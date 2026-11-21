import { describe, expect, it, vi } from 'vitest';

import type { ClassifierContext } from '@earendil-works/pi-ai';

import {
  classifyWithPiClassifier,
  getBuiltinClassifierModel,
  listBuiltinClassifierModels,
  listBuiltinClassifierProviders,
  registerCustomLlamaClassifierEndpoint,
} from './pi-classifier.js';

const BOOL_CONTEXT: ClassifierContext = {
  state: { task: 'provider-surface-check', ready: true },
  questions: {
    ready: {
      type: 'bool',
      instructions: 'Is the provider surface ready?',
      criteria: { true: 'The surface is ready', false: 'The surface is not ready' },
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pi-classifier builtin catalog (V-P01 classifier surface)', () => {
  it('exposes the pinned classifier providers and models', () => {
    expect(listBuiltinClassifierProviders()).toContain('openai');
    const models = listBuiltinClassifierModels();
    // JEV / Decisions / clef representatives from the pin catalog.
    expect(models.some((model) => model.api === 'typesafe-system-one')).toBe(true);
    expect(models.some((model) => model.api === 'openai-decisions')).toBe(true);
    expect(models.some((model) => model.api === 'cloudflare-workers-ai-system-one')).toBe(true);
  });

  it('resolves the JEV and Decisions representatives by provider+model id', () => {
    expect(getBuiltinClassifierModel('typesafe', 'jev-latest')?.api).toBe('typesafe-system-one');
    expect(getBuiltinClassifierModel('openai', 'gpt-6-luna')?.api).toBe('openai-decisions');
    expect(
      getBuiltinClassifierModel('cloudflare-workers-ai', 'typesafe/jev')?.api,
    ).toBe('cloudflare-workers-ai-system-one');
    // llama.cpp is endpoint-owned: no catalog entry, only custom registration.
    expect(listBuiltinClassifierModels().some((model) => model.api === 'llama-cpp-classify')).toBe(
      false,
    );
  });
});

describe('classifyWithPiClassifier (host policy, V-P06 classify path)', () => {
  it('routes a Decisions call through the host fetch with host auth and parses answers', async () => {
    const model = getBuiltinClassifierModel('openai', 'gpt-6-luna');
    expect(model).toBeDefined();
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse({
        answers: [{ name: 'ready', type: 'predicate', probability: 0.87 }],
        usage: { input_tokens: 12, output_tokens: 0 },
      });
    });

    const result = await classifyWithPiClassifier(model!, BOOL_CONTEXT, {
      apiKey: 'test-decisions-key',
      fetch: fetchImpl,
      maxRetries: 0,
    });

    expect(result.stopReason).toBe('stop');
    expect(result.answers.ready).toMatchObject({ type: 'bool', probability: 0.87 });
    expect(result.usage?.input).toBe(12);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/decisions');
    expect(requests[0]?.headers.authorization).toBe('Bearer test-decisions-key');
    expect(requests[0]?.body).toMatchObject({ model: 'gpt-6-luna' });
  });

  it('normalizes a failing endpoint into an error result instead of throwing', async () => {
    const model = getBuiltinClassifierModel('openai', 'gpt-6-luna');
    expect(model).toBeDefined();
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'upstream_stream_read_error' }, 500));

    const result = await classifyWithPiClassifier(model!, BOOL_CONTEXT, {
      apiKey: 'test-decisions-key',
      fetch: fetchImpl,
      maxRetries: 0,
    });

    expect(result.stopReason).toBe('error');
    expect(typeof result.errorMessage).toBe('string');
    expect(result.answers).toEqual({});
  });
});

describe('registerCustomLlamaClassifierEndpoint (llama.cpp)', () => {
  it('dispatches through the pinned llama-cpp-classify protocol to the endpoint root', async () => {
    const model = registerCustomLlamaClassifierEndpoint({
      providerId: 'custom_provider:llama-test',
      modelId: 'local-qwen',
      baseUrl: 'http://127.0.0.1:9199/v1',
    });
    expect(model).toMatchObject({
      type: 'classifier',
      api: 'llama-cpp-classify',
      provider: 'custom_provider:llama-test',
      baseUrl: 'http://127.0.0.1:9199/v1',
    });

    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({ error: 'not a llama server' }, 500);
    });

    const result = await classifyWithPiClassifier(model, BOOL_CONTEXT, {
      fetch: fetchImpl,
      maxRetries: 0,
    });

    // The pin's llama-cpp protocol resolves the server root (strips /v1) and
    // talks to its own endpoints — proof the call left through the pinned
    // implementation with the host fetch.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith('http://127.0.0.1:9199/'))).toBe(true);
    expect(result.stopReason).toBe('error');
    expect(typeof result.errorMessage).toBe('string');
  });
});
