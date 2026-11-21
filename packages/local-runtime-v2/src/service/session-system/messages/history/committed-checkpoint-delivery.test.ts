import { expect, it } from 'vitest';
import {
  replacementEnvelopes,
  compactionReplacementEnvelopes,
  type SessionCanonicalHistoryChange,
} from './canonical-history-provider.js';
const summary = {
  role: 'compactionSummary',
  summary: 'summary',
  timestamp: 1,
  tokensBefore: 100,
  compactionId: 'compact-1',
};
const owner = {
  role: 'user',
  content: [{ type: 'text', text: 'owner input' }],
  timestamp: 2,
};
const existing = [summary, owner].map((message, index) => ({
  message,
  message_id: `id-${index}`,
  turn_id: 't',
}));
const notice = {
  role: 'custom',
  customType: 'notice',
  display: false,
  content: 'current notice',
  timestamp: 3,
};
function change(messages: unknown[]): SessionCanonicalHistoryChange {
  return {
    sessionId: 's',
    turnId: 't',
    reason: 'replaceMessages',
    messages,
    metadata: { committedReplacementId: 'compact-1' },
    operation: { id: 'delivery', kind: 'replace' },
  };
}
it('resolves installed checkpoint identities against current canonical history while inserting a host notice', () => {
  const result = replacementEnvelopes(
    change([structuredClone(summary), notice, structuredClone(owner)]),
    existing,
  );
  expect(result.map((entry) => entry.message_id)).toEqual([
    'id-0',
    expect.any(String),
    'id-1',
  ]);
});
it('rejects duplicated owner input and missing canonical messages', () => {
  expect(() =>
    replacementEnvelopes(change([summary, owner, owner]), existing),
  ).toThrow('only host notices');
  expect(() =>
    replacementEnvelopes(change([summary, notice]), existing),
  ).toThrow('drop canonical messages');
});


it('commits the native section baseline with the summary and re-delivers it without inventing history', () => {
  const baseline = { role: 'system', content: '', sections: { identity: 'stable', project: 'old' }, timestamp: 1 };
  const update = { role: 'system', content: '', sections: { project: 'current' }, timestamp: 2 };
  const active = [baseline, update, owner].map((message, index) => ({ message, message_id: `source-${index}`, turn_id: 't' }));
  const installed = compactionReplacementEnvelopes({
    ...change([summary, owner]), operation: { id: 'compact-native', kind: 'compaction' },
    compactionId: 'compact-1', summary: 'summary', method: 'llm_checkpoint', replacementSourceIndexes: [2],
  }, active);
  expect(installed.map((entry) => entry.message.role)).toEqual(['compactionSummary', 'system', 'user']);
  expect(installed[1].message).toMatchObject({ sections: { identity: 'stable', project: 'current' } });
  expect(installed[2].message_id).toBe('source-2');
  const delivered = replacementEnvelopes(change([...installed.map((entry) => entry.message), notice]), installed);
  expect(delivered.slice(0, 3).map((entry) => entry.message_id)).toEqual(installed.map((entry) => entry.message_id));
});
