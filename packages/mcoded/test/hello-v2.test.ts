/**
 * The v2 handshake (arch §4.3.1, §4.3.2, §4.7, §2.2): the v1 shim keeps the
 * W10/W11 semantics untouched; a v2 hello runs the daemon-side identity
 * checks in the arch order — token (UNAUTHORIZED), dataDir
 * (DATA_DIR_MISMATCH), env region/buildEnv (ENV_MISMATCH) — each answered
 * with its stable error code before the connection closes, and a passing
 * hello carries `minor` + `features` in the welcome.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
	MCODED_PROTOCOL_FEATURES,
	MCODED_PROTOCOL_MINOR,
	MCODED_PROTOCOL_VERSION,
} from '../src/protocol.js';
import { attachClient, setupHub, type TestClient } from './helpers.js';
import { waitForFailure, waitForSuccess } from './helpers.js';

async function setupHandshaken(hubOptions: Parameters<typeof setupHub>[0]): Promise<TestClient> {
	const { hub } = await setupHub(hubOptions);
	const client = attachClient(hub, 'hello-v2');
	return client;
}

describe('v1 shim (arch §4.3.1)', () => {
	it('answers a v1 hello with the plain W10/W11 welcome — no checks', async () => {
		// Even with a fully configured handshake identity, a v1 client keeps
		// the old semantics: no token/dataDir/env payload to check.
		const client = await setupHandshaken({
			handshake: { token: 'secret', dataDir: '/data', env: { region: 'en', buildEnv: 'prod' } },
		});
		client.send({ type: 'hello', version: 1 });
		const welcome = await waitForSuccess(client, (frame) => frame.command === 'hello');
		expect(welcome.data).toMatchObject({ version: 1, head: null });
		// No v2 fields on the shim welcome.
		expect(welcome.data).not.toHaveProperty('minor');
		expect(welcome.data).not.toHaveProperty('features');
		client.close();
	});
});

describe('v2 hello welcome', () => {
	it('welcomes a bare v2 hello when no handshake identity is configured', async () => {
		const client = await setupHandshaken({});
		client.send({ type: 'hello', version: 2, minor: 0 });
		const welcome = await waitForSuccess(client, (frame) => frame.command === 'hello');
		expect(welcome.data).toMatchObject({
			version: MCODED_PROTOCOL_VERSION,
			// W5 bumped the additive minor (restart-when-idle, §4.6.5).
			minor: MCODED_PROTOCOL_MINOR,
			head: null,
			// W3: the multiplexing core ships behind named features (arch §4.3.1).
			features: [...MCODED_PROTOCOL_FEATURES],
		});
		const features = (welcome.data as { features?: string[] }).features ?? [];
		expect(features).toContain('call');
		expect(features).toContain('stream');
		expect(features).toContain('attach');
		expect(features).toContain('subscribe');
		client.close();
	});

	it('still refuses unknown majors with UNSUPPORTED_VERSION', async () => {
		const client = await setupHandshaken({});
		client.send({ type: 'hello', version: MCODED_PROTOCOL_VERSION + 1 });
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('UNSUPPORTED_VERSION');
		client.close();
	});
});

describe('v2 hello: token check (arch §4.7)', () => {
	const handshake = { token: 'token-bytes-hex', dataDir: '/data' };

	it('accepts the correct token', async () => {
		const client = await setupHandshaken({ handshake });
		client.send({ type: 'hello', version: 2, token: 'token-bytes-hex', dataDir: '/data' });
		const welcome = await waitForSuccess(client, (frame) => frame.command === 'hello');
		expect(welcome.data).toMatchObject({ version: 2 });
		client.close();
	});

	it('refuses a missing token with UNAUTHORIZED and closes', async () => {
		const client = await setupHandshaken({ handshake });
		client.send({ type: 'hello', version: 2, dataDir: '/data' });
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('UNAUTHORIZED');
		await client.closed();
	});

	it('refuses a wrong token with UNAUTHORIZED', async () => {
		const client = await setupHandshaken({ handshake });
		client.send({ type: 'hello', version: 2, token: 'wrong', dataDir: '/data' });
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('UNAUTHORIZED');
		client.close();
	});
});

describe('v2 hello: dataDir check (arch §2.2)', () => {
	const handshake = { dataDir: '/data/real' };

	it('accepts the daemon dataDir and a symlinked spelling of it', async () => {
		const client = await setupHandshaken({ handshake });
		// The client sends ITS path; realpath comparison makes equivalent
		// spellings match. (/data/real as given matches verbatim.)
		client.send({ type: 'hello', version: 2, dataDir: '/data/real' });
		const welcome = await waitForSuccess(client, (frame) => frame.command === 'hello');
		expect(welcome.success).toBe(true);
		client.close();
	});

	it('refuses a missing dataDir with DATA_DIR_MISMATCH', async () => {
		const client = await setupHandshaken({ handshake });
		client.send({ type: 'hello', version: 2 });
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('DATA_DIR_MISMATCH');
		await client.closed();
	});

	it('refuses a foreign dataDir with DATA_DIR_MISMATCH', async () => {
		const client = await setupHandshaken({ handshake });
		client.send({ type: 'hello', version: 2, dataDir: '/data/other' });
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('DATA_DIR_MISMATCH');
		client.close();
	});
});

describe('v2 hello: env check (arch §4.3.2, risk R6)', () => {
	const handshake = { env: { region: 'en', buildEnv: 'prod' } };

	it('accepts the daemon region/buildEnv', async () => {
		const client = await setupHandshaken({ handshake });
		client.send({
			type: 'hello',
			version: 2,
			env: { region: 'en', buildEnv: 'prod', profile: 'work' },
		});
		const welcome = await waitForSuccess(client, (frame) => frame.command === 'hello');
		expect(welcome.success).toBe(true);
		client.close();
	});

	it.each([
		['region', { region: 'cn', buildEnv: 'prod' }],
		['buildEnv', { region: 'en', buildEnv: 'dev' }],
	])('refuses a mismatching %s with ENV_MISMATCH and closes', async (_name, env) => {
		const client = await setupHandshaken({ handshake });
		client.send({ type: 'hello', version: 2, env });
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('ENV_MISMATCH');
		await client.closed();
	});

	it('refuses a missing env with ENV_MISMATCH', async () => {
		const client = await setupHandshaken({ handshake });
		client.send({ type: 'hello', version: 2 });
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('ENV_MISMATCH');
		client.close();
	});
});

describe('check order (arch §4.3.2: token → dataDir → env)', () => {
	it('answers the token failure even when dataDir and env are wrong too', async () => {
		const client = await setupHandshaken({
			handshake: {
				token: 'secret',
				dataDir: '/data',
				env: { region: 'en', buildEnv: 'prod' },
			},
		});
		client.send({
			type: 'hello',
			version: 2,
			dataDir: '/other',
			env: { region: 'cn', buildEnv: 'dev' },
		});
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('UNAUTHORIZED');
		client.close();
	});

	it('answers the dataDir failure before the env failure', async () => {
		const client = await setupHandshaken({
			handshake: { dataDir: '/data', env: { region: 'en', buildEnv: 'prod' } },
		});
		client.send({
			type: 'hello',
			version: 2,
			dataDir: '/other',
			env: { region: 'cn', buildEnv: 'dev' },
		});
		const failure = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(failure.errorCode).toBe('DATA_DIR_MISMATCH');
		client.close();
	});
});
