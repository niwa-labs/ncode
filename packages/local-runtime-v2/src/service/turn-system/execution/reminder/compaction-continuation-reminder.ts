import type { PiBeforeLlmCallHook } from '@mavis/agent-core/pi-turn-runner';
import { createHash } from 'node:crypto';

/**
 * Wave 3 (canon 05 §2.4, item 3.5): the continuation reminder — delivered
 * EXACTLY ONCE per `compaction.id`.
 *
 * After a compaction the window opens with the summary (`compactionSummary`
 * leading the canonical history). The model must continue the task from where
 * it stopped, not restart it — but a reminder delivered on EVERY request of
 * the compacted window teaches the loop the canon forbids: the model keeps
 * answering «Продолжаю с того места» and each answer re-fires the reminder.
 * The delivered-ids set below is the whole mechanism: one compaction, one
 * reminder; every later request of the same window runs silent.
 *
 * The id comes from the summary message the cut inserted (the binding stamps
 * `compactionId` on it); a summary without the field (a pre-wave-3 log) keys
 * on the deterministic digest of its content — the same summary is the same
 * compaction, so the once-rule still holds.
 *
 * Delivery rides the standard reminder admission: the hidden custom marker,
 * `before-current-user` on the turn's first request (the reminder precedes
 * the fresh user input, right after the summary) and an end-append on the
 * mid-turn В1 delivery (the model continues where the kept tail ends).
 */

/** The custom marker type of the delivered reminder. */
export const COMPACTION_CONTINUATION_REMINDER_CUSTOM_TYPE = 'mcode.compaction-continuation';

/** Delivered compaction ids kept per session (bounded; oldest dropped). */
const MAX_TRACKED_COMPACTION_IDS = 32;

/** The reminder text of one compaction (the id names the cut). */
function continuationReminderText(compactionKey: string): string {
  return (
    `<system-reminder>\n` +
    `The conversation history was compacted (${compactionKey}). The summary above replaces the older context. ` +
    `Continue the work from where it stopped — do not restart the task and do not repeat completed steps.\n` +
    `</system-reminder>`
  );
}

export function createCompactionContinuationReminderHook(): PiBeforeLlmCallHook {
  const deliveredBySession = new Map<string, Set<string>>();
  return (input) => {
    const summary = readLatestCompactionSummary(input.canonicalMessages);
    if (summary === undefined) return undefined;
    const delivered = deliveredCompactionIds(deliveredBySession, input.sessionId);
    const key = compactionKeyOf(summary);
    if (delivered.has(key)) return undefined;
    delivered.add(key);
    if (delivered.size > MAX_TRACKED_COMPACTION_IDS) {
      const oldest = delivered.values().next().value;
      if (oldest !== undefined) delivered.delete(oldest);
    }
    const marker = {
      role: 'custom' as const,
      customType: COMPACTION_CONTINUATION_REMINDER_CUSTOM_TYPE,
      content: continuationReminderText(key),
      display: false as const,
      timestamp: Date.now(),
    };
    return {
      type: 'appendMessage',
      reason: COMPACTION_CONTINUATION_REMINDER_CUSTOM_TYPE,
      message: marker,
      ...(input.phase === 'initial' ? { placement: 'before-current-user' as const } : {}),
    };
  };
}

/** The winning compaction summary of the window: the LAST one in history. */
interface CompactionSummaryLike {
  readonly summary: string;
  readonly compactionId: string | undefined;
}

function readLatestCompactionSummary(
  messages: readonly unknown[],
): CompactionSummaryLike | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
    if (Reflect.get(message, 'role') !== 'compactionSummary') continue;
    const summary = Reflect.get(message, 'summary');
    if (typeof summary !== 'string' || summary.length === 0) continue;
    const compactionId = Reflect.get(message, 'compactionId');
    return {
      summary,
      compactionId: typeof compactionId === 'string' && compactionId.trim() ? compactionId : undefined,
    };
  }
  return undefined;
}

/**
 * The once-key of a compaction: the durable compaction id when the summary
 * carries it; otherwise the deterministic content digest — the same summary
 * text is the same compaction for the once-rule's purpose.
 */
function compactionKeyOf(summary: CompactionSummaryLike): string {
  return (
    summary.compactionId ??
    `summary:${createHash('sha256').update(summary.summary, 'utf8').digest('hex').slice(0, 16)}`
  );
}

/** The bounded delivered-ids set of one session. */
function deliveredCompactionIds(
  deliveredBySession: Map<string, Set<string>>,
  sessionId: string,
): Set<string> {
  let delivered = deliveredBySession.get(sessionId);
  if (delivered === undefined) {
    delivered = new Set();
    deliveredBySession.set(sessionId, delivered);
  }
  return delivered;
}
