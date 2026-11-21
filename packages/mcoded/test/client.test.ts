/**
 * W3: the client side end-to-end — McodedClient (connect/hello, typed call,
 * credit-managed streams, subscribe with reconnect-resume) and the typed
 * RemoteCliService projection, against a REAL hub over the in-memory
 * loopback.
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalEvent } from '@mavis/shared/global-events';

import { McodedClient, RemoteCliService, SocketConnectError } from '../src/client.js';
import { CrashLoopWatchdog, McodedCrashLoopError } from '../src/crash-loop-watchdog.js';
import { CliBridge } from '../src/cli-bridge.js';
import { McodedHub } from '../src/hub.js';
import { InMemoryCheckpointStore } from '../src/checkpoint.js';
import { createInMemoryTransportPair, type LineTransport } from '../src/transport.js';
import { catalogEvent, makeFakeCliService, makeGlobalEventSource } from './v2-fakes.js';

/**
 * The client's logger is a module-level `createLogger('mcode:rpc')`, not
 * injectable — the tests observe it through a full mock of `@mavis/logging`
 * (house pattern, cf. the `vi.hoisted` harness in
 * local-runtime-adapter.smoke.test.ts): deterministic regardless of the
 * developer's MCODE_LOG, and it records level + message + `err` so the
 * quiet-vs-warn split of `sendSubscribe` is assertable directly.
 */
const loggingMock = vi.hoisted(() => ({
	entries: [] as Array<{ ns: string; level: string; msg: string; err: unknown }>,
}));

vi.mock('@mavis/logging', () => {
	const makeLogger = (ns: string) => {
		const record = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
			loggingMock.entries.push({ ns, level, msg, err: fields?.err });
		};
		return {
			trace: record('trace'),
			debug: record('debug'),
			info: record('info'),
			warn: record('warn'),
			error: record('error'),
			child: () => makeLogger(ns),
			enabled: () => true,
		};
	};
	return { createLogger: (ns: string) => makeLogger(ns) };
});

interface ServerRig {
	cli: ReturnType<typeof makeFakeCliService>;
	events: ReturnType<typeof makeGlobalEventSource>;
	/** Factory of connected clients (a FRESH in-memory pair per (re)connect). */
	connect(): McodedClient;
	/** Drop the SERVER side of the client's current transport (disconnect). */
	sever(client: McodedClient): void;
}

function makeServerRig(): ServerRig {
	const cli = makeFakeCliService();
	const events = makeGlobalEventSource();
	const hub = new McodedHub({
		adapter: {
			submit: () => Promise.resolve(),
			abort: () => Promise.resolve(),
			events: (async function* () {})(),
			stop: () => undefined,
		},
		checkpoint: new InMemoryCheckpointStore(),
		bridge: new CliBridge({ cliService: () => cli }),
		globalEvents: events,
	});
	let hubStarted = false;
	const serverSides = new Map<McodedClient, LineTransport>();
	const rig: ServerRig = {
		cli,
		events,
		connect() {
			const client = new McodedClient({
				socketPath: 'memory://',
				handshake: { clientInstanceId: `client-${Math.random().toString(36).slice(2)}` },
				connect: async () => {
					if (!hubStarted) {
						// Starts the cursor sequences and the GlobalEvent pump.
						await hub.start();
						hubStarted = true;
					}
					const [clientSide, serverSide] = createInMemoryTransportPair();
					hub.attachTransport(serverSide);
					serverSides.set(client, serverSide);
					return clientSide;
				},
			});
			return client;
		},
		sever(client) {
			serverSides.get(client)?.end();
		},
	};
	return rig;
}

describe('McodedClient end-to-end', () => {
	it('connects, handshakes, and reports daemon features', async () => {
		const rig = makeServerRig();
		const client = rig.connect();
		const welcome = await client.connect();
		expect(welcome.version).toBe(2);
		expect(welcome.features).toContain('call');
		expect(client.hasFeature('stream')).toBe(true);
		expect(client.connectionState).toBe('ready');
		client.close();
	});

	it('typed call roundtrip via RemoteCliService (req-ctx and raw plans)', async () => {
		const rig = makeServerRig();
		const client = rig.connect();
		await client.connect();
		const remote = new RemoteCliService(client);
		const sessions = await remote.listSessions({} as Parameters<typeof remote.listSessions>[0]);
		expect(sessions).toEqual({ sessions: [], hasMore: false });
		const args = rig.cli.calls.find((call) => call.method === 'listSessions')?.args;
		expect(args?.[1]).toMatchObject({ signal: expect.anything() }); // daemon-built ctx

		await remote.getGoal('sess-7' as never);
		// Raw-plan methods receive the exact argument list.
		expect(rig.cli.calls.find((call) => call.method === 'getGoal')?.args).toEqual(['sess-7']);
		client.close();
	});

	it('streams a turn with credits: frames arrive in order, end arrives', async () => {
		const rig = makeServerRig();
		rig.cli.sendMessage.mockImplementationOnce(() =>
			Promise.resolve({
				ok: true,
				source: (async function* () {
					yield { type: 'message_delta', text: 'a' };
					yield { type: 'message_delta', text: 'b' };
					yield '[DONE]';
				})(),
			}),
		);
		const client = rig.connect();
		await client.connect();
		const remote = new RemoteCliService(client);
		const opened = await remote.sendMessage({ id: 'sess-1', content: 'hi' } as never);
		expect(opened.ok).toBe(true);
		if (opened.ok) {
			const frames: unknown[] = [];
			for await (const frame of opened.source) frames.push(frame);
			expect(frames).toHaveLength(3);
			expect(frames[2]).toBe('[DONE]');
		}
		client.close();
	});

	it('refused stream open surfaces the mirrored {status, body}', async () => {
		const rig = makeServerRig();
		rig.cli.sendMessage.mockImplementationOnce(() =>
			Promise.resolve({ ok: false, status: 410, body: { key: 'session_not_found', message: 'gone' } }),
		);
		const client = rig.connect();
		await client.connect();
		const remote = new RemoteCliService(client);
		const opened = await remote.sendMessage({ id: 'nope', content: 'x' } as never);
		expect(opened).toMatchObject({ ok: false, status: 410, body: { key: 'session_not_found' } });
		client.close();
	});

	it('subscribe delivers catalog events; a severed connection reconnects and resumes without loss or duplication', async () => {
		const rig = makeServerRig();
		const client = rig.connect();
		const states: string[] = [];
		client.onStateChange((state) => states.push(state));
		await client.connect();
		const subscription = client.subscribe({});
		const received: GlobalEvent[] = [];
		const draining = (async () => {
			for await (const entry of subscription.events) received.push(entry.event);
		})();

		rig.events.push(catalogEvent('session.created', { sessionId: 'g1', agentName: 'm', sessionType: 'root' }));
		rig.events.push(catalogEvent('session.created', { sessionId: 'g2', agentName: 'm', sessionType: 'root' }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(received).toHaveLength(2);

		// Sever: the client must reconnect, re-subscribe with
		// `after: <last cursor>` — no event lost, none doubled.
		rig.sever(client);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(states).toContain('reconnecting');
		expect(states).toContain('ready');
		rig.events.push(catalogEvent('session.created', { sessionId: 'g3', agentName: 'm', sessionType: 'root' }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		const ids = received.map((event) => (event.payload as { sessionId?: string }).sessionId);
		expect(ids).toEqual(['g1', 'g2', 'g3']);
		subscription.stop();
		client.close();
		void draining;
	});
});

describe('McodedClient connect failure paths (auto-spawn honesty)', () => {
	function deadSocketConnect(attemptGate?: (attempt: number) => boolean) {
		let attempt = 0;
		return async (): Promise<LineTransport> => {
			attempt += 1;
			if (attemptGate?.(attempt) === true) {
				// Succeeds: a minimal in-memory server pair answering hello.
				const cli = makeFakeCliService();
				const hub = new McodedHub({
					adapter: {
						submit: () => Promise.resolve(),
						abort: () => Promise.resolve(),
						events: (async function* () {})(),
						stop: () => undefined,
					},
					checkpoint: new InMemoryCheckpointStore(),
					bridge: new CliBridge({ cliService: () => cli }),
					globalEvents: makeGlobalEventSource(),
				});
				await hub.start();
				const [clientSide, serverSide] = createInMemoryTransportPair();
				hub.attachTransport(serverSide);
				return clientSide;
			}
			throw new SocketConnectError('connect ENOENT /no/such/mcoded.sock', 'ENOENT');
		};
	}

	it('surfaces the spawn-hook failure, not the raw ENOENT, when the hook itself throws', async () => {
		const client = new McodedClient({
			socketPath: '/no/such/mcoded.sock',
			handshake: { clientInstanceId: 'c-spawn-throw' },
			connect: deadSocketConnect(),
			spawn: async () => {
				throw new Error('EACCES: permission denied, open /root/mcoded/spawn.lock');
			},
			readyTimeoutMs: 60,
			backoffMinMs: 1,
			backoffMaxMs: 2,
		});
		await expect(client.connect()).rejects.toThrow(
			/auto-spawn failed: EACCES: permission denied/,
		);
	});

	it('resets the grace per spawn round so the crash-loop watchdog — not the raw ENOENT — decides repeated started-but-dead daemons', async () => {
		let rounds = 0;
		const client = new McodedClient({
			socketPath: '/no/such/mcoded.sock',
			handshake: { clientInstanceId: 'c-crash-loop' },
			connect: deadSocketConnect(),
			spawn: async () => {
				rounds += 1;
				return true; // "started a child" every round — never gets ready
			},
			crashLoop: new CrashLoopWatchdog({ windowMs: 60_000, maxCrashes: 3 }),
			readyTimeoutMs: 40,
			backoffMinMs: 1,
			backoffMaxMs: 2,
		});
		// Before the fix the 40 ms deadline expired during round 1 and the raw
		// "connect ENOENT ... retry" masked the crash loop.
		await expect(client.connect()).rejects.toThrow(McodedCrashLoopError);
		expect(rounds).toBe(3); // the watchdog refused the 4th dead child
	});

	it('a no-op spawn round (sibling spawning, long boot) extends the grace: a late-ready daemon still connects', async () => {
		let noopRounds = 0;
		const client = new McodedClient({
			socketPath: 'memory://late',
			handshake: { clientInstanceId: 'c-late-ready' },
			// Attempts 1–3 hit the dead socket; attempt 4 finds the daemon.
			connect: deadSocketConnect((attempt) => attempt >= 4),
			spawn: async () => {
				noopRounds += 1;
				return false; // a sibling window holds the spawn lock
			},
			readyTimeoutMs: 25,
			backoffMinMs: 10,
			backoffMaxMs: 80,
		});
		await expect(client.connect()).resolves.toBeTruthy();
		expect(noopRounds).toBe(3);
		client.close();
	});
});

/**
 * W6 regression: `sendSubscribe` WARN-ed EVERY rejection — including the
 * expected one when the user closes the client while a (re)subscribe is
 * still in flight (Ctrl+C during a reconnect loop: teardown rejects the
 * pending call with "client closed" and the shutdown logged an error-like
 * WARN). The contract now: a user-closed client exits quietly (debug only);
 * any other failure still warns.
 */
describe('McodedClient subscribe-failed logging (quiet on user close)', () => {
	/** Entries of one level+message from the mocked `@mavis/logging`. */
	function logEntries(level: string, msg: string) {
		return loggingMock.entries.filter((entry) => entry.level === level && entry.msg === msg);
	}

	/**
	 * Yield to the event loop so the in-memory wire, read loops and the
	 * rejection microtask chains settle (cf. the setImmediate settle in
	 * local-runtime-adapter.auth-lease.test.ts).
	 */
	async function settle(): Promise<void> {
		for (let i = 0; i < 250; i += 1) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	beforeEach(() => {
		loggingMock.entries.length = 0;
	});

	it('a subscribe in flight stays quiet when the user closes the client (no subscribe-failed warn)', async () => {
		const rig = makeServerRig();
		const client = rig.connect();
		await client.connect();
		// subscribe() writes the frame synchronously, so close() in the same
		// synchronous block is guaranteed to find the request still pending
		// and reject it from teardown — the exact owner complaint, without
		// any race with the daemon's subscribe-ok (it is dropped: the peer
		// side is already closed).
		const subscription = client.subscribe({});
		client.close();
		expect(client.connectionState).toBe('closed');
		await settle();
		// Quiet: no WARN. The debug trace proves the catch arm actually ran
		// (the test is not vacuously green) and carries the teardown reason.
		expect(logEntries('warn', 'subscribe-failed')).toEqual([]);
		const debug = logEntries('debug', 'subscribe-failed');
		expect(debug).toHaveLength(1);
		expect((debug[0]?.err as Error)?.message).toBe('client closed');
		subscription.stop();
	});

	it('a subscribe rejected by a lost connection on a LIVE client still warns (counterfactual)', async () => {
		const rig = makeServerRig();
		const client = rig.connect();
		await client.connect();
		const subscription = client.subscribe({});
		// Sever in the same synchronous block: the daemon's subscribe-ok can
		// never arrive (writes into a closed side are dropped), so the only
		// resolution is onConnectionLost rejecting the pending call — a
		// network failure while the client is alive (the reconnect loop has
		// a 100 ms backoff and the settle rounds never reach it).
		rig.sever(client);
		await settle();
		expect(client.connectionState).toBe('reconnecting');
		expect(logEntries('warn', 'subscribe-failed')).toHaveLength(1);
		expect((logEntries('warn', 'subscribe-failed')[0]?.err as Error)?.message).toBe(
			'connection lost',
		);
		expect(logEntries('debug', 'subscribe-failed')).toEqual([]);
		subscription.stop();
		client.close();
	});
});
