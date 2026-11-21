// Usage-axis completeness against the pin (W05 usage-ось, V-U02/V-U03).
//
// pi accumulates FOUR usage shapes (coding-agent `usage-totals.ts`
// `getUsageCostBreakdown`):
//   (a) inline usage on assistant MESSAGE entries, keyed
//       `provider/responseModel ?? model`;
//   (b) standalone `usage` entries keyed `provider/model`;
//   (c) inline usage on toolResult messages -> the "Tools/summaries" bucket;
//   (d) usage on branch_summary / compaction entries -> "Tools/summaries".
//
// Our projection folds (b) from `mcode.usage` and — since W05 — (a) INLINE
// off the assistant message payload (`inlineAssistantUsage`) in BOTH durable
// spellings: the bare message object AND the canonical writer envelope
// `payload.model = [message]` (the donor's EntryRecord form and our W02
// adapter's `pi.record` wrapping — the real-writer forms are pinned in
// usage-writer-forms.test.ts plus a live adapter round-trip in
// durable-backend-sqlite-zstd). Shapes (c)/(d) map to the mcode WRITER
// contract (plan W05 C: tool/summary/branch/cache_warm spend persists as
// explicit `mcode.usage` entries under writer-defined categories). WRITER
// STATUS: `summary` is written by the compaction core (context-compaction
// mirrors each cycle's summarizer spend, see its
// `summary-usage-entry.test.ts`); `tool`, `branch`, `cache_warm` have no
// writer yet — DEFERRED: cache_warm → W06 (CacheWarmer does not exist yet),
// tool/branch → W06/W07 (turn-loop/branch-summary product seams); the
// mapping lives in state/w05.md, section "V-U02 writer deferral". This suite
// pins, against the pinned pi dist (NOT our code):
//
//   1. all four shapes produce the SAME rendered billing: per-`provider/model`
//      rows equal pi's rows for (a)+(b), and the "Tools/summaries" row equals
//      the sum over our tool/summary/branch categories for (c)+(d);
//   2. assistant spend never moves the CONTEXT anchor and tool/warm spend
//      never pollutes it either (V-U02: only an assistant message anchors);
//   3. zero deltas fold nothing (pi's render filter) and corrupt inline
//      usage blocks never NaN the totals;
//   4. totals are replay/idempotence-safe: a double apply is rejected, and
//      capsule restore does not double the spend (V-U03).

import { describe, expect, it } from 'vitest';

import { fileURLToPath } from 'node:url';

import { buildProjection, ProjectionService } from '../../src/index.js';
import type { Entry, JsonValue } from '../../../durable-backend-sqlite-zstd/src/types.js';
import { commitOf, llmEntry, usageEntry } from './helpers.js';

type PiEntry = Record<string, unknown>;
interface PiBreakdownRow {
	key: string;
	cost: number;
	tokens: number;
}

// The pinned pi usage-totals, imported from the vendored dist (built from
// the pinned tree by W01 — third_party/pi-mono; NOT our code).
const PI_CORE = fileURLToPath(
	new URL('../../../../third_party/pi-mono/packages/coding-agent/dist/core', import.meta.url),
);

async function loadPi(): Promise<(entries: PiEntry[]) => PiBreakdownRow[]> {
	const usageTotals = (await import(`${PI_CORE}/usage-totals.js`)) as {
		getUsageCostBreakdown: (entries: PiEntry[]) => PiBreakdownRow[];
	};
	return usageTotals.getUsageCostBreakdown;
}

const TIMESTAMP = '1970-01-01T00:00:00.000Z';

function assistantEntry(
	seq: number,
	ordinal: number,
	provider: string,
	model: string,
	usage: Record<string, unknown> | undefined,
	responseModel?: string,
): Entry {
	return llmEntry('pi.assistant', {
		role: 'assistant',
		content: [{ type: 'text', text: 'a' }],
		provider,
		model,
		...(responseModel !== undefined ? { responseModel } : {}),
		...(usage !== undefined ? { usage } : {}),
		stopReason: 'stop',
	}, seq, ordinal);
}

function userEntry(seq: number, ordinal: number, text: string): Entry {
	return llmEntry('pi.user', { role: 'user', content: [{ type: 'text', text }] }, seq, ordinal);
}

function toolResultEntry(seq: number, ordinal: number, usage: Record<string, unknown>): Entry {
	return llmEntry('pi.toolResult', {
		role: 'toolResult',
		toolCallId: `call-${seq}-${ordinal}`,
		toolName: 'bash',
		content: [{ type: 'text', text: 'out' }],
		usage,
	}, seq, ordinal);
}

function piOf(entries: readonly Entry[]): PiEntry[] {
	const out: PiEntry[] = [];
	let prevId: string | null = null;
	for (const entry of entries) {
		const base = { id: entry.id, parentId: prevId, timestamp: TIMESTAMP };
		const payload = entry.payload as Record<string, unknown>;
		if (entry.kind === 'mcode.usage') {
			out.push({ type: 'usage', ...base, kind: payload.kind, provider: payload.provider, model: payload.model, usage: payload.usage });
		} else if (entry.kind === 'pi.branch-summary') {
			out.push({ type: 'branch_summary', ...base, fromId: payload.fromId, summary: payload.summary, usage: payload.usage });
		} else if (entry.kind === 'mcode.compaction') {
			out.push({ type: 'compaction', ...base, summary: payload.summary, firstKeptEntryId: payload.firstKeptEntryId, tokensBefore: payload.tokensBefore ?? 0, usage: payload.usage });
		} else {
			out.push({ type: 'message', ...base, message: { ...payload, timestamp: 0 } });
		}
		prevId = entry.id;
	}
	return out;
}

/** pi's rendered rows as a map (the breakdown dedupes by key). */
function piRows(rows: PiBreakdownRow[]): Map<string, PiBreakdownRow> {
	return new Map(rows.map((row) => [row.key, row]));
}

/** Unwrap our durable writer envelope `payload.model = [message]` to the bare message. */
function unenvelop(entry: Entry): Entry {
	const payload = entry.payload as Record<string, unknown>;
	const model = payload?.model;
	if (Array.isArray(model) && model.length === 1 && typeof model[0] === 'object' && model[0] !== null) {
		return { ...entry, payload: model[0] as JsonValue };
	}
	return entry;
}

const spend = (over: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens', number>> = {}) => ({
	input: 100,
	output: 50,
	cacheRead: 10,
	cacheWrite: 5,
	totalTokens: 165,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.01, total: 0.32 },
	...over,
});
/** Flat spend whose rendered pi token sum is exactly `input` (pi tokens = input+output+cacheRead+cacheWrite). */
const flatSpend = (input: number) => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: 0.01 * input, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 * input },
});
const ZERO_SPEND = spend({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

describe('all four pi usage shapes render the same billing (pinned oracle)', () => {
	it('assistant inline usage (shape a) folds per provider/model, responseModel wins', async () => {
		const pi = await loadPi();
		const log = [
			userEntry(1, 0, 'u1'),
			assistantEntry(1, 1, 'anthropic', 'claude-virtual', spend()),
			// A virtual model the provider resolved: pi bills the concrete model.
			assistantEntry(2, 0, 'anthropic', 'claude-virtual', spend({ input: 7 }), 'claude-3-7-sonnet'),
			assistantEntry(3, 0, 'openai', 'gpt-5', spend({ input: 3 })),
		];

		const manifest = buildProjection(log);
		// Our fold: virtual billed under responseModel, plain under model.
		expect(Object.keys(manifest.usage!.models).sort()).toEqual([
			'anthropic/claude-3-7-sonnet',
			'anthropic/claude-virtual',
			'openai/gpt-5',
		].sort());
		expect(manifest.usage!.models['anthropic/claude-virtual']!.input).toBe(100);
		expect(manifest.usage!.models['anthropic/claude-3-7-sonnet']!.input).toBe(7);

		// pi's rendered rows agree exactly (cost and token sum per key).
		const rows = piRows(pi(piOf(log)));
		expect([...rows.keys()].sort()).toEqual([
			'anthropic/claude-3-7-sonnet',
			'anthropic/claude-virtual',
			'openai/gpt-5',
		].sort());
		for (const [key, row] of rows) {
			const ours = manifest.usage!.models[key]!;
			expect(ours.cost.total).toBeCloseTo(row.cost, 10);
			expect(ours.input + ours.output + ours.cacheRead + ours.cacheWrite).toBe(row.tokens);
		}
		// Assistant spend never lands in categories (writer kinds only).
		expect(manifest.usage!.categories).toEqual({});
	});

	it('the canonical writer envelope payload.model = [message] folds IDENTICALLY to the bare spelling', async () => {
		const pi = await loadPi();
		const bare = [
			userEntry(1, 0, 'u1'),
			assistantEntry(1, 1, 'anthropic', 'claude-3', spend(), 'claude-3-7-sonnet'),
		];
		// Same message wrapped in the pi-durable writer envelope: the entry
		// payload is `{ model: [assistantMessage] }` (convert-to-llm decode.ts,
		// "the canonical writer convention"). Before the W05 review fix this
		// spelling folded NOTHING (no top-level role) — the billing of every
		// envelope-spelled assistant entry silently vanished.
		const enveloped = [
			userEntry(1, 0, 'u1'),
			llmEntry('pi.assistant', {
				model: [{
					role: 'assistant',
					content: [{ type: 'text', text: 'a' }],
					provider: 'anthropic',
					model: 'claude-3',
					responseModel: 'claude-3-7-sonnet',
					usage: spend(),
					stopReason: 'stop',
				}],
			}, 1, 1),
		];

		const bareManifest = buildProjection(bare);
		const envelopeManifest = buildProjection(enveloped);
		expect(envelopeManifest.usage).toEqual(bareManifest.usage);
		expect(envelopeManifest.usage!.models['anthropic/claude-3-7-sonnet']!.input).toBe(100);
		// pi's oracle reads the same message either way (its adapter unwraps
		// the envelope — pi's own writer stores the message in the entry, not
		// in a `model` array; the array is OUR durable convention).
		const piRowsOf = (entries: readonly Entry[]) =>
			piRows(pi(piOf(entries.map(unenvelop))));
		expect([...piRowsOf(enveloped).keys()]).toEqual([...piRowsOf(bare).keys()]);
		expect(piRowsOf(enveloped).get('anthropic/claude-3-7-sonnet')!.tokens).toBe(
			piRowsOf(bare).get('anthropic/claude-3-7-sonnet')!.tokens,
		);
		// An envelope around a NON-assistant message still folds nothing.
		const userOnly = buildProjection([
			llmEntry('pi.user', { model: [{ role: 'user', content: 'hi' }] }, 1, 0),
		]);
		expect(userOnly.usage).toBeUndefined();
	});

	it('shapes (b)+(c)+(d): usage entries plus the tool/summary/branch writer mapping', async () => {
		const pi = await loadPi();
		const assistantSpend = flatSpend(200);
		const toolSpend = flatSpend(11);
		const summarySpend = flatSpend(22);
		const branchSpend = flatSpend(33);
		const warmSpend = flatSpend(1);

		// OUR log: (a) rides the assistant message; (c)/(d) are explicit
		// mcode.usage records (the declared writer mapping). Tool/summary/
		// branch spend is attributed to the caller's own identity (durable's
		// harness keys tools by tool name, not by model) so the buckets stay
		// disjoint and every parity assertion is exact.
		const ourLog: Entry[] = [
			userEntry(1, 0, 'u1'),
			assistantEntry(1, 1, 'anthropic', 'claude-3', assistantSpend),
			usageEntry(2, 0, 'tool', 'tools-host', 'bash', toolSpend),
			usageEntry(3, 0, 'summary', 'anthropic', 'claude-3', summarySpend),
			usageEntry(4, 0, 'branch', 'tools-host', 'branch-writer', branchSpend),
			usageEntry(5, 0, 'cache_warm', 'anthropic', 'claude-3', warmSpend),
		];

		// PI log: the same spend in pi's own shapes — tool usage inline on a
		// toolResult message, summary usage on a compaction, branch usage on a
		// branch_summary, warming as a usage entry.
		const u1 = userEntry(1, 0, 'u1');
		const a1 = assistantEntry(1, 1, 'anthropic', 'claude-3', assistantSpend);
		const toolInline = toolResultEntry(2, 0, toolSpend);
		const compactionWithUsage = llmEntry('mcode.compaction', {
			summary: 's', firstKeptEntryId: u1.id, tokensBefore: 0, usage: summarySpend,
		} as unknown as JsonValue, 3, 0);
		const branchWithUsage = llmEntry('pi.branch-summary', {
			fromId: u1.id, summary: 'b', usage: branchSpend,
		}, 4, 0);
		const warmUsage = usageEntry(5, 0, 'cache_warm', 'anthropic', 'claude-3', warmSpend);
		const piLog = [u1, a1, toolInline, compactionWithUsage, branchWithUsage, warmUsage];

		const manifest = buildProjection(ourLog);
		const rows = piRows(pi(piOf(piLog)));

		// (a)+(b) under provider/model: the assistant row and the warm usage row
		// land in ONE anthropic/claude-3 bucket on both sides — exactly.
		const ourClaude = manifest.usage!.models['anthropic/claude-3']!;
		expect(ourClaude.input).toBe(200 + 22 + 1);
		const claudeRow = rows.get('anthropic/claude-3')!;
		expect(claudeRow.tokens).toBe(200 + 1);
		// pi's row carries only assistant+warm; our claude bucket also carries
		// the writer-attributed summary spend (pi durable keys summarization
		// attempts by provider/modelId the same way), so compare the row
		// against the same sources.
		expect(ourClaude.input - 22).toBe(claudeRow.tokens);
		expect(ourClaude.cost.total - summarySpend.cost.total).toBeCloseTo(claudeRow.cost, 10);

		// (c)+(d): pi's single "Tools/summaries" bucket equals the SUM of our
		// tool+summary+branch categories (tokens AND cost).
		const toolsRow = rows.get('Tools/summaries')!;
		expect(toolsRow.tokens).toBe(11 + 22 + 33);
		const categoryTokens = (kind: string) => manifest.usage!.categories[kind]!.input;
		expect(categoryTokens('tool') + categoryTokens('summary') + categoryTokens('branch')).toBe(11 + 22 + 33);
		expect(categoryTokens('cache_warm')).toBe(1);
		expect(toolsRow.cost).toBeCloseTo(toolSpend.cost.total + summarySpend.cost.total + branchSpend.cost.total, 10);
		// The tools-host bucket carries the durable-side tool attribution.
		expect(manifest.usage!.models['tools-host/bash']!.input).toBe(11);
		expect(manifest.usage!.models['tools-host/branch-writer']!.input).toBe(33);
	});

	it('a zero-usage assistant folds nothing — render parity with pi', async () => {
		const pi = await loadPi();
		const log = [userEntry(1, 0, 'u'), assistantEntry(1, 1, 'anthropic', 'claude-3', ZERO_SPEND)];
		const manifest = buildProjection(log);
		expect(manifest.usage).toBeUndefined();
		// pi renders no row either (its filter drops zero buckets).
		expect(pi(piOf(log))).toEqual([]);
	});

	it('corrupt inline usage never poisons the totals (never-NaN, unlike pi)', () => {
		const log = [
			userEntry(1, 0, 'u'),
			assistantEntry(1, 1, 'anthropic', 'claude-3', { input: 5, output: 5, cacheRead: 5, cacheWrite: 5, totalTokens: 20, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } }),
			assistantEntry(2, 0, 'anthropic', 'claude-3', { input: 'not-a-number' } as unknown as Record<string, unknown>),
			assistantEntry(3, 0, undefined as unknown as string, 'claude-3', spend()),
		];
		const manifest = buildProjection(log);
		const ours = manifest.usage!.models['anthropic/claude-3']!;
		expect(ours.input).toBe(5);
		expect(Number.isFinite(ours.input)).toBe(true);
	});
});

describe('V-U02: the billing axis never pollutes the context axis', () => {
	it('mcode.usage and inline assistant usage never move the usage anchor', () => {
		const u1 = userEntry(1, 0, 'u1');
		const a1 = assistantEntry(1, 1, 'anthropic', 'claude-3', spend());
		const tool = usageEntry(2, 0, 'tool', 'bash', 'bash', spend());
		const u2 = userEntry(3, 0, 'u2');
		const manifest = buildProjection([u1, a1, tool, u2]);
		// The anchor is the LAST LLM-VISIBLE entry — an assistant message or a
		// plain message, never a control entry: the anchor named u2 even though
		// the usage entry and the assistant's spend folded after a1.
		expect(manifest.usageAnchor).toBe(u2.id);
		expect(manifest.segments.map((s) => s.entryId)).toEqual([u1.id, a1.id, u2.id]);
		expect(manifest.usage!.models['anthropic/claude-3']!.input).toBe(100);
		expect(manifest.usage!.categories.tool!.input).toBe(100);
	});
});

describe('V-U03: replay/restore never doubles the spend', () => {
	it('a double apply of the same commit is rejected, not silently re-folded', () => {
		const service = new ProjectionService();
		const commit = commitOf(1, [userEntry(1, 0, 'u'), usageEntry(1, 1, 'context', 'p', 'm', spend())]);
		service.apply(commit);
		const once = service.manifest().usage!.models['p/m']!.input;
		expect(() => service.apply(commit)).toThrow();
		expect(service.manifest().usage!.models['p/m']!.input).toBe(once);
	});

	it('capsule restore replays the retained slice without doubling pre-slice spend', () => {
		const service = new ProjectionService();
		const early = usageEntry(1, 0, 'context', 'p', 'm', spend({ input: 40 }));
		const a = assistantEntry(2, 0, 'anthropic', 'claude-3', spend({ input: 60 }));
		const u = userEntry(3, 0, 'u2');
		const cut = { ...usageEntry(4, 0, 'context', 'p', 'm', spend()), kind: 'mcode.compaction', payload: { summary: 's', firstKeptEntryId: u.id } };
		const late = usageEntry(5, 0, 'context', 'p', 'm', spend({ input: 2 }));
		service.apply(commitOf(1, [early]));
		service.apply(commitOf(2, [a]));
		service.apply(commitOf(3, [u]));
		service.apply(commitOf(4, [cut]));
		service.apply(commitOf(5, [late]));

		const capsule = service.capsule();
		// The retained slice: the compaction's first kept entry … head. The
		// checkpoint itself sits before the slice; its mark is overlaid from
		// the capsule, its pre-slice spend restored WHOLESALE.
		const first = ProjectionService.fromCapsule(capsule, [u, late]);
		const second = ProjectionService.fromCapsule(capsule, [u, late]);
		// Idempotent RPC shape: two independent restores of one capsule see the
		// SAME totals — pre-slice spend exactly once, never doubled.
		expect(first.manifest().usage).toEqual(second.manifest().usage);
		expect(first.manifest().usage!.models['p/m']!.input).toBe(40 + 2);
		expect(first.manifest().usage!.models['anthropic/claude-3']!.input).toBe(60);
		expect(first.capsule()).toEqual(capsule);
	});
});
