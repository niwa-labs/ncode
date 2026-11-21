/**
 * Per-session ACP permission-mode registry (spec §2.1): one in-memory entry
 * per ACP-bound Session, owned by the runtime process (the mcoded daemon or
 * an embedded off-mode host). No persistence — `session/load` without an
 * explicit mode always rebinds to `default` and the client re-sends its mode.
 *
 * The lifecycle: `bind` on session/new|load|resume sets the mode and lifts
 * the lock; the first accepted Turn `lock`s the mode for the Session's rest
 * of life; child Sessions (task subagents, background tasks, side forks)
 * `inherit` a locked copy; `release` drops the entry on Session deletion.
 */

export type AcpPermissionMode = 'default' | 'auto' | 'bypassPermissions';

export interface SessionPermissionModeEntry {
  mode: AcpPermissionMode;
  /** True after the first accepted Turn since new/load; `set` then refuses changes. */
  locked: boolean;
  origin:
    | 'new-explicit'
    | 'new-default'
    | 'load-explicit'
    | 'load-default'
    | 'set-config'
    | 'inherited';
}

export type SetModeError =
  | { code: 'locked'; currentValue: AcpPermissionMode }
  | { code: 'turn_active'; currentValue: AcpPermissionMode };

export type SetModeResult =
  | { ok: true }
  | { ok: false; error: SetModeError };

export interface SessionPermissionModeRegistry {
  get(sessionId: string): SessionPermissionModeEntry | undefined;
  /** new/load: sets the mode and lifts the lock; `turn_active` when a Turn runs and the mode differs. */
  bind(
    sessionId: string,
    mode: AcpPermissionMode,
    origin: SessionPermissionModeEntry['origin'],
  ): SetModeResult;
  /** set_config_option: same mode → no-op ok; another mode while locked → 'locked'. */
  set(sessionId: string, mode: AcpPermissionMode): SetModeResult;
  inherit(childSessionId: string, parentSessionId: string): void;
  /** Idempotent; a missing entry is a no-op. */
  lock(sessionId: string): void;
  release(sessionId: string): void;
}

export interface SessionPermissionModeRegistryOptions {
  /**
   * Live Turn probe backing `bind`'s `turn_active` refusal: rebinding a
   * Session whose Turn is currently running to a DIFFERENT mode would change
   * the policy under the running Turn. Absent (tests) never refuses.
   */
  readonly isTurnActive?: (sessionId: string) => boolean;
}

export function createSessionPermissionModeRegistry(
  options: SessionPermissionModeRegistryOptions = {},
): SessionPermissionModeRegistry {
  const entries = new Map<string, SessionPermissionModeEntry>();
  return {
    get: (sessionId) => entries.get(sessionId),
    bind: (sessionId, mode, origin) => {
      const current = entries.get(sessionId);
      const turnActive = options.isTurnActive?.(sessionId) === true;
      if (current && current.mode !== mode && turnActive) {
        return {
          ok: false,
          error: { code: 'turn_active', currentValue: current.mode },
        };
      }
      // A rebind under a running Turn (same mode, or a Session without an
      // entry yet) keeps the mode locked: lifting it would let a following
      // set_config_option change the policy under that very Turn. The lock
      // is lifted only when no Turn runs; it re-arms at the next first Turn.
      entries.set(sessionId, { mode, locked: turnActive, origin });
      return { ok: true };
    },
    set: (sessionId, mode) => {
      const current = entries.get(sessionId);
      if (!current) {
        // An explicit set_config_option for a Session without an entry (e.g.
        // the daemon restarted under a live ACP agent) binds the Session to
        // the client's intent. A silent no-op would leave the Session on the
        // process config — a mode it never negotiated either.
        entries.set(sessionId, {
          mode,
          locked: options.isTurnActive?.(sessionId) === true,
          origin: 'set-config',
        });
        return { ok: true };
      }
      if (current.locked && current.mode !== mode) {
        return {
          ok: false,
          error: { code: 'locked', currentValue: current.mode },
        };
      }
      if (current.mode === mode) return { ok: true };
      entries.set(sessionId, { mode, locked: current.locked, origin: 'set-config' });
      return { ok: true };
    },
    inherit: (childSessionId, parentSessionId) => {
      const parent = entries.get(parentSessionId);
      if (!parent) return;
      entries.set(childSessionId, {
        mode: parent.mode,
        locked: true,
        origin: 'inherited',
      });
    },
    lock: (sessionId) => {
      const current = entries.get(sessionId);
      if (current && !current.locked) {
        entries.set(sessionId, { ...current, locked: true });
      }
    },
    release: (sessionId) => {
      entries.delete(sessionId);
    },
  };
}
