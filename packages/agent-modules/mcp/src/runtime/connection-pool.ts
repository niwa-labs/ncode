/**
 * Host-agnostic MCP connection pool — pi-mcp protocol engine behind the
 * mcode facade.
 *
 * W08 PORT-PI-1.3 (§4 map, plan :504): the OLD transport/client engine
 * (`@modelcontextprotocol/sdk` Client + hand-rolled stdio/http wrappers) is
 * ABSORBED by the pinned `@earendil-works/pi-mcp`. The pool remains the ONE
 * connection pool per scope/profile (§2.4.6 invariant, plan :195): connection
 * keys, per-server semaphores, idle reaping, connect generations, metrics and
 * stderr observers are mcode facade policy; wire protocol, transports and the
 * client are pi-mcp (`McpClient` + `StdioTransport`/`StreamableHttpTransport`).
 *
 * Behaviour parity with the pre-absorption pool on the hot paths:
 *
 *   * One persistent connection per server/scope, lazily spawned on first
 *     call, cleaned up after `idleTimeoutMs` of inactivity.
 *   * Per-server semaphore bounds concurrent calls to `maxConcurrency` so a
 *     flood from the LLM can't fork-bomb the stdio child.
 *   * Stderr of every stdio child is line-buffered into the injected logger
 *     as `[mcp:<server>:stderr] <line>` records and fed to registered
 *     observers (64 KiB unflushed-buffer safety valve).
 *   * `reconnect` re-establishes protocol state with a fresh pi client
 *     (initialize handshake re-runs; tool cache is refreshed). For HTTP
 *     servers whose session expired mid-call, READ-ONLY requests retry once
 *     on a fresh session; tool calls never auto-retry (fail-closed: an
 *     unknown effect is not repeated, plan invariant I07).
 *   * `McpAuthRequiredError` marks the connection `needs-auth` and surfaces a
 *     typed message; sign-in orchestration stays with the mcode facade/W10
 *     settings service, never inside the pool.
 */
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  type AuthProvider,
  type McpClientOptions,
  McpAuthRequiredError,
  McpClient,
  type McpRequestOptions,
  type McpTransport,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from '@earendil-works/pi-mcp';
import { createBearerAuthProvider } from './transport/auth.js';
import { describeMcpCallError } from './call-error.js';
import { createTransport } from './transport/factory.js';
import {
  MCP_DEFAULTS,
  NOOP_MCP_RUNTIME_LOGGER,
  type McpCallOptions,
  type McpConnection,
  type McpConnectionKey,
  type McpConnectionTokenOverrides,
  type McpPoolMetrics,
  type McpReadResourceResult,
  type McpResourceInfo,
  type McpResourceTemplateInfo,
  type McpRuntimeLogger,
  type McpToolCallResult,
  type McpToolInfo,
  type ResolvedMcpServer,
  type StderrLineObserver,
  toMcpToolInfo,
} from './types.js';

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 60_000;
const STDERR_BUFFER_SAFETY_VALVE = 64 * 1024;

/**
 * Read a server's resolved (transport + enabled + timeout) descriptor.
 * Passed in by the host so the pool stays config-source agnostic.
 */
export interface McpServerLookup {
  getResolvedServer(serverName: string): ResolvedMcpServer | null;
}

export interface McpConnectionPoolOptions {
  idleTimeoutMs?: number;
  maxConcurrency?: number;
  logger?: McpRuntimeLogger;
  fetchImpl?: typeof fetch;
  /**
   * Optional host-injected metrics port. Absent = noop (zero behavior
   * change). Emits BARE metric names with bounded label sets only — never
   * the user-defined server name (see `McpPoolMetrics`).
   */
  metrics?: McpPoolMetrics;
  /** Client identity sent in the MCP initialize handshake. */
  clientName?: string;
  clientVersion?: string;
  /**
   * Test/host seam: override transport creation entirely (pi `McpTransport`).
   * Defaults to the mcode facade factory over pi transports.
   */
  createTransportImpl?: (
    config: ResolvedMcpServer['transport'],
    options: {
      env?: Record<string, string>;
      headers?: Record<string, string>;
      fetchImpl?: typeof fetch;
      authProvider?: AuthProvider;
      onStderrChunk?: (chunk: string) => void;
    },
  ) => McpTransport;
}

class Semaphore {
  // Each waiter holds its own resolve/reject pair so `acquire(signal)` can
  // reject and remove itself from the queue on abort without waking up an
  // unrelated queued caller. The FIFO fairness for non-aborted waiters is
  // preserved because `release()` still shifts the head. When a waiter is
  // aborted mid-queue we splice it out — the semaphore never grants a permit
  // to an aborted caller and never leaks a `running` slot.
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private running = 0;
  constructor(private readonly max: number) {}
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Semaphore acquire aborted before dispatch');
    }
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: { resolve: () => void; reject: (err: Error) => void } = {
        resolve,
        reject,
      };
      const detach = (): void => {
        if (!signal) return;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        // Splice the exact waiter out of the queue so `release()` never
        // hands a permit to a caller that has already given up. `indexOf`
        // is O(queue) but the pool max is single-digit; the abort path is
        // strictly rarer than the normal grant path.
        const idx = this.queue.indexOf(waiter);
        if (idx >= 0) this.queue.splice(idx, 1);
        waiter.reject(new Error('Semaphore acquire aborted while queued'));
      };
      // Wrap the original resolve so a normal grant tears down the abort
      // listener; otherwise a later abort on the same signal would fire
      // against an already-resolved waiter and be a no-op leak.
      waiter.resolve = (): void => {
        detach();
        resolve();
      };
      waiter.reject = (err: Error): void => {
        detach();
        reject(err);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next.resolve();
    }
  }
  get pending(): number {
    return this.queue.length;
  }
  get active(): number {
    return this.running;
  }
}

interface PendingMcpConnection {
  promise: Promise<McpConnection>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

export class McpConnectionPool {
  private connections = new Map<McpConnectionKey, McpConnection>();
  private connectingPromises = new Map<McpConnectionKey, PendingMcpConnection>();
  private connectionServerNames = new Map<McpConnectionKey, string>();
  /**
   * Generation counter per connection key. Bumped by `disconnectConnection` so an
   * already-running `doConnect` can detect "I was started under generation N,
   * but disconnect has since moved us to N+1, so my freshly-spawned child is
   * stale — close it instead of caching it". Without this, the `.then()`
   * callback inside `ensureConnection` would unconditionally write the new
   * connection into `this.connections`, which avoids reusing a stdio child
   * that captured stale host-provided env at spawn.
   */
  private connectGenerations = new Map<McpConnectionKey, number>();
  private semaphores = new Map<McpConnectionKey, Semaphore>();
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private stderrObservers = new Set<StderrLineObserver>();

  private readonly idleTimeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly logger: McpRuntimeLogger;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly metrics: McpPoolMetrics | undefined;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly createTransportImpl: NonNullable<McpConnectionPoolOptions['createTransportImpl']>;

  constructor(
    private readonly lookup: McpServerLookup,
    options: McpConnectionPoolOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConcurrency = options.maxConcurrency ?? MCP_DEFAULTS.maxConcurrency;
    this.logger = options.logger ?? NOOP_MCP_RUNTIME_LOGGER;
    this.fetchImpl = options.fetchImpl;
    this.metrics = options.metrics;
    this.clientName = options.clientName ?? 'mavis-local-runtime-mcp';
    this.clientVersion = options.clientVersion ?? '1.0.0';
    this.createTransportImpl = options.createTransportImpl ?? createTransport;
  }

  /**
   * Register an observer that receives every stderr line from every stdio
   * child. Returns an unsubscribe function. Observers must not throw —
   * exceptions are caught and logger.warn'd so a single bad observer cannot
   * stop the stderr drain loop or break the audit sink for other consumers.
   */
  addStderrObserver(observer: StderrLineObserver): () => void {
    this.stderrObservers.add(observer);
    return () => {
      this.stderrObservers.delete(observer);
    };
  }

  async listTools(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpToolInfo[]> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.getSemaphore(connectionKey);
    if (options?.signal?.aborted) {
      throw new Error(`MCP list tools aborted before dispatch: ${serverName}`);
    }
    try {
      await sem.acquire(options?.signal);
    } catch {
      throw new Error(`MCP list tools aborted before dispatch: ${serverName}`);
    }
    try {
      if (options?.signal?.aborted) {
        throw new Error(`MCP list tools aborted before dispatch: ${serverName}`);
      }
      const conn = await this.ensureConnection(serverName, connectionKey, tokenOverrides, options);
      if (conn.tools) {
        conn.lastUsed = Date.now();
        return conn.tools;
      }
      const timeoutMs = this.resolveTimeout(serverName, options?.timeout, tokenOverrides);
      return await this.fetchAndCacheTools(conn, { ...options, timeout: timeoutMs });
    } finally {
      sem.release();
    }
  }

  async refreshTools(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpToolInfo[]> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.getSemaphore(connectionKey);
    if (options?.signal?.aborted) {
      throw new Error(`MCP list tools aborted before dispatch: ${serverName}`);
    }
    await sem.acquire(options?.signal);
    try {
      if (options?.signal?.aborted) {
        throw new Error(`MCP list tools aborted before dispatch: ${serverName}`);
      }
      const conn = await this.ensureConnection(serverName, connectionKey, tokenOverrides, options);
      conn.tools = null;
      const timeoutMs = this.resolveTimeout(serverName, options?.timeout, tokenOverrides);
      return await this.fetchAndCacheTools(conn, { ...options, timeout: timeoutMs });
    } finally {
      sem.release();
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpToolCallResult> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.getSemaphore(connectionKey);
    // Early-abort: skip semaphore acquisition entirely when the caller has
    // already aborted. Semaphore.acquire has no abort hook, so a queued waiter
    // would otherwise sit until an in-flight callTool releases it — turning an
    // "immediate cancel" into "wait for the head of the queue to finish".
    if (options?.signal?.aborted) {
      throw new Error(`MCP tool call aborted before dispatch: ${serverName}/${toolName}`);
    }
    // Abortable acquire: while queued behind an in-flight long-running call
    // (e.g. `image_synthesize`), an abort on `options.signal` splices this
    // waiter out of the semaphore queue and rejects immediately instead of
    // waiting for the head of the queue to release. Without this, the two
    // aborted-state checks around `acquire()` would only fire before we get
    // in line and after we already own the permit — a caller aborted while
    // *queued* would still block for the remainder of the head call.
    try {
      await sem.acquire(options?.signal);
    } catch {
      // Normalise to the same wire-shape as the other pre-dispatch aborts so
      // callers see a consistent "aborted before dispatch" surface regardless
      // of whether the abort landed on the pre-check or on the queue splice.
      throw new Error(`MCP tool call aborted before dispatch: ${serverName}/${toolName}`);
    }
    // Metrics cover DISPATCHED calls only (permit acquired): the pre-acquire
    // abort short-circuits above never reached a connection and are pure
    // caller-side cancellation noise. Duration is observed only for calls
    // that completed a round-trip (status ok | tool_error) so the unlabeled
    // histogram stays a clean "MCP tool latency" series instead of mixing in
    // instant aborts and connect failures.
    const startMs = Date.now();
    try {
      if (options?.signal?.aborted) {
        throw new Error(`MCP tool call aborted before dispatch: ${serverName}/${toolName}`);
      }
      const conn = await this.ensureConnection(serverName, connectionKey, tokenOverrides);
      conn.lastUsed = Date.now();
      const client = conn.client;
      if (!client || conn.state !== 'connected') {
        throw new Error(`MCP client not available for "${serverName}"`);
      }
      const timeoutMs = this.resolveTimeout(serverName, options?.timeout, tokenOverrides);
      try {
        // pi-mcp forwards the caller's AbortSignal into its pending-request
        // bookkeeping: it rejects the promise and sends a
        // `notifications/cancelled` frame, so an aborted turn stops waiting on
        // the remote MCP server instantly instead of ticking down the pool
        // timeout. `timeout` is still honoured as a belt-and-suspenders bound.
        const result = await client.callTool(toolName, args, {
          timeoutMs,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        const shaped: McpToolCallResult = {
          content: result.content ?? [],
          isError: result.isError === true,
          ...(isRecord(result.structuredContent)
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
        };
        this.metrics?.incr('mcp_tool_call_total', {
          status: shaped.isError ? 'tool_error' : 'ok',
        });
        this.metrics?.latency('mcp_tool_call_duration_ms', Date.now() - startMs);
        return shaped;
      } catch (err) {
        if (this.markNeedsAuthIfRequired(conn, err)) {
          throw new Error(
            `MCP tool call failed: MCP server "${serverName}" requires sign-in (run /mcp to sign in)`,
          );
        }
        // Upstream 0.7.2 call-error classification: attach the machine-readable
        // reason (JSON-RPC code / innermost cause) without altering the rendered
        // message and without deciding timeouts or retry policy here.
        const described = describeMcpCallError(err);
        const failure = new Error(
          `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (described) (failure as Error & { mcpCallError?: unknown }).mcpCallError = described;
        throw failure;
      }
    } catch (err) {
      this.metrics?.incr('mcp_tool_call_total', {
        status: options?.signal?.aborted ? 'aborted' : 'error',
      });
      throw err;
    } finally {
      sem.release();
    }
  }

  async listResources(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpResourceInfo[]> {
    return this.withConnectedClient(
      serverName,
      tokenOverrides,
      options,
      (client, requestOptions) => client.listResources(requestOptions),
    );
  }

  async listResourceTemplates(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpResourceTemplateInfo[]> {
    return this.withConnectedClient(
      serverName,
      tokenOverrides,
      options,
      (client, requestOptions) => client.listResourceTemplates(requestOptions),
    );
  }

  async readResource(
    serverName: string,
    uri: string,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpReadResourceResult> {
    return this.withConnectedClient(serverName, tokenOverrides, options, (client, requestOptions) =>
      client.readResource(uri, requestOptions),
    );
  }

  startIdleCheck(): void {
    if (this.idleCheckTimer) return;
    this.idleCheckTimer = setInterval(() => this.cleanupIdleConnections(), IDLE_CHECK_INTERVAL_MS);
    this.idleCheckTimer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    // Include in-flight connecting keys too so `disconnectConnection` bumps
    // the generation for each — a connect that resolves after shutdown will
    // see the mismatch and close its own child instead of caching it.
    const keys = new Set<McpConnectionKey>([
      ...this.connections.keys(),
      ...this.connectingPromises.keys(),
    ]);
    await Promise.allSettled([...keys].map((key) => this.disconnectConnection(key)));
    this.semaphores.clear();
    this.connectionServerNames.clear();
    this.logger.info(`All MCP connections closed`, { count: keys.size });
  }

  async reconnect(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): Promise<McpConnection> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    await this.disconnectConnection(connectionKey);
    return this.ensureConnection(serverName, connectionKey, tokenOverrides);
  }

  async disconnect(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): Promise<void> {
    if (tokenOverrides?.connectionKey) {
      await this.disconnectConnection(this.resolveConnectionKey(serverName, tokenOverrides));
      return;
    }
    const keys = this.findConnectionKeysForServer(serverName);
    if (keys.length === 0) {
      await this.disconnectConnection(this.resolveConnectionKey(serverName));
      return;
    }
    await Promise.allSettled(keys.map((key) => this.disconnectConnection(key)));
  }

  getStats(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): { active: number; pending: number; maxConcurrency: number } {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.semaphores.get(connectionKey);
    return {
      active: sem?.active ?? 0,
      pending: sem?.pending ?? 0,
      maxConcurrency: this.maxConcurrency,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async withConnectedClient<T>(
    serverName: string,
    tokenOverrides: McpConnectionTokenOverrides | undefined,
    options: McpCallOptions | undefined,
    run: (client: McpClient, requestOptions: McpRequestOptions) => Promise<T>,
  ): Promise<T> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.getSemaphore(connectionKey);
    if (options?.signal?.aborted) {
      throw new Error(`MCP request aborted before dispatch: ${serverName}`);
    }
    try {
      await sem.acquire(options?.signal);
    } catch {
      throw new Error(`MCP request aborted before dispatch: ${serverName}`);
    }
    try {
      if (options?.signal?.aborted) {
        throw new Error(`MCP request aborted before dispatch: ${serverName}`);
      }
      const conn = await this.ensureConnection(serverName, connectionKey, tokenOverrides, options);
      conn.lastUsed = Date.now();
      const client = conn.client;
      if (!client || conn.state !== 'connected') {
        throw new Error(`MCP client not available for "${serverName}"`);
      }
      const timeoutMs = this.resolveTimeout(serverName, options?.timeout, tokenOverrides);
      const requestOptions: McpRequestOptions = {
        timeoutMs,
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      try {
        // Read-only surface: a server that lost the HTTP session (restart,
        // deploy) did not run anything — retry once on a fresh session.
        return await run(client, requestOptions);
      } catch (err) {
        if (err instanceof Error && err.name === 'McpSessionExpiredError') {
          const fresh = await this.ensureFreshClientAfterSessionExpiry(
            serverName,
            connectionKey,
            tokenOverrides,
            conn,
          );
          const retryOptions: McpRequestOptions = {
            timeoutMs,
            ...(options?.signal ? { signal: options.signal } : {}),
          };
          return await run(fresh, retryOptions);
        }
        if (this.markNeedsAuthIfRequired(conn, err)) {
          throw new Error(
            `MCP request failed: MCP server "${serverName}" requires sign-in (run /mcp to sign in)`,
          );
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    } finally {
      sem.release();
    }
  }

  private getSemaphore(connectionKey: McpConnectionKey): Semaphore {
    let sem = this.semaphores.get(connectionKey);
    if (!sem) {
      sem = new Semaphore(this.maxConcurrency);
      this.semaphores.set(connectionKey, sem);
    }
    return sem;
  }

  private resolveConnectionKey(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): McpConnectionKey {
    const requestedKey = tokenOverrides?.connectionKey;
    // Keep the server identity separate from its scope: a raw server name can
    // itself contain the text of another server's scoped connection key.
    const scope = !requestedKey
      ? null
      : requestedKey.startsWith(`${serverName}:`)
        ? requestedKey.slice(serverName.length + 1)
        : requestedKey;
    return JSON.stringify([serverName, scope]);
  }

  private findConnectionKeysForServer(serverName: string): McpConnectionKey[] {
    const keys = new Set<McpConnectionKey>();
    for (const [key, conn] of this.connections.entries()) {
      if (conn.name === serverName) keys.add(key);
    }
    for (const [key, mappedServerName] of this.connectionServerNames.entries()) {
      if (mappedServerName === serverName) keys.add(key);
    }
    const baseKey = this.resolveConnectionKey(serverName);
    if (this.connections.has(baseKey) || this.connectingPromises.has(baseKey)) {
      keys.add(baseKey);
    }
    return [...keys];
  }

  private resolveTimeout(
    serverName: string,
    perCallTimeout?: number,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): number {
    if (perCallTimeout && perCallTimeout > 0) return perCallTimeout;
    const server = tokenOverrides?.serverOverride ?? this.lookup.getResolvedServer(serverName);
    if (server?.timeout && server.timeout > 0) return server.timeout;
    return MCP_DEFAULTS.timeout;
  }

  private async ensureConnection(
    serverName: string,
    connectionKey: McpConnectionKey,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpConnection> {
    this.connectionServerNames.set(connectionKey, serverName);
    const existing = this.connections.get(connectionKey);
    if (existing?.state === 'connected' && existing.client) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) {
      this.connections.delete(connectionKey);
    }
    const connecting = this.connectingPromises.get(connectionKey);
    if (connecting) {
      return this.waitForPendingConnection(serverName, connecting, options?.signal);
    }
    this.startIdleCheck();
    // Snapshot the generation BEFORE the spawn. If `disconnectConnection` runs
    // while we're connecting it bumps the counter, and the `.then()` below
    // sees the mismatch and closes the just-spawned (stale-identity) child
    // instead of caching it. Without this, an auth-context rotation that
    // happens during the very first `nd` spawn would silently leak the old
    // identity back into `this.connections`.
    const generation = (this.connectGenerations.get(connectionKey) ?? 0) + 1;
    this.connectGenerations.set(connectionKey, generation);
    const connectTimeoutMs = this.resolveTimeout(serverName, options?.timeout, tokenOverrides);
    const controller = new AbortController();
    const pending = {
      controller,
      waiters: 0,
      settled: false,
    } as Omit<PendingMcpConnection, 'promise'> & { promise?: Promise<McpConnection> };
    const connectPromise = this.doConnect(
      serverName,
      connectionKey,
      tokenOverrides,
      connectTimeoutMs,
      controller.signal,
    )
      .then(async (connection) => {
        if (this.connectGenerations.get(connectionKey) !== generation) {
          // A disconnect arrived after we started spawning. The connection
          // we just got belongs to the prior identity / config — close it
          // and surface that to the caller of THIS `ensureConnection` as a
          // disconnected error rather than handing back a stale child.
          await closeConnectionSafely(connection, this.logger, serverName);
          throw new Error(`MCP server "${serverName}" was disconnected while connecting`);
        }
        this.connections.set(connectionKey, connection);
        return connection;
      })
      .finally(() => {
        pending.settled = true;
        if (this.connectingPromises.get(connectionKey) === pending) {
          this.connectingPromises.delete(connectionKey);
        }
      });
    pending.promise = connectPromise;
    this.connectingPromises.set(connectionKey, pending as PendingMcpConnection);
    return this.waitForPendingConnection(
      serverName,
      pending as PendingMcpConnection,
      options?.signal,
    );
  }

  private waitForPendingConnection(
    serverName: string,
    pending: PendingMcpConnection,
    signal?: AbortSignal,
  ): Promise<McpConnection> {
    pending.waiters++;
    let released = false;
    const releaseWaiter = (): void => {
      if (released) return;
      released = true;
      pending.waiters--;
      if (pending.waiters === 0 && !pending.settled) {
        pending.controller.abort();
      }
    };
    if (signal?.aborted) {
      releaseWaiter();
      return Promise.reject(new Error(`MCP connection wait aborted: ${serverName}`));
    }
    return new Promise<McpConnection>((resolve, reject) => {
      const onAbort = (): void => {
        releaseWaiter();
        reject(new Error(`MCP connection wait aborted: ${serverName}`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(
        (connection) => {
          signal?.removeEventListener('abort', onAbort);
          releaseWaiter();
          resolve(connection);
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          releaseWaiter();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async doConnect(
    serverName: string,
    connectionKey: McpConnectionKey,
    tokenOverrides: McpConnectionTokenOverrides | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<McpConnection> {
    const server = tokenOverrides?.serverOverride ?? this.lookup.getResolvedServer(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not found`);
    }
    if (!server.enabled) {
      throw new Error(`MCP server "${serverName}" is disabled`);
    }

    const transportOverrides = { ...(tokenOverrides ?? {}) };
    delete transportOverrides.serverOverride;
    const authProvider = this.resolveAuthProvider(tokenOverrides);
    const transport = this.createTransportImpl(server.transport, {
      ...transportOverrides,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(authProvider ? { authProvider } : {}),
      ...(this.stderrObservers.size > 0 ? { onStderrChunk: this.stderrChunkHandler(serverName) } : {}),
    });
    const workspaceRoot = server.workspaceRoot ?? homedir();
    const clientOptions: McpClientOptions = {
      name: this.clientName,
      version: this.clientVersion,
      // Respond to roots/list so MCP servers (e.g. Playwright) know the
      // workspace root and don't fall back to their own process.cwd().
      roots: [
        {
          uri: pathToFileURL(server.workspaceRoot ?? workspaceRoot).href,
          name: server.workspaceRoot ? 'project' : 'home',
        },
      ],
    };

    let connection: McpConnection | null = null;
    const connectStartedAtMs = Date.now();
    this.logger.info(`Connecting MCP server`, {
      serverName,
      connectionKey,
      transportType: server.transport.type,
      timeoutMs,
    });
    const client = new McpClient(clientOptions);
    // zcode-model tools/schemas freshness: the connection-level tools
    // snapshot is invalidated on the server's list_changed notification, and
    // the next turn-scoped tools/list refetches fresh schemas. (pi
    // extensions/mcp/runtime.ts:382-384 does the same.)
    // Test client doubles may not implement the notification surface.
    client.onNotification?.('notifications/tools/list_changed', () => {
      const conn = this.connections.get(connectionKey);
      if (conn) conn.tools = null;
      this.logger.info('MCP tool list invalidated after list_changed', {
        serverName,
        connectionKey,
      });
    });
    const onClose = client.onClose(() => {
      // Transport dropped (stdio exit, network). Mark the record gone; the
      // next call reconnects with a fresh protocol session.
      const recorded = this.connections.get(connectionKey);
      if (recorded === connection && connection) {
        this.connections.delete(connectionKey);
        this.cleanupDisconnectedBookkeeping(connectionKey, {
          keepGeneration: this.connectingPromises.has(connectionKey),
        });
      }
      this.logger.warn(`MCP server transport closed`, { serverName, connectionKey });
    });
    const onTransportError = client.onError((error) => {
      this.logger.warn(`MCP server transport error`, {
        serverName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      // pi `McpClient.connect` takes no signal; waiter aborts (and shutdown)
      // reach the connect by closing the client — the in-flight initialize
      // rejects with McpConnectionClosedError and the transport closes.
      const onConnectAbort = (): void => {
        void client.close().catch(() => undefined);
      };
      signal.addEventListener('abort', onConnectAbort, { once: true });
      try {
        // Connect outcome is labeled by transport kind only — the server name
        // is user-defined (unbounded cardinality) and stays in logger fields.
        await withTimeout(
          client.connect(transport),
          timeoutMs,
          `MCP server "${serverName}" connect timed out after ${timeoutMs}ms`,
        );
      } finally {
        signal.removeEventListener('abort', onConnectAbort);
      }
      if (signal.aborted) {
        throw new Error(`MCP connection wait aborted: ${serverName}`);
      }
      this.metrics?.incr('mcp_connect_total', {
        transport: server.transport.type,
        status: 'ok',
      });
      connection = {
        key: connectionKey,
        name: serverName,
        state: 'connected',
        client,
        transport,
        tools: null,
        lastUsed: Date.now(),
      };
      this.logger.info(`Connected MCP server`, {
        serverName,
        connectionKey,
        transportType: server.transport.type,
        durationMs: Math.max(0, Date.now() - connectStartedAtMs),
      });
      return connection;
    } catch (error) {
      onClose();
      onTransportError();
      this.logger.error(`Failed to connect MCP server`, {
        serverName,
        connectionKey,
        transportType: server.transport.type,
        durationMs: Math.max(0, Date.now() - connectStartedAtMs),
        error: toErrorMessage(error),
      });
      this.metrics?.incr('mcp_connect_total', {
        transport: server.transport.type,
        status: 'error',
      });
      try {
        await client.close();
      } catch (closeError) {
        this.logger.warn(`Failed to close MCP client after connect error`, {
          serverName,
          error: toErrorMessage(closeError),
        });
      }
      throw new Error(`Failed to connect to MCP server "${serverName}": ${toErrorMessage(error)}`);
    }
  }

  private resolveAuthProvider(
    tokenOverrides: McpConnectionTokenOverrides | undefined,
  ): AuthProvider | undefined {
    const tokenProvider = tokenOverrides?.tokenProvider;
    if (!tokenProvider) return undefined;
    return createBearerAuthProvider({ token: tokenProvider });
  }

  private stderrChunkHandler(serverName: string): (chunk: string) => void {
    let buffer = '';
    return (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        this.emitStderrLine(serverName, buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > STDERR_BUFFER_SAFETY_VALVE) {
        this.emitStderrLine(serverName, buffer);
        buffer = '';
      }
    };
  }

  private emitStderrLine(serverName: string, rawLine: string): void {
    const trimmed = rawLine.replace(/\r$/, '');
    if (trimmed.length === 0) return;
    this.logger.info(`[mcp:${serverName}:stderr] ${trimmed}`);
    for (const observer of this.stderrObservers) {
      try {
        observer(serverName, trimmed);
      } catch (err) {
        this.logger.warn(`MCP stderr observer threw — line dropped from that observer`, {
          serverName,
          error: toErrorMessage(err),
        });
      }
    }
  }

  /** True when the error is an auth rejection worth a `needs-auth` marking. */
  private markNeedsAuthIfRequired(conn: McpConnection, error: unknown): boolean {
    const authRequired =
      error instanceof McpAuthRequiredError ||
      (error instanceof Error && error.name === 'McpOAuthAuthorizationRequiredError');
    if (!authRequired) return false;
    conn.state = 'needs-auth';
    conn.error = 'MCP server requires authentication';
    return true;
  }

  private async ensureFreshClientAfterSessionExpiry(
    serverName: string,
    connectionKey: McpConnectionKey,
    tokenOverrides: McpConnectionTokenOverrides | undefined,
    stale: McpConnection,
  ): Promise<McpClient> {
    // Detach the stale client (its session is gone server-side) and open a
    // fresh protocol session. The stale client is closed best-effort: its
    // other in-flight calls fail on their own 404s the same way.
    if (this.connections.get(connectionKey) === stale) {
      this.connections.delete(connectionKey);
    }
    await this.disconnectConnection(connectionKey);
    const fresh = await this.ensureConnection(serverName, connectionKey, tokenOverrides);
    const client = fresh.client;
    if (!client) {
      throw new Error(`MCP client not available for "${serverName}"`);
    }
    return client;
  }

  private async fetchAndCacheTools(
    conn: McpConnection,
    options?: McpCallOptions,
  ): Promise<McpToolInfo[]> {
    conn.lastUsed = Date.now();
    const client = conn.client;
    if (!client || conn.state !== 'connected') {
      throw new Error(`MCP client not available for "${conn.name}"`);
    }
    try {
      const tools: Tool[] = await client.listTools({
        ...(options?.timeout ? { timeoutMs: options.timeout } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const mapped = tools.map(toMcpToolInfo);
      conn.tools = mapped;
      conn.lastUsed = Date.now();
      return mapped;
    } catch (error) {
      if (this.markNeedsAuthIfRequired(conn, error)) {
        throw new Error(
          `MCP list tools failed: MCP server "${conn.name}" requires sign-in (run /mcp to sign in)`,
        );
      }
      throw new Error(`MCP list tools failed: ${toErrorMessage(error)}`);
    }
  }

  private async disconnectConnection(connectionKey: McpConnectionKey): Promise<void> {
    // Bump the generation FIRST so any in-flight `ensureConnection.then()`
    // observes the mismatch and closes its freshly-spawned child instead of
    // caching it. Reading the prior value with `?? 0` keeps the math safe on
    // servers that have never been connected.
    const serverName = this.connectionServerNames.get(connectionKey) ?? connectionKey;
    const prevGen = this.connectGenerations.get(connectionKey) ?? 0;
    this.connectGenerations.set(connectionKey, prevGen + 1);
    const pending = this.connectingPromises.get(connectionKey);
    const hadConnecting = pending !== undefined;
    if (pending) {
      this.connectingPromises.delete(connectionKey);
      pending.controller.abort();
    }
    const conn = this.connections.get(connectionKey);
    if (!conn) {
      this.cleanupDisconnectedBookkeeping(connectionKey, { keepGeneration: hadConnecting });
      return;
    }
    this.connections.delete(connectionKey);
    conn.state = 'disconnected';
    conn.tools = null;
    const { client } = conn;
    conn.client = null;
    conn.transport = null;
    if (!client) {
      this.cleanupDisconnectedBookkeeping(connectionKey, {
        keepGeneration: this.connectingPromises.has(connectionKey),
      });
      return;
    }
    try {
      await client.close();
      this.logger.info(`Closed MCP connection`, { serverName, connectionKey });
    } catch (error) {
      this.logger.warn(`Failed to close MCP connection`, {
        serverName,
        connectionKey,
        error: toErrorMessage(error),
      });
    } finally {
      this.cleanupDisconnectedBookkeeping(connectionKey, {
        keepGeneration: this.connectingPromises.has(connectionKey),
      });
    }
  }

  private cleanupDisconnectedBookkeeping(
    connectionKey: McpConnectionKey,
    options: { keepGeneration?: boolean } = {},
  ): void {
    this.connectionServerNames.delete(connectionKey);
    this.semaphores.delete(connectionKey);
    if (!options.keepGeneration) {
      this.connectGenerations.delete(connectionKey);
    }
    this.stopIdleCheckIfUnused();
  }

  private cleanupIdleConnections(): void {
    const now = Date.now();
    const idleKeys = [...this.connections.entries()]
      .filter(
        ([key, conn]) =>
          !this.connectingPromises.has(key) && now - conn.lastUsed >= this.idleTimeoutMs,
      )
      .map(([key]) => key);
    if (idleKeys.length === 0) {
      this.stopIdleCheckIfUnused();
      return;
    }
    void Promise.allSettled(idleKeys.map((key) => this.disconnectConnection(key))).then(
      (results) => {
        const failedCount = results.filter((result) => result.status === 'rejected').length;
        if (failedCount > 0) {
          this.logger.warn(`Failed to clean up some idle MCP connections`, {
            failedCount,
            total: idleKeys.length,
          });
        }
      },
    );
  }

  private stopIdleCheckIfUnused(): void {
    if (this.connections.size > 0 || this.connectingPromises.size > 0 || !this.idleCheckTimer) {
      return;
    }
    clearInterval(this.idleCheckTimer);
    this.idleCheckTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Close a connection that arrived AFTER a `disconnectConnection` invalidated its
 * generation. Used only on the in-flight-connect race path inside
 * `ensureConnection.then()`. We swallow close errors at warn level — the
 * connection was already stale; the worst case is a leaked child for one
 * idle-cleanup cycle.
 */
async function closeConnectionSafely(
  connection: McpConnection,
  logger: McpRuntimeLogger,
  serverName: string,
): Promise<void> {
  connection.state = 'disconnected';
  connection.tools = null;
  const { client } = connection;
  connection.client = null;
  connection.transport = null;
  if (!client) return;
  try {
    await client.close();
    logger.info(`Closed stale MCP connection from disconnected-mid-spawn race`, {
      serverName,
    });
  } catch (error) {
    logger.warn(`Failed to close stale MCP connection from disconnected-mid-spawn race`, {
      serverName,
      error: toErrorMessage(error),
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0 || !Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
