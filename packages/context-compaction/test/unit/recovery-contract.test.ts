/**
 * The public `context_edit` recovery contract: the named constants match the
 * behavior of `runWithOverflowRecovery`, the omission payload shape is the
 * one every projection reads, and the exactly-once/no-publication invariants
 * hold on the recovery paths (V-K06).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
  CONTEXT_EDIT_RECOVERY_CONTRACT,
  createOmissionEntryDraft,
  isContractOmissionPayload,
  parseCompactionEntry,
  projectContext,
  runWithOverflowRecovery,
  type DurableEntryDraft,
} from '../../src/index.js';

const overflow = () => {
  throw Object.assign(new Error('prompt is too long'), { status: 413 });
};

describe('CONTEXT_EDIT_RECOVERY_CONTRACT (the named public contract)', () => {
  it('pins the constants the recovery implements', () => {
    expect(CONTEXT_EDIT_RECOVERY_CONTRACT.entryKind).toBe('mcode.context_edit');
    expect(CONTEXT_EDIT_RECOVERY_CONTRACT.omissionAction).toBe('omission');
    expect(CONTEXT_EDIT_RECOVERY_CONTRACT.maxRecoveryCompactions).toBe(1);
    expect(CONTEXT_EDIT_RECOVERY_CONTRACT.maxRetries).toBe(1);
    expect(CONTEXT_EDIT_RECOVERY_CONTRACT.omissionAppendOnly).toBe(true);
    expect(CONTEXT_EDIT_RECOVERY_CONTRACT.noOmissionOnSuccess).toBe(true);
    expect(CONTEXT_EDIT_RECOVERY_CONTRACT.noCheckpointOnSummaryFailure).toBe(true);
    expect(CONTEXT_EDIT_RECOVERY_CONTRACT.invariants.length).toBe(5);
  });

  it('is frozen — consumers cannot silently rewrite the contract', () => {
    expect(Object.isFrozen(CONTEXT_EDIT_RECOVERY_CONTRACT)).toBe(true);
    expect(Object.isFrozen(CONTEXT_EDIT_RECOVERY_CONTRACT.invariants)).toBe(true);
  });
});

describe('the omission payload matches the contract shape', () => {
  it('createOmissionEntryDraft writes the contract shape', () => {
    const draft = createOmissionEntryDraft('o1', ['a', 'b'], 'overflow', () => 5);
    expect(draft.kind).toBe(CONTEXT_EDIT_RECOVERY_CONTRACT.entryKind);
    expect(isContractOmissionPayload(draft.payload)).toBe(true);
    expect(draft.payload).toEqual({
      action: 'omission',
      targetIds: ['a', 'b'],
      reason: 'overflow',
      createdAtMs: 5,
    });
  });

  it('the guard rejects foreign shapes', () => {
    for (const corrupt of [
      null,
      42,
      'omission',
      { action: 'omission' },
      { action: 'prune', targetIds: ['a'], reason: 'r', createdAtMs: 1 },
      { action: 'omission', targetIds: [7], reason: 'r', createdAtMs: 1 },
      { action: 'omission', targetIds: ['a'], reason: 3, createdAtMs: 1 },
    ]) {
      expect(isContractOmissionPayload(corrupt)).toBe(false);
    }
  });
});

describe('runWithOverflowRecovery honors the contract', () => {
  it('a clean first attempt: no compaction, no retry, no omission', async () => {
    let attempts = 0;
    const { result, report } = await runWithOverflowRecovery({
      attempt: async () => {
        attempts += 1;
        return 'ok';
      },
      compact: () => {
        throw new Error('must not compact');
      },
    });
    expect(result).toBe('ok');
    expect(report.compacted).toBe(false);
    expect(attempts).toBe(1);
  });

  it('a successful retry records no omission (noOmissionOnSuccess)', async () => {
    let attempts = 0;
    let compactions = 0;
    const appended: DurableEntryDraft[] = [];
    const { report } = await runWithOverflowRecovery({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) overflow();
        return 'ok';
      },
      compact: async () => {
        compactions += 1;
      },
      failedAttemptEntryIds: () => ['failed-1'],
      appendEntry: async (draft) => {
        appended.push(draft);
      },
    });
    expect(compactions).toBe(CONTEXT_EDIT_RECOVERY_CONTRACT.maxRecoveryCompactions);
    expect(attempts).toBe(1 + CONTEXT_EDIT_RECOVERY_CONTRACT.maxRetries);
    expect(report.omissionDraft).toBeUndefined();
    expect(appended).toEqual([]);
  });

  it('a terminal retry failure appends exactly ONE append-only omission', async () => {
    let attempts = 0;
    let compactions = 0;
    const appended: DurableEntryDraft[] = [];
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          overflow();
        },
        compact: async () => {
          compactions += 1;
        },
        failedAttemptEntryIds: () => ['failed-1', 'failed-2'],
        appendEntry: async (draft) => {
          appended.push(draft);
        },
      }),
    ).rejects.toThrow(/prompt is too long|still too long|413/);
    expect(compactions).toBe(1); // exactly one recovery compaction
    expect(attempts).toBe(2); // exactly one retry
    expect(appended.length).toBe(1);
    expect(isContractOmissionPayload(appended[0]!.payload)).toBe(true);
  });

  it('a non-overflow error never triggers recovery', async () => {
    let compactions = 0;
    await expect(
      runWithOverflowRecovery({
        attempt: () => Promise.reject(new Error('plain failure')),
        compact: async () => {
          compactions += 1;
        },
      }),
    ).rejects.toThrow('plain failure');
    expect(compactions).toBe(0);
  });

  it('the omission hides its targets from the projection (append-only: log entries stay)', async () => {
    // Terminal failure over a real log: the omitted attempt is hidden while
    // the raw records stay present in the log.
    const log = [
      { id: 'keep-1', parentId: null, kind: 'mcode.message', payload: { role: 'user', content: 'kept' }, seq: 1, ordinal: 0 },
      { id: 'failed-1', parentId: 'keep-1', kind: 'mcode.message', payload: { role: 'user', content: 'failed' }, seq: 2, ordinal: 0 },
    ];
    const drafts: DurableEntryDraft[] = [];
    await expect(
      runWithOverflowRecovery({
        attempt: overflow,
        compact: () => Promise.resolve(),
        failedAttemptEntryIds: () => ['failed-1'],
        appendEntry: async (draft) => {
          drafts.push(draft);
        },
        omissionEntryId: 'omit-1',
      }),
    ).rejects.toThrow();
    const withOmission = [...log, { ...drafts[0]!, seq: 3, ordinal: 0 }];
    const projected = projectContext(withOmission as never);
    expect(projected.entries[1]!.contextMessages).toEqual([]); // hidden
    expect(projected.entries[0]!.contextMessages.length).toBe(1); // kept
    expect(withOmission[1]!.id).toBe('failed-1'); // raw record still in the log
  });
});
