/**
 * Runtime event surface — bridges `@mavis/protocol`'s thrift-generated
 * shapes into the names agent-core internals use.
 *
 * The protocol package was regenerated from a thrift IDL via
 * `@creditkarma/thrift-typescript`. The new surface differs from the old
 * hand-written package in two important ways:
 *
 *  1. **Single struct + numeric enum** — instead of a discriminated union
 *     of `StreamRespEvent | ActionRequiredEvent | …`, there is now one
 *     `IRuntimeEvent` whose `type` is the numeric `RuntimeEventType` enum
 *     and whose `payload` is one `IRuntimeEventPayload` struct with every
 *     variant field optional. Narrow on `event.type === RuntimeEventType.X`
 *     at consumption sites.
 *  2. **No zod schemas** — `RuntimeEventSchema`, `RuntimeEventTypeSchema`
 *     etc. are gone. We accept the loss of runtime validation here per
 *     project owner directive.
 *
 * This file re-exports the protocol types under both their new `IXxx`
 * names and the legacy `RuntimeXxx` aliases that the rest of agent-core
 * already uses, plus defines small local types for the agent-core
 * internal vocabulary (`RuntimeToolCall`, `RuntimeToolCallStatus`,
 * `RuntimeRole`, `RuntimeMessageKind`, `RuntimeSessionStatus`,
 * `RuntimeTerminalStatus`) that were never IDL-bound.
 *
 * Daemon usage hint
 * -----------------
 * Phase 1: daemon emits `AgentMessageChunk` (see {@link ./agent-message.ts}).
 * Phase 2: daemon emits `RuntimeEvent` directly via `EventSink.pushRuntime`.
 *
 * Cloud impl hint
 * ---------------
 * Cloud-runtime always works with `RuntimeEvent` internally and translates
 * into `AgentMessageChunk` only in `ExchangeSink` for Phase 1 compatibility.
 */

import type {
  IPluginCapabilityProvenance,
  IProtocolError,
  IAttachment,
  IRuntimeAction,
  IRuntimeDebugTrace,
  IRuntimeEvent,
  IRuntimeStopReason,
  IRuntimeUsage,
} from '@mavis/protocol';

// ── Legacy-name aliases for agent-core internal use ───────────────────
//
// The rest of agent-core (event-bridge, pi-turn-runner, tests) still
// imports `RuntimeEvent`, `RuntimeAction`, … under the old names. Keep
// them as type aliases over the generated `IXxx` shapes so call sites
// don't have to flip every identifier in one pass.

// ── Re-exports from the generated thrift surface ──────────────────────

export type {
  IAttachment,
  IRuntimeAction,
  IRuntimeDebugTrace,
  IRuntimeEvent,
  IRuntimeEventPayload,
  IRuntimeStopReason,
  IRuntimeUsage,
} from '@mavis/protocol';

export {
  RuntimeActionType,
  RuntimeDebugTraceLevel,
  RuntimeEventStatus,
  RuntimeEventType,
  RuntimeStopReasonType,
} from '@mavis/protocol';

export { RUNTIME_EVENT_SCHEMA } from '@mavis/protocol';

export type RuntimeEvent = IRuntimeEvent;
export type RuntimeAction = IRuntimeAction;
export type RuntimeStopReason = IRuntimeStopReason;
export type RuntimeDebugTrace = IRuntimeDebugTrace;
export type RuntimeUsage = IRuntimeUsage;
export type RuntimeAttachment = IAttachment;

// Variant aliases — the new protocol collapses the discriminated union
// into one `IRuntimeEvent`, so each variant is just the same struct with
// the type tag carrying the meaning. Narrow on `event.type === RuntimeEventType.X`.
export type StreamRespEvent = IRuntimeEvent;
export type ActionRequiredEvent = IRuntimeEvent;
export type SessionStatusEvent = IRuntimeEvent;
export type TurnTerminalEvent = IRuntimeEvent;
export type DebugTraceEvent = IRuntimeEvent;

// ── Agent-core-internal vocabulary ────────────────────────────────────
//
// These types describe shapes the agent-core bridge / pi-turn-runner
// pass around in memory. They were never part of the IDL — the wire
// format always lived under `IRuntimeEvent.payload.*` — so they stay
// local to agent-core.

export type RuntimeRole = 'user' | 'assistant' | 'system';
export type RuntimeMessageKind =
  | 'assistant'
  | 'summary'
  | 'compaction_start'
  | 'compaction'
  | 'compaction_failed'
  | 'review_start'
  | 'review_result'
  | 'review_failed'
  | 'review_aborted'
  | 'review_interrupted';
export type RuntimeSessionStatus = 'running' | 'waiting_action' | 'idle' | 'failed' | 'aborted';
export type RuntimeTerminalStatus = 'completed' | 'failed' | 'aborted';
/**
 * `preparing` / `prepared` cover the model-side streaming phase: the LLM is
 * still emitting the call's arguments (`preparing`) or has finished them
 * (`prepared`) but the host has not dispatched the tool yet. `started`
 * onwards is the host execution phase.
 */
export type RuntimeToolCallStatus =
  | 'preparing'
  | 'prepared'
  | 'started'
  | 'running'
  | 'completed'
  | 'failed';

/**
 * Runtime status errors carry product daemon status_code values on the wire
 * (for example 50110 / 50111 / 50151), not only the low-cardinality thrift
 * ProtocolErrorCode enum. Keep the JSON shape compatible with IProtocolError
 * while allowing the broader numeric daemon code space.
 */
export interface RuntimeProtocolError extends Omit<IProtocolError, 'code'> {
  code: number;
}

/**
 * Who resolved a tool call's permission check and how (§4 `decidedBy`).
 *
 * Wire shape (ACP `_meta["minimax-code/permission"]`, runtime tool-call
 * status payloads): all five keys are ALWAYS present on a emitted mark —
 * `ruleKind: null` means "no rule was involved", not "unknown".
 *
 *   - `rule`    — a `permission.json` rule (`ruleKind` = its scope) or a
 *                 built-in checker policy (`ruleKind: 'builtin'`: safe-bash
 *                 fast-allow, fs inside workspace, final-deny, checker deny);
 *   - `classifier` — the managed-auto cloud classifier allowed the call;
 *   - `mode`    — a permission mode waived the check (bypass step 2a,
 *                 ask-gate downgrade, `off`);
 *   - `hook`    — a plugin hook (canPluginAutoApprove / PreToolUse) decided;
 *   - `user`   — the client answered a permission request (one-time or
 *                 persistent reply) or never answered (`reason:
 *                 "unanswered: <cancelled|error|closed|not_current|no_prompt>"`).
 */
export interface RuntimePermissionMark {
  decision: 'allow' | 'deny';
  decidedBy: 'classifier' | 'rule' | 'mode' | 'hook' | 'user';
  ruleKind: 'builtin' | 'session' | 'agent' | 'global' | null;
  /** Effective permission mode of the check that produced this mark. */
  mode: 'default' | 'auto' | 'bypassPermissions' | 'acceptEdits' | 'dontAsk' | 'off';
  /** Non-empty human-readable reason; the runtime always sends it. */
  reason: string;
}

/**
 * Turn-local, fail-open source of {@link RuntimePermissionMark}s keyed by the
 * pi `AgentToolCall.id`. The v2 permission gate records one mark per resolved
 * tool call; the event bridge stamps it onto every status event of that call
 * (Start normally predates the decision — the mark is guaranteed on the
 * final Finished/Failed status).
 */
export interface TurnPermissionMarkSource {
  get(toolCallId: string): RuntimePermissionMark | undefined;
}

/**
 * Tool-call state the bridge stages per assistant turn. Wire serialisation
 * happens in {@link toolCallFromRuntime} (event-bridge/converters.ts) which
 * folds `args` / `result` / `error` down to JSON strings on the legacy
 * `ToolCall` envelope.
 */
export interface RuntimeToolCall {
  tool_name: string;
  tool_call_id: string;
  /** Optional parent run_code id for a host-executed PTC child call. */
  parent_tool_call_id?: string;
  status: RuntimeToolCallStatus;
  args?: Record<string, unknown>;
  /**
   * Raw argument-JSON fragment for one `preparing` streaming update. Carried
   * only on argument-streaming chunks; the consumer accumulates fragments in
   * arrival order until the call leaves `preparing`.
   */
  args_text_delta?: string;
  result?: unknown;
  error?: RuntimeProtocolError;
  /** Immutable Plugin owners of the capability actually used by this call. */
  plugin_provenances?: IPluginCapabilityProvenance[];
  /** Tool execution wall-clock in ms (bridge-measured); non-prod / debug only. */
  duration_ms?: number;
  /** §4 `decidedBy` mark; present once the permission gate resolved this call. */
  permission?: RuntimePermissionMark;
}

/**
 * Intermediate "runtime message" shape some host bridges build before
 * they emit the wire-level `IRuntimeEvent`. Kept as an internal type
 * because it's an agent-core ergonomic — the wire never carries it.
 */
export interface RuntimeMessage {
  message_id: string;
  parent_message_id?: string;
  role: RuntimeRole;
  message_kind?: RuntimeMessageKind;
  text?: string;
  thinking?: string;
  tool_calls?: RuntimeToolCall[];
  attachments?: RuntimeAttachment[];
  usage?: RuntimeUsage;
  source?: string;
  origin?: unknown;
  created_at_ms?: number;
}

/** Streaming delta companion to {@link RuntimeMessage}. */
export interface RuntimeMessageChunk {
  message_id: string;
  parent_message_id?: string;
  role?: 'assistant';
  message_kind?: RuntimeMessageKind;
  text_delta?: string;
  thinking_delta?: string;
  tool_calls?: RuntimeToolCall[];
  chunk_index?: number;
  created_at_ms?: number;
}

/** Draft variant used when the host hasn't yet allocated a final message id. */
export interface RuntimeMessageDraft {
  client_message_id?: string;
  parent_message_id?: string;
  role: RuntimeRole;
  message_kind?: RuntimeMessageKind;
  text?: string;
  thinking?: string;
  tool_calls?: RuntimeToolCall[];
  attachments?: RuntimeAttachment[];
  source?: string;
  origin?: unknown;
  created_at_ms?: number;
}
