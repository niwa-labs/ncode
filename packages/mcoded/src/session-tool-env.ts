/**
 * The per-session tool-env snapshot store (arch §4.4, R5/W0-F2).
 *
 * The window's cwd/env (venv, PATH, AWS_PROFILE…) differ from the daemon's
 * process env, so the attach frame carries a snapshot and the daemon applies
 * it to THAT session's tool spawns. Rules pinned by the arch:
 *
 * - in-memory only: never persisted, never logged (§4.7);
 * - the last `owner`-role attach wins; `observer` attaches never overwrite;
 * - without a snapshot the tools run with the daemon's env (today's F2
 *   behavior), so the off-path and v1 clients are unaffected;
 * - the snapshot survives detach for the session's daemon lifetime (a
 *   re-attach window resumes the same env).
 *
 * The hub feeds {@link applyAttach}; the daemon composition exposes
 * {@link get} to the runtime's tool-context assembly, which overlays the
 * snapshot onto the spawn env BEFORE the always-on sanitizer (so `MCODE_*`/
 * `MINIMAX_*` stay stripped regardless of what the window sent — the window
 * filters them on its side, the daemon re-strips on its side).
 *
 * @module
 */

/** The attach snapshot (`session.attach.toolEnv`), already wire-validated. */
export interface SessionToolEnv {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

/** env prefixes the daemon never accepts from a window (defense in depth). */
const RESERVED_ENV_PREFIXES = ['MCODE_', 'MINIMAX_'];

/** Strip daemon-reserved names from a window-supplied env snapshot. */
export function sanitizeSessionToolEnv(env: Readonly<Record<string, string>>): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		clean[name] = value;
	}
	return clean;
}

export class SessionToolEnvStore {
	private readonly snapshots = new Map<string, SessionToolEnv>();

	/**
	 * Apply one `session.attach` snapshot ("last owner attach wins").
	 * An attach without a snapshot keeps the previous one.
	 */
	applyAttach(sessionId: string, role: 'owner' | 'observer', toolEnv: SessionToolEnv | undefined): void {
		if (role !== 'owner') return;
		if (toolEnv === undefined) return;
		this.snapshots.set(sessionId, {
			...(toolEnv.cwd !== undefined ? { cwd: toolEnv.cwd } : {}),
			...(toolEnv.env !== undefined ? { env: sanitizeSessionToolEnv(toolEnv.env) } : {}),
		});
	}

	/** The live snapshot for the session, or `undefined` (daemon env). */
	get(sessionId: string): SessionToolEnv | undefined {
		return this.snapshots.get(sessionId);
	}

	/** Forget one session (session deleted/archived on the daemon side). */
	forget(sessionId: string): void {
		this.snapshots.delete(sessionId);
	}

	/** Live snapshot count (daemon.status/tests). */
	get size(): number {
		return this.snapshots.size;
	}
}
