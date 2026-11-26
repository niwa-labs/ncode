import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseClient } from './client.js';
import { initializeDatabase } from './initialize.js';
import { runMigrations } from './migrate.js';
import { ALL_MIGRATIONS } from './migrations.js';
import { NCODE_MIGRATION_TABLE, runNcodeMigrations } from './ncode-migrate.js';
import { NCODE_MIGRATIONS } from './ncode-migrations.js';
import { assertDatabaseSchemaConsistent } from './schema-consistency.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function openDatabase(): Promise<{ database: DatabaseClient; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'ncode-migrations-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const database = new DatabaseClient({ dataDir });
  cleanup.push(() => database.close());
  return { database, dataDir };
}

function upstreamVersions(database: DatabaseClient): number[] {
  return database.rawDb
    .prepare('SELECT version FROM local_runtime_v2_schema_migrations ORDER BY version')
    .all()
    .map((row) => (row as { version: number }).version);
}

function ncodeIds(database: DatabaseClient): string[] {
  return database.rawDb
    .prepare(`SELECT id FROM ${NCODE_MIGRATION_TABLE} ORDER BY id`)
    .all()
    .map((row) => (row as { id: string }).id);
}

function hasFailureReason(database: DatabaseClient): boolean {
  return Boolean(
    database.rawDb
      .prepare(
        "SELECT 1 FROM pragma_table_info('local_runtime_turn_ingress') WHERE name = 'failure_reason'",
      )
      .get(),
  );
}

async function backupCount(dataDir: string): Promise<number> {
  const entries = await readdir(join(dataDir, 'v2', 'sqlite', 'backups')).catch(() => []);
  return entries.filter((name) => name.endsWith('.sqlite')).length;
}

describe('Ncode fork migrations', () => {
  it('keeps upstream versions unchanged and records fork changes by name', async () => {
    const { database, dataDir } = await openDatabase();

    const first = await initializeDatabase({ database, dataDir });
    expect(first.pendingVersions).toEqual(ALL_MIGRATIONS.map((migration) => migration.version));
    expect(first.pendingNcodeMigrations).toEqual(['0001_add_turn_failure_reason']);
    expect(Math.max(...upstreamVersions(database))).toBe(36);
    expect(upstreamVersions(database)).not.toContain(19);
    expect(ncodeIds(database)).toEqual(NCODE_MIGRATIONS.map((migration) => migration.id));
    expect(hasFailureReason(database)).toBe(true);

    const second = await initializeDatabase({ database, dataDir });
    expect(second.pendingVersions).toEqual([]);
    expect(second.pendingNcodeMigrations).toEqual([]);
    expect(second.backup.created).toBe(false);
  });

  it('upgrades a database whose later upstream numbers came from a published build', async () => {
    const { database, dataDir } = await openDatabase();
    runMigrations(database.rawDb, ALL_MIGRATIONS);
    // Published MCode 0.7.x builds recorded versions 37-53 with their own tables.
    const insertMarker = database.rawDb.prepare(
      'INSERT INTO local_runtime_v2_schema_migrations (version, applied_at_ms) VALUES (?, 1)',
    );
    for (let version = 37; version <= 53; version += 1) insertMarker.run(version);
    database.rawDb.exec(`
      CREATE TABLE local_runtime_v2_memory_scopes (scope_id TEXT PRIMARY KEY, body TEXT);
      INSERT INTO local_runtime_v2_memory_scopes VALUES ('scope-1', 'kept');
    `);
    expect(hasFailureReason(database)).toBe(false);

    const result = await initializeDatabase({ database, dataDir });

    expect(result.pendingVersions).toEqual([]);
    expect(result.pendingNcodeMigrations).toEqual(['0001_add_turn_failure_reason']);
    expect(result.backup.created).toBe(true);
    expect(await backupCount(dataDir)).toBe(1);
    expect(hasFailureReason(database)).toBe(true);
    expect(upstreamVersions(database).filter((version) => version > 36)).toHaveLength(17);
    expect(
      database.rawDb.prepare('SELECT body FROM local_runtime_v2_memory_scopes').all(),
    ).toEqual([{ body: 'kept' }]);
  });

  it('accepts a column that an upstream change already created', async () => {
    const { database, dataDir } = await openDatabase();
    runMigrations(database.rawDb, ALL_MIGRATIONS);
    database.rawDb.exec('ALTER TABLE local_runtime_turn_ingress ADD COLUMN failure_reason TEXT');

    await initializeDatabase({ database, dataDir });

    expect(ncodeIds(database)).toEqual(['0001_add_turn_failure_reason']);
    expect(hasFailureReason(database)).toBe(true);
  });

  it('keeps fork columns when later upstream migrations run after them', async () => {
    for (const [index, forkMigration] of NCODE_MIGRATIONS.entries()) {
      const { database } = await openDatabase();
      runMigrations(
        database.rawDb,
        ALL_MIGRATIONS.filter(
          (migration) => migration.version <= forkMigration.baseUpstreamVersion,
        ),
      );
      runNcodeMigrations(database.rawDb, NCODE_MIGRATIONS.slice(0, index + 1));
      runMigrations(database.rawDb, ALL_MIGRATIONS);
      runNcodeMigrations(database.rawDb, NCODE_MIGRATIONS);

      expect(() => assertDatabaseSchemaConsistent(database.rawDb)).not.toThrow();
    }
  });

  it('rolls back a failed fork migration without recording it', async () => {
    const { database } = await openDatabase();
    const failing = {
      id: '0002_failing_change',
      baseUpstreamVersion: 36,
      up(db: { exec(sql: string): void }) {
        db.exec('CREATE TABLE ncode_partial_change (id INTEGER)');
        throw new Error('boom');
      },
    };

    expect(() => runNcodeMigrations(database.rawDb, [failing])).toThrow('boom');
    expect(ncodeIds(database)).toEqual([]);
    expect(
      database.rawDb
        .prepare("SELECT 1 FROM sqlite_master WHERE name = 'ncode_partial_change'")
        .get(),
    ).toBeUndefined();
  });

  it('rejects ambiguous fork registries', async () => {
    const { database } = await openDatabase();
    const entry = { id: '0002_change', baseUpstreamVersion: 36, up: () => undefined };

    expect(() => runNcodeMigrations(database.rawDb, [entry, entry])).toThrow('Duplicate');
    expect(() =>
      runNcodeMigrations(database.rawDb, [entry, { ...entry, id: '0001_earlier' }]),
    ).toThrow('ascending');
    expect(() => runNcodeMigrations(database.rawDb, [{ ...entry, id: '37' }])).toThrow(
      'Invalid Ncode migration id',
    );
  });
});
