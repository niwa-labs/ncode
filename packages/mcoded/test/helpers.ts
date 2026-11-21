/**
 * Shared test rig: a scriptable wire client over any line transport (the
 * in-memory loopback or a real socket), plus small hub factories.
 *
 * @module
 */

import net from 'node:net';

import type { ClientFrame, ServerFrame } from '../src/protocol.js';
import { serializeFrame } from '../src/protocol.js';
import { McodedHub, type McodedHubOptions } from '../src/hub.js';
import { EchoRuntimeAdapter } from '../src/runtime-adapter.js';
import { InMemoryCheckpointStore } from '../src/checkpoint.js';
import { createInMemoryTransportPair, type BackpressureTransport, type LineTransport } from '../src/transport.js';
import { SocketLineTransport } from '../src/socket-transport.js';

/** Event frames are what replay/cursor semantics are about — narrow them. */
export function isEventFrame(
	frame: ServerFrame,
): frame is Extract<ServerFrame, { type: 'event' }> {
	return frame.type === 'event';
}

export function isResponse(
	frame: ServerFrame,
): frame is Extract<ServerFrame, { type: 'response' }> {
	return frame.type === 'response';
}

export function isReplayGap(
	frame: ServerFrame,
): frame is Extract<ServerFrame, { type: 'replay_gap' }> {
	return frame.type === 'replay_gap';
}

/**
 * A test client speaking raw JSONL over a line transport. Frames arrive in
 * order; `next()` consumes one, `waitFor(predicate)` consumes until a match
 * and puts everything it skipped back in front, preserving order.
 */
export class TestClient {
	readonly received: ServerFrame[] = [];
	private readonly waiters: Array<(frame: ServerFrame) => void> = [];
	private readonly pump: Promise<void>;

	constructor(
		readonly transport: LineTransport,
		readonly name: string = 'client',
	) {
		this.pump = this.drain();
	}

	/** Send a typed client frame. */
	send(frame: ClientFrame): void {
		this.transport.write(serializeFrame(frame));
	}

	/**
	 * Send an arbitrary raw line (for protocol-abuse tests). The line must be
	 * newline-free — the transport owns the framing, same as `send`.
	 */
	sendRaw(line: string): void {
		this.transport.write(line);
	}

	/** Next frame received (awaiting delivery if the queue is empty). */
	next(): Promise<ServerFrame> {
		const queued = this.received.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/**
	 * Next frame matching the predicate; skipped frames stay queued. With a
	 * type-guard predicate the result is narrowed; a plain boolean predicate
	 * only synchronizes (the result stays the wide frame type).
	 */
	async waitFor<T extends ServerFrame>(predicate: (frame: ServerFrame) => frame is T): Promise<T>;
	async waitFor(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
	async waitFor(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
		const skipped: ServerFrame[] = [];
		try {
			for (;;) {
				const index = this.received.findIndex(predicate);
				if (index >= 0) return this.received.splice(index, 1)[0] as ServerFrame;
				const frame = await this.next();
				if (predicate(frame)) return frame;
				skipped.push(frame);
			}
		} finally {
			for (const frame of skipped.reverse()) this.received.unshift(frame);
		}
	}

	/** Collect the next `count` event frames in order. */
	async events(count: number): Promise<Array<Extract<ServerFrame, { type: 'event' }>>> {
		const collected: Array<Extract<ServerFrame, { type: 'event' }>> = [];
		while (collected.length < count) {
			const frame = await this.waitFor(isEventFrame);
			collected.push(frame);
		}
		return collected;
	}

	/** Resolves when the transport hit end-of-stream (server closed). */
	closed(): Promise<void> {
		return this.pump;
	}

	close(): void {
		this.transport.end();
	}

	private async drain(): Promise<void> {
		const lines = this.transport.lines();
		for (;;) {
			const next = await lines.next();
			if (next.done) break;
			const line = next.value.trim();
			if (line.length === 0) continue;
			const frame = JSON.parse(line) as ServerFrame;
			const waiter = this.waiters.shift();
			if (waiter) {
				waiter(frame);
				continue;
			}
			this.received.push(frame);
		}
	}
}

/** Minimal hub factory for wire-level tests: echo runtime, memory checkpoint. */
export async function setupHub(
	override: Partial<McodedHubOptions> = {},
): Promise<{ hub: McodedHub; adapter: EchoRuntimeAdapter }> {
	const adapter = (override.adapter as EchoRuntimeAdapter | undefined) ?? new EchoRuntimeAdapter();
	const hub = new McodedHub({
		adapter,
		checkpoint: override.checkpoint ?? new InMemoryCheckpointStore(),
		...(override.eventLog ? { eventLog: override.eventLog } : {}),
		...(override.replayLimits ? { replayLimits: override.replayLimits } : {}),
		...(override.drainTimeoutMs !== undefined
			? { drainTimeoutMs: override.drainTimeoutMs }
			: {}),
		...(override.idleRestartPollMs !== undefined
			? { idleRestartPollMs: override.idleRestartPollMs }
			: {}),
		...(override.requestDedupLimit !== undefined
			? { requestDedupLimit: override.requestDedupLimit }
			: {}),
		...(override.handshake ? { handshake: override.handshake } : {}),
		...(override.bridge ? { bridge: override.bridge } : {}),
		...(override.globalEvents ? { globalEvents: override.globalEvents } : {}),
		...(override.promptMode !== undefined ? { promptMode: override.promptMode } : {}),
		...(override.detachedPermission !== undefined
			? { detachedPermission: override.detachedPermission }
			: {}),
		...(override.streamSinkMaxBytes !== undefined
			? { streamSinkMaxBytes: override.streamSinkMaxBytes }
			: {}),
		...(override.defaultStreamCredit !== undefined
			? { defaultStreamCredit: override.defaultStreamCredit }
			: {}),
		...(override.onRestartRequested ? { onRestartRequested: override.onRestartRequested } : {}),
		...(override.onAuthSyncRequested
			? { onAuthSyncRequested: override.onAuthSyncRequested }
			: {}),
	});
	await hub.start();
	return { hub, adapter };
}

/** A test client wired straight into a hub over the in-memory loopback. */
export function attachClient(hub: McodedHub, name?: string): TestClient {
	const [clientSide, serverSide] = createInMemoryTransportPair();
	hub.attachTransport(serverSide);
	return new TestClient(clientSide, name);
}

/** A test client connected over the daemon's real unix socket. */
export function connectClient(socketPath: string, name?: string): Promise<TestClient> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		socket.once('connect', () => resolve(new TestClient(new SocketLineTransport(socket), name)));
		socket.once('error', reject);
	});
}

export type SuccessfulResponse = Extract<ServerFrame, { type: 'response'; success: true }>;
export type FailedResponse = Extract<ServerFrame, { type: 'response'; success: false }>;

export function isStreamFrame(
	frame: ServerFrame,
): frame is Extract<ServerFrame, { type: 'stream.frame' }> {
	return frame.type === 'stream.frame';
}

export function isStreamEnd(
	frame: ServerFrame,
): frame is Extract<ServerFrame, { type: 'stream.end' }> {
	return frame.type === 'stream.end';
}

export function isPong(frame: ServerFrame): frame is Extract<ServerFrame, { type: 'pong' }> {
	return frame.type === 'pong';
}

/** Handshake shorthand used by nearly every test. */
export async function hello(client: TestClient): Promise<SuccessfulResponse> {
	client.send({ type: 'hello', version: 1 });
	const frame = await client.next();
	if (!isResponse(frame) || frame.command !== 'hello' || !frame.success) {
		throw new Error(`expected hello welcome, got ${JSON.stringify(frame)}`);
	}
	return frame;
}

/**
 * v2 handshake shorthand: carries a stable `clientInstanceId` so the
 * per-client dedup windows key deterministically in tests.
 */
export async function helloV2(
	client: TestClient,
	extra: Partial<Extract<ClientFrame, { type: 'hello' }>> = {},
): Promise<SuccessfulResponse> {
	client.send({
		type: 'hello',
		version: 2,
		minor: 0,
		clientInstanceId: `test-client-${client.name}`,
		...extra,
	});
	const frame = await client.next();
	if (!isResponse(frame) || frame.command !== 'hello' || !frame.success) {
		throw new Error(`expected v2 hello welcome, got ${JSON.stringify(frame)}`);
	}
	return frame;
}

/**
 * In-memory transport with a TEST-CONTROLLED congestion flag: same shape as
 * the loopback pair, but the hub's stream mux observes `congested`/`drain()`,
 * so credit/congestion/detach paths run without real sockets.
 */
export class CongestibleTransport implements BackpressureTransport {
	private readonly inbox: string[] = [];
	private readonly readers: Array<(result: IteratorResult<string>) => void> = [];
	private readonly drainWaiters: Array<() => void> = [];
	private peer: CongestibleTransport | undefined;
	private closedSelf = false;
	private closedPeer = false;
	private congestedNow = false;
	readonly closed: Promise<void>;
	private resolveClosed!: () => void;

	constructor() {
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
	}

	static link(a: CongestibleTransport, b: CongestibleTransport): void {
		a.peer = b;
		b.peer = a;
	}

	/** Flip the congestion flag; hub streams must pause (not buffer) while set. */
	setCongested(value: boolean): void {
		this.congestedNow = value;
		if (!value) for (const waiter of this.drainWaiters.splice(0)) waiter();
	}

	get congested(): boolean {
		return this.congestedNow;
	}

	waitDrain(): Promise<void> {
		if (!this.congestedNow) return Promise.resolve();
		return new Promise((resolve) => this.drainWaiters.push(resolve));
	}

	write(line: string): void {
		this.peer?.deliver(line);
	}

	private deliver(line: string): void {
		if (this.closedSelf || this.closedPeer) return;
		const reader = this.readers.shift();
		if (reader) {
			reader({ done: false, value: line });
			return;
		}
		this.inbox.push(line);
	}

	lines(): AsyncIterableIterator<string> {
		const iterator: AsyncIterableIterator<string> = {
			[Symbol.asyncIterator]: () => iterator,
			next: () => {
				const line = this.inbox.shift();
				if (line !== undefined) return Promise.resolve({ done: false as const, value: line });
				if (this.closedSelf || this.closedPeer) {
					return Promise.resolve({ done: true as const, value: undefined });
				}
				return new Promise((resolve) => this.readers.push(resolve));
			},
			return: async () => {
				this.end();
				return { done: true as const, value: undefined };
			},
		};
		return iterator;
	}

	end(): void {
		this.closedSelf = true;
		this.peer?.markPeerClosed();
		this.resolveClosed();
	}

	private markPeerClosed(): void {
		this.closedPeer = true;
		this.resolveClosed();
		for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
	}
}

/** A hub client over the congestion-controllable loopback. */
export function attachCongestibleClient(
	hub: McodedHub,
	name?: string,
): { client: TestClient; serverTransport: CongestibleTransport } {
	const clientSide = new CongestibleTransport();
	const serverSide = new CongestibleTransport();
	CongestibleTransport.link(clientSide, serverSide);
	hub.attachTransport(serverSide);
	return { client: new TestClient(clientSide, name), serverTransport: serverSide };
}

/** Next successful response frame matching `match`; other frames stay queued. */
export function waitForSuccess(
	client: TestClient,
	match: (frame: SuccessfulResponse) => boolean = () => true,
): Promise<SuccessfulResponse> {
	return client.waitFor((frame): frame is SuccessfulResponse => {
		return isResponse(frame) && frame.success && match(frame);
	});
}

/** Next failed response frame matching `match`; other frames stay queued. */
export function waitForFailure(
	client: TestClient,
	match: (frame: FailedResponse) => boolean = () => true,
): Promise<FailedResponse> {
	return client.waitFor((frame): frame is FailedResponse => {
		return isResponse(frame) && !frame.success && match(frame);
	});
}

/** Next response frame (either outcome) matching `match`; others stay queued. */
export function waitForResponse(
	client: TestClient,
	match: (frame: Extract<ServerFrame, { type: 'response' }>) => boolean = () => true,
): Promise<Extract<ServerFrame, { type: 'response' }>> {
	type ResponseFrame = Extract<ServerFrame, { type: 'response' }>;
	return client.waitFor((frame): frame is ResponseFrame => isResponse(frame) && match(frame));
}
