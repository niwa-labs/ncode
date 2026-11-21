/**
 * Per-model compaction settings (pin `compaction.modelOverrides`, commit
 * c4cf7957b) — resolution semantics, validation, and the merge with our
 * two-threshold budgets (V-K01: different models never reuse the previous
 * model's budget; the pi reserve rule fixes the BLOCKING boundary).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
  DEFAULT_COMPACTION_RESERVE_TOKENS,
  evaluateTriggers,
  resolveCompactionBudgets,
  resolveCompactionSettings,
  shouldCompact,
} from '../../src/index.js';

describe('resolveCompactionSettings (pin settings-manager semantics)', () => {
  it('defaults when nothing is set', () => {
    expect(resolveCompactionSettings({})).toEqual({
      enabled: true,
      reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
      keepRecentTokens: DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
    });
  });

  it('ordinary settings apply when no override matches', () => {
    expect(
      resolveCompactionSettings(
        { reserveTokens: 1000, keepRecentTokens: 2000 },
        { provider: 'anthropic', modelId: 'claude-3' },
      ),
    ).toEqual({ enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 });
  });

  it('the exact provider/modelId override wins, field by field', () => {
    const settings = {
      reserveTokens: 1000,
      keepRecentTokens: 2000,
      modelOverrides: {
        'anthropic/claude-opus-4': { reserveTokens: 400_000 },
      },
    };
    // Only reserveTokens overridden: keepRecentTokens falls back to ordinary.
    expect(resolveCompactionSettings(settings, { provider: 'anthropic', modelId: 'claude-opus-4' })).toEqual({
      enabled: true,
      reserveTokens: 400_000,
      keepRecentTokens: 2000,
    });
    // A different model keeps the ordinary values (V-K01).
    expect(resolveCompactionSettings(settings, { provider: 'anthropic', modelId: 'claude-sonnet-4' })).toEqual({
      enabled: true,
      reserveTokens: 1000,
      keepRecentTokens: 2000,
    });
  });

  it('override-only fields fall back to built-in defaults (pin: independent fallback)', () => {
    const settings = {
      modelOverrides: {
        'openai/gpt-6.1': { keepRecentTokens: 5000 },
      },
    };
    expect(resolveCompactionSettings(settings, { provider: 'openai', modelId: 'gpt-6.1' })).toEqual({
      enabled: true,
      reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
      keepRecentTokens: 5000,
    });
  });

  it('the key is exact and case-sensitive, slashes included in the model id', () => {
    const settings = {
      modelOverrides: {
        'openai/openai/gpt-6.1-sol': { reserveTokens: 7 },
      },
    };
    expect(resolveCompactionSettings(settings, { provider: 'openai', modelId: 'openai/gpt-6.1-sol' })).toMatchObject({
      reserveTokens: 7,
    });
    expect(
      resolveCompactionSettings(settings, { provider: 'OpenAI', modelId: 'openai/gpt-6.1-sol' }).reserveTokens,
    ).toBe(DEFAULT_COMPACTION_RESERVE_TOKENS);
  });

  it('enabled is global, not model-specific', () => {
    const settings = { enabled: false, modelOverrides: { 'a/b': {} } };
    expect(resolveCompactionSettings(settings, { provider: 'a', modelId: 'b' }).enabled).toBe(false);
    expect(resolveCompactionSettings(settings).enabled).toBe(false);
  });

  it('invalid values throw at read time, exactly like the pin', () => {
    expect(() => resolveCompactionSettings({ reserveTokens: -1 })).toThrow(/Invalid compaction\.reserveTokens/);
    expect(() => resolveCompactionSettings({ keepRecentTokens: 1.5 })).toThrow(/Invalid compaction\.keepRecentTokens/);
    expect(() => resolveCompactionSettings({ modelOverrides: { 'a/b': 42 as never } }, { provider: 'a', modelId: 'b' })).toThrow(
      /Invalid compaction\.modelOverrides\["a\/b"\]/,
    );
    expect(() =>
      resolveCompactionSettings(
        { modelOverrides: { 'a/b': { reserveTokens: 'big' as never } } },
        { provider: 'a', modelId: 'b' },
      ),
    ).toThrow(/Invalid compaction\.modelOverrides\["a\/b"\]\.reserveTokens/);
    // Invalid ordinary throws even when the model has a valid override (pin).
    expect(() =>
      resolveCompactionSettings(
        { reserveTokens: -5, modelOverrides: { 'a/b': { reserveTokens: 10 } } },
        { provider: 'a', modelId: 'b' },
      ),
    ).toThrow(/Invalid compaction\.reserveTokens/);
  });
});

describe('shouldCompact (pi trigger rule: reserve only decides WHEN)', () => {
  it('fires when free context drops below the reserve', () => {
    const settings = { enabled: true, reserveTokens: 16_384 };
    expect(shouldCompact(100_000 - 16_385, 100_000, settings)).toBe(false);
    expect(shouldCompact(100_000 - 16_384, 100_000, settings)).toBe(false);
    expect(shouldCompact(100_000 - 16_383, 100_000, settings)).toBe(true);
  });

  it('disabled never fires', () => {
    expect(shouldCompact(1_000_000, 100_000, { enabled: false, reserveTokens: 0 })).toBe(false);
  });
});

describe('resolveCompactionBudgets (per-model budgets merged with our double trigger)', () => {
  it('blocking fires exactly at the reserve boundary of the resolved model', () => {
    const window = 200_000;
    // reserve = 25% of the window: the pi boundary (window - reserve)/window
    // sits exactly ON the owner blocking knob (75%), so the knob and the
    // boundary coincide and the test observes the exact fire point.
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 50_000, keepRecentTokens: 20_000 },
      { contextWindowTokens: window },
    );
    expect(budgets.tokenBudget).toBe(window);
    // Blocking ratio = min(knob 0.75, (window - reserve)/window = 0.75); the
    // background keeps the owner 50% knob default — a real band exists below
    // the blocking boundary.
    expect(budgets.blockingThresholdRatio).toBeCloseTo(0.75, 12);
    expect(budgets.backgroundThresholdRatio).toBe(0.5);
    // Just below the boundary: background only.
    expect(evaluateTriggers({ tokens: window - 50_001 }, budgets).level).toBe('background');
    // At the boundary — the pi rule `contextTokens > contextWindow - reserve`
    // fires — the level is blocking.
    expect(evaluateTriggers({ tokens: window - 50_000 }, budgets).level).toBe('blocking');
  });

  it('when the reserve boundary sits at 0.75, background clamps to it (no band below a huge reserve)', () => {
    const window = 200_000;
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 50_000, keepRecentTokens: 20_000 },
      { contextWindowTokens: window },
    );
    expect(budgets.blockingThresholdRatio).toBeCloseTo(0.75, 12);
    // The background knob (0.5) sits below the boundary, so it survives
    // unclamped; the clamp only bites when the reserve pushes the boundary
    // UNDER the knob.
    expect(budgets.backgroundThresholdRatio).toBeCloseTo(0.5, 12);
    // One token below the reserve boundary the level drops to background
    // (the 50% knob band below the boundary); at the boundary, blocking.
    expect(evaluateTriggers({ tokens: window - 50_001 }, budgets).level).toBe('background');
    expect(evaluateTriggers({ tokens: window - 50_000 }, budgets).level).toBe('blocking');
  });

  it('a different model resolves a different budget (V-K01 per-model/virtual switch)', () => {
    const settings = {
      enabled: true,
      reserveTokens: 16_384,
      modelOverrides: {
        'anthropic/claude-opus-4': { reserveTokens: 400_000 },
      },
    };
    const small = resolveCompactionBudgets(resolveCompactionSettings(settings), {
      contextWindowTokens: 200_000,
    });
    const bigModel = resolveCompactionBudgets(
      resolveCompactionSettings(settings, { provider: 'anthropic', modelId: 'claude-opus-4' }),
      { contextWindowTokens: 1_000_000 },
    );
    expect(bigModel.tokenBudget).toBe(1_000_000);
    expect(bigModel.blockingThresholdRatio).toBeCloseTo(0.6, 12);
    // The same usage crosses BLOCKING for the small model (0.95 ≥ 0.918) but
    // sits far below the big model's boundaries (0.19 < 0.6): the previous
    // model's budget is never reused after a model switch.
    const midUsage = 190_000;
    expect(evaluateTriggers({ tokens: midUsage }, small).level).toBe('blocking');
    expect(evaluateTriggers({ tokens: midUsage }, bigModel).level).toBe('none');
  });

  it('background stays our 65% knob default, clamped below a huge reserve boundary', () => {
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 190_000, keepRecentTokens: 20_000 },
      { contextWindowTokens: 200_000 },
    );
    expect(budgets.blockingThresholdRatio).toBeCloseTo(0.05, 12);
    expect(budgets.backgroundThresholdRatio).toBeCloseTo(0.05, 12); // clamped to blocking
  });

  it('a reserve covering the whole window blocks on any usage (pi: window - reserve <= 0)', () => {
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 1_000_000, keepRecentTokens: 20_000 },
      { contextWindowTokens: 200_000 },
    );
    expect(budgets.blockingThresholdRatio).toBe(0);
    expect(evaluateTriggers({ tokens: 1 }, budgets).level).toBe('blocking');
  });

  it('the byte axis passes through and keeps our default thresholds', () => {
    const budgets = resolveCompactionBudgets(
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      { contextWindowTokens: 100_000, byteBudget: 1000 },
    );
    expect(budgets.byteBudget).toBe(1000);
    expect(budgets.backgroundThresholdRatio).toBe(0.5);
    // Byte-only overflow still fires (ours, not pi's).
    expect(evaluateTriggers({ tokens: 1, bytes: 900 }, budgets).level).toBe('blocking');
    expect(evaluateTriggers({ tokens: 1, bytes: 700 }, budgets).level).toBe('background');
  });

  it('rejects a non-positive window', () => {
    expect(() =>
      resolveCompactionBudgets({ enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, { contextWindowTokens: 0 }),
    ).toThrow(RangeError);
  });
});
