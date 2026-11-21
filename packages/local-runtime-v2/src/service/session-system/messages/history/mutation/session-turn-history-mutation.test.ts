import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TOOL_OUTCOME_UNKNOWN } from '@mavis/storage-worker';

import { inspectCanonicalHistorySequence } from '../../../sessions/representation/canonical-history-contract.js';
import {
  planCloseReleasedToolRound,
  planSettleTurnTail,
  type SettleTurnTailInput,
} from './session-turn-history-mutation.js';

/**
 * Incident 03 (2026-11-05) abort reconcile: an aborted turn's unclosed tool
 * round is CLOSED by the settlement — with unknown-outcome error results for
 * ALL accepted calls of the round, not only the ones whose effects started —
 * instead of being abandoned (`unchanged`) for the next non-toolResult delta
 * to trip the strict sequence walk on.
 */

const BASE_INPUT: SettleTurnTailInput = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  operationId: 'agent-host:turn-1:history:abort-reconcile',
  mode: 'abort',
  approvedContent: '',
  timestampMs: 1_000,
};

function envelope(
  messageId: string,
  turnId: string,
  message: Record<string, unknown>,
): { message_id: string; turn_id: string; message: Record<string, unknown> } {
  return { message_id: messageId, turn_id: turnId, message };
}

function user(text: string, turnId = 'turn-1') {
  return envelope(`msg-user-${text}`, turnId, { role: 'user', content: text, timestamp: 1 });
}

function assistantWithCalls(
  messageId: string,
  calls: readonly { readonly id: string; readonly name: string }[],
  turnId = 'turn-1',
) {
  return envelope(messageId, turnId, {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: {},
    })),
    timestamp: 2,
  });
}

function toolResult(
  messageId: string,
  callId: string,
  toolName: string,
  turnId = 'turn-1',
) {
  return envelope(messageId, turnId, {
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content: [{ type: 'text', text: 'started result' }],
    isError: true,
    timestamp: 3,
  });
}

function abortInput(overrides: Partial<SettleTurnTailInput> = {}): SettleTurnTailInput {
  return { ...BASE_INPUT, ...overrides };
}

describe('planSettleTurnTail abort: closing the unclosed tool round (incident 03)', () => {
  it('synthesizes unknown-outcome results for every accepted call without one', () => {
    // The owner scenario: two parallel task calls accepted, only the first
    // ever started and committed its task_error; the second never started.
    const active = [
      user('dig'),
      assistantWithCalls('msg-assistant-1', [
        { id: 'call-1', name: 'task' },
        { id: 'call-2', name: 'task' },
      ]),
      toolResult('msg-result-1', 'call-1', 'task'),
    ];
    const plan = planSettleTurnTail(active, abortInput());
    expect(plan.status).toBe('committed');
    expect(plan.deletedMessageIds).toEqual([]);
    // The round's records stay untouched; exactly one synthesized result.
    expect(plan.active.slice(0, active.length)).toEqual(active);
    expect(plan.active).toHaveLength(active.length + 1);
    const synthesized = plan.active.at(-1)!;
    expect(synthesized.turn_id).toBe('turn-1');
    expect(synthesized.message.role).toBe('toolResult');
    expect(synthesized.message['toolCallId']).toBe('call-2');
    expect(synthesized.message['toolName']).toBe('task');
    expect(synthesized.message['isError']).toBe(true);
    expect(synthesized.message['timestamp']).toBe(1_000);
    expect(synthesized.message['details']).toEqual({
      checkpointPolicy: { outcome: TOOL_OUTCOME_UNKNOWN, callId: 'call-2', toolName: 'task' },
    });
    expect(String(synthesized.message['content'][0]['text'])).toContain(TOOL_OUTCOME_UNKNOWN);
    // The settlement is a settled canonical sequence by construction.
    expect(inspectCanonicalHistorySequence(plan.active).status).toBe('settled');
  });

  it('closes a round that never started any of its accepted calls', () => {
    const active = [
      user('dig'),
      assistantWithCalls('msg-assistant-1', [
        { id: 'call-1', name: 'bash' },
        { id: 'call-2', name: 'bash' },
      ]),
    ];
    const plan = planSettleTurnTail(active, abortInput());
    expect(plan.status).toBe('committed');
    const results = plan.active.slice(active.length);
    expect(results.map(({ message }) => message['toolCallId'])).toEqual(['call-1', 'call-2']);
    expect(inspectCanonicalHistorySequence(plan.active).status).toBe('settled');
  });

  it('derives the synthesized identity from the operation and the call id (idempotent retries)', () => {
    const active = [
      user('dig'),
      assistantWithCalls('msg-assistant-1', [{ id: 'call-1', name: 'bash' }]),
    ];
    const first = planSettleTurnTail(active, abortInput());
    const retry = planSettleTurnTail(
      active,
      abortInput({ operationId: `${BASE_INPUT.operationId}`, timestampMs: 9_999 }),
    );
    expect(retry.active.at(-1)!.message_id).toBe(first.active.at(-1)!.message_id);
    expect(retry.active.at(-1)!.message_id).toMatch(/^msg-/);
  });

  it('keeps an already settled abort tail unchanged (regression)', () => {
    const active = [
      user('dig'),
      assistantWithCalls('msg-assistant-1', [{ id: 'call-1', name: 'bash' }]),
      toolResult('msg-result-1', 'call-1', 'bash'),
    ];
    const plan = planSettleTurnTail(active, abortInput());
    expect(plan.status).toBe('unchanged');
    expect(plan.active).toBe(active);
  });

  it('still folds a call-less tail: empty assistant is popped, approved text replaces (regression)', () => {
    const emptyTail = [
      user('dig'),
      envelope('msg-assistant-1', 'turn-1', { role: 'assistant', content: [], timestamp: 2 }),
    ];
    const plan = planSettleTurnTail(emptyTail, abortInput());
    expect(plan.status).toBe('committed');
    expect(plan.active).toHaveLength(1);
    expect(plan.deletedMessageIds).toEqual(['msg-assistant-1']);

    const partialTail = [
      user('dig'),
      envelope('msg-assistant-2', 'turn-1', {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        timestamp: 2,
      }),
    ];
    const folded = planSettleTurnTail(partialTail, abortInput({ approvedContent: 'approved' }));
    expect(folded.status).toBe('committed');
    expect(folded.active.at(-1)!.message['content']).toEqual([
      { type: 'text', text: 'approved' },
    ]);
  });

  it('leaves other turns\u2019 rounds untouched, and network mode never synthesizes (regression)', () => {
    const crossTurn = [
      user('earlier', 'turn-0'),
      assistantWithCalls('msg-assistant-0', [{ id: 'call-0', name: 'bash' }], 'turn-0'),
    ];
    expect(planSettleTurnTail(crossTurn, abortInput()).status).toBe('unchanged');
    // The round-closing synthesis is abort-only. The network reconcile keeps
    // its pre-existing tail fold (an empty approved content pops the trailing
    // assistant) without inventing tool results.
    const openRound = [
      user('dig'),
      assistantWithCalls('msg-assistant-1', [{ id: 'call-1', name: 'bash' }]),
    ];
    const network = planSettleTurnTail(openRound, abortInput({ mode: 'network' }));
    expect(network.status).toBe('committed');
    expect(
      network.active.some(({ message }) => message.role === 'toolResult'),
    ).toBe(false);
  });
});

describe('planCloseReleasedToolRound: the §1.8 recovery join (wave 3)', () => {
  const JOIN_INPUT = {
    turnId: 'turn-1',
    operationId: 'native-wait-recovery:session-1:turn-1:call-bg',
    timestampMs: 5_000,
  };

  it('closes the open round with the KNOWN release note and unknown outcomes for the rest', () => {
    const active = [
      user('start'),
      assistantWithCalls('msg-assist-1', [
        { id: 'call-bg', name: 'task' },
        { id: 'call-plain', name: 'bash' },
      ]),
    ];
    const plan = planCloseReleasedToolRound(active, {
      ...JOIN_INPUT,
      released: [
        {
          callId: 'call-bg',
          toolName: 'task',
          text: '<task_background task_id="task_1" execution_mode="background" reason="owner_input">...</task_background>',
        },
      ],
    });
    expect(plan.status).toBe('committed');
    expect(plan.closed).toEqual(['call-bg']);
    const appended = plan.active.slice(active.length);
    expect(appended).toHaveLength(2);
    // The released call receives the KNOWN background note — never an
    // unknown substitution, never a fabricated child answer.
    expect(appended[0]).toMatchObject({
      turn_id: 'turn-1',
      message: {
        role: 'toolResult',
        toolCallId: 'call-bg',
        isError: false,
        content: [{ type: 'text', text: expect.stringContaining('<task_background') }],
      },
    });
    // Every OTHER unclosed call of the round stays on the honest unknown
    // outcome synthesis.
    expect(appended[1]).toMatchObject({
      message: {
        role: 'toolResult',
        toolCallId: 'call-plain',
        isError: true,
        details: { checkpointPolicy: { outcome: TOOL_OUTCOME_UNKNOWN } },
      },
    });
    expect(inspectCanonicalHistorySequence(plan.active).status).toBe('settled');
  });

  it('is idempotent: the closed round reports unchanged, no second toolResult', () => {
    const active = [
      user('start'),
      assistantWithCalls('msg-assist-1', [{ id: 'call-bg', name: 'task' }]),
    ];
    const first = planCloseReleasedToolRound(active, {
      ...JOIN_INPUT,
      released: [{ callId: 'call-bg', toolName: 'task', text: 'note' }],
    });
    expect(first.status).toBe('committed');
    const second = planCloseReleasedToolRound(first.active, {
      ...JOIN_INPUT,
      released: [{ callId: 'call-bg', toolName: 'task', text: 'note' }],
    });
    expect(second.status).toBe('unchanged');
    expect(second.closed).toEqual([]);
    expect(second.active).toBe(first.active);
    // Identity is derived from the operation id and the call id, so a retried
    // join over the same round derives the same records anyway.
    const record = first.active.at(-1)!;
    const expectedId = `msg-${createHash('sha256')
      .update(`${JOIN_INPUT.operationId}:released-background:call-bg`)
      .digest('base64url')}`;
    expect(record.message_id).toBe(expectedId);
  });

  it('leaves foreign turns and fully closed rounds untouched', () => {
    const active = [
      user('older turn', 'turn-0'),
      assistantWithCalls('msg-assist-0', [{ id: 'call-old', name: 'task' }], 'turn-0'),
      toolResult('msg-result-old', 'call-old', 'task', 'older result'),
      user('newer turn', 'turn-2'),
    ];
    const plan = planCloseReleasedToolRound(active, {
      ...JOIN_INPUT,
      released: [{ callId: 'call-old', toolName: 'task', text: 'note' }],
    });
    expect(plan.status).toBe('unchanged');
    expect(plan.closed).toEqual([]);
  });
});
