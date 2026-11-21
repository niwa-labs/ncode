import type { PiBeforeLlmCallHook } from '@mavis/agent-core/pi-turn-runner';

import type { BackgroundReminderFacts } from '../../agent-host/assembly/local-turn-input-preparation.js';
import type { BackgroundCadenceReminder } from '../../agent-host/execution/contracts.js';
import {
  formatBackgroundCadenceReminderContent,
  type BackgroundCadenceReminderDetails,
} from '../../agent-host/history/canonical-history-validation.js';
import {
  BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
  projectBackgroundHistory,
  backgroundTaskKey,
} from '../../compaction/algorithm/background-cadence.js';
import type { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { readBackgroundTaskOriginMetadata } from '../../agent-host/history/background/host-metadata.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';

/**
 * Background task completion reminders, event-driven. Delivery happens only
 * when the state it reports is new to the model: once per user turn start while
 * tasks remain undelivered (phase 'initial'), plus one reminder per not-yet-
 * observed terminal task mid-turn. Suppression gates — a successful
 * `task_output` read and automatic background-origin messages — stay intact.
 */
export function createBackgroundCadenceReminder(
  usageAnchor: ContextUsageAnchorState,
): BackgroundCadenceReminder {
  return {
    async prepare(input) {
      if (hasAutomaticBackgroundOrigin(input.hookInput.canonicalMessages.at(-1))) {
        return { beforeUserMessages: [], hook: () => undefined };
      }
      const facts = freezeFacts(await input.loadFacts());
      const candidate = createBackgroundCadenceMarker(input.hookInput, facts);
      const marker =
        candidate && fitsReminderInFinalRequest(input.hookInput, candidate, usageAnchor)
          ? candidate
          : undefined;
      return {
        beforeUserMessages: marker ? [marker] : [],
        hook: createPreparedBackgroundCadenceReminderHook({
          facts,
          initialCandidate: candidate,
          usageAnchor,
          hasSuccessfulTaskOutputRead: input.hasSuccessfulTaskOutputRead,
          readTaskIds: input.readTaskIds,
          loadFacts: input.loadFacts,
        }),
      };
    },
  };
}

function createPreparedBackgroundCadenceReminderHook(options: {
  readonly facts: BackgroundReminderFacts;
  readonly initialCandidate: BackgroundCadenceMarker | undefined;
  readonly usageAnchor: ContextUsageAnchorState;
  readonly hasSuccessfulTaskOutputRead?: () => boolean;
  readonly readTaskIds?: () => ReadonlySet<string>;
  readonly loadFacts: () => Promise<BackgroundReminderFacts>;
}): PiBeforeLlmCallHook {
  const {
    facts,
    initialCandidate,
    usageAnchor,
    hasSuccessfulTaskOutputRead = () => false,
  } = options;
  return async (input) => {
    // Legacy callers keep their old boolean contract. Runtime callers settle
    // identified tasks only; reading A must never suppress unread result B.
    if (!options.readTaskIds && hasSuccessfulTaskOutputRead()) return undefined;
    if (hasAutomaticBackgroundOrigin(input.canonicalMessages.at(-1))) return undefined;
    const marker =
      input.phase === 'initial'
        ? initialCandidate
        : createBackgroundCadenceMarker(
            input,
            excludeReadTasks(freezeFacts(await options.loadFacts()), options.readTaskIds?.()),
          );
    if (
      !marker ||
      (input.phase === 'initial' && hasPreparedMarker(input.canonicalMessages, marker)) ||
      !fitsReminderInFinalRequest(input, marker, usageAnchor)
    ) {
      return undefined;
    }
    return marker
      ? {
          type: 'appendMessage',
          reason: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
          message: marker,
          ...(input.phase === 'initial' ? { placement: 'before-current-user' as const } : {}),
        }
      : undefined;
  };
}

type BackgroundCadenceMarker = NonNullable<ReturnType<typeof createBackgroundCadenceMarker>>;

function createBackgroundCadenceMarker(
  input: Parameters<PiBeforeLlmCallHook>[0],
  facts: BackgroundReminderFacts,
) {
  if (facts.undeliveredTotal === 0 || facts.tasks.length === 0) return undefined;
  const projection = projectBackgroundHistory(input.canonicalMessages);
  const hasNewTerminalTask =
    !projection.hasBackgroundState ||
    (projection.observedTerminalCount !== undefined &&
      facts.terminalTotal > projection.observedTerminalCount);
  // The reminder is event-driven: mid-turn it only fires when history has not
  // observed this many terminal tasks yet. The blind iteration-counter cadence
  // is gone — it re-fired every TODO_CADENCE_INTERVAL assistant iterations and
  // each injection spawned the next loop wave. The only counter-free delivery
  // is the single reminder prepared once at the start of a user turn.
  const newTasks = facts.tasks.filter(
    (task) => !projection.observedTaskKeys?.includes(backgroundTaskKey({ ...task })!),
  );
  if (input.phase !== 'initial' && newTasks.length === 0) return undefined;
  // Legacy observations without task identities use their original count gate.
  if (input.phase !== 'initial' && projection.observedTaskKeys === undefined && !hasNewTerminalTask)
    return undefined;
  const details: BackgroundCadenceReminderDetails = {
    version: 1,
    tasks: facts.tasks,
    undeliveredTotal: facts.undeliveredTotal,
    queuedTotal: facts.undeliveredTotal - facts.tasks.length,
    terminalTotal: facts.terminalTotal,
    cadence: {
      assistantIterationsBeforeReminder: projection.assistantIterationsSinceReminder,
    },
  };
  const marker = {
    role: 'custom' as const,
    customType: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
    content: formatBackgroundCadenceReminderContent(details),
    display: false as const,
    details,
    timestamp: Date.now(),
  };
  return marker;
}

function freezeFacts(facts: BackgroundReminderFacts): BackgroundReminderFacts {
  return Object.freeze({
    tasks: Object.freeze(facts.tasks.map((task) => Object.freeze({ ...task }))),
    undeliveredTotal: facts.undeliveredTotal,
    terminalTotal: facts.terminalTotal,
  });
}

function hasPreparedMarker(messages: readonly unknown[], marker: BackgroundCadenceMarker): boolean {
  return messages.some(
    (message) =>
      message !== null &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      Reflect.get(message, 'role') === 'custom' &&
      Reflect.get(message, 'customType') === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
      Reflect.get(message, 'timestamp') === marker.timestamp,
  );
}

function hasAutomaticBackgroundOrigin(message: unknown): boolean {
  return readBackgroundTaskOriginMetadata(message) !== undefined;
}

function excludeReadTasks(
  facts: BackgroundReminderFacts,
  read: ReadonlySet<string> | undefined,
): BackgroundReminderFacts {
  if (!read?.size) return facts;
  const tasks = facts.tasks.filter((task) => !read.has(task.taskId));
  return {
    ...facts,
    tasks,
    undeliveredTotal: Math.max(
      tasks.length,
      facts.undeliveredTotal - (facts.tasks.length - tasks.length),
    ),
  };
}
