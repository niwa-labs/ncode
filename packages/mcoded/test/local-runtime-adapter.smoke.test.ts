/**
 * Smoke coverage for the production RuntimeAdapter: the real
 * {@link LocalRuntimeV2Adapter} driven against a real local-runtime-v2 host
 * on a temporary durable root. The Pi runner is mocked (each Turn is a
 * deterministic script) — every other layer is production, exactly like the
 * host integration suite in local-runtime-v2. The daemon socket layer is not
 * under test here (daemon-lifecycle.test.ts covers it with the echo stub);
 * these tests pin the adapter-side conversation mapping:
 * prompt → real turn frames → terminal event, follow_up → queued input,
 * abort → runtime abort of the active turn.
 *
 * A second block drives the adapter against a full MOCK host
 * (`createHost` override) to pin the terminal-event contract of the frame
 * relay itself: the delivery layer ends EVERY stream with the `"[DONE]"`
 * sentinel, so the last `session_status` frame carries the outcome — a
 * terminal `session_status "error"` must surface as an explicit
 * `turn_failed` event (round-2 finding: it used to be masked as
 * `turn_completed`), while finished/aborted/no-status streams keep the
 * historical `turn_completed`.
 *
 * A third block pins the auth inheritance: with `auth` options the adapter
 * builds the profile session through the `createAuthSession` seam, syncs its
 * lease before the host boots, hands `authContextGetter`/
 * `authContextInvalidator` to the host verbatim and disposes the session on
 * close; a signed-out session (factory → `undefined`) and the auth-less
 * legacy construction stay hook-free. The rejected-managed-bearer case drives
 * the runtime-side 401 recovery through that wiring: the invalidator fires
 * with the rejected token/epoch, the lease is re-requested, and the terminal
 * 401 error still surfaces as `turn_failed`.
 *
 * A fourth block pins command ordering for pipelined frames: an `abort` that
 * arrives right behind a `prompt` must queue behind the prompt's admission
 * and reach the runtime (`abortSession` on the created Session) instead of
 * no-op'ing against a half-booted runtime.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
	CreateLocalRuntimeHostOptions,
	CreatedLocalRuntimeHost,
	LocalRuntimeAuthContext,
	LocalRuntimeConfig,
} from '@mavis/local-runtime-v2/process-local';
import type { CliService, SessionStreamFrameView } from '@mavis/local-runtime-v2/cli-service';

import {
	DEFAULT_MCODED_AGENT_NAME,
	LocalRuntimeV2Adapter,
	type LocalRuntimeAdapterAuthOptions,
	type LocalRuntimeAdapterAuthSession,
	type LocalRuntimeAdapterEvent,
	type LocalRuntimeAdapterOptions,
} from '../src/local-runtime-adapter.js';
import { createLocalRuntimeHostV2ForTest } from '../../../packages/local-runtime-v2/src/runtime.js';
import { closeLocalRuntimeDb } from '../../../packages/local-runtime/src/persistence/db.js';

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
	/** Turn scripts run in order; a missing script just completes the Turn. */
	scripts: [] as ((input: ScriptedTurnInput) => Promise<void>)[],
	invocations: 0,
	seq: 0,
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
	return {
		...actual,
		PiTurnRunner: class {
			async runTurn(input: ScriptedTurnInput): Promise<void> {
				const script = harness.scripts[harness.invocations];
				harness.invocations += 1;
				if (script) await script(input);
				await input.eventWriter.pushRuntime({
					schema: 'archon.runtime.event.v1',
					event_id: input.eventIdGenerator?.('session-status') ?? `evt-${input.turnId}-6`,
					session_id: input.sessionId,
					turn_id: input.turnId,
					runtime_seq: input.runtimeSeqGenerator?.() ?? (harness.seq += 1),
					type: 3,
					payload: { status: 6, stop_reason: { type: 1, message: 'completed' } },
				});
			}
		},
	};
});

let adapter: LocalRuntimeV2Adapter | undefined;
let dataDir: string | undefined;
/** Background collector over the adapter event stream; ends on `close`. */
let collected: LocalRuntimeAdapterEvent[] = [];
let collectorDone: Promise<void> = Promise.resolve();

const TEST_TIMEOUT_MS = 180_000;

async function startAdapter(): Promise<LocalRuntimeV2Adapter> {
	dataDir = await mkdtemp(join(tmpdir(), 'mcoded-adapter-'));
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
	// Same construction the local-runtime-v2 integration suite uses: real host,
	// mocked Pi runner, stubbed network so startup never leaves the machine.
	const createHost = (
		options: CreateLocalRuntimeHostOptions,
	): Promise<CreatedLocalRuntimeHost> => createLocalRuntimeHostV2ForTest(options, {});
	const instance = new LocalRuntimeV2Adapter({
		root: dataDir,
		createHost,
		configGetter: () => config,
	});
	collected = [];
	collectorDone = (async () => {
		for await (const event of instance.events) collected.push(event);
	})();
	await instance.start();
	return instance;
}

function eventsOf<T extends LocalRuntimeAdapterEvent['type']>(type: T) {
	return collected.filter((event): event is Extract<LocalRuntimeAdapterEvent, { type: T }> => {
		return event.type === type;
	});
}

async function waitForEvent(
	predicate: (event: LocalRuntimeAdapterEvent) => boolean,
	outline: string,
): Promise<LocalRuntimeAdapterEvent> {
	return vi.waitFor(
		() => {
			const found = collected.find(predicate);
			expect(found, outline).toBeDefined();
			return found as LocalRuntimeAdapterEvent;
		},
		{ timeout: 60_000, interval: 100 },
	);
}

afterEach(async () => {
	if (adapter) {
		await adapter.close().catch(() => undefined);
		await collectorDone.catch(() => undefined);
	}
	adapter = undefined;
	if (dataDir) {
		closeLocalRuntimeDb(dataDir);
		await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
	dataDir = undefined;
	collected = [];
	harness.scripts = [];
	harness.invocations = 0;
});

describe('LocalRuntimeV2Adapter over a temporary local-runtime-v2 host', () => {
	it(
		'prompt produces real turn frames and a terminal event',
		async () => {
			adapter = await startAdapter();
			harness.scripts = [async () => undefined];

			await adapter.submit({ kind: 'prompt', message: 'hello runtime', requestId: 'req-p1' });

			await waitForEvent(
				(event) => event.type === 'turn_completed' && event.requestId === 'req-p1',
				'prompt must end with a turn_completed event',
			);
			expect(adapter.currentSessionId).toBeTypeOf('string');
			expect(eventsOf('runtime_started')).toHaveLength(1);
			const frames = eventsOf('turn_frame').filter(
				(event) => event.requestId === 'req-p1',
			);
			expect(frames.length).toBeGreaterThan(0);
			// The delivery layer always opens the stream with its meta frame.
			expect(frames[0]?.frame.dataJson).toBeTypeOf('string');
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'follow_up queues input on the session without starting a prompt',
		async () => {
			adapter = await startAdapter();
			harness.scripts = [async () => undefined];

			await adapter.submit({ kind: 'follow_up', message: 'later please', requestId: 'req-f1' });

			const queued = await waitForEvent(
				(event) => event.type === 'input_queued' && event.requestId === 'req-f1',
				'follow_up must produce an input_queued event',
			);
			expect(queued).toMatchObject({ kind: 'follow_up', steered: false });
			expect((queued as Extract<LocalRuntimeAdapterEvent, { type: 'input_queued' }>).itemId).toBeTypeOf(
				'string',
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'abort cancels the active turn through the runtime',
		async () => {
			adapter = await startAdapter();
			// The scripted turn blocks until its signal fires: abort is what
			// ends it, and the mock then pushes the terminal event.
			harness.scripts = [
				(input) =>
					new Promise<void>((resolve) => {
						if (input.signal?.aborted) {
							resolve();
							return;
						}
						input.signal?.addEventListener('abort', () => resolve(), { once: true });
					}),
			];

			const submission = adapter.submit({
				kind: 'prompt',
				message: 'run until aborted',
				requestId: 'req-a1',
			});
			await waitForEvent(
				(event) => event.type === 'turn_started' && event.requestId === 'req-a1',
				'turn must start before abort',
			);
			await expect(submission).resolves.toBeUndefined();

			await adapter.abort();
			await waitForEvent(
				(event) => event.type === 'abort_requested',
				'abort must surface an abort_requested event',
			);
			// Abort is a cancel, not an error: the terminal relay must keep the
			// historical turn_completed (only session_status "error" fails) —
			// a regression that surfaces aborts as turn_failed must fail here.
			await waitForEvent(
				(event) => event.type === 'turn_completed' && event.requestId === 'req-a1',
				'aborted turn must end with turn_completed, not turn_failed',
			);
			expect(eventsOf('turn_failed')).toHaveLength(0);
		},
		TEST_TIMEOUT_MS,
	);
});

/** One mock terminal status: the `session_status` SSE frame shape. */
function sessionStatusFrame(status: Record<string, unknown>): SessionStreamFrameView {
	return { dataJson: JSON.stringify({ type: 'session_status', session_status: status }) };
}

/**
 * Immutable host stub around the CliService surface the adapter touches;
 * everything the adapter never calls is a no-op.
 */
function stubHost(cli: CliService): CreatedLocalRuntimeHost {
	return {
		dataDir: join(tmpdir(), 'mcoded-mock-host'),
		ready: Promise.resolve(),
		apiHost: {
			close: async () => undefined,
			ensureBuiltinAgents: async () => undefined,
		},
		metricsClient: { close: async () => undefined },
		cliService: cli,
	} as unknown as CreatedLocalRuntimeHost;
}

/**
 * Mock host whose `sendMessage` streams the given frames followed by the
 * delivery layer's `"[DONE]"` sentinel. Only the CliService surface the
 * adapter touches is implemented; everything else is an immutable stub.
 */
function createMockHost(frames: readonly SessionStreamFrameView[]): CreatedLocalRuntimeHost {
	const stream = (async function* generateFrames() {
		for (const frame of frames) yield frame;
		yield { dataJson: '[DONE]' } as SessionStreamFrameView;
	})();
	const cli = {
		createSession: async () => ({
			sessionId: 'sess-mock-1',
			agentName: DEFAULT_MCODED_AGENT_NAME,
		}),
		sendMessage: async () => ({ ok: true, source: stream }),
	} as unknown as CliService;
	return stubHost(cli);
}

/** Start an adapter against a mock host on a fresh temporary root. */
async function startMockAdapter(
	createHost: (options: CreateLocalRuntimeHostOptions) => Promise<CreatedLocalRuntimeHost>,
	extraOptions?: Omit<LocalRuntimeAdapterOptions, 'root' | 'createHost'>,
): Promise<LocalRuntimeV2Adapter> {
	dataDir = await mkdtemp(join(tmpdir(), 'mcoded-adapter-mock-'));
	await mkdir(join(dataDir, 'workspace'), { recursive: true });
	const instance = new LocalRuntimeV2Adapter({ root: dataDir, createHost, ...extraOptions });
	collected = [];
	collectorDone = (async () => {
		for await (const event of instance.events) collected.push(event);
	})();
	await instance.start();
	return instance;
}

describe('LocalRuntimeV2Adapter terminal relay over a mock host', () => {
	it(
		'relays a terminal session_status error as an explicit turn_failed',
		async () => {
			const failureMessage =
				'Model "minimax/MiniMax-M2" is not available for the "managed_token_plan" route';
			adapter = await startMockAdapter(
				async () =>
					createMockHost([
						{ dataJson: '{"type":10}' },
						{ dataJson: JSON.stringify({ type: 2, agent_message: { msg_id: 'm1' } }) },
						sessionStatusFrame({ type: 'started' }),
						sessionStatusFrame({ type: 'error', message: failureMessage, errorCode: 400 }),
					]),
			);

			await adapter.submit({ kind: 'prompt', message: 'fail please', requestId: 'req-e1' });

			const failed = await waitForEvent(
				(event) => event.type === 'turn_failed' && event.requestId === 'req-e1',
				'a terminal session_status error must surface as turn_failed',
			);
			expect(failed).toMatchObject({
				type: 'turn_failed',
				requestId: 'req-e1',
				sessionId: 'sess-mock-1',
				error: failureMessage,
			});
			// The failure must REPLACE the success terminator, not stack on it.
			expect(eventsOf('turn_completed')).toHaveLength(0);
			// Every frame is still relayed verbatim (the terminal status frame
			// included); only the terminator event differs.
			expect(eventsOf('turn_frame').filter((event) => event.requestId === 'req-e1')).toHaveLength(
				4,
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'keeps turn_completed for a finished terminal status',
		async () => {
			adapter = await startMockAdapter(
				async () =>
					createMockHost([
						{ dataJson: '{"type":10}' },
						sessionStatusFrame({ type: 'started' }),
						sessionStatusFrame({ type: 'finished' }),
					]),
			);

			await adapter.submit({ kind: 'prompt', message: 'succeed', requestId: 'req-ok1' });

			await waitForEvent(
				(event) => event.type === 'turn_completed' && event.requestId === 'req-ok1',
				'a finished terminal status must keep the turn_completed event',
			);
			expect(eventsOf('turn_failed')).toHaveLength(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'keeps turn_completed when the stream ends without a session_status frame',
		async () => {
			adapter = await startMockAdapter(
				async () => createMockHost([{ dataJson: '{"type":10}' }]),
			);

			await adapter.submit({ kind: 'prompt', message: 'no status', requestId: 'req-s1' });

			await waitForEvent(
				(event) => event.type === 'turn_completed' && event.requestId === 'req-s1',
				'a stream without terminal status keeps the historical turn_completed',
			);
			expect(eventsOf('turn_failed')).toHaveLength(0);
		},
		TEST_TIMEOUT_MS,
	);
});

/**
 * A fourth block pins command ORDERING against pipelined frames: the wire
 * dispatches `onCommand` fire-and-forget, so `prompt` + `abort` arriving
 * back-to-back on one connection reach the adapter concurrently. The abort
 * must queue behind the prompt's admission (host boot / Session creation /
 * turn open) instead of inspecting a half-booted runtime, cancelling nothing,
 * and acking success while the admitted prompt then runs an uncancelled turn
 * (review finding: lost abort).
 */
describe('LocalRuntimeV2Adapter command ordering over a mock host', () => {
	it(
		'applies a pipelined abort after the prompt it follows, not as a no-op',
		async () => {
			const calls: string[] = [];
			const hostGate = Promise.withResolvers<void>();
			const turnGate = Promise.withResolvers<void>();
			const stream = (async function* orderedTurn() {
				await turnGate.promise;
				yield { dataJson: '[DONE]' } as SessionStreamFrameView;
			})();
			const cli = {
				createSession: async () => {
					calls.push('createSession');
					return { sessionId: 'sess-order-1', agentName: DEFAULT_MCODED_AGENT_NAME };
				},
				sendMessage: async () => {
					calls.push('sendMessage');
					return { ok: true, source: stream };
				},
				abortSession: async (req: { id: string }) => {
					calls.push(`abortSession:${req.id}`);
					return { success: true };
				},
			} as unknown as CliService;
			// The host boot stalls on the gate, so the prompt's admission is
			// genuinely in flight (this.cli still undefined) when abort lands.
			const createHost = async (): Promise<CreatedLocalRuntimeHost> => {
				calls.push('createHost');
				await hostGate.promise;
				return stubHost(cli);
			};

			dataDir = await mkdtemp(join(tmpdir(), 'mcoded-adapter-order-'));
			await mkdir(join(dataDir, 'workspace'), { recursive: true });
			const instance = new LocalRuntimeV2Adapter({ root: dataDir, createHost });
			adapter = instance;
			collected = [];
			collectorDone = (async () => {
				for await (const event of instance.events) collected.push(event);
			})();

			// Pipelined exactly as the wire delivers it: prompt first, abort
			// immediately after, neither awaited in between.
			const admitted = instance.submit({
				kind: 'prompt',
				message: 'cancel me',
				requestId: 'req-o1',
			});
			const aborted = instance.abort();

			hostGate.resolve();
			await admitted;
			await aborted;

			// The abort reached the runtime only AFTER the prompt was admitted
			// (Session created, turn opened). With the old admission-bypassing
			// abort it resolved while the host was still booting and
			// `abortSession` was never called at all.
			expect(calls).toEqual([
				'createHost',
				'createSession',
				'sendMessage',
				'abortSession:sess-order-1',
			]);
			expect(eventsOf('abort_requested')).toEqual([
				{ type: 'abort_requested', sessionId: 'sess-order-1' },
			]);

			// The turn still terminates cleanly after the ordered abort.
			turnGate.resolve();
			await waitForEvent(
				(event) => event.type === 'turn_completed' && event.requestId === 'req-o1',
				'turn must end with turn_completed after the ordered abort',
			);
		},
		TEST_TIMEOUT_MS,
	);
});

/** Observability over a {@link createFakeAuthSession} session. */
interface FakeAuthSessionHarness {
	readonly session: LocalRuntimeAdapterAuthSession;
	/** 1-based ordinals of every `lease()` invocation, in call order. */
	readonly leaseCalls: number[];
	readonly invalidations: ReadonlyArray<{
		readonly rejectedAccessToken?: string;
		readonly loginEpoch?: string;
	}>;
	readonly isDisposed: () => boolean;
}

/**
 * Fake profile auth session mirroring the semantics of the product
 * `createProfileAuthSession` the adapter relies on: `lease()` serves the
 * cached context, `authContextGetter` exposes it, and a rejection passed to
 * `authContextInvalidator` swaps in a refreshed credential (`token-2`) and
 * re-leases — exactly what the owner-side recovery does on a managed 401.
 */
function createFakeAuthSession(initial: {
	readonly accessToken: string;
	readonly loginEpoch: string;
}): FakeAuthSessionHarness {
	let context: LocalRuntimeAuthContext = { ...initial };
	let leaseCount = 0;
	let disposed = false;
	const leaseCalls: number[] = [];
	const invalidations: Array<{
		readonly rejectedAccessToken?: string;
		readonly loginEpoch?: string;
	}> = [];
	const lease = async (): Promise<LocalRuntimeAuthContext> => {
		leaseCount += 1;
		leaseCalls.push(leaseCount);
		return context;
	};
	return {
		leaseCalls,
		invalidations,
		isDisposed: () => disposed,
		session: {
			authContextGetter: () => context,
			authContextInvalidator: async (rejectedAccessToken?: string, loginEpoch?: string) => {
				invalidations.push({ rejectedAccessToken, loginEpoch });
				context = { accessToken: 'token-2', loginEpoch: initial.loginEpoch };
				await lease();
			},
			lease,
			dispose: () => {
				disposed = true;
			},
		},
	};
}

/**
 * Mock runtime whose turn rejects the managed bearer the way the model
 * resolver's 401 recovery does (`createManagedAuthRetryFetch`): it reads the
 * current bearer through `authContextGetter`, hands it to
 * `authContextInvalidator`, then re-reads the refreshed context — and the
 * turn still ends in a terminal 401 error the adapter must relay.
 */
function createManagedAuthRejectionHost(
	options: CreateLocalRuntimeHostOptions,
	failureMessage: string,
	onRecoveredBearer: (accessToken: string | undefined) => void,
): CreatedLocalRuntimeHost {
	const stream = (async function* generateFrames() {
		yield { dataJson: '{"type":10}' } as SessionStreamFrameView;
		yield sessionStatusFrame({ type: 'error', message: failureMessage, errorCode: 401 });
		yield { dataJson: '[DONE]' } as SessionStreamFrameView;
	})();
	const cli = {
		createSession: async () => ({
			sessionId: 'sess-mock-1',
			agentName: DEFAULT_MCODED_AGENT_NAME,
		}),
		sendMessage: async () => {
			const rejected = options.authContextGetter?.();
			await options.authContextInvalidator?.(rejected?.accessToken, rejected?.loginEpoch);
			onRecoveredBearer(options.authContextGetter?.()?.accessToken);
			return { ok: true, source: stream };
		},
	} as unknown as CliService;
	return stubHost(cli);
}

describe('LocalRuntimeV2Adapter auth inheritance (fake profile session)', () => {
	it(
		'syncs the profile lease and hands the session hooks to the host verbatim',
		async () => {
			const fake = createFakeAuthSession({ accessToken: 'token-1', loginEpoch: 'epoch-1' });
			const authOptions: LocalRuntimeAdapterAuthOptions = { profile: 'test-profile' };
			const sessionArgs: LocalRuntimeAdapterAuthOptions[] = [];
			const hostOptionsSeen: CreateLocalRuntimeHostOptions[] = [];
			adapter = await startMockAdapter(
				async (options) => {
					hostOptionsSeen.push(options);
					return createMockHost([sessionStatusFrame({ type: 'finished' })]);
				},
				{
					auth: authOptions,
					createAuthSession: (received) => {
						sessionArgs.push(received);
						return fake.session;
					},
				},
			);

			// The session factory got the auth options with the SERVED dataDir
			// pinned on top (the credential namespace follows the data plane, opus
			// 2026-11-01 — the profile is a label), the initial lease synced
			// before the host booted, and the host received the session's hooks
			// verbatim — identity, not copies.
			expect(sessionArgs).toEqual([{ ...authOptions, dataDir }]);
			expect(fake.leaseCalls).toEqual([1]);
			const hostOptions = hostOptionsSeen[0];
			expect(hostOptions?.authContextGetter).toBe(fake.session.authContextGetter);
			expect(hostOptions?.authContextInvalidator).toBe(fake.session.authContextInvalidator);
			expect(hostOptions?.authContextGetter?.()).toEqual({
				accessToken: 'token-1',
				loginEpoch: 'epoch-1',
			});

			// Tearing the adapter down must drop the session's refresh timer.
			await adapter.close();
			expect(fake.isDisposed()).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'degrades to an auth-less host when the profile session is signed out',
		async () => {
			const hostOptionsSeen: CreateLocalRuntimeHostOptions[] = [];
			adapter = await startMockAdapter(
				async (options) => {
					hostOptionsSeen.push(options);
					return createMockHost([sessionStatusFrame({ type: 'finished' })]);
				},
				{ auth: { profile: 'signed-out' }, createAuthSession: () => undefined },
			);

			// `createProfileAuthSession` returns undefined for a signed-out
			// profile: the daemon still boots, just without auth hooks.
			expect(eventsOf('runtime_started')).toHaveLength(1);
			expect(hostOptionsSeen[0]?.authContextGetter).toBeUndefined();
			expect(hostOptionsSeen[0]?.authContextInvalidator).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'passes no auth hooks without auth options (legacy default construction)',
		async () => {
			const hostOptionsSeen: CreateLocalRuntimeHostOptions[] = [];
			adapter = await startMockAdapter(async (options) => {
				hostOptionsSeen.push(options);
				return createMockHost([sessionStatusFrame({ type: 'finished' })]);
			});

			expect(hostOptionsSeen[0]?.authContextGetter).toBeUndefined();
			expect(hostOptionsSeen[0]?.authContextInvalidator).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'relays a rejected managed bearer (terminal 401 error) and re-leases through the invalidator',
		async () => {
			const fake = createFakeAuthSession({ accessToken: 'token-1', loginEpoch: 'epoch-1' });
			const failureMessage =
				'Request failed with status 401: the managed token is invalid or expired';
			const recoveredBearers: (string | undefined)[] = [];
			adapter = await startMockAdapter(
				async (options) =>
					createManagedAuthRejectionHost(options, failureMessage, (accessToken) => {
						recoveredBearers.push(accessToken);
					}),
				{ auth: { profile: 'test-profile' }, createAuthSession: () => fake.session },
			);

			await adapter.submit({ kind: 'prompt', message: 'managed please', requestId: 'req-auth1' });

			const failed = await waitForEvent(
				(event) => event.type === 'turn_failed' && event.requestId === 'req-auth1',
				'a terminal managed-OAuth 401 error must surface as turn_failed',
			);
			expect(failed).toMatchObject({
				type: 'turn_failed',
				requestId: 'req-auth1',
				sessionId: 'sess-mock-1',
				error: failureMessage,
			});
			expect(eventsOf('turn_completed')).toHaveLength(0);
			// The 401 recovery went through the adapter's wiring: the invalidator
			// saw the rejected bearer/epoch, the lease was re-requested after the
			// initial sync, and the getter already serves the refreshed token.
			expect(fake.invalidations).toEqual([
				{ rejectedAccessToken: 'token-1', loginEpoch: 'epoch-1' },
			]);
			expect(fake.leaseCalls).toEqual([1, 2]);
			expect(recoveredBearers).toEqual(['token-2']);
		},
		TEST_TIMEOUT_MS,
	);
});
