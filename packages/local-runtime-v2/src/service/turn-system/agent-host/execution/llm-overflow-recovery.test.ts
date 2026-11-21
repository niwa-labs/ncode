/**
 * В1 (opus-decisions-20261101) — the host half of the llm-retry overflow
 * recovery: `createLlmContextOverflowRecovery` composes
 * `runWithOverflowRecovery` (the exactly-once contract of
 * `@mavis/context-compaction`) around the runner's single continuation.
 * The attempt sequence starts from the ALREADY-OBSERVED original verdict
 * (the failed request is replayed as a verdict, never re-sent), so the
 * compaction precedes the ONE continuation.
 *
 * Covered here (the chain the opus pins):
 * - compact → replaceMessages → exactly ONE retried request; the wire
 *   reseed receives the cut replacement WITHOUT the failed attempt's own
 *   (trailing assistant) record;
 * - the failed attempt's omission is recorded when the episode ends
 *   terminally (the second error), targeting the entries captured after
 *   the compaction — never for a successful recovery (invariant 3);
 * - a non-overflow original verdict or a non-overflow retry failure never
 *   compacts twice and never retries twice;
 * - no unified seam (the jsonl composition): the compaction fails and the
 *   overflow propagates — no retry on an uncompacted window.
 */

import { describe, expect, it } from 'vitest';

import type { LLMContextOverflowRecovery } from '@mavis/agent-core/pi-turn-runner';
import { CONTEXT_EDIT_ENTRY_KIND } from '@mavis/context-compaction';

import { createLlmContextOverflowRecovery } from './llm-overflow-recovery.js';
import type {
  WireCompactionBarrier,
  WireCompactionCheckpoint,
} from '../../compaction/context-wire.js';

function overflowError(): Error {
  return new Error('provider rejected the request: context_length_exceeded');
}

function networkError(): Error {
  return new Error('connection reset by peer');
}

function checkpoint(replacement: WireCompactionCheckpoint['replacement']): WireCompactionCheckpoint {
  return {
    compactionId: 'ctx_test_1',
    summary: 'overflow-recovery summary',
    replacement,
    tokensBefore: 900,
    tokensAfter: 120,
    messagesBefore: 9,
    messagesAfter: replacement.length,
  };
}

interface Harness {
  recovery: LLMContextOverflowRecovery;
  /** Continuations the recovery issued (the real provider requests). */
  continuations: number[];
  compactions: number[];
  reseeds: WireCompactionCheckpoint['replacement'][];
  omissions: { id: string; kind: string; targetIds: readonly string[]; reason: string }[];
  /** The trailing entry the unified log would report after each phase. */
  setLastLogEntry: (role: 'assistant' | undefined) => void;
  /** Removes the unified seam (the jsonl composition). */
  disableBarrier: () => void;
}

function harness(): Harness {
  const continuations: number[] = [];
  const compactions: number[] = [];
  const reseeds: WireCompactionCheckpoint['replacement'][] = [];
  const omissions: Harness['omissions'][number][] = [];
  // The recovery starts AFTER the failed request committed its assistant
  // response: the log tail is the failed record from the outset (and stays
  // it through the compaction rebuild, which keeps the recent tail).
  let lastLogRole: 'assistant' | undefined = 'assistant';
  let barrierLive = true;
  const barrier = (): WireCompactionBarrier | undefined => {
    if (!barrierLive) return undefined;
    return {
      evaluate: () => {
        throw new Error('evaluate is not part of the overflow recovery path');
      },
      runBlocking: async () => {
        if (!barrierLive) return null;
        compactions.push(1);
        return checkpoint([
          {
            role: 'compactionSummary',
            summary: 'overflow-recovery summary',
            tokensBefore: 900,
            timestamp: 1,
          },
          { role: 'user', content: [{ type: 'text', text: 'kept' }], timestamp: 2 },
          { role: 'assistant', content: [{ type: 'text', text: '' }], timestamp: 3 },
        ] as unknown as WireCompactionCheckpoint['replacement']);
      },
    };
  };
  const harness: Harness = {
    recovery: createLlmContextOverflowRecovery({
      sessionId: 's1',
      barrier,
      reseed: (messages) => reseeds.push(messages),
      resolveFailedAttemptEntryIds: () => (lastLogRole === 'assistant' ? ['mcode.message#failed'] : []),
      appendOmissionDraft: async (_sessionId, draft) => {
        const payload = draft.payload as { targetIds: readonly string[]; reason: string };
        omissions.push({
          id: draft.id,
          kind: draft.kind,
          targetIds: payload.targetIds,
          reason: payload.reason,
        });
      },
    }),
    continuations,
    compactions,
    reseeds,
    omissions,
    setLastLogEntry: (role) => {
      lastLogRole = role;
    },
    disableBarrier: () => {
      barrierLive = false;
    },
  };
  return harness;
}

describe('В1 overflow recovery — compact → replaceMessages → ONE retry → omission on the second failure', () => {
  it('compacts once, issues exactly ONE continuation, reseeds the cut window without the failed record', async () => {
    const h = harness();
    let terminalError: unknown;
    try {
      await h.recovery.recover(
        async () => {
          h.continuations.push(1);
          // The retried request still overflows — the terminal failure.
          throw overflowError();
        },
        { error: overflowError() },
      );
    } catch (error) {
      terminalError = error;
    }

    expect(String(terminalError)).toContain('context_length_exceeded');
    expect(h.compactions).toHaveLength(1); // exactly one compaction
    expect(h.continuations).toHaveLength(1); // exactly one retried request
    // The reseed received the cut replacement minus the trailing failed
    // assistant record — the retried request compiles the cut window.
    expect(h.reseeds).toHaveLength(1);
    expect(h.reseeds[0]!.map((message) => Reflect.get(message, 'role'))).toEqual([
      'compactionSummary',
      'user',
    ]);
  });

  it('records the omission on the terminal retry failure — targets captured after the compaction', async () => {
    const h = harness();
    let recoverError: unknown;
    try {
      await h.recovery.recover(
        async () => {
          h.continuations.push(1);
          throw overflowError();
        },
        { error: overflowError() },
      );
    } catch (error) {
      recoverError = error;
    }

    expect(h.continuations).toHaveLength(1);
    expect(recoverError).toBeInstanceOf(Error);
    expect(h.omissions).toHaveLength(1);
    const omission = h.omissions[0]!;
    expect(omission.kind).toBe(CONTEXT_EDIT_ENTRY_KIND);
    expect(omission.targetIds).toEqual(['mcode.message#failed']);
    expect(omission.reason).toContain('overflow recovery failed');
    expect(omission.reason).toContain('context_length_exceeded');
  });

  it('a successful retry records no omission (invariant 3)', async () => {
    const h = harness();
    await h.recovery.recover(
      async () => {
        h.continuations.push(1);
      },
      { error: overflowError() },
    );

    expect(h.continuations).toHaveLength(1);
    expect(h.compactions).toHaveLength(1);
    expect(h.omissions).toHaveLength(0);
  });

  it('a terminal retry failure of any kind records the omission of the FAILED attempt — one compaction, one retry', async () => {
    const h = harness();
    let recoverError: unknown;
    try {
      await h.recovery.recover(
        async () => {
          h.continuations.push(1);
          throw networkError();
        },
        { error: overflowError() },
      );
    } catch (error) {
      recoverError = error;
    }

    // The failed attempt's entries are hidden behind the omission whenever
    // the episode ends terminally (recovery-contract §"A second failure is
    // terminal"); the retry's own error propagates.
    expect(String(recoverError)).toContain('connection reset');
    expect(h.compactions).toHaveLength(1);
    expect(h.continuations).toHaveLength(1);
    expect(h.omissions).toHaveLength(1);
    expect(h.omissions[0]!.targetIds).toEqual(['mcode.message#failed']);
  });

  it('a non-overflow original verdict never compacts and never retries', async () => {
    const h = harness();
    let recoverError: unknown;
    try {
      await h.recovery.recover(
        async () => {
          h.continuations.push(1);
        },
        { error: networkError() },
      );
    } catch (error) {
      recoverError = error;
    }

    expect(String(recoverError)).toContain('connection reset');
    expect(h.compactions).toHaveLength(0);
    expect(h.continuations).toHaveLength(0);
    expect(h.omissions).toHaveLength(0);
  });

  it('no unified seam (jsonl composition): the compaction fails and the overflow propagates — no uncompacted retry', async () => {
    const h = harness();
    h.disableBarrier();
    let recoverError: unknown;
    try {
      await h.recovery.recover(
        async () => {
          h.continuations.push(1);
        },
        { error: overflowError() },
      );
    } catch (error) {
      recoverError = error;
    }

    // The compaction failure replaced the retry: the request is never
    // re-sent on an uncompacted window.
    expect(String(recoverError)).toContain('unified compaction seam is unavailable');
    expect(h.continuations).toHaveLength(0);
    expect(h.reseeds).toHaveLength(0);
    expect(h.omissions).toHaveLength(0);
  });
});
