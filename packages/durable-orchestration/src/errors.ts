/**
 * Bridge-local error types (fail-closed, per the wave invariants). None of
 * these ever silently degrade a read into "empty" — an absent record stays
 * `undefined`, and every inconsistent bridge state throws a diagnosed error.
 *
 * @module
 */

/** Base class for durable-orchestration bridge failures. */
export class OrchestrationBridgeError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = 'OrchestrationBridgeError';
	}
}

/**
 * A caller addressed a pi conversation the harness does not know. The bridge
 * never guesses a conversation id from a session id: the host supplies the
 * mapping, and an unmapped session is a thrown error, not a second identity.
 */
export class UnknownConversationError extends OrchestrationBridgeError {
	constructor(readonly sessionId: string) {
		super(`Session ${sessionId} is not mapped to a durable conversation`, 'ORCH_UNKNOWN_CONVERSATION');
	}
}

/** A store addressed a pi task record that does not exist (deleted storage or a foreign id). */
export class UnknownOrchestratedTaskError extends OrchestrationBridgeError {
	constructor(readonly taskId: string) {
		super(`Orchestrated task ${taskId} does not exist`, 'ORCH_UNKNOWN_TASK');
	}
}

/**
 * The record a bridge read is not the kind that owns it (e.g. a
 * `mcode.background.v1` control doc opened through the goal store). Fail
 * closed instead of interpreting foreign content.
 */
export class BridgeContractMismatchError extends OrchestrationBridgeError {
	constructor(message: string) {
		super(message, 'ORCH_BRIDGE_CONTRACT_MISMATCH');
	}
}
