import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent';
import type { PiBeforeLlmCallHook, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';
// Ш5: the double-trigger evaluator of the compaction package — the byte axis
// (`byteBudget`) fires against the projected context window.
import { evaluateTriggers } from '@mavis/context-compaction';
import { createLogger } from '@mavis/logging';

const log = createLogger('mcode:compaction');

import type {
  AutomaticContextCompactionInput,
  AutomaticContextCompactionProbe,
  AutomaticContextCompactor as AutomaticContextCompactorPort,
  ContextCompactionHooks,
  ContextCompactionResult,
  PromptSnapshotSource,
} from '../agent-host/contracts.js';
import {
  compactContext,
  type CheckpointSession,
  type CompactContextDecision,
  type CompactContextInput,
} from './algorithm/compact-context.js';
import {
  ToolResultArchiver,
  type ToolResultArchivePlan,
  type ToolResultCompactionCandidate,
} from './algorithm/tool-result-archiver.js';
import { createCheckpointSession } from './execution/checkpoint-provider.js';
import { checkpointMaxOutputTokens } from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
import { ContextUsageAnchorState } from './execution/usage-anchor.js';
import type { SubagentCheckpointStateSource } from './contracts.js';

/**
 * Ш5 (integration plan): the byte axis of the compaction double trigger
 * (`@mavis/context-compaction` `evaluateTriggers`), measured over the
 * PROJECTION WINDOW of the session's context-wire pipeline. Composed by
 * `createContextCompactors` whenever the context-wire path is enabled (the
 * durable default); the jsonl compatibility composition omits it and keeps
 * the exact legacy trigger semantics.
 */
export interface AutomaticByteTrigger {
  /**
   * Projected window bytes of the session (`manifest.windowBytes`).
   * `undefined` (no wire state yet) skips the axis for this probe.
   */
  readonly windowBytes: (sessionId: string) => number | undefined;
  /**
   * Byte budget the axis fires against — the wire payload guard
   * (`DEFAULT_MAX_PAYLOAD_BYTES`); the axis crosses background at 75% and
   * blocking at 90% of it, like every `evaluateTriggers` axis.
   */
  readonly byteBudget: number;
}

interface AutomaticContextCompactorDependencies {
  readonly toolResultArchiver?: ToolResultArchiver;
  readonly promptSnapshots?: PromptSnapshotSource;
  /** User `contextManagement.compactionTriggerAt`; read per call. */
  readonly getCompactionTriggerAt?: () => number | undefined;
  /** Ш5: the projection-window byte axis; present only in context-wire mode. */
  readonly byteTrigger?: AutomaticByteTrigger;
  /**
   * W10 unified-compaction switch (wire mode, the durable default): the
   * legacy CONTEXT triggers — token/byte budgets and the checkpoint
   * algorithm — are disabled; the unified scheduler owns them through the
   * context-wire seam (`createProductUnifiedCompaction`). Only the
   * tool-result archive axis remains active (the unified home has no
   * tool-output externalization yet). The jsonl composition never sets it.
   */
  readonly disableContextTriggers?: boolean;
  /**
   * Wave-0 item 0.4 (canon 05 §2.2, owner decision): the tool-result archive
   * axis stops being an AUTO-TRIGGER while there is no `offload` event. The
   * axis rewrites the whole history as `full reason=compact` (a 1:1
   * replacement with `producedBy: tool_archive` — no summary), so on a
   * media-heavy window it re-serializes megabytes of base64 on every firing
   * and presents "compaction succeeded" with zero token relief (incident
   * 2026-11-07, batch 17268). Wire mode composes it OFF by default; the
   * explicit `MCODE_TOOL_ARCHIVE_TRIGGER=1` knob turns the axis back on for
   * a session that wants the text-only tool-result squeeze. The MANUAL
   * `/compact` path never used the archiver (it is always `llm_checkpoint`)
   * and stays untouched.
   */
  readonly disableToolArchiveTrigger?: boolean;
}

export class AutomaticContextCompactor implements AutomaticContextCompactorPort {
  private readonly toolResultArchiver?: ToolResultArchiver;
  private readonly promptSnapshots?: PromptSnapshotSource;
  private readonly getCompactionTriggerAt?: () => number | undefined;
  private readonly byteTrigger?: AutomaticByteTrigger;
  private readonly disableContextTriggers: boolean;
  private readonly disableToolArchiveTrigger: boolean;

  constructor(
    private readonly usageAnchor: ContextUsageAnchorState | undefined,
    private readonly checkpointState: SubagentCheckpointStateSource | undefined,
    private readonly logger: Pick<PiTurnRunnerLogger, 'error' | 'debug'> | undefined,
    dependencies: AutomaticContextCompactorDependencies,
  ) {
    this.toolResultArchiver = dependencies.toolResultArchiver;
    this.promptSnapshots = dependencies.promptSnapshots;
    this.getCompactionTriggerAt = dependencies.getCompactionTriggerAt;
    this.byteTrigger = dependencies.byteTrigger;
    this.disableContextTriggers = dependencies.disableContextTriggers === true;
    this.disableToolArchiveTrigger = dependencies.disableToolArchiveTrigger === true;
  }

  probeBeforeLlm(input: AutomaticContextCompactionInput): AutomaticContextCompactionProbe {
    input.signal?.throwIfAborted();
    return {
      shouldStart: prepareAutomaticCompaction(
        input,
        this.usageAnchor,
        this.toolResultArchiver,
        this.readCompactionTriggerAt(),
        this.byteTrigger,
        this.disableContextTriggers,
        this.disableToolArchiveTrigger,
        this.logger,
      ).shouldStart,
    };
  }

  async compactBeforeLlm(
    input: AutomaticContextCompactionInput,
    hooks?: ContextCompactionHooks,
  ): Promise<ContextCompactionResult> {
    input.signal?.throwIfAborted();
    const preparation = prepareAutomaticCompaction(
      input,
      this.usageAnchor,
      this.toolResultArchiver,
      this.readCompactionTriggerAt(),
      this.byteTrigger,
      this.disableContextTriggers,
      this.disableToolArchiveTrigger,
      this.logger,
    );
    if (!preparation.shouldStart) {
      return { status: 'unchanged', reason: 'nothing-to-compact' };
    }
    await hooks?.onStarted();
    input.signal?.throwIfAborted();
    const toolResultCompactionCandidate = await materializeToolResultCompactionBestEffort(
      this.toolResultArchiver,
      input.sessionId,
      preparation.toolResultCompactionPlan,
      preparation.canReadArchivedToolResults,
    );
    input.signal?.throwIfAborted();
    if (
      preparation.toolResultCompactionPlan &&
      !toolResultCompactionCandidate &&
      !preparation.normalTriggerMatched
    ) {
      return { status: 'unchanged', reason: 'nothing-to-compact' };
    }
    const decision = await runAutomaticPolicy({
      input,
      hooks,
      preparation,
      toolResultCompactionCandidate,
      checkpointState: this.checkpointState,
      logger: this.logger,
      legacyToolTrim: this.toolResultArchiver === undefined,
      promptSnapshots: this.promptSnapshots,
    });
    this.usageAnchor?.invalidate(input.sessionId);
    return completedAutomaticCompaction(input.messages, decision);
  }

  /** A failing config read degrades to the built-in trigger. */
  private readCompactionTriggerAt(): number | undefined {
    try {
      return this.getCompactionTriggerAt?.();
    } catch {
      return undefined;
    }
  }
}

function prepareAutomaticCompaction(
  input: AutomaticContextCompactionInput,
  usageAnchor: ContextUsageAnchorState | undefined,
  archiver: ToolResultArchiver | undefined,
  compactionTriggerAt: number | undefined,
  byteTrigger: AutomaticByteTrigger | undefined,
  disableContextTriggers: boolean,
  disableToolArchiveTrigger: boolean,
  logger: Pick<PiTurnRunnerLogger, 'error' | 'debug'> | undefined,
) {
  const measurer = createAutomaticFootprintMeasurer(input, usageAnchor);
  const footprint = measurer.measure(input.messages);
  const { providerInputLimit, automaticTriggerAt } = resolveCompactionTokenBudget({
    contextWindow: input.model.contextWindow,
    configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
    compactionTriggerAt,
  });
  const toolResultCompactionPlan = archiver?.plan({
    sessionId: input.sessionId,
    messages: input.messages,
  });
  const byteTriggerMatched = evaluateProjectionByteTrigger(
    byteTrigger,
    input.sessionId,
    logger,
  );
  // W10 unified-compaction switch: with the triggers disabled (wire mode),
  // only the tool-result archive axis may start the legacy compactor — the
  // context axes belong to the unified scheduler of the wire seam.
  const normalTriggerMatched = disableContextTriggers
    ? false
    : footprint.inputTokens > automaticTriggerAt ||
      (input.maxSerializedInputBytes !== undefined &&
        footprint.serializedBytes > input.maxSerializedInputBytes) ||
      byteTriggerMatched;
  // Wave-0 item 0.4: with the archive axis's auto-trigger disabled (wire
  // mode default, `MCODE_TOOL_ARCHIVE_TRIGGER=1` re-enables), a prepared
  // archive plan never starts a compaction by itself — the media-heavy
  // "compaction" that re-serializes base64 and relieves no tokens is gone;
  // the honest media compression is the unified llm_checkpoint cut.
  const shouldStart =
    (toolResultCompactionPlan !== undefined && !disableToolArchiveTrigger) ||
    normalTriggerMatched;
  if (
    toolResultCompactionPlan !== undefined &&
    disableToolArchiveTrigger &&
    !normalTriggerMatched
  ) {
    logger?.debug?.(
      {
        event: 'context_compaction_tool_archive_trigger_disabled',
        session_id: input.sessionId,
        plan_savings_bytes: toolResultCompactionPlan.estimatedSavingsBytes,
      },
      '[local-runtime-v2] tool-result archive axis did not start a compaction (auto-trigger disabled)',
    );
  }
  return {
    measurer,
    footprint,
    toolResultCompactionPlan,
    canReadArchivedToolResults: hasReadTool(input.tools),
    normalTriggerMatched,
    shouldStart,
    providerInputLimit,
  };
}

/**
 * Ш5: the byte axis of the double trigger, over the session's projection
 * window. The legacy token/bytes budget checks above are untouched — wire
 * mode only ADDS this axis, never retimes the legacy trigger, so a
 * composition without `byteTrigger` (the jsonl compatibility mode) behaves
 * exactly as before. The package evaluator runs the byte axis alone
 * (`tokenBudget: 0` disables the token axis by contract); a `windowBytes`
 * of `undefined` (no wire state) or a non-positive byte budget disables the
 * axis for this probe. In wire mode with the W10 unified-compaction switch
 * the whole legacy trigger set is disabled (`disableContextTriggers`) —
 * the unified scheduler owns the axes through the wire seam.
 */
function evaluateProjectionByteTrigger(
  trigger: AutomaticByteTrigger | undefined,
  sessionId: string,
  logger: Pick<PiTurnRunnerLogger, 'error' | 'debug'> | undefined,
): boolean {
  if (!trigger) return false;
  const bytes = trigger.windowBytes(sessionId);
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return false;
  const evaluation = evaluateTriggers(
    { tokens: 0, bytes },
    { tokenBudget: 0, byteBudget: trigger.byteBudget },
  );
  if (evaluation.level === 'none') return false;
  const reason = evaluation.reasons.find((entry) => entry.axis === 'bytes');
  logger?.debug?.(
    {
      event: 'context_compaction_byte_trigger_fired',
      session_id: sessionId,
      bytes,
      byte_budget: trigger.byteBudget,
      ...(reason ? { ratio: reason.ratio, threshold: reason.threshold } : {}),
      level: evaluation.level,
    },
    '[local-runtime-v2] Context compaction byte trigger fired',
  );
  return true;
}

async function runAutomaticPolicy(options: {
  readonly input: AutomaticContextCompactionInput;
  readonly hooks?: ContextCompactionHooks;
  readonly preparation: ReturnType<typeof prepareAutomaticCompaction>;
  readonly toolResultCompactionCandidate: ToolResultCompactionCandidate | undefined;
  readonly checkpointState?: SubagentCheckpointStateSource;
  readonly logger?: Pick<PiTurnRunnerLogger, 'error'>;
  readonly legacyToolTrim: boolean;
  readonly promptSnapshots?: PromptSnapshotSource;
}) {
  const { input, hooks, preparation } = options;
  return compactContext({
    history: input.messages,
    limits: automaticLimits(input, preparation.providerInputLimit),
    measurePair: async (pair) => preparation.measurer.measurePair(pair),
    ...(options.toolResultCompactionCandidate
      ? { toolResultCompactionCandidate: options.toolResultCompactionCandidate }
      : {}),
    allowLegacyToolTrim: options.legacyToolTrim,
    checkpoint: automaticCheckpoint({
      input,
      hooks,
      tokensBefore: preparation.footprint.inputTokens,
      providerInputLimit: preparation.providerInputLimit,
      promptSnapshots: options.promptSnapshots,
    }),
    ...automaticSubagentCapture(input.sessionId, options.checkpointState, options.logger),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function automaticLimits(
  input: AutomaticContextCompactionInput,
  providerInputLimit: number,
): CompactContextInput['limits'] {
  return {
    providerInputLimit,
    ...(input.maxSerializedInputBytes === undefined
      ? {}
      : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
  };
}

function automaticCheckpoint({
  input,
  hooks,
  tokensBefore,
  providerInputLimit,
  promptSnapshots,
}: {
  readonly input: AutomaticContextCompactionInput;
  readonly hooks: ContextCompactionHooks | undefined;
  readonly tokensBefore: number;
  readonly providerInputLimit: number;
  readonly promptSnapshots: PromptSnapshotSource | undefined;
}): CompactContextInput['checkpoint'] {
  return {
    tokensBefore,
    timestamp: Date.now(),
    ...(hooks?.onCheckpointAttemptSettled
      ? { onAttemptSettled: hooks.onCheckpointAttemptSettled }
      : {}),
    ...(hooks?.getProviderTokenUsage ? { getTokenUsage: hooks.getProviderTokenUsage } : {}),
    open: () => openAutomaticCheckpoint(input, hooks, providerInputLimit, promptSnapshots),
  };
}

async function openAutomaticCheckpoint(
  input: AutomaticContextCompactionInput,
  hooks: ContextCompactionHooks | undefined,
  providerInputLimit: number,
  promptSnapshots: PromptSnapshotSource | undefined,
): Promise<CheckpointSession> {
  if (!input.streamFn) {
    throw new TypeError('Automatic context compaction requires streamFn.');
  }
  const session = await createCheckpointSession({
    model: input.model,
    streamFn: input.streamFn,
    thinkingLevel: input.thinkingLevel,
    providerInputLimit,
    maxOutputTokens: checkpointMaxOutputTokens(
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      input.maxTokens ?? input.model.maxTokens,
      input.model.contextWindow,
    ),
    ...(input.maxSerializedInputBytes === undefined
      ? {}
      : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.payloadTransform === undefined ? {} : { payloadTransform: input.payloadTransform }),
    ...(hooks?.onProviderRequestSettled
      ? { onRequestSettled: hooks.onProviderRequestSettled }
      : {}),
    onGenerated: (generation) =>
      hooks?.onCheckpointGenerated?.({
        responseContentKinds: generation.responseContentKinds,
        stopReason: generation.stopReason,
        outputTokens: generation.outputTokens,
      }),
    ...(promptSnapshots ? { promptSnapshots } : {}),
  });
  const measure = session.measure;
  return {
    ...session,
    fits: (request) =>
      session.fits({
        ...request,
        messages: projectAutomaticContextRequestMessages(request.messages),
      }),
    ...(measure === undefined
      ? {}
      : {
          measure: (request: Parameters<NonNullable<CheckpointSession['measure']>>[0]) =>
            measure({
              ...request,
              messages: projectAutomaticContextRequestMessages(request.messages),
            }),
        }),
    generate: async (request) =>
      await session.generate({
        ...request,
        messages: projectAutomaticContextRequestMessages(request.messages),
      }),
  };
}

function automaticSubagentCapture(
  sessionId: string,
  checkpointState: SubagentCheckpointStateSource | undefined,
  logger: Pick<PiTurnRunnerLogger, 'error'> | undefined,
): Pick<CompactContextInput, 'captureSubagents' | 'onSubagentCaptureFailure'> {
  if (!checkpointState) return {};
  return {
    captureSubagents: () => checkpointState.captureSubagents({ sessionId }),
    onSubagentCaptureFailure: () =>
      logger?.error?.(
        {
          event: 'context_compaction_subagent_checkpoint_capture_failed',
          session_id: sessionId,
        },
        '[local-runtime-v2] subagent checkpoint state capture failed',
      ),
  };
}

function completedAutomaticCompaction(
  messages: readonly AgentMessage[],
  decision: CompactContextDecision,
): ContextCompactionResult {
  const completed = {
    status: 'completed' as const,
    compactionId: `ctx_${randomUUID()}`,
    strategyVersion: 'local-context-compaction-v3',
    method: decision.method,
    replacementMessages: [...decision.replacementMessages],
    messagesBefore: messages.length,
    messagesAfter: decision.replacementMessages.length,
    tokensBefore: decision.measurement.before.inputTokens,
    tokensAfter: decision.measurement.after.inputTokens,
    serializedBytesBefore: decision.measurement.before.serializedBytes,
    serializedBytesAfter: decision.measurement.after.serializedBytes,
    ...hmidRecoveryMetadata(decision),
    ...(decision.method === 'llm_checkpoint' && decision.tokenUsage !== undefined
      ? { tokenUsage: decision.tokenUsage }
      : {}),
  };
  if (decision.method !== 'llm_checkpoint') {
    // Incident 2026-11-07 (mvs_f3f8d0ab), explicit scope declaration: the
    // tool_archive/tool_trim axes are TEXT-ONLY by design — the replacement
    // keeps every media block INLINE (`tool-result-archiver.ts` re-attaches
    // `...media` after the receipt). When a media-heavy window crosses the
    // trigger, this axis cannot shrink it and the owner must see WHY (the
    // honest compression for media is the llm_checkpoint cut). The census is
    // observability only; it never changes the committed replacement.
    const census = censusInlineMedia(decision.replacementMessages);
    if (census.blocks > 0) {
      log.info(
        '[local-runtime-v2] tool-result compaction is text-only: media blocks stay inline (compress media via the llm_checkpoint cut)',
        {
          event: 'tool_archive_media_kept_inline',
          method: decision.method,
          media_blocks: census.blocks,
          media_bytes: census.bytes,
          messages_before: messages.length,
          messages_after: decision.replacementMessages.length,
        },
      );
    }
  }
  return decision.method === 'llm_checkpoint'
    ? { ...completed, method: decision.method, summary: decision.summary }
    : {
        ...completed,
        method: decision.method,
        replacementSourceIndexes: messages.map((_message, index) => index),
      };
}

/** Inline media census of a replacement (image/video/audio blocks + their payload bytes). */
function censusInlineMedia(messages: readonly AgentMessage[]): {
  readonly blocks: number;
  readonly bytes: number;
} {
  let blocks = 0;
  let bytes = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const type = Reflect.get(block, 'type');
      if (type !== 'image' && type !== 'video' && type !== 'audio') continue;
      blocks += 1;
      const data = Reflect.get(block, 'data');
      if (typeof data === 'string') bytes += Buffer.byteLength(data, 'utf8');
    }
  }
  return { blocks, bytes };
}

function hmidRecoveryMetadata(decision: CompactContextDecision): {
  readonly hmidOverflowRecovered?: true;
} {
  return decision.method === 'llm_checkpoint' && decision.hmidOverflowRecovered
    ? { hmidOverflowRecovered: true }
    : {};
}
function hasReadTool(tools: AutomaticContextCompactionInput['tools']): boolean {
  return tools?.some((tool) => tool.name === 'read') === true;
}

async function materializeToolResultCompactionBestEffort(
  archiver: ToolResultArchiver | undefined,
  sessionId: string,
  plan: ToolResultArchivePlan | undefined,
  canReadArchivedToolResults: boolean,
): Promise<ToolResultCompactionCandidate | undefined> {
  if (!archiver || !plan) return undefined;
  try {
    return canReadArchivedToolResults
      ? await archiver.materialize({ sessionId, plan })
      : await archiver.materializeTrim({ sessionId, plan });
  } catch {
    return undefined;
  }
}

export function createAutomaticContextRequestFilterHook(): PiBeforeLlmCallHook {
  return (input) => {
    const messages = projectAutomaticContextRequestMessages(input.messages);
    return messages === input.messages
      ? { type: 'continue' }
      : {
          type: 'replaceRequestMessages',
          messages: [...messages],
          reason: 'internal-context-filter',
        };
  };
}

function projectAutomaticContextRequestMessages(messages: readonly AgentMessage[]) {
  return messages;
}

export function createAutomaticFootprintMeasurer(
  input: AutomaticContextCompactionInput,
  usageAnchor: ContextUsageAnchorState | undefined,
) {
  return createLocalContextFootprintMeasurer({
    model: input.model,
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(usageAnchor
      ? {
          usageAnchor: usageAnchor.bind({
            scope: input.sessionId,
            provider: input.model.provider,
            api: input.model.api,
            model: input.model.id,
            ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
            ...(input.tools === undefined ? {} : { tools: input.tools }),
          }),
        }
      : {}),
  });
}
