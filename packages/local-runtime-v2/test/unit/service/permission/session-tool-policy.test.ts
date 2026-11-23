import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSessionToolPolicyFileStore,
  createSessionToolPolicyRegistry,
  type SessionToolPolicyStore,
} from '../../../../src/service/permission/session-tool-policy.js';

const tempRoots: string[] = [];

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'session-tool-policy-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

const names = (entry: { readonly allow: ReadonlySet<string> } | undefined) =>
  [...(entry?.allow ?? [])].sort();

describe('session tool policy registry', () => {
  it('absent entry is the legacy all-tools mode; an empty list means none', () => {
    const registry = createSessionToolPolicyRegistry({ store: memoryStore() });
    expect(registry.get('s1')).toBeUndefined();

    const empty = registry.bind('s1', [], 'new-explicit');
    expect(empty).toMatchObject({ ok: true });
    expect(names(empty.entry)).toEqual([]);
    expect(empty.entry?.origin).toBe('new-explicit');

    const entry = registry.bind('s2', ['read', 'bash'], 'new-explicit', ['niwa']);
    expect(entry).toMatchObject({ ok: true });
    expect(names(entry.entry)).toEqual(['bash', 'read']);
    expect([...entry.entry!.servers]).toEqual(['niwa']);
  });

  it('bind with undefined keeps the previous mode (a load that names no policy)', () => {
    const registry = createSessionToolPolicyRegistry({ store: memoryStore() });
    registry.bind('s1', ['read'], 'new-explicit');
    // Absent key: a complete no-op, entry and origin untouched.
    const kept = registry.bind('s1', undefined, 'load-explicit');
    expect(kept).toMatchObject({ ok: true, entry: { origin: 'new-explicit' } });
    expect(names(kept.entry)).toEqual(['read']);
    // Absent key on a legacy session stays legacy.
    expect(registry.bind('s2', undefined, 'load-explicit')).toMatchObject({ ok: true, entry: undefined });
  });

  it('a rebind never widens: the effective set is the intersection', () => {
    const registry = createSessionToolPolicyRegistry({ store: memoryStore() });
    registry.bind('s1', ['read', 'bash', 'grep'], 'new-explicit');

    const widened = registry.bind('s1', ['read', 'bash', 'write'], 'load-explicit');
    expect(names(widened.entry)).toEqual(['bash', 'read']);
    const narrowed = registry.bind('s1', ['read'], 'load-explicit');
    expect(names(narrowed.entry)).toEqual(['read']);
    // Narrowing to nothing stays a (restricted, empty) entry — never legacy.
    const emptied = registry.bind('s1', ['write'], 'load-explicit');
    expect(names(emptied.entry)).toEqual([]);
    expect(registry.get('s1')?.allow.size).toBe(0);
  });

  it('the server set narrows the same way and rides every bind', () => {
    const registry = createSessionToolPolicyRegistry({ store: memoryStore() });
    registry.bind('s1', ['read'], 'new-explicit', ['niwa', 'notes']);

    const same = registry.bind('s1', ['read'], 'load-explicit', ['niwa', 'notes', 'other']);
    expect([...same.entry!.servers].sort()).toEqual(['niwa', 'notes']);
    const narrowed = registry.bind('s1', undefined, 'load-explicit', ['niwa']);
    expect([...narrowed.entry!.servers]).toEqual(['niwa']);
    expect(names(narrowed.entry)).toEqual(['read']);
    const kept = registry.bind('s1', ['read'], 'load-explicit');
    expect([...kept.entry!.servers]).toEqual(['niwa']);
    // Servers without an allow list bind nothing on a legacy session.
    expect(registry.bind('s2', undefined, 'load-explicit', ['niwa'])).toMatchObject({
      ok: true,
      entry: undefined,
    });
  });

  it('two simultaneous sessions hold independent policies', () => {
    const registry = createSessionToolPolicyRegistry({ store: memoryStore() });
    registry.bind('a', ['read'], 'new-explicit');
    registry.bind('b', ['bash'], 'new-explicit', ['niwa']);
    expect(names(registry.get('a'))).toEqual(['read']);
    expect(names(registry.get('b'))).toEqual(['bash']);
    registry.release('a');
    expect(registry.get('a')).toBeUndefined();
    expect(names(registry.get('b'))).toEqual(['bash']);
  });

  it('children inherit the parent policy and never widen', () => {
    const registry = createSessionToolPolicyRegistry({ store: memoryStore() });
    registry.bind('parent', ['read'], 'new-explicit', ['niwa']);

    registry.inherit('child', 'parent');
    expect(names(registry.get('child'))).toEqual(['read']);
    expect([...registry.get('child')!.servers]).toEqual(['niwa']);
    expect(registry.get('child')?.origin).toBe('inherited');

    registry.bind('child', ['read', 'bash'], 'load-explicit', ['niwa', 'other']);
    registry.inherit('child', 'parent');
    expect(names(registry.get('child'))).toEqual(['read']);
    expect([...registry.get('child')!.servers]).toEqual(['niwa']);

    registry.bind('legacy-parent', undefined, 'new-explicit');
    registry.bind('grandchild', ['grep'], 'new-explicit');
    registry.inherit('grandchild', 'legacy-parent');
    expect(names(registry.get('grandchild'))).toEqual(['grep']);
  });

  it('a CHANGING bind is refused under a running Turn; the identical ceiling passes', () => {
    let active: string | undefined;
    const registry = createSessionToolPolicyRegistry({
      store: memoryStore(),
      isTurnActive: (sessionId) => sessionId === active,
    });
    registry.bind('s1', ['read', 'bash'], 'new-explicit');

    active = 's1';
    // Re-sending the session's own policy (a cold resume) passes.
    const same = registry.bind('s1', ['bash', 'read'], 'load-explicit', []);
    expect(same).toMatchObject({ ok: true });
    expect(names(same.entry)).toEqual(['bash', 'read']);
    // A narrowing under the running Turn is refused with the current ceiling.
    const refused = registry.bind('s1', ['read'], 'load-explicit');
    expect(refused).toEqual({
      ok: false,
      error: { code: 'turn_active', current: expect.anything() },
    });
    expect(names((refused as { ok: false; error: { current: { allow: ReadonlySet<string> } } }).error.current)).toEqual([
      'bash',
      'read',
    ]);
    // Between Turns the same narrowing lands.
    active = undefined;
    const landed = registry.bind('s1', ['read'], 'load-explicit');
    expect(names(landed.entry)).toEqual(['read']);
  });
});

describe('session tool policy durability (current→current)', () => {
  it('a second runtime cannot widen what another narrowed (store-authoritative reads)', () => {
    const dataDir = tempDataDir();
    const a = createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(dataDir) });
    const b = createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(dataDir) });

    a.bind('s1', ['read', 'bash'], 'new-explicit', ['niwa']);
    // B reads the ceiling (the stale-cache trap from the review)…
    expect(names(b.get('s1'))).toEqual(['bash', 'read']);
    // …A narrows…
    a.bind('s1', ['read'], 'load-explicit');
    // …and B's rebind of the WIDER list intersects with the STORE, not B's
    // last read: the ceiling holds, and a third runtime sees it.
    const rebinding = b.bind('s1', ['read', 'bash'], 'load-explicit', ['niwa']);
    expect(names(rebinding.entry)).toEqual(['read']);
    const c = createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(dataDir) });
    expect(names(c.get('s1'))).toEqual(['read']);
    expect([...c.get('s1')!.servers]).toEqual(['niwa']);
  });

  it('an omitted policy and a wider explicit list cannot widen after a restart', () => {
    const dataDir = tempDataDir();
    const first = createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(dataDir) });
    first.bind('s1', ['read', 'bash'], 'new-explicit', ['niwa']);
    first.release('unrelated');

    const second = createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(dataDir) });
    const restored = second.bind('s1', undefined, 'load-explicit');
    expect(names(restored.entry)).toEqual(['bash', 'read']);
    const widened = second.bind('s1', ['read', 'write', 'grep'], 'load-explicit');
    expect(names(widened.entry)).toEqual(['read']);
    // The empty ceiling survives a restart too — a restriction, not an absence.
    first.bind('s2', [], 'new-explicit');
    const third = createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(dataDir) });
    expect(third.get('s2')?.allow.size).toBe(0);
    expect(names(third.bind('s2', ['read'], 'load-explicit').entry)).toEqual([]);
    // A released session leaves no ceiling behind.
    first.release('s1');
    expect(
      createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(dataDir) }).get('s1'),
    ).toBeUndefined();
  });

  it('refuses a policy mutation while the sidecar is locked by another writer', () => {
    const dataDir = tempDataDir();
    const store = createSessionToolPolicyFileStore(dataDir);
    const registry = createSessionToolPolicyRegistry({ store });
    registry.bind('s1', ['read', 'write'], 'new-explicit');
    store.withLock!('s1', () => {
      expect(() => registry.bind('s1', ['read'], 'load-explicit')).toThrow('locked');
    });
    expect(names(registry.get('s1'))).toEqual(['read', 'write']);
  });

  it('an unreadable sidecar fails CLOSED: nothing is granted until an explicit re-statement', () => {
    const dataDir = tempDataDir();
    const store = createSessionToolPolicyFileStore(dataDir);
    store.write('s1', { allow: ['read'], servers: [], origin: 'new-explicit' });

    // A truncated sidecar (exists, cannot be parsed) is a broken restriction.
    const file = join(
      dataDir,
      'v2',
      'session-tool-policy',
      `${Buffer.from('s1', 'utf8').toString('base64url')}.json`,
    );
    writeFileSync(file, '{not json', 'utf8');
    const registry = createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(dataDir) });
    expect(registry.get('s1')).toMatchObject({ origin: 'corrupt' });
    expect(registry.get('s1')?.allow.size).toBe(0);
    // Even an omitted bind does not restore legacy.
    expect(names(registry.bind('s1', undefined, 'load-explicit').entry)).toEqual([]);
    // An explicit re-statement recovers a ceiling (trusted client input).
    const recovered = registry.bind('s1', ['read', 'bash'], 'load-explicit', []);
    expect(names(recovered.entry)).toEqual(['bash', 'read']);
    // A missing file is still the honest never-bound legacy case.
    expect(registry.get('never-bound')).toBeUndefined();
  });

  it('a failing write fails the bind loudly; the previous ceiling stands', () => {
    const broken: SessionToolPolicyStore = {
      read: () => ({ status: 'absent' }),
      write: () => {
        throw new Error('disk full');
      },
      remove: () => undefined,
    };
    const registry = createSessionToolPolicyRegistry({ store: broken });
    expect(() => registry.bind('s1', ['read'], 'new-explicit')).toThrow('disk full');
    expect(registry.get('s1')).toBeUndefined();
  });
});

/** An in-memory store: no durability, no lock — the unit-test substrate. */
function memoryStore(): SessionToolPolicyStore {
  const entries = new Map<string, { allow: readonly string[]; servers: readonly string[]; origin: 'new-explicit' | 'load-explicit' | 'inherited' | 'corrupt' }>();
  return {
    read: (sessionId) => {
      const entry = entries.get(sessionId);
      return entry === undefined ? { status: 'absent' } : { status: 'entry', entry };
    },
    write: (sessionId, entry) => {
      entries.set(sessionId, { ...entry });
    },
    remove: (sessionId) => {
      entries.delete(sessionId);
    },
  };
}
