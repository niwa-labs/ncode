/**
 * Wave 3 (canon 05 §2.3/§2.7): the explicit threshold knobs of the double
 * trigger — the codex background scheme.
 *
 * The background knob (`MCODE_COMPACTION_BG_THRESHOLD`, default 50%) starts
 * the summarization EARLY so the blocking level (90%,
 * `MCODE_COMPACTION_BLOCKING_THRESHOLD`, never above `window − reserve`) is
 * only ever a join of an already-running job. The knobs are integer
 * percentages, fail closed on garbage, and clamp inside the budget
 * composition exactly like the canon's table says.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPACTION_BG_THRESHOLD_ENV,
  COMPACTION_BLOCKING_THRESHOLD_ENV,
  DEFAULT_BACKGROUND_THRESHOLD_PERCENT,
  DEFAULT_BLOCKING_THRESHOLD_PERCENT,
  evaluateTriggers,
  resolveCompactionBackgroundThresholdRatio,
  resolveCompactionBlockingThresholdRatio,
  resolveCompactionBudgets,
} from '../../src/index.js';

describe('threshold knobs (canon 05 §2.7)', () => {
  it('defaults are the owner 50% background and 75% blocking', () => {
    expect(DEFAULT_BACKGROUND_THRESHOLD_PERCENT).toBe(50);
    expect(DEFAULT_BLOCKING_THRESHOLD_PERCENT).toBe(75);
    expect(resolveCompactionBackgroundThresholdRatio({})).toBe(0.5);
    expect(resolveCompactionBlockingThresholdRatio({})).toBe(0.75);
  });

  it('parses explicit integer percentages', () => {
    expect(resolveCompactionBackgroundThresholdRatio({ [COMPACTION_BG_THRESHOLD_ENV]: '70' })).toBe(0.7);
    expect(resolveCompactionBlockingThresholdRatio({ [COMPACTION_BLOCKING_THRESHOLD_ENV]: '85' })).toBe(0.85);
  });

  it('ignores blank values and fails closed on garbage', () => {
    expect(resolveCompactionBackgroundThresholdRatio({ [COMPACTION_BG_THRESHOLD_ENV]: '  ' })).toBe(0.5);
    expect(() => resolveCompactionBackgroundThresholdRatio({ [COMPACTION_BG_THRESHOLD_ENV]: 'abc' })).toThrow(/MCODE_COMPACTION_BG_THRESHOLD/);
    expect(() => resolveCompactionBackgroundThresholdRatio({ [COMPACTION_BG_THRESHOLD_ENV]: '0' })).toThrow(/1\.\.99/);
    expect(() => resolveCompactionBackgroundThresholdRatio({ [COMPACTION_BG_THRESHOLD_ENV]: '100' })).toThrow(/1\.\.99/);
    expect(() => resolveCompactionBlockingThresholdRatio({ [COMPACTION_BLOCKING_THRESHOLD_ENV]: '6.5' })).toThrow(/MCODE_COMPACTION_BLOCKING_THRESHOLD/);
  });
});

describe('budget composition clamps (canon 05 §2.7: blocking never above window − reserve)', () => {
  it('the knobs apply verbatim when the reserve boundary is far above them', () => {
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      { contextWindowTokens: 1_000_000 },
      { backgroundThresholdRatio: 0.65, blockingThresholdRatio: 0.9 },
    );
    expect(budgets.backgroundThresholdRatio).toBe(0.65);
    expect(budgets.blockingThresholdRatio).toBe(0.9);
  });

  it('a huge reserve pushes the blocking boundary below the knob — the boundary wins', () => {
    // reserve 50% of a 200k window: the blocking boundary is 0.5, and the
    // background clamps to it (a band below the boundary cannot exist).
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 100_000, keepRecentTokens: 20_000 },
      { contextWindowTokens: 200_000 },
      { backgroundThresholdRatio: 0.65, blockingThresholdRatio: 0.9 },
    );
    expect(budgets.blockingThresholdRatio).toBeCloseTo(0.5, 12);
    expect(budgets.backgroundThresholdRatio).toBeCloseTo(0.5, 12);
  });

  it('a background knob above the blocking knob clamps to blocking', () => {
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      { contextWindowTokens: 1_000_000 },
      { backgroundThresholdRatio: 0.95, blockingThresholdRatio: 0.9 },
    );
    expect(budgets.backgroundThresholdRatio).toBe(0.9);
    expect(budgets.blockingThresholdRatio).toBe(0.9);
  });

  it('the levels fire in the canon order: none < background < blocking', () => {
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      { contextWindowTokens: 1_000_000 },
      { backgroundThresholdRatio: 0.65, blockingThresholdRatio: 0.9 },
    );
    expect(evaluateTriggers({ tokens: 640_000 }, budgets).level).toBe('none');
    expect(evaluateTriggers({ tokens: 650_000 }, budgets).level).toBe('background');
    expect(evaluateTriggers({ tokens: 900_000 }, budgets).level).toBe('blocking');
  });
});
