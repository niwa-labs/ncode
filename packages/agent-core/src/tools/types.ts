/**
 * Core tool contracts.
 *
 * `ToolDefinition`: The public tool contract. Its typebox schema (`TSchema`) is forwarded by
 * PiTurnRunner to pi as `AgentTool.parameters` and used with `Static<S>` to infer strongly typed
 * `ToolImpl.execute(input)` arguments. `prepareArguments` / `executionMode` map directly to the
 * corresponding Pi 0.79.1 `AgentTool` fields.
 *
 * `ToolExecutionContext`: Minimal context built by the host each turn and captured by the pi
 * `AgentTool` wrapper. Hosts can extend it (cloud-runtime's `CloudRuntimeContext` adds reporter /
 * bizId / workspaceRoot, etc.) and declare their TCtx in `ToolImpl<S, TCtx>`. **Never** inject
 * per-turn tool state through `AsyncLocalStorage`; the wrapper closure is the only injection point.
 *
 * `ToolImpl<S, TCtx>`: Tool implementation. The first argument to `execute(ctx, input, signal?,
 * onUpdate?)` is per-turn context, captured by the host in `assembleAgentTools`. One ToolDefinition
 * may have multiple ToolImpl implementations (cloud / local / mock), all sharing the same execute
 * signature.
 *
 * `RuntimeTool<S, TCtx>` — the `(def, impl)` pair consumed by PiTurnRunner. New platform-owned
 * tools should prefer declaring this object directly with `defineRuntimeTool(...)`, keeping the
 * LLM-facing definition and runtime implementation co-located.
 *
 * `bindTool(def)` / `toRuntimeTool(instance)` remain available for decorated class implementations,
 * but new code should prefer `defineRuntimeTool(...)`.
 */

import type { AgentToolUpdateCallback, ToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { ImageContent, JsonValue, TextContent, Usage } from '@earendil-works/pi-ai';
import type { Static, TSchema } from '@sinclair/typebox';
import type { IPluginCapabilityProvenance } from '@mavis/protocol';

export type RuntimeToolSource = 'builtin' | 'builtin-matrix' | 'configured';

export interface ToolCallProvenanceResolutionInput {
  readonly phase: 'start' | 'end';
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  readonly isError?: boolean;
}

export type ToolCallProvenanceResolver = (
  input: ToolCallProvenanceResolutionInput,
) => readonly IPluginCapabilityProvenance[] | undefined;

export interface VideoContent {
  type: 'video';
  data: string;
  mimeType: string;
}

export type ToolResultContent = TextContent | ImageContent | VideoContent;

/**
 * Source-owned, bounded operation classification for observability.
 *
 * The tool owns its operation vocabulary; PiTurnRunner accepts a classifier
 * result only when it belongs to this fixed allowlist. Unknown, malformed, or
 * throwing classifications collapse to the shared `unknown` metric value.
 */
export interface ToolOperationClassifier {
  readonly allowedValues: readonly string[];
  classify(args: unknown): string | undefined;
}

export interface ToolDefinition<S extends TSchema = TSchema> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly schema: S;
  readonly promptGuidelines?: readonly string[];
  readonly prepareArguments?: (args: unknown) => Static<S>;
  readonly executionMode?: ToolExecutionMode;
  readonly operationClassifier?: ToolOperationClassifier;
  /**
   * W04 (pin tool contract): JSON Schema of `structuredContent` in successful
   * results. Forwarded to pi `AgentTool.outputSchema`; tools that declare it
   * should always set `structuredContent` on success. Not sent to the model as
   * a call parameter — it describes the programmatic result channel only.
   */
  readonly outputSchema?: TSchema;
}

/**
 * Tool result. `content` stays compatible with pi `AgentToolResult` (a single text segment is
 * sufficient); `details` holds structured byproducts (read by the UI / caller, not the LLM);
 * `terminate` maps to Pi `AgentToolResult.terminate`; `output` is a legacy field retained only for
 * migration compatibility. New code should use `details`.
 *
 * W04 (pin tool contract): `structuredContent` is the machine-readable result matching the
 * tool's `outputSchema` — never sent to the model; `usage` carries tool-owned usage/cost of the
 * execution itself (not main-LLM context accounting); `isError` reports failure without
 * throwing while `details`/`structuredContent` stay available to the UI and programmatic
 * callers. `durationMs` is measured by the executor (monotonic clock, excludes hooks) and is
 * not set here.
 */
export interface ToolResult {
  tool_name: string;
  text: string;
  content: ToolResultContent[];
  isError?: boolean;
  details?: Record<string, unknown>;
  output?: Record<string, unknown>;
  terminate?: boolean;
  /** Machine-readable result for programmatic callers; matches `outputSchema` when declared. */
  structuredContent?: JsonValue;
  /** Usage/cost of the tool execution itself, when the tool can account it. */
  usage?: Usage;
  /** PTC-only payload; see `ProgrammaticToolResult`. Model calls ignore it. */
  programmatic?: ProgrammaticToolResult;
}

/** Programmatic (PTC) side-channel payload of one tool result; model-invisible. */
export interface ProgrammaticToolResult {
  /** Structured value; always a JSON object and never more than the text output shows. */
  readonly data?: Readonly<Record<string, unknown>>;
  readonly completeness?: ProgrammaticToolCompleteness;
  /** Raw protocol or connection error of a third-party call; hosts never branch on it. */
  readonly errorRaw?: unknown;
  /**
   * PTC child calls only: a model-visible output cap that a direct call of the
   * same tool applies would have cut this output, and the tool returned it in
   * full instead. Hosts only count it for logs; it never changes the result.
   */
  readonly uncappedOutput?: boolean;
}

export interface ProgrammaticToolCompleteness {
  /** True when this output dropped content (page, byte cap, match limit, cut lines, ...). */
  readonly truncated: boolean;
  /**
   * The source has more beyond this page although nothing was cut, for
   * example a `read` that stopped at the caller's `limit`.
   */
  readonly hasMore?: boolean;
  readonly nextOffset?: number;
  readonly offsetUnit?: 'line' | 'match' | 'file';
}

/** One nested (host-executed) child call of an outer tool such as `run_code`. */
export interface NestedToolEventInput {
  /** The child's own call id, `<parentToolCallId>/<n>`, assigned at registration. */
  readonly toolCallId: string;
  /** The outer tool call id the child is attributed to. */
  readonly parentToolCallId: string;
  readonly toolName: string;
  /** Start only: validated child arguments. */
  readonly args?: Record<string, unknown>;
  /** End only: the child's result payload as it should be shown to clients. */
  readonly result?: unknown;
  /** End only: failure text (a cancelled child reports why it stopped). */
  readonly error?: string;
  /** End only: child wall-clock in ms. */
  readonly durationMs?: number;
}

/**
 * Host-side sink for nested tool-call events. The turn runner owns event
 * sequencing and the durable bridge; a host tool (e.g. `run_code`) only
 * reports that a child started and finished, and the runner feeds the same
 * STREAM_RESP path direct calls use. Children are never appended to the
 * model-visible transcript as independent top-level calls.
 */
export interface NestedToolEventSink {
  start(input: NestedToolEventInput): void;
  end(input: NestedToolEventInput): void;
}

/**
 * Per-turn execution context, captured by the host in each `AgentTool.execute` wrapper in
 * `assembleAgentTools`. The minimal fields are sessionId / turnId. Hosts may extend it
 * (cloud-runtime's `CloudRuntimeContext` adds `bizId` / `reporter` / `workspaceRoot`, etc.) and
 * declare the corresponding TCtx in their `ToolImpl<S, TCtx>`.
 */
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  /** Per-call id supplied by the provider loop; absent in older/direct test paths. */
  readonly toolCallId?: string;
  /** Assistant message carrying this tool call; supplied by the runtime bridge when available. */
  readonly assistantMessageId?: string;
  /** Present when the host runner can record nested child calls (absent in bare test hosts). */
  readonly nestedToolEvents?: NestedToolEventSink;
}

/**
 * Tool implementation.
 *
 * `ctx` is host-built per-turn context injected via a closure in `assembleAgentTools`, not
 * `AsyncLocalStorage`. `input` fields are strongly typed from ToolDefinition.schema using
 * `Static<typeof schema>`.
 *
 * `signal` is an optional turn-level abort channel passed by pi `AgentTool.execute` and triggered
 * when SessionController aborts. Potentially blocking implementations (HTTP, long-running sandbox
 * shell, external resource IO) should forward it to fetch or check `signal.aborted` at key points,
 * allowing SessionController to interrupt inflight operations instead of waiting for natural
 * timeouts.
 *
 * `onUpdate` is Pi's partial tool result callback for streaming long-task progress. Implementations
 * may ignore it; when used, partial results must share the semantics of the final
 * `ToolResult.content/details`.
 */
export interface ToolImpl<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> {
  execute(
    ctx: TCtx,
    input: Static<S>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
  ): Promise<ToolResult>;
}

/**
 * `(def, impl)` pair. PiTurnRunner only depends on this protocol shape; it
 * does not care whether a tool comes from cloud, desktop, mobile, or a test
 * host.
 */
export interface RuntimeTool<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> {
  readonly def: ToolDefinition<S>;
  readonly impl: ToolImpl<S, TCtx>;
  readonly source?: RuntimeToolSource;
  /** Turn-local display attribution; never affects execution or permission semantics. */
  readonly toolCallProvenanceResolver?: ToolCallProvenanceResolver;
}

export type { ToolExecutionMode };
