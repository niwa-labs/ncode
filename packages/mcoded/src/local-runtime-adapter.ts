/**
 * The Ф4 product {@link RuntimeAdapter}: drives the live local-runtime-v2
 * conversation pipeline (`createLocalRuntimeHostV2` → its `CliService`)
 * instead of the echo stub.
 *
 * Mapping (pi-rpc submission kinds → runtime conversation operations):
 * - `prompt`     → `createSession` (first time only) + `sendMessage`; the
 *                  returned frame stream is relayed verbatim as adapter events
 *                  and ends with a terminal event of its own;
 * - `steer`      → `enqueueMessage` + `steerSession` while a Turn is active;
 *                  with no active Turn the message stays queued (which is the
 *                  follow-up behavior);
 * - `follow_up`  → `enqueueMessage`.
 * - `abort`      → `abortSession` on the adapter's Session; ordered through
 *                  the same admission chain as submissions, so a pipelined
 *                  `prompt`+`abort` pair can never let the abort run against a
 *                  half-admitted runtime (host booting / Session not created)
 *                  and silently cancel nothing.
 *
 * The host inherits the CLI profile's auth: `options.auth` resolves the
 * profile's shared OAuth lease (packages/oauth-core, the same
 * `auth/<buildEnv>/<region>/<clientId>` store the CLI login fills) and hands
 * `authContextGetter`/`authContextInvalidator` to `createLocalRuntimeHostV2`,
 * so the LocalModelResolver sees a synced managed bearer.
 *
 * Terminal semantics: the frame stream of EVERY turn ends with the
 * `"[DONE]"` sentinel, so the terminator alone cannot carry the outcome; the
 * last `session_status` frame does. `session_status.type === "error"` is
 * relayed as an explicit `turn_failed` event (with the upstream message);
 * successful turns keep the historical `turn_completed`.
 *
 * Ack semantics follow the hub contract: `submit` resolves once the runtime
 * ACCEPTED the input (stream opened / message queued); turn output flows
 * asynchronously through `events`. Every event is a plain JSON value — the
 * daemon stamps cursors and replays it verbatim, so nothing here may carry
 * sockets, cursors or client identity.
 *
 * The host boots lazily on the first submission (or explicit `start`) and is
 * torn down by `close`; `stop` only ends the event stream, matching the
 * graceful-shutdown order of the daemon (drain first, close host last).
 *
 * @module
 */

import os from 'node:os';
import path from 'node:path';

import { mkdirSync } from 'node:fs';

import { createLogger } from '@mavis/logging';
import {
	DEFAULT_MODEL_PRESETS,
	ensureDurableLayout,
	getRuntimeBuildEnv,
	getRuntimePresetKey,
	getRuntimeRegion,
	normalizeProfileSelector,
	resolveModelAvailability,
	resolveProfileDataDirPaths,
} from '@mavis/config';
import {
	createAuthNamespace,
	createCredentialStore,
	HttpOAuthClient,
	MCODE_OAUTH_SCOPES,
	MCodeOAuthCore,
	migrateLegacyAuthNamespace,
	requiresInteractiveLogin,
	resolveMCodeOAuthEndpointConfig,
	type AccessTokenLease,
} from '@mavis/oauth-core';
import { createLocalRuntimeHostV2, getDefaultLocalRuntimeConfig } from '@mavis/local-runtime-v2';
import type {
	CreateLocalRuntimeHostOptions,
	CreatedLocalRuntimeHost,
	LocalRuntimeAuthContext,
	LocalRuntimeConfig,
} from '@mavis/local-runtime-v2/process-local';
import type { GlobalEvent } from '@mavis/shared/global-events';
import type { RuntimeInternalTurn } from './runtime-adapter.js';
import {
	CliService,
	type AbortSessionReq,
	type CreateSessionReq,
	type SessionStreamFrameView,
} from '@mavis/local-runtime-v2/cli-service';

import { PushableIterable } from './runtime-adapter.js';
import type { RuntimeAdapter, RuntimeSubmission } from './runtime-adapter.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/**
 * Bounded beat the close drain gives the lifecycle observer to flush the
 * outcomes it saw while the host was closing (§5.4 №18): normally the host
 * close already ended the bus and the watch returns at once; the grace only
 * covers a broken bus that never returns.
 */
const INTERNAL_TURN_OBSERVER_DRAIN_GRACE_MS = 2_000;

/** The lifecycle-terminal GlobalEvents that settle an observed internal turn. */
type InternalTurnTerminalEvent =
	| Extract<GlobalEvent, { type: 'session.finish' }>
	| Extract<GlobalEvent, { type: 'session.error' }>
	| Extract<GlobalEvent, { type: 'session.abort' }>;

/** Default agent the daemon drives when the embedder does not name one. */
export const DEFAULT_MCODED_AGENT_NAME = 'mavis';

/** Opaque adapter events relayed verbatim by the daemon (all JSON-serializable). */
export type LocalRuntimeAdapterEvent =
	| { readonly type: 'runtime_started'; readonly dataDir: string }
	| {
			readonly type: 'turn_started';
			readonly requestId: string;
			readonly sessionId: string;
			/** Client submission kind; `undefined` for runtime-internal activations. */
			readonly kind?: RuntimeSubmission['kind'];
			/** Runtime turn identity; set for runtime-internal (observed) turns. */
			readonly turnId?: string;
			/** Why the adapter emitted this event beyond a client submission. */
			readonly origin?: 'background-delivery';
	  }
	| {
			readonly type: 'turn_frame';
			readonly requestId: string;
			readonly sessionId: string;
			/** Verbatim process-local stream frame (`SessionStreamFrameView`). */
			readonly frame: SessionStreamFrameView;
			/** Set on frames of runtime-internal (observed) turns. */
			readonly origin?: 'background-delivery';
	  }
	| {
			readonly type: 'turn_completed';
			readonly requestId: string;
			readonly sessionId: string;
			readonly turnId?: string;
			readonly origin?: 'background-delivery';
	  }
	| {
			readonly type: 'turn_failed';
			readonly requestId: string;
			readonly sessionId: string;
			readonly error: string;
			readonly turnId?: string;
			readonly origin?: 'background-delivery';
	  }
	| {
			/** A turn the runtime aborted: the TRUE outcome, never renamed. */
			readonly type: 'turn_aborted';
			readonly requestId: string;
			readonly sessionId: string;
			readonly turnId?: string;
			readonly origin?: 'background-delivery';
	  }
	| {
			readonly type: 'input_queued';
			readonly requestId: string;
			readonly sessionId: string;
			readonly kind: Exclude<RuntimeSubmission['kind'], 'prompt'>;
			readonly itemId?: string;
			readonly status?: string;
			/** True when the queued item was pulled into the active Turn. */
			readonly steered: boolean;
	  }
	| { readonly type: 'abort_requested'; readonly sessionId?: string };

/**
 * Profile auth the daemon should inherit. The OAuth credential store ALWAYS
 * comes from {@link dataDir} — the mcode data directory the runtime actually
 * serves (`~/.minimax[-<profile>]/auth/...`, packages/oauth-core; opus
 * 2026-11-01: the namespace is built from the REAL dataDir, so the creds and
 * the data plane can never diverge by construction) — the daemon serves a
 * DIFFERENT control root (`~/.mcode-durable[-<profile>]`), so without this
 * hand-off its LocalModelResolver sees no managed bearer and every
 * managed-login turn fails with "managed OAuth bearer is not synced". The
 * profile is a derived LOG LABEL here, never a namespace input.
 */
export interface LocalRuntimeAdapterAuthOptions {
	/** Explicit profile selector; log label only (`null` = default profile). */
	readonly profile?: string | null;
	/**
	 * Data directory the credential namespace is built from — the SAME
	 * directory the runtime serves. When omitted, the explicit profile's
	 * primary data directory (or the default one) is used; the profile ENV is
	 * never consulted on this path.
	 */
	readonly dataDir?: string;
	/** Environment backing the scope resolution. Default: `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** Home directory for the fallback data-dir resolution. Default: env `HOME`. */
	readonly homeDir?: string;
}

/** Synced profile OAuth lease handed to the runtime host. */
export interface LocalRuntimeAdapterAuthSession {
	/** Latest known auth context (`undefined` until a lease succeeds). */
	readonly authContextGetter: () => LocalRuntimeAuthContext | undefined;
	/** Host hook for rejected managed OAuth requests: refresh and re-sync. */
	readonly authContextInvalidator: (
		rejectedAccessToken?: string,
		loginEpoch?: string,
	) => Promise<void>;
	/** Read (and refresh when stale) the profile lease now; `undefined` = signed out. */
	lease(): Promise<LocalRuntimeAuthContext | undefined>;
	/** Drop the background refresh timer. */
	dispose(): void;
}

export interface LocalRuntimeAdapterOptions {
	/**
	 * Durable root the adapter was classically rooted at. With `dataDir` set
	 * this is the CONTROL plane only (the daemon shell's socket, lock, token,
	 * manifest); the runtime treats it as a plain directory otherwise.
	 */
	readonly root: string;
	/**
	 * Data plane the runtime serves (arch §2.2): the profile data directory
	 * whose `durable-history/`, `v2/` and workspace the host opens. When set,
	 * the runtime `dataDir`, the workspace and the config pinning ALL move
	 * here — the control root keeps no user data. Default: `root` (the
	 * pre-split single-root behavior, kept for embedders and tests).
	 */
	readonly dataDir?: string;
	/** Agent the daemon drives. Default: {@link DEFAULT_MCODED_AGENT_NAME}. */
	readonly agentName?: string;
	/** Session workspace directory. Default: `<dataDir>/workspace`. */
	readonly workspaceDir?: string;
	/** Profile auth the runtime host should inherit (see {@link LocalRuntimeAdapterAuthOptions}). */
	readonly auth?: LocalRuntimeAdapterAuthOptions;
	/** Host factory override; tests inject `createLocalRuntimeHostV2ForTest`. */
	readonly createHost?: (
		options: CreateLocalRuntimeHostOptions,
	) => Promise<CreatedLocalRuntimeHost>;
	/** Auth session factory override; tests inject a fake profile session. */
	readonly createAuthSession?: (
		options: LocalRuntimeAdapterAuthOptions,
	) => LocalRuntimeAdapterAuthSession | undefined;
	/** Config source override. Default: `getDefaultLocalRuntimeConfig` pinned to `root`. */
	readonly configGetter?: () => LocalRuntimeConfig;
}

/** Accepted-but-not-yet-relayed turn: the background frame pump. */
interface TurnPump {
	readonly requestId: string;
	readonly sessionId: string;
	readonly promise: Promise<void>;
}

/** One runtime-internal owner turn observed but not yet terminal. */
interface ObservedInternalTurn {
	readonly turnId: string;
	/** Deterministic synthetic identity, derived from the turnId. */
	readonly requestId: string;
	readonly sessionId: string;
	readonly startedAtMs: number;
}

/**
 * Production RuntimeAdapter over the local-runtime-v2 conversation pipeline.
 * One adapter owns one Session (the daemon serves one profile root); prompts
 * before the first submission create it on the configured agent.
 */
export class LocalRuntimeV2Adapter implements RuntimeAdapter {
	private readonly root: string;
	private readonly dataDir: string;
	private readonly agentName: string;
	private readonly workspaceDir: string;
	private readonly authOptions: LocalRuntimeAdapterAuthOptions | undefined;
	private readonly createHost: NonNullable<LocalRuntimeAdapterOptions['createHost']>;
	private readonly createAuthSession: NonNullable<
		LocalRuntimeAdapterOptions['createAuthSession']
	>;
	private readonly configGetter: LocalRuntimeAdapterOptions['configGetter'];

	private readonly stream = new PushableIterable<LocalRuntimeAdapterEvent>();
	private host: CreatedLocalRuntimeHost | undefined;
	private cli: CliService | undefined;

	/**
	 * The live CliService of the booted host, `undefined` before the first
	 * submission/explicit start. The v2 composition (W3) builds its
	 * `cli-bridge` over this getter — the same runtime serves the v1 shim
	 * through the adapter and the v2 `call`/`stream.open` surface through the
	 * bridge.
	 */
	get cliService(): CliService | undefined {
		return this.cli;
	}
	private authSession: LocalRuntimeAdapterAuthSession | undefined;
	private sessionId: string | undefined;
	private starting: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	/**
	 * Serializes admission so concurrent `submit`/`abort` calls cannot race
	 * the host or reorder against each other (the wire dispatches pipelined
	 * client frames fire-and-forget).
	 */
	private admissionChain: Promise<void> = Promise.resolve();
	private readonly pumps = new Set<TurnPump>();
	/**
	 * Runtime-level lifecycle observer (Wave 1, verdict §3.4): subscribes the
	 * host's `application.events` bus at bootstrap — BEFORE any background
	 * delivery can activate a turn — and projects internally activated owner
	 * turns into the adapter event feed. `undefined` for hosts without the
	 * bus (mock hosts, older runtimes): the client-pump behavior is unchanged.
	 */
	private observerAbort: AbortController | undefined;
	private observerTask: Promise<void> | undefined;
	/** Observed internal turns awaiting their real terminal (busy input). */
	private readonly internalTurnsById = new Map<string, ObservedInternalTurn>();

	readonly events: AsyncIterable<LocalRuntimeAdapterEvent> = this.stream;

	constructor(options: LocalRuntimeAdapterOptions) {
		this.root = options.root;
		this.dataDir = options.dataDir ?? options.root;
		this.agentName = options.agentName ?? DEFAULT_MCODED_AGENT_NAME;
		this.workspaceDir = options.workspaceDir ?? path.join(this.dataDir, 'workspace');
		this.authOptions = options.auth;
		this.createHost = options.createHost ?? createLocalRuntimeHostV2;
		this.createAuthSession = options.createAuthSession ?? createProfileAuthSession;
		this.configGetter = options.configGetter;
	}

	/** The Session every submission lands in; set after the first admission. */
	get currentSessionId(): string | undefined {
		return this.sessionId;
	}

	/** Whether the runtime host has been started. */
	get isStarted(): boolean {
		return this.host !== undefined;
	}

	/**
	 * Runtime-internal owner turns (turns the runtime activated itself —
	 * background-task delivery wake) that are LIVE right now. The daemon's
	 * busy/drain views count them (idle restart and the stop drain guard must
	 * never fire mid-wake); an empty array means idle or no observer.
	 */
	internalTurns(): RuntimeInternalTurn[] {
		return [...this.internalTurnsById.values()].map((turn) => ({
			sessionId: turn.sessionId,
			turnId: turn.turnId,
			startedAtMs: turn.startedAtMs,
		}));
	}

	/**
	 * Boot the runtime host (idempotent). The daemon entry calls this before
	 * serving; `submit` awaits it lazily so an embedder that skips `start`
	 * still works.
	 */
	start(): Promise<void> {
		this.starting ??= this.startOnce();
		return this.starting;
	}

	async submit(submission: RuntimeSubmission): Promise<void> {
		// Serialize admissions: the hub handles pipelined client frames
		// concurrently, and Session creation / Turn admission must not race.
		await this.enqueueAdmission(() => this.submitInner(submission));
	}

	/**
	 * Best-effort cancel of the active turn, ordered behind admissions. The
	 * wire dispatches frames fire-and-forget, so `prompt` followed immediately
	 * by `abort` reaches this adapter concurrently; running the abort while
	 * the prompt is still mid-admission (host booting / Session not yet
	 * created) would cancel nothing yet ack success, and the admitted prompt
	 * would then start a turn nobody aborts.
	 */
	async abort(): Promise<void> {
		await this.enqueueAdmission(() => this.abortInner());
	}

	/** Run `operation` after every earlier `submit`/`abort`, in arrival order. */
	private enqueueAdmission(operation: () => Promise<void>): Promise<void> {
		const enqueued = this.admissionChain.then(operation);
		this.admissionChain = enqueued.then(
			() => undefined,
			() => undefined,
		);
		return enqueued;
	}

	private async abortInner(): Promise<void> {
		const sessionId = this.sessionId;
		if (!this.cli || !sessionId) {
			this.stream.push({ type: 'abort_requested' });
			return;
		}
		const request: AbortSessionReq = { id: sessionId, reason: 'mcoded_abort' };
		const result = await this.cli.abortSession(request);
		log.debug('abort', { sessionId, success: result.success ?? false });
		this.stream.push({ type: 'abort_requested', sessionId });
	}

	/**
	 * End the event stream (graceful shutdown order: the hub drains FIRST,
	 * the embedder closes the host afterwards via {@link close}).
	 */
	stop(): void {
		this.stream.end();
	}

	/** Tear the runtime host down; resolves once the host is closed. Idempotent. */
	async close(): Promise<void> {
		this.closing ??= this.closeOnce();
		await this.closing;
	}

	private async startOnce(): Promise<void> {
		if (this.dataDir === this.root) {
			// Single-root mode (embedders/tests): the classic durable layout.
			ensureDurableLayout(this.root);
		} else {
			// Control/data split (arch §2.2): the data plane is the profile
			// dataDir — the host opens its durable-history/v2 layout there; the
			// control root was prepared by `ensureControlRootLayout` upstream.
			mkdirSync(this.dataDir, { recursive: true });
		}
		mkdirSync(this.workspaceDir, { recursive: true });
		// Inherit the profile OAuth lease BEFORE the host boots: the model
		// resolver reads it lazily at first turn, but an early sync means the
		// managed bearer is already in place (and a signed-out profile degrades
		// to the pre-fix behavior with a logged reason instead of silence).
		// The credential namespace is pinned to the dataDir this adapter
		// SERVES (opus 2026-11-01): any `auth.dataDir`/profile spelling the
		// embedder passed is a label — the served data plane decides the store.
		this.authSession = this.authOptions
			? (this.createAuthSession({ ...this.authOptions, dataDir: this.dataDir }) ?? undefined)
			: undefined;
		if (this.authSession) await this.syncInitialAuthLease();
		const host = await this.createHost({
			dataDir: this.dataDir,
			runtimeOwnerKind: 'cli',
			capabilityProfile: 'cli',
			capabilities: { cliEmbedded: true },
			// Per-session durable history (owner decision 2026-11-18): the
			// daemon owns the shared SYSTEM log — orchestration, delegation
			// steering, cron — while every session's own history lives in its
			// per-session file. Embedded (non-daemon) hosts omit this flag.
			ownsSystemLog: true,
			// Always pinned: the V1 host derives its dataDir from the config, so
			// an unpinned product default would silently move the runtime off
			// the data plane.
			configGetter: this.resolveConfigGetter(),
			// The resolved profile label rides the account status (opus
			// 2026-11-01, правка 5): /status shows which profile/store the
			// daemon serves. `undefined` without auth options keeps the field
			// off the wire for auth-less embedders.
			...(this.authOptions ? { daemonProfile: this.authOptions.profile ?? null } : {}),
			...(this.authSession
				? {
						authContextGetter: this.authSession.authContextGetter,
						authContextInvalidator: this.authSession.authContextInvalidator,
					}
				: {}),
		});
		await host.ready;
		if (!host.cliService) {
			await host.apiHost.close().catch(() => undefined);
			throw new Error('local-runtime-v2 host does not expose CliService');
		}
		// The internal-turn observer MUST subscribe before anything can steer a
		// delivery into the runtime: every later `session.start` must already be
		// observed (verdict §3.4 — "Подписка должна устанавливаться ДО
		// возможности background delivery activation").
		this.beginInternalTurnObservation(host);
		await host.apiHost.ensureBuiltinAgents();
		this.host = host;
		this.cli = host.cliService;
		this.stream.push({ type: 'runtime_started', dataDir: host.dataDir });
		log.info('runtime-started', { dataDir: host.dataDir, agent: this.agentName });
	}

	/**
	 * Subscribe the runtime-level lifecycle observer on the host's existing
	 * `application.events` bus (the same bus the daemon's GlobalEvent pump
	 * reads). The bus already projects every turn — direct or internally
	 * admitted, marked `source: 'background-task-delivery'` for delivery
	 * activations — with the terminal taken from the REAL runtime terminal
	 * event, so outcomes are never inferred from stream sentinels here.
	 */
	private beginInternalTurnObservation(host: CreatedLocalRuntimeHost): void {
		const events = host.application?.events;
		if (!events) {
			log.debug('internal-turn-observer-unavailable', {});
			return;
		}
		const abort = new AbortController();
		this.observerAbort = abort;
		this.observerTask = (async () => {
			try {
				for await (const event of events.watch(abort.signal)) {
					if (event.type === 'session.start') {
						this.observeInternalTurnStart(event.payload);
						continue;
					}
					if (
						event.type === 'session.finish' ||
						event.type === 'session.error' ||
						event.type === 'session.abort'
					) {
						this.observeInternalTurnTerminal(event);
					}
				}
			} catch (error) {
				// A broken observation bus must never take the adapter down: the
				// client-pump feed keeps working, only internal turns go unseen.
				log.warn('internal-turn-observer-failed', { err: error });
			}
		})();
	}

	/**
	 * Project one internally activated owner turn onto the feed: a
	 * `session.start` that the lifecycle observer marked as a background-task
	 * delivery activation on THIS adapter's Session. Everything else — client
	 * turns (no source), queued drains, CHILD sessions — keeps its existing
	 * emitter (the client pump) or stays out of the daemon feed.
	 */
	private observeInternalTurnStart(
		payload: Extract<GlobalEvent, { type: 'session.start' }>['payload'],
	): void {
		if (payload.source !== 'background-task-delivery') return;
		if (payload.sessionId !== this.sessionId) return;
		const turnId = payload.turnId;
		if (!turnId || this.internalTurnsById.has(turnId)) return;
		const requestId = `background-delivery:${turnId}`;
		this.internalTurnsById.set(turnId, {
			turnId,
			requestId,
			sessionId: payload.sessionId,
			startedAtMs: Date.now(),
		});
		log.info('internal-turn-started', { sessionId: payload.sessionId, turnId });
		this.stream.push({
			type: 'turn_started',
			requestId,
			sessionId: payload.sessionId,
			turnId,
			origin: 'background-delivery',
		});
		// Attach the frame relay for the wake turn's live window: a
		// live-only session stream (no replay anchor) that ends at the turn's
		// first terminal frame. Frames only — the OUTCOME below comes from the
		// real terminal event, never from a frame inference.
		void this.attachInternalTurnFramePump(payload.sessionId, requestId);
	}

	private async attachInternalTurnFramePump(sessionId: string, requestId: string): Promise<void> {
		const cli = this.cli;
		if (!cli) return;
		try {
			const opened = await cli.resumeSession({ id: sessionId });
			if (!opened.ok) return;
			this.trackPump(requestId, sessionId, opened.source, {
				emitTerminal: false,
				origin: 'background-delivery',
			});
		} catch (error) {
			log.debug('internal-turn-frame-pump-unavailable', {
				sessionId,
				err: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Settle one observed internal turn from its REAL terminal event: finish →
	 * `turn_completed`, error → `turn_failed` (with the runtime message),
	 * abort → `turn_aborted`. A failed or aborted wake is never renamed into
	 * a success by a stream sentinel (verdict §3.4 outcome rule).
	 */
	private observeInternalTurnTerminal(event: InternalTurnTerminalEvent): void {
		const turnId = event.payload.turnId;
		if (!turnId) return;
		const observed = this.internalTurnsById.get(turnId);
		if (!observed || observed.sessionId !== event.payload.sessionId) return;
		this.internalTurnsById.delete(turnId);
		const base = {
			requestId: observed.requestId,
			sessionId: observed.sessionId,
			turnId,
			origin: 'background-delivery' as const,
		};
		if (event.type === 'session.finish') {
			this.stream.push({ type: 'turn_completed', ...base });
			return;
		}
		if (event.type === 'session.abort') {
			this.stream.push({ type: 'turn_aborted', ...base });
			return;
		}
		const error =
			event.payload.error?.trim() ||
			event.payload.errorDetail?.trim() ||
			`turn failed with session_status "error"${event.payload.errorCode !== undefined ? ` (errorCode ${event.payload.errorCode})` : ''}`;
		this.stream.push({ type: 'turn_failed', ...base, error });
	}

	/**
	 * Initial profile lease sync, bounded: the common case is a credential
	 * file read (milliseconds), but a STALE token forces a network refresh
	 * and a slow identity provider must not hold the daemon socket hostage.
	 * A lease that lands after the deadline still populates the session
	 * cache in the background and serves subsequent turns.
	 */
	private async syncInitialAuthLease(): Promise<void> {
		if (!this.authSession) return;
		const startedAtMs = Date.now();
		const outcome = await Promise.race([
			this.authSession.lease().then(() => 'synced' as const),
			boundedWait(AUTH_SYNC_WAIT_MS).then(() => 'timeout' as const),
		]);
		if (outcome === 'timeout') {
			log.warn('auth-lease-slow', { waitMs: Date.now() - startedAtMs });
		}
	}

	private resolveConfigGetter(): () => LocalRuntimeConfig {
		// The default product config resolves against the process HOME; a
		// daemon rooted elsewhere must keep its own dataDir (the data plane,
		// not the control root).
		if (this.configGetter) return this.configGetter;
		const dataDir = this.dataDir;
		let warnedFallback = false;
		return () => {
			const config = { ...getDefaultLocalRuntimeConfig(), dataDir };
			const fallback = daemonDefaultModelFallback(config);
			if (!fallback) return config;
			// One warn per adapter life: the route/preset/model triple is what
			// explains a later turn_model_gate refusal (or its absence).
			if (!warnedFallback) {
				warnedFallback = true;
				log.warn('default-model-unavailable', {
					preset: getRuntimePresetKey(),
					from: config.defaultModel ?? '',
					to: fallback.defaultModel ?? '',
				});
			}
			return fallback;
		};
	}

	private async submitInner(submission: RuntimeSubmission): Promise<void> {
		if (this.closing) throw new Error('runtime adapter is closed');
		await this.start();
		const cli = this.cli;
		if (!cli) throw new Error('runtime adapter failed to start');
		switch (submission.kind) {
			case 'prompt':
				await this.submitPrompt(cli, submission);
				return;
			case 'steer':
			case 'follow_up':
				await this.submitQueuedInput(cli, submission);
				return;
		}
	}

	private async submitPrompt(
		cli: CliService,
		submission: RuntimeSubmission,
	): Promise<void> {
		const sessionId = await this.ensureSession(cli);
		this.stream.push({
			type: 'turn_started',
			requestId: submission.requestId,
			sessionId,
			kind: submission.kind,
		});
		const opened = await cli.sendMessage({ id: sessionId, content: submission.message });
		if (!opened.ok) {
			const body = opened.body;
			const error = `runtime rejected prompt (${body.sseErrorCode}/${body.key}): ${body.message}`;
			log.warn('prompt-rejected', { requestId: submission.requestId, sessionId, key: body.key });
			this.stream.push({
				type: 'turn_failed',
				requestId: submission.requestId,
				sessionId,
				error,
			});
			throw new Error(error);
		}
		this.trackPump(submission.requestId, sessionId, opened.source);
	}

	private async submitQueuedInput(
		cli: CliService,
		submission: RuntimeSubmission,
	): Promise<void> {
		if (submission.kind === 'prompt') return;
		const kind: Exclude<RuntimeSubmission['kind'], 'prompt'> = submission.kind;
		const sessionId = await this.ensureSession(cli);
		const queued = await cli.enqueueMessage({
			id: sessionId,
			content: submission.message,
			clientRequestId: submission.requestId,
		});
		let steered = false;
		if (submission.kind === 'steer') {
			// Steer only makes sense against a running Turn; without one the
			// queued item is left for the regular queue dispatch (follow-up).
			const active = await cli.getActiveTurn(sessionId);
			if (active && queued.itemId) {
				const steeredResult = await cli.steerSession({
					id: sessionId,
					queueItemId: queued.itemId,
				});
				steered = steeredResult.success;
			}
		}
		log.debug('input-queued', {
			requestId: submission.requestId,
			sessionId,
			kind,
			itemId: queued.itemId,
			steered,
		});
		this.stream.push({
			type: 'input_queued',
			requestId: submission.requestId,
			sessionId,
			kind,
			...(queued.itemId !== undefined ? { itemId: queued.itemId } : {}),
			...(queued.status !== undefined ? { status: queued.status } : {}),
			steered,
		});
	}

	private async ensureSession(cli: CliService): Promise<string> {
		if (this.sessionId) return this.sessionId;
		const request: CreateSessionReq = {
			name: this.agentName,
			workspaceDir: this.workspaceDir,
			title: 'mcoded',
		};
		const created = await cli.createSession(request);
		if (!created.sessionId) {
			throw new Error('runtime returned no sessionId for the daemon Session');
		}
		this.sessionId = created.sessionId;
		log.info('session-created', {
			sessionId: created.sessionId,
			agentName: created.agentName ?? this.agentName,
		});
		return created.sessionId;
	}

	/**
	 * Relay one turn's frame stream into the adapter event stream.
	 *
	 * `options.emitTerminal: false` attaches a FRAME-ONLY pump (used for
	 * internally activated turns whose outcome is owned by the runtime
	 * lifecycle observer): the frames are relayed, but the terminal event is
	 * never inferred here — exactly one emitter per turn.
	 */
	private trackPump(
		requestId: string,
		sessionId: string,
		source: AsyncIterable<SessionStreamFrameView> | Iterable<SessionStreamFrameView>,
		options?: { readonly emitTerminal?: boolean; readonly origin?: 'background-delivery' },
	): void {
		const pump: TurnPump = {
			requestId,
			sessionId,
			promise: this.pumpTurn(requestId, sessionId, source, options).finally(() => {
				this.pumps.delete(pump);
			}),
		};
		this.pumps.add(pump);
	}

	private async pumpTurn(
		requestId: string,
		sessionId: string,
		source: AsyncIterable<SessionStreamFrameView> | Iterable<SessionStreamFrameView>,
		options?: { readonly emitTerminal?: boolean; readonly origin?: 'background-delivery' },
	): Promise<void> {
		// The delivery layer terminates every stream (success or not) with
		// "[DONE]"; the OUTCOME rides the last `session_status` frame, so a
		// failed turn must not surface as turn_completed (round-2 finding: the
		// old relay masked the error behind the successful terminator).
		let finalStatus: TerminalSessionStatusView | undefined;
		try {
			for await (const frame of source) {
				if (frame.dataJson === '[DONE]') break;
				const status = readSessionStatus(frame);
				if (status) finalStatus = status;
				this.stream.push({
					type: 'turn_frame',
					requestId,
					sessionId,
					frame,
					...(options?.origin ? { origin: options.origin } : {}),
				});
			}
			// Frame-only pumps (internal turns) never emit a terminal: the
			// lifecycle observer owns the outcome from the real terminal event.
			if (options?.emitTerminal === false) return;
			if (finalStatus?.type === 'error') {
				const error = turnFailureMessage(finalStatus);
				log.warn('turn-failed', { requestId, sessionId, error: error.slice(0, 200) });
				this.stream.push({ type: 'turn_failed', requestId, sessionId, error });
				return;
			}
			this.stream.push({ type: 'turn_completed', requestId, sessionId });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (options?.emitTerminal === false) {
				log.debug('internal-turn-pump-failed', { requestId, sessionId, err: error });
				return;
			}
			log.warn('turn-pump-failed', { requestId, sessionId, err: error });
			this.stream.push({ type: 'turn_failed', requestId, sessionId, error: message });
		}
	}

	private async closeOnce(): Promise<void> {
		// Graceful drain order (Wave 1, verdict §3.4; Wave 4 §5.4 №18): stop new
		// admissions (`closing` gates `submitInner`), drain every in-flight turn
		// pump, and only THEN end the event stream. The push-after-end guard of
		// `PushableIterable` stays in place — the old end-before-drain order
		// silently dropped the terminal events of turns that were still
		// relaying, tearing the final outcome off the feed. `stop()` (the
		// daemon's "stop relaying now" edge) still ends the stream first; after
		// it, pumps drain without a live feed.
		//
		// The lifecycle OBSERVER must stay subscribed through the host close:
		// a reactive wake Turn still in flight settles during the shutdown and
		// its true outcome (completed, or an honest turn_aborted when the
		// runtime's graceful stop kills it) travels through the observer —
		// aborting it first tore the terminal off exactly those wakes. The
		// observer cannot simply be awaited (the lifecycle bus stays open while
		// the host lives), so it is stopped only after the host closed and its
		// bus ended the watch — with a bounded grace in case a broken bus never
		// returns.
		const drains: Promise<unknown>[] = [...this.pumps].map((pump) => pump.promise);
		await Promise.allSettled(drains);
		const host = this.host;
		this.host = undefined;
		this.cli = undefined;
		this.starting = undefined;
		this.internalTurnsById.clear();
		if (host) {
			try {
				await host.apiHost.close();
			} finally {
				await host.metricsClient.close().catch(() => undefined);
			}
		}
		this.observerAbort?.abort();
		if (this.observerTask) {
			await Promise.allSettled([
				Promise.race([
					this.observerTask,
					new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, INTERNAL_TURN_OBSERVER_DRAIN_GRACE_MS);
						timer.unref?.();
					}),
				]),
			]);
		}
		this.stream.end();
		this.authSession?.dispose();
	}
}

/** Terminal `session_status` payload of the last frame of a turn stream. */
interface TerminalSessionStatusView {
	readonly type: string;
	readonly message?: string;
	readonly errorCode?: number;
	readonly errorDetail?: string;
}

/**
 * Extract the `session_status` payload from one stream frame, or `undefined`.
 *
 * The v2 delivery layer frames turn state as
 * `{"type":"session_status","session_status":{...}}` (see
 * `session-stream-delivery.ts`); the turn-terminal frame is the LAST such
 * frame before the `"[DONE]"` sentinel. Parsing is guarded and only attempted
 * when the sentinel field name is present, so plain data frames never pay for
 * a `JSON.parse`.
 */
function readSessionStatus(frame: SessionStreamFrameView): TerminalSessionStatusView | undefined {
	const dataJson = frame.dataJson;
	if (!dataJson || dataJson === '[DONE]' || !dataJson.includes('"session_status"')) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(dataJson);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const status = (parsed as { session_status?: unknown }).session_status;
	if (typeof status !== 'object' || status === null) return undefined;
	const record = status as Record<string, unknown>;
	if (typeof record['type'] !== 'string') return undefined;
	return {
		type: record['type'],
		...(typeof record['message'] === 'string' ? { message: record['message'] } : {}),
		...(typeof record['errorCode'] === 'number' ? { errorCode: record['errorCode'] } : {}),
		...(typeof record['errorDetail'] === 'string' ? { errorDetail: record['errorDetail'] } : {}),
	};
}

/** Client-facing failure reason for a turn that ended in `session_status "error"`. */
function turnFailureMessage(status: TerminalSessionStatusView): string {
	return (
		status.message ??
		status.errorDetail ??
		(status.errorCode !== undefined
			? `turn failed with session_status "error" (errorCode ${status.errorCode})`
			: 'turn failed with session_status "error"')
	);
}

/** Split a `provider/model` config key; `undefined` pair when malformed. */
function splitDefaultModelKey(
	value: string | undefined,
): { readonly provider: string; readonly modelId: string } | undefined {
	const raw = value?.trim();
	const slash = raw?.indexOf('/') ?? -1;
	if (!raw || slash <= 0 || slash === raw.length - 1) return undefined;
	return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

/**
 * Round-2 model-gate fix: the daemon's config default must resolve to a model
 * the selected route can actually call. When the effective config's
 * `defaultModel` fails the shared route gate (or is absent/malformed), fall
 * back to the runtime preset's managed entry (`minimax/MiniMax-M3.1-Flash`
 * with the official catalog); a valid selection is returned untouched.
 */
function daemonDefaultModelFallback(config: LocalRuntimeConfig): LocalRuntimeConfig | undefined {
	const presetKey = getRuntimePresetKey();
	const key = splitDefaultModelKey(config.defaultModel);
	if (key) {
		const availability = resolveModelAvailability({
			config,
			providerId: key.provider,
			modelId: key.modelId,
			preset: presetKey,
			source: 'config_default',
		});
		if (availability.available) return undefined;
	}
	const preset = DEFAULT_MODEL_PRESETS[presetKey];
	return {
		...config,
		provider: { ...config.provider, minimax: preset.provider.minimax },
		defaultModel: preset.defaultModel,
	};
}

/** Lease refresh margin: renew this long before the access token expires. */
const AUTH_LEASE_MIN_VALIDITY_MS = 60_000;

/**
 * Retry cadence after a failed lease refresh. The refresh chain must never
 * die permanently (a dead chain strands the daemon without a managed bearer
 * until the process restarts), so every failed lease re-arms the timer with a
 * doubling delay: 30 s first, capped at 5 min. A successful lease resets the
 * ramp.
 */
const AUTH_LEASE_RETRY_BASE_MS = 30_000;
const AUTH_LEASE_RETRY_MAX_MS = 300_000;

/** Bounded wait for the initial auth sync before the daemon starts serving. */
const AUTH_SYNC_WAIT_MS = 10_000;

/** Resolve after `ms`; the timer is unref'd so it never holds the process. */
function boundedWait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * The profile's shared OAuth core over the SERVED dataDir's credential store
 * (the SAME `auth/<buildEnv>/<region>/<clientId>` namespace the CLI login
 * writes, packages/oauth-core). The namespace is built from `options.dataDir`
 * — the data directory the runtime actually serves (opus 2026-11-01): the
 * profile (`options.profile`, else the default one) is a log label only and
 * the profile ENV is never consulted here, so a `MINIMAX_PROFILE` that
 * disagrees with the served dataDir cannot pull creds from another store.
 * `undefined` when the OAuth endpoints cannot be resolved from this
 * environment — callers degrade (signed-out or misconfigured surface), never
 * a daemon failure.
 */
export function createProfileOAuthCore(
	options: LocalRuntimeAdapterAuthOptions,
): MCodeOAuthCore | undefined {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? env['HOME'] ?? os.homedir();
	const profile = 'profile' in options ? normalizeProfileSelector(options.profile) : null;
	const authScope = { region: getRuntimeRegion(), buildEnv: getRuntimeBuildEnv() };
	const logProfile = profile ?? 'default';

	let endpoints;
	try {
		endpoints = resolveMCodeOAuthEndpointConfig(env, authScope);
	} catch (error) {
		log.warn('auth-endpoints-unresolved', { err: error });
		return undefined;
	}
	// The credential store follows the data plane: the explicit dataDir wins;
	// without one the explicit profile's primary directory is the embedder
	// fallback (env-derived profiles are NOT resolved on this path).
	const dataDir = options.dataDir ?? resolveProfileDataDirPaths(profile, homeDir).dataDir;
	const namespace = createAuthNamespace({
		dataDir,
		buildEnv: authScope.buildEnv,
		region: authScope.region,
	});
	return new MCodeOAuthCore({
		namespace,
		oauthClient: new HttpOAuthClient(endpoints),
		credentialStore: createCredentialStore({ authHome: namespace.namespaceHome }),
		initialize: () => migrateLegacyAuthNamespace(namespace),
	});
}

/**
 * Product auth session: read the shared OAuth credential store of the SERVED
 * dataDir (packages/oauth-core, via {@link createProfileOAuthCore}) and keep a
 * renewed access token available for the runtime host's model resolver.
 * Signed-out profiles degrade to `undefined` auth — the pre-fix behavior —
 * with a logged reason, never a daemon failure.
 */
export function createProfileAuthSession(
	options: LocalRuntimeAdapterAuthOptions,
): LocalRuntimeAdapterAuthSession | undefined {
	const core = createProfileOAuthCore(options);
	if (!core) return undefined;
	const env = options.env ?? process.env;
	const profile = 'profile' in options ? normalizeProfileSelector(options.profile) : null;
	const logProfile = profile ?? 'default';

	let cachedLease: AccessTokenLease | undefined;
	let refreshTimer: NodeJS.Timeout | undefined;
	let retryDelayMs = AUTH_LEASE_RETRY_BASE_MS;

	const clearRefresh = (): void => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
		}
	};
	const scheduleRefresh = (expiresAtMs: number): void => {
		clearRefresh();
		// A fresh lease resets the retry ramp alongside the normal schedule.
		retryDelayMs = AUTH_LEASE_RETRY_BASE_MS;
		const delayMs = Math.max(0, expiresAtMs - Date.now() - AUTH_LEASE_MIN_VALIDITY_MS);
		refreshTimer = setTimeout(() => void lease(), delayMs);
		refreshTimer.unref?.();
	};
	/** Re-arm the refresh chain after a failed lease, with doubling backoff. */
	const scheduleRetry = (): void => {
		clearRefresh();
		const delayMs = retryDelayMs;
		retryDelayMs = Math.min(retryDelayMs * 2, AUTH_LEASE_RETRY_MAX_MS);
		refreshTimer = setTimeout(() => void lease(), delayMs);
		refreshTimer.unref?.();
	};
	const toAuthContext = (lease: AccessTokenLease): LocalRuntimeAuthContext => ({
		accessToken: lease.accessToken,
		...(lease.loginEpoch ? { loginEpoch: lease.loginEpoch } : {}),
	});
	const lease = async (): Promise<LocalRuntimeAuthContext | undefined> => {
		try {
			const refreshed = await core.getAccessToken({
				requiredScopes: [...MCODE_OAUTH_SCOPES],
				minValidityMs: AUTH_LEASE_MIN_VALIDITY_MS,
			});
			cachedLease = refreshed;
			scheduleRefresh(refreshed.expiresAtMs);
			log.info('auth-lease-synced', { profile: logProfile, expiresAtMs: refreshed.expiresAtMs });
			return toAuthContext(refreshed);
		} catch (error) {
			// Transient failure (unreachable identity provider, store hiccup):
			// KEEP the last known lease — it may still be valid, and a managed
			// 401 recovers through `authContextInvalidator` under this chain.
			// Only the signed-out family degrades to `undefined` auth — the
			// pre-fix behavior: turns fail with the resolver's credential error.
			if (requiresInteractiveLogin(error)) {
				cachedLease = undefined;
			}
			// Either way the refresh chain keeps running: a retry with backoff
			// picks up a recovered network or a later CLI login into the shared
			// store without a daemon restart.
			log.warn('auth-lease-unavailable', { profile: logProfile, err: error });
			scheduleRetry();
			return undefined;
		}
	};

	return {
		authContextGetter: () => (cachedLease ? toAuthContext(cachedLease) : undefined),
		authContextInvalidator: async (rejectedAccessToken?: string, loginEpoch?: string) => {
			const current = cachedLease;
			if (!current) return;
			if (rejectedAccessToken !== undefined && rejectedAccessToken !== current.accessToken) return;
			if (
				loginEpoch !== undefined &&
				current.loginEpoch !== undefined &&
				loginEpoch !== current.loginEpoch
			) {
				return;
			}
			try {
				await core.handleUnauthorized({
					generation: current.generation,
					...(current.loginEpoch ? { loginEpoch: current.loginEpoch } : {}),
				});
			} catch (error) {
				// A concurrent re-login (AuthSessionChanged) leaves a FRESH
				// credential in the store: a plain re-lease recovers it; a real
				// sign-out fails the lease and clears the cache either way.
				log.warn('auth-refresh-failed', { profile: logProfile, err: error });
				await lease();
				return;
			}
			await lease();
		},
		lease,
		dispose: clearRefresh,
	};
}
