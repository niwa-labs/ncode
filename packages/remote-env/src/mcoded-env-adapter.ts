/**
 * mcoded env transport adapter (W08 PORT-PI-1.3, plan :785/:789).
 *
 * The RPC boundary never hands out raw SSH controls: an RPC client selects a
 * PRE-CONFIGURED target by id, and the adapter resolves it against the
 * manager's explicit configuration, forwarding only the SSH
 * identity/path/env/cwd/watch facets the target config already allows
 * (plan D: «SSH identity/path/env/cwd/watch/error forwarding», :789).
 *
 *   * unknown target / disabled manager → stable `RemoteEnvError` codes for
 *     RPC error forwarding — never a silent fallback to the local sandbox;
 *   * `watch: true` is refused unless the target allows it
 *     (`remote_env_watch_not_allowed`);
 *   * the descriptor returned to RPC clients contains the identity facets
 *     (host/user/port, cwd, env keys — not values), so error and status
 *     forwarding stays diagnosable without leaking credentials;
 *   * errors thrown by the manager keep their stable codes and are mapped to
 *     wire shapes; remote errors keep their identity (`HostKeyChangedError`
 *     never becomes a generic failure).
 */
import type { RemoteEnvManager } from './manager.js';
import { RemoteEnvError } from './contracts.js';
import type { McodedEnvSelection, RemoteEnvErrorShape } from './contracts.js';

/** Public descriptor an RPC client may see for an accepted selection. */
export interface McodedEnvDescriptor {
  readonly targetId: string;
  readonly state: 'configured' | 'connecting' | 'ready' | 'error';
  /** SSH identity facets as configured (no credentials, no key contents). */
  readonly identity: {
    readonly host: string;
    readonly user?: string;
    readonly port?: number;
  };
  readonly cwd: string;
  /** Names of extra env vars forwarded to every remote command (not values). */
  readonly envKeys: readonly string[];
  readonly watch: boolean;
  /** Stable error code when state is `error` (mcoded error forwarding). */
  readonly error?: RemoteEnvErrorShape;
}

/**
 * Resolves an RPC env selection against the manager. Throws `RemoteEnvError`
 * with stable codes; returns the descriptor for accepted selections.
 */
export async function resolveMcodedEnvSelection(
  manager: RemoteEnvManager,
  selection: McodedEnvSelection,
): Promise<{ descriptor: McodedEnvDescriptor }> {
  if (!manager.isActive) {
    throw new RemoteEnvError(
      'remote_env_disabled',
      'Remote environments are not enabled for this runtime',
      selection.targetId,
    );
  }
  const config = manager.targetConfig(selection.targetId);
  if (!config) {
    throw new RemoteEnvError(
      'remote_env_unknown_target',
      `Remote env target "${selection.targetId}" is not configured`,
      selection.targetId,
    );
  }
  if (selection.watch === true && !manager.allowsWatch(selection.targetId)) {
    throw new RemoteEnvError(
      'remote_env_watch_not_allowed',
      `Remote env target "${selection.targetId}" does not allow watch forwarding`,
      selection.targetId,
    );
  }
  // Reachability probe: surfaces host-key/connection errors as stable codes
  // at selection time, not at first tool call. The env is shared, so this is
  // the same object later callers receive.
  await manager.getExecutionEnv(selection.targetId, selection.cwd);
  const status = manager.getStatus(selection.targetId);
  const descriptor: McodedEnvDescriptor = {
    targetId: config.id,
    state: status.state,
    identity: {
      host: config.host,
      ...(config.user !== undefined ? { user: config.user } : {}),
      ...(config.port !== undefined ? { port: config.port } : {}),
    },
    cwd: selection.cwd?.trim() ? selection.cwd : config.cwd,
    envKeys: Object.keys(config.env ?? {}),
    watch: manager.allowsWatch(selection.targetId),
    ...(status.state === 'error' && status.error
      ? { error: { code: 'remote_env_error' as const, message: status.error, targetId: config.id } }
      : {}),
  };
  return { descriptor };
}

/** Maps any error to the RPC wire shape (stable codes, no host leakage). */
export function remoteEnvErrorShape(error: unknown): RemoteEnvErrorShape {
  if (error instanceof RemoteEnvError) return error.toShape();
  return {
    code: 'remote_env_error',
    message: error instanceof Error ? error.message : String(error),
  };
}
