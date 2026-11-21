import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import { SqliteZstdBackend, loadSqlite3Constructor } from '@mavis/durable-backend-sqlite-zstd';

import type { CanonicalHistoryEnvelope } from '../../sessions/representation/canonical-history-contract.js';
import {
  applyFoldBase,
  applyFoldEntry,
  createEmptyFold,
  isHistoryEventKind,
  materializeFold,
  type SessionFold,
} from './history-event-log.js';

// Optional compatibility check for a prepared durable-history directory.
// When selected, the fixture must include legacy full-state records.
const historyDirectory = process.env['NCODE_TEST_HISTORY_DIR'];

const FULL_KIND = 'history.v1.full';
const APPEND_KIND = 'history.v1.append';
const SEED_COMMIT_KIND = 'history.v2.seed.commit';

interface SessionEntry {
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/** The legacy rebuild (pre-wave `rebuildFromLog`): last base + subsequent appends. */
function legacyRebuild(entries: readonly SessionEntry[]): CanonicalHistoryEnvelope[] | undefined {
  let base: CanonicalHistoryEnvelope[] | undefined;
  const appendChunks: CanonicalHistoryEnvelope[][] = [];
  for (const entry of entries) {
    if (entry.kind === FULL_KIND) {
      base = [...((entry.payload['envelopes'] as CanonicalHistoryEnvelope[]) ?? [])];
      appendChunks.length = 0;
      continue;
    }
    if (entry.kind === SEED_COMMIT_KIND) {
      // A verified seed publishes the chunk-stitched base; the chunks ride
      // their own entries which the legacy rebuild re-read through the
      // scanner. For this comparison the seed chunk payloads carry the same
      // envelopes — stitch them in commit order.
      base = [];
      appendChunks.length = 0;
      for (const candidate of entries) {
        if (candidate.kind !== 'history.v2.seed.chunk') continue;
        base.push(...((candidate.payload['envelopes'] as CanonicalHistoryEnvelope[]) ?? []));
      }
      continue;
    }
    if (entry.kind === APPEND_KIND) {
      if (!base) throw new Error('append before any base');
      appendChunks.push([...((entry.payload['envelopes'] as CanonicalHistoryEnvelope[]) ?? [])]);
      continue;
    }
  }
  if (base === undefined) return undefined;
  return [...base, ...appendChunks.flat()];
}

/** The wave-1 fold over the same entries (seq = the running count of session entries). */
function waveFold(entries: readonly SessionEntry[]): SessionFold | undefined {
  const fold = createEmptyFold();
  let sawBase = false;
  let seq = 0;
  for (const entry of entries) {
    seq += 1;
    if (isHistoryEventKind(entry.kind)) {
      applyFoldEntry(fold, entry, seq);
      sawBase ||= fold.segments.length > 0;
      continue;
    }
    // The bookkeeping seq advance happens for EVERY entry (applyFoldEntry);
    // a base then publishes through applyFoldBase at its own seq — the same
    // order loadSessionFold uses.
    applyFoldEntry(fold, entry, seq);
    if (entry.kind === FULL_KIND || entry.kind === SEED_COMMIT_KIND) {
      // Real bases were canonically decoded at write time; the fold takes
      // them as-is (the envelope shape validation happened at write).
      applyFoldBase(
        fold,
        (entry.payload['envelopes'] as CanonicalHistoryEnvelope[]) ??
          (entry.kind === SEED_COMMIT_KIND
            ? entries
                .filter((candidate) => candidate.kind === 'history.v2.seed.chunk')
                .flatMap((candidate) => (candidate.payload['envelopes'] as CanonicalHistoryEnvelope[]) ?? [])
            : []),
        seq,
      );
    }
    sawBase ||= fold.segments.length > 0;
  }
  return sawBase || fold.deleted ? fold : undefined;
}

function sessionIdOf(payload: Record<string, unknown>): string {
  return typeof payload['sessionId'] === 'string' ? payload['sessionId'] : '';
}

describe('durable history fold compatibility', () => {
  it.skipIf(!historyDirectory)('matches the legacy rebuild for the supplied history', { timeout: 600_000 }, async () => {
    const database = join(historyDirectory!, 'sessions.g1.db');
    const workdir = await mkdtemp(join(tmpdir(), 'wave1-real-base-'));
    try {
      // The live base is never touched. A CONSISTENT snapshot comes from
      // sqlite's own backup API over a READ-ONLY connection to the live
      // database (the wal included) — a raw file copy of a live base is not
      // atomic and tears. The snapshot still carries the LIVE writer's
      // ownership markers; they are reset in the COPY only (the backend
      // takes fresh ownership of an unowned db).
      const durableDir = join(workdir, 'durable-history');
      mkdirSync(durableDir, { recursive: true });
      const Sqlite = loadSqlite3Constructor();
      const source = new Sqlite(database, { readonly: true });
      try {
        await source.backup(join(durableDir, 'sessions.g1.db'));
      } finally {
        source.close();
      }
      const copiedDatabase = join(durableDir, 'sessions.g1.db');
      const strip = new Sqlite(copiedDatabase);
      try {
        strip.prepare("UPDATE meta SET value = '0' WHERE key = 'owner_epoch'").run();
        strip.prepare("DELETE FROM meta WHERE key IN ('owner_pid', 'owner_instance')").run();
      } finally {
        strip.close();
      }
      const backend = SqliteZstdBackend.open(durableDir);
      try {
        const perSession = new Map<string, SessionEntry[]>();
        let cursor = 0;
        for (;;) {
          const window = backend.readDeltaChecked(cursor, 8 * 1024 * 1024);
          for (const stored of window.entries) {
            if (stored.kind.startsWith('pi.')) continue;
            const payload = stored.payload as Record<string, unknown>;
            const sessionId = sessionIdOf(payload);
            if (!sessionId) continue;
            let list = perSession.get(sessionId);
            if (!list) {
              list = [];
              perSession.set(sessionId, list);
            }
            list.push({ id: stored.id, kind: stored.kind, payload });
          }
          if (window.tornTail !== null) {
            // The copy of a LIVE base is not an atomic snapshot: the last
            // (not yet checkpointed) batch can be torn in the copy. The
            // intact prefix is a consistent view of the past — the fold and
            // the legacy rebuild compare over exactly the same entries.
            break;
          }
          if (window.nextAfterSeq === null) break;
          cursor = window.nextAfterSeq;
        }
        expect(perSession.size).toBeGreaterThan(0);
        let compared = 0;
        let withFullStates = 0;
        for (const [sessionId, entries] of perSession) {
          const legacy = legacyRebuild(entries);
          const folded = waveFold(entries);
          if (legacy === undefined) {
            // An interrupted seed import (protocol entries only): the fold
            // reports no base either.
            expect(folded ?? undefined).toBeUndefined();
            continue;
          }
          expect(folded).toBeDefined();
          const envelopes = materializeFold(folded!);
          // Avoid printing the supplied history in an assertion diff.
          expect(isDeepStrictEqual(envelopes, legacy)).toBe(true);
          compared += 1;
          if (entries.some((entry) => entry.kind === FULL_KIND)) withFullStates += 1;
        }
        // The acceptance ran against real data: at least one session, and
        // the bases are known to carry pre-wave full states (compactions,
        // repairs) among them.
        expect(compared).toBeGreaterThan(0);
        expect(withFullStates).toBeGreaterThan(0);
      } finally {
        backend.close();
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
