/**
 * The per-entry conversion stage (node `pi-convert-to-llm`, adapt decision).
 *
 * `convertEntry(entry, dialect)` turns one durable entry into its provider
 * record deterministically: the same entry bytes and dialect version always
 * produce byte-identical output. The wire compiler memoizes this stage by
 * `(entryId, dialect, normalizerVersion)` — see {@link compileKey}.
 *
 * Role/content rules per the `minimax-m3` dialect:
 * - `pi.system` → `system`; `pi.user` → `user`;
 * - `pi.assistant` → `assistant` with text blocks and tool-call deltas;
 *   thinking blocks are cut;
 * - `pi.tool-result` → `tool` correlated by `toolCallId`;
 * - `mcode.owner-input.placed` → the executed user input (dedup upstream);
 * - `mcode.system-reminder` → a user record flagged `tail: true`;
 * - audit/control kinds (other `mcode.*`) convert to `null` — they are
 *   excluded from the provider payload by the steering D+C contract.
 *
 * Legacy embedded `<system-reminder>` blocks split into tail records via
 * {@link convertEntryTails}. Immutable canonical `session.message` records
 * retain their full text in log order, including embedded reminders.
 */

import { isAuditControlKind, isPlacedEntryKind, isReminderEntryKind } from './audit.js';
import { compileBatchKey, compileKey } from './dialect.js';
import { decodeEntryPayload, type DecodedMessage, type DecodedPart } from './decode.js';
import {
  buildCompiledEntry,
  buildReminderTail,
  splitUserReminders,
} from './reminders.js';
import type { CompiledEntry, Dialect, DurableEntry, RecordImageBlock } from './types.js';
import { bashExecutionToText, branchSummaryText, compactionSummaryText } from './tags.js';
import { MINIMAX_M3_DIALECT } from './dialect.js';

/** The image part shape {@link ImageRendering}'s callback receives. */
export type DecodedImagePart = Extract<DecodedPart, { readonly type: 'image' }>;

/**
 * Per-request rendering override for image parts — the Context-MMU residency
 * overlay (Ф2 R2) on the conversion stage. Absent (the default), every image
 * renders as the dialect's deterministic placeholder and the record depends
 * only on `(entry, dialect)`. Present, a RESIDENT page renders its real bytes
 * instead; a digest page keeps the placeholder by returning `undefined` from
 * the callback.
 *
 * Two rendering modes exist:
 * - `renderImage` — the resident bytes ride the TEXT as a data URL string.
 * - `renderImageBlock` (wave-0 item 0.5) — the resident bytes ride the record
 *   STRUCTURED ({@link RecordImageBlock}; the provider payload gets a real
 *   image block after hydration). A present `renderImageBlock` takes
 *   precedence over `renderImage`.
 *
 * Because two renderings of the SAME entry produce different bytes,
 * {@link ImageRendering.cacheState} MUST distinguish their cache keys — the
 * wire path folds it into the wire identity too, so the segment cache never
 * serves one state's bytes under the other's key.
 */
export interface ImageRendering {
  /** Renders one image part; `undefined` falls back to the dialect placeholder. */
  readonly renderImage?: (part: DecodedImagePart) => string | undefined;
  /**
   * Renders one image part as a STRUCTURED image block; `undefined` falls
   * back to `renderImage`/the placeholder. The block's position in the
   * record text is marked by {@link imageBlockMarker}.
   */
  readonly renderImageBlock?: (part: DecodedImagePart) => RecordImageBlock | undefined;
  /** Cache-state tag of this rendering (e.g. `resident@<sha16>` of the resident page). */
  readonly cacheState?: string;
}

/**
 * Control character the record text uses to mark where a structured image
 * block rides (`\u0000mcode-image:<index>\u0000`, zero-based index into the
 * record's `images`). The control byte cannot appear in provider-bound text
 * (entries are JSON at rest and pi text never carries NUL), so hydration
 * splitting is unambiguous. The NDJSON wire body carries the marker inside
 * `content` — a consumer that serves the raw body without hydration (none in
 * the runtime) would show the marker, never silently lose the image fact.
 */
const IMAGE_BLOCK_MARK = '\u0000mcode-image:';

/** The marker token for the record's `index`-th structured image block. */
export function imageBlockMarker(index: number): string {
  return `${IMAGE_BLOCK_MARK}${index}\u0000`;
}

/** Splits record text into text segments and structured-image indexes, in order. */
export function splitImageBlockMarkers(
  text: string,
): { readonly segments: readonly string[]; readonly imageIndexes: readonly number[] } {
  const segments: string[] = [];
  const imageIndexes: number[] = [];
  let segmentStart = 0;
  let searchFrom = 0;
  for (;;) {
    const index = text.indexOf(IMAGE_BLOCK_MARK, searchFrom);
    if (index === -1) break;
    const endIndex = text.indexOf('\u0000', index + IMAGE_BLOCK_MARK.length);
    if (endIndex === -1) break; // Unterminated marker: the tail stays raw text.
    const parsed = Number(text.slice(index + IMAGE_BLOCK_MARK.length, endIndex));
    if (!Number.isInteger(parsed) || parsed < 0) {
      // Not a well-formed marker: the bytes stay in the current segment; the
      // scan resumes past this candidate.
      searchFrom = index + 1;
      continue;
    }
    segments.push(text.slice(segmentStart, index));
    imageIndexes.push(parsed);
    segmentStart = endIndex + 1;
    searchFrom = segmentStart;
  }
  segments.push(text.slice(segmentStart));
  return { segments, imageIndexes };
}

/**
 * Renders decoded parts to provider text. `images` (when given) is the
 * collector this call's structured image blocks append to, in part order;
 * an image part rendered as a block leaves an {@link imageBlockMarker} token
 * in the text at its exact position.
 */
function renderParts(
  parts: readonly DecodedPart[],
  dialect: Dialect,
  images?: ImageRendering,
  imageCollector?: RecordImageBlock[],
): string {
  const rendered: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      rendered.push(part.text);
      continue;
    }
    // The rendering owns the decision — wave 2 (canon §2.5): an OFFLOADED
    // image part carries a REFERENCE instead of `data`, and a resident one
    // renders through `renderImageBlock` with the bytes resolved back out of
    // the artifact store. A callback that only handles inline data returns
    // `undefined` here and the placeholder path below applies, exactly as
    // before.
    const block = images?.renderImageBlock?.(part);
    if (block !== undefined && imageCollector !== undefined) {
      imageCollector.push(block);
      rendered.push(imageBlockMarker(imageCollector.length - 1));
      continue;
    }
    const override = images?.renderImage?.(part);
    rendered.push(override === undefined ? dialect.imagePlaceholder(part.mimeType) : override);
  }
  return rendered.join(dialect.textJoin);
}

/**
 * Cache key of a record under an optional rendering override — the key the
 * wire compiler's consumers memoize the per-entry stage by: `(entryId,
 * dialect, normalizerVersion)`, extended with the rendering's `cacheState`
 * (e.g. `resident@<sha16>`) when one is active, so the two renderings of the
 * same entry never share memoized bytes.
 */
export function recordCacheKey(entryId: string, dialect: Dialect, images: ImageRendering | undefined): string {
  return images?.cacheState === undefined ? compileKey(entryId, dialect) : `${compileKey(entryId, dialect)}@${images.cacheState}`;
}

/** Convert one decoded message to its provider record fields. */
function convertMessage(
  message: DecodedMessage,
  dialect: Dialect,
  images?: ImageRendering,
  imageCollector?: RecordImageBlock[],
): Pick<
  CompiledEntry,
  'role' | 'content' | 'toolCalls' | 'toolCallId' | 'toolName' | 'isError'
> {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: renderParts(message.parts, dialect, images, imageCollector) };
    case 'user':
      return { role: 'user', content: renderParts(message.parts, dialect, images, imageCollector) };
    case 'assistant': {
      return {
        role: 'assistant',
        content: renderParts(message.parts, dialect),
        toolCalls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    case 'toolResult':
      // The residency overlay renders toolResult images too — screenshots are
      // how the model receives fresh visuals (wave-0 item 0.5).
      return {
        role: 'tool',
        content: renderParts(message.parts, dialect, images, imageCollector),
        toolCallId: message.toolCallId ?? '',
        toolName: message.toolName ?? '',
        isError: message.isError === true,
      };
    // pi conversion tags (V-C10): every tag role becomes a USER record with
    // the pi template text — pi `convertToLlm` (coding-agent core/messages.ts)
    // semantics, byte-exact templates from ./tags.js. The `!!` exclusion
    // (`excludeFromContext`) drops the record entirely (pi returns undefined).
    case 'bashExecution': {
      const fields = message.tag?.bashExecution;
      return fields === undefined ? { role: 'user', content: '' } : { role: 'user', content: bashExecutionToText(fields) };
    }
    case 'custom':
      return { role: 'user', content: renderParts(message.parts, dialect, images, imageCollector) };
    case 'branchSummary': {
      const fields = message.tag?.branchSummary;
      return fields === undefined ? { role: 'user', content: '' } : { role: 'user', content: branchSummaryText(fields) };
    }
    case 'compactionSummary': {
      const fields = message.tag?.compactionSummary;
      return fields === undefined
        ? { role: 'user', content: '' }
        : { role: 'user', content: compactionSummaryText(fields) };
    }
  }
}

/**
 * Convert one durable entry into its primary provider record.
 *
 * Returns `null` when the entry carries no provider content: audit/control
 * kinds, `pi.reset` boundaries, undecodable payloads, system entries with
 * empty content, and user entries whose text is fully consumed by reminder
 * extraction (the text lives on in the tail records instead).
 *
 * Deterministic: identical `(entry, dialect, images)` inputs produce
 * identical records, byte for byte. Reminder TAIL records are exempt from
 * the override on purpose — a tail's bytes are its reminder block, which no
 * image rendering can touch.
 */
export function convertEntry(
  entry: DurableEntry,
  dialect: Dialect = MINIMAX_M3_DIALECT,
  images?: ImageRendering,
): CompiledEntry | null {
  if (isAuditControlKind(entry.kind)) return null;

  if (isReminderEntryKind(entry.kind)) {
    const decoded = decodeEntryPayload(entry.kind, entry.payload);
    if (decoded.reminderText === undefined) return null;
    return buildReminderTail(entry.id, entry.kind, decoded.reminderText, dialect);
  }

  const decoded = decodeEntryPayload(entry.kind, entry.payload);
  const message = decoded.messages[0];
  // pi-durable writes exactly one model message per entry; extra elements are
  // ignored on purpose — a multi-message payload would make the per-entry
  // cache key ambiguous. The writer contract, not the reader, owns this.
  if (message === undefined) return null;

  // The `!!` prefix: pi's `excludeFromContext` drops the bash execution from
  // LLM context entirely (pi convertToLlm returns undefined for it).
  if (message.role === 'bashExecution' && message.tag?.bashExecution?.excludeFromContext === true) {
    return null;
  }

  const imageCollector: RecordImageBlock[] = [];
  const fields = convertMessage(message, dialect, images, imageCollector);

  if (fields.role === 'user') {
    const text = fields.content;
    // Canonical session messages are already immutable, positioned history.
    // Moving their embedded reminders to the request tail resurrects obsolete
    // todo/unread-task snapshots AFTER the tool results that settled them.
    // Keeping the entire record in place also makes the whole prior request
    // an append-only cache prefix, including its reminders.
    const residual = entry.kind === 'session.message'
      ? text
      : splitUserReminders(entry.id, entry.kind, text, dialect).residualText;
    // Either reminders consumed the whole text (it lives on in the tails) or
    // the entry carried no provider-visible content at all; an empty user
    // record would only confuse the provider.
    if (residual.trim().length === 0 && imageCollector.length === 0) return null;
    return buildCompiledEntry({
      cacheKey: recordCacheKey(entry.id, dialect, images),
      entryId: entry.id,
      sourceEntryIds: [entry.id],
      kind: entry.kind,
      role: 'user',
      content: residual,
      tail: false,
      ...(imageCollector.length > 0 ? { images: [...imageCollector] } : {}),
      ...(isPlacedEntryKind(entry.kind) && decoded.inputEntryId !== undefined
        ? { inputEntryId: decoded.inputEntryId }
        : {}),
    });
  }

  // An empty system record (positional prompt / tool change) is prefix noise.
  if (fields.role === 'system' && fields.content.trim().length === 0) return null;

  return buildCompiledEntry({
    cacheKey: recordCacheKey(entry.id, dialect, images),
    entryId: entry.id,
    sourceEntryIds: [entry.id],
    kind: entry.kind,
    role: fields.role,
    content: fields.content,
    tail: false,
    ...(imageCollector.length > 0 ? { images: [...imageCollector] } : {}),
    ...(fields.toolCalls !== undefined ? { toolCalls: fields.toolCalls } : {}),
    ...(fields.toolCallId !== undefined ? { toolCallId: fields.toolCallId } : {}),
    ...(fields.toolName !== undefined ? { toolName: fields.toolName } : {}),
    ...(fields.isError !== undefined ? { isError: fields.isError } : {}),
  });
}

/**
 * Extract the reminder tail records of one entry: user entries yield the
 * `<system-reminder>` blocks split out of the stored text. Order is source
 * order; ids of split-out records are `entryId#reminder:N`.
 *
 * Dedicated `mcode.system-reminder` entries return `[]` here on purpose —
 * their tail record is the entry's own conversion result (see
 * {@link convertEntry}), so callers never see it twice.
 */
export function convertEntryTails(
  entry: DurableEntry,
  dialect: Dialect = MINIMAX_M3_DIALECT,
): readonly CompiledEntry[] {
  if (entry.kind === 'session.message') return [];
  if (isReminderEntryKind(entry.kind)) return [];
  if (isAuditControlKind(entry.kind)) return [];

  const decoded = decodeEntryPayload(entry.kind, entry.payload);
  const message = decoded.messages[0];
  if (message === undefined || message.role !== 'user') return [];

  const text = renderParts(message.parts, dialect);
  return splitUserReminders(entry.id, entry.kind, text, dialect).tails;
}

/**
 * Convert an immediate-send batch group into one merged user record (the
 * `outbound-message-normalizer` semantics: members join with a blank line,
 * later members merge into the first member's position). The cache key is
 * derived from every member id, so appending a member changes the key instead
 * of reusing stale bytes.
 */
export function convertBatch(
  entries: readonly DurableEntry[],
  dialect: Dialect = MINIMAX_M3_DIALECT,
): CompiledEntry | null {
  const first = entries[0];
  if (first === undefined) return null;
  const contents: string[] = [];
  for (const entry of entries) {
    const record = convertEntry(entry, dialect);
    if (record !== null && record.role === 'user') contents.push(record.content);
    // Tails of batch members still surface through convertEntryTails.
  }
  if (contents.length === 0) return null;
  const ids = entries.map((entry) => entry.id);
  return buildCompiledEntry({
    cacheKey: compileBatchKey(ids, dialect),
    entryId: first.id,
    sourceEntryIds: ids,
    kind: first.kind,
    role: 'user',
    content: contents.join(dialect.batchJoin),
    tail: false,
  });
}
