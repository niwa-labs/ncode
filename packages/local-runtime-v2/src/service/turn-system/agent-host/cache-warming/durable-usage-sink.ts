// The cache_warm durable port of the DEFAULT composition (W10 part B).
//
// W06 shipped the warmer, the `withCacheWarming` seam and the draft writer
// (`@mavis/prompt-cache`'s `createDurableCacheWarmUsageSink`), but no product
// append port existed: "the `mcode.usage` durable medium ... the default
// composition does not open, so no append port is bound here yet"
// (services.ts). W10 binds it: when the runtime composition owns the Ш1
// durable-history storage (one SqliteZstdBackend + one StorageWorker per
// runtime — the same worker the canonical history and the checkpoint barrier
// ride), every successful warm refresh is mirrored as ONE `mcode.usage`
// entry of the `cache_warm` category into that log.
//
// Contract notes:
// - the payload shape is pinned by the cross-package test against the
//   projection's strict `mcode.usage` decoder (`prompt-cache`,
//   cache-warm-usage.test.ts) — the fold reads it on BOTH axes
//   (provider/model billing + writer category);
// - the entry NEVER enters the LLM context (control kind, V-U02), so a warm
//   refresh cannot pollute the context-token trigger;
// - entries ride the shared worker (single writer discipline; log order is
//   authoritative — `parentId: null`, mirroring how the seed/full-state
//   writer anchors a new chain);
// - a failed mirror is LOUD (logged error) but never kills the turn: the
//   warmer's billing callback contract is "never throws through the agent
//   run" (`AppendCacheWarmUsage`), and the mirror is a billing record, not a
//   correctness gate — the refresh itself already happened.
//
// In the jsonl history mode no durable medium exists and the port stays
// unbound (the warmer's own logging records the spend) — the documented
// composition degradation, never a silent write to a different medium.

import { createLogger } from '@mavis/logging';
import {
  createDurableCacheWarmUsageSink,
  type AppendCacheWarmUsage,
} from '@mavis/prompt-cache';
import { entryDraftSizeBytes, type StorageWorker } from '@mavis/storage-worker';

const log = createLogger('mcode:cache');

/** The slice of the Ш1 durable-history storage the mirror needs. */
export type DurableUsageAppendTarget = {
  readonly worker: StorageWorker;
};

/**
 * Bind the `cache_warm` billing mirror to the runtime's durable-history log:
 * one `mcode.usage` entry per successful refresh, appended through the shared
 * storage worker. Never throws through the agent run.
 */
export function createDurableHistoryCacheWarmUsageSink(
  target: DurableUsageAppendTarget,
): AppendCacheWarmUsage {
  const sink = createDurableCacheWarmUsageSink(async (draft) => {
    try {
      await target.worker.enqueue({
        entryId: draft.id,
        parentId: draft.parentId ?? null,
        kind: draft.kind,
        payload: draft.payload,
        bytes: entryDraftSizeBytes({ id: draft.id, kind: draft.kind, payload: draft.payload }),
      });
    } catch (error) {
      // Admission failures (oversized/corrupt draft) and queue failures are
      // terminal for THIS mirror entry, never for the turn: the refresh spend
      // is still billed inline by the provider response fold.
      log.error('cache-warm-usage-append-failed', { err: error, entryId: draft.id });
    }
  });
  return (input) => {
    // The warmer calls this on its own cadence; surface sink rejections the
    // same way (log + swallow) so no refresh path can be broken by the mirror.
    return Promise.resolve(sink(input)).catch((error: unknown) => {
      log.error('cache-warm-usage-sink-failed', { err: error });
      return undefined;
    });
  };
}
