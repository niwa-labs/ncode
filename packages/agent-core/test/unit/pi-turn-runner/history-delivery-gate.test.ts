import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '@earendil-works/pi-agent-core';

import { newHistory } from '../../../src/pi-turn-runner/history.js';
import type { turnState } from '../../../src/pi-turn-runner/turn.js';

/**
 * Incident 03 (2026-11-05) history delivery gate: a non-toolResult delta
 * (the todo cadence reminder appended by a before-LLM hook, the empty partial
 * assistant of an aborted stream) must never be delivered over an unclosed
 * trailing tool round. The durable provider used to commit the delta first
 * and fail the strict sequence walk after — the session became permanently
 * unreadable. The delta is HELD instead: the delivery cursor stays put, the
 * messages ride a later flush once the round closed, and a delta that closes
 * the round delivers normally.
 */

function user(text: string, timestamp: number) {
  return { role: 'user' as const, content: text, timestamp };
}

function assistantWithCalls(
  calls: readonly { readonly id: string; readonly name: string }[],
  timestamp: number,
) {
  return {
    role: 'assistant' as const,
    content: calls.map((call) => ({
      type: 'toolCall' as const,
      id: call.id,
      name: call.name,
      arguments: {},
    })),
    timestamp,
  };
}

function toolResult(callId: string, toolName: string, timestamp: number) {
  return {
    role: 'toolResult' as const,
    toolCallId: callId,
    toolName,
    content: [{ type: 'text' as const, text: 'result' }],
    isError: false,
    timestamp,
  };
}

function reminder(timestamp: number) {
  return {
    role: 'custom' as const,
    customType: 'todo_cadence_reminder',
    content: '<system-reminder>todo cadence</system-reminder>',
    display: false as const,
    timestamp,
  };
}

/** Minimal turn/agent stubs: `newHistory` only touches the cursor seam inputs. */
function stubHistory(initial: { role: string; [key: string]: unknown }[]) {
  const delivered: unknown[][] = [];
  const turn = {
    input: { sessionId: 'session-1', turnId: 'turn-1' },
    hooks: {
      onHistory: [
        vi.fn(async (change: { messages: unknown[] }) => {
          delivered.push(change.messages);
        }),
      ],
    },
    metrics: { tryRecordTerminalFailure: vi.fn() },
    logger: { error: vi.fn() },
  } as unknown as turnState;
  // The delivery cursor starts at the construction-time transcript length
  // (the initial history belongs to the caller); the tests append live
  // records onto this exact array afterwards.
  const messages = initial;
  const agent = { state: { messages } } as unknown as Agent;
  return { history: newHistory(turn, agent), delivered, messages };
}

describe('history delivery gate: deltas over an unclosed tool round (incident 03)', () => {
  it('holds a reminder over an open round; the hold is stable, the round records deliver normally', async () => {
    const { history, delivered, messages } = stubHistory([user('dig', 1)]);
    // The round's records deliver normally (a legal pending tail).
    messages.push(
      assistantWithCalls(
        [
          { id: 'call-1', name: 'task' },
          { id: 'call-2', name: 'task' },
        ],
        2,
      ),
      toolResult('call-1', 'task', 3),
    );
    await history.flushTail();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toHaveLength(2);

    // The abort cascade appends the reminder over the still-open round.
    messages.push(reminder(4));
    await history.flushTail();
    expect(delivered).toHaveLength(1);
    // The hold is stable: repeated flushes keep holding.
    await history.flushTail();
    expect(delivered).toHaveLength(1);

    // The second call's result closes the round — but the reminder sits
    // BEFORE it in the transcript, so the slice stays held (the reminder can
    // never precede the closing result canonically). The turn is aborting;
    // the held messages drop with it instead of poisoning the durable log.
    messages.push(toolResult('call-2', 'task', 5));
    await history.flushTail();
    expect(delivered).toHaveLength(1);
  });

  it('delivers a delta that closes the round before any non-toolResult message', async () => {
    const { history, delivered, messages } = stubHistory([user('dig', 1)]);
    messages.push(assistantWithCalls([{ id: 'call-1', name: 'bash' }], 2));
    await history.flushTail();
    expect(delivered).toHaveLength(1);

    // The result arrives first, then the reminder: both deliver (the round
    // closed inside the same delta slice).
    messages.push(toolResult('call-1', 'bash', 3), reminder(4));
    await history.flushTail();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toHaveLength(2);
  });

  it('holds the empty partial assistant of an aborted stream over an open round', async () => {
    const { history, delivered, messages } = stubHistory([user('dig', 1)]);
    messages.push(
      assistantWithCalls(
        [
          { id: 'call-1', name: 'bash' },
          { id: 'call-2', name: 'bash' },
        ],
        2,
      ),
      toolResult('call-1', 'bash', 3),
    );
    await history.flushTail();
    expect(delivered).toHaveLength(1);
    // The child session's poison: the empty partial assistant of the aborted
    // stream must never reach the canonical history.
    messages.push({ role: 'assistant', content: [], timestamp: 4 });
    await history.flushTail();
    expect(delivered).toHaveLength(1);
    await history.flushTail();
    expect(delivered).toHaveLength(1);
  });

  it('never engages on a settled transcript (regression: the ordinary flow is untouched)', async () => {
    const { history, delivered, messages } = stubHistory([user('hi', 1)]);
    messages.push({ role: 'assistant', content: 'hey', timestamp: 2 });
    await history.flushTail();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toHaveLength(1);
  });
});
