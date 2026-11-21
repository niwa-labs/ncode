/**
 * W1-C — runaway guard delivers its reminder as a deferred custom marker, not
 * a steering message.
 *
 * The adapter parks a fired reminder in a Turn-scoped slot at `on_step_end`;
 * the `before_llm_call` hook of the NEXT provider request drains it as an
 * `appendMessage` decision (`role:'custom'`, `display:false`), the same
 * durable hidden-marker channel the todo-cadence reminder uses. If the model
 * stops before that request, the `turn_end` cleanup discards the reminder.
 *
 * Covered here, against the real PiTurnRunner:
 * - a fired guard followed by a tool-free model answer ends the Turn without
 *   an extra iteration (the marker rides the already-due request);
 * - with tools still running, the marker is present in the next request AND
 *   in the durable history delta as `custom` — never as a user message;
 * - a reminder parked at the final step (host stops the Turn) is discarded:
 *   no request consumes it and it is never reported as injected;
 * - the guard never writes to the steering queue (`agent.steer` untouched);
 * - escalation (+9 re-arm, monotone wording) survives the slot unchanged.
 */

import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from '@sinclair/typebox';

import {
  RUNAWAY_GUARD_REMINDER_CUSTOM_TYPE,
  runawayGuardExtension,
  type RunawayGuardReminderObservation,
} from '@mavis/agent-extension';
import type {
  BeforeLlmCallHandler,
  StepEndHandler,
  TurnAssemblyCtx,
  TurnEndHandler,
} from '@mavis/agent-runtime';
import type { PiHistoryChangedHookInput } from '@mavis/agent-core/pi-turn-runner';
import { PiTurnRunner } from '@mavis/agent-core/pi-turn-runner';
import type { RunTurnInput, RuntimeEvent } from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool, ToolExecutionContext } from '@mavis/agent-core/tools';

const SESSION = 'session-guard-slot';
const TURN = 'turn-guard-slot';

const model = {
  id: 'mock',
  name: 'mock',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
} as unknown as Model<'openai-responses'>;

function usage(): Usage {
  return {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'mock',
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function toolCallBlock(id: string, name: string, args: Record<string, unknown>) {
  return { type: 'toolCall' as const, id, name, arguments: args };
}

/** Identical action every time — the guard's exact_action_repeat fuel. */
function sameActionResponse(index: number): AssistantMessage {
  return assistant([toolCallBlock(`call-${index}`, 'write', { attempt: 'same' })], 'toolUse');
}

function textResponse(text: string): AssistantMessage {
  return assistant([{ type: 'text', text }], 'stop');
}

interface ScriptedProvider {
  streamFn: StreamFn;
  requests: unknown[][];
}

/** Scripted provider: each call records the parsed transcript it saw and pops one response. */
function scriptedProvider(responses: AssistantMessage[]): ScriptedProvider {
  const requests: unknown[][] = [];
  const streamFn: StreamFn = (_model, context) => {
    const messages = (context as { messages?: unknown[] }).messages ?? [];
    requests.push(messages as unknown[]);
    const response = responses.shift() ?? textResponse('done');
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: response.stopReason, message: response });
    });
    return stream;
  };
  return { streamFn, requests };
}

function writeTool(): RuntimeTool {
  return {
    def: {
      name: 'write',
      description: 'repeatable write',
      schema: Type.Object({ attempt: Type.Optional(Type.String()) }),
      executionMode: 'sequential',
    },
    impl: {
      execute: async () => ({
        tool_name: 'write',
        text: 'written',
        content: [{ type: 'text', text: 'written' }],
      }),
    },
  };
}

type CapturedHandler = (event: never, ctx: TurnAssemblyCtx) => unknown;

/** Minimal ExtensionAPI capture — the same handlers the Registry would wrap. */
async function captureHandlers(extension: {
  readonly init: (pi: never) => void | Promise<void>;
}): Promise<Record<string, CapturedHandler[]>> {
  const handlers = new Map<string, CapturedHandler[]>();
  await extension.init({
    params: {},
    registerTool: () => undefined,
    contributeSystemPrompt: () => undefined,
    contributeUserPromptPrefix: () => undefined,
    registerReminderProvider: () => undefined,
    on: (event: string, handler: CapturedHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as never);
  return {
    before_llm_call: handlers.get('before_llm_call') ?? [],
    on_step_end: handlers.get('on_step_end') ?? [],
    turn_end: handlers.get('turn_end') ?? [],
  };
}

interface SlotFixture {
  provider: ScriptedProvider;
  historyDeltas: PiHistoryChangedHookInput[];
  steeringBoundaries: ('mid-turn' | 'exit')[];
  reminders: RunawayGuardReminderObservation[];
  summaries: { reminderInjected: boolean; stepCount: number }[];
  run: () => Promise<void>;
  finishTurn: () => Promise<void>;
}

async function setupFixture(
  responses: AssistantMessage[],
  options: {
    readonly shouldStopAfterTurn?: RunTurnInput<ToolExecutionContext>['shouldStopAfterTurn'];
  } = {},
): Promise<SlotFixture> {
  const provider = scriptedProvider(responses);
  const summaries: { reminderInjected: boolean; stepCount: number }[] = [];
  const reminders: RunawayGuardReminderObservation[] = [];
  const handlers = await captureHandlers(
    runawayGuardExtension({
      remindAfterOccurrences: 3,
      onReminder: (observation) => {
        reminders.push(observation);
      },
      onTurnSummary: (summary) => {
        summaries.push({ reminderInjected: summary.reminderInjected, stepCount: summary.stepCount });
      },
    }),
  );
  const ctx = { sessionId: SESSION, turnId: TURN } as TurnAssemblyCtx;
  const historyDeltas: PiHistoryChangedHookInput[] = [];
  const steeringBoundaries: ('mid-turn' | 'exit')[] = [];

  const input: RunTurnInput<ToolExecutionContext> = {
    sessionId: SESSION,
    turnId: TURN,
    workspaceDir: '/tmp/guard-slot',
    systemPrompt: 'guard slot test',
    userMessage: { text: 'run the writes' },
    llm: { model, streamFn: provider.streamFn },
    eventWriter: {
      appendEvents(_batch: RuntimeEvent[]) {
        /* ignored */
      },
      pushRuntime(_event: RuntimeEvent) {
        /* ignored */
      },
    },
    toolConfig: {
      tools: [writeTool()],
      disableBuiltinToolFallback: true,
      context: { sessionId: SESSION, turnId: TURN },
    },
    hooks: {
      beforeLlmCallHook: handlers.before_llm_call.map(
        (handler) => (input: Parameters<BeforeLlmCallHandler>[0]) =>
          handler(input, ctx) as ReturnType<BeforeLlmCallHandler>,
      ),
      onStepEndHook: handlers.on_step_end.map(
        (handler) => (input: Parameters<StepEndHandler>[0]) => {
          handler(input, ctx);
        },
      ),
      onHistoryChangedHook: [
        (change) => {
          historyDeltas.push(change);
        },
      ],
    },
    getSteeringMessages: (context) => {
      steeringBoundaries.push(context?.boundary ?? 'exit');
      return [];
    },
    ...(options.shouldStopAfterTurn ? { shouldStopAfterTurn: options.shouldStopAfterTurn } : {}),
  };

  return {
    provider,
    historyDeltas,
    steeringBoundaries,
    reminders,
    summaries,
    run: async () => {
      await new PiTurnRunner().runTurn(input);
    },
    finishTurn: async () => {
      // The host drives extension turn_end handlers after the runner settles.
      for (const handler of handlers.turn_end) {
        await handler(
          {
            sessionId: SESSION,
            turnId: TURN,
            agentName: 'mavis',
            workspaceDir: '/tmp/guard-slot',
          } as Parameters<TurnEndHandler>[0],
          ctx,
        );
      }
    },
  };
}

function messagesOf(request: unknown[]): { role: string; content: unknown }[] {
  return request.map((message) => {
    const record = message as { role?: string; content?: unknown };
    return { role: record.role ?? 'unknown', content: record.content };
  });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = part as { type?: string; text?: string };
        return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
      })
      .join('');
  }
  return '';
}

const REMINDER_PHRASE = 'Do not repeat it again';

describe('runaway guard deferred reminder slot (W1-C)', () => {
  it('delivers the reminder on the already-due request and ends the Turn without an extra iteration', async () => {
    const fixture = await setupFixture([
      sameActionResponse(1),
      sameActionResponse(2),
      sameActionResponse(3),
      textResponse('Understood — changing strategy.'),
    ]);

    await fixture.run();
    await fixture.finishTurn();

    // 3 tool steps + the final answer. The parked reminder adds no request:
    // it rides the iteration that was already due after step 3's tool calls.
    expect(fixture.provider.requests).toHaveLength(4);
    // The reminder was delivered into the final request (last position) —
    // the marker text rides the request; the wire conversion renders the
    // custom marker as a user record by design (В3: custom → user on the
    // wire), the durable store keeps it custom (asserted below).
    expect(textOf(messagesOf(fixture.provider.requests[3]!).at(-1)?.content)).toContain(
      REMINDER_PHRASE,
    );
    // The guard fired exactly once and the reminder was delivered.
    expect(fixture.reminders).toHaveLength(1);
    expect(fixture.reminders[0]).toMatchObject({ occurrences: 3, signalKind: 'exact_action_repeat' });
    expect(fixture.summaries).toEqual([{ reminderInjected: true, stepCount: 4 }]);
    // The Turn reached a clean exit boundary — the marker never queues work.
    expect(fixture.steeringBoundaries.at(-1)).toBe('exit');
    // Durable history never records the reminder as a user message.
    for (const change of fixture.historyDeltas) {
      for (const message of change.messages) {
        const record = message as { role?: string; content?: unknown };
        if (record.role === 'user') {
          expect(textOf(record.content)).not.toContain(REMINDER_PHRASE);
        }
      }
    }
  });

  it('marker is in the next request and in the durable history delta as custom, not user', async () => {
    const fixture = await setupFixture([
      sameActionResponse(1),
      sameActionResponse(2),
      sameActionResponse(3),
      textResponse('Switching approach.'),
    ]);

    await fixture.run();
    await fixture.finishTurn();

    // The next request carries the reminder text (marker delivered).
    expect(textOf(messagesOf(fixture.provider.requests[3]!).at(-1)?.content)).toContain(
      REMINDER_PHRASE,
    );

    // Durable representation: the messageDelta append carries the custom
    // marker with the guard customType — the reminder is host context
    // annotation, never a user-authored record.
    const durableMarkers = fixture.historyDeltas
      .flatMap((change) => change.messages)
      .filter((message) => (message as { customType?: string }).customType !== undefined) as {
      role: string;
      customType: string;
      display: boolean;
      content: string;
    }[];
    expect(durableMarkers).toHaveLength(1);
    expect(durableMarkers[0]).toMatchObject({
      role: 'custom',
      customType: RUNAWAY_GUARD_REMINDER_CUSTOM_TYPE,
      display: false,
    });
    expect(durableMarkers[0]!.content).toContain(REMINDER_PHRASE);
    for (const change of fixture.historyDeltas) {
      for (const message of change.messages) {
        const record = message as { role?: string; content?: unknown };
        if (record.role === 'user') {
          expect(textOf(record.content)).not.toContain(REMINDER_PHRASE);
        }
      }
    }
  });

  it('discards a parked reminder when the host stops the Turn before the next request', async () => {
    let steps = 0;
    const fixture = await setupFixture([
      sameActionResponse(1),
      sameActionResponse(2),
      sameActionResponse(3),
    ], {
      shouldStopAfterTurn: () => {
        steps += 1;
        return steps >= 3; // stop right where the guard parks the reminder
      },
    });

    await fixture.run();
    await fixture.finishTurn();

    expect(fixture.provider.requests).toHaveLength(3);
    expect(fixture.reminders).toHaveLength(0);
    expect(fixture.summaries).toEqual([{ reminderInjected: false, stepCount: 3 }]);
    // No marker anywhere: the parked reminder was discarded, not delivered.
    for (const request of fixture.provider.requests) {
      expect(messagesOf(request).some((message) => message.role === 'custom')).toBe(false);
    }
    for (const change of fixture.historyDeltas) {
      expect(change.messages.some((message) => message.role === 'custom')).toBe(false);
    }
  });

  it('never touches the steering queue and drains the slot exactly once (unit)', async () => {
    const handlers = await captureHandlers(runawayGuardExtension({ remindAfterOccurrences: 3 }));
    const ctx = { sessionId: SESSION, turnId: TURN } as TurnAssemblyCtx;
    const steer = vi.fn();
    const signal = new AbortController().signal;
    const stepEvent = (index: number) =>
      ({
        agent: { steer },
        message: sameActionResponse(index),
        toolResults: [
          {
            role: 'toolResult',
            toolCallId: `call-${index}`,
            toolName: 'write',
            content: [{ type: 'text', text: `result-${index}` }],
            isError: false,
            timestamp: 0,
          },
        ],
        signal,
      }) as unknown as Parameters<StepEndHandler>[0];

    expect(handlers.on_step_end).toHaveLength(1);
    const onStepEnd = handlers.on_step_end[0]!;
    onStepEnd(stepEvent(1), ctx);
    onStepEnd(stepEvent(2), ctx);
    expect(steer).not.toHaveBeenCalled();
    onStepEnd(stepEvent(3), ctx);
    // The reminder is parked, not steered — the queue keeps only live users.
    expect(steer).not.toHaveBeenCalled();

    const beforeLlmCall = handlers.before_llm_call[0]!;
    const decision = await beforeLlmCall({
      sessionId: SESSION,
      turnId: TURN,
      phase: 'iteration',
      messages: [],
      canonicalMessages: [],
    } as Parameters<BeforeLlmCallHandler>[0], ctx);
    expect(decision).toMatchObject({
      type: 'appendMessage',
      reason: RUNAWAY_GUARD_REMINDER_CUSTOM_TYPE,
    });
    const message = (decision as { message: { role: string; customType: string; display: boolean; content: string } }).message;
    expect(message).toMatchObject({
      role: 'custom',
      customType: RUNAWAY_GUARD_REMINDER_CUSTOM_TYPE,
      display: false,
    });
    expect(message.content).toContain(REMINDER_PHRASE);

    // Single-shot drain: the next request sees no pending reminder.
    expect(
      await beforeLlmCall({
        sessionId: SESSION,
        turnId: TURN,
        phase: 'iteration',
        messages: [],
        canonicalMessages: [],
      } as Parameters<BeforeLlmCallHandler>[0], ctx),
    ).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('keeps escalation semantics through the slot: re-arm at +9 with stronger wording', async () => {
    const fixture = await setupFixture([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(sameActionResponse),
      textResponse('Actually stopping now.'),
    ]);

    await fixture.run();
    await fixture.finishTurn();

    // Reminders fire at occurrences 3 and 12 (+9 re-arm), each delivered on
    // the request that was already due after the firing step's tool calls.
    expect(fixture.provider.requests).toHaveLength(13);
    expect(fixture.reminders).toHaveLength(2);
    expect(fixture.reminders[0]).toMatchObject({ occurrences: 3, stepIndex: 3 });
    expect(fixture.reminders[1]).toMatchObject({ occurrences: 12, stepIndex: 12 });

    // Both deliveries landed in durable history as guard markers, in order,
    // with the escalated wording on the second.
    const durableMarkers = fixture.historyDeltas
      .flatMap((change) => change.messages)
      .filter((message) => (message as { customType?: string }).customType !== undefined) as {
      customType: string;
      content: string;
    }[];
    expect(durableMarkers).toHaveLength(2);
    expect(durableMarkers[0]!.customType).toBe(RUNAWAY_GUARD_REMINDER_CUSTOM_TYPE);
    expect(durableMarkers[0]!.content).not.toContain('reminder 2');
    expect(durableMarkers[1]!.content).toContain('reminder 2');
    expect(durableMarkers[1]!.content).toContain('did not change this pattern');
    expect(fixture.summaries).toEqual([{ reminderInjected: true, stepCount: 13 }]);
  });
});
