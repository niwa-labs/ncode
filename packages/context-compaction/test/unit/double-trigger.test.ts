/**
 * The double trigger: the token axis and the byte axis fire INDEPENDENTLY.
 *
 * `trigger.test.ts` proves the single-axis crossings. This file pins the
 * combinations: both axes over at once, an axis without a budget, a missing
 * byte measurement, and the configurable ratios.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKGROUND_THRESHOLD_RATIO,
  DEFAULT_BLOCKING_THRESHOLD_RATIO,
  evaluateTriggers,
} from '../../src/index.js';

const budgets = { tokenBudget: 100_000, byteBudget: 1_000_000 };

describe('both axes at once', () => {
  it('reports both reasons and takes the higher level', () => {
    const evaluation = evaluateTriggers({ tokens: 95_000, bytes: 950_000 }, budgets);
    expect(evaluation.level).toBe('blocking');
    expect(evaluation.reasons).toHaveLength(2);
    expect(evaluation.reasons.map((reason) => reason.axis).sort()).toEqual(['bytes', 'tokens']);
    // Each reason carries its own axis measurement.
    for (const reason of evaluation.reasons) {
      expect(reason.threshold).toBe(DEFAULT_BLOCKING_THRESHOLD_RATIO);
      expect(reason.ratio).toBeGreaterThanOrEqual(DEFAULT_BLOCKING_THRESHOLD_RATIO);
    }
  });

  it('reports both reasons at the background level too', () => {
    const evaluation = evaluateTriggers({ tokens: 80_000, bytes: 800_000 }, budgets);
    expect(evaluation.level).toBe('background');
    expect(evaluation.reasons).toHaveLength(2);
    expect(evaluation.reasons.every((reason) => reason.threshold === DEFAULT_BACKGROUND_THRESHOLD_RATIO)).toBe(true);
  });

  it('one axis over the blocking ratio wins over the other axis over the background ratio', () => {
    const evaluation = evaluateTriggers({ tokens: 95_000, bytes: 800_000 }, budgets);
    // The level is the MAXIMUM of the axes: the blocking token axis wins.
    expect(evaluation.level).toBe('blocking');
    // Both axes crossed the background threshold, so both are reported — with
    // the threshold that each of them actually crossed.
    expect(evaluation.reasons.map((reason) => reason.axis)).toEqual(['tokens', 'bytes']);
    expect(evaluation.reasons[0]).toMatchObject({ axis: 'tokens', threshold: 0.9 });
    expect(evaluation.reasons[1]).toMatchObject({ axis: 'bytes', threshold: 0.75 });
  });

  it('names the axis that fired with its usage and budget', () => {
    const evaluation = evaluateTriggers({ tokens: 75_000, bytes: 0 }, budgets);
    expect(evaluation.reasons[0]).toMatchObject({
      axis: 'tokens',
      usage: 75_000,
      budget: 100_000,
      threshold: 0.75,
    });
  });
});

describe('an axis without a budget', () => {
  it('ignores the token axis when no token budget is configured', () => {
    const evaluation = evaluateTriggers({ tokens: 999_999, bytes: 0 }, { byteBudget: 1_000_000 });
    expect(evaluation.level).toBe('none');
    expect(evaluation.reasons).toEqual([]);
  });

  it('ignores the byte axis when no byte budget is configured', () => {
    const evaluation = evaluateTriggers({ tokens: 0, bytes: 999_999_999 }, { tokenBudget: 100_000 });
    expect(evaluation.level).toBe('none');
    expect(evaluation.reasons).toEqual([]);
  });

  it('ignores a budget of zero', () => {
    // A zero budget is "not configured", not "always over budget": a zero
    // budget must not fire the trigger on every notification.
    const evaluation = evaluateTriggers({ tokens: 1, bytes: 1 }, { tokenBudget: 0, byteBudget: 0 });
    expect(evaluation.level).toBe('none');
    expect(evaluation.reasons).toEqual([]);
  });

  it('treats a missing byte measurement as zero', () => {
    const evaluation = evaluateTriggers({ tokens: 10 }, { tokenBudget: 100_000, byteBudget: 1_000_000 });
    expect(evaluation.level).toBe('none');
    expect(evaluation.reasons).toEqual([]);
  });
});

describe('configurable ratios', () => {
  it('honours a custom background and blocking ratio', () => {
    const evaluation = evaluateTriggers(
      { tokens: 60 },
      { tokenBudget: 100, backgroundThresholdRatio: 0.5, blockingThresholdRatio: 0.6 },
    );
    expect(evaluation.level).toBe('blocking');
    expect(evaluation.reasons[0]).toMatchObject({ axis: 'tokens', threshold: 0.6 });
  });

  it('rejects a background ratio above the blocking ratio', () => {
    expect(() =>
      evaluateTriggers(
        { tokens: 1 },
        { tokenBudget: 10, backgroundThresholdRatio: 0.95, blockingThresholdRatio: 0.9 },
      ),
    ).toThrow(RangeError);
  });

  it('rejects a negative blocking ratio', () => {
    expect(() =>
      evaluateTriggers(
        { tokens: 1 },
        { tokenBudget: 10, backgroundThresholdRatio: 0.1, blockingThresholdRatio: -0.5 },
      ),
    ).toThrow(RangeError);
  });

  it('accepts equal ratios', () => {
    const evaluation = evaluateTriggers(
      { tokens: 50 },
      { tokenBudget: 100, backgroundThresholdRatio: 0.5, blockingThresholdRatio: 0.5 },
    );
    expect(evaluation.level).toBe('blocking');
  });
});

describe('the default ratios are the documented ones', () => {
  it('fires at exactly 75% and at exactly 90%', () => {
    expect(DEFAULT_BACKGROUND_THRESHOLD_RATIO).toBe(0.75);
    expect(DEFAULT_BLOCKING_THRESHOLD_RATIO).toBe(0.9);
    expect(evaluateTriggers({ tokens: 75_000 }, { tokenBudget: 100_000 }).level).toBe('background');
    expect(evaluateTriggers({ tokens: 89_999 }, { tokenBudget: 100_000 }).level).toBe('background');
    expect(evaluateTriggers({ tokens: 90_000 }, { tokenBudget: 100_000 }).level).toBe('blocking');
  });

  it('stays below the background ratio one token earlier', () => {
    expect(evaluateTriggers({ tokens: 74_999 }, { tokenBudget: 100_000 }).level).toBe('none');
  });
});
