import type { ToolExecutionContext } from '@mavis/agent-core/tools';

import type { SessionSystemReadCapability } from '../../session-system/index.js';
import type {
  AgentExecutionSnapshot,
  AgentExecutionSource,
  AgentHostCompactionDependencies,
  AgentHostDependencies,
  AgentHostRuntimeProfiles,
  AgentHostUsageProjection,
  AgentHostTurnControl,
  ContextCompactionPreparationSource,
  LocalTurnPreparationSource,
} from './contracts.js';
import { assertAgentHostCapabilityAvailable } from './empty-dependencies.js';
import {
  RequiredAgentEventDelivery,
  type AgentHistoryFailureProjector,
  type RequiredAgentEventDeliveryOptions,
} from './events/required-agent-event-delivery.js';
import {
  DurableCanonicalHistoryStore,
  type DurableCanonicalHistoryProvider,
} from './history/durable-canonical-history-store.js';
import {
  LocalRuntimeTurnExecutor,
  type LocalRuntimeTurnExecutorOptions,
} from './execution/executor.js';
import { buildLocalRequestPayloadTransform } from './assembly/local-turn-payload-transform.js';

export interface AgentHostProductionDependenciesOptions<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
  TContext extends ToolExecutionContext = ToolExecutionContext,
> {
  readonly sessions: SessionSystemReadCapability;
  readonly planDocuments?: AgentHostDependencies<TAgent>['planDocuments'];
  readonly agentRuntimes: AgentHostRuntimeProfiles;
  readonly agents: AgentExecutionSource<TAgent>;
  readonly promptSnapshots?: AgentHostDependencies<TAgent>['promptSnapshots'];
  readonly internalTurnPromptReads?: AgentHostDependencies<TAgent>['internalTurnPromptReads'];
  readonly turnRuntimeFacts?: AgentHostDependencies<TAgent>['turnRuntimeFacts'];
  readonly preparation: LocalTurnPreparationSource<TAgent> &
    ContextCompactionPreparationSource<TAgent>;
  readonly compaction: Omit<AgentHostCompactionDependencies<TAgent>, 'preparation'>;
  readonly turnControl: AgentHostTurnControl;
  readonly turnCapabilities?: AgentHostDependencies<TAgent>['turnCapabilities'];
  readonly assemblyObserver?: AgentHostDependencies<TAgent>['assemblyObserver'];
  readonly canonicalHistory: DurableCanonicalHistoryProvider;
  readonly usage?: AgentHostUsageProjection;
  readonly logger?: AgentHostDependencies<TAgent>['logger'];
  readonly events: RequiredAgentEventDeliveryOptions & {
    readonly historyFailures: AgentHistoryFailureProjector;
  };
  readonly executor: LocalRuntimeTurnExecutorOptions<TAgent, TContext>;
  readonly promptSuggestion?: AgentHostDependencies<TAgent>['promptSuggestion'];
  readonly isRuntimeErrorRetryable?: AgentHostDependencies<TAgent>['isRuntimeErrorRetryable'];
}

/**
 * Explicit composition seam for concrete AgentHost adapters.
 *
 * It intentionally does not attach the Host to services.ts, Dispatcher, HTTP,
 * or v1 compatibility. Those owners remain a later production wiring step.
 */
export function createAgentHostProductionDependencies<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
  TContext extends ToolExecutionContext = ToolExecutionContext,
>(
  options: AgentHostProductionDependenciesOptions<TAgent, TContext>,
): AgentHostDependencies<TAgent> {
  validateBaseOwners(options);
  const history = new DurableCanonicalHistoryStore(options.canonicalHistory);
  assertAgentHostCapabilityAvailable(
    'history-failure-projector',
    typeof options.events?.historyFailures?.projectHistoryFailure === 'function',
  );
  const events = new RequiredAgentEventDelivery(options.events);
  validateUsageProjection(options.usage);
  return createDependencyRecord(
    options,
    history,
    events,
    // The suggestion port is host-owned; the executor only forwards the
    // short-lived capture after a successful commit.
    new LocalRuntimeTurnExecutor(
      options.promptSuggestion
        ? { ...options.executor, promptSuggestion: options.promptSuggestion }
        : options.executor,
    ),
  );
}

function validateUsageProjection(usage: AgentHostUsageProjection | undefined): void {
  if (usage) {
    assertAgentHostCapabilityAvailable(
      'usage-projector',
      typeof usage.projector?.record === 'function',
    );
  }
}

function createDependencyRecord<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(
  options: AgentHostProductionDependenciesOptions<TAgent, TContext>,
  history: DurableCanonicalHistoryStore,
  events: RequiredAgentEventDelivery,
  executor: LocalRuntimeTurnExecutor<TAgent, TContext>,
): AgentHostDependencies<TAgent> {
  return {
    sessions: options.sessions,
    ...(options.planDocuments ? { planDocuments: options.planDocuments } : {}),
    agentRuntimes: options.agentRuntimes,
    agents: options.agents,
    promptSnapshots: options.promptSnapshots,
    ...(options.internalTurnPromptReads
      ? { internalTurnPromptReads: options.internalTurnPromptReads }
      : {}),
    ...withTurnRuntimeFacts(options.turnRuntimeFacts),
    preparation: options.preparation,
    turnControl: options.turnControl,
    ...(options.executor.resolvePluginHookRuntimeContext
      ? { resolvePluginHookRuntimeContext: options.executor.resolvePluginHookRuntimeContext }
      : {}),
    ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
    ...(options.assemblyObserver ? { assemblyObserver: options.assemblyObserver } : {}),
    history,
    // Ш3: mirrored from the executor composition so Turn preparation shares
    // the ownership-transfer hand-off with the executor's own turn input.
    ...(options.executor.piCompatibleHistorySnapshots
      ? { piCompatibleHistorySnapshots: true }
      : {}),
    events,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.promptSuggestion ? { promptSuggestion: options.promptSuggestion } : {}),
    executor,
    buildRequestPayloadTransform: createRequestPayloadTransform(options.executor),
    compaction: {
      ...options.compaction,
      preparation: options.preparation,
    },
    historyFailure: events,
    ...(options.isRuntimeErrorRetryable
      ? { isRuntimeErrorRetryable: options.isRuntimeErrorRetryable }
      : {}),
  };
}

function createRequestPayloadTransform<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(
  executor: LocalRuntimeTurnExecutorOptions<TAgent, TContext>,
): NonNullable<AgentHostDependencies<TAgent>['buildRequestPayloadTransform']> {
  const options = {
    ...(executor.fileApi ? { fileApi: executor.fileApi } : {}),
    ...(executor.nowMs ? { nowMs: executor.nowMs } : {}),
  };
  return (input) => buildLocalRequestPayloadTransform(input, options);
}

function withTurnRuntimeFacts<TAgent extends AgentExecutionSnapshot>(
  turnRuntimeFacts: AgentHostDependencies<TAgent>['turnRuntimeFacts'],
): Pick<AgentHostDependencies<TAgent>, 'turnRuntimeFacts'> {
  return turnRuntimeFacts ? { turnRuntimeFacts } : {};
}

function validateBaseOwners<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(options: AgentHostProductionDependenciesOptions<TAgent, TContext>): void {
  assertAgentHostCapabilityAvailable(
    'session-system-read',
    typeof options.sessions?.get === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'agent-runtime',
    typeof options.agentRuntimes?.normal?.assembleTurn === 'function' &&
      typeof options.agentRuntimes.normal.assembleModelContext === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'agent-execution-source',
    typeof options.agents?.getExecutionSnapshot === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'turn-preparation',
    typeof options.preparation?.prepare === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'compaction-preparation',
    typeof options.preparation?.prepareCompaction === 'function',
  );
  // Wave 2 (canon 05 §2.2): wire mode composes NO legacy compactor — the
  // unified barrier (the manual route) or the text-offload axis is the
  // wire-mode evidence; the jsonl compatibility composition keeps both
  // legacy compactors.
  const legacyCompactorsWired =
    typeof options.compaction?.automatic?.compactBeforeLlm === 'function' &&
    typeof options.compaction?.manual?.compactManual === 'function';
  const unifiedManualRouteWired = typeof options.compaction?.wireCompactionBarrier === 'function';
  assertAgentHostCapabilityAvailable(
    'context-compactor',
    legacyCompactorsWired || unifiedManualRouteWired,
  );
  assertAgentHostCapabilityAvailable(
    'compaction-control',
    typeof options.compaction?.control?.beginClose === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'compaction-lifecycle',
    typeof options.compaction?.lifecycle?.completeCommittedHistory === 'function' &&
      typeof options.compaction.lifecycle.failCommittedHistory === 'function',
  );
  const control = options.turnControl;
  assertAgentHostCapabilityAvailable('turn-control', typeof control?.scope === 'function');
}
