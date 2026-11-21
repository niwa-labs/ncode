// Incremental projection service.
//
// The service keeps the manifest fold warm: `apply()` folds ONLY the entries
// of the incoming commit into the cached state through the single shared
// `foldEntry` step (the head-keyed incremental cache idea of pi-durable
// da866ada1), so the steady-state cost is O(entries of the commit) on EVERY
// commit — including the control kinds (`mcode.compaction` /
// `mcode.context_edit`), whose fold operates on the cached `state.segments`
// alone. A control commit therefore never re-folds the history, and the
// service holds NO retained raw log: RAM is bounded by the derived window,
// not by the session length. The equivalence to `buildProjection` over the
// whole log holds by construction (one fold step) and is pinned by a unit
// test.
//
// The backend `Commit` is a write result and does not carry the batch
// entries, while the projection fold needs their content — so `apply` takes
// the commit ENRICHED with its entries (`CommitWithEntries`), the pair the
// caller of `appendBatch` already has in hand.
//
// The manifest itself is NOT materialized on the commit path: it is cached
// per fold revision and deep-frozen on first same-head read (the W03 review's
// finding №1 — `toManifest` per commit made apply O(W) in window refs while
// the perf counter stayed blind). `apply()` therefore costs O(Δ) refs on
// every commit; `manifest()` at the same head is an O(1) cache return; a
// `snapshot()` over the cached manifest shares its frozen segment array.

// Types come straight from the backend's `src/types.ts` — see the note in
// `projection.ts` for why the package specifier is avoided until `dist/`
// exists.

import { createLogger } from '@mavis/logging';

import type { Commit, Entry, Seq } from '../../durable-backend-sqlite-zstd/src/types.js';
import { SEQ_AT_START } from '../../durable-backend-sqlite-zstd/src/types.js';

import { COMPACTION_KIND, CONTEXT_EDIT_KIND, USAGE_KIND, isControlKind } from './kinds.js';
import {
	type CompactionMark,
	type ContextManifest,
	EMPTY_STATE,
	type ProjectionState,
	type Segment,
	ProjectionError,
	foldEntry,
	toManifest,
} from './projection.js';
import {
	PROJECTION_SCHEMA_VERSION,
	type ProjectionRevision,
	type RequestSnapshot,
	type RequestSnapshotRoute,
	buildRequestSnapshot,
	deepFreeze,
} from './request-snapshot.js';
import type { ResidencyPolicy } from './residency.js';
import { isUsageEmpty, type UsageFold } from './usage.js';

const log = createLogger('mcode:projection');

/** A backend commit enriched with the entries stored in its batch. */
export type CommitWithEntries = Commit & { readonly entries: readonly Entry[] };

/** Result of applying one commit to the projection. */
export interface ApplyResult {
	/** The commit that was applied, verbatim. */
	readonly commit: Commit;
	/**
	 * Manifest snapshot after the commit; structurally equal to a full
	 * rebuild. LAZY: the commit path itself stays O(Δ) — the manifest is
	 * materialized (once per revision, deep-frozen) on first access, so a
	 * caller that never reads it pays nothing, and one that reads it twice
	 * gets the same frozen object.
	 */
	readonly manifest: ContextManifest;
	/**
	 * The derived view of ONLY the new entries: the segments of the post-apply
	 * manifest attributed to this commit's entries (control entries contribute
	 * none — they are filtered out of the LLM context). Lazy like
	 * {@link manifest}: a plain commit reads its segments off the window tail
	 * in O(Δ); only a control commit (whose fold already paid its O(W)
	 * rewrite) derives them from the materialized manifest.
	 */
	readonly delta: readonly Segment[];
	/**
	 * Whether the commit carried a control entry that rewrote the derived
	 * view (compaction cut / pruning). The fold itself is incremental on
	 * every commit — this flag only marks the manifest rewrite.
	 */
	readonly rebuilt: boolean;
}

/**
 * Projection-level resume capsule: everything a consumer needs to resume the
 * derived context WITHOUT walking the log — read the capsule, then
 * {@link ProjectionService.fromCapsule} the retained slice
 * (`firstKeptEntryId` … `head`) the storage layer serves as a range read.
 *
 * Self-contained by design (≤ a few hundred bytes): the capsule carries the
 * winning compaction mark, so the summary text survives without re-reading
 * the checkpoint entry.
 *
 * Distinct from the backend's storage-level `ResumeCapsule`, which describes
 * the last durable batch.
 */
export interface ResumeCapsule {
	/** Log head the projection has caught up to. */
	readonly head: Seq;
	/** First entry still kept as a segment after the last compaction; `null` without compaction. */
	readonly firstKeptEntryId: string | null;
	/** The winning compaction mark (summary + first kept id); `null` without compaction. */
	readonly compaction: CompactionMark | null;
	/** Entry id usage accounting resumes from; `null` before the first LLM-visible entry. */
	readonly usageAnchor: string | null;
	/** Sequence of the last applied commit; `SEQ_AT_START` before the first commit. */
	readonly appliedSeq: Seq;
	/**
	 * Persisted usage totals at the capsule position, present once any
	 * `mcode.usage` entry was folded. Totals survive compaction, so a resume
	 * must restore them wholesale instead of re-deriving from the retained
	 * slice (which would drop pre-slice spend).
	 */
	readonly usage?: UsageFold;
	/**
	 * Edit-revision counter at the capsule position, present once any
	 * `mcode.context_edit` entry was folded (see {@link ProjectionState.editCount}).
	 */
	readonly editCount?: number;
}

/** Options of {@link ProjectionService}. */
export interface ProjectionServiceOptions {
	/**
	 * Context MMU hook. Absent (default): every page is resident and `fault()`
	 * resolves segments locally from the manifest.
	 */
	readonly residency?: ResidencyPolicy;
}

/**
 * Incremental projector over one durable log. Apply commits in order; the
 * manifest, the resume capsule and the LLM context view stay current without
 * ever re-reading applied entries — the fold is O(entries of the commit) on
 * every commit, control kinds included, and nothing but the derived window is
 * retained.
 */
export class ProjectionService {
	private state: ProjectionState = EMPTY_STATE;
	private lastSeq: Seq = SEQ_AT_START as Seq;
	private readonly residency: ResidencyPolicy | undefined;
	/**
	 * Manifest materialization cache, keyed by the fold revision: `null`
	 * until the first same-head read of a revision, invalidated by every
	 * successful `apply` (and never set by the commit path itself). Built
	 * once per revision — O(W), the lazily paid read cost — and deep-frozen,
	 * so handing the SAME object to every same-head reader is safe: repeated
	 * `manifest()` calls are O(1) (I03) and no caller can corrupt the cache.
	 */
	private manifestCache: ContextManifest | null = null;

	constructor(options?: ProjectionServiceOptions) {
		this.residency = options?.residency;
	}

	/**
	 * Rebuilds a service from a resume capsule and the retained log slice the
	 * storage layer serves for it — the lazy-open path: read the capsule
	 * (one meta row), range-read ONLY the slice (`firstKeptEntryId` … `head`),
	 * fold it, and continue applying new commits; no full-log replay.
	 *
	 * The slice must be in ascending log order and must be exactly the window
	 * the capsule describes: it starts at `capsule.firstKeptEntryId` (when
	 * set), ends at `capsule.head`, and folds to the capsule's
	 * `usageAnchor`. The capsule's compaction mark is overlaid after the
	 * fold (the checkpoint entry itself sits BEFORE the slice and is not
	 * re-read). Any inconsistency throws {@link ProjectionError} before the
	 * service is built.
	 */
	static fromCapsule(capsule: ResumeCapsule, slice: readonly Entry[], options?: ProjectionServiceOptions): ProjectionService {
		if ((capsule.firstKeptEntryId === null) !== (capsule.compaction === null)) {
			throw new ProjectionError(
				`capsule at head ${capsule.head}: firstKeptEntryId and compaction must be set together or both null`,
			);
		}
		// Fold FIRST (it validates order and can throw), overlay the capsule
		// metadata after; only then mutate the fresh service.
		let state = EMPTY_STATE;
		for (const entry of slice) {
			state = foldEntry(state, entry);
		}
		if (capsule.firstKeptEntryId !== null) {
			const first = slice[0];
			if (first === undefined || first.id !== capsule.firstKeptEntryId) {
				throw new ProjectionError(
					`capsule at head ${capsule.head}: slice must start at firstKeptEntryId ` +
						`${JSON.stringify(capsule.firstKeptEntryId)}, got ${JSON.stringify(first?.id ?? null)}`,
				);
			}
		}
		if (state.head !== capsule.head) {
			throw new ProjectionError(
				`capsule at head ${capsule.head}: slice folds to head ${state.head}`,
			);
		}
		if (state.usageAnchor !== capsule.usageAnchor) {
			throw new ProjectionError(
				`capsule at head ${capsule.head}: slice folds to usageAnchor ` +
					`${JSON.stringify(state.usageAnchor)}, capsule says ${JSON.stringify(capsule.usageAnchor)}`,
			);
		}
		if (capsule.compaction !== null) {
			state = { ...state, compaction: { ...capsule.compaction } };
		}
		// Usage totals and the edit counter are restored WHOLESALE from the
		// capsule: they include pre-slice history the retained slice cannot
		// re-derive (spend before the compaction cut, edits of cut members).
		if (capsule.usage !== undefined) {
			state = { ...state, usage: capsule.usage };
		}
		if (capsule.editCount !== undefined && capsule.editCount >= state.editCount) {
			state = { ...state, editCount: capsule.editCount };
		}
		const service = new ProjectionService(options);
		// `lastSeq` accepts the appliedSeq+1 commit next; appliedSeq ≥ head is
		// the only ordering this backend family guarantees beyond equality.
		if (capsule.appliedSeq < capsule.head) {
			throw new ProjectionError(
				`capsule appliedSeq ${capsule.appliedSeq} is behind its own head ${capsule.head}`,
			);
		}
		service.state = state;
		service.lastSeq = capsule.appliedSeq;
		log.info('projection resumed from capsule', {
			head: capsule.head,
			entries: slice.length,
			appliedSeq: capsule.appliedSeq,
		});
		return service;
	}

	/**
	 * Applies one committed batch. The commit must be the immediate successor
	 * of the previously applied one (the backend never leaves sequence gaps),
	 * and its entries must be exactly the batch contents.
	 *
	 * Atomic on failure: every throw below (replay, gap, mismatch, or a
	 * control payload that violates the projection contract) happens BEFORE
	 * any state mutation, so the service stays exactly as it was and the
	 * corrected commit can be retried at the same sequence.
	 */
	apply(commit: CommitWithEntries): ApplyResult {
		const { entries } = commit;
		if (commit.head !== commit.seq) {
			// Backend invariant (`Commit.head === Commit.seq` for sqlite-zstd).
			throw new ProjectionError(`commit ${commit.seq}: head ${commit.head} differs from seq`);
		}
		if (entries.length === 0 || commit.entryCount !== entries.length) {
			throw new ProjectionError(
				`commit ${commit.seq}: entryCount ${commit.entryCount} does not match ${entries.length} supplied entries`,
			);
		}
		const expectedSeq = (this.lastSeq + 1) as Seq;
		if (commit.seq !== expectedSeq) {
			throw new ProjectionError(
				`commit ${commit.seq} is not the successor of the applied log (expected ${expectedSeq})`,
			);
		}
		for (const entry of entries) {
			if (entry.seq !== commit.seq) {
				throw new ProjectionError(
					`entry ${entry.id} carries seq ${entry.seq}, outside its commit ${commit.seq}`,
				);
			}
		}
		// A commit is a WHOLE batch: its first entry must carry ordinal 0. The
		// fold itself tolerates a mid-batch start on purpose (a resume slice may
		// begin in the middle of a batch), so an internal gap is caught by the
		// fold while a wrong BASE would slip through and park the watermark on
		// an ordinal that does not exist in the applied batch.
		if (entries[0]!.ordinal !== 0) {
			throw new ProjectionError(
				`commit ${commit.seq}: first entry ${JSON.stringify(entries[0]!.id)} carries ordinal ` +
					`${entries[0]!.ordinal}; a whole batch starts at ordinal 0`,
			);
		}

		// Every commit folds through the same single `foldEntry` step — control
		// kinds included, whose fold operates on the cached segments alone. The
		// flag only REPORTS that this commit rewrote the derived view.
		const rebuilt = entries.some(
			(entry) => entry.kind === COMPACTION_KIND || entry.kind === CONTEXT_EDIT_KIND,
		);
		// Fold FIRST, mutate LAST: the fold can throw (malformed control
		// payload, unknown compaction target), and a failed apply must leave
		// the cached state untouched — otherwise a poisoned state would
		// surface stale errors on every later read. A rejected commit also
		// leaves the manifest cache as is: the revision it belongs to is
		// still the current one.
		let state = this.state;
		const startedAtMs = Date.now();
		for (const entry of entries) {
			state = foldEntry(state, entry);
		}
		this.state = state;
		this.lastSeq = commit.seq;
		// The new revision has no manifest yet; materializing it is the READ
		// path's lazily paid cost (once per revision), never the commit's —
		// the commit itself stays O(Δ) refs no matter how large the window
		// is (I03: commit cost proportional to the delta, not to W).
		this.manifestCache = null;
		const durationMs = Date.now() - startedAtMs;

		// O(1) log metadata — segment count and window bytes are maintained
		// by the fold; no manifest materialization happens on the commit path.
		log.debug('commit applied', {
			seq: commit.seq,
			entries: entries.length,
			segments: state.segments.size,
			windowBytes: state.windowBytes,
			rebuilt,
			durationMs,
		});
		if (rebuilt) {
			log.info('projection rebuild', {
				seq: commit.seq,
				entries: entries.length,
				segments: state.segments.size,
				windowBytes: state.windowBytes,
			});
		}

		// The commit's own view of the new state is LAZY (see ApplyResult):
		// `manifest` materializes once per revision on first access — this
		// result is bound to the revision THIS apply produced, so later
		// applies cannot change what it reports — and `delta` of a plain
		// (non-control) commit is the window tail the fold appended: O(Δ),
		// no window scan. A control commit already paid its documented O(W)
		// rewrite in the fold; its delta reads off the materialized manifest.
		const appendedCount = rebuilt ? 0 : entries.filter((entry) => !isControlKind(entry.kind)).length;
		const own = rebuilt ? new Set(entries.map((entry) => entry.id)) : undefined;
		let manifestAtCommit: ContextManifest | null = null;
		let deltaAtCommit: readonly Segment[] | undefined;
		const materialize = (): ContextManifest => (manifestAtCommit ??= deepFreeze(toManifest(state)));
		return {
			commit,
			get manifest(): ContextManifest {
				return materialize();
			},
			get delta(): readonly Segment[] {
				if (deltaAtCommit === undefined) {
					if (own === undefined) {
						// Plain commit: the fold only appended — the new segments are
						// exactly the window tail, in fold (ordinal) order.
						const tail: Segment[] = [];
						for (let index = state.segments.size - appendedCount; index < state.segments.size; index += 1) {
							tail.push(state.segments.get(index)!);
						}
						deltaAtCommit = tail;
					} else {
						deltaAtCommit = materialize().segments.filter((segment) => own.has(segment.entryId));
					}
				}
				return deltaAtCommit;
			},
			rebuilt,
		};
	}

	/**
	 * Current manifest snapshot. SAME-HEAD O(1) (I03): the first read of a
	 * revision materializes and deep-freezes the manifest once (O(W), counted
	 * by the perf gate); every further read at the same head returns that
	 * same frozen object — no window copy, no payload work. Safe to retain
	 * across applies: a later apply builds the next revision's manifest, it
	 * can never mutate this one.
	 */
	manifest(): ContextManifest {
		return (this.manifestCache ??= deepFreeze(toManifest(this.state)));
	}

	/** Resume capsule for the current fold position (self-contained: carries the compaction mark). */
	capsule(): ResumeCapsule {
		return {
			head: this.state.head,
			firstKeptEntryId: this.state.compaction?.firstKeptEntryId ?? null,
			compaction: this.state.compaction === null ? null : { ...this.state.compaction },
			usageAnchor: this.state.usageAnchor,
			appliedSeq: this.lastSeq,
			...(isUsageEmpty(this.state.usage) ? {} : { usage: this.state.usage }),
			...(this.state.editCount > 0 ? { editCount: this.state.editCount } : {}),
		};
	}

	/**
	 * Identity of the current committed projection state (C2 output): the
	 * address a {@link snapshot} is taken at. Two services that folded the
	 * same log produce equal revisions.
	 */
	revision(identity: { readonly conversationId: string; readonly rootId: string }): ProjectionRevision {
		return {
			conversationId: identity.conversationId,
			rootId: identity.rootId,
			head: this.state.head,
			watermark: { ...this.state.watermark },
			schemaVersion: PROJECTION_SCHEMA_VERSION,
			editVersion: this.state.editCount,
			windowBytes: this.state.windowBytes,
		};
	}

	/**
	 * C3: the ONE immutable snapshot for a logical provider request, taken at
	 * the current revision. Deep-frozen: commits applied after the snapshot
	 * (concurrent input, a compaction) land as the NEXT revision and can
	 * never mutate this one — call once per logical request and resend the
	 * same object on retry.
	 */
	snapshot(options: {
		readonly conversationId: string;
		readonly rootId: string;
		readonly requestId: string;
		readonly sessionId: string;
		readonly route?: RequestSnapshotRoute | null;
		readonly createdAtMs?: number;
	}): RequestSnapshot {
		return buildRequestSnapshot({
			conversationId: options.conversationId,
			rootId: options.rootId,
			requestId: options.requestId,
			sessionId: options.sessionId,
			// The revision's frozen manifest cache: a same-head snapshot (a
			// retry resending the same revision) reuses it without copying
			// the window; buildRequestSnapshot shares its already-frozen
			// segment array instead of re-copying it.
			manifest: this.manifest(),
			editVersion: this.state.editCount,
			route: options.route,
			createdAtMs: options.createdAtMs,
		});
	}

	/**
	 * LLM context view: the manifest segments — audit/control (`mcode.*`)
	 * entries never become segments, so the kind filter holds by construction.
	 */
	llmSegments(): readonly Segment[] {
		return this.state.segments.toArray();
	}

	/**
	 * Residency-aware LLM context: materializes every non-resident page through
	 * the policy's `onFault`. With the default all-resident behavior (no policy)
	 * this resolves to {@link llmSegments} without any fault.
	 */
	async llmContext(): Promise<readonly Segment[]> {
		if (this.residency === undefined) {
			return this.llmSegments();
		}
		const pages: Segment[] = [];
		for (const segment of this.state.segments.toArray()) {
			pages.push(this.residency.resident(segment.entryId) ? segment : await this.residency.onFault(segment.entryId));
		}
		return pages;
	}

	/** Whether the page for this entry id is resident (default: always). */
	resident(entryId: string): boolean {
		return this.residency === undefined ? true : this.residency.resident(entryId);
	}

	/**
	 * Materializes the segment for an entry id: through the policy's `onFault`
	 * when a policy is installed, otherwise locally from the manifest (throws
	 * {@link ProjectionError} for an unknown id).
	 */
	async fault(entryId: string): Promise<Segment> {
		if (this.residency !== undefined) {
			return this.residency.onFault(entryId);
		}
		const index = this.state.segments.findIndex((candidate) => candidate.entryId === entryId);
		const segment = index < 0 ? undefined : this.state.segments.get(index);
		if (segment === undefined) {
			throw new ProjectionError(`no resident segment for entry ${JSON.stringify(entryId)}`);
		}
		return segment;
	}
}
