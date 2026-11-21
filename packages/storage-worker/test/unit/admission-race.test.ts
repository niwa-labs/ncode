/**
 * Byte-bounded admission and the dispose/enqueue race.
 *
 * The admission queue is the only place where an entry can be parked, so its
 * accounting is pinned here: what "at the ceiling" means, that a release
 * admits parked entries FIFO, that bytes never go negative, and that a
 * failure rejects every parked enqueue instead of dropping it silently.
 *
 * The teardown path is pinned next to it: an entry that arrives while the
 * final drain runs must be rejected explicitly (never slip past the last
 * flush), an entry parked at teardown must be rejected rather than lost, and
 * the handle must stay usable-as-disposed afterwards.
 */

import { describe, expect, it, vi } from 'vitest';

import { createBoundedByteQueue } from '../../src/queue.js';
import { createStorageWorker } from '../../src/client.js';
import type { Commit, Entry } from '../../src/contracts.js';
import { deferred, delay, makeCommit, makeEntry, until } from '../helpers.js';

function entryOf(bytes: number, entryId: string): Entry {
	return { entryId, parentId: null, kind: 'test', payload: { n: entryId }, bytes };
}

describe('bounded byte queue', () => {
	it('refuses a ceiling that is not a positive finite number', () => {
		expect(() => createBoundedByteQueue(0)).toThrow(RangeError);
		expect(() => createBoundedByteQueue(-1)).toThrow(RangeError);
		expect(() => createBoundedByteQueue(Number.NaN)).toThrow(RangeError);
		expect(() => createBoundedByteQueue(Number.POSITIVE_INFINITY)).toThrow(RangeError);
	});

	it('admits an entry that fits and counts its bytes', async () => {
		const queue = createBoundedByteQueue(100);
		const admitted: string[] = [];
		await queue.reserve(entryOf(40, 'a'), (entry) => admitted.push(entry.entryId));
		expect(admitted).toEqual(['a']);
		expect(queue.pendingBytes).toBe(40);
	});

	it('parks an entry over the ceiling and admits it on release', async () => {
		const queue = createBoundedByteQueue(100);
		const admitted: string[] = [];
		await queue.reserve(entryOf(60, 'a'), (entry) => admitted.push(entry.entryId));
		expect(admitted).toEqual(['a']);

		let parkedResolved = false;
		const parked = queue.reserve(entryOf(60, 'b'), (entry) => admitted.push(entry.entryId)).then(() => {
			parkedResolved = true;
		});
		await delay(20);
		expect(parkedResolved).toBe(false);
		expect(admitted).toEqual(['a']); // still parked, nothing admitted
		expect(queue.pendingBytes).toBe(60); // parked bytes are NOT counted yet

		queue.release(60);
		await parked;
		expect(admitted).toEqual(['a', 'b']);
		expect(queue.pendingBytes).toBe(60);
	});

	it('admits parked entries in enqueue order', async () => {
		const queue = createBoundedByteQueue(100);
		const admitted: string[] = [];
		await queue.reserve(entryOf(100, 'first'), (entry) => admitted.push(entry.entryId));

		const second = queue.reserve(entryOf(10, 'second'), (entry) => admitted.push(entry.entryId));
		const third = queue.reserve(entryOf(10, 'third'), (entry) => admitted.push(entry.entryId));

		queue.release(10);
		await delay(20);
		// The head fits now (90 + 10 <= 100): the second is admitted, the
		// third still does not fit (100 + 10 > 100).
		expect(admitted).toEqual(['first', 'second']);

		queue.release(10);
		await Promise.all([second, third]);
		expect(admitted).toEqual(['first', 'second', 'third']);
	});

	it('never drives the pending byte count below zero', () => {
		const queue = createBoundedByteQueue(100);
		queue.release(500);
		expect(queue.pendingBytes).toBe(0);
	});

	it('rejects every parked enqueue on failure instead of dropping it', async () => {
		const queue = createBoundedByteQueue(100);
		await queue.reserve(entryOf(100, 'a'), () => {});

		const parked = queue.reserve(entryOf(10, 'b'), () => {});
		queue.failAll(new Error('the worker died'));

		await expect(parked).rejects.toThrow('the worker died');
		// The failed entry was never admitted, so it never counted.
		expect(queue.pendingBytes).toBe(100);
	});
});

describe('dispose / enqueue race', () => {
	it('rejects an enqueue that races with the final drain', async () => {
		// The drain waits on the backend; an enqueue arriving in that window
		// must be refused, never admitted past the last flush (SW-02).
		const gate = deferred<Commit>();
		let appendCalls = 0;
		const append = vi.fn(async (entries: Entry[]) => {
			appendCalls += 1;
			if (appendCalls === 1) return gate.promise;
			return makeCommit(entries.length);
		});
		const worker = createStorageWorker({ appendBatch: append }, {
			queueBytes: 100,
			windowMs: 60_000,
			windowBytes: 10_000,
		});

		await worker.enqueue(makeEntry(40, { entryId: 'in-flight' }));
		const disposePromise = worker.dispose();
		await until(() => appendCalls === 1);

		await expect(worker.enqueue(makeEntry(10, { entryId: 'too-late' }))).rejects.toThrow(/disposing/);

		gate.resolve(makeCommit(1));
		await disposePromise;

		// The refused entry never reached the backend.
		const sent = append.mock.calls.flatMap((call) => call[0].map((entry) => entry.entryId));
		expect(sent).toEqual(['in-flight']);
	});

	it('rejects an entry that is still parked when the teardown gives up', async () => {
		// When the drain FAILS, the bytes of the failed batch are never
		// released, so a parked entry can never be admitted. The teardown
		// must reject it explicitly — silently dropping it would lose the
		// write without telling anyone.
		const append = vi.fn(async (_entries: Entry[]) => {
			throw new Error('backend down');
		});
		const worker = createStorageWorker({ appendBatch: append }, {
			queueBytes: 100,
			windowMs: 60_000,
			windowBytes: 10_000,
		});

		await worker.enqueue(makeEntry(60, { entryId: 'admitted' }));
		const parked = worker.enqueue(makeEntry(60, { entryId: 'parked' }));
		// The handler is attached NOW: the teardown rejects this promise, and
		// an unhandled rejection would fail the whole file.
		const parkedError = parked.then(
			() => null,
			(error: unknown) => error,
		);
		await delay(20);

		await expect(worker.dispose()).rejects.toThrow('backend down');
		const rejection = await parkedError;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(/disposed/);

		const sent = append.mock.calls.flatMap((call) => call[0].map((entry) => entry.entryId));
		expect(sent).not.toContain('parked');
	});

	it('keeps a disposed worker disposed and rejects every later call', async () => {
		const append = vi.fn(async (entries: Entry[]) => makeCommit(entries.length));
		const worker = createStorageWorker({ appendBatch: append }, { windowMs: 60_000 });

		await worker.enqueue(makeEntry(16, { entryId: 'a' }));
		await worker.dispose();

		await expect(worker.enqueue(makeEntry(16))).rejects.toThrow(/disposed/);
		await expect(worker.flush()).rejects.toThrow(/disposed/);
		await expect(worker.checkpoint()).rejects.toThrow(/disposed/);
	});

	it('is idempotent: a second dispose neither throws nor re-flushes', async () => {
		const append = vi.fn(async (entries: Entry[]) => makeCommit(entries.length));
		const worker = createStorageWorker({ appendBatch: append }, { windowMs: 60_000 });

		await worker.enqueue(makeEntry(16, { entryId: 'a' }));
		await worker.dispose();
		const callsAfterFirstDispose = append.mock.calls.length;

		await expect(worker.dispose()).resolves.toBeUndefined();
		expect(append.mock.calls.length).toBe(callsAfterFirstDispose);
	});

	it('drains everything admitted before the teardown started', async () => {
		const append = vi.fn(async (entries: Entry[]) => makeCommit(entries.length));
		const worker = createStorageWorker({ appendBatch: append }, { windowMs: 60_000 });

		await worker.enqueue(makeEntry(16, { entryId: 'a' }));
		await worker.enqueue(makeEntry(16, { entryId: 'b' }));
		await worker.dispose();

		expect(append.mock.calls.length).toBe(1);
		expect(append.mock.calls[0]?.[0].map((entry) => entry.entryId)).toEqual(['a', 'b']);
	});
});
