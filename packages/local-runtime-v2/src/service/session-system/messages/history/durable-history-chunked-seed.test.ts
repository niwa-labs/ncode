import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord, SessionRepository } from '../../sessions/repo/contract.js';
import type {
  CanonicalHistoryEnvelope,
  CanonicalHistoryFileAdapter,
} from '../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../sessions/representation/canonical-history.js';
import {
  createDurableHistoryStorage,
  createDurableSessionSystemCanonicalHistoryProvider,
  SeedImportConflictError,
  SeedRecordTooLargeError,
  type DurableHistoryStorage,
} from './durable-canonical-history-provider.js';
import type { SessionHistoryLocationResolver } from './session-history-location.js';
import { ensureResolvedSessionHistoryPaths, resolveSessionHistoryPaths, type SessionHistoryPaths } from './session-history-paths.js';
import { runHistoryImport } from '../../../../../../legacy-history/src/history-import/import-service.js';

/**
 * R5 chunked-seed tests: a full state larger than the worker's admission cap
 * is written through the history.v2.seed.begin/chunk/commit protocol —
 * sequential chunks, a durable cursor after each flush, and a resume that
 * replays the deterministic plan against the durable chunks without ever
 * duplicating a committed one. The legacy v1 single-entry path is pinned for
 * histories within the budget.
 */

const SEED_BEGIN_KIND = 'history.v2.seed.begin';
const SEED_CHUNK_KIND = 'history.v2.seed.chunk';
const SEED_COMMIT_KIND = 'history.v2.seed.commit';
const FULL_KIND = 'history.v1.full';

/** Payload text size of one synthetic record (~2 KiB message body). */
const RECORD_TEXT_BYTES = 2048;
/** Record count pushing the state safely past one 6 MiB chunk (≈7 MiB). */
const BIG_RECORD_COUNT = 3500;

function userEnvelope(index: number, textBytes: number): CanonicalHistoryEnvelope {
  return {
    message_id: `msg-seed-${String(index)}`,
    turn_id: `turn-seed-${String(index)}`,
    message: { role: 'user', content: 'x'.repeat(textBytes), timestamp: 1_700_000_000_000 + index },
  };
}

function bigRecords(): CanonicalHistoryEnvelope[] {
  return Array.from({ length: BIG_RECORD_COUNT }, (_, index) => userEnvelope(index, RECORD_TEXT_BYTES));
}

interface Fixture {
  readonly root: string;
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly locations: SessionHistoryLocationResolver;
  readonly files: CanonicalHistoryFileAdapter;
  storage: DurableHistoryStorage | undefined;
}

function stubLocations(root: string): SessionHistoryLocationResolver {
  const pathsFor = (sessionId: string): SessionHistoryPaths => {
    const sessionDir = join(root, 'sessions', sessionId);
    return {
      sessionDir,
      manifest: join(sessionDir, 'manifest.json'),
      messages: join(sessionDir, 'messages.jsonl'),
      snapshots: join(sessionDir, 'snapshots'),
      reports: join(sessionDir, 'reports'),
    };
  };
  return {
    resolve: async (session) => pathsFor(session.sessionId),
    allocate: async (session) => pathsFor(session.sessionId),
    ensure: async (session) => pathsFor(session.sessionId),
    inspect: async (session) => pathsFor(session.sessionId),
    inspectSession: async (sessionId) => ({
      session: (await stubSessionRepository(root).get(sessionId)) as SessionRecord,
      paths: pathsFor(sessionId),
    }),
    resolveSession: async (sessionId) => ({
      session: (await stubSessionRepository(root).get(sessionId)) as SessionRecord,
      paths: pathsFor(sessionId),
    }),
  };
}

function stubSessionRepository(root: string): Pick<SessionRepository, 'get'> {
  return {
    get: async (sessionId: string) =>
      ({
        sessionId,
        createdAtMs: 0,
        historyRelativeDir: `sessions/${sessionId}`,
        workspaceDir: join(root, 'workspaces', sessionId),
        agentName: 'root',
      }) as unknown as SessionRecord,
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'durable-seed-'));
  return {
    root,
    sessions: stubSessionRepository(root),
    locations: stubLocations(root),
    files: createCanonicalHistoryFileAdapter(),
    storage: undefined,
  };
}

function openProvider(fixture: Fixture, storage: DurableHistoryStorage) {
  return createDurableSessionSystemCanonicalHistoryProvider({
    storage,
    dataDir: fixture.root,
    sessions: fixture.sessions,
    locations: fixture.locations,
  });
}

/** Writes the synthetic source history into a session's JSONL. */
async function publishSource(
  fixture: Fixture,
  sessionId: string,
  records: readonly CanonicalHistoryEnvelope[],
): Promise<void> {
  const located = (await fixture.locations.resolveSession(sessionId))!;
  await fixture.files.publishInitial(located.paths.messages, records);
}

/**
 * Seed-protocol log entries as (id, kind) pairs, in log order. W10 hybrid
 * root: opening storage mints the pi bridge (open-time root marker,
 * conversation record, session map) — those entries carry the `pi.` kind
 * namespace and are not part of the seed protocol this suite pins.
 */
async function logEntries(storage: DurableHistoryStorage, sessionId: string): Promise<{ id: string; kind: string }[]> {
  // Per-session storage: the entries live in the session's OWN log file.
  const backend = (await storage.sessionStores(sessionId)).backend;
  return backend
    .readDelta(0, 256 * 1024 * 1024)
    .filter((entry) => !entry.kind.startsWith('pi.'))
    .map((entry) => ({ id: entry.id, kind: entry.kind }));
}

/**
 * Wraps a storage so seed-chunk enqueues fail after `failAfter` committed
 * chunks: a controlled crash BETWEEN chunks — the failing enqueue throws
 * before queueing, so nothing unflushed leaks into the log at dispose.
 */
function crashBetweenChunks(storage: DurableHistoryStorage, failAfter: number): DurableHistoryStorage {
  let chunkEnqueues = 0;
  const realEnqueue = storage.worker.enqueue.bind(storage.worker);
  const wrappedWorker = {
    ...storage.worker,
    enqueue: async (entry: { kind: string }): Promise<void> => {
      if (entry.kind === SEED_CHUNK_KIND) {
        if (chunkEnqueues >= failAfter) {
          throw new Error(`simulated crash before seed chunk ${String(chunkEnqueues + 1)}`);
        }
        chunkEnqueues += 1;
      }
      return realEnqueue(entry as Parameters<typeof realEnqueue>[0]);
    },
  } as DurableHistoryStorage['worker'];
  return { ...storage, worker: wrappedWorker };
}

describe('chunked durable seed (R5)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (fixture.storage) await fixture.storage.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('reads CLI-imported records by the live session ID after the dated name is truncated', async () => {
    const sessionId = '../source/' + 's'.repeat(200);
    const session: SessionRecord = {
      sessionId, agentName: 'mavis', workspaceDir: fixture.root, runtime: 'pi-agent',
      sessionType: 'root', sessionKind: 'conversation', archived: false, status: 'started',
      sessionOrigin: 'local-runtime', sessionDataVersion: 4, createdAtMs: 1, updatedAtMs: 1,
    };
    const source = ensureResolvedSessionHistoryPaths(resolveSessionHistoryPaths(fixture.root, session), session);
    const messages = [userEnvelope(0, 100)];
    await fixture.files.publishInitial(source.messages, messages);
    const durableRoot = join(fixture.root, 'imported');
    await runHistoryImport({ sourceDir: source.sessionDir, durableRoot });
    const storage = await createDurableHistoryStorage({ dataDir: durableRoot, ownsSystemRoot: true });
    fixture.storage = storage;
    const provider = createDurableSessionSystemCanonicalHistoryProvider({
      storage, dataDir: durableRoot, sessions: { get: async () => session },
    });
    expect((await provider.readActive(sessionId)).identityVector).toEqual(['msg-seed-0']);
  });

  it('seeds a history beyond the chunk budget through begin/chunk/commit and rebuilds it', async () => {
    const sessionId = 'session-big';
    await publishSource(fixture, sessionId, bigRecords());
    const storage = await createDurableHistoryStorage({ dataDir: fixture.root });
    fixture.storage = storage;
    const provider = openProvider(fixture, storage);

    const seeded = await provider.readActive(sessionId);
    expect(seeded.identityVector).toHaveLength(BIG_RECORD_COUNT);

    const entries = await logEntries(storage, sessionId);
    expect(entries[0]?.kind).toBe(SEED_BEGIN_KIND);
    expect(entries.at(-1)?.kind).toBe(SEED_COMMIT_KIND);
    expect(entries.filter((entry) => entry.kind === SEED_CHUNK_KIND).length).toBeGreaterThanOrEqual(2);

    // Reopen: the committed chunks stitch back to the exact base.
    await storage.dispose();
    fixture.storage = undefined;
    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    fixture.storage = reopened;
    const rebuilt = await openProvider(fixture, reopened).readActive(sessionId);
    expect(rebuilt.revision).toBe(seeded.revision);
    expect(rebuilt.identityVector).toEqual(seeded.identityVector);
  }, 120_000);

  it('resumes a crash between chunks with parity and without duplicated entries', async () => {
    const sessionId = 'session-crash';
    const referenceRecords = bigRecords();

    // Reference root: the uninterrupted seed defines the expected result and
    // the exact entry-id sequence a resume must converge to.
    const referenceRoot = await mkdtemp(join(tmpdir(), 'durable-seed-ref-'));
    const referenceStorage = await createDurableHistoryStorage({ dataDir: referenceRoot });
    try {
      const referenceProvider = createDurableSessionSystemCanonicalHistoryProvider({
        storage: referenceStorage,
        dataDir: referenceRoot,
        sessions: stubSessionRepository(referenceRoot),
        locations: stubLocations(referenceRoot),
      });
      const referenceLocated = (await stubLocations(referenceRoot).resolveSession(sessionId))!;
      await createCanonicalHistoryFileAdapter().publishInitial(
        referenceLocated.paths.messages,
        referenceRecords,
      );
      const reference = await referenceProvider.readActive(sessionId);
      const referenceIds = (await logEntries(referenceStorage, sessionId)).map((entry) => entry.id);
      expect(referenceIds[0]).toContain('|seed|');

      // Crash root: the seed dies between chunk 1 and chunk 2.
      await publishSource(fixture, sessionId, referenceRecords);
      const crashStorage = await createDurableHistoryStorage({ dataDir: fixture.root });
      const crashed = openProvider(fixture, crashBetweenChunks(crashStorage, 1));
      await expect(crashed.readActive(sessionId)).rejects.toThrow(/simulated crash/);
      expect((await logEntries(crashStorage, sessionId)).map((entry) => entry.kind)).toEqual([
        SEED_BEGIN_KIND,
        SEED_CHUNK_KIND,
      ]);
      await crashStorage.dispose();

      // A fresh process (empty caches, fresh lastEntryIds) resumes and
      // reaches parity with the uninterrupted run.
      const resumedStorage = await createDurableHistoryStorage({ dataDir: fixture.root });
      fixture.storage = resumedStorage;
      const revived = await openProvider(fixture, resumedStorage).readActive(sessionId);
      expect(revived.revision).toBe(reference.revision);
      expect(revived.identityVector).toEqual(reference.identityVector);

      // No duplicates: the resumed log holds exactly the reference entry ids,
      // in order — confirmed chunks were skipped, never re-sent.
      expect((await logEntries(resumedStorage, sessionId)).map((entry) => entry.id)).toEqual(referenceIds);
    } finally {
      await referenceStorage.dispose();
      await rm(referenceRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it('conflicts explicitly when the source changed over an unfinished import', async () => {
    const sessionId = 'session-drift';
    await publishSource(fixture, sessionId, bigRecords());
    const crashStorage = await createDurableHistoryStorage({ dataDir: fixture.root });
    const crashed = openProvider(fixture, crashBetweenChunks(crashStorage, 1));
    await expect(crashed.readActive(sessionId)).rejects.toThrow(/simulated crash/);
    await crashStorage.dispose();

    // The source changed: the resumed seed derives a different import id, and
    // two imports on one session never fork silently.
    const drifted = bigRecords().slice(0, BIG_RECORD_COUNT - 1);
    const located = (await fixture.locations.resolveSession(sessionId))!;
    await writeFile(
      located.paths.messages,
      `${drifted.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );

    const storage = await createDurableHistoryStorage({ dataDir: fixture.root });
    fixture.storage = storage;
    await expect(openProvider(fixture, storage).readActive(sessionId)).rejects.toBeInstanceOf(
      SeedImportConflictError,
    );
  }, 180_000);

  it('keeps the legacy single-entry full state for histories within the budget', async () => {
    const sessionId = 'session-small';
    await publishSource(fixture, sessionId, [userEnvelope(0, 64), userEnvelope(1, 64)]);
    const storage = await createDurableHistoryStorage({ dataDir: fixture.root });
    fixture.storage = storage;
    const provider = openProvider(fixture, storage);

    const seeded = await provider.readActive(sessionId);
    expect(seeded.identityVector).toHaveLength(2);
    expect((await logEntries(storage, sessionId)).map((entry) => entry.kind)).toEqual([FULL_KIND]);
  });

  it('fails controlled when a single record reaches the admission cap', async () => {
    const sessionId = 'session-huge';
    // One record whose serialized entry passes the 6 MiB chunk target and
    // reaches the 8 MiB admission cap (≈9 MiB of message text).
    await publishSource(fixture, sessionId, [userEnvelope(0, 9 * 1024 * 1024)]);
    const storage = await createDurableHistoryStorage({ dataDir: fixture.root });
    fixture.storage = storage;
    const provider = openProvider(fixture, storage);

    await expect(provider.readActive(sessionId)).rejects.toBeInstanceOf(SeedRecordTooLargeError);
    // Controlled stop: the begin is durable, no chunk and no commit followed,
    // so nothing partial is published.
    expect((await logEntries(storage, sessionId)).map((entry) => entry.kind)).toEqual([SEED_BEGIN_KIND]);
  }, 120_000);
});
