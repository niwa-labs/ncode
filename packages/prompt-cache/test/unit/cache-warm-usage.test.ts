// The `cache_warm` usage writer (V-U02, W05 deferral → W06 part B).
//
// The pin records each successful refresh via
// `sessionManager.appendUsage("cache_warm", provider, responseModel ?? model,
// usage, note?)`; our declared writer mapping persists the same numbers as an
// explicit `mcode.usage` durable entry under the `cache_warm` category. This
// suite pins:
//   1. the draft's payload passes `@mavis/context-projection`'s STRICT
//      `UsagePayload` reader and folds under BOTH axes (provider/model
//      billing + the writer-defined `cache_warm` category);
//   2. the entry is a CONTROL kind — a warm refresh never becomes an LLM
//      segment, so warming cannot pollute the context-token trigger;
//   3. zero-drop, `totalTokens` fallback, optional splits, note handling;
//   4. the durable sink appends exactly one draft and answers the record
//      `onWarmed` consumes;
//   5. the one-line transcript text (pin `formatCacheWarmingUsage` parity).

import type { Usage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import {
  CACHE_WARM_USAGE_ENTRY_KIND,
  CACHE_WARM_USAGE_KIND,
  createCacheWarmUsageEntryDraft,
  createDurableCacheWarmUsageSink,
  formatCacheWarmingUsage,
  isZeroWarmUsage,
  normalizeWarmUsage,
  promptTokensOf,
} from '../../src/index.js';
import { asUsagePayload, buildProjection } from '../../../context-projection/src/index.js';
import type { Entry, JsonValue, Seq } from '../../../durable-backend-sqlite-zstd/src/types.js';

const usage: Usage = {
  input: 0,
  output: 1,
  cacheRead: 100_000,
  cacheWrite: 0,
  totalTokens: 100_001,
  cost: { input: 0, output: 0.000025, cacheRead: 0.05, cacheWrite: 0, total: 0.050025 },
};

function projectionEntryFor(draft: ReturnType<typeof createCacheWarmUsageEntryDraft>): Entry {
  if (draft === undefined) throw new Error('expected a usage draft');
  return {
    id: draft.id,
    parentId: null,
    kind: draft.kind,
    payload: draft.payload as JsonValue,
    seq: 1 as Seq,
    ordinal: 0,
  };
}

describe('draft shape', () => {
  it('normalizes the full payload with the attribution it was given', () => {
    const draft = createCacheWarmUsageEntryDraft(
      'u1',
      { provider: 'anthropic', model: 'claude-opus-4-6' },
      usage,
      undefined,
      () => 123,
    );
    expect(draft).toMatchObject({
      id: 'u1',
      kind: CACHE_WARM_USAGE_ENTRY_KIND,
      payload: {
        kind: CACHE_WARM_USAGE_KIND,
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        usage: {
          input: 0,
          output: 1,
          cacheRead: 100_000,
          cacheWrite: 0,
          totalTokens: 100_001,
          cost: { total: 0.050025 },
        },
        timestampMs: 123,
      },
    });
    expect('note' in (draft!.payload as Record<string, unknown>)).toBe(false);
  });

  it('passes optional splits through and drops all-zero records', () => {
    const withSplits = normalizeWarmUsage({
      ...usage,
      cacheWrite1h: 40,
      reasoning: 12,
    } as Usage);
    expect(withSplits.cacheWrite1h).toBe(40);
    expect(withSplits.reasoning).toBe(12);

    const zero: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    expect(isZeroWarmUsage(normalizeWarmUsage(zero))).toBe(true);
    expect(
      createCacheWarmUsageEntryDraft('u0', { provider: 'p', model: 'm' }, zero),
    ).toBeUndefined();
  });

  it('falls back to the counter sum when the transport omitted totalTokens', () => {
    const partial = {
      input: 3,
      output: 4,
      cacheRead: 5,
      cacheWrite: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as Usage;
    expect(normalizeWarmUsage(partial).totalTokens).toBe(18);
  });

  it('promptTokensOf is the pin arithmetic (input + cacheRead + cacheWrite)', () => {
    expect(promptTokensOf({ input: 3, cacheRead: 5, cacheWrite: 7 })).toBe(15);
  });
});

describe('cross-package: the projection folds the cache_warm entry (V-U02)', () => {
  it('decodes through the strict reader and folds under both axes, never into the context', () => {
    const draft = createCacheWarmUsageEntryDraft(
      'warm-1',
      { provider: 'anthropic', model: 'claude-opus-4-6' },
      usage,
      'extension override',
      () => 7,
    );
    const entry = projectionEntryFor(draft);

    const decoded = asUsagePayload(entry.payload, entry.id);
    expect(decoded).toMatchObject({ kind: 'cache_warm', provider: 'anthropic', model: 'claude-opus-4-6' });
    expect(decoded.usage.cacheRead).toBe(100_000);

    const manifest = buildProjection([entry]);
    // BOTH pi axes: provider/model billing AND the writer-defined category.
    expect(manifest.usage!.models['anthropic/claude-opus-4-6']!.cacheRead).toBe(100_000);
    expect(manifest.usage!.models['anthropic/claude-opus-4-6']!.cost.total).toBeCloseTo(0.050025);
    expect(manifest.usage!.categories.cache_warm!.cacheRead).toBe(100_000);
    // A usage entry never becomes an LLM segment: the one-token replay stays
    // out of the transcript (V-A05: "one-token response не в transcript").
    expect(manifest.segments).toEqual([]);
  });

  it('accumulates across refreshes without touching other categories', () => {
    const drafts = [1, 2].map((n) =>
      createCacheWarmUsageEntryDraft(
        `warm-${n}`,
        { provider: 'openai', model: 'gpt-5' },
        usage,
        undefined,
        () => n,
      ),
    );
    const manifest = buildProjection(
      drafts.map((d, i) => ({
        ...projectionEntryFor(d),
        parentId: i === 0 ? null : drafts[i - 1]!.id,
        seq: (i + 1) as Seq,
      })),
    );
    expect(manifest.usage!.categories.cache_warm!.cacheRead).toBe(200_000);
    expect(manifest.usage!.categories.summary).toBeUndefined();
    expect(manifest.usage!.models['openai/gpt-5']!.totalTokens).toBe(200_002);
  });
});

describe('durable sink', () => {
  it('appends exactly one draft per refresh and answers the persisted record', async () => {
    const appended: unknown[] = [];
    const sink = createDurableCacheWarmUsageSink(
      (draft) => {
        appended.push(draft);
      },
      { nextId: () => 'fixed-id', now: () => 42 },
    );
    const record = await sink({ provider: 'anthropic', model: 'claude-opus-4-6', usage });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ id: 'fixed-id', kind: 'mcode.usage' });
    expect(record).toMatchObject({ kind: 'cache_warm', provider: 'anthropic', timestampMs: 42 });

    const none = await sink({ provider: 'anthropic', model: 'claude-opus-4-6', usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } });
    expect(none).toBeUndefined();
    expect(appended).toHaveLength(1);
  });
});

describe('transcript text (pin parity)', () => {
  it('formats the one-line usage notice', () => {
    const record = {
      kind: CACHE_WARM_USAGE_KIND,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      usage: {
        ...usage,
        cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
      },
      note: 'extension override',
      timestampMs: 0,
    } as const;
    expect(formatCacheWarmingUsage(record)).toBe('Cache warmed (extension override): $0.029497');
    expect(formatCacheWarmingUsage({ ...record, note: undefined })).toBe('Cache warmed: $0.029497');
  });
});
