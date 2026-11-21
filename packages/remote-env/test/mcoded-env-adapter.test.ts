/**
 * mcoded env transport adapter tests: RPC selection is fail-closed against
 * the explicit target config, watch is gated, descriptors expose identity
 * facets without credentials, and errors keep stable codes for forwarding.
 */
import { describe, expect, it, vi } from 'vitest';

import { RemoteEnvError } from '../src/contracts.js';
import { RemoteEnvManager } from '../src/manager.js';
import {
  remoteEnvErrorShape,
  resolveMcodedEnvSelection,
} from '../src/mcoded-env-adapter.js';
import type { RemoteEnvTargetConfig } from '../src/contracts.js';

function target(overrides: Partial<RemoteEnvTargetConfig> = {}): RemoteEnvTargetConfig {
  return {
    id: 'gpu-box',
    host: 'gpu-box.internal',
    user: 'deploy',
    knownHostsFile: '/data/ssh/known_hosts',
    hostKeyAlias: 'pi-env-gpu-box',
    cwd: '/home/me/project',
    env: { RUST_LOG: 'info', SECRET: 'do-not-leak' },
    ...overrides,
  };
}

async function activeManager(
  configure: readonly RemoteEnvTargetConfig[],
): Promise<RemoteEnvManager> {
  const manager = new RemoteEnvManager({ connect: async () => ({ connection: { close: () => undefined } as never }) });
  manager.configure(configure);
  manager.activate();
  return manager;
}

describe('resolveMcodedEnvSelection', () => {
  it('refuses selections while the backend is disabled (default-legacy invariant)', async () => {
    const manager = new RemoteEnvManager();
    manager.configure([target()]);
    await expect(
      resolveMcodedEnvSelection(manager, { targetId: 'gpu-box' }),
    ).rejects.toMatchObject({ code: 'remote_env_disabled' });
    await manager.close();
  });

  it('refuses unknown targets with a stable code', async () => {
    const manager = await activeManager([target()]);
    await expect(
      resolveMcodedEnvSelection(manager, { targetId: 'nope' }),
    ).rejects.toMatchObject({ code: 'remote_env_unknown_target', targetId: 'nope' });
    await manager.close();
  });

  it('gates watch forwarding on the target policy', async () => {
    const manager = await activeManager([target(), target({ id: 'lab', allowWatch: true })]);
    await expect(
      resolveMcodedEnvSelection(manager, { targetId: 'gpu-box', watch: true }),
    ).rejects.toMatchObject({ code: 'remote_env_watch_not_allowed' });
    const { descriptor } = await resolveMcodedEnvSelection(manager, {
      targetId: 'lab',
      watch: true,
    });
    expect(descriptor.watch).toBe(true);
    await manager.close();
  });

  it('returns an identity descriptor without leaking env values', async () => {
    const manager = await activeManager([target()]);
    const { descriptor } = await resolveMcodedEnvSelection(manager, {
      targetId: 'gpu-box',
      cwd: '/tmp/scratch',
    });
    expect(descriptor).toEqual({
      targetId: 'gpu-box',
      state: 'ready',
      identity: { host: 'gpu-box.internal', user: 'deploy' },
      cwd: '/tmp/scratch',
      envKeys: ['RUST_LOG', 'SECRET'],
      watch: false,
    });
    expect(JSON.stringify(descriptor)).not.toContain('do-not-leak');
    await manager.close();
  });

  it('surfaces host-key failures at selection time as stable codes', async () => {
    const manager = new RemoteEnvManager({
      connect: async () => {
        throw Object.assign(new Error('unknown host key'), { name: 'HostKeyUnknownError' });
      },
    });
    manager.configure([target()]);
    manager.activate();
    await expect(
      resolveMcodedEnvSelection(manager, { targetId: 'gpu-box' }),
    ).rejects.toMatchObject({ code: 'remote_env_host_key_unknown' });
    await manager.close();
  });
});

describe('remoteEnvErrorShape', () => {
  it('maps RemoteEnvError and foreign errors to bounded wire shapes', () => {
    const shaped = remoteEnvErrorShape(
      new RemoteEnvError('remote_env_unknown_target', 'nope', 'nope'),
    );
    expect(shaped).toEqual({ code: 'remote_env_unknown_target', message: 'nope', targetId: 'nope' });
    expect(remoteEnvErrorShape(new Error('boom')).code).toBe('remote_env_error');
  });
});
