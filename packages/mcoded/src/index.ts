/**
 * @mavis/mcoded — the resident `mcoded` daemon (Ф4 contract, product shape).
 *
 * Layering, socket to core:
 * - `daemon.ts` — unix socket lifecycle: durable-path socket at `0600`,
 *   `LISTEN_FDS` adoption, stale-socket crash recovery, graceful shutdown;
 * - `daemon-lock.ts` — the CAS file locks of the control root (`mcoded.lock`
 *   held by the live daemon, `spawn.lock` for client auto-spawn); the lock
 *   closes the probe→bind race of the stale-socket recovery;
 * - `product-daemon.ts` — the product composition: the `MCODE_SERVER_MODE`
 *   gate, the control/data split (`resolveDaemonControlRoot` + profile
 *   dataDir), `daemon.json`, the per-start handshake token, and the host
 *   factory injection point the TUI composition fills;
 * - `ipc.ts` — the CLI-side `hello` probe and graceful `shutdown` request
 *   (`mcode daemon status|stop|restart`);
 * - `hub.ts` — transport-agnostic core: cursor assignment, replay ring,
 *   request-id dedup, client fan-out, drain + checkpoint;
 * - `wire.ts` / `protocol.ts` — the pi-rpc-semantics JSONL contract
 *   (prompt/steer/follow_up/events; version, cursor, request-id);
 * - `event-log.ts` — the durable replay window: every retained frame is
 *   appended under the durable root and a restart seeds the ring from its
 *   tail, so reconnects replay across restarts instead of `replay_gap`;
 * - `transport.ts` / `socket-transport.ts` — the line transports the wire
 *   runs over (in-memory loopback for tests, unix socket in the daemon);
 * - `runtime-adapter.ts` — the seam the live agent runtime plugs into; the
 *   echo stub stays as the explicit `MCODED_RUNTIME=echo` compat mode;
 * - `local-runtime-adapter.ts` — the product adapter: drives the real
 *   local-runtime-v2 conversation pipeline through the seam (the hybrid
 *   default runtime);
 * - `runtime-kind.ts` — the `MCODED_RUNTIME` switch (default `local-v2`,
 *   fail-closed on unknown values);
 * - `daemon-entry.ts` — the standalone build entry (`dist/mcoded.js`), which
 *   serves the durable root; intentionally not exported here, it self-starts;
 * - `checkpoint.ts` — the durable watermark that makes restarts crash-only.
 *
 * @module
 */

export {
	MCODED_PROTOCOL_VERSION,
	MCODED_PROTOCOL_MINOR,
	MCODED_PROTOCOL_FEATURES,
	MAX_INBOUND_FRAME_BYTES,
	DEFAULT_STREAM_CREDIT,
	STREAM_SINK_MAX_BYTES,
	STREAM_CLI_METHODS,
	ProtocolError,
	compareCursors,
	parseFrame,
	serializeFrame,
} from './protocol.js';
export type {
	ClientCommandName,
	ClientFrame,
	Cursor,
	HelloClientIdentity,
	HelloData,
	HelloEnvIdentity,
	McodedErrorCode,
	McodedPromptMode,
	ServerFrame,
	StreamCliMethod,
} from './protocol.js';
/**
 * v2 remote-method allowlist and its type ties (arch §4.3.6): the single
 * source of truth both the daemon bridge and the remote client dispatch
 * through.
 */
export {
	METHOD_NOT_ALLOWED_CODE,
	REMOTE_CALL_PLANS,
	REMOTE_CLI_METHODS,
	REMOTE_METHOD_EXCEPTIONS,
} from './remote-methods.js';
export type { RemoteCallPlan, RemoteCliMethod, TuiCliSurface } from './remote-methods.js';

/** v2 event routing table (arch §4.3.4): catalog vs session-attached. */
export {
	GLOBAL_EVENT_ROUTES,
	globalEventSessionId,
	routeGlobalEventType,
	shouldDeliverGlobalEvent,
} from './event-routing.js';
export type { GlobalEventRoute } from './event-routing.js';

/** v2 `call`/`stream.open` → CliService bridge (arch §5). */
export { BRIDGE_STREAM_METHODS, BridgeMethodError, CliBridge } from './cli-bridge.js';
export type { BridgeConnectionContext, BridgeStreamResult, McodedBridgeErrorCode } from './cli-bridge.js';

/** v2 stream multiplexer: credits, congestion gate, detach-sink (§4.3.5). */
export { StreamMux } from './stream-mux.js';
export type { MuxSink, MuxSource, StreamMuxOptions } from './stream-mux.js';

/** v2 client side (arch §5): McodedClient + RemoteCliService (W4 consumes). */
export {
	McodedClient,
	McodedConnectionError,
	McodedRemoteError,
	RemoteCliService,
} from './client.js';
export type {
	CallMethod,
	DaemonStatusData,
	McodedClientHandshake,
	McodedClientOptions,
	McodedClientState,
	RemoteCallParams,
	RemoteCliSurface,
	RemoteEventStream,
	RemoteStream,
	StreamEnd,
	WatchEventsStream,
} from './client.js';

export {
	CRASH_LOOP_COOLDOWN_MS,
	CRASH_LOOP_MAX_CRASHES,
	CRASH_LOOP_WINDOW_MS,
	CrashLoopWatchdog,
	McodedCrashLoopError,
} from './crash-loop-watchdog.js';
export type { CrashLoopDecision, CrashLoopWatchdogOptions } from './crash-loop-watchdog.js';

export { DEFAULT_REPLAY_LIMITS, ReplayRing } from './replay-ring.js';
export type { ReplayFrame, ReplayLimits, ReplaySlice } from './replay-ring.js';

export { EchoRuntimeAdapter, PushableIterable } from './runtime-adapter.js';
export type { RuntimeAdapter, RuntimeSubmission, SubmissionKind } from './runtime-adapter.js';

export {
	DEFAULT_MCODED_AGENT_NAME,
	LocalRuntimeV2Adapter,
	createProfileAuthSession,
} from './local-runtime-adapter.js';
export type {
	LocalRuntimeAdapterAuthOptions,
	LocalRuntimeAdapterAuthSession,
	LocalRuntimeAdapterEvent,
	LocalRuntimeAdapterOptions,
} from './local-runtime-adapter.js';

export {
	DEFAULT_EVENT_LOG_MAX_FILE_BYTES,
	MCODED_EVENT_LOG_BASENAME,
	FileEventLog,
} from './event-log.js';
export type { EventLog, FileEventLogOptions } from './event-log.js';

export {
	MCODED_RUNTIME_ENV,
	McodedRuntimeConfigError,
	resolveMcodedRuntimeKind,
} from './runtime-kind.js';
export type { McodedRuntimeKind } from './runtime-kind.js';

export { createInMemoryTransportPair } from './transport.js';
export type { LineTransport } from './transport.js';
export { SocketLineTransport } from './socket-transport.js';

export {
	MCODED_CHECKPOINT_BASENAME,
	FileCheckpointStore,
	InMemoryCheckpointStore,
	makeCheckpoint,
} from './checkpoint.js';
export type { CheckpointStore, DaemonCheckpoint } from './checkpoint.js';

export { RpcConnection } from './wire.js';
export type { RpcConnectionHost, RpcConnectionState } from './wire.js';

export { McodedHub } from './hub.js';
export type { McodedHubOptions } from './hub.js';

export {
	LISTEN_FD_START,
	McodedDaemon,
	McodedDaemonError,
	readInheritedListenFd,
} from './daemon.js';
export type {
	DaemonHubOptions,
	McodedDaemonErrorCode,
	McodedDaemonOptions,
} from './daemon.js';

export {
	FileLockHeldError,
	FileLockStaleError,
	MCODED_LOCK_BASENAME,
	SPAWN_LOCK_BASENAME,
	acquireFileLock,
	acquireFileLockSelfHealing,
	isPidAlive,
	readLockHolderPid,
	recoverStaleFileLock,
	releaseFileLock,
} from './daemon-lock.js';
export type { FileLock, FileLockContents } from './daemon-lock.js';

export {
	MCODED_LOG_DIR_BASENAME,
	MCODED_MANIFEST_BASENAME,
	MCODED_TOKEN_BASENAME,
	DaemonManifestError,
	ProfileDataDirMismatchError,
	daemonManifestPath,
	openDaemonLogFd,
	readDaemonManifest,
	readDaemonToken,
	resolveDaemonTargets,
	startProductDaemon,
	writeDaemonManifest,
} from './product-daemon.js';
export type {
	DaemonManifest,
	DaemonState,
	DaemonTargets,
	DaemonTargetsOptions,
	ProductDaemonHandle,
	ProductDaemonHostFactory,
	ProductDaemonOptions,
} from './product-daemon.js';

/** W4 (§4.5/D5): approvals push-routing and the per-session toolEnv snapshots. */
export {
	ASK_EVENT_TYPES,
	PermissionRouter,
	routedEventSessionId,
} from './permission-router.js';
export type { RoutableClient, RoutableEvent } from './permission-router.js';
export { SessionToolEnvStore, sanitizeSessionToolEnv } from './session-tool-env.js';
export type { SessionToolEnv } from './session-tool-env.js';
export { resolveDetachedPermission } from './product-daemon.js';

/**
 * Revision 11 F2: the daemon-owned mcode-tools readiness — the OAuth lease
 * broker, the launcher installation and the `__MAVIS_MCODE_TOOLS_*`
 * activation live in the process that survives the TUI window (composed in
 * `startProductDaemon`); the env inheritance of the spawning window stays as
 * the fallback.
 */
export {
	createDaemonMcodeToolsAuthSession,
	createDaemonMcodeToolsRuntimeDir,
	normalizeMcodeToolsHostBuildEnv,
	prepareDaemonMcodeToolsIntegration,
	removeDaemonMcodeToolsRuntimeDir,
} from './mcode-tools.js';
export type {
	DaemonMcodeToolsReadiness,
	DaemonMcodeToolsReadinessCategory,
	PrepareDaemonMcodeToolsIntegrationOptions,
} from './mcode-tools.js';

/**
 * Design 15 (ДИЗАЙН 2): mcoded.log rotation — М3 spawn-time rename (via
 * `openDaemonLogFd` above) + М2 in-daemon copytruncate on fd 2, bounded by
 * the `MCODED_LOG_MAX_BYTES` / `MCODED_LOG_KEEP` env knobs.
 */
export {
	DEFAULT_MCODED_LOG_KEEP,
	DEFAULT_MCODED_LOG_MAX_BYTES,
	MCODED_LOG_BASENAME,
	MCODED_LOG_FILE_ENV,
	MCODED_LOG_KEEP_ENV,
	MCODED_LOG_MAX_BYTES_ENV,
	MCODED_LOG_ROTATION_INTERVAL_MS,
	copyTruncate,
	readLogRotationEnv,
	rotateBeforeSpawn,
	shiftGenerations,
	startLogRotation,
} from './log-rotation.js';
export type {
	CopyTruncateOptions,
	LogRotationConfig,
	LogRotationHandle,
	StartLogRotationOptions,
} from './log-rotation.js';

export {
	DAEMON_IPC_TIMEOUT_MS,
	helloDaemon,
	listDaemonActiveRuns,
	requestDaemonShutdown,
} from './ipc.js';
export type {
	DaemonActiveRunsSnapshot,
	DaemonClientHandshake,
	DaemonIpcOutcome,
} from './ipc.js';

export { mcodedMain, parseMcodedArgs } from './main.js';
export type { McodedMainOptions } from './main.js';

// `daemon-entry.ts` is intentionally NOT exported: it is the standalone build
// entry (`dist/mcoded.js`) and self-starts the daemon on import.
