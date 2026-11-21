/**
 * Shared contract types of the context-compaction package.
 *
 * The package is a semantic port of the pi v1.3 compaction core (see the
 * package README): a pure module that decides WHERE a context window may be
 * cut, produces a structured summary through an injected {@link Summarizer},
 * and records the result as a durable, append-only entry in the session log.
 *
 * The durable shapes declared here (`DurableEntryDraft`, the `mcode.*` entry
 * kinds) are structurally compatible with `EntryDraft` of
 * `@mavis/durable-backend-sqlite-zstd`, the same way the storage worker pins
 * its own copy of the wave contract: the package compiles and tests
 * standalone, without importing the SQLite backend at runtime.
 *
 * @module
 */

// ============================================================================
// Messages
// ============================================================================

/** A piece of user/assistant content. Images are estimated, not decoded. */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** A placeholder block for an image; token estimation charges a flat char cost. */
export interface ImageBlock {
  readonly type: 'image';
}

/**
 * A reasoning block. It OCCUPIES context (token estimation counts it) but is
 * EXCLUDED from summarizer serialization — replayed thinking is rarely part of
 * the model's live context, and including it can make the summary request
 * larger than the window it summarizes.
 */
export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
}

/** A tool invocation emitted by the assistant. */
export interface ToolCallBlock {
  readonly type: 'toolCall';
  readonly name: string;
  readonly arguments: unknown;
}

export type UserContent = string | readonly (TextBlock | ImageBlock)[];

export interface UserMessage {
  readonly role: 'user';
  readonly content: UserContent;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: readonly (TextBlock | ThinkingBlock | ToolCallBlock)[];
  /**
   * Provider-reported usage of the turn that produced this message. The last
   * valid usage anchors the token estimate of the whole window (see
   * `estimateContextTokens`); `totalTokens` wins, the component fields are the
   * fallback.
   */
  readonly usage?: ProviderUsage;
  /** `aborted`/`error` messages carry no trustworthy usage anchor. */
  readonly stopReason?: 'stop' | 'length' | 'aborted' | 'error' | string;
}

export interface ToolResultMessage {
  readonly role: 'toolResult';
  readonly content: readonly (TextBlock | ImageBlock)[];
  /** Id of the tool call this result answers, when known. */
  readonly toolCallId?: string;
}

/**
 * An application-defined message. It counts as a turn boundary (the cut point
 * logic may cut at it), mirroring pi's `custom` role.
 */
export interface CustomMessage {
  readonly role: 'custom';
  readonly customType: string;
  readonly text?: string;
}

export type CompactionMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

/** Provider usage subset the estimator understands. All fields are optional. */
export interface ProviderUsage {
  readonly totalTokens?: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

// ============================================================================
// Durable entries
// ============================================================================

/**
 * One record of the append-only session log. Structurally compatible with
 * `EntryDraft` of `@mavis/durable-backend-sqlite-zstd` (`id`/`kind`/`payload`
 * with optional `parentId`); declared locally so this package never depends
 * on the backend at compile time or runtime.
 */
export interface DurableEntryDraft {
  /** Stable application identity, unique across the whole log. */
  readonly id: string;
  /** Log position of the predecessor entry; `null`/`undefined` for the first. */
  readonly parentId?: string | null;
  /** Application-defined discriminator — one of the `mcode.*` kinds below. */
  readonly kind: string;
  /** JSON payload stored inside the batch frame. */
  readonly payload: unknown;
}

/** A stored log entry: draft content plus whatever position the backend stamped. */
export interface LogEntry extends DurableEntryDraft {
  readonly seq: number;
  readonly ordinal: number;
}

/** Entry kind carrying one conversation message; payload is a `CompactionMessage`. */
export const MESSAGE_ENTRY_KIND = 'mcode.message';

/** Entry kind carrying the frozen system prompt; payload is `{ text: string }`. */
export const SYSTEM_ENTRY_KIND = 'mcode.system';

/**
 * Entry kind of a compaction checkpoint: the summary, the first entry id that
 * survives it, and the system prompt frozen at compaction time. Appending it
 * never rewrites history — projection derives the short window, the original
 * entries stay in the log.
 */
export const COMPACTION_ENTRY_KIND = 'mcode.compaction';

/**
 * Entry kind of a context edit; `action: 'omission'` hides the target entries
 * from projection (for example a failed overflow-recovery attempt that reached
 * the log but must not be replayed into the model context).
 */
export const CONTEXT_EDIT_ENTRY_KIND = 'mcode.context_edit';

/**
 * Entry kind of model-attributed usage that never enters LLM context — the
 * mcode mirror of pi's standalone `usage` entries ("Append model-attributed
 * usage that does not participate in LLM context", coding-agent
 * session-manager). The projection folds it into the persisted billing fold
 * under BOTH axes (`provider/model` and the writer-defined category); the
 * payload shape is pinned equal to `@mavis/context-projection`'s strict
 * `UsagePayload` decoder (all counters required — the draft factory
 * normalizes optional transport counters to `0`).
 */
export const USAGE_ENTRY_KIND = 'mcode.usage';

/**
 * Payload of a {@link USAGE_ENTRY_KIND} entry. Structurally identical to
 * `@mavis/context-projection`'s `UsagePayload` (the two are pinned equal by
 * the cross-package usage test); declared locally so this package keeps its
 * zero-dependency layout.
 */
export interface UsageEntryPayload {
	/** Usage category, writer-defined (`summary` for summarizer spend). */
	readonly kind: string;
	readonly provider: string;
	readonly model: string;
	/** Token/cost counters — the FULL shape, every field required. */
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly totalTokens: number;
		readonly cost: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly total: number;
		};
	};
	readonly note?: string;
}

/** File lists recorded in a checkpoint's `details` (pin `CompactionDetails`). */
export interface CompactionDetails {
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
}

/** Payload of a `mcode.compaction` entry. */
export interface CompactionEntryPayload {
  readonly summary: string;
  /** Id of the first entry (in log order) that stays visible after this compaction. */
  readonly firstKeptEntryId: string;
  /**
   * System prompt frozen at compaction time; replayed verbatim by projection.
   * Three spellings: the legacy prompt text (`string`), retain-none (`null`),
   * and the V-C09 FULL frozen pi-SystemMessage (content+sections+toolsAdded+
   * timestamp — see `frozen-system.ts`), which readers render through
   * `renderFrozenSystemText` for the prompt-text view.
   */
  readonly systemMessage: string | null | import('./frozen-system.js').FrozenSystemMessage;
  /** Whether the cut split a user turn (two summaries were merged). */
  readonly isSplitTurn: boolean;
  /** Estimated context tokens before the compaction. */
  readonly tokensBefore: number;
  /** Estimated context tokens the window occupies after the compaction. */
  readonly estimatedTokensAfter: number;
  readonly createdAtMs: number;
  /**
   * File lists of the summarized range, folded across compactions (pin
   * `CompactionEntry.details`): an iterative compaction re-baselines from the
   * previous checkpoint's lists.
   */
  readonly details?: CompactionDetails;
}

/** Payload of a `mcode.context_edit` omission entry. */
export interface ContextEditOmissionPayload {
  readonly action: 'omission';
  /** Ids of the entries the projection must hide. */
  readonly targetIds: readonly string[];
  /** Human-readable cause, e.g. the overflow error message. */
  readonly reason: string;
  readonly createdAtMs: number;
}

// ============================================================================
// Projection
// ============================================================================

/**
 * One entry as the compaction algorithms see it: the durable entry plus the
 * context messages it currently contributes. `contextMessages` is empty for
 * omitted entries and pure metadata; compaction entries contribute their
 * summary as a single user message.
 */
export interface ProjectedEntry {
  readonly id: string;
  /** True when this projected entry IS a compaction checkpoint. */
  readonly isCompaction: boolean;
  /**
   * Whether the SOURCE entry is a well-formed message entry — pi's
   * `isIntrinsicallyVisible` (coding-agent compaction.ts:822: `type !==
   * "context_edit" && sessionEntryToContextMessages(sourceEntry).length > 0`):
   * it WOULD contribute context messages when no omission applies. Read
   * together with `contextMessages`: intrinsically visible + empty
   * `contextMessages` = OMITTED (a live window member hidden by a recovery
   * omission); not intrinsically visible = audit/control/context-edit
   * bookkeeping that never enters context under any edits.
   */
  readonly intrinsicallyVisible: boolean;
  /**
   * Role of the source message payload (`user`/`assistant`/`toolResult`/
   * `custom`); `null` for every non-message entry. The recovery-omission
   * suffix rule needs it to recognize an omitted ASSISTANT attempt (pin
   * compaction.ts:836-839) even though the entry's `contextMessages` are
   * hidden by the omission.
   */
  readonly sourceRole: CompactionMessage['role'] | null;
  readonly contextMessages: readonly CompactionMessage[];
}

/** Result of projecting the raw log into the model-visible window. */
export interface ProjectedContext {
  /** Frozen system prompt (`mcode.system` / last compaction), `null` when none. */
  readonly systemMessage: string | null;
  /** Conversation messages in order, omissions and compactions applied. */
  readonly messages: readonly CompactionMessage[];
  /** Per-entry projection, aligned 1:1 with the raw input entries. */
  readonly entries: readonly ProjectedEntry[];
}

// ============================================================================
// Cut points
// ============================================================================

/** Result of `findCutPoint`. */
export interface CutPointResult {
  /** Index of the first projected entry to keep. */
  readonly firstKeptEntryIndex: number;
  /** Index of the user-like message that started the split turn, or `-1`. */
  readonly turnStartIndex: number;
  /** Whether the cut lands mid-turn (the turn prefix gets its own summary). */
  readonly isSplitTurn: boolean;
}

// ============================================================================
// Estimation and triggers
// ============================================================================

/** Usage-anchored estimate of a context window. */
export interface ContextUsageEstimate {
  /** Total estimated context tokens (anchor + trailing, or pure estimate). */
  readonly tokens: number;
  /** Tokens reported by the usage anchor itself. */
  readonly usageTokens: number;
  /** Estimated tokens of the messages after the anchor. */
  readonly trailingTokens: number;
  /** Index of the anchor message, `null` when no valid usage was found. */
  readonly usageAnchorIndex: number | null;
}

/** Which trigger axis fired. */
export type TriggerAxis = 'tokens' | 'bytes';

/** Compaction level a trigger evaluation selects. */
export type CompactionLevel = 'none' | 'background' | 'blocking';

/** One crossed threshold, reported by `evaluateTriggers`. */
export interface TriggerReason {
  readonly axis: TriggerAxis;
  /** Measured usage on this axis. */
  readonly usage: number;
  /** Budget of this axis. */
  readonly budget: number;
  /** `usage / budget`. */
  readonly ratio: number;
  /** The crossed threshold ratio (background or blocking). */
  readonly threshold: number;
}

export interface TriggerEvaluation {
  readonly level: CompactionLevel;
  readonly reasons: readonly TriggerReason[];
}

/** Budgets and thresholds of the double trigger (tokens AND bytes). */
export interface CompactionBudgets {
  /**
   * Context window in tokens; the primary trigger axis. `0` (or any
   * non-positive budget) DISABLES the axis — the trigger can never fire on
   * it — rather than treating the usage as always over budget.
   */
  readonly tokenBudget: number;
  /**
   * Byte budget of the session manifest (sum of serialized entry lengths);
   * when set, it triggers independently of the token axis. As with
   * `tokenBudget`, `0` disables the axis.
   */
  readonly byteBudget?: number;
  /** Background compaction starts at this usage ratio. Default 0.75. */
  readonly backgroundThresholdRatio?: number;
  /** Compaction becomes blocking at this usage ratio. Default 0.90. */
  readonly blockingThresholdRatio?: number;
}

// ============================================================================
// Compaction
// ============================================================================

/**
 * One summarizer call's answer: the summary text plus, OPTIONALLY, the
 * provider spend of exactly the call that produced it (`createModelSummarizer`
 * returns this form). A rejected/failed call throws instead — there is no
 * result and nothing to bill.
 */
export interface SummaryResult {
  readonly text: string;
  /**
   * Provider spend of THIS call attributed to the summarizer model; omitted
   * when the transport reports no usage (nothing is invented).
   */
  readonly usage?: SummaryUsageRecord;
}

/**
 * The summary backend, injected by the caller. Given one prompt string it
 * returns the summary text — either a bare `string` (plain summarizers:
 * tests, custom backends) or a {@link SummaryResult} carrying the call's
 * provider usage, which `compact()` mirrors into a `mcode.usage` entry (the
 * `summary` category). Keeping this a plain async function (instead of a
 * model/API client) makes the whole pipeline testable and provider-agnostic.
 */
/** Optional cache-preserving alternative to the serialized cold prompt. */
export interface SummaryForkTask {
  /** Abort means a blocking admission may use the explicit cold fallback. */
  readonly anchorWaitSignal?: AbortSignal;
  readonly coveredEntryIds: readonly string[];
  readonly instruction: string;
}
export type Summarizer = (prompt: string, fork?: SummaryForkTask) => Promise<string | SummaryResult>;

/**
 * Provider usage of one summary call, in the transport's own subset shape
 * (`SummaryResponse.usage`): every counter optional, cost optional — a
 * transport that reports no usage yields `undefined`.
 */
export interface SummaryUsageDelta {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly totalTokens?: number;
	readonly cost?: {
		readonly input?: number;
		readonly output?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
		readonly total?: number;
	};
}

/** One summary call's spend attributed to the summarizer model. */
export interface SummaryUsageRecord {
	/** Provider id of the summarizer model (`SummaryModel.provider`). */
	readonly provider: string;
	/** Model id of the summarizer model (`SummaryModel.modelId`). */
	readonly model: string;
	readonly usage: SummaryUsageDelta;
}

// ============================================================================
// Wave 3 (canon 05 §2.3/§2.6): the codex background scheme
// ============================================================================

/**
 * The attempt snapshot of the current log (canon §2.3): the durable truth the
 * attempt key is built from — the fold generation the plan would be built on
 * and the covered cut (the log head). The binding that serves a wave-1 event
 * log reports the REAL generation; the projection stand-in reports its own
 * replace-stamped counter with the same semantics (grows only on replace).
 */
export interface SchedulerAttemptSnapshot {
	readonly baseGeneration: number;
	/** The covered cut of the snapshot (the log head in the binding's coordinates). */
	readonly cut: string;
}

/**
 * The attempt identity a job's append carries back to the binding (canon §2.3
 * staleness): the append refuses (a `stale` class failure, one immediate
 * re-plan) when the binding's CURRENT generation or summarizer identity has
 * moved since the snapshot the plan was built on — the result is discarded,
 * never committed over a replaced history or a swapped model/prompt.
 */
export interface SchedulerAppendAttempt {
  /** Durable receipt links restored with a paid READY candidate. */
  readonly requestIds?: readonly string[];
	readonly generation: number;
	/** The summarizer identity (`model|promptHash`) the summary was produced under. */
	readonly identity: string;
}

/**
 * Wave 3 (canon §2.6, item 3.3): the unified measure of the projected window —
 * ONE function's output for the triggers, the admission barrier and the status
 * surface. `estimated` marks the post-compaction window before the first
 * provider answer of the new generation (no valid usage anchor → the number is
 * the pure chars/4 estimate, never a provider-anchored total).
 */
export interface CompactionMeasure {
	/** Tokens of the projected window (usage-anchored, or the pure estimate). */
	readonly tokens: number;
	/** Σ serialized bytes of the window (the second trigger axis). */
	readonly bytes: number;
	/** `true` when `tokens` is the pure estimate (no valid usage anchor). */
	readonly estimated: boolean;
	/** The anchoring provider usage total, when the anchor is valid. */
	readonly usageAnchorTokens?: number;
	/** The budgets/ratios the triggers evaluate this measure against. */
	readonly tokenBudget: number;
	readonly byteBudget?: number;
	readonly backgroundThresholdRatio: number;
	readonly blockingThresholdRatio: number;
}

export interface CompactOptions {
  /** Manual request: allow a short history to cut before its last safe message. */
  readonly force?: boolean;
  /** Raw session log entries, oldest first. */
  readonly entries: readonly LogEntry[];
  readonly summarizer: Summarizer;
  /**
   * Wave 3 (canon 05 §2.2/§2.4, item 3.2): the deterministic fallback summary
   * producer (the cline `basic` shape — tool activity + last assistant texts).
   * When given, BOTH summaries (history and split-turn prefix) are produced by
   * it — no provider call is made and no usage record is drafted. This is the
   * breaker-open path: the blocking edge cuts the window without another call
   * to the summarizer that just opened the breaker.
   */
  readonly deterministicSummary?: import('./deterministic-summary.js').DeterministicSummaryProducer;
  /**
   * Recent-context budget for the cut point. Default 20000. When
   * `tokenBudget` is also given, the effective value is clamped so the
   * post-compaction window fits inside 90% of the budget.
   */
  readonly keepRecentTokens?: number;
  /**
   * Per-model resolved settings (settings.ts): `keepRecentTokens` is used when
   * the explicit option is absent. `reserveTokens` is NOT consumed here — it
   * is a trigger/retained-window policy input, never a summary output limit
   * (the pin's output-limit fix, commit 6fcb48670).
   */
  readonly settings?: import('./settings.js').ResolvedCompactionSettings;
  /**
   * Context window in tokens. Enables the ≤90% clamp of `keepRecentTokens`
   * and the `estimatedTokensAfter` computation of the outcome.
   */
  readonly tokenBudget?: number;
  /** Tokens the summary itself may occupy; the ≤90% clamp reserves this. Default 2048. */
  readonly summaryHeadroomTokens?: number;
  /**
   * System prompt to freeze into the compaction entry (legacy string form).
   * Default: the system message of the projected context.
   */
  readonly systemMessage?: string | null;
  /**
   * V-C09 full form: the complete frozen SystemMessage (content+sections+
   * toolsAdded+timestamp) of the compaction boundary. When given it WINS over
   * `systemMessage` and is recorded verbatim; readers of both spellings
   * render it to the same prompt text (`renderFrozenSystemText`).
   */
  readonly frozenSystemMessage?: import('./frozen-system.js').FrozenSystemMessage;
  /** Optional extra focus appended to the summarizer prompt. */
  readonly customInstructions?: string;
  /** Id of the produced compaction entry. Default: generated. */
  readonly entryId?: string;
  /** Clock for the payload timestamp. Default `Date.now`. */
  readonly now?: () => number;
}

export interface CompactionOutcome {
  /** Id of the compaction entry (`draft.id`). */
  readonly entryId: string;
  /** Durable draft ready for `appendBatch` — kind `mcode.compaction`. */
  readonly draft: DurableEntryDraft;
  /** Full summary text (split-turn already merged, file lists appended). */
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly isSplitTurn: boolean;
  readonly tokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly systemMessage: string | null | import('./frozen-system.js').FrozenSystemMessage;
  /** File lists recorded in the checkpoint `details` (read-only/modified). */
  readonly details: CompactionDetails;
  /**
   * Wave 3 (item 3.2): `true` when the summary came from the deterministic
   * fallback producer — the honest producer marker the durable commit and the
   * status surface report instead of claiming an LLM checkpoint.
   */
  readonly deterministic?: true;
  /**
   * Provider spend of THIS cycle's summarizer calls (history + turn prefix
   * combined, pin `combineUsage`), when the summarizer reports usage at all.
   * Omitted for plain `Summarizer`s — no spend is invented.
   */
  readonly summaryUsage?: SummaryUsageRecord;
  /**
   * Durable draft of the `mcode.usage` entry mirroring {@link summaryUsage}
   * under the `summary` category (pi's "Tools/summaries" shape (d) — our
   * declared writer mapping persists it as an explicit usage entry). Appended
   * by the scheduler in the SAME writer-gated batch as the checkpoint;
   * `undefined` when there is nothing to bill.
   */
  readonly usageDraft?: DurableEntryDraft;
}

// ============================================================================
// Control-plane priorities
// ============================================================================

/**
 * Control-plane priority of a commit/append, P0 (most urgent) through P4
 * (background). The background compaction scheduler appends its checkpoint at
 * P4 and yields the writer to everything below.
 */
export type ControlPlanePriority = 0 | 1 | 2 | 3 | 4;

/** Priority used by the background compaction scheduler. */
export const BACKGROUND_COMPACTION_PRIORITY: ControlPlanePriority = 4;
