/**
 * Remote env manager tests: opt-in activation, fail-closed configuration,
 * lazy shared connections, stable error codes. The SSH seam is injected —
 * no network, no daemon (the real-SSH scenario is a separate G-LIVE gate,
 * run with `MCODE_REMOTE_ENV_SSH_TEST=1` + a reachable host; not run here).
 */
import { describe, expect, it, vi } from 'vitest';

import type { Connection, SshConnectOptions } from '@earendil-works/pi-env';

import { RemoteEnvError, validateRemoteEnvTarget } from '../src/contracts.js';
import { RemoteEnvManager } from '../src/manager.js';
import type { RemoteEnvTargetConfig } from '../src/contracts.js';

function target(overrides: Partial<RemoteEnvTargetConfig> = {}): RemoteEnvTargetConfig {
  return {
    id: 'gpu-box',
    host: 'gpu-box.internal',
    knownHostsFile: '/data/ssh/known_hosts',
    hostKeyAlias: 'pi-env-gpu-box',
    cwd: '/home/me/project',
    ...overrides,
  };
}

function fakeConnection(): Connection {
  return { close: () => undefined } as unknown as Connection;
}

function managerWith(connect: ReturnType<typeof vi.fn>): RemoteEnvManager {
  return new RemoteEnvManager({ connect });
}

describe('validateRemoteEnvTarget', () => {
  it('requires host, knownHostsFile, hostKeyAlias, cwd and a safe id', () => {
    expect(validateRemoteEnvTarget(target())).toBeUndefined();
    expect(validateRemoteEnvTarget(target({ host: '' }))).toMatch(/missing host/);
    expect(validateRemoteEnvTarget(target({ knownHostsFile: ' ' }))).toMatch(/knownHostsFile/);
    expect(validateRemoteEnvTarget(target({ hostKeyAlias: undefined as never }))).toMatch(/hostKeyAlias/);
    expect(validateRemoteEnvTarget(target({ cwd: '' }))).toMatch(/missing cwd/);
    expect(validateRemoteEnvTarget(target({ id: 'bad id!' }))).toMatch(/target id/);
    expect(validateRemoteEnvTarget(target({ port: 0 }))).toMatch(/invalid port/);
  });
});

describe('RemoteEnvManager', () => {
  it('fails closed before activation even with configured targets', async () => {
    const connect = vi.fn(async () => ({ connection: fakeConnection() }));
    const manager = managerWith(connect);
    manager.configure([target()]);

    await expect(manager.getExecutionEnv('gpu-box')).rejects.toMatchObject({
      code: 'remote_env_disabled',
    });
    expect(connect).not.toHaveBeenCalled();
    await manager.close();
  });

  it('rejects unknown targets and invalid configs without contacting anything', async () => {
    const connect = vi.fn(async () => ({ connection: fakeConnection() }));
    const manager = managerWith(connect);
    manager.activate();

    await expect(manager.getExecutionEnv('ghost')).rejects.toMatchObject({
      code: 'remote_env_unknown_target',
    });
    expect(() => manager.configure([target({ knownHostsFile: '' })])).toThrow(RemoteEnvError);
    expect(() => manager.configure([target(), target()])).toThrow(/duplicate/);
    expect(connect).not.toHaveBeenCalled();
    await manager.close();
  });

  it('opens one shared connection lazily and reuses it across envs', async () => {
    const connect = vi.fn(
      async (_options: SshConnectOptions): Promise<{ connection: Connection }> => ({
        connection: fakeConnection(),
      }),
    );
    const manager = managerWith(connect);
    manager.activate();
    manager.configure([target()]);

    const envA = await manager.getExecutionEnv('gpu-box');
    const envB = await manager.getExecutionEnv('gpu-box');
    const envC = await manager.getExecutionEnv('gpu-box', '/other/cwd');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(envB).toBe(envA); // same (target, cwd) → same env
    expect(envC).not.toBe(envA);
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      host: 'gpu-box.internal',
      knownHostsFile: '/data/ssh/known_hosts',
      hostKeyAlias: 'pi-env-gpu-box',
    });
    expect(manager.getStatus('gpu-box').state).toBe('ready');
    await manager.close();
  });

  it('forwards user, port and identityFile when configured', async () => {
    const connect = vi.fn(
      async (_options: SshConnectOptions): Promise<{ connection: Connection }> => ({
        connection: fakeConnection(),
      }),
    );
    const manager = managerWith(connect);
    manager.activate();
    manager.configure([
      target({ user: 'deploy', port: 2222, identityFile: '/keys/gpu', env: { RUST_LOG: 'info' } }),
    ]);

    await manager.getExecutionEnv('gpu-box');
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      user: 'deploy',
      port: 2222,
      identityFile: '/keys/gpu',
    });
    await manager.close();
  });

  it('maps host-key failures to stable codes without retry loops', async () => {
    const failure = Object.assign(new Error('host key changed'), { name: 'HostKeyChangedError' });
    const connect = vi.fn(async () => {
      throw failure;
    });
    const manager = managerWith(connect);
    manager.activate();
    manager.configure([target()]);

    await expect(manager.getExecutionEnv('gpu-box')).rejects.toMatchObject({
      code: 'remote_env_host_key_changed',
      targetId: 'gpu-box',
    });
    expect(manager.getStatus('gpu-box').state).toBe('error');
    await manager.close();
  });

  it('rejects operations after close', async () => {
    const manager = managerWith(vi.fn());
    await manager.close();
    expect(() => manager.configure([target()])).toThrow(RemoteEnvError);
    expect(() => manager.activate()).toThrow(RemoteEnvError);
  });

  it('is watch-gated per target for the mcoded adapter', () => {
    const manager = managerWith(vi.fn());
    manager.configure([target(), target({ id: 'lab', allowWatch: true })]);
    expect(manager.allowsWatch('gpu-box')).toBe(false);
    expect(manager.allowsWatch('lab')).toBe(true);
    expect(manager.listTargets()).toEqual(['gpu-box', 'lab']);
    return manager.close();
  });
});
