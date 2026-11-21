import {
  createModelSummarizer,
  resolveCompactionBudgets,
  resolveCompactionSettings,
  type CompactionBudgets,
  type CompactionSettingsFile,
  type DeterministicSummaryProducer,
  type DurableEntryDraft,
  type LogEntry,
  type ModelKeyInput,
  type ResolvedCompactionSettings,
  type SchedulerAppendAttempt,
  type SchedulerAttemptSnapshot,
  type Summarizer,
  type SummaryModel,
  type SummaryTransport,
} from '@mavis/context-compaction';
import type { ContextWireCompaction, WireCompactionCheckpoint } from './context-wire.js';

/**
 * W10 Part A — the unified-compaction composition (W05 readiness-transfer
 * step, state/w05.md Deferred 3: "Продуктовая компоновка новых API
 * (resolveCompactionSettings/resolveCompactionBudgets/createModelSummarizer
 * в context-wire/turn-loop: подстановка resolved model identity +
 * пер-модельный budgets в scheduler)").
 *
 * One builder turns the product's per-session model identity, the compaction
 * settings file and the summary transport into the wire pipeline's
 * {@link ContextWireCompaction} seam — the W05 APIs are now the product
 * resolution path instead of package-level tests only. The durable log
 * binding (`entries`/`append`) is injected: it is the log owner's job (the
 * dialect unification of W05 deferred item 2 stays the cross-package
 * contract; this module never re-implements a second fold).
 *
 * @module
 */

/** Resolved model identity + window of the session's model (axis owner). */
export interface SessionModelContext {
  readonly modelKey: ModelKeyInput;
  /** Provider context window in tokens; enables the token trigger axis. */
  readonly contextWindowTokens: number;
  /** Byte budget override; defaults to the pipeline's wire guard. */
  readonly byteBudget?: number;
  /** The summarizer model (defaults to the session model). */
  readonly summaryModel?: Pick<SummaryModel, 'provider' | 'modelId' | 'maxTokens' | 'reasoning'>;
  /** Thinking level offered to the summary model when it supports reasoning. */
  readonly summaryThinkingLevel?: string;
}

/** The session's durable log binding (compaction dialect, writer-gated). */
export interface WireCompactionLogBinding {
  /** Live append-only session log, oldest first, growing only. */
  readonly entries: () => readonly LogEntry[];
  readonly readyStore?: import('@mavis/context-compaction').ReadyCompactionStore;
  readonly onProgress?: (stage: import('@mavis/context-compaction').CompactionProgressStage) => void;
  /**
   * Durable append of checkpoint drafts (writer-gated). The second argument
   * carries the attempt identity the plan was built on (wave 3, canon 05
   * §2.3 staleness) — a binding serving the wave-1 event log refuses the
   * append when its current generation or summarizer identity has moved.
   */
  readonly append: (drafts: readonly DurableEntryDraft[], attempt?: SchedulerAppendAttempt) => Promise<void>;
  /**
   * Wave 3 (item 3.1, canon 05 §2.3): the canonical attempt snapshot — the
   * fold generation and the covered cut of the log the job would summarize.
   * The scheduler keys the attempt `(baseGeneration, cut, model, promptHash)`
   * on it; absent keeps the head-proxy key.
   */
  readonly attemptSnapshot?: () => SchedulerAttemptSnapshot;
  /**
   * Wave 3 (item 3.2, canon 05 §2.2): the deterministic fallback summary
   * producer — with the breaker open, the blocking edge compacts through it
   * (NO provider call).
   */
  readonly deterministicSummary?: DeterministicSummaryProducer;
  /**
   * В1: facts of the session's LAST checkpoint committed through `append`
   * (the canonical replacement included) — the barrier admission point's
   * `replaceMessages` source. `undefined` while no checkpoint has been
   * committed; omitting the member disables the barrier for the session.
   */
  readonly checkpointReplacement?: () => WireCompactionCheckpoint | undefined;
  /**
   * В1: registers the CURRENT turn's abort signal for the summary request
   * (see `ContextWireCompaction.setSummarySignal` — the exec streamFn has no
   * idle timeout; the signal must be self-clearing, since a background job
   * may outlive the turn that registered it).
   */
  readonly setSummarySignal?: (signal: AbortSignal | undefined) => void;
}

export interface UnifiedCompactionCompositionOptions {
  /** The compaction settings file source (re-read per resolution). */
  readonly settings: () => CompactionSettingsFile;
  /** The session's resolved model context; `undefined` = seam disabled for this session. */
  readonly resolveSessionModel: (sessionId: string) => SessionModelContext | undefined;
  /**
   * The summary transport factory (the product provider request path,
   * adapted to the W05 SummaryTransport shape); invoked lazily per session.
   */
  readonly summaryTransport: (sessionId: string) => SummaryTransport;
  /** The durable log binding; `undefined` = seam disabled for this session. */
  readonly logBinding: (sessionId: string) => WireCompactionLogBinding | undefined;
  /** Recent-context budget override; default: the scheduler's own. */
  readonly keepRecentTokens?: (sessionId: string) => number | undefined;
}

export interface UnifiedCompactionResolution {
  readonly settings: ResolvedCompactionSettings;
  readonly budgets: CompactionBudgets;
}

export interface UnifiedCompactionComposition {
  /** The per-session seam factory for `createTurnContextWire({ compactionFor })`. */
  readonly compactionFor: (sessionId: string) => ContextWireCompaction | undefined;
  /** The last resolution per session (observability for the budget axes). */
  readonly lastResolution: (sessionId: string) => UnifiedCompactionResolution | undefined;
}

/**
 * Builds the unified-compaction composition. Resolution follows the W05
 * semantics exactly: per-model settings (`provider/modelId`), the pi trigger
 * rule (`contextTokens > window − reserve`) mapped onto the budget ratios,
 * the byte axis preserved, and the summarizer pinned to `cacheRetention:
 * 'none'` with the host output cap. A session without model identity or log
 * binding gets NO seam (the pipeline's own loud warning covers the unset
 * budget) — never a silently wrong budget.
 */
export function createUnifiedCompactionComposition(
  options: UnifiedCompactionCompositionOptions,
): UnifiedCompactionComposition {
  const resolutions = new Map<string, UnifiedCompactionResolution>();
  return {
    compactionFor: (sessionId: string) => {
      const model = options.resolveSessionModel(sessionId);
      const binding = options.logBinding(sessionId);
      if (model === undefined || binding === undefined) return undefined;
      const settings = resolveCompactionSettings(options.settings(), model.modelKey);
      const budgets = resolveCompactionBudgets(settings, {
        contextWindowTokens: model.contextWindowTokens,
        ...(model.byteBudget !== undefined ? { byteBudget: model.byteBudget } : {}),
      });
      resolutions.set(sessionId, { settings, budgets });
      const summarizer: Summarizer = createModelSummarizer(
        model.summaryModel ?? {
          provider: model.modelKey.provider,
          modelId: model.modelKey.modelId,
          maxTokens: model.contextWindowTokens,
        },
        options.summaryTransport(sessionId),
        model.summaryThinkingLevel !== undefined
          ? { thinkingLevel: model.summaryThinkingLevel }
          : {},
      );
      const keepRecent = options.keepRecentTokens?.(sessionId);
      return {
        summarizer,
        // Wave-0 item 0.2: the resolved summary-model identity rides the seam
        // so the scheduler's attempt key distinguishes summarizers.
        summarizerKey: () => {
          const summaryModel = model.summaryModel ?? {
            provider: model.modelKey.provider,
            modelId: model.modelKey.modelId,
          };
          return `${summaryModel.provider}/${summaryModel.modelId}`;
        },
        entries: binding.entries,
        readyStore: binding.readyStore,
        onProgress: binding.onProgress,
        append: binding.append,
        budgets: { ...budgets },
        ...(keepRecent !== undefined ? { keepRecentTokens: keepRecent } : {}),
        // Wave 3 (item 3.1): the canonical attempt snapshot and (item 3.2)
        // the deterministic fallback producer forward from the binding.
        ...(binding.attemptSnapshot ? { attemptSnapshot: binding.attemptSnapshot } : {}),
        ...(binding.deterministicSummary
          ? { deterministicSummary: binding.deterministicSummary }
          : {}),
        ...(binding.checkpointReplacement
          ? { checkpointReplacement: binding.checkpointReplacement }
          : {}),
        ...(binding.setSummarySignal ? { setSummarySignal: binding.setSummarySignal } : {}),
      };
    },
    lastResolution: (sessionId) => resolutions.get(sessionId),
  };
}
