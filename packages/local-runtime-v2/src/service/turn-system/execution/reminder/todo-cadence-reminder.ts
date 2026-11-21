import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiBeforeLlmCallHook } from '@mavis/agent-core/pi-turn-runner';
import { clearTodoWriteNoopLatch, seedLocalSessionTodos } from '@mavis/agent-tools/desktop';
import { summarizeTodoStatuses } from '@mavis/system-reminder';

import { formatTodoCadenceReminderContent } from '../../agent-host/history/canonical-history-validation.js';
import {
  TODO_CADENCE_REMINDER_CUSTOM_TYPE,
  projectTodoHistory,
} from '../../compaction/algorithm/todo-cadence.js';
import { TODO_CADENCE_INTERVAL } from '../../compaction/compat.js';
import type { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';

/**
 * Reminder eligibility is derived from durable facts and the host checkpoint.
 * A changed todo snapshot re-arms the cadence; compaction and unchanged writes
 * preserve it. No model-generated summary text decides whether work is open.
 */
export function createTodoCadenceReminderHook(
  usageAnchor: ContextUsageAnchorState,
): PiBeforeLlmCallHook {
  return (input) => {
    if (!input.tools?.some((tool) => tool.name.toLowerCase() === 'todowrite')) return undefined;
    clearTodoWriteNoopLatchOnForeignActivity(input.sessionId, input.canonicalMessages);
    const projection = projectTodoHistory(input.canonicalMessages);
    // M3.1 dupe wave: the durable projection is the source of truth for the
    // snapshot; seeding keeps the tool's Map a pure cache so the first
    // identical write after a restart still reads as a no-op.
    if (projection.todoState) seedLocalSessionTodos(input.sessionId, projection.todoState);
    if (!projection.todoState || !projection.todoCadence) return undefined;
    const summary = summarizeTodoStatuses(
      projection.todoState.map((todo) => ({ status: todo.status })),
    );
    if (
      summary.active === 0 ||
      projection.reminderSinceTodoWrite ||
      projection.todoCadence.assistantIterationsSinceTodoWrite < TODO_CADENCE_INTERVAL ||
      projection.todoCadence.assistantIterationsSinceReminder < TODO_CADENCE_INTERVAL
    ) {
      return undefined;
    }
    const details = {
      version: 1 as const,
      summary,
      todos: projection.todoState,
      cadence: projection.todoCadence,
    };
    const marker = {
      role: 'custom' as const,
      customType: TODO_CADENCE_REMINDER_CUSTOM_TYPE,
      content: formatTodoCadenceReminderContent(details),
      display: false as const,
      details,
      timestamp: Date.now(),
    };
    if (!fitsReminderInFinalRequest(input, marker, usageAnchor)) {
      return undefined;
    }

    return {
      type: 'appendMessage',
      reason: TODO_CADENCE_REMINDER_CUSTOM_TYPE,
      message: marker,
    };
  };
}

/**
 * M3.1 dupe wave, step 4: the TodoWrite tool refuses a back-to-back
 * unchanged rewrite. The tool cannot see other tools' calls, so this hook —
 * already the observer of the durable history — disarms that refusal
 * whenever another tool result (or a user turn) follows the last TodoWrite
 * result, keeping the rule strictly "no other calls in between". Scanning
 * starts at the tail and stops at the most recent TodoWrite result.
 */
function clearTodoWriteNoopLatchOnForeignActivity(
  sessionId: string,
  messages: readonly AgentMessage[],
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const role = Reflect.get(message, 'role');
    if (role === 'user') {
      clearTodoWriteNoopLatch(sessionId);
      return;
    }
    if (role !== 'toolResult') continue;
    const toolName = Reflect.get(message, 'toolName');
    if (typeof toolName === 'string' && toolName.toLowerCase() === 'todowrite') return;
    clearTodoWriteNoopLatch(sessionId);
    return;
  }
}
