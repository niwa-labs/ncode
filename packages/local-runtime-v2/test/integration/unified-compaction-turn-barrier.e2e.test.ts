import { describe, expect, it } from 'vitest';

import { resolveCompactionBackgroundThresholdRatio } from '@mavis/context-compaction';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai/compat';

import { createProductUnifiedCompaction } from '../../src/service/turn-system/compaction/product-unified-compaction.js';
import type { ProductUnifiedCompactionOptions } from '../../src/service/turn-system/compaction/product-unified-compaction.js';
import {
  createTurnContextWire,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type ContextWireCommitInput,
  type TurnContextWire,
} from '../../src/service/turn-system/compaction/context-wire.js';
import { AutomaticContextCompactor } from '../../src/service/turn-system/compaction/automatic-context-compactor.js';
import { ContextUsageAnchorState } from '../../src/service/turn-system/compaction/execution/usage-anchor.js';
import {
  createAutomaticContextCompactionHook,
  ContextCompactionAttemptFactory,
  type AgentHostCompactionHookDependencies,
} from '../../src/service/turn-system/agent-host/compaction/context-compaction.js';
import type { PiBeforeLlmCallHookDecision } from '@mavis/agent-core/pi-turn-runner';
import type { AgentEventContext } from '../../src/service/turn-system/agent-host/events/contracts.js';
import type { AgentExecutionSource } from '../../src/service/turn-system/agent-host/preparation/contracts.js';
import type { CanonicalHistoryMessage } from '../../src/service/turn-system/agent-host/history/contracts.js';
import type { ProductionAgentPreparation } from '../../src/service/turn-system/production-composition.js';
import type { SessionRecord } from '../../src/service/session-system/index.js';

/**
 * Regression coverage for the compaction turn barrier.
 * Without the barrier, the following race can occur:
 *
 *   Even with an admission point awaited, the checkpoint of a mid-turn
 *   compaction reaches the CURRENT turn's wire projection only on the NEXT
 *   turn: the wire pipeline is fed only by the executor's seed
 *   (executor.ts:628) and the runner history hook (executor.ts:991-1010),
 *   while the unified compaction append commits through the canonical
 *   `compact` seam (product-unified-compaction.ts:379-392) — which never
 *   feeds the bridge. The synchronous layer is off in wire mode
 *   (production-composition.ts:573 disableContextTriggers), and the legacy
 *   before-LLM compaction hook is inert on the unified axes.
 *
 * The scenario: one turn — the executor-shaped seed (pre-turn history + the
 * resolved model), then committed deltas — crosses the BLOCKING byte
 * threshold of the unified double trigger mid-turn. The full current
 * before-LLM compaction chain runs (the production hook over the production
 * compactor wiring), the documented admission point resolves, the checkpoint
 * IS durably committed — and the next `project()` still compiles the
 * UNTRIMMED window. The В1 fix (blocking hook → runBlocking → replaceMessages
 * decision → reseed, context-wire.ts:977-981) must turn this test GREEN by
 * returning the checkpoint replacement as a replaceMessages decision; the
 * harness applies that decision through the same commit feed the runner uses.
 *
 * Composition provenance — every seam below is the production composition:
 * - `createProductUnifiedCompaction` + `createTurnContextWire` + the
 *   feed glue = production-composition.ts:428-445 (`feedUnifiedCompactionLog`,
 *   :849-865 — not exported, mirrored verbatim);
 * - the before-LLM hook = local-agent-host.ts:632 (`createAutomaticContextCompactionHook`
 *   over `dependencies.compaction`) with the production compactor option
 *   shape = production-composition.ts:559-586 (disableContextTriggers + the
 *   wire windowBytes byteTrigger on the payload guard);
 * - the stubbed boundaries are the provider transport (the summarizer's
 *   streamFn behind the preparation port) and the canonical `compact` port
 *   (recording; the real provider persists, and fact 1 does not depend on its
 *   internals — nothing on that path feeds the wire bridge) — an e2e harness
 *   cannot call a live provider.
 *
 * Test-scale deviation (documented, the plan's "отклонения с обоснованием"):
 * `createTurnContextWire({ maxBytes })` is scaled down to 600 КБ (production
 * composes the default 32 МБ payload guard) so the byte axis crosses in the
 * test with ~560 КБ of content instead of ~29 МБ; the trigger semantics
 * (75%/blocking ratio of the budget) are identical. The context window rides
 * the seed as the executor passes it (executor.ts:628 → turnWireModelContext).
 */

const SESSION = 'session-unified-barrier-e2e';
const TURN_ID = 'turn-unified-barrier-e2e';
/** Test-scale wire guard = the unified byte-axis budget (`pipeline.maxBytes`). */
const MAX_BYTES = 600_000;
/** The model window the seed carries; blocking ratio = (window − 16384)/window. */
const CONTEXT_WINDOW_TOKENS = 200_000;
const MODEL_MAX_TOKENS = 4096;
/** Phase 1: 20 × ~12 KB deltas stay below the product background threshold. */
const PHASE1_MESSAGES = 20;
const PHASE1_CHARS = 12_000;
/** Phase 2: ONE huge delta — jumps past the blocking line in a single commit. */
const PHASE2_CHARS = 230_000;

const SUMMARY_TEXT = 'Свернуто: длинная история fixture-хода сжата в краткое резюме.';

/**
 * Canonical user message — the exact shape the executor's history hook feeds:
 * a durable user message carries the immediate-send batch linkage
 * (`isCanonicalRuntimeMessage` requires it), so the checkpoint's kept list
 * stays canonical-valid for the В1 `replaceMessages` delivery.
 */
function userMessage(text: string, timestamp: number): CanonicalHistoryMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp,
    hostMetadata: { immediateSendBatchId: `fixture-batch-${timestamp}` },
  } as unknown as CanonicalHistoryMessage;
}

function fixtureSession(): SessionRecord {
  return {
    sessionId: SESSION,
    agentName: 'fixture',
    workspaceDir: '/tmp/unified-barrier-fixture',
    runtime: 'v2',
    sessionType: 'standard',
    sessionKind: 'session',
    archived: false,
    status: 'active',
    effectiveModel: 'fixture/fixture-model',
    createdAtMs: 1,
    updatedAtMs: 1,
  } as unknown as SessionRecord;
}

const FIXTURE_MODEL: Model<Api> = {
  id: 'fixture-model',
  name: 'Fixture model',
  api: 'openai-completions',
  provider: 'fixture',
  baseUrl: 'http://fixture.invalid/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: CONTEXT_WINDOW_TOKENS,
  maxTokens: MODEL_MAX_TOKENS,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * Provider boundary stub: a short summary, whatever prompt arrives. Typed
 * loosely — the whole preparation port below is narrowed by the production
 * transport's actual usage (buildAgentConfig → resolveModel → streamFn).
 */
const fixtureStreamFn = async () => ({
  result: async () => ({
    content: [{ type: 'text', text: SUMMARY_TEXT }],
    stopReason: 'stop',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    api: FIXTURE_MODEL.api,
    provider: FIXTURE_MODEL.provider,
    model: FIXTURE_MODEL.id,
    timestamp: 1,
  }),
});

/** One canonical compaction commit recorded at the durable `compact` seam. */
type CompactionCommit = Parameters<
  ProductUnifiedCompactionOptions['canonicalHistory']['compact']
>[0];

interface TurnCompactionPath {
  readonly contextWire: TurnContextWire;
  /**
   * The full before-LLM compaction hook; returns its decision exactly as the
   * runner observes it (the harness applies a `replaceMessages` decision
   * through the same commit feed the runner's history hook uses).
   */
  readonly runBeforeLlmCompactionHook: (
    messages: readonly CanonicalHistoryMessage[],
    signal?: AbortSignal,
  ) => Promise<PiBeforeLlmCallHookDecision | undefined>;
  readonly compactCommits: CompactionCommit[];
  /** The unified byte-axis blocking ratio; readable only AFTER the turn seed. */
  readonly blockingBudgetRatio: () => number;
}

/**
 * Composes the production turn-compaction path: the product unified-compaction
 * seam over the canonical `compact` port + the context-wire bridge + the
 * production before-LLM compaction hook — the exact assembly
 * production-composition.ts:428-445/:541-545/:559-586 and
 * local-agent-host.ts:632 perform. `options.streamFn` overrides the summary
 * provider boundary (the Esc/refusal scenarios stub a hanging/failing one).
 */
function composeTurnCompactionPath(
  options: {
    readonly streamFn?: typeof fixtureStreamFn;
  } = {},
): TurnCompactionPath {
  const compactCommits: CompactionCommit[] = [];
  // The canonical store the commit-time baseline reads: the commit seam APPLIES
  // its replacement (the real provider persists; it does NOT feed the wire —
  // that is fact 1), and readActive serves the fresh history the unified
  // commit rebuilds its plan against.
  const canonicalStore: { messages: unknown[]; identityVector: string[] } = {
    messages: [],
    identityVector: [],
  };
  const unifiedCompaction = createProductUnifiedCompaction({
    sessions: { get: async (id) => (id === SESSION ? fixtureSession() : undefined) },
    agents: {
      getExecutionSnapshot: async () => ({ agentName: 'fixture', systemPrompt: 'fixture prompt' }),
    } as AgentExecutionSource,
    // The product preparation port, narrowed to what the summary transport
    // uses (buildAgentConfig → resolveModel → streamFn); the provider call
    // itself is the fixture stream above (or the scenario's override).
    preparation: {
      buildAgentConfig: async () => ({}),
      resolveModel: async () => ({ model: FIXTURE_MODEL, streamFn: options.streamFn ?? fixtureStreamFn }),
    } as unknown as ProductionAgentPreparation,
    canonicalHistory: {
      readActive: async () => ({
        messages: [...canonicalStore.messages],
        identityVector: [...canonicalStore.identityVector],
      }),
      compact: async (change) => {
        canonicalStore.messages = [...change.messages];
        canonicalStore.identityVector = change.messages.map(
          (_message, index) => `fixture-env-${index}`,
        );
        compactCommits.push(change);
        return change;
      },
    },
  });

  // Test-scale guard: production composes the 32 МБ default (see header).
  // compactionFor — production-composition.ts:440-442.
  const wire = createTurnContextWire({
    maxBytes: MAX_BYTES,
    compactionFor: unifiedCompaction.compactionFor,
  });
  // feedUnifiedCompactionLog — production-composition.ts:849-865 (not exported).
  const contextWire: TurnContextWire = {
    ...wire,
    seed: (input) => {
      canonicalStore.messages = [...input.messages];
      canonicalStore.identityVector = input.messages.map(
        (_message, index) => `fixture-env-${index}`,
      );
      unifiedCompaction.observeSeed(input);
      wire.seed(input);
    },
    observeCommit: (change) => {
      if (change.reason === 'replaceMessages') {
        canonicalStore.messages = [...change.messages];
        canonicalStore.identityVector = change.messages.map(
          (_message, index) => `fixture-env-${index}`,
        );
      } else {
        canonicalStore.messages.push(...change.messages);
        canonicalStore.identityVector.push(
          ...change.messages.map((_message, index) => `fixture-env-${canonicalStore.messages.length + index}`),
        );
      }
      unifiedCompaction.observeCommit(change);
      wire.observeCommit(change);
    },
  };

  // The production compactor wiring in wire mode
  // (production-composition.ts:559-586): the unified scheduler owns the
  // CONTEXT triggers; the legacy byteTrigger stays on the payload guard.
  // The tool-result archive axis and prompt snapshots are omitted — the
  // fixture window holds no tool results, the axis is inert either way.
  const automatic = new AutomaticContextCompactor(new ContextUsageAnchorState(), undefined, undefined, {
    disableContextTriggers: true,
    byteTrigger: {
      windowBytes: (sessionId) => contextWire.windowBytes(sessionId),
      byteBudget: DEFAULT_MAX_PAYLOAD_BYTES,
    },
  });
  // local-agent-host.ts:632 — the hook the before-LLM chain positions first
  // among the compaction hooks (executor.ts:714-727). В1: the hook receives
  // the wire compaction barrier exactly as the production composition does
  // (production-composition.ts `wireCompactionBarrier` over
  // `contextWire.compactionBarrier`) — the level-aware admission point.
  const runBeforeLlmCompactionHook = async (
    messages: readonly CanonicalHistoryMessage[],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PiBeforeLlmCallHookDecision | undefined> => {
    const hook = createAutomaticContextCompactionHook(
      {
        automatic,
        lifecycle: {
          completeCommittedHistory: async () => {},
          failCommittedHistory: async () => {},
        },
        wireCompactionBarrier: (sessionId) => contextWire.compactionBarrier(sessionId),
      } as AgentHostCompactionHookDependencies,
      {
        sessionId: SESSION,
        turnId: TURN_ID,
        turnSequence: 1,
      } as AgentEventContext,
      'lease-unified-barrier-e2e',
      { attempts: new ContextCompactionAttemptFactory() },
    );
    const decision = await hook({
      sessionId: SESSION,
      turnId: TURN_ID,
      phase: 'iteration',
      messages: [...messages] as unknown as AgentMessage[],
      canonicalMessages: [...messages] as unknown as AgentMessage[],
      model: FIXTURE_MODEL,
      thinkingLevel: 'off',
      signal,
    });
    // The runner applies a replaceMessages decision by committing the
    // replacement through the history hook — the feed of executor.ts:991-1010
    // that reseeds the wire pipeline (context-wire.ts:977-981).
    if (decision?.type === 'replaceMessages') {
      const change: ContextWireCommitInput = {
        sessionId: SESSION,
        reason: 'replaceMessages',
        messages: decision.messages as unknown as readonly CanonicalHistoryMessage[],
      };
      contextWire.observeCommit(change);
    }
    return decision;
  };

  return {
    contextWire,
    runBeforeLlmCompactionHook,
    compactCommits,
    // Readable only AFTER the turn seed (compactionFor resolves at seed time).
    blockingBudgetRatio: () =>
      unifiedCompaction.lastResolution(SESSION)?.budgets.blockingThresholdRatio ?? 0.9,
  };
}

describe('В1 ШАГ 0: the mid-turn blocking compaction barrier through the production composition', () => {
  it('a blocking crossing mid-turn must cut the window BEFORE the next project() (fact 1: falls until the В1 hook lands)', { timeout: 60_000 }, async () => {
    const path = composeTurnCompactionPath();

    // Turn seed (executor.ts:628): pre-turn history + the resolved model.
    path.contextWire.seed({
      sessionId: SESSION,
      messages: [userMessage('fixture seed history', 1)],
      model: {
        provider: FIXTURE_MODEL.provider,
        modelId: FIXTURE_MODEL.id,
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: MODEL_MAX_TOKENS,
      },
    });
    // The seed resolved the unified seam: the byte-axis blocking line is the
    // W05 trigger ratio over the test-scale wire budget.
    const blockingBytes = MAX_BYTES * path.blockingBudgetRatio();
    expect(blockingBytes, 'the seed must resolve the unified compaction budgets').toBeGreaterThan(0);

    const feed = (text: string, timestamp: number): void => {
      path.contextWire.observeCommit({
        sessionId: SESSION,
        reason: 'messageDelta',
        messages: [userMessage(text, timestamp)],
      });
    };

    // Phase 1: the long first stretch of the turn — under the background line.
    for (let turn = 1; turn <= PHASE1_MESSAGES; turn += 1) {
      feed(`chunk-${turn}-${'x'.repeat(PHASE1_CHARS)}`, turn + 1);
    }
    const backgroundBytes = MAX_BYTES * resolveCompactionBackgroundThresholdRatio();
    const beforeCrossing = path.contextWire.windowBytes(SESSION) ?? 0;
    expect(
      beforeCrossing,
      `phase 1 must stay under the background line (got ${beforeCrossing}, background ${backgroundBytes})`,
    ).toBeLessThan(backgroundBytes);

    // Phase 2: ONE delta that crosses the BLOCKING line in a single commit —
    // the blocking пересечение посреди хода.
    feed(`tail-${'x'.repeat(PHASE2_CHARS)}`, PHASE1_MESSAGES + 2);
    const atCrossing = path.contextWire.windowBytes(SESSION) ?? 0;
    expect(
      atCrossing,
      `phase 2 must cross the blocking line (got ${atCrossing}, blocking ${blockingBytes})`,
    ).toBeGreaterThanOrEqual(blockingBytes);

    // The full current before-LLM compaction chain — its В1 admission point
    // (the wire compaction barrier: blocking level → runBlocking → the
    // `replaceMessages` decision) runs inside the hook; the trailing
    // `whenCompactionIdle` here is only a diagnostics drain. Then the runner
    // feed of the hook's replaceMessages decision.
    const requestView = [...(path.contextWire.projection(SESSION)?.project()?.records ?? [])];
    expect(requestView.length, 'the request view must be live before the barrier').toBeGreaterThan(0);
    const decision = await path.runBeforeLlmCompactionHook([userMessage('tail', PHASE1_MESSAGES + 2)]);
    expect(
      decision?.type,
      'the blocking barrier must return the checkpoint replacement as replaceMessages',
    ).toBe('replaceMessages');
    await path.contextWire.whenCompactionIdle(SESSION);

    // Precondition: the unified compaction REALLY published its checkpoint
    // through the canonical `compact` seam mid-turn.
    expect(
      path.compactCommits.length,
      'the crossing must have produced a committed compaction checkpoint',
    ).toBeGreaterThanOrEqual(1);
    const commit = path.compactCommits.at(-1)!;
    expect(commit.reason).toBe('replaceMessages');
    expect(commit.method).toBe('llm_checkpoint');
    expect(commit.messages.length).toBeGreaterThanOrEqual(2);
    expect((commit.messages[0] as { role?: string }).role).toBe('compactionSummary');

    // THE В1 VERDICT (fact 1): the next request's project() must compile the
    // CUT window — below the blocking threshold. On the current code the
    // checkpoint never reaches this turn's wire pipeline, so the window is
    // still the uncut one and this assert FAILS.
    const windowBytesAfter = path.contextWire.windowBytes(SESSION) ?? 0;
    expect(
      windowBytesAfter,
      `fact 1 CONFIRMED only if this fails: the committed checkpoint must reach the current turn's wire projection (windowBytes ${windowBytesAfter} >= blocking ${blockingBytes})`,
    ).toBeLessThan(blockingBytes);

    const prepared = path.contextWire.projection(SESSION)?.project();
    expect(prepared).toBeDefined();
    // The projection port serves records + totalBytes (context-wire.ts:1027);
    // the manifest-side windowBytes above is the trigger axis truth.
    expect(prepared!.totalBytes).toBeLessThan(blockingBytes);
  });

  it('a BACKGROUND crossing never blocks the request (fire-and-forget; the checkpoint lands harmlessly later)', { timeout: 60_000 }, async () => {
    // A 250мс summarizer delay makes the non-blocking proof deterministic:
    // the hook must return BEFORE the background job's summarizer resolves.
    const SUMMARIZER_DELAY_MS = 250;
    const delayedStreamFn = (async () => {
      await new Promise((resolve) => setTimeout(resolve, SUMMARIZER_DELAY_MS));
      return fixtureStreamFn();
    }) as unknown as typeof fixtureStreamFn;
    const path = composeTurnCompactionPath({ streamFn: delayedStreamFn });
    path.contextWire.seed({
      sessionId: SESSION,
      messages: [userMessage('fixture seed history', 1)],
      model: {
        provider: FIXTURE_MODEL.provider,
        modelId: FIXTURE_MODEL.id,
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: MODEL_MAX_TOKENS,
      },
    });

    // Cross only the configured background line, staying below blocking.
    const backgroundBytes = MAX_BYTES * resolveCompactionBackgroundThresholdRatio();
    const blockingBytes = MAX_BYTES * path.blockingBudgetRatio();
    const feeds = Math.floor(backgroundBytes / (PHASE1_CHARS + 64)) + 4; // a few past the line
    for (let turn = 1; turn <= feeds; turn += 1) {
      path.contextWire.observeCommit({
        sessionId: SESSION,
        reason: 'messageDelta',
        messages: [userMessage(`bg-chunk-${turn}-${'x'.repeat(PHASE1_CHARS)}`, turn + 1)],
      });
      const bytes = path.contextWire.windowBytes(SESSION) ?? 0;
      expect(bytes, `feed ${turn} must stay under the blocking line`).toBeLessThan(blockingBytes);
    }
    const atCrossing = path.contextWire.windowBytes(SESSION) ?? 0;
    expect(atCrossing).toBeGreaterThanOrEqual(backgroundBytes);
    expect(atCrossing).toBeLessThan(blockingBytes);

    // The hook must NOT wait for the background job it finds in flight: it
    // returns the ordinary continue decision while the job is still running.
    const startedAtMs = Date.now();
    const decision = await path.runBeforeLlmCompactionHook([userMessage('bg-tail', feeds + 2)]);
    const elapsedMs = Date.now() - startedAtMs;
    expect(decision?.type, 'a background crossing must not produce a replacement').not.toBe(
      'replaceMessages',
    );
    expect(
      elapsedMs,
      `the hook must return before the background summarizer resolves (took ${elapsedMs}мс, delay ${SUMMARIZER_DELAY_MS}мс)`,
    ).toBeLessThan(SUMMARIZER_DELAY_MS);
    // The hook resolved BEFORE the background job's checkpoint committed.
    expect(path.compactCommits.length).toBe(0);

    // The background job was running fire-and-forget: it settles on its own,
    // and its checkpoint is the harmless background write it always was.
    await path.contextWire.whenCompactionIdle(SESSION);
    expect(path.compactCommits.length).toBeGreaterThanOrEqual(1);
    const commit = path.compactCommits.at(-1)!;
    expect(commit.reason).toBe('replaceMessages');
    expect(commit.method).toBe('llm_checkpoint');
  });

  it('Esc during a blocking compaction returns control within the 2-с user-stop budget', { timeout: 60_000 }, async () => {
    // A summary provider call that hangs until its request signal aborts —
    // the exec streamFn has no idle timeout, so the turn signal is what must
    // stop it (the В1 setSummarySignal wiring).
    let seenRequestSignal: AbortSignal | undefined;
    const hangingStreamFn = (async (_model: unknown, _context: unknown, streamOptions: { signal?: AbortSignal }) => {
      seenRequestSignal = streamOptions?.signal;
      return {
        result: () =>
          new Promise<never>((_resolve, reject) => {
            const signal = streamOptions?.signal;
            if (signal === undefined) return; // would hang forever — the assert below catches it
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      };
    }) as unknown as typeof fixtureStreamFn;

    const path = composeTurnCompactionPath({ streamFn: hangingStreamFn });
    path.contextWire.seed({
      sessionId: SESSION,
      messages: [userMessage('fixture seed history', 1)],
      model: {
        provider: FIXTURE_MODEL.provider,
        modelId: FIXTURE_MODEL.id,
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: MODEL_MAX_TOKENS,
      },
    });
    for (let turn = 1; turn <= PHASE1_MESSAGES; turn += 1) {
      path.contextWire.observeCommit({
        sessionId: SESSION,
        reason: 'messageDelta',
        messages: [userMessage(`chunk-${turn}-${'x'.repeat(PHASE1_CHARS)}`, turn + 1)],
      });
    }
    path.contextWire.observeCommit({
      sessionId: SESSION,
      reason: 'messageDelta',
      messages: [userMessage(`tail-${'x'.repeat(PHASE2_CHARS)}`, PHASE1_MESSAGES + 2)],
    });
    expect(path.contextWire.windowBytes(SESSION) ?? 0).toBeGreaterThanOrEqual(
      MAX_BYTES * path.blockingBudgetRatio(),
    );

    // Esc fires 100 мс into the blocking wait — far inside the 2-с budget.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAtMs = Date.now();
    const decision = await path.runBeforeLlmCompactionHook(
      [userMessage('tail', PHASE1_MESSAGES + 2)],
      controller.signal,
    );
    const elapsedMs = Date.now() - startedAtMs;
    expect(
      elapsedMs,
      `the aborted wait must fit the user-stop budget (took ${elapsedMs}мс)`,
    ).toBeLessThan(2_000);
    // The barrier's skip decision returns control; the turn unwinds.
    expect(decision?.type).toBe('skip');
    expect(decision).toMatchObject({ reason: 'context_compaction_barrier_aborted' });
    // The turn's signal rode the summary request (the hang is stoppable).
    expect(seenRequestSignal, 'the summary request must carry the turn signal').toBeDefined();
    expect(seenRequestSignal!.aborted).toBe(true);
    // Nothing was published: an aborted summary never becomes a checkpoint.
    expect(path.compactCommits.length).toBe(0);
  });

  it('a summarizer refusal keeps the request going on the current window (the turn does not fail)', { timeout: 60_000 }, async () => {
    // The provider answers with an error stop — `getSummarizationFailure`
    // rejects it, no checkpoint is published, and the barrier fails OPEN.
    const failingStreamFn = async () => ({
      result: async () => ({
        content: [],
        stopReason: 'error',
        errorMessage: 'fixture summarizer outage',
        usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
        api: FIXTURE_MODEL.api,
        provider: FIXTURE_MODEL.provider,
        model: FIXTURE_MODEL.id,
        timestamp: 1,
      }),
    }) as unknown as typeof fixtureStreamFn;

    const path = composeTurnCompactionPath({ streamFn: failingStreamFn });
    path.contextWire.seed({
      sessionId: SESSION,
      messages: [userMessage('fixture seed history', 1)],
      model: {
        provider: FIXTURE_MODEL.provider,
        modelId: FIXTURE_MODEL.id,
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: MODEL_MAX_TOKENS,
      },
    });
    for (let turn = 1; turn <= PHASE1_MESSAGES; turn += 1) {
      path.contextWire.observeCommit({
        sessionId: SESSION,
        reason: 'messageDelta',
        messages: [userMessage(`chunk-${turn}-${'x'.repeat(PHASE1_CHARS)}`, turn + 1)],
      });
    }
    path.contextWire.observeCommit({
      sessionId: SESSION,
      reason: 'messageDelta',
      messages: [userMessage(`tail-${'x'.repeat(PHASE2_CHARS)}`, PHASE1_MESSAGES + 2)],
    });
    expect(path.contextWire.windowBytes(SESSION) ?? 0).toBeGreaterThanOrEqual(
      MAX_BYTES * path.blockingBudgetRatio(),
    );

    // The hook must not throw and must not replace: the request proceeds on
    // the current (still-fitting) window; the turn survives.
    const decision = await path.runBeforeLlmCompactionHook([
      userMessage('tail', PHASE1_MESSAGES + 2),
    ]);
    expect(decision?.type, 'the refusal must fail open to the ordinary request').toBe('continue');
    expect(path.compactCommits.length, 'a rejected summary publishes nothing').toBe(0);
    // The projection is still live for the request that goes out.
    const prepared = path.contextWire.projection(SESSION)?.project();
    expect(prepared).toBeDefined();
    expect(prepared!.records.length).toBeGreaterThan(0);
  });

  it('owner input appended while the summarizer runs survives the commit (the steering race, incident 2026-11-07)', { timeout: 60_000 }, async () => {
    // The owner's live shape: the byte axis crossed, the summarizer runs
    // 20-30s, the owner steers mid-job — the commit-time baseline must keep
    // the steer in the retained tail instead of dropping it (or, before the
    // fix, failing the one-summary validation forever).
    const STEER_DELAY_MS = 120;
    const delayedStreamFn = (async () => {
      await new Promise((resolve) => setTimeout(resolve, STEER_DELAY_MS));
      return fixtureStreamFn();
    }) as unknown as typeof fixtureStreamFn;
    const path = composeTurnCompactionPath({ streamFn: delayedStreamFn });
    path.contextWire.seed({
      sessionId: SESSION,
      messages: [userMessage('fixture seed history', 1)],
      model: {
        provider: FIXTURE_MODEL.provider,
        modelId: FIXTURE_MODEL.id,
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: MODEL_MAX_TOKENS,
      },
    });
    const backgroundBytes = MAX_BYTES * resolveCompactionBackgroundThresholdRatio();
    const feeds = Math.floor(backgroundBytes / (PHASE1_CHARS + 64)) + 4;
    for (let turn = 1; turn <= feeds; turn += 1) {
      path.contextWire.observeCommit({
        sessionId: SESSION,
        reason: 'messageDelta',
        messages: [userMessage(`chunk-${turn}-${'x'.repeat(PHASE1_CHARS)}`, turn + 1)],
      });
    }

    // The job starts (background); the owner steers WHILE the summarizer runs.
    const steer = userMessage('steer: change of plans mid-job', feeds + 10);
    setTimeout(() => {
      path.contextWire.observeCommit({
        sessionId: SESSION,
        reason: 'messageDelta',
        messages: [steer],
      });
    }, STEER_DELAY_MS / 2);

    await path.contextWire.whenCompactionIdle(SESSION);
    expect(path.compactCommits.length, 'the crossing must still commit a checkpoint').toBeGreaterThanOrEqual(1);
    const commit = path.compactCommits.at(-1)!;
    expect(commit.method).toBe('llm_checkpoint');
    expect((commit.messages[0] as { role?: string }).role).toBe('compactionSummary');
    // THE FIX: the steer is IN the committed replacement's retained tail, with
    // its source lineage — nothing appended mid-job was dropped.
    const committedMessages = commit.messages as readonly { role?: string; content?: unknown }[];
    const steerInTail = committedMessages.some(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content ?? '').includes('change of plans mid-job'),
    );
    expect(steerInTail, 'the mid-job owner input must survive in the kept tail').toBe(true);
    const sourceIndexes = (commit as { replacementSourceIndexes?: readonly number[] })
      .replacementSourceIndexes;
    expect(Array.isArray(sourceIndexes), 'the kept tail carries its source lineage').toBe(true);
    expect(sourceIndexes!.length).toBe(commit.messages.length - 1);
  });
});
