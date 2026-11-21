/**
 * Out-of-the-box Browser tooling (owner bug 2026-11-07): the TUI runtime
 * lifecycle must treat an ABSENT `beta.browserUseTooling` as ENABLED — the
 * product's beta channel model already ships the flag ON
 * (`defaultVisibility: 'online'` in BETA_FEATURE_DEFS), and the previous
 * explicit-only read made the out-of-the-box state impossible while the
 * plugin's `control-in-app-browser` skill stayed visible to the model without
 * its tool. An explicit `beta.browserUseTooling: false` in the owner's
 * config.yaml remains the kill switch; a missing config file stays
 * fail-closed (no owner intent readable -> no provider).
 *
 * @module
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTuiRuntime } from '../../src/runtime/lifecycle.js';

const createEmbeddedRuntimeHost = vi.hoisted(() =>
  vi.fn(async () => ({
    apiHost: { close: async () => undefined, ensureBuiltinAgents: async () => undefined },
    cliService: {},
  })),
);

vi.mock('../../src/runtime/embedded-host.js', () => ({
  createEmbeddedRuntimeHost,
  projectEmbeddedRuntimeConfig: (config: unknown) => config,
}));
vi.mock('../../src/runtime/remote-host.js', () => ({
  createRemoteRuntimeHost: vi.fn(),
  resolveTuiServerMode: (env: NodeJS.ProcessEnv = process.env) => {
    const raw = env['MCODE_SERVER_MODE']?.trim().toLowerCase();
    if (raw === undefined || raw === '') return 'off' as const;
    if (raw === 'off' || raw === 'auto' || raw === 'required') return raw;
    throw new Error(`Invalid MCODE_SERVER_MODE value ${JSON.stringify(raw)}`);
  },
}));

function stubDeps() {
  // Every config the lifecycle hands the factory, gate outcome included.
  const seenBetas: (boolean | undefined)[] = [];
  // Providers actually composed (the factory's own gate mirrors
  // createTuiBrowserProvider's `beta.browserUseTooling !== true` admission).
  const providerCalls: { dataDir: string; betaBrowserUseTooling: boolean | undefined }[] = [];
  const createBrowserProvider = vi.fn((dataDir: string, config: unknown) => {
    const beta = (config as { beta?: { browserUseTooling?: boolean } } | undefined)?.beta;
    seenBetas.push(beta?.browserUseTooling);
    if (beta?.browserUseTooling !== true) return undefined;
    providerCalls.push({ dataDir, betaBrowserUseTooling: beta.browserUseTooling });
    return { disposeSession: async () => undefined, close: async () => undefined };
  });
  return {
    seenBetas,
    providerCalls,
    createBrowserProvider,
    deps: {
      factory: vi.fn(async () => ({
        apiHost: { close: async () => undefined, ensureBuiltinAgents: async () => undefined },
        cliService: {},
      })),
      getConfig: () => ({ review: undefined, beta: {}, memory: {} }) as never,
      createLogging: () =>
        ({
          logDirectory: '/tmp/browser-tooling-test-logs',
          runDuringStartup: async <T>(fn: () => Promise<T>) => await fn(),
          shutdown: async () => undefined,
          flush: async () => undefined,
        }) as never,
      createBrowserProvider,
      readAuthContext: () => undefined,
      createObservability: undefined,
      importSharedAuthContext: undefined,
    },
  };
}

describe('TUI Browser tooling default (out of the box, kill switch preserved)', () => {
  let dataDir: string;
  dataDir = mkdtempSync(join(tmpdir(), 'browser-tooling-'));

  afterEach(() => {
    delete process.env['MCODE_SERVER_MODE'];
    vi.clearAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = mkdtempSync(join(tmpdir(), 'browser-tooling-'));
  });

  it('composes the Browser provider when the config carries no beta.browserUseTooling key', { timeout: 20000 }, async () => {
    writeFileSync(join(dataDir, 'config.yaml'), 'review: {}\n', 'utf8');
    const { deps, providerCalls, createBrowserProvider } = stubDeps();
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test' },
      deps as never,
    );
    expect(createBrowserProvider).toHaveBeenCalledTimes(1);
    expect(providerCalls[0]?.betaBrowserUseTooling).toBe(true);
    expect(runtime.browserProvider).toBeDefined();
    await runtime.host.apiHost.close();
  });

  it('keeps the explicit beta.browserUseTooling: false kill switch working', { timeout: 20000 }, async () => {
    writeFileSync(
      join(dataDir, 'config.yaml'),
      'beta:\n  browserUseTooling: false\n',
      'utf8',
    );
    const { deps, providerCalls, seenBetas } = stubDeps();
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test' },
      deps as never,
    );
    // The lifecycle override propagated the owner's explicit false...
    expect(seenBetas).toEqual([false]);
    // ...and the gated factory composed nothing.
    expect(providerCalls).toHaveLength(0);
    expect(runtime.browserProvider).toBeUndefined();
    await runtime.host.apiHost.close();
  });

  it('keeps the explicit beta.browserUseTooling: true opt-in working', { timeout: 20000 }, async () => {
    writeFileSync(
      join(dataDir, 'config.yaml'),
      'beta:\n  browserUseTooling: true\n',
      'utf8',
    );
    const { deps, providerCalls } = stubDeps();
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test' },
      deps as never,
    );
    expect(providerCalls[0]?.betaBrowserUseTooling).toBe(true);
    expect(runtime.browserProvider).toBeDefined();
    await runtime.host.apiHost.close();
  });

  it('stays fail-closed when the config file cannot be read', { timeout: 20000 }, async () => {
    // No config.yaml in the temp dataDir: readExplicitBetaFeatureFromFile
    // throws CONFIG_READ_FAILED and the lifecycle keeps the provider off —
    // an unreadable config carries no owner intent to honor.
    const { deps, providerCalls, seenBetas } = stubDeps();
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test' },
      deps as never,
    );
    // The unreadable config degraded the opt-in to fail-closed false...
    expect(seenBetas).toEqual([false]);
    // ...and the gated factory composed nothing.
    expect(providerCalls).toHaveLength(0);
    expect(runtime.browserProvider).toBeUndefined();
    await runtime.host.apiHost.close();
  });
});
