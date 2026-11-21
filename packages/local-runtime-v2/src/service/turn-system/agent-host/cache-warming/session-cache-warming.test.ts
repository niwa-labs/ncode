// Session cache-warming composition tests (W06 part B, review round 1):
// the product composition that instantiates the ONE per-session CacheWarmer
// and wires `withCacheWarming` over the composed MAIN stream path.

import { describe, expect, it } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { LLMCallSettledEvent } from '@mavis/agent-core/pi-turn-runner';
import type { Model } from '@earendil-works/pi-ai';

import {
  createSessionCacheWarming,
  MCODE_CACHE_WARMING_ENV,
  resolveCacheWarmingMode,
} from './session-cache-warming.js';

/** Anthropic-shaped catalog model with prompt-cache tiers (the only tiered provider today). */
function tieredModel(): Model<'anthropic-messages'> {
  return {
    id: 'claude-test',
    name: 'claude-test',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    promptCache: { short: 300, long: 3600 },
  } as unknown as Model<'anthropic-messages'>;
}

/** MiniMax-shaped catalog model — no promptCache tiers, warming must stay inert. */
function untieredModel(): Model<'openai-responses'> {
  return {
    id: 'MiniMax-test',
    name: 'MiniMax-test',
    api: 'openai-responses',
    provider: 'minimax',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as unknown as Model<'openai-responses'>;
}

function scriptedTransport(): { streamFn: StreamFn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const streamFn: StreamFn = (model, context, options) => {
    calls.push([model, context, options]);
    throw new Error('transport not expected to stream in this test');
  };
  return { streamFn, calls };
}

function settledUsageEvent(inputTokens: number): LLMCallSettledEvent {
  return {
    sessionId: 's1',
    turnId: 't1',
    callId: 'c1',
    scope: 'agent',
    provider: 'anthropic',
    model: 'claude-test',
    final: { outcome: 'success', errorKind: 'none' },
    retryTriggered: false,
    requestAttempts: 1,
    usage: {
      input: inputTokens,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

describe('resolveCacheWarmingMode (MCODE_CACHE_WARMING)', () => {
  it('defaults to the legacy-safe mode "off" and accepts explicit modes', () => {
    expect(resolveCacheWarmingMode({})).toBe('off');
    expect(resolveCacheWarmingMode({ [MCODE_CACHE_WARMING_ENV]: 'off' })).toBe('off');
    expect(resolveCacheWarmingMode({ [MCODE_CACHE_WARMING_ENV]: 'idle' })).toBe('idle');
    expect(resolveCacheWarmingMode({ [MCODE_CACHE_WARMING_ENV]: 'streaming' })).toBe('streaming'); // donor default is opt-in
  });

  it('fails safe to off on an invalid value', () => {
    expect(resolveCacheWarmingMode({ [MCODE_CACHE_WARMING_ENV]: 'sometimes' })).toBe('off');
  });
});

describe('createSessionCacheWarming (product composition)', () => {
  it('starts the ONE warmer on session-routed requests and delegates verbatim', () => {
    const warming = createSessionCacheWarming({ getMode: () => 'streaming' });
    const { streamFn, calls } = scriptedTransport();
    const wrapper = warming.wrapStreamFn('s1')(streamFn);

    const model = tieredModel();
    const context = { messages: [] } as never;
    const options = { sessionId: 's1' } as never;
    expect(() => wrapper(model, context, options)).toThrow('transport not expected');
    // The observation contract: the transport received the SAME argument
    // objects the wrapper observed (no copy, no re-serialization).
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(model);
    expect(calls[0]![1]).toBe(context);
    expect(calls[0]![2]).toBe(options);

    // A tiered model with retention: the warmer RUN exists (composed). With
    // no settled usage yet the economics are unavailable — the donor's
    // honest "do not warm on unknown economics" state — and once the host
    // feeds the session's prompt size the run reports scheduled.
    expect(warming.status('s1')).toMatchObject({
      state: 'inactive',
      reason: 'cache economics unavailable',
    });
    warming.onLLMCallSettled('s1', settledUsageEvent(100_000));
    expect(warming.status('s1')).toMatchObject({ state: 'scheduled' });
    expect(typeof warming.describeStatus('s1')).toBe('string');
    warming.dispose();
  });

  it('never starts a run for requests routed under a foreign session id', () => {
    const warming = createSessionCacheWarming({ getMode: () => 'streaming' });
    const { streamFn, calls } = scriptedTransport();
    const wrapper = warming.wrapStreamFn('s1')(streamFn);

    expect(() =>
      wrapper(tieredModel(), { messages: [] } as never, { sessionId: 'summary-x' } as never),
    ).toThrow('transport not expected');
    expect(calls).toHaveLength(1);
    // The warmer exists (the wrapper composed it) but no run was started:
    // it is still waiting for the session's first real request.
    expect(warming.status('s1')).toMatchObject({
      state: 'inactive',
      reason: 'waiting for first request',
    });
    warming.dispose();
  });

  it('stays inert for models without prompt-cache tiers (MiniMax catalog shape)', () => {
    const warming = createSessionCacheWarming({ getMode: () => 'streaming' });
    const { streamFn } = scriptedTransport();
    const wrapper = warming.wrapStreamFn('s1')(streamFn);

    expect(() =>
      wrapper(untieredModel(), { messages: [] } as never, { sessionId: 's1' } as never),
    ).toThrow('transport not expected');
    expect(warming.status('s1')).toMatchObject({
      state: 'inactive',
      reason: 'cache lifetime unavailable',
    });
    warming.dispose();
  });

  it('feeds economics from settled call usage and stops on agent settle (streaming)', () => {
    const warming = createSessionCacheWarming({ getMode: () => 'streaming' });
    const { streamFn } = scriptedTransport();
    const wrapper = warming.wrapStreamFn('s1')(streamFn);
    expect(() => wrapper(tieredModel(), { messages: [] } as never, { sessionId: 's1' } as never))
      .toThrow('transport not expected');

    // Before any settled usage the run exists but reports no economics.
    expect(warming.status('s1')).toMatchObject({ reason: 'cache economics unavailable' });

    warming.onLLMCallSettled('s1', settledUsageEvent(100_000));
    // promptTokensOf(input + cacheRead + cacheWrite) now feeds the decision.
    expect(warming.status('s1')?.decision?.economicsAvailable).toBe(true);

    warming.onAgentSettled('s1');
    expect(warming.status('s1')).toMatchObject({ state: 'inactive', reason: 'agent run settled' });
    warming.dispose();
  });

  it('disposeSession cancels the run and forgets the session', () => {
    const warming = createSessionCacheWarming({ getMode: () => 'streaming' });
    const { streamFn } = scriptedTransport();
    const wrapper = warming.wrapStreamFn('s1')(streamFn);
    expect(() => wrapper(tieredModel(), { messages: [] } as never, { sessionId: 's1' } as never))
      .toThrow('transport not expected');
    expect(warming.status('s1')).toBeDefined();

    warming.disposeSession('s1');
    expect(warming.status('s1')).toBeUndefined();
    warming.dispose();
  });

  it('bounds the warmer registry: the oldest tracked session is evicted', () => {
    const warming = createSessionCacheWarming({ getMode: () => 'streaming' });
    const { streamFn } = scriptedTransport();
    for (let index = 0; index < 9; index += 1) {
      warming.wrapStreamFn(`s${index}`)(streamFn);
    }
    // s0 was evicted once the 9th session was tracked; s8 is still tracked
    // (its warmer never started a run, so it reports the waiting state).
    expect(warming.status('s0')).toBeUndefined();
    expect(warming.status('s8')).toMatchObject({ reason: 'waiting for first request' });
    warming.dispose();
  });
});
