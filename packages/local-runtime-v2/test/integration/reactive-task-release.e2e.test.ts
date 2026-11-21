/**
 * Wave 2 vertical (verdict 09 §5.1 wave 2, §1.1–1.6/§1.8, §2, §4) over the
 * assembled V2 Runtime host — real ingress, real task runner, real steering
 * composition (durable default), real background-task store/delivery; only
 * the Pi runner is scripted. The parent script commits REAL canonical deltas
 * through the assembled history seam (`onHistoryChangedHook`), so the
 * tool-round round-trip of a released wait is exactly what production does.
 *
 * Acceptance criteria covered:
 * - №1: no intervention — one inline `<task_result>`, deliveredAt latched, no
 *   background wake, the row stays `foreground`.
 * - №2: owner input releases a parked foreground wait — the child keeps its
 *   session/turn/taskId and receives NO abort, the parent's next provider
 *   request (the requeued steering query) carries the user message AND the
 *   `<task_background reason="owner_input">` note BEFORE the child latch
 *   releases, and the row is promoted to `background` inside the release.
 *   №17 folds in here: the round closes with the KNOWN background outcome (no
 *   unknown/error substitution) and the follow-up turn starts cleanly.
 * - №6: both race orders — completion-first stays inline (delivery
 *   already-delivered, no wake); release-first returns the background note
 *   once and the late child terminal arrives as exactly one delivery wake.
 * - №8: machine deliveries (a sibling child's completion, a direct
 *   background-task-delivery steer) never release the foreground wait; the
 *   owner steer does.
 * - №13: user Stop after the release — the promoted child enters the stop
 *   cascade (canceled), old notifications do not wake the session, and a NEW
 *   task after the stop is not canceled by the old Stop.
 * - №14: task_stop targets one task — a released sibling stays running, and
 *   the stopped task's late child terminal never rewrites `canceled`.
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import {
  persistLocalSubagentTaskTerminal,
} from '../../../local-runtime/src/background-task/terminal.js';
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
  startedTurns: [] as { sessionId: string; turnId: string }[],
  observedContexts: [] as { turnId: string; sessionId: string; messages: readonly unknown[] }[],
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
        harness.observedContexts.push({
          turnId: input.turnId,
          sessionId: input.sessionId,
          messages: [],
        });
        const script = harness.scripts[index];
        if (script) await script(input);
        // The real runner's exit boundary: user steering is discarded through
        // the exit-close requeue (queue + wake), machine steering holds the
        // close until the poll consumes it. Reproduce one poll-and-retry.
        let close = await input.tryBeginClose?.();
        if (close && close.closed === false && close.reason === 'steer-pending') {
          await input.getSteeringMessages?.({ boundary: 'exit' });
          close = await input.tryBeginClose?.();
        }
        // An aborted Turn settles through its abort; pushing a synthetic
        // completed terminal into it would only park the event pipeline the
        // way no real runner ever would.
        if (!input.signal?.aborted) {
          await input.eventWriter.pushRuntime(
            terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'),
          );
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

/** Commits REAL canonical deltas through the assembled history seam. */
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

function assistantToolCallDelta(callId: string, prompt: string): Record<string, unknown> {
  return {
    role: 'assistant',
    // The provider-bound metadata every canonical assistant row carries (the
    // model projection normalizes against it).
    provider: 'test',
    api: 'openai-completions',
    model: 'model',
    content: [
      {
        type: 'toolCall',
        id: callId,
        name: 'task',
        arguments: {
          agent_name: 'worker',
          description: 'Long child',
          prompt,
        },
      },
    ],
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

/** A committed assistant message pushed over the turn's real event writer. */
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

/**
 * The per-call context exactly as the production pi adapter builds it
 * (`pi-turn-runner/tools.ts` merges `toolCallId` into the turn context).
 */
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

function abortedSignal(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) =>
    signal.addEventListener('abort', () => resolve(true), { once: true }),
  );
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let host: CreatedLocalRuntimeHost | undefined;
let dataDir: string | undefined;

/** Every steer the runtime ingress accepted, with the admission mode. */
const steers: Array<{
  readonly input: ConversationSteerInput;
  readonly result: { delivered: boolean; mode?: string; turnId?: string };
}> = [];
let ownerSessionId = '';

async function startRig(): Promise<{ cli: CliService; conversation: NonNullable<CreatedLocalRuntimeHost['apiHost']['runtimeConversation']> }> {
  dataDir = await mkdtemp(join(tmpdir(), 'reactive-task-release-'));
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
    ownsSystemLog: true,
    capabilityProfile: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(dataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
  const conversation = host.apiHost.runtimeConversation!;
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
  return { cli: host.cliService as CliService, conversation };
}

async function waitOwnerIdle(cli: CliService): Promise<void> {
  await waitFor(async () => (await cli.getActiveTurn(ownerSessionId)) === undefined, 'owner idle');
}

function ownerTurns(): readonly { sessionId: string; turnId: string }[] {
  return harness.startedTurns.filter((turn) => turn.sessionId === ownerSessionId);
}

function deliveryTurns(): readonly { sessionId: string; turnId: string }[] {
  return ownerTurns().filter((turn) => turn.turnId.startsWith('turn_task_delivery'));
}

function childTurns(): readonly { sessionId: string; turnId: string }[] {
  return harness.startedTurns.filter((turn) => turn.sessionId !== ownerSessionId);
}

async function nextOwnerTurnCount(previous: number): Promise<number> {
  await waitFor(async () => ownerTurns().length > previous, 'next owner turn');
  return ownerTurns().length;
}

afterEach(async () => {
  await host?.apiHost.close().catch(() => undefined);
  await host?.metricsClient.close().catch(() => undefined);
  if (dataDir) {
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  host = undefined;
  dataDir = undefined;
  harness.scripts = [];
  harness.invocations = 0;
  harness.startedTurns = [];
  harness.observedContexts = [];
  steers.length = 0;
  ownerSessionId = '';
});

const HOST_TIMEOUT_MS = 240_000;

describe('reactive foreground task release over the production host', () => {
  it(
    '№1: without intervention the foreground task completes inline — one task_result, no background wake',
    async () => {
      const { cli, conversation } = await startRig();
      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir!, 'workspace'),
        sessionType: 'root',
      });
      ownerSessionId = owner.sessionId;

      let toolText = '';
      harness.scripts = [
        // Parent: one foreground task call; the child finishes on its own.
        async (input) => {
          await deliverDelta(input, [assistantToolCallDelta('call_no', 'short work')]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_no'),
            { agent_name: 'worker', description: 'Short child', prompt: 'answer quickly' },
            input.signal,
          );
          toolText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_no', toolText)]);
          await deliverDelta(input, [assistantReplyDelta('integrated the child answer')]);
        },
        // Child: completes immediately.
        async (input) => {
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'child done'));
        },
      ];

      const firstTurn = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'run one quick task', attachments: [] },
      });
      await firstTurn.completion;

      expect(toolText).toContain('<task_result');
      expect(toolText).toContain('child done');
      expect(toolText).not.toContain('<task_background');

      // The runner adopted exactly one child turn and the parent kept its own.
      expect(childTurns()).toHaveLength(1);
      expect(ownerTurns()).toHaveLength(1);

      await waitOwnerIdle(cli);
      // Give any (wrong) background delivery a chance to wake the session.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(deliveryTurns()).toEqual([]);
      expect(steers).toEqual([]);
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№2+№17: owner input releases the parked wait — the child keeps its identity un-aborted, the next provider request carries message + note, the row is promoted',
    async () => {
      const { cli, conversation } = await startRig();
      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir!, 'workspace'),
        sessionType: 'root',
      });
      ownerSessionId = owner.sessionId;

      const childLatch = deferred();
      const childStateAtLatch = { aborted: false, turnId: '' };
      let toolText = '';
      const toolReturned = deferred();

      harness.scripts = [
        // Parent: park inside the task tool until the release returns the note.
        async (input) => {
          await deliverDelta(input, [assistantToolCallDelta('call_bg', 'long work')]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_bg'),
            { agent_name: 'worker', description: 'Long child', prompt: 'work until told' },
            input.signal,
          );
          toolText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_bg', toolText)]);
          await deliverDelta(input, [assistantReplyDelta('answering the new message')]);
          toolReturned.resolve();
        },
        // Child: blocked on the test latch; records its abort state at that point.
        async (input) => {
          childStateAtLatch.turnId = input.turnId;
          await childLatch.promise;
          childStateAtLatch.aborted = input.signal?.aborted ?? false;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'child finished later'));
        },
      ];

      await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'start the long task', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child turn started');
      const ownerTurnsBefore = ownerTurns().length;

      // The owner message while the parent is parked on the task tool.
      const steer = await conversation.ingress.steer({
        sessionId: owner.sessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-release-1',
        message: { content: 'the new user instruction', attachments: [] },
      });
      // The ingress receipt: a steered join carries the parked parent turn's id.
      expect(steer).toEqual({ mode: 'steered', turnId: ownerTurns()[0]?.turnId });

      await toolReturned.promise;
      // The single release receipt: the §2.2 note, never a second inline result.
      expect(toolText).toContain('<task_background');
      expect(toolText).toContain('reason="owner_input"');
      expect(toolText).toContain('The user sent a new message, so this task was moved to the background.');
      expect(toolText).not.toContain('<task_result');

      const taskId = childTurns().length === 1 ? await findRunningTaskId() : '';
      const task = await host!.apiHost.backgroundTaskService.get(taskId);
      // §1.5: the promotion happened inside the committed release pass.
      expect(task?.metadata?.['executionMode']).toBe('background');
      expect(typeof task?.metadata?.['releasedFromForegroundAtMs']).toBe('number');
      expect(task?.status).toBe('running');
      // The child kept its identity and received no cancellation while parked.
      expect(task?.metadata?.['subTurnId']).toBe(childStateAtLatch.turnId);
      expect(childStateAtLatch.aborted).toBe(false);

      // The parent made its next provider request — the requeued steering
      // query started while the child latch is STILL held (№2 ordering fact:
      // the released parent continues against the new input before the child
      // finishes), and the child still owns its original turn id.
      await nextOwnerTurnCount(ownerTurnsBefore);
      const followUp = harness.startedTurns.slice(ownerTurnsBefore).find(
        (turn) => turn.sessionId === ownerSessionId,
      );
      expect(followUp).toBeDefined();
      expect(childStateAtLatch.aborted).toBe(false);
      expect(childTurns().length).toBe(1);

      // Now the child finishes; its terminal is delivered automatically (wake).
      childLatch.resolve();
      await waitFor(
        async () => ((await host!.apiHost.backgroundTaskService.get(taskId))?.status) === 'succeeded',
        'child terminal persisted',
      );
      await waitFor(() => deliveryTurns().length > 0, 'background delivery wake', 60_000);

      // №17: the released tool round was closed by the KNOWN background
      // outcome — the follow-up turn started cleanly over the durable history
      // (an unknown/error substitution or an open round would have failed the
      // turn above). The only extra owner turns are the follow-up query and
      // the single automatic delivery wake.
      expect(ownerTurns().length).toBe(ownerTurnsBefore + 2);
      expect(deliveryTurns()).toHaveLength(1);
      void cli;
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№6: completion-first stays inline with no wake; release-first returns the note once and wakes once',
    async () => {
      const { cli, conversation } = await startRig();
      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir!, 'workspace'),
        sessionType: 'root',
      });
      ownerSessionId = owner.sessionId;

      // --- completion-first: the child finishes before any owner input. ---
      let inlineText = '';
      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [assistantToolCallDelta('call_race_a', 'race a')]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_race_a'),
            { agent_name: 'worker', description: 'Race A', prompt: 'finish fast' },
            input.signal,
          );
          inlineText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_race_a', inlineText)]);
        },
        async (input) => {
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'race a child done'));
        },
      ];
      const firstTurn = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'race completion first', attachments: [] },
      });
      await firstTurn.completion;
      expect(inlineText).toContain('<task_result');
      expect(inlineText).not.toContain('<task_background');
      const raceATaskId = await findRunningTaskId('succeeded');
      expect((await host!.apiHost.backgroundTaskService.get(raceATaskId))?.deliveredAt).toBeDefined();
      await waitOwnerIdle(cli);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // The inline result was the delivery: no background wake for it.
      expect(deliveryTurns()).toEqual([]);
      expect(steers.filter((entry) => entry.input.producerId === 'background-task-delivery')).toEqual([]);
      const steersBeforeReleaseLeg = steers.length;

      // --- release-first: owner input wins, the late terminal wakes once. ---
      const childLatch = deferred();
      let releaseText = '';
      const releaseReturned = deferred();
      harness.scripts.push(
        // Second parent turn: parks on the task tool again.
        async (input) => {
          await deliverDelta(input, [assistantToolCallDelta('call_race_b', 'race b')]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_race_b'),
            { agent_name: 'worker', description: 'Race B', prompt: 'finish late' },
            input.signal,
          );
          releaseText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_race_b', releaseText)]);
          releaseReturned.resolve();
        },
        async (input) => {
          await childLatch.promise;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'race b child done'));
        },
      );
      const ownerTurnsBeforeSecond = ownerTurns().length;
      const secondTurn = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'race release first', attachments: [] },
      });
      void secondTurn;
      await waitFor(async () => childTurns().length > 1, 'second child started');
      await conversation.ingress.steer({
        sessionId: owner.sessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-release-2',
        message: { content: 'release race b', attachments: [] },
      });
      await releaseReturned.promise;
      expect(releaseText).toContain('<task_background');
      expect(releaseText).toContain('reason="owner_input"');
      // Race A is already terminal, so race B is the only active row.
      const raceBTaskId = await findRunningTaskId('running');
      childLatch.resolve();
      await waitFor(
        async () => ((await host!.apiHost.backgroundTaskService.get(raceBTaskId))?.status) === 'succeeded',
        'race b terminal',
      );
      // Exactly ONE delivery admission for the late terminal. It may join the
      // still-active follow-up turn (mode steered) instead of waking an idle
      // session — either way it is admitted exactly once.
      await waitFor(
        () => steers.slice(steersBeforeReleaseLeg).filter((entry) => entry.input.producerId === 'background-task-delivery').length > 0,
        'race b delivery admission',
        60_000,
      );
      expect(
        steers.slice(steersBeforeReleaseLeg).filter((entry) => entry.input.producerId === 'background-task-delivery'),
      ).toHaveLength(1);
      void ownerTurnsBeforeSecond;
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№8: sibling completion and machine deliveries never release the parked wait; the owner steer does',
    async () => {
      const { conversation } = await startRig();
      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir!, 'workspace'),
        sessionType: 'root',
      });
      ownerSessionId = owner.sessionId;

      const childLatch = deferred();
      let toolText = '';
      const toolReturned = deferred();
      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [assistantToolCallDelta('call_hold', 'hold')]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_hold'),
            { agent_name: 'worker', description: 'Held child', prompt: 'hold' },
            input.signal,
          );
          toolText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_hold', toolText)]);
          toolReturned.resolve();
        },
        async (input) => {
          await childLatch.promise;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'held child done'));
        },
      ];
      await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'start held task', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child started');
      const heldTaskId = await findRunningTaskId();

      // A sibling background child completes while the parent is parked: its
      // notification joins the ACTIVE owner turn and must NOT release the wait.
      const siblingId = 'bg_sibling_1';
      await host!.apiHost.backgroundTaskService.create({
        taskId: siblingId,
        ownerSessionId,
        kind: 'subagent',
        status: 'running',
        description: 'sibling',
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      await persistLocalSubagentTaskTerminal({
        host: host!.apiHost,
        taskId: siblingId,
        result: {
          status: 'succeeded',
          requestedAgentName: 'worker',
          resolvedAgentName: 'worker',
          finalText: 'sibling done',
        },
        delivery: 'schedule',
      });
      await waitFor(
        () => steers.some((entry) => entry.input.producerId === 'background-task-delivery'),
        'sibling delivery steered',
      );
      const siblingSteer = steers.find((entry) => entry.input.producerId === 'background-task-delivery');
      // The notification JOINED the live owner turn (mode steered) — it never
      // releases the parked foreground wait.
      expect(siblingSteer?.result).toEqual({ mode: 'steered', turnId: ownerTurns()[0]?.turnId });
      expect(toolText).toBe('');

      // A direct machine steer likewise never releases.
      await conversation.ingress.steer({
        sessionId: owner.sessionId,
        source: 'background-task',
        producerId: 'background-task-delivery',
        idempotencyKey: 'batch-machine-1',
        message: { content: '<background-task-finished>machine</background-task-finished>', attachments: [], hideUserMessage: true },
      });
      expect(toolText).toBe('');
      expect((await host!.apiHost.backgroundTaskService.get(heldTaskId))?.metadata?.['executionMode']).toBe('foreground');

      // The OWNER steer releases.
      await conversation.ingress.steer({
        sessionId: owner.sessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-release-3',
        message: { content: 'owner releases', attachments: [] },
      });
      await toolReturned.promise;
      expect(toolText).toContain('<task_background');
      expect((await host!.apiHost.backgroundTaskService.get(heldTaskId))?.metadata?.['executionMode']).toBe('background');

      // No wake happened for either machine event: they joined the live turn.
      expect(deliveryTurns()).toEqual([]);
      // Let the held child finish so the host teardown is clean.
      childLatch.resolve();
      await waitFor(
        async () => ((await host!.apiHost.backgroundTaskService.get(heldTaskId))?.status) === 'succeeded',
        'held child terminal after the release',
      );
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№13: user Stop after the release cascades the promoted child, suppresses wakes, and spares the next task',
    async () => {
      const { cli, conversation } = await startRig();
      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir!, 'workspace'),
        sessionType: 'root',
      });
      ownerSessionId = owner.sessionId;

      const childLatch = deferred();
      const toolReturned = deferred();
      const childAbortObserved = deferred<boolean>();
      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [assistantToolCallDelta('call_stop', 'stop me later')]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_stop'),
            { agent_name: 'worker', description: 'Stopped child', prompt: 'work' },
            input.signal,
          );
          void result;
          await deliverDelta(input, [
            toolResultDelta('call_stop', result.text ?? '', result.isError === true),
          ]);
          toolReturned.resolve();
        },
        async (input) => {
          const aborted = await Promise.race([
            childLatch.promise.then(() => false),
            (input.signal
              ? new Promise<boolean>((resolve) =>
                  input.signal!.addEventListener('abort', () => resolve(true), { once: true }),
                )
              : Promise.resolve(false)),
          ]);
          childAbortObserved.resolve(aborted);
          if (!aborted) {
            await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'stop child done'));
          }
        },
      ];
      await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'start then stop', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child started');
      const stoppedTaskId = await findRunningTaskId();

      // Release to the background, then stop the session.
      await conversation.ingress.steer({
        sessionId: owner.sessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-before-stop',
        message: { content: 'move on', attachments: [] },
      });
      await toolReturned.promise;
      expect((await host!.apiHost.backgroundTaskService.get(stoppedTaskId))?.metadata?.['executionMode']).toBe('background');

      await conversation.ingress.abort(owner.sessionId, 'user_stop');
      // The promoted child entered the stop cascade.
      const childAborted = await childAbortObserved.promise;
      expect(childAborted).toBe(true);
      await waitFor(
        async () => ((await host!.apiHost.backgroundTaskService.get(stoppedTaskId))?.status) === 'canceled',
        'promoted child canceled by the cascade',
      );

      // Old pending notifications must not wake the stopped session.
      // Old pending notifications must not wake the stopped session: outwait
      // the delivery retry window and require zero delivery turns. (The
      // aborted turn's own user steering returns through the pre-existing
      // requeue machinery — a lost user message would be worse — so the turn
      // COUNT is not a wake signal here; the DELIVERY turns are.)
      await new Promise((resolve) => setTimeout(resolve, 9_000));
      expect(deliveryTurns()).toEqual([]);

      // A NEW task after the stop is not canceled by the old Stop.
      await waitOwnerIdle(cli);
      let freshText = '';
      // Index alignment: invocation 2 was the requeued steering turn.
      harness.scripts[2] = async () => undefined;
      harness.scripts.push(
        async (input) => {
          await deliverDelta(input, [assistantToolCallDelta('call_fresh', 'fresh work')]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_fresh'),
            { agent_name: 'worker', description: 'Fresh child', prompt: 'quick' },
            input.signal,
          );
          freshText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_fresh', freshText)]);
        },
        async (input) => {
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'fresh child done'));
        },
      );
      const freshTurn = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'fresh task after stop', attachments: [] },
      });
      await freshTurn.completion;
      expect(freshText).toContain('<task_result');
      const freshTaskId = await findRunningTaskId('succeeded');
      expect((await host!.apiHost.backgroundTaskService.get(freshTaskId))?.status).toBe('succeeded');
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№14: task_stop targets one released task; siblings keep running; the late terminal never rewrites canceled',
    async () => {
      const { conversation } = await startRig();
      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir!, 'workspace'),
        sessionType: 'root',
      });
      ownerSessionId = owner.sessionId;

      const heldLatch = deferred();
      const stopLatch = deferred();
      const toolReturned = deferred();
      harness.scripts = [
        async (input) => {
          // The parent starts TWO children: one foreground (released later,
          // then stopped) and one explicit background sibling.
          const sibling = await tool(input, 'task').impl.execute(
            callContext(input, 'call_sib'),
            { agent_name: 'worker', description: 'Sibling', prompt: 'keep running', run_in_background: true },
            input.signal,
          );
          expect(sibling.text ?? '').toContain('<task_background');
          await deliverDelta(input, [assistantToolCallDelta('call_held', 'held')]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_held'),
            { agent_name: 'worker', description: 'Held', prompt: 'hold' },
            input.signal,
          );
          void result;
          await deliverDelta(input, [
            toolResultDelta('call_held', result.text ?? '', result.isError === true),
          ]);
          toolReturned.resolve();
        },
        // First child turn: the released task's child, latched. A task_stop
        // aborts this Turn before the latch resolves — the script must wake on
        // the abort (the executor waits for the runner) and return honestly.
        async (input) => {
          await Promise.race([
            heldLatch.promise,
            input.signal ? abortedSignal(input.signal) : Promise.resolve(),
          ]);
          if (input.signal?.aborted) return;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'held done'));
        },
        // Second child turn: the sibling, latched independently.
        async (input) => {
          await Promise.race([
            stopLatch.promise,
            input.signal ? abortedSignal(input.signal) : Promise.resolve(),
          ]);
          if (input.signal?.aborted) return;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'sibling done'));
        },
      ];
      await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'two children', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 1, 'both children started');
      const heldTaskId = await findRunningTaskId();
      const siblingTaskId = await findRunningTaskId('running', 2);

      // Release the foreground wait, then task_stop THAT one task.
      await conversation.ingress.steer({
        sessionId: owner.sessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-before-stop-14',
        message: { content: 'release for stop test', attachments: [] },
      });
      await toolReturned.promise;
      await host!.apiHost.backgroundTaskService.stop(heldTaskId, 'task_stop');
      await waitFor(
        async () => ((await host!.apiHost.backgroundTaskService.get(heldTaskId))?.status) === 'canceled',
        'held task canceled',
      );
      // The sibling was not touched.
      expect((await host!.apiHost.backgroundTaskService.get(siblingTaskId))?.status).toBe('running');

      // The stopped child's late terminal arrives and must NOT rewrite
      // `canceled` (output backfill only).
      heldLatch.resolve();
      await waitFor(
        async () => {
          const task = await host!.apiHost.backgroundTaskService.get(heldTaskId);
          return task?.status === 'canceled' && task.outputRef !== undefined;
        },
        'late terminal backfilled without rewriting canceled',
      );
      expect((await host!.apiHost.backgroundTaskService.get(heldTaskId))?.status).toBe('canceled');

      stopLatch.resolve();
    },
    HOST_TIMEOUT_MS,
  );

  it(
    'owner input releases a parked task_output wait — the read returns early in the SAME turn and the later terminal still wakes exactly once',
    async () => {
      const { cli, conversation } = await startRig();
      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir!, 'workspace'),
        sessionType: 'root',
      });
      ownerSessionId = owner.sessionId;

      // A plain running subagent row the parent will park a task_output read on.
      const waitTaskId = 'bg_output_wait_1';
      await host!.apiHost.backgroundTaskService.create({
        taskId: waitTaskId,
        ownerSessionId,
        kind: 'subagent',
        status: 'running',
        description: 'Parked-read child',
        createdAt: 1_000,
        updatedAt: 1_000,
      });

      const toolReturned = deferred<{
        elapsedMs: number;
        text: string;
        details: Record<string, unknown> | undefined;
        drainedSteering: readonly unknown[];
      }>();
      // The script signals right before the blocking call so the steer cannot
      // race the read's baseline capture (an earlier bump would be absorbed
      // into the baseline and the read would legitimately run to its bound).
      const parking = deferred();

      harness.scripts = [
        // Parent: one blocking task_output read; the owner input arrives while
        // it is parked, the owner-input wake releases it, and the SAME turn
        // drains the steer and answers.
        async (input) => {
          await deliverDelta(input, [
            {
              role: 'assistant',
              provider: 'test',
              api: 'openai-completions',
              model: 'model',
              content: [
                {
                  type: 'toolCall',
                  id: 'call_wait',
                  name: 'task_output',
                  arguments: { task_id: waitTaskId, wait_ms: 30_000 },
                },
              ],
              timestamp: T,
            },
          ]);
          parking.resolve();
          const startedAt = Date.now();
          const result = await tool(input, 'task_output').impl.execute(
            callContext(input, 'call_wait'),
            { task_id: waitTaskId, wait_ms: 30_000 },
            input.signal,
          );
          const elapsedMs = Date.now() - startedAt;
          // The steer reaches the model in this same turn: drain the real
          // steering query (the released read no longer hides it behind the wait).
          const drainedSteering: unknown[] = [];
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const messages = (await input.getSteeringMessages?.()) ?? [];
            if (messages.length > 0) {
              drainedSteering.push(...messages);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await deliverDelta(input, [
            {
              role: 'toolResult',
              toolCallId: 'call_wait',
              toolName: 'task_output',
              content: [{ type: 'text', text: result.text ?? '' }],
              timestamp: T + 1,
            },
          ]);
          await deliverDelta(input, [assistantReplyDelta('answered the new message')]);
          toolReturned.resolve({
            elapsedMs,
            text: result.text ?? '',
            details: result.details as Record<string, unknown> | undefined,
            drainedSteering,
          });
        },
      ];

      await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'wait for the child output', attachments: [] },
      });
      await waitFor(() => harness.observedContexts.length > 0, 'owner turn started');
      const ownerTurnId = ownerTurns()[0]?.turnId ?? '';
      // The read is (about to be) parked inside the tool call.
      await parking.promise;
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The owner message while the read is parked. The accepted input bumps
      // the §1.7 generation; the wake releases the read at the probe slice.
      const steer = await conversation.ingress.steer({
        sessionId: owner.sessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-wait-release-1',
        message: { content: 'the new user instruction', attachments: [] },
      });
      expect(steer).toEqual({ mode: 'steered', turnId: ownerTurnId });

      const outcome = await toolReturned.promise;
      // Released at the probe slice (~250 ms), never near the 30 s bound, and
      // an ordinary tool result — not a backgrounded round.
      expect(outcome.elapsedMs).toBeLessThan(20_000);
      expect(outcome.text).toContain('<task_output status="running">');
      expect(outcome.text).toContain(
        'The user sent a new message while this read was waiting, so the wait returned early with the output so far.',
      );
      expect(outcome.details).toMatchObject({
        task_id: waitTaskId,
        status: 'running',
        released: 'owner_input',
        timed_out: false,
      });
      // canon 09: the steered input was delivered into the active turn.
      expect(
        outcome.drainedSteering.some((message) =>
          JSON.stringify(message).includes('the new user instruction'),
        ),
      ).toBe(true);
      // No requeue turn was needed: the same turn consumed the steer.
      expect(ownerTurns().length).toBe(1);

      // The early read consumed nothing: the later terminal still wakes the
      // conversation exactly once, with the full result body on board.
      await persistLocalSubagentTaskTerminal({
        host: host!.apiHost,
        taskId: waitTaskId,
        result: {
          status: 'succeeded',
          requestedAgentName: 'worker',
          resolvedAgentName: 'worker',
          finalText: 'the late child report',
        },
        delivery: 'schedule',
      });
      await waitFor(() => deliveryTurns().length > 0, 'background delivery wake', 60_000);
      const deliverySteer = steers.find(
        (entry) => entry.input.producerId === 'background-task-delivery',
      );
      expect(deliverySteer).toBeDefined();
      expect(String(deliverySteer?.input.message.content)).toContain('the late child report');
      expect(String(deliverySteer?.input.message.content)).toContain('<task_output>');
      await waitOwnerIdle(cli);
      expect(deliveryTurns()).toHaveLength(1);
    },
    HOST_TIMEOUT_MS,
  );
});

/** Finds the running (or given-status) subagent task row of this test. */
async function findRunningTaskId(status = 'running', occurrence = 1): Promise<string> {
  let found = '';
  await waitFor(async () => {
    const list = await host!.apiHost.backgroundTaskService.list({
      ownerSessionId,
      statuses: status === 'running' ? ['queued', 'running', 'stopping'] : [status as never],
      limit: 50,
    });
    const candidates = list.items.filter((task) => task.kind === 'subagent');
    const target = candidates[occurrence - 1];
    if (!target) return false;
    found = target.taskId;
    return true;
  }, `task row (${status}, #${occurrence})`);
  return found;
}
