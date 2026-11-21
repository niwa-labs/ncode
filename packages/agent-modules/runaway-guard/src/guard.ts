import type { RunawayGuard, RunawayGuardOptions } from './contracts.js';
import { DEFAULT_MAX_FINGERPRINT_BYTES, positiveInteger } from './fingerprint.js';
import {
  clearDetectionStreaks,
  runKey,
  snapshotTurnSummary,
  stateFor,
  type ShadowState,
} from './state.js';
import {
  projectStep,
  toolCallIdsFromMessage,
  trustedToolProvenanceMapBestEffort,
  verifiedProgressMapBestEffort,
} from './step-view.js';
import { observeStep } from './signals.js';
import { REMINDER_REARM_OCCURRENCES, takePreferredReminder } from './reminder.js';

/**
 * Turn-local detector and reminder policy. No Agent, lifecycle registration,
 * host IO, Memory writes, or persistence belongs to this module.
 */
export function createRunawayGuard(options: RunawayGuardOptions = {}): RunawayGuard {
  const maxFingerprintBytes = positiveInteger(
    options.maxFingerprintBytes ?? DEFAULT_MAX_FINGERPRINT_BYTES,
    'maxFingerprintBytes',
  );
  const afterOccurrences =
    options.remindAfterOccurrences === undefined
      ? undefined
      : integerAtLeast(options.remindAfterOccurrences, 3, 'remindAfterOccurrences');
  const policies = new Map(Object.entries(options.toolPolicies ?? {}));
  const states = new Map<string, ShadowState>();

  return {
    observe(ctx, step, shouldRemind) {
      const state = stateFor(states, ctx);
      state.stepIndex += 1;
      const toolCallIds = new Set(toolCallIdsFromMessage(step.message));
      const view = projectStep(
        step.message,
        step.toolResults,
        state,
        policies,
        maxFingerprintBytes,
        verifiedProgressMapBestEffort(step.verifiedProgress ?? [], toolCallIds),
        trustedToolProvenanceMapBestEffort(step.trustedToolProvenance ?? [], toolCallIds),
        step.blockedToolCalls,
      );
      // The reminder threshold is dynamic: the plain configured level until
      // the first reminder fires, then the next re-arm level (+REMINDER_REARM_OCCURRENCES
      // beyond the last fired one) so the crossing detector re-fires exactly
      // when an escalated reminder is due.
      const threshold = shouldRemind
        ? state.reminderFiredAtOccurrences === undefined
          ? afterOccurrences
          : state.reminderFiredAtOccurrences + REMINDER_REARM_OCCURRENCES
        : undefined;
      const candidates = observeStep(view, { ctx, state, observer: options.onSignal }, threshold);
      return threshold === undefined
        ? undefined
        : takePreferredReminder(candidates, ctx, state, threshold);
    },
    clearDetectionStreaks(ctx) {
      const state = states.get(runKey(ctx));
      if (state) clearDetectionStreaks(state);
    },
    markReminderInjected(ctx) {
      const state = states.get(runKey(ctx));
      if (state) state.reminderInjected = true;
    },
    finishTurn(ctx) {
      const key = runKey(ctx);
      const state = states.get(key);
      if (!state) return undefined;
      const summary = snapshotTurnSummary(ctx, state);
      states.delete(key);
      return summary;
    },
  };
}

function integerAtLeast(value: number, minimum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`runawayGuardExtension: ${field} must be an integer >= ${minimum}`);
  }
  return value;
}
