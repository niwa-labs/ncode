import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord, SessionRepository } from '../../sessions/repo/contract.js';
import type {
  CanonicalHistoryEnvelope,
} from '../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../sessions/representation/canonical-history.js';
import {
  createDurableHistoryStorage,
  createDurableSessionSystemCanonicalHistoryProvider,
  CompactionStartLeaseActiveError,
  type DurableHistoryStorage,
  type DurableSessionSystemCanonicalHistoryProvider,
} from './durable-canonical-history-provider.js';
import {
  createDurableJsonlPublisher,
  type DurableJsonlPublisher,
} from './durable-jsonl-publisher.js';
import { createSessionHistoryIoLane } from './mutation/session-history-coordination.js';
import type { SessionHistoryLocationResolver } from './session-history-location.js';
import type { SessionHistoryPaths } from './session-history-paths.js';

/**
 * Wave-1 acceptance suite over the REAL durable store (canon 05 §3, items
 * 1.3–1.8): the compaction commit is the four-event protocol writing
 * kilobytes over a seq range (never a full|compact list) with the live
 * suffix guaranteed by construction; the repair is an appended event (never
 * a full|repair rewrite); an unclosed compaction.start is closed by the 600s
 * lease; delete is a tombstone with the explicit purge as the only physical
 * removal; `messages.jsonl` stays the derived view of the fold; and the fold
 * checkpoint is a disposable cache whose deletion changes nothing while its
 * presence keeps the cold open off the whole-log scan.
 */

const EVENT_START = 'history.v2.compaction.start';
const EVENT_SUMMARY = 'history.v2.compaction.summary';
const EVENT_REPLACE = 'history.v2.compaction.replace';
const EVENT_END = 'history.v2.compaction.end';
const EVENT_REPAIR = 'history.v2.repair';
const EVENT_TOMBSTONE = 'history.v2.tombstone';
const FULL_KIND = 'history.v1.full';

interface Fixture {
  readonly root: string;
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly locations: SessionHistoryLocationResolver;
  storage: DurableHistoryStorage;
  durable: DurableSessionSystemCanonicalHistoryProvider;
}

function stubLocations(root: string): SessionHistoryLocationResolver {
  const pathsFor = (sessionId: string): SessionHistoryPaths => {
    const sessionDir = join(root, 'v2', 'sessions', sessionId);
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
  const root = await mkdtemp(join(tmpdir(), 'durable-events-'));
  const storage = await createDurableHistoryStorage({ dataDir: root });
  return {
    root,
    sessions: stubSessionRepository(root),
    locations: stubLocations(root),
    storage,
    durable: createDurableSessionSystemCanonicalHistoryProvider({
      storage,
      dataDir: root,
      sessions: stubSessionRepository(root),
      locations: stubLocations(root),
    }),
  };
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.storage.dispose();
  await rm(fixture.root, { recursive: true, force: true });
}

/** Reopens a NEW provider over the same storage — the crash-restart path (a new writer token). */
function reopenProvider(fixture: Fixture): DurableSessionSystemCanonicalHistoryProvider {
  return createDurableSessionSystemCanonicalHistoryProvider({
    storage: fixture.storage,
    dataDir: fixture.root,
    sessions: fixture.sessions,
    locations: fixture.locations,
  });
}

interface LogEntryView {
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly bytes: number;
}

/** The session's own durable entries in log order (the runtime's `pi.*` bookkeeping excluded). */
async function sessionEntries(storage: DurableHistoryStorage, sessionId: string): Promise<LogEntryView[]> {
  // Per-session storage: the entries live in the session's OWN log file.
  const backend = (await storage.sessionStores(sessionId)).backend;
  return backend
    .readDelta(0, 256 * 1024 * 1024)
    .filter((stored) => !stored.kind.startsWith('pi.'))
    .filter((stored) => (stored.payload as { sessionId?: string }).sessionId === sessionId)
    .map((stored) => ({
      id: stored.id,
      kind: stored.kind,
      payload: stored.payload as Record<string, unknown>,
      bytes: JSON.stringify(stored.payload).length,
    }));
}

function userMessage(text: string, timestamp: number) {
  return { role: 'user', content: `${text} ${'x'.repeat(160)}`, timestamp };
}

function assistantMessage(text: string, timestamp: number) {
  return { role: 'assistant', content: [{ type: 'text', text: `${text} ${'x'.repeat(160)}` }], timestamp };
}

function assistantToolCallMessage(callId: string, timestamp: number) {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: 'read', arguments: {} }],
    timestamp,
  };
}

function toolResultMessage(callId: string, timestamp: number) {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'read',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp,
  };
}

function appendChange(
  sessionId: string,
  operationId: string,
  messages: readonly unknown[],
  turnId = 'turn-1',
) {
  return {
    sessionId,
    turnId,
    reason: 'messageDelta' as const,
    messages,
    operation: { id: operationId, kind: 'test' },
  };
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
    summary: typeof messages[0] === 'object' && messages[0] !== null
      ? String((messages[0] as { summary?: unknown }).summary ?? '')
      : 'summary',
    method: 'llm_checkpoint' as const,
    ...extra,
  };
}

const SUMMARY = (text = 'compressed history') => ({
  role: 'compactionSummary',
  summary: text,
  tokensBefore: 42_000,
  timestamp: 100,
});

// ---------------------------------------------------------------------------

describe('wave 1.4 — the compaction commit is the four-event protocol', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await disposeFixture(fixture);
  });

  async function seedRoundHistory(sessionId: string, rounds = 10): Promise<void> {
    let clock = 1;
    let op = 0;
    const append = async (messages: readonly unknown[]): Promise<void> => {
      op += 1;
      await fixture.durable.append(
        appendChange(sessionId, `op-${String(op)}`, messages, `turn-${String(op)}`),
      );
    };
    await append([userMessage(`first question ${'x'.repeat(512)}`, clock)]);
    clock += 1;
    for (let index = 0; index < rounds; index += 1) {
      await append([assistantToolCallMessage(`call-${String(index)}`, clock)]);
      clock += 1;
      await append([toolResultMessage(`call-${String(index)}`, clock)]);
      clock += 1;
      await append([assistantMessage(`answer ${String(index)} ${'x'.repeat(512)}`, clock)]);
      clock += 1;
      await append([userMessage(`question ${String(index)} ${'x'.repeat(512)}`, clock)]);
      clock += 1;
    }
  }

  it('writes start/summary/replace/end events — kilobytes over the covered range, never a full|compact list', async () => {
    const sessionId = 'session-events';
    await seedRoundHistory(sessionId);
    const before = await fixture.durable.readActive(sessionId);
    // A realistic summarizer output: small next to the covered prefix.
    const compacted = await fixture.durable.compact(
      checkpointChange(sessionId, 'op-c1', [SUMMARY('the conversation opened with a read round')], {
        replacementSourceIndexes: [],
      }),
    );
    expect(compacted.generation).toBe(1);

    const entries = await sessionEntries(fixture.storage, sessionId);
    const kinds = entries.map((entry) => entry.kind);
    // The protocol shape: no COMPRESSION full state anywhere (the session's
    // initial `seed` base is the one legitimate full), exactly one event group.
    expect(
      entries.filter(
        (entry) =>
          entry.kind === FULL_KIND &&
          ['compact', 'replace', 'repair', 'delete'].includes(String(entry.payload['reason'])),
      ),
    ).toHaveLength(0);
    expect(kinds.filter((kind) => kind === EVENT_START)).toHaveLength(1);
    expect(kinds.filter((kind) => kind === EVENT_SUMMARY)).toHaveLength(1);
    expect(kinds.filter((kind) => kind === EVENT_REPLACE)).toHaveLength(1);
    expect(kinds.filter((kind) => kind === EVENT_END)).toHaveLength(1);
    const [start, summary, replace, end] = kinds.slice(-4);
    expect([start, summary, replace, end]).toEqual([EVENT_START, EVENT_SUMMARY, EVENT_REPLACE, EVENT_END]);
    expect(end && entries.at(-1)?.payload['outcome']).toBe('committed');
    expect(start && entries.at(-4)?.payload['baseGeneration']).toBe(0);

    // The acceptance: kilobytes, not the full list — the whole event group is
    // orders of magnitude smaller than the covered prefix it replaced.
    const eventBytes = entries
      .slice(-4)
      .reduce((sum, entry) => sum + entry.bytes, 0);
    const coveredBytes = before.messages.reduce(
      (sum: number, message) => sum + JSON.stringify(message).length,
      0,
    );
    // The acceptance: kilobytes, not the full list — the whole event group is
    // two orders of magnitude smaller than the covered prefix it replaced.
    expect(eventBytes).toBeLessThan(coveredBytes / 10);
    expect(eventBytes).toBeLessThan(4_096);

    // The folded history is the summary alone (the whole history was covered).
    const active = await fixture.durable.readActive(sessionId);
    expect(active.messages).toEqual([SUMMARY('the conversation opened with a read round')]);
  });

  it('the В1 barrier re-delivery of the committed checkpoint writes nothing', async () => {
    const sessionId = 'session-v1-redelivery';
    await seedRoundHistory(sessionId, 2);
    // The unified commit: the cut covers the first round.
    const before = await fixture.durable.readActive(sessionId);
    const committed = await fixture.durable.compact(
      checkpointChange(sessionId, 'op-c1', [SUMMARY('the opening round'), ...before.messages.slice(4)], {
        replacementSourceIndexes: before.messages.slice(4).map((_m, offset) => 4 + offset),
      }),
    );
    const entriesAfterCommit = await sessionEntries(fixture.storage, sessionId);
    // The В1 re-delivery: the commit pipeline routes the barrier's
    // replaceMessages decision through the compact seam with the lifecycle
    // metadata only (replacementId = the committed compaction id).
    const redelivered = await fixture.durable.compact({
      sessionId,
      turnId: 'turn-v1-delivery',
      reason: 'replaceMessages' as const,
      messages: committed.messages,
      operation: { id: 'turn-v1-delivery:history:compaction:ctx_op-c1', kind: 'compaction' as const },
      metadata: {
        replacementId: 'ctx_op-c1',
        strategyVersion: 'unified-compaction-wire-v1',
        compactionMethod: 'llm_checkpoint',
        compactionPhase: 'before_llm',
        compactionAttemptId: 'attempt-1',
      },
    } as never);
    expect(redelivered.messages).toEqual(committed.messages);
    expect(redelivered.generation).toBe(committed.generation);
    // Nothing was written: exactly the same log.
    expect((await sessionEntries(fixture.storage, sessionId))).toEqual(entriesAfterCommit);
  });

  it('keeps the live suffix: messages after endSeq survive the compaction (property, deterministic PRNG)', { timeout: 30_000 }, async () => {
    // Deterministic PRNG (mulberry32) — the property runs over many random
    // valid shapes without flaking.
    let seed = 0x9e3779b9;
    const random = (): number => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let round = 0; round < 12; round += 1) {
      const sessionId = `session-property-${String(round)}`;
      // A random history of plain and tool-round turns.
      const appended: unknown[] = [];
      let clock = 1;
      let op = 0;
      const append = async (messages: readonly unknown[]): Promise<void> => {
        op += 1;
        appended.push(...messages);
        await fixture.durable.append(
          appendChange(sessionId, `op-${String(op)}`, messages, `turn-${String(op)}`),
        );
      };
      await append([userMessage(`q${String(clock)}`, clock)]);
      clock += 1;
      const rounds = 2 + Math.floor(random() * 3);
      for (let r = 0; r < rounds; r += 1) {
        if (random() < 0.5) {
          await append([assistantToolCallMessage(`c${String(r)}`, clock)]);
          clock += 1;
          await append([toolResultMessage(`c${String(r)}`, clock)]);
          clock += 1;
        }
        await append([assistantMessage(`a${String(clock)}`, clock)]);
        clock += 1;
        await append([userMessage(`q${String(clock)}`, clock)]);
        clock += 1;
      }
      // A steer catches up BEFORE the commit (the owner input that used to be
      // dropped by the whole-list replacement).
      await append([userMessage('steer: mid-job input', clock)]);
      clock += 1;
      const before = await fixture.durable.readActive(sessionId);
      const total = before.identityVector.length;
      // A random valid cut: never inside a tool round (the boundary must not
      // leave a covered call with a kept result or vice versa).
      let cut = 1 + Math.floor(random() * (total - 1));
      for (; cut < total; cut += 1) {
        const message = before.messages[cut] as { role?: string } | undefined;
        const previous = before.messages[cut - 1] as { role?: string; content?: unknown } | undefined;
        const previousCalls = Array.isArray(previous?.content)
          ? (previous!.content as { type?: string }[]).some((block) => block.type === 'toolCall')
          : false;
        if (message?.role === 'toolResult') continue;
        if (previousCalls && previous?.role === 'assistant') continue;
        break;
      }
      if (cut >= total) continue;
      const kept = before.messages.slice(cut);
      const committed = await fixture.durable.compact(
        checkpointChange(sessionId, `op-cut-${String(round)}`, [SUMMARY(`s${String(round)}`), ...kept], {
          replacementSourceIndexes: kept.map((_message, offset) => cut + offset),
        }),
      );
      // The summary plus the EXACT kept suffix — nothing dropped, nothing rewritten.
      expect(committed.messages).toEqual([SUMMARY(`s${String(round)}`), ...kept]);
      // Appends AFTER the compaction land on the folded history and survive.
      const postCompaction = await fixture.durable.append(
        appendChange(sessionId, `op-post-${String(round)}`, [userMessage('post-compaction input', clock)], 'turn-post'),
      );
      expect(postCompaction.messages.at(-1)).toEqual(userMessage('post-compaction input', clock));
      expect(postCompaction.identityVector).toHaveLength(committed.identityVector.length + 1);
      // A fresh fold over the log equals the live state (canon 1.2).
      const fresh = reopenProvider(fixture);
      const refolded = await fresh.readActive(sessionId);
      expect(refolded.identityVector).toEqual(postCompaction.identityVector);
    }
  });
});

describe('wave 1.5 — the repair is an appended event', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await disposeFixture(fixture);
  });

  it('closes an interrupted committed round through a repair event (incident 03, brick-fix 215719bb)', async () => {
    const sessionId = 'session-brick-events';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('go', 1)]));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
            { type: 'toolCall', id: 'call-2', name: 'read', arguments: {} },
          ],
          timestamp: 2,
        },
      ]),
    );
    await fixture.durable.append(
      appendChange(sessionId, 'op-3', [toolResultMessage('call-1', 3)]),
    );
    // A delta over an open round repairs it FIRST, then appends.
    const healed = await fixture.durable.append(
      appendChange(sessionId, 'op-4', [userMessage('reminder', 4)], 'turn-reminder'),
    );
    expect(healed.identityVector).toHaveLength(5);
    const entries = await sessionEntries(fixture.storage, sessionId);
    // No full|repair anywhere; exactly one repair event carrying the delta.
    expect(
      entries.filter(
        (entry) =>
          entry.kind === FULL_KIND &&
          ['compact', 'replace', 'repair', 'delete'].includes(String(entry.payload['reason'])),
      ),
    ).toHaveLength(0);
    const repairs = entries.filter((entry) => entry.kind === EVENT_REPAIR);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.payload['truncateTo']).toBeUndefined();
    const synthesized = repairs[0]?.payload['appended'] as {
      message: { toolCallId?: string };
    }[];
    expect(synthesized.map((envelope) => envelope.message.toolCallId)).toEqual(['call-2']);
    // The next turn appends normally (the brick stays healed).
    const next = await fixture.durable.append(
      appendChange(sessionId, 'op-5', [userMessage('continue', 5)], 'turn-2'),
    );
    expect(next.identityVector).toHaveLength(6);
    // The repair is durable: a fresh fold rebuilds the healed history.
    const fresh = reopenProvider(fixture);
    const rebuilt = await fresh.readActive(sessionId);
    expect(rebuilt.identityVector).toEqual(next.identityVector);
  });

  it('closes a clean open round with synthesized unknown outcomes through a repair event', async () => {
    const sessionId = 'session-unknown-outcome-events';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('go', 1)]));
    await fixture.durable.append(
      appendChange(sessionId, 'op-2', [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
            { type: 'toolCall', id: 'call-2', name: 'read', arguments: {} },
          ],
          timestamp: 2,
        },
      ]),
    );
    await fixture.durable.append(
      appendChange(sessionId, 'op-3', [toolResultMessage('call-1', 3)]),
    );
    const healed = await fixture.durable.append(
      appendChange(sessionId, 'op-4', [userMessage('cadence reminder', 4)], 'turn-reminder'),
    );
    expect(healed.identityVector).toHaveLength(5);
    const entries = await sessionEntries(fixture.storage, sessionId);
    expect(
      entries.filter(
        (entry) =>
          entry.kind === FULL_KIND &&
          ['compact', 'replace', 'repair', 'delete'].includes(String(entry.payload['reason'])),
      ),
    ).toHaveLength(0);
    const repairs = entries.filter((entry) => entry.kind === EVENT_REPAIR);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.payload['truncateTo']).toBeUndefined();
    const appended = repairs[0]?.payload['appended'] as {
      message: { toolCallId?: string };
    }[];
    expect(appended).toHaveLength(1);
    expect(appended[0]?.message.toolCallId).toBe('call-2');
    // The synthesized result is the honest unknown-outcome form.
    expect(JSON.stringify(appended[0])).toContain('tool-outcome-unknown');
    // Restart parity: the fold rebuilds the same healed history.
    const fresh = reopenProvider(fixture);
    const rebuilt = await fresh.read(sessionId);
    expect(rebuilt.identityVector).toEqual(healed.identityVector);
  });
});

describe('wave 1.6 — the lease of an open compaction.start', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await disposeFixture(fixture);
  });

  /**
   * Wraps the worker so every enqueue after the compaction start fails — the
   * mid-commit crash: the start is durably queued (and folded), the summary
   * write dies, the process never recovers the attempt.
   */
  function crashAfterCompactionStart(storage: DurableHistoryStorage): DurableHistoryStorage {
    const realEnqueue = storage.worker.enqueue.bind(storage.worker);
    const wrappedWorker = {
      ...storage.worker,
      enqueue: async (entry: { kind: string }): Promise<void> => {
        if (entry.kind === EVENT_START) {
          return realEnqueue(entry as Parameters<typeof realEnqueue>[0]);
        }
        throw new Error('simulated crash after the compaction start');
      },
    } as unknown as DurableHistoryStorage['worker'];
    return { ...storage, worker: wrappedWorker };
  }

  it('a killed compaction leaves the start open and the NEXT compaction starts (auto-close abandoned)', async () => {
    const sessionId = 'session-lease';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('first question', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('first answer', 2)]));
    // The crash: the start is durable, everything after dies.
    const crashedProvider = createDurableSessionSystemCanonicalHistoryProvider({
      storage: crashAfterCompactionStart(fixture.storage),
      dataDir: fixture.root,
      sessions: fixture.sessions,
      locations: fixture.locations,
    });
    await expect(
      crashedProvider.compact(
        checkpointChange(sessionId, 'op-killed', [SUMMARY('never committed')], {
          replacementSourceIndexes: [],
        }),
      ),
    ).rejects.toThrow(/simulated crash/);
    // The log holds the open start and nothing else of the protocol beyond
    // the seeded base and the appends.
    expect((await sessionEntries(fixture.storage, sessionId)).map((entry) => entry.kind)).toEqual([
      FULL_KIND,
      'history.v1.append',
      'history.v1.append',
      EVENT_START,
    ]);

    // The restart (a NEW writer token): the next compaction starts, closing
    // the dead attempt as abandoned first.
    const restarted = reopenProvider(fixture);
    const committed = await restarted.compact(
      checkpointChange(sessionId, 'op-next', [SUMMARY('the next attempt commits')], {
        replacementSourceIndexes: [],
      }),
    );
    expect(committed.messages).toEqual([SUMMARY('the next attempt commits')]);
    const entries = await sessionEntries(fixture.storage, sessionId);
    const abandoned = entries.filter((entry) => entry.kind === EVENT_END && entry.payload['outcome'] === 'abandoned');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.payload['compactionId']).toBe('ctx_op-killed');
    expect(entries.filter((entry) => entry.kind === EVENT_END && entry.payload['outcome'] === 'committed'))
      .toHaveLength(1);
    // The fold is clean: no open start, the committed cut applied.
    const fresh = reopenProvider(fixture);
    const active = await fresh.readActive(sessionId);
    expect(active.messages).toEqual([SUMMARY('the next attempt commits')]);
  });

  it('a fresh open start of the SAME instance inside the lease refuses a second attempt (fail-closed)', async () => {
    const sessionId = 'session-lease-refuse';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('first question', 1)]));
    const crashedProvider = createDurableSessionSystemCanonicalHistoryProvider({
      storage: crashAfterCompactionStart(fixture.storage),
      dataDir: fixture.root,
      sessions: fixture.sessions,
      locations: fixture.locations,
    });
    await expect(
      crashedProvider.compact(
        checkpointChange(sessionId, 'op-killed', [SUMMARY('never committed')], {
          replacementSourceIndexes: [],
        }),
      ),
    ).rejects.toThrow(/simulated crash/);
    // The SAME instance (same writer token, lease unexpired) refuses.
    await expect(
      crashedProvider.compact(
        checkpointChange(sessionId, 'op-second', [SUMMARY('refused')], {
          replacementSourceIndexes: [],
        }),
      ),
    ).rejects.toThrowError(CompactionStartLeaseActiveError);
    // The history is untouched by both failed attempts.
    const active = await crashedProvider.readActive(sessionId);
    expect(active.identityVector).toHaveLength(1);
  });
});

describe('wave 1.7 — delete is a tombstone; the purge is the only physical removal', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await disposeFixture(fixture);
  });

  it('delete appends the tombstone, keeps the derived files and the restorable log; purge removes the files', async () => {
    const sessionId = 'session-tombstone';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('first question', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('first answer', 2)]));
    const paths = (await fixture.locations.resolveSession(sessionId))!.paths;
    expect(existsSync(paths.messages)).toBe(true);

    await fixture.durable.delete(sessionId);
    // The derived files stay; the log holds the tombstone and EVERY envelope.
    expect(existsSync(paths.messages)).toBe(true);
    const entries = await sessionEntries(fixture.storage, sessionId);
    const tombstones = entries.filter((entry) => entry.kind === EVENT_TOMBSTONE);
    expect(tombstones).toHaveLength(1);
    expect(
      entries.some(
        (entry) => entry.kind === 'history.v1.append' && JSON.stringify(entry.payload).includes('first question'),
      ),
    ).toBe(true);

    // The deleted session reads as empty (the fold marks it deleted)…
    const fresh = reopenProvider(fixture);
    const active = await fresh.readActive(sessionId);
    expect(active.identityVector).toEqual([]);
    // …and the log bytes are untouched — the session is restorable until the
    // explicit purge.
    expect((await sessionEntries(fixture.storage, sessionId)).filter((entry) => entry.kind !== EVENT_TOMBSTONE)).toHaveLength(3);

    // The explicit purge is the ONLY physical removal.
    await fixture.durable.purgeSession(sessionId);
    expect(existsSync(paths.messages)).toBe(false);
    // The log bytes stay (immutable; the wave-4 log compaction reclaims them).
    expect((await sessionEntries(fixture.storage, sessionId))).toHaveLength(4);
  });
});

describe('wave 1.8 — messages.jsonl is the derived view of the fold', () => {
  let fixture: Fixture;
  let publisher: DurableJsonlPublisher;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-events-pub-'));
    const storage = await createDurableHistoryStorage({ dataDir: root });
    const sessions = stubSessionRepository(root);
    const locations = stubLocations(root);
    const lane = createSessionHistoryIoLane();
    const durable = createDurableSessionSystemCanonicalHistoryProvider({
      storage,
      dataDir: root,
      sessions,
      locations,
      publisherFactory: (source) =>
        createDurableJsonlPublisher({
          sessions,
          locations,
          ioLane: lane,
          durable: source,
          debounceMs: 5,
          maxLagMs: 20,
        }),
    });
    publisher = durable.publisher!;
    fixture = { root, sessions, locations, storage, durable };
  });

  afterEach(async () => {
    await publisher.dispose();
    await disposeFixture(fixture);
  });

  it('after each compaction messages.jsonl equals the fold', async () => {
    const sessionId = 'session-publish';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('first question', 1)]));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('first answer', 2)]));
    await fixture.durable.append(appendChange(sessionId, 'op-3', [userMessage('second question', 3)]));
    await fixture.durable.append(appendChange(sessionId, 'op-4', [assistantMessage('second answer', 4)]));
    const paths = (await fixture.locations.resolveSession(sessionId))!.paths;
    // A deterministic await of the coalesced publication.
    await publisher.flushBeforeMutation(sessionId);
    const beforePublished = await readFile(paths.messages, 'utf8');
    expect(beforePublished.split('\n').filter((line) => line.trim())).toHaveLength(4);

    // The compaction replaces the covered prefix with the summary; the
    // publication rewrites the view from the FOLD.
    const before = await fixture.durable.readActive(sessionId);
    const committed = await fixture.durable.compact(
      checkpointChange(sessionId, 'op-c1', [SUMMARY('the opening round'), ...before.messages.slice(2)], {
        replacementSourceIndexes: [2, 3],
      }),
    );
    await publisher.flushBeforeMutation(sessionId);
    const publishedLines = (await readFile(paths.messages, 'utf8'))
      .split('\n')
      .filter((line) => line.trim());
    expect(publishedLines).toHaveLength(committed.identityVector.length);
    expect(publishedLines.map((line) => JSON.parse(line).message_id)).toEqual(committed.identityVector);
    // The view equals the fold itself, byte-for-byte per record.
    const active = await fixture.durable.readActive(sessionId);
    expect(publishedLines.map((line) => JSON.parse(line).message)).toEqual(active.messages);
  });
});

describe('wave 1.3 — the fold checkpoint is a disposable cold-start cache', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await disposeFixture(fixture);
  });

  async function recordingBackend(
    storage: DurableHistoryStorage,
    sessionId: string,
  ): Promise<{
    readonly storage: DurableHistoryStorage;
    readonly cursors: number[];
  }> {
    const cursors: number[] = [];
    // Per-session storage: the cold-open scan reads the session's OWN file —
    // through `backendForRead`. The spy counts the scan cursors there (a
    // prototype-linked wrapper keeps every other backend method intact).
    const sessionBackend = (await storage.sessionStores(sessionId)).backend;
    const realRead = sessionBackend.readDeltaChecked.bind(sessionBackend);
    const wrappedBackend = Object.create(sessionBackend) as typeof sessionBackend;
    wrappedBackend.readDeltaChecked = (cursor: number, bytes: number) => {
      cursors.push(cursor);
      return realRead(cursor, bytes);
    };
    return {
      storage: {
        ...storage,
        backendForRead: async (id: string) =>
          id === sessionId ? wrappedBackend : storage.backendForRead(id),
      } as DurableHistoryStorage,
      cursors,
    };
  }

  it('cold open with a checkpoint scans only the delta; deleting the cache yields the identical fold', async () => {
    const sessionId = 'session-checkpoint';
    for (let index = 0; index < 6; index += 1) {
      await fixture.durable.append(
        appendChange(sessionId, `op-${String(index)}`, [userMessage(`q${String(index)}`, index)], `turn-${String(index)}`),
      );
    }
    await fixture.durable.compact(
      checkpointChange(sessionId, 'op-c1', [SUMMARY('the opening rounds')], { replacementSourceIndexes: [] }),
    );
    for (let index = 0; index < 3; index += 1) {
      await fixture.durable.append(
        appendChange(sessionId, `op-post-${String(index)}`, [userMessage(`p${String(index)}`, index)], `turn-post-${String(index)}`),
      );
    }
    const live = await fixture.durable.readActive(sessionId);
    await fixture.storage.dispose();

    // Cold open #1 (with the checkpoint written by the compaction): the scan
    // resumes from the checkpointed backend position — never from 0.
    const checkpointPath = join(fixture.storage.directory, 'fold-cache', `${sessionId}.json`);
    expect(existsSync(checkpointPath)).toBe(true);
    const reopenedStorage = await createDurableHistoryStorage({ dataDir: fixture.root });
    await reopenedStorage.sessionStores(sessionId);
    const resumed = await recordingBackend(reopenedStorage, sessionId);
    fixture.storage = resumed.storage;
    const resumedProvider = reopenProvider(fixture);
    const resumedState = await resumedProvider.readActive(sessionId);
    expect(resumedState.identityVector).toEqual(live.identityVector);
    expect(resumed.cursors.length).toBeGreaterThan(0);
    expect(resumed.cursors.every((cursor) => cursor > 0)).toBe(true);
    await fixture.storage.dispose();

    // Cold open #2 with the cache DELETED: the fold recomputes from the log —
    // the identical result (the cache is disposable by definition).
    await rm(checkpointPath, { force: true });
    const fullStorage = await createDurableHistoryStorage({ dataDir: fixture.root });
    await fullStorage.sessionStores(sessionId);
    const full = await recordingBackend(fullStorage, sessionId);
    fixture.storage = full.storage;
    const fullProvider = reopenProvider(fixture);
    const refolded = await fullProvider.readActive(sessionId);
    expect(refolded.identityVector).toEqual(live.identityVector);
    expect(full.cursors).toContain(0);
    // The cache is rewritten for the next cold open.
    expect(existsSync(checkpointPath)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The poison of the pre-fix write path (incident 2026-11-07, mvs_70b7f22): a
// compaction.replace with an INVERTED seq range sat in a live log. The write
// path now refuses such a range before the first protocol event, but the one
// recorded record must not make the session unreadable: the replay skips it
// with diagnostics and the fold keeps the pre-replace state.
// -----------------------------------------------------------------------------

describe('the replay tolerates a logged compaction.replace with an inverted seq range', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await disposeFixture(fixture);
  });

  function historyEntry(
    sessionId: string,
    kind: string,
    payload: Record<string, unknown>,
    parentId: string | null,
  ): { entryId: string; parentId: string | null; kind: string; payload: Record<string, unknown>; bytes: number } {
    // The `<sessionId>|` prefix routes the entry into the session's own file
    // (the routing worker's key).
    return {
      entryId: `${sessionId}|poison-${String(payload['compactionId'] ?? 'x')}-${kind}`,
      parentId,
      kind,
      payload,
      bytes: JSON.stringify(payload).length,
    };
  }

  it('keeps the session readable: the fold skips the invalid range and the attempt closes as failed', async () => {
    const sessionId = 'session-poison-replay';
    await fixture.durable.append(appendChange(sessionId, 'op-1', [userMessage('first question', 1)], 'turn-1'));
    await fixture.durable.append(appendChange(sessionId, 'op-2', [assistantMessage('first answer', 2)], 'turn-1'));
    const healthy = await fixture.durable.readActive(sessionId);
    expect(healthy.identityVector).toHaveLength(2);

    // The live poison sequence behind the provider's back: start → summary →
    // replace (inverted) → end{failed}. The pre-fix path enqueued the replace
    // BEFORE its fold apply threw on it; the end{failed} is the failure
    // path's honest close.
    const entries = await sessionEntries(fixture.storage, sessionId);
    const compactionId = 'ctx_poison';
    let parentId: string | null = entries.at(-1)?.id ?? null;
    const poisonSequence: ReturnType<typeof historyEntry>[] = [
      historyEntry(sessionId, EVENT_START, {
        kind: EVENT_START,
        sessionId,
        compactionId,
        baseGeneration: 0,
        coveredUpToSeq: 2,
        writerToken: 'dead-writer',
        startedAtMs: 1,
      }, parentId),
      historyEntry(sessionId, EVENT_SUMMARY, {
        kind: EVENT_SUMMARY,
        sessionId,
        compactionId,
        text: 'a summary the fold must never apply',
        tokensBefore: 42_000,
      }, `${sessionId}|poison-${compactionId}-${EVENT_START}`),
      historyEntry(sessionId, EVENT_REPLACE, {
        kind: EVENT_REPLACE,
        sessionId,
        compactionId,
        baseGeneration: 0,
        startSeq: 9,
        endSeq: 3,
        endEnvelopeCount: 1,
        inserted: [SUMMARY('poison summary')],
        generation: 1,
        producedBy: 'llm_checkpoint',
        parentSnapshot: { generation: 0, compactionId, revision: healthy.revision },
      }, `${sessionId}|poison-${compactionId}-${EVENT_SUMMARY}`),
      historyEntry(sessionId, EVENT_END, {
        kind: EVENT_END,
        sessionId,
        compactionId,
        outcome: 'failed',
      }, `${sessionId}|poison-${compactionId}-${EVENT_REPLACE}`),
    ];
    for (const entry of poisonSequence) {
      await fixture.storage.worker.enqueue(entry);
    }
    await fixture.storage.worker.flush();

    // A restart on the SAME storage replays the delta after the checkpoint:
    // the poison is skipped, the session reads, the fold is the pre-attempt
    // state (generation did not grow — the replace never applied).
    const reopened = reopenProvider(fixture);
    const resumed = await reopened.readActive(sessionId);
    expect(resumed.messages).toEqual(healthy.messages);
    expect(resumed.identityVector).toEqual(healthy.identityVector);
    expect(resumed.revision).toBe(healthy.revision);

    // A full cold start (fresh storage over the same directory, the whole log
    // scanned) reads the identical fold.
    await fixture.storage.dispose();
    const cold = await createDurableHistoryStorage({ dataDir: fixture.root });
    fixture.storage = cold;
    const coldProvider = reopenProvider(fixture);
    const refolded = await coldProvider.readActive(sessionId);
    expect(refolded.messages).toEqual(healthy.messages);
    expect(refolded.revision).toBe(healthy.revision);
  });
});
