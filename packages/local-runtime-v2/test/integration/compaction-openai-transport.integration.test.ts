import { createRequestFork } from '@mavis/agent-core/pi-turn-runner';
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// pi 48c8f322: `streamSimple` lives in the pi-ai `./compat` entry, not the root index.
import { streamSimple, normalizeContext, type Context, type Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactContext } from "../../src/service/turn-system/compaction/algorithm/compact-context.js";
import { createCheckpointSession } from "../../src/service/turn-system/compaction/execution/checkpoint-provider.js";

const summary =
  "The synthetic file was read. Continue with the pending user request.";

function history(model: Model<"openai-completions">): Context["messages"] {
  return [
    { role: "user", content: "Read the synthetic file.", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read-1",
          name: "read",
          arguments: { path: "fixture.txt" },
        },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "toolUse",
      timestamp: 2,
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Synthetic file contents." }],
      isError: false,
      timestamp: 3,
    },
  ];
}

describe("OpenAI compaction HTTP transport", () => {
  let server: ReturnType<typeof createServer>;
  let model: Model<"openai-completions">;
  let requests: Record<string, unknown>[];

  beforeEach(async () => {
    requests = [];
    // Exercise the real SDK serializer and stream parser with a local fixture.
    // This models the reported validation rule, not acceptance by a live service.
    server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        response.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              message: "tools must not be an empty array",
              type: "invalid_request_error",
              param: "tools",
            },
          }),
        );
        return;
      }
      if (body.system) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: summary } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
          { type: 'message_stop' },
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "synthetic-checkpoint",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [
            { index: 0, delta: { content: summary }, finish_reason: null },
          ],
        })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 15,
            total_tokens: 115,
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    model = {
      id: "fixture-model",
      name: "Fixture model",
      api: "openai-completions",
      provider: "custom",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      reasoning: false,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });

  afterEach(async () => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each(["custom", "openai"])(
    "compacts tool history through the %s provider without empty tools",
    async (provider) => {
      model = { ...model, provider };
      const result = await compactContext({
        history: history(model),
        allowLegacyToolTrim: false,
        limits: {
          providerInputLimit: 20_000,
          maxSerializedInputBytes: 100_000,
        },
        // Admission is synthetic; checkpoint generation and HTTP transport are real.
        measurePair: async () => ({
          before: { inputTokens: 1000, serializedBytes: 10_000 },
          after: { inputTokens: 100, serializedBytes: 1000 },
        }),
        checkpoint: {
          tokensBefore: 1000,
          timestamp: 4,
          open: () =>
            createCheckpointSession({
              model,
              streamFn: streamSimple,
              thinkingLevel: "off",
              apiKey: "synthetic-key",
              maxOutputTokens: 1024,
              providerInputLimit: 20_000,
            }),
        },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("tools");
      expect(requests[0]).not.toHaveProperty("tool_choice");
      expect(requests[0].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: [expect.objectContaining({ id: "read-1" })],
          }),
          expect.objectContaining({
            role: "tool",
            tool_call_id: "read-1",
            content: "Synthetic file contents.",
          }),
        ]),
      );
      expect(result).toMatchObject({
        method: "llm_checkpoint",
        summary,
        generationAttempts: 1,
      });
      expect(result.replacementMessages[0]).toMatchObject({
        role: "compactionSummary",
      });
    },
  );

  it.each([
    { label: "absent", tools: undefined },
    { label: "empty", tools: [] },
  ])("omits $label tool definitions with tool history", async ({ tools }) => {
    const result = await streamSimple(
      model,
      { messages: history(model), tools },
      { apiKey: "synthetic-key" },
    ).result();
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("tools");
    expect(result.stopReason).toBe("stop");
  });

  it.each(["explicit", "detected"])(
    "omits tools with %s Anthropic cache compatibility and tool history",
    async (mode) => {
      model =
        mode === "explicit"
          ? { ...model, compat: { cacheControlFormat: "anthropic" } }
          : { ...model, provider: "openrouter", id: "anthropic/fixture-model" };
      const result = await streamSimple(
        model,
        { messages: history(model) },
        {
          apiKey: "synthetic-key",
          cacheRetention: "none",
        },
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("tools");

      await streamSimple(
        model,
        {
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
          tools: [],
        },
        {
          apiKey: "synthetic-key",
          cacheRetention: "none",
        },
      ).result();
      expect(requests[1]).not.toHaveProperty("tools");
    },
  );

  it("preserves nonempty tool definitions on ordinary agent requests", async () => {
    const result = await streamSimple(
      model,
      {
        messages: history(model),
        tools: [
          {
            name: "read",
            description: "Read a synthetic file",
            parameters: Type.Object({ path: Type.String() }),
          },
        ],
      },
      { apiKey: "synthetic-key" },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(requests[0].tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "read" }),
      }),
    ]);
  });
  it('forks the actual prepared request through the same HTTP encoder with tools, route and an image-free exact prefix', async () => {
    model = { ...model, input: ['text', 'image'] };
    const context = normalizeContext({
      systemPrompt: 'Stable system prompt for the shared request builder.',
      tools: [{ name: 'read', description: 'Read a file', parameters: Type.Object({ path: Type.String() }) }],
      messages: [...history(model), { role: 'user', content: [
        { type: 'text', text: 'Current image stays in the retained suffix.' },
        { type: 'image', mimeType: 'image/png', data: 'AA==' },
      ], timestamp: 4 }],
    });
    const options = {
      apiKey: 'synthetic-key', sessionId: 'same-cache-route', cacheRetention: 'long' as const,
      maxTokens: 4096, headers: { 'x-test-route': 'inherited' },
      onPayload: (payload: unknown) => payload,
    };
    const fork = createRequestFork(streamSimple, model, context, options);
    await (await fork.main()).result();
    // The fork owns its snapshot, even if the main loop mutates its arrays.
    context.messages.length = 0;
    await (await fork.stream(4, 'Summarize the preceding transcript; do not call tools.')).result();
    expect(requests).toHaveLength(2);
    const main = requests[0]!;
    const summary = requests[1]!;
    expect(summary.messages.slice(0, -1)).toEqual(main.messages.slice(0, -1));
    expect(summary.tools).toEqual(main.tools);
    expect(summary.max_completion_tokens).toBe(4096);
    expect(summary.max_completion_tokens).toEqual(main.max_completion_tokens);
    expect(summary.prompt_cache_key).toEqual(main.prompt_cache_key);
    expect(JSON.stringify(summary)).not.toContain('image_url');
    expect(JSON.stringify(main)).toContain('image_url');
    expect(() => fork.stream(3, 'summary')).toThrow('inside a tool round');
    expect(() => fork.stream(5, 'summary')).toThrow('image-free prefix');
  });

  it('preserves the final Anthropic payload cache breakpoint when extending the full main anchor', async () => {
    const anthropicModel = { ...model, api: 'anthropic-messages' as const };
    const context = normalizeContext({
      systemPrompt: 'Stable system',
      tools: [{ name: 'read', description: 'Read a file', parameters: Type.Object({ path: Type.String() }) }],
      messages: [{ role: 'user', content: 'Covered history ' + 'x'.repeat(94_000), timestamp: 1 },
        { role: 'user', content: 'Retained tail and host reminders', timestamp: 2 }],
    });
    const oldSignal = new AbortController();
    const signal = new AbortController();
    const options = { apiKey: 'synthetic-key', sessionId: 'stable-route', maxTokens: 4096, signal: oldSignal.signal };
    const fork = createRequestFork(streamSimple, anthropicModel, context, options);
    expect((await (await fork.main()).result()).stopReason).toBe('stop');
    oldSignal.abort();
    const result = await (await fork.stream(fork.prefixLength, 'Summarize only the covered history.', signal.signal, 1024)).result();
    expect(result.stopReason, result.errorMessage).toBe('stop');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.slice(0, -1)).toEqual(requests[0]!.messages);
    expect(requests[1]!.max_tokens).toBe(1024);
    expect(requests[1]!.max_tokens).toBeLessThan(requests[0]!.max_tokens);
    expect(requests[1]!.system).toEqual(requests[0]!.system);
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    expect(requests[1]!.messages.at(-1).content.at(-1).cache_control).toBeUndefined();
    expect(requests[0]!.messages.at(-1).content.at(-1).cache_control).toBeDefined();
    expect(requests[1]!.messages.at(-2).content.at(-1).cache_control).toEqual(requests[0]!.messages.at(-1).content.at(-1).cache_control);
  });

  it('refuses a cache identity change by onPayload before sending the fork', async () => {
    let calls = 0;
    const fork = createRequestFork(streamSimple, model, normalizeContext({
      systemPrompt: 'Stable system', messages: [{ role: 'user', content: 'History', timestamp: 1 }],
    }), { apiKey: 'synthetic-key', onPayload: (payload) => {
      calls += 1;
      return calls === 1 ? payload : { ...payload as object, temperature: 0.9 };
    } });
    await (await fork.main()).result();
    const result = await (await fork.stream(fork.prefixLength, 'Summarize.')).result();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('changed provider temperature');
    expect(requests).toHaveLength(1);
  });

  it('freezes the main payload before later keep-alive callbacks and bypasses the main observer on forks', async () => {
    let replayOptions: Parameters<Parameters<typeof createRequestFork>[0]>[2];
    let mainCalls = 0;
    const main: Parameters<typeof createRequestFork>[0] = (m, c, o) => {
      mainCalls += 1;
      replayOptions = o;
      return streamSimple(m, c, o);
    };
    const context = normalizeContext({ systemPrompt: 'Stable main system', messages: [
      { role: 'user', content: 'Covered history', timestamp: 1 },
    ] });
    const fork = createRequestFork(streamSimple, model, context, { apiKey: 'synthetic-key' });
    await (await fork.main(main)).result();
    await (await streamSimple(model, normalizeContext({ systemPrompt: 'Later keep-alive callback', messages: [
      { role: 'user', content: 'Probe', timestamp: 2 },
    ] }), { ...replayOptions, maxTokens: 1 })).result();
    const result = await (await fork.stream(fork.prefixLength, 'Summarize.')).result();
    expect(result.stopReason, result.errorMessage).toBe('stop');
    expect(requests[2]!.messages.slice(0, -1)).toEqual(requests[0]!.messages);
    expect(mainCalls).toBe(1);
  });

});
