/**
 * Remote environment contracts (W08 PORT-PI-1.3, plan §4 :511 / §2.4.6 :198).
 *
 * The remote environment is an OPT-IN execution backend for the tool gateway.
 * It never creates an alternative permission path, a second session store, or
 * an implicit host selection: every target is explicitly configured, every
 * activation is explicit, and missing pieces fail closed with diagnosable
 * errors. Stable error codes cross the mcoded RPC boundary unchanged.
 */

/**
 * One explicitly configured SSH target. All identity fields are REQUIRED —
 * there is no default host, no default key, no default known_hosts (plan D:
 * "SSH identity/path/env/cwd/watch/error forwarding", plan :789).
 */
export interface RemoteEnvTargetConfig {
  /** Stable target id used by tool configs and RPC selections, e.g. `gpu-box`. */
  readonly id: string;
  /** Host name or `~/.ssh/config` alias. */
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  /** Explicit identity file; never inherited from an ambient agent config. */
  readonly identityFile?: string;
  /**
   * Application-owned known-hosts file. Required: pi never uses the user's
   * global known_hosts, and the hybrid must not either (identity isolation).
   */
  readonly knownHostsFile: string;
  /** Name host keys are stored under, independent of aliases/ports. */
  readonly hostKeyAlias: string;
  /** Default working directory on the remote machine. Required. */
  readonly cwd: string;
  /** Extra environment variables for every remote command (pi `shellEnv`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Watch forwarding policy for the mcoded transport adapter (default false). */
  readonly allowWatch?: boolean;
}

/** Remote environment selection arriving over mcoded RPC. */
export interface McodedEnvSelection {
  /** Configured target id. Absent/unknown → explicit error, never a fallback. */
  readonly targetId: string;
  /** Per-session working directory override inside the target. */
  readonly cwd?: string;
  /** Enable watch/event forwarding for this session (target must allow it). */
  readonly watch?: boolean;
}

/** Stable, bounded error codes for the mcoded RPC surface. */
export type RemoteEnvErrorCode =
  | 'remote_env_disabled'
  | 'remote_env_unknown_target'
  | 'remote_env_invalid_target'
  | 'remote_env_host_key_unknown'
  | 'remote_env_host_key_changed'
  | 'remote_env_connection_lost'
  | 'remote_env_auth_failed'
  | 'remote_env_watch_not_allowed'
  | 'remote_env_closed'
  | 'remote_env_error';

export interface RemoteEnvErrorShape {
  readonly code: RemoteEnvErrorCode;
  readonly message: string;
  readonly targetId?: string;
}

/** Thrown by the manager; carries the stable code for RPC forwarding. */
export class RemoteEnvError extends Error {
  readonly code: RemoteEnvErrorCode;
  readonly targetId: string | undefined;

  constructor(
    code: RemoteEnvErrorCode,
    message: string,
    targetId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = 'RemoteEnvError';
    this.code = code;
    this.targetId = targetId;
  }

  /** Wire shape for mcoded error forwarding (no host names beyond the id). */
  toShape(): RemoteEnvErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.targetId !== undefined ? { targetId: this.targetId } : {}),
    };
  }
}

/** Bounded target-id charset: letters, digits, `-`, `_`, `.` (no separators that collide with cache keys). */
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validates one target config; returns the error message or undefined. */
export function validateRemoteEnvTarget(config: RemoteEnvTargetConfig): string | undefined {
  if (typeof config.id !== 'string' || !TARGET_ID_PATTERN.test(config.id)) {
    return `remote env target id must match ${TARGET_ID_PATTERN.source}`;
  }
  if (typeof config.host !== 'string' || config.host.trim().length === 0) {
    return `remote env target "${config.id}" is missing host`;
  }
  if (typeof config.knownHostsFile !== 'string' || config.knownHostsFile.trim().length === 0) {
    return `remote env target "${config.id}" is missing knownHostsFile (app-owned known_hosts is required)`;
  }
  if (typeof config.hostKeyAlias !== 'string' || config.hostKeyAlias.trim().length === 0) {
    return `remote env target "${config.id}" is missing hostKeyAlias`;
  }
  if (typeof config.cwd !== 'string' || config.cwd.trim().length === 0) {
    return `remote env target "${config.id}" is missing cwd`;
  }
  if (config.port !== undefined && (!Number.isInteger(config.port) || config.port <= 0)) {
    return `remote env target "${config.id}" has an invalid port`;
  }
  return undefined;
}
