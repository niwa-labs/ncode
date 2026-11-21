/**
 * Batch byte cap.
 *
 * The backend refuses a batch whose UNCOMPRESSED JSON exceeds
 * `maxBatchUncompressedBytes`. The cap is the last line of defence before a
 * huge frame lands in the WAL, so its measurement must be pinned exactly:
 * which bytes are counted (the serialized ARRAY, not the sum of its drafts),
 * what happens at the boundary (exactly at the cap is allowed), and that a
 * refused batch leaves NOTHING behind.
 *
 * Two measurement paths exist in this backend and they do not agree:
 * `appendBatch` measures the serialized array, `stage` measures the sum of the
 * per-draft JSONs. The difference is `n + 1` bytes for `n` drafts (the
 * brackets and the commas). The tests below pin BOTH behaviours, including
 * the divergence — see `BUG-STORAGE-WORKER-001` in the review notes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteZstdBackend, type SqliteZstdBackend } from '../../src/index.js';
import { DuplicateEntryError, SqliteZstdError } from '../../src/errors.js';
import { SEQ_AT_START, type EntryDraft } from '../../src/index.js';

let workDir: string;
let backend: SqliteZstdBackend | null = null;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'sqlite-zstd-cap-'));
});

afterEach(async () => {
	// A wedged open batch (see BUG-STORAGE-WORKER-001) cannot be flushed, so
	// close() fails too — the teardown must not mask the test's own verdict.
	try {
		await backend?.close();
	} catch {
		// Best effort: the directory removal below is what matters.
	}
	backend = null;
	rmSync(workDir, { recursive: true, force: true });
});

/** Open a backend with an explicit cap (0 disables the cap entirely). */
function openWithCap(capBytes: number): SqliteZstdBackend {
	backend = openSqliteZstdBackend(workDir, { maxBatchUncompressedBytes: capBytes });
	return backend;
}

function draft(id: string, payload: unknown): EntryDraft {
	return { id, kind: 'pi.test', payload: payload as EntryDraft['payload'] };
}

/** Byte length of the JSON array a batch is stored as. */
function arrayBytes(drafts: readonly EntryDraft[]): number {
	return Buffer.byteLength(JSON.stringify(drafts), 'utf8');
}

/** Sum of the per-draft JSON lengths — what `stage()` measures. */
function draftSumBytes(drafts: readonly EntryDraft[]): number {
	return drafts.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0);
}

/** `n` drafts whose payloads carry a marker, so sizes are stable. */
function draftsOf(count: number, marker = 'm'): EntryDraft[] {
	return Array.from({ length: count }, (_, index) => draft(`e-${index}`, { marker, n: index }));
}

describe('appendBatch byte cap', () => {
	it('reports the configured cap through maxBatchUncompressedBytes', () => {
		expect(openWithCap(4_096).maxBatchUncompressedBytes).toBe(4_096);
	});

	it('accepts a batch whose serialized size is exactly at the cap', async () => {
		const drafts = draftsOf(4);
		const bytes = arrayBytes(drafts);
		const b = openWithCap(bytes);

		const commit = await b.appendBatch(drafts);

		expect(commit.uncompressedBytes).toBe(bytes);
		expect(commit.entryCount).toBe(4);
		expect(b.head).toBe(1);
	});

	it('refuses a batch one byte over the cap and writes nothing', async () => {
		const drafts = draftsOf(4);
		const bytes = arrayBytes(drafts);
		const b = openWithCap(bytes - 1);

		await expect(b.appendBatch(drafts)).rejects.toThrow(SqliteZstdError);
		await expect(b.appendBatch(drafts)).rejects.toThrow(
			new RegExp(`batch exceeds the uncompressed cap: ${bytes} > ${bytes - 1} bytes`),
		);

		// A refused batch must leave no trace: no head, no rows, no entries.
		expect(b.head).toBe(SEQ_AT_START);
		expect(b.readDelta(SEQ_AT_START, 1_000_000)).toEqual([]);
		expect(b.verify()).toEqual({ batchesChecked: 0, entriesChecked: 0, issues: [] });
	});

	it('measures the cap against the serialized array, not the sum of the drafts', async () => {
		// The stored image is the JSON ARRAY, so the array is what the cap
		// must measure. `arrayBytes === draftSumBytes + n + 1` for n drafts
		// (two brackets and n-1 commas).
		const drafts = draftsOf(4);
		const sum = draftSumBytes(drafts);
		const array = arrayBytes(drafts);
		expect(array).toBe(sum + drafts.length + 1);

		// A cap of `sum` is under the array size — the batch must be refused
		// even though every individual draft would fit.
		const b = openWithCap(sum);
		await expect(b.appendBatch(drafts)).rejects.toThrow(/batch exceeds the uncompressed cap/);
		expect(b.head).toBe(SEQ_AT_START);
	});

	it('disables the cap entirely when maxBatchUncompressedBytes is 0', async () => {
		const drafts = draftsOf(2, 'x'.repeat(400_000));
		const b = openWithCap(0);

		expect(b.maxBatchUncompressedBytes).toBe(0);
		const commit = await b.appendBatch(drafts);
		expect(commit.entryCount).toBe(2);
		expect(commit.uncompressedBytes).toBeGreaterThan(800_000);
	});

	it('applies the cap to the filtered source of an idempotent append', async () => {
		// Under `idempotent: true` the committed ids are dropped BEFORE the
		// measurement, so the cap applies to what is actually written.
		const b = openWithCap(4_096);
		await b.appendBatch([draft('already', { n: 1 })]);

		const fresh = draftsOf(3);
		const source = arrayBytes(fresh);
		expect(source).toBeLessThan(4_096);

		// The full batch (old id + fresh ids) is far over the cap, but only
		// the fresh source is measured — so the append must succeed.
		const commit = await b.appendBatch([draft('already', { n: 1 }), ...fresh], { idempotent: true });
		expect(commit.entryCount).toBe(3);
		expect(b.head).toBe(2);
	});

	it('refuses an idempotent append where every entry is already committed', async () => {
		const b = openWithCap(4_096);
		await b.appendBatch([draft('already', { n: 1 })]);

		await expect(b.appendBatch([draft('already', { n: 1 })], { idempotent: true })).rejects.toThrow(
			DuplicateEntryError,
		);
		await expect(b.appendBatch([draft('already', { n: 1 })], { idempotent: true })).rejects.toThrow(
			/all 1 entries are already committed/,
		);
		expect(b.head).toBe(1); // nothing was written
	});

	it('refuses to combine a pre-serialized batch with the idempotent filter', async () => {
		const b = openWithCap(4_096);
		await expect(
			b.appendBatch([draft('e-0', { n: 1 })], {
				serialized: Buffer.from('[{"id":"e-0","kind":"pi.test","payload":{"n":1}}]', 'utf8'),
				idempotent: true,
			}),
		).rejects.toThrow(TypeError);
	});

	it('measures a pre-serialized batch against the cap', async () => {
		const b = openWithCap(32);
		const serialized = Buffer.from(JSON.stringify([draft('e-0', { n: 1 })]), 'utf8');
		expect(serialized.length).toBeGreaterThan(32);
		await expect(b.appendBatch([draft('e-0', { n: 1 })], { serialized })).rejects.toThrow(
			/batch exceeds the uncompressed cap/,
		);
		expect(b.head).toBe(SEQ_AT_START);
	});
});

describe('stage byte cap', () => {
	it('stages up to the cap and flushes the open batch as one commit', async () => {
		const drafts = draftsOf(3);
		const b = openWithCap(64 * 1024);

		b.stage(drafts);
		const commit = await b.checkpoint();

		expect(commit?.entryCount).toBe(3);
		expect(b.head).toBe(1);
	});

	it('refuses to stage past the cap and leaves no partial batch behind', async () => {
		const small = draft('small', { n: 1 });
		const big = draft('big', { marker: 'x'.repeat(4_096) });
		const cap = Buffer.byteLength(JSON.stringify(small), 'utf8') + 512;
		const b = openWithCap(cap);
		b.stage([small]);

		// `stage()` is synchronous: the refusal arrives as a thrown error.
		expect(() => b.stage([big])).toThrow(SqliteZstdError);
		expect(() => b.stage([big])).toThrow(/checkpoint\(\) the open batch first/);

		// The refused stage must not have pushed a single draft: only the
		// first, explicitly staged draft is in the open batch.
		const commit = await b.checkpoint();
		expect(commit?.entryCount).toBe(1);
		expect(b.readDelta(SEQ_AT_START, 1_000_000).map((entry) => entry.id)).toEqual(['small']);
	});

	it('stages a batch the commit path then refuses: the two measurements disagree', async () => {
		// BUG-STORAGE-WORKER-001: `stage()` measures the SUM of the per-draft
		// JSONs, while `commitBatch()` measures the serialized ARRAY. For n
		// drafts the array is `n + 1` bytes larger (brackets + commas), so an
		// open batch that fits the cap at stage time can be refused at
		// checkpoint time — and the entries then stay in the open batch
		// forever, because every retry measures the same way.
		const drafts = draftsOf(3);
		const sum = draftSumBytes(drafts);
		const array = arrayBytes(drafts);
		const b = openWithCap(sum);

		// The stage measurement accepts it: sum === cap.
		b.stage(drafts);

		// The commit measurement refuses it: array === sum + 4 > cap.
		await expect(b.checkpoint()).rejects.toThrow(/batch exceeds the uncompressed cap/);
		expect(b.head).toBe(SEQ_AT_START);

		// The entries are NOT dropped — they are put back into the open
		// batch, but no flush can ever succeed for them.
		await expect(b.checkpoint()).rejects.toThrow(/batch exceeds the uncompressed cap/);
		expect(b.head).toBe(SEQ_AT_START);
		expect(array).toBe(sum + 4);
	});
});
