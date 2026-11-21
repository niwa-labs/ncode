import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationSteerInput } from '@mavis/conversation-contract';

import {
  buildBackgroundTaskDeliveryInput,
  buildBackgroundTaskDeliveryPrompt,
  startConversationBackgroundTaskDeliveryTurn,
} from '../../src/background-task/conversation-delivery.js';
import type { BackgroundTask } from '../../src/background-task/domain.js';
import { LocalBackgroundTaskService } from '../../src/background-task/service.js';
import { FsLocalTaskOutputStore, SqliteLocalBackgroundTaskStore } from '../../src/background-task/store.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import type { LocalSessionRecord } from '../../src/sessions/controller.js';

/**
 * Owner override of verdict 09 §3.1 (2026-11-06): the wake envelope carries the
 * task's FULL output body from the same store `task_output` reads, so the model
 * answers without an extra `task_output` turn. No truncation or size limit is
 * introduced (owner rule); an empty output keeps the legacy envelope without
 * the field, and a host that cannot serve a body degrades to the legacy notice.
 */

const OWNER = 'session-owner';
const NOW_MS = 90_000;

describe('background delivery wake envelope with the result body', () => {
  let dataDir = '';
  let steer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    steer = vi.fn(async (input: ConversationSteerInput) => ({
      turnId: input.requestedTurnId!,
      mode: 'activated' as const,
      completion: Promise.resolve({ status: 'completed' } as never),
    }));
  });

  afterEach(async () => {
    if (!dataDir) return;
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(
      () => undefined,
    );
    dataDir = '';
  });

  function makeHost(options: {
    service: LocalTaskRunnerHostWithSessionLookup['backgroundTaskService'];
  }): LocalTaskRunnerHostWithSessionLookup {
    return {
      runtimeConversation: { ingress: { steer } },
      backgroundTaskService: options.service,
      nowMs: () => NOW_MS,
      getSessionById: async () =>
        ({
          sessionId: OWNER,
          sessionType: 'root',
        }) as unknown as LocalSessionRecord,
    } as unknown as LocalTaskRunnerHostWithSessionLookup;
  }

  async function makeService(): Promise<LocalBackgroundTaskService> {
    dataDir = await mkdtemp(join(tmpdir(), 'background-delivery-body-'));
    return new LocalBackgroundTaskService({
      store: new SqliteLocalBackgroundTaskStore(dataDir, () => NOW_MS),
      outputStore: new FsLocalTaskOutputStore(dataDir),
      nowMs: () => NOW_MS,
    });
  }

  async function seedTerminalTask(
    service: LocalBackgroundTaskService,
    overrides: Partial<BackgroundTask> = {},
  ): Promise<BackgroundTask> {
    return service.create({
      taskId: overrides.taskId ?? 'bg_body_1',
      ownerSessionId: OWNER,
      kind: 'subagent',
      status: 'succeeded',
      description: 'Reporting child',
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
      endedAt: NOW_MS + 10,
      ...overrides,
    });
  }

  it('includes the full output body in the wake steer, read from the task_output store', async () => {
    const service = await makeService();
    const host = makeHost({ service });
    await seedTerminalTask(service);
    await service.appendOutput({ taskId: 'bg_body_1', stream: 'final_result', content: 'the child report body' });

    const result = await startConversationBackgroundTaskDeliveryTurn({
      host,
      conversation: host.runtimeConversation!,
      ownerSessionId: OWNER,
      tasks: [(await service.get('bg_body_1'))!],
      observedTerminalCount: 1,
    });

    expect(result).toBe('delivered');
    expect(steer).toHaveBeenCalledTimes(1);
    const content = steer.mock.calls[0]![0].message.content as string;
    expect(content).toContain('<background-task-finished>');
    expect(content).toContain('<task task_id="bg_body_1" status="succeeded" description="Reporting child"');
    expect(content).toContain('<task_output>');
    expect(content).toContain('the child report body');
    // The instruction no longer sends the model through task_output for the body.
    expect(content).toContain('full output is included');
    expect(content).not.toContain('Use task_output with each task_id to read the results');
    // The idempotency key is untouched by the body.
    expect(steer.mock.calls[0]![0].idempotencyKey).toBe('bg_body_1');
  });

  it('reads a multi-chunk output in full (beyond the single 64KiB store page)', async () => {
    const service = await makeService();
    const chunk = 'x'.repeat(64 * 1024);
    const taskId = 'bg_body_paged';
    await seedTerminalTask(service, { taskId });
    await service.appendOutput({ taskId, stream: 'final_result', content: chunk });
    await service.appendOutput({ taskId, stream: 'final_result', content: 'TAIL-MARKER-9f2' });

    await expect(service.readFullOutput(taskId)).resolves.toContain('TAIL-MARKER-9f2');
    const full = await service.readFullOutput(taskId);
    expect(full).toHaveLength(chunk.length + 'TAIL-MARKER-9f2'.length);
  });

  it('omits the task_output field for an empty output and keeps the legacy notice', async () => {
    const service = await makeService();
    const host = makeHost({ service });
    await seedTerminalTask(service, { taskId: 'bg_body_empty' });

    const result = await startConversationBackgroundTaskDeliveryTurn({
      host,
      conversation: host.runtimeConversation!,
      ownerSessionId: OWNER,
      tasks: [(await service.get('bg_body_empty'))!],
      observedTerminalCount: 1,
    });

    expect(result).toBe('delivered');
    const content = steer.mock.calls[0]![0].message.content as string;
    expect(content).toContain('<task task_id="bg_body_empty" status="succeeded" description="Reporting child"');
    expect(content).toContain('/>');
    expect(content).not.toContain('<task_output>');
    // The legacy instruction survives for bodies-less envelopes.
    expect(content).toContain('Use task_output with each task_id to read the results');
  });

  it('escapes XML-significant characters in the body without truncating it', () => {
    const task = {
      taskId: 'bg_escape',
      ownerSessionId: OWNER,
      kind: 'subagent' as const,
      status: 'succeeded' as const,
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    };
    const body = '<note> a && b </note>';
    const prompt = buildBackgroundTaskDeliveryPrompt([task], new Map([[task.taskId, body]]));
    expect(prompt).toContain('&lt;note&gt; a &amp;&amp; b &lt;/note&gt;');
    expect(prompt).not.toContain('<note>');
  });

  it('degrades to the legacy envelope when the host cannot serve output bodies', async () => {
    const service = await makeService();
    // A plain object without readFullOutput — the shape older fakes and hosts pass.
    const legacyService = { get: (taskId: string) => service.get(taskId) } as unknown as LocalTaskRunnerHostWithSessionLookup['backgroundTaskService'];
    const host = makeHost({ service: legacyService });
    await seedTerminalTask(service, { taskId: 'bg_body_legacy' });
    await service.appendOutput({ taskId: 'bg_body_legacy', stream: 'final_result', content: 'unreachable body' });

    const result = await startConversationBackgroundTaskDeliveryTurn({
      host,
      conversation: host.runtimeConversation!,
      ownerSessionId: OWNER,
      tasks: [(await service.get('bg_body_legacy'))!],
      observedTerminalCount: 1,
    });

    expect(result).toBe('delivered');
    const content = steer.mock.calls[0]![0].message.content as string;
    expect(content).not.toContain('<task_output>');
    expect(content).toContain('Use task_output with each task_id to read the results');
  });

  it('keeps the batch byte bounds measuring the metadata envelope only', () => {
    const task = {
      taskId: 'bg_bounds',
      ownerSessionId: OWNER,
      kind: 'subagent' as const,
      status: 'succeeded' as const,
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    };
    // The input builder without an outputs map (what selectDeliveryBatch calls)
    // stays within the historical budget shape regardless of any body.
    const input = buildBackgroundTaskDeliveryInput({
      ownerSessionId: OWNER,
      tasks: [task],
      observedTerminalCount: 1,
      requestedTurnId: 'turn_task_delivery_x',
    });
    expect(input.message.content).not.toContain('<task_output>');
    expect(input.idempotencyKey).toBe('bg_bounds');
  });
});
