/**
 * Wave 2 (verdict 09 §2): the task tool's wait-outcome surfaces.
 *
 * - `formatReleasedBackgroundNote` pins the §2.2 verbatim release note: the
 *   structural origin (task_id / execution_mode / reason /
 *   automatic_notification / actual status) and the two reason variants — the
 *   owner-input note names the user message, every other reason must NOT.
 * - The tool's branch selection pins the single outcome rule: a released wait
 *   returns the `<task_background>` note, a completed wait returns the normal
 *   `<task_result>`/`<task_error>` path, and an adapter without the reactive
 *   method keeps the legacy inline contract (§5.2: jsonl honesty).
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import {
  LocalTaskTool,
  formatExplicitBackgroundNote,
  formatReleasedBackgroundNote,
} from './local-task.js';
import type {
  LocalRuntimeToolContext,
  LocalTaskAdapter,
  LocalTaskForegroundWaitResult,
  LocalTaskRunResult,
} from './types.js';

const context: LocalRuntimeToolContext = {
  sessionId: 'owner-session',
  turnId: 'owner-turn-1',
  toolCallId: 'call_task_1',
};

function backgrounded(
  overrides: Partial<Extract<LocalTaskForegroundWaitResult, { kind: 'backgrounded' }>> = {},
): Extract<LocalTaskForegroundWaitResult, { kind: 'backgrounded' }> {
  return {
    kind: 'backgrounded',
    taskId: 'bg_task_1',
    reason: 'owner_input',
    subSessionId: 'child-session',
    subTurnId: 'bg_task_1_t',
    taskStatus: 'running',
    ...overrides,
  };
}

describe('formatReleasedBackgroundNote (§2.2 verbatim)', () => {
  it('owner_input release on a running task: the verbatim §2.2 body and structural origin', () => {
    const note = formatReleasedBackgroundNote(backgrounded());
    expect(note).toContain('<task_background task_id="bg_task_1" execution_mode="background" reason="owner_input" automatic_notification="true" status="running" session_id="child-session">');
    expect(note).toContain('The user sent a new message, so this task was moved to the background.');
    expect(note).toContain('Task bg_task_1 is still queued or running; it has not been canceled or completed.');
    expect(note).toContain(
      "Respond to the user's latest message now. The task's terminal status will be delivered automatically to this conversation, starting a new turn if needed.",
    );
    expect(note).toContain(
      'Do not wait, sleep, or repeatedly poll for this task. Use task_query/task_output only when the user asks for its current state or when a completion notice arrives. Use task_stop to cancel this task, or task_append to send it additional instructions.',
    );
    expect(note).toContain(
      'Do not repeat this task merely because it moved to the background. Avoid conflicting changes while it is still running.',
    );
    expect(note.endsWith('</task_background>')).toBe(true);
  });

  it('queued status keeps the release note and reports the queued structural status', () => {
    const note = formatReleasedBackgroundNote(backgrounded({ taskStatus: 'queued' }));
    expect(note).toContain('status="queued"');
    expect(note).toContain('it has not been canceled or completed.');
    expect(note).not.toContain('completion notice is pending');
  });

  it('release that won against an already-terminal child: no false still-running, notice pending', () => {
    const note = formatReleasedBackgroundNote(backgrounded({ taskStatus: 'succeeded' }));
    expect(note).toContain('already reached a terminal status (succeeded)');
    expect(note).toContain('its completion notice is pending');
    expect(note).not.toContain('still queued or running');
    // The wait outcome is still backgrounded: no inline result text appears.
    expect(note).not.toContain('<task_result');
  });

  it('a non-owner reason never claims the user sent a message (§2.2)', () => {
    for (const reason of ['run_in_background', 'manual_background', 'timer'] as const) {
      const note = formatReleasedBackgroundNote(backgrounded({ reason }));
      expect(note).toContain(`reason="${reason}"`);
      expect(note).not.toContain('The user sent a new message');
      expect(note).toContain('delivered automatically to this conversation');
    }
  });

  it('escapes XML-significant characters in the identity attributes', () => {
    const note = formatReleasedBackgroundNote(backgrounded({ taskId: 'bg<"x">' }));
    expect(note).toContain('task_id="bg&lt;&quot;x&quot;&gt;"');
  });
});

describe('formatExplicitBackgroundNote (run_in_background=true)', () => {
  it('keeps the owning-conversation resume sentence without a user-message phrase', () => {
    const note = formatExplicitBackgroundNote({ taskId: 'bg_task_2', subSessionId: 'child-2' });
    expect(note).toContain('<task_background task_id="bg_task_2" execution_mode="background" reason="run_in_background" automatic_notification="true" session_id="child-2">');
    expect(note).toContain('The owning conversation will automatically resume when it finishes unless the user explicitly stops it');
    expect(note).not.toContain('The user sent a new message');
  });

  it('carries the same don\'t-wait-unless-asked rule as the owner-input release note', () => {
    const note = formatExplicitBackgroundNote({ taskId: 'bg_task_3' });
    expect(note).toContain('the completion notice will carry the full output');
    expect(note).toContain(
      "do not call task_output with waiting unless the user explicitly asked you to wait for this task's completion in this turn",
    );
  });

  it('the owner-input release note keeps its don\'t-wait rule (§2.2 regression)', () => {
    const note = formatReleasedBackgroundNote(backgrounded());
    expect(note).toContain(
      'Do not wait, sleep, or repeatedly poll for this task. Use task_query/task_output only when the user asks for its current state or when a completion notice arrives.',
    );
  });
});

function runResult(
  overrides: Partial<LocalTaskRunResult> = {},
): LocalTaskRunResult {
  return {
    status: 'succeeded',
    requestedAgentName: 'worker',
    resolvedAgentName: 'worker',
    taskId: 'bg_task_1',
    subSessionId: 'child-session',
    subTurnId: 'bg_task_1_t',
    finalText: 'child answer',
    ...overrides,
  };
}

function reactiveAdapter(
  wait: LocalTaskForegroundWaitResult,
): LocalTaskAdapter {
  return {
    runForeground: vi.fn(async () => runResult()),
    startBackground: vi.fn(async () => ({ status: 'started' as const, taskId: 'bg_task_1' })),
    runReactiveForeground: vi.fn(async () => wait),
  };
}

const taskInput = {
  description: 'child',
  prompt: 'do the work',
  agent_name: 'worker',
} as const;

describe('LocalTaskTool wait-outcome branches', () => {
  it('a released wait returns the single <task_background> result, not task_result', async () => {
    const adapter = reactiveAdapter(backgrounded());
    const result = await new LocalTaskTool(adapter).execute(context, taskInput);
    expect(result.text).toContain('<task_background task_id="bg_task_1"');
    expect(result.text).toContain('reason="owner_input"');
    expect(result.text).not.toContain('<task_result');
    expect(result.details).toMatchObject({
      status: 'backgrounded',
      task_id: 'bg_task_1',
      reason: 'owner_input',
      automatic_notification: true,
      task_status: 'running',
    });
    expect(adapter.runForeground).not.toHaveBeenCalled();
  });

  it('a completed reactive wait returns the normal inline task_result', async () => {
    const adapter = reactiveAdapter({ kind: 'completed', result: runResult() });
    const result = await new LocalTaskTool(adapter).execute(context, taskInput);
    expect(result.text).toContain('<task_result');
    expect(result.text).toContain('child answer');
    expect(result.text).not.toContain('<task_background');
  });

  it('a completed failed wait returns the task_error path with the run status', async () => {
    const adapter = reactiveAdapter({
      kind: 'completed',
      result: runResult({ status: 'failed', errorMessage: 'boom' }),
    });
    const result = await new LocalTaskTool(adapter).execute(context, taskInput);
    expect(result.text).toContain('<task_error');
    expect(result.details).toMatchObject({ status: 'failed', error_message: 'boom' });
    expect(result.isError).toBe(true);
  });

  it('an adapter without the reactive method keeps the legacy inline contract (§5.2)', async () => {
    const adapter: LocalTaskAdapter = {
      runForeground: vi.fn(async () => runResult()),
      startBackground: vi.fn(async () => ({ status: 'started' as const, taskId: 'bg' })),
    };
    const result = await new LocalTaskTool(adapter).execute(context, taskInput);
    expect(result.text).toContain('<task_result');
    expect(adapter.runForeground).toHaveBeenCalledTimes(1);
  });
});
