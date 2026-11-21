/**
 * Wave 4 burst verticals (verdict 09 §3.3, acceptance №11) over the assembled
 * V2 Runtime host — real ingress, real task runner, real background-task store
 * and the REAL delivery scheduler; only the Pi runner is scripted. Same rig
 * contract as the wave-2/3 reactive e2e files.
 *
 * Covered:
 * - five SIMULTANEOUS child terminals coalesce into ONE delivery admission
 *   (one `turn_task_delivery` wake Turn whose envelope names all five tasks);
 *   no terminal is lost, no window is pushed forward by later finishes;
 * - the completion storm guard binds AUTONOMOUS activations only: after three
 *   idle wakes exhaust the 3/60s window, a fourth terminal is deferred (held,
 *   never lost, no 300s cooldown retry storm) while a normal owner input is
 *   accepted immediately and consumed by the parent Turn — owner input is
 *   never rate-limited by the completion budget.
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CreatedLocalRuntimeHost,
  type LocalRuntimeConfig,
} from '@mavis/local-runtime';
import { RuntimeEventStatus, RuntimeStopReasonType } from '@mavis/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalRuntimeToolContext, ToolResult } from '@mavis/agent-tools/desktop';
import type { ConversationSteerInput } from '@mavis/conversation-contract';

import { closeLocalRuntimeDb } from '../../../local-runtime/src/persistence/db.js';
import { persistLocalSubagentTaskTerminal } from '../../../local-runtime/src/background-task/terminal.js';
import { scheduleLocalBackgroundTaskDelivery } from '../../../local-runtime/src/background-task/delivery.js';

process.env.MCODE_PUBLISH_JSONL = 'on';
import { createLocalRuntimeHostV2ForTest } from '../../src/runtime.js';
import type { CliService } from '../../src/local/cli-service.js';

interface ScriptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
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
  readonly eventWriter: {
    pushRuntime(event: Record<string, unknown>): void | Promise<void>;
  };
  readonly toolConfig: {
    readonly context: unknown;
    readonly tools?: readonly {
      readonly def: { readonly name: string };
      readonly impl: {
        execute(
          context: unknown,
          input: Record<string, unknown>,
          signal?: AbortSignal,
        ): Promise<ToolResult>;
      };
    }[];
  };
  readonly tryBeginClose?: () => Promise<
    { readonly closed: true } | { readonly closed: false; readonly reason: string }
  >;
  readonly getSteeringMessages?: (context?: {
    readonly boundary?: string;
  }) => Promise<readonly unknown[]>;
}

const harness = vi.hoisted(() => ({
  scripts: [] as ((input: ScriptedTurnInput) => Promise<void>)[],
  invocations: 0,
  startedTurns: [] as { sessionId: string; turnId: string; startedAtMs: number }[],
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
  return {
    ...actual,
    PiTurnRunner: class {
      async runTurn(input: ScriptedTurnInput): Promise<void> {
        const index = harness.invocations;
        harness.invocations += 1;
        harness.startedTurns.push({
          sessionId: input.sessionId,
          turnId: input.turnId,
          startedAtMs: Date.now(),
        });
        const script = harness.scripts[index];
        if (script) await script(input);
        let close = await input.tryBeginClose?.();
        if (close && close.closed === false && close.reason === 'steer-pending') {
          await input.getSteeringMessages?.({ boundary: 'exit' });
          close = await input.tryBeginClose?.();
        }
        if (!input.signal?.aborted) {
          await input.eventWriter.pushRuntime(terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'));
        }
      }
    },
  };
});

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

async function deliverDelta(
  input: ScriptedTurnInput,
  messages: readonly unknown[],
): Promise<void> {
  const hook = input.hooks?.onHistoryChangedHook?.[0];
  if (!hook) throw new Error('the assembled host must expose the history delivery hook');
  await hook({
    sessionId: input.sessionId,
    turnId: input.turnId,
    reason: 'messageDelta',
    messages: [...messages],
  });
}

const T = 1_700_000_000_000;

function assistantBatchDelta(calls: readonly { id: string; background: boolean }[]): Record<string, unknown> {
  return {
    role: 'assistant',
    provider: 'test',
    api: 'openai-completions',
    model: 'model',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: 'task',
      arguments: {
        agent_name: 'worker',
        description: `Child ${call.id}`,
        prompt: `work ${call.id}`,
        ...(call.background ? { run_in_background: true } : {}),
      },
    })),
    timestamp: T,
  };
}

function toolResultDelta(
  callId: string,
  text: string,
  isError = false,
): Record<string, unknown> {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'task',
    content: [{ type: 'text', text }],
    isError,
    timestamp: T + 1,
  };
}

function assistantReplyDelta(text: string, timestamp = T + 2): Record<string, unknown> {
  return {
    role: 'assistant',
    provider: 'test',
    api: 'openai-completions',
    model: 'model',
    content: text,
    timestamp,
  };
}

function assistantReplyEvent(input: ScriptedTurnInput, content: string): Record<string, unknown> {
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('stream-resp') ?? `evt-${input.turnId}-resp`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? 2,
    type: 1,
    payload: {
      stream_resp: JSON.stringify({
        type: 2,
        agent_message: {
          msg_id: `msg-${input.turnId}`,
          role: 'assistant',
          msg_content: content,
        },
      }),
    },
  };
}

function tool(input: ScriptedTurnInput, name: string) {
  const found = input.toolConfig.tools?.find((candidate) => candidate.def.name === name);
  if (!found) throw new Error(`Production Turn omitted the ${name} tool`);
  return found;
}

function callContext(input: ScriptedTurnInput, callId: string): LocalRuntimeToolContext {
  return {
    ...(input.toolConfig.context as LocalRuntimeToolContext),
    toolCallId: callId,
  };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await probe()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let host: CreatedLocalRuntimeHost | undefined;
let dataDir: string | undefined;

const steers: Array<{
  readonly input: ConversationSteerInput;
  readonly result: { delivered: boolean; mode?: string; turnId?: string };
}> = [];
let ownerSessionId = '';

async function startRig(): Promise<{
  cli: CliService;
  conversation: NonNullable<CreatedLocalRuntimeHost['apiHost']['runtimeConversation']>;
}> {
  dataDir = await mkdtemp(join(tmpdir(), 'reactive-task-burst-'));
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  const config = {
    dataDir,
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
  host = await createLocalRuntimeHostV2ForTest({
    dataDir,
    runtimeOwnerKind: 'cli',
    capabilityProfile: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(dataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
  const conversation = host.apiHost.runtimeConversation!;
  tapSteers(conversation);
  return { cli: host.cliService as CliService, conversation };
}

function tapSteers(
  conversation: NonNullable<CreatedLocalRuntimeHost['apiHost']['runtimeConversation']>,
): void {
  const ingress = conversation.ingress as {
    steer(input: ConversationSteerInput): Promise<{
      delivered: boolean;
      mode?: string;
      turnId?: string;
    }>;
  };
  const originalSteer = ingress.steer.bind(ingress);
  steers.length = 0;
  ingress.steer = async (input: ConversationSteerInput) => {
    const result = await originalSteer(input);
    steers.push({ input, result });
    return result;
  };
}

async function closeHost(): Promise<void> {
  await host?.apiHost.close().catch(() => undefined);
  await host?.metricsClient.close().catch(() => undefined);
  host = undefined;
}

async function waitOwnerIdle(cli: CliService): Promise<void> {
  await waitFor(async () => (await cli.getActiveTurn(ownerSessionId)) === undefined, 'owner idle');
}

function ownerTurns(): readonly { sessionId: string; turnId: string; startedAtMs: number }[] {
  return harness.startedTurns.filter((turn) => turn.sessionId === ownerSessionId);
}

function deliveryTurns(): readonly { sessionId: string; turnId: string; startedAtMs: number }[] {
  return ownerTurns().filter((turn) => turn.turnId.startsWith('turn_task_delivery'));
}

function childTurns(): readonly { sessionId: string; turnId: string; startedAtMs: number }[] {
  return harness.startedTurns.filter((turn) => turn.sessionId !== ownerSessionId);
}

function deliverySteers(): readonly {
  readonly input: ConversationSteerInput;
  readonly result: { delivered: boolean; mode?: string; turnId?: string };
}[] {
  return steers.filter((entry) => entry.input.producerId === 'background-task-delivery');
}

async function subagentRows(): Promise<
  readonly { taskId: string; status: string; deliveredAt?: number }[]
> {
  const list = await host!.apiHost.backgroundTaskService.list({ ownerSessionId, limit: 50 });
  return list.items
    .filter((task) => task.kind === 'subagent')
    .map((task) => ({
      taskId: task.taskId,
      status: task.status,
      ...(task.deliveredAt === undefined ? {} : { deliveredAt: task.deliveredAt }),
    }));
}

/** The canonical durable log of the session — what the wake Turn actually consumed. */
function readPublishedCanonicalHistory(hostDataDir: string, sessionId: string): string {
  const identities = [sessionId, Buffer.from(sessionId, 'utf8').toString('base64')];
  const stack = [join(hostDataDir, 'v2', 'sessions')];
  const found: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      if (entry === 'messages.jsonl') {
        if (identities.some((identity) => current.includes(identity))) found.push(full);
        continue;
      }
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) stack.push(full);
    }
  }
  if (found.length === 0) {
    throw new Error(`no published canonical history found for ${sessionId}`);
  }
  return found.map((file) => readFileSync(file, 'utf8')).join('\n');
}

afterEach(async () => {
  await closeHost();
  if (dataDir) {
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  dataDir = undefined;
  harness.scripts = [];
  harness.invocations = 0;
  harness.startedTurns = [];
  steers.length = 0;
  ownerSessionId = '';
});

const HOST_TIMEOUT_MS = 240_000;

async function createOwner(
  conversation: NonNullable<CreatedLocalRuntimeHost['apiHost']['runtimeConversation']>,
): Promise<void> {
  const owner = await conversation.lifecycle.createSession({
    agentName: 'mavis',
    workspaceDir: join(dataDir!, 'workspace'),
    sessionType: 'root',
  });
  ownerSessionId = owner.sessionId;
}

describe('reactive subagents wave 4: burst delivery over the production host', () => {
  it(
    '№11a: five simultaneous child terminals coalesce into ONE delivery admission',
    async () => {
      const { cli, conversation } = await startRig();
      await createOwner(conversation);

      const childLatches = [deferred(), deferred(), deferred(), deferred(), deferred()];
      let backgroundNotes = 0;
      harness.scripts = [
        // Parent: five `run_in_background` task calls in one batch — each
        // returns its launch note immediately, so the parent turn ends while
        // all five children still run.
        async (input) => {
          await deliverDelta(input, [
            assistantBatchDelta([
              { id: 'call_bg_1', background: true },
              { id: 'call_bg_2', background: true },
              { id: 'call_bg_3', background: true },
              { id: 'call_bg_4', background: true },
              { id: 'call_bg_5', background: true },
            ]),
          ]);
          for (const callId of ['call_bg_1', 'call_bg_2', 'call_bg_3', 'call_bg_4', 'call_bg_5']) {
            const result = await tool(input, 'task').impl.execute(
              callContext(input, callId),
              {
                agent_name: 'worker',
                description: `Child ${callId}`,
                prompt: `work ${callId}`,
                run_in_background: true,
              },
              input.signal,
            );
            expect(result.text ?? '').toContain('<task_background');
            backgroundNotes += 1;
            await deliverDelta(input, [toolResultDelta(callId, result.text ?? '')]);
          }
          await deliverDelta(input, [assistantReplyDelta('all five launched')]);
        },
        // Five children, each parked on its own latch until the test releases
        // all of them in the same tick.
        ...childLatches.map((latch) => async (input: ScriptedTurnInput) => {
          await latch.promise;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'child finished'));
        }),
      ];

      const firstTurn = await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'launch five background tasks', attachments: [] },
      });
      await firstTurn.completion;
      expect(backgroundNotes).toBe(5);
      await waitFor(async () => childTurns().length === 5, 'five children started');
      await waitOwnerIdle(cli);
      expect(deliveryTurns()).toEqual([]);

      // Five terminals land in the same tick — inside ONE coalescing epoch.
      for (const latch of childLatches) latch.resolve();

      await waitFor(() => deliveryTurns().length > 0, 'the coalesced delivery wake');
      // Exactly ONE admission for all five; no later finish pushed a second one.
      expect(deliveryTurns()).toHaveLength(1);
      const admission = deliverySteers();
      expect(admission).toHaveLength(1);
      expect(admission[0]!.input.message.origin.taskIds).toHaveLength(5);
      expect(admission[0]!.result.mode).toBe('activated');
      for (const taskId of (admission[0]!.input.message.origin.taskIds ?? []) as string[]) {
        expect(admission[0]!.input.message.content).toContain(`task_id="${taskId}"`);
      }
      // No terminal was lost: all five rows are terminal; the scheduler
      // acknowledged the single admission (deliveredAt stays unset until a
      // task_output read — the wake admission is the delivery).
      const rows = await subagentRows();
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.status === 'succeeded')).toBe(true);

      // The wake Turn is quiet afterwards — no trailing second admission.
      await waitOwnerIdle(cli);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(deliveryTurns()).toHaveLength(1);
      void cli;
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№11b: three idle wakes exhaust the activation guard; the deferred terminal is held (never lost) while owner input stays immediate',
    async () => {
      const { cli, conversation } = await startRig();
      await createOwner(conversation);

      const childLatches = [deferred(), deferred(), deferred(), deferred()];
      let launchNotes = 0;
      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [
            assistantBatchDelta([
              { id: 'call_st_1', background: true },
              { id: 'call_st_2', background: true },
              { id: 'call_st_3', background: true },
              { id: 'call_st_4', background: true },
            ]),
          ]);
          for (const callId of ['call_st_1', 'call_st_2', 'call_st_3', 'call_st_4']) {
            const result = await tool(input, 'task').impl.execute(
              callContext(input, callId),
              {
                agent_name: 'worker',
                description: `Child ${callId}`,
                prompt: `work ${callId}`,
                run_in_background: true,
              },
              input.signal,
            );
            launchNotes += 1;
            await deliverDelta(input, [toolResultDelta(callId, result.text ?? '')]);
          }
          await deliverDelta(input, [assistantReplyDelta('four launched')]);
        },
        ...childLatches.map((latch) => async (input: ScriptedTurnInput) => {
          await latch.promise;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'child finished'));
        }),
        // The follow-up owner turn after the steered input.
        async (input) => {
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'answered the user'));
          const consumed = await input.getSteeringMessages?.({ boundary: 'mid-turn' });
          void consumed;
        },
      ];

      const firstTurn = await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'launch four background tasks', attachments: [] },
      });
      await firstTurn.completion;
      expect(launchNotes).toBe(4);
      await waitFor(async () => childTurns().length === 4, 'four children started');
      await waitOwnerIdle(cli);

      // Three children finish SEQUENTIALLY, each on a fully idle session, so
      // each becomes its own autonomous wake: exactly the storm-guard budget.
      const rows: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const before = deliveryTurns().length;
        childLatches[index]!.resolve();
        await waitFor(
          () => deliveryTurns().length > before,
          `wake turn ${index + 1} for child ${index + 1}`,
          60_000,
        );
        rows.push((await subagentRows())[index]!.taskId);
        await waitOwnerIdle(cli);
      }
      expect(deliveryTurns()).toHaveLength(3);

      // The fourth terminal: the guard is exhausted, so the wake is deferred —
      // the terminal is HELD (undelivered, rescheduled), not lost, and the
      // scheduler does not storm retries (no wake within the hold).
      const wakesBefore = deliveryTurns().length;
      childLatches[3]!.resolve();
      await waitFor(
        async () => (await subagentRows()).every((row) => row.status === 'succeeded'),
        'fourth terminal persisted',
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(deliveryTurns()).toHaveLength(wakesBefore);
      const fourth = (await subagentRows()).find((row) => !rows.includes(row.taskId));
      expect(fourth?.deliveredAt).toBeUndefined();

      // Owner input while the completion budget is exhausted: accepted
      // immediately (the idle session starts its follow-up Turn), consumed by
      // the parent Turn — owner input is NEVER rate-limited by the completion
      // storm guard.
      const steerStartedAt = Date.now();
      const steer = await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-burst-owner-input',
        message: { content: 'the user asks something unrelated', attachments: [] },
      });
      expect(Date.now() - steerStartedAt).toBeLessThan(5_000);
      expect(['steered', 'activated']).toContain(steer.mode);
      await waitFor(async () => {
        const active = await cli.getActiveTurn(ownerSessionId);
        return active !== undefined;
      }, 'the owner follow-up turn started');
      await waitOwnerIdle(cli);
      const ownerSteers = steers.filter((entry) => entry.input.producerId !== 'background-task-delivery');
      expect(ownerSteers.length).toBeGreaterThanOrEqual(1);
      // The deferred completion never stole an admission: still exactly the
      // three wakes, held batch untouched.
      expect(deliveryTurns()).toHaveLength(wakesBefore);
      expect(fourth?.deliveredAt).toBeUndefined();
    },
    HOST_TIMEOUT_MS,
  );

  it(
    'owner override of §3.1: the wake envelope carries the result body — the model answers without task_output; an empty output omits the field; delivery stays idempotent',
    async () => {
      const { cli, conversation } = await startRig();
      await createOwner(conversation);

      const bodyChildLatch = deferred();
      harness.scripts = [
        // Parent: one run_in_background child; the turn ends while it runs.
        async (input) => {
          await deliverDelta(input, [assistantBatchDelta([{ id: 'call_body', background: true }])]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_body'),
            {
              agent_name: 'worker',
              description: 'Reporting child',
              prompt: 'work call_body',
              run_in_background: true,
            },
            input.signal,
          );
          expect(result.text ?? '').toContain('<task_background');
          await deliverDelta(input, [toolResultDelta('call_body', result.text ?? '')]);
          await deliverDelta(input, [assistantReplyDelta('launched')]);
        },
        // The child finishes WITH a report body.
        async (input) => {
          await bodyChildLatch.promise;
          await input.eventWriter.pushRuntime(
            assistantReplyEvent(input, 'REPORT-BODY-9f2a: the answer is 42'),
          );
        },
        // The wake Turn: the model answers straight from the envelope.
        async (input) => {
          await deliverDelta(input, [assistantReplyDelta('answered from the envelope')]);
        },
        // The second wake Turn (empty-output child): same shape.
        async (input) => {
          await deliverDelta(input, [assistantReplyDelta('noted the silent child')]);
        },
      ];

      const firstTurn = await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'launch one background task', attachments: [] },
      });
      await firstTurn.completion;
      await waitFor(async () => childTurns().length === 1, 'the child started');
      await waitOwnerIdle(cli);
      const rows = await subagentRows();
      expect(rows).toHaveLength(1);
      const bodyTaskId = rows[0]!.taskId;

      bodyChildLatch.resolve();
      await waitFor(() => deliveryTurns().length > 0, 'the wake turn for the reporting child', 60_000);
      expect(deliverySteers()).toHaveLength(1);
      const wakeEnvelope = deliverySteers()[0]!.input.message.content;
      // The envelope carries the FULL body from the task_output store — the
      // model does not need an extra task_output read to answer.
      expect(wakeEnvelope).toContain('<task_output>');
      expect(wakeEnvelope).toContain('REPORT-BODY-9f2a: the answer is 42');
      expect(wakeEnvelope).toContain('full output is included');
      expect(wakeEnvelope).not.toContain('Use task_output with each task_id to read the results');
      await waitOwnerIdle(cli);
      // The wake Turn really ran over the envelope: its reply is in the
      // canonical history, and the delivery was admitted as an activation.
      const ownerHistory = readPublishedCanonicalHistory(dataDir!, ownerSessionId);
      expect(ownerHistory).toContain('answered from the envelope');
      expect(deliverySteers()[0]!.result.mode).toBe('activated');

      // Delivery idempotency: re-scheduling the SAME terminal (a recovery-style
      // replay) never re-admits a second wake.
      scheduleLocalBackgroundTaskDelivery(host!.apiHost, bodyTaskId);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(deliveryTurns()).toHaveLength(1);
      expect(deliverySteers()).toHaveLength(1);

      // An EMPTY output keeps the legacy envelope: no <task_output> field.
      await host!.apiHost.backgroundTaskService.create({
        taskId: 'bg_empty_direct',
        ownerSessionId,
        kind: 'subagent',
        status: 'running',
        description: 'Silent child',
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      await persistLocalSubagentTaskTerminal({
        host: host!.apiHost,
        taskId: 'bg_empty_direct',
        result: {
          status: 'succeeded',
          requestedAgentName: 'worker',
          resolvedAgentName: 'worker',
          finalText: '',
        },
        delivery: 'schedule',
      });
      await waitFor(() => deliveryTurns().length > 1, 'the wake turn for the silent child', 60_000);
      const emptyEnvelope = deliverySteers()[1]!.input.message.content;
      expect(emptyEnvelope).toContain('task_id="bg_empty_direct"');
      expect(emptyEnvelope).not.toContain('<task_output>');
      expect(emptyEnvelope).toContain('Use task_output with each task_id to read the results');
      await waitOwnerIdle(cli);
      expect(deliveryTurns()).toHaveLength(2);
      void cli;
    },
    HOST_TIMEOUT_MS,
  );
});
