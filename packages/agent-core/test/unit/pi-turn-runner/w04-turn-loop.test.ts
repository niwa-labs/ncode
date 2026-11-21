/**
 * W04 part A — turn-loop migration regressions (product surface).
 *
 * Covers the host-side migration of the six §5.1 seam behaviors onto the
 * pin-native turn cycle (finishTurn/prepareRequest/steering) and the pin tool
 * contract (structuredContent/usage/isError/outputSchema/durationMs):
 *
 * - shouldStopAfterTurn → finishTurn: true → end (no queue consumption, one
 *   request), false → undefined scheduling (never an extra request);
 * - finishTurn observes the FINAL tool results of the step (before turn_end);
 * - canonical request snapshot at EVERY prepareRequest boundary (first
 *   included), supplier failures degrade, boundary-minted ids are enforced;
 * - the pin tool contract flows through the RuntimeTool adapter;
 * - immediate-send steering batches stay atomic (steerBatch seam).
 */

import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import type {
  AgentContext,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, TranscriptContext, Usage } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';

import { PiTurnRunner } from '../../../src/pi-turn-runner/pi-turn-runner.js';
import type {
  CanonicalRequestSnapshot,
  PrepareRequestSnapshotContext,
} from '../../../src/pi-turn-runner/request-snapshot.js';
import { createRequestSnapshotBoundary } from '../../../src/pi-turn-runner/request-snapshot.js';
import type { RuntimeEvent, RunTurnInput } from '../../../src/pi-turn-runner/types.js';
import type { RuntimeTool, ToolExecutionContext } from '../../../src/tools/index.js';

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

interface ScriptedProvider {
  streamFn: StreamFn;
  requests: string[];
}

/** Scripted provider: each call records the transcript it saw and pops one response. */
function scriptedProvider(responses: AssistantMessage[]): ScriptedProvider {
  const requests: string[] = [];
  const streamFn: StreamFn = (_model, context: TranscriptContext) => {
    requests.push(JSON.stringify(context.messages));
    const response = responses.shift() ?? assistant([{ type: 'text', text: 'done' }]);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: response.stopReason, message: response });
    });
    return stream;
  };
  return { streamFn, requests };
}

function toolCallBlock(id: string, name: string, arguments_: Record<string, unknown>) {
  return { type: 'toolCall' as const, id, name, arguments: arguments_ };
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

interface TurnFixture {
  input: RunTurnInput<ToolExecutionContext>;
  events: RuntimeEvent[];
}

function turnInput(
  overrides: Partial<RunTurnInput<ToolExecutionContext>> & { streamFn: StreamFn },
): TurnFixture {
  const events: RuntimeEvent[] = [];
  const input: RunTurnInput<ToolExecutionContext> = {
    sessionId: 'session-w04',
    turnId: 'turn-w04',
    workspaceDir: '/tmp/w04',
    systemPrompt: 'w04 test',
    userMessage: { text: 'hello' },
    llm: { model, streamFn: overrides.streamFn },
    eventWriter: collectWriter(events),
    toolConfig: {
      tools: overrides.toolConfig?.tools ?? [],
      disableBuiltinToolFallback: true,
      context: { sessionId: 'session-w04', turnId: 'turn-w04' },
    },
    ...overrides,
  };
  return { input: { ...input, ...overrides }, events };
}

describe('W04 shouldStopAfterTurn → finishTurn migration (§5.1 row 32)', () => {
  it('true ends the run after the tool step without consuming queued steering', async () => {
    const provider = scriptedProvider([
      assistant([toolCallBlock('tc1', 'noop', {})], 'toolUse'),
    ]);
    const stopCalls: unknown[][] = [];
    const { input, events } = turnInput({
      streamFn: provider.streamFn,
      toolConfig: {
        tools: [noopTool()],
        disableBuiltinToolFallback: true,
        context: { sessionId: 'session-w04', turnId: 'turn-w04' },
      },
      shouldStopAfterTurn: (...args) => {
        stopCalls.push(args);
        return true;
      },
      getSteeringMessages: async () => [
        { role: 'user', content: [{ type: 'text', text: 'queued while running' }], timestamp: 1 },
      ],
    });

    await new PiTurnRunner().runTurn(input);

    // One provider request; the steering poll happens before the request but
    // the end decision wins before any post-turn queue consumption.
    expect(provider.requests).toHaveLength(1);
    expect(stopCalls).toHaveLength(1);
    // finishTurn observed the FINAL tool result of the step (row 32: после
    // всех tool results, до turn_end).
    const turn = stopCalls[0]![0] as { toolResults: { toolCallId: string }[] };
    expect(turn.toolResults).toHaveLength(1);
    expect(turn.toolResults[0]).toMatchObject({ toolCallId: 'tc1' });
    expect(events.length).toBeGreaterThan(0);
  });

  it('false preserves normal scheduling — no extra request, no continuation', async () => {
    const provider = scriptedProvider([assistant([{ type: 'text', text: 'answer' }])]);
    const { input } = turnInput({
      streamFn: provider.streamFn,
      shouldStopAfterTurn: () => false,
    });

    await new PiTurnRunner().runTurn(input);

    // false ≠ continue: a plain-text turn ends the run after exactly one request.
    expect(provider.requests).toHaveLength(1);
  });

  it('false with pending tool calls still follows the tool chain', async () => {
    const provider = scriptedProvider([
      assistant([toolCallBlock('tc1', 'noop', {})], 'toolUse'),
      assistant([{ type: 'text', text: 'after tool' }]),
    ]);
    const { input } = turnInput({
      streamFn: provider.streamFn,
      toolConfig: {
        tools: [noopTool()],
        disableBuiltinToolFallback: true,
        context: { sessionId: 'session-w04', turnId: 'turn-w04' },
      },
      shouldStopAfterTurn: () => false,
    });

    await new PiTurnRunner().runTurn(input);

    expect(provider.requests).toHaveLength(2);
  });
});

describe('W04 canonical request snapshot boundary (prepareRequest, W03 C3)', () => {
  function snapshot(
    requestId: string,
    head: number,
    route: { provider: string; modelId: string } | null = { provider: 'openai', modelId: 'mock' },
  ): CanonicalRequestSnapshot {
    return {
      requestId,
      sessionId: 'session-w04',
      revision: {
        conversationId: 'pi.conv.1',
        rootId: 'pi.root.1',
        head,
        watermark: head,
        schemaVersion: 2,
        editVersion: 0,
        windowBytes: 1024,
      },
      tokenEstimate: 64,
      route,
    };
  }

  it('takes exactly one snapshot per logical request — first included', async () => {
    const provider = scriptedProvider([
      assistant([toolCallBlock('tc1', 'noop', {})], 'toolUse'),
      assistant([{ type: 'text', text: 'after tool' }]),
    ]);
    const supplier = vi.fn(async (context: PrepareRequestSnapshotContext) =>
      snapshot(context.requestId, context.requestIndex + 1),
    );
    const { input } = turnInput({
      streamFn: provider.streamFn,
      toolConfig: {
        tools: [noopTool()],
        disableBuiltinToolFallback: true,
        context: { sessionId: 'session-w04', turnId: 'turn-w04' },
      },
      prepareRequestSnapshot: supplier,
    });

    await new PiTurnRunner().runTurn(input);

    expect(provider.requests).toHaveLength(2);
    expect(supplier).toHaveBeenCalledTimes(2);
    expect(supplier.mock.calls[0]![0]).toMatchObject({ requestIndex: 0, phase: 'first' });
    expect(supplier.mock.calls[1]![0]).toMatchObject({ requestIndex: 1, phase: 'next' });
    expect(supplier.mock.calls[0]![0].requestId).toBe('turn-w04#req0');
    expect(supplier.mock.calls[1]![0].requestId).toBe('turn-w04#req1');
  });

  it('a throwing supplier degrades without failing the turn (legacy-safe)', async () => {
    const provider = scriptedProvider([assistant([{ type: 'text', text: 'ok' }])]);
    const { input } = turnInput({
      streamFn: provider.streamFn,
      prepareRequestSnapshot: () => {
        throw new Error('projection bridge unavailable');
      },
    });

    await expect(new PiTurnRunner().runTurn(input)).resolves.toBeUndefined();
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects snapshots that do not adopt the boundary-minted request id', async () => {
    const provider = scriptedProvider([assistant([{ type: 'text', text: 'ok' }])]);
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
    };
    const { input } = turnInput({
      streamFn: provider.streamFn,
      prepareRequestSnapshot: async () => snapshot('foreign-id', 1),
    });

    await new PiTurnRunner({ logger }).runTurn(input);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'turn_request_snapshot_rejected',
        reason: 'request_id_mismatch',
      }),
      expect.any(String),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'turn_request_snapshot' }),
      expect.any(String),
    );
  });

  it('absent supplier leaves the pin hook unset (legacy default unchanged)', () => {
    const boundary = createRequestSnapshotBoundary({
      sessionId: 's',
      turnId: 't',
      logger: {},
    });
    expect(boundary.prepareRequest).toBeUndefined();
    expect(boundary.snapshots()).toEqual([]);
  });

  it('logs route changes between consecutive snapshots', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const boundary = createRequestSnapshotBoundary({
      sessionId: 's',
      turnId: 't',
      logger,
      supplier: async (context) =>
        snapshot(context.requestId, 1, context.requestIndex === 0
          ? { provider: 'openai', modelId: 'mock' }
          : { provider: 'anthropic', modelId: 'other' }),
    });
    const invoke = boundary.prepareRequest!;
    await invoke({ context: { messages: [] }, model, thinkingLevel: 'off' as ThinkingLevel });
    await invoke({ context: { messages: [] }, model, thinkingLevel: 'off' as ThinkingLevel });
    expect(boundary.snapshots()).toHaveLength(2);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls[0]![0]).not.toHaveProperty('route_changed');
    expect(logger.info.mock.calls[1]![0]).toMatchObject({ route_changed: true });
  });
});

describe('W04 pin tool contract through the RuntimeTool adapter', () => {
  it.each([false, true])('maps structuredContent/usage/isError and declares outputSchema (named sections: %s)', async (namedSections) => {
    const toolUsage = usage();
    const runtime: RuntimeTool = {
      def: {
        name: 'structured',
        description: 'structured tool',
        schema: Type.Object({ q: Type.String() }),
        outputSchema: Type.Object({ answer: Type.String() }),
        executionMode: 'sequential',
      },
      impl: {
        execute: async () => ({
          tool_name: 'structured',
          text: 'for the model',
          content: [{ type: 'text', text: 'for the model' }],
          isError: false,
          structuredContent: { answer: 'for the caller' },
          usage: toolUsage,
        }),
      },
    };
    // Re-create the wrapped AgentTool the way newTools does (without the
    // builtin fallback) by exercising a full tool turn through the runner.
    const provider = scriptedProvider([
      assistant([toolCallBlock('tc9', 'structured', { q: 'hi' })], 'toolUse'),
      assistant([{ type: 'text', text: 'done' }]),
    ]);
    const observed: AgentMessage[] = [];
    const { input } = turnInput({
      ...(namedSections ? { systemPromptSections: { identity: 'w04 test' } } : {}),
      streamFn: async (m, context, options) => {
        observed.push(...(context as unknown as { messages: AgentMessage[] }).messages);
        return provider.streamFn(m, context, options);
      },
      toolConfig: {
        tools: [runtime],
        disableBuiltinToolFallback: true,
        context: { sessionId: 'session-w04', turnId: 'turn-w04' },
      },
    });

    await new PiTurnRunner().runTurn(input);

    expect(provider.requests).toHaveLength(2);
    const toolResult = observed.find((message) => message.role === 'toolResult');
    expect(toolResult).toMatchObject({
      toolCallId: 'tc9',
      isError: false,
      usage: toolUsage,
      content: [{ type: 'text', text: 'for the model' }],
    });
  });

  it('direct adapter mapping: newTool() output carries the full pin contract', async () => {
    // Directly exercise the adapter's execute() mapping (unit-level).
    const { newTools } = await import('../../../src/pi-turn-runner/tools.js');
    const toolUsage = usage();
    const runtime: RuntimeTool = {
      def: {
        name: 'direct',
        description: 'direct tool',
        schema: Type.Object({}),
        outputSchema: Type.Object({ v: Type.Number() }),
      },
      impl: {
        execute: async () => ({
          tool_name: 'direct',
          text: 'x',
          content: [{ type: 'text', text: 'x' }],
          isError: true,
          structuredContent: { v: 7 },
          usage: toolUsage,
        }),
      },
    };
    const tools = newTools('/tmp', [runtime], { sessionId: 's', turnId: 't' } as ToolExecutionContext, {
      disableBuiltinToolFallback: true,
    });
    const agentTool = tools.find((tool) => tool.name === 'direct') as AgentTool;
    expect(agentTool.outputSchema).toBeDefined();
    const result: AgentToolResult<Record<string, unknown>> = await agentTool.execute(
      'call-1',
      {} as never,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { v: 7 },
      usage: toolUsage,
      content: [{ type: 'text', text: 'x' }],
    });
  });
});

describe('W04 immediate-send steering batches stay atomic (§5.1 row 44 via runner)', () => {
  it('delivers an immediate-send batch in one boundary and the next request sees both texts', async () => {
    const provider = scriptedProvider([
      assistant([{ type: 'text', text: 'first answer' }]),
      assistant([{ type: 'text', text: 'second answer' }]),
    ]);
    let polls = 0;
    const { input } = turnInput({
      streamFn: provider.streamFn,
      getSteeringMessages: async () => {
        polls += 1;
        if (polls > 1) return [];
        return [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'immediate one' }],
            timestamp: 1,
            hostMetadata: { immediateSendBatchId: 'batch-1' },
          },
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'immediate two' }],
            timestamp: 2,
            hostMetadata: { immediateSendBatchId: 'batch-1' },
          },
        ];
      },
    });

    await new PiTurnRunner().runTurn(input);

    // Turn 1 consumes the batch atomically (steerBatch seam): one extra request
    // total, and BOTH batch members ride in it.
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]).toContain('immediate one');
    expect(provider.requests[1]).toContain('immediate two');
  });
});

function noopTool(): RuntimeTool {
  return {
    def: {
      name: 'noop',
      description: 'no-op',
      schema: Type.Object({}),
      executionMode: 'sequential',
    },
    impl: {
      execute: async () => ({
        tool_name: 'noop',
        text: 'noop done',
        content: [{ type: 'text', text: 'noop done' }],
      }),
    },
  };
}

// AgentContext import keeps the transcript typing honest for the observed list.
export type __keepAgentContext = AgentContext;


describe('native Pi named prompt section integration', () => {
  it('persists deltas before requests and replays them across fresh runner instances', async () => {
    const persisted: AgentMessage[] = [];
    const run = async (sections: Record<string, string>, options: Partial<RunTurnInput<ToolExecutionContext>> = {}) => {
      const provider = scriptedProvider([assistant([{ type: 'text', text: 'done' }])]);
      const { input } = turnInput({
        streamFn: provider.streamFn,
        systemPrompt: Object.values(sections).join('\n\n'),
        systemPromptSections: sections,
        history: [...persisted],
        hooks: { onHistoryChangedHook: [async (change) => {
          if (change.reason === 'replaceMessages') persisted.splice(0, persisted.length, ...change.messages);
          else persisted.push(...change.messages);
        }] },
        ...options,
      });
      await new PiTurnRunner().runTurn(input);
      expect(provider.requests).toHaveLength(1);
      return JSON.parse(provider.requests[0]!) as AgentMessage[];
    };
    const first = await run({ identity: 'Identity', memory: 'old fact', project: 'Rules' });
    expect(first.find((message) => message.role === 'system' && message.sections)).toMatchObject({
      sections: { identity: 'Identity', memory: 'old fact', project: 'Rules' },
    });
    const initial = persisted.filter((message) => message.role === 'system');
    expect(initial).toHaveLength(1);
    await run({ identity: 'Identity', memory: 'old fact', project: 'Rules' });
    expect(persisted.filter((message) => message.role === 'system')).toHaveLength(1);
    await run({ identity: 'Identity', memory: 'new fact', project: 'Rules' });
    const patches = persisted.filter((message) => message.role === 'system');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({ content: '', sections: { memory: 'new fact' } });
    await run({ identity: 'Identity', project: 'Rules' }, { startMode: 'continue' });
    expect(persisted.filter((message) => message.role === 'system').at(-1)).toMatchObject({
      sections: { memory: null },
    });
  });

  it('keeps a replay baseline when a compaction hook replaces history', async () => {
    const provider = scriptedProvider([assistant([{ type: 'text', text: 'after compaction' }])]);
    const committed: AgentMessage[][] = [];
    const { input } = turnInput({
      streamFn: provider.streamFn,
      systemPrompt: 'Identity\n\nRemember the project',
      systemPromptSections: { identity: 'Identity', memory: 'Remember the project' },
      hooks: {
        beforeLlmCallHook: [async () => ({ type: 'replaceMessages',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Retained user' }], timestamp: 3 }],
          metadata: { replacementId: 'native-compaction', strategyVersion: 'test', summary: 'summary',
            compactedMessages: [], keptMessages: [], firstKeptIndex: 0 },
        })],
        onHistoryChangedHook: [async (change) => {
          if (change.reason === 'replaceMessages') committed.push(change.messages);
        }],
      },
    });
    await new PiTurnRunner().runTurn(input);
    expect(committed).toHaveLength(1);
    expect(committed[0]![0]).toMatchObject({ role: 'system', sections: {
      identity: 'Identity', memory: 'Remember the project',
    } });
    expect(provider.requests[0]).toContain('Remember the project');
  });
});
