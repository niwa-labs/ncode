import { describe, expect, it } from 'vitest';

import {
  ACP_CONFIG_MODEL,
  configOptions,
  modelConfigValue,
} from '../../src/acp/control-state.js';
import type { TuiModel, TuiSession } from '../../src/runtime/port.js';

/**
 * Catalog context data (packages/config/src/minimax-model-catalog.ts):
 * M3/M3.1-Flash run 512000 context with a 1M-tier option; M2.7 stays at
 * 200000; output is 128000 everywhere.
 */
const M3: TuiModel = {
  providerId: 'minimax',
  modelId: 'MiniMax-M3',
  displayName: 'MiniMax-M3',
  selected: true,
  variant: 'thinking',
  supportedVariants: ['none-thinking', 'thinking'],
  contextLimit: 512000,
  maxOutputTokens: 128000,
  contextWindowOptions: [512000, 1000000],
  effortOptions: ['default', 'low', 'medium', 'high'],
  thinkingConfig: { mode: 'switchable', defaultValue: 'true' },
};

const M2_7: TuiModel = {
  providerId: 'minimax',
  modelId: 'MiniMax-M2.7',
  displayName: 'MiniMax-M2.7',
  contextLimit: 200000,
  maxOutputTokens: 128000,
};

const session: TuiSession = {
  sessionId: 'session-1',
  workspaceDir: '/workspace',
};

function modelOption(models: readonly TuiModel[]): {
  currentValue: string;
  options: Array<{ value: string; name: string; _meta?: Record<string, unknown> }>;
} {
  const option = configOptions(session, 'default', models).find(
    (candidate) => candidate.id === ACP_CONFIG_MODEL,
  );
  if (!option || !('options' in option) || !Array.isArray(option.options)) {
    throw new Error('Model config option is missing.');
  }
  return option as unknown as {
    currentValue: string;
    options: Array<{ value: string; name: string; _meta?: Record<string, unknown> }>;
  };
}

function contextMeta(option: { _meta?: Record<string, unknown> }): Record<string, unknown> {
  const meta = option._meta?.['minimax-code/context'];
  if (!meta || typeof meta !== 'object') throw new Error('minimax-code/context meta is missing.');
  return meta as Record<string, unknown>;
}

describe('MiniMax Code ACP model option context _meta', () => {
  it('projects catalog context data onto every model option', () => {
    const option = modelOption([M3, M2_7]);
    const byValue = new Map(option.options.map((candidate) => [candidate.value, candidate]));
    expect(option.options).toHaveLength(3);

    const m3Thinking = byValue.get(modelConfigValue({ providerId: 'minimax', modelId: 'MiniMax-M3', variant: 'thinking' }));
    expect(contextMeta(m3Thinking!)).toEqual({
      contextLimit: 512000,
      maxOutputTokens: 128000,
      contextWindowOptions: [512000, 1000000],
    });

    const m3None = byValue.get(modelConfigValue({ providerId: 'minimax', modelId: 'MiniMax-M3', variant: 'none-thinking' }));
    expect(contextMeta(m3None!)).toEqual({
      contextLimit: 512000,
      maxOutputTokens: 128000,
      contextWindowOptions: [512000, 1000000],
    });

    const m27 = byValue.get(modelConfigValue({ providerId: 'minimax', modelId: 'MiniMax-M2.7' }));
    expect(contextMeta(m27!)).toEqual({ contextLimit: 200000, maxOutputTokens: 128000 });
    expect(m27!._meta?.['minimax-code/context']).not.toHaveProperty('contextWindowOptions');
  });

  it('exposes the 1M tier so clients can opt into the higher-usage window', () => {
    const option = modelOption([M3]);
    const tiers = option.options.flatMap(
      (candidate) => contextMeta(candidate).contextWindowOptions as number[] | undefined,
    );
    expect(tiers).toContain(1000000);
    expect(tiers).toContain(512000);
  });

  it('still emits an empty context payload when the model reports no catalog data', () => {
    const option = modelOption([
      { providerId: 'byok', modelId: 'custom-model', displayName: 'Custom' },
    ]);
    expect(option.options).toHaveLength(1);
    expect(contextMeta(option.options[0]!)).toEqual({});
  });
});
