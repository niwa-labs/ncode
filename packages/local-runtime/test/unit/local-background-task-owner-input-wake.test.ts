import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalBackgroundTaskService } from '../../src/background-task/service.js';
import { FsLocalTaskOutputStore, SqliteLocalBackgroundTaskStore } from '../../src/background-task/store.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';
import { toolContext } from './background-task-test-helpers.js';

/**
 * Owner-input wake of a bounded task_output wait (owner bug 2026-11-06): the
 * model parked its turn in `task_output wait_ms` while the owner sent a new
 * message ("go go") — the read must release early instead of parking the turn
 * behind the input the runtime already accepted. The probe is the steering
 * composition's accepted-owner-input generation (verdict 09 §1.7): only a
 * trusted owner input bumps it, so the read can never be released by a machine
 * delivery. Without the probe (JSONL) the wait keeps the exact legacy behavior.
 */

const OWNER = 'session-owner';
const NOW_MS = 90_000;

describe('bounded task_output wait releases on accepted owner input', () => {
  let dataDir = '';

  afterEach(async () => {
    if (!dataDir) return;
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(
      () => undefined,
    );
    dataDir = '';
  });

  async function makeService(bindProbe: boolean): Promise<{
    service: LocalBackgroundTaskService;
    bumpGeneration: () => void;
  }> {
    dataDir = await mkdtemp(join(tmpdir(), 'task-output-owner-wake-'));
    const service = new LocalBackgroundTaskService({
      store: new SqliteLocalBackgroundTaskStore(dataDir, () => NOW_MS),
      outputStore: new FsLocalTaskOutputStore(dataDir),
      nowMs: () => NOW_MS,
    });
    const generation = { value: 0 };
    if (bindProbe) {
      service.bindOwnerInputGeneration(() => generation.value);
    }
    return {
      service,
      bumpGeneration: () => {
        generation.value += 1;
      },
    };
  }

  async function seedRunningTask(
    service: LocalBackgroundTaskService,
    taskId = 'bg_wait_1',
  ): Promise<void> {
    await service.create({
      taskId,
      ownerSessionId: OWNER,
      kind: 'subagent',
      status: 'running',
      description: 'Long child',
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
  }

  it('returns early with releasedFromOwnerInput when the generation bumps mid-wait', async () => {
    const { service, bumpGeneration } = await makeService(true);
    await seedRunningTask(service);

    const startedAt = Date.now();
    const pending = service.readOutput(toolContext(OWNER), 'bg_wait_1', { waitMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    bumpGeneration();
    const read = await pending;
    const elapsedMs = Date.now() - startedAt;

    // Released at the probe slice (~250 ms), never near the 30 s bound.
    expect(elapsedMs).toBeLessThan(10_000);
    expect(read.releasedFromOwnerInput).toBe(true);
    expect(read.timedOut).toBe(false);
    // Output-so-far plus the still-running status: an ordinary toolResult.
    expect(read.status).toBe('running');
    expect(read.task?.status).toBe('running');
  });

  it('without an owner input the wait runs to its full bound as before', async () => {
    const { service } = await makeService(true);
    await seedRunningTask(service, 'bg_wait_2');

    const startedAt = Date.now();
    const read = await service.readOutput(toolContext(OWNER), 'bg_wait_2', { waitMs: 500 });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(450);
    expect(read.timedOut).toBe(true);
    expect(read.releasedFromOwnerInput).toBeUndefined();
    expect(read.status).toBe('running');
  });

  it('a host without the probe keeps the legacy full-wait behavior', async () => {
    const { service } = await makeService(false);
    await seedRunningTask(service, 'bg_wait_3');

    const startedAt = Date.now();
    const read = await service.readOutput(toolContext(OWNER), 'bg_wait_3', { waitMs: 400 });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(350);
    expect(read.timedOut).toBe(true);
    expect(read.releasedFromOwnerInput).toBeUndefined();
  });

  it('the early release consumes no delivery and the output wake still fires exactly once', async () => {
    const { service, bumpGeneration } = await makeService(true);
    await seedRunningTask(service, 'bg_wait_4');

    const pending = service.readOutput(toolContext(OWNER), 'bg_wait_4', { waitMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    bumpGeneration();
    const released = await pending;
    expect(released.releasedFromOwnerInput).toBe(true);

    // The read is a plain tool result: nothing about the task was consumed —
    // no deliveredAt latch, still running, waiter registry intact.
    const afterRelease = await service.get('bg_wait_4');
    expect(afterRelease?.status).toBe('running');
    expect(afterRelease?.deliveredAt).toBeUndefined();

    // A later parked read still wakes from output (the waiter registry was not
    // disturbed by the early release), and the terminal read is honest.
    const parked = service.readOutput(toolContext(OWNER), 'bg_wait_4', { waitMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await service.appendOutput({
      taskId: 'bg_wait_4',
      stream: 'final_result',
      content: 'the late child report',
    });
    const woken = await parked;
    expect(woken.content).toBe('the late child report');
    expect(woken.timedOut).toBe(false);
    expect(woken.releasedFromOwnerInput).toBeUndefined();
  });
});
