import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';
import { describe, expect, it } from 'vitest';

import { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { createBackgroundCadenceReminder } from './background-cadence-reminder.js';
import { createTodoCadenceReminderHook } from './todo-cadence-reminder.js';

/**
 * Regression for the live incident mvs_fd066dbd: 375 polling iterations with
 * active todos and an undelivered background task. The two 15-iteration
 * cadences used to re-fire on their saturated counters (~38 injections across
 * the session, each injection spawning the next loop wave). After the opus В2
 * gates — the todo novelty gate and the event-driven background reminder — one
 * user turn may inject at most 2 reminders: one background marker prepared at
 * the turn start, one todo reminder for the unchanged snapshot.
 *
 * The polling shape is task_query-style (no task_output settlements): that is
 * the canonical incident history in which both cadences advanced freely.
 */

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

const POLLING_ITERATIONS = 375;
const TASK_ID = 'task-poll-1';

const TODO_SNAPSHOT = [
  { content: 'wait for the background task', status: 'in_progress', priority: 'high' },
];

const BACKGROUND_FACTS = {
  tasks: [{ taskId: TASK_ID, status: 'succeeded' as const }],
  undeliveredTotal: 1,
  terminalTotal: 1,
};

function message(value: Record<string, unknown>): AgentMessage {
  return value as unknown as AgentMessage;
}

function user(text: string, timestamp: number): AgentMessage {
  return message({ role: 'user', content: [{ type: 'text', text }], timestamp });
}

function assistantWithToolCall(
  callId: string,
  toolName: string,
  timestamp: number,
): AgentMessage {
  return message({
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: toolName, arguments: {} }],
    stopReason: 'toolUse',
    provider: MODEL.provider,
    api: MODEL.api,
    model: MODEL.id,
    timestamp,
  });
}

function toolResult(
  callId: string,
  toolName: string,
  timestamp: number,
  details: Record<string, unknown> = { status: 'ok' },
): AgentMessage {
  return message({
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    isError: false,
    content: [{ type: 'text', text: 'ok' }],
    details,
    timestamp,
  });
}

function hookInput(
  messages: AgentMessage[],
  phase: 'initial' | 'iteration',
): PiBeforeLlmCallHookInput {
  return {
    sessionId: 'ses_incident_regression',
    turnId: 'turn-polling',
    phase,
    messages,
    canonicalMessages: messages,
    model: MODEL,
    thinkingLevel: 'off',
    tools: [{ name: 'TodoWrite' }],
  } as PiBeforeLlmCallHookInput;
}

describe('incident mvs_fd066dbd regression: cadence injections per turn', () => {
  it('375 polling iterations with active todos and a background task inject at most 2 reminders', async () => {
    const usageAnchor = new ContextUsageAnchorState();
    const todoHook = createTodoCadenceReminderHook(usageAnchor);
    const backgroundReminder = createBackgroundCadenceReminder(usageAnchor);

    // Durable history: the previous turn left an active todo snapshot.
    const durableHistory: AgentMessage[] = [
      user('start the export in the background', 1),
      assistantWithToolCall('call-todowrite-0', 'TodoWrite', 2),
      toolResult('call-todowrite-0', 'TodoWrite', 3, { todos: TODO_SNAPSHOT }),
    ];
    const currentUser = user('keep waiting', 10);

    // Turn start: the executor prepares the background reminder once.
    const prepared = await backgroundReminder.prepare({
      hookInput: hookInput([...durableHistory, currentUser], 'initial'),
      loadFacts: async () => BACKGROUND_FACTS,
      hasSuccessfulTaskOutputRead: () => false,
    });
    const history: AgentMessage[] = [
      ...durableHistory,
      ...prepared.beforeUserMessages,
      currentUser,
    ];
    let injections = prepared.beforeUserMessages.length;
    let todoFirings = 0;

    for (let iteration = 1; iteration <= POLLING_ITERATIONS; iteration += 1) {
      history.push(
        assistantWithToolCall(`call-query-${iteration}`, 'task_query', 100 + iteration * 2),
        toolResult(`call-query-${iteration}`, 'task_query', 101 + iteration * 2),
      );
      const backgroundDecision = await prepared.hook(hookInput(history, 'iteration'));
      if (backgroundDecision?.type === 'appendMessage') {
        history.push(backgroundDecision.message);
        injections += 1;
      }
      const todoDecision = todoHook(hookInput(history, 'iteration'));
      if (todoDecision?.type === 'appendMessage') {
        history.push(todoDecision.message);
        injections += 1;
        todoFirings += 1;
      }
    }

    expect(injections).toBeLessThanOrEqual(2);
    // The todo novelty gate: exactly one reminder for the unchanged snapshot,
    // silence on every later iteration no matter how saturated the counters are.
    expect(todoFirings).toBe(1);
  });
});
