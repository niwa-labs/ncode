/**
 * Adapter from the wave-1 `sqlite-zstd` durable backend to the seam's
 * storage port. This is the ONLY module of the package that knows the
 * backend; the seam core stays port-shaped and testable against any log.
 *
 * The backend is imported TYPE-only: the adapter receives the backend
 * instance structurally and never loads it at runtime, so the seam can be
 * composed over whatever object upholds the storage contract
 * (`SqliteZstdBackend` today). Backend errors are recognized structurally
 * (by class name) and mapped into the seam hierarchy:
 *
 * - backend `OwnerLostError` → seam `OWNER_LOST` (single-writer fencing;
 *   the epoch is re-checked inside every backend commit transaction);
 * - `SealedGenerationError` → `GENERATION_SEALED`;
 * - `DuplicateEntryError` (deterministic-entry-id collision) →
 *   `ENTRY_ID_COLLISION`;
 * - anything else → `STORAGE_FAILURE` with the original as `cause`.
 *
 * @module
 */

import { createLogger } from '@mavis/logging';
import { SeamError, SeamOwnerLostError, SeamStorageError } from './errors.js';
import type { DurableLogPort, PortCommit, PortDelta, PortEntry, PortEntryDraft } from './port.js';

/** Same namespace as the seam core (spec §4); module-level singleton. */
const log = createLogger('mcode:seam');

/**
 * Minimal structural shape of the wave-1 backend this adapter reads.
 * `SqliteZstdBackend` satisfies it as-is; a test double may too.
 */
export interface SqliteZstdBackendLike {
	appendBatch(
		entries: readonly { readonly id: string; readonly kind: string; readonly payload: unknown }[],
	): Promise<{ readonly seq: number; readonly head: number; readonly entryCount: number }>;
	getEntry(entryId: string): { readonly id: string; readonly kind: string; readonly payload: unknown; readonly seq: number; readonly ordinal: number } | undefined;
	readDeltaChecked(
		afterSeq: number,
		limitBytes: number,
	): {
		readonly entries: readonly { readonly id: string; readonly kind: string; readonly payload: unknown; readonly seq: number; readonly ordinal: number }[];
		readonly nextAfterSeq: number | null;
		readonly tornTail: { readonly batchId: number; readonly reason: string } | null;
	};
	readonly head: number;
	readonly maxBatchUncompressedBytes: number;
}

/** Wrap a `SqliteZstdBackend` (or structural equivalent) as a seam port. */
export function sqliteZstdDurableLogPort(backend: SqliteZstdBackendLike): DurableLogPort {
	return {
		async appendBatch(entries: readonly PortEntryDraft[]): Promise<PortCommit> {
			const startedMs = Date.now();
			try {
				const commit = await backend.appendBatch(entries);
				// Append proxy (spec §4 mcode:seam): timing around the storage
				// call itself.
				log.debug('port appendBatch committed', {
					entries: entries.length,
					seq: commit.seq,
					head: commit.head,
					durationMs: Date.now() - startedMs,
				});
				return { seq: commit.seq, head: commit.head, entryCount: commit.entryCount };
			} catch (error) {
				throw mapBackendError(error, 'appendBatch');
			}
		},
		getEntry(entryId: string): PortEntry | undefined {
			try {
				const entry = backend.getEntry(entryId);
				return entry === undefined ? undefined : toPortEntry(entry);
			} catch (error) {
				throw mapBackendError(error, 'getEntry');
			}
		},
		readDeltaChecked(afterSeq: number, limitBytes: number): PortDelta {
			try {
				const delta = backend.readDeltaChecked(afterSeq, limitBytes);
				// Windowed read (spec §4 mcode:seam "чтение"): one log per window.
				if (delta.tornTail !== null) {
					log.warn('port readDeltaChecked stopped on a torn tail', {
						batchId: delta.tornTail.batchId,
						reason: delta.tornTail.reason,
						entries: delta.entries.length,
						afterSeq,
					});
				}
				log.debug('port readDeltaChecked', {
					entries: delta.entries.length,
					nextAfterSeq: delta.nextAfterSeq,
					torn: delta.tornTail !== null,
					afterSeq,
				});
				return {
					entries: delta.entries.map(toPortEntry),
					nextAfterSeq: delta.nextAfterSeq,
					tornTail: delta.tornTail,
				};
			} catch (error) {
				throw mapBackendError(error, 'readDeltaChecked');
			}
		},
		head(): number {
			try {
				return backend.head;
			} catch (error) {
				throw mapBackendError(error, 'head');
			}
		},
		maxBatchBytes(): number | null {
			try {
				return backend.maxBatchUncompressedBytes;
			} catch (error) {
				throw mapBackendError(error, 'maxBatchBytes');
			}
		},
	};
}

type AnyBackendEntry = {
	readonly id: string;
	readonly kind: string;
	readonly payload: unknown;
	readonly seq: number;
	readonly ordinal: number;
};

function toPortEntry(entry: AnyBackendEntry): PortEntry {
	return { id: entry.id, kind: entry.kind, payload: entry.payload as PortEntry['payload'], seq: entry.seq, ordinal: entry.ordinal };
}

/**
 * Map a storage-contract error into the seam hierarchy. Recognition is
 * structural (the backend class is deliberately not loaded at runtime).
 * Every mapped failure is fail-closed for the caller, so it is logged at
 * `error` with the original error (spec §5) before the throw.
 */
function mapBackendError(error: unknown, op: string): unknown {
	if (error instanceof SeamError) return error;
	const name = error instanceof Error ? error.name : '';
	let mapped: unknown;
	if (name === 'OwnerLostError') {
		mapped = new SeamOwnerLostError(error instanceof Error ? error.message : 'the storage owner epoch moved', {
			cause: error,
		});
	} else if (name === 'SealedGenerationError') {
		mapped = new SeamStorageError('GENERATION_SEALED', error instanceof Error ? error.message : 'the generation is sealed', {
			cause: error,
		});
	} else if (name === 'DuplicateEntryError') {
		mapped = new SeamStorageError(
			'ENTRY_ID_COLLISION',
			error instanceof Error ? error.message : 'a deterministic seam entry id already exists',
			{ cause: error },
		);
	} else {
		mapped = new SeamStorageError('STORAGE_FAILURE', error instanceof Error ? error.message : String(error), { cause: error });
	}
	log.error('seam storage call failed', {
		op,
		code: (mapped as SeamStorageError).code,
		err: error instanceof Error ? error : new Error(String(error)),
	});
	return mapped;
}
