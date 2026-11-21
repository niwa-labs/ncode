/**
 * Gateway funnel adapter (W07 part B): exposes the dispatcher's `tool_call` /
 * `tool_result` events as `PiTurnHooks` slot functions so a host composes ONE
 * hook list — product registry handlers first (band `product` equivalent),
 * then the dispatcher (plugin-hook band, then pi band inside it). There is no
 * second tool-event hub: agent-core's `setToolHooks` already chains multiple
 * `beforeToolCall`/`afterToolCall` hooks with the pin's cumulative merge rule
 * (agent-core/src/pi-turn-runner/tools.ts:106–121), and this adapter produces
 * two more functions for exactly those slots.
 *
 * Invariants carried through (plan :775):
 * - afterToolCall override semantics are the dispatcher's tool-result fold —
 *   content-replace without structuredContent drops structuredContent.
 * - Argument modification mutates the live context in place (pin
 *   `ToolCallEventResult` doc), so the executor sees the rewritten args.
 * - Hook/permission wait time is NOT part of execution duration: this adapter
 *   adds no timing of its own; the executor's monotonic duration measurement
 *   (agent-core tool funnel) stays the single clock.
 */

import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';

import type { ExtensionDispatcher } from './dispatcher.js';

export interface ToolEventProjection {
  /** Dispatcher tool_call payload for a gateway admission point. */
  toolCallPayload(context: BeforeToolCallContext): Record<string, unknown>;
  /** Dispatcher tool_result payload for a gateway completion point. */
  toolResultPayload(context: AfterToolCallContext): Record<string, unknown>;
}

function defaultProjection(context: BeforeToolCallContext | AfterToolCallContext): {
  toolCallId: string;
  toolName: string;
  input: unknown;
  parentToolCallId?: string;
} {
  const toolCall = context.toolCall as { id: string; name: string; input?: unknown; parentToolCallId?: string };
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    input: context.args ?? toolCall.input,
    ...(toolCall.parentToolCallId !== undefined ? { parentToolCallId: toolCall.parentToolCallId } : {}),
  };
}

export interface DispatcherToolHooks {
  readonly beforeToolCall: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  readonly afterToolCall: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Build the dispatcher's before/after hooks. `beforeToolCall` rethrows handler
 * errors like the pinned `emitToolCall` (a throwing tool_call handler surfaces
 * to the pipeline — pinned runner :1256–1266); `afterToolCall` isolates them.
 */
export function createDispatcherToolHooks(dispatcher: ExtensionDispatcher): DispatcherToolHooks {
  return {
    async beforeToolCall(context, signal) {
      const base = defaultProjection(context);
      const payload: Record<string, unknown> = {
        type: 'tool_call',
        toolCallId: base.toolCallId,
        toolName: base.toolName,
        input: base.input,
        ...(base.parentToolCallId !== undefined ? { parentToolCallId: base.parentToolCallId } : {}),
      };
      const outcome = await dispatcher.dispatch('tool_call', payload, { signal });
      const result = outcome.result;
      if (!result) return undefined;
      const blocked = result.block === true;
      const hookResult: BeforeToolCallResult = {
        ...(blocked ? { block: true } : {}),
        ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
        ...(result.terminate === true ? { terminate: true } : {}),
      };
      return blocked ? hookResult : undefined;
    },

    async afterToolCall(context, signal) {
      const base = defaultProjection(context);
      const result = (context.result ?? {}) as unknown as Record<string, unknown>;
      const payload: Record<string, unknown> = {
        type: 'tool_result',
        toolCallId: base.toolCallId,
        toolName: base.toolName,
        input: base.input,
        ...(result.content !== undefined ? { content: result.content } : {}),
        ...(result.details !== undefined ? { details: result.details } : {}),
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        isError: context.isError,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      };
      const outcome = await dispatcher.dispatch('tool_result', payload, { signal });
      const merged = outcome.result;
      if (!merged) return undefined;
      const patch: AfterToolCallResult = {};
      if (merged.content !== undefined) patch.content = merged.content as AfterToolCallResult['content'];
      if (merged.details !== undefined) patch.details = merged.details;
      if (merged.structuredContent !== undefined) {
        patch.structuredContent = merged.structuredContent as AfterToolCallResult['structuredContent'];
      }
      if (merged.isError !== undefined) patch.isError = merged.isError === true;
      if (merged.usage !== undefined) patch.usage = merged.usage as AfterToolCallResult['usage'];
      return patch;
    },
  };
}
