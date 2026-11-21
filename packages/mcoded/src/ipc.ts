/**
 * The client-side IPC helpers of the daemon CLI surface (`mcode daemon
 * status|stop|restart`): a bounded `hello` probe and the graceful `shutdown`
 * request, both over the real unix socket.
 *
 * This is deliberately NOT the W3 `McodedClient` (connect/spawn/reconnect/
 * streams): just enough protocol to observe and stop a running daemon. The
 * shutdown path still handshakes first — the wire accepts nothing before
 * `hello` — and carries the control root's current token so a stopped daemon
 * is an authorized act.
 *
 * @module
 */

import net from 'node:net';

import type {
	DaemonActiveRun,
	HelloData,
	HelloEnvIdentity,
	McodedErrorCode,
	ServerFrame,
} from './protocol.js';
import { MCODED_PROTOCOL_VERSION, serializeFrame } from './protocol.js';
import { SocketLineTransport } from './socket-transport.js';

/** Default bounded wait for one IPC roundtrip. */
export const DAEMON_IPC_TIMEOUT_MS = 5_000;

/** The v2 handshake payload the client side of the CLI sends. */
export interface DaemonClientHandshake {
	/** Token read from `mcoded.token` in the control root. */
	readonly token?: string;
	/** realpath of the data directory the client expects (DATA_DIR_MISMATCH check). */
	readonly dataDir?: string;
	/** Client env identity (ENV_MISMATCH check, arch R6). */
	readonly env?: HelloEnvIdentity;
	/** Bounded wait for connect + response. Default {@link DAEMON_IPC_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
}

/** Outcome of one daemon IPC exchange. */
export type DaemonIpcOutcome<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly error: string;
			readonly errorCode?: McodedErrorCode;
			/** errno of the transport failure (`ENOENT`, `ECONNREFUSED`, …), if any. */
			readonly errno?: string;
	  };

/**
 * Handshake with the daemon and return its welcome.
 *
 * A successful probe proves the socket is live AND this caller satisfies the
 * daemon's v2 handshake (token/dataDir/env); `UNAUTHORIZED`,
 * `DATA_DIR_MISMATCH` and `ENV_MISMATCH` surface as their stable codes.
 */
export async function helloDaemon(
	socketPath: string,
	handshake: DaemonClientHandshake = {},
): Promise<DaemonIpcOutcome<HelloData>> {
	try {
		return await withConnection(socketPath, handshake.timeoutMs, async (transport) => {
			writeLine(
				transport,
				serializeFrame({
					type: 'hello',
					version: MCODED_PROTOCOL_VERSION,
					...(handshake.token !== undefined ? { token: handshake.token } : {}),
					...(handshake.dataDir !== undefined ? { dataDir: handshake.dataDir } : {}),
					...(handshake.env !== undefined ? { env: handshake.env } : {}),
				}),
			);
			const frame = await readFrame(transport, handshake.timeoutMs);
			if (frame.type !== 'response' || frame.command !== 'hello') {
				return {
					ok: false,
					error: `unexpected frame in reply to hello: ${JSON.stringify(frame).slice(0, 120)}`,
				};
			}
			if (!frame.success) {
				return {
					ok: false,
					error: frame.error,
					...(frame.errorCode ? { errorCode: frame.errorCode } : {}),
				};
			}
			return { ok: true, data: frame.data as HelloData };
		});
	} catch (error) {
		return transportFailure(error);
	}
}

/**
 * Ask the daemon for a graceful shutdown: handshake, `shutdown` frame, wait
 * for the ack and the `bye`/close. The daemon drains (checkpoint + event log
 * flush) before the socket goes away.
 */
export async function requestDaemonShutdown(
	socketPath: string,
	handshake: DaemonClientHandshake = {},
): Promise<DaemonIpcOutcome<{ accepted: boolean }>> {
	try {
		return await withConnection(socketPath, handshake.timeoutMs, async (transport) => {
			writeLine(
				transport,
				serializeFrame({
					type: 'hello',
					version: MCODED_PROTOCOL_VERSION,
					...(handshake.token !== undefined ? { token: handshake.token } : {}),
					...(handshake.dataDir !== undefined ? { dataDir: handshake.dataDir } : {}),
					...(handshake.env !== undefined ? { env: handshake.env } : {}),
				}),
			);
			const welcome = await readFrame(transport, handshake.timeoutMs);
			if (welcome.type !== 'response' || welcome.command !== 'hello') {
				return { ok: false, error: 'unexpected handshake reply' };
			}
			if (!welcome.success) {
				return {
					ok: false,
					error: welcome.error,
					...(welcome.errorCode ? { errorCode: welcome.errorCode } : {}),
				};
			}
			writeLine(transport, serializeFrame({ type: 'shutdown' }));
			// The daemon acks, drains, then says bye and closes; either frame
			// (or the transport end) finishes a successful stop.
			for (;;) {
				const frame = await readFrame(transport, handshake.timeoutMs);
				if (frame.type === 'response' && frame.command === 'shutdown' && !frame.success) {
					return { ok: false, error: frame.error, ...(frame.errorCode ? { errorCode: frame.errorCode } : {}) };
				}
				if (frame.type === 'bye' || frame.type === 'response') break;
			}
			return { ok: true, data: { accepted: true } };
		});
	} catch (error) {
		return transportFailure(error);
	}
}

/**
 * The drain-guard probe result (`daemon.status`): the per-run list when the
 * daemon reported it, plus the fallback inputs for a daemon whose response
 * carries no `activeRuns` array (an older protocol). The guard is fail-closed:
 * it may let a shutdown through only when idleness is PROVEN, so absence of
 * the list is reported instead of read as "empty".
 */
export interface DaemonActiveRunsSnapshot {
	/** The live turn streams (`activeRuns`); empty unless {@link activeRunsReported}. */
	readonly runs: readonly DaemonActiveRun[];
	/** Whether the response carried the `activeRuns` array at all. */
	readonly activeRunsReported: boolean;
	/** The response's `activeTurns` counter (live streams), when the daemon sent one. */
	readonly activeTurns?: number;
}

/**
 * Ask the daemon for its live turn streams (`daemon.status` → `activeRuns`):
 * sessionId + elapsed per stream, running or detached-draining. The drain
 * guard of `mcode daemon stop|restart` refuses the shutdown while any exist,
 * unless `--force` is given.
 */
export async function listDaemonActiveRuns(
	socketPath: string,
	handshake: DaemonClientHandshake = {},
): Promise<DaemonIpcOutcome<DaemonActiveRunsSnapshot>> {
	try {
		return await withConnection(socketPath, handshake.timeoutMs, async (transport) => {
			writeLine(
				transport,
				serializeFrame({
					type: 'hello',
					version: MCODED_PROTOCOL_VERSION,
					...(handshake.token !== undefined ? { token: handshake.token } : {}),
					...(handshake.dataDir !== undefined ? { dataDir: handshake.dataDir } : {}),
					...(handshake.env !== undefined ? { env: handshake.env } : {}),
				}),
			);
			const welcome = await readFrame(transport, handshake.timeoutMs);
			if (welcome.type !== 'response' || welcome.command !== 'hello') {
				return { ok: false, error: 'unexpected handshake reply' };
			}
			if (!welcome.success) {
				return {
					ok: false,
					error: welcome.error,
					...(welcome.errorCode ? { errorCode: welcome.errorCode } : {}),
				};
			}
			writeLine(transport, serializeFrame({ type: 'daemon.status', id: 'active-runs' }));
			const frame = await readFrame(transport, handshake.timeoutMs);
			if (frame.type !== 'response' || frame.command !== 'daemon.status') {
				return {
					ok: false,
					error: `unexpected frame in reply to daemon.status: ${JSON.stringify(frame).slice(0, 120)}`,
				};
			}
			if (!frame.success) {
				return {
					ok: false,
					error: frame.error,
					...(frame.errorCode ? { errorCode: frame.errorCode } : {}),
				};
			}
			// The `activeRuns` field is newer than `daemon.status` itself: a
			// response without it is NOT "no runs" — report the absence (and the
			// `activeTurns` fallback counter) so the guard can stay fail-closed.
			const status = (frame.data ?? {}) as {
				activeRuns?: readonly DaemonActiveRun[];
				activeTurns?: number;
			};
			return {
				ok: true,
				data: {
					runs: Array.isArray(status.activeRuns) ? status.activeRuns : [],
					activeRunsReported: Array.isArray(status.activeRuns),
					...(typeof status.activeTurns === 'number'
						? { activeTurns: status.activeTurns }
						: {}),
				},
			};
		});
	} catch (error) {
		return transportFailure(error);
	}
}

/** Map a thrown transport failure onto the outcome shape. */
function transportFailure(error: unknown): { ok: false; error: string; errno?: string } {
	const errno = (error as NodeJS.ErrnoException).code;
	return {
		ok: false,
		error: error instanceof Error ? error.message : String(error),
		...(typeof errno === 'string' ? { errno } : {}),
	};
}

async function withConnection<T>(
	socketPath: string,
	timeoutMs: number | undefined,
	use: (transport: SocketLineTransport) => Promise<T>,
): Promise<T> {
	const boundedMs = timeoutMs ?? DAEMON_IPC_TIMEOUT_MS;
	const transport = await connectTransport(socketPath, boundedMs);
	try {
		return await use(transport);
	} finally {
		transport.end();
	}
}

function connectTransport(socketPath: string, timeoutMs: number): Promise<SocketLineTransport> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`connect ${socketPath} timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		timer.unref?.();
		socket.once('connect', () => {
			clearTimeout(timer);
			resolve(new SocketLineTransport(socket));
		});
		socket.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function writeLine(transport: SocketLineTransport, line: string): void {
	transport.write(line);
}

/** Next frame off the transport, bounded by `timeoutMs` (the socket is destroyed on timeout). */
async function readFrame(
	transport: SocketLineTransport,
	timeoutMs: number | undefined,
): Promise<ServerFrame> {
	const lines = transport.lines();
	const boundedMs = timeoutMs ?? DAEMON_IPC_TIMEOUT_MS;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`daemon reply timed out after ${boundedMs} ms`));
		}, boundedMs);
		timer.unref?.();
	});
	try {
		const result = await Promise.race([lines.next(), timeout]);
		if (result.done) throw new Error('daemon closed the connection before replying');
		return JSON.parse(result.value) as ServerFrame;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
