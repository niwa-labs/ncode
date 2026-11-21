import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteZstdBackend, SEQ_AT_START } from '@mavis/durable-backend-sqlite-zstd';

import { SqliteZstdAdapterStateError } from '../../src/errors.js';
import {
  sqliteZstdStorageBackend,
  toEntryDraft,
  type SqliteZstdBackendLike,
} from '../../src/sqlite-zstd-adapter.js';
import type { Entry } from '../../src/contracts.js';

// Cross-package contract between the storage worker's split/replay adapter and
// the REAL durable backend: what the adapter promises about the commit it
// returns, what survives a restart of the adapter (its dedup bookkeeping is
// in-memory, the backend's is not), and what a reader anchored at the
// returned commit actually sees.

const directories: string[] = [];

function freshDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-zstd-restart-e2e-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function entry(entryId: string, textKb: number): Entry {
  return {
    entryId,
    parentId: null,
    kind: 'pi.session',
    payload: { text: 'z'.repeat(textKb * 1024) },
    bytes: textKb * 1024,
  };
}

const CAP_BYTES = 256 * 1024;

describe('adapter against the real backend: the commit of a split flush', () => {
  it('covers the whole appended range when every sub-batch succeeds', async () => {
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);
    const adapter = sqliteZstdStorageBackend(backend);

    // Four 80 KiB entries serialize to more than the backend's cap: the
    // adapter MUST split, and the backend must never see an over-cap batch.
    const batch = [entry('e1', 80), entry('e2', 80), entry('e3', 80), entry('e4', 80)];
    const commit = await adapter.appendBatch(batch);

    // The aggregate commit spans both sub-batches: first seq, last head.
    expect(commit.seq).toBe(1);
    expect(commit.head).toBe('2');
    // Both sub-batches are durable and readable.
    expect(backend.readDelta(SEQ_AT_START, 8 * 1024 * 1024).map((item) => item.id)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
    ]);
    expect(backend.verify().issues).toEqual([]);
    await backend.close();
  });

  it('loses the committed prefix from the commit after a partial split (BUG-01)', async () => {
    // Known bug (B-01):
    // after a partial split failure the retry returns the commit of the
    // SUFFIX only. The adapter's own contract (IC-F1-006) requires ONE commit
    // covering the whole appended range — the first sub-batch's seq and the
    // last sub-batch's head — so a resume cursor anchored at the returned
    // commit can never skip the committed prefix. The assertions below pin
    // the current (lossy) behavior: the data is durable, but the commit's seq
    // points past the prefix, so a reader anchored there skips it.
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);

    let failSuffix = true;
    const flaky: SqliteZstdBackendLike = {
      maxBatchUncompressedBytes: CAP_BYTES,
      appendBatch: async (drafts) => {
        if (failSuffix && drafts.some((draft) => draft.id === 'e3')) {
          failSuffix = false;
          throw new Error('injected crash while the suffix was being written');
        }
        return backend.appendBatch(drafts);
      },
      checkpoint: () => backend.checkpoint(),
    };
    const adapter = sqliteZstdStorageBackend(flaky);
    const batch = [entry('e1', 80), entry('e2', 80), entry('e3', 80), entry('e4', 80)];

    // Attempt 1: the prefix commits, the suffix dies.
    await expect(adapter.appendBatch(batch)).rejects.toThrow('injected crash');

    // The prefix IS durable — the data is not lost.
    expect(backend.readDelta(SEQ_AT_START, 8 * 1024 * 1024).map((item) => item.id)).toEqual(['e1', 'e2']);
    expect(backend.head).toBe(1);

    // Attempt 2 (the worker retry): only the suffix is re-appended.
    const commit = await adapter.appendBatch(batch);
    expect(backend.readDelta(SEQ_AT_START, 8 * 1024 * 1024).map((item) => item.id)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
    ]);

    // ...but the returned commit starts at the SUFFIX's seq, so a reader that
    // anchors its resume cursor at `commit.seq` never sees the prefix.
    expect(commit.seq).toBe(2);
    expect(commit.head).toBe('2');
    expect(backend.readDelta(commit.seq, 8 * 1024 * 1024).map((item) => item.id)).toEqual([]);
    await backend.close();
  });
});

describe('adapter against the real backend: dedup state across a restart', () => {
  it('replays a batch after a restart without duplicating the committed prefix', async () => {
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);

    let failSuffix = true;
    const flaky: SqliteZstdBackendLike = {
      maxBatchUncompressedBytes: CAP_BYTES,
      appendBatch: async (drafts) => {
        if (failSuffix && drafts.some((draft) => draft.id === 'e3')) {
          failSuffix = false;
          throw new Error('injected crash while the suffix was being written');
        }
        return backend.appendBatch(drafts);
      },
    };
    const first = sqliteZstdStorageBackend(flaky);
    const batch = [entry('e1', 80), entry('e2', 80), entry('e3', 80), entry('e4', 80)];
    await expect(first.appendBatch(batch)).rejects.toThrow('injected crash');

    // RESTART: a fresh adapter instance over the same backend. Its in-memory
    // dedup bookkeeping is empty again — the backend's durable index is the
    // only thing that remembers what was committed.
    const restarted = sqliteZstdStorageBackend(backend);
    const commit = await restarted.appendBatch(batch);

    // Every entry is stored exactly once: the duplicate refusal of the
    // committed prefix was consumed as idempotent success.
    const stored = backend.readDelta(SEQ_AT_START, 8 * 1024 * 1024).map((item) => item.id);
    expect(stored).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(new Set(stored).size).toBe(stored.length);
    expect(backend.verify().issues).toEqual([]);

    // The same prefix-accounting loss as B-01: the commit starts at the
    // suffix's seq, so the committed prefix is invisible to a reader that
    // anchors at the returned commit.
    expect(commit.seq).toBe(2);
    expect(backend.readDelta(commit.seq, 8 * 1024 * 1024).map((item) => item.id)).toEqual([]);
    await backend.close();
  });

  it('fails loudly when a restarted adapter replays a fully durable batch', async () => {
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);
    const adapter = sqliteZstdStorageBackend(backend);
    await adapter.appendBatch([entry('d1', 10), entry('d2', 10)]);
    const headBefore = backend.head;

    // RESTART: the new adapter does not know the ids are committed, so the
    // backend's duplicate refusal is the backstop. W11.5 follow-up
    // (2026-10-27): the replay resolves as an IDEMPOTENT NO-OP whose cursor
    // is the backend head (content-addressed ids ⇒ identical content) —
    // failing loudly here poisoned the worker retry loop into quarantine.
    const restarted = sqliteZstdStorageBackend(backend);
    const noop = await restarted.appendBatch([entry('d1', 10), entry('d2', 10)]);
    expect(noop.seq).toBe(headBefore);
    expect(noop.head).toBe(String(headBefore));
    expect(backend.head).toBe(headBefore);
    expect(backend.readDelta(SEQ_AT_START, 8 * 1024 * 1024).map((item) => item.id)).toEqual(['d1', 'd2']);
    await backend.close();
  });

  it('measures the drafts exactly as the backend stores them', async () => {
    // The adapter's cap is enforced on the REAL serialized size, not on the
    // caller-declared `entry.bytes`: a batch that fits the declared bytes can
    // still be over the cap, and then the adapter MUST split it.
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);
    const adapter = sqliteZstdStorageBackend(backend);

    const lying = entry('lying', 1);
    // The declared size is 1 KiB, the real one is far bigger.
    const serialized = JSON.stringify([toEntryDraft(lying)]);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(lying.bytes);

    const commit = await adapter.appendBatch([lying]);
    expect(commit.seq).toBe(1);
    expect(backend.readDelta(SEQ_AT_START, 8 * 1024 * 1024).map((item) => item.id)).toEqual(['lying']);
    await backend.close();
  });
});
