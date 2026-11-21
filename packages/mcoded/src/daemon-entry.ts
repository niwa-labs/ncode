/**
 * The `mcoded` daemon entry point of the standalone build: the resident
 * process that serves the profile's data directory over its unix socket.
 *
 * All product composition lives in `product-daemon.ts` (the `SERVER_MODE`
 * gate, the control/data split, `daemon.json`, the handshake token); the TUI
 * CLI injects its `createEmbeddedRuntimeHost` factory there. This file stays
 * the thin self-starting `dist/mcoded.js` wrapper:
 * - `resolveMcodedRuntimeKind` (see `runtime-kind.ts`) resolves `MCODED_RUNTIME`
 *   to `local-v2` unless the legacy echo skeleton is explicitly requested with
 *   `MCODED_RUNTIME=echo`; any other value fails the startup (never a silent
 *   downgrade);
 * - the echo branch keeps the skeleton composition (`mcodedMain`).
 *
 * Lifecycle (product runtime): start the runtime host on the profile dataDir,
 * serve the control root until SIGTERM/SIGINT, drain the hub (checkpoint and
 * event log flush inside the graceful shutdown), then close the runtime host
 * and exit. The product runtime inherits the selected profile's auth
 * (`--profile` / `MINIMAX_PROFILE`).
 *
 * @module
 */

import process from 'node:process';

import { createLogger } from '@mavis/logging';

import { McodedDaemon } from './daemon.js';
import { mcodedMain } from './main.js';
import { startProductDaemon } from './product-daemon.js';
import { resolveMcodedRuntimeKind } from './runtime-kind.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/** Exit code reported when the daemon cannot start. */
export const MCODED_START_FAILURE_EXIT_CODE = 1;

export interface McodedDaemonEntryOptions {
	/** Argument vector; defaults to `process.argv.slice(2)`. */
	readonly argv?: readonly string[];
	/** Environment; defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** Home directory for durable-root resolution (tests override this). */
	readonly homeDir?: string;
}

/**
 * Run the daemon until a termination signal arrives. The promise resolves
 * once the daemon is serving; shutdown runs from the signal path. Startup
 * failures reject.
 */
export async function mcodedDaemonEntry(
	options: McodedDaemonEntryOptions = {},
): Promise<McodedDaemon> {
	const argv = options.argv ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? env['HOME'];

	// Live-check finding (W2): the TUI CLI applies the profile's startup
	// environment (region/buildEnv) before spawning, but this standalone
	// entry used to read the raw process env — a daemon started from a
	// shell without MAVIS_REGION/MAVIS_BUILD_ENV lived in `en/dev` while
	// every `mcode daemon status/stop` (profile-aware) arrived as `cn/prod`,
	// so the v2 handshake rejected with ENV_MISMATCH and `stop` could not
	// reach the daemon. Pin the same identity here: inherit explicit env,
	// fall back to the profile preference (tui/cli/environment.ts parity).
	if (env['MAVIS_REGION'] === undefined || env['MAVIS_BUILD_ENV'] === undefined) {
		try {
			// Lazy import: the config surface is not on the daemon's hot path.
			const { readProfileStartupEnvironment } = await import('./startup-env.js');
			const startup = readProfileStartupEnvironment(env, homeDir);
			if (env['MAVIS_REGION'] === undefined && startup.region !== undefined) {
				env['MAVIS_REGION'] = startup.region;
			}
			if (env['MAVIS_BUILD_ENV'] === undefined && startup.buildEnv !== undefined) {
				env['MAVIS_BUILD_ENV'] = startup.buildEnv;
			}
		} catch {
			// Profile resolution must not break the standalone daemon: the
			// handshake check (ENV_MISMATCH) surfaces any mismatch loudly.
		}
	}

	if (resolveMcodedRuntimeKind(env) === 'echo') {
		// Explicit legacy compatibility mode: the deterministic echo skeleton,
		// the same adapter default `mcodedMain` used to boot.
		return mcodedMain({ argv, env, homeDir });
	}

	const handle = await startProductDaemon({ argv, env, homeDir });
	return handle.daemon;
}

mcodedDaemonEntry().catch((error: unknown) => {
	log.error('mcoded: startup failed', { err: error });
	process.exitCode = MCODED_START_FAILURE_EXIT_CODE;
});
