import { eq, sql } from 'drizzle-orm';

import { createLogger } from '@mavis/logging';

import type { AppDb } from '../../../../infra/db/client.js';
import {
  legacyMessages,
  messageRowMigrations,
  messageRows,
} from '../../../../infra/db/schema/messages.js';
import { MessageDataCorruptionError } from './contract.js';
import type { DisplayMessageRecord } from './contract.js';

/** Structured runtime diagnostics; the namespace is the `mcode:runtime` registry entry. */
const log = createLogger('mcode:runtime');

/**
 * Blobs at or below both bounds keep the historical one-shot backfill: a single
 * transaction parses the blob, inserts every row, writes the completion marker
 * and clears the blob. Anything larger is backfilled in staged portions so that
 * opening a fat legacy session never parses plus re-inserts the whole display
 * history inside one synchronous transaction (R7 staged backfill).
 */
export const DISPLAY_BACKFILL_FAST_PATH_MAX_RECORDS = 512;
export const DISPLAY_BACKFILL_FAST_PATH_MAX_BLOB_CHARS = 4 * 1024 * 1024;
/** Newest records written synchronously before the activation gate opens. */
export const DISPLAY_BACKFILL_TAIL_RECORDS = 256;
/** Older records written per background transaction. */
export const DISPLAY_BACKFILL_CHUNK_RECORDS = 256;

/** Lazy legacy display materialization seam consumed by display readers such as Peek. */
export interface MessageDisplayReadiness {
  ensureDisplayReady(sessionId: string): Promise<void>;
}

/**
 * Per-transaction display write sink. `rowId` carries the staged backfill's
 * reserved row id; non-staged callers always receive `undefined` and let the
 * table's autoincrement assign the id.
 */
export type LegacyDisplayWriteSink = (
  db: AppDb,
  message: DisplayMessageRecord,
  index: number,
  rowId: number | undefined,
) => void;

export function ensureMessageRowsReadyInTransaction(
  db: AppDb,
  sessionId: string,
  nowMs: number,
  write: (message: DisplayMessageRecord, index: number) => void,
): void {
  if (hasMarker(db, sessionId)) return;
  const source = selectLegacySource(db, sessionId);
  if (hasInterruptedBackfillArtifacts(db, sessionId, source)) {
    // Rows without a completion marker can only come from an interrupted staged
    // backfill of this same legacy blob (every other writer commits its marker
    // in the same transaction as its rows). Re-insert from scratch so row ids
    // follow the blob order.
    db.delete(messageRows).where(eq(messageRows.sessionId, sessionId)).run();
  }
  const messages = source ? parseLegacyMessages(source.displayMessagesJson, sessionId) : [];
  messages.forEach(write);
  insertMarker(db, sessionId, nowMs);
  if (source) {
    db.update(legacyMessages)
      .set({ displayMessagesJson: '[]' })
      .where(eq(legacyMessages.sessionId, sessionId))
      .run();
  }
}

/**
 * Read/activation path (R7 gate). Small blobs run the exact one-shot backfill;
 * large blobs write only the newest portion ("tail") in one transaction, open
 * the activation gate immediately and leave the remaining older portions to
 * `stepDisplayRowsBackfill` in the background. Reads stay unblocked once the
 * tail is committed; the completion marker only appears after every record is
 * backfilled, so crash recovery restarts the whole staged pass idempotently.
 */
export function ensureMessageRowsReadyStaged(
  db: AppDb,
  sessionId: string,
  nowMs: () => number,
  sink: LegacyDisplayWriteSink,
): void {
  if (hasMarker(db, sessionId)) return;
  if (stagedState(db, sessionId)) return;
  const source = selectLegacySource(db, sessionId);
  const raw = source?.displayMessagesJson ?? '[]';
  const messages = parseLegacyMessages(raw, sessionId);
  if (messages.length <= DISPLAY_BACKFILL_FAST_PATH_MAX_RECORDS && raw.length <= DISPLAY_BACKFILL_FAST_PATH_MAX_BLOB_CHARS) {
    db.transaction(
      (tx) => {
        ensureMessageRowsReadyInTransaction(tx, sessionId, nowMs(), (message, index) =>
          sink(tx, message, index, undefined),
        );
      },
      { behavior: 'immediate' },
    );
    return;
  }
  const tailStart = Math.max(0, messages.length - DISPLAY_BACKFILL_TAIL_RECORDS);
  const state: StagedDisplayBackfillState = {
    messages,
    recordsTotal: messages.length,
    tailStart,
    baseId: 0,
    nextIndex: 0,
    chunks: 0,
    activated: false,
    startedAtMs: performance.now(),
  };
  setStagedState(db, sessionId, state);
  log
    .child({ sessionId })
    .debug('legacy display backfill start', {
      recordsTotal: state.recordsTotal,
      blobChars: raw.length,
      activationRecords: state.recordsTotal - tailStart,
    });
  stepDisplayRowsBackfill(db, sessionId, nowMs, sink);
}

/**
 * Write path inside a caller-owned transaction. An active staged backfill is
 * absorbed here with reservation-aligned ids (row order stays identical to the
 * blob order); otherwise this is the plain one-shot backfill. Completing here
 * lets the pending background steps observe the marker and stop.
 */
export function ensureMessageRowsReadyInOpenedTransaction(
  topLevelDb: AppDb,
  tx: AppDb,
  sessionId: string,
  nowMs: number,
  sink: LegacyDisplayWriteSink,
): void {
  if (hasMarker(tx, sessionId)) {
    dropStagedState(topLevelDb, sessionId);
    return;
  }
  const state = stagedState(topLevelDb, sessionId);
  if (!state) {
    ensureMessageRowsReadyInTransaction(tx, sessionId, nowMs, (message, index) =>
      sink(tx, message, index, undefined),
    );
    return;
  }
  const source = selectLegacySource(tx, sessionId);
  if (isLegacySourceGone(source)) {
    // Session data was removed while the staged pass was in flight.
    dropStagedState(topLevelDb, sessionId);
    return;
  }
  for (let index = 0; index < state.recordsTotal; index += 1) {
    sink(tx, state.messages[index], index, state.baseId + 1 + index);
  }
  insertMarker(tx, sessionId, nowMs);
  clearLegacyBlob(tx, sessionId);
  dropStagedState(topLevelDb, sessionId);
  log
    .child({ sessionId })
    .debug('legacy display backfill done', {
      records: state.recordsTotal,
      chunks: state.chunks + 1,
      durationMs: performance.now() - state.startedAtMs,
      via: 'write',
      outcome: 'completed',
    });
}

/**
 * Process at most one staged portion: the activation tail on the first call,
 * then one prefix chunk per call, then the completion transaction. The
 * production scheduler chains this through `setTimeout(0)`; tests drive it
 * directly. Returns whether another step is required.
 */
export function stepDisplayRowsBackfill(
  db: AppDb,
  sessionId: string,
  nowMs: () => number,
  sink: LegacyDisplayWriteSink,
): boolean {
  const state = stagedState(db, sessionId);
  if (!state) return false;
  if (!state.activated) return activateStagedBackfill(db, sessionId, nowMs, sink, state);
  return extendStagedBackfill(db, sessionId, nowMs, sink, state);
}

interface StagedDisplayBackfillState {
  readonly messages: readonly DisplayMessageRecord[];
  readonly recordsTotal: number;
  /** Blob index where the activation tail begins; the background prefix ends here. */
  readonly tailStart: number;
  /** Reservation base: blob record `index` becomes row id `baseId + 1 + index`. */
  baseId: number;
  /** Number of prefix records (blob front) already committed. */
  nextIndex: number;
  chunks: number;
  activated: boolean;
  readonly startedAtMs: number;
}

/**
 * In-process checkpoint of staged backfills keyed by connection. The legacy
 * blob and the missing completion marker are the durable record of an
 * unfinished pass: after a crash the next activation wipes the partial rows
 * and restarts, and every row write is an upsert, so redo is idempotent.
 */
const stagedBackfills = new WeakMap<AppDb, Map<string, StagedDisplayBackfillState>>();

function stagedState(db: AppDb, sessionId: string): StagedDisplayBackfillState | undefined {
  return stagedBackfills.get(db)?.get(sessionId);
}

function setStagedState(db: AppDb, sessionId: string, state: StagedDisplayBackfillState): void {
  let sessions = stagedBackfills.get(db);
  if (!sessions) {
    sessions = new Map();
    stagedBackfills.set(db, sessions);
  }
  sessions.set(sessionId, state);
}

function dropStagedState(db: AppDb, sessionId: string): void {
  stagedBackfills.get(db)?.delete(sessionId);
}

function activateStagedBackfill(
  db: AppDb,
  sessionId: string,
  nowMs: () => number,
  sink: LegacyDisplayWriteSink,
  state: StagedDisplayBackfillState,
): boolean {
  const sessionLog = log.child({ sessionId });
  const stepStartedAtMs = performance.now();
  let superseded = false;
  let aborted = false;
  try {
    db.transaction(
      (tx) => {
        if (hasMarker(tx, sessionId)) {
          superseded = true;
          return;
        }
        const source = selectLegacySource(tx, sessionId);
        if (isLegacySourceGone(source)) {
          aborted = true;
          return;
        }
        if (hasInterruptedBackfillArtifacts(tx, sessionId, source)) {
          tx.delete(messageRows).where(eq(messageRows.sessionId, sessionId)).run();
        }
        // Reserve one id per blob record above the current global maximum so
        // the tail (written first) keeps higher ids than the older prefix that
        // background chunks insert afterwards: row id order stays identical to
        // blob order for every read, rewind and prefix copy.
        state.baseId = selectMaxMessageRowId(tx);
        for (let index = state.tailStart; index < state.recordsTotal; index += 1) {
          sink(tx, state.messages[index], index, state.baseId + 1 + index);
        }
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    dropStagedState(db, sessionId);
    sessionLog.warn('legacy display backfill failed', { err: error, phase: 'activation' });
    throw error;
  }
  state.activated = true;
  state.chunks += 1;
  if (superseded || aborted) {
    dropStagedState(db, sessionId);
    sessionLog.debug('legacy display backfill done', {
      records: state.recordsTotal,
      chunks: state.chunks,
      durationMs: performance.now() - state.startedAtMs,
      via: 'activation',
      outcome: superseded ? 'superseded' : 'aborted',
    });
    return false;
  }
  sessionLog.debug('legacy display backfill chunk', {
    phase: 'activation',
    written: state.recordsTotal - state.tailStart,
    cursor: 0,
    recordsTotal: state.recordsTotal,
    durationMs: performance.now() - stepStartedAtMs,
  });
  return scheduleOrFinalize(db, sessionId, nowMs, sink, state);
}

function extendStagedBackfill(
  db: AppDb,
  sessionId: string,
  nowMs: () => number,
  sink: LegacyDisplayWriteSink,
  state: StagedDisplayBackfillState,
): boolean {
  const sessionLog = log.child({ sessionId });
  const from = state.nextIndex;
  const to = Math.min(from + DISPLAY_BACKFILL_CHUNK_RECORDS, state.tailStart);
  const stepStartedAtMs = performance.now();
  let superseded = false;
  let aborted = false;
  try {
    db.transaction(
      (tx) => {
        if (hasMarker(tx, sessionId)) {
          superseded = true;
          return;
        }
        if (isLegacySourceGone(selectLegacySource(tx, sessionId))) {
          aborted = true;
          return;
        }
        for (let index = from; index < to; index += 1) {
          sink(tx, state.messages[index], index, state.baseId + 1 + index);
        }
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    dropStagedState(db, sessionId);
    // A background failure never surfaces into a read; the next activation
    // restarts the staged pass from the intact legacy blob.
    sessionLog.warn('legacy display backfill failed', { err: error, phase: 'background', cursor: from });
    return false;
  }
  if (superseded || aborted) {
    dropStagedState(db, sessionId);
    sessionLog.debug('legacy display backfill done', {
      records: state.recordsTotal,
      chunks: state.chunks,
      durationMs: performance.now() - state.startedAtMs,
      via: 'background',
      outcome: superseded ? 'superseded' : 'aborted',
    });
    return false;
  }
  state.nextIndex = to;
  state.chunks += 1;
  sessionLog.debug('legacy display backfill chunk', {
    phase: 'background',
    written: to - from,
    cursor: to,
    recordsTotal: state.recordsTotal,
    durationMs: performance.now() - stepStartedAtMs,
  });
  return scheduleOrFinalize(db, sessionId, nowMs, sink, state);
}

function scheduleOrFinalize(
  db: AppDb,
  sessionId: string,
  nowMs: () => number,
  sink: LegacyDisplayWriteSink,
  state: StagedDisplayBackfillState,
): boolean {
  if (state.nextIndex < state.tailStart) {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      stepDisplayRowsBackfill(db, sessionId, nowMs, sink);
    }, 0);
    // Never hold the process open for a background backfill.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    return true;
  }
  finalizeStagedBackfill(db, sessionId, nowMs, state);
  return false;
}

function finalizeStagedBackfill(
  db: AppDb,
  sessionId: string,
  nowMs: () => number,
  state: StagedDisplayBackfillState,
): void {
  const sessionLog = log.child({ sessionId });
  let superseded = false;
  try {
    db.transaction(
      (tx) => {
        superseded = hasMarker(tx, sessionId);
        if (!superseded) insertMarker(tx, sessionId, nowMs());
        const source = selectLegacySource(tx, sessionId);
        if (source && source.displayMessagesJson !== '[]') clearLegacyBlob(tx, sessionId);
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    dropStagedState(db, sessionId);
    sessionLog.warn('legacy display backfill failed', { err: error, phase: 'finalize' });
    return;
  }
  dropStagedState(db, sessionId);
  sessionLog.debug('legacy display backfill done', {
    records: state.recordsTotal,
    chunks: state.chunks,
    durationMs: performance.now() - state.startedAtMs,
    via: 'background',
    outcome: superseded ? 'superseded' : 'completed',
  });
}

function hasMarker(db: AppDb, sessionId: string): boolean {
  return (
    db
      .select({ sessionId: messageRowMigrations.sessionId })
      .from(messageRowMigrations)
      .where(eq(messageRowMigrations.sessionId, sessionId))
      .get() !== undefined
  );
}

function selectLegacySource(db: AppDb, sessionId: string) {
  return db
    .select()
    .from(legacyMessages)
    .where(eq(legacyMessages.sessionId, sessionId))
    .get();
}

function isLegacySourceGone(
  source: typeof legacyMessages.$inferSelect | undefined,
): boolean {
  return source === undefined || source.displayMessagesJson === '[]';
}

function hasInterruptedBackfillArtifacts(
  db: AppDb,
  sessionId: string,
  source: typeof legacyMessages.$inferSelect | undefined,
): boolean {
  if (isLegacySourceGone(source)) return false;
  return (
    db
      .select({ id: messageRows.id })
      .from(messageRows)
      .where(eq(messageRows.sessionId, sessionId))
      .limit(1)
      .get() !== undefined
  );
}

function selectMaxMessageRowId(db: AppDb): number {
  return (
    db
      .select({ value: sql<number>`coalesce(max(${messageRows.id}), 0)` })
      .from(messageRows)
      .get()?.value ?? 0
  );
}

function insertMarker(db: AppDb, sessionId: string, nowMs: number): void {
  db.insert(messageRowMigrations)
    .values({ sessionId, displayRowsBackfilledAtMs: nowMs })
    .onConflictDoNothing()
    .run();
}

function clearLegacyBlob(db: AppDb, sessionId: string): void {
  db.update(legacyMessages)
    .set({ displayMessagesJson: '[]' })
    .where(eq(legacyMessages.sessionId, sessionId))
    .run();
}

function parseLegacyMessages(raw: string, sessionId: string): DisplayMessageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MessageDataCorruptionError(sessionId, 'legacy-display-blob');
  }
  if (!Array.isArray(parsed) || !parsed.every(isObject)) {
    throw new MessageDataCorruptionError(sessionId, 'legacy-display-blob');
  }
  return parsed;
}
function isObject(value: unknown): value is DisplayMessageRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
