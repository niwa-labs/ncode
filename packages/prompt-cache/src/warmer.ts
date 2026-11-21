// The ONE CacheWarmer controller (W06 part B) — port of the pin's
// `coding-agent/src/core/cache-warmer.ts` (48c8f32, read line-by-line).
//
// A session's main requests and speculative prewarm intentions share this
// controller and its single in-flight job. The source label is diagnostic.
//
// Adaptations over the donor (the rest is a faithful port):
//   - `models.streamSimple` is our composed stream path (`StreamFn` from
//     pi-agent-core — the SAME wrappers the real request went through:
//     host fetch/headers/timeouts/output clamp), and the warm replay passes
//     the request's `context`/`options` VERBATIM. The warmer never
//     re-serializes or re-hydrates the body: W03/W06 wire segment identity is
//     preserved because the replay IS the same transport over the same
//     canonical window («не converts back в полный Message[]», plan C).
//   - `facts.lastPromptTokens()` replaces the pin's `sessionManager.getBranch`
//     scan — the host reads the last real request's prompt size from the W03
//     projection/durable log (`promptTokensOf(usage)` is the pin arithmetic).
//   - `appendUsage` is the `cache_warm` writer (V-U02) instead of the pin's
//     in-memory SessionManager append; `createDurableCacheWarmUsageSink`
//     turns it into one `mcode.usage` durable entry.
//   - `CacheWarmRequest.revision` carries the canonical request revision
//     (W03 C3 / W04 boundary, structural) the real request addressed;
//     `revisionStillCurrent` composes the V-A04 stale-snapshot guard the host
//     feeds into `isCurrent` («stale snapshot/model/profile отменяет warm»).
//
// Logging: namespace `mcode:cache` — warm scheduled/decision/refreshed/usage
// events (content-free, fields only, `err` object on failures).

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { calculateCost } from '@earendil-works/pi-ai';
import type {
  Api,
  CacheRetention,
  Model,
  ProviderEnv,
  SimpleStreamOptions,
  TranscriptContext,
  Usage,
} from '@earendil-works/pi-ai';
import { createLogger } from '@mavis/logging';

import { resolveCacheRetentionPolicy } from './retention.js';
import type { AppendCacheWarmUsage, CacheWarmUsageRecord } from './usage.js';

const log = createLogger('mcode:cache');

/** Streaming warming never continues past this long after the real request that started it. */
export const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
export const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from pi's own usage; per-session estimates were
 * not better than this constant.
 */
export const IDLE_CONTINUATION_PROBABILITY = 0.15;

/** Persisted warming mode (pin `settings-manager` `CacheWarmingMode`). */
export type CacheWarmingMode = 'off' | 'streaming' | 'idle';

/** Which side expressed the warm intention — both funnel into this one controller. */
export type WarmIntentionSource = 'agent' | 'speculation';

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's
 * `promptCache` tier for the retention the request used. Undefined when the
 * model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheTtlMs(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): number | undefined {
  const retention = resolveCacheRetentionPolicy(options?.cacheRetention, undefined, options?.env);
  if (retention === 'none') return undefined;
  const seconds = retention === undefined ? model.promptCache?.short : model.promptCache?.[retention];
  return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache
 * entry untouched. Anthropic's budget-based thinking (Claude models without
 * adaptive thinking) derives `budget_tokens` from `max_tokens`; the replay
 * would get a different budget, which Anthropic keys the message cache on,
 * and the model could still think for thousands of tokens.
 */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
  if (!options?.reasoning || model.api !== 'anthropic-messages') return true;
  return (model as Model<'anthropic-messages'>).compat?.forceAdaptiveThinking === true;
}

export type CacheWarmingAction = 'warm' | 'stop';

/** Inputs and outcome of one warm-or-stop decision, as shown by `/session`. */
export interface CacheWarmingDecision {
  /** "streaming" while the agent run that sent the request is still active. */
  phase: 'streaming' | 'idle';
  /** Price of this refresh: a cache read of the prompt plus one output token. */
  warmCost: number;
  /** Extra price of the next real request if the cache entry is lost. */
  missCost: number;
  /** Estimated chance that a real request arrives before the entry expires. */
  continuationProbability: number;
  /** `continuationProbability * missCost - warmCost`. */
  expectedSavings: number;
  /** False when the prompt size or the model's prices are unknown. */
  economicsAvailable: boolean;
  /** Pi's decision: "warm" when `expectedSavings` is at least $0.05. */
  action: CacheWarmingAction;
}

/**
 * Fired before each refresh with pi's decision filled in. Everything else an
 * extension might want (model, idle state, context size) is on the context.
 */
export interface CacheWarmingDecisionEvent
  extends Pick<CacheWarmingDecision, 'warmCost' | 'missCost' | 'continuationProbability' | 'action'> {
  type: 'cache_warming_decision';
}

export interface CacheWarmingDecisionEventResult {
  /** Override whether this refresh is sent. "stop" ends warming until the next real request. */
  action?: CacheWarmingAction;
}

export interface CacheWarmingStatus {
  /** "scheduled": a refresh timer is armed; "refreshing": a warm request is in flight. */
  state: 'inactive' | 'scheduled' | 'refreshing';
  /** Why nothing is scheduled. */
  reason?: string;
  nextWarmAt?: number;
  /** The pending decision, or the decision that stopped warming. */
  decision?: CacheWarmingDecision;
  /** True when an extension changed `decision.action`. */
  extensionOverride?: boolean;
  /** Which side expressed the warming intention this status describes. */
  source?: WarmIntentionSource;
}

/**
 * Canonical revision the warmed request addressed (structural subset of the
 * W03 `ProjectionRevision` / W04 `CanonicalRequestRevision`) — the stale-
 * snapshot identity of V-A04. A warm replay is only legal while the
 * projection still sits at this exact revision.
 */
export interface WarmRevision {
  readonly conversationId: string;
  readonly head: number;
  readonly watermark: { readonly seq: number; readonly ordinal: number };
  readonly editVersion: number;
}

/**
 * Compose the V-A04 stale-snapshot guard: current while the projection still
 * reports THIS exact revision (same conversation, head, watermark and edit
 * version). A `current()` that cannot answer (`undefined`) is stale — an
 * unknown revision must never authorize a warm request.
 */
export function revisionStillCurrent(
  at: WarmRevision,
  current: () => WarmRevision | undefined,
): () => boolean {
  return () => {
    const live = current();
    if (live === undefined) return false;
    return (
      live.conversationId === at.conversationId &&
      live.head === at.head &&
      live.watermark.seq === at.watermark.seq &&
      live.watermark.ordinal === at.watermark.ordinal &&
      live.editVersion === at.editVersion
    );
  };
}

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
  model: Model<Api>;
  context: TranscriptContext;
  options: SimpleStreamOptions;
  /** Canonical revision the request addressed (W03 C3); logged and never mutated. */
  revision?: WarmRevision;
  /** Intention source funneled into this one controller (default "agent"). */
  source?: WarmIntentionSource;
}

/** The transport seam: the same composed stream path the real request used. */
export interface WarmModels {
  streamSimple: StreamFn;
}

/** Host facts the economics read; supplied from the W03 projection/durable log. */
export interface WarmFacts {
  /** Prompt size of the most recent real request on the branch, as reported by the provider. */
  lastPromptTokens(): number;
}

interface ActiveRun extends CacheWarmRequest {
  /** False once the session's model or messages no longer match the request. */
  isCurrent: () => boolean;
  ttlMs: number;
  delayMs: number;
  /** Latest safe time to send this refresh, leaving half the original expiry margin. */
  refreshDeadlineAt: number;
  startedAt: number;
  controller: AbortController;
  phase: 'streaming' | 'idle';
  nextWarmAt: number;
  /** Set while a refresh that an extension forced is in flight. */
  extensionOverride: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function price(
  model: Model<Api>,
  tokens: Partial<Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>>,
): number {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...tokens,
  };
  return calculateCost(model, usage).total;
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run — there is exactly ONE controller and at most ONE in-flight
 * warm job no matter how many intention sources call in; warm requests never
 * extend the fixed safety windows.
 */
export class CacheWarmer {
  private run?: ActiveRun;
  private inactive: CacheWarmingStatus;
  private readonly models: WarmModels;
  private readonly facts: WarmFacts;
  private readonly appendUsage: AppendCacheWarmUsage;
  private readonly getMode: () => CacheWarmingMode;
  /** Lets extensions override `event.action`; failures fall back to pi's decision. */
  private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
  /** Called with the persisted usage record after each successful refresh. */
  onWarmed?: (record: CacheWarmUsageRecord) => void;

  constructor(
    models: WarmModels,
    facts: WarmFacts,
    appendUsage: AppendCacheWarmUsage,
    getMode: () => CacheWarmingMode,
    decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
  ) {
    this.models = models;
    this.facts = facts;
    this.appendUsage = appendUsage;
    this.getMode = getMode;
    this.decide = decide;
    this.inactive = { state: 'inactive', reason: 'waiting for first request' };
  }

  get status(): CacheWarmingStatus {
    if (this.getMode() === 'off') return { state: 'inactive', reason: 'cache warming disabled' };
    const run = this.run;
    if (!run) return this.inactive;
    if (!run.isCurrent()) return { state: 'inactive', reason: 'conversation context changed' };
    const decision = this.evaluate(run);
    const refreshing = run.timer === undefined;
    if (!decision.economicsAvailable && !refreshing) {
      return { state: 'inactive', reason: 'cache economics unavailable' };
    }
    return {
      state: refreshing ? 'refreshing' : 'scheduled',
      nextWarmAt: run.nextWarmAt,
      decision,
      extensionOverride: run.extensionOverride,
      source: run.source ?? 'agent',
    };
  }

  /** Keep the prompt cache entry written by `request` warm while `isCurrent` holds. */
  start(request: CacheWarmRequest, isCurrent: () => boolean): void {
    this.clearRun();
    const mode = this.getMode();
    if (mode === 'off') {
      this.stop('cache warming disabled');
      return;
    }
    if (!isReplayable(request.model, request.options)) {
      this.stop('request cannot be replayed safely');
      return;
    }
    const ttlMs = getPromptCacheTtlMs(request.model, request.options);
    if (ttlMs === undefined) {
      this.stop(
        request.options.cacheRetention === 'none'
          ? 'request disabled prompt caching'
          : 'cache lifetime unavailable',
      );
      return;
    }
    const delayMs = getCacheWarmingDelayMs(ttlMs);
    if (delayMs === undefined) {
      this.stop('cache lifetime unavailable');
      return;
    }
    const source = request.source ?? 'agent';
    this.run = {
      ...request,
      source,
      isCurrent,
      ttlMs,
      delayMs,
      refreshDeadlineAt: 0,
      startedAt: Date.now(),
      controller: new AbortController(),
      phase: 'streaming',
      nextWarmAt: 0,
      extensionOverride: false,
    };
    log.debug('cache warm scheduled', {
      source,
      provider: request.model.provider,
      model_id: request.model.id,
      ttl_ms: ttlMs,
      delay_ms: delayMs,
      ...(request.revision !== undefined
        ? { revision_head: request.revision.head, revision_edit_version: request.revision.editVersion }
        : {}),
    });
    this.schedule(this.run);
  }

  onAgentSettled(): void {
    const run = this.run;
    if (!run) return;
    if (this.getMode() === 'streaming') {
      this.stop('agent run settled');
      return;
    }
    run.phase = 'idle';
    const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
    if (run.nextWarmAt > deadline || Date.now() >= deadline) {
      this.stop('30-minute idle safety limit reached');
    }
  }

  /** Reconcile an active run after the persisted warming mode changes. */
  onModeChanged(): void {
    const run = this.run;
    if (!run) return;
    const reason = this.getModeStopReason(run);
    if (reason) this.stop(reason);
  }

  cancel(): void {
    this.stop('inactive');
  }

  private clearRun(): void {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    if (run.timer) clearTimeout(run.timer);
    run.controller.abort();
  }

  private stop(
    reason: string,
    stopped?: Pick<CacheWarmingStatus, 'decision' | 'extensionOverride' | 'source'>,
  ): void {
    this.clearRun();
    this.inactive = { state: 'inactive', reason, ...stopped };
    log.debug('cache warm stopped', {
      reason,
      ...(stopped?.extensionOverride !== undefined ? { extension_override: stopped.extensionOverride } : {}),
    });
  }

  private schedule(run: ActiveRun): void {
    run.extensionOverride = false;
    run.nextWarmAt = Date.now() + run.delayMs;
    // A timer can run late after sleep or event-loop blockage. Keep half of
    // the planned pre-expiry margin for that delay and request dispatch; a
    // late refresh is likely a full-price cache write, not a cache warm.
    run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
    const deadline = run.startedAt + (run.phase === 'idle' ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
    if (run.nextWarmAt > deadline || Date.now() >= deadline) {
      this.stop(run.phase === 'idle' ? '30-minute idle safety limit reached' : 'one-hour safety limit reached');
      return;
    }
    run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
    run.timer.unref?.();
  }

  private async refresh(run: ActiveRun): Promise<void> {
    run.timer = undefined;
    if (!this.validateRun(run)) return;
    if (this.refreshDeadlineMissed(run)) return;
    const decision = this.evaluate(run);
    const { warmCost, missCost, continuationProbability } = decision;
    let action = decision.action;
    try {
      action = await this.decide({
        type: 'cache_warming_decision',
        warmCost,
        missCost,
        continuationProbability,
        action,
      });
    } catch {
      // Extension failures fall back to pi's own decision.
    }
    if (!this.validateRun(run) || this.refreshDeadlineMissed(run)) return;
    const extensionOverride = action !== decision.action;
    log.debug('cache warm decision', {
      action,
      warm_cost: warmCost,
      miss_cost: missCost,
      continuation_probability: continuationProbability,
      expected_savings: decision.expectedSavings,
      economics_available: decision.economicsAvailable,
      extension_override: extensionOverride,
      phase: run.phase,
    });
    if (action === 'stop') {
      const reason = extensionOverride
        ? 'stopped by extension'
        : decision.economicsAvailable
          ? 'expected savings below threshold'
          : 'cache economics unavailable';
      this.stop(reason, { decision, extensionOverride, source: run.source ?? 'agent' });
      return;
    }

    run.extensionOverride = extensionOverride;
    try {
      const stream = await this.models.streamSimple(run.model, run.context, {
        ...run.options,
        maxTokens: 1,
        maxRetries: 0,
        signal: run.controller.signal,
      });
      const message = await stream.result();
      if (!this.validateRun(run)) return;
      if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
        const record = await this.appendUsage({
          provider: message.provider,
          model: message.responseModel ?? message.model,
          usage: message.usage,
          ...(extensionOverride ? { note: 'extension override' } : {}),
        });
        log.info('cache warm refreshed', {
          provider: message.provider,
          model_id: message.responseModel ?? message.model,
          stop_reason: message.stopReason,
          cost_total: message.usage.cost.total,
          extension_override: extensionOverride,
        });
        if (record !== undefined && record !== null) this.onWarmed?.(record);
      } else {
        log.debug('cache warm refresh ended without success', { stop_reason: message.stopReason });
      }
    } catch (error) {
      // Cache warming is best-effort and must not affect the active agent run.
      log.warn('cache warm refresh failed', { err: error instanceof Error ? error : new Error(String(error)) });
    }
    if (this.run === run) this.schedule(run);
  }

  private refreshDeadlineMissed(run: ActiveRun): boolean {
    if (Date.now() <= run.refreshDeadlineAt) return false;
    this.stop('cache refresh deadline missed');
    return true;
  }

  private validateRun(run: ActiveRun): boolean {
    if (this.run !== run) return false;
    const reason = this.getModeStopReason(run) ?? (!run.isCurrent() ? 'conversation context changed' : undefined);
    if (!reason) return true;
    this.stop(reason);
    return false;
  }

  private getModeStopReason(run: ActiveRun): string | undefined {
    const mode = this.getMode();
    if (mode === 'off') return 'cache warming disabled';
    if (mode === 'streaming' && run.phase === 'idle') return 'agent run settled';
    return undefined;
  }

  private evaluate(run: ActiveRun): CacheWarmingDecision {
    const model = run.model;
    const promptTokens = this.facts.lastPromptTokens();
    const cacheHitCost = price(model, { cacheRead: promptTokens });
    const cacheMissCost = price(
      model,
      model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens },
    );
    const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
    const missCost = Math.max(0, cacheMissCost - cacheHitCost);
    const continuationProbability = run.phase === 'idle' ? IDLE_CONTINUATION_PROBABILITY : 1;
    const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
    const expectedSavings = continuationProbability * missCost - warmCost;
    return {
      phase: run.phase,
      warmCost,
      missCost,
      continuationProbability,
      expectedSavings,
      economicsAvailable,
      action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? 'warm' : 'stop',
    };
  }
}

function formatDollars(value: number): string {
  return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
  if (!decision.economicsAvailable) return 'cache economics unavailable';
  const probability = Math.round(decision.continuationProbability * 100);
  const probabilityText =
    decision.phase === 'streaming'
      ? `${probability}% continuation probability while agent is running`
      : `${probability}% continuation probability`;
  const comparison = decision.action === 'warm' ? '>=' : '<';
  return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
  if (nextWarmAt === undefined || nextWarmAt <= now) return 'Decision now';
  let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
  const hours = Math.floor(remainingSeconds / 3600);
  remainingSeconds %= 3600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return `Decision in ${parts.join(' ')}`;
}

/** One-line status for `/session`. */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now: number = Date.now()): string {
  const decision = status.decision;
  // A decision is attached once pi (or an extension) acted on it; "inactive"
  // without one never got that far.
  if (!decision || (status.state === 'inactive' && !decision.economicsAvailable && !status.extensionOverride)) {
    return `Inactive (${status.reason ?? 'unknown reason'})`;
  }
  const details = status.extensionOverride
    ? `extension override, ${formatCacheWarmingEconomics(decision)}`
    : `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
  if (status.state === 'inactive') return `Stopped (${details})`;
  if (status.state === 'refreshing') return `Warming cache (${details})`;
  return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}
