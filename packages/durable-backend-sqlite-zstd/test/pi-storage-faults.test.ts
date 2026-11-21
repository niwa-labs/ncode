/**
 * W02-T: fault injection and rollback beyond the conformance suite, plus the
 * identity-domain separation the plan demands ("rollback/fault-injection, seq
 * gaps/head≠commitSeq", port-plan.md W02-T; u-registry U01).
 *
 * Fault surface exercised here, all against the REAL adapter:
 * - a commit whose document lifecycle fails the IN-TRANSACTION checks (the
 *   `appendBatchWithIndex` hook) rolls back COMPLETELY: no zstd batch, no
 *   index rows, no claimed record ids, no consumed sequence — even when valid
 *   writes of other families ride in the same batch (atomicity of
 *   entries+head+tasks/submissions/document revisions, W02-D);
 * - a batch that exceeds the backend's uncompressed admission cap fails the
 *   same way (nothing durable, sequence not consumed);
 * - `head === seq` holds ONLY as the backend-local commit-sequence equation:
 *   an entry's `commitSeq` is COMMIT order (not EntryId order), a
 *   conversation head is an EntryId pointer of a different domain, and the
 *   adapter's commit sequence is gap-free here (upstream permits gaps — the
 *   stronger invariant; the seam-port side of gap tolerance is proven in
 *   `@mavis/durable-seam` pi-storage-port tests).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Op } from '@earendil-works/chord/delta';
import {
	ROOT_CONVERSATION_ID,
	type DocumentCreate,
	type DocumentId,
	type EntryId,
	type EntryRecord,
	type ConversationId,
} from '@earendil-works/pi-durable';
import { afterAll, describe, expect, it } from 'vitest';

import { PiSqliteZstdStorage, SqliteZstdBackend } from '../src/index.js';

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];

function freshDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'pi-storage-faults-'));
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

function entry(id: EntryId, conversationId: ConversationId, kind = 'note', head?: EntryId): EntryRecord {
	return { id, conversationId, kind, ...(head !== undefined ? { head } : {}) };
}

function rewindableDocument(id: DocumentId, conversationId: ConversationId): DocumentCreate {
	return {
		id,
		kind: 'conversation.notes',
		scope: { kind: 'conversation', conversationId },
		history: 'rewindable',
		fork: 'asOf',
	};
}

/** Counters of every pi index table — the "nothing durable" oracle. */
function indexCounts(backend: SqliteZstdBackend): Record<string, number> {
	const sql = backend.recordIndexSql();
	const tables = ['pi_record_ids', 'pi_conversations', 'pi_entries', 'pi_tasks', 'pi_submissions', 'pi_documents', 'pi_document_revisions'];
	const counts: Record<string, number> = {};
	for (const table of tables) {
		counts[table] = (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { readonly n: number }).n;
	}
	return counts;
}

describe('PiSqliteZstdStorage fault injection and rollback', () => {
	it('rolls a document-lifecycle failure back completely, including valid co-riding writes', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);

		const entryId = await storage.mintId<EntryId>();
		const documentId = await storage.mintId<DocumentId>();
		const before = {
			head: backend.head,
			entries: backend.readDelta(0, 1024 * 1024).length,
			index: indexCounts(backend),
		};

		// `document.change` of an unknown incarnation fails the IN-TRANSACTION
		// check inside the appendBatchWithIndex hook — with a valid entry and a
		// valid task riding in the same batch.
		const ops: Op[] = [['s', ['x'], 1]];
		await expect(
			storage.commit(
				[
					{ type: 'entry', value: entry(entryId, ROOT_CONVERSATION_ID, 'user') },
					{
						type: 'task',
						value: {
							id: await storage.mintId(),
							conversationId: ROOT_CONVERSATION_ID,
							kind: 'test.task',
							version: 1,
							input: {},
							state: { status: 'pending', checkpoint: {} },
							background: false,
							abortRequested: false,
						},
					},
					{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops } },
				],
				context,
			),
		).rejects.toThrow(`Unknown document: ${documentId}`);

		// Nothing durable: no batch content, no index rows, no claimed ids.
		expect(backend.head).toBe(before.head);
		expect(backend.readDelta(0, 1024 * 1024)).toHaveLength(before.entries);
		expect(indexCounts(backend)).toEqual(before.index);

		// The failed commit consumed no sequence and poisoned nothing: the
		// next good commit takes the very next sequence and the entry lands.
		const seq = await storage.commit([{ type: 'entry', value: entry(entryId, ROOT_CONVERSATION_ID, 'user') }], context);
		expect(seq).toBe(before.head + 1);
		expect(await storage.entry(entryId, context)).toMatchObject({ entry: { id: entryId } });
		await storage.close(context);
	});

	it('rolls an in-transaction version-transition failure back the same way', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		const documentId = await storage.mintId<DocumentId>();
		await storage.commit(
			[
				{
					type: 'document.create',
					record: rewindableDocument(documentId, ROOT_CONVERSATION_ID),
					content: { kind: 'base', version: 1, value: { a: 1 } },
				},
			],
			context,
		);
		const before = { head: backend.head, index: indexCounts(backend) };

		// A delta for a version with no stored base fails inside the hook.
		await expect(
			storage.commit(
				[
					{
						type: 'document.change',
						id: documentId,
						content: { kind: 'delta', version: 9, ops: [['s', ['a'], 2]] as Op[] },
					},
				],
				context,
			),
		).rejects.toThrow('version transition requires a base');
		expect(backend.head).toBe(before.head);
		expect(indexCounts(backend)).toEqual(before.index);

		// Two live incarnations at one address also fail in-transaction.
		const secondId = await storage.mintId<DocumentId>();
		await expect(
			storage.commit(
				[
					{
						type: 'document.create',
						record: rewindableDocument(secondId, ROOT_CONVERSATION_ID),
						content: { kind: 'base', version: 1, value: { a: 2 } },
					},
				],
				context,
			),
		).rejects.toThrow('Document address already has a current incarnation');
		expect(backend.head).toBe(before.head);
		expect(indexCounts(backend)).toEqual(before.index);
		await storage.close(context);
	});

	it('refuses an over-cap batch atomically (admission fault, nothing durable)', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory); // default cap: 256 KiB
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		const before = { head: backend.head, index: indexCounts(backend) };

		// One record whose serialized content alone passes the global checks
		// but exceeds the backend's uncompressed batch cap: the commit fails
		// and leaves nothing durable — the controlled refusal, not a partial
		// publish.
		const entryId = await storage.mintId<EntryId>();
		const huge: EntryRecord = {
			id: entryId,
			conversationId: ROOT_CONVERSATION_ID,
			kind: 'user',
			data: { blob: 'x'.repeat(300 * 1024) },
		};
		await expect(storage.commit([{ type: 'entry', value: huge }], context)).rejects.toThrow(
			/batch exceeds the uncompressed cap/,
		);
		expect(backend.head).toBe(before.head);
		expect(indexCounts(backend)).toEqual(before.index);
		expect(await storage.entry(entryId, context)).toBeUndefined();

		// The adapter itself is unpoisoned: the next in-cap commit succeeds.
		const smallSeq = await storage.commit([{ type: 'entry', value: entry(entryId, ROOT_CONVERSATION_ID) }], context);
		expect(smallSeq).toBe(before.head + 1);
		await storage.close(context);
	});
});

describe('PiSqliteZstdStorage identity domains: commitSeq vs EntryId vs head', () => {
	it('commitSeq is COMMIT order, never EntryId order (head≠commitSeq non-universality)', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);

		// Mint two ids; commit the HIGHER id first, the lower id second.
		const lowId = await storage.mintId<EntryId>();
		const highId = await storage.mintId<EntryId>();
		const firstSeq = await storage.commit([{ type: 'entry', value: entry(highId, ROOT_CONVERSATION_ID) }], context);
		const secondSeq = await storage.commit([{ type: 'entry', value: entry(lowId, ROOT_CONVERSATION_ID) }], context);

		expect(highId).toBeGreaterThan(lowId);
		expect(secondSeq).toBeGreaterThan(firstSeq);
		// The LOWER EntryId carries the HIGHER commitSeq: the two orders are
		// genuinely different domains, and no consumer may equate them.
		const low = await storage.entry(lowId, context);
		const high = await storage.entry(highId, context);
		expect(low?.commitSeq).toBe(secondSeq);
		expect(high?.commitSeq).toBe(firstSeq);
		expect(low!.commitSeq).toBeGreaterThan(high!.commitSeq);

		// Reads are EntryId-ordered regardless of commit order.
		const scan = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context);
		expect(scan.items.map((record) => record.id)).toEqual([highId, lowId]);
		await storage.close(context);
	});

	it('a conversation head is an EntryId pointer, never the commit sequence', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);

		const firstId = await storage.mintId<EntryId>();
		const markerId = await storage.mintId<EntryId>();
		await storage.commit([{ type: 'entry', value: entry(firstId, ROOT_CONVERSATION_ID) }], context);
		const markerSeq = await storage.commit(
			[{ type: 'entry', value: entry(markerId, ROOT_CONVERSATION_ID, 'marker', firstId) }],
			context,
		);

		const marker = await storage.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context);
		expect(marker?.id).toBe(markerId);
		// The head points at the FIRST entry — an EntryId of another domain —
		// and differs from the marker's own commit sequence.
		expect(marker?.head).toBe(firstId);
		expect(marker!.head).not.toBe(markerSeq);
		expect(marker!.head).toBeLessThan(markerSeq);
		await storage.close(context);
	});

	it('keeps the backend-local commit sequence strictly gap-free (the documented stronger invariant)', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		let previous = await storage.commit([], context); // empty commits count too
		for (let index = 0; index < 5; index += 1) {
			const entryId = await storage.mintId<EntryId>();
			const seq = await storage.commit([{ type: 'entry', value: entry(entryId, ROOT_CONVERSATION_ID) }], context);
			expect(seq).toBe(previous + 1);
			previous = seq;
		}
		// A rejected commit between two good ones consumes nothing.
		await expect(
			storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context),
		).rejects.toThrow();
		const entryId = await storage.mintId<EntryId>();
		const afterRejection = await storage.commit(
			[{ type: 'entry', value: entry(entryId, ROOT_CONVERSATION_ID) }],
			context,
		);
		expect(afterRejection).toBe(previous + 1);
		await storage.close(context);
	});
});
