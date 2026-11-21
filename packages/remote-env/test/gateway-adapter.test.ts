/**
 * Gateway adapter tests: `createRemoteBashOperations` maps a pi `ExecutionEnv`
 * onto the tool gateway's `BashOperations` seam — the seam pi documents as
 * "override these to delegate command execution to remote systems". The tool
 * definition, permission path, and checkpoint are unchanged by construction;
 * these tests pin the mapping itself (command/cwd/env/timeout forwarding,
 * cancellation via chord Context, output streaming, error/exit-code shapes).
 */
import { describe, expect, it } from 'vitest';

import type { ExecutionEnv, ShellExecOptions, ShellOutputInfo } from '@earendil-works/pi-durable/env';
import type { Context } from '@earendil-works/chord/context';

import { createRemoteBashOperations } from '../src/gateway-adapter.js';
import { ok, err, ExecutionError } from '@earendil-works/pi-durable/env';

interface RecordedExec {
  command: string | readonly string[];
  options: ShellExecOptions | undefined;
  context: Context | undefined;
}

type ExecResult = { ok: true; value: { exitCode: number } } | { ok: false; error: ExecutionError };

function fakeEnv(
  behavior: (recorded: RecordedExec) => Promise<ExecResult>,
): {
  env: ExecutionEnv;
  recorded: RecordedExec[];
  lastContext: () => Context | undefined;
} {
  const recorded: RecordedExec[] = [];
  const env = {
    exec: (
      command: string | readonly string[],
      options: ShellExecOptions | undefined,
      context: Context,
    ) => {
      recorded.push({ command, options, context });
      return behavior(recorded[recorded.length - 1]!);
    },
  } as unknown as ExecutionEnv;
  return { env, recorded, lastContext: () => recorded[recorded.length - 1]?.context };
}

describe('createRemoteBashOperations', () => {
  it('forwards command, cwd, env (exact by default) and timeout to the ExecutionEnv', async () => {
    const { env, recorded } = fakeEnv(() => Promise.resolve(ok({ exitCode: 0 })));
    const ops = createRemoteBashOperations(env);

    const result = await ops.exec('echo hi', '/work', {
      onData: () => undefined,
      env: { PATH: '/usr/bin', TOKEN: 'x' },
      timeout: 30,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(recorded).toHaveLength(1);
    const record = recorded[0]!;
    expect(record.command).toBe('echo hi');
    expect(record.options?.cwd).toBe('/work');
    expect(record.options?.env).toEqual({ PATH: '/usr/bin', TOKEN: 'x' });
    // Default: exact env, no inheritance — matches the local spawn semantics.
    expect(record.options?.inheritEnv).toBe(false);
    expect(record.options?.timeout).toBe(30);
  });

  it('streams decoded output chunks to onData', async () => {
    const { env } = fakeEnv(() => Promise.resolve(ok({ exitCode: 0 })));
    const ops = createRemoteBashOperations(env);
    const chunks: Buffer[] = [];
    let sink: ((text: string, context: Context, info: ShellOutputInfo) => void) | undefined;
    // Re-wrap to capture the onOutput wiring.
    const envWithOutput = env as unknown as {
      exec: (
        command: string,
        options: ShellExecOptions | undefined,
        context: Context,
      ) => Promise<{ ok: true; value: { exitCode: number } }>;
    };
    const original = envWithOutput.exec.bind(envWithOutput);
    envWithOutput.exec = (command, options, context) => {
      sink = options?.onOutput;
      return original(command, options, context);
    };

    const done = ops.exec('long-task', '/work', { onData: (data) => chunks.push(data) });
    sink?.('partial ', {} as Context, {} as ShellOutputInfo);
    sink?.('output\n', {} as Context, {} as ShellOutputInfo);
    await done;

    expect(Buffer.concat(chunks).toString('utf8')).toBe('partial output\n');
  });

  it('cancels the remote command through the chord context on abort', async () => {
    const { env, lastContext } = fakeEnv(() => Promise.resolve(ok({ exitCode: 0 })));
    const ops = createRemoteBashOperations(env);
    const controller = new AbortController();

    const running = ops.exec('sleep 10', '/work', {
      onData: () => undefined,
      signal: controller.signal,
    });
    controller.abort();
    // The context the env received must observe the abort (withAbortSignal).
    for (let i = 0; i < 10 && !lastContext()?.abortSignal?.aborted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(lastContext()?.abortSignal?.aborted).toBe(true);
    await running;
  });

  it('rejects before dispatch when the signal is already aborted (fail-closed)', async () => {
    const { env, recorded } = fakeEnv(() => Promise.resolve(ok({ exitCode: 0 })));
    const ops = createRemoteBashOperations(env);
    const controller = new AbortController();
    controller.abort();
    await expect(
      ops.exec('rm -rf /', '/work', { onData: () => undefined, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(recorded).toHaveLength(0);
  });

  it('throws ExecutionErrors (timeout/aborted/spawn) instead of inventing an exit code', async () => {
    const { env } = fakeEnv(() =>
      Promise.resolve(err(new ExecutionError('timeout', 'command timed out'))),
    );
    const ops = createRemoteBashOperations(env);
    await expect(ops.exec('slow', '/work', { onData: () => undefined })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('supports inheritEnv opt-in and string commands verbatim', async () => {
    const { env, recorded } = fakeEnv(() => Promise.resolve(ok({ exitCode: 7 })));
    const ops = createRemoteBashOperations(env, { inheritEnv: true });
    const result = await ops.exec('git status', '/repo', {
      onData: () => undefined,
      env: { ONLY: 'this' },
    });
    expect(result).toEqual({ exitCode: 7 });
    expect(recorded[0]?.options?.inheritEnv).toBe(true);
    expect(recorded[0]?.command).toBe('git status');
  });
});
