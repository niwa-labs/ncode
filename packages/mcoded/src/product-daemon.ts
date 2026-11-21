/**
 * The product daemon composition (arch §4.1/§4.6, W2 wave): the one place
 * that turns "start an mcoded for this profile/dataDir" into a running
 * daemon.
 *
 * Responsibilities (§2.2, §4.6.1, §4.6.2, §4.7, §4.8):
 * - the `MCODE_SERVER_MODE` gate (`off` refuses with `SERVER_MODE_OFF`), then
 *   the switch is DELETED from the daemon's environment so child tools
 *   (`mcode exec` through bash-tool) inherit their caller's behavior, not the
 *   daemon's mode;
 * - the data plane is the profile data directory (or `--data-dir` /
 *   `MINIMAX_DATA_DIR`, realpath'd); the control plane is
 *   `resolveDaemonControlRoot` — the `dd-<hash>` branch keeps two windows
 *   with different data directories on separate daemons;
 * - the control root is created 0700 and verified (`ensureControlRootLayout`),
 *   and bound to exactly one dataDir via `daemon.json`;
 * - a fresh 32-byte handshake token (`mcoded.token`, 0600) is minted on every
 *   start and handed to the hub for the constant-time `hello.token` check;
 * - `daemon.json` (0600) records `{pid, buildId, protocol, dataDir, profile,
 *   region, buildEnv, state, startedAt, socketPath}` with the §4.6.2 п.3
 *   state transitions `starting` → `ready` / `failed:<reason>` → `stopped`;
 * - the runtime host is injected: the product composition lives in `tui`
 *   (`createEmbeddedRuntimeHost`, host kind `'tui'`), while `mcoded` stays a
 *   library. Default: the adapter's own `createLocalRuntimeHostV2` host
 *   (kind `'cli'`) — the standalone entry keeps working without `tui`.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { createLogger, type Logger } from '@mavis/logging';
import {
	DEFAULT_PROFILE_NAME,
	MCODE_SERVER_MODE_ENV,
	assertDaemonStartAllowed,
	ensureControlRootLayout,
	getConfig,
	getPrimaryDataDirPath,
	getRuntimeBuildEnv,
	getRuntimeRegion,
	normalizeProfileSelector,
	profileOfDataDir,
	readProfileEnv,
	resolveDaemonControlRoot,
	resolveDurableRoot,
	resolveMcodedSocketPath,
	resolveRealPath,
} from '@mavis/config';
import type {
	CreateLocalRuntimeHostOptions,
	CreatedLocalRuntimeHost,
} from '@mavis/local-runtime-v2/process-local';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';
import {
	clearSessionToolEnvProvider,
	setSessionToolEnvProvider,
} from '@mavis/local-runtime-v2/turn-system';

import { McodedDaemon, McodedDaemonError } from './daemon.js';
import { CliBridge } from './cli-bridge.js';
import {
	FileLockHeldError,
	MCODED_LOCK_BASENAME,
	acquireFileLockSelfHealing,
	type FileLock,
} from './daemon-lock.js';
import { LocalRuntimeV2Adapter } from './local-runtime-adapter.js';
import {
	createDaemonMcodeToolsAuthSession,
	prepareDaemonMcodeToolsIntegration,
	type DaemonMcodeToolsReadiness,
	type PrepareDaemonMcodeToolsIntegrationOptions,
} from './mcode-tools.js';
import {
	MCODED_LOG_BASENAME,
	MCODED_LOG_FILE_ENV,
	readLogRotationEnv,
	rotateBeforeSpawn,
	startLogRotation,
	type LogRotationConfig,
	type LogRotationHandle,
} from './log-rotation.js';
import { parseMcodedArgs } from './main.js';
import { MCODED_PROTOCOL_VERSION } from './protocol.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/** Control-root file holding the per-start handshake token (0600, arch §4.7). */
export const MCODED_TOKEN_BASENAME = 'mcoded.token';

/** Control-root file binding the control root to its daemon identity (§2.2). */
export const MCODED_MANIFEST_BASENAME = 'daemon.json';

/** Control-root directory for the daemon log the spawner points stdio at. */
export const MCODED_LOG_DIR_BASENAME = 'logs';

/** Lifecycle state recorded in `daemon.json` (§4.6.2 п.3). */
export type DaemonState = 'starting' | 'ready' | 'stopped' | `failed:${string}`;

/** The on-disk daemon identity (arch §2.2). */
export interface DaemonManifest {
	pid: number;
	buildId: string;
	protocol: number;
	dataDir: string;
	profile: string | null;
	region: string;
	buildEnv: string;
	state: DaemonState;
	startedAt: string;
	socketPath: string;
}

/** Thrown when the control root cannot serve the requested data directory. */
export class DaemonManifestError extends Error {
	readonly code: 'DATA_DIR_MISMATCH' | 'MANIFEST_INVALID';
	readonly controlRoot: string;

	constructor(code: 'DATA_DIR_MISMATCH' | 'MANIFEST_INVALID', controlRoot: string, message: string) {
		super(message);
		this.name = 'DaemonManifestError';
		this.code = code;
		this.controlRoot = controlRoot;
	}
}

/**
 * Thrown when an explicitly selected profile contradicts the dataDir it is
 * paired with: profile A plus a dataDir that is the primary data directory of
 * a DIFFERENT profile B (or of the default). Fail-closed (opus 2026-11-01):
 * silently picking one of the two identities would point one of them at the
 * wrong account's credentials. A profile paired with a genuinely foreign
 * dataDir is allowed — the control root moves to `dd-<hash>` and the profile
 * stays a label.
 */
export class ProfileDataDirMismatchError extends Error {
	readonly code = 'PROFILE_DATA_DIR_MISMATCH';
	/** The explicitly selected profile. */
	readonly profile: string;
	/** The profile the dataDir actually belongs to; `null` = the default profile. */
	readonly dataDirProfile: string | null;
	/** The requested dataDir, before realpathing. */
	readonly dataDir: string;

	constructor(profile: string, dataDirProfile: string | null, dataDir: string) {
		super(
			`Profile "${profile}" cannot be paired with dataDir "${dataDir}": that directory ` +
				`belongs to the ${dataDirProfile === null ? 'default' : `"${dataDirProfile}"`} profile. ` +
				'Drop --profile, drop --data-dir, or use a matching pair.',
		);
		this.name = 'ProfileDataDirMismatchError';
		this.profile = profile;
		this.dataDirProfile = dataDirProfile;
		this.dataDir = dataDir;
	}
}

/** Absolute path of `daemon.json` inside a control root. */
export function daemonManifestPath(controlRoot: string): string {
	return path.join(controlRoot, MCODED_MANIFEST_BASENAME);
}

/** Read `daemon.json`; `undefined` when absent or unparsable (tolerated). */
export function readDaemonManifest(controlRoot: string): DaemonManifest | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(daemonManifestPath(controlRoot), 'utf8');
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as DaemonManifest;
		if (typeof parsed.dataDir !== 'string' || typeof parsed.pid !== 'number') return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** Write `daemon.json` with `0600` (the pid binding must not be world-editable). */
export function writeDaemonManifest(controlRoot: string, manifest: DaemonManifest): void {
	fs.writeFileSync(daemonManifestPath(controlRoot), `${JSON.stringify(manifest, null, '\t')}\n`, {
		mode: 0o600,
	});
}

/** Read the current handshake token of a control root, if any. */
export function readDaemonToken(controlRoot: string): string | undefined {
	try {
		const raw = fs.readFileSync(path.join(controlRoot, MCODED_TOKEN_BASENAME), 'utf8').trim();
		return raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** Options of {@link resolveDaemonTargets}. */
export interface DaemonTargetsOptions {
	/**
	 * Explicit profile selector (`--profile`), raw: `'default'` normalizes to
	 * the implicit profile HERE (login wave 2026-11-02), and the env is not
	 * consulted when this is present. Absent → `readProfileEnv`, else
	 * inference from the dataDir, else the implicit profile.
	 */
	profile?: string;
	/** Requested data directory (`--data-dir`), before realpathing. */
	dataDir?: string | null;
	/** Control-root override (legacy `--root`); skips `resolveDaemonControlRoot`. */
	root?: string | null;
	/** Home directory for profile resolution (tests override this). */
	homeDir?: string;
	/** Environment backing the `MINIMAX_DATA_DIR`/`MAVIS_DATA_DIR` override. */
	env?: NodeJS.ProcessEnv;
}

/** Where a daemon for the given request lives (arch §2.2). */
export interface DaemonTargets {
	/** Effective profile (`null` = default profile). */
	profile: string | null;
	/** The data plane: realpath of the requested dataDir, else the profile dir. */
	dataDir: string;
	/** The control plane: socket, lock, token, manifest, event log, checkpoint. */
	controlRoot: string;
	/** The requested dataDir before realpathing, when one was given. */
	requestedDataDir?: string;
}

/**
 * Resolve the control root and the data plane of a daemon.
 *
 * The dataDir comes from the explicit request, else the `MINIMAX_DATA_DIR` /
 * `MAVIS_DATA_DIR` override (the same rule the TUI applies), else the
 * profile's primary data directory. The profile label resolves in priority
 * order (opus 2026-11-01; the selector is normalized HERE per the login-wave
 * decision, not at the CLI boundary): the explicit `--profile` — normalized
 * with {@link normalizeProfileSelector}, so `'default'` means the implicit
 * profile, and the env is NOT read when the flag is present (the config.ts
 * rule) — then `MINIMAX_PROFILE`, then INFERENCE from the requested dataDir
 * ({@link profileOfDataDir}) — the data plane's realpath is the identity,
 * and an inferred label lands in `targets.profile` so the spawn (`--profile`
 * argv flag, `MINIMAX_PROFILE` env) and the `daemon.json` binding carry it.
 *
 * Fail-closed: a profile the OPERATOR named (flag or env) paired with a
 * dataDir that is the primary data directory of a DIFFERENT profile throws
 * {@link ProfileDataDirMismatchError} — `--profile default` counts as named
 * even though it resolves to the implicit profile. An inferred label cannot
 * mismatch by construction. A profile paired with a genuinely foreign
 * dataDir stays allowed — the control root follows
 * {@link resolveDaemonControlRoot} to the `dd-<hash>` branch.
 */
export function resolveDaemonTargets(options: DaemonTargetsOptions = {}): DaemonTargets {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? env['HOME'];
	// The flag wins over the env whenever it is present — even when its value
	// is 'default' — the exact rule config.ts applies
	// (`cliArgValue("profile") ?? readProfileEnv()`). Normalizing HERE and not
	// at the CLI boundary: a string 'default' must survive into this resolver,
	// or the "the flag was given" signal would collapse into "no flag" and
	// MINIMAX_PROFILE would win again through the truthiness checks in
	// main.ts/launcher.ts.
	const flagGiven = options.profile !== undefined;
	const explicitProfile = flagGiven ? normalizeProfileSelector(options.profile) : null;
	const requested =
		options.dataDir?.trim() ||
		env['MINIMAX_DATA_DIR']?.trim() ||
		env['MAVIS_DATA_DIR']?.trim() ||
		'';
	const inferenceHome = homeDir ?? os.homedir();
	const envProfile = flagGiven ? null : readProfileEnv(env);
	// The explicit flag suppresses inference too (an explicit profile is a
	// complete answer, even when it normalizes to the implicit one).
	const inferred =
		!flagGiven && envProfile === null && requested !== ''
			? profileOfDataDir(inferenceHome, requested)
			: undefined;
	const profile =
		explicitProfile ??
		envProfile ??
		(inferred?.kind === 'profile' ? inferred.profile : null);

	// The label must not contradict the identity: a profile the OPERATOR
	// named (flag or env) cannot sit on another profile's dataDir. Keyed on
	// "named by the operator", NOT on `profile !== null`: `--profile default`
	// normalizes to the implicit profile (null) and still must refuse another
	// profile's dataDir. An inferred label cannot mismatch by construction —
	// it was READ off the dataDir. A foreign dataDir (no owner) is not a
	// contradiction.
	const operatorNamedProfile = flagGiven || envProfile !== null;
	if (operatorNamedProfile && requested !== '') {
		const owner = profileOfDataDir(inferenceHome, requested);
		const dataDirProfile =
			owner.kind === 'profile' ? owner.profile : owner.kind === 'default' ? null : undefined;
		if (dataDirProfile !== undefined && dataDirProfile !== profile) {
			// `profile` is null only when the operator named the implicit profile
			// (`--profile default`): report the selector they actually typed.
			throw new ProfileDataDirMismatchError(
				profile ?? options.profile ?? DEFAULT_PROFILE_NAME,
				dataDirProfile,
				requested,
			);
		}
	}

	// Always a realpath: the daemon.json binding, the hub's DATA_DIR_MISMATCH
	// check and the workspace layout must be symlink-proof, so the default
	// (not-yet-created) profile dir resolves through the same fallback rule.
	const dataDir = resolveRealPath(requested || getPrimaryDataDirPath(homeDir, profile));
	const controlRoot = options.root
		? path.resolve(options.root)
		: resolveDaemonControlRoot({ profile, dataDir: requested || null, homeDir });
	return {
		profile,
		dataDir,
		controlRoot,
		...(requested ? { requestedDataDir: requested } : {}),
	};
}

/**
 * Host factory injection (arch §5): the product composition passes
 * `createEmbeddedRuntimeHost` from `tui` so the daemon serves with the SAME
 * host policy as the in-process window (`runtimeOwnerKind: 'tui'` and what
 * `services.ts` derives from it). The param shape mirrors
 * `EmbeddedRuntimeHostOptions` — the fields `createEmbeddedRuntimeHost` pins
 * itself are absent, so the TUI factory plugs in directly.
 */
export type ProductDaemonHostFactory = (
	options: Omit<
		CreateLocalRuntimeHostOptions,
		| 'runtimeOwnerKind'
		| 'runtimeMode'
		| 'legacyOpencodeEnabled'
		| 'enableLiveMcp'
		| 'capabilityProfile'
		| 'isContextWindowUsageEnabled'
	>,
) => Promise<CreatedLocalRuntimeHost>;

/** Options of {@link startProductDaemon}. */
export interface ProductDaemonOptions {
	/** Argument vector; defaults to `process.argv.slice(2)`. */
	readonly argv?: readonly string[];
	/** Environment; defaults to `process.env` (mutated: the mode switch is removed). */
	readonly env?: NodeJS.ProcessEnv;
	/** Home directory for root resolution (tests override this). */
	readonly homeDir?: string;
	/** Host factory override; the TUI composition injects `createEmbeddedRuntimeHost`. */
	readonly createHost?: ProductDaemonHostFactory;
	/**
	 * The daemon-owned mcode-tools readiness (revision 11 F2): when the served
	 * config requests `beta.mcodeTools`, the broker, the launcher installation
	 * and the `__MAVIS_MCODE_TOOLS_*` activation live in THIS process — the
	 * one that survives the TUI window — instead of only reaching the daemon
	 * through env inheritance of the spawning window. Started before the host
	 * boots; disposed on the graceful shutdown. A not-ready readiness leaves
	 * the environment untouched, so the inherited-window keys remain the
	 * working fallback. Tests may replace it (`null` = disabled, a function =
	 * a fake); the default resolves the user config's `beta.mcodeTools`.
	 */
	readonly prepareMcodeTools?:
		| typeof prepareDaemonMcodeToolsIntegration
		| ((options: PrepareDaemonMcodeToolsIntegrationOptions) => Promise<DaemonMcodeToolsReadiness>)
		| null;
	/**
	 * Observed right after the readiness resolved (before the host boots):
	 * the product host factory (`createEmbeddedRuntimeHost` from the TUI
	 * composition) uses it to pin `productCapabilities.mcodeTools`, so the
	 * prompt surface reflects the broker the daemon actually owns.
	 */
	readonly onMcodeToolsReadiness?: (readiness: DaemonMcodeToolsReadiness) => void;
}

/**
 * Whether THIS daemon requests mcode-tools: the user config's
 * `beta.mcodeTools` — the same `getConfig()` source the runtime's
 * `configGetter` (`getDefaultLocalRuntimeConfig`) reads, so the gate matches
 * the prompt surface the served host will actually project.
 */
function isDaemonMcodeToolsRequested(env: NodeJS.ProcessEnv): boolean {
	void env;
	try {
		return getConfig().beta?.mcodeTools === true;
	} catch {
		return false;
	}
}

/** A started product daemon plus the handles its CLI needs. */
export interface ProductDaemonHandle {
	/** The serving daemon (socket, hub, graceful shutdown). */
	readonly daemon: McodedDaemon;
	/** Resolves once the graceful shutdown (drain + host close) completed. */
	readonly done: Promise<void>;
	/** Trigger the graceful shutdown; idempotent, also the signal path. */
	readonly stop: () => Promise<void>;
	readonly controlRoot: string;
	readonly dataDir: string;
	readonly manifestPath: string;
	readonly tokenPath: string;
}

/**
 * Start the product daemon and keep it serving until `stop`/SIGTERM/SIGINT.
 *
 * Resolves once the socket is listening (`daemon.json` state `ready`);
 * `handle.done` resolves after the graceful shutdown finalized the manifest.
 * Startup failures (mode gate, insecure control root, foreign dataDir
 * binding, bind refusal) reject and leave `failed:<reason>` behind.
 *
 * Note: `region`/`buildEnv` are read from THIS process's environment
 * (`getRuntimeRegion`/`getRuntimeBuildEnv`); a spawner must fix
 * `MAVIS_REGION`/`MAVIS_BUILD_ENV` before starting the daemon (§4.6.2 п.2).
 */
/** `MCODE_DETACHED_PERMISSION=wait|deny` (§4.5 п.3); anything else = `wait`. */
export function resolveDetachedPermission(env: NodeJS.ProcessEnv): 'wait' | 'deny' {
	return env['MCODE_DETACHED_PERMISSION']?.trim().toLowerCase() === 'deny' ? 'deny' : 'wait';
}

/**
 * The spawner's log plumbing (design 15, ДИЗАЙН 2), extracted from the two
 * duplicated daemon-spawn bodies (window auto-spawn + `daemon restart`):
 * mkdir 0700, the М3 pre-rotation (rename an over-ceiling log into the
 * generation chain BEFORE the fd exists), the O_APPEND 0600 fd the child's
 * stdio is handed, and the `MCODED_LOG_FILE` declaration the child's own
 * rotation (М2) requires — without the declaration (foreground `daemon
 * run`, a TTY, a user `>` redirection) the daemon never rotates, exactly as
 * designed. Pre-rotation failures are fail-open too: a log problem must
 * never block a spawn. The caller closes the fd in its `finally`.
 */
export function openDaemonLogFd(
	controlRoot: string,
	env: NodeJS.ProcessEnv,
	logger: Logger = log,
): { fd: number; logPath: string; childEnv: NodeJS.ProcessEnv } {
	const logDir = path.join(controlRoot, MCODED_LOG_DIR_BASENAME);
	// Explicit modes: the control root is already 0700; the log dir and the
	// log file must not silently widen the picture (0777&~umask dirs,
	// 0666&~umask files) even inside it.
	fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
	const logPath = path.join(logDir, MCODED_LOG_BASENAME);
	const config: LogRotationConfig = readLogRotationEnv(env, logger);
	try {
		rotateBeforeSpawn(logPath, config);
	} catch (error) {
		logger.warn('mcoded: log pre-rotation skipped', { err: error, path: logPath });
	}
	const fd = fs.openSync(logPath, 'a', 0o600);
	return { fd, logPath, childEnv: { ...env, [MCODED_LOG_FILE_ENV]: logPath } };
}

/**
 * The daemon-side GlobalEvent source for the v2 subscribe surface (§4.3.3,
 * W4): the runtime CliService's `watchEvents` bus, pumped lazily — the hub's
 * pump starts iterating only at `hub.start()`, which happens AFTER the host
 * boots, so the getter has a CliService by then; the small wait loop covers
 * composition orders where it does not yet.
 *
 * One reader per daemon life (the hub's pump is the only consumer); when the
 * hub stops iterating, the underlying `watchEvents` generator is closed
 * through its `return()`.
 */
export function lazyRuntimeGlobalEvents(getCli: () => CliService | undefined): AsyncIterable<unknown> {
	async function* pump(): AsyncGenerator<unknown> {
		let cli = getCli();
		for (let waited = 0; cli === undefined && waited < 120; waited += 1) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			cli = getCli();
		}
		if (!cli) {
			log.warn('global-events-source-unavailable');
			return;
		}
		const controller = new AbortController();
		try {
			for await (const event of cli.watchEvents(controller.signal)) {
				yield event;
			}
		} finally {
			controller.abort();
		}
	}
	return pump();
}

export async function startProductDaemon(
	options: ProductDaemonOptions = {},
): Promise<ProductDaemonHandle> {
	const argv = options.argv ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? env['HOME'];

	// §4.8 gate first, then drop the switch from our environment: child tools
	// inherit their CALLER's behavior, never the daemon's mode.
	assertDaemonStartAllowed(env);
	delete env[MCODE_SERVER_MODE_ENV];

	// Design 15 (М2): the spawner's log declaration — "your stderr is this
	// file, opened O_APPEND" — read once, then deleted next to the mode
	// switch so bash tools never inherit it (they would point the daemon-only
	// machinery at a file they do not own). Without the declaration
	// (foreground `daemon run`, a TTY, a user `>` redirection) the daemon
	// never rotates: truncating an undeclared fd-2 target would corrupt it.
	const logRotationConfig = readLogRotationEnv(env);
	const declaredLogPath = env[MCODED_LOG_FILE_ENV];
	delete env[MCODED_LOG_FILE_ENV];

	const args = parseMcodedArgs(argv);
	const targets = resolveDaemonTargets({
		profile: args.profile,
		dataDir: args.dataDir,
		root: args.root,
		homeDir,
		env,
	});
	const { controlRoot, dataDir } = targets;
	ensureControlRootLayout(controlRoot);

	// §2.2: a control root serves exactly ONE dataDir — the binding in
	// daemon.json is the on-disk truth. Both spellings are realpath'd at
	// check time: a dataDir that did not exist at first start (its realpath
	// materializes once the daemon creates it) must not read as a different
	// directory on the next start.
	const manifestPath = daemonManifestPath(controlRoot);
	const existing = readDaemonManifest(controlRoot);
	if (existing && resolveRealPath(existing.dataDir) !== resolveRealPath(dataDir)) {
		throw new DaemonManifestError(
			'DATA_DIR_MISMATCH',
			controlRoot,
			`control root "${controlRoot}" is bound to dataDir "${existing.dataDir}"; ` +
				`refusing to serve "${dataDir}" (use a different profile or dataDir)`,
		);
	}

	// The CAS lock comes BEFORE any control-plane write (arch §4.6.2 п.4): a
	// refused second start must not rotate the live daemon's token or trample
	// its manifest — it dies here, holding nothing. The loser re-reads the
	// winner's manifest so the refusal names the daemon that actually owns
	// the root (incident 2026-11-04: two auto-spawns raced, the CAS loser
	// overwrote the live winner's mcoded.token and management was lost).
	let lock: FileLock;
	try {
		// Owner requirement 2026-11-06: a crashed predecessor's lock debris no
		// longer strands the start — a PROVABLY dead holder (the pid liveness
		// check recoverStaleFileLock always applied) is recovered under the
		// inode guard and the start continues. A live foreign holder still
		// refuses below before anything is touched, so the spawn-race channel
		// of the 2026-11-04 incident stays fail-closed.
		const acquisition = acquireFileLockSelfHealing(
			path.join(controlRoot, MCODED_LOCK_BASENAME),
		);
		lock = acquisition.lock;
		if (acquisition.healedHolderPid !== undefined) {
			log.warn('daemon-start-healed-stale-lock', {
				controlRoot,
				deadHolderPid: acquisition.healedHolderPid,
			});
		}
	} catch (error) {
		if (error instanceof FileLockHeldError) {
			const winner = readDaemonManifest(controlRoot);
			const winnerSuffix = winner
				? ` [manifest: pid ${winner.pid}, state ${winner.state}, startedAt ${winner.startedAt}]`
				: '';
			throw new McodedDaemonError(
				'daemon-alive',
				`another mcoded daemon holds ${error.path} (pid ${error.holderPid})${winnerSuffix}; one daemon per control root`,
			);
		}
		throw error;
	}

	// §4.7: 32 random bytes, 0600, a new one on every start — written under
	// the lock, so the token on disk always belongs to the live daemon.
	// Publication is atomic and private (astra T1 п.5): the token is fully
	// written at a private temp path (0600) and renamed into place within the
	// same directory, so `mcoded.token` never exists truncated mid-write and
	// never keeps stale permissions of a previous file (`writeFileSync` on an
	// existing path neither fixes the mode nor avoids the truncate/read
	// window) — a reader sees either the old or the new complete secret.
	const tokenPath = path.join(controlRoot, MCODED_TOKEN_BASENAME);
	const publishToken = (token: string): void => {
		const tempPath = `${tokenPath}.tmp-${process.pid}`;
		try {
			fs.writeFileSync(tempPath, token, { mode: 0o600 });
			fs.renameSync(tempPath, tokenPath);
		} finally {
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// Renamed away (or never written) — nothing to clean.
			}
		}
	};

	const region = getRuntimeRegion();
	const buildEnv = getRuntimeBuildEnv();
	const manifestBase = {
		pid: process.pid,
		buildId: env['MCODE_BUILD_ID'] ?? 'dev',
		protocol: MCODED_PROTOCOL_VERSION,
		dataDir,
		profile: targets.profile,
		region,
		buildEnv,
		startedAt: new Date().toISOString(),
		socketPath: resolveMcodedSocketPath(controlRoot),
	};
	const finalize = (state: DaemonState): void => {
		try {
			writeDaemonManifest(controlRoot, { ...manifestBase, state });
		} catch (error) {
			log.warn('daemon-manifest-write-failed', { err: error, state });
		}
		if (state !== 'ready' && state !== 'starting') {
			// The token must not outlive the daemon it authenticates.
			try {
				fs.rmSync(tokenPath, { force: true });
			} catch (error) {
				log.warn('daemon-token-cleanup-failed', { err: error });
			}
		}
	};

	// The ownership contract of everything below (astra T1 п.1/п.2/п.4):
	// every control-plane write (manifest finalize, token publish/remove)
	// happens while THIS process holds the lock, and the release of the lock
	// is the LAST ownership act on every branch — success, stop, failure and
	// every failure in between. `ownershipReleased` gates the token self-heal
	// too: once the handoff happened, the file belongs to the successor and a
	// late heal must not rewrite it.
	let ownershipReleased = false;

	let resolveDone: () => void = () => undefined;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	let adapter: LocalRuntimeV2Adapter | undefined;
	let signalShutdown: () => void = () => undefined;
	let logRotation: LogRotationHandle | undefined;
	// Revision 11 F2: the daemon-owned mcode-tools readiness. The region and
	// buildEnv were resolved above (§4.6.2 п.2 identity), and the auth session
	// reads the SAME served dataDir's shared credential store the runtime's
	// model resolver uses.
	let mcodeToolsReadiness: DaemonMcodeToolsReadiness | undefined;

	try {
		const token = randomBytes(32).toString('hex');
		publishToken(token);

		/**
		 * The daemon is the lock holder, so its in-memory token is the source
		 * of truth for `mcoded.token` (incident 2026-11-04): any foreign
		 * content on disk (a losing spawner's leftover write, pre-fix debris)
		 * is rewritten with OUR token — but only while ownership is retained
		 * (astra T1 п.4): after the release handoff the file belongs to the
		 * successor and must not be healed. Called right after the start
		 * completes (heals a clobber that landed during the host boot) and on
		 * every hello that fails the token check (heals a live daemon without a
		 * kill — the first refused probe repairs the file and THIS hello is
		 * still refused UNAUTHORIZED; the next client re-reads it and passes).
		 */
		const resyncTokenFile = (reason: string): void => {
			if (ownershipReleased) return;
			try {
				if (readDaemonToken(controlRoot) === token) return;
				publishToken(token);
				log.warn('daemon-token-file-resynced', { controlRoot, reason });
			} catch (error) {
				log.warn('daemon-token-resync-failed', { err: error });
			}
		};
		finalize('starting');

		adapter = new LocalRuntimeV2Adapter({
			root: controlRoot,
			dataDir,
			auth: {
				profile: targets.profile,
				env,
				...(homeDir !== undefined ? { homeDir } : {}),
			},
			...(options.createHost ? { createHost: options.createHost } : {}),
		});
		// TS: closures over the `let` see the widened type; pin the value.
		const runtimeAdapter = adapter;
		// W3: the same runtime serves the v1 shim (through the adapter) and the
		// v2 `call`/`stream.open` surface (the bridge over its CliService). The
		// getter is lazy — the host boots on adapter.start() below, BEFORE the
		// socket opens, so a served `call` always finds a CliService.
		const daemon = new McodedDaemon({
			root: controlRoot,
			adapter: runtimeAdapter,
			// The `dd-<hash>` branch is a PURE control root: a `cas/` there would
			// be an orphan — the tool-spill CAS lives in the profile durable root
			// (arch §2.2) and `openCas` creates its layout on demand. The default
			// branch IS the profile durable root: keep the full durable layout.
			durableLayout: controlRoot === resolveDurableRoot(targets.profile, homeDir),
			handshake: {
				token,
				dataDir,
				env: { region, buildEnv },
				// The lazy half of the token self-heal: a hello refused on the
				// token re-asserts OUR token file before answering (see
				// {@link resyncTokenFile}) — a damaged file costs one refused
				// probe, not a dead daemon.
				resyncToken: () => resyncTokenFile('unauthorized-hello'),
			},
			hub: {
				bridge: new CliBridge({ cliService: () => runtimeAdapter.cliService }),
				// W4 (§4.5/D5): the runtime's GlobalEvent bus feeds the v2 subscribe
				// surface — `permission.ask` push, session events, catalog updates.
				// Lazy: the CliService exists only after `adapter.start()` below.
				globalEvents: lazyRuntimeGlobalEvents(() => runtimeAdapter.cliService),
				// `MCODE_DETACHED_PERMISSION=wait|deny` (§4.5 п.3; default `wait`).
				...(resolveDetachedPermission(env) === 'deny'
					? { detachedPermission: 'deny' as const }
					: {}),
			},
			// The product composition already holds the lock (acquired before
			// the token/manifest writes); the daemon holds it for refusal
			// purposes and the RELEASE belongs to this composition — it runs
			// only after the final control-plane writes (see stop and the catch
			// below; astra T1 п.1).
			lock,
			// `mcode daemon stop` (the shutdown frame) runs the SAME graceful path
			// as SIGTERM/SIGINT: drain, host close, manifest `stopped`.
			onShutdownRequested: () => {
				void stop();
			},
			// W5 (§4.6.5): `daemon.restart{when:'now'|'idle'}` runs the SAME
			// graceful drain and exits — the version-skew path (a newer client
			// schedules the restart; the next client respawns the newer build).
			onRestartRequested: () => {
				void stop();
			},
		});

		let stopping: Promise<void> | undefined;
		const stop = (): Promise<void> => {
		stopping ??= (async () => {
			process.removeListener('SIGTERM', signalShutdown);
			process.removeListener('SIGINT', signalShutdown);
			clearSessionToolEnvProvider();
			// Revision 11 F2: the daemon-owned broker dies only with the daemon.
			if (mcodeToolsReadiness) {
				await mcodeToolsReadiness.dispose().catch((error) => {
					log.warn('mcoded: mcode-tools dispose failed', { err: error });
				});
				mcodeToolsReadiness = undefined;
			}
				// Design 15: stop rotating before the drain — the shutdown log
				// lines that follow must not trigger a last rotation.
				logRotation?.stop();
				try {
					try {
						// Drain the hub first (refuse work, flush checkpoint + event
						// log, bye clients); only then tear the runtime host down.
						// Resource teardown only — the ADOPTED lock is NOT released
						// inside daemon.shutdown().
						await daemon.shutdown();
					} finally {
						await runtimeAdapter.close();
					}
				} finally {
					// The final control-plane writes happen UNDER ownership and the
					// release is the LAST ownership act (astra T1 п.1): a successor
					// can only acquire afterwards, so it can never lose its token to
					// our cleanup nor read a manifest we are about to overwrite.
					// Runs even when the drain failed — a failed drain must not
					// wedge the root with an eternally held lock either.
					finalize('stopped');
					ownershipReleased = true;
					daemon.releaseLock();
				}
				log.info('mcoded: shutdown complete', { socketPath: daemon.socketPath });
				resolveDone();
			})();
			return stopping;
		};
		signalShutdown = () => {
			void stop();
		};
		process.once('SIGTERM', signalShutdown);
		process.once('SIGINT', signalShutdown);

		// Revision 11 F2: the daemon-owned mcode-tools readiness starts BEFORE
		// the host boots, so the product host factory (via
		// `onMcodeToolsReadiness`) and the turn tools see the activation the
		// daemon itself owns — not just what a spawning window happened to
		// leave in the environment. A not-ready readiness is honest: the env
		// stays untouched and the inherited-window keys remain the fallback.
		const prepareMcodeTools =
			options.prepareMcodeTools === undefined
				? prepareDaemonMcodeToolsIntegration
				: (options.prepareMcodeTools ?? null);
		if (prepareMcodeTools) {
			mcodeToolsReadiness = await prepareMcodeTools({
				requested: isDaemonMcodeToolsRequested(env),
				dataDir,
				buildEnv,
				region,
				session: createDaemonMcodeToolsAuthSession({
					profile: targets.profile,
					dataDir,
					env,
					...(homeDir !== undefined ? { homeDir } : {}),
				}),
				entryUrl: import.meta.url,
			});
			options.onMcodeToolsReadiness?.(mcodeToolsReadiness);
			if (!mcodeToolsReadiness.ready && mcodeToolsReadiness.requested) {
				log.warn('mcoded: mcode-tools not ready', {
					category: mcodeToolsReadiness.category,
					buildEnv: mcodeToolsReadiness.buildEnv,
				});
			}
		}

		// Boot the runtime host BEFORE the socket opens (§4.6.2 п.3: a
		// successful hello means the daemon is ready — listen happens last).
		await runtimeAdapter.start();
		await daemon.start();
		// W4 (§4.4/R5): the hub's per-session snapshots drive the turn tool
		// contexts. Cleared on shutdown so a stopped daemon never serves a
		// later session's tools from stale window env.
		setSessionToolEnvProvider((sessionId) => {
			const hub = daemon.hubOrNull;
			return hub?.sessionToolEnv.get(sessionId);
		});
		finalize('ready');
		// Incident 2026-11-04, self-heal: the host boot above can take seconds —
		// a clobber that lands inside it (a pre-fix loser's token write) must not
		// strand a serving daemon with a foreign token file. The lock holder's
		// token is the truth; verify once the start completed.
		resyncTokenFile('start-completed');
		// Design 15 (М2): bound the declared log with the in-daemon copytruncate.
		// Started only once the daemon is ready; the timer is unref'd (it never
		// holds the loop) and `stop()` above clears it before the drain.
		logRotation = startLogRotation({
			...(declaredLogPath !== undefined ? { path: declaredLogPath } : {}),
			maxBytes: logRotationConfig.maxBytes,
			keep: logRotationConfig.keep,
		});
		log.info('mcoded: listening', {
			socketPath: daemon.socketPath,
			adopted: daemon.isAdopted,
			runtime: 'local-runtime-v2',
			controlRoot,
			dataDir,
		});
		return { daemon, done, stop, controlRoot, dataDir, manifestPath, tokenPath };
	} catch (error) {
		// The guaranteed cleanup of the WHOLE acquire→ready window (astra T1
		// п.2): a failure anywhere after the lock was won — token write,
		// constructors, listener wiring, host boot, listen — finalizes and
		// releases OUR OWN ownership, so a live caller is never left holding a
		// phantom lock. The pid-guarded release can never remove a file that
		// already belongs to someone else; nothing here touches a successor's
		// control plane.
		process.removeListener('SIGTERM', signalShutdown);
		process.removeListener('SIGINT', signalShutdown);
		// The daemon-owned readiness never outlives a failed boot either.
		if (mcodeToolsReadiness) {
			await mcodeToolsReadiness.dispose().catch(() => undefined);
			mcodeToolsReadiness = undefined;
		}
		await adapter?.close().catch(() => undefined);
		if (!ownershipReleased) {
			// Ownership finalization BEFORE the release (astra T1 п.1) — the
			// failed manifest and the token removal are control-plane writes
			// too. Skipped only when a concurrent stop() already finalized and
			// released (a signal racing the boot).
			finalize(`failed:${error instanceof Error ? error.name : 'unknown'}`);
			ownershipReleased = true;
			lock.release();
		}
		resolveDone();
		throw error;
	}
}
