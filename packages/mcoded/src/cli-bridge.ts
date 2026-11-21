/**
 * The daemon-side bridge from the v2 wire (`call` / `stream.open`) onto the
 * runtime's {@link CliService} (arch §4.3.6, §5).
 *
 * Responsibilities, exactly:
 * - dispatch `call` frames through the {@link REMOTE_CALL_PLANS} table — the
 *   allowlist is the only dispatch path, there is no dynamic member access on
 *   client-controlled strings beyond the table lookup (§4.7);
 * - open the three stream methods and mirror `ProcessLocalStreamResult`:
 *   `{ok:true, source}` or `{ok:false, status, body}` (the latter becomes a
 *   failed `stream.open` response with `errorData`);
 * - inject the connection-bound `ProcessLocalContext` — the client never
 *   sends one (§4.3.2). Per W0 F3 the runtime ignores the `sendMessage`
 *   signal entirely, so the connection signal here only drives surfaces that
 *   consume it (`watchEvents`-style subscriptions, usage commits); aborting a
 *   turn is EXPLICIT: `stream.cancel{mode:'abort'}` → `abortSession` (§4.3.5);
 * - enforce the attach rule of §4.5: `replyPermission` answers `NOT_ATTACHED`
 *   from a connection without an attach on that session, and
 *   `listPendingPermissions` is filtered to the connection's attached
 *   sessions (window A must never see window B's approvals);
 * - serialize thrown runtime errors onto the wire's stable codes.
 *
 * Everything the bridge touches is in-memory per call; nothing here logs
 * `toolInput`/`toolEnv` payloads (§4.7).
 *
 * @module
 */

import { createLogger } from '@mavis/logging';

import type { ProcessLocalContext } from '@mavis/conversation-contract';
import type {
	CliSendMessageOptions,
	CliSendMessageReq,
	CliService,
	ResumeSessionReq,
	SessionStreamErrorBody,
	SessionStreamFrameView,
} from '@mavis/local-runtime-v2/cli-service';

import {
	METHOD_NOT_ALLOWED_CODE,
	REMOTE_CALL_PLANS,
	type RemoteCliMethod,
} from './remote-methods.js';
import { STREAM_CLI_METHODS, type StreamCliMethod } from './protocol.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/**
 * The connection-scoped context the daemon builds for every call: the signal
 * dies WITH the connection (unsubscribe/drain of watch-style surfaces only —
 * never a turn abort, W0 F3) and `attachedSessionIds` is the attach set the
 * §4.5 permission rules key on.
 */
export interface BridgeConnectionContext extends ProcessLocalContext {
	/** Sessions this connection holds `session.attach` on. */
	readonly attachedSessionIds: ReadonlySet<string>;
	/**
	 * The hub's own internal invocation (the `MCODE_DETACHED_PERMISSION=deny`
	 * auto-deny, §4.5 п.3): not a window reply, so the §4.5 attach rule does
	 * not apply — there is no attached window by definition.
	 */
	readonly internal?: boolean;
}

/** Mirror of `ProcessLocalStreamResult` with a widened frame type. */
export type BridgeStreamResult =
	| { readonly ok: true; readonly source: AsyncIterable<SessionStreamFrameView | string> }
	| { readonly ok: false; readonly status: number; readonly body: SessionStreamErrorBody | unknown };

/** Wire-mapped failure: stable code + class name + structured detail. */
export class BridgeMethodError extends Error {
	readonly code: McodedBridgeErrorCode;
	readonly errorName: string;
	readonly data: unknown;

	constructor(
		message: string,
		options: { code?: McodedBridgeErrorCode; errorName?: string; data?: unknown } = {},
	) {
		super(message);
		this.name = 'BridgeMethodError';
		this.code = options.code ?? 'RUNTIME_REJECTED';
		this.errorName = options.errorName ?? 'Error';
		this.data = options.data;
	}
}

/** Error codes the bridge itself can produce. */
export type McodedBridgeErrorCode = 'RUNTIME_REJECTED' | 'METHOD_NOT_ALLOWED' | 'NOT_ATTACHED';

/** What the bridge needs: a CliService (possibly late — the host boots lazily). */
export interface CliBridgeOptions {
	/** Resolves the CliService to dispatch onto (may return `undefined` until ready). */
	readonly cliService: () => CliService | undefined;
}

/**
 * The `call`/`stream.open` → CliService bridge. Pure dispatch: no sockets,
 * no cursors — the hub owns frames, credits and detach-sinks.
 */
export class CliBridge {
	private readonly resolveCli: () => CliService | undefined;

	constructor(options: CliBridgeOptions) {
		this.resolveCli = options.cliService;
	}

	/** Whether a CliService is available (else `call` answers METHOD_NOT_ALLOWED). */
	get available(): boolean {
		return this.resolveCli() !== undefined;
	}

	/** The publish-stale snapshot for `daemon.status`; empty without a runtime. */
	async publishStaleSessions(): Promise<readonly string[]> {
		const cli = this.resolveCli();
		if (!cli) return [];
		try {
			return cli.getSessionPublishStaleSessions();
		} catch {
			return [];
		}
	}

	/**
	 * Invoke one allowlisted method. The plan table decides how arguments map
	 * onto the CliService signature; the narrow casts below are guarded by the
	 * `satisfies` chain in `remote-methods.ts` (name IS a method) and by the
	 * per-method plans (arity convention).
	 */
	async invoke(
		method: string,
		params: unknown[] | undefined,
		context: BridgeConnectionContext,
	): Promise<unknown> {
		const cli = this.requireCli(method);
		const plan = REMOTE_CALL_PLANS[method as RemoteCliMethod];
		if (!plan) {
			throw new BridgeMethodError(`method ${JSON.stringify(method)} is not in the allowlist`, {
				code: METHOD_NOT_ALLOWED_CODE,
			});
		}
		if (plan.kind === 'stream-only') {
			throw new BridgeMethodError(
				`method ${JSON.stringify(method)} is a stream method — use stream.open`,
				{ code: METHOD_NOT_ALLOWED_CODE },
			);
		}
		const list = params ?? [];
		if (plan.kind === 'req-ctx') {
			if (method === 'replyPermission' && context.internal !== true) {
				this.enforceAttach(list[0], context);
			}
			if (method === 'listPendingPermissions') {
				return this.filteredPendingPermissions(cli, list[0], context);
			}
			const fn = cli[method as CallMethod] as (
				req: unknown,
				ctx?: ProcessLocalContext,
			) => Promise<unknown>;
			return fn.call(cli, list[0], { signal: context.signal });
		}
		const fn = cli[method as CallMethod] as (...args: unknown[]) => Promise<unknown>;
		return fn.apply(cli, list);
	}

	/**
	 * Open one of the three stream methods. The returned source is the raw
	 * process-local stream — pumping it (frames, credits, detach) is the
	 * hub's `StreamMux` business, not the bridge's.
	 */
	async openStream(
		method: StreamCliMethod,
		params: unknown[] | undefined,
		context: BridgeConnectionContext,
	): Promise<BridgeStreamResult> {
		const cli = this.requireCli(method);
		const list = params ?? [];
		if (method === 'sendMessage') {
			const req = list[0] as CliSendMessageReq;
			const options = list[1] as CliSendMessageOptions | undefined;
			const opened = options
				? await cli.sendMessage(req, { signal: context.signal }, options)
				: await cli.sendMessage(req, { signal: context.signal });
			return opened.ok
				? { ok: true, source: asAsyncIterable(opened.source) }
				: { ok: false, status: opened.status, body: opened.body };
		}
		if (method === 'resumeSession') {
			const req = list[0] as ResumeSessionReq;
			const opened = await cli.resumeSession(req, { signal: context.signal });
			return opened.ok
				? { ok: true, source: asAsyncIterable(opened.source) }
				: { ok: false, status: opened.status, body: opened.body };
		}
		// watchSessionUsageCommits(signal?) — a plain generator of commit ids.
		const source = cli.watchSessionUsageCommits(context.signal);
		return { ok: true, source };
	}

	/**
	 * `stream.cancel{mode:'abort'}`: the EXPLICIT abort path (arch §4.3.5, W0
	 * F3 — the runtime never reads a per-call signal, so an aborted stream is
	 * aborted through `abortSession`, keyed on the turn's session). Streams
	 * without a session (usage commits) have nothing to abort.
	 */
	async abortStreamTurn(method: StreamCliMethod, params: unknown[]): Promise<void> {
		const cli = this.requireCli(method);
		const sessionId = this.streamSessionId(method, params);
		if (!sessionId) return;
		const request = params[0] as { turnId?: unknown } | undefined;
		await cli.abortSession({
			id: sessionId,
			reason: 'stream_cancel',
			...(typeof request?.turnId === 'string' ? { turnId: request.turnId } : {}),
		});
	}

	/**
	 * The session a stream's turn belongs to. `SendMessageInput`/`ResumeSessionInput`
	 * carry it as `id`; `sessionId` accepted as the tolerant spelling.
	 */
	streamSessionId(method: StreamCliMethod, params: unknown[] | undefined): string | undefined {
		if (method === 'watchSessionUsageCommits') return undefined;
		const req = (params ?? [])[0] as { id?: unknown; sessionId?: unknown } | undefined;
		const id = req?.id ?? req?.sessionId;
		return typeof id === 'string' && id.length > 0 ? id : undefined;
	}

	/** Serialize one thrown error onto the wire's failure fields. */
	static toWireError(error: unknown): {
		message: string;
		code: McodedErrorCodeAlias;
		name: string;
		data: unknown;
	} {
		if (error instanceof BridgeMethodError) {
			return { message: error.message, code: error.code, name: error.errorName, data: error.data };
		}
		const name = error instanceof Error ? error.name : 'Error';
		const message = error instanceof Error ? error.message : String(error);
		log.warn('bridge-call-failed', { err: error });
		return { message, code: 'RUNTIME_REJECTED', name, data: undefined };
	}

	/** §4.5: replying to a permission requires an attach on its session. */
	private enforceAttach(req: unknown, context: BridgeConnectionContext): void {
		const sessionId = (req as { sessionId?: unknown } | null | undefined)?.sessionId;
		if (typeof sessionId === 'string' && context.attachedSessionIds.has(sessionId)) return;
		throw new BridgeMethodError(
			`no session.attach on session ${typeof sessionId === 'string' ? sessionId : '<missing>'}; ` +
				'permission replies are accepted from attached windows only',
			{ code: 'NOT_ATTACHED' },
		);
	}

	/** §4.5: the pending-permission snapshot filters to attached sessions. */
	private async filteredPendingPermissions(
		cli: CliService,
		_req: unknown,
		context: BridgeConnectionContext,
	): Promise<unknown> {
		const response = await cli.listPendingPermissions({}, { signal: context.signal });
		return {
			requests: (response.requests ?? []).filter(
				(request) =>
					typeof request.sessionId === 'string' &&
					context.attachedSessionIds.has(request.sessionId),
			),
		};
	}

	private requireCli(method: string): CliService {
		const cli = this.resolveCli();
		if (!cli) {
			throw new BridgeMethodError('the v2 call surface is not wired in this daemon', {
				code: METHOD_NOT_ALLOWED_CODE,
			});
		}
		void method;
		return cli;
	}
}

/**
 * The process-local stream contract allows a sync `Iterable` source; the mux
 * pumps asynchronously, so wrap the sync shape once at the bridge boundary.
 */
function asAsyncIterable(
	source: AsyncIterable<SessionStreamFrameView> | Iterable<SessionStreamFrameView>,
): AsyncIterable<SessionStreamFrameView | string> {
	if (Symbol.asyncIterator in source) return source;
	const iterator = source[Symbol.iterator]();
	const asyncIterator: AsyncIterableIterator<SessionStreamFrameView> = {
		[Symbol.asyncIterator]: () => asyncIterator,
		next: async () => iterator.next(),
		return: async () => {
			iterator.return?.();
			return { done: true as const, value: undefined };
		},
	};
	return asyncIterator;
}

/** Alias so the wire's {@link McodedErrorCode} stays the single wire truth. */
type McodedErrorCodeAlias = 'RUNTIME_REJECTED' | 'METHOD_NOT_ALLOWED' | 'NOT_ATTACHED';

/** Allowlisted method names that `call` may dispatch (stream methods excluded). */
type CallMethod = Exclude<RemoteCliMethod, StreamCliMethod>;

/** Stream methods for reference by tests/compositions (single import site). */
export const BRIDGE_STREAM_METHODS = STREAM_CLI_METHODS;
