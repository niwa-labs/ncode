import { describe, expect, it } from 'vitest';

import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';

import { createAutomaticContextCompactionHook } from '../../../src/service/turn-system/agent-host/compaction/context-compaction.js';
import type { WireCompactionBarrier, WireCompactionCheckpoint } from '../../../src/service/turn-system/compaction/context-wire.js';

/**
 * Wave 3 (canon 05 §2.4, item 3.5): the WALL — after the deterministic
 * fallback the projection is still above the blocking goal, so the turn
 * STOPS with a clear reason instead of re-entering the compact → «Продолжаю
 * с того места» loop. An LLM checkpoint never triggers the wall (its
 * above-goal outcome is the `ineffective` breaker class, which routes the
 * NEXT blocking edge through the fallback).
 */

function barrierOf(
  checkpoint: WireCompactionCheckpoint | null,
  evaluateLevels: readonly ('none' | 'background' | 'blocking')[] = ['blocking', 'blocking'],
): WireCompactionBarrier {
  let evaluations = 0;
  return {
    evaluate: () => {
      const level = evaluateLevels[Math.min(evaluations, evaluateLevels.length - 1)]!;
      evaluations += 1;
      return {
        level,
        reasons:
          level === 'none'
            ? []
            : [
                { axis: 'tokens' as const, usage: 95_000, budget: 100_000, ratio: 0.95, threshold: 0.9 },
              ],
      };
    },
    runBlocking: async () => checkpoint,
  };
}

function fallbackCheckpoint(): WireCompactionCheckpoint {
  return {
    compactionId: 'ctx_fallback',
    summary: 'fallback summary',
    replacement: [{ role: 'compactionSummary', summary: 'fallback summary', tokensBefore: 1, timestamp: 1 }],
    tokensBefore: 95_000,
    tokensAfter: 92_000,
    messagesBefore: 10,
    messagesAfter: 3,
    deterministic: true,
    contextUsage: {
      contextWindowTokens: 100_000,
      usedTokens: 92_000,
      totalCountSource: 'LOCAL_ESTIMATE',
      components: [
        { kind: 'SYSTEM_PROMPT', tokens: 0 },
        { kind: 'MEMORY', tokens: 0 },
        { kind: 'TOOLS', tokens: 0 },
        { kind: 'SKILLS', tokens: 0 },
        { kind: 'MESSAGES', tokens: 92_000 },
        { kind: 'OTHER', tokens: 0 },
      ],
    },
  };
}

function llmCheckpoint(): WireCompactionCheckpoint {
  return { ...fallbackCheckpoint(), compactionId: 'ctx_llm', deterministic: undefined };
}

function hookWithBarrier(barrier: WireCompactionBarrier | undefined) {
  return createAutomaticContextCompactionHook(
    {
      automatic: undefined, // wire mode: no legacy compactor
      lifecycle: { failCommittedHistory: async () => undefined } as never,
      observer: undefined,
      metricsClient: undefined,
      ...(barrier ? { wireCompactionBarrier: () => barrier } : {}),
      toolResultOffload: undefined,
    },
    { sessionId: 's1', turnId: 't1', turnSequence: 1 },
    'lease-1',
  );
}

function hookInput(phase: 'initial' | 'iteration' = 'iteration'): PiBeforeLlmCallHookInput {
  return {
    sessionId: 's1',
    turnId: 't1',
    phase,
    messages: [],
    canonicalMessages: [],
    model: { modelId: 'm', provider: 'p', api: 'x' } as never,
    thinkingLevel: 'off',
  } as PiBeforeLlmCallHookInput;
}

describe('the compaction wall (wave 3, item 3.5)', () => {
  it('after the deterministic fallback, still above the goal → the turn STOPS with a clear reason', async () => {
    const hook = hookWithBarrier(barrierOf(fallbackCheckpoint(), ['blocking', 'blocking']));
    const decision = await hook(hookInput());
    expect(decision).toMatchObject({ type: 'abort' });
    expect((decision as { reason: string }).reason).toContain('Context compaction wall');
    expect((decision as { reason: string }).reason).toContain('fresh conversation');
  });

  it('after the deterministic fallback below the goal, the cut delivers as replaceMessages', async () => {
    // The gate evaluated blocking (the request waited on the fallback); the
    // post-commit evaluation is below the goal — no wall, the cut delivers.
    const hook = hookWithBarrier(barrierOf(fallbackCheckpoint(), ['blocking', 'none']));
    const decision = await hook(hookInput());
    expect(decision).toMatchObject({ type: 'replaceMessages' });
    expect(
      (decision as { metadata?: { contextUsage?: { totalCountSource: string } } }).metadata?.contextUsage
        ?.totalCountSource,
    ).toBe('LOCAL_ESTIMATE');
  });

  it('an LLM checkpoint never trips the wall — even above the goal it delivers the cut', async () => {
    // The LLM checkpoint's own above-goal outcome is the `ineffective`
    // breaker class; the wall judges only the fallback commit.
    const hook = hookWithBarrier(barrierOf(llmCheckpoint(), ['blocking', 'blocking']));
    const decision = await hook(hookInput());
    expect(decision).toMatchObject({ type: 'replaceMessages' });
  });

  it('the barrier runs only on a blocking crossing — background never waits', async () => {
    let runBlockingCalls = 0;
    const barrier: WireCompactionBarrier = {
      evaluate: () => ({ level: 'background', reasons: [] }),
      runBlocking: async () => {
        runBlockingCalls += 1;
        return fallbackCheckpoint();
      },
    };
    const hook = hookWithBarrier(barrier);
    const decision = await hook(hookInput());
    expect(runBlockingCalls).toBe(0); // the background threshold stays non-blocking
    expect(decision).toMatchObject({ type: 'continue' });
  });
});
