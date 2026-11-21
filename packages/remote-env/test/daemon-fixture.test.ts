/**
 * Real pi-env daemon fixture test (W08-T «fixture … remote tools/watch/cancel/
 * reconnect», plan :789 — the daemon leg; the SSH leg is the separate G-LIVE
 * scenario requiring a reachable host and is NOT run here).
 *
 * Requires the pi-env daemon binary. `cargo build` in
 * `third_party/pi-mono/packages/env/daemon` produces
 * `target/debug/pi-env`; the test skips itself when neither
 * `MCODE_PI_ENV_DAEMON` nor the default build output exists, so the
 * repository suite stays green without a Rust toolchain.
 *
 * Exercises the whole production chain over the real framed protocol:
 * command exec with output streaming and exit codes, cancellation through
 * the adapter's chord-Context bridge, and bounded `listFiles` against the
 * local filesystem via `LocalExecutionEnv`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Connection, LocalExecutionEnv, RemoteExecutionEnv } from '@earendil-works/pi-env';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

import { createRemoteBashOperations } from '../src/gateway-adapter.js';

const daemonPath =
  process.env.MCODE_PI_ENV_DAEMON ??
  new URL('../../../third_party/pi-mono/packages/env/daemon/target/debug/pi-env', import.meta.url)
    .pathname;

let daemonAvailable = false;
try {
  execFileSync(daemonPath, ['--version'], { stdio: 'ignore' });
  daemonAvailable = true;
} catch {
  daemonAvailable = false;
}

function withDaemon(): { connection: Connection } {
  return { connection: new Connection({ command: [daemonPath] }) };
}

describe.skipIf(!daemonAvailable)('pi-env daemon fixture (real protocol)', () => {
  it('executes commands with streaming output and exit codes through the gateway adapter', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'remote-env-fixture-'));
    try {
      const { connection } = withDaemon();
      const env = new RemoteExecutionEnv({ connection, id: 'pi-env:fixture', cwd: workdir });
      const ops = createRemoteBashOperations(env);

      const chunks: Buffer[] = [];
      const result = await ops.exec('printf "hello-remote"', workdir, { onData: (d) => chunks.push(d) });
      expect(result.exitCode).toBe(0);
      expect(Buffer.concat(chunks).toString('utf8')).toContain('hello-remote');

      const failing = await ops.exec('exit 3', workdir, { onData: () => undefined });
      expect(failing.exitCode).toBe(3);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 30_000);

  it('cancels a long-running command through the adapter abort bridge', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'remote-env-fixture-'));
    try {
      const { connection } = withDaemon();
      const env = new RemoteExecutionEnv({ connection, id: 'pi-env:fixture', cwd: workdir });
      const ops = createRemoteBashOperations(env);
      const controller = new AbortController();
      const running = ops.exec('sleep 30', workdir, {
        onData: () => undefined,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      // pi maps the abort to an ExecutionError (code aborted); the adapter
      // must not swallow it into a fake exit code.
      await expect(running).rejects.toMatchObject({ code: 'aborted' });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 30_000);

  it('lists files through LocalExecutionEnv with bounded entries', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'remote-env-fixture-'));
    try {
      writeFileSync(join(workdir, 'a.txt'), 'a');
      writeFileSync(join(workdir, 'b.txt'), 'b');
      const { connection } = withDaemon();
      const local = new LocalExecutionEnv({ cwd: workdir, connection });
      const listing = await local.listFiles('.', { maxEntries: 10 }, BACKGROUND_CONTEXT);
      expect(listing.ok).toBe(true);
      if (listing.ok) {
        const names = listing.value.entries.map((entry) => entry.path).sort();
        expect(names).toEqual(['a.txt', 'b.txt']);
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 30_000);
});
