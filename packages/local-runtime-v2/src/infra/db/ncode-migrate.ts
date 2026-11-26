import type { MigrationDatabase } from './migrate.js';

/**
 * Schema changes owned by the Ncode fork.
 *
 * Upstream MCode numbers its migrations in `local_runtime_v2_schema_migrations`,
 * and published MCode builds have already used versions that the public source
 * does not contain. A fork migration in that numeric space would eventually
 * collide with an upstream marker and be skipped. Fork migrations are therefore
 * recorded by name in a separate table and run after every upstream migration.
 *
 * Each `up` must be idempotent, because an upstream change may later provide
 * the same schema. `baseUpstreamVersion` is the newest upstream migration the
 * change was written against; tests replay the real order on existing
 * databases (upstream up to that version, the fork change, later upstream) to
 * detect an upstream migration that rebuilds a table and drops fork columns.
 */
export interface NcodeMigrationEntry {
  readonly id: string;
  readonly baseUpstreamVersion: number;
  readonly up: (database: MigrationDatabase) => void;
}

export const NCODE_MIGRATION_TABLE = 'ncode_schema_migrations';

const ID_PATTERN = /^\d{4}_[a-z0-9_]+$/u;

export function readAppliedNcodeMigrations(database: MigrationDatabase): Set<string> {
  const table = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .all(NCODE_MIGRATION_TABLE);
  if (table.length === 0) return new Set();
  return new Set(
    database.prepare(`SELECT id FROM ${NCODE_MIGRATION_TABLE}`).all().map((row) => {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('id' in row) ||
        typeof row.id !== 'string'
      ) {
        throw new Error('Invalid Ncode schema migration history row');
      }
      return row.id;
    }),
  );
}

export function runNcodeMigrations(
  database: MigrationDatabase,
  migrations: readonly NcodeMigrationEntry[],
): void {
  validateNcodeMigrations(migrations);
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${NCODE_MIGRATION_TABLE} (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);
  const applied = readAppliedNcodeMigrations(database);
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      const recorded = database
        .prepare(`SELECT 1 FROM ${NCODE_MIGRATION_TABLE} WHERE id = ?`)
        .all(migration.id);
      if (recorded.length === 0) {
        migration.up(database);
        database
          .prepare(`INSERT INTO ${NCODE_MIGRATION_TABLE} (id, applied_at_ms) VALUES (?, ?)`)
          .run(migration.id, Date.now());
      }
      database.exec('COMMIT');
      applied.add(migration.id);
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back; keep the migration error.
      }
      throw error;
    }
  }
}

function validateNcodeMigrations(migrations: readonly NcodeMigrationEntry[]): void {
  const ids = new Set<string>();
  let previousId = '';
  for (const migration of migrations) {
    if (!ID_PATTERN.test(migration.id)) {
      throw new Error(`Invalid Ncode migration id: ${migration.id}`);
    }
    if (ids.has(migration.id)) throw new Error(`Duplicate Ncode migration id: ${migration.id}`);
    if (migration.id <= previousId) {
      throw new Error('Ncode migrations must be ordered by ascending id');
    }
    if (!Number.isSafeInteger(migration.baseUpstreamVersion) || migration.baseUpstreamVersion < 1) {
      throw new Error(`Invalid upstream base for Ncode migration: ${migration.id}`);
    }
    ids.add(migration.id);
    previousId = migration.id;
  }
}

export function tableHasColumn(
  database: MigrationDatabase,
  table: string,
  column: string,
): boolean {
  return (
    database.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').all(table, column)
      .length > 0
  );
}
