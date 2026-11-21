/**
 * Persistence port of the delegation supervisor plus its sqlite-zstd adapter.
 *
 * The supervisor needs MULTI-ENTRY ATOMIC commits (a transition = supervisor
 * task record + child conversation record + delegation record + document, one
 * durable unit — §3 T_spawn). The storage worker's per-entry enqueue cannot
 * promise that, so the supervisor drives the delta log directly through this
 * narrow port and the sqlite-zstd backend's `appendBatch` provides the
 * all-or-nothing commit (batch row + index rows + head + resume capsule in one
 * transaction, `synchronous = FULL`).
 *
 * The port is STRUCTURAL (like `storage-worker`'s backend seam): this package
 * imports nothing from the backend package at runtime; `SqliteZstdBackend`
 * satisfies {@link DelegationLogBackend} as-is.
 *
 * @module
 */

import { createLogger } from '@mavis/logging';
import type { JsonValue } from './types.js';
import { DelegationRecoveryTruncatedError } from './errors.js';
import { isSupervisorKind } from './document.js';

const log = createLogger('mcode:delegation');

/** One supervisor entry handed to the log. */
export interface SupervisorEntryDraft {
  /** Deterministic entry id (see `ids.ts`); unique across the database. */
  readonly id: string;
  readonly kind: string;
  readonly payload: JsonValue;
  /** Predecessor entry id inside the supervisor's entry chain. */
  readonly parentId?: string | null;
}

/** One stored entry read back from the log. */
export interface StoredSupervisorEntry {
  readonly id: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly seq: number;
}

/** Commit mark of one atomic transition. */
export interface DelegationLogCommit {
  readonly seq: number;
  readonly head: number;
}

/** Structural surface of a delta-log backend the supervisor drives. */
export interface DelegationLogBackend {
  /**
   * Commit ALL drafts as ONE durable unit. Never invoked with an empty array.
   * A duplicate entry id (a logic bug — replays are pre-checked) must reject
   * instead of silently skipping, so a half-applied transition is impossible
   * to miss.
   */
  appendBatch(
    drafts: readonly { readonly id: string; readonly parentId?: string | null; readonly kind: string; readonly payload: JsonValue }[],
  ): Promise<{ readonly seq: number; readonly head: number }>;
  /** Current log head (last committed sequence; 0 when empty). */
  readonly head: number;
  /**
   * Point read of one entry by id; `undefined` when never committed. Used for
   * the bounded `getDelegation` fallback (anchor at the spawn entry).
   */
  getEntry(entryId: string): { readonly id: string; readonly kind: string; readonly payload: JsonValue; readonly seq: number } | undefined;
  /**
   * Entries committed strictly after `afterSeq`, oldest first, within an
   * uncompressed byte budget, PLUS a completeness verdict: `tornTail` (a
   * corrupt batch stopped the scan) or a `nextAfterSeq` short of the head
   * means the log was NOT fully served.
   */
  readDeltaChecked(
    afterSeq: number,
    limitBytes: number,
  ): {
    readonly entries: readonly { readonly id: string; readonly kind: string; readonly payload: JsonValue; readonly seq: number }[];
    readonly nextAfterSeq: number | null;
    readonly tornTail: { readonly batchId: number; readonly reason: string } | null;
  };
  /**
   * Windowed read anchored at an entry id: from the anchor's BATCH (inclusive
   * by default) forward within a byte budget. The anchor must exist.
   */
  readDeltaFrom(
    entryId: string,
    limitBytes: number,
    options?: { readonly inclusive?: boolean },
  ): readonly { readonly id: string; readonly kind: string; readonly payload: JsonValue; readonly seq: number }[];
  /**
   * Existence probe over the entry-id PRIMARY KEY: whether ANY committed id
   * sorts inside `[minId, maxId)` — one covering-index range search, no batch
   * decoding. OPTIONAL: a backend without it cannot disprove membership, and
   * the {@link sqliteZstdDelegationLog} wrapper then reports `true` so
   * recovery takes its windowed full-replay fallback instead of skipping
   * (fail-closed); the sqlite-zstd backend implements it.
   */
  hasEntriesInRange?(minId: string, maxId: string): boolean;
}

/** Persistence surface of the supervisor. */
export interface DelegationLog {
  /** Atomically commit one transition (never empty). */
  commitAtomic(drafts: readonly SupervisorEntryDraft[]): Promise<DelegationLogCommit>;
  /** Last committed sequence; 0 when empty. */
  head(): number;
  /** Point read by entry id (`undefined` when never committed). */
  getEntry(entryId: string): StoredSupervisorEntry | undefined;
  /**
   * The COMPLETE sequence of stored SUPERVISOR entries, oldest first,
   * accumulated over bounded windows of `windowBytes` uncompressed batch
   * bytes (memory stays O(window) however long the log is). Rejects with
   * `DelegationRecoveryTruncatedError` when a window stopped on a torn tail
   * or failed to make progress — recovery must never silently replay a
   * prefix.
   */
  readAll(windowBytes: number): Promise<readonly StoredSupervisorEntry[]>;
  /**
   * Entries from the BATCH of `entryId` (inclusive by default) forward,
   * bounded by `limitBytes`; the bounded anchor read behind
   * `getDelegation`'s durable fallback.
   */
  readFrom(entryId: string, limitBytes: number, options?: { readonly inclusive?: boolean }): readonly StoredSupervisorEntry[];
  /**
   * Existence probe over the entry-id PRIMARY KEY (optional — see
   * {@link DelegationLogBackend.hasEntriesInRange}). Recovery uses it as the
   * negative probe: an id range with no entries means there is nothing to
   * replay, whatever the log's total size. A port without the probe must
   * report `true` ("cannot disprove") — never a silent empty.
   */
  hasEntriesInRange?(minId: string, maxId: string): boolean;
}

/**
 * Default recovery replay window: 64 MiB of uncompressed batch bytes read
 * per `readDeltaChecked` window. This bounds RECOVERY MEMORY, not the total
 * scan volume — the windowed replay walks a log of any length.
 */
export const DEFAULT_RECOVERY_SCAN_BYTES = 64 * 1024 * 1024;

/** Default bounded anchor-read budget for `getDelegation` fallbacks. */
export const DEFAULT_ANCHOR_READ_BYTES = 4 * 1024 * 1024;

/**
 * Wraps a `SqliteZstdBackend` (structurally) into the {@link DelegationLog}
 * port. The backend's `appendBatch` IS the atomic multi-entry commit; its
 * entry-id primary key is the durable dedup layer under the supervisor's
 * deterministic entry ids.
 */
export function sqliteZstdDelegationLog(backend: DelegationLogBackend): DelegationLog {
  return {
    async commitAtomic(drafts) {
      if (drafts.length === 0) throw new TypeError('commitAtomic requires at least one entry');
      const commit = await backend.appendBatch(
        drafts.map((draft) => ({ id: draft.id, parentId: draft.parentId ?? null, kind: draft.kind, payload: draft.payload })),
      );
      return { seq: commit.seq, head: commit.head };
    },
    head(): number {
      return backend.head;
    },
    getEntry(entryId: string): StoredSupervisorEntry | undefined {
      return backend.getEntry(entryId);
    },
    async readAll(windowBytes: number): Promise<readonly StoredSupervisorEntry[]> {
      if (backend.head === 0) return [];
      // Windowed walk (the durable-seam replay idiom): the head is snapshotted
      // once, each window is one budgeted `readDeltaChecked`, and only the
      // supervisor entries of the window accumulate — the raw log (foreign
      // payloads included) is never held in memory. The first batch of every
      // window is always served by the backend, so every iteration makes
      // progress and the walk always reaches the snapshotted head.
      const head = backend.head;
      const entries: StoredSupervisorEntry[] = [];
      let cursor = 0;
      while (cursor < head) {
        const result = backend.readDeltaChecked(cursor, windowBytes);
        if (result.tornTail !== null) {
          const failure = new DelegationRecoveryTruncatedError(
            `batch ${result.tornTail.batchId} is corrupt (${result.tornTail.reason}); the log tail was not served`,
          );
          log.error('recovery-truncated', { tornTail: true, batchId: result.tornTail.batchId, err: failure });
          throw failure;
        }
        // A window without a cursor served nothing despite a pending batch
        // (the first batch is always served) — replaying the empty prefix
        // would understate the durable state.
        if (result.nextAfterSeq === null || result.nextAfterSeq <= cursor) {
          const failure = new DelegationRecoveryTruncatedError(
            `the recovery window read stalled at cursor ${cursor} of head ${head}: no batch was served`,
          );
          log.error('recovery-truncated', { tornTail: false, cursor, head, err: failure });
          throw failure;
        }
        for (const entry of result.entries) {
          if (isSupervisorKind(entry.kind)) entries.push(entry);
        }
        cursor = result.nextAfterSeq;
      }
      return entries;
    },
    readFrom(entryId, limitBytes, options) {
      // The backend is batch-granular; `inclusive` (default) keeps the anchor's
      // batch so the anchor entry itself is always served.
      return backend.readDeltaFrom(entryId, limitBytes, options);
    },
    hasEntriesInRange(minId, maxId) {
      // Absent on structural fakes: an honest "cannot disprove" (true), NOT
      // "not found" — a wrapper that silently reported an empty range would
      // let recovery SKIP the replay (fail-open: state would be lost). True
      // sends recovery down its windowed full-replay fallback instead.
      return backend.hasEntriesInRange?.(minId, maxId) ?? true;
    },
  };
}
