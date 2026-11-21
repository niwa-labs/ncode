import { describe, expect, it } from 'vitest';

import { getModels, getProviders } from '@earendil-works/pi-ai/compat';
import { getBuiltinClassifierModels } from '@earendil-works/pi-ai/providers/all';

import { LocalModelResolver } from './local-model-resolver.js';
import { isAdaptiveDefaultThinkingModelId } from './adaptive-thinking-models.js';
import type { IAgentConfig } from '@mavis/protocol';

/**
 * W06 provider-surface gate (plan :759 Take "весь provider/API catalog … все
 * 40+ провайдеров"; readiness "ни одна target provider/type/cache surface не
 * потеряна"): every builtin provider of the pinned pi-ai catalog is servable
 * by the product model resolver, and the chat/classifier model types both
 * survive on the pin. No network access happens — resolution is catalog +
 * config only.
 */

const BASE_AGENT_CONFIG: IAgentConfig = {
  system_prompt: 'system',
  agent_id: 'agent-surface',
  model: { provider: 'placeholder', model_id: 'placeholder' },
  tools: [],
  skills: [],
};

const OPENAI_CODEX_PROVIDER = 'openai-codex';

describe('pinned provider surface (V-P01)', () => {
  it('resolves the first model of every catalog provider', async () => {
    const providers = getProviders();
    expect(providers.length).toBeGreaterThanOrEqual(40);
    const resolved: string[] = [];
    const classifierOnly: string[] = [];
    for (const provider of providers) {
      const model = getModels(provider)[0];
      if (!model) {
        // `typesafe` is the pin's classifier-only provider (JEV); its surface
        // is proven by the classifier-catalog test below.
        classifierOnly.push(provider);
        continue;
      }
      // Azure derives its endpoint from the resource config, so its catalog
      // baseUrl is empty; resolution only needs a configured base URL and no
      // request happens here.
      const baseURL = model.baseUrl || 'https://surface.example.invalid';
      const resolver = new LocalModelResolver({
        providerConfig: {
          [provider]: {
            options: { apiKey: 'test-surface-key', baseURL },
            models: {},
          },
        },
        // openai-codex resolves its key through the provider auth getter.
        providerAuthGetter: async () => 'test-surface-key',
      });
      const config = await resolver.resolveModel({
        sessionId: 'surface-session',
        turnId: 'surface-turn',
        agentConfig: {
          ...BASE_AGENT_CONFIG,
          model: { provider, model_id: model.id },
        },
      });
      expect(config.model.provider).toBe(provider);
      expect(config.model.id).toBe(model.id);
      expect(config.model.baseUrl).toBe(baseURL);
      resolved.push(`${provider}/${model.id}`);
    }
    // The product-critical named providers are all present at the pin.
    for (const provider of [
      'minimax',
      'minimax-cn',
      'zai',
      'zai-coding-cn',
      'kimi-coding',
      OPENAI_CODEX_PROVIDER,
    ]) {
      expect(providers).toContain(provider);
      expect(resolved.some((entry) => entry.startsWith(`${provider}/`))).toBe(true);
    }
    expect(classifierOnly).toEqual(['typesafe']);
    expect(resolved.length).toBe(providers.length - classifierOnly.length);
  });

  it('keeps concrete representative models resolvable', async () => {
    const representatives: Array<[string, string]> = [
      ['anthropic', 'claude-opus-5'],
      ['minimax', 'MiniMax-M3'],
    ];
    for (const [provider, modelId] of representatives) {
      const model = getModels(provider).find((candidate) => candidate.id === modelId);
      expect(model, `${provider}/${modelId}`).toBeDefined();
      const resolver = new LocalModelResolver({
        providerConfig: {
          [provider]: { options: { apiKey: 'test-surface-key', baseURL: model!.baseUrl }, models: {} },
        },
      });
      const config = await resolver.resolveModel({
        sessionId: 'surface-session',
        turnId: 'surface-turn',
        agentConfig: { ...BASE_AGENT_CONFIG, model: { provider, model_id: modelId } },
      });
      expect(config.model.id).toBe(modelId);
    }
  });

  it('serves classifier models from the same pinned catalog', () => {
    const classifierModels = getProviders().flatMap((provider) =>
      getBuiltinClassifierModels(provider),
    );
    expect(classifierModels.length).toBeGreaterThan(0);
    expect(classifierModels.some((model) => model.api === 'openai-decisions')).toBe(true);
    expect(classifierModels.some((model) => model.api === 'typesafe-system-one')).toBe(true);
  });

  it('keeps the adaptive-default-thinking family on pin metadata', () => {
    // The default/adaptive-thinking family classification is the pinned
    // catalog's own `compat.forceAdaptiveThinking` metadata (registry PR-03
    // №12/№37 adapt): the pin's adaptive Claude entries are matched and no
    // hardcoded product list remains.
    const adaptive = getModels('anthropic').filter(
      (model) => model.compat?.forceAdaptiveThinking === true,
    );
    expect(adaptive.length).toBeGreaterThan(0);
    for (const model of adaptive) {
      expect(isAdaptiveDefaultThinkingModelId(model.id)).toBe(true);
    }
  });
});
