import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadSqlite3Constructor,
  type AppDb,
} from '../../../../infra/db/client.js';
import { runMigrations } from '../../../../infra/db/migrate.js';
import { ALL_MIGRATIONS } from '../../../../infra/db/migrations.js';
import {
  legacyMessages,
  messageRowMigrations,
  messageRows,
} from '../../../../infra/db/schema/messages.js';
import { normalizeDisplayMessage } from './codec.js';
import type { DisplayMessageRecord } from './contract.js';
import { createMessageRepository } from './drizzle.js';
import {
  DISPLAY_BACKFILL_FAST_PATH_MAX_RECORDS,
  DISPLAY_BACKFILL_TAIL_RECORDS,
  ensureMessageRowsReadyInOpenedTransaction,
  ensureMessageRowsReadyInTransaction,
  ensureMessageRowsReadyStaged,
  stepDisplayRowsBackfill,
  type LegacyDisplayWriteSink,
} from './readiness.js';

const SESSION = 'legacy-session';
const NOW_MS = 1_700_000_000_000;
const nowMs = () => NOW_MS;

function createDb(): AppDb {
  const Database = loadSqlite3Constructor();
  const sqlite = new Database(':memory:');
  runMigrations(sqlite as never, ALL_MIGRATIONS);
  return drizzle({ client: sqlite as never });
}

/** Mirrors the repository's legacy write: normalized payload, deterministic `legacy:${index}` ids. */
const sink: LegacyDisplayWriteSink = (db, message, index, rowId) => {
  const normalized = normalizeDisplayMessage(message, {
    generatedIdDiscriminator: `legacy:${index}`,
    nowMs,
  });
  const values = {
    ...(rowId === undefined ? {} : { id: rowId }),
    sessionId: SESSION,
    messageId: normalized.msgId,
    role: normalized.role,
    turnId: normalized.turnId,
    source: normalized.source,
    sourceContextJson: normalized.sourceContextJson,
    createdAtMs: normalized.createdAtMs,
    dataJson: normalized.dataJson,
  };
  db.insert(messageRows)
    .values(values)
    .onConflictDoUpdate({
      target: [messageRows.sessionId, messageRows.messageId],
      set: {
        role: normalized.role,
        turnId: normalized.turnId,
        source: normalized.source,
        sourceContextJson: normalized.sourceContextJson,
        createdAtMs: normalized.createdAtMs,
        dataJson: normalized.dataJson,
      },
    })
    .run();
};

function legacyRecord(index: number): DisplayMessageRecord {
  return {
    msg_id: `legacy-${String(index)}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    timestamp: 1_000 + index,
    text: `display record ${index}`,
  };
}

function legacyRecords(count: number): DisplayMessageRecord[] {
  return Array.from({ length: count }, (_, index) => legacyRecord(index));
}

function seedLegacyBlob(db: AppDb, records: readonly DisplayMessageRecord[]): void {
  db.insert(legacyMessages)
    .values({
      sessionId: SESSION,
      displayMessagesJson: JSON.stringify(records),
      piHistoryJson: '[]',
    })
    .run();
}

function readRows(db: AppDb) {
  return db
    .select()
    .from(messageRows)
    .where(eq(messageRows.sessionId, SESSION))
    .orderBy(asc(messageRows.id))
    .all();
}

function readMarker(db: AppDb) {
  return db
    .select()
    .from(messageRowMigrations)
    .where(eq(messageRowMigrations.sessionId, SESSION))
    .get();
}

function readBlob(db: AppDb): string | undefined {
  return db
    .select({ json: legacyMessages.displayMessagesJson })
    .from(legacyMessages)
    .where(eq(legacyMessages.sessionId, SESSION))
    .get()?.json;
}

function oneShotBackfill(db: AppDb, records?: readonly DisplayMessageRecord[]): void {
  db.transaction((tx) => {
    ensureMessageRowsReadyInTransaction(tx, SESSION, NOW_MS, (message, index) =>
      sink(tx, message, index, undefined),
    );
  });
}

async function expectRowsEqual(left: AppDb, right: AppDb): Promise<void> {
  expect(readRows(right)).toEqual(readRows(left));
}

describe('message display readiness backfill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the one-shot path 1:1 for small blobs', () => {
    const oneShotDb = createDb();
    const stagedDb = createDb();
    seedLegacyBlob(oneShotDb, legacyRecords(3));
    seedLegacyBlob(stagedDb, legacyRecords(3));

    oneShotBackfill(oneShotDb);
    ensureMessageRowsReadyStaged(stagedDb, SESSION, nowMs, sink);

    expectRowsEqual(oneShotDb, stagedDb);
    expect(readMarker(stagedDb)?.displayRowsBackfilledAtMs).toBe(NOW_MS);
    expect(readBlob(stagedDb)).toBe('[]');
    expect(readRows(stagedDb)).toHaveLength(3);
  });

  it('activates on the newest tail before the backfill completes, then reaches one-shot parity', () => {
    const records = legacyRecords(1_200);
    const oneShotDb = createDb();
    const stagedDb = createDb();
    seedLegacyBlob(oneShotDb, records);
    seedLegacyBlob(stagedDb, records);
    oneShotBackfill(oneShotDb);

    // Activation: only the newest tail is readable, no marker, blob intact.
    ensureMessageRowsReadyStaged(stagedDb, SESSION, nowMs, sink);
    const activatedRows = readRows(stagedDb);
    expect(activatedRows).toHaveLength(DISPLAY_BACKFILL_TAIL_RECORDS);
    expect(readMarker(stagedDb)).toBeUndefined();
    expect(readBlob(stagedDb)).toBe(JSON.stringify(records));
    expect(activatedRows.at(-1)?.messageId).toBe('legacy-1199');
    expect(activatedRows[0]?.messageId).toBe(`legacy-${String(1_200 - DISPLAY_BACKFILL_TAIL_RECORDS)}`);

    // The activation gate is idempotent for subsequent reads.
    ensureMessageRowsReadyStaged(stagedDb, SESSION, nowMs, sink);
    expect(readRows(stagedDb)).toHaveLength(DISPLAY_BACKFILL_TAIL_RECORDS);

    // Background portions converge on the exact one-shot result.
    let more = stepDisplayRowsBackfill(stagedDb, SESSION, nowMs, sink);
    expect(more).toBe(true);
    expect(readRows(stagedDb).length).toBeLessThan(records.length);
    while (more) {
      more = stepDisplayRowsBackfill(stagedDb, SESSION, nowMs, sink);
    }
    expect(readRows(stagedDb)).toHaveLength(records.length);
    expect(readMarker(stagedDb)?.displayRowsBackfilledAtMs).toBe(NOW_MS);
    expect(readBlob(stagedDb)).toBe('[]');
    expectRowsEqual(oneShotDb, stagedDb);
  });

  it('absorbs an active staged backfill when a write transaction needs full readiness', () => {
    const stagedDb = createDb();
    const records = legacyRecords(1_200);
    seedLegacyBlob(stagedDb, records);
    ensureMessageRowsReadyStaged(stagedDb, SESSION, nowMs, sink);
    expect(readRows(stagedDb)).toHaveLength(DISPLAY_BACKFILL_TAIL_RECORDS);

    stagedDb.transaction((tx) => {
      ensureMessageRowsReadyInOpenedTransaction(stagedDb, tx, SESSION, NOW_MS, sink);
    });

    expect(readRows(stagedDb)).toHaveLength(records.length);
    expect(readMarker(stagedDb)?.displayRowsBackfilledAtMs).toBe(NOW_MS);
    expect(readBlob(stagedDb)).toBe('[]');
    // The pending background chain observes the marker and stops without work.
    expect(stepDisplayRowsBackfill(stagedDb, SESSION, nowMs, sink)).toBe(false);
    expect(readRows(stagedDb)).toHaveLength(records.length);
  });

  it('re-inserts interrupted staged rows from scratch so row ids follow blob order', () => {
    const recoveredDb = createDb();
    const records = legacyRecords(600);
    seedLegacyBlob(recoveredDb, records);
    // Simulate a crash mid-staged-backfill: partial rows, no marker, blob intact.
    for (let index = 0; index < 10; index += 1) {
      sink(recoveredDb, records[index], index, undefined);
    }
    expect(readRows(recoveredDb)).toHaveLength(10);
    expect(readMarker(recoveredDb)).toBeUndefined();

    oneShotBackfill(recoveredDb);

    expect(readRows(recoveredDb)).toHaveLength(records.length);
    expect(readMarker(recoveredDb)).toBeDefined();
    readRows(recoveredDb).forEach((row, index) => {
      expect(row.messageId).toBe(records[index]?.msg_id);
    });
  });

  it('never treats rows without a marker as backfill artifacts when the blob is empty', () => {
    const forkShapeDb = createDb();
    // Fork targets carry rows without a marker and without a legacy blob.
    forkShapeDb
      .insert(legacyMessages)
      .values({ sessionId: SESSION, displayMessagesJson: '[]', piHistoryJson: '[]' })
      .run();
    sink(forkShapeDb, legacyRecord(0), 0, undefined);
    sink(forkShapeDb, legacyRecord(1), 1, undefined);

    oneShotBackfill(forkShapeDb);

    expect(readRows(forkShapeDb)).toHaveLength(2);
    expect(readMarker(forkShapeDb)).toBeDefined();
  });

  it('fails staged and one-shot activation with the same corruption error', () => {
    const corrupted = createDb();
    corrupted
      .insert(legacyMessages)
      .values({ sessionId: SESSION, displayMessagesJson: '{not-json', piHistoryJson: '[]' })
      .run();
    expect(() => oneShotBackfill(corrupted)).toThrowError(/corrupt/i);
    expect(readMarker(corrupted)).toBeUndefined();

    const corruptedStaged = createDb();
    corruptedStaged
      .insert(legacyMessages)
      .values({ sessionId: SESSION, displayMessagesJson: '{not-json', piHistoryJson: '[]' })
      .run();
    expect(() => ensureMessageRowsReadyStaged(corruptedStaged, SESSION, nowMs, sink)).toThrowError(
      /corrupt/i,
    );
    expect(readMarker(corruptedStaged)).toBeUndefined();
    expect(readRows(corruptedStaged)).toHaveLength(0);
  });

  it('reaches staged parity with a one-shot repository read of a large legacy session', async () => {
    const records = legacyRecords(1_200);
    const oneShotDb = createDb();
    const stagedDb = createDb();
    seedLegacyBlob(oneShotDb, records);
    seedLegacyBlob(stagedDb, records);
    oneShotBackfill(oneShotDb);

    const stagedRepo = createMessageRepository({ db: stagedDb });
    const oneShotRepo = createMessageRepository({ db: oneShotDb });

    // First read activates the staged backfill on the tail only.
    const firstRead = await stagedRepo.list(SESSION, { limit: 50 });
    expect(firstRead.messages).toHaveLength(50);
    expect(firstRead.messages[0]?.msg_id).toBe('legacy-1199');
    expect(readMarker(stagedDb)).toBeUndefined();

    // The gate stays open while the background chain runs to completion.
    await stagedRepo.list(SESSION, { limit: 50 });
    await vi.runAllTimersAsync();

    const stagedPage = await stagedRepo.list(SESSION, { limit: 50 });
    const oneShotPage = await oneShotRepo.list(SESSION, { limit: 50 });
    expect(stagedPage).toEqual(oneShotPage);
    const stagedReplay = await stagedRepo.listAfter(SESSION);
    const oneShotReplay = await oneShotRepo.listAfter(SESSION);
    expect(stagedReplay).toEqual(oneShotReplay);
    expect(stagedReplay.messages).toHaveLength(records.length);
    expect(readMarker(stagedDb)).toBeDefined();
    expect(readBlob(stagedDb)).toBe('[]');
    expectRowsEqual(oneShotDb, stagedDb);
  });

  it('keeps fast-path repository reads whole-history on the first read', async () => {
    const smallDb = createDb();
    seedLegacyBlob(smallDb, legacyRecords(3));
    const repo = createMessageRepository({ db: smallDb });
    const page = await repo.list(SESSION, { limit: 50 });
    expect(page.messages).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(readMarker(smallDb)).toBeDefined();
    expect(readBlob(smallDb)).toBe('[]');
    expect(readRows(smallDb)).toHaveLength(3);
  });

  it('surfaces the fast-path bound below the staged threshold', () => {
    expect(DISPLAY_BACKFILL_FAST_PATH_MAX_RECORDS).toBeGreaterThan(
      DISPLAY_BACKFILL_TAIL_RECORDS,
    );
  });
  it('rejects a missing or foreign paging anchor instead of repeating the newest page', async () => {
    const db = createDb();
    seedLegacyBlob(db, legacyRecords(3));
    const repo = createMessageRepository({ db });
    await repo.list(SESSION, { limit: 2 });
    await expect(repo.list(SESSION, { limit: 2, before: 'unknown-message' })).rejects.toThrow(/cursor/i);
    await expect(repo.list('other-session', { limit: 2, before: 'legacy-1' })).rejects.toThrow(/cursor/i);
    expect((await repo.list(SESSION, { limit: 2, before: 'legacy-0' })).messages).toEqual([]);
  });

});
