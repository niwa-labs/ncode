import type { AgentExtension } from '@mavis/agent-runtime';
import {
  OUTPUT_LIMIT_EXHAUSTED_REASON,
  OUTPUT_LIMIT_RETRY_REASON,
  decideOutputLimitRecovery,
} from '@mavis/context-manager';

export interface OutputLimitRecoveryObservation {
  readonly sessionId: string;
  readonly turnId: string;
  /** Recovery requests made for this step, including the one being reported. */
  readonly attempts: number;
  /** Whether the cut-off response was writing a tool call (retry and exhausted only). */
  readonly truncatedToolCall?: boolean;
  readonly model?: string;
}

export interface OutputLimitRecoveryExtensionOptions {
  readonly maxRetries?: number;
  readonly onRetry?: (observation: OutputLimitRecoveryObservation) => void | Promise<void>;
  readonly onRecovered?: (observation: OutputLimitRecoveryObservation) => void | Promise<void>;
  readonly onExhausted?: (observation: OutputLimitRecoveryObservation) => void | Promise<void>;
  readonly id?: string;
  readonly description?: string;
}

/**
 * М2 (our seam): a response cut off by the output limit BEFORE any visible
 * reply is dropped and the request repeated with a brief-reasoning hint;
 * once the retries are spent the turn fails with a stable visible marker.
 * The retry count reads from the transcript itself — no state between
 * turns. This is the OUTPUT limit, deliberately separate from the context
 * overflow path (В1 barrier), and it never re-runs an effectful tool call:
 * the cut-off response is discarded, not resumed.
 */
export function createOutputLimitRecoveryExtension(
  options: OutputLimitRecoveryExtensionOptions = {},
): AgentExtension {
  return {
    id: options.id ?? 'output-limit-recovery',
    description:
      options.description ??
      'Retry a response cut off by the output limit before any visible reply, with a hint to reason briefly.',
    init(pi) {
      pi.on('after_llm_call', async (event, ctx) => {
        const decision = decideOutputLimitRecovery(
          event.message,
          event.messages,
          options.maxRetries,
        );
        const model = typeof event.message.model === 'string' ? event.message.model : undefined;
        const base = { sessionId: ctx.sessionId, turnId: ctx.turnId, ...(model ? { model } : {}) };
        switch (decision.kind) {
          case 'none':
            return { type: 'continue' };
          case 'recovered':
            await notify(options.onRecovered, { ...base, attempts: decision.attempts });
            return { type: 'continue' };
          case 'retry':
            await notify(options.onRetry, {
              ...base,
              attempts: decision.attempts,
              ...(decision.truncatedToolCall ? { truncatedToolCall: true } : {}),
            });
            return { type: 'retry', reason: OUTPUT_LIMIT_RETRY_REASON, prompt: decision.prompt };
          case 'exhausted':
            await notify(options.onExhausted, {
              ...base,
              attempts: decision.attempts,
              ...(decision.truncatedToolCall ? { truncatedToolCall: true } : {}),
            });
            return { type: 'fail', reason: OUTPUT_LIMIT_EXHAUSTED_REASON };
        }
      });
    },
  };
}

async function notify(
  observer: OutputLimitRecoveryExtensionOptions['onRetry'],
  value: OutputLimitRecoveryObservation,
): Promise<void> {
  if (!observer) return;
  try {
    await observer(value);
  } catch {
    // Observability must not change recovery semantics.
  }
}
