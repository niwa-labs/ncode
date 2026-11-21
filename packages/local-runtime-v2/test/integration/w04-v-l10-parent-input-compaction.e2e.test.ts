/**
 * W04 V-L10 / port-plan §10 scenario 2 — parent input during a foreground
 * child + background compaction, driven through the REAL W04 stack:
 *
 * - the REAL sqlite-zstd backend,
 * - the REAL wave-3 steering composition (`@mavis/durable-seam` +
 *   `@mavis/delegation-supervisor` + `@mavis/steering-control` +
 *   `@mavis/input-delivery`) — U11/U12/U13 owners,
 * - the REAL W04 durable turn-driver (`agent-host/driver`) over the SAME
 *   backend, with a test executor that stands for the (W04 part A)
 * agent-core loop and models the `task` tool as a foreground delegation.
 *
 * The scenario pins the §10 mandatory combined flow: "Parent ждёт foreground
 * child; пользователь вводит новую цель во время background compaction.
 * Durable receipt, reactive detach, effect fence, steering re-poll,
 * finishTurn continue/end и child completion не теряют ввод и не дублируют
 * tool result", plus the V-L10 boundary: durable ack → release foreground →
 * parent request, ровно один placed/user и tool result, ни одного auto
 * child-submission (u-registry U11/U12/U13 rows).
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import {
  SEAM_ENTRY_KINDS,
  sqliteZstdDurableLogPort,
  toolResultEntryId,
} from '@mavis/durable-seam';
import {
  KIND_BACKGROUNDED,
  KIND_COMPLETED,
  type SpawnDelegationResult,
} from '@mavis/delegation-supervisor';
import type { WaitOutcome } from '@mavis/steering-control';

import {
  createDelegationSteeringComposition,
  type DelegationSteeringComposition,
} from '../../src/service/turn-system/execution/steering/delegation-release-composition.js';
import {
  DurableTurnDriver,
  type DriverCompactionGate,
  type DriverQueuePort,
  type DriverQueuedInput,
  type DriverSettings,
  type DriverToolObligation,
  type DriverTranscriptPort,
  type TurnStepExecutor,
  type TurnStepReport,
} from '../../src/service/turn-system/agent-host/driver/index.js';
import { DurableTurnDriverStore } from '../../src/service/turn-system/agent-host/driver/turn-driver-store.js';

const directories: string[] = [];
const backends: SqliteZstdBackend[] = [];
const compositions: DelegationSteeringComposition[] = [];

afterEach(() => {
  while (backends.length > 0) {
    const backend = backends.pop();
    void backend?.close();
  }
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function closeCompositions(): Promise<void> {
  while (compositions.length > 0) {
    const composition = compositions.pop();
    await composition?.close();
  }
}

/** A gateway fence: engages per conversation, disengages per terminal fact. */
function gatewayFence() {
  const engaged = new Set<string>();
  const engagedConversations: string[] = [];
  const disengagedRefs: Array<{ conversationId: string; reason: string; delegationId: string }> = [];
  return {
    engagedConversations,
    disengagedRefs,
    isEngaged(conversationId: string): boolean {
      return engaged.has(conversationId);
    },
    async engage(request: { readonly parentConversationId: string }) {
      if (!engaged.has(request.parentConversationId)) {
        engaged.add(request.parentConversationId);
        engagedConversations.push(request.parentConversationId);
      }
      return { status: 'engaged' };
    },
    async disengage(request: {
      readonly parentConversationId: string;
      readonly reason: string;
      readonly refs: readonly { delegationId: string }[];
    }) {
      for (const ref of request.refs) {
        disengagedRefs.push({
          conversationId: request.parentConversationId,
          reason: request.reason,
          delegationId: ref.delegationId,
        });
      }
      engaged.delete(request.parentConversationId);
      return { status: 'disengaged' };
    },
  };
}

// ---------------------------------------------------------------------------
// The DriverQueuePort adapter over the REAL input-delivery stack (the shape
// the W10 integrator wires): peek = saved-but-unplaced deliveries, claim =
// placement (admitted), settle = terminal delivery fact on the seam.
// ---------------------------------------------------------------------------

interface SeamQueueAdapter extends DriverQueuePort {
  readonly claimLog: readonly string[];
  readonly settleLog: readonly { id: string; status: string }[];
}

function seamQueuePort(
  composition: DelegationSteeringComposition,
): SeamQueueAdapter {
  const modes = new Map<string, 'steer' | 'followUp'>();
  const accepts = new Map<string, { inputEntryId: string; commitSeq: number }>();
  const placed = new Set<string>();
  const claimLog: string[] = [];
  const settleLog: { id: string; status: string }[] = [];

  return {
    claimLog,
    settleLog,
    async peek(conversationId) {
      const visible: DriverQueuedInput[] = [];
      for (const delivery of composition.seam.listActiveDeliveries()) {
        if (delivery.conversationId !== conversationId || placed.has(delivery.requestId)) continue;
        visible.push({
          id: delivery.requestId,
          mode: modes.get(delivery.requestId) ?? 'steer',
          content: null,
        });
      }
      return visible;
    },
    async claim(conversationId, ids) {
      for (const id of ids) {
        const accept = accepts.get(id);
        const inputEntryId = accept?.inputEntryId ?? `mcode:owner-input:${conversationId}:${id}`;
        placed.add(id);
        claimLog.push(id);
        // NOTE (W10 wiring hint): placement writes no new seam commit in this
        // adapter, so the admitted fact carries NO commitSeq — the index
        // requires a strictly-advancing sequence when present.
        composition.delivery.transition(inputEntryId, 'admitted', { inputEntryId });
      }
    },
    async settle(conversationId, ids, settlement) {
      for (const id of ids) {
        settleLog.push({ id, status: settlement.status });
        const accept = accepts.get(id);
        const inputEntryId = accept?.inputEntryId ?? `mcode:owner-input:${conversationId}:${id}`;
        composition.delivery.transition(
          inputEntryId,
          settlement.status === 'done' ? 'answered' : 'unanswered',
        );
        await composition.seam.settleDelivery({ conversationId, requestId: id });
      }
    },
    async withdrawQueued(conversationId, reason) {
      for (const delivery of composition.seam.listActiveDeliveries()) {
        if (delivery.conversationId !== conversationId || placed.has(delivery.requestId)) continue;
        const accept = accepts.get(delivery.requestId);
        composition.delivery.transition(
          accept?.inputEntryId ?? delivery.inputEntryId,
          'unanswered',
        );
        await composition.seam.settleDelivery({
          conversationId,
          requestId: delivery.requestId,
        });
      }
      void reason;
    },
    /** Test-side Enter helper: the durable receipt + the projection row. */
    async enter(conversationId: string, requestId: string, content: unknown, whenBusy: 'steer' | 'followUp') {
      const saved = await composition.acceptOwnerInput({
        conversationId,
        requestId,
        content: content as never,
        whenBusy,
      });
      modes.set(requestId, whenBusy);
      accepts.set(requestId, { inputEntryId: saved.inputEntryId, commitSeq: saved.commitSeq });
      composition.delivery.register(saved.inputEntryId, {
        requestId,
        conversationId,
        target: { conversationId, kind: 'parent' },
        whenBusy,
      });
      composition.delivery.transition(saved.inputEntryId, 'saved', {
        submissionId: saved.submissionId,
        receiptEntryId: saved.inputEntryId,
        commitSeq: saved.commitSeq,
      });
      return saved;
    },
  } as SeamQueueAdapter;
}

// ---------------------------------------------------------------------------
// Transcript over the REAL backend: tool results are probed from the log
// ---------------------------------------------------------------------------

class BackendTranscript implements DriverTranscriptPort {
  constructor(private readonly backend: SqliteZstdBackend) {}
  readonly entries: Array<{ id: string; kind: 'user' | 'assistant' }> = [
    { id: 'entry-user', kind: 'user' },
  ];

  headEntryId(): Promise<string | undefined> {
    return Promise.resolve(this.entries.at(-1)?.id);
  }

  async assistantAfter(
    _conversationId: string,
    cutoff: string,
  ): Promise<
    | {
        readonly entryId: string;
        readonly stopReason: string;
        readonly toolCalls: readonly { readonly callId: string; readonly name: string }[];
      }
    | undefined
  > {
    const index = this.entries.findIndex((entry) => entry.id === cutoff);
    const assistant = this.entries.slice(index + 1).find((entry) => entry.kind === 'assistant');
    return assistant === undefined
      ? undefined
      : { entryId: assistant.id, stopReason: 'stop', toolCalls: [] };
  }

  async toolResultOf(_conversationId: string, callId: string): Promise<string | undefined> {
    // The committed fact lives in the durable log (the release finalized it).
    const entry = this.backend.getEntry(toolResultEntryId(callId));
    return entry === undefined ? undefined : entry.id;
  }

  async appendSyntheticToolResult(input: { readonly callId: string }): Promise<string> {
    throw new Error(`unexpected synthetic tool result for ${input.callId}`);
  }

  async appendContinuationUserEntry(_conversationId: string, content: unknown): Promise<string> {
    const id = `continuation-${String(content)}`;
    this.entries.push({ id, kind: 'user' });
    return id;
  }
}

// ---------------------------------------------------------------------------
// The compaction gate: run#2's prepare blocks until the test finishes it
// ---------------------------------------------------------------------------

class BlockingCompactionGate implements DriverCompactionGate {
  thresholdCalls = 0;
  readonly started: string[] = [];
  readonly #finished = new Set<string>();
  readonly #waiters = new Set<{ taskId: string; resolve: () => void }>();

  threshold(): Promise<'blocking' | undefined> {
    this.thresholdCalls += 1;
    // The SECOND prepare (run#2, after the detach) blocks: the user's new
    // goal lands while this background compaction is pending.
    return Promise.resolve(this.thresholdCalls === 2 ? 'blocking' : undefined);
  }

  start(): Promise<string> {
    const taskId = `compaction-${this.started.length + 1}`;
    this.started.push(taskId);
    return Promise.resolve(taskId);
  }

  outcome(): Promise<{ status: 'completed' }> {
    return Promise.resolve({ status: 'completed' });
  }

  wait(taskId: string, signal: AbortSignal): Promise<{ status: 'completed' }> {
    return new Promise((resolve, reject) => {
      if (this.#finished.has(taskId)) return resolve({ status: 'completed' });
      const waiter = { taskId, resolve: () => resolve({ status: 'completed' }) };
      this.#waiters.add(waiter);
      signal.addEventListener(
        'abort',
        () => {
          this.#waiters.delete(waiter);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  canCut(): Promise<boolean> {
    return Promise.resolve(true);
  }

  finish(taskId: string): void {
    this.#finished.add(taskId);
    for (const waiter of [...this.#waiters]) {
      if (waiter.taskId === taskId) {
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The executor: W04 part A loop stand-in; the `task` tool is a REAL
// delegation through the composition (spawn + foreground wait)
// ---------------------------------------------------------------------------

class DelegatingExecutor implements TurnStepExecutor {
  readonly executorId = 'mavis.agent-core.pi-turn-loop';
  readonly stepClaims: readonly string[][] = [];
  spawned: SpawnDelegationResult | undefined;
  waitOutcome: Promise<WaitOutcome> | undefined;
  readonly toolRoundAnswers: string[] = [];
  #composition: DelegationSteeringComposition;
  #handle: { outcome: Promise<WaitOutcome> } | undefined;
  #taskSettled = false;

  constructor(composition: DelegationSteeringComposition) {
    this.#composition = composition;
  }

  executeStep(request: Parameters<TurnStepExecutor['executeStep']>[0]): Promise<TurnStepReport> {
    (this.stepClaims as string[][]).push(request.claimed.map((item) => item.id));
    if (this.stepClaims.length === 1) {
      return Promise.resolve({
        kind: 'toolRound',
        assistantEntryId: 'a-1',
        obligations: [{ callId: 'task-1', name: 'task', state: 'pending' }],
        pending: ['task-1'],
      });
    }
    return Promise.resolve({ kind: 'answer', assistantEntryId: 'a-2', stopReason: 'stop' });
  }

  async advanceToolRound(
    request: Parameters<TurnStepExecutor['advanceToolRound']>[0],
  ): ReturnType<TurnStepExecutor['advanceToolRound']> {
    const obligations = [...request.obligations];
    if (request.nextCallId === 'task-1') {
      // The task tool starts: T_spawn + the foreground wait registration.
      this.spawned = await this.#composition.spawnDelegation({
        parentConversationId: 'conv-parent',
        parentRunId: 'run-1',
        toolCallId: 'task-1',
        childSpec: { prompt: 'explore W04' },
      });
      this.#handle = this.#composition.registerWait(this.spawned, {
        parentConversationId: 'conv-parent',
        parentRunId: 'run-1',
        toolCallId: 'task-1',
      });
      this.waitOutcome = this.#handle.outcome;
      return {
        obligations: obligations.map((obligation) =>
          obligation.callId === 'task-1' ? { ...obligation, state: 'running' as const } : obligation,
        ),
      };
    }
    if (!this.#taskSettled) {
      if (this.#handle === undefined) throw new Error('wait not registered before settlement');
      // The parent blocks inside the task tool until the wait resolves.
      const outcome = await raceAbort(this.#handle.outcome, request.signal);
      if (outcome.kind !== 'backgrounded') {
        throw new Error(`unexpected wait outcome ${outcome.kind} (scenario: release wins)`);
      }
      // The release committed the single background tool result; the round
      // settles against that durable fact — never a second tool result.
      this.#taskSettled = true;
      this.toolRoundAnswers.push('backgrounded');
      return {
        obligations: obligations.map((obligation) =>
          obligation.callId === 'task-1'
            ? {
                ...obligation,
                state: 'settled' as const,
                resultEntryId: toolResultEntryId('task-1'),
              }
            : obligation,
        ),
        // finishTurn END: the continuation is driven by the PLACED queue
        // item (V-L10 durable ack → release → parent request), not by an
        // extra empty request.
      };
    }
    // The finishTurn probe after the round: native end (no decision needed).
    return { obligations: obligations as DriverToolObligation[] };
  }

  async fetchDeferred(): Promise<TurnStepReport> {
    throw new Error('deferred provider responses are not part of this scenario');
  }

  async cancelDeferred(): Promise<void> {
    /* not used */
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
      { once: true },
    );
    promise.then(resolve, reject);
  });
}

// ---------------------------------------------------------------------------

const SETTINGS: DriverSettings = {
  queue: { steeringMode: 'first', followUpMode: 'first' },
  retry: { enabled: false, maxRetries: 0, initialDelayMs: 0 },
  afterFailedRun: 'keep',
};

function payloads(backend: SqliteZstdBackend, kind: string): Array<Record<string, unknown>> {
  return backend
    .readDeltaChecked(0, 512 * 1024 * 1024)
    .entries.filter((entry: { kind: string }) => entry.kind === kind)
    .map((entry: { payload: unknown }) => entry.payload as Record<string, unknown>);
}

describe('W04 V-L10 e2e: parent input during foreground child + background compaction', () => {
  it('durable receipt → reactive detach → steering re-poll → one parent request; child completion is single', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'w04-vl10-'));
    directories.push(directory);
    const backend = SqliteZstdBackend.open(directory);
    backends.push(backend);
    const fence = gatewayFence();
    const composition = await createDelegationSteeringComposition({
      backend,
      effectFence: fence as never,
    });
    compositions.push(composition);

    const store = new DurableTurnDriverStore(sqliteZstdDurableLogPort(backend));
    const transcript = new BackendTranscript(backend);
    const queue = seamQueuePort(composition);
    const gate = new BlockingCompactionGate();
    const executor = new DelegatingExecutor(composition);
    const driver = new DurableTurnDriver({
      store,
      executor,
      queue,
      transcript,
      compaction: gate,
      settings: SETTINGS,
      clock: {
        nowMs: () => Date.now(),
        sleepUntil: (untilMs, signal) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), Math.max(0, untilMs - Date.now()));
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
              },
              { once: true },
            );
          }),
      },
      resolveModel: async () => ({
        model: { providerId: 'p', modelId: 'm' },
        thinkingLevel: 'medium',
        streamOptions: {},
      }),
      events: () => undefined,
    });

    await driver.bind('conv-parent');
    await driver.startRun({ conversationId: 'conv-parent', runId: 'run-1', inputs: [] });
    const drive = driver.drive('conv-parent');

    // 1) The parent reaches the foreground child (the task tool wait).
    await vi.waitFor(() => expect(executor.spawned).toBeDefined());

    // 2) Enter DURING the pending background compaction: the durable receipt
    //    commits first (saving → saved; dequeue/ack ≠ provider delivery).
    const saved = await queue.enter('conv-parent', 'steer-1', { text: 'focus W04' }, 'steer');
    expect(saved.status).toBe('committed');
    expect(composition.delivery.get(saved.inputEntryId).state).toBe('saved');

    // 3) Reactive detach: the committed steer releases the foreground wait
    //    (auto-detach), engages the effect fence — the child keeps running.
    const release = await composition.onCommittedSteer({
      parentConversationId: 'conv-parent',
      requestId: 'steer-1',
    });
    expect(release?.released).toHaveLength(1);
    const outcome = await executor.waitOutcome;
    expect(outcome.kind).toBe('backgrounded');
    expect(fence.isEngaged('conv-parent')).toBe(true);

    // 4) The parent continues: the postTools boundary PLACES the input and
    //    run#2's prepare blocks on the background compaction threshold. The
    //    input is placed (admitted) but NOT provider-delivered yet (I06).
    await vi.waitFor(() => expect(gate.started).toHaveLength(1));
    expect(executor.stepClaims).toEqual([[]]); // request 2 has NOT started
    expect(composition.delivery.get(saved.inputEntryId).state).toBe('admitted');

    // 5) The compaction completes: the re-poll discipline keeps the placed
    //    input single, and EXACTLY ONE following request carries it.
    gate.finish(gate.started[0]!);
    const result = await drive;
    expect(result).toEqual({ status: 'completed', entryId: 'a-2' });
    expect(executor.stepClaims).toEqual([[], ['steer-1']]);
    expect(queue.claimLog).toEqual(['steer-1']);
    expect(composition.delivery.get(saved.inputEntryId)).toMatchObject({
      state: 'answered',
      active: false,
    });
    expect(queue.settleLog).toEqual([{ id: 'steer-1', status: 'done' }]);

    // 6) The child completes LATE: reporter delivery, exactly one completion
    //    and one wake-up; the fence lifts on the proven terminal fact.
    const completion = await composition.supervisor.complete({
      delegationId: executor.spawned!.delegationId,
      childRunId: 'child-run-1',
      outcome: { status: 'completed', summary: 'child done' },
    });
    expect(completion.delivery).toBe('reporter');
    expect(completion.requestId).toBe(
      `delegation:${executor.spawned!.delegationId}:completion:child-run-1`,
    );
    expect(completion.fence).toEqual({ status: 'disengaged' });
    expect(fence.isEngaged('conv-parent')).toBe(false);
    const repeat = await composition.supervisor.complete({
      delegationId: executor.spawned!.delegationId,
      childRunId: 'child-run-1',
      outcome: { status: 'completed', summary: 'child done' },
    });
    expect(repeat.replayed).toBe(true);
    expect(repeat.submissionId).toBe(completion.submissionId);

    // 7) Nothing lost, nothing duplicated (§10 scenario 2 verdict):
    //    - exactly one backgrounded record, one completion, ONE tool result
    //      for the task call (no duplicate tool result after the release);
    //    - exactly one accepted input — the parent's; the release created NO
    //      auto child-submission (V-L10).
    expect(payloads(backend, KIND_BACKGROUNDED)).toHaveLength(1);
    expect(payloads(backend, KIND_COMPLETED)).toHaveLength(1);
    expect(payloads(backend, SEAM_ENTRY_KINDS.toolResult)).toHaveLength(1);
    const receipts = payloads(backend, SEAM_ENTRY_KINDS.receipt);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ targetConversationId: 'conv-parent' });
    expect(
      receipts.filter((payload) => payload.targetConversationId === executor.spawned!.childConversationId),
    ).toHaveLength(0);

    await closeCompositions();
  });
});
