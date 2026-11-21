import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  currentGeneration,
  OwnerWriteLockError,
  SqliteZstdBackend,
} from '@mavis/durable-backend-sqlite-zstd';

import type { SessionRecord, SessionRepository } from '../../sessions/repo/contract.js';
import type {
  CanonicalHistoryEnvelope,
  CanonicalHistoryFileAdapter,
} from '../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../sessions/representation/canonical-history.js';
import {
  createDurableHistoryStorage,
  createDurableSessionSystemCanonicalHistoryProvider,
  DurableHistoryLogOwnedError,
  wrapSessionHistoryMutationForDurable,
  resolveHistoryProviderMode,
  type DurableHistoryStorage,
} from './durable-canonical-history-provider.js';
import { createSessionHistoryMutationAdapter } from './mutation/session-history-mutation-adapter.js';
import { CompactionNothingToCutError } from './history-event-log.js';
import {
  createSessionSystemCanonicalHistoryProvider,
  type SessionCanonicalHistoryChange,
  type SessionSystemCanonicalHistoryProvider,
} from './canonical-history-provider.js';
import type { SessionHistoryLocationResolver } from './session-history-location.js';
import type { SessionHistoryPaths } from './session-history-paths.js';
import type { DurableSystemStores } from './durable-session-stores.js';

/**
 * Ш1 durable canonical-history provider tests. The durable path is opt-in by
 * env in composition; these tests construct the storage explicitly and check
 * interface parity with the JSONL provider plus log-rebuild persistence.
 */

function userMessage(content: string, timestamp: number) {
  return { role: 'user', content, timestamp };
}

function assistantMessage(content: string, timestamp: number) {
  return { role: 'assistant', content, timestamp };
}

/** One assistant message accepting several parallel tool calls (incident 03 shape). */
function assistantToolCallsMessage(
  calls: readonly { readonly id: string; readonly name?: string }[],
  timestamp: number,
) {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: call.name ?? 'task',
      arguments: {},
    })),
    timestamp,
  };
}

function toolResultMessage(
  callId: string,
  toolName: string,
  text: string,
  timestamp: number,
  isError = true,
) {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp,
  };
}

/** The abort-cascade service delta: the todo cadence reminder (custom role). */
function cadenceReminderMessage(timestamp: number) {
  return {
    role: 'custom',
    customType: 'todo_cadence_reminder',
    content: '<system-reminder>todo cadence</system-reminder>',
    display: false,
    timestamp,
  };
}

function assistantToolCallMessage(callId: string, timestamp: number) {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: 'probe', arguments: {} }],
    timestamp,
  };
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
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly locations: SessionHistoryLocationResolver;
  storage: DurableHistoryStorage;
  /** The fixture's SYSTEM log (the legacy monolith) — present in every fixture. */
  readonly system: DurableSystemStores;
  readonly durable: ReturnType<typeof createDurableSessionSystemCanonicalHistoryProvider>;
  readonly jsonl: SessionSystemCanonicalHistoryProvider;
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
      session: await stubSessionRepository(root).get(sessionId),
      paths: pathsFor(sessionId),
    }),
    resolveSession: async (sessionId) => ({
      session: await stubSessionRepository(root).get(sessionId),
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
  // Durable and JSONL providers live in separate roots so parity comparisons
  // never observe each other's storage.
  const root = await mkdtemp(join(tmpdir(), 'durable-history-'));
  const jsonlRoot = await mkdtemp(join(tmpdir(), 'jsonl-history-'));
  const locations = stubLocations(root);
  const sessions = stubSessionRepository(root);
  const storage = await createDurableHistoryStorage({ dataDir: root, ownsSystemRoot: true });
  if (!storage.system) throw new Error('fixture requires the system log');
  const durable = createDurableSessionSystemCanonicalHistoryProvider({
    storage,
    dataDir: root,
    sessions,
    locations,
  });
  const jsonl = createSessionSystemCanonicalHistoryProvider({
    dataDir: jsonlRoot,
    sessions: stubSessionRepository(jsonlRoot),
    locations: stubLocations(jsonlRoot),
  });
  return {
    root,
    sessions,
    locations,
    storage,
    system: storage.system,
    durable,
    jsonl,
  };
}

describe('resolveHistoryProviderMode', () => {
  // W10 hybrid default (plan §8 W10-C): the durable provider is the default;
  // `jsonl` is the explicit compatibility mode; unknown values fail closed.
  it('defaults to durable when the env flag is unset', () => {
    expect(resolveHistoryProviderMode({})).toBe('durable');
    expect(resolveHistoryProviderMode({ MCODE_HISTORY_PROVIDER: 'durable' })).toBe('durable');
    expect(resolveHistoryProviderMode({ MCODE_HISTORY_PROVIDER: '  Durable ' })).toBe('durable');
  });

  it('keeps jsonl as the explicit compatibility mode and fails closed on unknown values', () => {
    expect(resolveHistoryProviderMode({ MCODE_HISTORY_PROVIDER: 'jsonl' })).toBe('jsonl');
    expect(() =>
      resolveHistoryProviderMode({ MCODE_HISTORY_PROVIDER: 'file' }),
    ).toThrowError(/Unsupported MCODE_HISTORY_PROVIDER/);
  });
});

describe('durable history storage open under a competing writer', () => {
  // Second-instance policy (W11 hotfix): `mcode exec`/TUI must survive a
  // transient overlap with another runtime's ownership, and a LIVE owner
  // (an open TUI) must fail FAST with the typed, actionable
  // DurableHistoryLogOwnedError instead of the old 10s retry loop under the
  // "Starting server..." spinner. Rotation under a live owner stays
  // forbidden: the new generation would start empty (no cross-generation
  // read chain) and the live owner's subsequent writes would be silently
  // lost — the refusal never steals and never rotates.
  it('waits out a transient owner that releases the system log and then opens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-owner-transient-'));
    try {
      const holder = SqliteZstdBackend.open(join(root, 'durable-history'));
      const release = setTimeout(() => holder.close(), 300);
      const startedAtMs = Date.now();
      let storage: DurableHistoryStorage | undefined;
      try {
        storage = await createDurableHistoryStorage({
          dataDir: root,
          ownsSystemRoot: true,
          ownerWaitTimeoutMs: 5_000,
        });
        // The open waited at least one owner-wait interval instead of
        // failing on the first refusal.
        expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(300);
        expect(storage.system?.backend.generation).toBe(1);
      } finally {
        clearTimeout(release);
        await storage?.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails fast with the actionable typed error when a live owner keeps the system log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-owner-live-'));
    try {
      const holder = SqliteZstdBackend.open(join(root, 'durable-history'));
      try {
        const startedAtMs = Date.now();
        const error = await createDurableHistoryStorage({
          dataDir: root,
          ownsSystemRoot: true,
          ownerWaitTimeoutMs: 300,
        }).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        // The bounded wait ran to its deadline before failing fast.
        expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(300);
        // Typed refusal: DurableHistoryLogOwnedError IS an
        // OwnerWriteLockError, so existing catch sites keep matching.
        expect(error).toBeInstanceOf(DurableHistoryLogOwnedError);
        expect(error).toBeInstanceOf(OwnerWriteLockError);
        if (!(error instanceof DurableHistoryLogOwnedError)) return;
        expect(error.message).toMatch(/pid \d+/);
        expect(error.message).toMatch(/a second daemon cannot start/);
        expect(error.message).toMatch(/mcode daemon stop/);
        // Structured fields carry the live owner's identity (the backend
        // surfaces pid + instance; this process is the holder here).
        expect(error.ownerPid).toBe(process.pid);
        expect(typeof error.ownerInstance).toBe('string');
        expect(error.ownerInstance).toMatch(/^[\w-]+@\d+$/);
        expect(error.directory).toBe(join(root, 'durable-history'));
        expect(error.generation).toBe(1);
        expect(error.waitedMs).toBeGreaterThanOrEqual(300);
        // Fail-closed, not steal: the failed open left the live owner in
        // possession — a fresh open is still refused.
        expect(() => SqliteZstdBackend.open(join(root, 'durable-history'))).toThrowError(
          OwnerWriteLockError,
        );
      } finally {
        holder.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('two runtimes on one dataDir: plain runtimes coexist per session; a second SYSTEM owner fails fast; the session history hands over intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-two-instances-'));
    const sessionsDir = join(root, 'durable-history', 'sessions');
    // "Runtime-1" (the daemon): owns the system log and writes a session's
    // history into the session's OWN per-session file.
    const first = await createDurableHistoryStorage({ dataDir: root, ownsSystemRoot: true });
    const firstLocations = stubLocations(root);
    const firstProvider = createDurableSessionSystemCanonicalHistoryProvider({
      storage: first,
      dataDir: root,
      sessions: stubSessionRepository(root),
      locations: firstLocations,
    });
    const sessionId = 'session-handover';
    await firstProvider.append(
      appendChange(sessionId, 'op-1', [userMessage('first instance turn', 1)]),
    );
    await firstProvider.append(
      appendChange(sessionId, 'op-2', [assistantMessage('first instance reply', 2)]),
    );
    let firstSnapshot: Awaited<ReturnType<typeof firstProvider.readActive>>;
    try {
      // A SECOND PLAIN runtime on the same dataDir now BOOTS (the whole point
      // of the per-session model) and writes a DIFFERENT session without any
      // contention with the live first runtime.
      const second = await createDurableHistoryStorage({ dataDir: root, ownsSystemRoot: false });
      try {
        const secondProvider = createDurableSessionSystemCanonicalHistoryProvider({
          storage: second,
          dataDir: root,
          sessions: stubSessionRepository(root),
          locations: stubLocations(root),
        });
        await secondProvider.append(
          appendChange('session-other', 'op-1', [userMessage('parallel runtime turn', 1)]),
        );
        expect((await secondProvider.readActive('session-other')).messages).toHaveLength(1);
      } finally {
        await second.dispose();
      }
      // The first runtime keeps writing through the neighbor's open.
      await firstProvider.append(
        appendChange(sessionId, 'op-3', [assistantMessage('still the owner', 3)]),
      );
      firstSnapshot = await firstProvider.readActive(sessionId);
      expect(firstSnapshot.messages).toHaveLength(3);
      // Only a second SYSTEM-log owner (a second daemon) is refused: the
      // shared substrate stays single-writer, fail-fast, no rotation.
      const startedAtMs = Date.now();
      const refusal = await createDurableHistoryStorage({
        dataDir: root,
        ownsSystemRoot: true,
        ownerWaitTimeoutMs: 250,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(refusal).toBeInstanceOf(DurableHistoryLogOwnedError);
      expect(Date.now() - startedAtMs).toBeLessThan(5_000);
      // No rotation happened anywhere: g1 is still the highest generation of
      // BOTH the system log and the contested session's own file.
      expect(currentGeneration(join(root, 'durable-history'))).toBe(1);
      expect(currentGeneration(join(sessionsDir, sessionId))).toBe(1);
    } finally {
      await first.dispose();
    }
    // After the first SYSTEM owner exits, the next daemon open takes the SAME
    // generation (no empty-head rotation) and the session history — which
    // lived in the session's own file all along — rebuilds byte-for-byte.
    const third = await createDurableHistoryStorage({ dataDir: root, ownsSystemRoot: true });
    try {
      expect(third.system?.backend.generation).toBe(1);
      const thirdProvider = createDurableSessionSystemCanonicalHistoryProvider({
        storage: third,
        dataDir: root,
        sessions: stubSessionRepository(root),
        locations: stubLocations(root),
      });
      const snapshot = await thirdProvider.readActive(sessionId);
      expect(snapshot.messages).toEqual(firstSnapshot.messages);
      expect(snapshot.revision).toBe(firstSnapshot.revision);
      expect(snapshot.identityVector).toEqual(firstSnapshot.identityVector);
      // The new owner can keep appending onto the rebuilt history.
      const appended = await thirdProvider.append(
        appendChange(sessionId, 'op-4', [userMessage('second runtime turn', 4)]),
      );
      expect(appended.messages).toHaveLength(4);
    } finally {
      await third.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });
});

describe('durable canonical history provider (MCODE_HISTORY_PROVIDER=durable path)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (!fixture) return;
    await fixture.storage.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('persists native named-section baselines and deltas across durable restart', async () => {
    const sessionId = 'section-replay';
    const baseline = { role: 'system', content: '', sections: { identity: 'Identity', memory: 'old' }, timestamp: 1 };
    const update = { role: 'system', content: '', sections: { memory: 'new' }, timestamp: 4 };
    for (const provider of [fixture.durable, fixture.jsonl]) {
      await provider.append(appendChange(sessionId, 'sections-1', [baseline, userMessage('first', 2), assistantMessage('done', 3)]));
      await provider.append(appendChange(sessionId, 'sections-2', [update, userMessage('second', 5), assistantMessage('done', 6)]));
      expect((await provider.read(sessionId)).messages.filter((message) => message.role === 'system')).toEqual([baseline, update]);
    }
    await fixture.storage.dispose();
    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const restarted = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopened, dataDir: fixture.root, sessions: fixture.sessions, locations: fixture.locations,
      });
      expect((await restarted.read(sessionId)).messages.filter((message) => message.role === 'system')).toEqual([baseline, update]);
    } finally {
      await reopened.dispose();
    }
  });

  it('matches the JSONL provider for append, replace and compact', async () => {
    const sessionId = 'session-parity';
    const first = await fixture.durable.append(
      appendChange(sessionId, 'op-1', [userMessage('hi', 1)]),
    );
    const jsonlFirst = await fixture.jsonl.append(
      appendChange(sessionId, 'op-1', [userMessage('hi', 1)]),
    );
    expect(first.revision).toBe(jsonlFirst.revision);
    expect(first.messages).toEqual(jsonlFirst.messages);
    expect(first.identityVector).toEqual(jsonlFirst.identityVector);

    const second = await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]),
    );
    const jsonlSecond = await fixture.jsonl.append(
      appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]),
    );
    expect(second.revision).toBe(jsonlSecond.revision);
    expect(second.identityVector).toEqual(jsonlSecond.identityVector);

    const base = await fixture.durable.readActive(sessionId);
    const jsonlBase = await fixture.jsonl.readActive(sessionId);
    const replacement = {
      sessionId,
      turnId: 'turn-replace',
      reason: 'replaceMessages' as const,
      messages: [userMessage('hi', 1), assistantMessage('rewritten', 3)],
      replacementEntries: [
        {
          message: userMessage('hi', 1),
          identity: { kind: 'preserve' as const, messageId: base.identityVector[0]! },
        },
        {
          message: assistantMessage('rewritten', 3),
          identity: { kind: 'new' as const, seed: 'rewrite' },
        },
      ],
      operation: { id: 'op-replace', kind: 'test' },
    };
    expect(base.revision).toBe(jsonlBase.revision);
    const replaced = await fixture.durable.replace(replacement);
    const jsonlReplaced = await fixture.jsonl.replace(replacement);
    expect(replaced.revision).toBe(jsonlReplaced.revision);
    expect(replaced.identityVector).toEqual(jsonlReplaced.identityVector);

    const compaction = {
      sessionId,
      turnId: 'turn-compact',
      reason: 'replaceMessages' as const,
      messages: [{ role: 'compactionSummary', summary: 'compressed' }],
      operation: { id: 'op-compact', kind: 'compaction' },
      compactionId: 'compact-1',
      summary: 'compressed',
      method: 'llm_checkpoint' as const,
    };
    const compacted = await fixture.durable.compact(compaction);
    const jsonlCompacted = await fixture.jsonl.compact(compaction);
    // Wave 1: the durable replace above committed a `history.v2.replace`
    // event (canon §2.1: the generation grows on replace), so the fold
    // generation — and with it the compaction's marker — runs one ahead of
    // the frozen JSONL provider's compaction count. Pure-compaction sessions
    // (no non-compaction replaces) keep exact parity.
    expect(compacted.generation).toBe(jsonlCompacted.generation + 1);
    expect(compacted.messages).toEqual(jsonlCompacted.messages);
    // Documented wave-1 deviation: the fold generation (and with it the
    // lineage marker inside the revision hash) runs one ahead of the frozen
    // JSONL provider's compaction count after a non-compaction replace —
    // canon §2.1 (the generation grows on replace) against the frozen
    // marker-only counting.
    expect(compacted.revision).not.toBe(jsonlCompacted.revision);
  });

  it('keeps the settled read and the active read distinct for a pending tool tail', async () => {
    const sessionId = 'session-pending';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    const active = await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantToolCallMessage('call-1', 2)]),
    );
    // The same operations through the JSONL provider, so every comparison
    // below runs against a real session instead of an empty one.
    await fixture.jsonl.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    const jsonlActive = await fixture.jsonl.append(
      appendChange(sessionId, 'op-2', [assistantToolCallMessage('call-1', 2)]),
    );
    expect(active.identityVector).toHaveLength(2);
    expect(active.identityVector).toEqual(jsonlActive.identityVector);
    expect(active.revision).toBe(jsonlActive.revision);

    const settled = await fixture.durable.read(sessionId);
    // The durable settled view drops the pending tool round AND its turn's
    // user message: an interrupted turn is replayed whole, never partially.
    expect(settled.identityVector).toEqual([]);
    expect(settled.messages).toEqual([]);

    // Documented deviation, not parity: the JSONL settled read removes only
    // the pending round itself and keeps the in-flight turn's user message.
    const jsonlSettled = await fixture.jsonl.read(sessionId);
    expect(jsonlSettled.identityVector).toHaveLength(1);

    const stillActive = await fixture.durable.readActive(sessionId);
    expect(stillActive.identityVector).toHaveLength(2);
    expect(stillActive.revision).toBe(active.revision);
    expect(settled.revision).not.toBe(stillActive.revision);
  });

  it('heals a service delta over an unclosed tool round: closes the round honestly first (incident 03)', async () => {
    // Incident 03 (2026-11-05, session mvs_02567f43): a turn accepted two
    // parallel task calls, only one ever started; the abort cascade committed
    // the started call's error result and then a todo cadence reminder. The
    // reminder used to be committed FIRST and rejected by the strict walk
    // AFTER the commit — the durable log kept the poison and every later turn
    // died on history_read ("Conversation history could not be safely
    // updated"), restart included. Post-fix the append closes the stale round
    // BEFORE the delta (the same unknown-outcome synthesis the abort
    // reconcile uses) and the strict pass validates the PROJECTED sequence
    // before the enqueue — fail-closed for anything the repair cannot heal.
    const sessionId = 'session-brick';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('dig', 1)]));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [
        assistantToolCallsMessage([{ id: 'call-1' }, { id: 'call-2' }], 2),
      ]),
    );
    await fixture.durable.append(
      appendChange(sessionId, 'op-3', [toolResultMessage('call-1', 'task', 'task_error', 3)]),
    );

    // The poison delta arrives — and heals: the queued call's round closes
    // with its honest unknown-outcome result, then the reminder lands.
    const healed = await fixture.durable.append(
      appendChange(sessionId, 'op-4', [cadenceReminderMessage(4)], 'turn-reminder'),
    );
    expect(healed.identityVector).toHaveLength(5);
    const records = healed.messages;
    const synthesized = records[3] as Record<string, unknown>;
    expect(synthesized['role']).toBe('toolResult');
    expect(synthesized['toolCallId']).toBe('call-2');
    expect(synthesized['toolName']).toBe('task');
    expect(synthesized['isError']).toBe(true);
    expect(synthesized['details']).toMatchObject({
      checkpointPolicy: { outcome: 'tool-outcome-unknown', toolName: 'task' },
    });
    expect(String((synthesized['content'] as readonly { text: string }[])[0]?.text)).toContain(
      'tool-outcome-unknown',
    );
    // The reminder landed strictly after the closing result.
    expect((records[4] as Record<string, unknown>)['role']).toBe('custom');

    // The history is settled and readable; the next turn's user message
    // appends normally (pre-fix this was the permanent brick).
    const settled = await fixture.durable.read(sessionId);
    expect(settled.identityVector).toHaveLength(5);
    const nextTurn = await fixture.durable.append(
      appendChange(sessionId, 'op-5', [userMessage('continue', 5)], 'turn-2'),
    );
    expect(nextTurn.identityVector).toHaveLength(6);

    // The repair is durable: a fresh provider over the same storage (the
    // restart path, rebuildFromLog) rebuilds the healed, valid history.
    await fixture.storage.dispose();
    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const restarted = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopened,
        dataDir: fixture.root,
        sessions: fixture.sessions,
        locations: fixture.locations,
      });
      const rebuilt = await restarted.readActive(sessionId);
      expect(rebuilt.identityVector).toHaveLength(6);
      await expect(restarted.read(sessionId)).resolves.toBeDefined();
    } finally {
      await reopened.dispose();
    }
  });

  it('fails closed on an orphan tool result over an open round and keeps the log writable', async () => {
    // The synthesis only heals a CLEAN pending tail; anything else the strict
    // pass rejects before the commit — nothing is written.
    const sessionId = 'session-orphan';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('go', 1)]));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantToolCallsMessage([{ id: 'call-1' }], 2)]),
    );
    await expect(
      fixture.durable.append(
        appendChange(sessionId, 'op-3', [toolResultMessage('call-unknown', 'task', 'x', 3)]),
      ),
    ).rejects.toThrowError(/orphan or out-of-order tool result/);
    const active = await fixture.durable.readActive(sessionId);
    expect(active.identityVector).toHaveLength(2);
    await expect(fixture.durable.read(sessionId)).resolves.toBeDefined();
    // The round can still close through its honest path.
    const closed = await fixture.durable.append(
      appendChange(sessionId, 'op-4', [toolResultMessage('call-1', 'task', 'done', 4)]),
    );
    expect(closed.identityVector).toHaveLength(3);
  });

  it('tool result deltas over an unclosed round keep appending (regression)', async () => {
    // The repair only engages for non-toolResult deltas over an open round;
    // the ordinary round flow (results arriving one by one) is untouched.
    const sessionId = 'session-round-flow';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('go', 1)]));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [
        assistantToolCallsMessage([{ id: 'call-1' }, { id: 'call-2' }], 2),
      ]),
    );
    const first = await fixture.durable.append(
      appendChange(sessionId, 'op-3', [toolResultMessage('call-1', 'bash', 'ok', 3, false)]),
    );
    expect(first.identityVector).toHaveLength(3);
    const second = await fixture.durable.append(
      appendChange(sessionId, 'op-4', [toolResultMessage('call-2', 'bash', 'ok', 4, false)]),
    );
    expect(second.identityVector).toHaveLength(4);
    const settled = await fixture.durable.read(sessionId);
    expect(settled.identityVector).toHaveLength(4);
  });

  it('rebuilds the history from the durable log after reopen', async () => {
    const sessionId = 'session-reopen';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    const committed = await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]),
    );
    await fixture.storage.dispose();

    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const provider = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopened,
        dataDir: fixture.root,
        sessions: fixture.sessions,
        locations: fixture.locations,
      });
      const read = await provider.readActive(sessionId);
      expect(read.revision).toBe(committed.revision);
      expect(read.messages).toEqual(committed.messages);
      expect(read.identityVector).toEqual(committed.identityVector);
      const appended = await provider.append(
        appendChange(sessionId, 'op-3', [assistantMessage('again', 3)], 'turn-2'),
      );
      expect(appended.identityVector).toHaveLength(3);
    } finally {
      await reopened.dispose();
    }
  });

  it('rebuilds many append deltas of one session interleaved with another session', async () => {
    // Regression guard for the chunked rebuild: append deltas are collected
    // as chunks (one per entry, never re-spread) and concatenated once, while
    // the scan skips the other sessions' entries. Rebuilding after reopen
    // must reproduce the exact pre-reopen identity vector for both sessions.
    const sessionId = 'session-many-deltas';
    const interleaved = 'session-interleaved';
    await fixture.durable.append(
      appendChange(interleaved, 'op-other-1', [userMessage('other', 1)]),
    );
    let committed = await fixture.durable.append(
      appendChange(sessionId, 'op-1', [userMessage('hi', 1)]),
    );
    const DELTAS = 60;
    for (let index = 2; index <= DELTAS; index += 1) {
      committed = await fixture.durable.append(
        appendChange(
          sessionId,
          `op-${index}`,
          [assistantMessage(`hello-${index}`, index)],
          `turn-${index}`,
        ),
      );
      if (index % 10 === 0) {
        await fixture.durable.append(
          appendChange(interleaved, `op-other-${index / 10 + 1}`, [
            assistantMessage(`other-${index}`, index),
          ]),
        );
      }
    }
    expect(committed.identityVector).toHaveLength(DELTAS);
    await fixture.storage.dispose();

    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const provider = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopened,
        dataDir: fixture.root,
        sessions: fixture.sessions,
        locations: fixture.locations,
      });
      const read = await provider.readActive(sessionId);
      expect(read.revision).toBe(committed.revision);
      expect(read.identityVector).toEqual(committed.identityVector);
      expect(read.messages).toEqual(committed.messages);
      const other = await provider.readActive(interleaved);
      expect(other.identityVector).toHaveLength(1 + Math.floor(DELTAS / 10));
      const appended = await provider.append(
        appendChange(
          sessionId,
          'op-after-reopen',
          [assistantMessage('again', 999)],
          'turn-after',
        ),
      );
      expect(appended.identityVector).toHaveLength(DELTAS + 1);
      expect(appended.identityVector.slice(0, DELTAS)).toEqual(committed.identityVector);
    } finally {
      await reopened.dispose();
    }
  });

  it('rebuilds from the latest full state, dropping earlier append deltas', async () => {
    // Regression guard for the base reset inside the rebuild: a replace (a
    // new full-state base) after appends must discard the pre-replace deltas,
    // and appends after the replace extend only the new base.
    const sessionId = 'session-base-reset';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantMessage('stale', 2)], 'turn-2'),
    );
    const base = await fixture.durable.readActive(sessionId);
    const replaced = await fixture.durable.replace({
      sessionId,
      turnId: 'turn-replace',
      reason: 'replaceMessages',
      messages: [userMessage('hi', 1), assistantMessage('rewritten', 3)],
      replacementEntries: [
        {
          message: userMessage('hi', 1),
          identity: { kind: 'preserve', messageId: base.identityVector[0]! },
        },
        {
          message: assistantMessage('rewritten', 3),
          identity: { kind: 'new', seed: 'rewrite' },
        },
      ],
      operation: { id: 'op-replace', kind: 'test' },
    });
    expect(replaced.identityVector).toHaveLength(2);
    const appended = await fixture.durable.append(
      appendChange(sessionId, 'op-3', [assistantMessage('after', 4)], 'turn-3'),
    );
    expect(appended.identityVector).toHaveLength(3);
    await fixture.storage.dispose();

    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const provider = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopened,
        dataDir: fixture.root,
        sessions: fixture.sessions,
        locations: fixture.locations,
      });
      const read = await provider.readActive(sessionId);
      expect(read.revision).toBe(appended.revision);
      expect(read.identityVector).toEqual(appended.identityVector);
      expect(read.messages).toEqual(appended.messages);
    } finally {
      await reopened.dispose();
    }
  });

  it('rejects a duplicate append identity and keeps the state intact', async () => {
    const sessionId = 'session-dup';
    const first = await fixture.durable.append(
      appendChange(sessionId, 'op-1', [userMessage('hi', 1)]),
    );
    await expect(
      fixture.durable.append({
        ...appendChange(sessionId, 'op-2', [userMessage('hi', 1)]),
        identityHints: [
          { index: 0, messageId: first.identityVector[0]!, source: 'internal-new' },
        ],
      }),
    ).rejects.toThrow();
    expect((await fixture.durable.readActive(sessionId)).identityVector).toEqual(
      first.identityVector,
    );
  });

  it('mirrors a published JSONL state via adoptFromFiles and stays readable after reopen', async () => {
    const sessionId = 'session-mirror';
    const files: CanonicalHistoryFileAdapter = createCanonicalHistoryFileAdapter();
    const located = await fixture.locations.resolveSession(sessionId);
    const envelope: CanonicalHistoryEnvelope = {
      message_id: 'msg-user-v1-mirror',
      turn_id: 'turn-file',
      message: userMessage('from files', 1),
    };
    await files.replace(located.paths.messages, [envelope]);

    await fixture.durable.adoptFromFiles(sessionId);
    const mirrored = await fixture.durable.readActive(sessionId);
    expect(mirrored.identityVector).toEqual(['msg-user-v1-mirror']);
    expect(mirrored.messages).toEqual([userMessage('from files', 1)]);

    const appended = await fixture.durable.append(
      appendChange(sessionId, 'op-after-mirror', [assistantMessage('on top', 2)]),
    );
    expect(appended.identityVector).toHaveLength(2);

    await fixture.storage.dispose();
    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const provider = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopened,
        dataDir: fixture.root,
        sessions: fixture.sessions,
        locations: fixture.locations,
      });
      expect((await provider.readActive(sessionId)).revision).toBe(appended.revision);
    } finally {
      await reopened.dispose();
    }
  });

  it('inspects the file state without writing to the durable log', async () => {
    const sessionId = 'session-inspect';
    const files: CanonicalHistoryFileAdapter = createCanonicalHistoryFileAdapter();
    const located = await fixture.locations.resolveSession(sessionId);
    await files.publishInitial(located.paths.messages, [
      {
        message_id: 'msg-user-v1-inspect',
        turn_id: 'turn-inspect',
        message: userMessage('inspect me', 1),
      },
    ]);
    const inspected = await fixture.durable.inspectActive(sessionId);
    expect(inspected.identityVector).toEqual(['msg-user-v1-inspect']);
    // The inspect writes NOTHING to the durable log: the SYSTEM log head
    // stays exactly where the composition left it (the W10 open-time root
    // marker rides in the pi layer, not in the history entry stream this
    // assertion watches), and no per-session file is created for a session
    // whose only data is the published JSONL.
    const headBefore = fixture.system.backend.head;
    await fixture.durable.inspectActive(sessionId);
    expect(fixture.system.backend.head).toBe(headBefore);
    expect(fixture.storage.hasSessionFile(sessionId)).toBe(false);
  });

  it('serves inspectActive from the warm state without rescanning the durable log', async () => {
    // Regression guard for the hot path (turn continuation, teardown steering,
    // goal verification): a session already materialized in memory must serve
    // inspectActive from the warm state — cached revision, no whole-log
    // rebuild, no full-history re-hash — exactly like readActive. The provider
    // under test gets a counting view of the same stores so the test can
    // observe that no log backend is touched at all.
    const sessionId = 'session-inspect-warm';
    let backendAccesses = 0;
    const readCountingStorage: DurableHistoryStorage = new Proxy(fixture.storage, {
      get(target, property, receiver) {
        if (property === 'backendForRead') {
          return (...args: Parameters<DurableHistoryStorage['backendForRead']>) => {
            backendAccesses += 1;
            return target.backendForRead(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const provider = createDurableSessionSystemCanonicalHistoryProvider({
      storage: readCountingStorage,
      dataDir: fixture.root,
      sessions: fixture.sessions,
      locations: fixture.locations,
    });
    await provider.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    const second = await provider.append(
      appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]),
    );

    const accessesBeforeInspection = backendAccesses;
    const inspected = await provider.inspectActive(sessionId);
    expect(backendAccesses).toBe(accessesBeforeInspection);
    expect(inspected.revision).toBe(second.revision);
    expect(inspected.identityVector).toEqual(second.identityVector);
    expect(inspected.identityVector).toHaveLength(2);
    // The committed shape is the normalized canonical form (assistant string
    // content is lifted into a text block at the shared provider boundary),
    // so compare against the committed messages, not the raw fixture.
    expect(inspected.messages).toEqual(second.messages);

    // The warm path keeps the detached-copy boundary: mutating an inspected
    // message never reaches the provider's in-memory state.
    (inspected.messages[0] as { content?: string }).content = 'mutated';
    expect((await provider.readActive(sessionId)).messages).toEqual(second.messages);
  });
});


// R1 regression (W0 F5, confirmed 2026-10-27): in durable mode a file-backed
// mutation must never drop the durable-only tail (appends published only to
// the durable log). The wrapper publishes durable state BEFORE the mutation
// plans on the file; the adopt-side guard refuses a stale-baseline adopt.
describe('R1: file mutations never lose the durable-only tail', () => {
  it('mutation planning reads durable messages with continuous JSONL publication disabled', async () => {
    const fixture = await createFixture();
    try {
      const sessionId = 'session-fork-without-publisher';
      await fixture.durable.append(appendChange(sessionId, 'op-user', [userMessage('hi', 1)]));
      await fixture.durable.append(appendChange(sessionId, 'op-answer', [assistantMessage('hello', 2)]));
      expect(fixture.durable.publisher).toBeUndefined();
      const adapter = createSessionHistoryMutationAdapter({
        dataDir: fixture.root, sessions: fixture.sessions, locations: fixture.locations,
      });
      const wrapped = wrapSessionHistoryMutationForDurable(adapter, fixture.durable);
      const snapshot = await wrapped.read(sessionId);
      expect(snapshot.active).toHaveLength(2);
      expect(snapshot.activeSettled).toBe(true);
      expect(snapshot.active.map(({ message_id }) => message_id))
        .toEqual((await fixture.durable.readActive(sessionId)).identityVector);
    } finally {
      await fixture.storage.dispose();
    }
  });

  it('adoptFromFiles refuses to drop a durable-only tail from a stale file', async () => {
    const fixture = await createFixture();
    const sessionId = 'session-r1-adopt';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('hello', 2)]));
    const before = await fixture.durable.readActive(sessionId);
    expect(before.identityVector).toHaveLength(2);

    // Simulate the pre-guard world: write a STALE file (empty) behind the
    // provider's back, then call adoptFromFiles directly — the guard must
    // refresh the file from durable and refuse the adopt (rerun contract),
    // never drop the durable-only tail.
    const session = await fixture.sessions.get(sessionId);
    const paths = await fixture.locations.ensure(session);
    writeFileSync(paths.messages, '');

    await expect(fixture.durable.adoptFromFiles(sessionId)).rejects.toThrow(
      /does not match the durable log/u,
    );
    // The durable state survived intact.
    const after = await fixture.durable.readActive(sessionId);
    expect(after.identityVector).toHaveLength(2);
    // And the file was refreshed from durable (the guard's side effect).
    const refreshed = readFileSync(paths.messages, 'utf8').trim();
    expect(refreshed.length).toBeGreaterThan(0);
    await fixture.storage.dispose();
  });

  it('wrapped settle truncates the pending tail WITHOUT tripping the R1 guard (freshBaseline path)', async () => {
    // Review round 1 blocker: a settle truncates messages.jsonl, so the file
    // becomes a strict PREFIX of durable — indistinguishable from a lagging
    // file by shape alone. The wrapper publishes durable before the mutation
    // and adopts with freshBaseline, so the truncation mirrors back cleanly.
    const fixture = await createFixture();
    const sessionId = 'session-r1-wrapper';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    // pending tool tail: assistant + toolCall/toolResult pair left open
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [assistantMessage('thinking…', 2)]),
    );

    const wrapped = wrapSessionHistoryMutationForDurable(
      {
        settleTurnTail: async () => ({ sessionId } as never),
      } as never,
      fixture.durable,
    );
    // The settle callback above does not touch files (the real adapter does);
    // the guard's freshness contract is what this tests: publish-before +
    // freshBaseline adopt never throws DurableAdoptStaleFileError.
    await expect(wrapped.settleTurnTail!( { sessionId, turnId: 't', outcome: { status: 'completed' } } as never)).resolves.toBeDefined();
    const after = await fixture.durable.readActive(sessionId);
    expect(after.identityVector.length).toBeGreaterThanOrEqual(2);
    await fixture.storage.dispose();
  });

  it('wrapped stageFork publish mirrors the fork WITHOUT the guard wiping it (freshBaseline)', async () => {
    // Review round 2 blocker: stageFork.publish adopt must pass
    // freshBaseline — the direct adopt refreshed the target file from a
    // (seed-empty) durable state and WIPED the just-published fork.
    const fixture = await createFixture();
    const sourceId = 'session-r1-fork-src';
    const targetId = 'session-r1-fork-dst';
    await fixture.durable.append(appendChange(sourceId, 'op-1', [userMessage('hi', 1)]));

    const wrapped = wrapSessionHistoryMutationForDurable(
      {
        stageFork: async () => ({
          publish: async () => {
            // Simulate the real adapter writing the fork into the TARGET's
            // messages.jsonl.
            const session = await fixture.sessions.get(targetId);
            const paths = await fixture.locations.ensure(session);
            const forked = [userMessage('hi', 1)].map((message, index) => ({
              message_id: `msg-fork-${index}`,
              turn_id: 'turn-fork',
              message,
            }));
            writeFileSync(paths.messages, `${JSON.stringify(forked[0])}\n`);
          },
        }),
      } as never,
      fixture.durable,
    );
    const staged = await wrapped.stageFork!({ sourceSessionId: sourceId, targetSessionId: targetId } as never);
    await expect(staged.publish()).resolves.toBeUndefined();
    // The fork content survived in the target's file (not wiped by a guard
    // refresh) and was mirrored into the durable log.
    const session = await fixture.sessions.get(targetId);
    const paths = await fixture.locations.ensure(session);
    const fileContent = readFileSync(paths.messages, 'utf8');
    expect(fileContent).toContain('hi');
    const durableTarget = await fixture.durable.readActive(targetId);
    expect(durableTarget.identityVector.length).toBeGreaterThanOrEqual(1);
    await fixture.storage.dispose();
  });

  it('publishDurableStateToFiles is a no-op when the file is fresh, publishes when stale', async () => {
    const fixture = await createFixture();
    const sessionId = 'session-r1-publish';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('hi', 1)]));
    const session = await fixture.sessions.get(sessionId);
    const paths = await fixture.locations.ensure(session);
    writeFileSync(paths.messages, '');

    await fixture.durable.publishDurableStateToFiles(sessionId);
    const published = readFileSync(paths.messages, 'utf8');
    expect(published).toContain('hi');
    // Second call: fresh now — no rewrite, no error.
    await fixture.durable.publishDurableStateToFiles(sessionId);
    await fixture.storage.dispose();
  });
});

describe('llm_checkpoint kept-tail plans (incident 2026-11-07, mvs_f3f8d0ab)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (!fixture) return;
    await fixture.storage.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const SUMMARY = (text = 'compressed history') => ({
    role: 'compactionSummary',
    summary: text,
    tokensBefore: 42_000,
    timestamp: 100,
  });

  /** Seeds [user, assistant, user, assistant] (no tool round) and returns the active snapshot. */
  async function seedPlainHistory(
    provider: (typeof fixture)['durable'] | (typeof fixture)['jsonl'],
    sessionId: string,
  ) {
    await provider.append(appendChange(sessionId, 'seed-1', [userMessage('first question', 1)]));
    await provider.append(appendChange(sessionId, 'seed-2', [assistantMessage('first answer', 2)]));
    await provider.append(appendChange(sessionId, 'seed-3', [userMessage('second question', 4)]));
    await provider.append(appendChange(sessionId, 'seed-4', [assistantMessage('second answer', 5)]));
    return provider.readActive(sessionId);
  }

  /** Seeds a valid tool round into [user, toolCall, toolResult, user, assistant] (durable view). */
  async function seedTurnHistory(provider: (typeof fixture)['durable'], sessionId: string) {
    await provider.append(appendChange(sessionId, 'seed-1', [userMessage('first question', 1)]));
    await provider.append(
      appendChange(sessionId, 'seed-2', [assistantToolCallMessage('call-1', 2)]),
    );
    await provider.append(
      appendChange(sessionId, 'seed-3', [toolResultMessage('call-1', 'read', 'file body', 3, false)]),
    );
    await provider.append(appendChange(sessionId, 'seed-4', [userMessage('second question', 4)]));
    await provider.append(appendChange(sessionId, 'seed-5', [assistantMessage('second answer', 5)]));
    return provider.readActive(sessionId);
  }

  function checkpointChange(
    sessionId: string,
    operationId: string,
    messages: readonly unknown[],
    extra: Record<string, unknown> = {},
  ) {
    return {
      sessionId,
      turnId: 'turn-compact',
      reason: 'replaceMessages' as const,
      messages,
      operation: { id: operationId, kind: 'compaction' as const },
      compactionId: `ctx_${operationId}`,
      summary: 'compressed history',
      method: 'llm_checkpoint' as const,
      ...extra,
    };
  }

  it('commits a source-verified retained tail through both providers (the unified cut shape)', async () => {
    const base = await seedPlainHistory(fixture.durable, 'session-kept-tail');
    const jsonlBase = await seedPlainHistory(fixture.jsonl, 'session-kept-tail');
    expect(base.identityVector).toHaveLength(4);
    expect(base.identityVector).toEqual(jsonlBase.identityVector);

    // The unified scheduler's cut: the summary covers [0..1]; [2..3] are kept
    // verbatim with their source lineage.
    const messages = [SUMMARY(), userMessage('second question', 4), assistantMessage('second answer', 5)];
    const change = checkpointChange('session-kept-tail', 'op-kept', messages, {
      replacementSourceIndexes: [2, 3],
    });
    const compacted = await fixture.durable.compact(change);
    const jsonlCompacted = await fixture.jsonl.compact({ ...change, compactionId: 'ctx_jsonl-op-kept' });

    // Durable parity.
    expect(jsonlCompacted.messages).toEqual(compacted.messages);
    expect(jsonlCompacted.identityVector).toEqual(compacted.identityVector);
    // The kept tail returns the SOURCE messages verbatim (canonical forms).
    expect(compacted.messages).toEqual([messages[0], jsonlBase.messages[2], jsonlBase.messages[3]]);
    expect(compacted.generation).toBe(1);
    // The kept tail preserves the source identities of the retained window.
    expect(compacted.identityVector.slice(1)).toEqual(base.identityVector.slice(2));
  });

  it('keeps owner input appended between the plan and the commit (the steering race, honest plan rebuild)', async () => {
    const sessionId = 'session-steer-race';
    await seedTurnHistory(fixture.durable, sessionId);
    // The owner steers while the summarizer runs: the append lands BEFORE the
    // commit rebuilds the plan from the fresh baseline.
    await fixture.durable.append(
      appendChange(sessionId, 'steer-1', [userMessage('steer: change of plans', 6)], 'turn-2'),
    );
    const fresh = await fixture.durable.readActive(sessionId);
    const cutIndex = 3;
    const kept = fresh.messages.slice(cutIndex);
    const messages = [SUMMARY(), ...kept];
    const compacted = await fixture.durable.compact(
      checkpointChange(sessionId, 'op-steer', messages, {
        replacementSourceIndexes: kept.map((_message, offset) => cutIndex + offset),
      }),
    );
    // Nothing is dropped: the steer rides the retained tail verbatim, after
    // the tool round the summary covers.
    expect(compacted.messages).toEqual([messages[0], ...kept]);
    expect(compacted.messages.at(-1)).toEqual(userMessage('steer: change of plans', 6));
  });

  it('a plan whose replacement range stops short of the trailing history keeps the suffix (wave 1: the drop hazard is impossible by construction)', async () => {
    const sessionId = 'session-stale-plan';
    await seedTurnHistory(fixture.durable, sessionId);
    // The plan was built against the 5-envelope baseline; the owner appended
    // before the commit. Wave 1: the replace event covers only the planned
    // seq range — everything after it (the steer) survives in the log as the
    // live suffix, so the incident's silent drop is impossible by
    // construction and the old whole-list staleness refusal disappears.
    await fixture.durable.append(
      appendChange(sessionId, 'steer-1', [userMessage('steer: change of plans', 6)], 'turn-2'),
    );
    const shortCut = checkpointChange(sessionId, 'op-stale', [
      SUMMARY('compressed history that replaces only the covered prefix'),
      userMessage('second question', 4),
      assistantMessage('second answer', 5),
    ], { replacementSourceIndexes: [3, 4] });
    const committed = await fixture.durable.compact(shortCut);
    // The cut covers [user, toolCall, toolResult]; the summary rides in front
    // of the kept suffix: second question, second answer, AND the steer.
    expect(committed.messages).toHaveLength(4);
    expect(committed.messages[0]).toEqual(SUMMARY('compressed history that replaces only the covered prefix'));
    expect(committed.messages.at(-1)).toEqual(userMessage('steer: change of plans', 6));
    const active = await fixture.durable.readActive(sessionId);
    expect(active.identityVector).toHaveLength(4);
    // The same plan on the frozen JSONL provider keeps the legacy refusal:
    // the whole-list replacement would drop the steer append.
    await seedPlainHistory(fixture.jsonl, 'session-stale-plan-jsonl');
    const jsonlStale = checkpointChange('session-stale-plan-jsonl', 'op-stale-jsonl', [
      SUMMARY(),
      userMessage('second question', 4),
      assistantMessage('second answer', 5),
    ], { replacementSourceIndexes: [2, 3] });
    await fixture.jsonl.append(
      appendChange('session-stale-plan-jsonl', 'steer-1', [userMessage('steer: change of plans', 6)], 'turn-2'),
    );
    await expect(fixture.jsonl.compact(jsonlStale)).rejects.toThrowError(/plan is stale/);
  });

  it('refuses kept messages that do not match their source envelopes, and plans without lineage', async () => {
    const sessionId = 'session-verbatim';
    await seedPlainHistory(fixture.durable, sessionId);
    const rewritten = checkpointChange(sessionId, 'op-rewrite', [
      SUMMARY(),
      userMessage('REWRITTEN question', 4),
      assistantMessage('second answer', 5),
    ], { replacementSourceIndexes: [2, 3] });
    await expect(fixture.durable.compact(rewritten)).rejects.toThrowError(
      /kept tail diverges from its source/,
    );
    // Incomplete lineage: kept messages without source indexes.
    const noLineage = checkpointChange(sessionId, 'op-nolineage', [
      SUMMARY(),
      userMessage('second question', 4),
      assistantMessage('second answer', 5),
    ]);
    await expect(fixture.durable.compact(noLineage)).rejects.toThrowError(
      /kept-tail source lineage/,
    );
    await expect(fixture.jsonl.compact({ ...noLineage, compactionId: 'ctx_jsonl-nolineage' })).rejects.toThrowError(
      /kept-tail source lineage/,
    );
    const stillActive = await fixture.durable.readActive(sessionId);
    expect(stillActive.identityVector).toHaveLength(4);
  });

  it('persists native section replay with the checkpoint and accepts delivery after restart', async () => {
    const sessionId = 'session-native-checkpoint';
    const sections = { role: 'system', content: '', sections: { identity: 'stable', project: 'current' }, timestamp: 1 };
    await fixture.durable.append(appendChange(sessionId, 'native-seed', [sections, userMessage('old question', 2), assistantMessage('old answer', 3), userMessage('retained question', 4)]));
    const before = await fixture.durable.readActive(sessionId);
    const summary = { ...SUMMARY(), compactionId: 'ctx_native-checkpoint' };
    const installed = await fixture.durable.compact(checkpointChange(sessionId, 'native-checkpoint', [summary, before.messages[3]], { replacementSourceIndexes: [3] }));
    expect(installed.messages).toEqual([summary, sections, before.messages[3]]);
    expect(installed.identityVector[2]).toBe(before.identityVector[3]);
    await fixture.storage.dispose();
    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const restarted = createDurableSessionSystemCanonicalHistoryProvider({ storage: reopened, dataDir: fixture.root, sessions: fixture.sessions, locations: fixture.locations });
      expect((await restarted.readActive(sessionId)).messages).toEqual(installed.messages);
      const delivered = await restarted.replace({ sessionId, turnId: 'after-restart', reason: 'replaceMessages', messages: installed.messages,
        metadata: { committedReplacementId: summary.compactionId }, operation: { id: 'native-delivery', kind: 'replace' } });
      expect(delivered.identityVector).toEqual(installed.identityVector);
    } finally { await reopened.dispose(); }
  });

  it('returns the installed checkpoint when only the terminal receipt flush fails', async () => {
    const sessionId = 'session-end-receipt-failure';
    await seedPlainHistory(fixture.durable, sessionId);
    const flush = fixture.storage.worker.flush.bind(fixture.storage.worker);
    let calls = 0;
    const spy = vi.spyOn(fixture.storage.worker, 'flush').mockImplementation(async () => {
      calls += 1;
      if (calls === 4) throw new Error('synthetic terminal receipt failure');
      return flush();
    });
    try {
      const committed = await fixture.durable.compact(
        checkpointChange(sessionId, 'op-receipt-failure', [SUMMARY('installed summary')]),
      );
      expect(committed.messages).toEqual([SUMMARY('installed summary')]);
      expect((await fixture.durable.readActive(sessionId)).messages).toEqual(committed.messages);
    } finally {
      spy.mockRestore();
      await flush();
    }
  });

  it('keeps the legacy whole-history plans valid: [summary] alone and [summary] + current-user tail', async () => {
    const sessionId = 'session-legacy';
    await seedPlainHistory(fixture.durable, sessionId);
    // Manual compaction: the whole history becomes the summary.
    const manual = await fixture.durable.compact(
      checkpointChange(sessionId, 'op-manual', [SUMMARY('manual summary')]),
    );
    expect(manual.messages).toEqual([SUMMARY('manual summary')]);

    // The В1 barrier delivery: [summary] + the current-user tail (marker + user).
    // The tail user must be an EXTERNAL user envelope (a display-user identity).
    const sessionId2 = 'session-legacy-tail';
    await seedPlainHistory(fixture.durable, sessionId2);
    await fixture.durable.append({
      ...appendChange(sessionId2, 'seed-5', [userMessage('owner tail question', 6)], 'turn-2'),
      identityHints: [{ index: 0, messageId: 'msg-user-v1-fixture-tail', source: 'display-user' }],
    });
    const tailed = await fixture.durable.readActive(sessionId2);
    const tailUserIndex = tailed.identityVector.length - 1;
    const marker = {
      role: 'custom',
      customType: 'compaction-tail-marker',
      display: false,
      content: 'history replaced above',
      timestamp: 90,
    };
    const tailUser = tailed.messages[tailUserIndex];
    const withTail = await fixture.durable.compact(
      checkpointChange(sessionId2, 'op-tail', [
        SUMMARY(),
        marker,
        tailUser,
      ], { currentUserSourceIndex: tailUserIndex }),
    );
    expect(withTail.messages).toEqual([SUMMARY(), marker, tailUser]);

    // The same plan with owner input appended past the tail user: wave 1
    // covers only the planned range — the tail user and the steer survive as
    // the live suffix, the marker rides in front of them, nothing drops (the
    // old whole-list staleness refusal guarded a hazard the seq range makes
    // impossible by construction).
    await fixture.durable.append(
      appendChange(sessionId2, 'steer-2', [userMessage('steer', 7)], 'turn-3'),
    );
    const grown = await fixture.durable.readActive(sessionId2);
    // The same-shaped plan over the just-compacted prefix: the covered range
    // is the previous summary + marker only (the tail user and the steer are
    // the live suffix), so a new summary of it cannot be smaller than its
    // source — the wave-1 size property refuses the ineffective replace
    // fail-closed. What the old staleness refusal guarded (silently dropping
    // the steer) is structurally impossible now; what remains is the honest
    // ineffectiveness check.
    await expect(
      fixture.durable.compact(
        checkpointChange(sessionId2, 'op-tail-2', [
          SUMMARY('a fresh summary of the regrown history'),
          marker,
          tailUser,
        ], { currentUserSourceIndex: grown.identityVector.length - 2 }),
      ),
    ).rejects.toThrowError(/not smaller than its source/);
    const untouched = await fixture.durable.readActive(sessionId2);
    expect(untouched.identityVector).toHaveLength(4);
  });
});

describe('a second compaction on an already-compacted window (incident 2026-11-07, mvs_70b7f22: the inverted seq range)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (!fixture) return;
    await fixture.storage.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const SUMMARY = (text: string) => ({
    role: 'compactionSummary',
    summary: text,
    tokensBefore: 42_000,
    timestamp: 100,
  });

  function checkpointChange(
    sessionId: string,
    operationId: string,
    messages: readonly unknown[],
    extra: Record<string, unknown> = {},
  ) {
    return {
      sessionId,
      turnId: 'turn-compact',
      reason: 'replaceMessages' as const,
      messages,
      operation: { id: operationId, kind: 'compaction' as const },
      compactionId: `ctx_${operationId}`,
      summary: 'compressed history',
      method: 'llm_checkpoint' as const,
      ...extra,
    };
  }

  /**
   * The live shape: compaction #1 commits with a kept tail (the fold's
   * summary segment carries the replace event's log seq, HIGHER than the kept
   * tail's original segment seq), a turn appends on top, and compaction #2
   * plans a cut across that boundary. The covered prefix now resolves to the
   * ascending seq interval of its segments and commits correctly — before the
   * fix the same plan wrote a replace with an INVERTED seq range and both the
   * live fold and every cold start broke on it.
   */
  it('commits the expressible cut across the compaction boundary as a normalized seq interval', async () => {
    const sessionId = 'session-inverted-range';
    await fixture.durable.append(appendChange(sessionId, 'seed-1', [userMessage('first question', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'seed-2', [assistantMessage('first answer', 2)]));
    await fixture.durable.append(appendChange(sessionId, 'seed-3', [userMessage('second question', 4)]));
    await fixture.durable.append(appendChange(sessionId, 'seed-4', [assistantMessage('second answer', 5)]));

    // Compaction #1 (the successful wave): summary covers [0..1], the tail
    // [2..3] is kept verbatim.
    const first = await fixture.durable.compact(
      checkpointChange(sessionId, 'op-1', [
        SUMMARY('first compression'),
        userMessage('second question', 4),
        assistantMessage('second answer', 5),
      ], { replacementSourceIndexes: [2, 3] }),
    );
    expect(first.messages).toHaveLength(3);

    // The turn appends on the compacted window.
    await fixture.durable.append(
      appendChange(sessionId, 'post-1', [userMessage('third question', 7)], 'turn-2'),
    );
    const before = await fixture.durable.readActive(sessionId);
    expect(before.messages).toHaveLength(4);

    // Compaction #2 on the ALREADY-COMPACTED window: the cut covers
    // [summary, second question, second answer], keeps the fresh append.
    const committed = await fixture.durable.compact(
      checkpointChange(sessionId, 'op-2', [
        SUMMARY('second compression'),
        before.messages[3],
      ], { replacementSourceIndexes: [3] }),
    );
    expect(committed.messages).toEqual([SUMMARY('second compression'), before.messages[3]]);
    const active = await fixture.durable.readActive(sessionId);
    expect(active.messages).toEqual([SUMMARY('second compression'), before.messages[3]]);

    // The committed protocol replays identically on a cold start: no poison
    // in the log.
    await fixture.storage.dispose();
    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const cold = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopened,
        dataDir: fixture.root,
        sessions: stubSessionRepository(fixture.root),
        locations: stubLocations(fixture.root),
      });
      const replayed = await cold.readActive(sessionId);
      expect(replayed.messages).toEqual([SUMMARY('second compression'), before.messages[3]]);
    } finally {
      await reopened.dispose();
    }
  });

  /**
   * The genuinely degenerate cut: the covered prefix leaves an uncovered
   * segment INSIDE the seq interval it spans, so no `compaction.replace`
   * event can express it. It must refuse BEFORE any protocol event (fail
   * -closed canon 1.4) with the honest nothing-to-cut error — not a
   * contract breach — and leave the log byte-identical.
   */
  it('refuses the unexpressible cut before any protocol event is written and the log stays readable', async () => {
    const sessionId = 'session-degenerate-cut';
    await fixture.durable.append(appendChange(sessionId, 'seed-1', [userMessage('first question', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'seed-2', [assistantMessage('first answer', 2)]));
    await fixture.durable.append(appendChange(sessionId, 'seed-3', [userMessage('second question', 4)]));
    await fixture.durable.append(appendChange(sessionId, 'seed-4', [assistantMessage('second answer', 5)]));
    await fixture.durable.compact(
      checkpointChange(sessionId, 'op-1', [
        SUMMARY('first compression'),
        userMessage('second question', 4),
        assistantMessage('second answer', 5),
      ], { replacementSourceIndexes: [2, 3] }),
    );
    await fixture.durable.append(
      appendChange(sessionId, 'post-1', [userMessage('third question', 7)], 'turn-2'),
    );
    const before = await fixture.durable.readActive(sessionId);

    // The cut covers [summary, second question] but leaves `second answer` —
    // whose segment seq sits inside the covered run's seq interval —
    // uncovered: the fold apply would drop it. Honest refusal, zero writes.
    await expect(
      fixture.durable.compact(
        checkpointChange(sessionId, 'op-2', [
          SUMMARY('second compression'),
          assistantMessage('second answer', 5),
          userMessage('third question', 7),
        ], { replacementSourceIndexes: [2, 3] }),
      ),
    ).rejects.toThrowError(CompactionNothingToCutError);
    const after = await fixture.durable.readActive(sessionId);
    expect(after.messages).toEqual(before.messages);
    expect(after.identityVector).toEqual(before.identityVector);

    // The log holds no trace of the refused round.
    await fixture.storage.dispose();
    const reopened = await createDurableHistoryStorage({ dataDir: fixture.root });
    try {
      const cold = createDurableSessionSystemCanonicalHistoryProvider({
        storage: reopened,
        dataDir: fixture.root,
        sessions: stubSessionRepository(fixture.root),
        locations: stubLocations(fixture.root),
      });
      const replayed = await cold.readActive(sessionId);
      expect(replayed.messages).toEqual(before.messages);
      expect(replayed.identityVector).toEqual(before.identityVector);
    } finally {
      await reopened.dispose();
    }
  });

  /**
   * The poisoned log of the live incident (a replace with an inverted seq
   * range written by the pre-fix path): the replay skips the invalid range
   * with diagnostics and the session stays readable — the fold keeps the
   * pre-replace state. The full poison-replay contract (open start, skipped
   * replace, closing end) lives in `durable-history-event-log.test.ts`.
   */
  it('refuses a degenerate zero-covered plan before any protocol event is written', async () => {
    const sessionId = 'session-zero-covered';
    await fixture.durable.append(appendChange(sessionId, 'seed-1', [userMessage('first question', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'seed-2', [assistantMessage('first answer', 2)]));
    const before = await fixture.durable.readActive(sessionId);
    // A kept tail that starts at index 0: the cut covers nothing.
    await expect(
      fixture.durable.compact(
        checkpointChange(sessionId, 'op-zero', [
          SUMMARY('a summary over nothing'),
          userMessage('first question', 1),
          assistantMessage('first answer', 2),
        ], { replacementSourceIndexes: [0, 1] }),
      ),
    ).rejects.toThrowError(CompactionNothingToCutError);
    const after = await fixture.durable.readActive(sessionId);
    expect(after.messages).toEqual(before.messages);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-session migration (owner decision 2026-11-18): a session whose history
// lives in the LEGACY monolith gets its own file seeded on the FIRST live
// write. The regression this pins is the stale-carrier checkpoint: cold open
// #1 writes the fold checkpoint against the MONOLITH; after the migration the
// file (generation 1, like the monolith) must never resume from that
// monolith position — its own records would be silently hidden.
// ─────────────────────────────────────────────────────────────────────────────
describe('per-session migration: the legacy monolith seeds the session own file on the first live write', () => {
  it('survives the cold open AFTER the migration with the full history (no stale-checkpoint hiding, no baseless file)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-migration-'));
    try {
      const sessionId = 'session-migrate';
      const envelopes: CanonicalHistoryEnvelope[] = [
        { message_id: 'msg-mig-user', turn_id: 'turn-mig', message: userMessage('legacy base', 1) },
      ];
      // The pre-2026-11-18 dataDir: a monolith holding the session's base.
      const monolith = SqliteZstdBackend.open(join(root, 'durable-history'));
      await monolith.appendBatch([
        {
          id: `${sessionId}|full|seed|legacy`,
          parentId: null,
          kind: 'history.v1.full',
          payload: { sessionId, reason: 'seed', envelopes },
        },
      ]);
      monolith.close();

      // Cold open #1 (against the monolith): the fold reads, the checkpoint
      // is written against the MONOLITH carrier.
      const first = await createDurableHistoryStorage({ dataDir: root });
      const firstProvider = createDurableSessionSystemCanonicalHistoryProvider({
        storage: first,
        dataDir: root,
        sessions: stubSessionRepository(root),
        locations: stubLocations(root),
      });
      const before = await firstProvider.readActive(sessionId);
      expect(before.identityVector).toEqual(['msg-mig-user']);
      // The live write MIGRATES: seed the own file with the base, then the delta.
      await firstProvider.append(appendChange(sessionId, 'op-mig', [assistantMessage('migrated tail', 2)]));
      const live = await firstProvider.readActive(sessionId);
      expect(live.messages).toHaveLength(2);
      // The own file holds base + delta — self-sufficient.
      const ownBackend = (await first.sessionStores(sessionId)).backend;
      const ownHistory = ownBackend
        .readDelta(0, 8 * 1024 * 1024)
        .filter((entry) => !entry.kind.startsWith('pi.'));
      expect(ownHistory.map((entry) => entry.kind)).toEqual(['history.v1.full', 'history.v1.append']);
      await first.dispose();

      // Cold open #2: the fold comes from the OWN file — the stale
      // monolith-carrier checkpoint from cold open #1 must NOT resume the
      // file scan from a monolith position.
      const second = await createDurableHistoryStorage({ dataDir: root });
      try {
        const secondProvider = createDurableSessionSystemCanonicalHistoryProvider({
          storage: second,
          dataDir: root,
          sessions: stubSessionRepository(root),
          locations: stubLocations(root),
        });
        const after = await secondProvider.readActive(sessionId);
        expect(after.messages).toEqual(live.messages);
        expect(after.identityVector).toEqual(live.identityVector);
        // The migrated session keeps appending in place.
        const appended = await secondProvider.append(
          appendChange(sessionId, 'op-mig-2', [userMessage('post migration', 3)]),
        );
        expect(appended.messages).toHaveLength(3);
      } finally {
        await second.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
