/**
 * Context compaction for long agent sessions.
 *
 * A semantic port of the pi v1.3 compaction core over the durable entry log:
 * cut points that never split a tool result from its call, split-turn
 * summaries, overflow recovery with exactly one retry, and a background
 * scheduler with the double trigger (tokens AND bytes) and P0–P4 control
 * plane priorities. See `README.md` for the design contract.
 *
 * W05 additions: per-model compaction settings (`settings.ts`, pin
 * `compaction.modelOverrides`), summary generation by the MODEL's output
 * limit (`summarize.ts`, pin commit 6fcb48670 — never `0.8 * reserveTokens`),
 * file-operation tracking in summaries (`file-ops.ts`), the full frozen
 * SystemMessage checkpoint form (V-C09, `frozen-system.ts`), and the public
 * `context_edit` recovery contract (`recovery-contract.ts`).
 *
 * @module
 */

export * from './types.js';
export {
  CHARS_PER_TOKEN,
  DEFAULT_BACKGROUND_THRESHOLD_RATIO,
  DEFAULT_BLOCKING_THRESHOLD_RATIO,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_SUMMARY_HEADROOM_TOKENS,
  ESTIMATED_IMAGE_CHARS,
  calculateUsageTokens,
  estimateContextTokens,
  estimateManifestBytes,
  estimateMessageTokens,
  estimateProjectedContextTokens,
  evaluateTriggers,
  hasValidUsageAnchor,
  resolveKeepRecentTokens,
} from './estimate.js';
export {
  DEFAULT_COMPACTION_ENABLED,
  DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
  DEFAULT_COMPACTION_RESERVE_TOKENS,
  resolveCompactionBudgets,
  resolveCompactionSettings,
  shouldCompact,
} from './settings.js';
export type {
  CompactionModelOverride,
  CompactionSettingsFile,
  CompactionModelWindow,
  ModelKeyInput,
  ResolvedCompactionSettings,
} from './settings.js';
export {
  COMPACTION_BG_THRESHOLD_ENV,
  COMPACTION_BLOCKING_THRESHOLD_ENV,
  DEFAULT_BACKGROUND_THRESHOLD_PERCENT,
  DEFAULT_BLOCKING_THRESHOLD_PERCENT,
  resolveCompactionBackgroundThresholdRatio,
  resolveCompactionBlockingThresholdRatio,
} from './thresholds.js';
export { createDeterministicSummaryProducer } from './deterministic-summary.js';
export type {
  DeterministicSummaryInput,
  DeterministicSummaryProducer,
} from './deterministic-summary.js';
export {
  createFrozenSystemMessage,
  isFrozenSystemMessage,
  normalizeCheckpointSystemMessage,
  renderFrozenSystemText,
} from './frozen-system.js';
export {
  DEFAULT_SUMMARY_OUTPUT_HOST_CAP,
  SummaryRejectedError,
  createModelSummarizer,
  getSummarizationFailure,
  resolveSummaryMaxOutputTokens,
} from './summarize.js';
export type {
  ModelSummarizerOptions,
  SummaryModel,
  SummaryRequest,
  SummaryResponse,
  SummaryStopReason,
  SummaryTransport,
} from './summarize.js';
export {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  fileOpsFromPreviousDetails,
  formatFileOperations,
} from './file-ops.js';
export type { FileOperations } from './file-ops.js';
export {
  findCutPoint,
  findTurnStartIndex,
  isCutPointMessage,
  isTurnStartMessage,
} from './cut-point.js';
export {
  SPLIT_TURN_SEPARATOR,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  TOOL_RESULT_MAX_CHARS,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  buildSummaryPrompt,
  buildTurnPrefixPrompt,
  imageArtifactPlaceholder,
  mergeSplitTurnSummary,
  serializeConversation,
  withSystemInstructions,
} from './serialize.js';
export {
  UnknownFirstKeptEntryError,
  projectContext,
  summarizableMessages,
  windowManifestBytes,
} from './project.js';
export {
  createCompactionEntryDraft,
  createMessageEntryDraft,
  createOmissionEntryDraft,
  createSystemEntryDraft,
  createUsageEntryDraft,
  generateLogEntryId,
  isCompactionMessagePayload,
  isZeroSummaryUsage,
  parseCompactionEntry,
} from './entries.js';
export { compact } from './compact.js';
export {
  CONTEXT_EDIT_RECOVERY_CONTRACT,
  isContractOmissionPayload,
} from './recovery-contract.js';
export type { ContextEditRecoveryContract } from './recovery-contract.js';
export {
  isContextOverflowError,
  runWithOverflowRecovery,
} from './overflow.js';
export type { GateRelease, WriterGate } from './gate.js';
export { createWriterGate } from './gate.js';
export { WindowUsageTracker } from './usage-tracker.js';
export type { WindowUsage } from './usage-tracker.js';
export type {
  BackgroundCompactionScheduler,
  BackgroundCompactionSchedulerOptions,
  SchedulerNotification,
  SchedulerSession,
  SchedulerFailureStatus,
} from './scheduler.js';
export { createBackgroundCompactionScheduler } from './scheduler.js';
export type {
  ClassifiedCompactionFailure,
  CompactionFailureClass,
} from './scheduler-failures.js';
export {
  DEFAULT_BREAKER_THRESHOLD,
  TRANSIENT_BACKOFF_MS,
  CompactionBreaker,
  classifyCompactionFailure,
  ineffectiveCompactionFailure,
  transientBackoffMs,
} from './scheduler-failures.js';

export type { ReadyCompaction, ReadyCompactionStore, CompactionProgressStage } from './scheduler.js';
