/**
 * One client connection of the mcoded wire: the per-connection protocol state
 * machine that runs the pi-rpc-semantics JSONL frames from `protocol.ts` over
 * any {@link LineTransport}.
 *
 * The connection owns exactly two protocol rules; everything else is delegated
 * to the hub:
 * 1. the handshake — the FIRST frame must be `hello` carrying
 *    {@link MCODED_PROTOCOL_VERSION} (or major 1, the v1 shim); anything else
 *    answers with a failed `hello` response and closes. The v2 payload checks
 *    themselves (token, dataDir, env) belong to the hub, which owns the
 *    daemon-side identity the hello fields are compared against;
 * 2. framing discipline — a line that does not parse answers with a failed
 *    response naming the offending command, never tears the stream down
 *    silently.
 *
 * @module
 */

import { createLogger, type Logger } from '@mavis/logging';

import {
	type ClientFrame,
	type ServerFrame,
	MCODED_PROTOCOL_VERSION,
	MAX_INBOUND_FRAME_BYTES,
	ProtocolError,
	parseFrame,
	serializeFrame,
} from './protocol.js';
import type { BackpressureTransport } from './transport.js';

/**
 * The v1 shim (arch §4.3.1): a hello at major 1 keeps the exact W10/W11
 * semantics — no token/dataDir/env checks, the plain v1 welcome — so clients
 * from before the v2 handshake keep working against a newer daemon.
 */
const MCODED_PROTOCOL_V1 = 1;
import type { LineTransport } from './transport.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/** Process-local counter backing per-connection log correlation ids. */
let nextConnectionId = 0;

/** Callbacks the hub implements to serve a handshaken connection. */
export interface RpcConnectionHost {
	/** Handle a post-handshake command frame (responses are sent by the hub). */
	onCommand(frame: ClientFrame, connection: RpcConnection): Promise<void>;
	/** The peer closed the transport or the connection was closed locally. */
	onClose(connection: RpcConnection): void;
}

/** Connection lifecycle stage. */
export type RpcConnectionState = 'awaiting-hello' | 'open' | 'closed';

/** Per-client protocol machine over one duplex line transport. */
export class RpcConnection {
	private state: RpcConnectionState = 'awaiting-hello';
	private readonly reader: AsyncIterableIterator<string>;
	private readLoop: Promise<void> | undefined;
	/**
	 * Process-local correlation id for this connection's log events; the hub
	 * also cites it when an event delivery to this client fails.
	 */
	readonly connectionId = ++nextConnectionId;
	private readonly log: Logger;

	constructor(
		private readonly transport: LineTransport,
		private readonly host: RpcConnectionHost,
	) {
		this.reader = transport.lines();
		this.log = log.child({ connectionId: this.connectionId });
	}

	/** Current protocol stage of this client. */
	get connectionState(): RpcConnectionState {
		return this.state;
	}

	/** True once the handshake succeeded and the hub is serving the client. */
	get isOpen(): boolean {
		return this.state === 'open';
	}

	/**
	 * Write-backpressure probe of the underlying transport (arch §4.3.5), or
	 * `null` when the transport cannot report it. The hub's stream mux gates
	 * on this BEFORE buffering: a congested client's frames wait in a bounded
	 * sink, never in the socket's unbounded internal buffer.
	 */
	get backpressure(): Pick<BackpressureTransport, 'congested' | 'waitDrain'> | null {
		const candidate = this.transport as Partial<BackpressureTransport>;
		if (typeof candidate.waitDrain === 'function') {
			return {
				congested: candidate.congested === true,
				waitDrain: () => candidate.waitDrain!(),
			};
		}
		return null;
	}

	/** Begin reading frames. Idempotent; called by the hub on attach. */
	start(): void {
		if (this.readLoop) return;
		this.readLoop = this.drain();
	}

	/** Queue one server frame to this client. */
	send(frame: ServerFrame): void {
		if (this.state === 'closed') return;
		this.transport.write(serializeFrame(frame));
	}

	/**
	 * Close the connection politely: a `bye` frame, then transport end.
	 * Idempotent.
	 */
	close(reason?: string): void {
		if (this.state === 'closed') return;
		const wasOpen = this.state !== 'awaiting-hello';
		this.state = 'closed';
		this.log.info('disconnect', reason ? { reason } : undefined);
		if (wasOpen) {
			this.transport.write(serializeFrame({ type: 'bye', ...(reason ? { reason } : {}) }));
		}
		this.transport.end();
		this.host.onClose(this);
	}

	/** Read frames until the transport dies; protocol errors answer inline. */
	private async drain(): Promise<void> {
		try {
			for (;;) {
				const next = await this.reader.next();
				if (next.done) break;
				this.handleLine(next.value);
				if (this.state === 'closed') break;
			}
		} finally {
			if (this.state !== 'closed') {
				this.state = 'closed';
				this.log.info('disconnect', { reason: 'eof' });
				this.host.onClose(this);
			}
		}
	}

	private handleLine(line: string): void {
		// Inbound frame limit (arch §4.3.5): the transport guards its own buffer
		// (SocketLineTransport), and this wire-level check covers transports
		// without the guard. Attachments travel as paths — no legitimate frame
		// approaches 8 MiB; anything bigger answers PROTOCOL_ERROR and closes.
		if (line.length > MAX_INBOUND_FRAME_BYTES) {
			this.log.warn('frame-limit', { bytes: line.length });
			this.send({
				type: 'response',
				command: 'invalid',
				success: false,
				error: `frame exceeds the ${MAX_INBOUND_FRAME_BYTES} byte limit`,
				errorCode: 'PROTOCOL_ERROR',
			});
			this.close('frame-limit');
			return;
		}
		let frame: ClientFrame;
		try {
			frame = parseFrame(line);
		} catch (error) {
			// Error responses echo the client-declared command when the line
			// declared one (pi-rpc lets error responses name any command).
			const hint = error instanceof ProtocolError ? error.commandHint : null;
			const message = error instanceof Error ? error.message : 'unparsable frame';
			this.log.error('protocol-error', { err: error, command: hint ?? undefined });
			this.send({
				type: 'response',
				command: hint ?? 'invalid',
				success: false,
				error: `protocol error: ${message}`,
				errorCode: 'PROTOCOL_ERROR',
			});
			return;
		}

		// Heartbeat never reaches the hub (arch §4.3.3: `pong` is its own
		// frame): it must answer even while the daemon is draining and the hub
		// refuses commands.
		if (frame.type === 'ping') {
			this.send({ type: 'pong', ...(frame.id ? { id: frame.id } : {}) });
			return;
		}

		if (this.state === 'awaiting-hello') {
			this.handleHello(frame, line.length);
			return;
		}
		if (frame.type === 'hello') {
			this.log.warn('duplicate-hello');
			this.send({
				type: 'response',
				command: 'hello',
				success: false,
				error: 'already handshaken',
				errorCode: 'ALREADY_HANDSHAKEN',
			});
			return;
		}
		this.dispatch(frame, line.length);
	}

	private handleHello(frame: ClientFrame, lineBytes: number): void {
		if (frame.type !== 'hello') {
			// Tolerant like pi-rpc: the connection stays open so the client can
			// still send the handshake it forgot.
			this.log.warn('handshake-required', { method: frame.type });
			this.send({
				type: 'response',
				command: frame.type,
				success: false,
				error: 'handshake required: the first frame must be hello',
				errorCode: 'HANDSHAKE_REQUIRED',
			});
			return;
		}
		if (frame.version !== MCODED_PROTOCOL_VERSION && frame.version !== MCODED_PROTOCOL_V1) {
			this.log.warn('handshake-refused', {
				clientVersion: frame.version,
				version: MCODED_PROTOCOL_VERSION,
			});
			this.send({
				type: 'response',
				command: 'hello',
				success: false,
				error: `unsupported protocol version ${String(frame.version)}; daemon speaks ${MCODED_PROTOCOL_VERSION}`,
				errorCode: 'UNSUPPORTED_VERSION',
			});
			this.close('handshake-failed');
			return;
		}
		this.state = 'open';
		this.log.info('connect', { version: frame.version });
		this.dispatch(frame, lineBytes);
	}

	/** Dispatch one command to the host, timing the request/response roundtrip. */
	private dispatch(frame: ClientFrame, requestBytes: number): void {
		const startedAt = Date.now();
		void this.host
			.onCommand(frame, this)
			.finally(() => {
				this.log.debug('request', {
					method: frame.type,
					bytes: requestBytes,
					durationMs: Date.now() - startedAt,
				});
			})
			.catch((error: unknown) => {
				// A rejecting host (e.g. a throwing daemon shutdown callback) must
				// not become an unhandled rejection — Node terminates the process.
				// The hub answers expected failures inline; this is the backstop.
				this.log.error('command-failed', { err: error, method: frame.type });
			});
	}
}
