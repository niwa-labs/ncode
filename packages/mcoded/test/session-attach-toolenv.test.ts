/**
 * The `session.attach.toolEnv` channel, end to end over the in-memory
 * loopback (revision 11 F3): the window's env/cwd snapshot reaches the
 * daemon's per-session store — and the UPDATE path works, so the window's
 * environment is never frozen at the daemon's first spawn.
 *
 * The SENDER lives in the TUI thin client (`buildWindowToolEnvSnapshot` in
 * tui/src/runtime/remote-host.ts, covered there); this file pins the wire and
 * the daemon-side semantics the sender relies on:
 * - an owner attach with a snapshot feeds the store (MCODE_* and MINIMAX_*
 *   re-stripped on the daemon side — defense in depth);
 * - a LATER owner attach with a fresh snapshot REPLACES it (the update path
 *   the turn-start attaches exercise);
 * - an observer attach never overwrites;
 * - the client retains the latest snapshot and re-sends it verbatim on
 *   reconnect (§4.6.3 re-attach), so the env survives a daemon/network death.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McodedClient } from '../src/client.js';
import { CliBridge } from '../src/cli-bridge.js';
import { McodedHub } from '../src/hub.js';
import { InMemoryCheckpointStore } from '../src/checkpoint.js';
import { createInMemoryTransportPair, type LineTransport } from '../src/transport.js';
import { makeFakeCliService, makeGlobalEventSource } from './v2-fakes.js';

function makeRig() {
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
	const rig = {
		hub,
		connect(): McodedClient {
			const client = new McodedClient({
				socketPath: 'memory://',
				handshake: { clientInstanceId: `client-${Math.random().toString(36).slice(2)}` },
				connect: async () => {
					if (!hubStarted) {
						await hub.start();
						hubStarted = true;
					}
					const [clientSide, serverSide] = createInMemoryTransportPair();
					hub.attachTransport(serverSide);
					serverSides.set(client, serverSide);
					return clientSide;
				},
			});
			clients.add(client);
			return client;
		},
		/** Drop the SERVER side; the client's reconnect loop takes over. */
		sever(client: McodedClient): void {
			serverSides.get(client)?.end();
		},
	};
	return rig;
}

const clients = new Set<McodedClient>();

afterEach(() => {
	for (const client of clients) client.close();
	clients.clear();
});

describe('session.attach.toolEnv (revision 11 F3)', () => {
	let rig: ReturnType<typeof makeRig>;

	beforeEach(() => {
		rig = makeRig();
	});

	it('an owner attach feeds the daemon store, daemon-reserved keys re-stripped', async () => {
		const client = rig.connect();
		await client.connect();
		await client.sessionAttach('sess-a', 'owner', {
			cwd: '/window/workdir',
			env: { VIRTUAL_ENV: '/window/venv', MCODE_REGION: 'cn', MINIMAX_PROFILE: 'work' },
		});
		expect(rig.hub.sessionToolEnv.get('sess-a')).toEqual({
			cwd: '/window/workdir',
			env: { VIRTUAL_ENV: '/window/venv' },
		});
	});

	it('a later owner attach REPLACES the snapshot (the env update path)', async () => {
		const client = rig.connect();
		await client.connect();
		await client.sessionAttach('sess-b', 'owner', {
			cwd: '/window/first',
			env: { PATH: '/first/bin' },
		});
		// The window shell changed its environment between turns; the next
		// turn-start attach carries the fresh snapshot.
		await client.sessionAttach('sess-b', 'owner', {
			cwd: '/window/second',
			env: { PATH: '/second/bin', AWS_PROFILE: 'work' },
		});
		expect(rig.hub.sessionToolEnv.get('sess-b')).toEqual({
			cwd: '/window/second',
			env: { PATH: '/second/bin', AWS_PROFILE: 'work' },
		});
	});

	it('an observer attach never overwrites the owner snapshot', async () => {
		const client = rig.connect();
		await client.connect();
		await client.sessionAttach('sess-c', 'owner', { cwd: '/owner', env: { A: '1' } });
		await client.sessionAttach('sess-c', 'observer', { cwd: '/observer', env: { A: '2' } });
		expect(rig.hub.sessionToolEnv.get('sess-c')).toEqual({ cwd: '/owner', env: { A: '1' } });
	});

	it('the client re-sends the retained snapshot verbatim on reconnect', async () => {
		const client = rig.connect();
		await client.connect();
		await client.sessionAttach('sess-d', 'owner', {
			cwd: '/window/live',
			env: { VIRTUAL_ENV: '/window/venv' },
		});
		expect(rig.hub.sessionToolEnv.get('sess-d')).toBeDefined();

		// The transport dies (daemon restart / network blip); the client's
		// §4.6.3 re-attach must carry the RETAINED snapshot so the new daemon
		// life serves the same window env.
		rig.sever(client);
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(client.connectionState).toBe('ready');
		expect(rig.hub.sessionToolEnv.get('sess-d')).toEqual({
			cwd: '/window/live',
			env: { VIRTUAL_ENV: '/window/venv' },
		});
	});
});
