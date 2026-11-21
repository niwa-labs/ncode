import type { PiDurableCompositionRoot } from '../../../session-system/messages/history/pi-durable-root.js';
import {
  DurableTurnDriver,
  type DriverPrepareResolution,
} from './durable-turn-driver.js';
import {
  DurableTurnDriverStore,
  type TurnDriverCheckpoint,
  type TurnDriverSaveInput,
  type TurnDriverStateView,
  type TurnDriverStorePort,
  type TurnDriverStoreResult,
} from './turn-driver-store.js';
import type {
  DriverClock,
  DriverCompactionGate,
  DriverQueuePort,
  DriverSettings,
  DriverTranscriptPort,
  TurnDriverEventSink,
  TurnStepExecutor,
} from './driver-contracts.js';

/**
 * W10 Part A — composition of the W04 durable turn-driver into the product
 * flow (W04 part B deferred item 2: "Runtime-композиция драйвера в
 * продуктовый путь (services.ts/production-composition, адаптеры
 * DriverQueuePort/DriverTranscriptPort поверх input-delivery/durable-history)
 * — W10").
 *
 * The durable state of the driver lives on the runtime's ONE storage: the
 * {@link DurableTurnDriverStore} opens over the composition root's seam port
 * (`mcode.turn-driver.state` records in the bridge log, revision-CAS,
 * single-writer fenced) — the same storage as the canonical history, the
 * checkpoint barrier and the orchestration scheduler.
 *
 * The behavior-bearing collaborators stay EXPLICIT composition inputs,
 * fail-closed:
 * - `executor` — the ONE turn-step executor (W04 part A loop adapter; the
 *   driver refuses to start without a binding, I01);
 * - `queue` — the steering/follow-up queue port (input-delivery receipts:
 *   saved/placed/delivered stay distinct);
 * - `transcript` — the committed-transcript reconciliation port (durable
 *   history);
 * - `compaction` — the unified compaction gate (the wire pipeline's
 *   scheduler); omitted = compaction waits disabled.
 *
 * @module
 */

export interface ProductTurnDriverOptions {
  /**
   * The session's pi composition root, resolved per conversation id (the
   * product session id string — `driver.bind(input.lease.sessionId)`).
   * Per-session durable history (owner decision 2026-11-18): the driver's
   * state rides the SESSION's own log/port, so driver checkpoints coexist
   * across processes exactly like the history files. The root must already
   * be open (the provider's ensureState opened the session first).
   */
  readonly rootOfSession: (sessionId: string) => PiDurableCompositionRoot;
  /** The ONE turn-step executor (W04 part A loop adapter). */
  readonly executor: TurnStepExecutor;
  /** Queue port over the product steering/follow-up queue. */
  readonly queue: DriverQueuePort;
  /** Transcript reconciliation port over the durable canonical history. */
  readonly transcript: DriverTranscriptPort;
  /** Unified compaction gate; omitted disables compaction waits. */
  readonly compaction?: DriverCompactionGate;
  readonly settings: DriverSettings;
  readonly resolveModel: (conversationId: string) => Promise<DriverPrepareResolution | undefined>;
  readonly clock: DriverClock;
  readonly events?: TurnDriverEventSink;
}

export interface ProductTurnDriver {
  readonly driver: DurableTurnDriver;
  readonly store: TurnDriverStorePort;
}

/**
 * One {@link DurableTurnDriverStore} per conversation, over that session's
 * own pi port — the per-session routing view of the driver store. Store
 * instances are cheap port wrappers; the map only caches them.
 */
class RoutingTurnDriverStore implements TurnDriverStorePort {
  readonly #stores = new Map<string, DurableTurnDriverStore>();
  readonly #rootOf: (sessionId: string) => PiDurableCompositionRoot;

  constructor(rootOf: (sessionId: string) => PiDurableCompositionRoot) {
    this.#rootOf = rootOf;
  }

  #store(conversationId: string): DurableTurnDriverStore {
    let store = this.#stores.get(conversationId);
    if (!store) {
      store = new DurableTurnDriverStore(this.#rootOf(conversationId).port);
      this.#stores.set(conversationId, store);
    }
    return store;
  }

  read(conversationId: string): TurnDriverStateView {
    return this.#store(conversationId).read(conversationId);
  }

  readCheckpoint(conversationId: string): TurnDriverCheckpoint | undefined {
    return this.#store(conversationId).readCheckpoint(conversationId);
  }

  save(input: TurnDriverSaveInput): Promise<TurnDriverStoreResult> {
    return this.#store(input.conversationId).save(input);
  }
}

/**
 * Composes the product turn driver over the runtime's per-session stores.
 * Construction is cheap and side-effect free; `driver.bind(conversationId)`
 * performs the durable executor binding (fail-closed EXECUTOR_BOUND against
 * a second driver).
 */
export function composeProductTurnDriver(options: ProductTurnDriverOptions): ProductTurnDriver {
  const store = new RoutingTurnDriverStore(options.rootOfSession);
  const driver = new DurableTurnDriver({
    store,
    executor: options.executor,
    queue: options.queue,
    transcript: options.transcript,
    ...(options.compaction ? { compaction: options.compaction } : {}),
    settings: options.settings,
    resolveModel: options.resolveModel,
    clock: options.clock,
    ...(options.events ? { events: options.events } : {}),
  });
  return { driver, store };
}
