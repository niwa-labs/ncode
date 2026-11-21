/**
 * Goal state merged with pi documents (W08 part A; merge-map row
 * "goal/plan/todo/memory/roster ↔ durable documents/revisions/as-of/fork",
 * port-plan.md:508): the product `ThreadGoalStore` port of @mavis/goal is
 * implemented over the rewindable conversation document family
 * {@link GoalStateDocs} + the session-scoped {@link GoalIndexDoc}.
 *
 * What this buys over the incumbent per-host sqlite store:
 * - every CAS guard (`rejectIfCurrentStatus`, `rejectIfObjectiveChangedFrom`,
 *   `rejectIfUpdatedAtChangedFrom`) is enforced INSIDE one session
 *   transaction — the read-check-write is atomic by construction, no
 *   read-then-write window;
 * - the state is rewindable: `snapshotAsOf` answers the goal state at any
 *   visible entry, and a conversation fork copies the goal (scope/version/
 *   fork/as-of policies preserved — never a hidden prompt blob);
 * - codex replace-on-complete (`insert_thread_goal ON CONFLICT … WHERE
 *   status = 'complete'`) is enforced in the creating commit.
 *
 * The product session id → pi conversation mapping is injected (fail-closed:
 * an unmapped session throws {@link UnknownConversationError}, never a
 * guessed conversation).
 *
 * @module
 */

import type { ConversationId, Tx } from '@earendil-works/pi-durable';

import {
	ThreadGoalAlreadyExistsError,
	ThreadGoalBudgetLimitedError,
	ThreadGoalEpochConflictError,
	ThreadGoalObjectiveConflictError,
	ThreadGoalStatusConflictError,
	ThreadGoalTokenBudgetExhaustedError,
} from '@mavis/goal';
import type {
	ThreadGoalBreakerInput,
	ThreadGoalBreakerResult,
	ThreadGoalCreateInput,
	ThreadGoalDecisionResult,
	ThreadGoalPatchInput,
	ThreadGoalRecordVerificationInput,
	ThreadGoalState,
	ThreadGoalStore,
} from '@mavis/goal';

import {
	GoalIndexDoc,
	GoalStateDocs,
	conversationKey,
	type GoalDocValue,
	type GoalIndexValue,
} from './documents.js';
import { UnknownConversationError } from './errors.js';
import type { OrchestrationHarness } from './harness.js';

export interface DurableThreadGoalStoreOptions {
	readonly harness: OrchestrationHarness;
	/** Map a product session id to its pi conversation; `undefined` = unmapped (throws). */
	readonly conversationOfSession: (sessionId: string) => Promise<ConversationId | undefined> | ConversationId | undefined;
	readonly now?: () => number;
	/** Goal id factory; default `tg_<conversation>-<createdAt>` (stable, opaque). */
	readonly goalIdFactory?: (conversationId: ConversationId, createdAt: number) => string;
}

/** Product `ThreadGoalStore` over pi documents (the merged persistence). */
export class DurableThreadGoalStore implements ThreadGoalStore {
	readonly #harness: OrchestrationHarness;
	readonly #conversationOfSession: DurableThreadGoalStoreOptions['conversationOfSession'];
	readonly #now: () => number;
	readonly #goalIdFactory: (conversationId: ConversationId, createdAt: number) => string;

	constructor(options: DurableThreadGoalStoreOptions) {
		this.#harness = options.harness;
		this.#conversationOfSession = options.conversationOfSession;
		this.#now = options.now ?? Date.now;
		this.#goalIdFactory = options.goalIdFactory ?? ((conversationId, createdAt) => `tg_${conversationId}_${createdAt}`);
	}

	async getBySession(sessionId: string): Promise<ThreadGoalState | undefined> {
		const conversationId = await this.#conversation(sessionId);
		const index = await this.#goalIndex();
		const goalId = index.current[conversationKey(conversationId)];
		if (goalId === undefined) return undefined;
		return this.#readGoal(conversationId, goalId);
	}

	async getById(goalId: string): Promise<ThreadGoalState | undefined> {
		const index = await this.#goalIndex();
		for (const [key, candidate] of Object.entries(index.current)) {
			if (candidate !== goalId) continue;
			return this.#readGoal(Number(key) as ConversationId, goalId);
		}
		return undefined;
	}

	async create(input: ThreadGoalCreateInput): Promise<ThreadGoalState> {
		const conversationId = await this.#conversation(input.sessionId);
		const now = this.#now();
		return this.#harness.commit(async (tx) => {
			const index = await tx.doc(GoalIndexDoc);
			const existingGoalId = index.current[conversationKey(conversationId)];
			if (existingGoalId !== undefined) {
				// codex ON CONFLICT … WHERE status = 'complete': replace ONLY a
				// complete goal; anything else is a thrown conflict.
				const existing = await this.#locateInTx(tx, existingGoalId);
				if (existing.value.status !== 'complete') {
					throw new ThreadGoalAlreadyExistsError(existingGoalId);
				}
			}
			const goalId = this.#goalIdFactory(conversationId, now);
			const state: GoalDocValue = {
				goalId,
				sessionId: input.sessionId,
				objective: input.objective,
				objectiveResources: input.objectiveResources
					? ([...input.objectiveResources].map((attachment) => ({ ...attachment })) as GoalDocValue['objectiveResources'])
					: [],
				status: 'active',
				createdAt: now,
				updatedAt: now,
				tokensUsed: 0,
				turnsUsed: 0,
				timeUsedSeconds: 0,
				tokenBudget: input.tokenBudget ?? null,
				replyFingerprint: null,
				noProgressStreak: 0,
			};
			const draft = await tx.doc(GoalStateDocs, conversationId, goalId, state);
			// Family seed initializes a new incarnation; for a REPLACEMENT over a
			// complete goal the same address returns the old draft — assign the
			// new state over it (one write path for both).
			Object.assign(draft, state);
			index.current[conversationKey(conversationId)] = goalId;
			// Drafts never escape the transaction (chord settles the overlay at
			// commit); callers get a detached copy.
			return detachGoal(draft);
		});
	}

	async patch(goalId: string, input: ThreadGoalPatchInput): Promise<ThreadGoalState> {
		return this.#harness.commit(async (tx) => {
			const located = await this.#locateInTx(tx, goalId);
			const draft = await tx.doc(GoalStateDocs, located.conversationId, goalId, located.value);
			// All CAS guards inside ONE transaction — no read-then-write window.
			if (input.rejectIfCurrentStatus !== undefined && located.value.status !== input.rejectIfCurrentStatus) {
				throw new ThreadGoalStatusConflictError(goalId, located.value.status);
			}
			if (input.rejectIfObjectiveChangedFrom !== undefined && located.value.objective !== input.rejectIfObjectiveChangedFrom) {
				throw new ThreadGoalObjectiveConflictError(goalId, input.rejectIfObjectiveChangedFrom, located.value.objective);
			}
			if (input.rejectIfUpdatedAtChangedFrom !== undefined && located.value.updatedAt !== input.rejectIfUpdatedAtChangedFrom) {
				throw new ThreadGoalEpochConflictError(goalId, located.value.updatedAt, input.rejectIfUpdatedAtChangedFrom);
			}
			if (input.status !== undefined && input.status !== located.value.status) {
				// `complete` is final; `budget_limited` → `active` only via a
				// guarded token-budget rearm that actually unexhausts the cap.
				if (located.value.status === 'complete') {
					throw new ThreadGoalStatusConflictError(goalId, located.value.status);
				}
				if (input.status === 'active' && located.value.status === 'budget_limited') {
					const budget = input.tokenBudget === undefined ? located.value.tokenBudget : input.tokenBudget;
					if (budget !== null && budget > 0 && located.value.tokensUsed >= budget) {
						throw new ThreadGoalBudgetLimitedError(goalId);
					}
				}
				draft.status = input.status;
			}
			if (input.statusReason !== undefined) draft.statusReason = input.statusReason;
			if (input.objective !== undefined) draft.objective = input.objective;
			if (input.objectiveResources !== undefined) {
				draft.objectiveResources = [...input.objectiveResources].map((attachment) => ({ ...attachment })) as GoalDocValue['objectiveResources'];
			}
			if (input.tokenBudget !== undefined) {
				const nextBudget = input.tokenBudget;
				if (nextBudget !== null && nextBudget > 0 && located.value.tokensUsed >= nextBudget) {
					throw new ThreadGoalTokenBudgetExhaustedError(goalId, located.value.tokensUsed, nextBudget);
				}
				draft.tokenBudget = nextBudget;
			}
			draft.updatedAt = this.#now();
			return detachGoal(draft);
		});
	}

	async updateBreaker(goalId: string, input: ThreadGoalBreakerInput): Promise<ThreadGoalBreakerResult> {
		return this.#harness.commit(async (tx) => {
			const located = await this.#locateInTx(tx, goalId);
			if (located.value.status !== 'active') {
				return { action: 'stale', staleReason: 'goal_status', goal: located.value as unknown as ThreadGoalState };
			}
			if (located.value.updatedAt !== input.expectedEpoch) {
				return { action: 'stale', staleReason: 'goal_epoch', goal: located.value as unknown as ThreadGoalState };
			}
			const draft = await tx.doc(GoalStateDocs, located.conversationId, goalId, located.value);
			// Shared no-progress streak: a repeated reply OR a tool-less turn
			// increments; an observation gap (`unknown`) resets instead of being
			// stitched into a run (port contract); a fresh fingerprint resets.
			if (input.fingerprint !== null && draft.replyFingerprint === input.fingerprint) {
				draft.noProgressStreak = draft.noProgressStreak + 1;
			} else if (input.toolActivity === 'absent') {
				draft.noProgressStreak = draft.noProgressStreak + 1;
			} else if (input.toolActivity === 'unknown') {
				draft.noProgressStreak = 0;
			} else if (input.fingerprint !== null) {
				draft.replyFingerprint = input.fingerprint;
				draft.noProgressStreak = 0;
			}
			draft.updatedAt = this.#now();
			if (input.limit > 0 && draft.noProgressStreak >= input.limit) {
				const cause: 'repeated_reply' | 'no_tool' =
					input.toolActivity !== 'used' && input.fingerprint === null ? 'no_tool' : 'repeated_reply';
				draft.status = 'paused';
				draft.statusReason = input.pauseReason ?? 'paused(no_progress)';
				const goal = detachGoal(draft);
				return { action: 'pause', cause, epoch: goal.updatedAt, goal };
			}
			const goal = detachGoal(draft);
			return { action: 'none', epoch: goal.updatedAt, goal };
		});
	}

	async recordVerification(input: ThreadGoalRecordVerificationInput): Promise<ThreadGoalDecisionResult> {
		return this.#harness.commit(async (tx) => {
			const located = await this.#locateInTx(tx, input.goalId);
			if (located.value.updatedAt !== input.expectedEpoch) {
				return { status: 'stale', staleReason: 'goal_epoch', goal: located.value as unknown as ThreadGoalState };
			}
			const draft = await tx.doc(GoalStateDocs, located.conversationId, input.goalId, located.value);
			draft.lastVerification = input.result as unknown as NonNullable<GoalDocValue['lastVerification']>;
			if (input.workerProposal !== undefined) {
				draft.lastWorkerProposal = input.workerProposal as unknown as NonNullable<GoalDocValue['lastWorkerProposal']>;
			}
			// Verifier-owned pause on a repeated not-met streak, unless the
			// caller brought its own decision.
			if (input.decision === undefined && input.repeatedNotMetLimit > 0 && input.result.notMetStreak >= input.repeatedNotMetLimit) {
				draft.status = 'paused';
				draft.statusReason = 'paused(no_progress)';
			}
			if (input.decision !== undefined) {
				draft.status = input.decision.status;
				draft.statusReason = input.decision.statusReason;
			}
			draft.updatedAt = this.#now();
			const goal = detachGoal(draft);
			return { status: 'settled', goal, decisionEpoch: goal.updatedAt };
		});
	}

	async delete(goalId: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const index = await tx.doc(GoalIndexDoc);
			for (const [key, candidate] of Object.entries(index.current)) {
				if (candidate === goalId) delete index.current[key];
			}
			// The state document itself stays as history (rewindable); the index
			// removal is the delete contract ("no-op if it does not exist").
		});
	}

	// -------------------------------------------------------------------------

	async #conversation(sessionId: string): Promise<ConversationId> {
		const conversationId = await this.#conversationOfSession(sessionId);
		if (conversationId === undefined) throw new UnknownConversationError(sessionId);
		return conversationId;
	}

	async #goalIndex(): Promise<GoalIndexValue> {
		return this.#harness.commit(async (tx) => {
			const draft = await tx.doc(GoalIndexDoc);
			return { current: { ...draft.current } };
		});
	}

	async #readGoal(conversationId: ConversationId, goalId: string): Promise<ThreadGoalState | undefined> {
		return this.#harness.commit(async (tx) => {
			const draft = await tx.doc(GoalStateDocs, conversationId, goalId, placeholderSeed(goalId));
			// A placeholder-seeded read of an address that should exist surfaces
			// as the obvious synthetic record the caller guards against.
			if (draft.createdAt === 0 && draft.sessionId === '') return undefined;
			return detachGoal(draft);
		});
	}

	async #locateInTx(tx: Tx, goalId: string): Promise<{ conversationId: ConversationId; value: GoalDocValue }> {
		const index = await tx.doc(GoalIndexDoc);
		for (const [key, candidate] of Object.entries(index.current)) {
			if (candidate !== goalId) continue;
			const conversationId = Number(key) as ConversationId;
			const draft = await tx.doc(GoalStateDocs, conversationId, goalId, placeholderSeed(goalId));
			return { conversationId, value: draft as unknown as GoalDocValue };
		}
		throw new Error(`goal ${goalId} does not exist`);
	}
}

/**
 * Detached copy of a goal draft: drafts never escape the transaction (chord
 * settles the overlay proxy at commit), so every public return snapshots the
 * value while the transaction is still open.
 */
function detachGoal(draft: { -readonly [K in keyof GoalDocValue]: GoalDocValue[K] }): ThreadGoalState {
	const copy: GoalDocValue = {
		...draft,
		objectiveResources: draft.objectiveResources.map((attachment) => ({ ...attachment })),
	};
	return copy as unknown as ThreadGoalState;
}

/**
 * Seed handed to `tx.doc` for documents that an indexed entry must already
 * have (the seed is used only when the address does not exist — which would
 * be a contract breach the caller's guards then surface).
 */
function placeholderSeed(goalId: string): GoalDocValue {
	return {
		goalId,
		sessionId: '',
		objective: '',
		status: 'complete',
		createdAt: 0,
		updatedAt: 0,
		tokensUsed: 0,
		turnsUsed: 0,
		timeUsedSeconds: 0,
		tokenBudget: null,
		replyFingerprint: null,
		noProgressStreak: 0,
		objectiveResources: [],
	};
}
