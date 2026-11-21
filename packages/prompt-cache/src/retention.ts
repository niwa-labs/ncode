// Cache-retention policy and session affinity (W06 part B).
//
// Donor (pin 48c8f32): every cache-capable adapter resolves retention through
// the SAME two-step rule — `ai/src/api/{anthropic-messages,openai-responses,
// pi-messages,bedrock-converse-stream}.ts` `resolveCacheRetention`:
//   1. an explicit `options.cacheRetention` wins;
//   2. otherwise `PI_CACHE_RETENTION=long` (provider-scoped env, then
//      process.env — `getProviderEnvValue`) selects "long";
//   3. otherwise the adapter default "short" applies downstream.
// and then keys the provider's cache-affinity field ONLY when caching is on:
// `cacheSessionId = cacheRetention === "none" ? undefined : options.sessionId`
// (anthropic-messages.ts:626-627, openai-responses.ts:186-187/364,
// mistral-conversations.ts:546 `promptCacheKey`). This module is that rule as
// one policy seam for the host, with the mcode precedence layer documented by
// the port plan (§3.2 :478): «явная request policy → профиль/настройки →
// pi env/default, с отдельным запретом кэша для summary».
//
// The summary ban is NOT re-implemented here: `@mavis/context-compaction`'s
// summarizer already pins `cacheRetention: 'none'` + a fresh routing id per
// call (W05 `summarize.ts`, V-K04), which this module treats as just another
// explicit request policy.

import { getProviderEnvValue } from '@earendil-works/pi-ai/utils/provider-env';
import type { CacheRetention, ProviderEnv } from '@earendil-works/pi-ai';

/** Environment variable the pinned adapters read for the legacy "long" default. */
export const PI_CACHE_RETENTION_ENV = 'PI_CACHE_RETENTION';

/**
 * Resolve the effective cache-retention POLICY, `undefined` meaning "no
 * explicit choice — the provider adapter applies its own default (`short`)".
 *
 * Precedence (port-plan §3.2 :478, V-A01):
 *   1. explicit per-request policy (`SimpleStreamOptions.cacheRetention`);
 *   2. host profile/settings policy (our `LLMModelConfig.cacheRetention`,
 *      agent-core `withCacheRetention` wrapper feeds exactly this);
 *   3. pinned pi env default — `PI_CACHE_RETENTION=long` selects "long",
 *      every other value falls through (pin: `=== "long" ? "long" : …`);
 *   4. `undefined` → the adapter default "short".
 */
export function resolveCacheRetentionPolicy(
  requestPolicy: CacheRetention | undefined,
  hostPolicy: CacheRetention | undefined = undefined,
  env: ProviderEnv | undefined = undefined,
): CacheRetention | undefined {
  if (requestPolicy !== undefined && requestPolicy !== null) return requestPolicy;
  if (hostPolicy !== undefined && hostPolicy !== null) return hostPolicy;
  if (getProviderEnvValue(PI_CACHE_RETENTION_ENV, env) === 'long') return 'long';
  return undefined;
}

/**
 * The retention a request is EFFECTIVELY made with: the resolved policy, or
 * `"short"` when nobody chose — the pinned adapters' documented default
 * (`StreamOptions.cacheRetention`: "Default: 'short'").
 */
export function effectiveCacheRetention(
  requestPolicy: CacheRetention | undefined,
  hostPolicy: CacheRetention | undefined = undefined,
  env: ProviderEnv | undefined = undefined,
): Exclude<CacheRetention, 'none'> {
  const resolved = resolveCacheRetentionPolicy(requestPolicy, hostPolicy, env);
  return resolved === undefined || resolved === 'none' ? 'short' : resolved;
}

/**
 * The cache-affinity session id a request carries: the session id UNLESS
 * caching is disabled. This is the pinned adapters' shared rule
 * (`cacheSessionId = cacheRetention === "none" ? undefined : options.sessionId`)
 * exposed once so the host and the CacheWarmer agree on what "stable routing"
 * means — a warm replay must send the SAME affinity key as the real request.
 */
export function resolveSessionAffinity(input: {
  readonly sessionId: string | undefined;
  readonly cacheRetention: CacheRetention | undefined;
  readonly env?: ProviderEnv;
}): string | undefined {
  const retention = resolveCacheRetentionPolicy(input.cacheRetention, undefined, input.env);
  return retention === 'none' ? undefined : input.sessionId;
}
