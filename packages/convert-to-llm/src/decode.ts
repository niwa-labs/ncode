/**
 * Tolerant, deterministic decoding of durable entry payloads into logical
 * messages.
 *
 * Entries are JSON at rest. The canonical writer convention (pi-durable) is
 * `payload.model = [message]` with exactly one message per entry; the decoder
 * also accepts a bare message object and a `payload.messages` array so that
 * import paths and app-level writers stay convertible. Anything it cannot
 * decode yields an empty message list — the caller counts that as
 * `undecodable` and the wire equivalence gate would flag a wrongly dropped
 * entry.
 *
 * Images decode to reference parts (`{type:'image', mimeType}`) plus the
 * payload's inline base64 when it carries one (`data`, optional): the dialect
 * renders a deterministic text placeholder and CAS pages own the actual image
 * transport, so the base64 never persists into a compiled record — it is read
 * only when a residency override explicitly renders a RESIDENT page's bytes
 * onto the wire (the Context-MMU overlay), within this one conversion call.
 */

import type { JsonValue } from './types.js';

/**
 * The artifact reference of an OFFLOADED image block (wave 2, canon 05 §2.5):
 * the durable log stores the reference instead of the base64 bytes, and the
 * payload's own fields name the content-addressed artifact. `sha256` is the
 * store's content address (the artifact file stem), `artifact` the absolute
 * path the model can `read` again, `bytes` the original byte length (the
 * stub's size line).
 */
export interface DecodedImageArtifactRef {
  readonly sha256: string;
  readonly artifact: string;
  readonly bytes: number;
}

/** One projected content part: text bytes or an image reference. */
export type DecodedPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly mimeType: string;
      readonly data?: string;
      readonly ref?: DecodedImageArtifactRef;
    };

/** Projected tool call before dialect rendering. */
export interface DecodedToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON-encoded arguments; byte-stable for identical stored payloads. */
  readonly arguments: string;
}

/**
 * A tool declaration as it appears in a system message's `toolsAdded` — the
 * JSON shape of pi-ai's `Tool` after `toToolDeclaration` (the typebox symbol
 * keys and unknown extra fields do not survive JSON at rest). `parameters` is
 * the raw stored JSON schema; `constrainedSampling` passes through verbatim.
 */
export interface DecodedToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
  readonly constrainedSampling?: JsonValue;
}

/** A `toolsRemoved` reference: a tool name that stops being available. */
export interface DecodedToolReference {
  readonly name: string;
}

/** Logical message roles the converter understands. */
export type DecodedRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'toolResult'
  | 'bashExecution'
  | 'custom'
  | 'branchSummary'
  | 'compactionSummary';

/**
 * Pi conversion-tag payloads of the tag roles (V-C10): the decoded fields of
 * `bashExecution` / `custom` / `branchSummary` / `compactionSummary` messages
 * (pi coding-agent `core/messages.ts`). A malformed tag payload fails the
 * whole message — it decodes to nothing, exactly like any other malformed
 * message shape; it never converts partially.
 */
export interface DecodedTagFields {
  readonly bashExecution?: {
    readonly command: string;
    readonly output: string;
    readonly exitCode: number | undefined;
    readonly cancelled: boolean;
    readonly truncated: boolean;
    readonly fullOutputPath?: string;
    readonly excludeFromContext?: boolean;
  };
  readonly custom?: { readonly customType: string; readonly display: boolean };
  readonly branchSummary?: { readonly summary: string };
  readonly compactionSummary?: { readonly summary: string; readonly tokensBefore: number };
}

/** A logical message decoded from an entry payload. */
export interface DecodedMessage {
  readonly role: DecodedRole;
  readonly parts: readonly DecodedPart[];
  /** Assistant-only: tool-call deltas carried by the message. */
  readonly toolCalls?: readonly DecodedToolCall[];
  /** Tool-result-only correlation. */
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  /** Immediate-send batch marker (`hostMetadata.immediateSendBatchId`). */
  readonly batchId?: string;
  /** Tag-role payloads (V-C10); present only on the four pi tag roles. */
  readonly tag?: DecodedTagFields;
  /**
   * System-only: named prompt sections; a `null` value removes the section
   * (pi-ai `SystemMessage.sections`). Later messages patch by name.
   */
  readonly sections?: Readonly<Record<string, string | null>>;
  /** System-only: complete tool declarations that become available here. */
  readonly toolsAdded?: readonly DecodedToolDeclaration[];
  /** System-only: tools that stop being available here. */
  readonly toolsRemoved?: readonly DecodedToolReference[];
  /** Unix milliseconds, when the stored message carries one (system replay uses the first). */
  readonly timestamp?: number;
}

/** Everything the converter needs from one entry payload. */
export interface DecodedEntryPayload {
  /** Logical messages; empty when the payload decodes to nothing. */
  readonly messages: readonly DecodedMessage[];
  /** Steering placed-entry linkage (`mcode.owner-input.placed`). */
  readonly inputEntryId?: string;
  /** Raw reminder text of a dedicated `mcode.system-reminder` entry. */
  readonly reminderText?: string;
}

type PlainObject = { readonly [key: string]: JsonValue };

function isRecord(value: JsonValue | undefined): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** Encode tool-call arguments deterministically: JSON strings pass through, values stringify. */
function encodeArguments(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

/** Decode a content block list (text/image) into projected parts. */
function decodeBlockParts(blocks: readonly JsonValue[]): DecodedPart[] {
  const parts: DecodedPart[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = asString(block.type);
    if (type === 'text') {
      const text = asString(block.text);
      if (text !== undefined) parts.push({ type: 'text', text });
    } else if (type === 'image') {
      const mimeType = asString(block.mimeType) ?? 'application/octet-stream';
      const data = asString(block.data);
      // Wave 2 (canon 05 §2.5): an OFFLOADED image block carries the artifact
      // reference instead of base64 — the fields survive the projection so the
      // wire rendering can name the path (the read-again stub) and the
      // residency can resolve the bytes back out of the artifact store.
      const sha256 = asString(block.sha256);
      const artifact = asString(block.artifact);
      const ref =
        sha256 !== undefined && artifact !== undefined
          ? {
              sha256,
              artifact,
              bytes: typeof block.bytes === 'number' && Number.isSafeInteger(block.bytes) && block.bytes >= 0 ? block.bytes : 0,
            }
          : undefined;
      parts.push(
        data === undefined && ref === undefined
          ? { type: 'image', mimeType }
          : {
              type: 'image',
              mimeType,
              ...(data === undefined ? {} : { data }),
              ...(ref === undefined ? {} : { ref }),
            },
      );
    }
  }
  return parts;
}

/** Decode message content of any supported shape into projected parts. */
function decodeContentParts(content: JsonValue | undefined): DecodedPart[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  return decodeBlockParts(asArray(content));
}

/** Read the immediate-send batch marker the same way mcode's normalizer does. */
function decodeBatchId(message: PlainObject): string | undefined {
  const metadata = message.hostMetadata;
  if (!isRecord(metadata)) return undefined;
  const id = asString(metadata.immediateSendBatchId);
  return id !== undefined && id.length > 0 ? id : undefined;
}

/**
 * Decode the system-message tool/section extras (pi-ai `SystemMessage`):
 * `sections`, `toolsAdded`, `toolsRemoved`, `timestamp`.
 *
 * STRICT per design W03-D: a present-but-malformed field makes the whole
 * message undecodable (`undefined`) instead of silently dropping tool
 * declarations — the loss would be invisible to every later stage. The
 * caller counts the entry as `noProviderRecord`, so the corruption is
 * diagnosable, never silent. Absent fields stay absent.
 */
function decodeSystemExtras(
  message: PlainObject,
): Pick<DecodedMessage, 'sections' | 'toolsAdded' | 'toolsRemoved' | 'timestamp'> | undefined {
  const extras: {
    sections?: Record<string, string | null>;
    toolsAdded?: DecodedToolDeclaration[];
    toolsRemoved?: DecodedToolReference[];
    timestamp?: number;
  } = {};

  if (message.sections !== undefined) {
    if (!isRecord(message.sections)) return undefined;
    const sections: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(message.sections)) {
      if (typeof value !== 'string' && value !== null) return undefined;
      sections[name] = value;
    }
    extras.sections = sections;
  }

  if (message.toolsAdded !== undefined) {
    if (!Array.isArray(message.toolsAdded)) return undefined;
    const toolsAdded: DecodedToolDeclaration[] = [];
    for (const tool of message.toolsAdded) {
      if (!isRecord(tool)) return undefined;
      const name = asString(tool.name);
      const description = asString(tool.description);
      if (name === undefined || description === undefined) return undefined;
      if (tool.parameters === undefined) return undefined;
      toolsAdded.push({
        name,
        description,
        parameters: tool.parameters,
        ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
      });
    }
    extras.toolsAdded = toolsAdded;
  }

  if (message.toolsRemoved !== undefined) {
    if (!Array.isArray(message.toolsRemoved)) return undefined;
    const toolsRemoved: DecodedToolReference[] = [];
    for (const reference of message.toolsRemoved) {
      if (!isRecord(reference)) return undefined;
      const name = asString(reference.name);
      if (name === undefined) return undefined;
      toolsRemoved.push({ name });
    }
    extras.toolsRemoved = toolsRemoved;
  }

  if (message.timestamp !== undefined) {
    if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) return undefined;
    extras.timestamp = message.timestamp;
  }

  return extras;
}

/** Decode one pi-ai-shaped message object. Returns `undefined` for non-messages. */
function decodeMessage(raw: JsonValue): DecodedMessage | undefined {
  if (!isRecord(raw)) return undefined;
  const role = asString(raw.role);
  switch (role) {
    case 'system': {
      const extras = decodeSystemExtras(raw);
      // A malformed system extra fails the WHOLE message (see decodeSystemExtras):
      // an entry whose tool deltas cannot be trusted must not convert at all.
      if (extras === undefined) return undefined;
      const message: DecodedMessage = {
        role,
        parts: decodeContentParts(raw.content),
        ...extras,
      };
      return message;
    }
    case 'user': {
      const message: DecodedMessage = {
        role,
        parts: decodeContentParts(raw.content),
      };
      const batchId = decodeBatchId(raw);
      return batchId === undefined ? message : { ...message, batchId };
    }
    case 'assistant': {
      const parts = decodeContentParts(raw.content);
      const toolCalls: DecodedToolCall[] = [];
      for (const block of asArray(raw.content)) {
        if (!isRecord(block)) continue;
        if (asString(block.type) !== 'toolCall') continue;
        const id = asString(block.id);
        const name = asString(block.name);
        if (id === undefined || name === undefined) continue;
        toolCalls.push({ id, name, arguments: encodeArguments(block.arguments) });
      }
      return { role: 'assistant', parts, toolCalls };
    }
    case 'toolResult': {
      const toolCallId = asString(raw.toolCallId);
      if (toolCallId === undefined) return undefined;
      return {
        role: 'toolResult',
        parts: decodeContentParts(raw.content),
        toolCallId,
        toolName: asString(raw.toolName) ?? '',
        isError: raw.isError === true,
      };
    }
    // pi conversion-tag roles (V-C10, pinned coding-agent core/messages.ts).
    // Each carries its pi fields under `tag`; `content`/`output` decode as
    // parts where pi carries them. Malformed fields fail the whole message.
    case 'bashExecution': {
      const command = asString(raw.command);
      const output = asString(raw.output);
      if (command === undefined || output === undefined) return undefined;
      const exitCode = raw.exitCode;
      if (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isFinite(exitCode))) return undefined;
      if (raw.cancelled !== undefined && typeof raw.cancelled !== 'boolean') return undefined;
      if (raw.truncated !== undefined && typeof raw.truncated !== 'boolean') return undefined;
      const fullOutputPath = asString(raw.fullOutputPath);
      const excludeFromContext = raw.excludeFromContext;
      if (excludeFromContext !== undefined && typeof excludeFromContext !== 'boolean') return undefined;
      return {
        role: 'bashExecution' as const,
        parts: [],
        tag: {
          bashExecution: {
            command,
            output,
            exitCode,
            cancelled: raw.cancelled === true,
            truncated: raw.truncated === true,
            ...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
            ...(excludeFromContext !== undefined ? { excludeFromContext: excludeFromContext === true } : {}),
          },
        },
      };
    }
    case 'custom': {
      const customType = asString(raw.customType);
      if (customType === undefined) return undefined;
      if (raw.display !== undefined && typeof raw.display !== 'boolean') return undefined;
      const content = raw.content;
      const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : decodeContentParts(content);
      return {
        role: 'custom' as const,
        parts,
        tag: { custom: { customType, display: raw.display === true } },
      };
    }
    case 'branchSummary': {
      const summary = asString(raw.summary);
      if (summary === undefined || summary.length === 0) return undefined;
      return { role: 'branchSummary' as const, parts: [], tag: { branchSummary: { summary } } };
    }
    case 'compactionSummary': {
      const summary = asString(raw.summary);
      const tokensBefore = raw.tokensBefore;
      if (summary === undefined || summary.length === 0) return undefined;
      if (typeof tokensBefore !== 'number' || !Number.isFinite(tokensBefore)) return undefined;
      return { role: 'compactionSummary' as const, parts: [], tag: { compactionSummary: { summary, tokensBefore } } };
    }
    default:
      return undefined;
  }
}

/** Decode the `model` field convention: `[message]`, single message, or `messages` array. */
function decodeModel(payload: PlainObject): readonly DecodedMessage[] {
  const model = payload.model;
  if (Array.isArray(model)) {
    return model
      .map(decodeMessage)
      .filter((message): message is DecodedMessage => message !== undefined);
  }
  const single = decodeMessage(model ?? ({} as JsonValue));
  if (single) return [single];
  const list = asArray(payload.messages);
  return list
    .map(decodeMessage)
    .filter((message): message is DecodedMessage => message !== undefined);
}

/** Decode a bare payload: the payload object itself is the message. */
function decodeBareMessage(payload: PlainObject): readonly DecodedMessage[] {
  const single = decodeMessage(payload as JsonValue);
  return single ? [single] : [];
}

/** Reminder text of a dedicated reminder entry: `text`/`content`/`blocks`/model message. */
function decodeReminderText(payload: PlainObject): string | undefined {
  const direct = asString(payload.text) ?? asString(payload.content);
  if (direct !== undefined) return direct;
  const blocks = asArray(payload.blocks)
    .map((block) => (isRecord(block) ? asString(block.text) : asString(block)))
    .filter((text): text is string => text !== undefined);
  if (blocks.length > 0) return blocks.join('\n\n');
  const fromModel = decodeModel(payload);
  const firstUser = fromModel.find((message) => message.role === 'user');
  if (!firstUser) return undefined;
  return firstUser.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

/**
 * Decode one entry payload. Never throws: malformed payloads decode to an
 * empty message list and let the caller decide (count and skip).
 */
export function decodeEntryPayload(kind: string, payload: JsonValue): DecodedEntryPayload {
  if (!isRecord(payload)) return { messages: [] };

  if (kind === 'mcode.system-reminder') {
    const reminderText = decodeReminderText(payload);
    return reminderText === undefined ? { messages: [] } : { messages: [], reminderText };
  }

  if (kind === 'mcode.owner-input.placed') {
    // Same non-empty discipline as `decodeBatchId`: an empty `inputEntryId`
    // carries no linkage, and letting it through would make every empty-linked
    // placement share one dedup key (distinct user inputs collapsing into one).
    const raw = asString(payload.inputEntryId);
    const inputEntryId = raw !== undefined && raw.length > 0 ? raw : undefined;
    const decoded = decodeModel(payload);
    const messages = decoded.length > 0 ? decoded : decodePlacedContent(payload);
    return inputEntryId === undefined ? { messages } : { messages, inputEntryId };
  }

  if (Object.hasOwn(payload, 'model') || Object.hasOwn(payload, 'messages')) {
    return { messages: decodeModel(payload) };
  }
  return { messages: decodeBareMessage(payload) };
}

/** Placed-entry fallback: model user content stored directly under `content`. */
function decodePlacedContent(payload: PlainObject): readonly DecodedMessage[] {
  const content = payload.content;
  if (typeof content !== 'string' || content.length === 0) return [];
  return [{ role: 'user', parts: [{ type: 'text', text: content }] }];
}
