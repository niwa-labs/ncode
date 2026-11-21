/**
 * pi ↔ mcode identity-domain schemas of wave W02 (PORT-PI-1.3).
 *
 * This module is TYPE-ONLY like the rest of `@mavis/durable-core`. It fixes
 * the W02-D contract pieces that live at the INTEGRATION boundary between a
 * full pi `Storage` implementation (the wave's new adapter) and our existing
 * durable stack (worker / seam / v2-adapter):
 *
 * 1. branded mirrors of the pi numeric id family (`Id<Kind>`/`Seq`,
 *    `third_party/pi-durable/src/types.ts:18-40`) so every conversion between
 *    pi numeric ids and our stable string ids is an EXPLICIT, named step —
 *    never an implicit string↔number coercion (wave risk "silent
 *    string↔number ID collisions", port-plan.md:707);
 * 2. the entry envelope schema a pi Storage-backed log port uses to keep the
 *    mcode entry id alive inside a pi `EntryRecord` (U03/U05);
 * 3. the `CommitReceipt` shape of boundary contract C1 — commitSeq, head,
 *    watermark and ownerEpoch as SEPARATE domains, explicitly not the RPC
 *    cursor (port-pi-1.3/contracts/boundary-contracts.md, C1 invariant 1);
 * 4. the scoping rule that kills the false universality of `head === seq`:
 *    that equation is a backend-local invariant of
 *    `@mavis/durable-backend-sqlite-zstd` only, while pi `head` is an
 *    `EntryId` context pointer and pi `Seq` permits gaps
 *    (port-pi-1.3/contracts/identity-domains.md, rules 1-2).
 *
 * Runtime conversion helpers deliberately do NOT live here (the package ships
 * no runtime code): they live beside their single runtime consumer — the
 * storage-worker pi composition and the seam's pi-storage port — next to the
 * existing precedent that runtime translation between dictionaries stays in
 * exactly one bridge module (`storage-worker/src/sqlite-zstd-adapter.ts`).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// 1. Branded mirrors of the pi numeric id family (pin types.ts:18-40)
// ---------------------------------------------------------------------------

/**
 * Marker namespace separating the mirror brands below from pi's own erased
 * brands. pi's `Id`/`Seq` brands and these mirrors are structurally
 * `number`, so values cross between them only through the explicitly named
 * conversion helpers of the consuming bridge module — the brands exist to
 * make an accidental bare-number assignment a type error on OUR side of the
 * seam.
 */
declare const piIdMirrorBrand: unique symbol;

type PiIdMirror<Kind extends string> = number & {
	readonly [piIdMirrorBrand]: Kind;
};

/**
 * Mirror of pi `ConversationId` (`Id<"conversation">`). Numeric; allocated by
 * `Storage.mintId()`; `ROOT_CONVERSATION_ID = 1` is reserved upstream.
 */
export type PiConversationId = PiIdMirror<'pi.conversation'>;

/** Mirror of pi `EntryId` (`Id<"entry">`): a numeric RECORD id, not a log position. */
export type PiEntryId = PiIdMirror<'pi.entry'>;

/** Mirror of pi `TaskId` (`Id<"task">`). */
export type PiTaskId = PiIdMirror<'pi.task'>;

/** Mirror of pi `SubmissionId` (`Id<"submission">`). */
export type PiSubmissionId = PiIdMirror<'pi.submission'>;

/** Mirror of pi `DocumentId` (`Id<"document">`). */
export type PiDocumentId = PiIdMirror<'pi.document'>;

/**
 * Mirror of pi `Seq`: strictly increasing sequence of one ATOMIC storage
 * commit; **gaps are permitted** and it is never a conversation head
 * (pin `types.ts:36-37`). Contrast {@link BackendLocalCommitSeq}, where the
 * backend happens to close the gaps.
 */
export type PiSeq = number & { readonly [piIdMirrorBrand]: 'pi.Seq' };

// ---------------------------------------------------------------------------
// 2. Entry envelope: keeping the mcode entry id alive inside a pi EntryRecord
// ---------------------------------------------------------------------------

/** Version tag of {@link PiBridgeEntryEnvelope}. */
export type PI_BRIDGE_ENTRY_ENVELOPE_VERSION = 1;

/**
 * Envelope stored as the `data` of one pi `EntryRecord` when a pi
 * Storage-backed `DurableLogPort` hosts mcode log entries (U05: the seam and
 * the worker stay on top of the FULL pi Storage, not beside it).
 *
 * Rules (fixed here so no bridge invents its own mapping):
 * - `EntryRecord.kind` carries the mcode entry kind verbatim
 *   (`mcode.owner-input.submission`, `history.v2.seed.chunk`, …);
 * - `EntryRecord.data` carries this envelope: the mcode stable string entry
 *   id plus the payload, untouched;
 * - the numeric `EntryRecord.id` is ALWAYS allocated through
 *   `Storage.mintId()` — it is never derived from, hashed from, or parsed
 *   out of the string id. Both directions of the mapping are carried by the
 *   envelope itself, so a string id can never silently collide with a number
 *   and an eviction/rebuild can restore the mapping from the log alone.
 */
export interface PiBridgeEntryEnvelope {
	readonly v: PI_BRIDGE_ENTRY_ENVELOPE_VERSION;
	/** Stable application identity of the entry (`Entry.entryId` domain). */
	readonly mcodeEntryId: string;
	/** Application payload, stored verbatim. */
	readonly payload: unknown;
}

/** Structural guard document for the envelope version tag (bridges assert `v === 1`). */
export type PiBridgeEntryEnvelopeOfVersion<
	V extends PI_BRIDGE_ENTRY_ENVELOPE_VERSION,
> = PiBridgeEntryEnvelope & { readonly v: V };

// ---------------------------------------------------------------------------
// 3. CommitReceipt — boundary contract C1 (AppendCommand → CommitReceipt)
// ---------------------------------------------------------------------------

/**
 * Position of one entry inside its commit, in the pi-mapped reading:
 * `(commitSeq, ordinal)` addresses a record the way the sqlite-zstd backend
 * addresses it with `(seq, ordinal)`. These are LOG-POSITION domains — never
 * entry identity, never the RPC cursor.
 */
export interface CommitPosition {
	/** Sequence of the atomic commit that persisted the entry (pi `Seq` mirror domain). */
	readonly commitSeq: number;
	/** Zero-based position of the entry inside that commit's write batch. */
	readonly ordinal: number;
}

/**
 * Fenced acknowledgement of ONE durable commit, shaped by boundary contract
 * C1 (invariant 1): `commitSeq`, `head`, `watermark` and `ownerEpoch` are
 * FOUR SEPARATE domains and none of them is a public RPC cursor (the mcoded
 * daemon cursor is a daemon-event domain, `packages/mcoded/src/protocol.ts`).
 *
 * - `commitSeq` — the storage commit sequence (pi `Seq` semantics: gaps
 *   permitted, strictly increasing);
 * - `head` — the log head AFTER the commit, in the producing backend's own
 *   rendering: for the sqlite-zstd backend this equals `commitSeq`
 *   ({@link BackendLocalCommitSeq}); a pi Storage-backed port renders its
 *   own last-commit sequence. It is never an `EntryId`-shaped context head;
 * - `watermark` — the derived projection position of the last entry of this
 *   commit, when the committer tracks one (`context-projection` domain);
 * - `ownerEpoch` — the fencing epoch under which the commit landed
 *   (`durable-backend-sqlite-zstd` owner domain); `null` when the producing
 *   storage does not fence owners.
 *
 * The receipt acknowledges a DURABLE commit, never an enqueue (C1
 * invariant 2), and a repeated operation id maps to the original receipt
 * rather than a second mutation (C1 invariant 3 — the caller-side key;
 * `EntryAppendStatus` covers the entryId-keyed special case).
 */
export interface CommitReceipt {
	/** Pi-`Seq`-shaped commit sequence (gaps permitted). */
	readonly commitSeq: number;
	/** Backend-local log head after the commit (see above for the scoping). */
	readonly head: number;
	/** Projection watermark of the commit's last entry, when tracked. */
	readonly watermark: CommitPosition | null;
	/** Owner fencing epoch of the commit, when the backend fences owners. */
	readonly ownerEpoch: number | null;
}

// ---------------------------------------------------------------------------
// 4. head === seq is a BACKEND-LOCAL equation, not a universal one
// ---------------------------------------------------------------------------

/**
 * Named invariant marker for the ONE storage family where `Commit.head`
 * equals `Commit.seq`: `@mavis/durable-backend-sqlite-zstd` (its
 * `BatchId === Seq` and every commit takes `head + 1`, so no gaps occur —
 * `durable-backend-sqlite-zstd/src/types.ts:43-51`).
 *
 * W02 removes the FALSE universality of that equation outside this backend:
 * - pi `Seq` PERMITS gaps and is not a conversation head;
 * - pi `head` is an `EntryId` context pointer inside `EntryRecord`
 *   (pin `types.ts:437-438`) — a different domain entirely, consumed by the
 *   projection fold waves (W03), never by log-position arithmetic;
 * - a pi Storage-backed `DurableLogPort` renders `PortCommit.head` from its
 *   own last-commit sequence and MUST document that rendering locally.
 *
 * Type-level rule: a value typed {@link BackendLocalCommitSeq} may be used
 * where "head" and "commit sequence" coincide; everywhere else the two
 * domains are carried as separate fields (see {@link CommitReceipt}) and
 * joined only by the producing backend's documented equation.
 */
export type BackendLocalCommitSeq = number & {
	readonly [piIdMirrorBrand]: 'sqlite-zstd.head-eq-seq';
};

/**
 * Documentation schema of the numeric↔string id mapping W02-D requires
 * ("schemas for numeric pi IDs ↔ stable mcode IDs"). The runtime bridges
 * (storage-worker pi composition, seam pi-storage port) implement exactly
 * this schema; nothing else may invent a second mapping.
 */
export interface PiMcodeIdMappingSchema {
	/** Entries: one {@link PiBridgeEntryEnvelope} per pi `EntryRecord` (see above). */
	readonly entry: {
		readonly carrier: 'pi.EntryRecord.data';
		readonly envelope: PiBridgeEntryEnvelope;
		readonly numericId: 'storage.mintId()';
	};
	/**
	 * Conversations: one minted pi `ConversationId` per logical mcode
	 * conversation string (the seam's `conversationId`, a session id in the
	 * history provider). The mapping is carried by the port's rebuilt index
	 * and by the creating conversation write itself; ids are never re-derived
	 * from the string.
	 */
	readonly conversation: {
		readonly numericId: 'storage.mintId()';
		readonly appKey: 'verbatim mcode conversation string';
	};
	/** Commits: pi `Seq` (gaps permitted) → our `commitSeq`/batch `seq` domain as-is. */
	readonly commit: {
		readonly piSeq: 'as-is (gaps permitted)';
		readonly backendLocalEquation: 'head === seq holds only in @mavis/durable-backend-sqlite-zstd';
	};
}
