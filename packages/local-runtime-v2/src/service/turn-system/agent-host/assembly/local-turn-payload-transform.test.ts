import { buildSystemPrompt } from '../preparation/config/local-agent-config-builder.js';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { describe, expect, it } from 'vitest';

import { LocalModelResolver } from '../../../model-system/resolution/local-model-resolver.js';
import { modelRefForModel } from '../../../model-system/resolution/model-ref.js';
import type { LocalModelConfig } from '../../../model-system/contracts.js';
import { buildLocalTurnPayloadTransform, buildLocalRequestPayloadTransform } from './local-turn-payload-transform.js';

// Mirrors the bundled MiniMax catalog entries that matter for thinking.
const M31_FLASH = {
  name: 'M3.1-Flash',
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 512_000, output: 128_000 },
  thinking: {
    effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'default',
  },
  thinking_config: { mode: 'forced_on' },
  variants: {
    'none-thinking': { thinking: { type: 'disabled' } },
    thinking: { thinking: { type: 'adaptive' } },
  },
} as unknown as LocalModelConfig;

const M3 = {
  name: 'M3',
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 1_000_000, output: 128_000 },
  thinking_config: { mode: 'forced_on' },
  variants: {
    'none-thinking': { thinking: { type: 'disabled' } },
    thinking: { thinking: { type: 'adaptive' } },
  },
} as unknown as LocalModelConfig;

/** Resolve an API-key MiniMax model and capture the request body pi-ai actually sends. */
async function captureWireBody(input: {
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfig: LocalModelConfig;
  readonly effort?: string;
  readonly minimaxModelSource?: string;
}) {
  const modelRef = modelRefForModel(input.provider, input.modelId, input.modelConfig, {
    ...(input.effort ? { thinking: { effort: input.effort } } : {}),
  } as never);
  const agentConfig = {
    system_prompt: 'system',
    agent_id: 'agent',
    model: modelRef,
    tools: [],
    skills: [],
  } as never;
  const resolver = new LocalModelResolver({
    providerConfig: { minimax: { models: { [input.modelId]: input.modelConfig } } } as never,
    byokConfigGetter: () =>
      ({
        ...(input.minimaxModelSource ? { minimaxModelSource: input.minimaxModelSource } : {}),
        minimax_api: { apiKey: 'k', baseURL: 'https://byok.invalid/anthropic' },
      }) as never,
  });
  const llm = await resolver.resolveModel({ sessionId: 's', turnId: 't', agentConfig });
  expect(llm.model.provider).toBe('minimax_api');
  expect(llm.managedProvider).not.toBe(true);
  let body: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: unknown, init: { body?: unknown }) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response('stop here', { status: 500 });
  }) as unknown as typeof fetch;
  const onPayload = buildLocalRequestPayloadTransform(
    { agentConfig, llm, sessionId: 's', signal: new AbortController().signal },
    {},
  );
  const stream = streamSimple(
    llm.model as never,
    { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
    {
      apiKey: 'k',
      reasoning: llm.thinkingLevel ?? undefined,
      fetch: fetchImpl,
      onPayload,
      maxRetries: 0,
    } as never,
  );
  for await (const _event of stream) {
    // Drain until the stubbed provider error ends the stream.
  }
  expect(body).toBeDefined();
  return body!;
}

describe('API-key MiniMax thinking effort', () => {
  it.each(['high', 'low', 'xhigh', 'max'])(
    'keeps --effort %s on the minimax_api wire request',
    async (effort) => {
      const body = await captureWireBody({
        provider: 'minimax_api',
        modelId: 'MiniMax-M3.1-Flash',
        modelConfig: M31_FLASH,
        effort,
      });
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort });
    },
  );

  it('keeps --effort when a MiniMax model is routed through the API key source', async () => {
    const body = await captureWireBody({
      provider: 'minimax',
      modelId: 'MiniMax-M3.1-Flash',
      modelConfig: M31_FLASH,
      effort: 'high',
      minimaxModelSource: 'minimax_api_key',
    });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('sends no effort when none was selected (default)', async () => {
    const body = await captureWireBody({
      provider: 'minimax_api',
      modelId: 'MiniMax-M3.1-Flash',
      modelConfig: M31_FLASH,
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body).not.toHaveProperty('output_config');
  });

  it('sends no effort for a model without effort levels', async () => {
    const body = await captureWireBody({
      provider: 'minimax_api',
      modelId: 'MiniMax-M3',
      modelConfig: M3,
      effort: 'high',
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body).not.toHaveProperty('output_config');
  });
});

describe('MiniMax cross-session prompt prefix', () => {
  const model = { id: 'MiniMax-M3.1-Flash', api: 'anthropic-messages' } as never;
  const tools = [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }];
  function fixture(workspace: string) {
    const system = 'Stable identity and harness rules';
    const runtime = `Project instructions: preserve files.\n# Environment\nworkspace: ${workspace}\nMemory: fixture\nSkills: read`;
    const original = `${system}\n\n${runtime}`;
    const transform = buildLocalTurnPayloadTransform({
      system_prompt: original,
      cacheablePrompt: { system, runtimePrefix: 'Stable capabilities', runtime },
    });
    return { system, runtime, original, transform };
  }

  it.each(['string', 'blocks'] as const)(
    'keeps system+tools identical across workspaces (%s)',
    async (shape) => {
      const bodies = [];
      for (const workspace of ['/workspace/a', '/workspace/b']) {
        const f = fixture(workspace);
        const image = { type: 'image', source: { type: 'base64', data: 'fixture' } };
        const body = {
          system: shape === 'string' ? f.original : [{ type: 'text', text: f.original }],
          tools,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Question' }, image] }],
        };
        await f.transform(body, model);
        expect(JSON.stringify(body.system)).not.toContain(workspace);
        expect(JSON.stringify(body.messages[1])).toContain(workspace);
        expect(JSON.stringify(body.messages[1])).toContain('preserve files');
        expect(body.messages[1]!.content.at(-1)).toBe(image);
        const once = JSON.stringify(body);
        await f.transform(body, model);
        expect(JSON.stringify(body)).toBe(once);
        bodies.push(body);
      }
      expect(bodies[0]!.system).toEqual(bodies[1]!.system);
      expect(bodies[0]!.tools).toEqual(bodies[1]!.tools);
      expect(bodies[0]!.messages[0]).toEqual(bodies[1]!.messages[0]);
      expect(bodies[0]!.messages).not.toEqual(bodies[1]!.messages);
    },
  );

  it('inherits the existing cache policy and never enables disabled caching', async () => {
    const f = fixture('/workspace');
    const policy = { type: 'ephemeral', ttl: '1h' };
    const cached = { system: [{ type: 'text', text: f.original, cache_control: policy }],
      messages: [{ role: 'user', content: 'question' }] };
    await f.transform(cached, model);
    expect((cached.messages[0]!.content as unknown as {cache_control: unknown}[])[0]!.cache_control).toEqual(policy);
    const disabled = { system: [{ type: 'text', text: f.original }],
      messages: [{ role: 'user', content: 'question' }] };
    await f.transform(disabled, model);
    expect(JSON.stringify(disabled)).not.toContain('cache_control');
  });

  it.each(['anthropic-messages', 'openai-completions'] as const)(
    'reuses project context across independent sessions and refreshes changed content (%s)',
    async (api) => {
      const make = async (session: string, instructions = 'Project rules', cached = true) => {
        const policy = { type: 'ephemeral', ttl: '1h' };
        const projectContext = `Skills: read\nMemory: preserve files\n${instructions}`;
        const transform = buildLocalTurnPayloadTransform({
          system_prompt: 'Original full prompt',
          cacheablePrompt: { system: 'Identity', runtimePrefix: 'Shared', projectContext,
            runtime: `Session rules: ${session}` },
        });
        const body = {
          system: [{ type: 'text', text: 'Original full prompt', ...(cached ? { cache_control: policy } : {}) }],
          tools: [{ ...tools[0], ...(cached ? { cache_control: policy } : {}) }],
          messages: [{ role: 'user', content: [{ type: 'text', text: `Question ${session}`,
            ...(cached && api === 'anthropic-messages' ? { cache_control: policy } : {}) }] }],
        };
        await transform(body, { id: 'MiniMax-M3.1-Flash', api } as never);
        const once = JSON.stringify(body);
        await transform(body, { id: 'MiniMax-M3.1-Flash', api } as never);
        expect(JSON.stringify(body)).toBe(once);
        return body;
      };
      const a = await make('session-a');
      const b = await make('session-b');
      expect(a.messages.slice(0, 2)).toEqual(b.messages.slice(0, 2));
      expect(JSON.stringify(a.messages[1])).toContain('Memory: preserve files');
      expect(JSON.stringify(a.messages[1])).toContain('Project rules');
      expect(JSON.stringify(a.messages[2])).toContain('session-a');
      expect(JSON.stringify(b.messages[2])).toContain('session-b');
      const changed = await make('session-c', 'Updated project rules');
      expect(changed.messages[0]).toEqual(a.messages[0]);
      expect(changed.messages[1]).not.toEqual(a.messages[1]);
      if (api === 'anthropic-messages') {
        expect(a.system[0]).not.toHaveProperty('cache_control');
        expect(a.messages[1]!.content[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(JSON.stringify(a).match(/"cache_control"/g)).toHaveLength(4);
        expect(JSON.stringify(await make('disabled', 'Project rules', false))).not.toContain('cache_control');
      } else {
        expect(JSON.stringify(a.messages)).not.toContain('cache_control');
      }
    },
  );

  it('handles the OpenAI-compatible payload without changing tool correlations', async () => {
    const f = fixture('/workspace');
    const body = {
      tools,
      messages: [
        { role: 'system', content: f.original },
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] },
        { role: 'tool', content: 'result', tool_call_id: 'call-1' },
      ],
    };
    const tail = JSON.stringify(body.messages.slice(2));
    await f.transform(body, { id: 'MiniMax-M3.1-Flash', api: 'openai-completions' } as never);
    expect(body.messages[0]!.content).toBe(f.system);
    expect(JSON.stringify(body.messages)).not.toContain('cache_control');
    expect(body.messages[2]!.content).toContain('Question');
    expect(body.messages[2]!.content).toContain('/workspace');
    expect(JSON.stringify(body.messages.slice(-2))).toBe(tail);
  });

  it('preserves extension prefixes and leaves unrecognized prompts and other models intact', async () => {
    const f = fixture('/workspace');
    const body = {
      system: `Extension rules\n\n${f.original}`,
      messages: [{ role: 'user', content: 'hi' }],
    };
    await f.transform(body, model);
    expect(body.system).toBe(`Extension rules\n\n${f.system}`);
    const unchanged = {
      system: 'A completely different prompt',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(await f.transform(unchanged, model)).toBeUndefined();
    const other = { system: f.original, messages: [{ role: 'user', content: 'hi' }] };
    expect(
      await f.transform(other, { id: 'other', api: 'anthropic-messages' } as never),
    ).toBeUndefined();
    expect(other.system).toBe(f.original);
  });
});

it('builds a stable prefix without losing scoped instructions, memory or skills', () => {
  const prepare = (workspaceDir: string, projectInstructions: string, customConfig?: unknown) =>
    buildSystemPrompt({
      config: { dataDir: '/profile' },
      environment: { platform: 'test', osVersion: 'test', shell: 'sh' },
      modelId: 'MiniMax-M3.1-Flash',
      isGitRepository: false,
      workspaceDir,
      sessionType: 'root',
      agent: { agentName: 'mavis', systemPrompt: 'Identity' },
      profile: undefined,
      customConfig,
      overrides: undefined,
      layers: {
        basePrompt: 'Base rules',
        sessionPrompt: 'Session rules',
        globalInstructions: 'Global rules',
        projectInstructions,
        memoryBlocks: ['Memory fact'],
        catalog: '<skills>Stable catalog</skills>',
      },
    } as never);
  const a = prepare('/work/a', 'Project A rules');
  const b = prepare('/work/b', 'Project B rules');
  expect(Object.values(a.sections).filter(Boolean).join('\n\n')).toBe(a.text);
  expect(a.cacheablePrompt.system).toBe(b.cacheablePrompt.system);
  for (const text of ['Global rules', 'Project A rules', 'Memory fact', '<skills>']) {
    expect(a.cacheablePrompt.projectContext).toContain(text);
    expect(a.cacheablePrompt.runtime).not.toContain(text);
    expect(a.text).toContain(text);
  }
  for (const text of ['Session rules', '/work/a']) {
    expect(a.cacheablePrompt.runtime).toContain(text);
    expect(a.cacheablePrompt.projectContext).not.toContain(text);
    expect(a.text).toContain(text);
  }
  expect(a.cacheablePrompt.runtimePrefix).not.toContain('/work/');
  expect(a.cacheablePrompt.runtimePrefix).toBe(b.cacheablePrompt.runtimePrefix);
  expect(a.cacheablePrompt.projectContext).not.toBe(b.cacheablePrompt.projectContext);
  expect(a.cacheablePrompt.projectContext).toBe(prepare('/work/other', 'Project A rules').cacheablePrompt.projectContext);
  const custom = prepare('/work/a', 'Excluded project rules', { systemPrompt: 'CUSTOM' });
  expect(custom.cacheablePrompt.system).toContain('CUSTOM');
  expect(custom.cacheablePrompt.projectContext).not.toContain('Excluded project rules');
  expect(custom.cacheablePrompt.projectContext).toContain('Memory fact');
});
