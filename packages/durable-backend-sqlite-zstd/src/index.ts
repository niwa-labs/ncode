/**
 * `@mavis/durable-backend-sqlite-zstd`
 * -----------------------------------
 *
 * Durable delta-log storage backend: immutable compressed entry batches in
 * SQLite. Each `appendBatch()` writes the whole batch as ONE zstd (or gzip)
 * frame — content checksummed, torn frames are never served — plus its index
 * rows and the log head, all in ONE transaction under WAL and
 * `synchronous = FULL`. Format generations (`sessions.gN.db`) open forward
 * only: a newer generation seals the older ones byte-for-byte.
 *
 * This is the fifth storage backend beside Memory/JSONL/SQLite/DO, written
 * against the durable storage seam; the compression codec lives in the
 * `./codec` subpath.
 */

export {
	SqliteZstdBackend,
	FORMAT_ID,
	currentGeneration,
	databaseFileName,
	loadSqlite3Constructor,
	openSqliteZstdBackend,
	type AppendBatchOptions,
	type ReadDeltaResult,
	type RecordIndexSql,
	type RecordIndexWrite,
	type Sqlite3Constructor,
	type SqliteStatement,
	type TornTailInfo,
	type VerifyIssue,
	type VerifyResult,
} from './backend.js';
export {
	PI_COMMIT_MARKER_KIND,
	PI_RECORD_ENTRY_KIND,
	piCommitMarkerEntryId,
	piImmutableEntryId,
	piVersionedEntryId,
	type PiRecordFamily,
} from './pi-ids.js';
export { PI_INDEX_SCHEMA_SQL, PI_NEXT_ID_META_KEY, encodeIndexedString as encodePiIndexedString } from './pi-schema.js';
export { PiSqliteZstdStorage } from './pi-storage.js';
export {
	DEFAULT_MAX_OUTPUT_LENGTH,
	decodeFrame,
	encodeFrame,
	getCodec,
	isZstdSupported,
	peekFrameUncompressedLength,
	resolveCodec,
	type Codec,
	type CodecName,
	type DecodedFrame,
	type DecodeFrameOptions,
} from './codec.js';
export {
	CodecUnavailableError,
	CorruptFrameError,
	DuplicateEntryError,
	OwnerLostError,
	OwnerWriteLockError,
	SealedGenerationError,
	SqliteZstdError,
} from './errors.js';
export {
	type BatchId,
	type Commit,
	type DurableCoreCommit,
	type DurableCoreEntry,
	type Entry,
	type EntryDraft,
	type JsonValue,
	MAX_BATCH_UNCOMPRESSED_BYTES,
	type OpenDurableBackendOptions,
	type ResumeCapsule,
	SEQ_AT_START,
	type Seq,
	type SqliteZstdBackendOptions,
} from './types.js';
