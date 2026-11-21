/**
 * Wave 3 (canon 05 §2.3/§2.7): the explicit threshold knobs of the double
 * trigger — the codex background scheme.
 *
 * - The BACKGROUND threshold (default **50%**) starts the summarization job in
 *   the background, without any writer held, while the owner keeps working.
 *   Starting EARLY is the point of the scheme: by the time the blocking level
 *   is reached there is almost always an already-running job to join, so the
 *   ordinary turn never waits on a fresh summarization.
 * - The BLOCKING threshold (default **75%**, never above `window − reserve`)
 *   is the before-LLM admission edge: the turn waits only for the ALREADY
 *   RUNNING job (join), never for a new one started on top of it.
 *
 * Both knobs are integer percentages of the context window, read from the
 * environment exactly like the other context knobs
 * (such as `MCODE_RESIDENT_IMAGE_BUDGET_TOKENS`): unset → owner default, an
 * explicit value must be an integer in 1..99 — anything else fails closed
 * with a clear error instead of silently disabling an axis.
 *
 * @module
 */

import { DEFAULT_BACKGROUND_THRESHOLD_RATIO, DEFAULT_BLOCKING_THRESHOLD_RATIO } from './estimate.js';

/** Owner default of the background trigger: 50% of the window (canon §2.7). */
export const DEFAULT_BACKGROUND_THRESHOLD_PERCENT = 50;

/** Owner default of the blocking trigger: 75% of the window (owner decision 2026-11-11). */
export const DEFAULT_BLOCKING_THRESHOLD_PERCENT = 75;

/** Env knob: the background (non-blocking) trigger, percent of the window. */
export const COMPACTION_BG_THRESHOLD_ENV = 'MCODE_COMPACTION_BG_THRESHOLD';

/** Env knob: the blocking trigger, percent of the window. */
export const COMPACTION_BLOCKING_THRESHOLD_ENV = 'MCODE_COMPACTION_BLOCKING_THRESHOLD';

/**
 * Resolves the background threshold ratio (canon 05 §2.7: default 50%).
 * Unset follows the owner default; an explicit value must be an integer
 * percentage in 1..99. Invalid values fail closed, like every context knob.
 */
export function resolveCompactionBackgroundThresholdRatio(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return resolveThresholdRatio(COMPACTION_BG_THRESHOLD_ENV, DEFAULT_BACKGROUND_THRESHOLD_PERCENT, env);
}

/**
 * Resolves the blocking threshold ratio (owner decision 2026-11-11: default 75%). The
 * `window − reserve` ceiling is applied at budget composition
 * (`resolveCompactionBudgets`), where the window is known — the knob itself
 * only bounds the percentage shape.
 */
export function resolveCompactionBlockingThresholdRatio(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return resolveThresholdRatio(COMPACTION_BLOCKING_THRESHOLD_ENV, DEFAULT_BLOCKING_THRESHOLD_PERCENT, env);
}

function resolveThresholdRatio(
  envName: string,
  defaultPercent: number,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[envName]?.trim();
  if (raw === undefined || raw === '') return defaultPercent / 100;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 99) {
    throw new Error(
      `Unsupported ${envName} value '${raw}' (an integer percentage in 1..99 is expected)`,
    );
  }
  return value / 100;
}

export { DEFAULT_BACKGROUND_THRESHOLD_RATIO, DEFAULT_BLOCKING_THRESHOLD_RATIO };
