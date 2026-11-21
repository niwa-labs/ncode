/**
 * A4 (final-sprint `01-verdict-astra.md` §3) — the response-control discard
 * path must be VISIBLE and IDENTITY-CARRYING on the event stream:
 *
 * `delta(A) → reject/discard(A) → delta(B) → final(B)` through the real
 * turn runner and the real EventBridge. The rejected attempt A has already
 * streamed text deltas to live consumers, so the discard resets the bridge
 * WITHOUT silence: a `debug.trace` frame with the phase
 * `assistant_message_discarded` and A's host-allocated `message_id` rides
 * the writer BEFORE the replacement attempt B streams, letting identity-aware
 * consumers retract exactly A's transient cells. A's `message_end` is never
 * delivered (no finish chunk, no completed message carries A), A never
 * reaches onHistory, and B streams and completes after the trace.
 *
 * Also pinned (astra scenario list): an attempt the hooks ALLOW keeps its
 * completed message — the discard trace stays the ONLY discard signal; a
 * `messageId` change alone never implies a discard.
 */

import { describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import { RuntimeEventType } from '@mavis/protocol';

import { PiTurnRunner } from '../../../src/pi-turn-runner/pi-turn-runner.js';
import type { RuntimeEvent, RunTurnInput } from '../../../src/pi-turn-runner/types.js';
import type { PiHistoryChangedHookInput } from '../../../src/pi-turn-runner/hooks.js';
import type { ToolExecutionContext } from '../../../src/tools/index.js';

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

interface ScriptedAttempt {
  readonly deltas: readonly string[];
  readonly finalText: string;
}

/**
 * Streams each scripted attempt as REAL provider events: `start`, then
 * `text_delta` frames each carrying the accumulated `partial` (the pi loop
 * contract), then the final `done` with the completed message.
 */
function streamingProvider(attempts: readonly ScriptedAttempt[]): StreamFn {
  return () => {
    const attempt = attempts.shift() ?? { deltas: [], finalText: 'done' };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const base = {
        role: 'assistant',
        api: 'openai-responses',
        provider: 'openai',
        model: 'mock',
        usage: usage(),
        stopReason: 'stop',
        timestamp: Date.now(),
      } as AssistantMessage;
      stream.push({ type: 'start', partial: { ...base, content: [] } });
      let accumulated = '';
      for (const delta of attempt.deltas) {
        accumulated += delta;
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta,
          partial: { ...base, content: [{ type: 'text', text: accumulated }] },
        });
      }
      stream.push({
        type: 'done',
        reason: 'stop',
        message: { ...base, content: [{ type: 'text', text: attempt.finalText }] },
      });
    });
    return stream;
  };
}

interface StreamedChunk {
  readonly msgId: string | undefined;
  readonly text: string;
}

/** Assistant text the wire surface saw (delta chunks + completed messages), in writer order. */
function assistantTextChunks(events: readonly RuntimeEvent[]): StreamedChunk[] {
  return events.flatMap((event) => {
    if (event.type !== RuntimeEventType.STREAM_RESP) return [];
    const raw = event.payload?.stream_resp;
    if (typeof raw !== 'string') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const record = parsed as {
      type?: number;
      agent_message_chunk?: Record<string, unknown>;
      agent_message?: Record<string, unknown>;
    };
    const chunk = record.agent_message_chunk ?? record.agent_message;
    if (!chunk) return [];
    const text = typeof chunk['msg_content'] === 'string' ? chunk['msg_content'] : '';
    if (!text) return [];
    return [
      {
        msgId: typeof chunk['msg_id'] === 'string' ? chunk['msg_id'] : undefined,
        text,
      },
    ];
  });
}

interface DiscardTrace {
  readonly messageId: string;
  readonly orderIndex: number;
}

/** The `assistant_message_discarded` debug traces, with their writer order. */
function discardTraces(events: readonly RuntimeEvent[]): DiscardTrace[] {
  return events.flatMap((event, index) => {
    if (event.type !== RuntimeEventType.DEBUG_TRACE) return [];
    const trace = (event.payload as { trace?: { phase?: string; attrs_json?: string } }).trace;
    if (trace?.phase !== 'assistant_message_discarded') return [];
    let attrs: Record<string, unknown> = {};
    try {
      attrs = JSON.parse(trace.attrs_json ?? '{}') as Record<string, unknown>;
    } catch {
      attrs = {};
    }
    return [{ messageId: String(attrs['message_id'] ?? ''), orderIndex: index }];
  });
}

function assistantHistoryTexts(changes: readonly PiHistoryChangedHookInput[]): string[] {
  return changes.flatMap((change) =>
    change.messages.flatMap((message) =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? message.content
            .filter((block) => block.type === 'text')
            .map((block) => (block as { text: string }).text)
        : [],
    ),
  );
}

function turnInput(
  overrides: Partial<RunTurnInput<ToolExecutionContext>> & { streamFn: StreamFn },
  events: RuntimeEvent[],
  historyChanges: PiHistoryChangedHookInput[],
): RunTurnInput<ToolExecutionContext> {
  const { hooks, ...rest } = overrides;
  return {
    sessionId: 'session-discard',
    turnId: 'turn-discard',
    workspaceDir: '/tmp/discard',
    systemPrompt: 'discard test',
    userMessage: { text: 'hello' },
    llm: { model, streamFn: overrides.streamFn },
    toolConfig: {
      tools: [],
      disableBuiltinToolFallback: true,
      context: { sessionId: 'session-discard', turnId: 'turn-discard' },
    },
    eventWriter: {
      appendEvents(batch) {
        events.push(...batch);
      },
      pushRuntime(event) {
        events.push(event);
      },
    },
    hooks: {
      ...hooks,
      onHistoryChangedHook: [
        async (change: PiHistoryChangedHookInput) => {
          historyChanges.push(change);
        },
        ...(hooks?.onHistoryChangedHook ?? []),
      ],
    },
    ...rest,
  };
}

describe('A4 response-control discard: identity on the stream', () => {
  it('delta(A) → discard(A) → delta(B) → final(B): the discard is visible with A identity, A never completes, B streams after it', async () => {
    const events: RuntimeEvent[] = [];
    const historyChanges: PiHistoryChangedHookInput[] = [];
    const allocated: string[] = [];
    let sawAttempt = 0;
    const input = turnInput(
      {
        streamFn: streamingProvider([
          { deltas: ['rejected ', 'attempt A'], finalText: 'rejected attempt A' },
          { deltas: ['accepted ', 'answer B'], finalText: 'accepted answer B' },
        ]),
        hooks: {
          afterLlmCallHook: [
            async (hookInput) => {
              sawAttempt += 1;
              if (sawAttempt === 1) {
                expect(
                  hookInput.message.content.some(
                    (block) => block.type === 'text' && block.text === 'rejected attempt A',
                  ),
                ).toBe(true);
                return {
                  type: 'retry',
                  reason: 'response control rejected A',
                  prompt: 'try again',
                } as const;
              }
              return undefined;
            },
          ],
        },
      },
      events,
      historyChanges,
    );

    await new PiTurnRunner({
      messageIdAllocator: {
        allocateAssistantMessageId: async () => {
          allocated.push(`msg-${allocated.length + 1}`);
          return allocated[allocated.length - 1]!;
        },
      },
    }).runTurn(input);

    // The rejected attempt and the retry both ran; both ids were allocated.
    expect(sawAttempt).toBe(2);
    expect(allocated).toEqual(['msg-1', 'msg-2']);

    // Attempt A's deltas DID stream (the residue consumers must retract)…
    const chunks = assistantTextChunks(events);
    expect(chunks.filter((chunk) => chunk.msgId === 'msg-1').map((chunk) => chunk.text)).toEqual([
      'rejected ',
      'attempt A',
    ]);
    // …but its message_end never did: nothing completed carries A's identity.
    expect(
      chunks.some((chunk) => chunk.msgId === 'msg-1' && chunk.text === 'rejected attempt A'),
    ).toBe(false);

    // The discard trace carries A's identity exactly once…
    const discards = discardTraces(events);
    expect(discards).toHaveLength(1);
    expect(discards[0]!.messageId).toBe('msg-1');
    // …and lands after A's deltas, before anything of B.
    const lastDeltaA = events.indexOf(
      events.findLast((event) => {
        if (event.type !== RuntimeEventType.STREAM_RESP) return false;
        const raw = event.payload?.stream_resp;
        return typeof raw === 'string' && raw.includes('attempt A') && raw.includes('msg-1');
      })!,
    );
    expect(discards[0]!.orderIndex).toBeGreaterThan(lastDeltaA);
    const firstOfB = events.findIndex((event) => {
      if (event.type !== RuntimeEventType.STREAM_RESP) return false;
      const raw = event.payload?.stream_resp;
      return typeof raw === 'string' && raw.includes('msg-2');
    });
    expect(firstOfB).toBeGreaterThan(discards[0]!.orderIndex);

    // B streams and completes under its own identity.
    expect(
      chunks.filter((chunk) => chunk.msgId === 'msg-2').map((chunk) => chunk.text),
    ).toEqual(['accepted ', 'answer B', 'accepted answer B']);
  });

  it('an allowed attempt keeps its completed message — a messageId change alone is never a discard', async () => {
    const events: RuntimeEvent[] = [];
    const historyChanges: PiHistoryChangedHookInput[] = [];
    const input = turnInput(
      {
        streamFn: streamingProvider([{ deltas: ['preamble'], finalText: 'preamble answer' }]),
      },
      events,
      historyChanges,
    );

    await new PiTurnRunner().runTurn(input);

    expect(discardTraces(events)).toEqual([]);
    const chunks = assistantTextChunks(events);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['preamble', 'preamble answer']);
    expect(assistantHistoryTexts(historyChanges)).toContain('preamble answer');
  });

  it('the discarded attempt never reaches onHistory; the retry prompt and B do', async () => {
    const events: RuntimeEvent[] = [];
    const historyChanges: PiHistoryChangedHookInput[] = [];
    let sawAttempt = 0;
    const input = turnInput(
      {
        streamFn: streamingProvider([
          { deltas: ['A'], finalText: 'history-rejected A' },
          { deltas: ['B'], finalText: 'history-accepted B' },
        ]),
        hooks: {
          afterLlmCallHook: [
            async () => {
              sawAttempt += 1;
              return sawAttempt === 1
                ? ({ type: 'retry', reason: 'reject', prompt: 'retry prompt' } as const)
                : undefined;
            },
          ],
        },
      },
      events,
      historyChanges,
    );

    await new PiTurnRunner().runTurn(input);

    const delivered = assistantHistoryTexts(historyChanges);
    expect(delivered).not.toContain('history-rejected A');
    expect(delivered).toContain('history-accepted B');
    const retryPrompt = historyChanges.some((change) =>
      change.messages.some(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === 'text' && (block as { text: string }).text === 'retry prompt',
          ),
      ),
    );
    expect(retryPrompt).toBe(true);
  });
});
