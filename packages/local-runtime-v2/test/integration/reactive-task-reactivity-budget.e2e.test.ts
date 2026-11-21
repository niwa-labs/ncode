/**
 * Wave 4 (verdict 09 §5.5): the measured reactivity budget of the release on
 * the production host with a scripted provider. "Instant" is a causal
 * guarantee: the parent's continuation does NOT wait on the child. The
 * instrumented chain per cycle is
 *
 *   owner input accepted → release committed (durable seam) → parked tool
 *   returned (tool round closed) → executor continues to the next provider
 *   request (started against the accepted input; model latency is a separate
 *   measure and never attributed to the release mechanism).
 *
 * The test budgets `accepted → tool round closed` at p95 ≤ 250ms over nine
 * release cycles (worst case ≤ 1s) and the wake side at the fixed idle
 * coalescing bound (terminal batch → notification admission ≤ 2s on a healthy
 * runtime; the storm guard's designed trailing drain for the ninth+ terminal
 * is latency-bounded by the 60s window, checked in the scheduler unit tests).
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
        arguments: { agent_name: 'worker', description: 'Budget child', prompt: 'work until told' },
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
    await new Promise((resolve) => setTimeout(resolve, 25));
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
  dataDir = await mkdtemp(join(tmpdir(), 'reactive-task-budget-'));
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

function childTurns(): readonly { sessionId: string; turnId: string; startedAtMs: number }[] {
  return harness.startedTurns.filter((turn) => turn.sessionId !== ownerSessionId);
}

function deliverySteers(): readonly {
  readonly input: ConversationSteerInput;
  readonly result: { delivered: boolean; mode?: string; turnId?: string };
}[] {
  return steers.filter((entry) => entry.input.producerId === 'background-task-delivery');
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

const HOST_TIMEOUT_MS = 300_000;
const RELEASE_BUDGET_P95_MS = 250;
const RELEASE_BUDGET_MAX_MS = 1_000;
const WAKE_ADMISSION_BUDGET_MS = 2_000;
const RELEASE_CYCLES = 9;

describe('reactive subagents wave 4: the measured release budget (§5.5)', () => {
  it(
    `accepted→release-committed stays within budget: p95 ≤ ${RELEASE_BUDGET_P95_MS}ms over ${RELEASE_CYCLES} cycles; the wake batch admits within the fixed coalescing bound`,
    async () => {
      const { cli, conversation } = await startRig();
      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir!, 'workspace'),
        sessionType: 'root',
      });
      ownerSessionId = owner.sessionId;

      // Per cycle: the parent parks on the task tool; the test resolves the
      // `toolReturned` latch the moment the §2.2 note came back (the release
      // committed and the tool round closed).
      const toolReturned: (ReturnType<typeof deferred> | undefined)[] = [];
      const childLatches: (ReturnType<typeof deferred> | undefined)[] = [];
      const scripts: ((input: ScriptedTurnInput) => Promise<void>)[] = [];
      for (let index = 0; index < RELEASE_CYCLES; index += 1) {
        const callId = `call_budget_${index}`;
        scripts.push(async (input) => {
          await deliverDelta(input, [assistantToolCallDelta(callId)]);
          const result = await tool(input, 'task').impl.execute(
            callContext(input, callId),
            { agent_name: 'worker', description: 'Budget child', prompt: 'work until told' },
            input.signal,
          );
          expect(result.text ?? '').toContain('<task_background');
          expect(result.text ?? '').toContain('reason="owner_input"');
          toolReturned[index]?.resolve();
          await deliverDelta(input, [toolResultDelta(callId, result.text ?? '')]);
          // The executor continues to the steering drain (the §1.7 yield
          // boundary): the accepted input is consumed IN this turn, so no
          // exit-close requeue spawns a follow-up turn that would steal the
          // next script slot.
          const consumed = await input.getSteeringMessages?.({ boundary: 'mid-turn' });
          expect(consumed?.length).toBe(1);
          await deliverDelta(input, [assistantReplyDelta(`cycle ${index} answered`)]);
        });
        const latch = deferred();
        childLatches.push(latch);
        scripts.push(async (input) => {
          await latch.promise;
          await input.eventWriter.pushRuntime(assistantReplyEvent(input, 'child done'));
        });
      }
      harness.scripts = scripts;

      // The release cycles: submit → child parked → owner input → the release
      // commits and the parked tool returns. The next parent provider request
      // starts in the same executor against the accepted input.
      const releaseLatenciesMs: number[] = [];
      for (let index = 0; index < RELEASE_CYCLES; index += 1) {
        toolReturned[index] = deferred();
        // The parent turn cannot complete until the release — the completion
        // is awaited only AFTER the steer of this cycle.
        const turn = conversation.ingress.submit({
          sessionId: ownerSessionId,
          source: 'api',
          allowQueue: false,
          message: { content: `run budget task ${index}`, attachments: [] },
        });
        await waitFor(async () => childTurns().length > index, `child ${index} started`);
        const acceptedAtMs = Date.now();
        const steer = await conversation.ingress.steer({
          sessionId: ownerSessionId,
          source: 'api',
          producerId: 'composer-steer',
          idempotencyKey: `steer-budget-${index}`,
          message: { content: `the new instruction ${index}`, attachments: [] },
        });
        expect(steer.mode).toBe('steered');
        await toolReturned[index]!.promise;
        releaseLatenciesMs.push(Date.now() - acceptedAtMs);
        // Let the parent turn settle before the next cycle.
        await (await turn).completion;
        await waitFor(
          async () => (await cli.getActiveTurn(ownerSessionId)) === undefined,
          `parent turn ${index} settled`,
        );
      }

      releaseLatenciesMs.sort((left, right) => left - right);
      const p95Index = Math.min(
        releaseLatenciesMs.length - 1,
        Math.ceil(releaseLatenciesMs.length * 0.95) - 1,
      );
      expect(releaseLatenciesMs).toHaveLength(RELEASE_CYCLES);
      expect(
        releaseLatenciesMs[p95Index]!,
        `p95 accepted→release-committed ${releaseLatenciesMs[p95Index]}ms must be ≤${RELEASE_BUDGET_P95_MS}ms (samples: ${releaseLatenciesMs.join(',')})`,
      ).toBeLessThanOrEqual(RELEASE_BUDGET_P95_MS);
      expect(
        Math.max(...releaseLatenciesMs),
        `worst release sample ${Math.max(...releaseLatenciesMs)}ms must be ≤${RELEASE_BUDGET_MAX_MS}ms`,
      ).toBeLessThanOrEqual(RELEASE_BUDGET_MAX_MS);

      // Wake side (§5.5): all parked children release in one tick — their
      // terminals land in ONE coalescing epoch and admit together within the
      // fixed idle bound (window 50ms + healthy-runtime margin).
      const releasedAtMs = Date.now();
      for (const latch of childLatches) latch?.resolve();
      await waitFor(() => deliverySteers().length > 0, 'the wake batch admission', 60_000);
      const admissionMs = Date.now() - releasedAtMs;
      expect(
        admissionMs,
        `terminal batch → notification admission ${admissionMs}ms must be ≤${WAKE_ADMISSION_BUDGET_MS}ms`,
      ).toBeLessThanOrEqual(WAKE_ADMISSION_BUDGET_MS);
      const admission = deliverySteers()[0]!;
      expect(admission.result.mode).toBe('activated');
      // Every one of the nine terminals is named by the single coalesced batch
      // — none lost, no window shifted.
      const wakeTaskIds = (admission.input.message.origin.taskIds ?? []) as string[];
      expect(wakeTaskIds.length).toBe(RELEASE_CYCLES);
      const rows = await host!.apiHost.backgroundTaskService.list({
        ownerSessionId,
        statuses: ['succeeded'],
        limit: 50,
      });
      expect(rows.items).toHaveLength(RELEASE_CYCLES);
    },
    HOST_TIMEOUT_MS,
  );
});
