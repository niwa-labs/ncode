/**
 * W02 part B: the seam's DurableLogPort over a FULL pi `Storage` (U05).
 *
 * The port is exercised against the vendored pi REFERENCE implementation
 * (`MemoryStorage`, `@earendil-works/pi-durable/storage/memory`) — the same
 * oracle the wave's storage conformance runs against — proving the seam
 * composes over the pi Storage contract, not just over the sqlite-zstd
 * backend. The cast at each construction site is brand-only (pi's erased
 * numeric id brands vs the port's plain-number structural mirror); the
 * runtime shapes are identical, and the cast is the one explicitly
 * documented boundary crossing (never a silent coercion).
 */

import { describe, expect, it } from 'vitest';
// Reference pi storage (vendored pin 48c8f32): the conformance oracle.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';

import {
	decodePiBridgeEnvelope,
	encodePiBridgeEnvelope,
	openPiStorageDurableLogPort,
	type PiStorageLike,
} from '../../src/pi-storage-port.js';
import type { PortEntryDraft } from '../../src/port.js';
import { DurableSeam } from '../../src/seam.js';
import { SEAM_ENTRY_KINDS } from '../../src/types.js';

/** Brand-only structural adaptation of the reference storage (see file doc). */
function referenceStorage(): PiStorageLike {
	return new MemoryStorage() as unknown as PiStorageLike;
}

/**
 * PiStorageLike wrapper that counts calls and items served — the oracle for
 * the W02 round-2 seek/budget tests: a compliant port must answer warm
 * window reads with ZERO storage traffic and reload windows by seeking, not
 * by rescanning the log.
 */
function countingStorage(base: PiStorageLike): {
	readonly storage: PiStorageLike;
	readonly calls: { scanEntries: number; entry: number; commit: number; mintId: number };
	readonly itemsServed: { scanEntries: number };
	reset(): void;
} {
	const calls = { scanEntries: 0, entry: 0, commit: 0, mintId: 0 };
	const itemsServed = { scanEntries: 0 };
	return {
		calls,
		itemsServed,
		reset() {
			calls.scanEntries = 0;
			calls.entry = 0;
			calls.commit = 0;
			calls.mintId = 0;
			itemsServed.scanEntries = 0;
		},
		storage: {
			commit: (batches, receive, context) => {
				calls.commit += 1;
				return base.commit(batches, receive, context);
			},
			mintId: () => {
				calls.mintId += 1;
				return base.mintId();
			},
			entry: (id) => {
				calls.entry += 1;
				return base.entry(id);
			},
			scanEntries: async (query, limit, cursor) => {
				calls.scanEntries += 1;
				const page = await base.scanEntries(query, limit, cursor);
				itemsServed.scanEntries += page.items.length;
				return page;
			},
		},
	};
}

/** Sync-throw helper: runs `op` and returns the SeamErrorCode it threw, if any. */
function thrownCode(op: () => unknown): string | null {
	try {
		op();
		return null;
	} catch (error) {
		return (error as { readonly code?: string }).code ?? null;
	}
}

function draft(id: string, payload: unknown = { value: id }): PortEntryDraft {
	return { id, kind: 'mcode.test.entry', payload: payload as PortEntryDraft['payload'] };
}

describe('pi storage port — batch appends over a pi Storage', () => {
	it('commits one pi batch atomically and mints the bridge conversation', async () => {
		const storage = referenceStorage();
		const port = await openPiStorageDurableLogPort(storage);

		const commit = await port.appendBatch([draft('a'), draft('b')]);

		expect(commit.seq).toBe(1);
		// Port-local head rendering: the port's own last-commit sequence —
		// documented as port-local, never a pi EntryId-context head.
		expect(commit.head).toBe(1);
		expect(commit.entryCount).toBe(2);
		expect(port.bridgedConversationId).toBe(2); // first minted id after ROOT=1

		const first = port.getEntry('a');
		expect(first).toMatchObject({ id: 'a', kind: 'mcode.test.entry', seq: 1, ordinal: 0 });
		expect(port.getEntry('b')).toMatchObject({ id: 'b', seq: 1, ordinal: 1 });
		expect(port.getEntry('missing')).toBeUndefined();
		expect(port.head()).toBe(1);
	});

	it('keeps per-commit ordinals and positions across appends', async () => {
		const port = await openPiStorageDurableLogPort(referenceStorage());
		await port.appendBatch([draft('a'), draft('b'), draft('c')]);
		const second = await port.appendBatch([draft('d')]);

		expect(second.seq).toBe(2);
		expect(port.getEntry('c')).toMatchObject({ seq: 1, ordinal: 2 });
		expect(port.getEntry('d')).toMatchObject({ seq: 2, ordinal: 0 });
		expect(port.head()).toBe(2);
	});

	it('returns the ORIGINAL positions on idempotent point reads (string ids never collide with numeric ones)', async () => {
		const port = await openPiStorageDurableLogPort(referenceStorage());
		await port.appendBatch([draft('1'), draft('2'), draft('10')]);

		// String ids '1'/'2'/'10' must never be confused with numeric pi ids.
		expect(port.getEntry('1')?.id).toBe('1');
		expect(port.getEntry('10')?.id).toBe('10');
		expect(port.getEntry('1')).not.toMatchObject({ id: '10' });
	});
});

describe('pi storage port — windowed reads', () => {
	it('reads complete batches oldest-first within the byte budget and reports the next cursor', async () => {
		const port = await openPiStorageDurableLogPort(referenceStorage());
		await port.appendBatch([draft('a'), draft('b')]);
		await port.appendBatch([draft('c')]);
		await port.appendBatch([draft('d'), draft('e')]);

		const window = port.readDeltaChecked(0, 256 * 1024);
		expect(window.entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(window.nextAfterSeq).toBeNull();
		expect(window.tornTail).toBeNull();

		const afterFirst = port.readDeltaChecked(1, 256 * 1024);
		expect(afterFirst.entries.map((entry) => entry.id)).toEqual(['c', 'd', 'e']);
		expect(afterFirst.nextAfterSeq).toBeNull();
	});

	it('cuts whole batches on the byte budget and continues from the cursor', async () => {
		const port = await openPiStorageDurableLogPort(referenceStorage());
		await port.appendBatch([draft('a', { pad: 'x'.repeat(200) })]);
		await port.appendBatch([draft('b', { pad: 'x'.repeat(200) })]);
		await port.appendBatch([draft('c', { pad: 'x'.repeat(200) })]);

		// A budget that fits one batch but not two: the window takes the first
		// batch whole and reports its seq as the continuation cursor.
		const first = port.readDeltaChecked(0, 400);
		expect(first.entries.map((entry) => entry.id)).toEqual(['a']);
		expect(first.nextAfterSeq).toBe(1);

		const second = port.readDeltaChecked(first.nextAfterSeq!, 400);
		expect(second.entries.map((entry) => entry.id)).toEqual(['b']);
		expect(second.nextAfterSeq).toBe(2);

		const third = port.readDeltaChecked(second.nextAfterSeq!, 400);
		expect(third.entries.map((entry) => entry.id)).toEqual(['c']);
		expect(third.nextAfterSeq).toBeNull();
	});

	it('tolerates pi Seq gaps: external commits on other conversations never leak into the log', async () => {
		const storage = referenceStorage();
		const port = await openPiStorageDurableLogPort(storage);
		await port.appendBatch([draft('a')]);

		// External pi commit on ANOTHER conversation: consumes a Seq (gap for
		// the port) and must never surface in the port's reads.
		const externalConversation = await storage.mintId();
		const externalEntry = await storage.mintId();
		// Chord-era protocol: one batch in the series array, the durable Seq
		// arrives through the receive callback.
		let seq = 0;
		await storage.commit(
			[
				[
					{ type: 'conversation', value: { id: externalConversation } },
					{
						type: 'entry',
						value: {
							id: externalEntry,
							conversationId: externalConversation,
							kind: 'pi.foreign',
						},
					},
				],
			],
			(_index, received) => {
				seq = received;
			},
			BACKGROUND_CONTEXT,
		);
		expect(seq).toBe(2); // the gap: pi Seq permits it, the port must not assume seq === index+1

		const commit = await port.appendBatch([draft('b')]);
		expect(commit.seq).toBe(3);

		const window = port.readDeltaChecked(0, 256 * 1024);
		expect(window.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
		expect(port.head()).toBe(3);
	});
});

describe('pi storage port — reopen (recovery) and single-writer guard', () => {
	it('rebuilds the index from the bridge conversation on reopen with the explicit conversationId', async () => {
		const storage = referenceStorage();
		const first = await openPiStorageDurableLogPort(storage);
		await first.appendBatch([draft('a'), draft('b')]);
		await first.appendBatch([draft('c')]);
		const conversationId = first.bridgedConversationId!;

		const reopened = await openPiStorageDurableLogPort(storage, { conversationId });
		expect(reopened.getEntry('b')).toMatchObject({ id: 'b', seq: 1, ordinal: 1 });
		expect(reopened.getEntry('c')).toMatchObject({ id: 'c', seq: 2, ordinal: 0 });
		expect(reopened.head()).toBe(2);
		const window = reopened.readDeltaChecked(1, 256 * 1024);
		expect(window.entries.map((entry) => entry.id)).toEqual(['c']);
	});

	it('pages the recovery scan through pi scan cursors', async () => {
		const storage = referenceStorage();
		const first = await openPiStorageDurableLogPort(storage);
		await first.appendBatch([draft('a')]);
		await first.appendBatch([draft('b')]);
		const conversationId = first.bridgedConversationId!;

		// scanPageSize 1 forces one pi scan page per entry.
		const reopened = await openPiStorageDurableLogPort(storage, {
			conversationId,
			scanPageSize: 1,
		});
		expect(reopened.getEntry('a')).toBeDefined();
		expect(reopened.getEntry('b')).toBeDefined();
		expect(reopened.head()).toBe(2);
	});

	it('fails closed on a foreign entry inside the bridge conversation (I01: no second writer)', async () => {
		const storage = referenceStorage();
		const first = await openPiStorageDurableLogPort(storage);
		await first.appendBatch([draft('a')]);
		const conversationId = first.bridgedConversationId!;

		// A second writer puts a non-envelope entry into the port's conversation.
		const foreign = await storage.mintId();
		await storage.commit(
			[
				[
					{
						type: 'entry',
						value: { id: foreign, conversationId, kind: 'pi.foreign', data: { no: 'envelope' } },
					},
				],
			],
			() => {},
			BACKGROUND_CONTEXT,
		);

		await expect(
			openPiStorageDurableLogPort(storage, { conversationId }),
		).rejects.toMatchObject({ code: 'PI_BRIDGE_ENVELOPE_INVALID' });
	});
});

describe('pi storage port — envelope codec', () => {
	it('round-trips drafts and preserves the mcode entry id domain', () => {
		const envelope = encodePiBridgeEnvelope(draft('mcode:receipt:abc', { ok: true }));
		expect(envelope.v).toBe(1);
		expect(envelope.mcodeEntryId).toBe('mcode:receipt:abc');
		expect(envelope.payload).toEqual({ ok: true });

		const decoded = decodePiBridgeEnvelope(envelope, 7);
		expect(decoded).toEqual(envelope);
	});

	it('rejects malformed envelopes fail-closed', () => {
		expect(() => decodePiBridgeEnvelope(null, 1)).toThrow(/bridge envelope/);
		expect(() => decodePiBridgeEnvelope({ v: 2, mcodeEntryId: 'x', payload: 1 }, 1)).toThrow(
			/bridge envelope/,
		);
		expect(() => decodePiBridgeEnvelope({ v: 1, mcodeEntryId: '', payload: 1 }, 1)).toThrow(
			/bridge envelope/,
		);
		expect(() => decodePiBridgeEnvelope({ v: 1, mcodeEntryId: 'x' }, 1)).toThrow(/bridge envelope/);
	});
});

describe('pi storage port — index seek and the bounded retained window (W02 review round 2)', () => {
	it('readDeltaChecked seeks by afterSeq: warm windows answer with ZERO storage traffic and only the Δ', async () => {
		const counting = countingStorage(referenceStorage());
		const port = await openPiStorageDurableLogPort(counting.storage);
		const batches = 250;
		for (let i = 0; i < batches; i += 1) {
			await port.appendBatch([draft(`e${String(i).padStart(3, '0')}`, { pad: 'x'.repeat(400) })]);
		}
		expect(port.head()).toBe(batches);

		counting.reset();
		// A seek near the head returns exactly the batches past the cursor —
		// the pre-fix code scanned all 250 batches to answer this.
		const tail = port.readDeltaChecked(batches - 2, 1024 * 1024);
		expect(tail.entries.map((entry) => entry.id)).toEqual(['e248', 'e249']);
		expect(tail.nextAfterSeq).toBeNull();
		expect(tail.tornTail).toBeNull();

		// A mid-log seek under a tight budget takes ONE whole batch and
		// reports its seq as the continuation cursor (incumbent semantics).
		const mid = port.readDeltaChecked(100, 500);
		expect(mid.entries.map((entry) => entry.id)).toEqual(['e100']);
		expect(mid.nextAfterSeq).toBe(101);

		// O(log B + Δ) in-memory seek, O(0) on the pi surface: the storage
		// must not see a single call for warm window reads (I03).
		expect(counting.calls.scanEntries).toBe(0);
		expect(counting.calls.entry).toBe(0);
		expect(counting.calls.commit).toBe(0);
		expect(counting.calls.mintId).toBe(0);
	});

	it('a windowed recovery walk with eviction reloads each record O(1) times — O(H) total, not O(W·H)', async () => {
		const padBytes = 400;
		const batches = 60;
		const counting = countingStorage(referenceStorage());
		// A window cap of ~8 batches and 3-batch recovery windows force
		// eviction + reload throughout the walk.
		const port = await openPiStorageDurableLogPort(counting.storage, {
			retainedWindowBytes: 8 * (padBytes + 64),
			scanPageSize: 2,
		});
		for (let i = 0; i < batches; i += 1) {
			await port.appendBatch([draft(`w${String(i).padStart(3, '0')}`, { pad: 'x'.repeat(padBytes) })]);
		}
		const windowBytes = 3 * (padBytes + 64);

		counting.reset();
		let cursor = 0;
		let windows = 0;
		let seen = 0;
		while (cursor < port.head()) {
			const report = await port.loadWindowAfter(cursor, windowBytes);
			expect(report.tornReason).toBeNull();
			const delta = port.readDeltaChecked(cursor, windowBytes);
			expect(delta.tornTail).toBeNull();
			expect(delta.entries.length).toBeGreaterThan(0);
			seen += delta.entries.length;
			windows += 1;
			if (delta.nextAfterSeq === null) break;
			cursor = delta.nextAfterSeq;
		}
		expect(seen).toBe(batches);
		expect(windows).toBe(batches / 3);

		// The pre-fix shape paid W×H entry visits (a full-log pass per
		// window); the seek+reload protocol serves each record a bounded
		// constant number of times (fetch + page over-serve only).
		const served = counting.itemsServed.scanEntries;
		const linearBound = 2 * batches + windows * 2;
		expect(served).toBeLessThanOrEqual(linearBound);
		expect(windows * batches).toBeGreaterThan(linearBound); // documents the contrast
	});

	it('caps the retained payload window, fails closed on evicted reads (never lies), and reloads on seek', async () => {
		const padBytes = 1024;
		const envelopeOf = (id: string): number =>
			Buffer.byteLength(JSON.stringify(encodePiBridgeEnvelope(draft(id, { pad: 'x'.repeat(padBytes) }))), 'utf8');
		const perBatch = envelopeOf('c000');
		const batches = 40;
		const storage = referenceStorage();
		const port = await openPiStorageDurableLogPort(storage, {
			retainedWindowBytes: 8 * perBatch,
		});
		for (let i = 0; i < batches; i += 1) {
			await port.appendBatch([draft(`c${String(i).padStart(3, '0')}`, { pad: 'x'.repeat(padBytes) })]);
		}

		// The metadata index keeps EVERY batch; payloads stay under the cap.
		const stats = port.windowStats();
		expect(stats.totalBatches).toBe(batches);
		expect(stats.retainedBytes).toBeLessThanOrEqual(8 * perBatch);
		expect(stats.retainedBatches).toBe(8);
		expect(stats.evictedBatches).toBe(batches - 8);

		// Recent window reads keep working…
		expect(port.getEntry('c039')).toMatchObject({ id: 'c039', seq: batches });
		expect(port.head()).toBe(batches);
		// …while an evicted point read fails CLOSED: `undefined` would claim
		// absence and silently break dedup.
		expect(thrownCode(() => port.getEntry('c000'))).toBe('PI_WINDOW_EVICTED');
		expect(thrownCode(() => port.readDeltaChecked(0, 1024 * 1024))).toBe('PI_WINDOW_EVICTED');

		// Reload by seek: two batches paged back in, the third is the budget stop.
		const report = await port.loadWindowAfter(0, 2 * perBatch);
		expect(report).toMatchObject({ loadedBatches: 2, loadedEntries: 2, tornReason: null });
		expect(report.stoppedAtSeq).toBe(3);
		const delta = port.readDeltaChecked(0, 1024 * 1024);
		expect(delta.entries.map((entry) => entry.id)).toEqual(['c000', 'c001']);
		// Batch 3 is resident-but-evicted again: the walk stops on the cursor
		// instead of throwing mid-window.
		expect(delta.nextAfterSeq).toBe(2);
		expect(delta.tornTail).toBeNull();

		// The reopen/recovery path rebuilds the SAME shape: full metadata
		// index, bounded tail, evicted first window until reloaded.
		const reopened = await openPiStorageDurableLogPort(storage, {
			conversationId: port.bridgedConversationId!,
			retainedWindowBytes: 8 * perBatch,
		});
		const reopenStats = reopened.windowStats();
		expect(reopenStats.totalBatches).toBe(batches);
		expect(reopenStats.retainedBatches).toBe(8);
		expect(reopened.head()).toBe(batches);
		expect(thrownCode(() => reopened.readDeltaChecked(0, 1024 * 1024))).toBe('PI_WINDOW_EVICTED');
	});

	it('surfaces post-open damage discovered during a window reload as an explicit torn tail (not end-of-log)', async () => {
		const padBytes = 256;
		const base = referenceStorage();
		let damaged = false;
		let poisonAfterEntryId = 0;
		const storage: PiStorageLike = {
			commit: (batches, receive, context) => base.commit(batches, receive, context),
			mintId: () => base.mintId(),
			entry: (id) => base.entry(id),
			scanEntries: (query, limit, cursor) => {
				// Damage that appears AFTER open: page reads seeking past the
				// second batch reject, the way a torn zstd frame would.
				if (damaged && query.minEntryId !== undefined && query.minEntryId > poisonAfterEntryId) {
					return Promise.reject(new Error('torn zstd frame in batch'));
				}
				return base.scanEntries(query, limit, cursor);
			},
		};
		const port = await openPiStorageDurableLogPort(storage, {
			retainedWindowBytes: 4 * (padBytes + 64),
		});
		for (let i = 0; i < 6; i += 1) {
			await port.appendBatch([draft(`t${i}`, { pad: 'x'.repeat(padBytes) })]);
		}
		// One entry per batch → the conversation's records line up with
		// batches 1..6; seeks anchored beyond batch 2 hit the damage.
		const all = await base.scanEntries(
			{ conversationId: port.bridgedConversationId!, order: 'ascending' },
			100,
			undefined,
		);
		expect(all.items.length).toBe(6);
		poisonAfterEntryId = all.items[1]!.id;
		damaged = true;

		const report = await port.loadWindowAfter(0, 3 * (padBytes + 64));
		expect(report.loadedBatches).toBe(2);
		expect(report.stoppedAtSeq).toBe(3);
		expect(report.tornReason).toMatch(/torn zstd frame/);

		// The sync read reports the torn batch explicitly — entries before it
		// stand, the cursor marks the intact prefix (incumbent parity:
		// backend.ts readDeltaChecked returns lastServedSeq alongside
		// tornTail), and the verdict names the damaged batch.
		const delta = port.readDeltaChecked(0, 1024 * 1024);
		expect(delta.entries.map((entry) => entry.id)).toEqual(['t0', 't1']);
		expect(delta.nextAfterSeq).toBe(2);
		expect(delta.tornTail).toMatchObject({ batchId: 3 });
		expect(delta.tornTail?.reason).toMatch(/torn zstd frame/);

		// Windows that never reach the damaged batch are unaffected.
		const tail = port.readDeltaChecked(4, 1024 * 1024);
		expect(tail.entries.map((entry) => entry.id)).toEqual(['t4', 't5']);
		expect(tail.tornTail).toBeNull();
		expect(tail.nextAfterSeq).toBeNull();
	});
});

describe('DurableSeam over the full pi Storage (U05 end-to-end)', () => {
	it('accepts owner input atomically, dedups by the original commit, and recovers after reopen', async () => {
		const storage = referenceStorage();
		const port = await openPiStorageDurableLogPort(storage);
		const seam = await DurableSeam.open(port);

		const accepted = await seam.acceptOwnerInput({
			conversationId: 'conv-1',
			requestId: 'req-1',
			content: { text: 'continue the long task' },
			whenBusy: 'steer',
		});
		expect(accepted.status).toBe('committed');
		expect(accepted.commitSeq).toBe(1);

		// Dedup replay returns the ORIGINAL commit sequence — the pi-backed
		// port's index preserves it.
		const replayed = await seam.acceptOwnerInput({
			conversationId: 'conv-1',
			requestId: 'req-1',
			content: { text: 'continue the long task' },
			whenBusy: 'steer',
		});
		expect(replayed.status).toBe('replayed');
		expect(replayed.commitSeq).toBe(accepted.commitSeq);
		expect(port.head()).toBe(1); // no second commit

		expect(seam.listActiveDeliveries()).toHaveLength(1);

		// Reopen the seam over a REOPENED port (same storage, explicit
		// conversation) — recovery rebuilds the registry from the pi log.
		const reopenedPort = await openPiStorageDurableLogPort(storage, {
			conversationId: port.bridgedConversationId!,
		});
		const reopenedSeam = await DurableSeam.open(reopenedPort);
		const report = await reopenedSeam.recover();
		expect(report.recoveredDeliveries).toBe(1);
		expect(reopenedSeam.listActiveDeliveries()).toHaveLength(1);
	});

	it('carries the seam entry kinds verbatim inside pi EntryRecords', async () => {
		const storage = referenceStorage();
		const port = await openPiStorageDurableLogPort(storage);
		const seam = await DurableSeam.open(port);
		await seam.acceptOwnerInput({
			conversationId: 'conv-2',
			requestId: 'req-2',
			content: { text: 'hi' },
			whenBusy: 'followUp',
		});

		const window = port.readDeltaChecked(0, 256 * 1024);
		const kinds = window.entries.map((entry) => entry.kind);
		expect(kinds).toContain(SEAM_ENTRY_KINDS.submission);
		expect(kinds).toContain(SEAM_ENTRY_KINDS.receipt);
		expect(kinds).toContain(SEAM_ENTRY_KINDS.snapshot);
	});
});
