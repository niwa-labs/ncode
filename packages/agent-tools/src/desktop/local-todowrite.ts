import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';
import { todoSnapshotKey, updateTodoState } from '@mavis/system-reminder';

import { LocalTodoWriteToolDef, type LocalTodoWriteToolInput } from './builtin-defs.js';
import type { LocalRuntimeToolContext, LocalTodoEventSink } from './types.js';

type TodoItem = LocalTodoWriteToolInput['todos'][number];

const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const todosBySession = new Map<string, TodoItem[]>();
/**
 * M3.1 dupe wave, step 4: armed when a TodoWrite answer was `unchanged`;
 * a second unchanged write with the latch still armed (no other tool or user
 * turn in between — the reminder hook clears it, see
 * clearTodoWriteNoopLatch) is refused with isError instead of another
 * identical answer.
 */
const unchangedLatchBySession = new Map<string, true>();

@bindTool(LocalTodoWriteToolDef)
export class LocalTodoWriteTool implements ToolImpl<
  typeof LocalTodoWriteToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly eventSink?: LocalTodoEventSink) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalTodoWriteToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const active = todos.filter((t) => !TERMINAL_STATUSES.has(t.status)).length;
    const completed = todos.filter((t) => t.status === 'completed').length;
    const cancelled = todos.filter((t) => t.status === 'cancelled').length;

    // M3.1 dupe wave: a snapshot identical to the current one (shared
    // comparator) is a no-op. The cache Map, reminder state and the
    // todo_updated event stream stay untouched — only the answer tells the
    // model there is nothing to rewrite.
    if (todoSnapshotKey(todosBySession.get(ctx.sessionId)) === todoSnapshotKey(todos)) {
      if (unchangedLatchBySession.has(ctx.sessionId)) {
        // Step 4: the previous answer already said `unchanged` and no other
        // tool or user turn ran in between — the feedback was ignored once.
        // Refuse with an error result (the turn continues); the durable
        // projection ignores isError todo records, so state is unaffected.
        const text =
          'unchanged-refused: the list is still identical and the previous TodoWrite answer already said so. ' +
          "Do not call TodoWrite again until a status or item actually changes — continue the work.";
        return {
          tool_name: LocalTodoWriteToolDef.name,
          text,
          content: [{ type: 'text', text }],
          isError: true,
          details: {
            todos,
            total: todos.length,
            active,
            completed,
            cancelled,
            event_emitted: false,
            unchanged: true,
          },
        };
      }
      unchangedLatchBySession.set(ctx.sessionId, true);
      const text = `unchanged: list identical to current (${active} active); don't rewrite until a status/item changes — continue the work`;
      return {
        tool_name: LocalTodoWriteToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          todos,
          total: todos.length,
          active,
          completed,
          cancelled,
          event_emitted: false,
          unchanged: true,
        },
      };
    }

    unchangedLatchBySession.delete(ctx.sessionId);
    if (todos.length === 0) {
      todosBySession.delete(ctx.sessionId);
    } else {
      todosBySession.set(ctx.sessionId, [...todos]);
    }

    try {
      updateTodoState(ctx.sessionId, todos);
    } catch {
      // Reminder state is best-effort and should not block the tool result.
    }

    let eventEmitted = false;
    if (this.eventSink) {
      try {
        eventEmitted = await this.eventSink.emitTodoUpdated(ctx, todos, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        // The structured todo state and tool result are authoritative. A
        // side-stream delivery failure must not fail the provider tool call.
      }
    }

    const text = `updated (${active} active, ${completed} completed). This list supersedes any earlier TodoWrite snapshot shown in reminders.`;
    return {
      tool_name: LocalTodoWriteToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        todos,
        total: todos.length,
        active,
        completed,
        cancelled,
        event_emitted: eventEmitted,
      },
    };
  }
}

export function getLocalSessionTodos(sessionId: string): TodoItem[] {
  const todos = todosBySession.get(sessionId);
  return todos ? [...todos] : [];
}

/**
 * M3.1 dupe wave, step 4: clears the back-to-back unchanged latch. Called by
 * the todo-cadence reminder hook — the observer of the durable history —
 * whenever another tool (or a user turn) ran after the last TodoWrite
 * result, so the refusal stays strictly "no other calls in between".
 */
export function clearTodoWriteNoopLatch(sessionId: string): void {
  unchangedLatchBySession.delete(sessionId);
}

export function isTodoWriteNoopLatchArmed(sessionId: string): boolean {
  return unchangedLatchBySession.has(sessionId);
}

/**
 * Seeds the tool's snapshot cache from the durable todo projection so the
 * first identical write after a restart is recognized as a no-op (M3.1 dupe
 * wave): the Map is only a cache, the durable history is the source of
 * truth. Reconciles stale process-local state, including an empty durable list.
 */
export function seedLocalSessionTodos(
  sessionId: string,
  todos: ReadonlyArray<{ readonly content: string; readonly status: string; readonly priority: string }>,
): void {
  if (todoSnapshotKey(todosBySession.get(sessionId)) === todoSnapshotKey(todos)) return;
  unchangedLatchBySession.delete(sessionId);
  if (todos.length === 0) {
    todosBySession.delete(sessionId);
    return;
  }
  todosBySession.set(
    sessionId,
    todos.map((todo) => ({ content: todo.content, status: todo.status, priority: todo.priority })),
  );
}

export function _resetLocalTodoWriteStateForTests(): void {
  todosBySession.clear();
  unchangedLatchBySession.clear();
}
