/**
 * W08 pi-mcp absorption conformance loop (`@mavis/mcp` facade over pinned
 * `@earendil-works/pi-mcp`).
 *
 * Drives the real pi protocol over an in-memory transport pair (scripted
 * server from `helpers/pi-mcp-fake-server.ts`) with only the transport
 * factory mocked, covering the W08 gate surfaces for the MCP module:
 *
 *   * protocol engine   — real pi `McpTransport` + `McpClient` handshake
 *                         through the pool (transports themselves are
 *                         exercised in `transport-factory.test.ts`).
 *   * protocol state    — initialize handshake re-runs on reconnect; a
 *                         dropped transport does not poison the pool.
 *   * roots             — the workspace root reaches the server's
 *                         `roots/list` request.
 *   * resources         — resources/list, templates, read through the pool.
 *   * errors            — tool isError, method-not-found, disabled server,
 *                         missing server.
 *   * auth              — 401-style rejection marks the connection
 *                         `needs-auth` and fails closed (no auto-retry of
 *                         the effect).
 *   * cancellation      — an aborted callTool sends
 *                         `notifications/cancelled` to the server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpConnectionPool } from '../src/runtime/connection-pool.js';
import type {
  McpConnectionPoolOptions,
  ResolvedMcpServer,
} from '../src/runtime/types.js';
import { createScriptedMcpServer, type ScriptedServer } from './helpers/pi-mcp-fake-server.js';

const { createTransportMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn<(config: unknown, overrides?: unknown) => unknown>(),
}));

vi.mock('../src/runtime/transport/factory.js', () => ({
  createTransport: createTransportMock,
}));

function stubLookup(server: ResolvedMcpServer): { getResolvedServer: () => ResolvedMcpServer } {
  return { getResolvedServer: () => server };
}

function makePool(
  server: ResolvedMcpServer,
  overrides?: Partial<McpConnectionPoolOptions>,
): McpConnectionPool {
  return new McpConnectionPool(stubLookup(server), {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  });
}

function seededClient(
  pool: McpConnectionPool,
  serverName: string,
): { client: { request: (m: string, p?: Record<string, unknown>) => Promise<unknown> } } {
  const conn = (
    pool as unknown as {
      connections: Map<
        string,
        { client: { request: (m: string, p?: Record<string, unknown>) => Promise<unknown> } }
      >;
    }
  ).connections.get(JSON.stringify([serverName, null]));
  if (!conn) throw new Error(`no connection for ${serverName}`);
  return conn;
}

const httpServer: ResolvedMcpServer = {
  name: 'demo',
  enabled: true,
  transport: { type: 'http', url: 'https://example.test/mcp' },
};

const projectServer: ResolvedMcpServer = {
  name: 'proj',
  enabled: true,
  workspaceRoot: '/tmp/project-root',
  transport: { type: 'http', url: 'https://example.test/mcp' },
};

const tick = async (times = 10): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('McpConnectionPool over pi-mcp — protocol loop', () => {
  let pool: McpConnectionPool | undefined;
  let scripted: ScriptedServer | undefined;

  afterEach(async () => {
    await pool?.shutdown();
    pool = undefined;
    await scripted?.close();
    scripted = undefined;
  });

  it('performs the initialize handshake through the pi client', async () => {
    scripted = createScriptedMcpServer();
    createTransportMock.mockImplementation(() => scripted!.clientTransport);
    pool = makePool(httpServer);

    const tools = await pool.listTools('demo');
    expect(tools).toEqual([{ name: 'ping', inputSchema: { type: 'object' } }]);
    expect(scripted.initializeRequests).toHaveLength(1);
    const init = scripted.initializeRequests[0] as {
      clientInfo: { name: string };
      protocolVersion: string;
    };
    expect(init.clientInfo.name).toBe('mavis-local-runtime-mcp');
    expect(typeof init.protocolVersion).toBe('string');
  });

  it('caches tools per connection and refetches on refreshTools', async () => {
    scripted = createScriptedMcpServer();
    createTransportMock.mockImplementation(() => scripted!.clientTransport);
    pool = makePool(httpServer);

    const first = await pool.listTools('demo');
    const second = await pool.listTools('demo');
    expect(second).toBe(first); // same cached array — no second wire call
    const refreshed = await pool.refreshTools('demo');
    expect(refreshed).not.toBe(first);
    expect(refreshed).toEqual(first);
  });

  it('answers the server roots/list request from the resolved workspaceRoot', async () => {
    scripted = createScriptedMcpServer();
    createTransportMock.mockImplementation(() => scripted!.clientTransport);

    type RootsReply = { id: unknown; result?: { roots?: Array<{ uri: string; name: string }> } };
    const replies: RootsReply[] = [];
    scripted.serverTransport.onMessage((message) => {
      if ('id' in message && !('method' in message)) {
        replies.push(message as RootsReply);
      }
    });

    pool = makePool(projectServer);
    await pool.listTools('proj');

    await scripted.serverTransport.send({
      jsonrpc: '2.0',
      id: 'roots-probe',
      method: 'roots/list',
    });
    await tick(4);

    const probe = replies.find((reply) => reply.id === 'roots-probe');
    expect(probe?.result?.roots).toEqual([{ uri: 'file:///tmp/project-root', name: 'project' }]);
  });

  it('falls back to the home root when no workspaceRoot is configured', async () => {
    scripted = createScriptedMcpServer();
    createTransportMock.mockImplementation(() => scripted!.clientTransport);
    pool = makePool(httpServer);
    await pool.listTools('demo');

    const os = await import('node:os');
    const { pathToFileURL } = await import('node:url');
    type ClientWithOptions = { options?: { roots?: Array<{ uri: string; name: string }> } };
    const conn = (
      pool as unknown as { connections: Map<string, { client: ClientWithOptions }> }
    ).connections.get(JSON.stringify(['demo', null]));
    expect(conn?.client?.options?.roots).toEqual([
      { uri: pathToFileURL(os.homedir()).href, name: 'home' },
    ]);
  });

  it('preserves structuredContent and _meta on tool results', async () => {
    scripted = createScriptedMcpServer({
      handlers: {
        'tools/call': () => ({
          content: [{ type: 'text', text: 'done' }],
          structuredContent: { ok: true, items: [1, 2] },
          _meta: { traceId: 't-1' },
        }),
      },
    });
    createTransportMock.mockImplementation(() => scripted!.clientTransport);
    pool = makePool(httpServer);

    const result = await pool.callTool('demo', 'structured', {});
    expect(result).toEqual({
      content: [{ type: 'text', text: 'done' }],
      isError: false,
      structuredContent: { ok: true, items: [1, 2] },
      _meta: { traceId: 't-1' },
    });
  });

  it('surfaces method-not-found as a rejected request, connection stays usable', async () => {
    scripted = createScriptedMcpServer();
    createTransportMock.mockImplementation(() => scripted!.clientTransport);
    pool = makePool(httpServer);
    await pool.listTools('demo');

    const { client } = seededClient(pool, 'demo');
    await expect(client.request('prompts/list', {})).rejects.toThrow(/Method not found/);

    // Pool still healthy afterwards.
    await expect(pool.callTool('demo', 'ping', {})).resolves.toMatchObject({ isError: false });
  });

  it('lists and reads resources through the pi client', async () => {
    scripted = createScriptedMcpServer();
    createTransportMock.mockImplementation(() => scripted!.clientTransport);
    pool = makePool(httpServer);

    const resources = await pool.listResources('demo');
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ uri: 'file:///notes.md', name: 'notes.md' });

    const templates = await pool.listResourceTemplates('demo');
    expect(templates).toEqual([]);

    const read = await pool.readResource('demo', 'file:///notes.md');
    expect(read.contents).toEqual([
      { uri: 'file:///notes.md', mimeType: 'text/markdown', text: '# Notes' },
    ]);
  });

  it('sends notifications/cancelled when a call is aborted mid-flight', async () => {
    scripted = createScriptedMcpServer({
      handlers: {
        'tools/call': () => new Promise(() => undefined), // never resolves
      },
    });
    createTransportMock.mockImplementation(() => scripted!.clientTransport);
    pool = makePool(httpServer);

    const controller = new AbortController();
    const call = pool.callTool('demo', 'slow', {}, undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(call).rejects.toThrow(/MCP tool call failed/);

    await tick(4);
    expect(scripted.cancelledRequests.length).toBeGreaterThanOrEqual(1);
  });

  it('marks the connection needs-auth when the transport reports an auth rejection', async () => {
    // The transport layer is where 401 becomes McpAuthRequiredError (HTTP
    // surface; the factory suite pins that error on a real 401 response).
    // Here the seeded client surfaces the same typed error so the pool's
    // classification is exercised: needs-auth marking + fail-closed message
    // (no automatic retry of the effect).
    const { McpAuthRequiredError } = await import('@earendil-works/pi-mcp');
    pool = makePool(httpServer);
    const fakeClient = {
      async readResource(): Promise<never> {
        throw new McpAuthRequiredError(new Response(null, { status: 401 }));
      },
      async close(): Promise<void> {},
    };
    (
      pool as unknown as {
        connections: Map<string, unknown>;
        connectionServerNames: Map<string, string>;
      }
    ).connections.set(JSON.stringify(['demo', null]), {
      key: JSON.stringify(['demo', null]),
      name: 'demo',
      state: 'connected',
      client: fakeClient,
      transport: null,
      tools: [],
      lastUsed: Date.now(),
    });
    (pool as unknown as { connectionServerNames: Map<string, string> }).connectionServerNames.set(
      JSON.stringify(['demo', null]),
      'demo',
    );

    await expect(pool.readResource('demo', 'file:///guarded')).rejects.toThrow(/requires sign-in/);
    const conn = (
      pool as unknown as { connections: Map<string, { state: string; error?: string }> }
    ).connections.get(JSON.stringify(['demo', null]));
    expect(conn?.state).toBe('needs-auth');
    expect(conn?.error).toBe('MCP server requires authentication');
  });

  it('rejects a disabled server and an unknown server without spawning anything', async () => {
    createTransportMock.mockClear();
    createTransportMock.mockImplementation(() => {
      throw new Error('no transport should be created');
    });
    pool = new McpConnectionPool(
      {
        getResolvedServer: (name) => (name === 'demo' ? { ...httpServer, enabled: false } : null),
      },
      { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );
    await expect(pool.callTool('demo', 'ping', {})).rejects.toThrow(/is disabled/);
    await expect(pool.listTools('ghost')).rejects.toThrow(/not found/);
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('reconnects with a fresh protocol session after the transport drops', async () => {
    scripted = createScriptedMcpServer();
    createTransportMock.mockImplementation(() => scripted!.clientTransport);
    pool = makePool(httpServer);

    await pool.listTools('demo');
    expect(scripted.initializeRequests).toHaveLength(1);

    // The server side dies (stdio child exit / HTTP drop).
    await scripted.serverTransport.close();
    await tick(10);

    // Next call must observe the gone connection and re-run the handshake.
    const second = createScriptedMcpServer();
    scripted = second;
    createTransportMock.mockImplementation(() => second.clientTransport);
    const tools = await pool.listTools('demo');
    expect(tools).toHaveLength(1);
    expect(second.initializeRequests).toHaveLength(1);
  });
});
