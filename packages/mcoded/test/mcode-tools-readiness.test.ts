/**
 * The daemon-owned mcode-tools readiness (revision 11 F2).
 *
 * Covered here:
 * - `prepareDaemonMcodeToolsIntegration` (unit, fake deps): the disabled
 *   no-op, the missing-session degradation, the ready path (env keys + PATH
 *   activation, full teardown on dispose), and the fail-open degradation that
 *   leaves the environment untouched — the inherited-window env stays the
 *   working fallback;
 * - `startProductDaemon` (integration, real socket + stub host): a daemon
 *   started from a CLEAN shell owns its broker — the readiness composes
 *   before the host boots, a window closing (an unrelated TUI-style readiness
 *   dispose) does NOT touch the daemon broker while the daemon keeps serving,
 *   and the graceful shutdown disposes exactly the daemon's own readiness.
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	McodeToolsAuthStatusSnapshot,
	McodeToolsHostAuthSession,
	ValidatedMcodeToolsResource,
} from '@mavis/mcode-tools-host';
import { MCODE_SERVER_MODE_ENV, resetConfig } from '@mavis/config';
import type { CreatedLocalRuntimeHost } from '@mavis/local-runtime-v2/process-local';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';

import { helloDaemon } from '../src/ipc.js';
import {
	createDaemonMcodeToolsAuthSession,
	prepareDaemonMcodeToolsIntegration,
	type DaemonMcodeToolsReadiness,
	type PrepareDaemonMcodeToolsIntegrationOptions,
} from '../src/mcode-tools.js';
import {
	readDaemonToken,
	startProductDaemon,
	type ProductDaemonHandle,
	type ProductDaemonHostFactory,
} from '../src/product-daemon.js';

// ────────────────────────── prepare (unit, fake deps) ──────────────────────────

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-tools-daemon-readiness-'));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => {
			fs.rmSync(directory, { recursive: true, force: true });
		}),
	);
});

function validatedResource(rootDir: string): ValidatedMcodeToolsResource {
	return {
		rootDir,
		cliPath: path.join(rootDir, 'cli.mjs'),
		manifest: {
			schemaVersion: 3,
			packageName: '@minimax/mcode-tools-test',
			version: '0.0.0-test.1',
			gitSha: 'abc1234',
			buildEnv: 'test',
			bedrockLane: 'oauth',
			nodeRange: '>=20',
			entry: 'cli.mjs',
			auth: {
				mode: 'shared-broker',
				protocol: {
					name: '@mavis/oauth-lease-protocol',
					version: '0.1.0-beta.0',
					wireVersion: 1,
				},
			},
			nativePackages: [],
			resources: [{ path: 'cli.mjs', sha256: '0'.repeat(64) }],
		},
	};
}

function fakeSession(status: McodeToolsAuthStatusSnapshot): McodeToolsHostAuthSession {
	return {
		getStatus: vi.fn(async () => status),
		getAccessToken: vi.fn(),
		handleUnauthorized: vi.fn(),
		watch: vi.fn(() => () => undefined),
	};
}

describe('prepareDaemonMcodeToolsIntegration (revision 11 F2)', () => {
	it('does no resource or broker work when the capability is not requested', async () => {
		const validateResource = vi.fn();
		const startBroker = vi.fn();
		const environment: Record<string, string | undefined> = { PATH: '/usr/bin' };
		const result = await prepareDaemonMcodeToolsIntegration(
			{
				requested: false,
				dataDir: '/profile',
				buildEnv: 'dev',
				region: 'cn',
				session: fakeSession({ status: 'anonymous', generation: 0 }),
				entryUrl: 'file:///package/cli.js',
				environment,
			},
			{ validateResource, startBroker },
		);

		expect(result).toMatchObject({ requested: false, ready: false, category: 'disabled' });
		expect(validateResource).not.toHaveBeenCalled();
		expect(startBroker).not.toHaveBeenCalled();
		expect(environment).toEqual({ PATH: '/usr/bin' });
	});

	it('degrades honestly when no broker auth session can be built', async () => {
		const startBroker = vi.fn();
		const environment: Record<string, string | undefined> = { PATH: '/usr/bin' };
		const result = await prepareDaemonMcodeToolsIntegration(
			{
				requested: true,
				dataDir: '/profile',
				buildEnv: 'test',
				region: 'en',
				session: undefined,
				entryUrl: 'file:///package/cli.js',
				environment,
			},
			{ startBroker },
		);

		expect(result).toMatchObject({ requested: true, ready: false, category: 'host_unavailable' });
		expect(startBroker).not.toHaveBeenCalled();
		// The fallback contract: a degraded readiness NEVER touches the env —
		// inherited window keys (if any) keep serving.
		expect(environment).toEqual({ PATH: '/usr/bin' });
	});

	it('activates the daemon-owned broker env and tears everything down on dispose', async () => {
		const dataDir = makeTemporaryDirectory();
		const runtimeDir = path.join(dataDir, 'run', 'mcode-tools', 'daemon', 'runtime');
		fs.mkdirSync(runtimeDir, { recursive: true });
		const environment: Record<string, string | undefined> = {
			PATH: ['/usr/bin', '/bin'].join(path.delimiter),
		};
		const brokerDispose = vi.fn(async () => undefined);
		const removeRuntimeDir = vi.fn(async () => undefined);
		const session = fakeSession({ status: 'authenticated' as const, generation: 1 });
		const startBroker = vi.fn(async () => ({
			endpoint: path.join(runtimeDir, 'broker.sock'),
			capabilityFile: path.join(runtimeDir, 'broker.cap'),
			dispose: brokerDispose,
		}));

		const result = await prepareDaemonMcodeToolsIntegration(
			{
				requested: true,
				dataDir,
				buildEnv: 'dev',
				region: 'en',
				session,
				entryUrl: 'file:///package/cli.js',
				environment,
			},
			{
				validateResource: vi.fn(() => validatedResource('/package/embedded/mcode-tools')),
				startBroker,
				createRuntimeDir: vi.fn(async () => runtimeDir),
				removeRuntimeDir,
			},
		);

		expect(result).toMatchObject({
			requested: true,
			ready: true,
			category: 'ready',
			buildEnv: 'test',
			version: '0.0.0-test.1',
		});
		expect(startBroker).toHaveBeenCalledWith({
			dataDir: runtimeDir,
			session,
			logger: expect.any(Object),
		});
		// The daemon process env now carries the broker surface its tool
		// children inherit — exactly the TUI activation contract, owned by the
		// daemon this time.
		expect(environment.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT).toBe(
			path.join(runtimeDir, 'broker.sock'),
		);
		expect(environment.__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE).toBe(
			path.join(runtimeDir, 'broker.cap'),
		);
		expect(environment.__MAVIS_MCODE_TOOLS_CONFIG_DIR).toBe(
			path.join(dataDir, 'integrations', 'mcode-tools', 'en'),
		);
		expect(environment.__MAVIS_MCODE_TOOLS_REGION).toBe('en');
		expect(environment.__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE).toBe(process.execPath);
		expect(environment.PATH?.split(path.delimiter)[0]).toBe(
			path.resolve('/package', 'internal-bin'),
		);

		await result.dispose();
		await result.dispose();
		expect(brokerDispose).toHaveBeenCalledOnce();
		expect(removeRuntimeDir).toHaveBeenCalledOnce();
		expect(environment.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT).toBeUndefined();
		expect(environment.__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE).toBeUndefined();
		expect(environment.PATH?.split(path.delimiter)).not.toContain(
			path.resolve('/package', 'internal-bin'),
		);
	});

	it('degrades without touching the env when the resource is unavailable', async () => {
		const environment: Record<string, string | undefined> = {
			PATH: '/usr/bin',
			__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT: 'inherited-from-window',
		};
		const startBroker = vi.fn();
		const result = await prepareDaemonMcodeToolsIntegration(
			{
				requested: true,
				dataDir: '/profile',
				buildEnv: 'test',
				region: 'cn',
				session: fakeSession({ status: 'authenticated' as const, generation: 1 }),
				entryUrl: 'file:///package/cli.js',
				environment,
			},
			{
				validateResource: () => {
					throw new Error('mcode-tools manifest is missing');
				},
				startBroker,
			},
		);

		expect(result).toMatchObject({
			requested: true,
			ready: false,
			category: 'resource_unavailable',
		});
		expect(startBroker).not.toHaveBeenCalled();
		// The env-inheritance fallback survives untouched, broker key included.
		expect(environment).toEqual({
			PATH: '/usr/bin',
			__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT: 'inherited-from-window',
		});
	});

	it('projects the profile oauth core into the broker auth session shape', async () => {
		const home = makeTemporaryDirectory();
		const session = createDaemonMcodeToolsAuthSession({
			profile: null,
			dataDir: path.join(home, '.minimax'),
			env: { MAVIS_REGION: 'en', MAVIS_BUILD_ENV: 'prod', HOME: home },
			homeDir: home,
		});
		// Endpoint resolution for the en/prod preset succeeds offline: the
		// session is structural, nothing dials the identity provider here.
		expect(session).toBeDefined();
		const status = await (session as McodeToolsHostAuthSession).getStatus();
		expect(typeof status.generation).toBe('number');
	});
});

// ─────────────────── product daemon ownership (integration) ───────────────────

const tempHomes: string[] = [];
const handles: ProductDaemonHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
	'MAVIS_REGION',
	'MAVIS_BUILD_ENV',
	'MINIMAX_PROFILE',
	'MINIMAX_DATA_DIR',
	'__MAVIS_RUNTIME_DATA_DIR',
	'__MAVIS_RUNTIME_MANAGED',
	'__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG',
];

beforeEach(() => {
	tempHomes.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcoded-mcode-tools-')));
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env['MAVIS_REGION'] = 'en';
	process.env['MAVIS_BUILD_ENV'] = 'prod';
});

afterEach(async () => {
	resetConfig();
	for (const handle of handles.splice(0)) {
		await handle.stop().catch(() => undefined);
	}
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	resetConfig();
});

afterAll(() => {
	for (const home of tempHomes) {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

function stubHostFactory(): {
	factory: ProductDaemonHostFactory;
	calls: Parameters<ProductDaemonHostFactory>[0][];
} {
	const calls: Parameters<ProductDaemonHostFactory>[0][] = [];
	const factory: ProductDaemonHostFactory = async (options) => {
		calls.push(options);
		const cli = {
			createSession: async () => ({ sessionId: 'sess-mcode-tools' }),
		} as unknown as CliService;
		return {
			dataDir: options.dataDir,
			ready: Promise.resolve(),
			apiHost: { close: async () => undefined, ensureBuiltinAgents: async () => undefined },
			metricsClient: { close: async () => undefined },
			cliService: cli,
		} as unknown as CreatedLocalRuntimeHost;
	};
	return { factory, calls };
}

interface FakePrepare {
	prepare: (options: PrepareDaemonMcodeToolsIntegrationOptions) => Promise<DaemonMcodeToolsReadiness>;
	calls: PrepareDaemonMcodeToolsIntegrationOptions[];
	brokerDispose: ReturnType<typeof vi.fn>;
	/** A separate, window-style readiness the test can dispose like a TUI. */
	windowReadiness: { dispose: ReturnType<typeof vi.fn> };
}

function fakePrepare(requested: boolean, ready = requested): FakePrepare {
	const brokerDispose = vi.fn(async () => undefined);
	const state: FakePrepare = {
		prepare: async () => {
			throw new Error('not installed');
		},
		calls: [],
		brokerDispose,
		windowReadiness: { dispose: vi.fn(async () => undefined) },
	};
	const readiness: DaemonMcodeToolsReadiness = {
		requested,
		ready,
		category: ready ? 'ready' : 'disabled',
		buildEnv: 'test',
		dispose: brokerDispose,
	};
	state.prepare = async (options) => {
		state.calls.push(options);
		return readiness;
	};
	return state;
}

async function probeDaemon(handle: ProductDaemonHandle): Promise<boolean> {
	const probe = await helloDaemon(handle.daemon.socketPath, {
		token: readDaemonToken(handle.controlRoot),
		dataDir: handle.dataDir,
		env: { region: 'en', buildEnv: 'prod' },
		timeoutMs: 2_000,
	});
	return probe.ok;
}

describe('daemon-owned mcode-tools readiness in startProductDaemon (revision 11 F2)', () => {
	it('a clean-shell daemon owns a live broker; a window closing cannot kill it', async () => {
		const home = fs.realpathSync(tempHomes.at(-1) as string);
		const dataDir = path.join(home, '.minimax');
		// The user config requests mcode-tools for this daemon.
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(path.join(dataDir, 'config.yaml'), 'beta:\n  mcodeTools: true\n');
		process.env['MINIMAX_DATA_DIR'] = dataDir;
		process.env['__MAVIS_RUNTIME_DATA_DIR'] = dataDir;
		process.env['__MAVIS_RUNTIME_MANAGED'] = '1';
		process.env['__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG'] = '1';
		resetConfig();

		const fake = fakePrepare(true);
		const observed: string[] = [];
		const { factory } = stubHostFactory();
		const handle = await startProductDaemon({
			env: { [MCODE_SERVER_MODE_ENV]: 'auto', HOME: home },
			homeDir: home,
			createHost: factory,
			prepareMcodeTools: (options: PrepareDaemonMcodeToolsIntegrationOptions) => {
				observed.push('prepare');
				return fake.prepare(options);
			},
			onMcodeToolsReadiness: () => {
				observed.push('onReadiness');
			},
		});
		handles.push(handle);

		// The config gate resolved the request; the readiness composed BEFORE
		// the host factory ran (so the product projection sees the daemon's
		// own broker, not a window's).
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.requested).toBe(true);
		expect(observed).toEqual(['prepare', 'onReadiness']);
		expect(fake.brokerDispose).not.toHaveBeenCalled();
		expect(await probeDaemon(handle)).toBe(true);

		// THE regression scenario: the TUI window closes — its OWN readiness
		// disposes (shutdownAuth) — and the daemon's broker must not care.
		await fake.windowReadiness.dispose();
		expect(fake.brokerDispose).not.toHaveBeenCalled();
		expect(await probeDaemon(handle)).toBe(true);

		// The daemon's graceful shutdown is the ONLY thing that disposes its
		// broker (exactly once), and the daemon stops serving after it.
		await handle.stop();
		expect(fake.brokerDispose).toHaveBeenCalledOnce();
		expect(await probeDaemon(handle)).toBe(false);
	}, 20_000);

	it('an explicit config off-switch requests nothing; the daemon boots untouched', async () => {
		const home = fs.realpathSync(tempHomes.at(-1) as string);
		const dataDir = path.join(home, '.minimax');
		fs.mkdirSync(dataDir, { recursive: true });
		// mcodeTools DEFAULTS to enabled on this platform/buildEnv — the honest
		// off-switch is the explicit config false.
		fs.writeFileSync(path.join(dataDir, 'config.yaml'), 'beta:\n  mcodeTools: false\n');
		process.env['MINIMAX_DATA_DIR'] = dataDir;
		process.env['__MAVIS_RUNTIME_DATA_DIR'] = dataDir;
		process.env['__MAVIS_RUNTIME_MANAGED'] = '1';
		process.env['__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG'] = '1';
		resetConfig();

		const fake = fakePrepare(false);
		const { factory, calls } = stubHostFactory();
		const handle = await startProductDaemon({
			env: { [MCODE_SERVER_MODE_ENV]: 'auto', HOME: home },
			homeDir: home,
			createHost: factory,
			prepareMcodeTools: (options: PrepareDaemonMcodeToolsIntegrationOptions) =>
				fake.prepare(options),
		});
		handles.push(handle);

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.requested).toBe(false);
		expect(fake.brokerDispose).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
	});
});
