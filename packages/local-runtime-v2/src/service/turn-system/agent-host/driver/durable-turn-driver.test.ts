/**
 * W04 part B — durable turn-driver conformance tests.
 *
 * Donor semantics: pi-durable `harness/generation.ts` (GenerationTask, pin
 * 48c8f32) read line-by-line in this wave; every scenario below names the
 * donor behavior it pins. The executor is scripted (the W04 part A seam binds
 * the same SPI), the store runs over an in-memory DurableLogPort with the
 * same batch/dedup discipline as the sqlite-zstd port, and the clock is
 * manual, so event traces are deterministic.
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
import {
  DurableTurnDriver,
  type DurableTurnDriverDeps,
  TurnDriverError,
} from './durable-turn-driver.js';
import { DurableTurnDriverStore } from './turn-driver-store.js';

// ---------------------------------------------------------------------------
// In-memory DurableLogPort (same contract as the sqlite-zstd adapter)
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

// ---------------------------------------------------------------------------
// Manual clock
// ---------------------------------------------------------------------------

class ManualClock implements DriverClock {
  #now = 1_000;
  readonly #sleepers = new Set<{ readonly until: number; resolve: () => void; reject: (error: Error) => void; signal: AbortSignal }>();

  nowMs(): number {
    return this.#now;
  }

  sleepUntil(untilMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sleeper = {
        until: untilMs,
        resolve,
        reject,
        signal,
      };
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

  #wake(sleeper: { readonly until: number; resolve: () => void }): void {
    this.#sleepers.delete(sleeper);
    sleeper.resolve();
  }
}

// ---------------------------------------------------------------------------
// Scripted executor (the part-A seam, scripted per scenario)
// ---------------------------------------------------------------------------

interface ExecutorCall {
  readonly kind: 'step' | 'advance' | 'fetchDeferred' | 'cancelDeferred';
  readonly attempt?: number;
  readonly nextCallId?: string;
  readonly cutoff?: string;
  readonly claimedIds?: readonly string[];
}

class ScriptedExecutor implements TurnStepExecutor {
  readonly executorId: string;
  readonly calls: ExecutorCall[] = [];
  #steps: TurnStepReport[] = [];
  #fetches: TurnStepReport[] = [];
  #rounds: ((input: { nextCallId?: string; obligations: readonly DriverToolObligation[] }) => {
    obligations: readonly DriverToolObligation[];
    finishTurn?: { action: 'end' | 'continue' };
  })[] = [];
  hangFetches = 0;
  hangRounds = 0;
  cancelledDeferred = 0;

  constructor(executorId = 'mavis.agent-core.pi-turn-loop') {
    this.executorId = executorId;
  }

  /** Queue one report per executeStep call, in order. */
  scriptSteps(steps: readonly TurnStepReport[]): this {
    this.#steps = [...steps];
    return this;
  }

  scriptFetches(fetches: readonly TurnStepReport[]): this {
    this.#fetches = [...fetches];
    return this;
  }

  /** Queue one settlement per advanceToolRound call, in order. */
  scriptRounds(
    rounds: ((input: { nextCallId?: string; obligations: readonly DriverToolObligation[] }) => {
      obligations: readonly DriverToolObligation[];
      finishTurn?: { action: 'end' | 'continue' };
    })[],
  ): this {
    this.#rounds = [...rounds];
    return this;
  }

  executeStep(request: Parameters<TurnStepExecutor['executeStep']>[0]): Promise<TurnStepReport> {
    this.calls.push({
      kind: 'step',
      attempt: request.attempt,
      cutoff: request.plan.cutoff,
      claimedIds: request.claimed.map((item) => item.id),
    });
    const report = this.#steps.shift();
    if (report === undefined) return Promise.reject(new Error('ScriptedExecutor: no step scripted'));
    return Promise.resolve(report);
  }

  advanceToolRound(request: Parameters<TurnStepExecutor['advanceToolRound']>[0]): ReturnType<TurnStepExecutor['advanceToolRound']> {
    this.calls.push({ kind: 'advance', nextCallId: request.nextCallId });
    if (this.#rounds.length === 0 && this.hangRounds > 0) {
      this.hangRounds -= 1;
      return this.#hang(request.signal);
    }
    const round = this.#rounds.shift();
    if (round === undefined) {
      return Promise.resolve({ obligations: request.obligations });
    }
    return Promise.resolve(round({ nextCallId: request.nextCallId, obligations: request.obligations }));
  }

  fetchDeferred(request: Parameters<TurnStepExecutor['fetchDeferred']>[0]): Promise<TurnStepReport> {
    this.calls.push({ kind: 'fetchDeferred', attempt: request.attempt });
    if (this.#fetches.length === 0 && this.hangFetches > 0) {
      this.hangFetches -= 1;
      return this.#hang(request.signal) as Promise<TurnStepReport>;
    }
    const report = this.#fetches.shift();
    if (report === undefined) return Promise.reject(new Error('ScriptedExecutor: no fetch scripted'));
    return Promise.resolve(report);
  }

  async cancelDeferred(): Promise<void> {
    this.calls.push({ kind: 'cancelDeferred' });
    this.cancelledDeferred += 1;
  }

  /** A signal-aware never-resolving call, as the real seam must be. */
  #hang<T>(signal: AbortSignal): Promise<T> {
    return new Promise<T>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Fake queue + transcript + compaction gate
// ---------------------------------------------------------------------------

class FakeQueue implements DriverQueuePort {
  queued: DriverQueuedInput[] = [];
  claimed: string[] = [];
  settled: { id: string; status: string; reason?: string }[] = [];
  withdrawn: string[] = [];
  peekCount = 0;

  peek(): Promise<readonly DriverQueuedInput[]> {
    this.peekCount += 1;
    return Promise.resolve([...this.queued]);
  }

  claim(_conversationId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (!this.queued.some((item) => item.id === id)) throw new Error(`Queue claim of absent id ${id}`);
      this.claimed.push(id);
    }
    this.queued = this.queued.filter((item) => !ids.includes(item.id));
    return Promise.resolve();
  }

  settle(_conversationId: string, ids: readonly string[], settlement: { status: string; reason?: string }): Promise<void> {
    for (const id of ids) this.settled.push({ id, status: settlement.status, reason: settlement.reason });
    return Promise.resolve();
  }

  withdrawQueued(_conversationId: string, reason: string): Promise<void> {
    this.withdrawn.push(reason);
    this.queued = [];
    return Promise.resolve();
  }
}

interface FakeEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'toolResult' | 'system';
  readonly stopReason?: string;
  readonly toolCalls?: readonly { readonly callId: string; readonly name: string }[];
  readonly forCallId?: string;
}

class FakeTranscript implements DriverTranscriptPort {
  entries: FakeEntry[] = [];
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
    const after = this.entries.slice(index + 1);
    const assistant = after.find((entry) => entry.kind === 'assistant');
    if (assistant === undefined) return undefined;
    return {
      entryId: assistant.id,
      stopReason: assistant.stopReason ?? 'stop',
      toolCalls: assistant.toolCalls ?? [],
    };
  }

  async toolResultOf(_conversationId: string, callId: string): Promise<string | undefined> {
    return this.entries.find((entry) => entry.kind === 'toolResult' && entry.forCallId === callId)?.id;
  }

  async appendSyntheticToolResult(input: {
    readonly callId: string;
    readonly code: string;
  }): Promise<string> {
    this.synthetic.push({ callId: input.callId, code: input.code });
    const id = `synthetic-${input.callId}`;
    this.entries.push({ id, kind: 'toolResult', forCallId: input.callId });
    return id;
  }

  async appendContinuationUserEntry(_conversationId: string, content: unknown): Promise<string> {
    this.continuations.push(content);
    const id = `continuation-${this.continuations.length}`;
    this.entries.push({ id, kind: 'user' });
    return id;
  }
}

class FakeCompactionGate implements DriverCompactionGate {
  verdict: 'blocking' | 'background' | undefined;
  canCutResult = false;
  started: string[] = [];
  outcomes = new Map<string, 'completed' | 'failed' | 'aborted'>();
  private waiter: ((value: 'completed' | 'failed' | 'aborted') => void) | undefined;

  threshold(): Promise<'blocking' | 'background' | undefined> {
    return Promise.resolve(this.verdict);
  }

  start(_input: { readonly reason: string }): Promise<string> {
    const taskId = `compaction-${this.started.length + 1}`;
    this.started.push(taskId);
    return Promise.resolve(taskId);
  }

  outcome(taskId: string): Promise<{ status: 'completed' } | { status: 'failed'; error: string } | { status: 'aborted' }> {
    const outcome = this.outcomes.get(taskId) ?? 'completed';
    return Promise.resolve(outcome === 'failed' ? { status: 'failed', error: 'boom' } : { status: outcome });
  }

  wait(taskId: string): Promise<{ status: 'completed' } | { status: 'failed'; error: string } | { status: 'aborted' }> {
    const outcome = this.outcomes.get(taskId) ?? 'completed';
    if (outcome === 'completed') return Promise.resolve({ status: 'completed' });
    return this.outcome(taskId);
  }

  canCut(): Promise<boolean> {
    return Promise.resolve(this.canCutResult);
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

interface Harness {
  readonly driver: DurableTurnDriver;
  readonly executor: ScriptedExecutor;
  readonly queue: FakeQueue;
  readonly transcript: FakeTranscript;
  readonly clock: ManualClock;
  readonly store: DurableTurnDriverStore;
  readonly events: TurnDriverEvent[];
  readonly gate: FakeCompactionGate;
  hooks: DurableTurnDriverDeps['hooks'];
}

function harness(options?: { readonly settings?: DriverSettings; readonly executorId?: string }): Harness {
  const port = new MemoryLogPort();
  const store = new DurableTurnDriverStore(port as never);
  const executor = new ScriptedExecutor(options?.executorId);
  const queue = new FakeQueue();
  const transcript = new FakeTranscript();
  const clock = new ManualClock();
  const gate = new FakeCompactionGate();
  const events: TurnDriverEvent[] = [];
  const hooks: DurableTurnDriverDeps['hooks'] = {};
  const driver = new DurableTurnDriver({
    store,
    executor,
    queue,
    transcript,
    compaction: gate,
    settings: SETTINGS,
    clock,
    resolveModel: async () => ({
      model: { providerId: 'p', modelId: 'm' },
      thinkingLevel: 'medium',
      streamOptions: { maxTokens: 1024 },
    }),
    hooks,
    events: (event) => events.push(event),
  });
  return { driver, executor, queue, transcript, clock, store, events, gate, hooks };
}

async function start(h: Harness, runId = 'run-1', inputs: readonly string[] = ['sub-1']): Promise<void> {
  await h.driver.bind('conv');
  h.transcript.entries.push({ id: 'entry-user', kind: 'user' });
  await h.driver.startRun({ conversationId: 'conv', runId, inputs: [...inputs] });
}

/**
 * Pump a drive to completion against the manual clock: yield one macrotask so
 * the driver chain advances past its current await, then advance virtual time
 * in steps so sleeps scheduled at "now + delay" always reach their wake.
 */
async function settle(
  h: Harness,
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
const toolRound = (
  assistantEntryId: string,
  calls: readonly { readonly callId: string; readonly name: string }[],
  pending: readonly string[] = [],
): TurnStepReport => ({
  kind: 'toolRound',
  assistantEntryId,
  obligations: calls.map((call) => ({ callId: call.callId, name: call.name, state: 'pending' })),
  pending: pending.length > 0 ? pending : calls.map((call) => call.callId),
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('durable turn-driver: run lifecycle (donor GenerationTask)', () => {
  it('preserves an executor abort as the durable terminal outcome without retrying', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([{ kind: 'aborted' } as TurnStepReport]);
    await expect(h.driver.drive('conv')).resolves.toEqual({ status: 'aborted' });
    expect(h.store.readCheckpoint('conv')).toMatchObject({
      phase: 'settled', outcome: { status: 'aborted' },
    });
    expect(h.events.filter((event) => event.type === 'driver.run.settled')).toEqual([
      expect.objectContaining({ status: 'aborted' }),
    ]);
    expect(h.executor.calls.filter((call) => call.kind === 'step')).toHaveLength(1);
  });

  it('drives a normal answer run through prepare → request → final boundary', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([answer('a-1')]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    // Deterministic trace (W04 T: event traces).
    expect(h.events.map((event) => event.type)).toEqual([
      'driver.run.started',
      'driver.checkpoint.committed',
      'driver.prepare.completed',
      'driver.checkpoint.committed',
      'driver.request.completed',
      'driver.boundary.applied',
      'driver.checkpoint.committed',
      'driver.run.settled',
    ]);
    expect(h.queue.settled).toEqual([{ id: 'sub-1', status: 'done' }]);
    const settled = h.store.readCheckpoint('conv');
    expect(settled?.phase).toBe('settled');
  });

  it('resolves the model once per prepare and freezes the request identity', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([answer('a-1')]);
    await h.driver.drive('conv');
    const step = h.executor.calls.find((call) => call.kind === 'step');
    expect(step?.cutoff).toBe('entry-user');
  });

  it('fails closed with no_model when resolution yields nothing', async () => {
    const h = harness();
    const port = new MemoryLogPort();
    const driver = new DurableTurnDriver({
      store: new DurableTurnDriverStore(port as never),
      executor: h.executor,
      queue: h.queue,
      transcript: h.transcript,
      settings: SETTINGS,
      clock: h.clock,
      resolveModel: async () => undefined,
      events: () => undefined,
    });
    await driver.bind('conv');
    h.transcript.entries.push({ id: 'entry-user', kind: 'user' });
    await driver.startRun({ conversationId: 'conv', runId: 'run-1', inputs: ['sub-1'] });
    const outcome = await driver.drive('conv');
    expect(outcome).toMatchObject({ status: 'failed', detail: { reason: 'no_model' } });
    expect(h.queue.settled).toEqual([{ id: 'sub-1', status: 'unanswered', reason: 'no_model' }]);
  });
});

describe('durable turn-driver: single-executor invariant (§2.6 I01)', () => {
  it('refuses a second executor while a run is open, allows rebind of the same executor', async () => {
    const h = harness();
    await start(h);
    const intruder = harness({ executorId: 'pi.generation.raw' });
    // The intruder's driver shares the same durable store state through its own
    // port copy is not possible; simulate by binding through a second driver
    // over the SAME port instance.
    const second = new DurableTurnDriver({
      store: h.store,
      executor: intruder.executor,
      queue: h.queue,
      transcript: h.transcript,
      settings: SETTINGS,
      clock: h.clock,
      resolveModel: async () => ({
        model: { providerId: 'p', modelId: 'm' },
        thinkingLevel: 'medium',
        streamOptions: {},
      }),
    });
    await expect(second.bind('conv')).rejects.toMatchObject({ code: 'EXECUTOR_BOUND' });
    // The SAME executor may rebind (epoch advances).
    const binding = await h.driver.bind('conv');
    expect(binding.epoch).toBeGreaterThan(1);
  });

  it('refuses to start a second run while one is open (RUN_OPEN)', async () => {
    const h = harness();
    await start(h);
    await expect(
      h.driver.startRun({ conversationId: 'conv', runId: 'run-2', inputs: ['sub-2'] }),
    ).rejects.toMatchObject({ code: 'RUN_OPEN' });
  });

  it('refuses to start a run before binding the executor', async () => {
    const h = harness();
    h.transcript.entries.push({ id: 'entry-user', kind: 'user' });
    await expect(
      h.driver.startRun({ conversationId: 'conv', runId: 'run-1', inputs: ['sub-1'] }),
    ).rejects.toMatchObject({ code: 'NOT_BOUND' });
  });
});

describe('durable turn-driver: tool rounds (donor tools phase)', () => {
  it('runs an all-at-once round, then finishTurn continue triggers exactly one following request', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([
      { kind: 'toolRound', assistantEntryId: 'a-1', obligations: [{ callId: 'c1', name: 'bash', state: 'settled', resultEntryId: 't-1' }], pending: [] },
      answer('a-2'),
    ]);
    h.executor.scriptRounds([
      () => ({
        obligations: [{ callId: 'c1', name: 'bash', state: 'settled', resultEntryId: 't-1' }],
        finishTurn: { action: 'continue' },
      }),
    ]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-2' });
    // Exactly TWO provider-facing steps: the tool turn and ONE continuation —
    // `Continue` never adds an extra empty request on top (§2.4.3).
    expect(h.executor.calls.filter((call) => call.kind === 'step')).toHaveLength(2);
  });

  it('advances a sequential round one call at a time (donor pending semantics)', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([toolRound('a-1', [
      { callId: 'c1', name: 'bash' },
      { callId: 'c2', name: 'read' },
    ])]);
    const states: DriverToolObligation[] = [
      { callId: 'c1', name: 'bash', state: 'pending' },
      { callId: 'c2', name: 'read', state: 'pending' },
    ];
    h.executor.scriptRounds([
      ({ nextCallId, obligations }) => {
        expect(nextCallId).toBe('c1');
        return { obligations: obligations.map((o) => (o.callId === 'c1' ? { ...o, state: 'settled', resultEntryId: 't-1' } : o)) };
      },
      ({ nextCallId, obligations }) => {
        expect(nextCallId).toBe('c2');
        return { obligations: obligations.map((o) => (o.callId === 'c2' ? { ...o, state: 'settled', resultEntryId: 't-2' } : o)) };
      },
      () => ({ obligations: states.map((o) => ({ ...o, state: 'settled' as const })), finishTurn: { action: 'end' } }),
    ]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    const advances = h.executor.calls.filter((call) => call.kind === 'advance');
    expect(advances.map((call) => call.nextCallId)).toEqual(['c1', 'c2', undefined]);
  });

  it('finishTurn sees the final tool results before the boundary (§2.4.3)', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([{ kind: 'toolRound', assistantEntryId: 'a-1', obligations: [{ callId: 'c1', name: 'bash', state: 'settled', resultEntryId: 't-1' }], pending: [] }]);
    let finishSawSettled = false;
    h.executor.scriptRounds([
      ({ obligations }) => {
        finishSawSettled = obligations.every((o) => o.state === 'settled');
        return { obligations, finishTurn: { action: 'end' } };
      },
    ]);
    await h.driver.drive('conv');
    expect(finishSawSettled).toBe(true);
  });
});

describe('durable turn-driver: retry and deferred poll (donor retry/poll)', () => {
  it('backs off, increments the attempt, and retries the logical request', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([
      { kind: 'error', stopReason: 'error', errorMessage: 'rate limited', overflow: false, retryable: true },
      answer('a-1'),
    ]);
    const outcome = await settle(h, h.driver.drive('conv'));
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    expect(h.executor.calls.filter((call) => call.kind === 'step').map((call) => call.attempt)).toEqual([1, 2]);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'driver.retry.scheduled', attempt: 1, until: 1_100 }),
    );
  });

  it('never retries an overflow — a compaction gate decides the next prepare', async () => {
    const h = harness();
    h.gate.canCutResult = true;
    h.gate.outcomes.set('compaction-1', 'completed');
    await start(h);
    h.executor.scriptSteps([
      { kind: 'error', stopReason: 'error', errorMessage: 'context overflow', overflow: true, retryable: true },
      answer('a-1'),
    ]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    // Only ONE provider step happened after the compaction; no blind retry.
    expect(h.executor.calls.filter((call) => call.kind === 'step')).toHaveLength(2);
    expect(h.gate.started).toEqual(['compaction-1']);
  });

  it('fails the run when a blocking overflow compaction fails', async () => {
    const h = harness();
    h.gate.canCutResult = true;
    h.gate.outcomes.set('compaction-1', 'failed');
    await start(h);
    h.executor.scriptSteps([
      { kind: 'error', stopReason: 'error', errorMessage: 'context overflow', overflow: true, retryable: true },
    ]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toMatchObject({ status: 'failed', detail: { reason: 'model_error' } });
  });

  it('exhausts retries and settles unanswered with the afterFailedRun policy', async () => {
    const h = harness();
    h.queue.queued = [{ id: 'q-1', mode: 'followUp', content: 'later' }];
    const port = new MemoryLogPort();
    const driver = new DurableTurnDriver({
      store: new DurableTurnDriverStore(port as never),
      executor: h.executor,
      queue: h.queue,
      transcript: h.transcript,
      settings: { ...SETTINGS, retry: { enabled: true, maxRetries: 1, initialDelayMs: 100 }, afterFailedRun: 'withdraw' },
      clock: h.clock,
      resolveModel: async () => ({ model: { providerId: 'p', modelId: 'm' }, thinkingLevel: 'medium', streamOptions: {} }),
      events: () => undefined,
    });
    await driver.bind('conv');
    h.transcript.entries.push({ id: 'entry-user', kind: 'user' });
    await driver.startRun({ conversationId: 'conv', runId: 'run-1', inputs: ['sub-1'] });
    h.executor.scriptSteps([
      { kind: 'error', stopReason: 'error', errorMessage: 'e1', overflow: false, retryable: true },
      { kind: 'error', stopReason: 'error', errorMessage: 'e2', overflow: false, retryable: true },
    ]);
    const outcome = await settle(h, driver.drive('conv'));
    expect(outcome).toMatchObject({ status: 'failed', error: 'e2' });
    expect(h.queue.withdrawn).toEqual(['run_failed']);
    expect(h.queue.settled).toEqual([{ id: 'sub-1', status: 'unanswered', reason: 'model_error' }]);
  });

  it('polls a deferred response strictly later on every poll (donor pollAt+1)', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([
      { kind: 'deferred', handle: { id: 'd-1', pollAfterMs: 100 } },
    ]);
    h.executor.scriptFetches([
      { kind: 'deferred', handle: { id: 'd-1', pollAfterMs: 100 } },
      answer('a-1'),
    ]);
    const outcome = await settle(h, h.driver.drive('conv'));
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    const polls = h.events.filter((event) => event.type === 'driver.poll.scheduled');
    const pollAts = polls.map((event) => (event as { pollAt: number }).pollAt);
    expect(pollAts).toHaveLength(2);
    expect(pollAts[1]!).toBeGreaterThan(pollAts[0]!);
  });

  it('cancels a deferred response on abort while the poll hangs', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([{ kind: 'deferred', handle: { id: 'd-1', pollAfterMs: 100 } }]);
    h.executor.hangFetches = 1;
    const drive = h.driver.drive('conv');
    // The deferred fetch hangs inside the poll phase; abort must cancel it.
    await vi.waitFor(() => expect(h.store.readCheckpoint('conv')?.phase).toBe('poll'));
    await h.clock.advance(500);
    const outcome = await h.driver.abort('conv');
    expect(outcome).toEqual({ status: 'aborted' });
    expect(h.executor.cancelledDeferred).toBe(1);
    await expect(drive).resolves.toEqual({ status: 'aborted' });
  });
});

describe('durable turn-driver: queue boundaries and steering', () => {
  it('places queued steering at the final boundary and continues with exactly one request', async () => {
    const h = harness();
    await start(h);
    h.queue.queued = [
      { id: 'q-1', mode: 'steer', content: 'focus tests' },
      { id: 'q-2', mode: 'steer', content: 'second steer' },
    ];
    h.executor.scriptSteps([answer('a-1'), answer('a-2')]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-2' });
    // steeringMode 'first': the step-1 prepare re-poll claims q-1; the final
    // boundary then places q-2 for the single continuation request.
    expect(h.queue.claimed).toEqual(['q-1', 'q-2']);
    expect(h.queue.queued).toEqual([]);
    const steps = h.executor.calls.filter((call) => call.kind === 'step');
    expect(steps).toHaveLength(2);
    expect(steps[0]!.claimedIds).toEqual(['q-1']);
    expect(steps[1]!.claimedIds).toEqual(['q-2']);
  });

  it('places all steers when steeringMode is all (batch steering, §5.1 steerBatch)', async () => {
    const h = harness();
    const port = new MemoryLogPort();
    const driver = new DurableTurnDriver({
      store: new DurableTurnDriverStore(port as never),
      executor: h.executor,
      queue: h.queue,
      transcript: h.transcript,
      settings: { ...SETTINGS, queue: { steeringMode: 'all', followUpMode: 'first' } },
      clock: h.clock,
      resolveModel: async () => ({ model: { providerId: 'p', modelId: 'm' }, thinkingLevel: 'medium', streamOptions: {} }),
      events: () => undefined,
    });
    await driver.bind('conv');
    h.transcript.entries.push({ id: 'entry-user', kind: 'user' });
    await driver.startRun({ conversationId: 'conv', runId: 'run-1', inputs: ['sub-1'] });
    h.queue.queued = [
      { id: 'q-1', mode: 'steer', content: 'a' },
      { id: 'q-2', mode: 'steer', content: 'b' },
    ];
    h.executor.scriptSteps([answer('a-1'), answer('a-2')]);
    const outcome = await driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    // Batch steering (§5.1 steerBatch): both steers land atomically in ONE
    // claim for ONE request; nothing is partially visible.
    expect(h.queue.claimed).toEqual(['q-1', 'q-2']);
    const steps = h.executor.calls.filter((call) => call.kind === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.claimedIds).toEqual(['q-1', 'q-2']);
  });

  it('re-polls during prepare ONLY when the previous poll was empty (§2.5.1)', async () => {
    const h = harness();
    await start(h);
    h.queue.queued = [{ id: 'q-1', mode: 'steer', content: 's1' }];
    // Attempt 1 claims q-1, then fails retryably. q-2 arrives while attempt 1
    // is in flight; the retry's re-prepare must NOT re-poll (the previous
    // poll was non-empty), so q-2 is untouched until the final boundary.
    h.executor.scriptSteps([
      { kind: 'error', stopReason: 'error', errorMessage: 'rl', overflow: false, retryable: true },
      answer('a-1'),
      answer('a-2'),
    ]);
    const drive = h.driver.drive('conv');
    // q-2 arrives after attempt 1 claimed q-1 but before the retry wakes.
    h.queue.queued.push({ id: 'q-2', mode: 'steer', content: 's2' });
    await settle(h, drive);
    // q-2 was not consumed by the retry prepare; the final boundary claims it
    // for the continuation step — exactly once.
    expect(h.queue.claimed.filter((id) => id === 'q-2')).toEqual(['q-2']);
    const steps = h.executor.calls.filter((call) => call.kind === 'step');
    expect(steps.map((call) => call.attempt)).toEqual([1, 2, 1]);
    expect(steps[0]!.claimedIds).toEqual(['q-1']);
    expect(steps[1]!.claimedIds).toEqual([]);
    expect(steps[2]!.claimedIds).toEqual(['q-2']);
  });

  it('honours a structured admission veto with zero provider requests (§5.1)', async () => {
    const h = harness();
    h.hooks.onAdmissionCheck = async () => ({ reason: 'plugin continue:false' });
    await start(h);
    h.queue.queued = [{ id: 'q-1', mode: 'steer', content: 'go' }];
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed' });
    expect(h.executor.calls.filter((call) => call.kind === 'step')).toHaveLength(0);
    expect(h.queue.settled).toContainEqual({ id: 'q-1', status: 'unanswered', reason: 'admission_veto' });
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'driver.admission.vetoed', reason: 'plugin continue:false' }),
    );
  });

  it('onYield continuation appends one user entry only when no queue item was placed (donor answer)', async () => {
    const h = harness();
    let yields = 0;
    h.hooks.onYield = async () => {
      if (yields > 0) return undefined;
      yields += 1;
      return { continue: 'keep going' };
    };
    await start(h);
    h.executor.scriptSteps([answer('a-1'), answer('a-2')]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-2' });
    expect(h.transcript.continuations).toEqual(['keep going']);
    expect(yields).toBe(1);
  });
});

describe('durable turn-driver: abort paths (donor abort handler)', () => {
  it('converts unstarted sequential calls to aborted and started calls to unknown outcomes', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([toolRound('a-1', [
      { callId: 'c1', name: 'bash' },
      { callId: 'c2', name: 'read' },
    ])]);
    // The round's first advance marks c1 running and then hangs on the next
    // advance, so the driver is inside the tools phase when abort lands.
    h.executor.scriptRounds([
      ({ obligations }) => ({
        obligations: obligations.map((o) => (o.callId === 'c1' ? { ...o, state: 'running' } : o)),
      }),
    ]);
    h.executor.hangRounds = 1;
    const drive = h.driver.drive('conv');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const outcome = await h.driver.abort('conv');
    expect(outcome).toEqual({ status: 'aborted' });
    // c1 started (running) → unknown outcome; c2 never started → aborted.
    expect(h.transcript.synthetic).toContainEqual({ callId: 'c1', code: 'tool_outcome_unknown' });
    expect(h.transcript.synthetic).toContainEqual({ callId: 'c2', code: 'aborted' });
    expect(h.queue.settled).toEqual([{ id: 'sub-1', status: 'unanswered', reason: 'aborted' }]);
    await expect(drive).resolves.toEqual({ status: 'aborted' });
  });
});

/** Plant a `request` checkpoint as if the driver crashed mid-request. */
async function plantRequestCheckpoint(h: Harness): Promise<void> {
  const view = h.store.read('conv');
  await h.store.save({
    conversationId: 'conv',
    expectedRevision: view.revision,
    checkpoint: {
      phase: 'request',
      conversationId: 'conv',
      runId: 'run-1',
      attempt: 1,
      inputs: ['sub-1'],
      model: { providerId: 'p', modelId: 'm' },
      thinkingLevel: 'medium',
      streamOptions: { maxTokens: 1024 },
      cutoff: 'entry-user',
    },
  });
}

describe('durable turn-driver: recovery map (W04 D)', () => {
  it('a committed answer after the cutoff settles without re-executing the request', async () => {
    const h = harness();
    await start(h);
    await plantRequestCheckpoint(h);
    // Crash right after the executor committed the assistant entry.
    h.transcript.entries.push({ id: 'a-1', kind: 'assistant', stopReason: 'stop' });
    const recovery = await h.driver.recover('conv');
    expect(recovery.actions).toContain('request:assistant-committed:a-1');
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    expect(h.executor.calls).toHaveLength(0);
  });

  it('a committed tool-calling answer rebuilds the round from the transcript', async () => {
    const h = harness();
    await start(h);
    await plantRequestCheckpoint(h);
    h.transcript.entries.push(
      {
        id: 'a-1',
        kind: 'assistant',
        stopReason: 'toolUse',
        toolCalls: [
          { callId: 'c1', name: 'bash' },
          { callId: 'c2', name: 'read' },
        ],
      },
      { id: 't-1', kind: 'toolResult', forCallId: 'c1' },
    );
    const recovery = await h.driver.recover('conv');
    expect(recovery.actions).toContain('request:recover-tool-round:a-1');
    expect(recovery.actions).toContain('tools:unknown-outcome:c2');
    // c1 keeps its committed result; c2 (started, no outcome) is unknown ONCE.
    h.executor.scriptRounds([() => ({ obligations: [], finishTurn: { action: 'end' } })]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
    expect(h.transcript.synthetic).toEqual([{ callId: 'c2', code: 'tool_outcome_unknown' }]);
    expect(h.executor.calls.filter((call) => call.kind === 'step')).toHaveLength(0);
  });

  it('a request with no committed assistant resends the frozen plan with the same attempt', async () => {
    const h = harness();
    await start(h);
    await plantRequestCheckpoint(h);
    const recovery = await h.driver.recover('conv');
    expect(recovery.actions).toContain('request:resend-frozen-plan');
    h.executor.scriptSteps([answer('a-1')]);
    await h.driver.drive('conv');
    const step = h.executor.calls.find((call) => call.kind === 'step');
    expect(step?.attempt).toBe(1);
    expect(step?.cutoff).toBe('entry-user');
  });

  it('recovers a tools checkpoint: settled stay, running become unknown, pending stay runnable', async () => {
    const h = harness();
    await start(h);
    // Manually plant a tools checkpoint: c1 running (outcome lost), c2 pending.
    const view = h.store.read('conv');
    await h.store.save({
      conversationId: 'conv',
      expectedRevision: view.revision,
      checkpoint: {
        phase: 'tools',
        conversationId: 'conv',
        runId: 'run-1',
        inputs: ['sub-1'],
        assistant: 'a-1',
        obligations: [
          { callId: 'c1', name: 'bash', state: 'running' },
          { callId: 'c2', name: 'read', state: 'pending' },
        ],
        pending: ['c2'],
      },
    });
    const recovery = await h.driver.recover('conv');
    expect(recovery.actions).toContain('tools:unknown-outcome:c1');
    // The recovered round keeps c2 pending and finishes via the executor.
    h.executor.scriptRounds([
      ({ nextCallId, obligations }) => {
        expect(nextCallId).toBe('c2');
        return {
          obligations: obligations.map((o) =>
            o.callId === 'c2' ? { ...o, state: 'settled' as const, resultEntryId: 't-2' } : o,
          ),
        };
      },
      () => ({ obligations: [], finishTurn: { action: 'end' } }),
    ]);
    const outcome = await h.driver.drive('conv');
    expect(outcome).toEqual({ status: 'completed', entryId: 'a-1' });
  });

  it('recover of an idle conversation is a no-op', async () => {
    const h = harness();
    const recovery = await h.driver.recover('conv');
    expect(recovery).toEqual({ conversationId: 'conv', phase: 'idle', actions: [] });
  });

  it('recover of a settled run reports the terminal status without effects', async () => {
    const h = harness();
    await start(h);
    h.executor.scriptSteps([answer('a-1')]);
    await h.driver.drive('conv');
    const callsAfterDrive = h.executor.calls.length;
    const recovery = await h.driver.recover('conv');
    expect(recovery.actions).toEqual(['settled:completed']);
    expect(h.executor.calls).toHaveLength(callsAfterDrive);
  });
});

describe('durable turn-driver: store discipline', () => {
  it('rejects a concurrent writer by revision CAS', async () => {
    const h = harness();
    await start(h);
    const view = h.store.read('conv');
    // A first writer takes the next revision behind the driver's back.
    await h.store.save({
      conversationId: 'conv',
      expectedRevision: view.revision,
      checkpoint: {
        phase: 'settled',
        conversationId: 'conv',
        runId: 'run-1',
        outcome: { status: 'aborted' },
      },
    });
    // The driver's stale write fails closed instead of racing.
    await expect(
      h.store.save({
        conversationId: 'conv',
        expectedRevision: view.revision,
        checkpoint: {
          phase: 'settled',
          conversationId: 'conv',
          runId: 'run-1',
          outcome: { status: 'completed' },
        },
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('replays an identical crash-retry write instead of appending', async () => {
    const h = harness();
    const first = await h.store.save({
      conversationId: 'conv',
      expectedRevision: 0,
      checkpoint: {
        phase: 'prepare',
        conversationId: 'conv',
        runId: 'run-1',
        attempt: 1,
        inputs: ['sub-1'],
      },
    });
    expect(first).toEqual({ revision: 1, status: 'committed' });
    const replay = await h.store.save({
      conversationId: 'conv',
      expectedRevision: 0,
      checkpoint: {
        phase: 'prepare',
        conversationId: 'conv',
        runId: 'run-1',
        attempt: 1,
        inputs: ['sub-1'],
      },
    });
    expect(replay).toEqual({ revision: 1, status: 'replayed' });
  });

  it('driving without a run fails with NO_RUN, not with a silent no-op', async () => {
    const h = harness();
    await expect(h.driver.drive('conv')).rejects.toBeInstanceOf(TurnDriverError);
  });
});
