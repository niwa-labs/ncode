// cacheRetention precedence, session affinity, and the wire wrapper
// (W06 part B, V-A01 «promptCache tiers/cacheRetention/PI_CACHE_RETENTION,
// provider affinity/sessionId и explicit option precedence»).
//
// Precedence is the documented host policy (port-plan §3.2 :478): explicit
// request policy → profile/settings → PI_CACHE_RETENTION env → adapter
// default "short". The wire wrapper asserts the W03 segment-identity rule:
// observation never copies or rebuilds the request objects.

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import {
  CacheWarmer,
  effectiveCacheRetention,
  PI_CACHE_RETENTION_ENV,
  resolveCacheRetentionPolicy,
  resolveSessionAffinity,
  withCacheWarming,
} from '../../src/index.js';

const model: Model<Api> = {
  ...getBuiltinModel('anthropic', 'claude-opus-4-6'),
  promptCache: { short: 300, long: 3600 },
};

describe('cacheRetention precedence (V-A01)', () => {
  it('explicit request policy wins over host policy and env', () => {
    expect(resolveCacheRetentionPolicy('none', 'long', { PI_CACHE_RETENTION: 'long' })).toBe('none');
    expect(resolveCacheRetentionPolicy('long', 'short', { PI_CACHE_RETENTION: 'short' })).toBe('long');
  });

  it('host profile/settings policy wins over env', () => {
    expect(resolveCacheRetentionPolicy(undefined, 'none', { PI_CACHE_RETENTION: 'long' })).toBe('none');
    expect(resolveCacheRetentionPolicy(undefined, 'short', { [PI_CACHE_RETENTION_ENV]: 'long' })).toBe('short');
  });

  it('PI_CACHE_RETENTION=long selects long; other values fall through to the adapter default', () => {
    expect(resolveCacheRetentionPolicy(undefined, undefined, { PI_CACHE_RETENTION: 'long' })).toBe('long');
    // The pinned adapters only recognize "long" in the env; anything else
    // (including an explicit "short" or "none") keeps the default — only an
    // explicit request/host policy can express those.
    expect(resolveCacheRetentionPolicy(undefined, undefined, { PI_CACHE_RETENTION: 'short' })).toBeUndefined();
    expect(resolveCacheRetentionPolicy(undefined, undefined, { PI_CACHE_RETENTION: 'none' })).toBeUndefined();
    expect(resolveCacheRetentionPolicy(undefined, undefined, {})).toBeUndefined();
  });

  it('effective retention defaults to short when nobody chose', () => {
    expect(effectiveCacheRetention(undefined, undefined, {})).toBe('short');
    expect(effectiveCacheRetention(undefined, undefined, { PI_CACHE_RETENTION: 'long' })).toBe('long');
    expect(effectiveCacheRetention('none', undefined, {})).toBe('short');
  });
});

describe('session affinity (V-A01: the provider cache key)', () => {
  it('carries the session id unless caching is disabled', () => {
    expect(resolveSessionAffinity({ sessionId: 's1', cacheRetention: undefined })).toBe('s1');
    expect(resolveSessionAffinity({ sessionId: 's1', cacheRetention: 'short' })).toBe('s1');
    expect(resolveSessionAffinity({ sessionId: 's1', cacheRetention: 'long', env: {} })).toBe('s1');
    expect(resolveSessionAffinity({ sessionId: 's1', cacheRetention: 'none' })).toBeUndefined();
    // Retention resolved through the env fallback keeps affinity on.
    expect(
      resolveSessionAffinity({ sessionId: 's1', cacheRetention: undefined, env: { PI_CACHE_RETENTION: 'long' } }),
    ).toBe('s1');
  });
});

describe('withCacheWarming: the warm-intention seam on our wire', () => {
  const context = { messages: [] } as unknown as TranscriptContext;
  const revision = { conversationId: 'c1', head: 3, watermark: { seq: 3, ordinal: 0 }, editVersion: 0 };

  function harness() {
    const started: Array<{ model: Model<Api>; sessionId?: string; revision?: typeof revision }> = [];
    const warmer = new CacheWarmer(
      { streamSimple: (() => ({})) as unknown as StreamFn },
      { lastPromptTokens: () => 100_000 },
      async () => undefined,
      () => 'idle',
    );
    vi.spyOn(warmer, 'start').mockImplementation((req, isCurrent) => {
      started.push({ model: req.model, sessionId: req.options.sessionId, revision: req.revision });
      expect(typeof isCurrent).toBe('function');
    });
    const seen: Array<{ model: unknown; context: unknown; options: unknown }> = [];
    const inner: StreamFn = (m, c, o) => {
      seen.push({ model: m, context: c, options: o });
      return { result: async () => ({ stopReason: 'stop' }) } as unknown as AssistantMessageEventStream;
    };
    return { warmer, started, seen, inner };
  }

  async function resultOf(call: ReturnType<StreamFn>): Promise<unknown> {
    const stream = await call;
    return stream.result();
  }

  it('a session request starts the warmer and reaches the transport by the SAME object references', async () => {
    const { warmer, started, seen, inner } = harness();
    const wrapped = withCacheWarming(inner, {
      warmer,
      sessionId: 'session-1',
      isCurrent: () => () => true,
      revision: () => revision,
    });
    const options: SimpleStreamOptions = { sessionId: 'session-1', cacheRetention: 'short' };
    await resultOf(wrapped(model, context, options));

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ model, sessionId: 'session-1', revision });
    // Segment identity (W03): the wrapper observed without copying — the
    // transport received the identical objects, and the warm intention is
    // the SAME context/options the real request used.
    expect(seen[0]!.model).toBe(model);
    expect(seen[0]!.context).toBe(context);
    expect(seen[0]!.options).toBe(options);
  });

  it('foreign routing ids (summaries, other sessions) never replace the warmed entry', async () => {
    const { warmer, started, seen, inner } = harness();
    const wrapped = withCacheWarming(inner, {
      warmer,
      sessionId: 'session-1',
      isCurrent: () => () => true,
    });
    // The W05 summarizer routes with a fresh `summary-<uuid>` id: warming
    // must stay on the session's entry ("Summary warming отключён").
    await resultOf(wrapped(model, context, { sessionId: 'summary-8e2' }));
    await resultOf(wrapped(model, context, { sessionId: 'other-session' }));
    await resultOf(wrapped(model, context, undefined));

    expect(started).toHaveLength(0);
    expect(seen).toHaveLength(3);
  });
});
