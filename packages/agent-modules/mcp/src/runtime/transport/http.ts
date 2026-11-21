/**
 * HTTP / SSE MCP transport for Mavis runtimes — pi-mcp `StreamableHttpTransport`.
 *
 * W08 PORT-PI-1.3: the old `@modelcontextprotocol/sdk` SSE/StreamableHTTP
 * wrappers are ABSORBED by `@earendil-works/pi-mcp` (streamable HTTP with
 * SSE reconnect, session handling, `McpSessionExpiredError`). Mcode behaviors
 * preserved through this facade:
 *
 *   * `protectHeadersOnRedirect` — the old manual-redirect fetch wrapper is
 *     kept verbatim: package-configured headers must not follow a cross-origin
 *     redirect (credential leak guard). pi transports take a plain `fetch`.
 *   * Host fetch threading (proxy / enterprise-CA aware environments).
 *   * Bearer auth via pi `AuthProvider` — the pool bridges `tokenProvider`
 *     (mcode credentials, one copy per profile) into it.
 */
import type { AuthProvider, McpFetch, McpTransport, StreamableHttpTransportOptions } from '@earendil-works/pi-mcp';
import { StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { HttpTransportConfig, SseTransportConfig } from '../types.js';

export interface McpHttpTransportOptions {
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  authProvider?: AuthProvider;
}

export function createHttpTransport(
  config: HttpTransportConfig | SseTransportConfig,
  options?: McpHttpTransportOptions,
): McpTransport {
  const url = parseTransportUrl(config.url);
  const headers = mergeHeaders(config.headers, options?.headers);
  const fetchImpl = config.protectHeadersOnRedirect
    ? protectConfiguredHeadersOnRedirect(options?.fetchImpl ?? fetch, config.headers)
    : options?.fetchImpl;
  const transportOptions: StreamableHttpTransportOptions = {
    url,
    ...(headers ? { headers } : {}),
    ...(fetchImpl ? { fetch: fetchImpl as McpFetch } : {}),
    ...(options?.authProvider ? { authProvider: options.authProvider } : {}),
  };
  // pi-mcp speaks streamable HTTP. Legacy `sse` configs keep their historical
  // transport-type label; the pinned upstream dropped the separate SSE client,
  // and streamable HTTP handles SSE responses over the same endpoint.
  return new StreamableHttpTransport(transportOptions);
}

function protectConfiguredHeadersOnRedirect(
  fetchImpl: typeof fetch,
  configuredHeaders: Record<string, string> | undefined,
): typeof fetch {
  const protectedNames = new Set(
    Object.keys(configuredHeaders ?? {}).map((name) => name.toLocaleLowerCase('en-US')),
  );
  return async (input, init) => {
    let request = new Request(input, { ...init, redirect: 'manual' });
    for (let redirects = 0; redirects <= 10; redirects += 1) {
      const redirectSource = request.clone();
      const response = await fetchImpl(request);
      if (!isRedirect(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects === 10) throw new TypeError('MCP redirect limit exceeded');
      const nextUrl = new URL(location, request.url);
      const headers = new Headers(request.headers);
      if (nextUrl.origin !== new URL(request.url).origin) {
        for (const name of protectedNames) headers.delete(name);
      }
      await response.body?.cancel();
      request = new Request(
        nextUrl,
        redirectedRequestInit(redirectSource, response.status, headers),
      );
    }
    throw new TypeError('MCP redirect limit exceeded');
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectedRequestInit(request: Request, status: number, headers: Headers): RequestInit {
  const switchToGet =
    status === 303 || ((status === 301 || status === 302) && request.method === 'POST');
  if (switchToGet) {
    headers.delete('content-length');
    headers.delete('content-type');
  }
  return {
    method: switchToGet ? 'GET' : request.method,
    headers,
    signal: request.signal,
    ...(switchToGet ? {} : { body: request.body, duplex: 'half' as const }),
    redirect: 'manual',
  };
}

function mergeHeaders(
  configHeaders?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  const headers = { ...(configHeaders ?? {}), ...(extraHeaders ?? {}) };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseTransportUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`Invalid MCP transport url: ${url}`);
  }
}
