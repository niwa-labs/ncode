/**
 * The daemon-owned mcode-tools readiness (revision 11 F2).
 *
 * Master kept the OAuth lease broker and the launcher bins in the SAME
 * process that ran the runtime (the TUI window), so their lifecycles could
 * never diverge. This branch moves the runtime into the resident mcoded
 * daemon while the broker stayed in the TUI (`prepareTuiMcodeToolsIntegration`
 * in `tui/src/runtime/lifecycle.ts`), which left two holes:
 *
 * 1. a daemon started outside the TUI spawn chain (`mcode daemon run` from a
 *    clean shell, a machine restart, the standalone `mcoded` entry) inherited
 *    no `__MAVIS_MCODE_TOOLS_*` env at all — with `beta.mcodeTools: true` the
 *    prompt surface was on while every tool call was silently dead (no broker
 *    endpoint, no launcher PATH);
 * 2. closing the TUI window disposed the window's broker
 *    (`shutdownAuth` → readiness.dispose) while the daemon kept running — the
 *    lease surface of a LIVE daemon broke with its owner window.
 *
 * This module gives the daemon its OWN readiness, composed in
 * `product-daemon.ts` (started before the host boots, disposed on the
 * graceful shutdown): the broker, the launcher installation and the
 * `__MAVIS_MCODE_TOOLS_*` activation live in the process that survives the
 * window. The env-inheritance path stays as the FALLBACK, unchanged: when
 * this readiness does not reach `ready` (resource missing in a dev tree,
 * broker socket failure), the daemon's environment is left untouched, so a
 * daemon spawned from an activated TUI chain keeps serving through the
 * inherited keys exactly as before.
 *
 * @module
 */

import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { MavisBuildEnv, MavisRegion } from '@mavis/config';
import { createLogger } from '@mavis/logging';
import {
	activateMcodeToolsHostEnvironment,
	resolveBundledMcodeToolsCommandBinDir,
	resolveBundledMcodeToolsResourceDir,
	startMcodeToolsAuthLeaseBroker,
	validateMcodeToolsResource,
	type McodeToolsAuthLeaseBroker,
	type McodeToolsBuildEnv,
	type McodeToolsHostAuthSession,
	type McodeToolsHostEnvironmentActivation,
	type McodeToolsHostLogger,
} from '@mavis/mcode-tools-host';
import {
	MCODE_OAUTH_SCOPES,
	type AuthStatusSnapshot,
	type MCodeOAuthCore,
} from '@mavis/oauth-core';

import {
	createProfileOAuthCore,
	type LocalRuntimeAdapterAuthOptions,
} from './local-runtime-adapter.js';

const log = createLogger('mcode:rpc');

export type DaemonMcodeToolsReadinessCategory =
	| 'disabled'
	| 'ready'
	| 'resource_unavailable'
	| 'broker_unavailable'
	| 'host_unavailable';

/**
 * The daemon-side twin of the TUI `McodeToolsReadiness`: no
 * `ensureCommandPath` — the daemon activates the launcher PATH once for its
 * own lifetime instead of re-asserting it around window-driven spawns.
 */
export interface DaemonMcodeToolsReadiness {
	readonly requested: boolean;
	readonly ready: boolean;
	readonly category: DaemonMcodeToolsReadinessCategory;
	readonly buildEnv: McodeToolsBuildEnv;
	readonly version?: string;
	dispose(): Promise<void>;
}

export interface PrepareDaemonMcodeToolsIntegrationOptions {
	/** The daemon's effective `beta.mcodeTools` request (user config). */
	requested: boolean;
	/** The served dataDir — the launcher config dir lives under it. */
	dataDir: string;
	buildEnv: MavisBuildEnv;
	region: MavisRegion;
	/**
	 * The broker auth session over the profile's shared credential store
	 * (`createDaemonMcodeToolsAuthSession`); `undefined` (unresolvable OAuth
	 * endpoints) degrades to `host_unavailable`.
	 */
	session: McodeToolsHostAuthSession | undefined;
	/**
	 * The bundle URL the embedded resource layout resolves against
	 * (`import.meta.url` of the caller — in the built dist both the TUI and
	 * the daemon bundle root carry `embedded/mcode-tools` + `internal-bin`).
	 */
	entryUrl: string;
	environment?: Record<string, string | undefined>;
	logger?: McodeToolsHostLogger;
}

export interface PrepareDaemonMcodeToolsIntegrationDependencies {
	validateResource?: typeof validateMcodeToolsResource;
	startBroker?: typeof startMcodeToolsAuthLeaseBroker;
	createRuntimeDir?: typeof createDaemonMcodeToolsRuntimeDir;
	removeRuntimeDir?: typeof removeDaemonMcodeToolsRuntimeDir;
	activateEnvironment?: typeof activateMcodeToolsHostEnvironment;
}

const NOOP_DISPOSE = async (): Promise<void> => undefined;
const NOOP = (): void => undefined;

/**
 * The daemon-side twin of the TUI readiness prepare: same resource/broker/
 * activation pipeline, daemon ownership semantics (see the module comment).
 * Failures degrade to an inactive readiness and NEVER touch the environment —
 * the inherited-window env stays the working fallback.
 */
export async function prepareDaemonMcodeToolsIntegration(
	options: PrepareDaemonMcodeToolsIntegrationOptions,
	dependencies: PrepareDaemonMcodeToolsIntegrationDependencies = {},
): Promise<DaemonMcodeToolsReadiness> {
	const buildEnv = normalizeMcodeToolsHostBuildEnv(options.buildEnv);
	if (!options.requested) return inactiveDaemonReadiness(false, 'disabled', buildEnv);
	if (!options.session) {
		log.warn('mcode-tools readiness category=host_unavailable (no broker auth session)');
		return inactiveDaemonReadiness(true, 'host_unavailable', buildEnv);
	}

	const logger = options.logger ?? daemonMcodeToolsLogger();
	const environment = options.environment ?? process.env;
	const removeRuntimeDir = dependencies.removeRuntimeDir ?? removeDaemonMcodeToolsRuntimeDir;
	let runtimeDir: string | undefined;
	let broker: McodeToolsAuthLeaseBroker | undefined;
	let activation: McodeToolsHostEnvironmentActivation | undefined;
	try {
		const resource = (dependencies.validateResource ?? validateMcodeToolsResource)({
			resourceDir: resolveBundledMcodeToolsResourceDir(options.entryUrl, environment),
			expectedBuildEnv: buildEnv,
		});
		runtimeDir = await (dependencies.createRuntimeDir ?? createDaemonMcodeToolsRuntimeDir)();
		broker = await (dependencies.startBroker ?? startMcodeToolsAuthLeaseBroker)({
			dataDir: runtimeDir,
			session: options.session,
			logger,
		});
		const configDir = path.join(options.dataDir, 'integrations', 'mcode-tools', options.region);
		await ensurePrivateDirectory(configDir);
		activation = (dependencies.activateEnvironment ?? activateMcodeToolsHostEnvironment)(
			environment,
			{
				runtimeExecutable: process.execPath,
				brokerEndpoint: broker.endpoint,
				brokerCapabilityFile: broker.capabilityFile,
				configDir,
				region: options.region,
				commandBinDir: resolveBundledMcodeToolsCommandBinDir(options.entryUrl),
			},
		);
		// Pin the narrowed locals for the dispose closure (a `let` captured in
		// an async closure loses the assignment narrowing).
		const activeActivation = activation;
		const activeBroker = broker;
		const activeRuntimeDir = runtimeDir;
		let disposed = false;
		const readiness: DaemonMcodeToolsReadiness = {
			requested: true,
			ready: true,
			category: 'ready',
			buildEnv,
			version: resource.manifest.version,
			async dispose(): Promise<void> {
				// Idempotent, and disposed ONLY by the daemon's own graceful
				// shutdown — never by a window closing. Full teardown: env
				// restore, broker, runtime dir (order mirrors the TUI path).
				if (disposed) return;
				disposed = true;
				let firstError: unknown;
				activeActivation.restore();
				try {
					await activeBroker.dispose();
				} catch (error) {
					firstError = error;
				}
				try {
					await removeRuntimeDir(activeRuntimeDir);
				} catch (error) {
					firstError ??= error;
				}
				if (firstError) throw firstError;
			},
		};
		log.info('mcode-tools readiness ready', {
			buildEnv,
			region: options.region,
			version: resource.manifest.version,
		});
		return readiness;
	} catch (error) {
		activation?.restore();
		await broker?.dispose().catch(() => undefined);
		if (runtimeDir) await removeRuntimeDir(runtimeDir).catch(() => undefined);
		const category = classifyDaemonReadinessFailure(error);
		log.warn('mcode-tools readiness degraded', {
			category,
			buildEnv,
			region: options.region,
			err: error,
		});
		return inactiveDaemonReadiness(true, category, buildEnv);
	}
}

/**
 * Projects the profile's shared OAuth core (the SAME served-dataDir namespace
 * the runtime's model resolver reads, `createProfileOAuthCore`) into the
 * `McodeToolsHostAuthSession` the lease broker serves — the daemon-side twin
 * of the TUI window's `createMcodeToolsBrokerAuthSession`. `undefined` when
 * the OAuth endpoints cannot be resolved: the readiness then degrades instead
 * of starting a broker that cannot ever authenticate.
 */
export function createDaemonMcodeToolsAuthSession(
	options: LocalRuntimeAdapterAuthOptions,
): McodeToolsHostAuthSession | undefined {
	const core: MCodeOAuthCore | undefined = createProfileOAuthCore(options);
	if (!core) return undefined;
	const projectStatus = (status: AuthStatusSnapshot) => ({
		status: status.status,
		generation: status.generation,
		...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }),
	});
	return {
		getStatus: async () => projectStatus(await core.getStatus()),
		getAccessToken: (minValidityMs) =>
			core.getAccessToken({
				requiredScopes: [...MCODE_OAUTH_SCOPES],
				minValidityMs,
			}),
		handleUnauthorized: (generation) => core.handleUnauthorized({ generation }),
		watch: (listener) => core.watch((status) => listener(projectStatus(status))),
	};
}

export function normalizeMcodeToolsHostBuildEnv(buildEnv: MavisBuildEnv): McodeToolsBuildEnv {
	return buildEnv === 'dev' ? 'test' : buildEnv;
}

export async function createDaemonMcodeToolsRuntimeDir(): Promise<string> {
	// The TUI rationale applies verbatim: macOS Unix-domain sockets have a
	// short path limit, so the process-private broker endpoint lives in `/tmp`
	// under a daemon-specific prefix (the TUI uses `mcode-tools-tui-`).
	const parent = process.platform === 'win32' ? tmpdir() : '/tmp';
	const runtimeDir = await mkdtemp(path.join(parent, `mcode-tools-daemon-${process.pid}-`));
	if (process.platform !== 'win32') await chmod(runtimeDir, 0o700);
	return runtimeDir;
}

export function removeDaemonMcodeToolsRuntimeDir(runtimeDir: string): Promise<void> {
	return rm(runtimeDir, { recursive: true, force: true });
}

/** The ready-but-inactive readiness (never touches the environment). */
function inactiveDaemonReadiness(
	requested: boolean,
	category: Exclude<DaemonMcodeToolsReadinessCategory, 'ready'>,
	buildEnv: McodeToolsBuildEnv,
): DaemonMcodeToolsReadiness {
	return {
		requested,
		ready: false,
		category,
		buildEnv,
		dispose: NOOP_DISPOSE,
	};
}

function daemonMcodeToolsLogger(): McodeToolsHostLogger {
	return {
		info: (message) => log.info(message, { surface: 'mcode-tools' }),
		warn: (message) => log.warn(message, { surface: 'mcode-tools' }),
	};
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== 'win32') await chmod(directory, 0o700);
}

function classifyDaemonReadinessFailure(
	error: unknown,
): Exclude<DaemonMcodeToolsReadinessCategory, 'disabled' | 'ready'> {
	if (isErrorCode(error, 'EADDRINUSE')) return 'broker_unavailable';
	const message = error instanceof Error ? error.message.toLowerCase() : '';
	if (
		[
			'manifest',
			'resource',
			'sha256',
			'build environment',
			'package mismatch',
			'embedded cli',
		].some((needle) => message.includes(needle))
	) {
		return 'resource_unavailable';
	}
	if (message.includes('broker') || message.includes('socket') || message.includes('named pipe')) {
		return 'broker_unavailable';
	}
	return 'host_unavailable';
}

function isErrorCode(error: unknown, code: string): boolean {
	return Boolean(
		error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code,
	);
}
