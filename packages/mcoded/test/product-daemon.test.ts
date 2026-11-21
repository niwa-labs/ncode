/**
 * The product daemon composition (W2): the SERVER_MODE gate, the
 * control/data split (the runtime host opens the PROFILE dataDir, never the
 * control root), `daemon.json` state transitions, the per-start token, the
 * dataDir binding refusal, and the v2 handshake enforced end-to-end over the
 * real socket — with the runtime host stubbed at the same seam the TUI
 * composition injects `createEmbeddedRuntimeHost` into.
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreatedLocalRuntimeHost } from '@mavis/local-runtime-v2/process-local';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';
import {
	MCODE_SERVER_MODE_ENV,
	ServerModeOffError,
	resolveMcodedSocketPath,
	resolveDurableRoot,
} from '@mavis/config';

import {
	DaemonManifestError,
	ProfileDataDirMismatchError,
	readDaemonToken,
	resolveDaemonTargets,
	startProductDaemon,
	type ProductDaemonHandle,
	type ProductDaemonHostFactory,
} from '../src/product-daemon.js';
import { helloDaemon, requestDaemonShutdown } from '../src/ipc.js';
import { parseMcodedArgs } from '../src/main.js';
// The WINDOW side of the login-wave integration below: the thin-client
// composition lives in the tui package (the spawn hole it closes is there).
// Cross-package SOURCE import in a test is the established precedent
// (local-runtime-adapter.smoke.test.ts imports local-runtime-v2 the same way).
import { createRemoteRuntimeHost } from '../../../packages/tui/src/runtime/remote-host.js';

const tempHomes: string[] = [];
const handles: ProductDaemonHandle[] = [];

/**
 * The home the tests resolve against, already realpath'd: the product daemon
 * pins the data plane to a realpath, and macOS tmpdirs live behind a
 * `/var` → `/private/var` symlink, so assertions must join the same spelling.
 */
function currentHome(): string {
	return fs.realpathSync(tempHomes.at(-1) as string);
}
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ['MAVIS_REGION', 'MAVIS_BUILD_ENV', 'MINIMAX_PROFILE', 'MINIMAX_DATA_DIR'];

beforeEach(() => {
	tempHomes.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcoded-product-')));
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env['MAVIS_REGION'] = 'en';
	process.env['MAVIS_BUILD_ENV'] = 'prod';
});

afterEach(async () => {
	for (const handle of handles.splice(0)) {
		await handle.stop().catch(() => undefined);
	}
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

afterAll(() => {
	for (const home of tempHomes) {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

/**
 * Host stub over the CliService surface the adapter touches — the same seam
 * `createEmbeddedRuntimeHost` plugs into from the TUI composition. Captures
 * the options so tests can pin WHERE the host was pointed. The factory is
 * typed exactly like the injection seam ({@link ProductDaemonHostFactory}):
 * the host-policy fields the real TUI factory pins are absent by contract.
 */
function stubHostFactory(): {
	factory: ProductDaemonHostFactory;
	calls: Parameters<ProductDaemonHostFactory>[0][];
} {
	const calls: Parameters<ProductDaemonHostFactory>[0][] = [];
	const factory: ProductDaemonHostFactory = async (options) => {
		calls.push(options);
		const cli = {
			createSession: async () => ({ sessionId: 'sess-product' }),
		} as unknown as CliService;
		return {
			dataDir: options.dataDir,
			ready: Promise.resolve(),
			apiHost: {
				close: async () => undefined,
				ensureBuiltinAgents: async () => undefined,
			},
			metricsClient: { close: async () => undefined },
			cliService: cli,
		} as unknown as CreatedLocalRuntimeHost;
	};
	return { factory, calls };
}

function productEnv(home: string): NodeJS.ProcessEnv {
	return { [MCODE_SERVER_MODE_ENV]: 'auto', HOME: home };
}

describe('SERVER_MODE gate (arch §4.8)', () => {
	it('refuses to start while off, with SERVER_MODE_OFF, touching nothing', async () => {
		const home = currentHome();
		const env = { [MCODE_SERVER_MODE_ENV]: 'off', HOME: home };
		await expect(startProductDaemon({ env, homeDir: home })).rejects.toBeInstanceOf(
			ServerModeOffError,
		);
		// Nothing was created: no durable root, no manifest, no token.
		expect(fs.existsSync(path.join(home, '.mcode-durable'))).toBe(false);
		expect(fs.existsSync(path.join(home, '.minimax'))).toBe(false);
	});

	it('allows the DEFAULT (unset) mode — auto since the owner flip on 2026-10-29', async () => {
		const home = currentHome();
		const { factory } = stubHostFactory();
		const handle = await startProductDaemon({
			env: { HOME: home },
			homeDir: home,
			createHost: factory,
		});
		handles.push(handle);
		expect(handle).toBeTruthy();
	});

	it('removes the mode switch from the daemon environment after the gate', async () => {
		const home = currentHome();
		const env = productEnv(home);
		const { factory } = stubHostFactory();
		const handle = await startProductDaemon({ env, homeDir: home, createHost: factory });
		handles.push(handle);
		// Child tools (mcode exec via bash-tool) must inherit their caller's
		// behavior, not the daemon's mode (§4.8).
		expect(env[MCODE_SERVER_MODE_ENV]).toBeUndefined();
	});
});

describe('control/data split (arch §2.2 — the W2 headline)', () => {
	it('serves the profile dataDir with the control plane in the default durable root', async () => {
		const home = currentHome();
		const { factory, calls } = stubHostFactory();
		const handle = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: factory,
		});
		handles.push(handle);

		const controlRoot = resolveDurableRoot(null, home);
		const dataDir = path.join(home, '.minimax');
		expect(handle.controlRoot).toBe(controlRoot);
		expect(handle.dataDir).toBe(dataDir);
		// The RUNTIME opens the data plane — never the control root.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.dataDir).toBe(dataDir);
		expect(fs.existsSync(path.join(dataDir, 'workspace'))).toBe(true);

		// daemon.json: ready state, the full identity (§2.2), 0600.
		const manifest = JSON.parse(fs.readFileSync(handle.manifestPath, 'utf8')) as Record<
			string,
			unknown
		>;
		expect(manifest).toMatchObject({
			pid: process.pid,
			protocol: 2,
			dataDir,
			profile: null,
			region: 'en',
			buildEnv: 'prod',
			state: 'ready',
		});
		expect(fs.statSync(handle.manifestPath).mode & 0o777).toBe(0o600);
		expect(manifest['socketPath']).toBe(resolveMcodedSocketPath(controlRoot));

		// mcoded.token: 0600, 32 random bytes hex.
		expect(fs.statSync(handle.tokenPath).mode & 0o777).toBe(0o600);
		expect(readDaemonToken(controlRoot)).toHaveLength(64);

		// Control root stays 0700 (ensureControlRootLayout ran).
		expect(fs.statSync(controlRoot).mode & 0o777).toBe(0o700);
		// The default control root IS the profile durable root: the full
		// durable layout (incl. the tool-spill cas/) belongs here.
		expect(fs.existsSync(path.join(controlRoot, 'cas'))).toBe(true);
	});

	it('a v2 hello over the real socket must carry token + dataDir + env', async () => {
		const home = currentHome();
		const { factory } = stubHostFactory();
		const handle = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: factory,
		});
		handles.push(handle);
		const token = readDaemonToken(handle.controlRoot) as string;

		// Wrong token → UNAUTHORIZED (the file token belongs to the live daemon).
		const rejected = await helloDaemon(handle.daemon.socketPath, {
			token: 'wrong',
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.errorCode).toBe('UNAUTHORIZED');

		// Right identity → welcome.
		const welcomed = await helloDaemon(handle.daemon.socketPath, {
			token,
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(welcomed.ok).toBe(true);
		if (welcomed.ok) expect(welcomed.data).toMatchObject({ version: 2, minor: 1 });

		// Foreign region → ENV_MISMATCH (the auth-namespace trap, R6).
		const foreign = await helloDaemon(handle.daemon.socketPath, {
			token,
			dataDir: handle.dataDir,
			env: { region: 'cn', buildEnv: 'prod' },
		});
		expect(foreign.ok).toBe(false);
		if (!foreign.ok) expect(foreign.errorCode).toBe('ENV_MISMATCH');
	});

	it('moves the control plane to dd-<hash> for a foreign --data-dir', async () => {
		const home = currentHome();
		const foreign = fs.mkdtempSync(path.join(home, 'project-data-'));
		const { factory, calls } = stubHostFactory();
		const handle = await startProductDaemon({
			argv: ['--data-dir', foreign],
			env: productEnv(home),
			homeDir: home,
			createHost: factory,
		});
		handles.push(handle);

		const defaultRoot = resolveDurableRoot(null, home);
		expect(handle.controlRoot.startsWith(path.join(defaultRoot, 'dd-'))).toBe(true);
		expect(handle.dataDir).toBe(fs.realpathSync(foreign));
		expect(calls[0]?.dataDir).toBe(fs.realpathSync(foreign));
		const manifest = JSON.parse(fs.readFileSync(handle.manifestPath, 'utf8')) as Record<
			string,
			unknown
		>;
		expect(manifest['dataDir']).toBe(fs.realpathSync(foreign));
		// A pure control root: no orphaned cas/ — the tool-spill CAS lives in
		// the PROFILE durable root (arch §2.2), and openCas creates it itself.
		expect(fs.existsSync(path.join(handle.controlRoot, 'cas'))).toBe(false);
	});

	it('refuses a control root already bound to another dataDir (§2.2)', async () => {
		const home = currentHome();
		const controlRoot = resolveDurableRoot(null, home);
		fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
		fs.writeFileSync(
			path.join(controlRoot, 'daemon.json'),
			JSON.stringify({ pid: 1, dataDir: '/somewhere/else', state: 'stopped' }),
		);
		await expect(
			startProductDaemon({ env: productEnv(home), homeDir: home, createHost: stubHostFactory().factory }),
		).rejects.toMatchObject({
			name: 'DaemonManifestError',
			code: 'DATA_DIR_MISMATCH',
		});
	});
});

// The opus 2026-11-01 table: the profile label resolves flag → env → dataDir
// inference, and an operator-named profile never sits on another profile's
// dataDir. `env: {}` keeps ambient MINIMAX_* out of every row.
describe('resolveDaemonTargets (profile ↔ dataDir resolution, opus 2026-11-01)', () => {
	it('the explicit flag lands on the profile durable root', () => {
		const home = currentHome();
		const targets = resolveDaemonTargets({ profile: 'cedar', homeDir: home, env: {} });
		expect(targets.profile).toBe('cedar');
		expect(targets.dataDir).toBe(path.join(home, '.minimax-cedar'));
		expect(targets.controlRoot).toBe(resolveDurableRoot('cedar', home));
	});

	it('null + the cedar dataDir infers the cedar profile onto the SAME root', () => {
		const home = currentHome();
		fs.mkdirSync(path.join(home, '.minimax-cedar'), { recursive: true });
		const inferred = resolveDaemonTargets({
			dataDir: path.join(home, '.minimax-cedar'),
			homeDir: home,
			env: {},
		});
		const flagged = resolveDaemonTargets({ profile: 'cedar', homeDir: home, env: {} });
		expect(inferred.profile).toBe('cedar');
		expect(inferred.controlRoot).toBe(flagged.controlRoot);
		expect(inferred.dataDir).toBe(flagged.dataDir);
	});

	it('null + ~/.minimax is the default profile on the unsuffixed root', () => {
		const home = currentHome();
		fs.mkdirSync(path.join(home, '.minimax'), { recursive: true });
		const targets = resolveDaemonTargets({
			dataDir: path.join(home, '.minimax'),
			homeDir: home,
			env: {},
		});
		expect(targets.profile).toBeNull();
		expect(targets.controlRoot).toBe(resolveDurableRoot(null, home));
	});

	it('explicit cedar + the default dataDir fails closed with PROFILE_DATA_DIR_MISMATCH', () => {
		const home = currentHome();
		fs.mkdirSync(path.join(home, '.minimax'), { recursive: true });
		try {
			resolveDaemonTargets({
				profile: 'cedar',
				dataDir: path.join(home, '.minimax'),
				homeDir: home,
				env: {},
			});
			expect.unreachable('the mismatch must be refused');
		} catch (error) {
			expect(error).toBeInstanceOf(ProfileDataDirMismatchError);
			expect((error as ProfileDataDirMismatchError).code).toBe('PROFILE_DATA_DIR_MISMATCH');
			expect((error as ProfileDataDirMismatchError).profile).toBe('cedar');
			expect((error as ProfileDataDirMismatchError).dataDirProfile).toBeNull();
		}
	});

	it('explicit cedar + another profile\'s dataDir fails closed naming that profile', () => {
		const home = currentHome();
		fs.mkdirSync(path.join(home, '.minimax-work'), { recursive: true });
		expect(() =>
			resolveDaemonTargets({
				profile: 'cedar',
				dataDir: path.join(home, '.minimax-work'),
				homeDir: home,
				env: {},
			}),
		).toThrow(ProfileDataDirMismatchError);
		try {
			resolveDaemonTargets({
				profile: 'cedar',
				dataDir: path.join(home, '.minimax-work'),
				homeDir: home,
				env: {},
			});
		} catch (error) {
			expect((error as ProfileDataDirMismatchError).dataDirProfile).toBe('work');
		}
	});

	it('a foreign dataDir keeps the dd-<hash> control root and no profile', () => {
		const home = currentHome();
		const foreign = fs.mkdtempSync(path.join(home, 'project-data-'));
		const targets = resolveDaemonTargets({ dataDir: foreign, homeDir: home, env: {} });
		expect(targets.profile).toBeNull();
		expect(targets.controlRoot.startsWith(path.join(resolveDurableRoot(null, home), 'dd-'))).toBe(
			true,
		);
	});

	it('a symlinked spelling of a profile dataDir infers through realpath', () => {
		const home = currentHome();
		const real = path.join(home, 'real-cedar-data');
		fs.mkdirSync(real, { recursive: true });
		fs.symlinkSync(real, path.join(home, '.minimax-cedar'));
		const targets = resolveDaemonTargets({
			dataDir: path.join(home, '.minimax-cedar'),
			homeDir: home,
			env: {},
		});
		expect(targets.profile).toBe('cedar');
		expect(targets.controlRoot).toBe(resolveDurableRoot('cedar', home));
	});

	it('MINIMAX_PROFILE selects the profile without the flag, and the flag beats the env', () => {
		const home = currentHome();
		const fromEnv = resolveDaemonTargets({
			homeDir: home,
			env: { MINIMAX_PROFILE: 'cedar' },
		});
		expect(fromEnv.profile).toBe('cedar');
		expect(fromEnv.controlRoot).toBe(resolveDurableRoot('cedar', home));

		const fromFlag = resolveDaemonTargets({
			profile: 'work',
			homeDir: home,
			env: { MINIMAX_PROFILE: 'cedar' },
		});
		expect(fromFlag.profile).toBe('work');
	});

	it('an explicitly named profile with a genuinely foreign dataDir stays allowed (dd-<hash>, label kept)', () => {
		const home = currentHome();
		const foreign = fs.mkdtempSync(path.join(home, 'project-data-'));
		const targets = resolveDaemonTargets({
			profile: 'cedar',
			dataDir: foreign,
			homeDir: home,
			env: {},
		});
		expect(targets.profile).toBe('cedar');
		expect(targets.controlRoot.startsWith(path.join(resolveDurableRoot(null, home), 'dd-'))).toBe(
			true,
		);
	});

	// login wave 2026-11-02: the raw 'default' selector must survive into this
	// resolver and normalize HERE — the implicit profile under whatever env the
	// wrapper carries, never a second `~/.minimax-default` identity.
	it("'default' under MINIMAX_PROFILE=cedar resolves to the implicit profile (env not read)", () => {
		const home = currentHome();
		fs.mkdirSync(path.join(home, '.minimax'), { recursive: true });
		const targets = resolveDaemonTargets({
			profile: 'default',
			homeDir: home,
			env: { MINIMAX_PROFILE: 'cedar' },
		});
		expect(targets.profile).toBeNull();
		expect(targets.dataDir).toBe(path.join(home, '.minimax'));
		expect(targets.controlRoot).toBe(resolveDurableRoot(null, home));
	});

	it("'DEFAULT' and ' default ' normalize to the implicit profile the same way", () => {
		const home = currentHome();
		fs.mkdirSync(path.join(home, '.minimax'), { recursive: true });
		for (const selector of ['DEFAULT', ' default ']) {
			const targets = resolveDaemonTargets({
				profile: selector,
				homeDir: home,
				env: { MINIMAX_PROFILE: 'cedar' },
			});
			expect(targets.profile, selector).toBeNull();
			expect(targets.dataDir, selector).toBe(path.join(home, '.minimax'));
			expect(targets.controlRoot, selector).toBe(resolveDurableRoot(null, home));
		}
	});

	it("'default' + another profile's dataDir fails closed (the operator named the profile)", () => {
		const home = currentHome();
		fs.mkdirSync(path.join(home, '.minimax-cedar'), { recursive: true });
		try {
			resolveDaemonTargets({
				profile: 'default',
				dataDir: path.join(home, '.minimax-cedar'),
				homeDir: home,
				env: {},
			});
			expect.unreachable('the mismatch must be refused');
		} catch (error) {
			expect(error).toBeInstanceOf(ProfileDataDirMismatchError);
			expect((error as ProfileDataDirMismatchError).code).toBe('PROFILE_DATA_DIR_MISMATCH');
			expect((error as ProfileDataDirMismatchError).profile).toBe('default');
			expect((error as ProfileDataDirMismatchError).dataDirProfile).toBe('cedar');
		}
	});

	it('no flag + MINIMAX_PROFILE=cedar keeps the wrapper semantics (cedar)', () => {
		const home = currentHome();
		const targets = resolveDaemonTargets({
			homeDir: home,
			env: { MINIMAX_PROFILE: 'cedar' },
		});
		expect(targets.profile).toBe('cedar');
		expect(targets.dataDir).toBe(path.join(home, '.minimax-cedar'));
		expect(targets.controlRoot).toBe(resolveDurableRoot('cedar', home));
	});
});

// Login wave 2026-11-02, L3: the WINDOW under a wrapper env, integrated. The
// window is the real thin-client composition (`createRemoteRuntimeHost`): it
// resolves its identity through the login-wave `resolveDaemonTargets`
// (the raw 'default' selector, env NOT read when the flag is given), then
// talks to the daemon over the real socket. Scenario 2 is the only test in
// the wave that can catch the spawn-side env leak — the child's identity is
// derived from the spawn hook's argv + env exactly the way the real child CLI
// parses them, so a leaked MINIMAX_PROFILE with no `--profile` flag makes
// THIS boot die with PROFILE_DATA_DIR_MISMATCH (the resolveDaemonTargets
// unit table above never sees the leak).
describe('default window under a wrapper env (login wave 2026-11-02 integration)', () => {
	/** The wrapper env of the live repro: an cedar profile is SELECTED. */
	function wrapperEnv(home: string): NodeJS.ProcessEnv {
		return { HOME: home, MINIMAX_PROFILE: 'cedar', __MAVIS_RUNTIME_PROFILE: 'cedar' };
	}

	it('a live default daemon welcomes the default window without a mismatch', async () => {
		const home = currentHome();
		const { factory } = stubHostFactory();
		const handle = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: factory,
		});
		handles.push(handle);
		// The daemon on the socket is the implicit-profile one.
		expect(handle.dataDir).toBe(path.join(home, '.minimax'));
		expect(handle.controlRoot).toBe(resolveDurableRoot(null, home));

		// The window: lifecycle.ts passes the selector AS THE OPERATOR TYPED IT
		// (`--profile default` → profile: 'default') and no --data-dir of its
		// own; the wrapper's cedar env rides along in `environment`.
		const host = await createRemoteRuntimeHost({
			dataDir: '',
			profile: 'default',
			homeDir: home,
			environment: wrapperEnv(home),
		});
		try {
			// Connect + v2 hello + the snapshot refresh — the full client path,
			// with the auto-spawn hook armed (and idle: the daemon answers).
			await host.ready;
			expect(host.connectionState()).toBe('ready');
			expect(host.socketPath).toBe(resolveMcodedSocketPath(handle.controlRoot));
			// The handshake reached the SAME default identity — the manifest is
			// untouched and the cedar durable root never materialized.
			const manifest = JSON.parse(fs.readFileSync(handle.manifestPath, 'utf8')) as Record<
				string,
				unknown
			>;
			expect(manifest).toMatchObject({
				profile: null,
				dataDir: path.join(home, '.minimax'),
				state: 'ready',
			});
			expect(fs.existsSync(resolveDurableRoot('cedar', home))).toBe(false);
		} finally {
			await host.apiHost.close();
		}
	}, 30_000);

	it('no daemon: the window spawns the default identity and leaks NO wrapper env into the child', async () => {
		const home = currentHome();
		const spawns: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
		const boots: Array<Promise<ProductDaemonHandle>> = [];
		const stubHost = stubHostFactory().factory;
		const host = await createRemoteRuntimeHost(
			{
				dataDir: '',
				profile: 'default',
				homeDir: home,
				environment: wrapperEnv(home),
			},
			{
				spawnSeams: {
					// The seam STANDS IN for the detached `mcoded daemon run` child,
					// booting a REAL product daemon: the child's identity comes ONLY
					// from the captured argv + env — parseMcodedArgs is exactly what
					// the child CLI runs, and startProductDaemon resolves the rest.
					// With the leak regressed (env cedar inherited, no --profile
					// flag) this boot rejects with PROFILE_DATA_DIR_MISMATCH and the
					// test fails — there is nowhere for the leak to hide.
					spawnDaemon: (options) => {
						spawns.push({ argv: [...options.argv], env: { ...options.env } });
						expect(parseMcodedArgs(options.argv.slice(2))).toEqual({
							dataDir: path.join(home, '.minimax'),
							profile: 'default',
						});
						boots.push(
							startProductDaemon({
								argv: options.argv.slice(2),
								env: { ...options.env },
								homeDir: home,
								createHost: stubHost,
							}),
						);
						return { unref: () => undefined };
					},
					// The readiness probe stays REAL (manifest + hello over the
					// socket); only the poll cadence is compressed.
					sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
				},
			},
		);
		try {
			// ENOENT → spawn hook → child daemon ready → the window's own v2
			// hello (default identity under the cedar env) is WELCOMED. The
			// wait is bounded well under the hook's SPAWN_READY_TIMEOUT_MS
			// (20 s): this pins the REAL readiness probe (manifest + hello with
			// the binding's dataDir). A probe the daemon refuses would leave
			// the hook polling until its full timeout before the client even
			// retried connect — the degraded path this test must never take.
			const readyStartedAt = Date.now();
			await host.ready;
			expect(Date.now() - readyStartedAt).toBeLessThan(15_000);
			expect(host.connectionState()).toBe('ready');

			// Exactly one spawn, with the resolved identity spelled out in argv.
			const dataDir = path.join(home, '.minimax');
			expect(spawns).toHaveLength(1);
			expect(spawns[0]?.argv.slice(2)).toEqual([
				'daemon',
				'run',
				'--data-dir',
				dataDir,
				'--profile',
				'default',
			]);
			// NO wrapper profile selector reaches the child env — the public
			// variable and the gated legacy one are both stripped.
			expect(spawns[0]?.env['MINIMAX_PROFILE']).toBeUndefined();
			expect(spawns[0]?.env['__MAVIS_RUNTIME_PROFILE']).toBeUndefined();
			// The data-plane identity and the wrapper's HOME do reach it, and
			// the mode gate is pinned to `auto` for the child only.
			expect(spawns[0]?.env['MINIMAX_DATA_DIR']).toBe(dataDir);
			expect(spawns[0]?.env['HOME']).toBe(home);
			expect(spawns[0]?.env[MCODE_SERVER_MODE_ENV]).toBe('auto');

			// The child accepted its own argv+env identity: the boot RESOLVED
			// (a leaked env would have rejected it with a mismatch).
			expect(boots).toHaveLength(1);
			const child = await (boots[0] as Promise<ProductDaemonHandle>);
			handles.push(child);
			const manifest = JSON.parse(fs.readFileSync(child.manifestPath, 'utf8')) as Record<
				string,
				unknown
			>;
			expect(manifest).toMatchObject({
				profile: null,
				dataDir,
				state: 'ready',
			});
			// The spawned identity is the implicit one: ~/.minimax exists, no
			// cedar durable root was ever created.
			expect(fs.existsSync(dataDir)).toBe(true);
			expect(fs.existsSync(resolveDurableRoot('cedar', home))).toBe(false);
		} finally {
			await host.apiHost.close();
		}
	}, 30_000);
});

describe('startProductDaemon fail-closed on a profile/dataDir mismatch (opus 2026-11-01)', () => {
	it('refuses the mismatched pair before touching any control plane', async () => {
		const home = currentHome();
		fs.mkdirSync(path.join(home, '.minimax'), { recursive: true });
		await expect(
			startProductDaemon({
				argv: ['--profile', 'cedar', '--data-dir', path.join(home, '.minimax')],
				env: { HOME: home, [MCODE_SERVER_MODE_ENV]: 'auto' },
				homeDir: home,
				createHost: stubHostFactory().factory,
			}),
		).rejects.toMatchObject({
			name: 'ProfileDataDirMismatchError',
			code: 'PROFILE_DATA_DIR_MISMATCH',
		});
		// Fail-closed means nothing was written: no profile durable root, no
		// manifest, no token.
		expect(fs.existsSync(resolveDurableRoot('cedar', home))).toBe(false);
	});
});

describe('one daemon per control root', () => {
	it('refuses a second product daemon with daemon-alive — without trampling the live one', async () => {
		const home = currentHome();
		const { factory } = stubHostFactory();
		const first = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: factory,
		});
		handles.push(first);
		const tokenBefore = readDaemonToken(first.controlRoot);
		const manifestBefore = fs.readFileSync(first.manifestPath, 'utf8');

		// The lock is held BEFORE the loser writes anything: no token rotation,
		// no manifest trample.
		await expect(
			startProductDaemon({ env: productEnv(home), homeDir: home, createHost: factory }),
		).rejects.toMatchObject({ name: 'McodedDaemonError', code: 'daemon-alive' });
		expect(readDaemonToken(first.controlRoot)).toBe(tokenBefore);
		expect(fs.readFileSync(first.manifestPath, 'utf8')).toBe(manifestBefore);
		expect(first.daemon.isListening).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Incident 2026-11-04: two competing auto-spawns on one control root split
// the mcoded.lock CAS; the loser's writes replaced the live winner's
// mcoded.token (and daemon.json), leaving the winner UNAUTHORIZED to every
// client — even `daemon stop --force` could not reach it. The CAS itself is
// hammered cross-process in daemon-lock.test.ts; these fixtures pin the
// PRODUCT composition's side of the contract: the loser refuses having
// written NOTHING (the token/manifest on disk stay the winner's, read back
// through the winner's own socket), and a daemon whose token FILE was
// damaged re-asserts it without a kill.
// ---------------------------------------------------------------------------
describe('two parallel spawn attempts on one control root (incident 2026-11-04)', () => {
	it('exactly one daemon wins; the loser refuses with the winner manifest and writes nothing', async () => {
		const home = currentHome();
		const factory = stubHostFactory().factory;
		const [first, second] = await Promise.allSettled([
			startProductDaemon({ env: productEnv(home), homeDir: home, createHost: factory }),
			startProductDaemon({ env: productEnv(home), homeDir: home, createHost: factory }),
		]);
		// Separate env objects: the composition mutates the env it is given.
		// Exactly one start may win the CAS.
		const settled = [first, second];
		expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const winner = settled.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<ProductDaemonHandle>;
		const loser = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
		handles.push(winner.value);
		// The loser re-read the WINNER's manifest before dying: the refusal
		// names the daemon that owns the root.
		expect(loser.reason).toMatchObject({ name: 'McodedDaemonError', code: 'daemon-alive' });
		expect(String(loser.reason.message)).toContain(`pid ${process.pid}`);
		expect(String(loser.reason.message)).toContain('one daemon per control root');

		// The loser wrote NOTHING: the token on disk still authenticates
		// against the live winner over its own socket (had the loser rotated
		// the file, this hello would be UNAUTHORIZED — the incident), and the
		// manifest on disk is still the winner's.
		const manifest = JSON.parse(fs.readFileSync(winner.value.manifestPath, 'utf8')) as Record<
			string,
			unknown
		>;
		expect(manifest['pid']).toBe(process.pid);
		expect(manifest['state']).toBe('ready');
		const fileToken = readDaemonToken(winner.value.controlRoot) as string;
		const probe = await helloDaemon(winner.value.daemon.socketPath, {
			token: fileToken,
			dataDir: winner.value.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(probe.ok, `hello with the file token: ${JSON.stringify(probe)}`).toBe(true);
		expect(winner.value.daemon.isListening).toBe(true);
	}, 30_000);
});

describe('token file self-heal (incident 2026-11-04, daemon is the token source of truth)', () => {
	it('a clobbered token file is re-asserted on the next refused hello — management is restored', async () => {
		const home = currentHome();
		const handle = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: stubHostFactory().factory,
		});
		handles.push(handle);
		const ownToken = readDaemonToken(handle.controlRoot) as string;

		// The loser's leftover write: a foreign token in the file.
		fs.writeFileSync(handle.tokenPath, 'aforeignloserwrotehere', { mode: 0o600 });
		// The client that read the damaged file is refused…
		const refused = await helloDaemon(handle.daemon.socketPath, {
			token: readDaemonToken(handle.controlRoot) as string,
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.errorCode).toBe('UNAUTHORIZED');
		// …but the refusal HEALED the file back to the daemon's own token.
		expect(readDaemonToken(handle.controlRoot)).toBe(ownToken);
		// The next client (fresh read) passes — no kill needed.
		const healed = await helloDaemon(handle.daemon.socketPath, {
			token: readDaemonToken(handle.controlRoot) as string,
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(healed.ok).toBe(true);
		// The exact management path lost in the incident works again.
		const stop = await requestDaemonShutdown(handle.daemon.socketPath, {
			token: readDaemonToken(handle.controlRoot),
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(stop.ok, `stop outcome: ${JSON.stringify(stop)}`).toBe(true);
		await handle.done;
	});

	it('a token file deleted under a live daemon is recreated on the next refused hello', async () => {
		const home = currentHome();
		const handle = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: stubHostFactory().factory,
		});
		handles.push(handle);
		const ownToken = readDaemonToken(handle.controlRoot) as string;

		fs.rmSync(handle.tokenPath, { force: true });
		// A token-less hello is refused (the incident's "token missing")…
		const refused = await helloDaemon(handle.daemon.socketPath, {
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.errorCode).toBe('UNAUTHORIZED');
		// …and the file is back with the daemon's own token.
		expect(readDaemonToken(handle.controlRoot)).toBe(ownToken);
		const healed = await helloDaemon(handle.daemon.socketPath, {
			token: readDaemonToken(handle.controlRoot) as string,
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(healed.ok).toBe(true);
	});

	it('a clobber landing during the host boot is healed by the ready check', async () => {
		const home = currentHome();
		const controlRoot = resolveDurableRoot(null, home);
		const tokenPath = path.join(controlRoot, 'mcoded.token');
		// The spawn-race shape: the loser's token write lands while the winner
		// is still booting its runtime host (the factory stands in for the
		// seconds-long host boot).
		const clobberingFactory: ProductDaemonHostFactory = async (options) => {
			const stub = stubHostFactory();
			fs.writeFileSync(tokenPath, 'loser-mid-boot-clobber', { mode: 0o600 });
			return stub.factory(options);
		};
		const handle = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: clobberingFactory,
		});
		handles.push(handle);
		// The start-completed check re-asserted the daemon's own token: the
		// file authenticates against the live daemon (without the check, the
		// clobber would survive and every client would be UNAUTHORIZED).
		const probe = await helloDaemon(handle.daemon.socketPath, {
			token: readDaemonToken(handle.controlRoot) as string,
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(probe.ok, `hello with the file token: ${JSON.stringify(probe)}`).toBe(true);
	});
});

describe('graceful stop finalizes the control plane', () => {
	it('stop writes state stopped, removes the token, and frees the root', async () => {
		const home = currentHome();
		const { factory } = stubHostFactory();
		const handle = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: factory,
		});

		// The authorized IPC stop path (what `mcode daemon stop` uses): the
		// full identity — token, dataDir AND env — is required of every v2
		// hello, the stop command's included.
		const stopped = await requestDaemonShutdown(handle.daemon.socketPath, {
			token: readDaemonToken(handle.controlRoot),
			dataDir: handle.dataDir,
			env: { region: 'en', buildEnv: 'prod' },
		});
		expect(stopped.ok, `stop outcome: ${JSON.stringify(stopped)}`).toBe(true);
		await handle.done;

		const manifest = JSON.parse(fs.readFileSync(handle.manifestPath, 'utf8')) as Record<
			string,
			unknown
		>;
		expect(manifest['state']).toBe('stopped');
		expect(fs.existsSync(handle.tokenPath)).toBe(false);
		expect(fs.existsSync(resolveMcodedSocketPath(handle.controlRoot))).toBe(false);
		expect(fs.existsSync(path.join(handle.controlRoot, 'mcoded.lock'))).toBe(false);

		// The root is startable again after the graceful stop.
		const next = await startProductDaemon({
			env: productEnv(home),
			homeDir: home,
			createHost: stubHostFactory().factory,
		});
		handles.push(next);
		await next.stop();
	});
});

// ---------------------------------------------------------------------------
// Astra T1 корректировки (2026-11-04): владение control root'ом.
//   п.1 — финализация владельца ДО release на всех ветках: stop→start
//         interleaving с задержанным close старого владельца;
//   п.2 — гарантированная уборка СВОЕГО владения при сбое между acquire и
//         готовностью (ошибка записи токена, ошибка boot);
//   п.5 — атомарная и приватная публикация токена (tmp 0600 + rename): файл
//         никогда не существует усечённым и не наследует чужие права.
// ---------------------------------------------------------------------------
describe('ownership handoff and failure cleanup (astra T1)', () => {
	/** A host factory whose apiHost.close() parks on a gate — the delayed
	 * close of the old owner between its resource teardown and its final
	 * control-plane writes. */
	function gatedCloseFactory(gate: Promise<void>): ProductDaemonHostFactory {
		const stub = stubHostFactory();
		return async (options) => {
			const host = await stub.factory(options);
			const inner = host.apiHost;
			return {
				...host,
				apiHost: {
					...inner,
					close: async () => {
						await gate;
						await inner.close();
					},
				},
			} as typeof host;
		};
	}

	/** Poll until `predicate` holds (bounded), so the test synchronizes on
	 * real world state instead of sleeps. */
	async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error('waitUntil: condition not reached');
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	it(
		'stop→start interleaving: the successor cannot publish while the old owner still owes its final writes (T1 п.1)',
		async () => {
			const home = currentHome();
			let liftGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				liftGate = resolve;
			});
			const first = await startProductDaemon({
				env: productEnv(home),
				homeDir: home,
				createHost: gatedCloseFactory(gate),
			});
			handles.push(first);
			const socketPath = resolveMcodedSocketPath(first.controlRoot);
			expect(fs.existsSync(socketPath)).toBe(true);

			// The stop parks between resource teardown (hub drained, socket
			// unlinked — observable) and the final control-plane writes,
			// because the runtime host close is gated.
			const stopping = first.stop();
			await waitUntil(() => !fs.existsSync(socketPath));

			// While the old owner still holds the lock, a successor MUST
			// refuse: publishing now would mean the old owner's pending
			// `stopped` manifest write and token cleanup land on OUR files
			// (the 8fa5d06 bug: the release lived inside daemon.shutdown).
			await expect(
				startProductDaemon({
					env: productEnv(home),
					homeDir: home,
					createHost: stubHostFactory().factory,
				}),
			).rejects.toMatchObject({ name: 'McodedDaemonError', code: 'daemon-alive' });

			// The old owner finalizes UNDER ownership and releases LAST.
			liftGate();
			await stopping;
			const stoppedManifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8')) as Record<
				string,
				unknown
			>;
			expect(stoppedManifest['state']).toBe('stopped');
			expect(fs.existsSync(first.tokenPath)).toBe(false);
			expect(fs.existsSync(path.join(first.controlRoot, 'mcoded.lock'))).toBe(false);

			// Only now the successor wins — and nothing the old owner did
			// afterwards (there is nothing left) damages it.
			const second = await startProductDaemon({
				env: productEnv(home),
				homeDir: home,
				createHost: stubHostFactory().factory,
			});
			handles.push(second);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const successorManifest = JSON.parse(
				fs.readFileSync(second.manifestPath, 'utf8'),
			) as Record<string, unknown>;
			expect(successorManifest['state']).toBe('ready');
			const successorToken = readDaemonToken(second.controlRoot) as string;
			expect(successorToken).toHaveLength(64);
			const probe = await helloDaemon(second.daemon.socketPath, {
				token: successorToken,
				dataDir: second.dataDir,
				env: { region: 'en', buildEnv: 'prod' },
			});
			expect(probe.ok, `hello with the successor's token: ${JSON.stringify(probe)}`).toBe(true);
			await second.stop();
		},
		30_000,
	);

	it(
		'a token-write failure after the lock release path leaves NO phantom ownership and finalizes failed (T1 п.2)',
		async () => {
			const home = currentHome();
			const controlRoot = resolveDurableRoot(null, home);
			// Deterministic write failure at the FIRST token publish: a
			// directory at the temp path of the atomic publish (EISDIR).
			const tokenTempDir = path.join(controlRoot, `mcoded.token.tmp-${process.pid}`);
			fs.mkdirSync(tokenTempDir, { recursive: true });
			try {
				await expect(
					startProductDaemon({
						env: productEnv(home),
						homeDir: home,
						createHost: stubHostFactory().factory,
					}),
				).rejects.toBeInstanceOf(Error);
				// The live test process must not be left holding a phantom lock…
				expect(fs.existsSync(path.join(controlRoot, 'mcoded.lock'))).toBe(false);
				// …and the failure finalized the manifest BEFORE releasing.
				const manifest = JSON.parse(
					fs.readFileSync(path.join(controlRoot, 'daemon.json'), 'utf8'),
				) as Record<string, unknown>;
				expect(String(manifest['state'])).toMatch(/^failed:/);
			} finally {
				fs.rmSync(tokenTempDir, { recursive: true, force: true });
			}
			// The root is not wedged: a clean start succeeds immediately.
			const next = await startProductDaemon({
				env: productEnv(home),
				homeDir: home,
				createHost: stubHostFactory().factory,
			});
			handles.push(next);
		},
	);

	it(
		'a host-boot failure finalizes failed, removes the token and releases ownership (T1 п.1/п.2)',
		async () => {
			const home = currentHome();
			const controlRoot = resolveDurableRoot(null, home);
			const explodingFactory: ProductDaemonHostFactory = async () => {
				throw new Error('boot exploded');
			};
			await expect(
				startProductDaemon({ env: productEnv(home), homeDir: home, createHost: explodingFactory }),
			).rejects.toThrow('boot exploded');
			// The failed boot cleaned up its own ownership completely.
			expect(fs.existsSync(path.join(controlRoot, 'mcoded.lock'))).toBe(false);
			expect(fs.existsSync(path.join(controlRoot, 'mcoded.token'))).toBe(false);
			const manifest = JSON.parse(
				fs.readFileSync(path.join(controlRoot, 'daemon.json'), 'utf8'),
			) as Record<string, unknown>;
			expect(String(manifest['state'])).toMatch(/^failed:/);
			// …and the root stays startable.
			const next = await startProductDaemon({
				env: productEnv(home),
				homeDir: home,
				createHost: stubHostFactory().factory,
			});
			handles.push(next);
		},
	);

	it(
		'publishes the token atomically and privately: a wrongly-permissioned stale file is REPLACED, not rewritten (T1 п.5)',
		async () => {
			const home = currentHome();
			const controlRoot = resolveDurableRoot(null, home);
			fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
			// Pre-fix debris: world-readable stale secret at the token path.
			const tokenPath = path.join(controlRoot, 'mcoded.token');
			fs.writeFileSync(tokenPath, 'stale-secret-from-a-previous-life', { mode: 0o644 });

			const handle = await startProductDaemon({
				env: productEnv(home),
				homeDir: home,
				createHost: stubHostFactory().factory,
			});
			handles.push(handle);
			// The publish REPLACED the inode: fresh 0600 perms (writeFileSync
			// on the existing path would have kept 0644) and the daemon's own
			// 32-byte token, never the stale content.
			expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
			expect(readDaemonToken(controlRoot)).toHaveLength(64);
			expect(readDaemonToken(controlRoot)).not.toContain('stale-secret');
			// No publication temp debris in the control root.
			expect(
				fs.readdirSync(controlRoot).filter((name) => name.includes('.tmp-')),
			).toEqual([]);

			// The self-heal republish is atomic and re-private too: a foreign
			// token with widened perms is healed back 0600 with OUR token (the
			// refused hello stays UNAUTHORIZED — pinned in the self-heal suite).
			const ownToken = readDaemonToken(controlRoot) as string;
			fs.writeFileSync(tokenPath, 'aforeignloserwrotehere', { mode: 0o644 });
			const refused = await helloDaemon(handle.daemon.socketPath, {
				token: 'aforeignloserwrotehere',
				dataDir: handle.dataDir,
				env: { region: 'en', buildEnv: 'prod' },
			});
			expect(refused.ok).toBe(false);
			if (!refused.ok) expect(refused.errorCode).toBe('UNAUTHORIZED');
			expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
			expect(readDaemonToken(controlRoot)).toBe(ownToken);
			const healed = await helloDaemon(handle.daemon.socketPath, {
				token: readDaemonToken(controlRoot),
				dataDir: handle.dataDir,
				env: { region: 'en', buildEnv: 'prod' },
			});
			expect(healed.ok).toBe(true);
		},
	);
});
