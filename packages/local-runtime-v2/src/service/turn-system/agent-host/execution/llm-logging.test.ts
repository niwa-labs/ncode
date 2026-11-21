import type { PiLlmCallPreparedHookInput } from '@mavis/agent-core/pi-turn-runner';
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggingCalls = vi.hoisted(() => {
  const debugEvents: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  return { debugEvents };
});

vi.mock('@mavis/logging', () => ({
  createLogger: () => ({
    trace: () => undefined,
    debug: (msg: string, fields?: Record<string, unknown>) => {
      loggingCalls.debugEvents.push({ msg, fields: fields ?? {} });
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => {
      throw new Error('child() is not used by llm-logging');
    },
    enabled: (level: string) => level === 'debug',
  }),
  traffic: () => undefined,
}));

import { createTurnLlmCallObservation } from './llm-logging.js';

/** A message record as the provider sees it: every string except the internal
 * `details` subtree of message records is serialized (pi providers carry
 * `content` only and drop `ToolResultMessage.details`). */
function providerVisibleBytes(value: unknown, depth = 0): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value !== 'object' || value === null || depth >= 6) return 0;
  const record = value as Record<string, unknown>;
  let total = 0;
  for (const [key, item] of Object.entries(record)) {
    if (key === 'details' && typeof record['role'] === 'string') continue;
    total += providerVisibleBytes(item, depth + 1);
  }
  return total;
}

/** Same walk without the `details` exclusion — the inflated legacy estimate. */
function naiveMessageBytes(value: unknown, depth = 0): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value !== 'object' || value === null || depth >= 6) return 0;
  let total = 0;
  for (const item of Object.values(value as Record<string, unknown>)) {
    total += naiveMessageBytes(item, depth + 1);
  }
  return total;
}

function fileReadToolResultMessage(details: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'toolResult',
    toolCallId: 'toolcall_1',
    toolName: 'read',
    content: [{ type: 'text', text: 'const answer = 42;\n' }],
    isError: false,
    details,
    timestamp: 1_700_000_000_000,
  };
}

function preparedInput(messages: readonly unknown[]): PiLlmCallPreparedHookInput {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    phase: 'initial',
    scope: 'agent',
    messages,
    model: { id: 'model-1', provider: 'test-provider', api: 'openai-completions' },
    systemPrompt: 'You are a test.',
    tools: [{ name: 'read', description: 'Read a file.', parameters: {} }],
    thinkingLevel: 'off',
  } as unknown as PiLlmCallPreparedHookInput;
}

describe('createTurnLlmCallObservation bytes metric', () => {
  beforeEach(() => {
    loggingCalls.debugEvents.length = 0;
  });

  it('llm request bytes matches the provider-visible payload when details dominate (spec §4 mcode:llm)', () => {
    // File-read byproduct: two orders of magnitude above the wire content.
    const bigDetails = {
      file: '/repo/src/big-generated-module.ts',
      lines: Array.from({ length: 512 }, (_, index) => `line ${index}: ${'x'.repeat(96)}`),
    };
    const messages = [
      { role: 'user', content: 'Read the generated module.', timestamp: 1 },
      fileReadToolResultMessage(bigDetails),
    ];

    const observation = createTurnLlmCallObservation({
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    observation.onLlmCallPrepared(preparedInput(messages));

    const request = loggingCalls.debugEvents.find((event) => event.msg === 'llm request');
    expect(request).toBeDefined();
    const loggedBytes = request?.fields['bytes'];
    expect(typeof loggedBytes).toBe('number');

    const providerVisible = providerVisibleBytes(messages);
    const naive = naiveMessageBytes(messages);
    // The metric equals the provider-visible walk...
    expect(loggedBytes).toBe(providerVisible);
    // ...the input actually carries a dominant details subtree...
    expect(naive).toBeGreaterThan(providerVisible * 50);
    // ...and the subtraction logic reconciles: the excluded subtree accounts
    // for the whole naive/provider gap.
    expect(naive - providerVisible).toBeGreaterThanOrEqual(
      providerVisibleBytes(bigDetails.lines),
    );
  });

  it('details keys inside provider-visible payloads (model arguments) keep counting', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'toolcall_1',
            name: 'read',
            // Model-produced JSON the provider does receive.
            arguments: { details: 'provider-visible argument payload'.repeat(8) },
          },
        ],
        timestamp: 2,
      },
    ];

    const observation = createTurnLlmCallObservation({
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    observation.onLlmCallPrepared(preparedInput(messages));

    const request = loggingCalls.debugEvents.find((event) => event.msg === 'llm request');
    expect(request?.fields['bytes']).toBe(providerVisibleBytes(messages));
    expect(request?.fields['bytes']).toBeGreaterThan(
      Buffer.byteLength('provider-visible argument payload'),
    );
  });
});
