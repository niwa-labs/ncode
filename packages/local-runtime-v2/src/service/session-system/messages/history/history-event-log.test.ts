import { describe, expect, it } from 'vitest';

import type { CanonicalHistoryEnvelope } from '../../sessions/representation/canonical-history-contract.js';
import {
  applyFoldBase,
  applyFoldEntry,
  COMPACTION_START_LEASE_MS,
  createEmptyFold,
  EVENT_COMPACTION_END,
  EVENT_COMPACTION_REPLACE,
  EVENT_COMPACTION_START,
  EVENT_COMPACTION_SUMMARY,
  EVENT_OFFLOAD,
  EVENT_REPAIR,
  EVENT_REPLACE_ALL,
  EVENT_TOMBSTONE,
  foldFromCheckpoint,
  materializeFold,
  parseFoldCheckpoint,
  parseHistoryEvent,
  resolveCompactionReplaceRange,
  resolveOpenCompactionLease,
  serializeFoldCheckpoint,
  type CompactionReplaceEvent,
  type SessionFold,
} from './history-event-log.js';

/**
 * Wave 1 unit suite (canon 05 §2.1/§3): the event codec is fail-closed at
 * write and at read, the fold reproduces the active history from the event
 * log with the live-suffix guarantee, the replace plan is validated by
 * properties (never by the "exactly one summary" shape), the open
 * compaction.start carries the 600s lease, and the fold checkpoint is a
 * disposable, exactly-equivalent cache.
 */

function userEnvelope(text: string, index: number): CanonicalHistoryEnvelope {
  return {
    message_id: `msg-user-${String(index)}`,
    turn_id: `turn-${String(index)}`,
    message: { role: 'user', content: text, timestamp: index },
  };
}

function assistantEnvelope(text: string, index: number): CanonicalHistoryEnvelope {
  return {
    message_id: `msg-assistant-${String(index)}`,
    turn_id: `turn-${String(index)}`,
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: index },
  };
}

function toolCallEnvelope(callId: string, index: number): CanonicalHistoryEnvelope {
  return {
    message_id: `msg-call-${callId}`,
    turn_id: `turn-${String(index)}`,
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name: 'read', arguments: {} }],
      timestamp: index,
    },
  };
}

function toolResultEnvelope(callId: string, index: number): CanonicalHistoryEnvelope {
  return {
    message_id: `msg-result-${callId}`,
    turn_id: `turn-${String(index)}`,
    message: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'read',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: index,
    },
  };
}

function summaryEnvelope(text: string, generation: number): CanonicalHistoryEnvelope {
  return {
    message_id: `msg-summary-${String(generation)}`,
    turn_id: 'turn-compaction',
    message: { role: 'compactionSummary', summary: text, tokensBefore: 42_000, timestamp: 100 },
    history_artifact: {
      schemaVersion: 1,
      generation,
      producedBy: 'llm_checkpoint',
      parentSnapshot: { generation: generation - 1, compactionId: 'ctx_x', revision: 'sha256:prev' },
    },
  };
}

function entry(kind: string, payload: unknown, id = `entry-${kind}`): {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
} {
  return { id, kind, payload };
}

function startPayload(compactionId = 'ctx_1'): unknown {
  return {
    kind: EVENT_COMPACTION_START,
    sessionId: 's',
    compactionId,
    baseGeneration: 0,
    coveredUpToSeq: 1,
    writerToken: 'writer-a',
    startedAtMs: 1_000,
  };
}

function endPayload(compactionId = 'ctx_1', outcome = 'committed'): unknown {
  return { kind: EVENT_COMPACTION_END, sessionId: 's', compactionId, outcome };
}

/** Seeds a base of `count` plain envelopes and returns the fold. */
function seededBase(count: number): SessionFold {
  const fold = createEmptyFold();
  applyFoldEntry(
    fold,
    entry(
      'history.v1.full',
      {
        sessionId: 's',
        reason: 'seed',
        envelopes: Array.from({ length: count }, (_, index) => userEnvelope(`u${String(index)}`, index)),
      },
      'entry-seed',
    ),
    1,
  );
  return fold;
}

describe('history event codec (fail-closed at write and read)', () => {
  it('decodes every known event kind and rejects an unknown one', () => {
    expect(parseHistoryEvent(EVENT_COMPACTION_START, startPayload())).toMatchObject({
      compactionId: 'ctx_1',
      baseGeneration: 0,
    });
    expect(() =>
      parseHistoryEvent('history.v2.something-else', { sessionId: 's' }),
    ).toThrowError(/Unknown durable history event kind/);
  });

  it('refuses malformed payloads per kind (missing fields, wrong shapes, empty inserts)', () => {
    expect(() => parseHistoryEvent(EVENT_COMPACTION_START, { sessionId: 's' })).toThrowError(
      /compaction.start/,
    );
    expect(() =>
      parseHistoryEvent(EVENT_COMPACTION_SUMMARY, {
        sessionId: 's',
        compactionId: 'ctx',
        text: '',
        tokensBefore: 1,
      }),
    ).toThrowError(/compaction.summary/);
    expect(() =>
      parseHistoryEvent(EVENT_COMPACTION_END, {
        sessionId: 's',
        compactionId: 'ctx',
        outcome: 'surprised',
      }),
    ).toThrowError(/unknown outcome/);
    expect(() =>
      parseHistoryEvent(EVENT_COMPACTION_REPLACE, {
        sessionId: 's',
        compactionId: 'ctx',
        baseGeneration: 0,
        startSeq: 2,
        endSeq: 1,
        endEnvelopeCount: 0,
        inserted: [summaryEnvelope('x', 1)],
        generation: 1,
        producedBy: 'llm_checkpoint',
        parentSnapshot: { generation: 0, compactionId: 'ctx', revision: 'sha256:r' },
      }),
    ).toThrowError(/inverted seq range/);
    expect(() =>
      parseHistoryEvent(EVENT_COMPACTION_REPLACE, {
        sessionId: 's',
        compactionId: 'ctx',
        baseGeneration: 0,
        startSeq: 1,
        endSeq: 1,
        endEnvelopeCount: 0,
        inserted: [],
        generation: 1,
        producedBy: 'llm_checkpoint',
        parentSnapshot: { generation: 0, compactionId: 'ctx', revision: 'sha256:r' },
      }),
    ).toThrowError(/inserts no envelopes/);
    expect(() =>
      parseHistoryEvent(EVENT_OFFLOAD, { sessionId: 's', seq: 1, blockIdx: 0 }),
    ).toThrowError(/offload/);
    expect(() =>
      parseHistoryEvent(EVENT_REPAIR, {
        sessionId: 's',
        turnId: 't',
        appended: [{ message_id: 'm', turn_id: 't' }],
        generation: 1,
      }),
    ).toThrowError(/repair/);
  });
});

describe('fold: log → active history', () => {
  it('folds base + appends exactly like the legacy rebuild', () => {
    const fold = seededBase(2);
    applyFoldEntry(
      fold,
      entry('history.v1.append', { sessionId: 's', envelopes: [assistantEnvelope('a', 9)] }),
      2,
    );
    expect(materializeFold(fold)).toHaveLength(3);
    expect(fold.headSeq).toBe(2);
    expect(fold.generation).toBe(0);
  });

  it('applies a compaction.replace to its seq range and keeps the live suffix', () => {
    // base(1) + three append segments; the replace covers base+first append.
    const fold = seededBase(2);
    applyFoldEntry(
      fold,
      entry('history.v1.append', { sessionId: 's', envelopes: [userEnvelope('m1', 2)] }),
      2,
    );
    applyFoldEntry(
      fold,
      entry('history.v1.append', { sessionId: 's', envelopes: [userEnvelope('m2', 3)] }),
      3,
    );
    applyFoldEntry(fold, entry(EVENT_COMPACTION_START, startPayload()), 4);
    applyFoldEntry(
      fold,
      entry(EVENT_COMPACTION_SUMMARY, {
        kind: EVENT_COMPACTION_SUMMARY,
        sessionId: 's',
        compactionId: 'ctx_1',
        text: 'summary',
        tokensBefore: 10,
      }),
      5,
    );
    const replace: CompactionReplaceEvent = {
      kind: EVENT_COMPACTION_REPLACE,
      sessionId: 's',
      compactionId: 'ctx_1',
      baseGeneration: 0,
      startSeq: 1,
      endSeq: 2,
      endEnvelopeCount: 1,
      inserted: [summaryEnvelope('summary', 1)],
      generation: 1,
      producedBy: 'llm_checkpoint',
      parentSnapshot: { generation: 0, compactionId: 'ctx_1', revision: 'sha256:r' },
    };
    applyFoldEntry(fold, entry(EVENT_COMPACTION_REPLACE, replace), 6);
    expect(resolveOpenCompactionLease(fold, 'writer-a', 1_001)).toBe('close-committed');
    expect(resolveOpenCompactionLease(fold, 'recovered-writer', 1_001)).toBe('close-committed');
    const active = materializeFold(fold);
    // The covered prefix (base + first append) is replaced by the summary;
    // the second append — the live suffix — survives verbatim.
    expect(active).toEqual([summaryEnvelope('summary', 1), userEnvelope('m2', 3)]);
    expect(fold.generation).toBe(1);
    // The attempt closes only on its end event.
    expect(fold.openCompaction?.compactionId).toBe('ctx_1');
    applyFoldEntry(fold, entry(EVENT_COMPACTION_END, endPayload()), 7);
    expect(fold.openCompaction).toBeUndefined();
  });

  it('fails closed on a replace whose range or start does not resolve', () => {
    const fold = seededBase(2);
    applyFoldEntry(fold, entry(EVENT_COMPACTION_START, startPayload()), 2);
    const base: Omit<CompactionReplaceEvent, 'startSeq' | 'endSeq' | 'endEnvelopeCount'> = {
      kind: EVENT_COMPACTION_REPLACE,
      sessionId: 's',
      compactionId: 'ctx_1',
      baseGeneration: 0,
      inserted: [summaryEnvelope('s', 1)],
      generation: 1,
      producedBy: 'llm_checkpoint',
      parentSnapshot: { generation: 0, compactionId: 'ctx_1', revision: 'sha256:r' },
    };
    expect(() =>
      applyFoldEntry(
        fold,
        entry(EVENT_COMPACTION_REPLACE, { ...base, startSeq: 9, endSeq: 9, endEnvelopeCount: 1 }),
        3,
      ),
    ).toThrowError(/startSeq 9 matches no segment/);
    expect(() =>
      applyFoldEntry(
        fold,
        entry(EVENT_COMPACTION_REPLACE, { ...base, startSeq: 1, endSeq: 7, endEnvelopeCount: 1 }),
        4,
      ),
    ).toThrowError(/endSeq 7 matches no segment/);
    // Without an open start the replace is a corrupt log.
    const orphan = createEmptyFold();
    applyFoldEntry(
      orphan,
      entry('history.v1.full', { sessionId: 's', reason: 'seed', envelopes: [userEnvelope('u', 0)] }, 'seed-orphan'),
      1,
    );
    expect(() =>
      applyFoldEntry(
        orphan,
        entry(EVENT_COMPACTION_REPLACE, { ...base, startSeq: 1, endSeq: 1, endEnvelopeCount: 1 }),
        2,
      ),
    ).toThrowError(/no matching open start/);
  });

  it('grows the generation only on replace/repair/tombstone/adopt — never on appends', () => {
    const fold = seededBase(1);
    applyFoldEntry(
      fold,
      entry('history.v1.append', { sessionId: 's', envelopes: [userEnvelope('x', 1)] }),
      2,
    );
    expect(fold.generation).toBe(0);
    applyFoldEntry(
      fold,
      entry(EVENT_REPAIR, {
        kind: EVENT_REPAIR,
        sessionId: 's',
        turnId: 't',
        appended: [toolResultEnvelope('c1', 2)],
        generation: 1,
      }),
      3,
    );
    expect(fold.generation).toBe(1);
    // A repair event that does not grow the generation is a corrupt log.
    expect(() =>
      applyFoldEntry(
        fold,
        entry(EVENT_REPAIR, {
          kind: EVENT_REPAIR,
          sessionId: 's',
          turnId: 't',
          appended: [],
          generation: 1,
        }),
        4,
      ),
    ).toThrowError(/does not grow the generation/);
    applyFoldEntry(
      fold,
      entry(EVENT_TOMBSTONE, {
        kind: EVENT_TOMBSTONE,
        sessionId: 's',
        generation: 2,
        deletedAtMs: 5,
      }),
      5,
    );
    expect(fold.deleted).toBe(true);
    expect(materializeFold(fold)).toEqual([]);
    // The legacy full|delete behaves the same on old sessions.
    const legacy = seededBase(1);
    applyFoldEntry(legacy, entry('history.v1.full', { sessionId: 's', reason: 'delete', envelopes: [] }), 2);
    expect(legacy.deleted).toBe(true);
    expect(legacy.generation).toBe(1);
  });

  it('applies a repair: truncate an interrupted round, append synthesized outcomes', () => {
    const fold = seededBase(3);
    applyFoldEntry(
      fold,
      entry('history.v1.append', {
        sessionId: 's',
        envelopes: [toolCallEnvelope('c1', 3), userEnvelope('stray', 4)],
      }),
      2,
    );
    // The interrupted committed round is truncated to the settled prefix…
    applyFoldEntry(
      fold,
      entry(EVENT_REPAIR, {
        kind: EVENT_REPAIR,
        sessionId: 's',
        turnId: 'turn-3',
        truncateTo: 3,
        appended: [],
        generation: 1,
      }),
      3,
    );
    expect(materializeFold(fold)).toHaveLength(3);
    // …and the synthesized unknown outcome appends as its own segment.
    applyFoldEntry(
      fold,
      entry(EVENT_REPAIR, {
        kind: EVENT_REPAIR,
        sessionId: 's',
        turnId: 'turn-3',
        appended: [toolResultEnvelope('c1', 5)],
        generation: 2,
      }),
      4,
    );
    expect(materializeFold(fold).at(-1)).toEqual(toolResultEnvelope('c1', 5));
    expect(fold.generation).toBe(2);
  });

  it('recognizes the offload record (wave-2 placeholder) without changing envelopes', () => {
    const fold = seededBase(1);
    applyFoldEntry(
      fold,
      entry(EVENT_OFFLOAD, {
        kind: EVENT_OFFLOAD,
        sessionId: 's',
        seq: 1,
        blockIdx: 0,
        artifactRef: 'artifacts/ab12.png',
      }),
      2,
    );
    expect(materializeFold(fold)).toHaveLength(1);
  });

  it('applies a whole-history replace event with its generation', () => {
    const fold = seededBase(2);
    applyFoldEntry(
      fold,
      entry(EVENT_REPLACE_ALL, {
        kind: EVENT_REPLACE_ALL,
        sessionId: 's',
        envelopes: [userEnvelope('rewritten', 0)],
        generation: 1,
      }),
      2,
    );
    expect(materializeFold(fold)).toEqual([userEnvelope('rewritten', 0)]);
    expect(fold.generation).toBe(1);
  });
});

describe('compaction replace plan validation (properties, not shape)', () => {
  it('resolves the segment range and enforces the tool-round boundary', () => {
    const fold = seededBase(2);
    applyFoldEntry(
      fold,
      entry('history.v1.append', {
        sessionId: 's',
        envelopes: [toolCallEnvelope('c1', 2), toolResultEnvelope('c1', 3), userEnvelope('after', 4)],
      }),
      2,
    );
    // Covering up to (and including) the tool result is legal…
    const legal = resolveCompactionReplaceRange(fold, {
      coveredEnvelopeCount: 4,
      inserted: [summaryEnvelope('a summary long enough to be honest about its source, which the covered prefix of four envelopes certainly exceeds in serialized bytes', 1)],
      summaryText: 'a summary',
      baseGeneration: 0,
    });
    expect(legal).toMatchObject({ startSeq: 1, endSeq: 2, endEnvelopeCount: 2 });
    // …but the boundary must not separate a call from its result: covering
    // the call while keeping the result cuts the round (the last covered
    // envelope is the call itself — the unclosed-call check fires)…
    expect(() =>
      resolveCompactionReplaceRange(fold, {
        coveredEnvelopeCount: 3,
        inserted: [summaryEnvelope('a summary long enough to be honest about its source', 1)],
        summaryText: 'a summary',
        baseGeneration: 0,
      }),
    ).toThrowError(/assistant with unclosed tool calls/);
    // …while covering the whole round (call and result together) stays legal.
    expect(() =>
      resolveCompactionReplaceRange(fold, {
        coveredEnvelopeCount: 4,
        inserted: [summaryEnvelope('a summary long enough to be honest about its source, which four covered envelopes exceed in serialized bytes', 1)],
        summaryText: 'a summary',
        baseGeneration: 0,
      }),
    ).not.toThrow();
    // …and covering the round's head with the result left behind cuts it too.
    const openRound = seededBase(2);
    applyFoldEntry(
      openRound,
      entry('history.v1.append', { sessionId: 's', envelopes: [toolCallEnvelope('c9', 2), userEnvelope('x', 3)] }),
      2,
    );
    expect(() =>
      resolveCompactionReplaceRange(openRound, {
        coveredEnvelopeCount: 3,
        inserted: [summaryEnvelope('a summary long enough to be honest about its source', 1)],
        summaryText: 'a summary',
        baseGeneration: 0,
      }),
    ).toThrowError(/assistant with unclosed tool calls/);
  });

  it('enforces baseGeneration match, non-empty coverage and the smaller-than-source summary', () => {
    const fold = seededBase(4);
    const options = {
      inserted: [summaryEnvelope('long enough summary text to stay under the serialized source bytes of four envelopes with realistic content', 1)],
      summaryText: 'a summary',
    };
    expect(() =>
      resolveCompactionReplaceRange(fold, { ...options, coveredEnvelopeCount: 2, baseGeneration: 5 }),
    ).toThrowError(/plan is stale/);
    expect(() =>
      resolveCompactionReplaceRange(fold, { ...options, coveredEnvelopeCount: 0, baseGeneration: 0 }),
    ).toThrowError(/covers no source envelopes/);
    expect(() =>
      resolveCompactionReplaceRange(fold, { ...options, coveredEnvelopeCount: 9, baseGeneration: 0 }),
    ).toThrowError(/covers no source envelopes|exceeds the folded history/);
    expect(() =>
      resolveCompactionReplaceRange(fold, {
        ...options,
        coveredEnvelopeCount: 2,
        baseGeneration: 0,
        summaryText: '   ',
      }),
    ).toThrowError(/must be non-empty/);
    expect(() =>
      resolveCompactionReplaceRange(fold, {
        coveredEnvelopeCount: 2,
        baseGeneration: 0,
        summaryText: 'a summary',
        inserted: [summaryEnvelope(new Array(80).fill('x').join(''), 1)],
      }),
    ).toThrowError(/not smaller than its source/);
  });
});

describe('lease of an open compaction.start (canon 1.6, owner decision 600s)', () => {
  it('is silent without an open start and abandons a dead writer at once', () => {
    const fold = seededBase(1);
    expect(resolveOpenCompactionLease(fold, 'writer-b', 2_000)).toBe('none');
    applyFoldEntry(fold, entry(EVENT_COMPACTION_START, startPayload()), 2);
    // A different writer token belongs to a dead process — the ownership lock
    // guarantees a single live writer — so the lease closes it immediately.
    expect(resolveOpenCompactionLease(fold, 'writer-b', 1_001)).toBe('close-abandoned');
    // The writer's own attempt inside the window refuses a second start…
    expect(resolveOpenCompactionLease(fold, 'writer-a', 1_001)).toBe('refuse');
    // …and the same attempt past the 600s lease closes as abandoned.
    expect(resolveOpenCompactionLease(fold, 'writer-a', 1_000 + COMPACTION_START_LEASE_MS + 1)).toBe(
      'close-abandoned',
    );
  });
});

describe('fold checkpoint (canon 1.3: disposable cold-start cache)', () => {
  it('round-trips the fold exactly: parse → foldFromCheckpoint equals the original', () => {
    const fold = seededBase(2);
    applyFoldEntry(
      fold,
      entry('history.v1.append', { sessionId: 's', envelopes: [userEnvelope('m', 2)] }),
      2,
    );
    applyFoldEntry(fold, entry(EVENT_COMPACTION_START, startPayload()), 3);
    const raw = serializeFoldCheckpoint('session-1', fold, 42, 1);
    const parsed = parseFoldCheckpoint('session-1', raw);
    expect(parsed).toBeDefined();
    expect(parsed?.backendSeq).toBe(42);
    const restored = foldFromCheckpoint(parsed!);
    expect(materializeFold(restored)).toEqual(materializeFold(fold));
    expect(restored.headSeq).toBe(fold.headSeq);
    expect(restored.generation).toBe(fold.generation);
    expect(restored.lastEntryId).toBe(fold.lastEntryId);
    expect(restored.openCompaction?.compactionId).toBe('ctx_1');
    // The restored fold keeps applying: the segment structure survives.
    applyFoldEntry(
      restored,
      entry('history.v1.append', { sessionId: 's', envelopes: [userEnvelope('m2', 3)] }),
      4,
    );
    expect(materializeFold(restored)).toHaveLength(4);
  });

  it('discards a foreign, corrupt or structurally inconsistent checkpoint', () => {
    const fold = seededBase(2);
    const raw = serializeFoldCheckpoint('session-1', fold, 7, 1);
    expect(parseFoldCheckpoint('session-OTHER', raw)).toBeUndefined();
    expect(parseFoldCheckpoint('session-1', '{not json')).toBeUndefined();
    expect(parseFoldCheckpoint('session-1', '{"schema":2}')).toBeUndefined();
    // Segment counts must partition the envelopes exactly.
    const inconsistent = JSON.parse(raw) as { fold: { segmentCounts: number[] } };
    inconsistent.fold.segmentCounts = [1];
    expect(parseFoldCheckpoint('session-1', JSON.stringify(inconsistent))).toBeUndefined();
  });
});
