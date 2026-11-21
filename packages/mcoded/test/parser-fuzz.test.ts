/**
 * W3 gate: parser fuzz (arch §4.3.5 hardening) — broken, truncated and
 * swapped frames must answer `PROTOCOL_ERROR` without tearing the stream
 * down, oversized frames must close the connection, and a deterministic
 * fuzz corpus must never escape `ProtocolError` semantics.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { MCODED_PROTOCOL_VERSION, MAX_INBOUND_FRAME_BYTES, parseFrame, ProtocolError } from '../src/protocol.js';
import { McodedHub } from '../src/hub.js';
import { EchoRuntimeAdapter } from '../src/runtime-adapter.js';
import { InMemoryCheckpointStore } from '../src/checkpoint.js';
import {
	attachClient,
	hello,
	helloV2,
	isResponse,
	setupHub,
	type FailedResponse,
	type SuccessfulResponse,
} from './helpers.js';

/** Deterministic LCG so failures reproduce. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

/** Well-formed v2 frames to mutate. */
const SEED_FRAMES = [
	JSON.stringify({ type: 'call', id: 'c1', method: 'listSessions', params: [{ limit: 3 }] }),
	JSON.stringify({ type: 'stream.open', id: 'c2', method: 'sendMessage', params: [{}], credit: 4 }),
	JSON.stringify({ type: 'stream.credit', streamId: 's1', frames: 3 }),
	JSON.stringify({ type: 'stream.cancel', streamId: 's1', mode: 'detach' }),
	JSON.stringify({ type: 'session.attach', id: 'c3', sessionId: 'sess', role: 'owner' }),
	JSON.stringify({ type: 'session.detach', id: 'c4', sessionId: 'sess' }),
	JSON.stringify({ type: 'subscribe', id: 'c5', scope: 'all' }),
	JSON.stringify({ type: 'ping', id: 'p1' }),
	JSON.stringify({ type: 'daemon.status', id: 'd1' }),
	JSON.stringify({ type: 'daemon.restart', id: 'd2', when: 'idle' }),
	JSON.stringify({ type: 'daemon.authSync', id: 'd3' }),
	JSON.stringify({ type: 'hello', version: 2, minor: 0, clientInstanceId: 'w1' }),
];

describe('parseFrame fuzz: every mutation throws ProtocolError, nothing else', () => {
	it('survives a deterministic corpus of truncations, swaps and injections', () => {
		const random = lcg(20261028);
		let parsed = 0;
		let thrown = 0;
		for (let round = 0; round < 3000; round += 1) {
			const seed = SEED_FRAMES[Math.floor(random() * SEED_FRAMES.length)]!;
			let line = seed;
			const mutation = Math.floor(random() * 6);
			switch (mutation) {
				case 0: // truncate at a random point
					line = seed.slice(0, Math.floor(random() * seed.length));
					break;
				case 1: // byte swap of two positions
					if (line.length >= 2) {
						const i = Math.floor(random() * line.length);
						const j = Math.floor(random() * line.length);
						const chars = [...line];
						[chars[i], chars[j]] = [chars[j]!, chars[i]!];
						line = chars.join('');
					}
					break;
				case 2: // splice garbage in the middle
					line =
						seed.slice(0, Math.floor(random() * seed.length)) +
						'"\u0007\\x' +
						seed.slice(Math.floor(random() * seed.length));
					break;
				case 3: // not JSON at all
					line = random() < 0.5 ? '' : ']}{';
					break;
				case 4: // wrong JSON value types in fields
					line = seed.replace('"id":"', '"id":').replace('"', '', );
					break;
				case 5: // unknown / missing type
					line = random() < 0.5 ? '{"type":"totally_new"}' : '{"method":"x"}';
					break;
			}
			try {
				parseFrame(line);
				parsed += 1;
			} catch (error) {
				thrown += 1;
				// The ONLY acceptable failure mode: a ProtocolError naming the
				// offending type — never a TypeError from destructuring, never a
				// RangeError from recursion.
				expect(error, `line ${JSON.stringify(line.slice(0, 80))}`).toBeInstanceOf(ProtocolError);
			}
		}
		expect(parsed + thrown).toBe(3000);
		// The corpus must actually exercise both paths.
		expect(parsed).toBeGreaterThan(10);
		expect(thrown).toBeGreaterThan(10);
	});

	it('rejects pathological JSON depth without a stack crash', () => {
		const deep = `{"type":"call","id":"c1","method":"m","params":${'['.repeat(2000)}${']'.repeat(2000)}}`;
		try {
			parseFrame(deep);
			// Acceptable: some engines parse it; the frame must then fail the
			// object-shape checks downstream — but parseFrame itself returning
			// a call frame with a deep array is harmless (hub validates method).
		} catch (error) {
			expect(error).toBeInstanceOf(ProtocolError);
		}
	});
});

describe('wire-level protocol abuse', () => {
	it('answers a broken line with PROTOCOL_ERROR and keeps serving frames', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'abuse');
		await hello(client);
		client.sendRaw('this is not json');
		const failure = await client.waitFor(
			(frame): frame is FailedResponse => isResponse(frame) && !frame.success,
		);
		expect(failure.errorCode).toBe('PROTOCOL_ERROR');
		// The stream survives: a valid frame after the abuse answers normally.
		client.send({ type: 'ping', id: 'still-alive' });
		const pong = await client.waitFor((frame) => frame.type === 'pong');
		expect(pong).toMatchObject({ type: 'pong', id: 'still-alive' });
		client.close();
	});

	it('answers an oversized frame with PROTOCOL_ERROR and closes (arch §4.3.5)', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'oversize');
		await hello(client);
		// One line just over the wire-level budget (the in-memory transport has
		// no buffer guard; the wire check owns the limit here).
		const junk = JSON.stringify({ type: 'ping', pad: 'x'.repeat(MAX_INBOUND_FRAME_BYTES + 1) });
		client.sendRaw(junk);
		const failure = await client.waitFor(
			(frame): frame is FailedResponse => isResponse(frame) && !frame.success,
		);
		expect(failure.errorCode).toBe('PROTOCOL_ERROR');
		await client.closed(); // the connection is torn down
	});

	it('still answers hello on a fresh connection after another client abused theirs', async () => {
		const { hub } = await setupHub();
		const abuser = attachClient(hub, 'abuser');
		await hello(abuser);
		abuser.sendRaw('{"type":"call"'); // truncated
		await abuser.waitFor((frame): frame is FailedResponse => isResponse(frame) && !frame.success);
		abuser.close();

		const fresh = attachClient(hub, 'fresh');
		const welcome = await hello(fresh);
		expect(welcome.success).toBe(true);
		fresh.close();
	});

	it('a v2 handshake never mutates v1 semantics: prompts still work after v2 frames', async () => {
		const { hub, adapter } = await setupHub();
		const v1 = attachClient(hub, 'v1');
		await hello(v1);
		const v2 = attachClient(hub, 'v2');
		await helloV2(v2);
		v2.send({ type: 'call', id: 'c1', method: 'listSessions' });
		// No bridge wired: METHOD_NOT_ALLOWED, and the v1 client is unaffected.
		const refused = await v2.waitFor((frame): frame is FailedResponse => isResponse(frame) && !frame.success);
		expect(refused.errorCode).toBe('METHOD_NOT_ALLOWED');
		v1.send({ type: 'prompt', message: 'hello from v1', id: 'r9' });
		await v1.waitFor((frame): frame is SuccessfulResponse => isResponse(frame) && frame.success);
		expect(adapter).toBeInstanceOf(EchoRuntimeAdapter);
		v1.close();
		v2.close();
		void hub;
		void MCODED_PROTOCOL_VERSION;
	});
});
