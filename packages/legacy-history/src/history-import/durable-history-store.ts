/**
 * CLI-side open of one durable-history root for the history import
 * (scripts/history-import.mjs). Mirrors the runtime composition's store open
 * (`createDurableHistoryStorage`): one sqlite-zstd log under
 * `<durable-root>/durable-history`, the same admission caps, one storage
 * worker on top. The import CLI never opens a root implicitly — the caller
 * hands the explicit `--root` directory, and nothing here resolves defaults.
 *
 * @module
 */

import { join } from 'node:path';

import { currentGeneration, SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import { safeHistoryPathSegment } from '@mavis/local-runtime-v2/canonical-history';
import { createLogger } from '@mavis/logging';
import {
  createStorageWorker,
  sqliteZstdStorageBackend,
  type StorageWorker,
} from '@mavis/storage-worker';

import { DURABLE_HISTORY_WORKER_LIMITS } from './seed-protocol.js';

/**
 * Seed protocol events are storage events (R5): the CLI's begin/chunk/commit
 * logs share the registry's `mcode:storage` namespace with the provider's.
 */
const log = createLogger('mcode:storage');

/** Directory of the durable history log inside an explicit durable root. */
export const DURABLE_HISTORY_DIRECTORY = 'durable-history';
/** Per-session log directories live under this subdirectory (owner decision 2026-11-18). */
export const DURABLE_SESSIONS_DIRECTORY = 'sessions';

/** Directory of ONE session's own durable log (the runtime's layout). */
export function durableSessionDirectory(durableRoot: string, sessionId: string): string {
  return join(
    durableRoot,
    DURABLE_HISTORY_DIRECTORY,
    DURABLE_SESSIONS_DIRECTORY,
    safeHistoryPathSegment(sessionId),
  );
}

/** Uncompressed read window of one log-scan step (mirrors the provider). */
const READ_WINDOW_BYTES = 8 * 1024 * 1024;

/** One open durable-history root of an import run. */
export interface DurableHistoryStore {
  readonly durableRoot: string;
  readonly directory: string;
  readonly backend: SqliteZstdBackend;
  readonly worker: StorageWorker;
  /** Drains and disposes the worker, then closes the backend. Idempotent. */
  dispose(): Promise<void>;
}

/** Resolves the log directory inside an explicit durable root. */
export function durableHistoryDirectory(durableRoot: string): string {
  return join(durableRoot, DURABLE_HISTORY_DIRECTORY);
}

/**
 * Opens the durable history log of an EXPLICIT root for an import run.
 * With `sessionId` the import targets the session's OWN per-session file
 * (the runtime's per-session layout); without it, the legacy monolith —
 * the pre-2026-11-18 layout, kept for reads of already-imported roots.
 */
export function openDurableHistoryStore(
  durableRoot: string,
  options?: { readonly sessionId?: string },
): DurableHistoryStore {
  const directory = options?.sessionId
    ? durableSessionDirectory(durableRoot, options.sessionId)
    : durableHistoryDirectory(durableRoot);
  const backend = SqliteZstdBackend.open(directory, {
    maxBatchUncompressedBytes: DURABLE_HISTORY_WORKER_LIMITS.maxBatchUncompressedBytes,
  });
  const worker = createStorageWorker(sqliteZstdStorageBackend(backend), DURABLE_HISTORY_WORKER_LIMITS);
  log.info('import durable history storage opened', {
    directory,
    generation: backend.generation,
    head: backend.head,
  });
  let disposed = false;
  return {
    durableRoot,
    directory,
    backend,
    worker,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await worker.dispose();
      } finally {
        backend.close();
      }
      log.info('import durable history storage closed', { directory });
    },
  };
}

/** Reads the current session log, or the pre-per-session monolith if absent. */
export function openHistoryStoreForVerification(
  durableRoot: string,
  sessionId: string,
): Pick<DurableHistoryStore, 'backend' | 'dispose'> | undefined {
  const candidates = [durableSessionDirectory(durableRoot, sessionId), durableHistoryDirectory(durableRoot)];
  for (const directory of candidates) {
    let generation: number;
    try {
      generation = currentGeneration(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (generation === 0) continue;
    const backend = SqliteZstdBackend.open(directory, { generation, readonly: true });
    return { backend, dispose: async () => backend.close() };
  }
  return undefined;
}

/** One decoded durable log entry, as the CLI's seed scan needs it. */
export interface DurableLogEntry {
  readonly id: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * Reads the whole durable log with the checked read (a torn tail throws —
 * an import never builds on an unverified log).
 */
export async function readDurableLogEntries(backend: SqliteZstdBackend): Promise<DurableLogEntry[]> {
  const entries: DurableLogEntry[] = [];
  let cursor = 0;
  for (;;) {
    const window = backend.readDeltaChecked(cursor, READ_WINDOW_BYTES);
    for (const stored of window.entries) {
      entries.push({ id: stored.id, seq: stored.seq, kind: stored.kind, payload: stored.payload });
    }
    if (window.tornTail !== null) {
      throw new Error(
        `Durable history log has a torn tail at batch ${window.tornTail.batchId} (${window.tornTail.reason})`,
      );
    }
    if (window.nextAfterSeq === null) break;
    cursor = window.nextAfterSeq;
  }
  return entries;
}
