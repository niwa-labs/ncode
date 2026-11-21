import { describe, expect, it } from 'vitest';

import type { BackgroundTask } from '@mavis/background-task';

import { LocalTaskOutputTool } from './local-task-control.js';
import type { LocalRuntimeToolContext, LocalTaskControlAdapter } from './types.js';

/**
 * The task_output receipt of the owner-input early release (owner bug
 * 2026-11-06): a wait released by an accepted owner input is an ordinary
 * toolResult that names the release, the still-running task and the automatic
 * full-output notice — the model answers the owner now instead of re-waiting.
 */

const context: LocalRuntimeToolContext = {
  sessionId: 'owner-session',
  turnId: 'owner-turn-1',
  toolCallId: 'call_out_1',
};

const runningTask: BackgroundTask = {
  taskId: 'bg_wake_1',
  ownerSessionId: 'owner-session',
  kind: 'subagent',
  status: 'running',
  description: 'Long child',
  createdAt: 1_000,
  updatedAt: 1_000,
};

function adapterWith(
  read: Partial<Awaited<ReturnType<LocalTaskControlAdapter['readOutput']>>>,
): LocalTaskControlAdapter {
  return {
    get: async () => runningTask,
    list: async () => ({ items: [] }),
    readOutput: async () => ({
      content: 'output so far',
      nextOffset: 13,
      status: 'running',
      task: runningTask,
      timedOut: false,
      ...read,
    }),
    stop: async () => runningTask,
  };
}

describe('LocalTaskOutputTool owner-input release receipt', () => {
  it('a released wait names the release, the background continuation and the notice', async () => {
    const tool = new LocalTaskOutputTool(
      adapterWith({ releasedFromOwnerInput: true }),
    );
    const result = await tool.execute(context, { task_id: 'bg_wake_1', wait_ms: 30_000 });
    expect(result.text).toContain('<task_output status="running">');
    expect(result.text).toContain(
      'The user sent a new message while this read was waiting, so the wait returned early with the output so far.',
    );
    expect(result.text).toContain(
      'do not re-issue a waiting read — its completion notice will arrive automatically with the full output',
    );
    expect(result.details).toMatchObject({
      task_id: 'bg_wake_1',
      status: 'running',
      released: 'owner_input',
      timed_out: false,
    });
  });

  it('a normal wait or timeout carries no release marker', async () => {
    const tool = new LocalTaskOutputTool(adapterWith({ timedOut: true }));
    const result = await tool.execute(context, { task_id: 'bg_wake_1', wait_ms: 30_000 });
    expect(result.text).not.toContain('returned early');
    expect(result.details).not.toHaveProperty('released');
    expect(result.details).toMatchObject({ status: 'running', timed_out: true });
  });
});
