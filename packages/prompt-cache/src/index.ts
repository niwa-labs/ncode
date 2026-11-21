/**
 * @mavis/prompt-cache — prompt-cache services (W06 part B, A4 cache zone).
 *
 * The pinned pi-ai cache surfaces, connected to our wire:
 * - `promptCache` tiers (`Model.promptCache` short/long lifetimes) and the
 *   TTL/delay schedule the warmer follows (`getPromptCacheTtlMs`,
 *   `getCacheWarmingDelayMs`);
 * - `cacheRetention` policy with the documented precedence (explicit request
 *   → host profile → `PI_CACHE_RETENTION` → adapter default "short"; the
 *   summary ban is the compaction summarizer's own `'none'` policy, W05);
 * - session affinity (`resolveSessionAffinity`: the provider cache key is
 *   the session id, dropped only when caching is off);
 * - the ONE `CacheWarmer` — the single warm-intention controller absorbing
 *   the speculation-prewarm source (map §4 :501): agent requests and
 *   speculation intentions both funnel here, one in-flight job, never a
 *   second warmer;
 * - the `cache_warm` usage writer (V-U02, W05 deferral): every successful
 *   refresh mirrors its spend as a `mcode.usage` durable entry under the
 *   `cache_warm` category — folded by the projection, never in LLM context.
 *
 * @module
 */

export {
  PI_CACHE_RETENTION_ENV,
  effectiveCacheRetention,
  resolveCacheRetentionPolicy,
  resolveSessionAffinity,
} from './retention.js';
export {
  CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
  CacheWarmer,
  IDLE_CONTINUATION_PROBABILITY,
  MAX_IDLE_WARMING_AGE_MS,
  MAX_WARMING_AGE_MS,
  formatCacheWarmingStatus,
  getCacheWarmingDelayMs,
  getPromptCacheTtlMs,
  isReplayable,
  revisionStillCurrent,
} from './warmer.js';
export type {
  CacheWarmRequest,
  CacheWarmingAction,
  CacheWarmingDecision,
  CacheWarmingDecisionEvent,
  CacheWarmingDecisionEventResult,
  CacheWarmingMode,
  CacheWarmingStatus,
  WarmFacts,
  WarmIntentionSource,
  WarmModels,
  WarmRevision,
} from './warmer.js';
export {
  CACHE_WARM_USAGE_ENTRY_KIND,
  CACHE_WARM_USAGE_KIND,
  createCacheWarmUsageEntryDraft,
  createDurableCacheWarmUsageSink,
  formatCacheWarmingUsage,
  isZeroWarmUsage,
  normalizeWarmUsage,
  promptTokensOf,
} from './usage.js';
export type {
  AppendCacheWarmUsage,
  AppendCacheWarmUsageInput,
  CacheWarmUsageRecord,
  DurableEntryDraft,
  WarmUsageDelta,
} from './usage.js';
export { withCacheWarming } from './wire.js';
export type { CacheWarmingWireOptions, ObservedWarmRequest } from './wire.js';
