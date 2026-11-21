/**
 * The per-session durable stores (owner decision 2026-11-18, "variant 1"):
 * one log file per session, per-session ownership, a routing worker, and the
 * legacy monolith demoted to a read-only source. These tests pin the
 * CROSS-PROCESS semantics the single-log era could not provide:
 *
 * - two runtimes on one dataDir coexist — each owns its own sessions;
 * - ONE session is still exclusive: the second claimant of the same session
 *   fails fast with the typed {@link DurableSessionLogOwnedError}, and the
 *   owner keeps writing;
 * - entries route by the `<sessionId>|` id prefix; control entries refuse on
 *   a runtime without a system log (fail-closed, no silent misrouting);
 * - the runtime that owns the system log (the daemon) takes it exclusively.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { currentGeneration, SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';

import {
  createDurableHistoryStores,
  DurableHistoryLogOwnedError,
  DurableSessionLogOwnedError,
  type DurableHistoryStores,
} from './durable-session-stores.js';

function historyEntryId(sessionId: string, tag: string): string {
  return `${sessionId}|test-append|${tag}`;
}

/** History entries of one backend — the open-time `pi.*` bookkeeping excluded, optionally scoped to one session. */
function historyEntries(
  backend: ReturnType<typeof SqliteZstdBackend.open>,
  sessionId?: string,
): { id: string; kind: string }[] {
  return backend
    .readDelta(0, 1024 * 1024)
    .filter((entry) => !entry.kind.startsWith('pi.'))
    .filter((entry) => sessionId === undefined || (entry.payload as { sessionId?: string }).sessionId === sessionId)
    .map((entry) => ({ id: entry.id, kind: entry.kind }));
}

describe('durable session stores (per-session history)', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'durable-session-stores-'));
    roots.push(root);
    return root;
  }

  it('two stores on one dataDir write two different sessions without contention', async () => {
    const root = tempRoot();
    const first: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: false,
    });
    const second: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: false,
    });
    try {
      // Each runtime claims its OWN session (the claim = the lazy open).
      const alpha = await first.sessionStores('session-alpha');
      const beta = await second.sessionStores('session-beta');
      expect(alpha.directory).not.toBe(beta.directory);

      // Both write concurrently-shaped appends through their own workers.
      await alpha.worker.enqueue({
        entryId: historyEntryId('session-alpha', 'a1'),
        parentId: null,
        kind: 'test.append',
        payload: { sessionId: 'session-alpha', note: 'from first' },
        bytes: 64,
      });
      await beta.worker.enqueue({
        entryId: historyEntryId('session-beta', 'b1'),
        parentId: null,
        kind: 'test.append',
        payload: { sessionId: 'session-beta', note: 'from second' },
        bytes: 64,
      });
      await alpha.worker.flush();
      await beta.worker.flush();

      // Each file holds exactly its own session's entry.
      expect(historyEntries(alpha.backend)).toHaveLength(1);
      expect(historyEntries(beta.backend)).toHaveLength(1);
      // The legacy monolith was never created (no system owner, no system
      // writes): the sessions root is the only thing on disk.
      expect(currentGeneration(join(root, 'durable-history'))).toBe(0);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('one session stays exclusive: the second claimant fails fast while the owner keeps writing', async () => {
    const root = tempRoot();
    const owner: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: false,
    });
    try {
      await owner.sessionStores('session-contested');
      // A "second process" (a second stores instance, same in-process
      // semantics the backend enforces cross-process by pid+instance) claims
      // the SAME session: refused, typed, no steal.
      const second: DurableHistoryStores = await createDurableHistoryStores({
        dataDir: root,
        ownsSystemRoot: false,
        ownerWaitTimeoutMs: 250,
      });
      try {
        const refusal = await second.sessionStores('session-contested').then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(refusal).toBeInstanceOf(DurableSessionLogOwnedError);
        expect(refusal).toBeInstanceOf(Error);
        if (refusal instanceof DurableSessionLogOwnedError) {
          expect(refusal.sessionId).toBe('session-contested');
          expect(refusal.message).toMatch(/pid \d+/);
          expect(refusal.message).toMatch(/a second process cannot write THIS session/);
        }
        // The owner keeps possession and keeps writing.
        const alpha = await owner.sessionStores('session-contested');
        await alpha.worker.enqueue({
          entryId: historyEntryId('session-contested', 'after-refusal'),
          parentId: null,
          kind: 'test.append',
          payload: { sessionId: 'session-contested' },
          bytes: 32,
        });
        await alpha.worker.flush();
        expect(alpha.backend.head).toBeGreaterThan(0);
        // A DIFFERENT session of the second runtime is unaffected by the
        // refusal — per-session isolation is the whole point.
        await expect(second.sessionStores('session-other')).resolves.toBeDefined();
      } finally {
        await second.dispose();
      }
    } finally {
      await owner.dispose();
    }
  });

  it('routes by the entry-id prefix; a control entry without a system log refuses (fail-closed)', async () => {
    const root = tempRoot();
    const stores: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: false,
    });
    try {
      // A session-keyed entry lands in the session's file…
      await stores.worker.enqueue({
        entryId: historyEntryId('session-route', 'r1'),
        parentId: null,
        kind: 'test.append',
        payload: { sessionId: 'session-route' },
        bytes: 32,
      });
      await stores.worker.flush();
      const session = await stores.sessionStores('session-route');
      expect(historyEntries(session.backend)).toHaveLength(1);
      // …while a control entry (no session key) refuses loudly instead of
      // silently landing somewhere else.
      await expect(
        stores.worker.enqueue({
          entryId: 'cache-warm-usage-some-uuid',
          parentId: null,
          kind: 'mcode.usage',
          payload: {},
          bytes: 16,
        }),
      ).rejects.toThrow(/owns no system log/);
    } finally {
      await stores.dispose();
    }
  });

  it('the system-log owner (the daemon) takes the monolith exclusively; plain stores never create it', async () => {
    const root = tempRoot();
    const daemon: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: true,
    });
    try {
      expect(daemon.system).toBeDefined();
      // The pi root marker rode the system log at open.
      expect(daemon.system.backend.head).toBeGreaterThan(0);
      // The control entry rides the system log for the owner.
      await daemon.worker.enqueue({
        entryId: 'cache-warm-usage-owner-uuid',
        parentId: null,
        kind: 'mcode.usage',
        payload: {},
        bytes: 16,
      });
      await daemon.worker.flush();

      // A second daemon on the same dataDir: refused AT OPEN, typed — the
      // system log is part of the composition, so there is no owner-less
      // object to enqueue through.
      const refusal = await createDurableHistoryStores({
        dataDir: root,
        ownsSystemRoot: true,
        ownerWaitTimeoutMs: 250,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(refusal).toBeInstanceOf(DurableHistoryLogOwnedError);
      if (refusal instanceof DurableHistoryLogOwnedError) {
        expect(refusal.directory).toBe(join(root, 'durable-history'));
        expect(refusal.message).toMatch(/a second daemon cannot start/);
      }
    } finally {
      await daemon.dispose();
    }
  });

  it('reads fall back to the legacy monolith until the session has its own file', async () => {
    const root = tempRoot();
    // A pre-2026-11-18 dataDir: the monolith holds the session's history.
    const durableDir = join(root, 'durable-history');
    mkdirSync(durableDir, { recursive: true });
    const monolith = SqliteZstdBackend.open(durableDir);
    const commit = await monolith.appendBatch([
      {
        // The backend dictionary: `id` (the worker's `entryId`).
        id: historyEntryId('session-legacy', 'old1'),
        parentId: null,
        kind: 'test.append',
        payload: { sessionId: 'session-legacy', note: 'legacy data' },
      },
    ]);
    expect(commit.head).toBe(1);
    monolith.close();

    const stores: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: false,
    });
    try {
      // No session file yet: reads see the legacy data through the read-only
      // monolith, and the session is NOT claimed by a read.
      const backend = await stores.backendForRead('session-legacy');
      expect(backend).toBeDefined();
      expect(historyEntries(backend)).toHaveLength(1);
      expect(stores.hasSessionFile('session-legacy')).toBe(false);

      // A fresh session with no file of its own: the read backend is the
      // legacy monolith (it exists on this dataDir), and the session has no
      // entries in it — the provider's negative probe yields an empty fold.
      const freshBackend = await stores.backendForRead('session-fresh');
      expect(freshBackend).toBeDefined();
      expect(historyEntries(freshBackend, 'session-fresh')).toHaveLength(0);

      // After the session claims its own file, reads switch to it.
      await stores.sessionStores('session-legacy');
      expect(stores.hasSessionFile('session-legacy')).toBe(true);
      const ownBackend = await stores.backendForRead('session-legacy');
      expect(ownBackend.directory).toContain(join('durable-history', 'sessions'));
    } finally {
      await stores.dispose();
    }
  });

  it('piOf fails closed for a session that was never opened (composition-order bug surface)', async () => {
    const root = tempRoot();
    const stores: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: false,
    });
    try {
      expect(() => stores.piOf('session-unopened')).toThrow(/not open/);
      const stores0 = await stores.sessionStores('session-opened');
      expect(stores.piOf('session-opened')).toBe(stores0.pi);
    } finally {
      await stores.dispose();
    }
  });

  it.each([true, false])('releases the writer after a sidecar fails to open (system=%s)', async (systemLog) => {
    const dataDir = tempRoot();
    const root = join(dataDir, 'durable-history');
    const directory = systemLog ? root : join(root, 'sessions', 'retry');
    mkdirSync(directory, { recursive: true });
    const sidecar = join(directory, 'root-resolver.json');
    writeFileSync(sidecar, 'broken sidecar');
    const open = async () => {
      const stores = await createDurableHistoryStores({ dataDir, ownsSystemRoot: systemLog, ownerWaitTimeoutMs: 0 });
      try {
        if (!systemLog) await stores.sessionStores('retry');
      } finally {
        await stores.dispose();
      }
    };
    await expect(open()).rejects.toMatchObject({ code: 'SIDECAR_INVALID' });
    rmSync(sidecar);
    await expect(open()).resolves.toBeUndefined();
  });

  it('dispose closes every open session worker and backend and is idempotent', async () => {
    const root = tempRoot();
    const stores: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: false,
    });
    await stores.sessionStores('session-dispose-a');
    await stores.sessionStores('session-dispose-b');
    await stores.dispose();
    await expect(stores.dispose()).resolves.toBeUndefined();
    // The ownership released: a fresh stores instance can claim the same
    // sessions immediately (no stale epoch on disk).
    const fresh: DurableHistoryStores = await createDurableHistoryStores({
      dataDir: root,
      ownsSystemRoot: false,
    });
    try {
      await expect(fresh.sessionStores('session-dispose-a')).resolves.toBeDefined();
    } finally {
      await fresh.dispose();
    }
  });
});
