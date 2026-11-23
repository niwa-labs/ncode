/**
 * Dispatch-time enforcement of the per-session built-in tool policy: the
 * second, fail-closed net behind the turn catalog filter. A Session with a
 * policy entry may call exactly the built-in tools its entry names, plus the
 * tools of the MCP servers its client supplied for it.
 *
 * Provenance is read from the TOOL OBJECT, never the name: the model-visible
 * name is a projection (normalized, shortened, collision-disambiguated), so
 * the ready inventory stamps each kept MCP tool with its configured server
 * (`attachRuntimeToolMcpServer`) and this guard trusts only that stamp. A
 * name that is not part of this Turn's assembled tools is blocked outright —
 * stale or forged calls have no provenance to check.
 *
 * Host-bound calls carry the resolved target from the tool-call lifecycle.
 * Named deferred calls are checked against the gateway's turn-local registry.
 * The gateway also checks the live policy when dispatching the actual target.
 */

import type { RuntimeTool } from '@mavis/agent-core/tools';
import { resolveMcpInvokeTarget } from '@mavis/agent-tools';

import type { LocalTurnToolPolicyGuard } from '../../service/turn-system/index.js';
import {
  sessionToolPolicyAllowsTool,
  type SessionToolPolicyEntry,
  type SessionToolPolicyRegistry,
} from '../../service/permission/session-tool-policy.js';

export function createSessionToolPolicyGuard(
  registry: SessionToolPolicyRegistry,
): LocalTurnToolPolicyGuard {
  return {
    async beforeToolCall(input) {
      const policy = registry.get(input.sessionId ?? '');
      if (!policy) return undefined;
      if (input.tool) return judge(policy, input.tool);

      const name = input.toolContext.toolCall.name;
      const tool = input.tools?.find((candidate) => candidate.def.name === name);
      if (!tool) {
        return blocked(policy, name, "it is not part of this turn's tools");
      }
      if (name === 'tool_search') return undefined;
      if (name === 'mcp_invoke') {
        const resolution = resolveMcpInvokeTarget(tool, input.toolContext.args);
        if (!resolution || resolution.kind === 'error') {
          return blocked(
            policy,
            name,
            resolution?.message ?? 'the deferred gateway could not resolve the tool',
          );
        }
        return judge(policy, resolution.target);
      }
      return judge(policy, tool);
    },
  };
}

function judge(
  policy: SessionToolPolicyEntry,
  tool: RuntimeTool,
): { block: true; reason: string } | undefined {
  return sessionToolPolicyAllowsTool(policy, tool)
    ? undefined
    : blocked(policy, tool.def.name);
}

function blocked(
  policy: SessionToolPolicyEntry,
  name: string,
  detail?: string,
): { block: true; reason: string } {
  const allowed = [...policy.allow].sort().join(', ') || 'none';
  return {
    block: true,
    reason:
      `Tool "${name}" is not part of this session's tool policy (allowed: ${allowed})` +
      (detail ? `: ${detail}` : ''),
  };
}
