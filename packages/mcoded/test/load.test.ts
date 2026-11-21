/**
 * W3 load gate (arch §6 W3): 8 parallel `sendMessage` streams against the
 * echo/replay-shaped model stand-in —
 * 1. p99 ADDED frame latency (source-production → client receipt) ≤ 5 ms;
 * 2. daemon event-loop lag p99 ≤ 50 ms during the storm;
 * 3. a HUNG client (credits exhausted, never replenished) is PAUSED — the
 *    daemon stops pulling its source (no growth), the other 7 streams
 *    complete unaffected, and hub memory stays bounded.
 *
 * The daemon path runs over the in-memory loopback, so the measured latency
 * is exactly the daemon's added forwarding cost (wire + mux + microtasks),
 * with no kernel-socket noise.
 *
 * @module
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import { CliBridge } from '../src/cli-bridge.js';
import { DEFAULT_STREAM_CREDIT } from '../src/protocol.js';
import { createInMemoryTransportPair, type LineTransport } from '../src/transport.js';
import {
	attachClient,
	TestClient,
	helloV2,
	isStreamEnd,
	isStreamFrame,
	setupHub,
	waitForSuccess,
} from './helpers.js';
import { makeFakeCliService } from './v2-fakes.js';

/**
 * Client-side transport that stamps ARRIVAL (the daemon's synchronous write)
 * per stream frame: `added latency = arrival − producer stamp`, with no test
 * polling in the measurement.
 */
class ArrivalStampingTransport implements LineTransport {
	private readonly peer: LineTransport;
	readonly arrivals = new Map<string, number>();

	constructor(peer: LineTransport) {
		this.peer = peer;
	}

	write(line: string): void {
		// `{"type":"stream.frame","streamId":"s1","seq":33,"frame":{"at":...}}`
		const streamId = /"streamId":"([^"]+)"/.exec(line)?.[1];
		const seq = /"seq":(\d+)/.exec(line)?.[1];
		if (streamId && seq) this.arrivals.set(`${streamId}:${seq}`, Date.now());
		this.peer.write(line);
	}

	lines(): AsyncIterableIterator<string> {
		return this.peer.lines();
	}

	end(): void {
		this.peer.end();
	}

	get closed(): Promise<void> {
		return this.peer.closed;
	}
}

/** attachClient over the stamping transport (returns the arrival map too). */
function attachStampedClient(hub: Parameters<typeof attachClient>[0], name: string): {
	client: TestClient;
	arrivals: Map<string, number>;
} {
	const [clientSide, serverSide] = createInMemoryTransportPair();
	const stamped = new ArrivalStampingTransport(serverSide);
	hub.attachTransport(stamped);
	const client = new TestClient(clientSide, name);
	return { client, arrivals: stamped.arrivals };
}

const STREAMS = 8;
const FRAMES_PER_STREAM = 400;
const FRAME_PAD_BYTES = 200;

interface Producer {
	/** Counts source.next() resolutions — the pause metric of gate 3. */
	readonly pulled: () => number;
	/** The source the bridge hands to the hub. */
	readonly source: AsyncGenerator<unknown>;
}

/** A turn-shaped producer: paced, stamped frames + terminal + [DONE]. */
function makeProducer(paceMs: number): Producer {
	let pulls = 0;
	const source = (async function* () {
		for (let index = 0; index < FRAMES_PER_STREAM; index += 1) {
			if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
			pulls += 1;
			yield {
				type: 'message_delta',
				at: Date.now(),
				text: 'x'.repeat(FRAME_PAD_BYTES),
				seq: index,
			};
		}
		yield { type: 'session_status', status: { type: 'completed' } };
		yield '[DONE]';
	})();
	return { pulled: () => pulls, source };
}

function percentile(samples: number[], p: number): number {
	if (samples.length === 0) return Number.POSITIVE_INFINITY;
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)]!;
}

describe('W3 load: 8 parallel sendMessage streams', () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it('gate 1+2: p99 added frame latency ≤ 5 ms, event-loop lag p99 ≤ 50 ms', async () => {
		const cli = makeFakeCliService();
		const producers: Producer[] = [];
		cli.sendMessage.mockImplementation(() => {
			const producer = makeProducer(1);
			producers.push(producer);
			return Promise.resolve({ ok: true, source: producer.source });
		});
		const lag = monitorEventLoopDelay({ resolution: 10 });
		lag.enable();
		cleanups.push(() => lag.disable());

		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => cli }),
		});

		// 8 windows, each its own connection and its own stream — the arch's
		// herd shape (one daemon, 8 multiplexed turn streams).
		const clients: TestClient[] = [];
		const arrivals: Map<string, number>[] = [];
		for (let index = 0; index < STREAMS; index += 1) {
			const attached = attachStampedClient(hub, `window-${index}`);
			const client = attached.client;
			arrivals.push(attached.arrivals);
			cleanups.push(() => client.close());
			await helloV2(client, { clientInstanceId: `window-${index}` });
			client.send({
				type: 'stream.open',
				id: `open-${index}`,
				method: 'sendMessage',
				params: [{ id: `sess-${index}`, content: 'load' }],
				credit: DEFAULT_STREAM_CREDIT,
			});
			await waitForSuccess(client, (frame) => frame.command === 'stream.open');
			clients.push(client);
		}
		expect(producers).toHaveLength(STREAMS);

		// Drain every stream to [DONE], stamping receipt times. Stream ids are
		// per-connection (every window's stream is `s1`), so progress is
		// tracked per client. A REAL client grants credits as it renders — the
		// sweep does the same (batched by 32), so streams longer than the
		// initial credit still complete.
		const latencies: number[] = [];
		const remaining = new Set(clients);
		const frameCount: number[] = clients.map(() => 0);
		const owed: number[] = clients.map(() => 0);
		const grantCredit = (index: number): void => {
			owed[index] += 1;
			if (owed[index] >= 32) {
				clients[index].send({ type: 'stream.credit', streamId: 's1', frames: owed[index] });
				owed[index] = 0;
			}
		};
		const deadline = Date.now() + 60_000;
		while (remaining.size > 0 && Date.now() < deadline) {
			for (const client of [...remaining]) {
				const index = clients.indexOf(client);
				while (true) {
					const queued = client.received.findIndex(
						(frame) => isStreamFrame(frame) || isStreamEnd(frame),
					);
					if (queued < 0) break;
					const frame = client.received.splice(queued, 1)[0]!;
					if (frame.type === 'stream.end') {
						remaining.delete(client);
						break;
					}
					frameCount[index] += 1;
					grantCredit(index);
					if (isStreamFrame(frame)) {
						const producedAt = (frame.frame as { at?: number }).at;
						const arrivedAt = arrivals[index]?.get(`${frame.streamId}:${frame.seq}`);
						if (typeof producedAt === 'number' && arrivedAt !== undefined) {
							latencies.push(arrivedAt - producedAt);
						}
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(remaining.size).toBe(0);
		// Every frame of every stream crossed the daemon.
		for (const count of frameCount) {
			expect(count).toBe(FRAMES_PER_STREAM + 2);
		}

		// Gate 1: added frame latency.
		const p50 = percentile(latencies, 50);
		const p99 = percentile(latencies, 99);
		const max = percentile(latencies, 100);
		expect(latencies.length).toBe(STREAMS * FRAMES_PER_STREAM); // every data frame stamped
		expect(
			p99,
			`p99 added frame latency ${p99.toFixed(2)} ms (p50 ${p50.toFixed(2)} ms, max ${max.toFixed(2)} ms) must be ≤ 5 ms`,
		).toBeLessThanOrEqual(5);

		// Gate 2: event-loop lag under the storm.
		await new Promise((resolve) => setTimeout(resolve, 120)); // let the histogram settle
		const lagP99 = lag.percentile(99) / 1e6;
		// Load tests print their measurements: the gate values are the limit,
		// these numbers are the observed headroom.
		console.log(
			`load: ${STREAMS} streams x ${FRAMES_PER_STREAM} frames — ` +
				`added-frame-latency p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms; ` +
				`event-loop lag p99=${lagP99.toFixed(2)}ms`,
		);
		expect(
			lagP99,
			`event-loop lag p99 ${lagP99.toFixed(2)} ms must be ≤ 50 ms`,
		).toBeLessThanOrEqual(50);
	}, 90_000);

	it('gate 3: a hung client is PAUSED (no pulls → no growth); the other streams finish', async () => {
		const cli = makeFakeCliService();
		const producers: Producer[] = [];
		cli.sendMessage.mockImplementation(() => {
			const producer = makeProducer(1);
			producers.push(producer);
			return Promise.resolve({ ok: true, source: producer.source });
		});
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => cli }),
			defaultStreamCredit: 32, // the hung client's whole budget
		});

		const healthy: ReturnType<typeof attachClient>[] = [];
		let hung: ReturnType<typeof attachClient> | undefined;
		for (let index = 0; index < STREAMS; index += 1) {
			const client = attachClient(hub, `w-${index}`);
			cleanups.push(() => client.close());
			await helloV2(client, { clientInstanceId: `w-${index}` });
			client.send({
				type: 'stream.open',
				id: `open-${index}`,
				method: 'sendMessage',
				params: [{ id: `sess-${index}`, content: 'load' }],
			});
			await waitForSuccess(client, (frame) => frame.command === 'stream.open');
			if (index === 0) hung = client;
			else healthy.push(client);
		}

		// The seven healthy clients credit as they consume (real client
		// behavior); the hung one never reads and never credits.
		const finishedHealthy = new Set<ReturnType<typeof attachClient>>();
		const owed: number[] = healthy.map(() => 0);
		const deadline = Date.now() + 60_000;
		while (finishedHealthy.size < healthy.length && Date.now() < deadline) {
			for (let index = 0; index < healthy.length; index += 1) {
				const client = healthy[index]!;
				while (true) {
					const queued = client.received.findIndex(
						(frame) => isStreamFrame(frame) || isStreamEnd(frame),
					);
					if (queued < 0) break;
					const frame = client.received.splice(queued, 1)[0]!;
					if (frame.type === 'stream.end') {
						finishedHealthy.add(client);
						break;
					}
					owed[index] = (owed[index] ?? 0) + 1;
					if ((owed[index] ?? 0) >= 32) {
						client.send({ type: 'stream.credit', streamId: 's1', frames: owed[index]! });
						owed[index] = 0;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(finishedHealthy.size).toBe(healthy.length);

		// The hung client: exactly its credit of frames, then SILENCE.
		const hungFrames = hung!.received.filter(isStreamFrame);
		expect(hungFrames.length).toBe(32);

		// Pause, not growth: the daemon stopped pulling the frozen source.
		const hungProducer = producers[0]!;
		const pullsAtFreeze = hungProducer.pulled();
		expect(pullsAtFreeze).toBeGreaterThanOrEqual(32);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(hungProducer.pulled()).toBe(pullsAtFreeze); // FROZEN — no growth
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(hungProducer.pulled()).toBe(pullsAtFreeze); // still frozen
		const hungAfter = hung!.received.filter(isStreamFrame);
		expect(hungAfter.length).toBe(32); // no new frames either

		// Crediting resumes exactly where it stopped (seq discipline intact):
		// consume the 32 buffered frames (the client "renders" them), then
		// the NEW frames are seq 33+.
		const bufferedSeqs = hungFrames.map((frame) => frame.seq);
		expect(bufferedSeqs).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
		hung!.received.length = 0; // consumed by the window
		hung!.send({ type: 'stream.credit', streamId: 's1', frames: 5 });
		for (let index = 0; index < 5; index += 1) {
			const next = await hung!.waitFor((candidate) => isStreamFrame(candidate) || isStreamEnd(candidate));
			expect(next.type).toBe('stream.frame');
			expect((next as { seq: number }).seq).toBe(33 + index);
		}

		// Detach ends the stream for the client; the turn drains on (I-DETACH).
		hung!.send({ type: 'stream.cancel', streamId: 's1', mode: 'detach' });
		const end = await hung!.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ streamId: 's1', reason: 'detached', resumable: true });
		// The daemon keeps consuming the frozen source after the detach (at
		// the producer's own pace) — poll until the pull count stabilizes.
		const drainDeadline = Date.now() + 15_000;
		let last = -1;
		while (Date.now() < drainDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const now = hungProducer.pulled();
			if (now === last) break;
			last = now;
		}
		// The daemon finished consuming the frozen source after the detach
		// (the counter ticks once per data frame; status/[DONE] trail it).
		expect(hungProducer.pulled()).toBe(FRAMES_PER_STREAM);
		void hub;
	}, 90_000);
});
