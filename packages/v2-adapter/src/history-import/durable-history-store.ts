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

import { SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import { createLogger } from '@mavis/logging';
import {
  createStorageWorker,
  sqliteZstdStorageBackend,
  type StorageWorker,
} from '@mavis/storage-worker';

/**
 * Seed protocol events are storage events (R5): the CLI's begin/chunk/commit
 * logs share the registry's `mcode:storage` namespace with the provider's.
 */
const log = createLogger('mcode:storage');

/** Directory of the durable history log inside an explicit durable root. */
export const DURABLE_HISTORY_DIRECTORY = 'durable-history';
/** Per-session log directories live under this subdirectory (owner decision 2026-11-18). */
export const DURABLE_SESSIONS_DIRECTORY = 'sessions';

/**
 * MUST stay byte-identical to the runtime's `safeHistoryPathSegment`
 * (`local-runtime-v2/.../session-history-paths.ts`): the CLI derives the
 * same per-session directory the runtime opens, from the same session id.
 */
function safeHistoryPathSegment(value: string): string {
  return (
    value
      .replaceAll(/[<>:"/\\|?*\u0000-\u001F]/gu, '-')
      .replaceAll(/^\.+/gu, '')
      .slice(0, 180) || 'snapshot'
  );
}

/** Directory of ONE session's own durable log (the runtime's layout). */
export function durableSessionDirectory(durableRoot: string, sessionId: string): string {
  return join(
    durableRoot,
    DURABLE_HISTORY_DIRECTORY,
    DURABLE_SESSIONS_DIRECTORY,
    safeHistoryPathSegment(sessionId),
  );
}

/** Mirrors the provider's `DURABLE_HISTORY_BATCH_CAP_BYTES` (worker admission). */
const BATCH_CAP_BYTES = 8 * 1024 * 1024;
/** Mirrors the provider's `DURABLE_HISTORY_QUEUE_BYTES`. */
const QUEUE_BYTES = 16 * 1024 * 1024;
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
  options?: { readonly sessionId?: string; readonly readonly?: boolean },
): DurableHistoryStore {
  const directory = options?.sessionId
    ? durableSessionDirectory(durableRoot, options.sessionId)
    : durableHistoryDirectory(durableRoot);
  const backend = SqliteZstdBackend.open(directory, {
    maxBatchUncompressedBytes: BATCH_CAP_BYTES,
  });
  const worker = createStorageWorker(sqliteZstdStorageBackend(backend), {
    maxBatchUncompressedBytes: BATCH_CAP_BYTES,
    queueBytes: QUEUE_BYTES,
  });
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
