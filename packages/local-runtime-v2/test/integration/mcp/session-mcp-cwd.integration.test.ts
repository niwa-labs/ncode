import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it, vi } from "vitest";
import { McpConnectionPool } from "@mavis/mcp/runtime/connection-pool";
import { CliService, type CliServiceOptions } from "../../../src/local/cli-service.js";
import { LocalMcpPublicFacade, LocalMcpService } from "../../../src/service/mcp/index.js";
import { sessionMcpConnectionKey } from "../../../src/service/mcp/runtime/settings-config.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixture = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let callId;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, result } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      send({ id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      } });
      break;
    case 'tools/list':
      send({ id, result: { tools: [{ name: 'where', inputSchema: { type: 'object' } }] } });
      break;
    case 'tools/call':
      callId = id;
      send({ id: 'roots', method: 'roots/list' });
      break;
    default:
      if (id === 'roots' && result) {
        const text = JSON.stringify({ cwd: process.cwd(), pid: process.pid, root: result.roots[0].uri });
        send({ id: callId, result: { content: [{ type: 'text', text }] } });
      }
  }
});
`;

async function setup() {
  const data = await realpath(await mkdtemp(join(tmpdir(), "session-mcp-cwd-")));
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const a = join(data, "a");
  const b = join(data, "b");
  const script = join(data, "server.cjs");
  await Promise.all([mkdir(a), mkdir(b), writeFile(script, fixture)]);
  let service: LocalMcpService;
  const pool = new McpConnectionPool({
    getResolvedServer: (name) => service.getServerLookup().getResolvedServer(name),
  });
  service = new LocalMcpService(() => data, { connectionPool: pool });
  cleanups.push(() => service.close());

  const workspaces = new Map<string, string | undefined>();
  const cli = new CliService({
    applications: {
      session: {
        query: {
          getSession: async (_ctx: unknown, { id }: { id: string }) => ({
            session: { workspaceDir: workspaces.get(id) },
          }),
        },
      },
    },
    application: { mcp: new LocalMcpPublicFacade(service) },
  } as unknown as CliServiceOptions);
  async function register(sessionId: string, sessionCwd?: string, cwd?: string) {
    workspaces.set(sessionId, sessionCwd);
    await cli.configureSessionMcpServers({
      sessionId,
      servers: [{ name: "probe", config: { command: process.execPath, args: [script] }, cwd }],
    });
  }

  const call = (sessionId: string, workspaceRoot?: string) =>
    service.call("probe", "where", {}, { context: { sessionId, workspaceRoot } });

  async function where(sessionId: string, workspaceRoot?: string) {
    const result = await call(sessionId, workspaceRoot);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const [message] = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(message.text) as { cwd: string; pid: number; root: string };
  }

  return { a, b, script, service, pool, register, call, where };
}

it.each(["0", "1"])("isolates same-name children by session with session-only mode %s", async (mode) => {
  vi.stubEnv("MCODE_SESSION_MCP_ONLY", mode);
  const { a, b, register, where } = await setup();
  await Promise.all([register("ses_a", a), register("ses_b", b)]);

  const [first, second] = await Promise.all([where("ses_a", b), where("ses_b", b)]);
  expect(first.cwd).toBe(a);
  expect(second.cwd).toBe(b);
  expect(first.pid).not.toBe(second.pid);
});

it("reconnects using the registered cwd and replaces the child on re-registration", async () => {
  const { a, b, register, where } = await setup();
  await register("ses_a", a);
  const first = await where("ses_a", b);

  process.kill(first.pid, "SIGTERM");
  const reconnected = await vi.waitFor(async () => {
    const child = await where("ses_a");
    expect(child.pid).not.toBe(first.pid);
    return child;
  });
  expect(reconnected.cwd).toBe(a);

  await register("ses_a", b);
  const reconfigured = await where("ses_a", a);
  expect(reconfigured.cwd).toBe(b);
  expect(reconfigured.pid).not.toBe(reconnected.pid);
});

it("prevents queued discovery from starting a child with a superseded cwd", async () => {
  const { a, b, pool, register, where, call } = await setup();
  await register("ses_a", a);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const listTools = pool.listTools.bind(pool);
  vi.spyOn(pool, "listTools").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return listTools(...args);
  });

  const staleCall = call("ses_a");
  try {
    await entered.promise;
    await register("ses_a", b);
  } finally {
    release.resolve();
  }
  expect((await staleCall).isError).toBe(true);
  expect((await where("ses_a")).cwd).toBe(b);
});

it("uses the trusted server cwd while keeping the client's existing roots response", async () => {
  const { a, b, register, where, call } = await setup();
  await register("ses_a", a, b);
  expect(await where("ses_a", a)).toMatchObject({
    cwd: b,
    root: pathToFileURL(homedir()).href,
  });
  await register("ses_a", a, join(b, "missing"));
  expect((await call("ses_a", a)).isError).toBe(true);
});

it("refuses unknown, relative, missing and non-directory session cwds", async () => {
  const { a, script, register, call } = await setup();
  for (const cwd of [undefined, ".", join(a, "missing"), script]) {
    await register("ses_a", cwd);
    expect((await call("ses_a", a)).isError, `cwd: ${cwd}`).toBe(true);
  }
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "fails to spawn in an existing directory without search permission",
  async () => {
    const { a, b, register, call } = await setup();
    await register("ses_a", a);
    await chmod(a, 0o600);
    try {
      expect((await call("ses_a", b)).isError).toBe(true);
    } finally {
      await chmod(a, 0o700);
    }
  },
);

it("leaves session HTTP and SSE transports and their roots unchanged", async () => {
  const { a, service, pool } = await setup();
  // Capture the real pool's input without opening a network connection.
  const listTools = vi.spyOn(pool, "listTools").mockResolvedValue([]);
  const servers = (["http", "sse"] as const).map((type) => ({
    name: type,
    config: { type, url: "https://mcp.example.test/mcp", headers: { "X-Test": "value" } },
  }));
  await service.configureSessionServers("ses_a", servers, a);
  for (const { name, config } of servers) {
    await service.listToolsLive(name, { sessionId: "ses_a", workspaceRoot: a });
    expect(listTools).toHaveBeenLastCalledWith(name, {
      connectionKey: sessionMcpConnectionKey("ses_a", name),
      serverOverride: { name, enabled: true, transport: config },
    }, expect.anything());
  }
});
