/**
 * The frozen SystemMessage of a compaction checkpoint (V-C09 full form).
 *
 * The pin's `CompactionEntry.systemMessage` (coding-agent session-manager.ts)
 * carries the COMPLETE prompt and tool state at the compaction boundary — the
 * pi-ai `SystemMessage` JSON shape, not prompt text: `content` (string or text
 * blocks), optional named `sections`, complete `toolsAdded` declarations, and
 * the wall-clock `timestamp`. The writer freezes the replayed
 * `getCurrentSystemMessage` of the session projection; readers re-baseline
 * content AND sections AND tools AND timestamp from it, so pre-checkpoint
 * declarations never leak past a cut and the retained window replays against
 * exactly the prompt state the summary was made for.
 *
 * The legacy string form (`systemMessage: string | null`, prompt text only, no
 * tools/sections/timestamp) stays a first-class readable spelling: every
 * reader accepts BOTH, old logs keep reading without regression.
 *
 * @module
 */

/** One text block of a frozen system message's content (`pi-ai TextContent`). */
export interface FrozenTextPart {
  readonly type: 'text';
  readonly text: string;
}

/**
 * A minimal tool declaration the frozen message carries — the JSON subset of
 * pi-ai `Tool` the transcript fold replays (`name` is the identity; the rest
 * passes through verbatim for the wire).
 */
export interface FrozenToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

/**
 * The full frozen SystemMessage form of a checkpoint's `systemMessage` — the
 * pinned pi-ai `SystemMessage` JSON shape (`role` included, pin-exact).
 */
export interface FrozenSystemMessage {
  readonly role: 'system';
  readonly content: string | readonly FrozenTextPart[];
  readonly sections?: Readonly<Record<string, string | null>>;
  readonly toolsAdded?: readonly FrozenToolDeclaration[];
  readonly toolsRemoved?: readonly { readonly name: string }[];
  readonly timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural guard for the full frozen form (tolerant, JSON-level): `role`
 * must be `"system"` when present (readers of old records without `role` are
 * not broken — but a WRONG role is a different message, not a system message),
 * `content` a string or a list of `{type:'text', text}` blocks, `sections` a
 * string/null record, `toolsAdded` declarations carrying a string `name`,
 * `timestamp` a finite number.
 */
export function isFrozenSystemMessage(value: unknown): value is FrozenSystemMessage {
  if (!isRecord(value)) return false;
  if (value.role !== undefined && value.role !== 'system') return false;
  const { content } = value;
  if (typeof content !== 'string') {
    if (!Array.isArray(content)) return false;
    for (const part of content) {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') return false;
    }
  }
  if (value.sections !== undefined) {
    if (!isRecord(value.sections)) return false;
    for (const sectionValue of Object.values(value.sections)) {
      if (typeof sectionValue !== 'string' && sectionValue !== null) return false;
    }
  }
  if (value.toolsAdded !== undefined) {
    if (!Array.isArray(value.toolsAdded)) return false;
    for (const tool of value.toolsAdded) {
      if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name.length === 0) return false;
    }
  }
  if (value.toolsRemoved !== undefined) {
    if (!Array.isArray(value.toolsRemoved)) return false;
    for (const reference of value.toolsRemoved) {
      if (!isRecord(reference) || typeof reference.name !== 'string') return false;
    }
  }
  if (value.timestamp !== undefined && (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp))) {
    return false;
  }
  return true;
}

/** Render the text of a frozen content: a string passes, text blocks join with `\n`. */
function frozenContentText(content: string | readonly FrozenTextPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Render a frozen system message as the complete prompt text its window
 * carries — pin `getSystemMessageText` semantics: the content, then every
 * non-null section, joined with a blank line. This is the text the token
 * estimate and the byte axis of a full-form checkpoint charge.
 */
export function renderFrozenSystemText(message: FrozenSystemMessage): string {
  const parts = [frozenContentText(message.content)];
  for (const text of Object.values(message.sections ?? {})) {
    if (text !== null) parts.push(text);
  }
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * Normalize every readable spelling of a checkpoint's `systemMessage` into the
 * pair the compaction core consumes: the rendered PROMPT TEXT (or `null` for
 * retain-none/absent) and the full frozen form when one was recorded.
 *
 * - `null`/`undefined` — retain-none: no system message at all.
 * - `string` — legacy: prompt text only, no tools/sections/timestamp.
 * - full form — both the rendered text and the structured message.
 */
export function normalizeCheckpointSystemMessage(
  systemMessage: string | null | undefined | FrozenSystemMessage,
): { readonly text: string | null; readonly frozen: FrozenSystemMessage | null } {
  if (systemMessage === null || systemMessage === undefined) return { text: null, frozen: null };
  if (typeof systemMessage === 'string') return { text: systemMessage, frozen: null };
  return { text: renderFrozenSystemText(systemMessage), frozen: systemMessage };
}

/**
 * Build a full frozen SystemMessage — the writer-side helper `compact()` uses
 * when the caller provides the session's replayed system state (pin writer:
 * `systemMessage ? { ...systemMessage, timestamp: new Date(timestamp).getTime() } : undefined`).
 */
export function createFrozenSystemMessage(
  content: string | readonly FrozenTextPart[],
  options: {
    readonly sections?: Readonly<Record<string, string | null>>;
    readonly toolsAdded?: readonly FrozenToolDeclaration[];
    readonly timestamp: number;
  },
): FrozenSystemMessage {
  return {
    role: 'system',
    content,
    ...(options.sections === undefined ? {} : { sections: options.sections }),
    ...(options.toolsAdded === undefined || options.toolsAdded.length === 0
      ? {}
      : { toolsAdded: options.toolsAdded }),
    timestamp: options.timestamp,
  };
}
