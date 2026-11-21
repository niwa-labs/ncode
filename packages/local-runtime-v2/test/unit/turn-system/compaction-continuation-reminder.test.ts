import { describe, expect, it } from 'vitest';

import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';

import {
  COMPACTION_CONTINUATION_REMINDER_CUSTOM_TYPE,
  createCompactionContinuationReminderHook,
} from '../../../src/service/turn-system/execution/reminder/compaction-continuation-reminder.js';

/**
 * Wave 3 (canon 05 §2.4, item 3.5): the continuation reminder is delivered
 * EXACTLY ONCE per `compaction.id` — the compact → «Продолжаю с того места»
 * loop is structurally impossible: the second request of the same window runs
 * silent.
 */

function hookInput(overrides?: Partial<PiBeforeLlmCallHookInput>): PiBeforeLlmCallHookInput {
  return {
    sessionId: 's1',
    turnId: 't1',
    phase: 'iteration',
    messages: [],
    canonicalMessages: [
      { role: 'compactionSummary', summary: 'the summary', compactionId: 'ctx_1', timestamp: 1, tokensBefore: 10 },
      { role: 'user', content: 'continue please', timestamp: 2 },
    ],
    model: { modelId: 'm', provider: 'p', api: 'x' } as never,
    thinkingLevel: 'off',
    ...overrides,
  } as PiBeforeLlmCallHookInput;
}

describe('the compaction continuation reminder (once per compaction.id)', () => {
  it('delivers the hidden marker once for the compaction id of the window', () => {
    const hook = createCompactionContinuationReminderHook();
    const first = hook(hookInput()) as { type: string; message?: { customType: string; content: string; display: boolean } };
    expect(first.type).toBe('appendMessage');
    expect(first.message!.customType).toBe(COMPACTION_CONTINUATION_REMINDER_CUSTOM_TYPE);
    expect(first.message!.display).toBe(false);
    expect(first.message!.content).toContain('ctx_1');
    expect(first.message!.content).toContain('Continue the work from where it stopped');

    // The SAME window on the next request: silent — the loop is impossible.
    expect(hook(hookInput())).toBeUndefined();
  });

  it('delivers once per compaction id — a NEW compaction reminds again, the old one never re-fires', () => {
    const hook = createCompactionContinuationReminderHook();
    expect(hook(hookInput())).toBeDefined(); // ctx_1 delivered
    expect(hook(hookInput())).toBeUndefined(); // ctx_1 silent

    // A second compaction cut a new window: its own single reminder.
    const second = hook(
      hookInput({
        canonicalMessages: [
          { role: 'compactionSummary', summary: 'newer summary', compactionId: 'ctx_2', timestamp: 2, tokensBefore: 10 },
        ],
      }),
    );
    expect((second as { message?: { content: string } }).message?.content).toContain('ctx_2');

    // ctx_1's window again (an old log replay): still silent for ctx_1.
    expect(hook(hookInput())).toBeUndefined();
  });

  it('a summary without a compaction id keys on its content digest — the same summary is the same compaction', () => {
    const hook = createCompactionContinuationReminderHook();
    const legacy = hookInput({
      canonicalMessages: [{ role: 'compactionSummary', summary: 'pre-wave-3 summary', timestamp: 1, tokensBefore: 10 }],
    });
    expect(hook(legacy)).toBeDefined();
    expect(hook(legacy)).toBeUndefined();
  });

  it('places the marker before the current user on the first request of a turn, appends at the tail mid-turn', () => {
    const hook = createCompactionContinuationReminderHook();
    const initial = hook(hookInput({ phase: 'initial' })) as { placement?: string };
    expect(initial.placement).toBe('before-current-user');
    // The initial-phase delivery consumed the id: the iteration request is silent.
    expect(hook(hookInput({ phase: 'iteration' }))).toBeUndefined();

    const fresh = createCompactionContinuationReminderHook();
    const iteration = fresh(hookInput({ phase: 'iteration' })) as { placement?: string };
    expect(iteration.placement).toBeUndefined(); // end-append: the model continues at the tail
  });

  it('stays silent without a compaction summary in the window', () => {
    const hook = createCompactionContinuationReminderHook();
    expect(hook(hookInput({ canonicalMessages: [{ role: 'user', content: 'hi', timestamp: 1 }] }))).toBeUndefined();
  });

  it('tracks compaction ids per session and stays bounded', () => {
    const hook = createCompactionContinuationReminderHook();
    for (let index = 0; index < 40; index += 1) {
      expect(
        hook(
          hookInput({
            sessionId: `s-${index}`,
            canonicalMessages: [
              { role: 'compactionSummary', summary: `s-${index}`, compactionId: `ctx_${index}`, timestamp: 1, tokensBefore: 1 },
            ],
          }),
        ),
      ).toBeDefined();
    }
    // The same ids again — all still remembered (per-session sets).
    expect(
      hook(hookInput({ sessionId: 's-0', canonicalMessages: [{ role: 'compactionSummary', summary: 's-0', compactionId: 'ctx_0', timestamp: 1, tokensBefore: 1 }] })),
    ).toBeUndefined();
  });
});
