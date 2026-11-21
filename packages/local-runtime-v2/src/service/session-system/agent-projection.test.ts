import { describe, expect, it, vi } from 'vitest';
import { createSessionSystemAgentProjection } from './agent-projection.js';

function setup() {
  const upsert = vi.fn(async (_input: { message: Record<string, unknown> }) => undefined);
  const handle = vi.fn(async () => undefined);
  const projection = createSessionSystemAgentProjection({
    messages: { upsert },
    stream: { write: vi.fn() },
    compactionFacts: { handle },
    nowMs: () => 100,
  } as never);
  const context = {
    sessionId: 'short-session',
    turnId: 'manual-compact',
    turnSequence: 1,
    agentName: 'mavis',
  } as never;
  const base = { context, attemptId: 'attempt-1' };
  const completed = {
    ...base,
    status: 'completed' as const,
    compactionId: 'checkpoint-1',
    messagesBefore: 6,
    messagesAfter: 2,
    tokensBefore: 152,
    tokensAfter: 23,
  };
  return { upsert, handle, projection, base, completed };
}

describe('compaction display completion', () => {
  it('settles the saved running row after a unified checkpoint commits', async () => {
    const { projection, upsert, handle, base, completed } = setup();
    await projection.compactionObserver.observe({ ...base, status: 'started', reason: 'manual' });
    await projection.compactionObserver.observe(completed);
    expect(upsert.mock.calls.map(([input]) => input.message.kind)).toEqual([
      'compaction_start',
      'compaction',
    ]);
    expect(upsert.mock.calls[1]?.[0]).toMatchObject({
      message: {
        msg_id: 'compaction-attempt-1',
        kind: 'compaction',
        metadata: { tokensBefore: 152, tokensAfter: 23 },
      },
    });
    expect(handle).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'completed' }));
  });

  it('preserves the richer display fact already written by legacy committed-history completion', async () => {
    const { projection, upsert, base, completed } = setup();
    await projection.compactionObserver.observe({ ...base, status: 'started', reason: 'manual' });
    await projection.compactionLifecycle.completeCommittedHistory({
      ...base,
      operationId: 'operation',
      committedRevision: 'revision',
      metadata: { preserved: true },
    });
    await projection.compactionObserver.observe(completed);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1]?.[0]).toMatchObject({
      message: {
        committedRevision: 'revision',
        operationId: 'operation',
        metadata: { preserved: true },
      },
    });
  });
});
