/**
 * W4 unit tests: the thin-client seams of `runtime/remote-host.ts`.
 *
 * - `resolveTuiServerMode` — `auto` is the default; unknown values fail closed.
 * - `createDaemonAutoSpawnHook` — the §4.6.2 spawn.lock dance: TWO windows
 *   racing produce exactly ONE daemon; a lock holder is a quiet no-op for
 *   the loser; an already-live daemon is never spawned over. The child is
 *   handed the window's RESOLVED identity: the argv always carries
 *   `--profile <name>` (`default` for the implicit one) and the child env
 *   carries exactly one profile selector (login wave 2026-11-02).
 * - `TuiRemoteCliService` — the abort REMAP (`ctx.signal` →
 *   `stream.cancel{mode:'abort'}`, a plain `source.return()` never aborts),
 *   the sync `isGoalEnabled` snapshot seam, and the `replyPermission`
 *   session re-attach.
 * - the honest `daemonConnection` status-line line (never a spinner).
 *
 * @module
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseMcodedArgs, resolveDaemonTargets, McodedRemoteError } from '@mavis/mcoded';
import type { StreamEnd } from '@mavis/mcoded';

import { TuiConversationAccess } from '../../src/runtime/adapters/conversation-access.js';
import {
  createDaemonAutoSpawnHook,
  resolveTuiServerMode,
  TuiRemoteCliService,
  TurnDeliveryRetired,
  TurnStreamDetached,
} from '../../src/runtime/remote-host.js';
import { TuiFailure } from '../../src/failure.js';

describe('resolveTuiServerMode', () => {
  it('defaults to auto when the variable is absent or blank (owner decision 2026-10-29, green 24h soak)', () => {
    expect(resolveTuiServerMode({})).toBe('auto');
    expect(resolveTuiServerMode({ MCODE_SERVER_MODE: '  ' })).toBe('auto');
  });

  it('passes the explicit modes through (case-insensitive)', () => {
    expect(resolveTuiServerMode({ MCODE_SERVER_MODE: 'auto' })).toBe('auto');
    expect(resolveTuiServerMode({ MCODE_SERVER_MODE: ' REQUIRED ' })).toBe('required');
    expect(resolveTuiServerMode({ MCODE_SERVER_MODE: 'Off' })).toBe('off');
  });

  it('fails closed on an unknown value', () => {
    expect(() => resolveTuiServerMode({ MCODE_SERVER_MODE: 'whenever' })).toThrow();
  });
});

describe('createDaemonAutoSpawnHook (§4.6.2 п.2)', () => {
  function rig(aliveSequence: boolean[]) {
    const spawns: Array<{ argv: readonly string[] }> = [];
    let probeIndex = 0;
    const releaseCalls: string[] = [];
    return {
      spawns,
      probe: vi.fn(async () => aliveSequence[probeIndex++] ?? false),
      spawnDaemon: vi.fn(({ argv }: { argv: readonly string[] }) => ({
        unref: () => undefined,
        argv,
      })),
      assertReleased: () => releaseCalls,
      seams: {
        daemonAlive: () => aliveSequence[probeIndex++] ?? false,
        spawnDaemon: (options: { argv: readonly string[] }) => {
          spawns.push(options);
          return { unref: () => undefined };
        },
        sleep: async () => undefined,
      },
    };
  }

  it('two windows racing on a cold root spawn exactly ONE daemon', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-race-'));
    let alive = false;
    const spawnSpy = vi.fn(() => {
      alive = true; // the child "comes up" as soon as it is spawned
      return { unref: () => undefined };
    });
    const seams = {
      daemonAlive: async () => alive,
      spawnDaemon: spawnSpy,
      sleep: async () => undefined,
    };
    const windowA = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: controlRoot, profile: undefined },
      seams,
    });
    const windowB = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: controlRoot, profile: undefined },
      seams,
    });
    await Promise.all([windowA(), windowB()]);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('a loser of the spawn.lock does not spawn (the winner is starting)', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-held-'));
    const spawnSpy = vi.fn(() => ({ unref: () => undefined }));
    const hook = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: controlRoot, profile: undefined },
      seams: {
        daemonAlive: async () => false,
        spawnDaemon: spawnSpy,
        sleep: async () => undefined,
      },
    });
    // Hold the spawn lock as "another window mid-spawn".
    const { acquireFileLock } = await import('@mavis/mcoded');
    const lock = acquireFileLock(join(controlRoot, 'spawn.lock'));
    try {
      await hook(); // must resolve quietly without spawning
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
  });

  it('a live daemon is never spawned over', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-alive-'));
    const spawnSpy = vi.fn(() => ({ unref: () => undefined }));
    const hook = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: controlRoot, profile: undefined },
      seams: { daemonAlive: async () => true, spawnDaemon: spawnSpy, sleep: async () => undefined },
    });
    await hook();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('waits for a live booting daemon instead of spawning over its writer lock', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-booting-'));
    writeFileSync(
      join(controlRoot, 'daemon.json'),
      JSON.stringify({ pid: process.pid, dataDir: controlRoot, state: 'starting' }),
    );
    writeFileSync(join(controlRoot, 'mcoded.lock'), JSON.stringify({ pid: process.pid }));
    const spawnSpy = vi.fn(() => ({ unref: () => undefined }));
    let probes = 0;
    const hook = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: controlRoot, profile: undefined },
      seams: {
        daemonAlive: async () => ++probes > 3,
        spawnDaemon: spawnSpy,
        sleep: async () => undefined,
      },
    });
    await expect(hook()).resolves.toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(probes).toBe(4);
  });

  it('spawns over a stale starting manifest whose pid does not hold the writer lock', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-stale-start-'));
    // A daemon killed mid-boot left `starting`; its pid now names another process.
    writeFileSync(
      join(controlRoot, 'daemon.json'),
      JSON.stringify({ pid: process.pid, dataDir: controlRoot, state: 'starting' }),
    );
    let alive = false;
    const spawnSpy = vi.fn(() => {
      alive = true;
      return { unref: () => undefined };
    });
    const hook = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: controlRoot, profile: undefined },
      seams: { daemonAlive: async () => alive, spawnDaemon: spawnSpy, sleep: async () => undefined },
    });
    await expect(hook()).resolves.toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('reports a spawned daemon still booting past the ready window as booting, not a crash', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-slow-boot-'));
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      let spawned = false;
      let booting = true;
      const seams = {
        daemonAlive: async () => false,
        daemonBooting: () => spawned && booting,
        spawnDaemon: () => {
          spawned = true;
          return { unref: () => undefined };
        },
        sleep: async () => {
          clock += 10_000;
        },
      };
      const hook = createDaemonAutoSpawnHook({
        targets: { controlRoot, dataDir: controlRoot, profile: undefined },
        seams,
      });
      await expect(hook()).resolves.toBe('booting');
      // The next round watches the same boot without spawning again.
      await expect(hook()).resolves.toBe('booting');
      // A boot that dies is the crash candidate again.
      booting = false;
      spawned = false;
      await expect(hook()).resolves.toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('pins the data-plane env of the child and the auto gate', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-env-'));
    const spawns: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    let alive = false;
    const hook = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: '/data/w4', profile: 'cedar' },
      environment: { HOME: '/home/w4', MCODE_SERVER_MODE: 'off' },
      seams: {
        daemonAlive: async () => alive,
        spawnDaemon: (options) => {
          spawns.push(options);
          alive = true;
          return { unref: () => undefined };
        },
        sleep: async () => undefined,
      },
    });
    await hook();
    expect(spawns).toHaveLength(1);
    // argv = [execPath, entryScript, 'daemon', 'run', ...] — the tail is the contract.
    expect(spawns[0]?.argv.slice(2)).toEqual([
      'daemon',
      'run',
      '--data-dir',
      '/data/w4',
      '--profile',
      'cedar',
    ]);
    expect(spawns[0]?.env['MINIMAX_DATA_DIR']).toBe('/data/w4');
    expect(spawns[0]?.env['MINIMAX_PROFILE']).toBe('cedar');
    // The caller's own env keeps `off`; only the CHILD is pinned to auto.
    expect(spawns[0]?.env['MCODE_SERVER_MODE']).toBe('auto');
    // Design 15: the child learns its own stderr — the MCODED_LOG_FILE
    // declaration the daemon-side copytruncate (М2) keys on.
    expect(spawns[0]?.env['MCODED_LOG_FILE']).toBe(join(controlRoot, 'logs', 'mcoded.log'));
  });

  // Design 15 (ДИЗАЙН 2): the spawn opens the log through `openDaemonLogFd` —
  // an over-ceiling log is renamed into the generation chain (М3) BEFORE the
  // fd exists, and the fresh log is opened empty for the child.
  it('declares MCODED_LOG_FILE and pre-rotates the over-ceiling daemon log (М3)', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-logrot-'));
    const logDir = join(controlRoot, 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'mcoded.log'), 'x'.repeat(4096));
    const spawns: Array<{ env: NodeJS.ProcessEnv }> = [];
    let alive = false;
    const hook = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: controlRoot, profile: undefined },
      environment: { MCODED_LOG_MAX_BYTES: '1024' },
      seams: {
        daemonAlive: async () => alive,
        spawnDaemon: (options) => {
          spawns.push({ env: { ...options.env } });
          alive = true;
          return { unref: () => undefined };
        },
        sleep: async () => undefined,
      },
    });
    await hook();
    expect(spawns).toHaveLength(1);
    // The declaration names the exact fresh file; the knobs flow to the child
    // too (the daemon re-reads them for its own М2 ceiling).
    expect(spawns[0]?.env['MCODED_LOG_FILE']).toBe(join(logDir, 'mcoded.log'));
    expect(spawns[0]?.env['MCODED_LOG_MAX_BYTES']).toBe('1024');
    // М3: the 4 KiB backlog moved to `.1`; the child's log starts empty.
    expect(readFileSync(join(logDir, 'mcoded.log.1'), 'utf8')).toBe('x'.repeat(4096));
    expect(statSync(join(logDir, 'mcoded.log')).size).toBe(0);
  });

  // Opus 2026-11-01: a profile-less window pointed at a profile's dataDir
  // must spawn a daemon that serves THAT profile — the label inferred from
  // the dataDir reaches the child's argv AND env (no bare `dd-<hash>` daemon
  // for a profile directory).
  it('carries the profile INFERRED from the dataDir in the child argv and env', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'w4-spawn-infer-')));
    mkdirSync(join(home, '.minimax-cedar'), { recursive: true });
    const targets = resolveDaemonTargets({
      dataDir: join(home, '.minimax-cedar'),
      homeDir: home,
      env: {},
    });
    expect(targets.profile).toBe('cedar');

    const spawns: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    let alive = false;
    const hook = createDaemonAutoSpawnHook({
      targets,
      environment: { HOME: home },
      seams: {
        daemonAlive: async () => alive,
        spawnDaemon: (options) => {
          spawns.push(options);
          alive = true;
          return { unref: () => undefined };
        },
        sleep: async () => undefined,
      },
    });
    await hook();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.argv.slice(2)).toEqual([
      'daemon',
      'run',
      '--data-dir',
      targets.dataDir,
      '--profile',
      'cedar',
    ]);
    expect(spawns[0]?.env['MINIMAX_PROFILE']).toBe('cedar');
    expect(spawns[0]?.env['MINIMAX_DATA_DIR']).toBe(targets.dataDir);
  });

  // Login wave 2026-11-02: the spawn must hand the child its RESOLVED
  // identity, never the wrapper's env. A default-identity window
  // (targets.profile === null) under MINIMAX_PROFILE=cedar used to spawn
  // `daemon run --data-dir ~/.minimax` with NO profile flag — the child then
  // read cedar from the inherited env, mismatched its own --data-dir, died,
  // and the window hung on "Starting server…". Now the argv spells the
  // identity out (`--profile default`) and childEnv carries NO selector.
  it('spawns the default identity EXPLICITLY: --profile default and a stripped profile env', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'w4-spawn-default-')));
    mkdirSync(join(home, '.minimax'), { recursive: true });
    // The window's own resolution: `--profile default` under the cedar env
    // is the implicit profile (the flag wins, 'default' normalizes to null).
    const targets = resolveDaemonTargets({
      profile: 'default',
      dataDir: join(home, '.minimax'),
      homeDir: home,
      env: { MINIMAX_PROFILE: 'cedar' },
    });
    expect(targets.profile).toBeNull();

    const spawns: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    let alive = false;
    const hook = createDaemonAutoSpawnHook({
      targets,
      environment: { HOME: home, MINIMAX_PROFILE: 'cedar', __MAVIS_RUNTIME_PROFILE: 'cedar' },
      seams: {
        daemonAlive: async () => alive,
        spawnDaemon: (options) => {
          spawns.push(options);
          alive = true;
          return { unref: () => undefined };
        },
        sleep: async () => undefined,
      },
    });
    await hook();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.argv.slice(2)).toEqual([
      'daemon',
      'run',
      '--data-dir',
      targets.dataDir,
      '--profile',
      'default',
    ]);
    // Neither profile selector leaks into the child env — the public variable
    // and the gated legacy one are both stripped for the implicit identity.
    expect(spawns[0]?.env['MINIMAX_PROFILE']).toBeUndefined();
    expect(spawns[0]?.env['__MAVIS_RUNTIME_PROFILE']).toBeUndefined();
    expect(spawns[0]?.env['MINIMAX_DATA_DIR']).toBe(targets.dataDir);

    // The child side of the same contract: the spawned argv parses to the
    // default selector, and resolving it under the cedar env STILL lands on
    // the implicit profile — the flag won, the env never mattered.
    const childArgs = parseMcodedArgs(spawns[0]?.argv.slice(2) ?? []);
    expect(childArgs.profile).toBe('default');
    const childTargets = resolveDaemonTargets({
      profile: childArgs.profile,
      dataDir: childArgs.dataDir,
      homeDir: home,
      env: { MINIMAX_PROFILE: 'cedar' },
    });
    expect(childTargets.profile).toBeNull();
    expect(childTargets.dataDir).toBe(targets.dataDir);
  });

  it('a named profile pins the child env to the resolved name over a polluted wrapper env', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'w4-spawn-named-'));
    const spawns: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    let alive = false;
    const hook = createDaemonAutoSpawnHook({
      targets: { controlRoot, dataDir: join(controlRoot, 'data'), profile: 'work' },
      environment: { MINIMAX_PROFILE: 'cedar', __MAVIS_RUNTIME_PROFILE: 'cedar' },
      seams: {
        daemonAlive: async () => alive,
        spawnDaemon: (options) => {
          spawns.push(options);
          alive = true;
          return { unref: () => undefined };
        },
        sleep: async () => undefined,
      },
    });
    await hook();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.argv.slice(2)).toEqual([
      'daemon',
      'run',
      '--data-dir',
      join(controlRoot, 'data'),
      '--profile',
      'work',
    ]);
    // The resolved name, not the wrapper's env value.
    expect(spawns[0]?.env['MINIMAX_PROFILE']).toBe('work');
  });
});

/** Minimal McodedClient double: only the members TuiRemoteCliService touches. */
function fakeClient() {
  const reconnected: Array<(info: { attempts: number }) => void> = [];
  const streams: Array<{ abort: ReturnType<typeof vi.fn> }> = [];
  let nextStream: { abort: ReturnType<typeof vi.fn> } | undefined;
  const client = {
    onReconnected: (listener: (info: { attempts: number }) => void) => {
      reconnected.push(listener);
      return () => undefined;
    },
    sessionAttach: vi.fn(async () => undefined),
    openStream: vi.fn(async () => {
      const frames = (async function* () {
        yield { type: 'session.start' };
      })();
      const abort = vi.fn(async () => undefined);
      const stream = { abort, frames, ended: Promise.resolve({ reason: 'done' }) };
      streams.push(stream);
      nextStream = stream;
      return stream;
    }),
    subscribe: vi.fn(() => {
      const events = (async function* () {
        yield {
          cursor: '1',
          event: {
            type: 'permission.ask',
            payload: { requestId: 'req-1', sessionId: 'sess-1', toolName: 'bash' },
          },
        };
      })();
      const gapped = Promise.resolve({ after: '0', head: '1' });
      return { events, gapped, stop: vi.fn() };
    }),
    emitReconnected: () => reconnected.forEach((listener) => listener({ attempts: 1 })),
    lastStream: () => nextStream,
  };
  return client;
}

/** Minimal RemoteCliService double. */
function fakeRemote(goalEnabled = true) {
  return {
    isGoalEnabled: vi.fn(async () => goalEnabled),
    getSession: vi.fn(async (req: unknown) => ({ session: { id: (req as { id?: string }).id } })),
    getMessages: vi.fn(async () => ({ messages: [] })),
    createSession: vi.fn(async () => ({ session: { id: 'sess-created' } })),
    listPendingPermissions: vi.fn(async () => ({
      requests: [{ requestId: 'snap-1', sessionId: 'sess-snap' }],
    })),
    replyPermission: vi.fn(async (req: Record<string, unknown>) => {
      void req;
      return { success: true };
    }),
  };
}

describe('TuiRemoteCliService (the W3-pinned seams)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts the signal into stream.cancel{mode:abort} — the only remote cancel', async () => {
    const client = fakeClient();
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    await tui.refreshGoalEnabled();
    const controller = new AbortController();
    const opened = await tui.sendMessage({ id: 'sess-1' } as never, { signal: controller.signal });
    expect(opened.ok).toBe(true);
    const stream = client.lastStream();
    controller.abort();
    // Drain one frame so the generator is running, then let the finally run.
    const source = (opened as { source: AsyncGenerator }).source;
    await source.next().catch(() => undefined);
    await source.return(undefined).catch(() => undefined);
    expect(stream?.abort).toHaveBeenCalledTimes(1);
  });

  it('a plain source.return() without an abort never cancels the remote turn', async () => {
    const client = fakeClient();
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    const opened = await tui.sendMessage({ id: 'sess-9' } as never);
    const source = (opened as { source: AsyncGenerator }).source;
    await source.next().catch(() => undefined);
    await source.return(undefined).catch(() => undefined);
    expect(client.lastStream()?.abort).not.toHaveBeenCalled();
  });

  it('isGoalEnabled is a SYNC snapshot, refreshed at connect and on reconnect', async () => {
    const client = fakeClient();
    const remote = fakeRemote(true);
    const tui = new TuiRemoteCliService(client as never, remote as never);
    expect(tui.isGoalEnabled()).toBe(false); // before the first sync
    await tui.refreshGoalEnabled();
    expect(tui.isGoalEnabled()).toBe(true);
    client.emitReconnected(); // the reconnect hook re-syncs (async)
    await vi.waitFor(() => expect(tui.isGoalEnabled()).toBe(true));
    expect(remote.isGoalEnabled).toHaveBeenCalledTimes(2);
  });

  it('replyPermission re-attaches the session of the SEEN ask (push + snapshot)', async () => {
    const client = fakeClient();
    const remote = fakeRemote();
    const tui = new TuiRemoteCliService(client as never, remote as never);
    // The ask arrives through the window's own event subscription...
    const watch = tui.watchEvents();
    await watch.events.next();
    // ...then the window replies; the daemon-side §4.5 attach rule needs the
    // session id the ask carried.
    await tui.replyPermission({ name: 'a', requestId: 'req-1', reply: 0 });
    expect(remote.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', sessionId: 'sess-1' }),
    );
    // Unknown request: no fabricated session — the daemon answers honestly.
    await tui.replyPermission({ name: 'a', requestId: 'req-unknown', reply: 0 });
    expect(remote.replyPermission).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() }),
    );
    // The snapshot path feeds the same map.
    tui.noteSnapshotRequests([{ requestId: 'req-2', sessionId: 'sess-2' }]);
    await tui.replyPermission({ name: 'a', requestId: 'req-2', reply: 0 });
    expect(remote.replyPermission).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'req-2', sessionId: 'sess-2' }),
    );
  });

  it('turn opens attach the session first (the event-routing key)', async () => {
    const client = fakeClient();
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    await tui.sendMessage({ id: 'sess-77' } as never);
    expect(client.sessionAttach).toHaveBeenCalledWith('sess-77', 'owner', expect.anything());
  });

  // --- Revision 11 F3: the window sends its toolEnv snapshot ---

  describe('session.attach toolEnv snapshot (revision 11 F3)', () => {
    function lastSnapshot(client: ReturnType<typeof fakeClient>): {
      cwd: string;
      env: Record<string, string>;
    } {
      const calls = client.sessionAttach.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return calls.at(-1)?.[2];
    }

    it('carries the window cwd/env with the daemon-owned families stripped', async () => {
      try {
        process.env['V3_PROBE'] = 'window-value';
        process.env['MCODE_REGION'] = 'cn';
        process.env['MINIMAX_PROFILE'] = 'work';
        process.env['__MAVIS_RUNTIME_DATA_DIR'] = '/leak';
        process.env['__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT'] = 'window-broker';
        const client = fakeClient();
        const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
        await tui.sendMessage({ id: 'sess-env-1' } as never);
        const snapshot = lastSnapshot(client);
        expect(snapshot.cwd).toBe(process.cwd());
        expect(snapshot.env['V3_PROBE']).toBe('window-value');
        // Daemon-reserved families never cross the wire (the daemon's
        // sanitizer re-strips MCODE_*/MINIMAX_*; __MAVIS_* is window-side).
        expect(snapshot.env['MCODE_REGION']).toBeUndefined();
        expect(snapshot.env['MINIMAX_PROFILE']).toBeUndefined();
        expect(snapshot.env['__MAVIS_RUNTIME_DATA_DIR']).toBeUndefined();
        expect(snapshot.env['__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT']).toBeUndefined();
      } finally {
        delete process.env['V3_PROBE'];
        delete process.env['MCODE_REGION'];
        delete process.env['MINIMAX_PROFILE'];
        delete process.env['__MAVIS_RUNTIME_DATA_DIR'];
        delete process.env['__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT'];
      }
    });

    it('an env change in the window reaches the next turn attach (nothing frozen)', async () => {
      try {
        delete process.env['V3_PROBE'];
        const client = fakeClient();
        const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
        await tui.sendMessage({ id: 'sess-env-2' } as never);
        expect(lastSnapshot(client).env['V3_PROBE']).toBeUndefined();
        // The window shell updated its env between turns.
        process.env['V3_PROBE'] = 'updated-value';
        await tui.sendMessage({ id: 'sess-env-2' } as never);
        expect(lastSnapshot(client).env['V3_PROBE']).toBe('updated-value');
      } finally {
        delete process.env['V3_PROBE'];
      }
    });
  });

  // --- Round-2 fixes ---

  it('BLOCKER regression: watchEvents composes with TuiEventAccess (for-await over the result)', async () => {
    const { TuiEventAccess } = await import('../../src/runtime/adapters/event-access.js');
    const client = fakeClient();
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    // The exact product composition: event-access iterates the watchEvents
    // RESULT directly — this failed with `TypeError: stream is not async
    // iterable` before the [Symbol.asyncIterator] forwarding.
    const access = new TuiEventAccess(tui as never);
    const controller = new AbortController();
    const seen: string[] = [];
    // eslint-disable-next-line no-unreachable-loop -- one event is the point: proving for-await composition works
    for await (const event of access.watch(controller.signal)) {
      seen.push((event as { type?: string }).type ?? '?');
      break; // one event proves the iteration works
    }
    expect(seen).toEqual(['permission.ask']);
    controller.abort();
  });

  it('the projection is async-iterable directly, and stop() still works', async () => {
    const client = fakeClient();
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    const watch = tui.watchEvents();
    await watch.events.next();
    await watch.return?.(undefined as never).catch(() => undefined);
    expect(typeof watch[Symbol.asyncIterator]).toBe('function');
  });

  it('listPendingPermissions tees the snapshot into the reply map (no event loop needed)', async () => {
    const client = fakeClient();
    const remote = fakeRemote();
    const tui = new TuiRemoteCliService(client as never, remote as never);
    await tui.listPendingPermissions({});
    await tui.replyPermission({ name: 'a', requestId: 'snap-1', reply: 0 });
    expect(remote.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'snap-1', sessionId: 'sess-snap' }),
    );
  });

  it('attaches newly delegated children and recovers a permission that raced the attach', async () => {
    const client = fakeClient();
    const remote = fakeRemote();
    remote.listPendingPermissions.mockResolvedValue({
      requests: [{ requestId: 'child-ask', sessionId: 'child', agentName: 'worker', toolName: 'bash' }],
    } as never);
    client.subscribe.mockImplementation(() => ({
      events: (async function* () {
        yield { cursor: '1', event: { type: 'session.created', payload: { sessionId: 'unrelated', parentSessionId: 'other-root' } } };
        yield { cursor: '2', event: { type: 'session.created', payload: { sessionId: 'child', parentSessionId: 'root' } } };
        yield { cursor: '3', event: { type: 'permission.ask', payload: { requestId: 'child-ask', sessionId: 'child', agentName: 'worker', toolName: 'bash' } } };
      })(),
      gapped: new Promise(() => {}), stop: vi.fn(),
    } as never));
    const tui = new TuiRemoteCliService(client as never, remote as never);
    await tui.getSession({ id: 'root' });
    const seen = [];
    for await (const event of tui.watchEvents()) seen.push(event);
    expect(client.sessionAttach).toHaveBeenCalledWith('child', 'owner', expect.anything());
    expect(client.sessionAttach).not.toHaveBeenCalledWith('unrelated', expect.anything(), expect.anything());
    expect(seen.filter((event) => event.type === 'permission.ask')).toHaveLength(1);
    await tui.replyPermission({ name: 'worker', requestId: 'child-ask', reply: 0 });
    expect(remote.replyPermission).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'child' }));
  });

  it('viewing a session attaches it (the reopen gate: a window that never streamed sees the ask)', async () => {
    const client = fakeClient();
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    await tui.getSession({ id: 'sess-view-1' });
    await tui.getMessages({ id: 'sess-view-2' });
    await tui.createSession({});
    expect(client.sessionAttach).toHaveBeenCalledWith('sess-view-1', 'owner', expect.anything());
    expect(client.sessionAttach).toHaveBeenCalledWith('sess-view-2', 'owner', expect.anything());
    expect(client.sessionAttach).toHaveBeenCalledWith('sess-created', 'owner', expect.anything());
  });

  it('a push ask triggers an immediate snapshot re-request (§4.4 push supplements polling)', async () => {
    const client = fakeClient();
    const remote = fakeRemote();
    const tui = new TuiRemoteCliService(client as never, remote as never);
    const watch = tui.watchEvents();
    await watch.events.next(); // the ask flows; the tee fires the refresh
    await vi.waitFor(() => expect(remote.listPendingPermissions).toHaveBeenCalled());
    await tui.replyPermission({ name: 'a', requestId: 'req-1', reply: 0 });
    expect(remote.replyPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', sessionId: 'sess-1' }),
    );
  });

  it('a replay gap re-attaches viewed sessions and refreshes the snapshot', async () => {
    const client = fakeClient();
    const remote = fakeRemote();
    const tui = new TuiRemoteCliService(client as never, remote as never);
    await tui.getSession({ id: 'sess-gap' });
    client.sessionAttach.mockClear();
    const watch = tui.watchEvents();
    await watch.events.next();
    // The fake subscription's gapped promise resolves immediately.
    await vi.waitFor(() => expect(client.sessionAttach).toHaveBeenCalledWith('sess-gap', 'owner', expect.anything()));
    await vi.waitFor(() => expect(remote.listPendingPermissions).toHaveBeenCalled());
  });

  // --- Incident 2026-11-05: the refused open is a VALUE, not an exception ---

  it('a busy refusal returns the mirrored {ok:false,status,body} from sendMessage (never throws)', async () => {
    const client = fakeClient();
    client.openStream.mockRejectedValueOnce(
      new McodedRemoteError('Session already has an active turn.', {
        code: 'RUNTIME_REJECTED',
        errorName: 'StreamRefused',
        data: {
          status: 409,
          body: busyRefusalBody(),
        },
      }),
    );
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    const opened = await tui.sendMessage({ id: 'sess-busy', turnId: 'turn-1', content: 'x' } as never);
    expect(opened).toEqual({ ok: false, status: 409, body: busyRefusalBody() });
  });

  it('a busy refusal returns the mirrored {ok:false,status,body} from resumeSession (never throws)', async () => {
    const client = fakeClient();
    client.openStream.mockRejectedValueOnce(
      new McodedRemoteError('Session already has an active turn.', {
        code: 'RUNTIME_REJECTED',
        errorName: 'StreamRefused',
        data: {
          status: 409,
          body: busyRefusalBody(),
        },
      }),
    );
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    const opened = await tui.resumeSession({ id: 'sess-busy' } as never);
    expect(opened).toEqual({ ok: false, status: 409, body: busyRefusalBody() });
  });

  it('an error without the mirrored {status,body} data still throws (dead daemon, faults)', async () => {
    const client = fakeClient();
    client.openStream.mockRejectedValueOnce(new McodedRemoteError('connection lost'));
    const tui = new TuiRemoteCliService(client as never, fakeRemote() as never);
    await expect(tui.sendMessage({ id: 'sess-1' } as never)).rejects.toThrow('connection lost');
  });
});


// --- Wave 2 (incident 2026-11-05, verdict §2.2а): the reattach — replay = end of turn ---

interface FakeTurnStream {
  /** Queue one frame for the consumer (waiters first, then the queue). */
  push(frame: unknown): void;
  /** Settle `ended` (the wire `stream.end`) and finish the frames iterable. */
  end(end: StreamEnd): void;
  readonly abort: ReturnType<typeof vi.fn>;
  /** The `RemoteStream` face the service consumes. */
  readonly remote: {
    readonly streamId: string;
    readonly frames: AsyncIterable<unknown>;
    readonly ended: Promise<StreamEnd>;
    abort(): Promise<void>;
  };
}

/** A controllable RemoteStream double: frames queue until consumed. */
function fakeTurnStream(streamId: string): FakeTurnStream {
  const queue: unknown[] = [];
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  let finished = false;
  let settleEnd: (end: StreamEnd) => void = () => undefined;
  const ended = new Promise<StreamEnd>((resolve) => {
    settleEnd = resolve;
  });
  const frames: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = queue.shift();
        if (value !== undefined) return { done: false as const, value };
        if (finished) return { done: true as const, value: undefined };
        return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
      },
    }),
  };
  const abort = vi.fn(async () => undefined);
  return {
    push: (frame) => {
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value: frame });
      else queue.push(frame);
    },
    end: (end) => {
      if (finished) return;
      finished = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
      settleEnd(end);
    },
    abort,
    remote: { streamId, frames, ended, abort: () => abort() },
  };
}

/** A client double with reattach-controllable streams and connection state. */
function fakeReattachClient(readyState = 'ready') {
  const streams: FakeTurnStream[] = [];
  const opens: Array<{ method: string; params: unknown[] }> = [];
  const stateListeners: Array<(state: string) => void> = [];
  const reconnected: Array<(info: { attempts: number }) => void> = [];
  let state = readyState;
  const client = {
    onReconnected: (listener: (info: { attempts: number }) => void) => {
      reconnected.push(listener);
      return () => undefined;
    },
    onStateChange: (listener: (state: string) => void) => {
      stateListeners.push(listener);
      return () => undefined;
    },
    get connectionState(): string {
      return state;
    },
    sessionAttach: vi.fn(async () => undefined),
    openStream: vi.fn(async (method: string, params: unknown[]) => {
      opens.push({ method, params });
      const stream = fakeTurnStream(`s${streams.length + 1}`);
      streams.push(stream);
      return stream.remote;
    }),
    subscribe: vi.fn(() => {
      const events = (async function* () {})();
      return { events, gapped: Promise.resolve(undefined), stop: vi.fn() };
    }),
    setState(next: string): void {
      state = next;
      for (const listener of stateListeners) listener(next);
    },
    streams,
    opens,
    reconnected,
  };
  return client;
}

interface ReattachServiceOptions {
  reattachReadyMs?: number;
  reattachSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function reattachService(
  client: ReturnType<typeof fakeReattachClient>,
  options: ReattachServiceOptions = {},
): TuiRemoteCliService {
  return new TuiRemoteCliService(client as never, fakeRemote() as never, options as never);
}

/**
 * Consumes the source into a MIRROR array the test can poll while the
 * generator is still running; the returned promise settles with the ending.
 */
function collect(source: AsyncGenerator<unknown>): {
  readonly frames: unknown[];
  readonly settled: Promise<{ frames: unknown[]; error?: unknown }>;
} {
  const frames: unknown[] = [];
  const settled = (async () => {
    try {
      for await (const frame of source) frames.push(frame);
    } catch (error) {
      return { frames, error };
    }
    return { frames };
  })();
  return { frames, settled };
}

const stderrWrites: string[] = [];
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

function stderrLines(): string[] {
  return stderrWrites.map((line) => String(line));
}

describe('abortAwareSource reattach (verdict §2.2а)', () => {
  it('recovers an evicted replay cursor from the last delivered durable message', async () => {
    const client = fakeReattachClient();
    const tui = reattachService(client);
    const opened = await tui.sendMessage({ id: 'sess-gap' } as never);
    const { settled } = collect((opened as { source: AsyncGenerator<unknown> }).source);
    client.streams[0]!.push({ dataJson: JSON.stringify({ type: 2, agent_message: { msg_id: 'user-anchor', role: 'user', msg_content: 'question' } }), cursor: '10' });
    client.streams[0]!.push({ dataJson: '{"type":"resume_overflow"}', cursor: '1000' });
    client.streams[0]!.push({ dataJson: '[DONE]' });
    client.streams[0]!.end({ reason: 'done' });
    await vi.waitFor(() => expect(client.opens).toHaveLength(2));
    expect(client.opens[1]).toEqual({ method: 'resumeSession', params: [{ id: 'sess-gap', afterMsgId: 'user-anchor' }] });
    client.streams[1]!.push({ dataJson: '{"type":2,"answer":true}', cursor: '1001' });
    client.streams[1]!.end({ reason: 'done' });
    const result = await settled;
    expect(result.error).toBeUndefined();
    expect(result.frames).toHaveLength(2);
  });

  it('retiring a completed delivery detaches its stream and never aborts Runtime', async () => {
    const client = fakeReattachClient();
    const tui = reattachService(client);
    const signal = new AbortController();
    const opened = await tui.sendMessage({ id: 'completed-session' } as never, {
      signal: signal.signal,
    });
    const first = client.streams[0]!;
    const detach = vi.fn(() =>
      first.end({ reason: 'detached', resumable: true }),
    );
    Object.assign(first.remote, { detach });
    const { settled } = collect(
      (opened as { source: AsyncGenerator<unknown> }).source,
    );
    signal.abort(new TurnDeliveryRetired());
    await settled;
    expect(detach).toHaveBeenCalledOnce();
    expect(first.abort).not.toHaveBeenCalled();
    expect(client.opens).toHaveLength(1);
  });

  it('aborts the reattached stream rather than the ended original stream', async () => {
    const client = fakeReattachClient();
    const tui = reattachService(client);
    const abort = new AbortController();
    const opened = await tui.sendMessage({ id: 'sess-abort-resumed' } as never, { signal: abort.signal });
    const { settled } = collect((opened as { source: AsyncGenerator<unknown> }).source);
    client.streams[0]!.end({ reason: 'error', resumable: true });
    await vi.waitFor(() => expect(client.opens).toHaveLength(2));
    abort.abort();
    expect(client.streams[1]!.abort).toHaveBeenCalledOnce();
    expect(client.streams[0]!.abort).not.toHaveBeenCalled();
    client.streams[1]!.end({ reason: 'aborted' });
    await settled;
  });

  afterEach(() => {
    stderrSpy?.mockRestore();
    stderrSpy = undefined;
    stderrWrites.length = 0;
  });

  it('detached+resumable: waits for ready, reopens resumeSession after the last cursor, no duplicates, ends only on done', async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const client = fakeReattachClient();
    const tui = reattachService(client);
    const opened = await tui.sendMessage({ id: 'sess-r1', turnId: 'turn-1', content: 'x' } as never);
    expect(opened.ok).toBe(true);
    const first = client.streams[0]!;
    const { frames, settled } = collect((opened as { source: AsyncGenerator<unknown> }).source);
    // The consumer parks on the queue; drive the turn.
    first.push({ dataJson: '{"type":2}', cursor: '10' });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    // The window dies mid-turn: the daemon detaches the stream (resumable).
    first.end({ reason: 'detached', resumable: true });
    // The reattach must wait for the client's own reconnect...
    client.setState('reconnecting');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.opens).toHaveLength(1); // no reopen before ready
    client.setState('ready');
    await vi.waitFor(() => expect(client.opens).toHaveLength(2));
    // ...and reopen resumeSession with the LAST DELIVERED cursor.
    expect(client.opens[1]).toEqual({
      method: 'resumeSession',
      params: [{ id: 'sess-r1', afterCursor: '10' }],
    });
    // The replay re-delivers cursor 10 (already seen) plus the fresh tail.
    const second = client.streams[1]!;
    second.push({ dataJson: '{"type":2,"replay":true}', cursor: '10' });
    second.push({ dataJson: '{"type":2,"tail":true}', cursor: '11' });
    second.push({ dataJson: '[DONE]' });
    second.end({ reason: 'done' });
    const { frames: all, error } = await settled;
    expect(error).toBeUndefined();
    // No duplicates: cursor 10 exactly once, the fresh 11, then the terminal.
    expect(
      all
        .map((frame) => (frame as { cursor?: string }).cursor)
        .filter((cursor) => cursor !== undefined),
    ).toEqual(['10', '11']);
    expect(all.at(-1)).toEqual({ dataJson: '[DONE]' });
    // Exactly one WARN for the detach event, with the first attempt number.
    const warns = stderrLines().filter((line) => line.includes('turn-stream-detached'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('mcode:rpc');
    expect(warns[0]).toContain('sessionId=sess-r1');
    expect(warns[0]).toContain('reason=detached');
    expect(warns[0]).toContain('attempt=1');
  });

  it('exhausts 3 attempts with the 1/2/4s backoff and throws TurnStreamDetached', async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const client = fakeReattachClient();
    const sleeps: number[] = [];
    const tui = reattachService(client, {
      reattachSleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const opened = await tui.sendMessage({ id: 'sess-fail', turnId: 'turn-2', content: 'x' } as never);
    const first = client.streams[0]!;
    const { frames, settled } = collect((opened as { source: AsyncGenerator<unknown> }).source);
    await vi.waitFor(() => expect(client.opens).toHaveLength(1));
    expect(frames).toHaveLength(0);
    // Every reattach open is refused — the turn is unreachable.
    client.openStream.mockRejectedValue(
      new McodedRemoteError('The current Turn is already complete', { code: 'RUNTIME_REJECTED' }),
    );
    first.end({ reason: 'detached', resumable: true });
    const { error } = await settled;
    expect(frames).toEqual([]);
    expect(error).toBeInstanceOf(TurnStreamDetached);
    const detached = error as InstanceType<typeof TurnStreamDetached>;
    expect(detached.sessionId).toBe('sess-fail');
    expect(detached.turnId).toBe('turn-2');
    expect(detached.reason).toBe('detached');
    expect(detached.attempts).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    // One WARN per attempt.
    const warns = stderrLines().filter((line) => line.includes('turn-stream-detached'));
    expect(warns).toHaveLength(3);
    expect(warns.map((line) => Number(/attempt=(\d+)/u.exec(line)?.[1]))).toEqual([1, 2, 3]);
  });

  it("reason 'aborted' under our own signal ends the generator without reconnecting", async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const client = fakeReattachClient();
    const tui = reattachService(client);
    const controller = new AbortController();
    const opened = await tui.sendMessage({ id: 'sess-abort-2' } as never, {
      signal: controller.signal,
    });
    const first = client.streams[0]!;
    const { frames, settled } = collect((opened as { source: AsyncGenerator<unknown> }).source);
    await vi.waitFor(() => expect(client.opens).toHaveLength(1));
    first.push({ dataJson: '{"type":2}', cursor: '1' });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    controller.abort();
    first.end({ reason: 'aborted', resumable: true });
    const { frames: all, error } = await settled;
    expect(error).toBeUndefined();
    expect(all).toHaveLength(1);
    // The abort remap fired once; no resumeSession was ever opened.
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(client.opens).toHaveLength(1);
    expect(stderrLines().some((line) => line.includes('turn-stream-detached'))).toBe(false);
  });

  it("the consumer's own return() ends the generator without reconnecting", async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const client = fakeReattachClient();
    const tui = reattachService(client);
    const opened = await tui.sendMessage({ id: 'sess-return' } as never);
    const first = client.streams[0]!;
    const source = (opened as { source: AsyncGenerator<unknown> }).source;
    first.push({ dataJson: '{"type":2}', cursor: '1' });
    await source.next();
    await source.return(undefined);
    first.end({ reason: 'detached', resumable: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.opens).toHaveLength(1);
    expect(stderrLines().some((line) => line.includes('turn-stream-detached'))).toBe(false);
  });

  it('a non-resumable end (client teardown) ends quietly — the coordinator net reports it', async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const client = fakeReattachClient();
    const tui = reattachService(client);
    const opened = await tui.sendMessage({ id: 'sess-teardown' } as never);
    const first = client.streams[0]!;
    const { frames, settled } = collect((opened as { source: AsyncGenerator<unknown> }).source);
    await vi.waitFor(() => expect(client.opens).toHaveLength(1));
    first.end({ reason: 'error', error: 'client closed' });
    const { frames: all, error } = await settled;
    expect(error).toBeUndefined();
    expect(all).toEqual([]);
    expect(client.opens).toHaveLength(1);
    expect(stderrLines().some((line) => line.includes('turn-stream-detached'))).toBe(false);
  });

  it('resumeSession reattaches the same way (afterCursor from its own replay position)', async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const client = fakeReattachClient();
    const tui = reattachService(client);
    const opened = await tui.resumeSession({ id: 'sess-res', afterCursor: '5' } as never);
    const first = client.streams[0]!;
    const { frames, settled } = collect((opened as { source: AsyncGenerator<unknown> }).source);
    await vi.waitFor(() => expect(client.opens).toHaveLength(1));
    first.push({ dataJson: '{"type":2}', cursor: '6' });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    first.end({ reason: 'error', error: 'connection lost', resumable: true });
    client.setState('reconnecting');
    client.setState('ready');
    await vi.waitFor(() => expect(client.opens).toHaveLength(2));
    expect(client.opens[1]).toEqual({
      method: 'resumeSession',
      params: [{ id: 'sess-res', afterCursor: '6' }],
    });
    client.streams[1]!.push({ dataJson: '[DONE]' });
    client.streams[1]!.end({ reason: 'done' });
    const { error } = await settled;
    expect(error).toBeUndefined();
  });
});

/** The exact wire shape of a busy refusal (`SessionStreamErrorBody`). */
function busyRefusalBody() {
  return {
    sseErrorCode: 409,
    code: 409,
    key: 'local_session_busy',
    message: 'This session already has an active turn. Use queue send or stop the turn first.',
  };
}

/**
 * Incident 2026-11-05: ONE refusal path for embedded and remote. Both modes
 * feed `TuiConversationAccess` the same `{ok:false,status,body}` mirror (the
 * embedded CliService returns it in-process; the remote thin client returns
 * it since the `TurnStreamRefused` throw was removed) — so the SAME
 * `TuiFailure` must come out on both sides. `TuiRuntimeAdapter` constructs
 * this adapter with whichever CliService the mode resolved (adapter.ts:169).
 */
describe('TuiConversationAccess consumes the mirrored refusal (embedded = remote)', () => {
  function refusedService(status: number) {
    return {
      sendMessage: vi.fn(async () => ({
        ok: false as const,
        status,
        body: busyRefusalBody(),
      })),
      resumeSession: vi.fn(async () => ({
        ok: false as const,
        status,
        body: busyRefusalBody(),
      })),
    };
  }

  it('sendMessage throws the TuiFailure with the body key and message (409: not retryable)', async () => {
    const access = new TuiConversationAccess(refusedService(409) as never);
    const source = access.sendMessage({ id: 'sess-1', turnId: 'turn-1', content: 'x' } as never);
    await expect(source.next()).rejects.toMatchObject({
      name: 'TuiFailure',
      category: 'runtime',
      code: 'local_session_busy',
      message: busyRefusalBody().message,
      retryable: false,
    });
  });

  it('resumeSession throws the same TuiFailure shape', async () => {
    const access = new TuiConversationAccess(refusedService(409) as never);
    const source = access.resumeSession({ id: 'sess-1' } as never, 'turn-1');
    const error: unknown = await source.next().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TuiFailure);
    expect(error).toMatchObject({
      code: 'local_session_busy',
      message: busyRefusalBody().message,
    });
  });

  it('a 5xx refusal is retryable, an admission-class 4xx is not', async () => {
    const unavailable = new TuiConversationAccess(refusedService(503) as never);
    await expect(
      unavailable.sendMessage({ id: 'sess-1', turnId: 'turn-1', content: 'x' } as never).next(),
    ).rejects.toMatchObject({ code: 'local_session_busy', retryable: true });
    const busy = new TuiConversationAccess(refusedService(409) as never);
    await expect(
      busy.sendMessage({ id: 'sess-1', turnId: 'turn-1', content: 'x' } as never).next(),
    ).rejects.toMatchObject({ code: 'local_session_busy', retryable: false });
  });
});
