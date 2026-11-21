import type { StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext } from '@earendil-works/pi-ai';

export class RequestForkIneligibleError extends Error {
  override readonly name = 'RequestForkIneligibleError';
}

/**
 * One builder/transport for the main call and its summary fork. Freeze the
 * normalized request, then also capture its final provider payload after the
 * caller's onPayload hook. A fork must preserve that encoded prefix, including
 * explicit cache breakpoints; an adapter repair cannot silently change it.
 */
export function createRequestFork(
  inner: StreamFn,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
) {
  const frozenModel = structuredClone(model);
  const imageIndex = context.messages.findIndex((message) =>
    'content' in message && Array.isArray(message.content) && message.content.some((block) => block.type === 'image')
  );
  // Never retain image bytes in a summary snapshot, even in an unused suffix.
  const messages = structuredClone(context.messages.slice(0, imageIndex < 0 ? undefined : imageIndex));
  const inherited = {
    ...options,
    ...(options?.headers ? { headers: { ...options.headers } } : {}),
    ...(options?.thinkingBudgets ? { thinkingBudgets: { ...options.thinkingBudgets } } : {}),
    ...(options?.samplingParams ? { samplingParams: structuredClone(options.samplingParams) } : {}),
  };
  let mainContext: typeof context | undefined = context;
  let payload: unknown;
  let captureClosed = false;
  let captureCount = 0;
  const transform = async (value: unknown, requestModel: typeof model) =>
    (await inherited.onPayload?.(value, requestModel)) ?? value;
  return {
    prefixLength: messages.length,
    canFork: () => !!payload && typeof payload === 'object' && Array.isArray(Reflect.get(payload, 'messages')),
    /** Send the main call through the same builder, observing its final payload. */
    main(mainStream: StreamFn = inner) {
      if (!mainContext) throw new Error('Prepared main request was already sent');
      const requestContext = mainContext;
      mainContext = undefined;
      const stream = mainStream(model, requestContext, {
        ...options,
        onPayload: async (value, requestModel) => {
          const prepared = await transform(value, requestModel);
          if (captureClosed) return prepared;
          captureCount += 1;
          try {
            if (captureCount === 1 && prepared && typeof prepared === 'object' && Array.isArray(Reflect.get(prepared, 'messages'))) {
              const encodedMessages = Reflect.get(prepared, 'messages') as unknown[];
              const firstImage = encodedMessages.findIndex(containsImage);
              payload = structuredClone({ ...prepared, messages: encodedMessages.slice(0, firstImage < 0 ? undefined : firstImage) });
            } else payload = undefined;
          } catch { payload = undefined; }
          return prepared;
        },
      });
      void Promise.resolve(stream).then((response) => response.result()).finally(() => {
        // Keep-alive replays may retain this callback, but never its mutable capture.
        captureClosed = true;
      }).catch(() => undefined);
      return stream;
    },
    stream(prefixLength: number, instruction: string, signal?: AbortSignal, maxOutputTokens?: number) {
      const prefix = messages.slice(0, prefixLength);
      if (prefix.length !== prefixLength || prefixLength <= 0) {
        throw new RequestForkIneligibleError('Request fork requires a complete image-free prefix');
      }
      const pending = new Set<string>();
      for (const message of prefix) {
        if (message.role === 'assistant') for (const block of message.content) {
          if (block.type === 'toolCall') pending.add(block.id);
        }
        if (message.role === 'toolResult' && !pending.delete(message.toolCallId)) {
          throw new RequestForkIneligibleError('Request fork contains an orphan tool result');
        }
      }
      if (pending.size) throw new RequestForkIneligibleError('Request fork ends inside a tool round');
      return inner(frozenModel, normalizeContext({ messages: [
        ...structuredClone(prefix), { role: 'user', content: instruction, timestamp: 0 },
      ] }), {
        ...inherited,
        ...(maxOutputTokens !== undefined ? {
          maxTokens: Math.min(maxOutputTokens, inherited.maxTokens ?? (frozenModel.maxTokens > 0 ? frozenModel.maxTokens : maxOutputTokens)),
        } : {}),
        // Cancellation belongs to this call, not the already-settled main call.
        signal,
        onPayload: async (value, requestModel) => {
          const prepared = await transform(value, requestModel);
          preserveEncodedPrefix(payload, prepared);
          if (containsImage(prepared)) throw new RequestForkIneligibleError('Request fork payload contains an image');
          return prepared;
        },
      });
    },
  };
}

function containsImage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (['image', 'image_url', 'input_image'].includes(String(Reflect.get(value, 'type')))) return true;
  return Object.values(value).some(containsImage);
}

/** Cache-control metadata may move when an adapter appends the directive.
 * Preserve the main prefix's original markers, after checking all other bytes.
 * Unsupported payload shapes fail closed rather than claiming cache identity.
 */
function preserveEncodedPrefix(main: unknown, fork: unknown): void {
  if (!main || typeof main !== 'object' || !fork || typeof fork !== 'object') {
    throw new RequestForkIneligibleError('Request fork has no captured provider payload');
  }
  const mainMessages = Reflect.get(main, 'messages');
  const forkMessages = Reflect.get(fork, 'messages');
  if (!Array.isArray(mainMessages) || !Array.isArray(forkMessages)) {
    throw new RequestForkIneligibleError('Request fork adapter has no message-prefix contract');
  }
  const keys = new Set([...Object.keys(main), ...Object.keys(fork)]);
  keys.delete('messages');
  // Output capacity is recomputed by the SAME adapter for the appended task.
  // Thinking/budget/effort must still match; those remain in the comparison.
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) keys.delete(key);
  for (const key of keys) {
    if (JSON.stringify(Reflect.get(main, key)) !== JSON.stringify(Reflect.get(fork, key))) {
      throw new RequestForkIneligibleError(`Request fork changed provider ${key}`);
    }
  }
  const length = forkMessages.length - 1;
  if (length > mainMessages.length || JSON.stringify(withoutCacheControl(forkMessages.slice(0, length))) !==
      JSON.stringify(withoutCacheControl(mainMessages.slice(0, length)))) {
    throw new RequestForkIneligibleError('Request fork changed the encoded message prefix');
  }
  for (let index = 0; index < length; index += 1) forkMessages[index] = structuredClone(mainMessages[index]);
  // Read the existing anchor; the summary directive needs no new checkpoint.
  // This also stays within Anthropic's four-breakpoint limit.
  forkMessages[length] = withoutCacheControl(forkMessages[length]);
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key,
      // Anthropic wraps string content in a text block when adding a marker.
      key === 'content' && typeof item === 'string' ? [{ type: 'text', text: item }] : withoutCacheControl(item),
    ]),
  );
  return value;
}
