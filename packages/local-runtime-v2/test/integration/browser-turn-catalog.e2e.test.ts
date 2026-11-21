/**
 * The Browser layer must be visible to the model. When Browser Use tooling is
 * enabled, the assembled V2 turn catalog hands the `browser` tool to the turn
 * runner — the exact tool list the model sees — bound to the
 * `control-in-app-browser` Skill; with the tooling disabled the catalog
 * carries no `browser` tool.
 *
 * The turns run through the REAL assembled V2 Runtime host (the embedded
 * composition) with the turn runner scripted — the same harness as
 * `turn-done-inventory.e2e.test.ts`. The service-level gate
 * (`resolveTurnCapability`) is separately pinned by `services.test.ts`; this
 * test pins the full pipeline end to end: config beta flag → Browser Use
 * service → runtime-agent-product `toolSources.resolve` → turn tool catalog →
 * runner `toolConfig.tools`.
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LocalBrowserAdapter } from '@mavis/agent-tools/desktop';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import {
  type CreatedLocalRuntimeHost,
  type LocalRuntimeConfig,
} from '@mavis/local-runtime';
import { RuntimeEventStatus } from '@mavis/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeLocalRuntimeDb } from '../../../local-runtime/src/persistence/db.js';
import type { CliService } from '../../src/local/cli-service.js';
import { createLocalRuntimeHostV2ForTest } from '../../src/runtime.js';

interface ScriptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
  readonly eventWriter: {
    pushRuntime(event: Record<string, unknown>): void | Promise<void>;
  };
}

const harness = vi.hoisted(() => ({
  /** Tool names captured from every scripted runner invocation, in order. */
  capturedToolNames: [] as string[][],
  startedTurns: [] as { sessionId: string; turnId: string }[],
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
  return {
    ...actual,
    PiTurnRunner: class {
      async runTurn(input: ScriptedTurnInput & {
        toolConfig: { tools: readonly RuntimeTool[] };
      }): Promise<void> {
        harness.capturedToolNames.push(input.toolConfig.tools.map(({ def }) => def.name));
        harness.startedTurns.push({ sessionId: input.sessionId, turnId: input.turnId });
        await input.eventWriter.pushRuntime(
          terminalEvent(input, RuntimeEventStatus.COMPLETED, 'completed'),
        );
      }
    },
  };
});

function terminalEvent(
  input: ScriptedTurnInput,
  status: number,
  message: string,
): Record<string, unknown> {
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('session-status') ?? `evt-${input.turnId}-${status}`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? status,
    type: 3,
    payload: { status, stop_reason: { type: 1, message } },
  };
}

/**
 * Minimal in-process Browser provider stub: a real adapter is Electron/plugin
 * owned; the catalog path under test only reads its capabilities and the
 * enabled flags, so `execute` can never be reached from a catalog assertion.
 */
function stubBrowserAdapter(): LocalBrowserAdapter {
  return {
    getCapabilities: () => ({
      provider: 'test-provider',
      version: 1,
      actions: ['inspect'],
    }),
    execute: async () => ({ content: [] }),
  };
}

let host: CreatedLocalRuntimeHost | undefined;
let dataDir: string | undefined;

async function createHost(
  hostDataDir: string,
  browserUseTooling: boolean,
): Promise<CreatedLocalRuntimeHost> {
  const config = {
    dataDir: hostDataDir,
    defaultModel: 'test/model',
    beta: { browserUseTooling, filePanelBrowser: true },
    provider: {
      test: {
        options: { apiKey: 'test-key', baseURL: 'https://provider.test/v1' },
        models: {
          model: { modalities: { input: ['text'], output: ['text'] } },
        },
      },
    },
  } as LocalRuntimeConfig;
  return createLocalRuntimeHostV2ForTest({
    dataDir: hostDataDir,
    runtimeOwnerKind: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(hostDataDir, 'workspace'),
    browserAdapter: stubBrowserAdapter(),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
}

/** Drains a mapped v2 stream to its "[DONE]" sentinel. */
async function drainStream(
  source: AsyncIterable<{ dataJson?: string }>,
): Promise<void> {
  for await (const frame of source) {
    if (frame.dataJson === '[DONE]') break;
  }
}

async function runTurnAndCaptureToolNames(
  cli: CliService,
  sessionId: string,
  content: string,
): Promise<string[]> {
  const opened = await cli.sendMessage({ id: sessionId, content });
  expect(opened.ok, `sendMessage refused: ${JSON.stringify(opened.ok ? null : opened)}`).toBe(true);
  if (opened.ok) await drainStream(opened.source);
  await vi.waitFor(
    () => {
      // The turn runner is async: the stream's [DONE] may precede the runner's
      // bookkeeping — wait for the script to have been invoked before asserts.
      // Explicit deadline: a loaded parallel suite starves the 1 s default.
      expect(harness.startedTurns.length).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );
  return harness.capturedToolNames.at(-1) ?? [];
}

afterEach(async () => {
  if (host) {
    await host.apiHost.close().catch(() => undefined);
    await host.metricsClient.close().catch(() => undefined);
    host = undefined;
  }
  if (dataDir) {
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    dataDir = undefined;
  }
  harness.capturedToolNames = [];
  harness.startedTurns = [];
});

describe('Browser turn catalog visibility (embedded, real pipeline)', () => {
  it('the model sees the `browser` tool bound to control-in-app-browser when Browser Use tooling is enabled', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'browser-catalog-on-'));
    await mkdir(join(dataDir, 'workspace'), { recursive: true });
    host = await createHost(dataDir, true);
    const cli = host.cliService as CliService;
    expect(cli, 'the host exposes the CliService').toBeDefined();

    const created = await cli.createSession({
      name: 'mavis',
      workspaceDir: join(dataDir, 'workspace'),
      title: 'browser-catalog-on',
    });
    expect(typeof created.sessionId).toBe('string');

    const toolNames = await runTurnAndCaptureToolNames(cli, created.sessionId as string, 'run the turn');
    expect(
      toolNames,
      `the turn catalog must include the browser tool; got: ${toolNames.join(', ')}`,
    ).toContain('browser');
    // The skill prerequisite is materialized into the tool the model sees:
    // the compact Browser tool description carries the required Skill name.
    expect(toolNames).toContain('skill');
  }, 240_000);

  it('the turn catalog carries no browser tool when Browser Use tooling is disabled', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'browser-catalog-off-'));
    await mkdir(join(dataDir, 'workspace'), { recursive: true });
    host = await createHost(dataDir, false);
    const cli = host.cliService as CliService;

    const created = await cli.createSession({
      name: 'mavis',
      workspaceDir: join(dataDir, 'workspace'),
      title: 'browser-catalog-off',
    });
    expect(typeof created.sessionId).toBe('string');

    const toolNames = await runTurnAndCaptureToolNames(cli, created.sessionId as string, 'run the turn');
    expect(
      toolNames,
      `the disabled gate must withhold the browser tool; got: ${toolNames.join(', ')}`,
    ).not.toContain('browser');
  }, 240_000);
});
