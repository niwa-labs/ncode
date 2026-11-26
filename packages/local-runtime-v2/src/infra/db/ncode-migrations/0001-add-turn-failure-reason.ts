import { tableHasColumn, type NcodeMigrationEntry } from '../ncode-migrate.js';

/** Keep the primary failure diagnostic with its turn receipt. */
export const migration: NcodeMigrationEntry = {
  id: '0001_add_turn_failure_reason',
  baseUpstreamVersion: 36,
  up(database) {
    if (tableHasColumn(database, 'local_runtime_turn_ingress', 'failure_reason')) return;
    database.exec('ALTER TABLE local_runtime_turn_ingress ADD COLUMN failure_reason TEXT;');
  },
};
