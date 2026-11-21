/**
 * Resume after the owner died mid-Turn, end to end over the assembled V2
 * Runtime host (the live owner incident: "stream refused by the runtime" on
 * every follow-up stream.open of the recorded Session while a fresh Session
 * worked).
 *
 * The mechanics under test: a Turn killed mid-flight leaves its durable
 * `local_runtime_session_locks` lease behind (owner `turn-lease:<pid>:<inst>`,
 * 30-minute expiry). The restarted Runtime must reconcile that orphan so the
 * Session accepts turns again — and the reconciliation must NOT depend on bare
 * PID liveness, because the restarted daemon frequently INHERITS the dead
 * daemon's pid: `kill(pid, 0)` then succeeds against a recycled pid while the
 * recorded owner is provably gone (its instance lease carries a different
 * process-generation start token).
 *
 * Reproduction shape (host A is abandoned, never closed gracefully — the kill;
 * its instance lease is rewritten the way a dead previous process would have
 * written it; host B boots on the same dataDir as the restarted daemon):
 *  - before the fix, host B kept the orphan lease as "live", every
 *    turn-admitting stream.open (sendMessage) was refused 409
 *    `local_session_busy` (the hub surfaces it as RUNTIME_REJECTED "stream
 *    refused by the runtime"), and the Session stayed durably "started";
 *  - after the fix, boot recovery releases the lease, settles the orphan Turn
 *    (terminal fact, no silent content reset), the Session accepts a new Turn
 *    and an anchored resume replays the durable tail.
 *
 * The second block pins the honest side of the contract: a LIVE Turn (second
 * client on the same Session) must keep refusing a second admitting stream
 * with 409 — the fix only touches dead owners, never live Turn exclusivity.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CreatedLocalRuntimeHost,
  type LocalRuntimeConfig,
} from '@mavis/local-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeLocalRuntimeDb } from '../../../local-runtime/src/persistence/db.js';
import { loadSqlite3Constructor } from '../../src/infra/db/client.js';
import { serializeRuntimeOwnerLease } from '../../src/infra/runtime-owner/runtime-owner-lease.js';
import type { CliService, SessionStreamFrameView } from '../../src/local/cli-service.js';
import { createLocalRuntimeHostV2ForTest } from '../../src/runtime.js';

// The repro needs TWO host generations on ONE dataDir inside one test process.
// The durable history writer fence legitimately refuses a second in-process
// writer (its own pid-recycle takeover covers the real restart), so this file
// pins the SESSION-lease fence (runtime-state.sqlite `local_runtime_session_
// locks`) in the legacy jsonl history mode, which has no second writer.
process.env['MCODE_HISTORY_PROVIDER'] = 'jsonl';

interface ScriptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
  readonly eventWriter: {
    pushRuntime(event: Record<string, unknown>): void | Promise<void>;
  };
}

const harness = vi.hoisted(() => ({
  /** Turn scripts run in order; a missing script just completes the Turn. */
  scripts: [] as ((input: ScriptedTurnInput) => Promise<void>)[],
  invocations: 0,
  /** Session ids of every Turn the Runtime actually started. */
  startedTurns: [] as { sessionId: string; turnId: string }[],
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
  return {
    ...actual,
    PiTurnRunner: class {
      async runTurn(input: ScriptedTurnInput): Promise<void> {
        const index = harness.invocations;
        harness.invocations += 1;
        harness.startedTurns.push({ sessionId: input.sessionId, turnId: input.turnId });
        const script = harness.scripts[index];
        if (script) await script(input);
        await input.eventWriter.pushRuntime(terminalEvent(input, 6, 1, 'completed'));
      }
    },
  };
});

function terminalEvent(
  input: ScriptedTurnInput,
  status: number,
  stopReason: number,
  message: string,
): Record<string, unknown> {
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('session-status') ?? `evt-${input.turnId}-${status}`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? status,
    type: 3,
    payload: { status, stop_reason: { type: stopReason, message } },
  };
}

/** A Turn body that never settles on its own — the mid-Turn owner death. */
function hangForever(): (input: ScriptedTurnInput) => Promise<void> {
  return () => new Promise<void>(() => undefined);
}

/** A LIVE Turn body: runs until its abort signal (the second-client test). */
function runUntilAborted(): (input: ScriptedTurnInput) => Promise<void> {
  return (input) => {
    const signal = input.signal;
    if (!signal) throw new Error('script requires the abort signal');
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
}

const OWNER_LEASES_DIR = join('v2', 'runtime-owner-leases');
/** A start token no living process of this test generation can record. */
const DEAD_OWNER_GENERATION_TOKEN = 'test-generation:dead-owner';

let hosts: CreatedLocalRuntimeHost[] = [];
let dataDir: string | undefined;
const HOST_TEST_TIMEOUT_MS = 240_000;

function createHost(hostDataDir: string): Promise<CreatedLocalRuntimeHost> {
  const config = {
    dataDir: hostDataDir,
    defaultModel: 'test/model',
    provider: {
      test: {
        options: { apiKey: 'test-key', baseURL: 'https://provider.test/v1' },
        models: {
          model: { modalities: { input: ['text'], output: ['text'] } },
        },
      },
    },
  } as LocalRuntimeConfig;
  const host = createLocalRuntimeHostV2ForTest({
    dataDir: hostDataDir,
    runtimeOwnerKind: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(hostDataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
  return host;
}

/** The single owner lease file of the (single) host booted so far. */
async function soleOwnerLeasePath(hostDataDir: string): Promise<string> {
  const dir = join(hostDataDir, OWNER_LEASES_DIR);
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.owner'));
  expect(entries, 'exactly one runtime owner lease expected').toHaveLength(1);
  return join(dir, entries[0] ?? '');
}

interface LockRow {
  readonly session_id: string;
  readonly owner_id: string;
  readonly owner_kind: string;
}

function readLockRows(hostDataDir: string, sessionId?: string): LockRow[] {
  const Database = loadSqlite3Constructor();
  const db = new Database(join(hostDataDir, 'v2', 'sqlite', 'runtime-state.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = (
      db.prepare('SELECT session_id, owner_id, owner_kind FROM local_runtime_session_locks').all() as Record<
        string,
        string
      >[]
    ).map((row) => ({
      session_id: row['session_id'] ?? '',
      owner_id: row['owner_id'] ?? '',
      owner_kind: row['owner_kind'] ?? '',
    }));
    return sessionId === undefined ? rows : rows.filter((row) => row.session_id === sessionId);
  } finally {
    db.close();
  }
}

interface IngressRow {
  readonly turn_id: string;
  readonly status: string;
}

function readTurnIngress(hostDataDir: string, sessionId: string): IngressRow[] {
  const Database = loadSqlite3Constructor();
  const db = new Database(join(hostDataDir, 'v2', 'sqlite', 'runtime-state.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      db
        .prepare(
          'SELECT turn_id, status FROM local_runtime_turn_ingress WHERE session_id = ? ORDER BY accepted_sequence',
        )
        .all(sessionId) as Record<string, string>[]
    ).map((row) => ({ turn_id: row['turn_id'] ?? '', status: row['status'] ?? '' }));
  } finally {
    db.close();
  }
}

/** Drains a mapped v2 stream to its "[DONE]" sentinel and returns the frames. */
async function drainStream(
  source: AsyncIterable<SessionStreamFrameView>,
): Promise<SessionStreamFrameView[]> {
  const frames: SessionStreamFrameView[] = [];
  for await (const frame of source) {
    frames.push(frame);
    if (frame.dataJson === '[DONE]') break;
  }
  return frames;
}

async function waitFor(
  probe: () => boolean | Promise<boolean>,
  outline: string,
  timeoutMs = 60_000,
): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await probe(), outline).toBe(true);
    },
    { timeout: timeoutMs, interval: 100 },
  );
}

afterEach(async () => {
  // Close in reverse boot order; every close is best-effort — the killed host's
  // close may trip over its force-forgotten v1 connection, which is fine.
  for (const host of hosts.reverse()) {
    await host.apiHost.close().catch(() => undefined);
    await host.metricsClient.close().catch(() => undefined);
  }
  hosts = [];
  if (dataDir) {
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  dataDir = undefined;
  harness.scripts = [];
  harness.invocations = 0;
  harness.startedTurns = [];
});

describe('resume after the owner died mid-Turn', () => {
  it(
    'a recycled owner pid does not fence the recorded Session: the orphan Turn is reconciled and streams open again',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'resume-owner-death-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });

      // 1. Owner generation: boot, create the Session, start a Turn that dies
      //    mid-flight with the process (never settles, ignores aborts).
      harness.scripts = [hangForever(), async () => undefined];
      const killedHost = await createHost(dataDir);
      hosts.push(killedHost);
      const killedConversation = killedHost.apiHost.runtimeConversation!;
      const session = await killedConversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });
      const orphanTurn = await killedConversation.ingress.submit({
        sessionId: session.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'killed mid-turn', attachments: [] },
      });
      await waitFor(
        () => harness.startedTurns.some((turn) => turn.sessionId === session.sessionId),
        'the owner Turn must be running before the kill',
      );

      // Precondition: the Turn owns its durable session lease.
      const orphanLocks = readLockRows(dataDir, session.sessionId);
      expect(orphanLocks).toHaveLength(1);
      expect(orphanLocks[0]?.owner_kind).toBe('turn');

      // 2. The kill: no graceful close — the durable lease and the instance
      //    lease file stay exactly like after SIGKILL. The restarted daemon
      //    then INHERITS the pid (modeled by the same process being alive) but
      //    is a different process generation: rewrite the instance lease the
      //    way the dead process wrote it (its own, now-stale start token).
      closeLocalRuntimeDb(dataDir);
      const deadOwnerLease = await soleOwnerLeasePath(dataDir);
      const deadOwnerLeaseText = await readFile(deadOwnerLease, 'utf8');
      expect(deadOwnerLeaseText).toContain(String(process.pid));
      await writeFile(
        deadOwnerLease,
        serializeRuntimeOwnerLease({ pid: process.pid, startToken: DEAD_OWNER_GENERATION_TOKEN }),
      );

      // 3. The restarted daemon on the same dataDir.
      const restartedHost = await createHost(dataDir);
      hosts.push(restartedHost);
      const cli = restartedHost.cliService as CliService;
      expect(cli, 'the restarted host exposes the CliService').toBeDefined();

      // THE FIX (root): boot recovery reconciled the orphan — lease released,
      // orphan Turn settled durably. No silent content reset: the receipt is a
      // terminal fact on the recorded ingress row.
      await waitFor(
        () => readLockRows(dataDir, session.sessionId).length === 0,
        'the orphaned Turn lease must be released by the restarted Runtime',
      );
      const ingress = readTurnIngress(dataDir, session.sessionId);
      expect(
        ingress.some((row) => row.turn_id === orphanTurn.turnId && row.status === 'failed'),
        'the orphan Turn must carry a terminal (failed) settlement receipt',
      ).toBe(true);

      // 4. The incident surface: a follow-up stream.open on the recorded
      //    Session must be ACCEPTED (pre-fix: 409 local_session_busy → hub
      //    RUNTIME_REJECTED "stream refused by the runtime").
      const nextTurn = await cli.sendMessage({ id: session.sessionId, content: 'after restart' });
      expect(nextTurn.ok, `sendMessage refused: ${JSON.stringify(nextTurn.ok ? null : nextTurn)}`).toBe(
        true,
      );
      await waitFor(
        () => harness.startedTurns.filter((turn) => turn.sessionId === session.sessionId).length >= 2,
        'the follow-up Turn must run on the reconciled Session',
      );

      // 5. Resume of the recorded Session: anchored resume replays the durable
      //    tail (the post-restart exchange) and ends cleanly.
      const messages = await cli.getMessages({ id: session.sessionId });
      const firstMsgId = messages.messages?.[0]?.msgId;
      expect(typeof firstMsgId, 'the Session keeps its durable messages').toBe('string');
      const resumed = await cli.resumeSession({ id: session.sessionId, afterMsgId: firstMsgId });
      expect(resumed.ok, `resume refused: ${JSON.stringify(resumed.ok ? null : resumed)}`).toBe(true);
      if (resumed.ok) {
        const frames = await drainStream(resumed.source as AsyncIterable<SessionStreamFrameView>);
        expect(
          frames.some((frame) => frame.dataJson.includes('"type":2')),
          'the resumed stream replays committed durable messages',
        ).toBe(true);
        expect(frames.at(-1)?.dataJson).toBe('[DONE]');
      }

      // 6. Control: a FRESH Session works the same way (it always did).
      const fresh = await cli.sendMessage({ id: (await freshSessionId(cli, dataDir)), content: 'fresh' });
      expect(fresh.ok, 'a fresh session must keep working').toBe(true);
      await waitFor(
        () => harness.startedTurns.length >= 3,
        'the fresh control Turn must complete',
      );
    },
    HOST_TEST_TIMEOUT_MS,
  );

  it(
    'a LIVE Turn still refuses a second admitting stream with 409 local_session_busy',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'resume-live-turn-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });

      harness.scripts = [runUntilAborted()];
      const host = await createHost(dataDir);
      hosts.push(host);
      const cli = host.cliService as CliService;
      const conversation = host.apiHost.runtimeConversation!;
      const session = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });

      const first = await cli.sendMessage({ id: session.sessionId, content: 'live turn' });
      expect(first.ok).toBe(true);
      await waitFor(
        () => harness.startedTurns.some((turn) => turn.sessionId === session.sessionId),
        'the first client Turn must be running',
      );

      // The second client on the same Session: the refusal is honest and stays.
      const second = await cli.sendMessage({ id: session.sessionId, content: 'second client' });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.status).toBe(409);
        expect((second.body as { key?: string }).key).toBe('local_session_busy');
      }
      expect(readLockRows(dataDir, session.sessionId)).toHaveLength(1);

      await cli.abortSession({ id: session.sessionId, reason: 'test-teardown' });
      await waitFor(() => readLockRows(dataDir, session.sessionId).length === 0, 'the live Turn released its lease after abort');
    },
    HOST_TEST_TIMEOUT_MS,
  );
});

async function freshSessionId(cli: CliService, hostDataDir: string): Promise<string> {
  const created = await cli.createSession({
    name: 'mavis',
    workspaceDir: join(hostDataDir, 'workspace'),
    title: 'fresh-control',
  });
  if (!created.sessionId) throw new Error('fresh control session was not created');
  return created.sessionId;
}
