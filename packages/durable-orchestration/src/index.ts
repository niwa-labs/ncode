/**
 * @mavis/durable-orchestration — W08 part A: the merged orchestration
 * persistence. The pinned pi-durable Harness over OUR Storage is the ONE
 * scheduler; product state persists as pi documents/tasks through this
 * bridge; product supervisors/policies stay on top as adapters.
 *
 * @module
 */

export {
	OrchestrationBridgeError,
	UnknownConversationError,
	UnknownOrchestratedTaskError,
	BridgeContractMismatchError,
} from './errors.js';
export {
	GoalStateDocs,
	GoalIndexDoc,
	BackgroundRecordDocs,
	BackgroundControlDocs,
	BackgroundIndexDoc,
	CronRecordDocs,
	CronIndexDoc,
	RosterDocs,
	CONTROL_KEY,
	TASK_EVENT_CAP,
	conversationKey,
} from './documents.js';
export type {
	GoalAttachmentJson,
	GoalDocValue,
	GoalDocSeed,
	GoalIndexValue,
	BackgroundTaskMetaValue,
	BackgroundControlValue,
	BackgroundIndexValue,
	CronStateValue,
	CronIndexValue,
	RosterMember,
} from './documents.js';
export { OrchestrationHosts } from './host-intents.js';
export type {
	BackgroundRunSettlement,
	BackgroundRunContext,
} from './host-intents.js';
export { openOrchestrationHarness } from './harness.js';
export type { OrchestrationHarness, OrchestrationHarnessOptions } from './harness.js';
export {
	DurableThreadGoalStore,
	type DurableThreadGoalStoreOptions,
} from './goal-store.js';
export {
	BACKGROUND_TASK_KIND,
	POLL_MS,
	TRANSITION_TIMEOUT_MS,
	backgroundTaskDefinition,
	backgroundTaskExtension,
	DurableBackgroundTaskStore,
	type DurableBackgroundTaskStoreOptions,
	type BackgroundTaskInput,
	type BackgroundTaskCheckpoint,
	type BackgroundTaskResult,
} from './background-store.js';
export {
	CRON_WAKE_KIND,
	cronWakeDefinition,
	cronWakeExtension,
	CronJobBridge,
	type CronJobBridgeOptions,
	type CronWakeInput,
	type CronWakeCheckpoint,
	type CronWakeResult,
} from './cron-bridge.js';
export { replaceRoster, rosterOf, rosterAsOf, ROSTER_KEY } from './roster.js';
