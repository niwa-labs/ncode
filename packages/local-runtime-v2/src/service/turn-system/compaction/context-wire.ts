// Context wire pipeline — the Ф2 context path composed for the runtime.
//
// Wave-2 review finding: none of the five context packages was imported by
// the runtime, so the Ф2 budgets (prep ≤50 мс, payload ≤32 МБ, открытие ≤1 с)
// were unmeasurable "on the real path". This module is the runtime seam: it
// wires the three packages of the request path together ONCE —
//
//   durable commits → ProjectionService (window manifest, incremental fold)
//                   → convert-to-llm (per-entry stage, convertEntry)
//                   → wire-compiler  (cached Buffer segments, byte guard)
//
// with the Ф2 R2 overlay beside it: an optional Context-MMU residency
// (`ContextWireOptions.residency`) decides which window entries' images ride
// the payload with their real bytes; everything else keeps the dialect
// placeholder. Without the overlay the path is the all-evicted baseline the
// equivalence gates pin.
//
// — and exposes the two operations the turn loop needs: `applyCommit` per
// durable commit (O(entries of the commit)) and `prepare()` per provider
// request. `prepare()` is warm-path O(delta) at the conversion stage: the
// per-entry stage is MEMOIZED by the convert-to-llm record key
// `(entryId, dialect, normalizerVersion)` — including the residency
// `#resident@<sha16>` cache state — so only new or residency-flipped entries
// re-convert (final-architecture.md:74/:90); segment bytes and hashing were
// already cached below it (wire-compiler LRU). The byte guard (`maxBytes`)
// runs inside every `prepare`, so a payload breach fails the request
// preparation with `WireBudgetExceeded` before anything is sent (В1: such a
// breach IS a context overflow — the llm-retry recovery compacts once,
// reseeds the pipeline and retries the request exactly once) — and the
// optional `ContextWireOptions.compaction` seam wires the byte-axis trigger
// (a real `BackgroundCompactionScheduler`) so the window compacts UP TO that
// guard (75%/90% of `maxBytes` by default) instead of at it
// (final-architecture.md:397).
//
// Window selection (steering D+C contract, `convert-to-llm/src/audit.ts`):
// the projection manifest never carries `mcode.*` segments, but TWO control
// kinds are model-visible and reach the payload from the retained window
// pages — `mcode.owner-input.placed` (the executed user input; deduplicated
// by `inputEntryId`, first log occurrence wins, so it enters EXACTLY once —
// input-delivery's "the input entered the model context (exactly once)") and
// `mcode.system-reminder` (a reminder TAIL record, positioned strictly after
// the stable prefix). Immediate-send batch members (entries sharing
// `hostMetadata.immediateSendBatchId`) merge into ONE user record at the
// first member's position — the same unit-merge `assemblePayload` applies.
// The compiled body therefore matches `assembleManifestPayload`
// (convert-to-llm) byte for byte on the same window — including the batch
// form — pinned by `context-wire.test.ts`.
//
// RAM: the projection stores handles only, so THIS module owns the window's
// content pages — and prunes them to the manifest segments plus the
// model-visible control pages after every commit (a compaction also cuts the
// control pages that logged before `firstKeptEntryId`). Retention is bounded
// by the WINDOW, never by history length: what a compaction cuts is dropped
// here too.
//
// Ш4: the wave-2 packages are registered as `local-runtime-v2` dependencies
// (integration plan Ш4, "зарегистрировать wave-2 пакеты в dependencies
// local-runtime-v2/package.json"), so the imports below use the workspace
// names instead of the former relative paths. Backend `Entry`/`Commit`/`Seq`
// come in type-only (wave-1 contract).

import type { Commit, Entry, Seq } from '@mavis/durable-backend-sqlite-zstd';
import { createHash } from 'node:crypto';

import { createLogger } from '@mavis/logging';
import {
  ContextWireImageBudgetExceeded,
  type ContextWireProjection,
  type ContextWireRecord,
} from '@mavis/agent-core/pi-turn-runner';
import type { CanonicalHistoryMessage } from '../agent-host/history/contracts.js';
import { resolveHistoryProviderMode } from '../../session-system/messages/history/durable-canonical-history-provider.js';

import {
  ProjectionService,
  buildProjection,
  type CommitWithEntries,
  type ContextManifest,
  type ResumeCapsule,
} from '@mavis/context-projection';
// Wave 2 (canon §2.5, item 2.2): the read-again stub of an evicted offloaded
// image — the SAME rendering the summarizer serialization uses (one format).
import { imageArtifactPlaceholder } from '@mavis/context-compaction';
import {
  createContextPlan,
  compileContextPlan,
  convertBatch,
  convertEntry,
  convertEntryTails,
  compileBatchKey,
  compileKey,
  decodeEntryPayload,
  isVisibleControlKind,
  MINIMAX_M3_DIALECT,
  recordCacheKey,
  type CompiledEntry,
  type ImageRendering,
  type RecordImageBlock,
} from '@mavis/convert-to-llm';
// Context MMU: type-only here (the runtime wires the instance in via
// `ContextWireOptions.residency`) — the MMU instance itself is composed by the
// runtime, not by this module.
import type { ContextMmu, PageHandle } from '@mavis/context-mmu';
// Background compaction (the `pi-durable-background-compaction` slot): the
// double-trigger scheduler the composed pipeline drives from `applyCommit`.
import {
  createBackgroundCompactionScheduler,
  type BackgroundCompactionScheduler,
  type CompactionBudgets,
  type CompactionMeasure,
  type DeterministicSummaryProducer,
  type DurableEntryDraft,
  type LogEntry,
  type SchedulerAttemptSnapshot,
  type SchedulerFailureStatus,
  type Summarizer,
  type TriggerEvaluation,
} from '@mavis/context-compaction';
import {
  WireBudgetExceeded,
  compile,
  compiledEntryToWireEntry,
  compiledRecordDialect,
  createLruSegmentCache,
  segmentCacheKey,
  type CompiledBody,
  type Entry as WireEntry,
  type WireSegmentCache,
} from '@mavis/wire-compiler';
// Wave-0 item 0.5: the current-turn image residency (the composition-owned
// overlay class; type-only here alongside the MMU types).
import type { TurnImageResidency } from './turn-image-residency.js';

/** Default hard cap of the provider payload: the Ф2 "payload ≤32 МБ всегда" gate. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Lifecycle status the residency overlay compiles against (the narrow slice
 * of `ContextMmu['statusOf']` the compile actually reads).
 */
export type ContextWirePageStatus = 'new' | 'resident' | 'digest' | 'stale' | 'released';

/**
 * Context-MMU residency seam (Ф2 R2 overlay): decides which window entries'
 * images ride the payload with their real bytes. Absent, every image converts
 * to its dialect placeholder — the all-evicted baseline the equivalence gates
 * pin.
 *
 * Wave-0 item 0.5: the seam is the NARROW structural contract the compile
 * uses (`statusOf`), not the whole `ContextMmu` — a residency decision layer
 * over the canonical log (the wave-0 current-turn overlay) satisfies it
 * without the CAS machinery, and the full MMU satisfies it structurally. The
 * content-addressed `segments` store of the R2 overlay stays optional and is
 * not composed in wave 0.
 */
export interface ContextWireResidency {
  /** The residency decision owner; `statusOf` decides resident vs digest. */
  readonly mmu: {
    readonly statusOf: (page: PageHandle) => ContextWirePageStatus;
  };
  /**
   * The page handle of `entry`'s image content; `undefined` when the entry
   * carries no MMU-managed image (plain text pages are always resident).
   */
  readonly pageOf: (entry: Entry) => PageHandle | undefined;
  /**
   * Wave 2 (canon 05 §2.5, item 2.2): resolves an OFFLOADED image's bytes
   * back out of the artifact store by its content address — the durable log
   * carries the reference, and a RESIDENT reference renders the real bytes
   * through this seam (an evicted one renders the read-again stub from the
   * decoded reference block itself, no store read). Absent: inline-data
   * rendering only.
   */
  readonly readImage?: (page: {
    readonly sha256: string;
    readonly id?: string;
    readonly mime?: string;
  }) => { readonly data: string; readonly mimeType: string } | undefined;
  /**
   * Content-addressed store of resident-image record segments, keyed by the
   * content-keyed wire identity `<entryId>#resident@<sha16>` — the CAS
   * page's sha256 is IN the key, and pages are immutable, so a hit's bytes
   * are always that page's bytes (no second truth: the store holds derived
   * bytes of frozen inputs only, exactly like the wire compiler's segment
   * cache). Absent (the default), no cross-pipeline reuse happens.
   *
   * Why it exists: a FRESH pipeline (process start, cold open) rebuilds its
   * private segment cache from scratch, and at the architectural residency
   * scale (~10 МБ of resident data URLs, final-architecture.md:310) that
   * rebuild is byte-dominated — serializing + hashing ~10 МБ of data URLs —
   * and blows the Ф2 cold budget (prep ≤50 мс p95 на любой длине истории,
   * final-architecture.md:404). With the store, a resident segment is
   * serialized + hashed once per CONTENT, not once per pipeline; the fresh
   * pipeline seeds its compiler cache from the store and pays conversion +
   * concat only. Same contract as the wire compiler's own cache: derived
   * state, evicting everything is always safe.
   */
  readonly segments?: WireSegmentCache;
}

/**
 * Memo cache of the per-entry conversion stage (Ф2: `pi-convert-to-llm` is
 * "the memoized per-entry stage inside the wire compiler",
 * final-architecture.md:74/:90). `records` maps {@link recordCacheKey} —
 * `(entryId, dialect, normalizerVersion)` extended with the residency
 * `cacheState` (`resident@<sha16>`) when a rendering is active — to the
 * converted record (`null` included: an audit/control page converts to
 * `null`, and memoizing that keeps the miss a one-time cost too). `tails`
 * maps the base key (a `#tails` suffix namespace) to the entry's reminder
 * tail records — rendering-independent by convert-to-llm's rule (a tail's
 * bytes are its reminder block, which no image rendering can touch).
 *
 * Correctness rests on the same frozen-entry guarantee the wire compiler's
 * segment cache already rests on (wire-compiler `compile.ts`): an entryId
 * never maps to different content, and a rendering change folds its
 * `cacheState` into the key.
 *
 * The memo is pruned to the keys of the CURRENT window after every
 * {@link compileWindow} pass, so it holds O(window), never O(history).
 */
export interface ContextWireConversionMemo {
  readonly records: Map<string, CompiledEntry | null>;
  readonly tails: Map<string, readonly CompiledEntry[]>;
}

/** Fresh conversion memo (one pipeline's warm-path state). */
export function createConversionMemo(): ContextWireConversionMemo {
  return { records: new Map(), tails: new Map() };
}

/** Memo key of one entry's primary record under its residency rendering. */
function conversionMemoKey(entryId: string, rendering: ImageRendering | undefined): string {
  return recordCacheKey(entryId, MINIMAX_M3_DIALECT, rendering);
}

/** Memo key of one entry's reminder tail records (rendering-independent). */
function tailsMemoKey(entryId: string): string {
  return `${compileKey(entryId, MINIMAX_M3_DIALECT)}#tails`;
}

/**
 * Background-compaction seam (Ф2: "`pi-compaction`/`split-turn`/
 * `overflow-recovery` with the byte trigger; background-compaction as the
 * scheduler", final-architecture.md:397) — the composed pipeline OWNS the
 * double trigger when this is wired: {@link BackgroundCompactionScheduler}
 * is created over the caller's log/append/summarizer and notified on every
 * {@link ContextWirePipeline.applyCommit}.
 *
 * The byte axis defaults to the pipeline's wire guard (`maxBytes`, the Ф2
 * 32-МБ payload budget): the window compacts UP TO the guard — background
 * compaction starts at 75% of the budget, compaction becomes blocking at
 * 90% — and the wire guard itself stays the last-resort hard line that fails
 * a request with {@link WireBudgetExceeded}, never the working trigger.
 *
 * The caller owns the durable side: `entries` serves the raw append-only log
 * in the compaction package's vocabulary (`mcode.message` / `mcode.system` /
 * ... — adapting the session's own message kinds is the log owner's job, and
 * the `mcode.*` control kinds pass through natively; a compaction checkpoint
 * MUST be visible there, it is what resets the byte axis), `append`
 * persists the produced `mcode.compaction` draft under the writer gate and
 * through the canonical `compact` seam. В1 (opus-decisions-20261101): the
 * checkpoint does NOT reach THIS turn's wire pipeline — the pipeline folds
 * only the canonical commits the executor feeds (`seed` + the history hook),
 * so a mid-turn cut must come back as a `replaceMessages` decision of the
 * before-LLM compaction hook (the runner delivers it → the history hook
 * reseeds this pipeline). {@link ContextWirePipeline.compactionBarrier} is
 * that admission point; the seam therefore also exposes
 * `checkpointReplacement` (the committed replacement, canonical vocabulary)
 * and `setSummarySignal` (the turn's abort signal for the summary request).
 */
export interface ContextWireCompaction {
  /** Summary backend of `pi-compaction` (an injected async function). */
  readonly summarizer: Summarizer;
  /**
   * Wave-0 item 0.2: identity of the summarizer binding (`provider/modelId`
   * of the summary model), folded into the scheduler's attempt key — a
   * failed attempt under one summarizer never blocks a retry under another.
   * Optional (tests and seams without a resolved model omit it).
   */
  readonly summarizerKey?: () => string | undefined;
  readonly readyStore?: import('@mavis/context-compaction').ReadyCompactionStore;
  readonly onProgress?: (stage: import('@mavis/context-compaction').CompactionProgressStage) => void;
  /** Live append-only session log, oldest first, growing only. */
  readonly entries: () => readonly LogEntry[];
  /**
   * Durable append of checkpoint drafts (writer-gated). The commit is the
   * ONE durable truth — it does NOT fold back into THIS turn's pipeline
   * (fact 1); the cut reaches the current turn only through the admission
   * point's `replaceMessages` decision or the В1 recovery's reseed.
   */
  readonly append: (drafts: readonly DurableEntryDraft[]) => Promise<void>;
  /**
   * Double-trigger budgets. `byteBudget` defaults to the pipeline's
   * `maxBytes` (the wire guard) when omitted.
   *
   * OWNER of the token axis: the CALLER (the turn loop's window gate) — this
   * pipeline has no provider-window knowledge of its own, so `tokenBudget`
   * has no default. Set it to the provider context window to enable the
   * token axis (`0` disables an axis deliberately); omitting it leaves the
   * byte axis as the only trigger — legal but must never happen silently,
   * so the construction emits a `MCODE_CONTEXT_WIRE_TOKEN_BUDGET_UNSET`
   * process warning (final-architecture.md:224 gates tokens AND bytes;
   * goals.md:4 "payload всегда в окне" includes the token axis).
   */
  readonly budgets?: Omit<CompactionBudgets, 'byteBudget'> & {
    readonly byteBudget?: number;
  };
  /** Recent-context budget for the cut point. Default: the scheduler's own. */
  readonly keepRecentTokens?: number;
  /**
   * В1 barrier read: the canonical replacement of the session's LAST
   * checkpoint committed through `append` (the summary plus the kept tail —
   * the list the canonical history now holds). The admission point returns
   * it as the hook's `replaceMessages` decision, which reseeds this
   * pipeline with the CUT window. Resolved by sessionId at call time; absent
   * when the binding does not record checkpoints (the barrier stays
   * disabled and the request proceeds on the current window).
   */
  readonly checkpointReplacement?: () => WireCompactionCheckpoint | undefined;
  /**
   * В1: registers the CURRENT turn's abort signal as the summary request's
   * signal — the exec streamFn carries no idle timeout (the product
   * transport passes no `timeoutMs`), so the turn signal is the only thing
   * that can stop a hung summary provider call. NO new timer is introduced:
   * an aborted signal must also clear itself (the barrier's registration is
   * turn-scoped, while a background job may outlive the turn), so stale
   * aborted signals never poison later background summaries.
   */
  readonly setSummarySignal?: (signal: AbortSignal | undefined) => void;
  /**
   * Wave 3 (item 3.1, canon 05 §2.3): the canonical attempt snapshot — the
   * fold generation and the covered cut of the log the job would summarize.
   * The scheduler builds its attempt key `(baseGeneration, cut, model,
   * promptHash)` from it, and the append staleness check compares the
   * generation it captured at job start against the binding's CURRENT one
   * (a foreign replace between the snapshot and the commit discards the
   * result — one immediate re-plan). Absent keeps the head-proxy key.
   */
  readonly attemptSnapshot?: () => SchedulerAttemptSnapshot;
  /**
   * Wave 3 (item 3.2, canon 05 §2.2): the deterministic fallback summary
   * producer (the cline `basic` shape — no provider call). With the breaker
   * open, the blocking edge compacts through it: the projection drops below
   * the goal without the summarizer that just failed its breaker threshold.
   */
  readonly deterministicSummary?: DeterministicSummaryProducer;
}

/**
 * The committed checkpoint of the unified compaction, in canonical history
 * vocabulary — the facts the admission point needs to return the
 * `replaceMessages` decision (the replacement list) and to report the cut.
 */
export interface WireCompactionCheckpoint {
  readonly compactionId: string;
  readonly summary: string;
  /** [compactionSummary, ...kept tail...] — the list canonical history holds. */
  readonly replacement: readonly CanonicalHistoryMessage[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  /**
   * Wave 3 (item 3.2): `true` when the summary came from the deterministic
   * fallback producer — the wall check (canon §2.4: still above the hard wall
   * after the fallback stops the turn) judges only this case, never an LLM
   * checkpoint.
   */
  readonly deterministic?: boolean;
  /**
   * Wave 3 (item 3.3, canon §2.6): the unified measure of the window the
   * commit produced — the SAME number the triggers evaluate, in the
   * post-compaction Context Usage shape (LOCAL_ESTIMATE: after a compaction
   * the usage anchor is gone, so the number is the estimate until the first
   * provider answer of the new generation). `undefined` when the scheduler
   * has no measure yet.
   */
  readonly contextUsage?: WireCompactionContextUsage;
}

/** Post-compaction Context Usage snapshot of the unified measure (item 3.3). */
export interface WireCompactionContextUsage {
  readonly contextWindowTokens: number;
  readonly usedTokens: number;
  readonly totalCountSource: 'LOCAL_ESTIMATE';
  readonly components: readonly {
    readonly kind: 'SYSTEM_PROMPT' | 'MEMORY' | 'TOOLS' | 'SKILLS' | 'MESSAGES' | 'OTHER';
    readonly tokens: number;
  }[];
}

/**
 * В1 compaction barrier — the level-aware admission point of the before-LLM
 * compaction hook (opus-decisions-20261101, В1): `evaluate()` decides
 * whether the crossing level is `none`/`background` (do NOT wait — the
 * background threshold stays non-blocking) or `blocking` (await
 * `runBlocking`, raced against the turn's abort signal; on success the
 * checkpoint replacement rides back as the hook's `replaceMessages`
 * decision, whose delivery reseeds this pipeline so the NEXT `project()`
 * compiles the cut window). `undefined` when the session has no unified
 * compaction seam or the seam records no checkpoint replacement.
 */
export interface WireCompactionBarrier {
  /** Pure trigger evaluation of the session's unified scheduler. */
  readonly evaluate: () => TriggerEvaluation;
  /**
   * Runs (or joins) the blocking compaction, raced against `signal`.
   * Resolves the committed checkpoint, `null` when nothing was compacted
   * (nothing-to-compact) or the signal aborted the WAIT (the job itself
   * keeps running in the background and its checkpoint stays harmless).
   * Rejects when the compaction failed — the caller logs the failure and
   * the request proceeds on the current window.
   */
  readonly runBlocking: (
    signal?: AbortSignal,
    options?: { readonly force?: boolean },
  ) => Promise<WireCompactionCheckpoint | null>;
}

export interface ContextWireOptions {
  /**
   * Hard cap on the compiled provider payload in bytes; `prepare()` throws
   * {@link WireBudgetExceeded} on breach. Default {@link DEFAULT_MAX_PAYLOAD_BYTES}.
   */
  readonly maxBytes?: number;
  /** Segment cache capacity. Default 4096 (one multi-hour session's window). */
  readonly cacheCapacity?: number;
  /** Explicit segment cache (tests). Default: a private LRU. */
  readonly cache?: WireSegmentCache;
  /** Context-MMU image residency (Ф2 R2). Default: everything evicted. */
  readonly residency?: ContextWireResidency;
  /**
   * Background-compaction seam; when wired, the pipeline creates and drives
   * the double-trigger scheduler (byte axis defaults to `maxBytes`).
   * Default: no scheduler — the wire guard alone bounds the window.
   */
  readonly compaction?: ContextWireCompaction;
  /**
   * W10 unified-compaction composition: a per-session seam factory, resolved
   * once when `seed()` builds the session's pipeline. The composition
   * supplies the W05 settings/budgets/summarizer resolution and the durable
   * log binding; `undefined` keeps that session's pipeline on the wire
   * guard alone.
   */
  readonly compactionFor?: (sessionId: string) => ContextWireCompaction | undefined;
}

/** The prepared provider payload plus the facts the turn loop reports. */
export interface PreparedContext {
  /** NDJSON wire body: one normalized provider record per line. */
  readonly body: Buffer;
  /** NDJSON bytes plus the UTF-8 data and MIME strings of forwarded image carriers. */
  readonly totalBytes: number;
  /** Σ manifest segment bytes (the compaction byte-trigger axis, for contrast). */
  readonly manifestBytes: number;
  /** The manifest the body was compiled from. */
  readonly manifest: ContextManifest;
  readonly segments: CompiledBody['segments'];
  /**
   * Ш4: the projected wire records in payload order — the same values the
   * body's NDJSON lines serialize, WITHOUT re-parsing the body. The runtime
   * bridge (`TurnContextWire`) maps them onto the runner's structural
   * `ContextWireRecord` port directly, so a request pays no O(payload) JSON
   * decode on top of the cached conversion.
   */
  readonly records: readonly WireEntry[];
}

/**
 * The incremental context path over one durable log. Feed every committed
 * batch through {@link applyCommit}; call {@link prepare} for each provider
 * request. The window manifest, the resume capsule and the segment cache
 * stay warm — nothing re-reads applied history.
 */
export class ContextWirePipeline {
  private readonly service: ProjectionService;
  private readonly cache: WireSegmentCache;
  private readonly maxBytes: number;
  private readonly residency: ContextWireResidency | undefined;
  private readonly scheduler: BackgroundCompactionScheduler | undefined;
  /** В1: the compaction seam itself (the barrier reads its replacement read). */
  private readonly compactionSeam: ContextWireCompaction | undefined;
  /** Content pages of the current window; pruned to the manifest after each commit. */
  private readonly content = new Map<string, Entry>();
  /** Warm-path conversion memo: one record per `(entryId, dialect, cacheState)`. */
  private readonly conversions: ContextWireConversionMemo = createConversionMemo();

  constructor(options?: ContextWireOptions) {
    this.service = new ProjectionService();
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.cache = options?.cache ?? createLruSegmentCache(options?.cacheCapacity ?? 4096);
    this.residency = options?.residency;
    this.compactionSeam = options?.compaction;
    // The byte axis defaults to the WIRE GUARD: compaction must shrink the
    // window up to (75%/90% of) the payload budget, never let the guard
    // become the only line of defense (final-architecture.md:397).
    const compaction = options?.compaction;
    if (compaction !== undefined && compaction.budgets?.tokenBudget === undefined) {
      // The token axis is the caller's ownership (the turn loop knows the
      // provider window; this seam does not). Its absence must be LOUD —
      // evaluateTriggers would otherwise skip the axis in silence and the
      // "tokens ≤ window − reserve" half of the window gate would be dead
      // without anyone deciding so (goals.md:4, final-architecture.md:224).
      process.emitWarning(
        'context-wire: the compaction seam is wired without budgets.tokenBudget — ' +
          'the token trigger axis (and the ≤90% cut clamp) stays disabled and the byte axis alone bounds the window. ' +
          'Set budgets.tokenBudget to the provider context window (0 disables the axis deliberately).',
        { code: 'MCODE_CONTEXT_WIRE_TOKEN_BUDGET_UNSET' },
      );
    }
    this.scheduler =
      compaction === undefined
        ? undefined
        : createBackgroundCompactionScheduler({
            budgets: {
              ...compaction.budgets,
              byteBudget: compaction.budgets?.byteBudget ?? this.maxBytes,
              // The token axis is the caller's ownership (the turn loop knows
              // the provider window; this seam does not). An unset budget
              // DISABLES the axis deliberately (0) — the warning above makes
              // that decision loud instead of letting it pass silently.
              tokenBudget: compaction.budgets?.tokenBudget ?? 0,
            },
            session: {
              // The seam serves the log through a callback (`entries()`); the
              // scheduler's session wants the live array itself.
              get entries() {
                return compaction.entries();
              },
              append: compaction.append,
              // Wave 3 (item 3.1): the canonical attempt snapshot
              // (`baseGeneration, cut`) when the binding tracks the wave-1
              // generation.
              ...(compaction.attemptSnapshot
                ? { attemptSnapshot: compaction.attemptSnapshot }
                : {}),
            },
            summarizer: compaction.summarizer,
            readyStore: compaction.readyStore,
            onProgress: compaction.onProgress,
            keepRecentTokens: compaction.keepRecentTokens,
            // Wave-0 item 0.2: the summarizer identity (model + prompt) is the
            // model/prompt half of the attempt key — a failed attempt under
            // one summarizer does not block a retry under another.
            ...(compaction.summarizerKey ? { summarizerKey: compaction.summarizerKey } : {}),
            // Wave 3 (item 3.2): the deterministic fallback for the open
            // breaker — the blocking edge cuts the window without a provider
            // call.
            ...(compaction.deterministicSummary
              ? { deterministicSummary: compaction.deterministicSummary }
              : {}),
          });
  }

  /**
   * Rebuilds the pipeline from a resume capsule and the retained slice the
   * storage layer serves for it — the lazy-open path (≤1 с budget opening).
   * The slice's entries are the initial window content pages.
   */
  static fromCapsule(
    capsule: ResumeCapsule,
    slice: readonly Entry[],
    options?: ContextWireOptions,
  ): ContextWirePipeline {
    const pipeline = new ContextWirePipeline(options);
    // Test/replay seam: the fresh pipeline's fold state is replaced by the
    // capsule's; the two-step cast is required because `service` is private.
    (pipeline as unknown as { service: ProjectionService }).service = ProjectionService.fromCapsule(
      capsule,
      slice,
    );
    for (const entry of slice) pipeline.content.set(entry.id, entry);
    pipeline.pruneToWindow();
    return pipeline;
  }

  /** Applies one committed batch (the backend commit enriched with its entries). */
  applyCommit(commit: CommitWithEntries): ContextManifest {
    for (const entry of commit.entries) this.content.set(entry.id, entry);
    this.service.apply(commit);
    this.pruneToWindow();
    // The double trigger is evaluated at the O(delta) moment — bytes grow
    // here, not in prepare(). A background-level crossing starts the job
    // fire-and-forget; a blocking-level crossing starts the same job and the
    // before-LLM compaction hook's barrier ({@link ContextWirePipeline.compactionBarrier})
    // awaits it before the next request — its `replaceMessages` decision is
    // what feeds the CUT window back into this pipeline (В1, fact 1: nothing
    // on the scheduler's own append path folds into the CURRENT turn here).
    this.scheduler?.notify();
    return this.service.manifest();
  }

  /**
   * Resolves when no compaction job is in flight. В1: this is NOT the
   * request-path admission point anymore — it awaits ANY in-flight job,
   * including a background 75% one, so awaiting it before every request
   * would erase the background threshold. The admission point is the
   * level-aware {@link ContextWirePipeline.compactionBarrier} of the
   * before-LLM compaction hook. Kept for diagnostics and test harnesses.
   */
  whenCompactionIdle(): Promise<void> {
    return this.scheduler?.whenIdle() ?? Promise.resolve();
  }

  /**
   * В1: the level-aware admission point over the session's unified
   * scheduler — `evaluate()` for the level gate (none/background never
   * wait), `runBlocking(signal)` for the blocking await with the checkpoint
   * replacement resolved back. `undefined` without the compaction seam or
   * without a seam that records the checkpoint replacement (the barrier
   * could not feed the cut window back, so it stays disabled).
   */
  compactionBarrier(): WireCompactionBarrier | undefined {
    const scheduler = this.scheduler;
    const seam = this.compactionSeam;
    const checkpointReplacement = seam?.checkpointReplacement;
    if (!scheduler || !checkpointReplacement) return undefined;
    return {
      evaluate: () => scheduler.evaluate(),
      runBlocking: async (signal, options) => {
        // The turn's abort signal rides the summary request too (the exec
        // streamFn has no idle timeout — see `setSummarySignal`).
        seam?.setSummarySignal?.(signal);
        const outcome = await raceWithAbort(scheduler.runBlocking({ ...options, signal }), signal);
        // The WAIT lost to Esc: return control at once; the job keeps
        // running in the background and its checkpoint stays harmless.
        if (signal?.aborted || outcome === null) return null;
        // Re-resolve the replacement THROUGH the seam (session-scoped), not
        // through this pipeline: the runner's delivery of the returned
        // decision reseeds the session with a NEW pipeline object, and this
        // stale one must never serve the fresh projection.
        const checkpoint = checkpointReplacement();
        if (checkpoint === undefined || checkpoint.replacement.length === 0) return null;
        return {
          ...checkpoint,
          // Wave 3 (item 3.3, canon §2.6): the post-commit unified measure in
          // the Context Usage shape — the SAME number the triggers evaluate,
          // marked LOCAL_ESTIMATE (after a cut the usage anchor is gone; the
          // mark holds until the first provider answer of the new window).
          ...(compactionContextUsageOf(scheduler.measure())
            ? { contextUsage: compactionContextUsageOf(scheduler.measure())! }
            : {}),
        };
      },
    };
  }

  /** The double-trigger scheduler when the compaction seam is wired. */
  get compactionScheduler(): BackgroundCompactionScheduler | undefined {
    return this.scheduler;
  }

  /**
   * Wave 3 (item 3.3, canon §2.6): the unified measure of the projected
   * window — the SAME snapshot of the same tracker the triggers evaluate
   * (`evaluate()` is a pure re-read of it). `undefined` without the
   * compaction seam.
   */
  measure(): CompactionMeasure | undefined {
    return this.scheduler?.measure();
  }

  /** Current window manifest snapshot. */
  manifest(): ContextManifest {
    return this.service.manifest();
  }

  /** Resume capsule for the current fold position (≤ a few hundred bytes). */
  capsule(): ResumeCapsule {
    return this.service.capsule();
  }

  /** Number of content pages currently held (bounded by the window). */
  get pageCount(): number {
    return this.content.size;
  }

  /**
   * Compiles the current window into the provider payload. The per-entry
   * conversion stage is MEMOIZED across prepares by
   * `(entryId, dialect, normalizerVersion, residency cacheState)` —
   * final-architecture.md:74/:90 — so a warm request re-converts only the
   * delta (entries appended since the last prepare, plus entries whose
   * residency state flipped); everything else reuses the converted record
   * and its cached wire segment. Warm requests pay O(window) arithmetic —
   * cached segments, no re-hashing; cold entries serialize once.
   */
  prepare(): PreparedContext {
    const manifest = this.service.manifest();
    const compiled = compileWindow([...this.content.values()], manifest, {
      maxBytes: this.maxBytes,
      cache: this.cache,
      residency: this.residency,
      conversionMemo: this.conversions,
    });
    return { ...compiled, manifest, manifestBytes: manifest.windowBytes };
  }

  /**
   * Prunes the content pages to the current window: the manifest segments
   * plus the model-visible control pages logged at or after the compaction
   * cut (`firstKeptEntryId`) — the same set the storage layer's retained
   * slice serves a resumed pipeline, so an incremental and a resumed
   * `prepare()` compile identical bodies.
   */
  private pruneToWindow(): void {
    const manifest = this.service.manifest();
    const live = new Set(manifest.segments.map((segment) => segment.entryId));
    // The compaction cut as a log position: control pages logged before the
    // first KEPT entry are cut together with the prefix they steered.
    let cut: { seq: Seq; ordinal: number } | undefined;
    if (manifest.compaction !== undefined) {
      const firstKeptEntryId = manifest.compaction.firstKeptEntryId;
      // Retain-none (`null`) has no kept entry: no cut position exists, so
      // visible control pages stay (bounded over-retention, monotone in the
      // same sense as the absent-cut reading) instead of indexing by `null`.
      const kept = firstKeptEntryId !== null ? this.content.get(firstKeptEntryId) : undefined;
      if (kept !== undefined) cut = { seq: kept.seq, ordinal: kept.ordinal };
    }
    for (const [id, entry] of this.content) {
      if (live.has(id)) continue;
      if (
        isVisibleControlKind(entry.kind) &&
        (cut === undefined ||
          entry.seq > cut.seq ||
          (entry.seq === cut.seq && entry.ordinal >= cut.ordinal))
      ) {
        continue;
      }
      this.content.delete(id);
    }
  }
}

/**
 * В1: races `job` against `signal`. Resolves `null` as soon as the signal
 * aborts (the WAIT is over; `job` itself keeps running — the scheduler owns
 * an internal rejection handler, so an abandoned job never surfaces as an
 * unhandled rejection). Without a signal (or with an already-aborted one —
 * the caller checks first) this is just `job`; rejections propagate so the
 * caller can distinguish a failed compaction from an aborted wait.
 */
function raceWithAbort<T>(job: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return job;
  // The Promise executor runs synchronously, so `onAbort` is assigned before
  // any listener or `finally` can read it (definite-assignment assertion).
  let onAbort!: () => void;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
  });
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([job.finally(() => signal.removeEventListener('abort', onAbort)), aborted]);
}

/**
 * Wave 3 (item 3.3, canon §2.6): the unified measure in the post-compaction
 * Context Usage shape — `LOCAL_ESTIMATE` by construction (a fresh cut has no
 * usage anchor of its generation; the mark holds until the first provider
 * answer re-anchors the window). The projected window is one MESSAGES
 * component; the disabled token axis (budget 0) has no percentage to show.
 */
function compactionContextUsageOf(
  measure: CompactionMeasure,
): WireCompactionContextUsage | undefined {
  if (!Number.isFinite(measure.tokenBudget) || measure.tokenBudget <= 0) return undefined;
  return {
    contextWindowTokens: measure.tokenBudget,
    usedTokens: measure.tokens,
    totalCountSource: 'LOCAL_ESTIMATE',
    components: [
      { kind: 'SYSTEM_PROMPT', tokens: 0 },
      { kind: 'MEMORY', tokens: 0 },
      { kind: 'TOOLS', tokens: 0 },
      { kind: 'SKILLS', tokens: 0 },
      { kind: 'MESSAGES', tokens: measure.tokens },
      { kind: 'OTHER', tokens: 0 },
    ],
  };
}

// Image objects are immutable results of the memoized conversion. Measure each once
// without serializing the base64 again or assuming that legacy data is valid ASCII.
const imageByteLengths = new WeakMap<RecordImageBlock, number>();

function imageByteLength(image: RecordImageBlock): number {
  let bytes = imageByteLengths.get(image);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(image.data, 'utf8') + Buffer.byteLength(image.mimeType, 'utf8');
    imageByteLengths.set(image, bytes);
  }
  return bytes;
}

/**
 * Executes the shared context plan with runtime media rendering and memoized
 * conversion/segments. Selection, placement recovery, batching, summary and
 * record order belong exclusively to createContextPlan/compileContextPlan.
 * Cache identities include batch membership or residency to prevent stale
 * bytes. Segment harvesting happens only after successful budget admission.
 */
export function compileWindow(
  windowPages: readonly Entry[],
  manifest: ContextManifest,
  options: {
    readonly maxBytes: number;
    readonly cache: WireSegmentCache;
    readonly residency?: ContextWireResidency;
    readonly conversionMemo?: ContextWireConversionMemo;
    readonly requireHashes?: boolean;
  },
): Omit<CompiledBody, 'totalBytes'> & Pick<PreparedContext, 'totalBytes' | 'records'> {
  const plan = createContextPlan(windowPages, manifest);
  const memo = options.conversionMemo;
  const liveRecordKeys = new Set<string>();
  const liveTailsKeys = new Set<string>();
  const memoRecord = (key: string, convert: () => CompiledEntry | null): CompiledEntry | null => {
    if (memo === undefined) return convert();
    liveRecordKeys.add(key);
    let record = memo.records.get(key);
    if (record === undefined) {
      record = convert();
      memo.records.set(key, record);
    }
    return record;
  };
  const memoTails = (
    key: string,
    convert: () => readonly CompiledEntry[],
  ): readonly CompiledEntry[] => {
    if (memo === undefined) return convert();
    liveTailsKeys.add(key);
    let tails = memo.tails.get(key);
    if (tails === undefined) {
      tails = convert();
      memo.tails.set(key, tails);
    }
    return tails;
  };

  const residencySegments = options.residency?.segments;
  const residentRecords = new Set<string>();
  const compileDialect = compiledRecordDialect();
  const assembled = compileContextPlan(plan, {
    lowering: {
      batch(unit, dialect) {
        const ids = unit.map((page) => page.id);
        const record = memoRecord(compileBatchKey(ids, dialect), () => convertBatch(unit, dialect));
        if (record === null) return null;
        const entryId = `${record.entryId}#batch@${createHash('sha256').update(JSON.stringify(ids), 'utf8').digest('hex').slice(0, 16)}`;
        return { ...record, entryId };
      },
      tails(page, dialect) {
        return memoTails(tailsMemoKey(page.id), () => convertEntryTails(page, dialect));
      },
      entry(source) {
        const page = source as Entry;
        const residency = options.residency;
        const imagePage = residency?.pageOf(page);
        const isResident =
          residency !== undefined &&
          imagePage !== undefined &&
          residency.mmu.statusOf(imagePage) === 'resident';
        const rendering: ImageRendering | undefined = isResident
          ? {
              cacheState: `resident@${imagePage!.sha256.slice(0, 16)}`,
              renderImageBlock: (part) => {
                if (part.data !== undefined) return { data: part.data, mimeType: part.mimeType };
                const stored =
                  part.ref === undefined
                    ? undefined
                    : residency.readImage?.({
                        sha256: part.ref.sha256,
                        id: imagePage!.id,
                        mime: part.mimeType,
                      });
                return stored === undefined
                  ? undefined
                  : { data: stored.data, mimeType: stored.mimeType };
              },
            }
          : pageHasOffloadedImage(page)
            ? {
                // The stub text is fixed per entry content (path/mime/size are
                // immutable in the reference block), so the cache state keys on
                // the content-addressed entry id alone.
                cacheState: 'artifact-stub',
                renderImage: (part) =>
                  part.ref === undefined
                    ? undefined
                    : imageArtifactPlaceholder({
                        artifact: part.ref.artifact,
                        mimeType: part.mimeType,
                        bytes: part.ref.bytes,
                      }),
              }
            : undefined;
        const record = memoRecord(conversionMemoKey(page.id, rendering), () =>
          convertEntry(page, undefined, rendering),
        );
        if (record !== null) {
          // A resident rendering compiles under its own content-keyed wire
          // identity — never under the plain entry id the digest placeholder
          // uses (see the residency note above).
          const wireRecord =
            rendering === undefined
              ? record
              : {
                  ...record,
                  entryId: `${record.entryId}#${rendering.cacheState}`,
                };
          if (rendering !== undefined && residencySegments !== undefined) {
            // Content-addressed cold reuse (Ф2 prep ≤50 мс): the identity embeds
            // the immutable page's sha256, so a hit's bytes are that page's bytes.
            // Seed the compiler's cache BEFORE the pass — compile() then serves
            // the stored segment without re-serializing or re-hashing it.
            const stored = residencySegments.get(wireRecord.entryId);
            if (stored !== undefined) {
              options.cache.set(segmentCacheKey(compileDialect, wireRecord.entryId), stored);
            }
            residentRecords.add(wireRecord.entryId);
          }
          return wireRecord;
        }
        return null;
      },
    },
  });
  if (memo !== undefined) {
    // Keep the memo O(window): a key the current window no longer converts
    // (the entry was cut, or its residency state flipped back) is dropped.
    for (const key of memo.records.keys()) {
      if (!liveRecordKeys.has(key)) memo.records.delete(key);
    }
    for (const key of memo.tails.keys()) {
      if (!liveTailsKeys.has(key)) memo.tails.delete(key);
    }
  }

  const wireEntries = assembled.records.map(compiledEntryToWireEntry);
  const wireManifest = wireEntries.map((entry) => ({ entryId: entry.entryId }));
  let additionalBytesByEntry: Map<string, number> | undefined;
  let imageBytes = 0;
  // Count only the final records and roles that hydrate into image content.
  // Provider-specific request envelopes are outside this canonical budget.
  for (const record of assembled.records) {
    if (record.images === undefined || (record.role !== 'user' && record.role !== 'tool')) continue;
    const bytes = record.images.reduce((total, image) => total + imageByteLength(image), 0);
    (additionalBytesByEntry ??= new Map()).set(record.entryId, bytes);
    imageBytes += bytes;
  }
  const compiled = compile(wireManifest, wireEntries, {
    maxBytes: options.maxBytes,
    ...(additionalBytesByEntry === undefined ? {} : { additionalBytesByEntry }),
    dialect: compileDialect,
    cache: options.cache,
    requireHashes: options.requireHashes === true,
  });
  if (residencySegments !== undefined && residentRecords.size > 0) {
    // Harvest on success only: a breached pass produced no body (compile
    // already rolled its inserted keys back), and the store must not record
    // segments of a pass that never went out. The bytes come from the
    // compiler's OWN cache — seeded there by this pass or freshly serialized
    // by compile() — so the store never re-serializes a record (a third
    // stringify over ~10 МБ of data URLs would defeat the reuse).
    for (const wireId of residentRecords.keys()) {
      if (residencySegments.get(wireId) !== undefined) continue;
      const segment = options.cache.get(segmentCacheKey(compileDialect, wireId));
      if (segment !== undefined) residencySegments.set(wireId, segment);
    }
  }
  return { ...compiled, totalBytes: compiled.totalBytes + imageBytes, records: wireEntries };
}

/**
 * One-shot prepare over a full log — the degraded/replay mode the equivalence
 * gate drives (full rebuild, fresh conversion, no carried cache).
 */
export function prepareContextWire(
  entries: readonly Entry[],
  options?: ContextWireOptions,
): PreparedContext {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const manifest = buildProjection(entries);
  const cache = options?.cache ?? createLruSegmentCache(options?.cacheCapacity ?? 4096);
  const compiled = compileWindow(entries, manifest, {
    maxBytes,
    cache,
    residency: options?.residency,
  });
  return { ...compiled, manifest, manifestBytes: manifest.windowBytes };
}

/** Builds a backend-shaped commit enriched with its entries (test/caller helper). */
export function commitOfEntries(seq: number, entries: readonly Entry[]): CommitWithEntries {
  const commit: Commit = {
    seq: seq as Seq,
    batchId: seq as Commit['batchId'],
    entryCount: entries.length,
    head: seq as Seq,
    codec: 'zstd',
    compressedBytes: 0,
    uncompressedBytes: entries.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'),
      0,
    ),
  };
  return { ...commit, entries };
}

// ── Ш4: the turn-path bridge ────────────────────────────────────────────────
//
// `TurnContextWire` owns one `ContextWirePipeline` per Session and bridges the
// canonical history commits of the turn path onto it: the executor feeds every
// committed canonical message ({@link TurnContextWire.observeCommit}, seeded
// per turn from the pre-turn runner history), and the runner's
// `convertToLlm` seam reads the provider-bound payload through the structural
// `ContextWireProjection` port (`@mavis/agent-core/pi-turn-runner`). The
// per-entry conversion memo and the compiled-segment LRU are the pipeline's
// own (convert-to-llm record key + wire-compiler `createLruSegmentCache`); the
// segment cache is SHARED across sessions and turns of this handle, so a
// re-seeded session reuses every unchanged record's bytes.
//
// Degradation is fail-safe, never fail-closed: any pipeline fault (a fold
// invariant breach, a `WireBudgetExceeded` payload) marks the session's state
// stale and the projection returns `undefined`, which degrades that request —
// and every request until the next turn seed or a В1 recovery reseed — to the
// legacy `projectAgentMessagesForModel` conversion. The wire path is an
// optimization of payload assembly; it can never lose or corrupt provider
// context. The stale mark is also how the В1 overflow recovery heals the
// session mid-turn: its reseed replaces the state wholesale (fresh pipeline,
// stale cleared) with the committed cut replacement.
//
// Enabled by composition (`resolveContextWireEnabled`): the gate follows the
// canonical-history mode — DURABLE (the W10 default) turns the wire path ON
// by default; the explicit jsonl compatibility mode keeps it OFF (the legacy
// conversion and the turn path are byte-identical to before there).

const wireLog = createLogger('mcode:turn');
// The wire path assembles the payload itself, bypassing the logging wrappers
// `assemblePayload`/`assembleManifestPayload` — so the convert-stage event of
// logging-spec §4 (`mcode:convert` "payload assembled") is mirrored here,
// beside the turn-seam event, from the same already-computed scalars.
const convertLog = createLogger('mcode:convert');

/** Env flag enabling the context-wire turn path. W10 default: follows the durable history mode (on). */
const CONTEXT_WIRE_ENV = 'MCODE_CONTEXT_WIRE';

/**
 * Resolves the env gate (W10 hybrid default): unset follows the canonical
 * history mode — DURABLE (the W10 default) turns the wire path ON, the
 * explicit `jsonl` compatibility mode keeps it OFF (exact legacy behavior).
 * Explicit `0/false/off` disables (compatibility switch); explicit
 * `1/true/on` enables. Unknown values fail closed with a clear error —
 * no silent degradation of the projection root.
 */
export function resolveContextWireEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[CONTEXT_WIRE_ENV]?.trim().toLowerCase();
  // Unset or blank follows the canonical-history mode (the W10 hybrid
  // default); explicit falsy values are the compatibility switch.
  if (!raw) return resolveHistoryProviderMode(env) === 'durable';
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  throw new Error(
    `Unsupported ${CONTEXT_WIRE_ENV} value '${raw}' (supported: '1'/'true'/'on', '0'/'false'/'off', or unset to follow MCODE_HISTORY_PROVIDER)`,
  );
}

/** Handle construction options; budgets default to the pipeline's own. */
export interface TurnContextWireOptions {
  readonly maxBytes?: number;
  /** Compiled-segment LRU capacity, shared by every session of the handle. Default 4096. */
  readonly cacheCapacity?: number;
  /** Explicit shared segment cache (tests). Default: a private LRU. */
  readonly cache?: WireSegmentCache;
  /**
   * Wave-0 item 0.5: the image residency overlay (the current-turn policy by
   * default), composed once per host. The overlay's turn boundaries ride the
   * same seed/commit feed below; `forSession` (when present) binds the
   * per-session seam view the pipeline compiles against.
   */
  readonly residency?: (ContextWireResidency & TurnImageResidencyHooks) | TurnImageResidency;
  /**
   * W10 unified-compaction composition: per-session seam factory, resolved
   * when `seed()` builds the session's pipeline. See {@link ContextWireOptions.compactionFor}.
   */
  readonly compactionFor?: (sessionId: string) => ContextWireCompaction | undefined;
}

/**
 * Turn-boundary hooks the composition-owned residency overlays on top of the
 * seam: `seed` starts a fresh turn (everything the seed folds is
 * pre-turn); `reseed`/replacement rebuild the same turn without aging images.
 * Every `messageDelta` commit observes the appended entries as
 * the CURRENT turn's material. Data-only: absent hooks make the overlay
 * stateless over the feed.
 */
export interface TurnImageResidencyHooks {
  readonly beginTurn?: (sessionId: string) => void;
  readonly observeEntries?: (sessionId: string, entries: readonly Entry[]) => void;
  /**
   * Binds the per-session seam view (the content-addressed entry ids are
   * session-scoped in the overlay's state). Absent: the overlay is passed
   * through as-is (a session-agnostic test seam).
   */
  readonly forSession?: (sessionId: string) => ContextWireResidency;
}

/**
 * The resolved model context a turn's seed may carry for the unified
 * compaction seam (W10): the executor passes the turn's resolved model so
 * `compactionFor` builds the budgets from the REAL session model, not from
 * a snapshot guess. Data only; absent seeds keep the pipeline on the wire
 * guard alone (documented fail-safe).
 */
export interface TurnWireModelContext {
  readonly provider: string;
  readonly modelId: string;
  /** Provider context window in tokens; the token-trigger axis owner. */
  readonly contextWindowTokens: number;
  /** The model's own output ceiling, if known. */
  readonly maxOutputTokens?: number;
  /** Thinking level offered to the summary model when it supports reasoning. */
  readonly thinkingLevel?: string;
}

/** One canonical history commit as the executor's history hook observes it. */
export interface ContextWireCommitInput {
  readonly sessionId: string;
  /** `messageDelta`: `messages` are the NEW canonical messages. `replaceMessages`: the full history. */
  readonly reason: 'messageDelta' | 'replaceMessages';
  readonly messages: readonly CanonicalHistoryMessage[];
}

/**
 * The composition-owned memoized payload-assembly bridge over the canonical
 * history of the turn path (integration plan Ш4). Created once per host; the
 * executor seeds and feeds it, the runner input receives per-session
 * {@link TurnContextWire.projection} ports.
 */
export interface TurnContextWire {
  /**
   * Replaces the session's wire state with a fresh pipeline seeded over the
   * pre-turn canonical runner history. Called once per turn preparation; a
   * previously stale state heals here. The optional model context rides for
   * the unified compaction seam ({@link TurnWireModelContext}).
   */
  seed(input: {
    readonly sessionId: string;
    readonly messages: readonly CanonicalHistoryMessage[];
    readonly model?: TurnWireModelContext;
  }): void;
  /**
   * В1 overflow recovery: rebuilds the session's wire state from the
   * canonical replacement a recovery compaction just committed — the
   * mid-turn fold the scheduler's own commit cannot do (fact 1: the
   * scheduler's append path never reaches THIS turn's pipeline), so the
   * recovery's single retry compiles the CUT window. A fresh state also
   * heals staleness (the breach that triggered the recovery marked it).
   */
  reseed(sessionId: string, messages: readonly CanonicalHistoryMessage[]): void;
  /** Feeds one canonical history commit. `replaceMessages` resets and reseeds. */
  observeCommit(change: ContextWireCommitInput): void;
  /**
   * Marks the session's wire state stale (a mid-turn output recall rewound
   * history outside this seam's view): projections degrade to the legacy
   * conversion until the next {@link TurnContextWire.seed} or
   * {@link TurnContextWire.reseed} (the В1 recovery's fresh state).
   */
  markStale(sessionId: string): void;
  /**
   * The per-turn projection for the runner input. `undefined` (no state yet,
   * or stale) degrades the whole turn to the legacy conversion.
   */
  projection(sessionId: string): ContextWireProjection | undefined;
  /** Entries currently held for the session (diagnostics/tests); 0 without state. */
  entryCount(sessionId: string): number;
  /**
   * Ш5/W10: resolves when the session's background compaction job is idle.
   * В1: NOT the request-path admission point — it awaits ANY in-flight job
   * including a background 75% one (awaiting it per request would erase the
   * background threshold). The admission point is the level-aware
   * {@link TurnContextWire.compactionBarrier} of the before-LLM compaction
   * hook. Kept for diagnostics and test harnesses. Resolves immediately
   * without wire state or without the compaction seam.
   */
  whenCompactionIdle(sessionId: string): Promise<void>;
  /**
   * В1: the session's level-aware compaction admission point over the
   * unified scheduler — `evaluate()` gates on the crossing level
   * (none/background never wait), `runBlocking(signal)` awaits the blocking
   * compaction raced against the turn's abort signal and resolves the
   * committed checkpoint replacement for the hook's `replaceMessages`
   * decision. `undefined` without wire state, without the unified seam, or
   * when the seam records no checkpoint replacement.
   */
  compactionBarrier(sessionId: string): WireCompactionBarrier | undefined;
  /**
   * Ш5: byte size of the session's current projection window
   * (`manifest.windowBytes` — the byte axis of the compaction double
   * trigger). `undefined` when the session has no wire state yet.
   */
  windowBytes(sessionId: string): number | undefined;
  /**
   * Wave-0 item 0.2: the session's unified-compaction failure status (the
   * breaker state, the consecutive-failure count, the last classified
   * failure) — the owner-visible surface of a paused auto trigger.
   * `undefined` without wire state or without the compaction seam.
   */
  compactionFailureStatus(sessionId: string): SchedulerFailureStatus | undefined;
  /**
   * Wave 3 (item 3.3, canon §2.6): the session's unified measure — the SAME
   * number the triggers and the admission barrier evaluate, with the
   * `estimated` mark (post-compaction, before the first provider answer).
   * The status surface reads this instead of recomputing a second opinion.
   * `undefined` without wire state or without the compaction seam.
   */
  contextMeasure(sessionId: string): CompactionMeasure | undefined;
}

/** Creates the composition-owned context-wire bridge. */
export function createTurnContextWire(options?: TurnContextWireOptions): TurnContextWire {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  // One compiled-segment LRU across every session and turn of this handle:
  // segment bytes are keyed by (dialect, entryId) and entries are
  // content-addressed, so a fresh pipeline re-serving an unchanged record
  // reuses the bytes without re-serializing or re-hashing them.
  const cache = options?.cache ?? createLruSegmentCache(options?.cacheCapacity ?? 4096);
  const residency = options?.residency;
  const sessions = new Map<string, SessionWireState>();
  return {
    seed,
    reseed,
    observeCommit,
    markStale,
    projection,
    entryCount,
    windowBytes,
    whenCompactionIdle,
    compactionBarrier,
    compactionFailureStatus,
    contextMeasure,
  };

  function seed(input: {
    readonly sessionId: string;
    readonly messages: readonly CanonicalHistoryMessage[];
    readonly model?: TurnWireModelContext;
  }): void {
    residency?.beginTurn?.(input.sessionId);
    rebuild(input);
  }

  function rebuild(input: {
    readonly sessionId: string;
    readonly messages: readonly CanonicalHistoryMessage[];
    readonly model?: TurnWireModelContext;
  }): void {
    const sessionResidency: ContextWireResidency | undefined =
      residency === undefined
        ? undefined
        : typeof (residency as Partial<TurnImageResidency>).forSession === 'function'
          ? (residency as TurnImageResidency).forSession(input.sessionId)
          : (residency as ContextWireResidency);
    const state: SessionWireState = {
      pipeline: new ContextWirePipeline({
        maxBytes,
        cache,
        // Wave-0 item 0.5: the per-host image residency overlay, bound to
        // THIS session (the seam's `pageOf` has no session context and entry
        // ids are content-addressed across sessions). A residency without
        // `forSession` (a test seam) is passed through as-is.
        ...(sessionResidency === undefined ? {} : { residency: sessionResidency }),
        // W10: the per-session unified-compaction seam (settings/budgets/
        // summarizer + the durable log binding), resolved once per seed.
        ...(options?.compactionFor ? { compaction: options.compactionFor(input.sessionId) } : {}),
      }),
      seq: 0,
      keyCounts: new Map(),
      timestamps: new Map(),
      sourceIndexes: new Map(),
      messageIndex: 0,
      stale: false,
    };
    sessions.set(input.sessionId, state);
    apply(state, input.sessionId, input.messages);
  }

  function reseed(sessionId: string, messages: readonly CanonicalHistoryMessage[]): void {
    rebuild({ sessionId, messages });
  }

  function observeCommit(change: ContextWireCommitInput): void {
    const state = sessions.get(change.sessionId);
    if (!state || state.stale) return;
    if (change.reason === 'replaceMessages') {
      // A full replacement (mid-turn compaction, context lifecycle) is only
      // expressible as a fresh window: rebuild from the replacement list.
      rebuild({ sessionId: change.sessionId, messages: change.messages });
      return;
    }
    apply(state, change.sessionId, change.messages, 'commit');
  }

  function markStale(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (!state || state.stale) return;
    state.stale = true;
    wireLog.debug('context-wire state marked stale', { sessionId });
  }

  function projection(sessionId: string): ContextWireProjection | undefined {
    // The port closes over the SESSION, not over one state object: a
    // mid-turn `replaceMessages` reseed replaces the map entry, and even an
    // already-resolved projection must serve the fresh window (or the fresh
    // staleness), never the replaced state.
    if (!sessions.get(sessionId) || sessions.get(sessionId)!.stale) return undefined;
    return {
      project: () => {
        // Re-resolve per request: `markStale` and a `replaceMessages` reseed
        // may both fire between the projection's creation and a late request
        // of the same turn.
        const state = sessions.get(sessionId);
        if (!state || state.stale) return undefined;
        try {
          const startedAtMs = performance.now();
          const prepared = state.pipeline.prepare();
          const records = mappedRecords(prepared.records, state.timestamps, state.sourceIndexes);
          const durationMs = Math.max(0, performance.now() - startedAtMs);
          wireLog.debug('context-wire payload prepared', {
            sessionId,
            records: records.length,
            totalBytes: prepared.totalBytes,
            manifestBytes: prepared.manifestBytes,
            pageCount: state.pipeline.pageCount,
            durationMs,
          });
          convertLog.debug('payload assembled', {
            sessionId,
            totalEntries: records.length,
            totalBytes: prepared.totalBytes,
            manifestBytes: prepared.manifestBytes,
            pageCount: state.pipeline.pageCount,
            durationMs,
          });
          return { records, totalBytes: prepared.totalBytes };
        } catch (error) {
          if (error instanceof WireBudgetExceeded && error.additionalBytes > 0) {
            throw new ContextWireImageBudgetExceeded(error);
          }
          // Fail-safe: degrade this (and every subsequent) request to the
          // legacy conversion instead of surfacing a wire fault as a Turn
          // failure. The next seed rebuilds from scratch.
          state.stale = true;
          wireLog.warn(
            'context-wire prepare failed; the session degrades to the legacy conversion',
            {
              sessionId,
              err: error instanceof Error ? error : new Error(String(error)),
            },
          );
          return undefined;
        }
      },
    };
  }

  function entryCount(sessionId: string): number {
    return sessions.get(sessionId)?.pipeline.pageCount ?? 0;
  }

  /** Ш5/W10: the per-session compaction idle point (diagnostics/tests; see the interface doc). */
  function whenCompactionIdle(sessionId: string): Promise<void> {
    return sessions.get(sessionId)?.pipeline.whenCompactionIdle() ?? Promise.resolve();
  }

  /** В1: the per-session level-aware admission point (resolved per call, by sessionId). */
  function compactionBarrier(sessionId: string): WireCompactionBarrier | undefined {
    return sessions.get(sessionId)?.pipeline.compactionBarrier();
  }

  /** Ш5: the projection window's byte size — the compaction byte-trigger axis. */
  function windowBytes(sessionId: string): number | undefined {
    const state = sessions.get(sessionId);
    return state ? state.pipeline.manifest().windowBytes : undefined;
  }

  /** Wave-0 item 0.2: the session's compaction failure status, when wired. */
  function compactionFailureStatus(sessionId: string): SchedulerFailureStatus | undefined {
    return sessions.get(sessionId)?.pipeline.compactionScheduler?.failureStatus();
  }

  /** Wave 3 (item 3.3): the session's unified measure, when wired. */
  function contextMeasure(sessionId: string): CompactionMeasure | undefined {
    return sessions.get(sessionId)?.pipeline.measure();
  }

  /** Folds `messages` as the next commit of `state`'s pipeline. */
  function apply(
    state: SessionWireState,
    sessionId: string,
    messages: readonly CanonicalHistoryMessage[],
    foldOrigin: 'seed' | 'commit' = 'seed',
  ): void {
    if (messages.length === 0) return;
    try {
      const seq = state.seq + 1;
      const entries: Entry[] = [];
      for (const message of messages) {
        const entry = entryOf(state, message, entries.length, seq);
        state.messageIndex += 1;
        if (entry !== undefined) entries.push(entry);
      }
      if (entries.length === 0) return;
      // Synthesized commit: the projection validates only `seq` succession,
      // `head === seq`, `entryCount` and the entries' `seq` here; the byte
      // fields are never read on this path (the byte axis reads
      // `manifest.windowBytes`).
      state.seq = seq;
      const commit: CommitWithEntries = {
        seq: seq as Seq,
        batchId: seq as CommitWithEntries['batchId'],
        entryCount: entries.length,
        head: seq as Seq,
        codec: 'zstd',
        compressedBytes: 0,
        uncompressedBytes: 0,
        entries,
      };
      state.pipeline.applyCommit(commit);
      // Wave-0 item 0.5: a `messageDelta` commit is CURRENT-turn material
      // (owner input, tool results, assistant output) — the residency
      // overlay tracks these entries as resident candidates.
      if (foldOrigin === 'commit') residency?.observeEntries?.(sessionId, entries);
    } catch (error) {
      state.stale = true;
      wireLog.warn('context-wire commit failed; the session degrades to the legacy conversion', {
        sessionId,
        entries: messages.length,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

/** Per-session wire state: the warm pipeline plus its identity bookkeeping. */
interface SessionWireState {
  readonly pipeline: ContextWirePipeline;
  /** Synthesized log position of the last applied commit. */
  seq: number;
  /** Occurrence counter per content key — repeats of identical messages get distinct ids. */
  readonly keyCounts: Map<string, number>;
  /** Source wall-clock per entry id (merged/derived records have none). */
  readonly timestamps: Map<string, number | undefined>;
  readonly sourceIndexes: Map<string, number>;
  messageIndex: number;
  stale: boolean;
}

/** Wire kind of a canonical-history entry: NOT `mcode.*` (that is control). */
const CONTEXT_WIRE_ENTRY_KIND = 'session.message';

/**
 * Builds the wire entry of one canonical message. The id is CONTENT-ADDRESSED
 * (`session.message#<sha16 of the message JSON>`): the pipeline's memo and
 * segment cache rest on the frozen-entry guarantee (an entryId never maps to
 * different content), and a canonical message is immutable once committed.
 * Identical repeats (same JSON — same text within the same millisecond, for
 * example) disambiguate by occurrence order (`#<digest>#2`), recomputed
 * identically on every reset+replay of the same sequence.
 */
function entryOf(
  state: SessionWireState,
  message: CanonicalHistoryMessage,
  ordinal: number,
  seq: number,
): Entry | undefined {
  const wireMessage = canonicalWireMessage(message);
  if (wireMessage === undefined) return undefined;
  const digest = createHash('sha256')
    .update(JSON.stringify(wireMessage), 'utf8')
    .digest('hex')
    .slice(0, 16);
  const seen = state.keyCounts.get(digest) ?? 0;
  state.keyCounts.set(digest, seen + 1);
  const entryId =
    seen === 0 ? `session.message#${digest}` : `session.message#${digest}#${seen + 1}`;
  state.timestamps.set(entryId, readTimestamp(message));
  state.sourceIndexes.set(entryId, state.messageIndex);
  // The canonical message is a persisted JSON shape; the projection only
  // decodes it locally (this synthesized commit is never stored), so the
  // backend's strict JSON narrowing is satisfied by construction.
  return {
    id: entryId,
    kind: CONTEXT_WIRE_ENTRY_KIND,
    payload: {
      model: [wireMessage],
      ...(Reflect.get(message, 'role') === 'custom' ? {
        context: { producer: String(Reflect.get(message, 'customType')), form: 'notice', scope: 'session' },
      } : {}),
    } as unknown as WirePayloadJson,
    seq: seq as Seq,
    ordinal,
  };
}

interface MinimalCompactionSummaryLike {
  readonly role: 'compactionSummary';
  readonly summary: string;
}

/** Backend JSON shape of a wire entry payload (`Entry['payload']`). */
type WirePayloadJson = Entry['payload'];

/**
 * Projects one canonical message onto the wire payload's decoded vocabulary
 * (convert-to-llm `decodeEntryPayload` reads `model: [message]` with pi-shaped
 * roles). Only the provider-relevant fields travel — the fold's byte
 * accounting then measures the real payload, not pi bookkeeping. Returns
 * `undefined` for messages with no provider projection.
 */
function canonicalWireMessage(
  message: CanonicalHistoryMessage,
): Record<string, unknown> | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const role = Reflect.get(message, 'role');
  // Native prompt sections travel through the Pi transcript, never as wire user text.
  if (role === 'system') return undefined;
  if (role === 'compactionSummary') {
    // The legacy compaction summary rides as user text (the same role the
    // legacy provider payload gives it).
    const summary = Reflect.get(message, 'summary');
    return {
      role: 'user',
      content: [{ type: 'text', text: typeof summary === 'string' ? summary : '' }],
    };
  }
  const content = Reflect.get(message, 'content');
  const base: Record<string, unknown> = {
    role,
    timestamp: readTimestamp(message),
  };
  if (role === 'user') {
    const hostMetadata = Reflect.get(message, 'hostMetadata');
    if (hostMetadata !== undefined) base.hostMetadata = hostMetadata;
  }
  if (role === 'assistant') {
    base.content = content;
    return base;
  }
  if (role === 'toolResult') {
    base.content = content;
    const toolCallId = Reflect.get(message, 'toolCallId');
    const toolName = Reflect.get(message, 'toolName');
    const isError = Reflect.get(message, 'isError');
    if (typeof toolCallId === 'string') base.toolCallId = toolCallId;
    if (typeof toolName === 'string') base.toolName = toolName;
    if (isError === true) base.isError = true;
    return base;
  }
  if (role === 'custom') {
    // W1-C/В3: a durable custom marker (runaway-guard and cadence reminders)
    // renders on the wire as its USER-record projection — the same mapping
    // the legacy conversion applies to `role:'custom'` messages — while the
    // durable store keeps the marker custom. The decode vocabulary has no
    // `customType`-less custom form, so passing the raw role through would
    // make the entry undecodable and silently drop the marker from the
    // provider payload. Canonical session.message entries keep their entire
    // text in log order: an old reminder must precede the activity settling
    // it, rather than returning at the end of every subsequent request.
    base.role = 'user';
  }
  base.content = content;
  return base;
}

function readTimestamp(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const timestamp = Reflect.get(message, 'timestamp');
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Maps the compiled wire records onto the runner's structural record port. */
function mappedRecords(
  entries: readonly WireEntry[],
  timestamps: ReadonlyMap<string, number | undefined>,
  sourceIndexes: ReadonlyMap<string, number>,
): ContextWireRecord[] {
  const records: ContextWireRecord[] = [];
  for (const entry of entries) {
    const text = recordText(entry.content);
    const timestamp = timestamps.get(entry.entryId);
    const indexes = (entry.sourceEntryIds ?? [entry.entryId]).map((id) => sourceIndexes.get(id));
    const stamp = {
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(indexes.every((index) => index !== undefined)
        ? { sourceIndexes: indexes as number[] }
        : {}),
    };
    // Wave-0 item 0.5: the residency overlay's structured image blocks ride
    // the mapped entry's content; the hydration layer interleaves them with
    // the text at the marker positions.
    const images = recordImages(entry.content);
    if (entry.kind === 'toolResult') {
      records.push({
        role: 'toolResult',
        text,
        ...(images !== undefined ? { images } : {}),
        toolCallId: entry.toolCallId ?? '',
        toolName: entry.toolName ?? '',
        isError: entry.isError === true,
        ...stamp,
      });
      continue;
    }
    const role = entry.role ?? 'user';
    if (role === 'assistant') {
      const toolCalls = (Array.isArray(entry.content) ? entry.content : [])
        .filter((block) => block.type === 'toolCall')
        .map((block) => ({
          id: String(block['id'] ?? ''),
          name: String(block['name'] ?? ''),
          arguments: typeof block['arguments'] === 'string' ? block['arguments'] : '',
        }));
      records.push({
        role: 'assistant',
        text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...stamp,
      });
      continue;
    }
    records.push({
      role: role === 'system' ? 'system' : 'user',
      text,
      ...(images !== undefined ? { images } : {}),
      ...stamp,
    });
  }
  return records;
}

/** Structured resident image blocks of a mapped record (`undefined`: none). */
function recordImages(content: WireEntry['content']): ContextWireRecord['images'] | undefined {
  if (content === undefined || typeof content === 'string') return undefined;
  const images = content
    .filter(
      (block) =>
        block.type === 'image' &&
        typeof block['data'] === 'string' &&
        typeof block['mimeType'] === 'string',
    )
    .map((block) => ({
      data: String(block['data']),
      mimeType: String(block['mimeType']),
    }));
  return images.length > 0 ? images : undefined;
}

/** Text of a wire record: its text blocks joined (images are placeholders already). */
function recordText(content: WireEntry['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => String(block['text'] ?? ''))
    .join('\n\n');
}

/**
 * True when the page's decoded payload carries an OFFLOADED image reference
 * (wave 2): such a page renders the read-again stub when it is not resident,
 * while inline-data pages keep the placeholder baseline.
 */
function pageHasOffloadedImage(page: Entry): boolean {
  if (page.kind !== 'session.message') return false;
  const decoded = decodeEntryPayload(page.kind, page.payload);
  const message = decoded.messages[0];
  if (message === undefined) return false;
  return message.parts.some((part) => part.type === 'image' && part.ref !== undefined);
}
