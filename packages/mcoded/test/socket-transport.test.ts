/**
 * `SocketLineTransport` framing over a real unix socket: one delivered line
 * per written frame and no empty lines between frames.
 *
 * Regression: `serializeFrame` used to append a trailing newline that
 * `SocketLineTransport.write` added again, so every frame crossed the wire as
 * `…}\n\n` — the peer read an empty line after each frame, `parseFrame('')`
 * answered every real frame with a spurious
 * `protocol error: frame is not valid JSON` response. The in-memory pair
 * passes lines through verbatim, so only a real socket reproduces it.
 *
 * Skipped on Windows (no unix sockets).
 *
 * @module
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { serializeFrame, type ServerFrame } from '../src/protocol.js';
import { SocketLineTransport } from '../src/socket-transport.js';
import { connectClient, hello, setupHub, waitForResponse, waitForSuccess } from './helpers.js';

const unixSockets = process.platform !== 'win32';
const describeSocket = unixSockets ? describe : describe.skip;

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** Fresh per-test socket path under a cleaned-up temp dir. */
function freshSocketPath(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return path.join(dir, 'wire.sock');
}

interface SocketTransportPair {
	/** Server-side end: writes frames exactly the way `RpcConnection.send` does. */
	server: SocketLineTransport;
	/** Client-side end reading raw lines off the wire. */
	client: SocketLineTransport;
	/** Tear both ends and the listener down. */
	close(): Promise<void>;
}

/** Two `SocketLineTransport`s joined by a real unix-domain socket. */
async function socketPair(socketPath: string): Promise<SocketTransportPair> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));

	const clientSocket = net.connect(socketPath);
	const serverSocket = await new Promise<net.Socket>((resolve) => {
		server.once('connection', (socket) => resolve(socket));
	});
	await new Promise<void>((resolve) => clientSocket.once('connect', () => resolve()));

	return {
		server: new SocketLineTransport(serverSocket),
		client: new SocketLineTransport(clientSocket),
		close: async () => {
			clientSocket.destroy();
			serverSocket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describeSocket('SocketLineTransport framing (real unix socket)', () => {
	it('delivers exactly one line per frame — no empty line after any frame', async () => {
		const { server, client, close } = await socketPair(freshSocketPath('mcoded-socktrans-'));

		// The exact composition RpcConnection.send performs: serializeFrame
		// output straight into transport.write.
		const bye: ServerFrame = { type: 'bye', reason: 'done' };
		const gap: ServerFrame = { type: 'replay_gap', after: '2', head: '7' };
		server.write(serializeFrame(bye));
		server.write(serializeFrame(gap));

		const lines = client.lines();
		const first = await lines.next();
		expect(first.done).toBe(false);
		expect(first.value).toBe(JSON.stringify(bye));
		const second = await lines.next();
		expect(second.done).toBe(false);
		expect(second.value).toBe(JSON.stringify(gap));

		// A duplicated newline on the wire surfaces as an empty ('') line here
		// before end-of-stream.
		server.end();
		const tail = await lines.next();
		expect(tail.done).toBe(true);

		await close();
	});

	it('serves the hub wire with no spurious protocol-error responses', async () => {
		const socketPath = freshSocketPath('mcoded-sockhub-');
		const { hub } = await setupHub();
		// The daemon's exact wiring (daemon.ts attachConnections): every
		// accepted socket becomes a SocketLineTransport on the hub.
		const server = net.createServer((socket) => {
			hub.attachTransport(new SocketLineTransport(socket));
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		const client = await connectClient(socketPath, 'framing-client');
		await hello(client);
		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		client.send({ type: 'prompt', id: 'sock-1', message: 'over the socket' });
		const events = await client.events(4);
		expect(events.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);
		await waitForSuccess(client, (frame) => frame.command === 'prompt');

		// Every daemon frame was a real response or event. The predicate-based
		// waitFor* helpers re-queue whatever they skip, so the double-newline
		// bug (one 'protocol error: frame is not valid JSON' response per
		// frame, client and server side alike) would be left behind here.
		expect(client.received).toEqual([]);

		client.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await hub.shutdown();
	});
});
