/**
 * The W10 product replay/cursor semantics: the durable event log behind the
 * replay window (append, bounded tail load, torn-line tolerance, rotation),
 * replay ACROSS a daemon restart, bounded pagination of the `events` attach,
 * and request-id dedup for retried mutations — plus the `MCODED_RUNTIME`
 * hybrid-default resolution. All over the in-memory transport and temporary
 * directories; no sockets, no live runtime.
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { FileCheckpointStore, InMemoryCheckpointStore } from '../src/checkpoint.js';
import { MCODED_EVENT_LOG_BASENAME, FileEventLog, type EventLog } from '../src/event-log.js';
import { McodedHub } from '../src/hub.js';
import { DEFAULT_REPLAY_LIMITS, ReplayRing, type ReplayFrame } from '../src/replay-ring.js';
import { EchoRuntimeAdapter } from '../src/runtime-adapter.js';
import { McodedRuntimeConfigError, resolveMcodedRuntimeKind } from '../src/runtime-kind.js';
import {
	TestClient,
	attachClient,
	hello,
	isReplayGap,
	setupHub,
	waitForFailure,
	waitForResponse,
	waitForSuccess,
} from './helpers.js';

const tempRoots: string[] = [];

beforeEach(() => {
	tempRoots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcoded-event-log-')));
});

afterAll(() => {
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function tempFile(name: string): string {
	const root = tempRoots[tempRoots.length - 1];
	if (!root) throw new Error('no temp root');
	return path.join(root, name);
}

function event(name: string): unknown {
	return { type: 'message_delta', text: name };
}

function frame(cursor: string, name: string): ReplayFrame {
	return { cursor, event: event(name), bytes: JSON.stringify(event(name)).length };
}

describe('FileEventLog', () => {
	it('appends frames and loads the tail oldest-first', async () => {
		const log = new FileEventLog(tempFile('events.jsonl'));
		await log.append(frame('1', 'a'));
		await log.append(frame('2', 'b'));
		await log.append(frame('3', 'c'));

		const tail = await log.loadTail(DEFAULT_REPLAY_LIMITS);
		expect(tail.map((f) => f.cursor)).toEqual(['1', '2', '3']);
		expect(tail.map((f) => (f.event as { text: string }).text)).toEqual(['a', 'b', 'c']);
		// Frames are re-measured on load, so the ring's byte budget holds.
		expect(tail.every((f) => f.bytes > 0)).toBe(true);
	});

	it('tolerates a torn final line (crash mid-append) and skips corrupt interior lines', async () => {
		const file = tempFile('torn.jsonl');
		const good = (cursor: string) =>
			`${JSON.stringify({ cursor, event: event(`e${cursor}`) })}\n`;
		// Line 2 is a complete but corrupt interior line; the file tail is a
		// torn write of cursor 4 (no trailing newline).
		fs.writeFileSync(
			file,
			good('1') + 'not-json-at-all\n' + good('3') + '{"cursor":"4","event":{"ty',
			'utf8',
		);

		const log = new FileEventLog(file);
		const tail = await log.loadTail(DEFAULT_REPLAY_LIMITS);
		// The torn write is not durable history; intact lines survive.
		expect(tail.map((f) => f.cursor)).toEqual(['1', '3']);
	});

	it('honors the frame and byte budgets of the tail load', async () => {
		const log = new FileEventLog(tempFile('bounded.jsonl'));
		for (let index = 1; index <= 10; index += 1) {
			await log.append(frame(String(index), 'x'.repeat(64)));
		}
		const tail = await log.loadTail({ maxFrames: 3, maxBytes: 1024 * 1024 });
		expect(tail.map((f) => f.cursor)).toEqual(['8', '9', '10']);
	});

	it('compacts atomically to exactly the retained window', async () => {
		const file = tempFile('compact.jsonl');
		const log = new FileEventLog(file);
		for (let index = 1; index <= 5; index += 1) await log.append(frame(String(index), 'y'));
		const retained = (await log.loadTail(DEFAULT_REPLAY_LIMITS)).slice(-2);
		await log.compact(retained);

		const raw = fs.readFileSync(file, 'utf8');
		expect(raw.trimEnd().split('\n')).toHaveLength(2);
		expect((await log.loadTail(DEFAULT_REPLAY_LIMITS)).map((f) => f.cursor)).toEqual(['4', '5']);
	});

	it('rotates the file once it crosses the grow cap, keeping the retention window', async () => {
		const file = tempFile('rotating.jsonl');
		const smallWindow = { maxFrames: 4, maxBytes: 1024 * 1024 };
		const log = new FileEventLog(file, { limits: smallWindow, maxFileBytes: 256 });
		for (let index = 1; index <= 40; index += 1) {
			await log.append(frame(String(index), 'z'.repeat(48)));
		}
		const stat = fs.statSync(file);
		expect(stat.size).toBeLessThan(40 * 64);
		const tail = await log.loadTail(smallWindow);
		expect(tail.map((f) => f.cursor)).toEqual(['37', '38', '39', '40']);
	});
});

describe('replay across a restart (durable event log)', () => {
	it('seeds the ring from the event log so a reconnect replays across the restart', async () => {
		const root = tempRoots[tempRoots.length - 1];
		if (!root) throw new Error('no temp root');
		const eventLog = new FileEventLog(path.join(root, MCODED_EVENT_LOG_BASENAME));

		const first = new McodedHub({
			adapter: new EchoRuntimeAdapter(),
			checkpoint: new FileCheckpointStore(path.join(root, 'mcoded-checkpoint.json')),
			eventLog,
		});
		await first.start();
		const client = attachClient(first, 'a');
		await hello(client);
		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		client.send({ type: 'prompt', message: 'turn one' });
		const live = await client.events(4);
		expect(live.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);
		await first.shutdown();

		// Second daemon life: ring empty, log durable. A reconnecting client
		// with an explicit anchor replays the pre-restart events.
		const second = new McodedHub({
			adapter: new EchoRuntimeAdapter(),
			checkpoint: new FileCheckpointStore(path.join(root, 'mcoded-checkpoint.json')),
			eventLog,
		});
		await second.start();

		const reconnected = attachClient(second, 'b');
		await hello(reconnected);
		reconnected.send({ type: 'events', after: '2' });
		const attachResponse = await waitForSuccess(
			reconnected,
			(frame) => frame.command === 'events',
		);
		expect(attachResponse.data).toMatchObject({ replayed: 2, head: '4' });
		const replayed = await reconnected.events(2);
		expect(replayed.map((frame) => frame.cursor)).toEqual(['3', '4']);

		// New live events continue the durable sequence — never reuse cursors.
		const secondClient = attachClient(second, 'c');
		await hello(secondClient);
		secondClient.send({ type: 'events' });
		const attachC = await waitForSuccess(secondClient, (frame) => frame.command === 'events');
		expect(attachC.data).toMatchObject({ replayed: 4, head: '4' });
		// Consume the replayed pre-restart window first.
		await secondClient.events(4);
		secondClient.send({ type: 'prompt', message: 'turn two' });
		const nextLife = await secondClient.events(4);
		expect(nextLife.map((frame) => frame.cursor)).toEqual(['5', '6', '7', '8']);
		expect(second.head).toBe('8');
		await second.shutdown();
	});

	it('keeps cursors unique even when the checkpoint write was lost (log holds the line)', async () => {
		const root = tempRoots[tempRoots.length - 1];
		if (!root) throw new Error('no temp root');
		const eventLog = new FileEventLog(path.join(root, MCODED_EVENT_LOG_BASENAME));

		const first = new McodedHub({
			adapter: new EchoRuntimeAdapter(),
			checkpoint: new InMemoryCheckpointStore(), // the crash lost the checkpoint
			eventLog,
		});
		await first.start();
		const client = attachClient(first, 'a');
		await hello(client);
		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		client.send({ type: 'prompt', message: 'seed' });
		await client.events(4);
		await first.shutdown();

		const second = new McodedHub({
			adapter: new EchoRuntimeAdapter(),
			checkpoint: new InMemoryCheckpointStore(),
			eventLog,
		});
		await second.start();
		expect(second.head).toBe('4');
		const reconnected = attachClient(second, 'b');
		await hello(reconnected);
		reconnected.send({ type: 'events' });
		const attachResponse = await waitForSuccess(
			reconnected,
			(frame) => frame.command === 'events',
		);
		expect(attachResponse.data).toMatchObject({ replayed: 4, head: '4' });
		await second.shutdown();
	});

	it('still answers replay_gap for cursors outside the seeded window', async () => {
		const root = tempRoots[tempRoots.length - 1];
		if (!root) throw new Error('no temp root');
		const eventLog = new FileEventLog(path.join(root, MCODED_EVENT_LOG_BASENAME), {
			limits: { maxFrames: 4, maxBytes: 1024 * 1024 },
		});

		const first = new McodedHub({
			adapter: new EchoRuntimeAdapter(),
			checkpoint: new InMemoryCheckpointStore(),
			eventLog,
			replayLimits: { maxFrames: 4 },
		});
		await first.start();
		const client = attachClient(first, 'a');
		await hello(client);
		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		for (const turn of ['one', 'two']) {
			client.send({ type: 'prompt', message: turn });
			await client.events(4);
		}
		await first.shutdown();

		const second = new McodedHub({
			adapter: new EchoRuntimeAdapter(),
			checkpoint: new InMemoryCheckpointStore(),
			eventLog,
			replayLimits: { maxFrames: 4 },
		});
		await second.start();
		const reconnected = attachClient(second, 'b');
		await hello(reconnected);
		reconnected.send({ type: 'events', after: '1' });
		const gap = await reconnected.waitFor(isReplayGap);
		expect(gap).toMatchObject({ type: 'replay_gap', after: '1', head: '8' });
		await second.shutdown();
	});

	it('serves the live stream even when the event log fails (loud degradation)', async () => {
		const failing: EventLog = {
			append: async () => {
				throw new Error('disk full');
			},
			loadTail: async () => [],
			compact: async () => undefined,
			flush: async () => undefined,
		};
		const { hub } = await setupHub({ eventLog: failing });
		const client = attachClient(hub, 'a');
		await hello(client);
		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		client.send({ type: 'prompt', message: 'still works' });
		const events = await client.events(4);
		expect(events.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);
	});
});

describe('bounded pagination of the events attach', () => {
	it('delivers at most limit frames and names the remaining count', async () => {
		const { hub } = await setupHub();
		const a = attachClient(hub, 'a');
		await hello(a);
		a.send({ type: 'events' });
		await waitForResponse(a, (frame) => frame.command === 'events');
		for (const turn of ['one', 'two']) {
			a.send({ type: 'prompt', message: turn });
			await a.events(4);
		}

		const pager = attachClient(hub, 'pager');
		await hello(pager);
		pager.send({ type: 'events', limit: 3 });
		const firstPage = await waitForSuccess(pager, (frame) => frame.command === 'events');
		expect(firstPage.data).toMatchObject({ replayed: 3, head: '8', remaining: 5 });
		const page = await pager.events(3);
		expect(page.map((frame) => frame.cursor)).toEqual(['1', '2', '3']);

		// Page forward from the newest delivered cursor.
		pager.send({ type: 'events', after: '3', limit: 3 });
		const secondPage = await waitForSuccess(pager, (frame) => frame.command === 'events');
		expect(secondPage.data).toMatchObject({ replayed: 3, head: '8', remaining: 2 });
		const page2 = await pager.events(3);
		expect(page2.map((frame) => frame.cursor)).toEqual(['4', '5', '6']);

		// The tail page leaves the client attached to the live stream.
		pager.send({ type: 'events', after: '6' });
		const lastPage = await waitForSuccess(pager, (frame) => frame.command === 'events');
		expect(lastPage.data).toMatchObject({ replayed: 2, head: '8' });
		// Consume the tail frames the attach delivered (7, 8).
		await pager.events(2);

		a.send({ type: 'prompt', message: 'live after paging' });
		const live = await pager.events(4);
		expect(live.map((frame) => frame.cursor)).toEqual(['9', '10', '11', '12']);
	});

	it('rejects a malformed limit with the protocol error code', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		await hello(client);
		client.sendRaw(JSON.stringify({ type: 'events', limit: 0 }));
		const failure = await waitForFailure(client, (frame) => frame.command === 'events');
		expect(failure.errorCode).toBe('PROTOCOL_ERROR');
		expect(hub.head).toBeNull();
	});
});

describe('request-id dedup', () => {
	it('answers a retried in-flight prompt once, without a second submission', async () => {
		let submissions = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = new EchoRuntimeAdapter();
		const hub = new McodedHub({
			adapter: {
				submit: async () => {
					submissions += 1;
					await gate;
					// The response is the observable outcome for this test; the
					// echo stream stays silent.
				},
				abort: () => adapter.abort(),
				events: adapter.events,
				stop: () => adapter.stop(),
			},
			checkpoint: new InMemoryCheckpointStore(),
		});
		await hub.start();

		const first = attachClient(hub, 'first');
		const retry = attachClient(hub, 'retry');
		await hello(first);
		await hello(retry);

		first.send({ type: 'prompt', id: 'req-1', message: 'turn' });
		// Give the hub a tick to record the in-flight request, then retry.
		await new Promise((resolve) => setTimeout(resolve, 10));
		retry.send({ type: 'prompt', id: 'req-1', message: 'turn' });

		release?.();
		const firstOutcome = await waitForResponse(first, (frame) => frame.command === 'prompt');
		const retryOutcome = await waitForResponse(retry, (frame) => frame.command === 'prompt');
		expect(firstOutcome.success).toBe(true);
		expect(retryOutcome.success).toBe(true);
		expect(retryOutcome.id).toBe('req-1');
		// Exactly ONE submission reached the runtime despite the retry.
		expect(submissions).toBe(1);
		await hub.shutdown();
	});

	it('replays the recorded failure for a retried rejected submission', async () => {
		let attempts = 0;
		const echo = new EchoRuntimeAdapter();
		const rejecting = {
			submit: async (): Promise<void> => {
				attempts += 1;
				throw new Error('runtime rejected prompt');
			},
			abort: async (): Promise<void> => {},
			events: echo.events,
			stop: (): void => echo.stop(),
		};
		const hub = new McodedHub({
			adapter: rejecting,
			checkpoint: new InMemoryCheckpointStore(),
		});
		await hub.start();
		const client = attachClient(hub, 'a');
		await hello(client);

		client.send({ type: 'prompt', id: 'req-x', message: 'fail' });
		const first = await waitForFailure(client, (frame) => frame.command === 'prompt');
		expect(first).toMatchObject({
			id: 'req-x',
			success: false,
			error: 'runtime rejected prompt',
			errorCode: 'RUNTIME_REJECTED',
		});

		client.send({ type: 'prompt', id: 'req-x', message: 'fail' });
		const retried = await waitForFailure(client, (frame) => frame.command === 'prompt');
		expect(retried).toEqual(first);
		// The retry must NOT have reached the runtime again.
		expect(attempts).toBe(1);
		await hub.shutdown();
	});
});

describe('daemon shutdown refusals carry the error code', () => {
	it('refuses commands during drain with DAEMON_SHUTTING_DOWN', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		await hello(client);
		const shutdown = hub.shutdown();
		client.send({ type: 'prompt', message: 'too late' });
		const failure = await waitForFailure(client, (frame) => frame.command === 'prompt');
		expect(failure.errorCode).toBe('DAEMON_SHUTTING_DOWN');
		await shutdown;
	});
});

describe('MCODED_RUNTIME resolution (hybrid default)', () => {
	it('defaults to the product runtime', () => {
		expect(resolveMcodedRuntimeKind({})).toBe('local-v2');
		expect(resolveMcodedRuntimeKind({ MCODED_RUNTIME: '' })).toBe('local-v2');
	});

	it('keeps the explicit legacy compatibility mode', () => {
		expect(resolveMcodedRuntimeKind({ MCODED_RUNTIME: 'echo' })).toBe('echo');
		expect(resolveMcodedRuntimeKind({ MCODED_RUNTIME: 'local-v2' })).toBe('local-v2');
	});

	it('fails closed on unknown values instead of silently downgrading', () => {
		expect(() => resolveMcodedRuntimeKind({ MCODED_RUNTIME: 'locl-v2' })).toThrowError(
			McodedRuntimeConfigError,
		);
		try {
			resolveMcodedRuntimeKind({ MCODED_RUNTIME: 'locl-v2' });
		} catch (error) {
			expect((error as McodedRuntimeConfigError).code).toBe('MCODED_RUNTIME_UNSUPPORTED');
			expect((error as Error).message).toContain('supported values');
		}
	});
});

describe('ReplayRing.seed', () => {
	it('seeds an empty ring and re-applies the window limits', () => {
		const ring = new ReplayRing({ maxFrames: 3, maxBytes: 1024 * 1024 });
		ring.seed([frame('1', 'a'), frame('2', 'b'), frame('3', 'c'), frame('4', 'd')]);
		expect(ring.oldest).toBe('2');
		expect(ring.head).toBe('4');
		expect(ring.size().frames).toBe(3);
		// Cursor 1 was evicted by the window — replay anchors after the oldest.
		const replay = ring.replayAfter('2');
		expect(replay.ok && replay.frames.map((f) => f.cursor)).toEqual(['3', '4']);
	});

	it('refuses seeding and rebasing after the first live append', () => {
		const ring = new ReplayRing();
		ring.append(event('a'));
		expect(() => ring.seed([frame('1', 'b')])).toThrowError(/first append/);
		expect(() => ring.resumeFrom(5)).toThrowError(/first append/);
	});
});
