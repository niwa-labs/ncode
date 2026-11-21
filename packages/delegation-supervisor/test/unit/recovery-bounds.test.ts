/**
 * Regression tests for the recovery/replay bounds:
 * - recovery is proportional to active state, not to foreign history length
 *   (document-checkpoint fast path via point reads);
 * - a log the supervisor never wrote to opens without any scan (negative
 *   entry-id probe), and a document-less log with supervisor entries replays
 *   through bounded windows;
 * - a spawn replay joins the prior child submission even after the record
 *   aged out of the bounded terminal tail;
 * - a stop cascade reaches descendants recovered from durable spawned
 *   payloads, never silently skipping a subtree;
 * - decided waits (forks, detached, completed) do not accumulate pending
 *   waiters during recovery.
 */

import { describe, expect, it, vi } from 'vitest';

import { SqliteZstdBackend } from '../../../durable-backend-sqlite-zstd/src/index.js';
import {
  KIND_CHILD_CONVERSATION,
  KIND_COMPLETED,
  KIND_SPAWNED,
  KIND_SUPERVISOR_TASK,
  childConversationEntryId,
  childSpecDigest,
  completedEntryId,
  deriveSpawnIdentity,
  spawnedEntryId,
  supervisorTaskEntryId,
} from '../../src/index.js';
import { sqliteZstdDelegationLog } from '../../src/log.js';
import { asJson, childSpec, doneOutcome, makeBackend, makeSupervisor, spawnKey } from '../helpers.js';

describe('recovery and replay bounds', () => {
  it('opens a foreign-heavy log with a tiny budget via the document checkpoint', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });

    // 2 MiB of foreign entries committed AFTER the supervisor activity: the
    // recovery fast path must never scan them.
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 32; i += 1) {
      await backend.appendBatch([{ id: `foreign:${i}`, kind: 'pi.foreign', payload: { blob: chunk } }]);
    }

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend, { recoveryScanBytes: 1024 * 1024 });

    expect(reopened.recovery.mode).toBe('document-checkpoint');
    expect(reopened.recovery.replayedEntries).toBe(0);
    const record = await reopened.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ waitState: 'backgrounded', childState: 'running' });

    // The supervisor keeps working after the checkpoint restore: a new
    // transition chains onto the restored revision.
    const completion = await reopened.complete({
      delegationId: spawn.delegationId,
      childRunId: 'post-recovery',
      outcome: doneOutcome,
    });
    expect(completion.delivery).toBe('reporter');
    expect(reopened.documentRevision).toBe(3);
    await reopenedBackend.close();
  });

  it('joins the prior child submission on replay even after terminal-tail eviction', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend, { maxTerminalRecords: 0 });
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'r1', outcome: doneOutcome });
    expect(supervisor.listIndexed()).toHaveLength(0);
    const headAfterFirst = backend.head;

    const replay = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });

    expect(replay.replayed).toBe(true);
    expect(replay.delegationId).toBe(spawn.delegationId);
    expect(replay.childSubmissionId).toBe(spawn.childSubmissionId);
    expect(backend.head).toBe(headAfterFirst);

    // The durable replay still discriminates the spec.
    await expect(
      supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec({ prompt: 'changed' }) }),
    ).rejects.toMatchObject({ name: 'DelegationKeyConflictError', code: 'DELEGATION_KEY_CONFLICT' });
    expect(backend.head).toBe(headAfterFirst);
  });

  it('stop cascade reaches descendants rebuilt from durable spawned payloads after eviction', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend, { maxTerminalRecords: 0 });
    const root = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-root' }), childSpec: childSpec() });
    const left = await supervisor.spawnDelegation({
      ...spawnKey({ parentConversationId: root.childConversationId, toolCallId: 'tool-left' }),
      childSpec: childSpec({ parentDelegationId: root.delegationId }),
    });
    const grandchild = await supervisor.spawnDelegation({
      ...spawnKey({ parentConversationId: left.childConversationId, toolCallId: 'tool-grandchild' }),
      childSpec: childSpec({ parentDelegationId: left.delegationId }),
    });
    // Both ancestors become terminal and age out of the zero-size tail; the
    // running grandchild stays indexed but loses its ancestor links.
    await supervisor.complete({ delegationId: root.delegationId, childRunId: 'r1', outcome: doneOutcome });
    await supervisor.complete({ delegationId: left.delegationId, childRunId: 'r2', outcome: doneOutcome });

    const result = await supervisor.stop({ rootDelegationId: root.delegationId });

    // The walk must NOT silently skip the subtree: both terminal ancestors are
    // reported skipped, and the running grandchild IS stopped.
    expect(result.outcomes).toEqual([
      { delegationId: root.delegationId, action: 'skipped', skippedBecause: 'terminal', depth: 0 },
      { delegationId: left.delegationId, action: 'skipped', skippedBecause: 'terminal', depth: 1 },
      { delegationId: grandchild.delegationId, action: 'stop-requested', depth: 2 },
    ]);
    const stopped = await supervisor.getDelegation(grandchild.delegationId);
    expect(stopped).toMatchObject({ childState: 'stopping' });
  });

  it('does not create pending waiters for decided waits (forks, detached) during recovery', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    const detached = await supervisor.spawnDelegation({
      ...spawnKey({ toolCallId: 'tool-bg' }),
      childSpec: childSpec(),
    });
    await supervisor.detachToBackground({ delegationId: detached.delegationId, reason: 'owner-input' });
    const fork = await supervisor.forkChild({ delegationId: spawn.delegationId });

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend);

    // Only the one foreground wait is re-materialized; the detached record and
    // the fork branch (waitState 'none') create no never-resolving waiters.
    expect(reopened.recovery.reMaterializedWaits).toEqual([spawn.waitId]);
    expect(reopened.getWait(`wait-${fork.forkDelegationId}`)).toBeUndefined();
    expect(reopened.getWait(detached.waitId)).toBeUndefined();
    // A handle for a decided wait is still available on demand, resolved:
    // replaying the detached record's key materializes it with its outcome.
    const onDemand = await reopened.spawnDelegation({
      ...spawnKey({ toolCallId: 'tool-bg' }),
      childSpec: childSpec(),
    });
    expect(onDemand.replayed).toBe(true);
    await expect(onDemand.wait.promise).resolves.toMatchObject({ kind: 'backgrounded' });
    await reopenedBackend.close();
  });

  it('starts on a foreign-only log the supervisor never committed to — the negative probe skips the replay', async () => {
    const backend = makeBackend();
    // 2 MiB of foreign entries; NO supervisor-derived id anywhere in the log.
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 32; i += 1) {
      await backend.appendBatch([{ id: `foreign:${i}`, kind: 'pi.foreign', payload: { blob: chunk } }]);
    }

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const logPort = sqliteZstdDelegationLog(reopenedBackend);
    const readAll = vi.spyOn(logPort, 'readAll');
    const reopened = await makeSupervisor(reopenedBackend, { recoveryScanBytes: 1024 * 1024, log: logPort });

    // A 1 MiB window cannot cover the 2 MiB history — and the supervisor
    // never asked for a scan at all: the entry-id probe answered instead.
    expect(readAll).not.toHaveBeenCalled();
    expect(reopened.recovery).toMatchObject({ mode: 'entry-replay', replayedEntries: 0, documentRevision: 0 });

    // The supervisor is fully usable: two fresh transitions chain onto
    // revisions 1 and 2 of its own document.
    const spawn = await reopened.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await reopened.complete({ delegationId: spawn.delegationId, childRunId: 'r1', outcome: doneOutcome });
    expect(reopened.documentRevision).toBe(2);
    await reopenedBackend.close();
  });

  it('replays supervisor entries through the windowed fallback while foreign history exceeds one window', async () => {
    const backend = makeBackend();
    // A split-design batch WITHOUT any document entry, then 1.5 MiB of
    // foreign history (twelve 128 KiB batches — one per the backend's
    // per-batch cap): far beyond the 1 MiB window below, so only a windowed
    // walk can reach the log head.
    const key = spawnKey({ toolCallId: 'tool-split' });
    const identity = deriveSpawnIdentity(key);
    await backend.appendBatch([
      {
        id: supervisorTaskEntryId(identity.supervisorTaskId),
        kind: KIND_SUPERVISOR_TASK,
        payload: asJson({
          supervisorTaskId: identity.supervisorTaskId,
          delegationId: identity.delegationId,
          ownershipBoundary: 'native-background',
        }),
      },
      {
        id: childConversationEntryId(identity.childConversationId),
        kind: KIND_CHILD_CONVERSATION,
        payload: asJson({
          childConversationId: identity.childConversationId,
          delegationId: identity.delegationId,
          supervisorTaskId: identity.supervisorTaskId,
          queueForkPolicy: 'initial',
          queues: identity.queues,
          epochSeed: identity.epochSeed,
          inheritedReceipts: 'none',
        }),
      },
      {
        id: spawnedEntryId(identity.delegationId),
        kind: KIND_SPAWNED,
        payload: asJson({
          delegationId: identity.delegationId,
          key,
          supervisorTaskId: identity.supervisorTaskId,
          childConversationId: identity.childConversationId,
          childSubmissionId: identity.childSubmissionId,
          waitId: identity.waitId,
          queues: identity.queues,
          epochSeed: identity.epochSeed,
          supervision: { cancelOnParentAbort: true },
          parentDelegationId: null,
          stateVersion: 1,
          childSpecDigest: childSpecDigest(childSpec()),
        }),
      },
    ]);
    const chunk = 'x'.repeat(128 * 1024);
    for (let i = 0; i < 12; i += 1) {
      await backend.appendBatch([{ id: `foreign:${i}`, kind: 'pi.foreign', payload: { blob: chunk } }]);
    }

    const reopened = await makeSupervisor(backend, { recoveryScanBytes: 1024 * 1024 });

    expect(reopened.recovery.mode).toBe('entry-replay');
    expect(reopened.recovery.replayedEntries).toBe(3);
    // The replayed foreground wait is live: recovery re-materialized it.
    expect(reopened.recovery.reMaterializedWaits).toEqual([identity.waitId]);
    await backend.close();
  });

  it('fails loudly on a completed transition without its spawned record in a document-less log', async () => {
    const backend = makeBackend();
    const identity = deriveSpawnIdentity(spawnKey({ toolCallId: 'tool-orphan' }));
    await backend.appendBatch([
      {
        id: completedEntryId(identity.delegationId, 'child-run-1'),
        kind: KIND_COMPLETED,
        payload: asJson({
          delegationId: identity.delegationId,
          childRunId: 'child-run-1',
          outcome: doneOutcome,
          delivery: 'foreground',
          requestId: null,
          stateVersion: 2,
        }),
      },
    ]);

    // The id IS inside the probe range, so recovery replays it — and the
    // index reducer refuses the orphan transition instead of dropping it.
    await expect(makeSupervisor(backend)).rejects.toThrow(/unknown delegation/);
    await backend.close();
  });

  it('treats a seam-only log (mcode:* wait ids) as never-written and skips the replay', async () => {
    const backend = makeBackend();
    // The wait seam commits under `mcode:*` ids (a colon sorts after the
    // supervisor prefix's dot) — they never enter the probe range.
    await backend.appendBatch([
      { id: 'mcode:wait:w-1', kind: 'seam.wait-opened', payload: asJson({ waitId: 'w-1' }) },
      { id: 'mcode:receipt:r-1', kind: 'seam.receipt', payload: asJson({}) },
    ]);
    const logPort = sqliteZstdDelegationLog(backend);
    const readAll = vi.spyOn(logPort, 'readAll');

    const supervisor = await makeSupervisor(backend, { log: logPort });

    expect(readAll).not.toHaveBeenCalled();
    expect(supervisor.recovery).toMatchObject({ mode: 'entry-replay', replayedEntries: 0, documentRevision: 0 });
    await backend.close();
  });

  it('a log port without the probe falls back to the windowed replay instead of skipping (fail-closed)', async () => {
    const backend = makeBackend();
    // Foreign-only history — exactly the log the negative probe would skip
    // when implemented. The port below LACKS `hasEntriesInRange` (an older or
    // structural backend): absence must read as "cannot disprove", never as
    // "not found" — otherwise the wrapper silently drops the replay and the
    // supervisor opens on a fabricated-empty state.
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 4; i += 1) {
      await backend.appendBatch([{ id: `foreign:${i}`, kind: 'pi.foreign', payload: { blob: chunk } }]);
    }
    const logPort = sqliteZstdDelegationLog(backend);
    delete logPort.hasEntriesInRange;
    const readAll = vi.spyOn(logPort, 'readAll');

    const supervisor = await makeSupervisor(backend, { log: logPort });

    // The probe could not answer, so recovery walked the windows instead of
    // skipping — and correctly found zero supervisor entries in them.
    expect(readAll).toHaveBeenCalled();
    expect(supervisor.recovery).toMatchObject({ mode: 'entry-replay', replayedEntries: 0, documentRevision: 0 });
    await backend.close();
  });

  it('rejects when a recovery window stops on a torn tail mid-walk', async () => {
    const logPort = sqliteZstdDelegationLog({
      head: 3,
      getEntry: () => undefined,
      readDeltaFrom: () => [],
      appendBatch: () => Promise.resolve({ seq: 3, head: 3 }),
      readDeltaChecked: (afterSeq: number) =>
        afterSeq === 0
          ? {
              entries: [
                { id: 'mcode.delegation.spawned:del-1', kind: KIND_SPAWNED, payload: asJson({ delegationId: 'del-1' }), seq: 1 },
              ],
              nextAfterSeq: 1,
              tornTail: null,
            }
          : { entries: [], nextAfterSeq: null, tornTail: { batchId: 2, reason: 'bad frame checksum' } },
    });

    // The first window served a batch; the second hit a corrupt batch — the
    // walk refuses instead of replaying the intact prefix only.
    await expect(logPort.readAll(8 * 1024 * 1024)).rejects.toMatchObject({
      name: 'DelegationRecoveryTruncatedError',
      code: 'DELEGATION_RECOVERY_TRUNCATED',
    });
  });

  it('rejects when a recovery window makes no progress before the head', async () => {
    // A window serving nothing at all (would loop forever)…
    const stalled = sqliteZstdDelegationLog({
      head: 1,
      getEntry: () => undefined,
      readDeltaFrom: () => [],
      appendBatch: () => Promise.resolve({ seq: 1, head: 1 }),
      readDeltaChecked: () => ({ entries: [], nextAfterSeq: null, tornTail: null }),
    });
    await expect(stalled.readAll(8 * 1024 * 1024)).rejects.toThrow(/stalled at cursor 0/);

    // …and one returning the SAME cursor (no movement).
    const stuck = sqliteZstdDelegationLog({
      head: 1,
      getEntry: () => undefined,
      readDeltaFrom: () => [],
      appendBatch: () => Promise.resolve({ seq: 1, head: 1 }),
      readDeltaChecked: (afterSeq: number) => ({ entries: [], nextAfterSeq: afterSeq, tornTail: null }),
    });
    await expect(stuck.readAll(8 * 1024 * 1024)).rejects.toThrow(/stalled at cursor 0/);
  });
});
