import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import {
  MCODE_SERVER_MODE_ENV,
  getRuntimeBuildEnv,
  ensureControlRootLayout,
  getRuntimeRegion,
  resolveDurableRoot,
  resolveMcodedSocketPath,
} from '@mavis/config';
import {
  MCODED_LOCK_BASENAME,
  MCODED_LOG_DIR_BASENAME,
  helloDaemon,
  isPidAlive,
  listDaemonActiveRuns,
  openDaemonLogFd,
  readDaemonManifest,
  readDaemonToken,
  readLockHolderPid,
  recoverStaleFileLock,
  requestDaemonShutdown,
  resolveDaemonTargets,
  startProductDaemon,
  type DaemonManifest,
  type DaemonTargets,
} from '@mavis/mcoded';

import { createEmbeddedRuntimeHost } from '../runtime/embedded-host.js';

export type McodeDaemonAction = 'run' | 'status' | 'stop' | 'restart' | 'recover';

/** Request of one `mcode daemon <action>` invocation. */
export interface McodeDaemonCliRequest {
  readonly action: McodeDaemonAction;
  /** Profile selector (`--profile`, applied to every command by the program). */
  readonly profile?: string;
  /** Data directory override (`--data-dir`). */
  readonly dataDir?: string;
  /** `status --json`: machine-readable output. */
  readonly json?: boolean;
  /**
   * `stop|restart --force`: shut down even when runs are active. Without it
   * the command is fail-closed: live turn streams (running or detached-
   * draining) refuse the shutdown and are listed instead (the owner incident
   * of 2026-11-03 — a plain `daemon restart` killed two 20-40 min runs).
   */
  readonly force?: boolean;
  /** Bounded wait for readiness after a restart spawn. Default 20 s (§4.6.2 п.3). */
  readonly waitTimeoutMs?: number;
}

/** Test seams of the daemon command (filesystem via homeDir/env, spawn, timers). */
export interface RunMcodeDaemonCommandOptions {
  readonly request: McodeDaemonCliRequest;
  /** Home directory for profile/dataDir resolution (tests override this). */
  readonly homeDir?: string;
  /** Environment; defaults to `process.env`. */
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Spawn seam; defaults to a detached child with stdio in
   * `<controlRoot>/logs`. The O_APPEND log fd (`openDaemonLogFd`, design 15)
   * is opened by the command BEFORE this seam, so test seams see the same
   * child env the real child gets — including `MCODED_LOG_FILE`.
   */
  readonly spawnDaemon?: (options: {
    argv: readonly string[];
    env: NodeJS.ProcessEnv;
    logFd: number;
  }) => {
    readonly unref: () => void;
    readonly pid?: number;
  };
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Bounded wait for a freshly spawned daemon to answer hello (§4.6.2 п.3). */
const DEFAULT_RESTART_WAIT_TIMEOUT_MS = 20_000;

/**
 * The env identity the daemon's CLIENT sessions (the window, exec) present in
 * every v2 hello (arch §4.3.2, R6): the daemon serves one auth namespace, so
 * a client session must prove the same region/buildEnv it wants to work in.
 */
function clientEnvIdentity(): { region: string; buildEnv: string } {
  return { region: getRuntimeRegion(), buildEnv: getRuntimeBuildEnv() };
}

/**
 * The env identity the MANAGEMENT commands (status/stop/restart) present in
 * their hello: the identity of the DAEMON being managed, read off its
 * manifest (opus 2026-11-02, мина 2 — `daemon stop` used to be refused with
 * ENV_MISMATCH whenever the caller's region differed). The handshake env
 * check is not a security boundary — reaching the socket at all is decided
 * by the control root (0700) plus its token and the dataDir — so management
 * speaks the daemon's own identity; client sessions keep the exact guard.
 * A manifest written before these fields existed (no region/buildEnv on
 * disk) falls back to the caller's identity — the pre-manifest-identity
 * behavior.
 */
function daemonEnvIdentity(manifest: DaemonManifest): { region: string; buildEnv: string } {
  if (typeof manifest.region !== 'string' || typeof manifest.buildEnv !== 'string') {
    return clientEnvIdentity();
  }
  return { region: manifest.region, buildEnv: manifest.buildEnv };
}
const READINESS_POLL_INTERVAL_MS = 200;
const STOP_DRAIN_POLL_INTERVAL_MS = 100;
const STOP_DRAIN_TIMEOUT_MS = 10_000;

/**
 * `mcode daemon run|status|stop|restart|recover` (arch §4.6.7, W2 scope).
 *
 * The composition the arch pins to `tui` lives here: `run` boots the daemon
 * through {@link startProductDaemon} with the in-process TUI host factory
 * (`createEmbeddedRuntimeHost`, `runtimeOwnerKind: 'tui'`), so the daemon
 * serves with the same host policy as the window. Returns the human-readable
 * report; `run` resolves only after the daemon shut down.
 */
export async function runMcodeDaemonCommand(
  options: RunMcodeDaemonCommandOptions,
): Promise<string> {
  const env = options.environment ?? process.env;
  const homeDir = options.homeDir ?? env['HOME'];
  const targets = resolveDaemonTargets({
    profile: options.request.profile,
    dataDir: options.request.dataDir,
    homeDir,
    env,
  });
  switch (options.request.action) {
    case 'run':
      return runForeground(options, env, homeDir);
    case 'status':
      return status(targets, options, env, homeDir);
    case 'stop':
      return stop(targets, options);
    case 'restart':
      return restart(targets, options, env);
    case 'recover':
      return recover(targets);
  }
}

/** `daemon run`: this process becomes the daemon (the §4.8 gate applies). */
async function runForeground(
  options: RunMcodeDaemonCommandOptions,
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
): Promise<string> {
  // Revision 11 F2: the daemon-owned mcode-tools readiness resolves BEFORE
  // the host factory runs (product-daemon composes it before adapter start),
  // so the projection below pins the prompt surface to the broker THIS
  // daemon actually owns — never to a window that may already be gone.
  let mcodeToolsReady = false;
  const handle = await startProductDaemon({
    argv: [
      ...(options.request.profile ? ['--profile', options.request.profile] : []),
      ...(options.request.dataDir ? ['--data-dir', options.request.dataDir] : []),
    ],
    env,
    ...(homeDir !== undefined ? { homeDir } : {}),
    onMcodeToolsReadiness: (readiness) => {
      mcodeToolsReady = readiness.ready;
    },
    // Arch §4.1: the product composition (host kind 'tui') lives in tui —
    // the daemon serves through the SAME host factory the window uses.
    createHost: (hostOptions) =>
      createEmbeddedRuntimeHost({
        ...hostOptions,
        ...(mcodeToolsReady ? { productCapabilities: { mcodeTools: true } } : {}),
      }),
  });
  await handle.done;
  return `mcoded stopped (socket ${handle.daemon.socketPath})`;
}

/** `daemon status`: manifest + live hello probe of the control root. */
async function status(
  targets: DaemonTargets,
  options: RunMcodeDaemonCommandOptions,
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
): Promise<string> {
  const manifest = readDaemonManifest(targets.controlRoot);
  const token = readDaemonToken(targets.controlRoot);
  // The probe presents the DAEMON's env identity (its manifest), not the
  // caller's: `status` must diagnose a live daemon even when the caller's
  // region differs — and report the difference instead of failing.
  const servedEnv = manifest === undefined ? undefined : daemonEnvIdentity(manifest);
  const probe =
    manifest === undefined || servedEnv === undefined
      ? undefined
      : await helloDaemon(manifest.socketPath, {
          ...(token !== undefined ? { token } : {}),
          dataDir: targets.dataDir,
          env: servedEnv,
          timeoutMs: 2_000,
        });
  const legacyRoot = resolveDurableRoot(targets.profile, homeDir ?? env['HOME']);
  const legacyDataPath = legacyDaemonDataPath(legacyRoot);
  const staleLock = staleMcodedLock(targets.controlRoot);

  const report = {
    running: probe?.ok === true,
    controlRoot: targets.controlRoot,
    dataDir: targets.dataDir,
    profile: targets.profile,
    manifest: manifest ?? null,
    probeError: probe && !probe.ok ? probe.error : null,
    holderAlive: manifest ? isPidAlive(manifest.pid) : null,
    staleLock,
    legacyDataPath,
  };
  if (options.request.json) return JSON.stringify(report, null, 2);

  const staleLockLine = staleLock ? staleLockAdvice(staleLock.holderPid, targets.profile) : null;
  if (!manifest) {
    return [
      `mcoded is not running`,
      `  control root: ${targets.controlRoot}`,
      `  data dir:     ${targets.dataDir}`,
      ...(legacyDataPath ? [`  legacy daemon data present: ${legacyDataPath} (not used)`] : []),
      ...(staleLockLine ? [`  ${staleLockLine}`] : []),
    ].join('\n');
  }
  if (probe?.ok) {
    // The daemon's env line carries the caller's identity as a suffix when
    // they differ — the diagnostics a region-mismatched `stop` used to need
    // (`env: region=cn (your env: en)`, canon 2026-11-02).
    const callerEnv = clientEnvIdentity();
    const served = servedEnv ?? callerEnv;
    const envSuffix =
      served.region === callerEnv.region && served.buildEnv === callerEnv.buildEnv
        ? ''
        : ` (your env: region=${callerEnv.region} buildEnv=${callerEnv.buildEnv})`;
    return [
      `mcoded is running (state: ${manifest.state})`,
      `  pid:        ${manifest.pid}`,
      `  socket:     ${manifest.socketPath}`,
      `  data dir:   ${manifest.dataDir}`,
      `  profile:    ${manifest.profile ?? 'default'}`,
      `  env:        region=${manifest.region} buildEnv=${manifest.buildEnv}${envSuffix}`,
      `  protocol:   v${manifest.protocol}`,
      `  started at: ${manifest.startedAt}`,
      ...(legacyDataPath ? [`  legacy daemon data present: ${legacyDataPath} (not used)`] : []),
    ].join('\n');
  }
  return [
    `mcoded is not responding (manifest state: ${manifest.state})`,
    `  pid:      ${manifest.pid} (${isPidAlive(manifest.pid) ? 'alive but not answering' : 'gone'})`,
    `  socket:   ${manifest.socketPath}`,
    `  error:    ${probe && !probe.ok ? probe.error : 'probe not attempted'}`,
    ...(staleLockLine ? [`  ${staleLockLine}`] : []),
  ].join('\n');
}

/**
 * The stale-lock diagnosis of a control root (owner requirement 2026-11-06):
 * `mcoded.lock` present while nothing provably live holds it — a dead
 * holder's pid, or an unparsable record (kill -9 debris). `null` when the
 * lock is absent or names a live process (a live daemon's own lock is never
 * stale). Purely diagnostic: a live holder is never reported stale, and the
 * actual removal belongs to `daemon recover` (or the daemon's own start
 * self-heal).
 */
function staleMcodedLock(controlRoot: string): { holderPid: number | null } | null {
  const lockPath = path.join(controlRoot, MCODED_LOCK_BASENAME);
  try {
    fs.statSync(lockPath);
  } catch {
    return null;
  }
  const holderPid = readLockHolderPid(lockPath);
  if (holderPid !== undefined && isPidAlive(holderPid)) return null;
  return { holderPid: holderPid ?? null };
}

/** The owner-mandated advice line naming the exact recovery command. */
function staleLockAdvice(holderPid: number | null, profile: string | null): string {
  const recoverCommand = `mcode daemon recover${profile ? ` --profile ${profile}` : ''}`;
  return holderPid === null
    ? `stale lock (unparsable record) — run \`${recoverCommand}\``
    : `stale lock from dead pid ${holderPid} — run \`${recoverCommand}\``;
}

/**
 * `daemon recover` (owner requirement 2026-11-06): the explicit manual form
 * of the stale-lock cleanup the daemon start now also performs by itself.
 *
 * Fail-closed exactly like the shared recovery: a lock whose record names a
 * LIVE pid (a daemon that may genuinely be serving right now) is never
 * touched, and neither is its socket — the report says so. Dead/unparsable
 * lock debris is removed through {@link recoverStaleFileLock} (the
 * inode-guarded offline recovery), and a socket file that nothing answers on
 * — the crashed daemon's other leftover — is unlinked with it. Anything
 * removed is named in the report; nothing removed keeps the root untouched.
 */
async function recover(targets: DaemonTargets): Promise<string> {
  const lockPath = path.join(targets.controlRoot, MCODED_LOCK_BASENAME);
  const socketPath = resolveMcodedSocketPath(targets.controlRoot);
  const lines: string[] = [`control root: ${targets.controlRoot}`];

  const holderPid = readLockHolderPid(lockPath);
  const lockPresent = fs.existsSync(lockPath);
  if (lockPresent && holderPid !== undefined && isPidAlive(holderPid)) {
    return [
      `nothing recovered — mcoded.lock is held by LIVE pid ${holderPid}`,
      ...lines,
      `  a live daemon owns this root; use \`mcode daemon stop\` instead`,
    ].join('\n');
  }

  if (!lockPresent) {
    lines.push(`mcoded.lock: absent (nothing to recover)`);
  } else if (holderPid === undefined) {
    const removed = recoverStaleFileLock(lockPath);
    lines.push(
      removed
        ? `mcoded.lock: removed unparsable debris (torn record)`
        : `mcoded.lock: unparsable debris could NOT be removed (changed while recovering)`,
    );
  } else {
    const removed = recoverStaleFileLock(lockPath);
    lines.push(
      removed
        ? `mcoded.lock: removed stale lock of dead pid ${holderPid}`
        : `mcoded.lock: stale lock of dead pid ${holderPid} could NOT be removed (changed while recovering)`,
    );
  }

  // The socket is only touched when no live holder owns the root (proven
  // above): a socket that still answers means something is serving — hands
  // off regardless of what the (now gone) lock said.
  let socketHandled: string | undefined;
  if (fs.existsSync(socketPath)) {
    if (await socketAnswers(socketPath)) {
      socketHandled = `socket ${socketPath}: still answers — left untouched (a daemon is serving)`;
    } else {
      try {
        fs.unlinkSync(socketPath);
        socketHandled = `socket ${socketPath}: removed stale socket file (nothing answered)`;
      } catch (error) {
        socketHandled = `socket ${socketPath}: could not be removed (${(error as Error).message})`;
      }
    }
  } else {
    socketHandled = `socket ${socketPath}: absent (nothing to recover)`;
  }
  lines.push(`  ${socketHandled}`);

  return [`mcoded recover report`, ...lines].join('\n');
}

/** Probe whether anything accepts connections on the existing socket file. */
function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      probe.destroy();
      resolve(false);
    });
  });
}

/**
 * A fail-closed drain-guard refusal (`daemon stop|restart` without `--force`
 * while the daemon may still own live runs). Thrown — not returned — so the
 * CLI reports it on stderr with a NON-ZERO exit code (`processRef.exitCode`
 * in main.ts's catch): a refusal a script can silently swallow as success
 * would defeat the guard.
 */
export class DaemonDrainRefusalError extends Error {
  constructor(readonly report: string) {
    super(report);
    this.name = 'DaemonDrainRefusalError';
  }
}

/** `daemon stop`: graceful shutdown over the socket (§4.6.7). */
async function stop(targets: DaemonTargets, options: RunMcodeDaemonCommandOptions): Promise<string> {
  const manifest = readDaemonManifest(targets.controlRoot);
  if (!manifest) {
    return `mcoded is not running (no daemon manifest in ${targets.controlRoot})`;
  }
  // Fail-closed drain guard: live runs refuse the shutdown without --force.
  const busy = await activeRunsRefusal(targets, manifest, options.request.force, 'stop');
  if (busy) throw new DaemonDrainRefusalError(busy);
  // The management hello presents the DAEMON's manifest identity (see
  // daemonEnvIdentity): a caller in another region must still reach the
  // graceful stop of its own daemon. Token + dataDir stay exact.
  const outcome = await requestDaemonShutdown(manifest.socketPath, {
    token: readDaemonToken(targets.controlRoot),
    dataDir: targets.dataDir,
    env: daemonEnvIdentity(manifest),
    timeoutMs: 10_000,
  });
  if (outcome.ok) return `mcoded stopped (pid ${manifest.pid})`;
  if (outcome.errno === 'ENOENT' || outcome.errno === 'ECONNREFUSED') {
    return `mcoded is not running (socket ${manifest.socketPath} does not answer)`;
  }
  throw new Error(`Failed to stop mcoded: ${outcome.errorCode ?? ''} ${outcome.error}`.trim());
}

/**
 * The drain guard (owner incident 2026-11-03): a `stop`/`restart` must not
 * kill live turn streams — running or detached-draining — without an explicit
 * `--force`. Asks the daemon for its `daemon.status` `activeRuns` under the
 * manifest identity (the same handshake the shutdown itself would use) and
 * returns the refusal text while idleness is not PROVEN; `undefined` lets the
 * shutdown proceed.
 *
 * Fail-closed by design: a probe that cannot verify idleness (timeout under a
 * busy daemon, handshake refusal, a response without the `activeRuns` array)
 * refuses instead of proceeding — the shutdown of a daemon that MIGHT own
 * 20-40 min runs is exactly what the guard exists to gate. The only probe
 * failure allowed through is a provably dead socket (`ENOENT`/`ECONNREFUSED`:
 * nothing is listening, so there is nothing alive to kill; the shutdown
 * request below then reports the real state itself). A response without
 * `activeRuns` (an older daemon) falls back to its `activeTurns` counter;
 * without even that, the guard refuses.
 */
async function activeRunsRefusal(
  targets: DaemonTargets,
  manifest: DaemonManifest,
  force: boolean | undefined,
  action: 'stop' | 'restart',
): Promise<string | undefined> {
  if (force) return undefined;
  const active = await listDaemonActiveRuns(manifest.socketPath, {
    token: readDaemonToken(targets.controlRoot),
    dataDir: targets.dataDir,
    env: daemonEnvIdentity(manifest),
    timeoutMs: 2_000,
  });
  if (!active.ok) {
    if (active.errno === 'ENOENT' || active.errno === 'ECONNREFUSED') return undefined;
    return [
      `cannot verify mcoded (pid ${manifest.pid}) is idle; refusing to ${action} without --force`,
      `  status probe failed: ${active.errorCode ? `${active.errorCode}: ` : ''}${active.error}`,
      `Use \`mcode daemon ${action} --force\` to stop anyway (active runs would be killed).`,
    ].join('\n');
  }
  if (active.data.runs.length > 0) {
    const runs = active.data.runs.map(
      (run) => `  ${run.sessionId} running ${formatRunElapsed(run.elapsedMs)} (${run.method})`,
    );
    return [
      `mcoded has ${active.data.runs.length} active run${active.data.runs.length === 1 ? '' : 's'}; ` +
        `refusing to ${action} without --force`,
      ...runs,
      `Use \`mcode daemon ${action} --force\` to stop anyway (active runs will be killed).`,
    ].join('\n');
  }
  if (!active.data.activeRunsReported) {
    // An older daemon: no per-run list. Its `activeTurns` counter is the same
    // registry `activeRuns` derives from — trust it when present.
    const activeTurns = active.data.activeTurns;
    if (activeTurns === undefined) {
      return [
        `cannot verify mcoded (pid ${manifest.pid}) is idle; refusing to ${action} without --force`,
        `  the daemon reported neither activeRuns nor activeTurns`,
        `Use \`mcode daemon ${action} --force\` to stop anyway (active runs would be killed).`,
      ].join('\n');
    }
    if (activeTurns > 0) {
      return [
        `mcoded has ${activeTurns} active turn${activeTurns === 1 ? '' : 's'}; ` +
          `refusing to ${action} without --force`,
        `  (the daemon did not report the per-run list)`,
        `Use \`mcode daemon ${action} --force\` to stop anyway (active runs will be killed).`,
      ].join('\n');
    }
  }
  return undefined;
}

/** Human elapsed of a live run: whole seconds, the shape of a long turn (`2543s`). */
function formatRunElapsed(elapsedMs: number): string {
  return `${Math.max(1, Math.round(elapsedMs / 1000))}s`;
}

/** `daemon restart`: graceful stop of the current life, then a fresh detached spawn. */
async function restart(
  targets: DaemonTargets,
  options: RunMcodeDaemonCommandOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const manifest = readDaemonManifest(targets.controlRoot);
  if (manifest) {
    // Fail-closed drain guard (same as stop): live runs refuse the restart.
    const busy = await activeRunsRefusal(targets, manifest, options.request.force, 'restart');
    if (busy) throw new DaemonDrainRefusalError(busy);
    // The previous life is stopped under ITS manifest identity (see stop) —
    // the fresh daemon below is the one that takes the caller's region.
    const previousEnv = daemonEnvIdentity(manifest);
    const outcome = await requestDaemonShutdown(manifest.socketPath, {
      token: readDaemonToken(targets.controlRoot),
      dataDir: targets.dataDir,
      env: previousEnv,
      timeoutMs: 10_000,
    });
    if (!outcome.ok && outcome.errno !== 'ENOENT' && outcome.errno !== 'ECONNREFUSED') {
      throw new Error(`Failed to stop the previous mcoded: ${outcome.error}`);
    }
    await waitForSocketGone(manifest.socketPath, previousEnv, options);
  }

  // §4.6.2 п.2 start shape: relaunch this CLI (`process.argv[1]`) detached
  // with the data-plane env explicitly fixed. `mcode daemon run` in the
  // child re-applies the SERVER_MODE gate and composes the 'tui' host.
  const script = process.argv[1];
  if (!script) {
    throw new Error('Cannot restart: this process has no entry script (process.argv[1]).');
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    MINIMAX_DATA_DIR: targets.dataDir,
    // The fresh daemon serves the CALLER's normally-resolved env: the CLI
    // startup chain (cli/environment.ts) has already applied env → preference
    // → default to MAVIS_REGION before this command ran, so getRuntimeRegion
    // reads exactly that. Restart is the штатный way to re-region a daemon;
    // the previous life was stopped under its own manifest identity above.
    MAVIS_REGION: getRuntimeRegion(),
    MAVIS_BUILD_ENV: getRuntimeBuildEnv(),
    ...(targets.profile ? { MINIMAX_PROFILE: targets.profile } : {}),
  };
  // A restart is an explicit daemon request: the child `daemon run` must
  // pass the §4.8 gate, so an absent or `off` switch is fixed to `auto` for
  // the child only (the caller's own environment is untouched). A live
  // `required` inherits as-is.
  const childMode = childEnv[MCODE_SERVER_MODE_ENV]?.trim().toLowerCase();
  if (childMode === undefined || childMode === '' || childMode === 'off') {
    childEnv[MCODE_SERVER_MODE_ENV] = 'auto';
  }
  const argv = [
    process.execPath,
    script,
    'daemon',
    'run',
    '--data-dir',
    targets.dataDir,
    ...(targets.profile ? ['--profile', targets.profile] : []),
  ];
  // §4.6.1/R11: the control root must come into existence at 0700 BEFORE the
  // restarter writes anything under it. In a COLD restart this parent is the
  // first process on the path — letting the log-dir mkdir below create it
  // recursively would materialize it at 0755 (0777 & ~umask), permanently
  // weakening the directory barrier the socket security model rests on
  // ("the directory is the real barrier"; a later `run` never re-tights an
  // existing directory). Idempotent; verifies owner + write bits for both
  // the control root and the fallback socket directory.
  ensureControlRootLayout(targets.controlRoot);

  const spawnDaemon =
    options.spawnDaemon ??
    (({
      argv: childArgv,
      env: childEnvOverride,
      logFd,
    }: {
      argv: readonly string[];
      env: NodeJS.ProcessEnv;
      logFd: number;
    }) => {
      const child = spawn(childArgv[0] as string, childArgv.slice(1) as string[], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: childEnvOverride,
      });
      child.unref();
      return child;
    });
  // Design 15: the spawner half of log rotation — pre-rotate an over-ceiling
  // log (М3), open the O_APPEND fd BOTH stdio of the child are handed, and
  // declare `MCODED_LOG_FILE` so the daemon's own copytruncate (М2) knows
  // fd 2 is this exact file.
  const logTarget = openDaemonLogFd(targets.controlRoot, childEnv);
  try {
    spawnDaemon({ argv, env: logTarget.childEnv, logFd: logTarget.fd });
  } finally {
    fs.closeSync(logTarget.fd);
  }

  const ready = await waitForReadiness(targets, options);
  if (!ready.ok) {
    throw new Error(
      `mcoded did not become ready within ${options.request.waitTimeoutMs ?? DEFAULT_RESTART_WAIT_TIMEOUT_MS} ms: ` +
        `${ready.error}. See ${path.join(targets.controlRoot, MCODED_LOG_DIR_BASENAME, 'mcoded.log')}`,
    );
  }
  const fresh = readDaemonManifest(targets.controlRoot);
  return `mcoded restarted (pid ${fresh?.pid ?? '?'}, socket ${ready.socketPath})`;
}

/** Poll until the old socket file stops answering (bounded). */
async function waitForSocketGone(
  socketPath: string,
  env: { region: string; buildEnv: string },
  options: RunMcodeDaemonCommandOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + STOP_DRAIN_TIMEOUT_MS;
  for (;;) {
    // The dying daemon's own manifest identity (the same hello its shutdown
    // accepted): a foreign caller env would be refused with ENV_MISMATCH and
    // stall this drain loop until its timeout instead of ending on
    // ENOENT/ECONNREFUSED.
    const probe = await helloDaemon(socketPath, {
      env,
      timeoutMs: 1_000,
    });
    if (!probe.ok && (probe.errno === 'ENOENT' || probe.errno === 'ECONNREFUSED')) return;
    if (Date.now() > deadline) return;
    await sleep(STOP_DRAIN_POLL_INTERVAL_MS);
  }
}

/** Poll until the fresh daemon answers hello (bounded, §4.6.2 п.3). */
async function waitForReadiness(
  targets: DaemonTargets,
  options: RunMcodeDaemonCommandOptions,
): Promise<{ ok: true; socketPath: string } | { ok: false; error: string }> {
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + (options.request.waitTimeoutMs ?? DEFAULT_RESTART_WAIT_TIMEOUT_MS);
  let lastError = 'socket never appeared';
  for (;;) {
    const manifest = readDaemonManifest(targets.controlRoot);
    if (manifest && manifest.state.startsWith('failed:')) {
      return { ok: false, error: `daemon start failed (${manifest.state})` };
    }
    if (manifest) {
      const probe = await helloDaemon(manifest.socketPath, {
        token: readDaemonToken(targets.controlRoot),
        dataDir: targets.dataDir,
        env: clientEnvIdentity(),
        timeoutMs: 1_000,
      });
      if (probe.ok) return { ok: true, socketPath: manifest.socketPath };
      lastError = probe.error;
    }
    if (Date.now() > deadline) return { ok: false, error: lastError };
    await sleep(READINESS_POLL_INTERVAL_MS);
  }
}

/**
 * Poll cadence for the restart waits. The timer is intentionally REF'D: the
 * CLI process often has no other pending work while it waits (the readiness
 * probe of a not-yet-listening daemon fails with ENOENT and leaves no
 * handles), and an unref'd timer would let the empty event loop tear the
 * process down mid-await ("unsettled top-level await", exit 13) before the
 * restart could report its outcome. The waits are deadline-bounded, so a
 * ref'd timer cannot hang the process — it exits through the normal path.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** W10/W11 artifact dirs of the old durable root, when any remain (§2.3). */
function legacyDaemonDataPath(legacyRoot: string): string | null {
  for (const entry of ['durable-history', 'workspace']) {
    const candidate = path.join(legacyRoot, entry);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // absent — keep looking
    }
  }
  return null;
}
