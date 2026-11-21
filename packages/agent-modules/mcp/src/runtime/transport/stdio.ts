/**
 * Stdio MCP transport for Mavis runtimes — pi-mcp `StdioTransport` engine.
 *
 * W08 PORT-PI-1.3: the old `@modelcontextprotocol/sdk` StdioClientTransport
 * wrapper is ABSORBED by `@earendil-works/pi-mcp`. Mcode behaviors preserved
 * through this facade (the factory owns them, the pool stays transport-
 * agnostic):
 *
 *   * `cwd: homedir()` — never inherit launchd / Electron / systemd CWD (which
 *     can be `/`), so MCP children that write workspace-relative dirs
 *     (such as Playwright's `.playwright-mcp/`) don't ENOENT against `/`.
 *   * `stderr: 'pipe'` — pi buffers child stderr itself (`onStderr` /
 *     `.stderr`); the pool's line-buffered observers are fed from here.
 *   * `env` constructed as `{ ...process.env, ...config.env, ...injected.env }`
 *     — injected env wins so host-provided identity or policy data can
 *     override any stale value baked into config or leaking from the parent
 *     process env. (pi `inheritEnv` stays at its default `true`; the merged
 *     map is passed explicitly so precedence is visible in one place.)
 *   * pi transport adds process-group kill for wrapper children (npx/uvx) and
 *     an exit hook — strictly stronger cleanup than the old SDK transport.
 */
import { homedir } from 'node:os';
import { StdioTransport } from '@earendil-works/pi-mcp';
import type { StdioTransportConfig } from '../types.js';

export interface McpStdioTransportOptions {
  env?: Record<string, string>;
  /** Raw stderr chunks from the child (pi transport callback). */
  onStderrChunk?: (chunk: string) => void;
}

export function createStdioTransport(
  config: StdioTransportConfig,
  options?: McpStdioTransportOptions,
): StdioTransport {
  return new StdioTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd ?? homedir(),
    env: buildProcessEnv(config.env, options?.env),
    stderr: 'pipe',
    ...(options?.onStderrChunk ? { onStderr: options.onStderrChunk } : {}),
  });
}

function buildProcessEnv(
  configEnv?: Record<string, string>,
  injectedEnv?: Record<string, string>,
): Record<string, string> {
  return {
    ...getProcessEnv(),
    ...(configEnv ?? {}),
    ...(injectedEnv ?? {}),
  };
}

function getProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}
