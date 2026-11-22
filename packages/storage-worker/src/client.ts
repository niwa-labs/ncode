/**
 * Main-thread side of the storage worker.
 *
 * NOTE: this backend-on-main-thread bridge is NOT the production default —
 * `createOffThreadStorageWorker` is (the worker thread there owns the backend
 * handle, so serialization + compression + fsync never run on the caller's
 * thread, and batches cross the boundary once instead of twice). Use this
 * host only when the backend handle must stay on the creating thread.
 *
 * `createStorageWorker(backend)` returns a handle whose `enqueue` only writes
 * to an internal byte-bounded queue (sub-millisecond) while a worker thread
 * owns the batch-window policy. Entries are pumped to the worker thread; the
 * worker cuts them into batches (<= 200 ms / <= 256 KiB, single-flight) and
 * asks this thread to run `backend.appendBatch` — exactly one call per batch,
 * never two in flight. The backend handle itself always stays on the thread
 * that created it.
 *
 * Admission is terminal for entries that can never be persisted: an entry
 * whose `bytes` exceed the backend batch cap is rejected by `enqueue`
 * immediately instead of wedging the retry loop forever.
 *
 * Entries cross the thread boundary with their plain-`ArrayBuffer` payloads
 * TRANSFERRED, not copied (OPT-B1): ownership moves once, and on a failed
 * append the buffers ride the rejection back so the engine's retained retry
 * copy stays intact.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

import { createLogger } from '@mavis/logging';

import { EntryExceedsBatchCapError, deserializeWorkerError, serializeWorkerError, type SerializedWorkerError } from './errors.js';
import type {
  Commit,
  Entry,
  StorageWorker,
  StorageWorkerBackend,
  StorageWorkerOptions,
} from './contracts.js';
import { createBoundedByteQueue } from './queue.js';
import {
  appendBoundedQuarantine,
  collectTransferableBuffers,
  restoreTransferredBuffers,
} from './engine.js';
import {
  DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES,
  DEFAULT_WINDOW_BYTES,
  DEFAULT_WINDOW_MS,
} from './worker.js';

const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES = 3;

// Messages this thread posts to the worker: entry pump, flush requests, and
// the replies to the worker's append/checkpoint requests (the backend runs
// here). Errors travel as `SerializedWorkerError` shapes so their class,
// fields, and cause survive the boundary.
type ClientToWorkerMessage =
  | { type: 'entries'; entries: Entry[] }
  | { type: 'flush'; requestId: number }
  | { type: 'checkpoint'; requestId: number }
  | { type: 'appendResult'; requestId: number; commit: Commit }
  | { type: 'appendError'; requestId: number; error: SerializedWorkerError; returnedBuffers?: ArrayBuffer[] }
  | { type: 'checkpointResult'; requestId: number; commit: Commit | null }
  | { type: 'checkpointError'; requestId: number; error: SerializedWorkerError };

// Messages the worker posts to this thread: batch append and checkpoint
// requests, quarantine reports, and the replies to flush requests.
type WorkerToMainMessage =
  | { type: 'append'; requestId: number; entries: Entry[] }
  | { type: 'checkpoint'; requestId: number }
  | { type: 'flushResult'; requestId: number; commit: Commit | null }
  | { type: 'flushError'; requestId: number; error: SerializedWorkerError }
  | { type: 'terminalError'; error: SerializedWorkerError }
  | { type: 'quarantined'; entries: Entry[]; error: SerializedWorkerError };

interface PendingFlush {
  resolve(commit: Commit | null): void;
  reject(error: unknown): void;
  /** Set when the flush was requested; drives the `durationMs` log field. */
  startedMs: number;
}

/** Module-level logger, namespace from the §4 registry (spec logging §9.3). */
const log = createLogger('mcode:worker');

/** Safely reads the log fields of a possibly-malformed entry under admission. */
function entryLogFields(entry: Entry): { kind?: unknown; bytes?: unknown } {
  if (entry === null || typeof entry !== 'object') return {};
  return { kind: entry.kind, bytes: entry.bytes };
}

function defaultWorkerUrl(): URL {
  // Built layout ships worker.js next to the compiled client; running from
  // source (vitest, tsx, Node type stripping) falls back to worker.ts.
  const built = new URL('worker.js', import.meta.url);
  if (existsSync(built)) return built;
  return new URL('worker.ts', import.meta.url);
}

/**
 * Default `execArgv` for a spawned worker thread. The thread loads the worker
 * file with raw Node (no vite pipeline), so bare specifiers there must resolve
 * through package `exports` — `import` → `dist`, never a dev source mapping
 * (logging spec §1.1). A parent runner can inject its own resolve conditions
 * into `process.execArgv` (vitest adds `--conditions development`, which flips
 * the `@mavis/*` `development` export targets to TypeScript sources a raw
 * thread cannot load: `ERR_MODULE_NOT_FOUND` on their internal `.js`
 * specifiers). The inherited list is therefore stripped of condition
 * overrides; everything else (type-stripping flags, `--import` hooks) is kept.
 * An explicit `workerExecArgv` option bypasses this and passes through as-is.
 */
export function defaultWorkerExecArgv(): string[] {
  const argv = process.execArgv;
  const filtered: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--conditions' || flag === '-C') {
      // The condition value follows as its own element: drop the pair.
      index += 1;
      continue;
    }
    // Node rejects this process-only V8 flag when passed explicitly to a worker.
    if (flag === '--expose-gc') continue;
    if (flag.startsWith('--conditions=') || flag.startsWith('-C=')) continue;
    filtered.push(flag);
  }
  return filtered;
}

/** Admission validation shared by both worker clients (main-side backends and off-thread hosts). */
export function validateEntry(entry: Entry, queueBytes: number, batchCapBytes: number): void {
  if (entry === null || typeof entry !== 'object') {
    throw new TypeError('entry must be an object');
  }
  if (typeof entry.entryId !== 'string' || entry.entryId.length === 0) {
    throw new TypeError('entry.entryId must be a non-empty string');
  }
  if (entry.parentId !== null && typeof entry.parentId !== 'string') {
    throw new TypeError('entry.parentId must be a string or null');
  }
  if (typeof entry.kind !== 'string' || entry.kind.length === 0) {
    throw new TypeError('entry.kind must be a non-empty string');
  }
  if (!Number.isFinite(entry.bytes) || entry.bytes < 0) {
    throw new TypeError(`entry.bytes must be a non-negative finite number, got ${entry.bytes}`);
  }
  if (entry.bytes > queueBytes) {
    throw new RangeError(
      `entry.bytes (${entry.bytes}) exceeds the queue ceiling (queueBytes=${queueBytes}); ` +
        'it could never be admitted',
    );
  }
  // Terminal at admission: an entry above the batch cap can never be part of
  // a committable batch, so queueing it would only wedge the retry loop.
  if (entry.bytes > batchCapBytes) {
    throw new EntryExceedsBatchCapError(entry.entryId, entry.bytes, batchCapBytes);
  }
}

export function createStorageWorker(
  backend: StorageWorkerBackend,
  options: StorageWorkerOptions = {},
): StorageWorker {
  if (typeof backend?.appendBatch !== 'function') {
    throw new TypeError('backend must provide appendBatch(entries): Promise<Commit>');
  }
  const queueBytes = options.queueBytes ?? DEFAULT_QUEUE_BYTES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
  const maxBatchUncompressedBytes =
    options.maxBatchUncompressedBytes ?? DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES;
  const maxConsecutiveFlushFailures =
    options.maxConsecutiveFlushFailures ?? DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES;

  const queue = createBoundedByteQueue(queueBytes);
  const worker = new Worker(options.workerUrl ?? defaultWorkerUrl(), {
    workerData: { windowMs, windowBytes, maxConsecutiveFlushFailures },
    execArgv:
      options.workerExecArgv === undefined
        ? defaultWorkerExecArgv()
        : [...options.workerExecArgv],
  });
  log.info('storage worker created', { windowMs, windowBytes, queueBytes, maxBatchUncompressedBytes });

  let closed = false;
  /** Set BEFORE the final drain starts; admission rejects while it holds. */
  let closing = false;
  let broken: Error | null = null;
  let pumpScheduled = false;
  let nextRequestId = 0;
  let lastCommit: Commit | null = null;
  const queued: Entry[] = [];
  const quarantinedEntries: Entry[] = [];
  const pendingFlushes = new Map<number, PendingFlush>();

  function failAll(error: Error): void {
    // Single error funnel of the handle (spec §5): terminal refusals, thread
    // crashes, and dead posts all fail closed through here.
    log.error('storage worker handle failed closed', { err: error });
    broken = error;
    for (const flush of pendingFlushes.values()) flush.reject(error);
    pendingFlushes.clear();
    queue.failAll(error);
  }

  function pump(): void {
    if (pumpScheduled || queued.length === 0 || broken) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      sendNow();
    });
  }

  function sendNow(): void {
    if (queued.length === 0) return;
    const chunk = queued.splice(0);
    // Buffer payloads transfer instead of copying (OPT-B1); on a failed post
    // they are restored before the entries go back to the queue head.
    const plan = collectTransferableBuffers(chunk);
    if (!post({ type: 'entries', entries: chunk }, plan.buffers)) {
      restoreTransferredBuffers(plan);
      // Back to the head, in order, without a spread push (the chunk can
      // exceed the frame-call stack).
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        queued.unshift(chunk[index]!);
      }
      failAll(new Error('storage worker thread is not accepting entries'));
    }
  }

  /** Returns false when the message could not be handed to the thread. */
  function post(message: ClientToWorkerMessage, transferList?: ArrayBuffer[]): boolean {
    try {
      worker.postMessage(message, transferList);
      return true;
    } catch {
      // The thread can terminate between dispose() and an in-flight callback;
      // dropped replies there are expected, that state was already failed.
      return false;
    }
  }

  function flushInternal(): Promise<Commit | null> {
    if (broken) return Promise.reject(broken);
    if (closed) return Promise.reject(new Error('storage worker is disposed'));
    sendNow();
    if (broken) return Promise.reject(broken); // pump may have failed closed
    const requestId = nextRequestId++;
    return new Promise<Commit | null>((resolve, reject) => {
      pendingFlushes.set(requestId, { resolve, reject, startedMs: Date.now() });
      post({ type: 'flush', requestId });
    });
  }

  worker.on('message', (raw: WorkerToMainMessage) => {
    if (raw.type === 'append') {
      const { requestId, entries } = raw;
      const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
      const appendStartedMs = Date.now();
      void Promise.resolve()
        .then(() => backend.appendBatch(entries))
        .then((commit) => {
          lastCommit = commit;
          // Batch committed through the main-thread bridge (spec §4
          // mcode:worker "обработано"); the engine logs its own cut-side
          // 'batch appended' — this line names the backend call site.
          log.debug('backend appendBatch resolved', {
            entries: entries.length,
            bytes,
            seq: commit.seq,
            head: commit.head,
            durationMs: Date.now() - appendStartedMs,
          });
          post({ type: 'appendResult', requestId, commit });
          // Release only on success: a failed batch is retained by the worker
          // for retry, so its bytes must keep counting against the ceiling.
          queue.release(bytes);
        })
        .catch((error: unknown) => {
          log.warn('batch append failed', {
            entries: entries.length,
            bytes,
            err: error instanceof Error ? error : new Error(String(error)),
          });
          // The transferred buffers must go back with the rejection, or the
          // engine's retained retry copy would re-send detached payloads.
          const plan = collectTransferableBuffers(entries);
          post(
            { type: 'appendError', requestId, error: serializeWorkerError(error), returnedBuffers: plan.buffers },
            plan.buffers,
          );
        });
      return;
    }
    if (raw.type === 'checkpoint') {
      const { requestId } = raw;
      const checkpointStartedMs = Date.now();
      void Promise.resolve()
        .then(() => backend.checkpoint?.())
        .then((produced) => {
          // An empty-window flush rides on this probe; a commit it produced
          // becomes the worker's lastCommit just like a batch commit would.
          if (produced) lastCommit = produced;
          log.debug('backend checkpoint probed', {
            seq: produced?.seq,
            durationMs: Date.now() - checkpointStartedMs,
          });
          post({ type: 'checkpointResult', requestId, commit: produced ?? null });
        })
        .catch((error: unknown) => {
          log.warn('backend checkpoint probe failed', {
            err: error instanceof Error ? error : new Error(String(error)),
          });
          post({ type: 'checkpointError', requestId, error: serializeWorkerError(error) });
        });
      return;
    }
    if (raw.type === 'terminalError') {
      // The backend refused writes terminally (owner lost, generation sealed):
      // fail the whole handle closed — parked and future calls reject with the
      // backend's own error instead of spinning or quarantining (IC-F1-004).
      failAll(deserializeWorkerError(raw.error));
      return;
    }
    if (raw.type === 'quarantined') {
      // Dead letters leave the retry path for good: release their bytes back
      // to the admission queue so they cannot wedge backpressure forever.
      const bytes = raw.entries.reduce((total, entry) => total + entry.bytes, 0);
      log.warn('entries quarantined', {
        entries: raw.entries.length,
        bytes,
        err: deserializeWorkerError(raw.error),
      });
      appendBoundedQuarantine(quarantinedEntries, raw.entries);
      queue.release(bytes);
      options.onQuarantined?.(raw.entries, deserializeWorkerError(raw.error));
      return;
    }
    // flushResult/flushError carry request ids issued by this thread;
    // appendResult/appendError carry worker-issued ids — never mixed.
    if (raw.type === 'flushResult' || raw.type === 'flushError') {
      const flush = pendingFlushes.get(raw.requestId);
      if (!flush) return;
      pendingFlushes.delete(raw.requestId);
      if (raw.type === 'flushResult') {
        if (raw.commit) lastCommit = raw.commit;
        log.debug('flush completed', {
          seq: raw.commit?.seq,
          durationMs: Date.now() - flush.startedMs,
        });
        flush.resolve(raw.commit);
      } else {
        log.warn('flush failed', {
          durationMs: Date.now() - flush.startedMs,
          err: deserializeWorkerError(raw.error),
        });
        flush.reject(deserializeWorkerError(raw.error));
      }
    }
  });

  worker.on('error', (error: Error) => {
    failAll(new Error(`storage worker thread crashed: ${error.message}`));
  });
  worker.on('exit', (code: number) => {
    if (!closed) failAll(new Error(`storage worker thread exited unexpectedly (code ${code})`));
  });

  return {
    enqueue(entry: Entry): Promise<void> {
      if (broken) return Promise.reject(broken);
      // Final state first (stable "disposed" wording after teardown), then the
      // in-flight drain state: admission during the final drain rejects
      // instead of slipping entries past the last flush (SW-02).
      if (closed) return Promise.reject(new Error('storage worker is disposed'));
      if (closing) {
        return Promise.reject(new Error('storage worker is disposing: the final drain is in progress'));
      }
      try {
        validateEntry(entry, queueBytes, maxBatchUncompressedBytes);
      } catch (error) {
        // Admission refusal (spec §5 warn): the entry will never be persisted.
        log.warn('entry refused at admission', {
          ...entryLogFields(entry),
          err: error instanceof Error ? error : new Error(String(error)),
        });
        return Promise.reject(error);
      }
      // Message accepted (spec §4 mcode:worker): depth is the committed-pending
      // byte count BEFORE this entry's admission; `queued` is the pump backlog.
      log.debug('entry enqueued', {
        kind: entry.kind,
        bytes: entry.bytes,
        depth: queue.pendingBytes,
        queued: queued.length,
      });
      return queue.reserve(entry, (admitted) => {
        queued.push(admitted);
        pump();
      });
    },

    flush(): Promise<Commit | null> {
      return flushInternal();
    },

    async checkpoint(): Promise<void> {
      // Fail-closed barrier: everything queued must be committed first, then
      // the backend must confirm its own open-batch flush. Any failure (or a
      // dead worker thread) propagates — never report unverified durability.
      // A `null` commit means the drain took the empty-window path, which
      // already probed `backend.checkpoint` through the bridge; after a real
      // batch commit the explicit barrier call is still required here.
      const commit = await flushInternal();
      if (commit !== null && backend.checkpoint) await backend.checkpoint();
    },

    get quarantined(): readonly Entry[] {
      return quarantinedEntries;
    },

    async dispose(): Promise<void> {
      // Mark closing BEFORE the drain (SW-02): concurrent enqueues reject
      // immediately instead of slipping entries past the final flush, and the
      // drain re-checks the pump queue afterwards so an entry admitted by an
      // in-flight backpressure release is still flushed, never silently lost.
      closing = true;
      log.info('storage worker disposing', { pendingBytes: queue.pendingBytes, queued: queued.length });
      let drainError: Error | null = null;
      try {
        // Drain everything that was admitted before closing began. Skipped
        // when nothing is uncommitted — dispose never pokes the backend with
        // an empty batch just to produce a commit.
        while ((queue.pendingBytes > 0 || queued.length > 0) && broken === null) {
          try {
            await flushInternal();
          } catch (error) {
            drainError = error instanceof Error ? error : new Error(String(error));
            break;
          }
        }
      } finally {
        closed = true;
        queue.failAll(new Error('storage worker is disposed'));
        for (const flush of pendingFlushes.values()) {
          flush.reject(new Error('storage worker is disposed'));
        }
        pendingFlushes.clear();
        await worker.terminate();
      }
      if (drainError !== null) throw drainError;
    },
  };
}
