/**
 * Per-model compaction settings (pin `compaction.modelOverrides`, commit
 * c4cf7957b of the v1.3.0..target diff) merged with OUR double-trigger
 * budgets.
 *
 * Resolution semantics are the pin's `settings-manager.getCompactionSettings`:
 * each token setting falls back INDEPENDENTLY — the model override's field,
 * then the ordinary setting, then the built-in default — keyed by the EXACT,
 * case-sensitive `provider/modelId` string (slashes inside the model id
 * included). Invalid values fail loudly at read time: a non-object override
 * entry, or a non-negative-safe-integer token value, throws; only OMITTED
 * fields fall back. `enabled` stays global — it is not model-specific.
 *
 * The trigger merge (plan §8 W05-D): `reserveTokens` only decides WHEN
 * compaction starts (and, through `keepRecentTokens`, how much is kept) — it
 * NEVER sizes the summary output (see `summarize.ts`: the model's output
 * limit). Our two-threshold (background/blocking) evaluation stays; the pi
 * reserve rule fixes where the BLOCKING level of the token axis sits:
 * exactly at `contextWindow - reserveTokens`.
 *
 * @module
 */

import type { CompactionBudgets } from './types.js';
import {
  resolveCompactionBackgroundThresholdRatio,
  resolveCompactionBlockingThresholdRatio,
} from './thresholds.js';

/** Built-in defaults of the pin (`DEFAULT_COMPACTION_SETTINGS`). */
export const DEFAULT_COMPACTION_ENABLED = true;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384;
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20000;

/** The per-model override shape: every field optional, each falls back independently. */
export interface CompactionModelOverride {
  readonly reserveTokens?: number;
  readonly keepRecentTokens?: number;
}

/** The `compaction` settings object as stored (all fields optional). */
export interface CompactionSettingsFile {
  readonly enabled?: boolean;
  readonly reserveTokens?: number;
  readonly keepRecentTokens?: number;
  /** Keyed by exact, case-sensitive `provider/modelId` strings. */
  readonly modelOverrides?: Readonly<Record<string, CompactionModelOverride>>;
}

/** Identity of the model the settings resolve for (`provider/modelId` key). */
export interface ModelKeyInput {
  readonly provider: string;
  readonly modelId: string;
}

/** Fully resolved compaction settings of one model (no optional fields left). */
export interface ResolvedCompactionSettings {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenSetting(
  field: 'reserveTokens' | 'keepRecentTokens',
  settings: CompactionSettingsFile,
  model: ModelKeyInput | undefined,
): number {
  const ordinary = settings[field];
  if (ordinary !== undefined && !isNonNegativeSafeInteger(ordinary)) {
    throw new Error(
      `Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
    );
  }
  const modelKey = model === undefined ? undefined : `${model.provider}/${model.modelId}`;
  const entry = modelKey !== undefined ? settings.modelOverrides?.[modelKey] : undefined;
  if (entry !== undefined && !isMergeableObject(entry)) {
    throw new Error(
      `Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
    );
  }
  const override = (entry as CompactionModelOverride | undefined)?.[field];
  if (override !== undefined && !isNonNegativeSafeInteger(override)) {
    throw new Error(
      `Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
    );
  }
  const fallback = field === 'reserveTokens' ? DEFAULT_COMPACTION_RESERVE_TOKENS : DEFAULT_COMPACTION_KEEP_RECENT_TOKENS;
  return override ?? ordinary ?? fallback;
}

/**
 * Resolve the compaction settings of one model — pin
 * `SettingsManager.getCompactionSettings`: per-field fallback
 * modelOverrides["provider/modelId"] → ordinary → default; `enabled` global.
 * Throws on any invalid value, exactly like the pin (invalid ordinary values
 * throw even when the model has a valid override).
 */
export function resolveCompactionSettings(
  settings: CompactionSettingsFile,
  model?: ModelKeyInput,
): ResolvedCompactionSettings {
  return {
    enabled: settings.enabled ?? DEFAULT_COMPACTION_ENABLED,
    reserveTokens: tokenSetting('reserveTokens', settings, model),
    keepRecentTokens: tokenSetting('keepRecentTokens', settings, model),
  };
}

/**
 * The pi trigger rule (`shouldCompact`, compaction.ts:267): compaction starts
 * when the free context drops below the reserve. `reserveTokens` ONLY decides
 * when compaction starts — never the summary output size.
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: Pick<ResolvedCompactionSettings, 'enabled' | 'reserveTokens'>,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

/** The model's window/output facts the budgets derive from. */
export interface CompactionModelWindow {
  /** Context window in tokens of the RESOLVED model (virtual models resolve first). */
  readonly contextWindowTokens: number;
  /**
   * Byte budget of the second trigger axis; `undefined`/`0` keeps the axis
   * disabled (our semantics — the byte axis is ours, not pi's).
   */
  readonly byteBudget?: number;
}

/**
 * Merge the per-model reserve rule with OUR two-threshold evaluation:
 *
 * - `tokenBudget` = the resolved model's context window (per-model budgets:
 *   a different model never reuses the previous model's budget);
 * - the BLOCKING threshold of the token axis is the resolved knob (canon 05
 *   §2.7: `MCODE_COMPACTION_BLOCKING_THRESHOLD`, default 90%) capped by the
 *   pi reserve boundary — never above `(contextWindow - reserveTokens) /
 *   contextWindow`;
 * - the background threshold is the resolved knob (canon 05 §2.7:
 *   `MCODE_COMPACTION_BG_THRESHOLD`, default 65%), clamped to stay at or
 *   below the blocking boundary (a huge reserve can push the blocking ratio
 *   below the knob — then background fires at the same point as blocking);
 * - the byte axis shares the same ratios: one measure, one trigger rule
 *   (canon §2.6).
 */
export function resolveCompactionBudgets(
  settings: ResolvedCompactionSettings,
  model: CompactionModelWindow,
  thresholds?: {
    readonly backgroundThresholdRatio?: number;
    readonly blockingThresholdRatio?: number;
  },
): CompactionBudgets {
  if (!Number.isFinite(model.contextWindowTokens) || model.contextWindowTokens <= 0) {
    throw new RangeError(`contextWindowTokens must be a positive number, got ${String(model.contextWindowTokens)}`);
  }
  const reserve = Math.min(settings.reserveTokens, model.contextWindowTokens);
  const reserveRatio = (model.contextWindowTokens - reserve) / model.contextWindowTokens;
  const blockingRatio = Math.min(
    thresholds?.blockingThresholdRatio ?? resolveCompactionBlockingThresholdRatio(),
    reserveRatio,
  );
  const backgroundRatio = Math.min(
    thresholds?.backgroundThresholdRatio ?? resolveCompactionBackgroundThresholdRatio(),
    blockingRatio,
  );
  return {
    tokenBudget: model.contextWindowTokens,
    ...(model.byteBudget !== undefined ? { byteBudget: model.byteBudget } : {}),
    backgroundThresholdRatio: backgroundRatio,
    blockingThresholdRatio: blockingRatio,
  };
}

/** Re-export for consumers computing the byte-axis defaults alongside. */
export {
  DEFAULT_BACKGROUND_THRESHOLD_RATIO,
  DEFAULT_BLOCKING_THRESHOLD_RATIO,
  resolveCompactionBackgroundThresholdRatio,
  resolveCompactionBlockingThresholdRatio,
  COMPACTION_BG_THRESHOLD_ENV,
  COMPACTION_BLOCKING_THRESHOLD_ENV,
  DEFAULT_BACKGROUND_THRESHOLD_PERCENT,
  DEFAULT_BLOCKING_THRESHOLD_PERCENT,
} from './thresholds.js';
