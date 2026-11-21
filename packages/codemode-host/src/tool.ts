/**
 * The `codemode` tool as a gateway `RuntimeTool` (W07 part B).
 *
 * This is an EXTENSION-registered orchestration tool, not a zone-A built-in:
 * its `def`/`impl` follow the W04 tool contract (`@mavis/agent-core` ToolResult
 * with structuredContent/usage/isError; durationMs stays the executor's
 * monotonic clock — this adapter never sets it). The tool declares no
 * outputSchema, so nothing structured leaks to the model; nested calls carry
 * `parentToolCallId`, so the gateway records them under the parent exactly like
 * the pinned session does.
 */

import { Type } from '@sinclair/typebox';
import type { RuntimeTool, ToolExecutionContext, ToolResult } from '@mavis/agent-core/tools';

import { executeCodemodeScript, type CodemodeSandboxMode } from './host.js';
import type { CallableToolDeclaration, CodemodeNestedCall, NestedToolInvoker } from './nested-tools.js';

export const CODEMODE_TOOL_NAME = 'codemode';

const codemodeSchema = Type.Object({
  code: Type.String({ description: 'Raw JavaScript source (not JSON, no code fence).' }),
});

export interface CodemodeRuntimeToolDeps {
  /** Resolves the callable nested tools for this turn (active `direct` + `codemode`/`deferred`). */
  readonly resolveCallableTools: () => readonly CallableToolDeclaration[];
  /** The gateway invoker — the ONE executeTool funnel. */
  readonly invoker: NestedToolInvoker;
  readonly sandboxMode?: CodemodeSandboxMode;
  /** Bundled-daemon support: explicit worker file URL (see host.ts). */
  readonly workerUrl?: string | URL;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  /** Session store for `load()`; `store()` writes are handed back in details. */
  readonly readStore?: (ctx: ToolExecutionContext) => Readonly<Record<string, unknown>> | undefined;
  readonly onCallsChanged?: (calls: readonly CodemodeNestedCall[]) => void;
}

export function createCodemodeRuntimeTool(deps: CodemodeRuntimeToolDeps): RuntimeTool<typeof codemodeSchema> {
  return {
    def: {
      name: CODEMODE_TOOL_NAME,
      label: CODEMODE_TOOL_NAME,
      description:
        'Run JavaScript that calls other tools. The input is raw JavaScript run as an async function body in a ' +
        'QuickJS sandbox: top-level await and return work. No Node, file system, network, or timers; only the ' +
        'injected tools are callable via `tools.<name>({...})`. Only the script output reaches the model.',
      schema: codemodeSchema,
    },
    impl: {
      async execute(ctx, input, signal): Promise<ToolResult> {
        const output = await executeCodemodeScript({
          code: input.code,
          parentToolCallId: ctx.toolCallId ?? ctx.turnId,
          callableTools: deps.resolveCallableTools(),
          invoker: deps.invoker,
          signal,
          ...(deps.readStore ? { store: deps.readStore(ctx) ?? {} } : {}),
          ...(deps.sandboxMode !== undefined ? { sandboxMode: deps.sandboxMode } : {}),
          ...(deps.workerUrl !== undefined ? { workerUrl: deps.workerUrl } : {}),
          ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
          ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
          ...(deps.onCallsChanged !== undefined ? { onCallsChanged: deps.onCallsChanged } : {}),
        });
        return {
          tool_name: CODEMODE_TOOL_NAME,
          text: output.text,
          content: [{ type: 'text', text: output.text }],
          details: { calls: output.calls },
          ...(output.isError ? { isError: true } : {}),
        };
      },
    },
    source: 'configured',
  };
}
