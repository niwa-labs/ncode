import type { RuntimeEvent } from '@mavis/agent-core/protocol';
import type {
  LLMContextOverflowRecovery,
  PiAfterToolCallHook,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookInput,
  PiBeforeToolCallHook,
  PiEventWriter,
  PiTurnRunnerLogger,
  RunTurnCaller,
  RunTurnInput,
  TurnEventReporter,
  UserMessageInput,
} from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool, ToolExecutionContext } from '@mavis/agent-core/tools';

import type { InputSafetyDecision } from '../../../content-safety/index.js';
import type {
  AgentExecutionSnapshot,
  AgentHostBrowserAsset,
  AgentHostChannelContext,
  ContextUsagePromptRange,
} from '../preparation/contracts.js';
import type { CheckpointBarrier } from './turn-checkpoint-policy.js';
import type { TurnLlmCallObservation } from './llm-logging.js';
import type { PromptSuggestionTurnPort } from '../runner/prompt-suggestion/prompt-suggestion-service.js';
import type { SessionRecord } from '../../../session-system/index.js';
import type {
  AgentHostFileChangeObservation,
  AgentHostSteeringMessage,
  LocalTurnExecutionInput,
  LocalTurnOutputTokenCapResolver,
  LocalTurnToolPolicyGuard,
} from '../runner/contracts.js';
import type { LocalTurnPermissionMarkSink } from '../runner/index.js';
import type {
  FileApiUploadStoreSource,
  MessagesFileApiPatcherLogger,
} from '../assembly/messages-file-api-patcher.js';
import type {
  LocalTurnEventWriter,
  RuntimeEventProjector,
} from '../events/runtime-event-writer.js';
import type { TurnContextWire } from '../../compaction/context-wire.js';
import type { InputReviewResolvedObserver } from '../runner/policy/input-review-runner-options.js';
import type { BackgroundReminderFacts } from '../assembly/local-turn-input-preparation.js';

/** Ephemeral, source-verified tool facts; no persistence or control ownership. */
interface AgentHostToolProgressObservation {
  readonly toolCallId: string;
  readonly loopKey: unknown;
  readonly progressKey: unknown;
  readonly stateChanged?: boolean;
  readonly artifactChanged?: boolean;
  readonly newFacts?: number;
}

export type LocalContextUsagePromptRange = ContextUsagePromptRange;

export type LocalRuntimeTurnRunnerInput<
  TContext extends ToolExecutionContext = LocalRuntimeTurnToolContext,
> = Omit<RunTurnInput<TContext>, 'eventWriter' | 'toolConfig'> & {
  readonly eventWriter: LocalTurnEventWriter;
  readonly tools?: readonly RuntimeTool[];
  readonly disableBuiltinToolFallback?: boolean;
  readonly toolContext?: TContext;
  readonly reviewUserInput?: string;
  readonly promptMetadata?: Readonly<Record<string, unknown>>;
  /** MiniMax-managed turns require the product content-review gateway; BYOK turns do not. */
  readonly contentReviewRequired?: boolean;
  /** TUI-only direct streaming for turns that do not require content review. */
  readonly streamUnreviewedOutput?: boolean;
  /** TUI-only: publish the input-review decision after the answer has settled. */
  readonly deferInputReviewResolution?: boolean;
  readonly inputSafetyDecision?: InputSafetyDecision;
  readonly inputSafetyDigest?: string;
  readonly getSteeringMessages?: NonNullable<RunTurnInput['getSteeringMessages']>;
  readonly shouldStopAfterSteering?: NonNullable<RunTurnInput['shouldStopAfterSteering']>;
  readonly shouldStopAfterTurn?: NonNullable<RunTurnInput['shouldStopAfterTurn']>;
  readonly tryBeginClose?: NonNullable<RunTurnInput['tryBeginClose']>;
  readonly recallOutputAttemptHistory?: (attempt: number) => Promise<void>;
  readonly onOutputRecall?: (input: {
    readonly attempt: number;
    readonly messageIds: readonly string[];
  }) => void | Promise<void>;
  readonly onInputReviewResolved?: (rejected: boolean) => void;
  readonly persistApprovedPartialOnNetworkStop?: boolean;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
  readonly onLlmAttempt?: (input: {
    readonly attemptIndex: number;
    readonly systemPrompt: string;
  }) => void;
  readonly contextUsagePromptRanges?: readonly LocalContextUsagePromptRange[];
  /** BYOK snapshots require terminal Provider input usage and context-window anchors. */
  readonly contextUsageRequiresProviderAnchor?: boolean;
  /** Frozen during preparation with the same Prompt snapshot as the System Prompt. */
  readonly outputRevisionInstruction?: string;
};

export type { LocalTurnEventWriter } from '../events/runtime-event-writer.js';

export interface LocalRuntimeTurnToolContext extends ToolExecutionContext {
  readonly agentName: string;
  readonly parentAgentConfig: Readonly<Record<string, unknown>>;
  /**
   * Frozen from the final catalog. Explicit background Bash may start only
   * when its owner can consume output through trusted native `task_output`.
   */
  readonly canConsumeBackgroundBashOutput?: boolean;
  /**
   * Set only by the trusted built-in Explore Turn profile. When the local
   * sandbox is enabled, Bash uses its existing read-only filesystem policy.
   */
  readonly forceReadOnlyFilesystem?: boolean;
  readonly eventWriter: PiEventWriter;
  readonly reporter?: TurnEventReporter;
  readonly channelContext?: AgentHostChannelContext;
  readonly trustedExactWritePaths: readonly string[];
  /** Native files materialized from user attachments during this active Turn. */
  readonly browserAssets?: readonly AgentHostBrowserAsset[];
  /**
   * W4 (§4.4/R5): the per-session tool-env snapshot the window attached with
   * (`session.attach.toolEnv`, "last owner attach wins"). The daemon overlays
   * it onto the spawn env/cwd BEFORE the always-on sanitizer, so `MCODE_*`/
   * `MINIMAX_*` stay stripped regardless of the snapshot. Absent (embedded
   * TUI, tests): tools run with the daemon's env — today's behavior.
   */
  readonly toolEnv?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> };
}

export type LocalRuntimeTurnReconcileSignal =
  | {
      readonly kind: 'output-recall';
      readonly source?: 'input-review' | 'output-review';
      readonly variant: 'content' | 'network' | 'auth';
    }
  | { readonly kind: 'network-reconcile'; readonly approvedContent?: string }
  | { readonly kind: 'abort-reconcile'; readonly approvedContent?: string };

export interface LocalRuntimeTurnRunnerResult {
  readonly reconcile?: LocalRuntimeTurnReconcileSignal;
  readonly events?: readonly RuntimeEvent[];
  readonly retracted?: boolean;
  readonly networkStopped?: boolean;
  readonly approvedPartial?: {
    readonly thinking: string;
    readonly content: string;
    readonly msgId?: string;
  };
  readonly retractionVariant?: 'content' | 'network' | 'auth';
  readonly timingEventsStartIndex?: number;
  readonly outcome?: LocalRuntimeTurnRuntimeOutcome;
}

export interface LocalRuntimeTurnRuntimeOutcome {
  readonly status: 'completed' | 'aborted' | 'failed' | 'unknown';
  readonly errorMessage?: string;
  readonly errorCode?: number;
  readonly errorSource?: string;
  readonly errorDetail?: string;
  readonly errorProviderId?: string;
  readonly messageId?: string;
  readonly waitingForUser?: boolean;
}

export interface LocalRuntimeTurnRunnerPort<
  TContext extends ToolExecutionContext = LocalRuntimeTurnToolContext,
> {
  /** The runner can consume an outcome summary instead of a retained event array. */
  readonly acceptsEventSummary?: boolean;
  runTurn(
    input: LocalRuntimeTurnRunnerInput<TContext>,
  ): Promise<LocalRuntimeTurnRunnerResult | void>;
}

export interface LocalTurnPermissionResolution<TContext extends ToolExecutionContext> {
  readonly context: TContext;
  readonly disableBuiltinToolFallback: boolean;
  /** Host-owned fail-closed permission policy applied to every executable tool. */
  readonly permissionGuard: PiBeforeToolCallHook;
  /**
   * §4 per-turn permission-mark sink shared by the permission guard (writer)
   * and the turn runner (reader: forwarded to the event bridge so tool-call
   * statuses carry who decided). Absent on hosts that never wired the guard.
   */
  readonly permissionMarks?: LocalTurnPermissionMarkSink;
}

export interface LocalToolResultHistoryFinalizerInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly toolContext: Parameters<PiAfterToolCallHook>[0];
}

/** Runs after Plugin PostToolUse and immediately before Pi records the ToolResult in History. */
export type LocalToolResultHistoryFinalizer = (
  input: LocalToolResultHistoryFinalizerInput,
  signal: AbortSignal,
) => ReturnType<PiAfterToolCallHook>;

/** Per-turn host safety seam that runs outside user- and plugin-controlled hooks. */
export interface LocalTurnToolSafetyGuard {
  readonly beforeToolCall: PiBeforeToolCallHook;
  readonly afterToolCall: (
    input: Parameters<PiAfterToolCallHook>[0],
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

export interface LocalTurnHookMergeOptions<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
> {
  readonly input: LocalTurnExecutionInput<TAgent>;
  readonly toolResolution: LocalTurnPermissionResolution<TContext>;
  readonly pendingToolResultTailClaims: Set<string>;
  readonly hostBeforeLlmCallHooks: readonly PiBeforeLlmCallHook[];
  /** SE-SW-002: fail-closed durability flush before every provider request. */
  readonly checkpointBarrier?: CheckpointBarrier;
  /**
   * Ш4 context-wire handle: canonical commits of the turn feed the session's
   * wire window from the merged history hook. Absent (default): no feed.
   */
  readonly contextWire?: TurnContextWire;
  readonly readTaskOutputTaskIds: Set<string>;
  readonly terminalTaskOutputReadIds?: Set<string>;
  readonly toolsDisabled: boolean;
  readonly toolSafetyGuard?: LocalTurnToolSafetyGuard;
  readonly toolPolicyGuard?: LocalTurnToolPolicyGuard;
  readonly finalizeToolResultForHistory?: LocalToolResultHistoryFinalizer;
  /** mcode:llm observers (request/first token/completion); logging-only. */
  readonly llmObservation?: TurnLlmCallObservation;
}

export interface LocalTurnExecutionPreparation<TContext extends ToolExecutionContext> {
  readonly initialBatchMessages?: readonly UserMessageInput[];
  readonly initialBatchGenuineUserQueryTexts?: readonly string[];
  readonly promptText?: string;
  readonly genuineUserQueryText?: string;
  readonly userMessage: Readonly<Omit<UserMessageInput, 'text'>>;
  readonly caller: RunTurnCaller;
  readonly reminderBlocks: readonly string[];
  readonly loadBackgroundReminder: () => Promise<BackgroundReminderFacts>;
  readonly systemReminderDiagnostic?: unknown;
  readonly prepareSteering?: (
    input: AgentHostSteeringMessage,
  ) => Promise<PreparedSteeringUserMessage>;
  readonly toolResolution: LocalTurnPermissionResolution<TContext>;
}

export interface PreparedSteeringUserMessage {
  readonly userMessage: UserMessageInput;
  readonly genuineUserQueryText: string;
}

export interface LocalTurnExecutionPreparationSource<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
> {
  prepare(input: {
    readonly execution: LocalTurnExecutionInput<TAgent>;
    readonly eventWriter: PiEventWriter;
  }): Promise<LocalTurnExecutionPreparation<TContext>>;
}

export interface LocalTurnFileChangeLifecycle {
  begin(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentName: string;
    readonly workspaceDir: string;
  }): Promise<void>;
  finalize(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly assistantMessageId?: string;
  }): Promise<AgentHostFileChangeObservation | undefined>;
  markFailed(input: { readonly sessionId: string; readonly turnId: string }): Promise<void>;
  /** Optional during migration; reads only active-Turn memory and performs no I/O. */
  takeToolProgress?(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolCallIds: readonly string[];
  }): readonly AgentHostToolProgressObservation[];
}

/** Product-owned Background reminder projection injected into AgentHost execution. */
export interface BackgroundCadenceReminder {
  prepare(input: {
    readonly hookInput: PiBeforeLlmCallHookInput;
    readonly loadFacts: () => Promise<BackgroundReminderFacts>;
    readonly hasSuccessfulTaskOutputRead: () => boolean;
    readonly readTaskIds?: () => ReadonlySet<string>;
  }): Promise<{
    readonly beforeUserMessages: NonNullable<RunTurnInput['beforeUserMessages']>;
    readonly hook: PiBeforeLlmCallHook;
  }>;
}

export type ExecutionBudgetReminderAdmission = (
  input: PiBeforeLlmCallHookInput,
  marker: PiBeforeLlmCallHookInput['messages'][number],
) => boolean;

export interface LocalRuntimeTurnExecutorOptions<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
> {
  readonly runtime: LocalRuntimeTurnRunnerPort<TContext>;
  /** The suggestion port is host-owned; the executor only forwards the relay to it. */
  readonly promptSuggestion?: PromptSuggestionTurnPort;
  readonly backgroundCadenceReminder?: BackgroundCadenceReminder;
  readonly canAppendExecutionBudgetReminder?: ExecutionBudgetReminderAdmission;
  /** Exact child Turn scope; notifications join this Turn and never independently reactivate it. */
  readonly createChildBashLifecycle?: (input: {
    readonly session: SessionRecord;
    readonly turnId: string;
    readonly signal: AbortSignal;
  }) =>
    | {
        hasPending(): Promise<boolean>;
        poll(input: {
          readonly wait: boolean;
          readonly readTaskIds: ReadonlySet<string>;
          readonly steeringSignal?: AbortSignal;
        }): Promise<string | undefined>;
        close(): Promise<void>;
      }
    | undefined;
  readonly executionPreparation: LocalTurnExecutionPreparationSource<TAgent, TContext>;
  readonly fileChanges: LocalTurnFileChangeLifecycle;
  readonly nowMs?: () => number;
  readonly attemptRecall: {
    recallAssistantAttempt(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly attempt: number;
      readonly messageIds: readonly string[];
    }): Promise<void>;
  };
  /** Shared command-line product policy selected by CLI and TUI compositions. */
  readonly cliProductPolicy?: boolean;
  /** Immutable policy selected only by the new TUI Runtime composition. */
  readonly tuiProductPolicy?: boolean;
  /** TUI-only region policy: only CN TUI hosts review MiniMax-managed turns. */
  readonly contentReviewEnabled?: boolean;
  readonly disableTools?: boolean;
  /**
   * SE-SW-002 checkpoint policy: the durability barrier composed around a
   * durable storage worker. When present, every provider request is preceded
   * by a fail-closed flush (`beforeLlmRequest`) and every tool effect of the
   * turn runs under the barrier (`runToolEffect`): an interrupted call is
   * recorded as `TOOL_OUTCOME_UNKNOWN` and never re-run implicitly.
   * Compositions without a durable storage worker omit it; the turn path
   * behaves exactly as before.
   */
  readonly checkpointBarrier?: CheckpointBarrier;
  /**
   * Ш3 durable mode: the canonical history provider hands the turn path
   * ownership-transferred snapshots (`withSnapshotTransform`) that are already
   * validated and Pi-compatible, so the turn consumes them directly instead of
   * re-validating and copying every message on every turn. Absent (default):
   * the legacy per-turn copy path stays exact.
   */
  readonly piCompatibleHistorySnapshots?: boolean;
  /**
   * Ш4 context-wire: the composition-owned memoized payload-assembly bridge
   * over the canonical history (`createTurnContextWire`, composed only when
   * `MCODE_CONTEXT_WIRE=1`). Present, the executor seeds and feeds it from
   * the canonical history commits and hands the runner input a per-session
   * `ContextWireProjection`; the provider payload is then compiled by the
   * wire pipeline instead of the legacy per-request conversion. Absent
   * (default): the turn path behaves exactly as before.
   */
  readonly contextWire?: TurnContextWire;
  /**
   * В1 (opus-decisions-20261101): the overflow-recovery factory for the
   * llm-retry seam (`RunTurnInput.llmRetry.contextOverflowRecovery`). Built
   * over the unified compaction seam + the wire handle by the composition;
   * the executor resolves it per turn alongside the base `resolveLlmRetry`
   * options. `undefined` (jsonl mode, or no unified seam): the executor
   * attaches nothing and the turn path behaves exactly as before.
   */
  readonly contextOverflowRecoveryFor?: (input: {
    readonly sessionId: string;
    readonly signal?: AbortSignal;
  }) => LLMContextOverflowRecovery | undefined;
  /**
   * Reactive subagents §1.7 (wave 3): the accepted-owner-input generation
   * probe factory for the pin's sequential-executor yield seam. Resolved per
   * turn over the steering composition's native wait binding; `undefined`
   * (jsonl mode, embeddings, no native binding) attaches nothing and the
   * batch behavior stays exactly as before.
   */
  readonly resolveOwnerInputGeneration?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => (() => number | Promise<number>) | undefined;
  /**
   * Explicit recovery decision of the checkpoint policy: allows re-running a
   * tool call whose earlier recorded outcome was `TOOL_OUTCOME_UNKNOWN`.
   * Default: forbidden — the previous attempt may have taken effect already.
   */
  readonly checkpointAllowAfterUnknownOutcome?: boolean;
  /** Creates isolated safety state once for each admitted product Turn. */
  readonly createTurnToolSafetyGuard?: () => LocalTurnToolSafetyGuard;
  readonly toolPolicyGuard?: LocalTurnToolPolicyGuard;
  readonly finalizeToolResultForHistory?: LocalToolResultHistoryFinalizer;
  /** Host budget bound to this turn's provider requests; absent for ordinary turns. */
  readonly outputTokenCap?: LocalTurnOutputTokenCapResolver;
  readonly reportFailure?: (sessionId: string, message: string) => void;
  readonly logger?: Pick<PiTurnRunnerLogger, 'info'>;
  readonly projectRuntimeEvent?: RuntimeEventProjector;
  readonly fileApi?: {
    readonly uploadStores: FileApiUploadStoreSource;
    readonly fetchImpl?: typeof fetch;
    readonly logger?: MessagesFileApiPatcherLogger;
  };
  readonly resolveBeforeLlmCallHooks?: (
    input: LocalTurnExecutionInput<TAgent>,
  ) => Promise<readonly PiBeforeLlmCallHook[]>;
  /** Fixed host hooks that must observe the post-compaction request history. */
  readonly afterCompactionBeforeLlmCallHooks?: readonly PiBeforeLlmCallHook[];
  readonly captureToolTiming?: (input: LocalTurnExecutionInput<TAgent>) => boolean;
  /** Resolves host-owned, non-secret Hook protocol metadata for one Session snapshot. */
  readonly resolvePluginHookRuntimeContext?: (session: SessionRecord) => {
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly permissionMode?: string;
  };
  /** Clears Hook-added Session permission state after logical SessionEnd completes. */
  readonly clearPluginHookSessionPermissions?: (sessionId: string) => Promise<void>;
  /** Prepares durable ownership only after normal Turn preparation reaches Hook admission. */
  readonly preparePluginHookSessionOwnership?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly ownershipClaimId: string;
  }) => Promise<void>;
  /** Activates ownership after the process-local Hook coordinator is bound. */
  readonly activatePluginHookSessionOwnership?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly ownershipClaimId: string;
  }) => Promise<void>;
  readonly onSteeringConsumed?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
  }) => void | Promise<void>;
  readonly onInputReviewResolved?: InputReviewResolvedObserver;
  readonly resolveLlmRetry?: (
    input: LocalTurnExecutionInput<TAgent>,
  ) => Promise<NonNullable<RunTurnInput['llmRetry']>> | NonNullable<RunTurnInput['llmRetry']>;
}
