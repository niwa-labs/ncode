import { randomUUID } from 'node:crypto';

import { Cron } from 'croner';
import { eq, sql } from 'drizzle-orm';

import type { CronJobBridge } from '@mavis/durable-orchestration';
import { createLogger } from '@mavis/logging';

import type { AppDb } from '../../../infra/db/client.js';
import {
  schedulerJobs,
  type SchedulerJobSchedule,
  type SchedulerJobState,
} from '../../../infra/db/schema/scheduler.js';
import type {
  ScheduledJob,
  SchedulerClient,
  ScheduledHandler,
} from '../../../infra/scheduler/index.js';

const log = createLogger('mcode:cron');

/**
 * W10 Part A — the atomic scheduler swap (state/w08.md closure №1, owner
 * W10): the product cron WAKE lives on the ONE durable scheduler through the
 * {@link CronJobBridge} (every job's due time is ONE pi sleeping task); the
 * croner timer wheel of `infra/scheduler` is NOT constructed in this mode
 * (`runtime.ts` composes this client instead) and the v1 host cron is
 * already disabled under the v2 runtime (`cronConsumerEnabled: false`).
 * Three schedulers never live.
 *
 * The product RECORD keeps its `scheduler_jobs` rows (same schema, same
 * migrations — the existing cron definitions/run history stay readable), but
 * no timer is ever armed here: `schedule`/`reschedule` upsert the row and
 * call `bridge.ensure` (a digest change retires the old wake task and
 * schedules a new one ON the pi scheduler); `cancel`/`remove` retire it.
 * Fires arrive from the bridge's `fire` host intent → the registered
 * handler, exactly the {@link ScheduledHandler} contract of the croner
 * scheduler.
 *
 * croner appears ONLY as a pure date calculator (`nextRunAtMs` of a cron
 * expression): no timer instance is retained, nothing is armed, no
 * callback is scheduled by it.
 *
 * @module
 */

interface DurableSchedulerMetrics {
  counter(name: string, delta?: number, labels?: Record<string, string>): void;
}

export interface DurableSchedulerClientOptions {
  readonly db: AppDb;
  readonly bridge: CronJobBridge;
  readonly metrics?: DurableSchedulerMetrics;
  readonly nowMs?: () => number;
}

/** Row projection mirroring `infra/scheduler`'s storage format. */
interface JobRow {
  schedulerId: string;
  handlerKey: string;
  schedule: SchedulerJobSchedule;
  scheduleGeneration: number;
  runCount: number;
  state: SchedulerJobState;
  nextRunAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Config digest of a job: any change to schedule (or handler binding) re-arms the wake task. */
function jobDigest(row: Pick<JobRow, 'handlerKey' | 'schedule' | 'scheduleGeneration'>): string {
  return JSON.stringify({
    handlerKey: row.handlerKey,
    schedule: row.schedule,
    scheduleGeneration: row.scheduleGeneration,
  });
}

/**
 * The {@link SchedulerClient} over the ONE durable scheduler. Constructor-
 * shaped like {@link SchedulerClient}: register handlers first, then
 * schedule.
 */
export class DurableSchedulerClient implements SchedulerClient {
  readonly #db: AppDb;
  readonly #bridge: CronJobBridge;
  readonly #metrics: DurableSchedulerMetrics | undefined;
  readonly #nowMs: () => number;
  readonly #handlers = new Map<string, ScheduledHandler>();

  constructor(options: DurableSchedulerClientOptions) {
    this.#db = options.db;
    this.#bridge = options.bridge;
    this.#metrics = options.metrics;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  registerHandler(handlerKey: string, handler: ScheduledHandler): void {
    if (handlerKey.trim() === '') throw new Error('scheduler handler key must not be empty');
    if (this.#handlers.has(handlerKey)) {
      throw new Error(`scheduler handler already registered: ${handlerKey}`);
    }
    this.#handlers.set(handlerKey, handler);
  }

  schedule(handlerKey: string, schedule: SchedulerJobSchedule): string {
    const handler = this.#requireHandler(handlerKey);
    const normalized = normalizeSchedule(schedule, this.#nowMs());
    const schedulerId = randomUUID();
    const now = this.#nowMs();
    const row: JobRow = {
      schedulerId,
      handlerKey,
      schedule: normalized,
      scheduleGeneration: 0,
      runCount: 0,
      state: 'active',
      nextRunAtMs: nextRunOf(normalized, now),
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.#insertRow(row);
    // The wake task is fire-and-forget: the bridge computes the durable WHEN
    // through the product's nextCronFire host intent. A failure here leaves
    // a row without a wake — surfaced, never silent.
    void this.#bridge.ensure(schedulerId, jobDigest(row)).catch((error: unknown) => {
      this.#report('bridge_ensure_failed', { schedulerId, error });
    });
    return schedulerId;
  }

  reschedule(schedulerId: string, schedule: SchedulerJobSchedule): void {
    const current = this.#readRow(schedulerId);
    if (!current) throw new Error(`scheduler job not found: ${schedulerId}`);
    this.#requireHandler(current.handlerKey);
    const normalized = normalizeSchedule(schedule, this.#nowMs());
    const next: JobRow = {
      ...current,
      schedule: normalized,
      scheduleGeneration: current.scheduleGeneration + 1,
      runCount: 0,
      state: 'active',
      nextRunAtMs: nextRunOf(normalized, this.#nowMs()),
      updatedAtMs: this.#nowMs(),
    };
    this.#updateRow(next);
    void this.#bridge.ensure(schedulerId, jobDigest(next)).catch((error: unknown) => {
      this.#report('bridge_ensure_failed', { schedulerId, error });
    });
  }

  cancel(schedulerId: string): void {
    const current = this.#readRow(schedulerId);
    if (!current || current.state === 'cancelled') return;
    this.#updateRow({
      ...current,
      state: 'cancelled',
      nextRunAtMs: null,
      updatedAtMs: this.#nowMs(),
    });
    void this.#bridge.retire(schedulerId).catch((error: unknown) => {
      this.#report('bridge_retire_failed', { schedulerId, error });
    });
  }

  get(schedulerId: string): ScheduledJob | undefined {
    const row = this.#readRow(schedulerId);
    return row ? toScheduledJob(row) : undefined;
  }

  /** Reads the durable row WITHOUT adopting it (cron queries' boundary). */
  inspect(schedulerId: string): ScheduledJob | undefined {
    const row = this.#readRow(schedulerId);
    return row ? toScheduledJob(row) : undefined;
  }

  remove(schedulerId: string): boolean {
    const result = this.#db
      .delete(schedulerJobs)
      .where(eq(schedulerJobs.schedulerId, schedulerId))
      .run();
    void this.#bridge.retire(schedulerId).catch((error: unknown) => {
      this.#report('bridge_retire_failed', { schedulerId, error });
    });
    return readChanges(result) > 0;
  }

  /**
   * The cron host policy the bridge's wake task consults: next fire of the
   * job's schedule after `nowMs` (null = terminal — retired/exhausted).
   * Registered on the orchestration hosts by {@link bindCronHost}.
   */
  nextCronFire(schedulerId: string, nowMs: number): number | null {
    const row = this.#readRow(schedulerId);
    if (!row || row.state !== 'active') return null;
    if (row.schedule.kind === 'once') {
      return row.schedule.runAtMs > nowMs ? row.schedule.runAtMs : null;
    }
    return nextRunOf(row.schedule, nowMs);
  }

  /**
   * The fire host intent: invoke the registered handler and advance the
   * row's run bookkeeping (the croner scheduler's `trigger` minus timers).
   */
  async fireCron(schedulerId: string): Promise<{ readonly note?: string }> {
    const row = this.#readRow(schedulerId);
    if (!row || row.state !== 'active') {
      return { note: 'job not active' };
    }
    const handler = this.#handlers.get(row.handlerKey);
    if (!handler) {
      this.#report('missing_handler', { schedulerId });
      return { note: `scheduler handler is not registered: ${row.handlerKey}` };
    }
    const startedAtMs = this.#nowMs();
    try {
      await handler(schedulerId);
      this.#metric('scheduler_trigger_total', 1, { handlerKey: row.handlerKey, outcome: 'success' });
    } catch (error) {
      this.#metric('scheduler_trigger_total', 1, { handlerKey: row.handlerKey, outcome: 'failure' });
      log.warn('durable cron fire handler failed', {
        schedulerId,
        handlerKey: row.handlerKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const exhausted = jobExhausted(row);
    const next: JobRow = {
      schedulerId: row.schedulerId,
      handlerKey: row.handlerKey,
      schedule: row.schedule,
      scheduleGeneration: row.scheduleGeneration,
      runCount: row.runCount + 1,
      state: exhausted ? 'completed' : row.state,
      nextRunAtMs: exhausted ? null : row.nextRunAtMs,
      createdAtMs: row.createdAtMs,
      updatedAtMs: this.#nowMs(),
    };
    this.#updateRow(next);
    // NOTE: an exhausted job is NOT retired inline — fireCron runs INSIDE the
    // wake task's fire phase, and an abortTask here would wait on the very
    // phase that is awaiting this call (circular wait). The wake task
    // retires itself naturally: the next wait phase asks nextCronFire, sees
    // the completed row, and terminates.
    log.debug('durable cron fired', {
      schedulerId,
      handlerKey: row.handlerKey,
      durationMs: this.#nowMs() - startedAtMs,
    });
    return {};
  }

  /** Binds this client's policy onto the orchestration hosts (the bridge's product side). */
  bindCronHost(hosts: {
    registerCronHost(
      fire: (cronId: string) => Promise<{ readonly note?: string }>,
      nextFire: (cronId: string, nowMs: number) => Promise<number | null> | number | null,
    ): void;
  }): void {
    hosts.registerCronHost(
      (cronId) => this.fireCron(cronId),
      (cronId, nowMs) => this.nextCronFire(cronId, nowMs),
    );
  }

  #requireHandler(handlerKey: string): ScheduledHandler {
    const handler = this.#handlers.get(handlerKey);
    if (!handler) throw new Error(`scheduler handler is not registered: ${handlerKey}`);
    return handler;
  }

  #readRow(schedulerId: string): JobRow | undefined {
    const row = this.#db
      .select({
        schedulerId: schedulerJobs.schedulerId,
        handlerKey: schedulerJobs.handlerKey,
        scheduleJsonText: sql<string>`${schedulerJobs.scheduleJson}`,
        scheduleGeneration: schedulerJobs.scheduleGeneration,
        runCount: schedulerJobs.runCount,
        state: schedulerJobs.state,
        nextRunAtMs: schedulerJobs.nextRunAtMs,
        createdAtMs: schedulerJobs.createdAtMs,
        updatedAtMs: schedulerJobs.updatedAtMs,
      })
      .from(schedulerJobs)
      .where(eq(schedulerJobs.schedulerId, schedulerId))
      .get();
    if (!row) return undefined;
    let schedule: unknown;
    try {
      schedule = JSON.parse(row.scheduleJsonText);
    } catch {
      this.#report('invalid_record', { schedulerId });
      return undefined;
    }
    try {
      const normalized = normalizeSchedule(schedule, this.#nowMs(), true);
      return {
        schedulerId: row.schedulerId,
        handlerKey: row.handlerKey,
        schedule: normalized,
        scheduleGeneration: row.scheduleGeneration,
        runCount: row.runCount,
        state: row.state,
        nextRunAtMs: Number.isSafeInteger(row.nextRunAtMs) ? (row.nextRunAtMs as number) : null,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
      };
    } catch {
      this.#report('invalid_record', { schedulerId });
      return undefined;
    }
  }

  #insertRow(row: JobRow): void {
    this.#db
      .insert(schedulerJobs)
      .values({
        schedulerId: row.schedulerId,
        handlerKey: row.handlerKey,
        scheduleJson: row.schedule,
        scheduleGeneration: row.scheduleGeneration,
        runCount: row.runCount,
        state: row.state,
        nextRunAtMs: row.nextRunAtMs ?? null,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
      })
      .run();
  }

  #updateRow(row: JobRow): void {
    this.#db
      .update(schedulerJobs)
      .set({
        scheduleJson: row.schedule,
        scheduleGeneration: row.scheduleGeneration,
        runCount: row.runCount,
        state: row.state,
        nextRunAtMs: row.nextRunAtMs ?? null,
        updatedAtMs: row.updatedAtMs,
      })
      .where(eq(schedulerJobs.schedulerId, row.schedulerId))
      .run();
  }

  #report(
    reason: string,
    info: { schedulerId: string; error?: unknown },
  ): void {
    this.#metric('scheduler_skipped_total', 1, { reason });
    log.warn('durable scheduler bridge operation failed', {
      reason,
      schedulerId: info.schedulerId,
      ...(info.error !== undefined
        ? {
            error:
              info.error instanceof Error ? info.error.message : String(info.error),
          }
        : {}),
    });
  }

  #metric(name: string, delta: number, labels?: Record<string, string>): void {
    try {
      this.#metrics?.counter(name, delta, labels);
    } catch {
      // Metrics are best-effort and must never change scheduler behavior.
    }
  }
}

function toScheduledJob(row: JobRow): ScheduledJob {
  return {
    schedulerId: row.schedulerId,
    handlerKey: row.handlerKey,
    schedule: row.schedule,
    scheduleGeneration: row.scheduleGeneration,
    runCount: row.runCount,
    state: row.state,
    ...(row.nextRunAtMs !== null ? { nextRunAtMs: row.nextRunAtMs } : {}),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function jobExhausted(row: JobRow): boolean {
  return (
    row.schedule.kind === 'once' ||
    (row.schedule.kind === 'cron' &&
      row.schedule.maxRuns !== undefined &&
      row.runCount + 1 >= row.schedule.maxRuns)
  );
}

function nextRunOf(
  schedule: SchedulerJobSchedule,
  afterMs: number,
): number | null {
  if (schedule.kind === 'once') {
    return schedule.runAtMs > afterMs ? schedule.runAtMs : null;
  }
  // Pure calculator: the next fire date of the expression — no timer armed.
  const timer = new Cron(schedule.expression, {
    ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
    paused: true,
    unref: true,
  });
  try {
    const next = timer.nextRun(new Date(afterMs));
    return next?.getTime() ?? null;
  } finally {
    timer.stop();
  }
}

function normalizeSchedule(
  schedule: unknown,
  nowMs: number,
  allowPastOnce = false,
): SchedulerJobSchedule {
  if (typeof schedule !== 'object' || schedule === null) {
    throw new Error('scheduler schedule must be an object');
  }
  const raw = schedule as Record<string, unknown>;
  if (raw.kind === 'once') {
    if (!Number.isSafeInteger(raw.runAtMs)) {
      throw new Error('once schedule runAtMs must be a Unix millisecond integer');
    }
    const runAtMs = raw.runAtMs as number;
    if (!allowPastOnce && runAtMs <= nowMs) {
      throw new Error('once schedule runAtMs must be in the future');
    }
    return { kind: 'once', runAtMs };
  }
  if (raw.kind === 'cron') {
    if (typeof raw.expression !== 'string' || raw.expression.trim() === '') {
      throw new Error('cron schedule expression must not be empty');
    }
    if (
      raw.timezone !== undefined &&
      (typeof raw.timezone !== 'string' || raw.timezone === '')
    ) {
      throw new Error('cron schedule timezone must be a non-empty string when present');
    }
    if (
      raw.maxRuns !== undefined &&
      (!Number.isSafeInteger(raw.maxRuns) || (raw.maxRuns as number) <= 0)
    ) {
      throw new Error('cron schedule maxRuns must be a positive integer when present');
    }
    return {
      kind: 'cron',
      expression: raw.expression,
      ...(raw.timezone !== undefined ? { timezone: raw.timezone as string } : {}),
      ...(raw.maxRuns !== undefined ? { maxRuns: raw.maxRuns as number } : {}),
    };
  }
  throw new Error('scheduler schedule kind must be once or cron');
}

function readChanges(result: unknown): number {
  return typeof result === 'object' && result !== null && 'changes' in result
    ? Number((result as { changes: unknown }).changes)
    : 0;
}
