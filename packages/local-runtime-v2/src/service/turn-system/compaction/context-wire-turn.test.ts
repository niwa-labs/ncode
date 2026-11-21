import { describe, expect, it } from 'vitest';

import {
  createTurnContextWire,
  resolveContextWireEnabled,
  type ContextWireCommitInput,
} from './context-wire.js';
import type { CanonicalHistoryMessage } from '../agent-host/history/contracts.js';

/** Pi-shaped canonical messages, exactly what the executor's history hook sees. */
function userMessage(text: string, timestamp: number): CanonicalHistoryMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp,
  } as unknown as CanonicalHistoryMessage;
}

function assistantWithToolCall(timestamp: number): CanonicalHistoryMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'ищу файлы' },
      { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
    ],
    timestamp,
  } as unknown as CanonicalHistoryMessage;
}

function toolResultMessage(timestamp: number): CanonicalHistoryMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'README.md' }],
    isError: false,
    timestamp,
  } as unknown as CanonicalHistoryMessage;
}

function delta(
  sessionId: string,
  messages: readonly CanonicalHistoryMessage[],
): ContextWireCommitInput {
  return { sessionId, reason: 'messageDelta', messages };
}

describe('resolveContextWireEnabled (Ш4 env gate)', () => {
  // W10 hybrid default: unset FOLLOWS the canonical-history mode — durable
  // (the W10 default) turns the wire path ON; the explicit `jsonl`
  // compatibility mode keeps it OFF. Explicit values always win.
  it('follows the durable default when unset; explicit falsy values stay OFF (compatibility)', () => {
    expect(resolveContextWireEnabled({})).toBe(true);
    expect(
      resolveContextWireEnabled({
        MCODE_HISTORY_PROVIDER: 'jsonl',
      }),
    ).toBe(false);
    expect(resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: '' })).toBe(true);
    expect(resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: '0' })).toBe(false);
    expect(resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: 'false' })).toBe(false);
    expect(resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: 'off' })).toBe(false);
  });

  it('turns ON for the explicit enabling values (also in jsonl compatibility mode)', () => {
    expect(resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: '1' })).toBe(true);
    expect(resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: 'true' })).toBe(true);
    expect(resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: 'ON' })).toBe(true);
    expect(resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: ' on ' })).toBe(true);
    expect(
      resolveContextWireEnabled({
        MCODE_HISTORY_PROVIDER: 'jsonl',
        MCODE_CONTEXT_WIRE: '1',
      }),
    ).toBe(true);
  });

  it('fails closed on unknown values instead of guessing', () => {
    expect(() => resolveContextWireEnabled({ MCODE_CONTEXT_WIRE: 'sure' })).toThrowError(
      /Unsupported MCODE_CONTEXT_WIRE/,
    );
  });
});

describe('createTurnContextWire (Ш4 turn-path bridge)', () => {
  const sessionId = 'session-wire-test';

  it('keeps persisted reminders before their settlement and later owner input', () => {
    const wire = createTurnContextWire();
    const oldTodo = '<system-reminder>8 active todos: finish before delivery</system-reminder>';
    const oldBackground = '<system-reminder>3 unread background tasks: read before delivery</system-reminder>';
    const messages = [
      userMessage(`initial task\n${oldTodo}`, 1),
      { role: 'custom', customType: 'background_task_cadence_reminder', content: oldBackground, display: false, timestamp: 2 },
      assistantWithToolCall(3),
      toolResultMessage(4),
      userMessage('Tasks finished and results read. Stop checking and answer.', 5),
    ] as CanonicalHistoryMessage[];
    wire.seed({ sessionId, messages });
    const before = wire.projection(sessionId)!.project()!.records;
    expect(before.map((record) => record.text)).toEqual([
      `initial task\n${oldTodo}`, oldBackground, 'ищу файлы', 'README.md',
      'Tasks finished and results read. Stop checking and answer.',
    ]);
    expect(before.map((record) => record.sourceIndexes)).toEqual([[0], [1], [2], [3], [4]]);

    wire.observeCommit(delta(sessionId, [userMessage('Only give the file path.', 6)]));
    const after = wire.projection(sessionId)!.project()!.records;
    // Appending a new request preserves every already compiled prefix byte.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)?.text).toBe('Only give the file path.');
    const cold = createTurnContextWire();
    cold.seed({ sessionId, messages: [...messages, userMessage('Only give the file path.', 6)] });
    expect(cold.projection(sessionId)!.project()!.records).toEqual(after);
  });

  it('projects the seeded history and every fed commit in payload order', () => {
    const wire = createTurnContextWire();
    wire.seed({
      sessionId,
      messages: [userMessage('привет', 1), assistantWithToolCall(2), toolResultMessage(3)],
    });
    const projection = wire.projection(sessionId);
    expect(projection).toBeDefined();
    const first = projection!.project();
    expect(first).toBeDefined();
    expect(first!.records.map((record) => record.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(first!.records[0]?.text).toBe('привет');
    expect(first!.records[0]?.timestamp).toBe(1);
    expect(first!.records[1]?.text).toBe('ищу файлы');
    expect(first!.records[1]?.toolCalls?.[0]).toMatchObject({
      id: 'call_1',
      name: 'bash',
      arguments: JSON.stringify({ command: 'ls' }),
    });
    expect(first!.records[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'bash',
      text: 'README.md',
      isError: false,
    });
    expect(first!.totalBytes).toBeGreaterThan(0);

    // A committed delta reaches the window before the next request.
    wire.observeCommit(delta(sessionId, [userMessage('а теперь?', 4)]));
    const second = projection.project();
    expect(second!.records.map((record) => record.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'user',
    ]);
    expect(second!.records[3]?.text).toBe('а теперь?');
    expect(second!.records[3]?.timestamp).toBe(4);
  });

  it('serves identical records on repeated prepares (the memoized warm path)', () => {
    const wire = createTurnContextWire();
    wire.seed({
      sessionId,
      messages: [userMessage('привет', 1), assistantWithToolCall(2), toolResultMessage(3)],
    });
    const projection = wire.projection(sessionId)!;
    const first = projection.project();
    const second = projection.project();
    expect(second).toEqual(first);
    // Wire identities are content-stable, so even a re-seeded handle serves
    // the same compiled bytes for the same window.
    const reseeded = createTurnContextWire();
    reseeded.seed({
      sessionId,
      messages: [userMessage('привет', 1), assistantWithToolCall(2), toolResultMessage(3)],
    });
    expect(reseeded.projection(sessionId)!.project()).toEqual(first);
  });

  it('rebuilds the window on a replaceMessages commit instead of appending', () => {
    const wire = createTurnContextWire();
    wire.seed({
      sessionId,
      messages: [userMessage('привет', 1), assistantWithToolCall(2), toolResultMessage(3)],
    });
    // An already-resolved projection must follow the replacement: the port
    // closes over the session, never over one replaced state.
    const projection = wire.projection(sessionId)!;
    const compacted: readonly CanonicalHistoryMessage[] = [
      userMessage('резюме диалога', 10),
      userMessage('вопрос после компакции', 11),
    ];
    wire.observeCommit({ sessionId, reason: 'replaceMessages', messages: compacted });
    const prepared = projection.project();
    expect(prepared!.records.map((record) => record.text)).toEqual([
      'резюме диалога',
      'вопрос после компакции',
    ]);
    expect(wire.entryCount(sessionId)).toBe(2);
  });

  it('degrades a stale session to legacy (undefined) and heals on the next seed', () => {
    const wire = createTurnContextWire();
    wire.seed({ sessionId, messages: [userMessage('привет', 1)] });
    expect(wire.projection(sessionId)!.project()).toBeDefined();

    // A mid-turn output recall rewound history outside the wire view.
    wire.markStale(sessionId);
    expect(wire.projection(sessionId)).toBeUndefined();
    expect(wire.projection(sessionId)?.project()).toBeUndefined();

    // The next turn preparation rebuilds from scratch.
    wire.seed({ sessionId, messages: [userMessage('привет', 1)] });
    expect(wire.projection(sessionId)!.project()).toBeDefined();
  });

  it('ignores commits for unknown or stale sessions instead of folding blind', () => {
    const wire = createTurnContextWire();
    expect(() =>
      wire.observeCommit(delta('session-unknown', [userMessage('сирота', 1)])),
    ).not.toThrow();
    expect(wire.entryCount('session-unknown')).toBe(0);

    wire.seed({ sessionId, messages: [userMessage('привет', 1)] });
    wire.markStale(sessionId);
    expect(() => wire.observeCommit(delta(sessionId, [userMessage('после stale', 2)]))).not.toThrow();
    // Still stale: the next seed rebuilds, never the blind fold.
    expect(wire.projection(sessionId)).toBeUndefined();
  });

  it('maps the legacy compaction summary onto a user text record', () => {
    const wire = createTurnContextWire();
    wire.seed({
      sessionId,
      messages: [
        {
          role: 'compactionSummary',
          summary: 'было длинное диалоговое окно',
        } as unknown as CanonicalHistoryMessage,
        userMessage('вопрос', 2),
      ],
    });
    const prepared = wire.projection(sessionId)!.project();
    expect(prepared!.records[0]).toMatchObject({ role: 'user', text: 'было длинное диалоговое окно' });
  });
});
