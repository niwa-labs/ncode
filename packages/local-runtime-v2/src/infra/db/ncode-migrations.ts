import type { NcodeMigrationEntry } from './ncode-migrate.js';
import { migration as n0001 } from './ncode-migrations/0001-add-turn-failure-reason.js';

/**
 * Fork-owned migrations, applied in this order after `ALL_MIGRATIONS`.
 * Never renumber or reuse an id once a build containing it has run.
 */
export const NCODE_MIGRATIONS: readonly NcodeMigrationEntry[] = [n0001];
