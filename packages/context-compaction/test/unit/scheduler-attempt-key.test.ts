/**
 * Wave 3 (canon 05 §2.3, item 3.1): the canonical attempt key and the
 * staleness rule.
 *
 * The attempt key is `(baseGeneration, cut, model, promptHash)` — the binding
 * that serves the wave-1 event log reports the fold generation and the
 * covered cut through `attemptSnapshot`; the summarizer identity (model +
 * prompt) is the second half. The append carries the attempt identity back to
 * the binding: when the generation or the identity moved between the snapshot
 * and the commit (a foreign replace, a model switch), the binding REFUSES —
 * the result of the stale snapshot is discarded (the wave-1 replace events
 * make the discard honest — nothing was written) and the `stale` class
 * re-plans exactly once, immediately.
 */

import { describe, expect, it } from 'vitest';

import { createBackgroundCompactionScheduler } from '../../src/index.js';
import type { SchedulerAppendAttempt } from '../../src/index.js';
import { MemoryLog, RecordingSummarizer, assistantMessage, filler, messageEntry, userMessage } from './helpers.js';

/** A window of ~`tokens` tokens anchored by a usage record. */
function windowAtTokens(tokens: number): ReturnType<typeof messageEntry>[] {
  return [
    messageEntry(userMessage('question')),
    messageEntry(assistantMessage(filler(tokens * 4), { totalTokens: tokens })),
  ];
}

interface SnapshotFixtureOptions {
  readonly failAppendWith?: () => unknown;
  /** Default: a succeeding summarizer returning 'SUMMARY'. */
  readonly summarizer?: (prompt: string) => Promise<string>;
}

interface SnapshotFixture {
  readonly log: MemoryLog;
  readonly scheduler: ReturnType<typeof createBackgroundCompactionScheduler>;
  readonly appended: { count: number; attempts: (SchedulerAppendAttempt | undefined)[] };
  generation: number;
  identity: string;
  lastAttemptKey(): string;
}

function createSnapshotFixture(
  entries: ReturnType<typeof messageEntry>[],
  options: SnapshotFixtureOptions = {},
): SnapshotFixture {
  const log = new MemoryLog();
  log.entries.push(...entries);
  let failedOnce = false;
  const fixture: SnapshotFixture = {
    log,
    generation: 5,
    identity: 'provider/model-a',
    appended: { count: 0, attempts: [] },
    scheduler: undefined as never,
    lastAttemptKey: () => fixture.scheduler.failureStatus().lastFailure?.attemptKey ?? '',
  };
  fixture.scheduler = createBackgroundCompactionScheduler({
    budgets: { tokenBudget: 100_000 },
    summarizer: options.summarizer ?? (async () => 'SUMMARY'),
    session: {
      entries: log.entries,
      append: async (drafts, attempt) => {
        fixture.appended.attempts.push(attempt);
        // The binding's staleness check (the production binding's rule).
        if (attempt !== undefined && (attempt.generation !== fixture.generation || attempt.identity !== fixture.identity)) {
          throw new TypeError(
            `unified compaction plan is stale: the attempt was built on generation ${attempt.generation} under ${attempt.identity}, ` +
              `the history has moved to generation ${fixture.generation} under ${fixture.identity}; the result is discarded and re-planned`,
          );
        }
        if (options.failAppendWith !== undefined && !failedOnce) {
          failedOnce = true;
          throw options.failAppendWith();
        }
        await log.append(drafts);
        fixture.generation += 1; // the own replace bumps the generation
        fixture.appended.count += 1;
      },
      attemptSnapshot: () => ({
        baseGeneration: fixture.generation,
        cut: `${log.entries.length}:${log.entries.at(-1)?.id ?? 'empty'}`,
      }),
    },
    summarizerKey: () => fixture.identity,
  });
  return fixture;
}

describe('the canonical attempt key (canon 05 §2.3)', () => {
  it('keys the attempt on (baseGeneration, cut, model, promptHash) — a foreign replace is a NEW attempt', async () => {
    const fixture = createSnapshotFixture(windowAtTokens(80_000), {
      failAppendWith: () => new Error('provider 503'),
      summarizer: async () => {
        throw new Error('provider 503');
      },
    });
    const first = fixture.scheduler.notify();
    await expect(first.job).rejects.toThrow('provider 503');
    const keyOnGen5 = fixture.lastAttemptKey();
    expect(keyOnGen5).toContain('gen5');
    expect(keyOnGen5).toContain('provider/model-a');
    // The same snapshot: the dedup holds the retry (transient backoff).
    expect(fixture.scheduler.notify().skippedReason).toBe('transient-backoff');

    // A foreign replace moves the generation: a different attempt key, the
    // retry is allowed at once (the canon's staleness rule — one re-plan).
    fixture.generation = 6;
    const second = fixture.scheduler.notify();
    expect(second.started).toBe(true);
    await expect(second.job).rejects.toThrow('provider 503');
    expect(fixture.lastAttemptKey()).toContain('gen6');
    expect(fixture.lastAttemptKey()).not.toBe(keyOnGen5);
  });

  it('a changed summarizer identity (model/prompt) is a different attempt key', async () => {
    const fixture = createSnapshotFixture(windowAtTokens(80_000), {
      failAppendWith: () => new Error('provider 503'),
      summarizer: async () => {
        throw new Error('provider 503');
      },
    });
    const first = fixture.scheduler.notify();
    await expect(first.job).rejects.toThrow('provider 503');
    expect(fixture.scheduler.notify().skippedReason).toBe('transient-backoff');

    fixture.identity = 'provider/model-b'; // the model (or prompt) changed
    const second = fixture.scheduler.notify();
    expect(second.started).toBe(true); // retried immediately under the new identity
    await expect(second.job).rejects.toThrow('provider 503');
    expect(fixture.lastAttemptKey()).toContain('provider/model-b');
  });
});

describe('the staleness rule: a moved generation or identity discards the result', () => {
  it('acceptance: a foreign replace between the snapshot and the append discards the result and re-plans once', async () => {
    // A genuinely shrinkable window: the re-plan's commit must reach the
    // goal, or its verdict would be `ineffective` (canon §2.6), not a success.
    const shrinkable: ReturnType<typeof messageEntry>[] = [
      messageEntry(userMessage('first question')),
      messageEntry(assistantMessage(filler(120_000))),
      messageEntry(userMessage('second question')),
      messageEntry(assistantMessage(filler(120_000), { totalTokens: 80_000 })),
    ];
    const fixture = createSnapshotFixture(shrinkable);
    // While the "summarization" is about to commit, a foreign replace moves
    // the generation (a repair, an adopt, another compaction).
    const notification = fixture.scheduler.notify();
    fixture.generation = 6; // the foreign replace lands mid-job
    await expect(notification.job).rejects.toThrow(/plan is stale/);
    // The stale attempt's identity rode the append (the binding compared it).
    expect(fixture.appended.attempts[0]).toMatchObject({ generation: 5, identity: 'provider/model-a' });
    // The class is stale and visible on the status surface.
    expect(fixture.scheduler.failureStatus().lastFailure?.className).toBe('stale');
    // One IMMEDIATE re-plan already fired from the failure path itself (the
    // canon's rule). Await it, then pin the durable outcome: exactly ONE
    // checkpoint — the stale result contributed nothing.
    await fixture.scheduler.whenIdle();
    expect(fixture.appended.count).toBe(1);
    expect(fixture.log.entries.filter((entry) => entry.kind === 'mcode.compaction')).toHaveLength(1);
    // The re-plan's append carried the NEW snapshot's identity.
    expect(fixture.appended.attempts[1]).toMatchObject({ generation: 6, identity: 'provider/model-a' });
    // The settled state is a success (the re-plan reached the goal).
    expect(fixture.scheduler.failureStatus().lastFailure).toBeUndefined();
  });

  it('an unchanged generation commits: the own replace bumps the generation after the append', async () => {
    // A genuinely shrinkable window (two turns; the kept tail stays inside
    // keepRecentTokens): a cut that cannot shrink would be the `ineffective`
    // verdict, not a commit (canon §2.6).
    const shrinkable: ReturnType<typeof messageEntry>[] = [
      messageEntry(userMessage('first question')),
      messageEntry(assistantMessage(filler(120_000))),
      messageEntry(userMessage('second question')),
      messageEntry(assistantMessage(filler(120_000), { totalTokens: 80_000 })),
    ];
    const fixture = createSnapshotFixture(shrinkable);
    const notification = fixture.scheduler.notify();
    const outcome = await notification.job;
    expect(outcome).not.toBeNull();
    expect(fixture.appended.count).toBe(1);
    expect(fixture.generation).toBe(6); // the own replace event
    expect(fixture.scheduler.failureStatus().lastFailure).toBeUndefined();
  });
});
