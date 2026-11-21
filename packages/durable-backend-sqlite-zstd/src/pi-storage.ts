/**
 * Full pi `Storage` adapter over the sqlite-zstd durable backend (W02 part A).
 *
 * Implements the pinned upstream interface (`@earendil-works/pi-durable`
 * `Storage`, pin `48c8f3228`) with our stack as the substrate:
 *
 * - record CONTENT of every family (conversations, entries, tasks,
 *   submissions, documents — including every task/submission replacement and
 *   every retirement) rides the backend's zstd batches as `pi.*` entries, so
 *   the single-writer fencing, WAL `synchronous = FULL` durability, codec,
 *   generations, and resume capsule of the backend all apply to pi records
 *   unchanged (port plan §2.4.1 "хранение records в наших zstd batches");
 * - SECONDARY INDEXES and the document revision history live in SQL tables of
 *   the same `sessions.gN.db` file (`pi-schema.ts`), written by the
 *   `appendBatchWithIndex` hook INSIDE the commit transaction — one atomic
 *   transaction covers log, indexes, document revisions and record state, and
 *   a rejected commit leaves neither batch nor index behind;
 * - the pi `Seq` is the backend's GLOBAL commit sequence — one counter
 *   shared by EVERY writer on the storage: pi records, the mcode worker
 *   batches that ride the same backend, and seed imports all commit through
 *   it, so gaps are the NORM under mixed use, not an anomaly (a log that
 *   happens to be single-writer is gap-free only for as long as it stays
 *   the sole writer). Upstream explicitly permits gaps, so they are legal
 *   here too — never assume `seq === index + 1` (port plan §4 D: drop the
 *   false universality of `head === seq` — the pi conversation head is an
 *   `EntryId` pointer domain, see `@mavis/durable-core` `pi-domains.ts`).
 *
 * Semantics mirror the pinned `SqliteStorage` one-to-one (global record-ID
 * namespace with immutable conversation/entry/document creation, complete
 * task/submission record replacement, fork-aware entry visibility through
 * ancestor caps, head markers, document incarnations with as-of reads and
 * chord-delta materialization, cursor-carried scan order,
 * `StorageRequestError` for invalid reads with no durable effect). The
 * upstream conformance suite (`@earendil-works/pi-durable/testing`
 * `createStorageConformance`) is run against this adapter in
 * `test/pi-storage-conformance.test.ts`.
 *
 * Logging: no adapter-local events — every commit is the backend's own batch
 * commit and is logged by the backend under the spec'd `mcode:storage`
 * events; nothing here changes correctness or the logging contract.
 *
 * @module
 */

import type { Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import { apply, type Op } from '@earendil-works/chord/delta';
import {
	StorageRequestError,
	type CommitResult,
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	type DocumentAddress,
	type DocumentContent,
	type DocumentCreate,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Id,
	type JsonObject,
	type Page,
	type ScanOrder,
	type Seq,
	type Storage,
	type StorageWrite,
	type StoredDocument,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskQuery,
	type TaskRecord,
} from '@earendil-works/pi-durable';

import { SqliteZstdBackend, type RecordIndexSql, type SqliteStatement } from './backend.js';
import {
	PI_COMMIT_MARKER_KIND,
	PI_RECORD_ENTRY_KIND,
	piCommitMarkerEntryId,
	piImmutableEntryId,
	piVersionedEntryId,
} from './pi-ids.js';
import { PI_INDEX_SCHEMA_SQL, PI_NEXT_ID_META_KEY, encodeIndexedString } from './pi-schema.js';
import type { EntryDraft } from './types.js';

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = 'conversation' | 'entry' | 'task' | 'submission' | 'document';
type RecordIdRow = { readonly record_type: TableName };
type IdRow = { readonly id: number };
type RevisionRow = {
	readonly seq: number;
	readonly kind: 'base' | 'delta';
	readonly version: number;
	readonly content: string;
};
type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: 'document.copy' }>['source'];
	content?: DocumentContent;
	retire: boolean;
};

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value) as string;

/** Apply the erased ID brand at a trusted numeric SQL boundary (mirrors upstream `ids.ts`). */
function idFromNumber<I extends Id<string>>(value: number): I {
	return value as I;
}

/** Apply the erased commit-sequence brand at a trusted storage boundary. */
function seqFromNumber(value: number): Seq {
	return value as Seq;
}

// ---------------------------------------------------------------------------
// Scan cursors (mirrors the pinned `storage/scan.ts`, which is not exported
// by the vendored package): a cursor carries its order and the last ID served.
// ---------------------------------------------------------------------------

type ScanStart = { readonly order: ScanOrder; readonly after: number | undefined };

function scanStart(requested: ScanOrder | undefined, cursor: Cursor | undefined, fallback: ScanOrder): ScanStart {
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor;
	if (typeof after !== 'number' || !Number.isSafeInteger(after)) throw new StorageRequestError('Invalid storage cursor');
	if (stored !== undefined && stored !== 'ascending' && stored !== 'descending') {
		throw new StorageRequestError('Invalid storage cursor');
	}
	const order = (stored ?? fallback) as ScanOrder;
	if (requested !== undefined && requested !== order) {
		throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	}
	return { order, after };
}

function nextCursor(id: Id<string>, order: ScanOrder): Cursor {
	return { after: id, order };
}

function cursorId<I extends Id<string>>(cursor: Cursor | undefined): I | undefined {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== 'number' || !Number.isSafeInteger(after)) throw new StorageRequestError('Invalid storage cursor');
	return after as I;
}

function page<T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder = 'ascending',
): Page<T, Cursor> {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: nextCursor(items[items.length - 1]!.id, order) };
}

/** The ID condition, its parameter, and the `ORDER BY` direction of a table scan. */
function scanSql(start: ScanStart): { readonly clause: string; readonly param: number; readonly direction: 'ASC' | 'DESC' } {
	return start.order === 'ascending'
		? { clause: 'id > ?', param: start.after ?? -1, direction: 'ASC' }
		: { clause: 'id < ?', param: start.after ?? Number.MAX_SAFE_INTEGER, direction: 'DESC' };
}

// ---------------------------------------------------------------------------
// Document address / scope helpers (mirror the pin)
// ---------------------------------------------------------------------------

type ScopeColumns = { readonly scopeKind: DocumentRecord['scope']['kind']; readonly ownerId: number };

function scopeColumns(scope: DocumentRecord['scope']): ScopeColumns {
	switch (scope.kind) {
		case 'session':
			return { scopeKind: 'session', ownerId: 0 };
		case 'conversation':
			return { scopeKind: 'conversation', ownerId: scope.conversationId };
		case 'task':
			return { scopeKind: 'task', ownerId: scope.taskId };
	}
}

function addressParts(address: DocumentAddress | DocumentCreate | DocumentRecord) {
	const scope = scopeColumns(address.scope);
	return {
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ''),
	};
}

function addressKey(address: DocumentAddress | DocumentCreate | DocumentRecord): string {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
}

function isAliveAt(record: DocumentRecord, at: DocumentPoint): boolean {
	if (at === 'current') return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
}

function isCurrentOnly(record: DocumentRecord): boolean {
	return record.scope.kind !== 'conversation' || record.history === 'latest';
}

function writeId(write: StorageWrite): Id<string> | undefined {
	switch (write.type) {
		case 'conversation':
		case 'entry':
		case 'task':
		case 'submission':
			return write.value.id;
		case 'document.create':
		case 'document.copy':
			return write.record.id;
		case 'document.change':
		case 'document.retire':
			return undefined;
	}
}

/**
 * Full pi Storage over one open {@link SqliteZstdBackend}. The adapter does
 * not open database files itself: pass a backend opened on the durable root
 * (or a sealed older generation for read-only access — commits then fail with
 * the backend's `SealedGenerationError`, fail-closed as required).
 */
export class PiSqliteZstdStorage implements Storage {
	private readonly backend: SqliteZstdBackend;
	private readonly sql: RecordIndexSql;
	private nextId: number;
	private closed = false;
	private closing: Promise<void> | undefined;
	private admittedReads = 0;
	private readsDrained: (() => void) | undefined;

	// Prepared once per adapter (reused by every read; usable inside the
	// backend's commit transactions — same connection).
	private readonly metaGetStmt: SqliteStatement;
	private readonly claimIdPrefix = 'INSERT OR IGNORE INTO pi_record_ids (id, record_type) VALUES ' as const;

	private constructor(backend: SqliteZstdBackend, nextId: number) {
		this.backend = backend;
		this.sql = backend.recordIndexSql();
		this.nextId = nextId;
		this.metaGetStmt = this.sql.prepare('SELECT value FROM meta WHERE key = ?');
	}

	/** Initialize the pi record-index schema over an open backend and read the ID watermark. */
	static open(backend: SqliteZstdBackend): PiSqliteZstdStorage {
		const sql = backend.recordIndexSql();
		if (!backend.sealed) sql.exec(PI_INDEX_SCHEMA_SQL);
		const row = sql.prepare(`SELECT value FROM meta WHERE key = '${PI_NEXT_ID_META_KEY}'`).get() as
			| { readonly value?: unknown }
			| undefined;
		let nextId = 2; // ID 1 is the reserved root conversation (ROOT_CONVERSATION_ID)
		if (row?.value !== undefined) {
			const parsed = Number(row.value);
			if (!Number.isFinite(parsed) || parsed < 2) {
				throw new Error(`Invalid pi next-id watermark: ${String(row.value)}`);
			}
			nextId = parsed;
		}
		return new PiSqliteZstdStorage(backend, nextId);
	}

	// ---------------------------------------------------------------------------
	// Commit
	// ---------------------------------------------------------------------------

	commit(writes: readonly StorageWrite[], context?: Context): Promise<Seq>;
	commit(batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, context: Context): Promise<CommitResult>;
	async commit(
		writesOrBatches: readonly StorageWrite[] | readonly (readonly StorageWrite[])[],
		contextOrReceive?: Context | ((index: number, seq: Seq) => void),
		_context?: Context,
	): Promise<Seq | CommitResult> {
		this.assertOpen();
		if (typeof contextOrReceive !== 'function') return this.commitSingle(writesOrBatches as readonly StorageWrite[]);
		const receipts: Seq[] = [];
		let refused: unknown;
		try {
			for (const writes of writesOrBatches as readonly (readonly StorageWrite[])[]) {
				// Expected validation refusals have no durable effect and do not fail
				// the Session. Failures inside commitSingle remain unknown/fatal.
				try {
					this.assertOpen();
					this.checkGlobalIds(this.sql, writes);
					this.checkDocumentActions(this.sql, prepareDocumentActions(writes));
				} catch (error) { refused = error; break; }
				receipts.push(await this.commitSingle(writes));
			}
		} finally {
			for (let index = 0; index < receipts.length; index++) contextOrReceive(index, receipts[index]!);
		}
		return { stored: receipts.length, ...(refused !== undefined ? { refused } : {}) };
	}

	private async commitSingle(writes: readonly StorageWrite[]): Promise<Seq> {
		this.assertOpen();
		const documentActions = prepareDocumentActions(writes);
		const candidateNextId = this.candidateNextId(writes);
		// Deterministic under the single writer: the next sequence is the
		// durable head + 1, and the backend re-asserts the head inside the
		// commit transaction (a diverged head fails the whole commit).
		const expectedSeq = this.backend.head + 1;
		const plan = this.planCommit(writes, documentActions, expectedSeq);
		// Global record-ID check BEFORE the durable attempt: the content entry
		// of a duplicate record id would otherwise hit the backend's entry-id
		// uniqueness first and report the wrong (log-level) error. Equivalent
		// to the in-transaction check under the single writer; the hook below
		// re-runs it inside the transaction as the fenced authority.
		this.checkGlobalIds(this.sql, writes);
		const commit = await this.backend.appendBatchWithIndex(plan.drafts, (sql, { seq }) => {
			if (seq !== expectedSeq) {
				throw new Error(`pi commit planned for seq ${expectedSeq} but the commit took ${seq}; refusing to write indexes`);
			}
			this.checkGlobalIds(sql, writes);
			this.checkDocumentActions(sql, documentActions);
			const piSeq = seqFromNumber(seq);
			for (const write of writes) this.applyTableWrite(sql, write, piSeq, plan);
			this.applyDocumentActions(sql, documentActions, piSeq, plan);
			sql.prepare(
				'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
			).run(PI_NEXT_ID_META_KEY, String(Math.max(this.nextId, candidateNextId)));
		});
		this.nextId = Math.max(this.nextId, candidateNextId);
		return seqFromNumber(commit.seq);
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error('ID space is exhausted');
		return idFromNumber<I>(this.nextId++);
	}

	// ---------------------------------------------------------------------------
	// Reads: conversations
	// ---------------------------------------------------------------------------

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		return this.hydrateConversation(id);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, 'ascending');
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: unknown[] = [scan.param];
		if (query.ownerConversationId !== undefined) {
			clauses.push('owner_conversation_id = ?');
			params.push(query.ownerConversationId);
		}
		if (query.ownerTaskId !== undefined) {
			clauses.push('owner_task_id = ?');
			params.push(query.ownerTaskId);
		}
		params.push(limit + 1);
		const rows = this.sql
			.prepare(`SELECT id FROM pi_conversations WHERE ${clauses.join(' AND ')} ORDER BY id ${scan.direction} LIMIT ?`)
			.all(...params) as Array<{ readonly id: number }>;
		const values: ConversationRecord[] = [];
		for (const row of rows) {
			const record = this.hydrateConversation(idFromNumber<ConversationId>(row.id));
			if (record !== undefined) values.push(record);
		}
		return page(values, limit, start.order);
	}

	// ---------------------------------------------------------------------------
	// Reads: entries (fork-aware)
	// ---------------------------------------------------------------------------

	async entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	async entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	async entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		return this.admitRead(() => this.readEntry(idOrConversationId, idOrContext, context));
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.admitRead(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}

	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.admitRead(() => this.readEntries(query, limit, cursor));
	}

	// ---------------------------------------------------------------------------
	// Reads: tasks and submissions
	// ---------------------------------------------------------------------------

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		return this.hydrateTask(id);
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, 'ascending');
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: unknown[] = [scan.param];
		if (query.conversationId !== undefined) {
			clauses.push('conversation_id = ?');
			params.push(query.conversationId);
		}
		if (query.kind !== undefined) {
			clauses.push('kind = ?');
			params.push(encodeIndexedString(query.kind));
		}
		if (query.status !== undefined) {
			clauses.push('status = ?');
			params.push(query.status);
		}
		if (query.abortRequested !== undefined) {
			clauses.push('abort_requested = ?');
			params.push(query.abortRequested ? 1 : 0);
		}
		if (query.background !== undefined) {
			clauses.push('background = ?');
			params.push(query.background ? 1 : 0);
		}
		params.push(limit + 1);
		const rows = this.sql
			.prepare(`SELECT id FROM pi_tasks WHERE ${clauses.join(' AND ')} ORDER BY id ${scan.direction} LIMIT ?`)
			.all(...params) as Array<{ readonly id: number }>;
		const values: StoredTask[] = [];
		for (const row of rows) {
			const record = this.hydrateTask(idFromNumber<TaskId>(row.id));
			if (record !== undefined) values.push(record);
		}
		return page(values, limit, start.order);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		return this.hydrateSubmission(id);
	}

	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, 'ascending');
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: unknown[] = [scan.param];
		if (query.conversationId !== undefined) {
			clauses.push('conversation_id = ?');
			params.push(query.conversationId);
		}
		if (query.status !== undefined) {
			clauses.push('status = ?');
			params.push(query.status);
		}
		params.push(limit + 1);
		const rows = this.sql
			.prepare(`SELECT id FROM pi_submissions WHERE ${clauses.join(' AND ')} ORDER BY id ${scan.direction} LIMIT ?`)
			.all(...params) as Array<{ readonly id: number }>;
		const values: SubmissionRecord[] = [];
		for (const row of rows) {
			const record = this.hydrateSubmission(idFromNumber<SubmissionId>(row.id));
			if (record !== undefined) values.push(record);
		}
		return page(values, limit, start.order);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = this.sql
			.prepare('SELECT id FROM pi_submissions WHERE conversation_id = ? AND request_id = ?')
			.get(conversationId, encodeIndexedString(requestId)) as { readonly id: number } | undefined;
		return row === undefined ? undefined : this.hydrateSubmission(idFromNumber<SubmissionId>(row.id));
	}

	// ---------------------------------------------------------------------------
	// Reads: documents
	// ---------------------------------------------------------------------------

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const parts = addressParts(address);
		const sql =
			at === 'current'
				? `SELECT id FROM pi_documents
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
				: `SELECT id FROM pi_documents
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
					ORDER BY created_at DESC LIMIT 1`;
		const params: unknown[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
		if (at !== 'current') params.push(at, at);
		const row = this.sql.prepare(sql).get(...params) as { readonly id: number } | undefined;
		return row === undefined ? undefined : this.hydrateDocumentRecord(idFromNumber<DocumentId>(row.id));
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		// The record and revision queries must observe one committed state; a
		// commit between them can replace the base (single connection, one
		// transaction — the backend serializes commits on this writer).
		return this.readDocumentMaterialized(id, at);
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const scope = scopeColumns(query.scope);
		const clauses = ['scope_kind = ?', 'owner_id = ?', 'id > ?'];
		const params: unknown[] = [scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
		if (query.kind !== undefined) {
			clauses.push('kind = ?');
			params.push(encodeIndexedString(query.kind));
		}
		if (query.at === 'current') {
			clauses.push('retired_at IS NULL');
		} else {
			clauses.push('created_at <= ?', '(retired_at IS NULL OR retired_at > ?)');
			params.push(query.at, query.at);
		}
		params.push(limit + 1);
		const rows = this.sql
			.prepare(`SELECT id FROM pi_documents WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`)
			.all(...params) as Array<{ readonly id: number }>;
		const values: DocumentRecord[] = [];
		for (const row of rows) {
			const record = this.hydrateDocumentRecord(idFromNumber<DocumentId>(row.id));
			if (record !== undefined) values.push(record);
		}
		return page(values, limit);
	}

	// ---------------------------------------------------------------------------
	// Close
	// ---------------------------------------------------------------------------

	close(_context: Context): Promise<void> {
		if (this.closing === undefined) {
			this.closed = true;
			this.closing = this.closeBackend();
		}
		return this.closing;
	}

	private async closeBackend(): Promise<void> {
		if (this.admittedReads > 0) {
			await new Promise<void>((resolve) => {
				this.readsDrained = resolve;
			});
		}
		await this.backend.close();
	}

	/** Run a read that issues several queries; close waits for admitted reads. */
	private async admitRead<T>(read: () => Promise<T> | T): Promise<T> {
		this.assertOpen();
		this.admittedReads += 1;
		try {
			return await read();
		} finally {
			this.admittedReads -= 1;
			if (this.admittedReads === 0) this.readsDrained?.();
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('PiSqliteZstdStorage is closed');
	}

	// ---------------------------------------------------------------------------
	// Content hydration: pi record JSON out of the zstd batches
	// ---------------------------------------------------------------------------

	/**
	 * Detach one record payload from the batch-decode cache: the decoded batch
	 * is shared and cached, so every value handed out goes through a JSON
	 * round-trip (fresh objects, plain prototypes, own `__proto__` keys kept —
	 * the upstream detachment contract).
	 */
	private hydrateRecord<T>(entryId: string, label: string): T | undefined {
		const entry = this.backend.getEntry(entryId);
		if (entry === undefined) return undefined;
		if (entry.kind !== PI_RECORD_ENTRY_KIND) {
			throw new Error(`${label}: entry ${entryId} is not a pi record entry (kind ${entry.kind})`);
		}
		return JSON.parse(JSON.stringify(entry.payload)) as T;
	}

	private hydrateConversation(id: ConversationId): ConversationRecord | undefined {
		return this.hydrateRecord<ConversationRecord>(piImmutableEntryId('conversation', id), `conversation ${id}`);
	}

	private hydrateEntryIndex(
		id: EntryId,
	): { readonly record: EntryRecord; readonly commitSeq: Seq } | undefined {
		const row = this.sql.prepare('SELECT id, conversation_id, head, commit_seq FROM pi_entries WHERE id = ?').get(id) as
			| { readonly id: number; readonly conversation_id: number; readonly head: number | null; readonly commit_seq: number }
			| undefined;
		if (row === undefined) return undefined;
		const record = this.hydrateRecord<EntryRecord>(piImmutableEntryId('entry', id), `entry ${id}`);
		if (record === undefined) return undefined;
		return { record, commitSeq: row.commit_seq as Seq };
	}

	private hydrateTask(id: TaskId): StoredTask | undefined {
		const row = this.sql.prepare('SELECT id, rev FROM pi_tasks WHERE id = ?').get(id) as
			| { readonly id: number; readonly rev: number }
			| undefined;
		if (row === undefined) return undefined;
		return this.hydrateRecord<StoredTask>(piVersionedEntryId('task', id, row.rev), `task ${id}`);
	}

	private hydrateSubmission(id: SubmissionId): SubmissionRecord | undefined {
		const row = this.sql.prepare('SELECT id, rev FROM pi_submissions WHERE id = ?').get(id) as
			| { readonly id: number; readonly rev: number }
			| undefined;
		if (row === undefined) return undefined;
		return this.hydrateRecord<SubmissionRecord>(piVersionedEntryId('submission', id, row.rev), `submission ${id}`);
	}

	private hydrateDocumentRecord(id: DocumentId): DocumentRecord | undefined {
		const row = this.sql.prepare('SELECT id, rev FROM pi_documents WHERE id = ?').get(id) as
			| { readonly id: number; readonly rev: number }
			| undefined;
		if (row === undefined) return undefined;
		return this.hydrateRecord<DocumentRecord>(piVersionedEntryId('document', id, row.rev), `document ${id}`);
	}

	// ---------------------------------------------------------------------------
	// Reads: internals (mirror the pinned SqliteStorage walk algorithms)
	// ---------------------------------------------------------------------------

	private async readEntry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		const id =
			context === undefined
				? (idOrConversationId as EntryId)
				: typeof idOrContext === 'number'
					? (idOrContext as EntryId)
					: undefined;
		if (id === undefined) throw new StorageRequestError('Storage.entry() requires an entry ID');
		let conversation: ConversationRecord | undefined;
		if (context !== undefined) {
			const conversationId = idOrConversationId as ConversationId;
			conversation = this.hydrateConversation(conversationId);
			if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		const stored = this.hydrateEntryIndex(id);
		if (stored === undefined) return undefined;
		const entry = stored.record;
		if (conversation !== undefined) {
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				conversation = this.hydrateConversation(conversation.parent.conversationId);
				if (conversation === undefined) return undefined;
			}
			if (entry.id > upperEntryId) return undefined;
		}
		return { entry, commitSeq: stored.commitSeq };
	}

	private readLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
	): (EntryRecord & { readonly head: EntryId }) | undefined {
		let conversation = this.readConversationRecord(conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		let upper: number | undefined = atOrBeforeEntryId;
		for (;;) {
			const row =
				upper === undefined
					? (this.sql
							.prepare('SELECT id FROM pi_entries WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1')
							.get(conversation.id) as { readonly id: number } | undefined)
					: (this.sql
							.prepare(
								'SELECT id FROM pi_entries WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1',
							)
							.get(conversation.id, upper) as { readonly id: number } | undefined);
			if (row !== undefined) {
				const stored = this.hydrateEntryIndex(row.id as EntryId);
				if (stored !== undefined && stored.record.head !== undefined) {
					return stored.record as EntryRecord & { readonly head: EntryId };
				}
				return undefined;
			}
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = this.readConversationRecord(conversation.parent.conversationId);
			if (conversation === undefined) return undefined;
		}
	}

	private readEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined): Page<EntryRecord, Cursor> {
		const { order, after } = scanStart(query.order, cursor, 'descending');
		if (order === 'ascending') return this.readEntriesAscending(query, limit, after);
		let conversation = this.readConversationRecord(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const values: EntryRecord[] = [];
		for (;;) {
			const clauses = ['conversation_id = ?'];
			const params: unknown[] = [conversation.id];
			if (query.minEntryId !== undefined) {
				clauses.push('id >= ?');
				params.push(query.minEntryId);
			}
			if (upper !== undefined) {
				clauses.push('id <= ?');
				params.push(upper);
			}
			params.push(limit + 1 - values.length);
			const rows = this.sql
				.prepare(`SELECT id FROM pi_entries WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`)
				.all(...params) as Array<{ readonly id: number }>;
			for (const row of rows) {
				const stored = this.hydrateEntryIndex(row.id as EntryId);
				if (stored !== undefined) values.push(stored.record);
			}
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = this.readConversationRecord(conversation.parent.conversationId);
			if (conversation === undefined) break;
		}
		return page(values, limit, 'descending');
	}

	/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
	private readEntriesAscending(query: EntryQuery, limit: number, after: number | undefined): Page<EntryRecord, Cursor> {
		const segments: Array<{ readonly conversationId: ConversationId; readonly upper: number | undefined }> = [];
		let conversation = this.readConversationRecord(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		for (;;) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = this.readConversationRecord(conversation.parent.conversationId);
			if (conversation === undefined) break;
		}
		let lower: number | undefined = query.minEntryId;
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
		const values: EntryRecord[] = [];
		for (const segment of segments.reverse()) {
			const clauses = ['conversation_id = ?'];
			const params: unknown[] = [segment.conversationId];
			if (lower !== undefined) {
				clauses.push('id >= ?');
				params.push(lower);
			}
			if (segment.upper !== undefined) {
				clauses.push('id <= ?');
				params.push(segment.upper);
			}
			params.push(limit + 1 - values.length);
			const rows = this.sql
				.prepare(`SELECT id FROM pi_entries WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`)
				.all(...params) as Array<{ readonly id: number }>;
			for (const row of rows) {
				const stored = this.hydrateEntryIndex(row.id as EntryId);
				if (stored !== undefined) values.push(stored.record);
			}
			if (values.length > limit) break;
		}
		return page(values, limit, 'ascending');
	}

	private readConversationRecord(id: ConversationId): ConversationRecord | undefined {
		return this.hydrateConversation(id);
	}

	// ---------------------------------------------------------------------------
	// Documents: materialization (base + chord deltas), mirroring the pin
	// ---------------------------------------------------------------------------

	private readDocumentMaterialized(id: DocumentId, at: DocumentPoint): StoredDocument | undefined {
		const record = this.hydrateDocumentRecord(id);
		if (record === undefined) return undefined;
		if (at !== 'current' && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === 'current' ? Number.MAX_SAFE_INTEGER : at;
		const base = this.sql
			.prepare(
				`SELECT seq, kind, version, content FROM pi_document_revisions
					WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
			)
			.get(id, upper) as RevisionRow | undefined;
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<JsonObject>(base.content);
		const tail = this.sql
			.prepare(
				`SELECT seq, kind, version, content FROM pi_document_revisions
					WHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
			)
			.all(id, base.seq, upper) as RevisionRow[];
		for (const revision of tail) {
			if (revision.kind !== 'delta' || revision.version !== base.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = apply(value, parseJson<readonly Op[]>(revision.content)) as JsonObject;
		}
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}

	// ---------------------------------------------------------------------------
	// Commit planning (pre-transaction, single writer) and in-transaction apply
	// ---------------------------------------------------------------------------

	private candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.nextId;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	/**
	 * Pre-transaction half of a commit: allocates record content versions
	 * (deterministic mcode entry ids), stamps `createdAt`/`retiredAt` with the
	 * expected sequence, materializes document copy sources, and assembles the
	 * zstd batch drafts plus every index mutation the in-transaction hook will
	 * run. Reads here observe committed state only — the single-writer
	 * backend serializes commits, and the in-transaction head re-check fails
	 * the whole commit if that assumption broke.
	 */
	private planCommit(
		writes: readonly StorageWrite[],
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		expectedSeq: number,
	): CommitPlan {
		const plan = new CommitPlan();

		const currentRev = (table: 'pi_tasks' | 'pi_submissions' | 'pi_documents', id: number): number => {
			const row = this.sql.prepare(`SELECT rev FROM ${table} WHERE id = ?`).get(id) as
				| { readonly rev: number }
				| undefined;
			return row === undefined ? 0 : row.rev;
		};

		for (const write of writes) {
			switch (write.type) {
				case 'conversation':
					plan.drafts.push({
						id: piImmutableEntryId('conversation', write.value.id),
						kind: PI_RECORD_ENTRY_KIND,
						payload: write.value as unknown as JsonValue,
					});
					break;
				case 'entry':
					plan.drafts.push({
						id: piImmutableEntryId('entry', write.value.id),
						kind: PI_RECORD_ENTRY_KIND,
						payload: write.value as unknown as JsonValue,
					});
					break;
				case 'task':
				case 'submission': {
					const table = write.type === 'task' ? 'pi_tasks' : 'pi_submissions';
					const family = write.type;
					const rev = plan.allocateRev(`${family}:${write.value.id}`, currentRev(table, write.value.id));
					plan.drafts.push({
						id: piVersionedEntryId(family, write.value.id, rev),
						kind: PI_RECORD_ENTRY_KIND,
						payload: write.value as unknown as JsonValue,
					});
					break;
				}
				case 'document.create':
				case 'document.copy': {
					const create = write.record;
					const action = actions.get(create.id);
					const rev = plan.allocateRev(`document:${create.id}`, 0);
					const record: DocumentRecord = {
						...create,
						createdAt: seqFromNumber(expectedSeq),
						...(action?.retire ? { retiredAt: seqFromNumber(expectedSeq) } : {}),
					} as DocumentRecord;
					plan.drafts.push({
						id: piVersionedEntryId('document', create.id, rev),
						kind: PI_RECORD_ENTRY_KIND,
						payload: record as unknown as JsonValue,
					});
					plan.setDocumentRecord(create.id, record);
					if (write.type === 'document.copy') {
						try {
							const stored = this.readDocumentMaterialized(write.source.id, write.source.at);
							if (stored === undefined) throw new Error(`Fork source document ${write.source.id} cannot be read`);
							if (
								stored.record.scope.kind !== 'conversation' ||
								create.scope.kind !== 'conversation' ||
								stored.record.kind !== create.kind ||
								stored.record.key !== create.key ||
								stored.record.history !== create.history ||
								stored.record.fork !== create.fork
							) {
								throw new Error(`Fork source document ${write.source.id} does not match the copied record`);
							}
							plan.copyBases.set(create.id, { version: stored.version, value: stored.value });
						} catch (error) {
							throw new Error(`Document copy ${create.id} was rejected`, { cause: error });
						}
					}
					break;
				}
				case 'document.change':
					// Ordinary content change: the record itself is unchanged
					// (only the revision table moves); no new content version.
					break;
				case 'document.retire': {
					const existing = this.hydrateDocumentRecord(write.id);
					if (existing === undefined) break; // the in-transaction check rejects unknown documents
					const rev = plan.allocateRev(`document:${write.id}`, currentRev('pi_documents', write.id));
					const record: DocumentRecord = { ...existing, retiredAt: seqFromNumber(expectedSeq) };
					plan.drafts.push({
						id: piVersionedEntryId('document', write.id, rev),
						kind: PI_RECORD_ENTRY_KIND,
						payload: record as unknown as JsonValue,
					});
					plan.setDocumentRecord(write.id, record);
					break;
				}
			}
		}

		if (plan.drafts.length === 0) {
			// A pi commit always advances the sequence. With no record content
			// (document.change-only or an empty write set) the batch carries a
			// commit marker so the durable sequence and the pi sequence stay
			// in lockstep; its id is derived from the expected sequence, which
			// keeps a crashed-and-retried commit replay-safe (same id, no
			// durable effect from the failed attempt).
			plan.drafts.push({
				id: piCommitMarkerEntryId(expectedSeq),
				kind: PI_COMMIT_MARKER_KIND,
				payload: { seq: expectedSeq, writes: writes.map((write) => write.type) },
			});
		}

		return plan;
	}

	private checkGlobalIds(sql: RecordIndexSql, writes: readonly StorageWrite[]): void {
		const lookup = sql.prepare('SELECT record_type FROM pi_record_ids WHERE id = ?');
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			if (write.type === 'document.change' || write.type === 'document.retire') continue;
			const document = write.type === 'document.create' || write.type === 'document.copy';
			const table: TableName = document ? 'document' : (write.type as TableName);
			const id = document ? write.record.id : write.value.id;
			const existing = (lookup.get(id) as RecordIdRow | undefined)?.record_type;
			const earlier = claimed.get(id);
			if (table === 'conversation' || table === 'entry' || table === 'document') {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private checkDocumentActions(sql: RecordIndexSql, actions: ReadonlyMap<DocumentId, DocumentAction>): void {
		const lastRevision = sql.prepare('SELECT version FROM pi_document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1');
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			const existing = this.hydrateDocumentRecord(id);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === 'delta') {
				const previous = lastRevision.get(id) as { readonly version: number } | undefined;
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const record = action.create ?? existing!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) live = this.currentDocumentId(sql, record) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live -= 1;
			if (action.create !== undefined && !action.retire) live += 1;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error('Document address already has a current incarnation');
		}
	}

	private currentDocumentId(
		sql: RecordIndexSql,
		address: DocumentAddress | DocumentCreate | DocumentRecord,
	): DocumentId | undefined {
		const parts = addressParts(address);
		const id = (
			sql.prepare(
				`SELECT id FROM pi_documents
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
					LIMIT 1`,
			).get(parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue) as IdRow | undefined
		)?.id;
		return id === undefined ? undefined : idFromNumber<DocumentId>(id);
	}

	private applyTableWrite(sql: RecordIndexSql, write: StorageWrite, seq: Seq, plan: CommitPlan): void {
		const claim = (id: Id<string>, table: TableName): void => {
			sql.prepare(`${this.claimIdPrefix}(?, ?)`).run(id, table);
		};
		switch (write.type) {
			case 'conversation':
				claim(write.value.id, 'conversation');
				sql.prepare('INSERT INTO pi_conversations (id, owner_conversation_id, owner_task_id) VALUES (?, ?, ?)').run(
					write.value.id,
					write.value.owner?.conversationId ?? null,
					write.value.owner?.taskId ?? null,
				);
				break;
			case 'entry':
				claim(write.value.id, 'entry');
				sql.prepare('INSERT INTO pi_entries (id, conversation_id, head, commit_seq) VALUES (?, ?, ?, ?)').run(
					write.value.id,
					write.value.conversationId,
					write.value.head ?? null,
					seq,
				);
				break;
			case 'task': {
				claim(write.value.id, 'task');
				const rev = plan.revOf('task', write.value.id);
				sql.prepare(
					`INSERT INTO pi_tasks (id, conversation_id, kind, status, abort_requested, background, rev)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
						status = excluded.status, abort_requested = excluded.abort_requested,
						background = excluded.background, rev = excluded.rev`,
				).run(
					write.value.id,
					write.value.conversationId,
					encodeIndexedString(write.value.kind),
					write.value.state.status,
					write.value.abortRequested ? 1 : 0,
					write.value.background ? 1 : 0,
					rev,
				);
				break;
			}
			case 'submission': {
				claim(write.value.id, 'submission');
				const rev = plan.revOf('submission', write.value.id);
				sql.prepare(
					`INSERT INTO pi_submissions (id, conversation_id, request_id, status, rev) VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
						request_id = excluded.request_id, status = excluded.status, rev = excluded.rev`,
				).run(
					write.value.id,
					write.value.conversationId,
					write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
					write.value.status,
					rev,
				);
				break;
			}
			case 'document.create':
			case 'document.copy':
			case 'document.change':
			case 'document.retire':
				break;
		}
	}

	private applyDocumentActions(
		sql: RecordIndexSql,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
		plan: CommitPlan,
	): void {
		const insertRevision = sql.prepare(
			'INSERT INTO pi_document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)',
		);
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				const base = plan.copyBases.get(id);
				if (base === undefined) throw new Error(`Document copy ${id} was rejected`);
				content = { kind: 'base', version: base.version, value: base.value };
			}
			let record: DocumentRecord;
			if (action.create !== undefined) {
				record = plan.documentRecordOf(id);
				const parts = addressParts(record);
				sql.prepare(`${this.claimIdPrefix}(?, ?)`).run(id, 'document');
				sql.prepare(
					`INSERT INTO pi_documents
						(id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, rev)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					id,
					parts.kind,
					parts.family,
					parts.keyValue,
					parts.scopeKind,
					parts.ownerId,
					seq,
					action.retire ? seq : null,
					plan.revOf('document', id),
				);
			} else {
				record = this.hydrateDocumentRecord(id)!;
			}

			if (content !== undefined) {
				if (content.kind === 'base' && isCurrentOnly(record)) {
					sql.prepare('DELETE FROM pi_document_revisions WHERE document_id = ?').run(id);
				}
				const encodedContent = content.kind === 'base' ? encodeJson(content.value) : encodeJson(content.ops);
				insertRevision.run(id, seq, content.kind, content.version, encodedContent);
			}

			if (action.retire) {
				if (action.create === undefined) {
					sql.prepare('UPDATE pi_documents SET retired_at = ?, rev = ? WHERE id = ?').run(
						seq,
						plan.revOf('document', id),
						id,
					);
				}
				if (isCurrentOnly(record)) {
					sql.prepare('DELETE FROM pi_document_revisions WHERE document_id = ?').run(id);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Commit plan (pre-transaction assembly)
// ---------------------------------------------------------------------------

/**
 * Everything a planned commit needs at apply time: the zstd batch drafts and
 * the lookups the in-transaction hook derives index writes from. Built by
 * {@link PiSqliteZstdStorage.planCommit} against committed state under the
 * single writer; the hook consumes it inside the commit transaction.
 */
class CommitPlan {
	/** zstd batch drafts: one per new record content version, or the commit marker. */
	readonly drafts: EntryDraft[] = [];
	/** Document records stamped while planning, keyed `document:<id>`. */
	private readonly documentRecords = new Map<number, DocumentRecord>();
	/** Materialized copy sources, keyed by the copying document's ID. */
	readonly copyBases = new Map<DocumentId, { readonly version: number; readonly value: JsonObject }>();
	/** Final allocated revision per mutable record (`<family>:<id>` → rev). */
	private readonly revs = new Map<string, number>();

	allocateRev(scope: string, base: number): number {
		const next = (this.revs.get(scope) ?? base) + 1;
		this.revs.set(scope, next);
		return next;
	}

	/** The revision a record's index row must store after this commit. */
	revOf(family: 'task' | 'submission' | 'document', id: number): number {
		const rev = this.revs.get(`${family}:${id}`);
		if (rev === undefined) throw new Error(`commit plan has no revision for ${family} ${id}`);
		return rev;
	}

	setDocumentRecord(id: number, record: DocumentRecord): void {
		this.documentRecords.set(id, record);
	}

	documentRecordOf(id: number): DocumentRecord {
		const record = this.documentRecords.get(id);
		if (record === undefined) throw new Error(`commit plan has no record for document ${id}`);
		return record;
	}
}

function prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
	const actions = new Map<DocumentId, DocumentAction>();
	for (const write of writes) {
		if (
			write.type !== 'document.create' &&
			write.type !== 'document.copy' &&
			write.type !== 'document.change' &&
			write.type !== 'document.retire'
		) {
			continue;
		}
		const id = write.type === 'document.create' || write.type === 'document.copy' ? write.record.id : write.id;
		let action = actions.get(id);
		if (action === undefined) {
			action = { retire: false };
			actions.set(id, action);
		}
		switch (write.type) {
			case 'document.create':
				if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${id} has more than one content command`);
				}
				action.create = write.record;
				action.content = write.content;
				break;
			case 'document.copy':
				if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${id} has more than one content command`);
				}
				action.create = write.record;
				action.copy = write.source;
				break;
			case 'document.change':
				if (action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${id} has more than one content command`);
				}
				action.content = write.content;
				break;
			case 'document.retire':
				if (action.retire) throw new Error(`Document ${id} is retired more than once`);
				action.retire = true;
				break;
		}
	}
	return actions;
}
