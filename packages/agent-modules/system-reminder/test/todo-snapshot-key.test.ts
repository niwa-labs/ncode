import { describe, expect, it } from 'vitest';

import { todoSnapshotKey } from '../src/todo-state.js';

describe('todoSnapshotKey (M3.1 dupe wave shared comparator)', () => {
  const snapshot = [
    { content: 'poll the background task', status: 'in_progress', priority: 'high' },
    { content: 'report the result', status: 'pending', priority: 'medium' },
  ];

  it('is equal for identical snapshots', () => {
    expect(todoSnapshotKey(snapshot)).toBe(todoSnapshotKey([...snapshot]));
  });

  it('ignores JSON object key order', () => {
    const reordered = snapshot.map((item) => ({
      priority: item.priority,
      status: item.status,
      content: item.content,
    }));
    expect(todoSnapshotKey(snapshot)).toBe(todoSnapshotKey(reordered));
  });

  it('ignores surrounding whitespace differences', () => {
    const padded = snapshot.map((item) => ({
      content: `  ${item.content}  `,
      status: item.status,
      priority: item.priority,
    }));
    expect(todoSnapshotKey(snapshot)).toBe(todoSnapshotKey(padded));
  });

  it('treats a reordered item list as a change (conservative)', () => {
    expect(todoSnapshotKey(snapshot)).not.toBe(todoSnapshotKey([snapshot[1], snapshot[0]]));
  });

  it('treats a status, content or priority change as a change', () => {
    const statusFlip = snapshot.map((item, index) =>
      index === 0 ? { ...item, status: 'completed' } : item,
    );
    expect(todoSnapshotKey(snapshot)).not.toBe(todoSnapshotKey(statusFlip));

    const contentFlip = snapshot.map((item, index) =>
      index === 1 ? { ...item, content: 'ship the report' } : item,
    );
    expect(todoSnapshotKey(snapshot)).not.toBe(todoSnapshotKey(contentFlip));

    const priorityFlip = snapshot.map((item, index) =>
      index === 0 ? { ...item, priority: 'low' } : item,
    );
    expect(todoSnapshotKey(snapshot)).not.toBe(todoSnapshotKey(priorityFlip));
  });

  it('treats added or removed items as a change', () => {
    expect(todoSnapshotKey(snapshot)).not.toBe(todoSnapshotKey(snapshot.slice(0, 1)));
    expect(todoSnapshotKey(snapshot)).not.toBe(
      todoSnapshotKey([
        ...snapshot,
        { content: 'extra item', status: 'pending', priority: 'low' },
      ]),
    );
  });

  it('maps an absent snapshot and an empty list to the same key', () => {
    expect(todoSnapshotKey(undefined)).toBe(todoSnapshotKey([]));
  });
});
