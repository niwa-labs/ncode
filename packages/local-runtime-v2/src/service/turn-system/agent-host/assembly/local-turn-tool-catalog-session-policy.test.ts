import { describe, expect, it, vi } from 'vitest';
import type { CodemodeRuntimeToolDeps } from '@mavis/codemode-host';
import { Type } from '@sinclair/typebox';

import { runtimeToolMcpServerOf, type RuntimeTool } from '@mavis/agent-core/tools';
import {
  createSessionToolPolicyRegistry,
  sessionToolPolicyAllowsTool,
} from '../../../permission/session-tool-policy.js';
import {
  buildLocalTurnToolCatalog,
  filterLocalTurnCapabilityInventory,
} from './local-turn-tool-catalog.js';

// Keep the production catalog and invoker. Feed a single synthetic child call
// at the sandbox boundary so the test needs no bundled worker.
vi.mock('@mavis/codemode-host', () => ({
  createCodemodeRuntimeTool: ({ invoker }: CodemodeRuntimeToolDeps) => ({
    impl: {
      async execute(_ctx: unknown, { code }: { code: string }) {
        const { name, args } = JSON.parse(code);
        return (await invoker.invoke(name, args)).result;
      },
    },
  }),
}));

function tool(name: string): RuntimeTool {
  return {
    def: { name, description: 'Synthetic test tool', schema: Type.Object({}) },
    impl: {
      execute: async () => ({
        tool_name: name,
        text: 'ok',
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
    },
  };
}

const model = { provider: 'synthetic', id: 'offline', contextWindow: 128_000 };

const sources = {
  nativeTools: [tool('read'), tool('bash'), tool('write')],
  mcpEntries: [
    {
      tool: tool('mcp__harness__submit_answer'),
      source: 'configured' as const,
      serverName: 'harness',
    },
    {
      tool: tool('mcp__project__read_file'),
      source: 'configured' as const,
      serverName: 'project',
    },
    {
      tool: tool('mcp__anonymous__orphan'),
      source: 'configured' as const,
    },
    {
      tool: tool('images_understand'),
      source: 'builtin-matrix' as const,
    },
  ],
  threadGoalTools: [tool('update_goal')],
  cuRuntimeAvailable: false,
};

/** A plugin-host capability view: one app tool and one MCP server binding. */
function desktopCapabilities() {
  const app = tool('app_notes_search');
  const harnessTool = tool('mcp__harness__lookup');
  return {
    revision: 'r1',
    plugins: [{ name: 'notes', source: 'local', appProviders: ['notes-app'] }],
    skills: [],
    runtimeTools: [app, harnessTool],
    runtimeToolBindings: [
      { kind: 'app' as const, source: 'notes-app', toolMode: 'tool_search' as const, tool: app },
      { kind: 'mcp' as const, source: 'harness', toolMode: 'tool_search' as const, tool: harnessTool },
    ],
  };
}

/** The filtered inventory is the frozen view the turn catalog and Task capture share. */
function inventoryOf(input: Parameters<typeof filterLocalTurnCapabilityInventory>[0]) {
  return filterLocalTurnCapabilityInventory(input);
}

function inventoryNames(input: Parameters<typeof filterLocalTurnCapabilityInventory>[0]) {
  const inventory = inventoryOf(input);
  return {
    native: inventory.nativeTools.map((entry) => entry.def.name),
    mcp: inventory.mcpEntries.map(({ tool: entry }) => entry.def.name),
    goal: inventory.threadGoalTools.map((entry) => entry.def.name),
    desktop: inventory.desktopCapabilities?.runtimeTools.map((entry) => entry.def.name) ?? [],
  };
}

describe('session tool policy catalog exposure', () => {
  it('keeps the allowed built-ins and only the session-supplied servers', () => {
    const names = inventoryNames({
      sources,
      builtinToolAllowlist: new Set(['read']),
      builtinToolServers: new Set(['harness']),
    });
    expect(names.native).toEqual(['read']);
    expect(names.goal).toEqual([]);
    // The supplied server's tool stays; the ambient project server and the
    // provenance-less entry fail closed; the unnamed Matrix tool is gone.
    expect(names.mcp).toEqual(['mcp__harness__submit_answer']);
  });

  it('a named Builtin Matrix tool stays while its siblings go', () => {
    const names = inventoryNames({
      sources,
      builtinToolAllowlist: new Set(['images_understand']),
      builtinToolServers: new Set(['harness']),
    });
    expect(names.native).toEqual([]);
    expect(names.mcp).toEqual(['mcp__harness__submit_answer', 'images_understand']);
  });

  it('no allowlist keeps the legacy inventory, ambient servers included', () => {
    const names = inventoryNames({ sources });
    expect(names.native).toEqual(['read', 'bash', 'write']);
    expect(names.mcp).toEqual([
      'mcp__harness__submit_answer',
      'mcp__project__read_file',
      'mcp__anonymous__orphan',
      'images_understand',
    ]);
    expect(names.goal).toEqual(['update_goal']);
  });

  it('an empty allowlist with no supplied servers exposes none of its own tools', () => {
    const catalog = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: model,
      sources,
      beta: { runCode: true },
      builtinToolAllowlist: new Set([]),
      builtinToolServers: new Set([]),
    });
    expect(catalog.tools.map((entry) => entry.def.name)).toEqual([]);
  });

  it('the run_code gate obeys the policy; legacy keeps it', () => {
    const restricted = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: model,
      sources: { ...sources, mcpEntries: [] },
      beta: { runCode: true },
      builtinToolAllowlist: new Set(['read', 'run_code']),
    });
    const restrictedNames = restricted.tools.map((entry) => entry.def.name);
    expect(restrictedNames).toContain('run_code');

    const unnamed = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: model,
      sources: { ...sources, mcpEntries: [] },
      beta: { runCode: true },
      builtinToolAllowlist: new Set(['read']),
    });
    expect(unnamed.tools.map((entry) => entry.def.name)).not.toContain('run_code');

    const legacy = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: model,
      sources: { ...sources, mcpEntries: [] },
      beta: { runCode: true },
    });
    expect(legacy.tools.map((entry) => entry.def.name)).toContain('run_code');
  });

  it('checks each child against the current session policy through run_code', async () => {
    const registry = createSessionToolPolicyRegistry();
    const sessionId = 'viewer';
    registry.bind(sessionId, ['read', 'write', 'run_code'], 'new-explicit', ['view', 'modify']);
    registry.bind('other', ['write'], 'new-explicit', ['modify']);
    const allowed = registry.get(sessionId)!;
    const view = tool('mcp__view__open_clip');
    const modify = tool('mcp__modify__replace_clip');
    const write = tool('write');
    const modifyHandler = vi.spyOn(modify.impl, 'execute');
    const writeHandler = vi.spyOn(write.impl, 'execute');
    const catalog = buildLocalTurnToolCatalog({
      sessionId,
      llmModel: model,
      sources: {
        ...sources,
        nativeTools: [tool('read'), write],
        mcpEntries: [
          { tool: view, source: 'configured', serverName: 'view' },
          { tool: modify, source: 'configured', serverName: 'modify' },
        ],
      },
      config: { modelWhitelist: ['*'], thresholdPct: 0 },
      env: {},
      beta: { runCode: true },
      builtinToolAllowlist: allowed.allow,
      builtinToolServers: allowed.servers,
      liveSessionToolPolicy: (target) => sessionToolPolicyAllowsTool(registry.get(sessionId)!, target),
    });
    const runner = catalog.tools.find((entry) => entry.def.name === 'run_code')!;
    const call = (name: string, args: object = {}) =>
      runner.impl.execute(
        { sessionId, turnId: 'synthetic-turn' },
        { code: JSON.stringify({ name, args }) } as never,
      );

    registry.bind(sessionId, ['read', 'run_code'], 'load-explicit', ['view']);
    expect((await call('read', { file_path: 'synthetic.mp4' })).tool_name).toBe('read');
    await expect(call('write')).rejects.toThrow('session');
    expect(
      (await call('mcp_invoke', { tool_name: view.def.name })).tool_name,
    ).toBe(view.def.name);
    expect(
      (await call('mcp_invoke', { tool_name: modify.def.name })).isError,
    ).toBe(true);
    expect(modifyHandler).not.toHaveBeenCalled();
    expect(writeHandler).not.toHaveBeenCalled();
    expect(registry.get('other')?.allow.has('write')).toBe(true);
  });

  it('restricted plugin-host surface keeps only the session-supplied server bindings', () => {
    const restricted = inventoryOf({
      sources: { ...sources, nativeTools: [] },
      builtinToolAllowlist: new Set([]),
      builtinToolServers: new Set(['harness']),
      desktopCapabilities: desktopCapabilities(),
    });
    expect(restricted.desktopCapabilities?.runtimeTools.map((entry) => entry.def.name)).toEqual([
      'mcp__harness__lookup',
    ]);
    expect(
      restricted.desktopCapabilities?.runtimeToolBindings.map((binding) => binding.kind),
    ).toEqual(['mcp']);

    // Legacy keeps the whole plugin-host surface.
    const legacy = inventoryOf({
      sources: { ...sources, nativeTools: [] },
      desktopCapabilities: desktopCapabilities(),
    });
    expect(
      legacy.desktopCapabilities?.runtimeTools.map((entry) => entry.def.name).sort(),
    ).toEqual(['app_notes_search', 'mcp__harness__lookup']);
  });

  it('kept MCP tools carry their RAW server identity as the dispatch provenance', () => {
    const stampedSources = {
      ...sources,
      mcpEntries: [
        {
          tool: tool('mcp__my_server__submit_answer'),
          source: 'configured' as const,
          serverName: 'my server',
        },
      ],
    };
    const inventory = inventoryOf({
      sources: stampedSources,
      builtinToolAllowlist: new Set([]),
      builtinToolServers: new Set(['my server']),
    });
    // The stamp holds the CONFIGURED server name, not the projected segment:
    // dispatch matches it against the session's supplied-server set without
    // guessing from the mcp__-prefixed tool name.
    expect(inventory.mcpEntries).toHaveLength(1);
    expect(runtimeToolMcpServerOf(inventory.mcpEntries[0].tool)).toBe('my server');
    // Desktop MCP bindings are stamped too.
    const desktop = inventoryOf({
      sources: { ...sources, nativeTools: [] },
      builtinToolAllowlist: new Set([]),
      builtinToolServers: new Set(['harness']),
      desktopCapabilities: desktopCapabilities(),
    });
    const bindingTool = desktop.desktopCapabilities?.runtimeTools.find(
      (entry) => entry.def.name === 'mcp__harness__lookup',
    );
    expect(runtimeToolMcpServerOf(bindingTool!)).toBe('harness');
  });
});
