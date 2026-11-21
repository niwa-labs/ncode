/**
 * W04 part B — durable turn-driver public surface.
 *
 * Composition note (I08/W10): the durable-mode product path composes the
 * driver through {@link withProductTurnDriver} (services.ts) — the store
 * opens over the runtime's pi composition root and every product turn runs
 * through the driver envelope, delegating steps to the part-A loop. The
 * jsonl compatibility mode keeps the direct part-A host (no driver).
 *
 * @module
 */

export type {
  DeferredFetchRequest,
  DriverAdmissionVeto,
  DriverAfterFailedRun,
  DriverClock,
  DriverCompactionGate,
  DriverCompactionWait,
  DriverDeferredHandle,
  DriverHooks,
  DriverModelRef,
  DriverQueueMode,
  DriverQueueModes,
  DriverQueuePort,
  DriverQueuedInput,
  DriverRequestPlan,
  DriverRetryPolicy,
  DriverSettings,
  DriverStreamOptions,
  DriverThinkingLevel,
  DriverToolObligation,
  DriverTranscriptPort,
  ExecutorBinding,
  ToolRoundSettlement,
  ToolRoundSettlementRequest,
  TurnDriverCheckpoint,
  TurnDriverEvent,
  TurnDriverEventSink,
  TurnDriverRunOutcome,
  TurnDriverStateRecord,
  TurnDriverStoreResult,
  TurnStepExecutor,
  TurnStepReport,
  TurnStepRequest,
} from './driver-contracts.js';
export {
  DurableTurnDriver,
  DEFAULT_POLL_AFTER_MS,
  nextRunId,
  TurnDriverError,
  type DriverPrepareResolution,
  type DurableTurnDriverDeps,
  type TurnDriverErrorCode,
  type TurnDriverRecovery,
} from './durable-turn-driver.js';
export {
  DurableTurnDriverStore,
  TURN_DRIVER_ENTRY_KINDS,
  turnDriverStateEntryId,
  type TurnDriverSaveInput,
  type TurnDriverStateView,
  type TurnDriverStoreError,
  type TurnDriverStoreErrorCode,
} from './turn-driver-store.js';
export {
  composeProductTurnDriver,
  type ProductTurnDriver,
  type ProductTurnDriverOptions,
} from './product-turn-driver.js';
export {
  withProductTurnDriver,
  type DriverBackedAgentHost,
  type ProductTurnDriverHostOptions,
} from './product-turn-integration.js';
