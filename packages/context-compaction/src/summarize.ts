/**
 * Summary policy and response validation. The core supplies a serialized,
 * image-free cold prompt plus an optional source-bounded request-fork task.
 * A prepared fork inherits the main request's model, route, system, tools,
 * thinking and cache options through the main builder; its adapter still
 * computes the available output capacity. The cold transport uses the model
 * output ceiling (never reserveTokens) and disables new prompt-cache writes.
 *
 * Partial, cancelled, empty and tool-calling responses cannot become durable
 * checkpoints. Provider usage is returned with the accepted summary for billing.
 * @module
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '@mavis/logging';

import type { Summarizer, SummaryResult, SummaryUsageDelta, SummaryForkTask } from './types.js';

const log = createLogger('mcode:compaction');

/**
 * Explicit host cap for a summary request's output. The model ceiling wins
 * whenever it is known and lower; the cap exists so an unknown ceiling
 * (`maxTokens <= 0`) still bounds the request. Deliberately generous — the pin
 * removed fixed caps, not the notion of ANY bound.
 */
export const DEFAULT_SUMMARY_OUTPUT_HOST_CAP = 65536;

/** What the compaction core needs to know about the resolved summarizer model. */
export interface SummaryModel {
  readonly provider: string;
  readonly modelId: string;
  /**
   * The model's output-token ceiling (`pi-ai Model.maxTokens`); `0`/undefined
   * when the catalog does not declare one.
   */
  readonly maxTokens?: number;
  /** Whether the model supports reasoning/thinking at all. */
  readonly reasoning?: boolean;
}

/** Stop reasons the summary response carries. */
export type SummaryStopReason = 'stop' | 'length' | 'aborted' | 'error' | string;

/** The transport-level summary response (an assistant message's relevant slice). */
export interface SummaryResponse {
  readonly text: string;
  readonly stopReason: SummaryStopReason;
  /** Whether the response tried to call a tool — never a valid summary. */
  readonly hasToolCall?: boolean;
  readonly errorMessage?: string;
  /**
   * Provider usage of the summary call, for billing records — the
   * transport's own subset shape (every counter optional; transports that
   * know pricing may report `cost`). Mirrored by the usage-aware summarizer
   * into the `mcode.usage` summary entry.
   */
  readonly usage?: SummaryUsageDelta;
}

/** Everything the transport receives; every field is pinned by this contract. */
export interface SummaryRequest {
  /** The full prompt string (system instruction + serialized conversation + task). */
  readonly prompt: string;
  readonly fork?: SummaryForkTask;
  /**
   * Output limit of the request: the model's output ceiling clamped by the
   * host cap. NEVER derived from `reserveTokens`.
   */
  readonly maxOutputTokens: number;
  /** Cold-route retention; a prepared fork inherits its main request's retention. */
  readonly cacheRetention: 'none';
  /**
   * Routing id: the caller's explicit id when supplied, otherwise a FRESH id
   * for this summary (never shared with the session route by accident).
   */
  readonly sessionId: string;
  /** Thinking level of the summarizer; `'off'` unless the model reasons. */
  readonly reasoning: 'off' | string;
  readonly signal?: AbortSignal;
}

/** The provider call, injected by the runtime (stream fn / completeSimple adapter). */
export type SummaryTransport = (request: SummaryRequest) => Promise<SummaryResponse>;

/** Options of {@link createModelSummarizer}. */
export interface ModelSummarizerOptions {
  /** Routing id forwarded when present; otherwise each call gets a fresh one. */
  readonly sessionId?: string;
  /** Thinking level of the summarizer; `undefined` = `'off'`. */
  readonly thinkingLevel?: 'off' | string;
  /** Explicit host cap; default {@link DEFAULT_SUMMARY_OUTPUT_HOST_CAP}. */
  readonly hostOutputCapTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * Resolve the output limit of a summary request: the model's output ceiling
 * (`maxTokens > 0`) clamped by the explicit host cap. There is NO
 * reserve-derived term — `resolveSummaryMaxOutputTokens` takes no reserve
 * input at all, by design.
 */
export function resolveSummaryMaxOutputTokens(
  model: SummaryModel,
  hostCapTokens: number = DEFAULT_SUMMARY_OUTPUT_HOST_CAP,
): number {
  const ceiling = model.maxTokens !== undefined && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
  const limit = Math.min(ceiling, hostCapTokens);
  // An absurd `hostCapTokens <= 0` means "unbounded" for the same reason the
  // trigger treats a non-positive budget as disabled — but a summary request
  // still carries a positive finite number for transports that require one.
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SUMMARY_OUTPUT_HOST_CAP;
}

/**
 * Returns the failure message when a summary response cannot safely be
 * persisted — pin `getSummarizationFailure` plus the tool-call and empty-text
 * checks of `generateSummaryWithUsage`. A `length` stop contains partial text
 * and must not become a session checkpoint.
 */
export function getSummarizationFailure(response: SummaryResponse, label: string): string | undefined {
  if (response.stopReason === 'error') {
    return `${label} failed: ${response.errorMessage || 'Unknown error'}`;
  }
  if (response.stopReason === 'aborted') return `${label} failed: request was aborted`;
  if (response.stopReason === 'length') {
    return `${label} failed: generation hit the token cap and the summary is incomplete`;
  }
  if (response.hasToolCall === true) {
    return `${label} attempted to call a tool`;
  }
  if (response.text.trim().length === 0) {
    return `${label} produced no text`;
  }
  return undefined;
}

/** Thrown when a summary response must not become a checkpoint. Nothing is published. */
export class SummaryRejectedError extends Error {
  override readonly name = 'SummaryRejectedError';

  constructor(
    message: string,
    /** The failing response, for diagnostics/telemetry (never persisted as a checkpoint). */
    readonly response: SummaryResponse,
  ) {
    super(message);
  }
}

/**
 * Adapter turning a provider transport into the pipeline's `Summarizer`:
 * applies the output limit, the routing rules (`cacheRetention: 'none'`,
 * fresh id when absent) and the thinking policy, and rejects unusable
 * responses with {@link SummaryRejectedError} BEFORE any checkpoint exists.
 *
 * Each SUCCESSFUL call answers in the {@link SummaryResult} form — the text
 * plus the provider spend of exactly that call, attributed to the summarizer
 * model. `compact()` mirrors the combined spend of a cycle's calls into a
 * `mcode.usage` entry (the `summary` category) — pi carries the same numbers
 * on the compaction entry itself (`appendCompaction(..., usage)` → the
 * "Tools/summaries" billing bucket); our declared writer mapping persists
 * them as an explicit usage entry. A REJECTED call throws: no result, no
 * checkpoint, and no billing (a rejected summary publishes nothing at all).
 */
export function createModelSummarizer(
  model: SummaryModel,
  transport: SummaryTransport,
  options: ModelSummarizerOptions = {},
): Summarizer {
  const hostCap = options.hostOutputCapTokens ?? DEFAULT_SUMMARY_OUTPUT_HOST_CAP;
  const maxOutputTokens = resolveSummaryMaxOutputTokens(model, hostCap);
  const reasoning: 'off' | string =
    model.reasoning === true && options.thinkingLevel !== undefined && options.thinkingLevel !== 'off'
      ? options.thinkingLevel
      : 'off';
  return async (prompt: string, fork?: SummaryForkTask): Promise<SummaryResult> => {
    const request: SummaryRequest = {
      prompt,
      ...(fork ? { fork } : {}),
      maxOutputTokens,
      cacheRetention: 'none',
      sessionId: options.sessionId ?? `summary-${randomUUID()}`,
      reasoning,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    const response = await transport(request);
    const failure = getSummarizationFailure(response, 'Summarization');
    if (failure !== undefined) {
      log.warn('summary rejected; no checkpoint will be published', {
        stopReason: response.stopReason,
        hasToolCall: response.hasToolCall === true,
      });
      throw new SummaryRejectedError(failure, response);
    }
    return {
      text: response.text,
      ...(response.usage === undefined
        ? {}
        : { usage: { provider: model.provider, model: model.modelId, usage: response.usage } }),
    };
  };
}
