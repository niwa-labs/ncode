// CacheWarmer parity against the pin (coding-agent test/cache-warmer.test.ts,
// 48c8f32 — read line-by-line; the numeric expectations below are the pin's
// own numbers on the same catalog models) plus the W06 part-B adaptations:
// the single-controller absorption of speculation intentions (map §4 :501)
// and the V-A04 stale-revision guard.

import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
  Usage,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CacheWarmer,
  type CacheWarmingAction,
  type CacheWarmingDecision,
  type CacheWarmingDecisionEvent,
  type CacheWarmRequest,
  formatCacheWarmingStatus,
  getCacheWarmingDelayMs,
  getPromptCacheTtlMs,
  isReplayable,
  revisionStillCurrent,
} from '../../src/index.js';
import type { AppendCacheWarmUsageInput, CacheWarmUsageRecord } from '../../src/index.js';
import type { WarmRevision } from '../../src/index.js';

const adaptiveModel: Model<Api> = {
  ...getBuiltinModel('anthropic', 'claude-opus-4-6'),
  promptCache: { short: 300, long: 3600 },
};
const budgetModel: Model<Api> = {
  ...getBuiltinModel('anthropic', 'claude-sonnet-4-5'),
  promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
  ...getBuiltinModel('openai', 'gpt-5'),
  promptCache: { short: 300, long: 86_400 },
};
const unknownModel: Model<Api> = { ...adaptiveModel, promptCache: undefined };

const warmUsage: Usage = {
  input: 0,
  output: 1,
  cacheRead: 100,
  cacheWrite: 0,
  totalTokens: 101,
  cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(model: Model<Api>, stopReason: AssistantMessage['stopReason'] = 'length'): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: warmUsage,
    stopReason,
    timestamp: 0,
  };
}

const context = { messages: [] } as unknown as TranscriptContext;

function fakeRuntime(
  options: {
    result?: (model: Model<Api>) => Promise<AssistantMessage>;
    decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction | Promise<CacheWarmingAction>;
    mode?: 'off' | 'streaming' | 'idle';
    promptTokens?: number;
  } = {},
) {
  const calls: Array<{ model: Model<Api>; options: SimpleStreamOptions | undefined }> = [];
  const events: CacheWarmingDecisionEvent[] = [];
  const usage: AppendCacheWarmUsageInput[] = [];
  const warmed: CacheWarmUsageRecord[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const state = { mode: options.mode ?? 'idle', promptTokens: options.promptTokens ?? 100_000 };
  const warmer = new CacheWarmer(
    {
      streamSimple: (model, _context, streamOptions) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push({ model, options: streamOptions });
        const done = (async () => (options.result ?? (async (m: Model<Api>) => response(m)))(model))().finally(
          () => {
            inFlight -= 1;
          },
        );
        // The pinned AssistantMessageEventStream answers result() with the
        // final message; a thenable stand-in keeps the double minimal.
        return { result: () => done } as unknown as AssistantMessageEventStream;
      },
    },
    { lastPromptTokens: () => state.promptTokens },
    async (input) => {
      usage.push(input);
      return { kind: 'cache_warm', ...input, usage: { ...input.usage }, timestampMs: 0 };
    },
    () => state.mode,
    async (event) => {
      events.push(event);
      return options.decide?.(event) ?? event.action;
    },
  );
  warmer.onWarmed = (record) => warmed.push(record);
  return { warmer, calls, events, usage, warmed, state, maxInFlight: () => maxInFlight };
}

function request(
  model: Model<Api> = adaptiveModel,
  options: SimpleStreamOptions = {},
  revision?: WarmRevision,
  source?: 'agent' | 'speculation',
): CacheWarmRequest {
  return {
    model,
    context,
    options,
    ...(revision !== undefined ? { revision } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

const current = () => true;

afterEach(() => vi.useRealTimers());

describe('cache warming eligibility and timing (pin parity)', () => {
  it('derives eligibility and timing from retention and provider behavior', () => {
    expect([
      getPromptCacheTtlMs(adaptiveModel, undefined),
      getPromptCacheTtlMs(adaptiveModel, { cacheRetention: 'long' }),
      getPromptCacheTtlMs(adaptiveModel, { cacheRetention: 'none' }),
      getPromptCacheTtlMs(adaptiveModel, { env: { PI_CACHE_RETENTION: 'long' } }),
      getPromptCacheTtlMs(openaiModel, { cacheRetention: 'long' }),
      getPromptCacheTtlMs(unknownModel, undefined),
    ]).toEqual([300_000, 3_600_000, undefined, 3_600_000, 86_400_000, undefined]);
    expect([getCacheWarmingDelayMs(300_000), getCacheWarmingDelayMs(60_000), getCacheWarmingDelayMs(10_000)]).toEqual(
      [270_000, 50_000, undefined],
    );
    expect([
      isReplayable(budgetModel, { reasoning: 'medium' }),
      isReplayable(budgetModel, undefined),
      isReplayable(adaptiveModel, { reasoning: 'medium' }),
      isReplayable(openaiModel, { reasoning: 'medium' }),
    ]).toEqual([false, true, true, true]);
  });
});

describe('cache warming refresh cycle (pin parity)', () => {
  it('replays profitable requests and preserves options across repeated refreshes', async () => {
    vi.useFakeTimers();
    const { warmer, calls, events, usage, warmed } = fakeRuntime();
    const signal = new AbortController().signal;
    const temperature = 0.7;

    warmer.start(request(adaptiveModel, { reasoning: 'high', signal, sessionId: 's', temperature }), current);
    await vi.advanceTimersByTimeAsync(270_000);

    expect(calls[0]).toMatchObject({
      model: adaptiveModel,
      options: { reasoning: 'high', sessionId: 's', temperature, maxTokens: 1, maxRetries: 0 },
    });
    expect(calls[0].options?.signal).not.toBe(signal);
    expect(events[0]).toMatchObject({
      type: 'cache_warming_decision',
      continuationProbability: 1,
      action: 'warm',
    });
    expect(events[0]!.missCost).toBeCloseTo(0.575);
    expect(events[0]!.warmCost).toBeCloseTo(0.050025);
    expect(usage[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-6' });
    expect(usage[0]!.usage).toBe(warmUsage);
    expect(warmed).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(270_000);
    expect(calls).toHaveLength(2);
    warmer.cancel();
  });

  it('bills the responded model, not the requested one', async () => {
    vi.useFakeTimers();
    const { warmer, calls, usage } = fakeRuntime({
      result: async () => ({ ...response(adaptiveModel), responseModel: 'claude-opus-4-6-virtual' }),
    });
    warmer.start(request(), current);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(calls).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'claude-opus-4-6-virtual' });
    warmer.cancel();
  });

  it('does not issue refreshes after their safe deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { warmer, calls } = fakeRuntime();
    warmer.start(request(), current);

    // A five-minute cache is scheduled for 4m30s and retains half of the
    // 30-second expiry margin. Simulate a timer delayed by sleep.
    vi.setSystemTime(285_001);
    vi.clearAllTimers();
    const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
    if (!internal.run) throw new Error('expected an active cache-warming run');
    await internal.refresh(internal.run);

    expect(calls).toHaveLength(0);
    expect(warmer.status).toMatchObject({ state: 'inactive', reason: 'cache refresh deadline missed' });
  });

  it('rechecks the deadline after an extension decision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { warmer, calls } = fakeRuntime({
      decide: async () => {
        await Promise.resolve();
        vi.setSystemTime(285_001);
        return 'warm' as const;
      },
    });
    warmer.start(request(), current);
    vi.clearAllTimers();
    const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
    if (!internal.run) throw new Error('expected an active cache-warming run');
    await internal.refresh(internal.run);

    expect(calls).toHaveLength(0);
    expect(warmer.status).toMatchObject({ state: 'inactive', reason: 'cache refresh deadline missed' });
  });
});

describe('cache warming economics and extension overrides (pin parity)', () => {
  it('applies economic decisions and extension overrides', async () => {
    vi.useFakeTimers();
    const unprofitable = fakeRuntime({ promptTokens: 5_000 });
    unprofitable.warmer.start(request(), current);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(unprofitable.calls).toHaveLength(0);
    expect(unprofitable.warmer.status).toMatchObject({
      state: 'inactive',
      decision: { action: 'stop', economicsAvailable: true },
      extensionOverride: false,
    });

    const forced = fakeRuntime({ promptTokens: 5_000, decide: () => 'warm' });
    forced.warmer.start(request(), current);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(forced.calls).toHaveLength(1);
    expect(forced.usage[0]!.note).toBe('extension override');
    forced.warmer.cancel();

    const vetoed = fakeRuntime({ decide: () => 'stop' });
    vetoed.warmer.start(request(), current);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(vetoed.calls).toHaveLength(0);
    expect(vetoed.warmer.status).toMatchObject({ state: 'inactive', extensionOverride: true });

    const unavailable = fakeRuntime({ promptTokens: 0 });
    unavailable.warmer.start(request(), current);
    expect(unavailable.warmer.status).toMatchObject({
      state: 'inactive',
      reason: 'cache economics unavailable',
    });
    await vi.advanceTimersByTimeAsync(270_000);
    expect(unavailable.calls).toHaveLength(0);
  });

  it('uses the idle continuation probability once the agent settled', async () => {
    vi.useFakeTimers();
    const { warmer, events } = fakeRuntime();
    warmer.start(request(), current);
    warmer.onAgentSettled();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(events[0]!.continuationProbability).toBeCloseTo(0.15);
    expect(warmer.status.decision?.phase).toBe('idle');
    warmer.cancel();
  });
});

describe('cache warming stops (pin parity)', () => {
  it('stops for unsupported requests, context changes, and mode changes', async () => {
    vi.useFakeTimers();
    const unsupported = fakeRuntime();
    unsupported.state.mode = 'off';
    unsupported.warmer.start(request(), current);
    expect(unsupported.warmer.status.reason).toBe('cache warming disabled');
    unsupported.state.mode = 'idle';
    unsupported.warmer.start(request(unknownModel), current);
    expect(unsupported.warmer.status.reason).toBe('cache lifetime unavailable');
    unsupported.warmer.start(request(adaptiveModel, { cacheRetention: 'none' }), current);
    expect(unsupported.warmer.status.reason).toBe('request disabled prompt caching');
    unsupported.warmer.start(request(budgetModel, { reasoning: 'high' }), current);
    expect(unsupported.warmer.status.reason).toBe('request cannot be replayed safely');

    let stillCurrent = true;
    unsupported.warmer.start(request(), () => stillCurrent);
    stillCurrent = false;
    expect(unsupported.warmer.status.reason).toBe('conversation context changed');
    await vi.advanceTimersByTimeAsync(270_000);
    expect(unsupported.calls).toHaveLength(0);

    unsupported.warmer.start(request(), current);
    unsupported.state.mode = 'off';
    await vi.advanceTimersByTimeAsync(270_000);
    expect(unsupported.calls).toHaveLength(0);

    const streaming = fakeRuntime({ mode: 'streaming', promptTokens: 400_000 });
    streaming.warmer.start(request(), current);
    streaming.warmer.onAgentSettled();
    expect(streaming.warmer.status.reason).toBe('agent run settled');
  });

  it('enforces the fixed idle safety window (30m)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fresh = fakeRuntime({ mode: 'idle', promptTokens: 400_000 });
    fresh.warmer.start(request(), current);
    fresh.warmer.onAgentSettled();
    vi.setSystemTime(29 * 60_000);
    fresh.warmer.onModeChanged();
    expect(fresh.warmer.status.state).toBe('scheduled');

    vi.setSystemTime(0);
    const older = fakeRuntime({ mode: 'idle', promptTokens: 400_000 });
    older.warmer.start(request(), current);
    // The agent settles past the idle horizon: the run must stop instead of
    // arming another refresh against a stale continuation estimate.
    vi.setSystemTime(31 * 60_000);
    older.warmer.onAgentSettled();
    expect(older.warmer.status.reason).toBe('30-minute idle safety limit reached');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(older.calls).toHaveLength(0);
  });
});

describe('cache warming abort/failure accounting (pin parity)', () => {
  it('aborts replaced requests and does not record failed refreshes', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = fakeRuntime({
      result: (model) =>
        new Promise((resolve) => {
          release = () => resolve(response(model));
        }),
    });
    pending.warmer.start(request(), current);
    await vi.advanceTimersByTimeAsync(270_000);
    pending.warmer.start(request(), current);
    expect(pending.calls[0].options?.signal?.aborted).toBe(true);
    release();
    pending.warmer.cancel();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(pending.calls).toHaveLength(1);

    const failed = fakeRuntime({ result: async (model) => response(model, 'error') });
    failed.warmer.start(request(), current);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(failed.usage).toHaveLength(0);
    failed.warmer.cancel();
  });
});

describe('single controller: speculation intentions are absorbed (map §4 :501)', () => {
  it('one warmer serves agent and speculation sources with ONE in-flight job', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const runtime = fakeRuntime({
      result: (model) =>
        new Promise((resolve) => {
          release = () => resolve(response(model));
        }),
    });
    const revision: WarmRevision = {
      conversationId: 'c1',
      head: 10,
      watermark: { seq: 10, ordinal: 0 },
      editVersion: 0,
    };

    runtime.warmer.start(request(adaptiveModel, {}, revision, 'agent'), current);
    await vi.advanceTimersByTimeAsync(270_000);
    // A speculation prewarm intention arrives mid-flight: the SAME controller
    // replaces the run — the speculation side never builds a second warmer.
    runtime.warmer.start(request(adaptiveModel, {}, revision, 'speculation'), current);
    expect(runtime.calls[0].options?.signal?.aborted).toBe(true);
    expect(runtime.warmer.status.source).toBe('speculation');
    release();

    await vi.advanceTimersByTimeAsync(270_000);
    expect(runtime.maxInFlight()).toBe(1);
    expect(runtime.warmer.status.source).toBe('speculation');
    runtime.warmer.cancel();
  });

  it('the warmer is the only writer of cache_warm usage — a stale run records nothing', async () => {
    vi.useFakeTimers();
    const runtime = fakeRuntime();
    let live = true;
    runtime.warmer.start(request(), () => live);
    live = false;
    await vi.advanceTimersByTimeAsync(270_000);
    expect(runtime.calls).toHaveLength(0);
    expect(runtime.usage).toHaveLength(0);
  });
});

describe('stale revision guard (V-A04 adaptation)', () => {
  const at: WarmRevision = { conversationId: 'c1', head: 7, watermark: { seq: 7, ordinal: 2 }, editVersion: 3 };

  it('current only at the exact same revision; unknown is stale', () => {
    expect(revisionStillCurrent(at, () => at)()).toBe(true);
    expect(revisionStillCurrent(at, () => ({ ...at, head: 8, watermark: { seq: 8, ordinal: 0 } }))()).toBe(false);
    expect(revisionStillCurrent(at, () => ({ ...at, editVersion: 4 }))()).toBe(false);
    expect(revisionStillCurrent(at, () => ({ ...at, conversationId: 'c2' }))()).toBe(false);
    expect(revisionStillCurrent(at, () => undefined)()).toBe(false);
  });

  it('a projection advance cancels the warm at the next refresh', async () => {
    vi.useFakeTimers();
    const runtime = fakeRuntime();
    let currentRevision: WarmRevision | undefined = { ...at };
    runtime.warmer.start(request(adaptiveModel, {}, at), revisionStillCurrent(at, () => currentRevision));
    expect(runtime.warmer.status.state).toBe('scheduled');
    // The conversation moves on (new committed entry): the stale snapshot
    // must cancel warming BEFORE any provider request leaves.
    currentRevision = { ...at, head: 8, watermark: { seq: 8, ordinal: 0 } };
    expect(runtime.warmer.status).toMatchObject({ state: 'inactive', reason: 'conversation context changed' });
    await vi.advanceTimersByTimeAsync(270_000);
    expect(runtime.calls).toHaveLength(0);
  });
});

describe('status formatting (pin parity)', () => {
  it('formats status and usage entries', () => {
    const decision: CacheWarmingDecision = {
      phase: 'idle',
      warmCost: 0.013,
      missCost: 0.621,
      continuationProbability: 0.6,
      expectedSavings: 0.36,
      economicsAvailable: true,
      action: 'warm',
    };
    expect(formatCacheWarmingStatus({ state: 'scheduled', nextWarmAt: 222_000, decision }, 0)).toBe(
      'Decision in 3m 42s (60% continuation probability, expected savings $0.360 >= $0.050 -> warm)',
    );
  });
});
