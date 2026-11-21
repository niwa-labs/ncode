/**
 * W3 conformance: the v2 frame contract (arch §4.3.2–4.3.3) — parse shapes,
 * feature gating, error codes, limits, and the allowlist/plan type ties.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { CliService } from '@mavis/local-runtime-v2/cli-service';
import { RemoteCliService } from '../src/client.js';

import {
	DEFAULT_STREAM_CREDIT,
	MAX_INBOUND_FRAME_BYTES,
	MCODED_PROTOCOL_FEATURES,
	MCODED_PROTOCOL_VERSION,
	STREAM_CLI_METHODS,
	STREAM_SINK_MAX_BYTES,
	parseFrame,
	serializeFrame,
	ProtocolError,
} from '../src/protocol.js';
import {
	REMOTE_CALL_PLANS,
	REMOTE_CLI_METHODS,
	REMOTE_METHOD_EXCEPTIONS,
	type RemoteCliMethod,
} from '../src/remote-methods.js';
import { GLOBAL_EVENT_ROUTES } from '../src/event-routing.js';

describe('v2 protocol constants (arch §4.3)', () => {
	it('pins major 2 with the multiplexing features', () => {
		expect(MCODED_PROTOCOL_VERSION).toBe(2);
		// W5 adds `restart-when-idle` (additive minor growth, §4.6.5).
		expect([...MCODED_PROTOCOL_FEATURES]).toEqual([
			'call',
			'stream',
			'attach',
			'subscribe',
			'restart-when-idle',
		]);
	});

	it('pins the arch limits: inbound 8 MiB, initial credit 256, sink 4 MiB', () => {
		expect(MAX_INBOUND_FRAME_BYTES).toBe(8 * 1024 * 1024);
		expect(DEFAULT_STREAM_CREDIT).toBe(256);
		expect(STREAM_SINK_MAX_BYTES).toBe(4 * 1024 * 1024);
	});

	it('pins the three stream methods', () => {
		expect([...STREAM_CLI_METHODS]).toEqual(['sendMessage', 'resumeSession', 'watchSessionUsageCommits']);
	});
});

describe('v2 client frame conformance', () => {
	it('parses call {id, method, params[]}', () => {
		const frame = parseFrame(serializeFrame({ type: 'call', id: 'c1', method: 'listSessions', params: [{ limit: 5 }] }));
		expect(frame).toEqual({ type: 'call', id: 'c1', method: 'listSessions', params: [{ limit: 5 }] });
	});

	it('parses call without params and rejects missing id/method', () => {
		expect(parseFrame('{"type":"call","id":"c1","method":"getRuntimeDiagnostics"}')).toEqual({
			type: 'call',
			id: 'c1',
			method: 'getRuntimeDiagnostics',
		});
		for (const bad of ['{"type":"call","method":"x"}', '{"type":"call","id":"c1"}', '{"type":"call","id":"c1","method":""}']) {
			expect(() => parseFrame(bad)).toThrow(ProtocolError);
		}
	});

	it('parses stream.open with only the three stream methods', () => {
		for (const method of STREAM_CLI_METHODS) {
			const frame = parseFrame(`{"type":"stream.open","id":"c2","method":"${method}","credit":8,"params":[]}`);
			expect(frame).toMatchObject({ type: 'stream.open', method, credit: 8 });
		}
		expect(() => parseFrame('{"type":"stream.open","id":"c2","method":"listSessions"}')).toThrow(ProtocolError);
		expect(() => parseFrame('{"type":"stream.open","id":"c2","method":"sendMessage","credit":-1}')).toThrow(ProtocolError);
	});

	it('parses stream.credit / stream.cancel strictly', () => {
		expect(parseFrame('{"type":"stream.credit","streamId":"s1","frames":4}')).toEqual({
			type: 'stream.credit',
			streamId: 's1',
			frames: 4,
		});
		expect(parseFrame('{"type":"stream.cancel","streamId":"s1","mode":"abort"}')).toMatchObject({
			type: 'stream.cancel',
			mode: 'abort',
		});
		for (const bad of [
			'{"type":"stream.credit","streamId":"s1","frames":0}',
			'{"type":"stream.credit","streamId":"","frames":1}',
			'{"type":"stream.cancel","streamId":"s1","mode":"detachy"}',
		]) {
			expect(() => parseFrame(bad)).toThrow(ProtocolError);
		}
	});

	it('parses session.attach with role and optional toolEnv', () => {
		const frame = parseFrame(
			serializeFrame({
				type: 'session.attach',
				id: 'c3',
				sessionId: 'sess-1',
				role: 'owner',
				toolEnv: { cwd: '/w', env: { VIRTUAL_ENV: '/w/.venv' } },
			}),
		);
		expect(frame).toMatchObject({
			type: 'session.attach',
			sessionId: 'sess-1',
			role: 'owner',
		});
		expect(
			(frame as Extract<typeof frame, { type: 'session.attach' }>).toolEnv?.env?.['VIRTUAL_ENV'],
		).toBe('/w/.venv');
		expect(() =>
			parseFrame('{"type":"session.attach","id":"c3","sessionId":"s","role":"admin"}'),
		).toThrow(ProtocolError);
		expect(() =>
			parseFrame('{"type":"session.attach","id":"c3","sessionId":"s","role":"owner","toolEnv":{"env":{"K":1}}}'),
		).toThrow(ProtocolError);
	});

	it('parses subscribe with scope and optional cursor', () => {
		expect(parseFrame('{"type":"subscribe","id":"c4"}')).toEqual({ type: 'subscribe', id: 'c4' });
		expect(
			parseFrame('{"type":"subscribe","id":"c4","after":"12","scope":"all"}'),
		).toMatchObject({ after: '12', scope: 'all' });
		expect(() => parseFrame('{"type":"subscribe","id":"c4","scope":"none"}')).toThrow(ProtocolError);
	});

	it('parses ping and the daemon.* frames', () => {
		expect(parseFrame('{"type":"ping","id":"p1"}')).toEqual({ type: 'ping', id: 'p1' });
		expect(parseFrame('{"type":"daemon.status","id":"d1"}')).toEqual({ type: 'daemon.status', id: 'd1' });
		expect(parseFrame('{"type":"daemon.restart","id":"d2","when":"now"}')).toMatchObject({ when: 'now' });
		expect(parseFrame('{"type":"daemon.authSync","id":"d3"}')).toEqual({ type: 'daemon.authSync', id: 'd3' });
		expect(() => parseFrame('{"type":"daemon.restart","id":"d2","when":"later"}')).toThrow(ProtocolError);
	});

	it('v1 frames parse exactly as before (shim intact)', () => {
		expect(parseFrame('{"type":"hello","version":1}')).toEqual({ type: 'hello', version: 1 });
		expect(parseFrame('{"type":"prompt","message":"hi","id":"r1"}')).toEqual({
			type: 'prompt',
			message: 'hi',
			id: 'r1',
		});
		expect(parseFrame('{"type":"events","after":"3","limit":10}')).toEqual({
			type: 'events',
			after: '3',
			limit: 10,
		});
	});
});

describe('v2 hello extensions', () => {
	it('carries clientInstanceId, client identity and promptMode', () => {
		const frame = parseFrame(
			serializeFrame({
				type: 'hello',
				version: 2,
				minor: 0,
				clientInstanceId: 'window-uuid',
				client: { kind: 'tui', pid: 42, buildId: 'b-1', cwd: '/w' },
				promptMode: 'tui',
			}),
		);
		expect(frame).toMatchObject({
			type: 'hello',
			version: 2,
			clientInstanceId: 'window-uuid',
			promptMode: 'tui',
		});
		expect((frame as { client?: { pid?: number } }).client?.pid).toBe(42);
	});

	it('rejects malformed v2 hello extensions', () => {
		for (const bad of [
			'{"type":"hello","version":2,"clientInstanceId":""}',
			'{"type":"hello","version":2,"client":{"kind":"web"}}',
			'{"type":"hello","version":2,"promptMode":"chaos"}',
			'{"type":"hello","version":2,"client":{"pid":-1}}',
		]) {
			expect(() => parseFrame(bad)).toThrow(ProtocolError);
		}
	});
});

describe('allowlist type ties (arch §4.3.6)', () => {
	it('every allowlisted method exists on the remote client at runtime', () => {
		const proto = RemoteCliService.prototype as unknown as Record<string, unknown>;
		for (const method of REMOTE_CLI_METHODS) {
			expect(typeof proto[method], `${method} must exist on RemoteCliService`).toBe('function');
		}
	});

	it('every allowlisted name is a CliService method (satisfies chain)', () => {
		// The `satisfies` in remote-methods.ts enforces this at compile time;
		// the runtime check documents the tie for readers of the failure output.
		const proto = CliService.prototype as unknown as Record<string, unknown>;
		for (const method of REMOTE_CLI_METHODS) {
			expect(typeof proto[method], `${method} must exist on CliService`).toBe('function');
		}
	});

	it('every allowlisted method has a call plan; stream methods are stream-only', () => {
		expect(Object.keys(REMOTE_CALL_PLANS).sort()).toEqual([...REMOTE_CLI_METHODS].sort());
		for (const method of STREAM_CLI_METHODS) {
			expect(REMOTE_CALL_PLANS[method as RemoteCliMethod]).toEqual({ kind: 'stream-only' });
		}
		expect(REMOTE_CALL_PLANS.listSessions).toEqual({ kind: 'req-ctx' });
		expect(REMOTE_CALL_PLANS.getGoal).toEqual({ kind: 'raw' });
	});

	it('watchEvents is the single documented exclusion', () => {
		expect(REMOTE_METHOD_EXCEPTIONS).toEqual(['watchEvents']);
		expect(REMOTE_CLI_METHODS).not.toContain('watchEvents');
	});
});

describe('event routing table completeness (arch §4.3.4)', () => {
	it('classifies every GlobalEvent type exactly once', async () => {
		const { GLOBAL_EVENT_TYPES } = await import('@mavis/shared/global-events');
		const table = GLOBAL_EVENT_ROUTES as Record<string, string>;
		for (const type of GLOBAL_EVENT_TYPES) {
			expect(table[type], `${type} must be classified`).toBeDefined();
		}
		expect(Object.keys(table).sort()).toEqual([...GLOBAL_EVENT_TYPES].sort());
	});

	it('the arch pinning holds: catalog set and session set', () => {
		const catalog = Object.entries(GLOBAL_EVENT_ROUTES)
			.filter(([, route]) => route === 'catalog')
			.map(([type]) => type)
			.sort();
		expect(catalog).toEqual(
			[
				'agent.created',
				'agent.updated',
				'config.browser_use_tooling.changed',
				'config.permission_mode.changed',
				'notification.read',
				'notification.refresh',
				'rotation.completed',
				'session.created',
				'session.deleted',
				'session.model_updated',
				'session.pinned_updated',
				'session.title_updated',
				'session.visibility_updated',
			].sort(),
		);
		// W1 §3.4 decision: session-scoped banner rides the attach route.
		expect(GLOBAL_EVENT_ROUTES['session.publish_conflict']).toBe('session');
	});
});
