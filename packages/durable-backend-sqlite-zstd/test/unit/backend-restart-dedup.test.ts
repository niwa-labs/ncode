import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteZstdBackend, SEQ_AT_START, type EntryDraft } from '../../src/index.js';
import { DuplicateEntryError } from '../../src/errors.js';

// The dedup state of the durable backend is NOT in-memory: it is the
// `entries.entry_id` index, so it must survive a restart of the process.
// These tests pin that contract (the replay-safety guarantee the storage
// worker's split/retry path relies on: IC-F1-005) and the edges of the
// idempotent-append filter that implements it.

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'sqlite-zstd-restart-'));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function draft(id: string): EntryDraft {
	return { id, kind: 'pi.user', payload: { id } };
}

function drafts(ids: readonly string[]): EntryDraft[] {
	return ids.map(draft);
}

function ids(count: number, prefix: string): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

describe('durable backend: dedup state across a restart', () => {
	it('keeps the committed ids after a close/reopen cycle', async () => {
		const first = SqliteZstdBackend.open(workDir);
		await first.appendBatch(drafts(['a-0', 'a-1', 'a-2']));
		await first.close();

		// The dedup state lives in the durable index, not in the handle.
		const reopened = SqliteZstdBackend.open(workDir);
		expect(reopened.head).toBe(1);

		// A full replay of an already-committed batch is refused loudly
		// instead of fabricating an empty commit.
		await expect(reopened.appendBatch(drafts(['a-0', 'a-1', 'a-2']), { idempotent: true })).rejects.toThrow(
			DuplicateEntryError,
		);
		await expect(reopened.appendBatch(drafts(['a-0', 'a-1', 'a-2']), { idempotent: true })).rejects.toThrow(
			/all 3 entries are already committed/,
		);

		// A mixed batch writes only the fresh half — the committed prefix is
		// skipped, the new tail is committed, and the head advances by one.
		const mixed = await reopened.appendBatch(drafts(['a-0', 'a-1', 'a-2', 'b-0', 'b-1']), { idempotent: true });
		expect(mixed.entryCount).toBe(2);
		expect(reopened.head).toBe(2);
		expect(reopened.readDelta(SEQ_AT_START, 1024 * 1024).map((entry) => entry.id)).toEqual([
			'a-0',
			'a-1',
			'a-2',
			'b-0',
			'b-1',
		]);

		// The index survived too: a resume cursor anchored at an entry id
		// still resolves against the reopened database. The anchor is
		// exclusive and batch-scoped: the rest of a-1's own batch is not
		// re-served, the next batch is.
		expect(reopened.readDeltaFrom('a-1', 1024 * 1024).map((entry) => entry.id)).toEqual(['b-0', 'b-1']);
		expect(reopened.verify().issues).toEqual([]);
		await reopened.close();
	});

	it('filters committed ids across the 256-entry chunk boundary', async () => {
		const committed = ids(300, 'a');
		const first = SqliteZstdBackend.open(workDir);
		await first.appendBatch(drafts(committed));
		await first.close();

		const reopened = SqliteZstdBackend.open(workDir);
		// The replay mixes already-committed ids (before AND after the
		// filter's 256-id chunk boundary) with fresh ones, so the chunked
		// existence filter is exercised on every chunk, not just the first.
		const fresh = ids(400, 'b');
		const replay = [...committed.slice(0, 150), ...fresh, ...committed.slice(150)];
		const commit = await reopened.appendBatch(drafts(replay), { idempotent: true });

		expect(commit.entryCount).toBe(fresh.length);
		expect(reopened.head).toBe(2);

		const stored = reopened.readDelta(SEQ_AT_START, 8 * 1024 * 1024).map((entry) => entry.id);
		expect(stored).toHaveLength(committed.length + fresh.length);
		expect(new Set(stored).size).toBe(stored.length); // no id was written twice
		expect(stored.slice(0, committed.length)).toEqual(committed);
		expect(stored.slice(committed.length)).toEqual(fresh);
		expect(reopened.verify().issues).toEqual([]);
		await reopened.close();
	});

	it('refuses a duplicate id inside one batch instead of silently deduping it', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		// The idempotent filter looks at the DURABLE index, not at the batch
		// itself: an id repeated inside one batch still hits the primary key.
		await expect(
			backend.appendBatch(drafts(['dup-0', 'dup-1', 'dup-0']), { idempotent: true }),
		).rejects.toThrow(DuplicateEntryError);
		expect(backend.head).toBe(SEQ_AT_START);
		expect(backend.readDelta(SEQ_AT_START, 1024 * 1024)).toEqual([]);
		await backend.close();
	});

	it('refuses an empty batch on every path', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await expect(backend.appendBatch([])).rejects.toThrow(TypeError);
		await expect(backend.appendBatch([], { idempotent: true })).rejects.toThrow(
			/batch must contain at least one entry/,
		);
		// The head did not move: a refused batch consumes no sequence.
		expect(backend.head).toBe(SEQ_AT_START);
		await backend.close();
	});
});
