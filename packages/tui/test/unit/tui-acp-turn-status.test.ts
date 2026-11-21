/**
 * Turn-status liveness extension (incident 2026-11-15): a kagero run sat six
 * minutes on "active" with zero wire events and no cheap way for the
 * integrator to tell a thinking model from a stalled stream — the only probe
 * available was polling full session/history pages.
 *
 * `mcode/session/turn_status` answers with the admitted active Turn, the
 * latest durable turn activity, and the queue depth in ONE read. The tests
 * pin the REAL `registerTuiAcpExtensions` handler on a real `acp.agent()` app
 * (idle / active / unknown session), then the REAL daemon wire leg: the
 * snapshot crosses McodedClient → CliBridge → adapter losslessly.
 *
 * @module
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as acp from '@agentclientprotocol/sdk';
import {
  CliBridge,
  EchoRuntimeAdapter,
  McodedClient,
  McodedDaemon,
  MCODED_TOKEN_BASENAME,
  PushableIterable,
} from '@mavis/mcoded';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTuiAcpExtensions } from '../../src/acp/extensions.js';
import type { TuiAcpRuntime } from '../../src/acp/runtime.js';
import { TuiRuntimeAdapter } from '../../src/runtime/adapter.js';
import { composeTuiRemoteCliService } from '../../src/runtime/remote-host.js';
import type { TuiTurnStatusSnapshot } from '../../src/runtime/port.js';

/** The REAL extension registration with a scripted liveness runtime. */
function mountTurnStatusExtensions(options: {
  runtime: Partial<TuiAcpRuntime> & Pick<TuiAcpRuntime, 'getSession'>;
  resolveSession?: (sessionId: string) => { sessionId: string } | undefined;
}): acp.AgentApp {
  const app = acp.agent({ name: 'turn-status-test' });
  app.onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
  }));
  registerTuiAcpExtensions({
    app,
    runtime: options.runtime as TuiAcpRuntime,
    resolveSession:
      options.resolveSession ??
      ((sessionId: string) => ({ sessionId, workspaceDir: '/workspace' })),
    activateSession: () => undefined,
    extensionNotificationsEnabled: () => false,
    activePromptTurnId: () => undefined,
  });
  return app;
}

async function withConnection(
  app: acp.AgentApp,
  run: (connection: acp.AgentContext) => Promise<void>,
): Promise<void> {
  const client = acp.client({ name: 'test-client' });
  await client.connectWith(app, async (connection) => {
    await connection.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await run(connection);
  });
}

function turnStatusRequest(connection: acp.AgentContext, sessionId: string) {
  return connection.request<
    {
      activeTurn: TuiTurnStatusSnapshot['activeTurn'];
      latestActivity: TuiTurnStatusSnapshot['latestActivity'];
      queue: { pendingCount: number; paused: boolean };
    },
    { sessionId: string }
  >('mcode/session/turn_status', { sessionId });
}

describe('mcode/session/turn_status liveness extension', () => {
  it('reports an idle session: null active turn, durable latest activity, empty queue', async () => {
    const getTurnStatus = vi.fn(async (sessionId: string) => ({
      activeTurn: null,
      latestActivity: {
        turnId: 'turn-prev',
        acceptedAtMs: 1000,
        completedAtMs: 9000,
        activityAtMs: 9000,
      },
      sessionId,
    }));
    const getQueueSnapshot = vi.fn(async () => ({
      items: [],
      paused: false,
      pendingCount: 0,
    }));
    const app = mountTurnStatusExtensions({
      runtime: { getTurnStatus, getQueueSnapshot } as never,
    });

    await withConnection(app, async (connection) => {
      await expect(turnStatusRequest(connection, 'session-1')).resolves.toEqual({
        activeTurn: null,
        latestActivity: {
          turnId: 'turn-prev',
          acceptedAtMs: 1000,
          completedAtMs: 9000,
          activityAtMs: 9000,
        },
        queue: { pendingCount: 0, paused: false },
      });
    });
    expect(getTurnStatus).toHaveBeenCalledWith('session-1');
  });

  it('reports an ACTIVE turn with its busy reason and latest movement', async () => {
    const app = mountTurnStatusExtensions({
      runtime: {
        getTurnStatus: async (sessionId: string) => ({
          activeTurn: { turnId: 'turn-live', busyReason: 'turn', locallyOwned: true },
          latestActivity: {
            turnId: 'turn-live',
            acceptedAtMs: 5000,
            activityAtMs: 7000,
          },
          sessionId,
        }),
        getQueueSnapshot: async () => ({
          items: [{ itemId: 'q1', sessionId: 'session-1', status: 'queued' }],
          paused: true,
          pendingCount: 1,
        }),
      } as never,
    });

    await withConnection(app, async (connection) => {
      await expect(turnStatusRequest(connection, 'session-1')).resolves.toEqual({
        activeTurn: { turnId: 'turn-live', busyReason: 'turn', locallyOwned: true },
        latestActivity: { turnId: 'turn-live', acceptedAtMs: 5000, activityAtMs: 7000 },
        queue: { pendingCount: 1, paused: true },
      });
    });
  });

  it('still answers when the runtime predates the liveness port', async () => {
    const app = mountTurnStatusExtensions({
      runtime: {
        getQueueSnapshot: async () => ({ items: [], paused: false, pendingCount: 0 }),
      } as never,
    });

    await withConnection(app, async (connection) => {
      await expect(turnStatusRequest(connection, 'session-1')).resolves.toEqual({
        activeTurn: null,
        latestActivity: null,
        queue: { pendingCount: 0, paused: false },
      });
    });
  });

  it('refuses a session unknown to the Runtime before any runtime read', async () => {
    const getQueueSnapshot = vi.fn(async () => ({
      items: [],
      paused: false,
      pendingCount: 0,
    }));
    const app = mountTurnStatusExtensions({
      runtime: {
        getQueueSnapshot,
        // The durable fallback rejects: unknown to the Runtime.
        getSession: async () => {
          throw new Error('not in runtime');
        },
      } as never,
      resolveSession: () => undefined,
    });

    await withConnection(app, async (connection) => {
      await expect(turnStatusRequest(connection, 'session-foreign')).rejects.toThrow();
    });
    expect(getQueueSnapshot).not.toHaveBeenCalled();
  });
});

describe('mcode/session/turn_status over the REAL daemon wire', () => {
  let root: string;
  let daemon: McodedDaemon | undefined;
  let client: McodedClient | undefined;

  afterEach(async () => {
    client?.close();
    if (daemon) await daemon.shutdown();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('the snapshot crosses the wire into the adapter and the handler', { timeout: 60_000 }, async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'turn-status-wire-')));
    writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
    const events = new PushableIterable<unknown>();
    const daemonSnapshot = {
      activeTurn: { turnId: 'turn-wire', busyReason: 'compaction', locallyOwned: false },
      latestActivity: { turnId: 'turn-wire', acceptedAtMs: 42, activityAtMs: 84 },
    };
    const daemonCli = {
      // SessionLookupResult nests the view under `session` (the contract the
      // adapter reads — response.session).
      getSession: async (req: { id?: string }) => ({
        session: {
          sessionId: req.id ?? 'sess-1',
          workspaceDir: '/tmp/turn-status',
          archived: false,
          agentName: 'mavis',
        },
      }),
      getPendingQuestionnaire: async () => ({}),
      listPendingPermissions: async () => ({ requests: [] }),
      replyPermission: async () => ({ success: true }),
      sendMessage: async () => ({ ok: true, source: (async function* () {})() }),
      abortSession: async () => ({ success: true }),
      listQueueMessages: async () => ({ items: [], paused: false, pendingCount: 0 }),
      getTurnStatus: async (sessionId: string) => ({ ...daemonSnapshot, sessionId }),
      isGoalEnabled: () => false,
      getSessionPublishStaleSessions: (): readonly string[] => [],
    };
    daemon = new McodedDaemon({
      root,
      adapter: new EchoRuntimeAdapter(),
      durableLayout: false,
      listenFd: null,
      handshake: { token: 'test-token', dataDir: root },
      hub: {
        bridge: new CliBridge({ cliService: () => daemonCli as never }),
        globalEvents: events,
      },
    });
    await daemon.start();
    client = new McodedClient({
      socketPath: daemon.socketPath,
      handshake: { token: 'test-token', dataDir: root, clientInstanceId: 'turn-status-1' },
      readyTimeoutMs: 10_000,
    });
    await client.connect();
    const { cliService } = composeTuiRemoteCliService(client);
    const runtime = new TuiRuntimeAdapter(cliService as never, {
      workspaceDir: '/tmp/turn-status',
    });

    // The adapter leg itself: the remote CliService serves the liveness view.
    await expect(runtime.getTurnStatus('sess-1')).resolves.toEqual(daemonSnapshot);

    const app = mountTurnStatusExtensions({
      runtime: runtime as never,
      // No attachment in THIS process — durable resolution through the
      // adapter's getSession (the follow_up integrator shape).
      resolveSession: () => undefined,
    });
    await withConnection(app, async (connection) => {
      await expect(turnStatusRequest(connection, 'sess-1')).resolves.toEqual({
        activeTurn: daemonSnapshot.activeTurn,
        latestActivity: daemonSnapshot.latestActivity,
        queue: { pendingCount: 0, paused: false },
      });
    });
  });
});
