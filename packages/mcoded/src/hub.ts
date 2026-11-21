/**
 * The mcoded hub: the transport-agnostic daemon core. It owns the event
 * sequence, the replay ring, the set of connected clients and the runtime
 * adapter seam; the socket layer in `daemon.ts` only feeds connections in and
 * triggers the graceful shutdown.
 *
 * Semantics pinned here (Ф4 contract):
 * - every runtime event gets one daemon-wide monotonically increasing cursor;
 * - `events` attach without `after` replays the whole retained window, attach
 *   with `after` resumes exactly after that cursor, an unretained cursor
 *   answers `replay_gap` (never a silent skip);
 * - mutations (prompt/steer/follow_up) acknowledge the request-id once the
 *   adapter has accepted the submission;
 * - crash-only recovery: on start the hub loads the checkpoint and resumes the
 *   sequence at `lastSeq + 1`, so a restart never reassigns a cursor;
 * - graceful shutdown: refuse new work, stop the event flow, wait (bounded)
 *   for in-flight submissions, flush the final checkpoint, `bye` every client.
 *
 * @module
 */

import { timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

import { createLogger } from '@mavis/logging';

import { resolveRealPath } from '@mavis/config';

import type { CheckpointStore } from './checkpoint.js';
import { makeCheckpoint } from './checkpoint.js';
import { CliBridge, BridgeMethodError, type BridgeConnectionContext } from './cli-bridge.js';
import type { EventLog } from './event-log.js';
import {
	type ClientCommandName,
	type ClientFrame,
	type Cursor,
	type DaemonActiveRun,
	type HelloData,
	type McodedErrorCode,
	DEFAULT_STREAM_CREDIT,
	MCODED_PROTOCOL_FEATURES,
	MCODED_PROTOCOL_MINOR,
	MCODED_PROTOCOL_VERSION,
	STREAM_SINK_MAX_BYTES,
	STREAM_CLI_METHODS,
	type ServerFrame,
	type StreamCliMethod,
	compareCursors,
} from './protocol.js';
import {
	DEFAULT_REPLAY_LIMITS,
	type ReplayFrame,
	type ReplayLimits,
	ReplayRing,
} from './replay-ring.js';
import { shouldDeliverGlobalEvent } from './event-routing.js';
import { ASK_EVENT_TYPES, PermissionRouter, routedEventSessionId } from './permission-router.js';
import { SessionToolEnvStore } from './session-tool-env.js';
import { StreamMux, type MuxSink } from './stream-mux.js';
import type { RuntimeAdapter, SubmissionKind } from './runtime-adapter.js';
import type { LineTransport } from './transport.js';
import { RpcConnection, type RpcConnectionHost } from './wire.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/**
 * The daemon-side handshake identity a v2 `hello` is validated against
 * (arch §4.3.2, §4.7). Everything is optional so embedders and tests can
 * adopt the checks one at a time; the product daemon passes all three.
 */
export interface DaemonHandshake {
	/** Expected `hello.token` (the contents of `mcoded.token`, arch §4.7). */
	readonly token?: string;
	/**
	 * Re-assert the daemon's token file before answering a token-refused
	 * hello (incident 2026-11-04): the daemon holds the CAS lock, so ITS
	 * in-memory token is the source of truth — a `mcoded.token` clobbered by
	 * a losing spawner is rewritten with the daemon's own token here, and the
	 * NEXT client (which re-reads the file) passes. Called on every hello
	 * that fails the token check; idempotent when the file already matches.
	 */
	readonly resyncToken?: () => void;
	/** The realpath'd dataDir the daemon serves; `hello.dataDir` must match. */
	readonly dataDir?: string;
	/** The env identity the daemon was started with (`ENV_MISMATCH` check, R6). */
	readonly env?: { region?: string; buildEnv?: string };
}

/** Bounded request-id dedup window: retried mutations answer once, idempotently. */
const DEFAULT_REQUEST_DEDUP_LIMIT = 256;

/** Resolved-permission window for the first-answer-wins guard (§4.5 п.4). */
const MAX_RESOLVED_PERMISSION_IDS = 1024;

/** `PermissionReply.Deny` (protocol/src/local.ts) for the detached-ask policy. */
const PERMISSION_REPLY_DENY = 2;

/** Whether the event is a §4.5 ask push (permission/questionnaire). */
function isAskEvent(event: unknown): boolean {
	const type = (event as { type?: unknown } | null | undefined)?.type;
	return typeof type === 'string' && ASK_EVENT_TYPES.has(type);
}

/** The routing session of a GlobalEvent (structural probe). */
function routedSessionIdOf(event: unknown): string | undefined {
	return routedEventSessionId(event as { type?: unknown; payload?: unknown });
}

/** Hub construction options; every field has a skeleton-safe default. */
export interface McodedHubOptions {
	/** The agent runtime behind the wire. */
	readonly adapter: RuntimeAdapter;
	/** Durable checkpoint seam. */
	readonly checkpoint: CheckpointStore;
	/**
	 * Durable event log behind the replay window. Present (the product daemon
	 * always wires one): every retained frame is appended to it and a restart
	 * seeds the ring from its tail, so reconnecting clients replay across the
	 * restart instead of hitting `replay_gap`. Absent (embedders/tests): the
	 * in-memory ring only — the documented skeleton behavior.
	 */
	readonly eventLog?: EventLog;
	/** Replay window limits; defaults to the Ф4 contract budget (2000 / 8 MB). */
	readonly replayLimits?: Partial<ReplayLimits>;
	/** Bounded wait for in-flight submissions during drain. Default 5000 ms. */
	readonly drainTimeoutMs?: number;
	/**
	 * W5 (§4.6.5): how often a scheduled idle restart re-checks the turn/ask
	 * counters. Default 250 ms; tests shrink it.
	 */
	readonly idleRestartPollMs?: number;
	/** Request-id dedup window size. Default {@link DEFAULT_REQUEST_DEDUP_LIMIT}. */
	readonly requestDedupLimit?: number;
	/** v2 handshake checks applied to every `hello` (absent = no checks). */
	readonly handshake?: DaemonHandshake;
	/**
	 * v2 `call`/`stream.open` surface (arch §4.3.6). Absent: every v2
	 * call/stream frame answers `METHOD_NOT_ALLOWED` — a skeleton hub serves
	 * no CliService surface.
	 */
	readonly bridge?: CliBridge;
	/**
	 * Live GlobalEvent source for `subscribe` (arch §4.3.3): the runtime's
	 * event bus. Frames land in a dedicated in-memory replay ring with their
	 * own cursor sequence — turn frames never enter it (§4.3.4). Durable
	 * seeding of THIS ring is deferred to the daemon recomposition wave: until
	 * then a `subscribe{after}` from a previous daemon life answers
	 * `replay_gap` (the client re-lists sessions, which is the documented
	 * recovery anyway).
	 */
	readonly globalEvents?: AsyncIterable<unknown>;
	/** The daemon's prompt mode (`PROMPT_MODE_MISMATCH` check, §4.4). */
	readonly promptMode?: string;
	/**
	 * `MCODE_DETACHED_PERMISSION` policy (§4.5 п.3): what an ask does when NO
	 * window is eligible (no connected initiator, no attached window).
	 * `wait` (default) — the ask waits and every connected window gets a
	 * `notice{kind:'permission-waiting'}`; `deny` — the hub auto-denies the
	 * request through the bridge instead of leaving the turn blocked.
	 */
	readonly detachedPermission?: 'wait' | 'deny';
	/** Per-stream sink budget override. Default {@link STREAM_SINK_MAX_BYTES}. */
	readonly streamSinkMaxBytes?: number;
	/** Initial stream credit override. Default {@link DEFAULT_STREAM_CREDIT}. */
	readonly defaultStreamCredit?: number;
	/**
	 * `daemon.restart{when:'now'}` hook: the composition drains and exits.
	 * Absent: restart answers success but nothing happens (embedders).
	 */
	readonly onRestartRequested?: (when: 'idle' | 'now') => void | Promise<void>;
	/** `daemon.authSync` hook (§4.4: replace in-process `synchronizeAuth`). */
	readonly onAuthSyncRequested?: () => Promise<void>;
}

interface SessionAttachment {
	role: 'owner' | 'observer';
	/** In-memory tool-env snapshot (§4.4); never persisted, never logged. */
	toolEnv?: { cwd?: string; env?: Record<string, string> };
}

interface GlobalSubscription {
	scope: 'catalog+attached' | 'all';
	/**
	 * Newest GlobalEvent cursor delivered to this subscription. `null` = not
	 * attached to the live stream (no subscribe yet, or the replay gapped).
	 */
	lastDelivered: Cursor | null;
}

interface AttachedClient {
	readonly connection: RpcConnection;
	/**
	 * Newest cursor already delivered to this client. `null` means the client
	 * has not attached to the event stream yet; `'0'` means attached while the
	 * stream was empty, so every future cursor is deliverable.
	 */
	lastDelivered: Cursor | null;
	/** Protocol major agreed at hello (1 = the shim, 2 = v2 frames). */
	protocolVersion: number;
	/** Stable client identity from the v2 hello (dedup key half). */
	clientInstanceId: string | null;
	/** `session.attach` registry — the event-routing key (§4.3.4). */
	readonly attachments: Map<string, SessionAttachment>;
	/**
	 * W5 (§4.6.5): the feature set the client declared in its v2 `hello`.
	 * `null` = the client declared NOTHING (a v1 shim, a bare peer) — the
	 * daemon cannot verify and does not gate; a declared set is authoritative
	 * and every v2 frame it gates is refused with `FEATURE_UNSUPPORTED`.
	 */
	features: ReadonlySet<string> | null;
	/** The `subscribe` state (v2 GlobalEvent stream). */
	subscription: GlobalSubscription | null;
	/**
	 * Connection-lifetime signal for watch-style surfaces (arch §4.3.5): fired
	 * on close so subscriptions/streams unsubscribe. Per W0 F3 it never
	 * aborts a turn — only an explicit `stream.cancel{abort}` does.
	 */
	readonly connectionAbort: AbortController;
	/** The connection's stream multiplexer (created lazily). */
	mux: StreamMux | undefined;
}

/** Adapter view of one connection as a {@link MuxSink}. */
type MuxSinkAdapter = MuxSink;

/**
 * Recorded outcome of one request-id: the exact response a retry receives.
 * Success carries the recorded payload (a v2 `call` replay returns the same
 * data); failure carries the mapped error so a retry of a FAILED submission
 * sees its failure again instead of a second submission.
 */
type RecordedOutcome =
	| { readonly success: true; readonly data?: unknown }
	| {
			readonly success: false;
			readonly error: string;
			readonly errorCode?: McodedErrorCode;
			readonly errorName?: string;
			readonly errorData?: unknown;
	  };

/** Server core serving RPC connections over any line transports. */
export class McodedHub implements RpcConnectionHost {
	private readonly ring: ReplayRing;
	private readonly clients = new Set<AttachedClient>();
	private readonly pendingSubmissions = new Set<Promise<unknown>>();
	private readonly drainTimeoutMs: number;
	private readonly adapter: RuntimeAdapter;
	private readonly checkpointStore: CheckpointStore;
	private readonly eventLog: EventLog | undefined;
	private readonly requestDedupLimit: number;
	private readonly handshake: DaemonHandshake | undefined;
	/** Bounded FIFO of client-declared request ids → their recorded outcome. */
	private readonly requestDedup = new Map<string, Promise<RecordedOutcome>>();

	private nextSeq = 1;
	private started = false;
	private stopping = false;
	private stopped = false;
	private pumpTask: Promise<void> | undefined;
	private checkpointWrite: Promise<void> = Promise.resolve();
	private checkpointDirty = false;
	private mintedRequestIds = 0;
	// --- v2 state (arch §4.3) ---
	private readonly bridge: CliBridge | undefined;
	private readonly globalEvents: AsyncIterable<unknown> | undefined;
	private readonly promptMode: string | undefined;
	private readonly detachedPermission: 'wait' | 'deny';
	/**
	 * The W4 permission machinery (§4.5): ask push-routing, the per-session
	 * toolEnv snapshots, and the resolved-request window that makes
	 * "first answer wins" a daemon guarantee (a second `replyPermission` for
	 * an already-resolved request answers `ALREADY_RESOLVED`).
	 */
	public readonly permissionRouter = new PermissionRouter();
	public readonly sessionToolEnv = new SessionToolEnvStore();
	private readonly resolvedPermissionIds = new Set<string>();
	private readonly streamSinkMaxBytes: number;
	private readonly defaultStreamCredit: number;
	/**
	 * W5 (§4.6.5): the composition's restart path — `now` drains immediately,
	 * `idle` after the turn/ask counters hit zero. Public-mutable like
	 * {@link onShutdownRequested} so the daemon shell can wire it post-build.
	 */
	onRestartRequested: ((when: 'idle' | 'now') => void | Promise<void>) | undefined;
	private readonly onAuthSyncRequested: (() => Promise<void>) | undefined;
	/**
	 * W5 (§4.6.5): turn streams (sendMessage/resumeSession) that are LIVE —
	 * running or detached-but-draining — keyed `connectionId\u0000streamId`,
	 * including turns whose originator connection DIED (the daemon keeps
	 * draining them, I-DETACH; the idle-restart must wait them out). The open
	 * timestamp feeds `daemon.status.activeRuns` (`listActiveTurns`), the
	 * drain guard of `mcode daemon stop|restart`.
	 */
	private readonly liveTurnStreams = new Map<
		string,
		{ sessionId: string; method: StreamCliMethod; openedAtMs: number }
	>();
	/**
	 * W5 (§4.6.5): permission/questionnaire asks seen on the global bus that
	 * have NOT been resolved/dismissed/superseded yet — the second idle
	 * condition of `daemon.restart{when:'idle'}`.
	 */
	private readonly pendingAsks = new Map<string, string>();
	/** W5: an idle restart has been scheduled (one at a time). */
	private idleRestartTimer: NodeJS.Timeout | undefined;
	private readonly idleRestartPollMs: number;
	/** GlobalEvent replay window: only GlobalEvents, own cursor sequence (§4.3.4). */
	private readonly globalRing: ReplayRing;
	private globalPumpTask: Promise<void> | undefined;
	/** Dedup window keyed `(clientInstanceId, id)` — reconnect-idempotent calls. */
	private readonly callDedup = new Map<string, Promise<RecordedOutcome>>();
	/** event-loop lag histogram for `daemon.status` (R3 herd observability). */
	private lagHistogram: IntervalHistogram | undefined;
	private readonly startedAtMs = Date.now();

	/** Set by the daemon: a client asked for a graceful daemon shutdown. */
	onShutdownRequested: (() => void) | undefined;

	constructor(options: McodedHubOptions) {
		this.ring = new ReplayRing({ ...DEFAULT_REPLAY_LIMITS, ...options.replayLimits });
		this.adapter = options.adapter;
		this.checkpointStore = options.checkpoint;
		this.eventLog = options.eventLog;
		this.requestDedupLimit = options.requestDedupLimit ?? DEFAULT_REQUEST_DEDUP_LIMIT;
		this.drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
		this.idleRestartPollMs = options.idleRestartPollMs ?? 250;
		this.handshake = options.handshake;
		this.bridge = options.bridge;
		this.globalEvents = options.globalEvents;
		this.promptMode = options.promptMode;
		this.detachedPermission = options.detachedPermission ?? 'wait';
		this.streamSinkMaxBytes = options.streamSinkMaxBytes ?? STREAM_SINK_MAX_BYTES;
		this.defaultStreamCredit = options.defaultStreamCredit ?? DEFAULT_STREAM_CREDIT;
		this.onRestartRequested = options.onRestartRequested;
		this.onAuthSyncRequested = options.onAuthSyncRequested;
		this.globalRing = new ReplayRing({ ...DEFAULT_REPLAY_LIMITS, ...options.replayLimits });
	}

	/** Newest assigned cursor, `null` before the first event. */
	get head(): Cursor | null {
		return this.ring.head;
	}

	/** Open connections right now (tests, diagnostics). */
	get connectionCount(): number {
		return this.clients.size;
	}

	/** Sequence watermark of the newest assigned cursor (checkpoint unit). */
	get sequenceWatermark(): number {
		return this.nextSeq - 1;
	}

	/**
	 * Load durable state and start relaying runtime events.
	 *
	 * Crash-only recovery, two durable sources:
	 * - the durable event log (when wired) seeds the replay window, so
	 *   reconnecting clients replay across the restart (`after` cursors from
	 *   the previous life land inside the seeded window, never in a gap);
	 * - the checkpoint resumes the cursor sequence AFTER the newest durable
	 *   cursor of either source, so a restart never reassigns a cursor — even
	 *   when the coalesced checkpoint lost its very tail, the seeded event
	 *   cursors hold the line and the sequence only skips forward.
	 */
	async start(): Promise<void> {
		if (this.started) throw new Error('McodedHub.start called twice');
		this.started = true;
		const saved = await this.checkpointStore.load();
		let resumeSeq = (saved?.lastSeq ?? 0) + 1;
		if (this.eventLog) {
			const seeded = await this.eventLog.loadTail(this.ring.limits);
			if (seeded.length > 0) {
				this.ring.seed(seeded);
				const newestSeeded = Number(seeded[seeded.length - 1]!.cursor);
				if (newestSeeded + 1 > resumeSeq) resumeSeq = newestSeeded + 1;
				log.debug('replay-seeded', {
					frames: seeded.length,
					oldest: seeded[0]!.cursor,
					newest: seeded[seeded.length - 1]!.cursor,
				});
			}
			// Keep the durable file within the retention window from here on.
			try {
				await this.eventLog.compact(this.ring.framesSnapshot());
			} catch (error) {
				log.error('event-log-compact-failed', { err: error, phase: 'start' });
			}
		}
		// The ring must continue the durable cursor sequence, not restart it:
		// cursors are only unique across restarts if the new life counts on.
		this.ring.resumeFrom(resumeSeq);
		this.nextSeq = resumeSeq;
		log.debug('start', { lastSeq: saved?.lastSeq ?? 0, resumeSeq });
		this.pumpTask = this.pumpAdapterEvents();
		if (this.globalEvents) {
			// The GlobalEvent window starts its own sequence per daemon life (see
			// McodedHubOptions.globalEvents): subscribe{after} from a previous
			// life answers replay_gap by construction.
			this.globalPumpTask = this.pumpGlobalEvents();
		}
		this.lagHistogram = monitorEventLoopDelay({ resolution: 20 });
		this.lagHistogram.enable();
	}

	/**
	 * Accept one transport as a client connection. The connection reads frames
	 * immediately; until `hello` succeeds the hub serves it nothing.
	 */
	attachTransport(transport: LineTransport): RpcConnection {
		const client: AttachedClient = {
			connection: new RpcConnection(transport, this),
			lastDelivered: null,
			protocolVersion: 0,
			clientInstanceId: null,
			features: null,
			attachments: new Map(),
			subscription: null,
			connectionAbort: new AbortController(),
			mux: undefined,
		};
		this.clients.add(client);
		client.connection.start();
		return client.connection;
	}

	/** Implement {@link RpcConnectionHost}. */
	async onCommand(frame: ClientFrame, connection: RpcConnection): Promise<void> {
		if (this.stopping && frame.type !== 'shutdown') {
			log.warn('refused', { method: frame.type });
			connection.send({
				type: 'response',
				command: frame.type,
				success: false,
				error: 'daemon is shutting down',
				errorCode: 'DAEMON_SHUTTING_DOWN',
			});
			return;
		}
		switch (frame.type) {
			case 'hello':
				this.respondHello(frame, connection);
				return;
			case 'prompt':
			case 'steer':
			case 'follow_up':
				await this.submit(frame.type, frame.message, frame.id, connection);
				return;
			case 'abort':
				await this.abort(frame.id, connection);
				return;
			case 'events':
				this.attachEvents(frame.after, frame.limit, connection);
				return;
			case 'shutdown':
				connection.send({
					type: 'response',
					command: 'shutdown',
					success: true,
					...(frame.id ? { id: frame.id } : {}),
				});
				this.onShutdownRequested?.();
				return;
			// --- v2 (arch §4.3) ---
			case 'call':
				await this.handleCall(frame, connection);
				return;
			case 'stream.open':
				await this.handleStreamOpen(frame, connection);
				return;
			case 'stream.credit':
				this.muxOf(connection)?.credit(frame.streamId, frame.frames);
				return;
			case 'stream.cancel':
				this.handleStreamCancel(frame, connection);
				return;
			case 'session.attach':
				this.handleSessionAttach(frame, connection);
				return;
			case 'session.detach':
				this.handleSessionDetach(frame, connection);
				return;
			case 'subscribe':
				this.handleSubscribe(frame, connection);
				return;
			case 'ping':
				// Answered by the wire (works during drain); this is a backstop.
				connection.send({ type: 'pong', ...(frame.id ? { id: frame.id } : {}) });
				return;
			case 'daemon.status':
				await this.respondDaemonStatus(frame, connection);
				return;
			case 'daemon.restart':
				await this.handleDaemonRestart(frame, connection);
				return;
			case 'daemon.authSync':
				await this.handleDaemonAuthSync(frame, connection);
				return;
		}
	}

	/** Implement {@link RpcConnectionHost}. */
	onClose(connection: RpcConnection): void {
		for (const client of this.clients) {
			if (client.connection === connection) {
				// Forensics (incident 2026-11-05, verdict §2.2г): a connection
				// dying with live streams used to leave NO daemon trace (the
				// plain `disconnect` is INFO and the owner's log filter eats it).
				// These are the windows whose turns kept draining unseen — the
				// exact shape of the incident. WARN passes the filter.
				const liveStreams = client.mux?.liveStreamIds ?? [];
				if (liveStreams.length > 0) {
					const sessionIds = [
						...new Set(
							liveStreams
								.map(
									(streamId) =>
										this.liveTurnStreams.get(`${connection.connectionId}\u0000${streamId}`)
											?.sessionId,
								)
								.filter((sessionId): sessionId is string => sessionId !== undefined),
						),
					];
					log.warn('disconnect-with-live-streams', {
						connectionId: connection.connectionId,
						streams: liveStreams,
						sessionIds,
					});
				}
				// Watch-style surfaces unsubscribe first (the connection signal),
				// then every stream detaches — never aborts (I-DETACH): the
				// sources keep draining into null sinks, turns run to completion.
				client.connectionAbort.abort();
				client.mux?.close();
				this.clients.delete(client);
				return;
			}
		}
	}

	/**
	 * Graceful shutdown: drain queues, persist the checkpoint, close clients.
	 *
	 * Order matters and is pinned:
	 * 1. refuse further commands (`stopping` gate) and stop the event pump;
	 * 2. wait, bounded by `drainTimeoutMs`, for in-flight adapter submissions
	 *    so no acknowledged mutation is dropped mid-flight;
	 * 3. flush the final checkpoint (awaited — the watermark must be durable
	 *    before the process may exit);
	 * 4. `bye` + close every client connection.
	 *
	 * A failed checkpoint write (3) is logged and rethrown only after the
	 * teardown (4) completed: a durability failure must never leave the hub
	 * half-shutdown — refusing commands yet never closing the clients.
	 */
	async shutdown(): Promise<void> {
		if (this.stopped) return;
		this.stopping = true;
		// W5: a scheduled idle restart is DONE once a drain runs (any path).
		if (this.idleRestartTimer !== undefined) {
			clearInterval(this.idleRestartTimer);
			this.idleRestartTimer = undefined;
		}
		this.adapter.stop();
		this.lagHistogram?.disable();
		this.lagHistogram = undefined;
		// Detach every v2 stream (I-DETACH: drain-only, never abort) — pumps run
		// in the background; the bounded drain below never waits on a turn.
		for (const client of [...this.clients]) client.mux?.close();
		await this.drainSubmissions();
		let checkpointFailed = false;
		let checkpointError: unknown;
		try {
			await this.checkpointStore.save(makeCheckpoint(this.sequenceWatermark));
			log.info('checkpoint', { seq: this.sequenceWatermark });
		} catch (error) {
			checkpointFailed = true;
			checkpointError = error;
			log.error('checkpoint-failed', { err: error, phase: 'shutdown' });
		}
		if (this.eventLog) {
			// The replay window must be durable before clients see bye: a client
			// reconnecting to the NEXT daemon life replays from this log.
			try {
				await this.eventLog.flush();
			} catch (error) {
				log.error('event-log-flush-failed', { err: error, phase: 'shutdown' });
			}
		}
		for (const client of [...this.clients]) {
			client.connection.close('daemon-shutdown');
		}
		this.clients.clear();
		this.stopped = true;
		await this.pumpTask;
		if (checkpointFailed) throw checkpointError;
	}

	/** Await the coalesced checkpoint writer so tests can pin durability. */
	async flushCheckpoint(): Promise<void> {
		await this.checkpointWrite;
	}

	/** Await the durable event log's coalesced writer (no-op without a log). */
	async flushEventLog(): Promise<void> {
		await this.eventLog?.flush();
	}

	/**
	 * Relay adapter events: stamp a cursor, retain in the ring, mirror to the
	 * durable event log, fan out to attached clients, and track the watermark
	 * durably.
	 */
	private async pumpAdapterEvents(): Promise<void> {
		try {
			for await (const event of this.adapter.events) {
				if (this.stopping) break;
				const frame: ReplayFrame = this.ring.append(event);
				this.nextSeq = Number(frame.cursor) + 1;
				this.scheduleCheckpoint();
				this.scheduleEventLogAppend(frame);
				for (const client of [...this.clients]) {
					try {
						this.deliver(client, frame);
					} catch (error) {
						// One broken client (dead socket, unserializable runtime
						// payload) must not kill the pump for everyone else: the
						// frame is lost for this client only, and it can resync
						// by re-attaching (replay covers the missed window).
						log.warn('deliver-failed', {
							connectionId: client.connection.connectionId,
							cursor: frame.cursor,
							err: error,
						});
					}
				}
			}
		} catch (error) {
			log.error('event-pump-failed', { err: error });
			// A throwing runtime must not kill the daemon; the Ф4 runtime adds
			// structured error events. The pump simply stops relaying.
		}
	}

	/**
	 * Mirror one retained frame to the durable event log. Fire-and-forget with
	 * the failure made LOUD: replay degradation (a restart would answer gaps
	 * where this log has no frames) must never be silent, but a failing log
	 * must not stop the live stream either.
	 */
	private scheduleEventLogAppend(frame: ReplayFrame): void {
		if (!this.eventLog) return;
		this.eventLog.append(frame).catch((error: unknown) => {
			log.error('event-log-append-failed', { cursor: frame.cursor, err: error });
		});
	}

	/** Deliver one live event unless the client has already seen the cursor. */
	private deliver(client: AttachedClient, frame: ReplayFrame): void {
		if (!client.connection.isOpen) return;
		if (client.lastDelivered === null) return;
		if (compareCursors(frame.cursor, client.lastDelivered) <= 0) return;
		client.lastDelivered = frame.cursor;
		client.connection.send({ type: 'event', cursor: frame.cursor, event: frame.event });
	}

	/**
	 * Answer the handshake.
	 *
	 * A v1 hello (the shim, arch §4.3.1) keeps the exact W10/W11 semantics: a
	 * plain welcome with no payload checks. A v2 hello runs the daemon-side
	 * identity checks in the arch order — token (§4.7), then dataDir (§2.2),
	 * then env region/buildEnv (§4.3.2) — and answers the first failure with
	 * its stable error code before closing the connection: a client that fails
	 * the handshake must not stay attached to the event stream.
	 */
	private respondHello(frame: Extract<ClientFrame, { type: 'hello' }>, connection: RpcConnection): void {
		if (frame.version !== MCODED_PROTOCOL_VERSION) {
			// v1 shim: the wire already refused anything but v1/v2.
			const data: HelloData = { version: frame.version, head: this.head };
			connection.send({ type: 'response', command: 'hello', success: true, data });
			return;
		}
		const refusal = this.checkHandshake(frame);
		if (refusal) {
			log.warn('handshake-refused', { code: refusal.errorCode, connectionId: connection.connectionId });
			connection.send({
				type: 'response',
				command: 'hello',
				success: false,
				error: refusal.error,
				errorCode: refusal.errorCode,
			});
			connection.close('handshake-failed');
			return;
		}
		// v2 connection state (arch §4.3.5): the dedup key half and the prompt
		// gate are remembered for the connection's lifetime. W5 (§4.6.5): the
		// client's DECLARED feature set too — the skew half of the handshake
		// (a client that declares a set is held to it, `FEATURE_UNSUPPORTED`
		// otherwise; a client that declares nothing stays ungated).
		const client = this.findClient(connection);
		if (client) {
			client.protocolVersion = MCODED_PROTOCOL_VERSION;
			client.clientInstanceId = frame.clientInstanceId ?? `conn-${connection.connectionId}`;
			client.features = frame.features !== undefined ? new Set(frame.features) : null;
		}
		const data: HelloData = {
			version: MCODED_PROTOCOL_VERSION,
			minor: MCODED_PROTOCOL_MINOR,
			head: this.head,
			features: [...MCODED_PROTOCOL_FEATURES],
		};
		connection.send({ type: 'response', command: 'hello', success: true, data });
	}

	/** Run the configured v2 handshake checks; the first failure wins. */
	private checkHandshake(
		frame: Extract<ClientFrame, { type: 'hello' }>,
	): { errorCode: McodedErrorCode; error: string } | undefined {
		// §4.4: the daemon freezes prompt assets for ONE mode; a client speaking
		// a different mode gets a refusal with the daemon's mode as the hint.
		if (this.promptMode !== undefined && frame.promptMode !== undefined && frame.promptMode !== this.promptMode) {
			return {
				errorCode: 'PROMPT_MODE_MISMATCH',
				error: `client promptMode "${frame.promptMode}" does not match the daemon's "${this.promptMode}"; start the daemon with a matching promptMode`,
			};
		}
		const handshake = this.handshake;
		if (!handshake) return undefined;
		if (handshake.token !== undefined) {
			if (frame.token === undefined || !timingSafeEquals(frame.token, handshake.token)) {
				// Self-heal first (incident 2026-11-04): the presented token is
				// read off `mcoded.token`, so a mismatch may mean the FILE was
				// clobbered, not that the client is wrong. The resync is a
				// no-op when the file already holds the daemon's token; THIS
				// hello is still refused (its token was minted before the
				// repair), the next one re-reads the healed file.
				handshake.resyncToken?.();
				return {
					errorCode: 'UNAUTHORIZED',
					error: 'handshake token missing or invalid',
				};
			}
		}
		if (handshake.dataDir !== undefined) {
			// Both sides go through resolveRealPath AT CHECK TIME: the client
			// sends its spelling of the dataDir (which may not have existed
			// when either side resolved it — a not-yet-created profile dir
			// behind a symlinked home), and equivalence, not string identity,
			// is the contract.
			const provided = frame.dataDir !== undefined ? resolveRealPath(frame.dataDir) : undefined;
			if (provided === undefined || resolveRealPath(handshake.dataDir) !== provided) {
				return {
					errorCode: 'DATA_DIR_MISMATCH',
					error: `client dataDir ${frame.dataDir ?? '<missing>'} does not match the daemon's data directory`,
				};
			}
		}
		if (handshake.env !== undefined) {
			const region = frame.env?.region;
			const buildEnv = frame.env?.buildEnv;
			if (
				(handshake.env.region !== undefined && region !== handshake.env.region) ||
				(handshake.env.buildEnv !== undefined && buildEnv !== handshake.env.buildEnv)
			) {
				return {
					errorCode: 'ENV_MISMATCH',
					error:
						`client env (region=${region ?? '<missing>'}, buildEnv=${buildEnv ?? '<missing>'}) ` +
						`does not match the daemon's env (region=${handshake.env.region ?? '<any>'}, buildEnv=${handshake.env.buildEnv ?? '<any>'}); ` +
						'a shared daemon must serve one auth namespace',
				};
			}
		}
		return undefined;
	}

	// ------------------------------------------------------------------
	// v2 multiplexing core (arch §4.3)
	// ------------------------------------------------------------------

	/** The connection-bound context the bridge dispatches with (§4.3.2). */
	private bridgeContext(client: AttachedClient): BridgeConnectionContext {
		return {
			attachedSessionIds: new Set(client.attachments.keys()),
			// W0 F3: the runtime ignores this signal on turn streams; it only
			// unsubscribes watch-style surfaces when the connection dies.
			signal: client.connectionAbort.signal,
		};
	}

	private muxSinkOf(client: AttachedClient): MuxSinkAdapter {
		const connection = client.connection;
		return {
			send: (frame: ServerFrame): void => {
				connection.send(frame);
			},
			get isOpen(): boolean {
				return connection.isOpen;
			},
			get congested(): boolean {
				return connection.backpressure?.congested ?? false;
			},
			waitDrain: (): Promise<void> => connection.backpressure?.waitDrain() ?? Promise.resolve(),
		};
	}

	/** The connection's mux, created on first stream frame. */
	private muxOf(connection: RpcConnection): StreamMux | undefined {
		return this.findClient(connection)?.mux;
	}

	private requireMux(client: AttachedClient): StreamMux {
		client.mux ??= new StreamMux({
			sink: this.muxSinkOf(client),
			sinkMaxBytes: this.streamSinkMaxBytes,
			defaultCredit: this.defaultStreamCredit,
			label: `conn-${client.connection.connectionId}`,
			// W5 (§4.6.5): the hub counts live turn streams DOWN here — including
			// the detached-but-draining tail of a turn whose window died.
			onStreamEnd: (streamId, method) => {
				this.liveTurnStreams.delete(`${client.connection.connectionId}\u0000${streamId}`);
				void method;
				if (this.idleRestartTimer !== undefined && this.isIdleForRestart()) {
					this.scheduleIdleRestartNow();
				}
			},
		});
		return client.mux;
	}

	/**
	 * `call` → bridge dispatch with `(clientInstanceId, id)` dedup (arch
	 * §4.3.5): a retry after a reconnect — same clientInstanceId, same id —
	 * receives the RECORDED outcome instead of re-executing the method.
	 */
	private async handleCall(
		frame: Extract<ClientFrame, { type: 'call' }>,
		connection: RpcConnection,
	): Promise<void> {
		const client = this.findClient(connection);
		if (!client || !this.bridge) {
			connection.send({
				type: 'response',
				id: frame.id,
				command: 'call',
				success: false,
				error: this.bridge ? 'connection is not tracked' : 'the v2 call surface is not wired in this daemon',
				errorCode: 'METHOD_NOT_ALLOWED',
			});
			return;
		}
		// W5 (§4.6.5): a client that DECLARED its features is held to them.
		if (!this.clientAdvertises(client, 'call')) {
			this.respondMissingFeature(connection, 'call', frame.id, 'call');
			return;
		}
		const dedupKey = `${client.clientInstanceId ?? ''}\u0000${frame.id}`;
		const recorded = this.callDedup.get(dedupKey);
		if (recorded) {
			log.debug('call-dedup', { method: frame.method, id: frame.id });
			this.sendOutcome(connection, 'call', frame.id, await recorded);
			return;
		}
		const inFlight = deferredOutcome();
		this.rememberCall(dedupKey, inFlight.promise);
		const context = this.bridgeContext(client);
		// §4.5 п.4 first-answer-wins: a reply for an already-resolved request
		// is refused at the daemon BEFORE it reaches the runtime.
		if (frame.method === 'replyPermission') {
			const requestId = (frame.params?.[0] as { requestId?: unknown } | undefined)?.requestId;
			if (typeof requestId === 'string' && this.resolvedPermissionIds.has(requestId)) {
				inFlight.settle({
					success: false,
					error: `permission request ${requestId} is already resolved; first answer wins`,
					errorCode: 'ALREADY_RESOLVED',
					errorName: 'AlreadyResolved',
				});
				const outcome = await inFlight.promise;
				this.sendOutcome(connection, 'call', frame.id, outcome);
				return;
			}
		}
		try {
			const data = await this.bridge.invoke(frame.method, frame.params, context);
			const outcome: RecordedOutcome = { success: true, data };
			inFlight.settle(outcome);
			this.sendOutcome(connection, 'call', frame.id, outcome);
		} catch (error) {
			const wire = CliBridge.toWireError(error);
			const outcome: RecordedOutcome = {
				success: false,
				error: wire.message,
				errorCode: wire.code,
				errorName: wire.name,
				...(wire.data !== undefined ? { errorData: wire.data } : {}),
			};
			inFlight.settle(outcome);
			this.sendOutcome(connection, 'call', frame.id, outcome);
		}
	}

	/** Record one `(clientInstanceId, id)` outcome, bounded FIFO like v1. */
	private rememberCall(dedupKey: string, outcome: Promise<RecordedOutcome>): void {
		while (this.callDedup.size >= this.requestDedupLimit) {
			const oldest = this.callDedup.keys().next().value;
			if (oldest === undefined) break;
			this.callDedup.delete(oldest);
		}
		this.callDedup.set(dedupKey, outcome);
	}

	/**
	 * `stream.open`: the bridge opens the process-local stream; success
	 * answers `{streamId}` and starts the credit-gated pump; a refused open
	 * mirrors `ProcessLocalStreamResult` as a failed response with
	 * `errorData = {status, body}` (arch §4.3.2).
	 */
	private async handleStreamOpen(
		frame: Extract<ClientFrame, { type: 'stream.open' }>,
		connection: RpcConnection,
	): Promise<void> {
		const client = this.findClient(connection);
		if (!client || !this.bridge) {
			connection.send({
				type: 'response',
				id: frame.id,
				command: 'stream.open',
				success: false,
				error: 'the v2 stream surface is not wired in this daemon',
				errorCode: 'METHOD_NOT_ALLOWED',
			});
			return;
		}
		// W5 (§4.6.5): the declared-features gate (mirror of the client side).
		if (!this.clientAdvertises(client, 'stream')) {
			this.respondMissingFeature(connection, 'stream', frame.id, 'stream.open');
			return;
		}
		if (!(STREAM_CLI_METHODS as readonly string[]).includes(frame.method)) {
			connection.send({
				type: 'response',
				id: frame.id,
				command: 'stream.open',
				success: false,
				error: `method ${JSON.stringify(frame.method)} is not a stream method`,
				errorCode: 'METHOD_NOT_ALLOWED',
			});
			return;
		}
		const context = this.bridgeContext(client);
		try {
			const opened = await this.bridge.openStream(frame.method as StreamCliMethod, frame.params, context);
			if (!opened.ok) {
				// Forensics (incident 2026-11-05): a refused open used to leave NO
				// daemon-side trace. WARN passes the owner's `mcode:wire:error`
				// filter (namespace `mcode:rpc`, event is rare). The body is the
				// runtime's structured failure (`{key, message}`) — log its parts
				// so the next busy-refusal is visible in mcoded.log.
				const body = opened.body as { key?: unknown; message?: unknown } | undefined;
				const bodyKey = typeof body?.key === 'string' ? body.key : undefined;
				const bodyMessage = typeof body?.message === 'string' ? body.message : undefined;
				log.warn('stream-open-refused', {
					method: frame.method,
					sessionId: this.bridge.streamSessionId(frame.method as StreamCliMethod, frame.params),
					status: opened.status,
					bodyKey,
					bodyMessage: bodyMessage?.slice(0, 200),
				});
				connection.send({
					type: 'response',
					id: frame.id,
					command: 'stream.open',
					success: false,
					// `error` has always been the human-readable field on this wire
					// format; mirror the runtime's message instead of a constant.
					error: bodyMessage ?? 'stream refused by the runtime',
					errorCode: 'RUNTIME_REJECTED',
					errorName: 'StreamRefused',
					errorData: { status: opened.status, body: opened.body },
				});
				return;
			}
			const mux = this.requireMux(client);
			const streamId = mux.open(frame.method as StreamCliMethod, opened.source, frame.credit, frame.params);
			// W5 (§4.6.5): a turn stream is LIVE from its open — the idle
			// restart waits for it (running AND detached-draining both count).
			if (frame.method !== 'watchSessionUsageCommits') {
				const sessionId = this.bridge.streamSessionId(
					frame.method as StreamCliMethod,
					frame.params,
				);
				if (sessionId !== undefined) {
					this.liveTurnStreams.set(`${connection.connectionId}\u0000${streamId}`, {
						sessionId,
						method: frame.method as StreamCliMethod,
						openedAtMs: Date.now(),
					});
					// §4.5 п.1: the window that opened the turn stream is the ask
					// target for that session, keyed by clientInstanceId (reconnect
					// keeps the claim; `conn:` keys cover v1 shims without one).
					this.permissionRouter.recordTurnInitiator(
						sessionId,
						client.clientInstanceId ?? `conn:${connection.connectionId}`,
					);
				}
			}
			connection.send({
				type: 'response',
				id: frame.id,
				command: 'stream.open',
				success: true,
				data: { streamId, method: frame.method },
			});
		} catch (error) {
			const wire = CliBridge.toWireError(error);
			connection.send({
				type: 'response',
				id: frame.id,
				command: 'stream.open',
				success: false,
				error: wire.message,
				errorCode: wire.code,
				errorName: wire.name,
				...(wire.data !== undefined ? { errorData: wire.data } : {}),
			});
		}
	}

	/** `stream.cancel{mode}` — detach (turn continues) or abort (`abortSession`). */
	private handleStreamCancel(
		frame: Extract<ClientFrame, { type: 'stream.cancel' }>,
		connection: RpcConnection,
	): void {
		const client = this.findClient(connection);
		const mux = client?.mux;
		if (!client || !mux) return; // unknown stream on a dead connection: nothing to do
		if (mux.methodOf(frame.streamId) === undefined) return;
		mux.cancel(frame.streamId, frame.mode, (method, tag) => {
			if (frame.mode !== 'abort' || !this.bridge) return;
			// W0 F3: explicit abort is the ONLY turn interruption path — the
			// bridge maps the stream's session onto `abortSession`.
			return this.bridge.abortStreamTurn(method, Array.isArray(tag) ? tag : []);
		});
	}

	private handleSessionAttach(
		frame: Extract<ClientFrame, { type: 'session.attach' }>,
		connection: RpcConnection,
	): void {
		const client = this.findClient(connection);
		if (!client) return;
		// W5 (§4.6.5): the declared-features gate (mirror of the client side).
		if (!this.clientAdvertises(client, 'attach')) {
			this.respondMissingFeature(connection, 'attach', frame.id, 'session.attach');
			return;
		}
		// Last attach wins (§4.4): the toolEnv snapshot is overwritten, the
		// routing key (sessionId) is idempotent across roles.
		client.attachments.set(frame.sessionId, { role: frame.role, ...(frame.toolEnv ? { toolEnv: frame.toolEnv } : {}) });
		// §4.4: the daemon-side tool-env snapshot (owner attach wins) feeds the
		// session's tool spawns. In-memory, sanitized, never persisted/logged.
		this.sessionToolEnv.applyAttach(frame.sessionId, frame.role, frame.toolEnv);
		connection.send({ type: 'response', id: frame.id, command: 'session.attach', success: true });
	}

	private handleSessionDetach(
		frame: Extract<ClientFrame, { type: 'session.detach' }>,
		connection: RpcConnection,
	): void {
		const client = this.findClient(connection);
		if (!client) return;
		// W5 (§4.6.5): the declared-features gate (mirror of the client side).
		if (!this.clientAdvertises(client, 'attach')) {
			this.respondMissingFeature(connection, 'attach', frame.id, 'session.detach');
			return;
		}
		client.attachments.delete(frame.sessionId);
		connection.send({ type: 'response', id: frame.id, command: 'session.detach', success: true });
	}

	/**
	 * `subscribe`: attach to the GlobalEvent stream with cursor replay (arch
	 * §4.3.2). Filtering applies to the replay with the attachments held NOW
	 * (§4.6.3: attach precedes subscribe), and to live events with the
	 * attachments held at each event's delivery.
	 */
	private handleSubscribe(
		frame: Extract<ClientFrame, { type: 'subscribe' }>,
		connection: RpcConnection,
	): void {
		const client = this.findClient(connection);
		if (!client) return;
		// W5 (§4.6.5): the declared-features gate (mirror of the client side).
		if (!this.clientAdvertises(client, 'subscribe')) {
			this.respondMissingFeature(connection, 'subscribe', frame.id, 'subscribe');
			return;
		}
		const scope = frame.scope ?? 'catalog+attached';
		const replay = this.globalRing.replayAfter(frame.after);
		if (!replay.ok) {
			// v1 contract shape: a gapped cursor answers loudly; the client
			// re-lists sessions and re-subscribes. The live stream does NOT
			// attach on a gap (silent skips are never an option).
			log.warn('global-replay-gap', { after: frame.after ?? '', head: this.globalRing.head });
			connection.send({ type: 'replay_gap', after: frame.after ?? '', head: this.globalRing.head });
			return;
		}
		client.subscription = { scope, lastDelivered: null };
		const attached = new Set(client.attachments.keys());
		const deliverable = replay.frames.filter(
			(candidate) =>
				shouldDeliverGlobalEvent(candidate.event, scope, attached) &&
				// §4.5: the replay obeys the same ask isolation as live delivery —
				// a reconnecting window never replays another window's asks.
				this.mayDeliverGlobalAskOnly(client, candidate.event),
		);
		connection.send({
			type: 'response',
			id: frame.id,
			command: 'subscribe',
			success: true,
			data: {
				replayed: deliverable.length,
				head: this.globalRing.head,
				scope,
			},
		});
		for (const candidate of deliverable) {
			connection.send({ type: 'event', cursor: candidate.cursor, event: candidate.event });
		}
		const newest = deliverable[deliverable.length - 1];
		// lastDelivered advances to the RING head (not the filtered newest):
		// filtered-out frames are still "seen" by this subscription, so live
		// delivery never re-sends anything the replay window covered.
		client.subscription.lastDelivered = this.globalRing.head ?? '0';
		void newest;
	}

	/**
	 * GlobalEvent pump: stamp cursors in the dedicated ring, fan out through
	 * the routing table. Turn frames (the adapter's opaque events) NEVER enter
	 * this ring — §4.3.4 keeps it GlobalEvent-only so 8 streaming sessions
	 * cannot evict the window.
	 */
	private async pumpGlobalEvents(): Promise<void> {
		if (!this.globalEvents) return;
		try {
			for await (const event of this.globalEvents) {
				if (this.stopping) break;
				this.noteGlobalPermissionState(event);
				const frame = this.globalRing.append(event);
				// §4.5 п.3: an ask with NO eligible window waits; every connected
				// window gets the non-blocking badge, and `deny` policy auto-
				// denies instead of leaving the turn blocked forever.
				if (isAskEvent(event) && this.permissionRouter.routeAsk(
					routedSessionIdOf(event) ?? '',
					this.connectedRoutableClients(),
				).length === 0) {
					this.onUnroutedAsk(event);
				}
				for (const client of [...this.clients]) {
					try {
						this.deliverGlobal(client, frame);
					} catch (error) {
						// One broken client never kills the pump (v1 deliver rule).
						log.warn('global-deliver-failed', {
							connectionId: client.connection.connectionId,
							cursor: frame.cursor,
							err: error,
						});
					}
				}
			}
		} catch (error) {
			log.error('global-event-pump-failed', { err: error });
		}
	}

	/**
	 * Track permission state the hub itself enforces: a `permission.resolved`
	 * request id enters the resolved window, and any later `replyPermission`
	 * for it answers `ALREADY_RESOLVED` — first answer wins at the daemon
	 * level (§4.5 п.4), not just at the runtime's. W5 (§4.6.5): the ask/
	 * resolution ledger also feeds the idle-restart gate — an ask that has
	 * not been resolved/dismissed/superseded keeps the daemon BUSY.
	 */
	private noteGlobalPermissionState(event: unknown): void {
		const type = (event as { type?: unknown } | null | undefined)?.type;
		const payload = (event as { payload?: Record<string, unknown> } | null | undefined)?.payload;
		const requestId =
			typeof payload?.['requestId'] === 'string' ? (payload['requestId'] as string) : undefined;
		const sessionId =
			typeof payload?.['sessionId'] === 'string' ? (payload['sessionId'] as string) : undefined;
		if (
			(type === 'permission.ask' || type === 'questionnaire.ask') &&
			requestId !== undefined
		) {
			this.pendingAsks.set(requestId, sessionId ?? '');
			return;
		}
		if (
			requestId !== undefined &&
			(type === 'permission.resolved' ||
				type === 'questionnaire.dismiss' ||
				type === 'questionnaire.superseded')
		) {
			this.pendingAsks.delete(requestId);
			if (this.idleRestartTimer !== undefined && this.isIdleForRestart()) {
				this.scheduleIdleRestartNow();
			}
		}
		if (type !== 'permission.resolved') return;
		if (requestId === undefined || requestId.length === 0) return;
		while (this.resolvedPermissionIds.size >= MAX_RESOLVED_PERMISSION_IDS) {
			const oldest = this.resolvedPermissionIds.values().next().value;
			if (oldest === undefined) break;
			this.resolvedPermissionIds.delete(oldest);
		}
		this.resolvedPermissionIds.add(requestId);
	}

	/** The `permission-waiting` badge + optional `deny` policy for a stranded ask. */
	private onUnroutedAsk(event: unknown): void {
		const payload = (event as { payload?: Record<string, unknown> }).payload ?? {};
		const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined;
		for (const client of [...this.clients]) {
			if (!client.connection.isOpen) continue;
			client.connection.send({
				type: 'notice',
				kind: 'permission-waiting',
				...(sessionId !== undefined ? { sessionId } : {}),
				toolName: typeof payload['toolName'] === 'string' ? payload['toolName'] : undefined,
			});
		}
		if (this.detachedPermission !== 'deny' || !this.bridge) return;
		const requestId = payload['requestId'];
		const name = payload['agentName'];
		if (typeof requestId !== 'string' || requestId.length === 0) return;
		void this.bridge
			.invoke(
				'replyPermission',
				[
					{
						...(typeof name === 'string' ? { name } : {}),
						requestId,
						reply: PERMISSION_REPLY_DENY,
						...(sessionId !== undefined ? { sessionId } : {}),
					},
				],
				{
					attachedSessionIds: new Set<string>(),
					signal: new AbortController().signal,
					// The hub's own auto-deny is not a window reply: it bypasses
					// the §4.5 attach rule (there IS no attached window).
					internal: true,
				},
			)
			.catch((error: unknown) => {
				log.warn('detached-permission-deny-failed', { requestId, err: error });
			});
	}

	/** Routing view of every open connection (§4.5 ask targets). */
	private connectedRoutableClients(): Array<{
		clientInstanceId: string | null;
		attachments: ReadonlyMap<string, 'owner' | 'observer'>;
	}> {
		return [...this.clients]
			.filter((client) => client.connection.isOpen)
			.map((client) => ({
				clientInstanceId: client.clientInstanceId,
				attachments: new Map<string, 'owner' | 'observer'>(
					[...client.attachments].map(([sessionId, attach]) => [sessionId, attach.role]),
				),
			}));
	}

	/** Deliver one live GlobalEvent through the routing filter (dedup by cursor). */
	private deliverGlobal(client: AttachedClient, frame: ReplayFrame): void {
		const subscription = client.subscription;
		if (!client.connection.isOpen || !subscription) return;
		if (subscription.lastDelivered === null) return;
		if (compareCursors(frame.cursor, subscription.lastDelivered) <= 0) return;
		if (!this.mayDeliverGlobal(client, frame.event)) return;
		subscription.lastDelivered = frame.cursor;
		client.connection.send({ type: 'event', cursor: frame.cursor, event: frame.event });
	}

	/**
	 * Whether ONE client may see ONE GlobalEvent: the ordinary routing table
	 * (scope + attachments), plus §4.5 ask routing — an ask reaches only its
	 * eligible windows (initiator, else attached-owners, else observers), so
	 * window A never sees window B's approvals while A's initiator holds the
	 * session.
	 */
	private mayDeliverGlobal(client: AttachedClient, event: unknown): boolean {
		const scope = client.subscription?.scope ?? 'catalog+attached';
		if (!shouldDeliverGlobalEvent(event, scope, new Set(client.attachments.keys()))) return false;
		if (!isAskEvent(event)) return true;
		const sessionId = routedSessionIdOf(event);
		if (sessionId === undefined) return true;
		const targets = this.permissionRouter.routeAsk(sessionId, this.connectedRoutableClients());
		if (targets.length === 0) return false; // waits; the pump already notified
		return targets.some(
			(target) =>
			target.clientInstanceId !== null && target.clientInstanceId === client.clientInstanceId,
		);
	}

	/** The §4.5 ask-isolation half alone (the replay path applies the table separately). */
	private mayDeliverGlobalAskOnly(client: AttachedClient, event: unknown): boolean {
		if (!isAskEvent(event)) return true;
		const sessionId = routedSessionIdOf(event);
		if (sessionId === undefined) return true;
		const targets = this.permissionRouter.routeAsk(sessionId, this.connectedRoutableClients());
		if (targets.length === 0) return false;
		return targets.some(
			(target) =>
			target.clientInstanceId !== null && target.clientInstanceId === client.clientInstanceId,
		);
	}

	/** `daemon.status` — health snapshot for `mcode daemon status` (§4.6.7). */
	private async respondDaemonStatus(
		frame: Extract<ClientFrame, { type: 'daemon.status' }>,
		connection: RpcConnection,
	): Promise<void> {
		let attachedSessions = 0;
		let activeStreams = 0;
		for (const client of this.clients) {
			attachedSessions += client.attachments.size;
			activeStreams += client.mux?.openStreams.length ?? 0;
		}
		const lagMs = this.eventLoopLagP99Ms();
		connection.send({
			type: 'response',
			id: frame.id,
			command: 'daemon.status',
			success: true,
			data: {
				pid: process.pid,
				buildId: process.env['MCODE_BUILD_ID'] ?? 'dev',
				uptimeMs: Date.now() - this.startedAtMs,
				protocol: { version: MCODED_PROTOCOL_VERSION, minor: MCODED_PROTOCOL_MINOR },
			connections: this.clients.size,
			attachedSessions,
			activeStreams,
			// W5 (§4.6.5): the idle-restart view — live turns (incl. detached-
			// draining), unresolved asks, and whether a restart is scheduled.
			// W5 + wave 1: live client streams AND runtime-internal turns (the
			// idle-restart view must not declare a wake turn idle).
			activeTurns: this.activeTurnCount,
			// The drain guard's input: sessionId + elapsed per live turn stream.
			activeRuns: this.listActiveTurns(),
			pendingPermissions: this.pendingAsks.size,
			restartPending: this.idleRestartTimer !== undefined,
			head: this.head,
				globalHead: this.globalRing.head,
				...(lagMs !== undefined ? { eventLoopLagP99Ms: lagMs } : {}),
				rssBytes: process.memoryUsage().rss,
				publishStaleSessions: this.bridge ? await this.bridge.publishStaleSessions() : [],
			},
		});
	}

	/** p99 of the lag histogram in ms, when enough samples exist (R3). */
	private eventLoopLagP99Ms(): number | undefined {
		const histogram = this.lagHistogram;
		if (!histogram || histogram.count < 10) return undefined;
		return histogram.percentile(99) / 1e6;
	}

	private async handleDaemonRestart(
		frame: Extract<ClientFrame, { type: 'daemon.restart' }>,
		connection: RpcConnection,
	): Promise<void> {
		if (frame.when === 'idle') {
			// W5 (§4.6.5): the daemon waits for the moment with NO active turns
			// and NO pending permissions, then drains gracefully and exits — the
			// next client respawns the newer build. Every connected window gets
			// `notice{kind:'restart-pending'}` («перезапуск после завершения
			// ходов»). A second request while one is scheduled is a no-op ack.
			const activeTurns = this.activeTurnCount;
			const pendingPermissions = this.pendingPermissionCount;
			connection.send({
				type: 'response',
				id: frame.id,
				command: 'daemon.restart',
				success: true,
				data: { scheduled: true, activeTurns, pendingPermissions },
			});
			this.broadcastNotice({
				type: 'notice',
				kind: 'restart-pending',
				activeTurns,
				pendingPermissions,
			});
			log.info('restart-when-idle-scheduled', { activeTurns, pendingPermissions });
			if (this.isIdleForRestart()) {
				await this.onRestartRequested?.('idle');
				return;
			}
			this.scheduleIdleRestart();
			return;
		}
		connection.send({ type: 'response', id: frame.id, command: 'daemon.restart', success: true });
		await this.onRestartRequested?.('now');
	}

	/** Live turn streams (running or detached-draining) — the busy count. */
	get activeTurnCount(): number {
		return this.liveTurnStreams.size + this.internalTurnRuns().length;
	}

	/**
	 * Runtime-internal turns (turns the RUNTIME activated itself — e.g. a
	 * background-task delivery wake with no client window) projected into the
	 * daemon's busy/drain views. Without them an idle restart or a stop drain
	 * could fire in the middle of a wake turn: client `liveTurnStreams` and
	 * in-flight submissions do not describe runtime-internal work.
	 */
	private internalTurnRuns(): DaemonActiveRun[] {
		const snapshot = this.adapter.internalTurns?.() ?? [];
		if (snapshot.length === 0) return [];
		const now = Date.now();
		return snapshot.map((turn) => ({
			sessionId: turn.sessionId,
			method: 'internal-runtime-turn',
			elapsedMs: Math.max(0, now - turn.startedAtMs),
		}));
	}

	/**
	 * The live turn streams themselves with their elapsed time — the
	 * `daemon.status` `activeRuns` field the `mcode daemon stop|restart` drain
	 * guard lists when it refuses a shutdown without `--force`. Runtime-
	 * internal turns ride the same list (`method: 'internal-runtime-turn'`)
	 * so the guard's "refuse while any exist" covers the wake turns too.
	 */
	listActiveTurns(): DaemonActiveRun[] {
		const now = Date.now();
		const clientRuns = [...this.liveTurnStreams.values()].map((stream) => ({
			sessionId: stream.sessionId,
			method: stream.method,
			elapsedMs: Math.max(0, now - stream.openedAtMs),
		}));
		return [...clientRuns, ...this.internalTurnRuns()];
	}

	/** Asks seen on the bus and not resolved/dismissed/superseded yet. */
	get pendingPermissionCount(): number {
		return this.pendingAsks.size;
	}

	/** Whether a scheduled idle restart may fire right now (§4.6.5). */
	private isIdleForRestart(): boolean {
		return (
			!this.stopping &&
			this.liveTurnStreams.size === 0 &&
			this.pendingAsks.size === 0 &&
			this.internalTurnRuns().length === 0
		);
	}

	/** One idle-restart waiter at a time; a busy daemon keeps re-arming. */
	private scheduleIdleRestart(): void {
		if (this.idleRestartTimer !== undefined) return;
		this.idleRestartTimer = setInterval(() => {
			if (this.isIdleForRestart()) this.scheduleIdleRestartNow();
		}, this.idleRestartPollMs);
		this.idleRestartTimer.unref?.();
	}

	/** Fire the composition's drain now and stop waiting. */
	private scheduleIdleRestartNow(): void {
		if (this.idleRestartTimer !== undefined) {
			clearInterval(this.idleRestartTimer);
			this.idleRestartTimer = undefined;
		}
		if (this.stopping) return;
		log.info('restart-when-idle-draining', {});
		void this.onRestartRequested?.('idle');
	}

	/** Push one notice frame to every live connection (§4.5-style badge). */
	private broadcastNotice(frame: Extract<ServerFrame, { type: 'notice' }>): void {
		for (const client of [...this.clients]) {
			try {
				if (client.connection.isOpen) client.connection.send(frame);
			} catch (error) {
				log.warn('notice-deliver-failed', {
					connectionId: client.connection.connectionId,
					kind: frame.kind,
					err: error,
				});
			}
		}
	}

	/** W5: the declared-features gate half (`null` features = ungated). */
	private clientAdvertises(client: AttachedClient, feature: string): boolean {
		return client.features === null || client.features.has(feature);
	}

	/** Refuse one frame whose feature the client did not declare (§4.6.5). */
	private respondMissingFeature(
		connection: RpcConnection,
		feature: string,
		id: string,
		command: string,
	): void {
		log.warn('feature-unsupported', { feature, command });
		connection.send({
			type: 'response',
			id,
			command,
			success: false,
			error: `this connection did not advertise feature "${feature}" in its hello; ` +
				'restart the client or the daemon ("mcode daemon restart") to realign',
			errorCode: 'FEATURE_UNSUPPORTED',
		} as Parameters<RpcConnection['send']>[0]);
	}

	private async handleDaemonAuthSync(
		frame: Extract<ClientFrame, { type: 'daemon.authSync' }>,
		connection: RpcConnection,
	): Promise<void> {
		if (!this.onAuthSyncRequested) {
			connection.send({
				type: 'response',
				id: frame.id,
				command: 'daemon.authSync',
				success: false,
				error: 'auth sync is not wired in this daemon',
				errorCode: 'METHOD_NOT_ALLOWED',
			});
			return;
		}
		try {
			await this.onAuthSyncRequested();
			connection.send({ type: 'response', id: frame.id, command: 'daemon.authSync', success: true });
		} catch (error) {
			const wire = CliBridge.toWireError(error);
			connection.send({
				type: 'response',
				id: frame.id,
				command: 'daemon.authSync',
				success: false,
				error: wire.message,
				errorCode: wire.code,
				errorName: wire.name,
			});
		}
	}

	/**
	 * Attach the client to the event stream. `after` semantics:
	 * - omitted → deliver the whole retained window, then live events;
	 * - a retained cursor → replay strictly after it, then live;
	 * - anything else → `replay_gap` with the current head; the client must
	 *   re-attach (the cursor was evicted, or belongs to a previous daemon
	 *   life that kept no event log).
	 *
	 * `limit` bounds one attach (bounded pagination, the plan's cursor
	 * contract): at most `limit` frames are delivered and the response names
	 * `remaining`, so the client pages forward with `after: <newest cursor>`.
	 * The attach itself stays attached to the LIVE stream either way.
	 */
	private attachEvents(
		after: string | undefined,
		limit: number | undefined,
		connection: RpcConnection,
	): void {
		const client = this.findClient(connection);
		if (!client) return;
		const replay = this.ring.replayAfter(after);
		if (!replay.ok) {
			log.warn('replay-gap', { after: after ?? '', head: this.head });
			connection.send({ type: 'replay_gap', after: after ?? '', head: this.head });
			return;
		}
		const capped =
			limit !== undefined && replay.frames.length > limit
				? replay.frames.slice(0, limit)
				: replay.frames;
		const remaining = replay.frames.length - capped.length;
		connection.send({
			type: 'response',
			command: 'events',
			success: true,
			data: {
				replayed: capped.length,
				head: this.head,
				...(remaining > 0 ? { remaining } : {}),
			},
		});
		for (const frame of capped) {
			client.connection.send({ type: 'event', cursor: frame.cursor, event: frame.event });
		}
		const newestReplayed = capped[capped.length - 1];
		client.lastDelivered = newestReplayed?.cursor ?? this.head ?? '0';
	}

	/**
	 * Submit one mutation (prompt/steer/follow_up) with request-id dedup: a
	 * retry that reuses a client-declared `id` — a dropped connection during
	 * the turn, a client timeout — receives the RECORDED outcome instead of
	 * silently starting a second turn (the plan's request-dedup criterion;
	 * replayed mutations would duplicate messages and usage). Daemon-minted
	 * ids are unique per life and never collide.
	 */
	private async submit(
		kind: SubmissionKind,
		message: string,
		requestId: string | undefined,
		connection: RpcConnection,
	): Promise<void> {
		const submissionId = requestId ?? this.freshRequestId();
		const dedupKey = requestId;
		if (dedupKey !== undefined) {
			const recorded = this.requestDedup.get(dedupKey);
			if (recorded) {
				log.debug('request-dedup', { method: kind, requestId: dedupKey });
				// In-flight or settled: the retry waits for the SAME outcome.
				this.sendOutcome(connection, kind, dedupKey, await recorded);
				return;
			}
			const inFlight = deferredOutcome();
			this.rememberRequest(dedupKey, inFlight.promise);
			try {
				await this.submitOnce(kind, message, submissionId, connection);
				inFlight.settle({ success: true });
			} catch (error) {
				const outcome = runtimeFailure(error);
				inFlight.settle(outcome);
				log.warn('submit-failed', { method: kind, requestId: submissionId, err: error });
				this.sendOutcome(connection, kind, submissionId, outcome);
			}
			return;
		}
		try {
			await this.submitOnce(kind, message, submissionId, connection);
		} catch (error) {
			log.warn('submit-failed', { method: kind, requestId: submissionId, err: error });
			this.sendOutcome(connection, kind, submissionId, runtimeFailure(error));
		}
	}

	/** The single submission path — dedup is the caller's concern. */
	private async submitOnce(
		kind: SubmissionKind,
		message: string,
		submissionId: string,
		connection: RpcConnection,
	): Promise<void> {
		const submission = this.adapter.submit({ kind, message, requestId: submissionId });
		this.track(submission);
		await submission;
		connection.send({ type: 'response', command: kind, id: submissionId, success: true });
	}

	private async abort(requestId: string | undefined, connection: RpcConnection): Promise<void> {
		try {
			const running = this.adapter.abort();
			this.track(running);
			await running;
			this.sendOutcome(connection, 'abort', requestId, { success: true });
		} catch (error) {
			log.warn('abort-failed', { requestId, err: error });
			this.sendOutcome(connection, 'abort', requestId, runtimeFailure(error));
		}
	}

	/** Send a recorded outcome as the response frame for one command. */
	private sendOutcome(
		connection: RpcConnection,
		command: ClientCommandName,
		requestId: string | undefined,
		outcome: RecordedOutcome,
	): void {
		if (outcome.success) {
			connection.send({
				type: 'response',
				command,
				...(requestId ? { id: requestId } : {}),
				success: true,
				...(outcome.data !== undefined ? { data: outcome.data } : {}),
			});
			return;
		}
		connection.send({
			type: 'response',
			command,
			...(requestId ? { id: requestId } : {}),
			success: false,
			error: outcome.error,
			...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
			...(outcome.errorName ? { errorName: outcome.errorName } : {}),
			...(outcome.errorData !== undefined ? { errorData: outcome.errorData } : {}),
		});
	}

	/** Record one request id's outcome, bounded by FIFO eviction. */
	private rememberRequest(requestId: string, outcome: Promise<RecordedOutcome>): void {
		while (this.requestDedup.size >= this.requestDedupLimit) {
			const oldest = this.requestDedup.keys().next().value;
			if (oldest === undefined) break;
			this.requestDedup.delete(oldest);
		}
		// Settled records stay addressable inside the bounded window: eviction
		// is purely FIFO by insertion order.
		this.requestDedup.set(requestId, outcome);
	}

	/** Track an adapter operation so graceful shutdown can wait it out. */
	private track(operation: Promise<unknown>): void {
		const recorded = operation.catch(() => undefined);
		this.pendingSubmissions.add(recorded);
		void recorded.finally(() => this.pendingSubmissions.delete(recorded));
	}

	private freshRequestId(): string {
		// Daemon-minted ids are unique within one process; clients that care
		// about correlation send their own ids (pi-rpc optional `id`).
		this.mintedRequestIds += 1;
		return `mcoded-req-${this.mintedRequestIds}`;
	}

	private findClient(connection: RpcConnection): AttachedClient | undefined {
		for (const client of this.clients) {
			if (client.connection === connection) return client;
		}
		return undefined;
	}

	/**
	 * Wait, bounded by `drainTimeoutMs`, for the in-flight adapter operations.
	 * New ones cannot appear: the `stopping` gate refuses commands first.
	 */
	private async drainSubmissions(): Promise<void> {
		if (this.pendingSubmissions.size === 0) return;
		let timer: NodeJS.Timeout | undefined;
		try {
			const deadline = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, this.drainTimeoutMs);
				timer.unref?.();
			});
			await Promise.race([
				Promise.allSettled([...this.pendingSubmissions]),
				deadline,
			]);
			if (this.pendingSubmissions.size > 0) {
				log.warn('drain-timeout', {
					pending: this.pendingSubmissions.size,
					timeoutMs: this.drainTimeoutMs,
				});
			}
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Coalesced checkpoint writer: at most one write in flight, the latest
	 * watermark wins, appends never wait on disk. A crash can therefore lose
	 * only the very tail of the watermark — and losing ground means cursors
	 * get SKIPPED after restart, never reused (see `start`).
	 */
	private scheduleCheckpoint(): void {
		this.checkpointDirty = true;
		this.checkpointWrite = this.checkpointWrite
			.catch(() => undefined)
			.then(async () => {
				if (!this.checkpointDirty || this.stopping) return;
				this.checkpointDirty = false;
				try {
					await this.checkpointStore.save(makeCheckpoint(this.sequenceWatermark));
				} catch (error) {
					log.error('checkpoint-failed', { err: error, phase: 'coalesced' });
					throw error;
				}
			});
	}
}

/** Settled-once holder of a dedup-recorded outcome. */
interface DeferredOutcome {
	readonly promise: Promise<RecordedOutcome>;
	settle(outcome: RecordedOutcome): void;
}

function deferredOutcome(): DeferredOutcome {
	let settle!: (outcome: RecordedOutcome) => void;
	const promise = new Promise<RecordedOutcome>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

/** Map one adapter failure onto the wire's error mapping (plan: request-id/error mapping). */
function runtimeFailure(error: unknown): RecordedOutcome {
	return {
		success: false,
		error: error instanceof Error ? error.message : 'runtime adapter failed',
		errorCode: 'RUNTIME_REJECTED',
	};
}

/**
 * Constant-time string comparison for the handshake token (arch §4.7): both
 * sides are hashed first so the comparison cost never depends on the input
 * lengths, then compared with `timingSafeEqual`.
 */
function timingSafeEquals(provided: string, expected: string): boolean {
	const providedDigest = createHash('sha256').update(provided).digest();
	const expectedDigest = createHash('sha256').update(expected).digest();
	return timingSafeEqual(providedDigest, expectedDigest);
}
