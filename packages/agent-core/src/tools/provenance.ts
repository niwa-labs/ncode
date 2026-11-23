/**
 * Session-scoped MCP provenance for RuntimeTools.
 *
 * The model-visible tool name is a PROJECTION (`mcp__<normalized>__<tool>`):
 * server identities are normalized, shortened and collision-disambiguated, so
 * a raw server string can never be matched against a prefix of the projected
 * name. Hosts that know the real server behind a tool (the ready MCP
 * inventory, plugin-host MCP bindings) stamp it here; dispatch-time policy
 * checks read the stamp and never guess from the name.
 */

import type { RuntimeTool } from './types.js';

const MCP_SERVER_PROVENANCE = Symbol('mcpServerProvenance');

export interface RuntimeToolMcpProvenance {
  /** The configured server name (the `mcpServers` key), not a projection. */
  readonly server: string;
}

/** Stamps `tool` (in place) with the configured MCP server it comes from. */
export function attachRuntimeToolMcpServer(
  tool: RuntimeTool,
  server: string,
): RuntimeTool {
  Object.defineProperty(tool, MCP_SERVER_PROVENANCE, {
    value: { server } satisfies RuntimeToolMcpProvenance,
    // Attribution and execution decorators copy RuntimeTools with object spread.
    enumerable: true,
    writable: false,
    configurable: true,
  });
  return tool;
}

/** The configured MCP server behind `tool`, when its host stamped one. */
export function runtimeToolMcpServerOf(tool: RuntimeTool): string | undefined {
  const stamped = tool as RuntimeTool & {
    readonly [MCP_SERVER_PROVENANCE]?: RuntimeToolMcpProvenance;
  };
  return stamped[MCP_SERVER_PROVENANCE]?.server;
}
