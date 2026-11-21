import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiBeforeLlmCallReplaceMetadata, PiHistoryChangedHookInput } from './hooks.js';
import type { turnState } from './turn.js';

export interface turnHistory {
  replace(
    messages: AgentMessage[],
    previousMessages: AgentMessage[],
    metadata: PiBeforeLlmCallReplaceMetadata,
  ): Promise<void>;
  flushTail(): Promise<void>;
  /**
   * Explicit delivery-cursor reconciliation after the host removed messages
   * from `agent.state.messages` outside a canonical replacement (a rejected
   * response-control attempt, the overflow recovery's failed-tail surgery).
   *
   * Two cases exist and they need OPPOSITE handling:
   * - the removed tail was never delivered (the discard path skips
   *   `flushTail` for rejected `message_end`s) — the cursor already sits at
   *   the new live length and this call is a no-op snap;
   * - the removed tail WAS already delivered (the overflow recovery removes
   *   the failed assistant only after its `message_end` flushed it to
   *   `onHistory`) — the durable side owns those records now, and the cursor
   *   must snap BACK to the live length so the replacement tail (the
   *   recovery answer) is delivered as a fresh delta. A stale cursor would
   *   swallow it: `total <= lastSnapshotLength` when the removal and the
   *   replacement have the same length.
   *
   * This is deliberately NOT `min(oldCursor, newLength)`: the cursor indexes
   * delivery progress, not a message identity, and the explicit snap to the
   * live transcript is the only value that keeps subsequent deltas correct
   * after an out-of-band removal.
   */
  reconcileRemoval(): void;
}

export function newHistory(turn: turnState, agent: Agent): turnHistory {
  // Cursor into agent.state.messages. Initial history belongs to the caller
  // and must not be re-sent through onHistoryChangedHook.
  //
  // pi 48c8f322: the agent keeps the system prompt (and per-request tool
  // declarations) as transcript-resident `system` messages — they precede the
  // caller's initial messages at construction and may be re-inserted mid-run
  // by declareToolChanges. Named-section system updates are canonical and
  // replayable; tool-only declarations stay runtime-owned. The cursor starts
  // after the construction-time history, so neither baseline is duplicated.
  let lastSnapshotLength = agent.state.messages.length;
  let deliveryFailed = false;

  const notify = async (change: PiHistoryChangedHookInput): Promise<void> => {
    if (turn.hooks.onHistory.length === 0) return;
    for (const hook of turn.hooks.onHistory) {
      await hook(change);
    }
  };

  const deliver = async (change: PiHistoryChangedHookInput): Promise<boolean> => {
    if (deliveryFailed) return false;
    try {
      await notify(change);
      if (turn.hooks.onHistory.length > 0) await turn.input.contextWire?.commitResponses?.(change.messages);
      return true;
    } catch (err) {
      deliveryFailed = true;
      turn.metrics.tryRecordTerminalFailure({
        errorSource: 'history',
        errorKind: 'persistence',
      });
      try {
        const errors = flattenHistoryErrors(err);
        const loggedErrors = errors.slice(0, MAX_LOGGED_HISTORY_ERRORS);
        const loggedMessages = selectHistoryMessages(change.messages);
        const toolCalls = summarizeToolCalls(loggedMessages);
        turn.logger.error(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            reason: change.reason,
            message_count: change.messages.length,
            message_roles: loggedMessages.map(({ message }) => readMessageRole(message)),
            tool_names: loggedMessages.flatMap(({ message }) => readToolName(message)),
            history_cursor: lastSnapshotLength,
            agent_message_count: agent.state.messages.length,
            history_messages: loggedMessages.map(({ message, index }) =>
              summarizeHistoryMessage(message, index),
            ),
            sampled_tool_call_count: toolCalls.count,
            tool_calls: toolCalls.entries,
            ...(toolCalls.count > toolCalls.entries.length
              ? { truncated_tool_call_count: toolCalls.count - toolCalls.entries.length }
              : {}),
            tool_results: loggedMessages.flatMap(({ message }) => readToolResult(message)),
            ...(change.messages.length > loggedMessages.length
              ? { truncated_message_count: change.messages.length - loggedMessages.length }
              : {}),
            error_count: errors.length,
            errors: loggedErrors.map(summarizeHistoryError),
            ...(errors.length > loggedErrors.length
              ? { truncated_error_count: errors.length - loggedErrors.length }
              : {}),
            error: truncateHistoryText(describeHistoryError(err), MAX_HISTORY_ERROR_MESSAGE_LENGTH),
          },
          '[pi-turn-runner] history delivery failed',
        );
      } catch {
        // History persistence remains the root failure when diagnostics are unavailable.
      }
      throw err;
    }
  };

  return {
    async replace(messages, previousMessages, metadata): Promise<void> {
      const delivered = await deliver({
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        reason: 'replaceMessages',
        messages: [...messages],
        previousMessages,
        metadata,
      });
      // The cursor indexes agent.state.messages, which (at pi 48c8f322)
      // carries the transcript-resident system block on top of the canonical
      // replacement — so it must snap to the LIVE transcript length at
      // delivery time, not to the canonical `messages.length`. Callers update
      // the transcript before delivering the replacement.
      if (delivered) lastSnapshotLength = agent.state.messages.length;
    },
    async flushTail(): Promise<void> {
      if (deliveryFailed) return;
      const total = agent.state.messages.length;
      if (total <= lastSnapshotLength) return;
      const delta = agent.state.messages
        .slice(lastSnapshotLength, total)
        .filter((message) => message.role !== 'system' || message.sections !== undefined);
      if (delta.length === 0) {
        // A system-only tail (e.g. a tool-declaration update) is runtime
        // bookkeeping, not conversation history. Advance the cursor without
        // emitting an empty change.
        lastSnapshotLength = total;
        return;
      }
      // Incident 03 (2026-11-05) delivery gate: a non-toolResult message
      // (a cadence reminder appended by a before-LLM hook, the empty partial
      // assistant of an aborted stream) must never be delivered over an
      // unclosed trailing tool round — it would land on top of assistant
      // calls that have no results yet, which the canonical sequence
      // validator rejects ("tool results must immediately follow their
      // assistant call"). In durable mode the abort-cascade delta used to be
      // committed first and rejected after, leaving the session permanently
      // unreadable. The delta is HELD instead: the cursor stays put, so the
      // messages ride the next flush once the round closed; if the round
      // never closes (the turn died), they are dropped with it — the abort
      // reconcile owns closing the round honestly.
      if (deltaHeldByOpenToolRound(agent.state.messages, lastSnapshotLength, delta)) return;
      const delivered = await deliver({
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        reason: 'messageDelta',
        messages: [...delta],
      });
      if (delivered) lastSnapshotLength = total;
    },
    reconcileRemoval(): void {
      lastSnapshotLength = agent.state.messages.length;
    },
  };
}

function readMessageRole(message: AgentMessage): string {
  return typeof message.role === 'string' && message.role.length > 0
    ? truncateHistoryText(message.role, MAX_HISTORY_ROLE_LENGTH)
    : 'unknown';
}

/**
 * True when delivering `delta` would place a non-toolResult message over an
 * unclosed trailing tool round (incident 03 delivery gate). The pending calls
 * come from the DELIVERED transcript prefix (strict backward walk over the
 * records below `deliveredLength`, system-role bookkeeping excluded exactly
 * like delivery) — never from the undelivered tail, so a HELD delta cannot
 * mask the round it is holding for: the hold stays stable until a delta that
 * closes the round reaches the canonical side, or the turn ends and the held
 * messages drop with it. The delta is then walked forward: tool results
 * consume the pending calls, and any other message while calls are still
 * pending holds the WHOLE delta — a delta is an ordered slice, so partial
 * delivery would split it.
 */
function deltaHeldByOpenToolRound(
  transcript: readonly AgentMessage[],
  deliveredLength: number,
  delta: readonly AgentMessage[],
): boolean {
  const pending = deliveredOpenToolCallIds(transcript, deliveredLength);
  if (pending.size === 0) return false;
  for (const message of delta) {
    if (message.role === 'toolResult') {
      pending.delete(message.toolCallId);
      continue;
    }
    // A non-toolResult message with calls still pending holds the WHOLE
    // delta (a delta is an ordered slice; partial delivery would split it).
    // Once the slice itself closed the round, the rest delivers.
    if (pending.size > 0) return true;
    return false;
  }
  return false;
}

/** Tool-call ids of the delivered transcript tail that have no result yet. */
function deliveredOpenToolCallIds(
  transcript: readonly AgentMessage[],
  deliveredLength: number,
): Set<string> {
  const seenResults = new Set<string>();
  for (let index = deliveredLength; index > 0; ) {
    const message = transcript[index - 1];
    if (!message) return new Set();
    // Transcript-resident system records are runtime bookkeeping, not
    // conversation history — they never sit between a round and its results.
    if (message.role === 'system') {
      index -= 1;
      continue;
    }
    if (message.role === 'toolResult') {
      seenResults.add(message.toolCallId);
      index -= 1;
      continue;
    }
    if (message.role !== 'assistant') return new Set();
    const pending = new Set<string>();
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          block &&
          typeof block === 'object' &&
          !Array.isArray(block) &&
          Reflect.get(block, 'type') === 'toolCall'
        ) {
          const callId = Reflect.get(block, 'id');
          if (typeof callId === 'string' && callId) pending.add(callId);
        }
      }
    }
    for (const callId of pending) {
      if (seenResults.has(callId)) pending.delete(callId);
    }
    return pending;
  }
  return new Set();
}

function readToolName(message: AgentMessage): string[] {
  return message.role === 'toolResult' && message.toolName.length > 0
    ? [truncateHistoryText(message.toolName, MAX_HISTORY_IDENTIFIER_LENGTH)]
    : [];
}

function summarizeHistoryMessage(
  message: AgentMessage,
  index: number,
): Readonly<Record<string, unknown>> {
  const content = Reflect.get(message, 'content');
  return {
    index,
    role: readMessageRole(message),
    content_types: readContentTypes(content),
    ...(Array.isArray(content) ? { content_part_count: content.length } : {}),
  };
}

const MAX_LOGGED_HISTORY_MESSAGES = 24;
const LOGGED_HISTORY_HEAD_MESSAGES = 4;
const MAX_LOGGED_HISTORY_TOOL_CALLS = 24;
const MAX_SCANNED_HISTORY_CONTENT_PARTS = 64;
const MAX_LOGGED_HISTORY_CONTENT_TYPES = 8;
const MAX_HISTORY_ROLE_LENGTH = 64;
const MAX_HISTORY_IDENTIFIER_LENGTH = 256;

function selectHistoryMessages(
  messages: readonly AgentMessage[],
): readonly { readonly message: AgentMessage; readonly index: number }[] {
  if (messages.length <= MAX_LOGGED_HISTORY_MESSAGES) {
    return messages.map((message, index) => ({ message, index }));
  }
  const head = messages
    .slice(0, LOGGED_HISTORY_HEAD_MESSAGES)
    .map((message, index) => ({ message, index }));
  const tailStart = messages.length - (MAX_LOGGED_HISTORY_MESSAGES - LOGGED_HISTORY_HEAD_MESSAGES);
  const tail = messages.slice(tailStart).map((message, offset) => ({
    message,
    index: tailStart + offset,
  }));
  return [...head, ...tail];
}

function readContentTypes(content: unknown): readonly string[] {
  if (typeof content === 'string') return ['text'];
  if (!Array.isArray(content)) return [];
  return [
    ...new Set(
      content.slice(0, MAX_SCANNED_HISTORY_CONTENT_PARTS).map((part) => {
        if (typeof part === 'string') return 'text';
        if (part && typeof part === 'object') {
          const type = Reflect.get(part, 'type');
          if (typeof type === 'string' && type.length > 0) {
            return truncateHistoryText(type, MAX_HISTORY_ROLE_LENGTH);
          }
        }
        return typeof part;
      }),
    ),
  ].slice(0, MAX_LOGGED_HISTORY_CONTENT_TYPES);
}

function summarizeToolCalls(messages: readonly { readonly message: AgentMessage }[]): {
  readonly count: number;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
} {
  const summary: {
    count: number;
    entries: Readonly<Record<string, unknown>>[];
  } = { count: 0, entries: [] };
  messages.forEach(({ message }) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    message.content.forEach((part) => {
      if (part.type !== 'toolCall') return;
      summary.count += 1;
      if (summary.entries.length >= MAX_LOGGED_HISTORY_TOOL_CALLS) return;
      summary.entries.push({
        tool_name: truncateHistoryText(part.name, MAX_HISTORY_IDENTIFIER_LENGTH),
        tool_call_id: truncateHistoryText(part.id, MAX_HISTORY_IDENTIFIER_LENGTH),
      });
    });
  });
  return summary;
}

function readToolResult(message: AgentMessage): readonly Readonly<Record<string, unknown>>[] {
  if (message.role !== 'toolResult') return [];
  return [
    {
      tool_name: truncateHistoryText(message.toolName, MAX_HISTORY_IDENTIFIER_LENGTH),
      tool_call_id: truncateHistoryText(message.toolCallId, MAX_HISTORY_IDENTIFIER_LENGTH),
      is_error: message.isError === true,
    },
  ];
}

const MAX_LOGGED_HISTORY_ERRORS = 4;
const MAX_HISTORY_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_HISTORY_ERROR_STACK_LENGTH = 4_096;

function flattenHistoryErrors(error: unknown): readonly unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return error.errors.flatMap(flattenHistoryErrors);
}

function summarizeHistoryError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: truncateHistoryText(
        error.message || 'Unknown error',
        MAX_HISTORY_ERROR_MESSAGE_LENGTH,
      ),
      ...(error.stack
        ? { stack: truncateHistoryText(error.stack, MAX_HISTORY_ERROR_STACK_LENGTH) }
        : {}),
    };
  }
  return {
    name: typeof error,
    message: truncateHistoryText(describeHistoryError(error), MAX_HISTORY_ERROR_MESSAGE_LENGTH),
  };
}

function truncateHistoryText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function describeHistoryError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown history delivery error';
  }
}
