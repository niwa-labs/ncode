/**
 * Import receipts of the history-import CLI (integration plan R6): one JSON
 * document per imported session, stored INSIDE the target durable root —
 * never beside the source, never in any default location.
 *
 * A receipt exists from `begin` with state `pending`, so a crash can be
 * resumed from it; `complete` is written only after the seed commit is
 * durable. The receipt is the convenience cursor: the DURABLE LOG remains the
 * authority for what actually committed (test architecture §10.2) — resume
 * re-derives the confirmed chunk cursor from the log and only cross-checks
 * the receipt's source fingerprint.
 *
 * @module
 */

import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SEED_MAPPING_VERSION } from './seed-protocol.js';

export const RECEIPT_SCHEMA_VERSION = 1 as const;

/** Directory of import receipts inside an explicit durable root. */
export const RECEIPTS_DIRECTORY = 'history-import';

export type HistoryImportReceiptState = 'pending' | 'running' | 'complete' | 'failed';

/** Where the import stopped: the confirmed durable chunk cursor. */
export interface HistoryImportReceiptCursor {
  /** Durable chunks confirmed by a flush (resume skips them). */
  readonly chunkNo: number;
  /** Records covered by the confirmed chunks. */
  readonly records: number;
  /** Digest of the last confirmed chunk (drift probe on resume). */
  readonly digest?: string;
  /** Backend sequence that made the last chunk durable, when reported. */
  readonly backendSeq?: number;
}

export interface HistoryImportReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly source: {
    readonly dir: string;
    readonly messagesPath: string;
    /** Source byte length at fingerprint time. */
    readonly bytes: number;
    /** SHA-256 of the source bytes — resume re-checks it (drift stop). */
    readonly sha256: string;
  };
  readonly durableRoot: string;
  readonly durableDirectory: string;
  readonly casRoot: string;
  readonly mappingVersion: string;
  readonly state: HistoryImportReceiptState;
  readonly importId?: string;
  readonly cursor: HistoryImportReceiptCursor;
  readonly chunks: {
    /** Durable chunk entries, including a begin's confirmed ones. */
    readonly committed: number;
    readonly bytes: number;
    readonly entries: number;
  };
  readonly counts: {
    readonly records: number;
    readonly imagesStored: number;
    readonly imagesInline: number;
  };
  readonly revision?: string;
  readonly rootDigest?: string;
  readonly error?: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs?: number;
}

/** Receipt location INSIDE the explicit durable root. */
export function receiptPath(durableRoot: string, sessionId: string): string {
  return join(durableRoot, RECEIPTS_DIRECTORY, `${sessionId}.receipt.json`);
}

/** Reads a receipt; `undefined` when none exists (never a fabricated one). */
export async function readReceipt(path: string): Promise<HistoryImportReceipt | undefined> {
  let raw: string;
  try {
    const file = await open(path, 'r');
    try {
      raw = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== 'object') {
    throw new Error(`Import receipt is not an object: ${path}`);
  }
  const receipt = value as HistoryImportReceipt;
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `Import receipt schema version ${String(receipt.schemaVersion)} is not supported: ${path}`,
    );
  }
  return receipt;
}

/**
 * Atomically publishes a receipt: temp file, fsync, rename (sidecar
 * checkpoint semantics of test architecture §10.2 — the durable log stays
 * the authority even if this write is lost).
 */
export async function writeReceipt(path: string, receipt: HistoryImportReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.write(`${JSON.stringify(receipt, null, 2)}\n`, null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Source byte length; `undefined` when the file cannot be stated. */
export async function fileSizeBytes(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/** Fresh receipt skeleton at `begin` (state pending, per §10.3). */
export function beginReceipt(input: {
  readonly sessionId: string;
  readonly sourceDir: string;
  readonly messagesPath: string;
  readonly fingerprint: { readonly bytes: number; readonly sha256: string };
  readonly durableRoot: string;
  readonly durableDirectory: string;
  readonly casRoot: string;
  readonly importId: string;
  readonly nowMs: number;
}): HistoryImportReceipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    source: {
      dir: input.sourceDir,
      messagesPath: input.messagesPath,
      bytes: input.fingerprint.bytes,
      sha256: input.fingerprint.sha256,
    },
    durableRoot: input.durableRoot,
    durableDirectory: input.durableDirectory,
    casRoot: input.casRoot,
    mappingVersion: SEED_MAPPING_VERSION,
    state: 'pending',
    importId: input.importId,
    cursor: { chunkNo: 0, records: 0 },
    chunks: { committed: 0, bytes: 0, entries: 0 },
    counts: { records: 0, imagesStored: 0, imagesInline: 0 },
    startedAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };
}
