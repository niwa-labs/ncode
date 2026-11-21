import type { TuiActiveRunSnapshot } from '../runtime/port.js';

/**
 * Headless lifetime policy (verdict 09 §4.4 / §5.4 №20): an exec process that
 * promised "the completion notice is delivered automatically" must not die
 * while its session still owns undelivered background work. After the parent
 * Turn settles, the exec drains that work — waiting for the pending
 * terminal(s) to be delivered and for the wake Turn they activated to finish —
 * before the runtime shuts down. When the drain bound expires, the process
 * exits with an explicit policy note instead of silently dropping the
 * promise; daemon mode (MCODE_SERVER_MODE=auto|required) is the wake that
 * outlives a single exec invocation.
 */

/** Snapshot of the session's background work that still owes a notice. */
export interface PendingBackgroundWork {
  /** Queued/running/stopping tasks owned by the session. */
  readonly active: number;
  /** Terminal tasks whose completion notice has not been consumed yet. */
  readonly undeliveredTerminal: number;
}

export function isBackgroundWorkPending(tasks: readonly {
  status: string;
  deliveredAtMs?: number;
  foreground?: true;
}[]): PendingBackgroundWork {
  let active = 0;
  let undeliveredTerminal = 0;
  for (const task of tasks) {
    // A task still owned by its foreground tool call belongs to the parent
    // Turn, not to the automatic wake path.
    if (task.foreground === true) continue;
    if (task.status === 'queued' || task.status === 'running' || task.status === 'stopping') {
      active += 1;
    } else if (task.deliveredAtMs === undefined) {
      undeliveredTerminal += 1;
    }
  }
  return { active, undeliveredTerminal };
}

export type BackgroundDrainOutcome =
  | 'drained'
  | 'timeout'
  | 'unsupported'
  | 'unreadable'
  | 'cancelled';

/**
 * Wait until the session holds no undelivered background work and no active
 * Run (the wake Turn a terminal activated counts as active work). Returns
 * `unsupported` without waiting when the runtime cannot list background tasks.
 */
export async function waitForBackgroundDeliveryDrain(input: {
  runtime: {
    listBackgroundTasks?(
      ownerSessionId: string,
      options?: { readonly includeSubagent?: boolean },
    ): Promise<readonly { status: string; deliveredAtMs?: number; foreground?: true }[]>;
    getActiveRun(sessionId: string): Promise<TuiActiveRunSnapshot>;
  };
  sessionId: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onPending?: (pending: PendingBackgroundWork) => void;
}): Promise<BackgroundDrainOutcome> {
  const { runtime, sessionId } = input;
  if (typeof runtime.listBackgroundTasks !== 'function') return 'unsupported';
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const deadline = Date.now() + input.timeoutMs;
  let pendingReported = false;
  let consecutiveErrors = 0;
  for (;;) {
    if (input.signal?.aborted) return 'cancelled';
    let pending: PendingBackgroundWork;
    try {
      const tasks = await runtime.listBackgroundTasks(sessionId, { includeSubagent: true });
      pending = isBackgroundWorkPending(tasks);
      consecutiveErrors = 0;
    } catch {
      // A list that persistently fails (a wire/runtime breakdown) must not
      // hang the exit forever: after a few attempts the state is unreadable,
      // and the honest exit is the explicit policy note — the notice was
      // neither confirmed delivered nor proven lost.
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) return 'unreadable';
      pending = { active: 1, undeliveredTerminal: 0 };
    }
    if ((pending.active > 0 || pending.undeliveredTerminal > 0) && !pendingReported) {
      pendingReported = true;
      input.onPending?.(pending);
    }
    if (pending.active === 0 && pending.undeliveredTerminal === 0) {
      // The last notice is consumed; the wake Turn it activated must also be
      // done — a killed wake Turn would drop the assistant's answer.
      let activeRun: TuiActiveRunSnapshot | undefined;
      try {
        activeRun = await runtime.getActiveRun(sessionId);
      } catch {
        activeRun = undefined;
      }
      if (!activeRun || activeRun.state === 'idle' || activeRun.state === 'terminal') {
        return 'drained';
      }
    }
    if (Date.now() >= deadline) return 'timeout';
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      timer.unref?.();
    });
  }
}

/** The explicit exit-policy note an expired drain appends to the exec output. */
export const BACKGROUND_DELIVERY_DRAIN_TIMEOUT_NOTE =
  'Background task work is still pending after the Turn ended; the automatic completion notice has not been delivered. ' +
  'This exec process must exit — run under the daemon (MCODE_SERVER_MODE=auto or required) for wake Turns that outlive a single invocation.';
