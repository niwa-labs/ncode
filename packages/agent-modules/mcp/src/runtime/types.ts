/**
 * Minimal MCP runtime types for the shared MCP substrate.
 *
 * W08 PORT-PI-1.3 (§4 map, row «MCP substrate/disclosure», plan :504): the old
 * `@modelcontextprotocol/sdk` transport/client engine is ABSORBED by the pinned
 * `@earendil-works/pi-mcp` package. `@mavis/mcp` remains the product FACADE:
 * connection pool policy (keys, semaphores, idle reaper, generations), mcode
 * config/credentials shaping (token overrides), name registry, and managed
 * routing stay here; the wire protocol, transports, and client are pi-mcp.
 *
 * Kept from the retired daemon surface: pool option/override shapes, metric
 * port contract, logger port, stderr-line observers. The client/transport
 * types now come from pi-mcp.
 */
import type {
  CallToolResult,
  McpClient,
  McpTransport,
  Resource,
  ResourceTemplate,
  ReadResourceResult,
  Tool,
} from '@earendil-works/pi-mcp';

export interface StdioTransportConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Optional process working directory. Existing MCP sources retain the home-directory default. */
  cwd?: string;
}

export interface HttpTransportConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /** Prevent package-configured headers from following a cross-origin redirect. */
  protectHeadersOnRedirect?: boolean;
}

export interface SseTransportConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  /** Prevent package-configured headers from following a cross-origin redirect. */
  protectHeadersOnRedirect?: boolean;
}

export type TransportConfig = StdioTransportConfig | HttpTransportConfig | SseTransportConfig;

/** Hardcoded defaults — server-level fields fall back to these when not set. */
export const MCP_DEFAULTS = {
  /** Per-call timeout in ms; tuned for matrix biz-gateway worst-case multimodal RPCs. */
  timeout: 120_000,
  /** Per-server semaphore size. */
  maxConcurrency: 5,
} as const;

/**
 * Resolved server descriptor handed to the connection pool. The caller
 * is responsible for inferring `transport` from its config source and gating
 * `enabled`.
 */
export interface ResolvedMcpServer {
  /** Explicit roots/list identity for project-scoped connections. */
  workspaceRoot?: string;
  name: string;
  transport: TransportConfig;
  enabled: boolean;
  /** Per-server tool-call timeout override (ms). */
  timeout?: number;
}

/** Cached tool descriptor for a single MCP server. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Resource descriptor surfaced by pi-mcp `resources/list`. */
export type McpResourceInfo = Resource;

/** Resource template descriptor surfaced by pi-mcp `resources/templates/list`. */
export type McpResourceTemplateInfo = ResourceTemplate;

/** Result of `resources/read` through the pool. */
export type McpReadResourceResult = ReadResourceResult;

/**
 * Lossless tool-call result, pi-mcp protocol type (MCP 2026-07-28 shape:
 * content, isError, structuredContent as any JSON value, _meta).
 */
export type McpToolCallResult = CallToolResult;

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error' | 'needs-auth';

export type McpConnectionKey = string;

/** Internal pool record — not exported as a stable product API. */
export interface McpConnection {
  key: McpConnectionKey;
  name: string;
  state: McpConnectionState;
  /** pi-mcp client — the one protocol engine per connection. */
  client: McpClient | null;
  /** pi-mcp transport owned by the client while connected. */
  transport: McpTransport | null;
  tools: McpToolInfo[] | null;
  lastUsed: number;
  error?: string;
}

/** Host-supplied bearer token source, bridged to the pi-mcp `AuthProvider`. */
export type McpTokenProvider = () => Promise<string | undefined>;

/**
 * Per-call overrides layered on top of the transport config at spawn time.
 * `env` is merged into the stdio child's process env; `headers` is merged
 * into the http/sse transport headers; `tokenProvider` becomes the bearer
 * `AuthProvider` for http/sse (mcode credentials, one copy per profile).
 */
export interface McpConnectionTokenOverrides {
  /**
   * Connection scope for transports whose child process/session captures host context
   * at spawn time. Omission selects the server's default scope. The pool encodes
   * this scope together with the logical server name as an internal cache key.
   */
  connectionKey?: McpConnectionKey;
  /**
   * Turn/session-scoped server descriptor supplied by a trusted in-process host.
   * This keeps ephemeral ACP MCP configuration out of the persisted server lookup.
   */
  serverOverride?: ResolvedMcpServer;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Bearer token source for http/sse auth. Read per request; never persisted by the pool. */
  tokenProvider?: McpTokenProvider;
}

export interface McpCallOptions {
  /** Per-call timeout in ms. Falls back to per-server config, then MCP_DEFAULTS.timeout. */
  timeout?: number;
  /**
   * Per-call abort signal, forwarded to the pi-mcp client request. The client
   * reacts to abort by rejecting the pending JSON-RPC promise and sending a
   * `notifications/cancelled` frame to the server, so the caller returns
   * immediately instead of waiting for the pool timeout.
   */
  signal?: AbortSignal;
}

/**
 * Pluggable logger. The MCP substrate emits no console output of its own;
 * hosts inject a logger that matches their logging conventions. The default
 * no-op logger is fine for unit tests; production callers should wire a real
 * one so MCP child crashes are diagnosable.
 */
export interface McpRuntimeLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export const NOOP_MCP_RUNTIME_LOGGER: McpRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Optional host-injected metrics port for the connection pool, mirroring the
 * `incr`/`latency` module-reporter shape used by the other agent-modules
 * (cron, hooks) so hosts can pass their existing reporter verbatim.
 *
 * Contract:
 *   * Metric names are BARE snake_case (`mcp_connect_total`); the metrics
 *     server prepends the service prefix on ingest.
 *   * Label values must be bounded enums. Server names are user-defined and
 *     unbounded — they are NEVER emitted as labels; per-server detail
 *     belongs in the injected `McpRuntimeLogger` fields instead.
 *   * Absent port = noop: the pool must behave identically without it.
 */
export interface McpPoolMetrics {
  incr(name: string, tags?: Record<string, string>): void;
  latency(name: string, durationMs: number, tags?: Record<string, string>): void;
}

/**
 * Stderr-line observer registration. The connection pool buffers each stdio
 * child's stderr into newline-terminated lines, calls each registered
 * observer with the trimmed line, and also forwards to the logger.
 *
 * Observers must not throw — the pool catches and logs.warn on rejection so a
 * bad observer can never wedge the stderr drain loop.
 */
export type StderrLineObserver = (serverName: string, line: string) => void;

/** Map a pi-mcp tool descriptor to the pool's cached tool shape. */
export function toMcpToolInfo(tool: Tool): McpToolInfo {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema:
      typeof tool.inputSchema === 'object' && tool.inputSchema !== null
        ? (tool.inputSchema as Record<string, unknown>)
        : {},
  };
}
