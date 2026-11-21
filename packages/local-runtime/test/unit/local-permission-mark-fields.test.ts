/**
 * §4.1/§4.2 facade attribution pins: every check-side branch of
 * `LocalPermissionFacade.checkPermission` fills `decidedBy` / `ruleKind` /
 * `mode`, the verdict ledger records the final attribution, and the §4.1
 * table rows attributable at check time (rule with scope, built-in checker
 * policy, classifier allow, mode waivers) produce the expected marks.
 *
 * The ask/hook/user/unanswered rows are attributed by the v2 turn gate and
 * pinned in local-runtime-v2 (local-turn-permission-gate-marks.test.ts).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import {
  configurePermissionHost,
  resetPermissionHostForTesting,
} from '@mavis/permission';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudClassifyVerdict, CloudGatewayClient } from '@mavis/permission';

import {
  LocalPermissionFacade,
  type LocalPermissionFacadeDeps,
} from '../../src/permissions/facade.js';
import { LocalPermissionRuleStore } from '../../src/permissions/rules.js';
import { LocalPluginHookPermissionStore } from '../../src/permissions/plugin-hook-permissions.js';
import {
  localPermissionVerdictKey,
  recordLocalPermissionVerdict,
  resetLocalPermissionVerdictLedger,
  takeLocalPermissionVerdict,
} from '../../src/permissions/verdict-ledger.js';
import type { LocalRuntimeConfig } from '../../src/config/types.js';

function freshFacade(
  opts: {
    permissionMode?: LocalRuntimeConfig['permissionMode'];
    cloudGateway?: CloudGatewayClient;
    managed?: boolean;
  } = {},
): {
  facade: LocalPermissionFacade;
  ruleStore: LocalPermissionRuleStore;
  dataDir: string;
} {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aa-mark-'));
  const config: LocalRuntimeConfig = {
    dataDir,
    permissionMode: opts.permissionMode ?? 'default',
    permission: { policyOwner: 'core' },
  } as LocalRuntimeConfig;
  const ruleStore = new LocalPermissionRuleStore(() => dataDir);
  const deps: LocalPermissionFacadeDeps = {
    ruleStore,
    configGetter: () => config,
    getSessionById: async () => undefined,
    getLocalAgent: async () => undefined,
    cloudGateway: opts.cloudGateway,
  };
  if (opts.managed) {
    configurePermissionHost({
      runtimeConfigProvider: {
        getConfig: () => ({}),
        getRuntimeRegion: () => 'cn',
        getRuntimeBuildEnv: () => 'prod',
        isManagedRuntime: () => true,
      },
    });
  }
  return { facade: new LocalPermissionFacade(deps), ruleStore, dataDir };
}

function cleanup(dataDir: string): void {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('LocalPermissionFacade §4 mark attribution', () => {
  afterEach(() => {
    resetPermissionHostForTesting();
    resetLocalPermissionVerdictLedger();
    vi.restoreAllMocks();
  });

  it('attributes a persisted allow rule with its scope (global)', async () => {
    const { facade, ruleStore, dataDir } = freshFacade();
    try {
      await ruleStore.applyUpdate({
        type: 'addRules',
        source: 'global',
        destination: 'global',
        behavior: 'allow',
        rules: [{ tool_name: 'read', rule_content: path.join(dataDir, 'config.yaml') }],
      });
      const result = await facade.checkPermission({
        sessionId: 'sess-rule',
        toolName: 'read',
        input: { path: path.join(dataDir, 'config.yaml') },
      });
      expect(result.behavior).toBe('allow');
      expect(result.decidedBy).toBe('rule');
      expect(result.ruleKind).toBe('global');
      expect(result.mode).toBe('default');
      expect(result.reason).toBeTruthy();
    } finally {
      cleanup(dataDir);
    }
  });

  it('attributes a session-scoped deny rule with ruleKind session', async () => {
    const { facade, ruleStore, dataDir } = freshFacade();
    try {
      await ruleStore.applyUpdate({
        type: 'addRules',
        source: 'session',
        destination: 'sess-deny',
        behavior: 'deny',
        rules: [{ tool_name: 'bash', rule_content: 'curl http://example.invalid' }],
      });
      const result = await facade.checkPermission({
        sessionId: 'sess-deny',
        toolName: 'bash',
        input: { command: 'curl http://example.invalid' },
      });
      expect(result.behavior).toBe('deny');
      expect(result.decidedBy).toBe('rule');
      expect(result.ruleKind).toBe('session');
      expect(result.mode).toBe('default');
    } finally {
      cleanup(dataDir);
    }
  });

  it('attributes built-in checker policy: safe-bash fast-allow', async () => {
    const { facade, dataDir } = freshFacade();
    try {
      const result = await facade.checkPermission({
        sessionId: 'sess-safe',
        toolName: 'bash',
        input: { command: 'npm test' },
      });
      expect(result.behavior).toBe('allow');
      expect(result.decidedBy).toBe('rule');
      expect(result.ruleKind).toBe('builtin');
      expect(result.mode).toBe('default');
    } finally {
      cleanup(dataDir);
    }
  });

  it('attributes built-in checker policy: workspace fs read allow', async () => {
    const { facade, dataDir } = freshFacade({ permissionMode: 'default' });
    try {
      const result = await facade.checkPermission({
        sessionId: 'sess-fs',
        agentName: 'fixture-agent',
        toolName: 'read',
        input: { path: path.join(dataDir, 'agents', 'fixture-agent', 'workspace', 'a.txt') },
      });
      expect(result.behavior).toBe('allow');
      expect(result.decidedBy).toBe('rule');
      expect(result.ruleKind).toBe('builtin');
      expect(result.mode).toBe('default');
    } finally {
      cleanup(dataDir);
    }
  });

  it('attributes a final-deny builtin pattern as rule/builtin', async () => {
    const { facade, dataDir } = freshFacade();
    try {
      const result = await facade.checkPermission({
        sessionId: 'sess-final',
        toolName: 'bash',
        input: { command: 'shred /tmp/definitely-not-created.txt' },
      });
      expect(result.behavior).toBe('deny');
      expect(result.decidedBy).toBe('rule');
      expect(result.ruleKind).toBe('builtin');
      expect(result.mode).toBe('default');
    } finally {
      cleanup(dataDir);
    }
  });

  it('attributes the ask-gate bypass downgrade as mode', async () => {
    const { facade, dataDir } = freshFacade({ permissionMode: 'bypassPermissions' });
    try {
      const result = await facade.checkPermission({
        sessionId: 'sess-bypass',
        toolName: 'bash',
        input: { command: 'npm publish' },
      });
      expect(result.behavior).toBe('allow');
      expect(result.decidedBy).toBe('mode');
      expect(result.ruleKind).toBeNull();
      expect(result.mode).toBe('bypassPermissions');
    } finally {
      cleanup(dataDir);
    }
  });

  it('attributes the off-mode waiver as mode', async () => {
    const { facade, dataDir } = freshFacade({ permissionMode: 'off' });
    try {
      const result = await facade.checkPermission({
        sessionId: 'sess-off',
        toolName: 'bash',
        input: { command: 'npm publish' },
      });
      expect(result.behavior).toBe('allow');
      expect(result.decidedBy).toBe('mode');
      expect(result.ruleKind).toBeNull();
      expect(result.mode).toBe('off');
    } finally {
      cleanup(dataDir);
    }
  });

  it('attributes the dontAsk auto-deny as mode', async () => {
    // Config-level permissionMode has no dontAsk value (readLocalPermissionMode
    // collapses it); the mode arrives via a plugin-hook setMode update.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aa-mark-'));
    const config: LocalRuntimeConfig = {
      dataDir,
      permissionMode: 'default',
      permission: { policyOwner: 'core' },
    } as LocalRuntimeConfig;
    const ruleStore = new LocalPermissionRuleStore(() => dataDir);
    const pluginStore = new LocalPluginHookPermissionStore({ dataDir });
    const facade = new LocalPermissionFacade({
      ruleStore,
      pluginHookPermissionStore: pluginStore,
      configGetter: () => config,
      getSessionById: async () => undefined,
      getLocalAgent: async () => undefined,
    });
    try {
      await pluginStore.applyAtomic({
        sessionId: 'sess-dontask',
        cwd: dataDir,
        bypassAvailable: true,
        updates: [{ type: 'setMode', mode: 'dontAsk', destination: 'session' }],
      });
      const result = await facade.checkPermission({
        sessionId: 'sess-dontask',
        toolName: 'bash',
        input: { command: 'npm publish' },
      });
      expect(result.behavior).toBe('deny');
      expect(result.decidedBy).toBe('mode');
      expect(result.ruleKind).toBeNull();
      expect(result.mode).toBe('dontAsk');
    } finally {
      cleanup(dataDir);
    }
  });

  it('attributes a managed-auto classifier allow as classifier', async () => {
    const classify = vi.fn(async (): Promise<CloudClassifyVerdict> => ({
      kind: 'allow',
      reasonLocalized: 'looked safe',
    }));
    const { facade, dataDir } = freshFacade({
      permissionMode: 'auto',
      managed: true,
      cloudGateway: { classify },
    });
    try {
      const result = await facade.checkPermission({
        sessionId: 'sess-auto',
        toolName: 'bash',
        input: { command: 'npm publish' },
      });
      expect(classify).toHaveBeenCalled();
      expect(result.behavior).toBe('allow');
      expect(result.decidedBy).toBe('classifier');
      expect(result.ruleKind).toBeNull();
      expect(result.mode).toBe('auto');
    } finally {
      cleanup(dataDir);
    }
  });

  it('records the final verdict attribution in the take-once ledger', async () => {
    const { facade, dataDir } = freshFacade();
    try {
      const input = { path: path.join(dataDir, 'skills', 'gif', 'SKILL.md') };
      const result = await facade.checkPermission({
        sessionId: 'sess-ledger',
        toolName: 'read',
        input,
      });
      expect(result.behavior).toBe('allow');
      const key = localPermissionVerdictKey('sess-ledger', 'read', input);
      expect(takeLocalPermissionVerdict(key)).toEqual({
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      });
      // Take-once: a second read yields nothing (never re-consumed).
      expect(takeLocalPermissionVerdict(key)).toBeUndefined();
    } finally {
      cleanup(dataDir);
    }
  });

  it('ledger keys are stable against key order in the input record', () => {
    resetLocalPermissionVerdictLedger();
    recordLocalPermissionVerdict(
      localPermissionVerdictKey('s', 'bash', { command: 'ls', timeout: 5 }),
      { decidedBy: 'rule', ruleKind: 'builtin', mode: 'default' },
    );
    expect(
      takeLocalPermissionVerdict(localPermissionVerdictKey('s', 'bash', { timeout: 5, command: 'ls' })),
    ).toEqual({ decidedBy: 'rule', ruleKind: 'builtin', mode: 'default' });
  });

  describe('R2 byok-auto-equals-default', () => {
    it('unmanaged auto never calls the classifier and behaves like default', async () => {
      const classify = vi.fn(async (): Promise<CloudClassifyVerdict> => ({
        kind: 'allow',
        reasonLocalized: 'ok',
      }));
      const { facade, dataDir } = freshFacade({
        permissionMode: 'auto',
        cloudGateway: { classify },
      });
      try {
        // Workspace read: builtin allow, no gateway call.
        const read = await facade.checkPermission({
          sessionId: 'sess-byok',
          agentName: 'fixture-agent',
          toolName: 'read',
          input: { path: path.join(dataDir, 'agents', 'fixture-agent', 'workspace', 'a.txt') },
        });
        expect(read.behavior).toBe('allow');
        expect(read.decidedBy).toBe('rule');
        expect(read.ruleKind).toBe('builtin');

        // Safe bash: builtin allow, no gateway call.
        const test = await facade.checkPermission({
          sessionId: 'sess-byok',
          toolName: 'bash',
          input: { command: 'npm test' },
        });
        expect(test.behavior).toBe('allow');
        expect(test.decidedBy).toBe('rule');
        expect(test.ruleKind).toBe('builtin');

        // Same verdict as default for an ordinary ask (classifier skipped).
        const ask = await facade.checkPermission({
          sessionId: 'sess-byok',
          toolName: 'bash',
          input: { command: 'npm publish' },
        });
        expect(ask.behavior).toBe('ask');
        expect(classify).not.toHaveBeenCalled();
      } finally {
        cleanup(dataDir);
      }
    });

    it('spec R2: read AND edit inside the Session workspace and npm test → allow rule/builtin', async () => {
      // F5: fs-permission step 4 (`pathInWorkingPath`) allows ANY fs tool —
      // read or write — inside the Session workspace, in default and BYOK
      // auto alike. The workspace is a plain tmp dir OUTSIDE dataDir so no
      // private-runtime-tree rule interferes. If this pin fails, that is an
      // F5 regression ("BYOK asks everything"), not a reason to weaken it.
      const classify = vi.fn(async (): Promise<CloudClassifyVerdict> => ({
        kind: 'allow',
        reasonLocalized: 'ok',
      }));
      const dataDir = mkdtempSync(path.join(tmpdir(), 'aa-mark-'));
      const workspaceDir = mkdtempSync(path.join(tmpdir(), 'aa-mark-ws-'));
      const config: LocalRuntimeConfig = {
        dataDir,
        permissionMode: 'auto',
        permission: { policyOwner: 'core' },
      } as LocalRuntimeConfig;
      const facade = new LocalPermissionFacade({
        ruleStore: new LocalPermissionRuleStore(() => dataDir),
        configGetter: () => config,
        getSessionById: async (id) =>
          id === 'sess-byok-ws'
            ? ({ id, agentName: 'fixture-agent', workspaceDir } as unknown as Awaited<
                ReturnType<LocalPermissionFacadeDeps['getSessionById']>
              >)
            : undefined,
        getLocalAgent: async () => undefined,
        cloudGateway: { classify },
      });
      try {
        const target = path.join(workspaceDir, 'src', 'a.txt');
        for (const [toolName, input] of [
          ['read', { path: target }],
          ['edit', { path: target, old_string: 'a', new_string: 'b' }],
          ['write', { path: target, content: 'hello' }],
          ['bash', { command: 'npm test' }],
        ] as const) {
          const result = await facade.checkPermission({
            sessionId: 'sess-byok-ws',
            toolName,
            input: { ...input },
          });
          expect({ toolName, behavior: result.behavior }).toEqual({ toolName, behavior: 'allow' });
          expect(result.decidedBy).toBe('rule');
          expect(result.ruleKind).toBe('builtin');
          expect(result.mode).toBe('auto');
        }
        expect(classify).not.toHaveBeenCalled();
      } finally {
        cleanup(dataDir);
        cleanup(workspaceDir);
      }
    });
  });
});

// Keep the homedir import referenced for parity with the facade suite's
// dataDirParent fixtures (the workspace fixtures above rely on tmpdir()).
void homedir;
