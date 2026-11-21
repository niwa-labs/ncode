import { describe, expect, it } from 'vitest';

import {
  createSessionPermissionModeRegistry,
  type AcpPermissionMode,
} from '../../../../src/service/permission/session-permission-mode.js';

function registryWithActiveSessions(active: readonly string[]) {
  return createSessionPermissionModeRegistry({
    isTurnActive: (sessionId) => active.includes(sessionId),
  });
}

describe('session permission-mode registry (§2.1)', () => {
  it('lock-after-first-turn: bind lifts the lock, lock fixes the mode, set obeys it', () => {
    const registry = createSessionPermissionModeRegistry();
    expect(registry.bind('s1', 'default', 'new-explicit')).toEqual({ ok: true });
    expect(registry.get('s1')).toEqual({ mode: 'default', locked: false, origin: 'new-explicit' });

    // Before the first accepted Turn the option may change freely.
    expect(registry.set('s1', 'auto')).toEqual({ ok: true });
    expect(registry.get('s1')).toEqual({ mode: 'auto', locked: false, origin: 'set-config' });

    registry.lock('s1');
    expect(registry.get('s1')?.locked).toBe(true);
    // Same value stays ok (no-op)…
    expect(registry.set('s1', 'auto')).toEqual({ ok: true });
    // …another value is refused with the current one.
    expect(registry.set('s1', 'default')).toEqual({
      ok: false,
      error: { code: 'locked', currentValue: 'auto' },
    });

    // Re-binding (load/resume) lifts the lock again.
    expect(registry.bind('s1', 'bypassPermissions', 'load-explicit')).toEqual({ ok: true });
    expect(registry.get('s1')).toEqual({
      mode: 'bypassPermissions',
      locked: false,
      origin: 'load-explicit',
    });
    expect(registry.set('s1', 'auto')).toEqual({ ok: true });
  });

  it('lock is idempotent and a missing entry is a no-op', () => {
    const registry = createSessionPermissionModeRegistry();
    expect(() => registry.lock('missing')).not.toThrow();
    registry.bind('s1', 'auto', 'new-default');
    registry.lock('s1');
    registry.lock('s1');
    expect(registry.get('s1')).toEqual({ mode: 'auto', locked: true, origin: 'new-default' });
  });

  it('load-during-active-turn-conflict: a different mode under a running Turn is refused', () => {
    const registry = registryWithActiveSessions(['s1']);
    expect(registry.bind('s1', 'default', 'new-explicit')).toEqual({ ok: true });
    // Same mode under an active Turn is fine (idempotent re-attach).
    expect(registry.bind('s1', 'default', 'load-explicit')).toEqual({ ok: true });
    // A different mode would change the policy under the running Turn.
    expect(registry.bind('s1', 'bypassPermissions', 'load-explicit')).toEqual({
      ok: false,
      error: { code: 'turn_active', currentValue: 'default' },
    });
    // The refused bind changed nothing; the accepted same-mode rebind under
    // the running Turn kept the lock, so set cannot move the mode either.
    expect(registry.get('s1')).toEqual({ mode: 'default', locked: true, origin: 'load-explicit' });
    expect(registry.set('s1', 'bypassPermissions')).toEqual({
      ok: false,
      error: { code: 'locked', currentValue: 'default' },
    });
  });

  it('a bind with no Turn running lifts the lock; under a running Turn it never does', () => {
    const active = new Set<string>();
    const registry = createSessionPermissionModeRegistry({
      isTurnActive: (sessionId) => active.has(sessionId),
    });
    registry.bind('s1', 'auto', 'new-explicit');
    registry.lock('s1');
    active.add('s1');
    expect(registry.bind('s1', 'auto', 'load-default')).toEqual({ ok: true });
    expect(registry.get('s1')?.locked).toBe(true);
    active.delete('s1');
    expect(registry.bind('s1', 'auto', 'load-default')).toEqual({ ok: true });
    expect(registry.get('s1')?.locked).toBe(false);
    // A Session without an entry bound under a running Turn starts locked.
    active.add('s2');
    expect(registry.bind('s2', 'default', 'load-default')).toEqual({ ok: true });
    expect(registry.get('s2')?.locked).toBe(true);
  });

  it('child-and-side-sessions-inherit: children copy the parent mode, locked; no parent entry is a no-op', () => {
    const registry = createSessionPermissionModeRegistry();
    registry.bind('parent', 'bypassPermissions', 'new-explicit');
    registry.lock('parent');
    registry.inherit('task-child', 'parent');
    registry.inherit('background-child', 'parent');
    registry.inherit('side-fork', 'parent');
    for (const child of ['task-child', 'background-child', 'side-fork']) {
      expect(registry.get(child)).toEqual({
        mode: 'bypassPermissions',
        locked: true,
        origin: 'inherited',
      });
    }

    // A TUI parent without an entry produces no child entry: the child keeps
    // following the process mode exactly as before (§2.5).
    registry.inherit('tui-child', 'tui-parent');
    expect(registry.get('tui-child')).toBeUndefined();
  });

  it('two-sessions-different-modes keep independent entries', () => {
    const registry = createSessionPermissionModeRegistry();
    registry.bind('a', 'default', 'new-explicit');
    registry.bind('b', 'bypassPermissions', 'new-explicit');
    registry.lock('a');
    expect(registry.get('a')).toEqual({ mode: 'default', locked: true, origin: 'new-explicit' });
    expect(registry.get('b')).toEqual({
      mode: 'bypassPermissions',
      locked: false,
      origin: 'new-explicit',
    });
    // Locking one Session never locks another.
    expect(registry.set('b', 'auto')).toEqual({ ok: true });
    expect(registry.set('a', 'auto')).toEqual({
      ok: false,
      error: { code: 'locked', currentValue: 'default' },
    });
  });

  it('release drops the entry; set on an unknown Session binds the client intent', () => {
    const registry = createSessionPermissionModeRegistry();
    registry.bind('s1', 'auto' as AcpPermissionMode, 'new-default');
    registry.release('s1');
    expect(registry.get('s1')).toBeUndefined();
    // An explicit set_config_option must not silently fall back to the
    // process config (opus §2 review, risk 1): it records the intent and
    // locks it if a Turn is already running.
    expect(registry.set('s1', 'default')).toEqual({ ok: true });
    expect(registry.get('s1')).toEqual({
      mode: 'default',
      locked: false,
      origin: 'set-config',
    });
  });
});
