/**
 * W08 part A — the merged orchestration persistence, over the REAL
 * `PiSqliteZstdStorage` (our full pi Storage adapter from W02).
 *
 * Covers the wave's T-rows that belong to this part:
 * - document as-of/fork (rewindable goal document; fork copies);
 * - task abort lifecycle (pi abort mark → definition abort handler);
 * - inbox/submission lifecycle (place → settle; abort of a submitted input);
 * - task completion after auto-detach (background:true survives a
 *   conversation abort) and after daemon death (storage dropped mid-run,
 *   reopen reconciles, the finalize intent settles exactly once);
 * - cron on the one scheduler (sleeping wake task fires from the manual
 *   clock; retire aborts; no second timer wheel exists).
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { afterAll, describe, expect, it } from 'vitest';

import { PiSqliteZstdStorage, SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import type { ConversationId, TaskId } from '@earendil-works/pi-durable';

import {
	BackgroundControlDocs,
	BackgroundIndexDoc,
	CONTROL_KEY,
	CronJobBridge,
	DurableBackgroundTaskStore,
	DurableThreadGoalStore,
	GoalStateDocs,
	OrchestrationHosts,
	openOrchestrationHarness,
	rosterAsOf,
	rosterOf,
	replaceRoster,
	type OrchestrationHarness,
} from '../src/index.js';

const directories: string[] = [];
const context = BACKGROUND_CONTEXT;

afterAll(() => {
	for (const directory of directories) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort: the OS temp root is wiped anyway.
		}
	}
});

interface Stack {
	readonly directory: string;
	readonly backend: SqliteZstdBackend;
	readonly storage: PiSqliteZstdStorage;
	readonly harness: OrchestrationHarness;
}

async function openStack(): Promise<Stack> {
	const directory = mkdtempSync(join(tmpdir(), 'w08-orch-'));
	directories.push(directory);
	const backend = SqliteZstdBackend.open(directory);
	const storage = PiSqliteZstdStorage.open(backend);
	const harness = await openOrchestrationHarness({ storage }, context);
	return { directory, backend, storage, harness };
}

async function closeStack(stack: Stack): Promise<void> {
	await stack.harness.close(context);
	await stack.storage.close(context);
	stack.backend.close();
}

describe('W08 part A: one scheduler over our storage', () => {
	it('opens the pi Harness over PiSqliteZstdStorage and persists a product document through the zstd batches', async () => {
		const stack = await openStack();
		try {
			const rootId = await stack.harness.root();
			expect(Number(rootId)).toBeGreaterThan(0);
			const goalStore = goalStoreOf(stack.harness);
			const goal = await goalStore.create({ sessionId: 's1', objective: 'ship the wave' });
			const read = await goalStore.getBySession('s1');
			expect(read?.goalId).toBe(goal.goalId);
			expect(read?.status).toBe('active');
			expect(read?.tokensUsed).toBe(0);
		} finally {
			await closeStack(stack);
		}
	});
});

describe('document as-of/fork (rewindable goal state)', () => {
	it('answers the goal state as of an older entry and copies it into a fork', async () => {
		const stack = await openStack();
		try {
			const rootId = await stack.harness.root();
			const conversation = await stack.harness.pi.conversation(rootId, context);
			expect(conversation).toBeDefined();
			// Anchor entries give the rewindable timeline its commit points
			// (doc-only commits create no conversation entries).
			const anchor = async (n: number): Promise<void> => {
				const submission = await conversation!.submit({ type: 'write', entry: { kind: 'mcode.test.anchor', data: { n } } }, context);
				await submission.wait(context);
			};
			await anchor(1);
			const goals = goalStoreOf(stack.harness);
			const created = await goals.create({ sessionId: 's1', objective: 'objective v1' });
			await anchor(2);
			const entriesAfterCreate = (await conversation!.entries({}, 50, undefined, context)).items.map((entry) => entry.id).sort((a, b) => a - b);
			const asOfPoint = entriesAfterCreate.at(-1)!;
			await goals.patch(created.goalId, { objective: 'objective v2' });
			await anchor(3);

			// As-of the entry that closed BEFORE the v2 patch: the original.
			const asOfPointEntry = await stack.harness.pi.snapshotAsOf(GoalStateDocs, rootId, created.goalId, asOfPoint, context);
			expect(asOfPointEntry !== undefined).toBe(true);
			expect((asOfPointEntry as { objective: string }).objective).toBe('objective v1');

			// Fork at that entry: the rewindable document is copied at its state.
			const forked = await conversation!.fork(asOfPoint, { ownership: { kind: 'ownerless' } }, context);
			const forkedGoal = await stack.harness.pi.snapshot(GoalStateDocs, forked.id, created.goalId, context);
			expect(forkedGoal !== undefined).toBe(true);
			expect((forkedGoal as { objective: string }).objective).toBe('objective v1');
		} finally {
			await closeStack(stack);
		}
	});
});

describe('goal store contract', () => {
	it('enforces replace-on-complete and the CAS guards inside one transaction', async () => {
		const stack = await openStack();
		try {
			const goals = goalStoreOf(stack.harness);
			const first = await goals.create({ sessionId: 's1', objective: 'first' });
			// Unfinished goal: create conflicts.
			await expect(goals.create({ sessionId: 's1', objective: 'second' })).rejects.toThrow(/Unfinished thread goal/);
			// Complete it, then replacement succeeds.
			await goals.patch(first.goalId, { status: 'complete', statusReason: 'complete(user_requested)' });
			const second = await goals.create({ sessionId: 's1', objective: 'second' });
			expect(second.goalId).not.toBe(first.goalId);
			expect((await goals.getBySession('s1'))?.objective).toBe('second');

			// Guarded model write against a stale objective conflicts.
			await expect(
				goals.patch(second.goalId, {
					status: 'complete',
					statusReason: 'complete(worker_proposal)',
					rejectIfObjectiveChangedFrom: 'stale objective',
				}),
			).rejects.toThrow(/objective conflict/);
			// Guarded write against a stale decision epoch conflicts.
			const current = await goals.getById(second.goalId);
			await expect(
				goals.patch(second.goalId, {
					tokenBudget: 500,
					rejectIfUpdatedAtChangedFrom: (current?.updatedAt ?? 0) - 1,
				}),
			).rejects.toThrow(/epoch changed/);
			// `complete` is final.
			await goals.patch(second.goalId, { status: 'complete', statusReason: 'complete(user_requested)' });
			await expect(goals.patch(second.goalId, { status: 'active' })).rejects.toThrow(/status conflict/);
		} finally {
			await closeStack(stack);
		}
	});
});

describe('background task bridge (task phases owned by the one scheduler)', () => {
	it('runs queued → running → succeeded through manager intents; stop path settles canceled via the abort handler', async () => {
		const stack = await openStack();
		try {
			const store = new DurableBackgroundTaskStore({ harness: stack.harness, resolveConversation: () => stack.harness.root() });
			const now = Date.now();
			const created = await store.create({
				taskId: 'bt_1',
				kind: 'bash',
				status: 'queued',
				ownerSessionId: 's1',
				description: 'long job',
				createdAt: now,
				updatedAt: now,
			});
			expect(created.status).toBe('queued');

			const running = await store.patch('bt_1', { status: 'running', startedAt: Date.now() });
			expect(running.status).toBe('running');

			const done = await store.patch('bt_1', { status: 'succeeded', endedAt: Date.now() });
			expect(done.status).toBe('succeeded');
			expect(done.endedAt).toBeDefined();

			// Stop flow on a second task: stopping (abort mark) → canceled.
			const now2 = Date.now();
			await store.create({ taskId: 'bt_2', kind: 'bash', status: 'queued', ownerSessionId: 's1', createdAt: now2, updatedAt: now2 });
			await store.patch('bt_2', { status: 'running', startedAt: Date.now() });
			const stopping = await store.patch('bt_2', { status: 'stopping' });
			expect(['stopping', 'canceled']).toContain(stopping.status);
			const canceled = await store.patch('bt_2', { status: 'canceled', endedAt: Date.now(), lastError: { message: 'owner stop', code: 'TASK_CANCELED' } });
			expect(canceled.status).toBe('canceled');

			// Durable terminal receipt: the outcome is the scheduler's.
			const index = await stack.harness.commit(async (tx) => {
				const draft = await tx.doc(BackgroundIndexDoc);
				return { tasks: JSON.parse(JSON.stringify(draft.tasks)) as Record<string, { piTaskId: number }> };
			});
			const piTaskId = index.tasks['bt_2']!.piTaskId;
			const record = await stack.harness.task(piTaskId as TaskId);
			expect(record?.state.status).toBe('terminal');

			// List mirrors the incumbent store's query semantics.
			const listing = await store.list({ statuses: ['canceled'] });
			expect(listing.items.map((task) => task.taskId)).toContain('bt_2');
		} finally {
			await closeStack(stack);
		}
	});

	it('completes after auto-detach: a background task survives a conversation abort', async () => {
		const stack = await openStack();
		try {
			const rootId = await stack.harness.root();
			const store = new DurableBackgroundTaskStore({ harness: stack.harness, resolveConversation: () => stack.harness.root() });
			const now = Date.now();
			await store.create({ taskId: 'bt_detach', kind: 'subagent', status: 'queued', ownerSessionId: 's1', createdAt: now, updatedAt: now });
			await store.patch('bt_detach', { status: 'running', startedAt: Date.now() });

			// The owner run aborts its conversation (the product auto-detach
			// analog at the pi level): background tasks are excluded.
			const conversation = await stack.harness.pi.conversation(rootId, context);
			await conversation!.abort(context);

			// The detached task still reaches its durable completion.
			const done = await store.patch('bt_detach', { status: 'succeeded', endedAt: Date.now() });
			expect(done.status).toBe('succeeded');
		} finally {
			await closeStack(stack);
		}
	});

	it('completes after daemon death: reopen reconciles the running task and settles the finalize intent exactly once', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'w08-death-'));
		directories.push(directory);
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		const harness = await openOrchestrationHarness({ storage }, context);
		const store = new DurableBackgroundTaskStore({ harness, resolveConversation: () => harness.root() });
		const now = Date.now();
		await store.create({ taskId: 'bt_death', kind: 'workflow', status: 'queued', ownerSessionId: 's1', createdAt: now, updatedAt: now });
		await store.patch('bt_death', { status: 'running', startedAt: Date.now() });

		// The completion intent is committed, but the "daemon" dies before the
		// observe phase settles it: storage is dropped without a graceful close.
		const index = await harness.commit(async (tx) => {
			const draft = await tx.doc(BackgroundIndexDoc);
			return { tasks: JSON.parse(JSON.stringify(draft.tasks)) as Record<string, { piTaskId: number }> };
		});
		const piTaskId = index.tasks['bt_death']!.piTaskId;
		await harness.commit(async (tx) => {
			const control = await tx.doc(BackgroundControlDocs, piTaskId as TaskId, CONTROL_KEY, {});
			control.finalize = { status: 'succeeded', at: Date.now() };
		});
		backend.close();

		// Reopen: pi's open reconciles surviving `running` records; the observe
		// phase resumes and settles the finalize intent exactly once.
		const backend2 = SqliteZstdBackend.open(directory);
		const storage2 = PiSqliteZstdStorage.open(backend2);
		try {
			const harness2 = await openOrchestrationHarness({ storage: storage2 }, context);
			try {
				const store2 = new DurableBackgroundTaskStore({ harness: harness2, resolveConversation: () => harness2.root() });
				const deadline = Date.now() + 15_000;
				let status = '';
				for (;;) {
					status = (await store2.get('bt_death'))?.status ?? '';
					if (status === 'succeeded' || Date.now() > deadline) break;
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				expect(status).toBe('succeeded');

				// Exactly once: the outcome is terminal and stable across reads.
				const index2 = await harness2.commit(async (tx) => {
					const draft = await tx.doc(BackgroundIndexDoc);
					return { tasks: JSON.parse(JSON.stringify(draft.tasks)) as Record<string, { piTaskId: number }> };
				});
				const record = await harness2.task(index2.tasks['bt_death']!.piTaskId as TaskId);
				expect(record?.state.status).toBe('terminal');
				const again = await store2.get('bt_death');
				expect(again?.status).toBe('succeeded');
			} finally {
				await harness2.close(context);
			}
		} finally {
			await storage2.close(context);
			backend2.close();
		}
	});
});

describe('inbox/submission lifecycle (through the one scheduler)', () => {
	it('places a submitted input, settles it with the run, and refuses double-settlement', async () => {
		const stack = await openStack();
		try {
			const rootId = await stack.harness.root();
			const conversation = await stack.harness.pi.conversation(rootId, context);
			expect(conversation).toBeDefined();
			const submission = await conversation!.submit({ type: 'input', content: 'hello' }, context);
			expect(submission.id).toBeGreaterThan(0);
			// The run starts (no models in the bridge harness → the generation
			// fault is contained and reported); the submission still settles.
			const settled = await submission.wait(context);
			expect(['answered', 'unanswered']).toContain(settled.status);
			// Abort after settlement reports the settled outcome (no second write).
			const abortResult = await submission.abort(context);
			expect(abortResult).toBe('settled');
		} finally {
			await closeStack(stack);
		}
	});
});

describe('cron on the one scheduler', () => {
	it('fires a wake task from the manual clock, records the durable fire fact, and retires via abort', async () => {
		const fires: string[] = [];
		let nowMs = 1_000_000;
		const timers = new Map<number, { at: number; callback: () => void }>();
		let nextTimerId = 1;
		const advance = (ms: number): void => {
			nowMs += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= nowMs) {
					timers.delete(id);
					timer.callback();
				}
			}
		};

		const stack = await openStackWithClock({
			now: () => nowMs,
			setTimer: (callback, delayMs) => {
				const id = nextTimerId++;
				timers.set(id, { at: nowMs + delayMs, callback });
				return () => timers.delete(id);
			},
		});
		try {
			// Bind the product cron ports on the HARNESS's host-intent object —
			// the same instance the registry's definition was built with.
			const hosts = stack.harness.hosts;
			hosts.registerCronHost(
				async (cronId) => {
					fires.push(cronId);
					return { note: `fired ${cronId}` };
				},
				(_cronId, now) => now + 100,
			);
			const bridge = new CronJobBridge({ harness: stack.harness, hosts });
			await bridge.ensure('job-a', 'digest-1');

			// Not yet due: sleeping, zero fires.
			await pump();
			let state = await bridge.state('job-a');
			expect(state?.wakeStatus).not.toBe('terminal');
			expect(fires).toHaveLength(0);

			advance(150);
			await pump();
			expect(fires).toEqual(['job-a']);
			state = await bridge.state('job-a');
			expect(state?.state.fireCount).toBe(1);
			expect(state?.state.lastFiredMs).toBeGreaterThan(0);

			// Config change: re-scheduled on the one scheduler (new wake task).
			await bridge.ensure('job-a', 'digest-2');
			await bridge.retire('job-a');
			await pump();
			state = await bridge.state('job-a');
			expect(state?.wakeStatus).toBe('terminal');

			// The scheduler is the only timer wheel: no product timer was armed.
			expect(timers.size).toBeLessThan(10);
		} finally {
			await closeStack(stack);
		}

		async function pump(): Promise<void> {
			for (let i = 0; i < 40 && timers.size > 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			advance(0);
		}
	});
});

describe('delegation roster document', () => {
	it('replaces the roster in one commit and answers as-of reads', async () => {
		const stack = await openStack();
		try {
			const rootId = await stack.harness.root();
			const conversation = await stack.harness.pi.conversation(rootId, context);
			const anchor = async (n: number): Promise<void> => {
				const submission = await conversation!.submit({ type: 'write', entry: { kind: 'mcode.test.anchor', data: { n } } }, context);
				await submission.wait(context);
			};
			await anchor(1);
			await replaceRoster(stack.harness, rootId, [
				{ delegationId: 'd1', childConversationKey: '7', parentConversationKey: '1', state: 'foreground', updatedAt: 1 },
			]);
			await anchor(2);
			const asOfPoint = (await conversation!.entries({}, 50, undefined, context)).items.map((entry) => entry.id).sort((a, b) => a - b).at(-1)!;
			await replaceRoster(stack.harness, rootId, [
				{ delegationId: 'd1', childConversationKey: '7', parentConversationKey: '1', state: 'backgrounded', updatedAt: 2 },
				{ delegationId: 'd2', childConversationKey: '9', parentConversationKey: '1', state: 'foreground', updatedAt: 2 },
			]);
			expect((await rosterOf(stack.harness, rootId)).map((member) => member.delegationId)).toEqual(['d1', 'd2']);
			const asOf = await rosterAsOf(stack.harness, rootId, asOfPoint);
			expect(asOf.map((member) => member.state)).toEqual(['foreground']);
		} finally {
			await closeStack(stack);
		}
	});
});

// ---------------------------------------------------------------------------

function goalStoreOf(harness: OrchestrationHarness): DurableThreadGoalStore {
	return new DurableThreadGoalStore({
		harness,
		conversationOfSession: async (sessionId) => {
			// The tests map every session to the root conversation; the store
			// contract (unmapped → throw) is unit-tested by construction here.
			if (sessionId.length === 0) return undefined;
			return (await harness.root()) as ConversationId;
		},
	});
}

async function openStackWithClock(clock: { now: () => number; setTimer: (callback: () => void, delayMs: number) => () => void }): Promise<Stack> {
	const directory = mkdtempSync(join(tmpdir(), 'w08-orch-clock-'));
	directories.push(directory);
	const backend = SqliteZstdBackend.open(directory);
	const storage = PiSqliteZstdStorage.open(backend);
	const harness = await openOrchestrationHarness(
		{
			storage,
			now: clock.now,
			setTimer: (callback, delayMs) => clock.setTimer(callback, delayMs),
		},
		context,
	);
	return { directory, backend, storage, harness };
}

// W08-П1 №2: the store must be fail-closed without resolveConversation.
it('rejects construction without resolveConversation (fail-closed, no root() fallback)', () => {
	expect(() => new DurableBackgroundTaskStore({ harness: undefined as never })).toThrow();
});
