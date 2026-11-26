/**
 * The v2 client side (arch §4.3, §5): `McodedClient` — connect/hello/
 * reconnect with backoff, multiplexed `call`s and credit-managed streams —
 * and `RemoteCliService`, the type-safe remote projection of the CliService
 * surface the TUI consumes through the W4 port adapter (server mode only:
 * `packages/tui/src/runtime/remote-host.ts`); the
 * suite exercises it end-to-end against the hub over in-memory and real
 * socket transports.
 *
 * Type ties: `RemoteCliSurface` maps every {@link RemoteCliMethod} onto its
 * `CliService` parameter/return types via indexed access — a renamed or
 * reshaped upstream method breaks the build here exactly where it breaks the
 * TUI. The caller-visible deltas from `TuiCliSurface = Pick<CliService, …>`
 * are deliberately exactly the set frozen at `EXPECTED_SURFACE_DELTAS` below:
 * - `sendMessage`/`resumeSession` lose the trailing `ProcessLocalContext`
 *   (the AbortSignal carrier): a context never crosses the wire, so the only
 *   remote in-flight cancel is `stream.cancel{mode:'abort'}` (see the W0 F3
 *   note below). REMAPPED IN W4: the TUI port adapter
 *   (`packages/tui/src/runtime/remote-host.ts`, `TuiRemoteCliService`)
 *   translates an aborted `ctx.signal` into `stream.cancel{mode:'abort'}`;
 *   a plain `source.return()` never cancels the daemon-side turn (I-DETACH).
 * - three CliService SYNC methods are `Promise`s on the remote surface (a
 *   network roundtrip cannot be synchronous): `getPlanModeCapabilities` and
 *   `getSessionCacheWarmingStatus` are consumed through async TUI accessors,
 *   so the Promise is transparent there; `isGoalEnabled` is a genuinely sync
 *   seam — the W4 port adapter serves a cached snapshot refreshed at connect
 *   and on every reconnect (`TuiRemoteCliService.refreshGoalEnabled`).
 * Every other method is type-identical across the seam (e.g. `setModelFavorite`
 * is already `Promise<boolean>` locally). This is why the module stays
 * decoupled from the TUI in W3.
 *
 * Reconnect semantics (§4.6.3): on transport death the client backs off
 * (100 ms → 2 s), re-handshakes, re-attaches every held `session.attach` and
 * re-subscribes every `subscribe` with `after: <last delivered cursor>` — so
 * event streams resume exactly where they stopped; `replay_gap` surfaces on
 * the subscription's `gapped` promise (the consumer re-lists sessions). Turn
 * streams are NOT resumed automatically: a broken turn stream ends with
 * `reason: 'error'`, and recovery is the caller's explicit
 * `stream.open resumeSession` (the arch's honest-UX rule).
 *
 * W0 F3 honored end to end: no client-side signal pretends to abort a turn —
 * `stream.cancel{mode:'abort'}` is the only remote abort.
 *
 * @module
 */

import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { createLogger } from '@mavis/logging';

import type {
	CliSendMessageOptions,
	CliSendMessageReq,
	CliService,
	ResumeSessionReq,
	SessionStreamErrorBody,
	SessionStreamFrameView,
} from '@mavis/local-runtime-v2/cli-service';
import type { ProcessLocalStreamResult } from '@mavis/conversation-contract';
import type { GlobalEvent } from '@mavis/shared/global-events';

import {
	DEFAULT_STREAM_CREDIT,
	MCODED_PROTOCOL_FEATURES,
	MCODED_PROTOCOL_MINOR,
	MCODED_PROTOCOL_VERSION,
	type ClientFrame,
	type Cursor,
	type DaemonActiveRun,
	type HelloClientIdentity,
	type HelloData,
	type HelloEnvIdentity,
	type McodedErrorCode,
	type ServerFrame,
	type StreamCliMethod,
	serializeFrame,
} from './protocol.js';
import { REMOTE_CLI_METHODS, type RemoteCliMethod, type TuiCliSurface } from './remote-methods.js';
import { CrashLoopWatchdog, McodedCrashLoopError } from './crash-loop-watchdog.js';
import { SocketLineTransport } from './socket-transport.js';
import type { LineTransport } from './transport.js';
import type { SessionToolEnv } from './session-tool-env.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/**
 * Total time a connect may spend on hook rounds that watched a live daemon
 * boot. The first start of a new build can migrate a large data directory
 * for minutes; past this bound the connect fails like any other.
 */
export const DAEMON_BOOT_WAIT_MS = 30 * 60_000;

/** Handshake payload the client sends on every (re)connect. */
export interface McodedClientHandshake {
	readonly token?: string;
	/**
	 * W4 (§4.6.2): read fresh at every handshake — the auto-spawn path starts
	 * against a daemon that does not exist yet, so the per-start token file
	 * only appears after the spawn hook ran. Takes precedence over
	 * {@link McodedClientHandshake.token} when both are set.
	 */
	readonly tokenGetter?: () => string | undefined;
	readonly dataDir?: string;
	readonly env?: HelloEnvIdentity;
	readonly clientInstanceId?: string;
	readonly client?: HelloClientIdentity;
	readonly promptMode?: 'tui' | 'coding' | 'work';
}

/** McodedClient construction options. */
export interface McodedClientOptions {
	/** Daemon socket path (used unless {@link McodedClientOptions.connect}). */
	readonly socketPath: string;
	/** Sent on every (re)connect. */
	readonly handshake: McodedClientHandshake;
	/** Transport factory override (tests, exotic transports). */
	readonly connect?: () => Promise<LineTransport>;
	/**
	 * Auto-spawn hook (arch §4.6.2): called on ENOENT/ECONNREFUSED before a
	 * retry; the W4 product wiring passes the spawn.lock dance here
	 * (`packages/tui/src/runtime/remote-host.ts`, `createDaemonAutoSpawnHook`).
	 * W5: the hook MAY report whether it actually STARTED a child (`true`) —
	 * a no-op round (daemon alive, sibling window spawning) reports `false`,
	 * which is what the crash-loop watchdog counts on (§4.6.4).
	 * `'booting'` reports a live daemon still starting (a long first-start
	 * migration): neither a crash nor connect time, bounded by
	 * {@link DAEMON_BOOT_WAIT_MS} in total.
	 */
	readonly spawn?: () => Promise<void | boolean | 'booting'>;
	/**
	 * W5 (§4.6.4): the crash-loop watchdog. When set, a spawn round that
	 * started a child and STILL failed to connect records a daemon death;
	 * 3 within the watchdog's window stop respawning (connect fails with the
	 * honest crash-loop message instead of hammering a dying daemon).
	 */
	readonly crashLoop?: CrashLoopWatchdog;
	/** Bounded wait for connect+spawn+hello. Default 20 000 ms (§4.6.2 п.3). */
	readonly readyTimeoutMs?: number;
	/** Reconnect backoff floor. Default 100 ms. */
	readonly backoffMinMs?: number;
	/** Reconnect backoff ceiling. Default 2 000 ms. */
	readonly backoffMaxMs?: number;
	/** Frames of credit granted per consumed stream frame. Default 1. */
	readonly creditStep?: number;
	/** Initial credit on stream.open. Default {@link DEFAULT_STREAM_CREDIT}. */
	readonly initialStreamCredit?: number;
	/** Connection state changes (UI status line, tests). */
	readonly onStateChange?: (state: McodedClientState) => void;
	/**
	 * Reconnect hook: called after a successful RE-handshake, once the client
	 * re-attached/re-subscribed and before replayed events flow (§4.6.3).
	 */
	readonly onReconnected?: (info: { attempts: number }) => void;
}

/** Connection lifecycle of the client. */
export type McodedClientState =
	| 'disconnected'
	| 'connecting'
	| 'ready'
	| 'reconnecting'
	| 'closed';

/** Terminal info of one client-side stream. */
export interface StreamEnd {
	readonly reason: 'done' | 'detached' | 'aborted' | 'error';
	readonly resumable?: boolean;
	readonly error?: string;
}

/** One opened remote stream (`stream.open` → `stream.frame`/`stream.end`). */
export interface RemoteStream<Frame> {
	readonly streamId: string;
	/** The frames, credit-managed: consuming replenishes the server budget. */
	readonly frames: AsyncIterable<Frame>;
	/** Resolves with the terminal `stream.end` info. */
	readonly ended: Promise<StreamEnd>;
	/** `detach` — stop listening, let the turn continue (I-DETACH). */
	detach(): void;
	/** `abort` — the explicit `abortSession` path (W0 F3). */
	abort(): Promise<void>;
}

/** One GlobalEvent subscription (`subscribe` → `event`). */
export interface RemoteEventStream {
	/** Events in cursor order (replay + live, deduplicated by cursor). */
	readonly events: AsyncIterable<{ cursor: Cursor; event: GlobalEvent }>;
	/** Resolves with the gap when the cursor was evicted (§4.6.3). */
	readonly gapped: Promise<{ after: string; head: string | null } | undefined>;
	/** Stop buffering locally (no server frame — the connection owns it). */
	stop(): void;
}

/** `daemon.status` payload. */
export interface DaemonStatusData {
	pid: number;
	buildId: string;
	uptimeMs: number;
	protocol: { version: number; minor: number };
	connections: number;
	attachedSessions: number;
	activeStreams: number;
	/** W5 (§4.6.5): live turns (running or detached-draining), incl. dead windows'. */
	activeTurns?: number;
	/** The live turns themselves (sessionId + elapsed) — the stop/restart drain guard's input. */
	activeRuns?: DaemonActiveRun[];
	/** W5: asks seen and not resolved/dismissed/superseded yet. */
	pendingPermissions?: number;
	/** W5: a `daemon.restart{when:'idle'}` is scheduled. */
	restartPending?: boolean;
	head: string | null;
	globalHead: string | null;
	eventLoopLagP99Ms?: number;
	rssBytes: number;
	publishStaleSessions: readonly string[];
}

/** A `call` failed at the daemon with its stable wire code. */
export class McodedRemoteError extends Error {
	readonly code: McodedErrorCode | undefined;
	readonly errorName: string | undefined;
	readonly data: unknown;

	constructor(
		message: string,
		options: { code?: McodedErrorCode; errorName?: string; data?: unknown } = {},
	) {
		super(message);
		this.name = 'McodedRemoteError';
		this.code = options.code;
		this.errorName = options.errorName;
		this.data = options.data;
	}
}

/** Thrown when the client is closed or the connection dropped mid-call. */
export class McodedConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'McodedConnectionError';
	}
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface StreamHandle {
	streamId: string;
	queue: unknown[];
	waiters: Array<(result: IteratorResult<unknown>) => void>;
	ended: Promise<StreamEnd>;
	settleEnd: (end: StreamEnd) => void;
	finished: boolean;
}

interface SubscriptionHandle {
	scope: 'catalog+attached' | 'all';
	lastCursor: Cursor | null;
	queue: Array<{ cursor: Cursor; event: GlobalEvent }>;
	waiters: Array<(result: IteratorResult<{ cursor: Cursor; event: GlobalEvent }>) => void>;
	stopped: boolean;
	gapped: Promise<{ after: string; head: string | null } | undefined>;
	settleGap: (gap: { after: string; head: string | null } | undefined) => void;
}

function makeSubscriptionHandle(
	scope: 'catalog+attached' | 'all',
	lastCursor: Cursor | null,
): SubscriptionHandle {
	const handle: SubscriptionHandle = {
		scope,
		lastCursor,
		queue: [],
		waiters: [],
		stopped: false,
		gapped: Promise.resolve(undefined),
		settleGap: () => undefined,
	};
	handle.gapped = new Promise((resolve) => {
		handle.settleGap = resolve;
	});
	return handle;
}

/**
 * The v2 client: one connection, multiplexed calls/streams, auto-reconnect.
 * Transport-agnostic via `options.connect`; the default dials the unix
 * socket and applies the inbound frame limit mirror of the daemon's.
 */
export class McodedClient {
	private readonly socketPath: string;
	private readonly handshakePayload: McodedClientHandshake;
	private readonly connectOverride: (() => Promise<LineTransport>) | undefined;
	private readonly spawnHook: (() => Promise<void | boolean | 'booting'>) | undefined;
	private readonly crashLoop: CrashLoopWatchdog | undefined;
	private readonly readyTimeoutMs: number;
	private readonly backoffMinMs: number;
	private readonly backoffMaxMs: number;
	private readonly creditStep: number;
	private readonly initialStreamCredit: number;
	private readonly stateListeners: Array<(state: McodedClientState) => void> = [];
	private readonly reconnectedListeners: Array<(info: { attempts: number }) => void> = [];

	private transport: LineTransport | undefined;
	private readerTask: Promise<void> | undefined;
	private reconnectTask: Promise<void> | undefined;
	private state: McodedClientState = 'disconnected';
	private readonly pending = new Map<string, PendingCall>();
	private readonly streams = new Map<string, StreamHandle>();
	/**
	 * Frames of streams the open-response has not claimed YET: the wire is
	 * ordered, but resolving the `stream.open` response hands control back to
	 * the awaiting microtask only AFTER the whole read batch is dispatched —
	 * so early `stream.frame`s land here and `makeStream` drains them.
	 */
	private readonly orphanFrames = new Map<string, Array<{ frame?: unknown; end?: StreamEnd }>>();
	private readonly subscriptions = new Set<SubscriptionHandle>();
	private readonly attachments = new Map<
		string,
		{ role: 'owner' | 'observer'; toolEnv?: SessionToolEnv }
	>();
	private requestSeq = 0;
	private welcome: HelloData | undefined;
	private reconnectAttempts = 0;
	private userClosed = false;
	private readonly helloWaiters: Array<{
		resolve: (data: HelloData) => void;
		reject: (error: Error) => void;
	}> = [];

	constructor(options: McodedClientOptions) {
		this.socketPath = options.socketPath;
		this.handshakePayload = options.handshake;
		this.connectOverride = options.connect;
		this.spawnHook = options.spawn;
		this.crashLoop = options.crashLoop;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
		this.backoffMinMs = options.backoffMinMs ?? 100;
		this.backoffMaxMs = options.backoffMaxMs ?? 2_000;
		this.creditStep = options.creditStep ?? 1;
		this.initialStreamCredit = options.initialStreamCredit ?? DEFAULT_STREAM_CREDIT;
		if (options.onStateChange) this.stateListeners.push(options.onStateChange);
		if (options.onReconnected) this.reconnectedListeners.push(options.onReconnected);
	}

	/** Subscribe to connection state changes (returns an unsubscribe fn). */
	onStateChange(listener: (state: McodedClientState) => void): () => void {
		this.stateListeners.push(listener);
		return () => {
			const index = this.stateListeners.indexOf(listener);
			if (index >= 0) this.stateListeners.splice(index, 1);
		};
	}

	/** Subscribe to successful RE-handshakes (W4: refresh cached snapshots). */
	onReconnected(listener: (info: { attempts: number }) => void): () => void {
		this.reconnectedListeners.push(listener);
		return () => {
			const index = this.reconnectedListeners.indexOf(listener);
			if (index >= 0) this.reconnectedListeners.splice(index, 1);
		};
	}

	/** Current connection state. */
	get connectionState(): McodedClientState {
		return this.state;
	}

	/** The v2 welcome of the live connection (head cursor, daemon features). */
	get hello(): HelloData | undefined {
		return this.welcome;
	}

	/** Whether the live daemon advertised a feature. */
	hasFeature(feature: string): boolean {
		return this.welcome?.features?.includes(feature) ?? false;
	}

	/**
	 * W5 (§4.6.5): the honest feature-skew gate — every v2 operation checks
	 * the daemon's advertised set before using it. A daemon OLDER than this
	 * client fails LOUDLY here ("restart the daemon") instead of answering a
	 * cryptic `METHOD_NOT_ALLOWED` from the wire (or worse, silently
	 * degrading). Same-major skew works whenever this check passes.
	 *
	 * A welcome WITHOUT a `features` field (a v1 shim welcome, a bare test
	 * peer) is not verifiable — the gate skips, the daemon keeps enforcing
	 * its own side of the contract.
	 */
	requireFeature(feature: string): void {
		const features = this.welcome?.features;
		if (features === undefined || features.includes(feature)) return;
		throw new McodedConnectionError(
			`the daemon does not advertise feature "${feature}" (it is older than this ` +
				`client); run "mcode daemon restart" to bring it to the current build`,
		);
	}

	/** Connect + handshake; auto-spawns via the hook while the socket is dead. */
	async connect(): Promise<HelloData> {
		if (this.state === 'ready' && this.welcome) return this.welcome;
		if (this.state === 'closed') throw new McodedConnectionError('client is closed');
		this.userClosed = false;
		this.setState('connecting');
		// Per-round grace (reset after every spawn round — a started child, or
		// a sibling's spawn under way, may legitimately need longer than one
		// window to reach ready), capped by a hard total: 4 windows. Without
		// the reset the 20 s deadline expired while the crash-loop watchdog's
		// own decision (3 × 20 s spawn waits) was still pending, and the raw
		// ENOENT masked the real state; without the cap an alive-probe lie
		// would loop forever.
		let hardDeadline = Date.now() + this.readyTimeoutMs * 4;
		// Hook rounds that watched a live daemon boot extend the hard
		// deadline by their duration, up to this total.
		let bootExtensionLeft = DAEMON_BOOT_WAIT_MS;
		let deadline = Date.now() + this.readyTimeoutMs;
		// The last spawn-hook failure, if the hook THREW (lock permission,
		// unwritable control root, no entry script...). Surfaced instead of the
		// raw socket error when the deadline expires: "connect ENOENT — retry
		// after the connection recovers" is a lie when spawning itself is
		// broken; the hook's error names the actionable root.
		let lastSpawnFailure: unknown;
		for (;;) {
			try {
				return await this.connectOnce();
			} catch (error) {
				if (this.userClosed) throw new McodedConnectionError('client closed during connect');
				if (!(error instanceof SocketConnectError)) throw error;
				if (this.spawnHook) {
					// §4.6.4: a tripped watchdog refuses to respawn — the caller
					// gets the honest crash-loop failure, not another dead child.
					this.crashLoop?.requireSpawn();
					let spawnedChild = false;
					const hookStartedAt = Date.now();
					try {
						const outcome = await this.spawnHook();
						spawnedChild = outcome === true;
						lastSpawnFailure = undefined;
						if (outcome === 'booting') {
							const extension = Math.min(Date.now() - hookStartedAt, bootExtensionLeft);
							bootExtensionLeft -= extension;
							hardDeadline += extension;
						}
					} catch (spawnError) {
						log.warn('client-spawn-failed', { err: spawnError });
						lastSpawnFailure = spawnError;
					}
					if (this.userClosed) throw new McodedConnectionError('client closed during connect');
					// The client-side image of a daemon death (§4.6.4): the hook
					// started a life and the connect STILL failed. A no-op round
					// (daemon alive / sibling spawning) is not a crash.
					if (this.crashLoop && spawnedChild) this.crashLoop.recordCrash();
					this.crashLoop?.requireSpawn();
					if (spawnedChild || lastSpawnFailure === undefined) {
						// Reset the grace window after a round that STARTED a
						// child or observed a sibling spawning (hook no-op):
						// readiness may legitimately arrive after this round's
						// connect attempt — a long daemon boot must not be cut
						// down by the original 20 s window. A hook that THREW
						// does not reset: a broken spawner will not heal, and
						// the surfaced failure should come at the first
						// deadline, not after four of them.
						deadline = Math.min(Date.now() + this.readyTimeoutMs, hardDeadline);
					}
				}
				if (Date.now() >= deadline) {
					if (lastSpawnFailure !== undefined) {
						throw new McodedConnectionError(
							`daemon socket is not answering and auto-spawn failed: ${
								lastSpawnFailure instanceof Error
									? lastSpawnFailure.message
									: String(lastSpawnFailure)
							}`,
						);
					}
					throw error;
				}
				await delay(
					Math.min(this.backoffMinMs * 2 ** this.reconnectAttempts, this.backoffMaxMs),
				);
			}
		}
	}

	/**
	 * One typed `call`. Daemon-minted ids are unique for the client's WHOLE
	 * life (never reset across reconnects); a caller that needs
	 * reconnect-idempotent retries pins the id via {@link callIdempotent}.
	 */
	async call<M extends CallMethod>(
		method: M,
		...params: RemoteCallParams<M>
	): Promise<Awaited<ReturnType<CliService[M]>>> {
		this.assertReady();
		this.requireFeature('call');
		const response = await this.request(this.nextId(), {
			type: 'call',
			id: 'pending',
			method,
			params,
		});
		return response as Awaited<ReturnType<CliService[M]>>;
	}

	/**
	 * Typed `call` under a caller-chosen id: the same `(clientInstanceId, id)`
	 * after a reconnect hits the daemon's dedup window and replays the
	 * RECORDED outcome (arch §4.3.5) instead of re-executing.
	 */
	async callIdempotent<M extends CallMethod>(
		id: string,
		method: M,
		...params: RemoteCallParams<M>
	): Promise<Awaited<ReturnType<CliService[M]>>> {
		this.assertReady();
		this.requireFeature('call');
		const response = await this.request(id, { type: 'call', id, method, params });
		return response as Awaited<ReturnType<CliService[M]>>;
	}

	/**
	 * Open one of the three stream methods. `params` is the raw argument list
	 * (`[req]` / `[req, options]`); the typed wrappers live in
	 * {@link RemoteCliService}. A refused open REJECTS with the mirrored
	 * `{status, body}` in `McodedRemoteError.data` (arch §4.3.2).
	 */
	async openStream<Frame = SessionStreamFrameView>(
		method: StreamCliMethod,
		params: unknown[],
		credit?: number,
	): Promise<RemoteStream<Frame>> {
		this.assertReady();
		this.requireFeature('stream');
		const openFrame: ClientFrame = {
			type: 'stream.open',
			id: this.nextId(),
			method,
			params,
			...(credit !== undefined ? { credit } : { credit: this.initialStreamCredit }),
		};
		const data = (await this.request(openFrame.id, openFrame)) as { streamId: string };
		return this.makeStream<Frame>(data.streamId);
	}

	/**
	 * Attach to a session (the event-routing key, arch §4.3.4).
	 *
	 * The optional `toolEnv` is the window's env/cwd snapshot (arch §4.4/R5,
	 * revision 11 F3): the daemon applies it to THIS session's tool spawns, so
	 * the tools see the window's shell environment, not the daemon's frozen
	 * first-spawn env. Re-sending the attach with a FRESH snapshot is the
	 * update path — the daemon's "last owner attach wins" store takes the new
	 * values for the next turn. The latest snapshot is retained and re-sent
	 * verbatim on reconnect (§4.6.3 re-attach), so a window's env survives the
	 * daemon or network dying mid-session.
	 */
	async sessionAttach(
		sessionId: string,
		role: 'owner' | 'observer' = 'owner',
		toolEnv?: SessionToolEnv,
	): Promise<void> {
		this.assertReady();
		this.requireFeature('attach');
		const id = this.nextId();
		await this.request(id, {
			type: 'session.attach',
			id,
			sessionId,
			role,
			...(toolEnv !== undefined ? { toolEnv } : {}),
		});
		this.attachments.set(sessionId, { role, ...(toolEnv !== undefined ? { toolEnv } : {}) });
	}

	/** Detach from a session. */
	async sessionDetach(sessionId: string): Promise<void> {
		this.assertReady();
		this.requireFeature('attach');
		const id = this.nextId();
		await this.request(id, { type: 'session.detach', id, sessionId });
		this.attachments.delete(sessionId);
	}

	/**
	 * Subscribe to GlobalEvents (arch §4.3.2). Survives reconnects: the client
	 * re-subscribes with `after: lastCursor`, replaying exactly the missed
	 * window. Attachments held NOW also filter the replay (§4.6.3) — attach
	 * before subscribing.
	 */
	subscribe(options: { after?: Cursor; scope?: 'catalog+attached' | 'all' } = {}): RemoteEventStream {
		this.assertReady();
		this.requireFeature('subscribe');
		const handle = makeSubscriptionHandle(
			options.scope ?? 'catalog+attached',
			options.after ?? null,
		);
		this.subscriptions.add(handle);
		void this.sendSubscribe(handle);
		return {
			events: iterateSubscription(handle),
			gapped: handle.gapped,
			stop: () => {
				handle.stopped = true;
				this.subscriptions.delete(handle);
				// W5: a consumer parked in `next()` when the stop landed must see
				// `done` — otherwise the event loop (TUI watch, ACP pump) hangs
				// forever on a subscription that will never deliver again.
				for (const waiter of handle.waiters.splice(0)) {
					waiter({ done: true, value: undefined });
				}
			},
		};
	}

	/** Heartbeat roundtrip (`ping` → `pong`). */
	async ping(): Promise<void> {
		this.assertReady();
		const id = this.nextId();
		await this.request(id, { type: 'ping', id });
	}

	/** `daemon.status` snapshot (§4.6.7). */
	async daemonStatus(): Promise<DaemonStatusData> {
		this.assertReady();
		const id = this.nextId();
		return (await this.request(id, { type: 'daemon.status', id })) as DaemonStatusData;
	}

	/** `daemon.restart{when:'now'}` — graceful drain + exit (§4.6.5). */
	async daemonRestart(when: 'now'): Promise<void>;
	/** `daemon.restart{when:'idle'}` — waits for no turns/pending asks, then drains (§4.6.5, W5). */
	async daemonRestart(when: 'idle'): Promise<void>;
	async daemonRestart(when: 'now' | 'idle'): Promise<void> {
		this.assertReady();
		if (when === 'idle') this.requireFeature('restart-when-idle');
		const id = this.nextId();
		await this.request(id, { type: 'daemon.restart', id, when });
	}

	/** `daemon.authSync` — the daemon re-reads the OAuth store (§4.4). */
	async daemonAuthSync(): Promise<void> {
		this.assertReady();
		const id = this.nextId();
		await this.request(id, { type: 'daemon.authSync', id });
	}

	/** Graceful daemon stop (the v1 `shutdown` frame, unchanged). */
	async shutdown(): Promise<void> {
		this.assertReady();
		const id = this.nextId();
		await this.request(id, { type: 'shutdown', id });
	}

	/** Close the client (stops the reconnect loop; pending calls reject). */
	close(): void {
		this.userClosed = true;
		this.teardown('client closed');
		this.setState('closed');
	}

	// ------------------------------------------------------------------
	// internals
	// ------------------------------------------------------------------

	private nextId(): string {
		this.requestSeq += 1;
		return `c${this.requestSeq}`;
	}

	private assertReady(): void {
		if (this.state !== 'ready' || !this.transport) {
			throw new McodedConnectionError(`client is ${this.state}, not ready`);
		}
	}

	private async request(id: string, frame: ClientFrame): Promise<unknown> {
		const transport = this.transport;
		if (!transport || this.state !== 'ready') {
			throw new McodedConnectionError(`client is ${this.state}, not ready`);
		}
		const promise = new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		transport.write(serializeFrame({ ...frame, id } as ClientFrame));
		return promise;
	}

	private async connectOnce(): Promise<HelloData> {
		const transport =
			(await this.connectOverride?.()) ?? (await this.connectSocket(this.socketPath));
		this.transport = transport;
		// The reader must run BEFORE the handshake: the hello response arrives
		// through the read loop, and nothing else consumes the transport.
		this.readerTask = this.readLoop(transport);
		let welcome: HelloData;
		try {
			welcome = await this.handshake(transport);
		} catch (error) {
			transport.end();
			this.transport = undefined;
			throw error;
		}
		this.welcome = welcome;
		this.reconnectAttempts = 0;
		this.setState('ready');
		// §4.6.3 order: attach precedes subscribe; both precede consumer hooks.
		for (const [sessionId, attachment] of this.attachments) {
			transport.write(
				serializeFrame({
					type: 'session.attach',
					id: this.nextId(),
					sessionId,
					role: attachment.role,
					...(attachment.toolEnv !== undefined
						? { toolEnv: attachment.toolEnv }
						: {}),
				} satisfies ClientFrame),
			);
		}
		for (const handle of this.subscriptions) {
			void this.sendSubscribe(handle);
		}
		if (this.reconnectAttempts > 0) {
			const attempts = this.reconnectAttempts;
			this.reconnectAttempts = 0;
			for (const listener of this.reconnectedListeners) listener({ attempts });
		}
		return welcome;
	}

	private async connectSocket(socketPath: string): Promise<LineTransport> {
		return await new Promise<LineTransport>((resolve, reject) => {
			const socket = net.connect(socketPath);
			const fail = (error: Error): void => {
				socket.destroy();
				reject(new SocketConnectError(error.message, (error as NodeJS.ErrnoException).code));
			};
			socket.once('error', fail);
			socket.once('connect', () => {
				socket.removeListener('error', fail);
				resolve(new SocketLineTransport(socket));
			});
		});
	}

	private handshake(transport: LineTransport): Promise<HelloData> {
		const handshake = this.handshakePayload;
		const dynamicToken = handshake.tokenGetter?.();
		transport.write(
			serializeFrame({
				type: 'hello',
				version: MCODED_PROTOCOL_VERSION,
				minor: MCODED_PROTOCOL_MINOR,
				features: [...MCODED_PROTOCOL_FEATURES],
				...(dynamicToken !== undefined
					? { token: dynamicToken }
					: handshake.token !== undefined
						? { token: handshake.token }
						: {}),
				...(handshake.dataDir !== undefined ? { dataDir: handshake.dataDir } : {}),
				...(handshake.env !== undefined ? { env: handshake.env } : {}),
				...(handshake.clientInstanceId !== undefined
					? { clientInstanceId: handshake.clientInstanceId }
					: {}),
				...(handshake.client !== undefined ? { client: handshake.client } : {}),
				...(handshake.promptMode !== undefined ? { promptMode: handshake.promptMode } : {}),
			} satisfies ClientFrame),
		);
		return new Promise<HelloData>((resolve, reject) => {
			this.helloWaiters.push({ resolve, reject });
		});
	}

	private async readLoop(transport: LineTransport): Promise<void> {
		try {
			const lines = transport.lines();
			for (;;) {
				const next = await lines.next();
				if (next.done) break;
				this.handleFrame(JSON.parse(next.value) as ServerFrame);
			}
		} catch (error) {
			log.warn('client-read-failed', { err: error });
		} finally {
			if (this.transport === transport) {
				this.transport = undefined;
				this.onConnectionLost();
			}
		}
	}

	private handleFrame(frame: ServerFrame): void {
		switch (frame.type) {
			case 'response': {
				if (frame.command === 'hello') {
					const waiter = this.helloWaiters.shift();
					if (!waiter) return;
					if (frame.success) waiter.resolve(frame.data as HelloData);
					else waiter.reject(new McodedRemoteError(frame.error, { code: frame.errorCode }));
					return;
				}
				const id = frame.id;
				if (id === undefined) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				if (frame.success) pending.resolve(frame.data);
				else
					pending.reject(
						new McodedRemoteError(frame.error, {
							code: frame.errorCode,
							errorName: frame.errorName,
							data: frame.errorData,
						}),
					);
				return;
			}
			case 'event': {
				for (const handle of this.subscriptions) {
					if (handle.stopped) continue;
					if (handle.lastCursor !== null && Number(frame.cursor) <= Number(handle.lastCursor)) {
						continue;
					}
					handle.lastCursor = frame.cursor;
					pushToSubscription(handle, { cursor: frame.cursor, event: frame.event as GlobalEvent });
				}
				return;
			}
			case 'replay_gap': {
				for (const handle of this.subscriptions) {
					// §4.6.3 (W4): a gap against a PREVIOUS daemon life must not kill
					// the live stream. The consumer learns about the hole through the
					// `gapped` promise (it re-lists sessions), and the client re-
					// subscribes WITHOUT `after` so the live tail keeps flowing. A
					// fresh subscribe never gaps again, so this cannot loop.
					const hadCursor = handle.lastCursor !== null;
					handle.lastCursor = null;
					handle.settleGap({ after: frame.after, head: frame.head });
					if (hadCursor) void this.sendSubscribe(handle);
				}
				return;
			}
			case 'stream.frame': {
				const handle = this.streams.get(frame.streamId);
				if (!handle) {
					this.orphan(frame.streamId, { frame: frame.frame });
					return;
				}
				if (handle.finished) return;
				pushToStream(handle, frame.frame);
				return;
			}
			case 'stream.end': {
				const handle = this.streams.get(frame.streamId);
				const end: StreamEnd = {
					reason: frame.reason,
					resumable: frame.resumable,
					error: frame.error,
				};
				if (!handle) {
					this.orphan(frame.streamId, { end });
					return;
				}
				if (handle.finished) return;
				finishStream(handle, end);
				return;
			}
			case 'pong':
			case 'bye':
			case 'notice':
				return;
		}
	}

	/** Park a frame of an unclaimed stream; bounded by the connection's flow. */
	private orphan(streamId: string, entry: { frame?: unknown; end?: StreamEnd }): void {
		let queue = this.orphanFrames.get(streamId);
		if (!queue) {
			queue = [];
			this.orphanFrames.set(streamId, queue);
		}
		queue.push(entry);
		// A stream that ends before anyone claims it cannot grow forever.
		if (queue.length > 4096) this.orphanFrames.delete(streamId);
	}

	private makeStream<Frame>(streamId: string): RemoteStream<Frame> {
		const handle: StreamHandle = {
			streamId,
			queue: [],
			waiters: [],
			ended: undefined as unknown as Promise<StreamEnd>,
			settleEnd: () => undefined,
			finished: false,
		};
		handle.ended = new Promise((resolve) => {
			handle.settleEnd = resolve;
		});
		this.streams.set(streamId, handle);
		// Claim whatever arrived between the open response and this call.
		const orphans = this.orphanFrames.get(streamId);
		this.orphanFrames.delete(streamId);
		if (orphans) {
			for (const entry of orphans) {
				if (entry.end !== undefined) {
					finishStream(handle, entry.end);
					break;
				}
				pushToStream(handle, entry.frame);
			}
		}
		return {
			streamId,
			frames: this.iterateStream<Frame>(handle),
			ended: handle.ended,
			detach: () => {
				void this.request(this.nextId(), { type: 'stream.cancel', streamId, mode: 'detach' }).catch(
					() => undefined,
				);
			},
			abort: async () => {
				await this.request(this.nextId(), { type: 'stream.cancel', streamId, mode: 'abort' });
			},
		};
	}

	/** Credit-managed iteration: each consumed frame replenishes the budget. */
	private iterateStream<Frame>(handle: StreamHandle): AsyncIterableIterator<Frame> {
		const creditStep = this.creditStep;
		const iterator: AsyncIterableIterator<Frame> = {
			[Symbol.asyncIterator]: () => iterator,
			next: () => {
				const value = handle.queue.shift();
				if (value !== undefined) {
					this.refill(handle.streamId, creditStep);
					return Promise.resolve({ done: false as const, value: value as Frame });
				}
				if (handle.finished) return Promise.resolve({ done: true as const, value: undefined });
				return new Promise<IteratorResult<Frame>>((resolve) =>
					handle.waiters.push((result) => {
						if (!result.done) this.refill(handle.streamId, creditStep);
						resolve(result as IteratorResult<Frame>);
					}),
				);
			},
		};
		return iterator;
	}

	private refill(streamId: string, frames: number): void {
		if (this.state !== 'ready' || !this.transport) return;
		this.transport.write(
			serializeFrame({ type: 'stream.credit', streamId, frames } satisfies ClientFrame),
		);
	}

	private async sendSubscribe(handle: SubscriptionHandle): Promise<void> {
		if (this.state !== 'ready' || !this.transport) return;
		const frame: ClientFrame = {
			type: 'subscribe',
			id: this.nextId(),
			scope: handle.scope,
			...(handle.lastCursor !== null ? { after: handle.lastCursor } : {}),
		};
		try {
			await this.request(frame.id, frame);
		} catch (error) {
			// A close the user asked for rejects every pending call — teardown
			// ("client closed") or a wire that died mid-close ("connection lost",
			// onConnectionLost runs before the userClosed early-return). The
			// refusal is then expected, not actionable: stay quiet (debug only),
			// so a normal exit does not read as an error. Every other failure
			// (network error on a live client, daemon refusal) keeps the WARN.
			// Via the getter: this.state is narrowed to 'ready' above, which is
			// unsound across the await — the state moves while we are suspended.
			if (this.userClosed || this.connectionState === 'closed') {
				log.debug('subscribe-failed', { err: error });
				return;
			}
			log.warn('subscribe-failed', { err: error });
		}
	}

	private onConnectionLost(): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(new McodedConnectionError('connection lost'));
		}
		for (const handle of [...this.streams.values()]) {
			finishStream(handle, { reason: 'error', error: 'connection lost', resumable: true });
		}
		for (const handle of this.helloWaiters.splice(0)) {
			handle.reject(new McodedConnectionError('connection lost'));
		}
		if (this.userClosed) return;
		this.setState('reconnecting');
		this.reconnectTask ??= this.reconnectLoop();
	}

	private async reconnectLoop(): Promise<void> {
		try {
			for (;;) {
				if (this.userClosed) return;
				const backoff = Math.min(
					this.backoffMinMs * 2 ** this.reconnectAttempts,
					this.backoffMaxMs,
				);
				this.reconnectAttempts += 1;
				await delay(backoff);
				if (this.userClosed) return;
				try {
					await this.connectOnce();
					return;
				} catch (error) {
					log.warn('reconnect-failed', { err: error, attempts: this.reconnectAttempts });
					if (this.spawnHook && error instanceof SocketConnectError) {
						try {
							await this.spawnHook();
						} catch (spawnError) {
							log.warn('client-spawn-failed', { err: spawnError });
						}
					}
				}
			}
		} finally {
			this.reconnectTask = undefined;
		}
	}

	private teardown(reason: string): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(new McodedConnectionError(reason));
		}
		for (const handle of [...this.streams.values()]) {
			finishStream(handle, { reason: 'error', error: reason });
		}
		for (const handle of this.helloWaiters.splice(0)) {
			handle.reject(new McodedConnectionError(reason));
		}
		this.transport?.end();
		this.transport = undefined;
	}

	private setState(state: McodedClientState): void {
		if (this.state === state) return;
		this.state = state;
		for (const listener of this.stateListeners) listener(state);
	}
}

function pushToSubscription(
	handle: SubscriptionHandle,
	value: { cursor: Cursor; event: GlobalEvent },
): void {
	const waiter = handle.waiters.shift();
	if (waiter) {
		waiter({ done: false, value });
		return;
	}
	handle.queue.push(value);
}

function iterateSubscription(
	handle: SubscriptionHandle,
): AsyncIterableIterator<{ cursor: Cursor; event: GlobalEvent }> {
	const iterator: AsyncIterableIterator<{ cursor: Cursor; event: GlobalEvent }> = {
		[Symbol.asyncIterator]: () => iterator,
		next: () => {
			const value = handle.queue.shift();
			if (value !== undefined) return Promise.resolve({ done: false as const, value });
			if (handle.stopped) return Promise.resolve({ done: true as const, value: undefined });
			return new Promise((resolve) => handle.waiters.push(resolve));
		},
	};
	return iterator;
}

function pushToStream(handle: StreamHandle, frame: unknown): void {
	const waiter = handle.waiters.shift();
	if (waiter) {
		waiter({ done: false, value: frame });
		return;
	}
	handle.queue.push(frame);
}

function finishStream(handle: StreamHandle, end: StreamEnd): void {
	if (handle.finished) return;
	handle.finished = true;
	for (const waiter of handle.waiters.splice(0)) waiter({ done: true, value: undefined });
	handle.settleEnd(end);
}

/** ENOENT/ECONNREFUSED marker for the connect/spawn retry logic. */
export class SocketConnectError extends Error {
	readonly errno: string | undefined;
	constructor(message: string, errno?: string) {
		super(message);
		this.name = 'SocketConnectError';
		this.errno = errno;
	}
}

// ---------------------------------------------------------------------------
// RemoteCliService — the typed remote projection of the CliService surface
// ---------------------------------------------------------------------------

/** The `watchEvents` remote shape: the global event bus over `subscribe`. */
export interface WatchEventsStream {
	readonly events: AsyncGenerator<GlobalEvent>;
	readonly gapped: Promise<{ after: string; head: string | null } | undefined>;
	stop(): void;
}

/** The `call`-able methods (stream methods ride the stream surfaces above). */
export type CallMethod = Exclude<
	RemoteCliMethod,
	'sendMessage' | 'resumeSession' | 'watchSessionUsageCommits'
>;

/** CliService parameter list minus the trailing injected `ProcessLocalContext`. */
export type RemoteCallParams<M extends RemoteCliMethod> =
	Parameters<CliService[M]> extends readonly [infer Head]
		? [Head]
		: Parameters<CliService[M]> extends readonly [
					infer Head,
					ProcessLocalContextMarker?,
					...infer Rest,
				]
			? Rest extends readonly []
				? [Head]
				: [Head, ...Rest]
			: Parameters<CliService[M]>;

/** Structural marker so the conditional above never matches non-ctx tuples. */
type ProcessLocalContextMarker = { readonly signal?: AbortSignal };

/**
 * The remote surface: every allowlisted method, params typed off CliService,
 * results typed off CliService. Generator methods keep the generator shape
 * (they yield frames lazily); everything else is a Promise (a network
 * roundtrip cannot be synchronous — the W4 port adapter
 * (`TuiRemoteCliService`) absorbs the sync minority).
 */
export type RemoteCliSurface = {
	readonly [M in RemoteCliMethod]: (
		...params: RemoteCallParams<M>
	) => RemoteReturn<M>;
};

type RemoteReturn<M extends RemoteCliMethod> =
	ReturnType<CliService[M]> extends AsyncGenerator<infer Frame, infer Return, infer Next>
		? AsyncGenerator<Frame, Return, Next>
		: Promise<Awaited<ReturnType<CliService[M]>>>;

/**
 * The frozen set of caller-visible type deltas between the local
 * {@link TuiCliSurface} and the remote {@link RemoteCliSurface} — deliberately
 * EXACTLY these, no more:
 *
 * - `params:sendMessage` — the trailing `ProcessLocalContext` (AbortSignal
 *   carrier) is stripped: a context never crosses the wire. Same applies to
 *   `resumeSession`, but its ctx is optional so the tuples stay compatible;
 *   the runtime effect is identical — the only remote in-flight cancel is
 *   `stream.cancel{mode:'abort'}` (REMAPPED IN W4: the TUI port adapter
 *   `packages/tui/src/runtime/remote-host.ts`, `TuiRemoteCliService`,
 *   translates an aborted signal into that cancel).
 * - `ret:getPlanModeCapabilities` / `ret:getSessionCacheWarmingStatus` /
 *   `ret:isGoalEnabled` — locally SYNC CliService methods, `Promise`s on the
 *   wire (a network roundtrip cannot be synchronous). Owned by the W4 port
 *   adapter since W4: the two awaited ones ride async TUI accessors
 *   unchanged; `isGoalEnabled` is served as a cached snapshot refreshed at
 *   connect/reconnect (`TuiRemoteCliService.refreshGoalEnabled`).
 *
 * A future CliService reshape that adds another delta (a newly sync method,
 * a new ctx-taking method) fails THIS compile via {@link AssertNoUndocumentedDelta};
 * removing one of these fails the `satisfies` below. W4 keeps this list honest
 * for free.
 */
type SurfaceDelta<M extends RemoteCliMethod> = [
	RemoteCallParams<M> extends Parameters<TuiCliSurface[M]> ? never : `params:${M & string}`,
	RemoteReturn<M> extends ReturnType<TuiCliSurface[M]> ? never : `ret:${M & string}`,
];
type SurfaceDeltas = { [M in RemoteCliMethod]: SurfaceDelta<M> }[RemoteCliMethod][number];
const EXPECTED_SURFACE_DELTAS = [
	'params:sendMessage',
	'ret:getPlanModeCapabilities',
	'ret:getSessionCacheWarmingStatus',
	'ret:isGoalEnabled',
] as const satisfies readonly SurfaceDeltas[];
type ExpectedDelta = (typeof EXPECTED_SURFACE_DELTAS)[number];
/** Fails the compile when the real delta set outgrows the documented one. */
type AssertNoUndocumentedDelta<T extends never> = T;
type UndocumentedDelta = AssertNoUndocumentedDelta<Exclude<SurfaceDeltas, ExpectedDelta>>;

/**
 * Typed client surface over one {@link McodedClient}. W4 hands THIS to the
 * TUI ports (type-only refactor); W3 ships it with its test coverage and no
 * TUI integration.
 */
export class RemoteCliService implements RemoteCliSurface {
	constructor(private readonly client: McodedClient) {}

	// -- stream surfaces (the reason stream.open exists) --

	sendMessage(
		req: CliSendMessageReq,
		options?: CliSendMessageOptions,
	): Promise<ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>> {
		return this.openConversationStream('sendMessage', options ? [req, options] : [req]);
	}

	async resumeSession(
		req: ResumeSessionReq,
	): Promise<ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>> {
		return this.openConversationStream('resumeSession', [req]);
	}

	/** `watchSessionUsageCommits` as a remote stream of commit ids. */
	watchSessionUsageCommits(): AsyncGenerator<string> {
		const open = (): Promise<RemoteStream<string>> =>
			this.client.openStream<string>('watchSessionUsageCommits', []);
		const iterator: AsyncGenerator<string> = (async function* () {
			const stream = await open();
			for await (const commit of stream.frames) {
				if (typeof commit === 'string') yield commit;
			}
		})();
		return iterator;
	}

	/** `watchEvents(signal?)` rides `subscribe` with the `all` scope (arch
	 * §4.3.6): the global event bus, cursor-resumed across reconnects. */
	watchEvents(): WatchEventsStream {
		const subscription = this.client.subscribe({ scope: 'all' });
		const iterator: AsyncGenerator<GlobalEvent> = (async function* () {
			for await (const entry of subscription.events) yield entry.event;
		})();
		return {
			events: iterator,
			gapped: subscription.gapped,
			stop: subscription.stop,
		};
	}

	// -- call surface (one typed line per allowlisted method) --

	private async invoke<M extends CallMethod>(
		method: M,
		...params: RemoteCallParams<M>
	): Promise<Awaited<ReturnType<CliService[M]>>> {
		return await this.client.call<M>(method, ...params);
	}

	private async openConversationStream(
		method: 'sendMessage' | 'resumeSession',
		params: unknown[],
	): Promise<ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>> {
		try {
			const stream = await this.client.openStream<SessionStreamFrameView>(method, params);
			return { ok: true, source: stream.frames };
		} catch (error) {
			if (error instanceof McodedRemoteError && error.data !== undefined) {
				const mirrored = error.data as { status?: number; body?: SessionStreamErrorBody };
				if (typeof mirrored.status === 'number') {
					return { ok: false, status: mirrored.status, body: mirrored.body as SessionStreamErrorBody };
				}
			}
			throw error;
		}
	}

	listSessions(
		...params: RemoteCallParams<'listSessions'>
	): Promise<Awaited<ReturnType<CliService['listSessions']>>> {
		return this.invoke('listSessions', ...params);
	}
	createSession(
		...params: RemoteCallParams<'createSession'>
	): Promise<Awaited<ReturnType<CliService['createSession']>>> {
		return this.invoke('createSession', ...params);
	}
	getSession(
		...params: RemoteCallParams<'getSession'>
	): Promise<Awaited<ReturnType<CliService['getSession']>>> {
		return this.invoke('getSession', ...params);
	}
	getSessionTree(
		...params: RemoteCallParams<'getSessionTree'>
	): Promise<Awaited<ReturnType<CliService['getSessionTree']>>> {
		return this.invoke('getSessionTree', ...params);
	}
	getMessages(
		...params: RemoteCallParams<'getMessages'>
	): Promise<Awaited<ReturnType<CliService['getMessages']>>> {
		return this.invoke('getMessages', ...params);
	}
	updateSession(
		...params: RemoteCallParams<'updateSession'>
	): Promise<Awaited<ReturnType<CliService['updateSession']>>> {
		return this.invoke('updateSession', ...params);
	}
	archiveSession(
		...params: RemoteCallParams<'archiveSession'>
	): Promise<Awaited<ReturnType<CliService['archiveSession']>>> {
		return this.invoke('archiveSession', ...params);
	}
	deleteSession(
		...params: RemoteCallParams<'deleteSession'>
	): Promise<Awaited<ReturnType<CliService['deleteSession']>>> {
		return this.invoke('deleteSession', ...params);
	}
	listSessionInputSummaries(
		...params: RemoteCallParams<'listSessionInputSummaries'>
	): Promise<Awaited<ReturnType<CliService['listSessionInputSummaries']>>> {
		return this.invoke('listSessionInputSummaries', ...params);
	}
	getSessionRewindPreview(
		...params: RemoteCallParams<'getSessionRewindPreview'>
	): Promise<Awaited<ReturnType<CliService['getSessionRewindPreview']>>> {
		return this.invoke('getSessionRewindPreview', ...params);
	}
	rewindSession(
		...params: RemoteCallParams<'rewindSession'>
	): Promise<Awaited<ReturnType<CliService['rewindSession']>>> {
		return this.invoke('rewindSession', ...params);
	}
	editSessionMessage(
		...params: RemoteCallParams<'editSessionMessage'>
	): Promise<Awaited<ReturnType<CliService['editSessionMessage']>>> {
		return this.invoke('editSessionMessage', ...params);
	}
	configureSessionMcpServers(
		...params: RemoteCallParams<'configureSessionMcpServers'>
	): Promise<Awaited<ReturnType<CliService['configureSessionMcpServers']>>> {
		return this.invoke('configureSessionMcpServers', ...params);
	}
	clearSessionMcpServers(
		...params: RemoteCallParams<'clearSessionMcpServers'>
	): Promise<Awaited<ReturnType<CliService['clearSessionMcpServers']>>> {
		return this.invoke('clearSessionMcpServers', ...params);
	}
	forkSession(
		...params: RemoteCallParams<'forkSession'>
	): Promise<Awaited<ReturnType<CliService['forkSession']>>> {
		return this.invoke('forkSession', ...params);
	}
	getSessionForkOptions(
		...params: RemoteCallParams<'getSessionForkOptions'>
	): Promise<Awaited<ReturnType<CliService['getSessionForkOptions']>>> {
		return this.invoke('getSessionForkOptions', ...params);
	}
	abortSession(
		...params: RemoteCallParams<'abortSession'>
	): Promise<Awaited<ReturnType<CliService['abortSession']>>> {
		return this.invoke('abortSession', ...params);
	}
	steerSession(
		...params: RemoteCallParams<'steerSession'>
	): Promise<Awaited<ReturnType<CliService['steerSession']>>> {
		return this.invoke('steerSession', ...params);
	}
	steer(
		...params: RemoteCallParams<'steer'>
	): Promise<Awaited<ReturnType<CliService['steer']>>> {
		return this.invoke('steer', ...params);
	}
	enqueueMessage(
		...params: RemoteCallParams<'enqueueMessage'>
	): Promise<Awaited<ReturnType<CliService['enqueueMessage']>>> {
		return this.invoke('enqueueMessage', ...params);
	}
	getPendingQuestionnaire(
		...params: RemoteCallParams<'getPendingQuestionnaire'>
	): Promise<Awaited<ReturnType<CliService['getPendingQuestionnaire']>>> {
		return this.invoke('getPendingQuestionnaire', ...params);
	}
	replyQuestionnaire(
		...params: RemoteCallParams<'replyQuestionnaire'>
	): Promise<Awaited<ReturnType<CliService['replyQuestionnaire']>>> {
		return this.invoke('replyQuestionnaire', ...params);
	}
	dismissQuestionnaire(
		...params: RemoteCallParams<'dismissQuestionnaire'>
	): Promise<Awaited<ReturnType<CliService['dismissQuestionnaire']>>> {
		return this.invoke('dismissQuestionnaire', ...params);
	}
	getLatestPlanReview(
		...params: RemoteCallParams<'getLatestPlanReview'>
	): Promise<Awaited<ReturnType<CliService['getLatestPlanReview']>>> {
		return this.invoke('getLatestPlanReview', ...params);
	}
	getPlanModeCapabilities(
		...params: RemoteCallParams<'getPlanModeCapabilities'>
	): Promise<Awaited<ReturnType<CliService['getPlanModeCapabilities']>>> {
		return this.invoke('getPlanModeCapabilities', ...params);
	}
	listPendingPermissions(
		...params: RemoteCallParams<'listPendingPermissions'>
	): Promise<Awaited<ReturnType<CliService['listPendingPermissions']>>> {
		return this.invoke('listPendingPermissions', ...params);
	}
	replyPermission(
		...params: RemoteCallParams<'replyPermission'>
	): Promise<Awaited<ReturnType<CliService['replyPermission']>>> {
		return this.invoke('replyPermission', ...params);
	}
	listQueueMessages(
		...params: RemoteCallParams<'listQueueMessages'>
	): Promise<Awaited<ReturnType<CliService['listQueueMessages']>>> {
		return this.invoke('listQueueMessages', ...params);
	}
	getQueueItem(
		...params: RemoteCallParams<'getQueueItem'>
	): Promise<Awaited<ReturnType<CliService['getQueueItem']>>> {
		return this.invoke('getQueueItem', ...params);
	}
	updateQueueItem(
		...params: RemoteCallParams<'updateQueueItem'>
	): Promise<Awaited<ReturnType<CliService['updateQueueItem']>>> {
		return this.invoke('updateQueueItem', ...params);
	}
	reorderQueue(
		...params: RemoteCallParams<'reorderQueue'>
	): Promise<Awaited<ReturnType<CliService['reorderQueue']>>> {
		return this.invoke('reorderQueue', ...params);
	}
	deleteQueueItem(
		...params: RemoteCallParams<'deleteQueueItem'>
	): Promise<Awaited<ReturnType<CliService['deleteQueueItem']>>> {
		return this.invoke('deleteQueueItem', ...params);
	}
	getSessionUsage(
		...params: RemoteCallParams<'getSessionUsage'>
	): Promise<Awaited<ReturnType<CliService['getSessionUsage']>>> {
		return this.invoke('getSessionUsage', ...params);
	}
	getSessionUsageSummary(
		...params: RemoteCallParams<'getSessionUsageSummary'>
	): Promise<Awaited<ReturnType<CliService['getSessionUsageSummary']>>> {
		return this.invoke('getSessionUsageSummary', ...params);
	}
	getSessionCacheWarmingStatus(
		...params: RemoteCallParams<'getSessionCacheWarmingStatus'>
	): Promise<Awaited<ReturnType<CliService['getSessionCacheWarmingStatus']>>> {
		return this.invoke('getSessionCacheWarmingStatus', ...params);
	}
	requestCompaction(
		...params: RemoteCallParams<'requestCompaction'>
	): Promise<Awaited<ReturnType<CliService['requestCompaction']>>> {
		return this.invoke('requestCompaction', ...params);
	}
	listSkills(
		...params: RemoteCallParams<'listSkills'>
	): Promise<Awaited<ReturnType<CliService['listSkills']>>> {
		return this.invoke('listSkills', ...params);
	}
	listRuntimeSkills(
		...params: RemoteCallParams<'listRuntimeSkills'>
	): Promise<Awaited<ReturnType<CliService['listRuntimeSkills']>>> {
		return this.invoke('listRuntimeSkills', ...params);
	}
	collectSessionReport(
		...params: RemoteCallParams<'collectSessionReport'>
	): Promise<Awaited<ReturnType<CliService['collectSessionReport']>>> {
		return this.invoke('collectSessionReport', ...params);
	}
	getPermissionMode(
		...params: RemoteCallParams<'getPermissionMode'>
	): Promise<Awaited<ReturnType<CliService['getPermissionMode']>>> {
		return this.invoke('getPermissionMode', ...params);
	}
	setPermissionMode(
		...params: RemoteCallParams<'setPermissionMode'>
	): Promise<Awaited<ReturnType<CliService['setPermissionMode']>>> {
		return this.invoke('setPermissionMode', ...params);
	}

	bindSessionPermissionMode(
		...params: RemoteCallParams<'bindSessionPermissionMode'>
	): Promise<Awaited<ReturnType<CliService['bindSessionPermissionMode']>>> {
		return this.invoke('bindSessionPermissionMode', ...params);
	}

	setSessionPermissionMode(
		...params: RemoteCallParams<'setSessionPermissionMode'>
	): Promise<Awaited<ReturnType<CliService['setSessionPermissionMode']>>> {
		return this.invoke('setSessionPermissionMode', ...params);
	}

	getSessionPermissionMode(
		...params: RemoteCallParams<'getSessionPermissionMode'>
	): Promise<Awaited<ReturnType<CliService['getSessionPermissionMode']>>> {
		return this.invoke('getSessionPermissionMode', ...params);
	}
	getDangerousCommandGateEnabled(
		...params: RemoteCallParams<'getDangerousCommandGateEnabled'>
	): Promise<Awaited<ReturnType<CliService['getDangerousCommandGateEnabled']>>> {
		return this.invoke('getDangerousCommandGateEnabled', ...params);
	}
	setDangerousCommandGateEnabled(
		...params: RemoteCallParams<'setDangerousCommandGateEnabled'>
	): Promise<Awaited<ReturnType<CliService['setDangerousCommandGateEnabled']>>> {
		return this.invoke('setDangerousCommandGateEnabled', ...params);
	}
	getSandboxFilesystemMode(
		...params: RemoteCallParams<'getSandboxFilesystemMode'>
	): Promise<Awaited<ReturnType<CliService['getSandboxFilesystemMode']>>> {
		return this.invoke('getSandboxFilesystemMode', ...params);
	}
	setSandboxFilesystemMode(
		...params: RemoteCallParams<'setSandboxFilesystemMode'>
	): Promise<Awaited<ReturnType<CliService['setSandboxFilesystemMode']>>> {
		return this.invoke('setSandboxFilesystemMode', ...params);
	}
	listModels(
		...params: RemoteCallParams<'listModels'>
	): Promise<Awaited<ReturnType<CliService['listModels']>>> {
		return this.invoke('listModels', ...params);
	}
	selectModel(
		...params: RemoteCallParams<'selectModel'>
	): Promise<Awaited<ReturnType<CliService['selectModel']>>> {
		return this.invoke('selectModel', ...params);
	}
	setModelFavorite(
		...params: RemoteCallParams<'setModelFavorite'>
	): Promise<Awaited<ReturnType<CliService['setModelFavorite']>>> {
		return this.invoke('setModelFavorite', ...params);
	}
	getRuntimeDiagnostics(
		...params: RemoteCallParams<'getRuntimeDiagnostics'>
	): Promise<Awaited<ReturnType<CliService['getRuntimeDiagnostics']>>> {
		return this.invoke('getRuntimeDiagnostics', ...params);
	}
	getAccountStatus(
		...params: RemoteCallParams<'getAccountStatus'>
	): Promise<Awaited<ReturnType<CliService['getAccountStatus']>>> {
		return this.invoke('getAccountStatus', ...params);
	}
	getInstructionSources(
		...params: RemoteCallParams<'getInstructionSources'>
	): Promise<Awaited<ReturnType<CliService['getInstructionSources']>>> {
		return this.invoke('getInstructionSources', ...params);
	}
	isGoalEnabled(
		...params: RemoteCallParams<'isGoalEnabled'>
	): Promise<Awaited<ReturnType<CliService['isGoalEnabled']>>> {
		return this.invoke('isGoalEnabled', ...params);
	}
	getGoal(
		...params: RemoteCallParams<'getGoal'>
	): Promise<Awaited<ReturnType<CliService['getGoal']>>> {
		return this.invoke('getGoal', ...params);
	}
	createGoal(
		...params: RemoteCallParams<'createGoal'>
	): Promise<Awaited<ReturnType<CliService['createGoal']>>> {
		return this.invoke('createGoal', ...params);
	}
	patchGoal(
		...params: RemoteCallParams<'patchGoal'>
	): Promise<Awaited<ReturnType<CliService['patchGoal']>>> {
		return this.invoke('patchGoal', ...params);
	}
	clearGoal(
		...params: RemoteCallParams<'clearGoal'>
	): Promise<Awaited<ReturnType<CliService['clearGoal']>>> {
		return this.invoke('clearGoal', ...params);
	}
	listBackgroundTasks(
		...params: RemoteCallParams<'listBackgroundTasks'>
	): Promise<Awaited<ReturnType<CliService['listBackgroundTasks']>>> {
		return this.invoke('listBackgroundTasks', ...params);
	}
	getActiveTurn(
		...params: RemoteCallParams<'getActiveTurn'>
	): Promise<Awaited<ReturnType<CliService['getActiveTurn']>>> {
		return this.invoke('getActiveTurn', ...params);
	}
	getTurnStatus(
		...params: RemoteCallParams<'getTurnStatus'>
	): Promise<Awaited<ReturnType<CliService['getTurnStatus']>>> {
		return this.invoke('getTurnStatus', ...params);
	}
	refreshPlugins(
		...params: RemoteCallParams<'refreshPlugins'>
	): Promise<Awaited<ReturnType<CliService['refreshPlugins']>>> {
		return this.invoke('refreshPlugins', ...params);
	}
	listMarketplacePlugins(
		...params: RemoteCallParams<'listMarketplacePlugins'>
	): Promise<Awaited<ReturnType<CliService['listMarketplacePlugins']>>> {
		return this.invoke('listMarketplacePlugins', ...params);
	}
	listInstalledPlugins(
		...params: RemoteCallParams<'listInstalledPlugins'>
	): Promise<Awaited<ReturnType<CliService['listInstalledPlugins']>>> {
		return this.invoke('listInstalledPlugins', ...params);
	}
	installPlugin(
		...params: RemoteCallParams<'installPlugin'>
	): Promise<Awaited<ReturnType<CliService['installPlugin']>>> {
		return this.invoke('installPlugin', ...params);
	}
	enablePlugin(
		...params: RemoteCallParams<'enablePlugin'>
	): Promise<Awaited<ReturnType<CliService['enablePlugin']>>> {
		return this.invoke('enablePlugin', ...params);
	}
	disablePlugin(
		...params: RemoteCallParams<'disablePlugin'>
	): Promise<Awaited<ReturnType<CliService['disablePlugin']>>> {
		return this.invoke('disablePlugin', ...params);
	}
	uninstallPlugin(
		...params: RemoteCallParams<'uninstallPlugin'>
	): Promise<Awaited<ReturnType<CliService['uninstallPlugin']>>> {
		return this.invoke('uninstallPlugin', ...params);
	}
	getWorkspaceGitMetadata(
		...params: RemoteCallParams<'getWorkspaceGitMetadata'>
	): Promise<Awaited<ReturnType<CliService['getWorkspaceGitMetadata']>>> {
		return this.invoke('getWorkspaceGitMetadata', ...params);
	}
	getWorkspaceReviewLink(
		...params: RemoteCallParams<'getWorkspaceReviewLink'>
	): Promise<Awaited<ReturnType<CliService['getWorkspaceReviewLink']>>> {
		return this.invoke('getWorkspaceReviewLink', ...params);
	}
	listWorkspaceFileTree(
		...params: RemoteCallParams<'listWorkspaceFileTree'>
	): Promise<Awaited<ReturnType<CliService['listWorkspaceFileTree']>>> {
		return this.invoke('listWorkspaceFileTree', ...params);
	}
	searchWorkspaceFiles(
		...params: RemoteCallParams<'searchWorkspaceFiles'>
	): Promise<Awaited<ReturnType<CliService['searchWorkspaceFiles']>>> {
		return this.invoke('searchWorkspaceFiles', ...params);
	}
	listMcpServers(
		...params: RemoteCallParams<'listMcpServers'>
	): Promise<Awaited<ReturnType<CliService['listMcpServers']>>> {
		return this.invoke('listMcpServers', ...params);
	}
	inspectProjectMcp(
		...params: RemoteCallParams<'inspectProjectMcp'>
	): Promise<Awaited<ReturnType<CliService['inspectProjectMcp']>>> {
		return this.invoke('inspectProjectMcp', ...params);
	}
	listUserModelProviders(
		...params: RemoteCallParams<'listUserModelProviders'>
	): Promise<Awaited<ReturnType<CliService['listUserModelProviders']>>> {
		return this.invoke('listUserModelProviders', ...params);
	}
	listProviderPresets(
		...params: RemoteCallParams<'listProviderPresets'>
	): Promise<Awaited<ReturnType<CliService['listProviderPresets']>>> {
		return this.invoke('listProviderPresets', ...params);
	}
	getCodexOAuthStatus(
		...params: RemoteCallParams<'getCodexOAuthStatus'>
	): Promise<Awaited<ReturnType<CliService['getCodexOAuthStatus']>>> {
		return this.invoke('getCodexOAuthStatus', ...params);
	}
	startCodexOAuthLogin(
		...params: RemoteCallParams<'startCodexOAuthLogin'>
	): Promise<Awaited<ReturnType<CliService['startCodexOAuthLogin']>>> {
		return this.invoke('startCodexOAuthLogin', ...params);
	}
	cancelCodexOAuthLogin(
		...params: RemoteCallParams<'cancelCodexOAuthLogin'>
	): Promise<Awaited<ReturnType<CliService['cancelCodexOAuthLogin']>>> {
		return this.invoke('cancelCodexOAuthLogin', ...params);
	}
	getMiniMaxApiKeyStatus(
		...params: RemoteCallParams<'getMiniMaxApiKeyStatus'>
	): Promise<Awaited<ReturnType<CliService['getMiniMaxApiKeyStatus']>>> {
		return this.invoke('getMiniMaxApiKeyStatus', ...params);
	}
	getMiniMaxModelSource(
		...params: RemoteCallParams<'getMiniMaxModelSource'>
	): Promise<Awaited<ReturnType<CliService['getMiniMaxModelSource']>>> {
		return this.invoke('getMiniMaxModelSource', ...params);
	}
	setMiniMaxModelSource(
		...params: RemoteCallParams<'setMiniMaxModelSource'>
	): Promise<Awaited<ReturnType<CliService['setMiniMaxModelSource']>>> {
		return this.invoke('setMiniMaxModelSource', ...params);
	}
	upsertMiniMaxApiKey(
		...params: RemoteCallParams<'upsertMiniMaxApiKey'>
	): Promise<Awaited<ReturnType<CliService['upsertMiniMaxApiKey']>>> {
		return this.invoke('upsertMiniMaxApiKey', ...params);
	}
	createUserModelProvider(
		...params: RemoteCallParams<'createUserModelProvider'>
	): Promise<Awaited<ReturnType<CliService['createUserModelProvider']>>> {
		return this.invoke('createUserModelProvider', ...params);
	}
	discoverUserModelsCandidate(
		...params: RemoteCallParams<'discoverUserModelsCandidate'>
	): Promise<Awaited<ReturnType<CliService['discoverUserModelsCandidate']>>> {
		return this.invoke('discoverUserModelsCandidate', ...params);
	}
	saveUserModelProviderCandidate(
		...params: RemoteCallParams<'saveUserModelProviderCandidate'>
	): Promise<Awaited<ReturnType<CliService['saveUserModelProviderCandidate']>>> {
		return this.invoke('saveUserModelProviderCandidate', ...params);
	}
	updateUserModelProvider(
		...params: RemoteCallParams<'updateUserModelProvider'>
	): Promise<Awaited<ReturnType<CliService['updateUserModelProvider']>>> {
		return this.invoke('updateUserModelProvider', ...params);
	}
	deleteUserModelProvider(
		...params: RemoteCallParams<'deleteUserModelProvider'>
	): Promise<Awaited<ReturnType<CliService['deleteUserModelProvider']>>> {
		return this.invoke('deleteUserModelProvider', ...params);
	}
	testUserModelProvider(
		...params: RemoteCallParams<'testUserModelProvider'>
	): Promise<Awaited<ReturnType<CliService['testUserModelProvider']>>> {
		return this.invoke('testUserModelProvider', ...params);
	}
	testUserModel(
		...params: RemoteCallParams<'testUserModel'>
	): Promise<Awaited<ReturnType<CliService['testUserModel']>>> {
		return this.invoke('testUserModel', ...params);
	}
}
