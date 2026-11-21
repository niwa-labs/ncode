/**
 * Incident 03 (2026-11-05, "brick" session) — the owner scenario end to end
 * over the assembled V2 Runtime host (the embedded composition, durable
 * history by default, scripted turn runner — the same harness as
 * `resume-after-owner-death.e2e.test.ts`).
 *
 * The turn accepts TWO parallel `task` calls; only one ever starts. The abort
 * cascade commits the started call's error result and then the todo cadence
 * reminder (the child session died on its empty partial assistant instead).
 * Before the fix the reminder was committed into the durable log FIRST and
 * rejected by the strict sequence walk AFTER the commit — every later turn
 * died on `history_read` ("Conversation history could not be safely updated"),
 * and a restart rebuilt the poison as is.
 *
 * After the fix, three layers hold on the real pipeline:
 * 1. the runner's history delivery gate HOLDS non-toolResult deltas while the
 *    round's turn is alive (unit-pinned in agent-core), so a live round can
 *    never be closed from under its own results;
 * 2. the durable append closes a stale open round honestly BEFORE such a
 *    delta — the same unknown-outcome synthesis the abort reconcile uses —
 *    and the strict pass validates the PROJECTED sequence before the enqueue
 *    (fail-closed for anything the repair cannot heal: orphan results,
 *    duplicate identities);
 * 3. the abort reconcile (`settle-turn-tail`, abort mode) closes the turn's
 *    round for ALL accepted calls, so an aborted turn ends ABORTED (a failed
 *    reconcile would fail the turn) and the follow-up turn in the SAME
 *    session passes setup (`history_read`) and works.
 *
 * The script reproduces the incident's delivery order (assistant delta, the
 * started call's error result, abort, then the reminder delta) through the
 * assembled pipeline's real history seam.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import {
  type CreatedLocalRuntimeHost,
  type LocalRuntimeConfig,
} from '@mavis/local-runtime';
import { RuntimeEventStatus, RuntimeStopReasonType } from '@mavis/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeLocalRuntimeDb } from '../../../local-runtime/src/persistence/db.js';
import { loadSqlite3Constructor } from '../../src/infra/db/client.js';
import type { CliService } from '../../src/local/cli-service.js';
import { formatTodoCadenceReminderContent } from '../../src/service/turn-system/agent-host/history/canonical-history-validation.js';
import { createLocalRuntimeHostV2ForTest } from '../../src/runtime.js';

interface ScriptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
  readonly eventWriter: {
    pushRuntime(event: Record<string, unknown>): void | Promise<void>;
  };
  readonly hooks?: {
    readonly onHistoryChangedHook?:
      | readonly ((input: {
          sessionId: string;
          turnId: string;
          reason: 'messageDelta' | 'replaceMessages';
          messages: readonly unknown[];
        }) => Promise<void> | void)[]
      | undefined;
  };
}

interface ScriptOutcome {
  readonly result?: Record<string, unknown>;
}

const harness = vi.hoisted(() => ({
  /** Turn scripts run in order; a missing script just completes the Turn. */
  scripts: [] as ((input: ScriptedTurnInput) => Promise<ScriptOutcome | void>)[],
  invocations: 0,
  startedTurns: [] as { sessionId: string; turnId: string }[],
  /** How the poison delta was dispositioned by the assembled pipeline. */
  reminderDisposition: 'not attempted' as string,
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
  return {
    ...actual,
    PiTurnRunner: class {
      async runTurn(input: ScriptedTurnInput): Promise<ScriptOutcome | void> {
        const index = harness.invocations;
        harness.invocations += 1;
        harness.startedTurns.push({ sessionId: input.sessionId, turnId: input.turnId });
        const script = harness.scripts[index];
        return script ? await script(input) : undefined;
      }
    },
  };
});

const T = 1_700_000_000_000;

function terminalEvent(
  input: ScriptedTurnInput,
  status: RuntimeEventStatus,
  message: string,
): Record<string, unknown> {
  const stopType =
    status === RuntimeEventStatus.ABORTED
      ? RuntimeStopReasonType.ABORT
      : RuntimeStopReasonType.END_TURN;
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('session-status') ?? `evt-${input.turnId}-${status}`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? 100 + status,
    type: 3,
    payload: { status, stop_reason: { type: stopType, message } },
  };
}

async function deliverDelta(input: ScriptedTurnInput, messages: readonly unknown[]): Promise<void> {
  const hook = input.hooks?.onHistoryChangedHook?.[0];
  if (!hook) throw new Error('the assembled host must expose the history delivery hook');
  await hook({
    sessionId: input.sessionId,
    turnId: input.turnId,
    reason: 'messageDelta',
    messages: [...messages],
  });
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error('the incident script requires the abort signal');
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

/** A valid todo cadence reminder marker (the parent session's poison delta). */
function todoCadenceReminder(timestamp: number): Record<string, unknown> {
  const details = {
    version: 1 as const,
    summary: { total: 2, active: 1, completed: 1, cancelled: 0 },
    todos: [
      { content: 'poll the background task', status: 'in_progress', priority: 'high' },
      { content: 'report the result', status: 'completed', priority: 'medium' },
    ],
    cadence: { assistantIterationsSinceTodoWrite: 15, assistantIterationsSinceReminder: 15 },
  };
  return {
    role: 'custom',
    customType: 'todo_cadence_reminder',
    content: formatTodoCadenceReminderContent(details),
    display: false,
    details,
    timestamp,
  };
}

/** Turn 1: two accepted parallel calls, one started, abort, then the reminder. */
async function incidentTurn(input: ScriptedTurnInput): Promise<ScriptOutcome> {
  await deliverDelta(input, [
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call-started', name: 'task', arguments: {} },
        { type: 'toolCall', id: 'call-queued', name: 'task', arguments: {} },
      ],
      timestamp: T,
    },
  ]);
  await deliverDelta(input, [
    {
      role: 'toolResult',
      toolCallId: 'call-started',
      toolName: 'task',
      content: [{ type: 'text', text: '<task_error task_id="bg_incident"></task_error>' }],
      isError: true,
      timestamp: T + 1,
    },
  ]);
  await aborted(input.signal);
  try {
    await deliverDelta(input, [todoCadenceReminder(T + 2)]);
    harness.reminderDisposition = 'committed';
  } catch (error) {
    harness.reminderDisposition = `refused: ${error instanceof Error ? error.message : String(error)}`;
  }
  await input.eventWriter.pushRuntime(
    terminalEvent(input, RuntimeEventStatus.ABORTED, 'owner aborted the turn'),
  );
  return { result: { reconcile: { kind: 'abort-reconcile', approvedContent: '' } } };
}

/** Turn 2: an ordinary turn — it must pass setup and commit its reply. */
async function followUpTurn(input: ScriptedTurnInput): Promise<void> {
  await deliverDelta(input, [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'collected after the abort' }],
      timestamp: T + 3,
    },
  ]);
  await input.eventWriter.pushRuntime(
    terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'),
  );
}

let hosts: CreatedLocalRuntimeHost[] = [];
let dataDir: string | undefined;
const HOST_TEST_TIMEOUT_MS = 180_000;

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
  return createLocalRuntimeHostV2ForTest({
    dataDir: hostDataDir,
    runtimeOwnerKind: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(hostDataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
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

/** Every canonical envelope the durable log holds for the session (all entry kinds). */
function readDurableEnvelopes(hostDataDir: string, sessionId: string): Record<string, unknown>[] {
  const backend = SqliteZstdBackend.open(join(hostDataDir, 'durable-history'));
  try {
    const envelopes: Record<string, unknown>[] = [];
    let cursor = 0;
    for (;;) {
      const window = backend.readDeltaChecked(cursor, 64 * 1024 * 1024);
      for (const entry of window.entries) {
        const payload = entry.payload as
          | { sessionId?: string; envelopes?: readonly unknown[] }
          | undefined;
        if (payload?.sessionId !== sessionId) continue;
        // Wave 1 event log: the base/appends ride `envelopes`, a repair's
        // synthesized outcomes ride `appended`, a compaction replace's
        // inserted summary rides `inserted`.
        for (const field of ['envelopes', 'appended', 'inserted'] as const) {
          const list = payload[field];
          if (Array.isArray(list)) envelopes.push(...(list as Record<string, unknown>[]));
        }
      }
      if (window.nextAfterSeq === null) break;
      cursor = window.nextAfterSeq;
    }
    return envelopes;
  } finally {
    backend.close();
  }
}

afterEach(async () => {
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
  harness.reminderDisposition = 'not attempted';
});

describe('incident 03: the abort of a half-started tool round must not brick the Session', () => {
  it(
    'the reminder delta heals the stale round instead of poisoning it, and the next turn runs',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'abort-brick-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      harness.scripts = [incidentTurn, followUpTurn];
      const host = await createHost(dataDir);
      hosts.push(host);
      const cli = host.cliService as CliService;
      expect(cli, 'the host exposes the CliService').toBeDefined();
      const conversation = host.apiHost.runtimeConversation!;
      const session = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });

      // The incident turn: two accepted parallel calls, one started, abort.
      const opened = await cli.sendMessage({
        id: session.sessionId,
        content: 'use subagents to collect data in different places',
      });
      expect(opened.ok, `sendMessage refused: ${JSON.stringify(opened.ok ? null : opened)}`).toBe(
        true,
      );
      await waitFor(
        () => harness.startedTurns.some((turn) => turn.sessionId === session.sessionId),
        'the incident turn must be running before the abort',
      );
      await cli.abortSession({ id: session.sessionId, reason: 'incident-repro' });

      // 1. The reminder delta reached the assembled pipeline over the open
      //    round and was COMMITTED — after the durable append closed the
      //    stale round honestly (the incident committed it first and threw
      //    only after the commit).
      expect(harness.reminderDisposition).toBe('committed');

      // 2. The turn ends ABORTED — the abort reconcile applied cleanly (a
      //    failed reconcile would fail the turn instead).
      try {
        await waitFor(
          () =>
            readTurnIngress(dataDir!, session.sessionId).some(
              (row) =>
                row.turn_id === harness.startedTurns[0]?.turnId && row.status === 'aborted',
            ),
          'the incident turn must settle as aborted with the reconcile applied',
        );
      } catch (error) {
        console.warn('[diagnostics] ingress rows:', JSON.stringify(readTurnIngress(dataDir!, session.sessionId)));
        console.warn('[diagnostics] reminder disposition:', harness.reminderDisposition);
        throw error;
      }

      // 3. A NEW turn in the SAME session passes setup (history_read) and
      //    works. Pre-fix this is exactly where every retry died.
      const next = await cli.sendMessage({ id: session.sessionId, content: 'continue after abort' });
      expect(next.ok, `follow-up refused: ${JSON.stringify(next.ok ? null : next)}`).toBe(true);
      await waitFor(
        () =>
          readTurnIngress(dataDir!, session.sessionId).some((row) => row.status === 'completed'),
        'the follow-up turn must complete on the recovered session',
      );

      // 4. The durable log: the queued call's round closed honestly, the
      //    reminder durable, the follow-up committed.
      const hostClosed = hosts.pop();
      if (hostClosed) {
        await hostClosed.apiHost.close().catch(() => undefined);
        await hostClosed.metricsClient.close().catch(() => undefined);
      }
      closeLocalRuntimeDb(dataDir);
      const envelopes = readDurableEnvelopes(dataDir, session.sessionId);
      const synthesized = envelopes.find(
        (envelope) =>
          Reflect.get(Reflect.get(envelope, 'message') as object, 'role') === 'toolResult' &&
          Reflect.get(Reflect.get(envelope, 'message') as object, 'toolCallId') === 'call-queued',
      );
      expect(
        synthesized,
        'the stale round must be closed for the queued call too',
      ).toBeDefined();
      const synthesizedMessage = Reflect.get(synthesized!, 'message') as Record<string, unknown>;
      expect(synthesizedMessage['isError']).toBe(true);
      expect(synthesizedMessage['details']).toMatchObject({
        checkpointPolicy: { outcome: 'tool-outcome-unknown', toolName: 'task' },
      });
      expect(
        envelopes.some(
          (envelope) =>
            Reflect.get(Reflect.get(envelope, 'message') as object, 'role') === 'custom' &&
            Reflect.get(Reflect.get(envelope, 'message') as object, 'customType') ===
              'todo_cadence_reminder',
        ),
        'the reminder delta itself must be durable (landed after the round closed)',
      ).toBe(true);
      expect(
        envelopes.some(
          (envelope) =>
            Reflect.get(Reflect.get(envelope, 'message') as object, 'role') === 'assistant' &&
            JSON.stringify(Reflect.get(Reflect.get(envelope, 'message') as object, 'content')).includes(
              'collected after the abort',
            ),
        ),
        'the follow-up turn\u2019s reply must be committed on the recovered history',
      ).toBe(true);
    },
    HOST_TEST_TIMEOUT_MS,
  );
});
