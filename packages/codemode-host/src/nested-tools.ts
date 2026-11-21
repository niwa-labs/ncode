/**
 * Out-of-context nested tool calls (W07 part B).
 *
 * A codemode script reaches tools ONLY through the injected invoker — the ONE
 * gateway `executeTool` (plan §2.4.5 :185: scripts "получают только
 * инжектированные tools/models/pages"; C :775: "Nested calls bounded (pi
 * defaults/oversized argument/result omissions)"). The gateway applies
 * validation, admission, permission and the tool_call/tool_result dispatcher
 * events exactly as for direct calls; nested results never reach the model —
 * only the script's own output does.
 *
 * Script-value mapping mirrors the pinned coding-agent bridge
 * (extensions/codemode/execute.ts `toScriptValue` :506–514): a tool that
 * declares `outputSchema` resolves to its `structuredContent` (also on error
 * results that carry one); any other tool resolves to its text content; other
 * failures reject with the tool's error text.
 */

import type { ToolResult } from '@mavis/agent-core/tools';
import { renderToolSample, toCodemodeIdentifier } from '@earendil-works/pi-codemode/declarations';
import type { CodemodeJsonSchema, CodemodeTool } from '@earendil-works/pi-codemode';

/** pi default: argument previews in the nested-call record (execute.ts :40). */
export const ARGS_PREVIEW_CHARS = 200;
/** pi default: error previews in the nested-call record (execute.ts :41). */
export const ERROR_PREVIEW_CHARS = 500;

/** Status of one nested call, pi `CodemodeNestedCall` shape (:103–110). */
export type CodemodeNestedCallStatus = 'running' | 'ok' | 'error' | 'cancelled';

export interface CodemodeNestedCall {
  /** Tool call id of the nested call, `<parent id>/<n>` — assigned by the gateway. */
  id: string;
  name: string;
  /** Compact JSON of the arguments, truncated for display. */
  args: string;
  status: CodemodeNestedCallStatus;
  durationMs?: number;
  /** Error text, truncated for display. */
  error?: string;
}

/** The gateway surface a host injects. `invoker` IS the gateway executeTool. */
export interface NestedToolInvoker {
  invoke(
    name: string,
    args: unknown,
    options: { signal?: AbortSignal },
  ): Promise<{ toolCallId: string; result: ToolResult; isError: boolean }>;
}

/** A callable tool as the host exposes it to scripts (declaration + schema). */
export interface CallableToolDeclaration {
  name: string;
  description?: string;
  inputSchema?: CodemodeJsonSchema;
  outputSchema?: CodemodeJsonSchema;
}

export function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

export function previewArgs(args: unknown): string {
  if (args === undefined) return '';
  try {
    return truncateText(JSON.stringify(args) ?? '', ARGS_PREVIEW_CHARS);
  } catch {
    return '';
  }
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block: { type: string }): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * The value a script receives for a nested call — pinned `toScriptValue`
 * semantics against OUR ToolResult.
 */
export function toScriptValue(tool: CallableToolDeclaration, result: ToolResult, isError: boolean): unknown {
  const hasOutputSchema = tool.outputSchema !== undefined && tool.outputSchema !== false;
  if (hasOutputSchema && result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  if (isError) throw new Error(text || `Tool "${tool.name}" failed`);
  return text;
}

export interface CreateNestedToolsInput {
  readonly parentToolCallId: string;
  readonly tools: readonly CallableToolDeclaration[];
  readonly invoker: NestedToolInvoker;
  /** Appended on every record state change (host streams progress). */
  readonly onCallsChanged?: (calls: readonly CodemodeNestedCall[]) => void;
}

export interface NestedToolsResult {
  readonly sandboxTools: CodemodeTool[];
  readonly calls: readonly CodemodeNestedCall[];
  /** Calls still `running` were cut off: script end, timeout, abort (pinned :534–537). */
  readonly settleCancelled: () => void;
}

/**
 * Build the sandbox tool set. Every sandbox `execute` routes through the
 * invoker — there is deliberately no direct-execution path.
 */
export function createNestedCodemodeTools(input: CreateNestedToolsInput): NestedToolsResult {
  const { parentToolCallId, invoker, onCallsChanged } = input;
  const calls: CodemodeNestedCall[] = [];
  const publish = () => onCallsChanged?.(calls.map((call) => ({ ...call })));

  const sandboxTools: CodemodeTool[] = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ? renderToolSample({ name: tool.name, description: tool.description }) : undefined,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    execute: async (args: unknown, context: { signal: AbortSignal }) => {
      const record: CodemodeNestedCall = {
        id: `${parentToolCallId}/?`,
        name: tool.name,
        args: previewArgs(args),
        status: 'running',
      };
      calls.push(record);
      publish();
      const startedAt = performance.now();
      try {
        const outcome = await invoker.invoke(tool.name, args, { signal: context.signal });
        record.id = outcome.toolCallId;
        record.durationMs = performance.now() - startedAt;
        if (outcome.isError) {
          record.status = context.signal.aborted ? 'cancelled' : 'error';
          record.error = truncateText(
            textOf(outcome.result) || `Tool "${tool.name}" failed`,
            ERROR_PREVIEW_CHARS,
          );
        } else {
          record.status = 'ok';
        }
        publish();
        return toScriptValue(tool, outcome.result, outcome.isError);
      } catch (error) {
        // Invoker-thrown errors (blocked/permission) settle the record like a
        // failed call; the script sees the error text.
        if (record.status === 'running') {
          record.status = context.signal.aborted ? 'cancelled' : 'error';
          record.durationMs = performance.now() - startedAt;
          record.error = truncateText(
            error instanceof Error ? error.message : String(error),
            ERROR_PREVIEW_CHARS,
          );
          publish();
        }
        throw error;
      }
    },
  }));

  return {
    sandboxTools,
    calls,
    settleCancelled: () => {
      for (const call of calls) {
        if (call.status === 'running') call.status = 'cancelled';
      }
      publish();
    },
  };
}

/** `searchTools`-style declaration list of every callable tool (`ALL_TOOLS`). */
export function toolCatalog(tools: readonly CallableToolDeclaration[]): Record<string, string> {
  return Object.fromEntries(
    tools.map((tool) => [toCodemodeIdentifier(tool.name), renderToolSample({ name: tool.name, description: tool.description })]),
  );
}
