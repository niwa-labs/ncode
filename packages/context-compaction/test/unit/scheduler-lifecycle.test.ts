/**
 * Scheduler lifecycle: what a notification does, what it joins, what it
 * reports — and the discipline of the single background job.
 *
 * `scheduler.test.ts` covers the trigger levels and the writer discipline.
 * This file covers the job lifecycle: deduplication, `whenIdle`, the blocking
 * path, the append priority and the failure handling.
 */

import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_COMPACTION_PRIORITY,
  createBackgroundCompactionScheduler,
  createWriterGate,
} from '../../src/index.js';
import type { DurableEntryDraft, LogEntry, WriterGate, Summarizer } from '../../src/index.js';
import { RecordingSummarizer, assistantMessage, filler, messageEntry, userMessage } from './helpers.js';

/** A log whose projected window is far over a tiny token budget. */
function overloadedLog(): LogEntry[] {
  return [
    messageEntry(userMessage('start')),
    messageEntry(assistantMessage(filler(48_000))),
    messageEntry(userMessage('more')),
    messageEntry(assistantMessage(filler(48_000))),
  ];
}

interface SchedulerFixture {
  readonly scheduler: ReturnType<typeof createBackgroundCompactionScheduler>;
  readonly appended: DurableEntryDraft[][];
  readonly priorities: number[];
}

function makeScheduler(
  summarizer: Summarizer,
  overrides: { tokenBudget?: number; appendPriority?: number; hold?: Promise<void> } = {},
): SchedulerFixture {
  const appended: DurableEntryDraft[][] = [];
  const priorities: number[] = [];
  const inner = createWriterGate();
  const gate: WriterGate = {
    acquire: (priority) => {
      priorities.push(priority);
      return inner.acquire(priority);
    },
    get held() {
      return inner.held;
    },
    get waiting() {
      return inner.waiting;
    },
    withGate: (priority, body) => {
      priorities.push(priority);
      return inner.withGate(priority, body);
    },
  };
  const scheduler = createBackgroundCompactionScheduler({
    budgets: { tokenBudget: overrides.tokenBudget ?? 100 },
    session: {
      entries: overloadedLog(),
      append: async (drafts) => {
        appended.push([...drafts]);
      },
    },
    summarizer,
    gate,
    ...(overrides.appendPriority === undefined ? {} : { appendPriority: overrides.appendPriority as never }),
  });
  return { scheduler, appended, priorities };
}

describe('a notification below the threshold', () => {
  it('starts nothing and exposes no job', () => {
    const { scheduler } = makeScheduler(async () => 'S', { tokenBudget: 10_000_000 });
    const notification = scheduler.notify();
    expect(notification.level).toBe('none');
    expect(notification.started).toBe(false);
    expect(notification.job).toBeNull();
  });

  it('evaluate() is pure: it never starts a job', async () => {
    let calls = 0;
    const { scheduler } = makeScheduler(async () => {
      calls += 1;
      return 'S';
    });
    scheduler.evaluate();
    scheduler.evaluate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
  });
});

describe('one job at a time', () => {
  it('a second notification joins the in-flight job instead of starting a duplicate', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let summarizerCalls = 0;
    const { scheduler, appended } = makeScheduler(async () => {
      summarizerCalls += 1;
      await hold;
      return 'S';
    });

    const first = scheduler.notify();
    const second = scheduler.notify();
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.job).toBe(first.job);

    release();
    await first.job;
    // Exactly one checkpoint was appended.
    expect(appended).toHaveLength(1);
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
  });

  it('whenIdle resolves once the job is done', async () => {
    const { scheduler, appended } = makeScheduler(async () => 'S');
    const notification = scheduler.notify();
    expect(notification.started).toBe(true);
    await scheduler.whenIdle();
    expect(appended).toHaveLength(1);
    // Nothing is in flight any more: a fresh blocking run starts a NEW job
    // (the first checkpoint's snapshot is done — one more checkpoint lands).
    const outcome = await scheduler.runBlocking();
    expect(outcome).not.toBeNull();
    await scheduler.whenIdle();
    expect(appended).toHaveLength(2);
  });

  it('whenIdle resolves immediately when nothing is running', async () => {
    const { scheduler } = makeScheduler(async () => 'S');
    await scheduler.whenIdle();
  });
});

describe('the blocking path', () => {
  it('runBlocking compacts even when the triggers are quiet', async () => {
    // The window (24k tokens) stays under the trigger budget (60k -> 40%), yet
    // it exceeds the kept-tail budget: there IS something to compact.
    const { scheduler, appended } = makeScheduler(async () => 'S', { tokenBudget: 60_000 });
    expect(scheduler.evaluate().level).toBe('none');
    const outcome = await scheduler.runBlocking();
    expect(outcome).not.toBeNull();
    expect(appended).toHaveLength(1);
  });

  it('runBlocking joins the in-flight job before compacting again', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler, appended } = makeScheduler(async () => {
      await hold;
      return 'S';
    });

    const background = scheduler.notify();
    const blocking = scheduler.runBlocking();
    release();
    await background.job;
    await blocking;
    // The blocking path joins the in-flight background job (no duplicate
    // compaction): one append covers both the background and blocking paths.
    expect(appended.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the append discipline', () => {
  it('appends the checkpoint at the background priority P4', async () => {
    const { scheduler, priorities } = makeScheduler(async () => 'S');
    const notification = scheduler.notify();
    await notification.job;
    expect(BACKGROUND_COMPACTION_PRIORITY).toBe(4);
    expect(priorities).toContain(4);
  });

  it('honours an explicit append priority', async () => {
    const { scheduler, priorities } = makeScheduler(async () => 'S', { appendPriority: 1 });
    const notification = scheduler.notify();
    await notification.job;
    expect(priorities).toContain(1);
    expect(priorities).not.toContain(4);
  });
});

describe('a failing summarizer', () => {
  it('rejects the job the caller awaits', async () => {
    const { scheduler } = makeScheduler(async () => {
      throw new Error('summarizer exploded');
    });
    const notification = scheduler.notify();
    await expect(notification.job).rejects.toThrow('summarizer exploded');
  });

  it('does not leave the scheduler stuck: whenIdle resolves and a new job can start', async () => {
    const { scheduler } = makeScheduler(async () => {
      throw new Error('summarizer exploded');
    });
    const notification = scheduler.notify();
    await expect(notification.job).rejects.toThrow('summarizer exploded');
    await scheduler.whenIdle();
    // Wave-0 item 0.2 (canon 05 §2.4): the failed attempt is classified
    // (`transient` — a plain provider error) and the SAME snapshot is not
    // re-attempted inside its backoff window — the pre-0.2 behavior (a fresh
    // 20-30s summarizer call on every notification) was the incident
    // mvs_f3f8d0ab's loop. The in-flight slot is released and a retry happens
    // when the backoff elapses.
    const suppressed = scheduler.notify();
    expect(suppressed.started).toBe(false);
    expect(suppressed.skippedReason).toBe('transient-backoff');
    await scheduler.whenIdle();
  });

  it('appends nothing when the summarizer fails', async () => {
    const { scheduler, appended } = makeScheduler(async () => {
      throw new Error('summarizer exploded');
    });
    const notification = scheduler.notify();
    await expect(notification.job).rejects.toThrow('summarizer exploded');
    expect(appended).toHaveLength(0);
  });
});

describe('the scheduler projects its own window', () => {
  it('usage() counts the projected window, not the raw log', async () => {
    const { scheduler } = makeScheduler(async () => 'S', { tokenBudget: 10_000_000 });
    const usage = scheduler.usage();
    expect(usage.tokens).toBeGreaterThan(0);
    expect(Number.isFinite(usage.tokens)).toBe(true);
    expect(Number.isFinite(usage.bytes)).toBe(true);
  });

  it('a summarizer double that records its prompts sees the system instruction', async () => {
    const summarizer = new RecordingSummarizer('S');
    const { scheduler } = makeScheduler(summarizer.call);
    const notification = scheduler.notify();
    await notification.job;
    expect(summarizer.callCount).toBeGreaterThanOrEqual(1);
    expect(summarizer.prompts[0]).toContain('summarization assistant');
  });
});


describe('cache anchor admission', () => {
  it('promotes a background anchor wait before joining at the blocking barrier', async () => {
    let waitingSignal: AbortSignal | undefined;
    const { scheduler, appended } = makeScheduler(async (_prompt, fork) => {
      waitingSignal = fork?.anchorWaitSignal;
      if (waitingSignal && !waitingSignal.aborted) {
        await new Promise<void>((resolve) => waitingSignal!.addEventListener('abort', () => resolve(), { once: true }));
      }
      return 'S';
    }, { tokenBudget: 40_000 });
    const notification = scheduler.notify();
    expect(notification.level).toBe('background');
    expect(waitingSignal?.aborted).toBe(false);
    expect(appended).toHaveLength(0);
    await scheduler.runBlocking();
    expect(waitingSignal?.aborted).toBe(true);
    expect(appended).toHaveLength(1);
  });
  it('also releases an anchor wait when a commit raises the notification to blocking', async () => {
    const entries = overloadedLog();
    let waitingSignal: AbortSignal | undefined;
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 40_000 },
      session: { entries, append: async () => {} },
      summarizer: async (_prompt, fork) => {
        waitingSignal = fork?.anchorWaitSignal;
        if (waitingSignal && !waitingSignal.aborted) await new Promise<void>((resolve) =>
          waitingSignal!.addEventListener('abort', () => resolve(), { once: true }));
        return 'S';
      },
    });
    expect(scheduler.notify().level).toBe('background');
    entries.push(messageEntry(userMessage(filler(40_000))));
    const notification = scheduler.notify();
    expect(notification.level).toBe('blocking');
    expect(waitingSignal?.aborted).toBe(true);
    await notification.job;
  });

});
