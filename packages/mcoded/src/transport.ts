/**
 * Transports for the JSONL wire: one duplex of newline-delimited raw lines.
 *
 * The protocol layer (wire, hub) only ever sees a {@link LineTransport}, so
 * the same session logic runs over the in-memory loopback used by the skeleton
 * tests and over a real unix socket in the daemon. This module provides the
 * in-memory pair; `socket-transport.ts` adapts `net.Socket`.
 *
 * @module
 */

/**
 * One side of a duplex line transport. Lines carry no trailing newline:
 * `write` receives bare lines and the transport appends the delimiter on the
 * wire (the socket side) or passes them straight through (the in-memory
 * loopback); `lines()` yields them newline-free. A writer that appends its
 * own newline puts an empty line on the stream after every frame.
 */
export interface LineTransport {
	/**
	 * Queue a raw line to the peer. Deliveries are ordered and best-effort:
	 * after either side closes, queued data may be dropped.
	 */
	write(line: string): void;
	/** Incoming lines from the peer; the iterator ends when either side closes. */
	lines(): AsyncIterableIterator<string>;
	/** Close our side; the peer observes end-of-stream after what is queued. */
	end(): void;
	/** Resolves once the transport is dead (either side closed). */
	readonly closed: Promise<void>;
}

/**
 * Write-backpressure probe (arch §4.3.5): the socket transport reports
 * `write()` returning `false` as `congested` and resolves `waitDrain()` on
 * the socket's `drain` event. The daemon pauses a congested connection's
 * streams (credit-like gate on top of credits) instead of letting Node's
 * socket buffer grow against a hung client; the in-memory loopback is never
 * congested.
 */
export interface BackpressureTransport extends LineTransport {
	/** True while the peer (or the OS buffer) cannot take more bytes. */
	readonly congested: boolean;
	/** Resolves once the transport drains (or closes — the waiter must recheck). */
	waitDrain(): Promise<void>;
}

/** In-memory transport side: what it writes, the peer receives, and vice versa. */
class InMemorySide implements LineTransport {
	private readonly inbox: string[] = [];
	private readonly waiters: Array<(result: IteratorResult<string>) => void> = [];
	private peer: InMemorySide | undefined;
	private resolveClosed: (() => void) | undefined;
	private peerClosed = false;
	private selfClosed = false;
	private readonly drainWaiters: Array<() => void> = [];

	readonly closed: Promise<void>;

	constructor() {
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
	}

	/**
	 * The loopback never congests (delivery is synchronous into a peer queue);
	 * the socket transport is the real {@link BackpressureTransport}. Kept on
	 * the prototype shape so the v2 code paths can probe either uniformly.
	 */
	get congested(): boolean {
		return false;
	}

	waitDrain(): Promise<void> {
		if (!this.congested) return Promise.resolve();
		return new Promise((resolve) => this.drainWaiters.push(resolve));
	}

	/** Wire two fresh sides together (called once by the factory). */
	static link(a: InMemorySide, b: InMemorySide): void {
		a.peer = b;
		b.peer = a;
	}

	write(line: string): void {
		if (this.selfClosed) return;
		this.peer?.deliver(line);
	}

	private deliver(line: string): void {
		if (this.selfClosed || this.peerClosed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ done: false, value: line });
			return;
		}
		this.inbox.push(line);
	}

	lines(): AsyncIterableIterator<string> {
		const iterator: AsyncIterableIterator<string> = {
			[Symbol.asyncIterator]: () => iterator,
			next: () => {
				const line = this.inbox.shift();
				if (line !== undefined) {
					return Promise.resolve({ done: false as const, value: line });
				}
				if (this.selfClosed || this.peerClosed) {
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
		if (this.selfClosed) return;
		this.selfClosed = true;
		this.peer?.markPeerClosed();
		this.settle();
	}

	/** Called by the peer when it closes its writing side. */
	private markPeerClosed(): void {
		if (this.peerClosed) return;
		this.peerClosed = true;
		this.settle();
	}

	private settle(): void {
		this.resolveClosed?.();
		for (const waiter of this.waiters.splice(0)) {
			waiter({ done: true, value: undefined });
		}
	}
}

/**
 * Create a connected pair of in-memory line transports: what one side writes,
 * the other receives, in order. Delivery is synchronous; reading is async so
 * both sides share the exact same contract as the socket transport.
 */
export function createInMemoryTransportPair(): [LineTransport, LineTransport] {
	const a = new InMemorySide();
	const b = new InMemorySide();
	InMemorySide.link(a, b);
	return [a, b];
}
