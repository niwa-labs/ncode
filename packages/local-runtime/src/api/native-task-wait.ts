import type { LocalTaskRunResult } from '@mavis/agent-tools/desktop';

/**
 * Native task-wait binding port (verdict 09 §1.4): the ONE new binding concept
 * of the reactive subagent wave. It ties a tool-origin foreground `task` call
 * to the existing steering-control wait machinery (`DurableSeam` +
 * `ReactiveDelegationControl`) WITHOUT a second execution registry: the child
 * execution stays owned by the local task runner, the port owns only the
 * wait/release decision.
 *
 * Identity: the wait is keyed by the parent's `(ownerSessionId, ownerTurnId,
 * toolCallId)` — the same WaitKey shape the reactive control uses — and
 * anchored durably under {@link nativeTaskWaitId}. The task row carries the
 * same id in its metadata (`nativeWaitId`), so recovery can join the seam
 * outcome with the canonical result by turn/toolCallId exactly once (§1.8).
 *
 * Implemented by the durable runtime (local-runtime-v2) over its delegation
 * steering composition; absent on the jsonl mode, which keeps the legacy
 * always-inline foreground contract (§5.2 — the capability is honestly
 * absent there, the prompt must not promise owner-input backgrounding).
 *
 * @module
 */

/** Deterministic durable anchor of one native task wait (the seam waitId). */
export function nativeTaskWaitId(
  ownerSessionId: string,
  ownerTurnId: string,
  toolCallId: string,
): string {
  return `native-wait:${ownerSessionId}:${ownerTurnId}:${toolCallId}`;
}

/** Registration of one tool-origin foreground task wait. */
export interface NativeTaskWaitRegistration {
  /** Parent (owner) conversation that is blocked on the task. */
  readonly ownerSessionId: string;
  /** Parent run whose tool-round contains the wait. */
  readonly ownerTurnId: string;
  /** The `task` tool-call holding the foreground promise open. */
  readonly toolCallId: string;
  /** The stable task handle the model was given (task_query/task_stop). */
  readonly taskId: string;
  /** Child session under the task row (recorded, never a second identity). */
  readonly childSessionId: string;
  /** Child turn id (the task row's subTurnId). */
  readonly childTurnId: string;
}

/** Why the wait released. `timer`/`manual_background` are control-plane reasons. */
export type NativeTaskWaitReleaseReason =
  | 'owner_input'
  | 'manual_background'
  | 'timer';

/** The single outcome of the wait, mapped from the steering-control WaitHandle. */
export type NativeTaskWaitOutcome =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'backgrounded';
      readonly reason: NativeTaskWaitReleaseReason;
      /** Task-row status snapshot at the release decision (note formatting). */
      readonly taskStatus: string;
    };

/** Handle of one registered native task wait (runner side). */
export interface NativeTaskWaitHandle {
  /** Resolves exactly once, with the single chosen outcome of this wait. */
  readonly outcome: Promise<NativeTaskWaitOutcome>;
  /**
   * Commits the child's terminal to the ONE durable decision (§1.8): the seam
   * `finalizeTool` records the completed outcome while the wait is still
   * foreground (`inline`); when a release already committed the background
   * outcome, the terminal is routed to the scheduled delivery instead
   * (`background`) and the backgrounded outcome of the wait stands.
   */
  complete(result: Pick<LocalTaskRunResult, 'status'>): Promise<'inline' | 'background'>;
  /**
   * True while the wait is still foreground. Gates the parent-abort proxy:
   * once the wait releases (or is mid-release), a parent turn cancellation
   * must NOT cancel the detached child execution (§4).
   */
  isForeground(): boolean;
  /** The stable task handle this wait was registered under. */
  readonly taskId: string;
}

/** The runtime port the task runner reads off the host. */
export interface LocalNativeTaskWaits {
  /**
   * Registers a foreground task wait BEFORE the child turn is submitted
   * (§1.5 step 2). Opening the durable anchor and registering with the
   * reactive control are idempotent: a replayed registration attaches to the
   * existing wait, and a release intent already committed for the same owner
   * round (owner input accepted while setup was still running) is replayed
   * against the freshly registered wait instead of re-parking the parent.
   */
  registerNativeTaskWait(registration: NativeTaskWaitRegistration): Promise<NativeTaskWaitHandle>;
  /**
   * Records that a trusted owner input was accepted for `(ownerSessionId,
   * ownerTurnId)` and its release pass is being committed (§1.6). A wait that
   * registers for the same round AFTER this fact must be released by the
   * replay instead of blocking the parent behind an input the runtime already
   * accepted. Wave 3: the fact is ALSO durable (the seam's deterministic
   * release-intent entry), so the replay survives a restart; the returned
   * promise resolves after the durable note and the release caller awaits it
   * before committing the pass.
   */
  noteOwnerReleaseIntent(ownerSessionId: string, ownerTurnId: string): void | Promise<void>;
  /**
   * Monotonic accepted-owner-input generation of a conversation (§1.7, wave
   * 3): the sequential executor's yield-to-owner-input seam probes it before
   * a tool batch and at every inter-call boundary; a change makes the
   * not-yet-started calls receive honest skipped outcomes instead of starting
   * blind against an already-accepted instruction. Absent (legacy port
   * implementations): the host resolves no probe and batches behave as
   * before.
   */
  ownerInputGeneration?(ownerSessionId: string): number;
}
