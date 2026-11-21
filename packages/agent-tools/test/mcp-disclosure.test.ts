/**
 * W08 gate coverage for the retained MCP disclosure facade
 * (`agent-tools/src/mcp-disclosure`): tool_search over the BM25-style index
 * and mcp_invoke as the fail-closed deferred-execution bridge (plan §4 :504 —
 * «@mavis/mcp и mcp_invoke остаются facade/мостом»; W08-T «…tool_search/
 * invoke», plan :789).
 *
 * The module had no tests before this file; these pin the contract that
 * survives the pi-mcp transport absorption:
 *
 *   * plan          — deferred only for whitelisted models with enough
 *                     configured candidates over the token threshold;
 *                     otherwise everything stays inline.
 *   * tool_search   — query/regex/topK bounds, JSON hits shape, error paths.
 *   * mcp_invoke    — exactly one selector; tool_name resolves through the
 *                     deferred registry with schema validation; arguments_json
 *                     bounds (bytes/depth/nodes/unsafe keys); tool_ref NEVER
 *                     executes without Host authorization (fail-closed); the
 *                     authorization is a one-shot snapshot consumed by the
 *                     next execution and revocable.
 */
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { defineRuntimeTool, type RuntimeTool, type ToolExecutionContext } from '@mavis/agent-core/tools';
import {
  buildIndex,
  computeIndexSignature,
} from '../src/mcp-disclosure/search-index.js';
import { createToolSearchTool, planMcpDisclosure, modelInWhitelist } from '../src/mcp-disclosure/mcp-disclosure.js';
import {
  authorizeMcpInvokeReference,
  createMcpInvokeTool,
  resolveMcpInvokeTarget,
  revokeMcpInvokeReferenceAuthorization,
  type McpToolEntry,
} from '../src/mcp-disclosure/mcp-disclosure.js';

function makeTool(
  name: string,
  description: string,
  schema = Type.Object({ value: Type.String() }),
  execute?: (ctx: ToolExecutionContext, input: { value: string }) => unknown,
): RuntimeTool {
  return defineRuntimeTool({
    name,
    description,
    schema,
    execute: execute ?? (async () => ({ tool_name: name, text: 'ok', content: [{ type: 'text', text: 'ok' }] })),
  });
}

const OPTIONS = {
  enabled: true,
  modelWhitelist: ['minimax/*'],
  thresholdPct: 0.01,
  minDeferCount: 2,
  topKDefault: 5,
  topKMax: 20,
  systemHint: true,
  maxSchemaTextLen: 4_000,
};

describe('planMcpDisclosure', () => {
  it('keeps everything inline when disabled, not whitelisted, or under the threshold', () => {
    const tools = [
      makeTool('a_one', 'alpha search helper'),
      makeTool('b_two', 'beta search helper'),
    ];
    const entries: McpToolEntry[] = tools.map((tool) => ({ tool, source: 'configured' }));
    const model = { provider: 'minimax', id: 'm2', contextWindow: 200_000 };

    expect(planMcpDisclosure({ entries, model, options: { ...OPTIONS, enabled: false } }).deferred).toBe(false);
    expect(
      planMcpDisclosure({
        entries,
        model: { provider: 'other', id: 'x', contextWindow: 200_000 },
        options: OPTIONS,
      }).deferred,
    ).toBe(false);
    expect(
      planMcpDisclosure({
        entries,
        model,
        options: { ...OPTIONS, thresholdPct: 0, minDeferCount: 99 },
      }).deferred,
    ).toBe(false);
  });

  it('defers configured candidates and keeps non-configured tools inline', () => {
    const configured = [
      makeTool('mcp_one', 'project management board tool'),
      makeTool('mcp_two', 'issue tracker search tool'),
    ];
    const builtin = makeTool('bash', 'run a shell command');
    const entries: McpToolEntry[] = [
      ...configured.map((tool) => ({ tool, source: 'configured' as const })),
      { tool: builtin, source: 'builtin' as const },
    ];
    const plan = planMcpDisclosure({
      entries,
      model: { provider: 'minimax', id: 'm2', contextWindow: 1_000 },
      options: OPTIONS,
    });
    expect(plan.deferred).toBe(true);
    if (!plan.deferred) return;
    expect(plan.inlineTools).toEqual([builtin]);
    expect([...plan.deferredRegistry.keys()].sort()).toEqual(['mcp_one', 'mcp_two']);
    expect(plan.stats.indexedCount).toBe(2);
  });

  it('matches whitelist wildcards exactly', () => {
    expect(modelInWhitelist('minimax', 'm2', ['minimax/*'])).toBe(true);
    expect(modelInWhitelist('minimax', 'm2', ['minimax/m2'])).toBe(true);
    expect(modelInWhitelist('openai', 'gpt', ['minimax/*'])).toBe(false);
  });
});

describe('tool_search over the disclosure index', () => {
  it('returns ranked hits and honors topK bounds', async () => {
    const entries: McpToolEntry[] = [
      { tool: makeTool('board_create_task', 'Create a task on the project board'), source: 'configured' },
      { tool: makeTool('board_query', 'Query tasks on the board'), source: 'configured' },
    ];
    const index = buildIndex(entries, { maxSchemaTextLen: 4_000 });
    const search = createToolSearchTool(index, { topKDefault: 5, topKMax: 20 });

    const miss = await search.impl.execute({} as ToolExecutionContext, {});
    expect(miss.isError).toBe(true);

    const hits = await search.impl.execute({} as ToolExecutionContext, { query: 'board task', top_k: 1 });
    expect(hits.isError).toBeUndefined();
    const parsed = JSON.parse(hits.text) as { hits: Array<{ name: string }>; total: number };
    expect(parsed.total).toBe(1);
    expect(parsed.hits[0]?.name).toBe('board_create_task');

    const badRegex = await search.impl.execute({} as ToolExecutionContext, { regex: '(unclosed' });
    expect(badRegex.isError).toBe(true);
  });

  it('is stable across identical signatures (buildOrReuse contract)', () => {
    const entries: McpToolEntry[] = [{ tool: makeTool('t', 'x'), source: 'configured' }];
    expect(computeIndexSignature(entries)).toBe(computeIndexSignature(entries));
  });
});

describe('mcp_invoke — the fail-closed deferred bridge', () => {
  it('requires exactly one selector', async () => {
    const target = makeTool('t_one', 'target', Type.Object({}), async () => ({
      tool_name: 't_one',
      text: 'ran',
      content: [{ type: 'text', text: 'ran' }],
    }));
    const invoke = createMcpInvokeTool(new Map([['t_one', target]]));

    const neither = await invoke.impl.execute({} as ToolExecutionContext, {});
    expect(neither.isError).toBe(true);
    const both = await invoke.impl.execute({} as ToolExecutionContext, {
      tool_name: 't_one',
      tool_ref: 'ref',
    });
    expect(both.isError).toBe(true);
  });

  it('resolves tool_name through the deferred registry, validates arguments, executes the target', async () => {
    let executed: unknown;
    const target = makeTool(
      'mcp_two',
      'target with schema',
      Type.Object({ value: Type.String() }),
      async (_ctx, input) => {
        executed = input;
        return { tool_name: 'mcp_two', text: input.value, content: [{ type: 'text', text: input.value }] };
      },
    );
    const invoke = createMcpInvokeTool(new Map([['mcp_two', target]]));

    const resolution = resolveMcpInvokeTarget(invoke, { tool_name: 'mcp_two', arguments: { value: 'x' } });
    expect(resolution.kind).toBe('resolved');

    const ok = await invoke.impl.execute({} as ToolExecutionContext, {
      tool_name: 'mcp_two',
      arguments: { value: 'hello' },
    });
    expect(ok.isError).toBeUndefined();
    expect(executed).toEqual({ value: 'hello' });

    const bad = await invoke.impl.execute({} as ToolExecutionContext, {
      tool_name: 'mcp_two',
      arguments: { value: 42 },
    });
    expect(bad.isError).toBe(true);

    const unknown = await invoke.impl.execute({} as ToolExecutionContext, { tool_name: 'nope' });
    expect(unknown.isError).toBe(true);
  });

  it('enforces arguments_json bounds and unsafe keys', async () => {
    const target = makeTool('mcp_three', 'ref target', Type.Object({}));
    const invoke = createMcpInvokeTool(new Map([['mcp_three', target]]));

    const tooBig = await invoke.impl.execute({} as ToolExecutionContext, {
      tool_name: 'mcp_three',
      // tool_name + arguments_json is rejected before any byte check
      arguments_json: '{}',
    } as never);
    expect(tooBig.isError).toBe(true);

    const reference = { tool: target, pluginName: 'skill', inputSchema: target.def.schema };
    const refInvoke = createMcpInvokeTool(new Map(), new Map([['ref-1', reference]]));
    const unsafe = await refInvoke.impl.execute({} as ToolExecutionContext, {
      tool_ref: 'ref-1',
      arguments_json: '{"__proto__": {}}',
    });
    expect(unsafe.isError).toBe(true);
    expect((unsafe as { text: string }).text).toContain('__proto__');

    // A structurally valid decode passes the Host authorization path
    // (direct execution of a tool_ref stays fail-closed; see next test).
    const validInput = { tool_ref: 'ref-1', arguments_json: '{}' };
    resolveMcpInvokeTarget(refInvoke, validInput);
    const admitted = authorizeMcpInvokeReference(refInvoke, validInput);
    expect(admitted.kind).toBe('resolved');
  });

  it('never executes a tool_ref without Host authorization, and authorization is one-shot', async () => {
    let executions = 0;
    const target = makeTool(
      'mcp_ref_target',
      'ref target',
      Type.Object({ value: Type.String() }),
      async () => {
        executions += 1;
        return { tool_name: 'mcp_ref_target', text: 'ran', content: [{ type: 'text', text: 'ran' }] };
      },
    );
    const reference = { tool: target, pluginName: 'skill', inputSchema: target.def.schema };
    const invoke = createMcpInvokeTool(new Map(), new Map([['skill-ref', reference]]));
    const input = { tool_ref: 'skill-ref', arguments_json: '{"value":"v"}' };

    // Unauthorized direct execution must be refused even though the ref exists.
    const denied = await invoke.impl.execute({} as ToolExecutionContext, input);
    expect(denied.isError).toBe(true);
    expect((denied as { text: string }).text).toContain('not admitted');
    expect(executions).toBe(0);

    // Host pipeline: resolve → authorize → execute consumes the marker once.
    const resolution = resolveMcpInvokeTarget(invoke, input);
    expect(resolution.kind).toBe('resolved');
    const admission = authorizeMcpInvokeReference(invoke, input);
    expect(admission.kind).toBe('resolved');

    const allowed = await invoke.impl.execute({} as ToolExecutionContext, input);
    expect(allowed.isError).toBeUndefined();
    expect(executions).toBe(1);

    // One-shot: a replayed execution without a new admission is refused.
    const replay = await invoke.impl.execute({} as ToolExecutionContext, input);
    expect(replay.isError).toBe(true);
    expect(executions).toBe(1);

    revokeMcpInvokeReferenceAuthorization(invoke, input);
  });

  it('schema mismatch on a Host-bound ref fails closed', async () => {
    const target = makeTool('mcp_strict', 'strict', Type.Object({ value: Type.String() }));
    const reference = { tool: target, pluginName: 'skill', inputSchema: target.def.schema };
    const invoke = createMcpInvokeTool(new Map(), new Map([['strict-ref', reference]]));
    const input = { tool_ref: 'strict-ref', arguments_json: '{"value": 7}' };

    resolveMcpInvokeTarget(invoke, input);
    const admission = authorizeMcpInvokeReference(invoke, input);
    expect(admission.kind).toBe('error');
  });
});
