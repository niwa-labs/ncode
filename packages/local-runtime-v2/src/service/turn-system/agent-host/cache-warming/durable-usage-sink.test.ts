// The cache_warm durable-port tests (W10 part B): the `mcode.usage` billing
// mirror of warm refreshes bound to the Ш1 durable-history storage worker.

import { describe, expect, it } from 'vitest';
import type { Usage } from '@earendil-works/pi-ai';
import type { Entry, StorageWorker } from '@mavis/storage-worker';

import { createDurableHistoryCacheWarmUsageSink } from './durable-usage-sink.js';

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 100,
    output: 0,
    cacheRead: 0,
    cacheWrite: 200,
    totalTokens: 300,
    cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0.2, total: 0.3 },
    ...overrides,
  } as Usage;
}

function recordingWorker(): StorageWorker & { entries: Entry[] } {
  const entries: Entry[] = [];
  return {
    entries,
    enqueue: async (entry: Entry) => {
      entries.push(entry);
    },
  } as unknown as StorageWorker & { entries: Entry[] };
}

describe('createDurableHistoryCacheWarmUsageSink (W10 durable port)', () => {
  it('appends one mcode.usage entry per successful refresh through the shared worker', async () => {
    const worker = recordingWorker();
    const sink = createDurableHistoryCacheWarmUsageSink({ worker });

    const record = await sink({
      provider: 'anthropic',
      model: 'claude-test',
      usage: usage(),
      note: 'idle refresh',
    });

    expect(worker.entries).toHaveLength(1);
    const entry = worker.entries[0]!;
    // The durable log contract: canonical worker dictionary, control kind,
    // no parent chain of its own (log order is authoritative).
    expect(entry.kind).toBe('mcode.usage');
    expect(entry.parentId).toBeNull();
    expect(typeof entry.entryId).toBe('string');
    expect(entry.entryId.length).toBeGreaterThan(0);
    expect(entry.bytes).toBeGreaterThan(0);
    // The sink resolves with the SAME record it persisted.
    expect(record).toEqual(entry.payload);
    const payload = entry.payload as {
      kind: string;
      provider: string;
      model: string;
      usage: { input: number; cacheWrite: number; totalTokens: number };
      note?: string;
      timestampMs: number;
    };
    // The payload mirrors the pin's appendUsage attribution (responded model)
    // and the full counter shape the projection's strict decoder requires.
    expect(payload.kind).toBe('cache_warm');
    expect(payload.provider).toBe('anthropic');
    expect(payload.model).toBe('claude-test');
    expect(payload.usage.input).toBe(100);
    expect(payload.usage.cacheWrite).toBe(200);
    expect(payload.usage.totalTokens).toBe(300);
    expect(payload.note).toBe('idle refresh');
    expect(typeof payload.timestampMs).toBe('number');
  });

  it('writes nothing for an all-zero refresh (render-parity zero filter)', async () => {
    const worker = recordingWorker();
    const sink = createDurableHistoryCacheWarmUsageSink({ worker });

    const record = await sink({
      provider: 'anthropic',
      model: 'claude-test',
      usage: usage({
        input: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    });

    expect(record).toBeUndefined();
    expect(worker.entries).toHaveLength(0);
  });

  it('swallows a worker failure — the mirror never breaks the agent run', async () => {
    const failingWorker = {
      enqueue: async (): Promise<void> => {
        throw new Error('queue sealed');
      },
    } as unknown as StorageWorker;
    const sink = createDurableHistoryCacheWarmUsageSink({ worker: failingWorker });

    // The contract under test: the AppendCacheWarmUsage callback RESOLVES
    // even when the worker rejects — the append port logs the failure and the
    // turn (and the warmer's own refresh path) never sees the mirror error.
    await expect(
      sink({ provider: 'anthropic', model: 'claude-test', usage: usage() }),
    ).resolves.toBeDefined();
  });
});
