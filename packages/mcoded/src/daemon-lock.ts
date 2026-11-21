/**
 * The compare-and-swap file locks of the control root (arch §2.2, §4.6.2 п.4):
 *
 * - `mcoded.lock` — held by the live daemon for its whole life. A second
 *   daemon on the same control root refuses with `daemon-alive` BEFORE it
 *   probes or touches the socket, which closes the probe→bind race of the
 *   stale-socket recovery: two concurrent starts could both see "nobody
 *   answers", and the second `unlinkSync` would tear down the fresh socket
 *   of the first — two live daemons, one unreachable by path.
 * - `spawn.lock` — serializes client-side auto-spawn. No client ships in
 *   this wave (W3 owns `McodedClient`); the helper is exported under its
 *   contract name so the daemon lock and the future spawn lock share one
 *   implementation.
 *
 * CAS semantics: acquisition publishes a fully-written record atomically —
 * the `{pid, startedAtMs}` JSON is written at a private temp path and
 * hard-linked into place (`linkSync`), so the lock path never exists without
 * its pid and exactly one of N concurrent contenders wins, with no native
 * flock dependency. (The incident of 2026-11-04: the old `openSync(path,
 * 'wx')` created the path EMPTY first and wrote the pid a beat later; a
 * contender reading in that window saw an unparsable file, classified the
 * LIVE winner's lock as crash debris, unlinked it and took its own — two
 * holders, and the loser's daemon then overwrote the winner's `mcoded.token`
 * with its own, leaving the live daemon unmanageable. The publish is now
 * atomic; the empty-file state can no longer be produced.)
 *
 * Stale debris (a dead holder's file left by a crash) is NOT taken over
 * in-process (astra T1 п.3, 2026-11-04): the old takeover unlinked by path
 * behind an inode check, and a `stat → unlink` pair is not a CAS — two
 * reclaimers can both pass the check, the first removes the debris and
 * links its own record, and the second removes the FRESH winner's file. No
 * userland primitive conditions an unlink on an inode, so a provably safe
 * automatic reclaim does not exist without an OS lock, which this module
 * deliberately does not depend on. `acquireFileLock` therefore REFUSES on
 * stale/unclear ownership (`FileLockStaleError`) and the removal is a
 * separate, explicit offline step ({@link recoverStaleFileLock}). The named
 * cost of that verdict — auto-recovery after a `kill -9` crash is lost, the
 * next start refuses until the recovery runs — was lifted on 2026-11-06 at
 * the layer where it hurts, without reopening the incident channel: the
 * daemon START paths self-heal through {@link acquireFileLockSelfHealing}
 * (recover-once-and-retry, still fail-closed against a live holder), while
 * the bare {@link acquireFileLock} keeps the pure refusal semantics below.
 *
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '@mavis/logging';

/** Control-root file the live daemon holds for its whole life. */
export const MCODED_LOCK_BASENAME = 'mcoded.lock';

/** Control-root file serializing client-side auto-spawn (client lands in W3). */
export const SPAWN_LOCK_BASENAME = 'spawn.lock';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/** On-disk record of the lock holder. */
export interface FileLockContents {
	readonly pid: number;
	readonly startedAtMs: number;
}

/**
 * When THIS process came into being for the module's purposes (module load;
 * conservative — anything the process did before the module loaded counts as
 * "this incarnation"). Keyed into {@link recoverStaleFileLock} to recognize
 * debris of a PREVIOUS incarnation of our own pid: `startedAtMs` predating
 * this timestamp means the record was written by a dead process that merely
 * reused our pid number (astra T1 п.5: pid equality alone cannot distinguish
 * incarnations).
 */
const PROCESS_INCARNATION_START_MS = Date.now();

/** A held lock; `release()` is idempotent and only ever removes our own file. */
export interface FileLock {
	readonly path: string;
	/** The pid recorded in the file — always the acquiring process. */
	readonly pid: number;
	/** Remove the lock file; a no-op when the file is gone or was replaced. */
	release(): void;
}

/** Thrown when a live process other than the caller holds the lock. */
export class FileLockHeldError extends Error {
	readonly code = 'LOCK_HELD';
	readonly path: string;
	readonly holderPid: number;

	constructor(path: string, holderPid: number) {
		super(
			`lock ${path} is held by live pid ${holderPid}` +
				(holderPid === process.pid ? ' (this process)' : ''),
		);
		this.name = 'FileLockHeldError';
		this.path = path;
		this.holderPid = holderPid;
	}
}

/**
 * Thrown when the lock path holds debris the caller may NOT act on: a dead
 * holder's file (crash leftovers) or an unparsable record. Refused, not
 * taken over — see the module doc (astra T1 п.3): the removal is a separate
 * explicit step ({@link recoverStaleFileLock}), so a contender can never
 * strip a fresh winner's file through a `stat → unlink` window.
 */
export class FileLockStaleError extends Error {
	readonly code = 'LOCK_STALE';
	readonly path: string;
	/** The dead holder's pid, or `null` when the record was unparsable. */
	readonly holderPid: number | null;

	constructor(path: string, holderPid: number | null) {
		super(
			`lock ${path} is stale (dead or unparsable holder` +
				(holderPid === null ? '' : ` pid ${holderPid}`) +
				`); refusing to take it over in-process — run stale-lock recovery ` +
				`(recoverStaleFileLock) or remove the file manually`,
		);
		this.name = 'FileLockStaleError';
		this.path = path;
		this.holderPid = holderPid;
	}
}

/** Read the pid recorded in a lock file, or `undefined` when absent/unparsable. */
export function readLockHolderPid(lockPath: string): number | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(lockPath, 'utf8');
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { pid?: unknown };
		return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether `pid` names a live process. `EPERM` from `kill(pid, 0)` means the
 * process exists but belongs to another user — still alive, still a refusal.
 */
export function isPidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Acquire `lockPath` via an atomic exclusive publish (the CAS).
 *
 * - Free path → the fully-written record (`0600`) appears at `lockPath`
 *   through `linkSync` — one indivisible step; the lock is held.
 * - Path held by a LIVE pid (foreign or our own — a second holder in one
 *   process is a bug, never silently stolen) → {@link FileLockHeldError}.
 * - Path held by a DEAD pid, or an unparsable file (kill -9 debris) →
 *   {@link FileLockStaleError}: REFUSED, never taken over in-process. The
 *   `stat → unlink` of the old takeover was not a CAS (two reclaimers could
 *   both pass the inode check and the second would remove the first's fresh
 *   winner — astra T1 п.3), and no userland primitive can condition an
 *   unlink on an inode, so stale ownership is resolved by the explicit
 *   offline {@link recoverStaleFileLock} instead. This loses automatic
 *   recovery after a crash (a named limitation), and gains the impossibility
 *   of ever stripping a live winner.
 *
 * The record is written at `<lockPath>.tmp-<pid>` first so the lock path
 * itself is never observable without parsable contents: a contender that
 * loses the `linkSync` race always reads a REAL pid (live → refuse), never
 * the empty mid-create file that made stale-recovery steal live locks
 * (incident 2026-11-04). The temp name dies in the `finally`; only a kill -9
 * inside these few statements can leave it behind, and nothing reads it.
 *
 * A refused contender also never WRITES the lock path: the refusal touches
 * nothing but the private temp, so a loser cannot damage the holder's
 * control plane. The transient "EEXIST → the holder released before our
 * read" case reads as stale and refuses too — fail-closed; a retry wins the
 * freed path.
 */
export function acquireFileLock(
	lockPath: string,
	options: { nowMs?: () => number } = {},
): FileLock {
	const nowMs = options.nowMs ?? Date.now;
	// W5 live-check fix: the control root may not exist yet on a fresh data
	// dir (the very first client races `ensureControlRootLayout` with its own
	// spawn lock) — create it with the daemon's 0700 contract instead of
	// dying ENOENT on the lock open.
	fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	const tempPath = `${lockPath}.tmp-${process.pid}`;
	const contents: FileLockContents = { pid: process.pid, startedAtMs: nowMs() };
	try {
		// Private, fully-written record → one atomic step into place. On
		// win32 a taken target reports EPERM instead of EEXIST (Node's
		// link(2) mapping); both mean "someone owns the path".
		fs.writeFileSync(tempPath, JSON.stringify(contents), { mode: 0o600 });
		fs.linkSync(tempPath, lockPath);
		return {
			path: lockPath,
			pid: process.pid,
			release: () => releaseFileLock(lockPath, process.pid),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const pathTaken = code === 'EEXIST' || (code === 'EPERM' && process.platform === 'win32');
		if (!pathTaken) throw error;
		const holder = readLockHolderPid(lockPath);
		if (holder !== undefined && isPidAlive(holder)) {
			throw new FileLockHeldError(lockPath, holder);
		}
		// Dead or unparsable holder — refuse (see the module doc): the
		// removal belongs to the explicit offline recovery, never to a
		// contender racing other contenders.
		throw new FileLockStaleError(lockPath, holder ?? null);
	} finally {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// Already gone (or never written) — nothing to clean.
		}
	}
}

/**
 * Acquisition with the daemon-start self-heal (owner requirement 2026-11-06,
 * successor of the "next start refuses" cost named in astra T1 п.3): when the
 * CAS refuses on PROVABLY dead debris ({@link FileLockStaleError} — the pid
 * inside the file is gone, or the record is unparsable), the inode-guarded
 * {@link recoverStaleFileLock} runs ONCE and the acquisition is retried, so
 * `daemon run` repairs a crashed predecessor's leftover instead of stranding
 * the root until an operator remembers the manual step.
 *
 * Why this does not reopen the incident-2026-11-04 channel (a contender
 * stripping a LIVE winner):
 * - A live holder — foreign or a reused pid of ours — refuses with
 *   {@link FileLockHeldError} BEFORE any recovery runs, and the atomic
 *   link-publish guarantees a live winner's record is always parsable, so a
 *   live lock can never be classified as debris.
 * - Between concurrent starters the recovery's inode guard makes every
 *   non-winner hands off: only the exact pinned debris can be unlinked; a
 *   fresh winner's file fails the inode check and the retry then refuses on
 *   the winner's live pid.
 * - When the recovery itself hands off (the debris was replaced or removed in
 *   the meantime), the ORIGINAL refusal is rethrown — fail-closed, nothing
 *   was guessed.
 *
 * The bare {@link acquireFileLock} keeps its refusal semantics unchanged;
 * the heal is a policy of the daemon START paths, not of the CAS itself.
 *
 * Returns the acquired lock plus `healedHolderPid` — the dead/parsable-fail
 * pid recorded in the removed debris, or `null` for unparsable debris;
 * `undefined` when no heal happened (a clean first-acquisition win).
 */
export function acquireFileLockSelfHealing(lockPath: string): {
	lock: FileLock;
	healedHolderPid: number | null | undefined;
} {
	let lock: FileLock;
	try {
		lock = acquireFileLock(lockPath);
		return { lock, healedHolderPid: undefined };
	} catch (error) {
		if (!(error instanceof FileLockStaleError)) throw error;
		const holderPid = error.holderPid;
		if (!recoverStaleFileLock(lockPath)) throw error;
		log.warn('stale-lock-self-healed', { lockPath, holderPid });
		lock = acquireFileLock(lockPath);
		return { lock, healedHolderPid: holderPid };
	}
}

/**
 * Release `lockPath` only when it still holds `pid` (read-compare-unlink):
 * a release racing a takeover never removes the NEW holder's file. Idempotent.
 *
 * The pid-only comparison is sound for a LIVE caller (a live pid is unique —
 * no other live process can publish a record with our pid), which is the
 * only process allowed to call this: `release` travels with the acquiring
 * call. Pid-REUSE across incarnations cannot forge it, because the dead
 * incarnation's `release` is gone with the process. The incarnation stamp
 * (`startedAtMs`) matters only for classifying debris — see
 * {@link recoverStaleFileLock}.
 */
export function releaseFileLock(lockPath: string, pid: number): void {
	if (readLockHolderPid(lockPath) !== pid) return;
	try {
		fs.unlinkSync(lockPath);
	} catch {
		// Already gone (crash recovery raced us) — the release is done.
	}
}

/**
 * The OFFLINE stale-lock recovery (astra T1 п.3): remove a diagnosed-stale
 * lock file so the next `acquireFileLock` can win the freed path. This is
 * the explicit, separate successor of the old in-process takeover — an
 * operator-run step for a root whose holder died, NOT part of acquisition.
 *
 * Contract and honest limitations:
 * - A file whose pinned record names a LIVE foreign pid is never touched
 *   (the recovery refuses, `false`).
 * - A record naming OUR pid counts as debris only when its `startedAtMs`
 *   predates this process ({@link PROCESS_INCARNATION_START_MS}) — a
 *   previous incarnation of a reused pid number. The current incarnation's
 *   own lock is refused: the recovery never releases a lock this process
 *   may genuinely hold.
 * - Unparsable debris (a torn write of a pre-link publisher) is removable.
 * - The removal is still `stat`-guarded by inode identity (defense in
 *   depth: the path is unlinked only while it still names the pinned
 *   debris), but — exactly as the verdict states — a `stat → unlink` pair
 *   is not a CAS: TWO CONCURRENT RECOVERY INVOCATIONS can in principle
 *   interleave. Recovery is therefore an offline, single-operator action
 *   against a quiet root (no live contenders by construction); run one at
 *   a time. The in-process paths (acquire/release) never call this.
 *
 * Returns whether the stale file was removed.
 */
export function recoverStaleFileLock(lockPath: string): boolean {
	let fd: number;
	try {
		fd = fs.openSync(lockPath, 'r');
	} catch {
		// Gone before we could pin it — nothing to recover.
		return false;
	}
	try {
		const pinned = fs.fstatSync(fd);
		let raw: string;
		try {
			raw = fs.readFileSync(fd, 'utf8');
		} catch {
			return false;
		}
		let holderPid: number | null = null;
		let holderStartedAtMs: number | undefined;
		try {
			const parsed = JSON.parse(raw) as { pid?: unknown; startedAtMs?: unknown };
			if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
				holderPid = parsed.pid;
				if (typeof parsed.startedAtMs === 'number') holderStartedAtMs = parsed.startedAtMs;
			}
		} catch {
			// Unparsable debris (a torn write of a pre-link publisher) — stale.
		}
		if (holderPid !== null) {
			if (holderPid === process.pid) {
				// Our own pid: debris only when the record predates THIS
				// process (a previous incarnation of a reused pid number).
				// Without the incarnation stamp a pid collision would wedge
				// the root forever (the "live" holder is us).
				if (
					holderStartedAtMs === undefined ||
					holderStartedAtMs >= PROCESS_INCARNATION_START_MS
				) {
					return false;
				}
			} else if (isPidAlive(holderPid)) {
				// The pinned file's holder is alive after all — hands off.
				return false;
			}
		}
		const current = fs.statSync(lockPath, { throwIfNoEntry: false });
		if (
			current === undefined ||
			current.ino !== pinned.ino ||
			current.dev !== pinned.dev
		) {
			// Replaced (or removed) while we held the debris open — hands off.
			return false;
		}
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// Another recoverer removed it between the guard and here — same
			// decision: hands off.
			return false;
		}
		log.warn('stale-lock-recovered', { lockPath, holderPid });
		return true;
	} finally {
		fs.closeSync(fd);
	}
}
