import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PiSqliteZstdStorage,
  type SqliteZstdBackend,
} from '@mavis/durable-backend-sqlite-zstd';
import {
  openPiStorageDurableLogPort,
  type PiStorageLogPort,
} from '@mavis/durable-seam';
import {
  createSingleWriterGate,
  gatePiStorageMutations,
  gatedStorageWorkerBackend,
  sqliteZstdStorageBackend,
  type SingleWriterGate,
} from '@mavis/storage-worker';
import { createLogger } from '@mavis/logging';

const log = createLogger('mcode:storage');

/**
 * W10 Part A — runtime composition of the root resolver (W02 readiness
 * transfer, state/w02.md "Readiness transfer" item 1).
 *
 * The runtime's ONE `SqliteZstdBackend` (Ш1) gains its full pi Storage layer:
 * `PiSqliteZstdStorage` opens over the same backend, every mutation — pi
 * commits, id mints AND the history worker's own appends — is fenced through
 * ONE `SingleWriterGate` (`gatePiStorageMutations` +
 * `gatedStorageWorkerBackend`, the composition proven by W02's
 * pi-seed-full-cycle e2e), and the seam's `DurableLogPort` opens over the
 * gated storage. The port's `bridgedConversationId` is persisted BESIDE the
 * durable root (atomic sidecar next to `sessions.gN.db`) and fed back as
 * `options.conversationId` on reopen — the W02 root-resolver contract, now
 * executed by the runtime composition instead of tests only.
 *
 * Failure policy (plan W10-C "no silent downgrade", "no implicit old data
 * writes"): a sidecar that cannot be read/validated fails the composition
 * OPEN (clear error, recovery documented below) instead of silently minting
 * a fresh bridge root; a sidecar WRITE failure after a fresh mint also fails
 * the open — the runtime never serves a root it could not persist.
 *
 * Recovery (runbook): `root-resolver.json` corrupt while the log is intact —
 * restore the sidecar from the log's bridge conversation id, or, as an
 * explicit operator action, delete the sidecar to start a NEW bridge root
 * (entries of the old one stay readable through the same storage but are no
 * longer the port's log).
 *
 * @module
 */

/** Sidecar file name, colocated with the durable root log. */
export const PI_DURABLE_ROOT_SIDECAR = 'root-resolver.json';

/** The deterministic open-time root marker entry (mints the bridge conversation). */
export const ROOT_MARKER_ENTRY_KIND = 'mcode.runtime-root.v1';
export const ROOT_MARKER_ENTRY_ID = 'mcode.runtime-root.v1:root';

const SIDECAR_VERSION = 1;

interface RootResolverSidecar {
  readonly version: number;
  readonly bridgedConversationId: number;
}

/** Error thrown when the persisted root resolver cannot be honored (fail-closed). */
export class PiDurableRootError extends Error {
  override name = 'PiDurableRootError';
  constructor(
    readonly code: 'SIDECAR_INVALID' | 'SIDECAR_PERSIST_FAILED',
    message: string,
  ) {
    super(message);
  }
}

export interface OpenPiDurableCompositionRootOptions {
  /** The ONE backend of the runtime (Ш1); the pi layer opens over it. */
  readonly backend: SqliteZstdBackend;
  /** Directory holding `sessions.gN.db`; the sidecar is written here. */
  readonly directory: string;
  /**
   * Pre-commit validator for pi writes (W02 `legacy-history` CAS hook in the
   * full composition); omitted validators skip the hook. A rejection fails
   * the offending commit only.
   */
  readonly onBeforeCommit?: (writes: readonly unknown[]) => Promise<void>;
  /** Post-commit publication hook (§2.5.2); failures never un-commit. */
  readonly onCommitted?: (seq: number) => void;
}

/**
 * The pi Storage composition root of one runtime. Owned by the Ш1
 * `DurableHistoryStorage`; the storage `dispose()` closes the backend AFTER
 * the worker drains — this root adds no separate close on purpose (calling
 * `PiSqliteZstdStorage.close()` would close the shared backend twice).
 */
export interface PiDurableCompositionRoot {
  /** The ONE mutation gate (pi commits, mints, worker appends). */
  readonly gate: SingleWriterGate;
  /** The full pi Storage over the backend; commit/mintId gated. */
  readonly storage: PiSqliteZstdStorage;
  /** The seam port over the gated storage (driver store, orchestration). */
  readonly port: PiStorageLogPort;
  /**
   * The persisted bridge conversation (root-resolver contract); non-null
   * once the log has at least one entry.
   */
  readonly bridgedConversationId: number | null;
}

/**
 * Opens the runtime's pi Storage root: gated storage + seam port +
 * `bridgedConversationId` persistence/reopen. The composition order mirrors
 * the W02 seed-full-cycle proof exactly; the history worker rides the SAME
 * gate through {@link composeGatedDurableHistoryWorkerBackend}.
 */
export async function openPiDurableCompositionRoot(
  options: OpenPiDurableCompositionRootOptions,
): Promise<PiDurableCompositionRoot> {
  const sidecarPath = join(options.directory, PI_DURABLE_ROOT_SIDECAR);
  const persisted = await readRootSidecar(sidecarPath);
  const storage = PiSqliteZstdStorage.open(options.backend);
  const gate = createSingleWriterGate();
  const gated = gatePiStorageMutations(
    storage,
    {
      ...(options.onBeforeCommit
        ? { onBeforeCommit: options.onBeforeCommit as never }
        : {}),
      ...(options.onCommitted
        ? { onCommitted: (seq: number) => options.onCommitted?.(seq) }
        : {}),
    },
    gate,
  );
  const port = await openPiStorageDurableLogPort(gated as never, {
    ...(persisted !== null ? { conversationId: persisted.bridgedConversationId } : {}),
  });
  // Fresh storage: mint the bridge conversation NOW with a deterministic
  // root marker so the sidecar is persisted at open (never serve an
  // unpersisted root later — the port would otherwise mint lazily on the
  // first product append with nobody around to persist the id).
  if (port.bridgedConversationId === null) {
    await port.appendBatch([
      { id: ROOT_MARKER_ENTRY_ID, kind: ROOT_MARKER_ENTRY_KIND, payload: {} as never },
    ]);
  }
  const bridged = port.bridgedConversationId;
  if (bridged === null) {
    throw new PiDurableRootError(
      'SIDECAR_PERSIST_FAILED',
      'The bridge conversation was not minted at open (root marker append did not commit)',
    );
  }
  if (persisted?.bridgedConversationId !== bridged) {
    try {
      await writeRootSidecar(sidecarPath, bridged);
    } catch (error) {
      throw new PiDurableRootError(
        'SIDECAR_PERSIST_FAILED',
        `Failed to persist ${PI_DURABLE_ROOT_SIDECAR} for bridge conversation ${bridged}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  log.info('pi durable composition root opened', {
    directory: options.directory,
    bridgedConversationId: bridged,
    reopened: persisted !== null,
  });
  return {
    gate,
    storage,
    port,
    get bridgedConversationId(): number | null {
      return port.bridgedConversationId;
    },
  };
}

/**
 * The worker backend whose `appendBatch` shares the pi gate — the W02
 * `gatedStorageWorkerBackend` composition applied to the product Ш1
 * storage, so worker entry batches and pi record commits are structurally
 * serialized on ONE physical storage (I01). `checkpoint` stays ungated.
 */
export function composeGatedDurableHistoryWorkerBackend(
  backend: SqliteZstdBackend,
  gate: SingleWriterGate,
) {
  return gatedStorageWorkerBackend(sqliteZstdStorageBackend(backend), gate);
}

async function readRootSidecar(path: string): Promise<RootResolverSidecar | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new PiDurableRootError(
      'SIDECAR_INVALID',
      `Failed to read ${PI_DURABLE_ROOT_SIDECAR}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new PiDurableRootError(
      'SIDECAR_INVALID',
      `${PI_DURABLE_ROOT_SIDECAR} is not valid JSON (recovery: restore it beside the durable root or delete it to start a new bridge root): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as RootResolverSidecar).version !== SIDECAR_VERSION ||
    !Number.isSafeInteger((parsed as RootResolverSidecar).bridgedConversationId) ||
    (parsed as RootResolverSidecar).bridgedConversationId <= 0
  ) {
    throw new PiDurableRootError(
      'SIDECAR_INVALID',
      `${PI_DURABLE_ROOT_SIDECAR} has an unrecognized shape (expected version ${SIDECAR_VERSION} and a positive bridgedConversationId)`,
    );
  }
  return parsed as RootResolverSidecar;
}

/** Atomic sidecar write (temp file + rename); `randomUUID` disambiguates writers. */
async function writeRootSidecar(path: string, bridgedConversationId: number): Promise<void> {
  const payload = JSON.stringify({
    version: SIDECAR_VERSION,
    bridgedConversationId,
  } satisfies RootResolverSidecar);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
