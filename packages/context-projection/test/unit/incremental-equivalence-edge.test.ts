// Edge cases of the incremental projection.
//
// The existing suites pin the happy path (apply×N = full rebuild over a
// generated stream). This file pins the edges the happy path cannot reach:
//
//   - the DERIVED WINDOW must not depend on the writer's batch grouping
//     (the batch is a storage concern, the window is a projection concern);
//   - the manifest snapshot must be ISOLATED from the service state (a caller
//     may retain it across applies);
//   - a REJECTED commit must leave the state byte-identical (the failed apply
//     is retryable at the same sequence);
//   - malformed / giant inputs must be rejected or folded without drift.

import { describe, expect, it } from 'vitest';

import { SEQ_AT_START } from '../../../durable-backend-sqlite-zstd/src/types.js';
import type { Entry } from '../../../durable-backend-sqlite-zstd/src/types.js';

import { ProjectionError, ProjectionService, buildProjection } from '../../src/index.js';
import type { CommitWithEntries } from '../../src/index.js';
import { auditEntry, commitOf, compactionEntry, editEntry, llmEntry, seqOf } from './helpers.js';

/** The same log content, re-stamped for a different batch grouping. */
interface LogItem {
	readonly id: string;
	readonly kind: string;
	readonly payload: unknown;
}

const CONTENT: readonly LogItem[] = [
	{ id: 'u1', kind: 'pi.user', payload: { text: 'one' } },
	{ id: 'u2', kind: 'pi.user', payload: { text: 'two' } },
	{ id: 'a1', kind: 'pi.assistant', payload: { text: 'three' } },
	{ id: 'aud', kind: 'mcode.audit', payload: { note: 'x' } },
	{ id: 'u3', kind: 'pi.user', payload: { text: 'four' } },
];

/** Applies the same content under the given batch grouping; returns the service and the log. */
function applyGrouped(groupSizes: readonly number[]): {
	service: ProjectionService;
	log: Entry[];
} {
	const service = new ProjectionService();
	const log: Entry[] = [];
	let offset = 0;
	let seq = 0;
	for (const size of groupSizes) {
		const pendingSeq = seq + 1;
		const batch: Entry[] = [];
		for (let ordinal = 0; ordinal < size; ordinal += 1) {
			const item = CONTENT[offset];
			offset += 1;
			if (item === undefined) break;
			batch.push({
				id: item.id,
				parentId: null,
				kind: item.kind,
				payload: item.payload as never,
				seq: seqOf(pendingSeq),
				ordinal,
			});
		}
		if (batch.length === 0) continue;
		seq = pendingSeq;
		log.push(...batch);
		service.apply(commitOf(seq, batch));
	}
	return { service, log };
}

/** The derived view only — the parts that must not depend on the grouping. */
function windowOf(service: ProjectionService): unknown {
	const manifest = service.manifest();
	return {
		segments: manifest.segments,
		windowBytes: manifest.windowBytes,
		usageAnchor: manifest.usageAnchor,
	};
}

describe('derived window vs. batch grouping', () => {
	it('derives the same window whether the log arrives in one commit or in five', () => {
		const one = applyGrouped([1, 1, 1, 1, 1]);
		const single = applyGrouped([5]);
		const mixed = applyGrouped([2, 3]);

		// The window (segments, byte axis, usage anchor) is a projection
		// property — the batch is a storage property.
		expect(windowOf(one.service)).toEqual(windowOf(single.service));
		expect(windowOf(one.service)).toEqual(windowOf(mixed.service));

		// The log position DOES depend on the grouping: it is the storage axis.
		expect(one.service.manifest().head).toBe(5);
		expect(single.service.manifest().head).toBe(1);
		expect(one.service.manifest().watermark).toEqual({ seq: 5, ordinal: 0 });
		expect(single.service.manifest().watermark).toEqual({ seq: 1, ordinal: 4 });

		// And every grouping still equals a full rebuild over its own log.
		expect(one.service.manifest()).toEqual(buildProjection(one.log));
		expect(single.service.manifest()).toEqual(buildProjection(single.log));
	});

	it('keeps the window identical across a compaction under different groupings', () => {
		const build = (groupSizes: readonly number[]): { service: ProjectionService; log: Entry[] } => {
			const service = new ProjectionService();
			const log: Entry[] = [];
			let seq = 0;
			const groups = groupSizes.map((size) => size);
			groups.push(1); // the compaction commit
			let cursor = 0;
			for (const size of groups) {
				const pendingSeq = seq + 1;
				const batch: Entry[] = [];
				for (let ordinal = 0; ordinal < size; ordinal += 1) {
					const item = CONTENT[cursor];
					cursor += 1;
					if (item === undefined) break;
					batch.push({
						id: item.id,
						parentId: null,
						kind: item.kind,
						payload: item.payload as never,
						seq: seqOf(pendingSeq),
						ordinal,
					});
				}
				if (batch.length === 0) continue;
				seq = pendingSeq;
				log.push(...batch);
				service.apply(commitOf(seq, batch));
			}
			// The compaction keeps the LAST user entry.
			const last = log[log.length - 1]!;
			const cut = compactionEntry(seq + 1, 0, 'summary of the prefix', last.id);
			log.push(cut);
			service.apply(commitOf(seq + 1, [cut]));
			return { service, log };
		};

		const grouped = build([2, 3]);
		const single = build([5]);
		expect(windowOf(grouped.service)).toEqual(windowOf(single.service));
		expect(grouped.service.manifest()).toEqual(buildProjection(grouped.log));
		expect(single.service.manifest()).toEqual(buildProjection(single.log));
	});
});

describe('snapshot isolation', () => {
	it('hands out a manifest snapshot the caller cannot corrupt', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a]));

		const snapshot = service.manifest();
		// The revision's cached manifest is deep-frozen: a corruption attempt
		// THROWS instead of silently landing (the cache is shared by every
		// same-head reader, so it must be immutable by construction).
		expect(() => {
			(snapshot.segments as unknown as unknown[]).push({ entryId: 'injected', byteLen: 0, kind: 'pi.user' });
		}).toThrow();
		expect(() => {
			(snapshot.watermark as { ordinal: number }).ordinal = 999;
		}).toThrow();
		expect(() => {
			(snapshot as { head: number }).head = 999;
		}).toThrow();

		// The service state is untouched by the caller's attempt, and a
		// same-head read returns the SAME frozen cache object (O(1), I03).
		const fresh = service.manifest();
		expect(fresh).toBe(snapshot);
		expect(fresh.segments.map((segment) => segment.entryId)).toEqual([a.id]);
		expect(fresh.watermark).toEqual({ seq: 1, ordinal: 0 });
		expect(fresh.head).toBe(1);
	});

	it('keeps a snapshot taken before an apply valid after it', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a]));
		const before = service.manifest();

		const b = llmEntry('pi.assistant', { text: 'a1' }, 2, 0);
		service.apply(commitOf(2, [b]));

		// The retained snapshot still describes the OLD window, unchanged.
		expect(before.segments.map((segment) => segment.entryId)).toEqual([a.id]);
		expect(before.head).toBe(1);
		expect(service.manifest().segments.map((segment) => segment.entryId)).toEqual([a.id, b.id]);
	});

	it('hands out a copy of the LLM segment view', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a]));

		const view = service.llmSegments() as unknown as unknown[];
		view.push({ entryId: 'injected', byteLen: 0, kind: 'pi.user' });
		expect(service.llmSegments()).toHaveLength(1);
	});
});

describe('empty input', () => {
	it('folds an empty log into the start-of-log manifest and capsule', () => {
		const service = new ProjectionService();
		expect(service.manifest()).toEqual(buildProjection([]));
		expect(service.manifest().head).toBe(SEQ_AT_START);
		expect(service.llmSegments()).toEqual([]);
		expect(service.capsule()).toEqual({
			head: SEQ_AT_START,
			firstKeptEntryId: null,
			compaction: null,
			usageAnchor: null,
			appliedSeq: SEQ_AT_START,
		});
	});

	it('reports no resident segment for an unknown entry id', async () => {
		const service = new ProjectionService();
		await expect(service.fault('missing')).rejects.toThrow(ProjectionError);
	});
});

describe('rejected commits leave the state untouched', () => {
	it('keeps the manifest and the capsule byte-identical after every rejection', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a]));
		const manifestBefore = service.manifest();
		const capsuleBefore = service.capsule();

		const rejects: Array<[string, CommitWithEntries]> = [
			// A gap in the log sequence.
			['gap', commitOf(3, [llmEntry('pi.user', { text: 'x' }, 3, 0)])],
			// A replay of the already applied sequence.
			['replay', commitOf(1, [llmEntry('pi.user', { text: 'x' }, 1, 0)])],
			// An empty batch.
			['empty', commitOf(2, [])],
			// A skipped ordinal inside the batch.
			[
				'skipped ordinal',
				commitOf(2, [llmEntry('pi.user', { text: 'x' }, 2, 0), llmEntry('pi.assistant', { text: 'y' }, 2, 2)]),
			],
			// An entry carrying another commit's sequence.
			['foreign entry seq', commitOf(2, [llmEntry('pi.user', { text: 'x' }, 7, 0)])],
			// A commit whose head diverges from its seq.
			['diverged head', { ...commitOf(2, [llmEntry('pi.user', { text: 'x' }, 2, 0)]), head: seqOf(9) }],
			// A commit whose entryCount does not match the supplied entries.
			[
				'entryCount mismatch',
				{ ...commitOf(2, [llmEntry('pi.user', { text: 'x' }, 2, 0)]), entryCount: 2 },
			],
			// A control entry that violates the projection contract.
			['unknown compaction target', commitOf(2, [compactionEntry(2, 0, 'summary', 'missing-entry')])],
			// A strict prune of an id outside the current context.
			['unknown prune target', commitOf(2, [editEntry(2, 0, ['missing-entry'])])],
		];

		for (const [label, commit] of rejects) {
			expect(() => service.apply(commit), label).toThrow(ProjectionError);
			// The failed apply changed nothing: the retry at the same sequence
			// is still possible.
			expect(service.manifest(), label).toEqual(manifestBefore);
			expect(service.capsule(), label).toEqual(capsuleBefore);
		}

		// And the corrected commit at the same sequence still applies.
		const b = llmEntry('pi.assistant', { text: 'a1' }, 2, 0);
		service.apply(commitOf(2, [b]));
		expect(service.manifest().segments.map((segment) => segment.entryId)).toEqual([a.id, b.id]);
		expect(service.manifest()).toEqual(buildProjection([a, b]));
	});
});

describe('giant input', () => {
	it('folds a five-thousand-entry batch without drifting from a full rebuild', () => {
		const service = new ProjectionService();
		const batch: Entry[] = [];
		for (let ordinal = 0; ordinal < 5000; ordinal += 1) {
			batch.push(llmEntry('pi.user', { text: `payload-${ordinal}` }, 1, ordinal));
		}
		service.apply(commitOf(1, batch));

		const manifest = service.manifest();
		expect(manifest.segments).toHaveLength(5000);
		expect(manifest.watermark).toEqual({ seq: 1, ordinal: 4999 });
		expect(manifest.windowBytes).toBe(
			batch.reduce(
				(sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'),
				0,
			),
		);
		expect(manifest).toEqual(buildProjection(batch));
	});

	it('folds a giant payload without losing the byte axis', () => {
		const service = new ProjectionService();
		const huge = 'x'.repeat(2_000_000);
		const entry = llmEntry('pi.user', { text: huge }, 1, 0);
		service.apply(commitOf(1, [entry]));
		expect(service.manifest().windowBytes).toBe(
			Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'),
		);
		expect(service.manifest().windowBytes).toBeGreaterThan(2_000_000);
	});
});

describe('delta semantics', () => {
	it('reports no delta for a commit whose own control entry pruned its segments', () => {
		// Characterization of the documented contract: the delta is "the
		// segments of the POST-apply manifest attributed to this commit's
		// entries". A commit that adds a segment and prunes it again in the
		// same batch therefore contributes no delta segment — the segment
		// never exists in the derived view.
		const service = new ProjectionService();
		const user = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const prune = editEntry(1, 1, [user.id]);
		const result = service.apply(commitOf(1, [user, prune]));

		expect(result.rebuilt).toBe(true);
		expect(result.delta).toEqual([]);
		expect(result.manifest.segments).toEqual([]);
		expect(result.manifest.windowBytes).toBe(0);
	});
});

describe('resume capsule guards', () => {
	it('rejects a resume slice that is not in ascending log order', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		service.apply(commitOf(1, [a, b]));

		expect(() =>
			ProjectionService.fromCapsule(service.capsule(), [
				{ ...b, id: 'swapped' },
				{ ...a, id: 'swapped-2' },
			]),
		).toThrow(ProjectionError);
	});

	it('accepts a capsule whose appliedSeq is ahead of its head', () => {
		// The backend family guarantees `appliedSeq >= head`; a capsule ahead
		// of the fold head is legal and the resumed service continues at
		// appliedSeq + 1.
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a]));
		const capsule = service.capsule();

		const ahead: typeof capsule = { ...capsule, appliedSeq: seqOf(5) };
		const resumed = ProjectionService.fromCapsule(ahead, [a]);
		expect(resumed.manifest()).toEqual(service.manifest());
		expect(resumed.capsule().appliedSeq).toBe(5);

		const next = llmEntry('pi.assistant', { text: 'a1' }, 6, 0);
		resumed.apply(commitOf(6, [next]));
		expect(resumed.manifest().segments.map((segment) => segment.entryId)).toEqual([a.id, next.id]);
	});

	it('rejects a resume slice that folds to a different usage anchor', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a]));
		const capsule = service.capsule();
		expect(() =>
			ProjectionService.fromCapsule({ ...capsule, usageAnchor: 'stale' }, [a]),
		).toThrow(ProjectionError);
	});
});

describe('control kinds', () => {
	it('never turns a control kind into a segment, whatever its payload shape', () => {
		const service = new ProjectionService();
		const audit = auditEntry(1, 0);
		const mcode = llmEntry('mcode.', { anything: true }, 1, 1);
		const notMcode = llmEntry('mcodex', { text: 'visible' }, 1, 2);
		service.apply(commitOf(1, [audit, mcode, notMcode]));

		// `mcode.` is a control kind by prefix; `mcodex` is not.
		expect(service.manifest().segments.map((segment) => segment.entryId)).toEqual([notMcode.id]);
		expect(service.manifest().watermark).toEqual({ seq: 1, ordinal: 2 });
	});
});
