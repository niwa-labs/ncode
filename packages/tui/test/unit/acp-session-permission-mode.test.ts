/**
 * §2 pins (embedded agent): the per-session permission-mode wire contract of
 * the ACP agent (`MCODE_SERVER_MODE=off` shape — the runtime is in-process).
 * The mock runtime backs the new optional port methods with the REAL v2
 * registry and mirrors §2.3 (sendMessage locks the Session's mode), so the
 * pins exercise the agent's wire behavior against the shipped registry
 * semantics. The daemon leg of the same pins lives in
 * acp-session-permission-mode.e2e.test.ts.
 */

import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import { createSessionPermissionModeRegistry } from '@mavis/local-runtime-v2';

import { createTuiAcpAgent } from '../../src/acp/agent.js';
import type { TuiAcpRuntime } from '../../src/acp/runtime.js';
import {
  TuiRuntimeAdapter,
  TuiSessionPermissionModeUnsupportedError,
} from '../../src/runtime/adapter.js';
import type { TuiSession } from '../../src/runtime/port.js';

interface EmbeddedRuntimeHarness {
  readonly runtime: TuiAcpRuntime;
  readonly registry: ReturnType<typeof createSessionPermissionModeRegistry>;
  readonly createSession: ReturnType<typeof vi.fn>;
  readonly getPermissionMode: ReturnType<typeof vi.fn>;
  readonly setPermissionMode: ReturnType<typeof vi.fn>;
  readonly sendMessage: ReturnType<typeof vi.fn>;
  /** Marks a Session as having a running Turn (the registry's probe input). */
  setActive(sessionId: string | undefined): void;
}

function createEmbeddedRuntime(processMode: 'default' | 'auto' | 'bypassPermissions' | 'off' = 'auto'): EmbeddedRuntimeHarness {
  const registry = createSessionPermissionModeRegistry({
    isTurnActive: (sessionId) => active === sessionId,
  });
  let active: string | undefined;
  let nextSession = 0;
  const sessions = new Map<string, TuiSession>();
  const createSession = vi.fn(async ({ workspaceDir }: { workspaceDir: string }) => {
    nextSession += 1;
    const session: TuiSession = { sessionId: `session-${nextSession}`, workspaceDir };
    sessions.set(session.sessionId, session);
    return session;
  });
  let currentProcessMode: 'default' | 'auto' | 'bypassPermissions' | 'off' = processMode;
  const getPermissionMode = vi.fn(async () => currentProcessMode);
  const setPermissionMode = vi.fn(async (mode: 'default' | 'auto' | 'bypassPermissions' | 'off') => {
    currentProcessMode = mode;
    return mode;
  });
  const sendMessage = vi.fn(async function* sendMessage(req: { id: string }) {
    // §2.3 mirror: the first accepted Turn locks the Session's mode.
    registry.lock(req.id);
    yield { type: 'session-status', status: 'finished' as const, turnId: 'turn-1' };
    yield { type: 'done' as const };
  });
  const runtime = {
    createSession,
    getAccountStatus: vi.fn(async () => ({
      status: 'ready' as const,
      warnings: [],
    })),
    isGoalEnabled: () => false,
    configureSessionMcpServers: vi.fn(async () => undefined),
    clearSessionMcpServers: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    listSessionPage: vi.fn(async () => ({ sessions: [], hasMore: false })),
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? { sessionId, workspaceDir: '/workspace' }),
    listMessagePage: vi.fn(async () => ({ messages: [], hasMore: false })),
    sendMessage,
    abortSession: vi.fn(async () => true),
    steer: vi.fn(async () => ({ turnId: 'turn-1', mode: 'steered' as const })),
    listModels: vi.fn(async () => []),
    selectModel: vi.fn(async () => true),
    selectSessionModel: vi.fn(async () => true),
    getContextSnapshot: vi.fn(async () => ({ status: 'empty' as const })),
    getDelegationSnapshot: vi.fn(async () => ({ members: [] })),
    getSessionUsage: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => ({ skills: [] })),
    listMcpServers: vi.fn(async () => []),
    requestCompaction: vi.fn(async () => ({ success: true })),
    getPlanModeCapabilities: vi.fn(async () => ({ entryEnabled: true })),
    getPermissionMode,
    setPermissionMode,
    replyPermission: vi.fn(async () => true),
    replyQuestionnaire: vi.fn(async () => true),
    dismissQuestionnaire: vi.fn(async () => true),
    watchEvents: vi.fn((_signal: AbortSignal) => (async function* runtimeEvents() {})()),
    watchSessionTurn: vi.fn(() => (async function* sessionEvents() {})()),
    enqueueMessage: vi.fn(async () => ({ itemId: 'queue-1', position: 1 })),
    listQueuedMessages: vi.fn(async () => []),
    bindSessionPermissionMode: vi.fn(
      async (sessionId: string, mode: 'default' | 'auto' | 'bypassPermissions', origin: string) =>
        registry.bind(sessionId, mode, origin as never),
    ),
    setSessionPermissionMode: vi.fn(async (sessionId: string, mode: 'default' | 'auto' | 'bypassPermissions') =>
      registry.set(sessionId, mode),
    ),
    getSessionPermissionMode: vi.fn(async (sessionId: string) => registry.get(sessionId)?.mode),
  };
  return {
    runtime: runtime as unknown as TuiAcpRuntime,
    registry,
    createSession,
    getPermissionMode,
    setPermissionMode,
    sendMessage,
    setActive: (sessionId) => {
      active = sessionId;
    },
  };
}

function permissionOption(response: unknown): acp.SessionConfigOption | undefined {
  const options = (response as { configOptions?: acp.SessionConfigOption[] }).configOptions;
  return options?.find((option) => option.id === 'permissionMode');
}

async function withAgent<T>(
  harness: EmbeddedRuntimeHarness,
  run: (connection: acp.AgentConnection) => Promise<T>,
): Promise<T> {
  const client = acp.client({ name: 'pin-client' });
  await client.connectWith(createTuiAcpAgent({ runtime: harness.runtime, version: '1.0.0' }), async (connection) => {
    await connection.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await run(connection);
  });
  return undefined as never;
}

describe('ACP per-session permission mode (§2, embedded)', () => {
  it('new-meta-mode: explicit _meta wins; invalid values reject the request without creating a Session', async () => {
    const harness = createEmbeddedRuntime('default');
    await withAgent(harness, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
        _meta: { 'minimax-code/permissionMode': 'bypassPermissions' },
      });
      expect(permissionOption(created)).toMatchObject({
        currentValue: 'bypassPermissions',
        description: 'Permission mode for this session; fixed after the first prompt',
      });
      expect(harness.registry.get('session-1')).toMatchObject({
        mode: 'bypassPermissions',
        origin: 'new-explicit',
      });

      for (const invalid of ['off', 'acceptEdits', 'foo', 42]) {
        const before = harness.createSession.mock.calls.length;
        await expect(
          connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
            _meta: { 'minimax-code/permissionMode': invalid },
          }),
        ).rejects.toMatchObject({
          code: -32602,
          message: expect.stringContaining('invalid minimax-code/permissionMode'),
          data: { allowed: ['default', 'auto', 'bypassPermissions'] },
        });
        expect(harness.createSession.mock.calls.length).toBe(before);
      }
    });
  });

  it('new-without-mode-config-snapshot: the process mode is snapshotted; off maps to bypassPermissions', async () => {
    const auto = createEmbeddedRuntime('auto');
    await withAgent(auto, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(permissionOption(created)).toMatchObject({ currentValue: 'auto' });
      expect(auto.registry.get('session-1')).toMatchObject({ mode: 'auto', origin: 'new-default' });
    });

    const off = createEmbeddedRuntime('off');
    await withAgent(off, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      // §6.6: an ACP Session never runs in `off`.
      expect(permissionOption(created)).toMatchObject({ currentValue: 'bypassPermissions' });
      expect(off.registry.get('session-1')).toMatchObject({
        mode: 'bypassPermissions',
        origin: 'new-default',
      });
    });
  });

  it('load-without-mode-is-default: load and resume without _meta rebind a bypass Session to default', async () => {
    const harness = createEmbeddedRuntime('bypassPermissions');
    await withAgent(harness, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
        _meta: { 'minimax-code/permissionMode': 'bypassPermissions' },
      });
      const sessionId = created.sessionId;

      const loaded = await connection.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(permissionOption(loaded)).toMatchObject({ currentValue: 'default' });
      expect(harness.registry.get(sessionId)).toMatchObject({ mode: 'default', origin: 'load-default' });

      await connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'permissionMode',
        value: 'bypassPermissions',
      });
      const resumed = await connection.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(permissionOption(resumed)).toMatchObject({ currentValue: 'default' });
      expect(harness.registry.get(sessionId)).toMatchObject({ mode: 'default', origin: 'load-default' });
    });
  });

  it('load-with-mode-rebinds-and-unlocks: an explicit load mode overrides a locked Session', async () => {
    const harness = createEmbeddedRuntime('default');
    await withAgent(harness, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
        _meta: { 'minimax-code/permissionMode': 'default' },
      });
      const sessionId = created.sessionId;
      // One prompt locks the mode…
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'go' }],
      });
      expect(harness.registry.get(sessionId)?.locked).toBe(true);
      // …so a set_config_option change is refused…
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'permissionMode',
          value: 'auto',
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('permissionMode is fixed for the session after the first prompt'),
        data: { currentValue: 'default' },
      });
      // …but a load with an explicit mode rebinds and lifts the lock.
      const loaded = await connection.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: '/workspace',
        mcpServers: [],
        _meta: { 'minimax-code/permissionMode': 'bypassPermissions' },
      });
      expect(permissionOption(loaded)).toMatchObject({ currentValue: 'bypassPermissions' });
      expect(harness.registry.get(sessionId)).toMatchObject({
        mode: 'bypassPermissions',
        locked: false,
        origin: 'load-explicit',
      });
      // The lock re-arms on the first prompt after the load.
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'again' }],
      });
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'permissionMode',
          value: 'auto',
        }),
      ).rejects.toMatchObject({ code: -32602, data: { currentValue: 'bypassPermissions' } });
    });
  });

  it('lock-after-first-turn: free before the first prompt, fixed to the same value after it', async () => {
    const harness = createEmbeddedRuntime('default');
    await withAgent(harness, async (connection) => {
      const { sessionId } = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      // Before the first prompt the option may change.
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'permissionMode',
          value: 'auto',
        }),
      ).resolves.toMatchObject({
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'permissionMode', currentValue: 'auto' }),
        ]),
      });
      expect(harness.registry.get(sessionId)).toMatchObject({ mode: 'auto', origin: 'set-config' });

      await connection.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'go' }],
      });
      // Same value after the lock: ok (no-op)…
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'permissionMode',
          value: 'auto',
        }),
      ).resolves.toBeDefined();
      // …another value: -32602 with the current one.
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'permissionMode',
          value: 'default',
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('permissionMode is fixed for the session after the first prompt'),
        data: { currentValue: 'auto' },
      });
    });
  });

  it('set-config-option-session-scoped: changing session A never touches session B', async () => {
    const harness = createEmbeddedRuntime('default');
    await withAgent(harness, async (connection) => {
      const a = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const b = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const result = await connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: a.sessionId,
        configId: 'permissionMode',
        value: 'bypassPermissions',
      });
      expect(permissionOption(result)).toMatchObject({ currentValue: 'bypassPermissions' });
      expect(harness.registry.get(a.sessionId)).toMatchObject({ mode: 'bypassPermissions' });
      expect(harness.registry.get(b.sessionId)).toMatchObject({ mode: 'default' });
      expect(permissionOption(await connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: b.sessionId,
        configId: 'permissionMode',
        value: 'default',
      }))).toMatchObject({ currentValue: 'default' });
    });
  });

  it('process-mode-does-not-touch-acp-session: set_config_option never writes the process mode; a new Session snapshots it fresh', async () => {
    const harness = createEmbeddedRuntime('auto');
    await withAgent(harness, async (connection) => {
      const first = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      // The TUI surface may still flip the process mode; the ACP option must not.
      await connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: first.sessionId,
        configId: 'permissionMode',
        value: 'default',
      });
      expect(harness.setPermissionMode).not.toHaveBeenCalled();
      expect(harness.registry.get(first.sessionId)).toMatchObject({ mode: 'default' });

      // A process-mode change leaves the live Session's mode alone.
      await harness.runtime.setPermissionMode('bypassPermissions');
      expect(
        await harness.runtime.getSessionPermissionMode!(first.sessionId),
      ).toBe('default');

      // A NEW Session without _meta snapshots the new process value.
      const second = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(permissionOption(second)).toMatchObject({ currentValue: 'bypassPermissions' });
      expect(harness.registry.get(second.sessionId)).toMatchObject({
        mode: 'bypassPermissions',
        origin: 'new-default',
      });
    });
  });

  it('load-during-active-turn-conflict: a different mode under a running Turn is refused with the current value', async () => {
    const harness = createEmbeddedRuntime('default');
    await withAgent(harness, async (connection) => {
      const { sessionId } = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
        _meta: { 'minimax-code/permissionMode': 'default' },
      });
      harness.setActive(sessionId);
      await expect(
        connection.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: '/workspace',
          mcpServers: [],
          _meta: { 'minimax-code/permissionMode': 'bypassPermissions' },
        }),
      ).rejects.toMatchObject({
        code: -32602,
        data: { currentValue: 'default' },
      });
      expect(harness.registry.get(sessionId)).toMatchObject({ mode: 'default' });
      // The same mode under the running Turn rebinds fine.
      harness.setActive(undefined);
    });
  });

  it('old-daemon-without-rpc: a METHOD_NOT_ALLOWED daemon surfaces as -32603, never a process-mode fallback', async () => {
    // Adapter leg: the daemon-side METHOD_NOT_ALLOWED wire error (an
    // McodedRemoteError with that stable code) becomes the dedicated
    // unsupported error — the exact mapping the daemon transport delivers.
    const methodNotAllowed = Object.assign(
      new Error('method "bindSessionPermissionMode" is not in the allowlist'),
      { code: 'METHOD_NOT_ALLOWED' },
    );
    const adapter = new TuiRuntimeAdapter({
      bindSessionPermissionMode: async () => {
        throw methodNotAllowed;
      },
    } as never);
    await expect(adapter.bindSessionPermissionMode('s1', 'default', 'new-explicit')).rejects.toBeInstanceOf(
      TuiSessionPermissionModeUnsupportedError,
    );

    // Agent leg: the unsupported error answers -32603 with the restart hint.
    const harness = createEmbeddedRuntime('default');
    (harness.runtime as unknown as { bindSessionPermissionMode: unknown }).bindSessionPermissionMode = vi.fn(
      async () => {
        throw new TuiSessionPermissionModeUnsupportedError();
      },
    );
    await withAgent(harness, async (connection) => {
      await expect(
        connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
          _meta: { 'minimax-code/permissionMode': 'bypassPermissions' },
        }),
      ).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('runtime does not support per-session permissionMode; restart mcoded'),
      });
      // Without _meta the new-default bind path must fail equally loudly.
      await expect(
        connection.request(acp.methods.agent.session.new, { cwd: '/workspace', mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32603 });
    });
  });
});
