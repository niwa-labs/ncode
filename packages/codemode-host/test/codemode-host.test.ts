// W07 part B — codemode sandbox host on @earendil-works/pi-codemode:
// U21 (QuickJS capability sandbox: no ambient Node/fetch; parallel to the OS
// sandbox, plan :451/:775), out-of-context nested tool calls through the ONE
// gateway invoker, the W04 tool contract on the codemode RuntimeTool (U22:
// structuredContent/isError/details; plan :775), and deterministic replay with
// distinct safe/never verdicts (plan :185/:775).

import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';

import {
  CODEMODE_TOOL_NAME,
  createCodemodeRuntimeTool,
  executeCodemodeScript,
  type CallableToolDeclaration,
  type NestedToolInvoker,
} from '../src/index.js';
import { classifyReplay, replayRecording, startRecordingRun } from '../src/replay.js';
import { CodemodeSandbox, InlineCodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode';

const ECHO_TOOL: CallableToolDeclaration = {
  name: 'echo',
  description: 'Returns the input text back.',
  inputSchema: Type.Object({ text: Type.String() }),
};

/** A gateway-backed invoker: records every call — the ONE executeTool funnel. */
function makeInvoker(
  outcomes: Map<string, () => Partial<ToolResult>> = new Map(),
): { invoker: NestedToolInvoker; invoked: { name: string; args: unknown }[] } {
  const invoked: { name: string; args: unknown }[] = [];
  let counter = 0;
  const fallback = (toolArgs: unknown): Partial<ToolResult> => {
    const args = toolArgs as { text?: string } | undefined;
    return { text: `echo:${JSON.stringify(args?.['text' as keyof typeof args] ?? toolArgs)}` };
  };
  const invoker: NestedToolInvoker = {
    async invoke(name, args) {
      invoked.push({ name, args });
      counter += 1;
      const produce = outcomes.get(name) ?? (() => fallback(args));
      const partial = produce();
      return {
        toolCallId: `nested-${counter}`,
        isError: partial.isError ?? false,
        result: {
          tool_name: name,
          text: partial.text ?? '',
          content: partial.content ?? [{ type: 'text', text: partial.text ?? '' }],
          ...(partial.structuredContent !== undefined ? { structuredContent: partial.structuredContent } : {}),
        },
      };
    },
  };
  return { invoker, invoked };
}

describe('U21: QuickJS capability sandbox (no ambient Node/fetch)', () => {
  it('scripts have no ambient process, require, fetch, or network', async () => {
    const { invoker, invoked } = makeInvoker();
    const output = await executeCodemodeScript({
      code: `
        const probes = { process: typeof process, require: typeof require, fetch: typeof fetch,
          globalThis_keys: Object.keys(globalThis).filter((k) => ["process","require","fetch","Buffer","import"].includes(k)).length };
        return probes;
      `,
      parentToolCallId: 'u21-1',
      callableTools: [ECHO_TOOL],
      invoker,
      sandboxMode: 'inline',
    });
    expect(output.isError).toBe(false);
    // The sandbox returns compact JSON: no ambient Node/fetch globals at all.
    expect(output.text).toContain('"process":"undefined"');
    expect(output.text).toContain('"require":"undefined"');
    expect(output.text).toContain('"fetch":"undefined"');
    expect(output.text).toContain('"globalThis_keys":0');
    expect(invoked).toEqual([]);
  });

  it('only the injected tools are callable; unknown calls fail inside the sandbox', async () => {
    const { invoker, invoked } = makeInvoker();
    const output = await executeCodemodeScript({
      code: 'return typeof tools.echo;',
      parentToolCallId: 'u21-2',
      callableTools: [ECHO_TOOL],
      invoker,
      sandboxMode: 'inline',
    });
    expect(output.text).toContain('function');
    const missing = await executeCodemodeScript({
      code: 'return tools.not_injected;',
      parentToolCallId: 'u21-3',
      callableTools: [ECHO_TOOL],
      invoker,
      sandboxMode: 'inline',
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Script error');
  });

  it('a runaway CPU-bound script hits the interrupt budget instead of hanging the host', async () => {
    // Inline execution blocks the event loop. A small poll budget exercises the
    // real interrupt path without depending on how quickly CI reaches the default.
    const interruptBudget = 1_000;
    const sandbox = new InlineCodemodeSandbox({ interruptBudget, wasm: loadQuickJSWasm() });
    try {
      const result = await sandbox.execute('while (true) {}');
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'timeout', message: `Execution exceeded its interrupt budget of ${interruptBudget}` },
      });
    } finally {
      await sandbox.close();
    }
  }, 20000);
});

describe('out-of-context nested tool calls', () => {
  it('nested calls go through the invoker; their results do NOT reach the model — only script output does', async () => {
    const { invoker, invoked } = makeInvoker();
    const output = await executeCodemodeScript({
      code: "const a = await tools.echo({ text: 'one' }); const b = await tools.echo({ text: 'two' }); return `${a}+${b}`;",
      parentToolCallId: 'parent-1',
      callableTools: [ECHO_TOOL],
      invoker,
      sandboxMode: 'inline',
    });
    expect(invoked.map((call) => call.name)).toEqual(['echo', 'echo']);
    expect(output.text).toContain('Script completed');
    // Only the script's return value is in the model-visible text; the nested
    // tool outputs appear exactly once (inside the returned string).
    expect(output.text).toContain('echo:"one"+echo:"two"');
    expect(output.text).not.toContain('==> text 2/');
    // Nested call records are bounded and gateway-assigned.
    expect(output.calls).toHaveLength(2);
    expect(output.calls[0]).toMatchObject({ name: 'echo', status: 'ok', id: 'nested-1' });
  });

  it('outputSchema tools resolve structuredContent to the script; other tools resolve text; failed calls reject', async () => {
    const structuredTool: CallableToolDeclaration = {
      name: 'lookup',
      description: 'Returns a record.',
      outputSchema: Type.Object({ value: Type.Number() }),
    };
    const outcomes = new Map<string, () => Partial<ToolResult>>([
      ['lookup', () => ({ text: 'ignored-by-script', structuredContent: { value: 7 } })],
      ['echo', () => ({ text: 'plain-text' })],
      ['failing', () => ({ text: 'tool exploded', isError: true })],
    ]);
    const { invoker } = makeInvoker(outcomes);
    const output = await executeCodemodeScript({
      code: `
        const viaSchema = await tools.lookup({});
        const viaText = await tools.echo({ text: 'x' });
        let rejection = '';
        try { await tools.failing({}); } catch (error) { rejection = String(error.message); }
        return { viaSchema, viaText, rejection };
      `,
      parentToolCallId: 'parent-2',
      callableTools: [structuredTool, ECHO_TOOL, { name: 'failing', description: 'always fails' }],
      invoker,
      sandboxMode: 'inline',
    });
    expect(output.isError).toBe(false);
    // outputSchema tool -> structuredContent {value:7}; text tool -> plain text.
    expect(output.text).toContain('"viaSchema":{"value":7}');
    expect(output.text).toContain('"viaText":"plain-text"');
    expect(output.text).toContain('"rejection":"tool exploded"');
  });

  it('a failed script keeps its partial output and reports nested calls made before the failure', async () => {
    const { invoker } = makeInvoker();
    const output = await executeCodemodeScript({
      code: "await tools.echo({ text: 'before' }); throw new Error('script blew up');",
      parentToolCallId: 'parent-3',
      callableTools: [ECHO_TOOL],
      invoker,
      sandboxMode: 'inline',
    });
    expect(output.isError).toBe(true);
    expect(output.text).toContain('Script failed');
    // Partial output is preserved by design; this script produced no text()
    // items, so the partial output is the nested-call failure summary.
    expect(output.text).toContain('Tool calls made before the failure');
    expect(output.text).toContain('script blew up');
    expect(output.calls).toHaveLength(1);
    expect(output.calls[0]?.status).toBe('ok');
  });

  it('blocked nested calls (invoker throws) settle the record and fail the script call', async () => {
    const invoker: NestedToolInvoker = {
      invoke: async () => {
        throw new Error('Permission denied by policy');
      },
    };
    const output = await executeCodemodeScript({
      code: "try { await tools.echo({}); } catch (e) { return 'caught: ' + e.message; }",
      parentToolCallId: 'parent-4',
      callableTools: [ECHO_TOOL],
      invoker,
      sandboxMode: 'inline',
    });
    expect(output.text).toContain('caught: Permission denied by policy');
  });

  it('store() writes come back; load() reads the injected store', async () => {
    const { invoker } = makeInvoker();
    const output = await executeCodemodeScript({
      code: "const prior = load('k'); store('k', (prior ?? 0) + 1); return load('k');",
      parentToolCallId: 'parent-5',
      callableTools: [ECHO_TOOL],
      invoker,
      store: { k: 41 },
      sandboxMode: 'inline',
    });
    expect(output.text).toContain('42');
    expect(output.storeWrites).toEqual({ set: { k: 42 }, delete: [] });
  });
});

describe('U22: the codemode RuntimeTool honors the W04 tool contract', () => {
  it('result carries tool_name/text/content/details.calls and isError, never structuredContent to the model', async () => {
    const { invoker } = makeInvoker();
    const tool = createCodemodeRuntimeTool({
      resolveCallableTools: () => [ECHO_TOOL],
      invoker,
      sandboxMode: 'inline',
      readStore: () => ({}),
    });
    expect(tool.def.name).toBe(CODEMODE_TOOL_NAME);
    const result = await tool.impl.execute(
      { sessionId: 's', turnId: 't', toolCallId: 'call-77' },
      { code: "await tools.echo({ text: 'x' }); return 'done';" },
      undefined,
    );
    expect(result.tool_name).toBe('codemode');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined(); // no outputSchema declared
    expect(result.content[0]?.type).toBe('text');
    expect(result.text).toContain('Script completed');
    const details = result.details as { calls: { id: string }[] };
    expect(details.calls).toHaveLength(1);
  });

  it('a failing script surfaces isError=true through the contract', async () => {
    const { invoker } = makeInvoker();
    const tool = createCodemodeRuntimeTool({
      resolveCallableTools: () => [],
      invoker,
      sandboxMode: 'inline',
    });
    const result = await tool.impl.execute(
      { sessionId: 's', turnId: 't', toolCallId: 'call-78' },
      { code: 'throw new Error("nope");' },
      undefined,
    );
    expect(result.isError).toBe(true);
  });
});

describe('U22: deterministic replay (safe/never; zero gateway invocation) — plan :185/:775', () => {
  it('replays a recorded script with ZERO gateway invocations and an identical result', async () => {
    let invocations = 0;
    const recordingSandbox = new InlineCodemodeSandbox({ wasm: (await import('@earendil-works/pi-codemode')).loadQuickJSWasm() });
    const { recording } = startRecordingRun(
      recordingSandbox,
      "const a = await tools.echo({ text: 'r' }); return a + '!';",
      [ECHO_TOOL],
      async (call) => {
        invocations += 1;
        return { ok: true, value: `echo:${(call.args as { text: string }).text}` };
      },
      { startedAt: 1_000, seed: 42 },
    );
    const record = await recording;
    expect(record.calls).toHaveLength(1);
    await recordingSandbox.close();

    expect(classifyReplay(record, [ECHO_TOOL])).toEqual({ kind: 'safe' });
    const replaySandbox = new InlineCodemodeSandbox({ wasm: (await import('@earendil-works/pi-codemode')).loadQuickJSWasm() });
    const outcome = await replayRecording(replaySandbox, record, [ECHO_TOOL]);
    await replaySandbox.close();
    expect(outcome.verdict).toEqual({ kind: 'safe' });
    expect(outcome.result?.ok).toBe(true);
    if (outcome.result?.ok) {
      expect(outcome.result.value).toBe('echo:r!');
    }
    expect(invocations).toBe(1); // recorded once; replay executed nothing
  });

  it('a call without a recorded outcome is replay-never with reason tool-outcome-unknown', () => {
    const verdict = classifyReplay({
      code: 'await tools.echo({})',
      startedAt: 0,
      seed: 0,
      declaredTools: [{ name: 'echo', jsName: 'echo' }],
      declaredGlobals: [],
      calls: [
        // biome-ignore lint/suspicion/noExplicitAny: deliberate partial record
        { id: 1, target: 'tool', name: 'echo', args: {}, outcome: undefined as never },
      ],
    });
    expect(verdict).toEqual({ kind: 'never', reason: 'tool-outcome-unknown' });
  });

  it('declaration drift (renamed/missing tool) is replay-never', () => {
    const verdict = classifyReplay(
      {
        code: 'x',
        startedAt: 0,
        seed: 0,
        declaredTools: [{ name: 'echo', jsName: 'echo' }],
        declaredGlobals: [],
        calls: [],
      },
      [{ name: 'renamed-echo', description: 'moved' }],
    );
    expect(verdict).toEqual({ kind: 'never', reason: 'declaration-drift' });
  });

  it('the worker sandbox executes the same script surface (off-thread mode)', async () => {
    const { invoker, invoked } = makeInvoker();
    const output = await executeCodemodeScript({
      code: "return await tools.echo({ text: 'worker' });",
      parentToolCallId: 'w-1',
      callableTools: [ECHO_TOOL],
      invoker,
      sandboxMode: 'worker',
    });
    expect(output.isError).toBe(false);
    expect(invoked).toHaveLength(1);
    expect(output.text).toContain('echo:"worker"');
  }, 30000);
});
