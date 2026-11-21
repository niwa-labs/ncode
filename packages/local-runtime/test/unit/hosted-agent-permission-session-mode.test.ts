import { describe, expect, it, vi } from 'vitest';

import { createHostedAgentPermissionCapabilities } from '../../src/api/hosted-agent-permission-capabilities.js';
import type { LocalPermissionRouteContext } from '../../src/api/routes/permissions.js';
import type { LocalSessionPermissionModeEntry } from '../../src/permissions/session-permission-mode-port.js';

interface Harness {
  capabilities: ReturnType<typeof createHostedAgentPermissionCapabilities>;
  checkPermission: ReturnType<typeof vi.fn>;
  entries: Map<string, LocalSessionPermissionModeEntry>;
}

function harness(configPermissionMode: string, entries: Map<string, LocalSessionPermissionModeEntry>): Harness {
  const checkPermission = vi.fn(async () => ({ behavior: 'allow' as const, reason: 'test' }));
  const ctx = {
    configGetter: () => ({ permissionMode: configPermissionMode }),
    permissionService: { checkPermission },
  } as unknown as LocalPermissionRouteContext;
  const capabilities = createHostedAgentPermissionCapabilities({
    permissionRouteContext: () => ctx,
    supportsInteraction: () => false,
    sessionPermissionModes: { get: (sessionId: string) => entries.get(sessionId) },
  });
  return { capabilities, checkPermission, entries };
}

const ask = {
  sessionId: 's1',
  agentName: 'mavis',
  toolName: 'bash',
  toolInput: { command: 'python3 -c "print(1)"' },
};

describe('hosted permission seam per-session mode chain (§2.4 / S0-7)', () => {
  it('non-acp-sessions-unchanged: without a registry entry the process config fills the override', async () => {
    const { capabilities, checkPermission } = harness('bypassPermissions', new Map());
    await capabilities.decisions.check(ask);
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ permissionModeOverride: 'bypassPermissions' }),
    );
  });

  it('a session entry replaces the config fallback entirely', async () => {
    const entries = new Map([['s1', { mode: 'default', locked: false, origin: 'new-explicit' }]]);
    const { capabilities, checkPermission } = harness('bypassPermissions', entries);
    await capabilities.decisions.check(ask);
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionModeOverride: 'default',
        sessionPermissionMode: 'default',
      }),
    );
  });

  it('an explicit caller override applies only when stricter than the session mode', async () => {
    const entries = new Map([
      ['s1', { mode: 'default', locked: false, origin: 'new-explicit' }],
      ['s2', { mode: 'bypassPermissions', locked: false, origin: 'new-explicit' }],
    ]);
    const { capabilities, checkPermission } = harness('default', entries);
    // Weaker override under a default session is dropped (strictness: default > auto > bypass).
    await capabilities.decisions.check({ ...ask, permissionMode: 'bypassPermissions' });
    expect(checkPermission).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionModeOverride: 'default' }),
    );
    // A stricter override than the session mode still applies.
    await capabilities.decisions.check({ ...ask, sessionId: 's2', permissionMode: 'default' });
    expect(checkPermission).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionModeOverride: 'default', sessionPermissionMode: 'bypassPermissions' }),
    );
  });
});

describe('hosted permission seam bypass-immune passthrough (§3 review gaps)', () => {
  function immuneHarness(askDecision: Record<string, unknown>) {
    const checkPermission = vi.fn(async () => ({ behavior: 'ask' as const, reason: 'test', ...askDecision }));
    const begin = vi.fn(() => ({ promise: Promise.resolve('deny' as const) }));
    const ctx = {
      configGetter: () => ({ permissionMode: 'default' }),
      permissionService: { checkPermission },
      approvalService: { begin },
    } as unknown as LocalPermissionRouteContext;
    const capabilities = createHostedAgentPermissionCapabilities({
      permissionRouteContext: () => ctx,
      supportsInteraction: () => true,
    });
    return { capabilities, begin };
  }

  it('decisions.check ask mapping carries bypassImmune to the gate', async () => {
    const flagged = immuneHarness({ bypassImmune: true });
    const flaggedDecision = await flagged.capabilities.decisions.check(ask);
    expect(flaggedDecision).toMatchObject({ behavior: 'ask', bypassImmune: true });

    const plain = immuneHarness({});
    const plainDecision = await plain.capabilities.decisions.check(ask);
    expect(plainDecision).toMatchObject({ behavior: 'ask' });
    expect('bypassImmune' in plainDecision).toBe(false);
  });

  it('approval.request forwards bypassImmune so the ask loses its always-options', async () => {
    const { capabilities, begin } = immuneHarness({});
    await capabilities.approval.request({
      sessionId: 's1',
      turnId: 't1',
      agentName: 'mavis',
      toolName: 'bash',
      toolInput: { command: 'shred /dev/sda' },
      reason: 'test',
      ruleContents: ['shred /dev/sda'],
      bypassImmune: true,
    });
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({ bypassImmune: true }),
      undefined,
    );

    await capabilities.approval.request({
      sessionId: 's1',
      turnId: 't2',
      agentName: 'mavis',
      toolName: 'bash',
      toolInput: { command: 'python3 -c "print(1)"' },
      reason: 'test',
      ruleContents: [],
    });
    expect(begin).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ bypassImmune: true }),
      undefined,
    );
  });
});

describe('hosted permission seam §4 attribution passthrough', () => {
  it('decisions.check carries decidedBy/ruleKind/mode on every behavior', async () => {
    for (const [label, behavior] of [
      ['allow', 'allow'],
      ['deny', 'deny'],
      ['ask', 'ask'],
    ] as const) {
      const checkPermission = vi.fn(async () => ({
        behavior,
        reason: 'test',
        decidedBy: 'rule' as const,
        ruleKind: 'global' as const,
        mode: 'default' as const,
      }));
      const ctx = {
        configGetter: () => ({ permissionMode: 'default' }),
        permissionService: { checkPermission },
      } as unknown as LocalPermissionRouteContext;
      const capabilities = createHostedAgentPermissionCapabilities({
        permissionRouteContext: () => ctx,
        supportsInteraction: () => false,
      });
      const decision = await capabilities.decisions.check(ask);
      expect(decision, label).toMatchObject({
        behavior,
        decidedBy: 'rule',
        ruleKind: 'global',
        mode: 'default',
      });
    }
  });

  it('decisions.check omits attribution when the facade did not produce one', async () => {
    const checkPermission = vi.fn(async () => ({ behavior: 'allow' as const, reason: 'test' }));
    const ctx = {
      configGetter: () => ({ permissionMode: 'default' }),
      permissionService: { checkPermission },
    } as unknown as LocalPermissionRouteContext;
    const capabilities = createHostedAgentPermissionCapabilities({
      permissionRouteContext: () => ctx,
      supportsInteraction: () => false,
    });
    const decision = await capabilities.decisions.check(ask);
    expect(decision).toMatchObject({ behavior: 'allow' });
    expect('decidedBy' in decision).toBe(false);
  });
});
