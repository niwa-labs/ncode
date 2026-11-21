// Persisted usage fold of `mcode.usage` entries and inline assistant usage.
//
// pi folds usage in two places with the same arithmetic: the coding-agent's
// `usage-totals` (per `provider/model` buckets) and durable's `harness/usage`
// (`UsageState` with `addUsage`, whose optional counters are added once
// either side reports them). This module is that one fold for the projection:
// every `mcode.usage` entry folds into per-`provider/model` totals (the
// billing axis pi renders) AND per-category totals (the mcode axis that keeps
// context spend separate from tool/summary/warm/branch usage — the category
// names are writer-defined, `context` being the mcode convention for
// LLM-context spend).
//
// Completeness against the pin: pi accumulates FOUR usage shapes —
// (a) inline usage on assistant MESSAGE entries, keyed
//     `provider/responseModel ?? model` (usage-totals `getUsageCostBreakdown`),
// (b) standalone `usage` entries keyed `provider/model` (our `mcode.usage`),
// (c) inline usage on toolResult messages and (d) usage on branch-summary /
//     compaction entries, which pi buckets under "Tools/summaries". Shapes
//     (c)/(d) map to the mcode writer contract — the plan's W05 consolidation
//     persists them as explicit `mcode.usage` entries under writer-defined
//     categories (`tool`, `summary`, `branch`, `cache_warm`), so the fold
//     reads them there. WRITER STATUS (do not read this as more done than it
//     is — the mapping of the missing writers lives in state/w05.md,
//     section "V-U02 writer deferral"): `summary` is the ONE writer that
//     exists today — `@mavis/context-compaction`'s `compact()` mirrors each
//     cycle's summarizer spend (the `Summarizer`'s optional
//     `{text, usage?}` return) into a `mcode.usage` draft the scheduler
//     appends with the checkpoint in one writer-gated batch. `cache_warm`
//     now has its writer TOO (W06 part B): `@mavis/prompt-cache`'s
//     `createDurableCacheWarmUsageSink` drafts one `mcode.usage` entry per
//     successful warm refresh (`createCacheWarmUsageEntryDraft`, the
//     `cache_warm` category) — an all-zero refresh writes nothing, and the
//     draft never enters the LLM context (control kind). `tool` and
//     `branch` still have NO writer — DEFERRED product seams to the
//     turn-loop and branch-summary writers of W06/W07 — so until those
//     waves land the fold simply never sees those categories. Shape (a) rides the message itself in pi and has NO
//     `mcode.usage` mirror, so the projection folds it INLINE
//     (`inlineAssistantUsage`) in every spelling a writer produces: the bare
//     message, the donor's `EntryRecord` (`model` is a top-level array,
//     pi-durable generation.ts `appendAssistant`), and our W02 adapter's
//     `pi.record` wrapping of that record (payload verbatim — pinned by a
//     live adapter round-trip test). The product wire form
//     (`canonicalWireMessage`, context-wire.ts) strips provider/model/usage
//     by design, so wire entries fold NO inline billing — that seam's spend
//     rides the same W06/W07 writers. The fold therefore covers every pi
//     shape without any writer double-counting (the mirroring writers today
//     are the summary one and the W06 cache-warm one, which pi bills as
//     shape (d), never (a)).
//
// The fold is O(1) per entry and O(distinct keys) in memory — usage totals
// survive a compaction (spend does not disappear when the context is cut),
// and the UI reads them off the manifest instead of scanning the log.

import type { UsageCost, UsageDelta } from './kinds.js';

/** Cumulative usage counters of one bucket; same shape as {@link UsageDelta} with every split materialized once seen. */
export type UsageAccumulator = UsageDelta;

/** The persisted usage fold carried by the projection state and manifest. */
export interface UsageFold {
	/** Cumulative usage per `provider/model` — the axis pi's usage totals render. */
	readonly models: Readonly<Record<string, UsageAccumulator>>;
	/** Cumulative usage per writer-defined category (`kind` of the usage entry). */
	readonly categories: Readonly<Record<string, UsageAccumulator>>;
}

/** The empty usage fold; shared, never mutated. */
export const EMPTY_USAGE: UsageFold = { models: {}, categories: {} };

/** Whether the fold carries no counters at all. */
export function isUsageEmpty(fold: UsageFold): boolean {
	return Object.keys(fold.models).length === 0 && Object.keys(fold.categories).length === 0;
}

/**
 * Whether a delta carries no counters and no cost at all.
 *
 * pi's rendered billing (`getUsageCostBreakdown`) drops buckets whose cost
 * AND token sum are zero (`filter((entry) => entry.cost > 0 || entry.tokens > 0)`),
 * so a zero delta must not materialize a bucket in the fold either — a
 * zero-usage assistant message or a deliberately empty usage record leaves
 * the fold exactly as it was. Adding zeros into an EXISTING bucket is a
 * numeric no-op on both sides, so skipping zeros everywhere is render-parity
 * with pi while keeping `usage` omitted until real spend exists.
 */
export function isZeroUsageDelta(delta: UsageDelta): boolean {
	return (
		delta.input === 0 &&
		delta.output === 0 &&
		delta.cacheRead === 0 &&
		delta.cacheWrite === 0 &&
		(delta.cacheWrite1h ?? 0) === 0 &&
		(delta.reasoning ?? 0) === 0 &&
		delta.totalTokens === 0 &&
		delta.cost.input === 0 &&
		delta.cost.output === 0 &&
		delta.cost.cacheRead === 0 &&
		delta.cost.cacheWrite === 0 &&
		delta.cost.total === 0
	);
}

/**
 * The inline provider usage an assistant message entry carries (pi billing
 * shape (a): `usage-totals` reads it straight off the message), keyed
 * `provider/responseModel ?? model` — the axis pi's usage totals render:
 * a virtual model resolved by the provider bills under the concrete
 * `responseModel` it reported.
 *
 * TWO payload spellings carry the same message (both fold identically):
 * the BARE message object (`payload.role === 'assistant'`, …) and the
 * canonical writer envelope `payload.model = [message]` — exactly one
 * message per entry. The envelope is what the real writers produce: the
 * donor's `appendAssistant` (pi-durable harness/generation.ts:749) stores
 * an `EntryRecord` whose TOP-LEVEL `model` field is `[AssistantMessage]`
 * (pi-durable types.ts), our W02 adapter stores that record verbatim as a
 * `pi.record` payload, and convert-to-llm's decoder reads the same
 * convention — in every case the assistant message sits at
 * `payload.model[0]`. The envelope used to fall through here (no top-level
 * `role`), silently dropping the billing of every envelope-spelled
 * assistant entry; the reader now unwraps it (pinned on the donor form and
 * the adapter round-trip in usage-writer-forms.test.ts /
 * pi-storage-usage-roundtrip.test.ts).
 *
 * Returns `undefined` when the payload carries no foldable assistant usage:
 * not an assistant role, no usage object, non-finite counters, or no
 * `provider`/`model` strings to attribute the spend to. Unlike the STRICT
 * `mcode.usage` decoder (`asUsagePayload`, which rejects writer-contract
 * breaches with a `TypeError`), this reader is deliberately tolerant — the
 * message stays a perfectly valid CONTEXT entry when its usage block is
 * corrupt, and a corrupt block must never poison the totals with `NaN`
 * (pi would; the same never-NaN discipline as the compaction estimator).
 */
export function inlineAssistantUsage(payload: unknown): { key: string; delta: UsageDelta } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = payload as Record<string, unknown>;
  // Unwrap the canonical writer envelope `payload.model = [message]`: a bare
  // assistant message carries `model` as a STRING (never an array), so the
  // two spellings are disjoint and the unwrap is unambiguous.
  const message = unwrapMessageEnvelope(raw);
  if (message.role !== 'assistant') return undefined;
  const provider = message.provider;
  const model = message.model;
  const responseModel = message.responseModel;
  if (typeof provider !== 'string' || provider.length === 0) return undefined;
  if (typeof model !== 'string' || model.length === 0) return undefined;
  if (responseModel !== undefined && typeof responseModel !== 'string') return undefined;
  const usage = message.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const delta = usage as Record<string, unknown>;
	const counters: ReadonlyArray<[string, unknown]> = [
		['input', delta.input],
		['output', delta.output],
		['cacheRead', delta.cacheRead],
		['cacheWrite', delta.cacheWrite],
		['totalTokens', delta.totalTokens],
	];
	for (const [field, value] of counters) {
		if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	}
	for (const field of ['cacheWrite1h', 'reasoning'] as const) {
		const value = delta[field];
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) return undefined;
	}
	const cost = delta.cost;
	if (typeof cost !== 'object' || cost === null) return undefined;
	const costRecord = cost as Record<string, unknown>;
	for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
		const value = costRecord[field];
		if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	}
	return {
		key: `${provider}/${responseModel ?? model}`,
		delta: {
			input: delta.input as number,
			output: delta.output as number,
			cacheRead: delta.cacheRead as number,
			cacheWrite: delta.cacheWrite as number,
			...(delta.cacheWrite1h !== undefined ? { cacheWrite1h: delta.cacheWrite1h as number } : {}),
			...(delta.reasoning !== undefined ? { reasoning: delta.reasoning as number } : {}),
			totalTokens: delta.totalTokens as number,
			cost: {
				input: costRecord.input as number,
				output: costRecord.output as number,
				cacheRead: costRecord.cacheRead as number,
				cacheWrite: costRecord.cacheWrite as number,
				total: costRecord.total as number,
			},
		},
	};
}

/**
 * Unwrap the canonical writer envelope: `payload.model = [message]` with
 * exactly one message per entry (the donor's `EntryRecord` convention —
 * pi-durable `appendAssistant` — read the same way by convert-to-llm's
 * decoder). A payload whose `model` is not a one-or-more-element array of
 * objects IS the message itself (the bare spelling) and returns unchanged —
 * the two spellings are disjoint because a bare message's `model` is a
 * string.
 */
function unwrapMessageEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const model = payload.model;
  if (!Array.isArray(model) || model.length === 0) return payload;
  const first = model[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return payload;
  return first as Record<string, unknown>;
}

/**
 * Adds one delta to an accumulator (durable `harness/usage` `addUsage`
 * arithmetic): required counters add unconditionally; the optional splits
 * (`cacheWrite1h`, `reasoning`) materialize once either side reports them.
 */
export function addUsageDelta(total: UsageAccumulator, delta: UsageDelta): UsageAccumulator {	return {
		input: total.input + delta.input,
		output: total.output + delta.output,
		cacheRead: total.cacheRead + delta.cacheRead,
		cacheWrite: total.cacheWrite + delta.cacheWrite,
		...(total.cacheWrite1h !== undefined || delta.cacheWrite1h !== undefined
			? { cacheWrite1h: (total.cacheWrite1h ?? 0) + (delta.cacheWrite1h ?? 0) }
			: {}),
		...(total.reasoning !== undefined || delta.reasoning !== undefined
			? { reasoning: (total.reasoning ?? 0) + (delta.reasoning ?? 0) }
			: {}),
		totalTokens: total.totalTokens + delta.totalTokens,
		cost: addCost(total.cost, delta.cost),
	};
}

function addCost(total: UsageCost, delta: UsageCost): UsageCost {
	return {
		input: total.input + delta.input,
		output: total.output + delta.output,
		cacheRead: total.cacheRead + delta.cacheRead,
		cacheWrite: total.cacheWrite + delta.cacheWrite,
		total: total.total + delta.total,
	};
}

/**
 * Adds one delta under one key of one bucket, copy-on-write: returns a fresh
 * record sharing every other value. `Object.defineProperty` on the new record
 * keeps a writer-controlled key like `__proto__` a plain property (the same
 * own-keys discipline as durable's `addUsageState`).
 */
export function withUsageDelta(
	bucket: Readonly<Record<string, UsageAccumulator>>,
	key: string,
	delta: UsageDelta,
): Record<string, UsageAccumulator> {
	const next: Record<string, UsageAccumulator> = { ...bucket };
	const total = Object.hasOwn(bucket, key) ? bucket[key] : undefined;
	Object.defineProperty(next, key, {
		value: total === undefined ? { ...delta } : addUsageDelta(total, delta),
		enumerable: true,
		writable: true,
		configurable: true,
	});
	return next;
}
