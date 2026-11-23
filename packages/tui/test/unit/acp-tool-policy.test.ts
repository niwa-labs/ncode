/**
 * Wire pins (embedded agent) for the per-session built-in tool policy:
 * `MCODE_SERVER_MODE=off` shape with the runtime in-process. The mock runtime
 * backs the tool-policy ports with the REAL v2 registry over the REAL file
 * store (as production composes it), so the pins exercise the agent's wire
 * behavior against the shipped registry semantics — the store-authoritative
 * cold-restart restore, the turn-active refusal and the supplied-server set.
 */

import * as acp from '@agentclientprotocol/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionToolPolicyFileStore,
  createSessionToolPolicyRegistry,
} from '@mavis/local-runtime-v2';

import { createTuiAcpAgent } from '../../src/acp/agent.js';
import type { TuiAcpRuntime } from '../../src/acp/runtime.js';
import type { TuiSession } from '../../src/runtime/port.js';

const TOOL_POLICY_META = 'minimax-code/toolPolicy';

const tempRoots: string[] = [];

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'acp-tool-policy-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

interface EmbeddedRuntimeHarness {
  readonly runtime: TuiAcpRuntime;
  readonly registry: ReturnType<typeof createSessionToolPolicyRegistry>;
  readonly createSession: ReturnType<typeof vi.fn>;
  /** The dataDir backing the registry store (shared across a cold restart). */
  readonly dataDir: string;
  /** Marks a Session as having a running Turn (the registry's probe input). */
  setActive(sessionId: string | undefined): void;
}

function createEmbeddedRuntime(dataDirInput?: string): EmbeddedRuntimeHarness {
  const dataDir = dataDirInput ?? tempDataDir();
  let active: string | undefined;
  const registry = createSessionToolPolicyRegistry({
    store: createSessionToolPolicyFileStore(dataDir),
    isTurnActive: (sessionId) => active === sessionId,
  });
  let nextSession = 0;
  const sessions = new Map<string, TuiSession>();
  const createSession = vi.fn(async ({ workspaceDir }: { workspaceDir: string }) => {
    nextSession += 1;
    const session: TuiSession = { sessionId: `session-${nextSession}`, workspaceDir };
    sessions.set(session.sessionId, session);
    return session;
  });
  const wireView = (entry: { allow: ReadonlySet<string>; servers: ReadonlySet<string>; origin: string } | undefined) =>
    entry === undefined ? undefined : { allow: [...entry.allow], servers: [...entry.servers], origin: entry.origin };
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
    getSession: vi.fn(
      async (sessionId: string) =>
        sessions.get(sessionId) ?? { sessionId, workspaceDir: '/workspace' },
    ),
    listMessagePage: vi.fn(async () => ({ messages: [], hasMore: false })),
    getMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async function* sendMessage() {
      yield { type: 'session-status', status: 'finished' as const, turnId: 'turn-1' };
      yield { type: 'done' as const };
    }),
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
    getPermissionMode: vi.fn(async () => 'default' as const),
    setPermissionMode: vi.fn(async (mode: 'default') => mode),
    replyPermission: vi.fn(async () => true),
    replyQuestionnaire: vi.fn(async () => true),
    dismissQuestionnaire: vi.fn(async () => true),
    watchEvents: vi.fn((_signal: AbortSignal) => (async function* runtimeEvents() {})()),
    watchSessionTurn: vi.fn(() => (async function* sessionEvents() {})()),
    enqueueMessage: vi.fn(async () => ({ itemId: 'queue-1', position: 1 })),
    listQueuedMessages: vi.fn(async () => []),
    bindSessionPermissionMode: vi.fn(async () => ({ ok: true })),
    setSessionPermissionMode: vi.fn(async () => ({ ok: true })),
    getSessionPermissionMode: vi.fn(async () => 'default' as const),
    bindSessionToolPolicy: vi.fn(
      async (
        sessionId: string,
        request: { allow?: readonly string[]; servers?: readonly string[] },
        origin: 'new-explicit' | 'load-explicit' | 'inherited',
      ) => {
        const result = registry.bind(sessionId, request?.allow, origin, request?.servers);
        if (!result.ok) {
          return {
            ok: false as const,
            error: { code: 'turn_active' as const, current: wireView(result.error.current) ?? null },
          };
        }
        return result.entry === undefined
          ? { ok: true as const }
          : { ok: true as const, entry: wireView(result.entry) };
      },
    ),
    getSessionToolPolicy: vi.fn(async (sessionId: string) => wireView(registry.get(sessionId))),
  };
  return {
    runtime: runtime as unknown as TuiAcpRuntime,
    registry,
    createSession,
    dataDir,
    setActive: (sessionId) => {
      active = sessionId;
    },
  };
}

async function withAgent<T>(
  harness: EmbeddedRuntimeHarness,
  run: (connection: acp.AgentConnection) => Promise<T>,
): Promise<T> {
  const client = acp.client({ name: 'pin-client' });
  await client.connectWith(
    createTuiAcpAgent({ runtime: harness.runtime, version: '1.0.0' }),
    async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await run(connection);
    },
  );
  return undefined as never;
}

interface SessionToolsResult {
  policy:
    | { mode: 'legacy' }
    | { mode: 'allow'; allow: string[]; servers: string[] };
  catalog: { name: string; source: string }[];
  basis: string;
  effective: string[];
}

const mcpServer = (name: string) => ({
  name,
  type: 'stdio' as const,
  command: 'synthetic-server',
  args: [],
  env: [],
});

describe('ACP per-session tool policy (embedded)', () => {
  it('session/new binds the policy with the supplied servers, and mcode/session/tools answers', async () => {
    const harness = createEmbeddedRuntime();
    await withAgent(harness, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [mcpServer('niwa')],
        _meta: { [TOOL_POLICY_META]: { allow: ['bash', 'read'] } },
      });
      expect(created.sessionId).toBe('session-1');
      const entry = harness.registry.get('session-1')!;
      expect([...entry.allow].sort()).toEqual(['bash', 'read']);
      expect([...entry.servers]).toEqual(['niwa']);

      const tools = (await connection.request('mcode/session/tools', {
        sessionId: 'session-1',
      })) as SessionToolsResult;
      expect(tools.policy).toEqual({ mode: 'allow', allow: ['bash', 'read'], servers: ['niwa'] });
      // The effective set follows the CATALOG order, not the request order,
      // and reports the ceiling it is held to.
      expect(tools.effective).toEqual(['read', 'bash']);
      expect(tools.basis).toBe('catalog');
      // The stable catalog carries its sources, extras included.
      expect(tools.catalog).toContainEqual({ name: 'read', source: 'builtin' });
      expect(tools.catalog).toContainEqual({ name: 'images_understand', source: 'builtin-matrix' });
      expect(tools.catalog).toContainEqual({ name: 'task', source: 'builtin' });
      expect(tools.catalog).toContainEqual({ name: 'web_search', source: 'builtin-matrix' });
    });
  });

  it('an unknown name refuses the whole creation with the catalog spelled out', async () => {
    const harness = createEmbeddedRuntime();
    await withAgent(harness, async (connection) => {
      const before = harness.createSession.mock.calls.length;
      await expect(
        connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
          _meta: { [TOOL_POLICY_META]: { allow: ['read', 'not_a_tool'] } },
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('unknown tool names'),
        data: {
          unknown: ['not_a_tool'],
          allowed: expect.arrayContaining(['read', 'bash', 'task', 'run_code']),
        },
      });
      expect(harness.createSession.mock.calls.length).toBe(before);
    });
  });

  it('an empty list means no built-in tool; an absent key keeps the previous mode', async () => {
    const harness = createEmbeddedRuntime();
    await withAgent(harness, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
        _meta: { [TOOL_POLICY_META]: { allow: [] } },
      });
      const tools = (await connection.request('mcode/session/tools', {
        sessionId: created.sessionId,
      })) as SessionToolsResult;
      expect(tools.policy).toEqual({ mode: 'allow', allow: [], servers: [] });
      expect(tools.effective).toEqual([]);

      // Load without the key changes nothing.
      await connection.request(acp.methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      const afterLoad = (await connection.request('mcode/session/tools', {
        sessionId: created.sessionId,
      })) as SessionToolsResult;
      expect(afterLoad.policy).toEqual({ mode: 'allow', allow: [], servers: [] });
    });
  });

  it('load re-binds monotonically: a wider list never widens the session', async () => {
    const harness = createEmbeddedRuntime();
    await withAgent(harness, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [mcpServer('niwa')],
        _meta: { [TOOL_POLICY_META]: { allow: ['read', 'bash', 'grep'] } },
      });

      await connection.request(acp.methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: '/workspace',
        mcpServers: [mcpServer('niwa'), mcpServer('ambient')],
        _meta: { [TOOL_POLICY_META]: { allow: ['read', 'bash', 'write'] } },
      });
      const widened = (await connection.request('mcode/session/tools', {
        sessionId: created.sessionId,
      })) as SessionToolsResult;
      expect(widened.effective).toEqual(['read', 'bash']);
      // The server set narrows the same way: 'ambient' was never supplied
      // when the ceiling was bound.
      expect(widened.policy).toEqual({ mode: 'allow', allow: ['read', 'bash'], servers: ['niwa'] });

      // resume narrows the same way.
      await connection.request(acp.methods.agent.session.resume, {
        sessionId: created.sessionId,
        cwd: '/workspace',
        mcpServers: [mcpServer('niwa')],
        _meta: { [TOOL_POLICY_META]: { allow: ['read'] } },
      });
      const narrowed = (await connection.request('mcode/session/tools', {
        sessionId: created.sessionId,
      })) as SessionToolsResult;
      expect(narrowed.effective).toEqual(['read']);
    });
  });

  it('a CHANGING bind is refused while a Turn runs; the session keeps its ceiling', async () => {
    const harness = createEmbeddedRuntime();
    await withAgent(harness, async (connection) => {
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
        _meta: { [TOOL_POLICY_META]: { allow: ['read', 'bash'] } },
      });
      harness.setActive(created.sessionId);

      // Re-sending the session's own policy passes (the cold-resume shape).
      await connection.request(acp.methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: '/workspace',
        mcpServers: [],
        _meta: { [TOOL_POLICY_META]: { allow: ['bash', 'read'] } },
      });
      // A narrowing under the running Turn is refused with the honest reason.
      await expect(
        connection.request(acp.methods.agent.session.load, {
          sessionId: created.sessionId,
          cwd: '/workspace',
          mcpServers: [],
          _meta: { [TOOL_POLICY_META]: { allow: ['read'] } },
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('a turn is active in this session'),
      });
      // A failed load detaches the ACP client. Reattach with no policy
      // request and read back the ceiling that survived the refusal.
      await connection.request(acp.methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      const tools = (await connection.request('mcode/session/tools', {
        sessionId: created.sessionId,
      })) as SessionToolsResult;
      expect(tools.policy).toEqual({ mode: 'allow', allow: ['read', 'bash'], servers: [] });
    });
  });

  it('two simultaneous sessions hold independent policies', async () => {
    const harness = createEmbeddedRuntime();
    await withAgent(harness, async (connection) => {
      const first = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
        _meta: { [TOOL_POLICY_META]: { allow: ['read'] } },
      });
      const second = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [mcpServer('niwa')],
        _meta: { [TOOL_POLICY_META]: { allow: ['bash'] } },
      });
      const firstTools = (await connection.request('mcode/session/tools', {
        sessionId: first.sessionId,
      })) as SessionToolsResult;
      const secondTools = (await connection.request('mcode/session/tools', {
        sessionId: second.sessionId,
      })) as SessionToolsResult;
      expect(firstTools.effective).toEqual(['read']);
      expect(secondTools.effective).toEqual(['bash']);
    });
  });

  it('a cold restart restores the ceiling: no policy key and no wider list can widen it', async () => {
    const first = createEmbeddedRuntime();
    await withAgent(first, async (connection) => {
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [mcpServer('niwa')],
        _meta: { [TOOL_POLICY_META]: { allow: ['read', 'bash'] } },
      });
    });

    // A NEW runtime process over the same dataDir (the embedded off-mode
    // cold-resume shape): the sidecar store carries the ceiling, and every
    // read consults the store — a second process cannot widen what the first
    // narrowed.
    const second = createEmbeddedRuntime(first.dataDir);
    await withAgent(second, async (connection) => {
      await connection.request(acp.methods.agent.session.load, {
        sessionId: 'session-1',
        cwd: '/workspace',
        mcpServers: [mcpServer('niwa')],
      });
      const restored = (await connection.request('mcode/session/tools', {
        sessionId: 'session-1',
      })) as SessionToolsResult;
      expect(restored.policy).toEqual({
        mode: 'allow',
        allow: ['read', 'bash'],
        servers: ['niwa'],
      });

      // A wider explicit list still narrows to the restored ceiling.
      await connection.request(acp.methods.agent.session.resume, {
        sessionId: 'session-1',
        cwd: '/workspace',
        mcpServers: [mcpServer('niwa'), mcpServer('other')],
        _meta: { [TOOL_POLICY_META]: { allow: ['read', 'bash', 'write', 'grep'] } },
      });
      const widened = (await connection.request('mcode/session/tools', {
        sessionId: 'session-1',
      })) as SessionToolsResult;
      expect(widened.effective).toEqual(['read', 'bash']);
      expect(widened.policy).toEqual({ mode: 'allow', allow: ['read', 'bash'], servers: ['niwa'] });
    });
  });
});
