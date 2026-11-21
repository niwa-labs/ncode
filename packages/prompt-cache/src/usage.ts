// cache_warm usage writer (W06 part B; closes the W05 V-U02 deferral row
// «cache_warm — DEFERRED W06 (CacheWarmer ещё не существует; волна provider
// wire/prompt-cache)», state/w05.md section "V-U02 writer deferral").
//
// The pin records every successful refresh as a standalone usage entry:
// `sessionManager.appendUsage("cache_warm", message.provider,
// message.responseModel ?? message.model, message.usage, note?)`
// (coding-agent cache-warmer.ts refresh()); pi bills it under the session's
// usage totals with kind "cache_warm" and the `/session` view renders it via
// `formatCacheWarmingUsage`. Our declared writer mapping (W05) persists the
// same numbers as an EXPLICIT `mcode.usage` durable entry under the
// `cache_warm` category — the projection folds it under BOTH axes
// (provider/model billing + the writer-defined category) and it NEVER enters
// the LLM context (control kind), so a warm refresh cannot pollute the
// context-token trigger (V-U02: "warming не загрязняют context token trigger").
//
// The durable shapes are declared locally, structurally identical to
// `@mavis/context-compaction`'s `DurableEntryDraft`/`UsageEntryPayload` and
// `@mavis/context-projection`'s strict `UsagePayload` decoder (pinned equal by
// the cross-package test) — the same zero-dependency layout the compaction
// package uses.

import { randomUUID } from 'node:crypto';

import type { Usage } from '@earendil-works/pi-ai';

/** Writer-defined usage category of prompt-cache warming spend (pin kind). */
export const CACHE_WARM_USAGE_KIND = 'cache_warm';

/** Durable entry kind of the billing mirror (`mcode.usage`, control kind — never LLM context). */
export const CACHE_WARM_USAGE_ENTRY_KIND = 'mcode.usage';

/** Durable draft of one entry (structural copy of the compaction package's contract). */
export interface DurableEntryDraft {
  /** Stable application identity, unique across the whole log. */
  readonly id: string;
  /** Log position of the predecessor entry; `null`/`undefined` for the first. */
  readonly parentId?: string | null;
  /** Application-defined discriminator — `mcode.*` kinds. */
  readonly kind: string;
  /** JSON payload stored inside the batch frame. */
  readonly payload: unknown;
}

/** Full counter shape of one usage record (pi `Usage` minus transport optionals). */
export interface WarmUsageDelta {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

/**
 * One persisted cache-warm usage record — the mirror of the pin's `UsageEntry`
 * for kind `cache_warm`, with the repo's storage rule applied (Unix ms, never
 * ISO strings).
 */
export interface CacheWarmUsageRecord {
  readonly kind: typeof CACHE_WARM_USAGE_KIND;
  readonly provider: string;
  readonly model: string;
  readonly usage: WarmUsageDelta;
  readonly note?: string;
  /** Unix ms the spend was recorded (repo rule: never ISO strings in storage). */
  readonly timestampMs: number;
}

/**
 * Prompt size of one request as reported by the provider — the pin's
 * `lastPromptTokens` arithmetic (cache-warmer.ts: input + cacheRead +
 * cacheWrite): every token the provider saw, whichever bucket billed it.
 */
export function promptTokensOf(
  usage: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>,
): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Whether a usage record carries no counters worth billing at all (render-parity zero filter). */
export function isZeroWarmUsage(usage: WarmUsageDelta): boolean {
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const costSum =
    usage.cost.input +
    usage.cost.output +
    usage.cost.cacheRead +
    usage.cost.cacheWrite +
    usage.cost.total;
  return tokens === 0 && costSum === 0 && usage.totalTokens === 0;
}

/**
 * Normalize a provider `Usage` into the FULL payload shape the projection's
 * strict decoder requires (every core counter required; optional splits pass
 * through). `totalTokens` keeps the provider value, falling back to the
 * counter sum (pin `calculateContextTokens`).
 */
export function normalizeWarmUsage(usage: Usage): WarmUsageDelta {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens:
      usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

/**
 * Draft of one `mcode.usage` entry mirroring a warm refresh's spend — the
 * `cache_warm` category writer (V-U02). Attribution is the RESPONDED model:
 * `provider` + `responseModel ?? model` of the refresh message, exactly the
 * fields the pin passes to `appendUsage`. An all-zero record yields
 * `undefined` — nothing billed, nothing written (the same zero-drop as the
 * W05 summary writer).
 */
export function createCacheWarmUsageEntryDraft(
  id: string,
  attribution: { readonly provider: string; readonly model: string },
  usage: Usage,
  note?: string,
  now: () => number = Date.now,
  parentId: string | null = null,
): DurableEntryDraft | undefined {
  const delta = normalizeWarmUsage(usage);
  if (isZeroWarmUsage(delta)) return undefined;
  const payload: CacheWarmUsageRecord = {
    kind: CACHE_WARM_USAGE_KIND,
    provider: attribution.provider,
    model: attribution.model,
    usage: delta,
    ...(note !== undefined && note.length > 0 ? { note } : {}),
    timestampMs: now(),
  };
  return { id, parentId, kind: CACHE_WARM_USAGE_ENTRY_KIND, payload };
}

/** Input of {@link AppendCacheWarmUsage} — what a successful refresh bills. */
export interface AppendCacheWarmUsageInput {
  readonly provider: string;
  readonly model: string;
  readonly usage: Usage;
  readonly note?: string;
}

/** Record a successful warm refresh; never throws through the agent run. */
export type AppendCacheWarmUsage = (
  input: AppendCacheWarmUsageInput,
) => CacheWarmUsageRecord | undefined | void | Promise<CacheWarmUsageRecord | undefined | void>;

/**
 * Durable cache-warm usage sink: turns the warmer's billing callback into one
 * `mcode.usage` draft appended through the caller's log port (the same
 * writer-gated append discipline the compaction scheduler uses). Draft ids
 * are `cache-warm-usage-<uuid>` unless the host supplies its own mint.
 */
export function createDurableCacheWarmUsageSink(
  append: (draft: DurableEntryDraft) => Promise<void> | void,
  options: { readonly nextId?: () => string; readonly now?: () => number } = {},
): AppendCacheWarmUsage {
  const nextId = options.nextId ?? (() => `cache-warm-usage-${randomUUID()}`);
  const now = options.now ?? Date.now;
  return async (input) => {
    const draft = createCacheWarmUsageEntryDraft(
      nextId(),
      { provider: input.provider, model: input.model },
      input.usage,
      input.note,
      now,
    );
    if (draft === undefined) return undefined;
    await append(draft);
    return draft.payload as CacheWarmUsageRecord;
  };
}

/** One-line transcript text for persisted cache-warming usage (pin port). */
export function formatCacheWarmingUsage(record: CacheWarmUsageRecord): string {
  const note = record.note ? ` (${record.note})` : '';
  const cost = record.usage.cost.total.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, '$1');
  return `Cache warmed${note}: $${cost}`;
}
