import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { McpConnectionPool } from "@mavis/mcp/runtime/connection-pool";
import { LocalMcpService } from "../../../src/service/mcp/index.js";

const roots: string[] = [];
const services: LocalMcpService[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// Minimal stdio MCP server: announces one `probe` tool and writes a `started`
// marker into its cwd so the test can tell whether it was ever launched.
const fixture = `
const fs = require('node:fs');
const readline = require('node:readline');
if (process.env.CHECK_MARKER) fs.writeFileSync(process.env.CHECK_MARKER, 'yes');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (request.method === 'initialize') send({jsonrpc:'2.0', id:request.id, result:{protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'}}});
 if (request.method === 'tools/list') send({jsonrpc:'2.0',id:request.id,result:{tools:[{name:'probe',inputSchema:{type:'object'}}]}});
 if (request.method === 'tools/call') send({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'ok'}]}});
});
`;

async function setup() {
  const data = await realpath(await mkdtemp(join(tmpdir(), "session-mcp-only-")));
  roots.push(data);
  const workspace = join(data, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "server.cjs"), fixture);
  // A workspace `.mcp.json` the harness never agreed to: its server must not
  // even start in session-MCP-only mode.
  await writeFile(
    join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        stray: {
          command: process.execPath,
          args: ["./server.cjs"],
          env: { CHECK_MARKER: join(workspace, '..', 'stray-started') },
        },
      },
    }),
  );
  let service: LocalMcpService;
  const pool = new McpConnectionPool({
    getResolvedServer: (name) =>
      service.getServerLookup().getResolvedServer(name),
  });
  service = new LocalMcpService(() => data, { connectionPool: pool });
  services.push(service);
  return { data, workspace, service };
}

async function startedMarker(workspace: string): Promise<boolean> {
  try {
    await access(join(workspace, "..", "stray-started"));
    return true;
  } catch {
    return false;
  }
}

it("session-MCP-only mode connects only the session's own servers", async () => {
  vi.stubEnv("MCODE_SESSION_MCP_ONLY", "1");
  const { workspace, service } = await setup();
  await service.configureSessionServers("ses_harness", [
    {
      name: "harness",
      config: {
        command: process.execPath,
        args: [join(workspace, "server.cjs")],
        env: { CHECK_MARKER: join(workspace, '..', 'harness-started') },
      },
    },
  ], workspace);

  const entries = await service.listToolEntriesForTurn({
    sessionId: "ses_harness",
    workspaceRoot: workspace,
    emitBusEvent: () => {},
  });

  expect(entries.map((entry) => entry.serverName)).toEqual(["harness"]);
  expect(entries.map((entry) => entry.tool.def.name)).toEqual(["mcp__harness__probe"]);
  // The workspace-declared server was never launched: its marker is absent.
  expect(await startedMarker(workspace)).toBe(false);

  // Call-time enforcement: even a direct call naming the skipped server
  // must fail instead of reaching it.
  expect(await service.listNativeTools({ sessionId: "ses_harness", workspaceRoot: workspace })).toHaveLength(1);
  await expect(
    service.call("stray", "probe", {}, { context: { sessionId: "ses_harness", workspaceRoot: workspace } }),
  ).resolves.toMatchObject({ isError: true });

  // Control: without the mode both servers are discovered.
  vi.unstubAllEnvs();
  const control = await service.listToolEntriesForTurn({
    sessionId: "ses_harness",
    workspaceRoot: workspace,
    emitBusEvent: () => {},
  });
  expect(control.map((entry) => entry.serverName).sort()).toEqual(["harness", "stray"]);
  expect(await startedMarker(workspace)).toBe(true);
});

it("session-MCP-only mode without session servers yields no MCP tools", async () => {
  vi.stubEnv("MCODE_SESSION_MCP_ONLY", "1");
  const { workspace, service } = await setup();
  const entries = await service.listToolEntriesForTurn({
    sessionId: "ses_harness",
    workspaceRoot: workspace,
    emitBusEvent: () => {},
  });
  expect(entries).toEqual([]);
  expect(await startedMarker(workspace)).toBe(false);
});
