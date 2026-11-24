/**
 * The [DONE] inventory (incident 2026-11-05, verdict §2.3 precondition): every
 * NATURALLY finished turn — normal, runtime-error, compaction — must end its
 * mapped v2 stream with the synthetic `"[DONE]"` frame.
 *
 * This is the precondition for the run-coordinator's `sawTerminal` safety net
 * (TURN_DETACHED on a source that ends without its terminal marker): the net
 * may only arm once the inventory proves each natural end emits `done`.
 *
 * The turns run through the REAL assembled V2 Runtime host (the embedded
 * composition) with the turn runner scripted — the same harness as
 * `resume-after-owner-death.e2e.test.ts`. The wire leg (daemon → client) is
 * separately pinned by the wave-2 integration test in the tui package; the
 * daemon relays frames verbatim (hub-v2-streams: "[DONE] verbatim").
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CreatedLocalRuntimeHost,
  type LocalRuntimeConfig,
} from '@mavis/local-runtime';
import { RuntimeEventStatus } from '@mavis/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeLocalRuntimeDb } from '../../../local-runtime/src/persistence/db.js';
import type { CliService, SessionStreamFrameView } from '../../src/local/cli-service.js';
import { mapV2TurnStreamResult } from '../../src/application/conversation/session-stream-delivery.js';
import { createLocalRuntimeHostV2ForTest } from '../../src/runtime.js';

interface ScriptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
  readonly eventWriter: {
    pushRuntime(event: Record<string, unknown>): void | Promise<void>;
  };
}

const harness = vi.hoisted(() => ({
  /** Turn scripts run in order; a missing script just completes the Turn. */
  scripts: [] as ((input: ScriptedTurnInput) => Promise<void>)[],
  invocations: 0,
  startedTurns: [] as { sessionId: string; turnId: string }[],
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
  return {
    ...actual,
    PiTurnRunner: class {
      async runTurn(input: ScriptedTurnInput): Promise<void> {
        const index = harness.invocations;
        harness.invocations += 1;
        harness.startedTurns.push({ sessionId: input.sessionId, turnId: input.turnId });
        const script = harness.scripts[index];
        if (script) await script(input);
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

/** A committed assistant message: `type: 2` (RespDataType.AgentMessage) over STREAM_RESP. */
function assistantMessageEvent(
  input: ScriptedTurnInput,
  message: {
    readonly msgId: string;
    readonly role: string;
    readonly content: string;
    readonly kind?: string;
  },
): Record<string, unknown> {
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('stream-resp') ?? `evt-${input.turnId}-resp`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? 1,
    type: 1,
    payload: {
      stream_resp: JSON.stringify({
        type: 2,
        agent_message: {
          msg_id: message.msgId,
          role: message.role,
          msg_content: message.content,
          ...(message.kind ? { kind: message.kind } : {}),
        },
      }),
    },
  };
}

/** The scripted turn body: one assistant message, then the runner's terminal. */
function scriptedTurn(
  message: Parameters<typeof assistantMessageEvent>[1],
): (input: ScriptedTurnInput) => Promise<void> {
  return async (input) => {
    await input.eventWriter.pushRuntime(assistantMessageEvent(input, message));
  };
}

let host: CreatedLocalRuntimeHost | undefined;
let dataDir: string | undefined;

async function createHost(hostDataDir: string): Promise<CreatedLocalRuntimeHost> {
  const config = {
    dataDir: hostDataDir,
    defaultModel: 'test/model',
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
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
}

/** Drains a mapped v2 stream to its "[DONE]" sentinel and returns the frames. */
async function drainStream(
  source: AsyncIterable<SessionStreamFrameView>,
): Promise<SessionStreamFrameView[]> {
  const frames: SessionStreamFrameView[] = [];
  for await (const frame of source) {
    frames.push(frame);
    if (frame.dataJson === '[DONE]') break;
  }
  return frames;
}

async function sendMessageToCompletion(
  cli: CliService,
  sessionId: string,
  content: string,
): Promise<SessionStreamFrameView[]> {
  const opened = await cli.sendMessage({ id: sessionId, content });
  expect(opened.ok, `sendMessage refused: ${JSON.stringify(opened.ok ? null : opened)}`).toBe(true);
  const frames = await drainStream(opened.ok ? opened.source : []);
  await vi.waitFor(
    () => {
      // The turn runner is async: the stream's [DONE] may precede the runner's
      // bookkeeping — wait for the script to have been invoked before teardown.
      // Explicit deadline: a loaded parallel suite starves the 1 s default.
      expect(harness.startedTurns.length).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );
  return frames;
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
  harness.scripts = [];
  harness.invocations = 0;
  harness.startedTurns = [];
});

describe('[DONE] inventory: every naturally finished turn ends with the terminal marker', () => {
  it.each([[[]], [['another-turn']]])('does not finish a detached stream with terminal frames %j', async (turnIds) => {
    const frames = (async function* () {
      for (const turnId of turnIds) {
        yield {
          sessionId: 'session-1', identity: 'terminal', turnId, createdAtMs: 1,
          kind: 'turn-terminal' as const, data: { status: 'completed' },
        };
      }
    })();
    const opened = mapV2TurnStreamResult({ accepted: true, turnId: 'own-turn', frames });
    if (!opened.ok) throw new Error('Expected open stream');
    const projected = await drainStream(opened.source);
    expect(projected.map(frame => frame.dataJson)).toEqual(['{"type":10}']);
  });

  it.each([
    {
      name: 'a normal turn (assistant message)',
      message: { msgId: 'msg-normal', role: 'assistant', content: 'the final answer' },
    },
    {
      name: 'a turn with a runtime error (FAILED terminal)',
      message: { msgId: 'msg-error', role: 'assistant', content: 'partial before the fault' },
      failWith: 'the provider exploded',
    },
    {
      name: 'a turn with compaction (compaction summary committed)',
      message: {
        msgId: 'msg-compaction',
        role: 'assistant',
        content: 'the compacted summary',
        kind: 'compaction',
      },
    },
  ] as const)(
    '$name ends its mapped stream with [DONE] (embedded, real pipeline)',
    async ({ name, message, failWith }) => {
      void name;
      dataDir = await mkdtemp(join(tmpdir(), 'turn-done-inventory-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      harness.scripts = [
        scriptedTurn(message),
        ...(failWith
          ? [
              async (input: ScriptedTurnInput) => {
                throw new Error(failWith);
              },
            ]
          : []),
      ];
      host = await createHost(dataDir);
      const cli = host.cliService as CliService;
      expect(cli, 'the host exposes the CliService').toBeDefined();

      const created = await cli.createSession({
        name: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        title: 'done-inventory',
      });
      expect(typeof created.sessionId).toBe('string');
      const sessionId = created.sessionId as string;

      const frames = await sendMessageToCompletion(cli, sessionId, 'run the turn');
      expect(
        frames.at(-1)?.dataJson,
        'the LAST frame of a naturally finished turn is [DONE]',
      ).toBe('[DONE]');
      expect(
        frames.some((frame) => frame.dataJson.includes('"type":2')),
        'the turn streamed its committed message',
      ).toBe(true);
    },
    240_000,
  );

  it('a runtime-error turn carries the failure to the projection AND still ends with [DONE]', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'turn-done-inventory-err-'));
    await mkdir(join(dataDir, 'workspace'), { recursive: true });
    const reason = 'terminated: Response body length does not match content-length header (UND_ERR_RES_CONTENT_LENGTH_MISMATCH)';
    harness.scripts = [
      async (input) => {
        await input.eventWriter.pushRuntime(
          assistantMessageEvent(input, {
            msgId: 'msg-before-fault',
            role: 'assistant',
            content: 'working…',
          }),
        );
        throw new Error(`${reason}; Authorization: Bearer synthetic-credential`);
      },
    ];
    host = await createHost(dataDir);
    const cli = host.cliService as CliService;
    const created = await cli.createSession({
      name: 'mavis',
      workspaceDir: join(dataDir, 'workspace'),
      title: 'done-inventory-error',
    });
    const sessionId = created.sessionId as string;

    const turnId = '5a5ea813-311c-4854-aed3-eb72ade706f1';
    const opened = await cli.sendMessage({ id: sessionId, turnId, content: 'fail the turn' });
    expect(opened.ok).toBe(true);
    const frames = await drainStream(opened.ok ? opened.source : []);
    expect(frames.at(-1)?.dataJson).toBe('[DONE]');
    expect((await cli.getTurnStatus(sessionId, turnId)).latestActivity).toMatchObject({
      turnId,
      outcome: 'failed',
      failureReason: expect.stringContaining(reason),
      completedAtMs: expect.any(Number),
    });
    expect((await cli.getTurnStatus(sessionId, 'another-turn')).latestActivity).toBeNull();
    // The failure itself is in-band (an error projection), not a lost window:
    // the coordinator keeps the REAL error when `done` is present.
    expect(
      frames.some((frame) => /error|failed/i.test(frame.dataJson)),
      'the turn projected its failure before the terminal marker',
    ).toBe(true);

    await host.apiHost.close();
    await host.metricsClient.close();
    host = undefined;
    closeLocalRuntimeDb(dataDir);
    host = await createHost(dataDir);
    const reopened = host.cliService as CliService;

    await sendMessageToCompletion(reopened, sessionId, 'run another turn');
    expect((await reopened.getTurnStatus(sessionId)).latestActivity?.turnId).not.toBe(turnId);
    const recovered = (await reopened.getTurnStatus(sessionId, turnId)).latestActivity;
    expect(recovered).toMatchObject({ turnId, outcome: 'failed', failureReason: expect.stringContaining(reason) });
    expect(recovered?.failureReason).not.toContain('synthetic-credential');
  }, 240_000);
});
