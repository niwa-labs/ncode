import type { CanonicalHistoryEnvelope } from '../../sessions/representation/canonical-history-contract.js';

/**
 * Wave 1 of the compaction architecture (canon 05 §2.1/§3): the durable
 * history log becomes an EVENT log. Nothing already written is ever
 * rewritten: `history.v1.full` stays only for `seed`/`adopt` (external
 * imports) and the legacy records of sessions written before this wave; every
 * compression and lifecycle operation is an APPENDED event over a range of
 * per-session sequence numbers, and the active history is the FOLD of the
 * log.
 *
 * Per-session logical `seq`: every durable entry carrying the session's id
 * consumes one `seq`, numbered from 1 in log order (the fold assigns them by
 * counting; the live writer counts its own writes the same way). A
 * `compaction.replace` acts on `[startSeq, endSeq]`; everything appended
 * after `endSeq` is the live suffix and can never be dropped by construction
 * (the incident 2026-11-07 hazard class: a replacement list snapshot that
 * silently lost the messages that caught up between the plan and the commit).
 *
 * `generation` grows ONLY on `replace`/`repair`/adopt (`history.v1.full`
 * bases)/`tombstone` — never on plain appends (codex `history_version`
 * semantics): an append between a compaction plan and its commit must not
 * invalidate the plan.
 *
 * Every payload is validated fail-closed at WRITE (the codec refuses an
 * unknown kind or a malformed payload before an entry is enqueued) and at
 * READ (the fold throws on a malformed record — a corrupt log, never a
 * partially trusted history).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Event kinds and payloads (canon 05 §2.1 table)
// ---------------------------------------------------------------------------

export const EVENT_COMPACTION_START = 'history.v2.compaction.start';
export const EVENT_COMPACTION_SUMMARY = 'history.v2.compaction.summary';
export const EVENT_COMPACTION_REPLACE = 'history.v2.compaction.replace';
export const EVENT_COMPACTION_END = 'history.v2.compaction.end';
export const EVENT_OFFLOAD = 'history.v2.offload';
export const EVENT_REPAIR = 'history.v2.repair';
export const EVENT_TOMBSTONE = 'history.v2.tombstone';
/** Whole-history replacement of a NON-compaction `replaceMessages` delivery that is not already the canonical prefix. */
export const EVENT_REPLACE_ALL = 'history.v2.replace';

/** Outcome of a compaction lifecycle (canon: `end{id, outcome}`). */
export type CompactionOutcomeKind = 'committed' | 'failed' | 'abandoned';

export interface CompactionStartEvent {
  readonly kind: typeof EVENT_COMPACTION_START;
  readonly sessionId: string;
  readonly compactionId: string;
  /** Fold generation the plan was built on (the replace must match it). */
  readonly baseGeneration: number;
  /** Per-session seq head at the attempt start (observability). */
  readonly coveredUpToSeq: number;
  /**
   * Identity of the writing provider instance. A start still open under a
   * DIFFERENT token belongs to a dead process (the ownership lock guarantees
   * a single live writer) — the lease closes it as `abandoned` at once; a
   * start of THIS instance inside the lease window refuses a new attempt
   * (fail-closed: the per-session lane makes a concurrent commit impossible,
   * so this only ever surfaces a real defect).
   */
  readonly writerToken: string;
  readonly startedAtMs: number;
}

export interface CompactionSummaryEvent {
  readonly kind: typeof EVENT_COMPACTION_SUMMARY;
  readonly sessionId: string;
  readonly compactionId: string;
  readonly text: string;
  readonly tokensBefore: number;
}

export interface CompactionReplaceEvent {
  readonly kind: typeof EVENT_COMPACTION_REPLACE;
  readonly sessionId: string;
  readonly compactionId: string;
  readonly baseGeneration: number;
  /** The replaced range: the segment opening the covered prefix… */
  readonly startSeq: number;
  /** …the segment holding its last covered envelope (≤ the session head). */
  readonly endSeq: number;
  /** How many envelopes of the `endSeq` segment are covered (whole segment when it ends there). */
  readonly endEnvelopeCount: number;
  /** Envelopes inserted where the covered prefix stood: the summary (and the optional current-user marker). */
  readonly inserted: readonly CanonicalHistoryEnvelope[];
  /** Fold generation AFTER this replace (`baseGeneration + 1`, stamped by the writer). */
  readonly generation: number;
  readonly producedBy: string;
  readonly parentSnapshot: {
    readonly generation: number;
    readonly compactionId: string;
    readonly revision: string;
  };
}

export interface CompactionEndEvent {
  readonly kind: typeof EVENT_COMPACTION_END;
  readonly sessionId: string;
  readonly compactionId: string;
  readonly outcome: CompactionOutcomeKind;
}

/**
 * Wave 2 (canon 05 §2.1: `offload{seq, blockIdx → artifactRef}`; §2.2:
 * "tool_archive перестаёт быть «компакцией» → offload-событие"). The physical
 * offload of ONE block into an artifact:
 *
 * - IMAGE offload (item 2.1): the append-time receipt boundary — the envelope
 *   itself already carries the artifact reference (the base64 never entered
 *   the log), and this event records the physical offload
 *   (`contentBlockIdx` names the image block inside the envelope's content;
 *   `replacement` absent — the fold changes no envelopes).
 * - TEXT offload (item 2.4): the tool-result externalization — `replacement`
 *   carries the stub receipt the ACTIVE history shows in place of the
 *   envelope's text blocks. The log keeps the original bytes (append-only);
 *   the fold applies the delta, kilobytes instead of the whole-history
 *   `full`/`replace` rewrite the legacy axis wrote.
 *
 * `artifactRef` is the content-addressed artifact identity (the sha256 the
 * artifact store names the file by).
 */
export interface OffloadEvent {
  readonly kind: typeof EVENT_OFFLOAD;
  readonly sessionId: string;
  /** Per-session seq of the entry holding the offloaded block. */
  readonly seq: number;
  /** Index of the envelope inside that entry's envelopes. */
  readonly blockIdx: number;
  readonly artifactRef: string;
  /** Index of the offloaded block inside the envelope's content (images). */
  readonly contentBlockIdx?: number;
  /** Stub receipt replacing the envelope's text blocks (text offload). */
  readonly replacement?: string;
}

/**
 * Repair (canon: `repair{...}` — an append, never a full rewrite). Two
 * dispositions of the incident-03 healing, expressed as a delta:
 * `truncateTo` drops the trailing envelopes of an interrupted committed tool
 * round (envelope-level count of the active history); `appended` carries the
 * synthesized unknown-outcome results of an accepted-but-unconfirmed round.
 */
export interface RepairEvent {
  readonly kind: typeof EVENT_REPAIR;
  readonly sessionId: string;
  readonly turnId: string;
  /** Strict-JSON payload: the absent truncate is the key's ABSENCE. */
  readonly truncateTo?: number;
  readonly appended: readonly CanonicalHistoryEnvelope[];
  /** Fold generation AFTER this repair (stamped by the writer). */
  readonly generation: number;
}

/** Delete tombstone (canon: the physical removal is a separate explicit purge). */
export interface TombstoneEvent {
  readonly kind: typeof EVENT_TOMBSTONE;
  readonly sessionId: string;
  readonly generation: number;
  readonly deletedAtMs: number;
}

export interface ReplaceAllEvent {
  readonly kind: typeof EVENT_REPLACE_ALL;
  readonly sessionId: string;
  readonly envelopes: readonly CanonicalHistoryEnvelope[];
  readonly generation: number;
}

export type HistoryEvent =
  | CompactionStartEvent
  | CompactionSummaryEvent
  | CompactionReplaceEvent
  | CompactionEndEvent
  | OffloadEvent
  | RepairEvent
  | TombstoneEvent
  | ReplaceAllEvent;

/** Event kinds of this module (the codec's known set — anything else is refused). */
export const HISTORY_EVENT_KINDS: readonly string[] = [
  EVENT_COMPACTION_START,
  EVENT_COMPACTION_SUMMARY,
  EVENT_COMPACTION_REPLACE,
  EVENT_COMPACTION_END,
  EVENT_OFFLOAD,
  EVENT_REPAIR,
  EVENT_TOMBSTONE,
  EVENT_REPLACE_ALL,
];

export function isHistoryEventKind(kind: string): boolean {
  return HISTORY_EVENT_KINDS.includes(kind);
}

// -- codec (fail-closed at write and at read) ---------------------------------

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Durable history event ${what} payload is malformed.`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`Durable history event ${what} is missing its '${key}'.`);
  }
  return value;
}

function requireNumber(
  record: Record<string, unknown>,
  key: string,
  what: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Durable history event ${what} has an invalid '${key}'.`);
  }
  return value;
}

function requireEnvelopes(
  record: Record<string, unknown>,
  key: string,
  what: string,
): readonly CanonicalHistoryEnvelope[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new TypeError(`Durable history event ${what} is missing its '${key}'.`);
  }
  for (const envelope of value) {
    const recordEnvelope = requireObject(envelope, what);
    if (
      typeof recordEnvelope['message_id'] !== 'string' ||
      typeof recordEnvelope['turn_id'] !== 'string' ||
      !recordEnvelope['message']
    ) {
      throw new TypeError(`Durable history event ${what} carries a malformed envelope.`);
    }
  }
  return value as readonly CanonicalHistoryEnvelope[];
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  what: string,
): number | undefined {
  if (record[key] === undefined) return undefined;
  return requireNumber(record, key, what);
}

/**
 * Decodes and validates one event payload. FAIL-CLOSED: an unknown kind or a
 * malformed payload throws — a record that cannot be understood is a corrupt
 * log, never a partially trusted history.
 */
export function parseHistoryEvent(kind: string, payload: unknown): HistoryEvent {
  const record = requireObject(payload, kind);
  const sessionId = requireString(record, 'sessionId', kind);
  switch (kind) {
    case EVENT_COMPACTION_START:
      return {
        kind: EVENT_COMPACTION_START,
        sessionId,
        compactionId: requireString(record, 'compactionId', kind),
        baseGeneration: requireNumber(record, 'baseGeneration', kind),
        coveredUpToSeq: requireNumber(record, 'coveredUpToSeq', kind),
        writerToken: requireString(record, 'writerToken', kind),
        startedAtMs: requireNumber(record, 'startedAtMs', kind),
      };
    case EVENT_COMPACTION_SUMMARY:
      return {
        kind: EVENT_COMPACTION_SUMMARY,
        sessionId,
        compactionId: requireString(record, 'compactionId', kind),
        text: requireString(record, 'text', kind),
        tokensBefore: requireNumber(record, 'tokensBefore', kind),
      };
    case EVENT_COMPACTION_REPLACE: {
      const inserted = requireEnvelopes(record, 'inserted', kind);
      if (inserted.length === 0) {
        throw new TypeError(`Durable history event ${kind} inserts no envelopes.`);
      }
      const parentSnapshot = requireObject(record['parentSnapshot'], kind);
      const startSeq = requireNumber(record, 'startSeq', kind);
      const endSeq = requireNumber(record, 'endSeq', kind);
      if (endSeq < startSeq) {
        throw new TypeError(`Durable history event ${kind} has an inverted seq range.`);
      }
      return {
        kind: EVENT_COMPACTION_REPLACE,
        sessionId,
        compactionId: requireString(record, 'compactionId', kind),
        baseGeneration: requireNumber(record, 'baseGeneration', kind),
        startSeq,
        endSeq,
        endEnvelopeCount: requireNumber(record, 'endEnvelopeCount', kind),
        inserted,
        generation: requireNumber(record, 'generation', kind),
        producedBy: requireString(record, 'producedBy', kind),
        parentSnapshot: {
          generation: requireNumber(parentSnapshot, 'generation', kind),
          compactionId: requireString(parentSnapshot, 'compactionId', kind),
          revision: requireString(parentSnapshot, 'revision', kind),
        },
      };
    }
    case EVENT_COMPACTION_END: {
      const outcome = record['outcome'];
      if (
        outcome !== 'committed' &&
        outcome !== 'failed' &&
        outcome !== 'abandoned'
      ) {
        throw new TypeError(`Durable history event ${kind} has an unknown outcome.`);
      }
      return {
        kind: EVENT_COMPACTION_END,
        sessionId,
        compactionId: requireString(record, 'compactionId', kind),
        outcome,
      };
    }
    case EVENT_OFFLOAD:
      return {
        kind: EVENT_OFFLOAD,
        sessionId,
        seq: requireNumber(record, 'seq', kind),
        blockIdx: requireNumber(record, 'blockIdx', kind),
        artifactRef: requireString(record, 'artifactRef', kind),
        ...(record['contentBlockIdx'] === undefined
          ? {}
          : { contentBlockIdx: requireNumber(record, 'contentBlockIdx', kind) }),
        ...(record['replacement'] === undefined ? {} : { replacement: requireString(record, 'replacement', kind) }),
      };
    case EVENT_REPAIR: {
      const appended = requireEnvelopes(record, 'appended', kind);
      return {
        kind: EVENT_REPAIR,
        sessionId,
        turnId: requireString(record, 'turnId', kind),
        truncateTo: optionalNumber(record, 'truncateTo', kind),
        appended,
        generation: requireNumber(record, 'generation', kind),
      };
    }
    case EVENT_TOMBSTONE:
      return {
        kind: EVENT_TOMBSTONE,
        sessionId,
        generation: requireNumber(record, 'generation', kind),
        deletedAtMs: requireNumber(record, 'deletedAtMs', kind),
      };
    case EVENT_REPLACE_ALL: {
      const envelopes = requireEnvelopes(record, 'envelopes', kind);
      return {
        kind: EVENT_REPLACE_ALL,
        sessionId,
        envelopes,
        generation: requireNumber(record, 'generation', kind),
      };
    }
    default:
      throw new TypeError(`Unknown durable history event kind '${kind}'.`);
  }
}

// ---------------------------------------------------------------------------
// The fold (canon 05 §2.1: активная история = свёртка лога)
// ---------------------------------------------------------------------------

/** One origin segment of the folded history: the envelopes contributed by ONE session entry at `seq`. */
export interface FoldSegment {
  readonly seq: number;
  readonly envelopes: CanonicalHistoryEnvelope[];
}

/** The compaction attempt a `compaction.start` opened, until its `end` arrives. */
export interface OpenCompactionFold {
  readonly compactionId: string;
  readonly baseGeneration: number;
  readonly writerToken: string;
  readonly startedAtMs: number;
}

/**
 * The fold state of one session: origin segments (base, appends, repairs,
 * inserted summaries), the event-stamped generation, the per-session logical
 * seq head, and the open compaction attempt if one is unclosed. The active
 * history is the concatenation of the segments (materialized by the owner).
 */
export interface SessionFold {
  readonly segments: FoldSegment[];
  readonly generation: number;
  /** Per-session logical seq of the LAST consumed session entry. */
  readonly headSeq: number;
  /** Durable entry id of the last consumed session entry (the next write's `parentId`). */
  readonly lastEntryId: string | undefined;
  readonly deleted: boolean;
  readonly openCompaction: OpenCompactionFold | undefined;
  /**
   * The LAST committed compaction (its id and summary text). The В1 barrier
   * re-delivers the committed checkpoint through the `compact` seam — the
   * re-delivery is recognized here and writes nothing (the log already holds
   * that truth).
   */
  readonly lastCompaction: { readonly compactionId: string; readonly summaryText: string } | undefined;
  /** Total envelope count (O(1) bounds checks for truncate/replace plans). */
  readonly envelopeCount: number;
}

export function createEmptyFold(): SessionFold {
  return {
    segments: [],
    generation: 0,
    headSeq: 0,
    lastEntryId: undefined,
    deleted: false,
    openCompaction: undefined,
    lastCompaction: undefined,
    envelopeCount: 0,
  };
}

/** Flattens the fold into the active history (one concatenation, no O(n²) per-entry rewrite). */
export function materializeFold(fold: SessionFold): CanonicalHistoryEnvelope[] {
  const envelopes: CanonicalHistoryEnvelope[] = [];
  for (const segment of fold.segments) envelopes.push(...segment.envelopes);
  return envelopes;
}

/**
 * Marker generation carried by a base's first envelope (`history_artifact`);
 * legacy sessions without a marker start at generation 0.
 */
function baseGenerationOf(records: readonly CanonicalHistoryEnvelope[]): number {
  const generation = records[0]?.history_artifact?.generation;
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : 0;
}

function requireGenerationGrowth(fold: SessionFold, generation: number, kind: string): void {
  if (!Number.isSafeInteger(generation) || generation <= fold.generation) {
    throw new TypeError(
      `Durable history event ${kind} does not grow the generation (${String(generation)} after ${String(fold.generation)}).`,
    );
  }
}

/**
 * Applies one durable entry to the fold. `logicalSeq` is the per-session seq
 * of this entry (assigned by the caller: the running count of the session's
 * entries in log order). Seed-protocol BEGIN/CHUNK entries only advance the
 * seq bookkeeping (the base publishes through `applyFoldBase` when the
 * provider resolves a verified commit). Throws on a malformed or
 * sequence-inconsistent record — fail-closed (a corrupt log).
 *
 * `entryId` is stored only on non-event bookkeeping paths; callers pass the
 * durable entry id so the fold's `lastEntryId` stays the next write's
 * `parentId`.
 */
export function applyFoldEntry(
  fold: SessionFold,
  entry: { readonly id: string; readonly kind: string; readonly payload: unknown },
  logicalSeq: number,
): void {
  if (logicalSeq !== fold.headSeq + 1) {
    throw new TypeError(
      `Durable history fold seq gap: expected ${String(fold.headSeq + 1)}, got ${String(logicalSeq)}.`,
    );
  }
  (fold as { headSeq: number }).headSeq = logicalSeq;
  if (entry.id) {
    (fold as { lastEntryId: string | undefined }).lastEntryId = entry.id;
  }
  switch (entry.kind) {
    case EVENT_COMPACTION_START: {
      const event = parseHistoryEvent(entry.kind, entry.payload) as CompactionStartEvent;
      if (fold.openCompaction) {
        throw new TypeError(
          `Durable history log holds two open compaction starts (${fold.openCompaction.compactionId}, ${event.compactionId}).`,
        );
      }
      (fold as {
        openCompaction: OpenCompactionFold | undefined;
      }).openCompaction = {
        compactionId: event.compactionId,
        baseGeneration: event.baseGeneration,
        writerToken: event.writerToken,
        startedAtMs: event.startedAtMs,
      };
      return;
    }
    case EVENT_COMPACTION_SUMMARY: {
      const event = parseHistoryEvent(entry.kind, entry.payload) as CompactionSummaryEvent;
      if (fold.openCompaction?.compactionId !== event.compactionId) {
        throw new TypeError(
          `Durable history event compaction.summary has no matching open start (${event.compactionId}).`,
        );
      }
      return;
    }
    case EVENT_COMPACTION_REPLACE:
      applyFoldCompactionReplace(
        fold,
        parseHistoryEvent(entry.kind, entry.payload) as CompactionReplaceEvent,
        logicalSeq,
      );
      return;
    case EVENT_COMPACTION_END: {
      const event = parseHistoryEvent(entry.kind, entry.payload) as CompactionEndEvent;
      if (fold.openCompaction?.compactionId !== event.compactionId) {
        throw new TypeError(
          `Durable history event compaction.end has no matching open start (${event.compactionId}).`,
        );
      }
      (fold as { openCompaction: OpenCompactionFold | undefined }).openCompaction = undefined;
      return;
    }
    case EVENT_OFFLOAD: {
      const event = parseHistoryEvent(entry.kind, entry.payload) as OffloadEvent;
      // Wave 2: a TEXT offload (`replacement` present) applies its delta to
      // the fold — the active history shows the stub receipt where the
      // envelope's text blocks stood, while the log keeps the original bytes
      // (append-only). An IMAGE offload records the physical offload only:
      // the envelope itself already carries the artifact reference, so no
      // envelope changes. Neither grows the generation (canon §2.1: an
      // offload is not a replace/repair — a compaction plan stays valid).
      if (event.replacement !== undefined) {
        applyFoldTextOffload(fold, event);
      }
      return;
    }
    case EVENT_REPAIR:
      applyFoldRepair(
        fold,
        parseHistoryEvent(entry.kind, entry.payload) as RepairEvent,
        logicalSeq,
      );
      return;
    case EVENT_TOMBSTONE: {
      const event = parseHistoryEvent(entry.kind, entry.payload) as TombstoneEvent;
      requireGenerationGrowth(fold, event.generation, entry.kind);
      (fold as {
        segments: FoldSegment[];
        generation: number;
        deleted: boolean;
        envelopeCount: number;
      }).segments = [];
      (fold as { envelopeCount: number }).envelopeCount = 0;
      (fold as { generation: number }).generation = event.generation;
      (fold as { deleted: boolean }).deleted = true;
      return;
    }
    case EVENT_REPLACE_ALL: {
      const event = parseHistoryEvent(entry.kind, entry.payload) as ReplaceAllEvent;
      requireGenerationGrowth(fold, event.generation, entry.kind);
      (fold as { segments: FoldSegment[] }).segments = [
        { seq: logicalSeq, envelopes: [...event.envelopes] },
      ];
      (fold as { envelopeCount: number }).envelopeCount = event.envelopes.length;
      (fold as { generation: number }).generation = event.generation;
      (fold as { deleted: boolean }).deleted = false;
      return;
    }
    case 'history.v1.full': {
      const payload = entry.payload as {
        reason?: string;
        envelopes?: readonly CanonicalHistoryEnvelope[];
      };
      if (payload?.reason === 'delete') {
        // Legacy delete tombstone (pre-wave-1 sessions): the active history
        // empties and the generation grows (canon: delete bumps).
        (fold as { segments: FoldSegment[] }).segments = [];
        (fold as { envelopeCount: number }).envelopeCount = 0;
        (fold as { generation: number }).generation = fold.generation + 1;
        (fold as { deleted: boolean }).deleted = true;
        return;
      }
      const envelopes = Array.isArray(payload?.envelopes) ? payload.envelopes : [];
      applyFoldBase(fold, envelopes, logicalSeq);
      if (payload?.reason === 'adopt') {
        // Canon §2.1: adopt bumps the generation. The marker on the adopted
        // records is the last COMPACTION's count — never below it, and one
        // past the fold's own event-stamped generation.
        (fold as { generation: number }).generation = Math.max(
          baseGenerationOf(envelopes),
          fold.generation + 1,
        );
      }
      return;
    }
    case 'history.v1.append': {
      const payload = entry.payload as {
        envelopes?: readonly CanonicalHistoryEnvelope[];
      };
      const envelopes = Array.isArray(payload?.envelopes) ? payload.envelopes : [];
      if (fold.segments.length === 0 && !fold.deleted) {
        throw new TypeError(
          `Durable history log has an append before any base: seq ${String(logicalSeq)}.`,
        );
      }
      pushFoldSegment(fold, { seq: logicalSeq, envelopes: [...envelopes] });
      return;
    }
    // Seed protocol bookkeeping: the base publishes through `applyFoldBase`
    // when the provider resolves a verified commit.
    case 'history.v2.seed.begin':
    case 'history.v2.seed.chunk':
    case 'history.v2.seed.commit':
      return;
    default:
      throw new TypeError(
        `Durable history log has an unknown entry kind "${entry.kind}" at seq ${String(logicalSeq)}.`,
      );
  }
}

/** Publishes a verified base (a committed seed import or a legacy full state) as the fold's origin. */
export function applyFoldBase(
  fold: SessionFold,
  envelopes: readonly CanonicalHistoryEnvelope[],
  logicalSeq: number,
): void {
  (fold as { segments: FoldSegment[] }).segments = [
    { seq: logicalSeq, envelopes: [...envelopes] },
  ];
  (fold as { envelopeCount: number }).envelopeCount = envelopes.length;
  (fold as { generation: number }).generation = baseGenerationOf(envelopes);
  (fold as { deleted: boolean }).deleted = false;
}

function pushFoldSegment(fold: SessionFold, segment: FoldSegment): void {
  fold.segments.push(segment);
  (fold as { envelopeCount: number }).envelopeCount += segment.envelopes.length;
}

/**
 * Resolves the segment range of the first `coveredEnvelopeCount` envelopes of
 * the folded history. Shared by the write-side validator and the fold's
 * replace application — one definition of the range semantics.
 *
 * The covered prefix walks the segments in MATERIALIZED (list) order — the
 * order the plan's counts refer to. After a committed replace the fold's
 * summary segment carries the replace event's own log seq, HIGHER than the
 * kept tail's original segment seq (incident 2026-11-07, mvs_70b7f22), so
 * list order and seq order diverge. The event schema speaks SEQ INTERVALS
 * (`[startSeq..endSeq]`), so the covered run is normalized to the ascending
 * interval [minSeq..maxSeq] of its segments — and refused honestly
 * ({@link CompactionNothingToCutError}) when that interval cannot express the
 * cut, because the fold apply would drop or reorder envelopes the plan keeps:
 *
 * - a foreign (uncovered) segment inside [minSeq..maxSeq] would be removed;
 * - a partially covered segment that is not the interval maximum would lose
 *   its kept remainder (the partial count binds only to `endSeq`);
 * - a lower-seq segment after the covered run would be pushed in front of
 *   the inserted summary, reordering the materialized history.
 */
function resolveSegmentRange(
  fold: SessionFold,
  coveredEnvelopeCount: number,
): {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly endEnvelopeCount: number;
} {
  let remaining = coveredEnvelopeCount;
  const touched: { readonly seq: number; readonly covered: number; readonly length: number }[] = [];
  for (const segment of fold.segments) {
    if (remaining <= 0) break;
    const covered = Math.min(remaining, segment.envelopes.length);
    touched.push({ seq: segment.seq, covered, length: segment.envelopes.length });
    remaining -= segment.envelopes.length;
  }
  if (remaining > 0 || touched.length === 0) {
    throw new TypeError(
      `Canonical compaction range ${String(coveredEnvelopeCount)} exceeds the folded history (${String(fold.envelopeCount)} envelopes).`,
    );
  }
  // The ascending seq interval of the covered run (the event's shape).
  let startSeq = touched[0]!.seq;
  let endSeq = touched[0]!.seq;
  for (const segment of touched) {
    if (segment.seq < startSeq) startSeq = segment.seq;
    if (segment.seq > endSeq) endSeq = segment.seq;
  }
  const insideInterval = (segment: FoldSegment): boolean =>
    segment.seq >= startSeq && segment.seq <= endSeq;
  const foreign = fold.segments.find(
    (segment) => insideInterval(segment) && !touched.some((t) => t.seq === segment.seq),
  );
  if (foreign !== undefined) {
    throw new CompactionNothingToCutError(
      `Canonical compaction plan cannot cover ${String(coveredEnvelopeCount)} envelopes as a contiguous seq range (uncovered segment ${String(foreign.seq)} sits inside [${String(startSeq)}..${String(endSeq)}]); there is nothing this round can cut on this window.`,
    );
  }
  const lastTouched = touched[touched.length - 1]!;
  if (lastTouched.covered < lastTouched.length && lastTouched.seq !== endSeq) {
    throw new CompactionNothingToCutError(
      `Canonical compaction plan cannot cover ${String(coveredEnvelopeCount)} envelopes as a contiguous seq range (the partially covered segment ${String(lastTouched.seq)} is not the range maximum ${String(endSeq)}); there is nothing this round can cut on this window.`,
    );
  }
  // The covered run is a list prefix; anything after it with a seq below the
  // interval start would be pushed in front of the inserted summary by the
  // fold apply — a reordering the plan never asked for.
  for (const segment of fold.segments.slice(touched.length)) {
    if (segment.seq < startSeq) {
      throw new CompactionNothingToCutError(
        `Canonical compaction plan cannot cover ${String(coveredEnvelopeCount)} envelopes as a contiguous seq range (segment ${String(segment.seq)} below the range start ${String(startSeq)} follows the covered run); there is nothing this round can cut on this window.`,
      );
    }
  }
  const endSegment = touched.find((segment) => segment.seq === endSeq)!;
  return { startSeq, endSeq, endEnvelopeCount: endSegment.covered };
}

/**
 * Applies a `compaction.replace`: removes the covered range
 * `[startSeq..endSeq]` (envelope-level via `endEnvelopeCount`), inserts the
 * event's envelopes where the prefix stood, and stamps the event's
 * generation. Everything after `endSeq` — the live suffix — survives by
 * construction.
 */
function applyFoldCompactionReplace(
  fold: SessionFold,
  event: CompactionReplaceEvent,
  logicalSeq: number,
): void {
  if (fold.openCompaction?.compactionId !== event.compactionId) {
    throw new TypeError(
      `Durable history event compaction.replace has no matching open start (${event.compactionId}).`,
    );
  }
  requireGenerationGrowth(fold, event.generation, event.kind);
  const startSegment = fold.segments.find((segment) => segment.seq === event.startSeq);
  if (!startSegment) {
    throw new TypeError(
      `Durable history event compaction.replace startSeq ${String(event.startSeq)} matches no segment.`,
    );
  }
  const endSegment = fold.segments.find((segment) => segment.seq === event.endSeq);
  if (!endSegment) {
    throw new TypeError(
      `Durable history event compaction.replace endSeq ${String(event.endSeq)} matches no segment.`,
    );
  }
  if (
    event.endEnvelopeCount < 0 ||
    event.endEnvelopeCount > endSegment.envelopes.length ||
    (event.startSeq === event.endSeq && event.endEnvelopeCount > startSegment.envelopes.length)
  ) {
    throw new TypeError(
      `Durable history event compaction.replace endEnvelopeCount ${String(event.endEnvelopeCount)} is out of the end segment's bounds.`,
    );
  }
  const nextSegments: FoldSegment[] = [];
  let insertedPlaced = false;
  for (const segment of fold.segments) {
    if (segment.seq < event.startSeq) {
      nextSegments.push(segment);
      continue;
    }
    if (segment.seq > event.endSeq) {
      if (!insertedPlaced) {
        nextSegments.push({ seq: logicalSeq, envelopes: [...event.inserted] });
        insertedPlaced = true;
      }
      nextSegments.push(segment);
      continue;
    }
    // Covered segment. A partially covered end segment keeps its remainder —
    // the live suffix — after the inserted envelopes.
    if (segment.seq === event.endSeq && event.endEnvelopeCount < segment.envelopes.length) {
      nextSegments.push({ seq: logicalSeq, envelopes: [...event.inserted] });
      insertedPlaced = true;
      nextSegments.push({
        seq: segment.seq,
        envelopes: segment.envelopes.slice(event.endEnvelopeCount),
      });
    }
    // Fully covered segments disappear.
  }
  if (!insertedPlaced) {
    nextSegments.push({ seq: logicalSeq, envelopes: [...event.inserted] });
  }
  (fold as { segments: FoldSegment[] }).segments = nextSegments;
  (fold as { envelopeCount: number }).envelopeCount = sumEnvelopeCount(nextSegments);
  (fold as { generation: number }).generation = event.generation;
  (fold as {
    lastCompaction: { readonly compactionId: string; readonly summaryText: string } | undefined;
  }).lastCompaction = {
    compactionId: event.compactionId,
    summaryText: readInsertedSummaryText(event.inserted),
  };
  // The attempt stays OPEN until its `compaction.end` — the end event closes it.
}

/** The summary text of a replace event's inserted envelopes (exactly one native summary). */
function readInsertedSummaryText(
  inserted: readonly CanonicalHistoryEnvelope[],
): string {
  for (const envelope of inserted) {
    if (envelope.message.role !== 'compactionSummary') continue;
    const summary = (envelope.message as { summary?: unknown })['summary'];
    return typeof summary === 'string' ? summary : '';
  }
  return '';
}

function sumEnvelopeCount(segments: readonly FoldSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.envelopes.length, 0);
}

/** Applies a `repair` event: truncate the trailing envelopes, then append the synthesized ones. */
function applyFoldRepair(fold: SessionFold, event: RepairEvent, logicalSeq: number): void {
  requireGenerationGrowth(fold, event.generation, event.kind);
  if (event.truncateTo !== undefined) {
    if (event.truncateTo > fold.envelopeCount) {
      throw new TypeError(
        `Durable history event repair truncates past the history (${String(event.truncateTo)} > ${String(fold.envelopeCount)}).`,
      );
    }
    (fold as { segments: FoldSegment[] }).segments = truncateSegments(fold.segments, event.truncateTo);
    (fold as { envelopeCount: number }).envelopeCount = event.truncateTo;
  }
  if (event.appended.length > 0) {
    pushFoldSegment(fold, { seq: logicalSeq, envelopes: [...event.appended] });
  }
  (fold as { generation: number }).generation = event.generation;
  (fold as { deleted: boolean }).deleted = false;
}

function truncateSegments(
  segments: readonly FoldSegment[],
  keep: number,
): FoldSegment[] {
  const next: FoldSegment[] = [];
  let remaining = keep;
  for (const segment of segments) {
    if (remaining <= 0) break;
    if (segment.envelopes.length <= remaining) {
      next.push(segment);
      remaining -= segment.envelopes.length;
    } else {
      next.push({ seq: segment.seq, envelopes: segment.envelopes.slice(0, remaining) });
      remaining = 0;
    }
  }
  return next;
}

/**
 * Applies a TEXT offload event (wave 2, item 2.4): the envelope at
 * `(seq, blockIdx)` keeps its role and every non-text block (media,
 * tool-call metadata), while its text blocks collapse into ONE text block
 * carrying the stub receipt. Fail-closed on a foreign position — a delta that
 * cannot be applied is a corrupt log, never a partially trusted history.
 */
function applyFoldTextOffload(fold: SessionFold, event: OffloadEvent): void {
  const segmentIndex = fold.segments.findIndex((segment) => segment.seq === event.seq);
  if (segmentIndex === -1) {
    throw new TypeError(
      `Durable history event offload names no segment (seq ${String(event.seq)}).`,
    );
  }
  const segment = fold.segments[segmentIndex]!;
  if (event.blockIdx >= segment.envelopes.length) {
    throw new TypeError(
      `Durable history event offload blockIdx ${String(event.blockIdx)} is out of the segment's bounds (${String(segment.envelopes.length)} envelopes).`,
    );
  }
  const envelope = segment.envelopes[event.blockIdx]!;
  const content = (envelope.message as { content?: unknown }).content;
  const receiptBlock = { type: 'text', text: event.replacement };
  let nextMessage: Record<string, unknown>;
  if (Array.isArray(content)) {
    const others = content.filter(
      (block) => block && typeof block === 'object' && (block as { type?: unknown })['type'] !== 'text',
    );
    nextMessage = {
      ...(envelope.message as Record<string, unknown>),
      content: [receiptBlock, ...others],
    };
  } else {
    // A string-content message externalizes to the receipt text alone.
    nextMessage = {
      ...(envelope.message as Record<string, unknown>),
      content: event.replacement,
    };
  }
  const nextEnvelopes = segment.envelopes.slice();
  nextEnvelopes[event.blockIdx] = {
    ...envelope,
    message: nextMessage as unknown as CanonicalHistoryEnvelope['message'],
  };
  const nextSegments = fold.segments.slice();
  nextSegments[segmentIndex] = { seq: segment.seq, envelopes: nextEnvelopes };
  (fold as { segments: FoldSegment[] }).segments = nextSegments;
  // The envelope count is unchanged — a content replacement, not a range cut.
}

// ---------------------------------------------------------------------------
// Write-side planning: the replace range over the CURRENT fold (canon 1.4)
// ---------------------------------------------------------------------------

export interface CompactionReplaceRange {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly endEnvelopeCount: number;
  /** The covered envelopes (the summary's source, for the size property). */
  readonly covered: readonly CanonicalHistoryEnvelope[];
}

/**
 * A compaction round whose covered range is DEGENERATE for the event schema:
 * the window offers the protocol nothing it can cut (an empty/zero-covered
 * cut, or a covered prefix the fold's segment layout cannot express as the
 * ascending seq interval the `compaction.replace` event carries). This is an
 * honest refusal of the round — NOT a contract violation: nothing is written,
 * the breaker must not open, the same snapshot is not re-run (incident
 * 2026-11-07, mvs_70b7f22: the second compaction on an already-compacted
 * window wrote a replace with an inverted seq range and tripped the breaker
 * as `contract_violation`).
 */
export class CompactionNothingToCutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactionNothingToCutError';
  }
}

/**
 * Resolves and VALIDATES the range a compaction replace covers: the first
 * `coveredEnvelopeCount` envelopes of the CURRENT folded history. Properties
 * (canon 05 §2.1/§3 1.4 — свойства, а не форма):
 *
 * - the covered prefix is non-empty and within the history;
 * - `startSeq`/`endSeq` resolve against existing segments, `endSeq ≤ head`;
 * - the covered run IS expressible as the event's ascending seq interval
 *   (nothing uncovered inside it, no partially covered segment below the
 *   range maximum, no lower-seq segment after the covered run — the fold
 *   apply would otherwise drop or reorder envelopes the plan keeps);
 * - the boundary does not cut a tool round (the last covered envelope has no
 *   unclosed calls; the first kept envelope is not a tool result whose call
 *   the summary would strand);
 * - the summary is non-empty and smaller than the source it replaces;
 * - `baseGeneration` equals the CURRENT fold generation (an append between
 *   the plan and the commit does NOT invalidate — a repair/adopt/replace
 *   does, through the generation growth).
 */
export function resolveCompactionReplaceRange(
  fold: SessionFold,
  options: {
    readonly coveredEnvelopeCount: number;
    readonly inserted: readonly CanonicalHistoryEnvelope[];
    readonly summaryText: string;
    readonly baseGeneration: number;
  },
): CompactionReplaceRange {
  const { coveredEnvelopeCount, inserted, summaryText, baseGeneration } = options;
  if (baseGeneration !== fold.generation) {
    throw new TypeError(
      `Canonical compaction plan is stale: the plan was built on generation ${String(baseGeneration)}, the history moved to ${String(fold.generation)}. Rebuild the plan against the current history.`,
    );
  }
  if (!summaryText.trim()) {
    throw new TypeError('Canonical compaction summary must be non-empty.');
  }
  if (
    !Number.isSafeInteger(coveredEnvelopeCount) ||
    coveredEnvelopeCount < 1 ||
    coveredEnvelopeCount > fold.envelopeCount
  ) {
    throw new CompactionNothingToCutError(
      `Canonical compaction plan covers no source envelopes (${String(coveredEnvelopeCount)} of ${String(fold.envelopeCount)}); there is nothing this round can cut on this window.`,
    );
  }
  if (inserted.length === 0) {
    throw new TypeError('Canonical compaction replace inserts no envelopes.');
  }
  const active = materializeFold(fold);
  const covered = active.slice(0, coveredEnvelopeCount);
  const lastCovered = covered[covered.length - 1];
  if (lastCovered && lastCovered.message.role === 'assistant') {
    const unclosed = unclosedToolCallCount(lastCovered.message, covered);
    if (unclosed > 0) {
      throw new TypeError(
        'Canonical compaction plan cuts a tool round: the last covered envelope is an assistant with unclosed tool calls.',
      );
    }
  }
  if (coveredEnvelopeCount < fold.envelopeCount) {
    const firstKept = active[coveredEnvelopeCount];
    if (firstKept?.message.role === 'toolResult') {
      throw new TypeError(
        'Canonical compaction plan cuts a tool round: the first kept envelope is a tool result of a covered call.',
      );
    }
  }
  const coveredBytes = JSON.stringify(covered).length;
  const insertedBytes = JSON.stringify(inserted).length;
  if (insertedBytes >= coveredBytes) {
    throw new TypeError(
      `Canonical compaction summary is not smaller than its source (${String(insertedBytes)} ≥ ${String(coveredBytes)} bytes); refusing an ineffective replace.`,
    );
  }
  // The segment-range expressibility check comes LAST among the plan
  // properties: a plan that is already broken (a summary that cannot shrink,
  // a cut through a tool round) is a CONTRACT violation — the breaker class —
  // while a VALID plan the fold's segment layout cannot express is the
  // honest nothing-to-cut refusal (a degenerate window, not a breach).
  const range = resolveSegmentRange(fold, coveredEnvelopeCount);
  if (range.endSeq > fold.headSeq) {
    throw new TypeError(
      `Canonical compaction plan endSeq ${String(range.endSeq)} exceeds the session head ${String(fold.headSeq)}.`,
    );
  }
  return { ...range, covered };
}

function unclosedToolCallCount(
  message: CanonicalHistoryEnvelope['message'],
  covered: readonly CanonicalHistoryEnvelope[],
): number {
  const content = (message as { content?: unknown })['content'];
  if (!Array.isArray(content)) return 0;
  const callIds: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown })['type'] === 'toolCall' &&
      typeof (block as { id?: unknown })['id'] === 'string'
    ) {
      callIds.push((block as { id: string })['id']);
    }
  }
  if (callIds.length === 0) return 0;
  const closed = new Set<string>();
  for (const envelope of covered) {
    if (envelope.message.role !== 'toolResult') continue;
    const toolCallId = (envelope.message as { toolCallId?: unknown })['toolCallId'];
    if (typeof toolCallId === 'string') closed.add(toolCallId);
  }
  return callIds.filter((id) => !closed.has(id)).length;
}

// ---------------------------------------------------------------------------
// Lease of an open compaction.start (canon 1.6, owner decision: 600s)
// ---------------------------------------------------------------------------

/**
 * Lease window of an unclosed `compaction.start` written by THIS instance
 * (the owner's decision: 600s — it must cover a legitimate compaction
 * including the provider timeout with headroom; it only ever binds a leaked
 * same-instance attempt, because a cross-instance start belongs to a dead
 * process and is abandoned at once).
 */
export const COMPACTION_START_LEASE_MS = 600_000;

export type OpenCompactionLease = 'none' | 'close-abandoned' | 'close-committed' | 'refuse';

export function resolveOpenCompactionLease(
  fold: SessionFold,
  writerToken: string,
  nowMs: number,
  leaseMs = COMPACTION_START_LEASE_MS,
): OpenCompactionLease {
  const open = fold.openCompaction;
  if (!open) return 'none';
  // A durable replace is the commit point; a missing terminal receipt cannot
  // turn an installed summary into an abandoned attempt or hold its lease.
  if (fold.lastCompaction?.compactionId === open.compactionId) return 'close-committed';
  if (open.writerToken !== writerToken) return 'close-abandoned';
  if (nowMs - open.startedAtMs > leaseMs) return 'close-abandoned';
  return 'refuse';
}

// ---------------------------------------------------------------------------
// Fold checkpoint (canon 1.3: выбрасываемый кэш для холодного старта)
// ---------------------------------------------------------------------------

export const FOLD_CHECKPOINT_SCHEMA = 1;

/**
 * Disposable cold-start cache of one session's fold: the folded state as of
 * the log position `backendSeq` (the backend commit seq the checkpoint was
 * written at). Deleting the file changes nothing — the fold recomputes from
 * the log. A generation mismatch (the backend rotated to a new, empty
 * generation file) discards the cache.
 */
export interface FoldCheckpoint {
  readonly schema: typeof FOLD_CHECKPOINT_SCHEMA;
  readonly sessionId: string;
  readonly backendSeq: number;
  readonly backendGeneration: number;
  /**
   * Carrier identity of the log the checkpoint was read/written against —
   * the backend's `directory` (the legacy monolith directory, or the
   * session's own file directory in the per-session model). Checkpoints
   * written before the per-session model carry no field (undefined): they
   * can only ever match the monolith — a per-session file with the same
   * `backendGeneration` must never resume from their position.
   */
  readonly backendDirectory?: string;
  readonly fold: {
    readonly headSeq: number;
    readonly generation: number;
    readonly deleted: boolean;
    readonly lastEntryId: string | undefined;
    readonly openCompaction: OpenCompactionFold | undefined;
    readonly lastCompaction:
      | { readonly compactionId: string; readonly summaryText: string }
      | undefined;
    /** Envelope count of each segment, in order (partitions `envelopes`). */
    readonly segmentCounts: readonly number[];
    readonly segmentSeqs: readonly number[];
    readonly envelopes: readonly CanonicalHistoryEnvelope[];
  };
}

export function serializeFoldCheckpoint(
  sessionId: string,
  fold: SessionFold,
  backendSeq: number,
  backendGeneration: number,
  backendDirectory?: string,
): string {
  const checkpoint: FoldCheckpoint = {
    schema: FOLD_CHECKPOINT_SCHEMA,
    sessionId,
    backendSeq,
    backendGeneration,
    ...(backendDirectory !== undefined ? { backendDirectory } : {}),
    fold: {
      headSeq: fold.headSeq,
      generation: fold.generation,
      deleted: fold.deleted,
      lastEntryId: fold.lastEntryId,
      openCompaction: fold.openCompaction,
      lastCompaction: fold.lastCompaction,
      segmentCounts: fold.segments.map((segment) => segment.envelopes.length),
      segmentSeqs: fold.segments.map((segment) => segment.seq),
      envelopes: materializeFold(fold),
    },
  };
  return JSON.stringify(checkpoint);
}

/**
 * Parses a fold checkpoint. Returns `undefined` on ANY mismatch — the cache
 * is disposable and must never poison the fold (a malformed or foreign
 * checkpoint falls back to the full log scan).
 */
export function parseFoldCheckpoint(
  sessionId: string,
  raw: string,
): FoldCheckpoint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record['schema'] !== FOLD_CHECKPOINT_SCHEMA || record['sessionId'] !== sessionId) {
    return undefined;
  }
  if (
    typeof record['backendSeq'] !== 'number' ||
    typeof record['backendGeneration'] !== 'number'
  ) {
    return undefined;
  }
  if (
    record['backendDirectory'] !== undefined &&
    typeof record['backendDirectory'] !== 'string'
  ) {
    return undefined;
  }
  const foldRecord = record['fold'];
  if (!foldRecord || typeof foldRecord !== 'object' || Array.isArray(foldRecord)) {
    return undefined;
  }
  const fold = foldRecord as Record<string, unknown>;
  const envelopes = fold['envelopes'];
  const segmentCounts = fold['segmentCounts'];
  const segmentSeqs = fold['segmentSeqs'];
  if (
    !Array.isArray(envelopes) ||
    !Array.isArray(segmentCounts) ||
    !Array.isArray(segmentSeqs) ||
    segmentCounts.length !== segmentSeqs.length
  ) {
    return undefined;
  }
  if (segmentCounts.reduce((sum: number, count) => sum + (typeof count === 'number' ? count : NaN), 0) !== envelopes.length) {
    return undefined;
  }
  if (typeof fold['headSeq'] !== 'number' || typeof fold['generation'] !== 'number') {
    return undefined;
  }
  for (const envelope of envelopes) {
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      typeof (envelope as { message_id?: unknown })['message_id'] !== 'string' ||
      typeof (envelope as { turn_id?: unknown })['turn_id'] !== 'string' ||
      !(envelope as { message?: unknown })['message']
    ) {
      return undefined;
    }
  }
  return parsed as FoldCheckpoint;
}

/** Rebuilds the fold from a parsed checkpoint (the segments re-partition the envelopes). */
export function foldFromCheckpoint(checkpoint: FoldCheckpoint): SessionFold {
  const { fold } = checkpoint;
  const segments: FoldSegment[] = [];
  let cursor = 0;
  for (let index = 0; index < fold.segmentCounts.length; index += 1) {
    const count = fold.segmentCounts[index]!;
    segments.push({
      seq: fold.segmentSeqs[index]!,
      envelopes: fold.envelopes.slice(cursor, cursor + count),
    });
    cursor += count;
  }
  return {
    segments,
    generation: fold.generation,
    headSeq: fold.headSeq,
    lastEntryId: fold.lastEntryId,
    deleted: fold.deleted,
    openCompaction: fold.openCompaction,
    lastCompaction: fold.lastCompaction,
    envelopeCount: fold.envelopes.length,
  };
}
