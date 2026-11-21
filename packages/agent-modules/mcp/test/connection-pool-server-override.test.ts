/**
 * Session server override tests — W08 pi-mcp absorption edition.
 *
 * The pool's connection-key semantics are facade policy and unchanged; what
 * changed is the engine: transports come from the pi-mcp-backed factory and
 * connections are pi `McpClient` instances (initialize handshake, roots,
 * listTools array shape). The mocks pin the NEW signatures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpConnectionPool } from '../src/runtime/connection-pool.js';

const state = vi.hoisted(() => ({
  transports: [] as unknown[],
  clients: [] as Array<{ transport?: unknown; options?: unknown }>,
}));

vi.mock('../src/runtime/transport/factory.js', () => ({
  createTransport: vi.fn((transport: unknown) => {
    const created = { transport, close: vi.fn(async () => undefined) };
    state.transports.push(created);
    return created;
  }),
}));

vi.mock(import('@earendil-works/pi-mcp'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-mcp')>();
  class FakeMcpClient {
    transport?: unknown;
    options?: unknown;

    constructor(options: unknown) {
      this.options = options;
      state.clients.push(this);
    }

    onClose(): () => void {
      return () => undefined;
    }

    onError(): () => void {
      return () => undefined;
    }

    async connect(transport: unknown): Promise<unknown> {
      this.transport = transport;
      return {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      };
    }

    async listTools(): Promise<Array<{ name: string; inputSchema: object }>> {
      return [{ name: 'ping', inputSchema: {} }];
    }

    async close(): Promise<void> {}
  }
  return { ...actual, McpClient: FakeMcpClient };
});

describe('McpConnectionPool session server override', () => {
  beforeEach(() => {
    state.transports.length = 0;
    state.clients.length = 0;
  });

  it('connects from the ephemeral descriptor and isolates connections by explicit key', async () => {
    const pool = new McpConnectionPool({ getResolvedServer: () => null });
    const descriptor = {
      name: 'client-tools',
      enabled: true,
      transport: {
        type: 'stdio' as const,
        command: process.execPath,
        args: ['server.mjs'],
      },
    };

    await pool.listTools('client-tools', {
      connectionKey: 'acp-session:one:client-tools',
      serverOverride: descriptor,
    });
    await pool.listTools('client-tools', {
      connectionKey: 'acp-session:two:client-tools',
      serverOverride: descriptor,
    });

    expect(state.transports).toHaveLength(2);
    expect(state.clients).toHaveLength(2);
    expect(state.transports).toEqual([
      expect.objectContaining({ transport: descriptor.transport }),
      expect.objectContaining({ transport: descriptor.transport }),
    ]);
    // roots identity follows the ephemeral descriptor (no workspaceRoot → home)
    const roots = state.clients.map(
      (client) =>
        (client.options as { roots?: Array<{ name: string }> }).roots?.[0]?.name,
    );
    expect(roots).toEqual(['home', 'home']);

    await pool.shutdown();
  });

  it('separates raw server names from another server scope and disconnects only that server', async () => {
    const pool = new McpConnectionPool({
      getResolvedServer: (name) => ({
        name,
        enabled: true,
        transport: { type: 'http', url: `https://example.com/${name}` },
      }),
    });
    try {
      await pool.listTools('docs:scope');
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(2);
      await pool.disconnect('docs:scope');
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(2);
      await pool.listTools('docs:scope');
      expect(state.clients).toHaveLength(3);
    } finally {
      await pool.shutdown();
    }
  });

  it('does not mistake a JSON-shaped raw server for an encoded key during disconnect', async () => {
    const pool = new McpConnectionPool({
      getResolvedServer: (name) => ({
        name,
        enabled: true,
        transport: { type: 'http', url: 'https://example.com' },
      }),
    });
    try {
      await pool.listTools('docs', { connectionKey: 'scope' });
      await pool.disconnect('["docs","scope"]');
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(1);
      await pool.listTools('["docs","scope"]');
      expect(state.clients).toHaveLength(2);
      await pool.disconnect('["docs","scope"]');
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(2);
    } finally {
      await pool.shutdown();
    }
  });

  it('keeps relative and once-prefixed scopes equivalent without merging an explicit empty scope', async () => {
    const pool = new McpConnectionPool({
      getResolvedServer: (name) => ({
        name,
        enabled: true,
        transport: { type: 'http', url: 'https://example.com' },
      }),
    });
    try {
      await pool.listTools('docs');
      await pool.listTools('docs', { connectionKey: '' });
      expect(state.clients).toHaveLength(1);
      await pool.listTools('docs', { connectionKey: 'scope' });
      await pool.listTools('docs', { connectionKey: 'docs:scope' });
      expect(state.clients).toHaveLength(2);
      await pool.listTools('docs', { connectionKey: 'docs:' });
      expect(state.clients).toHaveLength(3);
      await pool.listTools('docs', { connectionKey: 'docs:docs:scope' });
      expect(state.clients).toHaveLength(4);
      await pool.disconnect('docs', { connectionKey: 'docs:scope' });
      await pool.listTools('docs');
      await pool.listTools('docs', { connectionKey: 'docs:' });
      expect(state.clients).toHaveLength(4);
      await pool.listTools('docs', { connectionKey: 'scope' });
      expect(state.clients).toHaveLength(5);
    } finally {
      await pool.shutdown();
    }
  });
});
