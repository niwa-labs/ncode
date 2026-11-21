// Warm-intention seam on the product wire (W06 part B).
//
// Donor wiring (pin coding-agent `sdk.ts` streamFn, read line-by-line): every
// SESSION request — `options.sessionId === sessionManager.getSessionId()`;
// compaction and summaries route under their OWN ids and never replace the
// cache entry — hands `{model, context, options}` to the ONE CacheWarmer
// before delegating to the real transport:
//
//     if (options?.sessionId === sessionManager.getSessionId()) {
//       cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
//     }
//     return modelRuntime.streamSimple(model, context, requestOptions);
//
// This module is that seam over OUR composed stream path (`StreamFn`, the
// agent-core wrapper chain: host fetch/headers/timeouts/output clamp). The
// wrapper OBSERVES only: `model`, `context` and `options` reach the inner
// stream fn by the same object references — no copy, no re-serialization, no
// re-hydration into a full Message[]. W03/W06 wire segment identity is
// preserved by construction because the warm replay (CacheWarmer.refresh)
// sends the very same `(model, context, options)` triple through the very
// same composed transport — «provider wire потребляет сегменты напрямую, не
// converts back в полный Message[]» (plan C).
//
// The W05 compaction summarizer needs no exclusion rule here: it already
// routes with a FRESH id (`summary-<uuid>`, summarize.ts) so the sessionId
// equality check never matches it («Summary warming отключён»).

import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
// pi 48c8f32: the simple-call helpers live in the `./compat` entry (compat
// re-exports the whole root surface) — the same default the agent-core
// wrappers fall back to (`llm.ts` withCacheRetention/withHeaders).
import { streamSimple } from '@earendil-works/pi-ai/compat';

import type { CacheWarmer, WarmIntentionSource, WarmRevision } from './warmer.js';

/** One observed real request, handed to the host policy callbacks. */
export interface ObservedWarmRequest {
  readonly model: Model<Api>;
  readonly context: TranscriptContext;
  readonly options: SimpleStreamOptions | undefined;
}

export interface CacheWarmingWireOptions {
  /** The ONE warmer controller all intentions funnel into. */
  readonly warmer: CacheWarmer;
  /** Session identity whose requests may replace the warmed cache entry. */
  readonly sessionId: string;
  /**
   * Staleness policy for the started run (V-A04): return the guard the warmer
   * re-checks before every refresh. Compose `revisionStillCurrent` (canonical
   * revision) with model/profile identity as the host sees fit; `cacheContextIsCurrent`
   * of the pin checked «model unchanged AND transcript still extends the
   * request's prefix».
   */
  readonly isCurrent: (request: ObservedWarmRequest) => () => boolean;
  /** Canonical revision supplier (W03 C3) attached to the warm intention. */
  readonly revision?: (request: ObservedWarmRequest) => WarmRevision | undefined;
  /** Intention source tag recorded on the run (default "agent"). */
  readonly source?: WarmIntentionSource;
}

/**
 * Compose cache warming over a stream fn: session requests start the ONE
 * warmer, every call still delegates VERBATIM to `inner` (identity of
 * model/context/options objects preserved — the request bytes are untouched
 * by observation). `inner === undefined` falls back to the pinned
 * `streamSimple` exactly like the agent-core wrappers do.
 */
export function withCacheWarming(
  inner: StreamFn | undefined,
  options: CacheWarmingWireOptions,
): StreamFn {
  const base = inner ?? streamSimple;
  return ((model, context, streamOptions) => {
    if (streamOptions?.sessionId === options.sessionId) {
      const observed: ObservedWarmRequest = { model, context, options: streamOptions };
      options.warmer.start(
        {
          model,
          context,
          options: streamOptions ?? {},
          ...(options.revision !== undefined ? { revision: options.revision(observed) } : {}),
          ...(options.source !== undefined ? { source: options.source } : {}),
        },
        options.isCurrent(observed),
      );
    }
    // Delegate with the ORIGINAL argument objects — never a rebuilt copy.
    return base(model, context, streamOptions);
  }) as StreamFn;
}
