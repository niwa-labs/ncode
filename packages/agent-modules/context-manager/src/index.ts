export { ContextManager } from './manager.js';
export { computeCompactionTriggerAt, DEFAULT_CONTEXT_MANAGER_SETTINGS } from './settings.js';
export {
  isValidCompactionTriggerSetting,
  resolveCompactionTokenBudget,
  resolveConfiguredCompactionTrigger,
  resolveDynamicMaxTokens,
} from './provider-budget.js';
export {
  BpeTokenEstimator,
  createDefaultContextTokenEstimator,
  createDefaultTokenEstimator,
  type ContextTokenEstimate,
  type EncodeFn,
  type TokenEstimator,
} from './token-estimator.js';
export {
  buildCountTokensRequestBody,
  cjkFallbackTokens,
  cjkFallbackTokensForBody,
  estimateCharsToTokensCjkAware,
  type CountTokensRequestBody,
  type CountTokensTool,
} from './count-tokens-body.js';
export {
  estimatePreparedContextUsage,
  readContextWindowTokens,
  type PreparedContextUsageEstimate,
} from './context-usage-estimator.js';
export type {
  ContextCompactionDecision,
  ContextCompactionFailedEvent,
  ContextCompactionPlan,
  ContextCompactionSkippedEvent,
  ContextCompactionCommittedEvent,
  ContextManagerLock,
  ContextManagerCheckpointOptions,
  ContextManagerObserver,
  ContextManagerOptions,
  ContextManagerSettings,
  ContextSummaryGenerator,
  ContextTokenCount,
  ContextTokenCounter,
  ContextTriggerEvaluatedEvent,
} from './types.js';

/**
 * Legacy name kept for the Browser screenshot path's typing: the real
 * request-media pipeline (М1) now backs `encodeRequestImageDetails`, whose
 * result structurally matches this shape.
 */
export interface DeferredScreenshotImageDetails {
  readonly image: { readonly data: string; readonly mimeType: string };
  readonly dimensionNote?: string;
  /** Present when the encoder also measured the source pixels. */
  readonly width?: number;
  readonly height?: number;
}

// М1: the real request-media pipeline is wired; the Browser screenshot
// preprocessor gets the actual re-encode chain (with the honest fallback
// when the image processor cannot load). The old deferred-media stub is gone.
export {
  encodeRequestImage,
  encodeRequestImageBlocks,
  encodeRequestImageDetails,
  type EncodedRequestImage,
  type EncodedRequestImageDetails,
  type RequestImageEncoding,
} from './request-media.js';
export {
  DEFAULT_OUTPUT_LIMIT_MAX_RETRIES,
  OUTPUT_LIMIT_EXHAUSTED_REASON,
  OUTPUT_LIMIT_RETRY_REASON,
  decideOutputLimitRecovery,
  type OutputLimitRecoveryDecision,
} from './output-limit.js';
