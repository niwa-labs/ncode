/**
 * Product orchestration state as pinned pi-durable DOCUMENTS (W08 part A,
 * merge-map rows "goal/plan/todo/memory/roster ↔ durable
 * documents/revisions/as-of/fork" and "delegation-supervisor/background/cron ↔
 * durable tasks/documents", port-plan.md:497,508).
 *
 * Every document keeps the pi scope/version/fork/as-of policies — goal state
 * and the delegation roster are REWINDABLE conversation documents (`fork:
 * "asOf"`), so `snapshotAsOf` reconstructs the state at any entry and a fork
 * copies it — no product state is serialized as a hidden blob into a prompt
 * entry (§2.4.6 A6, port-plan.md:198).
 *
 * Identity domains are explicit and single:
 * - product string ids (`goalId`, our `taskId`, `cronId`) are the FAMILY KEYS
 *   and index-doc keys of these documents;
 * - pi numeric `TaskId`s live only inside index/control payloads, owned by
 *   this package (`documents.ts` writes them; every reader treats them as
 *   opaque).
 *
 * @module
 */

import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';

import type { BackgroundTaskKind } from '@mavis/background-task';
import type { ThreadGoalStatus, ThreadGoalStatusReason } from '@mavis/goal';

import type { JsonValue } from '@earendil-works/chord/json';

// ---------------------------------------------------------------------------
// JSON mirrors (type ALIASES, so they carry implicit index signatures and are
// assignable to the chord/pi `JsonObject` document constraint without casts)
// ---------------------------------------------------------------------------

/**
 * Structural JSON mirror of the background-task module's `TaskOutputRef`
 * (that module declares interfaces, which carry no implicit index signature;
 * these aliases exist so document values stay `JsonObject`-clean).
 */
export type TaskOutputRefJson = {
	readonly taskId: string;
	readonly kind: string;
	readonly uri: string;
	readonly offset?: number;
	readonly updatedAt?: number;
	readonly metadata?: { readonly [key: string]: JsonValue };
};

/** Structural JSON mirror of the background-task module's `TaskError`. */
export type TaskErrorJson = {
	readonly message: string;
	readonly code?: string;
	readonly details?: { readonly [key: string]: JsonValue };
};

/** Structural JSON mirror of the background-task module's `TaskUsage`. */
export type TaskUsageJson = {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
	readonly metadata?: { readonly [key: string]: JsonValue };
};

/** Structural JSON mirror of the goal module's `ThreadGoalAttachment`. */
export type GoalAttachmentJson = {
	readonly type: 'file' | 'image';
	readonly filePath: string;
	readonly fileName: string;
	readonly mimeType: string;
	readonly dataUrl?: string;
	readonly assetId?: string;
	readonly error?: string;
};

/** Named alias: one execution wait (inline object|null unions break the JsonObject recursion). */
export type ExecutionWaitJson = { readonly reason: string; readonly sinceMs: number };

/** Structural JSON mirror of the goal module's `ThreadGoalState`. */
export type GoalDocValue = {
	readonly goalId: string;
	readonly sessionId: string;
	readonly objective: string;
	/** REQUIRED (never optional): optional readonly arrays fall outside the pi JsonObject constraint. */
	readonly objectiveResources: GoalAttachmentJson[];
	readonly status: ThreadGoalStatus;
	readonly statusReason?: ThreadGoalStatusReason | null;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly tokensUsed: number;
	readonly turnsUsed: number;
	readonly timeUsedSeconds: number;
	readonly tokenBudget: number | null;
	readonly replyFingerprint: string | null;
	readonly noProgressStreak: number;
	readonly lastVerification?: JsonValue | null;
	readonly lastWorkerProposal?: JsonValue | null;
	readonly kickoffState?: 'pending' | 'enqueued' | 'consumed';
	readonly executionWait?: ExecutionWaitJson | null;
};

/** Family seed of one goal document (the created state itself). */
export type GoalDocSeed = GoalDocValue;

/** Index of the CURRENT goal per conversation (codex: at most one per session). */
export type GoalIndexValue = {
	/** conversationId (pi numeric id, stored as decimal string key) → current goalId. */
	readonly current: { readonly [conversationKey: string]: string };
};

// ---------------------------------------------------------------------------
// Goal documents
// ---------------------------------------------------------------------------

/**
 * One goal's durable state, at address `(conversation, goalId)`. Rewindable:
 * `snapshotAsOf` answers the state as of any visible entry, and a fork of the
 * conversation copies the goal documents it can see.
 */
export const GoalStateDocs = defineDocFamily<GoalDocValue, GoalDocSeed>({
	kind: 'mcode.goal.state',
	scope: 'conversation',
	family: true,
	history: 'rewindable',
	fork: 'asOf',
	version: 1,
	initial: (seed) => seed,
	// Checkpoint policy: every change of these small bounded states becomes a
	// complete base (no delta chains to replay).
	checkpointWhen: () => true,
});

/** Session-scoped index of the current goal per conversation. */
export const GoalIndexDoc = defineDoc<GoalIndexValue>({
	kind: 'mcode.goal.index',
	scope: 'session',
	version: 1,
	initial: () => ({ current: {} }),
	checkpointWhen: () => true,
});

// ---------------------------------------------------------------------------
// Background task documents (persistence of @mavis/background-task state)
// ---------------------------------------------------------------------------

/** Metadata record persisted per orchestrated background task. */
export type BackgroundTaskMetaValue = {
	readonly taskId: string;
	readonly piTaskId: number;
	readonly kind: BackgroundTaskKind;
	readonly ownerSessionId: string;
	readonly description?: string;
	readonly toolCallId?: string;
	readonly parentMessageId?: string;
	readonly parentTaskId?: string | null;
	readonly createdAt: number;
	/** Bookkeeping timestamps (Unix ms); the STATUS authority is the pi task state, never these. */
	readonly updatedAt: number;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly deliveredAt?: number;
	readonly outputRef?: TaskOutputRefJson;
	readonly lastError?: TaskErrorJson;
	readonly usage?: TaskUsageJson;
	readonly metadata?: { readonly [key: string]: JsonValue };
	/** Lifecycle events, newest LAST, capped at {@link TASK_EVENT_CAP}. */
	readonly events: TaskEventJson[];
};

/** One lifecycle event of the per-task event tail (JSON mirror shape). */
export type TaskEventJson = { readonly eventId: string; readonly type: string; readonly at: number };

/** Cap of the per-task event tail inside the record document (checkpointed). */
export const TASK_EVENT_CAP = 64;

/** Control intents the STORE writes for the definition's phases to apply. */
export type BackgroundControlValue = {
	/** Manager start intent: the definition transitions pending → running. */
	readonly startRequestedAt?: number;
	/**
	 * Manager finalize intent (`complete`/`fail`). The running phase prefers it
	 * over the runner's own settlement when both exist; the runner is the
	 * product TaskRunner and the manager keeps UX ownership of outcomes.
	 */
	readonly finalize?: {
		readonly status: 'succeeded' | 'failed';
		readonly reason?: string;
		readonly outputRef?: TaskOutputRefJson;
		readonly usage?: TaskUsageJson;
		readonly error?: TaskErrorJson;
		readonly at: number;
	};
	/** Delivery bookkeeping (undeliveredOnly queries) — metadata, not phase state. */
	readonly deliveredAt?: number;
};

/** Session-scoped index: product task id → its pi task identity. */
export type BackgroundIndexValue = {
	readonly tasks: {
		readonly [taskId: string]: { readonly piTaskId: number; readonly ownerSessionId: string; readonly createdAt: number };
	};
};

/** Control-doc family key (task-scoped intents). */
export const CONTROL_KEY = 'control';

/**
 * Durable record of one orchestrated background task, keyed by the PRODUCT
 * task id (session-scoped family). Session-scoped ON PURPOSE: pi retires
 * task-scoped documents when the task settles, while the product record
 * (timestamps, output refs, events) must stay readable after terminal.
 */
export const BackgroundRecordDocs = defineDocFamily<BackgroundTaskMetaValue, BackgroundTaskMetaValue>({
	kind: 'mcode.background.record',
	scope: 'session',
	family: true,
	version: 1,
	initial: (seed) => seed,
	// Checkpoint policy: every change of these small bounded states becomes a
	// complete base (no delta chains to replay).
	checkpointWhen: () => true,
});

/**
 * Control intents of one pi task record (task-scoped; RETIRES WITH THE TASK
 * by design — intents are meaningless after settlement). Written by the store
 * while the task is live and read+applied by the definition's phases.
 */
export const BackgroundControlDocs = defineDocFamily<BackgroundControlValue, BackgroundControlValue>({
	kind: 'mcode.background.control',
	scope: 'task',
	family: true,
	version: 1,
	initial: (seed) => seed,
	// Checkpoint policy: every change of these small bounded states becomes a
	// complete base (no delta chains to replay).
	checkpointWhen: () => true,
});

/** Session-scoped background-task index. */
export const BackgroundIndexDoc = defineDoc<BackgroundIndexValue>({
	kind: 'mcode.background.index',
	scope: 'session',
	version: 1,
	initial: () => ({ tasks: {} }),
	checkpointWhen: () => true,
});

// ---------------------------------------------------------------------------
// Cron documents (runtime schedule state; config UX stays in @mavis/cron)
// ---------------------------------------------------------------------------

/** Durable runtime state of one cron job's wake task. */
export type CronStateValue = {
	readonly cronId: string;
	/** Digest of the cron config the wake task was scheduled for. */
	readonly configDigest: string;
	readonly lastFiredMs: number | null;
	readonly nextFireMs: number | null;
	readonly fireCount: number;
	/** Last fire result summary (executor policy keeps its own delivery state). */
	readonly lastFireNote?: string;
};

/** Session-scoped index: cronId → pi wake-task id. */
export type CronIndexValue = {
	readonly jobs: { readonly [cronId: string]: { readonly piTaskId: number; readonly configDigest: string } };
};

/**
 * Durable runtime state of one cron wake task, keyed by the PRODUCT cron id
 * (session-scoped family — readable after the wake task settles/aborts).
 */
export const CronRecordDocs = defineDocFamily<CronStateValue, CronStateValue>({
	kind: 'mcode.cron.record',
	scope: 'session',
	family: true,
	version: 1,
	initial: (seed) => seed,
	// Checkpoint policy: every change of these small bounded states becomes a
	// complete base (no delta chains to replay).
	checkpointWhen: () => true,
});

/** Session-scoped cron wake-task index. */
export const CronIndexDoc = defineDoc<CronIndexValue>({
	kind: 'mcode.cron.index',
	scope: 'session',
	version: 1,
	initial: () => ({ jobs: {} }),
	checkpointWhen: () => true,
});

// ---------------------------------------------------------------------------
// Delegation roster document
// ---------------------------------------------------------------------------

/** One roster member (a mirror of a delegation's cross-conversation identity). */
export type RosterMember = {
	readonly delegationId: string;
	readonly childConversationKey: string;
	readonly parentConversationKey: string;
	readonly state: 'foreground' | 'backgrounded' | 'completed';
	readonly updatedAt: number;
};

/** Roster document value (mutable array: chord JsonValue arrays are mutable). */
export type RosterValue = { members: RosterMember[] };

/**
 * Conversation-scoped delegation roster. The delegation SUPERVISOR stays the
 * canonical writer of its own entry stream; this document is the documents
 * home for roster reads (with rewindable history and as-of forks) and is
 * written only through {@link ./roster.ts} helpers in one commit per update.
 */
export const RosterDocs = defineDocFamily<RosterValue, RosterValue>({
	kind: 'mcode.roster',
	scope: 'conversation',
	family: true,
	history: 'rewindable',
	fork: 'asOf',
	version: 1,
	initial: (seed) => seed,
	// Checkpoint policy: every change of these small bounded states becomes a
	// complete base (no delta chains to replay).
	checkpointWhen: () => true,
});

/** Decimal-string key of a numeric pi conversation id (index-doc keys). */
export function conversationKey(conversationId: number): string {
	return String(conversationId);
}
