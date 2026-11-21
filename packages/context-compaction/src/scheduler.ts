import { createHash } from 'node:crypto';
/**
 * BackgroundCompactionScheduler — the double-trigger compaction driver
 * (wave 3, canon 05 §2.3: the codex background scheme).
 *
 * Triggers (evaluated on every `notify()`):
 * - tokens: usage-anchored estimate of the projected window (last valid
 *   provider usage + `chars/4` of the trailing messages, images at 4800
 *   characters);
 * - bytes: Σ serialized bytes of the PROJECTED WINDOW — kept entries, the
 *   winning checkpoint payload and the active system prompt. The axis is
 *   maintained INCREMENTALLY (O(delta) per appended entry, memoized per
 *   entry id) and RESETS when a checkpoint cuts the window: audit/control
 *   bookkeeping contributes nothing, and entries behind a checkpoint leave
 *   the axis instead of re-firing it forever.
 *
 * The codex scheme (canon §2.3): the BACKGROUND threshold (default 65%, the
 * `MCODE_COMPACTION_BG_THRESHOLD` knob) starts the summarization WITHOUT any
 * writer held, fire-and-forget — the turn goes on. With readyStore, the paid
 * result is persisted and held until blocking/manual admission; a new owner
 * tail does not invalidate it. Without readyStore the standalone legacy seam
 * remains eager. Only the final append of
 * the produced batch passes through the writer gate, at background priority
 * (P4), behind every urgent commit: the commit is one append batch (the
 * checkpoint plus its billing mirror), milliseconds under the gate. The
 * BLOCKING threshold (default 90%, the `MCODE_COMPACTION_BLOCKING_THRESHOLD`
 * knob, never above `window − reserve`) is the before-LLM admission edge —
 * `runBlocking()` JOINS the already-running job and starts a new one only
 * when nothing is in flight; with the breaker open it runs the deterministic
 * fallback (no provider call) instead of the summarizer that just failed
 * three times in a row.
 *
 * One attempt per snapshot (canon §2.3): the attempt key is the canonical
 * `(baseGeneration, cut, model, promptHash)`; a stale plan (the generation or
 * the summarizer identity moved between the snapshot and the append) is
 * REFUSED by the binding and re-planned exactly once — the wave-1 replace
 * events make the discard honest (nothing is written over a replaced
 * history).
 *
 * @module
 */

import { createLogger } from '@mavis/logging';

import { compact } from './compact.js';
import { createWriterGate, type WriterGate } from './gate.js';
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  evaluateTriggers,
} from './estimate.js';
import {
  resolveCompactionBackgroundThresholdRatio,
  resolveCompactionBlockingThresholdRatio,
} from './thresholds.js';
import { WindowUsageTracker } from './usage-tracker.js';
import {
  CompactionBreaker,
  classifyCompactionFailure,
  ineffectiveCompactionFailure,
  transientBackoffMs,
  type ClassifiedCompactionFailure,
  type CompactionFailureClass,
} from './scheduler-failures.js';
import { BACKGROUND_COMPACTION_PRIORITY, type ControlPlanePriority, type DurableEntryDraft, type LogEntry, type Summarizer } from './types.js';
import type {
  CompactionBudgets,
  CompactionMeasure,
  CompactionOutcome,
  CompactionLevel,
  SchedulerAppendAttempt,
  SchedulerAttemptSnapshot,
  TriggerEvaluation,
} from './types.js';
import type { DeterministicSummaryProducer } from './deterministic-summary.js';

const log = createLogger('mcode:compaction');

/** A paid summary and its immutable read dependencies; append-only tail growth is valid. */
export interface ReadyCompaction {
  readonly version: 1;
  readonly outcome: CompactionOutcome;
  readonly source: readonly { readonly id: string; readonly digest: string }[];
  readonly identity: string;
  readonly requestIds?: readonly string[];
}
export type CompactionProgressStage = 'preparing' | 'installed' | 'failed';

export interface ReadyCompactionStore {
  load(): Promise<ReadyCompaction | undefined>;
  /** Close uncommitted receipts from an earlier failed preparation. */
  beginPreparation?(): Promise<void>;
  save(candidate: ReadyCompaction): Promise<ReadyCompaction | void>;
  clear(): Promise<void>;
}
function sourceDigest(entry: LogEntry): string {
  return createHash('sha256').update(JSON.stringify([entry.kind, entry.payload])).digest('hex');
}

/** Persistence seam the scheduler drives. */
export interface SchedulerSession {
  /** Current raw log entries, oldest first (the scheduler projects itself). */
  readonly entries: readonly LogEntry[];
  /**
   * Durably append drafts. Called under the writer gate — implementations
   * must persist the batch before resolving. The second argument carries the
   * attempt identity the plan was built on (wave 3, canon §2.3 staleness):
   * a binding that serves the wave-1 event log REFUSES the append when its
   * current generation or summarizer identity has moved — the result of a
   * stale snapshot is discarded, never committed.
   */
  append: (drafts: readonly DurableEntryDraft[], attempt?: SchedulerAppendAttempt) => Promise<void>;
  /**
   * Wave 3 (item 3.1): the canonical attempt snapshot — the fold generation
   * and the covered cut of the log the job would summarize. Present when the
   * binding tracks the wave-1 generation; absent keeps the head-proxy key.
   */
  readonly attemptSnapshot?: () => SchedulerAttemptSnapshot;
}

export interface BackgroundCompactionSchedulerOptions {
  readonly budgets: CompactionBudgets;
  readonly session: SchedulerSession;
  readonly summarizer: Summarizer;
  /** Passed through to `compact`. Default {@link DEFAULT_KEEP_RECENT_TOKENS}. */
  readonly keepRecentTokens?: number;
  /** Writer gate to share with the rest of the control plane. Default: private. */
  readonly gate?: WriterGate;
  /** Priority of the checkpoint append. Default: {@link BACKGROUND_COMPACTION_PRIORITY} (P4). */
  readonly appendPriority?: ControlPlanePriority;
  /** Clock. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Identity of the summarizer binding (model + prompt), folded into the
   * attempt key (canon 05 §2.3: `(baseGeneration, cut, model, promptHash)` —
   * the model/prompt half; the snapshot half is the attempt snapshot). A
   * changed identity is a different attempt key, so a snapshot that failed
   * under one summarizer may be retried under another, and a job whose
   * identity moved before its append is refused as stale.
   */
  readonly summarizerKey?: () => string | undefined;
  /** Consecutive breaker-class failures that pause the auto trigger. Default 3. */
  readonly breakerThreshold?: number;
  /**
   * Wave 3 (item 3.2): the deterministic fallback summary producer (canon
   * §2.2: the cline `basic` shape — tool activity + last assistant texts).
   * With the breaker open, the blocking edge compacts through it instead of
   * the LLM summarizer — the projection drops below the goal with NO
   * provider call.
   */
  readonly deterministicSummary?: DeterministicSummaryProducer;
  /** The trigger-threshold env (tests inject a fixture). Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Present in durable product mode: prepare at 65%, install on blocking/manual admission. */
  readonly readyStore?: ReadyCompactionStore;
  /** Best-effort user-facing progress; never gates durable work. */
  readonly onProgress?: (stage: CompactionProgressStage) => void;
}

export interface SchedulerNotification {
  /** Trigger evaluation of the current usage. */
  readonly evaluation: TriggerEvaluation;
  /** Compaction level the triggers selected. */
  readonly level: CompactionLevel;
  /** The compaction job when one was started or is already in flight, else `null`. */
  readonly job: Promise<CompactionOutcome | null> | null;
  /** True when this notification started a NEW compaction job. */
  readonly started: boolean;
  /**
   * Why no new job was started despite a crossed trigger (`undefined` when a
   * job was started or joined, or no trigger crossed). Wave-0 item 0.2: the
   * refusal is honest and classed, never a silent swallow.
   */
  readonly skippedReason?: 'breaker-open' | 'attempt-deduplicated' | 'transient-backoff' | 'summary-ready';
}

/** Owner-visible status of the scheduler's failure state (canon 05 §2.4). */
export interface SchedulerFailureStatus {
  /** The breaker opened: the auto trigger stays paused until a reset. */
  readonly breakerOpen: boolean;
  /** Consecutive breaker-class failures recorded since the last reset. */
  readonly consecutiveFailures: number;
  /** The last classified failure, with its attempt key and retry timing. */
  readonly lastFailure?: SchedulerLastFailure;
}

/** The last classified failure of the scheduler (status surface shape). */
export interface SchedulerLastFailure {
  readonly className: CompactionFailureClass;
  readonly message: string;
  readonly atMs: number;
  readonly attemptKey: string;
  /** Scheduler-internal retry rule of the class (not part of the surface). */
  readonly retrySameSnapshot: 'never' | 'immediately' | 'after-backoff';
  /** Earliest same-snapshot retry (transient backoff), when scheduled. */
  readonly nextRetryAtMs?: number;
}

export interface BackgroundCompactionScheduler {
  readonly budgets: CompactionBudgets;
  /** The shared writer gate. */
  readonly gate: WriterGate;
  /** Current usage estimate behind the triggers. */
  usage(): { readonly tokens: number; readonly bytes: number };
  /** Current trigger evaluation (pure, no side effects). */
  evaluate(): TriggerEvaluation;
  /**
   * Wave 3 (item 3.3, canon §2.6): the unified measure — the SAME snapshot of
   * the projected window the triggers evaluate, with the usage-anchor facts
   * (`estimated` — post-compaction, before the first provider answer of the
   * new generation) and the budgets/ratios it is judged against. The status
   * surface reads this; the triggers read `evaluate()` over the same tracker;
   * the two can never disagree.
   */
  measure(): CompactionMeasure;
  /**
   * Evaluate the triggers and start the compaction job when either axis
   * crossed a threshold. At the background level the returned `job` may be
   * dropped (fire and forget); at the BLOCKING level the turn loop MUST
   * await it. A crossed trigger may still start nothing — an open breaker
   * (background level only: the blocking level runs the deterministic
   * fallback instead), an already-failed attempt on this snapshot, or a
   * transient backoff — and the notification names that in `skippedReason`.
   */
  notify(): SchedulerNotification;
  /**
   * The blocking-edge admission (canon §2.3: before-LLM joins the ALREADY
   * RUNNING job — it never starts a duplicate on top of one). With nothing in
   * flight it starts the job; an open breaker routes the job through the
   * deterministic fallback (no provider call).
   */
  runBlocking(input?: { readonly force?: boolean; readonly signal?: AbortSignal }): Promise<CompactionOutcome | null>;
  /** Resolves when no compaction job is running. */
  whenIdle(): Promise<void>;
  /**
   * Owner-visible failure state (wave-0 item 0.2): the breaker state, the
   * consecutive-failure count and the last classified failure. The product
   * surfaces this on the owner's status line.
   */
  failureStatus(): SchedulerFailureStatus;
  /** Manual reset (an explicit `/compact` run calls this on success). */
  resetBreaker(): void;
}

export function createBackgroundCompactionScheduler(
  options: BackgroundCompactionSchedulerOptions,
): BackgroundCompactionScheduler {
  const { budgets, session, summarizer } = options;
  const gate = options.gate ?? createWriterGate();
  const appendPriority = options.appendPriority ?? BACKGROUND_COMPACTION_PRIORITY;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  // The trigger counters are maintained incrementally: each call ingests only
  // the entries appended since the previous call, so notify/evaluate/usage
  // never re-read (let alone re-stringify) the whole log.
  const usageTracker = new WindowUsageTracker();
  // Wave-0 item 0.2 (canon 05 §2.4): failures are classified, counted and
  // surfaced — the incident loop (the same broken plan re-summarized every
  // notification for ~40 minutes) must be structurally impossible.
  const breaker = new CompactionBreaker(options.breakerThreshold);
  /** Last classified failure: its attempt key, class and retry timing. */
  let lastFailure: SchedulerLastFailure | undefined;
  /** Consecutive transient failures on the failed attempt key (backoff index). */
  let consecutiveTransient = 0;
  /** Bounded same-snapshot transient run before the breaker takes over. */
  const TRANSIENT_EXHAUSTED_ATTEMPTS = 3;
  /** The in-flight job promise, when one is running (joined by later notifies). */
  let ready: ReadyCompaction | undefined;
  let restoredReady = false;
  let installSignal: AbortSignal | undefined;
  let waitingForAnchor: AbortController | undefined;
  let inFlight: Promise<CompactionOutcome | null> | null = null;

  // Wave 3 (item 3.1): the resolved threshold knobs — explicit env knobs
  // (default 65%/90%, canon §2.7), applied only when the budgets carry no
  // explicit ratio of their own (tests pin exact ratios through budgets).
  const backgroundRatio =
    budgets.backgroundThresholdRatio ?? resolveCompactionBackgroundThresholdRatio(env);
  const blockingRatio =
    budgets.blockingThresholdRatio ?? resolveCompactionBlockingThresholdRatio(env);

  function usage(): { tokens: number; bytes: number } {
    usageTracker.ingest(session.entries);
    return usageTracker.usage();
  }

  /**
   * Attempt key of the CURRENT log snapshot (canon 05 §2.3: one attempt per
   * `(baseGeneration, cut, model, promptHash)`). The canonical key reads the
   * binding's attempt snapshot (the wave-1 fold generation + the covered
   * cut); the summarizer identity is the model/prompt half. Without a
   * snapshot the head proxy stands in (append-only, so `(length, lastEntryId)`
   * identifies exactly what the job would read).
   */
  function currentAttemptKey(): string {
    const snapshot = session.attemptSnapshot?.();
    const identity = options.summarizerKey?.() ?? 'default';
    if (snapshot !== undefined) {
      return `gen${snapshot.baseGeneration}|cut=${snapshot.cut}|${identity}`;
    }
    const entries = session.entries;
    const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
    return `${entries.length}:${last?.id ?? 'empty'}|${identity}`;
  }

  /** The append attempt identity of the CURRENT snapshot (staleness check). */
  function currentAppendAttempt(): SchedulerAppendAttempt | undefined {
    const snapshot = session.attemptSnapshot?.();
    if (snapshot === undefined) return undefined;
    return {
      generation: snapshot.baseGeneration,
      identity: options.summarizerKey?.() ?? 'default',
    };
  }

  function recordFailure(
    failure: ClassifiedCompactionFailure,
    attemptKey: string,
  ): void {
    // A transient refusal that keeps failing the SAME snapshot is not
    // transient in any useful sense: an unbounded after-backoff loop on a
    // deterministic provider error (a rejected compaction payload) burns a
    // request every backoff tick forever. After a bounded run of consecutive
    // same-snapshot failures the class graduates into the breaker — the auto
    // trigger pauses (the blocking edge still compacts through), and a
    // changed snapshot or a success gives the scheduler its chances back.
    const exhausted =
      failure.className === 'transient' &&
      lastFailure?.attemptKey === attemptKey &&
      consecutiveTransient + 1 >= TRANSIENT_EXHAUSTED_ATTEMPTS;
    const effective = exhausted
      ? {
          ...failure,
          countsTowardBreaker: true,
          retrySameSnapshot: 'never' as const,
          message: `${failure.message} (persistent after ${String(consecutiveTransient + 1)} consecutive attempts on this snapshot)`,
        }
      : failure;
    failure = effective;
    const opened = breaker.record(failure);
    consecutiveTransient =
      failure.className === 'transient' && lastFailure?.attemptKey === attemptKey
        ? consecutiveTransient + 1
        : failure.className === 'transient'
          ? 1
          : 0;
    const atMs = now();
    lastFailure = {
      className: failure.className,
      message: failure.message,
      atMs,
      attemptKey,
      retrySameSnapshot: failure.retrySameSnapshot,
      ...(failure.retrySameSnapshot === 'after-backoff'
        ? { nextRetryAtMs: atMs + transientBackoffMs(consecutiveTransient - 1) }
        : {}),
    };
    // The owner-visible surface (canon §2.4: the class goes to the surface,
    // never masked): a structured warn with the class, the attempt key and
    // the breaker state.
    log.warn('compaction job failed', {
      event: 'context_compaction_job_failed',
      class: failure.className,
      attempt_key: attemptKey,
      breaker_open: opened,
      consecutive_failures: breaker.consecutiveFailures,
      retry_same_snapshot: failure.retrySameSnapshot,
      ...(lastFailure.nextRetryAtMs !== undefined
        ? { next_retry_at_ms: lastFailure.nextRetryAtMs }
        : {}),
      err: failure.message,
    });
  }

  function progress(stage: CompactionProgressStage): void {
    try { options.onProgress?.(stage); } catch { /* Observation cannot change compaction. */ }
  }

  async function runCompaction(runOptions?: {
    readonly deterministic?: boolean;
    readonly force?: boolean;
    readonly background?: boolean;
    readonly anchorWaitSignal?: AbortSignal;
    readonly signal?: AbortSignal;
  }): Promise<CompactionOutcome | null> {
    // Phase 1 — summarize WITHOUT the writer: the whole summarizer call runs
    // while urgent commits keep flowing through the gate. The deterministic
    // fallback (breaker open) makes no provider call at all.
    if (options.readyStore && !restoredReady) {
      ready = await options.readyStore.load();
      restoredReady = true;
    }
    const identity = options.summarizerKey?.() ?? 'default';
    if (ready && (ready.version !== 1 || ready.identity !== identity || ready.source.some((source, index) => {
      const current = session.entries[index];
      return !current || current.id !== source.id || sourceDigest(current) !== source.digest;
    }))) {
      log.info('discarding stale ready compaction', { entryId: ready.outcome.entryId });
      await options.readyStore?.clear();
      ready = undefined;
    }
    const attempt = currentAppendAttempt();
    let outcome: CompactionOutcome | null;
    if (ready) {
      if (runOptions?.background && !runOptions.anchorWaitSignal?.aborted) return null;
      outcome = ready.outcome;
      log.info('adopting ready compaction', { entryId: outcome.entryId });
    } else {
      if (options.readyStore?.beginPreparation) await options.readyStore.beginPreparation();
      const entries = [...session.entries];
      const source = options.readyStore ? entries.map((entry) => ({ id: entry.id, digest: sourceDigest(entry) })) : [];
      let preparationNotified = false;
      const preparing = () => {
        if (!preparationNotified) { preparationNotified = true; progress('preparing'); }
      };
      outcome = await compact({
        entries,
        summarizer: (prompt, fork) => {
          preparing();
          return summarizer(prompt, fork && runOptions?.anchorWaitSignal
            ? { ...fork, anchorWaitSignal: runOptions.anchorWaitSignal } : fork);
        },
        ...(runOptions?.force ? { force: true } : {}),
        ...(options.deterministicSummary !== undefined
          ? { deterministicSummary: runOptions?.deterministic === true ? (...args: Parameters<DeterministicSummaryProducer>) => { preparing(); return options.deterministicSummary!(...args); } : undefined }
          : {}),
        keepRecentTokens: options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
        tokenBudget: budgets.tokenBudget,
        now,
      });
      if (outcome === null) return null;
      if (options.readyStore && runOptions?.background && !runOptions.anchorWaitSignal?.aborted) {
        const candidate: ReadyCompaction = { version: 1, outcome, source, identity };
        ready = (await options.readyStore.save(candidate)) ?? candidate;
        log.info('compaction ready; installation deferred until admission', { entryId: outcome.entryId });
        return null;
      }
    }
    // Phase 2 — the append is the only writer-held section, at background
    // priority: every queued urgent commit (P0–P3) is granted first. The
    // batch carries the checkpoint AND, when the summarizer reported spend,
    // the `mcode.usage` billing mirror of that spend (same gate, same batch:
    // the usage record can never survive without its checkpoint or vice
    // versa — one atomic writer-held unit, pi's "Tools/summaries" shape (d)
    // in our declared writer mapping). The deterministic fallback bills
    // nothing and carries no usage draft.
    const appendStartedAtMs = Date.now();
    const drafts =
      outcome.usageDraft === undefined ? [outcome.draft] : [outcome.draft, outcome.usageDraft];
    // The attempt identity rides the append (canon §2.3 staleness): a binding
    // serving the wave-1 event log refuses when the generation or the
    // summarizer identity moved mid-job — the stale result is discarded and
    // the class re-plans once immediately.
    await gate.withGate(appendPriority, () => {
      if ((runOptions?.signal ?? installSignal)?.aborted) throw new DOMException('Compaction install cancelled', 'AbortError');
      return session.append(drafts, ready?.requestIds ? { ...(attempt ?? { generation: 0, identity }), requestIds: ready.requestIds } : attempt);
    });
    progress('installed');
    if (ready) {
      // Commit already happened. A failed cache cleanup must not turn it into
      // a failed install; replay rejects this candidate against the new prefix.
      ready = undefined;
      try { await options.readyStore?.clear(); }
      catch { log.warn('installed compaction retained a disposable ready artifact'); }
    }
    log.debug('checkpoint appended', {
      entryId: outcome.entryId,
      priority: appendPriority,
      usageEntry: outcome.usageDraft?.id,
      deterministic: outcome.deterministic === true,
      durationMs: Date.now() - appendStartedAtMs,
    });
    return outcome;
  }

  function startJob(runOptions?: {
    readonly deterministic?: boolean;
    readonly force?: boolean;
    readonly background?: boolean;
    readonly anchorWaitSignal?: AbortSignal;
    readonly signal?: AbortSignal;
  }): Promise<CompactionOutcome | null> {
    if (inFlight !== null) return inFlight;
    const attemptKey = currentAttemptKey();
    const anchorWait = runOptions?.background ? new AbortController() : undefined;
    waitingForAnchor = anchorWait;
    const job: Promise<CompactionOutcome | null> = runCompaction({
      ...runOptions, ...(anchorWait ? { anchorWaitSignal: anchorWait.signal } : {}),
    });
    void job.finally(() => {
      if (waitingForAnchor === anchorWait) waitingForAnchor = undefined;
    }).catch(() => undefined);
    // Classify EXACTLY once, on the shared promise, whether or not anyone
    // awaits it: a success (that actually shrank the window) resets the
    // failure state; a committed no-op cut is `ineffective`; a rejection is
    // classified by shape (canon §2.4). Attaching this observer is also what
    // keeps a dropped background job from ever surfacing as an unhandled
    // rejection — callers that await `job` still observe the raw outcome —
    // and it releases `inFlight` before any caller continuation runs (the
    // observer was registered first).
    job.then(
      (outcome) => {
        inFlight = null;
        installSignal = undefined;
        if (outcome === null) return;
        const shrankNothing =
          outcome.tokensBefore > 0 && outcome.estimatedTokensAfter >= outcome.tokensBefore;
        const stillAboveGoal = isAboveBlockingGoal(outcome);
        if (shrankNothing) {
          // A committed cut that shrank nothing is NOT a success (canon §2.6
          // preview): it counts toward the breaker as `ineffective` while the
          // checkpoint itself stays (already durable, harmless).
          recordFailure(
            ineffectiveCompactionFailure(outcome.tokensBefore, outcome.estimatedTokensAfter),
            attemptKey,
          );
          return;
        }
        if (stillAboveGoal) {
          // Wave 3 (item 3.3, canon §2.6): a compaction whose committed window
          // is STILL above the blocking goal did not reach the target — an
          // `ineffective` outcome, never a silent success (the
          // tool_archive-shaped "freed bytes" lie of the incident).
          recordFailure(
            ineffectiveCompactionFailure(outcome.tokensBefore, outcome.estimatedTokensAfter),
            attemptKey,
          );
          return;
        }
        // Success resets the failure state (canon §2.4: reset on success) —
        // the failed snapshot itself is gone behind the new log head, so the
        // dedup record is stale with it.
        breaker.reset();
        consecutiveTransient = 0;
        lastFailure = undefined;
      },
      (error: unknown) => {
        inFlight = null;
        installSignal = undefined;
        progress('failed');
        recordFailure(classifyCompactionFailure(error), attemptKey);
        // Wave 3 (item 3.1, canon §2.3): a STALE plan (the snapshot moved —
        // generation or summarizer identity) re-plans EXACTLY once, right
        // now: the wave-1 replace events make the discard honest, and the
        // next notification would otherwise wait for the next commit. The
        // re-plan re-evaluates the triggers — after a foreign replacement the
        // window usually shrank and nothing re-fires.
        if (lastFailure?.className === 'stale') {
          try {
            notify();
          } catch (replanError) {
            log.debug('stale re-plan notification failed', {
              err: replanError instanceof Error ? replanError.message : String(replanError),
            });
          }
        }
      },
    );
    inFlight = job;
    return job;
  }

  /**
   * Wave 3 (item 3.3): whether the committed cut reached the blocking goal —
   * the canonical `ineffective` verdict (canon §2.6: "компакция, после
   * которой проекция выше цели, — исход ineffective"). Judged on the
   * outcome's OWN post-commit estimate (the planned window: summary + kept
   * tail + frozen system), which is the projection the commit produces —
   * independent of whether this scheduler's tracker has ingested the
   * checkpoint yet. Only the token axis judges: the byte axis is the wire
   * guard's territory, and its checkpoint resets the axis by construction.
   */
  function isAboveBlockingGoal(outcome: CompactionOutcome): boolean {
    if (!Number.isFinite(budgets.tokenBudget) || budgets.tokenBudget <= 0) return false;
    const blockingTarget = blockingRatio * budgets.tokenBudget;
    return outcome.tokensBefore >= blockingTarget && outcome.estimatedTokensAfter >= blockingTarget;
  }

  function evaluate(): TriggerEvaluation {
    return evaluateTriggers(usage(), {
      ...budgets,
      backgroundThresholdRatio: backgroundRatio,
      blockingThresholdRatio: blockingRatio,
    });
  }

  function measure(): CompactionMeasure {
    const current = usage();
    const anchor = usageTracker.anchorState();
    return {
      tokens: current.tokens,
      bytes: current.bytes,
      estimated: !anchor.valid,
      ...(anchor.valid ? { usageAnchorTokens: anchor.tokens } : {}),
      tokenBudget: budgets.tokenBudget,
      ...(budgets.byteBudget !== undefined ? { byteBudget: budgets.byteBudget } : {}),
      backgroundThresholdRatio: backgroundRatio,
      blockingThresholdRatio: blockingRatio,
    };
  }

  function notify(): SchedulerNotification {
    const evaluation = evaluate();
    if (evaluation.level === 'none') {
      return { evaluation, level: evaluation.level, job: inFlight, started: false };
    }
    if (evaluation.level === 'blocking') waitingForAnchor?.abort();
    if (inFlight !== null) {
      return { evaluation, level: evaluation.level, job: inFlight, started: false };
    }
    // Wave 3 (item 3.2, canon §2.4): the breaker pauses the AUTO-LLM trigger.
    // At the BLOCKING edge the deterministic fallback still runs — the owner's
    // turn must not drown while the LLM summarizer is paused. At the
    // background level the crossing is honestly skipped and named.
    if (ready && evaluation.level === 'background') {
      return { evaluation, level: evaluation.level, job: null, started: false, skippedReason: 'summary-ready' };
    }
    if (breaker.open) {
      if (evaluation.level === 'blocking' && options.deterministicSummary !== undefined) {
        log.info('blocking compaction triggered (deterministic fallback; breaker open)', {
          event: 'context_compaction_blocking_fallback',
          tokens: usage().tokens,
        });
        return {
          evaluation,
          level: evaluation.level,
          job: startJob({ deterministic: true }),
          started: true,
        };
      }
      log.debug('compaction trigger suppressed: breaker open', {
        event: 'context_compaction_breaker_open',
        consecutive_failures: breaker.consecutiveFailures,
      });
      return {
        evaluation,
        level: evaluation.level,
        job: null,
        started: false,
        skippedReason: 'breaker-open',
      };
    }
    // One attempt per snapshot (canon §2.3): a failed attempt's key blocks a
    // re-run of the same snapshot per its class's retry rule.
    const attemptKey = currentAttemptKey();
    if (lastFailure !== undefined && lastFailure.attemptKey === attemptKey) {
      if (lastFailure.retrySameSnapshot === 'never') {
        return {
          evaluation,
          level: evaluation.level,
          job: null,
          started: false,
          skippedReason: 'attempt-deduplicated',
        };
      }
      const nextRetryAtMs = lastFailure.nextRetryAtMs;
      if (
        lastFailure.retrySameSnapshot === 'after-backoff' &&
        nextRetryAtMs !== undefined &&
        now() < nextRetryAtMs
      ) {
        return {
          evaluation,
          level: evaluation.level,
          job: null,
          started: false,
          skippedReason: 'transient-backoff',
        };
      }
    }
    const job = startJob({ background: evaluation.level === 'background' });
    const { tokens, bytes } = usage();
    log.info('compaction triggered', {
      level: evaluation.level,
      tokens,
      bytes,
      reasons: evaluation.reasons.length,
    });
    return { evaluation, level: evaluation.level, job, started: true };
  }

  async function runBlocking(input?: { readonly force?: boolean; readonly signal?: AbortSignal }): Promise<CompactionOutcome | null> {
    if (input?.signal?.aborted) throw new DOMException('Compaction admission cancelled', 'AbortError');
    installSignal = input?.signal;
    waitingForAnchor?.abort();
    // Join an in-flight background job first — a duplicate checkpoint helps
    // nobody (canon §2.3: before-LLM waits for the ALREADY RUNNING task, it
    // never starts one on top of it). When that job already recorded a
    // checkpoint, it IS the blocking compaction: starting a second pass would
    // re-summarize the freshly cut window (a wasted model call on the 90%
    // path). Only a joined job that found nothing to compact (`null`) or
    // failed falls through to a fresh pass over the current log.
    if (inFlight !== null) {
      const joined = await inFlight.catch(() => null);
      if (joined !== null) {
        log.debug('blocking compaction joined background job', {
          entryId: joined.entryId,
        });
        return joined;
      }
    }
    // Wave 3 (item 3.2): with the breaker open the fresh pass is the
    // deterministic fallback — the projection drops below the goal with no
    // provider call (canon §2.4), and its success resets the breaker.
    if (breaker.open && options.deterministicSummary !== undefined) {
      log.info('blocking compaction runs the deterministic fallback (breaker open)', {
        event: 'context_compaction_blocking_fallback',
      });
      return startJob({ ...input, deterministic: true });
    }
    return startJob(input);
  }

  async function whenIdle(): Promise<void> {
    while (inFlight !== null) {
      await inFlight.catch(() => undefined);
    }
  }

  function failureStatus(): SchedulerFailureStatus {
    return {
      breakerOpen: breaker.open,
      consecutiveFailures: breaker.consecutiveFailures,
      ...(lastFailure === undefined ? {} : { lastFailure }),
    };
  }

  function resetBreaker(): void {
    // The breaker state resets; the one-attempt-per-snapshot dedup does NOT —
    // a failed attempt's key keeps blocking an AUTO re-run of the same
    // snapshot (the explicit `runBlocking` path stays available regardless).
    breaker.reset();
    consecutiveTransient = 0;
  }

  return {
    budgets,
    gate,
    usage,
    evaluate,
    measure,
    notify,
    runBlocking,
    whenIdle,
    failureStatus,
    resetBreaker,
  };
}
