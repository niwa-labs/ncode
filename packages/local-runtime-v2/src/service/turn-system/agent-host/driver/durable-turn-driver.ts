/**
 * W04 part B — the durable turn-driver (PORT-PI-1.3 §2.4.3 A3, §2.5.1).
 *
 * ONE durable task-driver per product conversation. It owns the run's
 * durable checkpoint phases (`prepare → request → retry | poll | tools`) and
 * recovery; each logical turn/step is delegated to the agent-core loop (W04
 * part A) through the {@link TurnStepExecutor} seam. Donor semantics: pi
 * `harness/generation.ts` (`GenerationTask`, pin 48c8f32) — prepare pins the
 * model and freezes the request identity, `classify` routes to answer / tool
 * round / deferred poll / retry, boundaries place the queue, abort converts
 * unstarted calls to aborted results and never double-settles a call.
 *
 * What the driver deliberately does NOT do: it sends no provider requests,
 * executes no tools, keeps no second inbox truth (the product queue stays the
 * owner), and never starts a `pi.generation` for the same conversation — the
 * durable {@link ExecutorBinding} refuses a second executor while a run is
 * open (§2.6 I01; port-plan.md:40, :159).
 *
 * @module
 */

import type {
  DriverClock,
  DriverCompactionGate,
  DriverHooks,
  DriverQueuePort,
  DriverQueuedInput,
  DriverSettings,
  DriverToolObligation,
  DriverTranscriptPort,
  ExecutorBinding,
  TurnDriverCheckpoint,
  TurnDriverEvent,
  TurnDriverEventSink,
  TurnDriverRunOutcome,
  TurnStepExecutor,
  TurnStepReport,
} from './driver-contracts.js';
import type { TurnDriverSaveInput, TurnDriverStorePort } from './turn-driver-store.js';
import { TurnDriverStoreError } from './turn-driver-store.js';

/** Default deferred-poll delay when the provider sets none (donor: 5 s). */
export const DEFAULT_POLL_AFTER_MS = 5000;

/** Donor retry backoff: `retryDelayMs(policy, attempt)` exponential growth. */
function retryDelayMs(settings: DriverSettings, attempt: number): number {
  const { initialDelayMs, backoffFactor = 2 } = settings.retry;
  return Math.round(initialDelayMs * Math.pow(backoffFactor, Math.max(0, attempt - 1)));
}

/** Next step run id: `run`, `run#2`, `run#3`, … (donor: successor generation). */
export function nextRunId(runId: string): string {
  const [base, step] = runId.split('#');
  const n = step === undefined ? 2 : Number(step) + 1;
  return `${base}#${n}`;
}

export type TurnDriverErrorCode =
  | 'EXECUTOR_BOUND'
  | 'RUN_OPEN'
  | 'NO_RUN'
  | 'NOT_BOUND'
  | 'PHASE_MISMATCH';

export class TurnDriverError extends Error {
  override name = 'TurnDriverError';

  constructor(
    readonly code: TurnDriverErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Model resolution performed at prepare time (pinned for the request). */
export interface DriverPrepareResolution {
  readonly model: { readonly providerId: string; readonly modelId: string };
  readonly thinkingLevel: string;
  readonly streamOptions: Record<string, unknown>;
}

export interface DurableTurnDriverDeps {
  readonly store: TurnDriverStorePort;
  readonly executor: TurnStepExecutor;
  readonly queue: DriverQueuePort;
  readonly transcript: DriverTranscriptPort;
  /** Threshold/overflow compaction gate; omitted disables compaction waits. */
  readonly compaction?: DriverCompactionGate;
  readonly settings: DriverSettings;
  readonly clock: DriverClock;
  /** Resolve the run's model/thinking/options; `undefined` fails `no_model`. */
  readonly resolveModel: (conversationId: string) => Promise<DriverPrepareResolution | undefined>;
  readonly hooks?: DriverHooks;
  readonly events?: TurnDriverEventSink;
}

/** Recovery verdict of {@link DurableTurnDriver#recover}. */
export interface TurnDriverRecovery {
  readonly conversationId: string;
  readonly phase: TurnDriverCheckpoint['phase'] | 'idle';
  readonly actions: readonly string[];
}

/**
 * The durable turn-driver. Construct one per host and call {@link bind} for
 * each conversation before driving; the instance holds no per-run durable
 * state outside the store, so `drive()` is safe to re-enter after a crash or
 * restart — it resumes from whatever the durable checkpoint says.
 */
export class DurableTurnDriver {
  readonly #deps: DurableTurnDriverDeps;
  /** In-flight abort coordination per conversation (never durable state). */
  readonly #runSignals = new Map<string, AbortController>();
  /** One abort at a time per conversation; late callers join the first. */
  readonly #abortInFlight = new Map<string, Promise<TurnDriverRunOutcome>>();
  /** Steering claimed for the pending step of a conversation (advisory). */
  readonly #claimedForStep = new Map<string, readonly DriverQueuedInput[]>();

  constructor(deps: DurableTurnDriverDeps) {
    this.#deps = deps;
  }

  // -------------------------------------------------------------------------
  // Executor binding — the single-executor invariant (§2.6 I01)
  // -------------------------------------------------------------------------

  /**
   * Bind (or rebind) this driver's executor to the conversation. Fails closed
   * with `EXECUTOR_BOUND` while another executor holds an OPEN run — the
   * durable expression of "one turn executor per product conversation; an
   * ordinary `pi.generation` is not started alongside the driver".
   */
  async bind(conversationId: string): Promise<ExecutorBinding> {
    const view = this.#deps.store.read(conversationId);
    const current = view.record;
    const openRun = current?.checkpoint !== undefined && current.checkpoint.phase !== 'settled';
    if (openRun && current?.binding !== undefined && current.binding.executorId !== this.#deps.executor.executorId) {
      throw new TurnDriverError(
        'EXECUTOR_BOUND',
        `Conversation ${conversationId} is bound to executor ${current.binding.executorId} with an open run`,
      );
    }
    const binding: ExecutorBinding = {
      conversationId,
      executorId: this.#deps.executor.executorId,
      epoch: (current?.binding?.epoch ?? 0) + 1,
      boundAtMs: this.#deps.clock.nowMs(),
    };
    await this.#deps.store.save({
      conversationId,
      expectedRevision: view.revision,
      ...(current?.checkpoint === undefined ? {} : { checkpoint: current.checkpoint }),
      binding,
    });
    return binding;
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  /** Start a run for already-admitted, already-placed inputs. */
  async startRun(input: {
    readonly conversationId: string;
    readonly runId: string;
    readonly inputs: readonly string[];
  }): Promise<void> {
    const view = this.#deps.store.read(input.conversationId);
    const open = view.record?.checkpoint;
    if (open !== undefined && open.phase !== 'settled') {
      throw new TurnDriverError(
        'RUN_OPEN',
        `Conversation ${input.conversationId} already has an open run ${open.runId}`,
      );
    }
    const binding = view.record?.binding;
    if (binding?.executorId !== this.#deps.executor.executorId) {
      throw new TurnDriverError(
        'NOT_BOUND',
        `Conversation ${input.conversationId} is not bound to executor ${this.#deps.executor.executorId}; call bind() first`,
      );
    }
    this.#emit({
      type: 'driver.run.started',
      conversationId: input.conversationId,
      runId: input.runId,
      attempt: 1,
    });
    await this.#commit(input.conversationId, view.revision, {
      phase: 'prepare',
      conversationId: input.conversationId,
      runId: input.runId,
      attempt: 1,
      inputs: [...input.inputs],
    });
  }

  /**
   * Drive the conversation's open run to a terminal outcome. Re-entrant: it
   * resumes from the durable checkpoint, never from memory, so a restart
   * between phases cannot re-run an effect blindly.
   */
  async drive(conversationId: string): Promise<TurnDriverRunOutcome> {
    for (;;) {
      const view = this.#deps.store.read(conversationId);
      const checkpoint = view.record?.checkpoint;
      if (checkpoint === undefined) throw new TurnDriverError('NO_RUN', `No driver run for ${conversationId}`);
      if (checkpoint.phase === 'settled') return checkpoint.outcome;
      try {
        switch (checkpoint.phase) {
          case 'prepare':
            await this.#prepare(conversationId, view.revision, checkpoint);
            continue;
          case 'request':
            return await this.#request(conversationId, checkpoint);
          case 'retry':
            await this.#sleepUntil(conversationId, checkpoint.until);
            await this.#commit(conversationId, view.revision, {
              phase: 'prepare',
              conversationId,
              runId: checkpoint.runId,
              attempt: checkpoint.attempt + 1,
              inputs: checkpoint.inputs,
              ...(checkpoint.compacted === undefined ? {} : { compacted: checkpoint.compacted }),
              ...(checkpoint.lastPollEmpty === undefined ? {} : { lastPollEmpty: checkpoint.lastPollEmpty }),
            });
            continue;
          case 'poll':
            await this.#sleepUntil(conversationId, checkpoint.pollAt);
            return await this.#requestDeferred(conversationId, checkpoint);
          case 'tools':
            return await this.#tools(conversationId, checkpoint);
        }
      } catch (error) {
        if (this.#signalOf(conversationId).signal.aborted) {
          return this.abort(conversationId);
        }
        // A phase fault settles the run unanswered/faulted (donor scheduler
        // `faulted`); it never leaves a half-open checkpoint behind.
        const text = error instanceof Error ? error.message : String(error);
        const settled = await this.#settleFailed(conversationId, text, 'faulted');
        if (settled !== undefined) return settled;
        throw error;
      }
    }
  }

  /** Abort the open run: donor `abort` handler, adapted to the seam. */
  async abort(conversationId: string, reason = 'aborted'): Promise<TurnDriverRunOutcome> {
    this.#signalOf(conversationId).abort(new Error(reason));
    // Serialize aborts: a drive whose awaited executor call rejected on the
    // abort signal joins the caller's in-flight abort instead of racing it
    // (one settle, one deferred cancellation — never two).
    const inFlight = this.#abortInFlight.get(conversationId);
    if (inFlight !== undefined) return inFlight;
    const operation = this.#runAbort(conversationId, reason);
    this.#abortInFlight.set(conversationId, operation);
    try {
      return await operation;
    } finally {
      this.#abortInFlight.delete(conversationId);
    }
  }

  async #runAbort(conversationId: string, reason: string): Promise<TurnDriverRunOutcome> {
    const view = this.#deps.store.read(conversationId);
    const checkpoint = view.record?.checkpoint;
    if (checkpoint === undefined) throw new TurnDriverError('NO_RUN', `No driver run for ${conversationId}`);
    if (checkpoint.phase === 'settled') return checkpoint.outcome;
    if (checkpoint.phase === 'poll') {
      await this.#deps.executor.cancelDeferred?.({
        conversationId,
        model: checkpoint.model,
        handle: checkpoint.handle,
        signal: new AbortController().signal,
      });
    }
    if (checkpoint.phase === 'tools') {
      // Never-started calls get `aborted` results; started-but-unsettled calls
      // get TOOL_OUTCOME_UNKNOWN — never an auto-retry of a writing effect
      // (§2.6 I07). Each callId receives exactly one outcome.
      for (const obligation of checkpoint.obligations) {
        if (obligation.state === 'settled') continue;
        const settled = await this.#deps.transcript.toolResultOf(conversationId, obligation.callId);
        if (settled !== undefined) continue;
        const started = obligation.state !== 'pending';
        await this.#deps.transcript.appendSyntheticToolResult({
          conversationId,
          callId: obligation.callId,
          name: obligation.name,
          isError: true,
          code: started ? 'tool_outcome_unknown' : 'aborted',
          message: started
            ? `Tool ${obligation.name} outcome is unknown after abort`
            : `Tool ${obligation.name} was aborted`,
        });
      }
    }
    try {
      return await this.#endRun(
        conversationId,
        view.revision,
        checkpoint,
        { status: 'unanswered', reason },
        { status: 'aborted' },
      );
    } catch (error) {
      // A concurrent abort invocation may have settled this run first; the
      // loser replays the settled outcome instead of racing the CAS.
      if (error instanceof TurnDriverStoreError && error.code === 'REVISION_CONFLICT') {
        const settled = this.#deps.store.readCheckpoint(conversationId);
        if (settled?.phase === 'settled') return settled.outcome;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Map the durable checkpoint to committed transcript state and pending tool
   * obligations after a restart (W04 D: recovery map). Effects already
   * committed are NEVER repeated: a committed assistant after the cutoff
   * re-classifies from the transcript; a tool obligation without a committed
   * outcome becomes TOOL_OUTCOME_UNKNOWN exactly once and is never retried; a
   * request with no committed assistant resends the frozen plan (transport
   * resend semantics, not a naked rerun).
   */
  async recover(conversationId: string): Promise<TurnDriverRecovery> {
    const view = this.#deps.store.read(conversationId);
    const checkpoint = view.record?.checkpoint;
    if (checkpoint === undefined) {
      return { conversationId, phase: 'idle', actions: [] };
    }
    const actions: string[] = [];
    switch (checkpoint.phase) {
      case 'settled':
        actions.push(`settled:${checkpoint.outcome.status}`);
        break;
      case 'prepare':
      case 'retry':
      case 'poll':
        actions.push(`${checkpoint.phase}:resume`);
        break;
      case 'request': {
        const assistant = await this.#deps.transcript.assistantAfter(conversationId, checkpoint.cutoff);
        if (assistant === undefined) {
          actions.push('request:resend-frozen-plan');
        } else if (assistant.toolCalls.length > 0) {
          const obligations = await this.#reconcileObligations(conversationId, assistant.toolCalls, actions);
          actions.push(`request:recover-tool-round:${assistant.entryId}`);
          await this.#commit(conversationId, view.revision, {
            phase: 'tools',
            conversationId,
            runId: checkpoint.runId,
            inputs: checkpoint.inputs,
            assistant: assistant.entryId,
            obligations,
            pending: [],
          });
        } else {
          actions.push(`request:assistant-committed:${assistant.entryId}`);
          await this.#commit(conversationId, view.revision, {
            phase: 'settled',
            conversationId,
            runId: checkpoint.runId,
            outcome: { status: 'completed', entryId: assistant.entryId },
          });
        }
        break;
      }
      case 'tools': {
        const obligations = await this.#reconcileObligations(conversationId, checkpoint.obligations, actions);
        await this.#commit(conversationId, view.revision, {
          phase: 'tools',
          conversationId,
          runId: checkpoint.runId,
          inputs: checkpoint.inputs,
          assistant: checkpoint.assistant,
          obligations,
          pending: checkpoint.pending.filter((id) =>
            obligations.some((o) => o.callId === id && o.state === 'pending'),
          ),
        });
        actions.push('tools:redrive-round');
        break;
      }
    }
    this.#emit({ type: 'driver.recovered', conversationId, phase: checkpoint.phase, actions });
    return { conversationId, phase: checkpoint.phase, actions };
  }

  /**
   * Reconcile obligations against the committed transcript: a committed
   * result settles the call; a started-but-lost outcome gets a synthetic
   * TOOL_OUTCOME_UNKNOWN (exactly once, never retried); a not-started
   * sequential call stays `pending` so the round may still run it.
   */
  async #reconcileObligations(
    conversationId: string,
    calls: readonly { readonly callId: string; readonly name: string; readonly state?: DriverToolObligation['state'] }[],
    actions: string[],
  ): Promise<readonly DriverToolObligation[]> {
    const obligations: DriverToolObligation[] = [];
    for (const call of calls) {
      const resultEntryId = await this.#deps.transcript.toolResultOf(conversationId, call.callId);
      if (resultEntryId !== undefined) {
        obligations.push({ callId: call.callId, name: call.name, state: 'settled', resultEntryId });
        continue;
      }
      const started = call.state !== 'pending';
      if (started) {
        await this.#deps.transcript.appendSyntheticToolResult({
          conversationId,
          callId: call.callId,
          name: call.name,
          isError: true,
          code: 'tool_outcome_unknown',
          message: `Tool ${call.name} outcome is unknown after restart`,
        });
        actions.push(`tools:unknown-outcome:${call.callId}`);
        obligations.push({ callId: call.callId, name: call.name, state: 'settled' });
      } else {
        obligations.push({ callId: call.callId, name: call.name, state: 'pending' });
      }
    }
    return obligations;
  }

  // -------------------------------------------------------------------------
  // Phases — donor GenerationTask, adapted
  // -------------------------------------------------------------------------

  /** Donor `prepare`: resolve model, gate compaction, freeze the request. */
  async #prepare(
    conversationId: string,
    revision: number,
    checkpoint: Extract<TurnDriverCheckpoint, { phase: 'prepare' }>,
  ): Promise<void> {
    // A blocking compaction's outcome is checked exactly once on resume.
    if (checkpoint.compacted !== undefined) {
      const outcome = await this.#deps.compaction?.outcome(checkpoint.compacted.taskId);
      const blocking = checkpoint.compacted.overflow !== undefined || checkpoint.compacted.threshold === true;
      if (blocking && outcome?.status !== 'completed') {
        const text =
          outcome === undefined
            ? (checkpoint.compacted.overflow ?? 'Blocking compaction did not complete')
            : outcome.status === 'failed'
              ? `Compaction failed: ${outcome.error}`
              : 'Compaction was aborted';
        await this.#failRun(conversationId, revision, checkpoint, text, 'model_error');
        return;
      }
    }
    const resolution = await this.#deps.resolveModel(conversationId);
    if (resolution === undefined) {
      await this.#failRun(conversationId, revision, checkpoint, 'No model is configured', 'no_model');
      return;
    }
    // Threshold gating (donor §8.3): a blocking compaction re-enters prepare.
    const gate = this.#deps.compaction;
    const threshold = await gate?.threshold({ conversationId, model: resolution.model });
    if (gate !== undefined && threshold === 'blocking') {
      const taskId = await gate.start({ conversationId, reason: 'threshold' });
      await this.#commit(conversationId, revision, {
        phase: 'prepare',
        conversationId,
        runId: checkpoint.runId,
        attempt: checkpoint.attempt,
        inputs: checkpoint.inputs,
        compacted: { taskId, threshold: true },
        ...(checkpoint.lastPollEmpty === undefined ? {} : { lastPollEmpty: checkpoint.lastPollEmpty }),
      });
      await gate.wait(taskId, this.#signalOf(conversationId).signal);
      return;
    }
    // Queue re-poll discipline (§2.5.1 NX): a re-poll happens ONLY when the
    // previous poll was empty and no boundary placement is still pending for
    // this step, so one-at-a-time consumption never doubles.
    let claimedIds: readonly string[] = [];
    let lastPollEmpty = checkpoint.lastPollEmpty;
    const pendingPlacement = this.#claimedForStep.get(conversationId) ?? [];
    if (checkpoint.lastPollEmpty !== false && pendingPlacement.length === 0) {
      const queued = await this.#deps.queue.peek(conversationId);
      const steers = queued.filter((item) => item.mode === 'steer');
      if (steers.length > 0) {
        const picked = this.#deps.settings.queue.steeringMode === 'all' ? steers : steers.slice(0, 1);
        await this.#deps.queue.claim(
          conversationId,
          picked.map((item) => item.id),
        );
        this.#claimedForStep.set(conversationId, [...pendingPlacement, ...picked]);
        claimedIds = picked.map((item) => item.id);
        lastPollEmpty = false;
        this.#emit({
          type: 'driver.queue.repolled',
          conversationId,
          runId: checkpoint.runId,
          reason: 'prepare-long',
        });
      } else {
        lastPollEmpty = true;
      }
    }
    // Post-steering admission veto (§5.1 `shouldStopAfterSteering`): a
    // structured veto AFTER dequeue, BEFORE placement effects or any next
    // request — graceful agent_end, zero new provider requests.
    if (claimedIds.length > 0) {
      const veto = await this.#deps.hooks?.onAdmissionCheck?.({
        conversationId,
        claimed: this.#claimedForStep.get(conversationId) ?? [],
      });
      if (veto !== undefined) {
        this.#emit({
          type: 'driver.admission.vetoed',
          conversationId,
          runId: checkpoint.runId,
          reason: veto.reason,
        });
        await this.#deps.queue.settle(conversationId, claimedIds, {
          status: 'unanswered',
          reason: 'admission_veto',
        });
        await this.#endRun(
          conversationId,
          revision,
          checkpoint,
          { status: 'unanswered', reason: 'admission_veto' },
          { status: 'completed' },
          claimedIds,
        );
        return;
      }
    }
    const cutoff = await this.#deps.transcript.headEntryId(conversationId);
    if (cutoff === undefined) {
      await this.#failRun(
        conversationId,
        revision,
        checkpoint,
        `Conversation ${conversationId} has no entries to send`,
        'model_error',
      );
      return;
    }
    this.#emit({
      type: 'driver.prepare.completed',
      conversationId,
      runId: checkpoint.runId,
      cutoff,
    });
    await this.#commit(conversationId, revision, {
      phase: 'request',
      conversationId,
      runId: checkpoint.runId,
      attempt: checkpoint.attempt,
      inputs: [...checkpoint.inputs, ...claimedIds],
      model: resolution.model,
      thinkingLevel: resolution.thinkingLevel,
      streamOptions: resolution.streamOptions,
      cutoff,
      ...(lastPollEmpty === undefined ? {} : { lastPollEmpty }),
    });
  }

  /** Donor `request`: execute one logical turn and classify the report. */
  async #request(
    conversationId: string,
    checkpoint: Extract<TurnDriverCheckpoint, { phase: 'request' }>,
  ): Promise<TurnDriverRunOutcome> {
    await this.#deps.hooks?.onBeforeRequest?.({ conversationId, attempt: checkpoint.attempt });
    const report = await this.#deps.executor.executeStep({
      conversationId,
      runId: checkpoint.runId,
      attempt: checkpoint.attempt,
      plan: {
        model: checkpoint.model,
        thinkingLevel: checkpoint.thinkingLevel,
        streamOptions: checkpoint.streamOptions,
        cutoff: checkpoint.cutoff,
      },
      claimed: this.#takeClaimed(conversationId),
      signal: this.#signalOf(conversationId).signal,
    });
    return this.#classify(conversationId, checkpoint, report);
  }

  /** Donor `poll` phase body: fetch the deferred response. */
  async #requestDeferred(
    conversationId: string,
    checkpoint: Extract<TurnDriverCheckpoint, { phase: 'poll' }>,
  ): Promise<TurnDriverRunOutcome> {
    const report = await this.#deps.executor.fetchDeferred({
      conversationId,
      runId: checkpoint.runId,
      attempt: checkpoint.attempt,
      model: checkpoint.model,
      handle: checkpoint.handle,
      signal: this.#signalOf(conversationId).signal,
    });
    return this.#classify(conversationId, checkpoint, report);
  }

  /** Donor `classify`: route a terminal report to its successor phase. */
  async #classify(
    conversationId: string,
    checkpoint: Extract<TurnDriverCheckpoint, { phase: 'request' | 'poll' }>,
    report: TurnStepReport,
  ): Promise<TurnDriverRunOutcome> {
    const revision = this.#revision(conversationId);
    this.#emit({
      type: 'driver.request.completed',
      conversationId,
      runId: checkpoint.runId,
      report: report.kind,
      ...(report.kind === 'answer' || report.kind === 'error' ? { stopReason: report.stopReason } : {}),
    });
    await this.#deps.hooks?.onAfterResponse?.({
      conversationId,
      stopReason:
        report.kind === 'error' ? 'error' : report.kind === 'answer' ? report.stopReason : report.kind,
    });
    switch (report.kind) {
      case 'aborted':
        return this.abort(conversationId, 'executor_aborted');
      case 'answer':
        return this.#answer(conversationId, checkpoint, report.assistantEntryId);
      case 'toolRound': {
        await this.#commit(conversationId, revision, {
          phase: 'tools',
          conversationId,
          runId: checkpoint.runId,
          inputs: checkpoint.inputs,
          assistant: report.assistantEntryId,
          obligations: report.obligations,
          pending: report.pending,
        });
        for (const obligation of report.obligations) {
          this.#emit({
            type: 'driver.tools.obligation',
            conversationId,
            runId: checkpoint.runId,
            callId: obligation.callId,
            state: obligation.state,
          });
        }
        return this.drive(conversationId);
      }
      case 'deferred': {
        // A still-deferred result polls strictly later than before (donor).
        const pollAt = Math.max(
          this.#deps.clock.nowMs() + (report.handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
          (checkpoint.phase === 'poll' ? checkpoint.pollAt : Number.NEGATIVE_INFINITY) + 1,
        );
        await this.#commit(conversationId, revision, {
          phase: 'poll',
          conversationId,
          runId: checkpoint.runId,
          attempt: checkpoint.attempt,
          inputs: checkpoint.inputs,
          model: checkpoint.model,
          cutoff: checkpoint.cutoff,
          handle: report.handle,
          pollAt,
        });
        this.#emit({ type: 'driver.poll.scheduled', conversationId, runId: checkpoint.runId, pollAt });
        return this.drive(conversationId);
      }
      case 'error': {
        const text = report.errorMessage ?? 'Model response ended with stop reason error';
        // Overflow is never retried: only a compaction can make it fit.
        if (report.overflow && checkpoint.phase === 'request') {
          const gate = this.#deps.compaction;
          if (gate !== undefined && (await gate.canCut(conversationId))) {
            const taskId = await gate.start({ conversationId, reason: 'overflow' });
            await this.#commit(conversationId, revision, {
              phase: 'prepare',
              conversationId,
              runId: checkpoint.runId,
              attempt: checkpoint.attempt,
              inputs: checkpoint.inputs,
              compacted: { taskId, overflow: text },
            });
            const outcome = await gate.wait(taskId, this.#signalOf(conversationId).signal);
            if (outcome.status === 'completed') return this.drive(conversationId);
            return this.#failRun(
              conversationId,
              this.#revision(conversationId),
              this.#requirePhase(conversationId, 'prepare'),
              `Compaction failed: ${outcome.status === 'failed' ? outcome.error : 'aborted'}`,
              'model_error',
            );
          }
        }
        const { retry } = this.#deps.settings;
        const shouldRetry =
          !report.overflow && report.retryable && retry.enabled && checkpoint.attempt <= retry.maxRetries;
        if (shouldRetry) {
          const until = this.#deps.clock.nowMs() + retryDelayMs(this.#deps.settings, checkpoint.attempt);
          await this.#commit(conversationId, revision, {
            phase: 'retry',
            conversationId,
            runId: checkpoint.runId,
            attempt: checkpoint.attempt,
            inputs: checkpoint.inputs,
            until,
            error: text,
            // Only the request phase carries the re-poll flag onward.
            ...(checkpoint.phase === 'request' && checkpoint.lastPollEmpty !== undefined
              ? { lastPollEmpty: checkpoint.lastPollEmpty }
              : {}),
          });
          this.#emit({
            type: 'driver.retry.scheduled',
            conversationId,
            runId: checkpoint.runId,
            attempt: checkpoint.attempt,
            until,
          });
          return this.drive(conversationId);
        }
        return this.#failRun(conversationId, revision, checkpoint, text, 'model_error');
      }
    }
  }

  /**
   * Donor `tools` + `finishToolRound`: advance the round (one sequential call
   * at a time), then apply the postTools boundary. A settled round is never
   * re-executed; `advanceToolRound` without `nextCallId` settles/finishes.
   */
  async #tools(
    conversationId: string,
    checkpoint: Extract<TurnDriverCheckpoint, { phase: 'tools' }>,
  ): Promise<TurnDriverRunOutcome> {
    let obligations = [...checkpoint.obligations];
    let pending = [...checkpoint.pending];
    let revision = this.#revision(conversationId);
    const allSettled = (): boolean => obligations.length > 0 && obligations.every((o) => o.state === 'settled');
    let previousSignature = JSON.stringify([obligations, pending]);
    while (!allSettled() || pending.length > 0) {
      const next = pending[0];
      const settlement = await this.#deps.executor.advanceToolRound({
        conversationId,
        runId: checkpoint.runId,
        assistantEntryId: checkpoint.assistant,
        ...(next === undefined ? {} : { nextCallId: next }),
        obligations,
        signal: this.#signalOf(conversationId).signal,
      });
      obligations = [...settlement.obligations];
      pending = pending.filter((id) => !obligations.some((o) => o.callId === id && o.state !== 'pending'));
      const signature = JSON.stringify([obligations, pending]);
      const progressed = signature !== previousSignature;
      previousSignature = signature;
      for (const obligation of settlement.obligations) {
        this.#emit({
          type: 'driver.tools.obligation',
          conversationId,
          runId: checkpoint.runId,
          callId: obligation.callId,
          state: obligation.state,
        });
      }
      revision = await this.#commit(conversationId, revision, {
        phase: 'tools',
        conversationId,
        runId: checkpoint.runId,
        inputs: checkpoint.inputs,
        assistant: checkpoint.assistant,
        obligations,
        pending,
      });
      if (!progressed) {
        // Defensive: a settlement that changes nothing ends the loop instead
        // of spinning on a non-progressing executor; the committed checkpoint
        // stays consistent and a later drive() resumes the round.
        break;
      }
    }
    this.#emit({
      type: 'driver.tools.roundFinished',
      conversationId,
      runId: checkpoint.runId,
      assistantEntryId: checkpoint.assistant,
    });
    const resultEntryIds = obligations.flatMap((o) => (o.resultEntryId === undefined ? [] : [o.resultEntryId]));
    await this.#deps.hooks?.onAfterTools?.({
      conversationId,
      assistantEntryId: checkpoint.assistant,
      resultEntryIds,
    });
    // finishTurn sees the FINAL tool results before the boundary decision
    // (§2.4.3 invariant) — it runs strictly after every result committed.
    const finish = await this.#deps.executor.advanceToolRound({
      conversationId,
      runId: checkpoint.runId,
      assistantEntryId: checkpoint.assistant,
      obligations,
      signal: this.#signalOf(conversationId).signal,
    });
    return this.#postToolsBoundary(conversationId, checkpoint, finish.finishTurn?.action === 'continue');
  }

  /**
   * Donor `answer` + final boundary: settle `done`, place the queue, honour a
   * single onYield continuation only when no user item was placed.
   */
  async #answer(
    conversationId: string,
    checkpoint: Extract<TurnDriverCheckpoint, { phase: 'request' | 'poll' }>,
    assistantEntryId: string,
  ): Promise<TurnDriverRunOutcome> {
    let continuation: unknown;
    const yielded = await this.#deps.hooks?.onYield?.({ conversationId, entryId: assistantEntryId });
    if (yielded !== undefined) continuation = yielded.continue;
    const placed = await this.#applyBoundary(conversationId, checkpoint.runId, 'final');
    const revision = this.#revision(conversationId);
    if (continuation !== undefined && placed.length === 0) {
      await this.#deps.transcript.appendContinuationUserEntry(conversationId, continuation);
      await this.#commit(conversationId, revision, {
        phase: 'prepare',
        conversationId,
        runId: nextRunId(checkpoint.runId),
        attempt: 1,
        inputs: checkpoint.inputs,
      });
      return this.drive(conversationId);
    }
    const outcome = await this.#endRun(
      conversationId,
      revision,
      checkpoint,
      { status: 'done' },
      { status: 'completed', entryId: assistantEntryId },
      placed,
    );
    // Placed queue items start the next run themselves (donor `answer`:
    // `if (users.length > 0) await startRun(...)`), each satisfying exactly
    // one following request.
    if (placed.length > 0) {
      await this.startRun({ conversationId, runId: nextRunId(checkpoint.runId), inputs: placed });
      return this.drive(conversationId);
    }
    return outcome;
  }

  /** Donor `finishToolRound` postTools boundary: continue or end the run. */
  async #postToolsBoundary(
    conversationId: string,
    checkpoint: Extract<TurnDriverCheckpoint, { phase: 'tools' }>,
    continueRequested: boolean,
  ): Promise<TurnDriverRunOutcome> {
    const placed = await this.#applyBoundary(conversationId, checkpoint.runId, 'postTools');
    const revision = this.#revision(conversationId);
    if (continueRequested || placed.length > 0) {
      // `Continue` is satisfied by EXACTLY one following request; placed queue
      // items satisfy it too — no extra empty request is ever added (§2.4.3).
      await this.#commit(conversationId, revision, {
        phase: 'prepare',
        conversationId,
        runId: nextRunId(checkpoint.runId),
        attempt: 1,
        inputs: [...checkpoint.inputs, ...placed],
      });
      return this.drive(conversationId);
    }
    return this.#endRun(
      conversationId,
      revision,
      checkpoint,
      { status: 'done' },
      { status: 'completed', entryId: checkpoint.assistant },
      placed,
    );
  }

  /**
   * Place what a boundary selects (donor `applyBoundary`): steers `first` or
   * `all` per mode; follow-ups only at the final boundary. Product writes and
   * resets stay upstream — the driver's queue holds user inputs only.
   */
  async #applyBoundary(
    conversationId: string,
    runId: string,
    at: 'postTools' | 'final',
  ): Promise<readonly string[]> {
    const queued = await this.#deps.queue.peek(conversationId);
    const pick = (mode: 'steer' | 'followUp', queueMode: 'first' | 'all') => {
      const items = queued.filter((item) => item.mode === mode);
      return queueMode === 'all' ? items : items.slice(0, 1);
    };
    const users = [
      ...pick('steer', this.#deps.settings.queue.steeringMode),
      ...(at === 'final' ? pick('followUp', this.#deps.settings.queue.followUpMode) : []),
    ];
    if (users.length > 0) {
      await this.#deps.queue.claim(
        conversationId,
        users.map((item) => item.id),
      );
      this.#claimedForStep.set(conversationId, users);
    }
    this.#emit({
      type: 'driver.boundary.applied',
      conversationId,
      runId,
      at,
      placed: users.map((item) => item.id),
    });
    return users.map((item) => item.id);
  }

  /** Donor `endFailedRun` + `AfterFailedRun` policy. */
  async #failRun(
    conversationId: string,
    revision: number,
    checkpoint: TurnDriverCheckpoint,
    text: string,
    reason: string,
  ): Promise<TurnDriverRunOutcome> {
    const policy = this.#deps.settings.afterFailedRun;
    if (policy === 'withdraw') {
      await this.#deps.queue.withdrawQueued(conversationId, 'run_failed');
    }
    const placed = policy === 'continue' ? await this.#applyBoundary(conversationId, checkpoint.runId, 'final') : [];
    const outcome = await this.#endRun(
      conversationId,
      revision,
      checkpoint,
      { status: 'unanswered', reason, detail: text },
      { status: 'failed', error: text, detail: { reason } },
      placed,
    );
    if (policy === 'continue' && placed.length > 0) {
      await this.startRun({ conversationId, runId: nextRunId(checkpoint.runId), inputs: placed });
      return this.drive(conversationId);
    }
    return outcome;
  }

  /** Settle a faulted run if one is open; `undefined` when already settled. */
  async #settleFailed(
    conversationId: string,
    text: string,
    reason: string,
  ): Promise<TurnDriverRunOutcome | undefined> {
    const view = this.#deps.store.read(conversationId);
    const checkpoint = view.record?.checkpoint;
    if (checkpoint === undefined || checkpoint.phase === 'settled') return undefined;
    return this.#endRun(
      conversationId,
      view.revision,
      checkpoint,
      { status: 'unanswered', reason, detail: text },
      { status: 'failed', error: text, detail: { reason } },
    );
  }

  /** Settle the run's inputs and record the terminal checkpoint (donor `endRun`). */
  async #endRun(
    conversationId: string,
    revision: number,
    checkpoint: TurnDriverCheckpoint,
    settlement:
      | { readonly status: 'done' }
      | { readonly status: 'unanswered'; readonly reason: string; readonly detail?: string },
    outcome: TurnDriverRunOutcome,
    placedIds: readonly string[] = [],
  ): Promise<TurnDriverRunOutcome> {
    const settled = new Set(placedIds);
    // A terminal `settled` checkpoint carries no inputs (its run already
    // settled them); every other phase does.
    const runInputs = checkpoint.phase === 'settled' ? [] : checkpoint.inputs;
    const toSettle = runInputs.filter((id: string) => !settled.has(id));
    if (toSettle.length > 0) {
      await this.#deps.queue.settle(
        conversationId,
        toSettle,
        settlement.status === 'done'
          ? { status: 'done' }
          : { status: 'unanswered', reason: settlement.reason },
      );
    }
    await this.#commit(conversationId, revision, {
      phase: 'settled',
      conversationId,
      runId: checkpoint.runId,
      outcome,
    });
    this.#emit({ type: 'driver.run.settled', conversationId, runId: checkpoint.runId, status: outcome.status });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Current store revision (the CAS base for the NEXT commit). */
  #revision(conversationId: string): number {
    return this.#deps.store.read(conversationId).revision;
  }

  #signalOf(conversationId: string): AbortController {
    let controller = this.#runSignals.get(conversationId);
    if (controller === undefined) {
      controller = new AbortController();
      this.#runSignals.set(conversationId, controller);
    }
    return controller;
  }

  #takeClaimed(conversationId: string): readonly DriverQueuedInput[] {
    const claimed = this.#claimedForStep.get(conversationId) ?? [];
    this.#claimedForStep.delete(conversationId);
    return claimed;
  }

  #requirePhase(conversationId: string, phase: 'prepare'): Extract<TurnDriverCheckpoint, { phase: 'prepare' }> {
    const checkpoint = this.#deps.store.readCheckpoint(conversationId);
    if (checkpoint?.phase !== phase) {
      throw new TurnDriverError('PHASE_MISMATCH', `Expected ${phase} phase for ${conversationId}`);
    }
    return checkpoint;
  }

  /** Commit one checkpoint revision; resolves with the NEW revision. */
  async #commit(conversationId: string, revision: number, checkpoint: TurnDriverCheckpoint): Promise<number> {
    // Records are full-state snapshots: the executor binding survives every
    // checkpoint transition (a lost binding would re-admit a second executor).
    const binding = this.#deps.store.read(conversationId).record?.binding;
    const input: TurnDriverSaveInput = {
      conversationId,
      expectedRevision: revision,
      checkpoint,
      ...(binding === undefined ? {} : { binding }),
    };
    const result = await this.#deps.store.save(input);
    this.#emit({
      type: 'driver.checkpoint.committed',
      conversationId,
      phase: checkpoint.phase,
      revision: result.revision,
    });
    return result.revision;
  }

  async #sleepUntil(conversationId: string, untilMs: number): Promise<void> {
    await this.#deps.clock.sleepUntil(untilMs, this.#signalOf(conversationId).signal);
  }

  #emit(event: TurnDriverEvent): void {
    try {
      this.#deps.events?.(event);
    } catch {
      // Observation must never break correctness (§2.6 I10).
    }
  }
}
