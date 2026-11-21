/**
 * `@mavis/durable-core` — type-only shared contracts of the durable-core
 * wave. Ships no runtime code; the wave dictionary lives in
 * `./contracts.js`, the W02 pi ↔ mcode identity-domain schemas in
 * `./pi-id-domains.js`.
 *
 * @module
 */

export type {
	Commit,
	DeadLetter,
	DeadLetterAck,
	DeadLetterReason,
	Entry,
	EntryAppendStatus,
	FlushFailureStability,
} from './contracts.js';
// W02 part B (PORT-PI-1.3): pi ↔ mcode identity-domain schemas — branded
// mirrors of the pi numeric id family, the entry envelope of a pi
// Storage-backed log port, the C1 CommitReceipt, and the backend-local
// scoping of `head === seq`. Still type-only; see ./pi-id-domains.js.
export type {
	BackendLocalCommitSeq,
	CommitPosition,
	CommitReceipt,
	PiBridgeEntryEnvelope,
	PiBridgeEntryEnvelopeOfVersion,
	PiConversationId,
	PiDocumentId,
	PiEntryId,
	PiMcodeIdMappingSchema,
	PiSeq,
	PiSubmissionId,
	PiTaskId,
	PI_BRIDGE_ENTRY_ENVELOPE_VERSION,
} from './pi-id-domains.js';
