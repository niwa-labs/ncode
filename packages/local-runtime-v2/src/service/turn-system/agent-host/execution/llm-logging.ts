import {
  type PiAfterLlmCallHook,
  type PiEventWriter,
  type PiLLMRequestFailureInfo,
  type PiOnLlmCallPreparedHook,
} from '@mavis/agent-core/pi-turn-runner';
import { createLogger, traffic } from '@mavis/logging';

/**
 * mcode:llm seam (spec §4): request, first token, completion and failure
 * observations for the logical provider calls of one Turn. Logging only —
 * every hook returns `undefined`, so no before/after-LLM decision changes.
 * Full bodies go to the traffic sink, never to stderr fields (spec §8).
 */

const log = createLogger('mcode:llm');

/** Depth cap keeps the byte estimation walk bounded on hostile shapes. */
const MAX_ESTIMATE_DEPTH = 6;

export interface TurnLlmCallObservation {
  /** Best-effort observer of the final main-agent request view. */
  readonly onLlmCallPrepared: PiOnLlmCallPreparedHook;
  /** Best-effort observer of the logical call outcome. */
  readonly afterLlmCall: PiAfterLlmCallHook;
  /**
   * Transparent event-writer wrapper that records the first stream event after
   * a prepared call as its first token. Events, order and awaits are unchanged.
   */
  wrapEventWriter<TWriter extends PiEventWriter>(writer: TWriter): TWriter;
}

interface CallTimingState {
  preparedAtMs?: number;
  awaitingFirstToken: boolean;
  firstTokenAtMs?: number;
}

export function createTurnLlmCallObservation(input: {
  readonly sessionId: string;
  readonly turnId: string;
}): TurnLlmCallObservation {
  const state: CallTimingState = { awaitingFirstToken: false };

  const onLlmCallPrepared: PiOnLlmCallPreparedHook = (prepared) => {
    const startedAtMs = performance.now();
    state.preparedAtMs = startedAtMs;
    state.awaitingFirstToken = true;
    state.firstTokenAtMs = undefined;
    const messages = prepared.messages.length;
    const tools = prepared.tools.length;
    // The byte scan is O(content); guard it so the default info level pays
    // nothing (spec §7 hot-path hygiene).
    const bytes = log.enabled('debug') ? estimateJsonBytes(prepared.messages) : undefined;
    log.debug('llm request', {
      sessionId: input.sessionId,
      turnId: input.turnId,
      phase: prepared.phase,
      scope: prepared.scope,
      model: prepared.model.id,
      provider: prepared.model.provider,
      api: prepared.model.api,
      messages,
      tools,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(prepared.maxTokens !== undefined ? { maxTokens: prepared.maxTokens } : {}),
      thinkingLevel: prepared.thinkingLevel,
    });
    traffic('llm.request', {
      sessionId: input.sessionId,
      turnId: input.turnId,
      phase: prepared.phase,
      scope: prepared.scope,
      model: {
        id: prepared.model.id,
        provider: prepared.model.provider,
        api: prepared.model.api,
      },
      ...(prepared.maxTokens !== undefined ? { maxTokens: prepared.maxTokens } : {}),
      thinkingLevel: prepared.thinkingLevel,
      systemPrompt: prepared.systemPrompt,
      tools: prepared.tools,
      messages: prepared.messages,
    });
  };

  const afterLlmCall: PiAfterLlmCallHook = ({ message }) => {
    const preparedAtMs = state.preparedAtMs;
    state.awaitingFirstToken = false;
    const durationMs =
      preparedAtMs === undefined ? undefined : Math.max(0, performance.now() - preparedAtMs);
    const latencyMs =
      state.firstTokenAtMs === undefined || preparedAtMs === undefined
        ? undefined
        : Math.max(0, state.firstTokenAtMs - preparedAtMs);
    const usage = message.usage;
    const fields = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      model: message.model,
      provider: message.provider,
      api: message.api,
      finishReason: message.stopReason,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(usage
        ? {
            usageInput: usage.input,
            usageOutput: usage.output,
            usageCacheRead: usage.cacheRead,
            usageCacheWrite: usage.cacheWrite,
          }
        : {}),
    };
    if (message.stopReason === 'error') {
      log.error('llm call failed', { ...fields, err: errorMessageAsError(message.errorMessage) });
    } else {
      log.debug('llm call settled', fields);
    }
    traffic('llm.response', {
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      stopReason: message.stopReason,
      ...(usage ? { usage } : {}),
      message,
    });
    return undefined;
  };

  return {
    onLlmCallPrepared,
    afterLlmCall,
    wrapEventWriter: (writer) => {
      const markFirstStreamEvent = (): void => {
        if (!state.awaitingFirstToken) return;
        state.awaitingFirstToken = false;
        state.firstTokenAtMs = performance.now();
      };
      return {
        ...writer,
        pushRuntime: async (event) => {
          markFirstStreamEvent();
          await writer.pushRuntime(event);
        },
        appendEvents: async (events) => {
          if (events.length > 0) markFirstStreamEvent();
          await writer.appendEvents(events);
        },
      };
    },
  };
}

/**
 * Physical provider request failure (each retry attempt reports separately;
 * user cancellation never reaches this hook). `injected` keeps any host hook
 * wired before instrumentation — logging is additive and never replaces it.
 */
export function logLlmRequestFailure(
  injected: ((info: PiLLMRequestFailureInfo) => void) | undefined,
): (info: PiLLMRequestFailureInfo) => void {
  return (info) => {
    log.error('llm request failed', {
      err: info.error ?? info.providerError ?? errorMessageAsError(info.errorMessage),
      errorKind: info.metricKind,
      provider: info.request.provider,
      model: info.request.model,
      api: info.request.api,
      baseUrl: info.request.baseUrl,
      caller: info.request.caller,
    });
    if (!injected) return;
    try {
      injected(info);
    } catch {
      // The injected hook is best effort by contract; failure stays silent.
    }
  };
}

function errorMessageAsError(message: string | undefined): Error {
  const error = new Error(message === undefined || message.length === 0 ? 'llm call failed' : message);
  error.name = 'LLMCallError';
  return error;
}

/**
 * Utf8 byte estimate over the provider-visible message payload:
 * Buffer.byteLength per string, no JSON dumps or allocations (spec §7). The
 * `details` subtree of message records is excluded — tool-result byproducts and
 * reminder payloads under that key are read by the UI / caller and never reach
 * the provider, so counting them inflated the metric (pi `ToolResultMessage`
 * carries provider-invisible `details`; providers serialize `content` only).
 * Callers gate it on an enabled level.
 */
function estimateJsonBytes(value: unknown, depth = 0): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value !== 'object' || value === null || depth >= MAX_ESTIMATE_DEPTH) return 0;
  const record = value as Record<string, unknown>;
  let total = 0;
  for (const [key, item] of Object.entries(record)) {
    // Only message records carry the internal `details`; a `details` key inside
    // provider-visible payloads (e.g. model-produced tool-call arguments) has
    // no `role` sibling and keeps counting.
    if (key === 'details' && typeof record['role'] === 'string') continue;
    total += estimateJsonBytes(item, depth + 1);
  }
  return total;
}
