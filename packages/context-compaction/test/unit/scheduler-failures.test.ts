/**
 * Wave-0 item 0.2 (canon 05 §2.4): the scheduler's failure classes, circuit
 * breaker, transient backoff and one-attempt-per-snapshot deduplication.
 *
 * The live incident 2026-11-07 (session mvs_f3f8d0ab): a contract-violating
 * plan was re-summarized every notification for ~40 minutes — the pre-0.2
 * scheduler swallowed the failure and let the trigger re-fire. These tests
 * pin the opposite behavior: the class is recorded and visible, the same
 * snapshot is never re-attempted, and the breaker pauses the auto trigger.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyCompactionFailure,
  createBackgroundCompactionScheduler,
  ineffectiveCompactionFailure,
  transientBackoffMs,
  CompactionBreaker,
} from '../../src/index.js';
import type {
  BackgroundCompactionScheduler,
  LogEntry,
  Summarizer,
} from '../../src/index.js';
import { MemoryLog, messageEntry, userMessage, assistantMessage, filler } from './helpers.js';

/** Window of ~`tokens` tokens anchored by a usage record (past every trigger). */
function windowAtTokens(tokens: number): LogEntry[] {
  return [
    messageEntry(userMessage('question')),
    messageEntry(assistantMessage(filler(tokens * 4), { totalTokens: tokens })),
  ];
}

interface FixtureOptions {
  readonly now?: () => number;
  readonly summarizerKey?: () => string | undefined;
  readonly summarizer?: Summarizer;
  /** When set, the FIRST append throws this error (once) and never appends. */
  readonly failFirstAppendWith?: () => unknown;
}

function createFixture(entries: LogEntry[], options: FixtureOptions = {}): {
  readonly log: MemoryLog;
  readonly scheduler: BackgroundCompactionScheduler;
  readonly appended: { count: number };
} {
  const log = new MemoryLog();
  log.entries.push(...entries);
  const appended = { count: 0 };
  let failedOnce = false;
  const scheduler = createBackgroundCompactionScheduler({
    budgets: { tokenBudget: 100_000 },
    session: {
      entries: log.entries,
      append: async (drafts) => {
        if (options.failFirstAppendWith !== undefined && !failedOnce) {
          failedOnce = true;
          throw options.failFirstAppendWith();
        }
        await log.append(drafts);
        appended.count += 1;
      },
    },
    summarizer: options.summarizer ?? (async () => 'SUMMARY'),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.summarizerKey === undefined ? {} : { summarizerKey: options.summarizerKey }),
  });
  return { log, scheduler, appended };
}

describe('failure classification (canon 05 §2.4)', () => {
  it('classifies an abort signal as aborted — quiet, retry allowed, no breaker', () => {
    const controller = new AbortController();
    controller.abort();
    const failure = classifyCompactionFailure(new Error('request aborted'), controller.signal);
    expect(failure.className).toBe('aborted');
    expect(failure.countsTowardBreaker).toBe(false);
    expect(failure.retrySameSnapshot).toBe('immediately');
  });

  it('classifies AbortError as aborted', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(classifyCompactionFailure(error).className).toBe('aborted');
  });

  it('classifies the stale-plan refusal as stale — one immediate re-plan', () => {
    const failure = classifyCompactionFailure(
      new TypeError('unified compaction plan is stale: the covered history moved'),
    );
    expect(failure.className).toBe('stale');
    expect(failure.countsTowardBreaker).toBe(false);
    expect(failure.retrySameSnapshot).toBe('immediately');
  });

  it('classifies a TypeError from the commit contract as contract_violation — breaker class, never retried', () => {
    const failure = classifyCompactionFailure(
      new TypeError('Canonical checkpoint compaction must contain one native summary.'),
    );
    expect(failure.className).toBe('contract_violation');
    expect(failure.countsTowardBreaker).toBe(true);
    expect(failure.retrySameSnapshot).toBe('never');
  });

  it('classifies provider failures as transient — backoff, no breaker', () => {
    const failure = classifyCompactionFailure(new Error('fetch failed: ECONNRESET'));
    expect(failure.className).toBe('transient');
    expect(failure.countsTowardBreaker).toBe(false);
    expect(failure.retrySameSnapshot).toBe('after-backoff');
  });

  it('builds the ineffective class for a committed no-op cut', () => {
    const failure = ineffectiveCompactionFailure(90_000, 90_000);
    expect(failure.className).toBe('ineffective');
    expect(failure.countsTowardBreaker).toBe(true);
  });

  it('classifies the durable seam nothing-to-cut refusal as no_cut — breaker-counted, never retried (incidents 2026-11-07 mvs_70b7f22 and 2026-11-16 mvs_bf72c0ca)', () => {
    // The durable compaction seam refuses a degenerate window (an empty cut,
    // or a covered prefix the fold's segment layout cannot express as the
    // replace event's ascending seq interval) with a named Error — matched by
    // name, not by importing the runtime package. It counts toward the
    // breaker: the 2026-11-16 niwa session proved that with `never` retries
    // and no breaker count, every owner append produced a fresh attempt key
    // and the scheduler re-planned and refused forever — a silent
    // no-chance-of-success storm.
    const error = new Error(
      'Canonical compaction plan cannot cover 2 envelopes as a contiguous seq range; there is nothing this round can cut on this window.',
    );
    error.name = 'CompactionNothingToCutError';
    const failure = classifyCompactionFailure(error);
    expect(failure.className).toBe('no_cut');
    expect(failure.countsTowardBreaker).toBe(true);
    expect(failure.retrySameSnapshot).toBe('never');
    // A plain Error with the same message is NOT the refusal: it stays a
    // provider-side transient.
    expect(classifyCompactionFailure(new Error(error.message)).className).toBe('transient');
  });
});

describe('circuit breaker', () => {
  it('opens at 3 consecutive breaker-class failures', () => {
    const breaker = new CompactionBreaker(3);
    const invalid = ineffectiveCompactionFailure(1, 1);
    expect(breaker.record(invalid)).toBe(false);
    expect(breaker.record(invalid)).toBe(false);
    expect(breaker.open).toBe(false);
    expect(breaker.record(invalid)).toBe(true);
    expect(breaker.open).toBe(true);
  });

  it('a contract violation opens the breaker immediately (no counting)', () => {
    const breaker = new CompactionBreaker(3);
    const violation = classifyCompactionFailure(new TypeError('bad shape'));
    expect(breaker.record(violation)).toBe(true);
    expect(breaker.consecutiveFailures).toBe(3);
  });

  it('aborted/stale/transient never advance the breaker', () => {
    const breaker = new CompactionBreaker(3);
    for (const className of ['aborted', 'stale', 'transient'] as const) {
      breaker.record({ className, message: 'x', countsTowardBreaker: false, retrySameSnapshot: 'immediately' });
    }
    expect(breaker.open).toBe(false);
    expect(breaker.consecutiveFailures).toBe(0);
  });

  it('a success resets the count', () => {
    const breaker = new CompactionBreaker(3);
    breaker.record(ineffectiveCompactionFailure(1, 1));
    breaker.record(ineffectiveCompactionFailure(1, 1));
    breaker.reset();
    expect(breaker.open).toBe(false);
    expect(breaker.consecutiveFailures).toBe(0);
  });

  it('transient backoff escalates 30s, 2m, 5m and holds', () => {
    expect(transientBackoffMs(0)).toBe(30_000);
    expect(transientBackoffMs(1)).toBe(120_000);
    expect(transientBackoffMs(2)).toBe(300_000);
    expect(transientBackoffMs(10)).toBe(300_000);
  });
});

describe('scheduler failure handling (acceptance: contract_violation → 1 attempt, breaker open, status visible)', () => {
  it('a contract-violating append opens the breaker after ONE attempt and the status carries the class', async () => {
    const { scheduler, appended } = createFixture(windowAtTokens(60_000), {
      failFirstAppendWith: () => new TypeError('Canonical checkpoint compaction must contain one native summary.'),
    });

    const notification = scheduler.notify();
    expect(notification.level).toBe('background');
    expect(notification.started).toBe(true);
    await expect(notification.job).rejects.toThrow(TypeError);
    // The failure is classified and visible on the status surface:
    const status = scheduler.failureStatus();
    expect(status.breakerOpen).toBe(true);
    expect(status.lastFailure?.className).toBe('contract_violation');
    expect(status.lastFailure?.message).toContain('one native summary');
    expect(appended.count).toBe(0); // fail-closed: nothing durably appended

    // The crossed trigger does NOT re-fire the job: one attempt per snapshot,
    // and the breaker pauses the auto trigger.
    const second = scheduler.notify();
    expect(second.started).toBe(false);
    expect(second.job).toBeNull();
    expect(second.skippedReason).toBe('breaker-open');
  });

  it('the same failed snapshot is never re-attempted even with the breaker reset', async () => {
    const { log, scheduler } = createFixture(windowAtTokens(80_000), {
      failFirstAppendWith: () => new TypeError('bad plan shape'),
    });
    const first = scheduler.notify();
    await expect(first.job).rejects.toThrow(TypeError);
    expect(scheduler.failureStatus().breakerOpen).toBe(true);

    scheduler.resetBreaker(); // e.g. a manual run reset the breaker
    const second = scheduler.notify();
    expect(second.started).toBe(false);
    expect(second.skippedReason).toBe('attempt-deduplicated');

    // New log entries are a NEW snapshot: the trigger fires again.
    log.entries.push(messageEntry(userMessage('fresh owner input')));
    const third = scheduler.notify();
    expect(third.started).toBe(true);
  });

  it('a single nothing-to-cut refusal counts toward the breaker, deduplicates the snapshot, and a new snapshot retries', async () => {
    // The live incident 2026-11-07 (mvs_70b7f22): the second compaction on an
    // already-compacted window must be an honest refusal — never a
    // contract_violation that opens the breaker over "nothing to do".
    const nothingToCut = (): unknown => {
      const error = new Error(
        'Canonical compaction plan cannot cover 2 envelopes as a contiguous seq range; there is nothing this round can cut on this window.',
      );
      error.name = 'CompactionNothingToCutError';
      return error;
    };
    const { log, scheduler, appended } = createFixture(windowAtTokens(80_000), {
      failFirstAppendWith: nothingToCut,
    });

    const first = scheduler.notify();
    await expect(first.job).rejects.toThrow(Object);
    const status = scheduler.failureStatus();
    expect(status.breakerOpen).toBe(false); // one refusal of three: counted, not yet open
    expect(status.lastFailure?.className).toBe('no_cut');
    expect(appended.count).toBe(0); // fail-closed: nothing durably appended

    // The same snapshot is not re-run (the window did not move — a re-plan
    // would burn a fresh summarizer call on the same refusal)...
    const second = scheduler.notify();
    expect(second.started).toBe(false);
    expect(second.skippedReason).toBe('attempt-deduplicated');
    expect(scheduler.failureStatus().breakerOpen).toBe(false);

    // ...but a NEW snapshot (fresh owner input) gets a fresh attempt — and
    // with the failure gone the compaction commits and resets the state.
    log.entries.push(messageEntry(userMessage('fresh owner input')));
    const third = scheduler.notify();
    expect(third.started).toBe(true);
    await third.job;
    expect(appended.count).toBe(1);
    expect(scheduler.failureStatus().breakerOpen).toBe(false);
  });

  it('a transient failure backs off on the same snapshot and retries when the backoff elapses', async () => {
    let clock = 1_000_000;
    const log = new MemoryLog();
    log.entries.push(...windowAtTokens(80_000));
    let calls = 0;
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 100_000 },
      session: {
        entries: log.entries,
        append: async (drafts) => {
          await log.append(drafts);
        },
      },
      summarizer: async () => {
        calls += 1;
        throw new Error('provider 503');
      },
      now: () => clock,
      summarizerKey: () => 'test/model',
    });

    const first = scheduler.notify();
    await expect(first.job).rejects.toThrow('provider 503');
    const status = scheduler.failureStatus();
    expect(status.breakerOpen).toBe(false); // transient never opens the breaker
    expect(status.lastFailure?.className).toBe('transient');
    expect(status.lastFailure?.nextRetryAtMs).toBe(clock + 30_000);
    expect(calls).toBe(1);

    // Inside the backoff window: no new attempt.
    clock += 10_000;
    const second = scheduler.notify();
    expect(second.started).toBe(false);
    expect(second.skippedReason).toBe('transient-backoff');

    // After the backoff: the same snapshot retries (30s → 2m escalation next).
    clock += 30_001;
    const third = scheduler.notify();
    expect(third.started).toBe(true);
    await expect(third.job).rejects.toThrow('provider 503');
    expect(scheduler.failureStatus().lastFailure?.nextRetryAtMs).toBe(clock + 120_000);
    expect(calls).toBe(2);
  });

  it('a successful compaction resets the breaker and the failure status', async () => {
    // A window the cut CAN shrink: two 30k-token assistant messages with a
    // usage anchor at 80k — the kept tail stays inside keepRecentTokens.
    const shrinkable: LogEntry[] = [
      messageEntry(userMessage('first question')),
      messageEntry(assistantMessage(filler(120_000))),
      messageEntry(userMessage('second question')),
      messageEntry(assistantMessage(filler(120_000), { totalTokens: 80_000 })),
    ];
    const { log, scheduler } = createFixture(shrinkable, {
      failFirstAppendWith: () => new TypeError('bad plan shape'),
    });
    const first = scheduler.notify();
    await expect(first.job).rejects.toThrow(TypeError);
    expect(scheduler.failureStatus().breakerOpen).toBe(true);

    // With the breaker open the auto trigger stays paused; the reset path is
    // the explicit run (manual /compact or the 90% blocking await).
    log.entries.push(messageEntry(userMessage('owner keeps typing')));
    const suppressed = scheduler.notify();
    expect(suppressed.started).toBe(false);
    expect(suppressed.skippedReason).toBe('breaker-open');

    const outcome = await scheduler.runBlocking();
    expect(outcome).not.toBeNull();
    const status = scheduler.failureStatus();
    expect(status.breakerOpen).toBe(false);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastFailure).toBeUndefined();
  });

  it('the summarizer identity is part of the attempt key (a changed key retries a transient failure at once)', async () => {
    let clock = 1_000_000;
    let modelKey = 'model/a';
    const log = new MemoryLog();
    log.entries.push(...windowAtTokens(80_000));
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 100_000 },
      session: {
        entries: log.entries,
        append: async (drafts) => {
          await log.append(drafts);
        },
      },
      summarizer: async () => {
        throw new Error('provider 503');
      },
      now: () => clock,
      summarizerKey: () => modelKey,
    });

    const first = scheduler.notify();
    await expect(first.job).rejects.toThrow('provider 503');
    expect(scheduler.failureStatus().lastFailure?.attemptKey).toContain('model/a');

    // Inside the transient backoff the SAME key waits...
    const deferredSameKey = scheduler.notify();
    expect(deferredSameKey.started).toBe(false);
    expect(deferredSameKey.skippedReason).toBe('transient-backoff');

    // ...but a DIFFERENT summarizer identity is a different attempt key: it
    // retries immediately, without waiting out the backoff clock.
    modelKey = 'model/b';
    const second = scheduler.notify();
    expect(second.started).toBe(true);
    await expect(second.job).rejects.toThrow('provider 503');
    expect(scheduler.failureStatus().lastFailure?.attemptKey).toContain('model/b');
  });

  it('a below-threshold notification stays silent about skips', async () => {
    // Owner canon: the background default is the 50% knob.
    const { scheduler } = createFixture(windowAtTokens(40_000));
    const below = scheduler.notify();
    expect(below.level).toBe('none');
    expect(below.skippedReason).toBeUndefined();
  });
});
