/**
 * The `MCODED_RUNTIME` switch of the daemon entry: which runtime adapter the
 * standalone daemon boots.
 *
 * The hybrid default (W10: the new path stops being opt-in dead code) is the
 * product runtime (`local-v2`); `echo` is the explicit legacy compatibility
 * mode; any other value is a typed startup failure — a typo must never
 * silently downgrade the daemon to the stub.
 *
 * Split from `daemon-entry.ts` so embedders and tests can resolve the switch
 * without importing the self-starting entry module.
 *
 * @module
 */

import process from 'node:process';

/** Which runtime adapter the daemon entry boots. */
export type McodedRuntimeKind = 'local-v2' | 'echo';

/** Env switch selecting the runtime adapter; absence resolves to the hybrid default. */
export const MCODED_RUNTIME_ENV = 'MCODED_RUNTIME';

/**
 * Typed refusal of an unknown `MCODED_RUNTIME` value: startup fails instead
 * of silently downgrading to the echo skeleton.
 */
export class McodedRuntimeConfigError extends Error {
	readonly code = 'MCODED_RUNTIME_UNSUPPORTED';

	constructor(readonly value: string) {
		super(
			`unsupported ${MCODED_RUNTIME_ENV} value ${JSON.stringify(value)}; ` +
				`supported values: "local-v2" (default), "echo" (legacy skeleton)`,
		);
		this.name = 'McodedRuntimeConfigError';
	}
}

/**
 * Resolve the runtime adapter kind from the environment. The hybrid default
 * is the product runtime (`local-v2`); `echo` is the explicit legacy
 * compatibility mode; anything else throws {@link McodedRuntimeConfigError}
 * (fail-closed — never a silent downgrade to the stub).
 */
export function resolveMcodedRuntimeKind(env: NodeJS.ProcessEnv = process.env): McodedRuntimeKind {
	const raw = env[MCODED_RUNTIME_ENV];
	if (raw === undefined || raw === '') return 'local-v2';
	if (raw === 'local-v2' || raw === 'echo') return raw;
	throw new McodedRuntimeConfigError(raw);
}
