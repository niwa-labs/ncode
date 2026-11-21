import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  ContextOperationStore,
  contextDigest,
  responseDigest,
} from './context-operation-store.js';

/** One durable receipt per physical SDK invocation, shared by normal and summary requests. */
export function withRequestReceipts(
  inner: StreamFn,
  store: ContextOperationStore | undefined,
  sessionId: string,
  turnId: string,
  kind: 'agent' | 'compaction',
): StreamFn {
  if (!store) return inner;
  return async (model, context, options) => {
    const receipt = await store.begin({
      sessionId,
      turnId,
      kind,
      model: `${model.provider}/${model.id}`,
      planDigest: contextDigest(context),
    });
    if (options?.signal?.aborted) {
      await store.record(receipt, 'not_sent');
      throw new DOMException('Request aborted before dispatch', 'AbortError');
    }
    // Intent is durable BEFORE invoking SDK code. It is not proof of sending.
    await store.record(receipt, 'dispatch_intent');
    if (options?.signal?.aborted) {
      await store.record(receipt, 'not_sent');
      throw new DOMException(
        'Request aborted before SDK invocation',
        'AbortError',
      );
    }
    try {
      const stream = await inner(model, context, {
        ...options,
        onPayload: async (payload, requestModel) => {
          const prepared =
            (await options?.onPayload?.(payload, requestModel)) ?? payload;
          await store.record(receipt, 'dispatch_intent', {
            payloadDigest: contextDigest(prepared),
          });
          return prepared;
        },
      });
      const originalResult = stream.result.bind(stream);
      const result = originalResult().then(
        async (message) => {
          const phase =
            message.stopReason === 'error'
              ? 'failed'
              : message.stopReason === 'aborted'
                ? 'aborted'
                : 'response_received';
          await store.record(receipt, phase, {
            responseDigest: responseDigest(message),
            stopReason: message.stopReason,
            usage: message.usage,
          });
          Reflect.set(message, 'requestReceiptId', receipt.id);
          return message;
        },
        async (error) => {
          await store.record(receipt, 'unknown');
          throw error;
        },
      );
      // The agent awaits result() before committing/executing its tool calls.
      // Persist the receipt before exposing that final result to the caller.
      stream.result = () => result;
      void result.catch(() => undefined);
      return stream;
    } catch (error) {
      await store.record(receipt, 'unknown');
      throw error;
    }
  };
}
