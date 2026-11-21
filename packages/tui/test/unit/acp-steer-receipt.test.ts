/**
 * Steer-receipt regression (final-sprint 5a): a replayed clientRequestId is
 * answered by its DURABLE receipt — `duplicate` with the ORIGINAL turnId —
 * instead of the pre-fix refusals:
 *  - the handler compared the duplicate's turnId with the CURRENTLY active
 *    prompt Turn and failed with "did not match" although the steer had been
 *    delivered;
 *  - with no active prompt left (turn finished, later turn, reconnected
 *    client) the handler refused BEFORE ever consulting the receipt.
 *
 * Composition: the REAL `registerTuiAcpExtensions` steer handler on a real
 * `acp.agent()` app, driven by a real ACP client. The runtime's `steer` is
 * backed by an in-memory store with the TurnRepository receipt contract
 * (find → duplicate with the original turnId; reserve → at-most-once) and the
 * production v1-conversation-compat ingress mapping of refusals to
 * ConversationTurnRejectedError — faithful to daemon mode, where class
 * identity is lost on the wire and the refusal is recognized by name.
 *
 * The final test adds the REAL daemon wire leg: the same handler over
 * TuiRuntimeAdapter → McodedClient → McodedDaemon → CliBridge, pinning that
 * the `receiptLookupOnly` probe crosses the JSON DTO losslessly.
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
import type {
  ConversationSteerInput,
  ConversationSteerResult,
} from '@mavis/local-runtime-v2/cli-service';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTuiAcpExtensions } from '../../src/acp/extensions.js';
import type { TuiAcpRuntime } from '../../src/acp/runtime.js';
import { TuiRuntimeAdapter } from '../../src/runtime/adapter.js';
import { composeTuiRemoteCliService } from '../../src/runtime/remote-host.js';

/**
 * The receipt-backed steer runtime double: one Map playing the durable
 * receipts (keyed sessionId + `steer:<producer>\0<key>`), at-most-once
 * delivery, and the v1-compat refusal mapping (name-stable error).
 */
function createReceiptBackedSteerRuntime(options: {
  activeTurnId: (sessionId: string) => string | undefined;
}) {
  const receipts = new Map<string, string>();
  const steerInputs: ConversationSteerInput[] = [];
  const deliveredTurnIds: string[] = [];
  const steer = vi.fn(
    async (input: ConversationSteerInput): Promise<ConversationSteerResult> => {
      steerInputs.push(input);
      const receiptKey = `${input.sessionId}\u0000steer:${input.producerId}\u0000${input.idempotencyKey}`;
      const receipt = receipts.get(receiptKey);
      if (receipt !== undefined) {
        // The receipt answers the replay with the ORIGINAL turnId.
        return { turnId: receipt, mode: 'duplicate' };
      }
      if (input.receiptLookupOnly) {
        throw turnRejected(input.sessionId, 'active-turn');
      }
      const activeTurnId = options.activeTurnId(input.sessionId);
      if (input.expectActiveTurnId === undefined || input.expectActiveTurnId !== activeTurnId) {
        // Pinned callers (the only kind this handler sends) refuse on a miss;
        // the probe branch above already returned.
        throw turnRejected(input.sessionId, 'active-turn');
      }
      receipts.set(receiptKey, activeTurnId);
      deliveredTurnIds.push(activeTurnId);
      return { turnId: activeTurnId, mode: 'steered' };
    },
  );
  return {
    runtime: { steer } as unknown as TuiAcpRuntime,
    steer,
    steerInputs,
    deliveredTurnIds,
    receipts,
  };
}

/** The name-stable refusal the daemon wire carries for a rejected steer. */
function turnRejected(sessionId: string, reason: string): Error {
  const error = new Error(
    `Conversation Turn was rejected for ${sessionId}: ${reason}`,
  ) as Error & { errorName?: string };
  error.name = 'ConversationTurnRejectedError';
  error.errorName = 'ConversationTurnRejectedError';
  return error;
}

/** The REAL extension handler on its own app, with a controllable prompt map. */
function mountSteerExtensions(options: {
  runtime: TuiAcpRuntime;
  activePromptTurnId: (sessionId: string) => string | undefined;
  resolveSession?: (sessionId: string) => { sessionId: string } | undefined;
}): acp.AgentApp {
  const app = acp.agent({ name: 'steer-receipt-test' });
  // Minimal core-methods subset so a real client can connect; the extension
  // handler under test is the production registration, untouched.
  app.onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
  }));
  registerTuiAcpExtensions({
    app,
    runtime: options.runtime,
    resolveSession:
      options.resolveSession ??
      ((sessionId: string) => ({ sessionId, workspaceDir: '/workspace' })),
    activateSession: () => undefined,
    extensionNotificationsEnabled: () => false,
    activePromptTurnId: options.activePromptTurnId,
  });
  return app;
}

async function withSteerConnection(
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

function steerRequest(
  connection: acp.AgentContext,
  params: { sessionId: string; text: string; clientRequestId?: string },
) {
  return connection.request<{ turnId: string; mode: string }, typeof params>(
    'mcode/session/steer',
    params,
  );
}

describe('mcode/session/steer replay receipts (final-sprint 5a)', () => {
  it('answers a repeat within the SAME Turn as duplicate with exactly one delivery', async () => {
    const runtimeActiveTurn = vi.fn(() => 'turn-1');
    const harness = createReceiptBackedSteerRuntime({
      activeTurnId: () => runtimeActiveTurn(),
    });
    const app = mountSteerExtensions({
      runtime: harness.runtime,
      activePromptTurnId: () => 'turn-1',
    });

    await withSteerConnection(app, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'steered' });
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'duplicate' });
    });

    expect(harness.deliveredTurnIds).toEqual(['turn-1']);
    expect(harness.steerInputs[1]).toMatchObject({
      expectActiveTurnId: 'turn-1',
      idempotencyKey: 'req-1',
    });
  });

  it('answers a repeat AFTER the prompt Turn finished (probe path, ORIGINAL turnId)', async () => {
    let runtimeActiveTurn: string | undefined = 'turn-1';
    let promptTurn: string | undefined = 'turn-1';
    const harness = createReceiptBackedSteerRuntime({
      activeTurnId: () => runtimeActiveTurn,
    });
    const app = mountSteerExtensions({
      runtime: harness.runtime,
      activePromptTurnId: () => promptTurn,
    });

    await withSteerConnection(app, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'steered' });

      // The prompt Turn settles: no active prompt AND no runtime Turn.
      promptTurn = undefined;
      runtimeActiveTurn = undefined;
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'duplicate' });
    });

    expect(harness.deliveredTurnIds).toEqual(['turn-1']);
    // The repeat took the read-only probe: no Turn pin, lookup-only.
    expect(harness.steerInputs[1]).toMatchObject({
      receiptLookupOnly: true,
      idempotencyKey: 'req-1',
    });
    expect(harness.steerInputs[1]?.expectActiveTurnId).toBeUndefined();
  });

  it('answers a repeat AFTER a LATER Turn started with the ORIGINAL turnId', async () => {
    let runtimeActiveTurn = 'turn-1';
    let promptTurn: string | undefined = 'turn-1';
    const harness = createReceiptBackedSteerRuntime({
      activeTurnId: () => runtimeActiveTurn,
    });
    const app = mountSteerExtensions({
      runtime: harness.runtime,
      activePromptTurnId: () => promptTurn,
    });

    await withSteerConnection(app, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'steered' });

      // A NEW prompt Turn is admitted; the client retries the old delivery.
      promptTurn = 'turn-2';
      runtimeActiveTurn = 'turn-2';
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'duplicate' });
    });

    // The receipt won: ORIGINAL turnId, and the new Turn got nothing.
    expect(harness.deliveredTurnIds).toEqual(['turn-1']);
    expect(harness.steerInputs[1]).toMatchObject({ expectActiveTurnId: 'turn-2' });
  });

  it('answers a repeat from a RECONNECTED client (fresh prompt state, same receipts)', async () => {
    let runtimeActiveTurn: string | undefined = 'turn-1';
    const harness = createReceiptBackedSteerRuntime({
      activeTurnId: () => runtimeActiveTurn,
    });
    const firstConnection = mountSteerExtensions({
      runtime: harness.runtime,
      activePromptTurnId: () => 'turn-1',
    });
    await withSteerConnection(firstConnection, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'steered' });
    });

    // Reconnect: a fresh agent with NO prompt state; the runtime still runs.
    runtimeActiveTurn = undefined;
    const reconnected = mountSteerExtensions({
      runtime: harness.runtime,
      activePromptTurnId: () => undefined,
    });
    await withSteerConnection(reconnected, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'duplicate' });
    });

    expect(harness.deliveredTurnIds).toEqual(['turn-1']);
    expect(harness.steerInputs[1]).toMatchObject({ receiptLookupOnly: true });
  });

  it('refuses a repeat with NO receipt instead of activating or delivering', async () => {
    const harness = createReceiptBackedSteerRuntime({ activeTurnId: () => 'turn-9' });
    const app = mountSteerExtensions({
      runtime: harness.runtime,
      activePromptTurnId: () => undefined,
    });

    await withSteerConnection(app, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'never delivered before',
          clientRequestId: 'never-seen',
        }),
      ).rejects.toThrow('Steering was not delivered to the active ACP prompt Turn');
      // Without a replay identity there is nothing to probe: the refusal is
      // the pre-receipt one and the runtime is not called at all.
      await expect(
        steerRequest(connection, { sessionId: 'session-1', text: 'no identity' }),
      ).rejects.toThrow('admitted, active ACP prompt Turn');
    });

    expect(harness.deliveredTurnIds).toEqual([]);
    expect(harness.steerInputs).toHaveLength(1);
    expect(harness.steerInputs[0]).toMatchObject({
      receiptLookupOnly: true,
      idempotencyKey: 'never-seen',
    });
  });

  it('keeps an honest refusal for a NEW request whose pin misses the active Turn', async () => {
    const harness = createReceiptBackedSteerRuntime({ activeTurnId: () => 'turn-runtime' });
    const app = mountSteerExtensions({
      runtime: harness.runtime,
      // The prompt still names a Turn the runtime has already moved past.
      activePromptTurnId: () => 'turn-stale',
    });

    await withSteerConnection(app, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'fresh steer',
          clientRequestId: 'fresh-1',
        }),
      ).rejects.toThrow('Steering was not delivered to the active ACP prompt Turn');
    });

    // Not masked by a duplicate: no receipt existed, so nothing was delivered.
    expect(harness.deliveredTurnIds).toEqual([]);
  });

  it('refuses an unknown Session before touching any receipt', async () => {
    const harness = createReceiptBackedSteerRuntime({ activeTurnId: () => 'turn-1' });
    const app = mountSteerExtensions({
      runtime: harness.runtime,
      activePromptTurnId: () => 'turn-1',
      resolveSession: () => undefined,
    });

    await withSteerConnection(app, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'session-other',
          text: 'foreign session',
          clientRequestId: 'req-1',
        }),
      ).rejects.toThrow();
    });

    expect(harness.steer).not.toHaveBeenCalled();
  });

  it('settles two CONCURRENT repeats into one steered and one duplicate, one delivery', async () => {
    const harness = createReceiptBackedSteerRuntime({ activeTurnId: () => 'turn-1' });
    const app = mountSteerExtensions({
      runtime: harness.runtime,
      activePromptTurnId: () => 'turn-1',
    });

    await withSteerConnection(app, async (connection) => {
      const [first, second] = await Promise.allSettled([
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
        steerRequest(connection, {
          sessionId: 'session-1',
          text: 'change course',
          clientRequestId: 'req-1',
        }),
      ]);
      const modes = [first, second]
        .map((settled) => (settled.status === 'fulfilled' ? settled.value.mode : 'rejected'))
        .sort();
      expect(modes).toEqual(['duplicate', 'steered']);
    });

    expect(harness.deliveredTurnIds).toEqual(['turn-1']);
  });
});

describe('mcode/session/steer replay receipts over the REAL daemon wire', () => {
  let root: string;
  let daemon: McodedDaemon | undefined;
  let client: McodedClient | undefined;

  afterEach(async () => {
    client?.close();
    if (daemon) await daemon.shutdown();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('the receiptLookupOnly probe crosses the wire and the duplicate returns', { timeout: 60_000 }, async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'steer-receipt-wire-')));
    writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
    const events = new PushableIterable<unknown>();
    const steerCalls: ConversationSteerInput[] = [];
    const daemonCli = {
      createSession: async () => ({ sessionId: 'sess-1', workspaceDir: '/tmp/steer-receipt' }),
      getSession: async (req: { id?: string }) => ({
        sessionId: req.id ?? 'sess-1',
        workspaceDir: '/tmp/steer-receipt',
        archived: false,
        agentName: 'mavis',
      }),
      getPendingQuestionnaire: async () => ({}),
      listPendingPermissions: async () => ({ requests: [] }),
      replyPermission: async () => ({ success: true }),
      sendMessage: async () => ({ ok: true, source: (async function* () {})() }),
      abortSession: async () => ({ success: true }),
      // The daemon-side receipt answer: this delivery already happened on
      // turn-original, so every steer under this key duplicates it.
      steer: async (...args: unknown[]) => {
        const input = args[0] as ConversationSteerInput;
        steerCalls.push(input);
        return { turnId: 'turn-original', mode: 'duplicate' };
      },
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
      handshake: { token: 'test-token', dataDir: root, clientInstanceId: 'steer-receipt-1' },
      readyTimeoutMs: 10_000,
    });
    await client.connect();
    const { cliService } = composeTuiRemoteCliService(client);
    const runtime = new TuiRuntimeAdapter(cliService as never, {
      workspaceDir: '/tmp/steer-receipt',
    });

    // The reconnect/finished-Turn shape: the handler's prompt state is empty,
    // so the repeat must ride the read-only probe across the daemon wire.
    const app = mountSteerExtensions({
      runtime: runtime as never,
      activePromptTurnId: () => undefined,
    });
    await withSteerConnection(app, async (connection) => {
      await expect(
        steerRequest(connection, {
          sessionId: 'sess-1',
          text: 'change course',
          clientRequestId: 'req-wire-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-original', mode: 'duplicate' });
    });

    expect(steerCalls).toHaveLength(1);
    const wireInput = steerCalls[0] as unknown as Record<string, unknown>;
    // Lossless through the real JSON DTO (a dropped or mangled probe flag
    // would silently turn the probe into an unpinned delivery).
    expect(JSON.parse(JSON.stringify(wireInput))).toStrictEqual(wireInput);
    expect(wireInput['receiptLookupOnly']).toBe(true);
    expect(wireInput['expectActiveTurnId']).toBeUndefined();
    expect(wireInput['idempotencyKey']).toBe('req-wire-1');
  });
});
