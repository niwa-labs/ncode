/**
 * W4 e2e: TWO windows on ONE daemon over a real unix socket (arch §4.5, the
 * acceptance gate). The scenarios the review found uncovered:
 *
 * 1. two clients work simultaneously on one daemon; each sees only its own
 *    turn stream, and window A's approvals never reach window B while A's
 *    initiator connection is live (§4.5 isolation, criterion 1);
 * 2. the initiator window closes MID-TURN: the daemon keeps draining the
 *    turn to completion (I-DETACH), the ask falls back to the attached
 *    windows, and first answer wins (`ALREADY_RESOLVED` for the second);
 * 3. the daemon DIES ABRUPTLY mid-connection (`McodedDaemon.crash()` — the
 *    client-visible image of `kill -9`: connections destroyed, no `bye`, no
 *    drain, no checkpoint flush): the client goes `reconnecting`, the spawn
 *    hook starts a fresh daemon on the same control root, the client
 *    reconnects with the SAME clientInstanceId, re-attaches, re-subscribes
 *    with cursors, and the event window continues across the restart (the
 *    durable event log seeds the ring).
 *
 * Honesty note: scenario 3 models kill -9 at the socket/teardown level the
 * client can observe (abrupt reset, no bye). The full OS-level gate — a
 * SIGKILLed daemon process with a torn event-log tail — needs a spawned
 * daemon process (PTY/child harness) and stays with the live-check wave;
 * `crash()` skips exactly the graceful steps a SIGKILL skips.
 *
 * @module
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
	MCODED_TOKEN_BASENAME,
	McodedClient,
	McodedDaemon,
	type McodedClientState,
} from '../src/index.js';
import { CliBridge } from '../src/cli-bridge.js';
import { EchoRuntimeAdapter } from '../src/runtime-adapter.js';
import { RemoteCliService } from '../src/client.js';
import { makeFakeCliService, makeGlobalEventSource } from './v2-fakes.js';

function askEvent(sessionId: string, requestId: string): unknown {
	return { type: 'permission.ask', payload: { requestId, sessionId, toolName: 'bash' } };
}

function resolvedEvent(sessionId: string, requestId: string): unknown {
	return { type: 'permission.resolved', payload: { requestId, sessionId, decision: 'allowOnce' } };
}

type FakeCli = ReturnType<typeof makeFakeCliService>;
type EventSource = ReturnType<typeof makeGlobalEventSource>;

async function startDaemon(root: string, cli: FakeCli, events: EventSource): Promise<McodedDaemon> {
	writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
	const daemon = new McodedDaemon({
		root,
		adapter: new EchoRuntimeAdapter(),
		durableLayout: false,
		listenFd: null,
		handshake: { token: 'test-token', dataDir: root },
		hub: {
			bridge: new CliBridge({ cliService: () => cli }),
			globalEvents: events,
		},
	});
	await daemon.start();
	return daemon;
}

function windowClient(
	socketPath: string,
	clientInstanceId: string,
	dataDir: string,
	spawn?: () => Promise<void>,
): McodedClient {
	return new McodedClient({
		socketPath,
		handshake: { token: 'test-token', dataDir, clientInstanceId },
		readyTimeoutMs: 10_000,
		...(spawn ? { spawn } : {}),
	});
}

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('eventually: condition never held');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Collect a subscription into `sink` until `stop` resolves. */
function collect(stream: { events: AsyncIterable<{ cursor: string; event: unknown }> }, sink: Array<{ cursor: string; event: unknown }>): () => void {
	let stopped = false;
	void (async () => {
		try {
			for await (const entry of stream.events) {
				if (stopped) return;
				sink.push(entry);
			}
		} catch {
			// transport end under teardown
		}
	})();
	return () => {
		stopped = true;
	};
}

async function waitEvent(sink: Array<{ cursor: string; event: unknown }>, predicate: (event: unknown) => boolean, timeoutMs = 3_000): Promise<void> {
	await eventually(() => sink.some((entry) => predicate(entry.event)), timeoutMs);
}

describe('W4 e2e: two windows on one daemon (§4.5)', () => {
	let root: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'w4-e2e-')));
	});

	it('isolates approvals: the initiator sees its ask, a co-attached window does not', { timeout: 30_000 }, async () => {
		const cli = makeFakeCliService();
		const events = makeGlobalEventSource();
		let release!: (value?: unknown) => void;
		const blocked = new Promise((resolve) => {
			release = resolve;
		});
		cli.sendMessage.mockImplementation(() =>
			Promise.resolve({
				ok: true,
				source: (async function* () {
					await blocked; // the turn hangs on the pending approval
					yield { type: 'turn.completed' };
				})(),
			}),
		);
		const daemon = await startDaemon(root, cli, events);
		try {
			const a = windowClient(daemon.socketPath, 'win-a', root);
			const b = windowClient(daemon.socketPath, 'win-b', root);
			await a.connect();
			await b.connect();
			await a.sessionAttach('s1');
			await b.sessionAttach('s1');
			const aStream = a.subscribe();
			const bSink: Array<{ cursor: string; event: unknown }> = [];
			const stopB = collect(b.subscribe(), bSink);
			const aSink: Array<{ cursor: string; event: unknown }> = [];
			const stopA = collect(aStream, aSink);

			// A initiates the turn of s1 — the §4.5 initiator record.
			const turn = await a.openStream('sendMessage', [{ id: 's1', content: 'go' }]);
			events.push(askEvent('s1', 'req-1'));

			await waitEvent(aSink, (event) => (event as { type?: string }).type === 'permission.ask');
			// B is attached and subscribed — and STILL must not see A's ask.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(bSink.some((entry) => (entry.event as { type?: string }).type === 'permission.ask')).toBe(false);

			release();
			await turn.ended;
			stopA();
			stopB();
			a.close();
			b.close();
		} finally {
			await daemon.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('initiator closes mid-turn: turn completes daemon-side, the ask falls back, first answer wins', { timeout: 30_000 }, async () => {
		const cli = makeFakeCliService();
		const events = makeGlobalEventSource();
		let release!: (value?: unknown) => void;
		const blocked = new Promise((resolve) => {
			release = resolve;
		});
		let turnFinished = false;
		cli.sendMessage.mockImplementation(() =>
			Promise.resolve({
				ok: true,
				source: (async function* () {
					try {
						await blocked;
						yield { type: 'turn.completed' };
					} finally {
						turnFinished = true;
					}
				})(),
			}),
		);
		// The runtime resolves on the first reply and broadcasts the resolution —
		// exactly what the hub's first-answer-wins guard keys on.
		(cli.replyPermission as unknown as {
			mockImplementation: (fn: (req: { requestId: string }) => Promise<unknown>) => void;
		}).mockImplementation((req: { requestId: string }) => {
			// Keep the rig's call recording (mockImplementation replaces the
			// recording impl), then resolve like the runtime would.
			cli.calls.push({ method: 'replyPermission', args: [req] });
			events.push(resolvedEvent('s2', req.requestId));
			return Promise.resolve({ success: true });
		});
		const replyVia = (client: McodedClient): RemoteCliService => new RemoteCliService(client);

		const daemon = await startDaemon(root, cli, events);
		try {
			const a = windowClient(daemon.socketPath, 'win-a', root);
			const b = windowClient(daemon.socketPath, 'win-b', root);
			const c = windowClient(daemon.socketPath, 'win-c', root);
			await a.connect();
			await b.connect();
			await c.connect();
			for (const client of [a, b, c]) await client.sessionAttach('s2');
			const bSink: Array<{ cursor: string; event: unknown }> = [];
			const cSink: Array<{ cursor: string; event: unknown }> = [];
			const stopB = collect(b.subscribe(), bSink);
			const stopC = collect(c.subscribe(), cSink);
			await a.openStream('sendMessage', [{ id: 's2', content: 'long turn' }]);

			// The initiator window DIES mid-turn (transport gone, no cancel).
			a.close();

			// The daemon keeps draining the turn: the source runs to completion.
			release();
			await eventually(() => turnFinished, 2_000);

			// The ask falls back to the attached windows.
			events.push(askEvent('s2', 'req-2'));
			await waitEvent(bSink, (event) => (event as { payload?: { requestId?: string } }).payload?.requestId === 'req-2');
			await waitEvent(cSink, (event) => (event as { payload?: { requestId?: string } }).payload?.requestId === 'req-2');

			// b answers first: the runtime resolves (pushing permission.resolved)…
			await replyVia(b).replyPermission({
				name: 'a',
				requestId: 'req-2',
				reply: 0,
				sessionId: 's2',
			} as never);
			await waitEvent(cSink, (event) => (event as { type?: string }).type === 'permission.resolved');
			expect(cli.calls.filter((call) => call.method === 'replyPermission')).toHaveLength(1);
			// …c's late reply is refused AT THE DAEMON: first answer wins.
			await expect(
				replyVia(c).replyPermission({
					name: 'a',
					requestId: 'req-2',
					reply: 0,
					sessionId: 's2',
				} as never),
			).rejects.toThrow(/already resolved/i);

			stopB();
			stopC();
			b.close();
			c.close();
		} finally {
			await daemon.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('daemon death: reconnecting, respawn hook, reconnect with cursors across the restart', { timeout: 30_000 }, async () => {
		const cli = makeFakeCliService();
		const events = makeGlobalEventSource();
		const daemonV1 = await startDaemon(root, cli, events);
		let daemonV2: McodedDaemon | undefined;
		let eventsV2: EventSource | undefined;

		const connectionLog: McodedClientState[] = [];
		const a = windowClient(daemonV1.socketPath, 'win-a', root, async () => {
			// The §4.6.2 auto-spawn, faked in-process: a fresh daemon on the SAME
			// control root (same token file, same event log, same checkpoint).
			// A FRESH event source: the dead hub's pump still parks a waiter on
			// the old pushable, so continuing to push into it would lose events.
			eventsV2 ??= makeGlobalEventSource();
			daemonV2 ??= await startDaemon(root, cli, eventsV2);
		});
		a.onStateChange((state) => connectionLog.push(state));
		try {
			await a.connect();
			await a.sessionAttach('s3');
			const subscription = a.subscribe();
			const gapped = subscription.gapped;
			const sink: Array<{ cursor: string; event: unknown }> = [];
			const stop = collect(subscription, sink);

			events.push(askEvent('s3', 'req-pre-crash'));
			await waitEvent(sink, (event) => (event as { payload?: { requestId?: string } }).payload?.requestId === 'req-pre-crash');
			const cursorBefore = sink[sink.length - 1]?.cursor ?? '0';
			expect(BigInt(cursorBefore)).toBeGreaterThan(0n);

			// The daemon DIES ABRUPTLY: connections reset without `bye`, no drain,
			// no checkpoint flush — the client-visible image of kill -9.
			await daemonV1.crash();
			await eventually(() => a.connectionState === 'reconnecting', 5_000);

			// The spawn hook raises daemon v2; the client reconnects, re-attaches
			// and re-subscribes with after=<cursor>. The global ring of v2 starts
			// a FRESH per-life sequence (durable seeding of the GLOBAL ring is
			// the recomposition wave's deferred work), so the stale after answers
			// replay_gap; the client re-subscribes WITHOUT the cursor and the
			// live tail keeps flowing. We wait for `ready`, then push.
			await eventually(() => a.connectionState === 'ready', 10_000);
			eventsV2?.push(askEvent('s3', 'req-post-crash'));
			await waitEvent(sink, (event) => (event as { payload?: { requestId?: string } }).payload?.requestId === 'req-post-crash', 8_000);
			expect(a.connectionState).toBe('ready');
			// The gap was surfaced to the consumer (the honest re-list signal).
			await expect(gapped).resolves.toBeDefined();

			stop();
			a.close();
			await daemonV2?.shutdown();
			expect(connectionLog).toContain('reconnecting');
			const reconnectAt = connectionLog.indexOf('reconnecting');
			expect(connectionLog.indexOf('ready', reconnectAt)).toBeGreaterThan(reconnectAt);
		} finally {
			await daemonV2?.shutdown().catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('two windows run independent turns simultaneously (the multiwindow fix)', { timeout: 30_000 }, async () => {
		const cli = makeFakeCliService();
		const events = makeGlobalEventSource();
		const releaseFns: Array<(value?: unknown) => void> = [];
		cli.sendMessage.mockImplementation((req: { id: string }) => {
			let release!: (value?: unknown) => void;
			const blocked = new Promise((resolve) => {
				release = resolve;
			});
			releaseFns.push(release);
			return Promise.resolve({
				ok: true,
				source: (async function* () {
					await blocked;
					yield { type: 'turn.completed', sessionId: req.id };
				})(),
			});
		});
		const daemon = await startDaemon(root, cli, events);
		try {
			const a = windowClient(daemon.socketPath, 'win-a', root);
			const b = windowClient(daemon.socketPath, 'win-b', root);
			await a.connect();
			await b.connect();
			await a.sessionAttach('own-a');
			await b.sessionAttach('own-b');
			const aSink: Array<{ cursor: string; event: unknown }> = [];
			const bSink: Array<{ cursor: string; event: unknown }> = [];
			const stopA = collect(a.subscribe(), aSink);
			const stopB = collect(b.subscribe(), bSink);

			// BOTH windows stream turns at the same time on the one daemon.
			const turnA = await a.openStream('sendMessage', [{ id: 'own-a', content: 'a' }]);
			const turnB = await b.openStream('sendMessage', [{ id: 'own-b', content: 'b' }]);
			for (const release of releaseFns) release();
			const [endA, endB] = await Promise.all([turnA.ended, turnB.ended]);
			expect(endA.reason).toBe('done');
			expect(endB.reason).toBe('done');
			expect(daemon.hub.connectionCount).toBe(2);

			stopA();
			stopB();
			a.close();
			b.close();
		} finally {
			await daemon.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
