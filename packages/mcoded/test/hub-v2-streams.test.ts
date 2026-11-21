/**
 * W3: the stream multiplexer — `stream.open` mirroring, credit gating (no
 * credit → pause, NOT growth), congestion + detach-sink bounds (§4.3.5),
 * cancel detach vs abort (W0 F3), and per-stream seq discipline.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import type { CliSendMessageReq } from '@mavis/local-runtime-v2/cli-service';

import { CliBridge } from '../src/cli-bridge.js';
import { attachClient, attachCongestibleClient, helloV2, isStreamEnd, isStreamFrame, setupHub, waitForFailure, waitForSuccess } from './helpers.js';
import { makeFakeCliService, type FakeCliService } from './v2-fakes.js';

/** A deterministic turn-shaped source: `count` frames, a terminal status, [DONE]. */
function turnFrames(count: number): AsyncGenerator<unknown> {
	return (async function* () {
		for (let index = 0; index < count; index += 1) {
			yield { type: 'message_delta', seq: index, text: `chunk-${index}` };
		}
		yield { type: 'session_status', status: { type: 'completed' } };
		yield '[DONE]';
	})();
}

interface Rig {
	cli: FakeCliService;
	setup: typeof setupHub;
}

function rigWithStreams(): Rig {
	const cli = makeFakeCliService();
	return {
		cli,
		setup: (override = {}) =>
			setupHub({
				bridge: new CliBridge({ cliService: () => cli }),
				...override,
			}),
	};
}

async function openSendStream(
	hub: Awaited<ReturnType<typeof setupHub>>['hub'],
	client: ReturnType<typeof attachClient>,
	params: unknown[] = [{ id: 'sess-1', message: 'hello' }],
	credit?: number,
	method: 'sendMessage' | 'resumeSession' | 'watchSessionUsageCommits' = 'sendMessage',
): Promise<string> {
	client.send({
		type: 'stream.open',
		id: `open-${Math.random().toString(36).slice(2)}`,
		method,
		params,
		...(credit !== undefined ? { credit } : {}),
	});
	const response = await waitForSuccess(client, (frame) => frame.command === 'stream.open');
	return (response.data as { streamId: string }).streamId;
}

describe('stream.open / stream.frame / stream.end', () => {
	it('mirrors the turn: frames in order with per-stream seq, [DONE] verbatim, end done', async () => {
		const { cli, setup } = rigWithStreams();
		cli.sendMessage.mockImplementationOnce(() =>
			Promise.resolve({ ok: true, source: turnFrames(3) }),
		);
		const { hub } = await setup();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		const streamId = await openSendStream(hub, client);
		const frames = [];
		for (;;) {
			const frame = await client.waitFor((candidate) => isStreamFrame(candidate) || isStreamEnd(candidate));
			if (frame.type === 'stream.end') {
				expect(frame).toMatchObject({ streamId, reason: 'done' });
				break;
			}
			frames.push(frame);
		}
		expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(frames[4]?.frame).toBe('[DONE]');
		// The vi mock records the REAL invocation args.
		const openArgs = (cli.sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(openArgs?.[0]).toEqual({ id: 'sess-1', message: 'hello' });
		// The daemon-built ctx rides as arg 1; the client sent none.
		expect(openArgs?.[1]).toMatchObject({ signal: expect.anything() });
		client.close();
	});

	it('a refused open mirrors ProcessLocalStreamResult as errorData {status, body}', async () => {
		const { cli, setup } = rigWithStreams();
		cli.sendMessage.mockImplementationOnce(() =>
			Promise.resolve({ ok: false, status: 409, body: { key: 'turn_active', message: 'a turn is running' } }),
		);
		const stderrSpy = vi.spyOn(process.stderr, 'write');
		const { hub } = await setup();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		client.send({
			type: 'stream.open',
			id: 'x',
			method: 'sendMessage',
			params: [{ id: 'sess-busy' }],
		});
		const failure = await waitForFailure(client, (frame) => frame.command === 'stream.open');
		expect(failure.errorCode).toBe('RUNTIME_REJECTED');
		// Incident 2026-11-05: `error` is the human-readable mirror of the
		// runtime's message (NOT the old constant), `errorData` keeps the full
		// {status, body} mirror, and the refusal leaves ONE mcode:rpc WARN —
		// the only daemon-side trace a busy-refusal ever had.
		expect(failure.error).toBe('a turn is running');
		expect(failure.errorData).toEqual({
			status: 409,
			body: { key: 'turn_active', message: 'a turn is running' },
		});
		const warns = stderrSpy.mock.calls
			.map(([chunk]) => String(chunk))
			.filter((line) => line.includes('stream-open-refused'));
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain('mcode:rpc');
		expect(warns[0]).toContain('method=sendMessage');
		expect(warns[0]).toContain('sessionId=sess-busy');
		expect(warns[0]).toContain('status=409');
		expect(warns[0]).toContain('bodyKey=turn_active');
		expect(warns[0]).toContain('bodyMessage=a turn is running');
		client.close();
	});

	it('watchSessionUsageCommits streams commit ids and ends done', async () => {
		const { cli, setup } = rigWithStreams();
		cli.watchSessionUsageCommits.mockImplementationOnce(() =>
			(async function* () {
				yield 'commit-1';
				yield 'commit-2';
			})(),
		);
		const { hub } = await setup();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		const streamId = await openSendStream(hub, client, [], undefined, 'watchSessionUsageCommits');
		void streamId;
		const first = await client.waitFor((candidate) => isStreamFrame(candidate));
		expect(first).toMatchObject({ type: 'stream.frame', seq: 1, frame: 'commit-1' });
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ reason: 'done' });
		client.close();
	});

	it('credit gating: no credit → pause (source NOT pulled), credit → resume', async () => {
		const { cli, setup } = rigWithStreams();
		let pulled = 0;
		const source = (async function* () {
			for (let index = 0; index < 6; index += 1) {
				pulled += 1;
				yield { type: 'message_delta', seq: index };
			}
		})();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source }));
		const { hub } = await setup({ defaultStreamCredit: 2 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		await openSendStream(hub, client);
		// Exactly the initial credit is pulled and delivered; the producer is
		// NOT drained ahead of the client's budget (pause, not growth).
		const seen: number[] = [];
		const first = await client.waitFor((candidate) => isStreamFrame(candidate));
		seen.push(first.seq);
		const second = await client.waitFor((candidate) => isStreamFrame(candidate));
		seen.push(second.seq);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(pulled).toBe(2);
		expect(seen).toEqual([1, 2]);
		// One credit unblocks exactly one more frame.
		client.send({ type: 'stream.credit', streamId: 's1', frames: 1 });
		const third = await client.waitFor((candidate) => isStreamFrame(candidate));
		expect(third.seq).toBe(3);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(pulled).toBe(3);
		// Finish the stream.
		client.send({ type: 'stream.credit', streamId: 's1', frames: 99 });
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ reason: 'done' });
		client.close();
	});

	it('credits are per-stream: two streams do not mix seqs or budgets', async () => {
		const { cli, setup } = rigWithStreams();
		cli.sendMessage.mockImplementation((...args: unknown[]) => {
			const req = args[0] as CliSendMessageReq;
			return Promise.resolve({ ok: true, source: turnFrames(req.id === 'sess-1' ? 2 : 3) });
		});
		const { hub } = await setup();
		const client = attachClient(hub, 'a');
		await helloV2(client);
		const s1 = await openSendStream(hub, client, [{ id: 'sess-1', message: 'one' }]);
		const s2 = await openSendStream(hub, client, [{ id: 'sess-2', message: 'two' }]);
		// Drain both to completion, interleaved on one connection: turnFrames(n)
		// yields n deltas + status + [DONE] → n+2 frames each.
		const seen: Record<string, number[]> = { [s1]: [], [s2]: [] };
		const ends: Record<string, string | undefined> = { [s1]: undefined, [s2]: undefined };
		while (!(ends[s1] && ends[s2])) {
			const frame = await client.waitFor((candidate) => isStreamFrame(candidate) || isStreamEnd(candidate));
			if (frame.type === 'stream.end') {
				ends[frame.streamId] = frame.reason;
				continue;
			}
			seen[frame.streamId]?.push(frame.seq);
		}
		expect(seen[s1]).toEqual([1, 2, 3, 4]);
		expect(seen[s2]).toEqual([1, 2, 3, 4, 5]);
		expect(ends[s1]).toBe('done');
		expect(ends[s2]).toBe('done');
		client.close();
	});
});

describe('detach / abort (I-DETACH, W0 F3)', () => {
	it('cancel{detach}: client stops receiving, the source keeps draining to done', async () => {
		const { cli, setup } = rigWithStreams();
		let pulled = 0;
		let finished = false;
		const source = (async function* () {
			for (let index = 0; index < 50; index += 1) {
				pulled += 1;
				yield { type: 'message_delta', seq: index };
			}
			finished = true;
		})();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source }));
		const { hub } = await setup({ defaultStreamCredit: 1000 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		await openSendStream(hub, client);
		await client.waitFor((candidate) => isStreamFrame(candidate));
		client.send({ type: 'stream.cancel', streamId: 's1', mode: 'detach' });
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ streamId: 's1', reason: 'detached', resumable: true });
		// The daemon keeps consuming the source into the null sink (I-DETACH).
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(finished).toBe(true);
		expect(pulled).toBe(50);
		// And nothing more reaches the detached client.
		const afterCount = client.received.filter(isStreamFrame).length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(client.received.filter(isStreamFrame)).toHaveLength(afterCount);
		client.close();
	});

	it('a frame pulled while cancel lands NEVER overtakes the terminal stream.end', async () => {
		const { cli, setup } = rigWithStreams();
		// The pump must be parked INSIDE source.next() when the cancel arrives
		// — the ordinary mid-turn cancellation shape. The stale-flag bug
		// delivered the parked frame AFTER the detach's terminal stream.end.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parked = false;
		const source = (async function* () {
			yield { type: 'message_delta', seq: 0 }; // reaches the client
			parked = true;
			await gate; // pump hangs here while `stream.cancel` is in flight
			yield { type: 'message_delta', seq: 1 }; // must be dropped (null sink)
		})();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source }));
		const { hub } = await setup({ defaultStreamCredit: 1000 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		const streamId = await openSendStream(hub, client);
		const first = await client.waitFor((candidate) => isStreamFrame(candidate));
		expect(first).toMatchObject({ streamId, seq: 1 });
		for (let attempt = 0; attempt < 100 && !parked; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(parked).toBe(true);
		client.send({ type: 'stream.cancel', streamId, mode: 'detach' });
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ streamId, reason: 'detached', resumable: true });
		// received is a CONSUMING queue — record the wire order as observed.
		const wireOrder = ['frame#1', 'stream.end'];
		release(); // the parked frame becomes available only AFTER the terminal
		await new Promise((resolve) => setTimeout(resolve, 50));
		// With no waiter pending, anything delivered now stays in the queue —
		// the stale-flag bug would append `frame#2` here.
		for (const frame of client.received) {
			if (isStreamFrame(frame)) wireOrder.push(`frame#${String(frame.seq)}`);
		}
		expect(wireOrder).toEqual(['frame#1', 'stream.end']);
		client.close();
	});

	it('cancel{abort}: explicit abortSession fires with the stream session (W0 F3)', async () => {
		const { cli, setup } = rigWithStreams();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source: turnFrames(100) }));
		const { hub } = await setup({ defaultStreamCredit: 1000 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		await openSendStream(hub, client, [{ id: 'sess-abort', message: 'long turn' }]);
		await client.waitFor((candidate) => isStreamFrame(candidate));
		client.send({ type: 'stream.cancel', streamId: 's1', mode: 'abort' });
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ streamId: 's1', reason: 'aborted', resumable: true });
		// The abort is EXPLICIT abortSession on the stream's session — the
		// runtime never reads a per-call signal (W0 F3).
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(cli.abortSession).toHaveBeenCalledTimes(1);
		const abortArgs = (cli.abortSession as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(abortArgs?.[0]).toMatchObject({ id: 'sess-abort', reason: 'stream_cancel' });
		client.close();
	});

	it('cancel is idempotent: a second cancel of the same stream is a no-op', async () => {
		const { cli, setup } = rigWithStreams();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source: turnFrames(10) }));
		const { hub } = await setup({ defaultStreamCredit: 100 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		await openSendStream(hub, client);
		await client.waitFor((candidate) => isStreamFrame(candidate));
		client.send({ type: 'stream.cancel', streamId: 's1', mode: 'abort' });
		const firstEnd = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(firstEnd.reason).toBe('aborted');
		client.send({ type: 'stream.cancel', streamId: 's1', mode: 'abort' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(cli.abortSession).toHaveBeenCalledTimes(1);
		// Only ONE end frame ever reached the client (the waitFor consumed it;
		// the retried cancel produced no second one).
		expect(client.received.filter(isStreamEnd)).toHaveLength(0);
		client.close();
	});

	it('client disconnect: streams detach silently and the source drains (turn survives)', async () => {
		const { cli, setup } = rigWithStreams();
		let finished = false;
		let release!: () => void;
		const turnBody = new Promise<void>((resolve) => {
			release = resolve;
		});
		const source = (async function* () {
			for (let index = 0; index < 20; index += 1) {
				yield { type: 'message_delta', seq: index };
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			await turnBody; // parked mid-turn until the test releases it
			finished = true;
		})();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source }));
		const { hub } = await setup({ defaultStreamCredit: 1000 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		await openSendStream(hub, client);
		await client.waitFor((candidate) => isStreamFrame(candidate));
		// Wave 2 forensics (verdict §2.2г): a connection dying with live
		// streams leaves ONE WARN — the trace the incident never had.
		const stderrSpy = vi.spyOn(process.stderr, 'write');
		// Let the sibling tests' pending closes flush BEFORE the baseline, so
		// only this test's disconnect is measured.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const baseline = stderrSpy.mock.calls.length;
		client.close(); // the window dies mid-turn
		const disconnectWarns = () =>
			stderrSpy.mock.calls
				.slice(baseline)
				.map(([chunk]) => String(chunk))
				.filter((line) => line.includes('disconnect-with-live-streams'));
		for (let attempt = 0; attempt < 50 && disconnectWarns().length === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(disconnectWarns()).toHaveLength(1);
		expect(disconnectWarns()[0]).toContain('mcode:rpc');
		expect(disconnectWarns()[0]).toContain('streams=["s1"]');
		expect(disconnectWarns()[0]).toContain('sessionIds=["sess-1"]');
		// Release the parked turn: the daemon keeps draining it (I-DETACH).
		release();
		await new Promise((resolve) => setTimeout(resolve, 120));
		// The daemon finished consuming the source: the turn is NOT aborted.
		expect(finished).toBe(true);
		stderrSpy.mockRestore();
	});
});

describe('stream-end forensics WARN (verdict §2.2г)', () => {
	type StderrSpy = { mock: { calls: Array<readonly unknown[]> } };
	function warnLines(spy: StderrSpy): string[] {
		return spy.mock.calls
			.map(([chunk]) => String(chunk))
			.filter((line) => line.includes('stream-end') && line.includes('mcode:rpc'));
	}

	it('a cancel{detach} writes ONE stream-end WARN with the stream identity, and the drain-end stays quiet', async () => {
		const { cli, setup } = rigWithStreams();
		let release!: () => void;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const source = (async function* () {
			yield { type: 'message_delta', seq: 0 };
			await parked; // still running when the cancel arrives
			for (let index = 1; index < 50; index += 1) {
				yield { type: 'message_delta', seq: index };
			}
		})();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source }));
		const { hub } = await setup({ defaultStreamCredit: 1000 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		await openSendStream(hub, client, [{ id: 'sess-warn-detach', message: 'long' }]);
		await client.waitFor((candidate) => isStreamFrame(candidate));
		const stderrSpy = vi.spyOn(process.stderr, 'write');
		// Baseline after the sibling tests' pending closes flush.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const baseline = stderrSpy.mock.calls.length;
		client.send({ type: 'stream.cancel', streamId: 's1', mode: 'detach' });
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ reason: 'detached', resumable: true });
		// The detached drain runs to its natural done — no second WARN.
		release();
		await new Promise((resolve) => setTimeout(resolve, 80));
		const scoped = warnLines(stderrSpy).slice(baseline);
		expect(scoped).toHaveLength(1);
		expect(scoped[0]).toContain('reason=detached');
		expect(scoped[0]).toContain('method=sendMessage');
		expect(scoped[0]).toContain('streamId=s1');
		expect(scoped[0]).toContain('sinkBytes=0');
		stderrSpy.mockRestore();
		client.close();
	});

	it('a source fault (doFinish error) writes the stream-end WARN', async () => {
		const { cli, setup } = rigWithStreams();
		let explode!: (error: Error) => void;
		const fault = new Promise<never>((_resolve, reject) => {
			explode = reject;
		});
		const source = (async function* () {
			yield { type: 'message_delta', seq: 0 };
			await fault; // the pump parks here until the test fires the fault
			yield { type: 'message_delta', seq: 1 };
		})();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source }));
		const { hub } = await setup({ defaultStreamCredit: 1000 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		await openSendStream(hub, client);
		const stderrSpy = vi.spyOn(process.stderr, 'write');
		// Baseline after the sibling tests' pending closes flush.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const baseline = stderrSpy.mock.calls.length;
		explode(new Error('the turn source exploded'));
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ reason: 'error', resumable: true });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const scoped = warnLines(stderrSpy).slice(baseline);
		expect(scoped.filter((line) => line.includes('reason=error'))).toHaveLength(1);
		expect(scoped[0]).toContain('streamId=s1');
		stderrSpy.mockRestore();
		client.close();
	});

	it('a natural done end writes NO stream-end WARN', async () => {
		const { cli, setup } = rigWithStreams();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source: turnFrames(2) }));
		const { hub } = await setup({ defaultStreamCredit: 1000 });
		const client = attachClient(hub, 'a');
		await helloV2(client);
		const stderrSpy = vi.spyOn(process.stderr, 'write');
		// Baseline after the sibling tests' pending closes flush.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const baseline = stderrSpy.mock.calls.length;
		await openSendStream(hub, client);
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ reason: 'done' });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(warnLines(stderrSpy).slice(baseline)).toEqual([]);
		stderrSpy.mockRestore();
		client.close();
	});
});

describe('congestion + detach-sink (§4.3.5)', () => {
  it('preserves a source failure waiting behind congestion when fresh credit arrives', async () => {
    const { cli, setup } = rigWithStreams();
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const source = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        reads += 1;
        if (reads === 1) return { done: false as const, value: { first: true } };
        if (reads === 2) { await gate; return { done: false as const, value: { second: true } }; }
        if (reads === 3) throw new Error('SSE subscriber overflow');
        return { done: true as const, value: undefined };
      },
    };
    cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source }));
    const { hub } = await setup({ defaultStreamCredit: 100 });
    const { client, serverTransport } = attachCongestibleClient(hub, 'fault-credit');
    await helloV2(client);
    const streamId = await openSendStream(hub, client);
    await client.waitFor(isStreamFrame);
    serverTransport.setCongested(true);
    release();
    await vi.waitFor(() => expect(reads).toBe(3));
    client.send({ type: 'stream.credit', streamId, frames: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    serverTransport.setCongested(false);
    const end = await client.waitFor(isStreamEnd);
    expect(end).toMatchObject({ reason: 'error', resumable: true, error: 'SSE subscriber overflow' });
    expect(reads).toBe(3);
    client.close();
  });

	it('congested connection: frames wait in the bounded sink; drain flushes in order', async () => {
		const { cli } = rigWithStreams();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source: turnFrames(6) }));
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => cli }),
			defaultStreamCredit: 100,
		});
		const { client, serverTransport } = attachCongestibleClient(hub, 'slow');
		await helloV2(client);
		await openSendStream(hub, client);
		const seen: number[] = [];
		const first = await client.waitFor((candidate) => isStreamFrame(candidate) || isStreamEnd(candidate));
		if (first.type === 'stream.frame') seen.push(first.seq);
		// Congest AFTER the first frame: the pump buffers into the bounded
		// sink instead of writing (one frame already in flight is legal).
		serverTransport.setCongested(true);
		await new Promise((resolve) => setTimeout(resolve, 60));
		// NOT the whole turn leaked through: the sink held the rest.
		expect(client.received.filter(isStreamFrame).length).toBeLessThan(7);
		// Drain: the sink flushes in order and the stream runs to done.
		serverTransport.setCongested(false);
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ reason: 'done' });
		const all = [...seen, ...client.received.filter(isStreamFrame).map((frame) => frame.seq)];
		expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // turnFrames(6) = 8 frames, ordered
		client.close();
	});

	it('sink overflow detaches the stream (resumable) while the source keeps draining', async () => {
		const { cli } = rigWithStreams();
		let finished = false;
		const source = (async function* () {
			for (let index = 0; index < 500; index += 1) {
				yield { type: 'message_delta', seq: index, text: 'x'.repeat(64) };
			}
			finished = true;
		})();
		cli.sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true, source }));
		const { hub } = await setupHub({
			bridge: new CliBridge({ cliService: () => cli }),
			defaultStreamCredit: 10_000,
			streamSinkMaxBytes: 256, // tiny: overflow happens quickly
		});
		const { client, serverTransport } = attachCongestibleClient(hub, 'hung');
		await helloV2(client);
		await openSendStream(hub, client);
		await client.waitFor((candidate) => isStreamFrame(candidate));
		serverTransport.setCongested(true); // the window froze
		const end = await client.waitFor((candidate) => isStreamEnd(candidate));
		expect(end).toMatchObject({ streamId: 's1', reason: 'detached', resumable: true });
		// Daemon memory stays bounded even though the source runs on…
		await new Promise((resolve) => setTimeout(resolve, 50));
		// …to completion (I-DETACH: the hung window never aborts the turn).
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(finished).toBe(true);
		serverTransport.setCongested(false);
		client.close();
	});
});
