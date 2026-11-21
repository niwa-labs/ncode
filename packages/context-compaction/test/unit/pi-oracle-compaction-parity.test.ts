// Differential compaction parity: our context-compaction core vs the PINNED
// pi v1.3 compaction (W05 T-axis, U09 / V-K02, V-K05).
//
// The oracle is NOT our code: `findCutPoint`, `estimateTokens`,
// `estimateContextTokens`, `estimateProjectedContextTokens`, `shouldCompact`,
// `prepareCompaction` and `serializeConversation`/`computeFileLists`/
// `formatFileOperations` come from the vendored coding-agent source of the
// pinned tree (pin 48c8f32; the oracle reads the pinned source),
// and `buildSessionProjection` from its session-manager.
//
// Declared data mapping (the T-stage mapping of the port plan):
//   our `mcode.message` payload IS a pi AgentMessage;
//   our `mcode.compaction` payload maps to pi `CompactionEntry`
//   (summary/firstKeptEntryId/details);
//   our `mcode.context_edit` omission `{action:'omission', targetIds:[t1..tn]}`
//   maps to n pi `ContextEditEntry` `{targetId: ti, replacement: null}` —
//   pi's pure-omission spelling;
//   our plain audit entries (`mcode.label`) map to pi `LabelEntry`
//   (zero context messages on both sides).
//
// What MUST agree:
//   1. findCutPoint: the exact (firstKeptEntryIndex, turnStartIndex,
//      isSplitTurn) triple on logs without zero-context entries;
//   2. prepareCompaction vs our `compact()` preparation: the same visible
//      kept window, the same messages-to-summarize / turn-prefix split, the
//      same iterative previous-summary handling, the same tokensBefore
//      (pi's `estimateProjectedContextTokens`), the same file-operations
//      section, and the same skip verdicts — on logs with checkpoints,
//      omissions and metadata (pi's trailing-metadata scan-back names an
//      invisible entry as firstKept; ours always names a window-VISIBLE one,
//      which the projection fold requires — visible equivalence, not id
//      equality, is the pinned invariant there);
//   3. serializeConversation: byte equality, including the omission of
//      thinking blocks (V-K02: a huge reasoning fixture), the 2000-char tool
//      result truncation, and pi's "\n" join of multi-block assistant text;
//   4. per-message and window token estimates (anchor + trailing);
//   5. the blocking trigger: pi's `shouldCompact(t, w, {reserveTokens: r})`
//      ⟺ our `evaluateTriggers({tokens: t}, {tokenBudget: w})` blocking at
//      ratio 0.9 with the mapping r = w - 0.9w (documented boundary: ours
//      fires at ratio >= 0.9, pi at strictly > w - r).
//
// Deliberately OUT of the differential surface (documented divergences):
//   - `custom`-role messages: our CompactionMessage spells them
//     customType/text, pi content — projection-level parity for them is
//     pinned in context-projection's pi-oracle-parity suite;
//   - summary PROMPT wording (ours is a deliberate paraphrase; the
//     conversation serialization feeding it is pinned byte-exact instead).
//
// The recovery-omission suffix advance (compaction.ts:818-843) is PORTED and
// pinned as agreement in section 6 below (W05 review pass 1, settled-tail):
// both sides advance over a closed omission suffix and write the same
// checkpoint; the unsent-input and never-crossed-budget guards are pinned
// there too.

import { describe, expect, it } from 'vitest';

import { fileURLToPath } from 'node:url';

import {
	DEFAULT_BLOCKING_THRESHOLD_RATIO,
	compact,
	evaluateTriggers,
	estimateContextTokens,
	estimateMessageTokens,
	estimateProjectedContextTokens,
	findCutPoint,
	projectContext,
	serializeConversation,
} from '../../src/index.js';
import type { LogEntry } from '../../src/index.js';

type PiEntry = Record<string, unknown>;

const PI_CORE = fileURLToPath(
	new URL('../../../../third_party/pi-mono/packages/coding-agent/src/core', import.meta.url),
);

interface PiCompaction {
	findCutPoint: (
		entries: PiEntry[],
		startIndex: number,
		endIndex: number,
		keepRecentTokens: number,
	) => { firstKeptEntryIndex: number; turnStartIndex: number; isSplitTurn: boolean };
	estimateTokens: (message: Record<string, unknown>) => number;
	estimateContextTokens: (messages: Record<string, unknown>[]) => {
		tokens: number;
		usageTokens: number;
		trailingTokens: number;
		lastUsageIndex: number | null;
	};
	estimateProjectedContextTokens: (
		projection: { entries: unknown[]; messages: unknown[] },
		branchEntries: PiEntry[],
	) => { tokens: number; usageTokens: number; trailingTokens: number };
	shouldCompact: (
		contextTokens: number,
		contextWindow: number,
		settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
	) => boolean;
	prepareCompaction: (
		pathEntries: PiEntry[],
		settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
	) => {
		firstKeptEntryId: string;
		messagesToSummarize: Record<string, unknown>[];
		turnPrefixMessages: Record<string, unknown>[];
		isSplitTurn: boolean;
		tokensBefore: number;
		previousSummary?: string;
		fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
	} | undefined;
}

async function loadPi(): Promise<
	PiCompaction & {
		serializeConversation: (messages: Record<string, unknown>[]) => string;
		computeFileLists: (fileOps: PiCompaction['prepareCompaction'] extends undefined ? never : NonNullable<ReturnType<PiCompaction['prepareCompaction']>>['fileOps']) => { readFiles: string[]; modifiedFiles: string[] };
		formatFileOperations: (readFiles: string[], modifiedFiles: string[]) => string;
		buildSessionProjection: (entries: PiEntry[]) => {
			entries: { sourceEntry: PiEntry; messages: Record<string, unknown>[] }[];
		};
	}
> {
	const compaction = (await import(`${PI_CORE}/compaction/compaction.ts`)) as PiCompaction;
	const utils = (await import(`${PI_CORE}/compaction/utils.ts`)) as {
		serializeConversation: (messages: Record<string, unknown>[]) => string;
		computeFileLists: (fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) => { readFiles: string[]; modifiedFiles: string[] };
		formatFileOperations: (readFiles: string[], modifiedFiles: string[]) => string;
	};
	const sessionManager = (await import(`${PI_CORE}/session-manager.ts`)) as {
		buildSessionProjection: PiCompaction & {
			buildSessionProjection: (entries: PiEntry[]) => { entries: { sourceEntry: PiEntry; messages: Record<string, unknown>[] }[] };
		};
	};
	return {
		...compaction,
		serializeConversation: utils.serializeConversation,
		computeFileLists: utils.computeFileLists,
		formatFileOperations: utils.formatFileOperations,
		buildSessionProjection: sessionManager.buildSessionProjection,
	};
}

// ---------------------------------------------------------------------------
// Fixtures and the declared mapping
// ---------------------------------------------------------------------------

const TIMESTAMP = '1970-01-01T00:00:00.000Z';
const USAGE = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

let counter = 0;
const id = (prefix: string) => `${prefix}-${(counter += 1)}`;

function messageEntry(role: 'user' | 'assistant' | 'toolResult', message: Record<string, unknown>): LogEntry {
	counter += 1;
	return {
		id: `m-${counter}`,
		parentId: null,
		kind: 'mcode.message',
		payload: message,
		seq: counter,
		ordinal: 0,
	};
}

function compactionLogEntry(firstKeptEntryId: string, summary: string, details?: { readFiles: string[]; modifiedFiles: string[] }): LogEntry {
	counter += 1;
	return {
		id: `cp-${counter}`,
		parentId: null,
		kind: 'mcode.compaction',
		payload: {
			summary,
			firstKeptEntryId,
			systemMessage: null,
			isSplitTurn: false,
			tokensBefore: 0,
			estimatedTokensAfter: 0,
			createdAtMs: 0,
			...(details !== undefined ? { details } : {}),
		},
		seq: counter,
		ordinal: 0,
	};
}

function omissionLogEntry(targetIds: readonly string[], reason = 'overflow'): LogEntry {
	counter += 1;
	return {
		id: `om-${counter}`,
		parentId: null,
		kind: 'mcode.context_edit',
		payload: { action: 'omission', targetIds: [...targetIds], reason, createdAtMs: 0 },
		seq: counter,
		ordinal: 0,
	};
}

function labelLogEntry(targetId: string): LogEntry {
	counter += 1;
	return { id: `lb-${counter}`, parentId: null, kind: 'mcode.label', payload: { targetId, label: 'x' }, seq: counter, ordinal: 0 };
}

/** The declared mapping: our log → pi session entries (linear parent chain). */
function toPiEntries(log: readonly LogEntry[]): PiEntry[] {
	const out: PiEntry[] = [];
	let prevId: string | null = null;
	for (const entry of log) {
		const base = { id: entry.id, parentId: prevId, timestamp: TIMESTAMP };
		const payload = entry.payload as Record<string, unknown>;
		if (entry.kind === 'mcode.message') {
			out.push({ type: 'message', ...base, message: payload });
		} else if (entry.kind === 'mcode.compaction') {
			out.push({
				type: 'compaction',
				...base,
				summary: payload.summary,
				firstKeptEntryId: payload.firstKeptEntryId,
				tokensBefore: 0,
				...(payload.details !== undefined ? { details: payload.details } : {}),
			});
		} else if (entry.kind === 'mcode.context_edit' && payload.action === 'omission') {
			for (const targetId of payload.targetIds as string[]) {
				out.push({ type: 'context_edit', ...base, targetId, replacement: null });
			}
		} else {
			out.push({ type: 'label', ...base, targetId: payload.targetId ?? entry.id, label: 'x' });
		}
		prevId = entry.id;
	}
	return out;
}

const asUser = (text: string) => messageEntry('user', { role: 'user', content: text });
const asAssistant = (text: string, over: Record<string, unknown> = {}) =>
	messageEntry('assistant', { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', ...over });
const asToolResult = (text: string, toolCallId = 'c1') =>
	messageEntry('toolResult', { role: 'toolResult', toolCallId, content: [{ type: 'text', text }] });

// ---------------------------------------------------------------------------
// 1. findCutPoint: exact triple parity on pure message logs
// ---------------------------------------------------------------------------

describe('differential: findCutPoint (exact triple parity, pure message logs)', () => {
	it('agrees on deterministic turn/tool-pair shapes across budgets', async () => {
		const pi = await loadPi();
		const log = [
			asUser('u1'.repeat(400)),
			asAssistant('a1'),
			asToolResult('r1'.repeat(2000), 'c1'),
			asUser('u2'.repeat(300)),
			asAssistant('a2 with tool call', { content: [{ type: 'toolCall', name: 'read', arguments: { path: '/f' } }] }),
			asToolResult('r2', 'c2'),
			asUser('u3'),
			asAssistant('a3', { usage: USAGE }),
			asUser('u4'.repeat(500)),
		];
		const ours = projectContext(log).entries;
		const piEntries = toPiEntries(log);
		for (const keep of [1, 50, 150, 400, 1200, 10_000]) {
			expect(findCutPoint(ours, 0, ours.length, keep)).toEqual(pi.findCutPoint(piEntries, 0, piEntries.length, keep));
		}
	});

	it('agrees on a giant single turn that overflows any budget (split turn)', async () => {
		const pi = await loadPi();
		// One huge user turn followed by assistant/tool pairs: the kept tail
		// cannot satisfy the budget inside one turn, so the cut splits it.
		const log = [
			asUser('huge '.repeat(20_000)),
			asAssistant('step 1'),
			asToolResult('out 1'.repeat(500)),
			asAssistant('step 2'),
			asToolResult('out 2'.repeat(500)),
			asAssistant('step 3'),
		];
		const ours = projectContext(log).entries;
		const piEntries = toPiEntries(log);
		expect(findCutPoint(ours, 0, ours.length, 200)).toEqual(pi.findCutPoint(piEntries, 0, piEntries.length, 200));
	});

	it('agrees at every head of a randomized message log (LCG)', async () => {
		const pi = await loadPi();
		const lcg = makeLcg(0x91ee05);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(lcg() * items.length) % items.length]!;
		const log: LogEntry[] = [];
		for (let step = 0; step < 80; step += 1) {
			const roll = lcg();
			if (roll < 0.35) log.push(asUser(`u-${step} `.repeat(1 + Math.floor(lcg() * 300))));
			else if (roll < 0.6) log.push(asAssistant(`a-${step} `.repeat(1 + Math.floor(lcg() * 80)), lcg() < 0.4 ? { usage: USAGE } : {}));
			else if (roll < 0.85) log.push(asToolResult(`r-${step} `.repeat(1 + Math.floor(lcg() * 600)), `c-${step}`));
			else log.push(asAssistant('tooling', { content: [{ type: 'toolCall', name: pick(['read', 'edit', 'write']), arguments: { path: `/f-${step}` } }] }));
			const ours = projectContext(log).entries;
			const piEntries = toPiEntries(log);
			const keep = 1 + Math.floor(lcg() * 2500);
			expect(findCutPoint(ours, 0, ours.length, keep)).toEqual(pi.findCutPoint(piEntries, 0, piEntries.length, keep));
		}
	});
});

// ---------------------------------------------------------------------------
// 2. serializeConversation: byte parity (V-K02 thinking omission included)
// ---------------------------------------------------------------------------

describe('differential: serializeConversation (byte parity)', () => {
	it('matches on text, tool calls, truncation and empty content', async () => {
		const pi = await loadPi();
		const messages = [
			{ role: 'user', content: 'plain user' },
			{ role: 'user', content: [{ type: 'text', text: 'block user' }, { type: 'image' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'two' }, { type: 'text', text: 'blocks' }] },
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'hidden reasoning' },
					{ type: 'text', text: 'visible answer' },
					{ type: 'toolCall', name: 'read', arguments: { path: '/a', limit: 10 } },
				],
			},
			{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(1999) }] },
			{ role: 'toolResult', toolCallId: 'c2', content: [{ type: 'text', text: 'y'.repeat(5000) }] },
			{ role: 'toolResult', toolCallId: 'c3', content: '' },
			{ role: 'user', content: '' },
		];
		expect(serializeConversation(messages as never)).toBe(pi.serializeConversation(messages));
	});

	it('V-K02: a huge reasoning transcript never inflates the summary request', async () => {
		const pi = await loadPi();
		const hugeThinking = 'T'.repeat(400_000);
		const messages = [
			asAssistant('before').payload as Record<string, unknown>,
			{ role: 'assistant', content: [{ type: 'thinking', thinking: hugeThinking }, { type: 'text', text: 'short answer' }] },
			asUser('after').payload as Record<string, unknown>,
		];
		const ours = serializeConversation(messages as never);
		expect(ours).toBe(pi.serializeConversation(messages));
		expect(ours.length).toBeLessThan(1000);
		expect(ours).not.toContain('TTTT');
	});
});

// ---------------------------------------------------------------------------
// 3. Token estimates: per message, anchored windows, projected windows
// ---------------------------------------------------------------------------

describe('differential: token estimates', () => {
	it('per-message estimateTokens agrees across the content matrix', async () => {
		const pi = await loadPi();
		const messages = [
			{ role: 'user', content: 'x'.repeat(101) },
			{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(59) }, { type: 'image' }, { type: 'image' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(33) }, { type: 'thinking', thinking: 'k'.repeat(77) }] },
			{ role: 'assistant', content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/f', old: 'a', new: 'b' } }] },
			{ role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'r'.repeat(250) }] },
		];
		for (const message of messages) {
			expect(estimateMessageTokens(message as never)).toBe(pi.estimateTokens(message));
		}
	});

	it('estimateContextTokens agrees: anchor, trailing, no-anchor, aborted/error excluded', async () => {
		const pi = await loadPi();
		const zero = { ...USAGE, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		const messages = [
			{ role: 'user', content: 'u1'.repeat(40) },
			{ role: 'assistant', content: [{ type: 'text', text: 'a1' }], usage: USAGE, stopReason: 'stop' },
			{ role: 'user', content: 'u2'.repeat(20) },
			{ role: 'assistant', content: [{ type: 'text', text: 'aborted' }], usage: USAGE, stopReason: 'aborted' },
			{ role: 'assistant', content: [{ type: 'text', text: 'errored' }], usage: USAGE, stopReason: 'error' },
			{ role: 'assistant', content: [{ type: 'text', text: 'zero' }], usage: zero, stopReason: 'stop' },
			{ role: 'user', content: 'u3'.repeat(60) },
		];
		const ours = estimateContextTokens(messages as never);
		const theirs = pi.estimateContextTokens(messages);
		expect(ours.tokens).toBe(theirs.tokens);
		expect(ours.usageTokens).toBe(theirs.usageTokens);
		expect(ours.trailingTokens).toBe(theirs.trailingTokens);
	});

	it('estimateProjectedContextTokens agrees on anchor invalidation (compaction/edit) and survival (label)', async () => {
		const pi = await loadPi();
		const u1 = asUser('u1'.repeat(100));
		const a1 = asAssistant('anchored', { usage: USAGE });
		const u2 = asUser('u2'.repeat(50));
		const scenarios: Array<{ name: string; suffix: LogEntry[] }> = [
			{ name: 'no invalidation: plain tail after the anchor', suffix: [asUser('tail')] },
			{ name: 'a label after the anchor does not invalidate (both sides)', suffix: [labelLogEntry(u2.id)] },
			{ name: 'a compaction after the anchor invalidates -> pure estimate', suffix: [compactionLogEntry(u2.id, 'cut')] },
			{ name: 'an omission after the anchor invalidates -> pure estimate', suffix: [omissionLogEntry([u2.id])] },
		];
		for (const { name, suffix } of scenarios) {
			const log = [u1, a1, u2, ...suffix];
			const ours = estimateProjectedContextTokens(log);
			const piProjection = pi.buildSessionProjection(toPiEntries(log));
			const theirs = pi.estimateProjectedContextTokens(piProjection as never, toPiEntries(log));
			expect({ tokens: ours.tokens, usageTokens: ours.usageTokens, trailingTokens: ours.trailingTokens }, name).toEqual({
				tokens: theirs.tokens,
				usageTokens: theirs.usageTokens,
				trailingTokens: theirs.trailingTokens,
			});
		}
	});
});

// ---------------------------------------------------------------------------
// 4. The blocking trigger mapping
// ---------------------------------------------------------------------------

describe('differential: blocking trigger (shouldCompact ⟺ evaluateTriggers blocking)', () => {
	it('agrees off the exact boundary under the reserve mapping', async () => {
		const pi = await loadPi();
		const settings = { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 };
		for (const budget of [10_000, 40_000, 123_457]) {
			const reserve = budget - budget * DEFAULT_BLOCKING_THRESHOLD_RATIO;
			for (const tokens of [0, 1, budget * 0.5, budget * 0.89, budget * 0.91, budget]) {
				const piFires = pi.shouldCompact(tokens, budget, { ...settings, reserveTokens: reserve });
				const ourLevel = evaluateTriggers({ tokens }, { tokenBudget: budget }).level;
				expect(ourLevel === 'blocking', `budget=${budget} tokens=${tokens}`).toBe(piFires);
			}
		}
	});

	it('the exact boundary is the documented >= vs > delta (ours two-threshold)', async () => {
		const pi = await loadPi();
		const budget = 10_000;
		const reserve = budget - budget * DEFAULT_BLOCKING_THRESHOLD_RATIO; // 1000
		const at = budget * DEFAULT_BLOCKING_THRESHOLD_RATIO; // exactly 9000
		// pi: 9000 > 10000 - 1000 is FALSE; ours: ratio >= 0.9 fires blocking.
		expect(pi.shouldCompact(at, budget, { enabled: true, reserveTokens: reserve, keepRecentTokens: 20_000 })).toBe(false);
		expect(evaluateTriggers({ tokens: at }, { tokenBudget: budget }).level).toBe('blocking');
	});
});

// ---------------------------------------------------------------------------
// 5. prepareCompaction vs our compact(): preparation-level parity
// ---------------------------------------------------------------------------

async function runOurs(log: readonly LogEntry[], keepRecentTokens: number) {
	const prompts: string[] = [];
	const outcome = await compact({
		entries: [...log],
		summarizer: async (prompt) => {
			prompts.push(prompt);
			return 'SUM';
		},
		keepRecentTokens,
		entryId: 'cp-diff',
		now: () => 0,
	});
	return { outcome, prompts };
}

describe('differential: prepareCompaction vs our compact() preparation', () => {
	it('deterministic scenario: iterative compaction with a previous summary, omissions and metadata', async () => {
		const pi = await loadPi();
		const keep = 120;
		const u1 = asUser('first turn '.repeat(40));
		const a1 = asAssistant('answer 1');
		const r1 = asToolResult('tool out '.repeat(100), 'c1');
		const u2 = asUser('second turn '.repeat(30));
		const a2 = asAssistant('answer 2', { content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/edited' } }] });
		const r2 = asToolResult('out 2', 'c2');
		const cp1 = compactionLogEntry(u2.id, 'checkpoint one', { readFiles: ['/prev-read'], modifiedFiles: ['/prev-mod'] });
		const u3 = asUser('third turn '.repeat(60));
		const a3 = asAssistant('answer 3', { usage: USAGE });
		const om = omissionLogEntry([a3.id]);
		const u4 = asUser('fourth turn '.repeat(20));
		const a4 = asAssistant('final', { content: [{ type: 'toolCall', name: 'read', arguments: { path: '/new-read' } }] });
		const lb = labelLogEntry(u4.id);
		const log = [u1, a1, r1, u2, a2, r2, cp1, u3, a3, om, u4, a4, lb];

		const prep = pi.prepareCompaction(toPiEntries(log), { enabled: true, reserveTokens: 16384, keepRecentTokens: keep });
		const { outcome, prompts } = await runOurs(log, keep);
		expect(prep).toBeDefined();
		expect(outcome).not.toBeNull();

		// tokensBefore IS pi's estimateProjectedContextTokens over the path.
		expect(outcome!.tokensBefore, 'tokensBefore parity').toBe(prep!.tokensBefore);

		// The visible kept window is the same (ids, in order).
		const piProjection = pi.buildSessionProjection(toPiEntries(log));
		const piVisibleById = new Map(piProjection.entries.map((pe) => [pe.sourceEntry.id as string, pe.messages.length > 0]));
		const piEntries = toPiEntries(log);
		const piKeepIdx = piEntries.findIndex((entry) => entry.id === prep!.firstKeptEntryId);
		const piKeptVisible = piEntries
			.filter((entry, index) => index >= piKeepIdx && (piVisibleById.get(entry.id as string) ?? false))
			.map((entry) => entry.id as string);
		const ourProjected = projectContext(log).entries;
		const ourKeepIdx = log.findIndex((entry) => entry.id === outcome!.firstKeptEntryId);
		const ourKeptVisible = ourProjected
			.filter((entry, index) => index >= ourKeepIdx && entry.contextMessages.length > 0)
			.map((entry) => entry.id);
		expect(ourKeptVisible).toEqual(piKeptVisible);
		// OUR first kept entry is always a VISIBLE member — the projection fold
		// resolves firstKeptEntryId against window segments only (pi's
		// trailing-metadata scan-back may name an invisible entry instead).
		expect(ourProjected[ourKeepIdx]!.contextMessages.length).toBeGreaterThan(0);

		// The history prompt carries exactly pi's messagesToSummarize (through
		// the byte-pinned serializer) and pi's iterative previous summary.
		const piSerializedHistory = pi.serializeConversation(prep!.messagesToSummarize);
		const historyPrompt = prompts[0]!;
		expect(historyPrompt).toContain(`<conversation>\n${piSerializedHistory}\n</conversation>`);
		if (prep!.previousSummary !== undefined) {
			expect(historyPrompt).toContain(`<previous-summary>\n${prep!.previousSummary}\n</previous-summary>`);
		} else {
			expect(historyPrompt).not.toContain('<previous-summary>');
		}

		// The split-turn decision and the turn-prefix conversation agree.
		const effectiveSplit = prep!.isSplitTurn && prep!.turnPrefixMessages.length > 0;
		expect(outcome!.isSplitTurn).toBe(effectiveSplit);
		if (effectiveSplit) {
			expect(prompts.length).toBe(2);
			expect(prompts[1]!).toContain(`<conversation>\n${pi.serializeConversation(prep!.turnPrefixMessages)}\n</conversation>`);
		} else {
			expect(prompts.length).toBe(1);
		}

		// The file-operations section appended to the summary is pi's own
		// rendering of pi's own preparation fileOps (seeded from the previous
		// checkpoint's details plus the summarized tool calls).
		const piSection = pi.formatFileOperations(...Object.values(pi.computeFileLists(prep!.fileOps)) as [string[], string[]]);
		expect(outcome!.summary.endsWith(piSection)).toBe(true);
	});

	it('both sides skip when there is nothing to summarize', async () => {
		const pi = await loadPi();
		const u1 = asUser('only turn');
		const a1 = asAssistant('only answer');
		const prep = pi.prepareCompaction(toPiEntries([u1, a1]), { enabled: true, reserveTokens: 16384, keepRecentTokens: 100_000 });
		const { outcome } = await runOurs([u1, a1], 100_000);
		expect(prep).toBeUndefined();
		expect(outcome).toBeNull();
	});

	it('agrees at every head of a randomized log with checkpoints, omissions and metadata (LCG)', async () => {
		const pi = await loadPi();
		const lcg = makeLcg(0x5eed05);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(lcg() * items.length) % items.length]!;
		const log: LogEntry[] = [];
		let members: LogEntry[] = [];
		for (let step = 0; step < 100; step += 1) {
			const roll = lcg();
			if (roll < 0.3) {
				const entry = asUser(`u-${step} `.repeat(1 + Math.floor(lcg() * 200)));
				log.push(entry);
				members.push(entry);
			} else if (roll < 0.55) {
				const entry = asAssistant(`a-${step} `.repeat(1 + Math.floor(lcg() * 60)), {
					...(lcg() < 0.3 ? { usage: USAGE } : {}),
					...(lcg() < 0.4
						? { content: [{ type: 'toolCall', name: pick(['read', 'edit', 'write']), arguments: { path: `/f-${step}` } }] }
						: {}),
				});
				log.push(entry);
				members.push(entry);
			} else if (roll < 0.75) {
				const entry = asToolResult(`r-${step} `.repeat(1 + Math.floor(lcg() * 400)), `c-${step}`);
				log.push(entry);
				// A tool result is never a cut point and never kept alone, but it
				// IS a live member an omission may hide.
				members.push(entry);
			} else if (roll < 0.82 && members.length > 4) {
				// Omit a live member that is NOT the last emitted message (keeps
				// the generator clear of pi's recovery-omission-suffix shape,
				// which has its own dedicated pinned test below).
				const candidates = members.slice(0, Math.max(1, members.length - 1));
				const target = pick(candidates);
				log.push(omissionLogEntry([target.id]));
				members = members.filter((member) => member.id !== target.id);
			} else if (roll < 0.88) {
				log.push(labelLogEntry(pick(members)?.id ?? 'none'));
			} else if (roll < 0.94 && members.length > 3) {
				// Monotone checkpoint at a live member; the next message keeps
				// the log off pi's "compaction is the last entry" skip shape.
				const firstKept = pick(members);
				const checkpoint = compactionLogEntry(
					firstKept.id,
					`cp-${step}`,
					lcg() < 0.5 ? { readFiles: [`/r-${step}`], modifiedFiles: [`/m-${step}`] } : undefined,
				);
				log.push(checkpoint);
				log.push(asUser(`after cp ${step} `.repeat(1 + Math.floor(lcg() * 40))));
				members = members.slice(members.indexOf(firstKept));
				members.push(log[log.length - 1]!);
			} else {
				log.push(asUser(`tail-${step} `.repeat(1 + Math.floor(lcg() * 30))));
				members.push(log[log.length - 1]!);
			}

			if (log[log.length - 1]!.kind === 'mcode.compaction') continue; // pi's skip shape
			const keep = 1 + Math.floor(lcg() * 3000);
			const prep = pi.prepareCompaction(toPiEntries(log), { enabled: true, reserveTokens: 16384, keepRecentTokens: keep });
			const { outcome, prompts } = await runOurs(log, keep);
			if (prep === undefined) {
				expect(outcome, `step ${step}: pi skips, ours must skip too`).toBeNull();
				continue;
			}
			expect(outcome, `step ${step}: pi prepares, ours must produce`).not.toBeNull();
			if (outcome === null) continue;
			expect(outcome.tokensBefore, `step ${step}: tokensBefore`).toBe(prep.tokensBefore);
			const ourProjected = projectContext(log).entries;
			const ourKeepIdx = log.findIndex((entry) => entry.id === outcome.firstKeptEntryId);
			expect(ourProjected[ourKeepIdx]!.contextMessages.length, `step ${step}: our first kept is visible`).toBeGreaterThan(0);

			// pi's trailing scan-back names an INVISIBLE entry (label /
			// context_edit) whenever a run of them directly precedes the cut;
			// ours names the visible cut point. Visible firstKept ⟺ the run
			// is empty ⟺ the cut triples are exact, so:
			//   visible  -> exact split parity + exact history conversation;
			//   invisible-> the history+turn-prefix UNION is one history on
			//               our side (same visible messages, same order).
			const piEntries = toPiEntries(log);
			const piProjection = pi.buildSessionProjection(piEntries);
			const piVisibleById = new Map(piProjection.entries.map((pe) => [pe.sourceEntry.id as string, pe.messages.length > 0]));
			const piKeptIsVisible = piVisibleById.get(prep.firstKeptEntryId) ?? false;
			if (piKeptIsVisible) {
				expect(outcome.isSplitTurn, `step ${step}: split decision`).toBe(prep.isSplitTurn && prep.turnPrefixMessages.length > 0);
				expect(prompts[0], `step ${step}: history conversation`).toContain(
					`<conversation>\n${pi.serializeConversation(prep.messagesToSummarize)}\n</conversation>`,
				);
				if (prep.isSplitTurn && prep.turnPrefixMessages.length > 0) {
					expect(prompts.length, `step ${step}: turn-prefix prompt`).toBe(2);
					expect(prompts[1]!, `step ${step}: turn-prefix conversation`).toContain(
						`<conversation>\n${pi.serializeConversation(prep.turnPrefixMessages)}\n</conversation>`,
					);
				} else {
					expect(prompts.length, `step ${step}: single prompt`).toBe(1);
				}
			} else {
				const union = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
				expect(prompts[0], `step ${step}: union conversation`).toContain(
					`<conversation>\n${pi.serializeConversation(union)}\n</conversation>`,
				);
				expect(prompts.length, `step ${step}: union is one history prompt`).toBe(1);
			}
			const piKeepIdx = piEntries.findIndex((entry) => entry.id === prep.firstKeptEntryId);
			const piKeptVisible = piEntries
				.filter((entry, index) => index >= piKeepIdx && (piVisibleById.get(entry.id as string) ?? false))
				.map((entry) => entry.id as string);
			const ourKeptVisible = ourProjected
				.filter((entry, index) => index >= ourKeepIdx && entry.contextMessages.length > 0)
				.map((entry) => entry.id);
			expect(ourKeptVisible, `step ${step}: visible kept window`).toEqual(piKeptVisible);
		}
	}, 60_000);
});

// ---------------------------------------------------------------------------
// 6. The recovery-omission suffix advance (pin compaction.ts:818-843)
// ---------------------------------------------------------------------------

describe('recovery-omission suffix advance (settled-tail, ported W05 review pass 1)', () => {
	it('pi and ours AGREE: the cut advances past the omitted attempt, the checkpoint names it and summarizes the request', async () => {
		const pi = await loadPi();
		const u1 = asUser('the request');
		const a1 = asAssistant('the failed attempt');
		const om = omissionLogEntry([a1.id]);
		const log = [u1, a1, om];
		const keep = 1;

		const prep = pi.prepareCompaction(toPiEntries(log), { enabled: true, reserveTokens: 16384, keepRecentTokens: keep });
		const { outcome, prompts } = await runOurs(log, keep);

		// pi: the cut advances past the omitted attempt — the preceding user
		// input is summarized and the (invisible) attempt names firstKept.
		expect(prep).toBeDefined();
		expect(prep!.isSplitTurn).toBe(true);
		expect(prep!.messagesToSummarize).toEqual([]);
		expect(prep!.turnPrefixMessages.map((message) => message.content)).toEqual(['the request']);

		// ours: the SAME checkpoint — the advance is ported. The cut names the
		// omitted attempt itself (a live, resolvable window member whose
		// content the omission hides — pi's own naming), the request is
		// summarized as the turn prefix, and exactly ONE summarizer call is
		// made: pi's history leg of an empty messagesToSummarize is the
		// previous-summary placeholder, not a model call.
		expect(outcome).not.toBeNull();
		expect(outcome!.firstKeptEntryId).toBe(prep!.firstKeptEntryId);
		expect(outcome!.firstKeptEntryId).toBe(a1.id);
		expect(outcome!.isSplitTurn).toBe(true);
		expect(outcome!.tokensBefore).toBe(prep!.tokensBefore);
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toContain(`<conversation>\n${pi.serializeConversation(prep!.turnPrefixMessages)}\n</conversation>`);
		// The merged summary is pi's own split-turn glue over the placeholder
		// history and the summarizer's turn-prefix text (no file ops here).
		expect(outcome!.summary).toBe('No prior history.\n\n---\n\n**Turn Context (split turn):**\n\nSUM');

		// Round trip: appending the checkpoint collapses the request into the
		// summary — the window carries the summary ALONE, exactly pi's
		// post-compaction projection ([cp, a1(omitted), om] projects the
		// summary and nothing else).
		const checkpoint = { ...outcome!.draft, seq: 4, ordinal: 0 };
		const projected = projectContext([...log, checkpoint]);
		expect(projected.messages).toHaveLength(1);
		expect((projected.messages[0] as { content: unknown }).content).toBe(outcome!.summary);
		const kept = projected.entries.find((entry) => entry.id === outcome!.firstKeptEntryId);
		expect(kept).toBeDefined();
		// The named first kept entry is the hidden attempt: named, member,
		// context-invisible until a later edit resurrects it.
		expect(kept!.contextMessages).toHaveLength(0);
		expect(kept!.intrinsicallyVisible).toBe(true);
	});

	it('a visible input after the omission pins the cut: neither side advances past unsent input', async () => {
		const pi = await loadPi();
		const u1 = asUser('the request '.repeat(200));
		const a1 = asAssistant('the failed attempt');
		const om = omissionLogEntry([a1.id]);
		const u2 = asUser('the retry input');
		const log = [u1, a1, om, u2];
		// The budget crosses only at u1 (u2 alone is under it), so the cut
		// snaps to u1 and the suffix [a1, om, u2] still holds a VISIBLE
		// member: the closed-suffix condition fails and no side advances.
		const keep = 100;

		const prep = pi.prepareCompaction(toPiEntries(log), { enabled: true, reserveTokens: 16384, keepRecentTokens: keep });
		const { outcome } = await runOurs(log, keep);

		expect(prep).toBeUndefined();
		expect(outcome).toBeNull();
		// The unsent input stays visible in the window.
		const projected = projectContext(log);
		expect(projected.messages.map((message) => (message as { content: unknown }).content)).toEqual([
			'the request '.repeat(200),
			'the retry input',
		]);
	});

	it('no advance when the budget was never crossed, even over a closed omission suffix', async () => {
		const pi = await loadPi();
		const u1 = asUser('the request '.repeat(200));
		const a1 = asAssistant('the failed attempt');
		const om = omissionLogEntry([a1.id]);
		const log = [u1, a1, om];
		// The suffix after the first cut point IS a closed omission series,
		// but the walk never crosses the budget: pi's `exceededBudget` gate
		// (compaction.ts:834) keeps the cut where it is, and so does ours.
		const keep = 1_000_000;

		const prep = pi.prepareCompaction(toPiEntries(log), { enabled: true, reserveTokens: 16384, keepRecentTokens: keep });
		const { outcome } = await runOurs(log, keep);

		expect(prep).toBeUndefined();
		expect(outcome).toBeNull();
	});
});

/** Deterministic LCG in [0, 1). */
function makeLcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}
