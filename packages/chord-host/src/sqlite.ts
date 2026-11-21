/**
 * Guarded chord SQLite (W08 C-invariant, port-plan.md:789 — chord replication
 * keeps "exclusive SQLite"; §2.4.6 A6 :195 — "replicated host state не
 * получает обходного canonical writer"):
 *
 * 1. DURABLE-PATH GUARD (fail-closed): a chord database is NEVER opened at a
 *    path belonging to OUR durable storage (`sessions.g*.db`, the durable
 *    root family) — the sqlite-zstd backend is the single writer of that
 *    file, and a second SQLite handle on it is an invariant breach, not a
 *    degraded mode.
 * 2. EXCLUSIVE WRITER: each opened path takes an O_EXCL lockfile; a second
 *    opener gets `ChordSqliteLockedError` instead of a silent second writer.
 *    `close()` releases the lock.
 *
 * @module
 */

import { unlinkSync, openSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { SqliteDatabase } from '@earendil-works/chord/sqlite';

import { createLogger } from '@mavis/logging';

const log = createLogger('mcode:chord-host');

/** Fail-closed errors of the guarded chord SQLite open. */
export class ChordSqliteError extends Error {
	constructor(
		message: string,
		readonly code: 'DURABLE_PATH_BLOCKED' | 'LOCKED',
	) {
		super(message);
		this.name = 'ChordSqliteError';
	}
}

/** Patterns that belong to OUR durable storage (the sqlite-zstd backend's files). */
export function isDurableStorePath(path: string): boolean {
	const name = basename(path);
	if (/^sessions\.g\d+\.db/.test(name)) return true;
	if (/\.mcode-durable/.test(path)) return true;
	return false;
}

export interface GuardedChordSqlite {
	readonly path: string;
	readonly database: SqliteDatabase;
	/** Release the exclusive writer lock and close the database. */
	close(): Promise<void>;
}

export type ChordSqliteOpener = (path: string) => Promise<SqliteDatabase>;

interface OpenOptions {
	readonly busyTimeoutMs?: number;
	/**
	 * Database opener injection (tests supply an adapter so the vitest module
	 * graph never loads chord's `node:sqlite` adapter). Production uses the
	 * default: chord's `openNodeSqliteDatabase`, imported lazily.
	 */
	readonly open?: ChordSqliteOpener;
}

/** Common guard + exclusive lockfile acquisition. Returns the unlock handle. */
function acquire(path: string): string {
	const absolute = resolve(path);
	if (isDurableStorePath(absolute)) {
		throw new ChordSqliteError(
			`refusing to open a chord SQLite database at durable-store path ${absolute} (the sqlite-zstd backend owns it)`,
			'DURABLE_PATH_BLOCKED',
		);
	}
	const lockPath = `${absolute}.chord-writer.lock`;
	try {
		// O_EXCL|O_CREAT: atomic single-writer claim.
		openSync(lockPath, 'wx');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			throw new ChordSqliteError(`a chord SQLite writer already holds ${absolute}`, 'LOCKED');
		}
		throw error;
	}
	return lockPath;
}

/** Default opener: chord's node adapter, imported lazily (node:sqlite). */
async function defaultOpen(path: string, busyTimeoutMs?: number): Promise<SqliteDatabase> {
	const { openNodeSqliteDatabase } = await import('@earendil-works/chord/sqlite/node');
	return openNodeSqliteDatabase(path, {
		walAutoCheckpointPages: 0,
		...(busyTimeoutMs !== undefined ? { busyTimeoutMs } : {}),
	});
}

/** Open a chord database for the plugin host, guarded and exclusive. */
export async function openPluginHostSqlite(path: string, options: OpenOptions = {}): Promise<GuardedChordSqlite> {
	const absolute = resolve(path);
	const lockPath = acquire(absolute);
	try {
		const database = await (options.open !== undefined
			? options.open(absolute)
			: defaultOpen(absolute, options.busyTimeoutMs));
		log.debug('chord sqlite opened (exclusive)', { path: absolute });
		return {
			path: absolute,
			database,
			close: async () => {
				try {
					await database.close();
				} finally {
					releaseLock(lockPath);
				}
			},
		};
	} catch (error) {
		releaseLock(lockPath);
		throw error;
	}
}

function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		// Best effort: an already-released lock is fine.
	}
}
