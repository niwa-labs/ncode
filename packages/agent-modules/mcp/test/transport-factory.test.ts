/**
 * W08 pi-mcp absorption — transport factory facade tests.
 *
 * Pins the mcode behaviors that now live on top of the pi transports
 * (plan §4 :504 — engine absorbed, mcode behaviors preserved):
 *
 *   * stdio: cwd defaults to homedir, env precedence config < injected,
 *     stderr piped, `onStderr` wired to the pool observer feed.
 *   * http: header merge (config < per-call), host fetch threading,
 *     `protectHeadersOnRedirect` strips configured headers on cross-origin
 *     redirects (credential-leak guard, kept verbatim from the absorbed
 *     implementation), bearer AuthProvider passthrough.
 *   * auth: `createBearerAuthProvider` trims tokens, drops empties, reports
 *     401/insufficient-scope rejections to the credential owner.
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { createBearerAuthProvider } from '../src/runtime/transport/auth.js';
import { createTransport } from '../src/runtime/transport/factory.js';
import { createHttpTransport } from '../src/runtime/transport/http.js';
import { createStdioTransport } from '../src/runtime/transport/stdio.js';
import type { StdioTransportConfig } from '../src/runtime/types.js';

describe('stdio transport facade', () => {
  it('defaults cwd to homedir and pipes stderr', () => {
    const config: StdioTransportConfig = {
      type: 'stdio',
      command: 'some-server',
      args: ['--flag'],
    };
    const transport = createStdioTransport(config);
    expect(transport.options.command).toBe('some-server');
    expect(transport.options.cwd).toBe(homedir());
    expect(transport.options.stderr).toBe('pipe');
  });

  it('merges env with injected values winning over config', () => {
    const config: StdioTransportConfig = {
      type: 'stdio',
      command: 'some-server',
      args: [],
      env: { MCODE_TEST_LAYER: 'config' },
    };
    const transport = createStdioTransport(config, {
      env: { MCODE_TEST_LAYER: 'injected', MCODE_TEST_IDENTITY: 'profile-a' },
    });
    const env = transport.options.env ?? {};
    expect(env.MCODE_TEST_LAYER).toBe('injected');
    expect(env.MCODE_TEST_IDENTITY).toBe('profile-a');
    // Parent env still inherited (pi inheritEnv default true; we pass the
    // merged map explicitly).
    expect(Object.keys(env).length).toBeGreaterThan(2);
  });

  it('wires the stderr chunk callback through to the pi transport', async () => {
    const chunks: string[] = [];
    const config: StdioTransportConfig = {
      type: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("line-1\\n"); setTimeout(() => process.exit(0), 50)'],
    };
    const transport = createStdioTransport(config, { onStderrChunk: (chunk) => chunks.push(chunk) });
    await transport.start();
    for (let i = 0; i < 40 && chunks.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await transport.close();
    expect(chunks.join('')).toContain('line-1');
  });

  it('is the engine behind the generic factory for stdio configs', () => {
    const viaFactory = createTransport({
      type: 'stdio',
      command: 'factory-server',
      args: [],
    });
    expect(viaFactory).toBeInstanceOf(Object);
    expect((viaFactory as { options?: { command?: string } }).options?.command).toBe(
      'factory-server',
    );
  });
});

describe('http transport facade', () => {
  it('merges headers with per-call values winning over config', () => {
    const transport = createHttpTransport(
      { type: 'http', url: 'https://mcp.example.test/mcp', headers: { 'X-Config': 'config' } },
      { headers: { 'X-Call': 'call', 'X-Config': 'override' } },
    );
    const options = (transport as unknown as { options: { headers?: Record<string, string> } })
      .options;
    expect(options.headers).toMatchObject({ 'X-Config': 'override', 'X-Call': 'call' });
  });

  it('threads the host fetch through to the pi transport', () => {
    const hostFetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const transport = createHttpTransport(
      { type: 'http', url: 'https://mcp.example.test/mcp' },
      { fetchImpl: hostFetch },
    );
    const options = (transport as unknown as { options: { fetch?: unknown } }).options;
    expect(options.fetch).toBe(hostFetch);
  });

  it('protects configured headers from cross-origin redirects', async () => {
    const seenRequests: Array<{ url: string; authorization?: string }> = [];
    const redirectingFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seenRequests.push({
        url: request.url,
        authorization: request.headers.get('authorization') ?? undefined,
      });
      if (request.url.startsWith('https://mcp.example.test/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.test/catch' },
        });
      }
      return new Response('caught', { status: 200 });
    };
    const transport = createHttpTransport(
      {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: { authorization: 'Bearer secret' },
        protectHeadersOnRedirect: true,
      },
      { fetchImpl: redirectingFetch },
    );
    await transport.start();
    const send = (transport as unknown as { send: (m: unknown) => Promise<void> }).send;
    await expect(
      send.call(transport, { jsonrpc: '2.0', id: 1, method: 'ping' }),
    ).rejects.toThrow();
    const caught = seenRequests.find((r) => r.url.includes('evil.example.test'));
    expect(caught).toBeDefined();
    expect(caught?.authorization).toBeUndefined();
    expect(seenRequests[0]?.authorization).toBe('Bearer secret');
  });

  it('keeps configured headers on same-origin redirects', async () => {
    const seenRequests: Array<{ url: string; authorization?: string }> = [];
    let call = 0;
    const redirectingFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seenRequests.push({
        url: request.url,
        authorization: request.headers.get('authorization') ?? undefined,
      });
      call += 1;
      if (call === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://mcp.example.test/mcp-v2' },
        });
      }
      return new Response('ok', { status: 200 });
    };
    const transport = createHttpTransport(
      {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: { authorization: 'Bearer secret' },
        protectHeadersOnRedirect: true,
      },
      { fetchImpl: redirectingFetch },
    );
    await transport.start();
    const send = (transport as unknown as { send: (m: unknown) => Promise<void> }).send;
    await send.call(transport, { jsonrpc: '2.0', method: 'ping' });
    const redirected = seenRequests.find((r) => r.url.includes('mcp-v2'));
    expect(redirected?.authorization).toBe('Bearer secret');
  });

  it('rejects malformed transport urls with a diagnosable error', () => {
    expect(() => createTransport({ type: 'http', url: 'not a url' })).toThrow(
      /Invalid MCP transport url/,
    );
  });

  it('surfaces a 401 as the typed McpAuthRequiredError for pool classification', async () => {
    const transport = createHttpTransport(
      {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: { authorization: 'Bearer stale' },
      },
      {
        fetchImpl: (async () => new Response('expired', { status: 401 })) as typeof fetch,
      },
    );
    await transport.start();
    await expect(
      transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    ).rejects.toMatchObject({ name: 'McpAuthRequiredError', status: 401 });
  });
});

describe('legacy `sse` label runs on the streamable HTTP engine', () => {
  /**
   * W08 review round 1: mcode configs keep the historical `sse` transport
   * label, but the pinned pi-mcp dropped the separate legacy-SSE client —
   * `createHttpTransport` maps the label onto `StreamableHttpTransport`
   * (http.ts). These tests pin that behavior change: an `sse`-typed config
   * speaks streamable HTTP (single-endpoint POST with JSON), NOT the old
   * GET text/event-stream + /messages wire. Legacy SSE-only servers need a
   * proxy or an upstream upgrade (tracked for W10 composition).
   */
  it('builds a StreamableHttpTransport for `sse` configs and threads url/headers', () => {
    const transport = createTransport(
      {
        type: 'sse',
        url: 'https://mcp.example.test/sse',
        headers: { 'X-Config': 'config' },
      },
      { headers: { 'X-Call': 'call' } },
    );
    expect(transport.constructor.name).toBe('StreamableHttpTransport');
    const options = (transport as unknown as { options: { url: URL; headers?: Record<string, string> } })
      .options;
    expect(options.url).toBeInstanceOf(URL);
    expect(options.url.href).toBe('https://mcp.example.test/sse');
    expect(options.headers).toMatchObject({ 'X-Config': 'config', 'X-Call': 'call' });
  });

  it('sends JSON-RPC as a single-endpoint POST and resolves JSON replies', async () => {
    const seenRequests: Array<{ method: string; accept?: string; contentType?: string }> = [];
    const transport = createHttpTransport(
      { type: 'sse', url: 'https://mcp.example.test/sse' },
      {
        fetchImpl: (async (input, init) => {
          const request = new Request(input, init);
          seenRequests.push({
            method: request.method,
            accept: request.headers.get('accept') ?? undefined,
            contentType: request.headers.get('content-type') ?? undefined,
          });
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as typeof fetch,
      },
    );
    const replies: unknown[] = [];
    transport.onMessage((message) => replies.push(message));
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    await transport.close();
    expect(seenRequests).toEqual([
      { method: 'POST', accept: 'application/json, text/event-stream', contentType: 'application/json' },
    ]);
    expect(replies).toMatchObject([{ id: 7, result: { ok: true } }]);
  });
});

describe('bearer auth bridge (mcode credentials → pi AuthProvider)', () => {
  it('supplies the trimmed token and drops empty credentials', async () => {
    let supplied = '  token-a  ';
    const provider = createBearerAuthProvider({
      token: async () => supplied,
    });
    await expect(provider.token()).resolves.toBe('token-a');
    supplied = '   ';
    await expect(provider.token()).resolves.toBeUndefined();
  });

  it('reports unauthorized contexts to the credential owner without retrying', async () => {
    const rejected: Array<{ status: number }> = [];
    const provider = createBearerAuthProvider({
      token: async () => 'stale-token',
      onRejected: (context) => {
        rejected.push({ status: context.response.status });
      },
    });
    const response = new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="mcp"' },
    });
    await provider.onUnauthorized?.({
      response,
      serverUrl: new URL('https://mcp.example.test/mcp'),
      fetch,
      token: 'stale-token',
    });
    expect(rejected).toEqual([{ status: 401 }]);
  });
});
