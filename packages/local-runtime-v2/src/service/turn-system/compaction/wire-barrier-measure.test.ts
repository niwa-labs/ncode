import { describe, expect, it } from 'vitest';

import {
  ContextWirePipeline,
  type WireCompactionCheckpoint,
} from './context-wire.js';
import type { DurableEntryDraft, LogEntry } from '@mavis/context-compaction';

/**
 * Wave 3 (canon 05 §2.6, item 3.3): the В1 admission point resolves the
 * committed checkpoint WITH the unified measure in the post-compaction
 * Context Usage shape — the SAME number the triggers evaluate, marked
 * LOCAL_ESTIMATE (a fresh cut has no usage anchor of its generation).
 */

/** A compactable window: two turns, a summarized prefix, an anchored tail. */
function windowEntries(): LogEntry[] {
  let seq = 0;
  const message = (role: string, content: string, usage?: { totalTokens: number }): LogEntry => {
    seq += 1;
    return {
      id: `m${seq}`,
      parentId: null,
      kind: 'mcode.message',
      payload: {
        role,
        content:
          role === 'assistant'
            ? [{ type: 'text', text: content }]
            : content,
        timestamp: seq,
        ...(role === 'assistant' ? { stopReason: 'stop' } : {}),
        ...(usage ? { usage } : {}),
      },
      seq: seq as LogEntry['seq'],
      ordinal: 0,
    };
  };
  return [
    message('user', 'first question'),
    message('assistant', 'a'.repeat(120_000)),
    message('user', 'second question'),
    message('assistant', 'the tail of the window', { totalTokens: 95_000 }),
  ];
}

describe('В1 barrier resolves the unified measure with the checkpoint (wave 3, item 3.3)', () => {
  it('runBlocking returns the checkpoint with the post-compaction LOCAL_ESTIMATE of the SAME measure', async () => {
    const log: LogEntry[] = windowEntries();
    let checkpoint: WireCompactionCheckpoint | undefined;
    const pipeline = new ContextWirePipeline({
      compaction: {
        summarizer: async () => 'SUMMARY',
        entries: () => log,
        append: async (drafts: readonly DurableEntryDraft[]) => {
          const draft = drafts.find((candidate) => candidate.kind === 'mcode.compaction')!;
          const payload = draft.payload as { summary: string };
          log.push({
            ...draft,
            seq: (log.length + 1) as LogEntry['seq'],
            ordinal: 0,
          });
          checkpoint = {
            compactionId: 'ctx_test',
            summary: payload.summary,
            replacement: [
              { role: 'compactionSummary', summary: payload.summary, tokensBefore: 1, timestamp: 1 },
            ],
            tokensBefore: 1,
            tokensAfter: 1,
            messagesBefore: 1,
            messagesAfter: 1,
          };
        },
        budgets: { tokenBudget: 100_000 },
        checkpointReplacement: () => checkpoint,
      },
    });
    const measureBefore = pipeline.measure();
    expect(measureBefore).toBeDefined();
    expect(measureBefore!.tokens).toBeGreaterThan(90_000); // above the blocking edge

    const barrier = pipeline.compactionBarrier();
    expect(barrier).toBeDefined();
    const resolved = await barrier!.runBlocking();
    expect(resolved).not.toBeNull();

    // The post-commit measure and the barrier's checkpoint agree on ONE
    // number (canon §2.6: метр и триггер показывают одно число).
    const measureAfter = pipeline.measure();
    expect(measureAfter!.estimated).toBe(true); // no anchor of the new generation yet
    expect(resolved!.contextUsage).toBeDefined();
    expect(resolved!.contextUsage!.totalCountSource).toBe('LOCAL_ESTIMATE');
    expect(resolved!.contextUsage!.contextWindowTokens).toBe(100_000);
    expect(resolved!.contextUsage!.usedTokens).toBe(measureAfter!.tokens);
    const componentSum = resolved!.contextUsage!.components.reduce((sum, c) => sum + c.tokens, 0);
    expect(componentSum).toBe(measureAfter!.tokens);
    expect(resolved!.contextUsage!.components).toHaveLength(6);
    // The same evaluation the before-LLM hook would gate on.
    expect(barrier!.evaluate().level).toBe('none'); // the cut reached the goal
  });

  it('the barrier is absent without the compaction seam', () => {
    const pipeline = new ContextWirePipeline({});
    expect(pipeline.compactionBarrier()).toBeUndefined();
    expect(pipeline.measure()).toBeUndefined();
  });
});
