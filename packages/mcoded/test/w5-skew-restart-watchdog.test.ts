/**
 * W5 (§4.6.4/§4.6.5): version-skew and lifecycle — the review findings:
 *
 * 1. `hello.features` are ENFORCED, not just declared: the daemon reads the
 *    client's declared set and refuses gated frames with
 *    `FEATURE_UNSUPPORTED`; the client checks the daemon's advertised set
 *    (`requireFeature`) before using a v2 frame and fails loudly on skew.
 * 2. `daemon.restart{when:'idle'}` is wired: the daemon answers with the
 *    busy snapshot, badges every window `notice{kind:'restart-pending'}`,
 *    and drains ONLY when the live turn streams and pending asks clear —
 *    including a turn whose originator connection DIED (I-DETACH tail).
 * 3. The crash-loop watchdog (§4.6.4): 3 dead daemon lives within the
 *    window stop the respawning, with the log path and the
 *    `MCODE_SERVER_MODE=off` hint in the error; hysteresis keeps the trip
 *    through the cooldown instead of flip-flopping.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import type { ServerFrame } from '../src/protocol.js';

import { CliBridge } from '../src/cli-bridge.js';
import { McodedClient } from '../src/client.js';
import {
	CRASH_LOOP_COOLDOWN_MS,
	CrashLoopWatchdog,
	McodedCrashLoopError,
} from '../src/crash-loop-watchdog.js';
import { McodedHub } from '../src/hub.js';
import {
	attachClient,
	helloV2,
	setupHub,
	waitForFailure,
	waitForSuccess,
	type TestClient,
} from './helpers.js';

/** A CliService double whose `sendMessage` source the test controls. */
function gatedCli() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	let release: (() => void) | undefined;
	return {
		calls,
		releaseTurn: () => release?.(),
		cli: {
			getSession: async () => ({}),
			createSession: async () => ({ session: { id: 's1' } }),
			getPendingQuestionnaire: async () => ({}),
			listPendingPermissions: async () => ({ requests: [] }),
			abortSession: async () => ({ success: true }),
			isGoalEnabled: () => false,
			getSessionPublishStaleSessions: () => [] as readonly string[],
			sendMessage: async (...args: unknown[]) => {
				calls.push({ method: 'sendMessage', args });
				return {
					ok: true,
					source: (async function* () {
						await new Promise<void>((resolve) => {
							release = resolve;
						});
						yield { dataJson: '[DONE]' };
					})(),
				};
			},
		},
	};
}

describe('W5 skew: hello.features are enforced on both sides (§4.6.5)', () => {
	it('the daemon refuses a gated frame a client did NOT declare (FEATURE_UNSUPPORTED)', async () => {
		const double = gatedCli();
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => double.cli as never }),
		});
		// Declare ONLY `call` — `stream` is not in the set.
		const client = attachClient(hub, 'skew');
		client.send({
			type: 'hello',
			version: 2,
			minor: 1,
			features: ['call'],
			clientInstanceId: 'skew-1',
		});
		await waitForSuccess(client, (frame) => frame.command === 'hello');

		client.send({ type: 'call', id: 'c1', method: 'getSession', params: [{ id: 's1' }] });
		await waitForSuccess(client, (frame) => frame.command === 'call');

		client.send({
			type: 'stream.open',
			id: 's1',
			method: 'sendMessage',
			params: [{ id: 's1', message: 'hi' }],
		});
		const refused = await waitForFailure(client, (frame) => frame.command === 'stream.open');
		expect(refused.errorCode).toBe('FEATURE_UNSUPPORTED');
		expect(refused.error).toContain('"stream"');
		client.close();
	});

	it('a client that declares nothing (v1 shim shape) stays ungated', async () => {
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => ({}) as never }),
		});
		const client = attachClient(hub, 'legacy');
		client.send({ type: 'hello', version: 2, minor: 1, clientInstanceId: 'legacy-1' });
		await waitForSuccess(client, (frame) => frame.command === 'hello');
		client.send({
			type: 'stream.open',
			id: 's1',
			method: 'sendMessage',
			params: [{ id: 's1', message: 'hi' }],
		});
		const answered = await waitForFailure(client, (frame) => frame.command === 'stream.open');
		// No declared set → the daemon cannot verify → no FEATURE gate.
		expect(answered.errorCode).not.toBe('FEATURE_UNSUPPORTED');
		client.close();
	});

	it('the client fails LOUDLY on a daemon that does not advertise a feature', async () => {
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => ({}) as never }),
		});
		const client = attachClient(hub, 'old-daemon');
		client.send({
			// Simulate an OLDER daemon: no `restart-when-idle` in its welcome.
			type: 'hello',
			version: 2,
			minor: 0,
			clientInstanceId: 'old-1',
		});
		await waitForSuccess(client, (frame) => frame.command === 'hello');
		// The client-side gate against a welcome that lacks the feature (the
		// v2.0 welcome shape): requireFeature must demand a daemon restart.
		const wire = new McodedClient({
			socketPath: '/w5-not-dialed.sock',
			handshake: {},
		});
		(wire as unknown as { welcome: { features?: string[] } }).welcome = {
			features: ['call', 'stream', 'attach', 'subscribe'],
		};
		(wire as unknown as { state: string }).state = 'ready';
		expect(() => wire.requireFeature('call')).not.toThrow();
		expect(() => wire.requireFeature('restart-when-idle')).toThrow(/mcode daemon restart/);
		// A welcome WITHOUT features (v1 shim / bare peer) is not verifiable.
		(wire as unknown as { welcome: { features?: string[] } }).welcome = {};
		expect(() => wire.requireFeature('restart-when-idle')).not.toThrow();
		client.close();
	});
});

describe('W5 restart-when-idle: drains only when turns and asks clear (§4.6.5)', () => {
	it('busy: schedules, badges restart-pending, fires after the live turn ends', async () => {
		vi.useRealTimers();
		const double = gatedCli();
		const restarts: string[] = [];
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => double.cli as never }),
			idleRestartPollMs: 5,
			onRestartRequested: (when) => {
				restarts.push(when);
			},
		});
		const client = attachClient(hub, 'w');
		await helloV2(client);

		// Open a LIVE turn stream (the source hangs until releaseTurn).
		client.send({
			type: 'stream.open',
			id: 't1',
			method: 'sendMessage',
			params: [{ id: 's1', message: 'long turn' }],
		});
		await waitForSuccess(client, (frame) => frame.command === 'stream.open');
		expect(hub.activeTurnCount).toBe(1);

		// A second window watches the badge.
		const watcher = attachClient(hub, 'w2');
		await helloV2(watcher);

		client.send({ type: 'daemon.restart', id: 'r1', when: 'idle' });
		const scheduled = await waitForSuccess(client, (frame) => frame.command === 'daemon.restart');
		expect(scheduled.data).toMatchObject({ scheduled: true, activeTurns: 1, pendingPermissions: 0 });
		// The hook has NOT fired while the turn runs.
		expect(restarts).toEqual([]);
		// Both windows got the badge.
		const badge = await (watcher as TestClient).waitFor(
			(frame): frame is Extract<ServerFrame, { type: 'notice' }> =>
				(frame as { type?: string }).type === 'notice',
		);
		expect(badge).toMatchObject({ type: 'notice', kind: 'restart-pending', activeTurns: 1 });

		// The turn completes → the daemon drains.
		double.releaseTurn();
		await vi.waitFor(() => expect(restarts).toEqual(['idle']), { timeout: 2_000 });
		// The live-turn count cleared; status reflects the restart state.
		expect(hub.activeTurnCount).toBe(0);
		client.close();
		watcher.close();
	});

	it('a DETACHED turn (window died mid-turn) still holds the restart (I-DETACH tail)', async () => {
		const double = gatedCli();
		const restarts: string[] = [];
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => double.cli as never }),
			idleRestartPollMs: 5,
			onRestartRequested: (when) => {
				restarts.push(when);
			},
		});
		const client = attachClient(hub, 'w');
		await helloV2(client);
		client.send({
			type: 'stream.open',
			id: 't1',
			method: 'sendMessage',
			params: [{ id: 's1', message: 'outlives its window' }],
		});
		await waitForSuccess(client, (frame) => frame.command === 'stream.open');
		client.send({ type: 'daemon.restart', id: 'r1', when: 'idle' });
		await waitForSuccess(client, (frame) => frame.command === 'daemon.restart');
		// The window DIES: the mux detaches, the pump keeps draining (I-DETACH).
		client.close();
		expect(hub.activeTurnCount).toBe(1);
		expect(restarts).toEqual([]);

		double.releaseTurn();
		await vi.waitFor(() => expect(restarts).toEqual(['idle']), { timeout: 2_000 });
	});

	it('a pending ask holds the restart; the resolution releases it', async () => {
		const events = (await import('./v2-fakes.js')).makeGlobalEventSource();
		const restarts: string[] = [];
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => gatedCli().cli as never }),
			globalEvents: events,
			idleRestartPollMs: 5,
			onRestartRequested: (when) => {
				restarts.push(when);
			},
		});
		const client = attachClient(hub, 'w');
		await helloV2(client);

		events.push({
			type: 'permission.ask',
			payload: { requestId: 'ask-1', sessionId: 's1', toolName: 'bash' },
		});
		await vi.waitFor(() => expect(hub.pendingPermissionCount).toBe(1));

		client.send({ type: 'daemon.restart', id: 'r1', when: 'idle' });
		const scheduled = await waitForSuccess(client, (frame) => frame.command === 'daemon.restart');
		expect(scheduled.data).toMatchObject({ pendingPermissions: 1 });
		expect(restarts).toEqual([]);

		events.push({
			type: 'permission.resolved',
			payload: { requestId: 'ask-1', sessionId: 's1', decision: 'allowOnce' },
		});
		await vi.waitFor(() => expect(restarts).toEqual(['idle']), { timeout: 2_000 });
		client.close();
	});
});

describe('W5 crash-loop watchdog (§4.6.4)', () => {
	it('trips at 3 dead lives in the window and names the log path + the off hint', () => {
		const now = { value: 1_000 };
		const watchdog = new CrashLoopWatchdog({
			windowMs: 60_000,
			maxCrashes: 3,
			cooldownMs: 60_000,
			logPath: '/ctrl/logs/mcoded.log',
			now: () => now.value,
		});
		expect(watchdog.recordCrash()).toEqual({ allowSpawn: true });
		expect(watchdog.recordCrash()).toEqual({ allowSpawn: true });
		const third = watchdog.recordCrash();
		expect(third.allowSpawn).toBe(false);
		// The user-facing half: the log path and MCODE_SERVER_MODE=off.
		let message = '';
		try {
			watchdog.requireSpawn();
		} catch (error) {
			message = (error as McodedCrashLoopError).message;
		}
		expect(error_name_of(watchdog)).toBe('McodedCrashLoopError');
		expect(message).toContain('/ctrl/logs/mcoded.log');
		expect(message).toContain('MCODE_SERVER_MODE=off');
		// Hysteresis: mid-cooldown the trip persists…
		now.value = 1_000 + 30_000;
		expect(watchdog.canSpawn()).toBe(false);
		// …and a fresh crash DURING the cooldown extends it past the original
		// deadline (no flip-flopping on `trippedAt + cooldown` alone): at
		// 61s the deadline passed, but the 31s crash still fills the window.
		now.value = 1_000 + 30_000 + 1;
		watchdog.recordCrash();
		now.value = 1_000 + CRASH_LOOP_COOLDOWN_MS + 1;
		expect(watchdog.canSpawn()).toBe(false);
		// Fully quiet past both the window and the cooldown → un-trips.
		now.value = 1_000 + 30_000 + 1 + 60_001;
		expect(watchdog.canSpawn()).toBe(true);
	});

	it('un-trips after the cooldown with a quiet window (hysteresis release)', () => {
		const now = { value: 0 };
		const watchdog = new CrashLoopWatchdog({
			windowMs: 60_000,
			maxCrashes: 3,
			cooldownMs: 60_000,
			now: () => now.value,
		});
		for (let index = 0; index < 3; index += 1) watchdog.recordCrash();
		expect(watchdog.canSpawn()).toBe(false);
		now.value = 60_001; // crashes left the window long ago, cooldown passed
		expect(watchdog.canSpawn()).toBe(true);
		expect(watchdog.recordCrash()).toEqual({ allowSpawn: true });
	});

	it('a no-op spawn round (sibling window) never counts as a crash; the client throws the trip error', async () => {
		// The client-side integration: every spawn hook round starts a "child"
		// and the connect still fails — the third trip stops the loop. The
		// connect override is the REAL unix-socket dial (ENOENT → the retry
		// path), no fake error class.
		let spawnRounds = 0;
		const client = new McodedClient({
			socketPath: '/w5-nowhere.sock',
			handshake: {},
			spawn: async () => {
				spawnRounds += 1;
				return true;
			},
			crashLoop: new CrashLoopWatchdog({
				windowMs: 60_000,
				maxCrashes: 3,
				cooldownMs: 60_000,
				logPath: '/ctrl/logs/mcoded.log',
			}),
			readyTimeoutMs: 2_000,
			backoffMinMs: 1,
			backoffMaxMs: 1,
		});
		await expect(client.connect()).rejects.toThrow(McodedCrashLoopError);
		// 3 spawn rounds (each a dead daemon life), then the watchdog refuses.
		expect(spawnRounds).toBe(3);
	});

	it('a hook that spawns NOTHING (daemon alive elsewhere) never trips the watchdog', async () => {
		let spawnRounds = 0;
		const client = new McodedClient({
			socketPath: '/w5-nowhere.sock',
			handshake: {},
			spawn: async () => {
				spawnRounds += 1;
				return false; // the sibling-window no-op path
			},
			crashLoop: new CrashLoopWatchdog({ windowMs: 60_000, maxCrashes: 3, cooldownMs: 60_000 }),
			readyTimeoutMs: 300,
			backoffMinMs: 1,
			backoffMaxMs: 1,
		});
		// Deadline exhaustion — the underlying dial error, NOT a crash-loop trip.
		await expect(client.connect()).rejects.toThrow(/ENOENT|nowhere/);
		expect(spawnRounds).toBeGreaterThan(0);
	});
});

/** The watchdog's thrown error class name (typed access without a cast chain). */
function error_name_of(watchdog: CrashLoopWatchdog): string {
	try {
		watchdog.requireSpawn();
	} catch (error) {
		return (error as Error).name;
	}
	return 'did-not-throw';
}
