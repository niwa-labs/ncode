import { randomUUID as compactionProgressId } from 'node:crypto';
import { join as joinContextPath } from 'node:path';
import { ContextOperationStore } from './compaction/context-operation-store.js';
import { createProductionRunawayGuardExtension } from './runaway-guard/extension.js';
// pi 48c8f322: `streamSimple` lives in the pi-ai `./compat` entry; streamFns
// take the normalized TranscriptContext (system prompt folded into the leading
// system message).
import {
  normalizeContext,
  streamSimple,
  type Api,
  type Context,
  type Model,
  type Tool,
} from '@earendil-works/pi-ai/compat';
import type {
  AgentExtension,
  InternalTurnPromptReadRegistry,
  PromptSnapshotSource,
} from '@mavis/agent-runtime';
import {
  sessionReportExtension,
  terminalResponseRecoveryExtension,
  toolOutputBudgetExtension,
  type ToolOutputArtifact,
  type ToolOutputArtifactInput,
} from '@mavis/agent-extension';
import type { LLMRetryOptions } from '@mavis/agent-core/pi-turn-runner';
import { describeLocalBrowserToolInput } from '@mavis/agent-tools/desktop';
import type { IAgentConfig } from '@mavis/protocol';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import {
  TOOL_RESULT_COMPACTION_DEFAULTS,
  noBuiltinToolsFromEnv,
  parseToolResultCompactionConfig,
  type ResolvedAgentCapabilities,
  type RunawayGuardOverride,
} from '@mavis/config';
import { isValidCompactionTriggerSetting } from '@mavis/context-manager';
import { createLogger } from '@mavis/logging';
import { openCas, parseCasSpillRef, type CasStore } from '@mavis/cas';
import { createCasToolOutputSpill } from '@mavis/agent-tools/truncation/cas-spill';
import { readProfileEnv, resolveDurableRoot } from '@mavis/config';
import type { AppDb } from '../../infra/db/client.js';

import type { ContentSafetyService } from '../content-safety/index.js';
import {
  ArchiveTitleModelAdapter,
  SessionTitleModelAdapter,
  type RootArchiveTitleModel,
  type SessionRecord,
  type SessionTitleModel,
  type SessionSystemOwner,
  resolveSessionHistoryPaths,
} from '../session-system/index.js';
import { isPeekSession } from '../session-system/sessions/repo/normalization.js';
import {
  createNativeAgentHostProductionDependencies,
  createNativeLocalAgentPreparation,
  LocalAgentHost,
  type AgentEventBestEffortObserver,
  type AgentExecutionSource,
  type AgentHostRuntimeLifecycle,
  type AgentHostAssemblyObserver,
  type AgentHostTurnCapabilityLifecycle,
  type AgentHostTurnCapabilityView,
  type CanonicalHistoryChange,
  type LocalAgentTurnRunnerOptions,
  type LocalRuntimeTurnExecutorOptions,
  type LocalRuntimeTurnToolContext,
  type LocalTurnOutputTokenCapResolver,
  type LocalTurnToolPolicyGuard,
  type LocalTurnRawToolSources,
  type LocalTurnInputPreparerOptions,
  type LocalTurnPermissionGateOptions,
  type LocalAgentPreparationService,
  type NativeAgentPreparationOptions,
  type NativeLocalAgentPreparationOptions,
} from './agent-host/index.js';
import type { AgentExecutionSnapshot, AgentHost, AgentHostDependencies } from './agent-host/contracts.js';
import type { SessionCacheWarming } from './agent-host/runner/index.js';
import { resolveExecutorCheckpointBarrier } from './agent-host/execution/turn-checkpoint-policy.js';
import { createLlmContextOverflowRecovery } from './agent-host/execution/llm-overflow-recovery.js';
import type { StorageWorker } from '@mavis/storage-worker';
import type { CanonicalHistoryCompactionChange } from './agent-host/history/contracts.js';
import type { DurableCanonicalHistoryProvider } from './agent-host/history/durable-canonical-history-store.js';
import { captureSemanticSnapshot } from './agent-host/history/semantic-identity.js';
import { validateCanonicalHistoryMessages } from './agent-host/history/canonical-history-validation.js';
import type { TurnSystemHostCapabilities } from './contracts.js';
import type {
  RequiredAgentEventProjector,
  RequiredAgentRuntimeProjector,
} from './agent-host/events/required-agent-event-delivery.js';
import { readCompactionCommitMetadata } from './agent-host/compaction/context-compaction.js';
import {
  createTurnContextWire,
  resolveContextWireEnabled,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type TurnContextWire,
} from './compaction/context-wire.js';
// Wave-0 item 0.5: the current-turn image residency overlay (wire mode).
import { TurnImageResidency } from './compaction/turn-image-residency.js';
import { LocalContextCompactor } from './compaction/local-context-compactor.js';
import {
  AutomaticContextCompactor,
  createAutomaticContextRequestFilterHook,
  type AutomaticByteTrigger,
} from './compaction/automatic-context-compactor.js';
import {
  createProductUnifiedCompaction,
  type ProductUnifiedCompaction,
} from './compaction/product-unified-compaction.js';
import type {
  ToolResultCompactionConfig,
  SubagentCheckpointStateSource,
} from './compaction/contracts.js';
import { ContextUsageAnchorState } from './compaction/execution/usage-anchor.js';
import { ToolResultArchiver } from './compaction/algorithm/tool-result-archiver.js';
// Wave 2 (canon 05 §2.2/§2.5): the tool-result TEXT offload axis (the legacy
// tool_archive compaction demoted to an offload pass) and the image artifact
// store handle the residency resolves offloaded bytes from.
import { createToolResultTextOffloader } from './compaction/tool-result-text-offloader.js';
import {
  ImageArtifactStore,
  resolveArtifactsDir,
} from '../session-system/messages/history/image-artifact-store.js';
import { createFileApiUploadStoreSource } from './persistence/file-api-upload.repository.js';
import { ToolOutputArtifactRepository } from './persistence/tool-output-artifact.repository.js';
import type { MessagesFileApiPatcherLogger } from './agent-host/assembly/messages-file-api-patcher.js';
import { isProductionRuntimeErrorRetryable } from './runtime-error-retry-policy.js';
import { createTodoCadenceReminderHook } from './execution/reminder/todo-cadence-reminder.js';
import { createBackgroundCadenceReminder } from './execution/reminder/background-cadence-reminder.js';
import { createSessionIdentityReminderHook } from './execution/reminder/session-identity-reminder.js';
import { createCompactionContinuationReminderHook } from './execution/reminder/compaction-continuation-reminder.js';
import { fitsReminderInFinalRequest } from './execution/reminder/reminder-admission.js';
import { readSessionAgentExecutionSnapshot } from './agent-host/preparation/session-agent-execution-snapshot.js';
import { McpToolResultHistoryExternalizer } from './agent-host/execution/mcp-tool-result-history-externalizer.js';
import { createBrowserHostCapabilityAdapter } from './agent-host/assembly/host-capability/browser.js';
import { HostCapabilityRegistry } from './agent-host/assembly/host-capability/registry.js';

export interface ProductionAgentProductCapabilities<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly agents: AgentExecutionSource<TAgent>;
  /** Optional encrypted template reader shared with AgentHost's per-turn assembly. */
  readonly promptSnapshots?: PromptSnapshotSource;
  readonly internalTurnPromptReads?: Pick<InternalTurnPromptReadRegistry, 'take'>;
  readonly capabilities?: {
    resolve(agentName: string): Promise<ResolvedAgentCapabilities>;
  };
  readonly preparation: NativeAgentPreparationOptions;
  readonly turnRuntimeFacts: {
    snapshot(): {
      readonly cuModeActive: boolean;
    };
  };
  readonly checkpointState: SubagentCheckpointStateSource;
  readonly toolSources: {
    resolve(input: {
      readonly session: SessionRecord;
      readonly turnId: string;
      readonly resourceAgentName: string;
      readonly builtinCapabilities?: ResolvedAgentCapabilities;
      readonly toolsDisabled: boolean;
      /** External-tools-only mode: native sources off, configured MCP only. */
      readonly noBuiltinTools?: boolean;
      readonly cuModeActive: boolean;
      readonly excludeAgentResources?: boolean;
      readonly skipAgentResolution?: boolean;
      readonly expectedAgentInstanceId?: string;
      readonly agentMemoryEnabled?: boolean;
      readonly agentMemoryReadNames?: readonly string[];
      readonly allowedSkillNames?: readonly string[];
      readonly allowedExtensionSkillNames?: readonly string[];
      readonly miniappAvailable?: boolean;
      readonly desktopCapabilities?: AgentHostTurnCapabilityView;
    }): Promise<LocalTurnRawToolSources>;
  };
  readonly inputPreparation: LocalTurnInputPreparerOptions;
  readonly terminalMemory: {
    record(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly agentName: string;
      readonly status: 'finished' | 'error' | 'aborted' | 'interrupted';
      readonly errorMessage?: string;
    }): Promise<unknown>;
  };
  readonly permission: LocalTurnPermissionGateOptions;
  readonly runner: Omit<LocalAgentTurnRunnerOptions, 'reviewContent'>;
  readonly executor: Omit<
    LocalRuntimeTurnExecutorOptions<TAgent, LocalRuntimeTurnToolContext>,
    | 'runtime'
    | 'executionPreparation'
    | 'attemptRecall'
    | 'onSteeringConsumed'
    | 'fileApi'
    | 'cliProductPolicy'
    | 'tuiProductPolicy'
    | 'contentReviewEnabled'
    | 'backgroundCadenceReminder'
    | 'canAppendExecutionBudgetReminder'
    | 'afterCompactionBeforeLlmCallHooks'
  >;
  readonly fileApi?: {
    readonly fetchImpl?: typeof fetch;
    readonly logger?: MessagesFileApiPatcherLogger;
  };
  /** Optional product-domain observer fed only immutable v2 Turn facts. */
  readonly eventObserver?: AgentEventBestEffortObserver;
  /** Required post-settlement product participant; failures remain visible to TurnSystem. */
  readonly turnSettlement?: RequiredAgentTurnSettlement;
  readonly normalExtensions?: readonly AgentExtension[];
  /** SE-SW-002: the durable storage worker for the fail-closed checkpoint barrier. */
  readonly checkpointStorageWorker?: StorageWorker;
}

interface RequiredAgentTurnSettlement {
  settle(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly status: 'completed' | 'failed' | 'aborted';
  }): Promise<void>;
  /** Called once TurnSystem has exhausted its settle retries for this Turn. */
  abandon?(input: { readonly sessionId: string; readonly turnId: string }): Promise<void>;
}

export type ProductionAgentPreparation = Pick<
  LocalAgentPreparationService,
  | 'prepare'
  | 'prepareCompaction'
  | 'buildAgentConfig'
  | 'resolveModel'
  | 'bindSessionModelRepair'
  | 'bindTaskSessionBindings'
>;

export interface ProductionSessionTitleProductCapabilities<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly agents: AgentExecutionSource<TAgent>;
  readonly preparation: ProductionAgentPreparation;
}

export interface CreateLocalAgentHostOptions<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly product: ProductionAgentProductCapabilities<TAgent>;
  readonly db: AppDb;
  readonly preparation: ProductionAgentPreparation;
  readonly sessions: SessionSystemOwner;
  readonly safety: Pick<ContentSafetyService, 'review'>;
  readonly turnControl: TurnSystemHostCapabilities['turnControl'];
  readonly turnFacts: RequiredAgentEventProjector;
  readonly publishCompactionProgress?: (event: GlobalEventInput<'session.compaction.progress'>) => void;
  readonly pluginHookSessionOwnership: TurnSystemHostCapabilities['pluginHookSessionOwnership'];
  readonly toolPolicyGuard?: LocalTurnToolPolicyGuard;
  /** Binds the Goal verifier child's opt-in attempt cap to its provider requests. */
  readonly outputTokenCap?: LocalTurnOutputTokenCapResolver;
  readonly normalExtensions?: readonly AgentExtension[];
  readonly eventObserver?: AgentEventBestEffortObserver;
  readonly contextUsageProjection?: RequiredAgentRuntimeProjector;
  readonly assemblyObserver?: AgentHostAssemblyObserver;
  readonly onSteeringConsumed: NonNullable<
    LocalRuntimeTurnExecutorOptions<TAgent, LocalRuntimeTurnToolContext>['onSteeringConsumed']
  >;
  readonly onInputReviewResolved: NonNullable<
    LocalRuntimeTurnExecutorOptions<TAgent, LocalRuntimeTurnToolContext>['onInputReviewResolved']
  >;
  readonly resolveLlmRetry?: LocalRuntimeTurnExecutorOptions<
    TAgent,
    LocalRuntimeTurnToolContext
  >['resolveLlmRetry'];
  /**
   * Reactive subagents §1.7 (wave 3): the accepted-owner-input generation
   * probe factory wired from the durable steering composition's native wait
   * binding. Absent (jsonl, embeddings): nothing attaches and the sequential
   * batch behaves exactly as before.
   */
  readonly resolveOwnerInputGeneration?: LocalRuntimeTurnExecutorOptions<
    TAgent,
    LocalRuntimeTurnToolContext
  >['resolveOwnerInputGeneration'];
  readonly nowMs?: () => number;
  readonly turnCapabilities?: AgentHostTurnCapabilityLifecycle;
  /** Optional next-message suggestion port; composition forwards it verbatim. */
  readonly promptSuggestion?: AgentHostDependencies['promptSuggestion'];
  readonly cliProductPolicy?: boolean;
  readonly tuiProductPolicy?: boolean;
  readonly contentReviewEnabled?: boolean;
  readonly getRunawayGuardConfig?: () => RunawayGuardOverride | undefined;
  readonly getToolResultCompactionConfig?: () => ToolResultCompactionConfig | undefined;
  /** SE-SW-002: the durable storage worker for the fail-closed checkpoint barrier. */
  readonly checkpointStorageWorker?: StorageWorker;
  /**
   * W06 cache warming: the session-warming controller composed into the
   * runner's MAIN stream path. Absent — no wrapper, legacy composition.
   */
  readonly cacheWarming?: SessionCacheWarming;
}

export interface LocalAgentHostComposition {
  readonly host: AgentHost;
  readonly lifecycle: AgentHostRuntimeLifecycle;
}

/** Creates the one process-local AgentConfig/model preparation shared by title and AgentHost. */
export function createProductionAgentPreparation(
  options: NativeLocalAgentPreparationOptions,
): ProductionAgentPreparation {
  return createNativeLocalAgentPreparation(options);
}

/** Uses the same product Agent/config/model resolution as normal native AgentHost turns. */
export function createProductionSessionTitleModel<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(
  product: ProductionSessionTitleProductCapabilities<TAgent>,
  nowMs?: () => number,
): SessionTitleModel {
  const { preparation } = product;
  return new SessionTitleModelAdapter<IAgentConfig, Model<Api>>({
    buildAgentConfig: async (session) => {
      const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
      if (!agent) throw new Error(`Session title Agent not found: ${session.agentName}`);
      return preparation.buildAgentConfig({
        session,
        agent,
        isSessionFirstTurn: true,
      });
    },
    resolveModel: async (input) => {
      const resolved = await preparation.resolveModel(input);
      const resolvedStream = resolved.streamFn;
      return {
        model: resolved.model,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
        ...(resolvedStream
          ? {
              stream: (model, context, options) =>
                resolvedStream(model, normalizeContext(mutableTitleContext(context)), options),
            }
          : {}),
      };
    },
    stream: (model, context, options) =>
      streamSimple(model, mutableTitleContext(context), options),
    ...(nowMs ? { nowMs } : {}),
  });
}

/** Reuses the native Agent/model preparation and product safety checker for archived Root titles. */
export function createProductionRootArchiveTitleModel<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(
  product: ProductionSessionTitleProductCapabilities<TAgent> & {
    readonly safety: Pick<ContentSafetyService, 'review'>;
  },
  nowMs?: () => number,
): RootArchiveTitleModel {
  const { preparation } = product;
  return new ArchiveTitleModelAdapter<IAgentConfig, Model<Api>>({
    buildAgentConfig: async (session) => {
      const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
      if (!agent) throw new Error(`Archive title Agent not found: ${session.agentName}`);
      return preparation.buildAgentConfig({
        session,
        agent,
        isSessionFirstTurn: false,
      });
    },
    resolveModel: async (input) => {
      const resolved = await preparation.resolveModel(input);
      const resolvedStream = resolved.streamFn;
      return {
        model: resolved.model,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
        ...(resolvedStream
          ? {
              stream: (model, context, options) =>
                resolvedStream(model, normalizeContext(mutableTitleContext(context)), options),
            }
          : {}),
      };
    },
    review: product.safety.review,
    stream: (model, context, options) =>
      streamSimple(model, mutableTitleContext(context), options),
    ...(nowMs ? { nowMs } : {}),
  });
}

/** Desktop Peek adds mutation approval; BTW shares the ordinary runtime permission policy. */
function createHostPermissionPolicy<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
) {
  return {
    ...options.product.permission,
    sideSessions: {
      isSideSession: async (sessionId: string) => {
        const session = await options.sessions.sessions.execution.getExecutionSnapshot(sessionId);
        return session ? session.purpose !== 'peek_btw_session' && isPeekSession(session) : false;
      },
    },
  };
}

/** Connects the native v2 AgentHost only to injected product, owner and observer ports. */
export async function createLocalAgentHost<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(options: CreateLocalAgentHostOptions<TAgent>): Promise<LocalAgentHostComposition> {
  const eventObserver = combineAgentEventObservers(
    options.product.eventObserver,
    options.eventObserver,
  );
  const contextUsageAnchor = new ContextUsageAnchorState();
  const toolOutputArtifacts = createToolOutputArtifactRepository(options);
  const getToolResultCompactionConfig = createToolResultCompactionConfigGetter(options);
  const toolResultArchiver = new ToolResultArchiver({
    writeArtifact: (input) => toolOutputArtifacts.write(input),
    logger: options.product.runner.logger,
    getConfig: getToolResultCompactionConfig,
  });
  const mcpToolResultHistoryExternalizer = createMcpToolResultHistoryExternalizer(
    options,
    toolOutputArtifacts,
    getToolResultCompactionConfig,
  );
  const normalExtensions = createHostNormalExtensions(
    options,
    toolOutputArtifacts,
    getToolResultCompactionConfig,
  );
  // SE-SW-002: the fail-closed durability barrier of the turn path — composed
  // around the storage worker this composition runs against; an explicitly
  // composed barrier on the executor options wins. Without either, the turn
  // path behaves exactly as before (the policy stays dormant).
  const checkpointBarrier = resolveExecutorCheckpointBarrier(
    options.product.executor.checkpointBarrier,
    options.checkpointStorageWorker,
  );
  // Ш4/W10: the memoized context-wire payload assembly (ContextWirePipeline
  // over the wave-2 context packages), fed from the canonical history commits
  // and read at the runner's `convertToLlm` seam. The gate follows the
  // canonical-history mode (resolveContextWireEnabled): DURABLE (the W10
  // default) composes it ON — the wire pipeline is the default projection
  // path; the explicit jsonl compatibility mode keeps it OFF and the turn
  // path stays on the legacy per-request conversion exactly.
  const contextWireEnabled = resolveContextWireEnabled();
  // W10 unified compaction (review w10-review-p1 item 2; W05 «Product
  // switch = W10»): composed only in wire mode — the W05 APIs
  // (resolveCompactionSettings/resolveCompactionBudgets/createModelSummarizer)
  // reach the product seam through `compactionFor`, with per-session budgets
  // from the turn's resolved model and checkpoints committed back through
  // the canonical `compact` seam. jsonl composes none of it.
  const unifiedCompaction = contextWireEnabled
    ? createProductUnifiedCompaction({
        requestFork: true,
        onProgress: (sessionId, stage) => options.publishCompactionProgress?.({
          type: 'session.compaction.progress', payload: { sessionId, stage, progressId: compactionProgressId() },
        }),
        operations: new ContextOperationStore(joinContextPath(options.product.preparation.configBuilder.config().dataDir, 'context-operations')),
        sessions: {
          get: (sessionId) => options.sessions.sessions.repository.get(sessionId),
        },
        agents: options.product.agents,
        preparation: options.preparation,
        canonicalHistory: options.sessions.canonicalHistory,
      })
    : undefined;
  // Fixed one-turn image residency (owner decision 2026-11-08): batch
  // eviction on the turn boundary, the token budget, and the artifact store
  // resolving an OFFLOADED image's bytes back out of
  // `<dataDir>/artifacts/<sha256>.<ext>` (the durable log stores references;
  // the store instance here is a second handle on the same content-addressed
  // directory the canonical-history provider offloads into — file names are
  // content addresses, so the handles agree by construction).
  const turnImageResidency = contextWireEnabled
    ? new TurnImageResidency(undefined, {
        artifacts: new ImageArtifactStore({
          artifactsDir: resolveArtifactsDir(
            options.product.preparation.configBuilder.config().dataDir,
          ),
        }),
      })
    : undefined;
  const contextWire: TurnContextWire | undefined = contextWireEnabled
    ? feedUnifiedCompactionLog(
        createTurnContextWire({
          ...(turnImageResidency ? { residency: turnImageResidency } : {}),
          ...(unifiedCompaction ? { compactionFor: unifiedCompaction.compactionFor } : {}),
        }),
        unifiedCompaction,
      )
    : undefined;
  // The adapted canonical-history seam, hoisted so the compaction deps'
  // TEXT-offload axis (wave 2, item 2.4) reads and offloads through the SAME
  // validated provider view the turn path commits through.
  const adaptedCanonicalHistory = adaptCanonicalHistory(
    options.sessions.canonicalHistory,
    options.sessions.sessions.historyMutation,
  );
  const dependencies = await createNativeAgentHostProductionDependencies({
    sessions: {
      get: (sessionId) => options.sessions.sessions.execution.getExecutionSnapshot(sessionId),
    },
    planDocuments: options.sessions.planDocuments,
    agents: options.product.agents,
    ...optionalPromptReadDependencies(options.product),
    turnRuntimeFacts: options.product.turnRuntimeFacts,
    preparation: options.preparation,
    toolCatalog: {
      ...optionalDesktopHostCapabilities(options.cliProductPolicy),
      // K2: the run_code gate reads the conversation beta per catalog build,
      // the same fact the profile render turns into the prompt section.
      beta: () => options.product.preparation.configBuilder.config().beta,
      resolveSources: async (input) => {
        const session = await requireExecutionSession(options.sessions, input);
        return options.product.toolSources.resolve({
          session,
          turnId: input.turnId,
          resourceAgentName: input.resourceAgentName,
          ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
          ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
          ...(input.expectedAgentInstanceId
            ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
            : {}),
          ...(input.builtinCapabilities ? { builtinCapabilities: input.builtinCapabilities } : {}),
          toolsDisabled: process.env.MAVIS_LOCAL_RUNTIME_DISABLE_TOOLS === '1',
          noBuiltinTools: noBuiltinToolsFromEnv(process.env),
          cuModeActive: input.cuModeActive,
          ...(input.agentMemoryEnabled === undefined
            ? {}
            : { agentMemoryEnabled: input.agentMemoryEnabled }),
          ...(input.agentMemoryReadNames === undefined
            ? {}
            : { agentMemoryReadNames: input.agentMemoryReadNames }),
          ...(input.allowedSkillNames === undefined
            ? {}
            : { allowedSkillNames: input.allowedSkillNames }),
          ...(input.allowedExtensionSkillNames === undefined
            ? {}
            : { allowedExtensionSkillNames: input.allowedExtensionSkillNames }),
          ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        });
      },
      config: options.product.preparation.configBuilder.config().mcpToolSearch,
      env: process.env,
    },
    inputPreparation: options.product.inputPreparation,
    permission: createHostPermissionPolicy(options),
    runner: {
      ...options.product.runner,
      reviewContent: options.safety.review,
      ...(options.cacheWarming ? { cacheWarming: options.cacheWarming } : {}),
    },
    ...optionalToolPolicyGuard(options.toolPolicyGuard),
    executor: {
      ...options.product.executor,
      // SE-SW-002: durability is confirmed BEFORE every provider request
      // (`beforeLlmRequest`, first-position hook) and BEFORE every tool
      // effect (`runToolEffect`); interrupted calls resolve to
      // TOOL_OUTCOME_UNKNOWN and are never re-run implicitly.
      ...(checkpointBarrier ? { checkpointBarrier } : {}),
      // Ш3: the storage worker is injected exactly in durable mode, where the
      // canonical history provider serves ownership-transferred snapshots —
      // the turn path may then skip its per-turn Pi-compatibility copy.
      ...(options.checkpointStorageWorker ? { piCompatibleHistorySnapshots: true } : {}),
      // Ш4: the context-wire bridge — present only when the env gate
      // composed it; the executor then seeds and feeds it from the canonical
      // history commits of each turn.
      ...(contextWire ? { contextWire } : {}),
      logger: options.product.runner.logger,
      backgroundCadenceReminder: createBackgroundCadenceReminder(contextUsageAnchor),
      canAppendExecutionBudgetReminder: (input, marker) =>
        fitsReminderInFinalRequest(input, marker, contextUsageAnchor),
      fileApi: {
        uploadStores: createFileApiUploadStoreSource({
          db: options.db,
          ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        }),
        ...(options.product.fileApi?.fetchImpl
          ? { fetchImpl: options.product.fileApi.fetchImpl }
          : {}),
        ...(options.product.fileApi?.logger ? { logger: options.product.fileApi.logger } : {}),
      },
      attemptRecall: options.sessions.agentProjection.attemptRecall,
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
      cliProductPolicy: options.cliProductPolicy,
      tuiProductPolicy: options.tuiProductPolicy,
      contentReviewEnabled: options.contentReviewEnabled,
      finalizeToolResultForHistory: mcpToolResultHistoryExternalizer.finalize,
      resolvePluginHookRuntimeContext: (session) => {
        const config = options.product.preparation.configBuilder.config();
        return {
          transcriptPath: resolveSessionHistoryPaths(config.dataDir, session).messages,
          permissionMode: config.permissionMode,
        };
      },
      preparePluginHookSessionOwnership: options.pluginHookSessionOwnership.prepare,
      activatePluginHookSessionOwnership: options.pluginHookSessionOwnership.activate,
      afterCompactionBeforeLlmCallHooks: [
        createAutomaticContextRequestFilterHook(),
        createSessionIdentityReminderHook(contextUsageAnchor),
        createTodoCadenceReminderHook(contextUsageAnchor),
        // Wave 3 (item 3.5, canon 05 §2.4): the continuation reminder —
        // exactly one per compaction.id, delivered after the compaction
        // hook's cut reached the canonical history.
        createCompactionContinuationReminderHook(),
      ],
      onSteeringConsumed: options.onSteeringConsumed,
      onInputReviewResolved: options.onInputReviewResolved,
      resolveLlmRetry: options.resolveLlmRetry,
      // Reactive subagents §1.7 (wave 3): the yield-to-owner-input probe of
      // the sequential executor, resolved per turn from the native wait
      // binding. jsonl/embeddings compositions omit it.
      ...(options.resolveOwnerInputGeneration
        ? { resolveOwnerInputGeneration: options.resolveOwnerInputGeneration }
        : {}),
      // В1 (opus-decisions-20261101): the overflow half of the llm-retry
      // seam — runWithOverflowRecovery composed over the unified scheduler
      // (compact → replaceMessages) + the wire reseed (fact 1: the
      // scheduler's own commit never folds into THIS turn's pipeline), so
      // the ONE retried request compiles the cut window, and the failed
      // attempt's omission rides the unified log on the second failure.
      // jsonl composes none of it: the legacy turn path stays exact.
      ...(unifiedCompaction && contextWire
        ? {
            contextOverflowRecoveryFor: ({
              sessionId,
              signal,
            }: {
              sessionId: string;
              signal?: AbortSignal;
            }) =>
              createLlmContextOverflowRecovery({
                sessionId,
                ...(signal ? { signal } : {}),
                barrier: () => contextWire.compactionBarrier(sessionId),
                reseed: (messages) => contextWire.reseed(sessionId, messages),
                resolveFailedAttemptEntryIds: (id) =>
                  unifiedCompaction.resolveFailedAttemptEntryIds(id),
                appendOmissionDraft: (id, draft) =>
                  unifiedCompaction.appendOmissionDraft(id, draft),
              }),
          }
        : {}),
      ...(options.outputTokenCap ? { outputTokenCap: options.outputTokenCap } : {}),
    },
    ...optionalNormalExtensions(normalExtensions),
    turnControl: options.turnControl,
    ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
    ...(options.assemblyObserver ? { assemblyObserver: options.assemblyObserver } : {}),
    ...(options.promptSuggestion ? { promptSuggestion: options.promptSuggestion } : {}),
    canonicalHistory: adaptedCanonicalHistory,
    compaction: {
      // Wave 2 (canon 05 §2.2: "Legacy-компактор в wire-режиме удаляется
      // полностью"): wire mode composes NO legacy compactor — no
      // AutomaticContextCompactor probe (the unified scheduler owns the
      // context triggers), no LocalContextCompactor manual path (the manual
      // /compact routes through the unified barrier), and the tool axis is
      // the TEXT offload pass below — offload events, never the whole-history
      // rewrite. The jsonl compatibility composition keeps the exact legacy
      // semantics (both compactors, no barrier, no offload).
      ...(contextWire
        ? {}
        : createContextCompactors({
            contextUsageAnchor,
            checkpointState: options.product.checkpointState,
            logger: options.product.runner.logger,
            toolResultArchiver,
            promptSnapshots: options.product.promptSnapshots,
            getCompactionTriggerAt: createCompactionTriggerAtGetter(options),
          })),
      control: options.turnControl,
      lifecycle: options.sessions.agentProjection.compactionLifecycle,
      observer: options.sessions.agentProjection.compactionObserver,
      ...(options.product.runner.metricsClient
        ? { metricsClient: options.product.runner.metricsClient }
        : {}),
      usageAnchor: contextUsageAnchor,
      // В1: the wire-mode admission point — the before-LLM compaction hook
      // awaits the unified scheduler's blocking compaction through it and
      // feeds the committed checkpoint back as its `replaceMessages`
      // decision (which reseeds the wire pipeline with the CUT window).
      // jsonl composes none of it.
      ...(contextWire
        ? {
            wireCompactionBarrier: (sessionId: string) => contextWire.compactionBarrier(sessionId),
            prepareManualWireCompaction: async (sessionId: string, turnId: string) => {
              const existing = contextWire.compactionBarrier(sessionId);
              if (existing) return existing;
              const session = await options.sessions.sessions.repository.get(sessionId);
              if (!session) throw new Error(`Compaction session not found: ${sessionId}`);
              const agent = await readSessionAgentExecutionSnapshot(options.product.agents, session);
              if (!agent) throw new Error(`Compaction Agent not found: ${session.agentName}`);
              const history = await adaptedCanonicalHistory.readActive(sessionId);
              const prepared = await options.preparation.prepareCompaction({
                session, agent, history, turnId,
              });
              const model = prepared.llm.model;
              contextWire.seed({
                sessionId,
                messages: history.messages,
                ...(Number.isFinite(model.contextWindow) && model.contextWindow > 0
                  ? { model: {
                      provider: model.provider,
                      modelId: model.id,
                      contextWindowTokens: model.contextWindow,
                      ...(model.maxTokens > 0 ? { maxOutputTokens: model.maxTokens } : {}),
                      ...(prepared.llm.thinkingLevel && prepared.llm.thinkingLevel !== 'off'
                        ? { thinkingLevel: prepared.llm.thinkingLevel } : {}),
                    } }
                  : {}),
              });
              return contextWire.compactionBarrier(sessionId);
            },
          }
        : {}),
      // Wave 2 (item 2.4): the tool-result TEXT offload axis — planned over
      // the canonical history by the SAME archiver, applied as `offload`
      // events through the durable provider's seam. Best-effort; the hook
      // catches and logs.
      ...(contextWire
        ? {
            toolResultOffload: (sessionId: string): Promise<void> =>
              createToolResultTextOffloader({
                archiver: toolResultArchiver,
                readActiveMessages: async (id) => {
                  const snapshot = await adaptedCanonicalHistory.readActive(id);
                  return snapshot.messages;
                },
                offloadToolText: adaptedCanonicalHistory.offloadToolText,
              })(sessionId).then(() => undefined),
          }
        : {}),
    },
    usage: {
      projector: options.sessions.usage.projector,
      onFailure: ({ sessionId, error }) => {
        options.product.executor.reportFailure?.(
          sessionId,
          `agent_usage_projection_failed:${describeError(error)}`,
        );
      },
    },
    events: {
      projectors: {
        session: options.sessions.agentProjection.session,
        messages: withContextUsageProjection(
          options.sessions.agentProjection.messages,
          options.contextUsageProjection,
        ),
        stream: options.sessions.agentProjection.stream,
        turnFacts: options.turnFacts,
      },
      historyFailures: options.sessions.agentProjection.historyFailures,
      ...(eventObserver ? { observer: eventObserver } : {}),
      onObservationFailure: ({ sessionId, error }) => {
        options.product.executor.reportFailure?.(
          sessionId,
          `agent_event_observation_failed:${describeError(error)}`,
        );
      },
    },
    isRuntimeErrorRetryable: isProductionRuntimeErrorRetryable,
  });
  return { host: new LocalAgentHost(dependencies), lifecycle: dependencies.lifecycle };
}

function createHostNormalExtensions<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
  toolOutputArtifacts: ToolOutputArtifactRepository,
  getToolResultCompactionConfig: () => ToolResultCompactionConfig,
): readonly AgentExtension[] | undefined {
  return mergeNormalExtensions(
    [
      sessionReportExtension({
        reports: options.sessions.llmCalls,
        reportFailure: options.product.executor.reportFailure,
      }),
      createHostRunawayGuardExtension(options),
      // Revision 11 F1: the exported safety-net was never composed — an empty
      // assistant response after a successful tool batch now gets one bounded
      // retry; a second empty response fails the turn with `terminal_empty`
      // instead of reporting a blank success. Observation goes to the runner
      // log only; observability must not change recovery semantics.
      terminalResponseRecoveryExtension({
        onRecovered: (observation) =>
          options.product.runner.logger?.info?.({
            event: 'terminal_response_recovery',
            outcome: 'recovered',
            ...observation,
          }),
        onFailed: (observation) =>
          options.product.runner.logger?.error?.({
            event: 'terminal_response_recovery',
            outcome: 'terminal_empty',
            ...observation,
          }),
      }),
      toolOutputBudgetExtension({
        maxInlineBytes: TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024,
        getMaxInlineBytes: () => getToolResultCompactionConfig().maxInlineBytes,
        fallbackPreviewBytes: 2 * 1_024,
        writeArtifact: createToolOutputArtifactWriter(
          options,
          toolOutputArtifacts,
          getToolResultCompactionConfig,
        ),
        onArtifactError: (error, input) =>
          logToolOutputBudgetDecisionBestEffort(options.product.runner.logger, {
            input,
            maxInlineBytes:
              getToolResultCompactionConfig().maxInlineBytes ??
              TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024,
            outcome: 'fallback',
            reason: safeErrorReason(error),
          }),
      }),
    ],
    options.product.normalExtensions,
    options.normalExtensions,
  );
}

function createHostRunawayGuardExtension<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): AgentExtension {
  return createProductionRunawayGuardExtension({
    readLocalConfig: () => options.product.preparation.configBuilder.config().runawayGuard,
    readRemoteConfig: options.getRunawayGuardConfig,
    readVerifiedProgress: (input) =>
      options.product.executor.fileChanges.takeToolProgress?.(input) ?? [],
    logger: options.product.runner.logger,
    reportEvent: (sessionId, event) =>
      options.product.runner.evalReporterFactory?.reportRuntimeEvent?.(sessionId, event),
  });
}

/** Env flag selecting the tool-output spill backend; default (legacy) is `file`. */
const TOOL_SPILL_ENV = 'MCODE_TOOL_SPILL';

/** Spec §4 registry: `mcode:turn` is local-runtime-v2's namespace. */
const spillLog = createLogger('mcode:turn');

type ToolSpillMode = 'cas' | 'file';

/** Resolves the spill backend from the env; unknown values degrade to `file`. */
function resolveToolSpillMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ToolSpillMode {
  const raw = env[TOOL_SPILL_ENV]?.trim().toLowerCase();
  if (!raw || raw === 'file') return 'file';
  if (raw === 'cas') return 'cas';
  spillLog.warn('unknown MCODE_TOOL_SPILL value; using the file spill backend', { value: raw });
  return 'file';
}

/**
 * The `toolOutputBudgetExtension.writeArtifact` seam (integration plan Ш6
 * CAS). `MCODE_TOOL_SPILL=file` (the default) keeps the legacy Session
 * reports-directory repository — byte-identical to the previous inline
 * implementation, including the decision log. `MCODE_TOOL_SPILL=cas` spills
 * the oversized tool output into the content-addressed store at the durable
 * root (`<root>/cas/<aa>/…`, profile-aware through `readProfileEnv`) and the
 * history receives the canonical `cas://sha256/<digest>#<size>` reference
 * instead of a file path.
 *
 * CAS failure policy (never silent): a fatal store error (ENOSPC/EACCES/…)
 * throws `CasSpillFatalError`, which the extension's own error path converts
 * into the bounded preview fallback and the `fallback` decision log; a
 * non-fatal store failure degrades to `undefined` (reported to the issue
 * listener) and this writer recovers through the legacy file repository, so
 * the receipt always carries a working reference. Both modes emit the same
 * `tool_output_budget_decision` log; the CAS artifact's `read_format`
 * (`cas_v1`) travels in its metadata.
 */
function createToolOutputArtifactWriter<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
  toolOutputArtifacts: ToolOutputArtifactRepository,
  getToolResultCompactionConfig: () => ToolResultCompactionConfig,
): (input: ToolOutputArtifactInput) => Promise<ToolOutputArtifact> {
  const write: (input: ToolOutputArtifactInput) => Promise<ToolOutputArtifact> =
    resolveToolSpillMode() === 'cas'
      ? createCasToolOutputArtifactSpill(toolOutputArtifacts)
      : (input) => toolOutputArtifacts.write(input);
  return async (input) => {
    const maxInlineBytes =
      getToolResultCompactionConfig().maxInlineBytes ??
      TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024;
    const artifact = await write(input);
    logToolOutputBudgetDecisionBestEffort(options.product.runner.logger, {
      input,
      maxInlineBytes,
      outcome: 'externalized',
      artifactReadFormat: artifact.metadata?.read_format,
    });
    return artifact;
  };
}

/**
 * The CAS-backed artifact writer. The store is opened lazily on the first
 * spill and shared for the host's lifetime; `openCas` takes the durable ROOT
 * and appends the `cas` layout itself (the same convention as the v2
 * importer's default root). A non-fatal store failure degrades the spill to
 * `undefined` and recovers through the legacy file repository.
 */
function createCasToolOutputArtifactSpill(
  toolOutputArtifacts: ToolOutputArtifactRepository,
): (input: ToolOutputArtifactInput) => Promise<ToolOutputArtifact> {
  let storePromise: Promise<CasStore> | undefined;
  const store = (): Promise<CasStore> => {
    storePromise ??= openCas(resolveDurableRoot(readProfileEnv()));
    return storePromise;
  };
  const spill = createCasToolOutputSpill(
    {
      putBytes: async (data) => await (await store()).putBytes(data),
      putFile: async (sourcePath) => await (await store()).putFile(sourcePath),
      putBase64: async (base64) => await (await store()).putBase64(base64),
    },
    (issue) => {
      // The issue listener fires outside any per-call artifact input, so only
      // the code and reason are known here (no session correlation).
      spillLog.warn('tool output CAS spill degraded', {
        code: issue.code,
        reason: issue.message,
      });
    },
  );
  return async (input) => {
    const reference = await spill.spill(input.text);
    if (reference === undefined) {
      // Non-fatal degradation (already reported): the legacy file repository
      // keeps the receipt recoverable.
      return await toolOutputArtifacts.write(input);
    }
    const digest = parseCasSpillRef(reference);
    return {
      reference,
      metadata: {
        artifact_kind: 'tool_output',
        spill: 'cas',
        sensitive: input.sensitive,
        read_format: 'cas_v1',
        ...(digest ? { content_sha256: digest.sha256, bytes: digest.size } : {}),
      },
    };
  };
}

function createMcpToolResultHistoryExternalizer<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
  artifacts: ToolOutputArtifactRepository,
  getConfig: () => ToolResultCompactionConfig,
): McpToolResultHistoryExternalizer {
  return new McpToolResultHistoryExternalizer({
    maxInlineBytes: TOOL_RESULT_COMPACTION_DEFAULTS.mcpDetailsMaxInlineKiB * 1_024,
    getMaxInlineBytes: () => getConfig().mcpDetailsMaxInlineBytes,
    writeArtifact: (input) => artifacts.write(input),
    logger: options.product.runner.logger,
  });
}

function createToolOutputArtifactRepository<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): ToolOutputArtifactRepository {
  return new ToolOutputArtifactRepository({
    resolveSessionReportsDirectory: (sessionId) =>
      options.sessions.artifacts.ensureReportsDirectory(sessionId),
  });
}

function createContextCompactors(input: {
  readonly contextUsageAnchor: ContextUsageAnchorState;
  readonly checkpointState: ConstructorParameters<typeof AutomaticContextCompactor>[1];
  readonly logger: ConstructorParameters<typeof AutomaticContextCompactor>[2];
  readonly toolResultArchiver: ToolResultArchiver;
  readonly promptSnapshots: ConstructorParameters<typeof LocalContextCompactor>[2];
  readonly getCompactionTriggerAt: () => number | undefined;
  /** Ш5: the projection-window byte axis; composed only in context-wire mode. */
  readonly byteTrigger?: AutomaticByteTrigger;
  /** W10: the unified scheduler owns the context triggers (wire mode). */
  readonly disableContextTriggers?: boolean;
}) {
  return {
    automatic: new AutomaticContextCompactor(
      input.contextUsageAnchor,
      input.checkpointState,
      input.logger,
      {
        toolResultArchiver: input.toolResultArchiver,
        promptSnapshots: input.promptSnapshots,
        getCompactionTriggerAt: input.getCompactionTriggerAt,
        ...(input.disableContextTriggers ? { disableContextTriggers: true } : {}),
        // Wave-0 item 0.4 (canon 05 §2.2, owner decision): in wire mode the
        // tool_archive axis is NOT an auto-trigger while there is no offload
        // event — the axis rewrites the whole history as a no-summary
        // `full reason=compact` and re-serializes inline media on every
        // firing (incident 2026-11-07, batch 17268). The explicit
        // MCODE_TOOL_ARCHIVE_TRIGGER=1 knob turns the axis back on.
        ...(input.disableContextTriggers
          ? { disableToolArchiveTrigger: !resolveToolArchiveTriggerEnabled() }
          : {}),
        ...(input.byteTrigger ? { byteTrigger: input.byteTrigger } : {}),
      },
    ),
    manual: new LocalContextCompactor(input.checkpointState, input.logger, input.promptSnapshots),
  };
}

/** Env knob re-enabling the legacy tool_archive AUTO axis in wire mode. */
const TOOL_ARCHIVE_TRIGGER_ENV = 'MCODE_TOOL_ARCHIVE_TRIGGER';

/**
 * Resolves the tool_archive auto-trigger knob (wave-0 item 0.4). Unset or
 * falsy keeps the wire-mode default (the axis never starts a compaction on
 * its own); `1/true/on` re-enables the axis for a session that wants the
 * text-only tool-result squeeze back. Unknown values fail closed with a
 * clear error — the same convention as `resolveContextWireEnabled`.
 */
export function resolveToolArchiveTriggerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[TOOL_ARCHIVE_TRIGGER_ENV]?.trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  throw new Error(
    `Unsupported ${TOOL_ARCHIVE_TRIGGER_ENV} value '${raw}' (supported: '1'/'true'/'on', '0'/'false'/'off', or unset for the wire-mode default: off)`,
  );
}

/**
 * W10: feeds the unified compaction's live canonical-log projection from the
 * SAME commits the context-wire bridge observes (and the turn seed's model
 * context), so the seam's `entries()` stays live without a second storage
 * read. Without a unified composition the bridge passes through untouched.
 */
function feedUnifiedCompactionLog(
  contextWire: TurnContextWire,
  unifiedCompaction: ProductUnifiedCompaction | undefined,
): TurnContextWire {
  if (!unifiedCompaction) return contextWire;
  return {
    ...contextWire,
    projection: (sessionId) => {
      const projection = contextWire.projection(sessionId);
      return projection ? unifiedCompaction.bindRequestFork(sessionId, projection) : undefined;
    },
    seed: (input) => {
      unifiedCompaction.observeSeed(input);
      contextWire.seed(input);
    },
    observeCommit: (change) => {
      unifiedCompaction.observeCommit(change);
      contextWire.observeCommit(change);
    },
  };
}

/**
 * Reads `contextManagement.compactionTriggerAt` per call. An invalid value is
 * reported once when the host is composed and then ignored by the budget.
 */
function createCompactionTriggerAtGetter<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): () => number | undefined {
  const read = () =>
    options.product.preparation.configBuilder.config().contextManagement?.compactionTriggerAt;
  try {
    const initial = read();
    if (initial !== undefined && !isValidCompactionTriggerSetting(initial)) {
      options.product.runner.logger?.warn?.(
        { event: 'context_compaction_trigger_config_ignored', value: initial },
        '[local-runtime-v2] contextManagement.compactionTriggerAt must be a ratio in (0, 1] or an integer token count above 1; using the built-in trigger',
      );
    }
  } catch {
    // The compactor treats an unreadable config as unset.
  }
  return read;
}

function createToolResultCompactionConfigGetter<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): () => ToolResultCompactionConfig {
  const fileConfig = parseToolResultCompactionConfig(readToolResultCompactionFileConfig(options));
  const base: Required<ToolResultCompactionConfig> = {
    enabled: fileConfig.enabled,
    maxInlineBytes: fileConfig.maxInlineKiB * 1_024,
    mcpDetailsMaxInlineBytes: fileConfig.mcpDetailsMaxInlineKiB * 1_024,
    watermarkBytes: fileConfig.watermarkKiB * 1_024,
    minSavingsBytes: fileConfig.minSavingsKiB * 1_024,
    minCandidateBytes: fileConfig.minCandidateKiB * 1_024,
    keepRecentRounds: fileConfig.keepRecentRounds,
  };
  return () => {
    const override = readToolResultCompactionOverride(options.getToolResultCompactionConfig);
    return {
      enabled: typeof override?.enabled === 'boolean' ? override.enabled : base.enabled,
      maxInlineBytes: positiveSafeInteger(override?.maxInlineBytes) ?? base.maxInlineBytes,
      mcpDetailsMaxInlineBytes:
        positiveSafeInteger(override?.mcpDetailsMaxInlineBytes) ?? base.mcpDetailsMaxInlineBytes,
      watermarkBytes: positiveSafeInteger(override?.watermarkBytes) ?? base.watermarkBytes,
      minSavingsBytes: positiveSafeInteger(override?.minSavingsBytes) ?? base.minSavingsBytes,
      minCandidateBytes: positiveSafeInteger(override?.minCandidateBytes) ?? base.minCandidateBytes,
      keepRecentRounds: positiveSafeInteger(override?.keepRecentRounds) ?? base.keepRecentRounds,
    };
  };
}

interface ToolOutputBudgetLogDecision {
  readonly input: ToolOutputArtifactInput;
  readonly maxInlineBytes: number;
  readonly outcome: 'externalized' | 'fallback';
  readonly artifactReadFormat?: unknown;
  readonly reason?: string;
}

function logToolOutputBudgetDecisionBestEffort(
  logger: LocalAgentTurnRunnerOptions['logger'],
  decision: ToolOutputBudgetLogDecision,
): void {
  try {
    const { input, maxInlineBytes, outcome, artifactReadFormat, reason } = decision;
    const fields = {
      event: 'tool_output_budget_decision',
      session_id: input.sessionId,
      turn_id: input.turnId,
      tool_name: input.toolName,
      outcome,
      original_bytes: input.originalBytes,
      max_inline_bytes: maxInlineBytes,
      ...(typeof artifactReadFormat === 'string' && artifactReadFormat.trim()
        ? { artifact_read_format: artifactReadFormat.trim() }
        : {}),
      ...(reason ? { reason } : {}),
    };
    logger?.[outcome === 'fallback' ? 'error' : 'info']?.(
      fields,
      '[local-runtime-v2] Tool output budget',
    );
  } catch {
    // Diagnostics must not change the ToolResult returned to History.
  }
}

function safeErrorReason(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string' && error.code.trim()) {
    return error.code.trim();
  }
  return error instanceof Error && error.name.trim() ? error.name.trim() : 'unknown_error';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readToolResultCompactionFileConfig<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): unknown {
  try {
    return options.product.preparation.configBuilder.config().toolResultCompaction;
  } catch {
    return undefined;
  }
}

function readToolResultCompactionOverride(
  getter: (() => ToolResultCompactionConfig | undefined) | undefined,
): ToolResultCompactionConfig | undefined {
  try {
    return getter?.();
  } catch {
    return undefined;
  }
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalPromptReadDependencies<TAgent extends AgentExecutionSnapshot>(
  product: ProductionAgentProductCapabilities<TAgent>,
) {
  return {
    ...(product.promptSnapshots ? { promptSnapshots: product.promptSnapshots } : {}),
    ...(product.internalTurnPromptReads
      ? { internalTurnPromptReads: product.internalTurnPromptReads }
      : {}),
  };
}

function withContextUsageProjection(
  messages: RequiredAgentEventProjector,
  contextUsage: RequiredAgentRuntimeProjector | undefined,
): RequiredAgentEventProjector {
  if (!contextUsage) return messages;
  return {
    async projectRuntimeEvent(input) {
      const result = await messages.projectRuntimeEvent(input);
      await contextUsage.projectRuntimeEvent(input);
      return result;
    },
    projectHistoryCommitted: (input) => messages.projectHistoryCommitted(input),
  };
}

function mergeNormalExtensions(
  builtins: readonly AgentExtension[],
  product: readonly AgentExtension[] | undefined,
  additional: readonly AgentExtension[] | undefined,
): readonly AgentExtension[] | undefined {
  const configured = [...(product ?? []), ...(additional ?? [])];
  const builtinIds = new Set(builtins.map((extension) => extension.id));
  const merged = [
    ...configured.filter((extension) => !builtinIds.has(extension.id)),
    // Host-owned builtins establish terminal postconditions. They must observe every configured
    // after_tool_call rewrite and cannot be replaced by a configured extension with the same id.
    ...builtins,
  ];
  return merged.length > 0 ? merged : undefined;
}

function optionalToolPolicyGuard(toolPolicyGuard: LocalTurnToolPolicyGuard | undefined) {
  return toolPolicyGuard ? { toolPolicyGuard } : {};
}

function optionalDesktopHostCapabilities(cliProductPolicy: boolean | undefined) {
  return cliProductPolicy
    ? {}
    : {
        hostCapabilityRegistry: new HostCapabilityRegistry([
          createBrowserHostCapabilityAdapter(describeLocalBrowserToolInput),
        ]),
      };
}

function optionalNormalExtensions(normalExtensions: readonly AgentExtension[] | undefined) {
  return normalExtensions ? { normalExtensions } : {};
}

export function combineAgentEventObservers(
  ...observers: readonly (AgentEventBestEffortObserver | undefined)[]
): AgentEventBestEffortObserver | undefined {
  const active = observers.filter(
    (observer): observer is AgentEventBestEffortObserver => observer !== undefined,
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return {
    observeRuntimeEvent: (input) =>
      observeAll(active, (observer) => observer.observeRuntimeEvent?.(input)),
    observeHistoryCommitted: (input) =>
      observeAll(active, (observer) => observer.observeHistoryCommitted?.(input)),
    observeHistoryFailure: (input) =>
      observeAll(active, (observer) => observer.observeHistoryFailure?.(input)),
  };
}

type SessionLLMRetryEventPublisher = (event: GlobalEventInput<'session.llm_retry'>) => void;

/** Projects transient provider retry state from Turn execution onto the product event stream. */
export function createSessionLLMRetryEventObserver(
  publish: SessionLLMRetryEventPublisher,
): NonNullable<LLMRetryOptions['observer']> {
  return (event) => {
    if (event.scope === 'title') return;
    publish({
      type: 'session.llm_retry',
      payload: { schemaVersion: 1, ...event },
    });
  };
}

async function observeAll(
  observers: readonly AgentEventBestEffortObserver[],
  observe: (observer: AgentEventBestEffortObserver) => void | Promise<void> | undefined,
): Promise<void> {
  const results = await Promise.allSettled(observers.map((observer) => observe(observer)));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Agent event observers failed');
}

async function requireExecutionSession(
  sessions: SessionSystemOwner,
  input: {
    readonly sessionId: string;
    readonly agentName: string;
    readonly workspaceDir: string;
  },
): Promise<SessionRecord> {
  const session = await sessions.sessions.repository.get(input.sessionId);
  if (
    !session ||
    session.agentName !== input.agentName ||
    session.workspaceDir !== input.workspaceDir
  ) {
    throw new Error(`AgentHost tool source Session mismatch: ${input.sessionId}`);
  }
  return session;
}

function adaptCanonicalHistory(
  provider: SessionSystemOwner['canonicalHistory'],
  mutation: SessionSystemOwner['sessions']['historyMutation'],
): DurableCanonicalHistoryProvider {
  // The default Session provider owns deeply immutable decoded rows. Transfer
  // each message once; legacy and injected providers keep their original path.
  if (provider.withSnapshotTransform) {
    const messages = new WeakMap<object, unknown>();
    provider = provider.withSnapshotTransform((snapshot) => {
      const owned = snapshot.messages.map((message) => {
        if (typeof message !== 'object' || message === null) return message;
        const previous = messages.get(message);
        if (previous !== undefined) return previous;
        const value = captureSemanticSnapshot(message).value;
        messages.set(message, value);
        return value;
      });
      return captureSemanticSnapshot({
        revision: snapshot.revision,
        messages: captureSemanticSnapshot(owned).value,
        identityVector: captureSemanticSnapshot(snapshot.identityVector).value,
      }).value;
    });
  }
  return {
    read: async (sessionId) => {
      const snapshot = await provider.read(sessionId);
      validateCanonicalHistoryMessages(snapshot.messages);
      return {
        revision: snapshot.revision,
        messages: snapshot.messages,
        identityVector: snapshot.identityVector,
      };
    },
    readActive: async (sessionId) => {
      const snapshot = await provider.readActive(sessionId);
      validateCanonicalHistoryMessages(snapshot.messages);
      return {
        revision: snapshot.revision,
        messages: snapshot.messages,
        identityVector: snapshot.identityVector,
      };
    },
    append: async (change) => {
      const committed = await provider.append(requireHistoryOperation(change));
      validateCanonicalHistoryMessages(committed.messages);
      return { ...committed, messages: committed.messages };
    },
    // Wave 2 (canon 05 §2.2, item 2.4): the durable TEXT offload seam,
    // forwarded when the underlying provider implements it (durable mode).
    ...(provider.offloadToolText
      ? {
          offloadToolText: (
            sessionId: string,
            items: readonly {
              readonly envelopeIndex: number;
              readonly replacement: string;
              readonly reference: string;
            }[],
          ) => provider.offloadToolText!(sessionId, items),
        }
      : {}),
    replace: async (change) => {
      const committed = await provider.replace(requireHistoryOperation(change));
      validateCanonicalHistoryMessages(committed.messages);
      return { ...committed, messages: committed.messages };
    },
    compact: async (change: CanonicalHistoryCompactionChange) => {
      const operation = requireHistoryOperation(change);
      if (operation.reason !== 'replaceMessages' || operation.operation.kind !== 'compaction') {
        throw new TypeError('Typed canonical compaction requires a compaction operation.');
      }
      const metadata = readCompactionCommitMetadata(operation.metadata);
      if (!metadata) throw new TypeError('Canonical compaction metadata is invalid.');
      const baseChange = {
        ...operation,
        reason: 'replaceMessages',
        operation: { id: operation.operation.id, kind: 'compaction' },
        compactionId: metadata.compactionId,
        summary: metadata.summary,
        ...(metadata.currentUserSourceIndex === undefined
          ? {}
          : { currentUserSourceIndex: metadata.currentUserSourceIndex }),
      } as const;
      if (metadata.method !== 'llm_checkpoint') {
        const committed = await provider.compact({
          ...baseChange,
          method: metadata.method,
          replacementSourceIndexes: metadata.replacementSourceIndexes,
        });
        validateCanonicalHistoryMessages(committed.messages);
        return { ...committed, messages: committed.messages };
      }
      const committed = await provider.compact({
        ...baseChange,
        method: metadata.method,
      });
      validateCanonicalHistoryMessages(committed.messages);
      return { ...committed, messages: committed.messages };
    },
    settleTurnTail: async (input) => {
      if (!mutation.settleTurnTail) {
        throw new TypeError('SessionSystem settleTurnTail capability is unavailable.');
      }
      const committed = await mutation.settleTurnTail({
        sessionId: input.sessionId,
        turnId: input.turnId,
        operationId: input.operation.id,
        mode: input.mode,
        approvedContent: input.approvedContent,
      });
      validateCanonicalHistoryMessages(committed.messages);
      return {
        revision: committed.revision,
        messages: committed.messages,
        identityVector: committed.identityVector,
        status: committed.status,
        deletedMessageIds: committed.deletedMessageIds,
      };
    },
    retractTurn: async (input) => {
      if (!mutation.retractTurn) {
        throw new TypeError('SessionSystem retractTurn capability is unavailable.');
      }
      const committed = await mutation.retractTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        operationId: input.operation.id,
        reason: input.reason,
      });
      validateCanonicalHistoryMessages(committed.messages);
      return {
        revision: committed.revision,
        messages: committed.messages,
        identityVector: committed.identityVector,
        status: committed.status,
        deletedMessageIds: committed.deletedMessageIds,
      };
    },
  };
}

function requireHistoryOperation(change: CanonicalHistoryChange): CanonicalHistoryChange & {
  readonly operation: NonNullable<CanonicalHistoryChange['operation']>;
} {
  if (!change.operation) throw new TypeError('Canonical history operation is required.');
  return { ...change, operation: change.operation };
}

function mutableTitleContext(context: {
  readonly systemPrompt: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'user';
    readonly content: string;
    readonly timestamp: number;
  }>;
  readonly tools?: readonly Tool[];
}): Context {
  return {
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((message) => ({ ...message })),
    ...(context.tools ? { tools: [...context.tools] } : {}),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
