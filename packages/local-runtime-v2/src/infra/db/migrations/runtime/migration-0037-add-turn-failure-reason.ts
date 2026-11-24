import type { MigrationEntry } from '../../migrate.js';

export const migration: MigrationEntry = {
  version: 37,
  name: 'add_turn_failure_reason',
  up: 'ALTER TABLE local_runtime_turn_ingress ADD COLUMN failure_reason TEXT;',
};
