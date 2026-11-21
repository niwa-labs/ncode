/**
 * Remote environment manager (W08 PORT-PI-1.3, plan §4 :511).
 *
 * Owns the opt-in pi-env lifecycle: explicit target configuration, lazy SSH
 * connection per target, `RemoteExecutionEnv` instances per (target, cwd).
 * The manager is DISABLED until `activate()` — no implicit environment
 * selection anywhere (I08 default/legacy; plan :789 «remote environment
 * проходит тот же product permission/effect checkpoint», :791 «optional
 * activation работает, локальный startup остаётся lazy»).
 *
 * The connection seam is injectable so tests run without an SSH server; the
 * production seam is pi's `connectSsh` (deploy daemon over SSH, BatchMode,
 * strict host-key checking against the app-owned known_hosts file).
 */
import { RemoteExecutionEnv, type Connection, type SshConnectOptions } from '@earendil-works/pi-env';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
  RemoteEnvTargetConfig,
} from './contracts.js';
import {
  RemoteEnvError,
  validateRemoteEnvTarget,
} from './contracts.js';

export interface RemoteEnvRuntimeLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

/** Production SSH seam signature (subset of pi `connectSsh` the manager needs). */
export type RemoteEnvConnect = (
  options: SshConnectOptions,
) => Promise<{ connection: Connection }> | { connection: Connection };export interface RemoteEnvManagerOptions {
  logger?: RemoteEnvRuntimeLogger;
  /** Test/host seam. Defaults to pi `connectSsh`. */
  connect?: RemoteEnvConnect;
}

export interface RemoteEnvStatus {
  readonly targetId: string;
  readonly state: 'configured' | 'connecting' | 'ready' | 'error';
  readonly error?: string;
}

interface ManagedTarget {
  readonly config: RemoteEnvTargetConfig;
  connection: Connection | undefined;
  connecting: Promise<Connection> | undefined;
  envs: Map<string, RemoteExecutionEnv>;
  error: string | undefined;
}

const NOOP_LOGGER: RemoteEnvRuntimeLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class RemoteEnvManager {
  private readonly targets = new Map<string, ManagedTarget>();
  private readonly connectImpl: RemoteEnvConnect;
  private readonly logger: RemoteEnvRuntimeLogger;
  private active = false;
  private closed = false;

  constructor(options: RemoteEnvManagerOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    // pi `connectSsh` is a pure factory (no I/O until the first operation),
    // so the default seam is created lazily in `defaultConnect`.
    this.connectImpl = options.connect ?? defaultConnect;
  }

  /** Turns the opt-in backend on. Configuration stays explicit either way. */
  activate(): void {
    this.assertOpen();
    this.active = true;
    this.logger.info('Remote env manager activated', { targets: this.targets.size });
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Registers (or replaces) the explicit target set. Fails closed on any invalid entry. */
  configure(targets: readonly RemoteEnvTargetConfig[]): void {
    this.assertOpen();
    const seen = new Set<string>();
    for (const config of targets) {
      const invalid = validateRemoteEnvTarget(config);
      if (invalid) {
        throw new RemoteEnvError('remote_env_invalid_target', invalid, config.id);
      }
      if (seen.has(config.id)) {
        throw new RemoteEnvError('remote_env_invalid_target', `duplicate remote env target id "${config.id}"`, config.id);
      }
      seen.add(config.id);
    }
    // Close connections for targets that disappeared.
    for (const [id, managed] of this.targets) {
      if (!seen.has(id)) {
        void this.dropTarget(managed);
        this.targets.delete(id);
      }
    }
    for (const config of targets) {
      const existing = this.targets.get(config.id);
      if (existing && JSON.stringify(existing.config) === JSON.stringify(config)) continue;
      if (existing) {
        void this.dropTarget(existing);
      }
      this.targets.set(config.id, {
        config,
        connection: undefined,
        connecting: undefined,
        envs: new Map(),
        error: undefined,
      });
    }
    this.logger.info('Remote env targets configured', { targets: [...this.targets.keys()] });
  }

  listTargets(): string[] {
    return [...this.targets.keys()].sort();
  }

  getStatus(targetId: string): RemoteEnvStatus {
    const managed = this.targets.get(targetId);
    if (!managed) return { targetId, state: 'configured', error: 'unknown target' };
    if (managed.error) return { targetId, state: 'error', error: managed.error };
    if (managed.connection) return { targetId, state: 'ready' };
    if (managed.connecting) return { targetId, state: 'connecting' };
    return { targetId, state: 'configured' };
  }

  /**
   * Returns the shared `RemoteExecutionEnv` for the target. Throws
   * `RemoteEnvError` (stable code) when disabled, unknown, or misconfigured —
   * never a silent fallback to the local environment.
   */
  async getExecutionEnv(targetId: string, cwdOverride?: string): Promise<RemoteExecutionEnv> {
    this.assertOpen();
    if (!this.active) {
      throw new RemoteEnvError('remote_env_disabled', 'Remote environments are not enabled for this runtime', targetId);
    }
    const managed = this.targets.get(targetId);
    if (!managed) {
      throw new RemoteEnvError('remote_env_unknown_target', `Remote env target "${targetId}" is not configured`, targetId);
    }
    const cwd = cwdOverride?.trim() ? cwdOverride : managed.config.cwd;
    const key = cwd;
    const existing = managed.envs.get(key);
    if (existing) return existing;
    const connection = await this.ensureConnection(targetId, managed);
    const env = new RemoteExecutionEnv({
      connection,
      id: `pi-env:${managed.config.id}`,
      cwd,
      ...(managed.config.env ? { shellEnv: { ...managed.config.env } } : {}),
    });
    managed.envs.set(key, env);
    return env;
  }

  /** Watch forwarding policy for a target (mcoded transport adapter gate). */
  allowsWatch(targetId: string): boolean {
    return this.targets.get(targetId)?.config.allowWatch === true;
  }

  targetConfig(targetId: string): RemoteEnvTargetConfig | undefined {
    return this.targets.get(targetId)?.config;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.active = false;
    await Promise.allSettled([...this.targets.values()].map((managed) => this.dropTarget(managed)));
    this.targets.clear();
    this.logger.info('Remote env manager closed');
  }

  // ---------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new RemoteEnvError('remote_env_closed', 'Remote env manager is closed');
  }

  private async ensureConnection(targetId: string, managed: ManagedTarget): Promise<Connection> {
    if (managed.connection) return managed.connection;
    managed.connecting ??= this.openConnection(targetId, managed).finally(() => {
      managed.connecting = undefined;
    });
    return managed.connecting;
  }

  private async openConnection(targetId: string, managed: ManagedTarget): Promise<Connection> {
    const config = managed.config;
    this.logger.info('Connecting remote env target', { targetId, host: config.host });
    try {
      const { connection } = await this.connectImpl({
        // SshConnectOptions extends SshTarget flat.
        host: config.host,
        ...(config.user !== undefined ? { user: config.user } : {}),
        ...(config.port !== undefined ? { port: config.port } : {}),
        ...(config.identityFile !== undefined ? { identityFile: config.identityFile } : {}),
        knownHostsFile: config.knownHostsFile,
        hostKeyAlias: config.hostKeyAlias,
      });
      managed.connection = connection;
      managed.error = undefined;
      return connection;
    } catch (error) {
      managed.error = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to connect remote env target', { targetId, error: managed.error });
      throw this.asRemoteEnvError(error, targetId);
    }
  }

  private asRemoteEnvError(error: unknown, targetId: string): RemoteEnvError {
    if (error instanceof RemoteEnvError) return error;
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'HostKeyUnknownError') {
      return new RemoteEnvError('remote_env_host_key_unknown', message, targetId, { cause: error });
    }
    if (name === 'HostKeyChangedError') {
      return new RemoteEnvError('remote_env_host_key_changed', message, targetId, { cause: error });
    }
    if (name === 'SshError') {
      return new RemoteEnvError('remote_env_auth_failed', message, targetId, { cause: error });
    }
    if (name === 'RemoteError' || name === 'ConnectionLostError') {
      return new RemoteEnvError('remote_env_connection_lost', message, targetId, { cause: error });
    }
    return new RemoteEnvError('remote_env_error', message, targetId, { cause: error });
  }

  private async dropTarget(managed: ManagedTarget): Promise<void> {
    for (const env of managed.envs.values()) {
      try {
        // Mandatory shutdown path: no caller cancellation (withoutAbortSignal
        // semantics via the background context).
        await env.cleanup(BACKGROUND_CONTEXT);
      } catch {
        // Best-effort shutdown; the remote daemon dies with the connection.
      }
    }
    managed.envs.clear();
    const connection = managed.connection;
    managed.connection = undefined;
    try {
      await connection?.close();
    } catch {
      // Idempotent close; daemon side cleans up on EOF.
    }
  }
}

async function defaultConnect(options: SshConnectOptions): Promise<{ connection: Connection }> {
  const { connectSsh } = await import('@earendil-works/pi-env');
  return connectSsh(options);
}
