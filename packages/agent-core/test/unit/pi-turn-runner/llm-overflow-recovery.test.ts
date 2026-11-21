/**
 * В1 (opus-decisions-20261101) — the llm-retry overflow recovery at the turn
 * loop: after the run settles with an overflow-failed response, the runner
 * rejects the failed response out of the transcript and the host recovery
 * (`llmRetry.contextOverflowRecovery`) wraps the ONE continuation whose
 * request recompiles the context. A transport retry inside `withLLMRetry`
 * would re-send the same oversized payload — the retry must be a NEW request.
 *
 * Covered here (the agent-core half of the seam):
 * - an overflow failure triggers exactly ONE recovery and ONE continued
 *   request; the retried request no longer carries the failed response;
 * - a non-overflow failure never triggers the recovery;
 * - a terminal retry failure (the recovery rethrows) fails the turn with
 *   that failure, and still only one continuation was issued.
 */

import { describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, TranscriptContext, Usage } from '@earendil-works/pi-ai';

import { PiTurnRunner } from '../../../src/pi-turn-runner/pi-turn-runner.js';
import type { LLMContextOverflowRecovery } from '../../../src/pi-turn-runner/llm-retry.js';
import type { RuntimeEvent, RunTurnInput } from '../../../src/pi-turn-runner/types.js';
import type { ToolExecutionContext } from '../../../src/tools/index.js';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';

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
  errorMessage?: string,
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
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  } as AssistantMessage;
}

interface ScriptedProvider {
  streamFn: StreamFn;
  /** The conversation messages each physical request saw (pi roles only). */
  requests: AgentMessage[][];
}

/** Scripted provider: each call records the transcript it saw and pops one response. */
function scriptedProvider(responses: AssistantMessage[]): ScriptedProvider {
  const requests: AgentMessage[][] = [];
  const streamFn: StreamFn = (_model, context: TranscriptContext) => {
    requests.push([...context.messages]);
    const response = responses.shift() ?? assistant([{ type: 'text', text: 'done' }]);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: response.stopReason, message: response });
    });
    return stream;
  };
  return { streamFn, requests };
}

function collectWriter(events: RuntimeEvent[]): RunTurnInput['eventWriter'] {
  return {
    appendEvents(batch) {
      events.push(...batch);
    },
    pushRuntime(event) {
      events.push(event);
    },
  };
}

function turnInput(
  overrides: Partial<RunTurnInput<ToolExecutionContext>> & { streamFn: StreamFn },
): RunTurnInput<ToolExecutionContext> {
  const events: RuntimeEvent[] = [];
  const input: RunTurnInput<ToolExecutionContext> = {
    sessionId: 'session-overflow',
    turnId: 'turn-overflow',
    workspaceDir: '/tmp/overflow',
    systemPrompt: 'overflow test',
    userMessage: { text: 'hello' },
    llm: { model, streamFn: overrides.streamFn },
    eventWriter: collectWriter(events),
    toolConfig: {
      tools: [],
      disableBuiltinToolFallback: true,
      context: { sessionId: 'session-overflow', turnId: 'turn-overflow' },
    },
    ...overrides,
  };
  return input;
}

/** Assistant texts the onHistoryChangedHook saw, in delivery order. */
function deliveredAssistantTexts(
  changes: readonly { readonly messages: readonly AgentMessage[] }[],
): string[] {
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

function countingRecovery(
  behavior: 'succeeds' | 'rethrows',
): { recovery: LLMContextOverflowRecovery; recoverCalls: number[] } {
  const recoverCalls: number[] = [];
  const recovery: LLMContextOverflowRecovery = {
    isOverflowError: (error) => String(error).includes('context_length_exceeded'),
    recover: async (retry) => {
      recoverCalls.push(1);
      if (behavior === 'rethrows') {
        await retry();
        throw new Error('context overflow recovery failed after one compact-and-retry attempt');
      }
      await retry();
    },
  };
  return { recovery, recoverCalls };
}

describe('В1 llm-retry context-overflow recovery (runAgent level)', () => {
  it('an overflow failure is recovered with exactly ONE continued request — without the failed response', async () => {
    const provider = scriptedProvider([
      assistant([{ type: 'text', text: '' }], 'error', 'context_length_exceeded: prompt too long'),
      assistant([{ type: 'text', text: 'recovered answer' }]),
    ]);
    const { recovery, recoverCalls } = countingRecovery('succeeds');
    const input = turnInput({
      streamFn: provider.streamFn,
      llmRetry: { contextOverflowRecovery: recovery },
    });

    await new PiTurnRunner().runTurn(input);

    // The failed request + the ONE continuation — never two retries.
    expect(provider.requests).toHaveLength(2);
    expect(recoverCalls).toHaveLength(1);
    // The retried request carries the user message but NOT the failed
    // assistant response (rejected out of the transcript before continue).
    const retryRequest = provider.requests[1]!;
    expect(retryRequest.filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(retryRequest.some((message) => message.role === 'user')).toBe(true);
  });

  it('a non-overflow failure never triggers the recovery', async () => {
    const provider = scriptedProvider([
      assistant([{ type: 'text', text: '' }], 'error', 'connection reset by peer'),
    ]);
    const { recovery, recoverCalls } = countingRecovery('succeeds');
    const input = turnInput({
      streamFn: provider.streamFn,
      llmRetry: { contextOverflowRecovery: recovery },
    });

    await new PiTurnRunner().runTurn(input);

    expect(provider.requests).toHaveLength(1);
    expect(recoverCalls).toHaveLength(0);
  });

  it('a terminal retry failure propagates after the single continuation', async () => {
    const provider = scriptedProvider([
      assistant([{ type: 'text', text: '' }], 'error', 'context_length_exceeded: prompt too long'),
      assistant([{ type: 'text', text: '' }], 'error', 'context_length_exceeded: still too long'),
    ]);
    const { recovery, recoverCalls } = countingRecovery('rethrows');
    const events: RuntimeEvent[] = [];
    const input = turnInput({
      streamFn: provider.streamFn,
      llmRetry: { contextOverflowRecovery: recovery },
      eventWriter: collectWriter(events),
    });

    await new PiTurnRunner().runTurn(input);

    // Exactly one compaction-and-retry episode: two requests total, and the
    // terminal frame carries the recovery's failure (the run outcome is
    // computed from the post-recovery agent state).
    expect(provider.requests).toHaveLength(2);
    expect(recoverCalls).toHaveLength(1);
    const terminal = events.filter(
      (event) =>
        event.type === RuntimeEventType.SESSION_STATUS &&
        (event as { payload?: { status?: RuntimeEventStatus } }).payload?.status !==
          RuntimeEventStatus.RUNNING,
    );
    expect(terminal.at(-1)).toBeDefined();
  });

  it('A4(2): with the failed tail already delivered, the recovery answer still reaches onHistory (same final length must not swallow it)', async () => {
    // The failed assistant response's message_end delivers it through
    // onHistory (audit); the recovery then removes it from the agent
    // transcript and the retried request appends the answer at the SAME
    // index. The length-based flushTail cursor must be explicitly
    // reconciled, or the recovery answer is never delivered — durable
    // history loses it while the turn shows success.
    const provider = scriptedProvider([
      assistant([{ type: 'text', text: '' }], 'error', 'context_length_exceeded: prompt too long'),
      assistant([{ type: 'text', text: 'recovered answer' }]),
    ]);
    const historyChanges: { messages: AgentMessage[] }[] = [];
    const { recovery } = countingRecovery('succeeds');
    const input = turnInput({
      streamFn: provider.streamFn,
      llmRetry: { contextOverflowRecovery: recovery },
      hooks: {
        onHistoryChangedHook: [
          async (change) => {
            historyChanges.push({ messages: [...change.messages] });
          },
        ],
      },
    });

    await new PiTurnRunner().runTurn(input);

    // The failed record was delivered exactly once (audit stays)…
    const failedDeliveries = historyChanges.filter((change) =>
      change.messages.some(
        (message) => message.role === 'assistant' && message.stopReason === 'error',
      ),
    );
    expect(failedDeliveries).toHaveLength(1);
    // …and the recovery answer IS delivered after the rewind.
    expect(deliveredAssistantTexts(historyChanges)).toContain('recovered answer');
  });

  it('A4(2): a history delivery failure stays fail-closed across the recovery (no silent resume)', async () => {
    // The other order: the failed tail's delivery THREW (persistence broke),
    // latching the cursor fail-closed. The rewind must not resurrect
    // deliveries behind a broken persistence seam.
    const provider = scriptedProvider([
      assistant([{ type: 'text', text: '' }], 'error', 'context_length_exceeded: prompt too long'),
      assistant([{ type: 'text', text: 'recovered answer' }]),
    ]);
    const deliveries: string[] = [];
    const { recovery } = countingRecovery('succeeds');
    const input = turnInput({
      streamFn: provider.streamFn,
      llmRetry: { contextOverflowRecovery: recovery },
      hooks: {
        onHistoryChangedHook: [
          async (change) => {
            deliveries.push(change.reason);
            if (change.reason === 'messageDelta' && deliveries.length > 1) {
              throw new Error('history persistence broke mid-turn');
            }
          },
        ],
      },
    });

    // The turn surfaces the failure; nothing is silently re-delivered.
    await new PiTurnRunner().runTurn(input);
    expect(deliveries.length).toBe(2);
  });
});
