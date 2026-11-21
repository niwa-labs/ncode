import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { todoSnapshotKey } from '@mavis/system-reminder';

import {
  normalizeTodoItems,
  readCompactionCompatibility,
  TODO_CADENCE_INTERVAL,
  type CompactionTodoCadence,
  type CompactionTodoItem,
} from '../compat.js';
import { readContextDomainState } from './domain-state.js';
import { advanceAssistantIterationCadence } from './assistant-iteration-cadence.js';

export const TODO_CADENCE_REMINDER_CUSTOM_TYPE = 'todo_cadence_reminder';

export interface TodoHistoryProjection {
  readonly todoState?: readonly CompactionTodoItem[];
  readonly todoCadence?: CompactionTodoCadence;
  /** Scheduling state follows the todo snapshot across compression/replay. */
  readonly reminderSinceTodoWrite: boolean;
}

/** Rebuilds Todo reminder state from the durable transcript. */
export function projectTodoHistory(messages: readonly AgentMessage[]): TodoHistoryProjection {
  const inherited = readCompactionCompatibility(messages[0]);
  const checkpoint = readContextDomainState(messages[0])?.todo;
  let todoState = checkpoint?.todoState ?? inherited?.todoState;
  let todoCadence: CompactionTodoCadence = checkpoint?.todoCadence ?? inherited?.todoCadence ?? {
    assistantIterationsSinceTodoWrite: TODO_CADENCE_INTERVAL,
    assistantIterationsSinceReminder: TODO_CADENCE_INTERVAL,
  };
  let reminderSinceTodoWrite = checkpoint?.reminderSinceTodoWrite ?? false;
  const toolNames = new Map<string, string>();

  messages.forEach((message) => {
    if (message.role === 'assistant') {
      todoCadence = {
        assistantIterationsSinceTodoWrite: advanceAssistantIterationCadence(
          todoCadence.assistantIterationsSinceTodoWrite,
        ),
        assistantIterationsSinceReminder: advanceAssistantIterationCadence(
          todoCadence.assistantIterationsSinceReminder,
        ),
      };
      recordToolNames(message, toolNames);
    }

    const next = readSuccessfulTodo(message, toolNames);
    // M3.1 dupe wave: a write whose snapshot is identical to the current
    // state (shared comparator) is a no-op — it must not reset the cadence
    // counters or re-arm the reminder gate. The comparison is redone here
    // instead of trusting `details.unchanged`: records written before the
    // fix do not carry the flag.
    if (next !== undefined && todoSnapshotKey(todoState) !== todoSnapshotKey(next)) {
      todoState = next;
      todoCadence = { ...todoCadence, assistantIterationsSinceTodoWrite: 0 };
      reminderSinceTodoWrite = false;
    }
    if (isTodoCadenceReminder(message)) {
      todoCadence = { ...todoCadence, assistantIterationsSinceReminder: 0 };
      reminderSinceTodoWrite = true;
    }
  });

  return todoState === undefined
    ? { reminderSinceTodoWrite }
    : { todoState, todoCadence, reminderSinceTodoWrite };
}

function isTodoCadenceReminder(message: AgentMessage): boolean {
  const details = Reflect.get(message, 'details');
  return (
    message.role === 'custom' &&
    Reflect.get(message, 'customType') === TODO_CADENCE_REMINDER_CUSTOM_TYPE &&
    Reflect.get(message, 'display') === false &&
    details !== null &&
    typeof details === 'object' &&
    Reflect.get(details, 'version') === 1 &&
    Array.isArray(Reflect.get(details, 'todos'))
  );
}

function recordToolNames(message: AgentMessage, toolNames: Map<string, string>): void {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
  message.content.forEach((block) => {
    if (!block || block.type !== 'toolCall') return;
    if (block.id.trim() && block.name.trim()) toolNames.set(block.id, block.name.toLowerCase());
  });
}

function readSuccessfulTodo(
  message: AgentMessage,
  toolNames: ReadonlyMap<string, string>,
): readonly CompactionTodoItem[] | undefined {
  if (message.role !== 'toolResult' || message.isError) return undefined;
  const toolName = message.toolName?.toLowerCase() ?? toolNames.get(message.toolCallId);
  if (toolName !== 'todowrite') return undefined;
  const details = Reflect.get(message, 'details');
  if (
    !details ||
    typeof details !== 'object' ||
    Reflect.get(details, 'cancelled') === true ||
    Reflect.get(details, 'status') === 'cancelled'
  ) {
    return undefined;
  }
  return normalizeTodoItems(Reflect.get(details, 'todos'));
}
