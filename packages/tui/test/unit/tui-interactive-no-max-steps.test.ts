import { describe, expect, it, vi } from 'vitest';

import { TuiChatController } from '../../src/tui/controller/chat-controller.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import {
  TuiRunCoordinator,
  type TuiRunRequest,
  type TuiRunRuntime,
} from '../../src/application/run-coordinator.js';
import type { TuiStreamEvent } from '../../src/runtime/stream-events.js';

/**
 * `--max-steps` is an opt-in `mcode exec`/`exec review` flag enforced in the
 * process-local coordinator; the interactive Turn is unlimited by design —
 * no flag, no default — matching the donor, whose agent loop has no step
 * cap anywhere (mechanism-analysis/max-steps.md). These tests pin the code
 * side of that decision so it no longer rests on the absence of code alone.
 */

function createRuntime(
  send: TuiRunRuntime['sendMessage'],
): TuiRunRuntime & {
  sendMessage: ReturnType<typeof vi.fn<TuiRunRuntime['sendMessage']>>;
  abortSession: ReturnType<typeof vi.fn<TuiRunRuntime['abortSession']>>;
} {
  return {
    sendMessage: vi.fn(send),
    abortSession: vi.fn(async () => true),
  };
}

function assistantStep(index: number): TuiStreamEvent {
  return {
    type: 'message',
    message: { id: `answer-${index}`, role: 'assistant', content: `step ${index}` },
  } as const;
}

describe('interactive path never carries a max-steps limit', () => {
  it('the chat-controller submits its interactive request without policy.maxSteps', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'done' } as const;
    });
    const coordinator = new TuiRunCoordinator(runtime);
    const execute = vi.spyOn(coordinator, 'execute');
    const controller = new TuiChatController({
      runtime: runtime as never,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      version: 'test',
      createTurnId: () => 'interactive-turn-1',
      runCoordinator: coordinator,
    });

    await controller.submit('Fix it');

    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0]?.[0] as TuiRunRequest;
    // The plain interactive submit carries no policy at all: the limiter is
    // exec-surface-only and there is nothing interactive to enforce it on.
    expect(request.policy).toBeUndefined();
    expect(request.policy?.maxSteps).toBeUndefined();
    expect(runtime.abortSession).not.toHaveBeenCalled();
  });

  it('even with the automation-result sink the interactive policy is requireAnswer only', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'done' } as const;
    });
    const coordinator = new TuiRunCoordinator(runtime);
    const execute = vi.spyOn(coordinator, 'execute');
    const controller = new TuiChatController({
      runtime: runtime as never,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      version: 'test',
      createTurnId: () => 'interactive-turn-2',
      runCoordinator: coordinator,
      writeAutomationResult: vi.fn(),
    });

    await controller.submit('Fix it');

    const request = execute.mock.calls[0]?.[0] as TuiRunRequest;
    expect(request.policy).toEqual({ requireAnswer: true });
    expect(request.policy?.maxSteps).toBeUndefined();
  });

  it('an interactive-shaped request (no policy) settles succeeded across many assistant steps', async () => {
    const steps = 40;
    const runtime = createRuntime(async function* () {
      for (let index = 1; index <= steps; index += 1) yield assistantStep(index);
      yield { type: 'session-status', status: 'finished' } as const;
      yield { type: 'done' } as const;
    });

    // Exactly the request shape the interactive entries build: no policy.
    const result = await new TuiRunCoordinator(runtime).execute({
      turnId: 'turn-unbounded',
      session: Promise.resolve({ sessionId: 'session-1' }),
      content: 'Keep going',
      workspace: '/repo',
      version: 'test',
    });

    expect(result.status).toBe('succeeded');
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    // No implicit cap fired, so the host never aborted the Runtime Turn.
    expect(runtime.abortSession).not.toHaveBeenCalled();
  });
});
