import { describe, expect, it, vi } from 'vitest';

import { createStorageWorker, validateEntry } from '../../src/client.js';
import { createBoundedByteQueue } from '../../src/queue.js';
import type { Entry } from '../../src/contracts.js';
import { makeEntry } from '../helpers.js';

// The byte-bounded admission queue is the backpressure seam of the storage
// worker: `enqueue` resolves while the queue is below its ceiling and parks
// (never drops) the entries above it until committed bytes free room again.
//
// These tests pin the queue's own contract, plus the seam contract with the
// client: the queue alone cannot refuse an oversized entry, so admission
// validation is what keeps a too-big entry from parking forever.

describe('bounded byte queue: the ceiling', () => {
  it('refuses a ceiling that is not a positive finite number', () => {
    expect(() => createBoundedByteQueue(0)).toThrow(RangeError);
    expect(() => createBoundedByteQueue(-1)).toThrow(/queueBytes must be a positive finite number/);
    expect(() => createBoundedByteQueue(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => createBoundedByteQueue(Number.NaN)).toThrow(RangeError);
  });

  it('admits up to the ceiling and parks everything above it', async () => {
    const queue = createBoundedByteQueue(100);
    const admitted: Entry[] = [];

    await queue.reserve(makeEntry(60, { entryId: 'a' }), (entry) => admitted.push(entry));
    expect(queue.pendingBytes).toBe(60);
    expect(admitted.map((entry) => entry.entryId)).toEqual(['a']);

    // 60 + 60 > 100: the second entry parks, it is NOT dropped.
    let parkedSettled = false;
    const parked = queue.reserve(makeEntry(60, { entryId: 'b' }), (entry) => admitted.push(entry));
    void parked.then(() => {
      parkedSettled = true;
    });
    await Promise.resolve();
    expect(parkedSettled).toBe(false);
    expect(queue.pendingBytes).toBe(60);
    expect(admitted.map((entry) => entry.entryId)).toEqual(['a']);

    // Releasing the committed bytes admits the parked entry.
    queue.release(60);
    await parked;
    expect(admitted.map((entry) => entry.entryId)).toEqual(['a', 'b']);
    expect(queue.pendingBytes).toBe(60);
  });

  it('admits an entry that exactly fills the remaining room', async () => {
    const queue = createBoundedByteQueue(100);
    await queue.reserve(makeEntry(70, { entryId: 'a' }), () => {});
    await queue.reserve(makeEntry(30, { entryId: 'b' }), () => {});
    expect(queue.pendingBytes).toBe(100);
  });

  it('wakes parked entries in enqueue order, never out of order', async () => {
    const queue = createBoundedByteQueue(100);
    const order: string[] = [];
    await queue.reserve(makeEntry(100, { entryId: 'head' }), (entry) => order.push(entry.entryId));

    const first = queue.reserve(makeEntry(50, { entryId: 'first' }), (entry) => order.push(entry.entryId));
    const second = queue.reserve(makeEntry(50, { entryId: 'second' }), (entry) => order.push(entry.entryId));

    queue.release(100);
    await Promise.all([first, second]);
    expect(order).toEqual(['head', 'first', 'second']);
    expect(queue.pendingBytes).toBe(100);
  });

  it('never lets the accounted bytes go below zero', () => {
    const queue = createBoundedByteQueue(100);
    queue.release(50); // releasing bytes that were never accounted
    expect(queue.pendingBytes).toBe(0);
  });

  it('rejects every parked entry when the queue is failed', async () => {
    const queue = createBoundedByteQueue(100);
    await queue.reserve(makeEntry(100, { entryId: 'head' }), () => {});
    const parked = queue.reserve(makeEntry(10, { entryId: 'parked' }), () => {});
    const failure = new Error('worker died');

    queue.failAll(failure);
    await expect(parked).rejects.toBe(failure);
  });

  it('accounts a payload larger than 10 MiB exactly', async () => {
    const tenMiB = 10 * 1024 * 1024;
    const queue = createBoundedByteQueue(16 * 1024 * 1024);
    const admitted: Entry[] = [];
    await queue.reserve(makeEntry(tenMiB, { entryId: 'huge' }), (entry) => admitted.push(entry));
    expect(queue.pendingBytes).toBe(tenMiB);
    expect(admitted).toHaveLength(1);

    // The next entry parks: the ceiling is nearly full.
    let parkedSettled = false;
    const parked = queue.reserve(makeEntry(tenMiB, { entryId: 'huge-2' }), () => {});
    void parked.then(() => {
      parkedSettled = true;
    });
    await Promise.resolve();
    expect(parkedSettled).toBe(false);
    expect(queue.pendingBytes).toBe(tenMiB);
  });
});

describe('bounded byte queue: the seam with the client', () => {
  it('parks an oversized entry forever, so admission must refuse it instead', async () => {
    // The queue has no way to reject an entry bigger than its own ceiling:
    // it would park and never be admitted. The client's admission check is
    // the guard that keeps such an entry from wedging the queue.
    const queue = createBoundedByteQueue(100);
    let settled = false;
    void queue.reserve(makeEntry(200, { entryId: 'too-big' }), () => {}).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(queue.pendingBytes).toBe(0);

    // The client refuses the same entry at admission, with the reason.
    expect(() => validateEntry(makeEntry(200, { entryId: 'too-big' }), 100, 1024 * 1024)).toThrow(
      /exceeds the queue ceiling/,
    );
  });

  it('refuses an entry above the batch cap at admission, before it reaches the queue', () => {
    // Terminal at admission: such an entry could never be part of a
    // committable batch, so queueing it would only wedge the retry loop.
    expect(() => validateEntry(makeEntry(300 * 1024, { entryId: 'oversize' }), 1024 * 1024, 256 * 1024)).toThrow(
      /can never be part of a committable batch/,
    );
  });

  it('refuses malformed entries at admission', () => {
    const base = makeEntry(16);
    expect(() => validateEntry(null as unknown as Entry, 1024, 1024)).toThrow(TypeError);
    expect(() => validateEntry({ ...base, entryId: '' }, 1024, 1024)).toThrow(/entryId must be a non-empty string/);
    expect(() => validateEntry({ ...base, kind: '' }, 1024, 1024)).toThrow(/kind must be a non-empty string/);
    expect(() => validateEntry({ ...base, bytes: -1 }, 1024, 1024)).toThrow(
      /entry.bytes must be a non-negative finite number/,
    );
    expect(() => validateEntry({ ...base, bytes: Number.NaN }, 1024, 1024)).toThrow(TypeError);
    expect(() => validateEntry({ ...base, parentId: 7 as unknown as string }, 1024, 1024)).toThrow(
      /parentId must be a string or null/,
    );
  });

  it('never lets the queue ceiling be exceeded by the admitted entries', async () => {
    // The queue is the only accounting of not-yet-committed bytes: the
    // client's ceiling and the queue's ceiling are the same number.
    const queueBytes = 1024;
    const backend = { appendBatch: vi.fn(async (entries: Entry[]) => ({ batchId: '1', seq: 1, head: '1' })) };
    const worker = createStorageWorker(backend, { queueBytes, windowMs: 60_000 });

    await worker.enqueue(makeEntry(512, { entryId: 'half' }));
    await worker.enqueue(makeEntry(512, { entryId: 'other-half' }));
    // The second entry fills the queue exactly; a third one parks.
    const parked = worker.enqueue(makeEntry(512, { entryId: 'third' }));
    let parkedSettled = false;
    void parked.then(
      () => {
        parkedSettled = true;
      },
      () => {
        parkedSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(parkedSettled).toBe(false);

    // The drain frees room, admits the parked entry and flushes it: the entry
    // is neither dropped nor left hanging.
    await worker.dispose();
    await expect(parked).resolves.toBeUndefined();
    expect(backend.appendBatch.mock.calls.flatMap((call) => call[0].map((entry) => entry.entryId))).toEqual([
      'half',
      'other-half',
      'third',
    ]);
  });
});
