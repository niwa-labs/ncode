import { describe, expect, it, vi } from 'vitest';

import { createStorageWorker } from '../../src/client.js';
import type { Entry } from '../../src/contracts.js';
import { deferred, makeCommit, makeEntry } from '../helpers.js';

// The dispose/enqueue race: what happens to entries that are in flight, parked
// on backpressure, or racing with the final drain while the handle is being
// torn down. The invariant under test is that no entry is silently lost and
// no caller hangs: every entry is either committed or explicitly rejected.

describe('storage worker: dispose races with enqueue', () => {
  it('rejects a parked enqueue with the terminal error instead of leaving it hanging', async () => {
    const backend = {
      appendBatch: vi.fn(async (_entries: Entry[]) => {
        const error = new Error('owner epoch moved; another writer took over this generation');
        error.name = 'OwnerLostError';
        throw error;
      }),
    };
    const worker = createStorageWorker(backend, { queueBytes: 100, windowMs: 60_000 });

    await worker.enqueue(makeEntry(100, { entryId: 'head' })); // fills the ceiling
    const parked = worker.enqueue(makeEntry(50, { entryId: 'parked' })); // parks on backpressure

    // The flush drives the append, which fails terminally.
    await expect(worker.flush()).rejects.toMatchObject({ name: 'OwnerLostError' });

    // The parked caller is released with the SAME terminal error: the handle
    // fails closed instead of parking the caller forever.
    await expect(parked).rejects.toMatchObject({ name: 'OwnerLostError' });

    // Fail-closed: later writes reject with the same terminal error.
    await expect(worker.enqueue(makeEntry(10, { entryId: 'after' }))).rejects.toMatchObject({
      name: 'OwnerLostError',
    });
    await worker.dispose().catch(() => undefined);
  });

  it('flushes the tail that was parked on backpressure when dispose drains', async () => {
    const gate = deferred<ReturnType<typeof makeCommit>>();
    const backend = {
      appendBatch: vi.fn(async (entries: Entry[]) => {
        await gate.promise;
        return makeCommit(entries.length);
      }),
    };
    const worker = createStorageWorker(backend, { queueBytes: 100, windowMs: 60_000 });

    await worker.enqueue(makeEntry(100, { entryId: 'head' }));
    const parked = worker.enqueue(makeEntry(100, { entryId: 'parked' })); // parks: 100 + 100 > 100

    // dispose() drains: the first batch commits, its bytes free room, and the
    // parked entry is admitted and flushed by the drain's re-check.
    const disposePromise = worker.dispose();
    gate.resolve(makeCommit(1));
    await parked;
    await disposePromise;

    expect(backend.appendBatch.mock.calls.map((call) => call[0].map((entry) => entry.entryId))).toEqual([
      ['head'],
      ['parked'],
    ]);
  });

  it('rejects an enqueue that races with the final drain instead of slipping past it', async () => {
    const backend = { appendBatch: vi.fn(async (entries: Entry[]) => makeCommit(entries.length)) };
    const worker = createStorageWorker(backend, { windowMs: 60_000 });

    await worker.enqueue(makeEntry(16, { entryId: 'first' }));
    // dispose() marks the handle closing synchronously, before its first await.
    const disposePromise = worker.dispose();

    await expect(worker.enqueue(makeEntry(16, { entryId: 'late' }))).rejects.toThrow(
      /storage worker is disposing/,
    );
    await disposePromise;

    // The entry that was admitted BEFORE the drain is committed by it.
    expect(backend.appendBatch.mock.calls.flatMap((call) => call[0].map((entry) => entry.entryId))).toEqual([
      'first',
    ]);
    // After the disposal the handle refuses writes with the stable wording.
    await expect(worker.enqueue(makeEntry(16))).rejects.toThrow(/disposed/);
  });

  it('surfaces a failing drain instead of reporting a clean disposal', async () => {
    // The gate resolves with the verdict instead of rejecting: a rejected
    // deferred would surface as an unhandled rejection in the test process.
    const gate = deferred<boolean>();
    const backend = {
      appendBatch: vi.fn(async (entries: Entry[]) => {
        const shouldFail = await gate.promise;
        if (shouldFail) throw new Error('disk on fire');
        return makeCommit(entries.length);
      }),
    };
    const worker = createStorageWorker(backend, {
      queueBytes: 100,
      windowMs: 60_000,
      maxConsecutiveFlushFailures: 1,
    });

    await worker.enqueue(makeEntry(100, { entryId: 'head' }));
    const parked = worker.enqueue(makeEntry(100, { entryId: 'parked' }));
    const disposePromise = worker.dispose();
    gate.resolve(true);

    // The disposal reports the failure instead of pretending everything was
    // flushed.
    await expect(disposePromise).rejects.toThrow(/disk on fire/);
    // The parked caller is settled too — never left hanging.
    await expect(parked).resolves.toBeUndefined();
  });

  it('settles a flush that races with dispose instead of hanging', async () => {
    const backend = { appendBatch: vi.fn(async (entries: Entry[]) => makeCommit(entries.length)) };
    const worker = createStorageWorker(backend, { windowMs: 60_000 });

    await worker.enqueue(makeEntry(16, { entryId: 'first' }));
    const flushPromise = worker.flush();
    const disposePromise = worker.dispose();

    // Both settle: the flush resolves with the commit of the drained batch.
    await expect(flushPromise).resolves.toEqual(makeCommit(1));
    await expect(disposePromise).resolves.toBeUndefined();
  });

  it('is idempotent for sequential disposes', async () => {
    const backend = { appendBatch: vi.fn(async (entries: Entry[]) => makeCommit(entries.length)) };
    const worker = createStorageWorker(backend, { windowMs: 60_000 });

    await worker.enqueue(makeEntry(16, { entryId: 'first' }));
    await worker.dispose();
    // A second, sequential disposal is a no-op — it must not reject.
    await expect(worker.dispose()).resolves.toBeUndefined();
  });

  it('rejects a concurrent second dispose with the disposal error (BUG-02)', async () => {
    // Known bug (B-02):
    // `dispose()` is not idempotent under concurrency. The second disposal
    // observes `closed` and rejects with "storage worker is disposed" — the
    // caller that asked to shut the worker down gets an error instead of a
    // resolved promise. The assertion below pins the current behavior so the
    // regression is visible; it must flip when dispose becomes idempotent.
    const backend = { appendBatch: vi.fn(async (entries: Entry[]) => makeCommit(entries.length)) };
    const worker = createStorageWorker(backend, { windowMs: 60_000 });

    await worker.enqueue(makeEntry(16, { entryId: 'first' }));
    const results = await Promise.allSettled([worker.dispose(), worker.dispose()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/disposed/);
  });

  it('resolves both concurrent disposals when there is nothing to drain', async () => {
    // Without pending work there is no flush to cancel, so both disposals
    // resolve — the rejection above is specific to the drain path.
    const backend = { appendBatch: vi.fn(async (entries: Entry[]) => makeCommit(entries.length)) };
    const worker = createStorageWorker(backend, { windowMs: 60_000 });

    const results = await Promise.allSettled([worker.dispose(), worker.dispose()]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });
});
