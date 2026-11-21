/**
 * Context-wire projection port (integration plan Ш4).
 *
 * The composition (`local-runtime-v2`) owns the memoized payload-assembly
 * pipeline (`ContextWirePipeline` over the wave-2 context packages). This
 * module is the ONLY bridge the turn runner needs: a structural port injected
 * on {@link RunTurnInput.contextWire}, plus the hydration of the projected
 * provider-bound records into the pi-ai messages the agent loop sends.
 *
 * `agent-core` deliberately imports neither the wire packages nor
 * `local-runtime-v2` (integration plan Ш4: "пайплайн внедряется через
 * опцию/hook из композиции, не прямым импортом"). Everything here is plain
 * data in, pi `Message` out.
 *
 * Degradation contract: a projection never throws through the request path.
 * `project()` returning `undefined` (or throwing) degrades THAT single
 * request to the legacy conversion; the payload is then assembled by
 * `projectAgentMessagesForModel` exactly as without the port, so a wire-mode
 * fault can never lose or corrupt provider context.
 *
 * @module
 */

import { projectAgentMessagesForModel } from './outbound-message-normalizer.js';
import type { SystemMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, ImageContent, JsonObject, JsonValue, Message, Model, TextContent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
// The convert-to-llm marker contract (wave-0 item 0.5): the projection marks
// a structured image's position in the record text; hydration splits here.
import { imageBlockMarker, splitImageBlockMarkers } from '../../../convert-to-llm/src/index.js';

/** Assistant tool call of a projected record (provider shape). */
export interface ContextWireRecordToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON-encoded arguments; byte-stable for identical stored payloads. */
  readonly arguments: string;
}

/**
 * One provider-bound record of a context-wire payload. The wire projection
 * has already applied every payload-level rule (audit/control exclusion,
 * reminder tails, batch merging, image placeholders) — records arrive in
 * payload order and are sent in that order.
 */
export interface ContextWireRecord {
  /** Canonical source positions, including every member of a merged record. */
  readonly sourceIndexes?: readonly number[];
  readonly role: 'user' | 'assistant' | 'system' | 'toolResult';
  /**
   * Text content; non-resident images were already reduced to deterministic
   * placeholders. A RESIDENT image leaves an `imageBlockMarker` token here
   * (wave-0 item 0.5) and its bytes ride {@link ContextWireRecord.images}.
   */
  readonly text: string;
  /**
   * Structured RESIDENT image blocks of this record (wave-0 item 0.5, canon
   * 05 §2.5): hydration interleaves them with the text at the marker
   * positions, so the provider payload carries real image blocks. Absent on
   * the all-placeholder baseline.
   */
  readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
  /** Assistant tool-call deltas (assistant records only). */
  readonly toolCalls?: readonly ContextWireRecordToolCall[];
  /** Tool-result correlation (`toolResult` records only). */
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  /**
   * Wall-clock of the source canonical message (Unix ms) when the projection
   * still knows it; `undefined` on merged/derived records.
   */
  readonly timestamp?: number;
}

/** The projected payload for one provider request. */
export interface ContextWireRequest {
  readonly records: readonly ContextWireRecord[];
  /** Exact byte length the wire compiler measured for this payload. */
  readonly totalBytes: number;
}

/**
 * Host-owned context-wire projection injected on the runner input. Called
 * once per provider request from the pi `convertToLlm` seam; implementations
 * must be warm-path O(delta) (the composition-side pipeline memoizes the
 * per-entry stage and caches compiled segments).
 */
export interface ContextWireProjection {
  /** The payload for this request, or `undefined` to use the legacy conversion. */
  project(): ContextWireRequest | undefined;
  /** Observe every physical provider invocation, beneath host cache-warming wrappers. */
  wrapProviderStreamFn?(inner: StreamFn, call: { readonly turnId: string; readonly kind: 'agent' | 'compaction' }): StreamFn;
  /** Capture the actual normalized main request over its fully composed transport. */
  wrapStreamFn?(inner: StreamFn, main?: StreamFn): StreamFn;
  /** Called only after the canonical-history mutation has succeeded. */
  commitResponses?(messages: readonly unknown[]): Promise<void>;
}

/**
 * Hydrates one projected payload into the pi-ai messages the agent loop
 * sends. Deterministic: identical records produce identical messages except
 * for the assistant bookkeeping fields (`api`/`provider`/`model`), which come
 * from the active model. Timestamps fall back to `0` — the records are a
 * request-scoped re-rendering, and no payload semantics read them.
 */
export function contextWireMessages(
  request: ContextWireRequest,
  model: Model<Api>,
): Message[] {
  const messages: Message[] = [];
  for (const record of request.records) {
    switch (record.role) {
      case 'user':
        messages.push(userRecordMessage(record));
        break;
      case 'system':
        messages.push({ role: 'system', content: record.text, timestamp: record.timestamp ?? 0 });
        break;
      case 'assistant':
        messages.push(assistantRecordMessage(record, model));
        break;
      case 'toolResult':
        messages.push(toolResultRecordMessage(record));
        break;
    }
  }
  return messages;
}

/**
 * Splits a record's text into provider content blocks (wave-0 item 0.5):
 * structured resident images interleave with the text at their marker
 * positions. A marker without a matching image entry (a projection bug)
 * degrades to the raw marker text — visible, never silently dropped.
 */
function recordContentBlocks(
  record: ContextWireRecord,
): readonly (TextContent | ImageContent)[] {
  if (record.images === undefined || record.images.length === 0) {
    return record.text.length > 0 ? [{ type: 'text', text: record.text }] : [];
  }
  const { segments, imageIndexes } = splitImageBlockMarkers(record.text);
  const blocks: (TextContent | ImageContent)[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.length > 0) blocks.push({ type: 'text', text: segment });
    const imageIndex = imageIndexes[index];
    if (imageIndex === undefined) continue;
    const image = record.images[imageIndex];
    if (image === undefined) {
      // The marker names an image the record does not carry: keep the marker
      // visible instead of silently dropping the position.
      blocks.push({ type: 'text', text: imageBlockMarker(imageIndex) });
      continue;
    }
    blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  return blocks;
}

/**
 * Hydrates a projected payload while preserving the transcript's system
 * messages.
 *
 * The pi agent encodes the system prompt AND the tool declarations in
 * transcript system messages (`createInitialSystemMessage` plus
 * `declareToolChanges` deltas), and the provider request is shaped from those
 * same messages downstream (`normalizeContext` → `getInitialSystemMessage`
 * reads the prompt, `getCurrentTools` folds the tool deltas). The wire window
 * carries only conversation records, so replacing the transcript with the
 * projection alone would send the request with no system prompt and no tools
 * — the model would answer toolless. Runtime tool declarations remain ahead
 * of the projected records. Canonical named-section updates are reinserted
 * at their source positions so they do not rewrite earlier conversation.
 */
export function contextWireRequestMessages(
  transcript: readonly AgentMessage[],
  request: ContextWireRequest,
  model: Model<Api>,
): Message[] {
  const runtimeSystems = transcript.filter((message): message is SystemMessage => message.role === 'system' && message.sections === undefined);
  const canonical = transcript.filter((message) => message.role !== 'system' || message.sections !== undefined);
  const patches = canonical.flatMap((message, index) =>
    message.role === 'system' && message.sections !== undefined ? [{ message, index }] : []);
  if (patches.length === 0) return [...runtimeSystems, ...contextWireMessages(request, model)];
  // Never guess a chronological position for a projection without source anchors.
  if (request.records.some((record) => !record.sourceIndexes?.length)) {
    return projectAgentMessagesForModel(transcript, model).messages;
  }
  const result: Message[] = [...runtimeSystems];
  let next = 0;
  for (const record of request.records) {
    const start = Math.min(...record.sourceIndexes!);
    while (next < patches.length && patches[next]!.index <= start) {
      result.push(patches[next++]!.message);
    }
    result.push(...contextWireMessages({ records: [record], totalBytes: 0 }, model));
  }
  result.push(...patches.slice(next).map(({ message }) => message));
  return result;
}

function userRecordMessage(record: ContextWireRecord): UserMessage {
  return {
    role: 'user',
    content: [...recordContentBlocks(record)],
    timestamp: record.timestamp ?? 0,
  };
}

function assistantRecordMessage(record: ContextWireRecord, model: Model<Api>): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (record.text.length > 0) content.push({ type: 'text', text: record.text });
  for (const call of record.toolCalls ?? []) {
    content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: decodeArguments(call.arguments) });
  }
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: record.toolCalls?.length ? 'toolUse' : 'stop',
    timestamp: record.timestamp ?? 0,
  };
}

function toolResultRecordMessage(record: ContextWireRecord): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: record.toolCallId ?? '',
    toolName: record.toolName ?? '',
    content: [...recordContentBlocks(record)],
    isError: record.isError === true,
    timestamp: record.timestamp ?? 0,
  };
}

/** Tool-call arguments travel JSON-encoded; a corrupt string stays visible. */
function decodeArguments(encoded: string): JsonObject {
  try {
    const parsed = JSON.parse(encoded) as JsonValue;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // JSON.parse output is JSON by construction — pi toolCall `arguments`
      // carry `JsonObject`.
      return parsed as JsonObject;
    }
    return { value: parsed ?? null };
  } catch {
    return { raw: encoded };
  }
}
