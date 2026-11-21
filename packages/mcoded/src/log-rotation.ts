/**
 * Rotation of the daemon log (`logs/mcoded.log`) the spawners point the
 * child's stdio at (design 15, ДИЗАЙН 2): bound a file that was growing
 * unboundedly.
 *
 * Two cooperating halves:
 * - `rotateBeforeSpawn` (М3) — the SPAWNER-side rename rotation, run before
 *   the log fd exists (`openDaemonLogFd` in `product-daemon.ts`): zero risk
 *   (no descriptor is open yet), O(1) on any filesystem, and it drains the
 *   existing multi-МВ backlog on the first spawn.
 * - `copyTruncate` / `startLogRotation` (М2) — the DAEMON-side copytruncate
 *   on fd 2. fd 1, fd 2 and every child that inherited the descriptor share
 *   one O_APPEND file description, so the classic rename+reopen would leave
 *   them all writing to the renamed (and eventually deleted-but-open) inode
 *   — an invisible disk leak until process death, and Node has no `dup2`.
 *   Here the fd and the inode never change; only the CONTENT moves to
 *   `<log>.1` (APFS: `COPYFILE_FICLONE` = clonefile, O(1)).
 *
 * Safety envelope:
 * - rotation runs only when the spawner DECLARED the log (`MCODED_LOG_FILE`);
 *   foreground `daemon run`, TTYs and user redirections `>` never declare
 *   it, and truncating an undeclared fd-2 target would corrupt it;
 * - only while fd 2 still IS that exact file (dev/ino guard);
 * - fail-open: any error emits ONE `mcoded: log rotation disabled` warning
 *   and disables rotation for the rest of the process life — the daemon
 *   never dies over a log.
 *
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';

import { createLogger, type Logger } from '@mavis/logging';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/** The spawner's declaration: "your stderr is this file, opened O_APPEND". */
export const MCODED_LOG_FILE_ENV = 'MCODED_LOG_FILE';

/** Per-generation size ceiling; `0` disables rotation entirely. */
export const MCODED_LOG_MAX_BYTES_ENV = 'MCODED_LOG_MAX_BYTES';

/** Retained generations (`<log>.1` … `<log>.<keep>`), 1…10. */
export const MCODED_LOG_KEEP_ENV = 'MCODED_LOG_KEEP';

/** The daemon log's basename inside `<controlRoot>/logs`. */
export const MCODED_LOG_BASENAME = 'mcoded.log';

/** N = 20 МиБ: weeks at `warn`, about a day at `info` (design 15 §б). */
export const DEFAULT_MCODED_LOG_MAX_BYTES = 20 * 1024 * 1024;

/** K = 3 generations — an 80 МиБ ceiling per profile ((K+1)·N). */
export const DEFAULT_MCODED_LOG_KEEP = 3;

/** How often the daemon re-checks the declared log's size. */
export const MCODED_LOG_ROTATION_INTERVAL_MS = 60_000;

/** The size/generations policy both the spawner (М3) and the daemon (М2) read. */
export interface LogRotationConfig {
	/** Ceiling per generation; `0` = rotation disabled. */
	readonly maxBytes: number;
	/** Retained generations, 1…10. */
	readonly keep: number;
}

function isENOENT(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Read `MCODED_LOG_MAX_BYTES` / `MCODED_LOG_KEEP` — the env knobs BOTH the
 * spawner and the daemon honor. An invalid value keeps the default and emits
 * exactly one warning; `0` is the explicit opt-out, not an error.
 */
export function readLogRotationEnv(
	env: Record<string, string | undefined>,
	logger: Logger = log,
): LogRotationConfig {
	let maxBytes = DEFAULT_MCODED_LOG_MAX_BYTES;
	let keep = DEFAULT_MCODED_LOG_KEEP;
	const rawMax = env[MCODED_LOG_MAX_BYTES_ENV];
	if (rawMax !== undefined && rawMax !== '') {
		const parsed = Number(rawMax);
		if (!Number.isInteger(parsed) || parsed < 0) {
			logger.warn('mcoded: invalid MCODED_LOG_MAX_BYTES, using default', {
				value: rawMax,
				default: maxBytes,
			});
		} else {
			maxBytes = parsed;
		}
	}
	const rawKeep = env[MCODED_LOG_KEEP_ENV];
	if (rawKeep !== undefined && rawKeep !== '') {
		const parsed = Number(rawKeep);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
			logger.warn('mcoded: invalid MCODED_LOG_KEEP, using default', {
				value: rawKeep,
				default: keep,
			});
		} else {
			keep = parsed;
		}
	}
	return { maxBytes, keep };
}

function generationPath(logPath: string, generation: number): string {
	return `${logPath}.${generation}`;
}

/**
 * Bump the `.1` … `.<keep>` chain one step: drop `.<keep>`, rename every
 * younger generation up. A missing generation is not an error (nothing to
 * move). The live log itself is NEVER renamed here — that is the М1 trap
 * (the inherited descriptor would keep writing to the renamed inode).
 */
export function shiftGenerations(logPath: string, keep: number): void {
	try {
		fs.unlinkSync(generationPath(logPath, keep));
	} catch (error) {
		if (!isENOENT(error)) throw error;
	}
	for (let i = keep - 1; i >= 1; i--) {
		try {
			fs.renameSync(generationPath(logPath, i), generationPath(logPath, i + 1));
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
	}
}

/**
 * М3 — the spawner-side rotation, run BEFORE the fd exists (`openDaemonLogFd`):
 * an over-ceiling log is renamed straight into the generation chain. No
 * descriptor is open yet, so nothing can keep writing to the renamed inode.
 * If the previous daemon is still draining into that inode (a restart race),
 * its lines land in `.1` — harmless by design. Rotation disabled (`0`) or a
 * within-ceiling log leaves the file untouched.
 */
export function rotateBeforeSpawn(logPath: string, config: LogRotationConfig): void {
	if (config.maxBytes <= 0) return;
	let size: number;
	try {
		size = fs.statSync(logPath).size;
	} catch (error) {
		if (isENOENT(error)) return;
		throw error;
	}
	if (size <= config.maxBytes) return;
	shiftGenerations(logPath, config.keep);
	fs.renameSync(logPath, generationPath(logPath, 1));
}

/** Options of {@link copyTruncate} (М2, one synchronous section). */
export interface CopyTruncateOptions {
	/** The O_APPEND descriptor both stdio of the daemon point at (fd 2). */
	readonly fd: number;
	/** The declared log path (`MCODED_LOG_FILE`). */
	readonly path: string;
	readonly maxBytes: number;
	readonly keep: number;
}

/**
 * М2 — the copytruncate, one SYNCHRONOUS tick: size check → shift
 * generations → copy the current log to `.1` → `ftruncate` THROUGH THE FD
 * (never the path: fd 1/2 must stay on the same inode) → the marker line as
 * the fresh file's first bytes. The descriptor is O_APPEND, so the next
 * write lands at offset 0 — no sparse hole. A JS signal handler cannot
 * interleave this section (it runs after the tick).
 */
export function copyTruncate(options: CopyTruncateOptions): void {
	const { fd, path: logPath, maxBytes, keep } = options;
	const size = fs.fstatSync(fd).size;
	if (size <= maxBytes) return;
	shiftGenerations(logPath, keep);
	const first = generationPath(logPath, 1);
	fs.copyFileSync(logPath, first, fs.constants.COPYFILE_FICLONE);
	// copy/clone preserves the source mode; enforce 0600 anyway — a rotation
	// must not be the thing that widens the spawner's 0600 picture.
	if ((fs.statSync(first).mode & 0o777) !== 0o600) {
		fs.chmodSync(first, 0o600);
	}
	fs.ftruncateSync(fd, 0);
	fs.writeSync(fd, `mcoded: log rotated (prev ${size} → ${path.basename(logPath)}.1)\n`);
}

/** Options of {@link startLogRotation}. */
export interface StartLogRotationOptions {
	/** Defaults to 2 — the daemon's stderr, the descriptor the spawner shared. */
	readonly fd?: number;
	/**
	 * The declared log path. `undefined` (no `MCODED_LOG_FILE` — foreground
	 * `daemon run`, a TTY, a user redirection) disables rotation entirely.
	 */
	readonly path?: string;
	readonly maxBytes: number;
	readonly keep: number;
	readonly intervalMs?: number;
	readonly log?: Logger;
}

/** The handle `stop()` clears the timer with. */
export interface LogRotationHandle {
	stop(): void;
}

/**
 * М2 wired for the daemon: one check at start (catches a pre-М3 spawner that
 * handed over an already over-ceiling log) plus an unref'd interval — the
 * timer must never hold the daemon's event loop. Every check re-proves the
 * inode identity (fd must still BE the declared file); any error is
 * fail-open: ONE warning, then rotation is off for the process life.
 */
export function startLogRotation(options: StartLogRotationOptions): LogRotationHandle {
	const { fd = 2, path: logPath, maxBytes, keep } = options;
	const logger = options.log ?? log;
	const intervalMs = options.intervalMs ?? MCODED_LOG_ROTATION_INTERVAL_MS;
	// No declaration or explicit opt-out: a stopped no-op, not an error.
	if (logPath === undefined || maxBytes <= 0) {
		return { stop: () => undefined };
	}
	let timer: NodeJS.Timeout | undefined;
	let disabled = false;
	const disable = (): void => {
		disabled = true;
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	const check = (): void => {
		if (disabled) return;
		try {
			// Inode guard: rotation may only truncate a file it can PROVE is
			// this fd's own inode. A stale declaration (external logrotate, a
			// user redirection) must disable rotation, not truncate a stranger.
			const fdStat = fs.fstatSync(fd);
			const fileStat = fs.statSync(logPath);
			if (
				!fdStat.isFile() ||
				!fileStat.isFile() ||
				fdStat.dev !== fileStat.dev ||
				fdStat.ino !== fileStat.ino
			) {
				disable();
				logger.debug('mcoded: log rotation disabled (fd is not the declared log file)', {
					fd,
					path: logPath,
				});
				return;
			}
			copyTruncate({ fd, path: logPath, maxBytes, keep });
		} catch (error) {
			disable();
			logger.warn('mcoded: log rotation disabled', { err: error, path: logPath });
		}
	};
	check();
	if (!disabled) {
		timer = setInterval(check, intervalMs);
		timer.unref();
	}
	return { stop: disable };
}
