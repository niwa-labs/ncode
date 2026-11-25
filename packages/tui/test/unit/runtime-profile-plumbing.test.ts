/**
 * The `--profile` plumbing chain (opus 2026-11-01, правка 4, тест 2):
 * launcher → lifecycle → remote-host with a FAKE factory and NO profile env.
 *
 * `mcode --profile cedar` must reach `resolveDaemonTargets` as the explicit
 * input — not via `MINIMAX_PROFILE` (the env is deliberately empty here) and
 * not via the dataDir inference (the dataDir is a foreign temp directory).
 * The whole chain runs for real: the launcher's lifecycle seam returns the
 * REAL `createTuiRuntime` in server mode, and the remote host is the REAL
 * `createRemoteRuntimeHost` — only `McodedClient.connect` is stubbed (no
 * socket, no auto-spawn) and `resolveDaemonTargets` is wrapped with a
 * recording spy.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchTui, type LaunchTuiDependencies } from '../../src/tui/launcher.js';
import { createTuiRuntime, shutdownTuiRuntime } from '../../src/runtime/lifecycle.js';
import {
  noopTuiIncidentReporter,
  noopTuiObservability,
} from '../../src/observability/index.js';
import type { Terminal } from '../../src/tui/engine/public.js';

const resolveTargetsSpy = vi.hoisted(() => vi.fn());

vi.mock('@mavis/mcoded', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mavis/mcoded')>();
  return {
    ...actual,
    resolveDaemonTargets: (...args: Parameters<typeof actual.resolveDaemonTargets>) => {
      const result = actual.resolveDaemonTargets(...args);
      resolveTargetsSpy(args[0], result);
      return result;
    },
    // No socket, no auto-spawn: the chain ends at the client boundary.
    McodedClient: class extends actual.McodedClient {
      override connect(): Promise<unknown> {
        return Promise.resolve({});
      }
    },
  };
});

/** Minimal terminal double: the launcher needs the shape, not a renderer. */
class StubTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  write(): void {}
  start(): void {}
  stop(): void {}
  drainInput(): Promise<void> {
    return Promise.resolve();
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setMouseTracking(): void {}
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'HOME',
  'MCODE_SERVER_MODE',
  'MINIMAX_PROFILE',
  'MINIMAX_DATA_DIR',
  'MAVIS_DATA_DIR',
  'MAVIS_REGION',
  'MAVIS_BUILD_ENV',
] as const;

const tempHomes: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The data plane env stays EMPTY: the profile may only arrive via the flag.
  const home = mkdtempSync(join(tmpdir(), 'profile-plumbing-'));
  tempHomes.push(home);
  process.env['HOME'] = home;
  process.env['MCODE_SERVER_MODE'] = 'auto';
  process.env['MAVIS_REGION'] = 'en';
  process.env['MAVIS_BUILD_ENV'] = 'prod';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function chainDependencies(writeExitMessage: (message: string) => void = () => undefined): LaunchTuiDependencies {
  let closeWindow!: () => void;
  const stopped = new Promise<void>((resolve) => { closeWindow = resolve; });
  const fakeApp = {
    ready: Promise.resolve(),
    firstFrame: Promise.resolve(),
    start: () => undefined,
    stop: () => Promise.resolve(),
    stopped,
    runStartupCheckin: () => { closeWindow(); },
    submit: async () => undefined,
    controller: { snapshot: () => ({ session: { sessionId: 'mvs_example' } }) },
  };
  return {
    captureStderr: (() => ({ logFile: undefined, restore: () => undefined })) as never,
    createObservability: (() => noopTuiObservability) as never,
    createIncidentReporter: () => noopTuiIncidentReporter,
    createSharedAuthSession:
      (() => ({
        getStatus: async () => ({ status: 'logged_out', generation: 0 }),
        getAccessToken: async () => {
          throw new Error('no credentials in the plumbing test');
        },
        handleUnauthorized: async () => 'login' as never,
        watch: () => () => undefined,
      })) as never,
    createAuthApplication: (() => ({})) as never,
    installProcessGuards: (() => () => undefined) as never,
    loadRuntimeLifecycle: async () => ({ createTuiRuntime, shutdownTuiRuntime }),
    loadUpdateApplication: (async () => ({
      inspect: async () => ({ status: 'up-to-date' }),
    })) as never,
    readTelemetryEnabled: () => false,
    createApp: (() => fakeApp) as never,
    writeExitMessage,
  };
}

describe('profile plumbing: launcher → lifecycle → remote-host → resolveDaemonTargets', () => {
  it('closing a daemon window stops the UI without cancelling its runtime Turn', async () => {
    const home = tempHomes.at(-1) as string;
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const stop = vi.fn(async () => { finish(); });
    let guards: Parameters<NonNullable<LaunchTuiDependencies['installProcessGuards']>>[0] | undefined;
    const running = launchTui({
      version: 'test', dataDir: join(home, 'window-close-data'), workspaceDir: home,
      terminal: new StubTerminal(),
    }, {
      ...chainDependencies(),
      loadRuntimeLifecycle: async () => ({
        createTuiRuntime: async () => ({ adapter: {}, connection: { state: () => 'ready' } }) as never,
        shutdownTuiRuntime: async () => false,
      }),
      createApp: (() => ({
        ready: Promise.resolve(), firstFrame: Promise.resolve(), start: () => undefined,
        stop, stopped, submit: async () => undefined,
      })) as never,
      installProcessGuards: (options) => { guards = options; return () => undefined; },
    });
    await vi.waitFor(() => expect(guards).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 10));
    guards!.onStopCause?.({ source: 'signal', signal: 'SIGHUP', terminalDead: false });
    await guards!.stop();
    await running;
    expect(stop).toHaveBeenNthCalledWith(1, { abortActiveTurn: false });
  });

  it('delivers the explicit --profile cedar to resolveDaemonTargets without any profile env', async () => {
    const home = tempHomes.at(-1) as string;
    const dataDir = join(home, 'data');
    mkdirSync(dataDir, { recursive: true });
    // resolveDaemonTargets realpaths the data plane (/var → /private/var on macOS).
    const realDataDir = realpathSync(dataDir);

    const writeExit = vi.fn();
    await launchTui(
      {
        version: 'test',
        dataDir,
        workspaceDir: join(home, 'workspace'),
        profile: 'cedar',
        terminal: new StubTerminal(),
      },
      chainDependencies(writeExit),
    );

    expect(writeExit).toHaveBeenCalledWith(
      expect.stringContaining('  ncode --profile cedar --session mvs_example\n'),
    );
    expect(resolveTargetsSpy).toHaveBeenCalledOnce();
    const [options, targets] = resolveTargetsSpy.mock.calls[0] as [
      { profile?: string; dataDir: string; homeDir?: string; env?: NodeJS.ProcessEnv },
      { profile: string | null; dataDir: string },
    ];
    // The flag is the top-priority input; the env contributed nothing.
    expect(options.profile).toBe('cedar');
    expect(options.dataDir).toBe(dataDir);
    // lifecycle passes no homeDir: the identity home travels through env.HOME.
    expect(options.homeDir).toBeUndefined();
    expect(options.env?.['HOME']).toBe(home);
    expect(options.env?.['MINIMAX_PROFILE']).toBeUndefined();
    // The resolved targets carry the label into the daemon binding.
    expect(targets.profile).toBe('cedar');
    expect(targets.dataDir).toBe(realDataDir);
  });

  it('keeps the request profile-less when no flag was given (the field stays unset)', async () => {
    const home = tempHomes.at(-1) as string;
    const dataDir = join(home, 'data');
    mkdirSync(dataDir, { recursive: true });

    const options = { version: 'test', dataDir, workspaceDir: home, terminal: new StubTerminal() };
    const writeExit = vi.fn();
    await launchTui(options, chainDependencies(writeExit));
    expect(writeExit).toHaveBeenCalledWith(
      expect.stringContaining('  ncode --session mvs_example\n'),
    );

    expect(resolveTargetsSpy).toHaveBeenCalledOnce();
    const [targetsOptions, targets] = resolveTargetsSpy.mock.calls[0] as [
      { profile?: string },
      { profile: string | null },
    ];
    // remote-host always passes the field through; without the flag it is undefined.
    expect(targetsOptions.profile).toBeUndefined();
    // A foreign dataDir without a flag infers nothing: the default profile.
    expect(targets.profile).toBeNull();
  });
});
