import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  currentGeneration,
  OwnerWriteLockError,
  SqliteZstdBackend,
} from '@mavis/durable-backend-sqlite-zstd';
import {
  createStorageWorker,
  entryDraftSizeBytes,
  sqliteZstdStorageBackend,
  type Entry,
  type StorageWorker,
} from '@mavis/storage-worker';
import { createLogger } from '@mavis/logging';
// R5: the chunked full-state seed protocol (history.v2.seed.begin/chunk/commit)
// has ONE implementation, shared with the history-import CLI. The provider
// replays and writes it; restate nothing locally.
import {
  createSeedScan,
  deriveSeedImportId,
  isSeedKind,
  seedBeginEntryId,
  SeedChunker,
  seedChunkEntryId,
  seedCommitEntryId,
  seedEntrySizeBytes,
  SEED_BEGIN_KIND,
  SEED_CHUNK_HARD_CAP_BYTES,
  SEED_CHUNK_KIND,
  SEED_COMMIT_KIND,
  SEED_MAPPING_VERSION,
  seedRootDigest,
  stitchSeedImport,
  type SeedBeginPayload,
  type SeedChunkPayload,
  type SeedChunkPlan,
  type SeedCommitPayload,
  type SeedEnvelope,
  type SeedImportScan,
} from '@mavis/legacy-history';

import type { SessionRepository } from '../../sessions/repo/contract.js';
import {
  canonicalActiveHistoryRevision,
  canonicalHistoryRevision,
  type CanonicalHistoryEnvelope,
  type CanonicalHistoryFileAdapter,
} from '../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../sessions/representation/canonical-history.js';
// R5: the canonical decoder stays the single validation authority — a
// CLI-seeded import's records are re-validated here, at load.
import { decodeCanonicalHistoryEnvelope } from '../../../../infra/file/canonical-history.js';
import { replaceFileAtomically } from '../../../../infra/file/jsonl.js';
import { repairCanonicalHistory } from './canonical-history-recovery.js';
import {
  applyFoldBase,
  applyFoldEntry,
  createEmptyFold,
  EVENT_COMPACTION_END,
  EVENT_COMPACTION_REPLACE,
  EVENT_COMPACTION_START,
  EVENT_COMPACTION_SUMMARY,
  EVENT_OFFLOAD,
  EVENT_REPAIR,
  EVENT_REPLACE_ALL,
  EVENT_TOMBSTONE,
  foldFromCheckpoint,
  isHistoryEventKind,
  materializeFold,
  parseFoldCheckpoint,
  resolveCompactionReplaceRange,
  resolveOpenCompactionLease,
  serializeFoldCheckpoint,
  type CompactionEndEvent,
  type CompactionReplaceEvent,
  type CompactionStartEvent,
  type CompactionSummaryEvent,
  type FoldCheckpoint,
  type OffloadEvent,
  type RepairEvent,
  type SessionFold,
  type TombstoneEvent,
  type ReplaceAllEvent,
} from './history-event-log.js';
import {
  openToolRoundTail,
  synthesizedUnknownOutcomeEnvelopes,
} from './mutation/session-turn-history-mutation.js';
import {
  composeGatedDurableHistoryWorkerBackend,
  openPiDurableCompositionRoot,
  type PiDurableCompositionRoot,
} from './pi-durable-root.js';
import {
  createDurableHistoryStores,
  DurableHistoryLogOwnedError,
  DurableSessionLogOwnedError,
  type DurableHistoryStores,
  type SessionDurableStores,
} from './durable-session-stores.js';
import { deleteSessionHistory, safeHistoryPathSegment } from './session-history-paths.js';
// Wave 2 (canon 05 §2.5): the content-addressed image artifact store and the
// receipt-boundary offload transform (base64 never enters the log).
import { ImageArtifactStore } from './image-artifact-store.js';
import { offloadMessageImages, offloadEventsOf } from './image-offload.js';
import {
  createSessionHistoryLocationResolver,
  type SessionHistoryLocationResolver,
} from './session-history-location.js';
import {
  ensureCanonicalHistoryMaterialized,
  type CanonicalHistoryLegacyMigration,
  type CanonicalHistoryMaterializerProgressListener,
} from './canonical-history-materializer.js';
import {
  appendEnvelopes,
  assertChange,
  buildCanonicalEnvelope,
  normalizeHistoryMessage,
  replacementEnvelopes,
  withCheckpointSystemBaseline,
  safeCompactionId,
  type HistorySnapshotTransform,
  type SessionCanonicalHistoryChange,
  type SessionCanonicalHistoryCommit,
  type SessionCanonicalHistoryCompactionChange,
  type SessionCanonicalHistorySnapshot,
  type SessionSystemCanonicalHistoryProvider,
} from './canonical-history-provider.js';
import { isUserMessageId } from '../../shared/user-message-id.js';
import {
  createSessionHistoryIoLane,
  type SessionHistoryActivity,
  type SessionHistoryIoLane,
} from './mutation/session-history-coordination.js';
import type {
  SessionHistoryMutationCapability,
  StagedSessionHistoryRewind,
} from './mutation/session-history-mutation-adapter.js';
import type {
  DurableJsonlPublisher,
  DurableJsonlPublisherDurableSource,
  DurableJsonlPublisherFactory,
  PublishedDurableState,
} from './durable-jsonl-publisher.js';

/**
 * Durable canonical-history provider (integration plan Ш1).
 *
 * Stores the canonical history of every Session as entries of ONE sqlite-zstd
 * durable log per runtime, written through the shared `StorageWorker` (Ш1:
 * the same instance later backs the turn checkpoint barrier — Ш2 — and the
 * steering backend). Appends enqueue only the delta (the JSONL provider's
 * O(n²) full re-read/rewrite per append disappears); the in-memory
 * per-Session state is authoritative between restarts and is rebuilt from
 * the log once per process.
 *
 * Selection follows the W10 hybrid default (port-plan §8 W10-C: "новый путь
 * становится hybrid default"): the DURABLE provider is the default since W10,
 * and `MCODE_HISTORY_PROVIDER=jsonl` is the explicit compatibility mode that
 * keeps the exact legacy behavior. Unknown env values fail closed with a
 * clear error (supported: `durable`, `jsonl`) instead of silently
 * downgrading. The single storage instance is created by the runtime
 * composition (`services.ts`), never by this module.
 *
 * File-backed mutations (settle/retract/fork/rewind) keep their JSONL
 * publication path and are mirrored back into the durable log by
 * {@link wrapSessionHistoryMutationForDurable}. Since W1 the durable state is
 * ALSO published continuously onto `messages.jsonl` by the injected
 * `DurableJsonlPublisher` (architecture §3.2): the pre-mutation publish below
 * (invariant I-PUB-1) is a cheap catch-up flush in the steady state, and the
 * mirror only ever sees a fresh file. The coarse
 * `publishDurableStateToFiles` remains the fail-closed backstop for
 * compositions without a publisher.
 *
 * Ш3: the provider exposes `withSnapshotTransform` like the JSONL private
 * reader. Through that seam the turn path receives each message once as a
 * validated, deeply frozen, ownership-transferred value (weakly cached across
 * reads), so per-turn history reads stop structured-cloning and re-repairing
 * the whole sequence.
 *
 * @module
 */

const log = createLogger('mcode:turn');
/**
 * Seed protocol events (integration plan R5: begin/chunk/commit with bytes and
 * entries) are storage events, logged under the registry's `mcode:storage`
 * namespace like the backend's own commit logs.
 */
const storageLog = createLogger('mcode:storage');

/** Env flag selecting the canonical-history provider; W10 default is `durable`, `jsonl` is the explicit compatibility mode. */
export type HistoryProviderMode = 'durable' | 'jsonl';
const HISTORY_PROVIDER_ENV = 'MCODE_HISTORY_PROVIDER';

/**
 * Resolves the provider mode from the environment (W10 hybrid default:
 * `durable`). `jsonl` is the explicit compatibility mode. Unknown values
 * fail closed with a clear error — a silent downgrade to the legacy
 * provider is exactly the W10-C elimination target.
 */
export function resolveHistoryProviderMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HistoryProviderMode {
  const raw = env[HISTORY_PROVIDER_ENV]?.trim().toLowerCase();
  if (!raw || raw === 'durable') return 'durable';
  if (raw === 'jsonl') return 'jsonl';
  throw new Error(
    `Unsupported ${HISTORY_PROVIDER_ENV} value '${raw}' (supported: 'durable' (default), 'jsonl' (legacy compatibility)); refusing to silently downgrade the canonical-history provider`,
  );
}

/** True when the env EXPLICITLY selected durable mode (vs the W10 default). */
export function isExplicitDurableHistoryProviderMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[HISTORY_PROVIDER_ENV]?.trim().toLowerCase() === 'durable';
}

/**
 * The durable-history storage of one runtime (per-session model, owner
 * decision 2026-11-18): one OWN sqlite-zstd log per session under
 * `durable-history/sessions/<id>/`, a ROUTING storage worker over them, and
 * — for runtimes that own scheduling/delegation (the mcoded daemon) — the
 * shared SYSTEM log (the legacy monolith). See `durable-session-stores.ts`.
 */
export type DurableHistoryStorage = DurableHistoryStores;
export {
  createDurableHistoryStores as createDurableHistoryStorage,
  DurableHistoryLogOwnedError,
  DurableSessionLogOwnedError,
};

/**
 * Single-entry cap of the durable history log. History deltas carry full
 * provider messages, so the backend default (256 KiB) is raised to keep
 * ordinary large tool rounds on the ordinary append path; the worker's
 * admission cap mirrors the backend's (their documented invariant). The
 * per-session stores factory (`durable-session-stores.ts`) passes the same
 * caps to every session worker it opens.
 */
const DURABLE_HISTORY_BATCH_CAP_BYTES = 8 * 1024 * 1024;
/** Uncompressed read window of one log-scan step. */
const READ_DELTA_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * R1 guard: the file-backed mutation was planned on a `messages.jsonl` that
 * lagged the durable log; the provider refreshed the file from durable state
 * and refused the adopt, so the mutation must rerun on the fresh baseline
 * instead of silently dropping the durable-only tail.
 */
export class DurableAdoptStaleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableAdoptStaleFileError';
  }
}

/** Entry kinds of the durable history log. */
const APPEND_KIND = 'history.v1.append';
const FULL_KIND = 'history.v1.full';



/**
 * Wave 1 (canon 1.6): a compaction attempt tried to start while THIS
 * instance's earlier `compaction.start` is still open inside the lease
 * window. Never a silent override — the open attempt is closed or the lease
 * expires first.
 */
export class CompactionStartLeaseActiveError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly compactionId: string,
    readonly startedAtMs: number,
  ) {
    super(message);
    this.name = 'CompactionStartLeaseActiveError';
  }
}

interface AppendPayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly operationId: string;
  readonly envelopes: readonly CanonicalHistoryEnvelope[];
}

interface FullPayload {
  readonly sessionId: string;
  readonly reason: FullStateReason;
  readonly envelopes: readonly CanonicalHistoryEnvelope[];
}

type FullStateReason = 'seed' | 'replace' | 'compact' | 'adopt' | 'repair' | 'delete';

/**
 * The session-system canonical-history provider backed by
 * {@link DurableHistoryStorage}. Implements the exact
 * `SessionSystemCanonicalHistoryProvider` interface, so
 * `adaptCanonicalHistory` (provider-agnostic) consumes it unchanged.
 */
export interface DurableSessionSystemCanonicalHistoryProvider
  extends SessionSystemCanonicalHistoryProvider {
  /**
   * Mirrors the canonical state a file-backed mutation just published (the
   * JSONL mutation adapter path) into the durable log. Fail-closed: a failed
   * mirror propagates to the mutation caller instead of leaving divergence.
   */
  adoptFromFiles(sessionId: string, options?: { freshBaseline?: boolean }): Promise<void>;
  /**
   * R1 guard: publish the session's CURRENT durable state into
   * `messages.jsonl` before a file-backed mutation plans on it, so the
   * mutation (and the adopt that mirrors it back) can never drop a
   * durable-only tail. No-op when the file is already fresh.
   */
  publishDurableStateToFiles(sessionId: string): Promise<void>;
  /**
   * W1: the continuous durable→jsonl publisher created through the
   * composition's `publisherFactory`; `undefined` when the composition did
   * not inject one (the pre-mutation publish then keeps the coarse backstop).
   */
  readonly publisher?: DurableJsonlPublisher;
  /**
   * Wave 1 (canon 1.7): the EXPLICIT physical purge. `delete` only appends a
   * tombstone event — the durable log keeps every envelope (the session is
   * restorable from the log) and the derived session files stay on disk.
   * Only this method removes the derived files (`rmSync` of the session
   * history directory); the log's own bytes are immutable and physically
   * reclaimed only by the wave-4 log compaction.
   */
  purgeSession(sessionId: string): Promise<void>;
  /**
   * Wave 2 (canon 05 §2.2, item 2.4): applies a TEXT offload plan — one
   * `history.v2.offload{seq, blockIdx, replacement → artifactRef}` event per
   * item, the fold shows the stub receipts in the active history while the
   * log keeps the original tool-result bytes. Fail-closed on a plan whose
   * positions do not resolve against the CURRENT fold (a stale plan throws
   * and writes nothing).
   */
  offloadToolText(
    sessionId: string,
    items: readonly {
      /** Index of the target envelope in the CURRENT active history. */
      readonly envelopeIndex: number;
      /** The stub receipt replacing the envelope's text blocks. */
      readonly replacement: string;
      /** The artifact reference the receipt names (the sha256 / file stem). */
      readonly reference: string;
    }[],
  ): Promise<void>;
}

/**
 * Wave 2 (item 2.4): the injected tool-result TEXT offload policy — evaluated
 * by the provider after each append, so the axis that used to run as the
 * legacy `tool_archive` compaction (a whole-history `full`/replace rewrite)
 * becomes kilobyte offload events over the fresh fold. The plan runs over the
 * CURRENT active envelopes; the artifact writes happen inside the planner.
 */
export interface DurableToolTextOffload {
  plan(input: {
    readonly sessionId: string;
    readonly envelopes: readonly CanonicalHistoryEnvelope[];
  }): Promise<
    readonly {
      readonly envelopeIndex: number;
      readonly replacement: string;
      readonly reference: string;
    }[]
  >;
}

export interface DurableSessionSystemCanonicalHistoryProviderOptions {
  readonly storage: DurableHistoryStorage;
  readonly dataDir: string;
  readonly sessions: Pick<SessionRepository, 'get'> &
    Partial<Pick<SessionRepository, 'bindHistoryRelativeDir'>>;
  readonly locations?: SessionHistoryLocationResolver;
  readonly legacyHistory?: CanonicalHistoryLegacyMigration;
  /**
   * R4: optional progress channel threaded into the legacy materialization
   * (scan → normalize → verify → complete). Diagnostic only.
   */
  readonly onProgress?: CanonicalHistoryMaterializerProgressListener;
  readonly nowMs?: () => number;
  readonly ioLane?: SessionHistoryIoLane;
  readonly activity?: SessionHistoryActivity;
  /**
   * W1 (architecture §3.2): when provided, the provider creates the
   * `DurableJsonlPublisher` over its private state and drives it after every
   * durability flush (the publish trigger, W0 F6) and at the cold-open
   * reconcile (§3.3/§3.4(a)). The product composition always provides it.
   */
  readonly publisherFactory?: DurableJsonlPublisherFactory;
  /**
   * Wave 2 (canon 05 §2.5, item 2.1): the content-addressed image artifact
   * store over `<dataDir>/artifacts`. When present, every append offloads the
   * messages' inline image blocks into artifacts BEFORE envelope identity is
   * computed — the log stores the reference blocks and one
   * `history.v2.offload` event per image, never base64. Absent (tests,
   * embeddings), appends keep the exact pre-wave-2 behavior.
   */
  readonly imageArtifacts?: ImageArtifactStore;
  /**
   * Wave 2 (canon 05 §2.2, item 2.4): the tool-result TEXT offload policy.
   * Evaluated after each append against the fresh fold; each planned item
   * becomes one kilobyte `offload` event (the artifact with the full text is
   * written by the planner). Absent: no offload axis — the wire-mode
   * composition injects it (the legacy `tool_archive` compaction axis is
   * removed there); the jsonl compatibility composition keeps the legacy
   * semantics and injects nothing.
   */
  readonly toolTextOffload?: DurableToolTextOffload;
}

/**
 * R5: an unfinished seed import exists for the session with a DIFFERENT
 * import id than the one about to be written. Two imports on one session
 * without an explicit resolution are forbidden (test architecture §10.2) —
 * the error names both ids so a resuming caller can finish the open import
 * (its chunks are durable) instead of silently forking it.
 */
export class SeedImportConflictError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly openImportId: string,
    readonly attemptedImportId: string,
  ) {
    super(message);
    this.name = 'SeedImportConflictError';
  }
}

/**
 * R5: a single record's serialized entry reaches the hard admission cap. The
 * import fails controlled — chunks already flushed stay durable and a resume
 * will find them — and nothing partial is published; fragmented envelopes
 * (test architecture §10.2, R9) are the follow-up work for such sessions.
 */
export class SeedRecordTooLargeError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly importId: string,
    readonly bytes: number,
    readonly capBytes: number,
  ) {
    super(message);
    this.name = 'SeedRecordTooLargeError';
  }
}

/** One decoded durable-log entry: writer id/sequence plus its typed payload. */
interface DurableLogEntry {
  readonly id: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload:
    | AppendPayload
    | FullPayload
    | SeedBeginPayload
    | SeedChunkPayload
    | SeedCommitPayload;
}

interface SessionState {
  /**
   * Wave 1: the authoritative FOLD of the session's log (origin segments,
   * event-stamped generation, per-session logical seq head, open compaction).
   * The live path applies every write through the same fold functions the
   * cold start replays, so the live state and a fresh fold agree by
   * construction.
   */
  fold: SessionFold;
  envelopes: CanonicalHistoryEnvelope[];
  identityIds: Set<string>;
  /**
   * Per-session model (owner decision 2026-11-18): the fold was loaded from
   * the LEGACY monolith — the session's own file does not hold its history
   * yet. The next live write must SEED the session file with the whole fold
   * first (see ensureOwnLogFileForWrites); reset after the seed lands.
   */
  loadedFromLegacy?: boolean;
  /** Bumped on every committed mutation; keys the per-version caches. */
  version: number;
  activeCache?: { readonly version: number; readonly revision: string };
  settledCache?: {
    readonly version: number;
    readonly revision: string;
    readonly records: readonly CanonicalHistoryEnvelope[];
  };
}

export function createDurableSessionSystemCanonicalHistoryProvider(
  options: DurableSessionSystemCanonicalHistoryProviderOptions,
): DurableSessionSystemCanonicalHistoryProvider {
  const ioLane = options.ioLane ?? createSessionHistoryIoLane();
  const nowMs = options.nowMs ?? Date.now;
  /**
   * Identity token of THIS provider instance (one per process in production).
   * A `compaction.start` still open under a DIFFERENT token belongs to a dead
   * writer — the ownership lock guarantees a single live writer, so the next
   * compaction closes it as `abandoned` at once (canon 1.6: kill
   * mid-compaction → the next compaction starts). A start of THIS token
   * inside the lease window refuses a new attempt (fail-closed; the
   * per-session lane makes a concurrent commit impossible, so this only ever
   * surfaces a real defect).
   */
  const writerToken = randomUUID();
  // Wave 2 (canon 05 §2.5): the image artifact store (the receipt-boundary
  // offload) and the injected tool-result text offload policy (item 2.4).
  const imageArtifacts = options.imageArtifacts;
  const toolTextOffload = options.toolTextOffload;
  const files: CanonicalHistoryFileAdapter = createCanonicalHistoryFileAdapter();
  const locations =
    options.locations ??
    createSessionHistoryLocationResolver({ dataDir: options.dataDir, sessions: options.sessions });
  const states = new Map<string, SessionState>();
  /** Decoded log caches, one per session, keyed by that backend's carrier + head. */
  const logCaches = new Map<
    string,
    { readonly directory: string; readonly head: number; readonly entries: readonly DurableLogEntry[] }
  >();
  /** Last enqueued entry id per session — the `parentId` of the next entry. */
  const lastEntryIds = new Map<string, string>();

  // W1 (architecture §3.2): the durable side of the continuous jsonl
  // publisher. Every method runs with the session history I/O lane already
  // held by the publisher — none of them re-enters it.
  const durableSource: DurableJsonlPublisherDurableSource = {
    readCommitted: async (sessionId, mode): Promise<PublishedDurableState | undefined> => {
      if (mode === 'ensure') await ensureState(sessionId, 'resolve');
      const state = states.get(sessionId);
      if (!state) return undefined;
      return { envelopes: state.envelopes, revision: activeRevision(state) };
    },
    importForeignAppends: async (sessionId, foreign) => {
      const state = states.get(sessionId);
      if (!state) {
        throw new Error(`Foreign jsonl import before the session state was loaded: ${sessionId}`);
      }
      if (foreign.length === 0) return;
      // Parity of the append path: an interrupted committed tool round is
      // repaired before the delta lands on top; a non-toolResult delta over a
      // CLEAN open round closes the round honestly first (the incident 03
      // self-healing append). Wave 1: the repair is an appended event.
      if (hasPendingToolTail(state.envelopes)) {
        const recovery = repairCanonicalHistory(state.envelopes, { allowPendingToolCallTail: true });
        const [issue] = recovery.issues;
        const repairsCommittedTail =
          recovery.issues.length === 1 && issue?.kind === 'interrupted-tool-round';
        if (repairsCommittedTail) {
          const droppedTurnId = state.envelopes[recovery.records.length]?.turn_id;
          await enqueueRepairEvent(state, sessionId, {
            turnId: typeof droppedTurnId === 'string' ? droppedTurnId : 'external-jsonl',
            truncateTo: recovery.records.length,
            appended: [],
          });
          await flushDurability();
        } else if (recovery.issues.length === 0 && deltaCarriesNonToolResult(foreign)) {
          const round = openToolRoundTail(state.envelopes);
          if (round) {
            await enqueueRepairEvent(state, sessionId, {
              turnId: round.turnId,
              truncateTo: undefined,
              appended: synthesizedUnknownOutcomeEnvelopes({
                seed: `${round.turnId}:history-repair`,
                turnId: round.turnId,
                calls: round.unclosed,
                timestampMs: nowMs(),
              }),
            });
            await flushDurability();
          }
        }
      }
      assertAppendIdentityBoundary(state, foreign);
      // Incident 03 fail-closed parity with append(): the foreign tail is
      // validated by the same projected strict pass BEFORE the enqueue — a
      // delta that would land a non-toolResult record over an unclosed tool
      // round never reaches the durable log.
      const projectedRevision = canonicalActiveHistoryRevision([...state.envelopes, ...foreign]);
      const entryId = foreignAppendEntryId(sessionId, foreign, nowMs());
      const payload: AppendPayload = {
        sessionId,
        turnId: 'external-jsonl',
        operationId: entryId,
        envelopes: foreign,
      };
      await writeSessionEntry(state, sessionId, {
        id: entryId,
        kind: APPEND_KIND,
        payload,
      });
      state.activeCache = { version: state.version, revision: projectedRevision };
      await flushDurability();
      options.activity?.notify(sessionId);
    },
    adoptPublishedState: async (sessionId, records) => {
      const state = states.get(sessionId);
      if (!state) {
        throw new Error(`Published-state adopt before the session state was loaded: ${sessionId}`);
      }
      await enqueueFullState(state, sessionId, records, 'adopt');
      await flushDurability();
      options.activity?.notify(sessionId);
    },
  };
  const publisher = options.publisherFactory?.(durableSource);

  return view();

  // Ш3: the provider owns every envelope message it serves (appends detach at
  // envelope creation; seeds adopt freshly decoded file records; store commits
  // arrive deeply frozen), so — like the JSONL private reader — it can hand
  // its internal records to the ownership-transfer transform instead of
  // structured-cloning every message on every read. Views without a transform
  // keep the detached-copy boundary.
  function view(
    transform?: HistorySnapshotTransform,
  ): DurableSessionSystemCanonicalHistoryProvider {
    return {
      withSnapshotTransform: (next) => view(next),
      read: (sessionId) => ioLane.run(sessionId, () => readSettled(sessionId, transform)),
      readActive: (sessionId) => ioLane.run(sessionId, () => readActive(sessionId, transform)),
      inspectActive: (sessionId) => ioLane.run(sessionId, () => inspectActive(sessionId, transform)),
      initialize: (sessionId) =>
        ioLane.run(sessionId, async () => {
          await ensureState(sessionId, 'allocate');
        }),
      delete: (sessionId) => ioLane.run(sessionId, () => deleteSession(sessionId)),
      purgeSession: (sessionId) => ioLane.run(sessionId, () => purgeSession(sessionId)),
      offloadToolText: (sessionId, items) => ioLane.run(sessionId, () => offloadToolText(sessionId, items)),
      append: (change) => ioLane.run(change.sessionId, () => append(change, transform)),
      replace: (change) => ioLane.run(change.sessionId, () => replace(change, transform)),
      compact: (change) => ioLane.run(change.sessionId, () => compact(change, transform)),
      adoptFromFiles: (sessionId, adoptOptions) =>
        ioLane.run(sessionId, () => adoptFromFiles(sessionId, adoptOptions)),
      publishDurableStateToFiles: (sessionId) =>
        ioLane.run(sessionId, () => publishDurableStateToFiles(sessionId)),
      ...(publisher ? { publisher } : {}),
    };
  }

  // -- reads -----------------------------------------------------------------

  async function readSettled(
    sessionId: string,
    transform?: HistorySnapshotTransform,
  ): Promise<SessionCanonicalHistorySnapshot> {
    const state = await ensureState(sessionId, 'resolve');
    const settled = settledView(state);
    return snapshotFromRecords(settled.records, settled.revision, transform);
  }

  async function readActive(
    sessionId: string,
    transform?: HistorySnapshotTransform,
  ): Promise<SessionCanonicalHistorySnapshot> {
    const state = await ensureState(sessionId, 'resolve');
    return snapshotFromRecords(state.envelopes, activeRevision(state), transform);
  }

  async function inspectActive(
    sessionId: string,
    transform?: HistorySnapshotTransform,
  ): Promise<SessionCanonicalHistorySnapshot> {
    // Readonly inspection: never materializes, never seeds the log. The
    // in-memory per-Session state is authoritative between restarts (see the
    // module doc), so a session already materialized by read/append serves
    // straight from it — cached revision, no whole-log rescan, no full-history
    // re-hash; `ensureState` serves warm state the same way. Only a cold
    // session falls back to the readonly log/file scan below.
    const state = states.get(sessionId);
    if (state) return snapshotFromRecords(state.envelopes, activeRevision(state), transform);
    const located = await locations.inspectSession(sessionId);
    if (!located) throw new Error(`Session not found: ${sessionId}`);
    const folded = await loadSessionFold(sessionId);
    const records = folded
      ? materializeFold(folded)
      : ((await files.readTargetStrict(located.paths.messages)) ?? []);
    return snapshotFromRecords(records, canonicalActiveHistoryRevision(records), transform);
  }

  // -- writes ----------------------------------------------------------------

  async function append(
    change: SessionCanonicalHistoryChange,
    transform?: HistorySnapshotTransform,
  ): Promise<SessionCanonicalHistorySnapshot> {
    assertChange(change, 'messageDelta');
    const state = await ensureState(change.sessionId, 'resolve');
    const startedMs = nowMs();
    // Wave 2 (canon 05 §2.5, item 2.1): the image offload runs BEFORE
    // envelope identity is computed, so the stored message, its message id
    // and every later read-back agree on the artifact-reference form — the
    // base64 never enters the log. A re-read of the same image hashes to the
    // same content address (the store dedups; the new reference is not a
    // copy).
    let pendingImageOffloads: ReturnType<typeof offloadMessageImages>['offloads'] = [];
    let effectiveChange: SessionCanonicalHistoryChange = change;
    if (imageArtifacts !== undefined) {
      const result = offloadMessageImages(change.messages, imageArtifacts);
      if (result.offloads.length > 0) {
        effectiveChange = { ...change, messages: result.messages };
        pendingImageOffloads = result.offloads;
      }
    }
    const appended = appendEnvelopes(effectiveChange);
    assertAppendIdentityBoundary(state, appended);
    // Parity of the JSONL append path (appendWithInterruptedToolRoundRecovery):
    // appending onto an interrupted committed tool round first repairs that
    // tail, then appends the delta. Wave 1 (canon 1.5): the repair is an
    // APPENDED EVENT carrying only the delta (the truncate boundary, the
    // synthesized unknown outcomes) — the `history.v1.full reason='repair'`
    // rewrite of the whole history is gone.
    if (hasPendingToolTail(state.envelopes)) {
      const recovery = repairCanonicalHistory(state.envelopes, { allowPendingToolCallTail: true });
      const [issue] = recovery.issues;
      const repairsCommittedTail =
        recovery.issues.length === 1 && issue?.kind === 'interrupted-tool-round';
      if (repairsCommittedTail) {
        // The interrupted round's own turn id names the repair (the first
        // dropped envelope opens the round).
        const droppedTurnId = state.envelopes[recovery.records.length]?.turn_id;
        await enqueueRepairEvent(state, change.sessionId, {
          turnId: typeof droppedTurnId === 'string' ? droppedTurnId : change.turnId,
          truncateTo: recovery.records.length,
          appended: [],
        });
        await flushDurability();
      } else if (recovery.issues.length === 0 && deltaCarriesNonToolResult(appended)) {
        // Incident 03 (2026-11-05) self-healing append: a non-toolResult delta
        // (an abort-cascade cadence reminder, a partial assistant) over a CLEAN
        // pending tail. The runner's delivery gate holds such deltas while the
        // round's turn is alive, so a delta that still arrived here belongs to
        // a round whose remaining results can never come — exactly the
        // incident's abort cascade, which used to commit the delta FIRST and
        // fail the strict walk only when the next reader computed the revision
        // (the permanent "Conversation history could not be safely updated"
        // brick). Close the round honestly BEFORE the delta, with the same
        // unknown-outcome synthesis the abort reconcile uses — an accepted
        // call without a result is an honest tool error, never a fabricated
        // success — then let the delta append onto the settled history.
        const round = openToolRoundTail(state.envelopes);
        if (round) {
          await enqueueRepairEvent(state, change.sessionId, {
            turnId: round.turnId,
            truncateTo: undefined,
            appended: synthesizedUnknownOutcomeEnvelopes({
              seed: `${round.turnId}:history-repair`,
              turnId: round.turnId,
              calls: round.unclosed,
              timestampMs: nowMs(),
            }),
          });
          await flushDurability();
        }
      }
    }
    // Incident 03 fail-closed parity with the JSONL append path
    // (`assertCanonicalHistoryAppend` runs before `appendJsonl`): the PROJECTED
    // sequence is validated by the exact strict pass the return snapshot below
    // used to run only AFTER the commit. Anything the repair above could not
    // legitimately heal (orphan or out-of-order tool results, duplicate
    // identities) throws HERE — before enqueue — so the durable log can never
    // keep a poisoned append that only throws when the next reader computes
    // the revision. The computed revision primes the state cache, so the
    // post-commit return reuses it instead of re-walking the sequence — the
    // strict pass still costs exactly once per append.
    const projectedRevision = canonicalActiveHistoryRevision([...state.envelopes, ...appended]);
    const payload: AppendPayload = {
      sessionId: change.sessionId,
      turnId: change.turnId,
      operationId: change.operation.id,
      envelopes: appended,
    };
    await writeSessionEntry(state, change.sessionId, {
      id: appendEntryId(change, appended),
      kind: APPEND_KIND,
      payload,
    });
    state.activeCache = { version: state.version, revision: projectedRevision };
    await flushDurability();
    // Wave 2 (item 2.1): one `offload` event per offloaded image block — the
    // durable record of the physical offload (canon §2.5: "Событие offload —
    // только при физическом выносе байтов в артефакт"). The append entry's
    // own seq is now the fold head.
    if (pendingImageOffloads.length > 0) {
      await writeImageOffloadEvents(state, change.sessionId, state.fold.headSeq, pendingImageOffloads);
    }
    // Wave 2 (item 2.4): the tool-result TEXT offload axis — the legacy
    // tool_archive compaction's replacement, now kilobyte events over the
    // fresh fold instead of a whole-history rewrite. Best-effort: a planner
    // fault logs and moves on (the axis is maintenance, never a commit
    // precondition).
    if (toolTextOffload !== undefined && appended.length > 0) {
      try {
        const items = await toolTextOffload.plan({
          sessionId: change.sessionId,
          envelopes: state.envelopes,
        });
        if (items.length > 0) await offloadToolText(change.sessionId, items);
      } catch (error) {
        log.warn('tool-result text offload pass failed; continuing without it', {
          session_id: change.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    log.debug('append committed', {
      sessionId: change.sessionId,
      kind: change.operation.kind,
      entries: appended.length,
      ...(pendingImageOffloads.length > 0 ? { image_offloads: pendingImageOffloads.length } : {}),
      durationMs: nowMs() - startedMs,
    });
    options.activity?.notify(change.sessionId);
    // W1 publish trigger (W0 F6): strictly after the durability flush above.
    publisher?.notify(change.sessionId);
    return snapshotActive(state, transform);
  }

  async function replace(
    change: SessionCanonicalHistoryChange,
    transform?: HistorySnapshotTransform,
  ): Promise<SessionCanonicalHistorySnapshot> {
    assertChange(change, 'replaceMessages');
    const state = await ensureState(change.sessionId, 'resolve');
    const startedMs = nowMs();
    const replacement = replacementEnvelopes(change, state.envelopes);
    // Deviation from the JSONL replace: no generation-snapshot file is
    // published for `metadata.replacementId` — the durable log keeps every
    // full state, and the file-backed flows (fork/rewind companions) keep
    // reading their snapshots from the JSONL bundle they published.
    //
    // Wave 1 (canon §2.1: `full` stays only for seed/adopt): a replacement
    // that is ALREADY a bit-identical prefix of the canonical history — the
    // В1 barrier's delivery of a checkpoint the `compact` seam committed —
    // writes NOTHING. The log already holds that truth, and anything appended
    // beyond the delivered prefix (an owner input that caught up mid-turn)
    // survives by construction — the drop hazard of the whole-list rewrite is
    // gone. A genuine whole-history rewrite (a legacy migration, a foreign
    // adoption) is one `history.v2.replace` event carrying the new envelopes.
    if (isPrefixParity(replacement, state.envelopes)) {
      log.debug('replace delivered the canonical prefix; nothing to write', {
        sessionId: change.sessionId,
        entries: replacement.length,
        durationMs: nowMs() - startedMs,
      });
      return snapshotActive(state, transform);
    }
    const payload: ReplaceAllEvent = {
      kind: EVENT_REPLACE_ALL,
      sessionId: change.sessionId,
      envelopes: replacement,
      generation: state.fold.generation + 1,
    };
    await writeSessionEntry(state, change.sessionId, {
      id: replaceAllEntryId(change.sessionId, payload.generation, replacement),
      kind: EVENT_REPLACE_ALL,
      payload,
    });
    await flushDurability();
    log.debug('replace committed as a whole-history event', {
      sessionId: change.sessionId,
      entries: replacement.length,
      generation: payload.generation,
      durationMs: nowMs() - startedMs,
    });
    options.activity?.notify(change.sessionId);
    publisher?.notify(change.sessionId);
    return snapshotActive(state, transform);
  }

  /**
   * Wave 1 (canon 1.4): the compaction commit is the four-event protocol
   * `compaction.start{id, baseGeneration, coveredUpToSeq}` →
   * `compaction.summary{id, text, tokensBefore}` →
   * `compaction.replace{id, startSeq, endSeq}` → `compaction.end{id,
   * outcome}` — kilobytes over the covered seq range, never the full list.
   * The plan is validated by PROPERTIES before anything is written (the
   * covered range exists and does not cut a tool round, `endSeq ≤ head`,
   * `baseGeneration` matches the fold, the summary is non-empty and smaller
   * than its source); the shape rule "exactly one summary" is gone. Each
   * event is its own durability flush, so a crash mid-commit leaves the open
   * start the lease closes (1.6), and a failed write closes the attempt as
   * `failed`.
   */
  async function compact(
    change: SessionCanonicalHistoryCompactionChange,
    transform?: HistorySnapshotTransform,
  ): Promise<SessionCanonicalHistoryCommit> {
    const state = await ensureState(change.sessionId, 'resolve');
    const startedMs = nowMs();
    // 1.6 — the lease of an open attempt: a start from a dead writer (a
    // different instance token) or past the lease window closes as
    // `abandoned` before this attempt begins.
    const lease = resolveOpenCompactionLease(state.fold, writerToken, nowMs());
    if (lease === 'refuse') {
      const open = state.fold.openCompaction!;
      throw new CompactionStartLeaseActiveError(
        `A compaction attempt of ${change.sessionId} is still open inside its lease window (${open.compactionId}); refusing to start another one.`,
        change.sessionId,
        open.compactionId,
        open.startedAtMs,
      );
    }
    if (lease === 'close-committed') {
      await writeCompactionEnd(state, change.sessionId, state.fold.openCompaction!.compactionId, 'committed');
    }
    if (lease === 'close-abandoned') {
      const open = state.fold.openCompaction!;
      log.warn('closing an open compaction.start as abandoned (writer gone or lease expired)', {
        event: 'context_compaction_start_abandoned',
        session_id: change.sessionId,
        compaction_id: open.compactionId,
        writer_was_this_instance: open.writerToken === writerToken,
        started_at_ms: open.startedAtMs,
      });
      await writeCompactionEnd(state, change.sessionId, open.compactionId, 'abandoned');
    }
    // The В1 barrier RE-DELIVERS the checkpoint the `compact` seam already
    // committed: the same compaction id arrives through the commit pipeline
    // (metadata.replacementId — the delivery carries no top-level compaction
    // fields). The log already holds that truth — the re-delivery writes
    // NOTHING; the delivery's own job (reseeding the turn's window) happens
    // through the returned snapshot.
    const deliveryCompactionId = readDeliveryCompactionId(change);
    if (
      deliveryCompactionId !== undefined &&
      state.fold.lastCompaction?.compactionId === deliveryCompactionId
    ) {
      log.debug('compaction re-delivery of the committed checkpoint; nothing to write', {
        sessionId: change.sessionId,
        compaction_id: deliveryCompactionId,
      });
      return { ...snapshotActive(state, transform), generation: state.fold.generation };
    }
    // The plan is validated BEFORE any event is written: a refused plan
    // leaves no trace in the log. The replace range is resolved and validated
    // by its properties here too (canon 1.4, fail-closed): a stale
    // generation, a cut through a tool round, an ineffective summary, or a
    // degenerate window the event schema cannot express (incident
    // 2026-11-07, mvs_70b7f22 — an already-compacted window resolves an
    // inverted seq range) all refuse BEFORE the start event, never as a
    // poisoned replace already sitting in the log.
    const plan = planCompactionEvents(change, state);
    const baseGeneration = state.fold.generation;
    const compactionId = plan.compactionId;
    const range = resolveCompactionReplaceRange(state.fold, {
      coveredEnvelopeCount: plan.coveredEnvelopeCount,
      inserted: plan.inserted,
      summaryText: plan.summaryText,
      baseGeneration,
    });
    const startedAtMs = nowMs();
    let installed = false;
    let terminalFlushed = false;
    try {
      await writeCompactionEvent<CompactionStartEvent>(state, change.sessionId, {
        id: compactionEventEntryId(change.sessionId, compactionId, 'start'),
        kind: EVENT_COMPACTION_START,
        payload: {
          kind: EVENT_COMPACTION_START,
          sessionId: change.sessionId,
          compactionId,
          baseGeneration,
          coveredUpToSeq: state.fold.headSeq,
          writerToken,
          startedAtMs,
        },
      });
      await writeCompactionEvent<CompactionSummaryEvent>(state, change.sessionId, {
        id: compactionEventEntryId(change.sessionId, compactionId, 'summary'),
        kind: EVENT_COMPACTION_SUMMARY,
        payload: {
          kind: EVENT_COMPACTION_SUMMARY,
          sessionId: change.sessionId,
          compactionId,
          text: plan.summaryText,
          tokensBefore: plan.tokensBefore,
        },
      });
      await writeCompactionEvent<CompactionReplaceEvent>(state, change.sessionId, {
        id: compactionEventEntryId(change.sessionId, compactionId, 'replace'),
        kind: EVENT_COMPACTION_REPLACE,
        payload: {
          kind: EVENT_COMPACTION_REPLACE,
          sessionId: change.sessionId,
          compactionId,
          baseGeneration,
          startSeq: range.startSeq,
          endSeq: range.endSeq,
          endEnvelopeCount: range.endEnvelopeCount,
          inserted: plan.inserted,
          generation: baseGeneration + 1,
          producedBy: change.method,
          parentSnapshot: {
            generation: baseGeneration,
            compactionId,
            revision: activeRevision(state),
          },
        },
      });
      installed = true;
      await writeCompactionEvent<CompactionEndEvent>(state, change.sessionId, {
        id: compactionEventEntryId(change.sessionId, compactionId, 'end'),
        kind: EVENT_COMPACTION_END,
        payload: {
          kind: EVENT_COMPACTION_END,
          sessionId: change.sessionId,
          compactionId,
          outcome: 'committed',
        },
      });
      terminalFlushed = true;
    } catch (error) {
      if (!installed) {
        if (state.fold.lastCompaction?.compactionId === compactionId) {
          // Replace was enqueued but its durability is unknown. Never append a
          // false failure receipt: replay must resolve the actual commit fact.
          states.delete(change.sessionId);
        } else {
          await captureCompactionEnd(state, change.sessionId, compactionId, 'failed');
        }
        throw error;
      }
      log.warn('compaction installed; terminal receipt failed and will be reconciled on replay', {
        sessionId: change.sessionId, compactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // The post-commit fold must be a valid canonical sequence — the strict
    // pass the return snapshot hashes with (fail-closed parity with append).
    const committedRevision = activeRevision(state);
    log.info('compact committed through compaction events', {
      sessionId: change.sessionId,
      compaction_id: compactionId,
      generation: state.fold.generation,
      covered_envelopes: plan.coveredEnvelopeCount,
      inserted: plan.inserted.length,
      revision: committedRevision,
      durationMs: nowMs() - startedMs,
    });
    if (terminalFlushed) {
      const backend = await options.storage.backendForRead(change.sessionId);
      if (backend) await writeFoldCheckpoint(change.sessionId, state.fold, backend);
    }
    options.activity?.notify(change.sessionId);
    publisher?.notify(change.sessionId);
    return { ...snapshotActive(state, transform), generation: state.fold.generation };
  }

  /**
   * Wave 1 (canon 1.7): delete appends a TOMBSTONE event and touches nothing
   * on disk — the durable log keeps every envelope (the session is
   * restorable from the log until the explicit purge) and the derived session
   * files stay. Physical removal is {@link purgeSession}'s job.
   */
  async function deleteSession(sessionId: string): Promise<void> {
    // The tombstone's generation comes from the LOG's own fold (never from a
    // possibly-absent live state), and a second delete is a no-op: the first
    // tombstone already marks the session deleted and the generation rule
    // (every delete grows) would refuse a second one.
    const fold = await loadSessionFold(sessionId);
    if (fold && !fold.deleted) {
      const payload: TombstoneEvent = {
        kind: EVENT_TOMBSTONE,
        sessionId,
        generation: fold.generation + 1,
        deletedAtMs: nowMs(),
      };
      const entryId = tombstoneEntryId(sessionId, payload.deletedAtMs);
      await options.storage.worker.enqueue({
        entryId,
        parentId: lastEntryIds.get(sessionId) ?? null,
        kind: EVENT_TOMBSTONE,
        payload,
        bytes: entryDraftSizeBytes({ id: entryId, kind: EVENT_TOMBSTONE, payload }),
      });
      lastEntryIds.set(sessionId, entryId);
      await flushDurability();
    }
    states.delete(sessionId);
    log.info('session history deleted (tombstone; the log stays restorable until the explicit purge)', { sessionId });
    options.activity?.notify(sessionId);
    // The published files stay (the view is only removed by the explicit
    // purge); drop the publisher's per-session schedule/watermark state.
    publisher?.forget(sessionId);
  }

  /**
   * Wave 1 (canon 1.7): the explicit physical purge — the tombstone of
   * {@link deleteSession} plus the removal of the derived session history
   * directory. The durable log's own bytes are immutable; they are physically
   * reclaimed only by the wave-4 log compaction.
   */
  async function purgeSession(sessionId: string): Promise<void> {
    await deleteSession(sessionId);
    const located = await locations.resolveSession(sessionId);
    if (located) deleteSessionHistory(options.dataDir, located.session, located.paths);
    log.info('session history purged (derived files removed; the log bytes stay until the wave-4 compaction)', { sessionId });
  }

  async function adoptFromFiles(sessionId: string, adoptOptions?: { freshBaseline?: boolean }): Promise<void> {
    const session = await options.sessions.get(sessionId);
    if (!session) return;
    const paths = await locations.ensure(session);
    const published = await files.readStrict(paths.messages);
    const records = repairCanonicalHistory(published, { allowPendingToolCallTail: true }).records;
    // R1 guard (W0 F5, review round 1): only for callers that did NOT go
    // through the wrapper's pre-mutation publish (`freshBaseline`). The
    // wrapper's publishDurableStateToFiles makes the file equal the durable
    // state BEFORE the mutation plans on it, so the mutation result — even
    // a truncating settle — is always built on the fresh baseline and may
    // be mirrored back unconditionally. A direct adopt on a file we cannot
    // vouch for must refuse to overwrite the durable log when the file does
    // not match the durable revision: it is either a lagging file (prefix
    // of durable) or an unrelated/divergent one — in both cases mirroring
    // could drop the durable-only tail. Refresh the file from durable and
    // tell the caller to rerun its mutation on the fresh baseline.
    let state = states.get(sessionId);
    let publishedRecords = records;
    let publishedRevision = canonicalActiveHistoryRevision(publishedRecords);
    const freshBaseline = adoptOptions?.freshBaseline === true;
    if (!freshBaseline && (state === undefined || activeRevision(state) !== publishedRevision)) {
      const durable = state ?? (await ensureState(sessionId, 'resolve'));
      const durableRevision = activeRevision(durable);
      if (durableRevision !== publishedRevision) {
        await files.replaceActive(paths.messages, durable.envelopes);
        log.warn('unverifiable published history refreshed from durable before adopt', {
          sessionId,
          durableEntries: durable.envelopes.length,
          publishedEntries: publishedRecords.length,
          publishedWasPrefix: durableExtendsPublished(durable.envelopes, publishedRecords),
        });
        // Contract: the caller planned on a file that does not match the
        // durable log; the file has been refreshed from durable — rerun the
        // mutation on the fresh baseline and adopt again. The wrapper passes
        // freshBaseline for every product mutation (settle/retract/fork/
        // rewind publish durable state first); this throw is the backstop
        // for adopt calls that cannot vouch for their baseline.
        throw new DurableAdoptStaleFileError(
          `published messages.jsonl for ${sessionId} does not match the durable log; refreshed from durable (${durable.envelopes.length} entries), rerun the file mutation on the fresh baseline`,
        );
      }
      state = durable;
    }
    if (state && activeRevision(state) === publishedRevision) return;
    const startedMs = nowMs();
    if (!state) {
      state = createState(createEmptyFold());
      states.set(sessionId, state);
    }
    await enqueueFullState(state, sessionId, publishedRecords, 'adopt');
    await flushDurability();
    log.debug('file mutation mirrored', {
      sessionId,
      entries: publishedRecords.length,
      durationMs: nowMs() - startedMs,
    });
    options.activity?.notify(sessionId);
    publisher?.notify(sessionId);
  }

  /**
   * R1 guard helper: does the durable state strictly extend the published
   * records (same prefix, longer or equal with a newer tail)? A `true` means
   * the file lags the log and an adopt from it would drop durable-only
   * entries. Prefix comparison is by entry id — ids are content-addressed,
   * so an equal id at an equal index is an equal record.
   */
  function durableExtendsPublished(
    durable: readonly CanonicalHistoryEnvelope[],
    published: readonly CanonicalHistoryEnvelope[],
  ): boolean {
    if (published.length > durable.length) return false;
    for (let index = 0; index < published.length; index += 1) {
      if (published[index]!.message_id !== durable[index]!.message_id) return false;
    }
    return durable.length > published.length;
  }

  /**
   * R1 guard, publish side: flush the CURRENT durable state of the session
   * into `messages.jsonl` (atomic full rewrite through the file adapter) so
   * a file-backed mutation planned right after reads fresh state. Used by
   * {@link wrapSessionHistoryMutationForDurable} BEFORE the mutation runs;
   * the W1 DurableJsonlPublisher turns this coarse pre-mutation flush into a
   * continuous incremental publication.
   */
  async function publishDurableStateToFiles(sessionId: string): Promise<void> {
    const session = await options.sessions.get(sessionId);
    if (!session) return;
    const paths = await locations.ensure(session);
    const durable = await ensureState(sessionId, 'resolve');
    const published = await files.readStrict(paths.messages);
    const publishedRecords = repairCanonicalHistory(published ?? [], {
      allowPendingToolCallTail: true,
    }).records;
    if (canonicalActiveHistoryRevision(publishedRecords) === activeRevision(durable)) return;
    if (!durableExtendsPublished(durable.envelopes, publishedRecords)) return;
    await files.replaceActive(paths.messages, durable.envelopes);
    log.info('published durable state to files before file mutation', {
      sessionId,
      entries: durable.envelopes.length,
    });
  }

  // -- state -----------------------------------------------------------------

  async function ensureState(
    sessionId: string,
    locationMode: 'allocate' | 'resolve',
  ): Promise<SessionState> {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const session = await options.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const paths =
      locationMode === 'allocate'
        ? await locations.allocate(session)
        : await locations.ensure(session);
    await ensureCanonicalHistoryMaterialized({
      sessionId,
      paths,
      files,
      ...(options.legacyHistory ? { legacyHistory: options.legacyHistory } : {}),
      // Ш6: the durable provider reads the target v2 `messages.jsonl` through
      // the streaming legacy-history; the JSONL (legacy default) provider keeps
      // the legacy whole-file read.
      readTargetViaV2Adapter: true,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      nowMs,
    });
    const startedMs = nowMs();
    // Wave 1 (canon 1.3): the cold start resumes from the disposable fold
    // checkpoint when it matches this log generation — the open reads only
    // the delta after the checkpointed position, never the whole log.
    // Per-session files: the read backend is resolved BEFORE the session
    // claims its own file — a legacy session's data still lives in the
    // monolith, and the claim must not hide it behind the fresh empty file.
    const readBackend = await options.storage.backendForRead(sessionId);
    // Per-session model: the fold came from the LEGACY monolith when the
    // read carrier is the shared root — the session's own file does not hold
    // its history yet, and the next live write must seed it there.
    const loadedFromLegacy =
      readBackend !== undefined && readBackend.directory === options.storage.directory;
    const loaded = await loadSessionFold(sessionId, undefined, readBackend);
    const state = createState(loaded ?? createEmptyFold(), loadedFromLegacy);
    states.set(sessionId, state);
    // The claim (and the seed writes it routes) can refuse — another live
    // runtime owns THIS session's file, or the seed's first write hits the
    // ownership window. A warm state left behind would then serve stale
    // snapshots forever (a zombie): on ANY failure here the state is
    // discarded and the next ensureState retries the whole cold open.
    try {
      if (loaded) {
        log.debug('session state loaded', {
          sessionId,
          entries: state.envelopes.length,
          generation: state.fold.generation,
          headSeq: state.fold.headSeq,
          durationMs: nowMs() - startedMs,
        });
      } else {
        // No durable entries yet: adopt the materialized JSONL base (legacy,
        // migrated or pre-existing sessions). The seed entry is written for
        // EMPTY sessions too — every session's log must open with a full-state
        // base, or the first append would have nothing to fold from.
        const published = await files.readStrict(paths.messages);
        // R5: an unfinished seed import (a crashed provider seed or a crashed
        // history-import CLI run) may already hold durable chunks. When the
        // chunks carry exactly the published records, finish the import by
        // writing its commit; anything else is an explicit conflict — two
        // imports on one session never fork silently.
        const completed = await completeVerifiedSeedImport(state, sessionId, published);
        if (completed) {
          syncFoldToState(state);
        } else {
          const records = repairCanonicalHistory(published, {
            allowPendingToolCallTail: true,
          }).records;
          await enqueueFullState(state, sessionId, records, 'seed');
          await flushDurability();
        }
        // The seed wrote the base INTO THE SESSION'S OWN FILE (the routing
        // worker's target): the session is no longer a legacy-monolith
        // resident, and a later live write must not re-seed (a second
        // full-state write with the same entry id would replay-conflict).
        state.loadedFromLegacy = false;
        log.debug('session state seeded', {
          sessionId,
          entries: state.envelopes.length,
          durationMs: nowMs() - startedMs,
        });
      }
      // W1 §3.3/§3.4(a): cold open reconciles the published jsonl with the
      // durable log — catches a stale file up (prefix append or snapshot
      // rewrite) and imports a foreign tail the app wrote while it held the
      // turn lease. Runs on the lane the caller holds; never throws.
      if (publisher) await publisher.importForeignTail(sessionId, paths);
      // Per-session files: CLAIM the session's own log now — the fold (legacy
      // or own) is loaded, so the claim can no longer hide anything. The turn
      // driver binds right after ensureState; its pi port comes from this
      // open. A session owned by a live runtime in another process refuses
      // here, fast and typed (DurableSessionLogOwnedError).
      await options.storage.sessionStores(sessionId);
      return state;
    } catch (error) {
      states.delete(sessionId);
      throw error;
    }
  }

  function createState(fold: SessionFold, loadedFromLegacy = false): SessionState {
    const envelopes = materializeFold(fold);
    return {
      fold,
      envelopes,
      identityIds: new Set(envelopes.map(({ message_id }) => message_id)),
      ...(loadedFromLegacy ? { loadedFromLegacy: true } : {}),
      version: 0,
    };
  }

  /**
   * Re-syncs the materialized view after a fold mutation. The cost matches
   * the pre-wave live path (one O(n) rebuild per committed mutation — the
   * O(n²)-per-append rewrite this provider removed was the REBUILD's, which
   * now defers to one concatenation per fold).
   */
  function syncFoldToState(state: SessionState): void {
    state.envelopes = materializeFold(state.fold);
    state.identityIds = new Set(state.envelopes.map(({ message_id }) => message_id));
    state.version += 1;
    state.activeCache = undefined;
    state.settledCache = undefined;
  }

  function activeRevision(state: SessionState): string {
    if (state.activeCache?.version !== state.version) {
      state.activeCache = {
        version: state.version,
        revision: canonicalActiveHistoryRevision(state.envelopes),
      };
    }
    return state.activeCache.revision;
  }

  /**
   * Settled view: the active state with an interrupted trailing tool round
   * removed — and, when that round was the in-flight turn's only assistant
   * output, with the turn's user message(s) removed with it. The in-memory
   * state is a repaired, valid sequence by construction (seeds and file
   * mirrors adopt recovery output; appends repair an interrupted committed
   * tail before appending), so the settled view differs from the active one
   * only by a trailing pending tool round. An interrupted turn is replayed
   * whole, never partially: a turn that produced no completed assistant
   * message is entirely unsettled. Ш3: the authoritative repair scan therefore
   * runs only when that tail exists — never on the per-turn steady state.
   */
  function settledView(state: SessionState): {
    readonly revision: string;
    readonly records: readonly CanonicalHistoryEnvelope[];
  } {
    if (state.settledCache?.version !== state.version) {
      const records = hasPendingToolTail(state.envelopes)
        ? settledRecords(state.envelopes)
        : state.envelopes;
      state.settledCache = {
        version: state.version,
        revision: canonicalHistoryRevision(records),
        records,
      };
    }
    return state.settledCache;
  }

  /**
   * Settled records of an active history that ends with a pending tool round.
   * The repair drops the round itself; when the round's turn then holds no
   * assistant output of its own (its only assistant work was the pending
   * round), the turn never reached a settled boundary and its user
   * message(s) leave the settled view with the round.
   */
  function settledRecords(
    envelopes: readonly CanonicalHistoryEnvelope[],
  ): readonly CanonicalHistoryEnvelope[] {
    const recovery = repairCanonicalHistory(envelopes, { allowPendingToolCallTail: false });
    const records = recovery.records;
    const [issue] = recovery.issues;
    const pendingTurnId =
      issue?.kind === 'pending-tool-call-tail'
        ? envelopes[issue.recordIndex]?.turn_id
        : undefined;
    if (pendingTurnId === undefined) return records;
    let turnStart = records.length;
    while (turnStart > 0 && records[turnStart - 1]?.turn_id === pendingTurnId) turnStart -= 1;
    const inFlightTurn = records.slice(turnStart);
    const producedAssistantOutput = inFlightTurn.some(({ message }) => message.role === 'assistant');
    if (producedAssistantOutput || inFlightTurn.length === 0) return records;
    return records.slice(0, turnStart);
  }

  /**
   * Builds one snapshot of `records` at `revision`. Without a transform the
   * messages are detached per read (legacy boundary); with the
   * ownership-transfer transform the provider-owned records cross once through
   * the transform, so repeated turn reads reuse the transferred values.
   */
  function snapshotFromRecords(
    records: readonly CanonicalHistoryEnvelope[],
    revision: string,
    transform?: HistorySnapshotTransform,
  ): SessionCanonicalHistorySnapshot {
    const snapshot = {
      revision,
      messages: records.map(({ message }) => (transform ? message : detached(message))),
      identityVector: records.map(({ message_id }) => message_id),
    };
    return transform ? transform(snapshot) : snapshot;
  }

  function snapshotActive(
    state: SessionState,
    transform?: HistorySnapshotTransform,
  ): SessionCanonicalHistorySnapshot {
    return snapshotFromRecords(state.envelopes, activeRevision(state), transform);
  }

  function assertAppendIdentityBoundary(
    state: SessionState,
    appended: readonly CanonicalHistoryEnvelope[],
  ): void {
    for (const { message_id } of appended) {
      if (state.identityIds.has(message_id)) {
        throw new TypeError(`Canonical history append identity is duplicated: ${message_id}`);
      }
    }
  }

  // -- writes through the fold ------------------------------------------------

  /**
   * One durable entry write, applied to the session's fold with the next
   * per-session logical seq. The live path IS the fold: every write goes
   * through the same {@link applyFoldEntry} the cold start replays, so the
   * live state and a fresh fold agree by construction. Seed-commit entries
   * carry only the verifying payload — the caller publishes the base through
   * {@link applyFoldBase} with the stitched records.
   *
   * Per-session files (owner decision 2026-11-18): a session whose history
   * still lives in the LEGACY monolith gets its own file seeded HERE, at its
   * first live write — otherwise the new file would start headless and the
   * next cold open would truncate the history back to just the new events.
   * Seed/full-state writes themselves never re-enter the hook (they ARE the
   * migration), and a fold with no envelopes needs no seed.
   */
  async function writeSessionEntry(
    state: SessionState,
    sessionId: string,
    input: { readonly id: string; readonly kind: string; readonly payload: unknown },
  ): Promise<void> {
    await ensureOwnLogFileForWrites(state, sessionId, input.kind);
    const parentId = lastEntryIds.get(sessionId) ?? null;
    await options.storage.worker.enqueue({
      entryId: input.id,
      parentId,
      kind: input.kind,
      payload: input.payload as Record<string, unknown>,
      bytes: entryDraftSizeBytes({
        id: input.id,
        kind: input.kind,
        payload: input.payload,
      }),
    });
    lastEntryIds.set(sessionId, input.id);
    applyFoldEntry(state.fold, input, state.fold.headSeq + 1);
    syncFoldToState(state);
  }

  /**
   * Legacy-monolith → own-file migration of one session (the per-session
   * storage model): the session's FIRST live event seeds the whole current
   * fold into the session's own file as a full-state base, so the file is
   * self-sufficient from its first byte. Keyed by the LOADED-FROM-LEGACY
   * flag (not by file existence — the claim creates the file eagerly at
   * ensureState, which must not suppress the migration). No-op for
   * seed/full-state writes themselves and for folds with no envelopes.
   */
  async function ensureOwnLogFileForWrites(
    state: SessionState,
    sessionId: string,
    kind: string,
  ): Promise<void> {
    if (state.loadedFromLegacy !== true) return;
    if (isSeedKind(kind) || kind === FULL_KIND) return;
    if (state.envelopes.length === 0) {
      state.loadedFromLegacy = false;
      return;
    }
    storageLog.info('seeding the session own durable file from the legacy monolith data', {
      sessionId,
      envelopes: state.envelopes.length,
    });
    await enqueueFullState(state, sessionId, state.envelopes, 'seed');
    state.loadedFromLegacy = false;
  }

  /** One compaction-protocol event: enqueue, fold-apply, then its own durability flush. */
  async function writeCompactionEvent<T>(
    state: SessionState,
    sessionId: string,
    input: { readonly id: string; readonly kind: string; readonly payload: T },
  ): Promise<void> {
    await writeSessionEntry(state, sessionId, input);
    await flushDurability();
  }

  async function writeCompactionEnd(
    state: SessionState,
    sessionId: string,
    compactionId: string,
    outcome: 'committed' | 'failed' | 'abandoned',
  ): Promise<void> {
    const payload: CompactionEndEvent = {
      kind: EVENT_COMPACTION_END,
      sessionId,
      compactionId,
      outcome,
    };
    await writeCompactionEvent(state, sessionId, {
      id: compactionEventEntryId(sessionId, compactionId, 'end'),
      kind: EVENT_COMPACTION_END,
      payload,
    });
  }

  /** Best-effort `end{outcome}` after a mid-protocol failure; never masks the original error. */
  async function captureCompactionEnd(
    state: SessionState,
    sessionId: string,
    compactionId: string,
    outcome: 'committed' | 'failed' | 'abandoned',
  ): Promise<void> {
    try {
      await writeCompactionEnd(state, sessionId, compactionId, outcome);
    } catch (error) {
      log.warn('could not close the compaction attempt after a mid-protocol failure', {
        sessionId,
        compactionId,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Wave 1 (canon 1.5): the repair event — the incident-03 healing as an
   * APPENDED delta (the truncate boundary of an interrupted committed round,
   * the synthesized unknown outcomes of a clean one), never a
   * `history.v1.full reason='repair'` rewrite. The projected sequence was
   * validated by the caller (the strict pass before enqueue); the event
   * stamps the next generation (a repair invalidates compaction plans, canon
   * §2.1).
   */
  async function enqueueRepairEvent(
    state: SessionState,
    sessionId: string,
    input: {
      readonly turnId: string;
      readonly truncateTo: number | undefined;
      readonly appended: readonly CanonicalHistoryEnvelope[];
    },
  ): Promise<void> {
    // The payload must stay a strict JSON value: the absent truncate is the
    // key's ABSENCE, never an `undefined` value.
    const payload: RepairEvent = {
      kind: EVENT_REPAIR,
      sessionId,
      turnId: input.turnId,
      ...(input.truncateTo === undefined ? {} : { truncateTo: input.truncateTo }),
      appended: input.appended,
      generation: state.fold.generation + 1,
    };
    await writeSessionEntry(state, sessionId, {
      id: repairEventEntryId(sessionId, payload),
      kind: EVENT_REPAIR,
      payload,
    });
    log.debug('repair committed as an append event', {
      sessionId,
      turn_id: input.turnId,
      truncate_to: input.truncateTo,
      appended: input.appended.length,
      generation: payload.generation,
    });
  }

  /**
   * Wave 2 (canon 05 §2.5, item 2.1): one `history.v2.offload` event per
   * physically offloaded image block of an append. `seq` is the append
   * entry's own logical seq; `blockIdx` the envelope index inside it;
   * `contentBlockIdx` the image block inside the envelope's content;
   * `artifactRef` the content address (the artifact file stem).
   */
  async function writeImageOffloadEvents(
    state: SessionState,
    sessionId: string,
    appendSeq: number,
    offloads: readonly {
      readonly messageIndex: number;
      readonly contentBlockIdx: number;
      readonly artifact: { readonly sha256: string };
    }[],
  ): Promise<void> {
    for (const offload of offloads) {
      const payload: OffloadEvent = {
        kind: EVENT_OFFLOAD,
        sessionId,
        seq: appendSeq,
        blockIdx: offload.messageIndex,
        contentBlockIdx: offload.contentBlockIdx,
        artifactRef: offload.artifact.sha256,
      };
      await writeSessionEntry(state, sessionId, {
        id: offloadEventEntryId(sessionId, payload),
        kind: EVENT_OFFLOAD,
        payload,
      });
    }
    await flushDurability();
    log.debug('image offload events committed', {
      sessionId,
      append_seq: appendSeq,
      events: offloads.length,
    });
  }

  /**
   * Wave 2 (canon 05 §2.2, item 2.4): applies a TEXT offload plan — one
   * `offload{seq, blockIdx, replacement → artifactRef}` event per item, the
   * fold shows the stub receipts while the log keeps the original bytes.
   * Positions resolve against the CURRENT fold (an envelope index of the
   * active history maps onto its owning segment); a plan that does not
   * resolve throws fail-closed and writes NOTHING (a stale plan is the
   * caller's bug, never a partially applied rewrite).
   */
  async function offloadToolText(
    sessionId: string,
    items: readonly {
      readonly envelopeIndex: number;
      readonly replacement: string;
      readonly reference: string;
    }[],
  ): Promise<void> {
    if (items.length === 0) return;
    const state = await ensureState(sessionId, 'resolve');
    const startedMs = nowMs();
    let written = 0;
    for (const item of items) {
      const position = resolveFoldEnvelopePosition(state.fold, item.envelopeIndex);
      if (position === undefined) {
        throw new TypeError(
          `Tool-result text offload plan is stale: envelope index ${String(item.envelopeIndex)} does not resolve against the current fold (${String(state.fold.envelopeCount)} envelopes).`,
        );
      }
      const payload: OffloadEvent = {
        kind: EVENT_OFFLOAD,
        sessionId,
        seq: position.seq,
        blockIdx: position.blockIdx,
        artifactRef: item.reference,
        replacement: item.replacement,
      };
      await writeSessionEntry(state, sessionId, {
        id: offloadEventEntryId(sessionId, payload),
        kind: EVENT_OFFLOAD,
        payload,
      });
      written += 1;
    }
    await flushDurability();
    log.info('tool-result text offload committed as offload events', {
      session_id: sessionId,
      events: written,
      durationMs: nowMs() - startedMs,
    });
    publisher?.notify(sessionId);
  }

  /**
   * Maps one envelope index of the active (materialized) history onto its
   * owning fold segment: `(seq, blockIdx)` — the event-addressable position.
   */
  function resolveFoldEnvelopePosition(
    fold: SessionFold,
    envelopeIndex: number,
  ): { readonly seq: number; readonly blockIdx: number } | undefined {
    if (!Number.isSafeInteger(envelopeIndex) || envelopeIndex < 0 || envelopeIndex >= fold.envelopeCount) {
      return undefined;
    }
    let remaining = envelopeIndex;
    for (const segment of fold.segments) {
      if (remaining < segment.envelopes.length) {
        return { seq: segment.seq, blockIdx: remaining };
      }
      remaining -= segment.envelopes.length;
    }
    return undefined;
  }

  /**
   * Wave 1 (canon 1.4): translates a canonical compaction change into the
   * event plan — the summary envelope (plus the optional current-user
   * marker), the covered prefix count, and the property checks the
   * `compaction.replace` event is validated against. The kept tail is NOT
   * part of the plan: everything after the covered range survives in the log
   * as the live suffix, so the shape rule "exactly one summary" disappears
   * and the drop hazard (a replacement list snapshot losing messages that
   * caught up between the plan and the commit) is impossible by construction.
   */
  function planCompactionEvents(
    change: SessionCanonicalHistoryCompactionChange,
    state: SessionState,
  ): {
    readonly compactionId: string;
    readonly summaryText: string;
    readonly tokensBefore: number;
    readonly coveredEnvelopeCount: number;
    readonly inserted: readonly CanonicalHistoryEnvelope[];
  } {
    const compactionId = safeCompactionId(change.compactionId);
    const messages = change.messages;
    if (messages.length === 0) {
      throw new TypeError('Canonical checkpoint compaction must contain one native summary.');
    }
    const summaryEnvelope = buildCanonicalEnvelope({
      change,
      message: messages[0],
      turnId: `${change.turnId}:compaction`,
      index: 0,
    });
    if (summaryEnvelope.message.role !== 'compactionSummary') {
      throw new TypeError('Canonical checkpoint compaction must contain one native summary.');
    }
    const summaryMessage = summaryEnvelope.message as { summary?: unknown; tokensBefore?: unknown };
    const summaryText = typeof summaryMessage['summary'] === 'string' ? summaryMessage['summary'] : '';
    const tokensBefore =
      typeof summaryMessage['tokensBefore'] === 'number' ? summaryMessage['tokensBefore'] : 0;
    const inserted: CanonicalHistoryEnvelope[] = [summaryEnvelope];
    let coveredEnvelopeCount: number;
    if (change.replacementSourceIndexes !== undefined && change.replacementSourceIndexes.length > 0) {
      // The unified cut: the summary covers [0..cut), the first kept source is
      // the cut. The kept messages must still describe the real history
      // verbatim (the caller's view sanity) — but they are NOT written: the
      // log's own envelopes after the cut are the retained window.
      const indexes = change.replacementSourceIndexes;
      if (indexes.length !== messages.length - 1) {
        throw new TypeError('Canonical checkpoint compaction kept-tail source lineage is incomplete.');
      }
      let previous = -1;
      indexes.forEach((index) => {
        if (
          !Number.isSafeInteger(index) ||
          index <= previous ||
          index >= state.envelopes.length ||
          (change.currentUserSourceIndex !== undefined && index >= change.currentUserSourceIndex)
        ) {
          throw new TypeError('Canonical checkpoint compaction kept-tail source lineage is invalid.');
        }
        previous = index;
      });
      indexes.forEach((index, offset) => {
        const source = state.envelopes[index];
        if (!source) {
          throw new TypeError('Canonical checkpoint compaction source identity is missing.');
        }
        const normalized = normalizeHistoryMessage(messages[offset + 1]);
        if (!sameJson(source.message, normalized)) {
          throw new TypeError(
            `Canonical checkpoint compaction kept tail diverges from its source: ${source.message_id}`,
          );
        }
      });
      coveredEnvelopeCount = indexes[0]!;
    } else if (change.currentUserSourceIndex !== undefined) {
      // The В1-shaped plan: [summary, hidden marker, the exact current user].
      // The marker is inserted after the summary; the user's own envelope
      // stays in the log as the first kept envelope — never re-written.
      const sourceIndex = change.currentUserSourceIndex;
      if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= state.envelopes.length) {
        throw new TypeError('Canonical current-user tail source lineage is invalid.');
      }
      if (messages.length < 2) {
        throw new TypeError('Canonical current-user tail is incomplete.');
      }
      const source = state.envelopes[sourceIndex];
      if (!source || !isUserMessageId(source.message_id) || source.message.role !== 'user') {
        throw new TypeError('Canonical current-user tail source is not an external user.');
      }
      const normalizedMarker = normalizeHistoryMessage(messages[messages.length - 2]);
      const normalizedUser = normalizeHistoryMessage(messages[messages.length - 1]);
      if (
        normalizedUser.role !== 'user' ||
        !sameJson(source.message, normalizedUser)
      ) {
        throw new TypeError(
          `Canonical current-user tail changed external user payload: ${source.message_id}`,
        );
      }
      if (messages.length > 2) {
        inserted.push(
          buildCanonicalEnvelope({
            change,
            message: normalizedMarker,
            turnId: `${change.turnId}:compaction`,
            index: messages.length - 2,
          }),
        );
      }
      coveredEnvelopeCount = sourceIndex;
    } else {
      // The legacy whole-history plan (manual /compact): the summary replaces
      // the ENTIRE history; anything else without lineage is malformed.
      if (messages.length !== 1) {
        throw new TypeError('Canonical checkpoint compaction kept-tail source lineage is incomplete.');
      }
      coveredEnvelopeCount = state.envelopes.length;
    }
    return {
      compactionId,
      summaryText,
      tokensBefore,
      coveredEnvelopeCount,
      inserted: withCheckpointSystemBaseline(change, state.envelopes, coveredEnvelopeCount, inserted),
    };
  }

  /**
   * The compaction id a delivery carries: the top-level field (the unified
   * commit, the manual /compact) or the В1 re-delivery's
   * `metadata.replacementId` — the commit pipeline routes the barrier's
   * `replaceMessages` decision through the `compact` seam with the lifecycle
   * metadata only.
   */
  function readDeliveryCompactionId(
    change: SessionCanonicalHistoryCompactionChange,
  ): string | undefined {
    if (typeof change.compactionId === 'string' && change.compactionId.trim()) {
      return safeCompactionId(change.compactionId);
    }
    const metadata = change.metadata;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const replacementId = Reflect.get(metadata as object, 'replacementId');
      if (typeof replacementId === 'string' && replacementId.trim()) {
        return safeCompactionId(replacementId);
      }
    }
    return undefined;
  }

  /**
   * Bit-identical prefix check (envelope by envelope, content included): the
   * В1 barrier's delivery of an already-committed checkpoint. The compare is
   * full-JSON so an identity-preserving CONTENT rewrite is never mistaken for
   * a no-op.
   */
  function isPrefixParity(
    replacement: readonly CanonicalHistoryEnvelope[],
    active: readonly CanonicalHistoryEnvelope[],
  ): boolean {
    if (replacement.length > active.length) return false;
    for (let index = 0; index < replacement.length; index += 1) {
      if (!sameJson(replacement[index], active[index])) return false;
    }
    return true;
  }

  // -- durable log -----------------------------------------------------------

  /**
   * Persists a full state as the session's new durable base (integration plan
   * R5). Wave 1 scope (canon §2.1): ONLY `seed` and `adopt` write full states
   * — every compression and lifecycle operation is an appended event. Small
   * states keep the exact legacy v1 single-entry path; a state whose
   * serialized entries exceed the chunk budget — or a resume of an
   * interrupted chunked import — is written through the versioned
   * begin/chunk/commit protocol: sequential chunk entries of at most ~6 MiB,
   * each flushed to durability before the next, resumable from the confirmed
   * chunk cursor without duplicating a committed chunk. Every entry written
   * is applied to the session's fold (the live path IS the fold).
   */
  async function enqueueFullState(
    state: SessionState,
    sessionId: string,
    envelopes: readonly CanonicalHistoryEnvelope[],
    reason: FullStateReason,
  ): Promise<void> {
    const revision = canonicalActiveHistoryRevision(envelopes);
    const importId = deriveSeedImportId({
      sessionId,
      reason,
      sourceFingerprint: revision,
      mappingVersion: SEED_MAPPING_VERSION,
    });
    const lastImport = await scanSessionSeedImport(sessionId);
    if (lastImport?.commit && lastImport.importId === importId) {
      // The identical import already published its base: a replayed full-state
      // write is a no-op, never a duplicate. The fold rebuilds from the log
      // (checkpoint bypassed) so the live state matches the committed base
      // exactly — the base's segment seq must be the REAL log position.
      storageLog.debug('seed already committed', { sessionId, importId });
      const rebuilt = await loadSessionFold(sessionId, { ignoreCheckpoint: true });
      if (rebuilt) {
        state.fold = rebuilt;
        syncFoldToState(state);
      }
      return;
    }
    if (lastImport && !lastImport.commit && lastImport.importId !== importId) {
      throw new SeedImportConflictError(
        `Durable history of ${sessionId} holds an unfinished seed import (${lastImport.importId}) while a different one (${importId}) was attempted; finish or discard the open import first`,
        sessionId,
        lastImport.importId,
        importId,
      );
    }
    // Resume only an UNFINISHED import of the SAME id; a committed import from
    // an earlier state is published history — a new full-state write always
    // starts its own import.
    const open = lastImport && !lastImport.commit ? lastImport : undefined;
    // The chunker is the size authority: it measures every envelope exactly as
    // admission will (entryDraftSizeBytes over the full draft).
    const chunker = new SeedChunker({ sessionId, importId });
    const plans: SeedChunkPlan[] = [];
    for (const envelope of envelopes) {
      const closed = chunker.add(envelope);
      if (closed) plans.push(closed);
    }
    const tail = chunker.finish();
    if (tail) plans.push(tail);
    // A single chunk with no prior import is exactly the legacy v1 full entry
    // (byte-compatible log format for every history that fits the budget);
    // an open import always finishes through its own protocol.
    // A plan at/above the hard admission cap never takes the legacy path —
    // including the single-oversize-record state, where the chunker holds the
    // one envelope as its own chunk: the chunked protocol writes the durable
    // begin first and then fails controlled with SeedRecordTooLargeError
    // (nothing partial published), while the legacy entry would only die in
    // admission (EntryExceedsBatchCapError) with an empty log.
    const overHardCap = plans.some((plan) => plan.entryBytes >= SEED_CHUNK_HARD_CAP_BYTES);
    if (plans.length <= 1 && !open && !overHardCap) {
      await enqueueLegacyFullState(state, sessionId, envelopes, reason, revision);
      return;
    }
    await writeSeedProtocol(state, sessionId, envelopes, reason, revision, importId, plans, open);
  }


  /** The legacy v1 single-entry full state, byte-for-byte as before R5. */
  async function enqueueLegacyFullState(
    state: SessionState,
    sessionId: string,
    envelopes: readonly CanonicalHistoryEnvelope[],
    reason: FullStateReason,
    revision: string,
  ): Promise<void> {
    const entryId =
      reason === 'delete'
        ? fullEntryId(sessionId, reason, `${nowMs()}`)
        : fullEntryId(sessionId, reason, revision);
    const payload: FullPayload = { sessionId, reason, envelopes };
    await writeSessionEntry(state, sessionId, {
      id: entryId,
      kind: FULL_KIND,
      payload,
    });
  }

  /**
   * Writes the versioned chunked seed: begin (unless resuming), sequential
   * chunks with a durability flush and a confirmed cursor after each one, then
   * the verifying commit that publishes the base. Resume replays the
   * deterministic chunk plan against the durable chunks — digests must match,
   * committed chunks are skipped (never re-sent, so the backend's entry-id
   * uniqueness can never see a duplicate).
   */
  async function writeSeedProtocol(
    state: SessionState,
    sessionId: string,
    envelopes: readonly CanonicalHistoryEnvelope[],
    reason: FullStateReason,
    revision: string,
    importId: string,
    plans: readonly SeedChunkPlan[],
    open: SeedImportScan | undefined,
  ): Promise<void> {
    const confirmed = open?.chunks ?? [];
    for (let index = 0; index < confirmed.length; index += 1) {
      const plan = plans[index];
      const durable = confirmed[index]!;
      if (!plan || plan.digest !== durable.digest) {
        throw new Error(
          `Durable history seed import ${importId} of ${sessionId} drifted: confirmed chunk ${String(index + 1)} does not match the recomputed plan`,
        );
      }
    }
    if (!open) {
      const beginPayload: SeedBeginPayload = {
        sessionId,
        importId,
        sourceFingerprint: revision,
        mappingVersion: SEED_MAPPING_VERSION,
        expectedCount: envelopes.length,
        reason,
      };
      const entryId = seedBeginEntryId(sessionId, importId);
      await writeSessionEntry(state, sessionId, {
        id: entryId,
        kind: SEED_BEGIN_KIND,
        payload: beginPayload,
      });
      await flushDurability();
      storageLog.info('seed begin', {
        sessionId,
        importId,
        reason,
        expectedCount: beginPayload.expectedCount,
      });
    }
    let writtenBytes = 0;
    let writtenEntries = 0;
    for (const plan of plans) {
      if (plan.chunkNo <= confirmed.length) continue; // durable: resume skips
      const payload: SeedChunkPayload = {
        sessionId,
        importId,
        chunkNo: plan.chunkNo,
        sourceCursor: plan.sourceCursor,
        count: plan.count,
        digest: plan.digest,
        envelopes: plan.envelopes,
      };
      const entryId = seedChunkEntryId(sessionId, importId, plan.chunkNo, plan.digest);
      const bytes = seedEntrySizeBytes(
        entryId,
        SEED_CHUNK_KIND,
        payload,
        lastEntryIds.get(sessionId) ?? null,
      );
      if (bytes >= SEED_CHUNK_HARD_CAP_BYTES) {
        throw new SeedRecordTooLargeError(
          `Durable history seed record of ${sessionId} serializes to ${String(bytes)} bytes and reaches the admission cap ${String(SEED_CHUNK_HARD_CAP_BYTES)}; the import stops controlled with flushed chunks durable (resume finds them), nothing partial is published`,
          sessionId,
          importId,
          bytes,
          SEED_CHUNK_HARD_CAP_BYTES,
        );
      }
      await writeSessionEntry(state, sessionId, {
        id: entryId,
        kind: SEED_CHUNK_KIND,
        payload,
      });
      // One chunk in flight: the durability barrier (and the confirmed cursor)
      // comes before the next chunk is queued (test architecture §10.2).
      await flushDurability();
      writtenBytes += bytes;
      writtenEntries += plan.count;
      storageLog.info('seed chunk', {
        sessionId,
        importId,
        chunkNo: plan.chunkNo,
        chunks: plans.length,
        bytes,
        entries: plan.count,
        cursor: plan.sourceCursor,
      });
    }
    const commitPayload: SeedCommitPayload = {
      sessionId,
      importId,
      chunkCount: plans.length,
      count: plans.reduce((sum, plan) => sum + plan.count, 0),
      activeRevision: revision,
      rootDigest: seedRootDigest(plans.map((plan) => plan.digest)),
      casManifestDigest: null,
    };
    const commitId = seedCommitEntryId(sessionId, importId);
    await writeSessionEntry(state, sessionId, {
      id: commitId,
      kind: SEED_COMMIT_KIND,
      payload: commitPayload,
    });
    // The commit publishes the base: the fold takes the verified envelopes as
    // its origin segment at the commit's own logical seq.
    applyFoldBase(state.fold, envelopes, state.fold.headSeq);
    syncFoldToState(state);
    await flushDurability();
    storageLog.info('seed commit', {
      sessionId,
      importId,
      chunks: plans.length,
      entries: commitPayload.count,
      bytes: writtenBytes,
      revision,
    });
  }

  /**
   * Finishes an UNFINISHED seed import whose durable chunks carry exactly the
   * published history: writes the verifying commit (the runtime computes the
   * revision) and returns the records as the session base — the typical end
   * state of a history-import CLI run that crashed after its last chunk but
   * before the commit. When the durable chunks do NOT yet cover the published
   * history, the import stays open and `undefined` is returned: the seed path
   * below re-derives the import id and either resumes it (same id — the
   * missing chunks are written and digested) or conflicts explicitly against
   * the foreign id. Divergence never forks silently either way.
   */
  async function completeVerifiedSeedImport(
    state: SessionState,
    sessionId: string,
    published: readonly CanonicalHistoryEnvelope[],
  ): Promise<readonly CanonicalHistoryEnvelope[] | undefined> {
    const open = await scanSessionSeedImport(sessionId);
    if (!open || open.commit) return undefined;
    const stitched = stitchSeedImport(open);
    if (!sameSerializedRecords(stitched, published)) {
      storageLog.debug('seed import incomplete; falling through to the seed writer', {
        sessionId,
        importId: open.importId,
        durableRecords: stitched.length,
        publishedRecords: published.length,
      });
      return undefined;
    }
    const records = stitched.map((record) => decodeCanonicalHistoryEnvelope(record));
    const commitPayload: SeedCommitPayload = {
      sessionId,
      importId: open.importId,
      chunkCount: open.chunks.length,
      count: records.length,
      activeRevision: canonicalActiveHistoryRevision(records),
      rootDigest: seedRootDigest(open.chunks.map((chunk) => chunk.digest)),
      casManifestDigest: null,
    };
    const entryId = seedCommitEntryId(sessionId, open.importId);
    await writeSessionEntry(state, sessionId, {
      id: entryId,
      kind: SEED_COMMIT_KIND,
      payload: commitPayload,
    });
    applyFoldBase(state.fold, records, state.fold.headSeq);
    syncFoldToState(state);
    await flushDurability();
    storageLog.info('seed commit', {
      sessionId,
      importId: open.importId,
      chunks: open.chunks.length,
      entries: records.length,
      revision: commitPayload.activeRevision,
      completedBy: 'provider',
    });
    return records;
  }

  /** The last seed import of one session in log order, if any. */
  /**
   * The last seed import of one session, scanned in THE SESSION'S OWN FILE
   * (the write target of every seed write in the per-session model):
   * - resuming an interrupted import is only ever possible against the file
   *   the interrupted import was writing into;
   * - an open import left in the LEGACY monolith is abandoned history —
   *   resuming it into the session file would write chunks/commit without
   *   their begin (a protocol violation on the next replay), and a committed
   *   monolith import is irrelevant too: the migration seeds the file with a
   *   fresh full base instead.
   */
  async function scanSessionSeedImport(sessionId: string): Promise<SeedImportScan | undefined> {
    if (!options.storage.hasSessionFile(sessionId)) return undefined;
    const entries = await durableEntries(sessionId);
    const scan = createSeedScan();
    for (const entry of entries) {
      if (!isSeedKind(entry.kind)) continue;
      if (sessionIdOf(entry.payload) !== sessionId) continue;
      scan.onEntry({ id: entry.id, kind: entry.kind, payload: entry.payload });
    }
    return scan.scan.last;
  }

  async function flushDurability(): Promise<void> {
    // Mutations return only after their entries are durable — the contract
    // the JSONL provider's synchronous write gave callers.
    await options.storage.worker.flush();
  }

  /**
   * The raw-payload signature of the pre-fix poison: a compaction.replace
   * whose `endSeq` is BELOW its `startSeq` (incident 2026-11-07, mvs_70b7f22).
   * Returns the range facts for diagnostics, or `undefined` when the entry is
   * not an inverted replace (including a malformed payload — that stays the
   * fail-closed codec's business).
   */
  function invertedReplaceSeqRange(
    entry: { readonly kind: string; readonly payload: unknown },
  ): { readonly compactionId: string; readonly startSeq: number; readonly endSeq: number } | undefined {
    if (entry.kind !== EVENT_COMPACTION_REPLACE) return undefined;
    if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) {
      return undefined;
    }
    const record = entry.payload as Record<string, unknown>;
    const startSeq = record['startSeq'];
    const endSeq = record['endSeq'];
    const compactionId = record['compactionId'];
    if (
      typeof startSeq !== 'number' ||
      typeof endSeq !== 'number' ||
      typeof compactionId !== 'string' ||
      endSeq >= startSeq
    ) {
      return undefined;
    }
    return { compactionId, startSeq, endSeq };
  }

  /**
   * Folds a session's durable entries into the session fold; `undefined` when
   * the log has none for the session. Canon 1.3: the fold resumes from the
   * DISPOSABLE checkpoint (a file next to the log) when it matches this log
   * generation — the scan then reads only the delta after the checkpointed
   * backend position, never the whole log. Deleting the checkpoint changes
   * nothing: the fold recomputes from the log and rewrites the cache. The
   * entry-kind switch is exhaustive (test architecture §10.2) — v1
   * full/append, the three v2 seed kinds through the shared protocol scanner,
   * the wave-1 event kinds through the fold module, and anything else fails
   * loudly. Only a committed, revision-verified seed publishes its base; an
   * unfinished import is ignored and the previous base stays. Every session
   * entry extends `lastEntryIds`, so a restart chains the next write onto the
   * log's tail.
   */
  async function loadSessionFold(
    sessionId: string,
    foldOptions?: { readonly ignoreCheckpoint?: boolean },
    preResolvedBackend?: NonNullable<Awaited<ReturnType<DurableHistoryStores['backendForRead']>>>,
  ): Promise<SessionFold | undefined> {
    // Per-session files: the scan reads the session's OWN log when it has
    // one, otherwise the legacy monolith (read-only). Neither exists — a
    // fresh session — and the fold is empty without any probe. A caller
    // that resolved the backend BEFORE claiming the session's own file
    // (ensureState's legacy ordering) passes it in.
    const backend = preResolvedBackend ?? (await options.storage.backendForRead(sessionId));
    if (!backend) return undefined;
    let fold: SessionFold | undefined;
    let scanned = 0;
    let scanFrom = 0;
    if (!foldOptions?.ignoreCheckpoint) {
      const checkpoint = await readFoldCheckpoint(sessionId);
      // Carrier check (per-session model): a checkpoint is valid only for the
      // log it was read against. Pre-per-session checkpoints carry no
      // directory — they can only ever match the legacy monolith; a session
      // FILE with the same generation must never resume from their position
      // (their backendSeq is a monolith position — resuming from it would
      // silently hide the file's own records).
      const checkpointCarrier = checkpoint?.backendDirectory ?? options.storage.directory;
      if (
        checkpoint &&
        checkpointCarrier === backend.directory &&
        checkpoint.backendGeneration === backend.generation
      ) {
        fold = foldFromCheckpoint(checkpoint);
        scanFrom = checkpoint.backendSeq;
        if (checkpoint.fold.lastEntryId) {
          lastEntryIds.set(sessionId, checkpoint.fold.lastEntryId);
        }
      }
    }
    // Negative probe before the full-log scan (incident 2026-11-15: a brand
    // new session's cold open paid a whole-log walk — seconds on GB-scale
    // stores — to learn it had no entries). Entry ids are
    // `<sessionId>|<kind>|…` (PRIMARY KEY range probe, no batch decoding), so
    // an empty id range proves the scan would consume nothing: skip it. The
    // `~`-suffix upper bound covers every kind character below U+FFFE.
    if (!fold && !backend.hasEntriesInRange(`${sessionId}|`, `${sessionId}|\u{10FFFF}`)) {
      return undefined;
    }
    const seedScan = createSeedScan();
    await scanSessionEntries(sessionId, scanFrom, backend, (entry) => {
      scanned += 1;
      if (!fold) fold = createEmptyFold();
      if (isSeedKind(entry.kind)) {
        seedScan.onEntry({ id: entry.id, kind: entry.kind, payload: entry.payload });
        // Seq bookkeeping for every seed entry (the fold's switch treats the
        // protocol kinds as opaque positions).
        applyFoldEntry(fold, entry, fold.headSeq + 1);
        if (entry.kind === SEED_COMMIT_KIND) {
          const last = seedScan.scan.last;
          if (!last?.commit) {
            throw new Error(`Durable history seed commit lost its import scan: ${sessionId}`);
          }
          applyFoldBase(fold, publishVerifiedSeedCommit(sessionId, last), fold.headSeq);
        }
        return;
      }
      // The poison of the pre-fix write path (incident 2026-11-07,
      // mvs_70b7f22): a compaction.replace whose seq range is already
      // inverted sits in a live log. The write path now refuses such a range
      // BEFORE the first protocol event, but the one recorded record must not
      // make the whole session unreadable: the replay skips the event (the
      // fold keeps the pre-replace state, the attempt's own end{failed}
      // closes it) and says so loudly. The WRITE path stays fail-closed —
      // this guard lives only on the replay.
      const inverted = invertedReplaceSeqRange(entry);
      if (inverted !== undefined) {
        log.warn('skipping an inverted compaction.replace in the durable log (pre-fix poison; the fold keeps the pre-replace state)', {
          event: 'history.v2.compaction.replace.skipped_inverted_range',
          session_id: sessionId,
          entry_id: entry.id,
          entry_seq: fold.headSeq + 1,
          compaction_id: inverted.compactionId,
          start_seq: inverted.startSeq,
          end_seq: inverted.endSeq,
        });
        return;
      }
      applyFoldEntry(fold, entry, fold.headSeq + 1);
    });
    if (!fold || (fold.segments.length === 0 && !fold.deleted)) {
      // No session base in the log (an interrupted seed import holds only
      // protocol entries): the caller seeds from the published files.
      return undefined;
    }
    if (scanned > 0) await writeFoldCheckpoint(sessionId, fold, backend);
    return fold;
  }

  /**
   * Walks the session's durable log (its own file, or the legacy monolith
   * before it has one) from `fromBackendSeq` (a backend commit position —
   * `0` reads from the start) and consumes every entry belonging to the
   * session, in log order. The per-session logical seq is the RUNNING COUNT
   * of the session's entries — the fold assigns it, the live writer counts
   * its own writes the same way, so both agree by construction.
   */
  async function scanSessionEntries(
    sessionId: string,
    fromBackendSeq: number,
    backend: NonNullable<Awaited<ReturnType<DurableHistoryStores['backendForRead']>>>,
    consume: (entry: { readonly id: string; readonly kind: string; readonly payload: unknown }) => void,
  ): Promise<void> {
    let cursor = fromBackendSeq;
    for (;;) {
      const window = backend.readDeltaChecked(cursor, READ_DELTA_WINDOW_BYTES);
      for (const stored of window.entries) {
        if (sessionIdOf(stored.payload) !== sessionId) continue;
        consume({
          id: stored.id,
          kind: stored.kind,
          payload: stored.payload as unknown,
        });
      }
      if (window.tornTail !== null) {
        throw new Error(
          `Durable history log has a torn tail at batch ${window.tornTail.batchId} (${window.tornTail.reason})`,
        );
      }
      if (window.nextAfterSeq === null) break;
      cursor = window.nextAfterSeq;
    }
  }

  // -- fold checkpoint (canon 1.3: disposable cold-start cache) ---------------

  function foldCheckpointPath(sessionId: string): string {
    return join(
      options.storage.directory,
      'fold-cache',
      `${safeHistoryPathSegment(sessionId)}.json`,
    );
  }

  async function readFoldCheckpoint(sessionId: string): Promise<FoldCheckpoint | undefined> {
    let raw: string;
    try {
      raw = await readFile(foldCheckpointPath(sessionId), 'utf8');
    } catch {
      return undefined;
    }
    return parseFoldCheckpoint(sessionId, raw);
  }

  /**
   * Writes the disposable fold checkpoint against the backend the fold was
   * read from (the session's own file, or the legacy monolith before the
   * session has one). Best-effort: a failed write is a warn — the next cold
   * open falls back to the full log scan and the fold result is identical
   * either way.
   */
  async function writeFoldCheckpoint(
    sessionId: string,
    fold: SessionFold,
    backend: NonNullable<Awaited<ReturnType<DurableHistoryStores['backendForRead']>>>,
  ): Promise<void> {
    try {
      await mkdir(join(options.storage.directory, 'fold-cache'), { recursive: true });
      await replaceFileAtomically(
        foldCheckpointPath(sessionId),
        serializeFoldCheckpoint(sessionId, fold, backend.head, backend.generation, backend.directory),
      );
    } catch (error) {
      log.warn('fold checkpoint write failed (the cache is disposable)', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Publishes a committed seed as the rebuilt base: the chunk records are
   * re-decoded through the canonical decoder (the single validation authority
   * — a CLI-written import is validated here, at load), and the commit's
   * revision must match the records exactly. Anything else is a corrupt log,
   * not a partially trusted base.
   */
  function publishVerifiedSeedCommit(
    sessionId: string,
    scan: SeedImportScan,
  ): readonly CanonicalHistoryEnvelope[] {
    const commit = scan.commit;
    if (!commit) throw new Error(`Durable history seed import has no commit: ${scan.importId}`);
    const records = stitchSeedImport(scan).map((record) => decodeCanonicalHistoryEnvelope(record));
    const revision = canonicalActiveHistoryRevision(records);
    if (commit.activeRevision !== revision) {
      throw new Error(
        `Durable history seed commit revision mismatch for ${sessionId}: commit recorded ${commit.activeRevision}, records compute ${revision}`,
      );
    }
    return records;
  }

  /**
   * Decoded entries of ONE session's log (its own file, or the legacy
   * monolith before it has one); empty when the session has no log at all.
   * The cache is per session and keyed by that backend's head.
   */
  async function durableEntries(sessionId: string): Promise<readonly DurableLogEntry[]> {
    const backend = await options.storage.backendForRead(sessionId);
    if (!backend) return [];
    const cached = logCaches.get(sessionId);
    const head = backend.head;
    // The cache is keyed by the CARRIER too: the legacy monolith and the
    // session's own file are different logs — a coinciding head must never
    // serve legacy entries for the file (or vice versa).
    if (cached && cached.directory === backend.directory && cached.head === head) {
      return cached.entries;
    }
    const inherits = cached !== undefined && cached.directory === backend.directory && cached.head <= head;
    const fresh: DurableLogEntry[] = [];
    let cursor = inherits ? cached.head : 0;
    for (;;) {
      const window = backend.readDeltaChecked(cursor, READ_DELTA_WINDOW_BYTES);
      for (const stored of window.entries) {
        fresh.push({
          id: stored.id,
          seq: stored.seq,
          kind: stored.kind,
          payload: stored.payload as unknown as DurableLogEntry['payload'],
        });
      }
      if (window.tornTail !== null) {
        throw new Error(
          `Durable history log has a torn tail at batch ${window.tornTail.batchId} (${window.tornTail.reason})`,
        );
      }
      if (window.nextAfterSeq === null) break;
      cursor = window.nextAfterSeq;
    }
    const entries = [...(inherits ? cached.entries : []), ...fresh];
    logCaches.set(sessionId, { directory: backend.directory, head, entries });
    return entries;
  }

  async function sessionHasDurableEntries(sessionId: string): Promise<boolean> {
    const entries = await durableEntries(sessionId);
    return entries.some((entry) => sessionIdOf(entry.payload) === sessionId);
  }
}

/**
 * Wraps the file-backed `SessionHistoryMutationCapability` so every committed
 * full-rewrite (settle/retract/fork/rewind, including resumed stagings) is
 * mirrored into the durable log. Reads stay file-backed (they observe the
 * published truth); only the mirror is added. Durable mode only — the JSONL
 * mode keeps the unwrapped adapter.
 */
export function wrapSessionHistoryMutationForDurable(
  mutation: SessionHistoryMutationCapability,
  durable: DurableSessionSystemCanonicalHistoryProvider,
): SessionHistoryMutationCapability {
  const settleTurnTail = mutation.settleTurnTail?.bind(mutation);
  const closeReleasedToolRound = mutation.closeReleasedToolRound?.bind(mutation);
  const retractTurn = mutation.retractTurn?.bind(mutation);
  const readForUserMessage = mutation.readForUserMessage?.bind(mutation);
  const resumeRewind = mutation.resumeRewind?.bind(mutation);
  // R1 guard (W0 F5): in durable mode the file can lag the log, so a mutation
  // planned on `messages.jsonl` would build its result on a stale baseline
  // and the adopt that mirrors it back would drop the durable-only tail.
  // W1: with the continuous publisher injected, this is a cheap catch-up
  // flush (I-PUB-1) — the steady state is already fresh within the
  // publication lag. Without one, the coarse pre-mutation publish stays the
  // fail-closed backstop.
  const publishBefore = (sessionId: string) => {
    const attempt = durable.publisher
      ? durable.publisher.flushBeforeMutation(sessionId)
      : durable.publishDurableStateToFiles(sessionId);
    return attempt.catch((error: unknown) => {
      // Fail-closed (review round 2): the freshBaseline adopt below does NOT
      // run the staleness guard, so a failed pre-mutation publish would let
      // the mutation plan on a stale file and the adopt would mirror that
      // stale file into the durable log SILENTLY — losing the durable-only
      // tail. Promote the failure: the mutation must not run on an
      // unverifiable baseline.
      throw new Error(
        `pre-mutation durable publish failed for ${sessionId}; refusing to plan the file mutation on an unverifiable baseline: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    });
  };
  return {
    // Fork/rewind boundary probes are mutation planning too. With continuous
    // publication disabled, a plain file read would see an empty/stale view.
    read: async (sessionId) => {
      await publishBefore(sessionId);
      return mutation.read(sessionId);
    },
    ...(settleTurnTail
      ? {
          settleTurnTail: async (input) => {
            await publishBefore(input.sessionId);
            const committed = await settleTurnTail(input);
            await durable.adoptFromFiles(input.sessionId, { freshBaseline: true });
            return committed;
          },
        }
      : {}),
    // Recovery join of a released native task wait (§1.8, wave 3): same
    // fail-closed publish → mutate → adopt mirror as the abort reconcile.
    ...(closeReleasedToolRound
      ? {
          closeReleasedToolRound: async (input: Parameters<typeof closeReleasedToolRound>[0]) => {
            await publishBefore(input.sessionId);
            const committed = await closeReleasedToolRound(input);
            await durable.adoptFromFiles(input.sessionId, { freshBaseline: true });
            return committed;
          },
        }
      : {}),
    ...(retractTurn
      ? {
          retractTurn: async (input) => {
            await publishBefore(input.sessionId);
            const committed = await retractTurn(input);
            await durable.adoptFromFiles(input.sessionId, { freshBaseline: true });
            return committed;
          },
        }
      : {}),
    ...(readForUserMessage
      ? {
          readForUserMessage: async (input) => {
            await publishBefore(input.sessionId);
            return readForUserMessage(input);
          },
        }
      : {}),
    stageFork: async (input) => {
      const staged = await mutation.stageFork(input);
      return {
        publish: async () => {
          await publishBefore(input.targetSessionId);
          await staged.publish();
          await durable.adoptFromFiles(input.targetSessionId, { freshBaseline: true });
        },
      };
    },
    stageRewind: async (input) => {
      const staged = await mutation.stageRewind(input);
      return withPublishMirror(staged, input.sessionId, durable);
    },
    ...(resumeRewind
      ? {
          resumeRewind: async (input) => {
            const resumed = await resumeRewind(input);
            if (!resumed) return undefined;
            return withPublishMirror(resumed, input.sessionId, durable);
          },
        }
      : {}),
  };
}

/** Runs the staged publication, then mirrors the published state into the durable log. */
function withPublishMirror(
  staged: StagedSessionHistoryRewind,
  sessionId: string,
  durable: DurableSessionSystemCanonicalHistoryProvider,
): StagedSessionHistoryRewind {
  return {
    ...staged,
    publish: async (publishOptions?: { readonly allowRevisionChange?: true }) => {
      // R1 guard: refresh `messages.jsonl` from durable before the staged
      // rewind publishes its planned replacement on top of it. W1: a cheap
      // catch-up flush when the continuous publisher is injected; the coarse
      // publish stays the backstop. Fail-closed (review round 3): the
      // freshBaseline adopt below bypasses the staleness guard, so a failed
      // pre-mutation publish must PROMOTE — planning a rewind on an
      // unverifiable baseline would mirror the stale file into the durable
      // log and silently drop the durable-only tail.
      try {
        if (durable.publisher) await durable.publisher.flushBeforeMutation(sessionId);
        else await durable.publishDurableStateToFiles(sessionId);
      } catch (error) {
        throw new Error(
          `pre-mutation durable publish failed for ${sessionId}; refusing to plan the rewind on an unverifiable baseline: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      await staged.publish(publishOptions);
      await durable.adoptFromFiles(sessionId, { freshBaseline: true });
    },
  };
}

// -- pure helpers ------------------------------------------------------------

/**
 * Detects an unfinished trailing tool round without walking the whole
 * sequence: the decision only needs the tail round; the authoritative repair
 * still runs through `repairCanonicalHistory`.
 */
function hasPendingToolTail(envelopes: readonly CanonicalHistoryEnvelope[]): boolean {
  const resultIds = new Set<string>();
  let index = envelopes.length;
  while (index > 0) {
    const message = envelopes[index - 1]?.message;
    if (!message || typeof message !== 'object') return false;
    if (Reflect.get(message, 'role') === 'toolResult') {
      const toolCallId = Reflect.get(message, 'toolCallId');
      if (typeof toolCallId === 'string') resultIds.add(toolCallId);
      index -= 1;
      continue;
    }
    if (Reflect.get(message, 'role') === 'assistant') {
      return toolCallIds(Reflect.get(message, 'content')).some((id) => !resultIds.has(id));
    }
    return false;
  }
  return false;
}

function toolCallIds(content: unknown): readonly string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      Reflect.get(block, 'type') === 'toolCall' &&
      typeof Reflect.get(block, 'id') === 'string'
    ) {
      ids.push(Reflect.get(block, 'id') as string);
    }
  }
  return ids;
}

/** Whether the appended delta carries any record that is not a tool result. */
function deltaCarriesNonToolResult(appended: readonly CanonicalHistoryEnvelope[]): boolean {
  return appended.some(({ message }) => message.role !== 'toolResult');
}

/** Content-addressed delta entry id: a replayed commit resolves to a replay, not a duplicate. */
function appendEntryId(
  change: SessionCanonicalHistoryChange,
  appended: readonly CanonicalHistoryEnvelope[],
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(appended.map(({ message_id }) => message_id)))
    .digest('base64url')
    .slice(0, 12);
  return `${change.sessionId}|${change.operation.id}|${fingerprint}`;
}

/** Entry id of a foreign jsonl append imported into the durable log (§3.4 row 2). */
function foreignAppendEntryId(
  sessionId: string,
  appended: readonly CanonicalHistoryEnvelope[],
  ts: number,
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(appended.map(({ message_id }) => message_id)))
    .digest('base64url')
    .slice(0, 12);
  return `${sessionId}|external-jsonl|${String(ts)}|${fingerprint}`;
}

/** Session id carried by any durable-history payload (writer or protocol). */
function sessionIdOf(payload: unknown): unknown {
  return (payload as { sessionId?: unknown }).sessionId;
}

/**
 * Record-by-record serialized equality (R5 completion check): both sides are
 * canonically decoded, so equal records serialize identically — key order is
 * fixed by the decoder, and the durable chunk round-trip preserves it.
 */
function sameSerializedRecords(
  left: readonly SeedEnvelope[],
  right: readonly CanonicalHistoryEnvelope[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return false;
  }
  return true;
}

function fullEntryId(sessionId: string, reason: string, revision: string): string {
  return `${sessionId}|full|${reason}|${revision}`;
}

/**
 * Entry id of one compaction-protocol event: unique per compaction id and
 * phase, so a replayed commit resolves to a replay, never a duplicate.
 */
function compactionEventEntryId(
  sessionId: string,
  compactionId: string,
  phase: string,
): string {
  return `${sessionId}|compaction|${compactionId}|${phase}`;
}

/** Entry id of a delete tombstone (one per delete; the timestamp orders retries). */
function tombstoneEntryId(sessionId: string, deletedAtMs: number): string {
  return `${sessionId}|tombstone|${String(deletedAtMs)}`;
}

/**
 * Entry id of a wave-2 offload event (canon §2.1 `offload{seq, blockIdx →
 * artifactRef}`): the addressed position plus the artifact reference name it,
 * so a replayed commit resolves to a replay, never a duplicate.
 */
function offloadEventEntryId(sessionId: string, payload: OffloadEvent): string {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        seq: payload.seq,
        blockIdx: payload.blockIdx,
        contentBlockIdx: payload.contentBlockIdx ?? null,
        artifactRef: payload.artifactRef,
        replacement: payload.replacement ?? null,
      }),
    )
    .digest('base64url')
    .slice(0, 12);
  return `${sessionId}|offload|${String(payload.seq)}|${String(payload.blockIdx)}|${fingerprint}`;
}

/** Content-addressed entry id of a whole-history replace event. */
function replaceAllEntryId(
  sessionId: string,
  generation: number,
  envelopes: readonly CanonicalHistoryEnvelope[],
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(envelopes.map(({ message_id }) => message_id)))
    .digest('base64url')
    .slice(0, 12);
  return `${sessionId}|replace|${String(generation)}|${fingerprint}`;
}

/** Content-addressed entry id of a repair event (the delta names it). */
function repairEventEntryId(sessionId: string, payload: RepairEvent): string {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        truncateTo: payload.truncateTo ?? null,
        ids: payload.appended.map(({ message_id }) => message_id),
      }),
    )
    .digest('base64url')
    .slice(0, 12);
  return `${sessionId}|repair|${payload.generation}|${fingerprint}`;
}

/** Whole-envelope serialized equality (content included, ids alone are not enough). */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function detached<T>(value: T): T {
  return structuredClone(value);
}
