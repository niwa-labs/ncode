/**
 * W02-T (torn-tail follow-up): a torn zstd frame in an EXISTING log must fail
 * closed at the pi layer, per the backend's torn-tail contract (backend.ts
 * header: a torn batch "fails decoding with `CorruptFrameError`" and
 * `readDeltaChecked()` "reports a torn tail explicitly instead of silently
 * confusing it with the end of the log").
 *
 * `codec-torn-frame.test.ts` proves the CODEC refuses torn frames and
 * `pi-storage-faults.test.ts` proves IN-TRANSACTION rollback; neither drives
 * a damaged batch on disk through the pi Storage read path. This file does:
 * commit real pi records, close, flip one byte inside one stored frame (the
 * `batches.payload` blob, deep past the envelope header so the declared
 * lengths stay valid and the refusal must come from the frame checksum),
 * reopen, and prove:
 *
 * - reopen stays available: the pi adapter's `open` reads the ID watermark
 *   from SQL only — it must not refuse a log whose prefix is intact;
 * - the pi record whose content rides the torn batch FAILS CLOSED: `entry()`
 *   rejects with `CorruptFrameError`; damaged bytes are never served;
 * - point reads of records in INTACT batches still resolve — including the
 *   batch AFTER the torn one (`getEntry` decodes exactly one batch,
 *   backend.ts:835-853);
 * - `readDeltaChecked()` serves ONLY the intact prefix and reports the torn
 *   tail explicitly (`tornTail.batchId` + reason), never as a clean end.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type EntryId, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { afterAll, describe, expect, it } from 'vitest';

import {
	CorruptFrameError,
	loadSqlite3Constructor,
	PiSqliteZstdStorage,
	SqliteZstdBackend,
} from '../../src/index.js';

const context = BACKGROUND_CONTEXT;
const Database = loadSqlite3Constructor();

/** Current envelope header: 'MZS2' (4) | codec id (1) | frame length (8) | uncompressed length (8). */
const FRAME_HEADER_LENGTH = 21;

const directories: string[] = [];

function freshDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'pi-storage-torn-tail-'));
	directories.push(directory);
	return directory;
}

afterAll(() => {
	for (const directory of directories) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort; the OS temp root is wiped anyway.
		}
	}
});

describe('torn frame: pi Storage read path over a damaged zstd batch', () => {
	it('fails closed on the torn record, serves intact batches, and reports the torn tail', async () => {
		const dir = freshDirectory();
		const backend = SqliteZstdBackend.open(dir);
		const storage = PiSqliteZstdStorage.open(backend);

		// Four separate pi commits -> four zstd batches (one pi commit = one
		// backend batch): the root conversation, then three entries. IDs are
		// deterministic under the single writer: the watermark starts at 2 and
		// the reserved root conversation does not advance it.
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		const firstId = await storage.mintId<EntryId>();
		const tornId = await storage.mintId<EntryId>();
		const lastId = await storage.mintId<EntryId>();
		await storage.commit(
			[
				{
					type: 'entry',
					value: { id: firstId, conversationId: ROOT_CONVERSATION_ID, kind: 'note', data: { slot: 'first' } },
				},
			],
			context,
		);
		await storage.commit(
			[
				{
					type: 'entry',
					value: { id: tornId, conversationId: ROOT_CONVERSATION_ID, kind: 'note', data: { slot: 'torn' } },
				},
			],
			context,
		);
		await storage.commit(
			[
				{
					type: 'entry',
					value: { id: lastId, conversationId: ROOT_CONVERSATION_ID, kind: 'note', data: { slot: 'last' } },
				},
			],
			context,
		);
		await storage.close(context);

		// Corrupt the frame that carries the middle entry's record content:
		// the log index (`entries.entry_id -> batch_id`) tells us the batch,
		// and one flipped byte deep inside the frame body leaves the envelope
		// header intact, so the refusal can only come from the codec checksum.
		const raw = new Database(join(dir, 'sessions.g1.db'), { fileMustExist: true });
		const tornBatchId = (
			raw.prepare('SELECT batch_id FROM entries WHERE entry_id = ?').get(`pi.entry.${Number(tornId)}`) as {
				readonly batch_id: number;
			}
		).batch_id;
		const payloadRow = raw.prepare('SELECT payload FROM batches WHERE batch_id = ?').get(tornBatchId) as {
			readonly payload: Uint8Array;
		};
		const payload = Buffer.from(payloadRow.payload);
		expect(payload.length).toBeGreaterThan(FRAME_HEADER_LENGTH + 8);
		const flipOffset = FRAME_HEADER_LENGTH + Math.floor(((payload.length - FRAME_HEADER_LENGTH) * 2) / 3);
		payload[flipOffset] = (payload[flipOffset] ?? 0) ^ 0xff;
		raw.prepare('UPDATE batches SET payload = ? WHERE batch_id = ?').run(payload, tornBatchId);
		raw.close();

		// Reopen over the damaged file.
		const reopenedBackend = SqliteZstdBackend.open(dir);
		const reopenedStorage = PiSqliteZstdStorage.open(reopenedBackend);

		// (1) The torn record fails closed: `CorruptFrameError`, and the
		// verdict names the failed frame — not a JSON or index error.
		await expect(reopenedStorage.entry(tornId, context)).rejects.toBeInstanceOf(CorruptFrameError);
		await expect(reopenedStorage.entry(tornId, context)).rejects.toThrow(
			/frame failed (zstd|gzip) decompression/,
		);

		// (2) Records in intact batches still resolve byte-identically — the
		// batch AFTER the torn one included: a point read decodes exactly one
		// batch, so a torn tail never blinds intact point reads.
		const first = await reopenedStorage.entry(firstId, context);
		expect(first?.entry.kind).toBe('note');
		expect(first?.entry.data).toEqual({ slot: 'first' });
		const last = await reopenedStorage.entry(lastId, context);
		expect(last?.entry.kind).toBe('note');
		expect(last?.entry.data).toEqual({ slot: 'last' });

		// (3) The windowed read reports the torn tail explicitly and serves
		// only the intact prefix: nothing from the torn batch, nothing from
		// any batch after it.
		const scan = reopenedBackend.readDeltaChecked(0, 1024 * 1024 * 1024);
		expect(scan.tornTail).not.toBeNull();
		expect(Number(scan.tornTail?.batchId)).toBe(tornBatchId);
		expect(scan.tornTail?.reason).toMatch(/frame failed (zstd|gzip) decompression/);
		const servedIds = scan.entries.map((entry) => entry.id);
		expect(servedIds).toContain(`pi.entry.${Number(firstId)}`);
		expect(servedIds).not.toContain(`pi.entry.${Number(tornId)}`);
		expect(servedIds).not.toContain(`pi.entry.${Number(lastId)}`);
		// The served prefix ends at the batch right before the torn one.
		expect(scan.nextAfterSeq).not.toBeNull();
		expect(Number(scan.nextAfterSeq)).toBe(tornBatchId - 1);

		await reopenedStorage.close(context);
	}, 30_000);
});
