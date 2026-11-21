import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model, Api } from '@earendil-works/pi-ai';

import {
  contextWireMessages,
  contextWireRequestMessages,
  type ContextWireRequest,
} from '../../../src/pi-turn-runner/context-wire.js';

const model = {
  api: 'openai-completions',
  provider: 'test-provider',
  id: 'test-model',
} as unknown as Model<Api>;

describe('contextWireMessages (Ш4 convertToLlm hydration)', () => {
  it('hydrates the projected records into pi-ai messages in payload order', () => {
    const request: ContextWireRequest = {
      totalBytes: 128,
      records: [
        { role: 'user', text: 'привет', timestamp: 1 },
        {
          role: 'assistant',
          text: 'ищу',
          toolCalls: [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
          timestamp: 2,
        },
        {
          role: 'toolResult',
          text: 'README.md',
          toolCallId: 'call_1',
          toolName: 'bash',
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const messages = contextWireMessages(request, model);
    expect(messages).toHaveLength(3);

    expect(messages[0]).toMatchObject({ role: 'user', timestamp: 1 });
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'привет' }]);

    const assistant = messages[1]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toEqual([
      { type: 'text', text: 'ищу' },
      { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
    ]);
    // Pi requires assistant bookkeeping; stopReason reflects the pending tool use.
    expect(assistant).toMatchObject({
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: 'toolUse',
    });

    expect(messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'bash',
      isError: false,
      content: [{ type: 'text', text: 'README.md' }],
    });
  });

  it('degrades corrupt tool-call arguments to a visible raw value instead of throwing', () => {
    const messages = contextWireMessages(
      {
        totalBytes: 16,
        records: [
          {
            role: 'assistant',
            text: '',
            toolCalls: [{ id: 'call_x', name: 'bash', arguments: 'не-json' }],
          },
        ],
      },
      model,
    );
    const block = messages[0]!.content[0]!;
    expect(block).toMatchObject({ type: 'toolCall', id: 'call_x', name: 'bash', arguments: { raw: 'не-json' } });
  });

  it('falls back to timestamp 0 for merged records without a source wall clock', () => {
    const messages = contextWireMessages(
      { totalBytes: 8, records: [{ role: 'user', text: 'batch-merged' }] },
      model,
    );
    expect(messages[0]).toMatchObject({ role: 'user', timestamp: 0 });
  });

  // Wave-0 item 0.5 (canon 05 §2.5): a RESIDENT image rides the record as a
  // structured image block at its marker position — the provider payload
  // carries a real image block, not the `[image: image/png]` placeholder
  // text. Ordering with surrounding text is preserved; a marker whose image
  // is missing degrades to the visible marker, never a silent drop.
  it('hydrates structured resident images into provider image blocks at their marker positions', () => {
    const request: ContextWireRequest = {
      totalBytes: 4096,
      records: [
        {
          role: 'user',
          text: `\u0000mcode-image:0\u0000\n\nвот скриншот`,
          images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
          timestamp: 5,
        },
        {
          role: 'toolResult',
          text: `captured\n\n\u0000mcode-image:0\u0000\n\n\u0000mcode-image:1\u0000 done`,
          images: [
            { data: 'c2hvdA==', mimeType: 'image/jpeg' },
            { data: 'c2hvdzI=', mimeType: 'image/png' },
          ],
          toolCallId: 'call_9',
          toolName: 'screen',
          isError: false,
          timestamp: 6,
        },
      ],
    };
    const messages = contextWireMessages(request, model);
    expect(messages).toHaveLength(2);

    const user = messages[0]!;
    expect(user.role).toBe('user');
    expect(user.content).toEqual([
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'text', text: '\n\nвот скриншот' },
    ]);

    const toolResult = messages[1]!;
    expect(toolResult.role).toBe('toolResult');
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'captured\n\n' },
      { type: 'image', data: 'c2hvdA==', mimeType: 'image/jpeg' },
      { type: 'text', text: '\n\n' },
      { type: 'image', data: 'c2hvdzI=', mimeType: 'image/png' },
      { type: 'text', text: ' done' },
    ]);
  });

  it('keeps the placeholder baseline when a record carries no images', () => {
    const messages = contextWireMessages(
      {
        totalBytes: 64,
        records: [
          { role: 'user', text: 'вопрос с картинкой [image: image/png] и текст', timestamp: 1 },
        ],
      },
      model,
    );
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'вопрос с картинкой [image: image/png] и текст' },
    ]);
  });

  it('degrades a dangling image marker to visible raw text instead of dropping it', () => {
    const messages = contextWireMessages(
      {
        totalBytes: 64,
        records: [
          {
            role: 'user',
            text: `\u0000mcode-image:0\u0000 gone`,
            images: [],
            timestamp: 1,
          },
        ],
      },
      model,
    );
    // images: [] (present but empty) — the marker has no image to resolve to;
    // the marker text stays visible (a projection bug, never a silent loss).
    expect(messages[0]!.content).toEqual([{ type: 'text', text: `\u0000mcode-image:0\u0000 gone` }]);
  });
});

describe('contextWireRequestMessages (system-prompt/tool-declaration preservation)', () => {
  const request: ContextWireRequest = {
    totalBytes: 64,
    records: [
      { role: 'user', text: 'вопрос', timestamp: 1 },
      { role: 'assistant', text: 'ответ', timestamp: 2 },
    ],
  };

  // The vendor agent encodes the system prompt and the tool declarations in
  // transcript system messages (createInitialSystemMessage + declareToolChanges
  // deltas); the provider request is shaped from those messages downstream.
  const initialSystem = {
    role: 'system',
    content: 'You are a coding agent.',
    toolsAdded: [
      { name: 'read', description: 'Reads a file', parameters: { type: 'object' } },
      { name: 'bash', description: 'Runs a command', parameters: { type: 'object' } },
    ],
    timestamp: 0,
  } as unknown as AgentMessage;
  const toolDelta = {
    role: 'system',
    content: '',
    toolsAdded: [{ name: 'browser', description: 'Drives a browser', parameters: { type: 'object' } }],
    timestamp: 3,
  } as unknown as AgentMessage;

  it('keeps the transcript system messages ahead of the projected records', () => {
    const transcript: AgentMessage[] = [
      initialSystem,
      { role: 'user', content: [{ type: 'text', text: 'старая история' }], timestamp: 0 },
      toolDelta,
    ];
    const messages = contextWireRequestMessages(transcript, request, model);
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
    ]);
    // Verbatim ride: the provider shapes system+tools from these exact objects.
    expect(messages[0]).toBe(initialSystem);
    expect(messages[1]).toBe(toolDelta);
    expect(messages[2]).toMatchObject({ role: 'user', timestamp: 1 });
  });

  it('is plain hydration when the transcript has no system messages', () => {
    const transcript: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'вопрос' }], timestamp: 1 },
    ];
    const messages = contextWireRequestMessages(transcript, request, model);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('regression: a transcript with only the initial system message keeps it', () => {
    // The live failure this pins: the wire path replaced the whole transcript,
    // so the request reached the provider with no system prompt and no tools
    // and the model answered toolless ("no access to the repository").
    const transcript: AgentMessage[] = [
      initialSystem,
      { role: 'user', content: [{ type: 'text', text: 'прочитай файл' }], timestamp: 1 },
    ];
    const messages = contextWireRequestMessages(transcript, request, model);
    expect(messages[0]).toBe(initialSystem);
    expect(getCurrentTools(messages).map((tool) => tool.name)).toEqual(['read', 'bash']);
  });
});

// Mirrors pi-ai utils/transcript.getCurrentTools — the fold the provider
// request's tool set is derived from.
function getCurrentTools(messages: readonly { role: string }[]): { name: string }[] {
  const tools = new Map<string, { name: string }>();
  for (const message of messages) {
    if (message.role !== 'system') continue;
    const record = message as unknown as {
      toolsRemoved?: { name: string }[];
      toolsAdded?: { name: string }[];
    };
    for (const tool of record.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of record.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}


it('keeps native section updates in chronological position and excludes them from user text', () => {
  const baseline: AgentMessage = { role: 'system', content: '', sections: { memory: 'old' }, timestamp: 1 };
  const update: AgentMessage = { role: 'system', content: '', sections: { memory: 'new' }, timestamp: 3 };
  const transcript: AgentMessage[] = [baseline,
    { role: 'user', content: [{ type: 'text', text: 'First' }], timestamp: 2 }, update,
    { role: 'user', content: [{ type: 'text', text: 'Second' }], timestamp: 4 }];
  const messages = contextWireRequestMessages(transcript, { totalBytes: 20, records: [
    { role: 'user', text: 'First', sourceIndexes: [1] },
    { role: 'user', text: 'Second', sourceIndexes: [3] },
  ] }, model);
  expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'system', 'user']);
  expect(messages[0]).toBe(baseline);
  expect(messages[2]).toBe(update);
  expect(JSON.stringify(messages.filter((message) => message.role === 'user'))).not.toContain('memory');
});
