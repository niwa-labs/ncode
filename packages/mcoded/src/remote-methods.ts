/**
 * The v2 method allowlist and its type ties (arch §4.3.6).
 *
 * `REMOTE_CLI_METHODS` is the single source of truth shared by both sides:
 * - the daemon's `cli-bridge` dispatches `call` frames ONLY through it;
 * - the client's `RemoteCliService` implements exactly the
 *   {@link TuiCliSurface} projection it names.
 *
 * The compile-time chain is the point:
 * 1. `satisfies readonly (keyof CliService)[]` — every name IS a CliService
 *    method (a typo or a renamed upstream method fails the build);
 * 2. `REMOTE_CALL_PLANS satisfies Record<RemoteCliMethod, CallPlan>` — every
 *    allowlisted method declares how the bridge passes its arguments, so a
 *    new method cannot skip the invocation convention;
 * 3. `TuiCliSurface = Pick<CliService, RemoteCliMethod>` — the remote client
 *    and the in-process TUI share one type; `packages/tui/src` keeps calling
 *    `CliService` unchanged (W4 wiring).
 *
 * The completeness TEST additionally greps `packages/tui/src` and requires
 * every called method to be allowlisted — the one standing exception is
 * `watchEvents`, which rides the `subscribe` frame instead (arch §4.3.6).
 *
 * @module
 */

import type { CliService } from '@mavis/local-runtime-v2/cli-service';

import { STREAM_CLI_METHODS } from './protocol.js';

/**
 * Every CliService method a thin client may invoke through the daemon.
 *
 * Composition: the TUI-observed surface (task-brief §2.4 port table, verified
 * by grep over `packages/tui/src`) plus the arch additions (`model.*`,
 * `provider.*`, `goal.*`, skills, plugins, `collectSessionReport`).
 *
 * NOT allowlisted:
 * - `watchEvents` — rides the `subscribe` frame (cursor replay + per-session
 *   filtering, arch §4.3.6);
 * - daemon surfaces (`daemon.status` etc.) — daemon-level frames, not
 *   CliService methods.
 *
 * Mutating-global-state surfaces, precisely: the model-provider lifecycle
 * (`createUserModelProvider`/`updateUserModelProvider`/
 * `deleteUserModelProvider`, the MiniMax key/source setters) IS deliberately
 * allowed — one process owns the runtime, and the `config.*` events reach
 * every window (arch §4.3.6). Plugin lifecycle commands also use the owner:
 * starting an embedded writer for these commands conflicts with the daemon.
 */
export const REMOTE_CLI_METHODS = [
	// SessionPort (task-brief §2.4)
	'createSession',
	'listSessions',
	'getSession',
	'getSessionTree',
	'getMessages',
	'updateSession',
	'archiveSession',
	'deleteSession',
	'listSessionInputSummaries',
	'getSessionRewindPreview',
	'rewindSession',
	'editSessionMessage',
	'configureSessionMcpServers',
	'clearSessionMcpServers',
	'forkSession',
	'getSessionForkOptions',
	// ConversationPort
	'sendMessage',
	'resumeSession',
	'watchSessionUsageCommits',
	'abortSession',
	'steerSession',
	'steer',
	'enqueueMessage',
	// InteractionPort
	'getPendingQuestionnaire',
	'replyQuestionnaire',
	'dismissQuestionnaire',
	'getLatestPlanReview',
	'getPlanModeCapabilities',
	'listPendingPermissions',
	'replyPermission',
	// QueuePort
	'listQueueMessages',
	'getQueueItem',
	'updateQueueItem',
	'reorderQueue',
	'deleteQueueItem',
	// InspectionPort
	'getSessionUsage',
	'getSessionUsageSummary',
	'getSessionCacheWarmingStatus',
	'requestCompaction',
	'listSkills',
	'listRuntimeSkills',
	'collectSessionReport',
	// ConfigurationPort
	'getPermissionMode',
	'setPermissionMode',
	'bindSessionPermissionMode',
	'setSessionPermissionMode',
	'getSessionPermissionMode',
	'bindSessionToolPolicy',
	'getSessionToolPolicy',
	'getDangerousCommandGateEnabled',
	'setDangerousCommandGateEnabled',
	'getSandboxFilesystemMode',
	'setSandboxFilesystemMode',
	'listModels',
	'selectModel',
	'setModelFavorite',
	'getRuntimeDiagnostics',
	'getAccountStatus',
	'getInstructionSources',
	// GoalPort
	'isGoalEnabled',
	'getGoal',
	'createGoal',
	'patchGoal',
	'clearGoal',
	// Delegation / background
	'listBackgroundTasks',
	'getActiveTurn',
	'getTurnStatus',
	// Plugins
	'refreshPlugins',
	'listMarketplacePlugins',
	'listInstalledPlugins',
	'installPlugin',
	'enablePlugin',
	'disablePlugin',
	'uninstallPlugin',
	// Workspace
	'getWorkspaceGitMetadata',
	'getWorkspaceReviewLink',
	'listWorkspaceFileTree',
	'searchWorkspaceFiles',
	// MCP
	'listMcpServers',
	'inspectProjectMcp',
	// provider.* / model provider management (arch §4.3.6 addition)
	'listUserModelProviders',
	'listProviderPresets',
	'getCodexOAuthStatus',
	'startCodexOAuthLogin',
	'cancelCodexOAuthLogin',
	'getMiniMaxApiKeyStatus',
	'getMiniMaxModelSource',
	'setMiniMaxModelSource',
	'upsertMiniMaxApiKey',
	'createUserModelProvider',
	'discoverUserModelsCandidate',
	'saveUserModelProviderCandidate',
	'updateUserModelProvider',
	'deleteUserModelProvider',
	'testUserModelProvider',
	'testUserModel',
] as const satisfies readonly (keyof CliService)[];

/** Allowlist method-name union. */
export type RemoteCliMethod = (typeof REMOTE_CLI_METHODS)[number];

/**
 * The in-process TUI surface, pinned to the allowlist: the remote client
 * implements THIS, and the W4 adapter refactor swaps `CliService` for it
 * (type-only). `watchEvents` is served by `RemoteCliService` itself over the
 * `subscribe` frame, outside this projection.
 */
export type TuiCliSurface = Pick<CliService, RemoteCliMethod>;

/** How `cli-bridge` maps a `call` frame onto a CliService signature. */
export type RemoteCallPlan =
	/** `(req, ctx?)`: the bridge injects the connection context as the second
	 * argument — the client never sends a `ProcessLocalContext` (§4.3.2). */
	| { readonly kind: 'req-ctx' }
	/** Plain argument list: the bridge spreads `params` verbatim. */
	| { readonly kind: 'raw' }
	/** Stream method: `call` refuses it with `METHOD_NOT_ALLOWED`; it is
	 * allowlisted only so `TuiCliSurface` covers the full remote surface and
	 * `stream.open` can dispatch it. */
	| { readonly kind: 'stream-only' };

/** The CliService methods served as streams (`stream.open`, never `call`). */
export const REMOTE_STREAM_METHODS: readonly RemoteCliMethod[] = STREAM_CLI_METHODS;

/**
 * Per-method invocation plans; the `satisfies Record<RemoteCliMethod, …>`
 * makes a missing plan (or an extra entry for a non-allowlisted name) a
 * compile error.
 */
export const REMOTE_CALL_PLANS = {
	// SessionPort
	createSession: { kind: 'req-ctx' },
	listSessions: { kind: 'req-ctx' },
	getSession: { kind: 'req-ctx' },
	getSessionTree: { kind: 'req-ctx' },
	getMessages: { kind: 'req-ctx' },
	updateSession: { kind: 'req-ctx' },
	archiveSession: { kind: 'req-ctx' },
	deleteSession: { kind: 'req-ctx' },
	listSessionInputSummaries: { kind: 'req-ctx' },
	getSessionRewindPreview: { kind: 'req-ctx' },
	rewindSession: { kind: 'req-ctx' },
	editSessionMessage: { kind: 'req-ctx' },
	configureSessionMcpServers: { kind: 'raw' },
	clearSessionMcpServers: { kind: 'raw' },
	forkSession: { kind: 'req-ctx' },
	getSessionForkOptions: { kind: 'req-ctx' },
	// ConversationPort
	sendMessage: { kind: 'stream-only' },
	resumeSession: { kind: 'stream-only' },
	watchSessionUsageCommits: { kind: 'stream-only' },
	abortSession: { kind: 'req-ctx' },
	steerSession: { kind: 'req-ctx' },
	steer: { kind: 'raw' },
	enqueueMessage: { kind: 'req-ctx' },
	// InteractionPort
	getPendingQuestionnaire: { kind: 'req-ctx' },
	replyQuestionnaire: { kind: 'req-ctx' },
	dismissQuestionnaire: { kind: 'req-ctx' },
	getLatestPlanReview: { kind: 'req-ctx' },
	getPlanModeCapabilities: { kind: 'raw' },
	listPendingPermissions: { kind: 'req-ctx' },
	replyPermission: { kind: 'req-ctx' },
	// QueuePort
	listQueueMessages: { kind: 'req-ctx' },
	getQueueItem: { kind: 'req-ctx' },
	updateQueueItem: { kind: 'req-ctx' },
	reorderQueue: { kind: 'req-ctx' },
	deleteQueueItem: { kind: 'req-ctx' },
	// InspectionPort
	getSessionUsage: { kind: 'req-ctx' },
	getSessionUsageSummary: { kind: 'req-ctx' },
	getSessionCacheWarmingStatus: { kind: 'raw' },
	requestCompaction: { kind: 'req-ctx' },
	listSkills: { kind: 'raw' },
	listRuntimeSkills: { kind: 'raw' },
	collectSessionReport: { kind: 'raw' },
	// ConfigurationPort
	getPermissionMode: { kind: 'raw' },
	setPermissionMode: { kind: 'raw' },
	bindSessionPermissionMode: { kind: 'raw' },
	setSessionPermissionMode: { kind: 'raw' },
	getSessionPermissionMode: { kind: 'raw' },
	bindSessionToolPolicy: { kind: 'raw' },
	getSessionToolPolicy: { kind: 'raw' },
	getDangerousCommandGateEnabled: { kind: 'raw' },
	setDangerousCommandGateEnabled: { kind: 'raw' },
	getSandboxFilesystemMode: { kind: 'raw' },
	setSandboxFilesystemMode: { kind: 'raw' },
	listModels: { kind: 'raw' },
	selectModel: { kind: 'raw' },
	setModelFavorite: { kind: 'raw' },
	getRuntimeDiagnostics: { kind: 'raw' },
	getAccountStatus: { kind: 'raw' },
	getInstructionSources: { kind: 'raw' },
	// GoalPort
	isGoalEnabled: { kind: 'raw' },
	getGoal: { kind: 'raw' },
	createGoal: { kind: 'raw' },
	patchGoal: { kind: 'raw' },
	clearGoal: { kind: 'raw' },
	// Delegation / background
	listBackgroundTasks: { kind: 'raw' },
	getActiveTurn: { kind: 'raw' },
	getTurnStatus: { kind: 'raw' },
	// Plugins
	refreshPlugins: { kind: 'raw' },
	listMarketplacePlugins: { kind: 'raw' },
	listInstalledPlugins: { kind: 'raw' },
	installPlugin: { kind: 'raw' },
	enablePlugin: { kind: 'raw' },
	disablePlugin: { kind: 'raw' },
	uninstallPlugin: { kind: 'raw' },
	// Workspace
	getWorkspaceGitMetadata: { kind: 'raw' },
	getWorkspaceReviewLink: { kind: 'raw' },
	listWorkspaceFileTree: { kind: 'raw' },
	searchWorkspaceFiles: { kind: 'raw' },
	// MCP
	listMcpServers: { kind: 'raw' },
	inspectProjectMcp: { kind: 'raw' },
	// provider.* / model providers
	listUserModelProviders: { kind: 'raw' },
	listProviderPresets: { kind: 'raw' },
	getCodexOAuthStatus: { kind: 'raw' },
	startCodexOAuthLogin: { kind: 'raw' },
	cancelCodexOAuthLogin: { kind: 'raw' },
	getMiniMaxApiKeyStatus: { kind: 'raw' },
	getMiniMaxModelSource: { kind: 'raw' },
	setMiniMaxModelSource: { kind: 'raw' },
	upsertMiniMaxApiKey: { kind: 'raw' },
	createUserModelProvider: { kind: 'raw' },
	discoverUserModelsCandidate: { kind: 'raw' },
	saveUserModelProviderCandidate: { kind: 'raw' },
	updateUserModelProvider: { kind: 'raw' },
	deleteUserModelProvider: { kind: 'raw' },
	testUserModelProvider: { kind: 'raw' },
	testUserModel: { kind: 'raw' },
} as const satisfies Record<RemoteCliMethod, RemoteCallPlan>;

/** `watchEvents` rides the `subscribe` frame — the allowlist's one exclusion. */
export const REMOTE_METHOD_EXCEPTIONS: readonly string[] = ['watchEvents'];

/** Stable code the bridge attaches to allowlist violations. */
export const METHOD_NOT_ALLOWED_CODE = 'METHOD_NOT_ALLOWED' as const;
