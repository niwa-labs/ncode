import { createLogger } from '@mavis/logging';

import { formatReleasedBackgroundNote } from '@mavis/agent-tools/desktop';

import type { SessionHistoryMutationCapability } from '../../../session-system/messages/history/mutation/session-history-mutation-adapter.js';
import { openToolRoundTail } from '../../../session-system/messages/history/mutation/session-turn-history-mutation.js';
import type { NativeTaskWaits } from './native-task-waits.js';

const log = createLogger('mcode:turn');

/**
 * Crash-recovery join of the reactive subagent wave (verdict 09 §1.8, wave
 * 3): binds the seam outcome of a RELEASED native task wait with the parent
 * conversation's canonical result, exactly once.
 *
 * Ruptures this closes (§5.4 №16):
 * - crash after release-prepare: the durable prepared outcome is finalized
 *   into the seam verbatim (`finalizePendingPreparedReleases` — the decision
 *   is reproduced, never re-decided, the child is never relaunched);
 * - seam finalize before the canonical result: the parent turn died with an
 *   open trailing tool round, so the round is closed with the KNOWN §2.2
 *   background note the live executor would have committed — never a second
 *   toolResult over a closed round, never an unknown substitution for a
 *   decision the seam already recorded.
 *
 * A released call whose round is no longer open (another honest closure —
 * the abort reconcile's unknown outcomes — got there first) is reported
 * `superseded` and left untouched: the model already holds an honest error
 * for that call id, and appending over it would fork the history.
 */

/** The task-row facts the join needs (from the background-task store). */
export interface ReleasedTaskRowSnapshot {
  readonly taskId: string;
  readonly ownerSessionId: string;
  /** The parent turn that owned the released tool call. */
  readonly parentTurnId: string;
  readonly toolCallId: string;
  readonly childSessionId?: string;
  /** Current row status — the §2.2 note reports the factual one. */
  readonly status: string;
}

export interface NativeWaitRecoveryReport {
  /** Prepared outcomes finalized into the seam by this join. */
  readonly finalizedPrepared: number;
  readonly failedPrepared: readonly { readonly waitId: string; readonly error: string }[];
  /** Parent tool rounds closed with the KNOWN seam release result. */
  readonly closed: readonly {
    readonly sessionId: string;
    readonly taskId: string;
    readonly toolCallId: string;
  }[];
  /** Released calls whose canonical result already existed (no second one). */
  readonly alreadyClosed: readonly string[];
  /** Released calls whose round was closed by another honest path. */
  readonly superseded: readonly { readonly taskId: string; readonly toolCallId: string }[];
  /** Released calls with no durable seam decision (reported, never invented). */
  readonly missingSeamOutcome: readonly { readonly taskId: string; readonly toolCallId: string }[];
  /**
   * Accepted owner inputs the seam delivery index still counts as active —
   * the durable "admitted but never consumed by a provider request" fact
   * (§5.4 №16 rupture "admission ACK до consumed"). Reported so the input is
   * never silently lost; content requeue stays with the steering requeue
   * lane (Decision v5), the seam stores the receipt hashed.
   */
  readonly unconsumedDeliveries: readonly {
    readonly conversationId: string;
    readonly requestId: string;
  }[];
}

export interface NativeWaitRecoveryDeps {
  readonly nativeWaits: NativeTaskWaits;
  /**
   * The session history mutation capability (read + the §1.8
   * `closeReleasedToolRound` join). Optional: without it the join only
   * finalizes prepared outcomes and reports what it found.
   */
  readonly historyMutation?: Pick<SessionHistoryMutationCapability, 'read'> &
    Partial<Pick<SessionHistoryMutationCapability, 'closeReleasedToolRound'>>;
  /** The released subagent rows of the background-task store. */
  readonly listReleasedTaskRows: () => Promise<readonly ReleasedTaskRowSnapshot[]>;
  readonly nowMs?: () => number;
}

export async function joinReleasedNativeTasksWithCanonicalHistory(
  deps: NativeWaitRecoveryDeps,
): Promise<NativeWaitRecoveryReport> {
  // 1. The seam decisions first: a crash between T_release and T_complete is
  // closed by reproducing the prepared outcome (idempotent per waitId).
  const prepared = await deps.nativeWaits.finalizePendingPreparedReleases();

  const alreadyClosed: string[] = [];
  const superseded: { taskId: string; toolCallId: string }[] = [];
  const missingSeamOutcome: { taskId: string; toolCallId: string }[] = [];
  const closed: { sessionId: string; taskId: string; toolCallId: string }[] = [];

  const rows = await deps.listReleasedTaskRows();
  const history = deps.historyMutation;
  for (const row of rows) {
    if (!history?.closeReleasedToolRound) break;
    const outcome = deps.nativeWaits.releasedBackgroundOutcomeOf(row.toolCallId);
    if (!outcome) {
      // No durable background result for a row the release pass promoted:
      // reported, never invented (§5.3 risk 11 — no fabricated success).
      missingSeamOutcome.push({ taskId: row.taskId, toolCallId: row.toolCallId });
      continue;
    }
    const active = (await history.read(row.ownerSessionId)).active;
    if (historyHasToolResult(active, row.toolCallId)) {
      // The live executor (or an earlier join) already committed the result:
      // the canonical history is closed, a second toolResult is forbidden.
      alreadyClosed.push(row.toolCallId);
      continue;
    }
    const round = openToolRoundTail(active, row.parentTurnId);
    const isPending = round?.unclosed.some((call) => call.callId === row.toolCallId);
    if (!isPending) {
      // The round was closed by another honest path (the abort reconcile's
      // unknown outcomes). The call already has a result; the join never
      // rewrites it.
      superseded.push({ taskId: row.taskId, toolCallId: row.toolCallId });
      continue;
    }
    const note = formatReleasedBackgroundNote({
      kind: 'backgrounded',
      taskId: row.taskId,
      // The seam's recorded reason (owner_input / manual_background / timer).
      reason: outcome.reason as 'owner_input' | 'manual_background' | 'timer',
      taskStatus: row.status,
      ...(row.childSessionId ? { subSessionId: row.childSessionId } : {}),
    });
    try {
      const commit = await history.closeReleasedToolRound({
        sessionId: row.ownerSessionId,
        turnId: row.parentTurnId,
        // Deterministic per (session, turn, call): a retried join derives the
        // same records (and after the commit reports `unchanged` anyway).
        operationId: `native-wait-recovery:${row.ownerSessionId}:${row.parentTurnId}:${row.toolCallId}`,
        released: [
          {
            callId: row.toolCallId,
            toolName: 'task',
            text: note,
          },
        ],
        timestampMs: deps.nowMs?.() ?? Date.now(),
      });
      if (commit.closed.includes(row.toolCallId)) {
        closed.push({ sessionId: row.ownerSessionId, taskId: row.taskId, toolCallId: row.toolCallId });
      } else {
        superseded.push({ taskId: row.taskId, toolCallId: row.toolCallId });
      }
    } catch (error) {
      // A failed join leaves the round open (valid) and visible; the next
      // recovery retries it. Never fatal to startup.
      log.warn('native-wait-recovery-join-failed', {
        sessionId: row.ownerSessionId,
        taskId: row.taskId,
        toolCallId: row.toolCallId,
        err: error,
      });
    }
  }

  const unconsumedDeliveries = deps.nativeWaits.listUnconsumedDeliveries().map((delivery) => ({
    conversationId: delivery.conversationId,
    requestId: delivery.requestId,
  }));
  if (
    prepared.finalized > 0 ||
    closed.length > 0 ||
    unconsumedDeliveries.length > 0 ||
    prepared.failed.length > 0
  ) {
    log.info('native wait recovery join', {
      finalizedPrepared: prepared.finalized,
      failedPrepared: prepared.failed.length,
      closedRounds: closed.length,
      alreadyClosed: alreadyClosed.length,
      superseded: superseded.length,
      missingSeamOutcome: missingSeamOutcome.length,
      unconsumedDeliveries: unconsumedDeliveries.length,
    });
  }
  return {
    finalizedPrepared: prepared.finalized,
    failedPrepared: prepared.failed,
    closed,
    alreadyClosed,
    superseded,
    missingSeamOutcome,
    unconsumedDeliveries,
  };
}

function historyHasToolResult(
  active: readonly { message: { role: string } }[],
  toolCallId: string,
): boolean {
  return active.some(
    (envelope) =>
      envelope.message.role === 'toolResult' &&
      (envelope.message as { role: string; toolCallId?: unknown }).toolCallId === toolCallId,
  );
}
