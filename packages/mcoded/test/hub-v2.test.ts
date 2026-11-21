/**
 * W3: the v2 hub core — `call` dispatch through the CliBridge (plans, error
 * mapping, per-client dedup), `session.attach` routing rules (§4.5), the
 * `subscribe` GlobalEvent stream (§4.3.4 filtering, replay, no double
 * delivery) and the daemon.* surfaces.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import type { ServerFrame } from '../src/protocol.js';

import { BridgeMethodError, CliBridge } from '../src/cli-bridge.js';
import { McodedHub } from '../src/hub.js';
import {
	attachClient,
	helloV2,
	isResponse,
	setupHub,
	waitForFailure,
	waitForResponse,
	waitForSuccess,
	type FailedResponse,
	type SuccessfulResponse,
} from './helpers.js';
import { catalogEvent, makeFakeCliService, makeGlobalEventSource, type FakeCliService } from './v2-fakes.js';

interface Rig {
	hub: McodedHub;
	cli: FakeCliService;
	events: ReturnType<typeof makeGlobalEventSource>;
}

async function setupV2(): Promise<Rig> {
	const cli = makeFakeCliService();
	const events = makeGlobalEventSource();
	const { hub } = await setupHub({
		bridge: new CliBridge({ cliService: () => cli }),
		globalEvents: events,
	});
	return { hub, cli, events };
}

describe('v2 call → CliBridge', () => {
	it('dispatches a req-ctx method: params[0] is the request, ctx is daemon-built', async () => {
		const { hub, cli } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		client.send({ type: 'call', id: 'c1', method: 'listSessions', params: [{ limit: 3 }] });
		const response = await waitForSuccess(client, (frame) => frame.command === 'call');
		expect(response.data).toEqual({ sessions: [], hasMore: false });
		const recorded = cli.calls.find((call) => call.method === 'listSessions');
		expect(recorded).toBeDefined();
		// Plan `req-ctx`: the request first, the daemon's own context second —
		// the client never sends a ProcessLocalContext (arch §4.3.2).
		expect(recorded?.args[0]).toEqual({ limit: 3 });
		expect(recorded?.args[1]).toMatchObject({ signal: expect.anything() });
		client.close();
	});

	it('dispatches a raw method with the exact argument list', async () => {
		const { hub, cli } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		client.send({ type: 'call', id: 'c2', method: 'patchGoal', params: ['sess-1', { status: 'active' }] });
		await waitForSuccess(client, (frame) => frame.command === 'call');
		const recorded = cli.calls.find((call) => call.method === 'patchGoal');
		expect(recorded?.args).toEqual(['sess-1', { status: 'active' }]);
		client.close();
	});

	it('maps a thrown runtime error onto RUNTIME_REJECTED with the class name', async () => {
		const { hub, cli } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		(cli.getSession as unknown as RejectableMock).mockRejectedValueOnce(
			new TypeError('session exploded'),
		);
		client.send({ type: 'call', id: 'c3', method: 'getSession', params: [{ id: 'x' }] });
		const failure = await waitForFailure(client, (frame) => frame.command === 'call');
		expect(failure.errorCode).toBe('RUNTIME_REJECTED');
		expect(failure.errorName).toBe('TypeError');
		expect(failure.error).toContain('session exploded');
		client.close();
	});

	it('refuses unknown methods and stream-methods-over-call with METHOD_NOT_ALLOWED', async () => {
		const { hub } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		client.send({ type: 'call', id: 'c4', method: 'deleteEverything' });
		let failure = await waitForFailure(client, (frame) => frame.command === 'call');
		expect(failure.errorCode).toBe('METHOD_NOT_ALLOWED');
		client.send({ type: 'call', id: 'c5', method: 'sendMessage', params: [{}] });
		failure = await waitForFailure(client, (frame) => frame.command === 'call');
		expect(failure.errorCode).toBe('METHOD_NOT_ALLOWED');
		expect(failure.error).toContain('stream.open');
		client.close();
	});

	it('refuses the whole v2 call surface when no bridge is wired', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		client.send({ type: 'call', id: 'c6', method: 'listSessions' });
		const failure = await waitForFailure(client, (frame) => frame.command === 'call');
		expect(failure.errorCode).toBe('METHOD_NOT_ALLOWED');
		client.close();
	});

	it('dedups retries by (clientInstanceId, id) — success replays the same data', async () => {
		const { hub, cli } = await setupV2();
		const client = attachClient(hub, 'client-42');
		await helloV2(client, { clientInstanceId: 'client-42' });
		client.send({ type: 'call', id: 'idem-1', method: 'createSession', params: [{ agentName: 'mavis' }] });
		const first = await waitForSuccess(client, (frame) => frame.command === 'call');
		// The same id after a "reconnect" (same connection in tests) replays.
		client.send({ type: 'call', id: 'idem-1', method: 'createSession', params: [{ agentName: 'mavis' }] });
		const second = await waitForSuccess(client, (frame) => frame.command === 'call');
		expect(second.data).toEqual(first.data);
		const creations = cli.calls.filter((call) => call.method === 'createSession');
		expect(creations).toHaveLength(1); // executed ONCE
		// A DIFFERENT id executes again.
		client.send({ type: 'call', id: 'idem-2', method: 'createSession', params: [{ agentName: 'mavis' }] });
		await waitForSuccess(client, (frame) => frame.command === 'call');
		expect(cli.calls.filter((call) => call.method === 'createSession')).toHaveLength(2);
		client.close();
	});

	it('dedups failures too: a retried failed call sees its failure again', async () => {
		const { hub, cli } = await setupV2();
		const client = attachClient(hub, 'client-43');
		await helloV2(client, { clientInstanceId: 'client-43' });
		(cli.createSession as unknown as RejectableMock).mockRejectedValueOnce(
			new BridgeMethodError('admission refused', { code: 'RUNTIME_REJECTED' }),
		);
		client.send({ type: 'call', id: 'idem-f', method: 'createSession', params: [{}] });
		const first = await waitForFailure(client, (frame) => frame.command === 'call');
		client.send({ type: 'call', id: 'idem-f', method: 'createSession', params: [{}] });
		const retry = await waitForFailure(client, (frame) => frame.command === 'call');
		expect(retry.error).toBe(first.error);
		// The vi mock counts EVERY invocation (recorded impl or not): the
		// rejection consumed the once-mock; the retry hit the dedup record
		// WITHOUT re-executing the method.
		expect(cli.createSession).toHaveBeenCalledTimes(1);
		client.close();
	});
});

describe('v2 attach rules (§4.5)', () => {
	it('replyPermission without attach answers NOT_ATTACHED; with attach it executes', async () => {
		const { hub, cli } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		client.send({ type: 'call', id: 'p1', method: 'replyPermission', params: [{ requestId: 'r1', sessionId: 'sess-9', reply: 'allowOnce' }] });
		const refused = await waitForFailure(client, (frame) => frame.command === 'call');
		expect(refused.errorCode).toBe('NOT_ATTACHED');
		expect(cli.calls.some((call) => call.method === 'replyPermission')).toBe(false);

		client.send({ type: 'session.attach', id: 'a1', sessionId: 'sess-9', role: 'owner' });
		await waitForSuccess(client, (frame) => frame.command === 'session.attach');
		client.send({ type: 'call', id: 'p2', method: 'replyPermission', params: [{ requestId: 'r1', sessionId: 'sess-9', reply: 'allowOnce' }] });
		await waitForSuccess(client, (frame) => frame.command === 'call');
		expect(cli.calls.some((call) => call.method === 'replyPermission')).toBe(true);
		client.close();
	});

	it('listPendingPermissions filters the snapshot to attached sessions (§4.5)', async () => {
		const { hub, cli } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		(cli.listPendingPermissions as unknown as ResolvableMock).mockResolvedValueOnce({
			requests: [
				{ requestId: 'mine', sessionId: 'sess-mine' },
				{ requestId: 'theirs', sessionId: 'sess-theirs' },
			],
		});
		client.send({ type: 'session.attach', id: 'a1', sessionId: 'sess-mine', role: 'owner' });
		await waitForSuccess(client, (frame) => frame.command === 'session.attach');
		client.send({ type: 'call', id: 'lp1', method: 'listPendingPermissions', params: [{}] });
		const response = await waitForSuccess(client, (frame) => frame.command === 'call');
		const requests = (response.data as { requests: Array<{ requestId: string }> }).requests;
		expect(requests.map((request) => request.requestId)).toEqual(['mine']);
		// After detach the snapshot is empty for this connection.
		client.send({ type: 'session.detach', id: 'd1', sessionId: 'sess-mine' });
		await waitForSuccess(client, (frame) => frame.command === 'session.detach');
		client.send({ type: 'call', id: 'lp2', method: 'listPendingPermissions', params: [{}] });
		const empty = await waitForSuccess(client, (frame) => frame.command === 'call');
		expect((empty.data as { requests: unknown[] }).requests).toEqual([]);
		client.close();
	});
});

describe('v2 subscribe: GlobalEvent routing (§4.3.4)', () => {
	it('catalog events broadcast to every subscriber; session events only to attached', async () => {
		const { hub, events } = await setupV2();
		const a = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await helloV2(a, { clientInstanceId: 'w-a' });
		await helloV2(b, { clientInstanceId: 'w-b' });
		a.send({ type: 'session.attach', id: 'a1', sessionId: 'sess-a', role: 'owner' });
		await waitForSuccess(a, (frame) => frame.command === 'session.attach');
		a.send({ type: 'subscribe', id: 's1' });
		b.send({ type: 'subscribe', id: 's1' });
		await waitForSuccess(a, (frame) => frame.command === 'subscribe');
		await waitForSuccess(b, (frame) => frame.command === 'subscribe');

		events.push(catalogEvent('session.created', { sessionId: 'new-1', agentName: 'mavis', sessionType: 'root' }));
		events.push(catalogEvent('session.start', { sessionId: 'sess-a', agentName: 'mavis' }));
		events.push(catalogEvent('session.start', { sessionId: 'sess-b', agentName: 'mavis' }));

		// Window A: catalog + its own session event.
		const aEvents = await collectEvents(a, 2);
		expect(aEvents.map((entry) => entry.event.type).sort()).toEqual(['session.created', 'session.start']);
		expect(aEvents.every((entry) => (entry.event.payload as { sessionId: string }).sessionId !== 'sess-b')).toBe(true);
		// Window B: catalog only.
		const bEvents = await collectEvents(b, 1);
		expect(bEvents.map((entry) => entry.event.type)).toEqual(['session.created']);
		a.close();
		b.close();
	});

	it("scope 'all' delivers everything (mcode exec --watch)", async () => {
		const { hub, events } = await setupV2();
		const watcher = attachClient(hub, 'watch');
		await helloV2(watcher, { clientInstanceId: 'exec' });
		watcher.send({ type: 'subscribe', id: 's1', scope: 'all' });
		await waitForSuccess(watcher, (frame) => frame.command === 'subscribe');
		events.push(catalogEvent('session.start', { sessionId: 'any', agentName: 'mavis' }));
		const seen = await collectEvents(watcher, 1);
		expect(seen[0]?.event.type).toBe('session.start');
		watcher.close();
	});

	it('unknown types fail open: with sessionId → attached, without → everyone', async () => {
		const { hub, events } = await setupV2();
		const a = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await helloV2(a, { clientInstanceId: 'w-a' });
		await helloV2(b, { clientInstanceId: 'w-b' });
		a.send({ type: 'session.attach', id: 'a1', sessionId: 'sess-a', role: 'observer' });
		await waitForSuccess(a, (frame) => frame.command === 'session.attach');
		a.send({ type: 'subscribe', id: 's1' });
		b.send({ type: 'subscribe', id: 's1' });
		await waitForSuccess(a, (frame) => frame.command === 'subscribe');
		await waitForSuccess(b, (frame) => frame.command === 'subscribe');

		events.push(catalogEvent('brand_new.kind', { sessionId: 'sess-a' }));
		events.push(catalogEvent('brand_new.kind', { note: 'global' }));

		const aEvents = await collectEvents(a, 2);
		expect(aEvents).toHaveLength(2);
		const bEvents = await collectEvents(b, 1);
		expect((bEvents[0]?.event.payload as { note?: string }).note).toBe('global');
		a.close();
		b.close();
	});

	it('replays from the ring after a cursor with the SAME filtering, no double delivery', async () => {
		const { hub, events } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client, { clientInstanceId: 'w-r' });
		client.send({ type: 'session.attach', id: 'a1', sessionId: 'sess-a', role: 'owner' });
		await waitForSuccess(client, (frame) => frame.command === 'session.attach');
		client.send({ type: 'subscribe', id: 's1' });
		const first = await waitForSuccess(client, (frame) => frame.command === 'subscribe');

		events.push(catalogEvent('session.created', { sessionId: 'g1', agentName: 'm', sessionType: 'root' }));
		events.push(catalogEvent('session.start', { sessionId: 'sess-a', agentName: 'm' }));
		events.push(catalogEvent('session.start', { sessionId: 'other', agentName: 'm' }));
		await collectEvents(client, 2); // g1 + sess-a; 'other' filtered

		// Replay from cursor 1: the ring window is [sess-a, other] — the same
		// filter applies (sess-a attached, 'other' not), so exactly the
		// sess-a event replays; then live continues WITHOUT re-delivering
		// anything the replay window covered.
		client.send({ type: 'subscribe', id: 's2', after: '1' });
		const second = await waitForSuccess(client, (frame) => frame.command === 'subscribe');
		expect((second.data as { replayed: number }).replayed).toBe(1);
		// Drain the replayed frame; the NEXT event must be the new live one —
		// nothing the replay covered is delivered twice.
		const replayedFrame = await collectEvents(client, 1);
		expect((replayedFrame[0]?.event.payload as { sessionId?: string }).sessionId).toBe('sess-a');
		events.push(catalogEvent('session.created', { sessionId: 'g2', agentName: 'm', sessionType: 'root' }));
		const live = await collectEvents(client, 1);
		expect((live[0]?.event.payload as { sessionId?: string }).sessionId).toBe('g2');
		void first;
		client.close();
	});

	it('answers an evicted cursor with replay_gap and does NOT attach the live stream', async () => {
		const { hub, events } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client, { clientInstanceId: 'w-g' });
		client.send({ type: 'subscribe', id: 's1', after: '99999' });
		const gap = await client.waitFor((frame) => frame.type === 'replay_gap');
		expect(gap).toMatchObject({ type: 'replay_gap', after: '99999' });
		// Live events do not flow into a gapped subscription: give the pump a
		// beat, then assert nothing event-shaped arrived.
		events.push(catalogEvent('session.created', { sessionId: 'x', agentName: 'm', sessionType: 'root' }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.received.some((frame) => frame.type === 'event')).toBe(false);
		client.close();
	});
});

describe('v2 daemon surfaces', () => {
	it('daemon.status reports the health snapshot', async () => {
		const { hub } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client, { clientInstanceId: 'w-s' });
		client.send({ type: 'session.attach', id: 'a1', sessionId: 'sess-1', role: 'owner' });
		await waitForSuccess(client, (frame) => frame.command === 'session.attach');
		client.send({ type: 'daemon.status', id: 'st1' });
		const response = await waitForSuccess(client, (frame) => frame.command === 'daemon.status');
		const status = response.data as Record<string, unknown>;
		expect(status['pid']).toBe(process.pid);
		expect(status['protocol']).toMatchObject({ version: 2 });
		expect(status['connections']).toBe(1);
		expect(status['attachedSessions']).toBe(1);
		expect(status).toHaveProperty('rssBytes');
		expect(status).toHaveProperty('head');
		expect(status).toHaveProperty('globalHead');
		expect(status).toHaveProperty('publishStaleSessions');
		client.close();
	});

	it('daemon.restart now fires the hook immediately; idle schedules, notices and drains (W5)', async () => {
		const restarts: string[] = [];
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => makeFakeCliService() }),
			onRestartRequested: (when) => {
				restarts.push(when);
			},
		});
		const client = attachClient(hub, 'a');
		await helloV2(client);
		client.send({ type: 'daemon.restart', id: 'r1', when: 'now' });
		await waitForSuccess(client, (frame) => frame.command === 'daemon.restart');
		expect(restarts).toEqual(['now']);
		// W5 (§4.6.5): an idle daemon (no turns, no pending asks) drains at
		// once and answers with the scheduled snapshot…
		client.send({ type: 'daemon.restart', id: 'r2', when: 'idle' });
		const scheduled = await waitForSuccess(client, (frame) => frame.command === 'daemon.restart');
		expect(scheduled.data).toMatchObject({
			scheduled: true,
			activeTurns: 0,
			pendingPermissions: 0,
		});
		// …fires the composition's restart hook with `idle`…
		await vi.waitFor(() => expect(restarts).toEqual(['now', 'idle']));
		// …and every connected window sees the `restart-pending` badge.
		const notice = await client.waitFor(
			(frame): frame is Extract<ServerFrame, { type: 'notice' }> =>
				(frame as { type?: string }).type === 'notice',
		);
		expect(notice).toMatchObject({ type: 'notice', kind: 'restart-pending' });
		client.close();
	});

	it('daemon.authSync fires the hook; without one it refuses', async () => {
		let syncs = 0;
		const withHook = await setupHub({
			onAuthSyncRequested: async () => {
				syncs += 1;
			},
		});
		const hooked = attachClient(withHook.hub, 'a');
		await helloV2(hooked);
		hooked.send({ type: 'daemon.authSync', id: 'au1' });
		await waitForSuccess(hooked, (frame) => frame.command === 'daemon.authSync');
		expect(syncs).toBe(1);
		hooked.close();

		const without = await setupHub();
		const bare = attachClient(without.hub, 'b');
		await helloV2(bare);
		bare.send({ type: 'daemon.authSync', id: 'au2' });
		const refused = await waitForFailure(bare, (frame) => frame.command === 'daemon.authSync');
		expect(refused.errorCode).toBe('METHOD_NOT_ALLOWED');
		bare.close();
	});

	it('PROMPT_MODE_MISMATCH refuses a mismatched promptMode hello (§4.4)', async () => {
		const { hub } = await setupHub({ promptMode: 'tui' });
		const client = attachClient(hub, 'a');
		client.send({ type: 'hello', version: 2, promptMode: 'coding' });
		const failure = await client.waitFor(
			(frame): frame is FailedResponse => isResponse(frame) && !frame.success,
		);
		expect(failure.errorCode).toBe('PROMPT_MODE_MISMATCH');
		expect(failure.error).toContain('tui');
		await client.closed();
	});

	it('ping answers pong without touching the hub (works during drain)', async () => {
		const { hub } = await setupV2();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		client.send({ type: 'ping', id: 'beat' });
		const pong = await client.waitFor((frame) => frame.type === 'pong');
		expect(pong.id).toBe('beat');
		client.close();
	});
});

/** Collect `count` v2 event frames in order. */
async function collectEvents(
	client: ReturnType<typeof attachClient>,
	count: number,
): Promise<Array<{ type: 'event'; cursor: string; event: { type: string; payload: Record<string, unknown> } }>> {
	const collected: Array<{ type: 'event'; cursor: string; event: { type: string; payload: Record<string, unknown> } }> = [];
	while (collected.length < count) {
		const frame = await client.waitFor((candidate) => candidate.type === 'event');
		if (frame.type === 'event') {
			collected.push(frame as { type: 'event'; cursor: string; event: { type: string; payload: Record<string, unknown> } });
		}
	}
	return collected;
}

/** Minimal shape of a vitest mock used through the fake CliService cast. */
type RejectableMock = { mockRejectedValueOnce: (error: unknown) => unknown };
type ResolvableMock = { mockResolvedValueOnce: (value: unknown) => unknown };
