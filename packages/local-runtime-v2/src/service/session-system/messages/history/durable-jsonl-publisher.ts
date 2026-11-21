import { createHash } from 'node:crypto';
import { open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@mavis/logging';

import { replaceFileAtomically } from '../../../../infra/file/jsonl.js';
import type { SessionRepository } from '../../sessions/repo/contract.js';
import {
  canonicalActiveHistoryRevision,
  type CanonicalHistoryEnvelope,
  type CanonicalHistoryFileAdapter,
} from '../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../sessions/representation/canonical-history.js';
import { repairCanonicalHistory } from './canonical-history-recovery.js';
import type { SessionHistoryIoLane } from './mutation/session-history-coordination.js';
import type { SessionHistoryLocationResolver } from './session-history-location.js';
import type { SessionHistoryPaths } from './session-history-paths.js';

/**
 * DurableJsonlPublisher (integration plan W1, architecture §3.2).
 *
 * The publisher is the SECONDARY sink of durable history mutations: it
 * reproduces the durable state of every session on the same
 * `CanonicalHistoryFileAdapter` the JSONL provider writes, so the published
 * `messages.jsonl` is byte-for-byte what `MCODE_HISTORY_PROVIDER=jsonl`
 * produces and the old app keeps reading it. The writer of a session's JSONL
 * stays single: the process that owns the durable log (I-SW); the publisher
 * shares the provider's per-session `SessionHistoryIoLane`, so its file I/O
 * never interleaves with the provider's or the mutation adapter's.
 *
 * Trigger (W0 F6): the durable provider calls {@link DurableJsonlPublisher.notify}
 * strictly after its per-mutation durability flush (`flushDurability` →
 * `worker.flush()`), so a published line can never precede its durable
 * commit. Publications coalesce per session: the first publish lands within
 * {@link DEFAULT_DEBOUNCE_MS} of the commit and the lag never exceeds
 * {@link DEFAULT_MAX_LAG_MS} during a long turn — one fsync per coalesced
 * batch, not per frame. A publication failure never fails a turn: the
 * session is marked publish-stale and the next trigger retries (durable is
 * the source of truth).
 *
 * Forced flushes:
 * - {@link DurableJsonlPublisher.flushBeforeMutation} — invariant I-PUB-1: a
 *   file-backed mutation (settle/retract/fork/rewind) must never plan on a
 *   file that lags the durable log. Throws on failure (fail-closed); the
 *   hotfix's coarse `publishDurableStateToFiles` stays as the backstop for
 *   compositions without a publisher.
 * - {@link DurableJsonlPublisher.flushBeforeRelease} — invariant I-PUB-1b:
 *   the turn-end flush completes before the turn lease is released (the
 *   insertion point is `settleAndRelease`, between the last durable write of
 *   the turn and the repository settlement — W0 F8). Never throws: the lease
 *   is released either way and a failed flush marks the session stale.
 *
 * Watermark (§3.2): the sidecar `<sessionDir>/.mcode-publish.json` records
 * the published durable revision and the published file identity
 * (size/ino/mtime + SHA-256 of the last 4 KiB). It is written atomically and
 * NEVER touches AppDb (invariant I-PUB-2). A missing or corrupt sidecar is
 * recoverable: the reconcile compares the file's records with the durable
 * envelopes by content-addressed `message_id` and continues idempotently.
 *
 * Foreign-tail import (§3.4): the reconcile stats the file against the
 * watermark. A file that grew past the watermark on the same inode with the
 * published tail intact is a foreign append (the app wrote the session while
 * it held the turn lease): the new records are imported INTO the durable log
 * through the ordinary append entry path (`external-jsonl` origin). A growth
 * whose leading records are already durable is NOT foreign — it is our own
 * tail from a crash between the file append and the sidecar write; that run
 * is skipped idempotently and the watermark catches up (review round 2). A
 * foreign append that duplicates a durable id outside that continuation, and
 * a file too corrupt to parse or repair (a duplicated message identity), are
 * §3.4 row 3 conflicts: durable stays the source, the raw bytes are
 * preserved as evidence, the banner-class warning is emitted, and the file is
 * rewritten from durable — never a permanent fail-closed deadlock (review
 * round 3). A rewritten file with no unpublished durable tail is a foreign
 * rewrite
 * (app-side rewind/compact): it is adopted into durable. A rewritten file
 * while WE hold an unpublished durable tail is a conflict: durable stays the
 * source, the foreign file is preserved as `messages.external-<ts>.jsonl`
 * and a banner-class warning is logged.
 *
 * @module
 */

const log = createLogger('mcode:history-publish');

/** First coalesced publish lands within this delay of the durable commit (§3.2: ≤ 1 s). */
const DEFAULT_DEBOUNCE_MS = 250;
/** Maximum publication lag behind a continuous stream of commits (§3.2: ≤ 2 s). */
const DEFAULT_MAX_LAG_MS = 2_000;

const WATERMARK_FILENAME = '.mcode-publish.json';
const WATERMARK_SCHEMA = 1;
/** Size of the hashed file tail recorded in the watermark. */
const WATERMARK_TAIL_BYTES = 4096;

/** Env knob for the durable→jsonl replication of this publisher: `on` | `off`. */
const PUBLISH_JSONL_ENV = 'MCODE_PUBLISH_JSONL';

/**
 * Resolves whether the durable composition replicates durable history into
 * the session's `messages.jsonl` through this publisher. DEFAULT OFF: the
 * durable log alone is the source of truth and every history read (including
 * session/history) serves from it — a durable session needs no jsonl. Set
 * `MCODE_PUBLISH_JSONL=on` only for compatibility with legacy jsonl readers
 * (the old app tailing `messages.jsonl`, external tooling): the publisher
 * then keeps the file byte-identical to what `MCODE_HISTORY_PROVIDER=jsonl`
 * produces. An invalid value fails CLOSED to off with a warning (the
 * `MCODE_CACHE_WARMING` knob convention) — never a half-published session
 * directory. Existing `messages.jsonl`/watermark files are never touched by
 * the off state; a session started at `on` and continued at `off` simply
 * stops receiving new publications.
 */
export function resolveDurableJsonlPublishingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[PUBLISH_JSONL_ENV]?.trim().toLowerCase();
  if (!raw || raw === 'off') return false;
  if (raw === 'on') return true;
  log.warn('durable jsonl publication env invalid; failing closed to off', {
    env: PUBLISH_JSONL_ENV,
    value: raw,
    supported: "'on', 'off' (default)",
  });
  return false;
}

/**
 * Publication watermark of one session (architecture §3.2 sidecar schema;
 * `publishedCount` extends it so the incremental-append decision is an exact
 * prefix check instead of an id search). Sidecar only — invariant I-PUB-2
 * keeps this state out of AppDb.
 */
interface PublishWatermark {
  readonly schema: typeof WATERMARK_SCHEMA;
  /** Durable active revision the file was published at. */
  readonly durableRevision: string;
  /** message_id of the last published envelope; `null` for an empty history. */
  readonly lastMessageId: string | null;
  /** Number of durable envelopes the file carried at publication. */
  readonly publishedCount: number;
  readonly fileSize: number;
  readonly fileIno: number;
  readonly fileMtimeMs: number;
  /** SHA-256 of the last {@link WATERMARK_TAIL_BYTES} bytes before `fileSize`. */
  readonly tailSha256: string;
}

/** Committed durable state of one session, read for publication. */
export interface PublishedDurableState {
  readonly envelopes: readonly CanonicalHistoryEnvelope[];
  /** Cached active revision of `envelopes` (the durable provider's own). */
  readonly revision: string;
}

/**
 * The durable side of the publisher, implemented by the durable
 * canonical-history provider closure. Every method is called with the
 * session history I/O lane already held (by the publisher) — implementations
 * must not re-enter the lane.
 */
export interface DurableJsonlPublisherDurableSource {
  /**
   * Committed durable envelopes of the session. `mode: 'ensure'` loads the
   * state first (a cold process must publish from the log, not skip);
   * `mode: 'cached'` returns `undefined` when the session was never opened.
   */
  readCommitted(
    sessionId: string,
    mode: 'cached' | 'ensure',
  ): Promise<PublishedDurableState | undefined>;
  /**
   * Imports a foreign jsonl append into the durable log (§3.4 row 2) through
   * the ordinary append entry path, marked `external-jsonl`, then flushes
   * durability.
   */
  importForeignAppends(
    sessionId: string,
    envelopes: readonly CanonicalHistoryEnvelope[],
  ): Promise<void>;
  /** Adopts published file content as the durable full state (§3.4 row 3, foreign rewrite without an unpublished local tail). */
  adoptPublishedState(
    sessionId: string,
    records: readonly CanonicalHistoryEnvelope[],
  ): Promise<void>;
}

/**
 * §3.4 row 3 conflict: a foreign jsonl rewrite landed while this runtime held
 * an UNPUBLISHED durable tail. Durable stays the source; the foreign file is
 * preserved as evidence. Besides the log line, the conflict must not stay
 * silent on the product surface: the composition turns this callback into a
 * `session.publish_conflict` global event (the window renders it as a
 * banner-class warning) — review round 1, §3.4.
 */
export interface SessionPublishConflictInput {
  readonly sessionId: string;
  /** Read-only evidence copy of the conflicting foreign file, when preserved. */
  readonly preservedTo: string | undefined;
  readonly durableEntries: number;
  readonly publishedEntries: number;
}

export interface DurableJsonlPublisherOptions {
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly locations: SessionHistoryLocationResolver;
  /** The same per-session history I/O lane the durable provider and the mutation adapter use. */
  readonly ioLane: SessionHistoryIoLane;
  readonly durable: DurableJsonlPublisherDurableSource;
  /**
   * §3.4 conflict observer (review round 1). Best-effort: a throwing listener
   * is logged and ignored — the reconcile must not turn stale because a
   * product surface failed to render the warning.
   */
  readonly onSessionPublishConflict?: (input: SessionPublishConflictInput) => void;
  /** Coalescing delay after the first unpublished commit; default {@link DEFAULT_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** Hard publication lag cap; default {@link DEFAULT_MAX_LAG_MS}. */
  readonly maxLagMs?: number;
  readonly nowMs?: () => number;
}

/**
 * Composition seam: the durable provider builds the durable-source closure
 * (its per-session state is private) and hands it to this factory, which
 * completes the publisher over the runtime's shared locations/lane. The
 * product composition passes `createDurableJsonlPublisher` with its options
 * bound.
 */
export type DurableJsonlPublisherFactory = (
  source: DurableJsonlPublisherDurableSource,
) => DurableJsonlPublisher;

export interface DurableJsonlPublisher {
  /**
   * Publication trigger. The durable provider calls it strictly after the
   * session's durability flush resolved (W0 F6). Fire-and-forget: schedules
   * a coalesced publication on the session history I/O lane and never throws.
   */
  notify(sessionId: string): void;
  /**
   * I-PUB-1: catch-up flush before a file-backed mutation plans on
   * `messages.jsonl`. Resolves only when the file reflects the durable
   * state; throws so the mutation caller stays fail-closed.
   */
  flushBeforeMutation(sessionId: string): Promise<void>;
  /**
   * I-PUB-1b: turn-end flush; resolves after the publication completed (or
   * failed and marked the session stale). Never throws — the turn lease is
   * released either way; durable stays the source of truth.
   */
  flushBeforeRelease(sessionId: string): Promise<void>;
  /**
   * §3.3/§3.4(a) cold-open reconcile: catches a durable session's stale jsonl
   * up and imports a foreign tail before the loaded state is served. The
   * caller holds the session history I/O lane (the provider's `ensureState`).
   * Never throws.
   */
  importForeignTail(sessionId: string, paths?: SessionHistoryPaths): Promise<void>;
  /** True when the last publication attempt of the session failed (visible in status surfaces). */
  isStale(sessionId: string): boolean;
  /**
   * §3.2: the publish-stale sessions of this runtime, for status surfaces
   * (`mcode daemon status` reads the runtime diagnostics seam). Empty when
   * every publication attempt is current.
   */
  publishStaleSessions(): readonly string[];
  /** Drops all per-session publisher state (session deleted). */
  forget(sessionId: string): void;
  /** Flushes every dirty session, then stops scheduling. Idempotent. */
  dispose(): Promise<void>;
}

interface PublisherSessionState {
  dirty: boolean;
  pendingSinceMs: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  inFlight: Promise<void> | undefined;
  stale: boolean;
}

/** Creates the W1 durable→jsonl publisher over the runtime's durable source. */
export function createDurableJsonlPublisher(
  options: DurableJsonlPublisherOptions,
): DurableJsonlPublisher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
  const nowMs = options.nowMs ?? Date.now;
  const files: CanonicalHistoryFileAdapter = createCanonicalHistoryFileAdapter();
  /** Scheduled/publication state per session; live only while the runtime is. */
  const states = new Map<string, PublisherSessionState>();

  return {
    notify,
    flushBeforeMutation,
    flushBeforeRelease,
    importForeignTail,
    isStale: (sessionId) => states.get(sessionId)?.stale ?? false,
    publishStaleSessions: () =>
      [...states.entries()].filter(([, state]) => state.stale).map(([sessionId]) => sessionId),
    forget,
    dispose,
  };

  // -- scheduling --------------------------------------------------------------

  function notify(sessionId: string): void {
    const state = stateFor(sessionId);
    state.dirty = true;
    if (state.inFlight) return; // the running loop re-checks `dirty`
    schedule(sessionId, state);
  }

  function schedule(sessionId: string, state: PublisherSessionState): void {
    if (state.timer) return;
    const now = nowMs();
    state.pendingSinceMs ??= now;
    const elapsed = now - state.pendingSinceMs;
    const delay = Math.max(0, Math.min(debounceMs, maxLagMs - elapsed));
    const timer = setTimeout(() => {
      state.timer = undefined;
      runScheduled(sessionId, state);
    }, delay);
    timer.unref?.();
    state.timer = timer;
  }

  function runScheduled(sessionId: string, state: PublisherSessionState): void {
    if (state.inFlight) return;
    const running = options.ioLane
      .run(sessionId, () => runPublishLoop(sessionId, state))
      .finally(() => {
        if (state.inFlight === running) state.inFlight = undefined;
        if (state.dirty) notify(sessionId);
      });
    state.inFlight = running;
  }

  async function runPublishLoop(sessionId: string, state: PublisherSessionState): Promise<void> {
    do {
      state.dirty = false;
      state.pendingSinceMs = undefined;
      try {
        await reconcile(sessionId);
        state.stale = false;
      } catch (error) {
        state.stale = true;
        log.warn('durable jsonl publication failed; session marked publish-stale', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } while (state.dirty);
  }

  async function flushBeforeMutation(sessionId: string): Promise<void> {
    await cancelAndAwait(sessionId);
    // I-PUB-1: propagate failures — the file mutation must not plan on an
    // unverifiable baseline (fail-closed, hotfix semantics).
    await options.ioLane.run(sessionId, () => reconcile(sessionId));
  }

  async function flushBeforeRelease(sessionId: string): Promise<void> {
    try {
      await cancelAndAwait(sessionId);
      await options.ioLane.run(sessionId, () => reconcile(sessionId));
    } catch (error) {
      const state = stateFor(sessionId);
      state.stale = true;
      // I-PUB-1b: settlement (and the lease release) must never block on the
      // publication; durable is the source of truth and the next trigger
      // catches the file up.
      log.warn('turn-end jsonl flush failed; session marked publish-stale', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function importForeignTail(
    sessionId: string,
    paths?: SessionHistoryPaths,
  ): Promise<void> {
    try {
      await reconcile(sessionId, paths);
    } catch (error) {
      const state = stateFor(sessionId);
      state.stale = true;
      // The cold-open import must not fail the turn that triggered the load;
      // the durable log stays the source of truth and the next trigger retries.
      log.warn('cold-open jsonl reconcile failed; session marked publish-stale', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function forget(sessionId: string): void {
    const state = states.get(sessionId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    states.delete(sessionId);
  }

  async function dispose(): Promise<void> {
    for (const [sessionId, state] of [...states.entries()]) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (!state.dirty && !state.inFlight) continue;
      try {
        if (state.inFlight) await state.inFlight;
        await options.ioLane.run(sessionId, () => reconcile(sessionId));
      } catch (error) {
        log.warn('durable jsonl publication failed during dispose', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    states.clear();
  }

  async function cancelAndAwait(sessionId: string): Promise<void> {
    const state = states.get(sessionId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.inFlight) {
      await state.inFlight;
      // The finished loop may have re-scheduled for a dirty flag; this flush
      // covers it, so the timer must not fire mid-flush.
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }
  }

  function stateFor(sessionId: string): PublisherSessionState {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        dirty: false,
        pendingSinceMs: undefined,
        timer: undefined,
        inFlight: undefined,
        stale: false,
      };
      states.set(sessionId, state);
    }
    return state;
  }

  // -- publication (caller holds the session history I/O lane) -------------------

  /**
   * Reconciles the session's `messages.jsonl` with the committed durable
   * state (§3.2–§3.4). Fast path: a watermark-matching up-to-date file needs
   * one stat. Decision order:
   * 1. file untouched since the watermark → incremental append (or done);
   * 2. foreign append past the watermark on the same inode → import into durable;
   * 3. file is a verified prefix of moved-forward durable → append the tail;
   * 4. file extends durable → import the unwatermarked foreign tail;
   * 5. divergence: adopt (foreign rewrite, nothing unpublished) / snapshot +
   *    rewrite (local full-state mutation behind an untouched file) /
   *    external-preserve + rewrite (conflict or §3.3 catch-up).
   */
  async function reconcile(sessionId: string, pathsHint?: SessionHistoryPaths): Promise<void> {
    const durable = await options.durable.readCommitted(sessionId, 'ensure');
    if (!durable) return;
    const session = await options.sessions.get(sessionId);
    if (!session) return;
    const paths = pathsHint ?? (await options.locations.ensure(session));

    const current = await statOrUndefined(paths.messages);
    const watermark = await readWatermark(paths.sessionDir);
    const durableMoved = !watermark || watermark.durableRevision !== durable.revision;

    // 1. Fast path: the file is exactly what we published last time.
    if (watermark && current && (await watermarkMatches(paths.messages, current, watermark))) {
      if (!durableMoved) return;
      if (durableExtendsWatermark(durable, watermark)) {
        await appendEnvelopesToFile(paths, durable.envelopes.slice(watermark.publishedCount));
        await writeWatermark(paths, (await statOrUndefined(paths.messages)) ?? current, durable);
        return;
      }
      // Durable moved by a local full-state mutation (replace/compact/rewind);
      // fall through to the divergence decision, which snapshots and rewrites.
      return resolveDivergence(sessionId, paths, durable, (await readPublishedRecords(paths.messages)).records, {
        watermark,
        current,
        durableMoved,
        fileUnchangedSinceWatermark: true,
      });
    }

    const publishedInfo = await readPublishedRecords(paths.messages);
    if (publishedInfo.unreadable) {
      // Review round 3: a file with a duplicated message identity (or any
      // other unrepairable corruption) used to throw out of every reconcile —
      // a permanent fail-closed deadlock, although durable can regenerate
      // every byte. Resolve as §3.4 row 3 instead: durable stays the source,
      // the raw bytes are preserved as evidence, the banner-class warning is
      // logged and emitted, and the file is rewritten from durable.
      await rewriteFromDurablePreservingForeign(sessionId, paths, durable, {
        publishedEntries: await countRawLinesBestEffort(paths.messages),
        reason: 'unreadable',
        ...(publishedInfo.unreadableError ? { detail: publishedInfo.unreadableError } : {}),
      });
      return;
    }
    const published = publishedInfo.records;

    // 2. §3.4 row 2 — foreign append: same inode, grew past the watermark,
    // and the bytes we published are still the exact prefix tail.
    if (
      watermark &&
      current &&
      current.ino === watermark.fileIno &&
      current.size >= watermark.fileSize &&
      durableExtendsWatermark(durable, watermark) &&
      (await tailSha256Of(paths.messages, watermark.fileSize)) === watermark.tailSha256
    ) {
      const foreign = published.slice(watermark.publishedCount);
      // Crash window (kill between the file append and the sidecar write):
      // the watermark lags behind OUR OWN committed append, so the slice
      // begins with records that are already durable. Skip exactly the
      // leading run that continues the durable sequence one-by-one
      // (content-addressed ids) — importing it would trip the append
      // identity boundary and leave the session permanently publish-stale
      // with every file mutation rejected fail-closed (review round 2).
      const ownTail = ownUnwatermarkedPrefixLength(
        foreign,
        durable.envelopes,
        watermark.publishedCount,
      );
      const genuinelyForeign = foreign.slice(ownTail);
      // A parseable foreign record whose id is already durable OUTSIDE the
      // positional continuation would trip the identity boundary and re-throw
      // on every attempt. Resolve as §3.4 row 3 (review round 3): durable
      // stays the source, the file is preserved and rewritten — the conflict
      // surfaces through the warning and the event, never as a livelock.
      const durableIds = new Set(durable.envelopes.map(({ message_id }) => message_id));
      if (genuinelyForeign.some(({ message_id }) => durableIds.has(message_id))) {
        return rewriteFromDurablePreservingForeign(sessionId, paths, durable, {
          publishedEntries: published.length,
          reason: 'conflict',
        });
      }
      if (genuinelyForeign.length > 0) {
        log.info('importing foreign jsonl append into the durable log', {
          sessionId,
          foreignEntries: genuinelyForeign.length,
          ...(ownTail > 0 ? { ownUnwatermarkedEntries: ownTail } : {}),
        });
        await options.durable.importForeignAppends(sessionId, genuinelyForeign);
        const imported = await options.durable.readCommitted(sessionId, 'cached');
        if (!imported) return;
        if (imported.revision === canonicalActiveHistoryRevision(published)) {
          // The file now equals durable: re-watermark it and done.
          await writeWatermark(paths, current, imported);
          return;
        }
        // We also held an unpublished durable tail — durable (with the
        // foreign tail imported) stays the source; the file disagrees.
        return resolveDivergence(sessionId, paths, imported, published, {
          watermark,
          current,
          durableMoved: true,
          fileUnchangedSinceWatermark: false,
        });
      }
      if (ownTail > 0) {
        // The file is the watermarked prefix plus our own unwatermarked tail:
        // nothing to import. The prefix checks below append any remaining
        // durable tail (none, when the file already equals durable) and
        // re-watermark the file — the recovery is idempotent, a repeated
        // flush converges instead of throwing.
        log.info('publish watermark lags behind a committed append; recovering without an import', {
          sessionId,
          laggingEntries: ownTail,
        });
      }
    }

    // 3. Prefix / superset checks against the current durable state.
    const common = commonPrefixLength(durable.envelopes, published);
    if (durableMoved && common === published.length) {
      // The file is a verified prefix of durable (a missing file included):
      // publish the tail. Gated on durable having moved, so an externally
      // truncated file is never "restored" over a foreign rewind.
      await appendEnvelopesToFile(paths, durable.envelopes.slice(common));
      const freshStat = await statOrUndefined(paths.messages);
      if (freshStat) await writeWatermark(paths, freshStat, durable);
      return;
    }
    if (common === durable.envelopes.length && published.length > common) {
      // The file extends durable with records we never wrote (no watermark
      // evidence for the stat path): import the tail (§3.4 row 2).
      const foreign = published.slice(common);
      log.info('importing unwatermarked foreign jsonl tail into the durable log', {
        sessionId,
        foreignEntries: foreign.length,
      });
      await options.durable.importForeignAppends(sessionId, foreign);
      const imported = await options.durable.readCommitted(sessionId, 'cached');
      const freshStat = (await statOrUndefined(paths.messages)) ?? current;
      if (imported && freshStat) await writeWatermark(paths, freshStat, imported);
      return;
    }

    // 4. Divergence.
    return resolveDivergence(sessionId, paths, durable, published, {
      watermark,
      current,
      durableMoved,
      fileUnchangedSinceWatermark: false,
    });
  }

  /**
   * Divergence resolution. The file disagrees with durable beyond a shared
   * prefix. Either the durable state moved locally (full-state mutation, or
   * an unpublished tail — durable wins), or the file was rewritten by the
   * app while everything of ours was published (§3.4 row 3 — the file is the
   * newer truth and is adopted into durable).
   */
  async function resolveDivergence(
    sessionId: string,
    paths: SessionHistoryPaths,
    durable: PublishedDurableState,
    published: readonly CanonicalHistoryEnvelope[],
    evidence: {
      readonly watermark: PublishWatermark | undefined;
      readonly current: StatsLike | undefined;
      readonly durableMoved: boolean;
      readonly fileUnchangedSinceWatermark: boolean;
    },
  ): Promise<void> {
    if (
      evidence.watermark &&
      !evidence.durableMoved &&
      (published.length > 0 || durable.envelopes.length === 0)
    ) {
      // §3.4 row 3 — foreign rewrite while everything of ours was already
      // published (app-side rewind/compact at a lease boundary): adopt.
      // An emptied file never wipes a non-empty durable log on its own —
      // that resolution is the durable-wins rewrite below.
      log.info('adopting foreign jsonl rewrite into the durable log', {
        sessionId,
        publishedEntries: published.length,
        durableEntries: durable.envelopes.length,
      });
      await options.durable.adoptPublishedState(sessionId, published);
      const adopted = await options.durable.readCommitted(sessionId, 'cached');
      const freshStat = (await statOrUndefined(paths.messages)) ?? evidence.current;
      if (adopted && freshStat) await writeWatermark(paths, freshStat, adopted);
      return;
    }
    if (evidence.watermark && evidence.fileUnchangedSinceWatermark) {
      // Local full-state mutation (replace/compact/rewind) behind the file we
      // published: snapshot the former state and full-rewrite (§3.2 replace/
      // compact action, byte-identical to the JSONL provider's behavior).
      await snapshotPublishedState(paths, durable, published);
      await files.replaceActive(paths.messages, durable.envelopes);
      const freshStat = await statOrUndefined(paths.messages);
      if (freshStat) await writeWatermark(paths, freshStat, durable);
      return;
    }
    if (evidence.watermark) {
      // Conflict (§3.4 row 3): we hold an unpublished durable tail and the
      // file diverged. Durable stays the source; the foreign file is
      // preserved as read-only evidence and a banner-class warning is
      // logged and emitted.
      await rewriteFromDurablePreservingForeign(sessionId, paths, durable, {
        publishedEntries: published.length,
        reason: 'conflict',
      });
      return;
    }
    if (published.length > 0) {
      // §3.3 catch-up: a durable session whose jsonl is stale (created before
      // the publisher existed). Snapshot the former file, then full-rewrite.
      await snapshotPublishedState(paths, durable, published);
    }
    await files.replaceActive(paths.messages, durable.envelopes);
    const freshStat = await statOrUndefined(paths.messages);
    if (freshStat) await writeWatermark(paths, freshStat, durable);
  }

  /**
   * §3.4 row 3 conflict resolution, shared by the divergence branch, the
   * unparseable-file case and the identity-conflicting foreign append:
   * durable stays the source, the foreign bytes are preserved as read-only
   * evidence, a banner-class warning is logged AND emitted
   * (`session.publish_conflict` through `onSessionPublishConflict`), and the
   * file is rewritten from durable. Never throws for surface failures — the
   * reconcile must converge on every attempt.
   */
  async function rewriteFromDurablePreservingForeign(
    sessionId: string,
    paths: SessionHistoryPaths,
    durable: PublishedDurableState,
    conflict: {
      readonly publishedEntries: number;
      readonly reason: 'conflict' | 'unreadable';
      readonly detail?: string;
    },
  ): Promise<void> {
    const preservedTo =
      conflict.publishedEntries > 0 || conflict.reason === 'unreadable'
        ? await preserveExternalCopy(paths.messages, nowMs())
        : undefined;
    log.warn(
      conflict.reason === 'unreadable'
        ? 'published jsonl is unreadable; durable kept as the source'
        : 'external jsonl rewrite conflicted with an unpublished durable tail; durable kept as the source',
      {
        sessionId,
        preservedTo,
        durableEntries: durable.envelopes.length,
        publishedEntries: conflict.publishedEntries,
        ...(conflict.detail ? { detail: conflict.detail } : {}),
        hint: 'the session history continues from the durable log; the preserved file is evidence only',
      },
    );
    // §3.4 (review round 1): the conflict must not stay silent at the log
    // level — the product surface renders it as a banner-class warning
    // (`session.publish_conflict` global event) and the status seam can
    // observe it. Best-effort: a failed surface never fails the reconcile.
    try {
      options.onSessionPublishConflict?.({
        sessionId,
        preservedTo,
        durableEntries: durable.envelopes.length,
        publishedEntries: conflict.publishedEntries,
      });
    } catch (error) {
      log.warn('session publish-conflict observer failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await files.replaceActive(paths.messages, durable.envelopes);
    const freshStat = await statOrUndefined(paths.messages);
    if (freshStat) await writeWatermark(paths, freshStat, durable);
  }

  async function appendEnvelopesToFile(
    paths: SessionHistoryPaths,
    tail: readonly CanonicalHistoryEnvelope[],
  ): Promise<void> {
    if (tail.length === 0) return;
    const existing = await statOrUndefined(paths.messages);
    if (!existing) {
      // First publication of a session whose file is absent: the adapter's
      // atomic publish-if-absent (never exposes an empty target).
      await files.publishInitial(paths.messages, tail);
      return;
    }
    await files.append(paths.messages, tail);
  }

  async function snapshotPublishedState(
    paths: SessionHistoryPaths,
    durable: PublishedDurableState,
    published: readonly CanonicalHistoryEnvelope[],
  ): Promise<void> {
    if (published.length === 0) return;
    const snapshotPath = join(
      paths.snapshots,
      `g${String(generationOf(durable.envelopes)).padStart(12, '0')}--${safeSnapshotId(`publish-${nowMs()}`)}.jsonl`,
    );
    await files.publishSnapshot(snapshotPath, published);
    log.info('stale published history snapshotted before the durable catch-up rewrite', {
      sessionId: paths.sessionDir,
      snapshotPath,
      publishedEntries: published.length,
    });
  }

  // -- watermark -----------------------------------------------------------------

  /**
   * Fast-path identity of the published file (§3.2 watermark row 1). The stat
   * triple alone reads an in-place same-size same-mtimeMs edit as
   * "unchanged" (review round 1, remark 5), so the recorded tail hash is the
   * second, content-addressed half of the check — a mismatch falls through to
   * the foreign-rewrite decision (§3.4 row 3: adopt, or conflict when we hold
   * an unpublished tail). Cost deviation from the "one stat" fast path: one
   * ≤4 KiB read + SHA-256 per reconcile; the reconcile is coalesced (≥250 ms
   * per session), so this stays negligible. Residual window: an in-place edit
   * entirely BEFORE the hashed tail keeps matching — the watermark records no
   * older evidence than the tail hash, and full-file hashing would negate it.
   */
  async function watermarkMatches(
    messagesPath: string,
    current: StatsLike,
    watermark: PublishWatermark,
  ): Promise<boolean> {
    if (
      current.ino !== watermark.fileIno ||
      current.size !== watermark.fileSize ||
      current.mtimeMs !== watermark.fileMtimeMs
    ) {
      return false;
    }
    try {
      return (await tailSha256Of(messagesPath, watermark.fileSize)) === watermark.tailSha256;
    } catch {
      // Unreadable/vanished file is not "unchanged": let the slow path
      // (record-level prefix comparison) decide.
      return false;
    }
  }

  /** True when the watermark's published prefix is still a prefix of `durable`. */
  function durableExtendsWatermark(
    durable: PublishedDurableState,
    watermark: PublishWatermark,
  ): boolean {
    if (watermark.publishedCount > durable.envelopes.length) return false;
    if (watermark.publishedCount === 0) return true;
    return durable.envelopes[watermark.publishedCount - 1]?.message_id === watermark.lastMessageId;
  }

  async function writeWatermark(
    paths: SessionHistoryPaths,
    current: StatsLike,
    durable: PublishedDurableState,
  ): Promise<void> {
    const last = durable.envelopes.at(-1);
    const watermark: PublishWatermark = {
      schema: WATERMARK_SCHEMA,
      durableRevision: durable.revision,
      lastMessageId: last?.message_id ?? null,
      publishedCount: durable.envelopes.length,
      fileSize: current.size,
      fileIno: current.ino,
      fileMtimeMs: current.mtimeMs,
      tailSha256: await tailSha256Of(paths.messages, current.size),
    };
    await replaceFileAtomically(
      join(paths.sessionDir, WATERMARK_FILENAME),
      `${JSON.stringify(watermark, null, 2)}\n`,
    );
  }

  async function readWatermark(sessionDir: string): Promise<PublishWatermark | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(sessionDir, WATERMARK_FILENAME), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const record = JSON.parse(raw) as Record<string, unknown>;
      if (!record || typeof record !== 'object') return undefined;
      if (record['schema'] !== WATERMARK_SCHEMA) return undefined;
      if (typeof record['durableRevision'] !== 'string') return undefined;
      if (record['lastMessageId'] !== null && typeof record['lastMessageId'] !== 'string') {
        return undefined;
      }
      if (
        typeof record['publishedCount'] !== 'number' ||
        typeof record['fileSize'] !== 'number' ||
        typeof record['fileIno'] !== 'number' ||
        typeof record['fileMtimeMs'] !== 'number' ||
        typeof record['tailSha256'] !== 'string'
      ) {
        return undefined;
      }
      return {
        schema: WATERMARK_SCHEMA,
        durableRevision: record['durableRevision'],
        lastMessageId: record['lastMessageId'] as string | null,
        publishedCount: record['publishedCount'],
        fileSize: record['fileSize'],
        fileIno: record['fileIno'],
        fileMtimeMs: record['fileMtimeMs'],
        tailSha256: record['tailSha256'],
      };
    } catch {
      // A corrupt sidecar is recoverable: the reconcile falls back to the
      // record-level prefix comparison (idempotent by message_id).
      return undefined;
    }
  }

  // -- file helpers ----------------------------------------------------------------

  async function readPublishedRecords(messagesPath: string): Promise<{
    records: readonly CanonicalHistoryEnvelope[];
    /** The file exists but cannot be parsed or repaired — a §3.4 row 3 conflict, not an empty history. */
    unreadable: boolean;
    unreadableError: string | undefined;
  }> {
    let records: readonly CanonicalHistoryEnvelope[];
    try {
      records = await files.readEnvelopesStrict(messagesPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        return { records: [], unreadable: false, unreadableError: undefined };
      }
      // Review round 3: an unparseable file used to be read as EMPTY, which
      // let branch 3 stack durable records on top of the broken bytes. It is
      // a foreign corruption — route it to the conflict resolution instead.
      return {
        records: [],
        unreadable: true,
        unreadableError: error instanceof Error ? error.message : String(error),
      };
    }
    if (records.length === 0) {
      return { records, unreadable: false, unreadableError: undefined };
    }
    try {
      // Tolerant of an active (pending tool) tail, same as the durable reads;
      // the sequence repair keeps the comparison content-addressed.
      return {
        records: repairCanonicalHistory(records, { allowPendingToolCallTail: true }).records,
        unreadable: false,
        unreadableError: undefined,
      };
    } catch (error) {
      // A duplicated message identity (or any other unrepaired sequence
      // corruption) throws here — previously it escaped the reconcile and
      // deadlocked every fail-closed flush (review round 3).
      return {
        records: [],
        unreadable: true,
        unreadableError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Non-empty jsonl lines of the raw file, for the conflict evidence report. */
  async function countRawLinesBestEffort(messagesPath: string): Promise<number> {
    try {
      return (await readFile(messagesPath, 'utf8'))
        .split('\n')
        .filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  async function preserveExternalCopy(messagesPath: string, ts: number): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const target = `${messagesPath}.external-${String(ts)}${
        attempt === 0 ? '' : `-${String(attempt)}`
      }.jsonl`;
      try {
        await rename(messagesPath, target);
        return target;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT') return target;
        if (attempt === 4 || code === 'EXDEV' || code === 'EPERM') {
          // Best effort: the durable rewrite below must not be blocked by
          // the preservation of the conflicting foreign file.
          log.warn('could not preserve the conflicting foreign file', {
            messagesPath,
            error: error instanceof Error ? error.message : String(error),
          });
          return target;
        }
      }
    }
    throw new Error(`Could not preserve the conflicting foreign file: ${messagesPath}`);
  }

  async function statOrUndefined(filePath: string): Promise<StatsLike | undefined> {
    try {
      return await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async function tailSha256Of(filePath: string, uptoSize: number): Promise<string> {
    const start = Math.max(0, uptoSize - WATERMARK_TAIL_BYTES);
    const length = uptoSize - start;
    const buffer = Buffer.alloc(length);
    const handle = await open(filePath, 'r');
    try {
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
        if (bytesRead === 0) throw new Error(`Could not read the published tail: ${filePath}`);
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return createHash('sha256').update(buffer).digest('hex');
  }
}

interface StatsLike {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Longest common message_id prefix of the two envelope sequences. */
function commonPrefixLength(
  durable: readonly CanonicalHistoryEnvelope[],
  published: readonly CanonicalHistoryEnvelope[],
): number {
  let index = 0;
  const limit = Math.min(durable.length, published.length);
  while (index < limit && durable[index]!.message_id === published[index]!.message_id) index += 1;
  return index;
}

/**
 * Leading run of `foreign` that exactly continues `durable` from `startIndex`
 * (content-addressed ids) — our own tail that the previous process appended
 * to the file before the sidecar write crashed. Only a position-by-position
 * continuation counts: a duplicated id in any other position is not skipped
 * and stays a conflict for the append identity boundary to surface.
 */
function ownUnwatermarkedPrefixLength(
  foreign: readonly CanonicalHistoryEnvelope[],
  durable: readonly CanonicalHistoryEnvelope[],
  startIndex: number,
): number {
  let index = 0;
  while (
    index < foreign.length &&
    startIndex + index < durable.length &&
    foreign[index]!.message_id === durable[startIndex + index]!.message_id
  ) {
    index += 1;
  }
  return index;
}

function generationOf(records: readonly CanonicalHistoryEnvelope[]): number {
  const artifactGeneration = records[0]?.history_artifact?.generation;
  return typeof artifactGeneration === 'number' ? artifactGeneration : 0;
}

/** Snapshot-safe id for publisher snapshots (same rules as compaction ids). */
function safeSnapshotId(value: string): string {
  const sanitized = value.replaceAll(/[^A-Za-z0-9._-]/gu, '-');
  const normalized = /^[A-Za-z0-9]/u.test(sanitized) ? sanitized : `c${sanitized}`;
  return normalized.slice(0, 120);
}
