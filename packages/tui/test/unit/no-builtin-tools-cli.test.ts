import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NO_BUILTIN_TOOLS_ENV, SESSION_MCP_ONLY_ENV } from '@mavis/config';

import { runTuiAcpCommand } from '../../src/cli/run-acp-command.js';
import { runTuiExecCommand } from '../../src/cli/run-exec-command.js';

const originalEnv = process.env[NO_BUILTIN_TOOLS_ENV];
const originalSessionEnv = process.env[SESSION_MCP_ONLY_ENV];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[NO_BUILTIN_TOOLS_ENV];
  else process.env[NO_BUILTIN_TOOLS_ENV] = originalEnv;
  if (originalSessionEnv === undefined) delete process.env[SESSION_MCP_ONLY_ENV];
  else process.env[SESSION_MCP_ONLY_ENV] = originalSessionEnv;
});

function fakeAcpProcess() {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once: vi.fn(),
    off: vi.fn(),
    exit: vi.fn(),
  };
}

describe('no-builtin-tools CLI wiring', () => {
  it('acp publishes the env mode and hosts the runtime in this process', async () => {
    const created: unknown[] = [];
    await runTuiAcpCommand(
      'test-version',
      {
        processRef: fakeAcpProcess(),
        prepareDataDir: async () => '/tmp/mcode-acp-no-builtin-tools',
        createRuntime: (async (options: unknown) => {
          created.push(options);
          return { adapter: {} };
        }) as never,
        shutdownRuntime: async () => {},
        serve: (async () => {}) as never,
      },
      undefined,
      undefined,
      undefined,
      false,
      true,
    );

    expect(process.env[NO_BUILTIN_TOOLS_ENV]).toBe('1');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ surface: 'acp', noDaemon: true });
  });

  it('acp leaves the environment alone without the flag', async () => {
    // Baseline: the caller's environment must not decide the default case.
    delete process.env[NO_BUILTIN_TOOLS_ENV];
    const created: unknown[] = [];
    await runTuiAcpCommand(
      'test-version',
      {
        processRef: fakeAcpProcess(),
        prepareDataDir: async () => '/tmp/mcode-acp-no-builtin-tools',
        createRuntime: (async (options: unknown) => {
          created.push(options);
          return { adapter: {} };
        }) as never,
        shutdownRuntime: async () => {},
        serve: (async () => {}) as never,
      },
    );

    expect(process.env[NO_BUILTIN_TOOLS_ENV]).toBeUndefined();
    expect(created[0]).not.toHaveProperty('noDaemon');
  });

  it('acp honors an inherited env-only request by hosting in this process', async () => {
    process.env[NO_BUILTIN_TOOLS_ENV] = '1';
    const created: unknown[] = [];
    await runTuiAcpCommand(
      'test-version',
      {
        processRef: fakeAcpProcess(),
        prepareDataDir: async () => '/tmp/mcode-acp-no-builtin-tools',
        createRuntime: (async (options: unknown) => {
          created.push(options);
          return { adapter: {} };
        }) as never,
        shutdownRuntime: async () => {},
        serve: (async () => {}) as never,
      },
    );

    expect(process.env[NO_BUILTIN_TOOLS_ENV]).toBe('1');
    expect(created[0]).toMatchObject({ surface: 'acp', noDaemon: true });
  });

  it('acp publishes the session MCP scope and hosts the runtime in this process', async () => {
    const created: unknown[] = [];
    await runTuiAcpCommand(
      'test-version',
      {
        processRef: fakeAcpProcess(),
        prepareDataDir: async () => '/tmp/mcode-acp-no-builtin-tools',
        createRuntime: (async (options: unknown) => {
          created.push(options);
          return { adapter: {} };
        }) as never,
        shutdownRuntime: async () => {},
        serve: (async () => {}) as never,
      },
      undefined,
      undefined,
      undefined,
      false,
      false,
      true,
    );

    expect(process.env[SESSION_MCP_ONLY_ENV]).toBe('1');
    expect(created[0]).toMatchObject({ surface: 'acp', noDaemon: true });
  });

  it('exec honors an inherited env-only request by hosting in this process', async () => {
    process.env[NO_BUILTIN_TOOLS_ENV] = '1';
    const created: unknown[] = [];
    await runTuiExecCommand('hello', {}, 'test-version', {
      processRef: { once: vi.fn(), off: vi.fn() },
      writeError: () => {},
      resolveInvocation: (async () => ({
        prompt: 'hello',
        workspaceDir: process.cwd(),
        attachments: [],
        permission: 'smart',
        format: 'text',
        continueSession: false,
      })) as never,
      resolveDataDir: () => '/tmp/mcode-exec-no-builtin-tools',
      createRuntime: (async (options: unknown) => {
        created.push(options);
        return { adapter: {} };
      }) as never,
      shutdownRuntime: async () => {},
      runExec: (async () => 0) as never,
    });

    expect(created[0]).toMatchObject({ surface: 'headless', noDaemon: true });
  });

  it('exec publishes the env mode and hosts the runtime in this process', async () => {
    const created: unknown[] = [];
    await runTuiExecCommand('hello', {}, 'test-version', {
      processRef: { once: vi.fn(), off: vi.fn() },
      writeError: () => {},
      resolveInvocation: (async () => ({
        prompt: 'hello',
        workspaceDir: process.cwd(),
        attachments: [],
        permission: 'smart',
        format: 'text',
        continueSession: false,
        noBuiltinTools: true,
      })) as never,
      resolveDataDir: () => '/tmp/mcode-exec-no-builtin-tools',
      createRuntime: (async (options: unknown) => {
        created.push(options);
        return { adapter: {} };
      }) as never,
      shutdownRuntime: async () => {},
      runExec: (async () => 0) as never,
    });

    expect(process.env[NO_BUILTIN_TOOLS_ENV]).toBe('1');
    expect(created[0]).toMatchObject({ surface: 'headless', noDaemon: true });
  });
});
