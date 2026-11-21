import { describe, expect, it } from 'vitest';

import { WriteLockWaitAbortedError } from '../../../../infra/db/write-transaction.js';
import { AgentHostCommittedHistoryWriter } from './committed-history-writer.js';
import type {
  AgentHostHistoryFailure,
  CanonicalHistoryChange,
  CanonicalHistoryCommit,
  CanonicalHistorySnapshot,
  CanonicalHistoryStore,
  CommittedHistoryChange,
} from './contracts.js';
import type { AgentEventContext, AgentEventDelivery } from '../events/contracts.js';

/**
 * Fix B of the compaction incident 2026-11-07 (mvs_f3f8d0ab): an abort-caused
 * committed-history failure (the owner's Esc cancelled the commit pipeline
 * AFTER the write landed) must never poison the Session with the
 * "Canonical history commit failed" history-failure projection — the masked
 * "Conversation history could not be safely updated" surface is reserved for
 * REAL refusals, which still mark the Session fail-closed.
 */

const CONTEXT: AgentEventContext = {
  sessionId: 'session-abort-mask',
  turnId: 'turn-abort-mask',
  turnSequence: 1,
} as AgentEventContext;

// The exact key set readCompactionLifecycleMetadata parses (attemptId,
// replacementId, strategyVersion, compactionMethod, compactionPhase, counts).
const COMPACTION_METADATA = {
  compactionAttemptId: 'attempt-1',
  compactionPhase: 'initial',
  replacementId: 'ctx_abort-mask',
  strategyVersion: 'unified-compaction-wire-v1',
  compactionMethod: 'llm_checkpoint',
  messagesBefore: 3,
  messagesAfter: 1,
  tokensBefore: 100,
  tokensAfter: 10,
  serializedBytesBefore: 1_000,
  serializedBytesAfter: 100,
};

function compactionChange(): CanonicalHistoryChange {
  return {
    sessionId: CONTEXT.sessionId,
    turnId: CONTEXT.turnId,
    reason: 'replaceMessages',
    messages: [{ role: 'compactionSummary', summary: 'compressed', tokensBefore: 100, timestamp: 1 }],
    operation: { id: 'agent-host:turn-abort-mask:history:compaction:ctx_abort-mask', kind: 'compaction' },
    metadata: COMPACTION_METADATA,
  };
}

const COMMITTED: CanonicalHistorySnapshot = {
  revision: 'rev-1',
  messages: [{ role: 'compactionSummary', summary: 'compressed', tokensBefore: 100, timestamp: 1 }],
  identityVector: ['msg-summary-1'],
};

interface Harness {
  readonly writer: AgentHostCommittedHistoryWriter;
  readonly historyFailures: unknown[];
  readonly compactionFailures: unknown[];
  readonly failHistoryCommittedWith: (error: unknown) => void;
  readonly failCanonicalWriteWith: (error: unknown) => void;
}

function createHarness(): Harness {
  const historyFailures: unknown[] = [];
  const compactionFailures: unknown[] = [];
  let committedError: unknown = undefined;
  let writeError: unknown = undefined;
  const history: CanonicalHistoryStore = {
    read: async () => COMMITTED,
    append: async (change): Promise<CanonicalHistoryCommit> => {
      if (writeError) throw writeError;
      return { ...COMMITTED, generation: 1 };
    },
    replace: async (): Promise<CanonicalHistoryCommit> => {
      if (writeError) throw writeError;
      return { ...COMMITTED, generation: 1 };
    },
    compact: async (): Promise<CanonicalHistoryCommit> => {
      if (writeError) throw writeError;
      return { ...COMMITTED, generation: 1 };
    },
  };
  const events = {
    handleHistoryCommitted: async (): Promise<CommittedHistoryChange> => {
      if (committedError) throw committedError;
      return { ...compactionChange(), committedRevision: COMMITTED.revision, committedMessages: COMMITTED.messages } as unknown as CommittedHistoryChange;
    },
  } as unknown as AgentEventDelivery;
  const historyFailure: AgentHostHistoryFailure = {
    fail: async (input) => {
      historyFailures.push(input);
    },
  };
  const writer = new AgentHostCommittedHistoryWriter({
    history,
    events,
    historyFailure,
    compaction: {
      lifecycle: {
        completeCommittedHistory: async () => {},
        failCommittedHistory: async (input) => {
          compactionFailures.push(input);
        },
      },
    },
  });
  return {
    writer,
    historyFailures,
    compactionFailures,
    failHistoryCommittedWith: (error) => {
      committedError = error;
    },
    failCanonicalWriteWith: (error) => {
      writeError = error;
    },
  };
}

describe('AgentHostCommittedHistoryWriter: abort-caused failures never poison the Session', () => {
  it('an Esc-cancelled commit-pipeline delivery does NOT mark the history failed (quiet abort)', async () => {
    const harness = createHarness();
    // The canonical write LANDED; the required event delivery died on the
    // owner's Esc (the lease's write-lock wait was cancelled).
    const signal = AbortSignal.abort();
    harness.failHistoryCommittedWith(new WriteLockWaitAbortedError(signal));
    await expect(
      harness.writer.commit(CONTEXT, compactionChange()),
    ).rejects.toThrowError(/SQLite write lock wait was cancelled/);
    expect(harness.historyFailures).toEqual([]);
    // The compaction_failed fact stays an honest diagnostic.
    expect(harness.compactionFailures).toHaveLength(1);
  });

  it('a real failure of the commit pipeline still marks the history failed (fail-closed)', async () => {
    const harness = createHarness();
    harness.failHistoryCommittedWith(new TypeError('projection failed'));
    await expect(
      harness.writer.commit(CONTEXT, compactionChange()),
    ).rejects.toThrowError(/projection failed/);
    expect(harness.historyFailures).toHaveLength(1);
  });

  it('a canonical write refusal (a rejected compaction plan) still marks the history failed', async () => {
    const harness = createHarness();
    harness.failCanonicalWriteWith(
      new TypeError('Canonical checkpoint compaction plan is stale: canonical history grew past the planned replacement range'),
    );
    await expect(
      harness.writer.commit(CONTEXT, compactionChange()),
    ).rejects.toThrowError(/plan is stale/);
    expect(harness.historyFailures).toHaveLength(1);
    expect(harness.compactionFailures).toHaveLength(1);
  });

  it('an AbortError from the canonical write does NOT mark the history failed', async () => {
    const harness = createHarness();
    const abort = new Error('context canceled');
    abort.name = 'AbortError';
    harness.failCanonicalWriteWith(abort);
    await expect(harness.writer.commit(CONTEXT, compactionChange())).rejects.toThrowError(
      /context canceled/,
    );
    expect(harness.historyFailures).toEqual([]);
    expect(harness.compactionFailures).toHaveLength(1);
  });
});
