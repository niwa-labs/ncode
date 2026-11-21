/**
 * W4 (§4.5/D5): approvals push-routing — the PermissionRouter in the hub.
 *
 * Covered here:
 * - the router's priority chain (initiator → owner attach → observer);
 * - push ISOLATION: window B never receives window A's approvals while A's
 *   initiator connection is live (acceptance criterion 1);
 * - the initiator claim keyed by clientInstanceId survives a reconnect;
 * - replay isolation: a (re)subscribe never replays another window's asks;
 * - first-answer-wins at the daemon level (`ALREADY_RESOLVED`);
 * - the stranded-ask path: `permission-waiting` notice and the
 *   `MCODE_DETACHED_PERMISSION=deny` auto-deny;
 * - the per-session toolEnv snapshot store behind `session.attach`.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { CliBridge } from '../src/cli-bridge.js';
import { McodedHub } from '../src/hub.js';
import { PermissionRouter, type RoutableClient } from '../src/permission-router.js';
import { sanitizeSessionToolEnv } from '../src/session-tool-env.js';
import {
	attachClient,
	helloV2,
	isEventFrame,
	setupHub,
	waitForResponse,
	waitForSuccess,
	type TestClient,
} from './helpers.js';

/** Poll until `predicate` holds; rejects after `timeoutMs` (no hanging tests). */
async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('waitUntil: condition never held');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Resolves when NO matching frame arrives within `ms` (isolation assertion). */
async function noEventWithin(client: TestClient, match: (event: { type?: string }) => boolean, ms = 300): Promise<void> {
	const probe = client.waitFor((frame) => isEventFrame(frame) && match(frame.event as { type?: string }));
	return Promise.race([
		probe.then(() => {
			throw new Error('isolation leaked: the ask reached the wrong window');
		}),
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
	]);
}
import { catalogEvent, makeFakeCliService, makeGlobalEventSource, type FakeCliService } from './v2-fakes.js';

function ask(sessionId: string, requestId: string, toolName = 'bash'): unknown {
	return catalogEvent('permission.ask', { requestId, sessionId, toolName });
}

function resolved(sessionId: string, requestId: string): unknown {
	return catalogEvent('permission.resolved', { requestId, sessionId, decision: 'allowOnce' });
}

const clientView = (
	clientInstanceId: string | null,
	attachments: Record<string, 'owner' | 'observer'>,
): RoutableClient => ({ clientInstanceId, attachments: new Map(Object.entries(attachments)) });

describe('PermissionRouter (§4.5 п.1-2)', () => {
	it('routes the ask to the connected initiator window', () => {
		const router = new PermissionRouter();
		router.recordTurnInitiator('s1', 'win-a');
		const a = clientView('win-a', {});
		const b = clientView('win-b', { s1: 'owner' });
		expect(router.routeAsk('s1', [a, b])).toEqual([a]);
		// isolation holds through allowsDelivery too
		expect(router.allowsDelivery(a, { type: 'permission.ask', payload: { sessionId: 's1' } }, [a, b])).toBe(true);
		expect(router.allowsDelivery(b, { type: 'permission.ask', payload: { sessionId: 's1' } }, [a, b])).toBe(false);
	});

	it('falls back to owner-attached windows, then observers, then nobody', () => {
		const router = new PermissionRouter();
		const owner = clientView('win-b', { s1: 'owner' });
		const observer = clientView('win-c', { s1: 'observer' });
		expect(router.routeAsk('s1', [owner, observer])).toEqual([owner]);
		expect(router.routeAsk('s1', [observer])).toEqual([observer]);
		expect(router.routeAsk('s1', [])).toEqual([]);
	});

	it('a disconnected initiator falls through to the attach fallback', () => {
		const router = new PermissionRouter();
		router.recordTurnInitiator('s1', 'win-a');
		const owner = clientView('win-b', { s1: 'owner' });
		// win-a is NOT connected here
		expect(router.routeAsk('s1', [owner])).toEqual([owner]);
	});

	it('a fresh turn overwrites the initiator claim; the map stays bounded', () => {
		const router = new PermissionRouter();
		router.recordTurnInitiator('s1', 'win-a');
		router.recordTurnInitiator('s1', 'win-a2');
		expect(router.turnInitiator('s1')).toBe('win-a2');
		for (let index = 0; index < 300; index += 1) router.recordTurnInitiator(`s-${index}`, 'win-x');
		expect(router.turnInitiator('s-0')).toBeUndefined(); // evicted oldest
		expect(router.turnInitiator('s-299')).toBe('win-x');
	});

	it('non-ask events are never rerouted by the router', () => {
		const router = new PermissionRouter();
		router.recordTurnInitiator('s1', 'win-a');
		const b = clientView('win-b', { s1: 'owner' });
		expect(router.allowsDelivery(b, { type: 'session.start', payload: { sessionId: 's1' } }, [])).toBe(true);
	});
});

interface Rig {
	hub: McodedHub;
	cli: FakeCliService;
	events: ReturnType<typeof makeGlobalEventSource>;
}

async function setupV4(overrides: Partial<Parameters<typeof setupHub>[0]> = {}): Promise<Rig> {
	const cli = makeFakeCliService();
	const events = makeGlobalEventSource();
	const { hub } = await setupHub({
		bridge: new CliBridge({ cliService: () => cli }),
		globalEvents: events,
		...overrides,
	});
	return { hub, cli, events };
}

/** Open a turn stream so the hub records the caller as the session's initiator. */
async function openTurn(client: TestClient, sessionId: string): Promise<void> {
	client.send({
		type: 'stream.open',
		id: `open-${sessionId}`,
		method: 'sendMessage',
		params: [{ id: sessionId, content: 'go' }],
		credit: 8,
	});
	await waitForResponse(client, (frame) => frame.command === 'stream.open');
}

async function attachAndSubscribe(client: TestClient, sessionId?: string): Promise<void> {
	await helloV2(client);
	if (sessionId !== undefined) {
		client.send({ type: 'session.attach', id: `att-${sessionId}`, sessionId, role: 'owner' });
		await waitForSuccess(client, (frame) => frame.command === 'session.attach');
	}
	client.send({ type: 'subscribe', id: 'sub-1' });
	await waitForSuccess(client, (frame) => frame.command === 'subscribe');
}

describe('hub ask routing (§4.5, W4)', () => {
	it('isolates approvals: the initiator window sees the ask, a co-attached window does not', async () => {
		const { hub, cli, events } = await setupV4();
		const a = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await attachAndSubscribe(a, 's1');
		await attachAndSubscribe(b, 's1');
		await openTurn(a, 's1'); // A initiates the turn of s1

		events.push(ask('s1', 'req-1'));

		const seen = await a.waitFor(isEventFrame);
		expect((seen.event as { type: string }).type).toBe('permission.ask');
		// B is owner-attached and subscribed — and STILL must not see A's ask.
		await noEventWithin(b, (event) => event.type === 'permission.ask');
		b.close();
		a.close();
		void cli;
	});

	it('when the initiator disconnects, the ask falls back to the owner-attached window', async () => {
		const { hub, events } = await setupV4();
		const a = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await attachAndSubscribe(a, 's1');
		await attachAndSubscribe(b, 's1');
		await openTurn(a, 's1');

		a.close();
		await waitUntil(() => hub.connectionCount === 1);

		events.push(ask('s1', 'req-2'));
		const seen = await b.waitFor(isEventFrame);
		expect((seen.event as { type: string; payload: { requestId: string } }).payload.requestId).toBe('req-2');
		b.close();
	});

	it('the initiator claim is keyed by clientInstanceId: a reconnecting window keeps its asks', async () => {
		const { hub, events } = await setupV4();
		const a1 = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await attachAndSubscribe(a1, 's1');
		await attachAndSubscribe(b, 's1');
		await openTurn(a1, 's1');

		// "Reconnect": same clientInstanceId, fresh connection.
		a1.close();
		const a2 = attachClient(hub, 'a');
		await attachAndSubscribe(a2, 's1');

		events.push(ask('s1', 'req-3'));
		const seen = await a2.waitFor(isEventFrame);
		expect((seen.event as { payload: { requestId: string } }).payload.requestId).toBe('req-3');
		await noEventWithin(b, (event) => event.type === 'permission.ask');
		a2.close();
		b.close();
	});

	it('the replay filter isolates asks the same way live delivery does', async () => {
		const { hub, events } = await setupV4();
		const a = attachClient(hub, 'a');
		await attachAndSubscribe(a, 's1');
		await openTurn(a, 's1');
		events.push(ask('s1', 'req-4'));
		await a.waitFor(isEventFrame);

		// B attaches AFTER the ask and replays the whole ring — the ask of
		// A's live turn must not come back through the replay window.
		const b = attachClient(hub, 'b');
		await attachAndSubscribe(b, 's1');
		await noEventWithin(b, (event) => event.type === 'permission.ask');
		a.close();
		b.close();
	});

	it('first answer wins: a reply after permission.resolved answers ALREADY_RESOLVED', async () => {
		const { hub, cli, events } = await setupV4();
		const a = attachClient(hub, 'a');
		await attachAndSubscribe(a, 's1');
		events.push(ask('s1', 'req-5'));
		await a.waitFor(isEventFrame);

		clientReply(a, 'p1', 'req-5');
		await waitForSuccess(a, (frame) => frame.command === 'call');
		expect(cli.calls.some((call) => call.method === 'replyPermission')).toBe(true);

		events.push(resolved('s1', 'req-5'));
		await a.waitFor((frame) => isEventFrame(frame) && (frame.event as { type?: string }).type === 'permission.resolved');

		clientReply(a, 'p2', 'req-5');
		const refused = (await waitForResponse(
			a,
			(frame) => frame.command === 'call' && frame.success === false,
		)) as { success: false; errorCode?: string };
		expect(refused.errorCode).toBe('ALREADY_RESOLVED');
		// the runtime saw exactly ONE reply
		expect(cli.calls.filter((call) => call.method === 'replyPermission')).toHaveLength(1);
		a.close();
	});

	it('a stranded ask notifies every connected window (permission-waiting)', async () => {
		const { hub, events } = await setupV4();
		const watcher = attachClient(hub, 'w');
		await helloV2(watcher); // subscribed to nothing, attached to nothing
		events.push(ask('s-elsewhere', 'req-6'));
		const notice = await watcher.waitFor((frame) => frame.type === 'notice');
		expect((notice as { kind: string }).kind).toBe('permission-waiting');
		watcher.close();
	});

	it('MCODE_DETACHED_PERMISSION=deny auto-denies a stranded ask through the runtime', async () => {
		const { hub, cli, events } = await setupV4({ detachedPermission: 'deny' });
		const watcher = attachClient(hub, 'w');
		await helloV2(watcher);
		events.push(ask('s-none', 'req-7'));
		await watcher.waitFor((frame) => frame.type === 'notice');
		await waitUntil(() => cli.calls.some((call) => call.method === 'replyPermission'), 1_000);
		const deny = cli.calls.find((call) => call.method === 'replyPermission');
		expect(deny?.args[0]).toMatchObject({ requestId: 'req-7', reply: 2 });
		// The auto-deny executed WITHOUT any attach (internal hub invocation):
		// the §4.5 attach rule would have refused a window reply like this.
		expect(deny?.args[1]).toMatchObject({ signal: expect.anything() });
		watcher.close();
	});
});

function clientReply(client: TestClient, id: string, requestId: string): void {
	client.send({
		type: 'call',
		id,
		method: 'replyPermission',
		params: [{ requestId, sessionId: 's1', reply: 'allowOnce' }],
	});
}

describe('session toolEnv snapshots (§4.4, W4)', () => {
	it('an owner attach stores the snapshot; daemon-reserved names are stripped', async () => {
		const { hub } = await setupV4();
		const a = attachClient(hub, 'a');
		await helloV2(a);
		a.send({
			type: 'session.attach',
			id: 'att-1',
			sessionId: 's1',
			role: 'owner',
			toolEnv: { cwd: '/home/dev/proj', env: { VIRTUAL_ENV: '/venv', MCODE_SECRET: 'x', MINIMAX_KEY: 'y' } },
		});
		await waitForSuccess(a, (frame) => frame.command === 'session.attach');
		const snapshot = hub.sessionToolEnv.get('s1');
		expect(snapshot?.cwd).toBe('/home/dev/proj');
		expect(snapshot?.env).toMatchObject({ VIRTUAL_ENV: '/venv' });
		expect(snapshot?.env).not.toHaveProperty('MCODE_SECRET');
		expect(snapshot?.env).not.toHaveProperty('MINIMAX_KEY');
		a.close();
	});

	it('an observer attach never overwrites the owner snapshot', async () => {
		const { hub } = await setupV4();
		const a = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await helloV2(a);
		await helloV2(b);
		a.send({ type: 'session.attach', id: 'a1', sessionId: 's1', role: 'owner', toolEnv: { env: { OWNER: '1' } } });
		await waitForSuccess(a, (frame) => frame.command === 'session.attach');
		b.send({ type: 'session.attach', id: 'b1', sessionId: 's1', role: 'observer', toolEnv: { env: { OBSERVER: '1' } } });
		await waitForSuccess(b, (frame) => frame.command === 'session.attach');
		expect(hub.sessionToolEnv.get('s1')?.env).toEqual({ OWNER: '1' });
		a.close();
		b.close();
	});

	it('sanitizeSessionToolEnv strips daemon-reserved prefixes', () => {
		expect(sanitizeSessionToolEnv({ PATH: '/bin', MCODE_X: '1', MINIMAX_Y: '2' })).toEqual({ PATH: '/bin' });
	});
});
