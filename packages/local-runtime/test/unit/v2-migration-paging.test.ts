import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openLocalRuntimeDb } from '../../src/persistence/db.js';
import {
  ensureCurrentLocalRuntimeDataMigratedToV2,
} from '../../src/persistence/migration/v2-migration.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const dir = cleanup.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('v2 asset-ref migration paging (rows must never be materialized whole-table)', () => {
  it('migrates attachments across key pages exactly once per row', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'v2-mig-paging-'));
    cleanup.push(dataDir);
    const db = openLocalRuntimeDb(dataDir);
    const insert = (db as unknown as {
      prepare(sql: string): { run(...args: unknown[]): unknown };
    }).prepare(
      'INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const total = 450; // 200 + 200 + 50 pages at the migration's page size
    const withAttachment = 45; // every 10th row
    for (let i = 1; i <= total; i++) {
      const payload =
        i % 10 === 0
          ? { role: 'user', attachments: [{ file_name: `a${i}.png`, mime_type: 'image/png', data_url: DATA_URL }] }
          : { role: 'user', text: `row ${i}` };
      insert.run('sess-1', `msg-${i}`, 'user', 'turn-1', i, JSON.stringify(payload));
    }

    const manifest = ensureCurrentLocalRuntimeDataMigratedToV2({ dataDir });

    expect(manifest.errors).toEqual([]);
    expect(manifest.assetRefsUpdated).toBe(withAttachment);
    // Every row visited exactly once: no duplicates (paged cursor advance) and
    // none skipped (paging terminates at the true end of the table).
    const select = (db as unknown as {
      prepare(sql: string): { all(...args: unknown[]): unknown[] };
    }).prepare('SELECT data_json FROM local_runtime_message_rows ORDER BY id');
    const rows = select.all() as Array<{ data_json: string }>;
    expect(rows).toHaveLength(total);
    const migrated = rows.filter((row) => row.data_json.includes('asset_ref') || !row.data_json.includes('data:'));
    // Attachment rows lost their inline data: URL; plain rows untouched.
    const stillInline = rows.filter((row) => row.data_json.includes('data:image/png'));
    expect(stillInline).toHaveLength(0);
    expect(migrated.length).toBe(total);
  });

  it('is idempotent on a second run (receipt short-circuits the heavy pass)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'v2-mig-idem-'));
    cleanup.push(dataDir);
    const db = openLocalRuntimeDb(dataDir);
    const insert = (db as unknown as {
      prepare(sql: string): { run(...args: unknown[]): unknown };
    }).prepare(
      'INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('sess-1', 'msg-1', 'user', 'turn-1', 1, JSON.stringify({ attachments: [{ file_name: 'a.png', mime_type: 'image/png', data_url: DATA_URL }] }));

    const first = ensureCurrentLocalRuntimeDataMigratedToV2({ dataDir });
    expect(first.errors).toEqual([]);
    expect(first.assetRefsUpdated).toBeGreaterThan(0);
    const second = ensureCurrentLocalRuntimeDataMigratedToV2({ dataDir });
    expect(second.errors).toEqual([]);
    expect(second.assetRefsUpdated).toBe(0);
    expect(second.skipped).toContain('sqlite:asset-refs:migration-current');
  });
});
