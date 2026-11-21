/**
 * The v2 stream multiplexer of one connection (arch §4.3.2, §4.3.5).
 *
 * One {@link StreamMux} per handshaken v2 connection; it owns the wire side
 * of every `stream.open` the connection holds and enforces the two bounds
 * that keep a hung client from growing the daemon:
 *
 * 1. **Credits** — a stream pulls a frame from its source only while the
 *    client's credit balance is positive (`stream.credit` replenishes; the
 *    `stream.open` credit seeds it). No credit, no pull: a pull-based source
 *    (echo, replay, the turn pipeline's lazy generator) simply stops
 *    producing.
 * 2. **Detach-sink** — while the connection is congested (`socket.write()`
 *    returned `false`), pulled frames wait in a bounded per-stream sink
 *    (4 MiB). Overflow detaches the stream: the client gets
 *    `stream.end{reason:'detached', resumable:true}` and the daemon keeps
 *    DRAINING the source into a null sink until `[DONE]` — the turn
 *    continues (I-DETACH; W0 F3: aborting requires an explicit
 *    `stream.cancel{mode:'abort'}`, which maps to `abortSession`).
 *
 * Frames are `stream.frame{streamId, seq, frame}` with a per-stream
 * monotonic `seq`; terminal `stream.end` reasons: `done | detached |
 * aborted | error`.
 *
 * @module
 */

import { createLogger } from '@mavis/logging';

import {
	DEFAULT_STREAM_CREDIT,
	STREAM_SINK_MAX_BYTES,
	type ServerFrame,
	type StreamCliMethod,
} from './protocol.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/** What the mux needs from the connection (satisfied by {@link RpcConnection}). */
export interface MuxSink {
	/** Queue one server frame (drops silently once closed). */
	send(frame: ServerFrame): void;
	/** Whether the connection still accepts frames. */
	readonly isOpen: boolean;
	/** Write-backpressure state of the underlying transport. */
	readonly congested: boolean;
	/** Resolves on transport drain (or close — callers recheck `isOpen`). */
	waitDrain(): Promise<void>;
}

/** The source the bridge hands over for one opened stream. */
export type MuxSource = AsyncIterable<SessionStreamFrameLike>;

/** `SessionStreamFrameView | string` — the process-local stream payload. */
export type SessionStreamFrameLike = unknown;

/** Terminal handling the bridge exposes to the mux (detach/abort semantics). */
export interface StreamMuxOptions {
	readonly sink: MuxSink;
	/** Per-stream sink budget (bytes). Default {@link STREAM_SINK_MAX_BYTES}. */
	readonly sinkMaxBytes?: number;
	/** Initial credit when the open frame carried none. Default 256 (arch). */
	readonly defaultCredit?: number;
	/** Distinguishes log lines of concurrent connections. */
	readonly label?: string;
	/**
	 * W5 (§4.6.5): fired once per stream when its pump loop has EXITED
	 * (`state: 'ended'`) — the hub's idle-restart counts live turn streams
	 * down here. Detached streams (I-DETACH) fire it too, at their TRUE end:
	 * a turn keeps draining after its window died, and the restart must wait
	 * for exactly that.
	 */
	readonly onStreamEnd?: (streamId: string, method: StreamCliMethod) => void;
}

/** Mutable state of one open stream. */
interface MuxStream {
	readonly id: string;
	readonly method: StreamCliMethod;
	readonly source: AsyncIterator<SessionStreamFrameLike>;
	/** The open call's params — what an `abort` needs to reach the turn. */
	readonly tag: unknown;
	credits: number;
	seq: number;
	/** `running` delivers; `detached`/`ended` only drain (or nothing). */
	state: 'running' | 'detached' | 'ended';
	/** Frames pulled while congested, bounded by {@link StreamMuxOptions.sinkMaxBytes}. */
	sink: Array<{ frame: unknown; bytes: number }>;
	sinkBytes: number;
	/** Set when the source finished while congested: settle after the flush. */
	pendingEnd?: { reason: StreamExit; error?: string };
	/** Serializes the async pump loop per stream. */
	pumping: boolean;
	resumable: boolean;
}

/** Why a stream left the delivering state (drives the `stream.end` reason). */
type StreamExit = 'done' | 'detached' | 'aborted' | 'error';

export class StreamMux {
	private readonly streams = new Map<string, MuxStream>();
	private readonly sink: MuxSink;
	private readonly sinkMaxBytes: number;
	private readonly defaultCredit: number;
	private readonly label: string | undefined;
	private readonly onStreamEnd: ((streamId: string, method: StreamCliMethod) => void) | undefined;
	private nextSeq = 1;
	private drainHook: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(options: StreamMuxOptions) {
		this.sink = options.sink;
		this.sinkMaxBytes = options.sinkMaxBytes ?? STREAM_SINK_MAX_BYTES;
		this.defaultCredit = options.defaultCredit ?? DEFAULT_STREAM_CREDIT;
		this.label = options.label;
		this.onStreamEnd = options.onStreamEnd;
	}

	/** Open (register + start pumping) one stream; returns its wire id. */
	open(
		method: StreamCliMethod,
		source: AsyncIterable<SessionStreamFrameLike>,
		credit?: number,
		tag?: unknown,
	): string {
		const id = `s${this.nextSeq++}`;
		const initial = credit ?? this.defaultCredit;
		this.streams.set(id, {
			id,
			method,
			source: source[Symbol.asyncIterator](),
			tag,
			credits: initial,
			seq: 0,
			state: 'running',
			sink: [],
			sinkBytes: 0,
			pumping: false,
			resumable: true,
		});
		this.schedulePump(id);
		return id;
	}

	/** Replenish credits; resumes a credit-paused pump. Returns false if unknown. */
	credit(streamId: string, frames: number): boolean {
		const stream = this.streams.get(streamId);
		if (!stream || stream.state === 'ended') return false;
		stream.credits += frames;
		this.schedulePump(streamId);
		return true;
	}

	/**
	 * `stream.cancel{mode}`: `detach` stops delivery (turn continues);
	 * `abort` first fires the explicit abort callback (W0 F3), then detaches.
	 * Idempotent — a second cancel of the same stream is a no-op (the
	 * per-client dedup contract for stream.cancel). The abort callback
	 * receives the stream's method and the open call's `tag` (the bridge
	 * params: session/turn ids).
	 */
	cancel(
		streamId: string,
		mode: 'detach' | 'abort',
		onAbort: (method: StreamCliMethod, tag: unknown) => Promise<void> | void,
	): boolean {
		const stream = this.streams.get(streamId);
		if (!stream) return false;
		if (stream.state === 'ended') return false;
		if (stream.state === 'detached') return true;
		if (mode === 'abort') {
			stream.resumable = true;
			this.detach(stream, 'aborted');
			const { method, tag } = stream;
			this.drainHook = this.drainHook
				.catch(() => undefined)
				.then(() => onAbort(method, tag))
				.catch((error: unknown) => {
					log.warn('stream-abort-failed', { streamId, err: error, label: this.label });
				});
			return true;
		}
		this.detach(stream, 'detached');
		return true;
	}

	/** The stream's method (hub logs / abort wiring). */
	methodOf(streamId: string): StreamCliMethod | undefined {
		return this.streams.get(streamId)?.method;
	}

	/** Streams the connection currently holds (daemon.status, shutdown). */
	get openStreams(): readonly string[] {
		return [...this.streams.keys()];
	}

	/**
	 * Streams still ALIVE (running or detached-draining) — the input of the
	 * `disconnect-with-live-streams` forensics (verdict §2.2г). An ended
	 * stream's map entry lingers until the connection closes; it is not live.
	 */
	get liveStreamIds(): readonly string[] {
		return [...this.streams.values()]
			.filter((stream) => stream.state !== 'ended')
			.map((stream) => stream.id);
	}

	/** Total bytes currently held in sinks (bounded-memory assertion surface). */
	get sinkBytesTotal(): number {
		let total = 0;
		for (const stream of this.streams.values()) total += stream.sinkBytes;
		return total;
	}

	/** Frames pulled but not yet deliverable (sink occupancy, all streams). */
	get sinkFramesTotal(): number {
		let total = 0;
		for (const stream of this.streams.values()) total += stream.sink.length;
		return total;
	}

	/**
	 * Connection died: every stream detaches silently (no `stream.end` — the
	 * peer is gone) and keeps draining its source into the null sink, so
	 * in-flight turns run to completion (I-DETACH).
	 */
	close(): void {
		this.closed = true;
		for (const stream of this.streams.values()) {
			if (stream.state === 'running') {
				stream.state = 'detached';
				this.schedulePump(stream.id);
			}
		}
	}

	/** Settles once every stream's pump loop has exited (shutdown order). */
	async idle(): Promise<void> {
		await this.drainHook;
		const pumps: Promise<void>[] = [];
		for (const stream of this.streams.values()) {
			// The pump promise is not stored; poll-to-settle via a microtask
			// chain would be fragile — instead wait for every stream to leave
			// the pumping state and its source to be finished.
			pumps.push(this.waitStreamSettled(stream));
		}
		await Promise.allSettled(pumps);
	}

	private waitStreamSettled(stream: MuxStream): Promise<void> {
		if (stream.state === 'ended' && !stream.pumping) return Promise.resolve();
		return new Promise((resolve) => {
			const check = (): void => {
				if (stream.state === 'ended' && !stream.pumping) {
					resolve();
					return;
				}
				setImmediate(check);
			};
			check();
		});
	}

	private schedulePump(streamId: string): void {
		void this.pump(streamId);
	}

	/**
	 * Live read of a stream's state. Post-`await` code must consult this, not
	 * a captured flag: the state can change while the pump hangs inside
	 * `source.next()` (mid-turn `stream.cancel`/`close()`), and TypeScript's
	 * narrowing of `stream.state` across the await is unsound here.
	 */
	private stateOf(stream: MuxStream): MuxStream['state'] {
		return stream.state;
	}

	/**
	 * The single pull loop of one stream. Serialized by `stream.pumping`.
	 *
	 * Pull gates, in order (arch §4.3.5):
	 * - no credit → hard pause (a pull-based source stops producing: the
	 *   hung-client memory bound);
	 * - connection gone → wait for `close()` to detach us;
	 * - congested → KEEP pulling into the bounded sink (the grace window):
	 *   the client's credits bound how much accumulates, the sink cap is the
	 *   second bound, and its overflow detaches the stream — the turn
	 *   continues into a null sink, the window resumes via `resumeSession`.
	 */
	private async pump(streamId: string): Promise<void> {
		const stream = this.streams.get(streamId);
		if (!stream || stream.pumping || stream.pendingEnd) return;
		stream.pumping = true;
		try {
			for (;;) {
				if (stream.state === 'ended') return;
				const drainOnly = stream.state === 'detached';
				if (!drainOnly) {
					if (stream.credits <= 0) return; // credit pause — no pull, no growth
					if (!this.sink.isOpen) return; // dying; close() will detach
				}
				let next: IteratorResult<SessionStreamFrameLike>;
				try {
					next = await stream.source.next();
				} catch (error) {
					stream.credits = 0;
					this.finish(stream, 'error', error instanceof Error ? error.message : undefined);
					return;
				}
				if (next.done) {
					this.finish(stream, 'done');
					return;
				}
				// Re-read the state AFTER the await: `cancel()`/`close()` may have
				// detached the stream while this pump hung inside `source.next()`
				// (the ordinary mid-turn `stream.cancel` case). The stale local
				// `drainOnly` would deliver the frame after the terminal
				// `stream.end` detach already sent — frames NEVER overtake it.
				// `stateOf` reads through the property so TS's (unsound) narrowing
				// from the loop head cannot hide the state change.
				const state = this.stateOf(stream);
				if (state === 'ended') return;
				if (state === 'detached') continue; // null sink: the turn keeps producing
				stream.credits -= 1;
				const payload = next.value;
				const bytes = Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
				if (this.sink.congested) {
					// This frame (and followers, within credits) waits in the
					// bounded sink until the transport drains.
					stream.sink.push({ frame: payload, bytes });
					stream.sinkBytes += bytes;
					if (stream.sinkBytes > this.sinkMaxBytes) {
						log.warn('stream-sink-overflow', {
							streamId,
							sinkBytes: stream.sinkBytes,
							label: this.label,
						});
						this.detach(stream, 'detached');
						continue;
					}
					void this.flushWhenDrained(stream.id);
					continue;
				}
				this.deliver(stream, payload);
			}
		} finally {
			stream.pumping = false;
		}
	}

	/**
	 * Flush one stream's sink after the transport drains, then resume pulling
	 * — and settle a pending finish once the residue is delivered (frames
	 * NEVER overtake the terminal `stream.end`).
	 */
	private flushWhenDrained(streamId: string): Promise<void> {
		return this.sink.waitDrain().then(() => {
			const stream = this.streams.get(streamId);
			if (!stream || stream.state === 'ended') return;
			if (this.sink.congested || !this.sink.isOpen) return; // re-armed on next drain
			while (stream.sink.length > 0) {
				const buffered = stream.sink.shift()!;
				stream.sinkBytes -= buffered.bytes;
				if (stream.state === 'running') this.deliver(stream, buffered.frame);
			}
			stream.sinkBytes = Math.max(0, stream.sinkBytes);
			if (stream.pendingEnd) {
				this.doFinish(stream, stream.pendingEnd.reason, stream.pendingEnd.error);
				return;
			}
			this.schedulePump(streamId);
		});
	}

	private deliver(stream: MuxStream, frame: unknown): void {
		stream.seq += 1;
		this.sink.send({
			type: 'stream.frame',
			streamId: stream.id,
			seq: stream.seq,
			frame,
		});
	}

	/** Leave the delivering state: announce to the client (unless gone), drain. */
	private detach(stream: MuxStream, reason: Extract<StreamExit, 'detached' | 'aborted'>): void {
		if (stream.state !== 'running') return;
		stream.state = 'detached';
		// Forensics (incident 2026-11-05, verdict §2.2г): a stream leaving the
		// delivering state before its source finished used to leave NO daemon
		// trace. WARN passes the owner's `mcode:wire:error` filter (namespace
		// `mcode:rpc`); the event is rare — a window detach/abort.
		log.warn('stream-end', {
			streamId: stream.id,
			method: stream.method,
			reason,
			sinkBytes: stream.sinkBytes,
			label: this.label,
		});
		if (this.sink.isOpen) {
			this.sink.send({
				type: 'stream.end',
				streamId: stream.id,
				reason,
				resumable: stream.resumable,
			});
		}
		// Detach means "the window stopped listening": buffered frames are
		// dropped, the pump keeps draining the source into the null sink.
		stream.sink = [];
		stream.sinkBytes = 0;
		const pendingEnd = stream.pendingEnd;
		stream.pendingEnd = undefined;
		if (pendingEnd) this.doFinish(stream, pendingEnd.reason, pendingEnd.error);
		else this.schedulePump(stream.id);
	}

	/**
	 * Request the terminal frame. While the connection is congested the
	 * terminal WAITS for the sink residue (ordering), then {@link doFinish}.
	 */
	private finish(stream: MuxStream, reason: StreamExit, error?: string): void {
		if (stream.state === 'ended' || stream.pendingEnd) return;
		const wasDetached = stream.state === 'detached';
		if (!wasDetached && stream.sink.length > 0 && this.sink.isOpen && this.sink.congested) {
			stream.pendingEnd = { reason, error };
			void this.flushWhenDrained(stream.id);
			return;
		}
		this.doFinish(stream, reason, error);
	}

	private doFinish(stream: MuxStream, reason: StreamExit, error?: string): void {
		if (stream.state === 'ended') return;
		const wasDetached = stream.state === 'detached';
		// Forensics (verdict §2.2г): a non-`done` terminal of the source is the
		// daemon-side trace of a turn window dying mid-flight (source fault) —
		// WARN it with the sink residue that never reached the client. A
		// `done` after a detach stays quiet: the drain ran to its natural end.
		if (reason !== 'done') {
			log.warn('stream-end', {
				streamId: stream.id,
				method: stream.method,
				reason,
				sinkBytes: stream.sinkBytes,
				...(error !== undefined ? { error } : {}),
				label: this.label,
			});
		}
		// Any still-buffered frames flush IN ORDER before the terminal frame.
		if (!wasDetached && this.sink.isOpen && !this.sink.congested) {
			while (stream.sink.length > 0) {
				const buffered = stream.sink.shift()!;
				stream.sinkBytes -= buffered.bytes;
				this.deliver(stream, buffered.frame);
			}
		}
		stream.state = 'ended';
		stream.credits = 0;
		stream.sink = [];
		stream.sinkBytes = 0;
		stream.pendingEnd = undefined;
		// W5: the pump loop has exited — the hub's live-turn count comes down.
		this.onStreamEnd?.(stream.id, stream.method);
		if (wasDetached) return; // the end frame already went out (or the peer died)
		if (this.sink.isOpen) {
			this.sink.send({
				type: 'stream.end',
				streamId: stream.id,
				reason,
				resumable: reason !== 'done' ? stream.resumable : undefined,
				...(error !== undefined ? { error } : {}),
			});
		}
	}
}
