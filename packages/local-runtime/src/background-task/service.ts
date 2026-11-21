import { waitForChildBashTaskChange } from './child-bash-lifecycle.js';
import { performTaskStop } from './task-stop.js';
import {
  createTaskLifecycleEventId,
  InvalidTaskStatusTransitionError,
  isTerminalTaskStatus,
  type BackgroundTask,
  type BackgroundTaskCheckpointSnapshot,
  type BackgroundTaskReminderSnapshot,
  type BackgroundTaskPatch,
  type BackgroundTaskStatus,
  type TaskListResult,
  type TaskOutputChunk,
  type TaskOutputRef,
  type TaskOutputStore,
  type TaskQuery,
  type TaskStore,
} from './domain.js';
import { StartupTaskRecovery, type BackgroundTaskRuntimeOwner } from './startup-recovery.js';
import { captureBackgroundTaskCheckpointSnapshot } from './checkpoint-snapshot.js';
import type {
  LocalRuntimeToolContext,
  LocalTaskControlAdapter,
  LocalTaskOutputReadOptions,
  LocalTaskOutputReadResult,
} from '@mavis/agent-tools/desktop';
import { logger } from '../common/logger.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { KeyedOperationQueue } from './keyed-operation-queue.js';
import { TaskWaiterRegistry, taskWaitAbortError } from './task-waiter-registry.js';

export interface LocalBackgroundTaskServiceOptions {
  store: TaskStore;
  outputStore: TaskOutputStore;
  nowMs?: () => number;
  stopRuntime?: (task: BackgroundTask, reason?: string) => Promise<void>;
  /**
   * Fire once from the unified lifecycle exit after a task commits terminal state, waking Goals
   * waiting for required_background. Notifications keep retrying in memory but are lost on process
   * exit; terminal-state liveness must depend on committed state, not user-facing notification
   * delivery.
   */
  onTerminal?: (input: {
    readonly taskId: string;
    readonly ownerSessionId: string;
    readonly status: BackgroundTaskStatus;
  }) => void;
}

/**
 * How often a bounded task_output wait re-probes the accepted-owner-input
 * generation while parked (owner-input wake, owner bug 2026-11-06). One in-
 * memory Map read per slice; the slice bounds the added wake latency, and a
 * slice timeout falls back to the regular re-read so no output wake is lost
 * between probes.
 */
const OWNER_INPUT_PROBE_INTERVAL_MS = 250;

/**
 * The accepted-owner-input generation probe of the steering composition's
 * native task-wait binding (verdict 09 §1.7, wave 3). Late-bound by the
 * runtime host next to `nativeTaskWaits`; a generation change during a bounded
 * task_output wait releases it early — the owner's steer reaches the model in
 * the SAME turn (canon 09), so the read must not park the turn behind it.
 * Unset on hosts without the binding (JSONL): the wait runs to its full bound.
 */
type OwnerInputGenerationProbe = (ownerSessionId: string) => number;

export class LocalBackgroundTaskService implements LocalTaskControlAdapter {
  private runtimeOwner?: BackgroundTaskRuntimeOwner;
  private readonly startupRecovery: StartupTaskRecovery;
  private ownerInputGeneration?: OwnerInputGenerationProbe;

  bindRuntimeOwner(owner: BackgroundTaskRuntimeOwner): void {
    this.runtimeOwner = owner;
  }

  /**
   * Late-binds the owner-input generation probe (durable mode only — the
   * native task-wait binding exists there). jsonl/legacy hosts never bind it,
   * so bounded waits keep the exact legacy full-wait behavior.
   */
  bindOwnerInputGeneration(probe: OwnerInputGenerationProbe): void {
    this.ownerInputGeneration = probe;
  }

  private readonly store: TaskStore;
  private readonly outputStore: TaskOutputStore;
  private readonly nowMs: () => number;
  private readonly stopRuntime?: (task: BackgroundTask, reason?: string) => Promise<void>;
  private readonly onTerminal?: LocalBackgroundTaskServiceOptions['onTerminal'];
  private readonly taskWaiters = new TaskWaiterRegistry();
  private readonly stopRequests = new Map<string, Promise<BackgroundTask | undefined>>();
  // ponytail: runtime-local cursors replay from byte 0 after restart; persist only if replay costs justify it.
  private readonly taskOutputCursors = new Map<string, number>();
  private readonly taskOutputReads = new KeyedOperationQueue();

  constructor(options: LocalBackgroundTaskServiceOptions) {
    this.store = options.store;
    this.outputStore = options.outputStore;
    this.nowMs = options.nowMs ?? Date.now;
    this.stopRuntime = options.stopRuntime;
    this.onTerminal = options.onTerminal;
    this.startupRecovery = new StartupTaskRecovery({
      nowMs: this.nowMs,
      patchLost: (task, patch) => this.patchStatusIfNotTerminal(task, 'lost', patch),
      emitCompleted: (task, reason) => this.emit(task, 'completed', { status: 'lost', reason }),
    });
  }

  async create(task: BackgroundTask): Promise<BackgroundTask> {
    const created = await this.store.create(
      this.runtimeOwner
        ? {
            ...task,
            metadata: { ...task.metadata, runtimeOwnerId: this.runtimeOwner.ownerId },
          }
        : task,
    );
    await this.emit(created, 'created');
    return created;
  }

  async get(
    ctxOrTaskId: LocalRuntimeToolContext | string,
    maybeTaskId?: string,
  ): Promise<BackgroundTask | undefined> {
    const ctx = typeof ctxOrTaskId === 'string' ? undefined : ctxOrTaskId;
    const taskId = typeof ctxOrTaskId === 'string' ? ctxOrTaskId : maybeTaskId;
    if (!taskId) return undefined;
    const task = await this.store.get(taskId);
    return isVisibleToContext(task, ctx) ? task : undefined;
  }

  async list(
    ctxOrQuery: LocalRuntimeToolContext | TaskQuery,
    maybeQuery?: TaskQuery,
  ): Promise<TaskListResult> {
    const ctx = isToolContext(ctxOrQuery) ? ctxOrQuery : undefined;
    const query = isToolContext(ctxOrQuery) ? (maybeQuery ?? {}) : ctxOrQuery;
    return this.store.list({
      ...query,
      ...(ctx ? { ownerSessionId: ctx.sessionId } : {}),
    });
  }

  async reminderSnapshot(
    session:
      | string
      | Pick<
          LocalSessionRecord,
          'sessionId' | 'sessionType' | 'parentSessionId' | 'visibility' | 'sessionKind'
        >,
  ): Promise<BackgroundTaskReminderSnapshot> {
    return typeof session !== 'string' && isLocalChildWorkerSession(session)
      ? { tasks: [], undeliveredTotal: 0, terminalTotal: 0 }
      : this.store.reminderSnapshot(typeof session === 'string' ? session : session.sessionId, 5);
  }

  async waitForTaskChange(
    ownerSessionId: string,
    taskIds: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    return waitForChildBashTaskChange(
      this.taskWaiters,
      { ownerSessionId, taskIds, signal },
      (taskId) => this.get(taskId),
    );
  }

  async captureCheckpointSnapshot(
    ownerSessionId: string,
  ): Promise<BackgroundTaskCheckpointSnapshot | undefined> {
    return captureBackgroundTaskCheckpointSnapshot({
      ownerSessionId,
      capturedAtMs: this.nowMs(),
      store: this.store,
      outputStore: this.outputStore,
    });
  }

  /**
   * Wave 3 recovery (§5.4 №16 rupture "terminal persist до enqueue"): the
   * terminal subagent rows whose delivery never left this process — the
   * scheduler retries in memory only, so a crash after the durable persist
   * leaves an honest terminal with `deliveredAt` unset and NOBODY left to
   * deliver it. Candidates are the rows owned by a DEAD runtime owner: a
   * live owner still retries on its own, and the caller schedules delivery
   * for what this returns. Read-only; scheduling stays with the host.
   */
  async listUndeliveredTerminalTasksOfDeadOwners(): Promise<BackgroundTask[]> {
    if (!this.runtimeOwner) return [];
    const list = await this.store.list({
      kinds: ['subagent'],
      statuses: ['succeeded', 'failed', 'canceled', 'lost'],
      undeliveredOnly: true,
      limit: 500,
    });
    return list.items.filter((task) => {
      const ownerId = task.metadata?.runtimeOwnerId;
      return (
        typeof ownerId === 'string' &&
        ownerId !== this.runtimeOwner!.ownerId &&
        this.runtimeOwner!.isOwnerAlive(ownerId) === false
      );
    });
  }

  async markDelivered(ownerSessionId: string, taskIds: string[]): Promise<BackgroundTask[]> {
    const deliveredAt = this.nowMs();
    const delivered: BackgroundTask[] = [];
    for (const taskId of taskIds) {
      const task = await this.store.get(taskId);
      if (!isVisibleToOwnerSession(task, ownerSessionId) || !isTerminalTaskStatus(task.status)) {
        continue;
      }
      if (task.deliveredAt !== undefined) {
        delivered.push(task);
        continue;
      }
      delivered.push(await this.store.patch(taskId, { deliveredAt, updatedAt: deliveredAt }));
    }
    return delivered;
  }

  async reconcileStartupLostTasks(
    options: {
      reason?: string;
      createdBeforeMs?: number;
      recoveredTurnIds?: readonly string[];
    } = {},
  ): Promise<BackgroundTask[]> {
    const pending = await this.startupRecovery.collect(this.store, options, this.runtimeOwner);
    return this.startupRecovery.settle(pending, options);
  }

  hasPendingStartupRecovery(): boolean {
    return this.startupRecovery.hasPending();
  }

  async pollStartupLostTasks(): Promise<boolean> {
    if (!this.runtimeOwner || !this.startupRecovery.hasPending()) return false;
    const pending = await this.startupRecovery.poll(this.store, this.runtimeOwner);
    await this.startupRecovery.settle(pending);
    return this.startupRecovery.hasPending();
  }

  async readOutput(
    ctxOrTaskId: LocalRuntimeToolContext | string,
    taskIdOrOptions?: string | LocalTaskOutputReadOptions,
    maybeOptions?: LocalTaskOutputReadOptions,
  ): Promise<LocalTaskOutputReadResult> {
    const ctx = typeof ctxOrTaskId === 'string' ? undefined : ctxOrTaskId;
    const taskId = typeof ctxOrTaskId === 'string' ? ctxOrTaskId : String(taskIdOrOptions ?? '');
    const options = typeof ctxOrTaskId === 'string' ? taskIdOrOptions : maybeOptions;
    const readOptions = optionsAsReadOptions(options);
    if (ctx && readOptions?.offset === undefined) {
      const cursorKey = JSON.stringify([ctx.sessionId, taskId]);
      return this.taskOutputReads.run(cursorKey, async () => {
        if (readOptions?.signal?.aborted) throw taskWaitAbortError(readOptions.signal);
        const offset = this.taskOutputCursors.get(cursorKey);
        const read = await this.readOutputAtOffset(ctx, taskId, {
          ...(readOptions ?? {}),
          ...(offset === undefined ? {} : { offset }),
        });
        if (readOptions?.signal?.aborted) throw taskWaitAbortError(readOptions.signal);
        if (read.nextOffset !== undefined) this.taskOutputCursors.set(cursorKey, read.nextOffset);
        return read;
      });
    }
    return this.readOutputAtOffset(ctx, taskId, readOptions);
  }

  private async readOutputAtOffset(
    ctx: LocalRuntimeToolContext | undefined,
    taskId: string,
    readOptions: LocalTaskOutputReadOptions | undefined,
  ): Promise<LocalTaskOutputReadResult> {
    if (readOptions?.signal?.aborted) throw taskWaitAbortError(readOptions.signal);
    const waitMs = clampTaskOutputWaitMs(readOptions?.waitMs);
    const deadline = Date.now() + waitMs;
    // Owner-input wake (owner bug 2026-11-06): the generation of the READING
    // conversation, captured once per read. A trusted owner input accepted
    // while the wait is parked bumps it and releases the wait early — the
    // steer is delivered into the same turn, so a blocking read must not park
    // the model behind it. No probe (JSONL, no owner session, no wait): the
    // loop behaves exactly as before.
    const ownerInputBaseline =
      waitMs > 0 && ctx && this.ownerInputGeneration
        ? {
            sessionId: ctx.sessionId,
            generation: this.ownerInputGeneration(ctx.sessionId),
          }
        : undefined;

    for (;;) {
      // Register before reading the durable snapshot so output arriving between
      // the read and the await cannot become a missed wake-up.
      const waiter = waitMs > 0 ? this.taskWaiters.create(taskId, readOptions?.signal) : undefined;
      try {
        const visibleTask = await this.get(ctx ?? taskId, ctx ? taskId : undefined);
        if (!visibleTask) {
          return { content: '', nextOffset: readOptions?.offset ?? 0 };
        }
        const read = await this.outputStore.read(taskId, readOptions);
        const task = (await this.get(ctx ?? taskId, ctx ? taskId : undefined)) ?? visibleTask;
        const hasNewOutput =
          read.content.length > 0 ||
          (read.nextOffset !== undefined && read.nextOffset > (readOptions?.offset ?? 0));
        if (waitMs === 0 || hasNewOutput || isTerminalTaskStatus(task.status)) {
          return {
            ...read,
            status: task.status,
            task,
            ...(waitMs > 0 ? { timedOut: false } : {}),
          };
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return { ...read, status: task.status, task, timedOut: true };
        }
        const outcome = await this.waitBoundedOutput(
          waiter!,
          remainingMs,
          ownerInputBaseline,
        );
        if (outcome === 'owner_input' && ownerInputBaseline) {
          // Release with the freshest snapshot, exactly like the timeout path:
          // the model gets the output-so-far plus the still-running status, and
          // the completion notice still arrives automatically (delivery is
          // keyed by the terminal run — an early read never consumes it).
          const [latestTask, latestRead] = await Promise.all([
            this.get(ctx ?? taskId, ctx ? taskId : undefined),
            this.outputStore.read(taskId, readOptions),
          ]);
          logger.info(
            {
              event: 'task_output_wait_released_by_owner_input',
              taskId,
              ownerSessionId: ownerInputBaseline.sessionId,
            },
            'Bounded task_output wait released early by accepted owner input',
          );
          return {
            ...latestRead,
            ...(latestTask ? { status: latestTask.status, task: latestTask } : {}),
            timedOut: false,
            releasedFromOwnerInput: true,
          };
        }
        if (outcome === 'timeout') {
          const latestTask = await this.get(ctx ?? taskId, ctx ? taskId : undefined);
          const latestRead = await this.outputStore.read(taskId, readOptions);
          return {
            ...latestRead,
            ...(latestTask ? { status: latestTask.status, task: latestTask } : {}),
            timedOut: true,
          };
        }
      } finally {
        waiter?.cancel();
      }
    }
  }

  /**
   * One parked stretch of the bounded read. Without the owner-input probe this
   * is the legacy single waiter wait. With it, the wait is sliced at
   * {@link OWNER_INPUT_PROBE_INTERVAL_MS} and the generation is re-read after
   * every slice; a change resolves `'owner_input'`. A slice timeout falls back
   * to the caller's loop (fresh read + re-register), so output arriving
   * between probes wakes the read exactly once through the normal path.
   */
  private async waitBoundedOutput(
    waiter: { wait(timeoutMs: number): Promise<'event' | 'timeout'> },
    remainingMs: number,
    ownerInputBaseline:
      | { sessionId: string; generation: number }
      | undefined,
  ): Promise<'event' | 'timeout' | 'owner_input'> {
    if (!ownerInputBaseline || !this.ownerInputGeneration) {
      return waiter.wait(remainingMs);
    }
    for (let left = remainingMs; left > 0; ) {
      const slice = Math.min(left, OWNER_INPUT_PROBE_INTERVAL_MS);
      const outcome = await waiter.wait(slice);
      if (outcome === 'event') return 'event';
      if (this.ownerInputGeneration(ownerInputBaseline.sessionId) !== ownerInputBaseline.generation) {
        return 'owner_input';
      }
      left -= slice;
    }
    return 'timeout';
  }

  async stop(
    ctxOrTaskId: LocalRuntimeToolContext | string,
    taskIdOrReason?: string,
    maybeReason?: string,
  ): Promise<BackgroundTask | undefined> {
    const ctx = typeof ctxOrTaskId === 'string' ? undefined : ctxOrTaskId;
    const taskId = typeof ctxOrTaskId === 'string' ? ctxOrTaskId : taskIdOrReason;
    const reason = typeof ctxOrTaskId === 'string' ? taskIdOrReason : maybeReason;
    if (!taskId) return undefined;
    const task = await this.get(ctx ?? taskId, ctx ? taskId : undefined);
    if (!task) return undefined;
    if (isTerminalTaskStatus(task.status)) return task;

    // Two callers can both observe `running`. Install one shared stop promise
    // after the visibility check but before the first state mutation, then
    // make every concurrent caller reuse its settled terminal result.
    const pendingAfterRead = this.stopRequests.get(taskId);
    if (pendingAfterRead) return pendingAfterRead;
    const stopping = performTaskStop(
      {
        store: this.store,
        nowMs: this.nowMs,
        stopRuntime: this.stopRuntime,
        patchStatusIfNotTerminal: (current, status, patch) =>
          this.patchStatusIfNotTerminal(current, status, patch),
        emit: (current, type, payload) => this.emit(current, type, payload),
      },
      task,
      reason,
    );
    this.stopRequests.set(taskId, stopping);
    try {
      return await stopping;
    } finally {
      if (this.stopRequests.get(taskId) === stopping) this.stopRequests.delete(taskId);
    }
  }

  async patch(taskId: string, patch: BackgroundTaskPatch): Promise<BackgroundTask> {
    const task = await this.store.patch(taskId, patch);
    if (patch.status) {
      await this.emit(task, isTerminalTaskStatus(patch.status) ? 'completed' : 'status_changed', {
        status: patch.status,
      });
    }
    return task;
  }

  async patchIfNotTerminal(
    taskId: string,
    patch: BackgroundTaskPatch,
  ): Promise<{ task: BackgroundTask; patched: boolean }> {
    try {
      return { task: await this.patch(taskId, patch), patched: true };
    } catch (error) {
      const terminal = await this.getTerminalAfterInvalidTransition(taskId, error);
      if (terminal) return { task: terminal, patched: false };
      throw error;
    }
  }

  async appendOutput(chunk: TaskOutputChunk): Promise<TaskOutputRef> {
    const outputRef = await this.outputStore.append(chunk);
    const task = await this.store.patch(chunk.taskId, {
      outputRef,
      updatedAt: chunk.timestamp ?? this.nowMs(),
    });
    await this.emit(task, 'output_updated', { outputRef });
    return outputRef;
  }

  async finalizeOutput(taskId: string, summary?: string): Promise<void> {
    await this.outputStore.finalize(taskId, summary);
  }

  /**
   * The task's entire output, paged through the exact store `task_output` reads
   * (same source, no separate limit): the wake envelope carries the result body
   * so the model does not spend an extra turn on `task_output`. Empty for a
   * task that never wrote output.
   */
  async readFullOutput(taskId: string): Promise<string> {
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const read = await this.outputStore.read(taskId, { offset });
      if (read.content) chunks.push(read.content);
      if (!read.truncated || read.nextOffset === undefined || read.nextOffset <= offset) break;
      offset = read.nextOffset;
    }
    return chunks.join('');
  }

  private patchStatus(
    task: BackgroundTask,
    status: BackgroundTaskStatus,
    patch: Omit<BackgroundTaskPatch, 'status'>,
  ): Promise<BackgroundTask> {
    return this.store.patch(task.taskId, { ...patch, status });
  }

  private async patchStatusIfNotTerminal(
    task: BackgroundTask,
    status: BackgroundTaskStatus,
    patch: Omit<BackgroundTaskPatch, 'status'>,
  ): Promise<{ task: BackgroundTask; patched: boolean }> {
    try {
      return { task: await this.patchStatus(task, status, patch), patched: true };
    } catch (error) {
      const terminal = await this.getTerminalAfterInvalidTransition(task.taskId, error);
      if (terminal) return { task: terminal, patched: false };
      throw error;
    }
  }

  private async getTerminalAfterInvalidTransition(
    taskId: string,
    error: unknown,
  ): Promise<BackgroundTask | undefined> {
    if (!(error instanceof InvalidTaskStatusTransitionError)) return undefined;
    const current = await this.store.get(taskId);
    return current && isTerminalTaskStatus(current.status) ? current : undefined;
  }

  private async emit(
    task: BackgroundTask,
    type:
      | 'created'
      | 'started'
      | 'output_updated'
      | 'stop_requested'
      | 'status_changed'
      | 'completed',
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      try {
        await this.store.appendEvent({
          eventId: createTaskLifecycleEventId(),
          taskId: task.taskId,
          ownerSessionId: task.ownerSessionId,
          type,
          timestamp: this.nowMs(),
          payload,
        });
      } catch (error) {
        try {
          logger.warn(
            {
              event: 'background_task_lifecycle_event_persist_failed',
              taskId: task.taskId,
              ownerSessionId: task.ownerSessionId,
              lifecycleType: type,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to persist background task lifecycle event',
          );
        } catch {
          // The lifecycle state is already durable. Logging must not prevent
          // task_stop or terminal completion from progressing.
        }
      }
    } finally {
      this.taskWaiters.notify(task.taskId);
      this.taskWaiters.notify(`session:${task.ownerSessionId}`);
      if (type === 'completed' && isTerminalTaskStatus(task.status)) this.notifyTerminal(task);
    }
  }

  /**
   * `emit('completed')` is the one path every terminal writer funnels through —
   * `patch`, `performStop` and the startup reconcile all reach it — so hooking
   * here means no terminal outcome can silently skip the wake.
   */
  private notifyTerminal(task: BackgroundTask): void {
    if (!this.onTerminal) return;
    try {
      this.onTerminal({
        taskId: task.taskId,
        ownerSessionId: task.ownerSessionId,
        status: task.status,
      });
    } catch (error) {
      logger.warn(
        {
          taskId: task.taskId,
          ownerSessionId: task.ownerSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Local background task terminal wake hook failed',
      );
    }
  }
}

function isVisibleToContext(
  task: BackgroundTask | undefined,
  ctx: LocalRuntimeToolContext | undefined,
): task is BackgroundTask {
  if (!task) return false;
  return !ctx || task.ownerSessionId === ctx.sessionId;
}

function isVisibleToOwnerSession(
  task: BackgroundTask | undefined,
  ownerSessionId: string,
): task is BackgroundTask {
  return !!task && task.ownerSessionId === ownerSessionId;
}

function isToolContext(
  value: LocalRuntimeToolContext | TaskQuery,
): value is LocalRuntimeToolContext {
  return typeof (value as LocalRuntimeToolContext).sessionId === 'string';
}

function optionsAsReadOptions(
  value: string | LocalTaskOutputReadOptions | undefined,
): LocalTaskOutputReadOptions | undefined {
  return typeof value === 'string' ? undefined : value;
}
function clampTaskOutputWaitMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 0;
  return Math.min(30_000, Math.floor(value));
}
