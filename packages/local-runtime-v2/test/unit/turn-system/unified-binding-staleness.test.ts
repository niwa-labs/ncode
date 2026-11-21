import { describe, expect, it } from 'vitest';

import { COMPACTION_ENTRY_KIND } from '@mavis/context-compaction';
import type { DurableEntryDraft } from '@mavis/context-compaction';

import { createProductUnifiedCompaction } from '../../../src/service/turn-system/compaction/product-unified-compaction.js';

/**
 * Wave 3 (canon 05 §2.3/§2.4, items 3.1/3.2): the product binding of the
 * unified compaction.
 *
 * - The canonical attempt snapshot: the projection generation grows ONLY on
 *   replace (own commit / a canonical replaceMessages observation), never on
 *   an append or a seed — the scheduler's key and staleness check read it.
 * - The staleness rule at the append: a result built on a moved generation or
 *   a changed summarizer identity is DISCARDED (a `stale` failure, one
 *   immediate re-plan) — never committed over a replaced history.
 * - The deterministic fallback commits under its own honest method
 *   (`deterministic_fallback`) and the committed checkpoint carries the
 *   marker; the compactionSummary message carries the `compactionId` (the
 *   continuation reminder's once-per-id key).
 */

interface CanonicalDouble {
  readonly commits: {
    readonly method: string;
    readonly messages: readonly unknown[];
    readonly compactionId: string;
  }[];
}

function createBinding(input?: {
  readonly activeMessages?: readonly unknown[];
}) {
  const active = [...(input?.activeMessages ?? [])];
  const commits: CanonicalDouble['commits'] = [];
  const binding = createProductUnifiedCompaction({
    sessions: { get: async () => undefined as never },
    agents: {} as never,
    preparation: {} as never,
    canonicalHistory: {
      readActive: async () => ({ messages: active, identityVector: active.map((_, index) => `id-${index}`) }),
      compact: async (change) => {
        commits.push({
          method: change.method,
          messages: change.messages,
          compactionId: change.compactionId,
        });
        // The durable commit IS the replacement.
        active.length = 0;
        active.push(...change.messages);
        return { generation: 1 };
      },
    },
  });
  return { binding, commits, active };
}

function canonicalUser(text: string, timestamp: number): unknown {
  return { role: 'user', content: text, timestamp };
}

function checkpointDraft(firstKeptEntryId: string, deterministic = false): DurableEntryDraft {
  return {
    id: 'cp-1',
    kind: COMPACTION_ENTRY_KIND,
    payload: {
      summary: 'SUMMARY TEXT',
      firstKeptEntryId,
      systemMessage: null,
      isSplitTurn: false,
      tokensBefore: 500,
      estimatedTokensAfter: 100,
      createdAtMs: 1,
      ...(deterministic ? { deterministic: true } : {}),
    },
  };
}

describe('the product binding: attempt snapshot, staleness, deterministic commit', () => {
  it('the attempt snapshot grows only on replace — never on an append or a seed', () => {
    const { binding } = createBinding();
    binding.observeSeed({
      sessionId: 's',
      messages: [canonicalUser('one', 1), canonicalUser('two', 2)],
      model: { provider: 'p', modelId: 'm', contextWindowTokens: 100_000 },
    });
    const seam = binding.compactionFor('s')!;
    const first = seam.attemptSnapshot!();
    expect(first.baseGeneration).toBe(0);
    expect(first.cut).toContain('2:');

    // An append (a steer mid-job) does NOT move the generation.
    binding.observeCommit({ sessionId: 's', reason: 'messageDelta', messages: [canonicalUser('three', 3)] });
    expect(seam.attemptSnapshot!().baseGeneration).toBe(0);
    expect(seam.attemptSnapshot!().cut).toContain('3:');

    // A canonical replace DOES (the В1 delivery of a committed cut).
    binding.observeCommit({
      sessionId: 's',
      reason: 'replaceMessages',
      messages: [{ role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: 4 }],
    });
    expect(seam.attemptSnapshot!().baseGeneration).toBe(1);
  });

  it('an append whose attempt generation moved is refused — the stale result is discarded', async () => {
    const { binding } = createBinding();
    binding.observeSeed({
      sessionId: 's',
      messages: [canonicalUser('one', 1), canonicalUser('two', 2)],
      model: { provider: 'p', modelId: 'm', contextWindowTokens: 100_000 },
    });
    const seam = binding.compactionFor('s')!;
    const keptEntryId = seam.entries()[1]!.id;
    await expect(
      seam.append([checkpointDraft(keptEntryId)], { generation: 7, identity: 'p/m' }),
    ).rejects.toThrow(/plan is stale/);
  });

  it('an append whose summarizer identity moved is refused too', async () => {
    const { binding } = createBinding();
    binding.observeSeed({
      sessionId: 's',
      messages: [canonicalUser('one', 1), canonicalUser('two', 2)],
      model: { provider: 'p', modelId: 'm', contextWindowTokens: 100_000 },
    });
    const seam = binding.compactionFor('s')!;
    const keptEntryId = seam.entries()[1]!.id;
    await expect(
      seam.append([checkpointDraft(keptEntryId)], { generation: 0, identity: 'p/other-model' }),
    ).rejects.toThrow(/plan is stale/);
  });

  it('a matching attempt commits: the durable method is llm_checkpoint and the generation follows', async () => {
    const seeded = [canonicalUser('one', 1), canonicalUser('two', 2)];
    const { binding, commits } = createBinding({ activeMessages: seeded });
    binding.observeSeed({
      sessionId: 's',
      messages: seeded,
      model: { provider: 'p', modelId: 'm', contextWindowTokens: 100_000 },
    });
    const seam = binding.compactionFor('s')!;
    const keptEntryId = seam.entries()[1]!.id;
    await seam.append([checkpointDraft(keptEntryId)], { generation: 0, identity: 'p/m' });

    expect(commits).toHaveLength(1);
    expect(commits[0]!.method).toBe('llm_checkpoint');
    // The compactionSummary message carries the compaction id (item 3.5).
    const summary = commits[0]!.messages[0] as { role: string; compactionId: string };
    expect(summary.role).toBe('compactionSummary');
    expect(summary.compactionId).toMatch(/^ctx_/);
    // The own replace bumped the projection generation: the next attempt keys on it.
    expect(seam.attemptSnapshot!().baseGeneration).toBe(1);
    // The committed checkpoint feeds the В1 barrier.
    const replacement = seam.checkpointReplacement!();
    expect(replacement?.compactionId).toBe(commits[0]!.compactionId);
    expect(replacement?.replacement.length).toBeGreaterThan(0);
  });

  it('the deterministic fallback commits under deterministic_fallback and marks the checkpoint', async () => {
    const seeded = [canonicalUser('one', 1), canonicalUser('two', 2)];
    const { binding, commits } = createBinding({ activeMessages: seeded });
    binding.observeSeed({
      sessionId: 's',
      messages: seeded,
      model: { provider: 'p', modelId: 'm', contextWindowTokens: 100_000 },
    });
    const seam = binding.compactionFor('s')!;
    expect(seam.deterministicSummary).toBeDefined();
    const keptEntryId = seam.entries()[1]!.id;
    await seam.append([checkpointDraft(keptEntryId, true)], { generation: 0, identity: 'p/m' });

    expect(commits[0]!.method).toBe('deterministic_fallback');
    expect(seam.checkpointReplacement!()?.deterministic).toBe(true);
  });

  it('the deterministic producer summarizes the projection without a provider call', () => {
    const { binding } = createBinding();
    binding.observeSeed({
      sessionId: 's',
      messages: [
        canonicalUser('investigate', 1),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reading the logs' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: {} },
          ],
          timestamp: 2,
        },
      ],
      model: { provider: 'p', modelId: 'm', contextWindowTokens: 100_000 },
    });
    const seam = binding.compactionFor('s')!;
    const summary = seam.deterministicSummary!({
      historyMessages: [
        { role: 'user', content: 'investigate' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reading the logs' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: {} },
          ],
        },
      ] as never,
      turnPrefixMessages: [],
      previousSummary: undefined,
    });
    expect(summary).toContain('## Tool Activity');
    expect(summary).toContain('- read (×1)');
  });
});
