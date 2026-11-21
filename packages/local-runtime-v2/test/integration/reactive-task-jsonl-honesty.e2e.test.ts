/**
 * Wave 4 (verdict 09 §5.4 №19, §5.2): the JSONL backend never releases a
 * foreground task wait on owner input, and its model-facing surface says so.
 * On `MCODE_HISTORY_PROVIDER=jsonl` the durable steering composition (and with
 * it `host.nativeTaskWaits`) does not exist, so:
 * - the task tool description the Turn actually receives carries the honest
 *   non-reactive contract — no release promise;
 * - behaviorally, an owner message sent while a foreground child runs does
 *   NOT background the child: the tool returns the inline `<task_result>` and
 *   no `<task_background>` note, no delivery wake exists.
 * The durable e2e files prove the release side; this file proves the honesty
 * of the absence. One file per run: the env pins the whole process.
 *
 * @module
 */
process.env.MCODE_HISTORY_PROVIDER = 'jsonl';

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
      readonly def: { readonly name: string; readonly description: string };
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

function assistantToolCallDelta(callId: string): Record<string, unknown> {
  return {
    role: 'assistant',
    provider: 'test',
    api: 'openai-completions',
    model: 'model',
    content: [
      {
        type: 'toolCall',
        id: callId,
        name: 'task',
        arguments: { agent_name: 'worker', description: 'Jsonl child', prompt: 'work until done' },
      },
    ],
    timestamp: T,
  };
}

function toolResultDelta(callId: string, text: string): Record<string, unknown> {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'task',
    content: [{ type: 'text', text }],
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
  dataDir = await mkdtemp(join(tmpdir(), 'reactive-task-jsonl-'));
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
  // №19 form: the jsonl host never receives the native task-wait binding.
  expect(
    (host.apiHost as { nativeTaskWaits?: unknown }).nativeTaskWaits,
    'jsonl host must leave nativeTaskWaits unset',
  ).toBeUndefined();
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

async function closeHost(): Promise<void> {
  await host?.apiHost.close().catch(() => undefined);
  await host?.metricsClient.close().catch(() => undefined);
  host = undefined;
}

function ownerTurns(): readonly { sessionId: string; turnId: string }[] {
  return harness.startedTurns.filter((turn) => turn.sessionId === ownerSessionId);
}

function childTurns(): readonly { sessionId: string; turnId: string }[] {
  return harness.startedTurns.filter((turn) => turn.sessionId !== ownerSessionId);
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
  ownerSessionId = '';
  delete process.env.MCODE_HISTORY_PROVIDER;
});

const HOST_TIMEOUT_MS = 240_000;

describe('reactive subagents wave 4: JSONL honesty (§5.4 №19)', () => {
  it(
    'jsonl surface does not promise release and owner input never backgrounds a foreground child',
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
      let taskDescriptionSeen = '';
      harness.scripts = [
        // Parent: park on the foreground task; the owner message arrives while
        // it is parked. On jsonl the wait is NEVER released.
        async (input) => {
          await deliverDelta(input, [assistantToolCallDelta('call_jsonl_fg')]);
          const taskTool = tool(input, 'task');
          taskDescriptionSeen = taskTool.def.description;
          const result = await taskTool.impl.execute(
            callContext(input, 'call_jsonl_fg'),
            { agent_name: 'worker', description: 'Jsonl child', prompt: 'work until done' },
            input.signal,
          );
          toolText = result.text ?? '';
          await deliverDelta(input, [toolResultDelta('call_jsonl_fg', toolText)]);
          await deliverDelta(input, [assistantReplyDelta('finished after the message')]);
          toolReturned.resolve();
        },
        async (input) => {
          await childLatch.promise;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'jsonl child done'));
        },
      ];

      const firstTurn = await conversation.ingress.submit({
        sessionId: ownerSessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'run the task', attachments: [] },
      });
      await waitFor(async () => childTurns().length > 0, 'child started');
      void firstTurn;

      // The owner message while the task is parked; then the child finishes.
      const steerPromise = conversation.ingress.steer({
        sessionId: ownerSessionId,
        source: 'api',
        producerId: 'composer-steer',
        idempotencyKey: 'steer-jsonl-owner',
        message: { content: 'a message while the child runs', attachments: [] },
      });
      childLatch.resolve();
      const steer = await steerPromise;
      expect(steer.mode).toBe('steered');
      await toolReturned.promise;
      await firstTurn.completion;

      // Surface form (№19): the description this Turn received never promises
      // the release and carries the honest non-reactive statement instead.
      expect(taskDescriptionSeen).not.toContain('the runtime releases those waits');
      expect(taskDescriptionSeen).toContain('does NOT move it to the background');
      // Behavior: the foreground wait stayed inline — no release note.
      expect(toolText).toContain('<task_result');
      expect(toolText).not.toContain('<task_background');
      // No delivery machinery was engaged at all.
      expect(
        steers.filter((entry) => entry.input.producerId === 'background-task-delivery'),
      ).toEqual([]);
      void ownerTurns;
    },
    HOST_TIMEOUT_MS,
  );
});
