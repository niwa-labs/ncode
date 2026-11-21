/**
 * W02 part B (PORT-PI-1.3): the seed PUBLICATION gate — "Seed publication
 * только при validated commit" (port-plan.md W02-C row).
 *
 * The read side already refuses to publish an unverified import: the seed
 * protocol's scanner (`seed-protocol.ts`, the SINGLE implementation)
 * validates chunk continuity, counts and the chained root digest, and the
 * rebuild ignores begin/chunk entries without a verified commit. What was
 * missing is the same gate on the WRITE/composition side: when the durable
 * log is written through a full pi `Storage` (W02's adapter) instead of the
 * plain worker path, the commit that would carry
 * `history.v2.seed.commit` must be validated BEFORE it ever reaches the
 * storage — a corrupted seed then produces a rejected commit with nothing
 * published, instead of a durable commit entry the read side has to treat
 * as corrupt forever after.
 *
 * Two pieces:
 * - {@link verifySeedCommitForPublication}: pure verdict over the log's seed
 *   entries plus the candidate commit entry. Reuses `createSeedScan` for
 *   every structural rule (single implementation, nothing restated here)
 *   and adds the two publication-specific checks the scanner deliberately
 *   leaves to callers: the seed mapping version (resume compatibility) and
 *   strictly monotonic source cursors across chunks.
 * - {@link createSeedPublicationPreCommitHook}: the adapter that plugs the
 *   verdict into the storage-worker's pi single-writer composition
 *   (`onBeforeCommit` of `gatePiStorageMutations`): it finds seed-commit
 *   entries inside a pending pi write batch — mcode log entries travel as
 *   bridge envelopes (`PiBridgeEnvelope`, `@mavis/durable-seam`) in pi
 *   `EntryRecord.data` — validates them against the log state before the
 *   commit plus any begin/chunk entries riding in the SAME batch, and
 *   rejects the commit otherwise. A rejection fails that one commit and
 *   leaves the gate usable (validation, not storage damage).
 *
 * Monotonic cursor/digests/source drift are PRESERVED, not reinvented: the
 * digests and cursors are exactly the protocol's; the gate only refuses to
 * publish what they do not verify.
 *
 * @module
 */

import {
	asSeedCommitPayload,
	createSeedScan,
	SEED_BEGIN_KIND,
	SEED_CHUNK_KIND,
	SEED_COMMIT_KIND,
	SEED_MAPPING_VERSION,
	type SeedCommitPayload,
	type SeedLogEntry,
} from './seed-protocol.js';

/**
 * The bridge envelope a pi Storage-backed log port stores as
 * `EntryRecord.data` (schema: `@mavis/durable-core/src/pi-id-domains.ts`;
 * runtime mirror of the seam port's envelope — declared structurally here so
 * this module does not depend on `@mavis/durable-seam`).
 */
interface BridgeEnvelopeLike {
	readonly v: 1;
	readonly mcodeEntryId: string;
	readonly payload: unknown;
}

/** Why a seed commit was refused publication. */
export type SeedPublicationErrorCode =
	/** A pi write batch carries something at the seed-commit kind that is not a valid envelope + commit payload. */
	| 'SEED_COMMIT_ENTRY_MALFORMED'
	/** The log + batch seed state violates the seed protocol (scanner detail in `message`). */
	| 'SEED_IMPORT_STATE_INVALID'
	/** The begin was written under a different mapping version than the current one. */
	| 'SEED_MAPPING_VERSION_DRIFT'
	/** Chunk source cursors are not strictly increasing (monotonic cursor contract). */
	| 'SEED_SOURCE_CURSOR_NOT_MONOTONIC';

/** Verdict of {@link verifySeedCommitForPublication}. */
export type SeedPublicationVerdict =
	| { readonly ok: true; readonly commit: SeedCommitPayload }
	| {
			readonly ok: false;
			readonly code: SeedPublicationErrorCode;
			readonly message: string;
	  };

/**
 * Validates one candidate seed-commit entry against the seed entries the log
 * already holds (oldest first) plus any begin/chunk entries that ride in the
 * SAME commit batch. Ok means: publishing this commit yields exactly the
 * base the protocol's read side would reconstruct — nothing else.
 */
export function verifySeedCommitForPublication(input: {
	readonly logSeedEntries: readonly SeedLogEntry[];
	readonly batchSeedEntries: readonly SeedLogEntry[];
	readonly commitEntry: SeedLogEntry;
}): SeedPublicationVerdict {
	const scanner = createSeedScan();
	try {
		for (const entry of input.logSeedEntries) scanner.onEntry(entry);
		const commitCandidates: SeedLogEntry[] = [];
		for (const entry of input.batchSeedEntries) {
			if (entry.kind === SEED_COMMIT_KIND) commitCandidates.push(entry);
			else scanner.onEntry(entry);
		}
		if (commitCandidates.length > 0) {
			return {
				ok: false,
				code: 'SEED_IMPORT_STATE_INVALID',
				message: `the commit batch already carries ${String(commitCandidates.length)} seed commit(s) before the candidate`,
			};
		}
		const scanBefore = scanner.scan.last;
		if (scanBefore !== undefined && scanBefore.begin.mappingVersion !== SEED_MAPPING_VERSION) {
			return {
				ok: false,
				code: 'SEED_MAPPING_VERSION_DRIFT',
				message: `seed begin mapping version ${scanBefore.begin.mappingVersion} does not match the current ${SEED_MAPPING_VERSION}`,
			};
		}
		if (scanBefore !== undefined) {
			for (let index = 1; index < scanBefore.chunks.length; index += 1) {
				const previous = scanBefore.chunks[index - 1]!;
				const chunk = scanBefore.chunks[index]!;
				if (chunk.sourceCursor <= previous.sourceCursor) {
					return {
						ok: false,
						code: 'SEED_SOURCE_CURSOR_NOT_MONOTONIC',
						message: `seed chunk ${String(chunk.chunkNo)} sourceCursor ${String(chunk.sourceCursor)} does not advance past chunk ${String(previous.chunkNo)} (${String(previous.sourceCursor)})`,
					};
				}
			}
		}
		// Feed the candidate commit through the scanner: this is the single
		// authority for begin presence, chunk contiguity, counts, and the
		// chained root digest.
		scanner.onEntry(input.commitEntry);
		const committed = scanner.scan.last?.commit;
		if (committed === undefined) {
			return {
				ok: false,
				code: 'SEED_IMPORT_STATE_INVALID',
				message: 'the seed scanner did not adopt the candidate commit',
			};
		}
		return { ok: true, commit: committed };
	} catch (error) {
		return {
			ok: false,
			code: 'SEED_IMPORT_STATE_INVALID',
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

// ---------------------------------------------------------------------------
// Pre-commit hook for the pi single-writer composition
// ---------------------------------------------------------------------------

/**
 * Structural mirror of one pi `StorageWrite` (see
 * `@mavis/storage-worker` `PiStorageWriteLike`; declared locally so this
 * module keeps its dependency set — only `@mavis/storage-worker`'s seed size
 * primitive — unchanged).
 */
interface PiWriteLike {
	readonly type: string;
	readonly [key: string]: unknown;
}

/** One seed entry extracted from a pending pi write batch, in write order. */
interface BatchSeedEntry {
	readonly kind: string;
	readonly payload: unknown;
}

/** Options of {@link createSeedPublicationPreCommitHook}. */
export interface SeedPublicationHookOptions {
	/**
	 * Seed entries the durable log already holds (oldest first), read
	 * BEFORE the pending commit is issued. Async on purpose: the composer
	 * typically scans the underlying pi Storage inside the single-writer
	 * gate, where no other write can interleave.
	 */
	readonly readLogSeedEntries: () => Promise<readonly SeedLogEntry[]>;
}

/**
 * Builds the `onBeforeCommit` validator for
 * `gatePiStorageMutations(storage, { onBeforeCommit })`
 * (`@mavis/storage-worker`): every pi write batch containing a
 * `history.v2.seed.commit` entry is validated by
 * {@link verifySeedCommitForPublication} BEFORE the storage commit — a
 * corrupted seed never becomes durable, so nothing is ever published from
 * it. Batches without a seed commit pass through untouched.
 */
export function createSeedPublicationPreCommitHook(
	options: SeedPublicationHookOptions,
): (writes: readonly PiWriteLike[]) => Promise<void> {
	return async (writes: readonly PiWriteLike[]): Promise<void> => {
		const batchSeedEntries: BatchSeedEntry[] = [];
		let commitEntry: BatchSeedEntry | undefined;
		for (const write of writes) {
			if (write.type !== 'entry') continue;
			const value = write.value as { readonly kind?: unknown; readonly data?: unknown } | undefined;
			if (value === undefined || typeof value.kind !== 'string') continue;
			if (
				value.kind !== SEED_BEGIN_KIND &&
				value.kind !== SEED_CHUNK_KIND &&
				value.kind !== SEED_COMMIT_KIND
			) {
				continue;
			}
			const envelope = value.data as BridgeEnvelopeLike | undefined;
			if (
				typeof envelope !== 'object' ||
				envelope === null ||
				envelope.v !== 1 ||
				typeof envelope.mcodeEntryId !== 'string' ||
				!('payload' in envelope)
			) {
				if (value.kind === SEED_COMMIT_KIND) {
					throw new SeedPublicationRejectedError(
						'SEED_COMMIT_ENTRY_MALFORMED',
						`a ${SEED_COMMIT_KIND} entry write does not carry a v1 mcode bridge envelope`,
					);
				}
				continue;
			}
			if (value.kind === SEED_COMMIT_KIND) {
				if (commitEntry !== undefined) {
					throw new SeedPublicationRejectedError(
						'SEED_IMPORT_STATE_INVALID',
						'the commit batch carries more than one seed commit entry',
					);
				}
				commitEntry = { kind: value.kind, payload: envelope.payload };
			} else {
				batchSeedEntries.push({ kind: value.kind, payload: envelope.payload });
			}
		}
		if (commitEntry === undefined) return;
		// Malformed commit payloads are refused here, before any scanner run.
		let parsedCommit: SeedCommitPayload;
		try {
			parsedCommit = asSeedCommitPayload(commitEntry.payload);
		} catch (error) {
			throw new SeedPublicationRejectedError(
				'SEED_COMMIT_ENTRY_MALFORMED',
				error instanceof Error ? error.message : String(error),
			);
		}
		const logSeedEntries = await options.readLogSeedEntries();
		const verdict = verifySeedCommitForPublication({
			logSeedEntries,
			batchSeedEntries,
			commitEntry: { kind: SEED_COMMIT_KIND, payload: parsedCommit },
		});
		if (!verdict.ok) {
			throw new SeedPublicationRejectedError(verdict.code, verdict.message);
		}
	};
}

/** Validation rejection of the seed publication gate; fails the one commit, never poisons the writer gate. */
export class SeedPublicationRejectedError extends Error {
	readonly code: SeedPublicationErrorCode;
	constructor(code: SeedPublicationErrorCode, message: string) {
		super(`Seed publication gate: ${message}`);
		this.name = 'SeedPublicationRejectedError';
		this.code = code;
	}
}
