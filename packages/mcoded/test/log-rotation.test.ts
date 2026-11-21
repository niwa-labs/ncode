/**
 * mcoded.log rotation (design 15, ДИЗАЙН 2): the М2 copytruncate on the
 * shared O_APPEND fd, the М3 spawn-time rename, the env knobs, and the
 * guards (spawner declaration, inode identity, fail-open).
 *
 * Everything runs against a real temp directory and real descriptors opened
 * `'a'` — fd 2 of the test runner is never touched; fds and clocks are
 * injected. The last case is the design's LIGHT integration: a child `node`
 * spawned exactly in the spawner's shape (`stdio: ['ignore', fd, fd]` plus
 * `MCODED_LOG_FILE`) running the real `startLogRotation` under a live
 * writer — no full daemon (it would add runtime, auth and a socket while
 * testing nothing extra about rotation).
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
	DEFAULT_MCODED_LOG_KEEP,
	DEFAULT_MCODED_LOG_MAX_BYTES,
	MCODED_LOG_KEEP_ENV,
	MCODED_LOG_MAX_BYTES_ENV,
	copyTruncate,
	readLogRotationEnv,
	rotateBeforeSpawn,
	startLogRotation,
} from '../src/log-rotation.js';
import type { Logger } from '@mavis/logging';

const tempRoots: string[] = [];
afterAll(() => {
	for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

/** Capturing logger stub: rotation must talk, but never throw. */
function testLog(): { log: Logger; warnings: string[]; debugs: string[] } {
	const warnings: string[] = [];
	const debugs: string[] = [];
	const logger: Logger = {
		trace: () => undefined,
		debug: (msg: string) => void debugs.push(msg),
		info: () => undefined,
		warn: (msg: string) => void warnings.push(msg),
		error: () => undefined,
		child: () => logger,
		enabled: () => false,
	};
	return { log: logger, warnings, debugs };
}

describe('readLogRotationEnv', () => {
	it('defaults to N=20 MiB / K=3; 0 is the explicit opt-out; invalid values keep defaults and warn once each', () => {
		const { log, warnings } = testLog();
		expect(readLogRotationEnv({}, log)).toEqual({
			maxBytes: DEFAULT_MCODED_LOG_MAX_BYTES,
			keep: DEFAULT_MCODED_LOG_KEEP,
		});
		expect(DEFAULT_MCODED_LOG_MAX_BYTES).toBe(20 * 1024 * 1024);
		expect(DEFAULT_MCODED_LOG_KEEP).toBe(3);
		// 0 = rotation disabled, not an error.
		expect(readLogRotationEnv({ [MCODED_LOG_MAX_BYTES_ENV]: '0' }, log)).toEqual({
			maxBytes: 0,
			keep: DEFAULT_MCODED_LOG_KEEP,
		});
		expect(readLogRotationEnv({ [MCODED_LOG_MAX_BYTES_ENV]: '4096', [MCODED_LOG_KEEP_ENV]: '5' }, log)).toEqual({
			maxBytes: 4096,
			keep: 5,
		});
		// Blank = unset, not invalid.
		expect(
			readLogRotationEnv({ [MCODED_LOG_MAX_BYTES_ENV]: '', [MCODED_LOG_KEEP_ENV]: '' }, log),
		).toEqual({ maxBytes: DEFAULT_MCODED_LOG_MAX_BYTES, keep: DEFAULT_MCODED_LOG_KEEP });
		// Invalid: default + exactly one warning per knob.
		expect(warnings).toHaveLength(0);
		expect(
			readLogRotationEnv({ [MCODED_LOG_MAX_BYTES_ENV]: 'banana', [MCODED_LOG_KEEP_ENV]: '11' }, log),
		).toEqual({ maxBytes: DEFAULT_MCODED_LOG_MAX_BYTES, keep: DEFAULT_MCODED_LOG_KEEP });
		expect(warnings).toHaveLength(2);
		expect(
			readLogRotationEnv({ [MCODED_LOG_MAX_BYTES_ENV]: '-5', [MCODED_LOG_KEEP_ENV]: '0' }, log),
		).toEqual({ maxBytes: DEFAULT_MCODED_LOG_MAX_BYTES, keep: DEFAULT_MCODED_LOG_KEEP });
		expect(warnings).toHaveLength(4);
	});
});

describe('copyTruncate (М2: one synchronous section)', () => {
	it('copies the over-ceiling content to .1 byte-for-byte and restarts the log at offset 0 (O_APPEND, no sparse hole)', () => {
		const dir = tempDir('mcoded-logrot-m2-');
		const logPath = path.join(dir, 'mcoded.log');
		const fd = fs.openSync(logPath, 'a', 0o600);
		try {
			const payload = 'a'.repeat(3000);
			fs.writeSync(fd, payload);
			copyTruncate({ fd, path: logPath, maxBytes: 1024, keep: 3 });
			// .1 is a byte-for-byte copy of the previous content, still 0600.
			expect(fs.readFileSync(`${logPath}.1`)).toEqual(Buffer.from(payload));
			expect(fs.statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
			// The fd is unchanged (same inode, now empty except the marker).
			const marker = 'mcoded: log rotated (prev 3000 → mcoded.log.1)\n';
			expect(fs.statSync(logPath).size).toBe(Buffer.byteLength(marker));
			// The next write through the SAME fd lands right after the marker
			// at offset 0 — the O_APPEND proof: a positioned (non-append) fd
			// would have left a 3000-byte sparse hole instead.
			fs.writeSync(fd, 'after-rotation');
			expect(fs.statSync(logPath).size).toBe(Buffer.byteLength(marker) + 'after-rotation'.length);
			expect(fs.readFileSync(logPath, 'utf8')).toBe(`${marker}after-rotation`);
		} finally {
			fs.closeSync(fd);
		}
	});

	it('forces the .1 generation to 0600 even when the live log was widened', () => {
		const dir = tempDir('mcoded-logrot-mode-');
		const logPath = path.join(dir, 'mcoded.log');
		const fd = fs.openSync(logPath, 'a', 0o644);
		try {
			fs.writeSync(fd, 'x'.repeat(2048));
			copyTruncate({ fd, path: logPath, maxBytes: 1024, keep: 3 });
			expect(fs.statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
		} finally {
			fs.closeSync(fd);
		}
	});

	it('keeps exactly K generations in order (K=2: .1 and .2 exist, .3 does not)', () => {
		const dir = tempDir('mcoded-logrot-gen-');
		const logPath = path.join(dir, 'mcoded.log');
		const fd = fs.openSync(logPath, 'a', 0o600);
		try {
			for (let round = 1; round <= 3; round++) {
				fs.writeSync(fd, `round-${round}-`);
				fs.writeSync(fd, 'x'.repeat(2000)); // over the 1 KiB ceiling
				copyTruncate({ fd, path: logPath, maxBytes: 1024, keep: 2 });
			}
			expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toContain('round-3-');
			expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toContain('round-2-');
			expect(fs.existsSync(`${logPath}.3`)).toBe(false); // round-1 evicted by the K=2 ceiling
		} finally {
			fs.closeSync(fd);
		}
	});
});

describe('startLogRotation (guards, fail-open, timer)', () => {
	it('does nothing when the spawner declared no log file (no MCODED_LOG_FILE)', () => {
		const dir = tempDir('mcoded-logrot-nodecl-');
		const logPath = path.join(dir, 'mcoded.log');
		const fd = fs.openSync(logPath, 'a', 0o600);
		try {
			fs.writeSync(fd, 'x'.repeat(4096));
			const handle = startLogRotation({ fd, maxBytes: 1024, keep: 3, intervalMs: 10 });
			handle.stop();
			expect(fs.statSync(logPath).size).toBe(4096); // untouched
		} finally {
			fs.closeSync(fd);
		}
	});

	it('is disabled by MCODED_LOG_MAX_BYTES=0 (maxBytes 0)', () => {
		const dir = tempDir('mcoded-logrot-off-');
		const logPath = path.join(dir, 'mcoded.log');
		const fd = fs.openSync(logPath, 'a', 0o600);
		try {
			fs.writeSync(fd, 'x'.repeat(4096));
			const handle = startLogRotation({ fd, path: logPath, maxBytes: 0, keep: 3, intervalMs: 10 });
			handle.stop();
			expect(fs.statSync(logPath).size).toBe(4096); // untouched
		} finally {
			fs.closeSync(fd);
		}
	});

	it('is a no-op when fd points at a different file (inode guard, one debug line)', () => {
		const dir = tempDir('mcoded-logrot-inode-');
		const declared = path.join(dir, 'mcoded.log');
		fs.writeFileSync(declared, 'x'.repeat(4096));
		const other = path.join(dir, 'other.log');
		const fd = fs.openSync(other, 'a', 0o600);
		const { log, debugs, warnings } = testLog();
		try {
			const handle = startLogRotation({
				fd,
				path: declared,
				maxBytes: 1024,
				keep: 3,
				intervalMs: 10,
				log,
			});
			handle.stop();
			expect(debugs).toHaveLength(1);
			expect(warnings).toHaveLength(0);
			expect(fs.statSync(declared).size).toBe(4096); // the stranger's file is intact
			expect(fs.existsSync(`${declared}.1`)).toBe(false);
		} finally {
			fs.closeSync(fd);
		}
	});

	it('fails open: one warning on a rotation error, then rotation is off for the process life (no throw)', async () => {
		const dir = tempDir('mcoded-logrot-failopen-');
		const logPath = path.join(dir, 'mcoded.log');
		const fd = fs.openSync(logPath, 'a', 0o600);
		fs.writeSync(fd, 'x'.repeat(4096));
		fs.chmodSync(dir, 0o500); // creating .1 inside must fail (EACCES)
		const { log, warnings } = testLog();
		try {
			const handle = startLogRotation({
				fd,
				path: logPath,
				maxBytes: 1024,
				keep: 3,
				intervalMs: 20,
				log,
			});
			// The interval would have fired several times by now; fail-open
			// means exactly ONE warning ever.
			await new Promise((resolve) => setTimeout(resolve, 80));
			handle.stop();
			expect(warnings).toEqual(['mcoded: log rotation disabled']);
			// The fd itself is unharmed and still O_APPEND.
			fs.writeSync(fd, 'still-writable');
			expect(fs.statSync(logPath).size).toBe(4096 + 'still-writable'.length);
		} finally {
			fs.chmodSync(dir, 0o700); // restore for the temp cleanup
			fs.closeSync(fd);
		}
	});

	it('rotates on the interval while over the ceiling (clocks injected, timer unref\'d)', async () => {
		const dir = tempDir('mcoded-logrot-timer-');
		const logPath = path.join(dir, 'mcoded.log');
		const fd = fs.openSync(logPath, 'a', 0o600);
		const { log: logger, warnings } = testLog();
		try {
			const handle = startLogRotation({
				fd,
				path: logPath,
				maxBytes: 64,
				keep: 3,
				intervalMs: 10,
				log: logger,
			});
			try {
				fs.writeSync(fd, 'y'.repeat(200));
				await new Promise((resolve) => setTimeout(resolve, 50));
				// The interval caught the over-ceiling log and rotated it.
				expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toContain('y'.repeat(200));
				expect(fs.readFileSync(logPath, 'utf8')).toMatch(/^mcoded: log rotated \(prev \d+ → mcoded\.log\.1\)\n$/);
				expect(warnings).toHaveLength(0);
			} finally {
				handle.stop();
			}
			// After stop() the timer is gone: further growth stays unrotated.
			const sizeAtStop = fs.statSync(logPath).size;
			fs.writeSync(fd, 'z'.repeat(500));
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(fs.statSync(logPath).size).toBe(sizeAtStop + 500);
		} finally {
			fs.closeSync(fd);
		}
	});
});

describe('rotateBeforeSpawn (М3: the fd does not exist yet)', () => {
	it('renames an over-ceiling log into .1, shifting the generations', () => {
		const dir = tempDir('mcoded-logrot-m3-');
		const logPath = path.join(dir, 'mcoded.log');
		fs.writeFileSync(logPath, 'x'.repeat(2048));
		fs.writeFileSync(`${logPath}.1`, 'older');
		rotateBeforeSpawn(logPath, { maxBytes: 1024, keep: 2 });
		expect(fs.existsSync(logPath)).toBe(false); // the spawn re-creates it empty
		expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('x'.repeat(2048));
		expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toBe('older');
	});

	it('leaves a within-ceiling, missing or rotation-disabled (0) log untouched', () => {
		const dir = tempDir('mcoded-logrot-m3-no-');
		const logPath = path.join(dir, 'mcoded.log');
		fs.writeFileSync(logPath, 'small');
		rotateBeforeSpawn(logPath, { maxBytes: 1024, keep: 3 });
		expect(fs.readFileSync(logPath, 'utf8')).toBe('small');
		expect(fs.existsSync(`${logPath}.1`)).toBe(false);
		// Missing log: a quiet no-op.
		rotateBeforeSpawn(path.join(dir, 'absent.log'), { maxBytes: 1024, keep: 3 });
		// Disabled: an over-ceiling log stays put.
		fs.writeFileSync(logPath, 'x'.repeat(2048));
		rotateBeforeSpawn(logPath, { maxBytes: 0, keep: 3 });
		expect(fs.statSync(logPath).size).toBe(2048);
		expect(fs.existsSync(`${logPath}.1`)).toBe(false);
	});
});

describe('lightweight spawn-shape integration (child node, no daemon)', () => {
	// The only nontrivial mechanics here are cross-process: the child's
	// inherited O_APPEND file description and the truncate through fd 2. The
	// child is spawned EXACTLY in the spawner's shape (`stdio:
	// ['ignore', fd, fd]` + `MCODED_LOG_FILE`), imports the real
	// `startLogRotation`, and writes numbered lines to BOTH stdout and stderr
	// while the rotation timer fires. A full `startProductDaemon` would add
	// runtime, auth and a socket while testing nothing extra about rotation.
	it('rotates under a live child writer without losing a main-thread line', () => {
		const require = createRequire(import.meta.url);
		const dir = tempDir('mcoded-logrot-child-');
		const logDir = path.join(dir, 'logs');
		fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
		const logPath = path.join(logDir, 'mcoded.log');
		const fd = fs.openSync(logPath, 'a', 0o600);
		const moduleUrl = pathToFileURL(
			fileURLToPath(new URL('../src/log-rotation.ts', import.meta.url)),
		).href;
		const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
		const childScript = `
			const { startLogRotation } = await import(${JSON.stringify(moduleUrl)});
			const handle = startLogRotation({
				fd: 2,
				path: process.env.MCODED_LOG_FILE,
				maxBytes: 200,
				keep: 10,
				intervalMs: 15,
				log: {
					debug() {},
					warn: (msg) => process.stderr.write('WARN:' + msg + '\\n'),
				},
			});
			let i = 0;
			const writer = setInterval(() => {
				i += 1;
				process.stderr.write('L' + i + '\\n');
				process.stdout.write('O' + i + '\\n');
				if (i >= 60) {
					clearInterval(writer);
					handle.stop();
					process.exit(0);
				}
			}, 1);
		`;
		try {
			const result = spawnSync(
				process.execPath,
				[
					'--import', pathToFileURL(require.resolve('tsx')).href,
					'--input-type=module', '--eval', childScript,
				],
				{
					cwd: repoRoot,
					env: {
						...process.env,
						MCODED_LOG_FILE: logPath,
						TSX_TSCONFIG_PATH: fileURLToPath(
							new URL('../../../tsconfig.standalone.json', import.meta.url),
						),
					},
					stdio: ['ignore', fd, fd],
					timeout: 30_000,
					killSignal: 'SIGKILL',
				},
			);
			const observed = [
				fs.readFileSync(logPath, 'utf8'),
				...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
					.map((generation) => `${logPath}.${generation}`)
					.filter((p) => fs.existsSync(p))
					.map((p) => fs.readFileSync(p, 'utf8')),
			].join('');
			expect(
				`child status ${result.status}, signal ${result.signal}.\nlog tail:\n${observed.slice(-2000)}`,
				'the child must exit cleanly',
			).toContain('child status 0');
			const lines = observed.split('\n');
			// Rotation really happened and left its marker, and the fresh log
			// starts from the beginning with it.
			expect(lines.some((line) => line.startsWith('mcoded: log rotated (prev '))).toBe(true);
			expect(fs.readFileSync(logPath, 'utf8').startsWith('mcoded: log rotated (prev ')).toBe(true);
			expect(lines.some((line) => line.startsWith('WARN:'))).toBe(false); // no fail-open fired
			// Not one main-thread line lost: both streams' numbered sequences
			// are exactly 1..60, no gaps, no duplicates.
			for (const prefix of ['L', 'O']) {
				const numbers = lines
					.filter((line) => line.startsWith(prefix) && /^\d+$/.test(line.slice(1)))
					.map((line) => Number(line.slice(1)))
					.sort((a, b) => a - b);
				expect(numbers).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
			}
			// The previous content lives on in .1.
			expect(fs.existsSync(`${logPath}.1`)).toBe(true);
		} finally {
			fs.closeSync(fd);
		}
	}, 45_000);
});
