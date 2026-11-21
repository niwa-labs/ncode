/**
 * The mcoded wire contract: pi-rpc semantics (`third_party/pi-mono` coding-agent
 * `modes/rpc`) carried as JSONL frames with the daemon additions the Ф4 plan
 * pins — a protocol version, a replay cursor on every event, and request-id
 * correlation on every mutation.
 *
 * The frame shapes mirror `rpc-types.ts`:
 * - client commands `{ id?, type: "prompt" | "steer" | "follow_up" | ... }`;
 * - responses `{ id?, type: "response", command, success, data? | error }`;
 * - daemon events `{ type: "event", cursor, event }`, where `event` is the
 *   opaque runtime payload relayed verbatim.
 *
 * The module is transport-agnostic: frames are plain JSON values, and the only
 * framing assumption is the JSONL line discipline (`serializeFrame` emits one
 * newline-free line per frame — the transport appends the delimiter on write;
 * JSON string escapes guarantee no payload contains a raw newline).
 *
 * @module
 */

/**
 * Protocol major version spoken by this build. The handshake fails on any
 * other major — except major 1, which stays accepted as the v1 shim (arch
 * §4.3.1: W10/W11 clients keep the old semantics until they upgrade).
 */
export const MCODED_PROTOCOL_VERSION = 2;

/** Protocol minor version; growth is additive (new optional fields/frames).
 * W5 bumps 0 → 1: `restart-when-idle` joins the advertised feature set and
 * the daemon begins enforcing client-advertised `hello.features` on the v2
 * frames (both additive — a v2.0 peer interoperates). */
export const MCODED_PROTOCOL_MINOR = 1;

/**
 * Features the daemon advertises in a v2 `hello` welcome (arch §4.3.1): new
 * frames and methods ship only behind a feature, and clients must check this
 * set before using any of them. W3 pins the multiplexing core:
 * - `call` — request/response over the {@link REMOTE_CLI_METHODS} allowlist;
 * - `stream` — `stream.open`/`stream.credit`/`stream.cancel` + `stream.frame`
 *   /`stream.end` (credit backpressure, detach-sink);
 * - `attach` — `session.attach`/`session.detach` (event routing key §4.3.4);
 * - `subscribe` — `subscribe` with cursor replay + per-session filtering
 *   (replaces v1 `watchEvents` on the wire).
 */
export const MCODED_PROTOCOL_FEATURES: readonly string[] = [
	'call',
	'stream',
	'attach',
	'subscribe',
	/**
	 * W5 (§4.6.5): `daemon.restart{when:'idle'}` is wired — the daemon waits
	 * for the moment with no active turns and no pending permissions, sends
	 * `notice{kind:'restart-pending'}` and drains. Clients check this feature
	 * (`McodedClient.hasFeature`) before scheduling an idle restart and fall
	 * back to the explicit `mcode daemon restart` on an older daemon.
	 */
	'restart-when-idle',
];

/**
 * The client identity the `hello` frame carries for the auth-namespace check
 * (arch §4.3.2, risk R6): the daemon compares `region`/`buildEnv` against the
 * identity it was started with and answers `ENV_MISMATCH` on a difference —
 * two processes must never share one daemon whose OAuth credential namespace
 * disagrees with theirs.
 */
export interface HelloEnvIdentity {
	profile?: string;
	region?: string;
	buildEnv?: string;
}

/** Commands a client may send before the handshake completes. */
export type ClientCommandName =
	| 'hello'
	| 'prompt'
	| 'steer'
	| 'follow_up'
	| 'abort'
	| 'events'
	| 'shutdown'
	// v2 frames echo their type in the `response.command` field:
	| 'call'
	| 'stream.open'
	| 'stream.credit'
	| 'stream.cancel'
	| 'session.attach'
	| 'session.detach'
	| 'subscribe'
	| 'ping'
	| 'daemon.status'
	| 'daemon.restart'
	| 'daemon.authSync';

/**
 * The client process identity a v2 `hello` carries (arch §4.3.2). The daemon
 * logs it, tags dedup windows with it and uses `buildId` for the skew
 * handshake (§4.6.5); nothing here is authoritative.
 */
export interface HelloClientIdentity {
	kind?: 'tui' | 'exec' | 'acp';
	pid?: number;
	buildId?: string;
	cwd?: string;
}

/**
 * The window-announce prompt mode carried on `hello` (arch §4.4): a mismatch
 * with the daemon's mode answers `PROMPT_MODE_MISMATCH` — the daemon freezes
 * prompt assets for ONE mode, so a mixed-mode client would render prompts
 * against the wrong template set.
 */
export type McodedPromptMode = 'tui' | 'coding' | 'work';

/**
 * Client → daemon frames (JSONL). The prompting commands keep the pi-rpc
 * command set; `hello` negotiates the protocol version, `events` attaches the
 * caller to the replayable event stream (optionally resuming after a cursor,
 * optionally paging a bounded slice), and `shutdown` asks the daemon for a
 * graceful drain.
 *
 * The v2 `hello` adds `minor`, `token`, `dataDir`, `env`, `features`,
 * `clientInstanceId`, `client` and `promptMode` — all optional so a v1 client
 * (`{version:1}`) keeps its exact old shape (the daemon-side shim, arch
 * §4.3.1).
 *
 * The v2 multiplexing frames (arch §4.3.2, gated by
 * {@link MCODED_PROTOCOL_FEATURES}):
 * - `call` → `response` for any allowlisted {@link RemoteCliMethod};
 * - `stream.open`/`stream.credit`/`stream.cancel` → `stream.frame`/
 *   `stream.end` with credit backpressure and detach-sink semantics;
 * - `session.attach`/`session.detach` — the event-routing key (§4.3.4);
 * - `subscribe` — GlobalEvent stream with cursor replay and per-session
 *   filtering (replaces `watchEvents` on the wire);
 * - `ping` → `pong` heartbeat;
 * - `daemon.status`/`daemon.restart`/`daemon.authSync` — daemon health and
 *   lifecycle.
 */
export type ClientFrame =
	| {
			type: 'hello';
			version: number;
			minor?: number;
			/** Handshake token read from `mcoded.token` in the control root. */
			token?: string;
			/** realpath of the data directory the client expects the daemon to serve. */
			dataDir?: string;
			/** Client process identity for the `ENV_MISMATCH` check. */
			env?: HelloEnvIdentity;
			features?: string[];
			/**
			 * Stable client identity that survives reconnects (arch §4.3.5): the
			 * request-dedup key is `(clientInstanceId, id)`, so a retried `call`
			 * after a dropped connection answers its RECORDED outcome instead of
			 * re-executing.
			 */
			clientInstanceId?: string;
			/** Best-effort client process identity (logging, build skew). */
			client?: HelloClientIdentity;
			/** The window's prompt mode (`PROMPT_MODE_MISMATCH` check, §4.4). */
			promptMode?: McodedPromptMode;
	  }
	| { type: 'prompt'; id?: string; message: string }
	| { type: 'steer'; id?: string; message: string }
	| { type: 'follow_up'; id?: string; message: string }
	| { type: 'abort'; id?: string }
	| { type: 'events'; after?: string; limit?: number }
	| { type: 'shutdown'; id?: string }
	/** v2 request/response for one allowlisted method. `params` is the argument
	 * list; the daemon NEVER accepts a client-sent `ProcessLocalContext` (§4.3.2)
	 * — it builds its own, bound to the connection. */
	| { type: 'call'; id: string; method: string; params?: unknown[] }
	/** Open one of the stream methods. `credit` seeds the frame budget (arch:
	 * initial 256); the daemon sends no frame without credit. */
	| {
			type: 'stream.open';
			id: string;
			method: StreamCliMethod;
			params?: unknown[];
			credit?: number;
	  }
	/** Replenish the frame budget of one stream. */
	| { type: 'stream.credit'; streamId: string; frames: number }
	/** `detach` — the window stops listening, the turn continues (I-DETACH);
	 * `abort` — explicit `abortSession` for the turn of this stream (W0 F3). */
	| { type: 'stream.cancel'; streamId: string; mode: 'detach' | 'abort' }
	/** The window works with a session: the routing key of session-runtime
	 * events and permission snapshot filtering (§4.3.4, §4.5). */
	| {
			type: 'session.attach';
			id: string;
			sessionId: string;
			role: 'owner' | 'observer';
			/** In-memory per-session tool environment snapshot (§4.4); never
			 * persisted, never logged. Applied by the daemon composition (W4). */
			toolEnv?: { cwd?: string; env?: Record<string, string> };
	  }
	| { type: 'session.detach'; id: string; sessionId: string }
	/** Subscribe to GlobalEvents with cursor replay (arch §4.3.2). Attachments
	 * held at subscribe time also filter the replay (§4.6.3). */
	| {
			type: 'subscribe';
			id: string;
			after?: string;
			scope?: 'catalog+attached' | 'all';
	  }
	/** Heartbeat (arch: every 10 s, timeout 30 s); the daemon answers `pong`. */
	| { type: 'ping'; id?: string }
	| { type: 'daemon.status'; id: string }
	| { type: 'daemon.restart'; id: string; when: 'idle' | 'now' }
	| { type: 'daemon.authSync'; id: string };

/**
 * One live turn stream in the `daemon.status` snapshot (`activeRuns`): the
 * drain guard of `mcode daemon stop|restart` lists these and refuses the
 * shutdown without `--force` while any exist.
 */
export interface DaemonActiveRun {
	/** The session the turn belongs to (`bridge.streamSessionId`). */
	sessionId: string;
	/** The stream method carrying the turn (`sendMessage`/`resumeSession`). */
	method: string;
	/** How long the stream has been live (ms, from its open). */
	elapsedMs: number;
}

/** Data payload of a successful `hello` response. */
export interface HelloData {
	/** The daemon's protocol major (echoed for confirmation). */
	version: number;
	/** Newest event cursor assigned so far, `null` when the stream is empty. */
	head: string | null;
	/** Daemon's minor version (v2 welcome only). */
	minor?: number;
	/** Features the daemon supports beyond this shared shape (v2 welcome only). */
	features?: string[];
}

/** Daemon → client frames (JSONL). */
export type ServerFrame =
	| { type: 'response'; id?: string; command: ClientCommandName; success: true; data?: unknown }
	/**
	 * Failure responses echo any declared command, including unknown ones.
	 * `errorCode` is the stable machine-readable reason (see
	 * {@link MCODED_ERROR_CODES}); `error` stays the human-readable message.
	 * v2 failures additionally carry `errorName` (the thrown error class) and
	 * `errorData` (structured detail — e.g. the `{status, body}` mirror of a
	 * refused stream open), which the client rehydrates into error classes.
	 */
	| {
			type: 'response';
			id?: string;
			command: string;
			success: false;
			error: string;
			errorCode?: McodedErrorCode;
			errorName?: string;
			errorData?: unknown;
	  }
	/** One replayable runtime event; `cursor` is its position in the stream. */
	| { type: 'event'; cursor: string; event: unknown }
	/** The requested `after` cursor is not retained (evicted or never existed). */
	| { type: 'replay_gap'; after: string; head: string | null }
	/** One frame of a v2 stream: per-stream monotonic `seq`. */
	| { type: 'stream.frame'; streamId: string; seq: number; frame: unknown }
	/** Terminal frame of a v2 stream (arch §4.3.3). */
	| {
			type: 'stream.end';
			streamId: string;
			reason: 'done' | 'detached' | 'aborted' | 'error';
			/** True when the client can recover with `stream.open resumeSession`. */
			resumable?: boolean;
			error?: string;
	  }
	/** Non-intrusive status for the window's status line (arch §4.3.3). */
	| { type: 'notice'; kind: string; sessionId?: string; [extra: string]: unknown }
	/** Heartbeat answer. */
	| { type: 'pong'; id?: string }
	/** Sent immediately before the daemon closes the connection. */
	| { type: 'bye'; reason?: string };

/**
 * Stable machine-readable failure reasons of `response` frames with
 * `success: false` (the plan's request-id/error mapping: clients branch on
 * the code, the message is diagnostics only).
 */
export type McodedErrorCode =
	| 'PROTOCOL_ERROR'
	| 'HANDSHAKE_REQUIRED'
	| 'UNSUPPORTED_VERSION'
	| 'ALREADY_HANDSHAKEN'
	| 'DAEMON_SHUTTING_DOWN'
	| 'RUNTIME_REJECTED'
	/** v2 handshake: `hello.token` missing or wrong (arch §4.7). */
	| 'UNAUTHORIZED'
	/** v2 handshake: `hello.dataDir` is not the dataDir the daemon serves (§2.2). */
	| 'DATA_DIR_MISMATCH'
	/** v2 handshake: `hello.env` region/buildEnv disagree with the daemon's (§4.3.2, R6). */
	| 'ENV_MISMATCH'
	/** v2 handshake: `hello.promptMode` disagrees with the daemon's (§4.4). */
	| 'PROMPT_MODE_MISMATCH'
	/** v2 routing: the frame needs a `session.attach` this connection lacks (§4.5). */
	| 'NOT_ATTACHED'
	/** v2 approvals: the request was already resolved — first answer wins (§4.5 п.4). */
	| 'ALREADY_RESOLVED'
	/** v2 allowlist: `call`/`stream.open` named a method outside its lane (§4.3.6). */
	| 'METHOD_NOT_ALLOWED'
	/**
	 * W5 feature skew (§4.6.5): the frame needs a feature the client did NOT
	 * advertise in its `hello.features` — the daemon refuses instead of
	 * serving a capability the client declared it cannot handle.
	 */
	| 'FEATURE_UNSUPPORTED';

/**
 * Inbound frame limit (arch §4.3.5): attachments travel as paths, so an 8 MiB
 * line is never legitimate — exceeding it answers `PROTOCOL_ERROR` and closes
 * the connection instead of letting one client grow the daemon's memory.
 */
export const MAX_INBOUND_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Initial credit a client grants when opening a stream (arch §4.3.2): the
 * server sends at most this many `stream.frame`s before the first
 * `stream.credit` replenishment.
 */
export const DEFAULT_STREAM_CREDIT = 256;

/**
 * The CliService methods served as v2 streams (`stream.open`), not `call`:
 * `sendMessage`/`resumeSession` are `ProcessLocalStreamResult` turn streams,
 * `watchSessionUsageCommits` a commit-notification generator (arch §4.3.2).
 */
export const STREAM_CLI_METHODS = [
	'sendMessage',
	'resumeSession',
	'watchSessionUsageCommits',
] as const;

/** Stream-method name union ({@link STREAM_CLI_METHODS}). */
export type StreamCliMethod = (typeof STREAM_CLI_METHODS)[number];

/**
 * Daemon-side per-stream sink budget (arch §4.3.5): frames a CONGESTED
 * connection cannot take are held here; the overflow detaches the stream
 * (`stream.end{reason:'detached', resumable:true}`) — the turn continues, the
 * daemon's memory stays bounded, the window resumes via `resumeSession`.
 */
export const STREAM_SINK_MAX_BYTES = 4 * 1024 * 1024;

/** Cursor type alias: a decimal string of a monotonically increasing integer. */
export type Cursor = string;

/** Thrown when a received line is not a well-formed client frame. */
export class ProtocolError extends Error {
	readonly code = 'PROTOCOL_ERROR';
	/** Client-declared command type when one was recognizable; else `null`. */
	readonly commandHint: string | null;

	constructor(message: string, commandHint: string | null = null) {
		super(message);
		this.name = 'ProtocolError';
		this.commandHint = commandHint;
	}
}

/**
 * Serialize one frame to a single JSONL line. The line carries no trailing
 * newline: the `LineTransport` owns the framing (`transport.ts`) — appending
 * it here too would put a second newline on the wire through the socket
 * transport and an empty line after every frame.
 */
export function serializeFrame(frame: ServerFrame | ClientFrame): string {
	return JSON.stringify(frame);
}

/**
 * Parse one JSONL line into a client frame.
 *
 * @throws {ProtocolError} on invalid JSON, a non-object line, an unknown
 * command type, or a payload that does not satisfy the declared shape. The
 * error carries a `commandHint` when the line declared a recognizable type,
 * so error responses can echo the offending command.
 */
export function parseFrame(line: string): ClientFrame {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new ProtocolError('frame is not valid JSON');
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ProtocolError('frame must be a JSON object');
	}
	const record = value as Record<string, unknown>;
	const rawType = record['type'];
	const hint = typeof rawType === 'string' ? rawType : null;
	switch (rawType) {
		case 'hello': {
			if (typeof record['version'] !== 'number' || !Number.isInteger(record['version'])) {
				throw new ProtocolError('hello requires an integer "version"', 'hello');
			}
			const minor = record['minor'];
			if (minor !== undefined && (typeof minor !== 'number' || !Number.isInteger(minor))) {
				throw new ProtocolError('hello "minor" must be an integer', 'hello');
			}
			const token = record['token'];
			if (token !== undefined && typeof token !== 'string') {
				throw new ProtocolError('hello "token" must be a string', 'hello');
			}
			const dataDir = record['dataDir'];
			if (dataDir !== undefined && (typeof dataDir !== 'string' || dataDir.length === 0)) {
				throw new ProtocolError('hello "dataDir" must be a non-empty string', 'hello');
			}
			const env = parseHelloEnv(record['env']);
			const features = record['features'];
			if (
				features !== undefined &&
				(!Array.isArray(features) || features.some((entry) => typeof entry !== 'string'))
			) {
				throw new ProtocolError('hello "features" must be an array of strings', 'hello');
			}
			const clientInstanceId = record['clientInstanceId'];
			if (
				clientInstanceId !== undefined &&
				(typeof clientInstanceId !== 'string' || clientInstanceId.length === 0)
			) {
				throw new ProtocolError('hello "clientInstanceId" must be a non-empty string', 'hello');
			}
			const client = parseHelloClient(record['client']);
			const promptMode = record['promptMode'];
			if (
				promptMode !== undefined &&
				promptMode !== 'tui' &&
				promptMode !== 'coding' &&
				promptMode !== 'work'
			) {
				throw new ProtocolError('hello "promptMode" must be "tui" | "coding" | "work"', 'hello');
			}
			return {
				type: 'hello',
				version: record['version'],
				...(minor !== undefined ? { minor } : {}),
				...(token !== undefined ? { token } : {}),
				...(dataDir !== undefined ? { dataDir } : {}),
				...(env ? { env } : {}),
				...(features !== undefined ? { features: features as string[] } : {}),
				...(clientInstanceId !== undefined ? { clientInstanceId } : {}),
				...(client ? { client } : {}),
				...(promptMode !== undefined ? { promptMode } : {}),
			};
		}
		case 'prompt':
		case 'steer':
		case 'follow_up':
			if (typeof record['message'] !== 'string') {
				throw new ProtocolError(`${rawType} requires a string "message"`, rawType);
			}
			return {
				type: rawType,
				message: record['message'],
				...(isRequestId(record['id']) ? { id: record['id'] } : {}),
			};
		case 'abort':
			return { type: 'abort', ...(isRequestId(record['id']) ? { id: record['id'] } : {}) };
		case 'events': {
			const after = record['after'];
			if (after !== undefined && (typeof after !== 'string' || after.length === 0)) {
				throw new ProtocolError('events "after" must be a non-empty string cursor', 'events');
			}
			const limit = record['limit'];
			if (
				limit !== undefined &&
				(typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)
			) {
				throw new ProtocolError('events "limit" must be a positive integer', 'events');
			}
			return {
				type: 'events',
				...(after !== undefined ? { after } : {}),
				...(limit !== undefined ? { limit } : {}),
			};
		}
		case 'shutdown':
			return { type: 'shutdown', ...(isRequestId(record['id']) ? { id: record['id'] } : {}) };
		case 'call': {
			if (!isRequestId(record['id'])) {
				throw new ProtocolError('call requires a non-empty string "id"', 'call');
			}
			if (typeof record['method'] !== 'string' || record['method'].length === 0) {
				throw new ProtocolError('call requires a non-empty string "method"', 'call');
			}
			const params = record['params'];
			if (
				params !== undefined &&
				(!Array.isArray(params) || params.some((entry) => entry === undefined))
			) {
				throw new ProtocolError('call "params" must be an array without undefined entries', 'call');
			}
			return {
				type: 'call',
				id: record['id'],
				method: record['method'],
				...(params !== undefined ? { params: params as unknown[] } : {}),
			};
		}
		case 'stream.open': {
			if (!isRequestId(record['id'])) {
				throw new ProtocolError('stream.open requires a non-empty string "id"', 'stream.open');
			}
			const method = record['method'];
			if (method !== 'sendMessage' && method !== 'resumeSession' && method !== 'watchSessionUsageCommits') {
				throw new ProtocolError('stream.open "method" must be sendMessage | resumeSession | watchSessionUsageCommits', 'stream.open');
			}
			const params = record['params'];
			if (
				params !== undefined &&
				(!Array.isArray(params) || params.some((entry) => entry === undefined))
			) {
				throw new ProtocolError('stream.open "params" must be an array without undefined entries', 'stream.open');
			}
			const credit = record['credit'];
			if (
				credit !== undefined &&
				(typeof credit !== 'number' || !Number.isInteger(credit) || credit < 0)
			) {
				throw new ProtocolError('stream.open "credit" must be a non-negative integer', 'stream.open');
			}
			return {
				type: 'stream.open',
				id: record['id'],
				method,
				...(params !== undefined ? { params: params as unknown[] } : {}),
				...(credit !== undefined ? { credit } : {}),
			};
		}
		case 'stream.credit': {
			const streamId = record['streamId'];
			if (typeof streamId !== 'string' || streamId.length === 0) {
				throw new ProtocolError('stream.credit requires a non-empty string "streamId"', 'stream.credit');
			}
			const frames = record['frames'];
			if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1) {
				throw new ProtocolError('stream.credit "frames" must be a positive integer', 'stream.credit');
			}
			return { type: 'stream.credit', streamId, frames };
		}
		case 'stream.cancel': {
			const streamId = record['streamId'];
			if (typeof streamId !== 'string' || streamId.length === 0) {
				throw new ProtocolError('stream.cancel requires a non-empty string "streamId"', 'stream.cancel');
			}
			const mode = record['mode'];
			if (mode !== 'detach' && mode !== 'abort') {
				throw new ProtocolError('stream.cancel "mode" must be "detach" or "abort"', 'stream.cancel');
			}
			return { type: 'stream.cancel', streamId, mode };
		}
		case 'session.attach': {
			if (!isRequestId(record['id'])) {
				throw new ProtocolError('session.attach requires a non-empty string "id"', 'session.attach');
			}
			const sessionId = record['sessionId'];
			if (typeof sessionId !== 'string' || sessionId.length === 0) {
				throw new ProtocolError('session.attach requires a non-empty string "sessionId"', 'session.attach');
			}
			const role = record['role'];
			if (role !== 'owner' && role !== 'observer') {
				throw new ProtocolError('session.attach "role" must be "owner" or "observer"', 'session.attach');
			}
			const toolEnv = parseAttachToolEnv(record['toolEnv']);
			return {
				type: 'session.attach',
				id: record['id'],
				sessionId,
				role,
				...(toolEnv ? { toolEnv } : {}),
			};
		}
		case 'session.detach': {
			if (!isRequestId(record['id'])) {
				throw new ProtocolError('session.detach requires a non-empty string "id"', 'session.detach');
			}
			const sessionId = record['sessionId'];
			if (typeof sessionId !== 'string' || sessionId.length === 0) {
				throw new ProtocolError('session.detach requires a non-empty string "sessionId"', 'session.detach');
			}
			return { type: 'session.detach', id: record['id'], sessionId };
		}
		case 'subscribe': {
			if (!isRequestId(record['id'])) {
				throw new ProtocolError('subscribe requires a non-empty string "id"', 'subscribe');
			}
			const after = record['after'];
			if (after !== undefined && (typeof after !== 'string' || after.length === 0)) {
				throw new ProtocolError('subscribe "after" must be a non-empty string cursor', 'subscribe');
			}
			const scope = record['scope'];
			if (scope !== undefined && scope !== 'catalog+attached' && scope !== 'all') {
				throw new ProtocolError('subscribe "scope" must be "catalog+attached" or "all"', 'subscribe');
			}
			return {
				type: 'subscribe',
				id: record['id'],
				...(after !== undefined ? { after } : {}),
				...(scope !== undefined ? { scope } : {}),
			};
		}
		case 'ping':
			return { type: 'ping', ...(isRequestId(record['id']) ? { id: record['id'] } : {}) };
		case 'daemon.status': {
			if (!isRequestId(record['id'])) {
				throw new ProtocolError('daemon.status requires a non-empty string "id"', 'daemon.status');
			}
			return { type: 'daemon.status', id: record['id'] };
		}
		case 'daemon.restart': {
			if (!isRequestId(record['id'])) {
				throw new ProtocolError('daemon.restart requires a non-empty string "id"', 'daemon.restart');
			}
			const when = record['when'];
			if (when !== 'idle' && when !== 'now') {
				throw new ProtocolError('daemon.restart "when" must be "idle" or "now"', 'daemon.restart');
			}
			return { type: 'daemon.restart', id: record['id'], when };
		}
		case 'daemon.authSync': {
			if (!isRequestId(record['id'])) {
				throw new ProtocolError('daemon.authSync requires a non-empty string "id"', 'daemon.authSync');
			}
			return { type: 'daemon.authSync', id: record['id'] };
		}
		default:
			throw new ProtocolError(
				`unknown frame type ${JSON.stringify(rawType ?? null)}`,
				hint,
			);
	}
}

/** Optional request-id: pi-rpc lets clients omit `id`; the response echoes it. */
function isRequestId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** Parse the optional `hello.env` identity; `undefined` when the field is absent. */
function parseHelloEnv(value: unknown): HelloEnvIdentity | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ProtocolError('hello "env" must be an object', 'hello');
	}
	const record = value as Record<string, unknown>;
	const readString = (key: string): string | undefined => {
		const raw = record[key];
		if (raw === undefined) return undefined;
		if (typeof raw !== 'string') {
			throw new ProtocolError(`hello "env.${key}" must be a string`, 'hello');
		}
		return raw;
	};
	const profile = readString('profile');
	const region = readString('region');
	const buildEnv = readString('buildEnv');
	if (profile === undefined && region === undefined && buildEnv === undefined) return {};
	return {
		...(profile !== undefined ? { profile } : {}),
		...(region !== undefined ? { region } : {}),
		...(buildEnv !== undefined ? { buildEnv } : {}),
	};
}

/** Parse the optional `hello.client` identity; `undefined` when absent. */
function parseHelloClient(value: unknown): HelloClientIdentity | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ProtocolError('hello "client" must be an object', 'hello');
	}
	const record = value as Record<string, unknown>;
	const readString = (key: string): string | undefined => {
		const raw = record[key];
		if (raw === undefined) return undefined;
		if (typeof raw !== 'string') {
			throw new ProtocolError(`hello "client.${key}" must be a string`, 'hello');
		}
		return raw;
	};
	const kind = record['kind'];
	if (kind !== undefined && kind !== 'tui' && kind !== 'exec' && kind !== 'acp') {
		throw new ProtocolError('hello "client.kind" must be "tui" | "exec" | "acp"', 'hello');
	}
	const pid = record['pid'];
	if (pid !== undefined && (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0)) {
		throw new ProtocolError('hello "client.pid" must be a non-negative integer', 'hello');
	}
	const buildId = readString('buildId');
	const cwd = readString('cwd');
	if (kind === undefined && pid === undefined && buildId === undefined && cwd === undefined) {
		return {};
	}
	return {
		...(kind !== undefined ? { kind } : {}),
		...(pid !== undefined ? { pid } : {}),
		...(buildId !== undefined ? { buildId } : {}),
		...(cwd !== undefined ? { cwd } : {}),
	};
}

/** Parse the optional `session.attach.toolEnv` snapshot; `undefined` when absent. */
function parseAttachToolEnv(
	value: unknown,
): { cwd?: string; env?: Record<string, string> } | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ProtocolError('session.attach "toolEnv" must be an object', 'session.attach');
	}
	const record = value as Record<string, unknown>;
	const cwd = record['cwd'];
	if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0)) {
		throw new ProtocolError('session.attach "toolEnv.cwd" must be a non-empty string', 'session.attach');
	}
	let env: Record<string, string> | undefined;
	const rawEnv = record['env'];
	if (rawEnv !== undefined) {
		if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
			throw new ProtocolError('session.attach "toolEnv.env" must be an object of strings', 'session.attach');
		}
		env = {};
		for (const [key, entry] of Object.entries(rawEnv)) {
			if (typeof entry !== 'string') {
				throw new ProtocolError('session.attach "toolEnv.env" must be an object of strings', 'session.attach');
			}
			env[key] = entry;
		}
	}
	if (cwd === undefined && env === undefined) return undefined;
	return {
		...(cwd !== undefined ? { cwd } : {}),
		...(env ? { env } : {}),
	};
}

/**
 * Compare two cursors emitted by this daemon.
 *
 * Cursors are decimal integers, so numeric comparison is exact well past any
 * realistic sequence volume; the helper exists so call sites never compare
 * cursor strings lexicographically by accident.
 */
export function compareCursors(a: Cursor, b: Cursor): number {
	return Number(a) - Number(b);
}
