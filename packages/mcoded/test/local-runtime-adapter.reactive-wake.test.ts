/**
 * Wave 4 (verdict 09 §5.4 №18): the daemon surface contract for a REACTIVE
 * wake — the wake Turn that follows a released foreground task (native
 * binding, promoted row) projects into the adapter feed exactly like any
 * runtime-internal activation:
 *
 * - exactly ONE started/terminal pair per wake Turn, identity
 *   `(sessionId, turnId)`, synthetic requestId `background-delivery:<turnId>`,
 *   every event marked `origin: 'background-delivery'`;
 * - the outcome comes from the real runtime terminal (completed here; failed
 *   and aborted are pinned in the wave-1 observation file);
 * - `close()` while the wake Turn is still in flight drains its frames and
 *   terminal BEFORE ending the event stream — stop/drain never tears the
 *   terminal frames off a reactive wake (the drain-before-end order).
 *
 * The late-client replay and the idle-restart hold are hub-level contracts,
 * already pinned for internal turns in `hub.internal-turns.test.ts`; this file
 * pins the reactive-flavored wake on the adapter itself.
 *
 * Harness: the wave-1 observation rig extended with the real task tool —
 * the parent turn parks on a foreground Task, an owner steer releases it, the
 * child keeps its identity and its terminal wakes the owner.
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeEventStatus, RuntimeStopReasonType } from '@mavis/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
	CreatedLocalRuntimeHost,
	LocalRuntimeConfig,
} from '@mavis/local-runtime-v2/process-local';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';
import type { ConversationSteerInput } from '@mavis/conversation-contract';
import type { LocalRuntimeToolContext } from '@mavis/agent-tools/desktop';
import type { ToolResult } from '@mavis/agent-core/tools';

import { closeLocalRuntimeDb } from '../../../packages/local-runtime/src/persistence/db.js';
import { createLocalRuntimeHostV2ForTest } from '../../../packages/local-runtime-v2/src/runtime.js';
import { LocalRuntimeV2Adapter, type LocalRuntimeAdapterEvent } from '../src/local-runtime-adapter.js';

interface ScriptedTurnInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly signal?: AbortSignal;
	readonly eventIdGenerator?: (kind: string) => string;
	readonly runtimeSeqGenerator?: () => number;
	readonly hooks?: {
		readonly onHistoryChangedHook?:
			| readonly ((input: {
					sessionId: string;
					turnId: string;
					reason: 'messageDelta' | 'replaceMessages';
					messages: readonly unknown[];
			  }) => Promise<void> | void)[]
			| undefined;
	};
	readonly eventWriter: {
		pushRuntime(event: Record<string, unknown>): void | Promise<void>;
	};
	readonly toolConfig: {
		readonly context: unknown;
		readonly tools?: readonly {
			readonly def: { readonly name: string };
			readonly impl: {
				execute(
					context: unknown,
					input: Record<string, unknown>,
					signal?: AbortSignal,
				): Promise<ToolResult>;
			};
		}[];
	};
}

const harness = vi.hoisted(() => ({
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
				if (!input.signal?.aborted) {
					await input.eventWriter.pushRuntime(
						terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'),
					);
				}
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

/** The first lifecycle event publishes `session.start` — every script pushes it first. */
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

function assistantToolCallDelta(callId: string): Record<string, unknown> {
	return {
		role: 'assistant',
		provider: 'test',
		api: 'openai-completions',
		model: 'model',
		content: [
			{
				type: 'toolCall',
				id: callId,
				name: 'task',
				arguments: { agent_name: 'worker', description: 'Wake child', prompt: 'work until released' },
			},
		],
		timestamp: 1_700_000_000_000,
	};
}

function assistantReplyDelta(text: string, timestamp = 1_700_000_000_002): Record<string, unknown> {
	return {
		role: 'assistant',
		provider: 'test',
		api: 'openai-completions',
		model: 'model',
		content: text,
		timestamp,
	};
}

function toolResultDelta(callId: string, text: string): Record<string, unknown> {
	return {
		role: 'toolResult',
		toolCallId: callId,
		toolName: 'task',
		content: [{ type: 'text', text }],
		timestamp: 1_700_000_000_001,
	};
}

async function deliverDelta(
	input: ScriptedTurnInput,
	messages: readonly unknown[],
): Promise<void> {
	const hook = input.hooks?.onHistoryChangedHook?.[0];
	if (!hook) throw new Error('the assembled host must expose the history delivery hook');
	await hook({
		sessionId: input.sessionId,
		turnId: input.turnId,
		reason: 'messageDelta',
		messages: [...messages],
	});
}

let host: CreatedLocalRuntimeHost | undefined;
let adapter: LocalRuntimeV2Adapter | undefined;
let dataDir: string | undefined;
let collected: LocalRuntimeAdapterEvent[] = [];
let collectorDone: Promise<void> = Promise.resolve();
let hostClosed = false;
/** Any latch a failed test may leave held — released before the rig closes. */
const forceRelease: Array<() => void> = [];

const TEST_TIMEOUT_MS = 240_000;

async function startRig(): Promise<{
	cli: CliService;
	conversation: NonNullable<CreatedLocalRuntimeHost['apiHost']['runtimeConversation']>;
}> {
	dataDir = await mkdtemp(join(tmpdir(), 'mcoded-reactive-wake-'));
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
		ownsSystemLog: true,
		capabilityProfile: 'cli',
		capabilities: { cliEmbedded: true },
		configGetter: () => config,
		defaultWorkspaceDir: join(dataDir, 'workspace'),
		fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
	});
	const cli = host.cliService as CliService;
	const conversation = host.apiHost.runtimeConversation!;
	if (!conversation) throw new Error('the assembled host exposes no runtimeConversation');
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
	return { cli, conversation };
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

async function closeRig(): Promise<void> {
	for (const release of forceRelease.splice(0)) release();
	if (adapter) {
		await adapter.close().catch(() => undefined);
		hostClosed = true;
		await collectorDone.catch(() => undefined);
	}
	adapter = undefined;
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
}

afterEach(async () => {
	await closeRig();
});

describe('Wave 4: the daemon surface of a reactive wake (§5.4 №18)', () => {
	it(
		'the wake after a released foreground task emits exactly one pair, and close() mid-wake still relays its terminal',
		async () => {
			const childLatch = deferred();
			const parentToolReturned = deferred();
			const wakeStarted = deferred<string>();
			let releaseWake: (() => void) | undefined;
			const wakeGate = new Promise<void>((resolve) => {
				releaseWake = resolve;
				forceRelease.push(resolve);
			});
			forceRelease.push(() => childLatch.resolve());
			forceRelease.push(() => parentToolReturned.resolve());
			let noteText = '';

			harness.scripts = [
				// The opening client prompt parks on a foreground Task tool call.
				async (input) => {
					await deliverDelta(input, [assistantToolCallDelta('call_reactive_wake')]);
					const taskTool = input.toolConfig.tools?.find(
						(candidate) => candidate.def.name === 'task',
					);
					if (!taskTool) throw new Error('Production Turn omitted the task tool');
					const context = {
						...(input.toolConfig.context as LocalRuntimeToolContext),
						toolCallId: 'call_reactive_wake',
					};
					const result = await taskTool.impl.execute(
						context,
						{ agent_name: 'worker', description: 'Wake child', prompt: 'work until released' },
						input.signal,
					);
					noteText = result.text ?? '';
					await deliverDelta(input, [toolResultDelta('call_reactive_wake', noteText)]);
					await deliverDelta(input, [assistantReplyDelta('released the task')]);
					parentToolReturned.resolve();
				},
				// The child, parked until the test releases it after the parent settled.
				async (input) => {
					await childLatch.promise;
					await input.eventWriter.pushRuntime(assistantReply(input, 'child finished later'));
				},
				// The reactive wake: the delivery ACTIVATION must announce itself
				// (the first lifecycle event publishes session.start — wave-1
				// finding) and stays in flight while close() is called.
				async (input) => {
					await input.eventWriter.pushRuntime(runningEvent(input));
					await input.eventWriter.pushRuntime(assistantReply(input, 'the wake answer'));
					wakeStarted.resolve(input.turnId);
					await wakeGate;
				},
			];

			const { cli, conversation } = await startRig();

			await adapter!.submit({
				kind: 'prompt',
				message: 'run the reactive task',
				requestId: 'req-reactive-open',
			});
			const ownerSessionId = adapter!.currentSessionId!;
			await waitFor(
				() => harness.startedTurns.length >= 2,
				'the child turn must start',
			);

			// The owner message releases the parked foreground wait (the durable
			// release pass), the parent returns the §2.2 note.
			const steer = await conversation.ingress.steer({
				sessionId: ownerSessionId,
				source: 'api',
				producerId: 'composer-steer',
				idempotencyKey: 'steer-reactive-wake-release',
				message: { content: 'release the task', attachments: [] },
			});
			expect(steer.mode).toBe('steered');
			await parentToolReturned.promise;
			expect(noteText).toContain('<task_background');
			expect(noteText).toContain('reason="owner_input"');

			// The promoted row keeps its child identity.
			const rows = await host!.apiHost.backgroundTaskService.list({
				ownerSessionId,
				limit: 50,
			});
			const row = rows.items.find((task) => task.kind === 'subagent');
			expect(row?.metadata?.['executionMode']).toBe('background');
			expect(row?.status).toBe('running');

			// The child finishes; the owner session is idle again, so the terminal
			// ACTIVATES the reactive wake Turn.
			let idle = false;
			while (!idle) {
				idle = (await cli.getActiveTurn(ownerSessionId)) === undefined;
				if (!idle) await new Promise((resolve) => setTimeout(resolve, 100));
			}
			childLatch.resolve();
			const wakeTurnId = await wakeStarted.promise;

			// The wake Turn is on the daemon feed as ONE runtime-internal pair…
			await waitFor(
				() => deliveryEvents('turn_started').length === 1,
				'exactly one delivery-origin started event',
			);
			const started = deliveryEvents('turn_started')[0]!;
			expect(started.sessionId).toBe(ownerSessionId);
			expect(started.requestId).toBe(`background-delivery:${wakeTurnId}`);

			// …and close() while it is in flight must STILL relay its terminal
			// (drain-before-end), never tear the frames off the reactive wake.
			// Whichever TRUE outcome wins the race — the scripted completion, or
			// the runtime's graceful shutdown stopping the in-flight wake — the
			// feed carries exactly one real terminal, never a torn stream and
			// never a fabricated success.
			const closing = adapter!.close();
			releaseWake?.();
			await closing;
			await collectorDone;
			const outcomes = [
				...deliveryEvents('turn_completed'),
				...deliveryEvents('turn_aborted'),
				...deliveryEvents('turn_failed'),
			];
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]!.requestId).toBe(`background-delivery:${wakeTurnId}`);
			// The joined release notification created no pair of its own.
			expect(eventsOf('turn_started')).toHaveLength(2);
			expect(
				eventsOf('turn_started').filter((event) => event.requestId === 'req-reactive-open'),
			).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);
});

function deferred<T = void>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
