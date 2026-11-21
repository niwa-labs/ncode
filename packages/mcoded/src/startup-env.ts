/**
 * Startup-environment resolution for the standalone `mcoded` daemon entry
 * (W2 live-check finding: env identity parity with the TUI CLI).
 *
 * The TUI CLI (`tui/src/cli/environment.ts`) resolves the profile's auth
 * environment before anything else and pins `MAVIS_REGION`/`MAVIS_BUILD_ENV`
 * accordingly; a daemon started from a bare shell used to inherit whatever
 * the ambient env had (typically nothing → `en`/`dev`), so profile-aware
 * clients arrived with a different identity and the v2 handshake rejected
 * them with `ENV_MISMATCH` — including `daemon stop`, which then could not
 * reach the process at all.
 *
 * Resolution order (tui/cli/environment.ts parity):
 * 1. explicit `MAVIS_REGION` in the env wins (caller only asks when absent);
 * 2. the profile's `runtime-region` preference file;
 * 3. the shared auth scope recorded beside the credentials;
 * 4. `cn` — the same default the TUI applies for managed accounts.
 *
 * `buildEnv` has no profile-side preference today: the TUI pins it from its
 * own startup options, so this helper leaves the ambient default in place
 * unless the env already carries it.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import path from 'node:path';

import { readProfileEnv, resolveProfileDataDirPaths } from '@mavis/config/auth-profile';

export interface ProfileStartupEnvironment {
	/** Region the daemon should serve ('cn' | 'en'); never undefined. */
	readonly region: 'cn' | 'en';
	/**
	 * Build environment when the ambient env pins it; `undefined` leaves the
	 * `prod` default of the product daemon in place.
	 */
	readonly buildEnv: 'prod' | 'dev' | undefined;
}

interface RegionPreferenceRecord {
	readonly version?: number;
	readonly regions?: Partial<Record<'prod' | 'dev', 'cn' | 'en'>>;
}

/**
 * Resolve the startup env identity for the daemon from the ambient
 * environment and the selected profile. Never throws: a missing profile or
 * unreadable preferences fall back to the ambient/`cn` defaults so the
 * standalone entry keeps starting (the handshake check remains the loud
 * safety net for real mismatches).
 */
export function readProfileStartupEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string | undefined = env['HOME'],
): ProfileStartupEnvironment {
	const buildEnv = env['MAVIS_BUILD_ENV'] === 'dev' ? 'dev' : env['MAVIS_BUILD_ENV'] === 'prod' ? 'prod' : undefined;
	const explicit = env['MAVIS_REGION'];
	if (explicit === 'cn' || explicit === 'en') return { region: explicit, buildEnv };

	const profile = readProfileEnv(env);
	try {
		const { dataDir } = resolveProfileDataDirPaths(profile, homeDir);
		// TUI parity (`tui/src/auth/region-preference.ts`): the preference
		// file is `preferences/mcode-region.json` with a per-buildEnv region.
		const preferencePath = path.join(dataDir, 'preferences', 'mcode-region.json');
		if (existsSync(preferencePath)) {
			const record = JSON.parse(readFileSync(preferencePath, 'utf8')) as RegionPreferenceRecord;
			const region = record.regions?.[buildEnv ?? 'prod'];
			if (region === 'cn' || region === 'en') {
				return { region, buildEnv };
			}
		}
	} catch {
		// Unreadable/absent profile preferences: fall through to the default.
	}
	// TUI parity: the managed-account default is `cn`, not the `en` of
	// `getRuntimeRegion()`'s bare-shell fallback.
	return { region: 'cn', buildEnv };
}
