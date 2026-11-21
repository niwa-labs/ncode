import { createMiniAppControlExtension } from "@mavis/agent-extension";
import type {
  AgentExtension,
  InternalTurnPromptReadRegistry,
} from "@mavis/agent-runtime";
import type { RunawayGuardOverride } from "@mavis/config";
import {
  getRuntimeRegion,
  isLocalSourceProvenanceEnabled,
} from "@mavis/config";
import type { RuntimeConversation } from "@mavis/conversation-contract";
import type {
  GlobalEvent,
  GlobalEventInput,
} from "@mavis/shared/global-events";
import { isOrdinaryQuestionnaireResponseOrigin } from "@mavis/shared/questionnaire";
import { createGoalBudgetSummaryExtension } from "./application/agent/goal-budget-summary-reminder.js";
import { createGoalFinalReply } from "./application/agent/goal-final-reply.js";
import {
  combineLocalTurnToolPolicyGuards,
  createGoalBudgetToolPolicyGuard,
} from "./application/agent/goal-budget-tool-policy.js";
import { createGoalVerificationTranscriptReader } from "./application/agent/goal-verification-transcript.js";
import { createOutputLimitRecoveryExtension } from "./application/agent/output-limit-recovery-extension.js";
import { createRequestMediaEncodingExtension } from "./application/agent/request-media-extension.js";
import { parseRequestMediaConfig } from "@mavis/config";
import { createRuntimeSourceReferenceExtension } from "./application/agent/source-reference-extension.js";
import {
  createQueryCollapseKeyResolver,
  type ConversationApplication,
  type UserMessageTurnDelivery,
} from "./application/conversation/index.js";
import { createRuntimeMessageDelivery } from "./application/conversation/runtime-message-delivery.js";
import {
  AgentApplication,
  AppError,
  closeRuntimeServiceOwnersAfterFailure,
  composeRuntimeGlobalEventWriter,
  configureRuntimePluginHooks,
  createAgentSessionPorts,
  createGoalEvaluatorVerifier,
  createGoalSubagentVerifierRuntime,
  createRuntimeAgentApplication,
  createRuntimeBrowserUseComposition,
  createRuntimePluginSessionLifecycle,
  createRuntimeServicesLifecycle,
  createRuntimeSkillApplication,
  initializeApplications,
  isCommandLineRuntimeOwner,
  ModelProviderApplication,
  ownsElectronRuntimeCapabilities,
  type ForkWorktreePort,
  type GoalSubagentVerifierRuntime,
  type RuntimeApplications,
  type RuntimeSkillApplication,
} from "./application/index.js";
import { createRuntimeQueueSelection } from "./application/session/runtime-queue-selection.js";
import { createForkState } from "./application/session/conversation-fork-state.js";
import {
  createProductionConversationMutationWorkflow,
  unavailableForkWorktree,
} from "./application/session/conversation-mutation-workflow.js";
import { createMemoryRecallAdmissionPolicy } from "./application/session/memory-recall-admission.js";
import { createHostSessionMiniAppLifecycle } from "./application/session/miniapp-host.js";
import { resolvePluginServiceLogger } from "./application/session/plugin-service-logger.js";
import type { LocalRuntimeApplication } from "./application/session/process-local-application-contract.js";
import { composeProcessLocalApplication } from "./application/session/process-local-composition.js";
import { initializeRuntimeServicePromptSupport } from "./application/session/runtime-prompt-support.js";
import {
  createRuntimeAgentReferenceProjection,
  createServiceWorkspace,
  resolveServicesCompatibility,
} from "./application/session/runtime-services-composition.js";
import {
  createProductionSessionComposition,
  type ProductionSessionComposition,
} from "./application/session/runtime-session-composition.js";
import { createRuntimeUserApplications } from "./application/session/runtime-user-applications.js";
import { bindTaskAgentBindingCapture } from "./application/session/task-agent-ready-inventory.js";
import {
  createSessionTurnLifecycleEvents,
  type SessionTurnLifecycleEventObserver,
} from "./application/session/turn-lifecycle-event-observer.js";
import {
  createApprovedTitleHandler,
  createConsumedSteeringHandler,
  createQueueWakeFailureReporter,
  createTurnSystemMessageDelivery,
  describeError,
  reportRootBestEffortFailure,
} from "./application/session/turn-message-delivery.js";
import type {
  V1ServiceCompatibility,
  V1ServiceFactory,
} from "./compat/v1/runtime.js";
import type { AppDb } from "./infra/db/client.js";
import type { EventBusClient } from "./infra/event-bus/index.js";
import type { RuntimeOwnerIdentity } from "./infra/runtime-owner/index.js";
import type { SchedulerClient } from "./infra/scheduler/index.js";
import {
  AgentFavorites,
  type LocalAgentService,
} from "./service/agent/index.js";
import type {
  BrowserUseService,
  BrowserUseServiceOptions,
} from "./service/browser-use/index.js";
import {
  initializeRuntimeCanvas,
  type CanvasService,
} from "./service/canvas/index.js";
import {
  initializeOptionalChannelSystem,
  LegacyCredentialMigrationReceipt,
  type ChannelSystemOwner,
} from "./service/channel-system/index.js";
import {
  initializeContentSafetyService,
  reviewBlocks,
  SAFETY_SCENE,
  type ContentSafetyService,
} from "./service/content-safety/index.js";
import {
  createOptionalRuntimeCronTurnDelivery,
  createRuntimeCronSessionPorts,
  hasActiveCronSessionOwner,
  initializeCronService,
  type CronMetricsClient,
  type CronService,
  type CronSessionPorts,
  type CronTurnDeliveryPort,
  type InitializedCronService,
} from "./service/cron/index.js";
import {
  createRuntimeInspector,
  type ComposedInspector,
} from "./service/llm-context-inspector/index.js";
import {
  initializeMcpService,
  type InitializedMcpService,
  type McpSettingsService,
} from "./service/mcp/index.js";
import {
  composeMiniAppRuntimeCapability,
  createDeferredRuntimeOwnersLifecycle,
  resolveRuntimeMiniAppOptions,
  type RuntimeMiniAppServiceOptions,
  type RuntimeMiniAppServices,
} from "./service/miniapp/index.js";
import {
  createLocalModelSystemConfigPort,
  ModelFavoritesPreference,
  resolveLocalRuntimeModelKey,
  type ModelSystemOwner,
} from "./service/model-system/index.js";
import type { PinService } from "./service/pin/index.js";
import {
  bindConversationMutationPlanState,
  createPlanEntryReaders,
  createPlanEntrySubmissionPreparation,
  initializePlanService,
  type PlanService,
} from "./service/plan/index.js";
import {
  createPluginNameReservations,
  initializePluginService,
  SkillEnabledState,
  type InitializedPluginService,
  type PluginServiceLogger,
} from "./service/plugin-system/index.js";
import {
  bindRuntimeServicePromptLifecycle,
  createRuntimePromptAuthNotifier,
  withRuntimePromptSupportRollback,
  type LocalPromptFileReader,
  type RuntimePromptSupport,
} from "./service/prompt-config/index.js";
import {
  composeLocalSandboxService,
  type DeferredLocalSandboxBashOperationsFactory,
  type LocalSandboxService,
} from "./service/sandbox/index.js";
import {
  ComposerSendBehaviorPreference,
  initializeSessionApplicationSystem,
  type InitializedSessionApplicationSystem,
  type SessionLifecycleService,
  type SessionSystemOwner,
} from "./service/session-system/index.js";
import {
  AgentHostTurnCapabilityLifecycle,
  CliSunsetNotice,
  combineAgentEventObservers,
  composeTurnAdmissionPolicies,
  composeTurnSubmissionPreparations,
  createGoalTurnSubmissionPreparation,
  createLocalAgentHost,
  createSessionLLMRetryEventObserver,
  deactivateLocalPluginHooks,
  disposeLocalPluginHookSessions,
  GlobalInstructions,
  hasPriorityUserQueueItem,
  initializeTurnSystem,
  readLocalInstructionSources,
  requireAgentRuntime,
  requireTurnSystem,
  type AgentHostRuntimeLifecycle,
  type ToolResultCompactionConfig,
	type TurnSystemOwner,
	type SystemPromptOverrides,
	createSessionCacheWarming,
	createPromptSuggestionService,
	type PromptSuggestionTurnPort,
} from "./service/turn-system/index.js";
import {
  createSessionPermissionModeRegistry,
  type SessionPermissionModeRegistry,
} from "./service/permission/session-permission-mode.js";
import { resolvePromptSuggestionEnabled } from "@mavis/config";
import { createLogger } from "@mavis/logging";

const promptSuggestionLog = createLogger("mcode:prompt-suggestion");
const servicesLog = createLogger("mcode:runtime");
import { createDurableHistoryCacheWarmUsageSink } from "./service/turn-system/agent-host/cache-warming/durable-usage-sink.js";
import { withProductTurnDriver } from "./service/turn-system/agent-host/driver/index.js";
import {
  createDurableHistoryStorage,
  resolveHistoryProviderMode,
  type DurableHistoryStorage,
} from "./service/session-system/messages/history/durable-canonical-history-provider.js";
import {
  openDurableRuntimeOrchestration,
  type RuntimeOrchestration,
} from "./service/orchestration/runtime-orchestration.js";
import { createRuntimeDelegationSteeringComposition } from "./service/turn-system/execution/steering/runtime-delegation-steering.js";
import { composeV1Conversation } from "./service/v1-conversation-compat/index.js";
import type { WorkspaceSystem } from "./service/workspace/index.js";

export {
  createRuntimeAgentComposition,
  type AgentCutoverLogEvent,
  type AgentRuntimeOwner,
  type LegacyCustomAgentMaterializationEvent,
  type LegacyIdentityDetachEvent,
} from "./service/agent/index.js";
export {
  createDeferredLocalSandboxBashOperationsFactory,
  type DeferredLocalSandboxBashOperationsFactory,
} from "./service/sandbox/index.js";
export interface RuntimeServices extends RuntimeMiniAppServices {
  /** V2 Agent owner and cross-capability Agent workflows. */
  readonly agent: AgentApplication;
  readonly safety: ContentSafetyService;
  /**
   * Per-session permission-mode registry (spec §2.1): ONE instance per
   * runtime process, shared by the turn system (lock), the permission check
   * seam (consumption), the CliService surface (bind/set/get) and the child
   * Session creation points (inherit).
   */
  readonly sessionPermissionModes: SessionPermissionModeRegistry;
  readonly canvas: CanvasService;
  /** Electron-only scheduled execution capability; absent on embedded CLI. */
  readonly cron?: CronService;
  readonly cronDelivery?: CronTurnDeliveryPort;
  readonly globalEvents: Pick<EventBusClient<GlobalEvent>, "subscribe">;
  /** V1-owned Git implementation exposed through the V2 Desktop controller. */
  readonly managedWorktrees: V1ServiceCompatibility["managedWorktrees"];
  /** One V2 Workspace owner for Git and HTML previews. */
  readonly workspace: WorkspaceSystem;
  readonly sessionSystem: SessionSystemOwner;
  readonly pinService: PinService;
  readonly globalInstructions: GlobalInstructions;
  readonly agentFavorites: AgentFavorites;
  readonly composerSendBehavior: ComposerSendBehaviorPreference;
  /** Electron-only channel feedback capability; absent on embedded CLI. */
  readonly channelSystem?: ChannelSystemOwner;
  readonly turnSystem: TurnSystemOwner;
  /** V2-owned Browser Use policy, per-Session state, tools, and UI context. */
  readonly browserUse: BrowserUseService;
  /** Application use cases consumed by generated Desktop HTTP controllers. */
  readonly conversation: ConversationApplication;
  /** Required production Session/Queue/Project use cases. */
  readonly applications: RuntimeApplications;
  /** Process-local product surface implemented by the v2 owner. */
  readonly application: LocalRuntimeApplication;
  readonly plugin: InitializedPluginService["plugin"];
  readonly mcp: McpSettingsService;
  readonly mcpRuntime: InitializedMcpService["runtime"];
  readonly modelSystem: ModelSystemOwner;
  readonly modelProviderApplication: ModelProviderApplication;
  readonly skill: RuntimeSkillApplication;
  readonly sandbox: LocalSandboxService;
  /** Development-only LLM Context Inspector; absent when the build hides it. */
  readonly llmContextInspector?: ComposedInspector["service"];
  /** W10 durable mode: the ONE pi scheduler composition (goal/background/cron/roster bridges). */
  readonly orchestration?: RuntimeOrchestration;
  notifyAuthContextChanged(
    authState?: "pending" | "authenticated" | "logged_out",
  ): void | Promise<void>;
  /** True after builtins are durably ensured and legacy custom materialization has settled. */
  readonly builtinAgentDefinitionsReady: Promise<boolean>;
  /** Completes service recovery after shared background infrastructure starts. */
  ready(): Promise<void>;
  close(): Promise<void>;
}
export interface RuntimeServicesTestOverrides {
  readonly cron?: {
    readonly sessionPorts?: CronSessionPorts;
    readonly turnDelivery?: CronTurnDeliveryPort;
  };
  /** @internal Read-only observation seam for native AgentHost capability integration tests. */
  readonly inspectTurnCapabilities?: (
    lifecycle: AgentHostTurnCapabilityLifecycle,
  ) => void;
  readonly sandbox?: {
    readonly descriptors?: Parameters<
      typeof composeLocalSandboxService
    >[0]["sandboxDescriptors"];
  };
}
export interface CreateRuntimeServicesOptions
  extends RuntimeMiniAppServiceOptions {
  readonly db: AppDb;
  readonly logger?: PluginServiceLogger;
  readonly scheduler?: SchedulerClient;
  readonly metrics?: CronMetricsClient & {
    gauge?(name: string, value: number, labels?: Record<string, string>): void;
  };
  readonly eventBus: EventBusClient<GlobalEvent>;
  readonly compatibility: V1ServiceCompatibility | V1ServiceFactory;
  /** Raw product Browser provider. Policy and composition remain entirely V2-owned. */
  readonly browserUse?: Pick<
    BrowserUseServiceOptions,
    "adapter" | "toolExposure"
  >;
  /** Prepared before V1 construction in production; omission is a test-only convenience. */
  readonly prepared?: PreparedRuntimeServices;
  /** AgentRuntimeOwner creates and closes this service outside the graph. */
  readonly agentService: LocalAgentService;
  /** Shared encrypted-template cache created by AgentRuntimeOwner. */
  readonly promptFileReader?: LocalPromptFileReader;
  /** Infrastructure-owned Git capability injected by the runtime composition boundary. */
  readonly forkWorktree?: ForkWorktreePort;
  readonly dataDir: string;
  readonly configSource?: "default" | "explicit";
  readonly nowMs?: () => number;
  readonly recoverPersistedState?: boolean;
  /** Composition owner mode; CLI omits Electron-only capabilities. */
  readonly runtimeOwnerKind?: string;
  /**
   * Owner decision 2026-11-18 (per-session durable history): this runtime
   * owns the shared SYSTEM log (the mcoded daemon — the runtime that owns
   * scheduling, delegation steering and the orchestration bridges). Embedded
   * runtimes (off-mode TUI/exec/ACP) omit it: their writes land in the
   * per-session files alone, and the hub features stay on the daemon.
   */
  readonly ownsSystemLog?: boolean;
  /** Electron-owned fixed key for encrypted Desktop Prompt bundles. */
  readonly promptConfigKey?: Uint8Array;
  /** Client capability ceiling; omitted owners retain the shared legacy surface. */
  readonly capabilityProfile?: "cli";
  /** Launch-scoped main-Agent prompt overrides; process memory only. */
  readonly systemPromptOverrides?: SystemPromptOverrides;
  /** Electron owns greeting dispatch; embedded CLI only seeds V2 Agent/Root rows. */
  readonly greetingEnabled?: boolean;
  /** Live optional Runaway Guard override injected by the owning product. */
  readonly getRunawayGuardConfig?: () => RunawayGuardOverride | undefined;
  /** Live ToolResult compaction thresholds injected by the owning product. */
  readonly getToolResultCompactionConfig?: () =>
    | ToolResultCompactionConfig
    | undefined;
  readonly subscriptionQuota?: (input: { provider: string; modelId: string; signal?: AbortSignal }) => Promise<{ resetAtMs?: number } | undefined>;
  readonly runtimeOwnerIdentity: RuntimeOwnerIdentity;
  readonly sandboxOperationsFactory?: DeferredLocalSandboxBashOperationsFactory;
  readonly sandboxConfig?: Parameters<
    typeof composeLocalSandboxService
  >[0]["sandboxConfig"];
  readonly overrides?: RuntimeServicesTestOverrides;
}
type ResolvedCreateRuntimeServicesOptions = Omit<
  CreateRuntimeServicesOptions,
  "compatibility"
> & {
  readonly compatibility: V1ServiceCompatibility;
};

export interface PreparedRuntimeServices {
  readonly skillEnabledState: SkillEnabledState;
  readonly legacyCredentialMigrationReceipt: LegacyCredentialMigrationReceipt;
  readonly cliSunsetNotice: CliSunsetNotice;
  readonly v1: {
    readonly skillEnabledState: SkillEnabledState;
    readonly runLegacyImCredentialMigration: LegacyCredentialMigrationReceipt["run"];
    readonly cliSunsetNotice: CliSunsetNotice;
  };
}

export function prepareRuntimeServices(options: {
  readonly db: AppDb;
  readonly runtimeOwnerKind?: string;
}): PreparedRuntimeServices {
  const skillEnabledState = new SkillEnabledState(options.db);
  const legacyCredentialMigrationReceipt = new LegacyCredentialMigrationReceipt(
    options.db,
  );
  const cliSunsetNotice = new CliSunsetNotice(options.db);
  return {
    skillEnabledState,
    legacyCredentialMigrationReceipt,
    cliSunsetNotice,
    v1: {
      skillEnabledState,
      runLegacyImCredentialMigration: (action) =>
        legacyCredentialMigrationReceipt.run(action),
      cliSunsetNotice,
    },
  };
}
interface RuntimeServiceState {
  closed: boolean;
  /** Bound after owner initialization; greeting events remain best-effort until then. */
  agentApplication?: AgentApplication;
}

interface InitializedRuntimeServiceOwners {
  readonly plan: PlanService;
  readonly turnSystem: TurnSystemOwner;
  /** Electron-only scheduled execution capability; absent on embedded CLI. */
  readonly cron: InitializedCronService | undefined;
  readonly plugin: ReturnType<typeof initializePluginService>;
  readonly miniAppComposition: RuntimeMiniAppComposition;
  readonly mcp: InitializedMcpService;
  readonly agentApplication: AgentApplication;
  readonly runtimeConversation: RuntimeConversation;
  readonly applications: RuntimeApplications;
  readonly sessionApplications: InitializedSessionApplicationSystem;
}

type RuntimeMiniAppComposition = Awaited<
  ReturnType<typeof composeMiniAppRuntimeCapability>
>;

/**
 * Builds SessionSystem, the Plugin service, optional Channel/Cron owner
 * capabilities, AgentHost, and TurnSystem over that graph.
 */
export async function createRuntimeServices(
  creation: CreateRuntimeServicesOptions,
): Promise<RuntimeServices> {
  const compatibility = resolveServicesCompatibility(creation.compatibility);
  const options: ResolvedCreateRuntimeServicesOptions = {
    ...creation,
    compatibility,
  };
  const browserUseComposition = createRuntimeBrowserUseComposition(options);
  const prepared = options.prepared ?? prepareRuntimeServices(options);
  const nowMs = options.nowMs ?? Date.now;
  const processStartedAtMs = nowMs();
  // Ш1 (per-session model, owner decision 2026-11-18): the runtime's durable
  // history = ONE OWN log per session (`durable-history/sessions/<id>/`) plus
  // a ROUTING storage worker; runtimes with `ownsSystemLog` (the mcoded
  // daemon) additionally own the shared SYSTEM log (the legacy monolith) that
  // carries the orchestration substrate. The DURABLE provider is the W10
  // hybrid default; the explicit `MCODE_HISTORY_PROVIDER=jsonl` compatibility
  // mode opens nothing and keeps the exact legacy composition. The
  // session-system close() disposes it (durableHistory is passed down).
  // Cross-process exclusion is per SESSION file: another live runtime owning
  // a DIFFERENT session no longer blocks this one (the single-log era's
  // fail-fast now applies only to the same session, or to a second daemon on
  // the system log).
  const durableHistory =
    resolveHistoryProviderMode() === "durable"
      ? await createDurableHistoryStorage({
          dataDir: options.dataDir,
          ownsSystemRoot: options.ownsSystemLog === true,
        })
      : undefined;
  // W10 atomic scheduler swap (state/w08.md closure №1): in durable mode the
  // cron wake lives on the ONE pi scheduler through the CronJobBridge and the
  // croner Scheduler must NOT also be injected — three schedulers never live.
  if (durableHistory && options.scheduler) {
    throw new Error(
      "Durable composition refuses an injected croner Scheduler client: the cron wake is owned by the durable orchestration bridge (three schedulers must never live); drop the scheduler option or select MCODE_HISTORY_PROVIDER=jsonl",
    );
  }
  const ownerLifecycle = createDeferredRuntimeOwnersLifecycle();
  const state: RuntimeServiceState = { closed: false };
  // §2.1: the ONE per-process registry. The Turn probe is late-bound (the
  // Turn system does not exist yet) so `bind` can refuse a mode change under
  // a running Turn from the very first Session.
  const sessionPermissionTurnProbe: {
    read?: (sessionId: string) => boolean;
  } = {};
  const sessionPermissionModes = createSessionPermissionModeRegistry({
    isTurnActive: (sessionId) => sessionPermissionTurnProbe.read?.(sessionId) === true,
  });
  // W10: the durable orchestration composition (the ONE pi scheduler over the
  // gated SYSTEM storage + the goal/background/cron/roster bridges), with the
  // fail-closed session→conversation resolver minting one pi conversation per
  // product session. Owner decision 2026-11-18: the orchestration substrate
  // is a SYSTEM-log capability — the mcoded daemon opens it, embedded
  // runtimes (off-mode TUI/exec/ACP) run turns on their per-session files
  // without the hub features, loudly.
  const orchestration = durableHistory?.system
    ? await openDurableRuntimeOrchestration({
        durableSystem: durableHistory.system,
        nativeForeground: isCommandLineRuntimeOwner(options.runtimeOwnerKind) &&
          process.env.MCODE_FOREGROUND_EXECUTOR !== "agent-loop",
        db: options.db,
        nowMs,
        metrics: options.metrics,
      })
    : undefined;
  if (durableHistory && !durableHistory.system) {
    servicesLog.warn(
      "durable per-session mode without the system log: orchestration (goals, background tasks, cron), delegation steering and the usage mirror live on the daemon-owned system log; this runtime serves plain turns on its per-session files",
      { dataDir: options.dataDir },
    );
  }
  // The swapped cron scheduler client (bridge-backed); undefined keeps the
  // legacy injected scheduler in jsonl compatibility mode.
  const schedulerOverride = orchestration?.scheduler;
  const sandbox = initializeRuntimeSandbox(options);
  const { bindSessionSystem, inspector } =
    await createRuntimeInspector(options);
  const writeGlobalEvent = createServiceGlobalEventWriter(
    options,
    state,
    browserUseComposition.service,
    sandbox,
  );
  const workspace = createServiceWorkspace(writeGlobalEvent);
  const turnCapabilities = new AgentHostTurnCapabilityLifecycle();
  options.overrides?.inspectTurnCapabilities?.(turnCapabilities);
  const safety = initializeContentSafetyService({
    review: options.compatibility.safety.review,
  });
  const globalInstructions = new GlobalInstructions(options.dataDir);
  const promptSupport = await initializeRuntimeServicePromptSupport({
    ...options,
    promptConfig: options.compatibility.promptConfig,
    plugin: options.compatibility.plugin,
  });
  const { promptConfig, promptSnapshots, internalTurnPromptReads } =
    promptSupport;
  const agentSessionPorts = createAgentSessionPorts(options.agentService);
  const serviceLogger = resolvePluginServiceLogger(options.logger);
  const readAgentHostConfig =
    options.compatibility.agentHost.preparation.configBuilder.config;
  const productionSessionComposition = createProductionSessionComposition({
    ...options,
    baseProduct: options.compatibility.agentHost,
    compatibility: options.compatibility.sessionV2,
    refreshOfficialModels:
      options.compatibility.modelProvider?.refreshOfficialModels,
    safety,
    logger: serviceLogger,
    nowMs,
    publishGlobalEvent: writeGlobalEvent,
    agentSessionPorts,
    modelConfig: createLocalModelSystemConfigPort(readAgentHostConfig),
    agentReferenceProjection: createRuntimeAgentReferenceProjection(
      options.compatibility,
      options.agentService,
      serviceLogger,
    ),
    inspector,
    internalTurnPromptReads,
    miniappAvailable: resolveRuntimeMiniAppOptions(options) !== undefined,
    browserUse: browserUseComposition.service,
    promptSnapshots,
    globalInstructions,
    ...(durableHistory ? { durableHistory } : {}),
  });
  bindSessionSystem(productionSessionComposition.sessionSystem);
  const {
    product,
    preparation,
    modelSystem,
    modelProviderApplication,
    sessionSystem,
    pinService,
    archiveTitleModel,
    facts,
  } = productionSessionComposition;
  const { planEntryEnabled, agentPlanEntryEnabled } = createPlanEntryReaders(
    product.preparation.configBuilder.config,
  );
  const canvas = initializeRuntimeCanvas(options, sessionSystem);
  // Fail-closed failure path: if owner initialization throws after the
  // orchestration opened, close the ONE scheduler before the error
  // propagates (no half-composed durable runtime keeps running).
  let promptBoundOwners: Awaited<
    ReturnType<typeof initializePromptBoundRuntimeServiceOwners>
  >;
  try {
    promptBoundOwners = await initializePromptBoundRuntimeServiceOwners({
    options,
    processStartedAtMs,
    product,
    preparation,
    sessionSystem,
    pinService,
    canvas,
    archiveTitleModel,
    facts,
    safety,
    sessionPermissionModes,
    sessionPermissionTurnProbe,
    turnCapabilities,
    agentSessionPorts,
    agentService: options.agentService,
    internalTurnPromptReads,
    writeGlobalEvent,
    nowMs,
    enableCron: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind),
    runtimeOwnerIdentity: options.runtimeOwnerIdentity,
    planEntryEnabled,
    agentPlanEntryEnabled,
    inspector,
    promptSupport,
    enableChannel: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind),
    readyOwners: ownerLifecycle.ready,
    closeOwners: ownerLifecycle.close,
    ...(schedulerOverride ? { schedulerOverride } : {}),
    ...(orchestration?.orchestration.foregroundLoop ? { foregroundLoop: orchestration.orchestration.foregroundLoop } : {}),
    ...(durableHistory ? { durableHistory } : {}),
  });
  } catch (error) {
    if (orchestration) await orchestration.orchestration.close().catch(() => {});
    throw error;
  }
  const { channelSystem, owners, queryCollapseKeys } = promptBoundOwners;
  state.agentApplication = owners.agentApplication;
  const { conversation, skill } = createRuntimeUserApplications({
    options,
    owners,
    sessionSystem,
    queryCollapseKeys,
    agentSessionPorts,
    nowMs,
    createSkillApplication: createRuntimeSkillApplication,
  });
  const application = composeProcessLocalApplication({
    eventBus: options.eventBus,
    usageCommits: sessionSystem.usage.commits,
    compatibility: options.compatibility,
    listRuntimeSkills: (request) => skill.listRuntimeSkills(request),
    plugins: owners.plugin.plugin,
    pluginControl: owners.plugin,
    miniApp: owners.miniAppComposition.services.miniApp,
    planEntryEnabled,
    sessionReports: sessionSystem.reporting,
    ...(owners.turnSystem.cacheWarming
      ? { cacheWarming: owners.turnSystem.cacheWarming }
      : {}),
    // W1 §3.2 (review round 1): the publisher's publish-stale flag is
    // consumable from the status surfaces (`mcode daemon status`) through the
    // application diagnostics seam, not just the owner object.
    ...(sessionSystem.durableJsonlPublisher
      ? {
          publishStatus: {
            staleSessions: () =>
              sessionSystem.durableJsonlPublisher!.publishStaleSessions(),
          },
        }
      : {}),
    instructions: {
      listSources: (input) =>
        readLocalInstructionSources({ ...input, dataDir: options.dataDir }),
    },
    mcp: owners.mcp.public,
    modelProvider: {
      application: modelProviderApplication,
      providers: modelSystem.providers,
      listProviderPresets: modelSystem.listProviderPresets,
      oauth: modelSystem.oauth,
      favorites: new ModelFavoritesPreference(options.db),
    },
  });
  if (owners.cron)
    options.compatibility.cron.bindAgentCleanup(owners.cron.service);
  const cronDelivery = createOptionalCronDelivery(
    owners.cron,
    options,
    owners.turnSystem,
    product,
  );
  const lifecycle = createRuntimeServicesLifecycle({
    recoverPersistedState: options.recoverPersistedState,
    state,
    bindGlobalEventPublisher: () =>
      options.compatibility.events.bindPublisher(writeGlobalEvent),
    reportFailure: options.compatibility.agentHost.executor.reportFailure,
    bindConversation: () =>
      options.compatibility.conversation.bind(owners.runtimeConversation),
    recoverQuestionnaires: async () =>
      void (await options.compatibility.questionnaires
        .createService()
        .recoverOnStartup()),
    shutdownConversation: () => options.compatibility.conversation.shutdown(),
    disposePluginHookSessions: disposeLocalPluginHookSessions,
    sessionSystem,
    workspaceGit: workspace.git,
    workspaceHtmlPreview: workspace.htmlPreview,
    sandbox,
    closeBrowserUse: browserUseComposition.close,
    ...owners,
  });
  const notifyAuthContextChanged = configureRuntimePluginHooks({
    ...options,
    plugin: owners.plugin,
    turnSystem: owners.turnSystem,
  });
  const promptLifecycle = bindRuntimeServicePromptLifecycle({
    compatibility: options.compatibility,
    support: promptSupport,
    lifecycle,
  });
  ownerLifecycle.bind(promptLifecycle);
  return {
    agent: owners.agentApplication,
    safety,
    sessionPermissionModes,
    canvas,
    cron: owners.cron?.service,
    ...(cronDelivery ? { cronDelivery } : {}),
    globalEvents: createRuntimeGlobalEventSubscription(options.eventBus),
    managedWorktrees: options.compatibility.managedWorktrees,
    workspace,
    sessionSystem,
    pinService,
    globalInstructions,
    agentFavorites: new AgentFavorites(options.db, options.agentService),
    composerSendBehavior: new ComposerSendBehaviorPreference(options.db),
    ...(channelSystem ? { channelSystem } : {}),
    turnSystem: owners.turnSystem,
    browserUse: browserUseComposition.service,
    conversation,
    applications: owners.applications,
    application,
    plugin: owners.plugin.plugin,
    mcp: owners.mcp.service,
    mcpRuntime: owners.mcp.runtime,
    modelSystem,
    modelProviderApplication,
    skill,
    sandbox,
    ...(inspector ? { llmContextInspector: inspector.service } : {}),
    ...(orchestration ? { orchestration: orchestration.orchestration } : {}),
    ...owners.miniAppComposition.services,
    notifyAuthContextChanged: createRuntimePromptAuthNotifier(
      notifyAuthContextChanged,
      promptConfig,
    ),
    builtinAgentDefinitionsReady: lifecycle.builtinAgentDefinitionsReady,
    ready: owners.miniAppComposition.ready,
    close: orchestration
      ? async () => {
          // The ONE pi scheduler closes BEFORE the session system disposes
          // the shared storage (lifecycle order: orchestration → owners →
          // sessionSystem → durableHistory backend).
          try {
            await owners.miniAppComposition.close();
          } finally {
            await orchestration.orchestration.close();
          }
        }
      : owners.miniAppComposition.close,
  };
}

function createRuntimeGlobalEventSubscription(
  eventBus: EventBusClient<GlobalEvent>,
): Pick<EventBusClient<GlobalEvent>, "subscribe"> {
  return { subscribe: (subscriber) => eventBus.subscribe(subscriber) };
}

function createServiceGlobalEventWriter(
  options: CreateRuntimeServicesOptions,
  state: RuntimeServiceState,
  browserUse: BrowserUseService,
  sandbox: LocalSandboxService,
) {
  return composeRuntimeGlobalEventWriter({
    isClosed: () => state.closed,
    nowMs: options.nowMs ?? Date.now,
    notifyContextReset: (sessionId) => browserUse.notifyContextReset(sessionId),
    notifySessionDeleted: (sessionId) => browserUse.clearSession(sessionId),
    notifyGreetingTurnTerminal: (turnId, status) =>
      state.agentApplication?.notifyGreetingTurnTerminal?.(turnId, status),
    observeTurn: (input) => sandbox.observeTurn(input),
    write: (event) => options.eventBus.write(event),
  });
}

async function initializeRuntimeServiceOwners(
  input: RuntimeServiceOwnerInitializationInput,
): Promise<InitializedRuntimeServiceOwners> {
  const pluginLogger = resolvePluginServiceLogger(input.options.logger);
  let plugin: ReturnType<typeof initializePluginService> | undefined;
  let mcp: InitializedMcpService | undefined;
  let turnSystem: TurnSystemOwner | undefined;
  let cron: InitializedCronService | undefined;
  let miniAppComposition: RuntimeMiniAppComposition | undefined;
  let resumeSessionDeletion: ((sessionId: string) => Promise<void>) | undefined;
  try {
    mcp = initializeMcpService({
      ...input.options.compatibility.mcp,
      dataDir: input.options.dataDir,
      nowMs: input.nowMs,
      metrics: input.options.metrics,
    });
    const mcpRuntime = mcp.runtime;
    plugin = initializePluginService(
      {
        ...input.options.compatibility.plugin,
        mcp: mcpRuntime,
        listReservations: createPluginNameReservations(
          input.options.compatibility.plugin.skill,
          mcpRuntime,
        ),
        database: input.options.db,
        logger: pluginLogger,
      },
      input.turnCapabilities,
      deactivateLocalPluginHooks,
    );
    bindTaskAgentBindingCapture(input, { plugin, mcp }, pluginLogger);
    miniAppComposition = await composeMiniAppRuntimeCapability({
      options: resolveRuntimeMiniAppOptions(input.options),
      db: input.options.db,
      dataDir: input.options.dataDir,
      nowMs: input.nowMs,
      plugin,
      readyOwners: input.readyOwners,
      closeOwners: input.closeOwners,
    });
    const miniAppLifecycle = createHostSessionMiniAppLifecycle({
      plugins: plugin,
      supervisor: miniAppComposition.services.miniApp,
      sessions: input.sessionSystem.sessions.repository,
      surface: input.options.compatibility.miniAppSurface,
      logger: pluginLogger,
    });
    const miniAppExtensions = miniAppLifecycle
      ? [createMiniAppControlExtension(miniAppLifecycle)]
      : [];
    const plan = initializePlanService({
      db: input.options.db,
      modes: input.sessionSystem.sessions.interactionMode,
      documents: input.sessionSystem.planDocuments,
      questionnaires: input.options.compatibility.questionnaires,
      queue: input.sessionSystem.queue.committed,
      receipts: {
        findReceipt: (turnId) =>
          requireTurnSystem(turnSystem).receipts.findReceipt(turnId),
      },
      dispatchQueue: (sessionId) =>
        requireTurnSystem(turnSystem).turns.dispatchQueue(sessionId),
      entryEnabled: input.planEntryEnabled,
      agentEntryEnabled: input.agentPlanEntryEnabled,
      reportFailure: (error) => {
        input.product.executor.reportFailure?.(
          "plan-lifecycle",
          `owner=plan;stage=lifecycle-reconcile;error=${describeError(error)}`,
        );
      },
      nowMs: input.nowMs,
    });
    bindConversationMutationPlanState({
      mutationState: input.sessionSystem.conversationMutationState,
      modes: input.sessionSystem.sessions.interactionMode,
      lifecycleFence: plan.lifecycleFence,
    });
    const subagentVerification = createGoalSubagentVerifierRuntime({
      createExecution: (registry) =>
        input.options.compatibility.sessionV2.goals.createSubagentExecution?.(
          registry,
        ),
      config: input.product.preparation.configBuilder.config,
      nowMs: input.nowMs,
    });
    turnSystem = await initializeRuntimeTurnSystem(input, {
      plan,
      planEntryEnabled: input.planEntryEnabled,
      normalExtensions: miniAppExtensions,
      resumeSessionDeletion: (sessionId) => {
        if (!resumeSessionDeletion) {
          throw new Error(
            `Session deletion recovery is not bound: ${sessionId}`,
          );
        }
        return resumeSessionDeletion(sessionId);
      },
      disposeMcpSession: (sessionId) => mcpRuntime.disposeSession(sessionId),
      goalVerifierExtension: subagentVerification.extension,
      goalVerifierOutputTokenCap: subagentVerification.outputTokenCap,
    });
    const turnSystemForProbe = turnSystem;
    input.sessionPermissionTurnProbe.read = (sessionId) =>
      turnSystemForProbe.inspection?.activeTurnId(sessionId) !== undefined;
    const sessionApplications = await initializeSessionApplications(
      input,
      turnSystem,
      plugin,
      (sessionId) => cron?.isSessionOwnedByDefinition(sessionId) ?? false,
    );
    cron = input.enableCron
      ? initializeRuntimeCron(
          input,
          turnSystem,
          sessionApplications.applications,
          sessionApplications.sessionApplications.session.lifecycle,
        )
      : undefined;
    input.options.compatibility.sessionV2.goals.bindAutomationOwnerConflictReader?.(
      (sessionId) =>
        cron ? hasActiveCronSessionOwner(cron.service, sessionId) : false,
    );
    resumeSessionDeletion = (sessionId) =>
      sessionApplications.applications.session.lifecycle.deleteSessionById(
        sessionId,
      );
    const evaluatorVerifier = createGoalEvaluatorVerifier({
      tuiProductPolicy: input.options.runtimeOwnerKind === "tui",
      sessions: input.sessionSystem.sessions.execution,
      agents: input.product.agents,
      preparation: input.preparation,
      config: input.product.preparation.configBuilder.config,
      nowMs: input.nowMs,
    });
    input.options.compatibility.sessionV2.goals.bindVerifier?.(
      {
        dispatch: (attempt, signal) =>
          attempt.backend === "subagent"
            ? subagentVerification.verifier.dispatch(attempt, signal)
            : evaluatorVerifier.dispatch(attempt, signal),
      },
      createGoalVerificationTranscriptReader(
        input.sessionSystem.canonicalHistory,
      ),
    );
    return {
      plan,
      turnSystem,
      cron,
      plugin,
      miniAppComposition,
      mcp,
      agentApplication: sessionApplications.agentApplication,
      runtimeConversation: sessionApplications.runtimeConversation,
      applications: sessionApplications.applications,
      sessionApplications: sessionApplications.sessionApplications,
    };
  } catch (error) {
    input.options.compatibility.conversation.fail(error);
    await closeRuntimeServiceOwnersAfterFailure({
      cron,
      turnSystem,
      plugin,
      mcp,
      sessionSystem: input.sessionSystem,
      miniApp: miniAppComposition?.services.miniApp,
    });
    throw error;
  }
}

type PromptBoundRuntimeServiceOwnerInput = Omit<
  RuntimeServiceOwnerInitializationInput,
  "channelSystem" | "messageDelivery" | "turnLifecycleEvents"
> & {
  readonly promptSupport: RuntimePromptSupport;
  readonly enableChannel: boolean;
};

async function initializePromptBoundRuntimeServiceOwners(
  input: PromptBoundRuntimeServiceOwnerInput,
): Promise<{
  readonly channelSystem: ChannelSystemOwner | undefined;
  readonly owners: InitializedRuntimeServiceOwners;
  readonly queryCollapseKeys: ReturnType<typeof createQueryCollapseKeyResolver>;
}> {
  return withRuntimePromptSupportRollback(input.promptSupport, async () => {
    const channelSystem = initializeOptionalChannelSystem(input.enableChannel, {
      messages: input.sessionSystem.messages.repository,
      sessions: input.sessionSystem.sessions.repository,
      product: input.options.compatibility.channel,
    });
    const queryCollapseKeys = createQueryCollapseKeyResolver({
      state: input.sessionSystem.queryCollapse.state,
      messages: input.sessionSystem.messages.repository,
      getGoalBySession:
        input.options.compatibility.sessionV2.goals.getBySession,
    });
    const messageDelivery = createRuntimeMessageDelivery(
      input.sessionSystem,
      channelSystem,
      queryCollapseKeys,
    );
    const turnLifecycleEvents = createSessionTurnLifecycleEvents(
      input.sessionSystem.sessions.repository,
      input.writeGlobalEvent,
      input.product.terminalMemory,
    );
    const owners = await initializeRuntimeServiceOwners({
      ...input,
      channelSystem,
      messageDelivery,
      turnLifecycleEvents,
    });
    return { channelSystem, owners, queryCollapseKeys };
  });
}

interface RuntimeServiceOwnerInitializationInput
  extends Pick<RuntimeServices, "canvas"> {
  readonly options: ResolvedCreateRuntimeServicesOptions;
  readonly processStartedAtMs: number;
  readonly product: ProductionSessionComposition["product"];
  readonly preparation: ProductionSessionComposition["preparation"];
  readonly sessionSystem: SessionSystemOwner;
  readonly pinService: PinService;
  readonly archiveTitleModel: ProductionSessionComposition["archiveTitleModel"];
  readonly facts: ProductionSessionComposition["facts"];
  /** §2.1 registry — shared instance for this runtime process. */
  readonly sessionPermissionModes: SessionPermissionModeRegistry;
  /** Late-bound Turn probe feeding the registry's `turn_active` refusal. */
  readonly sessionPermissionTurnProbe: { read?: (sessionId: string) => boolean };
  readonly safety: ContentSafetyService;
  /** Electron-only channel feedback capability; absent on embedded CLI. */
  readonly channelSystem: ChannelSystemOwner | undefined;
  readonly messageDelivery: UserMessageTurnDelivery;
  readonly turnLifecycleEvents: SessionTurnLifecycleEventObserver;
  readonly turnCapabilities: AgentHostTurnCapabilityLifecycle;
  readonly agentSessionPorts: ReturnType<typeof createAgentSessionPorts>;
  readonly agentService: LocalAgentService;
  readonly internalTurnPromptReads: InternalTurnPromptReadRegistry;
  readonly writeGlobalEvent: (event: GlobalEventInput) => void;
  readonly nowMs: () => number;
  readonly enableCron: boolean;
  /** W10 durable mode: the bridge-backed scheduler client replacing the croner one. */
  readonly schedulerOverride?: SchedulerClient;
  readonly foregroundLoop?: RuntimeOrchestration["foregroundLoop"];
  readonly runtimeOwnerIdentity: RuntimeOwnerIdentity;
  readonly planEntryEnabled: () => boolean;
  readonly agentPlanEntryEnabled: () => boolean;
  readonly inspector: ComposedInspector | undefined;
  readonly readyOwners: () => Promise<void>;
  readonly closeOwners: () => Promise<void>;
  /** Ш1/Ш2: the runtime's single durable-history storage; present only in durable mode. */
  readonly durableHistory?: DurableHistoryStorage;
}

interface RuntimeTurnSystemInitializationDeps {
  readonly plan: PlanService;
  readonly planEntryEnabled: () => boolean;
  readonly normalExtensions: readonly AgentExtension[];
  readonly resumeSessionDeletion: (sessionId: string) => Promise<void>;
  readonly disposeMcpSession: (sessionId: string) => Promise<void>;
  readonly goalVerifierExtension: GoalSubagentVerifierRuntime["extension"];
  /** Host-clamped attempt cap the verifier child's provider requests must obey. */
  readonly goalVerifierOutputTokenCap: GoalSubagentVerifierRuntime["outputTokenCap"];
}

async function initializeRuntimeTurnSystem(
  input: RuntimeServiceOwnerInitializationInput,
  dependencies: RuntimeTurnSystemInitializationDeps,
): Promise<TurnSystemOwner> {
  const {
    plan,
    planEntryEnabled,
    normalExtensions,
    resumeSessionDeletion,
    goalVerifierExtension,
    goalVerifierOutputTokenCap,
  } = dependencies;
  const llmRetryObserver = createSessionLLMRetryEventObserver(
    input.writeGlobalEvent,
  );
  let agentRuntime: AgentHostRuntimeLifecycle | undefined;
  input.options.compatibility.backgroundTasks.bindRuntimeOwner({
    ownerId: input.runtimeOwnerIdentity.createOwnerId("background-task"),
    isOwnerAlive: input.runtimeOwnerIdentity.isOwnerAlive,
  });
  // Ш6: the delegation-steering composition lives on the SYSTEM log (owner
  // decision 2026-11-18: the seam's records are runtime-level, keyed by
  // delegation ids — the one shared substrate beside the orchestration
  // bridges). Daemon-owned runtimes compose it exactly as before; embedded
  // per-session runtimes and the jsonl default pass nothing: the steer
  // service keeps the pre-durable behavior in both cases.
  const delegationSteering = input.durableHistory?.system
    ? await createRuntimeDelegationSteeringComposition({
        system: input.durableHistory.system,
      })
    : undefined;
  // W06 cache warming: the ONE per-session CacheWarmer controller, composed
  // into every agent turn's MAIN stream path (see createHost below). W10 part
  // B binds the `cache_warm` billing mirror: in durable mode the mcode.usage
  // entries ride the SAME Ш1 durable log as the canonical history and the
  // checkpoint barrier (one worker per runtime); the jsonl default keeps the
  // documented degradation (no medium, warmer logging records the spend).
  const sessionCacheWarming = createSessionCacheWarming(
    input.durableHistory
      ? {
          appendUsage: createDurableHistoryCacheWarmUsageSink(input.durableHistory),
        }
      : {},
  );
  // W10 `/session` warmer status: the owner-facing slice of the controller
  // (the application layer reads it for the usage/status inspection).
  const ownerCacheWarmingSurface = {
    describeStatus: (sessionId: string) => sessionCacheWarming.describeStatus(sessionId),
  };
  try {
    const durableJsonlPublisher = input.sessionSystem.durableJsonlPublisher;
    const owner = await initializeTurnSystem({
    db: input.options.db,
    userStop: input.options.compatibility.backgroundTasks.userStop,
    sessionPermissionModes: input.sessionPermissionModes,
    ...(input.options.logger ? { logger: input.options.logger } : {}),
    sessions: input.sessionSystem,
    processStartedAtMs: input.processStartedAtMs,
    // I-PUB-1b (W1): the turn-end jsonl flush completes before the turn lease
    // is released — the point F8 (settleAndRelease, after the last durable
    // write of the turn). Durable mode only; jsonl mode keeps the absent
    // option and today's behavior.
    ...(durableJsonlPublisher
      ? {
          publishBeforeRelease: ({ sessionId }: { readonly sessionId: string }) =>
            durableJsonlPublisher.flushBeforeRelease(sessionId),
        }
      : {}),
    makeLeaseId: () => input.runtimeOwnerIdentity.createOwnerId("turn-lease"),
    makeDeletionOwnerId: () =>
      input.runtimeOwnerIdentity.createOwnerId("session-delete"),
    isLeaseOwnerAlive: input.runtimeOwnerIdentity.isOwnerAlive,
    isLeaseOwnerCurrent: input.runtimeOwnerIdentity.ownsOwnerId,
    runtimeRecoveryRetryMs: input.runtimeOwnerIdentity.recoveryRetryMs,
    ...(input.options.recoverPersistedState !== false
      ? {
          onRuntimeRecovery:
            input.options.compatibility.backgroundTasks.recover,
          pollRuntimeRecovery:
            input.options.compatibility.backgroundTasks.pollRecovery,
        }
      : {}),
    resumeSessionDeletion,
    // Decision v5: teardown fall-to-session uses the delivery service's
    // consumeSteering directly — the wrapped handler above would publish a
    // `session.start` no ended Turn should emit.
    commitSteeringTeardownProjection: (steer) =>
      input.messageDelivery.consumeSteering(steer),
    createHost: async ({
      turnControl,
      turnFacts,
      pluginHookSessionOwnership,
    }) => {
      const goalFinalReply = createGoalFinalReply();
      // Post-turn next-message suggestion (upstream 0.7.2 prompt-suggestion).
      // The upstream open-source release ships the service WITHOUT a
      // composition root; this is ours. The TUI-sender gate lives in the
      // capture (provenance sourceContext.surface === 'interactive'), so
      // headless clients (ACP/exec) never generate a request. The user switch
      // is `promptSuggestion.enabled` in config.yaml; there is no remote
      // rollout policy in this build, so absent = on for TUI turns.
      const promptSuggestionService = createPromptSuggestionService({
        enabled: () => {
          const config = input.product.preparation.configBuilder.config();
          return resolvePromptSuggestionEnabled(config.promptSuggestion?.enabled, undefined);
        },
        publish: (event) => input.writeGlobalEvent(event),
        review: async (text) => {
          const result = await input.safety.review(text, SAFETY_SCENE.MessageOutput);
          // A refusal must be diagnosable AND must not hide the feature when
          // the review gateway simply does not answer (owner decision
          // 2026-11-16: no gateway answer → show the chip; a real moderation
          // reject still hides it, with the offending text in the log).
          if (!result.pass) {
            promptSuggestionLog.warn('prompt suggestion safety verdict', {
              error_kind: result.errorKind ?? 'rejected',
              ...(result.errorKind === 'local_error'
                ? {}
                : { content_head: text.slice(0, 300) }),
            });
            // An unreachable/timeout gateway (local_error) is a transport
            // failure, not a moderation verdict: degrade-pass for the chip.
            // auth_error keeps the fail-closed semantics (a rejected token is
            // an account-level signal, not a transport blip).
            if (result.errorKind === 'local_error') return true;
          }
          return reviewBlocks(result);
        },
        policy: () => ({ killSwitch: false, sampleRate: 1 }),
        identity: {
          // Stable per daemon process: results live at most TTL minutes and are
          // never serialized, so a process-local key is sufficient isolation.
          identity: () => input.options.dataDir,
        },
        // Failures surface as WARN: without this the optional feature is
        // silent in BOTH directions (generated vs refused), which made the
        // first live check undiagnosable.
        log: (fields) =>
          promptSuggestionLog.warn('prompt suggestion event', fields),
      });
      const promptSuggestionPort: PromptSuggestionTurnPort = {
        enabled: () => promptSuggestionService.isEnabled(),
        // A new Turn of this Session supersedes any suggestion still generating.
        turnStarted: (sessionId) => promptSuggestionService.cancel(sessionId),
        committed: (scope, capture) =>
          promptSuggestionService.schedule(scope.sessionId, scope.turnId, capture, scope.messageId),
      };
      const production = await createLocalAgentHost({
        product: input.foregroundLoop
          ? { ...input.product, runner: { ...input.product.runner, runLoopForSession: input.foregroundLoop } }
          : input.product,
        db: input.options.db,
        preparation: input.preparation,
        sessions: input.sessionSystem,
        safety: input.safety,
        turnControl,
        turnFacts,
        publishCompactionProgress: input.writeGlobalEvent,
        promptSuggestion: promptSuggestionPort,
        pluginHookSessionOwnership,
        turnCapabilities: input.turnCapabilities,
        // `sessionTitle.enabled: false` disables title generation: wire a
        // no-op so no title model request is issued. Read from the injected
        // config source (same as beta/custom_provider above), default on.
        onInputReviewResolved:
          (input.product.preparation.configBuilder.config().sessionTitle
            ?.enabled ?? true)
            ? createApprovedTitleHandler(
                input.sessionSystem,
                input.product.executor.reportFailure,
              )
            : () => {},
        onSteeringConsumed: createConsumedSteeringHandler(
          input.messageDelivery,
          input.sessionSystem,
          input.writeGlobalEvent,
          input.product.executor.reportFailure,
        ),
        toolPolicyGuard: combineLocalTurnToolPolicyGuards(
          goalFinalReply.toolPolicyGuard,
          plan.toolGuard,
          createGoalBudgetToolPolicyGuard(),
        ),
        outputTokenCap: goalVerifierOutputTokenCap,
        resolveLlmRetry: () => ({ observer: llmRetryObserver, subscriptionQuota: input.options.subscriptionQuota }),
        // Reactive subagents §1.7 (wave 3): the sequential executor's
        // yield-to-owner-input probe over the steering composition's native
        // wait binding. jsonl (no delegationSteering) omits it — the batch
        // behavior stays exactly as before.
        ...(delegationSteering
          ? {
              resolveOwnerInputGeneration: ({ sessionId }: { sessionId: string; turnId: string }) => {
                const generation = () =>
                  Promise.resolve(delegationSteering.nativeWaits.ownerInputGeneration(sessionId));
                return generation;
              },
            }
          : {}),
        normalExtensions: [
          ...(!isLocalSourceProvenanceEnabled(input.options.runtimeOwnerKind)
            ? []
            : [
                createRuntimeSourceReferenceExtension(
                  input.options.compatibility.attachmentRegistration,
                ),
              ]),
          plan.extension,
          goalVerifierExtension,
          createGoalBudgetSummaryExtension(),
          goalFinalReply.extension,
          // М1: every tool-result image re-encodes to the requestMedia limits
          // once, on the after-tool seam; the browser preprocessor's stricter
          // post-action ceiling still wins for its own screenshots.
          createRequestMediaEncodingExtension({
            getImageEncoding: () => {
              const { image } = parseRequestMediaConfig(
                input.product.preparation.configBuilder.config().requestMedia,
              );
              return {
                maxWidth: image.max_width,
                maxHeight: image.max_height,
                maxBase64Bytes: image.max_base64_bytes,
              };
            },
          }),
          // М2: a response cut off by the output limit before any visible
          // reply is retried with a hint (transcript-counted), then fails
          // visibly; the context-overflow path (В1) stays separate.
          createOutputLimitRecoveryExtension(),
          ...normalExtensions,
        ],
        eventObserver: combineAgentEventObservers(
          ...(input.channelSystem ? [input.channelSystem.terminalReplies] : []),
          input.turnLifecycleEvents,
        ),
        nowMs: input.nowMs,
        ...(isCommandLineRuntimeOwner(input.options.runtimeOwnerKind)
          ? { cliProductPolicy: true }
          : {}),
        ...(input.options.runtimeOwnerKind === "tui"
          ? {
              tuiProductPolicy: true,
              contentReviewEnabled: getRuntimeRegion() === "cn",
            }
          : {}),
        ...(input.options.getRunawayGuardConfig
          ? { getRunawayGuardConfig: input.options.getRunawayGuardConfig }
          : {}),
        ...(input.options.getToolResultCompactionConfig
          ? {
              getToolResultCompactionConfig:
                input.options.getToolResultCompactionConfig,
            }
          : {}),
        // Ш2: the fail-closed checkpoint barrier is composed around the
        // runtime's single durable storage worker — present (and active)
        // only in durable mode; jsonl keeps the dormant-by-composition path.
        ...(input.durableHistory
          ? { checkpointStorageWorker: input.durableHistory.worker }
          : {}),
        // W06: the session cache-warming controller (MCODE_CACHE_WARMING,
        // product default "off" — donor "streaming" is opt-in); absent
        // sessions keep the legacy path.
        cacheWarming: sessionCacheWarming,
      });
      agentRuntime = production.lifecycle;
      // W10 (review w10-review-p1 item 1): in durable mode the product turn
      // path runs through the durable turn-driver — composeProductTurnDriver
      // over the runtime's REAL pi composition root (the same ONE storage as
      // the canonical history, the checkpoint barrier and the orchestration
      // scheduler), delegating every turn step to the part-A product loop
      // (the existing executor) through the TurnStepExecutor seam. jsonl
      // compatibility mode keeps the direct part-A host — the mode follows
      // MCODE_HISTORY_PROVIDER exactly like the history resolver (no
      // separate behavioral flag).
      const durableStores = input.durableHistory;
      const host = durableStores
        ? withProductTurnDriver({
            // Per-session model: the driver's durable state rides the
            // SESSION's own pi root (its port and bridge conversation are
            // file-local), so driver checkpoints coexist across processes
            // exactly like the history files.
            rootOfSession: (sessionId) => durableStores.piOf(sessionId),
            host: production.host,
            sessions: input.sessionSystem.sessions.repository,
            agents: input.product.agents,
            canonicalHistory: input.sessionSystem.canonicalHistory,
            ...(input.nowMs ? { nowMs: input.nowMs } : {}),
          })
        : production.host;
      return host;
    },
    disposeRuntimeSession: async (sessionId) => {
      try {
        await requireAgentRuntime(agentRuntime).disposeSession(sessionId);
      } finally {
        input.sessionPermissionModes.release(sessionId);
        sessionCacheWarming.disposeSession(sessionId);
        await dependencies.disposeMcpSession(sessionId);
      }
    },
    admissionPolicy: composeTurnAdmissionPolicies(
      plan.admission,
      createMemoryRecallAdmissionPolicy(),
    ),
    submissionPreparation: composeTurnSubmissionPreparations(
      createPlanEntrySubmissionPreparation(plan),
      createGoalTurnSubmissionPreparation({
        prepare:
          input.options.compatibility.sessionV2.goals.prepareTurnAdmission,
        hasPendingPlan: (sessionId) =>
          plan.lifecycleFence.blocks({ sessionId }),
        hasPriorityMailboxWork: async (sessionId) =>
          hasPriorityUserQueueItem(
            await input.sessionSystem.queue.committed.list(sessionId),
          ),
      }),
    ),
    forkProjections: {
      forkPrefix: async (request) => {
        const sourcePlan =
          await input.sessionSystem.planDocuments.resolveAndEnsure(
            request.sourceSessionId,
          );
        await input.options.compatibility.sessionV2.diff.capability.forkPrefix({
          ...request,
          excludedFilePaths: [sourcePlan.canonicalPath],
        });
      },
    },
    rewindProjections: {
      preflight: (request) =>
        input.options.compatibility.sessionV2.diff.rewind.preflight(request),
      apply: (request) =>
        input.options.compatibility.sessionV2.diff.rewind.apply(request),
      deleteTurns: async (request) => {
        await input.options.compatibility.sessionV2.diff.rewind.deleteTurns(
          request,
        );
        await input.inspector?.service.deleteTurns(
          request.sessionId,
          request.turnIds,
        );
      },
    },
    onTurnDiffRewindSkipped: (event) =>
      input.options.logger?.warn(
        { ...event },
        "Turn diff rewind phase skipped",
      ),
    ...createRuntimeQueueSelection({
      questionnaires: input.options.compatibility.peripherals.questionnaires,
      goals: input.options.compatibility.sessionV2.goals,
      queue: input.sessionSystem.queue.committed,
      lifecycleFence: plan.lifecycleFence,
      entryEnabled: planEntryEnabled,
    }),
    createMessageDelivery: createTurnSystemMessageDelivery(
      input.messageDelivery,
    ),
    ...(input.product.turnSettlement
      ? { turnSettlement: input.product.turnSettlement }
      : {}),
    onQueueWakeFailure: createQueueWakeFailureReporter(
      input.product.executor.reportFailure,
      "turn_submit_queue_wake_failed",
    ),
    onRuntimeRecoveryFailure: createQueueWakeFailureReporter(
      input.product.executor.reportFailure,
      "runtime_recovery_failed",
    ),
    ...(delegationSteering ? { delegationSteering } : {}),
    nowMs: input.nowMs,
    });
    if (!delegationSteering) {
      // W10: the warmer status rides the owner (`/session`-status surface)
      // and every warmed run cancels with the turn system even when the
      // durable steering composition is absent (default jsonl mode).
      const closeTurnSystemPlain = owner.close.bind(owner);
      return {
        ...owner,
        cacheWarming: ownerCacheWarmingSurface,
        close: async () => {
          try {
            await closeTurnSystemPlain();
          } finally {
            sessionCacheWarming.dispose();
          }
        },
      };
    }
    // The composition closes with the turn system — before the session-system
    // close disposes the shared storage worker and backend (lifecycle order:
    // turnSystem.close() runs first in the runtime services lifecycle).
    const closeTurnSystem = owner.close.bind(owner);
    return {
      ...owner,
      cacheWarming: ownerCacheWarmingSurface,
      // Native task-wait binding (verdict 09 §1.4): the host late-binds it
      // onto the API host (with the task-row projection) once both exist.
      nativeTaskWaits: delegationSteering.nativeWaits,
      close: async () => {
        try {
          await closeTurnSystem();
        } finally {
          sessionCacheWarming.dispose();
          await delegationSteering.close();
        }
      },
    };
  } catch (error) {
    if (delegationSteering) await delegationSteering.close();
    throw error;
  }
}

function initializeRuntimeCron(
  input: RuntimeServiceOwnerInitializationInput,
  turnSystem: TurnSystemOwner,
  applications: RuntimeApplications,
  lifecycle: Pick<SessionLifecycleService, "mutateSession">,
): InitializedCronService {
  const scheduler = input.schedulerOverride ?? input.options.scheduler;
  if (!scheduler) {
    throw new Error("Runtime Cron services require an owned Scheduler client.");
  }
  const sessionPorts =
    input.options.overrides?.cron?.sessionPorts ??
    createRuntimeCronSessionPorts({
      agentSessionPorts: input.agentSessionPorts,
      sessions: input.sessionSystem,
      turns: turnSystem.turns,
      reportFailure: input.product.executor.reportFailure,
      lifecycle,
      deletion: applications.session.lifecycle,
      resolveDefaultWorkspaceDir:
        input.options.compatibility.sessionV2.workspace.defaultDirectory,
    });
  return initializeCronService({
    db: input.options.db,
    scheduler,
    ...(input.options.metrics ? { metrics: input.options.metrics } : {}),
    sessionPorts,
    modelSelection: {
      resolve: (model) =>
        resolveLocalRuntimeModelKey(
          input.product.preparation.configBuilder.config(),
          model,
        ),
    },
    nowMs: input.nowMs,
    recoverPendingRuns: input.options.recoverPersistedState !== false,
  });
}
async function initializeSessionApplications(
  input: RuntimeServiceOwnerInitializationInput,
  turnSystem: TurnSystemOwner,
  plugin: InitializedPluginService,
  isSessionOwnedByScheduledTask: (sessionId: string) => boolean,
): Promise<{
  readonly sessionApplications: InitializedSessionApplicationSystem;
  readonly applications: RuntimeApplications;
  readonly agentApplication: AgentApplication;
  readonly runtimeConversation: RuntimeConversation;
}> {
  const sessionApplications = initializeSessionApplicationSystem({
    owner: input.sessionSystem,
    pin: input.pinService,
    canvas: input.canvas,
    compatibility: input.options.compatibility.sessionV2,
    archiveTitleModel: input.archiveTitleModel,
    maintenance: turnSystem.maintenance,
    facts: input.facts,
    processStartedAtMs: input.processStartedAtMs,
    ...(input.product.promptSnapshots
      ? { promptSnapshots: input.product.promptSnapshots }
      : {}),
  });
  const applications = initializeApplications({
    sessionSystem: sessionApplications,
    compatibility: input.options.compatibility.sessionV2,
    attachmentRegistration: input.options.compatibility.attachmentRegistration,
    resolveAgentWriteTarget: input.agentSessionPorts.resolveWriteTarget,
    requireExactAgentKey: input.agentSessionPorts.requireExactAgentKey,
    ...createRuntimePluginSessionLifecycle(turnSystem, plugin),
    turn: turnSystem.turns,
    assertSessionDeletionAllowed: async (sessionId) => {
      if (isSessionOwnedByScheduledTask(sessionId)) {
        throw new AppError(
          409,
          "CRON_OWNED_SESSION",
          "This session is owned by a scheduled task. Delete the scheduled task instead.",
        );
      }
    },
    conversationMutationPort: input.sessionSystem.conversationMutationState,
    conversationMutationWorkflow: createProductionConversationMutationWorkflow({
      sessionFork: input.sessionSystem.fork,
      forkState: createForkState({
        ...input.options.compatibility.sessionV2,
        plan: {
          documents: input.sessionSystem.planDocuments,
          modes: input.sessionSystem.sessions.interactionMode,
        },
      }),
      sessionRewind: input.sessionSystem.messages.rewind,
      rewindPreview: input.options.compatibility.sessionV2.diff.rewind,
      operations: input.sessionSystem.sessions.operationIntents,
      mutationPlanState: input.sessionSystem.conversationMutationState,
      stream: input.sessionSystem.stream,
      turn: turnSystem.turns,
      trustedEditSubmission: turnSystem.trustedEditSubmission,
      questionnaires:
        input.options.compatibility.questionnaires.createService(),
      sessionPermissionModes: input.sessionPermissionModes,
      worktree: input.options.forkWorktree ?? unavailableForkWorktree,
      attachmentRegistration:
        input.options.compatibility.attachmentRegistration,
      publishGlobalEvent: input.writeGlobalEvent,
    }),
    publishGlobalEvent: input.writeGlobalEvent,
    ...(input.options.nowMs ? { nowMs: input.options.nowMs } : {}),
    ...(input.options.metrics ? { metrics: input.options.metrics } : {}),
    onRootBestEffortFailure: (failure) =>
      reportRootBestEffortFailure(
        input.product.executor.reportFailure,
        failure,
      ),
  });
  const agentApplication = createRuntimeAgentApplication(input, applications);
  const runtimeConversation = composeV1Conversation({
    attachmentRegistration: input.options.compatibility.attachmentRegistration,
    rootAgents: input.agentSessionPorts.roots,
    resolveAgentWriteTarget: input.agentSessionPorts.resolveWriteTarget,
    sessions: input.sessionSystem,
    turns: turnSystem.turns,
    lifecycle: sessionApplications.session.lifecycle,
    deletion: applications.session.lifecycle,
    root: applications.session.root,
    onQueueWakeFailure: createQueueWakeFailureReporter(
      input.product.executor.reportFailure,
      "conversation_queue_wake_failed",
    ),
  });
  return {
    sessionApplications,
    applications,
    agentApplication,
    runtimeConversation,
  };
}
function createOptionalCronDelivery(
  cron: InitializedCronService | undefined,
  options: CreateRuntimeServicesOptions,
  turnSystem: TurnSystemOwner,
  product: ProductionSessionComposition["product"],
): CronTurnDeliveryPort | undefined {
  return createOptionalRuntimeCronTurnDelivery(
    Boolean(cron),
    options.overrides?.cron?.turnDelivery,
    turnSystem.turns,
    product.executor.reportFailure,
  );
}
function initializeRuntimeSandbox(
  options: ResolvedCreateRuntimeServicesOptions,
) {
  return composeLocalSandboxService({
    ...options,
    configWriter: options.compatibility.sandbox.writeConfig,
    evalReporter: options.compatibility.sandbox.eval,
    sandboxDescriptors: options.overrides?.sandbox?.descriptors,
  });
}
