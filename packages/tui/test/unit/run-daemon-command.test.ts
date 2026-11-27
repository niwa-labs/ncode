/**
 * The `mcode daemon` command surface (W2): registration in the CLI program
 * (`run|status|stop|restart` wiring), the SERVER_MODE gate on `run` (§4.8 —
 * `off` refuses before any host boots), and the restart orchestration —
 * graceful stop of the current life, the §4.6.2 start shape of the spawn
 * (argv, fixed env, no inherited mode switch), and the bounded readiness
 * wait — exercised against a REAL daemon on a temporary control root via the
 * injected spawn seam.
 *
 * @module
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Command } from 'commander';

import { MCODE_SERVER_MODE_ENV, resolveDurableRoot } from '@mavis/config';
import type {
  CreateLocalRuntimeHostOptions,
  CreatedLocalRuntimeHost,
} from '@mavis/local-runtime-v2/process-local';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';
import {
  McodedClient,
  helloDaemon,
  readDaemonToken,
  readLockHolderPid,
  serializeFrame,
  startProductDaemon,
  type ProductDaemonHandle,
} from '@mavis/mcoded';

import { createTuiProgram } from '../../src/cli/program.js';
import {
  DaemonDrainRefusalError,
  runMcodeDaemonCommand,
} from '../../src/cli/run-daemon-command.js';

const tempHomes: string[] = [];
const activeHandles: ProductDaemonHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ['MAVIS_REGION', 'MAVIS_BUILD_ENV', 'MINIMAX_PROFILE', 'MINIMAX_DATA_DIR'];

beforeEach(() => {
  tempHomes.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-daemon-cmd-')));
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env['MAVIS_REGION'] = 'en';
  process.env['MAVIS_BUILD_ENV'] = 'prod';
});

afterEach(async () => {
  for (const handle of activeHandles.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(() => {
  for (const home of tempHomes) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Host stub over the CliService surface the adapter touches — keeps the
 * REAL TUI host stack out of these tests (the `createEmbeddedRuntimeHost`
 * composition is pinned by the gate tests and the product-daemon suite).
 */
function makeStubHost() {
  return async (options: CreateLocalRuntimeHostOptions) =>
    ({
      dataDir: options.dataDir,
      ready: Promise.resolve(),
      apiHost: { close: async () => undefined, ensureBuiltinAgents: async () => undefined },
      metricsClient: { close: async () => undefined },
      cliService: {
        createSession: async () => ({ sessionId: 'sess-cmd' }),
      } as unknown as CliService,
    }) as unknown as CreatedLocalRuntimeHost;
}

function commandOptions(home: string) {
  return {
    homeDir: home,
    environment: {
      [MCODE_SERVER_MODE_ENV]: 'auto',
      MAVIS_REGION: 'en',
      MAVIS_BUILD_ENV: 'prod',
      HOME: home,
    } as NodeJS.ProcessEnv,
  };
}

describe('mcode daemon run: the §4.8 gate', () => {
  it('refuses while MCODE_SERVER_MODE=off before any host boots', async () => {
    const home = tempHomes.at(-1) as string;
    await expect(
      runMcodeDaemonCommand({
        request: { action: 'run' },
        homeDir: home,
        environment: { [MCODE_SERVER_MODE_ENV]: 'off', HOME: home },
      }),
    ).rejects.toMatchObject({ code: 'SERVER_MODE_OFF' });
    // Nothing was created — the gate precedes the control-plane writes.
    expect(fs.existsSync(path.join(home, '.mcode-durable'))).toBe(false);
  });

  // The DEFAULT mode flipped to `auto` on 2026-10-29 (owner decision after the
  // green 24h soak): `daemon run` with no env now starts for real (blocking),
  // so the default-mode gate coverage lives in product-daemon.test.ts with a
  // stubbed host instead of here.
});

describe('mcode daemon status', () => {
  it('reports not-running for a control root without a daemon', async () => {
    const home = tempHomes.at(-1) as string;
    const report = await runMcodeDaemonCommand({
      request: { action: 'status' },
      ...commandOptions(home),
    });
    expect(report).toContain('not running');
    expect(report).toContain(resolveDurableRoot(null, home));

    const json = JSON.parse(
      await runMcodeDaemonCommand({
        request: { action: 'status', json: true },
        ...commandOptions(home),
      }),
    ) as { running: boolean; controlRoot: string; dataDir: string };
    expect(json.running).toBe(false);
    expect(json.controlRoot).toBe(resolveDurableRoot(null, home));
    expect(json.dataDir).toBe(path.join(home, '.minimax'));
  });

  it('reports a live daemon as running — the probe carries the full env identity', async () => {
    const home = tempHomes.at(-1) as string;
    // Regression (round-2 finding): the status hello used to omit `env`, and
    // the product daemon ALWAYS checks region/buildEnv (getRuntimeRegion
    // never returns undefined) — a live daemon answered "not responding"
    // with ENV_MISMATCH.
    const handle = await startProductDaemon({
      argv: [],
      env: {
        [MCODE_SERVER_MODE_ENV]: 'auto',
        MAVIS_REGION: 'en',
        MAVIS_BUILD_ENV: 'prod',
        HOME: home,
      } as NodeJS.ProcessEnv,
      homeDir: home,
      createHost: makeStubHost(),
    });
    activeHandles.push(handle);

    const report = await runMcodeDaemonCommand({
      request: { action: 'status' },
      ...commandOptions(home),
    });
    expect(report).toContain('mcoded is running');
    expect(report).toContain('state: ready');

    const json = JSON.parse(
      await runMcodeDaemonCommand({
        request: { action: 'status', json: true },
        ...commandOptions(home),
      }),
    ) as { running: boolean; manifest: { pid: number; state: string } | null };
    expect(json.running).toBe(true);
    expect(json.manifest?.state).toBe('ready');
    expect(json.manifest?.pid).toBe(process.pid);
  });
});

describe('mcode daemon restart (spawn shape + readiness wait)', () => {
  /**
   * The spawn seam stands in for the detached child: it boots a REAL product
   * daemon in-process (stub host — the real TUI host factory is the
   * composition under test elsewhere), so the restart's readiness poll and
   * the manifest/token/lock protocol run against the real socket.
   */
  function makeSpawnSeam(home: string) {
    const spawned: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const boots: Array<Promise<ProductDaemonHandle>> = [];
    const stubHost = makeStubHost();
    const spawnDaemon = ({ argv, env }: { argv: readonly string[]; env: NodeJS.ProcessEnv }) => {
      spawned.push({ argv, env });
      // The child CLI would parse `daemon run` and forward the flags.
      const dataDir = argv[argv.indexOf('--data-dir') + 1] as string;
      boots.push(
        startProductDaemon({
          argv: ['--data-dir', dataDir],
          env,
          homeDir: home,
          createHost: stubHost,
        }).then((handle) => {
          activeHandles.push(handle);
          return handle;
        }),
      );
      return { unref: () => undefined, pid: 424242 };
    };
    return { spawnDaemon, spawned, boots };
  }

  it('spawns `daemon run` detached with the data-plane env fixed and waits for hello', async () => {
    const home = tempHomes.at(-1) as string;
    const { spawnDaemon, spawned, boots } = makeSpawnSeam(home);
    const report = await runMcodeDaemonCommand({
      request: { action: 'restart', waitTimeoutMs: 20_000 },
      ...commandOptions(home),
      spawnDaemon,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    });
    await Promise.all(boots);

    expect(report).toContain('mcoded restarted');
    expect(spawned).toHaveLength(1);
    const { argv, env } = spawned[0] as { argv: readonly string[]; env: NodeJS.ProcessEnv };
    // §4.6.2 п.2 start shape: this CLI relaunches itself as `daemon run`.
    expect(argv.slice(-4)).toEqual(['daemon', 'run', '--data-dir', path.join(home, '.minimax')]);
    // The env is explicitly fixed for the child (region/buildEnv trap, R6).
    expect(env['MINIMAX_DATA_DIR']).toBe(path.join(home, '.minimax'));
    expect(env['MAVIS_REGION']).toBe('en');
    expect(env['MAVIS_BUILD_ENV']).toBe('prod');
    // The fresh daemon must not inherit a mode switch that gates `run`.
    expect(env[MCODE_SERVER_MODE_ENV]).toBeUndefined();

    // The readiness wait really observed the started daemon.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(resolveDurableRoot(null, home), 'daemon.json'), 'utf8'),
    ) as { state: string };
    expect(manifest.state).toBe('ready');
  }, 60_000);

  it('restarts cleanly even when no daemon was running', async () => {
    const home = tempHomes.at(-1) as string;
    const { spawnDaemon, boots } = makeSpawnSeam(home);
    const report = await runMcodeDaemonCommand({
      request: { action: 'restart', waitTimeoutMs: 20_000 },
      ...commandOptions(home),
      spawnDaemon,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    });
    await Promise.all(boots);
    expect(report).toContain('mcoded restarted');
  }, 60_000);

  // Regression (round-2 review, exit 13): the REAL defaultSleep must keep the
  // event loop alive while the readiness poll runs — the poll of a not-yet-
  // listening daemon fails with ENOENT and leaves no handles, so an unref'd
  // poll timer let the CLI process die mid-await ("unsettled top-level
  // await") before the restart could report. Here no sleep is injected: the
  // wait path itself must run to its bounded deadline and reject, never
  // hang, with the production cadence.
  it('readiness timeout uses the real sleep cadence and rejects (loop held)', async () => {
    const home = tempHomes.at(-1) as string;
    // The spawn seam never boots anything: every probe hits ENOENT, the
    // exact shape that starved an unref'd wait in the live CLI.
    await expect(
      runMcodeDaemonCommand({
        request: { action: 'restart', waitTimeoutMs: 1_500 },
        ...commandOptions(home),
        spawnDaemon: () => ({ unref: () => undefined, pid: 4711 }),
      }),
    ).rejects.toThrow(/did not become ready within 1500 ms/);
  }, 30_000);

  it('keeps waiting past the readiness window while the spawned daemon is still booting', async () => {
    const home = tempHomes.at(-1) as string;
    const controlRoot = resolveDurableRoot(null, home);
    const manifestPath = path.join(controlRoot, 'daemon.json');
    const manifest = (state: string) =>
      JSON.stringify({
        pid: process.pid,
        dataDir: path.join(home, '.minimax'),
        state,
        startedAt: new Date().toISOString(),
        socketPath: path.join(controlRoot, 'mcoded.sock'),
      });
    let sleeps = 0;
    const startedAt = Date.now();
    await expect(
      runMcodeDaemonCommand({
        request: { action: 'restart', waitTimeoutMs: 50 },
        ...commandOptions(home),
        spawnDaemon: () => {
          // The child took the writer lock and is migrating.
          fs.writeFileSync(path.join(controlRoot, 'mcoded.lock'), JSON.stringify({ pid: process.pid }));
          fs.writeFileSync(manifestPath, manifest('starting'));
          return { unref: () => undefined, pid: process.pid };
        },
        sleep: async () => {
          sleeps += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          // The boot ends well past the 50 ms window.
          if (Date.now() - startedAt > 400) fs.writeFileSync(manifestPath, manifest('failed:migration'));
        },
      }),
    ).rejects.toThrow(/daemon start failed \(failed:migration\)/);
    expect(Date.now() - startedAt).toBeGreaterThan(400);
    expect(sleeps).toBeGreaterThan(10);
  }, 30_000);

  it('does not wait on a previous daemon life that is still booting', async () => {
    const home = tempHomes.at(-1) as string;
    const controlRoot = resolveDurableRoot(null, home);
    fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    await expect(
      runMcodeDaemonCommand({
        request: { action: 'restart', waitTimeoutMs: 50 },
        ...commandOptions(home),
        spawnDaemon: () => {
          // The new child lost the lock to an older life still migrating.
          fs.writeFileSync(path.join(controlRoot, 'mcoded.lock'), JSON.stringify({ pid: process.pid }));
          fs.writeFileSync(
            path.join(controlRoot, 'daemon.json'),
            JSON.stringify({
              pid: process.pid,
              dataDir: path.join(home, '.minimax'),
              state: 'starting',
              startedAt: new Date(startedAt - 60_000).toISOString(),
              socketPath: path.join(controlRoot, 'mcoded.sock'),
            }),
          );
          return { unref: () => undefined, pid: 4712 };
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      }),
    ).rejects.toThrow(/did not become ready within 50 ms/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);

  // Design 15 (ДИЗАЙН 2): the restart spawn opens the log through
  // `openDaemonLogFd` — the child env carries the MCODED_LOG_FILE
  // declaration (the daemon-side copytruncate key) and an over-ceiling log
  // is pre-rotated (М3) BEFORE the fd exists.
  it('declares MCODED_LOG_FILE to the child and pre-rotates the over-ceiling daemon log', async () => {
    const home = tempHomes.at(-1) as string;
    const controlRoot = resolveDurableRoot(null, home);
    const logDir = path.join(controlRoot, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'mcoded.log'), 'x'.repeat(4096));
    const seen: Array<{ env: NodeJS.ProcessEnv; logFd: number }> = [];
    await expect(
      runMcodeDaemonCommand({
        request: { action: 'restart', waitTimeoutMs: 300 },
        homeDir: home,
        environment: {
          ...commandOptions(home).environment,
          MCODED_LOG_MAX_BYTES: '1024',
        } as NodeJS.ProcessEnv,
        spawnDaemon: (options) => {
          // Snapshot the env BEFORE anything could boot against it.
          seen.push({ env: { ...options.env }, logFd: options.logFd });
          return { unref: () => undefined, pid: 48048 };
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      }),
    ).rejects.toThrow(/did not become ready within 300 ms/);
    expect(seen).toHaveLength(1);
    // The child learns its own stderr: the declaration the daemon's М2
    // copytruncate (and only it) trusts; the knobs flow to the child too.
    expect(seen[0]?.env['MCODED_LOG_FILE']).toBe(path.join(logDir, 'mcoded.log'));
    expect(seen[0]?.env['MCODED_LOG_MAX_BYTES']).toBe('1024');
    expect(Number.isInteger(seen[0]?.logFd)).toBe(true);
    // М3 ran before the fd existed: the 4 KiB backlog moved to `.1`, the
    // fresh `mcoded.log` was opened empty for the child.
    expect(fs.readFileSync(path.join(logDir, 'mcoded.log.1'), 'utf8')).toBe('x'.repeat(4096));
    expect(fs.statSync(path.join(logDir, 'mcoded.log')).size).toBe(0);
  }, 30_000);

  // Regression (round-3 review, cold-restart permissions): in a cold restart
  // the RESTARTER is the first process on the control-root path. It must
  // create the root through `ensureControlRootLayout` (0700 + owner/write-bit
  // verification) before anything writes under it — a recursive log-dir
  // mkdir without a mode materialized the root at 0755, permanently
  // weakening the directory barrier the socket model rests on (arch
  // §4.6.1/R11: "каталог 0700"; a later `run` never re-tights it).
  it('cold restart creates the control root at 0700 before spawning', async () => {
    const home = tempHomes.at(-1) as string;
    await runMcodeDaemonCommand({
      request: { action: 'restart', waitTimeoutMs: 1_000 },
      ...commandOptions(home),
      // No-op seam: the readiness wait times out, but the parent's
      // control-root preparation has already happened by then.
      spawnDaemon: () => ({ unref: () => undefined, pid: 4712 }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    }).catch(() => undefined);

    const controlRoot = resolveDurableRoot(null, home);
    expect(fs.statSync(controlRoot).mode & 0o777).toBe(0o700);
  }, 30_000);

  // U2 (opus 2026-11-02, мина 2): the previous life is stopped under ITS
  // manifest identity — a caller in another region is no longer refused with
  // ENV_MISMATCH at the stop step — and the fresh daemon takes the CALLER's
  // normally-resolved region. Restart is the штатный way to re-region a daemon.
  it('re-regions across a restart: the cn life stops by manifest identity, the fresh daemon serves en', async () => {
    const home = tempHomes.at(-1) as string;
    // The daemon captures its region from the ambient env at start (in
    // production the spawned child carries its own env): flip to cn for the
    // boot, restore the caller's `en` (the beforeEach default) after.
    process.env['MAVIS_REGION'] = 'cn';
    const previous = await startProductDaemon({
      argv: [],
      env: {
        [MCODE_SERVER_MODE_ENV]: 'auto',
        MAVIS_REGION: 'cn',
        MAVIS_BUILD_ENV: 'prod',
        HOME: home,
      } as NodeJS.ProcessEnv,
      homeDir: home,
      createHost: makeStubHost(),
    });
    process.env['MAVIS_REGION'] = 'en';
    activeHandles.push(previous);
    expect(
      (JSON.parse(fs.readFileSync(previous.manifestPath, 'utf8')) as { region: string }).region,
    ).toBe('cn');

    const { spawnDaemon, spawned, boots } = makeSpawnSeam(home);
    const report = await runMcodeDaemonCommand({
      request: { action: 'restart', waitTimeoutMs: 20_000 },
      ...commandOptions(home),
      spawnDaemon,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    });
    await Promise.all(boots);
    expect(report).toContain('mcoded restarted');
    // The spawn pins the CALLER's resolved region, not the old daemon's cn.
    expect(spawned[0]?.env['MAVIS_REGION']).toBe('en');
    // The cn life drained gracefully (its manifest identity was accepted).
    await previous.done;
    // The control root now binds the caller's en.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(resolveDurableRoot(null, home), 'daemon.json'), 'utf8'),
    ) as { region: string; state: string };
    expect(manifest.state).toBe('ready');
    expect(manifest.region).toBe('en');
  }, 60_000);
});

describe('daemon management: the manifest env identity (U2, opus 2026-11-02)', () => {
  /**
   * Boot a REAL daemon whose recorded env identity is region=cn. The daemon
   * captures its region from the ambient env at start (`getRuntimeRegion`
   * reads process.env — in production the spawned child carries its own
   * env), so the fixture flips the ambient region for the boot and restores
   * the caller's `en` (the beforeEach default) afterwards.
   */
  async function startCnDaemon(home: string): Promise<ProductDaemonHandle> {
    process.env['MAVIS_REGION'] = 'cn';
    try {
      return await startProductDaemon({
        argv: [],
        env: {
          [MCODE_SERVER_MODE_ENV]: 'auto',
          MAVIS_REGION: 'cn',
          MAVIS_BUILD_ENV: 'prod',
          HOME: home,
        } as NodeJS.ProcessEnv,
        homeDir: home,
        createHost: makeStubHost(),
      });
    } finally {
      process.env['MAVIS_REGION'] = 'en';
    }
  }

  it('stop: an en caller gracefully stops a cn daemon (drain completed, socket gone)', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startCnDaemon(home);
    activeHandles.push(handle);
    const manifest = JSON.parse(fs.readFileSync(handle.manifestPath, 'utf8')) as {
      region: string;
      pid: number;
      socketPath: string;
    };
    expect(manifest.region).toBe('cn'); // fixture sanity: the daemon really is cn

    const report = await runMcodeDaemonCommand({
      request: { action: 'stop' },
      ...commandOptions(home),
    });
    expect(report).toContain(`mcoded stopped (pid ${manifest.pid})`);
    // The graceful shutdown finished (drain + manifest finalize) and the
    // socket file is gone. The manifest pid is this in-process harness's own
    // pid, so `handle.done` — not an OS-pid poll — is the "pid exited" proof.
    await handle.done;
    expect(fs.existsSync(manifest.socketPath)).toBe(false);
  }, 30_000);

  it('status: reports the env difference to a mismatched caller instead of failing', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startCnDaemon(home);
    activeHandles.push(handle);

    const report = await runMcodeDaemonCommand({
      request: { action: 'status' },
      ...commandOptions(home),
    });
    expect(report).toContain('mcoded is running');
    expect(report).toContain('region=cn buildEnv=prod (your env: region=en buildEnv=prod)');

    const json = JSON.parse(
      await runMcodeDaemonCommand({
        request: { action: 'status', json: true },
        ...commandOptions(home),
      }),
    ) as { running: boolean; probeError: string | null };
    expect(json.running).toBe(true);
    expect(json.probeError).toBeNull();
  }, 30_000);

  it('a pre-U2 manifest without region/buildEnv falls back to the caller identity', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startCnDaemon(home);
    activeHandles.push(handle);
    // Strip the env fields the way an old daemon.json lacks them.
    const manifest = JSON.parse(fs.readFileSync(handle.manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    delete manifest['region'];
    delete manifest['buildEnv'];
    fs.writeFileSync(handle.manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);

    // Caller in the daemon's region: the fallback identity (the caller's)
    // matches, so the stop must go through. An absent hello env or the en
    // caller identity would both be refused with ENV_MISMATCH by the hub.
    process.env['MAVIS_REGION'] = 'cn';
    try {
      const report = await runMcodeDaemonCommand({
        request: { action: 'stop' },
        ...commandOptions(home),
      });
      expect(report).toContain('mcoded stopped');
    } finally {
      process.env['MAVIS_REGION'] = 'en';
    }
    await handle.done;
  }, 30_000);

  it('regression: a client-session hello in the caller env is still refused with ENV_MISMATCH', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startCnDaemon(home);
    activeHandles.push(handle);

    // The exact hello an en window/exec presents (clientEnvIdentity): the
    // client-session guard is untouched — only the management commands speak
    // the manifest identity.
    const foreign = await helloDaemon(handle.daemon.socketPath, {
      token: readDaemonToken(handle.controlRoot),
      dataDir: handle.dataDir,
      env: { region: 'en', buildEnv: 'prod' },
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.errorCode).toBe('ENV_MISMATCH');
  }, 30_000);

  it('regression: stop with a wrong token still fails UNAUTHORIZED (no manifest-env bypass)', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startCnDaemon(home);
    activeHandles.push(handle);
    const realToken = fs.readFileSync(handle.tokenPath, 'utf8');
    fs.writeFileSync(handle.tokenPath, '0'.repeat(64));
    try {
      await expect(
        runMcodeDaemonCommand({
          request: { action: 'stop' },
          ...commandOptions(home),
        }),
      ).rejects.toThrow(/UNAUTHORIZED/);
    } finally {
      // Restore the real token so the afterEach cleanup can still stop the
      // daemon gracefully.
      fs.writeFileSync(handle.tokenPath, realToken);
    }
  }, 30_000);
});

describe('daemon stop/restart: the live-runs drain guard (--force)', () => {
  /**
   * A stub host whose sendMessage opens a turn stream that never completes:
   * the hub registers it in its live-turn registry exactly like a real
   * running turn, so the daemon reports it as an active run.
   */
  function makeStreamingStubHost() {
    return async (options: CreateLocalRuntimeHostOptions) =>
      ({
        dataDir: options.dataDir,
        ready: Promise.resolve(),
        apiHost: { close: async () => undefined, ensureBuiltinAgents: async () => undefined },
        metricsClient: { close: async () => undefined },
        cliService: {
          createSession: async () => ({ sessionId: 'sess-cmd' }),
          sendMessage: async () => ({
            ok: true,
            source: (async function* neverEndingTurn() {
              await new Promise(() => undefined); // the turn never finishes
              yield { type: 'unreachable' } as never; // require-yield; never reached
            })(),
          }),
        } as unknown as CliService,
      }) as unknown as CreatedLocalRuntimeHost;
  }

  /** Boot a daemon whose CliService keeps turn streams open forever. */
  async function startStreamingDaemon(home: string): Promise<ProductDaemonHandle> {
    return startProductDaemon({
      argv: [],
      env: {
        [MCODE_SERVER_MODE_ENV]: 'auto',
        MAVIS_REGION: 'en',
        MAVIS_BUILD_ENV: 'prod',
        HOME: home,
      } as NodeJS.ProcessEnv,
      homeDir: home,
      createHost: makeStreamingStubHost(),
    });
  }

  /** Open one live turn stream on the daemon (a client window mid-run). */
  async function openLiveRun(
    handle: ProductDaemonHandle,
    sessionId: string,
  ): Promise<McodedClient> {
    const client = new McodedClient({
      socketPath: handle.daemon.socketPath,
      handshake: {
        token: readDaemonToken(handle.controlRoot),
        dataDir: handle.dataDir,
        env: { region: 'en', buildEnv: 'prod' },
      },
    });
    await client.connect();
    await client.openStream('sendMessage', [{ id: sessionId, message: 'still running' }]);
    return client;
  }

  /** Same spawn seam as the restart describe: a real in-process child. */
  function makeSpawnSeam(home: string) {
    const spawned: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const boots: Array<Promise<ProductDaemonHandle>> = [];
    const stubHost = makeStubHost();
    const spawnDaemon = ({ argv, env }: { argv: readonly string[]; env: NodeJS.ProcessEnv }) => {
      spawned.push({ argv, env });
      const dataDir = argv[argv.indexOf('--data-dir') + 1] as string;
      boots.push(
        startProductDaemon({
          argv: ['--data-dir', dataDir],
          env,
          homeDir: home,
          createHost: stubHost,
        }).then((handle) => {
          activeHandles.push(handle);
          return handle;
        }),
      );
      return { unref: () => undefined, pid: 424242 };
    };
    return { spawnDaemon, spawned, boots };
  }

  /**
   * The refusal is THROWN (not returned): main.ts's catch turns it into a
   * stderr diagnostic with `processRef.exitCode = 1` — a refusal a script
   * could read as success would defeat the guard.
   */
  async function captureRefusal(run: () => Promise<string>): Promise<DaemonDrainRefusalError> {
    const captured = await run().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(captured).toBeInstanceOf(DaemonDrainRefusalError);
    return captured as DaemonDrainRefusalError;
  }

  it('stop without --force refuses (thrown, exit-code path) while a run is live; the daemon stays up', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startStreamingDaemon(home);
    activeHandles.push(handle);
    const client = await openLiveRun(handle, 'sess-live-2543');
    try {
      const refusal = await captureRefusal(() =>
        runMcodeDaemonCommand({
          request: { action: 'stop' },
          ...commandOptions(home),
        }),
      );
      expect(refusal.report).toContain('refusing to stop without --force');
      expect(refusal.report).toContain('sess-live-2543 running');
      expect(refusal.report).toContain('mcode daemon stop --force');
      // Nothing was killed: the daemon still answers its handshake.
      const probe = await helloDaemon(handle.daemon.socketPath, {
        token: readDaemonToken(handle.controlRoot),
        dataDir: handle.dataDir,
        env: { region: 'en', buildEnv: 'prod' },
      });
      expect(probe.ok).toBe(true);
    } finally {
      client.close();
    }
  }, 30_000);

  it('stop --force shuts the daemon down despite live runs', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startStreamingDaemon(home);
    activeHandles.push(handle);
    const client = await openLiveRun(handle, 'sess-live-1168');
    try {
      const report = await runMcodeDaemonCommand({
        request: { action: 'stop', force: true },
        ...commandOptions(home),
      });
      expect(report).toContain('mcoded stopped');
      await handle.done;
    } finally {
      client.close();
    }
  }, 30_000);

  it('stop with no live runs goes through without --force', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startProductDaemon({
      argv: [],
      env: {
        [MCODE_SERVER_MODE_ENV]: 'auto',
        MAVIS_REGION: 'en',
        MAVIS_BUILD_ENV: 'prod',
        HOME: home,
      } as NodeJS.ProcessEnv,
      homeDir: home,
      createHost: makeStubHost(),
    });
    activeHandles.push(handle);
    const report = await runMcodeDaemonCommand({
      request: { action: 'stop' },
      ...commandOptions(home),
    });
    expect(report).toContain('mcoded stopped');
    await handle.done;
  }, 30_000);

  it('restart without --force refuses while a run is live and spawns nothing', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startStreamingDaemon(home);
    activeHandles.push(handle);
    const client = await openLiveRun(handle, 'sess-restart-guard');
    const { spawnDaemon, spawned } = makeSpawnSeam(home);
    try {
      const refusal = await captureRefusal(() =>
        runMcodeDaemonCommand({
          request: { action: 'restart', waitTimeoutMs: 5_000 },
          ...commandOptions(home),
          spawnDaemon,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        }),
      );
      expect(refusal.report).toContain('refusing to restart without --force');
      expect(refusal.report).toContain('sess-restart-guard running');
      expect(refusal.report).toContain('mcode daemon restart --force');
      // The refusal precedes the whole orchestration: no child was spawned.
      expect(spawned).toHaveLength(0);
      const probe = await helloDaemon(handle.daemon.socketPath, {
        token: readDaemonToken(handle.controlRoot),
        dataDir: handle.dataDir,
        env: { region: 'en', buildEnv: 'prod' },
      });
      expect(probe.ok).toBe(true);
    } finally {
      client.close();
    }
  }, 30_000);

  it('restart --force replaces the daemon despite live runs', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startStreamingDaemon(home);
    activeHandles.push(handle);
    const client = await openLiveRun(handle, 'sess-restart-force');
    const { spawnDaemon, boots } = makeSpawnSeam(home);
    try {
      const report = await runMcodeDaemonCommand({
        request: { action: 'restart', force: true, waitTimeoutMs: 20_000 },
        ...commandOptions(home),
        spawnDaemon,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      });
      expect(report).toContain('mcoded restarted');
      await Promise.all(boots);
    } finally {
      client.close();
    }
  }, 60_000);
});

/**
 * The guard's fail-closed half (bug 9 of the opus review of 2026-11-03): the
 * old guard read a failed/odd probe as "no runs" and killed live work. A fake
 * daemon socket exercises the probe outcomes a live busy daemon produces —
 * the probe timing out, a response without the `activeRuns` array — without
 * needing the real hub to misbehave.
 */
describe('daemon drain guard: fail-closed probe outcomes', () => {
  /**
   * A minimal frame-speaking daemon on the REAL control root's socket path
   * (the real daemon was stopped first, so the path is free): answers the
   * `hello` handshake, then handles `daemon.status`/`shutdown` per test.
   */
  function startFakeDaemon(
    socketPath: string,
    onStatus: () => { readonly silence?: boolean; readonly data?: unknown },
  ): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            handleLine(line, socket);
          }
        });
        const handleLine = (line: string) => {
          let frame: { type?: string };
          try {
            frame = JSON.parse(line) as { type?: string };
          } catch {
            return;
          }
          if (frame.type === 'hello') {
            socket.write(
              `${serializeFrame({ type: 'response', command: 'hello', success: true, data: {} })}\n`,
            );
            return;
          }
          if (frame.type === 'daemon.status') {
            const outcome = onStatus();
            // Silence = the probe's 2 s budget expires: a daemon too busy to
            // answer its management plane (the owner-incident shape).
            if (outcome.silence) return;
            socket.write(
              `${serializeFrame({
                type: 'response',
                command: 'daemon.status',
                success: true,
                data: outcome.data,
              })}\n`,
            );
            return;
          }
          if (frame.type === 'shutdown') {
            socket.write(
              `${serializeFrame({
                type: 'response',
                command: 'shutdown',
                success: true,
                data: { accepted: true },
              })}\n`,
            );
            socket.write(`${serializeFrame({ type: 'bye' })}\n`);
            socket.end();
          }
        };
      });
      server.once('error', reject);
      server.listen(socketPath, () => resolve(server));
    });
  }

  /** Boot a real daemon for its control root, stop it, fake its socket. */
  async function withFakeDaemonSocket(
    home: string,
    onStatus: () => { readonly silence?: boolean; readonly data?: unknown },
    run: (socketPath: string) => Promise<void>,
  ): Promise<void> {
    const handle = await startProductDaemon({
      argv: [],
      env: {
        [MCODE_SERVER_MODE_ENV]: 'auto',
        MAVIS_REGION: 'en',
        MAVIS_BUILD_ENV: 'prod',
        HOME: home,
      } as NodeJS.ProcessEnv,
      homeDir: home,
      createHost: makeStubHost(),
    });
    const socketPath = handle.daemon.socketPath;
    await handle.stop();
    const server = await startFakeDaemon(socketPath, onStatus);
    try {
      await run(socketPath);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('refuses when the status probe times out (a busy daemon), without --force', async () => {
    const home = tempHomes.at(-1) as string;
    await withFakeDaemonSocket(home, () => ({ silence: true }), async () => {
      const err = await runMcodeDaemonCommand({
        request: { action: 'stop' },
        ...commandOptions(home),
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(DaemonDrainRefusalError);
      expect((err as DaemonDrainRefusalError).report).toContain(
        'cannot verify mcoded (pid',
      );
      expect((err as DaemonDrainRefusalError).report).toContain('refusing to stop without --force');
    });
  }, 30_000);

  it('refuses on a response without activeRuns but activeTurns > 0 (older daemon)', async () => {
    const home = tempHomes.at(-1) as string;
    await withFakeDaemonSocket(home, () => ({ data: { activeTurns: 2 } }), async () => {
      const err = await runMcodeDaemonCommand({
        request: { action: 'stop' },
        ...commandOptions(home),
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(DaemonDrainRefusalError);
      expect((err as DaemonDrainRefusalError).report).toContain('2 active turns');
      expect((err as DaemonDrainRefusalError).report).toContain('refusing to stop without --force');
    });
  }, 30_000);

  it('refuses when the response carries neither activeRuns nor activeTurns', async () => {
    const home = tempHomes.at(-1) as string;
    await withFakeDaemonSocket(home, () => ({ data: {} }), async () => {
      const err = await runMcodeDaemonCommand({
        request: { action: 'restart', waitTimeoutMs: 5_000 },
        ...commandOptions(home),
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(DaemonDrainRefusalError);
      expect((err as DaemonDrainRefusalError).report).toContain(
        'neither activeRuns nor activeTurns',
      );
      expect((err as DaemonDrainRefusalError).report).toContain(
        'refusing to restart without --force',
      );
    });
  }, 30_000);

  it('proceeds when the probe proves idleness: activeTurns 0 without activeRuns', async () => {
    const home = tempHomes.at(-1) as string;
    await withFakeDaemonSocket(home, () => ({ data: { activeTurns: 0 } }), async () => {
      const report = await runMcodeDaemonCommand({
        request: { action: 'stop' },
        ...commandOptions(home),
      });
      expect(report).toContain('mcoded stopped');
    });
  }, 30_000);

  it('proceeds on a provably dead socket (ENOENT): nothing alive to kill', async () => {
    const home = tempHomes.at(-1) as string;
    const handle = await startProductDaemon({
      argv: [],
      env: {
        [MCODE_SERVER_MODE_ENV]: 'auto',
        MAVIS_REGION: 'en',
        MAVIS_BUILD_ENV: 'prod',
        HOME: home,
      } as NodeJS.ProcessEnv,
      homeDir: home,
      createHost: makeStubHost(),
    });
    activeHandles.push(handle);
    await handle.stop();
    // The manifest survives (state `stopped`), the socket is gone: the guard
    // lets the shutdown through and it reports the real state.
    const report = await runMcodeDaemonCommand({
      request: { action: 'stop' },
      ...commandOptions(home),
    });
    expect(report).toContain('mcoded is not running');
  }, 30_000);
});

/**
 * The stale-lock surface (owner requirement 2026-11-06): a crashed daemon
 * leaves `mcoded.lock` (and sometimes the socket file) behind; `status` must
 * NAME the debris and the recovery command, and `recover` must clean it —
 * while a lock naming a LIVE holder is never touched (fail-closed, the
 * spawn-race channel of 2026-11-04 stays shut).
 */
describe('mcode daemon recover (stale-lock debris, owner 2026-11-06)', () => {
  /** A pid that is guaranteed dead: one of a child that already exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    return pid as number;
  }

  it('status names the stale lock of a dead pid and the exact recover command', async () => {
    const home = tempHomes.at(-1) as string;
    const controlRoot = resolveDurableRoot(null, home);
    fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
    const dead = deadPid();
    fs.writeFileSync(
      path.join(controlRoot, 'mcoded.lock'),
      JSON.stringify({ pid: dead, startedAtMs: 0 }),
    );

    const report = await runMcodeDaemonCommand({
      request: { action: 'status' },
      ...commandOptions(home),
    });
    expect(report).toContain('mcoded is not running');
    expect(report).toContain(`stale lock from dead pid ${dead}`);
    expect(report).toContain('mcode daemon recover');

    const json = JSON.parse(
      await runMcodeDaemonCommand({
        request: { action: 'status', json: true },
        ...commandOptions(home),
      }),
    ) as { running: boolean; staleLock: { holderPid: number } | null };
    expect(json.running).toBe(false);
    expect(json.staleLock).toEqual({ holderPid: dead });
  }, 30_000);

  it('recover removes the dead holder lock and the stale socket file', async () => {
    const home = tempHomes.at(-1) as string;
    const controlRoot = resolveDurableRoot(null, home);
    fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
    const dead = deadPid();
    const lockPath = path.join(controlRoot, 'mcoded.lock');
    const socketPath = path.join(controlRoot, 'mcoded.sock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, startedAtMs: 0 }));
    fs.writeFileSync(socketPath, 'stale socket debris');

    const report = await runMcodeDaemonCommand({
      request: { action: 'recover' },
      ...commandOptions(home),
    });
    expect(report).toContain(`removed stale lock of dead pid ${dead}`);
    expect(report).toContain('removed stale socket file');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  }, 30_000);

  it('recover never touches a lock held by a LIVE pid', async () => {
    const home = tempHomes.at(-1) as string;
    const controlRoot = resolveDurableRoot(null, home);
    fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
    const lockPath = path.join(controlRoot, 'mcoded.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }),
    );

    const report = await runMcodeDaemonCommand({
      request: { action: 'recover' },
      ...commandOptions(home),
    });
    expect(report).toContain(`LIVE pid ${process.pid}`);
    expect(report).not.toContain('removed');
    expect(readLockHolderPid(lockPath)).toBe(process.pid);
  }, 30_000);

  it('recover on a quiet root reports nothing to recover', async () => {
    const home = tempHomes.at(-1) as string;
    const report = await runMcodeDaemonCommand({
      request: { action: 'recover' },
      ...commandOptions(home),
    });
    expect(report).toContain('mcoded.lock: absent');
    expect(report).toContain('nothing to recover');
  }, 30_000);

  it('the --profile selector is carried into the recover advice of status', async () => {
    const home = tempHomes.at(-1) as string;
    const dead = deadPid();
    // Recover first resolves (and reports) the profile control root, then
    // status for the same profile names the debris under it.
    const recoverReport = await runMcodeDaemonCommand({
      request: { action: 'recover', profile: 'work' },
      ...commandOptions(home),
    });
    const controlRoot = /control root: (.+)/u.exec(recoverReport)?.[1];
    expect(controlRoot).toBeTruthy();
    fs.mkdirSync(controlRoot as string, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(controlRoot as string, 'mcoded.lock'),
      JSON.stringify({ pid: dead, startedAtMs: 0 }),
    );

    const report = await runMcodeDaemonCommand({
      request: { action: 'status', profile: 'work' },
      ...commandOptions(home),
    });
    expect(report).toContain('stale lock from dead pid');
    expect(report).toContain('mcode daemon recover --profile work');
  }, 30_000);
});

describe('program registration', () => {
  function parse(program: Command, args: string[]): Promise<Error | undefined> {
    return program
      .parseAsync(args, { from: 'node' })
      .then(() => undefined)
      .catch((error: Error) => error);
  }

  it('wires daemon run|status|stop|restart to the runner with parsed options', async () => {
    const runDaemon = vi.fn(async () => undefined);
    const program = createTuiProgram({
      version: 'test',
      launchTui: async () => undefined,
      runExec: async () => undefined,
      runDaemon,
    });
    const error = await parse(program, ['node', 'mcode', 'daemon', 'status', '--json']);
    expect(error).toBeUndefined();
    expect(runDaemon).toHaveBeenCalledWith({ action: 'status', json: true });

    await parse(program, ['node', 'mcode', 'daemon', 'run', '--data-dir', '/tmp/dd']);
    expect(runDaemon).toHaveBeenCalledWith({ action: 'run', dataDir: '/tmp/dd' });

    await parse(program, ['node', 'mcode', 'daemon', 'stop']);
    expect(runDaemon).toHaveBeenLastCalledWith({ action: 'stop' });

    await parse(program, ['node', 'mcode', 'daemon', 'restart']);
    expect(runDaemon).toHaveBeenLastCalledWith({ action: 'restart' });

    await parse(program, ['node', 'mcode', 'daemon', 'stop', '--force']);
    expect(runDaemon).toHaveBeenLastCalledWith({ action: 'stop', force: true });

    await parse(program, ['node', 'mcode', 'daemon', 'restart', '--force']);
    expect(runDaemon).toHaveBeenLastCalledWith({ action: 'restart', force: true });

    await parse(program, ['node', 'mcode', 'daemon', 'recover']);
    expect(runDaemon).toHaveBeenLastCalledWith({ action: 'recover' });
  });

  it('gives every daemon subcommand the global --profile flag', async () => {
    const runDaemon = vi.fn(async () => undefined);
    const program = createTuiProgram({
      version: 'test',
      launchTui: async () => undefined,
      runExec: async () => undefined,
      runDaemon,
    });
    const error = await parse(program, ['node', 'mcode', 'daemon', 'status', '--profile', 'work']);
    expect(error).toBeUndefined();
    expect(runDaemon).toHaveBeenCalledOnce();
  });

  it('passes the nearest explicit --profile to the runner wherever it is written', async () => {
    const runDaemon = vi.fn(async () => undefined);
    const program = createTuiProgram({
      version: 'test',
      launchTui: async () => undefined,
      runExec: async () => undefined,
      runDaemon,
    });
    await parse(program, ['node', 'mcode', 'daemon', 'status', '--profile', 'default']);
    expect(runDaemon).toHaveBeenLastCalledWith({ action: 'status', profile: 'default' });

    await parse(program, ['node', 'mcode', '--profile', 'work', 'daemon', 'restart']);
    expect(runDaemon).toHaveBeenLastCalledWith({ action: 'restart', profile: 'work' });

    await parse(program, ['node', 'mcode', 'daemon', '--profile', 'work', 'recover']);
    expect(runDaemon).toHaveBeenLastCalledWith({ action: 'recover', profile: 'work' });
  });
});
