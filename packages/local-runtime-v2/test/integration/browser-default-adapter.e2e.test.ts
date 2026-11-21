/**
 * Out-of-the-box Browser tooling (owner bug 2026-11-07): a host that does NOT
 * inject its own Browser adapter — the mcoded daemon surface, whose composition
 * (packages/mcoded/src/local-runtime-adapter.ts) has no Electron shell to own
 * one — must still compose the local headless Chrome provider, so the model's
 * turn catalog carries the `browser` tool without any owner config. The plugin
 * `control-in-app-browser` skill is visible to the model regardless (it
 * materializes from the plugin cache), so a catalog without the tool would
 * advertise a capability the model cannot use.
 *
 * The gate: `beta.browserUseTooling` ABSENT means enabled (the product beta
 * channel model already ships the flag ON, `defaultVisibility: 'online'`);
 * an explicit `false` stays the owner's kill switch. The provider launches
 * Chrome lazily per Browser session, so these catalog assertions run without
 * any Chrome executable.
 *
 * The turns run through the REAL assembled V2 Runtime host with the turn
 * runner scripted — the same harness as `browser-turn-catalog.e2e.test.ts`,
 * which pins the injected-adapter path this test complements.
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

let host: CreatedLocalRuntimeHost | undefined;
let dataDir: string | undefined;

/**
 * The daemon composition shape: `runtimeOwnerKind: 'cli'` with
 * `capabilityProfile: 'cli'` (packages/mcoded/src/local-runtime-adapter.ts),
 * NO injected browserAdapter, and a config that carries no explicit
 * `beta.browserUseTooling` key — the owner's untouched config.yaml.
 */
async function createDaemonShapeHost(
  hostDataDir: string,
  beta: LocalRuntimeConfig['beta'],
): Promise<CreatedLocalRuntimeHost> {
  const config = {
    dataDir: hostDataDir,
    defaultModel: 'test/model',
    ...(beta ? { beta } : {}),
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
    capabilityProfile: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(hostDataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
}

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

describe('Daemon-shape host (manual compaction and default browser tooling)', () => {
  it('accepts manual compaction on a daemon-owned session without legacy compactors', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemon-manual-compact-'));
    await mkdir(join(dataDir, 'workspace'), { recursive: true });
    host = await createDaemonShapeHost(dataDir, { browserUseTooling: false });
    const cli = host.cliService as CliService;
    const created = await cli.createSession({
      name: 'mavis', workspaceDir: join(dataDir, 'workspace'), title: 'manual-compact',
    });
    const sessionId = created.sessionId as string;
    await runTurnAndCaptureToolNames(cli, sessionId, 'A small synthetic conversation.');
    await expect(cli.requestCompaction({ name: 'mavis', id: sessionId }))
      .rejects.toMatchObject({ key: 'NOTHING_TO_COMPACT' });
    await host.apiHost.close();
    await host.metricsClient.close();
    host = await createDaemonShapeHost(dataDir, { browserUseTooling: false });
    await expect((host.cliService as CliService).requestCompaction({ name: 'mavis', id: sessionId }))
      .rejects.toMatchObject({ key: 'NOTHING_TO_COMPACT' });
  }, 240_000);

  it('composes the headless provider without an injected adapter and without any owner beta config', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'browser-default-on-'));
    await mkdir(join(dataDir, 'workspace'), { recursive: true });
    host = await createDaemonShapeHost(dataDir, undefined);
    const cli = host.cliService as CliService;
    expect(cli, 'the host exposes the CliService').toBeDefined();

    const created = await cli.createSession({
      name: 'mavis',
      workspaceDir: join(dataDir, 'workspace'),
      title: 'browser-default-on',
    });
    expect(typeof created.sessionId).toBe('string');

    const toolNames = await runTurnAndCaptureToolNames(cli, created.sessionId as string, 'run the turn');
    expect(
      toolNames,
      `the daemon-shape catalog must carry the browser tool out of the box; got: ${toolNames.join(', ')}`,
    ).toContain('browser');
  }, 240_000);

  it('keeps the explicit beta.browserUseTooling: false kill switch working without an adapter', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'browser-default-off-'));
    await mkdir(join(dataDir, 'workspace'), { recursive: true });
    host = await createDaemonShapeHost(dataDir, { browserUseTooling: false });
    const cli = host.cliService as CliService;

    const created = await cli.createSession({
      name: 'mavis',
      workspaceDir: join(dataDir, 'workspace'),
      title: 'browser-default-off',
    });
    expect(typeof created.sessionId).toBe('string');

    const toolNames = await runTurnAndCaptureToolNames(cli, created.sessionId as string, 'run the turn');
    expect(
      toolNames,
      `the kill switch must withhold the browser tool; got: ${toolNames.join(', ')}`,
    ).not.toContain('browser');
  }, 240_000);
});
