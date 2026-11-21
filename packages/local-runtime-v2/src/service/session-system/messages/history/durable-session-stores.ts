/**
 * Per-session durable-history stores (owner decision 2026-11-18, "variant 1":
 * the session file is self-sufficient).
 *
 * The ONE-log-per-dataDir model (`sessions.gN.db`, single writer on the whole
 * directory) made any two live runtimes on the same profile mutually
 * exclusive: a `--no-daemon`/isolated run could not boot while mcoded lived,
 * because EVERY turn writes the log (history, driver state, usage). The
 * industry pattern (codex per-thread rollout + flock, deepseek per-session
 * directory + `session.lock`) is what this module implements for us:
 *
 * - `durable-history/sessions/<safe-id>/` — ONE directory per session, holding
 *   its own sqlite-zstd log (`sessions.g1.db`, the backend's canonical file
 *   name) plus its OWN pi composition root (`root-resolver.json` sidecar per
 *   directory). The per-file ownership epoch the backend already enforces
 *   becomes per-SESSION ownership: different sessions may be owned by
 *   different processes; the same session by exactly one.
 * - The legacy monolith `durable-history/sessions.gN.db` stops being the
 *   history destination. It stays as (a) a READ-ONLY source while a session
 *   has no file of its own yet (the provider seeds the session file on the
 *   first write — see the durable-canonical-history provider) and (b) the
 *   SYSTEM log of runtimes that own scheduling/delegation (`ownsSystemRoot`:
 *   the mcoded daemon). Nothing else writes it.
 * - `worker` is a ROUTING storage worker: an entry whose id carries a
 *   `<sessionId>|` prefix rides that session's worker (opening the session
 *   file lazily — the claiming moment); every other entry (control records
 *   such as the `mcode.usage` billing mirror) belongs to the system log and
 *   fails closed when this runtime owns none.
 *
 * The turn driver's pi port, the checkpoint barrier flush, the usage mirror
 * and the canonical-history provider all keep their shapes; only the target
 * of each write becomes session-scoped.
 *
 * @module
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createLogger } from '@mavis/logging';
import {
  currentGeneration,
  OwnerWriteLockError,
  SqliteZstdBackend,
} from '@mavis/durable-backend-sqlite-zstd';
import {
  createStorageWorker,
  gatedStorageWorkerBackend,
  sqliteZstdStorageBackend,
  type Commit,
  type Entry,
  type StorageWorker,
} from '@mavis/storage-worker';

import { openPiDurableCompositionRoot, type PiDurableCompositionRoot } from './pi-durable-root.js';
import { safeHistoryPathSegment } from './session-history-paths.js';

const log = createLogger('mcode:storage');

/** Batch caps mirror the previous ONE-log composition (8 MiB batches, 16 MiB queue). */
const DURABLE_HISTORY_BATCH_CAP_BYTES = 8 * 1024 * 1024;
const DURABLE_HISTORY_QUEUE_BYTES = 16 * 1024 * 1024;

/**
 * Bounded wait for a competing writer of ONE log; the same
 * transient-overlap/fail-fast policy the single log had (see the provider's
 * `OPEN_OWNER_WAIT_TIMEOUT_MS` for the full rationale — rotation and steal
 * stay forbidden for exactly the same reasons, now per file).
 */
const OWNER_WAIT_TIMEOUT_MS = 2_000;
const OWNER_WAIT_INTERVAL_MS = 250;

/** The backend handle type of one opened sqlite-zstd log. */
type DurableBackend = ReturnType<typeof SqliteZstdBackend.open>;

/**
 * The session's durable log is owned by a LIVE runtime in another process:
 * this open waited out the ownership window and refused (never rotating,
 * never stealing). Extends the backend's refusal type so existing catch
 * sites keep matching; the message names the SESSION, because with
 * per-session files that is the exact unit of contention.
 */
export class DurableSessionLogOwnedError extends OwnerWriteLockError {
  readonly sessionId: string;
  readonly sessionDirectory: string;
  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly sessionId: string;
      readonly sessionDirectory: string;
      readonly ownerPid?: number;
      readonly ownerInstance?: string;
    },
  ) {
    super(message, {
      cause: options.cause,
      ...(options.ownerPid !== undefined || options.ownerInstance !== undefined
        ? {
            owner: {
              ...(options.ownerPid !== undefined ? { pid: options.ownerPid } : {}),
              ...(options.ownerInstance !== undefined ? { instance: options.ownerInstance } : {}),
            },
          }
        : {}),
    });
    this.name = 'DurableSessionLogOwnedError';
    this.sessionId = options.sessionId;
    this.sessionDirectory = options.sessionDirectory;
  }
}

/**
 * The SYSTEM log of this data dir is owned by a LIVE mcode runtime (a second
 * daemon started against the same data dir): the open waited out the
 * ownership window and refused instead of rotating or stealing. Carries the
 * same identity the single-log era had (`DurableHistoryLogOwnedError`), so
 * existing catch sites keep matching.
 */
export class DurableHistoryLogOwnedError extends OwnerWriteLockError {
  readonly directory: string;
  readonly generation: number;
  readonly ownerPid: number | undefined;
  readonly ownerInstance: string | undefined;
  readonly waitedMs: number;
  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly directory: string;
      readonly generation: number;
      readonly ownerPid?: number;
      readonly ownerInstance?: string;
      /** How long this open waited before refusing. */
      readonly waitedMs: number;
    },
  ) {
    super(message, {
      cause: options.cause,
      ...(options.ownerPid !== undefined || options.ownerInstance !== undefined
        ? {
            owner: {
              ...(options.ownerPid !== undefined ? { pid: options.ownerPid } : {}),
              ...(options.ownerInstance !== undefined ? { instance: options.ownerInstance } : {}),
            },
          }
        : {}),
    });
    this.name = 'DurableHistoryLogOwnedError';
    this.directory = options.directory;
    this.generation = options.generation;
    this.ownerPid = options.ownerPid;
    this.ownerInstance = options.ownerInstance;
    this.waitedMs = options.waitedMs;
  }
}

/** The per-session composition: backend + pi root + worker, one directory. */
export interface SessionDurableStores {
  readonly sessionId: string;
  readonly directory: string;
  readonly backend: DurableBackend;
  readonly pi: PiDurableCompositionRoot;
  readonly worker: StorageWorker;
}

/** The system (shared) log of scheduling/delegation-owning runtimes. */
export interface DurableSystemStores {
  readonly directory: string;
  readonly backend: DurableBackend;
  readonly pi: PiDurableCompositionRoot;
  readonly worker: StorageWorker;
}

export interface DurableHistoryStores {
  /** Root `durable-history` directory (fold-cache lives here, unchanged). */
  readonly directory: string;
  /** Routing worker: `<sessionId>|`-prefixed entries → the session's worker. */
  readonly worker: StorageWorker;
  /** Present only when this runtime owns the system log (the mcoded daemon). */
  readonly system?: DurableSystemStores;
  /**
   * Opens (and claims ownership of) the session's own log; cached per
   * runtime. The claim is the per-session exclusion point: a second process
   * holding THIS session fails fast with
   * {@link DurableSessionLogOwnedError}; every other session is unaffected.
   */
  sessionStores(sessionId: string): Promise<SessionDurableStores>;
  /**
   * The backend a READ of this session should scan: the session's own file
   * when it exists (or is already open), otherwise the legacy monolith in
   * read-only mode. `undefined` when neither exists (a fresh session — the
   * caller treats the fold as empty without probing).
   */
  backendForRead(sessionId: string): Promise<DurableBackend | undefined>;
  /** True while the session has no file of its own (its data, if any, is legacy). */
  hasSessionFile(sessionId: string): boolean;
  /**
   * Sync access to an ALREADY-OPEN session root (the turn driver binds after
   * the provider's ensureState opened the session). Fail-closed: a miss is a
   * composition-order bug, never a lazy surprise.
   */
  piOf(sessionId: string): PiDurableCompositionRoot;
  /** Drains every live worker (sessions + system). */
  flush(): Promise<void>;
  /** Disposes every worker and closes every backend this runtime opened. */
  dispose(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Directory of one session's own log. */
function sessionDirectoryOf(sessionsRoot: string, sessionId: string): string {
  return join(sessionsRoot, safeHistoryPathSegment(sessionId));
}

function openGatedWorker(backend: DurableBackend, gate: PiDurableCompositionRoot['gate']): StorageWorker {
  // The worker rides the pi gate exactly like the previous composition
  // (`composeGatedDurableHistoryWorkerBackend`): one gate per file, worker
  // appends and pi commits structurally serialized.
  return createStorageWorker(gatedStorageWorkerBackend(sqliteZstdStorageBackend(backend), gate), {
    maxBatchUncompressedBytes: DURABLE_HISTORY_BATCH_CAP_BYTES,
    queueBytes: DURABLE_HISTORY_QUEUE_BYTES,
  });
}

/**
 * Opens the per-session durable stores of a data dir. `ownsSystemRoot` is the
 * daemon gate: only the mcoded daemon (the runtime that owns scheduling and
 * delegation) opens the shared monolith writable; every other runtime
 * (embedded TUI/exec/ACP, isolated wrapper runs) touches nothing shared —
 * its writes land in the session files alone.
 */
export async function createDurableHistoryStores(options: {
  readonly dataDir: string;
  readonly ownsSystemRoot: boolean;
  /** Test seam: the per-file ownership wait override. */
  readonly ownerWaitTimeoutMs?: number;
}): Promise<DurableHistoryStores> {
  const directory = join(options.dataDir, 'durable-history');
  const sessionsRoot = join(directory, 'sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const waitMs = options.ownerWaitTimeoutMs ?? OWNER_WAIT_TIMEOUT_MS;

  // -- system (shared) log: only scheduling/delegation owners open it -------
  let system: DurableSystemStores | undefined;
  if (options.ownsSystemRoot) {
    const backend = await openWaitingForOwnership(directory, waitMs, (refusal, waitedMs) =>
      wrapSystemRefusal(directory, refusal, waitedMs),
    );
    const pi = await openPiDurableCompositionRoot({ backend, directory });
    const worker = openGatedWorker(backend, pi.gate);
    system = { directory, backend, pi, worker };
    log.info('durable system log opened (this runtime owns scheduling/delegation)', {
      directory,
      generation: backend.generation,
      head: backend.head,
    });
  }

  // -- per-session stores, lazily opened and cached --------------------------
  const sessions = new Map<string, SessionDurableStores>();
  const opening = new Map<string, Promise<SessionDurableStores>>();

  async function openSessionStores(sessionId: string): Promise<SessionDurableStores> {
    if (disposed) {
      throw new Error(
        `durable session stores are disposed; session ${sessionId} cannot be opened (a caller raced the runtime shutdown)`,
      );
    }
    const cached = sessions.get(sessionId);
    if (cached) return cached;
    const pending = opening.get(sessionId);
    if (pending) return pending;
    const created = (async () => {
      const sessionDirectory = sessionDirectoryOf(sessionsRoot, sessionId);
      mkdirSync(sessionDirectory, { recursive: true });
      const backend = await openWaitingForOwnership(sessionDirectory, waitMs, (refusal) =>
        wrapSessionRefusal(sessionId, sessionDirectory, refusal),
      );
      const pi = await openPiDurableCompositionRoot({ backend, directory: sessionDirectory });
      const worker = openGatedWorker(backend, pi.gate);
      const stores: SessionDurableStores = { sessionId, directory: sessionDirectory, backend, pi, worker };
      sessions.set(sessionId, stores);
      return stores;
    })();
    opening.set(sessionId, created);
    try {
      return await created;
    } finally {
      opening.delete(sessionId);
    }
  }

  function hasSessionFileOnDisk(sessionId: string): boolean {
    // The DB FILE, not the directory: a claim may have created the directory
    // (and even an empty g1) before the session's data was seeded — the
    // presence of a database alone must not hide the legacy monolith reads.
    // An empty-but-created file is indistinguishable this way, so the CLAIM
    // order in the provider is what protects legacy reads: it happens AFTER
    // the legacy fold was loaded (see ensureState).
    try {
      return currentGeneration(sessionDirectoryOf(sessionsRoot, sessionId)) >= 1;
    } catch {
      return false;
    }
  }

  // -- legacy monolith: read-only source until a session file exists ---------
  let legacyBackend: DurableBackend | undefined;
  let legacyTried = false;
  function legacyBackendOrNull(): DurableBackend | undefined {
    if (legacyTried) return legacyBackend;
    legacyTried = true;
    try {
      if (currentGeneration(directory) < 1) {
        // No monolith on this data dir (a fresh install): nothing to read.
        return undefined;
      }
      legacyBackend = SqliteZstdBackend.open(directory, { readonly: true });
    } catch (error) {
      // A present-but-unopenable monolith is corruption, not absence — let it
      // surface (the caller's scan fails loudly instead of silently treating
      // the session as empty).
      throw error;
    }
    return legacyBackend;
  }

  // -- routing worker ---------------------------------------------------------
  const routing: StorageWorker = {
    async enqueue(entry: Entry): Promise<void> {
      const sessionId = sessionKeyOfEntry(entry);
      if (sessionId === undefined) {
        if (!system) {
          throw new Error(
            `control entry ${entry.entryId} (kind ${entry.kind}) has no session key and this runtime owns no system log; ` +
              'the entry is not durably recordable here (embedded runtimes record session history only)',
          );
        }
        await system.worker.enqueue(entry);
        return;
      }
      await (await openSessionStores(sessionId)).worker.enqueue(entry);
    },
    async flush(): Promise<Commit | null> {
      let last: Commit | null = null;
      if (system) last = (await system.worker.flush()) ?? last;
      for (const stores of sessions.values()) {
        last = (await stores.worker.flush()) ?? last;
      }
      return last;
    },
    async checkpoint(): Promise<void> {
      if (system) await system.worker.checkpoint();
      for (const stores of sessions.values()) {
        await stores.worker.checkpoint();
      }
    },
    get quarantined(): readonly Entry[] {
      const all: Entry[] = [];
      if (system) all.push(...system.worker.quarantined);
      for (const stores of sessions.values()) all.push(...stores.worker.quarantined);
      return all;
    },
    async dispose(): Promise<void> {
      /* the stores facade owns disposal; the routing view has no own state. */
    },
  };

  let disposed = false;
  return {
    directory,
    worker: routing,
    ...(system ? { system } : {}),
    sessionStores: openSessionStores,
    async backendForRead(sessionId) {
      if (sessions.has(sessionId) || hasSessionFileOnDisk(sessionId)) {
        return (await openSessionStores(sessionId)).backend;
      }
      return legacyBackendOrNull();
    },
    hasSessionFile(sessionId: string): boolean {
      return sessions.has(sessionId) || hasSessionFileOnDisk(sessionId);
    },
    piOf(sessionId: string): PiDurableCompositionRoot {
      const cached = sessions.get(sessionId);
      if (!cached) {
        throw new Error(
          `session ${sessionId} durable root is not open; the provider's ensureState must run before the turn driver binds (composition order bug)`,
        );
      }
      return cached.pi;
    },
    async flush(): Promise<void> {
      await routing.flush();
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      for (const [sessionId, stores] of sessions) {
        try {
          await stores.worker.dispose();
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            stores.backend.close();
          } catch (error) {
            failures.push(error);
          }
          sessions.delete(sessionId);
        }
      }
      if (system) {
        try {
          await system.worker.dispose();
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            system.backend.close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      try {
        legacyBackend?.close();
      } catch {
        /* a read-only handle failing to close is not a durability concern. */
      }
      if (failures.length > 0) {
        throw new Error(
          `durable session stores disposal failed (${String(failures.length)} failure(s)); first: ${
            failures[0] instanceof Error ? (failures[0] as Error).message : String(failures[0])
          }`,
        );
      }
      log.info('durable session stores closed', { directory });
    },
  };
}

/**
 * The `<sessionId>|` prefix every durable-history entry id carries (appends,
 * compaction events, seeds, repairs, offloads, tombstones — the provider's
 * id builders). Returns `undefined` for control entries without a session
 * key (they belong to the system log).
 */
function sessionKeyOfEntry(entry: Entry): string | undefined {
  const separator = entry.entryId.indexOf('|');
  if (separator <= 0) return undefined;
  const key = entry.entryId.slice(0, separator);
  return key.length > 0 ? key : undefined;
}

/**
 * The generic ownership-waiting open (the single-log policy, parameterized by
 * the refusal wrapper so the system log keeps its legacy error identity).
 */
async function openWaitingForOwnership(
  directory: string,
  waitMs: number,
  wrapRefusal: (refusal: OwnerWriteLockError, waitedMs: number) => Error,
): Promise<DurableBackend> {
  const startedAtMs = Date.now();
  const deadline = startedAtMs + waitMs;
  for (;;) {
    let refusal: OwnerWriteLockError | undefined;
    try {
      return SqliteZstdBackend.open(directory, {
        maxBatchUncompressedBytes: DURABLE_HISTORY_BATCH_CAP_BYTES,
      });
    } catch (error) {
      if (!(error instanceof OwnerWriteLockError)) throw error;
      refusal = error;
    }
    if (Date.now() >= deadline) throw wrapRefusal(refusal, Date.now() - startedAtMs);
    await delay(Math.min(OWNER_WAIT_INTERVAL_MS, deadline - Date.now()));
  }
}

function wrapSystemRefusal(directory: string, refusal: OwnerWriteLockError, waitedMs: number): Error {
  const generation = safeGenerationOf(directory);
  log.warn('durable system log owned by a live mcode instance; refusing to open', {
    directory,
    generation,
    ownerPid: refusal.ownerPid,
    ownerInstance: refusal.ownerInstance,
    waitedMs,
  });
  return new DurableHistoryLogOwnedError(
    `${refusal.message}; the durable system log of ${directory} is owned by a live mcode runtime ` +
      `(pid ${String(refusal.ownerPid)}) — a second daemon cannot start against the same data dir. ` +
      'Stop the other daemon first: mcode daemon stop.',
    {
      cause: refusal,
      directory,
      generation,
      waitedMs,
      ...(refusal.ownerPid !== undefined ? { ownerPid: refusal.ownerPid } : {}),
      ...(refusal.ownerInstance !== undefined ? { ownerInstance: refusal.ownerInstance } : {}),
    },
  );
}

function wrapSessionRefusal(
  sessionId: string,
  sessionDirectory: string,
  refusal: OwnerWriteLockError,
): Error {
  log.warn('durable session log owned by a live mcode instance; refusing to open', {
    sessionId,
    sessionDirectory,
    ownerPid: refusal.ownerPid,
    ownerInstance: refusal.ownerInstance,
  });
  return new DurableSessionLogOwnedError(
    `${refusal.message}; the durable log of session ${sessionId} is owned by a live mcode runtime ` +
      `(pid ${String(refusal.ownerPid)}${refusal.ownerInstance === undefined ? '' : `, instance ${refusal.ownerInstance}`}) — ` +
      'a second process cannot write THIS session while the first one runs. ' +
      'Resume it in the owning runtime, or wait for that runtime to close the session.',
    {
      cause: refusal,
      sessionId,
      sessionDirectory,
      ...(refusal.ownerPid !== undefined ? { ownerPid: refusal.ownerPid } : {}),
      ...(refusal.ownerInstance !== undefined ? { ownerInstance: refusal.ownerInstance } : {}),
    },
  );
}

function safeGenerationOf(directory: string): number {
  try {
    return Math.max(currentGeneration(directory), 1);
  } catch {
    return 1;
  }
}
