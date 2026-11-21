import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRecord, SessionRepository } from '../../sessions/repo/contract.js';
import {
  createSessionHistoryIoLane,
  type SessionHistoryIoLane,
} from './mutation/session-history-coordination.js';
import {
  createDurableHistoryStorage,
  createDurableSessionSystemCanonicalHistoryProvider,
  wrapSessionHistoryMutationForDurable,
  type DurableHistoryStorage,
  type DurableSessionSystemCanonicalHistoryProvider,
} from './durable-canonical-history-provider.js';
import {
  createDurableJsonlPublisher,
  resolveDurableJsonlPublishingEnabled,
  type DurableJsonlPublisher,
  type DurableJsonlPublisherFactory,
  type DurableJsonlPublisherOptions,
  type SessionPublishConflictInput,
} from './durable-jsonl-publisher.js';
import { createSessionHistoryLocationResolver, type SessionHistoryLocationResolver } from './session-history-location.js';
import type { SessionHistoryPaths } from './session-history-paths.js';
import {
  createSessionSystemCanonicalHistoryProvider,
  type SessionCanonicalHistoryChange,
} from './canonical-history-provider.js';
import { createSessionHistoryMutationAdapter } from './mutation/session-history-mutation-adapter.js';

/**
 * W1 DurableJsonlPublisher tests (architecture §3.2–§3.4): incremental
 * append after the durable commit trigger (W0 F6), full-rewrite on compact,
 * watermark recovery after a process restart, foreign-tail import
 * (growth/rewrite/conflict), the I-PUB-1 flush-before-mutation invariant and
 * byte parity with the hotfix's `publishDurableStateToFiles`.
 *
 * The publisher itself is always constructed explicitly here — these are the
 * golden tests of the `MCODE_PUBLISH_JSONL=on` behavior. The opt-in
 * composition gate (default off) is covered by the last describe.
 */

function userMessage(content: string, timestamp: number) {
  return { role: 'user', content, timestamp };
}

function assistantMessage(content: string, timestamp: number) {
  return { role: 'assistant', content, timestamp };
}

function appendChange(
  sessionId: string,
  operationId: string,
  messages: readonly unknown[],
  turnId = 'turn-1',
): SessionCanonicalHistoryChange {
  return {
    sessionId,
    turnId,
    reason: 'messageDelta',
    messages,
    operation: { id: operationId, kind: 'test' },
  };
}

interface Fixture {
  readonly root: string;
  readonly ioLane: SessionHistoryIoLane;
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly locations: SessionHistoryLocationResolver;
  readonly storage: DurableHistoryStorage;
  readonly durable: DurableSessionSystemCanonicalHistoryProvider;
  readonly publisher: DurableJsonlPublisher;
}

async function openFixture(
  root: string,
  publisherOptions?: Pick<DurableJsonlPublisherOptions, 'onSessionPublishConflict'>,
): Promise<Fixture> {
  const ioLane = createSessionHistoryIoLane();
  const sessions = stubSessionRepository(root);
  const locations = stubLocations(root, sessions);
  const storage = await createDurableHistoryStorage({ dataDir: root });
  let publisherRef: DurableJsonlPublisher | undefined;
  const durable = createDurableSessionSystemCanonicalHistoryProvider({
    storage,
    dataDir: root,
    sessions,
    locations,
    ioLane,
    publisherFactory: (source) => {
      publisherRef = createDurableJsonlPublisher({
        sessions,
        locations,
        ioLane,
        durable: source,
        ...publisherOptions,
      });
      return publisherRef;
    },
  });
  if (!publisherRef || !durable.publisher) throw new Error('publisher was not created');
  return { root, ioLane, sessions, locations, storage, durable, publisher: durable.publisher };
}

function stubLocations(
  root: string,
  sessions: Pick<SessionRepository, 'get'>,
): SessionHistoryLocationResolver {
  return createSessionHistoryLocationResolver({ dataDir: root, sessions });
}

function stubSessionRepository(root: string): Pick<SessionRepository, 'get'> {
  return {
    get: async (sessionId: string) =>
      ({
        sessionId,
        createdAtMs: 0,
        // A valid bound relative dir (the real location resolver validates the
        // four-segment UTC layout).
        historyRelativeDir: `1970/01/01/${sessionId}`,
        workspaceDir: join(root, 'workspaces', sessionId),
        agentName: 'root',
      }) as unknown as SessionRecord,
  };
}

async function pathsOf(fixture: Fixture, sessionId: string): Promise<SessionHistoryPaths> {
  const session = await fixture.sessions.get(sessionId);
  return fixture.locations.ensure(session!);
}

function readMessages(paths: SessionHistoryPaths): string {
  return readFileSync(paths.messages, 'utf8');
}

function foreignEnvelope(id: string, content: string) {
  return {
    message_id: id,
    turn_id: 'turn-foreign',
    message: userMessage(content, 99),
  };
}

describe('DurableJsonlPublisher', () => {
  let root: string;
  let fixture: Fixture;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'durable-jsonl-publisher-'));
    fixture = await openFixture(root);
  });

  afterEach(async () => {
    if (fixture) {
      await fixture.publisher.dispose();
      await fixture.storage.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });

  it('publishes an append after the durability flush and appends incrementally', async () => {
    const sessionId = 'session-append';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    // The trigger fired after the durable flush; the coalesced write may not
    // have landed yet — the forced flush is the deterministic barrier (I-PUB-1).
    await fixture.publisher.flushBeforeMutation(sessionId);
    const first = readMessages(paths);
    expect(first).toContain('hi');
    expect(first.trimEnd().split('\n')).toHaveLength(1);
    // The published bytes are exactly what the JSONL adapter serializes.
    expect(first.endsWith('\n')).toBe(true);
    expect(existsSync(join(paths.sessionDir, '.mcode-publish.json'))).toBe(true);

    // Second append lands as an INCREMENTAL append: the first line's bytes are
    // untouched and the file grows by exactly one line.
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const second = readMessages(paths);
    expect(second.startsWith(first)).toBe(true);
    expect(second.trimEnd().split('\n')).toHaveLength(2);
    expect(fixture.publisher.isStale(sessionId)).toBe(false);
  });

  it('coalesces notifications and publishes within the lag bound without a forced flush', async () => {
    const sessionId = 'session-coalesce';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    // No explicit flush: the notify trigger (after flushDurability) must
    // publish on its own within the ≤ 2 s coalescing bound (§3.2).
    await vi.waitFor(
      () => {
        expect(readMessages(paths)).toContain('hi');
      },
      { timeout: 2_000, interval: 25 },
    );
  });

  it('full-rewrites the file on compact and snapshots the former state', async () => {
    const sessionId = 'session-compact';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const before = readMessages(paths);
    expect(before.trimEnd().split('\n')).toHaveLength(2);

    await fixture.durable.compact({
      sessionId,
      turnId: 'turn-compact',
      reason: 'replaceMessages',
      messages: [{ role: 'compactionSummary', summary: 'compressed' }],
      operation: { id: 'op-compact', kind: 'compaction' },
      compactionId: 'compact-1',
      summary: 'compressed',
      method: 'llm_checkpoint',
    });
    await fixture.publisher.flushBeforeMutation(sessionId);

    const after = readMessages(paths);
    expect(after.trimEnd().split('\n')).toHaveLength(1);
    expect(after).toContain('compactionSummary');
    expect(after).toContain('compressed');
    // The former published state is preserved as a snapshot (§3.2 replace action).
    const snapshots = await readdir(paths.snapshots);
    expect(snapshots.some((name) => name.includes('publish-'))).toBe(true);
    const snapshot = readFileSync(join(paths.snapshots, snapshots[0]!), 'utf8');
    expect(snapshot).toBe(before);
  });

  it('recovers from the watermark after a process restart and appends the missing tail', async () => {
    const sessionId = 'session-restart';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const publishedBeforeRestart = readMessages(paths);
    // Simulate the process dying: release the log ownership without any
    // in-memory state carrying over — the fresh process rebuilds from the
    // durable log, the file and the watermark sidecar alone.
    await fixture.storage.dispose();

    // A fresh process reopens the same data dir.
    const restarted = await openFixture(root);
    try {
      await restarted.durable.append(appendChange(sessionId, 'op-3', [userMessage('again', 3)]));
      await restarted.publisher.flushBeforeMutation(sessionId);
      const after = readMessages(paths);
      // The file was NOT rewritten: the published prefix is byte-identical
      // and only the new tail was appended.
      expect(after.startsWith(publishedBeforeRestart)).toBe(true);
      expect(after.trimEnd().split('\n')).toHaveLength(3);
      expect(after).toContain('again');
    } finally {
      await restarted.publisher.dispose();
      await restarted.storage.dispose();
    }
  });

  it('recovers with a missing sidecar by comparing record prefixes', async () => {
    const sessionId = 'session-no-sidecar';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const published = readMessages(paths);
    // kill -9 between the file write and the sidecar write, or a deleted sidecar:
    // the reconcile falls back to the record-level prefix comparison
    // (idempotent by message_id — architecture §3.2).
    const { unlink } = await import('node:fs/promises');
    await unlink(join(paths.sessionDir, '.mcode-publish.json'));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const after = readMessages(paths);
    expect(after.startsWith(published)).toBe(true);
    expect(after.trimEnd().split('\n')).toHaveLength(2);
  });

  it('recovers idempotently from a crash between the file append and the sidecar write', async () => {
    // Review round 2: kill -9 in the middle of a publication — the append is
    // durable, its line landed in the file, the sidecar never advanced. The
    // foreign-append branch used to import our own tail, trip the append
    // identity boundary and leave the session permanently publish-stale with
    // every fail-closed flush throwing the same way.
    const sessionId = 'session-crash-append-window';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('first', 1)], 'turn-1'));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantMessage('second', 2)], 'turn-1'),
    );
    await fixture.publisher.flushBeforeMutation(sessionId);
    const sidecarPath = join(paths.sessionDir, '.mcode-publish.json');
    const laggingSidecar = readFileSync(sidecarPath, 'utf8');
    expect(JSON.parse(laggingSidecar).publishedCount).toBe(2);

    // The crash: durable has record 3, the file carries its line, the
    // sidecar still says publishedCount=2 (exactly the state the SIGKILL
    // leaves behind).
    await fixture.durable.append(appendChange(sessionId, 'op-3', [userMessage('third', 3)], 'turn-2'));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const crashedStateFile = readMessages(paths);
    expect(crashedStateFile.trimEnd().split('\n')).toHaveLength(3);
    writeFileSync(sidecarPath, laggingSidecar);

    // Recovery: the flush converges without importing our own tail…
    await expect(fixture.publisher.flushBeforeMutation(sessionId)).resolves.toBeUndefined();
    // …the file bytes are untouched (nothing was re-imported or rewritten)…
    expect(readMessages(paths)).toBe(crashedStateFile);
    // …and the sidecar is repaired to the durable state.
    const repaired = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    const durableNow = await fixture.durable.readActive(sessionId);
    expect(repaired.publishedCount).toBe(3);
    expect(repaired.durableRevision).toBe(durableNow.revision);
    expect(fixture.publisher.isStale(sessionId)).toBe(false);
    expect(fixture.publisher.publishStaleSessions()).toEqual([]);
    // A repeated flush is idempotent (previously it threw the same error again).
    await expect(fixture.publisher.flushBeforeMutation(sessionId)).resolves.toBeUndefined();

    // A later append publishes incrementally on the recovered base.
    await fixture.durable.append(
      appendChange(sessionId, 'op-4', [assistantMessage('fourth', 4)], 'turn-3'),
    );
    await fixture.publisher.flushBeforeMutation(sessionId);
    expect(readMessages(paths).startsWith(crashedStateFile)).toBe(true);
    expect(readMessages(paths).trimEnd().split('\n')).toHaveLength(4);
  });

  it('recovers the lagging sidecar on cold open after a restart', async () => {
    const sessionId = 'session-crash-cold-open';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('first', 1)], 'turn-1'));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantMessage('second', 2)], 'turn-1'),
    );
    await fixture.publisher.flushBeforeMutation(sessionId);
    const sidecarPath = join(paths.sessionDir, '.mcode-publish.json');
    const laggingSidecar = readFileSync(sidecarPath, 'utf8');
    // The crash state, then the process dies for real: no in-memory state
    // carries over.
    await fixture.durable.append(appendChange(sessionId, 'op-3', [userMessage('third', 3)], 'turn-2'));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const crashedStateFile = readMessages(paths);
    expect(crashedStateFile.trimEnd().split('\n')).toHaveLength(3);
    writeFileSync(sidecarPath, laggingSidecar);
    await fixture.storage.dispose();

    const restarted = await openFixture(root);
    try {
      // The cold-open reconcile (importForeignTail inside ensureState) must
      // repair the watermark silently — no duplicated-identity throw, no
      // publish-stale mark (review round 2, SIGKILL scenario).
      await restarted.durable.append(
        appendChange(sessionId, 'op-4', [assistantMessage('fourth', 4)], 'turn-3'),
      );
      await restarted.publisher.flushBeforeMutation(sessionId);
      expect(readMessages(paths).startsWith(crashedStateFile)).toBe(true);
      expect(readMessages(paths).trimEnd().split('\n')).toHaveLength(4);
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      expect(sidecar.publishedCount).toBe(4);
      expect(restarted.publisher.isStale(sessionId)).toBe(false);
      expect(restarted.publisher.publishStaleSessions()).toEqual([]);
    } finally {
      await restarted.publisher.dispose();
      await restarted.storage.dispose();
    }
  });

  it('resolves an unreadable file (duplicate message identity) as a §3.4 conflict, not a deadlock', async () => {
    // Review round 3: a duplicated identity threw out of readPublishedRecords
    // before any conflict handling — every flush failed fail-closed forever,
    // no event, no evidence copy, although durable can regenerate every byte.
    const conflicts: SessionPublishConflictInput[] = [];
    const conflictRoot = await mkdtemp(join(tmpdir(), 'durable-jsonl-publisher-dup-'));
    const observed = await openFixture(conflictRoot, {
      onSessionPublishConflict: (input) => conflicts.push(input),
    });
    try {
      const sessionId = 'session-duplicate-identity';
      const paths = await pathsOf(observed, sessionId);
      await observed.durable.append(appendChange(sessionId, 'op-1', [userMessage('first', 1)], 'turn-1'));
      await observed.durable.append(
        appendChange(sessionId, 'op-2', [assistantMessage('second', 2)], 'turn-1'),
      );
      await observed.publisher.flushBeforeMutation(sessionId);
      const sidecarPath = join(paths.sessionDir, '.mcode-publish.json');
      const laggingSidecar = readFileSync(sidecarPath, 'utf8');
      await observed.durable.append(appendChange(sessionId, 'op-3', [userMessage('third', 3)], 'turn-2'));
      await observed.publisher.flushBeforeMutation(sessionId);
      const durableStateFile = readMessages(paths);
      expect(durableStateFile.trimEnd().split('\n')).toHaveLength(3);

      // A foreign rewrite duplicated the second record's identity.
      const lines = durableStateFile.trimEnd().split('\n');
      writeFileSync(paths.messages, `${lines[0]}\n${lines[1]}\n${lines[1]}\n`);
      writeFileSync(sidecarPath, laggingSidecar);

      // Previously: TypeError (duplicate message identity) on every flush.
      await expect(observed.publisher.flushBeforeMutation(sessionId)).resolves.toBeUndefined();
      // Durable stays the source: the file is rewritten to exactly the
      // durable state.
      expect(readMessages(paths)).toBe(durableStateFile);
      // The raw corrupt bytes are preserved as evidence…
      const preserved = (await readdir(paths.sessionDir)).find((name) =>
        name.startsWith('messages.jsonl.external-'),
      );
      expect(preserved).toBeDefined();
      const preservedRaw = readFileSync(join(paths.sessionDir, preserved!), 'utf8');
      expect(preservedRaw.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(3);
      // …and the conflict surfaced through the banner-class event.
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.sessionId).toBe(sessionId);
      expect(conflicts[0]!.durableEntries).toBe(3);
      expect(conflicts[0]!.publishedEntries).toBe(3);
      expect(conflicts[0]!.preservedTo).toBeDefined();
      expect(observed.publisher.isStale(sessionId)).toBe(false);
      expect(observed.publisher.publishStaleSessions()).toEqual([]);
      // The recovery is idempotent and the session keeps working.
      await expect(observed.publisher.flushBeforeMutation(sessionId)).resolves.toBeUndefined();
      await observed.durable.append(
        appendChange(sessionId, 'op-4', [assistantMessage('fourth', 4)], 'turn-3'),
      );
      await observed.publisher.flushBeforeMutation(sessionId);
      expect(readMessages(paths).trimEnd().split('\n')).toHaveLength(4);
      expect(conflicts).toHaveLength(1);
    } finally {
      await observed.publisher.dispose();
      await observed.storage.dispose();
      await rm(conflictRoot, { recursive: true, force: true });
    }
  });

  it('resolves a parseable foreign duplicate of a durable id as a conflict, not a repeated throw', async () => {
    // Review round 3, the comment promise: a parseable foreign record whose
    // id is already durable OUTSIDE the positional continuation must surface
    // as a §3.4 row 3 conflict, never trip the identity boundary forever.
    const conflicts: SessionPublishConflictInput[] = [];
    const conflictRoot = await mkdtemp(join(tmpdir(), 'durable-jsonl-publisher-bnd-'));
    const observed = await openFixture(conflictRoot, {
      onSessionPublishConflict: (input) => conflicts.push(input),
    });
    try {
      const sessionId = 'session-boundary-duplicate';
      const paths = await pathsOf(observed, sessionId);
      await observed.durable.append(appendChange(sessionId, 'op-1', [userMessage('first', 1)], 'turn-1'));
      await observed.publisher.flushBeforeMutation(sessionId);
      const sidecarPath = join(paths.sessionDir, '.mcode-publish.json');
      const firstSidecar = readFileSync(sidecarPath, 'utf8');
      expect(JSON.parse(firstSidecar).publishedCount).toBe(1);
      for (const [index, content] of [
        ['op-2', 'second'],
        ['op-3', 'third'],
        ['op-4', 'fourth'],
      ] as const) {
        await observed.durable.append(
          appendChange(sessionId, index, [assistantMessage(content, Number(index.slice(3)))], `turn-${index.slice(3)}`),
        );
        await observed.publisher.flushBeforeMutation(sessionId);
      }
      const durableStateFile = readMessages(paths);
      const lines = durableStateFile.trimEnd().split('\n');
      expect(lines).toHaveLength(4);

      // The foreign file carried record 4 WITHOUT record 3 — a parseable
      // growth whose only new id is already durable at another position.
      writeFileSync(paths.messages, `${lines[0]}\n${lines[3]}\n`);
      writeFileSync(sidecarPath, firstSidecar);

      // Previously: identity-boundary TypeError on every flush.
      await expect(observed.publisher.flushBeforeMutation(sessionId)).resolves.toBeUndefined();
      expect(readMessages(paths)).toBe(durableStateFile);
      const preserved = (await readdir(paths.sessionDir)).find((name) =>
        name.startsWith('messages.jsonl.external-'),
      );
      expect(preserved).toBeDefined();
      expect(readFileSync(join(paths.sessionDir, preserved!), 'utf8')).toContain('fourth');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.sessionId).toBe(sessionId);
      expect(conflicts[0]!.durableEntries).toBe(4);
      expect(conflicts[0]!.publishedEntries).toBe(2);
      expect(observed.publisher.isStale(sessionId)).toBe(false);
      expect(observed.publisher.publishStaleSessions()).toEqual([]);
    } finally {
      await observed.publisher.dispose();
      await observed.storage.dispose();
      await rm(conflictRoot, { recursive: true, force: true });
    }
  });

  it('imports a foreign append that grew past the watermark into the durable log', async () => {
    const sessionId = 'session-foreign-append';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const oursBefore = readMessages(paths);

    // The app 3.1.6 wrote a turn while it held the lease: a raw O_APPEND-style
    // growth of the same file beyond our watermark.
    const foreign = foreignEnvelope('msg-user-v1-foreign-1', 'from the app');
    writeFileSync(paths.messages, `${oursBefore}${JSON.stringify(foreign)}\n`);

    await fixture.publisher.flushBeforeMutation(sessionId);
    // The foreign record became durable through the ordinary append path…
    const durableNow = await fixture.durable.readActive(sessionId);
    expect(durableNow.identityVector).toContain('msg-user-v1-foreign-1');
    // …the file was NOT rewritten (the foreign bytes stayed exactly where they are)…
    expect(readMessages(paths)).toBe(`${oursBefore}${JSON.stringify(foreign)}\n`);
    // …and our next turn appends cleanly after the foreign tail.
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const after = readMessages(paths);
    expect(after.startsWith(`${oursBefore}${JSON.stringify(foreign)}\n`)).toBe(true);
    expect(after).toContain('hello');
    expect(fixture.publisher.isStale(sessionId)).toBe(false);
  });

  it('adopts a foreign rewrite when everything of ours was already published', async () => {
    const sessionId = 'session-foreign-rewrite';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
    await fixture.publisher.flushBeforeMutation(sessionId);

    // The app rewound the session (its own rewrite, new inode): one foreign
    // record replaces our two.
    const foreign = foreignEnvelope('msg-user-v1-foreign-rewind', 'rewound by the app');
    writeFileSync(paths.messages, `${JSON.stringify(foreign)}\n`);

    await fixture.publisher.flushBeforeMutation(sessionId);
    const durableNow = await fixture.durable.readActive(sessionId);
    // The foreign rewrite became the durable state (the lease-transfer model:
    // the app's rewind is authoritative when we hold nothing unpublished)…
    expect(durableNow.identityVector).toEqual(['msg-user-v1-foreign-rewind']);
    // …the adopted foreign file stays in place; no external-preservation copy.
    expect(readFileSync(paths.messages, 'utf8')).toContain('rewound by the app');
    const sessionDirNames = await readdir(paths.sessionDir);
    expect(sessionDirNames.some((name) => name.includes('.external-'))).toBe(false);
  });

  it('keeps durable as the source and preserves the foreign file on a conflict', async () => {
    const sessionId = 'session-conflict';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    // A second durable append that has NOT been published yet.
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));

    // A foreign rewrite lands while we hold the unpublished tail.
    const foreign = foreignEnvelope('msg-user-v1-foreign-conflict', 'conflicting rewrite');
    writeFileSync(paths.messages, `${JSON.stringify(foreign)}\n`);

    await fixture.publisher.flushBeforeMutation(sessionId);
    // Durable stays the source: the file now carries both durable records and
    // none of the foreign rewrite…
    const durableNow = await fixture.durable.readActive(sessionId);
    expect(durableNow.identityVector).toHaveLength(2);
    expect(durableNow.identityVector).not.toContain('msg-user-v1-foreign-conflict');
    const after = readMessages(paths);
    expect(after).toContain('hi');
    expect(after).toContain('hello');
    expect(after).not.toContain('conflicting rewrite');
    // …and the foreign rewrite is preserved as read-only evidence.
    const preserved = (await readdir(paths.sessionDir)).find((name) =>
      name.startsWith('messages.jsonl.external-'),
    );
    expect(preserved).toBeDefined();
    expect(readFileSync(join(paths.sessionDir, preserved!), 'utf8')).toContain(
      'conflicting rewrite',
    );
  });

  it('keeps the I-PUB-1 invariant: a file mutation after N appends plans on all of them', async () => {
    const sessionId = 'session-ipub1';
    const paths = await pathsOf(fixture, sessionId);
    for (let index = 0; index < 3; index += 1) {
      await fixture.durable.append(
        appendChange(sessionId, `op-${index}`, [userMessage(`m${index}`, index + 1)]),
      );
    }
    // No explicit flush: the wrapper's pre-mutation flush must catch the file
    // up before the mutation plans on it (the W0 F5 regression, now through
    // the continuous publisher).
    const mutation = {
      settleTurnTail: async () => ({ sessionId }),
    };
    const wrapped = wrapSessionHistoryMutationForDurable(mutation as never, fixture.durable);
    await expect(
      wrapped.settleTurnTail!({
        sessionId,
        turnId: 'turn-1',
        outcome: { status: 'completed' },
      } as never),
    ).resolves.toBeDefined();

    const after = readMessages(paths);
    expect(after.trimEnd().split('\n')).toHaveLength(3);
    const durableNow = await fixture.durable.readActive(sessionId);
    expect(durableNow.identityVector).toHaveLength(3);
    // And the published revision equals the durable revision (fresh, not stale).
    expect(fixture.publisher.isStale(sessionId)).toBe(false);
  });

  it('publishes byte-identical files to the hotfix publishDurableStateToFiles', async () => {
    const viaPublisher = 'session-parity-publisher';
    const viaHotfix = 'session-parity-hotfix';
    const publisherPaths = await pathsOf(fixture, viaPublisher);
    const hotfixPaths = await pathsOf(fixture, viaHotfix);

    for (const sessionId of [viaPublisher, viaHotfix]) {
      await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
      await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
    }
    await fixture.publisher.flushBeforeMutation(viaPublisher);
    await fixture.durable.publishDurableStateToFiles(viaHotfix);

    // Same adapter, same records: the publications are byte-for-byte equal and
    // the revisions match the durable state.
    expect(readMessages(publisherPaths)).toBe(readMessages(hotfixPaths));
    expect(readMessages(publisherPaths).trimEnd().split('\n')).toHaveLength(2);
    const durablePublisher = await fixture.durable.readActive(viaPublisher);
    expect(durablePublisher.identityVector).toHaveLength(2);
  });

  it('flushes before the turn lease release and never blocks settlement on failure', async () => {
    // Happy path: flushBeforeRelease publishes and clears staleness.
    const sessionId = 'session-release';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.publisher.flushBeforeRelease(sessionId);
    expect(readMessages(paths)).toContain('hi');
    expect(fixture.publisher.isStale(sessionId)).toBe(false);

    // Failure path: a reconcile error is swallowed (I-PUB-1b — settlement
    // never blocks) and marks the session publish-stale instead of throwing.
    const failingLane = createSessionHistoryIoLane();
    const failingPublisher = createDurableJsonlPublisher({
      sessions: stubSessionRepository(root),
      locations: {
        ...fixture.locations,
        ensure: async () => {
          throw new Error('io failure');
        },
      },
      ioLane: failingLane,
      durable: {
        readCommitted: async () => ({ envelopes: [], revision: 'sha256:empty' }),
        importForeignAppends: async () => undefined,
        adoptPublishedState: async () => undefined,
      },
    });
    await expect(failingPublisher.flushBeforeRelease('any-session')).resolves.toBeUndefined();
    expect(failingPublisher.isStale('any-session')).toBe(true);
    // §3.2: the stale flag is readable as a status list (`mcode daemon status`
    // reads the runtime diagnostics seam) — the failed session is on it, the
    // healthy ones are not (review round 1, remark 3).
    expect(failingPublisher.publishStaleSessions()).toEqual(['any-session']);
    expect(fixture.publisher.publishStaleSessions()).toEqual([]);
    // …while the I-PUB-1 variant promotes the same failure (fail-closed).
    await expect(failingPublisher.flushBeforeMutation('any-session')).rejects.toThrow(
      /io failure/u,
    );
  });

  it('emits the §3.4 conflict observer and survives a failing one', async () => {
    const conflicts: SessionPublishConflictInput[] = [];
    // Each fixture owns its own durable log — a fresh data dir per runtime.
    const observedRoot = await mkdtemp(join(tmpdir(), 'durable-jsonl-publisher-obs-'));
    const failingRoot = await mkdtemp(join(tmpdir(), 'durable-jsonl-publisher-fail-'));
    const observed = await openFixture(observedRoot, {
      onSessionPublishConflict: (input) => conflicts.push(input),
    });
    const failing = await openFixture(failingRoot, {
      onSessionPublishConflict: () => {
        throw new Error('surface down');
      },
    });
    try {
      for (const fixtureName of ['observed', 'failing'] as const) {
        const current = fixtureName === 'observed' ? observed : failing;
        const sessionId = `session-conflict-event-${fixtureName}`;
        const paths = await pathsOf(current, sessionId);
        await current.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
        await current.publisher.flushBeforeMutation(sessionId);
        // An unpublished durable tail, then a foreign rewrite: the conflict
        // resolution (durable stays the source) must also reach the product
        // surface (review round 1: not silent beyond the log line).
        await current.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
        const foreign = foreignEnvelope(
          `msg-user-v1-foreign-event-${fixtureName}`,
          'conflicting rewrite',
        );
        writeFileSync(paths.messages, `${JSON.stringify(foreign)}\n`);
        await current.publisher.flushBeforeMutation(sessionId);

        expect(readMessages(paths)).toContain('hello');
        expect(readMessages(paths)).not.toContain('conflicting rewrite');
        expect(current.publisher.isStale(sessionId)).toBe(false);
        if (fixtureName === 'observed') {
          expect(conflicts).toHaveLength(1);
          const conflict = conflicts[0]!;
          expect(conflict.sessionId).toBe(sessionId);
          expect(conflict.durableEntries).toBe(2);
          expect(conflict.publishedEntries).toBe(1);
          expect(conflict.preservedTo).toBeDefined();
          expect(readFileSync(conflict.preservedTo!, 'utf8')).toContain('conflicting rewrite');
        }
      }
      // A throwing observer never fails the reconcile nor marks the session stale.
      expect(failing.publisher.isStale('session-conflict-event-failing')).toBe(false);
    } finally {
      await observed.publisher.dispose();
      await observed.storage.dispose();
      await failing.publisher.dispose();
      await failing.storage.dispose();
      await rm(observedRoot, { recursive: true, force: true });
      await rm(failingRoot, { recursive: true, force: true });
    }
  });

  it('does not treat an in-place same-size same-mtime edit as unchanged (watermark tail hash)', async () => {
    const sessionId = 'session-tail-hash';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(
      appendChange(sessionId, 'op-1', [userMessage('original content', 1)]),
    );
    await fixture.publisher.flushBeforeMutation(sessionId);
    // Pin a whole-second mtime and re-watermark: `utimes` carries only
    // microsecond precision and Node's seconds-as-float conversion rounds
    // sub-second values, so the recorded stat identity must be one `utimes`
    // can reproduce exactly. The sidecar is dropped so the next flush
    // re-records the pinned stat (no data writes in between).
    const pinnedMs = 1_700_000_000_000;
    await utimes(paths.messages, new Date(pinnedMs), new Date(pinnedMs));
    const { unlink } = await import('node:fs/promises');
    await unlink(join(paths.sessionDir, '.mcode-publish.json'));
    await fixture.publisher.flushBeforeMutation(sessionId);
    const watermark = JSON.parse(
      readFileSync(join(paths.sessionDir, '.mcode-publish.json'), 'utf8'),
    ) as { fileSize: number; fileMtimeMs: number };
    expect(watermark.fileMtimeMs).toBe(pinnedMs);
    const original = readFileSync(paths.messages, 'utf8');
    // Same inode, same byte size, mtime restored to the recorded value —
    // only the recorded tail hash can tell this foreign edit apart
    // (review round 1, remark 5).
    const tampered = original.replace('original content', 'tampered content');
    expect(tampered).not.toBe(original);
    expect(Buffer.byteLength(tampered)).toBe(watermark.fileSize);
    writeFileSync(paths.messages, tampered);
    await utimes(paths.messages, new Date(pinnedMs), new Date(pinnedMs));
    const statNow = await stat(paths.messages);
    expect(statNow.size).toBe(watermark.fileSize);
    expect(statNow.mtimeMs).toBe(watermark.fileMtimeMs);

    await fixture.publisher.flushBeforeMutation(sessionId);
    // §3.4 row 3: nothing of ours was unpublished, so the foreign rewrite is
    // ADOPTED into the durable log instead of being silently ignored.
    const durableNow = await fixture.durable.readActive(sessionId);
    expect(durableNow.identityVector).toHaveLength(1);
    expect(readMessages(paths)).toBe(tampered);
    expect(fixture.publisher.isStale(sessionId)).toBe(false);

    // Control: a genuinely untouched file still takes the fast path and the
    // next append lands incrementally on top of the adopted state.
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('next', 2)]));
    await fixture.publisher.flushBeforeMutation(sessionId);
    expect(readMessages(paths)).toContain('next');
    expect(readMessages(paths).startsWith(tampered)).toBe(true);
    expect(fixture.publisher.publishStaleSessions()).toEqual([]);
  });

  it('keeps the resumed retract publication and the publisher reconcile mutually exclusive on the shared lane', async () => {
    // Review round 1, remark 4: the retract resume publishes its staged
    // rewind with `alreadyInIoLane` — the write must stay inside the SAME
    // lane run the adapter holds, never race the publisher's reconcile. The
    // fixture wires the durable provider, the mutation adapter and the
    // publisher to ONE lane instance (as owner.ts:553 does in production);
    // the raced schedule below must end consistent no matter where the
    // reconcile's lane runs land.
    const sessionId = 'session-resume-retract-lane';
    const paths = await pathsOf(fixture, sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)], 'turn-1'));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)], 'turn-1'),
    );
    await fixture.durable.append(appendChange(sessionId, 'op-3', [userMessage('again', 3)], 'turn-2'));
    await fixture.durable.append(
      appendChange(sessionId, 'op-4', [assistantMessage('reply', 4)], 'turn-2'),
    );
    await fixture.publisher.flushBeforeMutation(sessionId);

    // Crash simulation: a turn-2 retraction staged its bundle but never
    // published — the manifest is what the next retractTurn resumes.
    const adapter = createSessionHistoryMutationAdapter({
      dataDir: root,
      sessions: fixture.sessions,
      locations: fixture.locations,
      ioLane: fixture.ioLane,
    });
    const history = await adapter.read(sessionId);
    const turnTwo = history.active.filter((envelope) => envelope.turn_id === 'turn-2');
    expect(turnTwo).toHaveLength(2);
    const stagedActive = history.active.slice(0, history.active.length - turnTwo.length);
    await adapter.stageRewind({
      sessionId,
      operationId: 'retract-op',
      expectedRevision: history.revision,
      sourceGeneration: history.activeGeneration,
      generation: history.activeGeneration,
      active: stagedActive,
      snapshots: [],
      operationData: {
        semanticMutation: 'retract-turn',
        turnId: 'turn-2',
        reason: { kind: 'output-final-recall' },
        deletedMessageIds: turnTwo.map(({ message_id }) => message_id),
      },
    });

    const wrapped = wrapSessionHistoryMutationForDurable(adapter, fixture.durable);
    const retract = wrapped.retractTurn!({
      sessionId,
      operationId: 'retract-op',
      turnId: 'turn-2',
      reason: { kind: 'output-final-recall' },
    });
    // Publisher reconcile traffic races the resumed retract (the reviewed
    // intersect scenario). Whatever the interleaving, the lane must
    // serialize the two writers.
    const reconcileTraffic = (async () => {
      for (let index = 0; index < 4; index += 1) {
        await fixture.publisher.flushBeforeMutation(sessionId);
      }
    })();
    const commit = await retract;
    await reconcileTraffic;

    expect(commit.status).toBe('committed');
    expect(commit.deletedMessageIds).toEqual(turnTwo.map(({ message_id }) => message_id));
    // File and durable log agree — no lost append, no divergence either way
    // the reconcile landed.
    const fileLines = readMessages(paths).trimEnd().split('\n');
    const durableNow = await fixture.durable.readActive(sessionId);
    expect(durableNow.identityVector).toHaveLength(fileLines.length);
    expect(durableNow.identityVector).not.toContain(turnTwo[0]!.message_id);
    expect(fixture.publisher.isStale(sessionId)).toBe(false);
  });
});

describe('MCODE_PUBLISH_JSONL: durable→jsonl replication is opt-in (default off)', () => {
  /** Quietude window past the whole coalescing schedule (debounce 250 ms). */
  const PUBLISH_QUIETUDE_MS = 400;

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Mirrors the owner.ts composition (`createSessionHistoryCapabilities`):
   * the durable provider is created with a `publisherFactory` only when the
   * knob resolves on — that conditional is exactly what production wires.
   */
  async function openGatedFixture(
    root: string,
    env: Readonly<Record<string, string | undefined>>,
  ) {
    const ioLane = createSessionHistoryIoLane();
    const sessions = stubSessionRepository(root);
    const locations = stubLocations(root, sessions);
    const storage = await createDurableHistoryStorage({ dataDir: root });
    const publisherFactory: DurableJsonlPublisherFactory | undefined =
      resolveDurableJsonlPublishingEnabled(env)
        ? (source) =>
            createDurableJsonlPublisher({ sessions, locations, ioLane, durable: source })
        : undefined;
    const durable = createDurableSessionSystemCanonicalHistoryProvider({
      storage,
      dataDir: root,
      sessions,
      locations,
      ioLane,
      ...(publisherFactory ? { publisherFactory } : {}),
    });
    return { sessions, locations, storage, durable };
  }

  async function pathsFor(
    sessions: Pick<SessionRepository, 'get'>,
    locations: SessionHistoryLocationResolver,
    sessionId: string,
  ): Promise<SessionHistoryPaths> {
    const session = await sessions.get(sessionId);
    return locations.ensure(session!);
  }

  it('resolves the knob: default/explicit off, explicit on, invalid fails closed to off', () => {
    expect(resolveDurableJsonlPublishingEnabled({})).toBe(false);
    expect(resolveDurableJsonlPublishingEnabled({ MCODE_PUBLISH_JSONL: '' })).toBe(false);
    expect(resolveDurableJsonlPublishingEnabled({ MCODE_PUBLISH_JSONL: 'off' })).toBe(false);
    expect(resolveDurableJsonlPublishingEnabled({ MCODE_PUBLISH_JSONL: ' OFF ' })).toBe(false);
    expect(resolveDurableJsonlPublishingEnabled({ MCODE_PUBLISH_JSONL: 'on' })).toBe(true);
    expect(resolveDurableJsonlPublishingEnabled({ MCODE_PUBLISH_JSONL: ' ON ' })).toBe(true);
    // Fail-closed (the MCODE_CACHE_WARMING knob convention): an invalid
    // value disables the replication with a warning instead of guessing.
    expect(resolveDurableJsonlPublishingEnabled({ MCODE_PUBLISH_JSONL: 'yes' })).toBe(false);
    expect(resolveDurableJsonlPublishingEnabled({ MCODE_PUBLISH_JSONL: '1' })).toBe(false);
    expect(resolveDurableJsonlPublishingEnabled({ MCODE_PUBLISH_JSONL: 'true' })).toBe(false);
  });

  it('default: a durable session publishes no messages.jsonl/watermark, stays fully readable and reopens from the durable log alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-jsonl-default-'));
    const fixture = await openGatedFixture(root, {});
    const sessionId = 'session-gate-default';
    let committedMessages: readonly unknown[] = [];
    try {
      expect(fixture.durable.publisher).toBeUndefined();
      const paths = await pathsFor(fixture.sessions, fixture.locations, sessionId);
      await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
      const committed = await fixture.durable.append(
        appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]),
      );
      committedMessages = committed.messages;
      // Past the whole coalescing window: a composed publisher would have
      // landed the publication by now; without one nothing may appear. (The
      // provider's own cold-open materializer may bootstrap an EMPTY
      // messages.jsonl for a new session — that is not a publication: no
      // records, no watermark, ever.)
      await delay(PUBLISH_QUIETUDE_MS);
      expect(existsSync(join(paths.sessionDir, '.mcode-publish.json'))).toBe(false);
      expect(existsSync(paths.messages) ? readFileSync(paths.messages, 'utf8').trim() : '').toBe('');
      // The durable branch alone serves the full active history (the
      // session/history read path) — the legacy jsonl fallback exists for
      // old file sessions, not for durable ones.
      const read = await fixture.durable.readActive(sessionId);
      expect(read.revision).toBe(committed.revision);
      expect(read.messages).toEqual(committed.messages);
      expect(read.identityVector).toHaveLength(2);
    } finally {
      await fixture.storage.dispose();
    }

    // A fresh process reopens the same data dir with the knob still off: the
    // history rebuilds from the durable log without any publication in the
    // session directory, and appends keep working.
    const reopenedStorage = await createDurableHistoryStorage({ dataDir: root });
    try {
      const reopened = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopenedStorage,
        dataDir: root,
        sessions: fixture.sessions,
        locations: fixture.locations,
      });
      expect(reopened.publisher).toBeUndefined();
      const read = await reopened.readActive(sessionId);
      expect(read.messages).toEqual(committedMessages);
      const appended = await reopened.append(
        appendChange(sessionId, 'op-3', [userMessage('again', 3)], 'turn-2'),
      );
      expect(appended.identityVector).toHaveLength(3);
      const paths = await pathsFor(fixture.sessions, fixture.locations, sessionId);
      expect(existsSync(join(paths.sessionDir, '.mcode-publish.json'))).toBe(false);
      expect(existsSync(paths.messages) ? readFileSync(paths.messages, 'utf8').trim() : '').toBe('');
    } finally {
      await reopenedStorage.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });

  it('explicit off: the publisher is not composed either', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-jsonl-off-'));
    const fixture = await openGatedFixture(root, { MCODE_PUBLISH_JSONL: 'off' });
    try {
      expect(fixture.durable.publisher).toBeUndefined();
      const sessionId = 'session-gate-off';
      const paths = await pathsFor(fixture.sessions, fixture.locations, sessionId);
      await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
      await delay(PUBLISH_QUIETUDE_MS);
      expect(existsSync(join(paths.sessionDir, '.mcode-publish.json'))).toBe(false);
      expect(existsSync(paths.messages) ? readFileSync(paths.messages, 'utf8').trim() : '').toBe('');
    } finally {
      await fixture.storage.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('on: the composition publishes messages.jsonl and the watermark as before', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-jsonl-on-'));
    const fixture = await openGatedFixture(root, { MCODE_PUBLISH_JSONL: 'on' });
    try {
      expect(fixture.durable.publisher).toBeDefined();
      const sessionId = 'session-gate-on';
      const paths = await pathsFor(fixture.sessions, fixture.locations, sessionId);
      await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
      // Deterministic barrier (I-PUB-1), same as the golden tests above.
      await fixture.durable.publisher!.flushBeforeMutation(sessionId);
      expect(readMessages(paths)).toContain('hi');
      expect(readMessages(paths).trimEnd().split('\n')).toHaveLength(1);
      expect(existsSync(join(paths.sessionDir, '.mcode-publish.json'))).toBe(true);
    } finally {
      await fixture.durable.publisher?.dispose();
      await fixture.storage.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a session started at on and continued at off keeps its published files untouched (no cleanup, no new publications)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-jsonl-flip-'));
    const on = await openGatedFixture(root, { MCODE_PUBLISH_JSONL: 'on' });
    const sessionId = 'session-gate-flip';
    let published: string;
    let watermark: string;
    const paths = await pathsFor(on.sessions, on.locations, sessionId);
    try {
      await on.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
      await on.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
      await on.durable.publisher!.flushBeforeMutation(sessionId);
      published = readMessages(paths);
      watermark = readFileSync(join(paths.sessionDir, '.mcode-publish.json'), 'utf8');
      expect(published.trimEnd().split('\n')).toHaveLength(2);
    } finally {
      await on.durable.publisher?.dispose();
      await on.storage.dispose();
    }

    // The next process runs with the default (off): the session continues
    // from the durable log, the published files are neither extended nor
    // cleaned up.
    const off = await openGatedFixture(root, {});
    try {
      expect(off.durable.publisher).toBeUndefined();
      await off.durable.append(
        appendChange(sessionId, 'op-3', [userMessage('again', 3)], 'turn-2'),
      );
      await delay(PUBLISH_QUIETUDE_MS);
      expect(readMessages(paths)).toBe(published);
      expect(readFileSync(join(paths.sessionDir, '.mcode-publish.json'), 'utf8')).toBe(watermark);
      const read = await off.durable.readActive(sessionId);
      expect(read.identityVector).toHaveLength(3);
    } finally {
      await off.storage.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the jsonl provider (MCODE_HISTORY_PROVIDER=jsonl) is independent of the knob: it keeps writing messages.jsonl at off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-jsonl-legacy-'));
    const sessions = stubSessionRepository(root);
    const locations = stubLocations(root, sessions);
    const jsonl = createSessionSystemCanonicalHistoryProvider({
      dataDir: root,
      sessions,
      locations,
    });
    try {
      const sessionId = 'session-legacy-jsonl';
      await jsonl.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
      const paths = await pathsFor(sessions, locations, sessionId);
      // The legacy provider's own storage IS messages.jsonl — the knob only
      // gates the durable→jsonl replication, never this path.
      expect(readMessages(paths)).toContain('hi');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
