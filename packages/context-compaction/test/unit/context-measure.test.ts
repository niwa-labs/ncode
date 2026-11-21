/**
 * Wave 3 (canon 05 §2.6, item 3.3): the unified measure.
 *
 * ONE measure for the triggers and the status surface: `measure()` reads the
 * SAME tracker snapshot `evaluate()` judges, with the usage-anchor facts —
 * `estimated` marks the post-compaction window before the first provider
 * answer of the new generation (canon: «после компакции — пометка "оценка"
 * до первого ответа провайдера»).
 *
 * And the `ineffective` verdict: a compaction whose committed window is still
 * above the blocking goal is a failure (the breaker class), never a silent
 * success — the tool_archive-shaped «freed bytes» lie of the incident dies
 * here.
 */

import { describe, expect, it } from 'vitest';

import { COMPACTION_ENTRY_KIND, createBackgroundCompactionScheduler } from '../../src/index.js';
import { MemoryLog, assistantMessage, filler, messageEntry, userMessage } from './helpers.js';

/** Two turns: a summarized prefix and a huge kept tail the cut cannot split. */
function windowAboveGoalAfterCut(): ReturnType<typeof messageEntry>[] {
  return [
    messageEntry(userMessage('first question')),
    messageEntry(assistantMessage(filler(120_000))),
    messageEntry(userMessage('second question')),
    messageEntry(assistantMessage(filler(368_000), { totalTokens: 95_000 })),
  ];
}

/** Two turns with a modest kept tail: a cut that reaches the goal. */
function windowReachingGoal(): ReturnType<typeof messageEntry>[] {
  return [
    messageEntry(userMessage('first question')),
    messageEntry(assistantMessage(filler(120_000))),
    messageEntry(userMessage('second question')),
    messageEntry(assistantMessage(filler(120_000), { totalTokens: 95_000 })),
  ];
}

function createFixture(entries: ReturnType<typeof messageEntry>[]) {
  const log = new MemoryLog();
  log.entries.push(...entries);
  const scheduler = createBackgroundCompactionScheduler({
    budgets: { tokenBudget: 100_000 },
    session: {
      entries: log.entries,
      append: async (drafts) => {
        await log.append(drafts);
      },
    },
    summarizer: async () => 'SUMMARY',
  });
  return { log, scheduler };
}

describe('measure() — one number for the triggers and the status surface', () => {
  it('measure().tokens is the exact usage the trigger evaluation judges', () => {
    const { scheduler } = createFixture(windowReachingGoal());
    const measure = scheduler.measure();
    const evaluation = scheduler.evaluate();
    expect(measure.tokens).toBeGreaterThan(0);
    for (const reason of evaluation.reasons) {
      if (reason.axis === 'tokens') {
        expect(reason.usage).toBe(measure.tokens);
        expect(reason.budget).toBe(measure.tokenBudget);
      }
    }
    expect(measure.backgroundThresholdRatio).toBe(0.5); // the owner knob default
    expect(measure.blockingThresholdRatio).toBe(0.75);
    expect(measure.bytes).toBeGreaterThan(0);
  });

  it('a provider usage anchor marks the measure anchored; a compaction marks it estimated', async () => {
    const entries: ReturnType<typeof messageEntry>[] = [
      messageEntry(userMessage('first question')),
      // An anchor of the CURRENT generation: the number is provider-anchored.
      messageEntry(assistantMessage(filler(4_000), { totalTokens: 1_000 })),
      messageEntry(userMessage('second question')),
      messageEntry(assistantMessage(filler(160_000), { totalTokens: 95_000 })),
    ];
    const { log, scheduler } = createFixture(entries);
    let measure = scheduler.measure();
    expect(measure.estimated).toBe(false);
    expect(measure.usageAnchorTokens).toBe(95_000);

    // A compaction: the anchor is gone — the number is the ESTIMATE until the
    // first provider answer of the new window.
    await scheduler.runBlocking();
    expect(log.entries.at(-1)!.kind).toBe(COMPACTION_ENTRY_KIND);
    measure = scheduler.measure();
    expect(measure.estimated).toBe(true);
    expect(measure.usageAnchorTokens).toBeUndefined();
    expect(measure.tokens).toBeGreaterThan(0); // summary + kept tail + system
  });

  it('appending a fresh provider answer re-anchors the measure of the new generation', async () => {
    const { log, scheduler } = createFixture(windowReachingGoal());
    await scheduler.runBlocking();
    expect(scheduler.measure().estimated).toBe(true);
    // The next provider turn commits its usage into the window.
    log.entries.push(
      messageEntry(userMessage('continue')),
      messageEntry(assistantMessage('done', { totalTokens: 500 })),
    );
    const measure = scheduler.measure();
    expect(measure.estimated).toBe(false);
    expect(measure.usageAnchorTokens).toBe(500);
  });
});

describe('the ineffective verdict (canon §2.6: above the goal after the cut = failure)', () => {
  it('a committed cut that stays above the blocking goal is ineffective and counts toward the breaker', async () => {
    const { scheduler } = createFixture(windowAboveGoalAfterCut());
    const notification = scheduler.notify();
    expect(notification.level).toBe('blocking');
    const outcome = await notification.job;
    expect(outcome).not.toBeNull(); // the checkpoint IS durable and harmless
    const status = scheduler.failureStatus();
    expect(status.lastFailure?.className).toBe('ineffective');
    expect(status.lastFailure?.message).toContain('still above target');
    expect(status.breakerOpen).toBe(false); // one ineffective: the breaker counts, not opens
  });

  it('a committed cut that reaches the goal is a success and resets the failure state', async () => {
    const { scheduler } = createFixture(windowReachingGoal());
    const outcome = await scheduler.runBlocking();
    expect(outcome).not.toBeNull();
    expect(outcome!.estimatedTokensAfter).toBeLessThan(90_000);
    expect(scheduler.failureStatus().lastFailure).toBeUndefined();
    expect(scheduler.failureStatus().breakerOpen).toBe(false);
  });
});
