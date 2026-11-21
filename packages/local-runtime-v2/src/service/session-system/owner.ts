import type { AppDb } from '../../infra/db/client.js';
import path, { join } from 'node:path';
import { deleteLegacyDaemonSessionMessages } from '../../infra/legacy-db/cleanup.js';
import { createLegacyOpencodeReadonlySource } from '../../infra/legacy-db/readonly-source.js';
import {
  createSessionSystemAgentProjection,
  type SessionCompactionFactSink,
  type SessionConversationFactSink,
} from './agent-projection.js';
import { SessionFilesService } from './files/service.js';
import { createSessionForkDataCapability } from './fork/index.js';
import { createSessionAssetRepository } from './files/repo/assets.js';
import {
  createHistoryPersistenceRepository,
  createLegacyHistorySourceReader,
  LegacyOpencodeImporter,
  type LegacyCanonicalRecoveryEvent,
  type LegacyImportedAssetPort,
} from './legacy-migration/index.js';
import { createLegacySessionMigrationRepository } from './legacy-migration/repo/migration-repository.js';
import {
  createReleasedSessionHistoryReader,
  createSessionHistoryActivity,
  createSessionHistoryIoLane,
  createSessionHistoryLocationResolver,
  createSessionSystemCanonicalHistoryProvider,
  createSessionHistoryMutationAdapter,
  createSessionRewindCapability,
  ConversationActionProjectionService,
  MessageQueryService,
  SessionSourceQueryService,
  SessionInputSummaryService,
  UserMessageCommitService,
  type CanonicalHistoryMessage,
  type CanonicalHistoryPort,
  type SessionInputNavigationDiffReader,
  type SessionHistoryLocationResolver,
  type SessionSystemCanonicalHistoryProvider,
} from './messages/index.js';
import {
  createDurableSessionSystemCanonicalHistoryProvider,
  isExplicitDurableHistoryProviderMode,
  resolveHistoryProviderMode,
  wrapSessionHistoryMutationForDurable,
  type DurableHistoryStorage,
} from './messages/history/durable-canonical-history-provider.js';
// Wave 2 (canon 05 §2.5, item 2.1): the content-addressed image artifact
// store of this runtime — the durable log stores references, bytes live once
// under `<dataDir>/artifacts`.
import {
  ImageArtifactStore,
  resolveArtifactsDir,
} from './messages/history/image-artifact-store.js';
import {
  createDurableJsonlPublisher,
  resolveDurableJsonlPublishingEnabled,
  type DurableJsonlPublisher,
  type DurableJsonlPublisherFactory,
  type SessionPublishConflictInput,
} from './messages/history/durable-jsonl-publisher.js';
import { createLogger } from '@mavis/logging';
import { createMessageRepository } from './messages/repo/drizzle.js';
import { createSessionSourceProjectionRepository } from './messages/repo/source-query.js';
import { createQueryCollapseProjector } from './query-collapse-projector.js';
import { createQueryCollapseState } from './query-collapse-state.js';
import { SidebarQueryService } from './projects/sidebar/query.js';
import { initializeProjectDomain } from './projects/initialize.js';
import { createProjectRepository } from './projects/repo/drizzle.js';
import { CommittedQueueService } from './queue/committed-service.js';
import type { QueueCommittedFactSink } from './queue/committed-service.js';
import { QueueCommittedFactHub } from './queue/committed-fact-hub.js';
import { createQueueDispatchCapability } from './queue/dispatch-capability.js';
import { createQueueRepository } from './queue/repo/drizzle.js';
import { QueueService, type QueueServiceOptions } from './queue/service.js';
import { createQueueTurnAdmissionPriorityFence } from './queue/turn-priority-fence.js';
import type { QueueClaimAcceptanceLookup, QueueRepositoryOptions } from './queue/repo/contract.js';
import { initializeSessionDomain } from './sessions/initialize.js';
import { createSessionInteractionModeCapability } from './sessions/interaction-mode-capability.js';
import {
  createSessionExecutionSource,
  createSessionStateWriter,
} from './sessions/recovery/capabilities.js';
import { createSessionRepository } from './sessions/repo/drizzle.js';
import { SessionActivationService } from './sessions/lifecycle/activation-service.js';
import {
  createNativeSessionRecordService,
  type NativeSessionAgentDirectory,
} from './sessions/support/native-record-factory.js';
import type { SessionBackfillDiagnostics } from './sessions/lifecycle/record-service.js';
import { SessionArtifactService } from './sessions/support/artifact-service.js';
import { createPlanDocumentOwner } from './sessions/support/plan-document.js';
import { SessionDeletionGate } from './sessions/lifecycle/deletion-gate.js';
import {
  createConversationMutationState,
  createSessionOperationIntentRepository,
} from './mutation/index.js';
import { SessionRecoveryService } from './sessions/recovery/recovery-service.js';
import {
  RootSessionInvariantService,
  type RootAgentPort,
} from './sessions/root/root-invariant-service.js';
import {
  SessionTitleService,
  type SessionFactSink,
  type SessionRecordServiceDeps,
  type SessionTitleServiceOptions,
} from './sessions/index.js';
import { SessionStreamService } from './stream/session-stream-service.js';
import { createSessionUsageRepository } from './usage/repo/drizzle.js';
import { recordCommittedPiUsage } from './usage/pi-usage.js';
import { SessionUsageService } from './usage/service.js';
import { createSessionUsageCommitSignal } from './usage/commit-signal.js';
import { SessionLlmCallReportStore, SessionReportService } from '@mavis/session-report';
import { createSessionStorageRetention } from './storage-retention.js';
import {
  repairRootProjectHistory,
  type RootProjectHistoryRepairDiagnostics,
} from './_migration-root-project-history-repair.js';
import {
  repairLegacyDefaultProjectHistory,
  type LegacyDefaultProjectHistoryRepairDiagnostics,
} from './projects/legacy-default-project-history-repair.js';

export interface InitializeSessionSystemOptions {
  readonly db: AppDb;
  /** Disable citation history projection without changing ordinary message persistence. */
  readonly sourceProjectionEnabled?: boolean;
  readonly dataDir: string;
  readonly agents: NativeSessionAgentDirectory;
  readonly rootAgents: RootAgentPort;
  readonly defaultWorkspaceDir: () => string;
  readonly titlePolicy: SessionRecordServiceDeps['titlePolicy'];
  readonly resolveRequestedModel?: SessionRecordServiceDeps['resolveRequestedModel'];
  readonly facts: SessionFactSink;
  readonly conversationFacts: SessionConversationFactSink;
  readonly compactionFacts?: SessionCompactionFactSink;
  readonly compactionMetrics?: Parameters<
    typeof createSessionSystemAgentProjection
  >[0]['compactionMetrics'];
  readonly title: Pick<SessionTitleServiceOptions, 'model' | 'onOutcome' | 'onFailure'>;
  readonly queueFacts: QueueCommittedFactSink;
  readonly resolveQueueModel?: QueueServiceOptions['resolveModel'];
  readonly legacyMigration: {
    readonly primaryAgentName: string;
    readonly assets: LegacyImportedAssetPort;
    readonly onCanonicalRecovery?: (event: LegacyCanonicalRecoveryEvent) => void;
  };
  readonly inputNavigationDiffs: SessionInputNavigationDiffReader;
  /** Injected steered-provenance derivation for stream projection query keys. */
  readonly steeringProjection?: (queryKey: string) => Readonly<Record<string, unknown>>;
  readonly onPinnedSessionImported?: (sessionId: string) => Promise<void>;
  readonly makeSessionId?: () => string;
  readonly nowMs?: () => number;
  /**
   * Best-effort diagnostics for the startup full-Session-definition backfill.
   * Production passes a logger-backed sink; tests may inject a spy or omit.
   */
  readonly backfillDiagnostics?: SessionBackfillDiagnostics;
  /** Best-effort repair for a narrowly proven historical root Project misclassification. */
  readonly rootProjectHistoryRepairDiagnostics?: RootProjectHistoryRepairDiagnostics;
  /** Best-effort repair for historical default roots left on a workspace Project. */
  readonly legacyDefaultProjectHistoryRepairDiagnostics?: LegacyDefaultProjectHistoryRepairDiagnostics;
  /** Existing Agent config read used to prove Custom root incarnations during startup repair. */
  readonly getAgentOwnerIdentity?: Parameters<
    typeof repairLegacyDefaultProjectHistory
  >[0]['getAgentOwnerIdentity'];
  readonly storageRetention?: {
    readonly pruneTurnDiffs: (cutoffMs: number, batchSize: number) => Promise<unknown>;
    readonly logger?: {
      warn(fields: Record<string, unknown>, message: string): void;
    };
  };
  readonly runtimeOwnerIdentity?: {
    createOwnerId(kind: 'queue-claim'): string;
    isOwnerAlive(ownerId: string): boolean | undefined;
  };
  /**
   * Ш1: the runtime's single durable-history storage (`services.ts` opens it
   * only when `MCODE_HISTORY_PROVIDER=durable`). When present in durable
   * mode, the canonical history is served by the durable provider on top of
   * it; absent (or jsonl mode) keeps the exact legacy JSONL provider. The
   * session-system `close()` disposes the injected storage.
   */
  readonly durableHistory?: DurableHistoryStorage;
  /**
   * W1 §3.4 (review round 1): observer for the foreign-rewrite-vs-unpublished-
   * durable-tail conflict of the jsonl publisher. The product composition
   * turns it into a `session.publish_conflict` global event (the window shows
   * a banner-class warning); tests may inject a spy. Durable mode only.
   */
  readonly onSessionPublishConflict?: (input: SessionPublishConflictInput) => void;
}

/** Lifecycle + provider-selection seam of the session-system history composition. */
const runtimeHistoryLog = createLogger('mcode:turn');

/** One production graph over the shared AppDb; repositories never own the connection. */
export function initializeSessionSystem(options: InitializeSessionSystemOptions) {
  const nowMs = options.nowMs ?? Date.now;
  const { sessions, historyLocations, interactionMode, planDocuments } =
    createSessionMetadataCapabilities(options, nowMs);
  const deletionGate = new SessionDeletionGate({ db: options.db });
  const messages = createMessageRepository({
    db: options.db,
    sourceProjectionEnabled: options.sourceProjectionEnabled,
    nowMs,
    userMessageAdmission: deletionGate.turnAdmission,
  });
  const usage = createSessionUsageRepository({ db: options.db });
  const usageCommits = createSessionUsageCommitSignal();
  const projects = createProjectRepository({ db: options.db });
  const assets = createSessionAssets(options, sessions);
  const operationIntents = createSessionOperationIntentRepository({ nowMs });
  const conversationMutationState = createConversationMutationState(options.db, operationIntents);
  const rewind = createSessionRewindCapability({ db: options.db, messages, sessions, nowMs });
  const turnAdmission = createTurnAdmission(deletionGate, operationIntents);
  const queueAdmission = createQueueAdmission(deletionGate, operationIntents);
  const legacyMigrations = createLegacyMigrations(options.db, nowMs);
  const queueRepository = createQueueRepository({
    db: options.db,
    nowMs,
    enqueueAdmission: queueAdmission,
    ...queueRuntimeOwnerOptions(options.runtimeOwnerIdentity),
  });
  const queueFacts = new QueueCommittedFactHub(options.queueFacts);
  const stream = new SessionStreamService({ messages, nowMs });
  const queryCollapseState = createQueryCollapseState({ db: options.db, nowMs });
  const { canonicalHistory, historyMutation, historyPersistence, llmCalls, reporting, durableJsonlPublisher } =
    createSessionHistoryCapabilities(options, sessions, historyLocations, nowMs);
  const { legacy, onLegacyCleanupError } = createLegacySessionCapabilities({
    options,
    migrations: legacyMigrations,
    sessions,
    messages,
    canonicalHistory,
    nowMs,
  });
  const storageRetention = createSessionStorageRetention({
    ...options.storageRetention,
    nowMs,
  });
  const records = createSessionRecordService({
    options,
    sessions,
    projects,
    canonicalHistory,
    nowMs,
  });
  const fork = createSessionForkDataCapability({
    sessions,
    records,
    messages,
    assets,
    historyMutation,
  });
  const roots = new RootSessionInvariantService({
    sessions,
    agents: options.rootAgents,
    creation: records,
    legacyRoot: legacy,
  });
  const activation = new SessionActivationService({
    writer: {
      reopenArchivedSession: (sessionId) => sessions.update(sessionId, { archived: false }),
    },
    facts: options.facts,
  });
  const titles = new SessionTitleService({
    sessions,
    commitTitle: createTitleCommitter(records, options.facts),
    ...options.title,
  });
  const sessionDomain = initializeSessionDomain({ repository: sessions, discovery: legacy });
  const recovery = new SessionRecoveryService({ sessions });
  const projectDomain = initializeProjectDomain({ repository: projects, sessions, nowMs });
  const queue = new CommittedQueueService({
    queue: new QueueService({
      store: queueRepository,
      sessions,
      nowMs,
      resolveModel: options.resolveQueueModel,
    }),
    facts: queueFacts,
  });
  const files = new SessionFilesService({ sessions, messages, assets, nowMs });
  const inputSummaries = createInputSummaries(options, sessions, legacy, files);
  const artifacts = new SessionArtifactService({
    queue,
    files,
    usage,
    messages,
    history: historyPersistence,
    onLegacyCleanupError,
    canonicalHistory,
    stream,
    reports: createSessionReportsOwner(historyLocations, sessions),
    snapshots: createSessionSnapshotsOwner(historyLocations, sessions),
  });
  const { agentProjection, conversationActions } = createAgentCapabilities({
    options,
    sessions,
    messages,
    stream,
    queryCollapseState,
    operations: operationIntents,
    conversationMutationState,
    llmCalls,
    nowMs,
  });
  const usageProjector = createUsageProjector({ sessions, usage, usageCommits, nowMs });
  const ready = createSessionSystemReadyHandler(options, queryCollapseState);
  let closePromise: Promise<void> | undefined;
  return {
    repositories: {
      sessions,
      projects,
      messages,
      queue: queueRepository,
      usage,
      assets,
      legacyMigrations,
      operationIntents,
    },
    sessions: {
      ...sessionDomain,
      historyMutation,
      operationIntents,
      records,
      root: roots,
      activation,
      recovery,
      state: createSessionStateWriter(sessions),
      execution: createSessionExecutionSource(sessions, legacy),
      interactionMode,
      deletion: createSessionDeletionCapability(deletionGate, turnAdmission),
    },
    messages: {
      repository: messages,
      query: new MessageQueryService({ messages, sessions, readiness: legacy }),
      sources: createSessionSourceHistory(options, messages, sessions, legacy),
      conversationActions,
      userMessages: new UserMessageCommitService({ messages, nowMs }),
      inputSummaries,
      rewind,
    },
    fork,
    projects: { ...projectDomain, sidebar: new SidebarQueryService(options.db, nowMs, (agentName) =>
      path.join(options.dataDir, 'agents', agentName, 'workspace')) },
    files,
    queue: {
      repository: queueRepository,
      committed: queue,
      priorityFence: createQueueTurnAdmissionPriorityFence({ facts: queueFacts }),
      submission: queue,
      facts: queueFacts,
      createDispatch: (acceptance: QueueClaimAcceptanceLookup) =>
        createQueueDispatchCapability({
          repository: queueRepository,
          acceptance,
          facts: queueFacts,
        }),
    },
    usage: {
      repository: usage,
      service: new SessionUsageService(usage),
      projector: usageProjector,
      commits: usageCommits,
    },
    titles,
    stream,
    canonicalHistory,
    historyLocations,
    planDocuments,
    conversationMutationState,
    legacy,
    artifacts,
    reporting,
    llmCalls,
    agentProjection,
    queryCollapse: { state: queryCollapseState },
    ready,
    runStorageMaintenance: () => storageRetention.run(),
    /** W1: the continuous durable→jsonl publisher; undefined in jsonl mode. */
    durableJsonlPublisher,
    close: () => {
      closePromise ??= closeSessionSystem(titles, stream, options.durableHistory, durableJsonlPublisher);
      return closePromise;
    },
  };
}

function createSessionSystemReadyHandler(
  options: InitializeSessionSystemOptions,
  queryCollapseState: ReturnType<typeof createQueryCollapseState>,
): () => Promise<void> {
  let rootProjectHistoryRepair: Promise<unknown> | undefined;
  let legacyDefaultProjectHistoryRepair: Promise<unknown> | undefined;
  return async () => {
    rootProjectHistoryRepair ??= repairRootProjectHistory({
      db: options.db,
      dataDir: options.dataDir,
      defaultWorkspaceDir: options.defaultWorkspaceDir,
      rootAgents: options.rootAgents,
      diagnostics: options.rootProjectHistoryRepairDiagnostics,
    });
    await rootProjectHistoryRepair;
    legacyDefaultProjectHistoryRepair ??= repairLegacyDefaultProjectHistory({
      db: options.db,
      dataDir: options.dataDir,
      defaultWorkspaceDir: options.defaultWorkspaceDir,
      rootAgents: options.rootAgents,
      ...(options.getAgentOwnerIdentity
        ? { getAgentOwnerIdentity: options.getAgentOwnerIdentity }
        : {}),
      diagnostics: options.legacyDefaultProjectHistoryRepairDiagnostics,
    });
    await legacyDefaultProjectHistoryRepair;
    await queryCollapseState.recoverUnfinished();
  };
}

function createSessionRecordService(input: {
  readonly options: InitializeSessionSystemOptions;
  readonly sessions: ReturnType<typeof createSessionRepository>;
  readonly projects: ReturnType<typeof createProjectRepository>;
  readonly canonicalHistory: SessionSystemCanonicalHistoryProvider;
  readonly nowMs: () => number;
}) {
  const { options, sessions, projects, canonicalHistory, nowMs } = input;
  return createNativeSessionRecordService({
    sessionRepository: sessions,
    projectRepository: projects,
    agentDirectory: options.agents,
    titlePolicy: options.titlePolicy,
    ...(options.resolveRequestedModel
      ? { resolveRequestedModel: options.resolveRequestedModel }
      : {}),
    artifacts: canonicalHistory,
    facts: options.facts,
    defaultWorkspaceDir: options.defaultWorkspaceDir,
    agentInternalWorkspaceDir: (agentName) =>
      path.join(options.dataDir, 'agents', agentName, 'workspace'),
    sessionDefaultWorkspaceDir: (sessionId) =>
      path.join(options.dataDir, 'sessions', sessionId, 'workspace'),
    ...(options.makeSessionId ? { makeSessionId: options.makeSessionId } : {}),
    ...(options.backfillDiagnostics ? { backfillDiagnostics: options.backfillDiagnostics } : {}),
    nowMs,
  });
}

function createSessionSourceHistory(
  options: Pick<InitializeSessionSystemOptions, 'db' | 'sourceProjectionEnabled'>,
  messages: ReturnType<typeof createMessageRepository>,
  sessions: ReturnType<typeof createSessionRepository>,
  readiness: LegacyOpencodeImporter,
): SessionSourceQueryService {
  return new SessionSourceQueryService({
    enabled: options.sourceProjectionEnabled,
    sources: createSessionSourceProjectionRepository({ db: options.db }),
    messages,
    sessions,
    readiness,
  });
}

function createSessionMetadataCapabilities(
  options: Pick<InitializeSessionSystemOptions, 'dataDir' | 'db'>,
  nowMs: () => number,
) {
  const sessions = createSessionRepository({
    db: options.db,
    nowMs,
    agentInternalWorkspaceDir: (agentName) => path.join(options.dataDir, 'agents', agentName, 'workspace'),
  });
  const historyLocations = createSessionHistoryLocationResolver({
    dataDir: options.dataDir,
    sessions,
  });
  const interactionMode = createSessionInteractionModeCapability({ db: options.db, nowMs });
  const planDocuments = createPlanDocumentOwner({
    dataDir: options.dataDir,
    sessions,
    modes: interactionMode,
    locations: historyLocations,
  });
  return { sessions, historyLocations, interactionMode, planDocuments };
}


function createSessionSnapshotsOwner(
  historyLocations: SessionHistoryLocationResolver,
  sessions: ReturnType<typeof createSessionRepository>,
) {
  return {
    resolveDirectory: async (sessionId: string) => {
      const session = await sessions.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      return (await historyLocations.ensure(session)).snapshots;
    },
    inspectDirectory: async (sessionId: string) =>
      (await historyLocations.inspectSession(sessionId))?.paths.snapshots,
  };
}
function createSessionReportsOwner(
  historyLocations: SessionHistoryLocationResolver,
  sessions: ReturnType<typeof createSessionRepository>,
) {
  return {
    ensureDirectory: async (sessionId: string) => {
      const session = await sessions.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      return (await historyLocations.ensure(session)).reports;
    },
    inspectDirectory: async (sessionId: string) =>
      (await historyLocations.inspectSession(sessionId))?.paths.reports,
  };
}

function createLegacySessionCapabilities(input: {
  readonly options: InitializeSessionSystemOptions;
  readonly migrations: ReturnType<typeof createLegacySessionMigrationRepository>;
  readonly sessions: ReturnType<typeof createSessionRepository>;
  readonly messages: ReturnType<typeof createMessageRepository>;
  readonly canonicalHistory: SessionSystemCanonicalHistoryProvider;
  readonly nowMs: () => number;
}) {
  const source = createLegacyOpencodeReadonlySource({ sourceDataDir: input.options.dataDir });
  const onLegacyCleanupError = (error: unknown, sessionId: string): void =>
    input.options.storageRetention?.logger?.warn(
      { error, sessionId },
      'Legacy Session copy cleanup failed',
    );
  const legacy = new LegacyOpencodeImporter({
    source,
    migrations: input.migrations,
    sessions: input.sessions,
    messages: input.messages,
    history: createLegacyMigrationHistory(input.canonicalHistory),
    assets: input.options.legacyMigration.assets,
    sourceDeletion: {
      deleteSessionMessages: (identity) => {
        deleteLegacyDaemonSessionMessages({ dataDir: input.options.dataDir, identity });
      },
      onError: onLegacyCleanupError,
    },
    defaultWorkspaceDir: input.options.defaultWorkspaceDir,
    primaryAgentName: input.options.legacyMigration.primaryAgentName,
    onPinnedSessionImported:
      input.options.onPinnedSessionImported ??
      (async () => {
        throw new Error('Imported Session Pin callback is not bound');
      }),
    onCanonicalRecovery: input.options.legacyMigration.onCanonicalRecovery,
    nowMs: input.nowMs,
  });
  return { legacy, onLegacyCleanupError };
}

function createQueryCollapseAgentProjectionOptions(
  state: ReturnType<typeof createQueryCollapseState>,
  messages: ReturnType<typeof createMessageRepository>,
  stream: SessionStreamService,
) {
  return {
    queryKeyForTurn: async (sessionId: string, turnId: string) =>
      (await state.findProcessingByCurrentTurn(sessionId, turnId))?.queryKey,
    queryCollapse: createQueryCollapseProjector({ state, messages, stream }),
  };
}

function createLegacyMigrations(db: AppDb, nowMs: () => number) {
  return createLegacySessionMigrationRepository({ db, nowMs });
}

function createSessionHistoryCapabilities(
  options: Pick<
    InitializeSessionSystemOptions,
    'dataDir' | 'db' | 'durableHistory' | 'onSessionPublishConflict'
  >,
  sessions: ReturnType<typeof createSessionRepository>,
  locations: SessionHistoryLocationResolver,
  nowMs: () => number,
) {
  const llmCalls = new SessionLlmCallReportStore({ locations });
  const reporting = new SessionReportService({ sessions, locations });
  const releasedHistory = createReleasedSessionHistoryReader({
    dataDir: options.dataDir,
    sessions,
    locations,
  });
  const ioLane = createSessionHistoryIoLane();
  const activity = createSessionHistoryActivity();
  const historyPersistence = createHistoryPersistenceRepository({ db: options.db });
  const legacyHistory = {
    sources: createLegacyHistorySourceReader({
      db: options.db,
      readLedgerSnapshot: (sessionId) => releasedHistory.readLedgerSnapshot(sessionId),
    }),
    checkpoints: historyPersistence,
  };
  // Ш1: provider selection. W10 hybrid default is DURABLE; `jsonl` is the
  // explicit compatibility mode. The durable provider requires the runtime
  // composition to have opened the single durable-history storage: an
  // EXPLICIT `MCODE_HISTORY_PROVIDER=durable` without it fails closed (the
  // request cannot be honored — no silent downgrade, no implicit old-data
  // writes); the W10 default without an injected storage keeps the jsonl
  // fallback as the documented compatibility seam for non-product embedders
  // (the product runtime always injects the storage).
  const mode = resolveHistoryProviderMode();
  // The durable→jsonl replication (W1 §3.2) is OPT-IN and OFF by default:
  // durable sessions read entirely from the durable log, the publisher
  // exists for legacy jsonl readers only (`MCODE_PUBLISH_JSONL=on`).
  const publishJsonl = resolveDurableJsonlPublishingEnabled();
  // W1 (architecture §3.2), opt-in: the composition creates the continuous
  // jsonl publisher over the SAME storage/locations/lane the provider uses
  // only when the knob is on. The publisher reproduces every durable commit
  // onto `messages.jsonl` (append after the durability flush, full-rewrite
  // on replace/compact/rewind) so legacy jsonl readers stay current; without
  // it no jsonl is written for durable sessions.
  const durablePublisherFactory: DurableJsonlPublisherFactory | undefined = publishJsonl
    ? (source) =>
        createDurableJsonlPublisher({
          sessions,
          locations,
          ioLane,
          durable: source,
          ...(options.onSessionPublishConflict
            ? { onSessionPublishConflict: options.onSessionPublishConflict }
            : {}),
          nowMs,
        })
    : undefined;
  const durable =
    options.durableHistory && mode === 'durable'
      ? createDurableSessionSystemCanonicalHistoryProvider({
          storage: options.durableHistory,
          dataDir: options.dataDir,
          sessions,
          locations,
          legacyHistory,
          ioLane,
          activity,
          nowMs,
          // Wave 2 (canon 05 §2.5, item 2.1): every append offloads inline
          // image blocks into `<dataDir>/artifacts/<sha256>.<ext>` — the log
          // stores the reference blocks and `offload` events, never base64.
          imageArtifacts: new ImageArtifactStore({ artifactsDir: resolveArtifactsDir(options.dataDir) }),
          ...(durablePublisherFactory ? { publisherFactory: durablePublisherFactory } : {}),
        })
      : undefined;
  if (mode === 'durable' && !options.durableHistory) {
    if (isExplicitDurableHistoryProviderMode()) {
      throw new Error(
        'MCODE_HISTORY_PROVIDER=durable requires the runtime composition to open the durable-history storage; refusing to serve the jsonl provider (no silent downgrade)',
      );
    }
    runtimeHistoryLog.warn(
      'durable history provider is the W10 default but no durable-history storage was injected; using the jsonl compatibility provider',
    );
  } else if (durable) {
    runtimeHistoryLog.info('durable canonical history provider selected', {
      directory: options.durableHistory?.directory,
    });
  }
  const canonicalHistory: SessionSystemCanonicalHistoryProvider =
    durable ??
    createSessionSystemCanonicalHistoryProvider({
      dataDir: options.dataDir,
      sessions,
      locations,
      legacyHistory,
      ioLane,
      activity,
      nowMs,
    });
  const fileMutation = createSessionHistoryMutationAdapter({
    dataDir: options.dataDir,
    sessions,
    locations,
    ioLane,
    activity,
    onRewindCommitted: (input) => llmCalls.pruneAfterRewind({ sessionId: input.sessionId }),
    onForkCommitted: (input) => llmCalls.copySnapshotCompanions(input),
  });
  // Durable mode: full-rewrite mutations keep their JSONL publication and are
  // mirrored into the durable log (fail-closed). Since W1 the continuous
  // DurableJsonlPublisher keeps `messages.jsonl` current after every durable
  // commit, so the wrapper's pre-mutation publish degrades to a cheap
  // catch-up flush (I-PUB-1) and the mirror sees a fresh file.
  const historyMutation = durable
    ? wrapSessionHistoryMutationForDurable(fileMutation, durable)
    : fileMutation;
  return {
    canonicalHistory,
    historyMutation,
    historyPersistence,
    llmCalls,
    reporting,
    durableJsonlPublisher: durable?.publisher,
  };
}

function queueRuntimeOwnerOptions(
  identity: InitializeSessionSystemOptions['runtimeOwnerIdentity'],
): Partial<Pick<QueueRepositoryOptions, 'claimOwnerId' | 'isClaimOwnerAlive'>> {
  if (!identity) return {};
  return {
    claimOwnerId: identity.createOwnerId('queue-claim'),
    isClaimOwnerAlive: (ownerId) => identity.isOwnerAlive(ownerId) !== false,
  };
}

function createSessionAssets(
  options: Pick<InitializeSessionSystemOptions, 'db' | 'dataDir'>,
  sessions: ReturnType<typeof createSessionRepository>,
) {
  return createSessionAssetRepository({
    db: options.db,
    resolveSessionWorkspaceRoot: async (sessionId) => (await sessions.get(sessionId))?.workspaceDir,
    resolveLegacySessionAssetRoot: (sessionId) =>
      join(options.dataDir, 'v2', 'session-assets', sessionId),
  });
}

function createSessionDeletionCapability(
  deletionGate: SessionDeletionGate,
  turnAdmission: ReturnType<typeof createTurnAdmission>,
) {
  return {
    begin: (sessionId: string) => deletionGate.begin(sessionId),
    complete: (sessionId: string) => deletionGate.complete(sessionId),
    turnAdmission,
  };
}

function createTurnAdmission(
  deletionGate: SessionDeletionGate,
  operations: ReturnType<typeof createSessionOperationIntentRepository>,
) {
  return {
    rejectionInTransaction: (db: AppDb, input: { readonly sessionId: string }) =>
      deletionGate.turnAdmission.rejectionInTransaction(db, input) ??
      (operations.blocksSessionInTransaction(db, input.sessionId)
        ? ('session-mutating' as const)
        : undefined),
  };
}

function createQueueAdmission(
  deletionGate: SessionDeletionGate,
  operations: ReturnType<typeof createSessionOperationIntentRepository>,
) {
  return {
    rejectionInTransaction: (
      db: AppDb,
      input: { readonly sessionId: string; readonly nowMs: number },
    ) =>
      deletionGate.queueAdmission.rejectionInTransaction(db, input) ??
      (operations.blocksSessionInTransaction(db, input.sessionId)
        ? ('maintenance-active' as const)
        : undefined),
  };
}

function createAgentCapabilities(input: {
  readonly options: InitializeSessionSystemOptions;
  readonly sessions: ReturnType<typeof createSessionRepository>;
  readonly messages: ReturnType<typeof createMessageRepository>;
  readonly stream: SessionStreamService;
  readonly queryCollapseState: ReturnType<typeof createQueryCollapseState>;
  readonly operations: ReturnType<typeof createSessionOperationIntentRepository>;
  readonly conversationMutationState: ReturnType<typeof createConversationMutationState>;
  readonly llmCalls: SessionLlmCallReportStore;
  readonly nowMs: () => number;
}) {
  const conversationActions = new ConversationActionProjectionService({
    sessions: input.sessions,
    messages: input.messages,
    operations: input.operations,
    availability: input.conversationMutationState,
  });
  const agentProjection = createSessionSystemAgentProjection({
    state: createSessionStateWriter(input.sessions),
    sessions: input.sessions,
    messages: input.messages,
    stream: input.stream,
    conversationActions,
    conversationFacts: input.options.conversationFacts,
    ...createQueryCollapseAgentProjectionOptions(
      input.queryCollapseState,
      input.messages,
      input.stream,
    ),
    ...(input.options.steeringProjection
      ? { steeringProjection: input.options.steeringProjection }
      : {}),
    compactionFacts: composeCompactionFactSink(input.llmCalls, input.options.compactionFacts),
    ...(input.options.compactionMetrics
      ? { compactionMetrics: input.options.compactionMetrics }
      : {}),
    nowMs: input.nowMs,
  });
  return { agentProjection, conversationActions };
}

function composeCompactionFactSink(
  reports: SessionLlmCallReportStore,
  downstream: SessionCompactionFactSink | undefined,
): SessionCompactionFactSink {
  return {
    handle: async (fact) => {
      if (fact.kind === 'completed') {
        try {
          await reports.freezeCompletedCompaction({
            sessionId: fact.sessionId,
            compactionId: fact.snapshotId,
          });
        } catch {
          // Report projection must never replace a committed compaction.
        }
      }
      await downstream?.handle(fact);
    },
  };
}

function createUsageProjector(input: {
  readonly sessions: ReturnType<typeof createSessionRepository>;
  readonly usage: ReturnType<typeof createSessionUsageRepository>;
  readonly usageCommits: ReturnType<typeof createSessionUsageCommitSignal>;
  readonly nowMs: () => number;
}) {
  return {
    record: async (record: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly model?: unknown;
      readonly messages: readonly unknown[];
    }) => {
      const session = await input.sessions.get(record.sessionId);
      if (!session) throw new Error(`Session not found: ${record.sessionId}`);
      const recorded = await recordCommittedPiUsage({
        store: input.usage,
        session,
        turnId: record.turnId,
        model: modelIdentity(record.model),
        nowMs: input.nowMs,
        messages: record.messages,
      });
      if (recorded > 0) input.usageCommits.publish(record.sessionId);
    },
  };
}

function createInputSummaries(
  options: Pick<InitializeSessionSystemOptions, 'db' | 'inputNavigationDiffs'>,
  sessions: ReturnType<typeof createSessionRepository>,
  legacy: Pick<LegacyOpencodeImporter, 'ensureDisplayReady'>,
  files: Pick<SessionFilesService, 'ensureSessionFilesReady'>,
): SessionInputSummaryService {
  return new SessionInputSummaryService({
    db: options.db,
    sessions,
    readiness: {
      ensureDisplayReady: (sessionId) => legacy.ensureDisplayReady(sessionId),
      ensureAssetsReady: (sessionId) => files.ensureSessionFilesReady(sessionId),
    },
    diffs: options.inputNavigationDiffs,
  });
}

function createLegacyMigrationHistory(
  history: SessionSystemCanonicalHistoryProvider,
): Pick<CanonicalHistoryPort, 'getPiHistory' | 'replacePiHistory'> {
  return {
    getPiHistory: async (sessionId) =>
      (await history.read(sessionId)).messages.map(assertCanonicalHistoryMessage),
    replacePiHistory: async (sessionId, messages, options) => {
      const replacementEntries = messages.map((message, index) => ({
        message,
        identity: { kind: 'new' as const, seed: `legacy-migration:${String(index)}` },
      }));
      const baseChange = {
        sessionId,
        turnId: `legacy-migration:${sessionId}`,
        reason: 'replaceMessages',
        messages,
        replacementEntries,
      } as const;
      await history.replace({
        ...baseChange,
        operation: {
          id: `legacy-migration:${sessionId}${options?.snapshotId ? `:${options.snapshotId}` : ''}`,
          kind: 'legacy-migration',
        },
        ...(options?.snapshotId ? { metadata: { replacementId: options.snapshotId } } : {}),
      });
    },
  };
}

function assertCanonicalHistoryMessage(value: unknown): CanonicalHistoryMessage {
  if (!isCanonicalHistoryMessage(value)) {
    throw new TypeError('Canonical history contains an invalid message');
  }
  return value;
}

function isCanonicalHistoryMessage(value: unknown): value is CanonicalHistoryMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (
    Reflect.get(value, 'role') === 'compactionSummary' &&
    typeof Reflect.get(value, 'summary') === 'string' &&
    !Object.hasOwn(value, 'timestamp') &&
    !Object.hasOwn(value, 'tokensBefore') &&
    Object.keys(value).every((key) => key === 'role' || key === 'summary')
  ) {
    return true;
  }
  return (
    typeof Reflect.get(value, 'role') === 'string' &&
    typeof Reflect.get(value, 'timestamp') === 'number'
  );
}

export type SessionSystemOwner = ReturnType<typeof initializeSessionSystem>;

async function closeSessionSystem(
  titles: Pick<SessionTitleService, 'close'>,
  stream: Pick<SessionStreamService, 'dispose'>,
  durableHistory?: DurableHistoryStorage,
  durableJsonlPublisher?: DurableJsonlPublisher,
): Promise<void> {
  const [titleResult] = await Promise.allSettled([titles.close()]);
  stream.dispose();
  // W1: drain the jsonl publisher (flush dirty sessions) while the worker is
  // still open, then dispose the ONE durable storage it rode.
  await durableJsonlPublisher?.dispose();
  // Ш1: the runtime's single durable storage rides the session-system close
  // (turn-system owners close before the session system in the lifecycle).
  await durableHistory?.dispose();
  if (titleResult?.status === 'rejected') throw titleResult.reason;
}

function createTitleCommitter(
  records: Pick<ReturnType<typeof createNativeSessionRecordService>, 'mutateSession'>,
  facts: SessionFactSink,
): SessionTitleServiceOptions['commitTitle'] {
  return async (sessionId, title, expectedTitle) => {
    const updated = await records.mutateSession(sessionId, { title }, undefined, expectedTitle);
    facts.handle({ kind: 'title-updated', session: updated, title });
  };
}

function modelIdentity(model: unknown): string | null {
  if (!model || typeof model !== 'object') return null;
  const provider = Reflect.get(model, 'provider');
  const id = Reflect.get(model, 'id');
  if (typeof provider === 'string' && typeof id === 'string') return `${provider}/${id}`;
  return typeof id === 'string' ? id : null;
}
