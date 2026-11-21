/**
 * W02 part A: adapter-specific guarantees BEYOND the upstream conformance
 * suite — the substrate properties the port plan demands of OUR
 * implementation:
 *
 * - record content really rides the zstd batches (`pi.*` entries, exact
 *   deterministic mcode entry ids — the id-domain separation of
 *   `pi-ids.ts`, no bare numeric ids);
 * - reopen recovery: the minted-ID watermark, records, and the sequence
 *   survive close/reopen (`pi.next_id` in the same database);
 * - atomicity: a rejected commit leaves NEITHER batch NOR index rows behind
 *   and does not consume a sequence number;
 * - empty commits advance the pi sequence through a deterministic commit
 *   marker;
 * - single-writer fencing is inherited from the backend (a second writable
 *   open is refused), and a sealed older generation stays readable through
 *   the adapter (old-generation read of the W02 readiness criteria).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { afterAll, describe, expect, it } from 'vitest';

import {
	OwnerWriteLockError,
	PiSqliteZstdStorage,
	PI_RECORD_ENTRY_KIND,
	SqliteZstdBackend,
} from '../src/index.js';

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];

function freshDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'pi-storage-part-a-'));
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

function pendingTask(id: TaskId<JsonValue>, conversationId: ConversationId) {
	return {
		id,
		conversationId,
		kind: 'test.task',
		version: 1,
		input: { value: id },
		state: { status: 'pending' as const, checkpoint: { phase: 'ready' } },
		background: false,
		abortRequested: false,
	};
}

describe('PiSqliteZstdStorage substrate', () => {
	it('stores record content in the zstd batches under deterministic pi-domain mcode entry ids', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		const entryId = await storage.mintId<EntryId>();
		const taskId = await storage.mintId<TaskId<JsonValue>>();
		await storage.commit(
			[
				{ type: 'entry', value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: 'user' } },
				{ type: 'task', value: pendingTask(taskId, ROOT_CONVERSATION_ID) },
			],
			context,
		);

		// The zstd log carries the record content with the deterministic
		// pi-domain ids — and no bare numeric id can collide with them.
		const entries = backend.readDelta(0, 1024 * 1024);
		const ids = entries.map((entry) => entry.id).sort();
		expect(ids).toContain('pi.conversation.1');
		expect(ids).toContain(`pi.entry.${String(entryId)}`);
		expect(ids).toContain(`pi.task.${String(taskId)}.r1`);
		expect(ids.some((id) => /^\d+$/.test(id))).toBe(false);
		for (const entry of entries) {
			if (isPiRecordEntryId(entry.id)) expect(entry.kind).toBe(PI_RECORD_ENTRY_KIND);
		}

		// The mcode history path is untouched: no history kinds, no seam kinds.
		expect(entries.every((entry) => !entry.kind.startsWith('history.') && !entry.kind.startsWith('mcode.'))).toBe(true);

		await storage.close(context);
	});

	it('reopens with the minted-ID watermark, records, and sequence intact', async () => {
		const directory = freshDirectory();
		{
			const backend = SqliteZstdBackend.open(directory);
			const storage = PiSqliteZstdStorage.open(backend);
			await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			await storage.commit([{ type: 'task', value: pendingTask(taskId, ROOT_CONVERSATION_ID) }], context);
			const mintedBeforeClose = (await storage.mintId<TaskId<JsonValue>>()) as number;
			await storage.close(context);
			// mintId that was never committed must be re-mintable to the same
			// value family: the watermark persists only up to the last COMMIT.
			void mintedBeforeClose;
		}
		{
			const backend = SqliteZstdBackend.open(directory);
			const storage = PiSqliteZstdStorage.open(backend);
			const conversation = await storage.conversation(ROOT_CONVERSATION_ID, context);
			expect(conversation).toEqual({ id: ROOT_CONVERSATION_ID });
			const tasks = await storage.scanTasks({}, 10, undefined, context);
			expect(tasks.items).toHaveLength(1);
			// The watermark covers every committed id: the task id was minted
			// BEFORE the commit, so a reopen mints strictly above it.
			const reminted = (await storage.mintId<TaskId<JsonValue>>()) as number;
			expect(reminted).toBeGreaterThan(tasks.items[0]!.id);
			await storage.close(context);
		}
	});

	it('rolls a rejected commit back without consuming a sequence or leaving entries', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		const headBefore = backend.head;
		const entriesBefore = backend.readDelta(0, 1024 * 1024).length;

		// Duplicate conversation id: the global-ID check rejects the batch.
		await expect(
			storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context),
		).rejects.toThrow(`ID ${ROOT_CONVERSATION_ID} already belongs to conversation`);

		expect(backend.head).toBe(headBefore);
		expect(backend.readDelta(0, 1024 * 1024)).toHaveLength(entriesBefore);

		// The next successful commit takes the very next sequence — a rejected
		// commit consumes nothing.
		const entryId = await storage.mintId<EntryId>();
		const seq = await storage.commit(
			[{ type: 'entry', value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: 'note' } }],
			context,
		);
		expect(seq).toBe(headBefore + 1);
		await storage.close(context);
	});

	it('advances the sequence for an empty commit through a deterministic marker', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		const first = await storage.commit([], context);
		const second = await storage.commit([], context);
		expect(second).toBe(first + 1);
		const marker = backend.getEntry(`pi.commit.${String(second)}`);
		expect(marker?.kind).toBe('pi.commit');
		await storage.close(context);
	});

	it('refuses a second writable storage over the same generation (single writer)', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		expect(() => SqliteZstdBackend.open(directory)).toThrow(OwnerWriteLockError);
		await storage.close(context);
	});

	it('reads a sealed older generation through the adapter after a new generation was opened', async () => {
		const directory = freshDirectory();
		{
			const backend = SqliteZstdBackend.open(directory);
			const storage = PiSqliteZstdStorage.open(backend);
			await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
			const entryId = await storage.mintId<EntryId>();
			await storage.commit(
				[{ type: 'entry', value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: 'user' } }],
				context,
			);
			await storage.close(context);
		}
		// Opening the next generation seals g1...
		const next = SqliteZstdBackend.openNextGeneration(directory);
		expect(next.sealed).toBe(false);
		// ...and the sealed generation stays readable through the adapter.
		const sealed = SqliteZstdBackend.open(directory, { generation: 1 });
		expect(sealed.sealed).toBe(true);
		const reader = PiSqliteZstdStorage.open(sealed);
		const conversation = await reader.conversation(ROOT_CONVERSATION_ID, context);
		expect(conversation).toEqual({ id: ROOT_CONVERSATION_ID });
		const stored = await reader.entry(ROOT_CONVERSATION_ID, (await reader.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1, undefined, context)).items[0]!.id, context);
		expect(stored?.entry.kind).toBe('user');
		// Fail-closed: commits through the sealed generation are refused.
		const entryId = await reader.mintId<EntryId>();
		await expect(
			reader.commit([{ type: 'entry', value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: 'x' } }], context),
		).rejects.toThrow();
		await next.close();
		await sealed.close();
	});

	it('keeps every task replacement version in the zstd log', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		const taskId = await storage.mintId<TaskId<JsonValue>>();
		const first = pendingTask(taskId, ROOT_CONVERSATION_ID);
		await storage.commit([{ type: 'task', value: first }], context);
		const running = { ...first, state: { status: 'running' as const, checkpoint: { phase: 'effect' } } };
		await storage.commit([{ type: 'task', value: running }], context);
		expect(await storage.task(taskId, context)).toEqual(running);
		// Both versions are durable log entries — the audit trail the plan's
		// "records in zstd batches" mandate keeps.
		expect(backend.getEntry(`pi.task.${String(taskId)}.r1`)).toBeDefined();
		expect(backend.getEntry(`pi.task.${String(taskId)}.r2`)).toBeDefined();
		await storage.close(context);
	});
});

function isPiRecordEntryId(id: string): boolean {
	return id.startsWith('pi.') && !id.startsWith('pi.commit.');
}
