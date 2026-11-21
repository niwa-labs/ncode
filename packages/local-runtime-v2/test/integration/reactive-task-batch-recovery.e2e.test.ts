/**
 * Wave 3 verticals (verdict 09 §1.7/§1.8/§5.1 wave 3, §5.4) over the
 * assembled V2 Runtime host — real ingress, real task runner, real steering
 * composition (durable default), real background-task store/delivery; only
 * the Pi runner is scripted. Same rig contract as the wave-2
 * `reactive-task-release.e2e.test.ts`: the parent script commits REAL
 * canonical deltas through the assembled history seam.
 *
 * Acceptance criteria covered:
 * - №4 (+№17 on the new path): sequential batch A/B/C — A is parked on the
 *   child, the owner input releases A, and the not-yet-started B/C receive
 *   honest skipped outcomes ("not started because new user input was
 *   accepted"), with NO child, NO task row and NO taskId minted for them;
 *   the parent answers the accepted input BEFORE B/C could start; every
 *   toolCall is closed, the round reads cleanly and the NEXT turn starts
 *   over it (brick regression of the yield path).
 * - №5: input during setup — the owner input is accepted while
 *   `createSession` is still latched; the late `registerNativeTaskWait`
 *   replays the DURABLE release intent, the child starts exactly once and
 *   continues in the background; no orphan sessions/promises; the input is
 *   consumed in the same turn.
 * - №7: two distinct owner replicas are kept in ingress order (both reach
 *   the parent), a duplicate RPC of the first one answers `duplicate`
 *   without re-delivering and re-runs the (idempotent, empty) release pass;
 *   the released tool returns exactly one note.
 * - №16a: crash rupture "seam finalize before the canonical result" — after
 *   a restart the recovery join closes the parent's open round with the
 *   KNOWN §2.2 background note from the seam, exactly once (a second
 *   restart writes no second tool-result), and the next turn over it passes
 *   the brick gate.
 * - №16b: crash rupture "terminal persist before the delivery enqueue" —
 *   the notification a dead process lost is re-scheduled at startup and
 *   wakes the session.
 * - №16c: crash rupture "admission ACK before consumption" — the accepted
 *   input stays a durable, inspectable fact (the seam delivery index), a
 *   duplicate RPC replays safely after the restart, and nothing relaunches.
 * - Shutdown honesty (§4): a graceful `close()` while a released child still
 *   runs drains it and leaves an honest terminal row — never a lost
 *   execution, never a fabricated success.
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
import { openUserStopWindow } from '../../../local-runtime/src/background-task/user-stop-suppression.js';

// The rig reads the PUBLISHED canonical history (messages.jsonl) — the
// continuous durable-jsonl publisher (I-PUB-1) keeps it current at every
// turn release and history mutation. Compatibility readers off by default.
process.env.MCODE_PUBLISH_JSONL = 'on';
import { createLocalRuntimeHostV2ForTest } from '../../src/runtime.js';
import type { CliService } from '../../src/local/cli-service.js';

interface ScriptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userMessage: { readonly text: string };
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
  startedTurns: [] as { sessionId: string; turnId: string; text: string }[],
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
          text: input.userMessage.text,
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

function assistantBatchDelta(calls: readonly { id: string; prompt: string }[]): Record<string, unknown> {
  return {
    role: 'assistant',
    provider: 'test',
    api: 'openai-completions',
    model: 'model',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: 'task',
      arguments: { agent_name: 'worker', description: `Child ${call.id}`, prompt: call.prompt },
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let host: CreatedLocalRuntimeHost | undefined;
let dataDir: string | undefined;
/** The dataDir persists across a simulated restart within one test. */
let persistentDir: string | undefined;

const steers: Array<{
  readonly input: ConversationSteerInput;
  readonly result: { delivered: boolean; mode?: string; turnId?: string };
}> = [];
let ownerSessionId = '';

async function createHost(hostDataDir: string): Promise<CreatedLocalRuntimeHost> {
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
    ownsSystemLog: true,
    capabilityProfile: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(hostDataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
}

async function startRig(): Promise<{
  cli: CliService;
  conversation: NonNullable<CreatedLocalRuntimeHost['apiHost']['runtimeConversation']>;
}> {
  dataDir = await mkdtemp(join(tmpdir(), 'reactive-task-batch-'));
  persistentDir = dataDir;
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  host = await createHost(dataDir);
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

/** Restarts the runtime over the SAME dataDir (the crash-recovery rig). */
async function restartHost(): Promise<{
  cli: CliService;
  conversation: NonNullable<CreatedLocalRuntimeHost['apiHost']['runtimeConversation']>;
}> {
  await closeHost();
  await new Promise((resolve) => setTimeout(resolve, 300));
  dataDir = persistentDir;
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  harness.invocations = 0;
  harness.scripts = [];
  host = await createHost(dataDir);
  return { cli: host.cliService as CliService, conversation: host.apiHost.runtimeConversation! };
}

async function closeHost(): Promise<void> {
  await host?.apiHost.close().catch(() => undefined);
  await host?.metricsClient.close().catch(() => undefined);
  host = undefined;
}

async function waitOwnerIdle(cli: CliService): Promise<void> {
  await waitFor(async () => (await cli.getActiveTurn(ownerSessionId)) === undefined, 'owner idle');
}

function ownerTurns() {
  return harness.startedTurns.filter((turn) => turn.sessionId === ownerSessionId);
}

function childTurns(): readonly { sessionId: string; turnId: string }[] {
  return harness.startedTurns.filter((turn) => turn.sessionId !== ownerSessionId);
}

afterEach(async () => {
  await closeHost();
  const dir = persistentDir;
  if (dir) {
    closeLocalRuntimeDb(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  dataDir = undefined;
  persistentDir = undefined;
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

/**
 * Every canonical envelope the durable log holds for the session (all entry
 * kinds) — the CANONICAL reader, unlike the display-level `cli.getMessages`.
 */
function readPublishedCanonicalHistory(hostDataDir: string, sessionId: string): string {
  // The layout encodes the session id in the leaf directory name
  // (`<time>-session_<base64>`), so match either the raw or the encoded id.
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
        isDirectory = false;
      }
      if (isDirectory) stack.push(full);
    }
  }
  if (found.length === 0) {
    throw new Error(`no published canonical history found for ${sessionId}`);
  }
  return found.map((file) => readFileSync(file, 'utf8')).join('\n');
}

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

describe('reactive subagents wave 3 over the production host', () => {
  it(
    '№4+№17: sequential batch A/B/C — A released, B/C honest skips without children, parent answers before B/C could start, the next turn reads cleanly',
    async () => {
      const { cli, conversation } = await startRig();
      await createOwner(conversation);

      const childLatch = deferred();
      const toolReturned = deferred();
      let noteText = '';
      let followUpAnswerCommitted = false;
      const childAborted = deferred<boolean>();

      harness.scripts = [
        // Parent: ONE assistant message with THREE task calls — the `task`
        // tool is sequential, so the batch executes A → B → C in order.
        async (input) => {
          await deliverDelta(input, [
            assistantBatchDelta([
              { id: 'call_a', prompt: 'long work' },
              { id: 'call_b', prompt: 'blind work b' },
              { id: 'call_c', prompt: 'blind work c' },
            ]),
          ]);
          const resultA = await tool(input, 'task').impl.execute(
            callContext(input, 'call_a'),
            { agent_name: 'worker', description: 'Child A', prompt: 'work until told' },
            input.signal,
          );
          noteText = resultA.text ?? '';
          // The release returned A's background note; the executor yielded:
          // B and C were NOT started — their honest skipped outcomes close
          // the round exactly as the pin seam emits them.
          await deliverDelta(input, [toolResultDelta('call_a', noteText)]);
          await deliverDelta(input, [
            toolResultDelta(
              'call_b',
              'Tool call "task" was not started because new user input was accepted while this batch was running; reconsider this call against the new instruction and issue it again if it is still needed.',
              true,
            ),
            toolResultDelta(
              'call_c',
              'Tool call "task" was not started because new user input was accepted while this batch was running; reconsider this call against the new instruction and issue it again if it is still needed.',
              true,
            ),
          ]);
          // The parent consumes the accepted input IN THIS TURN (the yield
          // boundary continues to the steering drain — the model turn is not
          // ended) and answers it.
          const consumed = await input.getSteeringMessages?.({ boundary: 'mid-turn' });
          expect(consumed?.length).toBe(1);
          await deliverDelta(input, [assistantReplyDelta('answering the new instruction')]);
          followUpAnswerCommitted = true;
          toolReturned.resolve();
        },
        async (input) => {
          const aborted = await Promise.race([
            childLatch.promise.then(() => false),
            new Promise<boolean>((resolve) => {
              if (input.signal?.aborted) resolve(true);
              else input.signal?.addEventListener('abort', () => resolve(true), { once: true });
            }),
          ]);
          childAborted.resolve(aborted);
          if (!aborted) {
            await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'child A finished later'));
          }
        },
      ];

      await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'run three tasks', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child A started');
      const steerPromise = conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-batch-release',
        message: { content: 'the new user instruction', attachments: [] },
      });
      await toolReturned.promise;
      const steer = await steerPromise;
      expect(steer).toEqual({ mode: 'steered', turnId: ownerTurns()[0]?.turnId });

      // A's single result is the §2.2 note; the child kept its identity.
      expect(noteText).toContain('<task_background');
      expect(noteText).toContain('reason="owner_input"');
      expect(noteText).not.toContain('<task_result');
      // B and C never started: exactly one child, exactly one task row —
      // no phantom child, no taskId minted for the skipped calls.
      expect(childTurns()).toHaveLength(1);
      const rows = await host!.apiHost.backgroundTaskService.list({
        ownerSessionId,
        limit: 50,
      });
      const subagentRows = rows.items.filter((task) => task.kind === 'subagent');
      expect(subagentRows).toHaveLength(1);
      expect(subagentRows[0]?.metadata?.['executionMode']).toBe('background');

      // №17 (yield path): the released tool round closed with the KNOWN
      // outcomes; the parent's answer is committed and the turn ends.
      expect(followUpAnswerCommitted).toBe(true);
      await waitOwnerIdle(cli);
      const canonical = JSON.stringify(readPublishedCanonicalHistory(persistentDir!, ownerSessionId));
      expect(canonical).toContain('answering the new instruction');
      expect(canonical).toContain('<task_background');
      // №4: the whole batch is closed — one real note and two honest skips.
      expect((canonical.match(/<task_background/g) ?? []).length).toBe(1);
      expect((canonical.match(/not started because new user input was accepted/g) ?? []).length).toBe(2);
      void childAborted;

      // The child finishes; its terminal wakes the session once.
      childLatch.resolve();
      const taskId = subagentRows[0]!.taskId;
      await waitFor(
        async () => (await host!.apiHost.backgroundTaskService.get(taskId))?.status === 'succeeded',
        'child A terminal',
      );
      await waitFor(
        () => steers.some((entry) => entry.input.producerId === 'background-task-delivery'),
        'background delivery wake',
        60_000,
      );

      // The NEXT turn over the settled history (one real + two skipped
      // results) starts and completes cleanly — the brick gate holds.
      await waitOwnerIdle(cli);
      harness.scripts[harness.invocations] = async (input) => {
        await deliverDelta(input, [assistantReplyDelta('next turn reply', T + 9)]);
        await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'next turn reply'));
      };
      const nextTurn = await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'continue after the wake', attachments: [] },
      });
      await nextTurn.completion;
      const canonicalAfter = JSON.stringify(readPublishedCanonicalHistory(persistentDir!, ownerSessionId));
      expect(canonicalAfter).toContain('next turn reply');
      await waitOwnerIdle(cli);
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№5: input accepted during setup — the late wait registration replays the durable release, the child starts once in the background',
    async () => {
      const { cli, conversation } = await startRig();
      await createOwner(conversation);

      const setupReached = deferred();
      const releaseSetup = deferred();
      const childStarted = deferred();
      const childLatch = deferred();
      const childAbortObserved = deferred<boolean>();
      let noteText = '';
      const toolReturned = deferred();

      // Barrier INSIDE the task setup: createSession is the step between the
      // admitted task row and the wait registration.
      const agentRoutes = host!.apiHost.agentRoutes as unknown as {
        createSession: (input: Record<string, unknown>) => Promise<unknown>;
      };
      const originalCreate = agentRoutes.createSession.bind(agentRoutes);
      agentRoutes.createSession = async (input: Record<string, unknown>) => {
        if (String(input.purpose ?? '').startsWith('local-task:')) {
          setupReached.resolve();
          await releaseSetup.promise;
        }
        return originalCreate(input);
      };

      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [assistantBatchDelta([{ id: 'call_setup', prompt: 'slow setup' }])]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_setup'),
            { agent_name: 'worker', description: 'Setup child', prompt: 'work' },
            input.signal,
          );
          noteText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_setup', noteText)]);
          const consumed = await input.getSteeringMessages?.({ boundary: 'mid-turn' });
          expect(consumed?.length).toBe(1);
          await deliverDelta(input, [assistantReplyDelta('answering during setup')]);
          toolReturned.resolve();
        },
        async (input) => {
          childStarted.resolve();
          const aborted = await Promise.race([
            childLatch.promise.then(() => false),
            new Promise<boolean>((resolve) => {
              if (input.signal?.aborted) resolve(true);
              else input.signal?.addEventListener('abort', () => resolve(true), { once: true });
            }),
          ]);
          childAbortObserved.resolve(aborted);
          if (!aborted) {
            await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'setup child done'));
          }
        },
      ];

      await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'start the setup task', attachments: [] },
      });
      await setupReached.promise;
      // The owner input arrives while the row is admitted but the wait is NOT
      // registered yet (createSession still latched).
      const steer = await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-during-setup',
        message: { content: 'the instruction sent during setup', attachments: [] },
      });
      expect(steer).toEqual({ mode: 'steered', turnId: ownerTurns()[0]?.turnId });

      releaseSetup.resolve();
      await toolReturned.promise;
      // The late registration replayed the DURABLE release intent: the tool
      // got the background note (never re-parked), the child ran ONCE.
      expect(noteText).toContain('<task_background');
      expect(noteText).toContain('reason="owner_input"');
      // The replay-release returns the note while the child execution is
      // still spinning up — wait for the single child turn, never a second.
      await waitFor(() => childTurns().length === 1, 'the setup child turn started');
      expect(childTurns()).toHaveLength(1);
      // Wake the latched child first, then read its (never-aborted) state.
      childLatch.resolve();
      expect(await childAbortObserved.promise).toBe(false);

      const rows = await host!.apiHost.backgroundTaskService.list({ ownerSessionId, limit: 50 });
      const subagentRows = rows.items.filter((task) => task.kind === 'subagent');
      expect(subagentRows).toHaveLength(1);
      expect(subagentRows[0]?.metadata?.['executionMode']).toBe('background');

      // No orphan promises: the child finishes and its terminal is delivered.
      const taskId = subagentRows[0]!.taskId;
      await waitFor(
        async () => (await host!.apiHost.backgroundTaskService.get(taskId))?.status === 'succeeded',
        'setup child terminal',
      );
      await waitFor(
        () => steers.some((entry) => entry.input.producerId === 'background-task-delivery'),
        'setup child delivery wake',
        60_000,
      );
      await waitOwnerIdle(cli);
      agentRoutes.createSession = originalCreate;
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№7: two replicas stay in ingress order, a duplicate RPC answers duplicate and never re-releases content',
    async () => {
      const { conversation } = await startRig();
      await createOwner(conversation);

      const childLatch = deferred();
      const toolReturned = deferred();
      let noteText = '';
      const consumedTexts: string[] = [];

      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [assistantBatchDelta([{ id: 'call_park', prompt: 'park' }])]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_park'),
            { agent_name: 'worker', description: 'Parked child', prompt: 'work' },
            input.signal,
          );
          noteText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_park', noteText)]);
          // Both accepted replicas are consumed in ingress order.
          const first = await input.getSteeringMessages?.({ boundary: 'mid-turn' });
          consumedTexts.push(...((first ?? []).map((message) => JSON.stringify(message)) as string[]));
          const second = await input.getSteeringMessages?.({ boundary: 'mid-turn' });
          consumedTexts.push(...((second ?? []).map((message) => JSON.stringify(message)) as string[]));
          await deliverDelta(input, [assistantReplyDelta('answered both messages')]);
          toolReturned.resolve();
        },
        async (input) => {
          const aborted = await Promise.race([
            childLatch.promise.then(() => false),
            new Promise<boolean>((resolve) => {
              if (input.signal?.aborted) resolve(true);
              else input.signal?.addEventListener('abort', () => resolve(true), { once: true });
            }),
          ]);
          if (!aborted) {
            await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'parked child done'));
          }
        },
      ];

      await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'park then talk', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child started');

      const preDelivery = { accept: async () => undefined };
      await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-first-7',
        message: { content: 'first replica', attachments: [] },
        preDelivery,
      });
      // The second distinct replica arrives while the turn is still active.
      await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-second-7',
        message: { content: 'second replica', attachments: [] },
        preDelivery,
      });
      // The duplicate RPC of the FIRST replica: never re-delivers, but re-runs
      // the idempotent release pass (now empty — the wait is already released).
      const duplicate = await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-first-7',
        message: { content: 'first replica', attachments: [] },
        preDelivery,
      });
      expect(duplicate).toEqual({ mode: 'duplicate', turnId: ownerTurns()[0]?.turnId });

      await toolReturned.promise;
      expect(noteText).toContain('<task_background');
      expect(noteText).toContain('reason="owner_input"');
      // Ingress order preserved: the first replica was consumed first.
      expect(consumedTexts.length).toBe(2);
      expect(consumedTexts[0]).toContain('first replica');
      expect(consumedTexts[1]).toContain('second replica');
      expect(childTurns()).toHaveLength(1);

      childLatch.resolve();
      const taskId = await findRunningTaskId();
      await waitFor(
        async () => (await host!.apiHost.backgroundTaskService.get(taskId))?.status === 'succeeded',
        'parked child terminal',
      );
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№16a: crash after the seam finalize — the restart join closes the open round with the KNOWN note, once',
    async () => {
      let { cli, conversation } = await startRig();
      await createOwner(conversation);

      const childLatch = deferred();
      const toolReturned = deferred();
      harness.scripts = [
        // The parent "crashes" right after the released tool returned the
        // note: the canonical history NEVER receives the toolResult delta —
        // the turn ends with an open trailing round.
        async (input) => {
          await deliverDelta(input, [assistantBatchDelta([{ id: 'call_crash', prompt: 'crash work' }])]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_crash'),
            { agent_name: 'worker', description: 'Crash child', prompt: 'work' },
            input.signal,
          );
          void result.text;
          // The process "dies" before committing the toolResult delta — but
          // the accepted input was consumed by this turn (in-memory), so the
          // turn ends through the normal close WITHOUT the exit-close requeue.
          await input.getSteeringMessages?.({ boundary: 'mid-turn' });
          toolReturned.resolve();
        },
        async (input) => {
          const aborted = await Promise.race([
            childLatch.promise.then(() => false),
            new Promise<boolean>((resolve) => {
              if (input.signal?.aborted) resolve(true);
              else input.signal?.addEventListener('abort', () => resolve(true), { once: true });
            }),
          ]);
          if (!aborted) {
            await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'crash child done'));
          }
        },
      ];
      await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'start the crash task', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child started');
      const taskId = await findRunningTaskId();
      await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-before-crash',
        message: { content: 'release before the crash', attachments: [] },
      });
      await toolReturned.promise;
      await waitOwnerIdle(cli);

      // Restart: the recovery join must close the round from the seam fact.
      ({ cli, conversation } = await restartHost());
      const joined = readPublishedCanonicalHistory(persistentDir!, ownerSessionId);
      // The KNOWN §2.2 note is projected into the canonical history.
      expect(joined).toContain('<task_background');
      // The jsonl line carries the note inside a JSON string, so the quotes
      // of the attribute are escaped on disk.
      expect(joined).toContain('reason=\\"owner_input\\"');
      expect(joined).toContain('call_crash');
      // Exactly one result for the call: a second restart adds nothing.
      const resultCount = (joined.match(/call_crash/g) ?? []).length;
      const noteCount = (joined.match(/<task_background/g) ?? []).length;
      expect(noteCount).toBe(1);
      ({ cli, conversation } = await restartHost());
      const reread = readPublishedCanonicalHistory(persistentDir!, ownerSessionId);
      expect((reread.match(/call_crash/g) ?? []).length).toBe(resultCount);
      expect((reread.match(/<task_background/g) ?? []).length).toBe(noteCount);

      // The brick gate: a NEW turn over the joined history runs cleanly.
      harness.scripts = [
        async (input) => {
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'post-recovery reply'));
        },
      ];
      const nextTurn = await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'continue after recovery', attachments: [] },
      });
      await nextTurn.completion;
      expect(JSON.stringify(await cli.getMessages({ id: ownerSessionId }))).toContain(
        'post-recovery reply',
      );
      void childLatch;
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№16b: crash after the terminal persist, before the delivery — the restart re-schedules the lost wake',
    async () => {
      const { cli, conversation } = await startRig();
      await createOwner(conversation);

      const childLatch = deferred();
      const toolReturned = deferred();
      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [assistantBatchDelta([{ id: 'call_lost', prompt: 'lost wake' }])]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_lost'),
            { agent_name: 'worker', description: 'Lost child', prompt: 'work' },
            input.signal,
          );
          await deliverDelta(input, [toolResultDelta('call_lost', result.text ?? '')]);
          // Consume the instruction that released the child. An unread steer is
          // requeued at turn exit and takes priority over background notices.
          const consumed = await input.getSteeringMessages?.({ boundary: 'mid-turn' });
          expect(consumed).toHaveLength(1);
          await deliverDelta(input, [assistantReplyDelta('answered after release')]);
          toolReturned.resolve();
        },
        async (input) => {
          const aborted = await Promise.race([
            childLatch.promise.then(() => false),
            new Promise<boolean>((resolve) => {
              if (input.signal?.aborted) resolve(true);
              else input.signal?.addEventListener('abort', () => resolve(true), { once: true });
            }),
          ]);
          if (!aborted) {
            await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'lost child done'));
          }
        },
      ];
      await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'start the lost-wake task', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child started');
      const taskId = await findRunningTaskId();
      await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-before-lost-wake',
        message: { content: 'release it', attachments: [] },
      });
      await toolReturned.promise;
      await waitOwnerIdle(cli);
      expect((await cli.listQueueMessages({ id: ownerSessionId })).pendingCount).toBe(0);

      // Hold delivery until shutdown, leaving the terminal row for the next host.
      const stopWindow = openUserStopWindow(host!.apiHost, ownerSessionId, Date.now());
      const deliveryTurns = () =>
        ownerTurns().filter((turn) => turn.turnId.startsWith('turn_task_delivery'));
      try {
        childLatch.resolve();
        await waitFor(
          async () => (await host!.apiHost.backgroundTaskService.get(taskId))?.status === 'succeeded',
          'terminal persisted',
        );
        expect((await host!.apiHost.backgroundTaskService.get(taskId))?.deliveredAt).toBeUndefined();
        await closeHost();
      } finally {
        stopWindow.close();
      }
      expect(deliveryTurns()).toHaveLength(0);

      // The runner records turns throughout startup, including a wake that fires
      // before restartHost returns. Check the message that actually reached it.
      const restarted = await restartHost();
      await waitFor(() => deliveryTurns().length > 0, 'the restarted owner received the terminal notice');
      await waitOwnerIdle(restarted.cli);
      expect(deliveryTurns().map((turn) => turn.text)).toEqual([
        expect.stringContaining(`task_id="${taskId}" status="succeeded"`),
      ]);
    },
    HOST_TIMEOUT_MS,
  );

  it(
    '№16c: crash after the admission ACK, before consumption — the accepted input stays a durable fact and a duplicate replays safely',
    async () => {
      let { cli, conversation } = await startRig();
      await createOwner(conversation);

      const childLatch = deferred();
      const toolReturned = deferred();
      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [assistantBatchDelta([{ id: 'call_ack', prompt: 'ack work' }])]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_ack'),
            { agent_name: 'worker', description: 'Ack child', prompt: 'work' },
            input.signal,
          );
          await deliverDelta(input, [toolResultDelta('call_ack', result.text ?? '')]);
          await deliverDelta(input, [assistantReplyDelta('answered after ack release')]);
          toolReturned.resolve();
        },
        async (input) => {
          const aborted = await Promise.race([
            childLatch.promise.then(() => false),
            new Promise<boolean>((resolve) => {
              if (input.signal?.aborted) resolve(true);
              else input.signal?.addEventListener('abort', () => resolve(true), { once: true });
            }),
          ]);
          if (!aborted) {
            await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'ack child done'));
          }
        },
      ];
      await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'start the ack task', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child started');
      const ackSteer = await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-ack-16',
        message: { content: 'accepted but never consumed', attachments: [] },
        preDelivery: { accept: async () => undefined },
      });
      expect(ackSteer).toEqual({ mode: 'steered', turnId: ownerTurns()[0]?.turnId });
      // The process "dies" before the scripted runner consumes the input.
      await closeHost();

      ({ cli, conversation } = await restartHost());
      // No relaunch: the child turn count is unchanged after the restart and
      // no new task row appeared.
      const rowsAfter = await host!.apiHost.backgroundTaskService.list({ ownerSessionId, limit: 50 });
      expect(rowsAfter.items.filter((task) => task.kind === 'subagent')).toHaveLength(1);
      expect(childTurns().filter((turn) => !turn.turnId.startsWith('turn_task_delivery'))).toHaveLength(1);

      // The duplicate RPC replays the receipt safely (no second delivery).
      const duplicateAfterRestart = await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-ack-16',
        message: { content: 'accepted but never consumed', attachments: [] },
        preDelivery: { accept: async () => undefined },
      });
      expect(duplicateAfterRestart?.mode).toBe('duplicate');

      // The child is still owned by the dead generation; the owner is idle.
      await waitOwnerIdle(cli);
      childLatch.resolve();
    },
    HOST_TIMEOUT_MS,
  );

  it(
    'shutdown honesty: a graceful close drains the released child into an honest terminal row',
    async () => {
      const { cli, conversation } = await startRig();
      await createOwner(conversation);

      const childLatch = deferred();
      const toolReturned = deferred();
      let closeCompleted = false;
      harness.scripts = [
        async (input) => {
          await deliverDelta(input, [assistantBatchDelta([{ id: 'call_stop', prompt: 'shutdown work' }])]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, 'call_stop'),
            { agent_name: 'worker', description: 'Shutdown child', prompt: 'work' },
            input.signal,
          );
          await deliverDelta(input, [toolResultDelta('call_stop', result.text ?? '')]);
          await deliverDelta(input, [assistantReplyDelta('answered after shutdown release')]);
          toolReturned.resolve();
        },
        async (input) => {
          const aborted = await Promise.race([
            childLatch.promise.then(() => false),
            new Promise<boolean>((resolve) => {
              if (input.signal?.aborted) resolve(true);
              else input.signal?.addEventListener('abort', () => resolve(true), { once: true });
            }),
          ]);
          if (!aborted) {
            await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'shutdown child done'));
          }
        },
      ];
      await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'start then close', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child started');
      const taskId = await findRunningTaskId();
      await conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-before-shutdown',
        message: { content: 'release for shutdown', attachments: [] },
      });
      await toolReturned.promise;
      await waitOwnerIdle(cli);

      // The graceful close aborts the accepted background execution and
      // DRAINS it: close() resolves only after the honest terminal row.
      const closing = closeHost().then(() => {
        closeCompleted = true;
      });
      await waitFor(() => closeCompleted, 'close drained the running child');
      // The row is durable: a fresh host over the same dataDir reads the
      // honest terminal (never a fabricated success, never a lost execution).
      const reopenedCli = (await restartHost()).cli;
      const row = await host!.apiHost.backgroundTaskService.get(taskId);
      // §4 honesty: the accepted execution reached an honest terminal during
      // the drain — never a fabricated success, never a lost execution.
      expect(['canceled', 'failed']).toContain(row?.status);
      expect(row?.endedAt).toBeDefined();
      const trail = `${JSON.stringify(row?.lastError)}${JSON.stringify(await host!.apiHost.backgroundTaskService.readOutput(taskId))}`;
      expect(trail).toMatch(/runtime-shutdown|aborted|canceled/i);
      await waitOwnerIdle(reopenedCli);
    },
    HOST_TIMEOUT_MS,
  );
});
