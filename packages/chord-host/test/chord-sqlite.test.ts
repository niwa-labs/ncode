/**
 * W08 chord tests — guarded exclusive SQLite and telemetry span links.
 *
 * - the durable-path guard refuses OUR sqlite-zstd store files (single
 *   writer by construction);
 * - the exclusive writer lock admits exactly one opener per path;
 * - a chord sqlite telemetry store opened through the guard records a span
 *   whose LINKS survive (the addLink conformance this wave owns).
 *
 * @module
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteTelemetry } from '@earendil-works/chord/telemetry-sqlite';
import type { SqliteDatabase, SqliteValue } from '@earendil-works/chord/sqlite';
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';
import { afterAll, describe, expect, it } from 'vitest';

import DatabaseCtor from 'better-sqlite3';
const Database = DatabaseCtor;

/**
 * Test-only chord `SqliteDatabase` adapter over better-sqlite3: keeps chord's
 * `node:sqlite` adapter out of the vitest module graph while the telemetry
 * store exercises a REAL SQLite database.
 */
function betterSqliteAdapter(db: import('better-sqlite3').Database): SqliteDatabase {
	const exec = async (sql: string) => {
		db.exec(sql);
	};
	return {
		exec,
		run: async (sql: string, ...params: SqliteValue[]) => {
			db.prepare(sql).run(...(params as never[]));
		},
		get: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
			return (db.prepare(sql).get(...(params as never[])) ?? undefined) as T | undefined;
		},
		all: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
			return db.prepare(sql).all(...(params as never[])) as T[];
		},
		transaction: async <T>(callback: (tx: SqliteDatabase) => Promise<T>) => {
			const wrapped = betterSqliteAdapter(db);
			db.exec('BEGIN');
			try {
				const result = await callback(wrapped);
				db.exec('COMMIT');
				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		close: async () => {
			db.close();
		},
	};
}

import {
	ChordSqliteError,
	contextWithSpan,
	isDurableStorePath,
	linkCallerSpan,
	openPluginHostSqlite,
} from '../src/index.js';

const directories: string[] = [];

afterAll(() => {
	for (const directory of directories) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort: the OS temp root is wiped anyway.
		}
	}
});

describe('exclusive SQLite guard', () => {
	it('refuses the durable store paths of our sqlite-zstd backend', async () => {
		expect(isDurableStorePath('/data/sessions.g1.db')).toBe(true);
		expect(isDurableStorePath('/data/sessions.g12.db')).toBe(true);
		expect(isDurableStorePath('/home/u/.mcode-durable-profile/sessions.g1.db')).toBe(true);
		expect(isDurableStorePath('/tmp/chord-plugins.db')).toBe(false);
		await expect(openPluginHostSqlite('/data/sessions.g1.db')).rejects.toMatchObject({
			code: 'DURABLE_PATH_BLOCKED',
		});
	});

	it('admits exactly one writer per path and releases the lock on close', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'w08-chord-sqlite-'));
		directories.push(directory);
		const path = join(directory, 'plugins.db');
		const opener = (p: string) => Promise.resolve(betterSqliteAdapter(new Database(p)));
		const first = await openPluginHostSqlite(path, { open: opener });
		await expect(openPluginHostSqlite(path, { open: opener })).rejects.toMatchObject({ code: 'LOCKED' });
		expect(existsSync(`${path}.chord-writer.lock`)).toBe(true);
		await first.close();
		expect(existsSync(`${path}.chord-writer.lock`)).toBe(false);
		// The lock is released: a second writer can take over after close.
		const second = await openPluginHostSqlite(path, { open: opener });
		await second.close();
	});
});

describe('telemetry span links across chord invocations', () => {
	it('records a span with a link to the caller span (addLink survives storage)', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'w08-chord-tel-'));
		directories.push(directory);
		const guarded = await openPluginHostSqlite(join(directory, 'telemetry.db'), {
			open: (p) => Promise.resolve(betterSqliteAdapter(new Database(p))),
		});
		try {
			const store = await createSqliteTelemetry(guarded.database);

			// The caller's span rides the chord invocation context; the provider
			// reads it off the context and links its own span to it (the pinned
			// pi-durable submissions pattern: span.addLink({ context })).
			await store.startSpan({ name: 'caller.operation' }, async (callerSpan) => {
				const invocationContext = contextWithSpan(callerSpan);
				await store.startSpan({ name: 'plugin.invoke' }, async (providerSpan) => {
					linkCallerSpan(providerSpan, invocationContext);
				});
			});

			// The propagation carrier of the caller span is JSON-serializable —
			// what crosses a chord link for CROSS-store traces.
			await store.startSpan({ name: 'carrier.probe' }, async (probeSpan) => {
				const carrier = probeSpan.propagation?.inject(probeSpan);
				expect(carrier).toBeDefined();
				expect(JSON.parse(JSON.stringify(carrier))).toBeTypeOf('object');
			});

			await store.flush();

			// Read the recorded spans straight from the store's table.
			const rows = await guarded.database.all<{ name: string; trace_id: string; links: string }>(
				'SELECT name, trace_id, links FROM telemetry_spans ORDER BY started_us',
			);
			const callerRow = rows.find((row) => row.name === 'caller.operation');
			const pluginRow = rows.find((row) => row.name === 'plugin.invoke');
			expect(callerRow).toBeDefined();
			expect(pluginRow).toBeDefined();
			const links = JSON.parse(pluginRow!.links) as { trace_id: string }[];
			expect(links.length).toBeGreaterThan(0);
			expect(links[0]!.trace_id).toBe(callerRow!.trace_id);
		} finally {
			await guarded.close();
		}
	});
});
