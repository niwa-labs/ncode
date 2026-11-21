/**
 * W02 part B: the pi single-writer composition — the discipline shared by a
 * full pi `Storage` (or the W02 part A adapter) and the worker's own
 * appends when both sit on one physical storage (I01; §4 row 2).
 *
 * The last block drives the composition against the vendored pi REFERENCE
 * storage (`MemoryStorage`) through the same brand-only structural cast used
 * by the seam port tests: runtime shapes identical, ids plain numbers.
 */

import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';

import type { Commit, Entry, StorageWorkerBackend } from '../../src/contracts.js';
import {
	createSingleWriterGate,
	gatePiStorageMutations,
	gatedStorageWorkerBackend,
	PiWriterFailedError,
	type PiStorageWriteLike,
	type PiWritableStorageLike,
} from '../../src/pi-composition.js';

/** Reference pi storage adapted brand-only (see file doc). */
function referenceStorage(): PiWritableStorageLike {
	const storage = new MemoryStorage();
  return {
    mintId: () => storage.mintId(),
    async commit(writes) {
      let seq = 0;
      const result = await storage.commit([writes] as never, (_index, value) => { seq = value; }, BACKGROUND_CONTEXT);
      if (result.refused !== undefined) throw result.refused;
      return seq;
    },
  };
}

function entry(n: number): Entry {
	return { entryId: `e${String(n)}`, parentId: null, kind: 'test', payload: { n }, bytes: 8 };
}

function commitOf(seq: number): Commit {
	return { batchId: String(seq), seq, head: String(seq) };
}

describe('createSingleWriterGate', () => {
	it('runs gated operations strictly one at a time in submission order', async () => {
		const gate = createSingleWriterGate();
		let inFlight = 0;
		let maxInFlight = 0;
		const order: number[] = [];

		const ops = Array.from({ length: 8 }, (_, index) =>
			gate.run(async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(index);
				inFlight -= 1;
				return index;
			}),
		);
		const results = await Promise.all(ops);

		expect(maxInFlight).toBe(1);
		expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('rejects every later run after fail() — fail-closed', async () => {
		const gate = createSingleWriterGate();
		gate.fail(new Error('storage is gone'));
		expect(gate.failed).toBe(true);
		await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(PiWriterFailedError);
	});
});

describe('gatePiStorageMutations', () => {
	it('serializes concurrent pi commits through the gate', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const storage: PiWritableStorageLike = {
			commit: async (writes: readonly PiStorageWriteLike[]) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				return writes.length;
			},
			mintId: async () => 1,
		};
		const gated = gatePiStorageMutations(storage);
		const seqs = await Promise.all([
			gated.commit([{ type: 'entry', value: { id: 1, conversationId: 1, kind: 'k' } }]),
			gated.commit([{ type: 'entry', value: { id: 2, conversationId: 1, kind: 'k' } }]),
			gated.commit([{ type: 'entry', value: { id: 3, conversationId: 1, kind: 'k' } }]),
		]);
		expect(maxInFlight).toBe(1);
		expect(seqs).toEqual([1, 1, 1]);
	});

	it('validates BEFORE the durable attempt and fails only that commit on a validation rejection', async () => {
		const commits: number[] = [];
		const storage: PiWritableStorageLike = {
			commit: async () => {
				commits.push(commits.length + 1);
				return commits.length;
			},
			mintId: async () => 1,
		};
		let rejectNext = true;
		const gated = gatePiStorageMutations(storage, {
			onBeforeCommit: () => {
				if (rejectNext) {
					rejectNext = false;
					throw new Error('unpublished CAS blob');
				}
			},
		});

		await expect(gated.commit([{ type: 'conversation', value: { id: 9 } }])).rejects.toThrow(
			/unpublished CAS blob/,
		);
		// Nothing durable happened; the gate stays usable.
		const seq = await gated.commit([{ type: 'conversation', value: { id: 10 } }]);
		expect(seq).toBe(1); // only the second commit reached storage
	});

	it('acknowledges and publishes only AFTER the durable commit (C1 invariant 2, §2.5.2 LOG→PUB)', async () => {
		const durableAtHook: boolean[] = [];
		const storage: PiWritableStorageLike = {
			commit: async (writes: readonly PiStorageWriteLike[]) => writes.length,
			mintId: async () => 1,
		};
		const seen: number[] = [];
		const gated = gatePiStorageMutations(storage, {
			// The hook observes the durable sequence; record that storage has
			// already resolved it by the time publication runs.
			onCommitted: (seq) => {
				durableAtHook.push(seq > 0);
				seen.push(seq);
			},
		});
		const seq = await gated.commit([{ type: 'conversation', value: { id: 1 } }]);
		expect(seq).toBe(1);
		expect(seen).toEqual([1]);
		expect(durableAtHook).toEqual([true]);
	});

	it('poisons the shared gate after a storage failure (pi semantics: the error is final)', async () => {
		const storage: PiWritableStorageLike = {
			commit: async () => {
				throw new Error('disk on fire');
			},
			mintId: async () => 1,
		};
		const failures: unknown[] = [];
		const gated = gatePiStorageMutations(storage, {
			onFailed: (reason) => failures.push(reason),
		});

		await expect(gated.commit([{ type: 'conversation', value: { id: 1 } }])).rejects.toThrow(
			/disk on fire/,
		);
		await expect(gated.commit([{ type: 'conversation', value: { id: 2 } }])).rejects.toBeInstanceOf(
			PiWriterFailedError,
		);
		await expect(gated.mintId()).rejects.toBeInstanceOf(PiWriterFailedError);
		expect(failures).toHaveLength(1);
	});

	it('forwards untouched surface methods bound to the original target', async () => {
		class Storage {
			private readonly label = 'target';
			commit = async (): Promise<number> => 1;
			mintId = async (): Promise<number> => 41;
			describe(): string {
				return this.label;
			}
		}
		const gated = gatePiStorageMutations(new Storage());
		// A non-mutation method keeps its receiver (private state intact)…
		expect(gated.describe()).toBe('target');
		// …and mutations run gated (mintId resolves through the gate).
		await expect(gated.mintId()).resolves.toBe(41);
	});
});

describe('gatedStorageWorkerBackend — worker appends share the pi gate', () => {
	it('never interleaves a worker append with a pi commit on the same gate', async () => {
		const gate = createSingleWriterGate();
		const timeline: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;

		const backend: StorageWorkerBackend = {
			appendBatch: async (entries: Entry[]) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				timeline.push(`worker:${String(entries.length)}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				return commitOf(1);
			},
		};
		const piLike: PiWritableStorageLike = {
			commit: async (writes: readonly PiStorageWriteLike[]) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				timeline.push(`pi:${String(writes.length)}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				return 2;
			},
			mintId: async () => 1,
		};
		const gatedWorkerBackend = gatedStorageWorkerBackend(backend, gate);
		const gatedPi = gatePiStorageMutations(piLike, {}, gate);

		await Promise.all([
			gatedWorkerBackend.appendBatch([entry(1)]),
			gatedPi.commit([{ type: 'conversation', value: { id: 1 } }]),
			gatedWorkerBackend.appendBatch([entry(2)]),
		]);
		expect(maxInFlight).toBe(1);
		expect(timeline).toHaveLength(3);
	});

	it('keeps checkpoint callable and fails appends closed once the shared gate is poisoned', async () => {
		const gate = createSingleWriterGate();
		let checkpointed = false;
		const backend: StorageWorkerBackend = {
			appendBatch: async () => commitOf(1),
			checkpoint: () => {
				checkpointed = true;
				return commitOf(1);
			},
		};
		const gated = gatedStorageWorkerBackend(backend, gate);

		expect(gated.checkpoint?.()).toMatchObject({ seq: 1 });
		expect(checkpointed).toBe(true);

		gate.fail(new Error('pi commit failed elsewhere'));
		await expect(gated.appendBatch([entry(1)])).rejects.toBeInstanceOf(PiWriterFailedError);
	});
});

describe('composition with the vendored pi reference storage', () => {
	it('runs gated commits and mintId against MemoryStorage', async () => {
		const gated = gatePiStorageMutations(referenceStorage());
		const conversationId = await gated.mintId();
		const seq = await gated.commit([{ type: 'conversation', value: { id: conversationId } }]);
		expect(seq).toBe(1);
		const entryId = await gated.mintId();
		const second = await gated.commit([
			{ type: 'entry', value: { id: entryId, conversationId, kind: 'mcode.test' } },
		]);
		expect(second).toBe(2);
	});

	it('still serializes when the reference storage is shared with a gated worker backend', async () => {
		const gate = createSingleWriterGate();
		const gated = gatePiStorageMutations(referenceStorage(), {}, gate);
		let inFlight = 0;
		let maxInFlight = 0;
		const backend: StorageWorkerBackend = {
			appendBatch: async (entries: Entry[]) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 3));
				inFlight -= 1;
				return commitOf(entries.length);
			},
		};
		const worker = gatedStorageWorkerBackend(backend, gate);

		await Promise.all([
			gated.commit([{ type: 'conversation', value: { id: await gated.mintId() } }]),
			worker.appendBatch([entry(1)]),
			gated.commit([{ type: 'conversation', value: { id: await gated.mintId() } }]),
		]);
		expect(maxInFlight).toBe(1);
	});
});


describe('Pi 1.5 batched durability receipts', () => {
  it('acknowledges the durable prefix after a refused batch without poisoning the writer', async () => {
    const storage = new MemoryStorage();
    const published: number[] = [];
    const gated = gatePiStorageMutations(storage, { onCommitted: (seq) => published.push(seq) });
    const id = await gated.mintId();
    const batch = [{ type: 'conversation' as const, value: { id } }];
    const receipts: number[] = [];
    const result = await gated.commit([batch, batch], (_index, seq) => {
      expect(published).toEqual([1]);
      receipts.push(seq);
    }, BACKGROUND_CONTEXT);
    expect(result.stored).toBe(1);
    expect(result.refused).toBeDefined();
    expect(receipts).toEqual([1]);
    const nextId = await gated.mintId();
    const next = await gated.commit([[{ type: 'conversation', value: { id: nextId } }]],
      (_index, seq) => receipts.push(seq), BACKGROUND_CONTEXT);
    expect(next).toEqual({ stored: 1 });
    expect(receipts).toEqual([1, 2]);
  });

  it('retains earlier receipts when a later batch has an unknown outcome', async () => {
    let count = 0;
    const fault = new Error('unknown second commit outcome');
    const storage = {
      mintId: async () => 2,
      async commit(_batches: readonly unknown[], receive: (index: number, seq: number) => void) {
        if (++count === 2) throw fault;
        receive(0, 7);
        return { stored: 1 };
      },
    };
    const gated = gatePiStorageMutations(storage);
    const receipts: number[] = [];
    await expect(gated.commit([[], []], (_index, seq) => receipts.push(seq))).rejects.toBe(fault);
    expect(receipts).toEqual([7]);
    await expect(gated.mintId()).rejects.toBeInstanceOf(PiWriterFailedError);
  });
});
