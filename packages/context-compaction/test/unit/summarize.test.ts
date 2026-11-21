/**
 * Summary generation through the resolved model — the pin's output-limit fix
 * (commit 6fcb48670) and the rejection/routing contracts (V-K02/V-K03/V-K04).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUMMARY_OUTPUT_HOST_CAP,
  SummaryRejectedError,
  createModelSummarizer,
  getSummarizationFailure,
  resolveSummaryMaxOutputTokens,
  serializeConversation,
  type SummaryRequest,
  type SummaryResponse,
} from '../../src/index.js';

describe('resolveSummaryMaxOutputTokens (V-K03: model output limit, never reserve)', () => {
  it('uses the model output ceiling when known and below the host cap', () => {
    expect(resolveSummaryMaxOutputTokens({ provider: 'p', modelId: 'm', maxTokens: 8192 })).toBe(8192);
  });

  it('falls back to the explicit host cap when the ceiling is unknown', () => {
    expect(resolveSummaryMaxOutputTokens({ provider: 'p', modelId: 'm', maxTokens: 0 })).toBe(
      DEFAULT_SUMMARY_OUTPUT_HOST_CAP,
    );
    expect(resolveSummaryMaxOutputTokens({ provider: 'p', modelId: 'm' })).toBe(DEFAULT_SUMMARY_OUTPUT_HOST_CAP);
    expect(
      resolveSummaryMaxOutputTokens({ provider: 'p', modelId: 'm' }, 2048),
    ).toBe(2048);
  });

  it('clamps a huge ceiling to the host cap but NEVER to a reserve share', () => {
    expect(resolveSummaryMaxOutputTokens({ provider: 'p', modelId: 'm', maxTokens: 1_000_000 })).toBe(
      DEFAULT_SUMMARY_OUTPUT_HOST_CAP,
    );
    // The pin's removed formulas: 0.8*reserve (13107 by default) and
    // 0.5*reserve for turn prefixes, 4096 for branch summaries. NONE of them
    // may reappear: the API takes no reserve input at all (asserted by the
    // signature below having no third parameter to abuse).
    const source = resolveSummaryMaxOutputTokens.toString();
    expect(source).not.toContain('reserve');
  });
});

describe('getSummarizationFailure (pin failure detection)', () => {
  const ok: SummaryResponse = { text: 'summary', stopReason: 'stop' };

  it('accepts a clean stop with text', () => {
    expect(getSummarizationFailure(ok, 'Summarization')).toBeUndefined();
  });

  it('rejects error stops with the provider message', () => {
    expect(
      getSummarizationFailure({ text: '', stopReason: 'error', errorMessage: 'boom' }, 'Summarization'),
    ).toBe('Summarization failed: boom');
  });

  it('rejects length stops — partial text must not become a checkpoint', () => {
    expect(getSummarizationFailure({ text: 'partial…', stopReason: 'length' }, 'Summarization')).toBe(
      'Summarization failed: generation hit the token cap and the summary is incomplete',
    );
  });

  it('rejects cancellation even when partial text exists', () => {
    expect(getSummarizationFailure({ text: 'partial', stopReason: 'aborted' }, 'S')).toBe('S failed: request was aborted');
  });

  it('rejects tool-call attempts and empty text', () => {
    expect(getSummarizationFailure({ text: 'ok', stopReason: 'stop', hasToolCall: true }, 'S')).toBe(
      'S attempted to call a tool',
    );
    expect(getSummarizationFailure({ text: '   ', stopReason: 'stop' }, 'S')).toBe('S produced no text');
  });
});

describe('createModelSummarizer (routing + rejection, V-K04)', () => {
  function transportReturning(response: SummaryResponse) {
    const requests: SummaryRequest[] = [];
    const transport = async (request: SummaryRequest): Promise<SummaryResponse> => {
      requests.push(request);
      return response;
    };
    return { requests, transport };
  }

  it('sends cacheRetention none and forwards the explicit routing id', async () => {
    const { requests, transport } = transportReturning({ text: 's', stopReason: 'stop' });
    const summarizer = createModelSummarizer(
      { provider: 'p', modelId: 'm', maxTokens: 4096 },
      transport,
      { sessionId: 'session-1' },
    );
    await summarizer('prompt');
    expect(requests[0]).toMatchObject({
      cacheRetention: 'none',
      sessionId: 'session-1',
      maxOutputTokens: 4096,
    });
  });

  it('mints a FRESH routing id when no explicit one is given', async () => {
    const { requests, transport } = transportReturning({ text: 's', stopReason: 'stop' });
    const summarizer = createModelSummarizer({ provider: 'p', modelId: 'm' }, transport);
    await summarizer('prompt-1');
    await summarizer('prompt-2');
    const [first, second] = requests;
    expect(first!.sessionId).toMatch(/^summary-/);
    expect(second!.sessionId).toMatch(/^summary-/);
    expect(first!.sessionId).not.toBe(second!.sessionId);
  });

  it('reasoning defaults off; a reasoning model forwards the requested level', async () => {
    const plain = transportReturning({ text: 's', stopReason: 'stop' });
    await createModelSummarizer({ provider: 'p', modelId: 'm', reasoning: false }, plain.transport, {
      thinkingLevel: 'high',
    })('p');
    expect(plain.requests[0]!.reasoning).toBe('off');

    const reasoning = transportReturning({ text: 's', stopReason: 'stop' });
    await createModelSummarizer({ provider: 'p', modelId: 'm', reasoning: true }, reasoning.transport, {
      thinkingLevel: 'high',
    })('p');
    expect(reasoning.requests[0]!.reasoning).toBe('high');
  });

  it('a rejected response throws SummaryRejectedError BEFORE any caller can publish', async () => {
    const { transport } = transportReturning({ text: 'partial', stopReason: 'length' });
    const summarizer = createModelSummarizer({ provider: 'p', modelId: 'm' }, transport);
    await expect(summarizer('prompt')).rejects.toBeInstanceOf(SummaryRejectedError);
    await expect(summarizer('prompt')).rejects.toThrow(/token cap/);
  });

  it('a tool-call response is rejected with the pin message', async () => {
    const { transport } = transportReturning({ text: 'ok', stopReason: 'stop', hasToolCall: true });
    const summarizer = createModelSummarizer({ provider: 'p', modelId: 'm' }, transport);
    await expect(summarizer('prompt')).rejects.toThrow(/attempted to call a tool/);
  });
});

describe('serializeConversation excludes thinking from summary INPUT (V-K02)', () => {
  it('thinking blocks never reach the summarizer prompt', () => {
    // Pre-existing behavior of serialize.ts (documented as ours since the
    // package's first cut — the plan's risk note says not to credit the pin
    // port for it); pinned here because V-K02 requires it. A huge reasoning
    // transcript must not inflate the summary request.
    const hugeReasoning = 'R'.repeat(100_000);
    const conversation = serializeConversation([
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: hugeReasoning },
          { type: 'text', text: 'done' },
        ],
      } as never,
    ]);
    expect(conversation).toContain('[User]: do the thing');
    expect(conversation).toContain('[Assistant]: done');
    expect(conversation).not.toContain('R'.repeat(100));
    expect(conversation.length).toBeLessThan(1000);
  });
});
