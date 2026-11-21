/**
 * Codemode script executor (W07 part B).
 *
 * Runs ONE script against the injected nested tools on `@earendil-works/pi-codemode`
 * — inline (same-thread QuickJS) or worker (fresh worker thread + fresh VM per
 * execution, pinned runtime/host.ts) sandboxes. QuickJS is a capability sandbox
 * parallel in purpose to the OS sandbox, never a replacement (U21): scripts get
 * no ambient Node, fetch, network, or timers — only injected tools.
 *
 * Result policy (C :775): a failed script keeps its partial output ("Script
 * failed" + "Script error:" block, pinned execute.ts :549–551); nested call
 * records are bounded previews; only the script's output reaches the model.
 */

import {
  type CodemodeOutputItem,
  type CodemodeResult,
  CodemodeSandbox,
  InlineCodemodeSandbox,
  type CodemodeSandboxBaseOptions,
  loadQuickJSWasm,
  parseCodemodeSource,
} from '@earendil-works/pi-codemode';

import {
  createNestedCodemodeTools,
  type CallableToolDeclaration,
  type CodemodeNestedCall,
  type NestedToolInvoker,
} from './nested-tools.js';

/** pi default: heap limit so a runaway script cannot take the host down (execute.ts :58). */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** pi default: token budget for script output (execute.ts :258). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/** pi default: characters per token when estimating (:259). */
const CHARS_PER_TOKEN = 4;

export type CodemodeSandboxMode = 'inline' | 'worker';

export interface CodemodeExecuteInput {
  readonly code: string;
  readonly parentToolCallId: string;
  readonly callableTools: readonly CallableToolDeclaration[];
  readonly invoker: NestedToolInvoker;
  readonly signal?: AbortSignal;
  /** Values the script reads with `load(key)`. */
  readonly store?: Readonly<Record<string, unknown>>;
  readonly sandboxMode?: CodemodeSandboxMode;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly onCallsChanged?: (calls: readonly CodemodeNestedCall[]) => void;
  /**
   * Bundled-daemon support: explicit worker file URL. Source-tree runs resolve
   * pi-codemode's own worker automatically; a bundled host chunk cannot, so
   * the build emits dist/codemode-worker.js and the caller passes its URL.
   */
  readonly workerUrl?: string | URL;
}

export interface CodemodeToolOutput {
  readonly text: string;
  readonly isError: boolean;
  readonly calls: readonly CodemodeNestedCall[];
  /** `store()` writes of a successful script; persisting them is the host's job. */
  readonly storeWrites?: { set: Record<string, unknown>; delete: string[] };
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Pinned `formatOutput` (:262–295): multi-text layout + one console block. */
function formatOutput(output: readonly CodemodeOutputItem[]): string[] {
  const total = output.filter((item) => item.type === 'text' && !item.console).length;
  const texts: string[] = [];
  const consoleLines: string[] = [];
  let index = 0;
  for (const item of output) {
    if (item.type === 'image') {
      texts.push(`[image ${item.mimeType}]`);
    } else if (item.console) {
      consoleLines.push(item.text);
    } else {
      index++;
      texts.push(total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text);
    }
  }
  if (consoleLines.length > 0) {
    texts.push(`<console_output>\n${consoleLines.join('\n')}\n</console_output>`);
  }
  return texts;
}

/** Pinned `truncateOutput` head/tail split (:427–456), text-only (no temp spill here). */
export function truncateScriptOutput(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const budget = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= budget) return { text, truncated: false };
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = text.length - headChars - tailChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : '';
  return {
    text:
      `Warning: truncated output (original token count: ${Math.ceil(text.length / CHARS_PER_TOKEN)})\n` +
      `Total output lines: ${text.split('\n').length}\n\n` +
      `${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`,
    truncated: true,
  };
}

function formatCallSummary(calls: readonly CodemodeNestedCall[]): string {
  if (calls.length === 0) return 'No tool calls were made.';
  return `Tool calls made before the failure (they are not undone): ${calls
    .map((call) => `${call.name} (${call.status})`)
    .join(', ')}`;
}

function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: readonly CodemodeNestedCall[]): string {
  const { error } = result;
  const head =
    error.kind === 'script'
      ? (error.stack ?? `${error.name ?? 'Error'}: ${error.message}`)
      : error.kind === 'timeout'
        ? `Script timed out: ${error.message}`
        : error.kind === 'aborted'
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`;
  return `${head}\n\n${formatCallSummary(calls)}`;
}

/**
 * Execute one script. The sandbox sees ONLY the injected tools; every nested
 * call goes through `invoker.invoke` (the gateway).
 */
export async function executeCodemodeScript(input: CodemodeExecuteInput): Promise<CodemodeToolOutput> {
  const startedAt = performance.now();
  const { code, options: sourceOptions } = parseCodemodeSource(input.code);

  const nested = createNestedCodemodeTools({
    parentToolCallId: input.parentToolCallId,
    tools: input.callableTools,
    invoker: input.invoker,
    onCallsChanged: input.onCallsChanged,
  });

  const sandboxOptions: CodemodeSandboxBaseOptions = {
    tools: nested.sandboxTools,
    timeoutMs: sourceOptions.timeoutMs ?? input.timeoutMs ?? Number.POSITIVE_INFINITY,
    memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
    // Bundled-daemon support: the worker file must exist beside the host chunk
    // (the source tree resolves it next to pi-codemode's dist automatically).
    ...(input.workerUrl ? { workerUrl: input.workerUrl } : {}),
  };

  let result: CodemodeResult;
  if (input.sandboxMode === 'inline') {
    const sandbox = new InlineCodemodeSandbox({ ...sandboxOptions, wasm: loadQuickJSWasm() });
    try {
      result = await sandbox.execute(code, { signal: input.signal, store: input.store });
    } finally {
      await sandbox.close();
    }
  } else {
    const sandbox = new CodemodeSandbox(sandboxOptions);
    try {
      result = await sandbox.execute(code, { signal: input.signal, store: input.store });
    } finally {
      await sandbox.close();
    }
  }
  // Calls still marked running were cut off by script end, timeout, or abort.
  nested.settleCancelled();

  const scriptTexts = formatOutput(result.output);
  if (result.ok && result.value !== undefined) {
    // A returned value is appended like text() (pinned execute.ts :545–547).
    scriptTexts.push(valueText(result.value));
  }
  if (!result.ok) {
    scriptTexts.push(`Script error:\n${formatError(result, nested.calls)}`);
  }
  const joined = scriptTexts.join('\n');
  const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
  const header = `${result.ok ? 'Script completed' : 'Script failed'}\nWall time ${wallTime} seconds\nOutput:\n`;
  const budgeted = truncateScriptOutput(joined, input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const text = budgeted.truncated
    ? `${header}${budgeted.text}\n\n[Full output not persisted: the host owns CAS-spill (W07 zone A).]`
    : `${header}${budgeted.text}`;

  return {
    text,
    isError: !result.ok,
    calls: nested.calls,
    ...(result.ok ? { storeWrites: result.storeWrites } : {}),
  };
}
