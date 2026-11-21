/**
 * Wire protocol of the chunked durable-history seed (integration plan R5,
 * test architecture §10.2: `history.v2.seed.begin` / `history.v2.seed.chunk`
 * / `history.v2.seed.commit`).
 *
 * The v1 log keeps every full state in ONE entry, and the storage worker's
 * admission cap (8 MiB uncompressed) makes any larger history unpersistable:
 * the seed falls over at admission with nothing published. This protocol cuts
 * a full state into sequential chunk entries of at most
 * {@link SEED_CHUNK_TARGET_BYTES} serialized bytes, each carrying its chunk
 * number, a content digest, and the writer's source cursor, so a crash
 * between chunks resumes from the durable log — never re-sending (and never
 * duplicating) a chunk that already committed. Only a `commit` entry whose
 * counts and digests verify publishes a new base; `begin`/`chunk` entries
 * without one are an unfinished import that rebuild ignores.
 *
 * This module is the SINGLE implementation of the protocol: the durable
 * canonical-history provider (packages/local-runtime-v2) replays and writes
 * it, and the history-import CLI (scripts/history-import.mjs) writes and
 * verifies it — neither side restates the payload shapes, id derivation, or
 * chunking rules. The module is deliberately dependency-free (node builtins
 * plus the worker's size primitive) so both sides can sit on it without a
 * package cycle.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { entryDraftSizeBytes } from '@mavis/storage-worker';

/**
 * Canonical envelope shape accepted as a seed record. Declared structurally:
 * the durable provider stores `CanonicalHistoryEnvelope` values here and the
 * CLI stores the canonical decoder's output; both satisfy this minimal
 * contract, and full canonical validation remains the caller's duty (the
 * provider works on already-canonical records, the CLI runs the canonical
 * envelope decoder before anything enters a chunk).
 */
export interface SeedEnvelope {
	readonly message_id: string;
	readonly turn_id: string;
	readonly message: unknown;
}

/** `history.v2.seed.begin` — opens one chunked full-state import. */
export const SEED_BEGIN_KIND = 'history.v2.seed.begin';
/** `history.v2.seed.chunk` — one sequential slice of the full state. */
export const SEED_CHUNK_KIND = 'history.v2.seed.chunk';
/** `history.v2.seed.commit` — verifies and publishes the imported base. */
export const SEED_COMMIT_KIND = 'history.v2.seed.commit';

/**
 * Mapping version keyed into every import id: bump when the writer-side
 * record mapping changes in a way that must not resume against chunks
 * written under the previous mapping.
 */
export const SEED_MAPPING_VERSION = 'canonical-history-seed.v1';

/**
 * Serialized entry budget of one seed chunk. Comfortably below the worker's
 * admission cap (`DURABLE_HISTORY_BATCH_CAP_BYTES`, 8 MiB, mirrored by
 * {@link SEED_CHUNK_HARD_CAP_BYTES}) so metadata and id variance can never
 * push a planned chunk over admission.
 */
export const SEED_CHUNK_TARGET_BYTES = 6 * 1024 * 1024;

/**
 * Hard admission ceiling of one seed entry, including a single-oversized-record
 * chunk. Mirrors the durable history provider's `DURABLE_HISTORY_BATCH_CAP_BYTES`
 * (the worker's `maxBatchUncompressedBytes`): a record whose entry serializes
 * at or above this bound cannot be admitted at all and fails the import with a
 * controlled record-too-large error instead of a partial publish.
 */
export const SEED_CHUNK_HARD_CAP_BYTES = 8 * 1024 * 1024;

export interface SeedBeginPayload {
	readonly sessionId: string;
	readonly importId: string;
	/** Semantic fingerprint of the imported source (revision or content hash). */
	readonly sourceFingerprint: string;
	readonly mappingVersion: string;
	/** Record count the writer expects to deliver; resume re-checks it. */
	readonly expectedCount: number;
	/** Provider-side full-state reason (`seed`/`replace`/`compact`/`adopt`/`repair`). */
	readonly reason: string;
}

export interface SeedChunkPayload {
	readonly sessionId: string;
	readonly importId: string;
	/** 1-based, gap-free position of this chunk inside the import. */
	readonly chunkNo: number;
	/** Writer's source cursor after this chunk (cumulative record position). */
	readonly sourceCursor: number;
	/** Records in this chunk; always `envelopes.length`. */
	readonly count: number;
	/** Content digest of the chunk's serialized envelopes. */
	readonly digest: string;
	readonly envelopes: readonly SeedEnvelope[];
}

export interface SeedCommitPayload {
	readonly sessionId: string;
	readonly importId: string;
	readonly chunkCount: number;
	readonly count: number;
	/** Canonical revision of the published base (writer-computed). */
	readonly activeRevision: string;
	/** Chained digest over the committed chunk digests, in order. */
	readonly rootDigest: string;
	/** Digest of the import's CAS manifest when the writer produced one. */
	readonly casManifestDigest: string | null;
}

export type SeedPayload = SeedBeginPayload | SeedChunkPayload | SeedCommitPayload;

/** One durable log entry as the protocol scanner sees it. */
export interface SeedLogEntry {
	/** Entry id when the reader carries it (used to chain parent links). */
	readonly id?: string;
	readonly kind: string;
	readonly payload: unknown;
}

/** A chunk recorded inside a scanned import. */
export interface SeedChunkRecord {
	readonly chunkNo: number;
	readonly digest: string;
	readonly count: number;
	readonly sourceCursor: number;
	readonly envelopes: readonly SeedEnvelope[];
}

/** One seed import reconstructed from the log, open or committed. */
export interface SeedImportScan {
	readonly importId: string;
	readonly begin: SeedBeginPayload;
	readonly chunks: readonly SeedChunkRecord[];
	readonly commit?: SeedCommitPayload;
}

/** Result of scanning a log slice for seed imports. */
export interface SeedScan {
	/** The most recent import in log order; `commit` absent means unfinished. */
	readonly last?: SeedImportScan;
}

/** Length of the derived ids/digests (base64url characters). */
const IMPORT_ID_CHARS = 16;
const DIGEST_CHARS = 24;

/** Derives the deterministic import id (test architecture §10.2). */
export function deriveSeedImportId(input: {
	readonly sessionId: string;
	readonly reason: string;
	readonly sourceFingerprint: string;
	readonly mappingVersion: string;
}): string {
	const material = [
		input.sessionId,
		input.reason,
		input.sourceFingerprint,
		input.mappingVersion,
	].join('|');
	return createHash('sha256').update(material, 'utf8').digest('base64url').slice(0, IMPORT_ID_CHARS);
}

/** Deterministic entry id of a seed begin (replays resolve, never duplicate). */
export function seedBeginEntryId(sessionId: string, importId: string): string {
	return `${sessionId}|seed|${importId}|begin`;
}

/** Deterministic entry id of a seed chunk: import, position, and content. */
export function seedChunkEntryId(sessionId: string, importId: string, chunkNo: number, digest: string): string {
	return `${sessionId}|seed|${importId}|chunk|${String(chunkNo)}|${digest}`;
}

/** Deterministic entry id of a seed commit. */
export function seedCommitEntryId(sessionId: string, importId: string): string {
	return `${sessionId}|seed|${importId}|commit`;
}

/** Content digest over the chunk's serialized envelope texts (exact array JSON). */
export function seedChunkDigest(envelopeTexts: readonly string[]): string {
	return createHash('sha256')
		.update('[')
		.update(envelopeTexts.join(','), 'utf8')
		.update(']')
		.digest('base64url')
		.slice(0, DIGEST_CHARS);
}

/** Chained digest over the committed chunk digests, in order. */
export function seedRootDigest(chunkDigests: readonly string[]): string {
	return createHash('sha256')
		.update(JSON.stringify(chunkDigests), 'utf8')
		.digest('base64url')
		.slice(0, DIGEST_CHARS);
}

/**
 * Serialized size of one seed entry draft — measured exactly as the storage
 * worker's admission and batch splitting measure it (UTF-8 bytes of the
 * stringified draft). `parentId` is passed by the writer once the previous
 * entry id is known; the draft-size delta of a parent id is its own length.
 */
export function seedEntrySizeBytes(entryId: string, kind: string, payload: SeedPayload, parentId?: string | null): number {
	return entryDraftSizeBytes({ id: entryId, parentId: parentId ?? null, kind, payload });
}

/**
 * Cuts a full state into deterministic seed chunks.
 *
 * Envelopes are fed one at a time ({@link SeedChunker.add}); the chunker
 * returns the just-closed chunk whenever the next envelope would push the
 * serialized entry past the target budget, so both an in-memory array (the
 * provider's full state) and a stream (the import CLI) cut IDENTICALLY — the
 * property resume idempotency relies on. A single envelope larger than the
 * target is accepted as its own chunk (the writer checks it against the hard
 * cap before admission); the budget is never applied to an empty chunk.
 */
export class SeedChunker {
	private readonly targetBytes: number;
	private readonly overheadBytes: number;
	private readonly texts: string[] = [];
	private readonly pending: SeedEnvelope[] = [];
	private pendingBytes = 0;
	private cursor: number;
	private chunkNo: number;

	constructor(
		private readonly options: {
			readonly sessionId: string;
			readonly importId: string;
			/** Serialized entry budget of one chunk; default {@link SEED_CHUNK_TARGET_BYTES}. */
			readonly targetBytes?: number;
			/**
			 * Chunk number of the first fresh chunk (default 1). A streaming
			 * resume that already has durable chunks sets this to
			 * `confirmedChunks + 1`, so its numbering continues the import.
			 */
			readonly startChunkNo?: number;
			/** Source-cursor value of the first fresh record (default 0). */
			readonly startCursor?: number;
		},
	) {
		this.targetBytes = options.targetBytes ?? SEED_CHUNK_TARGET_BYTES;
		this.chunkNo = options.startChunkNo ?? 1;
		this.cursor = options.startCursor ?? 0;
		// Conservative per-chunk overhead: a skeleton payload with maximum-width
		// numbers and the final digest length. Never an underestimate for the
		// id/digest/cursor fields it reserves, so the projection below errs
		// toward cutting earlier, never over-filling a chunk.
		this.overheadBytes = seedEntrySizeBytes(
			seedChunkEntryId(options.sessionId, options.importId, Number.MAX_SAFE_INTEGER, '0'.repeat(DIGEST_CHARS)),
			SEED_CHUNK_KIND,
			{
				sessionId: options.sessionId,
				importId: options.importId,
				chunkNo: Number.MAX_SAFE_INTEGER,
				sourceCursor: Number.MAX_SAFE_INTEGER,
				count: Number.MAX_SAFE_INTEGER,
				digest: '0'.repeat(DIGEST_CHARS),
				envelopes: [],
			},
		);
	}

	/**
	 * Feeds one envelope. Returns the chunk that just closed when this envelope
	 * had to start a new one, otherwise `null`.
	 */
	add(envelope: SeedEnvelope): SeedChunkPlan | null {
		const text = JSON.stringify(envelope);
		const textBytes = Buffer.byteLength(text, 'utf8');
		const separatorBytes = this.pending.length > 0 ? 1 : 0;
		if (
			this.pending.length > 0 &&
			this.overheadBytes + this.pendingBytes + separatorBytes + textBytes > this.targetBytes
		) {
			const closed = this.closeChunk();
			this.pending.push(envelope);
			this.texts.push(text);
			this.pendingBytes = textBytes;
			this.cursor += 1;
			return closed;
		}
		this.pending.push(envelope);
		this.texts.push(text);
		this.pendingBytes += separatorBytes + textBytes;
		this.cursor += 1;
		return null;
	}

	/** Closes the trailing partial chunk; `null` when nothing is pending. */
	finish(): SeedChunkPlan | null {
		return this.pending.length > 0 ? this.closeChunk() : null;
	}

	private closeChunk(): SeedChunkPlan {
		const chunkNo = this.chunkNo;
		const digest = seedChunkDigest(this.texts);		const envelopes = [...this.pending];
		const payload: SeedChunkPayload = {
			sessionId: this.options.sessionId,
			importId: this.options.importId,
			chunkNo,
			sourceCursor: this.cursor,
			count: envelopes.length,
			digest,
			envelopes,
		};
		const entryBytes = seedEntrySizeBytes(
			seedChunkEntryId(this.options.sessionId, this.options.importId, chunkNo, digest),
			SEED_CHUNK_KIND,
			payload,
		);
		this.texts.length = 0;
		this.pending.length = 0;
		this.pendingBytes = 0;
		this.chunkNo = chunkNo + 1;
		return { chunkNo, digest, count: envelopes.length, sourceCursor: this.cursor, envelopes, entryBytes };
	}
}

/** One chunk cut by {@link SeedChunker}, ready to be written. */
export interface SeedChunkPlan {
	readonly chunkNo: number;
	readonly digest: string;
	readonly count: number;
	/** Writer's cumulative record cursor after this chunk. */
	readonly sourceCursor: number;
	readonly envelopes: readonly SeedEnvelope[];
	/** Serialized entry size without the parentId contribution. */
	readonly entryBytes: number;
}

/** Validates a log payload as a seed begin; throws on any shape violation. */
export function asSeedBeginPayload(payload: unknown): SeedBeginPayload {
	const value = requireRecord(payload, 'seed begin');
	const sessionId = requireString(value['sessionId'], 'sessionId');
	const importId = requireString(value['importId'], 'importId');
	return {
		sessionId,
		importId,
		sourceFingerprint: requireString(value['sourceFingerprint'], 'sourceFingerprint'),
		mappingVersion: requireString(value['mappingVersion'], 'mappingVersion'),
		expectedCount: requireCount(value['expectedCount'], 'expectedCount'),
		reason: requireString(value['reason'], 'reason'),
	};
}

/** Validates a log payload as a seed chunk; throws on any shape violation. */
export function asSeedChunkPayload(payload: unknown): SeedChunkPayload {
	const value = requireRecord(payload, 'seed chunk');
	const envelopesValue = value['envelopes'];
	if (!Array.isArray(envelopesValue)) throw malformed('seed chunk envelopes must be an array');
	const envelopes: SeedEnvelope[] = envelopesValue.map((entry, index) => {
		const envelope = requireRecord(entry, `seed chunk envelopes[${String(index)}]`);
		return {
			message_id: requireString(envelope['message_id'], 'message_id'),
			turn_id: requireString(envelope['turn_id'], 'turn_id'),
			message: envelope['message'],
		};
	});
	const chunkNo = requireCount(value['chunkNo'], 'chunkNo');
	const count = requireCount(value['count'], 'count');
	if (count !== envelopes.length) {
		throw malformed(`seed chunk count (${String(count)}) does not match its envelope count (${String(envelopes.length)})`);
	}
	return {
		sessionId: requireString(value['sessionId'], 'sessionId'),
		importId: requireString(value['importId'], 'importId'),
		chunkNo,
		sourceCursor: requireCount(value['sourceCursor'], 'sourceCursor'),
		count,
		digest: requireString(value['digest'], 'digest'),
		envelopes,
	};
}

/** Validates a log payload as a seed commit; throws on any shape violation. */
export function asSeedCommitPayload(payload: unknown): SeedCommitPayload {
	const value = requireRecord(payload, 'seed commit');
	const casManifest = value['casManifestDigest'];
	if (casManifest !== null && typeof casManifest !== 'string') {
		throw malformed('seed commit casManifestDigest must be a string or null');
	}
	return {
		sessionId: requireString(value['sessionId'], 'sessionId'),
		importId: requireString(value['importId'], 'importId'),
		chunkCount: requireCount(value['chunkCount'], 'chunkCount'),
		count: requireCount(value['count'], 'count'),
		activeRevision: requireString(value['activeRevision'], 'activeRevision'),
		rootDigest: requireString(value['rootDigest'], 'rootDigest'),
		casManifestDigest: casManifest,
	};
}

/** True when the entry kind belongs to the chunked-seed protocol. */
export function isSeedKind(kind: string): boolean {
	return kind === SEED_BEGIN_KIND || kind === SEED_CHUNK_KIND || kind === SEED_COMMIT_KIND;
}

/**
 * Event-based scanner over the log's seed entries, in log order. Feed every
 * entry whose kind {@link isSeedKind}; the scan reconstructs the most recent
 * import, validating chunk continuity, counts, and the chained root digest of
 * a commit. Structural violations (a chunk without its begin, a foreign
 * import id, a gap in chunk numbers, a lying commit) throw — a log that
 * violates the protocol is corrupt, not partially readable.
 */
export function createSeedScan(): { onEntry(entry: SeedLogEntry): void; readonly scan: SeedScan } {
	let last: SeedImportScan | undefined;
	return {
		onEntry(entry) {
			if (entry.kind === SEED_BEGIN_KIND) {
				const begin = asSeedBeginPayload(entry.payload);
				// A newer begin supersedes an unfinished import; rebuild ignores
				// every import without a commit, so the superseded one simply
				// stops being the scan's `last`.
				last = { importId: begin.importId, begin, chunks: [] };
				return;
			}
			if (!last) throw malformed(`${entry.kind} without a seed begin`);
			if (entry.kind === SEED_CHUNK_KIND) {
				const chunk = asSeedChunkPayload(entry.payload);
				if (chunk.importId !== last.importId) {
					throw malformed(`seed chunk of foreign import ${chunk.importId} inside ${last.importId}`);
				}
				if (chunk.chunkNo !== last.chunks.length + 1) {
					throw malformed(
						`seed chunk ${String(chunk.chunkNo)} breaks the contiguous sequence of import ${last.importId}`,
					);
				}
				if (chunk.sessionId !== last.begin.sessionId) {
					throw malformed(`seed chunk sessionId ${chunk.sessionId} does not match its begin`);
				}
				last = { ...last, chunks: [...last.chunks, toChunkRecord(chunk)] };
				return;
			}
			// SEED_COMMIT_KIND
			const commit = asSeedCommitPayload(entry.payload);
			if (commit.importId !== last.importId) {
				throw malformed(`seed commit of foreign import ${commit.importId} inside ${last.importId}`);
			}
			const total = last.chunks.reduce((sum, chunk) => sum + chunk.count, 0);
			if (commit.chunkCount !== last.chunks.length) {
				throw malformed(
					`seed commit claims ${String(commit.chunkCount)} chunks, log holds ${String(last.chunks.length)}`,
				);
			}
			if (commit.count !== total) {
				throw malformed(`seed commit claims ${String(commit.count)} records, log holds ${String(total)}`);
			}
			if (commit.rootDigest !== seedRootDigest(last.chunks.map((chunk) => chunk.digest))) {
				throw malformed(`seed commit rootDigest does not match the committed chunks of ${last.importId}`);
			}
			last = { ...last, commit };
		},
		get scan(): SeedScan {
			return { ...(last === undefined ? {} : { last }) };
		},
	};
}

/** Concatenates a scanned import's chunks back into the full state. */
export function stitchSeedImport(scan: SeedImportScan): readonly SeedEnvelope[] {
	const records: SeedEnvelope[] = [];
	for (const chunk of scan.chunks) records.push(...chunk.envelopes);
	return records;
}

function toChunkRecord(chunk: SeedChunkPayload): SeedChunkRecord {
	return {
		chunkNo: chunk.chunkNo,
		digest: chunk.digest,
		count: chunk.count,
		sourceCursor: chunk.sourceCursor,
		envelopes: chunk.envelopes,
	};
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw malformed(`${what} payload must be a plain object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw malformed(`seed payload field ${field} must be a non-empty string`);
	}
	return value;
}

function requireCount(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw malformed(`seed payload field ${field} must be a non-negative safe integer`);
	}
	return value;
}

function malformed(reason: string): Error {
	return new Error(`Durable history seed protocol violation: ${reason}`);
}
