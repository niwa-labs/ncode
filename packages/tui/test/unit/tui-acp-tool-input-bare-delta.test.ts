import { describe, expect, it } from 'vitest';

import { TuiAcpUpdateProjector } from '../../src/acp/updates.js';

/**
 * Incident 2026-11-15: the run ring of an ACP integrator (kagero) pinned
 * `bash` with no command for the whole live run. The first tool_call
 * notification was emitted from a STREAMING delta — the tool's arguments are
 * assembled only by execution start — so the wire carried a bare call and the
 * context-carrying correction rode a tool_call_update the ring never reads.
 */
describe('TuiAcpUpdateProjector — bare streaming deltas', () => {
  it('suppresses a non-terminal delta without input and emits the start with its input', () => {
    const projector = new TuiAcpUpdateProjector();

    const bare = projector.project({
      type: 'delta',
      toolCalls: [{ id: 'call-1', name: 'bash', status: 'preparing' }],
    });
    expect(bare).toHaveLength(0);

    const started = projector.project({
      type: 'delta',
      toolCalls: [
        {
          id: 'call-1',
          name: 'bash',
          status: 'started',
          input: { command: 'pnpm test' },
        },
      ],
    });
    expect(started).toHaveLength(1);
    if (started[0]?.sessionUpdate !== 'tool_call') {
      throw new Error(`expected tool_call, got ${started[0]?.sessionUpdate}`);
    }
    expect(started[0]).toMatchObject({
      rawInput: { command: 'pnpm test' },
      toolCallId: started[0].toolCallId,
    });
  });

  it('always surfaces terminal outcomes, even without input', () => {
    const projector = new TuiAcpUpdateProjector();
    const failed = projector.project({
      type: 'delta',
      toolCalls: [{ id: 'call-x', name: 'bash', status: 'failed', error: 'boom' }],
    });
    expect(failed).toHaveLength(1);
    if (failed[0]?.sessionUpdate !== 'tool_call') {
      throw new Error(`expected tool_call, got ${failed[0]?.sessionUpdate}`);
    }
    expect(failed[0]).toMatchObject({ status: 'failed' });
  });

  it('does not suppress anonymous (id-less) calls — they cannot be superseded', () => {
    const projector = new TuiAcpUpdateProjector();
    const anonymous = projector.project({
      type: 'delta',
      toolCalls: [{ name: 'bash', status: 'preparing' }],
    });
    expect(anonymous.length).toBeGreaterThan(0);
  });
});
