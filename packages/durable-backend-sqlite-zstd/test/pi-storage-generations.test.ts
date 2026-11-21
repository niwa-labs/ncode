/**
 * W02-T: generation lifecycle of the pi record substrate
 * ("kill/restart/generation migration", port-plan.md W02-T; u-registry U01).
 *
 * The backend's generations are seal-and-start-empty: `openNextGeneration`
 * seals every older generation (reads stay, writes fail closed) and the new
 * database starts at head 0 — "moving content between generations is the
 * migration's job, not this call's" (backend.ts). This file pins what that
 * contract means for the FULL pi Storage adapter:
 *
 * - a sealed older generation keeps serving every record family through the
 *   adapter (reads), while its commits fail closed (I07: no silent writer);
 * - the new generation is an HONEST fresh pi namespace: no phantom records
 *   leak from the sealed generation, the minted-ID watermark restarts, and
 *   new commits succeed — the boundary a generation-migration owner (later
 *   wave) must build on; nothing silently merges.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	ROOT_CONVERSATION_ID,
	type DocumentCreate,
	type DocumentId,
	type EntryId,
	type Seq,
	type TaskId,
} from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { afterAll, describe, expect, it } from 'vitest';

import { PiSqliteZstdStorage, SqliteZstdBackend } from '../src/index.js';

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];

function freshDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'pi-storage-generations-'));
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

describe('PiSqliteZstdStorage across generations', () => {
	it('serves the sealed generation read-only while the new generation is a fresh honest namespace', async () => {
		const directory = freshDirectory();
		const documentId: DocumentId = 42 as DocumentId; // fresh namespace below reuses it
		const rewindable: DocumentCreate = {
			id: documentId,
			kind: 'conversation.notes',
			scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID },
			history: 'rewindable',
			fork: 'asOf',
		};

		let documentCreatedSeq: Seq | undefined;
		let documentChangedSeq: Seq | undefined;

		// Generation 1: every record family.
		{
			const backend = SqliteZstdBackend.open(directory);
			const storage = PiSqliteZstdStorage.open(backend);
			const entryId = await storage.mintId<EntryId>();
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			const createdBase = await storage.commit(
				[
					{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } },
					{
						type: 'entry',
						value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: 'user', data: { gen: 1 } },
					},
					{
						type: 'task',
						value: {
							id: taskId,
							conversationId: ROOT_CONVERSATION_ID,
							kind: 'test.task',
							version: 1,
							input: {},
							state: { status: 'pending', checkpoint: {} },
							background: false,
							abortRequested: false,
						},
					},
				],
				context,
			);
			expect(backend.generation).toBe(1);
			expect(backend.head).toBeGreaterThanOrEqual(createdBase);
			documentCreatedSeq = await storage.commit(
				[
					{
						type: 'document.create',
						record: rewindable,
						content: { kind: 'base', version: 1, value: { items: ['a'] } },
					},
				],
				context,
			);
			documentChangedSeq = await storage.commit(
				[
					{
						type: 'document.change',
						id: documentId,
						content: { kind: 'delta', version: 1, ops: [['p', ['items'], 1, 0, ['b']]] },
					},
				],
				context,
			);
			await storage.commit(
				[
					{
						type: 'task',
						value: {
							id: taskId,
							conversationId: ROOT_CONVERSATION_ID,
							kind: 'test.task',
							version: 1,
							input: {},
							state: { status: 'running', checkpoint: {} },
							background: false,
							abortRequested: false,
						},
					},
				],
				context,
			);
			expect(backend.generation).toBe(1);
			expect(backend.head).toBeGreaterThanOrEqual(createdBase);
			await storage.close(context);
		}

		// Open the next generation: g1 becomes sealed, g2 starts empty.
		const next = SqliteZstdBackend.openNextGeneration(directory);
		expect(next.sealed).toBe(false);
		expect(next.generation).toBe(2);
		expect(next.head).toBe(0);

		// The sealed generation keeps serving every family read-only.
		const sealedBackend = SqliteZstdBackend.open(directory, { generation: 1 });
		expect(sealedBackend.sealed).toBe(true);
		const sealed = PiSqliteZstdStorage.open(sealedBackend);
		expect(await sealed.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
		const scan = await sealed.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context);
		expect(scan.items).toHaveLength(1);
		expect(scan.items[0]!.data).toEqual({ gen: 1 });
		const documentAtBase = await sealed.document(documentId, documentCreatedSeq!, context);
		expect(documentAtBase?.value).toEqual({ items: ['a'] });
		expect(documentAtBase?.deltasSinceBase).toBe(0);
		expect(Number(documentChangedSeq)).toBeGreaterThan(Number(documentCreatedSeq));
		expect((await sealed.document(documentId, 'current', context))?.value).toEqual({ items: ['a', 'b'] });
		const tasks = await sealed.scanTasks({}, 10, undefined, context);
		expect(tasks.items[0]?.state.status).toBe('running');

		// Commits through the sealed generation fail closed (I07).
		const sealedEntryId = await sealed.mintId<EntryId>();
		await expect(
			sealed.commit(
				[{ type: 'entry', value: { id: sealedEntryId, conversationId: ROOT_CONVERSATION_ID, kind: 'x' } }],
				context,
			),
		).rejects.toThrow();

		// The new generation is an HONEST fresh namespace: nothing leaked.
		const nextStorage = PiSqliteZstdStorage.open(next);
		expect(await nextStorage.conversation(ROOT_CONVERSATION_ID, context)).toBeUndefined();
		expect((await nextStorage.scanConversations({}, 10, undefined, context)).items).toHaveLength(0);
		expect((await nextStorage.scanTasks({}, 10, undefined, context)).items).toHaveLength(0);
		expect(
			(await nextStorage.scanDocuments({ scope: { kind: 'session' } as const, at: 'current' }, 10, undefined, context))
				.items,
		).toHaveLength(0);
		const documentRead = await nextStorage.document(documentId, 'current', context);
		expect(documentRead).toBeUndefined();
		// The watermark restarted: id 2 is mintable again (generation-local
		// namespace — the migration contract, not a collision).
		const minted = (await nextStorage.mintId<EntryId>()) as number;
		expect(minted).toBe(2);

		// New commits succeed on the new generation and restart the backend-local
		// sequence at 1 (documented: the pi Seq here is the backend commit seq).
		const seq = await nextStorage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		expect(seq).toBe(1);
		const g2Entry = await nextStorage.mintId<EntryId>();
		await nextStorage.commit(
			[{ type: 'entry', value: { id: g2Entry, conversationId: ROOT_CONVERSATION_ID, kind: 'user', data: { gen: 2 } } }],
			context,
		);
		expect((await nextStorage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context)).items).toHaveLength(1);

		await nextStorage.close(context);
		await sealed.close(context);
	});
});
