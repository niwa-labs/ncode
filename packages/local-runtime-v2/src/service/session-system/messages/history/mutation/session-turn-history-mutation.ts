import { createHash } from 'node:crypto';

import { TOOL_OUTCOME_UNKNOWN } from '@mavis/storage-worker';

import {
  canonicalActiveHistoryRevision,
  inspectCanonicalHistorySequence,
  type CanonicalHistoryEnvelope,
} from '../../../sessions/representation/canonical-history-contract.js';

export interface SessionHistorySnapshot {
  readonly generation: number;
  readonly fileName: string;
  readonly revision: string;
  readonly records: readonly CanonicalHistoryEnvelope[];
}

export interface SettleTurnTailInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly operationId: string;
  readonly mode: 'abort' | 'network' | 'safety';
  readonly approvedContent: string;
  /**
   * Commit timestamp of synthesized abort records (incident 03: the
   * unknown-outcome tool results of an unclosed round). The canonical decoder
   * requires a finite timestamp on every runtime message; callers that have a
   * clock pass it here so the planner stays deterministic under test.
   */
  readonly timestampMs?: number;
}

export type RetractTurnReason =
  | { readonly kind: 'input-safety-recall' }
  | { readonly kind: 'output-attempt-recall'; readonly attempt: number }
  | { readonly kind: 'output-final-recall' }
  | { readonly kind: 'fatal' };

export interface RetractTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly operationId: string;
  readonly reason: RetractTurnReason;
}

export interface SessionTurnHistoryMutationCommit {
  readonly status: 'committed' | 'unchanged' | 'already-retracted';
  readonly revision: string;
  readonly generation: number;
  readonly messages: readonly unknown[];
  readonly identityVector: readonly string[];
  readonly deletedMessageIds: readonly string[];
}

interface SettleTurnTailPlan {
  readonly status: 'committed' | 'unchanged';
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly deletedMessageIds: readonly string[];
}

interface RetractTurnPlan {
  readonly status: 'committed' | 'already-retracted';
  readonly generation: number;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly snapshots: readonly SessionHistorySnapshot[];
  readonly deletedMessageIds: readonly string[];
}

interface RetractTurnHistory {
  readonly activeGeneration: number;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly snapshots: readonly SessionHistorySnapshot[];
}

/** Plans the existing abort/network tail fold against the latest envelopes. */
export function planSettleTurnTail(
  active: readonly CanonicalHistoryEnvelope[],
  input: SettleTurnTailInput,
): SettleTurnTailPlan {
  assertMutationIdentity(input);
  // Incident 03 (2026-11-05) abort fix: an abort reconcile now CLOSES the
  // turn's unclosed trailing tool round instead of abandoning it. The old
  // cop-out (`unchanged` whenever the tail assistant carried tool calls, and
  // nothing at all when the round's results already followed it) left the
  // accepted-but-never-started calls hanging: the next non-toolResult delta
  // over the open round failed the strict sequence walk, and — before the
  // durable append went fail-closed — poisoned the log permanently. The
  // synthesized results cover ALL accepted calls of the round, not only the
  // ones whose effects started (only the started ones ever got a result from
  // the checkpoint barrier): a call the dying turn accepted but never ran is
  // exactly as unconfirmable as an interrupted in-flight one.
  // 'safety' (upstream 0.7.2's content-safety rewind) settles the tail exactly
  // like an abort in our tree: the incident-03 close of the trailing tool round
  // is the honest outcome; their PTC-specific reconcile stays deferred.
  if (input.mode === 'abort' || input.mode === 'safety') {
    const round = openToolRoundTail(active, input.turnId);
    if (round) return closeAbortedToolRound(active, input, round);
  }
  const last = active.at(-1);
  if (!last || last.turn_id !== input.turnId || last.message.role !== 'assistant') {
    return unchangedSettle(active);
  }
  if (input.mode === 'abort' && containsToolCall(last.message.content)) {
    return unchangedSettle(active);
  }
  const next = [...active];
  const approvedContent = input.approvedContent;
  const deletedMessageIds: string[] = [];
  if (!approvedContent.trim()) {
    next.pop();
    deletedMessageIds.push(last.message_id);
  } else {
    next[next.length - 1] = {
      ...last,
      message: {
        ...last.message,
        content: [{ type: 'text', text: approvedContent }],
      },
    };
  }
  if (sameJson(active, next)) return unchangedSettle(active);
  assertSettled(next, 'Turn tail settlement');
  return { status: 'committed', active: next, deletedMessageIds };
}

/**
 * The trailing tool round that is still missing results (incident 03). The
 * walk mirrors the provider's `hasPendingToolTail`: results from the end
 * backwards, then the assistant that owns them. Used by the abort reconcile
 * (this module) and by the durable provider's append-time repair of a stale
 * open round — one walk, one form, one honest synthesis.
 */
export interface OpenToolRoundTail {
  /** turn_id of the assistant that owns the round. */
  readonly turnId: string;
  readonly unclosed: readonly { readonly callId: string; readonly toolName: string }[];
}

export function openToolRoundTail(
  active: readonly CanonicalHistoryEnvelope[],
  ownerTurnId?: string,
): OpenToolRoundTail | undefined {
  const seenResults = new Set<string>();
  let index = active.length;
  while (index > 0) {
    const envelope = active[index - 1];
    if (!envelope) return undefined;
    const message = envelope.message;
    if (message.role === 'toolResult') {
      const toolCallId = message['toolCallId'];
      if (typeof toolCallId === 'string') seenResults.add(toolCallId);
      index -= 1;
      continue;
    }
    if (message.role === 'assistant' && (ownerTurnId === undefined || envelope.turn_id === ownerTurnId)) {
      const calls = acceptedToolCalls(message['content']);
      if (calls.length === 0) return undefined;
      const unclosed = calls.filter((call) => !seenResults.has(call.callId));
      return unclosed.length > 0 ? { turnId: envelope.turn_id, unclosed } : undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Closes the aborted round: the accepted assistant and the results already
 * committed for it stay untouched (the started effects keep their honest
 * outcomes), and every still-unclosed call receives its unknown-outcome error
 * result in the `unknownOutcomeToolResult` form of the checkpoint policy
 * (turn-checkpoint-policy.ts) — an honest tool error, never a fabricated
 * success. The approved-content fold does not apply here: rewriting the
 * round's assistant would drop its accepted tool-call blocks.
 */
function closeAbortedToolRound(
  active: readonly CanonicalHistoryEnvelope[],
  input: SettleTurnTailInput,
  round: OpenToolRoundTail,
): SettleTurnTailPlan {
  const next = [
    ...active,
    ...synthesizedUnknownOutcomeEnvelopes({
      seed: input.operationId,
      turnId: round.turnId,
      calls: round.unclosed,
      ...(input.timestampMs === undefined ? {} : { timestampMs: input.timestampMs }),
    }),
  ];
  assertSettled(next, 'Turn tail settlement');
  return { status: 'committed', active: next, deletedMessageIds: [] };
}

/**
 * The unknown-outcome records of accepted calls without results — the
 * `unknownOutcomeToolResult` form of the checkpoint policy. The identity of
 * each record is derived from the seed and the call id (never the timestamp),
 * so a retried reconcile or repair derives the SAME records instead of
 * forking the round. The single builder serves the abort reconcile
 * (`planSettleTurnTail`, abort mode) and the durable provider's append-time
 * repair of a stale open round (incident 03).
 */
export function synthesizedUnknownOutcomeEnvelopes(input: {
  /** Identity seed: stable per closing operation (reconcile operation id / repair context). */
  readonly seed: string;
  /** turn_id stamped on the synthesized records (the round's assistant). */
  readonly turnId: string;
  readonly calls: readonly { readonly callId: string; readonly toolName: string }[];
  /** Commit timestamp; the canonical decoder requires a finite number. */
  readonly timestampMs?: number;
}): readonly CanonicalHistoryEnvelope[] {
  return input.calls.map((call) => synthesizedUnknownOutcomeEnvelope(input, call));
}

function synthesizedUnknownOutcomeEnvelope(
  input: {
    readonly seed: string;
    readonly turnId: string;
    readonly timestampMs?: number;
  },
  call: { readonly callId: string; readonly toolName: string },
): CanonicalHistoryEnvelope {
  const text =
    `Tool call ${call.callId} (${call.toolName}) was interrupted before its outcome could be confirmed ` +
    `(${TOOL_OUTCOME_UNKNOWN}). Auto-retry is forbidden by the checkpoint policy: ` +
    'the previous attempt may have taken effect, so re-running this call requires an ' +
    'explicit recovery decision (allowAfterUnknownOutcome).';
  return {
    message_id: `msg-${createHash('sha256')
      .update(`${input.seed}:tool-outcome-unknown:${call.callId}`)
      .digest('base64url')}`,
    turn_id: input.turnId,
    message: {
      role: 'toolResult',
      toolCallId: call.callId,
      toolName: call.toolName,
      content: [{ type: 'text', text }],
      isError: true,
      timestamp: input.timestampMs ?? 0,
      details: {
        checkpointPolicy: { outcome: TOOL_OUTCOME_UNKNOWN, callId: call.callId, toolName: call.toolName },
      },
    },
  };
}

/** Input of {@link planCloseReleasedToolRound} (§1.8 recovery join, wave 3). */
export interface CloseReleasedToolRoundInput {
  /** Session whose canonical history holds the open round. */
  readonly sessionId: string;
  /** turn_id of the assistant that owns the open round. */
  readonly turnId: string;
  /** Identity seed: stable per join operation (recovery operation id). */
  readonly operationId: string;
  /** Known release results keyed by call id (the §2.2 note text). */
  readonly released: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly text: string;
  }[];
  /** Commit timestamp of the synthesized records. */
  readonly timestampMs?: number;
}

/**
 * The recovery join of a released native task wait (reactive subagents §1.8,
 * wave 3): closes the parent turn's trailing open tool round with the KNOWN
 * seam outcome. Calls whose durable result is a background release receive
 * the same §2.2 note the live executor would have committed — never a second
 * toolResult for a call that already has one, and never a fabricated child
 * answer; every other still-unclosed call of the round stays on the honest
 * unknown-outcome synthesis of the abort reconcile. Identity is derived from
 * the seed and the call id, so a retried join derives the SAME records; after
 * the first commit the round is closed and the planner reports `unchanged`.
 */
export function planCloseReleasedToolRound(
  active: readonly CanonicalHistoryEnvelope[],
  input: Pick<CloseReleasedToolRoundInput, 'turnId' | 'operationId' | 'released' | 'timestampMs'>,
): { status: 'committed' | 'unchanged'; active: readonly CanonicalHistoryEnvelope[]; closed: readonly string[] } {
  const round = openToolRoundTail(active, input.turnId);
  if (!round) return { status: 'unchanged', active, closed: [] };
  const knownByCallId = new Map(input.released.map((entry) => [entry.callId, entry]));
  const envelopes: CanonicalHistoryEnvelope[] = [];
  const closed: string[] = [];
  for (const call of round.unclosed) {
    const known = knownByCallId.get(call.callId);
    if (known) {
      envelopes.push(releasedBackgroundResultEnvelope(input, call, known.text));
      closed.push(call.callId);
    } else {
      envelopes.push(synthesizedUnknownOutcomeEnvelope({ ...input, seed: input.operationId }, call));
    }
  }
  const next = [...active, ...envelopes];
  assertSettled(next, 'Released tool round join');
  return { status: 'committed', active: next, closed };
}

function releasedBackgroundResultEnvelope(
  input: {
    readonly operationId: string;
    readonly turnId: string;
    readonly timestampMs?: number;
  },
  call: { readonly callId: string; readonly toolName: string },
  text: string,
): CanonicalHistoryEnvelope {
  return {
    message_id: `msg-${createHash('sha256')
      .update(`${input.operationId}:released-background:${call.callId}`)
      .digest('base64url')}`,
    turn_id: input.turnId,
    message: {
      role: 'toolResult',
      toolCallId: call.callId,
      toolName: call.toolName,
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: input.timestampMs ?? 0,
    },
  };
}

function acceptedToolCalls(
  content: unknown,
): readonly { readonly callId: string; readonly toolName: string }[] {
  if (!Array.isArray(content)) return [];
  const calls: { readonly callId: string; readonly toolName: string }[] = [];
  for (const block of content) {
    if (
      !block ||
      typeof block !== 'object' ||
      Array.isArray(block) ||
      Reflect.get(block, 'type') !== 'toolCall'
    ) {
      continue;
    }
    const callId = Reflect.get(block, 'id');
    const toolName = Reflect.get(block, 'name');
    if (typeof callId === 'string' && callId && typeof toolName === 'string' && toolName) {
      calls.push({ callId, toolName });
    }
  }
  return calls;
}

/** Plans a target-Turn suffix removal across the reachable compaction lineage. */
export function planRetractTurn(
  history: RetractTurnHistory,
  input: RetractTurnInput,
): RetractTurnPlan {
  validateRetractTurnInput(input);
  const artifacts = [
    ...history.snapshots.map((snapshot) => ({
      generation: snapshot.generation,
      records: snapshot.records,
      snapshot,
    })),
    { generation: history.activeGeneration, records: history.active },
  ];
  const artifactIndex = artifacts.findIndex(({ records }) =>
    records.some(({ turn_id }) => turn_id === input.turnId),
  );
  if (artifactIndex < 0) {
    if (containsCompactionMarker(artifacts, input.turnId)) {
      throw new Error('Retracted Turn source boundary is missing from canonical history');
    }
    return {
      status: 'already-retracted',
      generation: history.activeGeneration,
      active: history.active,
      snapshots: history.snapshots,
      deletedMessageIds: [],
    };
  }
  assertTargetIsCurrentTail(history.active, input.turnId);
  const target = artifacts[artifactIndex];
  if (!target) throw new Error('Retracted Turn source boundary is missing from canonical history');
  const firstTargetIndex = target.records.findIndex(({ turn_id }) => turn_id === input.turnId);
  const targetSuffix = target.records.slice(firstTargetIndex);
  if (targetSuffix.some(({ turn_id }) => turn_id !== input.turnId)) {
    throw new Error('Retracted Turn is not the canonical history tail');
  }
  const active = target.records.slice(0, firstTargetIndex);
  assertSettled(active, 'Turn retraction prefix');
  if (target.generation > 0 && active.length === 0) {
    throw new Error('Turn retraction cannot preserve a non-zero generation without its marker');
  }
  return {
    status: 'committed',
    generation: target.generation,
    active,
    snapshots: history.snapshots.slice(0, Math.min(artifactIndex, history.snapshots.length)),
    deletedMessageIds: deletedTurnMessageIds(
      artifacts.slice(artifactIndex).flatMap(({ records }) => records),
      input.turnId,
    ),
  };
}

export function validateRetractTurnInput(input: RetractTurnInput): void {
  assertMutationIdentity(input);
  assertRetractReason(input.reason);
}

export function toTurnHistoryMutationCommit(input: {
  readonly status: SessionTurnHistoryMutationCommit['status'];
  readonly generation: number;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly deletedMessageIds: readonly string[];
}): SessionTurnHistoryMutationCommit {
  return {
    status: input.status,
    revision: canonicalActiveHistoryRevision(input.active),
    generation: input.generation,
    messages: input.active.map(({ message }) => structuredClone(message)),
    identityVector: input.active.map(({ message_id }) => message_id),
    deletedMessageIds: [...input.deletedMessageIds],
  };
}

function assertMutationIdentity(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly operationId: string;
}): void {
  if (!input.sessionId.trim() || !input.turnId.trim() || !input.operationId.trim()) {
    throw new TypeError('Turn history mutation identity is required');
  }
}

function assertRetractReason(reason: RetractTurnReason): void {
  if (
    reason.kind === 'output-attempt-recall' &&
    (!Number.isSafeInteger(reason.attempt) || reason.attempt < 1)
  ) {
    throw new TypeError('Output recall attempt must be a positive safe integer');
  }
}

function unchangedSettle(active: readonly CanonicalHistoryEnvelope[]): SettleTurnTailPlan {
  return { status: 'unchanged', active, deletedMessageIds: [] };
}

function containsToolCall(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        !Array.isArray(block) &&
        Reflect.get(block, 'type') === 'toolCall',
    )
  );
}

function containsCompactionMarker(
  artifacts: readonly { readonly records: readonly CanonicalHistoryEnvelope[] }[],
  turnId: string,
): boolean {
  const markerTurnId = `${turnId}:compaction`;
  return artifacts.some(({ records }) => records.some(({ turn_id }) => turn_id === markerTurnId));
}

function assertTargetIsCurrentTail(
  active: readonly CanonicalHistoryEnvelope[],
  turnId: string,
): void {
  const markerTurnId = `${turnId}:compaction`;
  const boundary = active.findIndex(
    ({ turn_id }) => turn_id === turnId || turn_id === markerTurnId,
  );
  if (
    boundary < 0 ||
    active.slice(boundary).some(({ turn_id }) => turn_id !== turnId && turn_id !== markerTurnId)
  ) {
    throw new Error('Retracted Turn is not the canonical history tail');
  }
}

function deletedTurnMessageIds(
  records: readonly CanonicalHistoryEnvelope[],
  turnId: string,
): readonly string[] {
  const markerTurnId = `${turnId}:compaction`;
  return [
    ...new Set(
      records
        .filter(({ turn_id }) => turn_id === turnId || turn_id === markerTurnId)
        .map(({ message_id }) => message_id),
    ),
  ];
}

function assertSettled(records: readonly CanonicalHistoryEnvelope[], operation: string): void {
  if (inspectCanonicalHistorySequence(records).status !== 'settled') {
    throw new Error(`${operation} must produce settled canonical history`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
