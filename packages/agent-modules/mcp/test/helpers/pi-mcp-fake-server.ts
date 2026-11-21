/**
 * Scripted MCP server over the pi-mcp in-memory transport pair.
 *
 * pi-mcp ships no server class (client-only package), so the pool tests run a
 * minimal JSON-RPC responder: it answers `initialize`, serves the configured
 * `tools` / `resources` maps, honors `roots/list`, records `notifications/
 * cancelled`, and can simulate protocol-level failures. This is the
 * replacement for the retired `@modelcontextprotocol/sdk` in-memory handshake
 * fixtures (W08 absorption, §4 :504).
 */
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  type JsonRpcMessage,
  LATEST_PROTOCOL_VERSION,
} from '@earendil-works/pi-mcp';
import { createInMemoryTransportPair, type InMemoryTransport } from '@earendil-works/pi-mcp/testing';

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ScriptedServerOptions {
  clientInfo?: { name: string; version: string };
  tools?: FakeMcpTool[];
  /** method → handler returning the JSON-RPC `result`. */
  handlers?: Record<string, (params: Record<string, unknown> | undefined) => unknown>;
  /** Record server→client method names observed (initialize, roots/list, …). */
  onRequest?: (method: string, params: Record<string, unknown> | undefined) => void;
  onNotification?: (method: string, params: unknown) => void;
  capabilities?: Record<string, unknown>;
}

export interface ScriptedServer {
  clientTransport: InMemoryTransport;
  /** Raw access for failure injection (transport close / error). */
  serverTransport: InMemoryTransport;
  initializeRequests: Array<Record<string, unknown> | undefined>;
  cancelledRequests: Array<{ requestId: unknown; reason?: string }>;
  close(): Promise<void>;
}

export function createScriptedMcpServer(options: ScriptedServerOptions = {}): ScriptedServer {
  const { client: clientTransport, server: serverTransport } = createInMemoryTransportPair();
  // The scripted side must be started before the client connects: the pi
  // in-memory transport refuses to deliver until the peer has started.
  void serverTransport.start();
  const scripted: ScriptedServer = {
    clientTransport,
    serverTransport,
    initializeRequests: [],
    cancelledRequests: [],
    close: async () => {
      await serverTransport.close();
    },
  };

  const tools = options.tools ?? [{ name: 'ping', inputSchema: { type: 'object' } }];
  const dispatch = new Map<string, (params: Record<string, unknown> | undefined) => unknown>();
  const capabilities = options.capabilities ?? { tools: {}, resources: {} };
  dispatch.set('initialize', (params) => {
    scripted.initializeRequests.push(params);
    const requested = params?.['protocolVersion'];
    return {
      protocolVersion:
        typeof requested === 'string' ? requested : LATEST_PROTOCOL_VERSION,
      capabilities,
      serverInfo: options.clientInfo ?? { name: 'fake-mcp', version: '1.0.0' },
    };
  });
  dispatch.set('tools/list', () => ({ tools }));
  dispatch.set('tools/call', (params) => {
    const name = typeof params?.['name'] === 'string' ? params['name'] : '';
    const custom = options.handlers?.['tools/call'];
    if (custom) return custom(params);
    if (name === 'boom') {
      return { content: [{ type: 'text', text: 'tool failed' }], isError: true };
    }
    return { content: [{ type: 'text', text: 'pong' }] };
  });
  dispatch.set('resources/list', () => ({
    resources: [
      { uri: 'file:///notes.md', name: 'notes.md', mimeType: 'text/markdown' },
    ],
  }));
  dispatch.set('resources/templates/list', () => ({ resourceTemplates: [] }));
  dispatch.set('resources/read', (params) => ({
    contents: [
      { uri: String(params?.['uri'] ?? ''), mimeType: 'text/markdown', text: '# Notes' },
    ],
  }));
  dispatch.set('ping', () => ({}));
  for (const [method, handler] of Object.entries(options.handlers ?? {})) {
    if (method === 'tools/call') continue; // merged above
    dispatch.set(method, handler);
  }

  serverTransport.onMessage((message: JsonRpcMessage) => {
    if (!isJsonRpcRequest(message)) {
      if (isJsonRpcNotification(message)) {
        options.onNotification?.(message.method, message.params);
        if (message.method === 'notifications/cancelled') {
          const params = message.params as { requestId?: unknown; reason?: string } | undefined;
          scripted.cancelledRequests.push({
            requestId: params?.requestId,
            ...(params?.reason !== undefined ? { reason: params.reason } : {}),
          });
        }
      }
      return;
    }
    const handler = dispatch.get(message.method);
    options.onRequest?.(message.method, message.params);
    void (async () => {
      if (!handler) {
        await serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
        return;
      }
      try {
        const result = handler(message.params);
        const resolved = result instanceof Promise ? await result : result;
        await serverTransport.send({ jsonrpc: '2.0', id: message.id, result: resolved ?? {} });
      } catch (error) {
        await serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();
  });

  return scripted;
}
