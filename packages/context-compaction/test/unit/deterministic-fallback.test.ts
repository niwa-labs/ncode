/**
 * Wave 3 (canon 05 §2.2/§2.4, item 3.2): the deterministic fallback
 * compaction — the cline `basic` shape (tool activity + last assistant
 * texts), NO provider call.
 *
 * Acceptance: with the breaker open, the BLOCKING edge compacts through the
 * fallback — the projection drops below the goal without a provider call —
 * and the fallback's success resets the breaker. At the background level the
 * open breaker still suppresses the auto-LLM trigger (the fallback is for the
 * edge where the owner's turn is at stake, not for opportunistic
 * maintenance).
 */

import { describe, expect, it } from 'vitest';

import {
  COMPACTION_ENTRY_KIND,
  createBackgroundCompactionScheduler,
  createDeterministicSummaryProducer,
  compact,
} from '../../src/index.js';
import type { BackgroundCompactionScheduler, LogEntry } from '../../src/index.js';
import { MemoryLog, assistantMessage, filler, messageEntry, toolResultMessage, userMessage } from './helpers.js';


/**
 * The realistic fixture: TWO user turns (a cut must land on a turn start),
 * tool calls + results + assistant texts in both, usage anchored at
 * `anchorTokens` on the last assistant (95_000 = the blocking edge of a
 * 100k budget).
 */
function richWindow(anchorTokens = 95_000): LogEntry[] {
  return [
    messageEntry(userMessage('investigate the failing build')),
    messageEntry({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will read the CI logs first.' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/ci/log' } },
      ],
      stopReason: 'toolUse',
    }),
    messageEntry(toolResultMessage(filler(80_000), 'c1')),
    messageEntry({
      role: 'assistant',
      content: [
        { type: 'text', text: 'The failing step is the integration suite.' },
        { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: '/ci/log/2' } },
      ],
      stopReason: 'toolUse',
    }),
    messageEntry(toolResultMessage(filler(80_000), 'c2')),
    messageEntry({
      role: 'assistant',
      content: [{ type: 'text', text: 'The suite lost its database volume; rerunning it now.' }],
    }),
    messageEntry(userMessage('any findings so far?')),
    messageEntry({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Root cause: the test container lost the database volume.' },
      ],
      usage: { totalTokens: anchorTokens },
      stopReason: 'stop',
    }),
  ];
}

interface FallbackFixture {
  readonly log: MemoryLog;
  readonly scheduler: BackgroundCompactionScheduler;
  providerCalls(): number;
}

function createFallbackFixture(
  entries: LogEntry[],
  overrides?: {
    /** When set, the FIRST append rejects with this error (once). */
    readonly failFirstAppendWith?: () => unknown;
    /** Budget override: the fixture window measures a fixed 95k tokens. */
    readonly tokenBudget?: number;
  },
): FallbackFixture {
  const log = new MemoryLog();
  log.entries.push(...entries);
  let providerCalls = 0;
  let failedOnce = false;
  const scheduler = createBackgroundCompactionScheduler({
    budgets: { tokenBudget: overrides?.tokenBudget ?? 100_000 },
    session: {
      entries: log.entries,
      append: async (drafts) => {
        if (overrides?.failFirstAppendWith !== undefined && !failedOnce) {
          failedOnce = true;
          throw overrides.failFirstAppendWith();
        }
        await log.append(drafts);
      },
    },
    summarizer: async () => {
      providerCalls += 1;
      return 'LLM SUMMARY';
    },
    deterministicSummary: createDeterministicSummaryProducer(),
  });
  return { log, scheduler, providerCalls: () => providerCalls };
}

describe('createDeterministicSummaryProducer', () => {
  const producer = createDeterministicSummaryProducer();

  it('is deterministic: the same input yields byte-identical summaries', () => {
    const input = {
      historyMessages: [
        { role: 'user' as const, content: 'question' },
        {
          role: 'assistant' as const,
          content: [
            { type: 'text' as const, text: 'answer one' },
            { type: 'toolCall' as const, id: 'c1', name: 'grep', arguments: {} },
          ],
        },
        {
          role: 'toolResult' as const,
          content: [{ type: 'text' as const, text: 'hits' }],
          toolCallId: 'c1',
        },
      ],
      turnPrefixMessages: [],
      previousSummary: undefined,
    };
    expect(producer(input)).toBe(producer({ ...input, historyMessages: [...input.historyMessages] }));
  });

  it('summarizes tool activity with counts and keeps the last assistant texts verbatim', () => {
    const summary = producer({
      historyMessages: [
        { role: 'user' as const, content: 'q' },
        {
          role: 'assistant' as const,
          content: [
            { type: 'text' as const, text: 'first progress note' },
            { type: 'toolCall' as const, id: 'c1', name: 'grep', arguments: {} },
          ],
        },
        { role: 'toolResult' as const, content: [{ type: 'text' as const, text: 'x' }], toolCallId: 'c1' },
        {
          role: 'assistant' as const,
          content: [
            { type: 'text' as const, text: 'second progress note' },
            { type: 'toolCall' as const, id: 'c2', name: 'grep', arguments: {} },
            { type: 'toolCall' as const, id: 'c3', name: 'read', arguments: {} },
          ],
        },
      ],
      turnPrefixMessages: [],
      previousSummary: undefined,
    });
    expect(summary).toContain('## Tool Activity');
    expect(summary).toContain('- grep (×2)');
    expect(summary).toContain('- read (×1)');
    expect(summary).toContain('## Recent Assistant Progress');
    expect(summary).toContain('first progress note');
    expect(summary).toContain('second progress note');
  });

  it('carries the previous summary sections and its Goal into the fallback', () => {
    const summary = producer({
      historyMessages: [{ role: 'user' as const, content: 'q' }],
      turnPrefixMessages: [],
      previousSummary:
        '## Goal\nShip the fix.\n\n## Key Decisions\n- **Keep the log**: it proved the leak.',
    });
    expect(summary).toContain('## Goal\nShip the fix.');
    expect(summary).toContain('## Key Decisions');
    expect(summary).toContain('**Keep the log**');
  });

  it('records the split-turn prefix request under its own section', () => {
    const summary = producer({
      historyMessages: [],
      turnPrefixMessages: [{ role: 'user' as const, content: 'finish the migration for module X' }],
      previousSummary: undefined,
    });
    expect(summary).toContain('## Current Turn (split)');
    expect(summary).toContain('finish the migration for module X');
  });
});

describe('compact() with the deterministic producer (no provider involvement)', () => {
  it('produces the checkpoint without calling the summarizer and marks the outcome deterministic', async () => {
    let summarizerCalls = 0;
    const outcome = await compact({
      entries: richWindow(),
      summarizer: async () => {
        summarizerCalls += 1;
        return 'LLM SUMMARY';
      },
      deterministicSummary: createDeterministicSummaryProducer(),
      keepRecentTokens: 5_000,
    });
    expect(outcome).not.toBeNull();
    expect(summarizerCalls).toBe(0); // NO provider call
    expect(outcome!.deterministic).toBe(true);
    expect(outcome!.draft.payload).toMatchObject({ deterministic: true });
    expect(outcome!.summary).toContain('## Tool Activity');
    expect(outcome!.usageDraft).toBeUndefined(); // nothing to bill
    expect(outcome!.summaryUsage).toBeUndefined();
  });
});

describe('the scheduler routes the open breaker through the fallback (canon §2.4)', () => {
  it('acceptance: breaker open → the blocking edge drops the projection below the goal with NO provider call', async () => {
    const fixture = createFallbackFixture(richWindow(), {
      // One contract-violating append opens the breaker immediately (the
      // canon table: contract_violation saturates the count).
      failFirstAppendWith: () =>
        new TypeError('Canonical checkpoint compaction must contain one native summary.'),
    });
    const first = fixture.scheduler.notify();
    await expect(first.job).rejects.toThrow(TypeError);
    expect(fixture.scheduler.failureStatus().breakerOpen).toBe(true);
    expect(fixture.providerCalls()).toBe(1); // the LLM ran once, then failed at the commit

    // The BLOCKING edge with the breaker open: the deterministic fallback
    // commits a real checkpoint — no provider call anywhere in it.
    const outcome = await fixture.scheduler.runBlocking();
    expect(outcome).not.toBeNull();
    expect(outcome!.deterministic).toBe(true);
    expect(fixture.providerCalls()).toBe(1); // unchanged — the fallback made NO call
    expect(fixture.log.entries.at(-1)!.kind).toBe(COMPACTION_ENTRY_KIND);
    expect(fixture.log.entries.at(-1)!.payload).toMatchObject({ deterministic: true });
    // The projection dropped below the goal (the ≤90% clamp of the cut).
    expect(fixture.scheduler.usage().tokens).toBeLessThan(90_000);
    // The fallback's success resets the breaker (canon §2.4).
    expect(fixture.scheduler.failureStatus().breakerOpen).toBe(false);
  });

  it('a blocking-level notify with the breaker open starts the fallback job itself', async () => {
    const fixture = createFallbackFixture(richWindow(), {
      failFirstAppendWith: () => new TypeError('bad plan shape'),
    });
    const first = fixture.scheduler.notify();
    await expect(first.job).rejects.toThrow(TypeError);
    expect(fixture.providerCalls()).toBe(1);

    const blocking = fixture.scheduler.notify(); // 95% of the budget → blocking
    expect(blocking.level).toBe('blocking');
    expect(blocking.started).toBe(true); // NOT suppressed: the fallback runs
    const outcome = await blocking.job;
    expect(outcome).not.toBeNull();
    expect(outcome!.deterministic).toBe(true);
    expect(fixture.providerCalls()).toBe(1); // no provider call
    expect(fixture.scheduler.failureStatus().breakerOpen).toBe(false); // success reset
  });

  it('a background-level notify with the breaker open stays suppressed (named skip)', async () => {
    // The fixture window measures a fixed 95k tokens; a 150k budget puts it
    // at ~63% — the background band, below the 75% blocking edge.
    const fixture = createFallbackFixture(richWindow(), {
      failFirstAppendWith: () => new TypeError('bad plan shape'),
      tokenBudget: 150_000,
    });
    const first = fixture.scheduler.notify();
    await expect(first.job).rejects.toThrow(TypeError);

    const suppressed = fixture.scheduler.notify(); // background level → suppressed
    expect(suppressed.level).toBe('background');
    expect(suppressed.started).toBe(false);
    expect(suppressed.skippedReason).toBe('breaker-open');
    expect(fixture.providerCalls()).toBe(1);
  });

  it('with the breaker closed the blocking edge still uses the LLM summarizer', async () => {
    const fixture = createFallbackFixture(richWindow());
    const notification = fixture.scheduler.notify();
    expect(notification.level).toBe('blocking');
    const outcome = await notification.job;
    expect(outcome).not.toBeNull();
    expect(outcome!.deterministic).toBeUndefined();
    expect(fixture.providerCalls()).toBe(1);
    expect((fixture.log.entries.at(-1)!.payload as { deterministic?: unknown }).deterministic).toBeUndefined();
  });
});
