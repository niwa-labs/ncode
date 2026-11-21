// Session cache-warming composition (W06 part B, review round 1 fix).
//
// The `@mavis/prompt-cache` package ships the ONE CacheWarmer and the
// `withCacheWarming` wire seam; this module is the PRODUCT composition the
// review found missing («CacheWarmer в рантайме не инстанцируется»): it owns
// one warmer per session, hands the agent-host runner the outermost stream
// wrapper for the turn's MAIN stream fn, feeds the warmer's economics from
// the settled usage of the final successful call, and moves the run to the
// idle phase when the agent run settles — the donor wiring
// (`coding-agent/src/core/sdk.ts` streamFn → `cacheWarmer.start`;
// `new CacheWarmer(modelRuntime, sessionManager, getMode, decide)`).
//
// Differences over the donor, each forced by our host shape:
//   - The warmer lives in a host-level registry (the donor hangs it off the
//     session manager). Bounded: at most `MAX_TRACKED_SESSIONS` warmers are
//     kept; the oldest tracked session is cancelled on overflow, so a
//     long-lived process cannot accumulate transcript-holding runs.
//   - The replay transport is the LATEST captured composed chain: our
//     `composeStreamFn` is rebuilt per turn (headers/fetch/clamps may
//     change), so the warmer delegates to the most recent turn's inner fn —
//     a refresh always rides the same product path the session's latest
//     real request used.
//   - `facts.lastPromptTokens()` reads the settled usage of the session's
//     last successful logical call (`promptTokensOf`, the pin arithmetic)
//     instead of scanning the pin SessionManager branch.
//   - `isCurrent` guards on request identity (model id + the context object
//     reference): every NEW session request replaces the warmed run
//     (`CacheWarmer.start`), so identity equality means "this run is still
//     the session's latest request". The donor additionally checks that the
//     live transcript still extends the request prefix; that stronger guard
//     needs the W03 projection revision and is the documented W07/W10 layer
//     (`WarmRevision` / `revisionStillCurrent` are ready for it).
//   - The warming mode is environment-driven (`MCODE_CACHE_WARMING`), product
//     default `off` (legacy-safe; donor default `streaming` (settings-defaults.ts `cacheWarming`); an invalid
//     value fails SAFE to `off` with a warning. For providers whose models
//     carry no `promptCache` tiers (every bundled catalog except anthropic
//     today) the warmer stops itself with "cache lifetime unavailable" — no
//     warm request is ever sent for them.
//
// The `cache_warm` usage writer: the `mcode.usage` durable medium is a
// wire/durable-mode artifact (the compaction conversation log — the same
// medium the W05 summary writer rides); in the default composition no such
// log exists, so no billing mirror is written there. When the composition
// root provides an append port, `createDurableCacheWarmUsageSink` persists
// one entry per successful refresh; until then the warmer's own logging
// records the spend.

import { createLogger } from '@mavis/logging';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { LLMCallSettledEvent } from '@mavis/agent-core/pi-turn-runner';
import {
  CacheWarmer,
  formatCacheWarmingStatus,
  promptTokensOf,
  withCacheWarming,
  type AppendCacheWarmUsage,
  type CacheWarmingMode,
  type CacheWarmingStatus,
} from '@mavis/prompt-cache';

const log = createLogger('mcode:cache');

/** Environment switch for prompt-cache warming: `off` | `streaming` | `idle`. */
export const MCODE_CACHE_WARMING_ENV = 'MCODE_CACHE_WARMING';

/**
 * Product default is `off` (the wave's legacy-default invariant, on par with
 * `MCODE_CONTEXT_WIRE`/`MCODE_HISTORY_PROVIDER`): warming — including its
 * provider spend — is opt-in. The donor default (`streaming`, pin
 * settings-defaults.ts `cacheWarming`) stays reachable by setting
 * `MCODE_CACHE_WARMING=streaming` explicitly.
 */
const DEFAULT_CACHE_WARMING_MODE: CacheWarmingMode = 'off';

const CACHE_WARMING_MODES: ReadonlySet<string> = new Set(['off', 'streaming', 'idle']);

/** Warmer registry bound — a warmer holds the request transcript by reference. */
const MAX_TRACKED_SESSIONS = 8;

export function resolveCacheWarmingMode(env: NodeJS.ProcessEnv = process.env): CacheWarmingMode {
  const raw = env[MCODE_CACHE_WARMING_ENV];
  if (raw === undefined || raw === '') return DEFAULT_CACHE_WARMING_MODE;
  if (CACHE_WARMING_MODES.has(raw)) return raw as CacheWarmingMode;
  log.warn('cache warming mode env invalid; failing safe to off', {
    env: MCODE_CACHE_WARMING_ENV,
    value: raw,
  });
  return 'off';
}

/** One tracked session: the warmer, its economics facts and its transport slot. */
interface SessionWarmingState {
  warmer: CacheWarmer;
  lastPromptTokens: number;
  /** Latest composed MAIN-stream fn of the session (the replay transport). */
  latestTransport?: StreamFn;
  /** Request identity of the run the warmer keeps warm (isCurrent guard). */
  currentModelId?: string;
  currentContext?: object;
  disposed: boolean;
}

/** The product port the agent-host runner consumes. */
export interface SessionCacheWarming {
  /**
   * Outermost MAIN-stream composition for one turn. The returned wrapper
   * captures `inner` as the session's replay transport and starts the ONE
   * warmer on every session-routed request (same-session `options.sessionId`
   * only — compaction/summary routing ids never match).
   */
  wrapStreamFn(sessionId: string): (inner: StreamFn) => StreamFn;
  /** Feed the warmer economics from the turn's settled call usage. */
  onLLMCallSettled(sessionId: string, event: LLMCallSettledEvent): void;
  /** Move the session's warmed run to the idle phase (agent run settled). */
  onAgentSettled(sessionId: string): void;
  /** `/session`-style one-line status, `undefined` when the session is unknown. */
  describeStatus(sessionId: string): string | undefined;
  /** Structured status for observability surfaces. */
  status(sessionId: string): CacheWarmingStatus | undefined;
  /** Cancel and forget a session's warmed run. */
  disposeSession(sessionId: string): void;
  /** Cancel everything (runtime close). */
  dispose(): void;
}

export interface SessionCacheWarmingOptions {
  /** Warming mode supplier; absent = env-resolved (`MCODE_CACHE_WARMING`). */
  readonly getMode?: () => CacheWarmingMode;
  /**
   * Durable append port for the `cache_warm` billing mirror
   * (`mcode.usage` drafts — `createDurableCacheWarmUsageSink` at the
   * composition root). Absent (default composition): no medium, no mirror;
   * refresh spend is still logged by the warmer.
   */
  readonly appendUsage?: AppendCacheWarmUsage;
  readonly env?: NodeJS.ProcessEnv;
}

export function createSessionCacheWarming(
  options: SessionCacheWarmingOptions = {},
): SessionCacheWarming {
  const getMode = options.getMode ?? (() => resolveCacheWarmingMode(options.env));
  const appendUsage: AppendCacheWarmUsage = options.appendUsage ?? (async () => undefined);
  const sessions = new Map<string, SessionWarmingState>();

  const disposeEntry = (sessionId: string): void => {
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);
    state.disposed = true;
    state.latestTransport = undefined;
    state.warmer.cancel();
  };

  const stateFor = (sessionId: string): SessionWarmingState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const state: SessionWarmingState = {
      lastPromptTokens: 0,
      disposed: false,
      warmer: undefined as never,
    };
    // The replay transport delegates to the LATEST captured composed chain:
    // `composeStreamFn` is rebuilt per turn, and a refresh must ride the
    // product path of the session's most recent real request, never a stale
    // turn's headers/fetch/clamps.
    const transport: StreamFn = (model, context, streamOptions) => {
      const latest = state.latestTransport;
      if (latest === undefined) {
        throw new Error('cache warm replay transport captured no product stream fn');
      }
      return latest(model, context, streamOptions);
    };
    state.warmer = new CacheWarmer(
      { streamSimple: transport },
      { lastPromptTokens: () => state.lastPromptTokens },
      appendUsage,
      getMode,
    );
    sessions.set(sessionId, state);
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      // Map iteration order = insertion order; the FIRST key is the oldest
      // tracked session. Cancelling it drops its transcript reference.
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined && oldest !== sessionId) disposeEntry(oldest);
    }
    return state;
  };

  log.info('session cache warming composed', { default_mode: getMode() });

  return {
    wrapStreamFn: (sessionId) => (inner) => {
      const state = stateFor(sessionId);
      state.latestTransport = inner;
      return withCacheWarming(inner, {
        warmer: state.warmer,
        sessionId,
        isCurrent: (request) => {
          // Record identity at start time: the guard below then answers
          // "is this run still the session's latest request" on every tick.
          state.currentModelId = request.model.id;
          state.currentContext = request.context;
          return () => {
            if (state.disposed || sessions.get(sessionId) !== state) return false;
            return (
              state.currentModelId === request.model.id &&
              state.currentContext === request.context
            );
          };
        },
      });
    },
    onLLMCallSettled: (sessionId, event) => {
      const state = sessions.get(sessionId);
      if (!state || state.disposed) return;
      if (event.final.outcome !== 'success' || !event.usage) return;
      state.lastPromptTokens = promptTokensOf(event.usage);
    },
    onAgentSettled: (sessionId) => {
      sessions.get(sessionId)?.warmer.onAgentSettled();
    },
    status: (sessionId) => sessions.get(sessionId)?.warmer.status,
    describeStatus: (sessionId) => {
      const state = sessions.get(sessionId);
      return state ? formatCacheWarmingStatus(state.warmer.status) : undefined;
    },
    disposeSession: disposeEntry,
    dispose: () => {
      for (const sessionId of [...sessions.keys()]) disposeEntry(sessionId);
    },
  };
}
