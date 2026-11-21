import { describe, expect, it } from 'vitest';

import {
  classifyFinishStepError,
  classifyLLMError,
  classifyLLMErrorToCode,
  isLLMProviderRefusalMessage,
  normalizeLLMError,
  toLLMRetryDecision,
  type LLMErrorInput,
} from './llm-error-classifier.js';

function normalize(input: LLMErrorInput) {
  return normalizeLLMError(input);
}

describe('llm-error-classifier transient network wordings (pin retry fixes)', () => {
  it.each([
    // pi 698a2d23b (#10920): gateway upstream failures relayed as
    // `response.failed` codes without an HTTP status.
    'OpenAI Responses API error (500): {"error":{"code":"upstream_stream_read_error"}}',
    'upstream request failed',
    'unable-to-forward: upstream request failed while relaying the stream',
    // The same pi pattern (`upstream.?request.?failed`) also covers the
    // code-shaped relay forms the gateway composes as
    // `"${error.code}: ${error.message}"` — regress both spellings.
    'upstream_request_failed',
    'upstream-request-failed: while relaying the response stream',
    'The stream was interrupted before the final response event',
    'http2 stream failed',
    'http/2 stream failed',
    // pi 0fbdbd3f8 (#10996): node-fetch system errors with an empty reason.
    'request to https://oauth2.googleapis.com/token failed, reason:',
    'request to https://example.invalid failed, reason: connect ECONNREFUSED',
  ])('classifies %j as retryable network', (errorMessage) => {
    const normalized = normalize({ errorMessage });
    expect(normalized.facts.signals.has('network')).toBe(true);
    expect(toLLMRetryDecision(normalized)).toMatchObject({ retryable: true, reason: 'network' });
  });

  it.each([
    // Deterministic rejections must stay non-retryable despite new patterns.
    'invalid_request_error: request to many tools',
    'Too many images in request: 31 > 30',
  ])('does not misclassify %j as network', (errorMessage) => {
    expect(normalize({ errorMessage }).facts.signals.has('network')).toBe(false);
  });

  it('keeps the pre-existing transient wordings retryable', () => {
    for (const errorMessage of ['fetch failed', 'network error while reading body', 'ECONNRESET']) {
      const normalized = normalize({ errorMessage });
      expect(normalized.facts.signals.has('network')).toBe(true);
      expect(toLLMRetryDecision(normalized).retryable).toBe(true);
    }
  });

  it('upstream wordings with an HTTP 429 status stay retryable', () => {
    // The classifier's precedence puts a transport signal ahead of the 429
    // mapping (both retryable); the guarantee that matters here is that the
    // gateway wording never turns a throttled request terminal.
    const normalized = normalize({ errorMessage: 'upstream request failed', statusCode: 429 });
    expect(toLLMRetryDecision(normalized).retryable).toBe(true);
  });

  it('a bare HTTP 413 stays the deterministic overflow verdict', () => {
    // No transport wording in the body: the overflow recovery path
    // (compact-and-retry) owns it, not the transport retry loop.
    const normalized = normalize({
      errorMessage: 'Copilot API error (413): {"message":"failed to parse request","code":""}',
      statusCode: 413,
    });
    expect(normalized.facts.signals.has('network')).toBe(false);
    expect(toLLMRetryDecision(normalized).retryable).toBe(false);
  });
});

describe('llm-error-classifier refusal marker (registry PR-03 №2, W06)', () => {
  it.each([
    // Raw SDK body forms.
    'anthropic error: stop_reason: refusal, explanation omitted',
    '{"type":"error","error":{"stop_reason":"refusal"}}',
    // The pinned adapter\'s normalized HTTP-200 refusal fallback
    // (api/anthropic-messages.ts mapStopReason) and its explanation form.
    'The model refused to complete the request',
    'the model refused to complete the request',
  ])('marks %j as a provider refusal', (errorMessage) => {
    expect(isLLMProviderRefusalMessage(errorMessage)).toBe(true);
    const normalized = normalize({ errorMessage, finishReason: 'error' });
    expect(normalized.facts.signals.has('refusal')).toBe(true);
    expect(toLLMRetryDecision(normalized)).toMatchObject({
      retryable: false,
      reason: 'content_filter',
    });
  });

  it('does not mark ordinary refusals of transport work as provider refusals', () => {
    expect(isLLMProviderRefusalMessage('upstream request failed')).toBe(false);
    expect(isLLMProviderRefusalMessage('the request was refused by the proxy')).toBe(false);
  });
});

describe('llm-error-classifier structural provider stop reasons (W06 review fix)', () => {
  // The pinned pi-ai adapters keep the provider's raw stop reason on the
  // assistant message (`AssistantMessage.rawStopReason`) before mapping
  // `refusal`/`sensitive` to `stopReason:"error"` with an arbitrary provider
  // explanation as `errorMessage` (api/anthropic-messages.ts mapStopReason).
  // The structural field — not the text — is the reliable signal.
  it('marks a refusal with an arbitrary provider explanation via rawStopReason', () => {
    const normalized = normalize({
      finishReason: 'error',
      errorMessage: 'The assistant declined because company policy forbids weapon instructions.',
      rawStopReason: 'refusal',
    });
    expect(normalized.facts.rawStopReason).toBe('refusal');
    expect(normalized.facts.signals.has('refusal')).toBe(true);
    expect(normalized.facts.signals.has('content_filter')).toBe(true);
    expect(normalized.sanitizedMessage).toBe(
      'The assistant declined because company policy forbids weapon instructions.',
    );
    expect(toLLMRetryDecision(normalized)).toMatchObject({
      retryable: false,
      reason: 'content_filter',
    });
  });

  it('marks the sensitive safety stop via rawStopReason (not retryable, content_filter)', () => {
    const normalized = normalize({
      finishReason: 'error',
      errorMessage: 'Provider stopped with: sensitive',
      rawStopReason: 'sensitive',
    });
    expect(normalized.facts.signals.has('content_filter')).toBe(true);
    expect(normalized.facts.signals.has('refusal')).toBe(false);
    expect(toLLMRetryDecision(normalized)).toMatchObject({
      retryable: false,
      reason: 'content_filter',
    });
  });

  it('collects rawStopReason from a raw assistant-message-like object', () => {
    const normalized = normalize({
      raw: {
        stopReason: 'error',
        rawStopReason: 'refusal',
        errorMessage: 'arbitrary provider explanation',
      },
    });
    expect(normalized.facts.signals.has('refusal')).toBe(true);
  });

  it('documents the text-marker limit: an explanation without the fallback wording is not a text refusal', () => {
    // Exactly the review case: the provider sent `explanation`, the fallback
    // text ("The model refused to complete the request") never appears, and
    // without the structural field nothing matches — which is why the
    // structural rawStopReason path above is the primary signal.
    const normalized = normalize({
      finishReason: 'error',
      errorMessage: 'The assistant declined because company policy forbids weapon instructions.',
    });
    expect(normalized.facts.signals.has('refusal')).toBe(false);
    expect(normalized.facts.rawStopReason).toBeUndefined();
  });

  it('classifyFinishStepError marks refusal and sensitive stops structurally', () => {
    expect(
      classifyFinishStepError({
        finishReason: 'error',
        errorMessage: 'arbitrary explanation',
        rawStopReason: 'refusal',
      }),
    ).toBe('content_filter');
    expect(
      classifyFinishStepError({
        finishReason: 'error',
        errorMessage: 'Provider stopped with: sensitive',
        rawStopReason: 'sensitive',
      }),
    ).toBe('content_filter');
  });

  it('classifyLLMErrorToCode never derives a status code from a structural refusal or safety stop', () => {
    expect(
      classifyLLMErrorToCode('arbitrary explanation', { rawStopReason: 'refusal' }),
    ).toBeNull();
    expect(
      classifyLLMErrorToCode('Provider stopped with: sensitive', { rawStopReason: 'sensitive' }),
    ).toBeNull();
    expect(classifyLLMErrorToCode({ message: 'arbitrary', rawStopReason: 'sensitive' })).toBeNull();
  });

  it('classifyLLMError marks structural refusal/safety objects as content_filter', () => {
    expect(classifyLLMError({ rawStopReason: 'refusal', message: 'arbitrary' })).toBe(
      'content_filter',
    );
    expect(classifyLLMError({ rawStopReason: 'sensitive', message: 'arbitrary' })).toBe(
      'content_filter',
    );
  });
});

describe('llm-error-classifier availability statuses (the live "ретраи сломаны" fix)', () => {
  it.each([502, 503, 504])('retries the gateway availability status %i (CDN HTML body included)', (status) => {
    const normalized = normalize({
      statusCode: status,
      errorMessage:
        status === 504
          ? '<HTML><HEAD><TITLE>Error</TITLE></HEAD><BODY>An error occurred while processing your request.</BODY></HTML>'
          : 'service unavailable',
    });
    expect(toLLMRetryDecision(normalized)).toMatchObject({ retryable: true, reason: 'network' });
  });

  it('retries a relayed 50113 whose message says temporarily unavailable (no HTTP status)', () => {
    const normalized = normalize({
      raw: { errorCode: 50113, message: 'The model provider is temporarily unavailable.' },
    });
    expect(normalized.facts.existingProtocolCode).toBe(50113);
    expect(normalized.facts.httpStatus).toBeUndefined();
    expect(toLLMRetryDecision(normalized)).toMatchObject({ retryable: true, reason: 'network' });
  });

  it('keeps 500 and unknown statuses fail-closed', () => {
    expect(toLLMRetryDecision(normalize({ statusCode: 500, errorMessage: 'boom' })).retryable).toBe(false);
    expect(toLLMRetryDecision(normalize({ statusCode: 418, errorMessage: 'teapot' })).retryable).toBe(false);
  });

  it('a 4xx re-labelled 50113 NEVER becomes retryable, with or without the transient wording', () => {
    // Explicit status wins: permanent rejection must stay terminal.
    const withStatus = normalize({
      raw: { statusCode: 400, errorCode: 50113, message: 'The model provider is temporarily unavailable.' },
    });
    expect(toLLMRetryDecision(withStatus).retryable).toBe(false);
    // No status and a permanent-looking message: no transient wording, no retry.
    const permanentWords = normalize({
      raw: { errorCode: 50113, message: 'invalid request: messages.0.content is missing' },
    });
    expect(toLLMRetryDecision(permanentWords).retryable).toBe(false);
  });
});
