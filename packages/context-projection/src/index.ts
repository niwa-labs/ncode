/**
 * `@mavis/context-projection`
 * ---------------------------
 *
 * Derived context view over the durable delta log: a one-shot manifest fold
 * (`buildProjection`), an incremental projector with a head-keyed cache
 * (`ProjectionService`), a projection-level resume capsule, the Context MMU
 * residency hook, and the C3 request-snapshot seam (ProjectionRevision →
 * one immutable RequestSnapshot per logical request). Entries come from
 * `@mavis/durable-backend-sqlite-zstd` (types only — this package never
 * touches the storage backend).
 *
 * @module
 */

export {
	COMPACTION_KIND,
	CONTEXT_EDIT_KIND,
	CONTROL_KIND_PREFIX,
	USAGE_KIND,
	type CompactionPayload,
	type ContextEditPayload,
	type FrozenCompactionSystemMessage,
	type OmissionEditPayload,
	type PruneEditPayload,
	type ReplacementEditPayload,
	type UsageCost,
	type UsageDelta,
	type UsagePayload,
	asCompactionPayload,
	asContextEditPayload,
	asUsagePayload,
	isControlKind,
	isFrozenCompactionSystemMessage,
} from './kinds.js';
export {
	EMPTY_STATE,
	type CompactionMark,
	type ContextManifest,
	ProjectionError,
	type LogPosition,
	type ProjectionState,
	type Segment,
	type Watermark,
	type WinningEdit,
	WATERMARK_AT_START,
	buildProjection,
	foldAll,
	foldEntry,
	toManifest,
} from './projection.js';
export {
	type ApplyResult,
	type CommitWithEntries,
	ProjectionService,
	type ProjectionServiceOptions,
	type ResumeCapsule,
} from './service.js';
export {
	PROJECTION_SCHEMA_VERSION,
	type ProjectionRevision,
	type RequestSnapshot,
	type RequestSnapshotInput,
	type RequestSnapshotRoute,
	buildRequestSnapshot,
	deepFreeze,
	estimateTokens,
} from './request-snapshot.js';
export {
	EMPTY_USAGE,
	type UsageAccumulator,
	type UsageFold,
	addUsageDelta,
	inlineAssistantUsage,
	isUsageEmpty,
	isZeroUsageDelta,
	withUsageDelta,
} from './usage.js';
export { type ResidencyPolicy } from './residency.js';
export {
	ChunkedView,
	WINDOW_CHUNK_CAPACITY,
	type ProjectionPerfCounters,
	projectionPerf,
	resetProjectionPerf,
} from './window.js';
