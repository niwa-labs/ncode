import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';

import type { RuntimeTool } from '@mavis/agent-core/tools';
import { buildLocalTurnToolCatalog } from './local-turn-tool-catalog.js';

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

describe('external-tools-only catalog policy', () => {
  it('suppresses run_code and plugin runtime tools', () => {
    const app = tool('app_notes_search');
    const sources = {
      nativeTools: [],
      mcpEntries: [
        { tool: tool('mcp__harness__submit_answer'), source: 'configured' as const, serverName: 'harness' },
      ],
      threadGoalTools: [],
      cuRuntimeAvailable: false,
    };
    const desktopCapabilities = {
      revision: 'r1',
      plugins: [{ name: 'notes', source: 'local', appProviders: ['notes-app'] }],
      skills: [],
      runtimeTools: [app],
      runtimeToolBindings: [
        { kind: 'app', source: 'notes-app', toolMode: 'tool_search', tool: app },
      ],
    };

    const restricted = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: model,
      sources: { ...sources, externalToolsOnly: true },
      beta: { runCode: true },
      desktopCapabilities,
    });
    expect(restricted.tools.map((entry) => entry.def.name)).toEqual([
      'mcp__harness__submit_answer',
    ]);

    // Control: without the marker the same turn keeps run_code; the plugin
    // app tool rides the default disclosure (tool_search), but run_code —
    // a native append — is present.
    const plain = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: model,
      sources,
      beta: { runCode: true },
      desktopCapabilities,
    });
    const names = plain.tools.map((entry) => entry.def.name);
    expect(names).toContain('run_code');
  });

  it('keeps harness MCP entries inline instead of deferring them', () => {
    const sources = {
      nativeTools: [],
      mcpEntries: [
        { tool: tool('mcp__harness__submit_answer'), source: 'configured' as const, serverName: 'harness' },
      ],
      threadGoalTools: [],
      cuRuntimeAvailable: false,
      externalToolsOnly: true,
    };
    // thresholdPct 0 defers any positive estimate (see the plugin test).
    const config = { enabled: true, modelWhitelist: ['*'] as string[], thresholdPct: 0 };

    const harnessScoped = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: model,
      sources,
      config,
      env: { MCODE_SESSION_MCP_ONLY: '1' },
    });
    const inline = harnessScoped.tools.map((entry) => entry.def.name);
    expect(inline).toContain('mcp__harness__submit_answer');
    expect(inline).not.toContain('tool_search');
    expect(inline).not.toContain('mcp_invoke');

    // Control: without the session scope the same options defer the entry.
    const deferred = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: model,
      sources,
      config,
      env: {},
    });
    const deferredNames = deferred.tools.map((entry) => entry.def.name);
    expect(deferredNames).not.toContain('mcp__harness__submit_answer');
    expect(deferredNames).toContain('tool_search');
  });
});
