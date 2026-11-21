/**
 * Native task-wait binding unit contracts (verdict 09 §1.4/§1.5/§1.8, wave 2)
 * over the REAL steering composition on the real sqlite-zstd backend:
 *
 * - registration anchors the durable seam wait AND the reactive control
 *   registry under the SAME native waitId; the release adapter reports the
 *   native taskId (never the toolCallId default);
 * - the wait outcome is the single decision of the durable seam: completion
 *   while foreground commits the completed outcome (inline channel); a
 *   committed release wins and a later completion routes the terminal to the
 *   scheduled channel without a second tool-result;
 * - a release intent committed before a late registration is replayed against
 *   the freshly registered wait (§1.6 input-before-provider barrier);
 * - the release pass projects onto the task row (promote out of `foreground`)
 *   inside the committed pass — the session stop cascade must see it.
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDelegationSteeringComposition,
  type DelegationSteeringComposition,
} from './delegation-release-composition.js';
import { joinReleasedNativeTasksWithCanonicalHistory } from './native-wait-recovery.js';
import { createNativeTaskWaits, type NativeTaskWaits } from './native-task-waits.js';
import { nativeTaskWaitId } from '@mavis/local-runtime';

const directories: string[] = [];
const backends: SqliteZstdBackend[] = [];

const OWNER = 'owner-session';
const TURN = 'owner-turn-1';
const TOOL_CALL = 'call_task_1';
const TASK = 'bg_task_1';
const CHILD_SESSION = 'child-session';
const CHILD_TURN = 'bg_task_1_t';

let promoted: string[] = [];
let taskStatuses: Record<string, string>;

beforeEach(() => {
  promoted = [];
  taskStatuses = { [TASK]: 'running' };
});

afterEach(() => {
  while (backends.length > 0) {
    const backend = backends.pop();
    backend?.close();
  }
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function compose(): Promise<{
  composition: DelegationSteeringComposition;
  nativeWaits: NativeTaskWaits;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'native-task-waits-'));
  directories.push(directory);
  const backend = SqliteZstdBackend.open(directory);
  backends.push(backend);
  const composition = await createDelegationSteeringComposition({ backend });
  // The task-row projection is late-bound by the runtime host (runtime.ts);
  // the test binds the same surface against its own recorder.
  composition.nativeWaits.bindTaskProjection({
    readTaskStatus: async (taskId) => taskStatuses[taskId],
    promoteTaskRow: async (taskId) => {
      promoted.push(taskId);
    },
  });
  return { composition, nativeWaits: composition.nativeWaits };
}

function registration() {
  return {
    ownerSessionId: OWNER,
    ownerTurnId: TURN,
    toolCallId: TOOL_CALL,
    taskId: TASK,
    childSessionId: CHILD_SESSION,
    childTurnId: CHILD_TURN,
  };
}

describe('native task wait binding (§1.4)', () => {
  it('anchors the seam wait and the control registry under the same native waitId and reports the native taskId', async () => {
    const { composition, nativeWaits } = await compose();
    const waitId = nativeTaskWaitId(OWNER, TURN, TOOL_CALL);

    const handle = await nativeWaits.registerNativeTaskWait(registration());

    expect(handle.taskId).toBe(TASK);
    expect(nativeWaits.taskIdForWait(waitId)).toBe(TASK);
    expect(nativeWaits.taskIdForWait('foreign-wait')).toBeUndefined();
    const view = composition.seam.getWait(waitId);
    expect(view).toMatchObject({
      waitId,
      toolCallId: TOOL_CALL,
      conversationId: OWNER,
      childConversationId: CHILD_SESSION,
      childRunId: CHILD_TURN,
      state: 'foreground',
      cancelOnParentAbort: true,
    });
    // The reactive control sees the wait as a releasable blocker of the round.
    expect(
      composition.control
        .blockers({ parentConversationId: OWNER })
        .map((blocker) => blocker.waitId),
    ).toEqual([waitId]);
    // A replayed registration attaches to the SAME wait — never a second one.
    const replay = await nativeWaits.registerNativeTaskWait(registration());
    expect(replay.taskId).toBe(TASK);
    expect(composition.seam.getWait(waitId)).toMatchObject({ state: 'foreground' });
    expect(
      composition.control.blockers({ parentConversationId: OWNER }),
    ).toHaveLength(1);
  });

  it('completion while foreground commits the completed outcome inline and settles the waiter once', async () => {
    const { composition, nativeWaits } = await compose();

    const handle = await nativeWaits.registerNativeTaskWait(registration());
    expect(handle.isForeground()).toBe(true);

    const channel = await handle.complete({ status: 'succeeded' });
    expect(channel).toBe('inline');
    const outcome = await handle.outcome;
    expect(outcome).toEqual({ kind: 'completed' });
    expect(handle.isForeground()).toBe(false);

    // The single tool-result of the toolCallId is the completed outcome; a
    // repeat reproduces it (idempotent), it is never re-decided.
    const replay = await composition.seam.finalizeTool({
      toolCallId: TOOL_CALL,
      outcome: {
        kind: 'completed',
        taskId: TASK,
        childSessionId: CHILD_SESSION,
        childTurnId: CHILD_TURN,
        status: 'succeeded',
      },
    });
    expect(replay.status).toBe('replayed');
    // No waits remain active, so a later steer finds nothing to release.
    expect(
      await composition.control.onCommittedSteer({ parentConversationId: OWNER }),
    ).toBeNull();
  });

  it('release first: the backgrounded outcome stands and a later completion routes to schedule without a second result', async () => {
    const { composition, nativeWaits } = await compose();

    const handle = await nativeWaits.registerNativeTaskWait(registration());
    const settled = handle.outcome;

    // The committed-steer release pass over the SAME registry.
    const release = await composition.control.onCommittedSteer({
      parentConversationId: OWNER,
    });
    expect(release?.released).toHaveLength(1);
    expect(release?.released[0]).toMatchObject({ status: 'released' });

    const outcome = await settled;
    expect(outcome).toEqual({ kind: 'backgrounded', reason: 'owner_input', taskStatus: 'running' });
    expect(handle.isForeground()).toBe(false);
    // §1.5: the promotion happened inside the committed release pass, before
    // the waiter settled.
    expect(promoted).toEqual([TASK]);

    // The child finishes afterwards: the durable background outcome is
    // authoritative, so the completion takes the scheduled channel.
    const channel = await handle.complete({ status: 'succeeded' });
    expect(channel).toBe('background');
    // The release pass already committed the ONE tool-result of the tool call
    // (nothing stays pending for recovery), and its decision carried the
    // owner_input reason for the NATIVE task id (never the toolCallId default).
    expect(composition.seam.listPendingPrepared()).toEqual([]);
    expect(release?.released[0]?.prepared?.reason).toBe('owner_input');
    expect(release?.released[0]?.prepared?.taskId).toBe(TASK);
  });

  it('a release intent noted before a late registration is replayed against the registered wait (§1.6)', async () => {
    const { composition, nativeWaits } = await compose();

    // The owner input was accepted and its release pass committed while the
    // task setup was still running.
    nativeWaits.noteOwnerReleaseIntent(OWNER, TURN);

    const handle = await nativeWaits.registerNativeTaskWait(registration());
    const outcome = await handle.outcome;
    expect(outcome).toEqual({ kind: 'backgrounded', reason: 'owner_input', taskStatus: 'running' });
    expect(promoted).toEqual([TASK]);
    // The replay pass ran the full two-phase release: nothing stays pending,
    // and the wait has left the active projection (decided + finalized).
    expect(composition.seam.listPendingPrepared()).toEqual([]);
  });

  it('projectReleaseDecision is a no-op for foreign (supervisor delegation) waits', async () => {
    const { nativeWaits } = await compose();
    await nativeWaits.projectReleaseDecision('wait:other-conversation:run:call');
    expect(promoted).toEqual([]);
  });

  it('status snapshot at release time is read through the bound projection', async () => {
    const { composition, nativeWaits } = await compose();
    taskStatuses[TASK] = 'queued';
    const handle = await nativeWaits.registerNativeTaskWait(registration());
    const release = await composition.control.onCommittedSteer({
      parentConversationId: OWNER,
    });
    expect(release?.released).toHaveLength(1);
    expect(await handle.outcome).toMatchObject({ kind: 'backgrounded', taskStatus: 'queued' });
  });
});

describe('native task wait binding: wave 3 (§1.6/§1.8)', () => {
  it('the durable release intent survives an in-memory restart: a NEW binding over the same seam replays the release', async () => {
    // ONE durable backend for both legs — the restart keeps the log.
    const directory = mkdtempSync(join(tmpdir(), 'native-task-waits-restart-'));
    directories.push(directory);
    const backend = SqliteZstdBackend.open(directory);
    backends.push(backend);
    const first = await createDelegationSteeringComposition({ backend });
    const composition = first;
    const nativeWaits = first.nativeWaits;

    // The owner input was accepted while the setup ran; the note is durable
    // now (the steering service awaits it before the release pass).
    await nativeWaits.noteOwnerReleaseIntent(OWNER, TURN);
    // Nothing was registered yet, so the pass found no waits.
    expect(await composition.control.onCommittedSteer({ parentConversationId: OWNER })).toBeNull();

    // The process restarts: a fresh composition over the SAME backend has an
    // EMPTY in-memory map, and the late registration replays the release from
    // the SEAM fact.
    const restarted = await createDelegationSteeringComposition({ backend });
    const handle = await restarted.nativeWaits.registerNativeTaskWait(registration());
    const outcome = await handle.outcome;
    expect(outcome).toEqual({ kind: 'backgrounded', reason: 'owner_input', taskStatus: 'running' });
    expect(composition.seam.hasReleaseIntent(OWNER, TURN)).toBe(true);
    expect(restarted.seam.listPendingPrepared()).toEqual([]);
  });

  it('the accepted-owner-input generation is monotonic per conversation and stable across reads', async () => {
    const { nativeWaits } = await compose();
    expect(nativeWaits.ownerInputGeneration(OWNER)).toBe(0);
    expect(nativeWaits.ownerInputGeneration('other-session')).toBe(0);
    await nativeWaits.noteOwnerReleaseIntent(OWNER, TURN);
    const afterFirst = nativeWaits.ownerInputGeneration(OWNER);
    expect(afterFirst).toBeGreaterThan(0);
    await nativeWaits.noteOwnerReleaseIntent(OWNER, TURN);
    await nativeWaits.noteOwnerReleaseIntent('other-session', 'turn-2');
    expect(nativeWaits.ownerInputGeneration(OWNER)).toBe(afterFirst + 1);
    expect(nativeWaits.ownerInputGeneration('other-session')).toBe(1);
    // Reads do not advance anything.
    expect(nativeWaits.ownerInputGeneration(OWNER)).toBe(afterFirst + 1);
  });

  it('joinReleasedNativeTasksWithCanonicalHistory finalizes the prepared outcome and closes the parent round with the KNOWN note', async () => {
    const { composition, nativeWaits } = await compose();

    // Crash simulation: the release PREPARE committed, but the process died
    // before the tool result was finalized and before the parent executor
    // committed the canonical toolResult. The durable state is exactly what
    // the seam holds after `prepareRelease`.
    const waitId = nativeTaskWaitId(OWNER, TURN, TOOL_CALL);
    const opened = await composition.seam.openForegroundWait({
      waitId,
      toolCallId: TOOL_CALL,
      conversationId: OWNER,
      delegationId: TASK,
      childConversationId: CHILD_SESSION,
      childRunId: CHILD_TURN,
    });
    const prepared = await composition.seam.prepareRelease({
      waitId,
      expectedVersion: opened.stateVersion,
      reason: 'owner_input',
    });
    expect(composition.seam.listPendingPrepared()).toHaveLength(1);

    // The parent turn's canonical history holds the open tool round.
    const active = [
      { message_id: 'msg-user-1', turn_id: 'user', message: { role: 'user', content: 'go', timestamp: 1 } },
      {
        message_id: 'msg-assist-1',
        turn_id: TURN,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: TOOL_CALL, name: 'task', arguments: {} }],
          timestamp: 2,
        },
      },
    ];
    let closedInput: Record<string, unknown> | undefined;
    const report = await joinReleasedNativeTasksWithCanonicalHistory({
      nativeWaits,
      listReleasedTaskRows: async () => [
        {
          taskId: TASK,
          ownerSessionId: OWNER,
          parentTurnId: TURN,
          toolCallId: TOOL_CALL,
          childSessionId: CHILD_SESSION,
          status: 'running',
        },
      ],
      nowMs: () => 5_000,
    });
    // Without the history capability the join still finalized the decision.
    expect(report.finalizedPrepared).toBe(1);
    expect(composition.seam.listPendingPrepared()).toHaveLength(0);
    expect(
      composition.seam.releasedBackgroundOutcomeOfToolCall(TOOL_CALL)?.kind,
    ).toBe('background');
    void prepared;

    // Second run, now with the history mutation: the round is closed with the
    // KNOWN §2.2 note (the seam outcome is authoritative, the child answer is
    // never fabricated).
    const report2 = await joinReleasedNativeTasksWithCanonicalHistory({
      nativeWaits,
      historyMutation: {
        read: async () => ({ activeGeneration: 0, active, snapshots: [], revision: 'r', activeSettled: false }),
        closeReleasedToolRound: async (input) => {
          closedInput = { ...input };
          return {
            status: 'committed',
            revision: 'r2',
            generation: 0,
            messages: [],
            identityVector: [],
            deletedMessageIds: [],
            closed: [input.released.map((entry) => entry.callId)].flat(),
          };
        },
      },
      listReleasedTaskRows: async () => [
        {
          taskId: TASK,
          ownerSessionId: OWNER,
          parentTurnId: TURN,
          toolCallId: TOOL_CALL,
          childSessionId: CHILD_SESSION,
          status: 'running',
        },
      ],
      nowMs: () => 5_000,
    });
    expect(report2.finalizedPrepared).toBe(0); // nothing pending anymore
    expect(report2.closed).toHaveLength(1);
    expect(closedInput).toMatchObject({
      sessionId: OWNER,
      turnId: TURN,
      released: [
        {
          callId: TOOL_CALL,
          toolName: 'task',
          text: expect.stringContaining('<task_background'),
        },
      ],
    });
    expect(String(closedInput?.operationId)).toContain('native-wait-recovery');
    // The note reports the FACTUAL row status and the recorded reason.
    const note = (closedInput!.released as readonly { text: string }[])[0]!.text;
    expect(note).toContain('reason="owner_input"');
    expect(note).toContain('status="running"');
    expect(note).toContain(`task_id="${TASK}"`);
  });

  it('the join never writes a second result over a closed canonical round', async () => {
    const { composition, nativeWaits } = await compose();
    const waitId = nativeTaskWaitId(OWNER, TURN, TOOL_CALL);
    const opened = await composition.seam.openForegroundWait({
      waitId,
      toolCallId: TOOL_CALL,
      conversationId: OWNER,
      delegationId: TASK,
    });
    const prepared = await composition.seam.prepareRelease({
      waitId,
      expectedVersion: opened.stateVersion,
    });
    await composition.seam.finalizeTool({ toolCallId: TOOL_CALL, outcome: prepared.outcome });

    // The canonical history ALREADY carries a tool result for the call (the
    // live executor won the write after all).
    const active = [
      { message_id: 'msg-user-1', turn_id: 'user', message: { role: 'user', content: 'go', timestamp: 1 } },
      {
        message_id: 'msg-assist-1',
        turn_id: TURN,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: TOOL_CALL, name: 'task', arguments: {} }],
          timestamp: 2,
        },
      },
      {
        message_id: 'msg-result-1',
        turn_id: TURN,
        message: { role: 'toolResult', toolCallId: TOOL_CALL, toolName: 'task', content: [{ type: 'text', text: 'inline' }], isError: false, timestamp: 3 },
      },
    ];
    let closeCalls = 0;
    const report = await joinReleasedNativeTasksWithCanonicalHistory({
      nativeWaits,
      historyMutation: {
        read: async () => ({ activeGeneration: 0, active, snapshots: [], revision: 'r', activeSettled: true }),
        closeReleasedToolRound: async () => {
          closeCalls += 1;
          throw new Error('the join must not touch a closed round');
        },
      },
      listReleasedTaskRows: async () => [
        {
          taskId: TASK,
          ownerSessionId: OWNER,
          parentTurnId: TURN,
          toolCallId: TOOL_CALL,
          status: 'running',
        },
      ],
    });
    expect(report.alreadyClosed).toEqual([TOOL_CALL]);
    expect(report.closed).toEqual([]);
    expect(closeCalls).toBe(0);
  });
});

describe('№3 (§5.4): one accepted input releases every wait of the owner scope', () => {
  it('releases five active waits of one conversation with exactly one tool-result each; another conversation is untouched', async () => {
    const { composition, nativeWaits } = await compose();

    // Five active children of the SAME owner conversation, each parked on
    // its own foreground wait; a sixth wait belongs to ANOTHER conversation.
    const owner = 'owner-session';
    const foreign = 'other-session';
    const registrations = [1, 2, 3, 4, 5].map((index) => ({
      ownerSessionId: owner,
      ownerTurnId: `owner-turn-${index}`,
      toolCallId: `call_${index}`,
      taskId: `bg_task_${index}`,
      childSessionId: `child-${index}`,
      childTurnId: `bg_task_${index}_t`,
    }));
    const handles = [];
    for (const registration of registrations) {
      handles.push(await nativeWaits.registerNativeTaskWait(registration));
    }
    const foreignHandle = await nativeWaits.registerNativeTaskWait({
      ownerSessionId: foreign,
      ownerTurnId: 'foreign-turn',
      toolCallId: 'foreign_call',
      taskId: 'foreign_task',
      childSessionId: 'foreign-child',
      childTurnId: 'foreign_task_t',
    });

    // ONE committed steer for the owner conversation releases ALL its waits.
    const release = await composition.control.onCommittedSteer({
      parentConversationId: owner,
    });
    expect(release?.released).toHaveLength(5);
    expect(release?.skipped).toHaveLength(0);
    for (const handle of handles) {
      const outcome = await handle.outcome;
      expect(outcome).toEqual({ kind: 'backgrounded', reason: 'owner_input', taskStatus: 'running' });
    }
    // Each released call holds exactly ONE durable tool-result — the single
    // §2.2 background outcome of that wait (never a second result later).
    for (const registration of registrations) {
      const outcome = composition.seam.releasedBackgroundOutcomeOfToolCall(registration.toolCallId);
      expect(outcome?.kind).toBe('background');
      expect(outcome?.reason).toBe('owner_input');
      expect(outcome?.conversationId).toBe(owner);
      expect(composition.seam.listPendingPrepared()).toEqual([]);
      // The row projection ran for every released wait (stop-cascade safety).
      expect(promoted).toContain(registration.taskId);
    }
    // The other session's wait was NOT touched by the owner input: it is
    // still parked foreground (never settled, never released).
    expect(foreignHandle.isForeground()).toBe(true);
    expect(composition.seam.getWait('native-wait:other-session:foreign-turn:foreign_call')).toMatchObject(
      { state: 'foreground' },
    );
    expect(
      composition.seam.releasedBackgroundOutcomeOfToolCall('foreign_call'),
    ).toBeUndefined();
    // ...and the foreign conversation releases separately.
    const foreignRelease = await composition.control.onCommittedSteer({
      parentConversationId: foreign,
    });
    expect(foreignRelease?.released).toHaveLength(1);
    expect(await foreignHandle.outcome).toMatchObject({ kind: 'backgrounded' });
  });
});
