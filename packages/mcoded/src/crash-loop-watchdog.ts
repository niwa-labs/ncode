/**
 * The client-side watchdog against crash-looping daemons (arch §4.6.4 п.3):
 *
 * > 3 падения за 60 с → клиент перестаёт респавнить и показывает путь к
 * > `logs/mcoded.log` и подсказку `MCODE_SERVER_MODE=off`.
 *
 * The client cannot observe a daemon's exit directly; the honest client-side
 * signal is the auto-spawn hook STARTING a child and the connect STILL
 * failing afterwards — each such round is one daemon life that died (a
 * sibling window's no-op spawn round is NOT a crash: the hook reports what
 * it did, `createDaemonAutoSpawnHook` in the TUI package returns whether it
 * actually started a child).
 *
 * Hysteresis: once tripped, the watchdog STAYS tripped until the crash
 * window has been quiet for a full cooldown — a pure sliding window would
 * un-trip itself mid-loop and restart the very respawn storm it stopped.
 *
 * @module
 */

/** Counting window and trip threshold (§4.6.4: 3 falls per 60 s). */
export const CRASH_LOOP_WINDOW_MS = 60_000;
export const CRASH_LOOP_MAX_CRASHES = 3;
/** Post-trip quiet time before respawning is allowed again (the hysteresis). */
export const CRASH_LOOP_COOLDOWN_MS = 60_000;

/** Why {@link CrashLoopWatchdog.recordCrash} decided as it did. */
export type CrashLoopDecision =
	| { readonly allowSpawn: true }
	| {
			readonly allowSpawn: false;
			readonly crashes: number;
			readonly windowMs: number;
			/** When respawning may resume (epoch ms), given the cooldown. */
			readonly retryAfterMs: number;
	  };

export interface CrashLoopWatchdogOptions {
	readonly windowMs?: number;
	readonly maxCrashes?: number;
	readonly cooldownMs?: number;
	/**
	 * Path surfaced in the trip message (the daemon's `logs/mcoded.log`).
	 * Design 15: the trip message also points at the rotated `.1…`
	 * generations — the crash trace may sit in a previous one.
	 */
	readonly logPath?: string;
	readonly now?: () => number;
}

/** The error thrown once the watchdog trips (surfaced verbatim to the user). */
export class McodedCrashLoopError extends Error {
	override readonly name = 'McodedCrashLoopError';
	readonly crashes: number;
	readonly windowMs: number;
	readonly retryAfterMs: number;

	constructor(
		decision: Extract<CrashLoopDecision, { allowSpawn: false }>,
		logPath?: string,
	) {
		super(
			`mcoded crash-loop: ${decision.crashes} daemon starts failed within ` +
				`${Math.round(decision.windowMs / 1000)}s; auto-spawn stopped. ` +
				// Design 15: log rotation (mcoded.log.1…) can move the crash
				// trace into a previous generation — point at it too.
				`See the daemon log${logPath ? ` (${logPath} and .1…)` : ''} for the cause, or ` +
				`set MCODE_SERVER_MODE=off to run without the daemon. Respawning ` +
				`resumes after ${Math.ceil(decision.retryAfterMs / 1000)}s of quiet.`,
		);
		this.crashes = decision.crashes;
		this.windowMs = decision.windowMs;
		this.retryAfterMs = decision.retryAfterMs;
	}
}

/**
 * Count daemon lives and refuse to respawn a crash loop. Pure clock-based
 * state — no timers, fully injectable for tests.
 */
export class CrashLoopWatchdog {
	private readonly windowMs: number;
	private readonly maxCrashes: number;
	private readonly cooldownMs: number;
	private readonly logPath: string | undefined;
	private readonly now: () => number;
	private readonly crashes: number[] = [];
	private trippedAt: number | undefined;

	constructor(options: CrashLoopWatchdogOptions = {}) {
		this.windowMs = options.windowMs ?? CRASH_LOOP_WINDOW_MS;
		this.maxCrashes = options.maxCrashes ?? CRASH_LOOP_MAX_CRASHES;
		this.cooldownMs = options.cooldownMs ?? CRASH_LOOP_COOLDOWN_MS;
		this.logPath = options.logPath;
		this.now = options.now ?? Date.now;
	}

	/** Record one dead daemon life; answers whether a respawn may proceed. */
	recordCrash(): CrashLoopDecision {
		const at = this.now();
		this.prune(at);
		this.crashes.push(at);
		if (this.trippedAt !== undefined) {
			// Hysteresis: a trip persists until the window has been quiet for a
			// full cooldown — then the state resets cleanly.
			if (at - this.trippedAt >= this.cooldownMs && this.crashes.length === 0) {
				this.trippedAt = undefined;
			}
		}
		if (this.trippedAt !== undefined || this.crashes.length >= this.maxCrashes) {
			this.trippedAt ??= at;
			return {
				allowSpawn: false,
				crashes: this.crashes.length,
				windowMs: this.windowMs,
				retryAfterMs: Math.max(
					0,
					this.trippedAt + this.cooldownMs - at,
				),
			};
		}
		return { allowSpawn: true };
	}

	/** Whether a spawn may proceed RIGHT NOW (checked before hooking). */
	canSpawn(): boolean {
		if (this.trippedAt === undefined) return true;
		const at = this.now();
		this.prune(at);
		if (at - this.trippedAt >= this.cooldownMs && this.crashes.length === 0) {
			this.trippedAt = undefined;
			return true;
		}
		return false;
	}

	/**
	 * {@link canSpawn} that THROWS the trip error — the connect loop's
	 * "stop respawning, tell the user why" exit (§4.6.4).
	 */
	requireSpawn(): void {
		if (this.canSpawn()) return;
		throw new McodedCrashLoopError(
			{
				allowSpawn: false,
				crashes: this.maxCrashes,
				windowMs: this.windowMs,
				retryAfterMs: Math.max(0, this.trippedAt! + this.cooldownMs - this.now()),
			},
			this.logPath,
		);
	}

	/** The trip message with the daemon-log path (§4.6.4's user-facing half). */
	tripMessage(decision: Extract<CrashLoopDecision, { allowSpawn: false }>): string {
		return new McodedCrashLoopError(decision, this.logPath).message;
	}

	/** Drop crashes that left the counting window. */
	private prune(at: number): void {
		while (this.crashes.length > 0 && at - this.crashes[0]! > this.windowMs) {
			this.crashes.shift();
		}
	}
}
