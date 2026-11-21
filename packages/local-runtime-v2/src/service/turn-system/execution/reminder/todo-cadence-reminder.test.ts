import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';
import {
  LocalTodoWriteTool,
  _resetLocalTodoWriteStateForTests,
  isTodoWriteNoopLatchArmed,
} from '@mavis/agent-tools/desktop';
import type { LocalRuntimeToolContext } from '@mavis/agent-tools/desktop';
import { describe, expect, it } from 'vitest';

import {
  formatTodoCadenceReminderContent,
  validateCanonicalHistoryMessages,
} from '../../agent-host/history/canonical-history-validation.js';
import { buildCheckpointMessage } from '../../compaction/algorithm/checkpoint-format.js';
import { projectTodoHistory } from '../../compaction/algorithm/todo-cadence.js';
import { TODO_CADENCE_INTERVAL } from '../../compaction/compat.js';
import { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { createTodoCadenceReminderHook } from './todo-cadence-reminder.js';

const MODEL = {
  id: 'test-model',
  name: 'test-model',
  api: 'anthropic-messages',
  provider: 'test-provider',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} as Model<Api>;

const TODO_SNAPSHOT = [
  { content: 'poll the background task', status: 'in_progress', priority: 'high' },
  { content: 'report the result', status: 'pending', priority: 'medium' },
];

const hook = createTodoCadenceReminderHook(new ContextUsageAnchorState());

function message(value: Record<string, unknown>): AgentMessage {
  return value as unknown as AgentMessage;
}

function user(timestamp: number): AgentMessage {
  return message({ role: 'user', content: [{ type: 'text', text: 'go' }], timestamp });
}

function assistant(timestamp: number): AgentMessage {
  return message({
    role: 'assistant',
    content: [{ type: 'text', text: 'working' }],
    stopReason: 'stop',
    provider: MODEL.provider,
    api: MODEL.api,
    model: MODEL.id,
    timestamp,
  });
}

let todoWriteSeq = 0;
function todoWritePair(timestamp: number, todos = TODO_SNAPSHOT): AgentMessage[] {
  todoWriteSeq += 1;
  const callId = `call-todowrite-${todoWriteSeq}`;
  return [
    message({
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name: 'TodoWrite' }],
      stopReason: 'toolUse',
      provider: MODEL.provider,
      api: MODEL.api,
      model: MODEL.id,
      timestamp,
    }),
    message({
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'TodoWrite',
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
      details: { todos },
      timestamp: timestamp + 1,
    }),
  ];
}

function iterations(count: number, startTimestamp: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => assistant(startTimestamp + index));
}

let noOpSeq = 0;
/** A no-op TodoWrite pair: identical snapshot, success result, unchanged flag. */
function noOpTodoWritePair(timestamp: number, todos = TODO_SNAPSHOT): AgentMessage[] {
  noOpSeq += 1;
  const callId = `call-todowrite-noop-${noOpSeq}`;
  return [
    message({
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name: 'TodoWrite' }],
      stopReason: 'toolUse',
      provider: MODEL.provider,
      api: MODEL.api,
      model: MODEL.id,
      timestamp,
    }),
    message({
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'TodoWrite',
      isError: false,
      content: [{ type: 'text', text: 'unchanged: list identical to current (2 active)' }],
      details: { todos, total: todos.length, unchanged: true },
      timestamp: timestamp + 1,
    }),
  ];
}

/** user + TodoWrite snapshot + `count` assistant iterations. */
function turnWithSnapshot(count: number, timestamp = 1): AgentMessage[] {
  return [user(timestamp), ...todoWritePair(timestamp + 1), ...iterations(count, timestamp + 10)];
}

function hookInput(messages: AgentMessage[]): PiBeforeLlmCallHookInput {
  return {
    sessionId: 'ses_todo_cadence_1',
    turnId: 'turn-1',
    phase: 'iteration',
    messages,
    canonicalMessages: messages,
    model: MODEL,
    thinkingLevel: 'off',
    tools: [{ name: 'TodoWrite' }],
  } as PiBeforeLlmCallHookInput;
}

function run(messages: AgentMessage[]): ReturnType<typeof hook> {
  return hook(hookInput(messages));
}

function expectReminder(decision: ReturnType<typeof run>): AgentMessage {
  if (decision?.type !== 'appendMessage') throw new Error('Expected an append decision');
  const marker = decision.message;
  expect(marker).toMatchObject({
    role: 'custom',
    customType: 'todo_cadence_reminder',
    display: false,
  });
  expect(decision.reason).toBe('todo_cadence_reminder');
  expect(marker.content).toBe(formatTodoCadenceReminderContent(marker.details));
  expect(() => validateCanonicalHistoryMessages([marker])).not.toThrow();
  return marker;
}

describe('Todo cadence reminder novelty gate (opus В2, вариант а)', () => {
  it('fires once after TODO_CADENCE_INTERVAL iterations on a fresh snapshot', () => {
    expect(run(turnWithSnapshot(TODO_CADENCE_INTERVAL - 1))).toBeUndefined();
    const marker = expectReminder(run(turnWithSnapshot(TODO_CADENCE_INTERVAL)));
    expect(marker.details.cadence).toEqual({
      assistantIterationsSinceTodoWrite: TODO_CADENCE_INTERVAL,
      assistantIterationsSinceReminder: TODO_CADENCE_INTERVAL,
    });
    // Reminder details keep the exact v1 envelope shape: two counters only.
    expect(Object.keys(marker.details)).toEqual(['version', 'summary', 'todos', 'cadence']);
    expect(Object.keys(marker.details.cadence)).toEqual([
      'assistantIterationsSinceTodoWrite',
      'assistantIterationsSinceReminder',
    ]);
  });

  it('stays silent at iteration 30 and 45 while the todo snapshot is unchanged', () => {
    const history = turnWithSnapshot(TODO_CADENCE_INTERVAL);
    const marker = expectReminder(run(history));

    const at30 = [...history, marker, ...iterations(TODO_CADENCE_INTERVAL, 100)];
    expect(run(at30)).toBeUndefined();

    const at45 = [...at30, ...iterations(TODO_CADENCE_INTERVAL, 200)];
    expect(run(at45)).toBeUndefined();
  });

  it('fires again only after a new TodoWrite plus TODO_CADENCE_INTERVAL iterations', () => {
    const history = turnWithSnapshot(TODO_CADENCE_INTERVAL);
    const firstMarker = expectReminder(run(history));
    const at30 = [...history, firstMarker, ...iterations(TODO_CADENCE_INTERVAL, 100)];
    expect(run(at30)).toBeUndefined();

    // A re-arm needs a real change: an identical rewrite is a no-op and must
    // leave the novelty gate armed (victim-loop regression, M3.1 dupe wave).
    const changedSnapshot = TODO_SNAPSHOT.map((todo, index) =>
      index === 1 ? { ...todo, status: 'completed' } : todo,
    );
    const rewritten = [
      ...at30,
      ...todoWritePair(300, changedSnapshot),
      ...iterations(TODO_CADENCE_INTERVAL, 310),
    ];
    const secondMarker = expectReminder(run(rewritten));
    expect(
      run([...rewritten, secondMarker, ...iterations(TODO_CADENCE_INTERVAL, 400)]),
    ).toBeUndefined();
  });

  it('preserves reminder scheduling across compaction and resume outside summary prose', () => {
    const history = turnWithSnapshot(TODO_CADENCE_INTERVAL);
    const preCompactionMarker = expectReminder(run(history));
    const compacted = [
      ...history,
      preCompactionMarker,
      ...iterations(TODO_CADENCE_INTERVAL, 100),
    ];

    const checkpoint = buildCheckpointMessage(compacted, '## Goal\nKeep going', 100, {
      timestamp: 999,
    });
    // Model prose stays unchanged; host state carries the scheduling gate.
    expect(checkpoint.summary).not.toContain('reminderSinceTodoWrite');
    const resumedProjection = projectTodoHistory([checkpoint]);
    expect(resumedProjection.todoCadence).toEqual({
      assistantIterationsSinceTodoWrite: TODO_CADENCE_INTERVAL,
      assistantIterationsSinceReminder: TODO_CADENCE_INTERVAL,
    });
    expect(resumedProjection.reminderSinceTodoWrite).toBe(true);

    const resumed = [checkpoint, user(1000), ...iterations(TODO_CADENCE_INTERVAL, 1010)];
    expect(run(resumed)).toBeUndefined();
    expect(run([checkpoint, ...iterations(TODO_CADENCE_INTERVAL * 3, 1100)])).toBeUndefined();
  });
});

describe('No-op TodoWrite keeps the cadence gate armed (M3.1 dupe wave)', () => {
  it('does not re-issue the reminder after the victim loop: cadence №1 → no-op → cadence №2', () => {
    // Real victim loop shape (01-session-forensics): a cadence reminder, then
    // the model rewrites the identical snapshot, then enough iterations for a
    // second reminder. The second one must not fire anymore.
    const history = turnWithSnapshot(TODO_CADENCE_INTERVAL);
    const firstMarker = expectReminder(run(history));
    const loop = [
      ...history,
      firstMarker,
      ...noOpTodoWritePair(90),
      ...iterations(TODO_CADENCE_INTERVAL, 100),
    ];
    expect(run(loop)).toBeUndefined();

    const longer = [...loop, ...noOpTodoWritePair(200), ...iterations(TODO_CADENCE_INTERVAL, 210)];
    expect(run(longer)).toBeUndefined();
  });

  it('detects no-op records written before the fix (no unchanged flag) via the comparator', () => {
    const history = turnWithSnapshot(TODO_CADENCE_INTERVAL);
    const firstMarker = expectReminder(run(history));
    // Legacy record: identical snapshot, plain success text, no details.unchanged.
    const [call, result] = noOpTodoWritePair(90);
    const legacyResult = { ...(result as object), details: { todos: TODO_SNAPSHOT } };
    const loop = [
      ...history,
      firstMarker,
      call,
      legacyResult as AgentMessage,
      ...iterations(TODO_CADENCE_INTERVAL, 100),
    ];
    expect(run(loop)).toBeUndefined();
  });

  it('still resets the counters on a real change after a no-op series', () => {
    const history = turnWithSnapshot(TODO_CADENCE_INTERVAL);
    const firstMarker = expectReminder(run(history));
    const withNoOp = [
      ...history,
      firstMarker,
      ...noOpTodoWritePair(90),
      ...iterations(3, 95),
    ];
    expect(run(withNoOp)).toBeUndefined();

    const changed = TODO_SNAPSHOT.map((todo, index) =>
      index === 1 ? { ...todo, status: 'completed' } : todo,
    );
    const projection = projectTodoHistory([
      ...withNoOp,
      ...todoWritePair(120, changed),
      ...iterations(TODO_CADENCE_INTERVAL, 130),
    ]);
    expect(projection.reminderSinceTodoWrite).toBe(false);
    expect(projection.todoCadence?.assistantIterationsSinceTodoWrite).toBe(
      TODO_CADENCE_INTERVAL,
    );
  });

  it('keeps cadence counters across a no-op series without checkpoint format changes', () => {
    const base = [user(1), ...todoWritePair(2), ...iterations(3, 10)];
    const withNoOp = [...base, ...noOpTodoWritePair(20), ...iterations(4, 30)];
    const projection = projectTodoHistory(withNoOp);
    // The no-op write must not zero the counter: 3 iterations after the real
    // write, the no-op's own assistant step, then 4 more — 8, not a reset
    // followed by 5.
    expect(projection.todoCadence?.assistantIterationsSinceTodoWrite).toBe(8);
    expect(projection.reminderSinceTodoWrite).toBe(false);

    const checkpoint = buildCheckpointMessage(withNoOp, '## Goal\nKeep going', 100, {
      timestamp: 999,
    });
    expect(checkpoint.summary).not.toContain('reminderSinceTodoWrite');
  });
});

describe('Back-to-back unchanged latch clearing (M3.1 dupe wave, step 4)', () => {
  const armedSession = 'ses_todo_latch_1';

  function bashPair(timestamp: number): AgentMessage[] {
    return [
      message({
        role: 'assistant',
        content: [{ type: 'toolCall', id: `call-bash-${timestamp}`, name: 'bash' }],
        stopReason: 'toolUse',
        provider: MODEL.provider,
        api: MODEL.api,
        model: MODEL.id,
        timestamp,
      }),
      message({
        role: 'toolResult',
        toolCallId: `call-bash-${timestamp}`,
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        timestamp: timestamp + 1,
      }),
    ];
  }

  function runHook(sessionId: string, messages: AgentMessage[]) {
    return hook({
      sessionId,
      turnId: 'turn-1',
      phase: 'iteration',
      messages,
      canonicalMessages: messages,
      model: MODEL,
      thinkingLevel: 'off',
      tools: [{ name: 'TodoWrite' }],
    } as PiBeforeLlmCallHookInput);
  }

  it('keeps the latch armed while the last tool activity is the unchanged TodoWrite', async () => {
    _resetLocalTodoWriteStateForTests();
    const tool = new LocalTodoWriteTool();
    await tool.execute({ sessionId: armedSession } as LocalRuntimeToolContext, {
      todos: TODO_SNAPSHOT,
    });
    await tool.execute({ sessionId: armedSession } as LocalRuntimeToolContext, {
      todos: TODO_SNAPSHOT.map((todo) => ({ ...todo })),
    });
    expect(isTodoWriteNoopLatchArmed(armedSession)).toBe(true);

    const history = [user(1), ...noOpTodoWritePair(2)];
    runHook(armedSession, history);
    expect(isTodoWriteNoopLatchArmed(armedSession)).toBe(true);
  });

  it('clears the latch when a bash result follows the last TodoWrite result', async () => {
    _resetLocalTodoWriteStateForTests();
    const tool = new LocalTodoWriteTool();
    await tool.execute({ sessionId: armedSession } as LocalRuntimeToolContext, {
      todos: TODO_SNAPSHOT,
    });
    await tool.execute({ sessionId: armedSession } as LocalRuntimeToolContext, {
      todos: TODO_SNAPSHOT.map((todo) => ({ ...todo })),
    });
    expect(isTodoWriteNoopLatchArmed(armedSession)).toBe(true);

    const history = [user(1), ...noOpTodoWritePair(2), ...bashPair(10)];
    runHook(armedSession, history);
    expect(isTodoWriteNoopLatchArmed(armedSession)).toBe(false);

    // The rewrite after the foreign tool is an ordinary unchanged answer again.
    const result = await tool.execute(
      { sessionId: armedSession } as LocalRuntimeToolContext,
      { todos: TODO_SNAPSHOT.map((todo) => ({ ...todo })) },
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ unchanged: true });
  });

  it('clears the latch when a user turn follows the last TodoWrite result', async () => {
    _resetLocalTodoWriteStateForTests();
    const tool = new LocalTodoWriteTool();
    await tool.execute({ sessionId: armedSession } as LocalRuntimeToolContext, {
      todos: TODO_SNAPSHOT,
    });
    await tool.execute({ sessionId: armedSession } as LocalRuntimeToolContext, {
      todos: TODO_SNAPSHOT.map((todo) => ({ ...todo })),
    });

    const history = [user(1), ...noOpTodoWritePair(2), user(10)];
    runHook(armedSession, history);
    expect(isTodoWriteNoopLatchArmed(armedSession)).toBe(false);
  });
});
