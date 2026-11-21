/**
 * W02 part B (PORT-PI-1.3): the composition point where a full pi `Storage`
 * sits on top of OUR single-writer/worker discipline — and where our worker
 * appends join the SAME discipline when both share one physical storage.
 *
 * Plan anchors:
 * - A1 (§2.4.1): "Единственный physical writer — storage-worker над нашим
 *   backend; pi Storage adapter реализует весь интерфейс" — the adapter
 *   itself (records/tables/cursors over sqlite-zstd) is W02 part A; THIS
 *   module is the integration half: the mutation discipline both sides must
 *   share so a second writer is structurally impossible (I01; R-row of W02:
 *   "невозможность second writer").
 * - §4 row 2: storage-worker/checkpoint — "Остается+мост — один worker и
 *   checkpoint-policy, соединённые с pi task/transaction lifecycle."
 * - C1 invariants 2/5 (boundary-contracts.md): ack only after the durable
 *   commit; a CAS blob must be published before a commit references it —
 *   both are enforced here through the pre-commit hook point.
 * - pi `Storage` contract (pin `third_party/pi-durable/src/types.ts:1166-1177`):
 *   an error thrown by `commit()`/`mintId()` is FINAL — the owning Session
 *   fails and nothing retries it. The gate mirrors that fail-closed: after
 *   the first storage failure every later mutation through the gate rejects.
 *
 * What each piece guarantees:
 * - {@link createSingleWriterGate}: at most ONE gated operation is in flight
 *   (the same invariant the batch engine upholds for `appendBatch`,
 *   `engine.ts` "single-flight"). Workers and pi commits that share one gate
 *   can therefore never interleave writes into the same storage.
 * - {@link gatePiStorageMutations}: a Proxy over a pi `Storage` (or the
 *   wave's adapter over our backend) that runs `commit`/`mintId` through the
 *   gate, validates writes BEFORE any durable attempt (`onBeforeCommit` —
 *   CAS publish-before-reference, seed publication gate), reports the
 *   durable sequence AFTER the commit resolved (`onCommitted` — the
 *   LOG→PUB ordering of §2.5.2), and fails closed after a storage error.
 *   Reads pass through untouched, bound to the original target.
 * - {@link gatedStorageWorkerBackend}: wraps a {@link StorageWorkerBackend}
 *   so worker appends go through the SAME gate as pi commits — the one-line
 *   composition `createStorageWorker(gatedStorageWorkerBackend(backend, gate))`.
 *
 * Fail-closed scoping decision (documented, deliberate): a VALIDATION
 * rejection from `onBeforeCommit` fails that one commit and leaves the gate
 * usable (it is a caller error, not storage damage); a STORAGE failure from
 * `commit`/`mintId` poisons the gate for everyone sharing it — one physical
 * storage, one fate (I07: no silent continuation of a second writer after
 * the first one failed). Callers that want independent failure domains must
 * NOT share one storage.
 *
 * The module is dependency-free at runtime besides `@mavis/logging`; the pi
 * surface is mirrored STRUCTURALLY (like `SqliteZstdBackendLike` in
 * `sqlite-zstd-adapter.ts`), so part A's adapter and the vendored reference
 * implementations (`@earendil-works/pi-durable/storage/memory`) plug in
 * without this package depending on pi-durable. A brand-only mismatch
 * (pi's erased numeric brands vs the plain numbers here) is bridged with one
 * explicit cast at the TEST/composition boundary — never by silent coercion.
 *
 * @module
 */

import { createLogger } from '@mavis/logging';

import type { StorageWorkerBackend } from './contracts.js';

/** Module-level logger; storage-commit events share the worker's §4 registry namespace. */
const log = createLogger('mcode:worker');

// ---------------------------------------------------------------------------
// Structural mirrors of the pi Storage mutation surface (pin types.ts:1179+)
// ---------------------------------------------------------------------------

/**
 * Structural stand-in for one pi `StorageWrite` (pin `types.ts:851-868`).
 * Deliberately loose: the pre-commit hook must be able to inspect ANY record
 * family (`conversation`, `entry`, `task`, `submission`, `document.*`)
 * without this package enumerating pi's union. Assignability note: pi's
 * `StorageWrite` union members are anonymous object types, so the real union
 * IS assignable to this shape through the bridge's argument plumbing.
 */
export type PiStorageWriteLike = {
  readonly type: string;
  readonly [key: string]: unknown;
};

/**
 * Minimal structural bound of a pi `Storage`'s MUTATION surface. Any object
 * whose `commit` returns a promise of the commit sequence (pi `Seq` — a
 * number) and whose `mintId` returns a promise of a fresh numeric id
 * satisfies it, including pi's own `Storage` implementations and W02 part
 * A's adapter. Reads are not bounded — the Proxy forwards them untouched.
 */
export interface PiMutationStorageLike {
  /** Atomically persist one write batch; resolves with the commit `Seq`. */
  commit(...args: never[]): Promise<unknown>;
  /** Fresh numeric id from the storage-global monotonic namespace. */
  mintId(): Promise<number>;
}

/**
 * The same mutation surface with the CONCRETE write-array parameter — the
 * shape test doubles and compositions declare when they call
 * `gatePiStorageMutations(fake)` and then invoke the gated `commit` with
 * {@link PiStorageWriteLike} batches ({@link PiMutationStorageLike}'s
 * `never[]` bound exists to preserve a real storage's precise parameter type
 * and therefore does not accept concrete arrays itself).
 */
export interface PiWritableStorageLike {
  /** Atomically persist one write batch; resolves with the commit `Seq`. */
  commit(writes: readonly PiStorageWriteLike[]): Promise<number>;
  /** Fresh numeric id from the storage-global monotonic namespace. */
  mintId(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Fail-closed terminal error
// ---------------------------------------------------------------------------

/**
 * Terminal, fail-closed refusal after the single-writer gate has seen a
 * storage failure (pi semantics: the error of `commit()`/`mintId()` is
 * final; nothing here retries it — I07). Every later mutation through the
 * poisoned gate rejects with this error; the owning composition must be
 * rebuilt from storage.
 */
export class PiWriterFailedError extends Error {
  constructor(
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options as ErrorOptions);
    this.name = 'PiWriterFailedError';
  }
}

// ---------------------------------------------------------------------------
// The single-writer gate
// ---------------------------------------------------------------------------

/** Serialized, fail-closed execution context shared by all writers of one storage. */
export interface SingleWriterGate {
  /**
   * Runs `op` as the single in-flight gated operation: the returned promise
   * chains onto the previous one, so gated operations execute strictly one
   * at a time in submission order. Rejects immediately with
   * {@link PiWriterFailedError} once the gate is poisoned
   * (see {@link SingleWriterGate.fail}).
   */
  run<T>(op: () => Promise<T>): Promise<T>;
  /**
   * Poisons the gate after a storage failure: every later `run` rejects with
   * {@link PiWriterFailedError}. The failure of the in-flight operation
   * itself still propagates to its own caller.
   */
  fail(reason: unknown): void;
  /** Whether the gate is poisoned (fail-closed). */
  readonly failed: boolean;
  /** The storage failure that poisoned the gate, when poisoned. */
  readonly failure: unknown;
}

/** Creates a {@link SingleWriterGate}. */
export function createSingleWriterGate(): SingleWriterGate {
  let tail: Promise<unknown> = Promise.resolve();
  let failed = false;
  let failure: unknown;
  const gate: SingleWriterGate = {
    run<T>(op: () => Promise<T>): Promise<T> {
      if (failed) {
        return Promise.reject(
          new PiWriterFailedError('the single-writer gate is failed (fail-closed)', {
            cause: failure,
          }),
        );
      }
      const next = tail.then(op, op);
      // The chain itself never rejects: the operation's own outcome is
      // carried by `next`; a poisoned gate must stay usable as a queue-head
      // without swallowing the original error.
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    fail(reason: unknown): void {
      if (failed) return;
      failed = true;
      failure = reason;
      log.error('single-writer gate poisoned by a storage failure', {
        err: reason instanceof Error ? reason : new Error(String(reason)),
      });
    },
    get failed(): boolean {
      return failed;
    },
    get failure(): unknown {
      return failure;
    },
  };
  return gate;
}

// ---------------------------------------------------------------------------
// Pre/post-commit hooks (C1 invariants 2 and 5)
// ---------------------------------------------------------------------------

/** Options of {@link gatePiStorageMutations}. */
export interface PiStorageWriterOptions {
  /**
   * Validation hook run BEFORE the write batch is handed to storage, inside
   * the single-writer gate (ordered after every earlier commit). Use it to
   * enforce publish-before-reference invariants — e.g. that every CAS ref
   * the batch references was already published (`CasStore.hasAsync`), or
   * that a `history.v2.seed.commit` entry may only travel in a commit whose
   * chunks verify (the seed publication gate of `@mavis/legacy-history`).
   *
   * A rejection FAILS THIS COMMIT ONLY: nothing durable happened, the gate
   * stays usable, and the rejection propagates to the commit's caller. A
   * validation rejection must never be retried silently.
   */
  readonly onBeforeCommit?: (writes: readonly PiStorageWriteLike[]) => Promise<void> | void;
  /**
   * Publication hook run AFTER the storage commit resolved with its durable
   * sequence — the LOG→PUB ordering of §2.5.2: subscribers and in-memory
   * publications see a commit only once it is durable (C1 invariant 2: the
   * ack follows the durable commit). Runs inside the gate, so publications
   * are ordered; an exception is logged and swallowed (publication must not
   * un-commit durable data — §2.5.2: "commit не отменяется фиктивно").
   */
  readonly onCommitted?: (seq: number, writes: readonly PiStorageWriteLike[]) => void;
  /** Hook run when the gate gets poisoned (storage failure), after logging. */
  readonly onFailed?: (reason: unknown) => void;
}

// ---------------------------------------------------------------------------
// The pi Storage mutation gate (Proxy preserving the rest of the surface)
// ---------------------------------------------------------------------------

/**
 * Wraps `storage` so its MUTATIONS (`commit`, `mintId`) run through a shared
 * {@link SingleWriterGate}: serialized, validated pre-commit, published
 * post-commit, and fail-closed after the first storage error. Everything
 * else (reads, `close`, custom adapter methods) passes through unchanged
 * and bound to the original target, so implementations using private state
 * keep working.
 *
 * The returned object is typed as `S` — the caller's precise storage type —
 * so part A's adapter (or the vendored reference `MemoryStorage`) keeps its
 * full surface for downstream consumers.
 */
export function gatePiStorageMutations<S extends PiMutationStorageLike>(
  storage: S,
  options: PiStorageWriterOptions = {},
  gate: SingleWriterGate = createSingleWriterGate(),
): S {
  const publish = (seq: number, writes: readonly PiStorageWriteLike[]) => {
    try { options.onCommitted?.(seq, writes); }
    catch (error) {
      log.error('pi commit publication hook failed after the durable commit', {
        seq, err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };
  const fail = (error: unknown): never => {
    gate.fail(error);
    options.onFailed?.(error);
    throw error;
  };
  const gatedCommit = (...args: never[]): Promise<unknown> =>
    gate.run(async () => {
      if (typeof args[1] === 'function') {
        // Pi 1.5 batches are durable in order; receipts follow all stored
        // batches, including a durable prefix before a refusal/fatal error.
        const batches = args[0] as readonly (readonly PiStorageWriteLike[])[];
        const receive = args[1] as (index: number, seq: number) => void;
        const receipts: number[] = [];
        let refused: unknown;
        try {
          for (const writes of batches) {
            try { await options.onBeforeCommit?.(writes); }
            catch (error) { refused = error; break; }
            let result: { stored: number; refused?: unknown };
            try {
              result = await (storage.commit as (...input: unknown[]) => Promise<typeof result>)(
                [writes], (_index: number, seq: number) => {
                  receipts.push(seq);
                  publish(seq, writes);
                }, args[2],
              );
            } catch (error) { return fail(error); }
            if (result.refused !== undefined || result.stored === 0) {
              refused = result.refused;
              break;
            }
          }
        } finally {
          receipts.forEach((seq, index) => receive(index, seq));
        }
        return { stored: receipts.length, ...(refused !== undefined ? { refused } : {}) };
      }
      // Compatibility for the product's existing one-batch journal port.
      const writes = (args[0] ?? []) as readonly PiStorageWriteLike[];
      await options.onBeforeCommit?.(writes);
      let seq: number;
      try { seq = await storage.commit(...args) as number; }
      catch (error) { return fail(error); }
      publish(seq, writes);
      return seq;
    });

  const gatedMintId = (): Promise<number> =>
    gate.run(() =>
      storage.mintId().catch((error: unknown) => {
        gate.fail(error);
        options.onFailed?.(error);
        throw error;
      }),
    );

  return new Proxy(storage, {
    get(target: S, property: string | symbol, receiver: unknown): unknown {
      if (property === 'commit') return gatedCommit;
      if (property === 'mintId') return gatedMintId;
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        // Bind reads to the ORIGINAL target: implementations with `this`
        // state (classes, private fields) must observe it untouched.
        return (value as (...fnArgs: never[]) => unknown).bind(target);
      }
      return value;
    },
  });
}

// ---------------------------------------------------------------------------
// Sharing the gate with the worker's own appends
// ---------------------------------------------------------------------------

/**
 * Wraps a {@link StorageWorkerBackend} so its `appendBatch` runs through the
 * SAME {@link SingleWriterGate} as pi commits (
 * `gatePiStorageMutations(adapter, options, gate)`): when one physical
 * storage serves both the worker's entry batches and the pi Storage record
 * families, this is the one-line composition that makes interleaved writes
 * structurally impossible (I01; §4 row 2: "один worker и checkpoint-policy,
 * соединённые с pi task/transaction lifecycle").
 *
 * `checkpoint` passes through ungated: it is a durability barrier, not a
 * mutation, and must stay callable while a batch is in flight. A poisoned
 * gate fails `appendBatch` with {@link PiWriterFailedError} — the shared
 * fate of one physical storage.
 */
export function gatedStorageWorkerBackend(
  backend: StorageWorkerBackend,
  gate: SingleWriterGate,
): StorageWorkerBackend {
  const gated: StorageWorkerBackend = {
    appendBatch(entries) {
      return gate.run(() => backend.appendBatch(entries));
    },
  };
  if (backend.checkpoint !== undefined) {
    gated.checkpoint = () => backend.checkpoint?.();
  }
  return gated;
}
