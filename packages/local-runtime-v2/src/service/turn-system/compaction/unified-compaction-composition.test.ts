import { describe, expect, it } from 'vitest';

import type { DurableEntryDraft, LogEntry } from '@mavis/context-compaction';

import { createTurnContextWire } from './context-wire.js';
import {
  createUnifiedCompactionComposition,
  type WireCompactionLogBinding,
} from './unified-compaction-composition.js';

/**
 * W10 Part A — the unified-compaction composition (W05 readiness transfer):
 * the product's per-session model identity + settings resolve through the
 * W05 APIs (resolveCompactionSettings → resolveCompactionBudgets) and the
 * summarizer is built by createModelSummarizer; sessions without a model
 * context or log binding get NO seam (never a silently wrong budget).
 *
 * W10 part B (review w10-review-p1 item 2): the REAL-passing test —
 * `compactionFor` handed to `createTurnContextWire` builds the session
 * pipeline's scheduler, and a crossing budget starts a compaction job over
 * the binding (the append the production composition commits through the
 * canonical `compact` seam).
 */

const SETTINGS = { enabled: true, reserveTokens: 20_000, keepRecentTokens: 8_000 };

describe('createUnifiedCompactionComposition', () => {
  it('resolves per-model budgets through the W05 APIs and builds the summarizer', () => {
    const binding: WireCompactionLogBinding = { entries: () => [], append: async () => {} };
    const composition = createUnifiedCompactionComposition({
      settings: () => SETTINGS,
      resolveSessionModel: (sessionId) =>
        sessionId === 's1'
          ? { modelKey: { provider: 'prov', modelId: 'mdl' }, contextWindowTokens: 100_000 }
          : undefined,
      summaryTransport: () => async () => ({ stopReason: 'stop', text: 'summary' }),
      logBinding: (sessionId) => (sessionId === 's1' ? binding : undefined),
    });

    const seam = composition.compactionFor('s1');
    expect(seam).toBeDefined();
    expect(seam!.entries).toBe(binding.entries);
    expect(seam!.append).toBe(binding.append);
    expect(seam!.budgets.tokenBudget).toBe(100_000);
    // Product policy installs at the owner 75% blocking knob, below the
    // model reserve ceiling (80%).
    expect(seam!.budgets.blockingThresholdRatio).toBeCloseTo(0.75);
    // background clamped to ≤ blocking.
    expect(seam!.budgets.backgroundThresholdRatio!).toBeLessThanOrEqual(
      seam!.budgets.blockingThresholdRatio,
    );
    const resolution = composition.lastResolution('s1');
    expect(resolution?.settings.enabled).toBe(true);
    expect(resolution?.settings.reserveTokens).toBe(20_000);
    // The summarizer is an async function pinned by createModelSummarizer.
    expect(typeof seam!.summarizer).toBe('function');
  });

  it('returns NO seam without model identity or log binding (no silent wrong budget)', () => {
    const composition = createUnifiedCompactionComposition({
      settings: () => SETTINGS,
      resolveSessionModel: () => undefined,
      summaryTransport: () => async () => ({ stopReason: 'stop', text: 'x' }),
      logBinding: () => undefined,
    });
    expect(composition.compactionFor('any')).toBeUndefined();
    expect(composition.lastResolution('any')).toBeUndefined();
  });

  it('compactionFor REALLY reaches the wire pipeline: a crossing budget starts a compaction job over the binding', async () => {
    const appended: DurableEntryDraft[] = [];
    // The binding's LIVE log (the log owner serves it; the scheduler's byte
    // axis evaluates over exactly this array).
    const live: LogEntry[] = [];
    const binding: WireCompactionLogBinding = {
      entries: () => live,
      append: async (drafts) => {
        appended.push(...drafts);
      },
    };
    const composition = createUnifiedCompactionComposition({
      settings: () => SETTINGS,
      resolveSessionModel: () => ({
        modelKey: { provider: 'prov', modelId: 'mdl' },
        contextWindowTokens: 100_000,
        // A small byte budget: seven ~130-byte turns cross the background
        // line, so the pipeline's scheduler MUST run a compaction job.
        byteBudget: 2000,
      }),
      // The cut SIZE is token-driven; the byte axis only selects WHEN.
      keepRecentTokens: () => 40,
      summaryTransport: () => async () => ({ stopReason: 'stop', text: 'unified summary' }),
      logBinding: () => binding,
    });
    const wire = createTurnContextWire({ compactionFor: composition.compactionFor });
    wire.seed({ sessionId: 's1', messages: [] });
    // The session's wire state exists and the seam resolved the W05 budgets.
    expect(composition.lastResolution('s1')?.budgets.byteBudget).toBe(2000);
    // Feed the same commits the wire bridge observes into the live log (the
    // production composition's observeCommit keeps it in sync): the window
    // crosses the byte axis and the scheduler appends a checkpoint draft
    // through the binding — what the production composition commits through
    // the canonical `compact` seam.
    let seq = 0;
    for (let index = 1; index <= 7; index += 1) {
      const messages = [
        { role: 'user', content: `turn-${index}:${'x'.repeat(80)}`, timestamp: index },
        {
          role: 'assistant',
          content: [{ type: 'text', text: `ok-${index}:${'x'.repeat(60)}` }],
          timestamp: index,
        },
      ];
      for (const [ordinal, message] of messages.entries()) {
        live.push({
          id: `log-${seq}-${ordinal}`,
          parentId: null,
          kind: 'mcode.message',
          payload: message,
          seq: ++seq,
          ordinal,
        });
      }
      wire.observeCommit({ sessionId: 's1', reason: 'messageDelta', messages });
    }
    await wire.whenCompactionIdle('s1');
    const checkpoint = appended.find((draft) => draft.kind === 'mcode.compaction');
    expect(checkpoint).toBeDefined();
    // The summarizer's text leads the checkpoint summary (compact() may
    // append its own file-ops/turn-prefix suffix after it).
    expect((checkpoint!.payload as { readonly summary: string }).summary).toContain(
      'unified summary',
    );
  });

  it('a session without a model context keeps the pipeline on the wire guard alone (no append)', async () => {
    const appended: DurableEntryDraft[] = [];
    const composition = createUnifiedCompactionComposition({
      settings: () => SETTINGS,
      resolveSessionModel: () => undefined,
      summaryTransport: () => async () => ({ stopReason: 'stop', text: 'x' }),
      logBinding: () => ({ entries: () => [], append: async (drafts) => { appended.push(...drafts); } }),
    });
    const wire = createTurnContextWire({ compactionFor: composition.compactionFor });
    wire.seed({
      sessionId: 's-no-model',
      messages: [{ role: 'user', content: `x`.repeat(400), timestamp: 1 }],
    });
    await wire.whenCompactionIdle('s-no-model');
    expect(appended).toEqual([]);
  });
});
