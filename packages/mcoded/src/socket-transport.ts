/**
 * `net.Socket` → {@link LineTransport} adapter: splits the byte stream on
 * newline boundaries and forwards JSONL frames between the daemon and a unix
 * socket client. The in-memory pair in `transport.ts` implements the same
 * interface, so the wire layer is transport-agnostic.
 *
 * v2 hardening (arch §4.3.5):
 * - the inbound accumulation buffer is bounded by `maxLineBytes` (default
 *   `MAX_INBOUND_FRAME_BYTES`): a client pushing one unbounded line cannot
 *   grow the daemon's memory — the transport fires `onLineLimit` once (so the
 *   wire can still answer `PROTOCOL_ERROR`) and destroys the socket;
 * - `congested`/`waitDrain()` expose Node's `write()` backpressure, so the
 *   hub pauses a slow connection's streams instead of buffering against a
 *   hung client forever.
 *
 * @module
 */

import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

import { createLogger } from '@mavis/logging';

import { MAX_INBOUND_FRAME_BYTES } from './protocol.js';
import type { BackpressureTransport, LineTransport } from './transport.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

export class SocketLineTransport implements BackpressureTransport {
	private readonly socket: net.Socket;
	private readonly decoder = new StringDecoder('utf8');
	private readonly inbox: string[] = [];
	private readonly waiters: Array<(result: IteratorResult<string>) => void> = [];
	private readonly drainWaiters: Array<() => void> = [];
	private readonly maxLineBytes: number;
	private readonly onLineLimit: (() => void) | undefined;
	private buffer = '';
	private resolveClosed: (() => void) | undefined;
	private ended = false;
	private writeCongested = false;
	private lineLimitFired = false;

	readonly closed: Promise<void>;

	constructor(
		socket: net.Socket,
		options: {
			/** Inbound single-line budget; `0`/negative disables the guard. */
			readonly maxLineBytes?: number;
			/** Fired once when the budget is crossed, BEFORE the socket dies. */
			readonly onLineLimit?: () => void;
		} = {},
	) {
		this.socket = socket;
		this.maxLineBytes = options.maxLineBytes ?? MAX_INBOUND_FRAME_BYTES;
		this.onLineLimit = options.onLineLimit;
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		socket.setNoDelay(true);
		socket.on('data', (chunk: Buffer) => this.onData(chunk));
		socket.on('close', () => this.settle());
		socket.on('error', (error: Error) => {
			log.debug('socket-error', { err: error });
			this.settle();
		});
		socket.on('drain', () => {
			this.writeCongested = false;
			for (const waiter of this.drainWaiters.splice(0)) waiter();
		});
	}

	/** True while the socket's write buffer is over `highWaterMark`. */
	get congested(): boolean {
		if (this.ended || this.socket.destroyed) return false;
		return this.writeCongested || this.socket.writableNeedDrain;
	}

	/** Resolves on the socket's `drain` event (or immediately when clear). */
	waitDrain(): Promise<void> {
		if (!this.congested) return Promise.resolve();
		return new Promise((resolve) => this.drainWaiters.push(resolve));
	}

	private onData(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		if (
			!this.lineLimitFired &&
			this.maxLineBytes > 0 &&
			this.buffer.length > this.maxLineBytes &&
			// No newline inside the budget: the client is pushing one oversized
			// line (or garbage), not a stream of legal frames.
			!this.hasNewlineWithin(this.maxLineBytes)
		) {
			this.lineLimitFired = true;
			log.warn('inbound-frame-limit', { bytes: this.buffer.length, max: this.maxLineBytes });
			try {
				this.onLineLimit?.();
			} catch (error) {
				log.error('inbound-frame-limit-callback-failed', { err: error });
			}
			// Destroy AFTER the callback answered: the response may still fit the
			// socket queue, and the connection must die either way.
			this.socket.destroy();
			this.settle();
			return;
		}
		let newline = this.buffer.indexOf('\n');
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			this.deliver(line);
			newline = this.buffer.indexOf('\n');
		}
	}

	private hasNewlineWithin(limit: number): boolean {
		return this.buffer.slice(0, limit + 1).indexOf('\n') >= 0;
	}

	private deliver(line: string): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ done: false, value: line });
			return;
		}
		this.inbox.push(line);
	}

	write(line: string): void {
		if (this.ended || this.socket.destroyed) return;
		// Lines arrive newline-free (LineTransport contract): this adapter owns
		// the '\n' framing, exactly one per line. A `false` return means the
		// internal buffer crossed `highWaterMark` — the congestion flag flips
		// and the `drain` event resolves `waitDrain()` waiters.
		this.writeCongested = !this.socket.write(`${line}\n`);
	}

	lines(): AsyncIterableIterator<string> {
		const iterator: AsyncIterableIterator<string> = {
			[Symbol.asyncIterator]: () => iterator,
			next: () => {
				const line = this.inbox.shift();
				if (line !== undefined) {
					return Promise.resolve({ done: false as const, value: line });
				}
				if (this.ended || this.socket.destroyed) {
					return Promise.resolve({ done: true as const, value: undefined });
				}
				return new Promise((resolve) => this.waiters.push(resolve));
			},
			return: async () => {
				this.end();
				return { done: true as const, value: undefined };
			},
		};
		return iterator;
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.socket.end();
		this.settle();
	}

	/** Destroy the socket immediately (no flush) — for daemon teardown. */
	destroy(): void {
		this.ended = true;
		this.socket.destroy();
		this.settle();
	}

	private settle(): void {
		this.resolveClosed?.();
		this.writeCongested = false;
		for (const waiter of this.drainWaiters.splice(0)) waiter();
		for (const waiter of this.waiters.splice(0)) {
			waiter({ done: true, value: undefined });
		}
	}
}
