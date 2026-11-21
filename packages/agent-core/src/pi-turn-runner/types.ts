/**
 * Pi turn runner boundary types.
 *
 * These are explicit per-turn contracts owned by `pi-turn-runner`. They
 * describe the model, event writer, user message, and tool configuration
 * supplied to `PiTurnRunner.runTurn(...)`; hosts may own event identity when
 * Pi attempts and native tools must share one logical-Turn sequence.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  Api,
  CacheRetention,
  ImageContent,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { IRuntimeEvent } from '@mavis/protocol';
import type { TurnPermissionMarkSource } from '../protocol/runtime-event.js';
import type {
  RuntimeTool,
  ToolCallProvenanceResolver,
  ToolExecutionContext,
} from '../tools/index.js';
import type { TSchema } from '@sinclair/typebox';
import type { ContextWireProjection } from './context-wire.js';
import type { PiBeforeLlmCallAppendMessage, PiTurnHooks } from './hooks.js';
import type { LLMRetryOptions } from './llm-retry.js';
import type { PrepareRequestSnapshotSupplier } from './request-snapshot.js';

export type RuntimeEvent = IRuntimeEvent;

/** Canonical in-memory history message exposed at the agent-core boundary. */
export type PiAgentMessage = AgentMessage;

export interface LLMModelConfig {
  model: Model<Api>;
  apiKey?: string;
  streamFn?: StreamFn;
  thinkingLevel?: ThinkingLevel;
  cacheRetention?: CacheRetention;
  maxTokens?: number;
  /** Host-owned serialized request cap used by before-LLM context admission. */
  maxSerializedInputBytes?: number;
  /**
   * Ceiling the host owns for this turn's output, not a default.
   *
   * `maxTokens` above is the model's own configured cap and loses to any
   * explicit per-call option; this one wins by taking the minimum of itself,
   * whatever the request already asked for, and the model's own cap, so a
   * budget the host already clamped can never be widened downstream. Leave it
   * absent when the host has no such budget — every request then behaves
   * exactly as before. Present but not a positive integer is rejected when the
   * turn assembles its stream function, before any provider request.
   */
  hostMaxOutputTokens?: number;
  headers?: Record<string, string>;
  /**
   * Per-attempt wait (ms) for the first provider stream event before the
   * request is aborted and reported as a retryable timeout. Absent: the
   * `MCODE_LLM_FIRST_EVENT_TIMEOUT_MS` environment value, else
   * `LLM_FIRST_EVENT_TIMEOUT_MS`. `0` disables the bound.
   */
  firstEventTimeoutMs?: number;
  /**
   * Per-attempt maximum gap (ms) between provider stream events after the
   * first. Absent: `MCODE_LLM_STREAM_IDLE_TIMEOUT_MS`, else
   * `LLM_STREAM_IDLE_TIMEOUT_MS`. `0` disables the bound.
   */
  streamIdleTimeoutMs?: number;
  fetch?: SimpleStreamOptions['fetch'];
  /** Provider payload transform for the main assistant response. */
  payloadTransform?: SimpleStreamOptions['onPayload'];
  /**
   * Provider payload transform for auxiliary LLM calls made by hooks, such as
   * automatic context-compaction checkpoints. Falls back to payloadTransform
   * when omitted so existing hosts retain their request-shaping behavior.
   */
  auxiliaryPayloadTransform?: SimpleStreamOptions['onPayload'];
  responseObserver?: SimpleStreamOptions['onResponse'];
}

export interface ToolConfig<TCtx extends ToolExecutionContext = ToolExecutionContext> {
  tools?: readonly RuntimeTool<TSchema, TCtx>[];
  disableBuiltinToolFallback?: boolean;
  context: TCtx;
}

export interface UserMessageInput {
  timestamp?: number;
  text: string;
  attachments?: readonly ImageContent[];
  canonicalTextRange?: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
  genuineUserQueryText?: string;
  /** Opaque Host-owned metadata. Provider projection always removes it. */
  hostMetadata?: Readonly<Record<string, unknown>> & { readonly immediateSendBatchId?: string };
}

/** How a fresh per-Turn Pi Agent starts its agent loop. */
export type RunTurnStartMode = 'prompt' | 'continue';

/**
 * Who initiated the turn — becomes the low-cardinality `caller` metric label
 * on turn metrics (MR1+). Values:
 * - `'chat'`            direct user message over the local HTTP API
 * - `'cron'`            scheduled cron task drain
 * - `'channel_feishu'`  IM channel inbound (single bucket for all channels
 *                       today; split per platform when more channels ship)
 * - `'team'`            team/multi-agent orchestration
 * - `'compact'`         history compaction (not yet populated — compaction
 *                       drives the LLM directly and bypasses PiTurnRunner)
 * - `'permission_llm'`  LLM-based permission evaluation
 */
export type RunTurnCaller =
  | 'chat'
  | 'cron'
  | 'channel_feishu'
  | 'team'
  | 'compact'
  | 'permission_llm';

/** Bounded origin of a cancelled Pi turn. Unknown values collapse to `unknown`. */
export type AbortSource =
  | 'user_stop'
  /**
   * Leaving a conversation (TUI `/clear`, switching Sessions). Keeps the Goal and
   * Queue pause effects of `user_stop`, but is NOT a stop: it must not cascade
   * into the Session's background work, which is expected to keep running.
   */
  | 'session_leave'
  | 'immediate_send'
  | 'input_safety'
  | 'output_safety'
  | 'lifecycle'
  | 'unknown';

export function normalizeAbortSource(value: unknown): AbortSource {
  switch (value) {
    case 'user_stop':
    case 'session_leave':
    case 'immediate_send':
    case 'input_safety':
    case 'output_safety':
    case 'lifecycle':
      return value;
    default:
      return 'unknown';
  }
}

/**
 * Boundary classification the runner reports on every steering poll.
 * `mid-turn`: further steps already follow (tool calls or queued follow-ups),
 * so returned messages ride along before the next LLM hop. `exit`: the last
 * step produced no further work and the runner attempts
 * {@link RunTurnInput.tryBeginClose} as soon as the poll returns nothing —
 * hosts may withhold messages here so the close hands them back to the
 * session instead of extending a finished answer.
 */
export interface SteeringPollContext {
  readonly boundary: 'mid-turn' | 'exit';
}

export interface RunTurnInput<TCtx extends ToolExecutionContext = ToolExecutionContext> {
  sessionId: string;
  turnId: string;
  workspaceDir: string;
  systemPrompt: string;
  /** Host-owned named sections; replay and deltas use Pi native system messages. */
  systemPromptSections?: Readonly<Record<string, string>>;
  userMessage: UserMessageInput;
  /** Omitted callers append `userMessage`; continuation re-enters from supplied history. */
  startMode?: RunTurnStartMode;
  llm: LLMModelConfig;
  eventWriter: PiEventWriter;
  history?: AgentMessage[];
  /** Hidden Host messages appended immediately before the current real user. */
  beforeUserMessages?: readonly (
    | PiBeforeLlmCallAppendMessage
    | import('@earendil-works/pi-ai').UserMessage
  )[];
  signal?: AbortSignal;
  toolConfig: ToolConfig<TCtx>;
  hooks?: PiTurnHooks;
  /** Host opt-in for framework transport retry. Omitted hosts keep legacy behavior. */
  llmRetry?: Omit<LLMRetryOptions, 'sessionId' | 'turnId' | 'scope'>;
  /** Attribution captured from the same immutable capability snapshot as this turn's tools. */
  toolCallProvenanceResolver?: ToolCallProvenanceResolver;
  /**
   * §4 `decidedBy`: turn-local permission-mark sink recorded by the
   * permission gate per resolved tool call; forwarded to the event bridge so
   * every status event of that call carries who decided it. Absent — status
   * events ship without the `permission` field.
   */
  permissionMarks?: TurnPermissionMarkSource;
  /** Forwarded to {@link EventBridgeContext.captureToolTiming}; host sets it non-prod only. */
  captureToolTiming?: boolean;
  /** TUI-only wire detail used to render output throughput. */
  includeDetailedUsage?: boolean;
  /** Turn initiator classification; see {@link RunTurnCaller}. */
  caller?: RunTurnCaller;
  /** Optional logical-Turn event identity source shared by host-owned retry attempts. */
  eventIdGenerator?: (kind: string) => string;
  /** Optional logical-Turn runtime sequence source shared by host-owned retry attempts. */
  runtimeSeqGenerator?: () => number;
  /** Messages accepted while the current step was running and injected before its next LLM hop. */
  getSteeringMessages?: (
    context?: SteeringPollContext,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  /**
   * Gracefully ends the run when host-side steering admission rejects continuation.
   * Migrated to the pin's post-steering-poll veto seam (§5.1 row 15): the veto
   * fires after messages were dequeued and BEFORE any placement/next request.
   */
  shouldStopAfterSteering?: () => boolean | Promise<boolean>;
  /**
   * Reactive subagents §1.7 (wave 3): the accepted-owner-input generation of
   * the owning conversation, forwarded to the pin's sequential-executor
   * yield seam. A generation change between two calls of ONE tool batch
   * makes the not-yet-started calls receive honest skipped outcomes instead
   * of starting blind against an already-accepted instruction. Absent (jsonl
   * mode, embeddings): the batch behaves exactly as before.
   */
  ownerInputGeneration?: () => number | Promise<number>;
  /**
   * Gracefully ends after the current assistant/tool step and before any follow-up poll.
   * Migrated onto the pin-native `finishTurn` hook (§5.1 row 32): `true` maps to
   * `{action:"end"}`, `false`/`undefined` preserves normal scheduling — never
   * `{action:"continue"}` (an explicit continuation adds a request).
   */
  shouldStopAfterTurn?: (context: {
    message: AgentMessage;
    toolResults: import('@earendil-works/pi-ai').ToolResultMessage[];
    context: import('@earendil-works/pi-agent-core').AgentContext;
    newMessages: AgentMessage[];
  }) => boolean | Promise<boolean>;
  /** Text returned when a provider emits a tool call the host intentionally did not expose. */
  unexpectedToolCallFallback?: string;
  /**
   * Atomically seals external continuation acceptance once steering is empty.
   * `false` means work won the close race and the runner must poll once more.
   */
  tryBeginClose?: (context: {
    /** Text from the most recent assistant message at this close boundary. */
    readonly lastAssistantMessage?: string;
  }) => boolean | Promise<boolean>;
  /**
   * W04 canonical request-snapshot bridge (W03 C3 RequestSnapshot over the
   * W02 storage adapter). When present, the runner installs the pin-native
   * `prepareRequest` hook and takes exactly one immutable canonical snapshot
   * per logical provider request — including the first — reusing it for that
   * request's physical retries. Absent (the default), no hook is installed and
   * the legacy path is byte-identical.
   */
  prepareRequestSnapshot?: PrepareRequestSnapshotSupplier;
  /**
   * Ш4 context-wire projection: when present, the provider-bound payload is
   * compiled by the composition-owned memoized pipeline instead of the legacy
   * per-request `projectAgentMessagesForModel` assembly. Injected only by
   * compositions that enabled the wire path (`MCODE_CONTEXT_WIRE=1`);
   * absent (the default) the legacy conversion stays exact. A projection
   * never throws through the request path — it returns `undefined` to
   * degrade a single request back to the legacy conversion.
   */
  contextWire?: ContextWireProjection;
  /**
   * Host composition over the MAIN assistant stream fn (W06 cache warming):
   * applied OUTERMOST around the fully composed product chain (host output
   * clamp -> cacheRetention -> maxTokens -> headers -> fetch -> request
   * timeout -> stream watchdogs), so the wrapper observes the same
   * `(model, context, options)` triple the transport receives and its
   * captured transport IS the composed product path. Auxiliary
   * (compaction-scope) stream fns are NOT wrapped - they route under their
   * own request identities. The wrapper must delegate verbatim: pass
   * `model`, `context` and `options` to `inner` by the same object
   * references.
   */
  wrapStreamFn?: (inner: StreamFn) => StreamFn;
}

/**
 * Per-turn event writer surface. PiTurnRunner batches multiple RuntimeEvents
 * per pi `AgentEvent` and delegates actual event persistence / fan-out to the caller.
 */
export interface PiEventWriter {
  /** Push a single canonical `RuntimeEvent`. */
  pushRuntime(event: RuntimeEvent): void | Promise<void>;
  /** Push a batch atomically when the caller supports it. */
  appendEvents(events: RuntimeEvent[]): void | Promise<void>;
}

/**
 * Turn-owned event identity and delivery surface shared by Pi and native tools.
 * Hosts inject the same reporter for the full logical turn, including retries.
 */
export interface TurnEventReporter {
  nextEventId(kind: string): string;
  nextRuntimeSeq(): number;
  appendEvents(events: RuntimeEvent[]): Promise<void>;
}

export interface PiTurnRunnerLogger {
  debug?(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}
