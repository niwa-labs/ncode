/**
 * The wave-2 integration gate (incident 2026-11-05, verdict §2.7): the reply
 * to `session/prompt` is the TRUE end of the turn — even when the window's
 * socket dies mid-turn.
 *
 * The full product chain, composed for real:
 *
 *   acp client (the SDK) → createTuiAcpAgent (the REAL ACP shim) →
 *   TuiRunCoordinator → TuiConversationAccess → TuiRemoteCliService (the
 *   thin client) → real McodedClient → REAL McodedDaemon on a real unix
 *   socket (temporary control root) → CliBridge → the REAL local-runtime-v2
 *   conversation pipeline, with the LLM turn scripted (the fake LLM).
 *
 * Scenario 1 (the incident): a long turn streams its first message, the test
 * RIPS the client's socket mid-turn, and only then releases the turn. The
 * prompt must answer AFTER the true end with the FINAL text — never the
 * mid-turn "Let me…" — via the daemon-side detach (I-DETACH) and the thin
 * client's reattach (`resumeSession` after the last delivered cursor).
 *
 * Scenario 2: the daemon stops mid-turn with no way back — the prompt ends
 * in the structured `turn_detached` JSON-RPC error, never `end_turn`.
 *
 * The remote leg of the [DONE] inventory rides scenario 3: a normal turn
 * answers `end_turn` through the wire, which the coordinator's sawTerminal
 * net only accepts when the terminal marker crossed the wire.
 *
 * @module
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

import * as acp from '@agentclientprotocol/sdk';
import {
  CliBridge,
  EchoRuntimeAdapter,
  MCODED_TOKEN_BASENAME,
  McodedClient,
  McodedDaemon,
  SocketLineTransport,
} from '@mavis/mcoded';
import { createLocalRuntimeHostV2, type CreatedLocalRuntimeHost } from '@mavis/local-runtime-v2';
import type { LocalRuntimeConfig } from '@mavis/local-runtime';
import { RuntimeEventStatus } from '@mavis/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TuiRuntimeAdapter } from '../../src/runtime/adapter.js';
import { composeTuiRemoteCliService } from '../../src/runtime/remote-host.js';

interface ScriptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
  readonly eventWriter: {
    pushRuntime(event: Record<string, unknown>): void | Promise<void>;
  };
}

const harness = vi.hoisted(() => ({
  /** Turn scripts run in order; a missing script just completes the Turn. */
  scripts: [] as ((input: ScriptedTurnInput) => Promise<void>)[],
  invocations: 0,
  startedTurns: [] as { sessionId: string; turnId: string }[],
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
  return {
    ...actual,
    PiTurnRunner: class {
      async runTurn(input: ScriptedTurnInput): Promise<void> {
        const index = harness.invocations;
        harness.invocations += 1;
        harness.startedTurns.push({ sessionId: input.sessionId, turnId: input.turnId });
        const script = harness.scripts[index];
        if (script) await script(input);
        await input.eventWriter.pushRuntime(
          terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'),
        );
      }
    },
  };
});

function terminalEvent(
  input: ScriptedTurnInput,
  status: number,
  message: string,
): Record<string, unknown> {
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('session-status') ?? `evt-${input.turnId}-${status}`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? status,
    type: 3,
    payload: { status, stop_reason: { type: 1, message } },
  };
}

/** The turn's RUNNING session-status event (what the real runner emits first). */
function runningEvent(input: ScriptedTurnInput): Record<string, unknown> {
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('session-status') ?? `evt-${input.turnId}-running`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? 0,
    type: 3,
    payload: { status: RuntimeEventStatus.RUNNING },
  };
}

/** A committed assistant message over STREAM_RESP (`type: 2`). */
function assistantMessageEvent(
  input: ScriptedTurnInput,
  msgId: string,
  content: string,
): Record<string, unknown> {
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('stream-resp') ?? `evt-${msgId}`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? 1,
    type: 1,
    payload: {
      stream_resp: JSON.stringify({
        type: 2,
        agent_message: { msg_id: msgId, role: 'assistant', msg_content: content },
      }),
    },
  };
}

let root: string | undefined;
let daemon: McodedDaemon | undefined;
let host: CreatedLocalRuntimeHost | undefined;
let hostDataDir: string | undefined;

interface Rig {
  readonly agent: acp.AgentApp;
  readonly wire: McodedClient;
  /** The raw client-side socket of the CURRENT connection (tear target). */
  lastSocket(): net.Socket | undefined;
}

/** An ACP test client capturing the shim's session/update stream. */
function acpTestClient(): {
  client: ReturnType<typeof acp.client>;
  assistantTexts(): string[];
} {
  const updates: acp.SessionNotification[] = [];
  const client = acp
    .client({ name: 'wave2-test-client' })
    .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));
  return {
    client,
    assistantTexts: () =>
      updates.flatMap((notification) =>
        notification.update.sessionUpdate === 'agent_message_chunk' &&
        notification.update.content?.type === 'text'
          ? [notification.update.content.text ?? '']
          : [],
      ),
  };
}

async function startRig(options: {
  reattachReadyMs?: number;
  reattachSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}): Promise<Rig> {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'w2-turn-detached-')));
  writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
  hostDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'w2-turn-detached-data-')));
  const config = {
    dataDir: hostDataDir,
    defaultModel: 'test/model',
    provider: {
      test: {
        options: { apiKey: 'test-key', baseURL: 'https://provider.test/v1' },
        models: {
          model: { modalities: { input: ['text'], output: ['text'] } },
        },
      },
    },
  } as LocalRuntimeConfig;
  host = await createLocalRuntimeHostV2({
    dataDir: hostDataDir,
    runtimeOwnerKind: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(hostDataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
  daemon = new McodedDaemon({
    root,
    adapter: new EchoRuntimeAdapter(),
    durableLayout: false,
    listenFd: null,
    handshake: { token: 'test-token', dataDir: root },
    hub: {
      bridge: new CliBridge({ cliService: () => host!.cliService as never }),
    },
  });
  await daemon.start();

  let currentSocket: net.Socket | undefined;
  const client = new McodedClient({
    socketPath: daemon.socketPath,
    handshake: { token: 'test-token', dataDir: root, clientInstanceId: 'acp-tear-1' },
    readyTimeoutMs: 10_000,
    connect: async () => {
      const socket = net.connect(daemon!.socketPath);
      await once(socket, 'connect');
      currentSocket = socket;
      return new SocketLineTransport(socket);
    },
  });
  await client.connect();
  const { cliService } = composeTuiRemoteCliService(client, {
    ...(options.reattachReadyMs !== undefined ? { reattachReadyMs: options.reattachReadyMs } : {}),
    ...(options.reattachSleep ? { reattachSleep: options.reattachSleep } : {}),
  });
  const runtime = new TuiRuntimeAdapter(cliService as never, {
    workspaceDir: join(hostDataDir, 'workspace'),
  });
  const agent = await createAgent(runtime as never);
  return { agent, wire: client, lastSocket: () => currentSocket };
}

/** The REAL ACP shim (imported late so the runner mock is in place). */
async function createAgent(runtime: never): Promise<acp.AgentApp> {
  const { createTuiAcpAgent } = await import('../../src/acp/agent.js');
  return createTuiAcpAgent({ runtime, version: '0.0.0-wave2-test' });
}

afterEach(async () => {
  if (daemon) await daemon.shutdown().catch(() => undefined);
  if (host) {
    await host.apiHost.close().catch(() => undefined);
    await host.metricsClient.close().catch(() => undefined);
  }
  daemon = undefined;
  host = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  if (hostDataDir) {
    // The v2 host's sqlite handles are process-cached per dataDir; every test
    // uses a FRESH dataDir, so the removal is best-effort teardown.
    rmSync(hostDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  root = undefined;
  hostDataDir = undefined;
  harness.scripts = [];
  harness.invocations = 0;
  harness.startedTurns = [];
});

describe('ACP session/prompt = the true end of the turn (wave 2 gate)', () => {
  it(
    'a torn socket mid-turn: the prompt answers only after the true end, with the final text',
    { timeout: 120_000 },
    async () => {
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      harness.scripts = [
        async (input) => {
          await input.eventWriter.pushRuntime(runningEvent(input));
          // The turn's first message crosses the wire BEFORE the tear.
          await input.eventWriter.pushRuntime(
            assistantMessageEvent(input, 'msg-early', 'Let me check the details…'),
          );
          await turnGate; // parked mid-turn: the window dies here in the test
          // The turn survives the dead window (I-DETACH) and finishes.
          await input.eventWriter.pushRuntime(
            assistantMessageEvent(input, 'msg-final', 'The FINAL answer after the tear.'),
          );
        },
      ];
      const rig = await startRig({ reattachReadyMs: 10_000 });
      await rig.wire.connect();
      const { client, assistantTexts } = acpTestClient();

      await client.connectWith(rig.agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await connection.request(acp.methods.agent.session.new, {
          cwd: join(hostDataDir!, 'workspace'),
          mcpServers: [],
        });
        const prompt = connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'long turn, then lose the window' }],
        });
        // Wait until the turn is genuinely running and its first message has
        // crossed the wire — then RIP the client's socket mid-turn. The
        // deadline is explicit: under a full parallel suite the daemon + v2
        // pipeline spin-up eats the 1 s default `vi.waitFor` timeout.
        await vi.waitFor(() => expect(harness.startedTurns.length).toBe(1), { timeout: 30_000 });
        await vi.waitFor(
          () => {
            expect(assistantTexts()).toContain('Let me check the details…');
          },
          { timeout: 30_000 },
        );
        const socket = rig.lastSocket();
        expect(socket, 'the client holds a live socket').toBeDefined();
        socket!.destroy();

        // The turn is still parked: the prompt must NOT settle here.
        const stillPending = await Promise.race([
          prompt.then(
            () => 'settled' as const,
            () => 'settled' as const,
          ),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 500)),
        ]);
        expect(stillPending, 'a torn window must not answer the prompt').toBe('pending');

        // The turn finishes; the thin client reattaches and the reply arrives.
        releaseTurn();
        const result = (await prompt) as { stopReason: string };
        expect(result.stopReason).toBe('end_turn');
        // The final text — not the mid-turn "Let me…" — is the answer.
        const texts = assistantTexts();
        expect(texts.at(-1)).toBe('The FINAL answer after the tear.');
      });
    },
  );

  it(
    'a daemon gone mid-turn with no way back: the prompt errors turn_detached, never end_turn',
    { timeout: 120_000 },
    async () => {
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      harness.scripts = [
        async (input) => {
          await input.eventWriter.pushRuntime(runningEvent(input));
          await input.eventWriter.pushRuntime(
            assistantMessageEvent(input, 'msg-early-2', 'Let me check the details…'),
          );
          await turnGate;
        },
      ];
      const rig = await startRig({
        // The reattach deadline and backoff are bounded for the test; the
        // production defaults (60 s, 1/2/4 s) live in remote-host.ts.
        reattachReadyMs: 250,
        reattachSleep: async () => undefined,
      });
      await rig.wire.connect();
      const { client, assistantTexts } = acpTestClient();

      await client.connectWith(rig.agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await connection.request(acp.methods.agent.session.new, {
          cwd: join(hostDataDir!, 'workspace'),
          mcpServers: [],
        });
        const prompt = connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'lose the daemon mid-turn' }],
        });
        await vi.waitFor(() => expect(harness.startedTurns.length).toBe(1), { timeout: 30_000 });
        await vi.waitFor(
          () => {
            expect(assistantTexts()).toContain('Let me check the details…');
          },
          { timeout: 30_000 },
        );
        // The daemon DIES mid-turn: no socket, no spawn hook, no way back.
        await daemon!.shutdown();
        await expect(prompt).rejects.toMatchObject({
          code: -32603,
          data: { code: 'turn_detached', sessionId: session.sessionId, resumable: true },
        });
        releaseTurn();
      });
    },
  );

  it(
    'a normal remote turn ends with end_turn (the remote [DONE] inventory leg)',
    { timeout: 120_000 },
    async () => {
      harness.scripts = [
        async (input) => {
          await input.eventWriter.pushRuntime(runningEvent(input));
          await input.eventWriter.pushRuntime(
            assistantMessageEvent(input, 'msg-answer', 'the whole answer in one message'),
          );
        },
      ];
      const rig = await startRig();
      await rig.wire.connect();
      const { client, assistantTexts } = acpTestClient();

      await client.connectWith(rig.agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await connection.request(acp.methods.agent.session.new, {
          cwd: join(hostDataDir!, 'workspace'),
          mcpServers: [],
        });
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'a normal turn' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        // The sawTerminal net accepted the turn ONLY because the terminal
        // marker crossed the wire: the answer is the full final text.
        expect(assistantTexts()).toContain('the whole answer in one message');
      });
    },
  );
});
