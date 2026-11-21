import { createLogger } from '@mavis/logging';

import { SeamError, type DurableSeam } from '@mavis/durable-seam';
import type {
	InternalWaitHandle,
	ReactiveDelegationControl,
	WaitOutcome,
} from '@mavis/steering-control';
import type {
	LocalNativeTaskWaits,
	NativeTaskWaitHandle,
	NativeTaskWaitOutcome,
	NativeTaskWaitRegistration,
	NativeTaskWaitReleaseReason,
} from '@mavis/local-runtime';

const log = createLogger('mcode:turn');

/**
 * Native task-wait binding (verdict 09 §1.4, wave 2): ties a tool-origin
 * foreground `task` call to the EXISTING steering-control wait machinery —
 * the durable seam anchor (`DurableSeam.openForegroundWait`), the reactive
 * control registry (`control.registerWait`) and the committed-steer release
 * pass (`control.onCommittedSteer`). It is NOT a second execution registry:
 * the child execution stays owned by the local task runner (task-owned
 * controller + background-task admission), this port owns only the
 * wait/release decision and its projection onto the task row.
 *
 * Identity is native end to end: the durable waitId is
 * `native-wait:<ownerSession>:<ownerTurn>:<toolCallId>` (the same id the task
 * row carries in `metadata.nativeWaitId`), and the release outcome reports the
 * native `taskId` through the configured adapter — never the adapter default
 * `toolCallId` (§1.4: the model must never receive a task_id task_query does
 * not know).
 *
 * Races (§1.8): the durable seam is the single outcome authority. Completion
 * commits the `completed` outcome through `finalizeTool` while the wait is
 * foreground; a committed release outcome is authoritative, so a losing
 * completion observes `TOOL_RESULT_CONFLICT` and routes the child terminal to
 * the scheduled delivery instead. The in-memory waiter is settled only AFTER
 * the durable choice (`completeForeground` after `finalizeTool`).
 */
export interface NativeTaskWaitsOptions {
	/**
	 * The durable seam (wait-outcome authority AND the durable
	 * release-intent store of §1.6, wave 3); injected lazily.
	 */
	readonly seam: () => DurableSeam;
	/**
	 * The reactive committed-steer release control, injected lazily: the
	 * composition wires the port BEFORE the control (the control's release
	 * pass projects through this port), so the instance is filled afterwards.
	 */
	readonly getControl: () => ReactiveDelegationControl;
	readonly nowMs?: () => number;
}

/**
 * Task-row projection of the native binding, late-bound by the runtime host
 * once its background-task service exists (verdict 09 §1.4/§1.5).
 */
export interface NativeTaskRowProjection {
	/** Reads the current task-row status (note formatting after a release). */
	readonly readTaskStatus?: (taskId: string) => Promise<string | undefined>;
	/**
	 * Promotes the task row when a release commits: `executionMode` must leave
	 * `foreground` before the parent's tool returns, or the session stop
	 * cascade would exclude the still-running child (`session-cascade-targets`
	 * skips foreground subagent rows — §1.5).
	 */
	readonly promoteTaskRow?: (taskId: string) => Promise<void>;
}

/** Wait bound to its native task identity, kept for release projection. */
interface NativeBinding {
	readonly registration: NativeTaskWaitRegistration;
	/**
	 * The registry's internal handle: `registerWait` returns the public
	 * `WaitHandle` surface, but the reactive control always instantiates the
	 * internal one (claim/settle state machine), which `isForeground` reads.
	 */
	readonly handle: InternalWaitHandle;
	/** Set by the release projection before the waiter settles. */
	released: boolean;
	/** Task-row status at the release decision; undefined while foreground. */
	statusAtRelease?: string;
}

/** Committed release intents per owner round, for late registrations (§1.6). */
const RELEASE_INTENT_LIMIT = 256;

export interface NativeTaskWaits extends LocalNativeTaskWaits {
	/**
	 * Release-side projection (§1.4: "синхронизировать native task projection"):
	 * called by the composition inside the committed release pass, AFTER the
	 * durable prepare and BEFORE the waiter settles. A no-op for non-native
	 * (supervisor delegation) waits.
	 */
	projectReleaseDecision(waitId: string): Promise<void>;
	/**
	 * The native taskId of a registered wait (for the release adapter's
	 * `taskIdFor`); undefined for delegation (supervisor) waits.
	 */
	taskIdForWait(waitId: string): string | undefined;
	/**
	 * Monotonic accepted-owner-input generation of a conversation (§1.7, wave
	 * 3): the sequential executor's yield seam probes it before a tool batch
	 * and at every inter-call boundary. A change means a trusted owner input
	 * was accepted while the batch was running.
	 */
	ownerInputGeneration(ownerSessionId: string): number;
	/**
	 * Crash recovery (§1.8/§5.1 wave 3): finalizes every prepared-but-
	 * unfinalized release the seam recovered — the durable prepared outcome is
	 * reproduced verbatim (never re-decided), so a crash between the release
	 * phases cannot wedge the wait or fork the decision.
	 */
	finalizePendingPreparedReleases(): Promise<{
		finalized: number;
		failed: readonly { readonly waitId: string; readonly error: string }[];
	}>;
	/**
	 * The committed background outcome of a tool call, when its single durable
	 * result was a release (§1.8). The canonical-history recovery join reads
	 * it to close the parent's round with the KNOWN release decision.
	 */
	releasedBackgroundOutcomeOf(toolCallId: string):
		| import('@mavis/durable-seam').BackgroundOutcome
		| undefined;
	/**
	 * The recovered seam delivery index entries still active — accepted owner
	 * inputs that were never settled as consumed by a provider request (the
	 * §5.4 №16 "admission ACK до consumed" fact). Recovery reports them so an
	 * accepted input is never silently lost.
	 */
	listUnconsumedDeliveries(): readonly {
		readonly conversationId: string;
		readonly requestId: string;
	}[];
	/**
	 * Late-binds the task-row projection (host background-task service).
	 * Releases committed before the bind keep the honest 'running' status
	 * snapshot and skip the row patch (reported); the runtime host binds long
	 * before any task tool can run.
	 */
	bindTaskProjection(projection: NativeTaskRowProjection): void;
}

export function createNativeTaskWaits(options: NativeTaskWaitsOptions): NativeTaskWaits {
	/** waitId → binding (this process; recovery joins via the row metadata). */
	const bindings = new Map<string, NativeBinding>();
	/** Owner rounds whose release pass already committed (late-registration replay). */
	const releaseIntents = new Map<string, number>();
	/**
	 * Monotonic accepted-owner-input generation per conversation (§1.7, wave
	 * 3): the sequential executor captures it before a tool batch and
	 * re-reads it at inter-call boundaries; a change yields the not-yet-started
	 * remainder with honest skipped outcomes. In-memory fast path of the
	 * durable `noteReleaseIntent` fact.
	 */
	const ownerInputGenerations = new Map<string, number>();
	const nowMs = options.nowMs ?? Date.now;
	let projection: NativeTaskRowProjection = {};
	const control = (): ReactiveDelegationControl => {
		const instance = options.getControl();
		if (!instance) {
			throw new Error('native task waits used before the reactive control was wired');
		}
		return instance;
	};

	function noteIntentKey(ownerSessionId: string, ownerTurnId: string): string {
		return `${ownerSessionId}\u0000${ownerTurnId}`;
	}

	async function rememberReleaseIntent(ownerSessionId: string, ownerTurnId: string): Promise<void> {
		const key = noteIntentKey(ownerSessionId, ownerTurnId);
		// The generation advances SYNCHRONOUSLY with the accept: a batch
		// boundary that races this note still observes the change (§1.7).
		ownerInputGenerations.set(ownerSessionId, (ownerInputGenerations.get(ownerSessionId) ?? 0) + 1);
		releaseIntents.set(key, nowMs());
		while (releaseIntents.size > RELEASE_INTENT_LIMIT) {
			const oldest = [...releaseIntents.entries()].sort((a, b) => a[1] - b[1])[0];
			if (oldest === undefined) break;
			releaseIntents.delete(oldest[0]);
		}
		// Durable fact (§1.6 wave 3): the in-memory map alone loses the
		// replay on restart or eviction. The seam note is idempotent per
		// (conversationId, turnId); a failed note is reported and retried by
		// the next owner input — the release pass itself is not blocked here,
		// the durable decision for EXISTING waits is the prepared outcome.
		try {
			await options.seam().noteReleaseIntent({
				conversationId: ownerSessionId,
				turnId: ownerTurnId,
			});
		} catch (error) {
			log.warn('native-task-release-intent-note-failed', {
				ownerSessionId,
				ownerTurnId,
				err: error,
			});
		}
	}

	function toWaitOutcome(outcome: WaitOutcome, binding: NativeBinding): NativeTaskWaitOutcome {
		if (outcome.kind === 'completed') return { kind: 'completed' };
		return {
			kind: 'backgrounded',
			reason: outcome.prepared.reason as NativeTaskWaitReleaseReason,
			taskStatus: binding.statusAtRelease ?? 'running',
		};
	}

	function mappedHandle(binding: NativeBinding): NativeTaskWaitHandle {
		const { handle, registration } = binding;
		return {
			taskId: registration.taskId,
			outcome: handle.outcome.then((outcome) => toWaitOutcome(outcome, binding)),
			isForeground: () => !handle.isSettled() && !handle.isReleasing(),
			async complete(result) {
				// Idempotent: a double terminal (execution retry, cancel race) must
				// not decide the channel twice — the first decision stands.
				if (handle.isSettled()) {
					const settled = await handle.outcome;
					return settled.kind === 'backgrounded' ? 'background' : 'inline';
				}
				// THE single durable decision of this tool call (§1.8): the FIRST
				// finalize wins. While the wait is still foreground this commits the
				// completed outcome; when a release already committed the prepared
				// background outcome, the seam refuses with TOOL_RESULT_CONFLICT and
				// the backgrounded outcome stands.
				try {
					await options.seam().finalizeTool({
						toolCallId: registration.toolCallId,
						outcome: {
							kind: 'completed',
							taskId: registration.taskId,
							childSessionId: registration.childSessionId,
							childTurnId: registration.childTurnId,
							status: result.status,
						},
					});
				} catch (error) {
					if (isToolResultConflict(error)) {
						// The release outcome is authoritative: the child terminal is
						// routed to the scheduled delivery, never a second tool-result.
						return 'background';
					}
					// Control-plane failure: the durable choice is unproven, so the
					// terminal takes the honest scheduled-delivery channel (visible
					// to recovery) instead of inventing an inline commit.
					log.warn('native-task-complete-failed', {
						waitId: handle.waitId,
						taskId: registration.taskId,
						err: error,
					});
					return 'background';
				}
				// The durable completed outcome is committed; settle the in-memory
				// waiter now (§1.8: `completeForeground` AFTER the confirmed choice).
				// `false` means a release pass holds the claim — its prepare will
				// read the seam's completed wait and roll back, replaying this
				// completion; either way `outcome` settles exactly once.
				handle.completeForeground(result);
				return 'inline';
			},
		};
	}

	return {
		async registerNativeTaskWait(
			registration: NativeTaskWaitRegistration,
		): Promise<NativeTaskWaitHandle> {
			const waitId = nativeWaitIdOf(registration);
			const existing = bindings.get(waitId);
			if (existing) {
				// Replayed registration joins the existing wait — never a second
				// waiter for one tool call.
				return mappedHandle(existing);
			}

			// 1. Durable anchor FIRST (idempotent open; a decided wait is refused).
			const opened = await options.seam().openForegroundWait({
				waitId,
				toolCallId: registration.toolCallId,
				conversationId: registration.ownerSessionId,
				childConversationId: registration.childSessionId,
				childRunId: registration.childTurnId,
				// Recorded verbatim: the parent Stop cascade must reach the child.
				// Enforcement lives in the session stop cascade, which stops this
				// task through its task row once the release promoted it.
				cancelOnParentAbort: true,
			});

			// 2. The reactive control registry — same instance the release pass
			// scans, keyed by the SAME native waitId (§1.4). The instance is the
			// registry's internal handle (claim/settle state machine); the public
			// interface types it as `WaitHandle`, so narrow it back here.
			let handle: InternalWaitHandle;
			try {
				// The registry always instantiates the internal handle (claim/settle
				// state machine); the control interface only exposes the public
				// surface, so the narrowing is structural, not a cast of a foreign
				// object.
				handle = control()
					.registerWait({
						parentConversationId: registration.ownerSessionId,
						parentRunId: registration.ownerTurnId,
						toolCallId: registration.toolCallId,
						stateVersion: opened.stateVersion,
						waitId,
						delegationId: registration.taskId,
					}) as InternalWaitHandle;
			} catch (error) {
				// Fail closed WITHOUT leaking a durable foreground wait: the tool
				// call got no waiter, so its result slot is finalized as a failed
				// outcome and the runner's task_error path stays the only result.
				try {
					await options.seam().finalizeTool({
						toolCallId: registration.toolCallId,
						outcome: { kind: 'failed', reason: 'wait-registry-refused' },
					});
				} catch (finalizeError) {
					log.warn('native-task-register-rollback-failed', { waitId, err: finalizeError });
				}
				throw error;
			}

			const binding: NativeBinding = {
				registration,
				handle,
				released: false,
			};
			bindings.set(waitId, binding);

			// 3. Late-registration replay (§1.6/§5.3 risk 4): an owner input for
			// this exact round was already accepted while the setup was running —
			// release the freshly registered wait instead of re-parking the
			// parent behind an input the runtime already committed. The durable
			// fact (wave 3) keeps the replay correct across restarts and after
			// in-memory eviction; the point read answers without a scan.
			const hasReleaseIntent =
				releaseIntents.has(noteIntentKey(registration.ownerSessionId, registration.ownerTurnId)) ||
				options.seam().hasReleaseIntent(registration.ownerSessionId, registration.ownerTurnId);
			if (hasReleaseIntent) {
				try {
					await control().onCommittedSteer({
						parentConversationId: registration.ownerSessionId,
						parentRunId: registration.ownerTurnId,
					});
				} catch (error) {
					// A replayed release that fails leaves the wait foreground and
					// visible; the next owner input retries it. Never throw into the
					// runner's setup path — the wait itself is healthy.
					log.warn('native-task-late-release-failed', { waitId, err: error });
				}
			}
			return mappedHandle(binding);
		},

		noteOwnerReleaseIntent(ownerSessionId: string, ownerTurnId: string): Promise<void> {
			return rememberReleaseIntent(ownerSessionId, ownerTurnId);
		},

		ownerInputGeneration(ownerSessionId: string): number {
			return ownerInputGenerations.get(ownerSessionId) ?? 0;
		},

		async finalizePendingPreparedReleases(): Promise<{
			finalized: number;
			failed: readonly { readonly waitId: string; readonly error: string }[];
		}> {
			// §1.8/§5.1 wave 3: the crash-recovery finalization of prepared
			// outcomes (T_release committed, T_complete missing) — the seam's
			// prepared outcome is reproduced verbatim, never re-decided.
			const report = await control().recover();
			return {
				finalized: report.finalized.length,
				failed: report.failed.map((failure) => ({
					waitId: failure.waitId ?? '',
					error: failure.error,
				})),
			};
		},

		releasedBackgroundOutcomeOf(toolCallId: string) {
			return options.seam().releasedBackgroundOutcomeOfToolCall(toolCallId);
		},

		listUnconsumedDeliveries() {
			return options.seam().listActiveDeliveries();
		},

		taskIdForWait(waitId: string): string | undefined {
			return bindings.get(waitId)?.registration.taskId;
		},

		async projectReleaseDecision(waitId: string): Promise<void> {
			const binding = bindings.get(waitId);
			if (!binding || binding.released) return;
			binding.released = true;
			if (projection.readTaskStatus) {
				try {
					binding.statusAtRelease =
						(await projection.readTaskStatus(binding.registration.taskId)) ?? 'running';
				} catch {
					binding.statusAtRelease = 'running';
				}
			}
			if (!projection.promoteTaskRow) return;
			try {
				// §1.5: the patch is MANDATORY at release — a row still marked
				// `foreground` is excluded from the session stop cascade
				// (session-cascade-targets), leaving a promoted child outside Stop.
				await projection.promoteTaskRow(binding.registration.taskId);
			} catch (error) {
				// The release is already committed; a projection failure is
				// reported, never rolled back into foreground.
				log.warn('native-task-promote-failed', {
					waitId,
					taskId: binding.registration.taskId,
					err: error,
				});
			}
		},

		bindTaskProjection(next: NativeTaskRowProjection): void {
			projection = next;
		},
	};
}

function nativeWaitIdOf(registration: NativeTaskWaitRegistration): string {
	return `native-wait:${registration.ownerSessionId}:${registration.ownerTurnId}:${registration.toolCallId}`;
}

/** Structural check by the stable seam error code, never by message text. */
function isToolResultConflict(error: unknown): boolean {
	return error instanceof SeamError && error.code === 'TOOL_RESULT_CONFLICT';
}
