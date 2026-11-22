/**
 * The `--profile` flag travel through the CLI contract (opus 2026-11-01,
 * правка 4): the interactive launch request carries it, and `exec`/`acp` —
 * which receive the flag from `applyProfileOptionToEveryCommand` (the program
 * walker) — forward it into the runtime creation options, where it reaches
 * `resolveDaemonTargets` as the top-priority input.
 *
 * Commander does not inherit parent options, so these tests pin the walker's
 * per-command flag too: an unknown-option error here means the plumbing broke.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import { Readable, Writable } from 'node:stream';

import { Command } from 'commander';

import { createTuiProgram } from '../../src/cli/program.js';
import { runTuiExecCommand } from '../../src/cli/run-exec-command.js';
import { runTuiAcpCommand } from '../../src/cli/run-acp-command.js';

function parse(program: Command, args: string[]): Promise<Error | undefined> {
  return program
    .parseAsync(args, { from: 'node' })
    .then(() => undefined)
    .catch((error: Error) => error);
}

function buildProgram(handlers: {
  launchTui: ReturnType<typeof vi.fn>;
  runExec?: ReturnType<typeof vi.fn>;
  runAcp?: ReturnType<typeof vi.fn>;
}) {
  return createTuiProgram({
    version: 'test',
    launchTui: handlers.launchTui,
    runExec: handlers.runExec ?? (async () => undefined),
    ...(handlers.runAcp ? { runAcp: handlers.runAcp } : {}),
    runLogin: async () => '',
    runLogout: async () => '',
    runUpdate: async () => undefined,
  });
}

describe('interactive contract: --profile lands in the launch request', () => {
  it('copies --profile cedar into TuiInteractiveLaunchRequest', async () => {
    const launchTui = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui });
    const error = await parse(program, ['node', 'mcode', '--profile', 'cedar', 'hello']);
    expect(error).toBeUndefined();
    expect(launchTui).toHaveBeenCalledOnce();
    expect(launchTui).toHaveBeenCalledWith(
      expect.objectContaining({ initialPrompt: 'hello', profile: 'cedar' }),
    );
  });

  it('accepts the inline spelling --profile=work', async () => {
    const launchTui = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui });
    const error = await parse(program, ['node', 'mcode', '--profile=work']);
    expect(error).toBeUndefined();
    expect(launchTui).toHaveBeenCalledWith(expect.objectContaining({ profile: 'work' }));
  });

  it('omits the field entirely when no flag was given', async () => {
    const launchTui = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui });
    const error = await parse(program, ['node', 'mcode']);
    expect(error).toBeUndefined();
    const request = launchTui.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('profile' in request).toBe(false);
  });

  it('rejects a path-shaped profile before any action runs', async () => {
    const launchTui = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui });
    const error = await parse(program, ['node', 'mcode', '--profile', '../../etc', 'hello']);
    expect(error).toBeDefined();
    expect(launchTui).not.toHaveBeenCalled();
  });
});

describe('exec contract: --profile reaches the runtime creation options', () => {
  it('forwards --profile cedar through the program into runExec options', async () => {
    const runExec = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui: vi.fn(async () => undefined), runExec });
    const error = await parse(program, ['node', 'mcode', 'exec', '--profile', 'cedar', 'hello']);
    expect(error).toBeUndefined();
    expect(runExec).toHaveBeenCalledOnce();
    expect(runExec).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ profile: 'cedar' }),
    );
  });

  it('runTuiExecCommand forwards the profile into createTuiRuntime options', async () => {
    const createRuntime = vi.fn(async () => ({
      adapter: {},
      host: { apiHost: { close: async () => undefined } },
    })) as unknown as ReturnType<typeof vi.fn>;
    const runExec = vi.fn(async () => 0);
    const shutdownRuntime = vi.fn(async () => undefined);
    await runTuiExecCommand(
      'hello',
      { profile: 'cedar' },
      'test',
      {
        resolveDataDir: async () => '/tmp/profile-exec-data',
        createRuntime: createRuntime as never,
        shutdownRuntime: shutdownRuntime as never,
        runExec: runExec as never,
      },
    );
    expect(createRuntime).toHaveBeenCalledOnce();
    // run-exec passes an empty dependencies object alongside the options.
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'headless', profile: 'cedar' }),
      {},
    );
  });

  it('omits the field when no profile was given', async () => {
    const createRuntime = vi.fn(async () => ({
      adapter: {},
      host: { apiHost: { close: async () => undefined } },
    }));
    await runTuiExecCommand(
      'hello',
      {},
      'test',
      {
        resolveDataDir: async () => '/tmp/profile-exec-data',
        createRuntime: createRuntime as never,
        shutdownRuntime: vi.fn(async () => undefined) as never,
        runExec: vi.fn(async () => 0) as never,
      },
    );
    const options = createRuntime.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('profile' in options).toBe(false);
  });
});

describe('acp contract: --profile reaches the runtime creation options', () => {
  it('forwards --profile cedar through the program into runAcp', async () => {
    const runAcp = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui: vi.fn(async () => undefined), runAcp });
    const error = await parse(program, ['node', 'mcode', 'acp', '--profile', 'cedar']);
    expect(error).toBeUndefined();
    expect(runAcp).toHaveBeenCalledOnce();
    expect(runAcp).toHaveBeenCalledWith(undefined, undefined, 'cedar', false, false, false);
  });

  it('runTuiAcpCommand forwards the profile into createTuiRuntime options', async () => {
    const createRuntime = vi.fn(async () => ({
      adapter: {},
      host: { apiHost: { close: async () => undefined } },
    }));
    const shutdownRuntime = vi.fn(async () => undefined);
    // The command redirects console output to stderr: real stream instances.
    const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
    const processRef = {
      once: () => undefined,
      off: () => undefined,
      stdin: new Readable({ read: () => undefined }),
      stdout: sink(),
      stderr: sink(),
    };
    await runTuiAcpCommand(
      'test',
      {
        processRef: processRef as never,
        workspaceDir: () => '/workspace',
        prepareDataDir: async () => '/tmp/profile-acp-data',
        createRuntime: createRuntime as never,
        shutdownRuntime: shutdownRuntime as never,
        serve: async () => undefined,
      },
      undefined,
      undefined,
      'cedar',
    );
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'acp', profile: 'cedar' }),
    );
    expect(shutdownRuntime).toHaveBeenCalledOnce();
  });
});

/**
 * The `--no-daemon` flag (isolated/wrapper runs): commander parses it as the
 * negated boolean `daemon: false`; the contracts translate that into an
 * explicit `noDaemon: true` that reaches `createTuiRuntime` on every surface
 * (interactive, exec, ACP) and is OMITTED when the flag was not given.
 */
describe('--no-daemon flag: contracts translate daemon=false into noDaemon=true', () => {
  it('interactive: the launch request carries noDaemon', async () => {
    const launchTui = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui });
    const error = await parse(program, ['node', 'mcode', '--no-daemon', 'hello']);
    expect(error).toBeUndefined();
    expect(launchTui).toHaveBeenCalledWith(
      expect.objectContaining({ initialPrompt: 'hello', noDaemon: true }),
    );
  });

  it('interactive: no flag ⇒ the field is absent, not false', async () => {
    const launchTui = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui });
    const error = await parse(program, ['node', 'mcode']);
    expect(error).toBeUndefined();
    const request = launchTui.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('noDaemon' in request).toBe(false);
  });

  it('exec: runTuiExecCommand forwards noDaemon into createTuiRuntime options', async () => {
    const createRuntime = vi.fn(async () => ({
      adapter: {},
      host: { apiHost: { close: async () => undefined } },
    }));
    await runTuiExecCommand(
      'hello',
      { daemon: false },
      'test',
      {
        resolveDataDir: async () => '/tmp/no-daemon-exec-data',
        createRuntime: createRuntime as never,
        shutdownRuntime: vi.fn(async () => undefined) as never,
        runExec: vi.fn(async () => 0) as never,
      },
    );
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'headless', noDaemon: true }),
      {},
    );
  });

  it('exec: no flag ⇒ createTuiRuntime options omit noDaemon', async () => {
    const createRuntime = vi.fn(async () => ({
      adapter: {},
      host: { apiHost: { close: async () => undefined } },
    }));
    await runTuiExecCommand(
      'hello',
      {},
      'test',
      {
        resolveDataDir: async () => '/tmp/no-daemon-exec-data',
        createRuntime: createRuntime as never,
        shutdownRuntime: vi.fn(async () => undefined) as never,
        runExec: vi.fn(async () => 0) as never,
      },
    );
    const options = createRuntime.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('noDaemon' in options).toBe(false);
  });

  it('acp: the program passes noDaemon through to runAcp', async () => {
    const runAcp = vi.fn(async () => undefined);
    const program = buildProgram({ launchTui: vi.fn(async () => undefined), runAcp });
    const error = await parse(program, ['node', 'mcode', 'acp', '--no-daemon']);
    expect(error).toBeUndefined();
    expect(runAcp).toHaveBeenCalledWith(undefined, undefined, undefined, true, false, false);
  });

  it('acp: runTuiAcpCommand forwards noDaemon into createTuiRuntime options', async () => {
    const createRuntime = vi.fn(async () => ({
      adapter: {},
      host: { apiHost: { close: async () => undefined } },
    }));
    const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
    const processRef = {
      once: () => undefined,
      off: () => undefined,
      stdin: new Readable({ read: () => undefined }),
      stdout: sink(),
      stderr: sink(),
    };
    await runTuiAcpCommand(
      'test',
      {
        processRef: processRef as never,
        workspaceDir: () => '/workspace',
        prepareDataDir: async () => '/tmp/no-daemon-acp-data',
        createRuntime: createRuntime as never,
        shutdownRuntime: vi.fn(async () => undefined) as never,
        serve: async () => undefined,
      },
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'acp', noDaemon: true }),
    );
  });
});
