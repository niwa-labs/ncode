/**
 * Background-task persistence merged with pi tasks (W08 part A; merge-map row
 * "delegation-supervisor/background/cron ↔ durable tasks/documents",
 * port-plan.md:497): the product `TaskStore` port of @mavis/background-task is
 * implemented over the ONE durable scheduler.
 *
 * Ownership split (the §2.4.6 A6 invariant, port-plan.md:195 — "durable
 * scheduler — один владелец task phases"):
 * - the pi task record is the STATUS authority. Every durable phase
 *   transition is committed by this module's task definition through the pi
 *   `TaskRuntime` — `tx.setTask` is internal to pi and is never used;
 * - the product manager keeps lifecycle UX; its `patch({status})` calls
 *   become INTENTS in the task-scoped control document, and stop becomes a
 *   pi abort mark (`harness.abortTask`), whose settlement is the definition's
 *   abort handler;
 * - `background: true` at creation excludes the task from ordinary idle
 *   waits, conversation aborts and cascades — the pi-native form of the
 *   product's auto-detach: the owner run can release its foreground wait and
 *   the task keeps running and completes (V: "task completion after
 *   auto-detach").
 *
 * The observe phases read the tiny control document INSIDE one commit and
 * return the same-commit sleep when there is no intent (pi: "returning
 * `{status:'sleeping', …}` from `commit()` is the same sleep"), so a poll is
 * one atomic read+transition on the scheduler's wheel — no second timer. An
 * abort mark wakes a sleeping observe immediately (pi semantics), so stop
 * latency is not bounded by the poll.
 *
 * The bridge is a pure LEDGER: product runners keep executing outside (the
 * manager and its `TaskRunner`s), execution liveness stays product policy.
 *
 * @module
 */

import type { JsonValue } from '@earendil-works/chord/json';
import type { Context } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import type { ConversationId, TaskId } from '@earendil-works/pi-durable';

import {
	TaskAlreadyExistsError,
	TaskNotFoundError,
	canTransitionTaskStatus,
} from '@mavis/background-task';
import type {
	BackgroundTask,
	BackgroundTaskPatch,
	BackgroundTaskStatus,
	TaskLifecycleEvent,
	TaskListResult,
	TaskQuery,
	TaskStore,
} from '@mavis/background-task';

import { createLogger } from '@mavis/logging';

import {
	BackgroundControlDocs,
	BackgroundIndexDoc,
	BackgroundRecordDocs,
	CONTROL_KEY,
	TASK_EVENT_CAP,
	type BackgroundControlValue,
	type BackgroundIndexValue,
	type BackgroundTaskMetaValue,
	type TaskErrorJson,
	type TaskEventJson,
	type TaskOutputRefJson,
	type TaskUsageJson,
} from './documents.js';
import { BridgeContractMismatchError, UnknownOrchestratedTaskError } from './errors.js';
import type { OrchestrationHarness } from './harness.js';

const log = createLogger('mcode:orchestration');

/** Registered pi task kind of the background bridge. */
export const BACKGROUND_TASK_KIND = 'mcode.background.v1';

/**
 * Host-intent observation interval on the scheduler's sleep wheel (ms).
 * 250ms (review W08-П1 №3): at 20ms an idle background task rewrote its
 * durable state ~50x/sec (write amplification on the log); abort wakes
 * instantly through the abort marker, so the poll only covers host-intent
 * changes (pause/resume/stop), where quarter-second latency is invisible.
 */
export const POLL_MS = 250;

/** Bounded wait for the scheduler to apply a manager intent (ms). */
export const TRANSITION_TIMEOUT_MS = 10_000;

/** Definition input (durable). */
export interface BackgroundTaskInput {
	readonly taskId: string;
	readonly kind: string;
}

/** Definition checkpoint. */
export type BackgroundTaskCheckpoint = { readonly phase: 'queued' | 'running' };

/** Result payload of a settled background task (durable). */
export type BackgroundTaskResult = {
	readonly status: 'succeeded' | 'failed';
	readonly reason?: string;
};

/** Outcome JSON committed by the phases (pi `TaskOutcome<BackgroundTaskResult>`). */
type Outcome =
	| { readonly status: 'completed'; readonly result: BackgroundTaskResult }
	| { readonly status: 'failed'; readonly error: { readonly message: string }; readonly result?: BackgroundTaskResult }
	| { readonly status: 'aborted'; readonly reason?: string };

function outcomeFromFinalize(finalize: NonNullable<BackgroundControlValue['finalize']>): Outcome {
	if (finalize.status === 'succeeded') {
		return {
			status: 'completed',
			result: { status: 'succeeded', ...(finalize.reason !== undefined ? { reason: finalize.reason } : {}) },
		};
	}
	return {
		status: 'failed',
		error: { message: finalize.error?.message ?? finalize.reason ?? 'task failed' },
		result: { status: 'failed', ...(finalize.reason !== undefined ? { reason: finalize.reason } : {}) },
	};
}

/** The bridge's registered definition (phases commit; nothing else does). */
export const backgroundTaskDefinition = defineTask<BackgroundTaskInput, BackgroundTaskCheckpoint, BackgroundTaskResult, object>({
	name: BACKGROUND_TASK_KIND,
	version: 1,
	initial: () => ({ phase: 'queued' }),
	phases: {
		queued: async (_task, runtime, context) => {
			await runtime.commit(async (tx, current) => {
				const control = await tx.doc(BackgroundControlDocs, current.id, CONTROL_KEY, {});
				if (control.finalize !== undefined) {
					return { status: 'terminal', outcome: outcomeFromFinalize(control.finalize) };
				}
				if (control.startRequestedAt !== undefined) {
					return { status: 'running', checkpoint: { phase: 'running' } };
				}
				return { status: 'sleeping', until: runtime.now() + POLL_MS, checkpoint: { phase: 'queued' } };
			}, context);
		},
		running: async (_task, runtime, context) => {
			await runtime.commit(async (tx, current) => {
				const control = await tx.doc(BackgroundControlDocs, current.id, CONTROL_KEY, {});
				if (control.finalize !== undefined) {
					return { status: 'terminal', outcome: outcomeFromFinalize(control.finalize) };
				}
				return { status: 'sleeping', until: runtime.now() + POLL_MS, checkpoint: { phase: 'running' } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(
			() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'stop_requested' } }) satisfies { status: 'terminal'; outcome: Outcome },
			context,
		);
	},
});

/** Registry entry for the bridge definition. */
export function backgroundTaskExtension(): { readonly name: string; readonly tasks: readonly [typeof backgroundTaskDefinition] } {
	return { name: 'mcode.orchestration.background', tasks: [backgroundTaskDefinition] };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface DurableBackgroundTaskStoreOptions {
	readonly harness: OrchestrationHarness;
	/** Resolve a product session to the pi conversation that owns its tasks. */
	readonly resolveConversation?: (ownerSessionId: string) => Promise<ConversationId> | ConversationId;
	readonly now?: () => number;
}

interface TaskRead {
	readonly piTaskId: number;
	readonly meta: BackgroundTaskMetaValue;
	readonly status: BackgroundTaskStatus;
}

/** Product `TaskStore` over the one durable scheduler (pi tasks + documents). */
export class DurableBackgroundTaskStore implements TaskStore {
	readonly #harness: OrchestrationHarness;
	readonly #resolveConversation: (ownerSessionId: string) => Promise<ConversationId> | ConversationId;
	readonly #now: () => number;

	constructor(options: DurableBackgroundTaskStoreOptions) {
		this.#harness = options.harness;
		// Fail-closed (review W08-П1 №2): no silent root() fallback — a missing
		// composition would collapse every product session into one shared
		// conversation (cross-session bleed). Require the injection.
		const resolveConversation = options.resolveConversation;
		if (resolveConversation === undefined) {
			throw new Error(
				'DurableBackgroundTaskStore requires resolveConversation: the product composition must map owner sessions to conversations (fail-closed, no root() fallback)',
			);
		}
		this.#resolveConversation = resolveConversation;
		this.#now = options.now ?? Date.now;
	}

	async create(task: BackgroundTask): Promise<BackgroundTask> {
		const conversationId = await this.#resolveConversation(task.ownerSessionId);
		const piTaskId = await this.#harness.commit(async (tx) => {
			const index = await tx.doc(BackgroundIndexDoc);
			if (index.tasks[task.taskId] !== undefined) throw new TaskAlreadyExistsError(task.taskId);
			const minted = await tx.createTask(
				backgroundTaskDefinition,
				{ taskId: task.taskId, kind: task.kind },
				{ ownership: { kind: 'conversation' }, conversationId, background: true },
			);
			const meta: BackgroundTaskMetaValue = {
				taskId: task.taskId,
				piTaskId: minted,
				kind: task.kind,
				ownerSessionId: task.ownerSessionId,
				...(task.description !== undefined ? { description: task.description } : {}),
				...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
				...(task.parentMessageId !== undefined ? { parentMessageId: task.parentMessageId } : {}),
				...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
				createdAt: task.createdAt,
				updatedAt: task.updatedAt,
				...(task.metadata !== undefined ? { metadata: jsonRecord(task.metadata) } : {}),
				events: [],
			};
			await tx.doc(BackgroundRecordDocs, task.taskId, meta);
			await tx.doc(BackgroundControlDocs, minted, CONTROL_KEY, {});
			index.tasks[task.taskId] = { piTaskId: minted, ownerSessionId: task.ownerSessionId, createdAt: task.createdAt };
			return minted;
		});
		log.debug('background task created', { taskId: task.taskId, piTaskId: String(piTaskId) });
		return { ...task };
	}

	async get(taskId: string): Promise<BackgroundTask | undefined> {
		const read = await this.#read(taskId);
		return read === undefined ? undefined : composeTask(read.meta, read.status);
	}

	async list(query: TaskQuery): Promise<TaskListResult> {
		const index = await this.#sessionSnapshotIndex();
		const items: BackgroundTask[] = [];
		for (const taskId of Object.keys(index.tasks)) {
			const read = await this.#read(taskId);
			if (read === undefined) continue;
			const composed = composeTask(read.meta, read.status);
			if (matchesQuery(composed, query)) items.push(composed);
		}
		const order = query.order ?? 'desc';
		const orderBy = query.orderBy ?? 'created_at';
		items.sort((left, right) => {
			const leftValue = getOrderValue(left, orderBy);
			const rightValue = getOrderValue(right, orderBy);
			return order === 'asc' ? leftValue - rightValue : rightValue - leftValue;
		});
		const offset = parseCursor(query.cursor);
		const limit = clampLimit(query.limit);
		const page = items.slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		return { items, ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}) };
	}

	async patch(taskId: string, patch: BackgroundTaskPatch): Promise<BackgroundTask> {
		const read = await this.#read(taskId);
		if (read === undefined) throw new TaskNotFoundError(taskId);
		const { piTaskId, status } = read;

		if (patch.status !== undefined && patch.status !== status) {
			if (!canTransitionTaskStatus(status, patch.status)) {
				throw new Error(`Invalid background task status transition ${status} -> ${patch.status} (${taskId})`);
			}
			await this.#requestStatus(piTaskId, taskId, status, patch);
		}

		await this.#harness.commit(async (tx) => {
			const recordDraft = await tx.doc(BackgroundRecordDocs, taskId, read.meta);
			applyMetaPatch(recordDraft, patch, this.#now());
		});

		const updated = await this.#read(taskId);
		if (updated === undefined) throw new TaskNotFoundError(taskId);
		return composeTask(updated.meta, updated.status);
	}

	async updateStatus(taskId: string, status: BackgroundTaskStatus, reason?: string): Promise<BackgroundTask> {
		const patch: BackgroundTaskPatch = { status };
		if (reason !== undefined && ['failed', 'canceled', 'lost'].includes(status)) {
			patch.lastError = { message: reason, code: status.toUpperCase() };
		}
		return this.patch(taskId, patch);
	}

	async appendEvent(event: TaskLifecycleEvent): Promise<void> {
		const read = await this.#read(event.taskId);
		if (read === undefined) throw new TaskNotFoundError(event.taskId);
		await this.#harness.commit(async (tx) => {
			const recordDraft = await tx.doc(BackgroundRecordDocs, event.taskId, read.meta);
			const events: TaskEventJson[] = [...recordDraft.events, { eventId: event.eventId, type: event.type, at: event.timestamp }];
			recordDraft.events = events.slice(-TASK_EVENT_CAP);
		});
	}

	// -------------------------------------------------------------------------

	async #requestStatus(piTaskId: number, taskId: string, current: BackgroundTaskStatus, patch: BackgroundTaskPatch): Promise<void> {
		const target = patch.status;
		switch (target) {
			case 'running': {
				await this.#harness.commit(async (tx) => {
					const control = await tx.doc(BackgroundControlDocs, piTaskId as TaskId, CONTROL_KEY, {});
					control.startRequestedAt = patch.startedAt ?? this.#now();
				});
				await this.#waitFor(taskId, piTaskId, (status) => status === 'running' || isTerminal(status), 'running');
				return;
			}
			case 'stopping': {
				// The pi abort mark: a sleeping observe wakes immediately and the
				// definition's abort handler settles the outcome.
				await this.#harness.abortTask(piTaskId as TaskId);
				await this.#waitFor(taskId, piTaskId, (status) => isTerminal(status) || status === 'stopping', 'stopping');
				return;
			}
			case 'canceled': {
				// Manager stop-flow: the mark was requested at 'stopping'. A direct
				// queued→canceled patch still needs the mark.
				if (current !== 'stopping') await this.#harness.abortTask(piTaskId as TaskId);
				await this.#waitFor(taskId, piTaskId, isTerminal, 'canceled');
				return;
			}
			case 'succeeded':
			case 'failed': {
				await this.#harness.commit(async (tx) => {
					const control = await tx.doc(BackgroundControlDocs, piTaskId as TaskId, CONTROL_KEY, {});
					control.finalize = {
						status: target,
						at: this.#now(),
						...(patch.lastError !== undefined ? { error: errorToJson(patch.lastError) } : {}),
					};
				});
				await this.#waitFor(taskId, piTaskId, isTerminal, target);
				return;
			}
			case 'lost':
				throw new Error(
					`'lost' is a scheduler-derived outcome (pi 'orphaned'); it cannot be patched (${taskId})`,
				);
			case 'queued':
				return; // initial state; nothing to request
		}
	}

	async #waitFor(taskId: string, piTaskId: number, predicate: (status: BackgroundTaskStatus) => boolean, label: string): Promise<void> {
		const deadline = this.#now() + TRANSITION_TIMEOUT_MS;
		for (;;) {
			const read = await this.#readByPiId(piTaskId, taskId);
			if (read !== undefined && predicate(read.status)) return;
			if (this.#now() > deadline) {
				throw new Error(`background task ${piTaskId} did not reach ${label} within ${TRANSITION_TIMEOUT_MS}ms`);
			}
			await delay(POLL_MS);
		}
	}

	async #read(taskId: string): Promise<TaskRead | undefined> {
		const index = await this.#sessionSnapshotIndex();
		const entry = index.tasks[taskId];
		if (entry === undefined) return undefined;
		return this.#readByPiId(entry.piTaskId, taskId);
	}

	async #readByPiId(piTaskId: number, taskId: string): Promise<TaskRead> {
		const record = await this.#harness.task(piTaskId as TaskId);
		if (record === undefined) throw new UnknownOrchestratedTaskError(String(piTaskId));
		// Read on the session line and detach INSIDE the transaction: document
		// draft overlays settle at commit and never escape it. The record doc is
		// SESSION-scoped (pi retires task-scoped docs at terminal).
		const meta = await this.#harness.commit(async (tx) => {
			const draft = await tx.doc(BackgroundRecordDocs, taskId, placeholderMeta(piTaskId));
			if (draft.createdAt === 0 && draft.ownerSessionId === '') {
				throw new BridgeContractMismatchError(`background task ${piTaskId} has no record document`);
			}
			return detachMeta(draft);
		});
		return { piTaskId, meta, status: deriveStatus(record as unknown as Parameters<typeof deriveStatus>[0], meta) };
	}

	async #sessionSnapshotIndex(): Promise<BackgroundIndexValue> {
		return this.#harness.commit(async (tx) => {
			const draft = await tx.doc(BackgroundIndexDoc);
			return { tasks: JSON.parse(JSON.stringify(draft.tasks)) as BackgroundIndexValue['tasks'] };
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The durable status: derived ONLY from the pi task record. */
function deriveStatus(
	record: {
		readonly state: {
			readonly status: string;
			readonly outcome?: { readonly status: string };
			readonly abortRequested?: boolean;
			readonly checkpoint?: { readonly phase?: string };
		};
	},
	_meta: BackgroundTaskMetaValue,
): BackgroundTaskStatus {
	const state = record.state;
	if (state.status === 'terminal' || state.status === 'completing') {
		switch (state.outcome?.status) {
			case 'completed': return 'succeeded';
			case 'aborted': return 'canceled';
			case 'orphaned': return 'lost';
			case 'failed':
			case 'faulted':
			default: return 'failed';
		}
	}
	// An abort mark dominates every live state (the definition settles it).
	if (state.abortRequested === true) return 'stopping';
	// The scheduler RESERVES a task (raw 'running' with the INITIAL checkpoint)
	// before its first phase makes progress; the product 'running' starts when
	// the observe phase has committed the 'running' checkpoint phase.
	if (state.checkpoint?.phase === 'running') return 'running';
	return 'queued';
}

function isTerminal(status: BackgroundTaskStatus): boolean {
	return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'lost';
}

function composeTask(meta: BackgroundTaskMetaValue, status: BackgroundTaskStatus): BackgroundTask {
	return {
		taskId: meta.taskId,
		kind: meta.kind,
		status,
		ownerSessionId: meta.ownerSessionId,
		...(meta.description !== undefined ? { description: meta.description } : {}),
		...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
		...(meta.parentMessageId !== undefined ? { parentMessageId: meta.parentMessageId } : {}),
		...(meta.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		...(meta.startedAt !== undefined ? { startedAt: meta.startedAt } : {}),
		...(meta.endedAt !== undefined ? { endedAt: meta.endedAt } : {}),
		...(meta.deliveredAt !== undefined ? { deliveredAt: meta.deliveredAt } : {}),
		...(meta.outputRef !== undefined ? { outputRef: meta.outputRef as unknown as BackgroundTask['outputRef'] } : {}),
		...(meta.lastError !== undefined ? { lastError: meta.lastError as unknown as BackgroundTask['lastError'] } : {}),
		...(meta.usage !== undefined ? { usage: meta.usage as unknown as BackgroundTask['usage'] } : {}),
		...(meta.metadata !== undefined ? { metadata: meta.metadata as Record<string, unknown> } : {}),
	};
}

function applyMetaPatch(
	draft: { -readonly [K in keyof BackgroundTaskMetaValue]: BackgroundTaskMetaValue[K] },
	patch: BackgroundTaskPatch,
	now: number,
): void {
	if (patch.description !== undefined) draft.description = patch.description;
	if (patch.outputRef !== undefined) draft.outputRef = outputRefToJson(patch.outputRef);
	if (patch.lastError !== undefined) draft.lastError = errorToJson(patch.lastError);
	if (patch.usage !== undefined) draft.usage = usageToJson(patch.usage);
	if (patch.startedAt !== undefined) draft.startedAt = patch.startedAt;
	if (patch.endedAt !== undefined) draft.endedAt = patch.endedAt;
	if (patch.deliveredAt !== undefined) draft.deliveredAt = patch.deliveredAt;
	if (patch.metadata !== undefined) draft.metadata = jsonRecord({ ...(draft.metadata ?? {}), ...patch.metadata });
	draft.updatedAt = patch.updatedAt ?? now;
}

/** Mirrors the incumbent InMemoryTaskStore query semantics (no extra archiving). */
function matchesQuery(task: BackgroundTask, query: TaskQuery): boolean {
	if (query.taskIds !== undefined && !query.taskIds.includes(task.taskId)) return false;
	if (query.ownerSessionId !== undefined && task.ownerSessionId !== query.ownerSessionId) return false;
	if (query.parentTaskId !== undefined && (task.parentTaskId ?? null) !== query.parentTaskId) return false;
	if (query.kinds !== undefined && !query.kinds.includes(task.kind)) return false;
	if (query.statuses !== undefined && !query.statuses.includes(task.status)) return false;
	if (query.createdAfter !== undefined && task.createdAt < query.createdAfter) return false;
	if (query.createdBefore !== undefined && task.createdAt > query.createdBefore) return false;
	if (query.updatedAfter !== undefined && task.updatedAt < query.updatedAfter) return false;
	if (query.updatedBefore !== undefined && task.updatedAt > query.updatedBefore) return false;
	if (query.undeliveredOnly === true) {
		if (task.endedAt === undefined) return false;
		if (task.deliveredAt !== undefined) return false;
	}
	return true;
}

function getOrderValue(task: BackgroundTask, orderBy: NonNullable<TaskQuery['orderBy']>): number {
	if (orderBy === 'updated_at') return task.updatedAt;
	if (orderBy === 'completed_at') return task.endedAt ?? 0;
	return task.createdAt;
}

function parseCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	const value = Number.parseInt(cursor, 10);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || limit <= 0) return 100;
	return Math.min(Math.floor(limit), 500);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function placeholderMeta(piTaskId: number): BackgroundTaskMetaValue {
	return {
		taskId: `pi:${piTaskId}`,
		piTaskId,
		kind: 'custom',
		ownerSessionId: '',
		createdAt: 0,
		updatedAt: 0,
		events: [],
	};
}

/** Detached copy of a meta draft (drafts never escape the transaction). */
function detachMeta(draft: { -readonly [K in keyof BackgroundTaskMetaValue]: BackgroundTaskMetaValue[K] }): BackgroundTaskMetaValue {
	return {
		...draft,
		events: draft.events.map((event) => ({ ...event })),
		...(draft.metadata !== undefined ? { metadata: { ...draft.metadata } } : {}),
	};
}

/**
 * Product task metadata crosses the product boundary as JSON (wire/protocol
 * types); this named boundary cast keeps the document value `JsonObject`
 * clean without a deep re-validation walk.
 */
function jsonRecord(value: Record<string, unknown>): { readonly [key: string]: JsonValue } {
	return value as { readonly [key: string]: JsonValue };
}

// Port interfaces carry `Record<string, unknown>` payloads, which are NOT
// JsonValue; the document mirrors are. These named converters are the only
// boundary between the two vocabularies (the reverse direction is plain
// structural assignability: JsonValue is assignable to unknown).

function outputRefToJson(value: NonNullable<BackgroundTask['outputRef']>): TaskOutputRefJson {
	return {
		taskId: value.taskId,
		kind: value.kind,
		uri: value.uri,
		...(value.offset !== undefined ? { offset: value.offset } : {}),
		...(value.updatedAt !== undefined ? { updatedAt: value.updatedAt } : {}),
		...(value.metadata !== undefined ? { metadata: jsonRecord(value.metadata) } : {}),
	};
}

function errorToJson(value: NonNullable<BackgroundTask['lastError']>): TaskErrorJson {
	return {
		message: value.message,
		...(value.code !== undefined ? { code: value.code } : {}),
		...(value.details !== undefined ? { details: jsonRecord(value.details) } : {}),
	};
}

function usageToJson(value: NonNullable<BackgroundTask['usage']>): TaskUsageJson {
	return {
		...(value.inputTokens !== undefined ? { inputTokens: value.inputTokens } : {}),
		...(value.outputTokens !== undefined ? { outputTokens: value.outputTokens } : {}),
		...(value.totalTokens !== undefined ? { totalTokens: value.totalTokens } : {}),
		...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}),
		...(value.metadata !== undefined ? { metadata: jsonRecord(value.metadata) } : {}),
	};
}
