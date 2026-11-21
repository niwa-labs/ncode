/**
 * W06 — host `wrapStreamFn` composition over the MAIN stream path.
 *
 * The cache-warming seam: the host wrapper composes OUTERMOST around the
 * fully built product chain and must observe the SAME `(model, context,
 * options)` triple the transport receives, delegating verbatim. This pins:
 * - the wrapper IS in the main request path (called once per physical
 *   provider request of the turn);
 * - argument identity is preserved end-to-end (the observation contract
 *   `withCacheWarming` relies on — no copy, no re-serialization);
 * - the turn still completes normally through the wrapped chain.
 */

import { describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';

import { PiTurnRunner } from '../../../src/pi-turn-runner/pi-turn-runner.js';
import type { RuntimeEvent, RunTurnInput } from '../../../src/pi-turn-runner/types.js';
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

interface ObservedCall {
  model: unknown;
  context: unknown;
  options: unknown;
}

describe('W06 host wrapStreamFn (outermost MAIN-stream composition)', () => {
  it('observes the transport triple verbatim and stays on the request path', async () => {
    const observed: ObservedCall[] = [];
    const transportArgs: unknown[][] = [];
    const inner: StreamFn = (requestModel, context, options) => {
      transportArgs.push([requestModel, context, options]);
      const response: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'warmed path answer' }],
        api: 'openai-responses',
        provider: 'openai',
        model: 'mock',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: 'stop', message: response });
      });
      return stream;
    };
    const wrapped: StreamFn = (requestModel, context, options) => {
      observed.push({ model: requestModel, context, options });
      return inner(requestModel, context, options);
    };

    let captures = 0;
    let replayTransport: StreamFn | undefined;
    let forkTransport: StreamFn | undefined;
    const events: RuntimeEvent[] = [];
    const input: RunTurnInput<ToolExecutionContext> = {
      sessionId: 'session-w06',
      turnId: 'turn-w06',
      workspaceDir: '/tmp/w06',
      systemPrompt: 'w06 test',
      userMessage: { text: 'hello' },
      llm: { model, streamFn: inner },
      eventWriter: {
        appendEvents(batch) {
          events.push(...batch);
        },
        pushRuntime(event) {
          events.push(event);
        },
      },
      toolConfig: {
        tools: [],
        disableBuiltinToolFallback: true,
        context: { sessionId: 'session-w06', turnId: 'turn-w06' },
      },
      contextWire: {
        project: () => undefined,
        wrapStreamFn: (base, main = base) => {
          forkTransport = base;
          return (requestModel, context, options) => {
            captures += 1;
            return main(requestModel, context, options);
          };
        },
      },
      wrapStreamFn: (base) => { replayTransport = base; return wrapped; },
    };

    await new PiTurnRunner().runTurn(input);

    // The wrapper sat in the main request path exactly once (one physical
    // request for a plain-text turn) and the transport saw the very same
    // argument objects the wrapper observed — verbatim delegation.
    expect(observed).toHaveLength(1);
    expect(transportArgs).toHaveLength(1);
    expect(transportArgs[0]![0]).toBe(observed[0]!.model);
    expect(transportArgs[0]![1]).toBe(observed[0]!.context);
    expect(transportArgs[0]![2]).toBe(observed[0]!.options);
    expect(events.length).toBeGreaterThan(0);
    expect(captures).toBe(1);
    const context = observed[0]!.context as Parameters<StreamFn>[1];
    // Neither a keep-alive replay nor an auxiliary summary may replace the
    // real main snapshot or recursively start the cache-warmer observer.
    await (await replayTransport!(model, context, {})).result();
    await (await forkTransport!(model, context, {})).result();
    expect(captures).toBe(1);
    expect(observed).toHaveLength(1);
    expect(transportArgs).toHaveLength(3);
  });
});
