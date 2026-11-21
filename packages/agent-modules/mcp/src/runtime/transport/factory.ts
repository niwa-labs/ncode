/**
 * MCP transport factory — pi-mcp engine behind the mcode facade.
 *
 * W08 PORT-PI-1.3: the transport ENGINE is absorbed by `@earendil-works/pi-mcp`
 * (§4 :504 — «старый transport/disclosure engine заменён pi-mcp»). This factory
 * maps the mcode `TransportConfig` shapes onto pi transports and preserves the
 * mcode-specific behaviors documented in `stdio.ts` / `http.ts`.
 */
import type { AuthProvider, McpTransport } from '@earendil-works/pi-mcp';
import type { TransportConfig } from '../types.js';
import { createBearerAuthProvider } from './auth.js';
import { createHttpTransport, type McpHttpTransportOptions } from './http.js';
import { createStdioTransport, type McpStdioTransportOptions } from './stdio.js';

export interface McpTransportFactoryOptions {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  authProvider?: AuthProvider;
  /** Raw stderr chunks from a stdio child (fed to the pool's line observers). */
  onStderrChunk?: (chunk: string) => void;
}

export function createTransport(
  config: TransportConfig,
  options?: McpTransportFactoryOptions,
): McpTransport {
  switch (config.type) {
    case 'stdio': {
      const stdioOptions: McpStdioTransportOptions = {
        env: options?.env,
        ...(options?.onStderrChunk ? { onStderrChunk: options.onStderrChunk } : {}),
      };
      return createStdioTransport(config, stdioOptions);
    }
    case 'http':
    case 'sse': {
      const httpOptions: McpHttpTransportOptions = {
        headers: options?.headers,
        ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options?.authProvider ? { authProvider: options.authProvider } : {}),
      };
      return createHttpTransport(config, httpOptions);
    }
  }
}

export { createBearerAuthProvider } from './auth.js';
export type { BearerAuthProviderOptions } from './auth.js';
