/**
 * §3 "неотключаемые действия" pins at the v2 gate layer.
 *
 *   - 3.3 immune-not-hook-approvable: neither a Plugin Hook
 *     `any_prompt` auto-approval nor a compatible PreToolUse allow may
 *     answer a bypass-immune ask on the user's behalf; only the approval
 *     owner (the user) can.
 *   - approval forwarding: the immune flag rides the approval-owner input
 *     so the surfaced question is built without allow-always / deny-always
 *     (serializePermissionRequest consumes it; pinned in local-runtime).
 *   - fail-closed: without an approval owner an immune ask throws instead
 *     of proceeding — bypass never silently executes it.
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalTurnPermissionGate } from '../../../src/service/turn-system/agent-host/runner/policy/local-turn-permission-gate.js';

type GateOptions = ConstructorParameters<typeof LocalTurnPermissionGate>[0];
type ApprovalOwnerInput = Parameters<NonNullable<GateOptions['approval']>['request']>[0];

function gateInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    agentName: 'mcode',
    model: 'model-1',
    toolContext: {
      // A non-builtin tool so the built-in tool policy does not skip the
      // gate (mirrors the §1 gate approval test).
      toolCall: { id: 'call-1', name: 'mcp_fetch', source: 'mcp' },
      args: { url: 'https://evil.example.com' },
    } as never,
    ...overrides,
  };
}

function immuneAskDecision() {
  return {
    behavior: 'ask' as const,
    reason: 'Needs confirmation: command opens a raw shell/network channel',
    ruleContents: ['bash(dev/tcp:*)'],
    hookAutoApprovalEligible: true,
    bypassImmune: true as const,
  };
}

describe('LocalTurnPermissionGate bypass-immune asks', () => {
  it('3.3 any_prompt auto-approval cannot approve an immune ask', async () => {
    const request = vi.fn(async () => 'deny' as const);
    const gate = new LocalTurnPermissionGate({
      decisions: { check: async () => immuneAskDecision() },
      approval: { request },
    });
    const result = await gate.beforeToolCall(
      gateInput({
        beforeApproval: async () => ({
          behavior: 'allow' as const,
          autoApproval: 'any_prompt' as const,
        }),
      }),
    );
    // The hook's blanket allow was ignored; the user (approval owner) was
    // asked and denied, so the call is blocked.
    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
  });

  it('3.3 a compatible PreToolUse allow cannot approve an immune ask', async () => {
    const request = vi.fn(async () => 'deny' as const);
    const gate = new LocalTurnPermissionGate({
      decisions: { check: async () => immuneAskDecision() },
      approval: { request },
    });
    const result = await gate.beforeToolCall(
      gateInput({
        preToolPermission: { behavior: 'allow', reason: 'hook says fine' },
      }),
    );
    // hookAutoApprovalEligible is true on the decision, but the immune flag
    // wins: the PreToolUse allow must not let the call proceed silently.
    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
  });

  it('control: a PreToolUse allow still waives an ordinary hook-eligible ask', async () => {
    const request = vi.fn(async () => 'allowOnce' as const);
    const gate = new LocalTurnPermissionGate({
      decisions: {
        check: async () => ({
          behavior: 'ask' as const,
          reason: 'No permission rule matched for tool "bash"',
          ruleContents: ['echo hi'],
          hookAutoApprovalEligible: true,
        }),
      },
      approval: { request },
    });
    const result = await gate.beforeToolCall(
      gateInput({ preToolPermission: { behavior: 'allow' } }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('control: any_prompt still approves an ordinary ask', async () => {
    const request = vi.fn(async () => 'deny' as const);
    const gate = new LocalTurnPermissionGate({
      decisions: {
        check: async () => ({
          behavior: 'ask' as const,
          reason: 'No permission rule matched for tool "bash"',
        }),
      },
      approval: { request },
    });
    const result = await gate.beforeToolCall(
      gateInput({
        beforeApproval: async () => ({
          behavior: 'allow' as const,
          autoApproval: 'any_prompt' as const,
        }),
      }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('forwards bypassImmune to the approval owner input', async () => {
    const seen: ApprovalOwnerInput[] = [];
    const gate = new LocalTurnPermissionGate({
      decisions: { check: async () => immuneAskDecision() },
      approval: {
        request: async (input) => {
          seen.push(input);
          return 'allowOnce';
        },
      },
    });
    const result = await gate.beforeToolCall(gateInput());
    expect(result).toBeUndefined();
    expect(seen[0]?.bypassImmune).toBe(true);
  });

  it('control: ordinary asks do not carry bypassImmune to the approval owner', async () => {
    const seen: ApprovalOwnerInput[] = [];
    const gate = new LocalTurnPermissionGate({
      decisions: {
        check: async () => ({
          behavior: 'ask' as const,
          reason: 'No permission rule matched for tool "bash"',
          ruleContents: ['echo hi'],
        }),
      },
      approval: {
        request: async (input) => {
          seen.push(input);
          return 'deny';
        },
      },
    });
    await gate.beforeToolCall(gateInput());
    expect(seen[0]?.bypassImmune).toBeUndefined();
  });

  it('3.6 fail-closed: an immune ask without an approval owner blocks instead of proceeding', async () => {
    // §4 tightened the fail-closed contract: a host that cannot prompt gets
    // a per-call deny (`unanswered: no_prompt` mark, §4.1) instead of a
    // thrown hook error aborting the whole Turn. The call still never
    // proceeds.
    const gate = new LocalTurnPermissionGate({
      decisions: { check: async () => immuneAskDecision() },
    });
    const result = await gate.beforeToolCall(gateInput());
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
  });
});
