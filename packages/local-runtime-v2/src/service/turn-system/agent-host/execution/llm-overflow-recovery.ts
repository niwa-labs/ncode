/**
 * В1 (opus-decisions-20261101) — the host half of the llm-retry overflow
 * recovery: `runWithOverflowRecovery` (`@mavis/context-compaction`, the
 * exactly-once contract) composed around the pi-loop continuation the
 * runner hands over.
 *
 * The chain per the opus: the failed attempt overflowed → ONE compaction
 * (`runBlocking` — join-or-start over the session's unified scheduler; the
 * committed checkpoint rides the canonical `compact` seam as a
 * `replaceMessages` commit) → the wire pipeline is RESEEDED with the cut
 * replacement (fact 1: the scheduler's own commit never folds into THIS
 * turn's pipeline, and the breach that triggered the recovery marked the
 * state stale) → exactly ONE retried request, which compiles the cut
 * window → the failed attempt's omission recorded ONLY when the retry fails
 * terminally (recovery-contract invariant 3: no omission for a successful
 * recovery). A non-overflow retry failure propagates at once — never a
 * second compaction, never a second retry.
 *
 * @module
 */

import {
  isContextOverflowError,
  runWithOverflowRecovery,
  type DurableEntryDraft,
} from '@mavis/context-compaction';

import type { LLMContextOverflowRecovery } from '@mavis/agent-core/pi-turn-runner';

import type { CanonicalHistoryMessage } from '../history/contracts.js';
import type { WireCompactionBarrier } from '../../compaction/context-wire.js';

/** Host-owned pieces the recovery composes; all resolved per turn. */
export interface LlmContextOverflowRecoveryDeps {
  readonly sessionId: string;
  /** The turn's abort signal — races the compaction wait (the user-stop budget). */
  readonly signal?: AbortSignal;
  /**
   * The session's level-aware compaction admission (the unified scheduler).
   * Resolved per call: a reseed replaces the pipeline, and the recovery runs
   * before it. `undefined` at call time = no seam → the compaction fails and
   * the original overflow propagates (fail-safe; the jsonl composition wires
   * no recovery at all).
   */
  readonly barrier: () => WireCompactionBarrier | undefined;
  /**
   * Folds the committed replacement into THIS turn's wire pipeline
   * (`TurnContextWire.reseed`) — the retry's `project()` compiles it.
   */
  readonly reseed: (messages: readonly CanonicalHistoryMessage[]) => void;
  /** The unified log's ids of the failed attempt's entries (omission targets). */
  readonly resolveFailedAttemptEntryIds?: (sessionId: string) => readonly string[];
  /** The durable append of the omission draft (the unified log binding). */
  readonly appendOmissionDraft?: (sessionId: string, draft: DurableEntryDraft) => Promise<void>;
}

/**
 * Builds the `llmRetry.contextOverflowRecovery` implementation for one turn:
 * `runWithOverflowRecovery` with `attempt` = the observed original verdict
 * replayed once (the request already failed — it is never re-sent), then the
 * runner's single continuation (`agent.continue()`); `compact` = the unified
 * compaction + the reseed; the omission recorded on the terminal retry
 * failure. The original verdict therefore always precedes the compaction,
 * and the continuation — the only real provider request of the episode —
 * runs on the compacted window: exactly one compaction, exactly one retry.
 */
export function createLlmContextOverflowRecovery(
  deps: LlmContextOverflowRecoveryDeps,
): LLMContextOverflowRecovery {
  // Captured AFTER the recovery compaction: the compaction rebuilt the log
  // projection, and the failed attempt's own record is its trailing entry at
  // exactly that moment (the retry has appended nothing yet). Resolving
  // later — at the terminal failure — would target the RETRY's record
  // instead; resolving earlier would see a log that has not committed the
  // failed response yet.
  let failedAttemptTargets: readonly string[] = [];
  return {
    isOverflowError: isContextOverflowError,
    recover: async (retry, failed) => {
      let originalReplayed = false;
      await runWithOverflowRecovery({
        attempt: async () => {
          if (!originalReplayed) {
            // The original request already failed (the recovery exists
            // because of that verdict): replay the verdict without a second
            // provider call, so the compaction precedes the continuation.
            originalReplayed = true;
            throw failed.error;
          }
          return retry();
        },
        isOverflowError: isContextOverflowError,
        compact: async () => {
          const checkpoint = await runRecoveryCompaction(deps);
          failedAttemptTargets =
            deps.resolveFailedAttemptEntryIds?.(deps.sessionId) ?? failedAttemptTargets;
          deps.reseed(dropTrailingFailedAttempt(checkpoint.replacement));
        },
        ...(deps.appendOmissionDraft !== undefined && deps.resolveFailedAttemptEntryIds !== undefined
          ? {
              failedAttemptEntryIds: () => failedAttemptTargets,
              appendEntry: (draft) => deps.appendOmissionDraft!(deps.sessionId, draft),
            }
          : {}),
      });
    },
  };
}

/**
 * The ONE recovery compaction: joins an in-flight job or starts a fresh pass
 * over the current log; the committed checkpoint is resolved through the
 * seam (session-scoped — the reseed replaces the pipeline object, so the
 * stale one must never serve the replacement). A `null` outcome (nothing to
 * compact) or a failed wait throws: the retry must not re-send an oversized
 * request, and the original overflow propagates to the run outcome.
 */
async function runRecoveryCompaction(
  deps: LlmContextOverflowRecoveryDeps,
): Promise<NonNullable<Awaited<ReturnType<WireCompactionBarrier['runBlocking']>>>> {
  const barrier = deps.barrier();
  if (barrier === undefined) {
    throw new Error(
      'context overflow recovery: the unified compaction seam is unavailable for this session',
    );
  }
  const checkpoint = await barrier.runBlocking(deps.signal);
  if (checkpoint === null || checkpoint.replacement.length === 0) {
    throw new Error('context overflow recovery: the compaction committed no checkpoint');
  }
  return checkpoint;
}

/**
 * Drops the failed attempt's own record from the reseeded window: the cut
 * replacement still ends with the failed assistant response (the most recent
 * canonical message), and the retried request must not re-send it — the
 * runner rejects it out of the transcript, and if the recovery fails
 * terminally the omission hides it in the log. Everything before it — the
 * summary, the kept tail — rides verbatim.
 */
function dropTrailingFailedAttempt(
  replacement: readonly CanonicalHistoryMessage[],
): readonly CanonicalHistoryMessage[] {
  const last = replacement[replacement.length - 1];
  if (last === undefined || Reflect.get(last, 'role') !== 'assistant') return replacement;
  return replacement.slice(0, -1);
}
