/**
 * The exactly-once overflow retry, edge by edge.
 *
 * `overflow-recovery.test.ts` covers the happy paths. This file pins the
 * boundaries of the contract: WHICH error escapes, WHEN an omission is
 * recorded, and what the overflow detector accepts.
 */

import { describe, expect, it } from 'vitest';

import { isContextOverflowError, runWithOverflowRecovery } from '../../src/index.js';
import type { DurableEntryDraft } from '../../src/index.js';

function overflow(message: string): Error {
  return new Error(message);
}

describe('which error escapes the recovery', () => {
  it('propagates the RETRY error, not the first one', async () => {
    let attempts = 0;
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          throw overflow(attempts === 1 ? 'prompt is too long (FIRST)' : 'prompt is too long (SECOND)');
        },
        compact: async () => undefined,
      }),
    ).rejects.toThrow('prompt is too long (SECOND)');
    expect(attempts).toBe(2);
  });

  it('treats a non-overflow retry failure as terminal too', async () => {
    const log: DurableEntryDraft[] = [];
    let attempts = 0;
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          throw attempts === 1 ? overflow('prompt is too long') : new Error('gateway timeout');
        },
        compact: async () => undefined,
        failedAttemptEntryIds: () => ['attempt-1'],
        appendEntry: (draft) => {
          log.push(draft);
        },
      }),
    ).rejects.toThrow('gateway timeout');
    // The attempt is NOT retried a third time, and the failed entries are hidden.
    expect(attempts).toBe(2);
    expect(log).toHaveLength(1);
  });

  it('does not retry when the compaction itself fails', async () => {
    let attempts = 0;
    let compactions = 0;
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          throw overflow('prompt is too long');
        },
        compact: async () => {
          compactions += 1;
          throw new Error('summarizer unavailable');
        },
      }),
    ).rejects.toThrow('summarizer unavailable');
    // The compaction failure is NOT swallowed and the turn is NOT retried:
    // a broken compactor must not produce a second, equally broken attempt.
    expect(attempts).toBe(1);
    expect(compactions).toBe(1);
  });

  it('does not retry a failure the detector does not recognize', async () => {
    let attempts = 0;
    let compactions = 0;
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          throw new Error('the model refused to answer');
        },
        compact: async () => {
          compactions += 1;
        },
      }),
    ).rejects.toThrow('the model refused to answer');
    expect(attempts).toBe(1);
    expect(compactions).toBe(0);
  });
});

describe('when the omission is recorded', () => {
  it('records no omission when the failed attempt produced no entries', async () => {
    const log: DurableEntryDraft[] = [];
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          throw overflow('prompt is too long');
        },
        compact: async () => undefined,
        failedAttemptEntryIds: () => [],
        appendEntry: (draft) => {
          log.push(draft);
        },
      }),
    ).rejects.toThrow(/prompt is too long/);
    expect(log).toHaveLength(0);
  });

  it('records no omission when there is no appender', async () => {
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          throw overflow('prompt is too long');
        },
        compact: async () => undefined,
        failedAttemptEntryIds: () => ['attempt-1'],
      }),
    ).rejects.toThrow(/prompt is too long/);
  });

  it('records the omission under the caller-supplied id', async () => {
    const log: DurableEntryDraft[] = [];
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          throw overflow('prompt is too long');
        },
        compact: async () => undefined,
        failedAttemptEntryIds: () => ['attempt-1', 'attempt-2'],
        appendEntry: (draft) => {
          log.push(draft);
        },
        omissionEntryId: 'omission-fixed-id',
      }),
    ).rejects.toThrow(/prompt is too long/);
    expect(log[0]!.id).toBe('omission-fixed-id');
    expect(log[0]!.kind).toBe('mcode.context_edit');
    expect(log[0]!.payload).toMatchObject({ action: 'omission', targetIds: ['attempt-1', 'attempt-2'] });
  });

  it('names BOTH failures in the omission reason', async () => {
    const log: DurableEntryDraft[] = [];
    let attempts = 0;
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          throw attempts === 1 ? overflow('prompt is too long') : new Error('still too long');
        },
        compact: async () => undefined,
        failedAttemptEntryIds: () => ['attempt-1'],
        appendEntry: (draft) => {
          log.push(draft);
        },
      }),
    ).rejects.toThrow('still too long');
    const reason = String((log[0]!.payload as { reason?: unknown }).reason);
    expect(reason).toContain('prompt is too long');
    expect(reason).toContain('still too long');
  });

  it('never records an omission for a recovered attempt', async () => {
    const log: DurableEntryDraft[] = [];
    let attempts = 0;
    const { report } = await runWithOverflowRecovery({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) throw overflow('prompt is too long');
        return 'ok';
      },
      compact: async () => undefined,
      failedAttemptEntryIds: () => ['attempt-1'],
      appendEntry: (draft) => {
        log.push(draft);
      },
    });
    expect(report.compacted).toBe(true);
    expect(report.omissionDraft).toBeUndefined();
    expect(log).toHaveLength(0);
  });
});

describe('the overflow detector', () => {
  it('accepts a bare string as the error', () => {
    expect(isContextOverflowError('prompt is too long')).toBe(true);
    expect(isContextOverflowError('all good')).toBe(false);
  });

  it('accepts a provider error code without a message', () => {
    expect(isContextOverflowError({ code: 'context_length_exceeded' })).toBe(true);
    expect(isContextOverflowError({ code: 'invalid_request' })).toBe(false);
  });

  it('inspects the cause chain but only a few levels deep', () => {
    const wrap = (depth: number): unknown => {
      let error: unknown = new Error('prompt is too long');
      for (let i = 0; i < depth; i += 1) error = new Error('wrapper', { cause: error });
      return error;
    };
    // The detector walks at most sixteen levels (bounded against circular cause).
    expect(isContextOverflowError(wrap(1))).toBe(true);
    expect(isContextOverflowError(wrap(3))).toBe(true);
    expect(isContextOverflowError(wrap(4))).toBe(true);
  });

  it('rejects values that carry no text at all', () => {
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(42)).toBe(false);
    expect(isContextOverflowError({})).toBe(false);
  });

  it('does not fire on a rate limit that merely mentions tokens', () => {
    expect(isContextOverflowError(new Error('rate limit exceeded, retry later'))).toBe(false);
    expect(isContextOverflowError(new Error('too many requests per minute'))).toBe(false);
  });
});
