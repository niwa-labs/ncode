/**
 * A4 (final-sprint `01-verdict-astra.md` §3) — the rejected attempt must not
 * stay on screen as a successful preamble.
 *
 * The full deterministic chain, no mocks between the layers that matter:
 * REAL pi-shaped events → REAL `EventBridge` (RuntimeEvents) → the SAME
 * SSE mapping the session stream produces (`runtime-event` frames carry the
 * raw RuntimeEvent JSON) → REAL `projectTuiSessionStreamFrame` normalizer →
 * REAL `TuiTurnProjection` + `TranscriptStore`.
 *
 * Scenarios (the astra list):
 * - `delta(A) → discard(A) → delta(B) → final(B)`: A's transient cell is
 *   retracted BY IDENTITY (the `assistant_message_discarded` trace's
 *   `message_id`); B renders alone.
 * - a late delta for A after the discard cannot resurrect A.
 * - the natural `preamble(A) → answer(B)` keeps A (a messageId change alone
 *   is never a discard).
 * - two legitimate identical answers with different ids both stay.
 * - `final` over accumulated deltas replaces the streamed text once.
 * - abort between delta and discard: the streamed cell settles as cancelled,
 *   never as a successful preamble.
 */

import { describe, expect, it } from 'vitest';

import {
  EventBridge,
  type BridgedEvents,
} from '@mavis/agent-core/event-bridge';
import {
  RuntimeEventType,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol/runtime-event';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import { projectTuiSessionStreamFrame } from '../../src/runtime/stream-events.js';
import type { TuiStreamEvent } from '../../src/runtime/stream-events.js';
import { TuiTurnProjection } from '../../src/tui/controller/projection/turn-projection.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';

const TURN_ID = 'turn-a4';

function baseAssistant(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'openai',
    model: 'mock',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1_000,
  } as AssistantMessage;
}

interface BridgeHarness {
  readonly bridge: EventBridge;
  /** Feed one pi event; allocates the requested assistant message id from `ids`. */
  feed(event: AgentEvent, id?: string): Promise<TuiStreamEvent[]>;
  /** The bridge's discard call, as the turn runner performs it. */
  discard(reason?: string): Promise<TuiStreamEvent[]>;
}

/**
 * The SSE `dataJson` a production `runtime-event` frame carries, composed
 * exactly like the real delivery path:
 * `local-runtime-v2` agent-projection (`streamProjectionData`) unwraps a
 * `stream_resp` RuntimeEvent to its RespData JSON string (re-stamping the
 * inner message's `turn_id` with the delivering turn's id — a no-op here,
 * the bridge already stamps `ctx.turnId`), and
 * `session-stream-delivery.mapStandardV2Frame` passes every other
 * `runtime-event` through as the raw RuntimeEvent JSON.
 */
function sseFrameDataJson(event: RuntimeEvent): string {
  if (event.type === RuntimeEventType.STREAM_RESP) {
    const raw = event.payload.stream_resp;
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return JSON.stringify(event);
}

/**
 * Real bridge + the runtime-event frame mapping (`sseFrameDataJson`, the
 * production composition) + the real TUI normalizer.
 */
function bridgeHarness(ids: readonly string[]): BridgeHarness {
  const bridge = new EventBridge({
    sessionId: 'session-a4',
    turnId: TURN_ID,
    eventIdGenerator: (kind: string) => `evt_${kind}_${Math.random().toString(36).slice(2)}`,
    runtimeSeqGenerator: () => Math.floor(Math.random() * 1_000_000),
    nowMs: () => 1_234,
  });
  let idIndex = 0;
  const toTui = async (bridged: BridgedEvents): Promise<TuiStreamEvent[]> => {
    if (bridged.requestAssistantMessageId) {
      const id = ids[idIndex++];
      bridge.setActiveAssistantMessageId(id ?? '');
    }
    const projected: TuiStreamEvent[] = [];
    for (const event of bridged.events as RuntimeEvent[]) {
      const tui = projectTuiSessionStreamFrame(
        { dataJson: sseFrameDataJson(event) },
        TURN_ID,
      );
      if (tui) projected.push(tui);
    }
    return projected;
  };
  return {
    bridge,
    feed: async (event, _id) => toTui(await bridge.processEvent(event, 1_234)),
    discard: async (reason) => toTui(bridge.discardActiveAssistantMessage(reason)),
  };
}

function textDelta(messageId: string, delta: string): TuiStreamEvent {
  return {
    type: 'delta',
    messageId,
    turnId: TURN_ID,
    role: 'assistant',
    content: delta,
    timestamp: 1_234,
  };
}

/** A completed agent_message wire frame, normalized through the real projector. */
function completedMessage(messageId: string, text: string): TuiStreamEvent {
  const frame = {
    dataJson: JSON.stringify({
      type: 2,
      agent_message: {
        msg_id: messageId,
        turn_id: TURN_ID,
        role: 'assistant',
        msg_content: text,
        finish_reason: 'stop',
        timestamp: 1_234,
      },
    }),
  };
  const event = projectTuiSessionStreamFrame(frame, TURN_ID);
  expect(event).toBeDefined();
  return event!;
}

/** Drives the real bridge through one streamed assistant attempt. */
async function streamAttempt(
  harness: BridgeHarness,
  messageId: string,
  deltas: readonly string[],
): Promise<TuiStreamEvent[]> {
  const events: TuiStreamEvent[] = [];
  const start = await harness.feed({
    type: 'message_start',
    message: baseAssistant(),
  });
  events.push(...start);
  let accumulated = '';
  for (const delta of deltas) {
    accumulated += delta;
    const partial = { ...baseAssistant(), content: [{ type: 'text', text: accumulated }] };
    const batch = await harness.feed({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial },
      message: partial,
    });
    events.push(...batch);
  }
  expect(harness.bridge.getActiveAssistantMessageId()).toBe(messageId);
  return events;
}

function makeProjection(): { projection: TuiTurnProjection; transcript: TranscriptStore } {
  const transcript = new TranscriptStore();
  const proj = new TuiTurnProjection({
    transcript,
    now: () => 1_234,
    onChange: () => undefined,
  });
  proj.beginTurn(TURN_ID, 1_000);
  return { projection: proj, transcript };
}

function applyAll(projection: TuiTurnProjection, events: readonly TuiStreamEvent[]): void {
  for (const event of events) projection.applyStreamEvent(TURN_ID, event);
}

function cells(transcript: TranscriptStore) {
  return transcript.snapshot().map((cell) => ({
    id: cell.id,
    kind: cell.kind,
    status: cell.status,
    content: cell.content,
  }));
}

describe('A4 discard projection: rejected attempt is not a successful preamble', () => {
  it('delta(A) → discard(A) → delta(B) → final(B): only B survives, retracted by identity', async () => {
    const harness = bridgeHarness(['msg-a', 'msg-b']);
    const { projection, transcript } = makeProjection();

    applyAll(projection, await streamAttempt(harness, 'msg-a', ['bad ', 'attempt']));
    expect(cells(transcript)).toEqual([
      { id: `assistant:${TURN_ID}`, kind: 'assistant', status: 'running', content: 'bad attempt' },
    ]);

    // The runner discards A before B streams; the trace carries A's identity.
    const discardEvents = await harness.discard('retry: response control');
    expect(discardEvents).toHaveLength(1);
    expect(discardEvents[0]).toMatchObject({
      type: 'assistant-discarded',
      messageId: 'msg-a',
      turnId: TURN_ID,
    });
    applyAll(projection, discardEvents);
    // A's transient cell is gone — not converted into a successful preamble.
    expect(cells(transcript)).toEqual([]);

    applyAll(projection, await streamAttempt(harness, 'msg-b', ['good ', 'answer']));
    applyAll(projection, [completedMessage('msg-b', 'good answer')]);
    projection.markTurn(TURN_ID, 'succeeded');

    expect(cells(transcript)).toEqual([
      {
        id: `assistant:${TURN_ID}`,
        kind: 'assistant',
        status: 'succeeded',
        content: 'good answer',
      },
    ]);
  });

  it('a late delta for A after the discard cannot resurrect the rejected attempt', async () => {
    const harness = bridgeHarness(['msg-a', 'msg-b']);
    const { projection, transcript } = makeProjection();

    applyAll(projection, await streamAttempt(harness, 'msg-a', ['bad attempt']));
    applyAll(projection, await harness.discard('retry: response control'));
    applyAll(projection, await streamAttempt(harness, 'msg-b', ['good answer']));
    applyAll(projection, [completedMessage('msg-b', 'good answer')]);

    // A late out-of-order frame for the discarded identity arrives (the
    // bridge itself drops anchor-less deltas; the projection must too).
    applyAll(projection, [textDelta('msg-a', ' resurrection')]);

    const assistantCells = cells(transcript).filter(
      (cell) => cell.kind === 'assistant' || cell.kind === 'assistant-preamble',
    );
    expect(assistantCells).toEqual([
      { id: `assistant:${TURN_ID}`, kind: 'assistant', status: 'succeeded', content: 'good answer' },
    ]);
  });

  it('natural preamble(A) → answer(B): the messageId change alone is NOT a discard — A stays', async () => {
    const harness = bridgeHarness(['msg-a', 'msg-b']);
    const { projection, transcript } = makeProjection();

    // A completes (no tool calls): the completed message and finish ride out.
    applyAll(projection, await streamAttempt(harness, 'msg-a', ['preamble text']));
    const endA = await harness.feed({
      type: 'message_end',
      message: { ...baseAssistant(), content: [{ type: 'text', text: 'preamble text' }] },
    });
    applyAll(projection, endA);

    applyAll(projection, await streamAttempt(harness, 'msg-b', ['final text']));
    applyAll(projection, [completedMessage('msg-b', 'final text')]);
    projection.markTurn(TURN_ID, 'succeeded');

    const assistantCells = cells(transcript).filter(
      (cell) => cell.kind === 'assistant' || cell.kind === 'assistant-preamble',
    );
    expect(assistantCells).toEqual([
      {
        id: `assistant:${TURN_ID}`,
        kind: 'assistant-preamble',
        status: 'succeeded',
        content: 'preamble text',
      },
      {
        id: `assistant:${TURN_ID}:2`,
        kind: 'assistant',
        status: 'succeeded',
        content: 'final text',
      },
    ]);
  });

  it('two legitimate identical answers with different ids both stay', async () => {
    const harness = bridgeHarness(['msg-a', 'msg-b']);
    const { projection, transcript } = makeProjection();

    const text = 'the same honest answer';
    applyAll(projection, await streamAttempt(harness, 'msg-a', [text]));
    applyAll(projection, [completedMessage('msg-a', text)]);
    applyAll(projection, await streamAttempt(harness, 'msg-b', [text]));
    applyAll(projection, [completedMessage('msg-b', text)]);
    projection.markTurn(TURN_ID, 'succeeded');

    const assistantCells = cells(transcript).filter(
      (cell) => cell.kind === 'assistant' || cell.kind === 'assistant-preamble',
    );
    // De-duplication by text would have eaten one of them.
    expect(assistantCells).toHaveLength(2);
    expect(assistantCells.every((cell) => cell.content === text)).toBe(true);
  });

  it('final over accumulated deltas: the completed message replaces the streamed text once', async () => {
    const harness = bridgeHarness(['msg-a']);
    const { projection, transcript } = makeProjection();

    applyAll(projection, await streamAttempt(harness, 'msg-a', ['Hel', 'lo']));
    applyAll(projection, [completedMessage('msg-a', 'Hello')]);
    projection.markTurn(TURN_ID, 'succeeded');

    expect(cells(transcript)).toEqual([
      {
        id: `assistant:${TURN_ID}`,
        kind: 'assistant',
        status: 'succeeded',
        content: 'Hello',
      },
    ]);
  });

  it('abort between delta and discard: the streamed cell settles cancelled, never a successful preamble', async () => {
    const harness = bridgeHarness(['msg-a']);
    const { projection, transcript } = makeProjection();

    applyAll(projection, await streamAttempt(harness, 'msg-a', ['partial answer']));
    // The user aborts; the bridge suppresses message_end for aborted runs and
    // the turn settles cancelled.
    const aborted = { ...baseAssistant(), stopReason: 'aborted' as const };
    applyAll(projection, await harness.feed({ type: 'message_end', message: aborted }));
    projection.markTurn(TURN_ID, 'cancelled');

    const assistantCells = cells(transcript).filter(
      (cell) => cell.kind === 'assistant' || cell.kind === 'assistant-preamble',
    );
    expect(assistantCells).toEqual([
      {
        id: `assistant:${TURN_ID}`,
        kind: 'assistant',
        status: 'cancelled',
        content: 'partial answer',
      },
    ]);
  });
});
