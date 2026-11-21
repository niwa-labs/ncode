import type { ContextOperationStore } from './context-operation-store.js';
import { withRequestReceipts } from './request-receipts.js';
import { captureContextDomainState } from './algorithm/checkpoint-format.js';
import { createHash, randomUUID } from 'node:crypto';

import { createLogger } from '@mavis/logging';
import { createRequestFork, RequestForkIneligibleError, type ContextWireProjection, type ContextWireRecord } from '@mavis/agent-core/pi-turn-runner';
import { normalizeContext } from '@earendil-works/pi-ai';
import type {
  DurableEntryDraft,
  LogEntry,
  SummaryRequest,
  SummaryResponse,
  SummaryTransport,
} from '@mavis/context-compaction';

import { createDeterministicSummaryProducer } from '@mavis/context-compaction';
import type { SchedulerAppendAttempt, SchedulerAttemptSnapshot } from '@mavis/context-compaction';

import { createUnifiedCompactionComposition } from './unified-compaction-composition.js';
import type { UnifiedCompactionComposition } from './unified-compaction-composition.js';
import type { CanonicalHistoryMessage } from '../agent-host/history/contracts.js';
import type {
  AgentExecutionSnapshot,
  AgentExecutionSource,
} from '../agent-host/preparation/contracts.js';
import type { ProductionAgentPreparation } from '../production-composition.js';
import { readSessionAgentExecutionSnapshot } from '../agent-host/preparation/session-agent-execution-snapshot.js';
import type { SessionRecord } from '../../session-system/index.js';

/**
 * W10 (review w10-review-p1 item 2; W05 «Product switch = W10», w05.md:24) —
 * the product composition of the unified compaction into the context-wire
 * pipeline: `createUnifiedCompactionComposition` resolved over the REAL
 * product inputs (per-session model identity from the turn preparation, a
 * provider summary transport over the product model resolution, and a live
 * canonical-history log binding) and handed to
 * `createTurnContextWire({ compactionFor })` by the production composition.
 *
 * The log binding is the dialect adapter the W05 composition module leaves
 * to the log owner (w05 deferred item 2): the canonical history stays the
 * ONE truth; this module projects it into the compaction package's
 * `mcode.*` vocabulary (`mcode.message`/`mcode.system`/`mcode.compaction`
 * entries) and commits produced checkpoints back through the canonical
 * `compact` seam (`llm_checkpoint`). Never a second context fold: cut
 * selection, budgets and the trigger rule stay with
 * `@mavis/context-compaction`.
 *
 * The per-session model identity arrives with each turn's wire seed (the
 * executor passes the resolved model of the turn) and is consumed by
 * `compactionFor` when the session's pipeline is built — the same
 * seed-resolved-per-session contract `TurnContextWireOptions.compactionFor`
 * documents. A session whose seed carried no model context (or no context
 * window) gets NO seam — never a silently wrong budget; the wire guard
 * alone bounds that session's window.
 *
 * Composed ONLY in wire mode (the durable default); the jsonl compatibility
 * composition creates none of it and keeps the exact legacy semantics.
 *
 * @module
 */

const log = createLogger('mcode:compaction');

const MESSAGE_ENTRY_KIND = 'mcode.message';
const SYSTEM_ENTRY_KIND = 'mcode.system';
const COMPACTION_ENTRY_KIND = 'mcode.compaction';
const USAGE_ENTRY_KIND = 'mcode.usage';

/** Compaction payload of the checkpoint draft (the subset this adapter reads). */
interface CompactionDraftPayload {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore?: number;
  readonly estimatedTokensAfter?: number;
  /** Wave 3 (item 3.2): the deterministic fallback producer made this summary. */
  readonly deterministic?: boolean;
}

/**
 * В1: facts of the last checkpoint this projection committed through the
 * canonical `compact` seam — the barrier admission point's `replaceMessages`
 * source (the replacement is the exact list canonical history now holds).
 */
interface LastCompactionCheckpoint {
  readonly compactionId: string;
  readonly summary: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly replacement: readonly unknown[];
  /**
   * Wave 3 (item 3.2): the committed summary came from the deterministic
   * fallback producer — the wall check after the fallback judges only this.
   */
  readonly deterministic?: true;
}

/** The per-session model context the wire seed carries (data only). */
export interface WireSeedModelContext {
  readonly provider: string;
  readonly modelId: string;
  /** Provider context window in tokens; the token-trigger axis owner. */
  readonly contextWindowTokens: number;
  /** The model's own output ceiling, if known (summary model clamp). */
  readonly maxOutputTokens?: number;
  /** Thinking level offered to the summary model when it supports reasoning. */
  readonly thinkingLevel?: string;
}

export interface ProductUnifiedCompactionOptions<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  /** Session records (summary-transport resolution context). */
  readonly sessions: { readonly get: (sessionId: string) => Promise<SessionRecord | undefined> };
  readonly agents: AgentExecutionSource<TAgent>;
  /** The product Agent/model preparation (summary transport resolution). */
  readonly preparation: ProductionAgentPreparation;
  /**
   * The canonical history seams (durable llm_checkpoint commits). `readActive`
   * is the commit-time baseline: the cut's plan is rebuilt against the CURRENT
   * history (never against the projection snapshot the summarizer ran on), so
   * owner input appended mid-job lands in the retained tail instead of being
   * silently dropped by the whole-history replacement.
   */
  readonly canonicalHistory: {
    readonly readActive: (sessionId: string) => Promise<{
      readonly messages: readonly unknown[];
      readonly identityVector: readonly string[];
    }>;
    readonly compact: (change: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly reason: 'replaceMessages';
      readonly messages: readonly unknown[];
      readonly operation: { readonly id: string; readonly kind: 'compaction' };
      readonly compactionId: string;
      readonly summary: string;
      /** Wave 3 (item 3.2): the fallback commits under its own honest method. */
      readonly method: 'llm_checkpoint' | 'deterministic_fallback';
      readonly replacementSourceIndexes: readonly number[];
    }) => Promise<unknown>;
  };
  /** Composition guarantees the main runner captures prepared request anchors. */
  readonly requestFork?: boolean;
  readonly operations?: ContextOperationStore;
  readonly onProgress?: (sessionId: string, stage: import('@mavis/context-compaction').CompactionProgressStage) => void;
  readonly nowMs?: () => number;
}

/** The unified composition plus the live canonical-log projection seam. */
export interface ProductUnifiedCompaction extends UnifiedCompactionComposition {
  readonly bindRequestFork: (sessionId: string, projection: ContextWireProjection) => ContextWireProjection;
  /** Feeds a turn's wire seed (pre-turn history + the resolved model). */
  readonly observeSeed: (input: {
    readonly sessionId: string;
    readonly messages: readonly unknown[];
    readonly model?: WireSeedModelContext;
  }) => void;
  /**
   * Feeds the same canonical history commits the context-wire bridge
   * observes into the compaction log projection (sync; keeps `entries()`
   * live without a second storage read).
   */
  readonly observeCommit: (change: {
    readonly sessionId: string;
    readonly reason: 'messageDelta' | 'replaceMessages';
    readonly messages: readonly unknown[];
  }) => void;
  /**
   * В1 overflow recovery: ids of the FAILED attempt's entries in this log's
   * projection — the runWithOverflowRecovery omission targets. The failed
   * request commits exactly its assistant response last (single-writer:
   * nothing else appends while the turn owns the log), so the rule is the
   * trailing assistant message entry; empty when the last entry is not one
   * (nothing to omit). Read-only: no occurrence counter is touched.
   */
  readonly resolveFailedAttemptEntryIds: (sessionId: string) => readonly string[];
  /**
   * В1 overflow recovery: the durable append of the `runWithOverflowRecovery`
   * omission draft (an `mcode.context_edit` `omission`) into this projection
   * of the session log — append-only, visible to the scheduler and to every
   * later rebuild of the same window. Recorded only when the recovery's
   * retry failed terminally (no omission for a successful recovery).
   */
  readonly appendOmissionDraft: (sessionId: string, draft: DurableEntryDraft) => Promise<void>;
}

/** One session's live compaction-log projection (the append-only truth view). */
interface SessionCompactionLog {
  readonly requestWaiters: Set<() => void>;
  readonly canonicalEntryIds: (string | undefined)[];
  requestFork?: {
    readonly request: ReturnType<typeof createRequestFork>;
    readonly sources: readonly (readonly string[] | undefined)[];
    readonly generation: number;
    readonly modelKey: string;
  };
  /** LIVE array identity: the binding's `entries()` closure reads it. */
  readonly entries: LogEntry[];
  /** Occurrence counters of content digests (stable repeat disambiguation). */
  readonly counts: Map<string, number>;
  /**
   * Wave 3 (item 3.1, canon 05 §2.3): the projection's generation counter —
   * the stand-in of the wave-1 fold generation with the SAME growth rule
   * (grows ONLY on a replace: a canonical replaceMessages commit, or this
   * projection's own compaction commit; never on an append or a seed). The
   * scheduler's attempt key and its staleness check read it.
   */
  generation: number;
  /** Model context of the latest seed; absent until the first turn. */
  model?: WireSeedModelContext;
  /** В1: facts of the last committed checkpoint; absent until the first cut. */
  lastCheckpoint?: LastCompactionCheckpoint;
  /**
   * В1: the CURRENT turn's abort signal for the summary request. Registered
   * by the barrier admission point and SELF-CLEARING on abort: a background
   * job may outlive the turn that registered the signal, and a stale aborted
   * signal must never kill a later background summary.
   */
  summarySignal?: AbortSignal;
}

/**
 * The summarizer identity half of the attempt key (canon 05 §2.3:
 * `(baseGeneration, cut, model, promptHash)` — the composition folds the
 * summary prompt's fixed template into the model identity). The SAME function
 * the composition's `summarizerKey` spells, computed over the LIVE model: a
 * model (or prompt identity) that moved between the attempt snapshot and the
 * append is a different identity — the stale result is discarded.
 */
function summarizerIdentityOf(model: WireSeedModelContext | undefined): string {
  if (model === undefined) return 'default';
  return `${model.provider}/${model.modelId}`;
}

export function createProductUnifiedCompaction<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(options: ProductUnifiedCompactionOptions<TAgent>): ProductUnifiedCompaction {
  const nowMs = options.nowMs ?? Date.now;
  const sessionLogs = new Map<string, SessionCompactionLog>();
  /** Summary transport cache: session → [model key, transport]. */
  const transports = new Map<string, readonly [string, SummaryTransport]>();

  const composition = createUnifiedCompactionComposition({
    // The product compaction settings-file surface (pi settings-manager
    // parity) is not wired yet; every field resolves to the W05 defaults
    // (enabled, reserve 16384, keepRecent 20000 — settings.ts).
    settings: () => ({}),
    resolveSessionModel: (sessionId) => {
      const sessionLog = requireSessionLog(sessionLogs, sessionId);
      return sessionLog.model === undefined
        ? undefined
        : {
            modelKey: {
              provider: sessionLog.model.provider,
              modelId: sessionLog.model.modelId,
            },
            contextWindowTokens: sessionLog.model.contextWindowTokens,
            ...(sessionLog.model.maxOutputTokens !== undefined
              ? { summaryModel: {
                  provider: sessionLog.model.provider,
                  modelId: sessionLog.model.modelId,
                  maxTokens: sessionLog.model.maxOutputTokens,
                  ...(sessionLog.model.thinkingLevel !== undefined
                    ? { reasoning: true as const }
                    : {}),
                } }
              : {}),
            ...(sessionLog.model.thinkingLevel !== undefined
              ? { summaryThinkingLevel: sessionLog.model.thinkingLevel }
              : {}),
          };
    },
    summaryTransport: (sessionId) => {
      const sessionLog = requireSessionLog(sessionLogs, sessionId);
      const key = sessionLog.model === undefined ? 'unknown' : `${sessionLog.model.provider}/${sessionLog.model.modelId}`;
      const cached = transports.get(sessionId);
      if (cached !== undefined && cached[0] === key) return cached[1];
      const transport = createPreparationSummaryTransport(options, sessionLogs, sessionId, nowMs);
      transports.set(sessionId, [key, transport]);
      return transport;
    },
    logBinding: (sessionId) => {
      const sessionLog = requireSessionLog(sessionLogs, sessionId);
      return {
        entries: () => sessionLog.entries,
        readyStore: options.operations?.readyStore(sessionId),
        onProgress: (stage) => {
          if (stage !== 'installed') notifyCompactionProgress(options, sessionId, stage);
        },
        append: (drafts, attempt) =>
          appendCompactionDrafts(options, sessionLogs, sessionId, drafts, attempt, nowMs),
        // Wave 3 (item 3.1, canon 05 §2.3): the canonical attempt snapshot —
        // the projection generation (grows only on replace) and the covered
        // cut (the log head). The scheduler keys the attempt on it and the
        // append staleness check compares it.
        attemptSnapshot: (): SchedulerAttemptSnapshot => {
          const last = sessionLog.entries[sessionLog.entries.length - 1];
          return {
            baseGeneration: sessionLog.generation,
            cut: `${sessionLog.entries.length}:${last?.id ?? 'empty'}`,
          };
        },
        // Wave 3 (item 3.2, canon 05 §2.2): the deterministic fallback
        // producer — with the breaker open, the blocking edge compacts
        // through it (tool activity + last assistant texts; NO provider
        // call).
        deterministicSummary: createDeterministicSummaryProducer(),
        // В1 barrier read: the last committed checkpoint's canonical
        // replacement — the hook's `replaceMessages` decision source.
        checkpointReplacement: () => {
          const checkpoint = sessionLog.lastCheckpoint;
          if (checkpoint === undefined) return undefined;
          return {
            compactionId: checkpoint.compactionId,
            summary: checkpoint.summary,
            replacement: checkpoint.replacement as readonly CanonicalHistoryMessage[],
            tokensBefore: checkpoint.tokensBefore,
            tokensAfter: checkpoint.tokensAfter,
            messagesBefore: checkpoint.messagesBefore,
            messagesAfter: checkpoint.messagesAfter,
            // Wave 3 (item 3.2): the wall check after the deterministic
            // fallback judges only fallback commits.
            ...(checkpoint.deterministic ? { deterministic: true as const } : {}),
          };
        },
        // В1: the turn's abort signal rides the summary request (the exec
        // streamFn carries no idle timeout). Self-clearing on abort.
        setSummarySignal: (signal) => {
          if (signal === undefined) {
            sessionLog.summarySignal = undefined;
            return;
          }
          sessionLog.summarySignal = signal;
          signal.addEventListener(
            'abort',
            () => {
              if (sessionLog.summarySignal === signal) sessionLog.summarySignal = undefined;
            },
            { once: true },
          );
        },
      };
    },
  });

  return {
    ...composition,
    bindRequestFork: (sessionId, projection) => {
      let records: readonly ContextWireRecord[] | undefined;
      let ids: readonly (string | undefined)[] = [];
      return {
        wrapProviderStreamFn: (inner, call) => withRequestReceipts(inner, options.operations, sessionId, call.turnId, call.kind),
        commitResponses: (messages) => options.operations?.commitResponses(sessionId, messages) ?? Promise.resolve(),
        project: () => {
          const result = projection.project();
          records = result?.records;
          ids = [...requireSessionLog(sessionLogs, sessionId).canonicalEntryIds];
          return result;
        },
        wrapStreamFn: (inner, main = inner) => (model, context, streamOptions) => {
          const sessionLog = requireSessionLog(sessionLogs, sessionId);
          sessionLog.requestFork = undefined;
          const conversationCount = context.messages.filter((message) => message.role !== 'system').length;
          let recordIndex = 0;
          const captured = records && conversationCount === records.length ? {
            request: createRequestFork(inner, model, context, streamOptions),
            sources: context.messages.map((message) => {
              if (message.role === 'system') return [];
              const indexes = records?.[recordIndex++]?.sourceIndexes;
              const sources = indexes?.map((sourceIndex) => ids[sourceIndex]);
              return sources?.length && sources.every((id) => id !== undefined) ? sources as string[] : undefined;
            }),
            generation: sessionLog.generation,
            modelKey: summarizerIdentityOf(sessionLog.model),
          } : undefined;
          const stream = captured ? captured.request.main(main) : main(model, context, streamOptions);
          // Publish only a successful physical request. An aborted/failed request
          // is never evidence that its prefix reached the provider cache.
          Promise.resolve(stream).then(async (result) => {
            const message = await result.result();
            if (captured?.request.canFork() && message.stopReason !== 'error' && message.stopReason !== 'aborted') sessionLog.requestFork = captured;
          }).catch(() => {}).finally(() => {
            for (const wake of sessionLog.requestWaiters) wake();
          });
          return stream;
        },
      };
    },
    observeSeed: (input) => {
      const sessionLog = requireSessionLog(sessionLogs, input.sessionId);
      // Recovery starts once per owner; dispatch awaits it through store.begin.
      void options.operations?.recover(input.sessionId, input.messages).catch((error) => {
        log.error('context operation recovery failed', { session_id: input.sessionId, error: error instanceof Error ? error.name : 'unknown' });
      });
      // Each Turn must establish its own prepared route and image rendering.
      sessionLog.requestFork = undefined;
      sessionLog.model = input.model;
      rebuildSessionLog(sessionLog, input.messages, nowMs());
    },
    observeCommit: (change) => {
      const sessionLog = requireSessionLog(sessionLogs, change.sessionId);
      if (change.reason === 'replaceMessages') {
        // A full replacement (a compaction cut, a lifecycle mutation) is only
        // expressible as a fresh projection: rebuild from the replacement.
        // Wave 3 (item 3.1): a replace grows the generation — every compaction
        // plan built before it is stale by the canon's rule, whether the
        // replacer was this projection's own commit (bumped below), a repair,
        // an adopt, or the В1 re-delivery of an already-committed checkpoint
        // (a harmless bump: the plan it would stale is long settled).
        rebuildSessionLog(sessionLog, change.messages, nowMs());
        sessionLog.generation += 1;
        return;
      }
      for (const message of change.messages) {
        const entry = compactionEntryOf(sessionLog, message, nowMs());
        if (entry !== undefined) sessionLog.entries.push(entry);
      }
    },
    resolveFailedAttemptEntryIds: (sessionId) => {
      const sessionLog = sessionLogs.get(sessionId);
      if (sessionLog === undefined || sessionLog.entries.length === 0) return [];
      const last = sessionLog.entries[sessionLog.entries.length - 1]!;
      const role =
        last.kind === MESSAGE_ENTRY_KIND
          ? Reflect.get(last.payload as Record<string, unknown>, 'role')
          : undefined;
      return last.kind === MESSAGE_ENTRY_KIND && role === 'assistant' ? [last.id] : [];
    },
    appendOmissionDraft: async (sessionId, draft) => {
      const sessionLog = requireSessionLog(sessionLogs, sessionId);
      // Append-only: the raw records the omission targets stay in the log
      // (recovery-contract invariant 2); the draft rides the same live
      // array the binding's `entries()` closure reads.
      sessionLog.entries.push({
        ...draft,
        seq: sessionLog.entries.length + 1,
        ordinal: 0,
      });
      log.info('overflow-recovery omission recorded', {
        session_id: sessionId,
        omission_id: draft.id,
      });
    },
  };
}

function requireSessionLog(
  sessionLogs: Map<string, SessionCompactionLog>,
  sessionId: string,
): SessionCompactionLog {
  let sessionLog = sessionLogs.get(sessionId);
  if (sessionLog === undefined) {
    sessionLog = { entries: [], requestWaiters: new Set(), canonicalEntryIds: [], counts: new Map(), generation: 0 };
    sessionLogs.set(sessionId, sessionLog);
  }
  return sessionLog;
}

function rebuildSessionLog(
  sessionLog: SessionCompactionLog,
  messages: readonly unknown[],
  timestamp: number,
): void {
  sessionLog.entries.length = 0;
  sessionLog.counts.clear();
  sessionLog.canonicalEntryIds.length = 0;
  for (const message of messages) {
    const entry = compactionEntryOf(sessionLog, message, timestamp);
    if (entry !== undefined) sessionLog.entries.push(entry);
  }
  // A canonical compactionSummary projects to a checkpoint entry whose
  // first-kept is the NEXT entry (the retained tail — the summary covers
  // everything before it). The projection builds it with an empty reference
  // because the tail's id is not known yet; patch it now that the ids exist —
  // `projectContext` (the usage tracker's resync over the shared log)
  // requires the reference to resolve.
  for (let index = 0; index < sessionLog.entries.length; index += 1) {
    const entry = sessionLog.entries[index]!;
    if (entry.kind !== COMPACTION_ENTRY_KIND) continue;
    const payload = entry.payload as { firstKeptEntryId?: string };
    if (payload.firstKeptEntryId !== '') continue;
    const next = sessionLog.entries[index + 1];
    if (next !== undefined) payload.firstKeptEntryId = next.id;
  }
}

// ---------------------------------------------------------------------------
// Canonical message → compaction LogEntry (the dialect projection)
// ---------------------------------------------------------------------------

/**
 * Projects one canonical message into the compaction vocabulary. The id is
 * CONTENT-ADDRESSED with an occurrence counter (the same convention as the
 * context-wire and driver-transcript adapters): a canonical message is
 * immutable once committed, and identical repeats keep distinct ids,
 * recomputed identically on every rebuild of the same history.
 */
function compactionEntryOf(
  sessionLog: SessionCompactionLog,
  message: unknown,
  timestamp: number,
): LogEntry | undefined {
  const projection = projectionOf(message, timestamp);
  const entry = projection === undefined ? undefined : logEntry(sessionLog, projection.kind, projection.payload);
  sessionLog.canonicalEntryIds.push(entry?.id);
  return entry;
}

/**
 * The pure dialect projection behind {@link compactionEntryOf} — kind and
 * payload only, no identity. Shared by the log projection and by the
 * commit-time cut resolution ({@link resolveCanonicalCutIndex}), which must
 * recompute the SAME content-addressed ids over the CURRENT canonical
 * messages the projection was folded from.
 */
function projectionOf(
  message: unknown,
  timestamp: number,
): { readonly kind: string; readonly payload: unknown } | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const role = Reflect.get(message, 'role');
  if (role === 'compactionSummary') {
    // The canonical summary rides as a checkpoint of the log: it covers
    // everything before the next message (first-kept points at the tail).
    const summary = readText(Reflect.get(message, 'summary'));
    return {
      kind: COMPACTION_ENTRY_KIND,
      payload: {
        summary,
        firstKeptEntryId: '',
        systemMessage: null,
        isSplitTurn: false,
        tokensBefore: 0,
        estimatedTokensAfter: 0,
        createdAtMs: readNumber(Reflect.get(message, 'timestamp')) ?? 0,
      },
    };
  }
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult' && role !== 'system') {
    return undefined;
  }
  if (role === 'system') {
    return { kind: SYSTEM_ENTRY_KIND, payload: { text: contentText(message) } };
  }
  const payload: Record<string, unknown> = {
    role,
    content: Reflect.get(message, 'content') ?? '',
    timestamp: readNumber(Reflect.get(message, 'timestamp')) ?? timestamp,
  };
  if (role === 'user') {
    // The immediate-send batch linkage is part of the CANONICAL user shape
    // (isCanonicalRuntimeMessage requires it); the checkpoint's kept list
    // must stay canonical-valid for the В1 barrier's `replaceMessages`
    // delivery, so the projection preserves it like the wire projection does.
    const hostMetadata = Reflect.get(message, 'hostMetadata');
    if (hostMetadata !== undefined) payload.hostMetadata = hostMetadata;
  }
  if (role === 'toolResult') {
    setString(payload, 'toolCallId', Reflect.get(message, 'toolCallId'));
    setString(payload, 'toolName', Reflect.get(message, 'toolName'));
    if (Reflect.get(message, 'isError') === true) payload.isError = true;
  }
  return { kind: MESSAGE_ENTRY_KIND, payload };
}

function logEntry(sessionLog: SessionCompactionLog, kind: string, payload: unknown): LogEntry {
  const digest = createHash('sha256')
    .update(JSON.stringify(payload), 'utf-8')
    .digest('hex')
    .slice(0, 16);
  const seen = sessionLog.counts.get(digest) ?? 0;
  sessionLog.counts.set(digest, seen + 1);
  return {
    id: seen === 0 ? `${kind}#${digest}` : `${kind}#${digest}#${seen + 1}`,
    parentId: null,
    kind,
    payload,
    seq: sessionLog.entries.length + 1,
    ordinal: 0,
  };
}

function contentText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const content = Reflect.get(message, 'content');
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block) => typeof block === 'object' && block !== null && Reflect.get(block, 'type') === 'text',
    )
    .map((block) => readText(Reflect.get(block, 'text')))
    .join('\n');
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function setString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string') target[key] = value;
}

// ---------------------------------------------------------------------------
// Drafts → canonical compact commit (the durable append)
// ---------------------------------------------------------------------------

/**
 * Commits the scheduler's drafts through the canonical history: the
 * `mcode.compaction` checkpoint becomes ONE `llm_checkpoint` canonical
 * compaction whose replacement list is the summary plus the RETAINED tail.
 *
 * The plan is rebuilt against the CURRENT canonical history at commit time,
 * never against the projection snapshot the summarizer ran on (incident
 * 2026-11-07, session mvs_f3f8d0ab): the summarizer runs 20-30s while the
 * owner keeps typing — reactive steering appends messages — and the compact
 * operation replaces the WHOLE history, so a plan committed from a stale
 * snapshot would either drop the appended owner input (silent data loss) or,
 * before this fix, be refused forever by the one-summary validation while the
 * trigger re-fired the SAME invalid shape every ~20-30s. The retained tail is
 * sliced from the fresh read with its source lineage (`replacementSourceIndexes`),
 * so owner input appended mid-job is kept verbatim; a cut that no longer
 * resolves (the projection diverged from canonical) cancels THIS round
 * honestly (`context_compaction_stale`) instead of committing a wrong plan —
 * the trigger re-evaluates and the next job summarizes fresh entries.
 *
 * Usage drafts ride the durable billing fold of the wave that owns them
 * (counted in the log, not re-modeled here). The canonical commit is the ONE
 * truth: the wire pipeline reseeds from it on the next turn (or the next
 * `replaceMessages` observation).
 */
async function appendCompactionDrafts(
  options: ProductUnifiedCompactionOptions,
  sessionLogs: Map<string, SessionCompactionLog>,
  sessionId: string,
  drafts: readonly DurableEntryDraft[],
  attempt: SchedulerAppendAttempt | undefined,
  nowMs: () => number,
): Promise<void> {
  const checkpoint = drafts.find((draft) => draft.kind === COMPACTION_ENTRY_KIND);
  if (checkpoint === undefined) {
    log.debug('unified compaction append carried no checkpoint draft', {
      session_id: sessionId,
      kinds: drafts.map((draft) => draft.kind),
    });
    return;
  }
  const payload = checkpoint.payload as Partial<CompactionDraftPayload> | null;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.summary !== 'string' ||
    typeof payload.firstKeptEntryId !== 'string'
  ) {
    throw new Error('unified compaction checkpoint draft payload is invalid');
  }
  const sessionLog = requireSessionLog(sessionLogs, sessionId);
  // Wave 3 (item 3.1, canon 05 §2.3 staleness): the result of an attempt
  // whose generation or summarizer identity moved since the snapshot is
  // DISCARDED, never committed — a foreign replace (repair/adopt/another
  // compaction) rewrote the covered history, or the model/prompt identity
  // changed mid-job. The failure carries the wave-0 classifier's stale
  // marker: the class re-plans exactly once, immediately (the wave-1 replace
  // events make the discard honest — nothing was written).
  if (attempt !== undefined) {
    const currentGeneration = sessionLog.generation;
    const currentIdentity = summarizerIdentityOf(sessionLog.model);
    if (attempt.generation !== currentGeneration || attempt.identity !== currentIdentity) {
      log.warn('unified compaction plan is stale — discarding the result', {
        event: 'context_compaction_stale_result_discarded',
        session_id: sessionId,
        attempt_generation: attempt.generation,
        current_generation: currentGeneration,
        attempt_identity: attempt.identity,
        current_identity: currentIdentity,
      });
      throw new TypeError(
        `unified compaction plan is stale: the attempt was built on generation ${attempt.generation} under ${attempt.identity}, ` +
          `the history has moved to generation ${currentGeneration} under ${currentIdentity}; the result is discarded and re-planned`,
      );
    }
  }
  const timestamp = nowMs();
  // Commit-time baseline: the cut resolves against the CURRENT canonical
  // history, so the retained tail (and everything the owner appended since
  // the summary was generated) is taken from the real envelopes.
  const canonical = await options.canonicalHistory.readActive(sessionId);
  const cutIndex = resolveCanonicalCutIndex(canonical.messages, payload.firstKeptEntryId);
  if (cutIndex === undefined) {
    log.warn('unified compaction round cancelled — the checkpoint cut does not resolve against the current canonical history', {
      event: 'context_compaction_stale',
      session_id: sessionId,
      compaction_entry_id: checkpoint.id,
      first_kept_entry_id: payload.firstKeptEntryId,
      canonical_messages: canonical.messages.length,
      projected_entries: sessionLog.entries.length,
    });
    return;
  }
  const kept = canonical.messages.slice(cutIndex);
  const replacementSourceIndexes = kept.map((_message, offset) => cutIndex + offset);
  const compactionId = `ctx_${randomUUID()}`;
  const deterministic = (payload as { deterministic?: unknown }).deterministic === true;
  const replacement: unknown[] = [
    {
      role: 'compactionSummary',
      summaryRequestIds: attempt?.requestIds ?? options.operations?.summaryRequestIds(sessionId) ?? [],
      contextState: captureContextDomainState(canonical.messages.slice(0, cutIndex) as Parameters<typeof captureContextDomainState>[0]),
      summary: payload.summary,
      // Canonical shape (isNativeCompactionSummary): a timestamped
      // compactionSummary MUST carry `tokensBefore` — the В1 barrier returns
      // this list through `copyCanonicalHistoryForPiCompatibility`, which
      // validates it. The draft's own tokensBefore is the honest value.
      tokensBefore: typeof payload.tokensBefore === 'number' ? payload.tokensBefore : 0,
      timestamp,
      // Wave 3 (item 3.5): the continuation reminder is delivered EXACTLY
      // once per compaction.id — the reminder hook reads the id from the
      // summary message the cut inserted. Extra fields pass the native
      // summary validator (only the minimal no-timestamp form is key-closed).
      compactionId,
    },
    ...kept,
  ];
  await options.canonicalHistory.compact({
    sessionId,
    turnId: `unified-compaction:${sessionId}`,
    reason: 'replaceMessages',
    messages: replacement,
    operation: { id: checkpoint.id, kind: 'compaction' },
    compactionId,
    summary: payload.summary,
    // Wave 3 (item 3.2): the durable `producedBy` is honest — the breaker
    // fallback says so instead of claiming an LLM checkpoint.
    method: deterministic ? 'deterministic_fallback' : 'llm_checkpoint',
    replacementSourceIndexes,
  });
  // The canonical writer may add a native system-section replay baseline.
  // Deliver the committed snapshot, never a pre-commit replacement guess.
  const committedReplacement = (await options.canonicalHistory.readActive(sessionId)).messages;
  // В1: record the committed checkpoint for the barrier admission point —
  // the canonical replacement IS the cut window; the hook's `replaceMessages`
  // decision returns it and the runner's delivery reseeds the wire pipeline
  // with it mid-turn (fact 1: the scheduler's own append path never folds
  // into the CURRENT turn's wire projection).
  notifyCompactionProgress(options, sessionId, 'installed');
  await options.operations?.commitSummaries(sessionId);
  sessionLog.lastCheckpoint = {
    compactionId,
    summary: payload.summary,
    tokensBefore: typeof payload.tokensBefore === 'number' ? payload.tokensBefore : 0,
    tokensAfter:
      typeof payload.estimatedTokensAfter === 'number' ? payload.estimatedTokensAfter : 0,
    messagesBefore: sessionLog.entries.length,
    messagesAfter: committedReplacement.length,
    replacement: committedReplacement,
    ...(deterministic ? { deterministic: true } : {}),
  };
  // Apply the cut to THIS projection as well — the same replacement the
  // canonical history now holds (the next replaceMessages observation would
  // rebuild it identically); keeps mid-turn trigger evaluation honest.
  // Wave 3 (item 3.1): the replace event grew the durable generation — this
  // projection's counter follows (the next attempt keys on the new one).
  rebuildSessionLog(sessionLog, committedReplacement, timestamp);
  sessionLog.generation += 1;
  log.info('unified compaction checkpoint committed to the canonical history', {
    session_id: sessionId,
    compaction_id: compactionId,
    kept_messages: kept.length,
    summarized_messages: cutIndex,
    deterministic,
    usage_drafts: drafts.filter((draft) => draft.kind === USAGE_ENTRY_KIND).length,
  });
}

/**
 * Resolves the checkpoint draft's `firstKeptEntryId` against the CURRENT
 * canonical messages: the same content-addressed id the projection computes
 * (kind + payload digest + repeat occurrence), recomputed over the fresh
 * read. Append-stable — owner input lands at the END of the log and never
 * shifts an earlier cut — so a draft built before a steer still resolves to
 * the same message after it. `undefined` — the id is foreign to the current
 * history (the projection diverged): the caller cancels the round honestly.
 */
function resolveCanonicalCutIndex(
  messages: readonly unknown[],
  firstKeptEntryId: string,
): number | undefined {
  const match = /^(mcode\.message|mcode\.system)#([0-9a-f]{16})(?:#(\d+))?$/.exec(firstKeptEntryId);
  if (!match) return undefined;
  const [, kind, digest, occurrenceRaw] = match;
  const occurrence = occurrenceRaw === undefined ? 0 : Number(occurrenceRaw) - 1;
  let seen = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const projection = projectionOf(messages[index], 0);
    if (projection === undefined || projection.kind !== kind) continue;
    const projectionDigest = createHash('sha256')
      .update(JSON.stringify(projection.payload), 'utf-8')
      .digest('hex')
      .slice(0, 16);
    if (projectionDigest !== digest) continue;
    if (seen === occurrence) return index;
    seen += 1;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Summary transport — the product provider request path
// ---------------------------------------------------------------------------

/**
 * Prefer a successfully sent main request's immutable prepared fork. The
 * source range and generation stay independent of its larger cached anchor.
 * Without an eligible image-free prefix, use the explicitly logged cold
 * preparation path; never claim cache reuse for a rebuilt serialized prompt.
 */
function createPreparationSummaryTransport(
  options: ProductUnifiedCompactionOptions,
  sessionLogs: Map<string, SessionCompactionLog>,
  sessionId: string,
  nowMs: () => number,
): SummaryTransport {
  return async (request: SummaryRequest): Promise<SummaryResponse> => {
    // В1: the CURRENT turn's summary signal (self-clearing) reads here —
    // resolved at request time, never baked into the transport closure.
    const sessionLog = requireSessionLog(sessionLogs, sessionId);
    if (options.requestFork && !sessionLog.requestFork && request.fork?.anchorWaitSignal && !request.fork.anchorWaitSignal.aborted) {
      log.info('background compaction waits for the main request anchor', { session_id: sessionId });
      await waitForRequestAnchor(sessionLog, request.fork.anchorWaitSignal, request.signal ?? sessionLog.summarySignal);
    }
    const candidate = sessionLog.requestFork;
    if (request.fork && candidate && candidate.generation === sessionLog.generation &&
        candidate.modelKey === summarizerIdentityOf(sessionLog.model)) {
      const covered = new Set(request.fork.coveredEntryIds);
      const present = new Set<string>();
      let prefixLength = 0;
      for (const sources of candidate.sources) {
        if (!sources || sources.some((id) => !covered.has(id))) break;
        sources.forEach((id) => present.add(id));
        prefixLength += 1;
      }
      if (prefixLength <= candidate.request.prefixLength && request.fork.coveredEntryIds.every((id) => present.has(id))) {
        try {
          // Reuse the exact cached covered prefix. Its source certificate must
          // include every message read by the summary, never a retained tail.
          const coveredMessages = candidate.sources.slice(0, prefixLength).filter((sources) => sources?.length).length;
          const instruction = `Summarize only the first ${coveredMessages} conversation messages of the preceding transcript (system messages are not counted). Everything after that range is retained separately: do not include it in the summary. Apply the following task to that range only.\n\n${request.fork.instruction}`;
          const stream = await candidate.request.stream(prefixLength, instruction, request.signal ?? sessionLog.summarySignal, request.maxOutputTokens);
          const message = await stream.result();
          log.info('compaction request fork completed', {
            session_id: sessionId, prefix_messages: prefixLength, covered_prefix_messages: prefixLength,
            cache_read_tokens: message.usage.cacheRead,
          });
          return {
            text: assistantText(message), stopReason: message.stopReason,
            errorMessage: message.errorMessage, hasToolCall: hasToolCall(message), usage: mapUsage(message.usage),
          };
        } catch (error) {
          // Never retry a failed provider request through a cold route. Only
          // local prefix eligibility failures may use the serialized path.
          if (!(error instanceof RequestForkIneligibleError)) throw error;
          log.info('compaction request fork ineligible', { session_id: sessionId, reason: error.message });
        }
      }
    }
    log.info('compaction cold request fallback', { session_id: sessionId, reason: 'no-compatible-image-free-prefix' });
    const session = await options.sessions.get(sessionId);
    if (!session) throw new Error(`Unified compaction transport: session ${sessionId} not found`);
    const agent = await readSessionAgentExecutionSnapshot(options.agents, session);
    if (!agent) throw new Error(`Unified compaction transport: agent of ${sessionId} not found`);
    const agentConfig = await options.preparation.buildAgentConfig({
      session,
      agent,
      isSessionFirstTurn: false,
    });
    const resolved = await options.preparation.resolveModel({
      sessionId,
      turnId: `unified-compaction:${request.sessionId}`,
      agentConfig,
    });
    const streamFn = resolved.streamFn;
    if (!streamFn) {
      throw new Error(`Unified compaction transport: session ${sessionId} resolved no streamFn`);
    }
    const streamOptions: Record<string, unknown> = {
      maxTokens: request.maxOutputTokens,
      ...(request.reasoning !== 'off' ? { reasoning: request.reasoning } : {}),
      // В1: the request's own signal wins; otherwise the CURRENT turn's
      // registered abort signal (the exec streamFn has no idle timeout, so a
      // hung summary provider call is otherwise unstoppable). Read at request
      // time — a background job may outlive the turn that registered it, and
      // an aborted registration clears itself.
      ...(request.signal !== undefined || sessionLog.summarySignal !== undefined
        ? { signal: request.signal ?? sessionLog.summarySignal }
        : {}),
      ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.headers !== undefined ? { headers: { ...resolved.headers } } : {}),
    };
    const stream = await withRequestReceipts(streamFn, options.operations, sessionId, `unified-compaction:${sessionId}`, 'compaction')(
      resolved.model,
      normalizeContext({
        messages: [
          {
            role: 'user',
            content: request.prompt,
            timestamp: nowMs(),
          },
        ],
      }),
      streamOptions as never,
    );
    const message = await stream.result();
    return {
      text: assistantText(message),
      stopReason: readText(Reflect.get(message, 'stopReason')) || 'stop',
      ...(Reflect.get(message, 'errorMessage') !== undefined
        ? { errorMessage: readText(Reflect.get(message, 'errorMessage')) }
        : {}),
      hasToolCall: hasToolCall(message),
      usage: mapUsage(Reflect.get(message, 'usage')),
    };
  };
}

/** Text of a pi AssistantMessage (its text blocks joined). */
function assistantText(message: unknown): string {
  const content = typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block) => typeof block === 'object' && block !== null && Reflect.get(block, 'type') === 'text',
    )
    .map((block) => readText(Reflect.get(block, 'text')))
    .join('');
}

function hasToolCall(message: unknown): boolean {
  const content = typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined;
  return (
    Array.isArray(content) &&
    content.some(
      (block) => typeof block === 'object' && block !== null && Reflect.get(block, 'type') === 'toolCall',
    )
  );
}

function mapUsage(usage: unknown): SummaryResponse['usage'] {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const read = (key: string): number | undefined => {
    const value = Reflect.get(usage, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const cost = Reflect.get(usage, 'cost');
  const mapped = {
    totalTokens: read('totalTokens'),
    input: read('input'),
    output: read('output'),
    cacheRead: read('cacheRead'),
    cacheWrite: read('cacheWrite'),
    ...(typeof cost === 'object' && cost !== null
      ? {
          cost: {
            input: readCostCounter(cost, 'input'),
            output: readCostCounter(cost, 'output'),
            cacheRead: readCostCounter(cost, 'cacheRead'),
            cacheWrite: readCostCounter(cost, 'cacheWrite'),
            total: readCostCounter(cost, 'total'),
          },
        }
      : {}),
  };
  return Object.values(mapped).some((value) => value !== undefined)
    ? mapped
    : undefined;
}

function readCostCounter(cost: object, key: string): number | undefined {
  const value = Reflect.get(cost, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A background-only wait. Blocking promotion and owner cancellation both wake
 * it, so compaction can never deadlock the request that would prime its cache.
 */
function waitForRequestAnchor(log: SessionCompactionLog, promotion: AbortSignal, cancellation?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      log.requestWaiters.delete(wake);
      promotion.removeEventListener('abort', wake);
      cancellation?.removeEventListener('abort', cancel);
    };
    const wake = () => { cleanup(); resolve(); };
    const cancel = () => { cleanup(); reject(cancellation?.reason ?? new Error('Compaction cancelled')); };
    log.requestWaiters.add(wake);
    promotion.addEventListener('abort', wake, { once: true });
    cancellation?.addEventListener('abort', cancel, { once: true });
    if (cancellation?.aborted) cancel();
    else if (promotion.aborted || log.requestFork) wake();
  });
}

function notifyCompactionProgress(
  options: ProductUnifiedCompactionOptions,
  sessionId: string,
  stage: import('@mavis/context-compaction').CompactionProgressStage,
): void {
  try { options.onProgress?.(sessionId, stage); }
  catch { log.warn('compaction progress delivery failed', { session_id: sessionId, stage }); }
}
