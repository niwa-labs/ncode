/**
 * Wave 0 stand for the reactive-subagents project (verdict §5.1): a scripted
 * host rig with controlled admission/completion barriers over the REAL
 * assembled local-runtime-v2 host, plus the reproduction of the Wave 0
 * targets, kept as separate pinned contracts:
 *
 * 1. Idle model wake through background delivery — the scheduler steers
 *    `<background-task-finished>` into an IDLE owner session through the real
 *    ingress; the runtime ACTIVATES a provider turn (no client, no user
 *    message). Pinned here: the wake turn runs, its reply is committed to the
 *    session history, and the delivery prompt never became a visible user
 *    message. (Verdict §3.2: "Idle: ingress активирует новый owner turn".)
 *
 * 2. The §4.1 input/Stop cause-map rows this level can observe today:
 *    - an owner message on an idle session starts its own turn and does not
 *      consume or suppress a later delivery;
 *    - a semantic user-stop window holds the delivery (no wake) until the
 *      window closes — the "User Stop всей сессии → suppress" row;
 *    - delivery after a NATURALLY ended owner turn still wakes the session —
 *      the "Нормальный конец parent turn → сохраняет delivery" row (test 1).
 *
 * The daemon-observation gap (internally activated turns emit no
 * turn_started/turn_completed on the adapter event feed) is pinned separately
 * in `local-runtime-adapter.background-delivery-observation.test.ts` together
 * with its Wave 1 fix, so the two bugs stay isolated.
 *
 * Harness: the PiTurnRunner is mocked with ordered scripts (the same harness
 * as `turn-done-inventory.e2e.test.ts` / the mcoded adapter smoke test); every
 * other layer is production. Scripts control admission/completion with
 * deferred barriers; each script pushes its own terminal event.
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
import type { ConversationSteerInput } from '@mavis/conversation-contract';

import { closeLocalRuntimeDb } from '../../../packages/local-runtime/src/persistence/db.js';
import type { LocalSessionRecord } from '../../../packages/local-runtime/src/sessions/controller.js';
import {
	SqliteLocalBackgroundTaskStore,
	FsLocalTaskOutputStore,
} from '../../../packages/local-runtime/src/background-task/store.js';
import { LocalBackgroundTaskService } from '../../../packages/local-runtime/src/background-task/service.js';
import { persistLocalSubagentTaskTerminal } from '../../../packages/local-runtime/src/background-task/terminal.js';
import { openUserStopWindow } from '../../../packages/local-runtime/src/background-task/user-stop-suppression.js';
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
	/** Every `ConversationSteerInput` the runtime ingress accepted, in order. */
	steers: [] as unknown[],
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

/** A committed assistant message pushed over the turn's real event writer. */
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

/**
 * The `session.status running` event the REAL PiTurnRunner emits at the very
 * start of every turn (`emitRunning` in pi-turn-runner/events.ts). The rig
 * scripts push it first so the runtime lifecycle observer publishes
 * `session.start` when the turn STARTS — the same shape a production turn
 * has, and the fact the daemon observation keys off.
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

/** Script: running status, one assistant reply, then a natural completed terminal. */
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
/** Background collector over the adapter event stream; ends on `close`. */
let collected: LocalRuntimeAdapterEvent[] = [];
let collectorDone: Promise<void> = Promise.resolve();
let deliveryHost: LocalTaskRunnerHostWithSessionLookup | undefined;
let hostClosed = false;

const TEST_TIMEOUT_MS = 240_000;

/**
 * The background-delivery facade over the assembled host: the REAL runtime
 * conversation (the same ingress the production task runner uses), the REAL
 * session lookup, and a REAL task store/service rooted at the temp dataDir.
 * This is the production delivery chain minus the task-tool UI.
 */
function buildDeliveryHost(
	conversation: unknown,
): LocalTaskRunnerHostWithSessionLookup {
	const service = new LocalBackgroundTaskService({
		store: new SqliteLocalBackgroundTaskStore(dataDir!, () => 31_000),
		outputStore: new FsLocalTaskOutputStore(dataDir!),
		nowMs: () => 31_000,
	});
	return {
		// Only the delivery path is exercised: conversation + session lookup +
		// task store. Agent resolution/routes belong to task CREATION (Wave 2)
		// and stay unused stubs here.
		agentResolver: {} as LocalTaskRunnerHostWithSessionLookup['agentResolver'],
		agentRoutes: {
			createSession: async () => {
				throw new Error('task creation is out of the Wave 0 stand scope');
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

/**
 * Submit the rig's opening owner prompt: the adapter creates its Session on
 * the first admission, and that first turn is the test's parent turn.
 */
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
 * waking an idle session.
 */
async function waitSessionIdle(cli: CliService, sessionId: string): Promise<void> {
	await waitFor(
		async () => (await cli.getActiveTurn(sessionId)) === undefined,
		'the session must be fully idle before the delivery',
	);
}

async function startRig(): Promise<{ cli: CliService }> {
	dataDir = await mkdtemp(join(tmpdir(), 'mcoded-bg-delivery-'));
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
	// ONE host, owned by BOTH the rig and the adapter (the adapter receives it
	// through its `createHost` seam) — two runtime processes on one dataDir
	// would contend over the same sqlite store.
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
	// The SAME conversation instance the production task runner resolves
	// through `requireTaskConversation`.
	const conversation = (
		host.apiHost as unknown as {
			runtimeConversation?: unknown;
		}
	).runtimeConversation;
	if (!conversation) throw new Error('the assembled host exposes no runtimeConversation');
	deliveryHost = buildDeliveryHost(conversation);
	// Tap the real ingress steer so tests can assert admission modes without
	// changing what the runtime executes.
	const ingress = (
		conversation as {
			ingress: { steer(input: ConversationSteerInput): Promise<unknown> };
		}
	).ingress;
	const originalSteer = ingress.steer.bind(ingress);
	ingress.steer = async (input: ConversationSteerInput) => {
		const result = await originalSteer(input);
		harness.steers.push({ input, result });
		return result;
	};

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

/** Terminal for a background child task, then schedule the owner delivery. */
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
	harness.steers = [];
});

describe('Wave 0: idle model wake through background delivery', () => {
	it(
		'a background terminal on an IDLE owner session activates a real provider turn (no client, no user message)',
		async () => {
			void eventsOf;
			harness.scripts = [scriptedReply('the first answer'), scriptedReply('the wake reply')];
			const { cli } = await startRig();
			await submitOpeningPrompt();
			const ownerSessionId = adapter!.currentSessionId!;
			expect(ownerSessionId, 'the first prompt created the owner Session').toBeTypeOf('string');

			// The owner turn ran and ENDED; the session is idle now.
			await waitFor(
				() => harness.startedTurns.length === 1,
				'the owner prompt turn must complete first',
			);
			await waitSessionIdle(cli, ownerSessionId);

			await finishBackgroundTask('bg-wake-1', ownerSessionId);

			// Bug-1 probe: does the delivery ACTIVATE a provider turn on the idle
			// session? The wake turn is script #2 running on the OWNER session.
			await waitFor(
				() =>
					harness.startedTurns.length >= 2 &&
					harness.startedTurns[1]?.sessionId === ownerSessionId,
				'the delivery must activate a new owner turn on the idle session',
			);
			await waitFor(
				() => harness.invocations >= 2,
				'the wake turn must run to completion',
			);

			// The wake went through the delivery ingress, with NO client submit.
			const wakeSteer = harness.steers.find((entry) => {
				const input = (entry as { input: ConversationSteerInput }).input;
				return input.source === 'background-task';
			}) as { input: ConversationSteerInput; result: { mode: string } } | undefined;
			expect(wakeSteer, 'the wake entered through the background-task ingress').toBeDefined();
			expect(
				wakeSteer?.result.mode,
				'the idle session ACTIVATED the wake turn (not queued, not steered)',
			).toBe('activated');
			expect(
				wakeSteer?.input.message.content,
				'the wake prompt is the background-task-finished envelope',
			).toContain('<background-task-finished>');
			expect(
				wakeSteer?.input.message.hideUserMessage,
				'the delivery prompt never becomes a visible user message',
			).toBe(true);

			// The wake reply is committed to the session history — the model ran
			// for real, and its result is readable without any user input.
			const messages = await cli.getMessages({ id: ownerSessionId });
			const committed = JSON.stringify(messages);
			expect(
				committed.includes('the wake reply'),
				'the wake turn\u2019s reply must be committed to the owner history',
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'delivery after a NATURALLY ended owner turn still wakes the session (§4.1 row: normal end keeps delivery)',
		async () => {
			harness.scripts = [scriptedReply('parent answer'), scriptedReply('post-end wake')];
			const { cli } = await startRig();
			await submitOpeningPrompt();
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(() => harness.startedTurns.length === 1, 'the owner turn must end first');
			await waitSessionIdle(cli, ownerSessionId);

			await finishBackgroundTask('bg-wake-2', ownerSessionId);

			await waitFor(
				() =>
					harness.startedTurns.length >= 2 &&
					harness.startedTurns[1]?.sessionId === ownerSessionId,
				'the delivery must survive the parent turn\u2019s normal end and wake the session',
			);
			const messages = await cli.getMessages({ id: ownerSessionId });
			expect(JSON.stringify(messages).includes('post-end wake')).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);
});

describe('Wave 0: §4.1 input/Stop cause map pinned at this level', () => {
	it(
		'an owner message on an idle session starts its own turn and does not consume a later delivery',
		async () => {
			harness.scripts = [
				scriptedReply('first'),
				scriptedReply('answer to the owner'),
				scriptedReply('wake after owner input'),
			];
			const { cli } = await startRig();
			await submitOpeningPrompt();
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(() => harness.startedTurns.length === 1, 'the first turn must settle');

			// Owner input on the idle session: a NEW client turn (not a delivery).
			await adapter!.submit({
				kind: 'prompt',
				message: 'a normal owner message',
				requestId: 'req-owner-2',
			});
			await waitFor(
				() => harness.startedTurns.length === 2,
				'the owner message must start its own turn',
			);
			await waitSessionIdle(cli, ownerSessionId);

			// A later background terminal is NOT lost to the owner input: it still
			// wakes the session (§4.1: "Обычное сообщение владельца → сохраняет
			// delivery").
			await finishBackgroundTask('bg-after-input', ownerSessionId);
			await waitFor(
				() =>
					harness.startedTurns.length >= 3 &&
					harness.startedTurns[2]?.sessionId === ownerSessionId,
				'the delivery after owner input must still wake the session',
			);
			const messages = await cli.getMessages({ id: ownerSessionId });
			expect(JSON.stringify(messages).includes('wake after owner input')).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'a semantic user-stop window HOLDS the delivery: no wake while the window is open (§4.1 row: user stop suppresses wake)',
		async () => {
			harness.scripts = [scriptedReply('first'), scriptedReply('must not run while stopped')];
			const { cli } = await startRig();
			await submitOpeningPrompt();
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(() => harness.startedTurns.length === 1, 'the first turn must settle');
			await waitSessionIdle(cli, ownerSessionId);

			// Semantic user Stop: the cascade opens the suppression window.
			const stopHandle = openUserStopWindow(deliveryHost!, ownerSessionId, 31_000);
			await finishBackgroundTask('bg-during-stop', ownerSessionId);

			// The stop window keeps collecting targets: the delivery is held as
			// busy (retryable), NOT delivered — no wake turn may start.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			expect(
				harness.startedTurns.length,
				'no wake turn may start while the user-stop window is open',
			).toBe(1);

			// The window closes (cascade finished): the held delivery proceeds.
			stopHandle.close('completed');
			await waitFor(
				() =>
					harness.startedTurns.length >= 2 &&
					harness.startedTurns[1]?.sessionId === ownerSessionId,
				'the delivery must wake the session once the stop window closed',
			);
		},
		TEST_TIMEOUT_MS,
	);
});
