/**
 * Wave 1 fix: the runtime→daemon observation of internally activated owner
 * turns (verdict §3.4). A background-task delivery that ACTIVATES a turn on
 * the daemon's own Session runs inside the runtime ingress — no client
 * `submit` opened it, so before this fix the adapter event feed (and with it
 * the daemon's replay ring and `daemon.status`) never saw the wake turn:
 * no `turn_started`, no frames, no terminal, no busy accounting.
 *
 * The fix wires a runtime-level observer at adapter bootstrap (the existing
 * `application.events` lifecycle bus, subscribed BEFORE any delivery can
 * activate) and projects every internally activated owner turn into the
 * adapter event feed through the same push path the client pumps use.
 *
 * Pinned contract (§3.4 + acceptance 9/10/18, minus release mechanics):
 * - identity is (sessionId, turnId); the synthetic requestId is derived from
 *   the turnId deterministically and every event is marked
 *   `origin: 'background-delivery'`;
 * - exactly one started/terminal pair per wake turn — a client turn keeps its
 *   own single pair, and a notification that JOINED an active turn creates no
 *   pair of its own;
 * - the outcome comes from the real runtime terminal: `failed` and `aborted`
 *   are never renamed into `turn_completed`;
 * - `close()` drains in-flight turn pumps and the observer BEFORE ending the
 *   event stream, so the final terminal events are relayed (the push-after-end
 *   guard of `PushableIterable` stays in place — the order around it is what
 *   the old `closeOnce` tore);
 * - `internalTurns()` exposes the live wake turns for the daemon's busy/drain
 *   views (idle restart and the stop drain guard read it through the hub).
 *
 * Harness: the same rig as `local-runtime-adapter.background-delivery.test.ts`
 * (real assembled host, scripted PiTurnRunner, real background-task delivery
 * chain); one file per run, sequential.
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeEventStatus, RuntimeStopReasonType } from '@mavis/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
	CreateLocalRuntimeHostOptions,
	CreatedLocalRuntimeHost,
	LocalRuntimeConfig,
} from '@mavis/local-runtime-v2/process-local';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';

import { closeLocalRuntimeDb } from '../../../packages/local-runtime/src/persistence/db.js';
import type { LocalSessionRecord } from '../../../packages/local-runtime/src/sessions/controller.js';
import {
	SqliteLocalBackgroundTaskStore,
	FsLocalTaskOutputStore,
} from '../../../packages/local-runtime/src/background-task/store.js';
import { LocalBackgroundTaskService } from '../../../packages/local-runtime/src/background-task/service.js';
import { persistLocalSubagentTaskTerminal } from '../../../packages/local-runtime/src/background-task/terminal.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../../../packages/local-runtime/src/api/local-task-host.js';
import { createLocalRuntimeHostV2ForTest } from '../../../packages/local-runtime-v2/src/runtime.js';
import { LocalRuntimeV2Adapter, type LocalRuntimeAdapterEvent } from '../src/local-runtime-adapter.js';

interface ScriptedTurnInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly signal?: AbortSignal;
	readonly eventIdGenerator?: (kind: string) => string;
	readonly runtimeSeqGenerator?: () => number;
	readonly eventWriter: {
		pushRuntime(event: Record<string, unknown>): void | Promise<void>;
	};
}

const harness = vi.hoisted(() => ({
	/** Turn scripts run in order; each pushes its own terminal event. */
	scripts: [] as ((input: ScriptedTurnInput) => Promise<void>)[],
	invocations: 0,
	startedTurns: [] as { sessionId: string; turnId: string }[],
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
	return {
		...actual,
		PiTurnRunner: class {
			async runTurn(input: ScriptedTurnInput): Promise<void> {
				const index = harness.invocations;
				harness.invocations += 1;
				harness.startedTurns.push({ sessionId: input.sessionId, turnId: input.turnId });
				const script = harness.scripts[index];
				if (script) await script(input);
			}
		},
	};
});

function assistantReply(input: ScriptedTurnInput, content: string): Record<string, unknown> {
	return {
		schema: 'archon.runtime.event.v1',
		event_id: input.eventIdGenerator?.('stream-resp') ?? `evt-${input.turnId}-resp`,
		session_id: input.sessionId,
		turn_id: input.turnId,
		runtime_seq: input.runtimeSeqGenerator?.() ?? 2,
		type: 1,
		payload: {
			stream_resp: JSON.stringify({
				type: 2,
				agent_message: {
					msg_id: `msg-${input.turnId}`,
					role: 'assistant',
					msg_content: content,
				},
			}),
		},
	};
}

/**
 * The `session.status running` event the REAL PiTurnRunner emits at the very
 * start of every turn (`emitRunning` in pi-turn-runner/events.ts). The rig
 * scripts MUST push it first: the runtime lifecycle observer publishes the
 * `session.start` GlobalEvent on the first lifecycle-status event, and the
 * daemon observation (turn_started + the frame pump) keys off exactly that.
 * A script that skips it models a turn that never announced itself — which is
 * precisely the pre-fix bug, not a turn shape.
 */
function runningEvent(input: ScriptedTurnInput): Record<string, unknown> {
	return {
		schema: 'archon.runtime.event.v1',
		event_id: input.eventIdGenerator?.('running-status') ?? `evt-${input.turnId}-running`,
		session_id: input.sessionId,
		turn_id: input.turnId,
		runtime_seq: input.runtimeSeqGenerator?.() ?? 1,
		type: 3,
		payload: { status: RuntimeEventStatus.RUNNING },
	};
}

function terminalEvent(
	input: ScriptedTurnInput,
	status: RuntimeEventStatus,
	message: string,
): Record<string, unknown> {
	const stopType =
		status === RuntimeEventStatus.ABORTED
			? RuntimeStopReasonType.ABORT
			: RuntimeStopReasonType.END_TURN;
	return {
		schema: 'archon.runtime.event.v1',
		event_id: input.eventIdGenerator?.('session-status') ?? `evt-${input.turnId}-status`,
		session_id: input.sessionId,
		turn_id: input.turnId,
		runtime_seq: input.runtimeSeqGenerator?.() ?? 100 + status,
		type: 3,
		payload: { status, stop_reason: { type: stopType, message } },
	};
}

function scriptedReply(content: string) {
	return async (input: ScriptedTurnInput): Promise<void> => {
		await input.eventWriter.pushRuntime(runningEvent(input));
		await input.eventWriter.pushRuntime(assistantReply(input, content));
		await input.eventWriter.pushRuntime(
			terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'),
		);
	};
}

let host: CreatedLocalRuntimeHost | undefined;
let adapter: LocalRuntimeV2Adapter | undefined;
let dataDir: string | undefined;
let collected: LocalRuntimeAdapterEvent[] = [];
let collectorDone: Promise<void> = Promise.resolve();
let deliveryHost: LocalTaskRunnerHostWithSessionLookup | undefined;
let hostClosed = false;

const TEST_TIMEOUT_MS = 240_000;

function buildDeliveryHost(
	conversation: unknown,
): LocalTaskRunnerHostWithSessionLookup {
	const service = new LocalBackgroundTaskService({
		store: new SqliteLocalBackgroundTaskStore(dataDir!, () => 31_000),
		outputStore: new FsLocalTaskOutputStore(dataDir!),
		nowMs: () => 31_000,
	});
	return {
		agentResolver: {} as LocalTaskRunnerHostWithSessionLookup['agentResolver'],
		agentRoutes: {
			createSession: async () => {
				throw new Error('task creation is out of scope for this rig');
			},
			listLocalAgents: async () => [],
		},
		runtimeConversation:
			conversation as LocalTaskRunnerHostWithSessionLookup['runtimeConversation'],
		backgroundTaskService: service,
		matrixLogger: { warn: () => undefined, info: () => undefined },
		configGetter: () => ({}) as ReturnType<LocalTaskRunnerHostWithSessionLookup['configGetter']>,
		nowMs: () => 31_000,
		resolveDefaultWorkspaceDir: () => dataDir!,
		getSessionById: async (sessionId: string) => {
			// The runtime conversation's session record IS the LocalSessionRecord
			// shape the delivery policy reads (sessionKind/visibility/purpose).
			const found = await (
				conversation as {
					query: {
						getSession(sessionId: string): Promise<unknown>;
					};
				}
			).query.getSession(sessionId);
			return (found ?? undefined) as LocalSessionRecord | undefined;
		},
	} as LocalTaskRunnerHostWithSessionLookup;
}

async function startRig(): Promise<{ cli: CliService }> {
	dataDir = await mkdtemp(join(tmpdir(), 'mcoded-bg-observe-'));
	await mkdir(join(dataDir, 'workspace'), { recursive: true });
	const config = {
		dataDir,
		defaultModel: 'test/model',
		provider: {
			test: {
				options: { apiKey: 'test-key', baseURL: 'https://provider.test/v1' },
				models: {
					model: { modalities: { input: ['text'], output: ['text'] } },
				},
			},
		},
	} as LocalRuntimeConfig;
	hostClosed = false;
	host = await createLocalRuntimeHostV2ForTest({
		dataDir,
		runtimeOwnerKind: 'cli',
		capabilityProfile: 'cli',
		capabilities: { cliEmbedded: true },
		configGetter: () => config,
	});
	await host.ready;
	const cli = host.cliService as CliService;
	const conversation = (
		host.apiHost as unknown as { runtimeConversation?: unknown }
	).runtimeConversation;
	if (!conversation) throw new Error('the assembled host exposes no runtimeConversation');
	deliveryHost = buildDeliveryHost(conversation);

	adapter = new LocalRuntimeV2Adapter({
		root: dataDir,
		createHost: async () => host!,
		configGetter: () => config,
	});
	collected = [];
	collectorDone = (async () => {
		for await (const event of adapter.events) collected.push(event);
	})();
	await adapter.start();
	return { cli };
}

async function submitOpeningPrompt(): Promise<void> {
	await adapter!.submit({
		kind: 'prompt',
		message: 'the opening owner prompt',
		requestId: 'req-open-1',
	});
}

/**
 * The idle barrier: wait until the runtime has no active turn on the session.
 * Without it a delivery scheduled in the same tick as the parent's terminal
 * may legally JOIN the still-active parent turn (mode 'steered') instead of
 * waking an idle session — the joined case has its own dedicated test.
 */
async function waitSessionIdle(cli: CliService, sessionId: string): Promise<void> {
	await waitFor(
		async () => (await cli.getActiveTurn(sessionId)) === undefined,
		'the session must be fully idle before the delivery',
	);
}

async function finishBackgroundTask(taskId: string, ownerSessionId: string): Promise<void> {
	if (!deliveryHost) throw new Error('delivery host not built');
	await deliveryHost.backgroundTaskService.create({
		taskId,
		ownerSessionId,
		kind: 'subagent',
		status: 'running',
		description: `Task ${taskId}`,
		createdAt: 1_000,
		updatedAt: 1_000,
	});
	await persistLocalSubagentTaskTerminal({
		host: deliveryHost,
		taskId,
		result: { status: 'succeeded', requestedAgentName: 'mavis', finalText: 'child result ready' },
		delivery: 'schedule',
	});
}

function eventsOf<T extends LocalRuntimeAdapterEvent['type']>(type: T) {
	return collected.filter((event): event is Extract<LocalRuntimeAdapterEvent, { type: T }> => {
		return event.type === type;
	});
}

function deliveryEvents<T extends LocalRuntimeAdapterEvent['type']>(type: T) {
	return eventsOf(type).filter(
		(event): event is Extract<LocalRuntimeAdapterEvent, { type: T }> =>
			(event as { origin?: string }).origin === 'background-delivery',
	);
}

async function waitFor(
	probe: () => boolean | Promise<boolean>,
	outline: string,
	timeoutMs = 60_000,
): Promise<void> {
	await vi.waitFor(
		async () => {
			expect(await probe(), outline).toBe(true);
		},
		{ timeout: timeoutMs, interval: 100 },
	);
}

afterEach(async () => {
	if (adapter) {
		await adapter.close().catch(() => undefined);
		hostClosed = true;
		await collectorDone.catch(() => undefined);
	}
	adapter = undefined;
	deliveryHost = undefined;
	if (host && !hostClosed) {
		await host.apiHost.close().catch(() => undefined);
		await host.metricsClient.close().catch(() => undefined);
	}
	host = undefined;
	hostClosed = false;
	if (dataDir) {
		closeLocalRuntimeDb(dataDir);
		await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
	dataDir = undefined;
	collected = [];
	harness.scripts = [];
	harness.invocations = 0;
	harness.startedTurns = [];
});

describe('Wave 1: the daemon observes internally activated owner turns', () => {
	it(
		'an idle wake turn emits exactly one started/terminal pair on the adapter feed (acceptance 9/18)',
		async () => {
			// The wake reply commits a beat AFTER the turn starts, so the
			// observer's frame pump is already attached when it does (a real
			// provider is far slower than the observer's subscription).
			harness.scripts = [
				scriptedReply('parent answer'),
				async (input) => {
					await input.eventWriter.pushRuntime(runningEvent(input));
					// The wake reply commits a beat AFTER the turn starts, so the
					// observer's frame pump is already attached when it does (a real
					// provider is far slower than the observer's subscription).
					await new Promise((resolve) => setTimeout(resolve, 100));
					await input.eventWriter.pushRuntime(assistantReply(input, 'the wake reply'));
					await input.eventWriter.pushRuntime(
						terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'),
					);
				},
			];
			const { cli } = await startRig();
			await submitOpeningPrompt();
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(() => harness.startedTurns.length === 1, 'the parent turn must settle');
			await waitSessionIdle(cli, ownerSessionId);

			await finishBackgroundTask('bg-observe-1', ownerSessionId);
			await waitFor(
				() => deliveryEvents('turn_completed').length > 0,
				'the wake turn must reach a terminal event on the adapter feed',
			);

			// Identity: (sessionId, turnId), not a client requestId. The synthetic
			// requestId is deterministically derived from the turnId.
			const started = deliveryEvents('turn_started');
			expect(started, 'exactly one started event for the wake turn').toHaveLength(1);
			expect(started[0]?.sessionId).toBe(ownerSessionId);
			const wakeTurnId = started[0]?.turnId;
			expect(wakeTurnId, 'the started event carries the runtime turnId').toBeTypeOf('string');
			expect(started[0]?.requestId).toBe(`background-delivery:${wakeTurnId}`);

			const completed = deliveryEvents('turn_completed');
			expect(completed, 'exactly one terminal event for the wake turn').toHaveLength(1);
			expect(completed[0]?.requestId).toBe(`background-delivery:${wakeTurnId}`);
			expect(completed[0]?.sessionId).toBe(ownerSessionId);
			expect(completed[0]?.turnId).toBe(wakeTurnId);
			// The parent turn's own pair stays untouched (single emitter per turn).
			expect(eventsOf('turn_started').filter((event) => event.requestId === 'req-open-1'))
				.toHaveLength(1);
			// The wake turn's frames are relayed too (session frames on the feed).
			expect(
				deliveryEvents('turn_frame').some((event) =>
					(event.frame.dataJson ?? '').includes('the wake reply'),
				),
				'the wake turn\u2019s committed reply appears as a frame',
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'a FAILED wake turn keeps its true outcome (never renamed into turn_completed)',
		async () => {
			harness.scripts = [
				scriptedReply('parent answer'),
				async (input) => {
					await input.eventWriter.pushRuntime(runningEvent(input));
					await input.eventWriter.pushRuntime(
						assistantReply(input, 'partial before the fault'),
					);
					throw new Error('the wake provider exploded');
				},
			];
			const { cli } = await startRig();
			await submitOpeningPrompt();
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(() => harness.startedTurns.length === 1, 'the parent turn must settle');
			await waitSessionIdle(cli, ownerSessionId);

			await finishBackgroundTask('bg-observe-fail', ownerSessionId);
			await waitFor(
				() => deliveryEvents('turn_failed').length > 0,
				'the failed wake turn must surface as turn_failed',
			);

			const failed = deliveryEvents('turn_failed');
			expect(failed).toHaveLength(1);
			expect(failed[0]?.error).toContain('the wake provider exploded');
			expect(failed[0]?.sessionId).toBe(ownerSessionId);
			expect(failed[0]?.turnId).toBeTypeOf('string');
			// A failed turn must not ALSO complete (the [DONE] sentinel alone
			// never proves success).
			expect(deliveryEvents('turn_completed')).toHaveLength(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'an ABORTED wake turn surfaces as turn_aborted (acceptance 18: true aborted outcome)',
		async () => {
			const wakeTurnStarted = new Promise<string>((resolve) => {
				harness.scripts = [
					scriptedReply('parent answer'),
					async (input) => {
						await input.eventWriter.pushRuntime(runningEvent(input));
						await input.eventWriter.pushRuntime(
							assistantReply(input, 'working until aborted'),
						);
						resolve(input.turnId);
						await new Promise<void>((resolveLatch) => {
							if (input.signal?.aborted) {
								resolveLatch();
								return;
							}
							input.signal?.addEventListener('abort', () => resolveLatch(), { once: true });
						});
						await input.eventWriter.pushRuntime(
							terminalEvent(input, RuntimeEventStatus.ABORTED, 'owner aborted the wake'),
						);
					},
				];
			});
			const { cli } = await startRig();
			await submitOpeningPrompt();
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(() => harness.startedTurns.length === 1, 'the parent turn must settle');
			await waitSessionIdle(cli, ownerSessionId);

			await finishBackgroundTask('bg-observe-abort', ownerSessionId);
			// The wake turn started and is latched on its abort signal.
			const wakeTurnId = await vi.waitFor(
				() => {
					const turnId = deliveryEvents('turn_started')[0]?.turnId;
					expect(turnId, 'the wake turn must start (observed)').toBeTypeOf('string');
					return Promise.resolve(turnId as string);
				},
				{ timeout: 60_000, interval: 100 },
			);
			await wakeTurnStarted;

			// The user aborts the session while the wake turn runs.
			await adapter!.abort();
			await waitFor(
				() => deliveryEvents('turn_aborted').length === 1,
				'the aborted wake turn must surface as turn_aborted',
			);
			const aborted = deliveryEvents('turn_aborted');
			expect(aborted[0]?.requestId).toBe(`background-delivery:${wakeTurnId}`);
			// Not renamed: an aborted wake is neither completed nor failed.
			expect(deliveryEvents('turn_completed')).toHaveLength(0);
			expect(deliveryEvents('turn_failed')).toHaveLength(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'a notification that JOINED an active turn creates no pair of its own (single emitter per turn)',
		async () => {
			// The parent turn latches on its abort signal; the delivery steer
			// JOINS it mid-flight.
			harness.scripts = [
				async (input) => {
					await input.eventWriter.pushRuntime(runningEvent(input));
					await input.eventWriter.pushRuntime(assistantReply(input, 'latched parent work'));
					await new Promise<void>((resolveLatch) => {
						if (input.signal?.aborted) {
							resolveLatch();
							return;
						}
						input.signal?.addEventListener('abort', () => resolveLatch(), { once: true });
					});
					await input.eventWriter.pushRuntime(
						terminalEvent(input, RuntimeEventStatus.ABORTED, 'owner aborted the parent'),
					);
				},
			];
			await startRig();
			await adapter!.submit({
				kind: 'prompt',
				message: 'the latched parent prompt',
				requestId: 'req-open-1',
			});
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(
				() => harness.startedTurns.length === 1,
				'the parent turn must be running before the delivery',
			);

			await finishBackgroundTask('bg-join-active', ownerSessionId);
			// Give the scheduler a beat to attempt the delivery (it must have
			// steered INTO the active turn — no new turn may start for it).
			await waitFor(
				() => harness.invocations >= 1 && deliveryEvents('turn_started').length === 0,
				'no new turn may start for a joined notification',
			);

			// End the parent turn: it settles with its OWN single pair.
			await adapter!.abort();
			await waitFor(
				() => eventsOf('turn_completed').some((event) => event.requestId === 'req-open-1'),
				'the parent turn must settle with its own terminal',
			);
			expect(deliveryEvents('turn_started')).toHaveLength(0);
			expect(deliveryEvents('turn_completed')).toHaveLength(0);
			expect(deliveryEvents('turn_failed')).toHaveLength(0);
			expect(deliveryEvents('turn_aborted')).toHaveLength(0);
			// The parent's own pair is exactly one started + one terminal.
			expect(eventsOf('turn_started').filter((event) => event.requestId === 'req-open-1'))
				.toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'close() drains in-flight turn events BEFORE ending the stream (the final terminal is relayed)',
		async () => {
			let releaseParent: (() => void) | undefined;
			const parentGate = new Promise<void>((resolve) => {
				releaseParent = resolve;
			});
			harness.scripts = [
				async (input) => {
					await input.eventWriter.pushRuntime(runningEvent(input));
					await input.eventWriter.pushRuntime(assistantReply(input, 'draining parent work'));
					await parentGate;
					await input.eventWriter.pushRuntime(
						terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'),
					);
				},
			];
			await startRig();
			await adapter!.submit({
				kind: 'prompt',
				message: 'the draining prompt',
				requestId: 'req-drain-1',
			});
			await waitFor(
				() => eventsOf('turn_started').some((event) => event.requestId === 'req-drain-1'),
				'the turn must start before close',
			);

			// close() WITHOUT stop(): the in-flight turn's terminal must still be
			// relayed before the event stream ends (the old end-before-drain order
			// silently dropped it).
			const closing = adapter!.close();
			releaseParent?.();
			await closing;
			await collectorDone;
			expect(
				collected.some(
					(event) => event.type === 'turn_completed' && event.requestId === 'req-drain-1',
				),
				'the in-flight turn\u2019s terminal must be on the feed before the stream ends',
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'internalTurns() reports the live wake turn for the daemon busy/drain views',
		async () => {
			const wakeTurnStarted = new Promise<string>((resolve) => {
				harness.scripts = [
					scriptedReply('parent answer'),
					async (input) => {
						await input.eventWriter.pushRuntime(runningEvent(input));
						await input.eventWriter.pushRuntime(assistantReply(input, 'latched wake work'));
						resolve(input.turnId);
						await new Promise<void>((resolveLatch) => {
							if (input.signal?.aborted) {
								resolveLatch();
								return;
							}
							input.signal?.addEventListener('abort', () => resolveLatch(), { once: true });
						});
						await input.eventWriter.pushRuntime(
							terminalEvent(input, RuntimeEventStatus.ABORTED, 'aborted after the probe'),
						);
					},
				];
			});
			const { cli } = await startRig();
			await submitOpeningPrompt();
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(() => harness.startedTurns.length === 1, 'the parent turn must settle');
			await waitSessionIdle(cli, ownerSessionId);

			expect(adapter!.internalTurns?.() ?? []).toHaveLength(0);
			await finishBackgroundTask('bg-busy-1', ownerSessionId);
			const wakeTurnId = await wakeTurnStarted;
			await waitFor(
				() => (adapter!.internalTurns?.() ?? []).length === 1,
				'the live wake turn must be reported as an internal turn',
			);
			const snapshot = adapter!.internalTurns?.() ?? [];
			expect(snapshot[0]?.sessionId).toBe(ownerSessionId);
			expect(snapshot[0]?.turnId).toBe(wakeTurnId);
			expect(typeof snapshot[0]?.startedAtMs).toBe('number');

			// The turn settles: the busy entry clears.
			await adapter!.abort();
			await waitFor(
				() => (adapter!.internalTurns?.() ?? []).length === 0,
				'the internal turn entry must clear at its terminal',
			);
		},
		TEST_TIMEOUT_MS,
	);
});
