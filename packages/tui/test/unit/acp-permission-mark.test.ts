/**
 * §4 ACP projection pins (TuiAcpUpdateProjector + stream-events parse):
 *
 *   - 4.1 mark-shape-all-keys: the `_meta["minimax-code/permission"]` value
 *     on `tool_call` / `tool_call_update` always carries exactly the five
 *     wire keys with a non-empty reason;
 *   - 4.3 mark-rides-existing-updates: the mark rides the ALREADY-EMITTED
 *     tool_call / tool_call_update messages — the number of session updates
 *     per call is identical with and without the feature;
 *   - 4.4 denied-call: a failed update carries the mark (the call never
 *     stays pending);
 *   - 4.5 mark-survives-replay: replayed messages (messages-replaced /
 *     message events) keep the mark.
 *
 * The runtime halves (mark production at the gate, stamping on status
 * chunks) are pinned in local-runtime-v2 and agent-core respectively.
 */

import { describe, expect, it } from 'vitest';

import { TuiAcpUpdateProjector } from '../../src/acp/updates.js';
import type { TuiToolCall } from '../../src/runtime/stream-events.js';

const MARK: NonNullable<TuiToolCall['permission']> = {
  decision: 'allow',
  decidedBy: 'rule',
  ruleKind: 'builtin',
  mode: 'default',
  reason: 'Safe bash command',
};

const DENY_MARK: NonNullable<TuiToolCall['permission']> = {
  decision: 'deny',
  decidedBy: 'user',
  ruleKind: null,
  mode: 'default',
  reason: 'reject_once',
};

function markKeys(update: { _meta?: Record<string, unknown> }): string[] {
  const mark = update._meta?.['minimax-code/permission'];
  expect(mark).toBeDefined();
  expect(typeof (mark as { reason: unknown }).reason).toBe('string');
  expect(String((mark as { reason: unknown }).reason).trim().length).toBeGreaterThan(0);
  return Object.keys(mark as object).sort();
}

const ALL_MARK_KEYS = ['decision', 'decidedBy', 'mode', 'reason', 'ruleKind'].sort();

describe('TuiAcpUpdateProjector §4 permission marks', () => {
  it('mark-rides-existing-updates: identical update count with and without the mark', () => {
    const plain = new TuiAcpUpdateProjector();
    const marked = new TuiAcpUpdateProjector();
    const statuses = ['started', 'completed'] as const;
    const plainUpdates = statuses.flatMap((status) =>
      plain.project({
        type: 'delta',
        toolCalls: [
          {
            id: 'call-1',
            name: 'bash',
            status,
            input: { command: 'pnpm test' },
          },
        ],
      }),
    );
    const markedUpdates = statuses.flatMap((status) =>
      marked.project({
        type: 'delta',
        toolCalls: [
          {
            id: 'call-1',
            name: 'bash',
            status,
            input: { command: 'pnpm test' },
            permission: MARK,
          },
        ],
      }),
    );
    expect(markedUpdates.length).toBe(plainUpdates.length);
    expect(plainUpdates.map((update) => update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
    ]);
    // 4.1: every marked update carries exactly the five keys.
    for (const update of markedUpdates) expect(markKeys(update)).toEqual(ALL_MARK_KEYS);
    if (markedUpdates[0]?.sessionUpdate !== 'tool_call') throw new Error('expected tool_call');
    if (markedUpdates[1]?.sessionUpdate !== 'tool_call_update') {
      throw new Error('expected tool_call_update');
    }
    expect(markedUpdates[0]._meta?.['minimax-code/permission']).toEqual(MARK);
    expect(markedUpdates[1]._meta?.['minimax-code/permission']).toEqual(MARK);
    for (const update of plainUpdates) expect(update._meta).toBeUndefined();
  });

  it('denied-call: the failed tool_call_update carries the deny mark', () => {
    const projector = new TuiAcpUpdateProjector();
    const updates = [
      ...projector.project({
        type: 'delta',
        toolCalls: [
          {
            id: 'call-deny',
            name: 'bash',
            status: 'started',
            input: { command: 'rm -rf /' },
            permission: DENY_MARK,
          },
        ],
      }),
      ...projector.project({
        type: 'delta',
        toolCalls: [
          {
            id: 'call-deny',
            name: 'bash',
            status: 'failed',
            error: 'Permission denied',
            permission: DENY_MARK,
          },
        ],
      }),
    ];
    expect(updates.length).toBe(2);
    const failed = updates[1];
    if (failed?.sessionUpdate !== 'tool_call_update') throw new Error('expected update');
    expect(failed.status).toBe('failed');
    expect(markKeys(failed)).toEqual(ALL_MARK_KEYS);
    expect(failed._meta?.['minimax-code/permission']).toEqual(DENY_MARK);
  });

  it('mark-survives-replay: replayed assistant messages keep the mark on tool_call', () => {
    const projector = new TuiAcpUpdateProjector();
    const updates = projector.project({
      type: 'messages-replaced',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          toolCalls: [
            {
              id: 'call-replay',
              name: 'bash',
              status: 'completed',
              input: { command: 'pnpm test' },
              output: 'ok',
              permission: MARK,
            },
          ],
        },
      ],
    });
    expect(updates.length).toBe(1);
    if (updates[0]?.sessionUpdate !== 'tool_call') throw new Error('expected tool_call');
    expect(updates[0].status).toBe('completed');
    expect(markKeys(updates[0])).toEqual(ALL_MARK_KEYS);
    expect(updates[0]._meta?.['minimax-code/permission']).toEqual(MARK);
  });

  it('keeps parentToolCallId alongside the permission mark in _meta', () => {
    const projector = new TuiAcpUpdateProjector();
    const [update] = projector.project({
      type: 'delta',
      toolCalls: [
        {
          id: 'call-nested',
          name: 'edit',
          status: 'started',
          input: { path: '/workspace/a.ts' },
          parentToolCallId: 'run-code-1',
          permission: MARK,
        },
      ],
    });
    if (update?.sessionUpdate !== 'tool_call') throw new Error('expected tool_call');
    expect(update._meta).toEqual({
      'minimax-code/parentToolCallId': 'run-code-1',
      'minimax-code/permission': MARK,
    });
  });

  it('parses the mark off the wire tool_call record (stream-events normalizeToolCalls)', async () => {
    const { projectTuiSessionStreamFrame } = await import('../../src/runtime/stream-events.js');
    const frame = {
      dataJson: JSON.stringify({
        type: 6,
        agent_message_chunk: {
          msg_id: 'm1',
          role: 'assistant',
          tool_calls: [
            {
              tool_name: 'bash',
              tool_call_id: 'call-wire',
              tool_call_status: 2,
              tool_call_args: '{"command":"pnpm test"}',
              permission: MARK,
            },
          ],
        },
      }),
    };
    const event = projectTuiSessionStreamFrame(frame as never);
    if (event?.type !== 'delta') throw new Error('expected delta');
    expect(event.toolCalls?.[0]?.permission).toEqual(MARK);
  });

  it('drops malformed permission payloads instead of forwarding partial marks', async () => {
    const { projectTuiSessionStreamFrame } = await import('../../src/runtime/stream-events.js');
    for (const malformed of [
      undefined,
      null,
      { decision: 'allow' },
      { decision: 'allow', decidedBy: 'nope', ruleKind: null, mode: 'default', reason: 'x' },
      { decision: 'allow', decidedBy: 'rule', ruleKind: null, mode: 'default', reason: '  ' },
    ]) {
      const frame = {
        dataJson: JSON.stringify({
          type: 6,
          agent_message_chunk: {
            msg_id: 'm1',
            role: 'assistant',
            tool_calls: [
              {
                tool_name: 'bash',
                tool_call_id: 'call-bad',
                tool_call_status: 2,
                permission: malformed,
              },
            ],
          },
        }),
      };
      const event = projectTuiSessionStreamFrame(frame as never);
      if (event?.type !== 'delta') throw new Error('expected delta');
      expect(event.toolCalls?.[0]?.permission).toBeUndefined();
    }
  });
});
