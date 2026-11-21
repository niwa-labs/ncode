/**
 * Explicit identity-domain conversions between the pinned pi numeric ID
 * namespace and our string mcode entry ids (W02-D "schemas for numeric pi IDs
 * ↔ stable mcode IDs"; the risk called out by the plan is "silent
 * string↔number ID collisions").
 *
 * Two mapping directions exist in W02 and they do NOT overlap:
 * - THIS module (part A): pi record CONTENT → deterministic mcode entry ids
 *   of the zstd log (`pi.<family>.<id>[.r<rev>]`) — the substrate direction,
 *   where our backend hosts the full pi `Storage`;
 * - `@mavis/durable-core` `pi-id-domains.ts` (part B): mcode log entries →
 *   pi `EntryRecord`s via the `PiBridgeEntryEnvelope` — the port direction,
 *   where a pi Storage-backed `DurableLogPort` hosts mcode entries, plus the
 *   C1 `CommitReceipt` and the backend-local scoping of `head === seq`.
 *
 * Rules this implementation upholds:
 * - pi `Id<Kind>` numbers never become mcode ids by string interpolation
 *   outside these helpers;
 * - every mcode entry id this module mints is prefixed `pi.` — it can never
 *   collide with application entry ids (history/seam kinds use other
 *   namespaces) nor with a bare numeric string;
 * - ids are deterministic functions of `(family, id, rev)`, so a retried
 *   commit after a rolled-back transaction reuses the same ids and the
 *   backend's entry-id uniqueness rejects any accidental double write.
 *
 * @module
 */

import type {
	ConversationId,
	DocumentId,
	EntryId,
	SubmissionId,
	TaskId,
} from '@earendil-works/pi-durable';

/** Discriminator of a pi record family inside a mcode entry kind. */
export type PiRecordFamily = 'conversation' | 'entry' | 'task' | 'submission' | 'document';

/** The mcode entry kind every pi record-content entry carries. */
export const PI_RECORD_ENTRY_KIND = 'pi.record';

/** The mcode entry kind of the commit marker written when a pi commit carries no record content. */
export const PI_COMMIT_MARKER_KIND = 'pi.commit';

/**
 * Deterministic mcode entry id of one immutable record (conversations and
 * entries are created exactly once — pi `Storage` enforces it).
 */
export function piImmutableEntryId(family: 'conversation' | 'entry', id: number): string {
	return `pi.${family}.${id}`;
}

/**
 * Deterministic mcode entry id of one VERSION of a mutable record. `rev` is
 * the per-record version counter maintained in the record's index row; each
 * committed replacement appends the next version, keeping the full task and
 * submission history in the zstd log.
 */
export function piVersionedEntryId(
	family: 'task' | 'submission' | 'document',
	id: number,
	rev: number,
): string {
	return `pi.${family}.${id}.r${rev}`;
}

/** Deterministic mcode entry id of the commit marker of sequence `seq`. */
export function piCommitMarkerEntryId(seq: number): string {
	return `pi.commit.${seq}`;
}

/** Apply the erased ID brand at a trusted numeric boundary (mirrors upstream `idFromNumber`). */
export function piIdFromNumber<I extends number>(value: number): I {
	return value as I;
}

export function conversationIdFromNumber(value: number): ConversationId {
	return value as ConversationId;
}

export function entryIdFromNumber(value: number): EntryId {
	return value as EntryId;
}

export function taskIdFromNumber(value: number): TaskId {
	return value as TaskId;
}

export function submissionIdFromNumber(value: number): SubmissionId {
	return value as SubmissionId;
}

export function documentIdFromNumber(value: number): DocumentId {
	return value as DocumentId;
}
