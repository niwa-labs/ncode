// G-PERF / I03 counter assertions for the incremental projection (plan §2.7
// «Append и обновление fold», §10 «Incremental path», u-registry U06: "I03
// same-head O(1), append без W-copy").
//
// The counters (`projectionPerf`, test instrumentation in src/window.ts) make
// the complexity contract observable instead of timing-based:
//
//   - `payloadBytesMeasured` — payload byte-length computations. THE no-op
//     gate of §10: "no-op counters = 0 old payload decode/convert/hash". A
//     warm same-head read and an audit-only commit must measure ZERO payloads;
//     appending Δ entries measures exactly Δ (each new payload once),
//     independent of the window size W.
//   - `windowRefsCopied` — window member references copied on the
//     projection's write paths: appends, control rewrites AND window
//     materializations (`toArray` — a manifest build counts its full size;
//     the W03 review's finding №1 was exactly a materialization the counter
//     could not see). Appending Δ entries must copy O(Δ·CHUNK + amortized
//     chunk pointers), never O(Δ·W): the previous `[...state.segments,
//     segment]` per entry would copy ≥ 2·Δ·W refs here and fail every append
//     assertion below. Same-head reads (the revision-cached manifest) copy
//     ZERO — the cache return is the O(1) lookup of I03.
//
// Control rewrites (an edit, a compaction cut) pay O(W) by design — the
// "явно оплачиваемая инвалидация затронутого span/окна" — and the test PINS
// that too, so the counters are shown to measure real copying (a counter that
// never counts proves nothing).

import { describe, expect, it } from 'vitest';

import {
	ProjectionService,
	WINDOW_CHUNK_CAPACITY,
	buildProjection,
	projectionPerf,
	resetProjectionPerf,
} from '../../src/index.js';
import type { Entry, JsonValue } from '../../../durable-backend-sqlite-zstd/src/types.js';
import { auditEntry, commitOf, llmEntry } from './helpers.js';

/** Builds one commit of `count` LLM entries at `seq` (ordinals 0..count-1). */
function batch(seq: number, count: number, salt: string): Entry[] {
	const entries: Entry[] = [];
	for (let ordinal = 0; ordinal < count; ordinal += 1) {
		const payload: JsonValue = { role: 'user', content: [{ type: 'text', text: `${salt}-${seq}-${ordinal}` }] };
		entries.push(llmEntry('pi.user', payload, seq, ordinal));
	}
	return entries;
}

/** Applies `commits` batches of `batchSize` entries, returning the applied log. */
function warm(service: ProjectionService, commits: number, batchSize: number): Entry[] {
	const log: Entry[] = [];
	for (let seq = 1; seq <= commits; seq += 1) {
		const entries = batch(seq, batchSize, 'warm');
		log.push(...entries);
		service.apply(commitOf(seq, entries));
	}
	return log;
}

/**
 * The exact structural bound of the persistent window, for the TWO
 * persistent lists the fold maintains (slots + segments): Δ appends copy
 * ≤ Δ·(CHUNK+1) tail refs per list plus ≤ (⌈Δ/CHUNK⌉+1) chunk-pointer-array
 * copies of ≤ (W+Δ)/CHUNK+2 refs each. A per-entry W-copy (the old
 * `[...segments, segment]` + `[...slots, slot]`) copies ≥ 2·Δ·W refs.
 */
const appendBound = (windowSize: number, delta: number): number =>
	2 *
	(delta * (WINDOW_CHUNK_CAPACITY + 1) +
		(Math.ceil(delta / WINDOW_CHUNK_CAPACITY) + 1) * ((windowSize + delta) / WINDOW_CHUNK_CAPACITY + 2));

describe('G-PERF/I03: no-op and same-head counters (plan §10 «no-op counters = 0»)', () => {
	it('same-head reads measure zero payloads and copy zero window refs (O(1) lookup)', () => {
		const service = new ProjectionService();
		warm(service, 10, 20); // W = 200

		// Materialize the revision's manifest cache once — the lazily paid
		// O(W) read cost the commit path never touches — THEN measure the
		// same-head reads (the warm lookup the invariant is about).
		service.manifest();
		resetProjectionPerf();
		const first = service.manifest();
		expect(projectionPerf.payloadBytesMeasured).toBe(0);
		expect(projectionPerf.windowRefsCopied).toBe(0);

		service.manifest();
		service.manifest();
		service.capsule();
		service.revision({ conversationId: 'c', rootId: 'r' });
		service.snapshot({ conversationId: 'c', rootId: 'r', requestId: 'q1', sessionId: 's', createdAtMs: 0 });
		expect(projectionPerf.payloadBytesMeasured).toBe(0);
		expect(projectionPerf.windowRefsCopied).toBe(0);
		// The repeated reads are lookups of the same committed state: the SAME
		// frozen cache object, not merely equal copies — and `snapshot()` over
		// the cache shares the frozen segment array (freezing is the isolation).
		expect(service.manifest()).toBe(first);
		const snapshot = service.snapshot({
			conversationId: 'c',
			rootId: 'r',
			requestId: 'q2',
			sessionId: 's',
			createdAtMs: 0,
		});
		expect(snapshot.manifest.segments).toBe(first.segments);
	});

	it('materializing a revision’s manifest copies the window exactly once — and the counter SEES it', () => {
		const service = new ProjectionService();
		warm(service, 10, 20); // W = 200

		// The first read of a revision pays ONE window materialization —
		// now counted (the W03 review's finding: `toArray` used to be free
		// to the gate while costing O(W)).
		resetProjectionPerf();
		const first = service.manifest();
		expect(projectionPerf.windowRefsCopied).toBe(200);
		expect(projectionPerf.payloadBytesMeasured).toBe(0);

		// Every further same-head read is the frozen cache: zero copies.
		resetProjectionPerf();
		expect(service.manifest()).toBe(first);
		expect(projectionPerf.windowRefsCopied).toBe(0);
		expect(projectionPerf.payloadBytesMeasured).toBe(0);
	});

	it('an audit-only commit is a no-op for both counters', () => {
		const service = new ProjectionService();
		warm(service, 10, 20);

		resetProjectionPerf();
		service.apply(commitOf(11, [auditEntry(11, 0)]));
		expect(projectionPerf.payloadBytesMeasured).toBe(0);
		expect(projectionPerf.windowRefsCopied).toBe(0);
		// The commit did not materialize the manifest either — the cache is
		// invalidated (new revision) and rebuilt only on the next read.
		service.manifest();
		expect(service.manifest().head).toBe(11);
	});
});

describe('G-PERF/I03: append is O(Δ), not O(W) — no W-copy per entry', () => {
	it('appending Δ entries copies O(Δ·CHUNK) refs at W≈2000 — far below Δ·W', () => {
		const windowSize = 2000;
		const delta = 100;
		const service = new ProjectionService();
		warm(service, 100, 20);

		resetProjectionPerf();
		service.apply(commitOf(101, batch(101, delta, 'delta')));
		const refs = projectionPerf.windowRefsCopied;

		// Each new payload is measured exactly once — the Δ axis.
		expect(projectionPerf.payloadBytesMeasured).toBe(delta);
		// Structural bound of the persistent window.
		expect(refs).toBeLessThanOrEqual(appendBound(windowSize, delta));
		// And the practical budget: a per-entry W-copy would be ≥ 2·Δ·W = 400 000.
		expect(refs).toBeLessThan(delta * WINDOW_CHUNK_CAPACITY * 4);
		expect(refs).toBeGreaterThan(0);
	});

	it('the append cost is independent of the window size (W=8000 stays in the same budget)', () => {
		const delta = 100;
		const service = new ProjectionService();
		warm(service, 400, 20); // W = 8000

		resetProjectionPerf();
		service.apply(commitOf(401, batch(401, delta, 'delta')));
		const refs = projectionPerf.windowRefsCopied;

		expect(projectionPerf.payloadBytesMeasured).toBe(delta);
		// Same structural bound as the W=2000 run, scaled only by the amortized
		// chunk-pointer growth (O(W/CHUNK) refs per CHUNK appends — allowed by
		// the plan's «O(Δ log W) при persistent-индексах» row).
		expect(refs).toBeLessThanOrEqual(appendBound(8000, delta));
		// A W-proportional implementation would copy ≥ 2·Δ·W = 1 600 000 refs.
		expect(refs).toBeLessThan(delta * WINDOW_CHUNK_CAPACITY * 4);
	});

	it('a control rewrite pays its explicit O(W) invalidation (the counters do measure copying)', () => {
		const service = new ProjectionService();
		const log = warm(service, 100, 20); // W = 2000
		const head = service.manifest();

		resetProjectionPerf();
		service.apply(commitOf(101, [{ ...auditEntry(101, 0), kind: 'mcode.compaction', payload: { summary: 'cut', firstKeptEntryId: head.segments[0]!.entryId } }]));
		// The cut rebuilt the window from a materialized array: ≥ kept+dropped refs.
		expect(projectionPerf.windowRefsCopied).toBeGreaterThan(0);
		// No payload was measured — a cut moves handles, it never decodes payloads.
		expect(projectionPerf.payloadBytesMeasured).toBe(0);
		expect(log.length).toBeGreaterThan(0);
	});

	it('a full rebuild copies ≥ N refs — the counter baseline (oracle outside the measured path)', () => {
		const log = warm(new ProjectionService(), 50, 20); // N = 1000
		resetProjectionPerf();
		buildProjection(log);
		expect(projectionPerf.windowRefsCopied).toBeGreaterThanOrEqual(log.length);
		expect(projectionPerf.payloadBytesMeasured).toBe(log.length);
	});
});

describe('G-PERF/I03: the commit cost is independent of the window size (O(Δ), not O(W))', () => {
	/**
	 * The reviewer's measurement axis (reviews/w03-review.md №1): per-commit
	 * cost grew linearly in W because `apply()` materialized the whole
	 * manifest (O(W) `toArray` + a `segments.filter` scan) on EVERY commit.
	 * After the fix the commit path folds Δ entries and nothing else — the
	 * manifest is the revision's lazy cache. This test pins the SAME axis
	 * structurally: K single-entry commits at W=1000 vs W=64000 must copy a
	 * near-identical number of refs (allowance ×2, the reviewer's tolerance)
	 * and measure exactly K payloads. A W-proportional commit path (the old
	 * one, or any regression back to `[...segments, x]`/per-commit
	 * materialization) copies ≥ 2·K·W refs — 256 000 at W=1000 and
	 * 16 384 000 at W=64000 — and fails every assertion below.
	 */
	const commitsAt = (windowSize: number, commits: number): { refs: number; payloads: number } => {
		const service = new ProjectionService();
		warm(service, Math.ceil(windowSize / 20), 20); // W ≈ windowSize
		const nextSeq = Math.ceil(windowSize / 20) + 1;
		resetProjectionPerf();
		for (let index = 0; index < commits; index += 1) {
			service.apply(commitOf(nextSeq + index, batch(nextSeq + index, 1, `tail-${windowSize}`)));
		}
		return { refs: projectionPerf.windowRefsCopied, payloads: projectionPerf.payloadBytesMeasured };
	};

	it('K single-entry commits copy ~the same refs at W=64000 as at W=1000 (×2 allowance)', () => {
		const commits = 128;
		const at1k = commitsAt(1000, commits);
		const at64k = commitsAt(64_000, commits);

		// Each new payload is measured exactly once — Δ refs of payload work,
		// never W.
		expect(at1k.payloads).toBe(commits);
		expect(at64k.payloads).toBe(commits);

		// Structural bound of the persistent window at both sizes.
		expect(at1k.refs).toBeLessThanOrEqual(appendBound(1000, commits));
		expect(at64k.refs).toBeLessThanOrEqual(appendBound(64_000, commits));
		expect(at1k.refs).toBeGreaterThan(0);
		expect(at64k.refs).toBeGreaterThan(0);

		// THE reviewer threshold: the commit cost must not grow linearly in
		// W — at 64× the window the same commits copy at most ×2 the refs
		// (the margin absorbs the amortized chunk-pointer growth alone).
		expect(at64k.refs).toBeLessThanOrEqual(2 * at1k.refs);
		// And a W-proportional path would already be ≥ 2·K·W at W=1000.
		expect(at1k.refs).toBeLessThan(2 * commits * 1000);
		expect(at64k.refs).toBeLessThan(2 * commits * 64_000);
	});

	it('reading the applied result stays honest: manifest() materializes once per revision, not per commit', () => {
		// The consumer pattern of the runtime wire (`applyCommit` folds, then
		// reads the manifest): the manifest is built ONCE for the new
		// revision — its K commits cost O(K) in refs plus one O(W)
		// materialization for the read, instead of K materializations.
		const commits = 128;
		const service = new ProjectionService();
		warm(service, 50, 20); // W = 1000
		resetProjectionPerf();
		for (let index = 0; index < commits; index += 1) {
			const seq = 51 + index;
			service.apply(commitOf(seq, batch(seq, 1, 'read')));
		}
		const foldRefs = projectionPerf.windowRefsCopied;
		service.manifest();
		const withOneRead = projectionPerf.windowRefsCopied;
		service.manifest();
		service.manifest();
		expect(projectionPerf.windowRefsCopied).toBe(withOneRead);

		// The K commits copied O(Δ·CHUNK) refs; the single read added one
		// window materialization (W + Δ refs). K reads of the OLD shape would
		// have copied ≥ K·(W+Δ) refs on top of the fold.
		expect(foldRefs).toBeLessThanOrEqual(appendBound(1000, commits));
		expect(withOneRead - foldRefs).toBe(1000 + commits);
	});
});
