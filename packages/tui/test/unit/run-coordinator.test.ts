import { describe, expect, it, vi } from 'vitest';

import { TuiRunCoordinator, type TuiRunRuntime } from '../../src/application/run-coordinator.js';
import { TuiFailure } from '../../src/failure.js';

describe('TuiRunCoordinator', () => {
  it.each([
    ['keep', undefined], ['clear', undefined],
    ['keep', 'plan-entry'], ['clear', 'plan-entry'],
    ['keep', 'plan-exit'], ['clear', 'plan-exit'],
  ] as const)('recovers rejected Queue admission with %s while preserving intent %s', async (action, clientIntent) => {
    const runtime = createRuntime(async function* (_submission, _signal, options) {
      if (!options?.pausedQueueAction) throw new TuiFailure('runtime', 'Queue paused', { code: 'local_session_queue_paused' });
      yield { type: 'done' } as const;
    });
    const onQueuePaused = vi.fn(async () => action === 'clear' ? 'paused-queue-clear' as const : 'paused-queue-keep' as const);
    const onAccepted = vi.fn();
    const result = await new TuiRunCoordinator(runtime).execute({
      turnId: 'turn-1', session: Promise.resolve({ sessionId: 'session-1' }),
      content: 'Continue with this instruction', workspace: '/repo', version: 'test', onQueuePaused,
      ...(clientIntent ? { clientIntent } : {}),
      attachments: [{ type: 'file', fileName: 'input.txt', filePath: '/repo/input.txt', mimeType: 'text/plain' }],
    }, undefined, onAccepted);
    expect(result.status).toBe('succeeded');
    expect(onQueuePaused).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage.mock.calls[1]?.[0]).toEqual(runtime.sendMessage.mock.calls[0]?.[0]);
    expect(runtime.sendMessage.mock.calls[1]?.[2]).toEqual({ pausedQueueAction: action });
  });

  it('keeps budgeted Queue admission immediate without prompting for recovery', async () => {
    const runtime = createRuntime(async function* () {
      yield await Promise.reject<never>(new TuiFailure('runtime', 'Queue paused', {
        code: 'local_session_queue_paused',
      }));
    });
    const onQueuePaused = vi.fn(async () => 'paused-queue-keep' as const);
    const result = await new TuiRunCoordinator(runtime, { nowMs: () => 1_000 }).execute({
      ...request('turn-budget'),
      policy: { timeoutMs: 60_000 },
      onQueuePaused,
    });
    expect(result.outcome.error?.code).toBe('local_session_queue_paused');
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(runtime.sendMessage.mock.calls[0]?.[0]).toMatchObject({ executionDeadlineAtMs: 61_000 });
    expect(onQueuePaused).not.toHaveBeenCalled();
  });

  it('keeps a cancelled paused submission unaccepted and does not resend it', async () => {
    const runtime = createRuntime(async function* () {
      yield await Promise.reject<never>(new TuiFailure('runtime', 'Queue paused', { code: 'local_session_queue_paused' }));
    });
    const onAccepted = vi.fn();
    const result = await new TuiRunCoordinator(runtime).execute({
      turnId: 'turn-1', session: Promise.resolve({ sessionId: 'session-1' }),
      content: 'Keep this draft', workspace: '/repo', version: 'test', onQueuePaused: async () => 'cancel',
    }, undefined, onAccepted);
    expect(result.outcome.error?.code).toBe('PAUSED_QUEUE_SEND_CANCELLED');
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('does not retry a Queue error after any frame was accepted', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'heartbeat' } as const;
      throw new TuiFailure('runtime', 'Queue paused', { code: 'local_session_queue_paused' });
    });
    const onQueuePaused = vi.fn(async () => 'paused-queue-keep' as const);
    await new TuiRunCoordinator(runtime).execute({
      turnId: 'turn-1', session: Promise.resolve({ sessionId: 'session-1' }), content: 'Send once',
      workspace: '/repo', version: 'test', onQueuePaused,
    });
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(onQueuePaused).not.toHaveBeenCalled();
  });
  it('uses generated sendMessage input and assembles an application-neutral outcome', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'heartbeat' } as const;
      yield {
        type: 'message',
        message: {
          id: 'answer-1',
          role: 'assistant',
          content: 'done',
          usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 1 },
        },
      } as const;
      yield { type: 'session-status', status: 'finished' } as const;
      yield { type: 'done' } as const;
    });
    const observed: string[] = [];
    const accepted = vi.fn();
    const coordinator = new TuiRunCoordinator(runtime, { nowMs: () => 1_200 });

    await expect(
      coordinator.execute(
        {
          turnId: 'turn-1',
          session: Promise.resolve({ sessionId: 'session-1' }),
          content: 'Fix it',
          clientIntent: 'plan-entry',
          workspace: '/repo',
          version: 'test',
          model: { providerId: 'provider', modelId: 'model', variant: 'fast' },
          attachments: [
            {
              type: 'file',
              filePath: '/repo/input.txt',
              fileName: 'input.txt',
              mimeType: 'text/plain',
              sizeBytes: 4,
            },
          ],
        },
        (event) => observed.push(event.type),
        accepted,
      ),
    ).resolves.toMatchObject({
      status: 'succeeded',
      outcome: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'succeeded',
        answer: 'done',
        model: { providerId: 'provider', modelId: 'model', variant: 'fast' },
        usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 1 },
      },
    });
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-1',
        content: 'Fix it',
        clientIntent: 'plan-entry',
        model: { providerId: 'provider', modelId: 'model', variant: 'fast' },
        attachments: [
          {
            meta: {
              attachmentType: 'file',
              fileName: 'input.txt',
              mimeType: 'text/plain',
              sizeBytes: 4,
            },
            local: { filePath: '/repo/input.txt' },
          },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(observed).toEqual(['heartbeat', 'message', 'session-status', 'done']);
    expect(accepted).toHaveBeenCalledOnce();
  });

  it('preserves generated admission error keys for queue fallback decisions', async () => {
    const runtime = createRuntime(async function* rejectedAdmission() {
      yield* [];
      throw Object.assign(new Error('Session is busy'), {
        category: 'runtime',
        code: 'local_session_busy',
        retryable: false,
      });
    });
    const coordinator = new TuiRunCoordinator(runtime);

    await expect(coordinator.execute(request('turn-busy'))).resolves.toMatchObject({
      status: 'failed',
      outcome: { error: { code: 'local_session_busy', message: 'Session is busy' } },
    });
  });

  // Incident 2026-11-05: the busy refusal arrives exactly as
  // `conversation-access` builds it from the mirrored `{ok:false,status,body}`
  // (the TuiFailure with the body key + message). The coordinator must carry
  // BOTH the structured error (the ACP shim reads outcome.error.code /
  // retryable) and the message string (the shim's error text).
  it('carries a busy-refusal TuiFailure into outcome.error AND the result error string', async () => {
    const runtime = createRuntime(async function* () {
      yield* [];
      throw new TuiFailure('runtime', 'This session already has an active turn.', {
        code: 'local_session_busy',
        retryable: false,
      });
    });

    const result = await new TuiRunCoordinator(runtime).execute(request('turn-busy-mirror'));
    expect(result.status).toBe('failed');
    expect(result.outcome.error).toMatchObject({
      category: 'runtime',
      code: 'local_session_busy',
      message: 'This session already has an active turn.',
      retryable: false,
    });
    expect(result.error).toBe('This session already has an active turn.');
  });

  it('aborts the Runtime Session and reports cancellation', async () => {
    let started = () => undefined;
    let streamSignal: AbortSignal | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = createRuntime(async function* pendingCancellation(_req, signal) {
      yield* [];
      streamSignal = signal;
      started();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    const coordinator = new TuiRunCoordinator(runtime);
    const running = coordinator.execute(request('turn-cancel'));
    await streamStarted;

    const stopRequested = Promise.withResolvers<void>();
    const stopReply = Promise.withResolvers<boolean>();
    runtime.abortSession.mockImplementationOnce(() => {
      stopRequested.resolve();
      return stopReply.promise;
    });
    const stopping = coordinator.abort();
    await stopRequested.promise;
    // A stream cancellation can race the turn-scoped stop on the daemon.
    expect(streamSignal?.aborted).toBe(false);
    stopReply.resolve(true);
    await expect(stopping).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(runtime.abortSession).toHaveBeenCalledWith({
      id: 'session-1',
      turnId: 'turn-cancel',
      reason: 'user_stop',
    });
  });

  it('keeps timeout and maxSteps in the process-local coordinator', async () => {
    vi.useFakeTimers();
    try {
      const timeoutRuntime = createRuntime(async function* pendingTimeout(_req, signal) {
        yield* [];
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
      });
      const timed = new TuiRunCoordinator(timeoutRuntime, { nowMs: () => 1_000 }).execute({
        ...request('turn-timeout'),
        policy: { timeoutMs: 20 },
      });
      await vi.advanceTimersByTimeAsync(19);
      expect(timeoutRuntime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ executionDeadlineAtMs: 1_020 }),
        expect.any(AbortSignal),
      );
      expect(timeoutRuntime.abortSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(timed).resolves.toMatchObject({ status: 'timeout' });
      expect(timeoutRuntime.abortSession).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'timeout' }),
      );
    } finally {
      vi.useRealTimers();
    }

    const limitRuntime = createRuntime(async function* () {
      yield { type: 'message', message: { role: 'assistant', content: 'first' } } as const;
      yield { type: 'message', message: { role: 'assistant', content: 'second' } } as const;
    });
    await expect(
      new TuiRunCoordinator(limitRuntime).execute({
        ...request('turn-limit'),
        policy: { maxSteps: 1 },
      }),
    ).resolves.toMatchObject({ status: 'limit_exceeded', outcome: { answer: 'first' } });
    expect(limitRuntime.abortSession).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'max_steps' }),
    );
  });

  // BYOK regression over reactive subagents wave 2: automatic context
  // compaction starts before the first real model call and reports its
  // lifecycle as assistant-role `compaction*` markers in the turn stream.
  // They are runtime maintenance, not model steps — with `--max-steps 1` the
  // real answer must still be accepted instead of being refused as
  // `limit_exceeded` with the turn aborted.
  it('does not let automatic compaction markers consume the --max-steps budget', async () => {
    const compactionRuntime = createRuntime(async function* () {
      yield {
        type: 'message',
        message: { id: 'compaction-1', role: 'assistant', kind: 'compaction_start', content: '' },
      } as const;
      yield {
        type: 'message',
        message: { id: 'answer-1', role: 'assistant', content: 'LOCAL_BYOK_OK' },
      } as const;
      yield { type: 'done' } as const;
    });
    await expect(
      new TuiRunCoordinator(compactionRuntime).execute({
        ...request('turn-compaction'),
        policy: { maxSteps: 1 },
      }),
    ).resolves.toMatchObject({ status: 'succeeded', outcome: { answer: 'LOCAL_BYOK_OK' } });
    expect(compactionRuntime.abortSession).not.toHaveBeenCalled();

    // The budget still counts real model steps: with maxSteps 1 a second real
    // answer is refused exactly as before the fix.
    const limitRuntime = createRuntime(async function* () {
      yield {
        type: 'message',
        message: { id: 'compaction-1', role: 'assistant', kind: 'compaction_start', content: '' },
      } as const;
      yield { type: 'message', message: { role: 'assistant', content: 'first' } } as const;
      yield { type: 'message', message: { role: 'assistant', content: 'second' } } as const;
    });
    await expect(
      new TuiRunCoordinator(limitRuntime).execute({
        ...request('turn-compaction-limit'),
        policy: { maxSteps: 1 },
      }),
    ).resolves.toMatchObject({ status: 'limit_exceeded', outcome: { answer: 'first' } });
    expect(limitRuntime.abortSession).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'max_steps' }),
    );
  });

  it('fires timeouts above the Node timer limit only at the requested deadline', async () => {
    vi.useFakeTimers();
    try {
      const timeoutRuntime = createRuntime(async function* pendingTimeout(_req, signal) {
        yield* [];
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
      });
      // 200 ms beyond Node's 32-bit timer limit; a plain setTimeout would
      // clamp this to 1 ms and cancel the run almost immediately.
      const timed = new TuiRunCoordinator(timeoutRuntime, { nowMs: () => 1_000 }).execute({
        ...request('turn-timeout-overflow'),
        policy: { timeoutMs: 2_147_483_847 },
      });
      expect(timeoutRuntime.abortSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(timeoutRuntime.abortSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      await expect(timed).resolves.toMatchObject({ status: 'timeout' });
      expect(timeoutRuntime.abortSession).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'timeout' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a Runtime questionnaire as awaiting continuation without aborting it', async () => {
    const runtime = createRuntime(async function* () {
      yield {
        type: 'generic',
        eventType: 'runtime.action-required',
        data: { kind: 'questionnaire' },
      } as const;
    });

    await expect(
      new TuiRunCoordinator(runtime).execute(request('turn-questionnaire')),
    ).resolves.toMatchObject({
      status: 'awaiting-user-continuation',
      outcome: { error: { code: 'QUESTIONNAIRE_REQUIRED' } },
    });
    expect(runtime.abortSession).not.toHaveBeenCalled();
  });

  it.each(['questionnaire.dismiss', 'questionnaire.superseded'])(
    'does not mistake %s for a new continuation', async (eventType) => {
      const runtime = createRuntime(async function* () {
        yield { type: 'generic', eventType, data: { requestId: 'old-ask' } } as const;
        yield { type: 'message', message: { role: 'assistant', content: 'Final answer' } } as const;
        yield { type: 'done' } as const;
      });
      await expect(new TuiRunCoordinator(runtime).execute(request('turn-after-dismiss')))
        .resolves.toMatchObject({ status: 'succeeded', outcome: { answer: 'Final answer' } });
    },
  );

  it('leaves permission interaction ownership to the active surface', async () => {
    const runtime = createRuntime(async function* () {
      yield {
        type: 'generic',
        eventType: 'permission.ask',
        data: { requestId: 'permission-1' },
      } as const;
      yield {
        type: 'message',
        message: { id: 'answer-1', role: 'assistant', content: 'continued' },
      } as const;
      yield { type: 'done' } as const;
    });
    const observed: string[] = [];

    await expect(
      new TuiRunCoordinator(runtime).execute(request('turn-permission'), (event) =>
        observed.push(event.type === 'generic' ? event.eventType : event.type),
      ),
    ).resolves.toMatchObject({
      status: 'succeeded',
      outcome: { answer: 'continued' },
    });
    expect(observed).toEqual(['permission.ask', 'message', 'done']);
    expect(runtime.abortSession).not.toHaveBeenCalled();
  });

  it('fails a Headless execution that completes without a final assistant response', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'session-status', status: 'finished' } as const;
      yield { type: 'done' } as const;
    });

    await expect(
      new TuiRunCoordinator(runtime).execute({
        ...request('turn-empty'),
        policy: { requireAnswer: true },
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      outcome: { error: { code: 'EMPTY_RESPONSE' } },
    });
  });

  it.each(['message', 'delta'] as const)(
    'keeps a quickly answered questionnaire as a continuation from its %s tool result',
    async (type) => {
      const toolCalls = [{
        name: 'ask_user', status: 2,
        output: { details: { request_id: 'ask-fast', waiting_for_user: true } },
      }];
      const runtime = {
        ...createRuntime(async function* (): AsyncGenerator<TuiStreamEvent> {
          yield type === 'message'
            ? { type, message: { role: 'assistant', turnId: 'turn-fast', toolCalls } }
            : { type, turnId: 'turn-fast', toolCalls };
          yield { type: 'done' };
        }),
        getPendingQuestionnaire: vi.fn(async () => undefined),
      };
      await expect(new TuiRunCoordinator(runtime).execute({
        ...request('turn-fast'), policy: { requireAnswer: true },
      })).resolves.toMatchObject({
        status: 'awaiting-user-continuation',
        outcome: { error: { code: 'QUESTIONNAIRE_REQUIRED' } },
      });
    },
  );

  it.each([
    { waiting: false, owner: 'turn-empty', status: 2 },
    { waiting: true, owner: 'turn-old', status: 2 },
    { waiting: true, owner: 'turn-empty', status: 3 },
  ])('does not hide an empty response behind an unowned or suppressed tool result %j', async (test) => {
    const runtime = createRuntime(async function* (): AsyncGenerator<TuiStreamEvent> {
      yield {
        type: 'delta', turnId: test.owner,
        toolCalls: [{ name: 'ask_user', status: test.status, output: { details: { waiting_for_user: test.waiting } } }],
      };
      yield { type: 'done' };
    });
    await expect(new TuiRunCoordinator(runtime).execute({
      ...request('turn-empty'), policy: { requireAnswer: true },
    })).resolves.toMatchObject({ status: 'failed', outcome: { error: { code: 'EMPTY_RESPONSE' } } });
  });

  it('accepts a final assistant response delivered only as text deltas', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'delta', role: 'assistant', content: 'delta ' } as const;
      yield { type: 'delta', role: 'assistant', content: 'answer' } as const;
      yield { type: 'session-status', status: 'finished' } as const;
      yield { type: 'done' } as const;
    });

    await expect(
      new TuiRunCoordinator(runtime).execute({
        ...request('turn-delta-answer'),
        policy: { requireAnswer: true },
      }),
    ).resolves.toMatchObject({
      status: 'succeeded',
      outcome: { answer: 'delta answer' },
    });
  });

  it('records answer selection and replacement without storing the answer', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'message', message: { id: 'pre-tool', role: 'assistant', content: 'private prelude',
        toolCalls: [{ id: 'tool-1', name: 'read', status: 2 }],
      } } as const;
      yield { type: 'message', message: { id: 'final-1', role: 'assistant', content: 'private completed' } } as const;
      yield { type: 'delta', role: 'assistant', content: 'private trailing draft' } as const;
      yield { type: 'done' } as const;
    });
    const selected = vi.fn();
    const result = await new TuiRunCoordinator(runtime, { onAnswerSelection: selected }).execute(request('selection'));
    expect(result.outcome.answer).toBe('private trailing draft');
    expect(selected.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ kind: 'answer_excluded', messageId: 'pre-tool', reason: 'tool_calls' }),
      expect.objectContaining({ kind: 'answer_selected', messageId: 'final-1', answerSource: 'completed_message' }),
      expect.objectContaining({ kind: 'answer_selected', answerSource: 'trailing_draft', replacedAnswer: true }),
    ]);
    expect(JSON.stringify(selected.mock.calls)).not.toContain('private');
  });

  it('keeps streamed final text when the completion event has an empty content field', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'delta', role: 'assistant', content: 'streamed answer' } as const;
      yield {
        type: 'message',
        message: { role: 'assistant', kind: 'final', content: '' },
      } as const;
      yield { type: 'done' } as const;
    });

    await expect(
      new TuiRunCoordinator(runtime).execute({
        ...request('turn-empty-completion'),
        policy: { requireAnswer: true },
      }),
    ).resolves.toMatchObject({
      status: 'succeeded',
      outcome: { answer: 'streamed answer' },
    });
  });

  it('publishes only the final assistant response after a tool call', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'delta', role: 'assistant', content: 'I will inspect it.' } as const;
      yield {
        type: 'message',
        message: {
          role: 'assistant',
          content: 'I will inspect it.',
          toolCalls: [{ id: 'read-1', name: 'read', status: 'completed' }],
        },
      } as const;
      yield { type: 'delta', role: 'assistant', content: 'The final answer.' } as const;
      yield {
        type: 'message',
        message: { role: 'assistant', kind: 'final', content: 'The final answer.' },
      } as const;
      yield { type: 'done' } as const;
    });
    const onOutcome = vi.fn();

    await expect(
      new TuiRunCoordinator(runtime).execute(
        { ...request('turn-tool-final'), policy: { requireAnswer: true } },
        undefined,
        undefined,
        onOutcome,
      ),
    ).resolves.toMatchObject({
      status: 'succeeded',
      outcome: { answer: 'The final answer.' },
    });
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', answer: 'The final answer.' }),
    );
  });

  it('fails automation when a tool call has no final assistant response', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'delta', role: 'assistant', content: 'I will inspect it.' } as const;
      yield {
        type: 'message',
        message: {
          role: 'assistant',
          content: 'I will inspect it.',
          toolCalls: [{ id: 'read-1', name: 'read', status: 'completed' }],
        },
      } as const;
      yield { type: 'done' } as const;
    });
    const onOutcome = vi.fn();

    await expect(
      new TuiRunCoordinator(runtime).execute(
        { ...request('turn-tool-empty'), policy: { requireAnswer: true } },
        undefined,
        undefined,
        onOutcome,
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      outcome: { answer: null, error: { code: 'EMPTY_RESPONSE' } },
    });
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'EMPTY_RESPONSE' }),
      }),
    );
  });

  it('turns an automation result write failure into a turn failure', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'message', message: { role: 'assistant', content: 'answer' } } as const;
      yield { type: 'done' } as const;
    });

    await expect(
      new TuiRunCoordinator(runtime).execute(
        request('turn-write-failed'),
        undefined,
        undefined,
        async () => {
          throw new Error('disk full');
        },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      outcome: { error: { code: 'AUTOMATION_RESULT_WRITE_FAILED' } },
    });
  });

  // --- Wave 2 (incident 2026-11-05, verdict §2.2б): the sawTerminal net ---

  it('reports TURN_DETACHED when the source ends without its terminal done marker', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'delta', role: 'assistant', content: 'Let me ' } as const;
      yield { type: 'delta', role: 'assistant', content: 'check…' } as const;
      // The window closed mid-turn: no `done` ever arrived.
    });
    const observed: string[] = [];

    await expect(
      new TuiRunCoordinator(runtime).execute(request('turn-detached'), (event) =>
        observed.push(event.type),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      outcome: {
        status: 'failed',
        answer: null,
        error: {
          category: 'runtime',
          code: 'TURN_DETACHED',
          message:
            'The turn window closed before the turn ended; the turn may still be running.',
          retryable: true,
        },
      },
    });
    expect(observed).toEqual(['delta', 'delta']);
    expect(runtime.abortSession).not.toHaveBeenCalled();
  });

  it('maps a thrown TurnStreamDetached to the same TURN_DETACHED code with the reason', async () => {
    const { TurnStreamDetached } = await import('../../src/runtime/remote-host.js');
    const runtime = createRuntime(async function* () {
      yield { type: 'delta', role: 'assistant', content: 'partial' } as const;
      throw new TurnStreamDetached({ sessionId: 'session-1', turnId: 'turn-thrown-detached', reason: 'error', attempts: 3 });
    });

    await expect(new TuiRunCoordinator(runtime).execute(request('turn-thrown-detached'))).resolves.toMatchObject({
      status: 'failed',
      outcome: {
        error: {
          category: 'runtime',
          code: 'TURN_DETACHED',
          message:
            'The turn window closed before the turn ended; the turn may still be running. ' +
            '(reason: error, attempts: 3)',
          retryable: true,
        },
      },
    });
  });

  it('keeps a real in-band failure when the turn ends with done after an error event', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'error', message: 'the provider exploded' } as const;
      yield { type: 'done' } as const;
    });

    await expect(new TuiRunCoordinator(runtime).execute(request('turn-error-done'))).resolves.toMatchObject({
      status: 'failed',
      outcome: {
        error: { category: 'runtime', message: 'the provider exploded', retryable: true },
      },
    });
  });

  it('keeps an aborted session-status outcome over the TURN_DETACHED net', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'session-status', status: 'aborted' } as const;
      // An aborted turn's window can end without [DONE] (the detach path).
    });

    await expect(new TuiRunCoordinator(runtime).execute(request('turn-aborted-status'))).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('maps a Runtime rewind during Headless execution to a content-review block', async () => {
    const runtime = createRuntime(async function* () {
      yield { type: 'generic', eventType: 'messages-rewound', data: {} } as const;
      yield { type: 'session-status', status: 'finished' } as const;
      yield { type: 'done' } as const;
    });

    await expect(
      new TuiRunCoordinator(runtime).execute(request('turn-content-blocked')),
    ).resolves.toMatchObject({
      status: 'failed',
      outcome: { error: { code: 'CONTENT_REVIEW_BLOCKED' } },
    });
  });
});

function request(turnId: string) {
  return {
    turnId,
    session: Promise.resolve({ sessionId: 'session-1' }),
    content: 'Continue',
    workspace: '/repo',
    version: 'test',
  };
}

function createRuntime(send: TuiRunRuntime['sendMessage']): TuiRunRuntime & {
  sendMessage: ReturnType<typeof vi.fn<TuiRunRuntime['sendMessage']>>;
  abortSession: ReturnType<typeof vi.fn<TuiRunRuntime['abortSession']>>;
} {
  return {
    sendMessage: vi.fn(send),
    abortSession: vi.fn(async () => true),
  };
}
