/**
 * Test doubles for the v2 surface: a spy CliService (the bridge only touches
 * the methods a test invokes, so a partial cast keeps the rig honest about
 * WHICH methods ran) and pushable GlobalEvent sources.
 *
 * @module
 */

import { vi, type Mock } from 'vitest';

import type { CliService } from '@mavis/local-runtime-v2/cli-service';

import { PushableIterable } from '../src/runtime-adapter.js';

export interface RecordedCall {
	readonly method: string;
	readonly args: unknown[];
}

/** The fake's mock-typed members (everything else is the plain CliService cast). */
export type FakeCliService = CliService & {
	readonly calls: RecordedCall[];
	sendMessage: Mock;
	resumeSession: Mock;
	watchSessionUsageCommits: Mock;
	abortSession: Mock;
	createSession: Mock;
	getSession: Mock;
	listPendingPermissions: Mock;
};

/**
 * A CliService test double: every allowlisted method the tests exercise is a
 * `vi.fn` recorded into `calls` (method name + exact arguments), so the
 * bridge invocation plans (`req-ctx` vs `raw`) assert on the REAL argument
 * shapes that reached the service.
 */
export function makeFakeCliService(): FakeCliService {
	const calls: RecordedCall[] = [];
	const record =
		(method: string) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
		};
	const asyncRecord =
		(method: string, result: unknown = { ok: true }) =>
		(...args: unknown[]) => {
			record(method)(...args);
			return Promise.resolve(result);
		};
	const fake = {
		calls,
		// req-ctx bucket representatives
		listSessions: vi.fn(asyncRecord('listSessions', { sessions: [], hasMore: false })),
		createSession: vi.fn(asyncRecord('createSession', { session: { id: 's-1' } })),
		getSession: vi.fn(asyncRecord('getSession', { session: undefined })),
		getMessages: vi.fn(asyncRecord('getMessages', { messages: [] })),
		replyPermission: vi.fn(asyncRecord('replyPermission', { success: true })),
		listPendingPermissions: vi.fn(asyncRecord('listPendingPermissions', { requests: [] })),
		// raw bucket representatives
		isGoalEnabled: vi.fn((...args: unknown[]) => {
			record('isGoalEnabled')(...args);
			return false;
		}),
		getGoal: vi.fn(asyncRecord('getGoal', undefined)),
		patchGoal: vi.fn(asyncRecord('patchGoal', {})),
		clearGoal: vi.fn(asyncRecord('clearGoal', true)),
		getWorkspaceReviewLink: vi.fn(asyncRecord('getWorkspaceReviewLink', undefined)),
		getPermissionMode: vi.fn((...args: unknown[]) => {
			record('getPermissionMode')(...args);
			return 'default';
		}),
		getPlanModeCapabilities: vi.fn((...args: unknown[]) => {
			record('getPlanModeCapabilities')(...args);
			return { entryEnabled: true };
		}),
		getRuntimeDiagnostics: vi.fn((...args: unknown[]) => {
			record('getRuntimeDiagnostics')(...args);
			return {};
		}),
		// streams
		sendMessage: vi.fn((...args: unknown[]) => {
			record('sendMessage')(...args);
			return Promise.resolve({ ok: true, source: (async function* () {})() });
		}),
		resumeSession: vi.fn((...args: unknown[]) => {
			record('resumeSession')(...args);
			return Promise.resolve({ ok: true, source: (async function* () {})() });
		}),
		watchSessionUsageCommits: vi.fn((...args: unknown[]) => {
			record('watchSessionUsageCommits')(...args);
			return (async function* () {})();
		}),
		abortSession: vi.fn(asyncRecord('abortSession', { success: true })),
		// daemon.status seam
		getSessionPublishStaleSessions: vi.fn(() => [] as readonly string[]),
	};
	return fake as unknown as FakeCliService;
}

/** Pushable GlobalEvent source for the hub's `subscribe` pump. */
export function makeGlobalEventSource(): PushableIterable<unknown> & { pushed: unknown[] } {
	const source = new PushableIterable<unknown>();
	const pushed: unknown[] = [];
	const originalPush = source.push.bind(source);
	(source as { push: (event: unknown) => void }).push = (event: unknown) => {
		pushed.push(event);
		originalPush(event);
	};
	Object.assign(source, { pushed });
	return source as PushableIterable<unknown> & { pushed: unknown[] };
}

export function catalogEvent(type: string, payload: Record<string, unknown> = {}): unknown {
	return { type, timestamp: Date.now(), source: 'local-runtime', payload };
}
