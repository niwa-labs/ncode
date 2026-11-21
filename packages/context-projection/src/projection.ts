// Context manifest: the derived view over the durable delta log.
//
// `buildProjection` is a left fold over entries in log order — no leaf→root
// walk of any entry graph. The same single `foldEntry` step drives both the
// one-shot fold and the incremental {@link ProjectionService}, so applying N
// commits incrementally yields a manifest structurally equal to a full
// rebuild over the whole log by construction; the equivalence is still pinned
// by a dedicated unit test.

// Types come straight from the backend's `src/types.ts` — the module the
// wave-1 contract pins — rather than through the package's `.` export,
// because the export's `import` condition resolves to `dist/index.js`, which
// does not exist until the integrator builds the workspace (and its `index.ts`
// would also drag `backend.ts` into the program). Switching to the package
// specifier is a two-line change once `dist/` exists.

import { createLogger } from '@mavis/logging';

import type { Entry, Seq } from '../../durable-backend-sqlite-zstd/src/types.js';
import { SEQ_AT_START } from '../../durable-backend-sqlite-zstd/src/types.js';

import {
	COMPACTION_KIND,
	CONTEXT_EDIT_KIND,
	USAGE_KIND,
	asCompactionPayload,
	asContextEditPayload,
	asUsagePayload,
	isControlKind,
} from './kinds.js';
import {
	EMPTY_USAGE,
	type UsageFold,
	inlineAssistantUsage,
	isUsageEmpty,
	isZeroUsageDelta,
	withUsageDelta,
} from './usage.js';
import { ChunkedView, projectionPerf } from './window.js';

const log = createLogger('mcode:projection');

/** Error raised when a log slice violates the projection contract. */
export class ProjectionError extends Error {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'ProjectionError';
	}
}

/** The branded start-of-log sequence, as the backend's `SEQ_AT_START` constant. */
const SEQ_AT_LOG_START = SEQ_AT_START as Seq;

/**
 * One LLM-visible context page of the manifest.
 *
 * Segments are handles, not content: the projection never holds entry
 * payloads, only their identity, discriminator and size. `entryId` is the
 * `Entry.id` of the source entry (the durable backend names it `id`; the
 * manifest vocabulary calls it `entryId`). `byteLen` measures the EFFECTIVE
 * model-visible payload: the stored payload bytes, or the replacement
 * content bytes while a replacement edit wins over the entry.
 */
export interface Segment {
	/** `Entry.id` of the entry this segment was derived from. */
	readonly entryId: string;
	/** UTF-8 byte length of the effective (stored or replacement) payload JSON. */
	readonly byteLen: number;
	/** Entry kind, verbatim from the log. */
	readonly kind: string;
}

/** Compaction mark recorded in the manifest. */
export interface CompactionMark {
	/** Summary standing in for the context dropped by the compaction. */
	readonly summary: string;
	/**
	 * Entry id of the first entry still kept as a segment after the cut;
	 * `null` for a retain-none checkpoint (every segment was cut).
	 */
	readonly firstKeptEntryId: string | null;
	/**
	 * The frozen prompt state the checkpoint carries (V-C09): legacy prompt
	 * text, `null` (retain-none / none frozen), or the full frozen
	 * SystemMessage. Present only when the writer recorded one — consumers
	 * seed the transcript fold from it
	 * (`convert-to-llm` `transcriptStateFromCheckpoint`).
	 */
	readonly systemMessage?: string | null | import('./kinds.js').FrozenCompactionSystemMessage;
}

/**
 * The winning edit of one target, exposed by the manifest's `edits` record:
 * which `mcode.context_edit` entry currently owns the target's contribution
 * and whether it replaces or omits it. Per-target newest-edit-wins (both pi
 * projectors agree); consumers keying caches off the projection get one
 * addressable edit revision instead of diffing segment lists.
 */
export interface WinningEdit {
	/** `Entry.id` of the winning `mcode.context_edit` entry. */
	readonly editEntryId: string;
	/** `replace` — content substituted; `omit` — target hidden from the window. */
	readonly action: 'replace' | 'omit';
}

/**
 * One window member, fold-internal: the ORIGINAL segment handle plus the
 * edit state that currently hides or rewrites it. Slots keep log order and
 * remember hidden members, which is what makes pi's newest-edit-wins
 * semantics foldable incrementally: a replacement arriving after an omission
 * resurrects the target at its original window position without re-reading
 * the log. Slots below a compaction cut are dropped with the window, so slot
 * memory stays bounded by the derived window plus its live edits.
 */
interface SegmentSlot {
	/** Original handle of the source entry (`byteLen` = stored payload bytes). */
	readonly segment: Segment;
	/** Log position of the source entry; fixes the member's window order. */
	readonly position: LogPosition;
	/** Winning edit, `null` while the member was never edited. */
	readonly edit: WinningEdit | null;
	/**
	 * EFFECTIVE bytes: the stored payload bytes, or the replacement content
	 * bytes while a replacement edit wins. Hidden members keep their last
	 * effective value for the window-byte arithmetic on resurrect/re-cut.
	 */
	readonly byteLen: number;
}

/** Position of one entry in the log: batch sequence plus ordinal inside the batch. */
export interface LogPosition {
	readonly seq: Seq;
	readonly ordinal: number;
}

/** Watermark of the projection: the log position the fold has caught up to. */
export type Watermark = LogPosition;

/** Watermark of a projection over an empty log: before the first commit (`SEQ_AT_START`, no ordinal). */
export const WATERMARK_AT_START: Watermark = { seq: SEQ_AT_LOG_START, ordinal: -1 };

/** The full derived context view; equal by construction to any incremental application. */
export interface ContextManifest {
	/**
	 * Log head the fold has caught up to: the `seq` of the last folded entry,
	 * `SEQ_AT_START` over an empty log. For the `sqlite-zstd` backend this is
	 * always equal to the last commit's `head` (`Commit.head === Commit.seq`).
	 */
	readonly head: Seq;
	/** LLM-visible context pages in log order; audit/control (`mcode.*`) entries never appear here. */
	readonly segments: readonly Segment[];
	/**
	 * Σ `byteLen` over {@link segments} — the byte size of the projection
	 * WINDOW, maintained incrementally (O(delta) per commit; a compaction
	 * subtracts the cut prefix). This is the byte truth the compaction
	 * trigger's byte axis consumes; it is NOT the provider payload size (the
	 * wire compiler's `CompiledBody.totalBytes` measures the normalized
	 * segments actually sent).
	 */
	readonly windowBytes: number;
	/** Last compaction applied to the context, if any; later compactions replace earlier ones. */
	readonly compaction?: CompactionMark;
	/**
	 * `entryId` of the last applied LLM-visible entry — the anchor usage
	 * accounting resumes from. Never regresses, even when a compaction cuts the
	 * anchored entry's segment; `null` before the first LLM-visible entry.
	 */
	readonly usageAnchor: string | null;
	/**
	 * Winning edit per edited target (`targetId → WinningEdit`), omitted while
	 * no edit has been applied. Per-target newest-edit-wins, pi 1.3 semantics.
	 */
	readonly edits?: Readonly<Record<string, WinningEdit>>;
	/**
	 * Persisted usage fold of `mcode.usage` entries, omitted while empty.
	 * Totals survive compaction (spend does not disappear when context is cut).
	 */
	readonly usage?: UsageFold;
	/** Exact log position (seq, ordinal) the fold has caught up to. */
	readonly watermark: Watermark;
}

/** The immutable fold state shared by the one-shot fold and the incremental service. */
export interface ProjectionState {
	readonly head: Seq;
	readonly watermark: Watermark;
	/**
	 * LLM-visible segments in log order — a persistent chunked view whose
	 * `append` is O(1) amortized refs (no W-copy per entry, plan §2.7);
	 * compaction cuts and context edits rewrite it as their paid O(W)
	 * invalidation. Materialize with `toArray()`.
	 */
	readonly segments: ChunkedView<Segment>;
	/**
	 * Every window member in log order — visible plus edit-hidden — carrying
	 * each member's winning edit. `segments` is exactly the non-hidden
	 * projection of `slots`; both are maintained by the same single
	 * `foldEntry` step so the two can never disagree.
	 */
	readonly slots: ChunkedView<SegmentSlot>;
	/** Σ effective `byteLen` over the visible slots (`segments`); maintained incrementally by {@link foldEntry}. */
	readonly windowBytes: number;
	readonly compaction: CompactionMark | null;
	readonly usageAnchor: string | null;
	/** Persisted usage fold (per `provider/model` and per category). */
	readonly usage: UsageFold;
	/**
	 * `mcode.context_edit` entries folded so far — inert ones included. A
	 * monotone edit-revision counter: any change of it invalidates results
	 * derived from an earlier revision (safe to over-invalidate).
	 */
	readonly editCount: number;
}

/** Fold state over an empty log. */
export const EMPTY_STATE: ProjectionState = {
	head: SEQ_AT_LOG_START,
	watermark: WATERMARK_AT_START,
	segments: ChunkedView.empty(),
	slots: ChunkedView.empty(),
	windowBytes: 0,
	compaction: null,
	usageAnchor: null,
	usage: EMPTY_USAGE,
	editCount: 0,
};

/** UTF-8 byte length of the canonical JSON serialization of a payload. */
function payloadByteLen(entry: Entry): number {
	projectionPerf.payloadBytesMeasured += 1;
	return Buffer.byteLength(JSON.stringify(entry.payload), 'utf8');
}

/** UTF-8 byte length of a replacement content's canonical JSON (the edited member's effective payload). */
function contentByteLen(content: string | readonly unknown[]): number {
	projectionPerf.payloadBytesMeasured += 1;
	return Buffer.byteLength(JSON.stringify(content), 'utf8');
}

/** The visible segment of a slot: original handle, or the replacement-sized handle while a replacement wins. */
function effectiveSegment(slot: SegmentSlot): Segment {
	if (slot.edit?.action === 'replace') {
		return { entryId: slot.segment.entryId, byteLen: slot.byteLen, kind: slot.segment.kind };
	}
	return slot.segment;
}

/** Recomputes the visible segments and window bytes from the slots in one O(slots) pass. */
function projectSlots(slots: ChunkedView<SegmentSlot>): {
	segments: ChunkedView<Segment>;
	windowBytes: number;
} {
	const segments: Segment[] = [];
	let windowBytes = 0;
	for (const slot of slots.toArray()) {
		if (slot.edit?.action === 'omit') continue;
		const segment = effectiveSegment(slot);
		segments.push(segment);
		windowBytes += slot.byteLen;
	}
	return { segments: ChunkedView.from(segments), windowBytes };
}

/**
 * Applies one edit to the slot list: returns fresh slots with the target's
 * winning edit set, or `undefined` when the target is not a window member
 * (inert — the pi projectors apply an edit only when its target is projected).
 * The rewrite is the edit's explicitly paid O(W) invalidation (plan §2.7).
 */
function editSlot(
	slots: ChunkedView<SegmentSlot>,
	targetId: string,
	edit: WinningEdit,
	replacementByteLen: number | null,
): ChunkedView<SegmentSlot> | undefined {
	const index = slots.findIndex((slot) => slot.segment.entryId === targetId);
	if (index < 0) return undefined;
	const materialized = slots.toArray();
	const target = materialized[index]!;
	materialized[index] = {
		segment: target.segment,
		position: target.position,
		edit,
		byteLen: replacementByteLen ?? target.byteLen,
	};
	return ChunkedView.from(materialized);
}

/**
 * Whether `(seq, ordinal)` strictly advances over `previous` in log order:
 * ascending `seq` may start at any ordinal — a projection slice may begin
 * mid-batch (e.g. a resume from a capsule) — while ordinals inside one batch
 * must be contiguous.
 */
function advancesLogPosition(previous: LogPosition, seq: Seq, ordinal: number): boolean {
	return seq > previous.seq || (seq === previous.seq && ordinal === previous.ordinal + 1);
}

/**
 * Folds ONE entry into the state. This is the single definition of the
 * projection semantics; both `buildProjection` and `ProjectionService.apply`
 * go through it, which is what makes incremental application identical to a
 * full rebuild.
 *
 * - LLM-visible entries append one segment and advance the usage anchor.
 * - `mcode.*` audit/control entries never become segments; the control kinds
 *   additionally rewrite the derived view (compaction cut, context edits,
 *   usage accumulation).
 * - Every entry advances the watermark and the head.
 */
export function foldEntry(state: ProjectionState, entry: Entry): ProjectionState {
	if (!advancesLogPosition(state.watermark, entry.seq, entry.ordinal)) {
		throw new ProjectionError(
			`entry ${entry.id} (seq ${entry.seq}, ordinal ${entry.ordinal}) does not advance ` +
				`the log position (seq ${state.watermark.seq}, ordinal ${state.watermark.ordinal}): ` +
				'entries must be in ascending (seq, ordinal) order and contiguous within a batch',
		);
	}

	const base: ProjectionState = {
		head: entry.seq,
		watermark: { seq: entry.seq, ordinal: entry.ordinal },
		segments: state.segments,
		slots: state.slots,
		windowBytes: state.windowBytes,
		compaction: state.compaction,
		usageAnchor: state.usageAnchor,
		usage: state.usage,
		editCount: state.editCount,
	};

	if (!isControlKind(entry.kind)) {
		const byteLen = payloadByteLen(entry);
		const segment: Segment = { entryId: entry.id, byteLen, kind: entry.kind };
		const slot: SegmentSlot = { segment, position: base.watermark, edit: null, byteLen };
		// pi billing shape (a): an assistant message carries its provider usage
		// INLINE (usage-totals reads it off the message, keyed
		// `provider/responseModel ?? model`). There is no `mcode.usage` mirror
		// for assistant spend, so the fold reads it here — never moving the
		// usage anchor (that is the CONTEXT axis, this is the BILLING axis),
		// never touching `categories` (writer-defined kinds are the explicit
		// `mcode.usage` contract), and skipping zero/corrupt blocks (render
		// parity with pi's zero-row filter; a corrupt block must not NaN the
		// totals).
		const inline = inlineAssistantUsage(entry.payload);
		const usage =
			inline !== undefined && !isZeroUsageDelta(inline.delta)
				? {
						models: withUsageDelta(state.usage.models, inline.key, inline.delta),
						categories: state.usage.categories,
					}
				: state.usage;
		return {
			...base,
			// Persistent appends: O(1) amortized refs each — no W-copy per entry.
			segments: state.segments.append(segment),
			slots: state.slots.append(slot),
			windowBytes: state.windowBytes + byteLen,
			usageAnchor: entry.id,
			usage,
		};
	}

	// Audit/control entry: filtered out of the LLM context; only the control
	// kinds rewrite the derived view. Every rewrite operates on the cached
	// slots alone — O(window), never a re-fold of the log.
	switch (entry.kind) {
		case COMPACTION_KIND: {
			const { summary, firstKeptEntryId, systemMessage } = asCompactionPayload(entry.payload, entry.id);
			// pi spells retain-none as the compaction's own id (`firstKeptEntryId ?? id`);
			// null is the explicit local spelling. Both cut every member.
			const retainNone = firstKeptEntryId === null || firstKeptEntryId === entry.id;
			let keptSlots: ChunkedView<SegmentSlot>;
			if (retainNone) {
				keptSlots = ChunkedView.empty();
			} else {
				const cutIndex = state.slots.findIndex(
					(slot) => slot.segment.entryId === firstKeptEntryId,
				);
				if (cutIndex < 0) {
					throw new ProjectionError(
						`mcode.compaction entry ${entry.id}: firstKeptEntryId ${JSON.stringify(firstKeptEntryId)} ` +
							'is not a member of the current context window',
					);
				}
				keptSlots = ChunkedView.from(state.slots.toArray().slice(cutIndex));
			}
			const { segments, windowBytes } = projectSlots(keptSlots);
			return {
				...base,
				segments,
				slots: keptSlots,
				windowBytes,
				compaction: {
					summary,
					firstKeptEntryId: retainNone ? null : firstKeptEntryId,
					// `null` (retain-none) carries no replay value — the
					// transcript seed from null equals the absent-field
					// reading — so the mark stays minimal, like the pin
					// writer that omits the field when there is none.
					...(systemMessage !== undefined && systemMessage !== null ? { systemMessage } : {}),
				},
			};
		}
		case CONTEXT_EDIT_KIND: {
			const payload = asContextEditPayload(entry.payload, entry.id);
			if ('action' in payload) {
				// Omission variant (the `@mavis/context-compaction` format): hide
				// whatever targets are window members; targets already gone (cut
				// by a compaction, pruned, or never projected) stay hidden
				// without raising — the writer cannot know the fold's exact
				// window when it records the retraction.
				let slots: ChunkedView<SegmentSlot> | undefined;
				for (const targetId of payload.targetIds) {
					slots = editSlot(slots ?? state.slots, targetId, { editEntryId: entry.id, action: 'omit' }, null) ??
						slots;
				}
				if (slots === undefined) return base;
				const { segments, windowBytes } = projectSlots(slots);
				return { ...base, segments, slots, windowBytes, editCount: state.editCount + 1 };
			}
			if ('targetId' in payload) {
				// pi replacement variant: per-target newest-edit-wins. A
				// replacement resurrects a previously omitted target at its
				// original window position; `replacement: null` omits it. A
				// target outside the window is INERT — the pi projectors apply
				// an edit only when its target is projected.
				const winning: WinningEdit = {
					editEntryId: entry.id,
					action: payload.replacement === null ? 'omit' : 'replace',
				};
				const byteLen = payload.replacement === null ? null : contentByteLen(payload.replacement.content);
				const slots = editSlot(state.slots, payload.targetId, winning, byteLen);
				if (slots === undefined) return base;
				const { segments, windowBytes } = projectSlots(slots);
				return { ...base, segments, slots, windowBytes, editCount: state.editCount + 1 };
			}
			const { removedEntryIds } = payload;
			// Strict prune variant: asserts exact knowledge of the VISIBLE
			// window — an unknown id is a contract breach. Pruning removes the
			// members outright (not hides them): a later pi edit of a pruned id
			// is inert, because the member no longer exists to resurrect.
			const removed = new Set(removedEntryIds);
			const visible = state.segments.toArray();
			const kept = visible.filter((segment) => !removed.has(segment.entryId));
			if (kept.length + removed.size !== visible.length) {
				const known = new Set(visible.map((segment) => segment.entryId));
				const unknown = removedEntryIds.filter((id) => !known.has(id));
				throw new ProjectionError(
					`mcode.context_edit entry ${entry.id}: removedEntryIds not in the current context: ` +
						unknown.map((id) => JSON.stringify(id)).join(', '),
				);
			}
			if (removedEntryIds.length === 0) {
				return base;
			}
			const slots = ChunkedView.from(
				state.slots.toArray().filter((slot) => !removed.has(slot.segment.entryId)),
			);
			const { segments, windowBytes } = projectSlots(slots);
			return { ...base, segments, slots, windowBytes, editCount: state.editCount + 1 };
		}
		case USAGE_KIND: {
			// Usage never enters the LLM context and never moves the usage
			// anchor; it folds into the persisted totals (which survive a
			// later compaction) under both pi axes: `provider/model` and the
			// writer-defined category. A delta with no counters and no cost
			// leaves the fold untouched — pi's rendered billing drops such
			// buckets, so the fold must not materialize them either.
			const { kind, provider, model, usage } = asUsagePayload(entry.payload, entry.id);
			if (isZeroUsageDelta(usage)) return base;
			return {
				...base,
				usage: {
					models: withUsageDelta(state.usage.models, `${provider}/${model}`, usage),
					categories: withUsageDelta(state.usage.categories, kind, usage),
				},
			};
		}
		default:
			// Plain audit entry: observed by the watermark only.
			return base;
	}
}

/** Folds a whole log-order slice of entries from the empty state. */
export function foldAll(entries: readonly Entry[]): ProjectionState {
	let state = EMPTY_STATE;
	for (const entry of entries) {
		state = foldEntry(state, entry);
	}
	return state;
}

/** Freezes a fold state into the public manifest shape (fresh arrays, optional compaction/edits/usage keys). */
export function toManifest(state: ProjectionState): ContextManifest {
	const manifest: { -readonly [K in keyof ContextManifest]: ContextManifest[K] } = {
		head: state.head,
		segments: state.segments.toArray(),
		windowBytes: state.windowBytes,
		usageAnchor: state.usageAnchor,
		watermark: { ...state.watermark },
	};
	if (state.compaction !== null) {
		manifest.compaction = { ...state.compaction };
	}
	if (state.editCount > 0) {
		// Winning edit per edited target, in slot (log) order — deterministic,
		// so incremental application stays byte-equal to a full rebuild.
		const edits: Record<string, WinningEdit> = {};
		for (const slot of state.slots.toArray()) {
			if (slot.edit !== null) edits[slot.segment.entryId] = { ...slot.edit };
		}
		manifest.edits = edits;
	}
	if (!isUsageEmpty(state.usage)) {
		manifest.usage = { models: { ...state.usage.models }, categories: { ...state.usage.categories } };
	}
	return manifest;
}

/**
 * Projects a whole slice of entries into a {@link ContextManifest} with one
 * left fold — no leaf→root traversal of an entry graph. The slice must be in
 * ascending log order (contiguous within each batch); the fold rejects any
 * position that does not strictly advance.
 */
export function buildProjection(entries: readonly Entry[]): ContextManifest {
	const startedAtMs = Date.now();
	const state = foldAll(entries);
	log.debug('projection built', {
		entries: entries.length,
		segments: state.segments.size,
		windowBytes: state.windowBytes,
		durationMs: Date.now() - startedAtMs,
	});
	return toManifest(state);
}
