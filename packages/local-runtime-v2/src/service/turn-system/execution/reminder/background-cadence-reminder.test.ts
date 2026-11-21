import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';
import { describe, expect, it } from 'vitest';

import type { BackgroundReminderFacts } from '../../agent-host/assembly/local-turn-input-preparation.js';
import {
  formatBackgroundCadenceReminderContent,
  validateCanonicalHistoryMessages,
  type BackgroundCadenceReminderDetails,
} from '../../agent-host/history/canonical-history-validation.js';
import { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE } from '../../compaction/algorithm/background-cadence.js';
import { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { createBackgroundCadenceReminder } from './background-cadence-reminder.js';

const SESSION_ID = 'ses_background_1';
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

function message(value: Record<string, unknown>): AgentMessage {
  return value as unknown as AgentMessage;
}

function user(text: string, timestamp: number): AgentMessage {
  return message({ role: 'user', content: [{ type: 'text', text }], timestamp });
}

function assistant(text: string, timestamp: number): AgentMessage {
  return message({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
    provider: 'test-provider',
    model: 'test-model',
    api: 'anthropic-messages',
  });
}

function assistants(count: number, firstTimestamp: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => assistant(`working ${index}`, firstTimestamp + index));
}

/** A reminder marker as the canonical history records it after a past delivery. */
function reminderMarker(input: {
  terminalTotal: number;
  timestamp: number;
  taskId?: string;
}): AgentMessage {
  const details: BackgroundCadenceReminderDetails = {
    version: 1,
    tasks: [{ taskId: input.taskId ?? 'task-1', status: 'succeeded' }],
    undeliveredTotal: 1,
    queuedTotal: 0,
    terminalTotal: input.terminalTotal,
    cadence: { assistantIterationsBeforeReminder: 0 },
  };
  return message({
    role: 'custom',
    customType: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
    content: formatBackgroundCadenceReminderContent(details),
    display: false,
    details,
    timestamp: input.timestamp,
  });
}

/** The automatic terminal notification a background turn itself starts from. */
function backgroundOriginUser(timestamp: number, observedTerminalCount: number): AgentMessage {
  return message({
    role: 'user',
    content: [{ type: 'text', text: 'background task finished' }],
    timestamp,
    hostMetadata: {
      backgroundTaskOrigin: {
        kind: 'background-task-terminal',
        taskIds: ['task-1'],
        observedTerminalCount,
      },
    },
  });
}

function facts(input: {
  taskId?: string;
  undeliveredTotal: number;
  terminalTotal: number;
}): BackgroundReminderFacts {
  return {
    tasks:
      input.undeliveredTotal === 0
        ? []
        : [{ taskId: input.taskId ?? 'task-1', status: 'succeeded' as const }],
    undeliveredTotal: input.undeliveredTotal,
    terminalTotal: input.terminalTotal,
  };
}

function hookInput(
  messages: AgentMessage[],
  phase: 'initial' | 'iteration' = 'iteration',
): PiBeforeLlmCallHookInput {
  return {
    sessionId: SESSION_ID,
    turnId: 'turn-1',
    phase,
    messages,
    canonicalMessages: messages,
    model: MODEL,
    thinkingLevel: 'off',
  } as PiBeforeLlmCallHookInput;
}

async function prepared(input: {
  messages: AgentMessage[];
  facts: BackgroundReminderFacts;
  hasSuccessfulTaskOutputRead?: () => boolean;
}) {
  const reminder = createBackgroundCadenceReminder(new ContextUsageAnchorState());
  return reminder.prepare({
    hookInput: hookInput(input.messages, 'initial'),
    loadFacts: async () => input.facts,
    hasSuccessfulTaskOutputRead: input.hasSuccessfulTaskOutputRead ?? (() => false),
  });
}

describe('Background cadence reminder — event model', () => {
  it('stays silent mid-turn no matter how many iterations pass without a new terminal task', async () => {
    const history = [
      user('start', 1),
      reminderMarker({ terminalTotal: 3, timestamp: 2 }),
      ...assistants(20, 3),
    ];
    const { hook } = await prepared({
      messages: history,
      facts: facts({ taskId: 'task-1', undeliveredTotal: 1, terminalTotal: 3 }),
    });

    // 20 ≥ TODO_CADENCE_INTERVAL: the removed blind branch would fire here on
    // the bare iteration counter. With the event model only a terminal task
    // history has not observed yet (observed=3, facts.terminalTotal=3 — none)
    // can produce a reminder.
    expect(await hook(hookInput(history, 'iteration'))).toBeUndefined();
  });

  it('fires mid-turn when a terminal task landed that history has not observed yet', async () => {
    const history = [
      user('start', 1),
      reminderMarker({ terminalTotal: 2, timestamp: 2 }),
      assistant('working', 3),
    ];
    const { hook } = await prepared({
      messages: history,
      facts: facts({ taskId: 'task-2', undeliveredTotal: 1, terminalTotal: 3 }),
    });

    const decision = await hook(hookInput(history, 'iteration'));
    expect(decision).toMatchObject({
      type: 'appendMessage',
      reason: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
      message: {
        role: 'custom',
        customType: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
        display: false,
      },
    });
    if (decision?.type !== 'appendMessage') throw new Error('Expected an append decision');
    expect(decision).not.toHaveProperty('placement');
    expect(() => validateCanonicalHistoryMessages([decision.message])).not.toThrow();
    const details = Reflect.get(decision.message, 'details') as BackgroundCadenceReminderDetails;
    expect(details.terminalTotal).toBe(3);
    expect(Reflect.get(decision.message, 'content')).toContain('1 local background task(s) are unread');

    // The event is consumed by its reminder: the next iteration observes
    // terminalTotal=3 through the marker details and stays silent.
    const nextHistory = [...history, decision.message];
    expect(await hook(hookInput(nextHistory, 'iteration'))).toBeUndefined();
  });

  it('stays silent after a successful task_output read even with a fresh terminal task', async () => {
    const history = [user('start', 1), reminderMarker({ terminalTotal: 2, timestamp: 2 })];
    const { hook } = await prepared({
      messages: history,
      facts: facts({ taskId: 'task-2', undeliveredTotal: 1, terminalTotal: 3 }),
      hasSuccessfulTaskOutputRead: () => true,
    });

    expect(await hook(hookInput([...history, assistant('reading', 3)], 'iteration'))).toBeUndefined();
    expect(await hook(hookInput(history, 'initial'))).toBeUndefined();
  });

  it('stays silent when the turn itself is an automatic background-origin message', async () => {
    const history = [
      user('start', 1),
      reminderMarker({ terminalTotal: 2, timestamp: 2 }),
      backgroundOriginUser(3, 2),
    ];
    const { beforeUserMessages, hook } = await prepared({
      messages: history,
      facts: facts({ taskId: 'task-2', undeliveredTotal: 1, terminalTotal: 3 }),
    });

    expect(beforeUserMessages).toHaveLength(0);
    expect(await hook(hookInput(history, 'initial'))).toBeUndefined();
  });
});

describe('Background cadence reminder — user turn start', () => {
  it('delivers one reminder before the current user while tasks remain undelivered', async () => {
    const history = [user('first ask', 1), user('second ask', 2)];
    const { beforeUserMessages, hook } = await prepared({
      messages: history,
      facts: facts({ taskId: 'task-1', undeliveredTotal: 1, terminalTotal: 1 }),
    });

    expect(beforeUserMessages).toHaveLength(1);
    const marker = beforeUserMessages[0] as AgentMessage;
    expect(() => validateCanonicalHistoryMessages([marker])).not.toThrow();

    const decision = await hook(hookInput(history, 'initial'));
    expect(decision).toMatchObject({
      type: 'appendMessage',
      reason: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
      placement: 'before-current-user',
      message: { customType: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE },
    });
    if (decision?.type !== 'appendMessage') throw new Error('Expected an append decision');
    expect(Reflect.get(decision.message, 'timestamp')).toBe(Reflect.get(marker, 'timestamp'));

    // The prepared marker already riding the turn is not appended a second time.
    const withMarker = [...history, marker];
    expect(await hook(hookInput(withMarker, 'initial'))).toBeUndefined();
  });

  it('stays silent at turn start and mid-turn when nothing is undelivered', async () => {
    const history = [user('start', 1), assistant('done', 2)];
    const { beforeUserMessages, hook } = await prepared({
      messages: history,
      facts: facts({ undeliveredTotal: 0, terminalTotal: 1 }),
    });

    expect(beforeUserMessages).toHaveLength(0);
    expect(await hook(hookInput(history, 'initial'))).toBeUndefined();
    expect(await hook(hookInput(history, 'iteration'))).toBeUndefined();
  });
});


it('reading one output does not suppress another task with the same terminal count', async () => {
  const history = [user('start', 1), reminderMarker({ taskId: 'task-A', terminalTotal: 2, timestamp: 2 })];
  const reminder = createBackgroundCadenceReminder(new ContextUsageAnchorState());
  let current = facts({ taskId: 'task-A', undeliveredTotal: 1, terminalTotal: 2 });
  const prepared = await reminder.prepare({
    hookInput: hookInput(history, 'initial'), loadFacts: async () => current,
    hasSuccessfulTaskOutputRead: () => true, readTaskIds: () => new Set(['task-A']),
  });
  current = facts({ taskId: 'task-B', undeliveredTotal: 1, terminalTotal: 2 });
  const decision = await prepared.hook(hookInput(history, 'iteration'));
  expect(decision?.type).toBe('appendMessage');
  if (decision?.type !== 'appendMessage') throw new Error('Missing task B notice');
  expect(Reflect.get(decision.message, 'content')).toContain('task-B');
  expect(await prepared.hook(hookInput([...history, decision.message], 'iteration'))).toBeUndefined();
});
