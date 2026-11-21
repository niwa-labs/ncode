/**
 * The control-root CAS locks (arch §4.6.2 п.4): `acquireFileLock` exclusive-
 * create semantics, live-holder refusal, STALE refusal (astra T1 п.3: dead
 * debris is never taken over in-process — `stat → unlink` is not a CAS), the
 * separate offline recovery, release-only-if-ours — and the integration
 * payoff: two daemons started concurrently against one root with stale
 * socket debris end with EXACTLY ONE live daemon, where the pre-lock
 * probe→bind race could leave two.
 *
 * Socket-dependent suites are skipped on Windows (no unix sockets); the pure
 * lock units still run there.
 *
 * @module
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveMcodedSocketPath } from '@mavis/config';

import {
	FileLockHeldError,
	FileLockStaleError,
	MCODED_LOCK_BASENAME,
	SPAWN_LOCK_BASENAME,
	acquireFileLock,
	acquireFileLockSelfHealing,
	isPidAlive,
	readLockHolderPid,
	recoverStaleFileLock,
} from '../src/daemon-lock.js';
import { McodedDaemon } from '../src/daemon.js';
import { connectClient, hello } from './helpers.js';

const tempRoots: string[] = [];

beforeEach(() => {
	tempRoots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcoded-lock-')));
});

afterAll(() => {
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// Socket-suite guard: the file mixes pure lock units and socket integration;
// Windows skips only the latter (no unix sockets).
const unixSockets = process.platform !== 'win32';
const describeSocket = unixSockets ? describe : describe.skip;

function freshRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcoded-lock-root-'));
	tempRoots.push(root);
	return root;
}

/** A pid that is guaranteed dead: one of a child that already exited. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
	const pid = child.pid;
	expect(pid).toBeGreaterThan(0);
	expect(isPidAlive(pid as number)).toBe(false);
	return pid as number;
}

/** Dead-holder debris at `lockPath`, the kill -9 shape. */
function writeDeadHolderDebris(lockPath: string): number {
	const dead = deadPid();
	fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, startedAtMs: 0 }));
	return dead;
}

describe('acquireFileLock (CAS semantics)', () => {
	it('creates a 0600 lock file recording the acquiring pid', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		const lock = acquireFileLock(lockPath);
		try {
			expect(lock.pid).toBe(process.pid);
			const stats = fs.statSync(lockPath);
			expect(stats.mode & 0o777).toBe(0o600);
			expect(readLockHolderPid(lockPath)).toBe(process.pid);
		} finally {
			lock.release();
		}
	});

	it('refuses a second acquirer while the first holds it', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		const first = acquireFileLock(lockPath);
		try {
			expect(() => acquireFileLock(lockPath)).toThrow(FileLockHeldError);
			try {
				acquireFileLock(lockPath);
			} catch (error) {
				expect((error as FileLockHeldError).code).toBe('LOCK_HELD');
				expect((error as FileLockHeldError).holderPid).toBe(process.pid);
			}
		} finally {
			first.release();
		}
	});

	// Astra T1 п.3: the old takeover was a `stat → unlink` pair behind an
	// inode check — not a CAS. Dead debris is now REFUSED and the removal is
	// the separate offline recovery below.
	it('REFUSES the lock of a dead holder (kill -9 debris) without touching it', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		const dead = writeDeadHolderDebris(lockPath);
		try {
			acquireFileLock(lockPath);
			expect.unreachable('dead-holder debris must be refused, not taken over');
		} catch (error) {
			expect(error).toBeInstanceOf(FileLockStaleError);
			expect((error as FileLockStaleError).code).toBe('LOCK_STALE');
			expect((error as FileLockStaleError).holderPid).toBe(dead);
		}
		// The refusal destroyed nothing: the debris is exactly as it was.
		expect(readLockHolderPid(lockPath)).toBe(dead);
	});

	it('REFUSES an unparsable lock file (torn pre-link debris)', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		fs.writeFileSync(lockPath, 'garbage from a torn write');
		try {
			acquireFileLock(lockPath);
			expect.unreachable('unparsable debris must be refused');
		} catch (error) {
			expect(error).toBeInstanceOf(FileLockStaleError);
			expect((error as FileLockStaleError).holderPid).toBeNull();
		}
		expect(fs.readFileSync(lockPath, 'utf8')).toBe('garbage from a torn write');
	});

	it('never steals a lock held by a live foreign holder', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		// This very process is the live "foreign" holder: takeover must refuse,
		// not unlink and recreate over a running owner.
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: 0 }));
		expect(() => acquireFileLock(lockPath)).toThrow(FileLockHeldError);
		// The refusal must not have destroyed the holder's record.
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
	});

	it('release is idempotent and only removes our own file', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		const lock = acquireFileLock(lockPath);
		lock.release();
		expect(fs.existsSync(lockPath)).toBe(false);
		expect(() => lock.release()).not.toThrow();

		// A release racing a takeover (the file now holds someone else's pid)
		// must leave the new holder's record alone.
		const dead = deadPid();
		const second = acquireFileLock(lockPath);
		fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, startedAtMs: 0 }));
		second.release();
		expect(readLockHolderPid(lockPath)).toBe(dead);
	});

	it('two contenders on STALE debris both refuse; after recovery exactly one wins', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		writeDeadHolderDebris(lockPath);
		// Both contenders see stale debris and refuse — deterministically,
		// because a refusal cannot change the world (the old takeover could:
		// the first unlink+link, the second unlink of the FRESH winner).
		const outcomes = [() => acquireFileLock(lockPath), () => acquireFileLock(lockPath)].map(
			(attempt) => {
				try {
					attempt();
					return { refused: false as const };
				} catch (error) {
					return { refused: true as const, error };
				}
			},
		);
		expect(outcomes).toHaveLength(2);
		for (const outcome of outcomes) {
			expect(outcome.refused).toBe(true);
			expect(outcome.refused ? outcome.error : undefined).toBeInstanceOf(FileLockStaleError);
		}
		expect(readLockHolderPid(lockPath)).not.toBe(process.pid);

		// The offline recovery clears the debris; the CAS then decides
		// between the two contenders exactly as designed.
		expect(recoverStaleFileLock(lockPath)).toBe(true);
		const retried = [() => acquireFileLock(lockPath), () => acquireFileLock(lockPath)].map(
			(attempt) => {
				try {
					return { won: true as const, lock: attempt() };
				} catch (error) {
					return { won: false as const, error };
				}
			},
		);
		expect(retried.filter((outcome) => outcome.won)).toHaveLength(1);
		expect(retried.find((outcome) => !outcome.won)?.error).toBeInstanceOf(FileLockHeldError);
		retried.find((outcome) => outcome.won)?.lock.release();
	});

	// Incident 2026-11-04 mechanics: the publish must be ATOMIC (the lock
	// path never exists without its pid) and no acquisition outcome may leave
	// debris behind. These units pin the quiet parts.
	it('leaves no acquisition temp debris behind (win, refusal, stale refusal)', () => {
		const root = freshRoot();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		const debris = () => fs.readdirSync(root).filter((name) => name.includes('.tmp-'));

		// Win → release.
		const lock = acquireFileLock(lockPath);
		expect(debris()).toEqual([]);
		lock.release();

		// Refusal against a live holder.
		const held = acquireFileLock(lockPath);
		expect(() => acquireFileLock(lockPath)).toThrow(FileLockHeldError);
		expect(debris()).toEqual([]);
		held.release();

		// Stale refusal, then offline recovery → a clean win.
		writeDeadHolderDebris(lockPath);
		expect(() => acquireFileLock(lockPath)).toThrow(FileLockStaleError);
		expect(debris()).toEqual([]);
		expect(recoverStaleFileLock(lockPath)).toBe(true);
		const taken = acquireFileLock(lockPath);
		expect(debris()).toEqual([]);
		taken.release();
		expect(fs.existsSync(lockPath)).toBe(false);
		expect(debris()).toEqual([]);
	});
});

describe('recoverStaleFileLock (the offline recovery, astra T1 п.3)', () => {
	it('removes dead-holder debris so the next acquire wins', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		writeDeadHolderDebris(lockPath);
		expect(recoverStaleFileLock(lockPath)).toBe(true);
		expect(fs.existsSync(lockPath)).toBe(false);
		const lock = acquireFileLock(lockPath);
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
		lock.release();
	});

	it('removes unparsable debris', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		fs.writeFileSync(lockPath, 'garbage from a torn write');
		expect(recoverStaleFileLock(lockPath)).toBe(true);
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('never touches a LIVE holder’s lock', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		const live = acquireFileLock(lockPath);
		try {
			expect(recoverStaleFileLock(lockPath)).toBe(false);
			expect(readLockHolderPid(lockPath)).toBe(process.pid);
			expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600);
		} finally {
			live.release();
		}
	});

	it('refuses when the path was re-placed by a fresh live winner (inode guard)', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		writeDeadHolderDebris(lockPath);
		// The debris is replaced by a fresh LIVE winner before the recovery
		// pins it: the recovery must hands off. Deterministic: the path is
		// re-placed (remove + publish ours) before the recovery call.
		fs.rmSync(lockPath, { force: true });
		const winner = acquireFileLock(lockPath);
		expect(recoverStaleFileLock(lockPath)).toBe(false);
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
		expect(fs.existsSync(lockPath)).toBe(true);
		winner.release();
	});

	it('removes debris of OUR pid only when it predates this process (incarnation, astra T1 п.5)', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		// A previous incarnation of a REUSED pid number: the pid is "alive"
		// (it is us), but the record was written before this process existed.
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: 0 }));
		// Acquisition sees a live pid (us) and refuses as held…
		expect(() => acquireFileLock(lockPath)).toThrow(FileLockHeldError);
		// …and the recovery recognizes the previous incarnation and clears it.
		expect(recoverStaleFileLock(lockPath)).toBe(true);
		const lock = acquireFileLock(lockPath);
		lock.release();

		// The CURRENT incarnation's own record (written now) is NOT debris.
		const current = acquireFileLock(lockPath);
		fs.rmSync(lockPath, { force: true });
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }));
		expect(recoverStaleFileLock(lockPath)).toBe(false);
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
		current.release();
	});
});

describe('acquireFileLockSelfHealing (the daemon-start self-heal, owner 2026-11-06)', () => {
	it('heals dead-holder debris and wins the freed path, naming the healed pid', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		const dead = writeDeadHolderDebris(lockPath);
		const outcome = acquireFileLockSelfHealing(lockPath);
		try {
			expect(outcome.healedHolderPid).toBe(dead);
			expect(outcome.lock.pid).toBe(process.pid);
			expect(readLockHolderPid(lockPath)).toBe(process.pid);
		} finally {
			outcome.lock.release();
		}
	});

	it('heals unparsable debris (healedHolderPid null)', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		fs.writeFileSync(lockPath, 'garbage from a torn write');
		const outcome = acquireFileLockSelfHealing(lockPath);
		try {
			expect(outcome.healedHolderPid).toBeNull();
			expect(readLockHolderPid(lockPath)).toBe(process.pid);
		} finally {
			outcome.lock.release();
		}
	});

	it('a clean acquisition reports no heal', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		const outcome = acquireFileLockSelfHealing(lockPath);
		try {
			expect(outcome.healedHolderPid).toBeUndefined();
		} finally {
			outcome.lock.release();
		}
	});

	it('a LIVE holder is never healed: FileLockHeldError, file untouched', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }));
		expect(() => acquireFileLockSelfHealing(lockPath)).toThrow(FileLockHeldError);
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
		expect(() => acquireFileLockSelfHealing(lockPath)).toThrow(FileLockHeldError);
	});

	it('rethrows the original stale refusal when the recovery hands off', () => {
		const lockPath = path.join(freshRoot(), MCODED_LOCK_BASENAME);
		// A path the CAS reads as stale but the recovery cannot pin or remove:
		// a DIRECTORY (readFileSync hands off on every platform). The ORIGINAL
		// stale refusal surfaces — fail-closed, nothing was guessed, nothing
		// was stripped.
		fs.mkdirSync(lockPath);
		expect(() => acquireFileLockSelfHealing(lockPath)).toThrow(FileLockStaleError);
		expect(fs.existsSync(lockPath)).toBe(true);
	});
});

describe('spawn.lock (client auto-spawn serialization, §4.6.2 п.2)', () => {
	// The W3 McodedClient consumes this under its contract name; the wave-2
	// deliverable is the serialization primitive itself: two contending
	// spawners on one control root, exactly one enters the spawn critical
	// section, and the lock frees for the next spawn.
	it('serializes two contending spawners under spawn.lock and frees after release', () => {
		const root = freshRoot();
		const spawnLockPath = path.join(root, SPAWN_LOCK_BASENAME);
		const first = acquireFileLock(spawnLockPath);
		try {
			expect(() => acquireFileLock(spawnLockPath)).toThrow(FileLockHeldError);
			// Distinct contract name from the daemon's own lock: both may coexist
			// in one control root.
			const daemonLock = acquireFileLock(path.join(root, MCODED_LOCK_BASENAME));
			daemonLock.release();
		} finally {
			first.release();
		}
		// The freed spawn.lock admits the next spawner immediately.
		const second = acquireFileLock(spawnLockPath);
		second.release();
		expect(fs.existsSync(spawnLockPath)).toBe(false);
	});

	it('a crashed spawner leaves a STALE spawn.lock: refused, then recovered offline', () => {
		const root = freshRoot();
		const spawnLockPath = path.join(root, SPAWN_LOCK_BASENAME);
		const dead = deadPid();
		fs.writeFileSync(spawnLockPath, JSON.stringify({ pid: dead, startedAtMs: 0 }));
		// The auto-spawn path refuses on the stale lock (fail-closed; the
		// caller surfaces FileLockStaleError)…
		expect(() => acquireFileLock(spawnLockPath)).toThrow(FileLockStaleError);
		// …the offline recovery restores the root.
		expect(recoverStaleFileLock(spawnLockPath)).toBe(true);
		const lock = acquireFileLock(spawnLockPath);
		expect(readLockHolderPid(spawnLockPath)).toBe(process.pid);
		lock.release();
	});
});

describe('isPidAlive', () => {
	it('answers for this process and for a dead pid', () => {
		expect(isPidAlive(process.pid)).toBe(true);
		expect(isPidAlive(deadPid())).toBe(false);
	});
});

describeSocket('two concurrent daemon starts (the §4.6.2 п.4 race)', () => {
	it('ends with exactly one live daemon when both start against stale debris', async () => {
		const root = freshRoot();
		const socketPath = resolveMcodedSocketPath(root);
		// The debris that made the old probe→bind window dangerous: both starts
		// would probe it, both would see "nobody answers", and the second
		// unlink would tear down the first's fresh socket.
		fs.writeFileSync(socketPath, 'stale debris');

		const first = new McodedDaemon({ root, listenFd: null });
		const second = new McodedDaemon({ root, listenFd: null });
		const [firstResult, secondResult] = await Promise.allSettled([
			first.start(),
			second.start(),
		]);

		const winner = firstResult.status === 'fulfilled' ? first : second;
		const loser = firstResult.status === 'fulfilled' ? second : first;
		const loserResult = winner === first ? secondResult : firstResult;
		expect(loserResult.status).toBe('rejected');
		const loserError = loserResult.status === 'rejected' ? loserResult.reason : undefined;
		expect((loserError as { code?: string }).code).toBe('daemon-alive');
		expect(winner.isListening).toBe(true);
		expect(loser.isListening).toBe(false);

		// The winner actually serves the wire over the recovered socket.
		const client = await connectClient(socketPath);
		expect((await hello(client)).success).toBe(true);
		client.close();

		// The lock dies with the daemon: the file is gone after shutdown.
		await winner.shutdown();
		expect(fs.existsSync(path.join(root, MCODED_LOCK_BASENAME))).toBe(false);
	});

	it('holds mcoded.lock for the daemon life and refuses a second start with it', async () => {
		const root = freshRoot();
		const daemon = new McodedDaemon({ root, listenFd: null });
		await daemon.start();
		expect(fs.existsSync(path.join(root, MCODED_LOCK_BASENAME))).toBe(true);

		const second = new McodedDaemon({ root, listenFd: null });
		await expect(second.start()).rejects.toMatchObject({
			name: 'McodedDaemonError',
			code: 'daemon-alive',
		});

		await daemon.shutdown();
		// After a graceful stop the root is startable again (lock released).
		const third = new McodedDaemon({ root, listenFd: null });
		await third.start();
		const client = await connectClient(third.socketPath);
		expect((await hello(client)).success).toBe(true);
		client.close();
		await third.shutdown();
	});

	// Owner requirement 2026-11-06 (self-heal after a crash): the daemon start
	// no longer strands on a dead predecessor's debris — it recovers the
	// provably-stale lock itself and starts. The astra T1 п.3 refusal stays
	// at the CAS layer (acquireFileLock), the heal is the start policy above
	// it; the LIVE-holder refusal below keeps the incident channel closed.
	it('a daemon start against dead-holder lock debris SELF-HEALS and starts (owner 2026-11-06)', async () => {
		const root = freshRoot();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		writeDeadHolderDebris(lockPath);
		const daemon = new McodedDaemon({ root, listenFd: null });
		await daemon.start();
		// The debris is gone and THIS daemon owns the root now.
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
		const client = await connectClient(daemon.socketPath);
		expect((await hello(client)).success).toBe(true);
		client.close();
		await daemon.shutdown();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('a daemon start against a LIVE foreign holder still refuses (daemon-alive, spawn-race protection)', async () => {
		const root = freshRoot();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		// THIS process is the live foreign holder: the start must refuse
		// without touching the holder's file (the incident-2026-11-04 shape —
		// a live winner stripped by a contender's "recovery" — stays closed).
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }));
		const daemon = new McodedDaemon({ root, listenFd: null });
		await expect(daemon.start()).rejects.toMatchObject({
			name: 'McodedDaemonError',
			code: 'daemon-alive',
		});
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
	});

	it('an in-process crash seam releases the lock; the root restarts cleanly', async () => {
		const root = freshRoot();
		const crashed = new McodedDaemon({ root, listenFd: null });
		await crashed.start();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
		// In-process crash seam: releases the lock cooperatively (see
		// daemon.ts). A REAL kill -9 leaves the file behind — that shape is
		// pinned by the stale-refusal units above: the next start REFUSES
		// until the offline recovery runs.
		await crashed.crash();
		expect(fs.existsSync(lockPath)).toBe(false);

		const next = new McodedDaemon({ root, listenFd: null });
		await next.start();
		await next.shutdown();
	});

	// Astra T1 п.1: a daemon constructed with a PRE-ACQUIRED lock (the
	// product composition) never releases it itself — the composition owns
	// the release and must run it after its final control-plane writes.
	it('shutdown of a pre-acquired-lock daemon does NOT release the composition’s lock', async () => {
		const root = freshRoot();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		const lock = acquireFileLock(lockPath);
		const daemon = new McodedDaemon({ root, listenFd: null, lock });
		await daemon.start();
		await daemon.shutdown();
		// Teardown done (socket gone) but ownership is still OURS…
		expect(fs.existsSync(resolveMcodedSocketPath(root))).toBe(false);
		expect(fs.existsSync(lockPath)).toBe(true);
		expect(readLockHolderPid(lockPath)).toBe(process.pid);
		// …until the composition's explicit handoff.
		daemon.releaseLock();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('a FAILED start with a pre-acquired lock leaves the release to the composition', async () => {
		const root = freshRoot();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		// Make the bind fail deterministically: a live listener already owns
		// the socket path, so listenFresh refuses with daemon-alive.
		const blocker = net.createServer();
		await new Promise<void>((resolve) => blocker.listen(resolveMcodedSocketPath(root), resolve));
		const lock = acquireFileLock(lockPath);
		const daemon = new McodedDaemon({ root, listenFd: null, lock });
		await expect(daemon.start()).rejects.toMatchObject({
			name: 'McodedDaemonError',
			code: 'daemon-alive',
		});
		// The adopted lock was NOT auto-released on the failed start: the
		// composition finalizes its own failure state first (product-daemon's
		// catch), then releases.
		expect(fs.existsSync(lockPath)).toBe(true);
		lock.release();
		expect(fs.existsSync(lockPath)).toBe(false);
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
	});
});

// ---------------------------------------------------------------------------
// Incident 2026-11-04: two competing auto-spawns split the CAS and BOTH
// believed they held mcoded.lock; the loser's daemon overwrote the live
// winner's mcoded.token and management of the winner was lost (UNAUTHORIZED,
// "handshake token missing or invalid", even --force refused).
//
// The mechanism was in acquireFileLock: the old publisher created the lock
// path EMPTY (openSync 'wx') and wrote the pid a beat later — a contender
// reading inside that window saw "unparsable", classified the LIVE winner as
// crash debris, unlinked it and took its own lock. A second, related window:
// the stale takeover's stat → unlink pair, which two reclaimers could
// interleave into removing a fresh winner's file. Both windows require true
// cross-process interleaving, so the regressions run real node children
// (distinct pids, the real module, no mocks):
// - the hammer below loops acquire → verify the file still names THIS pid →
//   release; on the old publisher it reports dozens of steals per child
//   within ~100 ms, the atomic link-publish + stale refusal reports zero;
// - the stale-contention pair pins the astra T1 п.3 outcome DETERMINISTICALLY:
//   against dead debris both children refuse (a refusal cannot change the
//   world, so no interleaving exists that could strip a winner), and after
//   the offline recovery exactly one of two contenders wins the freed path.
// ---------------------------------------------------------------------------
describe('cross-process CAS contention (incident 2026-11-04)', () => {
	/** Run `script` in a real child process against the real daemon-lock module. */
	function runChild(script: string, env: Record<string, string>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				['--experimental-strip-types', '--input-type=module', '--no-warnings', '-e', script],
				{ env: { ...process.env, ...env } },
			);
			let stdout = '';
			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf8');
			});
			child.stderr.on('data', () => undefined); // experimental-flag noise
			child.on('error', reject);
			child.on('close', (code) => {
				if (code !== 0) {
					reject(new Error(`child exited ${code}`));
					return;
				}
				try {
					resolve(JSON.parse(stdout.trim().split('\n').at(-1) as string));
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});
	}

	const MODULE_URL = new URL('../src/daemon-lock.ts', import.meta.url).href;

	/**
	 * A child whose stdout is consumed line-by-line (JSON per line): lets the
	 * test synchronize on intermediate states (a winner holding through a
	 * gate) instead of only the final aggregate.
	 */
	function runLinesChild(script: string, env: Record<string, string>) {
		const lines: Array<Promise<{ pid: number; outcome: string; kept?: boolean }>> = [];
		let resolveLine!: (line: { pid: number; outcome: string; kept?: boolean }) => void;
		lines.push(new Promise((resolve) => { resolveLine = resolve; }));
		let settled = false;
		const child = spawn(
			process.execPath,
			['--experimental-strip-types', '--input-type=module', '--no-warnings', '-e', script],
			{ env: { ...process.env, ...env } },
		);
		let buffer = '';
		const donePromise = new Promise<void>((resolveDone, rejectDone) => {
			child.on('error', rejectDone);
			child.on('close', (code) => {
				if (code !== 0) rejectDone(new Error(`child exited ${code}`));
				else resolveDone();
			});
		});
		child.stderr.on('data', () => undefined); // experimental-flag noise
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			let index: number;
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line === '' || settled) continue;
				settled = true;
				resolveLine(JSON.parse(line));
				// Arm the promise for the NEXT line (a child may emit more).
				settled = false;
				lines.push(
					new Promise((resolve) => {
						resolveLine = resolve;
					}),
				);
			}
		});
		return {
			nextLine: () => {
				const pending = lines.shift();
				if (pending) return pending;
				throw new Error('child produced no further lines');
			},
			done: () => donePromise,
		};
	}

	it.concurrent('two children against STALE debris both refuse; nothing is removed', async () => {
		const root = freshRoot();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		const dead = deadPid();
		fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, startedAtMs: 0 }));

		const CHILD = `
const mod = await import(process.env.MCODE_LOCK_MODULE);
try {
	const lock = mod.acquireFileLock(process.env.MCODE_LOCK_PATH);
	lock.release();
	console.log(JSON.stringify({ pid: process.pid, outcome: 'won' }));
} catch (error) {
	console.log(JSON.stringify({ pid: process.pid, outcome: error && error.code ? error.code : 'error' }));
}
`;
		const results = (await Promise.all([
			runChild(CHILD, { MCODE_LOCK_MODULE: MODULE_URL, MCODE_LOCK_PATH: lockPath }),
			runChild(CHILD, { MCODE_LOCK_MODULE: MODULE_URL, MCODE_LOCK_PATH: lockPath }),
		])) as Array<{ pid: number; outcome: string }>;

		// Deterministic outcome class: BOTH refuse stale — no child can remove
		// the debris, so no interleaving of the two can damage anyone.
		expect(results).toHaveLength(2);
		for (const result of results) expect(result.outcome).toBe('LOCK_STALE');
		expect(readLockHolderPid(lockPath)).toBe(dead);
		expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
	}, 30_000);

	it.concurrent('after offline recovery, two children contend and exactly one wins', async () => {
		const root = freshRoot();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		const dead = deadPid();
		fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, startedAtMs: 0 }));
		expect(recoverStaleFileLock(lockPath)).toBe(true);

		// Deterministic barrier: the winner HOLDS until the parent lifts the
		// gate, so the loser's refusal is guaranteed LOCK_HELD against a held
		// lock — not a race against the winner's release. Each child prints
		// its attempt outcome first, and the winner a final line after the
		// gated release.
		const gate = path.join(root, 'release-gate');
		const CHILD = `
const fs = await import('node:fs');
const mod = await import(process.env.MCODE_LOCK_MODULE);
const gate = process.env.MCODE_LOCK_GATE;
try {
	const lock = mod.acquireFileLock(process.env.MCODE_LOCK_PATH);
	console.log(JSON.stringify({ pid: process.pid, outcome: 'won' }));
	while (!fs.existsSync(gate)) await new Promise((r) => setTimeout(r, 10));
	// The held lock must still name THIS pid when the gate lifts: anything
	// else means the loser stripped our critical section.
	const kept = mod.readLockHolderPid(process.env.MCODE_LOCK_PATH) === process.pid;
	lock.release();
	console.log(JSON.stringify({ pid: process.pid, outcome: 'released', kept }));
} catch (error) {
	console.log(JSON.stringify({ pid: process.pid, outcome: error && error.code ? error.code : 'error' }));
}
`;
		const childEnv = { MCODE_LOCK_MODULE: MODULE_URL, MCODE_LOCK_PATH: lockPath, MCODE_LOCK_GATE: gate };
		const first = runLinesChild(CHILD, childEnv);
		const second = runLinesChild(CHILD, childEnv);
		// Both first lines arrive while the winner still holds the lock.
		const [firstAttempt, secondAttempt] = await Promise.all([first.nextLine(), second.nextLine()]);
		const attempts = [firstAttempt, secondAttempt];
		expect(attempts.filter((line) => line.outcome === 'won')).toHaveLength(1);
		expect(attempts.filter((line) => line.outcome === 'LOCK_HELD')).toHaveLength(1);

		// Lift the gate and collect the winner's final line.
		fs.writeFileSync(gate, 'go');
		const winner = firstAttempt.outcome === 'won' ? first : second;
		const final = await winner.nextLine();
		expect(final.outcome).toBe('released');
		expect(final.kept).toBe(true);
		await Promise.all([first.done(), second.done()]);
		expect(fs.existsSync(lockPath)).toBe(false);
		expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
	}, 30_000);

	/** The child side of the hammer, run by real parallel node processes. */
	const HAMMER_CHILD = `
const lockPath = process.env.MCODE_HAMMER_LOCK;
const rounds = Number(process.env.MCODE_HAMMER_ROUNDS);
const mod = await import(process.env.MCODE_HAMMER_MODULE);
let held = 0;
let refused = 0;
let stolen = 0;
for (let i = 0; i < rounds; i += 1) {
	let lock;
	try {
		lock = mod.acquireFileLock(lockPath);
		held += 1;
	} catch (error) {
		if (error && (error.code === 'LOCK_HELD' || error.code === 'LOCK_STALE')) {
			// LOCK_HELD: a sibling holds it. LOCK_STALE: the holder released
			// between our EEXIST and our read — the fail-closed transient;
			// retrying is the contract. Neither may change the world.
			refused += 1;
			continue;
		}
		throw error;
	}
	// The just-acquired lock must still name THIS pid: anything else means a
	// sibling stole our critical section (the incident's two-holders state).
	if (mod.readLockHolderPid(lockPath) !== process.pid) stolen += 1;
	lock.release();
}
console.log(JSON.stringify({ pid: process.pid, held, refused, stolen }));
`;

	it.concurrent('never steals a live holder under multi-process contention', async () => {
		const root = freshRoot();
		const lockPath = path.join(root, MCODED_LOCK_BASENAME);
		const children = 6;
		const rounds = 600;

		const results = await Promise.all(
			Array.from({ length: children }, () =>
				new Promise<{ pid: number; held: number; refused: number; stolen: number }>(
					(resolve, reject) => {
						const child = spawn(
							process.execPath,
							['--experimental-strip-types', '--input-type=module', '--no-warnings', '-e', HAMMER_CHILD],
							{
								env: {
									...process.env,
									MCODE_HAMMER_LOCK: lockPath,
									MCODE_HAMMER_ROUNDS: String(rounds),
									// The REAL module (types stripped by the flag), by absolute URL.
									MCODE_HAMMER_MODULE: new URL('../src/daemon-lock.ts', import.meta.url).href,
								},
							},
						);
						let stdout = '';
						child.stdout.on('data', (chunk: Buffer) => {
							stdout += chunk.toString('utf8');
						});
						child.stderr.on('data', () => undefined); // experimental-flag noise
						child.on('error', reject);
						child.on('close', (code) => {
							if (code !== 0) {
								reject(new Error(`hammer child exited ${code}`));
								return;
							}
							try {
								resolve(JSON.parse(stdout.trim().split('\n').at(-1) as string));
							} catch (error) {
								reject(error instanceof Error ? error : new Error(String(error)));
							}
						});
					},
				),
			),
		);

		// Contention actually happened (acquisitions and refusals were real)…
		expect(results.reduce((sum, r) => sum + r.held, 0)).toBeGreaterThan(0);
		expect(results.reduce((sum, r) => sum + r.refused, 0)).toBeGreaterThan(0);
		// …but no child ever lost a just-acquired lock to a sibling, and no
		// acquisition debris (temp files) or leftover lock remains.
		for (const r of results) expect(r.stolen, `pid ${r.pid}`).toBe(0);
		expect(fs.existsSync(lockPath)).toBe(false);
		expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
	}, 30_000);
});
