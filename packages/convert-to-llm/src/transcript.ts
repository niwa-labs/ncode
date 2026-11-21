/**
 * The transcript layer (W03 part A): system messages and tool deltas in the
 * transcript, ported from pinned pi-ai `ai/src/utils/transcript.ts` +
 * `ai/src/utils/text.ts` (pin `48c8f3228`, vendored byte-identical at
 * `third_party/pi-mono/packages/ai/src/utils/transcript.ts`).
 *
 * Two halves, one owner (plan §4 rows "convert-to-llm/outbound normalizer"
 * and "system-reminder/turn_config.tools" — судьба: СЛИВАЕТСЯ here, no second
 * full-history pass anywhere else):
 *
 * 1. PURE replay contracts over decoded messages — pin-exact semantics,
 *    parity-pinned against the pinned implementation itself by
 *    `test/unit/transcript-parity.test.ts` (the W03-T "not-our-projector"
 *    oracle rule): a leading system message is the system prompt, later
 *    system messages change it (`content` appends, `sections` patch by name
 *    with `null` removal, `toolsAdded`/`toolsRemoved` change the tool set),
 *    and replaying every system message in order yields the current prompt
 *    and tools.
 *
 * 2. An incremental fold over durable entries (`foldTranscriptEntry`) — the
 *    same single-step discipline as `@mavis/context-projection`: the
 *    one-shot fold, the incremental application and the pure replay agree by
 *    construction, and a same-head lookup answers from the folded state
 *    without re-walking the window. The fold additionally applies the
 *    compaction checkpoint semantics of pi `buildContextEntries`
 *    (`session-manager.ts`): a checkpoint RE-BASELINES the system state, so
 *    pre-checkpoint system messages never resurrect dropped declarations
 *    ("no initial-system duplication").
 *
 * Provider placement of the replayed tools is NOT done here: the frozen
 * interface for the wire owner (W06) is {@link resolveTranscriptTools} with
 * `TranscriptToolSupport` — which tools ride the top-level request field and
 * how many leading system messages are already folded into it.
 */

import type { DurableEntry, JsonValue } from './types.js';
import { decodeEntryPayload, type DecodedMessage, type DecodedPart, type DecodedToolDeclaration, type DecodedToolReference } from './decode.js';

/**
 * The replayed/collapsed system message — the transcript-layer shape of
 * pi-ai `SystemMessage` after JSON at rest: `content` is rendered text, the
 * optional fields are present only when non-empty (pin key discipline).
 */
export interface TranscriptSystemMessage {
	readonly role: 'system';
	/** Base prompt (leading) or additional instructions (later); replayed parts join with a blank line. */
	readonly content: string;
	/** Named prompt sections rendered verbatim after `content`. */
	readonly sections?: Readonly<Record<string, string | null>>;
	/** Complete tool declarations available at this point. */
	readonly toolsAdded?: readonly DecodedToolDeclaration[];
	/** Tools that stop being available at this point. */
	readonly toolsRemoved?: readonly DecodedToolReference[];
	/** Unix milliseconds; the replayed message carries the FIRST source timestamp. */
	readonly timestamp: number;
}

/**
 * Any message of a transcript list. The replay helpers only read entries
 * whose `role` is `"system"`, so transcripts carrying other roles pass
 * without filtering (pin `TranscriptMessages`).
 */
export type TranscriptMessage = DecodedMessage | TranscriptSystemMessage | { readonly role: string };

/** A message of a collapsed transcript: the replayed system head or any original non-system message. */
export type CollapsedTranscriptMessage = TranscriptSystemMessage | DecodedMessage;

// ─────────────────────────────────────────────────────────────────────────────
// text.ts ports (pin `ai/src/utils/text.ts`) — exact semantics.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract and join text from message content (pin `contentText`): a string
 * passes through, text blocks join with `separator` (default one newline —
 * WITHIN one message; across messages the replay joins with a blank line).
 */
export function contentText(content: string | readonly DecodedPart[], separator = '\n'): string {
	if (typeof content === 'string') return content;
	return content
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join(separator);
}

/** The text of one transcript message's content, whatever shape it carries. */
function messageText(message: TranscriptMessage): string {
	const content: string | readonly DecodedPart[] = 'parts' in message && message.parts !== undefined
		? message.parts
		: typeof (message as TranscriptSystemMessage).content === 'string'
			? (message as TranscriptSystemMessage).content
			: '';
	return contentText(content);
}

function systemSections(message: TranscriptMessage): Readonly<Record<string, string | null>> | undefined {
	return 'sections' in message ? (message as { sections?: Readonly<Record<string, string | null>> }).sections : undefined;
}

function systemToolsAdded(message: TranscriptMessage): readonly DecodedToolDeclaration[] | undefined {
	return 'toolsAdded' in message
		? (message as { toolsAdded?: readonly DecodedToolDeclaration[] }).toolsAdded
		: undefined;
}

function systemToolsRemoved(message: TranscriptMessage): readonly DecodedToolReference[] | undefined {
	return 'toolsRemoved' in message
		? (message as { toolsRemoved?: readonly DecodedToolReference[] }).toolsRemoved
		: undefined;
}

function systemTimestamp(message: TranscriptMessage): number | undefined {
	return 'timestamp' in message ? (message as { timestamp?: number }).timestamp : undefined;
}

function isSystemMessage(message: TranscriptMessage): message is TranscriptMessage & { readonly role: 'system' } {
	return message.role === 'system';
}

/** Render a system message as a complete prompt: its content followed by its sections (pin `getSystemMessageText`). */
export function getSystemMessageText(message: TranscriptSystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * Render a later system message for APIs that accept system messages
 * mid-conversation (pin `renderSystemMessageUpdate`): section changes are
 * framed by name so the model can relate them to the leading prompt.
 * Request-time only; may change between versions.
 */
export function renderSystemMessageUpdate(message: TranscriptSystemMessage): string {
	const parts: string[] = [];
	const text = contentText(message.content);
	if (text.length > 0) parts.push(text);
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		parts.push(
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure replay contracts (pin `ai/src/utils/transcript.ts`) — exact semantics.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the leading system message for a prompt and tool set (pin
 * `createInitialSystemMessage`). Returns `undefined` when both are empty, so
 * an empty transcript stays empty. `timestamp` is 0: the constructor carries
 * no wall-clock stamp (writers stamp on commit).
 */
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: readonly DecodedToolDeclaration[] | undefined,
): TranscriptSystemMessage | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		role: 'system',
		content: systemPrompt ?? '',
		...(hasTools ? { toolsAdded: [...tools] } : {}),
		timestamp: 0,
	};
}

/**
 * Return the leading system message, if the transcript starts with one (pin
 * `getInitialSystemMessage` — identity, no rebuilding). The result is the
 * message object itself: a decoded entry message or an already-replayed
 * {@link TranscriptSystemMessage}; readers use the replay helpers, not the
 * concrete shape.
 */
export function getInitialSystemMessage<T extends TranscriptMessage>(
	messages: readonly T[],
): (TranscriptMessage & { readonly role: 'system' }) | undefined {
	const first = messages[0];
	return first !== undefined && isSystemMessage(first) ? first : undefined;
}

/** Drop the leading system message for APIs that carry the prompt outside the message list (pin `withoutInitialSystemMessage`). */
export function withoutInitialSystemMessage(messages: readonly DecodedMessage[]): DecodedMessage[] {
	return getInitialSystemMessage(messages) ? messages.slice(1) : [...messages];
}

/** Resolve the tools available after applying every transcript delta in order (pin `getCurrentTools`). */
export function getCurrentTools(messages: readonly TranscriptMessage[]): DecodedToolDeclaration[] {
	const tools = new Map<string, DecodedToolDeclaration>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of systemToolsRemoved(message) ?? []) tools.delete(tool.name);
		for (const tool of systemToolsAdded(message) ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the
 * current prompt and tools (pin `getCurrentSystemMessage`). Later `content`
 * is appended to the base prompt (blank-line join), `sections` are patched
 * by name (`null` removes), and tools are resolved with {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(messages: readonly TranscriptMessage[]): TranscriptSystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		timestamp ??= systemTimestamp(message);
		const text = messageText(message);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(systemSections(message) ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: 'system',
		content: content.join('\n\n'),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message (pin `getCurrentSystemPrompt`). */
export function getCurrentSystemPrompt(messages: readonly TranscriptMessage[]): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : '';
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages
 * (pin `collapseSystemMessages`): the replayed system message leads, and
 * every later system message is dropped.
 */
export function collapseSystemMessages(messages: readonly TranscriptMessage[]): CollapsedTranscriptMessage[] {
	const head = getCurrentSystemMessage(messages);
	const rest = messages.filter((message) => message.role !== 'system') as DecodedMessage[];
	return head ? [head, ...rest] : rest;
}

/** Keep later system messages in place when the model accepts them; otherwise collapse them (pin `resolveTranscript`). */
export function resolveTranscript(
	messages: readonly DecodedMessage[],
	supportsMidConvoSystemMessages: boolean | undefined,
): readonly (DecodedMessage | TranscriptSystemMessage)[] {
	return supportsMidConvoSystemMessages ? messages : collapseSystemMessages(messages);
}

/**
 * Strip executable and display-only fields from a tool before transcript
 * comparison or persistence (pin `toToolDeclaration`): the JSON round-trip
 * drops symbol keys and `undefined` fields and rebuilds the object with one
 * key order, so serialized comparisons are exact without a deep-equal
 * dependency.
 */
export function toToolDeclaration(tool: DecodedToolDeclaration): DecodedToolDeclaration {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as JsonValue,
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

/**
 * Whether two tools declare the same interface to the model (pin
 * `declarationsEqual`): both sides go through {@link toToolDeclaration}
 * first, then compare the serialized declarations byte for byte.
 */
export function declarationsEqual(left: DecodedToolDeclaration, right: DecodedToolDeclaration): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

/** Tool-state delta between two complete tool states (pin `ToolStateChanges`). */
export interface ToolStateChanges {
	toolsAdded: DecodedToolDeclaration[];
	toolsRemoved: DecodedToolReference[];
}

/**
 * Compare two complete tool states (pin `getToolStateChanges` — the primitive
 * the pi agent loop's `declareToolChanges` and durable `planSystemEntries`
 * build their `pi.system` delta entries with). A changed definition is a
 * removal followed by an addition.
 */
export function getToolStateChanges(
	previous: readonly DecodedToolDeclaration[],
	current: readonly DecodedToolDeclaration[],
): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	return {
		toolsAdded: current
			.filter((tool) => {
				const previousTool = previousTools.get(tool.name);
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter((tool) => {
				const currentTool = currentTools.get(tool.name);
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map((tool) => ({ name: tool.name })),
	};
}

/** Every definition referenced by transcript tool state, in first-declaration order (pin `getDeclaredTools`). */
export function getDeclaredTools(messages: readonly TranscriptMessage[]): DecodedToolDeclaration[] {
	const definitions = new Map<string, DecodedToolDeclaration>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of systemToolsAdded(message) ?? []) definitions.set(tool.name, tool);
	}
	return [...definitions.values()];
}

/**
 * Whether tool history contains a removal or same-name redeclaration that an
 * addition-only transport cannot replay (pin `hasNonAdditiveToolChanges`).
 */
export function hasNonAdditiveToolChanges(messages: readonly TranscriptMessage[]): boolean {
	return findLastNonAdditiveToolChange(messages.filter(isSystemMessage)) >= 0;
}

/**
 * Index of the last system message with a removal or same-name
 * redeclaration, or -1 (pin `findLastNonAdditiveToolChange`, private there).
 * A name declared before counts as a redeclaration even after its removal:
 * Kimi K3 ignores a removed tool that a later tool message declares again
 * (verified October 2026, pin comment).
 */
function findLastNonAdditiveToolChange(systemMessages: readonly TranscriptMessage[]): number {
	const declared = new Set<string>();
	let last = -1;
	for (let index = 0; index < systemMessages.length; index++) {
		const message = systemMessages[index];
		if (message === undefined) continue;
		if ((systemToolsRemoved(message)?.length ?? 0) > 0) last = index;
		for (const tool of systemToolsAdded(message) ?? []) {
			if (declared.has(tool.name)) last = index;
			declared.add(tool.name);
		}
	}
	return last;
}

/**
 * How a transport can express tool changes after the first request (pin
 * `TranscriptToolSupport`):
 *
 * - `"none"`: only the top-level tool list exists; it always holds the current tools.
 * - `"additions"`: tools can be added at a later message, but not removed or redefined.
 * - `"changes"`: every tool is declared in place; a later declaration under the
 *   same name replaces the earlier one; removals are announced as text.
 */
export type TranscriptToolSupport = 'none' | 'additions' | 'changes';

/** The split {@link resolveTranscriptTools} produces (pin `TranscriptTools`). */
export interface TranscriptTools {
	/** Tools sent in the top-level request field. */
	requestTools: DecodedToolDeclaration[];
	/**
	 * Number of leading system messages whose tool changes `requestTools`
	 * already holds. Every later system message carries its own tool changes
	 * in place.
	 */
	foldedSystemMessages: number;
}

/**
 * Split tool declarations between the top-level request field and in-place
 * changes (pin `resolveTranscriptTools` — THE frozen W06 wire interface).
 *
 * With `"changes"`, the top-level list stays empty and every system message,
 * including the leading one, declares its tools in place. With `"additions"`,
 * a removal or redefinition cannot be expressed in place, so the top-level
 * list becomes the tool state after the last such change; later additions
 * stay anchored, and the cached prefix is invalidated once per removal
 * instead of on every later addition. With `"none"`, the top-level list is
 * the current tool set.
 */
export function resolveTranscriptTools(messages: readonly TranscriptMessage[], support: TranscriptToolSupport): TranscriptTools {
	const systemMessages = messages.filter(isSystemMessage);
	if (support === 'none') {
		return { requestTools: getCurrentTools(systemMessages), foldedSystemMessages: systemMessages.length };
	}
	if (support === 'changes') return { requestTools: [], foldedSystemMessages: 0 };
	const folded = Math.max(
		getInitialSystemMessage(messages) ? 1 : 0,
		findLastNonAdditiveToolChange(systemMessages) + 1,
	);
	return { requestTools: getCurrentTools(systemMessages.slice(0, folded)), foldedSystemMessages: folded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental fold over durable entries (W03 adapt: one transcript fold).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kind of the compaction checkpoint entry; the literal is pinned by
 * `@mavis/context-projection` (`COMPACTION_KIND` in `src/kinds.ts`). Declared
 * locally to keep this package's imports of the projection type-only.
 */
const COMPACTION_ENTRY_KIND = 'mcode.compaction';

/**
 * The folded transcript state — everything the replay contracts derive,
 * maintained per entry so a same-head lookup never re-walks the window.
 *
 * Size discipline: the state grows with the number of SYSTEM messages and
 * distinct tool names, never with the window length; the messages themselves
 * stay owned by the projection/window (`ContextManifest` handles only).
 */
export interface TranscriptState {
	/** Replayed system content parts (each already the message's own `\n`-joined text). */
	readonly contentParts: readonly string[];
	/** Replayed named sections (`null` removals delete). */
	readonly sections: ReadonlyMap<string, string>;
	/** Current tool state after every applied delta (removed first, then added, per message). */
	readonly tools: ReadonlyMap<string, DecodedToolDeclaration>;
	/** Every tool name ever declared — a name declared before is a redeclaration even after removal. */
	readonly declaredNames: ReadonlySet<string>;
	/** Timestamp of the first contributing system message; `null` until one appears. */
	readonly timestamp: number | null;
	/** System messages folded so far. */
	readonly systemCount: number;
	/** Whether ANY message was folded yet (the leading-message check needs the window's first message). */
	readonly sawAnyMessage: boolean;
	/** Whether the window's FIRST message is a system message (pin `getInitialSystemMessage`). */
	readonly firstMessageIsSystem: boolean;
	/**
	 * Tool state snapshot for `TranscriptToolSupport` `"additions"`: the tools
	 * after the last fold boundary (the leading system message, or the last
	 * non-additive change), equal by construction to
	 * `getCurrentTools(systemMessages.slice(0, boundaryFolded))`.
	 */
	readonly boundaryTools: readonly DecodedToolDeclaration[];
	/** `foldedSystemMessages` the `boundaryTools` snapshot answers with. */
	readonly boundaryFolded: number;
	/** Last folded entry id, for diagnostics. */
	readonly lastEntryId: string | null;
}

/** Fold state over an empty transcript. */
export const EMPTY_TRANSCRIPT_STATE: TranscriptState = {
	contentParts: [],
	sections: new Map(),
	tools: new Map(),
	declaredNames: new Set(),
	timestamp: null,
	systemCount: 0,
	sawAnyMessage: false,
	firstMessageIsSystem: false,
	boundaryTools: [],
	boundaryFolded: 0,
	lastEntryId: null,
};

/**
 * The full frozen SystemMessage a compaction checkpoint may freeze (V-C09) —
 * the pi-ai `SystemMessage` JSON shape. Declared structurally (local to this
 * layer): `content` is a string or text blocks, `sections`/`toolsAdded`/
 * `toolsRemoved` optional, `timestamp` wall-clock. Shape-equal to
 * `@mavis/context-compaction` `FrozenSystemMessage` and
 * `@mavis/context-projection` `FrozenCompactionSystemMessage` — pinned by the
 * cross-package checkpoint tests, declared locally per package (types-only
 * imports, no runtime coupling).
 */
export interface CheckpointSystemMessage {
	readonly role?: 'system';
	readonly content: string | readonly { readonly type: 'text'; readonly text: string }[];
	readonly sections?: Readonly<Record<string, string | null>>;
	readonly toolsAdded?: readonly DecodedToolDeclaration[];
	readonly toolsRemoved?: readonly { readonly name: string }[];
	readonly timestamp: number;
}

/** Structural guard of {@link CheckpointSystemMessage} (JSON-level, tolerant). */
export function isCheckpointSystemMessage(value: unknown): value is CheckpointSystemMessage {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.role !== undefined && record.role !== 'system') return false;
	const { content } = record;
	if (typeof content !== 'string') {
		if (!Array.isArray(content)) return false;
		for (const part of content) {
			if (
				typeof part !== 'object' ||
				part === null ||
				(part as { type?: unknown }).type !== 'text' ||
				typeof (part as { text?: unknown }).text !== 'string'
			) {
				return false;
			}
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
	// BOTH tool lists are validated, symmetrically to
	// `isFrozenCompactionSystemMessage` of `@mavis/context-projection`
	// (kinds.ts): a record with a corrupt `toolsRemoved` must be rejected by
	// EVERY reader of the frozen checkpoint shape, never accepted by one and
	// turned into dead weight by the other (W05 review pass 1, validator
	// asymmetry).
	for (const list of [record.toolsAdded, record.toolsRemoved]) {
		if (list === undefined) continue;
		if (!Array.isArray(list)) return false;
		for (const tool of list) {
			if (typeof tool !== 'object' || tool === null) return false;
			if (typeof (tool as { name?: unknown }).name !== 'string') return false;
		}
	}
	if (record.timestamp !== undefined && (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp))) {
		return false;
	}
	return true;
}

/**
 * Seed a transcript fold from a compaction checkpoint's frozen system
 * message — the manifest-path entry point: the projection window starts at
 * `firstKeptEntryId`, the checkpoint entry itself sits before the slice, so
 * the caller seeds the baseline and folds the retained slice on top
 * (`transcriptStateFromCheckpoint(manifest.compaction.systemMessage)`).
 *
 * Three spellings, all V-C09-legal: `null` is retain-none — no system message
 * at all (pi `CompactionEntry.systemMessage === null` contributes none); a
 * `string` is the legacy prompt-text checkpoint — content only, tool state
 * empty (the documented legacy gap); a full frozen SystemMessage object
 * re-baselines content AND sections AND tools AND timestamp — the pre-cut
 * declarations never leak past the cut, and the retained window replays
 * against exactly the prompt state the summary was made for.
 */
export function transcriptStateFromCheckpoint(
	systemMessage: string | null | CheckpointSystemMessage,
): TranscriptState {
	if (systemMessage === null) return { ...EMPTY_TRANSCRIPT_STATE, sawAnyMessage: true };
	if (typeof systemMessage === 'string') {
		return {
			...EMPTY_TRANSCRIPT_STATE,
			sawAnyMessage: true,
			firstMessageIsSystem: true,
			contentParts: [systemMessage],
			// The baseline IS the window's first system message (pi: checkpoint
			// leads, later system messages follow), so the fold's system
			// numbering continues after it.
			systemCount: 1,
			// The legacy string checkpoint carries no wall-clock stamp; the
			// full-SystemMessage checkpoint carries one.
			timestamp: 0,
		};
	}
	// Full frozen form (V-C09): the checkpoint IS the window's first system
	// message, complete with sections, tool declarations and its timestamp.
	const sections = new Map<string, string>();
	for (const [name, value] of Object.entries(systemMessage.sections ?? {})) {
		if (value !== null) sections.set(name, value);
	}
	const tools = new Map<string, DecodedToolDeclaration>();
	const declaredNames = new Set<string>();
	for (const tool of systemMessage.toolsAdded ?? []) {
		tools.set(tool.name, tool);
		declaredNames.add(tool.name);
	}
	return {
		contentParts: [contentText(systemMessage.content as string | readonly DecodedPart[])],
		sections,
		tools,
		declaredNames,
		timestamp: systemMessage.timestamp,
		systemCount: 1,
		sawAnyMessage: true,
		firstMessageIsSystem: true,
		boundaryTools: [...tools.values()],
		boundaryFolded: 1,
		lastEntryId: null,
	};
}

/**
 * Read a compaction checkpoint's frozen system message off its entry payload
 * — the same tolerant rule `asCompactionPayload` applies: `string`/`null`/
 * full frozen SystemMessage legal, absent legal, any other shape a
 * writer-contract breach.
 */
function checkpointSystemMessage(entry: DurableEntry): string | null | CheckpointSystemMessage | undefined {
	if (typeof entry.payload !== 'object' || entry.payload === null || Array.isArray(entry.payload)) {
		throw new TypeError(`mcode.compaction entry ${entry.id}: payload must be an object`);
	}
	const systemMessage = (entry.payload as { readonly systemMessage?: unknown }).systemMessage;
	if (systemMessage === undefined || systemMessage === null) return systemMessage === null ? null : undefined;
	if (typeof systemMessage === 'string') return systemMessage;
	if (isCheckpointSystemMessage(systemMessage)) return systemMessage;
	throw new TypeError(
		`mcode.compaction entry ${entry.id}: payload.systemMessage must be a string, null, or a frozen system message object`,
	);
}

/**
 * Folds ONE entry into the transcript state — the single definition of the
 * transcript fold semantics (the `foldEntry` discipline of
 * `@mavis/context-projection`): the one-shot {@link foldTranscriptEntries},
 * any incremental application and the pure replay contracts above all go
 * through it, which is what makes them agree by construction.
 *
 * - `pi.*` entries contribute their decoded messages; system messages apply
 *   content/sections/tool deltas and advance the fold-boundary bookkeeping;
 *   other roles only mark the leading-message check.
 * - `mcode.compaction` RE-BASELINES the system state to the checkpoint's
 *   frozen `systemMessage` (pi `buildContextEntries`: retained pre-checkpoint
 *   system messages are dropped, the checkpoint leads) — so pre-checkpoint
 *   declarations never leak past a cut. The legacy string checkpoint carries
 *   prompt text only (tool state resets to empty — the documented legacy
 *   gap); the V-C09 full frozen SystemMessage re-baselines
 *   content+sections+tools+timestamp.
 * - every other `mcode.*` kind advances `lastEntryId` only (their window
 *   effects belong to the projection fold, not the transcript layer).
 */
export function foldTranscriptEntry(state: TranscriptState, entry: DurableEntry): TranscriptState {
	if (entry.kind === COMPACTION_ENTRY_KIND) {
		// An absent `systemMessage` is legal (foreign writer): the honest reading
		// of a checkpoint that does not declare its frozen prompt is retain-none.
		const checkpoint = checkpointSystemMessage(entry) ?? null;
		return { ...transcriptStateFromCheckpoint(checkpoint), lastEntryId: entry.id };
	}

	if (entry.kind.startsWith('mcode.')) {
		return { ...state, lastEntryId: entry.id };
	}

	const decoded = decodeEntryPayload(entry.kind, entry.payload);
	if (decoded.messages.length === 0) {
		return { ...state, lastEntryId: entry.id };
	}

	let contentParts = state.contentParts;
	let sections = state.sections;
	let tools = state.tools;
	let declaredNames = state.declaredNames;
	let timestamp = state.timestamp;
	let systemCount = state.systemCount;
	let sawAnyMessage = state.sawAnyMessage;
	let firstMessageIsSystem = state.firstMessageIsSystem;
	let boundaryTools = state.boundaryTools;
	let boundaryFolded = state.boundaryFolded;

	for (const message of decoded.messages) {
		const leads = !sawAnyMessage;
		sawAnyMessage = true;
		if (leads) firstMessageIsSystem = message.role === 'system';
		if (message.role !== 'system') continue;

		// Content: the message's own text (parts join with a newline — pin
		// `contentText`), appended to the replayed parts.
		const text = contentText(message.parts);
		if (text.length > 0) contentParts = [...contentParts, text];

		// Sections: patch by name, `null` removes (copy-on-write only when
		// the message carries sections).
		if (message.sections !== undefined) {
			const nextSections = new Map(sections);
			for (const [name, value] of Object.entries(message.sections)) {
				if (value === null) nextSections.delete(name);
				else nextSections.set(name, value);
			}
			sections = nextSections;
		}

		// Tools: removals first, then additions — the pin `getCurrentTools`
		// order within one message.
		const removed = message.toolsRemoved ?? [];
		const added = message.toolsAdded ?? [];
		if (removed.length > 0 || added.length > 0) {
			const nextTools = new Map(tools);
			for (const reference of removed) nextTools.delete(reference.name);
			for (const tool of added) nextTools.set(tool.name, tool);
			tools = nextTools;
		}

		// Non-additive tracking: a removal or a redeclaration of an
		// ever-declared name moves the `"additions"` fold boundary here.
		const index = systemCount;
		let redeclared = false;
		if (added.length > 0) {
			const nextDeclared = new Set(declaredNames);
			for (const tool of added) {
				if (nextDeclared.has(tool.name)) redeclared = true;
				nextDeclared.add(tool.name);
			}
			declaredNames = nextDeclared;
		}
		const nonAdditive = removed.length > 0 || redeclared;
		if (nonAdditive || (index === 0 && firstMessageIsSystem)) {
			boundaryTools = [...tools.values()];
			boundaryFolded = index + 1;
		}

		if (timestamp === null && message.timestamp !== undefined) timestamp = message.timestamp;
		systemCount = index + 1;
	}

	return {
		contentParts,
		sections,
		tools,
		declaredNames,
		timestamp,
		systemCount,
		sawAnyMessage,
		firstMessageIsSystem,
		boundaryTools,
		boundaryFolded,
		lastEntryId: entry.id,
	};
}

/** Folds a whole log-order slice of entries from the empty state. */
export function foldTranscriptEntries(entries: readonly DurableEntry[]): TranscriptState {
	let state = EMPTY_TRANSCRIPT_STATE;
	for (const entry of entries) state = foldTranscriptEntry(state, entry);
	return state;
}

/**
 * The replayed system message of a folded state — equals
 * {@link getCurrentSystemMessage} over the folded window's messages by
 * construction (pinned by `test/unit/transcript-fold.test.ts`).
 */
export function transcriptSystemMessage(state: TranscriptState): TranscriptSystemMessage | undefined {
	const tools = [...state.tools.values()];
	if (state.timestamp === null && tools.length === 0) return undefined;
	return {
		role: 'system',
		content: state.contentParts.join('\n\n'),
		...(state.sections.size > 0 ? { sections: Object.fromEntries(state.sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: state.timestamp ?? 0,
	};
}

/** The current tools of a folded state — equals {@link getCurrentTools} over the folded window. */
export function transcriptTools(state: TranscriptState): DecodedToolDeclaration[] {
	return [...state.tools.values()];
}

/**
 * The {@link TranscriptTools} split of a folded state for a transport's
 * `support` — equals {@link resolveTranscriptTools} over the folded window.
 */
export function transcriptResolveTools(state: TranscriptState, support: TranscriptToolSupport): TranscriptTools {
	if (support === 'none') {
		return { requestTools: [...state.tools.values()], foldedSystemMessages: state.systemCount };
	}
	if (support === 'changes') return { requestTools: [], foldedSystemMessages: 0 };
	const folded = Math.max(state.firstMessageIsSystem ? 1 : 0, state.boundaryFolded);
	// boundaryFolded is 0 exactly when no boundary was ever set; the boundary
	// snapshot then is the empty tool set, which is getCurrentTools(∅).
	if (folded === 0) return { requestTools: [], foldedSystemMessages: 0 };
	return { requestTools: [...state.boundaryTools], foldedSystemMessages: folded };
}
