// Oracle parity: our single incremental fold vs the PINNED pi full projector.
//
// The oracle is NOT our code: `buildSessionProjection` /
// `buildContextEntries` come from the vendored coding-agent of the pinned
// tree (pin 48c8f32; the dist was built by W01 from that same tree), and
// `getUsageCostBreakdown` from its usage-totals module. Every prefix (head)
// of every generated log is projected by BOTH sides after a declared data
// mapping, and the results must agree on:
//
//   1. the ORDER of model-visible message entries (pi projected message
//      entries with non-empty messages == our manifest segments),
//   2. per-target edit effects (pi's newest-edit-wins content == our
//      replace/omit semantics and replacement byteLen),
//   3. usage totals per `provider/model` (pi's breakdown == our usage fold).
//
// Mapping declarations (the declared-data mapping of the plan's T stage):
//   `pi.user`/`pi.assistant`/`pi.toolResult` payloads ARE pi messages;
//   `mcode.context_edit` payloads ARE pi `ContextEditEntry` bodies;
//   `mcode.usage` payloads ARE pi `UsageEntry` bodies; `mcode.compaction`
//   payloads map to pi `CompactionEntry` (retain-none null maps to pi's
//   self-referencing spelling). The pi entry DICTIONARY (V-C06) is in scope:
//   `pi.branch-summary` ↔ pi `branch_summary` and `pi.custom-message` ↔ pi
//   `custom_message` are context-VISIBLE; `mcode.custom`/`mcode.label`/
//   `mcode.session-info`/`mcode.model-change`/`mcode.thinking-level` map to
//   the pi state/metadata kinds that NEVER enter context (pi tracks their
//   model/thinkingLevel STATE separately — not a manifest axis). System
//   message entries are OUT of scope here
//   (their replay/collapse is the transcript stage, wave part A); the
//   generator emits none. Compactions are monotone (a later cut never widens
//   the window past an earlier cut) — pi's full projector can re-widen by
//   re-reading the file, an incremental fold cannot restore cut members
//   without storage reads; that divergence is documented in the wave state.

import { describe, expect, it } from 'vitest';

import { fileURLToPath } from 'node:url';

import { buildProjection, ProjectionService } from '../../src/index.js';
import type { Entry, JsonValue } from '../../../durable-backend-sqlite-zstd/src/types.js';
import { commitOf, llmEntry, makeLcg, replacementEditEntry, retainNoneCompactionEntry, usageEntry, branchSummaryEntry, customMessageEntry, dictionaryControlEntry } from './helpers.js';

type PiEntry = Record<string, unknown>;
interface PiProjectedEntry {
	sourceEntry: PiEntry;
	messages: { role: string; content: unknown }[];
}
interface PiProjection {
	entries: PiProjectedEntry[];
	messages: unknown[];
}

// The pinned pi projector, imported from the vendored dist (built from the
// pinned tree by W01 — see third_party/pi-mono; NOT our code).
const PI_CORE = fileURLToPath(
	new URL('../../../../third_party/pi-mono/packages/coding-agent/dist/core', import.meta.url),
);

async function loadPi(): Promise<{
	buildSessionProjection: (entries: PiEntry[], leafId?: string | null) => PiProjection;
	getUsageCostBreakdown: (entries: PiEntry[]) => { key: string; cost: number; tokens: number }[];
}> {
	const sessionManager = (await import(`${PI_CORE}/session-manager.js`)) as {
		buildSessionProjection: (entries: PiEntry[], leafId?: string | null) => PiProjection;
	};
	const usageTotals = (await import(`${PI_CORE}/usage-totals.js`)) as {
		getUsageCostBreakdown: (entries: PiEntry[]) => { key: string; cost: number; tokens: number }[];
	};
	return { buildSessionProjection: sessionManager.buildSessionProjection, getUsageCostBreakdown: usageTotals.getUsageCostBreakdown };
}

const TIMESTAMP = '1970-01-01T00:00:00.000Z';
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Declared mapping: our log entries → pi session entries (linear parent chain). */
function toPiEntries(log: readonly Entry[]): PiEntry[] {
	const out: PiEntry[] = [];
	let prevId: string | null = null;
	for (const entry of log) {
		const base = { id: entry.id, parentId: prevId, timestamp: TIMESTAMP };
		const payload = entry.payload as Record<string, unknown>;
		if (entry.kind === 'mcode.context_edit') {
			out.push({ type: 'context_edit', ...base, targetId: payload.targetId, replacement: payload.replacement });
		} else if (entry.kind === 'mcode.usage') {
			out.push({ type: 'usage', ...base, kind: payload.kind, provider: payload.provider, model: payload.model, usage: payload.usage });
		} else if (entry.kind === 'mcode.compaction') {
			// pi's on-disk retain-none spelling is the compaction's own id.
			const firstKept = (payload.firstKeptEntryId as string | null) ?? entry.id;
			out.push({ type: 'compaction', ...base, summary: payload.summary, firstKeptEntryId: firstKept, tokensBefore: 0 });
		} else if (entry.kind === 'pi.branch-summary') {
			// V-C06 dictionary: pi BranchSummaryEntry — context-visible as a
			// user message (branch-summary template), NOT content-editable.
			out.push({ type: 'branch_summary', ...base, fromId: payload.fromId, summary: payload.summary });
		} else if (entry.kind === 'pi.custom-message') {
			// V-C06 dictionary: pi CustomMessageEntry — context-visible as a
			// user message; pi's edit layer treats role `custom` as replaceable.
			out.push({
				type: 'custom_message',
				...base,
				customType: payload.customType,
				content: payload.content,
				display: payload.display,
			});
		} else if (
			entry.kind === 'mcode.custom' ||
			entry.kind === 'mcode.label' ||
			entry.kind === 'mcode.session-info' ||
			entry.kind === 'mcode.model-change' ||
			entry.kind === 'mcode.thinking-level'
		) {
			// V-C06 dictionary: pi kinds that NEVER enter LLM context —
			// CustomEntry (extension state), LabelEntry, SessionInfoEntry,
			// ModelChangeEntry, ThinkingLevelChangeEntry. pi's projector yields
			// no context messages for them; our fold keeps `mcode.*` out of the
			// window by the control-prefix rule. (pi additionally tracks
			// model/thinkingLevel STATE from the last two — a separate axis our
			// manifest does not claim; context visibility is the parity axis.)
			const typeByKind: Record<string, string> = {
				'mcode.custom': 'custom',
				'mcode.label': 'label',
				'mcode.session-info': 'session_info',
				'mcode.model-change': 'model_change',
				'mcode.thinking-level': 'thinking_level_change',
			};
			out.push({ type: typeByKind[entry.kind]!, ...base, ...payload });
		} else {
			out.push({ type: 'message', ...base, message: { ...payload, timestamp: 0 } });
		}
		prevId = entry.id;
	}
	return out;
}

const MESSAGEISH = new Set(['message', 'custom_message', 'branch_summary']);

/** pi's model-visible message ids, in projection order. */
function piVisibleIds(projection: PiProjection): string[] {
	return projection.entries
		.filter((pe) => MESSAGEISH.has(pe.sourceEntry.type as string) && pe.messages.length > 0)
		.map((pe) => pe.sourceEntry.id as string);
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The full parity assertion for one head: pi full projection, our full
 * rebuild, and our incremental service must agree on visibility order, edit
 * effects and usage totals.
 */
async function assertHeadParity(pi: Awaited<ReturnType<typeof loadPi>>, log: readonly Entry[]): Promise<void> {
	const piProjection = pi.buildSessionProjection(toPiEntries(log));
	const manifest = buildProjection(log);

	// 1. Visible order.
	expect(manifest.segments.map((s) => s.entryId)).toEqual(piVisibleIds(piProjection));

	// 2. Per-target edit effects.
	const roles = new Map<string, string>();
	for (const entry of log) {
		if (!entry.kind.startsWith('pi.')) continue;
		const role = (entry.payload as { role?: string }).role;
		if (typeof role === 'string') roles.set(entry.id, role);
	}
	const piProjectedById = new Map(piProjection.entries.map((pe) => [pe.sourceEntry.id as string, pe]));
	for (const [targetId, winning] of Object.entries(manifest.edits ?? {})) {
		const source = log.find((entry) => entry.id === targetId);
		expect(source).toBeDefined();
		const editEntry = log.find((entry) => entry.id === winning.editEntryId);
		expect(editEntry).toBeDefined();
		const replacement = (editEntry!.payload as { replacement: { content: unknown } | null }).replacement;
		const piMessages = piProjectedById.get(targetId)?.messages ?? [];
		const ourSegment = manifest.segments.find((s) => s.entryId === targetId);
		if (winning.action === 'omit') {
			expect(piMessages).toEqual([]);
			expect(ourSegment).toBeUndefined();
		} else {
			expect(piMessages).toHaveLength(1);
			const role = roles.get(targetId);
			const content = replacement!.content;
			const expected =
				(role === 'assistant' || role === 'toolResult') && typeof content === 'string'
					? [{ type: 'text', text: content }]
					: content;
			expect(piMessages[0]!.content).toEqual(expected);
			expect(ourSegment?.byteLen).toBe(bytes(content));
		}
	}

	// 3. Usage totals per provider/model (pi scans the WHOLE file; our fold
	//    carries the same totals through compactions).
	const piRows = new Map(pi.getUsageCostBreakdown(toPiEntries(log)).map((row) => [row.key, row]));
	const ourModels = manifest.usage?.models ?? {};
	expect(Object.keys(ourModels).sort()).toEqual([...piRows.keys()].sort());
	for (const [key, row] of piRows) {
		const ours = ourModels[key]!;
		expect(ours.cost.total).toBeCloseTo(row.cost, 10);
		expect(ours.input + ours.output + ours.cacheRead + ours.cacheWrite).toBe(row.tokens);
	}

	// Incremental === full === pi: fold the same log commit by commit (one
	// commit per distinct seq) and require byte-equality with the full rebuild
	// that pi already agreed with above.
	const service = new ProjectionService();
	let lastSeq = -1;
	let batch: Entry[] = [];
	for (const entry of log) {
		if (entry.seq !== lastSeq && batch.length > 0) {
			service.apply(commitOf(lastSeq, batch));
			batch = [];
		}
		lastSeq = entry.seq as number;
		batch.push(entry);
	}
	if (batch.length > 0) service.apply(commitOf(lastSeq, batch));
	expect(JSON.stringify(service.manifest())).toBe(JSON.stringify(manifest));
}

// ---------------------------------------------------------------------------
// Deterministic scenarios
// ---------------------------------------------------------------------------

function message(kind: 'pi.user' | 'pi.assistant' | 'pi.toolResult', text: string, seq: number, ordinal: number): Entry {
	const payloads: Record<string, JsonValue> = {
		'pi.user': { role: 'user', content: [{ type: 'text', text }] },
		'pi.assistant': {
			role: 'assistant',
			content: [{ type: 'text', text }],
			provider: 'anthropic',
			model: 'claude-3',
			usage: ZERO_USAGE,
			stopReason: 'stop',
		},
		'pi.toolResult': { role: 'toolResult', toolCallId: `call-${seq}-${ordinal}`, toolName: 'bash', content: [{ type: 'text', text }] },
	};
	return { ...llmEntry(kind, payloads[kind]!, seq, ordinal) };
}

/** An assistant turn whose INLINE provider usage bills (usage shape (a), keyed `responseModel ?? model`). */
function assistantWithUsage(seq: number, ordinal: number, input: number, responseModel?: string): Entry {
	return llmEntry(
		'pi.assistant',
		{
			role: 'assistant',
			content: [{ type: 'text', text: `billed turn ${input}` }],
			provider: 'anthropic',
			model: 'claude-virtual',
			...(responseModel !== undefined ? { responseModel } : {}),
			usage: {
				input,
				output: input * 2,
				cacheRead: 1,
				cacheWrite: 2,
				totalTokens: input * 3 + 3,
				cost: { input: input * 0.1, output: input * 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: input * 0.33 },
			},
			stopReason: 'stop',
		},
		seq,
		ordinal,
	);
}

describe('pi oracle parity: deterministic scenarios', () => {
	it('replacement → omission → resurrection matches the pinned projector at every head', async () => {
		const pi = await loadPi();
		const a = message('pi.user', 'u1', 1, 0);
		const b = message('pi.assistant', 'a1', 1, 1);
		const c = message('pi.toolResult', 'r1', 1, 2);
		const log = [
			a,
			b,
			c,
			replacementEditEntry(2, 0, a.id, { content: 'v1' }),
			replacementEditEntry(3, 0, a.id, null),
			replacementEditEntry(4, 0, a.id, { content: [{ type: 'text', text: 'v2' }] }),
			replacementEditEntry(5, 0, b.id, { content: 'assistant rewrite' }),
			replacementEditEntry(6, 0, c.id, null),
		];
		for (let head = 1; head <= log.length; head += 1) {
			await assertHeadParity(pi, log.slice(0, head));
		}
	});

	it('edits around a compaction (monotone) match, including retain-none', async () => {
		const pi = await loadPi();
		const a = message('pi.user', 'u1', 1, 0);
		const b = message('pi.assistant', 'a1', 1, 1);
		const c = message('pi.user', 'u2', 3, 0);
		const d = message('pi.assistant', 'a2', 3, 1);
		const u3 = message('pi.user', 'u3', 5, 0);
		const a3 = message('pi.assistant', 'a3', 7, 0);
		const log = [
			a,
			b,
			replacementEditEntry(2, 0, a.id, null),
			c,
			d,
			{ ...retainNoneCompactionEntry(4, 0, 'reset'), payload: { summary: 'reset', firstKeptEntryId: null } },
			u3,
			replacementEditEntry(6, 0, c.id, { content: 'after reset' }), // c was cut: inert on both sides
			a3,
			replacementEditEntry(8, 0, u3.id, { content: 'direct' }), // live member: replaced
		];
		for (let head = 1; head <= log.length; head += 1) {
			await assertHeadParity(pi, log.slice(0, head));
		}
	});

	it('V-C06: the pi entry dictionary projects with the same visibility at every head', async () => {
		const pi = await loadPi();
		const u1 = message('pi.user', 'u1', 1, 0);
		const summary = branchSummaryEntry(1, 1, 'Tried a refactor; reverted.');
		const injected = customMessageEntry(1, 2, 'com.example.note', 'extension says hi');
		const a1 = message('pi.assistant', 'a1', 2, 0);
		const log = [
			u1,
			summary,
			injected,
			a1,
			// The context-INVISIBLE dictionary kinds — state/metadata/settings.
			dictionaryControlEntry('mcode.custom', 2, 1, { customType: 'com.example.state', data: { n: 1 } }),
			dictionaryControlEntry('mcode.label', 2, 2, { targetId: u1.id, label: 'important' }),
			dictionaryControlEntry('mcode.session-info', 2, 3, { name: 'dictionary run' }),
			dictionaryControlEntry('mcode.model-change', 2, 4, { provider: 'anthropic', modelId: 'claude-3' }),
			dictionaryControlEntry('mcode.thinking-level', 2, 5, { thinkingLevel: 'high' }),
			// A custom_message IS content-editable in pi (role `custom`); exercise
			// replace → omit → resurrect on it like on any message member.
			replacementEditEntry(3, 0, injected.id, { content: 'extension says hi (edited)' }),
			replacementEditEntry(4, 0, injected.id, null),
			replacementEditEntry(5, 0, injected.id, { content: [{ type: 'text', text: 'resurrected' }] }),
		];
		for (let head = 1; head <= log.length; head += 1) {
			await assertHeadParity(pi, log.slice(0, head));
		}
	});

	it('usage totals match the pinned usage breakdown through edits and compactions', async () => {
		const pi = await loadPi();
		const usage = (seq: number, ordinal: number, provider: string, model: string, input: number, cacheWrite1h?: number) =>
			usageEntry(seq, ordinal, 'context', provider, model, {
				input,
				output: input * 2,
				cacheRead: 1,
				cacheWrite: 2,
				...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
				totalTokens: input * 3 + 3,
				cost: { input: input * 0.1, output: input * 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: input * 0.33 },
			});
		const a = message('pi.user', 'u1', 1, 0);
		const log = [
			a,
			usage(1, 1, 'anthropic', 'claude-3', 10),
			usage(2, 0, 'openai', 'gpt-5', 20, 5),
			message('pi.assistant', 'a1', 3, 0),
			usage(3, 1, 'anthropic', 'claude-3', 1),
			{ ...retainNoneCompactionEntry(4, 0, 'reset'), payload: { summary: 'reset', firstKeptEntryId: null } },
			message('pi.user', 'u2', 5, 0),
			usage(5, 1, 'openai', 'gpt-5', 2),
		];
		for (let head = 1; head <= log.length; head += 1) {
			await assertHeadParity(pi, log.slice(0, head));
		}
	});
});

// ---------------------------------------------------------------------------
// Randomized log (deterministic LCG): every entry kind, every head
// ---------------------------------------------------------------------------

describe('pi oracle parity: randomized log', () => {
	it('agrees at every head across edits, usage, retain-none and monotone compactions', async () => {
		const pi = await loadPi();
		const lcg = makeLcg(0x5eed03);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(lcg() * items.length) % items.length]!;

		const log: Entry[] = [];
		let seq = 0;
		let ordinal = 0;
		// Window members not cut by a compaction yet (edit targets must stay
		// members on BOTH sides; the list is truncated by every compaction,
		// which keeps the generated cuts monotone).
		let members: string[] = [];
		const pushEntry = (entry: Entry) => {
			if (entry.seq !== seq) {
				seq = entry.seq as number;
				ordinal = 0;
			} else {
				ordinal += 1;
			}
			log.push({ ...entry, ordinal });
		};

		for (let step = 0; step < 120; step += 1) {
			const roll = lcg();
			if (members.length > 2 && roll < 0.16) {
				// pi-style edit of a random live member.
				const targetId = pick(members);
				const contentRoll = lcg();
				const replacement =
					contentRoll < 0.35
						? null
						: contentRoll < 0.7
							? { content: `rewrite-${step}` }
							: { content: [{ type: 'text', text: `block-${step}` }] };
				pushEntry(replacementEditEntry(seq + 1, 0, targetId, replacement));
			} else if (roll < 0.26) {
				// usage entry.
				const provider = pick(['anthropic', 'openai', 'google']);
				const model = pick(['claude-3', 'gpt-5', 'gemini-2']);
				const input = 1 + Math.floor(lcg() * 50);
				pushEntry(
					usageEntry(seq + 1, 0, pick(['context', 'cache_warm', 'summary']), provider, model, {
						input,
						output: Math.floor(lcg() * 30),
						cacheRead: Math.floor(lcg() * 10),
						cacheWrite: Math.floor(lcg() * 10),
						...(lcg() < 0.3 ? { cacheWrite1h: Math.floor(lcg() * 10) } : {}),
						...(lcg() < 0.2 ? { reasoning: Math.floor(lcg() * 10) } : {}),
						totalTokens: input + Math.floor(lcg() * 60),
						cost: {
							input: lcg() / 4,
							output: lcg() / 4,
							cacheRead: lcg() / 10,
							cacheWrite: lcg() / 10,
							total: lcg(),
						},
					}),
				);
		} else if (members.length > 3 && roll < 0.32) {
			// compaction: retain-none half the time, else cut at a live member.
			if (lcg() < 0.5) {
				pushEntry(retainNoneCompactionEntry(seq + 1, 0, `reset-${step}`));
				members = [];
			} else {
				const firstKept = pick(members);
				pushEntry({
					...retainNoneCompactionEntry(seq + 1, 0, `cut-${step}`),
					payload: { summary: `cut-${step}`, firstKeptEntryId: firstKept },
				});
				members = members.slice(members.indexOf(firstKept));
			}
		} else if (roll < 0.42) {
			// V-C06 dictionary: context-VISIBLE kinds — a branch summary (not
			// editable) and an extension custom_message (editable, role custom).
			if (lcg() < 0.5) {
				pushEntry(branchSummaryEntry(seq + 1, 0, `branch-${step}`));
			} else {
				const injected = customMessageEntry(seq + 1, 0, 'com.test', `inject-${step}`);
				pushEntry(injected);
				members.push(injected.id);
			}
		} else if (roll < 0.5) {
			// V-C06 dictionary: context-INVISIBLE kinds — extension state,
			// labels, session metadata, model/thinking settings changes.
			const kinds = [
				'mcode.custom',
				'mcode.label',
				'mcode.session-info',
				'mcode.model-change',
				'mcode.thinking-level',
			] as const;
			const kind = pick(kinds);
			const payloads: Record<(typeof kinds)[number], JsonValue> = {
				'mcode.custom': { customType: `com.test.${step}`, data: { step } },
				'mcode.label': { targetId: pick(members), label: `l-${step}` },
				'mcode.session-info': { name: `run-${step}` },
				'mcode.model-change': { provider: pick(['anthropic', 'openai']), modelId: pick(['claude-3', 'gpt-5']) },
				'mcode.thinking-level': { thinkingLevel: pick(['low', 'medium', 'high']) },
			};
			pushEntry(dictionaryControlEntry(kind, seq + 1, 0, payloads[kind]));
		} else {
				// Billing shape (a): a real inline assistant usage (sometimes via
				// a responseModel override) exercises the inline fold against
				// pi's `getUsageCostBreakdown` at every head.
				if (lcg() < 0.2) {
					const entry = assistantWithUsage(seq + 1, 0, 1 + Math.floor(lcg() * 40), lcg() < 0.4 ? 'claude-3-7-sonnet' : undefined);
					pushEntry(entry);
					members.push(entry.id);
				} else {
					const kind = pick(['pi.user', 'pi.assistant', 'pi.toolResult'] as const);
					const entry = message(kind, `m-${step}`, seq + 1, 0);
					pushEntry(entry);
					members.push(entry.id);
				}
			}
			await assertHeadParity(pi, log);
		}
	}, 30_000);
});
