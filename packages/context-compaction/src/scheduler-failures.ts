/**
 * Failure classification and circuit breaker of the background compaction
 * scheduler (wave 0, item 0.2 — canon 05 §2.4).
 *
 * Before this module a failed job was swallowed by an internal `catch` with a
 * log line (`scheduler.ts`): no class, no counter, no backoff, no attempt
 * deduplication — the live incident 2026-11-07 (session mvs_f3f8d0ab) fed the
 * SAME broken plan back through a fresh 20-30s summarizer call every
 * notification for ~40 minutes. The classes below are the canon §2.4 table:
 *
 * | Class              | Reaction                                             |
 * |--------------------|------------------------------------------------------|
 * | `aborted`          | quiet — the turn's abort signal; no breaker, no timer |
 * | `stale`            | the snapshot moved under the job — one immediate re-plan |
 * | `transient`        | provider/network failure — backoff 30s → 2m → 5m      |
 * | `invalid_output`   | unusable summary — +1 to the breaker                  |
 * | `ineffective`      | committed but the window is still above target — +1   |
 * | `contract_violation` | the commit contract refused the plan — breaker opens at once |
 * | `no_cut`           | the window offers the protocol nothing expressible to cut (the durable seam's honest pre-write refusal, incident 2026-11-07 mvs_70b7f22) — no breaker, one attempt per snapshot |
 *
 * The breaker counts consecutive classified failures; `threshold` in a row
 * (default 3) pauses the AUTO trigger (`notify()` stops starting jobs) until a
 * successful compaction or an explicit manual run resets it. The visible
 * status (`SchedulerFailureStatus`) is what the product surfaces to the owner.
 *
 * @module
 */

/** Failure classes of one compaction attempt (canon 05 §2.4 + the `no_cut` refusal). */
export type CompactionFailureClass =
  | 'aborted'
  | 'stale'
  | 'transient'
  | 'invalid_output'
  | 'ineffective'
  | 'contract_violation'
  | 'no_cut';

/** Transient backoff schedule (canon 05 §2.4): 30s → 2m → 5m. */
export const TRANSIENT_BACKOFF_MS: readonly [number, number, number] = [30_000, 120_000, 300_000];

/** Consecutive classified failures that open the breaker (canon §2.4: 3). */
export const DEFAULT_BREAKER_THRESHOLD = 3;

/** One classified failure with its attempt identity and timing facts. */
export interface ClassifiedCompactionFailure {
  readonly className: CompactionFailureClass;
  readonly message: string;
  /**
   * Whether the class counts toward the circuit breaker
   * (`invalid_output`/`ineffective`/`contract_violation` — the canon table's
   * breaker classes; aborted/stale/transient have their own reactions).
   */
  readonly countsTowardBreaker: boolean;
  /**
   * Whether the SAME snapshot may be re-attempted after this failure:
   * `stale` re-plans immediately (the snapshot moved), `aborted` is
   * turn-scoped and retries on the next notification, `transient` retries
   * after its backoff — every other class never re-runs the same snapshot
   * (one attempt per snapshot, canon §2.3).
   */
  readonly retrySameSnapshot: 'never' | 'immediately' | 'after-backoff';
}

/** Message marker the append-side validator uses for a stale plan refusal. */
const STALE_PLAN_MARKER = 'plan is stale';

/**
 * Error name the durable compaction seam refuses a degenerate window with
 * (`CompactionNothingToCutError`, history-event-log): an empty/zero-covered
 * cut or a covered prefix the fold's segment layout cannot express as the
 * replace event's ascending seq interval. Matched by NAME — the classifier
 * stays shape-based and never imports the runtime package.
 */
const NOTHING_TO_CUT_ERROR_NAME = 'CompactionNothingToCutError';

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Classifies one compaction failure (canon 05 §2.4). Best-effort by shape:
 * the turn's abort signal and its `AbortError` are quiet; the fail-closed
 * commit-contract refusals are `TypeError`s (the shared validator's
 * "must contain one native summary", the stale-plan refusal — which is a
 * STALE class, one immediate re-plan); everything else is a provider-side
 * transient. An `ineffective` outcome is not an error at all — the scheduler
 * detects it on the committed outcome and builds the class directly.
 */
export function classifyCompactionFailure(
  error: unknown,
  signal?: AbortSignal,
): ClassifiedCompactionFailure {
  const message = messageOf(error);
  if (signal?.aborted) {
    return { className: 'aborted', message, countsTowardBreaker: false, retrySameSnapshot: 'immediately' };
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'WriteLockWaitAbortedError') {
    return { className: 'aborted', message, countsTowardBreaker: false, retrySameSnapshot: 'immediately' };
  }
  if (message.includes(STALE_PLAN_MARKER)) {
    return { className: 'stale', message, countsTowardBreaker: false, retrySameSnapshot: 'immediately' };
  }
  if (error instanceof Error && error.name === NOTHING_TO_CUT_ERROR_NAME) {
    // A degenerate window is nothing-to-do, not a broken plan: the refusal
    // happened BEFORE any protocol event was written, so nothing was damaged.
    // It still counts toward the breaker (incident 2026-11-15/16, niwa
    // mvs_bf72c0ca): when the fold itself cannot express a cut (a
    // non-cuttable segment inside the window's seq interval), EVERY new
    // append produces a fresh attempt key, so with `never` retries the
    // scheduler re-planned and refused on every notification — a silent
    // provider-request storm with zero chance of success until the fold
    // changes shape. Counting it lets the breaker pause the auto trigger;
    // the blocking edge still compacts through an open breaker, and a real
    // fold-shape change resets the chain through a successful cut.
    return { className: 'no_cut', message, countsTowardBreaker: true, retrySameSnapshot: 'never' };
  }
  if (error instanceof TypeError) {
    // The fail-closed commit contract (the shared JSONL+durable validator)
    // refuses bad shapes with TypeError — canon: breaker opens at once,
    // never a retry of the same broken plan.
    return { className: 'contract_violation', message, countsTowardBreaker: true, retrySameSnapshot: 'never' };
  }
  return { className: 'transient', message, countsTowardBreaker: false, retrySameSnapshot: 'after-backoff' };
}

/** The `ineffective` outcome: the compaction committed but shrank nothing. */
export function ineffectiveCompactionFailure(
  tokensBefore: number,
  estimatedTokensAfter: number,
): ClassifiedCompactionFailure {
  return {
    className: 'ineffective',
    message: `compaction committed but the projected window is still above target (${estimatedTokensAfter} >= ${tokensBefore} tokens)`,
    countsTowardBreaker: true,
    retrySameSnapshot: 'never',
  };
}

/** Backoff delay after the nth consecutive transient failure (0-based). */
export function transientBackoffMs(consecutiveTransient: number): number {
  const index = Math.min(Math.max(consecutiveTransient, 0), TRANSIENT_BACKOFF_MS.length - 1);
  return TRANSIENT_BACKOFF_MS[index]!;
}

/**
 * The circuit breaker: counts consecutive breaker-class failures, opens at
 * `threshold` (contract violations open it immediately by saturating the
 * count), resets on success or an explicit manual reset. Pure state — the
 * scheduler owns the reactions.
 */
export class CompactionBreaker {
  private count = 0;

  constructor(readonly threshold: number = DEFAULT_BREAKER_THRESHOLD) {}

  get open(): boolean {
    return this.count >= this.threshold;
  }

  get consecutiveFailures(): number {
    return this.count;
  }

  /** Records one classified failure. Returns the (possibly newly) open state. */
  record(failure: ClassifiedCompactionFailure): boolean {
    if (!failure.countsTowardBreaker) return this.open;
    // A contract violation opens the breaker at once — no retries, no counting.
    this.count = failure.className === 'contract_violation' ? this.threshold : this.count + 1;
    return this.open;
  }

  /** A successful compaction (or an explicit manual run) resets the breaker. */
  reset(): void {
    this.count = 0;
  }
}
