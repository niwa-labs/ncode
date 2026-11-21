import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DatabaseClient } from '../../src/infra/db/client.js';
import { initializeDatabase } from '../../src/infra/db/initialize.js';
import {
  createDurableHistoryStorage,
  isExplicitDurableHistoryProviderMode,
  resolveHistoryProviderMode,
} from '../../src/service/session-system/messages/history/durable-canonical-history-provider.js';
import {
  openDurableRuntimeOrchestration,
} from '../../src/service/orchestration/runtime-orchestration.js';
import { SESSION_CONVERSATION_MAP_KIND } from '../../src/service/orchestration/session-conversation-resolver.js';
import { DurableSchedulerClient } from '../../src/service/cron/orchestration/durable-scheduler-client.js';
import {
  PI_DURABLE_ROOT_SIDECAR,
  PiDurableRootError,
} from '../../src/service/session-system/messages/history/pi-durable-root.js';
import {
  DurableTurnDriverStore,
  withProductTurnDriver,
  type DriverBackedAgentHost,
} from '../../src/service/turn-system/agent-host/driver/index.js';
import type {
  AgentHost,
  AgentHostRunInput,
} from '../../src/service/turn-system/agent-host/contracts.js';
import type { SessionRecord } from '../../src/service/session-system/index.js';

/**
 * W10 Part A — the durable composition chain end to end on REAL storages:
 * Ш1 storage + pi root (root resolver) → session→conversation resolver →
 * orchestration harness (the ONE scheduler) → CronJobBridge + the swapped
 * DurableSchedulerClient. Ask tracks covered here: runtime composition /
 * root resolver, atomic scheduler swap, hybrid defaults.
 */

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** Manual clock: deterministic wakeups for the ONE scheduler. */
function manualClock() {
  let nowMs = 1_000_000;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextId = 1;
  return {
    now: () => nowMs,
    advance: (deltaMs: number) => {
      nowMs += deltaMs;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= nowMs) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    setTimer: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: nowMs + delayMs, callback });
      return () => timers.delete(id);
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

interface Composition {
  readonly dataDir: string;
  readonly database: DatabaseClient;
  readonly storage: Awaited<ReturnType<typeof createDurableHistoryStorage>>;
  readonly orchestration: Awaited<
    ReturnType<typeof openDurableRuntimeOrchestration>
  >['orchestration'];
  readonly clock: ReturnType<typeof manualClock>;
}

async function openComposition(): Promise<Composition> {
  const clock = manualClock();
  const dataDir = tempDir('w10-composition-');
  const database = new DatabaseClient({ dataDir: join(dataDir, 'db') });
  await initializeDatabase({ database, dataDir: join(dataDir, 'db') });
  // The orchestration composition needs the SYSTEM log: this test suite plays
  // the daemon role (per-session durable history, owner decision 2026-11-18).
  const storage = await createDurableHistoryStorage({ dataDir, ownsSystemRoot: true });
  if (!storage.system) throw new Error('w10 composition requires the system log');
  const { orchestration } = await openDurableRuntimeOrchestration({
    durableSystem: storage.system,
    db: database.db,
    nowMs: clock.now,
    setTimer: (callback, delayMs) => clock.setTimer(callback, delayMs),
  });
  return { dataDir, database, storage, orchestration, clock };
}

async function closeComposition(composition: Composition): Promise<void> {
  await composition.orchestration.close();
  await composition.storage.dispose();
  composition.database.close();
}

describe('W10 part A: Ш1 pi root + root resolver (W02 readiness transfer)', () => {
  it('composes the full storage stack and persists the root resolver beside the durable root', async () => {
    const composition = await openComposition();
    try {
      const conversation = await composition.orchestration.requireConversation('session-1');
      expect(conversation).toBeDefined();
      expect(composition.storage.system?.pi.bridgedConversationId).not.toBeNull();
      const raw = JSON.parse(
        readFileSync(
          join(composition.storage.directory, PI_DURABLE_ROOT_SIDECAR),
          'utf8',
        ),
      ) as { version: number; bridgedConversationId: number };
      expect(raw.version).toBe(1);
      expect(raw.bridgedConversationId).toBe(composition.storage.system?.pi.bridgedConversationId);
    } finally {
      await closeComposition(composition);
    }
  });

  it('reopens the SAME bridge conversation and session mapping after restart', async () => {
    const dataDir = tempDir('w10-reopen-');
    const database = new DatabaseClient({ dataDir: join(dataDir, 'db') });
    await initializeDatabase({ database, dataDir: join(dataDir, 'db') });
    const clock = manualClock();
    const first = await createDurableHistoryStorage({ dataDir, ownsSystemRoot: true });
    const firstOpen = await openDurableRuntimeOrchestration({
      durableSystem: first.system!,
      db: database.db,
      nowMs: clock.now,
      setTimer: (callback, delayMs) => clock.setTimer(callback, delayMs),
    });
    const assigned = await firstOpen.orchestration.requireConversation('session-r');
    const bridged = first.system!.pi.bridgedConversationId;
    await firstOpen.orchestration.close();
    await first.dispose();

    const second = await createDurableHistoryStorage({ dataDir, ownsSystemRoot: true });
    try {
      expect(second.system?.pi.bridgedConversationId).toBe(bridged);
      const secondOpen = await openDurableRuntimeOrchestration({
        durableSystem: second.system!,
        db: database.db,
        nowMs: clock.now,
        setTimer: (callback, delayMs) => clock.setTimer(callback, delayMs),
      });
      await expect(
        secondOpen.orchestration.requireConversation('session-r'),
      ).resolves.toBe(assigned);
      await secondOpen.orchestration.close();
    } finally {
      await second.dispose();
      database.close();
    }
  });

  it('fails closed on a corrupt sidecar instead of minting a silent fresh root', async () => {
    const dataDir = tempDir('w10-corrupt-');
    const storage = await createDurableHistoryStorage({ dataDir, ownsSystemRoot: true });
    expect(storage.system?.pi.bridgedConversationId).not.toBeNull();
    await storage.dispose();
    await writeFile(
      join(dataDir, 'durable-history', PI_DURABLE_ROOT_SIDECAR),
      '{not json',
      'utf8',
    );
    await expect(
      createDurableHistoryStorage({ dataDir, ownsSystemRoot: true }),
    ).rejects.toBeInstanceOf(PiDurableRootError,
    );
  });
});

describe('W10 part A: atomic scheduler swap (CronJobBridge owns the wake)', () => {
  it('schedule → durable wake → fire → handler, on the ONE scheduler with a manual clock', async () => {
    const composition = await openComposition();
    const fired: string[] = [];
    const client = new DurableSchedulerClient({
      db: composition.database.db,
      bridge: composition.orchestration.cron,
      nowMs: composition.clock.now,
    });
    client.registerHandler('handler-key', (id) => {
      fired.push(id);
    });
    client.bindCronHost(composition.orchestration.hosts);
    try {
      const schedulerId = client.schedule('handler-key', {
        kind: 'cron',
        expression: '* * * * *',
      });
      expect(schedulerId).toBeDefined();
      await pump(composition.clock);
      const wakeState = await composition.orchestration.cron.state(schedulerId);
            expect(fired).toHaveLength(0); // next fire is the next minute boundary

      composition.clock.advance(61_000);
      await pump(composition.clock);
            expect(fired).toEqual([schedulerId]);

      // Retire: the wake task aborts on the ONE scheduler — no further fires.
      client.cancel(schedulerId);
      await pump(composition.clock);
      const firesAfterCancel = fired.length;
      composition.clock.advance(120_000);
      await pump(composition.clock);
      expect(fired.length).toBe(firesAfterCancel);
      expect(client.get(schedulerId)?.state).toBe('cancelled');
    } finally {
      await closeComposition(composition);
    }
  });

  it('a once schedule fires exactly once and completes the job', { timeout: 20_000 }, async () => {
    const composition = await openComposition();
    const fired: string[] = [];
    const client = new DurableSchedulerClient({
      db: composition.database.db,
      bridge: composition.orchestration.cron,
      nowMs: composition.clock.now,
    });
    client.registerHandler('once-key', (id) => {
      fired.push(id);
    });
    client.bindCronHost(composition.orchestration.hosts);
    try {
      const schedulerId = client.schedule('once-key', {
        kind: 'once',
        runAtMs: composition.clock.now() + 5_000,
      });
      await pump(composition.clock);
      expect(fired).toHaveLength(0);
      composition.clock.advance(6_000);
      await pump(composition.clock);
      expect(fired).toEqual([schedulerId]);
      composition.clock.advance(60_000);
      await pump(composition.clock);
      expect(fired).toHaveLength(1);
      expect(client.get(schedulerId)?.state).toBe('completed');
      // Let the wake task reach its terminal settlement before the harness
      // closes (the abort/terminal transition otherwise delays close()).
      await pump(composition.clock);
    } finally {
      await closeComposition(composition);
    }
  });

  it('schedule/reschedule/cancel keep the SAME scheduler_jobs rows (migration path for existing definitions)', async () => {
    const composition = await openComposition();
    const client = new DurableSchedulerClient({
      db: composition.database.db,
      bridge: composition.orchestration.cron,
      nowMs: composition.clock.now,
    });
    client.registerHandler('rows-key', () => {});
    try {
      const id = client.schedule('rows-key', { kind: 'cron', expression: '0 12 * * *' });
      expect(client.inspect(id)?.state).toBe('active');
      client.reschedule(id, { kind: 'cron', expression: '0 13 * * *' });
      expect(client.inspect(id)?.schedule).toEqual({ kind: 'cron', expression: '0 13 * * *' });
      expect(client.inspect(id)?.scheduleGeneration).toBe(1);
      client.remove(id);
      expect(client.inspect(id)).toBeUndefined();
    } finally {
      await closeComposition(composition);
    }
  });
});

describe('W10 part A: hybrid defaults (plan §8 W10-C)', () => {
  it('durable is the default provider mode; jsonl is the explicit compatibility mode; unknown values fail closed', () => {
    expect(resolveHistoryProviderMode({})).toBe('durable');
    expect(resolveHistoryProviderMode({ MCODE_HISTORY_PROVIDER: 'jsonl' })).toBe('jsonl');
    expect(resolveHistoryProviderMode({ MCODE_HISTORY_PROVIDER: ' Durable ' })).toBe('durable');
    expect(() =>
      resolveHistoryProviderMode({ MCODE_HISTORY_PROVIDER: 'file' }),
    ).toThrowError(/Unsupported MCODE_HISTORY_PROVIDER/);
    expect(isExplicitDurableHistoryProviderMode({ MCODE_HISTORY_PROVIDER: 'durable' })).toBe(
      true,
    );
    expect(isExplicitDurableHistoryProviderMode({})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W10 part B — the durable turn-driver in the ACTIVE product turn path
// (review w10-review-p1 item 1). The part-A loop is REPLACED by a recording
// fixture: if composeProductTurnDriver were not in the executed path, the
// fixture would never run and the driver store over the REAL pi port would
// hold no records — the asserts fail loudly on any silent regression to the
// direct legacy executor.
// ─────────────────────────────────────────────────────────────────────────────

/** Recording part-A fixture: the "existing executor" the driver delegates to. */
function recordingPartAHost() {
  const executedTurns: string[] = [];
  const host: AgentHost = {
    async run(input: AgentHostRunInput) {
      executedTurns.push(input.lease.turnId);
      return { status: 'completed' };
    },
    async compact() {
      throw new Error('compaction is not part of this fixture');
    },
  };
  return { host, executedTurns };
}

function fixtureSession(sessionId: string): SessionRecord {
  return {
    sessionId,
    agentName: 'mavis',
    workspaceDir: '/tmp/w10-fixture',
    runtime: 'v2',
    sessionType: 'standard',
    sessionKind: 'session',
    archived: false,
    status: 'active',
    effectiveModel: 'minimax/MiniMax-M3',
    createdAtMs: 1,
    updatedAtMs: 1,
  } as unknown as SessionRecord;
}

interface DriverFixtureComposition {
  readonly storage: Awaited<ReturnType<typeof createDurableHistoryStorage>>;
  readonly wrapped: DriverBackedAgentHost;
  readonly executedTurns: string[];
  readonly appended: unknown[];
}

/** Composes withProductTurnDriver over the REAL per-session pi root. */
async function openDriverFixture(sessionId: string): Promise<DriverFixtureComposition> {
  const storage = await createDurableHistoryStorage({ dataDir: tempDir('w10-driver-') });
  // The provider's ensureState opens the session root before the driver
  // binds in the real composition; the fixture opens it directly (no
  // provider here).
  await storage.sessionStores(sessionId);
  const partA = recordingPartAHost();
  const appended: unknown[] = [];
  const wrapped = withProductTurnDriver({
    rootOfSession: (id) => storage.piOf(id),
    host: partA.host,
    sessions: { get: async (id) => (id === sessionId ? fixtureSession(id) : undefined) },
    canonicalHistory: {
      inspectActive: async () => ({
        messages: [{ role: 'user', content: 'fixture input', timestamp: 1 }],
      }),
      append: async (change) => {
        appended.push(change);
        return change;
      },
    },
  });
  return { storage, wrapped, executedTurns: partA.executedTurns, appended };
}

function turnInput(sessionId: string, turnId: string): AgentHostRunInput {
  return {
    lease: {
      sessionId,
      turnId,
      leaseId: `lease-${turnId}`,
      acceptedSequence: 1,
      acceptedAtMs: 1,
      signal: new AbortController().signal,
      busyReason: 'turn',
    },
    request: { fixture: true } as never,
  };
}

describe('W10 part B: durable turn-driver in the product turn path', () => {
  it('executes the product turn THROUGH the driver and persists the run envelope on the REAL pi port', async () => {
    const fixture = await openDriverFixture('session-driver-1');
    try {
      const outcome = await fixture.wrapped.run(turnInput('session-driver-1', 'turn_drv_1'));
      expect(outcome).toEqual({ status: 'completed' });
      // The delegated part-A executor ran the turn exactly once.
      expect(fixture.executedTurns).toEqual(['turn_drv_1']);
      // The driver store of the composition holds the envelope…
      const record = fixture.wrapped.store.read('session-driver-1').record;
      expect(record?.binding?.executorId).toBe('mavis.local-runtime-v2.part-a-loop');
      expect(record?.checkpoint?.phase).toBe('settled');
      // …and a FRESH store over the SAME session-root port reads it back:
      // composeProductTurnDriver really opened over the session's pi root.
      const reopened = new DurableTurnDriverStore(fixture.storage.piOf('session-driver-1').port).read(
        'session-driver-1',
      );
      expect(reopened.record?.checkpoint?.phase).toBe('settled');
      expect(reopened.record?.binding?.executorId).toBe('mavis.local-runtime-v2.part-a-loop');
    } finally {
      await fixture.storage.dispose();
    }
  });

  it('consecutive turns rebind and advance the binding epoch (no RUN_OPEN regression)', async () => {
    const fixture = await openDriverFixture('session-driver-2');
    try {
      await fixture.wrapped.run(turnInput('session-driver-2', 'turn_drv_a'));
      const epochAfterFirst = fixture.wrapped.store.read('session-driver-2').record?.binding?.epoch;
      await fixture.wrapped.run(turnInput('session-driver-2', 'turn_drv_b'));
      const view = fixture.wrapped.store.read('session-driver-2');
      expect(fixture.executedTurns).toEqual(['turn_drv_a', 'turn_drv_b']);
      expect(view.record?.binding?.epoch).toBe(epochAfterFirst! + 1);
      expect(view.record?.checkpoint?.phase).toBe('settled');
    } finally {
      await fixture.storage.dispose();
    }
  });

  it('a stale open run from a crashed process is recovered and superseded, never blocking the turn', async () => {
    const fixture = await openDriverFixture('session-driver-3');
    try {
      // Simulate the crashed process: bind + open a run and leave it in the
      // prepare phase (same executor identity — a restart of the composition).
      await fixture.wrapped.driver.bind('session-driver-3');
      await fixture.wrapped.driver.startRun({
        conversationId: 'session-driver-3',
        runId: 'turn_crashed',
        inputs: [],
      });
      expect(fixture.wrapped.store.readCheckpoint('session-driver-3')?.phase).toBe('prepare');

      const outcome = await fixture.wrapped.run(turnInput('session-driver-3', 'turn_after_crash'));
      expect(outcome).toEqual({ status: 'completed' });
      expect(fixture.executedTurns).toEqual(['turn_after_crash']);
      const checkpoint = fixture.wrapped.store.readCheckpoint('session-driver-3');
      expect(checkpoint?.phase).toBe('settled');
      if (checkpoint?.phase === 'settled') {
        expect(checkpoint.runId).toBe('turn_after_crash');
        expect(checkpoint.outcome.status).toBe('completed');
      }
    } finally {
      await fixture.storage.dispose();
    }
  });

  it('a failed part-A turn settles the driver run failed and keeps the product outcome verbatim', async () => {
    const storage = await createDurableHistoryStorage({ dataDir: tempDir('w10-driver-fail-') });
    await storage.sessionStores('session-fail');
    const executedTurns: string[] = [];
    const failingHost: AgentHost = {
      async run(input: AgentHostRunInput) {
        executedTurns.push(input.lease.turnId);
        return { status: 'failed', error: new Error('provider unreachable') };
      },
      async compact() {
        throw new Error('not used');
      },
    };
    const wrapped = withProductTurnDriver({
      rootOfSession: (id) => storage.piOf(id),
      host: failingHost,
      sessions: { get: async (id) => fixtureSession(id) },
      canonicalHistory: {
        inspectActive: async () => ({ messages: [{ role: 'user', content: 'x', timestamp: 1 }] }),
        append: async (change) => change,
      },
    });
    try {
      const outcome = await wrapped.run(turnInput('session-fail', 'turn_fail_1'));
      expect(outcome.status).toBe('failed');
      const checkpoint = wrapped.store.readCheckpoint('session-fail');
      expect(checkpoint?.phase).toBe('settled');
      if (checkpoint?.phase === 'settled') expect(checkpoint.outcome.status).toBe('failed');
      expect(executedTurns).toEqual(['turn_fail_1']);
    } finally {
      await storage.dispose();
    }
  });
});

// The bridge-log kind is asserted so a rename breaks this suite loudly.
void SESSION_CONVERSATION_MAP_KIND;

async function pump(clock: ReturnType<typeof manualClock>): Promise<void> {
  // Always drain several event-loop turns: the ONE scheduler runs task
  // phases asynchronously, so timers may arm after the callers' advance.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.advance(0);
  }
}
