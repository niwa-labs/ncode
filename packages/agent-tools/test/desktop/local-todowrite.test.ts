import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  LocalTodoWriteTool,
  _resetLocalTodoWriteStateForTests,
  clearTodoWriteNoopLatch,
  getLocalSessionTodos,
  isTodoWriteNoopLatchArmed,
  seedLocalSessionTodos,
} from '../../src/desktop/local-todowrite.js';
import { _resetTodoStateForTests, getTodoState } from '@mavis/system-reminder';
import type { LocalRuntimeToolContext, LocalTodoEventSink } from '../../src/desktop/types.js';

const TODOWRITE = 'todowrite';
const UNCHANGED_PREFIX = 'unchanged: list identical to current';
const SUPERSEDE_SENTENCE =
  'This list supersedes any earlier TodoWrite snapshot shown in reminders.';

const TODOS = [
  { content: 'poll the background task', status: 'in_progress', priority: 'high' },
  { content: 'report the result', status: 'pending', priority: 'medium' },
];

function context(sessionId = 'ses_todowrite_1'): LocalRuntimeToolContext {
  return { sessionId, turnId: 'turn-1', toolCallId: 'call-1', agentName: 'mavis' };
}

function sink(): LocalTodoEventSink & { emitTodoUpdated: ReturnType<typeof vi.fn> } {
  return { emitTodoUpdated: vi.fn(async () => true) };
}

beforeEach(() => {
  _resetLocalTodoWriteStateForTests();
  _resetTodoStateForTests();
});

describe('LocalTodoWriteTool no-op detection (M3.1 dupe wave)', () => {
  it('answers unchanged for an identical snapshot and touches no state', async () => {
    const eventSink = sink();
    const tool = new LocalTodoWriteTool(eventSink);
    const first = await tool.execute(context(), { todos: TODOS });
    expect(first.text).toContain(SUPERSEDE_SENTENCE);
    expect(eventSink.emitTodoUpdated).toHaveBeenCalledTimes(1);

    const result = await tool.execute(context(), { todos: [...TODOS] });
    expect(result.tool_name).toBe(TODOWRITE);
    expect(result.text).toBe(
      'unchanged: list identical to current (2 active); don\'t rewrite until a status/item changes — continue the work',
    );
    expect(result.content).toEqual([{ type: 'text', text: result.text }]);
    expect(result.details).toMatchObject({
      total: 2,
      active: 2,
      completed: 0,
      cancelled: 0,
      event_emitted: false,
      unchanged: true,
    });
    expect(eventSink.emitTodoUpdated).toHaveBeenCalledTimes(1);
    // The reminder state still holds the record from the real write only.
    expect(getTodoState('ses_todowrite_1')).toBeDefined();
  });

  it('treats reordered JSON keys as an identical snapshot', async () => {
    const tool = new LocalTodoWriteTool();
    await tool.execute(context(), { todos: TODOS });
    const reorderedKeys = TODOS.map((todo) => ({
      priority: todo.priority,
      status: todo.status,
      content: todo.content,
    }));
    const result = await tool.execute(context(), { todos: reorderedKeys });
    expect(result.details).toMatchObject({ unchanged: true });
    expect(result.text).toContain(UNCHANGED_PREFIX);
  });

  it('treats whitespace-only differences as an identical snapshot', async () => {
    const tool = new LocalTodoWriteTool();
    await tool.execute(context(), { todos: TODOS });
    const padded = TODOS.map((todo) => ({ ...todo, content: `  ${todo.content}\t` }));
    const result = await tool.execute(context(), { todos: padded });
    expect(result.details).toMatchObject({ unchanged: true });
  });

  it('reports updated with the supersede sentence on a real status change', async () => {
    const eventSink = sink();
    const tool = new LocalTodoWriteTool(eventSink);
    await tool.execute(context(), { todos: TODOS });
    const changed = TODOS.map((todo, index) =>
      index === 1 ? { ...todo, status: 'completed' } : todo,
    );
    const result = await tool.execute(context(), { todos: changed });
    expect(result.text).toBe(
      'updated (1 active, 1 completed). ' + SUPERSEDE_SENTENCE,
    );
    expect(result.details).toMatchObject({
      total: 2,
      active: 1,
      completed: 1,
      event_emitted: true,
    });
    expect(result.details).not.toHaveProperty('unchanged', true);
    expect(eventSink.emitTodoUpdated).toHaveBeenCalledTimes(2);
    expect(getLocalSessionTodos('ses_todowrite_1')).toEqual(changed);
  });

  it('reports updated when an item is added or removed', async () => {
    const tool = new LocalTodoWriteTool();
    await tool.execute(context(), { todos: TODOS });
    const removed = await tool.execute(context(), { todos: TODOS.slice(0, 1) });
    expect(removed.text).toContain(SUPERSEDE_SENTENCE);
    expect(removed.details).not.toHaveProperty('unchanged', true);
  });

  it('treats empty-to-empty as unchanged', async () => {
    const tool = new LocalTodoWriteTool();
    const result = await tool.execute(context(), { todos: [] });
    expect(result.text).toBe(
      'unchanged: list identical to current (0 active); don\'t rewrite until a status/item changes — continue the work',
    );
    expect(result.details).toMatchObject({ total: 0, active: 0, unchanged: true });
  });

  it('clearing a non-empty list is a real change', async () => {
    const tool = new LocalTodoWriteTool();
    await tool.execute(context(), { todos: TODOS });
    const result = await tool.execute(context(), { todos: [] });
    expect(result.text).toBe(
      'updated (0 active, 0 completed). ' + SUPERSEDE_SENTENCE,
    );
    expect(getLocalSessionTodos('ses_todowrite_1')).toEqual([]);
  });
});

describe('LocalTodoWriteTool back-to-back unchanged refusal (M3.1 dupe wave, step 4)', () => {
  it('refuses the second consecutive unchanged write with isError and keeps refusing', async () => {
    const eventSink = sink();
    const tool = new LocalTodoWriteTool(eventSink);
    await tool.execute(context(), { todos: TODOS });

    const first = await tool.execute(context(), { todos: [...TODOS] });
    expect(first.isError).toBeUndefined();
    expect(isTodoWriteNoopLatchArmed('ses_todowrite_1')).toBe(true);

    const second = await tool.execute(context(), { todos: [...TODOS] });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('unchanged-refused');
    expect(second.text).toContain('previous TodoWrite answer already said so');
    expect(second.details).toMatchObject({ unchanged: true, event_emitted: false });
    expect(eventSink.emitTodoUpdated).toHaveBeenCalledTimes(1);

    const third = await tool.execute(context(), { todos: [...TODOS] });
    expect(third.isError).toBe(true);
  });

  it('does not refuse when another tool or user turn ran in between (hook clears the latch)', async () => {
    const tool = new LocalTodoWriteTool();
    await tool.execute(context(), { todos: TODOS });
    await tool.execute(context(), { todos: [...TODOS] });
    expect(isTodoWriteNoopLatchArmed('ses_todowrite_1')).toBe(true);

    // The reminder hook calls this when the durable history shows a foreign
    // tool result (e.g. bash) or a user turn after the last TodoWrite.
    clearTodoWriteNoopLatch('ses_todowrite_1');
    const result = await tool.execute(context(), { todos: [...TODOS] });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ unchanged: true });
  });

  it('disarms the latch on a real change', async () => {
    const tool = new LocalTodoWriteTool();
    const changed = TODOS.map((todo, index) =>
      index === 1 ? { ...todo, status: 'completed' } : todo,
    );
    await tool.execute(context(), { todos: TODOS });
    await tool.execute(context(), { todos: [...TODOS] });
    expect(isTodoWriteNoopLatchArmed('ses_todowrite_1')).toBe(true);

    await tool.execute(context(), { todos: changed });
    expect(isTodoWriteNoopLatchArmed('ses_todowrite_1')).toBe(false);
    const result = await tool.execute(context(), { todos: [...changed] });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ unchanged: true });
  });
});

describe('seedLocalSessionTodos (restart survival)', () => {
  it('an identical write after seeding from durable history reads as unchanged', async () => {
    // Fresh module state: the daemon restarted, the Map cache is empty, the
    // snapshot only exists in the durable projection.
    const tool = new LocalTodoWriteTool();
    seedLocalSessionTodos('ses_todowrite_2', [
      { content: 'poll the background task', status: 'in_progress', priority: 'high' },
      { content: 'report the result', status: 'pending', priority: 'medium' },
    ]);
    const result = await tool.execute(context('ses_todowrite_2'), { todos: [...TODOS] });
    expect(result.details).toMatchObject({ unchanged: true });
  });

  it('durable projection replaces a stale process-local cache entry', async () => {
    const tool = new LocalTodoWriteTool();
    const changed = TODOS.map((todo, index) =>
      index === 1 ? { ...todo, status: 'completed' } : todo,
    );
    await tool.execute(context('ses_todowrite_3'), { todos: changed });
    seedLocalSessionTodos('ses_todowrite_3', TODOS);
    // Only the durable projection owns truth; the cache cannot override it.
    const result = await tool.execute(context('ses_todowrite_3'), { todos: [...TODOS] });
    expect(result.details).toMatchObject({ unchanged: true });
  });

  it('seeds nothing for an empty projection', () => {
    seedLocalSessionTodos('ses_todowrite_4', []);
    expect(getLocalSessionTodos('ses_todowrite_4')).toEqual([]);
  });
});
