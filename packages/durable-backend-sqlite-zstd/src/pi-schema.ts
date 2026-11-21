/**
 * SQL schema of the pi record-index substrate (W02 part A).
 *
 * The full pi record CONTENT (conversation/entry/task/submission/document
 * records, every task and submission version) rides the zstd batches of this
 * backend as `pi.*` entries — the port plan's "хранение records в наших zstd
 * batches". The tables below are the plan's "SQL indexes / document revision
 * tables": queryable secondary index rows that point at the batch content by
 * the deterministic mcode entry id (`pi-ids.ts`), plus the document revision
 * history (bases and deltas), whose ordered reads the plan explicitly places
 * in SQL.
 *
 * Mirrors the pinned upstream layout (`pi-durable/src/storage/sqlite/`):
 * same column sets, same partial indexes — minus the upstream `record` JSON
 * column, which lives in the zstd batch instead. `rev` columns are ours: the
 * version counter of a mutable record (task/submission/document), i.e. the
 * suffix of its current content entry (`pi.task.<id>.r<rev>`).
 *
 * @module
 */

/**
 * DDL for the pi record-index tables. Idempotent (`CREATE ... IF NOT
 * EXISTS`), safe to run on every adapter open over a writable generation.
 */
export const PI_INDEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pi_record_ids (
  id INTEGER PRIMARY KEY,
  record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
);
CREATE TABLE IF NOT EXISTS pi_conversations (
  id INTEGER PRIMARY KEY,
  owner_conversation_id INTEGER,
  owner_task_id INTEGER
);
CREATE INDEX IF NOT EXISTS pi_conversations_by_owner_conversation ON pi_conversations (owner_conversation_id, id);
CREATE INDEX IF NOT EXISTS pi_conversations_by_owner_task ON pi_conversations (owner_task_id, id);
CREATE TABLE IF NOT EXISTS pi_entries (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  head INTEGER,
  commit_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_entries_by_conversation ON pi_entries (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS pi_entry_heads_by_conversation ON pi_entries (conversation_id, id DESC) WHERE head IS NOT NULL;
CREATE TABLE IF NOT EXISTS pi_tasks (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
  background INTEGER NOT NULL CHECK (background IN (0, 1)),
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_tasks_by_status ON pi_tasks (status, id);
CREATE INDEX IF NOT EXISTS pi_tasks_by_conversation ON pi_tasks (conversation_id, id);
CREATE INDEX IF NOT EXISTS pi_tasks_by_kind ON pi_tasks (kind, id);
CREATE INDEX IF NOT EXISTS pi_tasks_by_abort_requested ON pi_tasks (abort_requested, id);
CREATE INDEX IF NOT EXISTS pi_tasks_by_background ON pi_tasks (background, id);
CREATE TABLE IF NOT EXISTS pi_submissions (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  request_id TEXT,
  status TEXT NOT NULL,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_submissions_by_request ON pi_submissions (conversation_id, request_id);
CREATE INDEX IF NOT EXISTS pi_submissions_by_conversation ON pi_submissions (conversation_id, id);
CREATE INDEX IF NOT EXISTS pi_submissions_by_status ON pi_submissions (status, id);
CREATE TABLE IF NOT EXISTS pi_documents (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  family INTEGER NOT NULL CHECK (family IN (0, 1)),
  key_value TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
  owner_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_documents_by_address
  ON pi_documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
CREATE INDEX IF NOT EXISTS pi_documents_by_scope ON pi_documents (scope_kind, owner_id, id);
CREATE INDEX IF NOT EXISTS pi_documents_by_scope_kind ON pi_documents (scope_kind, owner_id, kind, id);
CREATE TABLE IF NOT EXISTS pi_document_revisions (
  document_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  PRIMARY KEY (document_id, seq)
);
CREATE INDEX IF NOT EXISTS pi_document_revisions_by_kind ON pi_document_revisions (document_id, kind, seq DESC);
`;

/** `meta` key persisting the pi minted-ID watermark (TEXT: ids are safe integers, the watermark may be MAX_SAFE_INTEGER + 1). */
export const PI_NEXT_ID_META_KEY = 'pi.next_id';

/**
 * Encode a string for an index column so its identity survives the SQLite
 * binding lossless: some bindings replace lone UTF-16 surrogates, and JSON
 * escaping (well-formed `JSON.stringify`) keeps them distinguishable. Same
 * trick as the pinned upstream `encodeIndexedString`.
 */
export function encodeIndexedString(value: string): string {
	return JSON.stringify(value);
}
