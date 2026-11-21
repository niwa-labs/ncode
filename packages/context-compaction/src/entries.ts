/**
 * Durable draft builders for the entry kinds this package owns.
 *
 * All payloads are plain JSON, structurally compatible with `EntryDraft` of
 * `@mavis/durable-backend-sqlite-zstd`. Building a draft never writes: the
 * caller appends it through its own persistence seam (backend, storage
 * worker, or an in-memory log in tests).
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import {
  COMPACTION_ENTRY_KIND,
  CONTEXT_EDIT_ENTRY_KIND,
  MESSAGE_ENTRY_KIND,
  SYSTEM_ENTRY_KIND,
  USAGE_ENTRY_KIND,
  type CompactionEntryPayload,
  type CompactionMessage,
  type ContextEditOmissionPayload,
  type DurableEntryDraft,
  type SummaryUsageDelta,
  type UsageEntryPayload,
} from './types.js';
import { isFrozenSystemMessage } from './frozen-system.js';

/**
 * Generate a reasonably unique entry id; callers may pass their own instead.
 * `randomUUID` keeps ids unique across process restarts — a Date.now +
 * counter scheme collides after a restart within the same clock tick, which
 * would violate the draft id's "unique across the whole log" contract.
 */
export function generateLogEntryId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Draft of one conversation-message entry (`mcode.message`). */
export function createMessageEntryDraft(
  id: string,
  message: CompactionMessage,
  parentId: string | null = null,
): DurableEntryDraft {
  return { id, parentId, kind: MESSAGE_ENTRY_KIND, payload: message };
}

/** Draft of one frozen-system-prompt entry (`mcode.system`). */
export function createSystemEntryDraft(id: string, text: string, parentId: string | null = null): DurableEntryDraft {
  return { id, parentId, kind: SYSTEM_ENTRY_KIND, payload: { text } };
}

/** Draft of one compaction checkpoint entry (`mcode.compaction`). */
export function createCompactionEntryDraft(
  id: string,
  payload: CompactionEntryPayload,
  parentId: string | null = null,
): DurableEntryDraft {
  return { id, parentId, kind: COMPACTION_ENTRY_KIND, payload };
}

/**
 * Draft of one context-edit omission entry (`mcode.context_edit`): hides the
 * target entries from projection without touching them in the log.
 */
export function createOmissionEntryDraft(
  id: string,
  targetIds: readonly string[],
  reason: string,
  now: () => number = Date.now,
  parentId: string | null = null,
): DurableEntryDraft {
  const payload: ContextEditOmissionPayload = {
    action: 'omission',
    targetIds: [...targetIds],
    reason,
    createdAtMs: now(),
  };
  return { id, parentId, kind: CONTEXT_EDIT_ENTRY_KIND, payload };
}

/**
 * Whether a summary usage delta carries no counters worth billing at all —
 * the same zero-drop pi's rendered billing applies (`getUsageCostBreakdown`
 * filters `cost > 0 || tokens > 0`). An all-zero/absent usage record must not
 * materialize a `mcode.usage` entry.
 */
export function isZeroSummaryUsage(delta: SummaryUsageDelta): boolean {
  const cost = delta.cost;
  const tokens =
    (delta.input ?? 0) + (delta.output ?? 0) + (delta.cacheRead ?? 0) + (delta.cacheWrite ?? 0);
  const costSum =
    (cost?.input ?? 0) + (cost?.output ?? 0) + (cost?.cacheRead ?? 0) + (cost?.cacheWrite ?? 0) + (cost?.total ?? 0);
  return tokens === 0 && costSum === 0 && (delta.totalTokens ?? 0) === 0;
}

/**
 * Draft of one usage entry (`mcode.usage`) recording spend that must bill but
 * never enter LLM context — the `summary` category records the summarizer's
 * own provider spend (pi carries the same numbers on the compaction entry,
 * billing bucket "Tools/summaries"; our declared writer mapping persists them
 * as an explicit usage entry instead).
 *
 * The transport-level delta is a subset (every counter optional); the payload
 * normalizes missing counters to `0` because the projection's strict
 * `UsagePayload` decoder requires the full shape. A delta with no counters at
 * all yields `undefined` — nothing is billed, nothing is written.
 */
export function createUsageEntryDraft(
  id: string,
  attribution: { readonly provider: string; readonly model: string },
  delta: SummaryUsageDelta,
  category: string,
  note?: string,
  parentId: string | null = null,
): DurableEntryDraft | undefined {
  if (isZeroSummaryUsage(delta)) return undefined;
  const cost = delta.cost;
  const payload: UsageEntryPayload = {
    kind: category,
    provider: attribution.provider,
    model: attribution.model,
    usage: {
      input: delta.input ?? 0,
      output: delta.output ?? 0,
      cacheRead: delta.cacheRead ?? 0,
      cacheWrite: delta.cacheWrite ?? 0,
      // pi's `calculateContextTokens`: `totalTokens` when the provider
      // reported it, else the sum of the token counters.
      totalTokens:
        delta.totalTokens ??
        (delta.input ?? 0) + (delta.output ?? 0) + (delta.cacheRead ?? 0) + (delta.cacheWrite ?? 0),
      cost: {
        input: cost?.input ?? 0,
        output: cost?.output ?? 0,
        cacheRead: cost?.cacheRead ?? 0,
        cacheWrite: cost?.cacheWrite ?? 0,
        total: cost?.total ?? 0,
      },
    },
    ...(note !== undefined && note.length > 0 ? { note } : {}),
  };
  return { id, parentId, kind: USAGE_ENTRY_KIND, payload };
}

const MESSAGE_ROLES: ReadonlySet<string> = new Set<CompactionMessage['role']>([
  'user',
  'assistant',
  'toolResult',
  'custom',
]);

/**
 * Structural guard for `mcode.message` payloads. A payload without a known
 * role (or with a content shape the estimator cannot walk) is dead weight:
 * the projection skips it and the usage tracker counts nothing for it — the
 * alternative is `estimateMessageTokens` falling through its exhaustive
 * switch, returning `undefined`, and poisoning the window totals into NaN on
 * a corrupt log.
 */
export function isCompactionMessagePayload(payload: unknown): payload is CompactionMessage {
  if (typeof payload !== 'object' || payload === null) return false;
  const role = (payload as { role?: unknown }).role;
  if (typeof role !== 'string' || !MESSAGE_ROLES.has(role)) return false;
  const record = payload as { content?: unknown; customType?: unknown };
  const isBlockList = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every((block) => typeof block === 'object' && block !== null && typeof (block as { type?: unknown }).type === 'string');
  switch (role) {
    case 'user':
      return typeof record.content === 'string' || isBlockList(record.content);
    case 'assistant':
    case 'toolResult':
      return isBlockList(record.content);
    case 'custom':
      return typeof record.customType === 'string';
  }
  // `role` is typed `string`, so the switch is not exhaustive to the checker.
  return false;
}

/**
 * Read back and validate a compaction payload. `undefined` when the entry is
 * not a well-formed compaction checkpoint (the projection skips foreign or
 * malformed entries rather than crashing on them).
 *
 * `systemMessage` has three legal spellings: the legacy prompt text
 * (`string`), retain-none (`null`), and the V-C09 full frozen SystemMessage
 * (object — validated by `isFrozenSystemMessage`). A record whose
 * systemMessage is none of these (missing included) is MALFORMED. Consumers
 * must treat it as plain audit noise, or `boundaryStartIndex` would park the
 * next cut range right after the malformed checkpoint (stranding every
 * earlier message outside both the window and the next summary) and
 * `previousSummaryOf` would feed a corrupt summary back into
 * UPDATE_SUMMARIZATION_PROMPT.
 */
export function parseCompactionEntry(entry: DurableEntryDraft): CompactionEntryPayload | undefined {
  if (entry.kind !== COMPACTION_ENTRY_KIND) return undefined;
  const payload = entry.payload as Partial<CompactionEntryPayload> | null;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.summary !== 'string' ||
    typeof payload.firstKeptEntryId !== 'string' ||
    !isLegalSystemMessage(payload.systemMessage)
  ) {
    return undefined;
  }
  return payload as CompactionEntryPayload;
}

/** `string | null | FrozenSystemMessage | undefined` — anything else is malformed. */
function isLegalSystemMessage(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string' || value === null) return true;
  return isFrozenSystemMessage(value);
}
