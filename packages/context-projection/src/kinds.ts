// Reserved entry kinds of the context projection.
//
// The durable log is kind-agnostic: `Entry.kind` is an application-defined
// discriminator. The projection applies one filter rule and three control
// interpretations on top of that open set:
//
//   - every kind prefixed with `mcode.` is an audit/control entry: it advances
//     the fold position but NEVER becomes an LLM-visible segment;
//   - `mcode.compaction` and `mcode.context_edit` carry payload that rewrites
//     the derived view (compaction cut / per-target edits); the fold applies
//     them through the same single `foldEntry` step as every other kind, so
//     incremental application stays identical to a full rebuild;
//   - `mcode.usage` accumulates into the persisted usage fold without ever
//     touching the LLM-visible window.
//
// All other kinds are LLM context: one segment per entry, in log order.

/** Prefix of every audit/control kind; such entries never enter the LLM context. */
export const CONTROL_KIND_PREFIX = 'mcode.';

/** Control entry that replaces an older context span with a summary. */
export const COMPACTION_KIND = 'mcode.compaction';

/** Control entry that rewrites (prunes) the current derived context. */
export const CONTEXT_EDIT_KIND = 'mcode.context_edit';

/** Control entry recording model-attributed usage that never enters LLM context. */
export const USAGE_KIND = 'mcode.usage';

/**
 * The full frozen pi-SystemMessage a checkpoint may freeze (V-C09, pin
 * `CompactionEntry.systemMessage`: "Complete prompt and tool state at this
 * compaction boundary"). The shape is the pi-ai `SystemMessage` JSON: `role`
 * `"system"`, `content` a string or text blocks, optional named `sections`
 * (`null` removes), complete `toolsAdded` declarations, and the wall-clock
 * `timestamp`. Declared locally (like every payload type here) so the
 * projection keeps importing nothing but the backend contract types; the
 * compaction core owns the writer (`@mavis/context-compaction`
 * `frozen-system.ts`) and the two shapes are pinned equal by the
 * cross-package checkpoint test.
 */
export interface FrozenCompactionSystemMessage {
	readonly role: 'system';
	readonly content: string | readonly { readonly type: 'text'; readonly text: string }[];
	readonly sections?: Readonly<Record<string, string | null>>;
	readonly toolsAdded?: readonly { readonly name: string; readonly [field: string]: unknown }[];
	readonly toolsRemoved?: readonly { readonly name: string; readonly [field: string]: unknown }[];
	readonly timestamp: number;
}

/** Structural guard of {@link FrozenCompactionSystemMessage} (JSON-level, tolerant). */
export function isFrozenCompactionSystemMessage(value: unknown): value is FrozenCompactionSystemMessage {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.role !== undefined && record.role !== 'system') return false;
	const { content } = record;
	if (typeof content !== 'string') {
		if (!Array.isArray(content)) return false;
		for (const part of content) {
			if (typeof part !== 'object' || part === null) return false;
			if ((part as { type?: unknown }).type !== 'text') return false;
			if (typeof (part as { text?: unknown }).text !== 'string') return false;
		}
	}
	if (record.sections !== undefined) {
		if (typeof record.sections !== 'object' || record.sections === null || Array.isArray(record.sections)) {
			return false;
		}
		for (const section of Object.values(record.sections as Record<string, unknown>)) {
			if (typeof section !== 'string' && section !== null) return false;
		}
	}
	for (const list of [record.toolsAdded, record.toolsRemoved]) {
		if (list === undefined) continue;
		if (!Array.isArray(list)) return false;
		for (const item of list) {
			if (typeof item !== 'object' || item === null) return false;
			if (typeof (item as { name?: unknown }).name !== 'string') return false;
		}
	}
	if (record.timestamp !== undefined && (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp))) {
		return false;
	}
	return true;
}

/** Payload of a {@link COMPACTION_KIND} entry. */
export interface CompactionPayload {
	/** Human- or model-readable summary standing in for the dropped prefix. */
	readonly summary: string;
	/**
	 * Entry id of the first entry still kept as a segment after the cut;
	 * `null` is pi's retain-none checkpoint (the cut drops every segment).
	 * pi never persists the null on disk — `appendCompaction` substitutes the
	 * compaction entry's OWN id (`firstKeptEntryId ?? id`,
	 * coding-agent session-manager) — so the decoder normalizes that
	 * self-reference to `null` too: both spellings mean "keep nothing".
	 */
	readonly firstKeptEntryId: string | null;
	/**
	 * The frozen prompt state at the boundary — legacy prompt text
	 * (`string`), retain-none (`null`), or the V-C09 full frozen
	 * SystemMessage (object). The FOLD never reads it (it is the compaction
	 * core's replay baseline, `convert-to-llm` transcript fold), so an
	 * ABSENT field stays legal; a PRESENT value of any other shape is the
	 * same writer-contract breach a corrupt summary is.
	 */
	readonly systemMessage?: string | null | FrozenCompactionSystemMessage;
}

/**
 * The omission variant of a {@link CONTEXT_EDIT_KIND} payload — the format
 * `@mavis/context-compaction` writes (`createOmissionEntryDraft`, the
 * overflow-recovery retraction). An omission HIDES its targets from the
 * derived context; targets that are not current segments (already cut by a
 * compaction, or never projected) stay hidden and do not raise.
 */
export interface OmissionEditPayload {
	readonly action: 'omission';
	/** Ids of the entries the projection must hide. */
	readonly targetIds: readonly string[];
	/** Human-readable cause (the overflow error, for example). Unused by the fold. */
	readonly reason?: unknown;
	/** Wall-clock stamp of the omission. Unused by the fold. */
	readonly createdAtMs?: unknown;
}

/**
 * The strict pruning variant of a {@link CONTEXT_EDIT_KIND} payload (the
 * local `pi-context-edit` shape). Unknown ids REJECT the entry — unlike the
 * omission variant, a strict prune asserts exact knowledge of the window.
 */
export interface PruneEditPayload {
	/** Entry ids to drop from the current derived segments. Unknown ids are rejected. */
	readonly removedEntryIds: readonly string[];
}

/**
 * The pi replacement variant of a {@link CONTEXT_EDIT_KIND} payload — the
 * pinned `ContextEditEntry` shape (`targetId`/`replacement`,
 * coding-agent session-manager). One append-only edit of ONE earlier entry's
 * contribution: `replacement: null` omits the target from model context,
 * `{ content }` replaces only its content. When several edits target the same
 * entry, the NEWEST edit wins (both pi projectors agree: the session-manager
 * `edits` map overwrites per target; durable `harness/context.ts` keeps "per
 * target, the newest edit in the range wins").
 */
export interface ReplacementEditPayload {
	/** Id of the edited entry; must be a current window member or the edit is inert. */
	readonly targetId: string;
	/** `null` omits the target; `{ content }` replaces its model-visible content. */
	readonly replacement: { readonly content: string | readonly unknown[] } | null;
}

/**
 * Payload of a {@link CONTEXT_EDIT_KIND} entry: the pi replacement/omission
 * variant ({@link ReplacementEditPayload}, the pinned 1.3 writer format), the
 * cross-package omission format ({@link OmissionEditPayload}, what
 * `@mavis/context-compaction` writes) or the local strict-prune format
 * ({@link PruneEditPayload}). `asContextEditPayload` throws on any other
 * shape — an unknown variant is a contract breach, never silently ignored.
 */
export type ContextEditPayload = OmissionEditPayload | PruneEditPayload | ReplacementEditPayload;

/**
 * Model-attributed usage recorded outside the LLM context — the pinned
 * `UsageEntry` shape (coding-agent session-manager: "Append model-attributed
 * usage that does not participate in LLM context"). Structurally identical to
 * pi's `Usage`; declared locally so this package keeps importing nothing but
 * the backend contract types.
 */
export interface UsagePayload {
	/** Usage category, e.g. `context`, `cache_warm`, `summary`. Writer-defined. */
	readonly kind: string;
	/** Provider id the spend is attributed to. */
	readonly provider: string;
	/** Model id the spend is attributed to. */
	readonly model: string;
	/** Token/cost counters of the recorded call. */
	readonly usage: UsageDelta;
	/** Optional human-readable qualifier; the fold does not accumulate it. */
	readonly note?: string;
}

/**
 * One usage record's counters (pi `Usage`): required core counters plus the
 * optional splits providers may omit (`cacheWrite1h`, `reasoning`).
 */
export interface UsageDelta {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheWrite1h?: number;
	readonly reasoning?: number;
	readonly totalTokens: number;
	readonly cost: UsageCost;
}

/** Cost breakdown of one usage record (pi `Usage.cost`). */
export interface UsageCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/** Whether `kind` marks an audit/control entry that must stay out of the LLM context. */
export function isControlKind(kind: string): boolean {
	return kind.startsWith(CONTROL_KIND_PREFIX);
}

/** Narrows an unknown entry payload to a {@link CompactionPayload}; throws when malformed. */
export function asCompactionPayload(payload: unknown, entryId: string): CompactionPayload {
	if (typeof payload !== 'object' || payload === null) {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload must be an object`);
	}
	const { summary, firstKeptEntryId, systemMessage } = payload as Record<string, unknown>;
	if (typeof summary !== 'string') {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload.summary must be a string`);
	}
	// `null` is pi's retain-none checkpoint (the cut drops every segment). pi
	// never persists the null on disk — `appendCompaction` substitutes the
	// compaction entry's OWN id (`firstKeptEntryId ?? id`, coding-agent
	// session-manager) — so BOTH spellings mean "keep nothing"; the fold
	// (which owns the entry's id) normalizes the self-reference, while this
	// decoder only validates the shape.
	if (firstKeptEntryId !== null && (typeof firstKeptEntryId !== 'string' || firstKeptEntryId.length === 0)) {
		throw new TypeError(
			`mcode.compaction entry ${entryId}: payload.firstKeptEntryId must be a non-empty string or null`,
		);
	}
	// The fold never reads `systemMessage` (it is the compaction core's frozen
	// prompt, not the projection's), so an ABSENT field stays legal — this
	// package's declared payload shape treats it as optional. A PRESENT but
	// corrupt value, though, is the same writer-contract breach a corrupt
	// summary is: the stricter compaction parsers treat such a checkpoint as
	// malformed (audit noise), so accepting it here would let a record one
	// consumer rejected apply a cut in another. Legal spellings: legacy prompt
	// text (`string`), retain-none (`null`), and the V-C09 full frozen
	// SystemMessage (object — shape-checked here, rendered by the compaction
	// core's readers).
	if (
		systemMessage !== undefined &&
		typeof systemMessage !== 'string' &&
		systemMessage !== null &&
		!isFrozenCompactionSystemMessage(systemMessage)
	) {
		throw new TypeError(
			`mcode.compaction entry ${entryId}: payload.systemMessage must be a string, null, or a frozen system message object`,
		);
	}
	return {
		summary,
		firstKeptEntryId: firstKeptEntryId as string | null,
		...(systemMessage !== undefined ? { systemMessage: systemMessage as CompactionPayload['systemMessage'] } : {}),
	};
}

/** Narrows an unknown entry payload to a {@link ContextEditPayload}; throws when malformed or of an unknown variant. */
export function asContextEditPayload(payload: unknown, entryId: string): ContextEditPayload {
	if (typeof payload !== 'object' || payload === null) {
		throw new TypeError(`mcode.context_edit entry ${entryId}: payload must be an object`);
	}
	const record = payload as Record<string, unknown>;
	// Omission variant (the format `@mavis/context-compaction` writes). Checked
	// first: a payload carrying several variants is read as an omission — never
	// as a strict prune (which would REJECT unknown ids).
	if (record.action === 'omission') {
		const { targetIds } = record;
		if (!Array.isArray(targetIds) || targetIds.some((id) => typeof id !== 'string')) {
			throw new TypeError(`mcode.context_edit entry ${entryId}: payload.targetIds must be a string array`);
		}
		return { action: 'omission', targetIds };
	}
	// pi replacement variant (the pinned 1.3 writer format): `targetId` +
	// `replacement` (null or `{ content }`). Recognized before the legacy
	// strict prune so a mixed payload keeps the pi meaning.
	if (record.targetId !== undefined) {
		if (typeof record.targetId !== 'string' || record.targetId.length === 0) {
			throw new TypeError(`mcode.context_edit entry ${entryId}: payload.targetId must be a non-empty string`);
		}
		if (!('replacement' in record) || record.replacement === undefined) {
			throw new TypeError(
				`mcode.context_edit entry ${entryId}: payload.replacement must be present — null to omit, { content } to replace`,
			);
		}
		const { replacement } = record;
		if (replacement === null) return { targetId: record.targetId, replacement: null };
		if (typeof replacement !== 'object' || !('content' in replacement)) {
			throw new TypeError(
				`mcode.context_edit entry ${entryId}: payload.replacement must be null or an object carrying content`,
			);
		}
		const { content } = replacement as Record<string, unknown>;
		if (typeof content !== 'string' && !Array.isArray(content)) {
			throw new TypeError(
				`mcode.context_edit entry ${entryId}: payload.replacement.content must be a string or an array`,
			);
		}
		return { targetId: record.targetId, replacement: { content } };
	}
	// Strict prune variant (the local `pi-context-edit` shape).
	if (record.removedEntryIds !== undefined) {
		if (!Array.isArray(record.removedEntryIds) || record.removedEntryIds.some((id) => typeof id !== 'string')) {
			throw new TypeError(`mcode.context_edit entry ${entryId}: payload.removedEntryIds must be a string array`);
		}
		return { removedEntryIds: record.removedEntryIds };
	}
	throw new TypeError(
		`mcode.context_edit entry ${entryId}: unknown payload variant — expected ` +
			`{targetId, replacement}, {action:"omission", targetIds:[...]} or {removedEntryIds:[...]}`,
	);
}

/** Narrows an unknown entry payload to a {@link UsagePayload}; throws when malformed. */
export function asUsagePayload(payload: unknown, entryId: string): UsagePayload {
	if (typeof payload !== 'object' || payload === null) {
		throw new TypeError(`mcode.usage entry ${entryId}: payload must be an object`);
	}
	const record = payload as Record<string, unknown>;
	const { kind, provider, model, usage, note } = record;
	if (typeof kind !== 'string' || kind.length === 0) {
		throw new TypeError(`mcode.usage entry ${entryId}: payload.kind must be a non-empty string`);
	}
	if (typeof provider !== 'string' || provider.length === 0) {
		throw new TypeError(`mcode.usage entry ${entryId}: payload.provider must be a non-empty string`);
	}
	if (typeof model !== 'string' || model.length === 0) {
		throw new TypeError(`mcode.usage entry ${entryId}: payload.model must be a non-empty string`);
	}
	if (typeof usage !== 'object' || usage === null) {
		throw new TypeError(`mcode.usage entry ${entryId}: payload.usage must be an object`);
	}
	const delta = usage as Record<string, unknown>;
	const { cost, cacheWrite1h, reasoning } = delta;
	const required: ReadonlyArray<[string, unknown]> = [
		['input', delta.input],
		['output', delta.output],
		['cacheRead', delta.cacheRead],
		['cacheWrite', delta.cacheWrite],
		['totalTokens', delta.totalTokens],
	];
	for (const [field, value] of required) {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new TypeError(`mcode.usage entry ${entryId}: payload.usage.${field} must be a finite number`);
		}
	}
	for (const [field, value] of [
		['cacheWrite1h', cacheWrite1h],
		['reasoning', reasoning],
	] as const) {
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
			throw new TypeError(`mcode.usage entry ${entryId}: payload.usage.${field} must be a finite number when present`);
		}
	}
	if (typeof cost !== 'object' || cost === null) {
		throw new TypeError(`mcode.usage entry ${entryId}: payload.usage.cost must be an object`);
	}
	const costRecord = cost as Record<string, unknown>;
	for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
		const value = costRecord[field];
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new TypeError(`mcode.usage entry ${entryId}: payload.usage.cost.${field} must be a finite number`);
		}
	}
	if (note !== undefined && typeof note !== 'string') {
		throw new TypeError(`mcode.usage entry ${entryId}: payload.note must be a string when present`);
	}
	return {
		kind,
		provider,
		model,
		usage: {
			input: delta.input as number,
			output: delta.output as number,
			cacheRead: delta.cacheRead as number,
			cacheWrite: delta.cacheWrite as number,
			totalTokens: delta.totalTokens as number,
			...(cacheWrite1h !== undefined ? { cacheWrite1h: cacheWrite1h as number } : {}),
			...(reasoning !== undefined ? { reasoning: reasoning as number } : {}),
			cost: {
				input: costRecord.input as number,
				output: costRecord.output as number,
				cacheRead: costRecord.cacheRead as number,
				cacheWrite: costRecord.cacheWrite as number,
				total: costRecord.total as number,
			},
		},
		...(note !== undefined ? { note } : {}),
	};
}
