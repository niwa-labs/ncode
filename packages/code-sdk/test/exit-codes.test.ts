import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  NcodeAbortError,
  NcodeError,
  NcodeInvocationError,
  NcodeProtocolError,
  NcodeRunError,
} from '../src/index.js';
import {
  ExecProcess,
  processTimings,
  releaseTrackedResources,
  trackTempDir,
} from '../src/exec-process.js';
import { checkCliVersion } from '../src/version.js';
import { fakeClient, fixture, tempDir } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

async function failureFor(
  exitCode: number,
  stderr = 'ncode exec failed: details',
): Promise<unknown> {
  const ncode = fakeClient({ FAKE_NCODE_EXIT: String(exitCode), FAKE_NCODE_STDERR: stderr });
  return ncode
    .startThread()
    .run('x')
    .catch((error: unknown) => error);
}

describe('exit code mapping without exec.completed', () => {
  it('maps exit 2 to NcodeInvocationError with the CLI message', async () => {
    const error = await failureFor(2, 'error: --effort must be one of low, medium, high');
    expect(error).toBeInstanceOf(NcodeInvocationError);
    expect((error as NcodeInvocationError).message).toContain('--effort must be one of');
    expect((error as NcodeInvocationError).exitCode).toBe(2);
  });

  it.each([
    [3, 'failed', 'config'],
    [4, 'failed', 'runtime'],
    [6, 'timeout', undefined],
    [7, 'limit_exceeded', undefined],
    [70, 'failed', 'internal'],
    // Codes outside the documented exec contract.
    [1, 'failed', 'internal'],
  ] as const)('maps exit %i to NcodeRunError(status=%s)', async (code, status, category) => {
    const error = await failureFor(code);
    expect(error).toBeInstanceOf(NcodeRunError);
    expect((error as NcodeRunError).status).toBe(status);
    expect((error as NcodeRunError).category).toBe(category);
    expect((error as NcodeRunError).result).toBeUndefined();
    expect((error as NcodeRunError).stderr).toContain('details');
  });

  it('maps exit 130 to NcodeAbortError', async () => {
    const error = await failureFor(130);
    expect(error).toBeInstanceOf(NcodeAbortError);
    expect((error as Error).name).toBe('AbortError');
  });

  it.each([141, 0])('maps exit %i to NcodeProtocolError', async (code) => {
    expect(await failureFor(code)).toBeInstanceOf(NcodeProtocolError);
  });
});

describe('failures before exec.completed keep the observed Session', () => {
  it('reports the sessionId from exec.started when the CLI exits 4 without a result', async () => {
    const path = `${tempDir()}/started-only.jsonl`;
    const lines = readFileSync(fixture('failed-upstream'), 'utf8').split('\n').slice(0, 3);
    writeFileSync(path, `${lines.join('\n')}\n`);

    const error = await fakeClient({ FAKE_NCODE_FIXTURE: path, FAKE_NCODE_EXIT: '4' })
      .startThread()
      .run('x')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NcodeRunError);
    expect((error as NcodeRunError).result).toBeUndefined();
    expect((error as NcodeRunError).sessionId).toBe('mvs_8d8ee44bc4994c1cacd3af0aa64d7a0a');
  });

  it('falls back to the resumed Session id when the CLI emitted no event', async () => {
    const error = await fakeClient({ FAKE_NCODE_EXIT: '3' })
      .resumeThread('mvs_resumed')
      .run('x')
      .catch((caught: unknown) => caught);
    expect((error as NcodeRunError).sessionId).toBe('mvs_resumed');
  });
});

describe('process exit with inherited pipes', () => {
  const grandchildren: number[] = [];
  afterEach(() => {
    for (const pid of grandchildren.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('settles shortly after the CLI exits even if a grandchild keeps stdout open', async () => {
    const pidFile = `${tempDir()}/grandchild.pid`;
    const ncode = fakeClient({
      FAKE_NCODE_FIXTURE: fixture('resumed'),
      FAKE_NCODE_GRANDCHILD_PID: pidFile,
    });
    const started = Date.now();

    const turn = await ncode.startThread().run('go', { timeoutMs: 1_000 });

    if (existsSync(pidFile)) grandchildren.push(Number(readFileSync(pidFile, 'utf8')));
    // The grandchild lives for 30s; the SDK drains for at most processTimings.exitDrainMs (2s).
    expect(Date.now() - started).toBeLessThan(processTimings.exitDrainMs + 3_000);
    // All lines written before exit are still delivered, including exec.completed.
    expect(turn.finalResponse).toMatch(/^I wrote exactly/u);
    expect(grandchildren).toHaveLength(1);
  });
});

describe('cancellation escalation and timeout backstop', () => {
  posixOnly('escalates SIGTERM to SIGKILL when the CLI ignores the cancel signal', async () => {
    const original = { ...processTimings };
    Object.assign(processTimings, { cancelGraceMs: 50 });
    try {
      const ncode = fakeClient({
        FAKE_NCODE_FIXTURE: fixture('cancelled'),
        FAKE_NCODE_MODE: 'ignore-signals',
        FAKE_NCODE_SPLIT: '5',
      });
      const thread = ncode.startThread();
      const controller = new AbortController();
      const pending = thread
        .run('x', { signal: controller.signal })
        .catch((error: unknown) => error);
      while (thread.id === null) await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      const error = await pending;
      expect(error).toBeInstanceOf(NcodeAbortError);
      expect((error as NcodeAbortError).signal).toBe('SIGKILL');
      expect((error as NcodeAbortError).sessionId).toBe('mvs_78b922a823a345728486967e33c95770');
      // Items seen before the kill are kept for diagnosis even without a result.
      expect((error as NcodeAbortError).items).toEqual([
        expect.objectContaining({ type: 'agent_message', incomplete: true }),
      ]);
    } finally {
      Object.assign(processTimings, original);
    }
  });

  posixOnly('force-stops a CLI that outlives timeoutMs and reports status timeout', async () => {
    const original = { ...processTimings };
    Object.assign(processTimings, { backstopExtraMs: 50 });
    try {
      const ncode = fakeClient({
        FAKE_NCODE_FIXTURE: fixture('cancelled'),
        FAKE_NCODE_MODE: 'hang',
      });
      const error = await ncode
        .startThread()
        .run('x', { timeoutMs: 100 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NcodeRunError);
      expect((error as NcodeRunError).status).toBe('timeout');
      expect((error as NcodeRunError).signal).toBe('SIGKILL');
    } finally {
      Object.assign(processTimings, original);
    }
  });
});

function nullStdioChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = null;
  child.stdout = null;
  child.stderr = null;
  child.kill = () => true;
  return child;
}

describe('spawn without stdio', () => {
  it('turns a null-stdio child into NcodeError and handles the delayed error event', async () => {
    const child = nullStdioChild();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    try {
      expect(
        () =>
          new ExecProcess({
            command: { command: 'ncode', args: ['exec'] },
            env: {},
            prompt: 'x',
            spawn: (() => child) as typeof spawn,
          }),
      ).toThrow(NcodeError);
      child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('rejects a version check with null stdio and clears the failure timer', async () => {
    const child = nullStdioChild();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const pending = checkCliVersion(
        { kind: 'exec', path: 'ncode', source: 'path' },
        {},
        (() => child) as typeof spawn,
      );
      const rejected = expect(pending).rejects.toBeInstanceOf(NcodeError);
      child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }));
      await rejected;
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

describe('process exit cleanup', () => {
  it('removes tracked prompt directories synchronously', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ncode-sdk-'));
    writeFileSync(join(directory, 'system-prompt.txt'), 'secret', { mode: 0o600 });
    trackTempDir(directory);
    expect(process.listeners('exit')).toContain(releaseTrackedResources);

    releaseTrackedResources();

    expect(existsSync(directory)).toBe(false);
  });
});
