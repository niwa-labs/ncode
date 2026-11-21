import { describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_DELIVERY_DRAIN_TIMEOUT_NOTE,
  isBackgroundWorkPending,
  waitForBackgroundDeliveryDrain,
} from '../../src/headless/background-drain.js';
import { runTuiExec } from '../../src/headless/runner.js';
import type { TuiStreamEvent } from '../../src/runtime/stream-events.js';

/**
 * Verdict 09 §4.4 / acceptance №20 — headless lifetime: the end of the parent
 * model turn must not kill a process that promised the automatic completion
 * notice while its session still owns background work. The exec drain keeps
 * the process alive until the notice is delivered and the wake Turn finished;
 * an expired bound exits with the explicit daemon-mode policy note, never a
 * silently dropped promise.
 */

const successEvents: readonly TuiStreamEvent[] = [
  { type: 'message', message: { id: 'assistant-1', role: 'assistant', content: 'done' } },
  { type: 'session-status', status: 'finished' },
];

function runtimeWith(
  events: readonly TuiStreamEvent[] = successEvents,
  hooks: {
    listBackgroundTasks?: (
      ownerSessionId: string,
      options?: { readonly includeSubagent?: boolean },
    ) => Promise<readonly { status: string; deliveredAtMs?: number; foreground?: true }[]>;
    getActiveRunStates?: readonly ('running' | 'idle')[];
  } = {},
) {
  let activeRunIndex = 0;
  return {
    getAccountStatus: vi.fn(async () => ({ status: 'ready' as const, managedTokenPresent: true, warnings: [] })),
    listModels: vi.fn(async () => [
      { providerId: 'default-provider', modelId: 'default-model', variant: 'balanced', selected: true },
    ]),
    setPermissionMode: vi.fn(async (mode) => mode),
    createSession: vi.fn(async () => ({ sessionId: 'session-1', workspaceDir: '/tmp/workspace' })),
    getSession: vi.fn(async () => ({ sessionId: 'session-1', workspaceDir: '/tmp/workspace', archived: false })),
    listSessionPage: vi.fn(async () => ({ sessions: [], hasMore: false })),
    getPendingQuestionnaire: vi.fn(async () => undefined),
    listPendingPermissions: vi.fn(async () => []),
    getSessionUsage: vi.fn(async () => ({ rows: [] })),
    listMessagePage: vi.fn(async () => ({ messages: [], hasMore: false })),
    getActiveRun: vi.fn(async () => {
      const states = hooks.getActiveRunStates ?? ['idle'];
      const state = states[Math.min(activeRunIndex, states.length - 1)]!;
      activeRunIndex += 1;
      return {
        schemaVersion: 1 as const,
        sessionId: 'session-1',
        state,
        turnId: 'turn-1',
        actions: { steer: true },
      };
    }),
    ...(hooks.listBackgroundTasks
      ? { listBackgroundTasks: vi.fn(hooks.listBackgroundTasks) }
      : {}),
    sendMessage: vi.fn(async function* () {
      for (const event of events) yield event;
      yield { type: 'done' } as const;
    }),
    watchSessionTurn: vi.fn(async function* () {
      yield { type: 'session-status' as const, status: 'finished' as const };
    }),
    abortSession: vi.fn(async () => true),
    steer: vi.fn(async () => ({ queueItemId: 'queue-1' })),
  };
}

async function runExec(
  runtime: ReturnType<typeof runtimeWith>,
  input: Partial<Parameters<typeof runTuiExec>[0]> = {},
): Promise<{ exitCode: number; stderrLines: string[] }> {
  const stderr = vi.fn();
  let exitCode = 0;
  const stdout = vi.fn();
  exitCode = await runTuiExec(
    {
      prompt: 'Do it',
      workspaceDir: '/tmp/workspace',
      version: '0.1.0',
      format: 'json',
      backgroundDeliveryDrainTimeoutMs: 2_000,
      ...input,
    },
    { runtime, stdout, stderr, shutdown: async () => undefined, createTurnId: () => 'turn-1' },
  );
  return { exitCode, stderrLines: stderr.mock.calls.map(([line]) => String(line)) };
}

describe('exec background delivery drain (§5.4 №20)', () => {
  it('waits for the pending notice, the wake Turn, and exits cleanly once both settle', async () => {
    let reads = 0;
    const runtime = runtimeWith(successEvents, {
      // First read: the terminal is undelivered. Second: delivered (the wake
      // Turn is running). Third: still clean and the wake Turn finished.
      listBackgroundTasks: async () => {
        reads += 1;
        if (reads === 1) return [{ status: 'succeeded' }];
        if (reads === 2) return [{ status: 'succeeded', deliveredAtMs: 123 }];
        return [];
      },
      // The wake Turn a delivery activated shows as running, then idle.
      getActiveRunStates: ['running', 'idle'],
    });
    const { exitCode } = await runExec(runtime);
    expect(exitCode).toBe(0);
    expect(runtime.listBackgroundTasks).toHaveBeenCalledWith('session-1', {
      includeSubagent: true,
    });
    expect(runtime.getActiveRun).toHaveBeenCalled();
  });

  it('keeps subagent rows in the lifetime projection', () => {
    expect(
      isBackgroundWorkPending([
        { status: 'running' },
        { status: 'succeeded' },
        { status: 'failed', deliveredAtMs: 5 },
        { status: 'queued', foreground: true },
      ]),
    ).toEqual({ active: 1, undeliveredTerminal: 1 });
    expect(isBackgroundWorkPending([{ status: 'succeeded', deliveredAtMs: 5 }])).toEqual({
      active: 0,
      undeliveredTerminal: 0,
    });
  });

  it('does not wait at all when the runtime cannot list background work', async () => {
    const runtime = runtimeWith();
    const { exitCode } = await runExec(runtime, { backgroundDeliveryDrainTimeoutMs: 5_000 });
    expect(exitCode).toBe(0);
    expect(runtime.getActiveRun).not.toHaveBeenCalled();
  });

  it('exits with the explicit daemon-mode policy note when the drain bound expires', async () => {
    const runtime = runtimeWith(successEvents, {
      // The child never finishes: the notice can never be delivered here.
      listBackgroundTasks: async () => [{ status: 'running' }],
      getActiveRunStates: ['idle'],
    });
    const { exitCode, stderrLines } = await runExec(runtime, {
      backgroundDeliveryDrainTimeoutMs: 150,
    });
    expect(exitCode).toBe(0);
    expect(stderrLines.join('\n')).toContain(BACKGROUND_DELIVERY_DRAIN_TIMEOUT_NOTE);
  });
});

describe('waitForBackgroundDeliveryDrain unit', () => {
  it('returns unsupported without a capability and drained on a clean session', async () => {
    expect(
      await waitForBackgroundDeliveryDrain({
        runtime: {
          getActiveRun: async () => ({
            schemaVersion: 1,
            sessionId: 's',
            state: 'idle',
            actions: { steer: true },
          }),
        } as never,
        sessionId: 's',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
      }),
    ).toBe('unsupported');

    expect(
      await waitForBackgroundDeliveryDrain({
        runtime: {
          listBackgroundTasks: async () => [],
          getActiveRun: async () => ({
            schemaVersion: 1,
            sessionId: 's',
            state: 'idle',
            actions: { steer: true },
          }),
        },
        sessionId: 's',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
      }),
    ).toBe('drained');
  });

  it('drains after work settles and times out with the policy note text available', async () => {
    let reads = 0;
    const drained = await waitForBackgroundDeliveryDrain({
      runtime: {
        listBackgroundTasks: async () => {
          reads += 1;
          return reads < 3 ? [{ status: 'succeeded' }] : [{ status: 'succeeded', deliveredAtMs: 1 }];
        },
        getActiveRun: async () => ({
          schemaVersion: 1,
          sessionId: 's',
          state: 'idle',
          actions: { steer: true },
        }),
      },
      sessionId: 's',
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    });
    expect(drained).toBe('drained');
    expect(reads).toBeGreaterThanOrEqual(3);

    const timedOut = await waitForBackgroundDeliveryDrain({
      runtime: {
        listBackgroundTasks: async () => [{ status: 'running' }],
        getActiveRun: async () => ({
          schemaVersion: 1,
          sessionId: 's',
          state: 'idle',
          actions: { steer: true },
        }),
      },
      sessionId: 's',
      timeoutMs: 80,
      pollIntervalMs: 10,
    });
    expect(timedOut).toBe('timeout');
    expect(BACKGROUND_DELIVERY_DRAIN_TIMEOUT_NOTE).toContain('MCODE_SERVER_MODE');
  });

  it('reports the pending snapshot once through onPending', async () => {
    const onPending = vi.fn();
    let reads = 0;
    await waitForBackgroundDeliveryDrain({
      runtime: {
        listBackgroundTasks: async () => {
          reads += 1;
          return reads === 1 ? [{ status: 'succeeded' }] : [{ status: 'succeeded', deliveredAtMs: 1 }];
        },
        getActiveRun: async () => ({
          schemaVersion: 1,
          sessionId: 's',
          state: 'idle',
          actions: { steer: true },
        }),
      },
      sessionId: 's',
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      onPending,
    });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(onPending).toHaveBeenCalledWith({ active: 0, undeliveredTerminal: 1 });
  });
});
