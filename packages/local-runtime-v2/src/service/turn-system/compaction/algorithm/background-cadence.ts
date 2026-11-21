import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { readCompactionCompatibility, TODO_CADENCE_INTERVAL } from '../compat.js';
import { readContextDomainState } from './domain-state.js';
import { advanceAssistantIterationCadence } from './assistant-iteration-cadence.js';
import {
  BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
  isBackgroundTaskReadSettlement,
  readBackgroundTaskOriginMetadata,
} from '../../agent-host/contracts.js';

export { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE };

export interface BackgroundHistoryProjection {
  readonly assistantIterationsSinceReminder: number;
  readonly observedTerminalCount?: number;
  readonly hasBackgroundState: boolean;
  readonly observedTaskKeys?: readonly string[];
}

/** Rebuilds the Session-shared Background reminder cadence from canonical History. */
export function projectBackgroundHistory(
  messages: readonly AgentMessage[],
): BackgroundHistoryProjection {
  const inherited = readCompactionCompatibility(messages[0])?.backgroundCadence;
  let state: BackgroundHistoryProjection =
    readContextDomainState(messages[0])?.background ??
    (inherited
      ? { ...inherited, hasBackgroundState: true }
      : {
          assistantIterationsSinceReminder: TODO_CADENCE_INTERVAL,
          observedTerminalCount: 0,
          hasBackgroundState: false,
        });

  for (const message of messages) {
    if (message.role === 'assistant') {
      state = {
        ...state,
        assistantIterationsSinceReminder: advanceAssistantIterationCadence(
          state.assistantIterationsSinceReminder,
        ),
      };
    }
    const observation = readReminderObservation(message);
    if (observation) {
      const observedTerminalCount = resolveObservedTerminalCount(state, observation);
      state = {
        ...state,
        observedTaskKeys: [
          ...new Set([...(state.observedTaskKeys ?? []), ...(observation.taskKeys ?? [])]),
        ].slice(-256),
        assistantIterationsSinceReminder: 0,
        ...(observedTerminalCount === undefined ? {} : { observedTerminalCount }),
        hasBackgroundState: true,
      };
    } else if (isBackgroundTaskReadSettlement(message)) {
      state = { ...state, assistantIterationsSinceReminder: 0, hasBackgroundState: true };
    }
  }
  return state;
}

function resolveObservedTerminalCount(
  state: BackgroundHistoryProjection,
  observation: { readonly observedTerminalCount?: number },
): number | undefined {
  if (observation.observedTerminalCount === undefined) {
    return state.hasBackgroundState ? state.observedTerminalCount : undefined;
  }
  return Math.max(state.observedTerminalCount ?? 0, observation.observedTerminalCount);
}

function readReminderObservation(
  message: AgentMessage,
): { readonly observedTerminalCount?: number; readonly taskKeys?: readonly string[] } | undefined {
  if (
    message.role === 'custom' &&
    Reflect.get(message, 'customType') === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
    Reflect.get(message, 'display') === false
  ) {
    const details = readRecord(Reflect.get(message, 'details'));
    const observedTerminalCount = nonNegativeSafeInteger(details.terminalTotal);
    return observedTerminalCount === undefined
      ? undefined
      : {
          observedTerminalCount,
          taskKeys: Array.isArray(details.tasks)
            ? details.tasks
                .map((task) => backgroundTaskKey(readRecord(task)))
                .filter((key): key is string => key !== undefined)
            : [],
        };
  }
  if (message.role !== 'user') return undefined;
  const origin = readBackgroundTaskOriginMetadata(message);
  if (!origin) return undefined;
  return origin.observedTerminalCount === undefined
    ? {}
    : { observedTerminalCount: origin.observedTerminalCount };
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

/** Task IDs identify runs; terminal timestamp/status distinguish a revised outcome. */
export function backgroundTaskKey(task: Readonly<Record<string, unknown>>): string | undefined {
  return typeof task.taskId === 'string' && typeof task.status === 'string'
    ? JSON.stringify([task.taskId, task.status, task.endedAtMs ?? null])
    : undefined;
}
