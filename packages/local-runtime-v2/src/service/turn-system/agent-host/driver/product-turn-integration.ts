import { createHash } from 'node:crypto';

import { createLogger } from '@mavis/logging';

import type { AgentHost, AgentHostRunInput } from '../contracts.js';
import type { AgentHostTurnOutcome } from '../runner/contracts.js';
import type { AgentExecutionSnapshot, AgentExecutionSource } from '../preparation/contracts.js';
import { readSessionAgentExecutionSnapshot } from '../preparation/session-agent-execution-snapshot.js';
import type { SessionRecord } from '../../../session-system/index.js';
import type { PiDurableCompositionRoot } from '../../../session-system/messages/history/pi-durable-root.js';
import type {
  DriverQueuePort,
  DriverTranscriptPort,
  TurnDriverEvent,
  TurnDriverEventSink,
  TurnStepExecutor,
  TurnStepReport,
} from './driver-contracts.js';
import { DurableTurnDriver, TurnDriverError, type DriverPrepareResolution } from './durable-turn-driver.js';
import type { TurnDriverStorePort } from './turn-driver-store.js';
import { composeProductTurnDriver } from './product-turn-driver.js';

/**
 * W10 — the durable turn-driver in the ACTIVE product turn path (review
 * w10-review-p1 item 1; port-plan §8 W10 risk «новая архитектура остаётся
 * opt-in мёртвым кодом», w10-part-a.md §3 deferred item 1).
 *
 * {@link withProductTurnDriver} wraps the composed part-A AgentHost (the
 * existing executor) with the {@link DurableTurnDriver} composed through
 * {@link composeProductTurnDriver} over the runtime's REAL pi composition
 * root — the same ONE storage as the canonical history, the checkpoint
 * barrier and the orchestration scheduler. In durable mode (the W10 default)
 * every product turn flows through the driver:
 *
 *   coordinator → DriverBackedAgentHost.run → driver.bind → startRun →
 *   drive() [prepare → request → settled, revision-CAS checkpoints on the
 *   bridge log] → TurnStepExecutor.executeStep → the part-A product loop
 *   (delegation, unchanged semantics).
 *
 * The step executor delegates ONE logical product turn per `executeStep` and
 * classifies the part-A outcome into the driver's report vocabulary; the
 * product settlement keeps consuming the part-A outcome verbatim, so lease,
 * steering, settlement and projection semantics are byte-identical. The
 * driver's retry/poll/tool-round phases stay dormant in this composition
 * stage (the part-A loop owns provider retries and settles its tool rounds
 * inside the step); what the driver OWNS durably is the executor binding
 * (§2.6 I01 — one executor per conversation), the run envelope
 * (prepare/request/settled checkpoints with the frozen model identity and
 * transcript cutoff) and crash recovery of that envelope
 * ({@link DurableTurnDriver.recover} reconciles a stale open run against the
 * committed transcript before the next turn opens).
 *
 * The queue port is the honest empty inbox: the product turn-system queue
 * dispatcher stays the owner of steering/follow-up placement — every placed
 * item becomes its own product turn (its own driver run). When the W04
 * part-A per-step executor adapter lands, this port adapts the committed
 * steering queue directly.
 *
 * jsonl compatibility mode composes none of this (services.ts keeps the
 * direct part-A host) — the legacy path stays exact.
 *
 * @module
 */

const integrationLog = createLogger('mcode:turn');

/** Executor identity recorded in the durable binding (part-A loop adapter). */
const PRODUCT_TURN_EXECUTOR_ID = 'mavis.local-runtime-v2.part-a-loop';

/**
 * Conservative product driver settings: provider retries stay with the
 * part-A loop (llm-retry hooks, runtime-error-retry-policy), so the driver's
 * own retry axis is disabled; queued inputs survive a failed run (`keep`).
 */
const PRODUCT_DRIVER_SETTINGS = {
  queue: { steeringMode: 'first', followUpMode: 'first' },
  retry: { enabled: false, maxRetries: 0, initialDelayMs: 0 },
  afterFailedRun: 'keep',
} as const;

/** Cutoff of a transcript with no committed entries yet (documented sentinel). */
const EMPTY_TRANSCRIPT_CUTOFF = 'mcode.transcript.empty';

/** Entry id namespace of the transcript adapter (content-addressed). */
const TRANSCRIPT_ENTRY_PREFIX = 'session.message';

export interface ProductTurnDriverHostOptions<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  /**
   * The session's pi composition root (per-session durable history): the
   * driver's durable state rides the session's OWN log/port. The resolver
   * is sync and fail-closed — the provider's ensureState opens the session
   * root before the driver binds.
   */
  readonly rootOfSession: (sessionId: string) => PiDurableCompositionRoot;
  /** The composed part-A AgentHost — the existing product executor. */
  readonly host: AgentHost;
  /** Session records (model identity resolution). */
  readonly sessions: { readonly get: (sessionId: string) => Promise<SessionRecord | undefined> };
  /** Optional Agent snapshot source (richer model identity). */
  readonly agents?: AgentExecutionSource<TAgent>;
  /**
   * The durable canonical history (read-only active inspection plus the
   * append seam for driver recovery writes).
   */
  readonly canonicalHistory: {
    readonly inspectActive: (sessionId: string) => Promise<{ readonly messages: readonly unknown[] }>;
    readonly append: (change: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly reason: 'messageDelta' | 'replaceMessages';
      readonly messages: readonly unknown[];
      readonly operation: { readonly id: string; readonly kind: string };
    }) => Promise<unknown>;
  };
  readonly nowMs?: () => number;
  /** Additional structured event sink (tests); events are always logged. */
  readonly events?: TurnDriverEventSink;
}

/** The driver-backed AgentHost composed by {@link withProductTurnDriver}. */
export interface DriverBackedAgentHost extends AgentHost {
  readonly driver: DurableTurnDriver;
  readonly store: TurnDriverStorePort;
  /** The delegating step executor (test/inspection seam). */
  readonly executor: TurnStepExecutor;
}

/**
 * Wraps the part-A product host with the durable turn-driver (durable-mode
 * composition point — see module doc). The wrapper adds the durable run
 * envelope around each turn; turn execution itself is delegated unchanged.
 */
export function withProductTurnDriver<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(options: ProductTurnDriverHostOptions<TAgent>): DriverBackedAgentHost {
  const nowMs = options.nowMs ?? Date.now;
  const stepExecutor = new DelegatingTurnStepExecutor(options.host);
  const { driver, store } = composeProductTurnDriver({
    rootOfSession: options.rootOfSession,
    executor: stepExecutor,
    queue: createProductDriverQueuePort(),
    transcript: createCanonicalHistoryTranscriptPort(options, nowMs),
    settings: PRODUCT_DRIVER_SETTINGS,
    resolveModel: (conversationId) => resolveProductModelIdentity(options, conversationId),
    clock: createProductDriverClock(nowMs),
    events: (event) => {
      observeDriverEvent(event);
      options.events?.(event);
    },
  });
  return {
    driver,
    store,
    executor: stepExecutor,
    run: (input) => runDriverBackedTurn(driver, stepExecutor, input),
    compact: (input) => options.host.compact(input),
  };
}

// ---------------------------------------------------------------------------
// The turn envelope — bind, open, drive, settle
// ---------------------------------------------------------------------------

async function runDriverBackedTurn(
  driver: DurableTurnDriver,
  stepExecutor: DelegatingTurnStepExecutor,
  input: AgentHostRunInput,
): Promise<AgentHostTurnOutcome> {
  const conversationId = input.lease.sessionId;
  await driver.bind(conversationId);
  stepExecutor.bind(conversationId, input);
  try {
    await openDriverRun(driver, conversationId, input.lease.turnId);
  } catch (error) {
    stepExecutor.release(conversationId);
    throw error;
  }
  try {
    await driver.drive(conversationId);
  } catch (error) {
    const executed = stepExecutor.release(conversationId);
    if (executed !== undefined) {
      // The delegated step COMPLETED; only the driver's post-step
      // bookkeeping faulted. The product turn result stands — the next run's
      // recovery reconciles the durable record against the transcript
      // (donor recovery map: committed effects are never repeated).
      integrationLog.warn('turn driver post-step bookkeeping failed; recovery will reconcile', {
        sessionId: conversationId,
        turnId: input.lease.turnId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
      return executed;
    }
    // Fail-closed: the driver faulted before the step executed — the product
    // turn did not run and must not silently degrade.
    throw error;
  }
  const outcome = stepExecutor.release(conversationId);
  if (outcome === undefined) {
    // Unreachable while drive() settles only through the step executor.
    throw new TurnDriverError('NO_RUN', `Driver run of ${conversationId} settled without a step outcome`);
  }
  return outcome;
}

/**
 * Opens the durable run, reconciling a stale open run (a crashed process
 * left prepare/request/poll/tools state) first: recover() replays the
 * checkpoint against the committed transcript, abort() settles whatever
 * stays open, and only then does the fresh product turn open its own run.
 */
async function openDriverRun(
  driver: DurableTurnDriver,
  conversationId: string,
  runId: string,
): Promise<void> {
  try {
    await driver.startRun({ conversationId, runId, inputs: [] });
    return;
  } catch (error) {
    if (!(error instanceof TurnDriverError) || error.code !== 'RUN_OPEN') throw error;
  }
  integrationLog.info('turn driver found a stale open run; recovering', {
    sessionId: conversationId,
    turnId: runId,
  });
  const recovery = await driver.recover(conversationId);
  if (recovery.phase !== 'idle' && recovery.phase !== 'settled') {
    await driver.abort(conversationId, 'superseded_by_product_turn');
  }
  await driver.startRun({ conversationId, runId, inputs: [] });
}

// ---------------------------------------------------------------------------
// TurnStepExecutor — delegation to the part-A product loop
// ---------------------------------------------------------------------------

/**
 * Delegates one driver step to one full part-A product turn. The part-A loop
 * owns the inner iteration (provider requests, retries, tool rounds, the
 * finishTurn decision), so `advanceToolRound` reports the round settled
 * inside the step and deferred handles never surface.
 */
class DelegatingTurnStepExecutor implements TurnStepExecutor {
  readonly executorId = PRODUCT_TURN_EXECUTOR_ID;

  readonly #host: AgentHost;
  readonly #bound = new Map<string, AgentHostRunInput>();
  readonly #outcomes = new Map<string, AgentHostTurnOutcome>();

  constructor(host: AgentHost) {
    this.#host = host;
  }

  /** Binds the product turn input of the conversation's next step. */
  bind(conversationId: string, input: AgentHostRunInput): void {
    this.#bound.set(conversationId, input);
  }

  /** Takes the delegated outcome; `undefined` when the step never executed. */
  release(conversationId: string): AgentHostTurnOutcome | undefined {
    this.#bound.delete(conversationId);
    const outcome = this.#outcomes.get(conversationId);
    this.#outcomes.delete(conversationId);
    return outcome;
  }

  async executeStep(request: Parameters<TurnStepExecutor['executeStep']>[0]): Promise<TurnStepReport> {
    const input = this.#bound.get(request.conversationId);
    if (input === undefined) {
      throw new Error(`No product turn is bound for conversation ${request.conversationId}`);
    }
    const outcome = await this.#host.run(input);
    this.#outcomes.set(request.conversationId, outcome);
    if (outcome.status === 'completed') {
      return {
        kind: 'answer',
        assistantEntryId: assistantEntryIdOf(request.runId),
        stopReason: 'stop',
      };
    }
    if (outcome.status === 'aborted') return { kind: 'aborted' };
    return {
      kind: 'error',
      stopReason: 'error',
      errorMessage: describeStepError(outcome.error),
      // Overflow/retry classification stays with the part-A loop's own
      // policies in this composition stage; the driver never re-sends.
      overflow: false,
      retryable: false,
    };
  }

  async advanceToolRound(
    request: Parameters<TurnStepExecutor['advanceToolRound']>[0],
  ): ReturnType<TurnStepExecutor['advanceToolRound']> {
    // The part-A loop settles the round inside the step; nothing to drive.
    return { obligations: request.obligations };
  }

  async fetchDeferred(): Promise<TurnStepReport> {
    throw new Error('The part-A product loop does not surface deferred provider handles.');
  }
}

/** Durable id of the run's final assistant commit in driver state. */
function assistantEntryIdOf(runId: string): string {
  return `mcode.turn-driver.assistant#${runId}`;
}

function describeStepError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// DriverQueuePort — the product queue dispatcher stays the placement owner
// ---------------------------------------------------------------------------

function createProductDriverQueuePort(): DriverQueuePort {
  return {
    async peek() {
      // The product turn-system queue dispatcher owns steering/follow-up
      // placement (each placed item opens its own product turn = driver
      // run). The driver's inbox is therefore empty in this composition
      // stage; boundary placement is a structural no-op, never a silent
      // second placement owner.
      return [];
    },
    async claim() {},
    async settle() {},
    async withdrawQueued() {},
  };
}

// ---------------------------------------------------------------------------
// DriverTranscriptPort — reconciliation over the durable canonical history
// ---------------------------------------------------------------------------

function createCanonicalHistoryTranscriptPort(
  options: ProductTurnDriverHostOptions,
  nowMs: () => number,
): DriverTranscriptPort {
  return {
    async headEntryId(conversationId) {
      const messages = await readActiveMessages(options, conversationId);
      const last = messages.at(-1);
      return last === undefined ? EMPTY_TRANSCRIPT_CUTOFF : transcriptEntryIds(messages).at(-1)!;
    },
    async assistantAfter(conversationId, cutoff) {
      const messages = await readActiveMessages(options, conversationId);
      const ids = transcriptEntryIds(messages);
      const cutoffIndex = ids.indexOf(cutoff);
      for (let index = messages.length - 1; index > cutoffIndex; index -= 1) {
        const message = messages[index]!;
        if (readRole(message) !== 'assistant') continue;
        return {
          entryId: ids[index]!,
          stopReason: readStringProperty(message, 'stopReason') ?? 'stop',
          toolCalls: readToolCalls(message),
        };
      }
      return undefined;
    },
    async toolResultOf(conversationId, callId) {
      const messages = await readActiveMessages(options, conversationId);
      const ids = transcriptEntryIds(messages);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (readRole(message) !== 'toolResult') continue;
        if (readStringProperty(message, 'toolCallId') !== callId) continue;
        return ids[index]!;
      }
      return undefined;
    },
    async appendSyntheticToolResult(input) {
      await options.canonicalHistory.append({
        sessionId: input.conversationId,
        turnId: driverTurnId(input.conversationId),
        reason: 'messageDelta',
        messages: [
          {
            role: 'toolResult',
            content: [{ type: 'text', text: input.message }],
            toolCallId: input.callId,
            toolName: input.name,
            isError: input.isError,
            timestamp: nowMs(),
          },
        ],
        operation: {
          id: `turn-driver-synthetic:${input.conversationId}:${input.callId}`,
          kind: 'turn-driver',
        },
      });
      return `mcode.turn-driver.synthetic#${input.callId}`;
    },
    async appendContinuationUserEntry(conversationId, content) {
      await options.canonicalHistory.append({
        sessionId: conversationId,
        turnId: driverTurnId(conversationId),
        reason: 'messageDelta',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: continuationText(content) }],
            timestamp: nowMs(),
          },
        ],
        operation: {
          id: `turn-driver-continuation:${conversationId}:${nowMs()}`,
          kind: 'turn-driver',
        },
      });
      return `mcode.turn-driver.continuation#${conversationId}`;
    },
  };
}

async function readActiveMessages(
  options: ProductTurnDriverHostOptions,
  conversationId: string,
): Promise<readonly unknown[]> {
  // inspectActive never initializes or rewrites artifacts (read-only probe).
  const snapshot = await options.canonicalHistory.inspectActive(conversationId);
  return snapshot.messages;
}

/**
 * Content-addressed entry ids over the canonical messages (the same
 * convention as the context-wire bridge): a canonical message is immutable
 * once committed, and identical repeats disambiguate by occurrence order —
 * recomputed identically on every read of the same history.
 */
function transcriptEntryIds(messages: readonly unknown[]): readonly string[] {
  const counts = new Map<string, number>();
  return messages.map((message) => {
    const digest = createHash('sha256')
      .update(JSON.stringify(message), 'utf-8')
      .digest('hex')
      .slice(0, 16);
    const seen = counts.get(digest) ?? 0;
    counts.set(digest, seen + 1);
    return seen === 0
      ? `${TRANSCRIPT_ENTRY_PREFIX}#${digest}`
      : `${TRANSCRIPT_ENTRY_PREFIX}#${digest}#${seen + 1}`;
  });
}

function readRole(message: unknown): unknown {
  return typeof message === 'object' && message !== null ? Reflect.get(message, 'role') : undefined;
}

function readStringProperty(source: unknown, property: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = Reflect.get(source, property);
  return typeof value === 'string' ? value : undefined;
}

function readToolCalls(
  message: unknown,
): readonly { readonly callId: string; readonly name: string }[] {
  const content = typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null || Reflect.get(block, 'type') !== 'toolCall') {
      return [];
    }
    const callId = String(Reflect.get(block, 'id') ?? '');
    const name = String(Reflect.get(block, 'name') ?? '');
    return callId ? [{ callId, name }] : [];
  });
}

function continuationText(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

function driverTurnId(conversationId: string): string {
  // Driver recovery writes are host-owned turns of the conversation.
  return `turn-driver:${conversationId}`;
}

// ---------------------------------------------------------------------------
// Model identity — resolved per prepare, frozen into the request checkpoint
// ---------------------------------------------------------------------------

/**
 * Resolves the run's model identity from the product's session record (and,
 * when available, the Agent execution snapshot's model config). The frozen
 * identity labels the durable request checkpoint; the part-A loop keeps
 * resolving the actual streaming model — an unresolved identity degrades to
 * the documented pending label rather than failing the product turn
 * (`no_model` stays reserved for the executor-adapter stage, where the plan
 * IS the streaming contract).
 */
async function resolveProductModelIdentity(
  options: ProductTurnDriverHostOptions,
  conversationId: string,
): Promise<DriverPrepareResolution> {
  const session = await options.sessions.get(conversationId);
  const fromSnapshot = session ? await resolveSnapshotModel(options, session) : undefined;
  const identity = fromSnapshot ?? parseEffectiveModelIdentity(session?.effectiveModel);
  return {
    model: identity ?? { providerId: 'mavis', modelId: 'session-model-pending' },
    thinkingLevel: readThinkingLevel(session),
    streamOptions: {},
  };
}

async function resolveSnapshotModel(
  options: ProductTurnDriverHostOptions,
  session: SessionRecord,
): Promise<{ readonly providerId: string; readonly modelId: string } | undefined> {
  if (!options.agents) return undefined;
  try {
    const snapshot = await readSessionAgentExecutionSnapshot(options.agents, session);
    const model = snapshot?.model;
    if (!model) return undefined;
    const provider = readStringProperty(model, 'provider');
    const modelId = readStringProperty(model, 'id') ?? readStringProperty(model, 'modelId');
    if (provider !== undefined && modelId !== undefined) {
      return { providerId: provider, modelId };
    }
    return undefined;
  } catch {
    // Identity resolution is best-effort bookkeeping; the step executor owns
    // the real model resolution.
    return undefined;
  }
}

/** Parses the session's `effectiveModel` (`provider/modelId`) identity. */
function parseEffectiveModelIdentity(
  effectiveModel: string | null | undefined,
): { readonly providerId: string; readonly modelId: string } | undefined {
  if (typeof effectiveModel !== 'string') return undefined;
  const separator = effectiveModel.indexOf('/');
  if (separator <= 0 || separator === effectiveModel.length - 1) return undefined;
  return {
    providerId: effectiveModel.slice(0, separator),
    modelId: effectiveModel.slice(separator + 1),
  };
}

function readThinkingLevel(session: SessionRecord | undefined): string {
  const thinking = session?.effectiveModelThinking;
  if (thinking !== undefined && thinking !== null && typeof thinking !== 'object') {
    return String(thinking);
  }
  if (typeof thinking === 'object' && thinking !== null) {
    const level = Reflect.get(thinking, 'level') ?? Reflect.get(thinking, 'thinking');
    if (typeof level === 'string' && level.trim()) return level;
  }
  return 'off';
}

// ---------------------------------------------------------------------------
// Clock + event observation
// ---------------------------------------------------------------------------

function createProductDriverClock(nowMs: () => number) {
  return {
    nowMs,
    sleepUntil(untilMs: number, signal: AbortSignal): Promise<void> {
      const remaining = Math.max(0, untilMs - nowMs());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, remaining);
        function onAbort() {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

function observeDriverEvent(event: TurnDriverEvent): void {
  try {
    integrationLog.debug('turn driver event', { ...event });
    if (event.type === 'driver.run.settled' || event.type === 'driver.recovered') {
      integrationLog.info(`turn driver ${event.type}`, { ...event });
    }
  } catch {
    // Observation must never break correctness (§2.6 I10).
  }
}
