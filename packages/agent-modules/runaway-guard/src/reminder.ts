import type {
  ReminderCandidates,
  RunawayGuardReminder,
  RunawayGuardReminderSignalKind,
  RunawayGuardRunIdentity,
  RunawayGuardSignalKind,
} from './contracts.js';
import type { ShadowState } from './state.js';

const REMINDER_CANDIDATE_PRIORITY: readonly RunawayGuardReminderSignalKind[] = [
  'unchanged_progress_repeat',
  'same_error_family',
  'exact_action_repeat',
  'polling_repeat',
];

/**
 * Reminder re-arm distance: after a fired reminder the SAME stuck pattern
 * keeps growing in the worst case (the live polling loop ran ~370
 * near-identical checks; the single one-shot nudge at occurrence 3 changed
 * nothing — the model reasoned around it). The next reminder fires once the
 * streak climbs this many occurrences beyond the last fired level, with
 * escalated wording. A genuine streak break re-arms the next reminder (a NEW
 * stuck pattern deserves a fresh nudge), while the escalation level stays
 * monotone for the whole turn.
 */
export const REMINDER_REARM_OCCURRENCES = 9;

export function takePreferredReminder(
  candidates: ReminderCandidates,
  ctx: RunawayGuardRunIdentity,
  state: ShadowState,
  afterOccurrences: number,
): RunawayGuardReminder | undefined {
  for (const signalKind of REMINDER_CANDIDATE_PRIORITY) {
    if (!candidates.has(signalKind)) continue;
    const firedAt = state.reminderFiredAtOccurrences;
    if (firedAt !== undefined && (afterOccurrences ?? 0) < firedAt + REMINDER_REARM_OCCURRENCES) {
      return undefined;
    }
    // Monotone for the whole turn: the first-ever reminder is level 0;
    // every later firing (growth re-arm or a fresh streak after a break)
    // is one level stronger.
    const escalation =
      firedAt === undefined && state.reminderEscalation === 0
        ? 0
        : state.reminderEscalation + 1;
    const content = reminderContent(signalKind, afterOccurrences, escalation);
    if (!content) return undefined;
    state.reminderInjected = false;
    state.reminderFiredAtOccurrences = afterOccurrences;
    state.reminderEscalation = escalation;
    return {
      content,
      observation: {
        schemaVersion: 1,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        agentName: ctx.agentName,
        signalKind,
        stepIndex: state.stepIndex,
        occurrences: afterOccurrences,
        action: 'steer',
      },
    };
  }
  return undefined;
}

export function isReminderSignalKind(
  signalKind: RunawayGuardSignalKind,
): signalKind is RunawayGuardReminderSignalKind {
  return REMINDER_CANDIDATE_PRIORITY.includes(signalKind as RunawayGuardReminderSignalKind);
}

function reminderContent(
  signalKind: RunawayGuardSignalKind,
  occurrences: number | undefined,
  escalation = 0,
): string | undefined {
  if (signalKind === 'polling_repeat') return pollingReminderContent(occurrences);
  const guidance = reminderGuidance(signalKind, occurrences, escalation);
  return guidance
    ? `${guidance} This is a temporary runtime reminder for the current Turn only, not a user preference or a durable rule; do not save this reminder or generalize it into Memory, Skills, or other persistent instruction files for future Turns or sessions.`
    : undefined;
}

function pollingReminderContent(occurrences: number | undefined): string | undefined {
  if (!occurrences) return undefined;
  const count = occurrences === 3 ? 'Three' : String(occurrences);
  return `<system-reminder>
${count} task_output reads for the same task have returned an unchanged status and output cursor. Avoid repeated polling; you will be notified automatically and this conversation will resume when the background task completes.
This reminder applies only to the current Turn. Do not save or generalize it into Memory, Skills, or other persistent instructions.
</system-reminder>`;
}

function reminderGuidance(
  signalKind: RunawayGuardSignalKind,
  occurrences: number | undefined,
  escalation = 0,
): string | undefined {
  if (!occurrences) return undefined;
  // Escalated repeats (the pattern survived an earlier reminder) name the
  // loop explicitly and demand a structurally different next step.
  const escalationPrefix =
    escalation > 0
      ? `[runaway guard · reminder ${escalation + 1}, the earlier reminder did not change this pattern] `
      : '';
  if (signalKind === 'exact_action_repeat') {
    return (
      `${escalationPrefix}The immediately repeated tool action has now occurred ${occurrences} ` +
      'times with effectively the same arguments. Do not repeat it again — not even with cosmetic ' +
      'variations such as changed timestamps, counters or reworded flags. Inspect the results already ' +
      'available, then either change strategy with a concrete expected state change, or report the ' +
      'blocker. If you are waiting for a long-running process, use a background task or a single ' +
      'long sleep instead of polling. Repetition alone does not establish that the task is complete ' +
      'or impossible.'
    );
  }
  if (signalKind === 'same_error_family') {
    return (
      `${escalationPrefix}The same tool error family has now occurred ${occurrences} times in ` +
      'a row. Do not retry the same route unchanged. Diagnose the cause, change one controlled ' +
      'variable or switch route. Do not infer that the entire task has failed from this signal.'
    );
  }
  if (signalKind === 'unchanged_progress_repeat') {
    return (
      `${escalationPrefix}Verified progress for the same work target has remained unchanged across ` +
      `${occurrences} attempts. Do not continue the same route without a concrete expected state ` +
      'change. Inspect the current artifact or state, change strategy, or explain the blocker. ' +
      'Unchanged observed state is not proof that the entire task has failed.'
    );
  }
  return undefined;
}
