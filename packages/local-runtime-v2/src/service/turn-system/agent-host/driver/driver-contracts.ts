/**
 * W04 part B — durable turn-driver contracts (PORT-PI-1.3 §2.4.3 A3).
 *
 * One durable task-driver per product conversation. The driver owns the run's
 * durable checkpoint phases — `prepare → request → retry | poll | tools` — and
 * recovery; every logical turn/step is DELEGATED to the agent-core loop (W04
 * part A) through the {@link TurnStepExecutor} seam. The donor semantics come
 * from pi-durable `harness/generation.ts` (`GenerationTask`, pin 48c8f32):
 * an ordinary `pi.generation` is NOT started for the same conversation — the
 * driver implements its checkpoint/retry/deferred-poll/tool-recovery duties
 * (port-plan.md:40, :159).
 *
 * This module is type-only plus small pure guards; it must stay importable
 * without pulling the whole agent-host graph so part A can bind against it
 * from `@mavis/agent-core` adapters without cycles.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Shared identity / policy types
// ---------------------------------------------------------------------------

/** Resolved model reference, frozen into the `request` checkpoint. */
export interface DriverModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

/** Thinking level resolved at prepare time (pi `ModelThinkingLevel` string). */
export type DriverThinkingLevel = string;

/**
 * Request options frozen when preparation committed. A transport resend after
 * recovery reuses them unchanged; a NEW logical retry re-runs prepare
 * (boundary-contract C3/C4: one immutable snapshot per logical request).
 */
export interface DriverStreamOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly [extra: string]: unknown;
}

/** Queue disposition mode (donor `QueueMode`): consume the first item or all. */
export type DriverQueueMode = 'first' | 'all';

export interface DriverQueueModes {
  /** How many queued steering items a boundary places. */
  readonly steeringMode: DriverQueueMode;
  /** How many queued follow-ups the FINAL boundary places. */
  readonly followUpMode: DriverQueueMode;
}

/** Retry policy read at classification time, not pinned at prepare (donor). */
export interface DriverRetryPolicy {
  readonly enabled: boolean;
  readonly maxRetries: number;
  /** Base delay; the donor grows it per attempt (`retryDelayMs`). */
  readonly initialDelayMs: number;
  readonly backoffFactor?: number;
}

/** What a failed run does with inputs queued behind it (donor `AfterFailedRun`). */
export type DriverAfterFailedRun = 'keep' | 'continue' | 'withdraw';

export interface DriverSettings {
  readonly queue: DriverQueueModes;
  readonly retry: DriverRetryPolicy;
  readonly afterFailedRun: DriverAfterFailedRun;
}

/** Deferred provider response handle (pi-ai `DeferredHandle` payload). */
export interface DriverDeferredHandle {
  readonly id: string;
  readonly pollAfterMs?: number;
  readonly [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Checkpoint phases — adapted from donor `GenerationCheckpoint`
// (pi-durable harness/generation.ts:56-97)
// ---------------------------------------------------------------------------

/** A blocking compaction the run waits for; the run starts no other one. */
export interface DriverCompactionWait {
  readonly taskId: string;
  /** Error text of the overflow that started the compaction; checked once. */
  readonly overflow?: string;
  /** Set when the blocking threshold started the compaction. */
  readonly threshold?: true;
}

/** Durable state of one tool-call obligation of the current tool round. */
export interface DriverToolObligation {
  readonly callId: string;
  readonly name: string;
  /**
   * `pending` — intent committed, effect not started;
   * `running` — effect started, no committed outcome yet;
   * `settled` — exactly one committed outcome exists;
   * `unknown` — effect start observed, outcome lost (crash): recovered as
   *   TOOL_OUTCOME_UNKNOWN, never auto-retried (§2.6 I07).
   */
  readonly state: 'pending' | 'running' | 'settled' | 'unknown';
  /** Entry id of the committed tool result once settled. */
  readonly resultEntryId?: string;
}

/**
 * The durable turn-driver checkpoint. Phases mirror the donor:
 * prepare → request → (classify) → retry | poll | tools → terminal.
 * Every transition is committed durably BEFORE its effects run, so a crash
 * never repeats an effect blindly (naked-rerun risk, port-plan.md:735).
 */
export type TurnDriverCheckpoint =
  | {
      readonly phase: 'prepare';
      readonly conversationId: string;
      readonly runId: string;
      readonly attempt: number;
      /** Submission ids whose settlement this run owns. */
      readonly inputs: readonly string[];
      readonly compacted?: DriverCompactionWait;
      /**
       * Queue re-poll discipline (§2.5.1): a re-poll during a long prepare
       * happens ONLY when the previous steering poll was empty, so
       * one-at-a-time consumption is never doubled.
       */
      readonly lastPollEmpty?: boolean;
    }
  | {
      readonly phase: 'request';
      readonly conversationId: string;
      readonly runId: string;
      readonly attempt: number;
      readonly inputs: readonly string[];
      readonly model: DriverModelRef;
      readonly thinkingLevel: DriverThinkingLevel;
      readonly streamOptions: DriverStreamOptions;
      /** Newest committed entry included in the request. */
      readonly cutoff: string;
      /** Carried so a retry's re-prepare still honors the re-poll rule. */
      readonly lastPollEmpty?: boolean;
    }
  | {
      readonly phase: 'retry';
      readonly conversationId: string;
      readonly runId: string;
      readonly attempt: number;
      readonly inputs: readonly string[];
      /** Monotonic wall-clock (ms) before which no new attempt may start. */
      readonly until: number;
      readonly error: string;
      readonly compacted?: DriverCompactionWait;
      readonly lastPollEmpty?: boolean;
    }
  | {
      readonly phase: 'poll';
      readonly conversationId: string;
      readonly runId: string;
      readonly attempt: number;
      readonly inputs: readonly string[];
      readonly model: DriverModelRef;
      readonly cutoff: string;
      readonly handle: DriverDeferredHandle;
      /** Strictly increasing across polls of the same deferred response. */
      readonly pollAt: number;
    }
  | {
      /** Waiting on the round's tool obligations, which the run owns. */
      readonly phase: 'tools';
      readonly conversationId: string;
      readonly runId: string;
      readonly inputs: readonly string[];
      /** Entry id of the tool-calling assistant answer. */
      readonly assistant: string;
      /** Obligations in call order; sequential rounds start one at a time. */
      readonly obligations: readonly DriverToolObligation[];
      /** Calls of a sequential round not started yet, in call order. */
      readonly pending: readonly string[];
    }
  | {
      /** Terminal; the checkpoint is retained for recovery, then cleared. */
      readonly phase: 'settled';
      readonly conversationId: string;
      readonly runId: string;
      readonly outcome: TurnDriverRunOutcome;
    };

/** Terminal outcome of one driver run (donor `TaskOutcome` projection). */
export type TurnDriverRunOutcome =
  | { readonly status: 'completed'; readonly entryId?: string }
  | { readonly status: 'failed'; readonly error: string; readonly detail?: { readonly reason: string } }
  | { readonly status: 'aborted' };

// ---------------------------------------------------------------------------
// Executor binding — the single-executor invariant (§2.6 I01)
// ---------------------------------------------------------------------------

/**
 * Durable record of WHICH executor may run turns for a conversation. Binding
 * is CAS'd through the driver store: while a binding holds, a second driver
 * (or a raw `pi.generation` started outside the driver) is refused rather
 * than racing (port-plan.md:156 "Один executor на product conversation").
 */
export interface ExecutorBinding {
  readonly conversationId: string;
  /** Executor identity, e.g. `mavis.agent-core.pi-turn-loop`. */
  readonly executorId: string;
  /** Advances on every successful (re)bind; recovery detects stale owners. */
  readonly epoch: number;
  readonly boundAtMs: number;
}

// ---------------------------------------------------------------------------
// Queue port — submissions waiting for a boundary (donor `pi.inbox`)
// ---------------------------------------------------------------------------

/** A queued input visible to the driver, in admission (id) order. */
export interface DriverQueuedInput {
  readonly id: string;
  readonly mode: 'steer' | 'followUp';
  /** Opaque user content; placement commits it as an entry via the adapter. */
  readonly content: unknown;
}

/**
 * Product-owned queue policy surface (input-delivery / steering-control stay
 * the owners of receipts and destination; the driver only consumes). Saved,
 * placed and provider-delivered remain distinct: `peek` sees queued items,
 * `claim` removes them from the queue (placed), and nothing here asserts
 * provider delivery.
 */
export interface DriverQueuePort {
  /** Queued items in admission order; provider-delivered items are absent. */
  peek(conversationId: string): Promise<readonly DriverQueuedInput[]>;
  /**
   * Atomically claim (place) the given ids — the batch steering contract
   * (§5.1 `steerBatch`): all-or-nothing, order preserved, peek never
   * substitutes for a claim.
   */
  claim(conversationId: string, ids: readonly string[]): Promise<void>;
  /** Settle claimed inputs: `done`, or `unanswered` with a reason. */
  settle(
    conversationId: string,
    ids: readonly string[],
    settlement: { readonly status: 'done' } | { readonly status: 'unanswered'; readonly reason: string },
  ): Promise<void>;
  /**
   * Withdraw every still-queued input (donor `withdrawQueuedInputs`): each
   * settles `unanswered` with `reason` and leaves the queue.
   */
  withdrawQueued(conversationId: string, reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Compaction gate — blocking threshold policy (donor §8.3); W05 owns the
// algorithm, the driver only gates its request on the decision.
// ---------------------------------------------------------------------------

export interface DriverCompactionGate {
  /**
   * Decide the threshold verdict for a prepared request. `blocking` waits on
   * `start()`'s task; `background` proceeds and lets the owner schedule.
   */
  threshold(input: {
    readonly conversationId: string;
    readonly model: DriverModelRef;
  }): Promise<'blocking' | 'background' | undefined>;
  /** Start a compaction task; resolves its durable task id. */
  start(input: {
    readonly conversationId: string;
    readonly reason: 'threshold' | 'overflow';
  }): Promise<string>;
  /** Outcome of a compaction task; `completed` means a summary was appended. */
  outcome(taskId: string): Promise<
    | { readonly status: 'completed' }
    | { readonly status: 'failed'; readonly error: string }
    | { readonly status: 'aborted' }
  >;
  /** Await the task's terminal outcome (the blocking wait of `prepare`). */
  wait(taskId: string, signal: AbortSignal): Promise<
    | { readonly status: 'completed' }
    | { readonly status: 'failed'; readonly error: string }
    | { readonly status: 'aborted' }
  >;
  /** Whether a cut exists for an overflow retry (donor `selectCut`). */
  canCut(conversationId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Transcript reconciliation port — recovery needs to see committed effects
// ---------------------------------------------------------------------------

/** Read-only view the driver needs over the committed transcript (A1/A2). */
export interface DriverTranscriptPort {
  /** Newest committed entry id of the conversation (`undefined` when empty). */
  headEntryId(conversationId: string): Promise<string | undefined>;
  /**
   * Committed assistant entry AFTER `cutoff`, if any — recovery's
   * "did the request already produce its assistant commit?" probe.
   */
  assistantAfter(conversationId: string, cutoff: string): Promise<
    | {
        readonly entryId: string;
        readonly stopReason: string;
        readonly toolCalls: readonly { readonly callId: string; readonly name: string }[];
      }
    | undefined
  >;
  /** Committed tool-result entry id for a call, if the round settled it. */
  toolResultOf(conversationId: string, callId: string): Promise<string | undefined>;
  /** Append a synthesized tool result (abort/unknown recovery), once per call. */
  appendSyntheticToolResult(input: {
    readonly conversationId: string;
    readonly callId: string;
    readonly name: string;
    readonly isError: boolean;
    readonly code: 'aborted' | 'tool_outcome_unknown' | 'tool_unavailable';
    readonly message: string;
  }): Promise<string>;
  /** Append the continuation user entry for a `continue` decision (donor `answer`). */
  appendContinuationUserEntry(conversationId: string, content: unknown): Promise<string>;
}

// ---------------------------------------------------------------------------
// The turn-step seam — what part A (agent-core loop) must satisfy
// ---------------------------------------------------------------------------

/** Identity of the logical request frozen by the prepare commit. */
export interface DriverRequestPlan {
  readonly model: DriverModelRef;
  readonly thinkingLevel: DriverThinkingLevel;
  readonly streamOptions: DriverStreamOptions;
  readonly cutoff: string;
  /** System/tool declaration deltas committed before the request (A2 fold). */
  readonly declaredDeltas?: readonly {
    readonly kind: 'system' | 'toolsAdded' | 'toolsRemoved';
    readonly payload: unknown;
  }[];
}

export interface TurnStepRequest {
  readonly conversationId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly plan: DriverRequestPlan;
  /** Steering inputs claimed for THIS step (already placed by the queue). */
  readonly claimed: readonly DriverQueuedInput[];
  readonly signal: AbortSignal;
}

/** Classification of one executed logical turn (donor `classify` inputs). */
export type TurnStepReport =
  | {
      /** The delegated runtime stopped the turn; this is not a provider failure. */
      readonly kind: 'aborted';
    }
  | {
      /** A final answer: `stop` or `length`; run ends at the final boundary. */
      readonly kind: 'answer';
      readonly assistantEntryId: string;
      readonly stopReason: 'stop' | 'length';
    }
  | {
      /**
       * A tool-calling answer. `obligations` are the round's calls in call
       * order with the state the executor left them in; `pending` lists the
       * sequential calls not started yet (donor `startToolRound`).
       */
      readonly kind: 'toolRound';
      readonly assistantEntryId: string;
      readonly obligations: readonly DriverToolObligation[];
      readonly pending: readonly string[];
      /** Un-offered calls already received their `tool_unavailable` result. */
      readonly unavailableCalls?: readonly string[];
    }
  | {
      /** Provider deferred the response; poll strictly later (donor). */
      readonly kind: 'deferred';
      readonly handle: DriverDeferredHandle;
    }
  | {
      /** Terminal provider error, already committed as an assistant entry. */
      readonly kind: 'error';
      readonly stopReason: 'error';
      readonly errorMessage?: string;
      /** Context overflow is never retried — only compaction can fix it. */
      readonly overflow: boolean;
      /** Executor-side retryability classification (pi `isRetryableAssistantError`). */
      readonly retryable: boolean;
    };

export interface ToolRoundSettlementRequest {
  readonly conversationId: string;
  readonly runId: string;
  readonly assistantEntryId: string;
  /** Next sequential call to start, when present. */
  readonly nextCallId?: string;
  readonly obligations: readonly DriverToolObligation[];
  readonly signal: AbortSignal;
}

/** Result of settling/advancing the round (donor `finishToolRound` inputs). */
export interface ToolRoundSettlement {
  readonly obligations: readonly DriverToolObligation[];
  /**
   * The finishTurn decision seen AFTER all final tool results (§2.4.3):
   * `end` stops at the final boundary; `continue` asks for exactly one more
   * request; absent means the executor's native loop already ended the turn.
   */
  readonly finishTurn?: { readonly action: 'end' | 'continue' };
}

export interface DeferredFetchRequest {
  readonly conversationId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly model: DriverModelRef;
  readonly handle: DriverDeferredHandle;
  readonly signal: AbortSignal;
}

/**
 * The step-capable seam to the agent-core loop (W04 part A). ONE logical
 * turn per call: `prepareRequest` (canonical snapshot) → provider request →
 * committed assistant + usage → tool batch via the A5 gateway → finishTurn.
 * The driver never starts a second inner loop and never sends requests
 * itself (port-plan.md:731 "phase transition не создаёт второй inner loop").
 */
export interface TurnStepExecutor {
  /** Stable executor identity recorded in the durable binding. */
  readonly executorId: string;
  /** Execute one logical turn from the frozen plan. */
  executeStep(request: TurnStepRequest): Promise<TurnStepReport>;
  /**
   * Drive the tool round forward: start the next sequential call and/or
   * settle completed obligations. Must not re-execute a settled call.
   */
  advanceToolRound(request: ToolRoundSettlementRequest): Promise<ToolRoundSettlement>;
  /** Fetch a deferred provider response (donor `poll` phase body). */
  fetchDeferred(request: DeferredFetchRequest): Promise<TurnStepReport>;
  /** Best-effort cancellation of a deferred response (donor abort path). */
  cancelDeferred?(request: {
    readonly conversationId: string;
    readonly model: DriverModelRef;
    readonly handle: DriverDeferredHandle;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Driver hooks — donor `GenerationHooks` adapted to product policy
// ---------------------------------------------------------------------------

/**
 * Structured admission veto (§5.1 `shouldStopAfterSteering`): returned BEFORE
 * the vetoed input is placed / a next request is sent. Not a boolean rename.
 */
export interface DriverAdmissionVeto {
  readonly reason: string;
}

export interface DriverHooks {
  /** Observed before each logical request (donor `beforeRequest`). */
  onBeforeRequest?(input: { readonly conversationId: string; readonly attempt: number }): Promise<void>;
  /** Observed after each terminal provider response (donor `afterResponse`). */
  onAfterResponse?(input: { readonly conversationId: string; readonly stopReason: string }): Promise<void>;
  /**
   * First non-undefined wins (donor `onYield`): a `continue` continuation
   * appends a user entry and hands the run to exactly one successor request.
   */
  onYield?(
    input: { readonly conversationId: string; readonly entryId: string },
  ): Promise<{ readonly continue: unknown } | undefined>;
  /** Observed after the round's final tool results (donor `afterTools`). */
  onAfterTools?(
    input: {
      readonly conversationId: string;
      readonly assistantEntryId: string;
      readonly resultEntryIds: readonly string[];
    },
  ): Promise<void>;
  /**
   * Post-steering admission veto: called after dequeue, before placement and
   * before any next request; a veto gracefully ends the run (agent_end) with
   * zero new provider requests (§5.1 plugin `UserPromptSubmit continue:false`).
   */
  onAdmissionCheck?(
    input: { readonly conversationId: string; readonly claimed: readonly DriverQueuedInput[] },
  ): Promise<DriverAdmissionVeto | undefined>;
}

// ---------------------------------------------------------------------------
// Deterministic event trace (W04 T: "deterministic event traces")
// ---------------------------------------------------------------------------

export type TurnDriverEvent =
  | { readonly type: 'driver.run.started'; readonly conversationId: string; readonly runId: string; readonly attempt: number }
  | { readonly type: 'driver.prepare.completed'; readonly conversationId: string; readonly runId: string; readonly cutoff: string }
  | {
      readonly type: 'driver.request.completed';
      readonly conversationId: string;
      readonly runId: string;
      readonly report: TurnStepReport['kind'];
      readonly stopReason?: string;
    }
  | { readonly type: 'driver.retry.scheduled'; readonly conversationId: string; readonly runId: string; readonly attempt: number; readonly until: number }
  | { readonly type: 'driver.poll.scheduled'; readonly conversationId: string; readonly runId: string; readonly pollAt: number }
  | { readonly type: 'driver.tools.obligation'; readonly conversationId: string; readonly runId: string; readonly callId: string; readonly state: DriverToolObligation['state'] }
  | { readonly type: 'driver.tools.roundFinished'; readonly conversationId: string; readonly runId: string; readonly assistantEntryId: string }
  | {
      readonly type: 'driver.boundary.applied';
      readonly conversationId: string;
      readonly runId: string;
      readonly at: 'postTools' | 'final';
      readonly placed: readonly string[];
      readonly reset?: boolean;
    }
  | { readonly type: 'driver.queue.repolled'; readonly conversationId: string; readonly runId: string; readonly reason: 'prepare-long' | 'boundary' }
  | { readonly type: 'driver.admission.vetoed'; readonly conversationId: string; readonly runId: string; readonly reason: string }
  | { readonly type: 'driver.run.settled'; readonly conversationId: string; readonly runId: string; readonly status: TurnDriverRunOutcome['status'] }
  | { readonly type: 'driver.checkpoint.committed'; readonly conversationId: string; readonly phase: TurnDriverCheckpoint['phase']; readonly revision: number }
  | { readonly type: 'driver.recovered'; readonly conversationId: string; readonly phase: TurnDriverCheckpoint['phase']; readonly actions: readonly string[] };

/** Observer for the driver's event trace; must never throw into the driver. */
export type TurnDriverEventSink = (event: TurnDriverEvent) => void;

// ---------------------------------------------------------------------------
// Clock / timers — injectable for deterministic tests
// ---------------------------------------------------------------------------

export interface DriverClock {
  nowMs(): number;
  sleepUntil(untilMs: number, signal: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store record
// ---------------------------------------------------------------------------

/** One durable driver-state entry (JSON payload of a store record). */
export interface TurnDriverStateRecord {
  readonly conversationId: string;
  /** Monotonic per-conversation revision of the driver state. */
  readonly revision: number;
  readonly checkpoint?: TurnDriverCheckpoint;
  readonly binding?: ExecutorBinding;
  /**
   * Boundary drafts staged by the last finishTurn, committed atomically with
   * the boundary transition (contract C6): preview is never committed state.
   */
  readonly pendingBoundaryDrafts?: readonly unknown[];
}

/** Result of a store save. */
export interface TurnDriverStoreResult {
  readonly revision: number;
  readonly status: 'committed' | 'replayed';
}
