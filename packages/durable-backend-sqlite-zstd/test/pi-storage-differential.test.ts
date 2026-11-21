/**
 * W02-T: DIFFERENTIAL storage conformance — "pi storage conformance против
 * memory/reference и sqlite-zstd" (port-plan.md W02-T row, u-registry U01).
 *
 * The upstream suite (`pi-storage-conformance.test.ts`) proves our adapter
 * satisfies every pinned case on its own. This file adds the second half of
 * the W02-T wording: the SAME scripted operation sequence — record families,
 * multiple conversations, fork visibility, task phases, submissions,
 * rewindable documents with as-of/retire/incarnation swaps, cursors, and the
 * pinned error texts — runs against BOTH the vendored reference
 * `MemoryStorage` (pin `48c8f3228`) and OUR `PiSqliteZstdStorage`, and every
 * recorded outcome must be structurally identical: same records, same pages,
 * same opaque cursors, same commit sequences, same error messages.
 *
 * The scenario intentionally re-uses the pinned conformance suite's shapes
 * (its `entry`/task/submission/document fixtures) so the differential run
 * exercises exactly the semantics the pin defines — nothing invented here.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import type { Op } from '@earendil-works/chord/delta';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import {
	ROOT_CONVERSATION_ID,
	type ConversationId,
	type DocumentCreate,
	type DocumentId,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	type Seq,
	type Storage,
	type StorageWrite,
	type SubmissionId,
	type TaskId,
} from '@earendil-works/pi-durable';
import { afterAll, describe, expect, it } from 'vitest';

import { PiSqliteZstdStorage, SqliteZstdBackend } from '../src/index.js';

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];

afterAll(() => {
	for (const directory of directories) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort; the OS temp root is wiped anyway.
		}
	}
});

// ---------------------------------------------------------------------------
// Trace machinery: every step records its outcome (or its pinned error text)
// ---------------------------------------------------------------------------

type TraceEntry = { readonly label: string; readonly result: unknown } | { readonly label: string; readonly threw: string };

class Trace {
	readonly entries: TraceEntry[] = [];

	async attempt<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
		try {
			const value = await run();
			this.entries.push({ label, result: serialize(value) });
			return value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// The close-error text is implementation-local (the pin's own suite
			// asserts only the substring "closed"); normalize it so the trace
			// compares the CONTRACT, not the wording.
			const normalized = /is closed$/.test(message) ? '<storage is closed>' : message;
			this.entries.push({ label, threw: normalized });
			return undefined;
		}
	}
}

/** JSON-normalize an outcome so branded numbers compare as plain numbers. */
function serialize(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value ?? null)) as unknown;
}

// ---------------------------------------------------------------------------
// Fixtures (the pinned conformance suite's shapes)
// ---------------------------------------------------------------------------

function entry(id: EntryId, conversationId: ConversationId, kind = 'note', extra?: { head?: EntryId }): EntryRecord {
	return { id, conversationId, kind, ...(extra?.head !== undefined ? { head: extra.head } : {}) };
}

function pendingTask(id: TaskId<JsonValue>, conversationId: ConversationId) {
	return {
		id,
		conversationId,
		kind: 'test.task',
		version: 1,
		input: { value: Number(id) },
		state: { status: 'pending' as const, checkpoint: { phase: 'ready' } },
		background: false,
		abortRequested: false,
	};
}

// ---------------------------------------------------------------------------
// The scenario: one script, two storages, byte-identical traces required
// ---------------------------------------------------------------------------

async function scenario(storage: Storage): Promise<TraceEntry[]> {
	// The chord-era Storage protocol (pi-durable 1.5.2) takes a SERIES of
	// batches plus a receive callback and reports refusals as data. The pinned
	// scenario speaks the flat single-batch protocol where a refusal THROWS
	// with the pinned message — adapt one batch per call so both storages run
	// the identical script and the trace keeps its original shapes.
	const commitFlat = async (writes: readonly StorageWrite[]): Promise<Seq> => {
		let seq: Seq | undefined;
		const result = await commitFlat([writes], (_index, received) => {
			seq = received;
		}, context);
		if (result.refused !== undefined) {
			throw result.refused instanceof Error
				? result.refused
				: new Error(String(result.refused));
		}
		if (seq === undefined) throw new Error('the commit stored no batch');
		return seq;
	};
	const trace = new Trace();

	await trace.attempt('mint: first id is 2 (root reserved)', () => storage.mintId<ConversationId>());
	await trace.attempt('root conversation commit', () =>
		commitFlat([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context),
	);
	await trace.attempt('root conversation read', () => storage.conversation(ROOT_CONVERSATION_ID, context));
	await trace.attempt('duplicate root conversation is rejected', () =>
		commitFlat([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context),
	);
	await trace.attempt('unknown conversation entry scan is rejected', () =>
		storage.scanEntries({ conversationId: 9999 as ConversationId }, 10, undefined, context),
	);

	// --- multiple conversations with durable owner edges -------------------
	const ownerTaskId = (await trace.attempt('mint owner task id', () => storage.mintId<TaskId<JsonValue>>())) as TaskId<JsonValue>;
	const childConversationId = (await trace.attempt(
		'mint child conversation id',
		() => storage.mintId<ConversationId>(),
	)) as ConversationId;
	await trace.attempt('owner conversation commit', () =>
		commitFlat([
			{
				type: 'conversation',
				value: {
					id: childConversationId,
					owner: { conversationId: ROOT_CONVERSATION_ID, taskId: ownerTaskId },
				},
			},
		], context),
	);
	await trace.attempt('scan conversations by owner task', () =>
		storage.scanConversations({ ownerTaskId }, 10, undefined, context),
	);
	await trace.attempt('scan conversations by owner conversation', () =>
		storage.scanConversations({ ownerConversationId: ROOT_CONVERSATION_ID }, 10, undefined, context),
	);

	// --- entries committed out of ID order + head markers + cursors --------
	const rootFirst = (await trace.attempt('mint rootFirst', () => storage.mintId<EntryId>())) as EntryId;
	const rootForkPoint = (await trace.attempt('mint rootForkPoint', () => storage.mintId<EntryId>())) as EntryId;
	const rootExcludedSameCommit = (await trace.attempt(
		'mint rootExcludedSameCommit',
		() => storage.mintId<EntryId>(),
	)) as EntryId;
	await trace.attempt('root entries commit (out of ID order inside one commit)', () =>
		commitFlat(
			[
				{ type: 'entry', value: entry(rootFirst, ROOT_CONVERSATION_ID) },
				{ type: 'entry', value: entry(rootForkPoint, ROOT_CONVERSATION_ID, 'marker', { head: rootFirst }) },
				{ type: 'entry', value: entry(rootExcludedSameCommit, ROOT_CONVERSATION_ID) },
			],
			context,
		),
	);
	await trace.attempt('root scan newest-first', () =>
		storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context),
	);
	await trace.attempt('root latest head marker', () =>
		storage.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context),
	);
	await trace.attempt('root scan ascending through the fork chain', () =>
		storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: 'ascending' }, 2, undefined, context),
	);

	// --- fork: child sees the ancestor prefix up to the fork point ---------
	const forkedId = (await trace.attempt('mint fork conversation', () => storage.mintId<ConversationId>())) as ConversationId;
	await trace.attempt('fork conversation commit', () =>
		commitFlat([
			{
				type: 'conversation',
				value: { id: forkedId, parent: { conversationId: ROOT_CONVERSATION_ID, at: rootForkPoint } },
			},
		], context),
	);
	const forkEntry = (await trace.attempt('mint fork entry', () => storage.mintId<EntryId>())) as EntryId;
	await trace.attempt('fork entry commit', () =>
		commitFlat([{ type: 'entry', value: entry(forkEntry, forkedId, 'user') }], context),
	);
	await trace.attempt('fork scan newest-first through the ancestor cap', () =>
		storage.scanEntries({ conversationId: forkedId }, 10, undefined, context),
	);
	await trace.attempt('fork scan ascending through the ancestor cap', () =>
		storage.scanEntries({ conversationId: forkedId, order: 'ascending' }, 10, undefined, context),
	);
	await trace.attempt('entry of the forked conversation resolves with its commit seq', () =>
		storage.entry(forkEntry, context),
	);
	await trace.attempt('excluded ancestor entry is invisible through the fork', () =>
		storage.entry(forkedId, rootExcludedSameCommit, context),
	);

	// --- task phases (complete replacement records) ------------------------
	const taskId = (await trace.attempt('mint task id', () => storage.mintId<TaskId<JsonValue>>())) as TaskId<JsonValue>;
	await trace.attempt('task pending commit', () =>
		commitFlat([{ type: 'task', value: pendingTask(taskId, ROOT_CONVERSATION_ID) }], context),
	);
	const running = { ...pendingTask(taskId, ROOT_CONVERSATION_ID), state: { status: 'running' as const, checkpoint: { phase: 'effect' } } };
	await trace.attempt('task running replacement', () => commitFlat([{ type: 'task', value: running }], context));
	await trace.attempt('task read after replacement', () => storage.task(taskId, context));
	await trace.attempt('scan tasks by status running', () =>
		storage.scanTasks({ status: 'running' }, 10, undefined, context),
	);
	await trace.attempt('scan tasks by status pending after replacement', () =>
		storage.scanTasks({ status: 'pending' }, 10, undefined, context),
	);
	const terminal = {
		...pendingTask(taskId, ROOT_CONVERSATION_ID),
		state: { status: 'terminal' as const, outcome: { status: 'completed' as const, result: { done: true } } },
	};
	await trace.attempt('task terminal replacement', () => commitFlat([{ type: 'task', value: terminal }], context));
	await trace.attempt('scan tasks by kind', () =>
		storage.scanTasks({ kind: 'test.task' }, 10, undefined, context),
	);

	// --- submissions --------------------------------------------------------
	const submissionId = (await trace.attempt('mint submission id', () => storage.mintId<SubmissionId>())) as SubmissionId;
	const answerEntryId = (await trace.attempt('mint answer entry id', () => storage.mintId<EntryId>())) as EntryId;
	await trace.attempt('submission placed commit', () =>
		commitFlat([
			{
				type: 'submission',
				value: {
					id: submissionId,
					conversationId: ROOT_CONVERSATION_ID,
					requestId: 'request-1',
					type: 'input',
					status: 'placed',
					entry: answerEntryId,
				},
			},
			{ type: 'entry', value: entry(answerEntryId, ROOT_CONVERSATION_ID, 'user') },
		], context),
	);
	await trace.attempt('submission by request', () =>
		storage.submissionByRequest(ROOT_CONVERSATION_ID, 'request-1', context),
	);
	const doneEntryId = (await trace.attempt('mint done entry id', () => storage.mintId<EntryId>())) as EntryId;
	await trace.attempt('submission done replacement + entry', () =>
		commitFlat([
			{
				type: 'submission',
				value: {
					id: submissionId,
					conversationId: ROOT_CONVERSATION_ID,
					requestId: 'request-1',
					type: 'input',
					status: 'done',
					entry: answerEntryId,
					answer: doneEntryId,
				},
			},
			{ type: 'entry', value: entry(doneEntryId, ROOT_CONVERSATION_ID, 'assistant') },
		], context),
	);
	await trace.attempt('scan submissions by conversation', () =>
		storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context),
	);
	await trace.attempt('scan submissions by status placed (gone after done)', () =>
		storage.scanSubmissions({ status: 'placed' }, 10, undefined, context),
	);

	// --- rewindable documents: base, delta, as-of, retire, incarnation -----
	const documentId = (await trace.attempt('mint document id', () => storage.mintId<DocumentId>())) as DocumentId;
	const documentRecord: DocumentCreate = {
		id: documentId,
		kind: 'conversation.notes',
		scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID },
		history: 'rewindable',
		fork: 'asOf',
	};
	const createdAt = (await trace.attempt('document create base', () =>
		commitFlat(
			[
				{
					type: 'document.create',
					record: documentRecord,
					content: { kind: 'base', version: 1, value: { items: ['a'], nested: { count: 1 } } },
				},
			],
			context,
		),
	)) as Seq;
	const ops: Op[] = [
		['p', ['items'], 1, 0, ['b']],
		['s', ['nested', 'count'], 2],
	];
	const changedAt = (await trace.attempt('document delta change', () =>
		commitFlat([{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops } }], context),
	)) as Seq;
	await trace.attempt('document as-of created', () => storage.document(documentId, createdAt, context));
	await trace.attempt('document as-of changed', () => storage.document(documentId, changedAt, context));
	await trace.attempt('document current', () => storage.document(documentId, 'current', context));
	await trace.attempt('document delta without base version is rejected', () =>
		commitFlat(
			[{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 7, ops } }],
			context,
		),
	);
	const secondDocumentId = (await trace.attempt(
		'mint second document id',
		() => storage.mintId<DocumentId>(),
	)) as DocumentId;
	const retiredAt = (await trace.attempt('document retire + recreate at the same address', () =>
		commitFlat(
			[
				{
					type: 'document.create',
					record: { ...documentRecord, id: secondDocumentId },
					content: { kind: 'base', version: 1, value: { items: ['new'] } },
				},
				{ type: 'document.retire', id: documentId },
			],
			context,
		),
	)) as Seq;
	await trace.attempt('findDocument as-of before the swap returns the first incarnation', () =>
		storage.findDocument({ kind: documentRecord.kind, scope: documentRecord.scope }, changedAt, context),
	);
	await trace.attempt('findDocument as-of after the swap returns the second incarnation', () =>
		storage.findDocument({ kind: documentRecord.kind, scope: documentRecord.scope }, retiredAt, context),
	);
	await trace.attempt('findDocument current returns the second incarnation', () =>
		storage.findDocument({ kind: documentRecord.kind, scope: documentRecord.scope }, 'current', context),
	);
	await trace.attempt('scanDocuments at the pre-swap point', () =>
		storage.scanDocuments({ scope: documentRecord.scope, at: changedAt }, 10, undefined, context),
	);
	await trace.attempt('retired document as-of its own retirement is undefined', () =>
		storage.document(documentId, retiredAt, context),
	);
	await trace.attempt('second document current value', () =>
		storage.document(secondDocumentId, 'current', context),
	);

	// --- document fork (copy) ----------------------------------------------
	const copiedDocumentId = (await trace.attempt(
		'mint copied document id',
		() => storage.mintId<DocumentId>(),
	)) as DocumentId;
	await trace.attempt('document copy forks the rewindable source', () =>
		commitFlat(
			[
				{
					type: 'document.copy',
					record: { ...documentRecord, id: copiedDocumentId },
					source: { id: documentId, at: changedAt },
				},
			],
			context,
		),
	);
	await trace.attempt('copied document materializes the source as-of value', () =>
		storage.document(copiedDocumentId, 'current', context),
	);

	// --- empty commit, exhaustion guard, close -----------------------------
	await trace.attempt('empty commit still advances the sequence', () => commitFlat([], context));
	await trace.attempt('closed conversation read before close still works', () =>
		storage.conversation(ROOT_CONVERSATION_ID, context),
	);
	await trace.attempt('close', () => storage.close(context));
	await trace.attempt('commit after close is rejected', () =>
		commitFlat([{ type: 'conversation', value: { id: 4242 as ConversationId } }], context),
	);

	return trace.entries;
}

describe('PiSqliteZstdStorage differential conformance vs the pinned MemoryStorage reference', () => {
	it('produces identical outcomes for the whole scripted scenario', async () => {
		const reference = await scenario(
			// Brand-only structural bridge (same pattern as the seam/worker tests):
			// runtime shapes identical; the two declaration trees are nominally apart.
			new MemoryStorage() as unknown as Storage,
		);

		const directory = mkdtempSync(join(tmpdir(), 'pi-storage-differential-'));
		directories.push(directory);
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		const ours = await scenario(storage);

		expect(ours).toEqual(reference);
	}, 30_000);
});
