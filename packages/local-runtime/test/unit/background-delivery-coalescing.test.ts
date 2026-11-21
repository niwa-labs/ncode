import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import { closeLocalBackgroundTaskDelivery } from '../../src/background-task/delivery.js';
import {
  scheduleLocalBackgroundTaskDelivery,
  startLocalBackgroundTaskDeliveryTurn,
} from '../../src/background-task/delivery.js';
import type { BackgroundTask } from '../../src/background-task/domain.js';
import type { ConversationSteerInput } from '@mavis/conversation-contract';
import type { LocalSessionRecord } from '../../src/sessions/controller.js';

/**
 * Verdict 09 §3.3 / acceptance №11 over the real scheduler with a virtual
 * clock: five simultaneous terminals coalesce into ONE delivery admission;
 * the coalescing timer is never shifted by later finishes; the rate limit
 * binds NEW autonomous activations only (a delivery that joins an active
 * owner Turn consumes no budget; owner input never goes through this
 * scheduler at all); an exhausted window produces an exact trailing drain at
 * its release — and never escalates into the transport-failure cooldown.
 */

const OWNER = 'session-owner';

interface SteerRecord {
  readonly input: ConversationSteerInput;
  readonly mode: 'activated' | 'steered';
}

describe('background delivery coalescing and the activation-only storm guard (§3.3, №11)', () => {
  /** The host clock IS the fake clock: advancing timers advances the runtime. */
  const clock = () => Date.now();
  let steer: ReturnType<typeof vi.fn>;
  let activationBudget: 'activated' | 'steered';
  let steers: SteerRecord[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(31_000);
    steers = [];
    // Default rig: every admission would WAKE an idle session (`activated`),
    // so the storm guard applies; a test flips the mode per call as needed.
    activationBudget = 'activated';
    steer = vi.fn(async (input: ConversationSteerInput) => {
      const mode = activationBudget;
      // Emulate the runtime admission contract: preDelivery.accept receives the
      // authoritative mode BEFORE delivery and its throw rejects the admission.
      await input.preDelivery?.accept({ mode, turnId: 'turn-active' });
      steers.push({ input, mode });
      return mode === 'activated'
        ? {
            mode: 'activated' as const,
            turnId: `turn-wake-${steers.length}`,
            completion: Promise.resolve({ status: 'completed' } as never),
          }
        : { mode, turnId: 'turn-active' };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function host(
    tasks: readonly BackgroundTask[] = [],
    options: { service?: LocalTaskRunnerHostWithSessionLookup['backgroundTaskService'] } = {},
  ): LocalTaskRunnerHostWithSessionLookup {
    const rows = new Map<string, BackgroundTask>(tasks.map((task) => [task.taskId, task]));
    return {
      runtimeConversation: { ingress: { steer } },
      backgroundTaskService:
        options.service ??
        ({
          get: async (taskId: string) => rows.get(taskId),
          reminderSnapshot: async () => ({
            tasks: [],
            undeliveredTotal: rows.size,
            terminalTotal: rows.size,
          }),
        } as unknown as LocalTaskRunnerHostWithSessionLookup['backgroundTaskService']),
      metricsClient: { counter: vi.fn() },
      nowMs: () => clock(),
      getSessionById: async () => rootSession(),
    } as unknown as LocalTaskRunnerHostWithSessionLookup;
  }

  function terminalTask(taskId: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
    return {
      taskId,
      ownerSessionId: OWNER,
      kind: 'subagent',
      status: 'succeeded',
      description: `Task ${taskId}`,
      createdAt: 1_000,
      updatedAt: 1_000,
      endedAt: 2_000,
      ...overrides,
    };
  }

  it('coalesces five simultaneous terminals into ONE delivery admission within the fixed window', async () => {
    const fixture = host([
      terminalTask('bg-1'),
      terminalTask('bg-2'),
      terminalTask('bg-3'),
      terminalTask('bg-4'),
      terminalTask('bg-5'),
    ]);
    scheduleLocalBackgroundTaskDelivery(fixture, 'bg-1');
    scheduleLocalBackgroundTaskDelivery(fixture, 'bg-2');
    scheduleLocalBackgroundTaskDelivery(fixture, 'bg-3');
    scheduleLocalBackgroundTaskDelivery(fixture, 'bg-4');
    scheduleLocalBackgroundTaskDelivery(fixture, 'bg-5');

    // Inside the coalescing window nothing has been admitted yet…
    await vi.advanceTimersByTimeAsync(49);
    expect(steer).not.toHaveBeenCalled();
    // …and at the window's edge ALL five go out together as one batch.
    await vi.advanceTimersByTimeAsync(1);
    await flushEnqueues();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steers[0]!.input.message.origin.taskIds).toEqual(['bg-1', 'bg-2', 'bg-3', 'bg-4', 'bg-5']);
    expect(steers[0]!.input.message.content).toContain('<background-task-finished>');
    // The window edge is 50ms after the first terminal, not later: the timer
    // was not shifted by the four joins.
    expect(clock()).toBe(31_050);
  });

  it('never moves the coalescing timer: a finish 30ms later still admits at +50ms', async () => {
    let releaseLateJoin: (() => void) | undefined;
    let lateTask: BackgroundTask | undefined;
    const service = {
      get: async (taskId: string) => {
        if (taskId === 'bg-first') return terminalTask('bg-first');
        // The late joiner resolves only when the test releases it (30ms later);
        // every read after the release sees the settled row.
        if (lateTask) return lateTask;
        return await new Promise<BackgroundTask | undefined>((resolve) => {
          releaseLateJoin = () => {
            lateTask = terminalTask('bg-late');
            resolve(lateTask);
          };
        });
      },
      reminderSnapshot: async () => ({ tasks: [], undeliveredTotal: 2, terminalTotal: 2 }),
    } as unknown as LocalTaskRunnerHostWithSessionLookup['backgroundTaskService'];
    const fixture = host([], { service });

    scheduleLocalBackgroundTaskDelivery(fixture, 'bg-first');
    await flushEnqueues();
    scheduleLocalBackgroundTaskDelivery(fixture, 'bg-late');
    await vi.advanceTimersByTimeAsync(30);
    expect(releaseLateJoin, 'the late join lookup must be pending by now').toBeDefined();
    releaseLateJoin!();
    await flushEnqueues();

    await vi.advanceTimersByTimeAsync(20);
    await flushDeliveries();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(clock()).toBe(31_050);
    expect(steers[0]!.input.message.origin.taskIds).toEqual(['bg-first', 'bg-late']);
  });

  it('exhausts the 3/60s activation guard and trailing-drains the rest at the window release', async () => {
    const fixture = host([
      terminalTask('bg-a'),
      terminalTask('bg-b'),
      terminalTask('bg-c'),
      terminalTask('bg-d'),
      terminalTask('bg-e'),
    ]);
    // Every batch here is one task (delivered one at a time), so five tasks
    // would be five ACTIVATIONS: the guard stops the fourth.
    for (const taskId of ['bg-a', 'bg-b', 'bg-c', 'bg-d', 'bg-e']) {
      scheduleLocalBackgroundTaskDelivery(fixture, taskId);
      await flushEnqueues();
      // Deliver strictly sequentially (one in-flight admission per session).
      await vi.advanceTimersByTimeAsync(51);
      await flushDeliveries();
    }
    // Three wake Turns went out; tasks 4 and 5 were deferred, not lost.
    const wakeSteers = steers.filter((entry) => entry.mode === 'activated');
    expect(wakeSteers.map((entry) => entry.input.message.origin.taskIds)).toEqual([
      ['bg-a'],
      ['bg-b'],
      ['bg-c'],
    ]);

    // Arrivals during the hold must not bypass it with per-arrival retries…
    await vi.advanceTimersByTimeAsync(5_000);
    expect(steers).toHaveLength(3);
    // …and the exact trailing drain fires at the window's release (60s from
    // the first activation), NEVER after a 300s failure cooldown. The two
    // terminals accumulated during the hold leave together as one batch.
    await vi.advanceTimersByTimeAsync(55_000);
    await flushDeliveries();
    const drained = steers.slice(3).map((entry) => entry.input.message.origin.taskIds);
    expect(drained.flat()).toEqual(expect.arrayContaining(['bg-d', 'bg-e']));
    expect(drained.length).toBeGreaterThanOrEqual(1);
    expect(drained.length).toBeLessThanOrEqual(2);
    expect(clock()).toBeLessThan(31_000 + 61_500);
  });

  it('does not rate-limit deliveries that join an already-active owner Turn', async () => {
    activationBudget = 'steered';
    const fixture = host(
      Array.from({ length: 6 }, (_, index) => terminalTask(`bg-join-${index + 1}`)),
    );
    for (let index = 1; index <= 6; index += 1) {
      scheduleLocalBackgroundTaskDelivery(fixture, `bg-join-${index}`);
      await flushEnqueues();
      await vi.advanceTimersByTimeAsync(51);
      await flushDeliveries();
    }
    // Six joins inside one 60s window: no activation budget involved, every
    // notice delivered.
    expect(steers).toHaveLength(6);
    expect(steers.every((entry) => entry.mode === 'steered')).toBe(true);
  });

  it('keeps batch bounds: 33 terminals admit as 32 + 1 through the single in-flight slot', async () => {
    const fixture = host(
      Array.from({ length: 33 }, (_, index) => terminalTask(`bg-bulk-${index + 1}`)),
    );
    for (let index = 1; index <= 33; index += 1) {
      scheduleLocalBackgroundTaskDelivery(fixture, `bg-bulk-${index}`);
    }
    await flushEnqueues();
    await vi.advanceTimersByTimeAsync(50);
    await flushDeliveries();
    expect(steers).toHaveLength(1);
    expect(steers[0]!.input.message.origin.taskIds).toHaveLength(32);
    // The overflow epoch opens with the batch it follows; the single in-flight
    // rule serializes it right after the first admission settles.
    await vi.advanceTimersByTimeAsync(200);
    await flushDeliveries();
    expect(steers).toHaveLength(2);
    expect(steers[1]!.input.message.origin.taskIds).toEqual(['bg-bulk-33']);
  });

  it('delivers distinct terminal generations of repeated append work separately (§3.1)', async () => {
    const first = terminalTask('bg-appended', {
      metadata: { subTurnId: 'child-turn-1' },
    });
    const second = terminalTask('bg-appended-2', {
      metadata: { subTurnId: 'child-turn-2' },
    });
    const fixture = host([first, second]);
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture, 'bg-appended')).resolves.toBe(
      'delivered',
    );
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture, 'bg-appended-2')).resolves.toBe(
      'delivered',
    );
    // Each notice names its own terminal run (child_turn_id), and the
    // idempotency keys differ per generation while staying retry-stable.
    expect(steers[0]!.input.message.content).toContain('child_turn_id="child-turn-1"');
    expect(steers[1]!.input.message.content).toContain('child_turn_id="child-turn-2"');
    expect(steers[0]!.input.idempotencyKey).toBe('bg-appended@child-turn-1');
    expect(steers[1]!.input.idempotencyKey).toBe('bg-appended-2@child-turn-2');
  });

  it('keeps the legacy single-task key retry-stable when no terminal generation is recorded', async () => {
    const fixture = host([terminalTask('bg-legacy')]);
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture, 'bg-legacy')).resolves.toBe(
      'delivered',
    );
    expect(steers[0]!.input.idempotencyKey).toBe('bg-legacy');
    expect(steers[0]!.input.message.content).not.toContain('child_turn_id');
  });
});

/** Let every pending scheduler lookup promise settle (fake timers don't tick microtasks). */
async function flushEnqueues(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
}

/** Let an in-flight delivery admission settle before advancing the clock again. */
async function flushDeliveries(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
}

function rootSession(): LocalSessionRecord {
  return {
    sessionId: OWNER,
    agentName: 'mavis',
    workspaceDir: '/tmp/unused',
    runtime: 'pi-agent',
    sessionType: 'root',
    archived: false,
    pinned: false,
    status: 'idle',
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  } as unknown as LocalSessionRecord;
}
