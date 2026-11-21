// C3: ProjectionRevision → RequestSnapshot.
//
// The boundary contract (port-pi-1.3 `boundary-contracts.md` C3) names the
// seam that was missing: exactly ONE immutable snapshot per logical provider
// request, addressed by the projection revision it was taken at. Concurrent
// input or a compaction lands as the NEXT revision of the projection — the
// middle of an already-sent body can never change, because the snapshot
// deep-freezes its manifest (the `freezeJson` discipline of pi-durable's
// `harness/context.ts`) and every later `apply` builds fresh state.
//
// The snapshot is bounded by construction (the manifest window) and carries a
// deterministic token estimate, so admission/budget decisions address the
// snapshot instead of re-deriving the window. Routing/session/request ids are
// supplied by the caller: this module owns identity and immutability, not id
// minting.

import type { Seq } from '../../durable-backend-sqlite-zstd/src/types.js';

import type { ContextManifest, Segment, Watermark } from './projection.js';

/**
 * Schema version of the projection manifest this module addresses. 2 = the
 * W03 part-B manifest (pi edit semantics, usage fold, retain-none); 1 =
 * pre-part-B manifests (compaction cut + prune only).
 */
export const PROJECTION_SCHEMA_VERSION = 2;

/** Identity of one committed projection state — the address a snapshot is taken at (C2 output, C3 input). */
export interface ProjectionRevision {
	/** Durable conversation the projection folds. */
	readonly conversationId: string;
	/** Durable root / session identity the conversation belongs to. */
	readonly rootId: string;
	/** Log head the fold has caught up to. */
	readonly head: Seq;
	/** Exact log position (seq, ordinal) of the fold. */
	readonly watermark: Watermark;
	/** Manifest schema version of the projection. */
	readonly schemaVersion: number;
	/** Monotone edit revision: `mcode.context_edit` entries folded so far. */
	readonly editVersion: number;
	/** Window bytes at this revision (bounded-window identity component). */
	readonly windowBytes: number;
}

/** Model route a snapshot was resolved for (provider + model ids, no catalog knowledge). */
export interface RequestSnapshotRoute {
	readonly provider: string;
	readonly modelId: string;
}

/** One immutable snapshot of the projected context per logical provider request (C3 output). */
export interface RequestSnapshot {
	/** Logical request id; the caller mints one per provider request and reuses the snapshot for its retries. */
	readonly requestId: string;
	/** Session identity the request belongs to. */
	readonly sessionId: string;
	/** The revision this snapshot was taken at. */
	readonly revision: ProjectionRevision;
	/** Bounded manifest view; DEEP-FROZEN — later applies cannot mutate it. */
	readonly manifest: ContextManifest;
	/** Deterministic token estimate of the manifest window (see {@link estimateTokens}). */
	readonly tokenEstimate: number;
	/** Model route resolved at snapshot time, when known. */
	readonly route: RequestSnapshotRoute | null;
	/** Wall-clock stamp supplied by the caller (deterministic snapshots pass a fixed value). */
	readonly createdAtMs: number;
}

/**
 * Deterministic token estimate of the manifest window: Σ ceil(byteLen / 4)
 * over the visible segments — the standard ~4-bytes-per-token heuristic. It
 * is an ESTIMATE for budget/admission, never a provider count; the wire
 * compiler's measured bytes remain the payload truth.
 */
export function estimateTokens(segments: readonly Segment[]): number {
	let tokens = 0;
	for (const segment of segments) tokens += Math.ceil(segment.byteLen / 4);
	return tokens;
}

/** Objects frozen by {@link deepFreeze} with everything inside them. */
const deeplyFrozen = new WeakSet<object>();

/**
 * Freezes a JSON value and everything in it (pi-durable `freezeJson`
 * discipline). Safe on shared structures: an already-frozen object graph is
 * returned as is.
 */
export function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== 'object' || deeplyFrozen.has(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	Object.freeze(value);
	deeplyFrozen.add(value);
	return value;
}

/** Inputs of {@link buildRequestSnapshot}. */
export interface RequestSnapshotInput {
	readonly conversationId: string;
	readonly rootId: string;
	readonly requestId: string;
	readonly sessionId: string;
	readonly manifest: ContextManifest;
	/** Edit revision counter of the projection at this manifest. */
	readonly editVersion: number;
	readonly route?: RequestSnapshotRoute | null;
	readonly createdAtMs?: number;
}

/**
 * Builds the ONE immutable snapshot for a logical request. The caller invokes
 * this exactly once per logical provider request and keeps the returned
 * object for the request's lifetime (retries resend the same snapshot); a
 * request assembled twice from the same revision yields equal, but distinct,
 * snapshot objects — revision identity, not object identity, is the address.
 *
 * A manifest whose object graph is already deep-frozen (the projection
 * service's revision cache) is SHARED, not re-copied: freezing is the
 * isolation, so the snapshot and its source can safely alias the same
 * segment array. A plain mutable manifest is still copied segment-by-segment
 * — the snapshot never aliases anything its caller can mutate.
 */
export function buildRequestSnapshot(input: RequestSnapshotInput): RequestSnapshot {
	if (input.conversationId.length === 0) throw new TypeError('RequestSnapshot: conversationId must be non-empty');
	if (input.rootId.length === 0) throw new TypeError('RequestSnapshot: rootId must be non-empty');
	if (input.requestId.length === 0) throw new TypeError('RequestSnapshot: requestId must be non-empty');
	if (input.sessionId.length === 0) throw new TypeError('RequestSnapshot: sessionId must be non-empty');
	if (input.editVersion < 0 || !Number.isInteger(input.editVersion)) {
		throw new TypeError('RequestSnapshot: editVersion must be a non-negative integer');
	}
	// `deeplyFrozen.has` is O(1) and holds only for graphs this module froze
	// in full — exactly the service's cached manifests.
	const manifestIsFrozen = deeplyFrozen.has(input.manifest);
	return deepFreeze({
		requestId: input.requestId,
		sessionId: input.sessionId,
		revision: deepFreeze({
			conversationId: input.conversationId,
			rootId: input.rootId,
			head: input.manifest.head,
			watermark: { ...input.manifest.watermark },
			schemaVersion: PROJECTION_SCHEMA_VERSION,
			editVersion: input.editVersion,
			windowBytes: input.manifest.windowBytes,
		}),
		manifest: deepFreeze({
			...input.manifest,
			segments: manifestIsFrozen
				? input.manifest.segments
				: input.manifest.segments.map((segment) => ({ ...segment })),
			watermark: { ...input.manifest.watermark },
		}),
		tokenEstimate: estimateTokens(input.manifest.segments),
		route: input.route == null ? null : { provider: input.route.provider, modelId: input.route.modelId },
		createdAtMs: input.createdAtMs ?? Date.now(),
	});
}
