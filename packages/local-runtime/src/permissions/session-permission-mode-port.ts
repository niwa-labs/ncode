/**
 * Structural port for the V2-owned per-session permission-mode registry
 * (spec §2.1; implementation lives in `local-runtime-v2/src/service/permission/`).
 * V1 cannot deep-import that module (package exports map the root only), so
 * the host carries the registry as this structurally-typed late-bound port —
 * the same pattern as `nativeTaskWaits`. TypeScript's structural typing makes
 * the V2 registry assignable without a cross-package import.
 */

export type LocalSessionPermissionMode = 'default' | 'auto' | 'bypassPermissions';

export interface LocalSessionPermissionModeEntry {
  mode: LocalSessionPermissionMode;
  locked: boolean;
  origin:
    | 'new-explicit'
    | 'new-default'
    | 'load-explicit'
    | 'load-default'
    | 'set-config'
    | 'inherited';
}

export interface LocalSessionPermissionModeRegistry {
  get(sessionId: string): LocalSessionPermissionModeEntry | undefined;
  bind(
    sessionId: string,
    mode: LocalSessionPermissionMode,
    origin: LocalSessionPermissionModeEntry['origin'],
  ): { ok: true } | { ok: false; error: { code: 'locked' | 'turn_active'; currentValue: LocalSessionPermissionMode } };
  set(
    sessionId: string,
    mode: LocalSessionPermissionMode,
  ): { ok: true } | { ok: false; error: { code: 'locked' | 'turn_active'; currentValue: LocalSessionPermissionMode } };
  inherit(childSessionId: string, parentSessionId: string): void;
  lock(sessionId: string): void;
  release(sessionId: string): void;
}
