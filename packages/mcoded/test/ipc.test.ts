/**
 * The CLI-side IPC helpers over a real unix socket: `helloDaemon` probes the
 * handshake (authorized by the control root's current token), and
 * `requestDaemonShutdown` runs the graceful `shutdown` frame path — the wire
 * the `mcode daemon status|stop` commands use.
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { McodedDaemon } from '../src/daemon.js';
import { helloDaemon, requestDaemonShutdown } from '../src/ipc.js';

const unixSockets = process.platform !== 'win32';
const describeSocket = unixSockets ? describe : describe.skip;

const tempRoots: string[] = [];

beforeEach(() => {
	tempRoots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcoded-ipc-')));
});

afterAll(() => {
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

async function startedDaemon(root: string, handshake: {
	token?: string;
	dataDir?: string;
	env?: { region?: string; buildEnv?: string };
}): Promise<McodedDaemon> {
	const daemon = new McodedDaemon({ root, listenFd: null, handshake });
	await daemon.start();
	return daemon;
}

describeSocket('helloDaemon', () => {
	it('answers a matching handshake and reports the welcome', async () => {
		const root = fs.realpathSync(tempRoots.at(-1) as string);
		const daemon = await startedDaemon(root, {
			token: 'tok',
			dataDir: root,
			env: { region: 'en', buildEnv: 'prod' },
		});
		const outcome = await helloDaemon(daemon.socketPath, {
			token: 'tok',
			dataDir: root,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.data).toMatchObject({ version: 2 });
		await daemon.shutdown();
	});

	it('reports UNAUTHORIZED for a wrong token without throwing', async () => {
		const root = tempRoots.at(-1) as string;
		const daemon = await startedDaemon(root, { token: 'tok' });
		const outcome = await helloDaemon(daemon.socketPath, { token: 'nope' });
		expect(outcome).toMatchObject({ ok: false, errorCode: 'UNAUTHORIZED' });
		await daemon.shutdown();
	});

	it('reports ENOENT for a socket that does not exist', async () => {
		const missing = path.join(tempRoots.at(-1) as string, 'absent.sock');
		const outcome = await helloDaemon(missing, {});
		expect(outcome.ok).toBe(false);
		expect((outcome as { errno?: string }).errno).toBe('ENOENT');
	});
});

describeSocket('requestDaemonShutdown', () => {
	it('runs the graceful path: ack, drain, socket unlinked', async () => {
		const root = tempRoots.at(-1) as string;
		const daemon = await startedDaemon(root, { token: 'tok' });
		// The wiring `mcode daemon stop` relies on: the shutdown frame triggers
		// the composition's graceful path (drain → checkpoint → unlink).
		let teardown: Promise<void> | undefined;
		daemon.hub.onShutdownRequested = () => {
			teardown ??= daemon.shutdown();
		};
		const outcome = await requestDaemonShutdown(daemon.socketPath, { token: 'tok' });
		expect(outcome.ok).toBe(true);
		await teardown;
		expect(daemon.isListening).toBe(false);
		expect(fs.existsSync(daemon.socketPath)).toBe(false);
	});
});
