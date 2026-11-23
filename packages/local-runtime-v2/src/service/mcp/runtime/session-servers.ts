import { isAbsolute } from 'node:path';

import type { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type { McpConnectionTokenOverrides } from '@mavis/mcp/runtime/types';
import { sessionMcpConnectionKey, requireSessionId } from './settings-config.js';
import type { LocalMcpServerConfig, LocalMcpSessionServer } from '../contracts.js';
import { configToTransportConfig, normalizeServerName } from './config.js';

interface SessionServerBinding {
  cwd?: string;
  abort: AbortController;
}

/** ACP-owned ephemeral configurations, independent of repository MCP configuration. */
export class SessionMcpServers {
  private readonly servers = new Map<string, Readonly<Record<string, LocalMcpServerConfig>>>();
  // Remember stale configs long enough to reject calls racing a replacement or removal.
  private readonly bindings = new WeakMap<LocalMcpServerConfig, SessionServerBinding>();

  constructor(private readonly pool?: McpConnectionPool) {}
  get(sessionId: string): Readonly<Record<string, LocalMcpServerConfig>> | undefined {
    return this.servers.get(sessionId);
  }
  clear(): void {
    this.servers.clear();
  }

  async configure(
    sessionId: string,
    servers: readonly LocalMcpSessionServer[],
    sessionCwd?: string,
  ): Promise<void> {
    const id = requireSessionId(sessionId);
    const next: Record<string, LocalMcpServerConfig> = Object.create(null);
    const abort = new AbortController();
    for (const server of servers) {
      const name = normalizeServerName(server.name);
      if (Object.hasOwn(next, name)) throw new Error(`Duplicate session MCP server name: ${name}`);
      const config = { ...server.config, enabled: true, configured: true, builtin: false };
      if (!configToTransportConfig(config))
        throw new Error(`Session MCP server "${name}" has no usable transport.`);
      this.bindings.set(config, { cwd: server.cwd ?? sessionCwd, abort });
      next[name] = config;
    }
    await this.remove(id);
    if (Object.keys(next).length > 0) this.servers.set(id, Object.freeze(next));
  }

  async remove(sessionId: string): Promise<void> {
    const id = requireSessionId(sessionId);
    const current = this.servers.get(id);
    this.servers.delete(id);
    if (!current) return;
    const pool = this.pool;
    await Promise.allSettled(
      Object.entries(current).map(([server, config]) => {
        this.bindings.get(config)?.abort.abort();
        return pool?.disconnect(server, { connectionKey: sessionMcpConnectionKey(id, server) });
      }),
    );
  }

  signal(config: LocalMcpServerConfig): AbortSignal | undefined {
    return this.bindings.get(config)?.abort.signal;
  }

  overrides(
    server: string,
    config: LocalMcpServerConfig,
    sessionId?: string,
  ): McpConnectionTokenOverrides | undefined {
    const binding = this.bindings.get(config);
    if (!binding) return undefined;
    const name = normalizeServerName(server);
    if (!sessionId || this.get(sessionId)?.[name] !== config) {
      throw new Error('Session MCP configuration changed before connection.');
    }
    const transport = configToTransportConfig(config);
    if (!transport) return undefined;
    if (transport.type === 'stdio') {
      const { cwd } = binding;
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
        throw new Error(
          `Session MCP server "${server}" (stdio) requires an absolute working directory.`,
        );
      }
      // Spawn checks whether this directory still exists and is accessible.
      transport.cwd = cwd;
    }
    return {
      connectionKey: sessionMcpConnectionKey(sessionId, name),
      serverOverride: {
        name: server,
        enabled: true,
        transport,
        ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
      },
    };
  }
}
