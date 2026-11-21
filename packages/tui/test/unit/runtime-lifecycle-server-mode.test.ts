/**
 * W4 (§6-W4 п.1): the lifecycle server-mode branch — behavior test.
 *
 * `MCODE_SERVER_MODE=off` (the DEFAULT) must take the embedded path
 * byte-for-byte: the embedded factory builds the host, the remote-host
 * module is NEVER touched. `auto` flips to the thin-client host. The
 * default's inviolability is exactly this pair of assertions.
 *
 * Both host builders are mocked: this test pins the BRANCH, not the hosts
 * (each host has its own suite).
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTuiRuntime } from '../../src/runtime/lifecycle.js';

const daemonOwner = vi.hoisted(() => ({
  live: false,
  /** Extra manifest fields (region/buildEnv) for the env-guard tests. */
  env: undefined as { readonly region?: string; readonly buildEnv?: string } | undefined,
}));
vi.mock('@mavis/mcoded', async (importOriginal) => ({
  ...await importOriginal<typeof import('@mavis/mcoded')>(),
  readDaemonManifest: () =>
    daemonOwner.live
      ? { pid: process.pid, ...(daemonOwner.env ?? {}) }
      : undefined,
}));

const createEmbeddedRuntimeHost = vi.hoisted(() =>
  vi.fn(async () => ({
    apiHost: { close: async () => undefined, ensureBuiltinAgents: async () => undefined },
    cliService: {},
  })),
);
const createRemoteRuntimeHost = vi.hoisted(() =>
  vi.fn(async () => ({
    apiHost: { close: async () => undefined },
    cliService: {},
    ready: Promise.resolve(),
    connectionState: () => 'ready' as const,
    onConnectionStateChange: () => () => undefined,
    notifyAuthContextChanged: async () => undefined,
    clientInstanceId: 'test-window',
    socketPath: '/tmp/test.sock',
  })),
);

vi.mock('../../src/runtime/embedded-host.js', () => ({
  createEmbeddedRuntimeHost,
  projectEmbeddedRuntimeConfig: (config: unknown) => config,
}));
vi.mock('../../src/runtime/remote-host.js', () => ({
  createRemoteRuntimeHost,
  resolveTuiServerMode: (env: NodeJS.ProcessEnv = process.env) => {
    const raw = env['MCODE_SERVER_MODE']?.trim().toLowerCase();
    if (raw === undefined || raw === '') return 'off' as const;
    if (raw === 'off' || raw === 'auto' || raw === 'required') return raw;
    throw new Error(`Invalid MCODE_SERVER_MODE value ${JSON.stringify(raw)}`);
  },
}));

function stubDeps() {
  return {
    factory: vi.fn(async (options: unknown) => {
      void createEmbeddedRuntimeHost; // the real (mocked) builder is what runs
      return await createEmbeddedRuntimeHost(options as never);
    }),
    getConfig: () => ({ review: undefined, beta: {}, memory: {} }) as never,
    createLogging: () =>
      ({
        logDirectory: '/tmp/w4-test-logs',
        runDuringStartup: async <T>(fn: () => Promise<T>) => await fn(),
        shutdown: async () => undefined,
        flush: async () => undefined,
      }) as never,
    createBrowserProvider: vi.fn(() => ({
      disposeSession: async () => undefined,
      dispose: async () => undefined,
    })),
    readAuthContext: () => undefined,
    createObservability: undefined,
    importSharedAuthContext: undefined,
  };
}

describe('lifecycle server-mode branch (W4 §6 п.1)', () => {
  let dataDir: string;
  beforeEachData();

  function beforeEachData() {
    dataDir = mkdtempSync(join(tmpdir(), 'w4-lifecycle-'));
  }

  afterEach(() => {
    delete process.env['MCODE_SERVER_MODE'];
    delete process.env['MAVIS_REGION'];
    daemonOwner.live = false;
    daemonOwner.env = undefined;
    vi.clearAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('off (the default, absent switch) builds the EMBEDDED host and never the remote one', async () => {
    delete process.env['MCODE_SERVER_MODE'];
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test' },
      stubDeps() as never,
    );
    expect(createEmbeddedRuntimeHost).toHaveBeenCalledTimes(1);
    expect(createRemoteRuntimeHost).not.toHaveBeenCalled();
    expect(runtime.connection).toBeUndefined();
    await runtime.host.apiHost.close();
  });

  it('auto connects the thin-client host and never the embedded one', async () => {
    process.env['MCODE_SERVER_MODE'] = 'auto';
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test' },
      stubDeps() as never,
    );
    expect(createRemoteRuntimeHost).toHaveBeenCalledTimes(1);
    expect(createEmbeddedRuntimeHost).not.toHaveBeenCalled();
    expect(runtime.connection).toBeDefined();
    expect(runtime.connection?.state()).toBe('ready');
    await runtime.host.apiHost.close();
  });

  it('management reuses the live owner even with server mode off, without spawning', async () => {
    process.env['MCODE_SERVER_MODE'] = 'off';
    daemonOwner.live = true;
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test', managementSurface: true },
      stubDeps() as never,
    );
    expect(createEmbeddedRuntimeHost).not.toHaveBeenCalled();
    expect(createRemoteRuntimeHost).toHaveBeenCalledWith(expect.objectContaining({ autoSpawn: false }));
    expect(runtime.connection?.state()).toBe('ready');
    await runtime.host.apiHost.close();
  });

  it('offline management stays embedded and never restores persisted jobs', async () => {
    process.env['MCODE_SERVER_MODE'] = 'auto';
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test', managementSurface: true },
      stubDeps() as never,
    );
    expect(createRemoteRuntimeHost).not.toHaveBeenCalled();
    expect(createEmbeddedRuntimeHost).toHaveBeenCalledWith(expect.objectContaining({
      startupExecutionPolicy: 'quarantined',
    }), expect.anything());
    await runtime.host.apiHost.close();
  });

  it('--no-daemon beats MCODE_SERVER_MODE=auto and builds the embedded host', async () => {
    process.env['MCODE_SERVER_MODE'] = 'auto';
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test', noDaemon: true },
      stubDeps() as never,
    );
    expect(createEmbeddedRuntimeHost).toHaveBeenCalledTimes(1);
    expect(createRemoteRuntimeHost).not.toHaveBeenCalled();
    await runtime.host.apiHost.close();
  });

  it('--no-daemon softens the live-daemon env mismatch: warn, boot embedded', async () => {
    // A live daemon of a DIFFERENT region must not block an in-process run
    // that never talks to it (isolated/wrapper runs share the profile home).
    process.env['MCODE_SERVER_MODE'] = 'auto';
    process.env['MAVIS_REGION'] = 'global';
    daemonOwner.live = true;
    daemonOwner.env = { region: 'cn' };
    const runtime = await createTuiRuntime(
      { dataDir, workspaceDir: dataDir, version: 'test', noDaemon: true },
      stubDeps() as never,
    );
    expect(createEmbeddedRuntimeHost).toHaveBeenCalledTimes(1);
    expect(createRemoteRuntimeHost).not.toHaveBeenCalled();
    await runtime.host.apiHost.close();
  });

  it('without the flag the same mismatch still refuses fast (daemon modes)', async () => {
    process.env['MCODE_SERVER_MODE'] = 'auto';
    process.env['MAVIS_REGION'] = 'global';
    daemonOwner.live = true;
    daemonOwner.env = { region: 'cn' };
    await expect(
      createTuiRuntime(
        { dataDir, workspaceDir: dataDir, version: 'test' },
        stubDeps() as never,
      ),
    ).rejects.toThrow(/Daemon env mismatch/);
    expect(createRemoteRuntimeHost).not.toHaveBeenCalled();
    expect(createEmbeddedRuntimeHost).not.toHaveBeenCalled();
  });
});
