/**
 * Adapter between the storage worker's `Entry`/`Commit` contract and the
 * `sqlite-zstd` durable backend's `EntryDraft`/`Commit` surface.
 *
 * The two packages declare different (documented) shapes: the worker speaks
 * `Entry = { entryId, parentId, kind, payload, bytes }` and `Commit =
 * { batchId: string, seq, head: string }`, while the backend accepts
 * `EntryDraft = { id, parentId?, kind, payload }` and answers with a commit
 * whose `batchId`/`head` are branded numbers. This module is the single
 * shipped reconciliation point:
 *
 * - `toEntryDraft` maps an `Entry` onto a draft, preserving `parentId` inside
 *   the stored frame and computing the real serialized size;
 * - `entryDraftSizeBytes` measures a draft exactly as the backend will store
 *   it (UTF-8 `JSON.stringify`);
 * - `commitFromSqliteZstd` maps the backend commit onto the worker commit;
 * - `sqliteZstdStorageBackend` wraps a backend instance into the
 *   `StorageWorkerBackend` seam and guarantees the backend's uncompressed
 *   batch cap by SPLITTING oversized batches (bisect over once-measured
 *   serialized sizes — no re-stringify per bisection level), instead of
 *   letting the backend reject a 257 KiB batch that the worker's byte window
 *   believed to be exactly 256 KiB.
 *
 * The wrapper is the package's SINGLE split/replay implementation (the
 * off-thread worker thread reuses it; it duplicates nothing): entry ids it
 * already committed are skipped on retry, so a crash (or quarantine of the
 * tail half) never duplicates the committed prefix. A draft's id is recorded
 * in `committedIds` only AFTER its sub-batch committed, and a failed split
 * never un-marks the committed prefix — a worker retry therefore re-appends
 * exactly the failed suffix. As a backstop against bookkeeping that missed
 * (for example a second adapter instance over the same backend), the backend's
 * duplicate-insert refusal (`DuplicateEntryError`, or the raw sqlite
 * entry-id constraint message) is treated as idempotent success: the range is
 * bisected entry-by-entry and already-durable ids are filtered as success.
 *
 * A split flush returns ONE commit covering the whole appended range — `seq`
 * of the first sub-batch, `head` of the last (IC-F1-006) — so a resume cursor
 * anchored at the returned commit (`readDelta(commit.seq)`) can never skip a
 * middle sub-batch; re-reading from the first sub-batch's seq only re-serves
 * entries the reader already has (idempotent by entry id).
 *
 * This module is loadable by raw Node inside `node:worker_threads` (its
 * runtime imports are builtin-only, like `engine.ts`), which is what lets the
 * off-thread worker share this implementation instead of inlining a copy.
 *
 * Everything is structural: this module imports nothing from the backend
 * package, and the worker stays dependency-free.
 *
 * @module
 */

import { Buffer } from 'node:buffer';

import { createLogger } from '@mavis/logging';

import type { Commit, Entry, StorageWorkerBackend } from './contracts.js';
import { EntryTooLargeError, isDuplicateEntryError } from './errors.ts';

/** Same namespace as the worker (spec §4); the adapter is its write seam. */
const log = createLogger('mcode:worker');

/** Default cap, mirroring `MAX_BATCH_UNCOMPRESSED_BYTES` of the backend. */
export const SQLITE_ZSTD_BATCH_CAP_BYTES = 256 * 1024;

/** Entry draft shape accepted by `SqliteZstdBackend.appendBatch`. */
export interface SqliteZstdEntryDraft {
	readonly id: string;
	/** Preserved inside the stored frame; the backend does not index it. */
	readonly parentId?: string | null;
	readonly kind: string;
	readonly payload: unknown;
}

/** Commit subset the adapter needs from the backend. */
export interface SqliteZstdCommitLike {
	readonly batchId: number | string;
	readonly seq: number;
	readonly head: number;
}

/** Structural surface of `SqliteZstdBackend` the adapter drives. */
export interface SqliteZstdBackendLike {
	appendBatch(drafts: readonly SqliteZstdEntryDraft[]): Promise<SqliteZstdCommitLike>;
	checkpoint?(): Promise<unknown> | unknown;
	/** The backend's own uncompressed batch cap, when it exposes it. */
	readonly maxBatchUncompressedBytes?: number;
}

export interface SqliteZstdAdapterOptions {
	/**
	 * Uncompressed batch cap the adapter enforces by splitting. Defaults to
	 * the backend instance's `maxBatchUncompressedBytes`, falling back to the
	 * backend default (256 KiB). `0` disables splitting (backend caps disabled
	 * too, matching its semantics).
	 */
	readonly maxBatchUncompressedBytes?: number;
}

/** Maps one worker entry onto the backend draft, preserving `parentId`. */
export function toEntryDraft(entry: Entry): SqliteZstdEntryDraft {
	return {
		id: entry.entryId,
		parentId: entry.parentId,
		kind: entry.kind,
		payload: entry.payload,
	};
}

/**
 * Serialized size of one draft, measured exactly as the backend stores it
 * (UTF-8 bytes of `JSON.stringify`), never the caller-declared `entry.bytes`.
 */
export function entryDraftSizeBytes(draft: SqliteZstdEntryDraft): number {
	return Buffer.byteLength(JSON.stringify(draft), 'utf8');
}

/** Maps the backend's branded numeric commit onto the worker's string commit. */
export function commitFromSqliteZstd(commit: SqliteZstdCommitLike): Commit {
	return {
		batchId: String(commit.batchId),
		seq: commit.seq,
		head: String(commit.head),
	};
}

/**
 * Wraps a `SqliteZstdBackend` (or anything structurally identical) into the
 * storage worker's backend seam. Batch appends are split, post-stringify, so
 * the backend's uncompressed cap can never reject a batch the worker already
 * accepted; a single entry that still does not fit raises
 * {@link EntryTooLargeError}, which the worker treats as poison.
 */
export function sqliteZstdStorageBackend(
	backend: SqliteZstdBackendLike,
	options: SqliteZstdAdapterOptions = {},
): StorageWorkerBackend {
	const cap = resolveCap(backend, options.maxBatchUncompressedBytes);
	// Entry ids this adapter instance already committed; makes split appends
	// idempotent under worker retries after a partial split failure.
	const committedIds = new Set<string>();
	// Byte-size fingerprint per committed id. Review round 1: entry ids are
	// content-addressed for full-state entries, but append ids hash only the
	// message id, and two generation branches (worktree-reminder, preserved
	// display-user messages) can reuse an id for DIFFERENT content. A no-op
	// replay must therefore confirm the payload SIZE matches what this
	// adapter committed under that id — a mismatch is a same-id-different-
	// content conflict and stays a loud error.
	const committedBytes = new Map<string, number>();
	// Last commit this adapter returned. An idempotent no-op replay (every id
	// already committed below) resolves with it, so a retried caller's cursor
	// lands on a real committed sequence instead of an error.
	const last = { commit: null as Commit | null };

		const checkpoint = backend.checkpoint;
		return {
			appendBatch: async (entries: Entry[]) => {
				if (entries.length === 0) {
					// Keep the backend's empty-batch contract visible at the seam.
					throw new TypeError('batch must contain at least one entry');
				}
				const drafts = entries.map(toEntryDraft).filter((draft) => {
					// Skip ids committed by an earlier partial split: the worker retry
					// re-runs the WHOLE batch, and re-appending a committed id would
					// die on the backend's `entries.entry_id` primary key. A committed
					// id with a DIFFERENT payload size is not a replay — it is a
					// same-id-different-content conflict and must stay loud.
					const known = committedBytes.get(draft.id);
					if (known !== undefined && known !== entryDraftSizeBytes(draft)) {
						throw new SqliteZstdAdapterStateError(
							`entry ${draft.id} replayed with a different payload size (${entryDraftSizeBytes(draft)} vs committed ${known}); refusing the idempotent no-op`,
						);
					}
					return !committedIds.has(draft.id);
				});
				if (drafts.length === 0) {
					// Idempotent replay: every id of this batch was already committed
					// by this adapter (content-addressed ids ⇒ identical content).
					// Treating this as an error poisoned the worker retry loop — the
					// re-adopt of an unchanged full-state batch hit failureStreak and
					// was quarantined, freezing the session's history. Resolve as a
					// no-op success on the last real commit instead.
					const noop = idempotentNoopCommit(backend, last.commit);
					if (noop !== null) return noop;
					throw new SqliteZstdAdapterStateError(
						`all ${entries.length} entries of the batch are already committed by this adapter, and no prior commit is known to report a no-op cursor`,
					);
				}
				last.commit = await appendWithinUncompressedCap(backend, drafts, cap, committedIds, committedBytes, last);
				return last.commit;
			},
			checkpoint: checkpoint
				? async () => {
						await checkpoint.call(backend);
					}
				: undefined,
		};
}

/**
 * Cursor for an idempotent no-op append (nothing written). Prefers the last
 * commit this adapter returned — it points at a real committed sequence this
 * instance produced; falls back to the backend's exposed head (the log's last
 * committed sequence) when the duplicates were committed through this adapter
 * only via the duplicate backstop (another instance wrote them first).
 * `null` only when neither source exists — the caller keeps its loud error.
 */
function idempotentNoopCommit(
	backend: SqliteZstdBackendLike,
	lastCommit: Commit | null,
): Commit | null {
	if (lastCommit !== null) {
		return lastCommit;
	}
	const head = (backend as { readonly head?: number }).head;
	if (typeof head === 'number' && head > 0) {
		return { batchId: 'idempotent-noop', seq: head, head: String(head) };
	}
	return null;
}

/** Raised when the adapter's replay bookkeeping is asked to do nothing. */
export class SqliteZstdAdapterStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SqliteZstdAdapterStateError';
	}
}

function resolveCap(backend: SqliteZstdBackendLike, explicit: number | undefined): number {
	if (explicit !== undefined) return explicit;
	if (backend.maxBatchUncompressedBytes !== undefined) return backend.maxBatchUncompressedBytes;
	return SQLITE_ZSTD_BATCH_CAP_BYTES;
}

/**
 * Appends drafts within the uncompressed cap, bisecting over once-measured
 * serialized sizes when the whole range does not fit (DS-B1: every draft is
 * stringified exactly once per `appendBatch` call — bisection levels work on
 * the cached sizes, never re-stringify).
 *
 * Returns ONE commit covering the whole appended range: `seq` of the first
 * sub-batch committed by THIS call, `head` of the last (IC-F1-006) — so the
 * caller's resume cursor never skips a middle sub-batch. A sub-range whose
 * entries all turned out already durable (duplicate backstop below) is
 * skipped; if EVERY entry was already durable the caller gets a loud
 * `SqliteZstdAdapterStateError` instead of a fabricated commit.
 *
 * Replay safety (IC-F1-005 / SW-01 / OPT-H4): a draft's id is recorded in
 * `committedIds` only AFTER its sub-batch committed. A failure mid-split
 * leaves the committed prefix marked and the failed suffix unmarked, so a
 * worker retry skips exactly the prefix and re-appends exactly the suffix —
 * never the reverse (which would die on the backend's entry-id primary key
 * and mask the original error). And if the backend reports a duplicate
 * anyway (a missed bookkeeping, another adapter instance on the same
 * backend), the duplicate-insert refusal is consumed as idempotent success:
 * the range is bisected entry-by-entry and durable ids are filtered out.
 */
async function appendWithinUncompressedCap(
	backend: SqliteZstdBackendLike,
	drafts: readonly SqliteZstdEntryDraft[],
	cap: number,
	committedIds: Set<string>,
	committedBytes: Map<string, number>,
	last: { commit: Commit | null },
): Promise<Commit> {
	const sizes = drafts.map((draft) => entryDraftSizeBytes(draft));
	const commit = await appendRange(backend, drafts, sizes, 0, drafts.length, cap, committedIds, committedBytes);
	if (commit === null) {
		// The duplicate backstop consumed every entry as already durable (the
		// ids were committed through another adapter instance over the same
		// backend). Content-addressed ids make this an idempotent replay, not
		// a conflict — resolve as a no-op (same reasoning as the committedIds
		// fast path above) instead of poisoning the worker retry loop.
		const noop = idempotentNoopCommit(backend, last.commit);
		if (noop !== null) return noop;
		throw new SqliteZstdAdapterStateError(
			`all ${drafts.length} entries of the batch are already committed by this adapter, and no no-op cursor source exists`,
		);
	}
	return commit;
}

/** Combines two range commits into one covering both: first seq, last head. */
function combineRangeCommits(left: Commit | null, right: Commit | null): Commit | null {
	if (left !== null && right !== null) {
		return { batchId: right.batchId, seq: left.seq, head: right.head };
	}
	return right ?? left;
}

async function appendRange(
	backend: SqliteZstdBackendLike,
	drafts: readonly SqliteZstdEntryDraft[],
	sizes: readonly number[],
	start: number,
	end: number,
	cap: number,
	committedIds: Set<string>,
	committedBytes: Map<string, number>,
): Promise<Commit | null> {
	if (start >= end) return null;
	let serializedBytes = 0;
	for (let index = start; index < end; index += 1) serializedBytes += sizes[index]!;
	if (cap <= 0 || serializedBytes <= cap) {
		const slice = drafts.slice(start, end);
		try {
			const commit = commitFromSqliteZstd(await backend.appendBatch(slice));
			// Marked only after success: a throw here must leave the suffix
			// unmarked so the retry re-appends exactly it.
			for (const draft of slice) {
					committedIds.add(draft.id);
					committedBytes.set(draft.id, entryDraftSizeBytes(draft));
				}
			return commit;
		} catch (error) {
			if (!isDuplicateEntryError(error)) throw error;
			if (end - start === 1) {
				// The single entry is already durable (missed bookkeeping or a
				// second adapter instance over the same backend): idempotent
				// success, not a wedge (SW-04).
				log.warn('duplicate insert consumed as idempotent success', { entryId: drafts[start]!.id });
				committedIds.add(drafts[start]!.id);
				committedBytes.set(drafts[start]!.id, sizes[start]!);
				return null;
			}
			// Some entries of this range are already durable: bisect further to
			// isolate them entry by entry.
		}
	} else if (end - start === 1) {
		// Poison entry (spec §5 warn): no batch can ever take it.
		log.warn('entry exceeds the batch cap in every split', {
			entryId: drafts[start]!.id,
			bytes: serializedBytes,
			cap,
		});
		throw new EntryTooLargeError(drafts[start]!.id, serializedBytes, cap);
	}
	log.debug('batch split over the uncompressed cap', {
		entries: end - start,
		bytes: serializedBytes,
		cap,
	});
	const midpoint = start + ((end - start) >> 1);
	const left = await appendRange(backend, drafts, sizes, start, midpoint, cap, committedIds, committedBytes);
	const right = await appendRange(backend, drafts, sizes, midpoint, end, cap, committedIds, committedBytes);
	return combineRangeCommits(left, right);
}
