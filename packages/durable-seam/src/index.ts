/**
 * `@mavis/durable-seam`
 * ---------------------
 *
 * The mandatory steering seam (Ф1): transaction-scoped composition over the
 * wave-1 durable storage contract —
 *
 * - `acceptOwnerInput` (T_accept): submission + `mcode.owner-input.received`
 *   receipt + delivery-index update in ONE commit, deduped by
 *   `(conversationId, requestId)` through the entry index, with
 *   `REQUEST_ID_CONFLICT` on a payload change;
 * - `prepareRelease` (T_release): the durable, replayable prepared
 *   background outcome of a foreground wait under a `stateVersion` CAS;
 * - `finalizeTool` (T_complete): the single tool-result of one `toolCallId`,
 *   idempotently reproduced after a crash between the release phases.
 *
 * The seam implements no inbox of its own, writes no SQL, and replaces no
 * loop: it composes the storage contract's atomic batch commits, indexed
 * point reads, and owner-epoch fencing. See `README.md` for the entry kinds
 * and the recovery model.
 *
 * @module
 */

export { DurableSeam } from './seam.js';
export {
	DEFAULT_MAX_INPUT_BYTES,
	SEAM_ENTRY_KINDS,
	type AcceptOwnerInputResult,
	type BackgroundOutcome,
	type DeliveryView,
	type DurableSeamOptions,
	type FinalizeToolInput,
	type FinalizeToolResult,
	type ForegroundWaitDraft,
	type JsonValue,
	type NoteReleaseIntentInput,
	type NoteReleaseIntentResult,
	type OpenWaitResult,
	type OwnerInputDraft,
	type PrepareReleaseInput,
	type PreparedRelease,
	type RecoveryOptions,
	type RecoveryReport,
	type SeamWaitView,
	type SettleDeliveryInput,
	type SettleDeliveryResult,
	type WaitState,
	type WhenBusy,
} from './types.js';
export {
	InputTooLargeError,
	InvalidInputError,
	RequestIdConflictError,
	SeamError,
	SeamOwnerLostError,
	SeamStorageError,
	ToolResultConflictError,
	UnknownWaitError,
	VersionConflictError,
	WaitIdConflictError,
	WaitTerminalError,
	type SeamErrorCode,
} from './errors.js';
export {
	receiptEntryId,
	releaseIntentEntryId,
	requestKeyHash,
	settledEntryId,
	snapshotEntryId,
	submissionEntryId,
	toolResultEntryId,
	waitOpenedEntryId,
	waitPreparedEntryId,
} from './ids.js';
export { hashJson, hashString, canonicalJson } from './canonical.js';
export type { DurableLogPort, PortCommit, PortDelta, PortEntry, PortEntryDraft } from './port.js';
export { sqliteZstdDurableLogPort, type SqliteZstdBackendLike } from './sqlite-zstd-port.js';
// W02 part B (PORT-PI-1.3): the seam's DurableLogPort over a FULL pi
// Storage (U05) — async open rebuilds the metadata index once in bounded
// pages, sync reads seek it (O(log B + Δ)), payloads stay in a bounded
// LRU window with `loadWindowAfter` reloads and explicit torn verdicts,
// one pi commit per appendBatch, id domains per
// @mavis/durable-core/src/pi-id-domains.ts.
export {
	decodePiBridgeEnvelope,
	encodePiBridgeEnvelope,
	openPiStorageDurableLogPort,
	PI_BRIDGE_ENVELOPE_VERSION,
	type PiBridgeEnvelope,
	type PiCursorLike,
	type PiEntryLookup,
	type PiEntryQueryLike,
	type PiEntryRecordLike,
	type PiPageLike,
	type PiStorageLike,
	type PiStorageLogPort,
	type PiStoragePortOptions,
	type PiStorageWriteLike,
	type PiWindowLoadReport,
	type PiWindowStats,
} from './pi-storage-port.js';
export {
	encodeSnapshotPayload,
	parseSnapshotPayload,
	probeLatestSnapshot,
	type SnapshotDeliveryRecord,
	type SnapshotPayload,
	type SnapshotWaitRecord,
} from './snapshot.js';
