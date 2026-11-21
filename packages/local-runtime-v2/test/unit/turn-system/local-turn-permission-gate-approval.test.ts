/**
 * The gate maps an approval reply to proceed/block by naming the deny
 * decisions, so a deny decision missing from that check would run the tool.
 * Pin every reply: both deny decisions block, both allow decisions proceed.
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalTurnPermissionGate } from '../../../src/service/turn-system/agent-host/runner/policy/local-turn-permission-gate.js';

type Reply = 'allowOnce' | 'allowAlways' | 'deny' | 'denyAlways';

async function gateWithReply(reply: Reply) {
  const request = vi.fn(async () => reply);
  const gate = new LocalTurnPermissionGate({
    decisions: { check: async () => ({ behavior: 'ask', reason: 'Network call needs approval' }) },
    approval: { request },
  });
  const result = await gate.beforeToolCall({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    agentName: 'mcode',
    model: 'model-1',
    toolContext: {
      toolCall: { id: 'call-1', name: 'mcp_fetch', source: 'mcp' },
      args: { url: 'https://example.com' },
    } as never,
  });
  return { result, request };
}

describe('LocalTurnPermissionGate approval reply mapping', () => {
  it.each(['deny', 'denyAlways'] as const)('%s blocks the tool call', async (reply) => {
    const { result, request } = await gateWithReply(reply);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
    expect(result?.reason).toContain('Permission denied by user for mcp_fetch');
  });

  it.each(['allowOnce', 'allowAlways'] as const)('%s lets the tool call proceed', async (reply) => {
    const { result, request } = await gateWithReply(reply);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });
});
