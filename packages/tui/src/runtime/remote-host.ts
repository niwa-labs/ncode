/**
 * The W4 remote runtime host (arch §4.4, §4.6, §6-W4): the TUI as a THIN
 * CLIENT of the mcoded daemon.
 *
 * What lives here, exactly:
 * - {@link createDaemonAutoSpawnHook} — the §4.6.2 п.2 spawn.lock dance the
 *   client runs on ENOENT/ECONNREFUSED: take the CAS lock (a concurrent
 *   window's spawn is a no-op for the loser), RE-probe the socket (the
 *   winner's daemon may already serve), then start `daemon run` detached
 *   with the data-plane env explicitly fixed;
 * - {@link TuiRemoteCliService} — the port adapter over {@link RemoteCliService}
 *   that owns the three seams W3 pinned in `mcoded/src/client.ts`:
 *     · the abort REMAP — `ctx.signal` never crosses the wire; aborting it
 *       issues `stream.cancel{mode:'abort'}` (W0 F3: the only remote cancel);
 *     · the sync minority — `isGoalEnabled()` is a cached snapshot refreshed
 *       at connect and on every reconnect (a roundtrip cannot be sync);
 *     · `replyPermission` re-attaches the session id the daemon's ask push
 *       carried, so the §4.5 attach rule admits the window's own replies;
 * - {@link createRemoteRuntimeHost} — connect + handshake + spawn hook,
 *   exposing the same `cliService`/`apiHost.close()` shape the TUI lifecycle
 *   consumes from the embedded host, plus an honest connection-state surface
 *   for the status line (`reconnecting` is a STATE, never a spinner).
 *
 * The OFF path never touches this module: `lifecycle.ts` branches on
 * `resolveServerMode()` and `off` (the product default) builds the embedded
 * host exactly as before.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createLogger } from '@mavis/logging';

import {
  DEFAULT_PROFILE_NAME,
  LEGACY_PROFILE_ENV_VAR,
  PROFILE_ENV_VAR,
  ensureControlRootLayout,
  getRuntimeBuildEnv,
  getRuntimeRegion,
  resolveMcodedSocketPath,
  resolveServerMode,
  type ServerMode,
} from '@mavis/config';
import {
  CrashLoopWatchdog,
  FileLockHeldError,
  McodedClient,
  McodedRemoteError,
  RemoteCliService,
  type DaemonTargets,
  type McodedClientHandshake,
  type McodedClientOptions,
  type McodedClientState,
  type RemoteEventStream,
  type RemoteStream,
  type SessionToolEnv,
  MCODED_LOG_DIR_BASENAME,
  acquireFileLock,
  helloDaemon,
  openDaemonLogFd,
  isPidAlive,
  readDaemonManifest,
  readDaemonToken,
  resolveDaemonTargets,
  SPAWN_LOCK_BASENAME,
} from '@mavis/mcoded';
import type {
  CliSendMessageOptions,
  CliSendMessageReq,
  CliService,
  ResumeSessionReq,
  SessionStreamErrorBody,
  SessionStreamFrameView,
} from '@mavis/local-runtime-v2/cli-service';
import type { ProcessLocalStreamResult } from '@mavis/conversation-contract';
import type { GlobalEvent } from '@mavis/shared/global-events';

/**
 * Client-side logger of the thin-client seams (`mcode:rpc`, the same
 * namespace the `McodedClient` uses — WARN lines pass the owner's
 * `warn,mcode:wire:error` filter, verdict §2.2(а)).
 */
const log = createLogger('mcode:rpc');

/** The connection state the window's status line renders. */
export type { McodedClientState };

/** Seams of the auto-spawn hook (tests inject every side effect). */
export interface DaemonSpawnSeams {
  /**
   * Starts the daemon child; defaults to a detached `daemon run` spawn. The
   * O_APPEND log fd (`openDaemonLogFd`, design 15) is opened by the hook
   * BEFORE this seam so both the real spawner and test seams see the same
   * child env — including the `MCODED_LOG_FILE` declaration.
   */
  readonly spawnDaemon?: (options: {
    argv: readonly string[];
    env: NodeJS.ProcessEnv;
    logFd: number;
  }) => {
    readonly unref: () => void;
    readonly pid?: number;
  };
  /** Live probe; defaults to "the daemon manifest answers hello" shape. */
  readonly daemonAlive?: () => Promise<boolean>;
  /** Sleep between probe rounds. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Options of {@link createDaemonAutoSpawnHook}. */
export interface DaemonAutoSpawnOptions {
  readonly targets: DaemonTargets;
  /** The WINDOW's env; the child gets it plus the fixed data-plane vars. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly seams?: DaemonSpawnSeams;
}

/**
 * env name families the window never puts on the wire (revision 11 F3):
 * - `MCODE_*`/`MINIMAX_*` — daemon-reserved (the daemon's sanitizer re-strips
 *   them; the window filters first so the values never cross the wire);
 * - `__MAVIS_*` — runtime identity (`__MAVIS_RUNTIME_*`) and the mcode-tools
 *   broker surface (`__MAVIS_MCODE_TOOLS_*`): the daemon owns both after the
 *   daemon-owned readiness (revision 11 F2), and a window value overlaid on
 *   the daemon's tool spawns would point the session's mcode-tools at the
 *   window's broker — the exact dead-broker shape F2 closed.
 */
function isDaemonOwnedEnvName(name: string): boolean {
  return (
    name.startsWith('MCODE_') || name.startsWith('MINIMAX_') || name.startsWith('__MAVIS_')
  );
}

/**
 * The window's toolEnv snapshot (arch §4.4/R5): the current working directory
 * and the shell environment this `mcode` process was started with, filtered
 * through {@link isDaemonOwnedEnvName}. Attached with every
 * `session.attach` the thin client sends (turn starts included), so an env
 * change in the window reaches the session's tools on the NEXT turn.
 */
export function buildWindowToolEnvSnapshot(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SessionToolEnv {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || isDaemonOwnedEnvName(name)) continue;
    env[name] = value;
  }
  return { cwd, env };
}

/** Bounded wait for a freshly spawned daemon to answer (§4.6.2 п.3). */
const SPAWN_READY_TIMEOUT_MS = 20_000;
const SPAWN_PROBE_INTERVAL_MS = 200;

/**
 * The §4.6.2 п.2 dance: `spawn.lock` (CAS) → re-probe → spawn detached.
 * A {@link FileLockHeldError} means another window is already spawning —
 * the caller just retries its connect, so the hook resolves quietly.
 *
 * W5 (§4.6.4): the hook REPORTS whether it actually started a child
 * (`true`) — a no-op round (daemon alive, sibling window spawning) reports
 * `false`, which is the crash-loop watchdog's crash signal; a no-op round
 * must never count as a daemon death.
 */
export function createDaemonAutoSpawnHook(options: DaemonAutoSpawnOptions): () => Promise<boolean> {
  const env = options.environment ?? process.env;
  const seams = options.seams ?? {};
  const sleep =
    seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spawnDaemon =
    seams.spawnDaemon ??
    (({ argv, env: childEnv, logFd }: { argv: readonly string[]; env: NodeJS.ProcessEnv; logFd: number }) => {
      const child = spawn(argv[0] as string, argv.slice(1) as string[], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: childEnv,
      });
      child.unref();
      return child;
    });
  // A stale manifest is not a live daemon: the default probe is a real
  // hello with the manifest's OWN dataDir binding, the control-root token,
  // and the window's env identity, so a dead-but-manifested daemon still
  // reads as "not alive" (and a live one refuses us if the env genuinely
  // mismatches — which must surface, not be papered over by a second spawn
  // that mcoded.lock would refuse). The dataDir was MISSING until the
  // login-wave integration test caught it (2026-11-02): the product daemon
  // refuses a dataDir-less hello with DATA_DIR_MISMATCH (hub.ts requires
  // the binding), so the readiness wait never saw the child alive and
  // every spawn burned the full SPAWN_READY_TIMEOUT_MS before the client
  // even retried — plus a phantom crash-loop entry per cold spawn.
  const daemonAlive =
    seams.daemonAlive ??
    (async () => {
      const manifest = readDaemonManifest(options.targets.controlRoot);
      if (manifest === undefined) return false;
      const token = readDaemonToken(options.targets.controlRoot);
      const probe = await helloDaemon(manifest.socketPath, {
        ...(token !== undefined ? { token } : {}),
        dataDir: manifest.dataDir,
        env: { region: getRuntimeRegion(), buildEnv: getRuntimeBuildEnv() },
        timeoutMs: 1_000,
      });
      return probe.ok;
    });
  return async () => {
    let lock;
    try {
      lock = acquireFileLock(path.join(options.targets.controlRoot, SPAWN_LOCK_BASENAME));
    } catch (error) {
      if (error instanceof FileLockHeldError) return false; // a sibling window is spawning
      throw error;
    }
    try {
      // The lock winner re-probes FIRST (fast): the winner of a PREVIOUS
      // round may have finished starting the daemon while we waited for
      // the lock. Still dead → this window spawns.
      if (await daemonAlive()) return false;
      // §4.6.2 п.2: the child is `daemon run` with the data plane FIXED —
      // region/buildEnv/dataDir/profile — and the SERVER_MODE gate pinned
      // to `auto` for the child only (the caller's env stays untouched).
      const script = process.argv[1];
      if (!script) throw new Error('Cannot auto-spawn mcoded: no entry script (process.argv[1]).');
      // The child inherits the RESOLVED identity, never the wrapper's env
      // (login wave 2026-11-02): a default-identity window (targets.profile
      // === null) under MINIMAX_PROFILE=cedar used to spawn `daemon run
      // --data-dir ~/.minimax` with NO profile flag, and the child then read
      // `cedar` from the inherited env — a mismatch with its own --data-dir
      // killed the daemon and the window hung on "Starting server…". So the
      // argv always spells the identity out (`default` for the implicit one)
      // and childEnv carries exactly one profile selector: set for a named
      // profile, BOTH of them stripped for the implicit one — the child must
      // resolve its identity from the flag, exactly as the window did.
      const profile = options.targets.profile || null;
      const childEnv: NodeJS.ProcessEnv = {
        ...env,
        MINIMAX_DATA_DIR: options.targets.dataDir,
        MAVIS_REGION: getRuntimeRegion(),
        MAVIS_BUILD_ENV: getRuntimeBuildEnv(),
        ...(profile !== null ? { [PROFILE_ENV_VAR]: profile } : {}),
      };
      if (profile === null) {
        delete childEnv[PROFILE_ENV_VAR];
        delete childEnv[LEGACY_PROFILE_ENV_VAR];
      }
      const mode = childEnv['MCODE_SERVER_MODE']?.trim().toLowerCase();
      if (mode === undefined || mode === '' || mode === 'off') {
        childEnv['MCODE_SERVER_MODE'] = 'auto';
      }
      // The control root must exist at 0700 before any child writes into it.
      ensureControlRootLayout(options.targets.controlRoot);
      // Design 15: the spawner half of log rotation — pre-rotate an
      // over-ceiling log (М3), open the O_APPEND fd BOTH stdio of the child
      // are handed, and declare `MCODED_LOG_FILE` so the daemon's own
      // copytruncate (М2) knows fd 2 is this exact file.
      const logTarget = openDaemonLogFd(options.targets.controlRoot, childEnv);
      try {
        spawnDaemon({
          argv: [
            process.execPath,
            script,
            'daemon',
            'run',
            '--data-dir',
            options.targets.dataDir,
            '--profile',
            profile ?? DEFAULT_PROFILE_NAME,
          ],
          env: logTarget.childEnv,
          logFd: logTarget.fd,
        });
      } finally {
        fs.closeSync(logTarget.fd);
      }
      // §4.6.2 п.3: bounded wait for readiness, so the connect loop's next
      // attempt finds a serving socket instead of re-entering the hook.
      const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS;
      while (!(await daemonAlive())) {
        if (Date.now() > deadline) return true; // started, but never got ready — a crash candidate
        await sleep(SPAWN_PROBE_INTERVAL_MS);
      }
      return true;
    } finally {
      lock.release();
    }
  };
}

/** The `watchEvents` projection the TUI port consumes. */
export interface TuiWatchEventsStream {
  readonly events: AsyncGenerator<GlobalEvent>;
  readonly gapped: Promise<{ after: string; head: string | null } | undefined>;
  stop(): void;
  /**
   * The stream IS the event iterator: the product consumer iterates the
   * `watchEvents(...)` result directly (`TuiEventAccess.watch`:
   * `for await (const event of cliService.watchEvents(signal))`), so the
   * projection forwards `Symbol.asyncIterator` to the same generator.
   */
  [Symbol.asyncIterator](): AsyncGenerator<GlobalEvent>;
}

/**
 * The port adapter over {@link RemoteCliService}. Every method NOT named
 * below delegates unchanged; the class owns only the pinned deltas.
 */
export class TuiRemoteCliService {
  private readonly client: McodedClient;
  private readonly remote: RemoteCliService;
  private goalEnabled = false;
  /** requestId → sessionId of asks this window has SEEN (push + snapshot). */
  private readonly askSessions = new Map<string, string>();
  /** Sessions this window VIEWED — the re-attach set after a replay gap. */
  private readonly attachedSessions = new Set<string>();
  /** Bounded wait for the client's reconnect during a turn reattach. */
  private readonly reattachReadyMs: number;
  /** Backoff sleep between reattach attempts (tests inject a clock). */
  private readonly reattachSleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;

  constructor(
    client: McodedClient,
    remote: RemoteCliService,
    options: {
      reattachReadyMs?: number;
      reattachSleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
    } = {},
  ) {
    this.client = client;
    this.remote = remote;
    this.reattachReadyMs = options.reattachReadyMs ?? REATTACH_READY_MS;
    this.reattachSleep = options.reattachSleep ?? delayWithAbort;
    this.client.onReconnected(() => {
      void this.refreshGoalEnabled();
      // Reconnect (§4.6.3): the client re-attaches its held attachments and
      // re-subscribes; the wrapper refreshes its derived state so the reply
      // map and the sync snapshot stay honest for the new daemon life.
      void this.refreshSnapshot();
    });
  }

  /** Cache the sync flag at connect and on every reconnect (honest snapshot). */
  async refreshGoalEnabled(): Promise<void> {
    try {
      this.goalEnabled = await this.remote.isGoalEnabled();
    } catch {
      this.goalEnabled = false;
    }
  }

  /** The sync seam: a daemon-minted snapshot, not a roundtrip lie. */
  isGoalEnabled(): boolean {
    return this.goalEnabled;
  }

  /**
   * The abort remap (W0 F3): the signal becomes `stream.cancel{mode:'abort'}`;
   * a plain `source.return()` (queue-continue closes its reader) only stops
   * consuming — the daemon-side turn keeps running (I-DETACH).
   */
  async sendMessage(
    req: CliSendMessageReq,
    ctx?: { signal?: AbortSignal },
    options?: CliSendMessageOptions,
  ): Promise<ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>> {
    ctx?.signal?.throwIfAborted();
    const sessionId = sessionIdOf(req);
    await this.attachBestEffort(sessionId);
    const opened = await this.openTurnStream('sendMessage', options ? [req, options] : [req]);
    if (!opened.ok) return opened;
    return {
      ok: true,
      source: abortAwareSource(opened.source, ctx?.signal, {
        sessionId: sessionId ?? '',
        ...(typeof req.turnId === 'string' ? { turnId: req.turnId } : {}),
        readyMs: this.reattachReadyMs,
        sleep: this.reattachSleep,
        resume: (afterCursor, afterMsgId) => this.reopenTurnStream(sessionId, afterCursor, afterMsgId),
        waitForReady: (timeoutMs) => this.waitForClientReady(timeoutMs),
      }),
    };
  }

  async resumeSession(
    req: ResumeSessionReq,
    ctx?: { signal?: AbortSignal },
  ): Promise<ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>> {
    ctx?.signal?.throwIfAborted();
    const sessionId = sessionIdOf(req);
    await this.attachBestEffort(sessionId);
    const opened = await this.openTurnStream('resumeSession', [req]);
    if (!opened.ok) return opened;
    return {
      ok: true,
      source: abortAwareSource(opened.source, ctx?.signal, {
        sessionId: sessionId ?? '',
        readyMs: this.reattachReadyMs,
        sleep: this.reattachSleep,
        resume: (afterCursor, afterMsgId) => this.reopenTurnStream(sessionId, afterCursor, afterMsgId),
        waitForReady: (timeoutMs) => this.waitForClientReady(timeoutMs),
      }),
    };
  }

  /**
   * `watchEvents` rides `catalog+attached` (NOT `all` — an `all` window
   * would SEE other windows' approvals, breaking §4.5 isolation), tees the
   * seen asks into the reply map AND refreshes the pending-permission
   * snapshot on every ask (§4.4: push supplements polling, so the dialog
   * latency does not depend on the poll period), and stops on the caller's
   * signal. The projection is async-iterable — it IS the generator.
   */
  watchEvents(signal?: AbortSignal): TuiWatchEventsStream {
    const subscription: RemoteEventStream = this.client.subscribe({ scope: 'catalog+attached' });
    // The generator is a function expression (no lexical `this`); capture the
    // members it needs instead of aliasing `this`.
    const askSessions = this.askSessions;
    const attachChild = (event: GlobalEvent) => this.attachDelegatedChild(event);
    const refreshSnapshotSoon = () => this.refreshSnapshotSoon();
    const iterator: AsyncGenerator<GlobalEvent> = (async function* () {
      const pendingAskIds = new Set<string>();
      const noteDelivery = (event: GlobalEvent): boolean => {
        const payload = event.payload as { requestId?: string };
        if (event.type === 'permission.resolved') pendingAskIds.delete(payload.requestId ?? '');
        if (event.type !== 'permission.ask') return true;
        const id = payload.requestId;
        if (id && pendingAskIds.has(id)) return false;
        if (id) pendingAskIds.add(id);
        return true;
      };
      try {
        for await (const entry of subscription.events) {
          if (!noteDelivery(entry.event)) continue;
          if (noteAsk(askSessions, entry.event)) refreshSnapshotSoon();
          yield entry.event;
          // First let ACP/TUI observe the ancestry, then subscribe to the child.
          // Snapshot recovery covers an ask emitted before session.attach ACK.
          for (const event of await attachChild(entry.event)) {
            if (noteDelivery(event)) yield event;
          }
        }
      } finally {
        if (signal?.aborted) subscription.stop();
      }
    })();
    signal?.addEventListener('abort', () => subscription.stop(), { once: true });
    // §4.6.3: a replay gap (event window evicted / previous daemon life)
    // means this window may have MISSED asks — refresh the snapshot (and
    // re-attach every viewed session) so nothing is silently invisible.
    void subscription.gapped.then(() => {
      void this.refreshSnapshot();
      for (const sessionId of this.attachedSessions) void this.attachBestEffort(sessionId);
    });
    return {
      events: iterator,
      gapped: subscription.gapped,
      stop: () => subscription.stop(),
      [Symbol.asyncIterator]: () => iterator,
    };
  }

  /**
   * The §4.5 snapshot, teed into the reply map. `listPendingPermissions` is
   * daemon-filtered to the window's attachments, so a window that VIEWED a
   * session (attach below) sees exactly its own pending approvals.
   */
  async listPendingPermissions(
    req?: unknown,
  ): Promise<{ requests?: Array<Record<string, unknown>> }> {
    const response = (await this.remote.listPendingPermissions(req as never)) as {
      requests?: Array<Record<string, unknown>>;
    };
    this.noteSnapshotRequests(response.requests ?? []);
    return response;
  }

  /**
   * Viewing a session ATTACHES it (§4.3.4/§4.5): the attach is the event-
   * routing and snapshot-filter key, so an opened session's approvals are
   * pushed to this window and survive a reopen of the dialog. Without this,
   * a window that never streamed a turn would never see the pending ask.
   */
  async getSession(
    req: { id?: unknown; sessionId?: unknown } & Record<string, unknown>,
  ): Promise<unknown> {
    await this.attachBestEffort(sessionIdOf(req));
    return await (this.remote.getSession as (r: unknown) => Promise<unknown>)(req);
  }

  async getMessages(
    req: { id?: unknown; sessionId?: unknown } & Record<string, unknown>,
  ): Promise<unknown> {
    await this.attachBestEffort(sessionIdOf(req));
    return await (this.remote.getMessages as (r: unknown) => Promise<unknown>)(req);
  }

  async getSessionTree(
    req: { id?: unknown; sessionId?: unknown } & Record<string, unknown>,
  ): Promise<unknown> {
    await this.attachBestEffort(sessionIdOf(req));
    return await (this.remote.getSessionTree as (r: unknown) => Promise<unknown>)(req);
  }

  async listSessionInputSummaries(
    req: { id?: unknown; sessionId?: unknown } & Record<string, unknown>,
  ): Promise<unknown> {
    await this.attachBestEffort(sessionIdOf(req));
    return await (this.remote.listSessionInputSummaries as (r: unknown) => Promise<unknown>)(req);
  }

  /** A created session is attached immediately (its first turn routes to us). */
  async createSession(req: Record<string, unknown>): Promise<unknown> {
    const response = (await (this.remote.createSession as (r: unknown) => Promise<unknown>)(
      req,
    )) as {
      session?: { id?: unknown };
    };
    const id = response.session?.id;
    if (typeof id === 'string' && id.length > 0) await this.attachBestEffort(id);
    return response;
  }

  /** `replyPermission` with the session re-attached (§4.5 attach rule). */
  async replyPermission(req: {
    name: string;
    requestId: string;
    reply: number;
    message?: string;
  }): Promise<{ success?: boolean }> {
    const sessionId = this.askSessions.get(req.requestId);
    return await this.remote.replyPermission({
      ...req,
      ...(sessionId !== undefined ? { sessionId } : {}),
    } as Parameters<typeof this.remote.replyPermission>[0]);
  }

  /** The delegated remainder of the surface (type-checked by the allowlist test). */
  get delegated(): RemoteCliService {
    return this.remote;
  }

  /** Remember the session of every ask the snapshot shows (poll parity). */
  noteSnapshotRequests(
    requests: ReadonlyArray<{ requestId?: unknown; sessionId?: unknown }>,
  ): void {
    for (const request of requests) noteSnapshotEntry(this.askSessions, request);
  }

  /**
   * One snapshot refresh at a time (asks can burst); the §4.4 "push
   * supplements polling" re-request, so the reply map does not depend on
   * the UI's poll period.
   */
  private refreshSnapshotInFlight: Promise<void> | undefined;

  private refreshSnapshotSoon(): void {
    this.refreshSnapshotInFlight ??= (async () => {
      try {
        await this.listPendingPermissions({});
      } catch {
        // The daemon may be mid-reconnect; the next ask re-triggers.
      } finally {
        this.refreshSnapshotInFlight = undefined;
      }
    })();
  }

  /** See {@link TuiRemoteCliService.refreshSnapshotSoon}. */
  private async refreshSnapshot(): Promise<void> {
    try {
      await this.listPendingPermissions({});
    } catch {
      // Same honesty: a failed refresh is retried by the next trigger.
    }
  }

  private async attachDelegatedChild(event: GlobalEvent): Promise<GlobalEvent[]> {
    if (event.type !== 'session.created') return [];
    const { sessionId, parentSessionId } = event.payload;
    if (!parentSessionId || !this.attachedSessions.has(parentSessionId)) return [];
    await this.attachBestEffort(sessionId);
    try {
      const snapshot = await this.listPendingPermissions({});
      return (snapshot.requests ?? [])
        .filter((request) => request.sessionId === sessionId && typeof request.requestId === 'string')
        .map((request) => ({
          type: 'permission.ask' as const,
          timestamp: Date.now(),
          source: 'local-runtime' as const,
          payload: {
            ...request,
            requestId: request.requestId as string,
            sessionId,
            agentName: typeof request.agentName === 'string' ? request.agentName : '',
            toolName: typeof request.toolName === 'string' ? request.toolName : '',
            ruleContents: Array.isArray(request.ruleContents) ? request.ruleContents as string[] : [],
            reason: typeof request.reason === 'string' ? request.reason : '',
            allowAlwaysSupported: request.allowAlwaysSupported === true,
            createdAt: typeof request.createdAt === 'number' ? request.createdAt : Date.now(),
          },
        }));
    } catch {
      return []; // Reconnect and the ordinary snapshot path remain available.
    }
  }

  private async attachBestEffort(sessionId: string | undefined): Promise<void> {
    if (sessionId === undefined) return;
    try {
      // Revision 11 F3 (arch §4.4/R5): every attach carries a FRESH snapshot
      // of the window's cwd/env — this is the update channel. Attach runs at
      // every turn start (`sendMessage`/`resumeSession`) and session op, so
      // the daemon's tools see the window's CURRENT shell environment on the
      // next turn, not the daemon's frozen first-spawn env. The window-side
      // filter strips the daemon-reserved families (the daemon re-strips
      // MCODE_*/MINIMAX_* on its side); `__MAVIS_*` runtime identity and the
      // mcode-tools broker keys stay out entirely — after the daemon-owned
      // broker (revision 11 F2) a window value there must never overlay the
      // daemon's own activation on tool spawns.
      await this.client.sessionAttach(sessionId, 'owner', buildWindowToolEnvSnapshot());
      this.attachedSessions.add(sessionId);
    } catch {
      // Attach best-effort: an ENV_MISMATCH or dead daemon surfaces on the
      // turn call itself with the real error.
    }
  }

  /**
   * The reattach open (verdict §2.2а п.2): `resumeSession` of the SAME
   * session from the last delivered cursor — the daemon replays its ring
   * after that cursor and re-joins the live turn. A refusal (the turn ended
   * meanwhile, the session is gone) is a failed reattach attempt, not a
   * mirrored value: the caller is mid-generator, the outcome it needs is
   * either a live stream or a detach.
   */
  private async reopenTurnStream(
    sessionId: string | undefined,
    afterCursor: string | undefined,
    afterMsgId?: string,
  ): Promise<RemoteStream<SessionStreamFrameView>> {
    if (sessionId === undefined) throw new Error('cannot reattach a turn without a session id');
    const req: ResumeSessionReq = {
      id: sessionId,
      ...(afterCursor !== undefined ? { afterCursor } : {}),
      ...(afterMsgId !== undefined ? { afterMsgId } : {}),
    };
    const opened = await this.openTurnStream('resumeSession', [req]);
    if (!opened.ok) {
      throw new Error(
        `resumeSession refused (${opened.status}): ${opened.body.message ?? 'unknown refusal'}`,
      );
    }
    return opened.source;
  }

  /**
   * Resolves when the mcoded client reaches `ready` (its reconnect loop owns
   * the re-dial and re-attach); rejects on the deadline, on a user `close()`,
   * or when the deadline is non-positive. Never dials on its own — a second
   * concurrent connect loop would fight the client's own.
   */
  private waitForClientReady(timeoutMs: number): Promise<void> {
    if (this.client.connectionState === 'ready') return Promise.resolve();
    if (timeoutMs <= 0) {
      return Promise.reject(new Error(`mcoded client is ${this.client.connectionState}, not ready`));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(
            `mcoded client did not become ready within ${timeoutMs}ms (state: ${this.client.connectionState})`,
          ),
        );
      }, timeoutMs);
      const unsubscribe = this.client.onStateChange((state) => {
        if (state !== 'ready' && state !== 'closed') return;
        clearTimeout(timer);
        unsubscribe();
        if (state === 'ready') resolve();
        else reject(new Error('mcoded client closed while waiting for the reconnect'));
      });
    });
  }

  /**
   * `stream.open` with the mirrored `{ok:false,status,body}` shape the TUI
   * adapter consumes (the hub refuses opens with the runtime's failure).
   * The refusal is a RETURN VALUE, not an exception — the thin-client
   * contract mirrors `ProcessLocalStreamResult` straight through, so
   * `conversation-access` builds the same `TuiFailure` for embedded and
   * remote modes.
   */
  private async openTurnStream(
    method: 'sendMessage' | 'resumeSession',
    params: unknown[],
  ): Promise<OpenedTurnStream> {
    try {
      return {
        ok: true,
        source: await this.client.openStream<SessionStreamFrameView>(method, params),
      };
    } catch (error) {
      if (error instanceof McodedRemoteError && error.data !== undefined) {
        const mirrored = error.data as { status?: number; body?: SessionStreamErrorBody };
        if (typeof mirrored.status === 'number') {
          return {
            ok: false,
            status: mirrored.status,
            body: mirrored.body as SessionStreamErrorBody,
          };
        }
      }
      throw error;
    }
  }
}

/** sessionId of a request (`id`, tolerant `sessionId`). */
function sessionIdOf(req: { id?: unknown; sessionId?: unknown }): string | undefined {
  const id = req.id ?? req.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * `stream.open` outcome: the live remote stream, or the mirrored refusal —
 * `ProcessLocalStreamResult` widened so the ok-branch keeps the full
 * `RemoteStream` (frames/abort/detach), not just its `AsyncIterable` face.
 */
type OpenedTurnStream =
  | { readonly ok: true; readonly source: RemoteStream<SessionStreamFrameView> }
  | { readonly ok: false; readonly status: number; readonly body: SessionStreamErrorBody };

/** Record an ask's (requestId → sessionId); `true` when it WAS an ask. */
function noteAsk(map: Map<string, string>, event: GlobalEvent): boolean {
  const type = (event as { type?: unknown }).type;
  if (type !== 'permission.ask' && type !== 'questionnaire.ask') return false;
  const payload = (event as { payload?: Record<string, unknown> }).payload ?? {};
  const requestId = payload['requestId'];
  const sessionId = payload['sessionId'];
  if (typeof requestId === 'string' && typeof sessionId === 'string') map.set(requestId, sessionId);
  return true;
}

function noteSnapshotEntry(
  map: Map<string, string>,
  request: { requestId?: unknown; sessionId?: unknown },
): void {
  if (typeof request.requestId === 'string' && typeof request.sessionId === 'string') {
    map.set(request.requestId, request.sessionId);
  }
}

/**
 * The turn source the TUI adapter iterates. Abort ⇒ `stream.cancel{abort}`
 * (the remap); a plain early return just stops reading (daemon keeps the
 * turn alive — I-DETACH).
 *
 * Wave 2 (incident 2026-11-05, verdict §2.2а): the frames iterable ending is
 * NOT the truth about the turn — `stream.ended` is. `done` and our own
 * `aborted` end the generator as before; `detached`/`error` with
 * `resumable: true` mean the window lost the stream while the turn is alive,
 * so the generator REATTACHES: bounded wait for the client's own reconnect,
 * `resumeSession` re-opened from the last delivered cursor (replayed frames
 * at or before it are dropped), same generator continues. Three attempts with
 * a 1/2/4 s backoff; exhaustion throws {@link TurnStreamDetached} — the
 * invariant "a reply to the consumer ends only at the true end of the turn"
 * (never a silent mid-turn end).
 */
export const REATTACH_READY_MS = 60_000;
/** Reattach attempts before the turn is reported detached. */
export const REATTACH_MAX_ATTEMPTS = 3;
/** Backoff between reattach attempts (exponential, 1 s → 2 s → 4 s). */
const REATTACH_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

/** Retire only the delivery reader after Runtime confirms the turn is over. */
export class TurnDeliveryRetired extends Error {}

/**
 * The turn window detached and every reattach attempt failed: the consumer
 * must learn the turn is UNCONFIRMED (it may still be running daemon-side),
 * never mistake the lost window for a finished turn. Flows as the iterator's
 * exception — the `AsyncIterable` contract allows it, no result field needed.
 */
export class TurnStreamDetached extends Error {
  readonly sessionId: string;
  readonly turnId: string | undefined;
  readonly reason: string;
  readonly attempts: number;
  /** The last reattach failure (readiness timeout, refusal, connection). */
  readonly cause: unknown;

  constructor(fields: {
    sessionId: string;
    turnId?: string;
    reason: string;
    attempts: number;
  }) {
    super(
      `turn stream detached (reason: ${fields.reason}, attempts: ${fields.attempts})`,
    );
    this.name = 'TurnStreamDetached';
    this.sessionId = fields.sessionId;
    this.turnId = fields.turnId;
    this.reason = fields.reason;
    this.attempts = fields.attempts;
  }
}

/** The reattach seams {@link abortAwareSource} needs from the service. */
interface TurnReattachSeams {
  readonly sessionId: string;
  readonly turnId?: string;
  /** Bounded wait for the client's own reconnect to reach `ready`. */
  readonly readyMs: number;
  /** Re-opens `resumeSession` from a cursor (the daemon replays after it). */
  readonly resume: (afterCursor: string | undefined, afterMsgId?: string) => Promise<RemoteStream<SessionStreamFrameView>>;
  /** Bounded wait for the mcoded client's own reconnect to reach `ready`. */
  readonly waitForReady: (timeoutMs: number) => Promise<void>;
  /** Overridable sleep (tests); resolves early on abort. */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

function abortAwareSource(
  stream: RemoteStream<SessionStreamFrameView>,
  signal: AbortSignal | undefined,
  reattach: TurnReattachSeams,
): AsyncGenerator<SessionStreamFrameView> {
  let abortSent = false;
  let activeStream = stream;
  const sendAbort = (): void => {
    if (abortSent || signal === undefined) return;
    abortSent = true;
    if (signal.reason instanceof TurnDeliveryRetired) activeStream.detach();
    else void activeStream.abort().catch(() => undefined);
  };
  signal?.addEventListener('abort', sendAbort, { once: true });
  const sleep = reattach.sleep ?? delayWithAbort;
  const iterator: AsyncGenerator<SessionStreamFrameView> = (async function* () {
    try {
      let current = stream;
      let lastCursor: string | undefined;
      let lastMessageId: string | undefined;
      let recoveredAnchor: string | undefined;
      let frames = 0;
      let skipped = 0;
      let lastProgressAt = 0;
      const startedAt = Date.now();
      log.info('turn-stream-open', { sessionId: reattach.sessionId, turnId: reattach.turnId, streamId: current.streamId });
      for (;;) {
        let resyncRequired = false;
        for await (const frame of current.frames) {
          signal?.throwIfAborted();
          const recovery = readRecoveryFrame(frame);
          if (recovery.messageId) lastMessageId = recovery.messageId;
          if (recovery.resync) resyncRequired = true;
          // A replay gap is not the end of the Turn. Recover from the last
          // durable message instead of exposing this replay's [DONE].
          if (resyncRequired) continue;
          const cursor = readFrameCursor(frame);
          // Reattach dedup (verdict §2.2а п.3): frames at or before the last
          // DELIVERED cursor are replay residue — never yield them twice.
          if (
            cursor !== undefined &&
            lastCursor !== undefined &&
            Number(cursor) <= Number(lastCursor)
          ) {
            skipped += 1;
            continue;
          }
          if (cursor !== undefined) lastCursor = cursor;
          frames += 1;
          const now = Date.now();
          if (now - lastProgressAt >= 5_000) {
            lastProgressAt = now;
            log.info('turn-stream-progress', {
              sessionId: reattach.sessionId, turnId: reattach.turnId, streamId: current.streamId,
              frames, skipped, cursor: lastCursor, elapsedMs: now - startedAt,
            });
          }
          yield frame;
        }
        const end = await current.ended;
        if (signal?.reason instanceof TurnDeliveryRetired) return;
        log.info('turn-stream-ended', {
          sessionId: reattach.sessionId, turnId: reattach.turnId, streamId: current.streamId,
          reason: end.reason, resumable: end.resumable, frames, skipped,
          cursor: lastCursor, elapsedMs: Date.now() - startedAt,
        });
        if (resyncRequired) {
          if (!lastMessageId || recoveredAnchor === lastMessageId) {
            throw new TurnStreamDetached({ sessionId: reattach.sessionId, turnId: reattach.turnId,
              reason: 'resync-durable-anchor-unavailable', attempts: 1 });
          }
          recoveredAnchor = lastMessageId;
          lastCursor = undefined;
          current = await reattachTurnStream(reattach, signal, undefined, 'resync-required', sleep, lastMessageId);
          activeStream = current;
          continue;
        }
        if (end.reason === 'done' || end.reason === 'aborted') return;
        if (end.resumable !== true) return; // unresumable end — the coordinator's net reports it
        current = await reattachTurnStream(reattach, signal, lastCursor, end.reason, sleep);
        activeStream = current;
      }
    } finally {
      signal?.removeEventListener('abort', sendAbort);
      if (signal?.aborted && !abortSent) sendAbort();
    }
  })();
  return iterator;
}

/**
 * One reattach cycle (verdict §2.2а): up to {@link REATTACH_MAX_ATTEMPTS}
 * rounds of {WARN `turn-stream-detached` → bounded `ready` wait →
 * `resumeSession` after the last cursor}, backoff 1/2/4 s in between.
 * Exhaustion throws {@link TurnStreamDetached}.
 */
async function reattachTurnStream(
  reattach: TurnReattachSeams,
  signal: AbortSignal | undefined,
  lastCursor: string | undefined,
  reason: string,
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>,
  afterMsgId?: string,
): Promise<RemoteStream<SessionStreamFrameView>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REATTACH_MAX_ATTEMPTS; attempt += 1) {
    // One WARN per detach event, with the reattach round that is about to run.
    log.warn('turn-stream-detached', {
      sessionId: reattach.sessionId,
      reason,
      attempt,
    });
    try {
      signal?.throwIfAborted();
      await reattach.waitForReady(reattach.readyMs);
      return await reattach.resume(lastCursor, afterMsgId);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error; // an aborted consumer sees its abort, never a detach
      // The full 1/2/4 s backoff — including one last grace window after the
      // final attempt, before the turn is declared detached.
      await sleep(REATTACH_BACKOFF_MS[attempt - 1] ?? 0, signal);
    }
  }
  throw new TurnStreamDetached({
    sessionId: reattach.sessionId,
    ...(reattach.turnId !== undefined ? { turnId: reattach.turnId } : {}),
    reason,
    attempts: REATTACH_MAX_ATTEMPTS,
  });
}

function readRecoveryFrame(frame: SessionStreamFrameView): { messageId?: string; resync?: boolean } {
  const text = frame.dataJson;
  if (!text || (!text.includes('"agent_message"') && !text.includes('"resume_overflow"'))) return {};
  try {
    const data = JSON.parse(text);
    if (data?.type === 'resume_overflow') return { resync: true };
    const messageId = data?.agent_message?.msg_id;
    return typeof messageId === 'string' && messageId ? { messageId } : {};
  } catch { return {}; }
}

/** The frame's delivery cursor (`SessionStreamFrameView.cursor`). */
function readFrameCursor(frame: SessionStreamFrameView): string | undefined {
  const cursor = (frame as { cursor?: unknown }).cursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

/** Sleep that wakes early on abort (a parked reattach must not delay a stop). */
function delayWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => finish();
    signal?.addEventListener('abort', onAbort, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}

/** What {@link createRemoteRuntimeHost} returns — the lifecycle-level host. */
export interface RemoteRuntimeHost {
  /** The thin-client CliService (cast at ONE site; the allowlist test guards it). */
  cliService: CliService;
  /** Resolves after connect+hello and the initial sync snapshot. */
  ready: Promise<void>;
  /** Same shape as the embedded host's — the shutdown path calls it. */
  apiHost: { close(): Promise<void> };
  /**
   * §4.4: the embedded host's `notifyAuthContextChanged` becomes the
   * `daemon.authSync` RPC — the daemon re-reads the OAuth store.
   */
  notifyAuthContextChanged(authState: 'authenticated' | 'logged_out'): Promise<void>;
  /** Honest connection state for the status line (`reconnecting` ≠ spinner). */
  connectionState(): McodedClientState;
  onConnectionStateChange(listener: (state: McodedClientState) => void): () => void;
  readonly clientInstanceId: string;
  readonly socketPath: string;
}

/** Options of {@link createRemoteRuntimeHost}. */
export interface CreateRemoteRuntimeHostOptions {
  readonly dataDir: string;
  /** Management commands may reuse an owner, but must never start one. */
  readonly autoSpawn?: boolean;
  readonly profile?: string;
  readonly homeDir?: string;
  readonly promptMode?: 'tui' | 'coding' | 'work';
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Pre-resolved daemon targets. The lifecycle boot resolves the targets
   * exactly ONCE (the env guard needs them before any boot work) and hands
   * them down here; without it the host resolves as before.
   */
  readonly daemonTargets?: ReturnType<typeof resolveDaemonTargets>;
  /**
   * W5 (§4.3.2): what enters `hello.client.kind` — the TUI lifecycle maps
   * its surface onto it (`headless` → `exec`, ACP → `acp`, else `tui`).
   * Diagnostic only (the daemon logs it); nothing branches on it.
   */
  readonly clientKind?: 'tui' | 'exec' | 'acp';
  /** Bounded connect+spawn+hello wait. Default 20 000 ms (§4.6.2 п.3). */
  readonly readyTimeoutMs?: number;
  /** Bounded reconnect wait per turn reattach. Default {@link REATTACH_READY_MS}. */
  readonly reattachReadyMs?: number;
}

/** Test seams of the remote host. */
export interface RemoteHostDependencies {
  /** Spawn-side seams (tests inject probe/spawn; the client takes `connect`). */
  readonly spawnSeams?: DaemonSpawnSeams;
  readonly clientInstanceId?: string;
}

/**
 * The W5 extract of the product composition: the CliService the TUI ports
 * consume — the pinned deltas live on {@link TuiRemoteCliService}, every
 * other member delegates (bound) to the plain {@link RemoteCliService}.
 * One composition for `createRemoteRuntimeHost` AND the e2e tests so they
 * cannot drift.
 */
export function composeTuiRemoteCliService(
  client: McodedClient,
  options: {
    reattachReadyMs?: number;
    reattachSleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  } = {},
): {
  cliService: CliService;
  /** The port adapter itself (the W4 deltas: refreshGoalEnabled et al). */
  tuiCli: TuiRemoteCliService;
} {
  const remote = new RemoteCliService(client);
  const tuiCli = new TuiRemoteCliService(client, remote, options);
  const cliService = new Proxy(tuiCli, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      const value = Reflect.get(remote as object, property, receiver);
      return typeof value === 'function' ? value.bind(remote) : value;
    },
  }) as unknown as CliService;
  return { cliService, tuiCli };
}

/**
 * Build the thin-client host: resolve the daemon targets, connect (auto-
 * spawning through the spawn.lock dance when allowed), sync the snapshot
 * seams, and expose the embedded-host-compatible shape.
 */
export async function createRemoteRuntimeHost(
  options: CreateRemoteRuntimeHostOptions,
  dependencies: RemoteHostDependencies = {},
): Promise<RemoteRuntimeHost> {
  const targets =
    options.daemonTargets ??
    resolveDaemonTargets({
      profile: options.profile,
      dataDir: options.dataDir,
      homeDir: options.homeDir ?? options.environment?.['HOME'],
      env: options.environment ?? process.env,
    });
  const clientInstanceId = dependencies.clientInstanceId ?? randomUUID();
  const handshake: McodedClientHandshake = {
    // Fresh read at every handshake: the token appears with the daemon.
    tokenGetter: () => {
      try {
        return readDaemonToken(targets.controlRoot);
      } catch {
        return undefined;
      }
    },
    dataDir: targets.dataDir,
    env: { region: getRuntimeRegion(), buildEnv: getRuntimeBuildEnv() },
    clientInstanceId,
    promptMode: options.promptMode ?? 'tui',
    // W5 (§4.3.2): the process identity the daemon logs per connection —
    // `mcode exec`/ACP/окно distinguishable in `logs/mcoded.log`.
    client: {
      kind: options.clientKind ?? 'tui',
      pid: process.pid,
      ...(process.env['MCODE_BUILD_ID'] ? { buildId: process.env['MCODE_BUILD_ID'] } : {}),
      cwd: process.cwd(),
    },
  };
  // W5 (§4.6.4): the crash-loop watchdog — 3 started-but-unservable daemon
  // lives within its window stop the respawning, with the daemon-log path
  // and the `MCODE_SERVER_MODE=off` hint in the failure.
  const crashLoop = new CrashLoopWatchdog({
    logPath: path.join(targets.controlRoot, MCODED_LOG_DIR_BASENAME, 'mcoded.log'),
  });
  const spawnHook = createDaemonAutoSpawnHook({
    targets,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(dependencies.spawnSeams ? { seams: dependencies.spawnSeams } : {}),
  });
  const clientOptions: McodedClientOptions = {
    socketPath:
      readDaemonManifest(targets.controlRoot)?.socketPath ??
      resolveMcodedSocketPath(targets.controlRoot),
    handshake,
    ...(options.autoSpawn === false ? {} : { spawn: spawnHook }),
    crashLoop,
    ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
  };
  const client = new McodedClient(clientOptions);
  const { cliService, tuiCli } = composeTuiRemoteCliService(
    client,
    options.reattachReadyMs !== undefined ? { reattachReadyMs: options.reattachReadyMs } : {},
  );

  const ready = (async () => {
    await client.connect();
    await tuiCli.refreshGoalEnabled();
  })();
  return {
    cliService,
    ready,
    apiHost: {
      close: async () => {
        client.close();
      },
    },
    notifyAuthContextChanged: async () => {
      // §4.4: the window's auth projection changed — the daemon re-reads
      // the OAuth store (the auth state itself stays a client closure).
      await client.daemonAuthSync();
    },
    connectionState: () => client.connectionState,
    onConnectionStateChange: (listener) => client.onStateChange(listener),
    clientInstanceId,
    socketPath: clientOptions.socketPath,
  };
}

/** The server mode the window runs in (re-exported for the lifecycle branch). */
export function resolveTuiServerMode(environment: NodeJS.ProcessEnv = process.env): ServerMode {
  return resolveServerMode(environment);
}
