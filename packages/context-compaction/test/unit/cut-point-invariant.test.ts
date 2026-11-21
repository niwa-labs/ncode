/**
 * The cut-point invariant END TO END.
 *
 * `cut-point.test.ts` proves the invariant for the pure `findCutPoint` helper.
 * This file proves it for the artifact the invariant actually protects: the
 * durable `mcode.compaction` checkpoint. `compact()` derives
 * `firstKeptEntryId` from the cut, and that id is resolved by the projection
 * fold against context-visible segments — so a checkpoint naming a tool
 * result (or an invisible bookkeeping entry) both breaks the "a cut never
 * separates a tool result from its tool call" rule and lands the fold on an
 * id it cannot resolve.
 *
 * Also covers the two cut-point primitives that had no direct unit test:
 * `findTurnStartIndex` (the split-turn bookkeeping) and `isTurnStartMessage`.
 */

import { describe, expect, it } from 'vitest';

import {
  compact,
  findCutPoint,
  findTurnStartIndex,
  isTurnStartMessage,
  parseCompactionEntry,
  projectContext,
} from '../../src/index.js';
import type { CompactionMessage, LogEntry, ProjectedEntry } from '../../src/index.js';
import {
  RecordingSummarizer,
  assistantMessage,
  customMessage,
  filler,
  messageEntry,
  stamp,
  toolResultMessage,
  userMessage,
} from './helpers.js';

/** The role of a raw `mcode.message` entry, or `undefined` for other kinds. */
function roleOf(entry: LogEntry | undefined): string | undefined {
  if (entry === undefined) return undefined;
  if (entry.kind !== 'mcode.message') return undefined;
  const payload = entry.payload as { role?: unknown } | null;
  return typeof payload?.role === 'string' ? payload.role : undefined;
}

/** Finds the raw log entry the checkpoint names as its first kept entry. */
function entryById(entries: readonly LogEntry[], id: string): LogEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

/**
 * THE invariant, asserted on the durable checkpoint: the named first kept
 * entry is context-visible and is NOT a tool result.
 */
async function assertCheckpointHonoursTheInvariant(
  entries: readonly LogEntry[],
  keepRecentTokens: number,
): Promise<void> {
  const outcome = await compact({
    entries: [...entries],
    summarizer: new RecordingSummarizer('S').call,
    keepRecentTokens,
  });
  if (outcome === null) return; // Nothing to compact: no checkpoint, no invariant to break.

  const payload = parseCompactionEntry(outcome.draft);
  expect(payload).toBeDefined();
  const kept = entryById(entries, outcome.firstKeptEntryId);
  expect(kept, 'the checkpoint must name an entry that exists in the log').toBeDefined();
  // A cut must never separate a tool result from the tool call that produced it.
  expect(roleOf(kept), 'the cut must never land on a tool result').not.toBe('toolResult');
  // The named entry must be visible to the projection: an invisible id (audit
  // bookkeeping) can never be resolved by the projection fold.
  const projected = projectContext([...entries, stamp(outcome.draft, entries.length + 1, 0)]);
  const keptProjected = projected.entries.find((entry) => entry.id === outcome.firstKeptEntryId);
  expect(keptProjected).toBeDefined();
  expect(keptProjected!.contextMessages.length, 'the cut must land on a context-visible entry').toBeGreaterThan(0);
}

describe('the durable checkpoint honours the cut-point invariant', () => {
  it('never names a tool result across many log shapes', async () => {
    // Every shape mixes the three roles that decide the cut: user (turn
    // start), assistant (cut point, not a turn start) and tool result (never a
    // cut point). The tail is deliberately over budget so the cut really moves.
    const shapes: readonly (() => LogEntry[])[] = [
      () => [
        messageEntry(userMessage('start')),
        messageEntry(assistantMessage('working')),
        messageEntry(toolResultMessage(filler(40_000), 'c0')),
        messageEntry(assistantMessage('still working')),
        messageEntry(toolResultMessage(filler(40_000), 'c1')),
      ],
      () => [
        messageEntry(userMessage('a')),
        messageEntry(toolResultMessage(filler(80_000), 'c0')),
        messageEntry(userMessage('b')),
        messageEntry(assistantMessage('c')),
        messageEntry(toolResultMessage(filler(80_000), 'c1')),
      ],
      () => [
        messageEntry(userMessage('only user')),
        messageEntry(toolResultMessage(filler(120_000), 'c0')),
      ],
      () => [
        messageEntry(userMessage('turn')),
        messageEntry(customMessage('hook', 'a hook fired')),
        messageEntry(toolResultMessage(filler(60_000), 'c0')),
        messageEntry(assistantMessage('done')),
      ],
    ];

    for (const shape of shapes) {
      await assertCheckpointHonoursTheInvariant(shape(), 4_000);
    }
  });

  it('snaps the cut back to the assistant tool call when the tail is all tool results', async () => {
    const entries: LogEntry[] = [
      messageEntry(userMessage('run the tool')),
      messageEntry(assistantMessage('calling the tool')),
      messageEntry(toolResultMessage(filler(120_000), 'c0')),
      messageEntry(toolResultMessage(filler(120_000), 'c1')),
    ];
    const outcome = await compact({
      entries,
      summarizer: new RecordingSummarizer('S').call,
      keepRecentTokens: 2_000,
    });
    expect(outcome).not.toBeNull();
    // The kept tail starts at the assistant message, not at a tool result.
    expect(roleOf(entryById(entries, outcome!.firstKeptEntryId))).toBe('assistant');
  });

  it('keeps the invariant when the log carries audit bookkeeping between the messages', async () => {
    // Audit/control entries project nothing: they are dead weight on both
    // sides of the cut and must never become the named first kept entry.
    const entries: LogEntry[] = [
      messageEntry(userMessage('question')),
      { id: 'audit-1', parentId: null, kind: 'mcode.owner-input.received', payload: { received: 'x' }, seq: 0, ordinal: 0 },
      messageEntry(assistantMessage(filler(40_000))),
      { id: 'audit-2', parentId: null, kind: 'mcode.owner-input.received', payload: { received: 'y' }, seq: 0, ordinal: 0 },
      messageEntry(toolResultMessage(filler(40_000), 'c0')),
      { id: 'audit-3', parentId: null, kind: 'mcode.owner-input.received', payload: { received: 'z' }, seq: 0, ordinal: 0 },
    ];
    await assertCheckpointHonoursTheInvariant(entries, 2_000);
  });

  it('writes no empty checkpoint when only a compaction summary is in range', async () => {
    // The range holds nothing but a checkpoint summary: summarizing it again
    // would nest an old summary into a new one. `compact()` must return null.
    const base: LogEntry[] = [messageEntry(userMessage('hello'))];
    const checkpoint = stamp(
      {
        id: 'cp-1',
        parentId: null,
        kind: 'mcode.compaction',
        payload: {
          summary: 'PRIOR-SUMMARY',
          firstKeptEntryId: base[0]!.id,
          systemMessage: null,
          isSplitTurn: false,
          tokensBefore: 100,
          estimatedTokensAfter: 10,
          createdAtMs: 0,
        },
        seq: 2,
        ordinal: 0,
      },
      2,
      0,
    );
    const summarizer = new RecordingSummarizer('SHOULD-NOT-RUN');
    const outcome = await compact({ entries: [...base, checkpoint], summarizer: summarizer.call, keepRecentTokens: 1 });
    expect(outcome).toBeNull();
    expect(summarizer.callCount).toBe(0);
  });
});

describe('findTurnStartIndex', () => {
  const entries: LogEntry[] = [
    messageEntry(userMessage('u0')),
    messageEntry(assistantMessage('a0')),
    messageEntry(toolResultMessage('t0')),
    messageEntry(userMessage('u1')),
    messageEntry(assistantMessage('a1')),
  ];
  const projected: readonly ProjectedEntry[] = projectContext(entries).entries;

  it('finds the user-like entry that starts the turn of the given index', () => {
    // The turn of index 4 starts at the user message of index 3.
    expect(findTurnStartIndex(projected, 4, 0)).toBe(3);
    expect(findTurnStartIndex(projected, 3, 0)).toBe(3);
  });

  it('walks back over the assistant and tool result of the same turn', () => {
    // Index 2 is the tool result of the turn that started at index 0.
    expect(findTurnStartIndex(projected, 2, 0)).toBe(0);
    expect(findTurnStartIndex(projected, 1, 0)).toBe(0);
  });

  it('returns -1 when the range holds no turn start', () => {
    expect(findTurnStartIndex(projected, 4, 4)).toBe(-1);
    expect(findTurnStartIndex(projected, 0, 1)).toBe(-1);
  });

  it('never treats a compaction checkpoint as a turn start', () => {
    // The checkpoint projects a user-shaped summary, but it is not a turn:
    // the search must skip it and keep looking for a real user entry.
    const withCheckpoint: LogEntry[] = [
      ...entries,
      stamp(
        {
          id: 'cp-1',
          parentId: null,
          kind: 'mcode.compaction',
          payload: {
            summary: 'S',
            firstKeptEntryId: entries[0]!.id,
            systemMessage: null,
            isSplitTurn: false,
            tokensBefore: 1,
            estimatedTokensAfter: 1,
            createdAtMs: 0,
          },
          seq: 9,
          ordinal: 0,
        },
        9,
        0,
      ),
    ];
    const projectedWithCheckpoint = projectContext(withCheckpoint).entries;
    expect(projectedWithCheckpoint.at(-1)!.isCompaction).toBe(true);
    // The checkpoint itself projects a user-shaped message...
    expect(projectedWithCheckpoint.at(-1)!.contextMessages[0]!.role).toBe('user');
    // ...but the turn search skips it and reports the real user turn start.
    expect(findTurnStartIndex(projectedWithCheckpoint, projectedWithCheckpoint.length - 1, 0)).toBe(3);
  });
});

describe('isTurnStartMessage', () => {
  it('starts a turn at user and custom messages only', () => {
    expect(isTurnStartMessage(userMessage('hi'))).toBe(true);
    expect(isTurnStartMessage(customMessage('hook', 'text'))).toBe(true);
    expect(isTurnStartMessage(assistantMessage('hi'))).toBe(false);
    expect(isTurnStartMessage(toolResultMessage('out'))).toBe(false);
  });

  it('treats a custom message as both a turn start and a valid cut point', () => {
    const projected = projectContext([
      messageEntry(userMessage('u')),
      messageEntry(customMessage('hook', 'h')),
      messageEntry(toolResultMessage(filler(40_000), 'c0')),
    ]).entries;
    const cut = findCutPoint(projected, 0, projected.length, 1_000);
    // The cut snapped forward to the custom message: the tool result after it
    // is never a cut point.
    const kept = projected[cut.firstKeptEntryIndex]!;
    expect(kept.contextMessages[0]!.role).toBe('custom');
  });
});

describe('the cut never lands on a compaction checkpoint', () => {
  it('skips the checkpoint entry even when the budget crosses exactly at it', () => {
    const base: LogEntry[] = [
      messageEntry(userMessage('u0')),
      messageEntry(assistantMessage('a0')),
      messageEntry(userMessage('u1')),
    ];
    const checkpoint = stamp(
      {
        id: 'cp-1',
        parentId: null,
        kind: 'mcode.compaction',
        payload: {
          summary: 'S',
          firstKeptEntryId: base[0]!.id,
          systemMessage: null,
          isSplitTurn: false,
          tokensBefore: 1,
          estimatedTokensAfter: 1,
          createdAtMs: 0,
        },
        seq: 4,
        ordinal: 0,
      },
      4,
      0,
    );
    const projected = projectContext([...base, checkpoint]).entries;
    // The checkpoint projects a user-shaped summary, so it LOOKS like a cut
    // point — but a checkpoint is a boundary, never a cut target.
    expect(projected.at(-1)!.contextMessages[0]!.role).toBe('user');

    for (const budget of [1, 10, 100, 10_000]) {
      const cut = findCutPoint(projected, 0, projected.length, budget);
      expect(cut.firstKeptEntryIndex).not.toBe(projected.length - 1);
    }
  });
});

describe('cut-point role matrix', () => {
  it('keeps the roles that decide a cut and the roles that never do apart', () => {
    // A tiny table makes the rule explicit: only user/assistant/custom can
    // carry a cut; toolResult never can.
    const cases: readonly { message: CompactionMessage; cuttable: boolean; turnStart: boolean }[] = [
      { message: userMessage('u'), cuttable: true, turnStart: true },
      { message: assistantMessage('a'), cuttable: true, turnStart: false },
      { message: customMessage('hook', 'h'), cuttable: true, turnStart: true },
      { message: toolResultMessage('t'), cuttable: false, turnStart: false },
    ];
    for (const testCase of cases) {
      const projected = projectContext([messageEntry(testCase.message)]).entries;
      const cut = findCutPoint(projected, 0, projected.length, 1);
      if (testCase.cuttable) {
        // The single entry IS a cut point, so the cut lands on it.
        expect(projected[cut.firstKeptEntryIndex]!.contextMessages[0]!.role).toBe(testCase.message.role);
      } else {
        // A lone tool result holds no cut point at all: the fallback keeps the
        // window from the start. The entry is KEPT, not cut at — there is
        // nothing else it could snap forward to.
        expect(cut.firstKeptEntryIndex).toBe(0);
        expect(cut.isSplitTurn).toBe(false);
        expect(cut.turnStartIndex).toBe(-1);
      }
      expect(isTurnStartMessage(testCase.message)).toBe(testCase.turnStart);
    }
  });
});
