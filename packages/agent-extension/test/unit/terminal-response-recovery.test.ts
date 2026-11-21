/**
 * Revision 11 F1 — the terminal-response safety-net that production now
 * composes in `createHostNormalExtensions` (local-runtime-v2).
 *
 * Covered here, against the extension's real handlers:
 * - an empty assistant response after a SUCCESSFUL tool batch gets exactly one
 *   bounded recovery request (`retry`, reason `terminal_empty`);
 * - a second consecutive empty response fails the turn honestly with
 *   `terminal_empty` instead of reporting a blank success (`fail`), and the
 *   failure observation reaches `onFailed`;
 * - a visible text answer after the retry resolves the recovery
 *   (`onRecovered`) and the turn continues;
 * - an empty response with NO prior tool batch (or only errored tools) is left
 *   alone — the net never fires outside the post-tool-success window;
 * - per-turn state is cleaned up at `turn_end`.
 */

import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type {
  AfterLlmCallHandler,
  StepEndHandler,
  TurnAssemblyCtx,
  TurnEndHandler,
} from '@mavis/agent-runtime';
import { terminalResponseRecoveryExtension } from '../../src/terminal-response-recovery.js';

/** Structural mirror of pi-turn-runner's `PiAfterLlmCallHookDecision` variants this extension returns. */
type Decision =
  | { type: 'continue' }
  | { type: 'retry'; reason: string; prompt: string }
  | { type: 'fail'; reason: string };

const SESSION = 'session-recovery';
const TURN = 'turn-recovery';

const ctx = {
  sessionId: SESSION,
  turnId: TURN,
  agentName: 'mavis',
  workspaceDir: '/tmp/workspace',
  history: { entries: [] },
  userInput: { text: 'do the thing' },
} as unknown as TurnAssemblyCtx;

function usage(): Usage {
  return {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'mock',
    usage: usage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

const EMPTY = assistant([]);
const TEXT = assistant([{ type: 'text', text: 'Done — the file is updated.' }]);
const TOOL_CALL = assistant([
  { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: '/tmp/x' } },
]);

function stepEnd(toolResults: Array<{ isError: boolean }>): Parameters<StepEndHandler>[0] {
  return {
    toolResults: toolResults.map((result, i) => ({
      role: 'toolResult' as const,
      id: `tr-${i}`,
      toolCallId: `call-${i}`,
      toolName: 'write',
      isError: result.isError,
      output: 'ok',
      timestamp: Date.now(),
    })),
  } as unknown as Parameters<StepEndHandler>[0];
}

interface CapturedHandlers {
  onStepEnd: StepEndHandler;
  afterLlmCall: AfterLlmCallHandler;
  turnEnd: TurnEndHandler;
}

function capture(
  options: Parameters<typeof terminalResponseRecoveryExtension>[0] = {},
): CapturedHandlers {
  let onStepEnd: StepEndHandler | undefined;
  let afterLlmCall: AfterLlmCallHandler | undefined;
  let turnEnd: TurnEndHandler | undefined;
  const extension = terminalResponseRecoveryExtension(options);
  extension.init({
    on(event: string, handler: unknown) {
      if (event === 'on_step_end') onStepEnd = handler as StepEndHandler;
      else if (event === 'after_llm_call') afterLlmCall = handler as AfterLlmCallHandler;
      else if (event === 'turn_end') turnEnd = handler as TurnEndHandler;
    },
  } as never);
  if (!onStepEnd || !afterLlmCall || !turnEnd) throw new Error('handlers not registered');
  return { onStepEnd, afterLlmCall, turnEnd };
}

describe('terminalResponseRecoveryExtension (revision 11 F1, composed in production)', () => {
  it('empty response after a successful tool batch asks for one bounded retry', async () => {
    const h = capture();
    h.onStepEnd(stepEnd([{ isError: false }]), ctx);
    const decision = (await h.afterLlmCall(
      { message: EMPTY, messages: [EMPTY] },
      ctx,
    )) as Decision;
    expect(decision).toEqual({
      type: 'retry',
      reason: 'terminal_empty',
      prompt:
        'The tools completed, but your response was empty. Provide a concise final response summarizing the result for the user.',
    });
  });

  it('a second consecutive empty response fails the turn with terminal_empty and reports the failure', async () => {
    const failed: unknown[] = [];
    const recovered: unknown[] = [];
    const h = capture({
      onFailed: (observation) => void failed.push(observation),
      onRecovered: (observation) => void recovered.push(observation),
    });
    h.onStepEnd(stepEnd([{ isError: false }]), ctx);
    await h.afterLlmCall({ message: EMPTY, messages: [EMPTY] }, ctx);
    const decision = (await h.afterLlmCall(
      { message: EMPTY, messages: [EMPTY, EMPTY] },
      ctx,
    )) as Decision;
    expect(decision).toEqual({ type: 'fail', reason: 'terminal_empty' });
    // `attempts` counts the empty responses consumed (retry + failed recovery).
    expect(failed).toEqual([{ sessionId: SESSION, turnId: TURN, attempts: 2 }]);
    expect(recovered).toEqual([]);
  });

  it('a visible answer after the retry resolves the recovery and continues', async () => {
    const failed: unknown[] = [];
    const recovered: unknown[] = [];
    const h = capture({
      onFailed: (observation) => void failed.push(observation),
      onRecovered: (observation) => void recovered.push(observation),
    });
    h.onStepEnd(stepEnd([{ isError: false }]), ctx);
    const first = (await h.afterLlmCall(
      { message: EMPTY, messages: [EMPTY] },
      ctx,
    )) as Decision;
    expect(first).toMatchObject({ type: 'retry' });
    const second = (await h.afterLlmCall(
      { message: TEXT, messages: [EMPTY, TEXT] },
      ctx,
    )) as Decision;
    expect(second).toEqual({ type: 'continue' });
    expect(recovered).toEqual([{ sessionId: SESSION, turnId: TURN, attempts: 1 }]);
    expect(failed).toEqual([]);
  });

  it('never fires outside the post-tool-success window', async () => {
    // No tool batch at all.
    const noTools = capture();
    expect(await noTools.afterLlmCall({ message: EMPTY, messages: [EMPTY] }, ctx)).toEqual({
      type: 'continue',
    });

    // Errored tool results do not arm the net either.
    const errored = capture();
    errored.onStepEnd(stepEnd([{ isError: true }]), ctx);
    expect(await errored.afterLlmCall({ message: EMPTY, messages: [EMPTY] }, ctx)).toEqual({
      type: 'continue',
    });

    // Tool intent or visible text is never retried.
    const withTools = capture();
    withTools.onStepEnd(stepEnd([{ isError: false }]), ctx);
    expect(
      await withTools.afterLlmCall({ message: TOOL_CALL, messages: [TOOL_CALL] }, ctx),
    ).toEqual({ type: 'continue' });
    expect(await withTools.afterLlmCall({ message: TEXT, messages: [TEXT] }, ctx)).toEqual({
      type: 'continue',
    });
  });

  it('cleans per-turn state at turn_end', async () => {
    const h = capture();
    h.onStepEnd(stepEnd([{ isError: false }]), ctx);
    await h.afterLlmCall({ message: EMPTY, messages: [EMPTY] }, ctx);
    h.turnEnd({ sessionId: SESSION, turnId: TURN, agentName: 'mavis', workspaceDir: '/tmp' }, ctx);
    // A fresh turn in the same session starts unarmed: no retry without tools.
    expect(
      await h.afterLlmCall(
        { message: EMPTY, messages: [EMPTY] },
        { ...ctx, turnId: 'turn-next' } as TurnAssemblyCtx,
      ),
    ).toEqual({ type: 'continue' });
  });
});
