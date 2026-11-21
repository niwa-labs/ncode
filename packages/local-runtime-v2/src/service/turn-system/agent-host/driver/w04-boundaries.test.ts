/**
 * W04 test wave — durable turn-driver boundary gaps (U11/U13/U25).
 *
 * Companion of `durable-turn-driver.test.ts` (part B conformance). This file
 * pins the W04 T-items the conformance suite leaves open
 * (port-plan.md:733):
 *
 * - **abort during prepare** — a run blocked in a threshold compaction wait
 *   aborts with zero provider requests and an `unanswered` queue settlement;
 * - **deferred provider recovery** — a crash between deferred polls recovers
 *   from the durable `poll` checkpoint and fetches strictly later (never a
 *   naked re-request);
 * - **V-L06 one-at-a-time across the boundary** — once a boundary PLACED an
 *   input for the pending step, the next prepare does not re-poll, so a
 *   late-arriving steer never joins the same request (one portion per
 *   request, peek consumes nothing);
 * - **I06 saved/placed/delivered are distinct** — the queue port sees the
 *   input while merely saved, the claim (placement) removes it from the
 *   queue BEFORE the request, and `done` settles only after the answer
 *   committed (provider delivery is never asserted by the queue itself);
 * - **faulted executor** — a raw executor exception settles the run `failed`
 *   without a retry storm (donor `faulted`).
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  DurableLogPort,
  PortCommit,
  PortDelta,
  PortEntry,
  PortEntryDraft,
} from '@mavis/durable-seam';

import type {
  DriverClock,
  DriverCompactionGate,
  DriverQueuePort,
  DriverQueuedInput,
  DriverSettings,
  DriverToolObligation,
  DriverTranscriptPort,
  TurnDriverEvent,
  TurnStepExecutor,
  TurnStepReport,
} from './driver-contracts.js';
import { DurableTurnDriver, type DurableTurnDriverDeps } from './durable-turn-driver.js';
import { DurableTurnDriverStore } from './turn-driver-store.js';

// ---------------------------------------------------------------------------
// Minimal doubles (same contracts as the part-B conformance suite)
// ---------------------------------------------------------------------------

class MemoryLogPort implements DurableLogPort {
  #entries: PortEntry[] = [];
  #head = 0;

  appendBatch(entries: readonly PortEntryDraft[]): Promise<PortCommit> {
    const seq = this.#head + 1;
    this.#head = seq;
    this.#entries.push(...entries.map((draft, ordinal) => ({ ...draft, seq, ordinal })));
    return Promise.resolve({ seq, head: this.#head, entryCount: entries.length });
  }

  getEntry(entryId: string): PortEntry | undefined {
    return this.#entries.find((entry) => entry.id === entryId);
  }

  readDeltaChecked(afterSeq: number, _limitBytes: number): PortDelta {
    const entries = this.#entries.filter((entry) => entry.seq > afterSeq);
    return { entries, nextAfterSeq: null, tornTail: null };
  }

  head(): number {
    return this.#head;
  }
}

class ManualClock implements DriverClock {
  #now = 1_000;
  readonly #sleepers = new Set<{
    readonly until: number;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly signal: AbortSignal;
  }>();

  nowMs(): number {
    return this.#now;
  }

  sleepUntil(untilMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sleeper = { until: untilMs, resolve, reject, signal };
      this.#sleepers.add(sleeper);
      signal.addEventListener(
        'abort',
        () => {
          this.#sleepers.delete(sleeper);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true },
      );
      if (untilMs <= this.#now) this.#wake(sleeper);
    });
  }

  async advance(ms: number): Promise<void> {
    this.#now += ms;
    for (const sleeper of [...this.#sleepers].sort((a, b) => a.until - b.until)) {
      if (sleeper.until <= this.#now) this.#wake(sleeper);
    }
    await Promise.resolve();
  }

  #wake(sleeper: { readonly until: number; readonly resolve: () => void }): void {
    this.#sleepers.delete(sleeper);
    sleeper.resolve();
  }
}

/** Records everything the driver did to the queue, in order (I06 timeline). */
class RecordingQueue implements DriverQueuePort {
  queued: DriverQueuedInput[] = [];
  readonly timeline: Array<
    | { readonly op: 'peek'; readonly visible: readonly string[] }
    | { readonly op: 'claim'; readonly ids: readonly string[] }
    | { readonly op: 'settle'; readonly ids: readonly string[]; readonly status: string }
    | { readonly op: 'withdraw'; readonly reason: string }
  > = [];
  readonly claimed: string[] = [];
  readonly settled: { id: string; status: string; reason?: string }[] = [];
  withdrawn: string[] = [];

  peek(): Promise<readonly DriverQueuedInput[]> {
    const visible = [...this.queued];
    this.timeline.push({ op: 'peek', visible: visible.map((item) => item.id) });
    return Promise.resolve(visible);
  }

  claim(_conversationId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (!this.queued.some((item) => item.id === id)) throw new Error(`Queue claim of absent id ${id}`);
      this.claimed.push(id);
    }
    this.queued = this.queued.filter((item) => !ids.includes(item.id));
    this.timeline.push({ op: 'claim', ids: [...ids] });
    return Promise.resolve();
  }

  settle(
    _conversationId: string,
    ids: readonly string[],
    settlement: { readonly status: string; readonly reason?: string },
  ): Promise<void> {
    for (const id of ids) this.settled.push({ id, status: settlement.status, reason: settlement.reason });
    this.timeline.push({ op: 'settle', ids: [...ids], status: settlement.status });
    return Promise.resolve();
  }

  withdrawQueued(_conversationId: string, reason: string): Promise<void> {
    this.withdrawn.push(reason);
    this.queued = [];
    this.timeline.push({ op: 'withdraw', reason });
    return Promise.resolve();
  }
}

class FakeTranscript implements DriverTranscriptPort {
  entries: { id: string; kind: 'user' | 'assistant' | 'toolResult'; forCallId?: string }[] = [];
  synthetic: { callId: string; code: string }[] = [];
  continuations: unknown[] = [];

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
    return this.entries.find((entry) => entry.kind === 'toolResult' && entry.forCallId === callId)?.id;
  }

  async appendSyntheticToolResult(input: { readonly callId: string; readonly code: string }): Promise<string> {
    this.synthetic.push({ callId: input.callId, code: input.code });
    const id = `synthetic-${input.callId}`;
    this.entries.push({ id, kind: 'toolResult', forCallId: input.callId });
    return id;
  }

  async appendContinuationUserEntry(_conversationId: string, content: unknown): Promise<string> {
    this.continuations.push(content);
    return `continuation-${this.continuations.length}`;
  }
}

/** A gate whose `wait` parks until the test finishes it (or aborts). */
class ControllableCompactionGate implements DriverCompactionGate {
  thresholdVerdicts: Array<'blocking' | 'background' | undefined> = [];
  started: { taskId: string; reason: string }[] = [];
  #finished = new Set<string>();
  #waiters = new Set<{ taskId: string; resolve: () => void }>();

  threshold(): Promise<'blocking' | 'background' | undefined> {
    return Promise.resolve(this.thresholdVerdicts.shift());
  }

  start(input: { readonly reason: string }): Promise<string> {
    const taskId = `compaction-${this.started.length + 1}`;
    this.started.push({ taskId, reason: input.reason });
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

/** Executor with per-scenario step scripts and observable claimed inputs. */
class RecordingExecutor implements TurnStepExecutor {
  readonly executorId = 'mavis.agent-core.pi-turn-loop';
  readonly stepClaims: readonly string[][] = [];
  readonly fetchHandles: string[] = [];
  readonly fetchAt: number[] = [];
  #steps: TurnStepReport[] = [];
  #fetches: TurnStepReport[] = [];
  #onStepStart: (() => void) | undefined;
  #onAdvance: (() => void) | undefined;
  #stepError: Error | undefined;
  #now: () => number = () => Date.now();

  /** Observe the driver's manual clock (fetch timestamps stay deterministic). */
  useClock(clock: { nowMs(): number }): this {
    this.#now = () => clock.nowMs();
    return this;
  }

  /** Hook fired inside every advanceToolRound call (round steps AND finishTurn). */
  onAdvance(hook: () => void): this {
    this.#onAdvance = hook;
    return this;
  }

  scriptSteps(steps: readonly TurnStepReport[]): this {
    this.#steps = [...steps];
    return this;
  }

  /** Make the next executeStep throw (a crashed executor, not a classified error). */
  failNextStep(error: Error): this {
    this.#stepError = error;
    return this;
  }

  scriptFetches(fetches: readonly TurnStepReport[]): this {
    this.#fetches = [...fetches];
    return this;
  }

  onStepStart(hook: () => void): this {
    this.#onStepStart = hook;
    return this;
  }

  executeStep(request: Parameters<TurnStepExecutor['executeStep']>[0]): Promise<TurnStepReport> {
    this.#onStepStart?.();
    (this.stepClaims as string[][]).push(request.claimed.map((item) => item.id));
    if (this.#stepError !== undefined) return Promise.reject(this.#stepError);
    const report = this.#steps.shift();
    if (report === undefined) return Promise.reject(new Error('RecordingExecutor: no step scripted'));
    return Promise.resolve(report);
  }

  advanceToolRound(
    request: Parameters<TurnStepExecutor['advanceToolRound']>[0],
  ): ReturnType<TurnStepExecutor['advanceToolRound']> {
    this.#onAdvance?.();
    return Promise.resolve({ obligations: request.obligations });
  }

  fetchDeferred(request: Parameters<TurnStepExecutor['fetchDeferred']>[0]): Promise<TurnStepReport> {
    this.fetchHandles.push(request.handle.id);
    this.fetchAt.push(this.#now());
    const report = this.#fetches.shift();
    if (report === undefined) return Promise.reject(new Error('RecordingExecutor: no fetch scripted'));
    return Promise.resolve(report);
  }

  async cancelDeferred(): Promise<void> {
    /* not used in these scenarios */
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SETTINGS: DriverSettings = {
  queue: { steeringMode: 'first', followUpMode: 'first' },
  retry: { enabled: true, maxRetries: 2, initialDelayMs: 100, backoffFactor: 2 },
  afterFailedRun: 'keep',
};

interface BoundaryHarness {
  readonly driver: DurableTurnDriver;
  readonly executor: RecordingExecutor;
  readonly queue: RecordingQueue;
  readonly transcript: FakeTranscript;
  readonly clock: ManualClock;
  readonly store: DurableTurnDriverStore;
  readonly gate: ControllableCompactionGate;
  readonly events: TurnDriverEvent[];
}

function boundaryHarness(options?: { readonly settings?: DriverSettings }): BoundaryHarness {
  const port = new MemoryLogPort();
  const store = new DurableTurnDriverStore(port as never);
  const executor = new RecordingExecutor();
  const queue = new RecordingQueue();
  const transcript = new FakeTranscript();
  const clock = new ManualClock();
  const gate = new ControllableCompactionGate();
  const events: TurnDriverEvent[] = [];
  const deps: DurableTurnDriverDeps = {
    store,
    executor,
    queue,
    transcript,
    compaction: gate,
    settings: options?.settings ?? SETTINGS,
    clock,
    resolveModel: async () => ({
      model: { providerId: 'p', modelId: 'm' },
      thinkingLevel: 'medium',
      streamOptions: { maxTokens: 1024 },
    }),
    events: (event) => events.push(event),
  };
  return { driver: new DurableTurnDriver(deps), executor, queue, transcript, clock, store, gate, events };
}

async function boundaryStart(h: BoundaryHarness, inputs: readonly string[] = ['sub-1']): Promise<void> {
  await h.driver.bind('conv');
  h.transcript.entries.push({ id: 'entry-user', kind: 'user' });
  await h.driver.startRun({ conversationId: 'conv', runId: 'run-1', inputs: [...inputs] });
}

async function boundarySettle(
  h: BoundaryHarness,
  drive: Promise<import('./driver-contracts.js').TurnDriverRunOutcome>,
): Promise<import('./driver-contracts.js').TurnDriverRunOutcome> {
  for (let round = 0; round < 200; round += 1) {
    const raced = await Promise.race([
      drive.then((outcome) => ({ settled: true as const, outcome })),
      new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 0)),
    ]);
    if (raced.settled) return raced.outcome;
    await h.clock.advance(100);
  }
  throw new Error('drive did not settle under the manual clock');
}

const answer = (entryId: string): TurnStepReport => ({ kind: 'answer', assistantEntryId: entryId, stopReason: 'stop' });
const settledToolRound = (assistantEntryId: string, callId: string): TurnStepReport => ({
  kind: 'toolRound',
  assistantEntryId,
  obligations: [{ callId, name: 'task', state: 'settled', resultEntryId: `t-${callId}` }],
  pending: [],
});

// ---------------------------------------------------------------------------
// W04 T: abort during prepare
// ---------------------------------------------------------------------------

describe('W04 boundaries: abort during a blocking prepare (compaction wait)', () => {
  it('aborts with zero provider requests and an unanswered queue settlement', async () => {
    const h = boundaryHarness();
    // The FIRST prepare blocks on a threshold compaction that never finishes
    // until the test aborts; the second prepare (never reached) is ungated.
    h.gate.thresholdVerdicts.push('blocking', undefined);
    await boundaryStart(h);
    h.executor.scriptSteps([answer('a-1')]);

    const drive = h.driver.drive('conv');
    // The run parks inside the compaction wait of the prepare phase.
    await vi.waitFor(() => {
      const checkpoint = h.store.readCheckpoint('conv');
      expect(checkpoint?.phase).toBe('prepare');
      expect((checkpoint as { compacted?: unknown }).compacted).toBeDefined();
      expect(h.gate.started).toHaveLength(1);
    });

    const outcome = await h.driver.abort('conv');

    expect(outcome).toEqual({ status: 'aborted' });
    await expect(drive).resolves.toEqual({ status: 'aborted' });
    // No provider request was ever sent (abort during prepare).
    expect(h.executor.stepClaims).toEqual([]);
    // The admitted input is settled unanswered with the abort reason.
    expect(h.queue.settled).toEqual([{ id: 'sub-1', status: 'unanswered', reason: 'aborted' }]);
    expect(h.store.readCheckpoint('conv')?.phase).toBe('settled');
  });
});

// ---------------------------------------------------------------------------
// W04 T: deferred provider recovery
// ---------------------------------------------------------------------------

describe('W04 boundaries: deferred provider recovery (poll checkpoint)', () => {
  async function plantPollCheckpoint(h: BoundaryHarness, pollAt: number): Promise<void> {
    const view = h.store.read('conv');
    await h.store.save({
      conversationId: 'conv',
      expectedRevision: view.revision,
      checkpoint: {
        phase: 'poll',
        conversationId: 'conv',
        runId: 'run-1',
        attempt: 1,
        inputs: ['sub-1'],
        model: { providerId: 'p', modelId: 'm' },
        cutoff: 'entry-user',
        handle: { id: 'd-9', pollAfterMs: 100 },
        pollAt,
      },
    });
  }

  it('recovers a poll checkpoint and fetches strictly later — never a fresh request', async () => {
    const h = boundaryHarness();
    h.executor.useClock(h.clock);
    await h.driver.bind('conv');
    h.transcript.entries.push({ id: 'entry-user', kind: 'user' });
    // Crash AFTER the deferred handle was committed, BEFORE the poll fired.
    await plantPollCheckpoint(h, h.clock.nowMs() + 100);

    const recovery = await h.driver.recover('conv');
    expect(recovery.phase).toBe('poll');
    expect(recovery.actions).toEqual(['poll:resume']);

    h.executor.scriptFetches([answer('a-1')]);
    const drive = h.driver.drive('conv');
    // The poll sleeps until the DURABLE pollAt — no fetch happens before it.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.executor.fetchHandles).toEqual([]);
    await h.clock.advance(200);
    const outcome = await drive;

    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    // The frozen handle is re-fetched at/after pollAt — no naked re-request.
    expect(h.executor.fetchHandles).toEqual(['d-9']);
    expect(h.executor.fetchAt[0]).toBeGreaterThanOrEqual(1_100);
    expect(h.executor.stepClaims).toEqual([]);
    expect(h.queue.settled).toEqual([{ id: 'sub-1', status: 'done' }]);
  });
});

// ---------------------------------------------------------------------------
// V-L06: one-at-a-time across the boundary placement
// ---------------------------------------------------------------------------

describe('W04 boundaries: prepare re-poll guard when a placement is pending (V-L06)', () => {
  it('a steer placed by the boundary is NOT joined by a later steer in the same request', async () => {
    const h = boundaryHarness();
    await boundaryStart(h, []);
    // Step 1 settles a task tool; the finishTurn round ends natively.
    h.executor.scriptSteps([settledToolRound('a-1', 'task-1'), answer('a-2'), answer('a-3')]);
    // q-1 arrives DURING step 1 (before its postTools boundary) — exactly once.
    let q1Arrived = false;
    h.executor.onStepStart(() => {
      if (!q1Arrived && h.executor.stepClaims.length === 0) {
        q1Arrived = true;
        h.queue.queued.push({ id: 'q-1', mode: 'steer', content: 'first steer' });
      }
    });

    // q-2 lands inside the finishTurn advance — i.e. AFTER step 1 but BEFORE
    // the postTools boundary peek — so it is already queued when run#2's
    // prepare runs; the pending-placement guard must keep it out of step 2.
    let q2Arrived = false;
    h.executor.onAdvance(() => {
      if (!q2Arrived) {
        q2Arrived = true;
        h.queue.queued.push({ id: 'q-2', mode: 'steer', content: 'second steer' });
      }
    });

    const drive = h.driver.drive('conv');
    const outcome = await boundarySettle(h, drive);

    expect(outcome).toEqual({ status: 'completed', entryId: 'a-3' });
    // One portion per request: step 2 carries ONLY the placed q-1; q-2 gets
    // its own single request afterwards (never two portions in one request).
    expect(h.executor.stepClaims).toEqual([[], ['q-1'], ['q-2']]);
    expect(h.queue.claimed).toEqual(['q-1', 'q-2']);
    expect(h.queue.queued).toEqual([]);
  });

  it('peek never consumes: repeated peeks leave the queue untouched', async () => {
    const h = boundaryHarness();
    await boundaryStart(h, []);
    h.queue.queued = [{ id: 'q-1', mode: 'steer', content: 's1' }];
    for (let i = 0; i < 5; i += 1) {
      const visible = await h.queue.peek('conv');
      expect(visible.map((item) => item.id)).toEqual(['q-1']);
    }
    expect(h.queue.queued).toHaveLength(1);
    expect(h.queue.claimed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// I06: saved / placed / provider-delivered stay distinct at the boundary
// ---------------------------------------------------------------------------

describe('W04 boundaries: I06 — saved, placed and delivered are distinct states', () => {
  it('walks peek(saved) → claim(placed, before the request) → settle done(after the answer)', async () => {
    const h = boundaryHarness();
    await boundaryStart(h, []);
    h.queue.queued = [{ id: 'q-1', mode: 'steer', content: 'focus W04' }];
    let queueVisibleAtRequest: string[] | undefined;
    h.executor.onStepStart(() => {
      if (queueVisibleAtRequest === undefined) {
        // Inside the FIRST provider request: a placed input is NOT queue-visible.
        queueVisibleAtRequest = h.queue.queued.map((item) => item.id);
      }
    });
    h.executor.scriptSteps([answer('a-1')]);

    const outcome = await h.driver.drive('conv');

    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    // The input was visible to the (saved/queued) poll before the claim…
    const firstPeek = h.queue.timeline.find((entry) => entry.op === 'peek');
    expect(firstPeek).toMatchObject({ op: 'peek', visible: ['q-1'] });
    // …placed (claimed) exactly once BEFORE the request started…
    const claimIndex = h.queue.timeline.findIndex((entry) => entry.op === 'claim');
    expect(h.queue.claimed).toEqual(['q-1']);
    // …invisible to the queue while the request was in flight…
    expect(queueVisibleAtRequest).toEqual([]);
    // …and settled done only AFTER the answer committed.
    const settleIndex = h.queue.timeline.findIndex(
      (entry) => entry.op === 'settle' && entry.ids.includes('q-1'),
    );
    expect(settleIndex).toBeGreaterThan(claimIndex);
    expect(h.queue.settled).toEqual([{ id: 'q-1', status: 'done' }]);
  });

  it('a failed run settles the input unanswered — delivery is never implied', async () => {
    const h = boundaryHarness();
    await boundaryStart(h, ['sub-1']);
    h.executor.scriptSteps([
      { kind: 'error', stopReason: 'error', errorMessage: 'boom', overflow: false, retryable: false },
    ]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toMatchObject({ status: 'failed', error: 'boom' });
    expect(h.queue.settled).toEqual([{ id: 'sub-1', status: 'unanswered', reason: 'model_error' }]);
  });
});

// ---------------------------------------------------------------------------
// Fault path: a raw executor exception settles failed (no retry storm)
// ---------------------------------------------------------------------------

describe('W04 boundaries: faulted executor step', () => {
  it('settles the run failed without retrying a crashed executor', async () => {
    const h = boundaryHarness();
    await boundaryStart(h, ['sub-1']);
    h.executor.failNextStep(new Error('executor crashed'));

    const outcome = await h.driver.drive('conv');

    expect(outcome).toMatchObject({ status: 'failed', error: 'executor crashed' });
    expect(h.store.readCheckpoint('conv')?.phase).toBe('settled');
    expect(h.queue.settled).toEqual([{ id: 'sub-1', status: 'unanswered', reason: 'faulted' }]);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'driver.run.settled', status: 'failed' }),
    );
  });
});
