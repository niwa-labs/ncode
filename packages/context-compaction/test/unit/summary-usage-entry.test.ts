// Summary-usage billing mirror (W05 review pass 2, V-U02 writer half).
//
// The pin carries the summarizer's provider usage ON the compaction entry
// (`appendCompaction(..., usage)` → the "Tools/summaries" billing bucket,
// coding-agent session-manager + usage-totals). Our declared writer mapping
// persists the same numbers as an EXPLICIT `mcode.usage` entry under the
// `summary` category, appended with the checkpoint in one writer-gated
// batch. This suite pins the whole path:
//
//   1. `createModelSummarizer` answers in the `SummaryResult` form — the
//      text plus the call's OWN usage attributed to the summarizer model
//      (a response that is then REJECTED throws instead: no result, no
//      checkpoint, nothing billed);
//   2. `compact()` combines a cycle's calls (history + turn prefix), copies
//      the attribution from the summarizer model, and normalizes the
//      transport subset into the FULL usage payload (missing counters -> 0,
//      `totalTokens` falls back to the counter sum, pi `calculateContextTokens`);
//   3. a plain `Summarizer` (bare string return) invents NO spend — no usage
//      fields, no draft;
//   4. an all-zero usage record writes nothing (pi's rendered zero filter);
//   5. the scheduler appends checkpoint + usage draft in ONE batch;
//   6. the produced payload decodes through `@mavis/context-projection`'s
//      STRICT `UsagePayload` reader and folds under BOTH axes (the
//      cross-package bridge, same pattern as checkpoint-cross-package).

import { describe, expect, it } from 'vitest';

import {
  USAGE_ENTRY_KIND,
  SummaryRejectedError,
  compact,
  createBackgroundCompactionScheduler,
  createModelSummarizer,
} from '../../src/index.js';
import type { DurableEntryDraft, LogEntry, SummaryResponse, SummaryTransport } from '../../src/index.js';
import { MemoryLog, RecordingSummarizer, assistantMessage, filler, messageEntry, userMessage } from './helpers.js';
import { buildProjection } from '../../../context-projection/src/index.js';
import type { Entry, JsonValue, Seq } from '../../../durable-backend-sqlite-zstd/src/types.js';

const MODEL = { provider: 'anthropic', modelId: 'claude-summarizer', maxTokens: 8192 };

/** Transport double serving fixed responses with per-call usage. */
function transportWithUsage(usages: ReadonlyArray<SummaryResponse['usage']>): SummaryTransport & {
  readonly calls: number;
} {
  let calls = 0;
  const transport: SummaryTransport = async () => {
    const usage = usages[Math.min(calls, usages.length - 1)];
    calls += 1;
    return {
      text: `summary-${calls}`,
      stopReason: 'stop',
      ...(usage === undefined ? {} : { usage }),
    };
  };
  return Object.assign(transport, {
    get calls(): number {
      return calls;
    },
  });
}

/** Log big enough that a 20000-token keep-recent budget must cut something. */
function compactableLog(): LogEntry[] {
  return [
    messageEntry(userMessage(`first ${filler(2000)}`)),
    messageEntry(assistantMessage(filler(2000), { totalTokens: 1000 })),
    messageEntry(userMessage(`last ${filler(200)}`)),
  ];
}

describe('createModelSummarizer: the SummaryResult return form', () => {
  it('each call RETURNS its own usage attributed to the summarizer model', async () => {
    const summarizer = createModelSummarizer(
      MODEL,
      transportWithUsage([{ input: 10, output: 5 }, { input: 7, output: 3 }]),
    );
    await expect(summarizer('p1')).resolves.toEqual({
      text: 'summary-1',
      usage: { provider: 'anthropic', model: 'claude-summarizer', usage: { input: 10, output: 5 } },
    });
    await expect(summarizer('p2')).resolves.toEqual({
      text: 'summary-2',
      usage: { provider: 'anthropic', model: 'claude-summarizer', usage: { input: 7, output: 3 } },
    });
  });

  it('a rejected response THROWS — no result exists, nothing is billed', async () => {
    let transportCall = 0;
    const summarizer = createModelSummarizer(MODEL, async () => {
      transportCall += 1;
      return { text: '', stopReason: 'length', usage: { input: 42 } };
    });
    await expect(summarizer('p')).rejects.toThrow(SummaryRejectedError);
    expect(transportCall).toBe(1);
  });

  it('omits usage entirely when the transport carries no usage block', async () => {
    const summarizer = createModelSummarizer(MODEL, transportWithUsage([undefined]));
    const result = await summarizer('p');
    expect(result).toEqual({ text: 'summary-1' });
    expect(typeof result === 'string' || result.usage).toBeFalsy();
  });
});

describe('compact(): the summary usage mirror on the outcome', () => {
  it('combines the cycle calls into one mcode.usage draft (category summary, full payload)', async () => {
    const summarizer = createModelSummarizer(
      MODEL,
      transportWithUsage([{ input: 100, output: 40 }, { input: 60, output: 20, cost: { total: 0.5 } }]),
    );
    const outcome = await compact({ entries: compactableLog(), summarizer, keepRecentTokens: 50 });
    expect(outcome).not.toBeNull();
    // One summarizer call (no split turn in this log): the history call only.
    expect(outcome!.summaryUsage).toEqual({
      provider: 'anthropic',
      model: 'claude-summarizer',
      usage: { input: 100, output: 40 },
    });
    expect(outcome!.usageDraft).toBeDefined();
    expect(outcome!.usageDraft!.kind).toBe(USAGE_ENTRY_KIND);
    expect(outcome!.usageDraft!.payload).toEqual({
      kind: 'summary',
      provider: 'anthropic',
      model: 'claude-summarizer',
      usage: {
        input: 100,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        // pi calculateContextTokens: totalTokens ?? sum of the counters.
        totalTokens: 140,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      note: 'compaction summary',
    });
  });

  it('a plain summarizer invents no spend — no summaryUsage, no usage draft', async () => {
    const recording = new RecordingSummarizer('SUMMARY');
    const outcome = await compact({ entries: compactableLog(), summarizer: recording.call, keepRecentTokens: 50 });
    expect(outcome).not.toBeNull();
    expect('summaryUsage' in outcome!).toBe(false);
    expect('usageDraft' in outcome!).toBe(false);
  });

  it('an all-zero usage record writes no usage entry (pi zero-row filter)', async () => {
    const summarizer = createModelSummarizer(MODEL, transportWithUsage([{ input: 0, output: 0 }]));
    const outcome = await compact({ entries: compactableLog(), summarizer, keepRecentTokens: 50 });
    expect(outcome).not.toBeNull();
    // Zero spend stays real data — the record exists but carries no counters
    // (subset shape: zero-sum fields drop) — and drafts nothing; the
    // projection's zero-drop would ignore the entry anyway.
    expect(outcome!.summaryUsage?.usage).toEqual({});
    expect('usageDraft' in outcome!).toBe(false);
  });

  it('a split turn SUMS the history and turn-prefix calls', async () => {
    // The pinned split-turn shape (split-turn.test.ts): turn B far bigger
    // than the budget, so the cut splits it — history (turn A) and turn
    // prefix (B's head) are TWO summarizer calls in one cycle.
    const log: LogEntry[] = [
      messageEntry(userMessage('start the work')), // turn A
      messageEntry(assistantMessage('ok', { totalTokens: 500 })),
      messageEntry({ role: 'toolResult', content: [{ type: 'text', text: filler(40_000) }], toolCallId: 'c0' }),
      messageEntry(userMessage('fix the build')), // turn B (the split one)
      messageEntry(assistantMessage('reading logs')),
      messageEntry({ role: 'toolResult', content: [{ type: 'text', text: filler(60_000) }], toolCallId: 'c1' }),
      messageEntry(assistantMessage('found the failing test')),
      messageEntry({ role: 'toolResult', content: [{ type: 'text', text: filler(60_000) }], toolCallId: 'c2' }),
      messageEntry(assistantMessage('patching now')),
    ];
    const summarizer = createModelSummarizer(
      MODEL,
      transportWithUsage([{ input: 100, output: 40 }, { input: 60, output: 20 }]),
    );
    const outcome = await compact({ entries: log, summarizer, keepRecentTokens: 8_000 });
    expect(outcome).not.toBeNull();
    if (!outcome!.isSplitTurn) {
      throw new Error('expected a split turn, got a plain cut');
    }
    // Both calls' returns are combined (the accessor-free contract: the
    // outcome carries the SUM of both calls with the summarizer model's
    // attribution).
    expect(outcome!.summaryUsage).toEqual({
      provider: 'anthropic',
      model: 'claude-summarizer',
      usage: { input: 160, output: 60 },
    });
    const payload = outcome!.usageDraft!.payload as { usage: { input: number; output: number; totalTokens: number } };
    expect(payload.usage.input).toBe(160);
    expect(payload.usage.output).toBe(60);
    expect(payload.usage.totalTokens).toBe(220);
  });
});

describe('scheduler: the usage draft rides the checkpoint batch', () => {
  function stamped(drafts: readonly DurableEntryDraft[]): LogEntry[] {
    return drafts.map((draft, ordinal) => ({ ...draft, seq: ordinal + 1, ordinal }));
  }

  it('runBlocking appends checkpoint AND usage entry in ONE writer-gated batch', async () => {
    const log = new MemoryLog();
    log.entries.push(...compactableLog());
    const batches: DurableEntryDraft[][] = [];
    const summarizer = createModelSummarizer(MODEL, transportWithUsage([{ input: 100, output: 40 }]));
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 10_000 },
      keepRecentTokens: 50,
      session: {
        entries: log.entries,
        append: async (drafts) => {
          batches.push([...drafts]);
          await log.append(drafts);
        },
      },
      summarizer,
    });
    const outcome = await scheduler.runBlocking();
    expect(outcome).not.toBeNull();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]!.map((draft) => draft.kind)).toEqual(['mcode.compaction', USAGE_ENTRY_KIND]);
    // The log itself now carries both entries; re-projecting the compacted
    // window still works (usage entries are control entries — invisible to
    // the LLM window, folded for billing only).
    expect(log.entries.filter((entry) => entry.kind === USAGE_ENTRY_KIND)).toHaveLength(1);
  });

  it('a plain summarizer appends the checkpoint alone', async () => {
    const log = new MemoryLog();
    log.entries.push(...compactableLog());
    const batches: DurableEntryDraft[][] = [];
    const recording = new RecordingSummarizer('SUMMARY');
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 10_000 },
      keepRecentTokens: 50,
      session: {
        entries: log.entries,
        append: async (drafts) => {
          batches.push([...drafts]);
          await log.append(drafts);
        },
      },
      summarizer: recording.call,
    });
    await scheduler.runBlocking();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]!.kind).toBe('mcode.compaction');
    expect(stamped(batches[0]!)).toHaveLength(1);
  });
});

describe('cross-package: the usage draft decodes and folds in the projection', () => {
  it('the mcode.usage payload passes the strict reader and folds under both axes', async () => {
    const summarizer = createModelSummarizer(MODEL, transportWithUsage([{ input: 100, output: 40, cost: { total: 0.3 } }]));
    const outcome = await compact({ entries: compactableLog(), summarizer, keepRecentTokens: 50 });
    expect(outcome!.usageDraft).toBeDefined();

    const usageEntry: Entry = {
      id: outcome!.usageDraft!.id,
      parentId: null,
      kind: USAGE_ENTRY_KIND,
      payload: outcome!.usageDraft!.payload as JsonValue,
      seq: 1 as Seq,
      ordinal: 0,
    };
    const manifest = buildProjection([usageEntry]);
    // BOTH pi axes: provider/model AND the writer-defined category.
    expect(manifest.usage!.models['anthropic/claude-summarizer']!.input).toBe(100);
    expect(manifest.usage!.models['anthropic/claude-summarizer']!.cost.total).toBe(0.3);
    expect(manifest.usage!.categories.summary!.input).toBe(100);
    // A usage entry never becomes an LLM segment (V-U02: billing never
    // pollutes context).
    expect(manifest.segments).toEqual([]);
  });
});
