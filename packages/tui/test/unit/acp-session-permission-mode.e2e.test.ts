/**
 * §2 pins (daemon leg): the per-session permission-mode contract over the
 * REAL daemon wire —
 *
 *   acp.client ↔ createTuiAcpAgent (the REAL ACP agent) ↔ TuiRuntimeAdapter
 *   ↔ composeTuiRemoteCliService ↔ real McodedClient ↔ socket ↔ real
 *   McodedDaemon ↔ CliBridge ↔ the daemon-side CliService double.
 *
 * The double backs the three new RPCs with the REAL v2 registry and mirrors
 * §2.3 (a turn start locks the Session's mode). What is deliberately
 * simulated: the "non-safe bash asks in default" classifier half of pin 2.1 —
 * the double's sendMessage consults the Session's registry mode and raises
 * `permission.ask` only in `default`, which pins the per-session SCOPING end
 * to end; the full classifier behavior is covered by the live embedded run
 * (scripts/verify-acp-session-mode.mjs).
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CliBridge,
  McodedClient,
  McodedDaemon,
  PushableIterable,
  MCODED_TOKEN_BASENAME,
} from '@mavis/mcoded';
import { createSessionPermissionModeRegistry } from '@mavis/local-runtime-v2';

import { createTuiAcpAgent } from '../../src/acp/agent.js';
import { TuiRuntimeAdapter } from '../../src/runtime/adapter.js';
import { composeTuiRemoteCliService } from '../../src/runtime/remote-host.js';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';

/** The daemon-side CliService double: the registry is the REAL v2 one. */
function daemonDouble(events: PushableIterable<unknown>) {
  const registry = createSessionPermissionModeRegistry({
    isTurnActive: (sessionId) => activeTurns.has(sessionId),
  });
  const activeTurns = new Set<string>();
  const finishedTurns = new Set<string>();
  let nextSession = 0;
  let processMode: 'default' | 'auto' | 'bypassPermissions' | 'off' = 'auto';
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const waitTurnEnd = async (sessionId: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (activeTurns.has(sessionId)) {
      if (Date.now() > deadline) throw new Error(`turn of ${sessionId} never ended`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const cli = {
    createSession: async (...args: unknown[]) => {
      calls.push({ method: 'createSession', args });
      nextSession += 1;
      return { sessionId: `sess-${nextSession}`, workspaceDir: '/tmp/w-acp-mode' };
    },
    getSession: async (req: { id?: string }) => ({
      session: {
        sessionId: req.id ?? 'sess-1',
        workspaceDir: '/tmp/w-acp-mode',
        archived: false,
        agentName: 'mavis',
      },
    }),
    getAccountStatus: async () => ({ status: 'ready', warnings: [] }),
    isGoalEnabled: () => false,
    getSessionPublishStaleSessions: (): readonly string[] => [],
    getPendingQuestionnaire: async () => ({}),
    listPendingPermissions: async () => ({ requests: [] }),
    getPermissionMode: async () => processMode,
    setPermissionMode: async (mode: 'default' | 'auto' | 'bypassPermissions' | 'off') => {
      processMode = mode;
      return mode;
    },
    bindSessionPermissionMode: async (
      sessionId: string,
      mode: 'default' | 'auto' | 'bypassPermissions',
      origin: string,
    ) => registry.bind(sessionId, mode, origin as never),
    setSessionPermissionMode: async (sessionId: string, mode: 'default' | 'auto' | 'bypassPermissions') =>
      registry.set(sessionId, mode),
    getSessionPermissionMode: async (sessionId: string) => registry.get(sessionId)?.mode,
    getPlanModeCapabilities: async () => ({ entryEnabled: true }),
    listModels: async () => [],
    listSkills: async () => ({ skills: [] }),
    listRuntimeSkills: async () => ({ skills: [] }),
    getContextSnapshot: async () => ({ status: 'empty' }),
    getDelegationSnapshot: async () => ({ members: [] }),
    listMessagePage: async () => ({ messages: [], hasMore: false }),
    getMessages: async () => ({ messages: [], hasMore: false }),
    listSessionPage: async () => ({ sessions: [], hasMore: false }),
    listSessions: async () => ({ sessions: [], hasMore: false }),
    getSessionTree: async () => ({ sessions: [], hasMore: false }),
    configureSessionMcpServers: async () => undefined,
    clearSessionMcpServers: async () => undefined,
    deleteSession: async () => undefined,
    requestCompaction: async () => ({ success: true }),
    abortSession: async () => ({ success: true }),
    replyPermission: async (...args: unknown[]) => {
      calls.push({ method: 'replyPermission', args });
      events.push({
        type: 'permission.resolved',
        payload: {
          requestId: (args[0] as { requestId: string }).requestId,
          sessionId: (args[0] as { sessionId: string }).sessionId,
          decision: 'allowOnce',
        },
      });
      return { success: true };
    },
    steer: async () => ({ turnId: 'turn-live', mode: 'steered' }),
    sendMessage: async (...args: unknown[]) => {
      calls.push({ method: 'sendMessage', args });
      const req = args[0] as { id: string };
      // §2.3 mirror: the accepted turn locks the mode. In `default` the
      // (simulated) non-safe tool asks; in bypass it never does.
      registry.lock(req.id);
      const turnAlreadyFinished = finishedTurns.has(req.id);
      if (!turnAlreadyFinished) activeTurns.add(req.id);
      if (registry.get(req.id)?.mode === 'default') {
        events.push({
          type: 'permission.ask',
          payload: {
            requestId: `ask-${req.id}`,
            sessionId: req.id,
            agentName: 'mavis',
            toolName: 'bash',
            allowAlwaysSupported: true,
          },
        });
      }
      return {
        ok: true,
        source: (async function* () {
          if (!turnAlreadyFinished) {
            await waitTurnEnd(req.id);
            finishedTurns.add(req.id);
          }
          yield { dataJson: '[DONE]' };
        })(),
      };
    },
  };
  const missing = new Set<string>();
  const cliProxy = new Proxy(cli, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (value === undefined && typeof property === 'string') {
        missing.add(property);
        return async () => undefined;
      }
      return value;
    },
  });
  return {
    cli: cliProxy as unknown as CliService,
    registry,
    activeTurns,
    calls,
    missing,
    finishTurn: (sessionId: string) => {
      finishedTurns.add(sessionId);
      activeTurns.delete(sessionId);
    },
  };
}

interface DaemonHarness {
  agent: ReturnType<typeof createTuiAcpAgent>;
  runtime: TuiRuntimeAdapter;
  double: ReturnType<typeof daemonDouble>;
  permissionAsks: Array<Record<string, unknown>>;
}

async function bootHarness(root: string, events: PushableIterable<unknown>): Promise<{
  harness: DaemonHarness;
  client: acp.Client;
  daemon: McodedDaemon;
  mcodedClient: McodedClient;
}> {
  const double = daemonDouble(events);
  const daemon = new McodedDaemon({
    root,
    durableLayout: false,
    listenFd: null,
    handshake: { token: 'test-token', dataDir: root },
    hub: {
      bridge: new CliBridge({ cliService: () => double.cli as never }),
      globalEvents: events,
    },
  });
  await daemon.start();
  const mcodedClient = new McodedClient({
    socketPath: daemon.socketPath,
    handshake: { token: 'test-token', dataDir: root, clientInstanceId: 'acp-mode-conn-1' },
    readyTimeoutMs: 10_000,
  });
  await mcodedClient.connect();
  const { cliService } = composeTuiRemoteCliService(mcodedClient);
  const runtime = new TuiRuntimeAdapter(cliService as never, { workspaceDir: '/tmp/w-acp-mode' });
  const permissionAsks: Array<Record<string, unknown>> = [];
  const client = acp
    .client({ name: 'pin-client' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissionAsks.push(params as Record<string, unknown>);
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    });
  const agent = createTuiAcpAgent({ runtime: runtime as never, version: '1.0.0' });
  return { harness: { agent, runtime, double, permissionAsks }, client, daemon, mcodedClient };
}

describe('ACP per-session permission mode over the daemon (§2)', () => {
  let root: string;
  let daemon: McodedDaemon | undefined;
  let mcodedClient: McodedClient | undefined;

  afterEach(async () => {
    mcodedClient?.close();
    if (daemon) await daemon.shutdown();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function connect(harness: DaemonHarness, client: acp.Client, run: (connection: acp.AgentConnection) => Promise<void>) {
    await client.connectWith(harness.agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await run(connection);
    });
  }

  function permissionOption(response: unknown): acp.SessionConfigOption | undefined {
    const options = (response as { configOptions?: acp.SessionConfigOption[] }).configOptions;
    return options?.find((option) => option.id === 'permissionMode');
  }

  it(
    'two-sessions-different-modes, session-scoped set_config_option, lock-after-first-turn, invalid _meta, load default, turn_active conflict',
    { timeout: 90_000 },
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'w-acp-mode-')));
      writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
      const events = new PushableIterable<unknown>();
      const { harness, client, daemon: d, mcodedClient: mc } = await bootHarness(root, events);
      daemon = d;
      mcodedClient = mc;

      await connect(harness, client, async (connection) => {
        // -- 2.1 two-sessions-different-modes (scoping over the daemon wire)
        const askSession = await connection.request(acp.methods.agent.session.new, {
          cwd: '/tmp/w-acp-mode',
          mcpServers: [],
          _meta: { 'minimax-code/permissionMode': 'default' },
        });
        expect(permissionOption(askSession)).toMatchObject({ currentValue: 'default' });
        const bypassSession = await connection.request(acp.methods.agent.session.new, {
          cwd: '/tmp/w-acp-mode',
          mcpServers: [],
          _meta: { 'minimax-code/permissionMode': 'bypassPermissions' },
        });
        expect(permissionOption(bypassSession)).toMatchObject({ currentValue: 'bypassPermissions' });

        const prompt = (sessionId: string) =>
          connection.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'run the non-safe tool' }],
          });
        const askPrompt = prompt(askSession.sessionId);
        await vi.waitFor(() => expect(harness.permissionAsks.length).toBe(1), { timeout: 10_000 });
        expect(harness.permissionAsks[0]).toMatchObject({ sessionId: askSession.sessionId });
        harness.double.finishTurn(askSession.sessionId);
        await askPrompt;

        harness.permissionAsks.length = 0;
        const bypassPrompt = prompt(bypassSession.sessionId);
        harness.double.finishTurn(bypassSession.sessionId);
        await bypassPrompt;
        // The bypass Session ran the same tool with NO permission request.
        expect(harness.permissionAsks).toHaveLength(0);

        // -- 2.8 lock-after-first-turn (daemon): after the prompt the option is fixed
        await expect(
          connection.request(acp.methods.agent.session.setConfigOption, {
            sessionId: askSession.sessionId,
            configId: 'permissionMode',
            value: 'bypassPermissions',
          }),
        ).rejects.toMatchObject({
          code: -32602,
          message: expect.stringContaining('permissionMode is fixed for the session after the first prompt'),
          data: { currentValue: 'default' },
        });
        // The same value stays a no-op ok.
        await expect(
          connection.request(acp.methods.agent.session.setConfigOption, {
            sessionId: askSession.sessionId,
            configId: 'permissionMode',
            value: 'default',
          }),
        ).resolves.toBeDefined();

        // -- 2.2 set-config-option-session-scoped: a THIRD session (still unlocked)
        const third = await connection.request(acp.methods.agent.session.new, {
          cwd: '/tmp/w-acp-mode',
          mcpServers: [],
        });
        await connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: third.sessionId,
          configId: 'permissionMode',
          value: 'auto',
        });
        expect(harness.double.registry.get(third.sessionId)).toMatchObject({ mode: 'auto' });
        expect(harness.double.registry.get(bypassSession.sessionId)).toMatchObject({
          mode: 'bypassPermissions',
        });

        // -- 2.4 new-meta-mode: invalid values reject without creating a Session
        const created = harness.double.calls.filter((call) => call.method === 'createSession').length;
        await expect(
          connection.request(acp.methods.agent.session.new, {
            cwd: '/tmp/w-acp-mode',
            mcpServers: [],
            _meta: { 'minimax-code/permissionMode': 'off' },
          }),
        ).rejects.toMatchObject({
          code: -32602,
          message: expect.stringContaining('invalid minimax-code/permissionMode'),
          data: { allowed: ['default', 'auto', 'bypassPermissions'] },
        });
        expect(
          harness.double.calls.filter((call) => call.method === 'createSession').length,
        ).toBe(created);

        // -- 2.6 load-without-mode-is-default: a bypass Session rebinds to default
        const loaded = await connection.request(acp.methods.agent.session.load, {
          sessionId: bypassSession.sessionId,
          cwd: '/tmp/w-acp-mode',
          mcpServers: [],
        });
        expect(permissionOption(loaded)).toMatchObject({ currentValue: 'default' });
        expect(harness.double.registry.get(bypassSession.sessionId)).toMatchObject({
          mode: 'default',
          origin: 'load-default',
        });

        // -- 2.11 load-during-active-turn-conflict (probe-driven)
        harness.double.activeTurns.add(askSession.sessionId);
        await expect(
          connection.request(acp.methods.agent.session.load, {
            sessionId: askSession.sessionId,
            cwd: '/tmp/w-acp-mode',
            mcpServers: [],
            _meta: { 'minimax-code/permissionMode': 'bypassPermissions' },
          }),
        ).rejects.toMatchObject({ code: -32602, data: { currentValue: 'default' } });
        expect(harness.double.registry.get(askSession.sessionId)).toMatchObject({ mode: 'default' });
      });
    },
  );

  it(
    'process-mode-does-not-touch-acp-session and the new Session snapshots the new process value',
    { timeout: 90_000 },
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'w-acp-mode-2-')));
      writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
      const events = new PushableIterable<unknown>();
      const { harness, client, daemon: d, mcodedClient: mc } = await bootHarness(root, events);
      daemon = d;
      mcodedClient = mc;

      await connect(harness, client, async (connection) => {
        const first = await connection.request(acp.methods.agent.session.new, {
          cwd: '/tmp/w-acp-mode',
          mcpServers: [],
        });
        // Snapshot of the daemon's process mode (auto by default in the double).
        expect(permissionOption(first)).toMatchObject({ currentValue: 'auto' });

        // The TUI process surface still flips the process mode over the wire.
        await harness.runtime.setPermissionMode('default');
        // …and the LIVE ACP Session keeps its bound mode.
        expect(await harness.runtime.getSessionPermissionMode(first.sessionId)).toBe('auto');

        // A NEW Session without _meta snapshots the new process value.
        const second = await connection.request(acp.methods.agent.session.new, {
          cwd: '/tmp/w-acp-mode',
          mcpServers: [],
        });
        expect(permissionOption(second)).toMatchObject({ currentValue: 'default' });
        expect(harness.double.registry.get(second.sessionId)).toMatchObject({
          mode: 'default',
          origin: 'new-default',
        });
      });
    },
  );
});
