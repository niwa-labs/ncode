// W07 part B — the ONE extension dispatcher: band precedence, pinned pi
// dispatch semantics, plugin-hook bridge decisions, and the pi compatibility
// facade. Guards the §4 A5 merge row («два public extension API обслуживаются
// одним dispatcher», plan :183) and the U24 invariant that plugin hooks keep
// their order and decisions (plan :775).

import { describe, expect, it } from 'vitest';

import type { PluginHookCommandHandler, PluginHookDecision, PluginHookEventInput, PluginHookRunResult } from '@mavis/plugin-hooks';
import { ExtensionDispatcher } from '../src/dispatcher.js';
import { createPiExtensionApi, MissingHostCapabilityError } from '../src/pi-compat.js';
import { attachPluginHookBridge } from '../src/plugin-bridge.js';
import { createDispatcherToolHooks } from '../src/agent-hooks.js';
import { PI_EXTENSION_EVENT_NAMES } from '../src/events.js';
import { Type } from '@sinclair/typebox';

function makeDispatcher() {
  return new ExtensionDispatcher();
}

/** Minimal pi tool_call event payload (ToolCallEventBase + Custom tool fields). */
function toolCallEvent(overrides: Record<string, unknown> = {}) {
  return { type: 'tool_call', toolCallId: 'call-1', toolName: 'my_tool', input: { a: 1 }, ...overrides };
}

function toolResultEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'tool_result',
    toolCallId: 'call-1',
    toolName: 'my_tool',
    content: [{ type: 'text', text: 'original' }],
    structuredContent: { value: 1 },
    isError: false,
    ...overrides,
  };
}

describe('band precedence (product > plugin-hook > pi)', () => {
  it('runs bands in order and a higher-band block stops lower bands', async () => {
    const dispatcher = makeDispatcher();
    const calls: string[] = [];
    dispatcher.on('tool_call', () => {
      calls.push('product');
      return undefined;
    }, { band: 'product', owner: 'guard' });
    dispatcher.on('tool_call', () => {
      calls.push('plugin-hook');
      return { block: true, reason: 'denied' };
    }, { band: 'plugin-hook', owner: 'hooks' });
    dispatcher.on('tool_call', () => {
      calls.push('pi');
      return undefined;
    }, { band: 'pi', owner: 'ext' });

    const outcome = await dispatcher.dispatch('tool_call', toolCallEvent());
    expect(calls).toEqual(['product', 'plugin-hook']);
    expect(outcome.result).toEqual({ block: true, reason: 'denied' });
  });

  it('within one band, registration order holds', async () => {
    const dispatcher = makeDispatcher();
    const calls: string[] = [];
    dispatcher.on('session_start', () => { calls.push('first'); }, { band: 'pi', owner: 'a' });
    dispatcher.on('session_start', () => { calls.push('second'); }, { band: 'pi', owner: 'b' });
    await dispatcher.emit('session_start', {});
    expect(calls).toEqual(['first', 'second']);
  });

  it('unsubscribe removes exactly one handler', async () => {
    const dispatcher = makeDispatcher();
    const calls: string[] = [];
    const off = dispatcher.on('session_start', () => { calls.push('x'); }, { band: 'pi', owner: 'a' });
    off();
    await dispatcher.emit('session_start', {});
    expect(calls).toEqual([]);
  });

  it('rejects unknown event names', () => {
    const dispatcher = makeDispatcher();
    expect(() => dispatcher.on('not_an_event', () => {}, { band: 'pi', owner: 'x' })).toThrow(/Unknown extension event/);
  });
});

describe('pi dispatch semantics', () => {
  it('tool_call: truthy block returns immediately (pinned runner :1253–1272)', async () => {
    const dispatcher = makeDispatcher();
    const calls: string[] = [];
    dispatcher.on('tool_call', () => {
      calls.push('h1');
      return { block: true, reason: 'first-block' };
    }, { band: 'pi', owner: 'e1' });
    dispatcher.on('tool_call', () => {
      calls.push('h2');
      return { block: true, reason: 'second' };
    }, { band: 'pi', owner: 'e2' });
    const outcome = await dispatcher.dispatch('tool_call', toolCallEvent());
    expect(calls).toEqual(['h1']);
    expect(outcome.result).toEqual({ block: true, reason: 'first-block' });
  });

  // W07 review round 1 (П2-4): pin keeps the LAST truthy result, not the first
  // — the doc said so, now the code and tests agree.
  it('tool_call: the LAST truthy result wins (pinned emitToolCall)', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('tool_call', () => ({ block: false, reason: 'first' }), { band: 'pi', owner: 'e1' });
    dispatcher.on('tool_call', () => ({ block: false, reason: 'second' }), { band: 'pi', owner: 'e2' });
    const outcome = await dispatcher.dispatch('tool_call', toolCallEvent());
    expect(outcome.result).toEqual({ block: false, reason: 'second' });
  });

  it('tool_call: falsy results never win and truthy non-boolean block returns (pin truthiness)', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('tool_call', () => '' as unknown, { band: 'pi', owner: 'empty-string' });
    dispatcher.on('tool_call', () => 0 as unknown, { band: 'pi', owner: 'zero' });
    dispatcher.on('tool_call', () => null, { band: 'pi', owner: 'null' });
    dispatcher.on('tool_call', () => ({ block: 1, reason: 'truthy-block' }), { band: 'pi', owner: 'truthy-block' });
    dispatcher.on('tool_call', () => ({ block: true, reason: 'never-reached' }), { band: 'pi', owner: 'after' });
    const outcome = await dispatcher.dispatch('tool_call', toolCallEvent());
    expect(outcome.result).toEqual({ block: 1, reason: 'truthy-block' });
  });

  it('tool_call: argument modification happens by mutating event.input in place (pinned doc)', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('tool_call', (event: { input: Record<string, unknown> }) => {
      event.input.a = 42;
      return undefined;
    }, { band: 'pi', owner: 'mutator' });
    const event = toolCallEvent();
    await dispatcher.dispatch('tool_call', event);
    expect((event as { input: Record<string, unknown> }).input.a).toBe(42);
  });

  it('tool_result: fold across ALL handlers; content replace without structuredContent drops it (pinned :1194–1242)', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('tool_result', () => ({ content: [{ type: 'text', text: 'replaced' }] }), { band: 'pi', owner: 'e1' });
    dispatcher.on('tool_result', () => ({ isError: true }), { band: 'pi', owner: 'e2' });
    const outcome = await dispatcher.dispatch('tool_result', toolResultEvent());
    // structuredContent dropped: content was replaced without returning one.
    expect(outcome.result).toEqual({
      content: [{ type: 'text', text: 'replaced' }],
      isError: true,
    });
  });

  it('tool_result: explicit structuredContent survives a content replace', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('tool_result', () => ({
      content: [{ type: 'text', text: 'replaced' }],
      structuredContent: { value: 2 },
    }), { band: 'pi', owner: 'e1' });
    const outcome = await dispatcher.dispatch('tool_result', toolResultEvent());
    expect(outcome.result).toMatchObject({ structuredContent: { value: 2 } });
  });

  it('tool_result: handler errors are isolated, chain continues', async () => {
    const dispatcher = makeDispatcher();
    const errors: unknown[] = [];
    const failing = new ExtensionDispatcher({ onError: (e) => errors.push(e) });
    failing.on('tool_result', () => { throw new Error('boom'); }, { band: 'pi', owner: 'bad' });
    failing.on('tool_result', () => ({ isError: true }), { band: 'pi', owner: 'good' });
    const outcome = await failing.dispatch('tool_result', toolResultEvent());
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toMatchObject({ owner: 'bad', event: 'tool_result' });
    // The good handler's override applied; unchanged fields carried through.
    expect(outcome.result).toMatchObject({ isError: true, structuredContent: { value: 1 } });
    void errors;
  });

  it('tool_call: handler errors propagate (pinned emitToolCall does not catch)', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('tool_call', () => { throw new Error('surfaced'); }, { band: 'pi', owner: 'bad' });
    await expect(dispatcher.dispatch('tool_call', toolCallEvent())).rejects.toThrow('surfaced');
  });

  it('notify events fan out to every band with error isolation', async () => {
    const failing = new ExtensionDispatcher();
    const calls: string[] = [];
    failing.on('session_start', () => { throw new Error('x'); }, { band: 'product', owner: 'p' });
    failing.on('session_start', () => { calls.push('pi'); }, { band: 'pi', owner: 'e' });
    const outcome = await failing.emit('session_start', {});
    expect(outcome.errors).toHaveLength(1);
    expect(calls).toEqual(['pi']);
  });

  it('cancellable session_before_* events cancel when any handler cancels', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('session_before_compact', () => undefined, { band: 'pi', owner: 'a' });
    dispatcher.on('session_before_compact', () => ({ cancel: true }), { band: 'pi', owner: 'b' });
    const outcome = await dispatcher.dispatch('session_before_compact', { type: 'session_before_compact' });
    expect(outcome.result).toEqual({ cancel: true });
  });

  it('exposes the full pinned pi event surface', () => {
    // 41 pi on() events (pinned ExtensionEvent union, types.ts :1405–1442).
    expect(PI_EXTENSION_EVENT_NAMES).toHaveLength(41);
    for (const name of ['session_start', 'tool_call', 'tool_result', 'input', 'user_bash', 'context', 'before_agent_start']) {
      expect(PI_EXTENSION_EVENT_NAMES).toContain(name);
    }
  });

  // W07 review round 1 (П2-2): `input` must accumulate transforms along the
  // chain like pinned `emitInput` (:1525–1566), NOT stop at the first result —
  // a plugin-hook transform must not silence pi-band input handlers.
  it('input: transform accumulates across bands; pi band sees the transformed text', async () => {
    const dispatcher = makeDispatcher();
    const seen: string[] = [];
    dispatcher.on('input', () => ({ action: 'transform', text: 'prefix' }), { band: 'plugin-hook', owner: 'hooks' });
    dispatcher.on('input', (event: { text: string }) => {
      seen.push(event.text);
      return { action: 'transform', text: `${event.text}+pi` };
    }, { band: 'pi', owner: 'ext' });
    const outcome = await dispatcher.dispatch('input', { type: 'input', text: 'hi', source: 'interactive' });
    expect(seen).toEqual(['prefix']);
    expect(outcome.result).toEqual({ action: 'transform', text: 'prefix+pi', images: undefined });
  });

  it('input: handled short-circuits; unchanged chain continues; handler errors isolated', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('input', () => { throw new Error('boom'); }, { band: 'pi', owner: 'bad' });
    const unchanged = await dispatcher.dispatch('input', { type: 'input', text: 'hi' });
    expect(unchanged.result).toEqual({ action: 'continue' });
    expect(unchanged.errors).toHaveLength(1);

    const consuming = makeDispatcher();
    consuming.on('input', () => undefined, { band: 'pi', owner: 'noop' });
    consuming.on('input', () => ({ action: 'handled' }), { band: 'pi', owner: 'consumer' });
    consuming.on('input', () => ({ action: 'transform', text: 'never' }), { band: 'pi', owner: 'after' });
    const handled = await consuming.dispatch('input', { type: 'input', text: 'hi' });
    expect(handled.result).toEqual({ action: 'handled' });
  });

  it('input: every handler gets a fresh event (in-place edits do not leak)', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('input', (event: { text: string }) => {
      event.text = 'mutated';
      return undefined;
    }, { band: 'pi', owner: 'mutator' });
    const outcome = await dispatcher.dispatch('input', { type: 'input', text: 'hi' });
    expect(outcome.result).toEqual({ action: 'continue' });
  });

  // W07 review round 1 (П2-3): `context` mirrors pinned `emitContext`
  // (:1305–1360) — in-place edits of event.messages are picked up, and the
  // system messages are restored over a changed visible transcript.
  it('context: in-place mutation of event.messages is applied', async () => {
    const dispatcher = makeDispatcher();
    const event = { type: 'context', messages: [{ role: 'user', content: 'keep' }, { role: 'assistant', content: 'drop' }] };
    dispatcher.on('context', (e: { messages: unknown[] }) => {
      e.messages.splice(1, 1);
    }, { band: 'pi', owner: 'pruner' });
    const outcome = await dispatcher.dispatch('context', event);
    expect(outcome.result).toEqual({ messages: [{ role: 'user', content: 'keep' }] });
  });

  it('context: system messages are restored as one leading system message over a changed transcript', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('context', () => ({ messages: [{ role: 'user', content: 'compacted' }] }), { band: 'pi', owner: 'compactor' });
    const outcome = await dispatcher.dispatch('context', {
      type: 'context',
      messages: [
        { role: 'system', content: 'prompt', sections: { style: 'terse' }, timestamp: 1 },
        { role: 'user', content: 'old' },
      ],
    });
    const messages = (outcome.result as { messages: { role: string; content?: string; sections?: unknown }[] }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('prompt');
    expect(messages[1]).toEqual({ role: 'user', content: 'compacted' });
  });

  it('context: an unchanged conversation keeps the system messages in place (cache-stable)', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('context', (e: { messages: unknown[] }) => e.messages.map((m) => m), { band: 'pi', owner: 'identity' });
    const outcome = await dispatcher.dispatch('context', {
      type: 'context',
      messages: [
        { role: 'system', content: 'prompt' },
        { role: 'user', content: 'u1' },
      ],
    });
    const messages = (outcome.result as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(2);
    expect((messages[0] as { role: string }).role).toBe('system');
    expect((messages[1] as { role: string }).role).toBe('user');
  });

  it('context: handlers chain — the later handler sees the earlier returned list', async () => {
    const dispatcher = makeDispatcher();
    const seen: number[] = [];
    dispatcher.on('context', () => ({ messages: [{ role: 'user', content: 'a' }] }), { band: 'pi', owner: 'first' });
    dispatcher.on('context', (e: { messages: unknown[] }) => {
      seen.push(e.messages.length);
      return undefined;
    }, { band: 'pi', owner: 'second' });
    await dispatcher.dispatch('context', { type: 'context', messages: [{ role: 'user', content: 'x' }] });
    expect(seen).toEqual([1]);
  });

  it('context_with_system: returned list is used as returned; dropping the leading system message is reported', async () => {
    const reporting = new ExtensionDispatcher();
    reporting.on('context_with_system', () => ({ messages: [{ role: 'user', content: 'no system' }] }), { band: 'pi', owner: 'dropper' });
    const outcome = await reporting.dispatch('context_with_system', {
      type: 'context_with_system',
      messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'u1' }],
    });
    expect(outcome.result).toEqual({ messages: [{ role: 'user', content: 'no system' }] });
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]?.message).toContain('leading system message');

    const keeping = makeDispatcher();
    keeping.on('context_with_system', () => undefined, { band: 'pi', owner: 'noop' });
    const kept = await keeping.dispatch('context_with_system', {
      type: 'context_with_system',
      messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'u1' }],
    });
    expect((kept.result as { messages: unknown[] }).messages).toHaveLength(2);
  });
});

describe('plugin-hook bridge (U24: hooks preserved, decisions applied)', () => {
  interface FakeRun {
    args: PluginHookEventInput[];
    decision: PluginHookDecision | undefined;
  }
  function fakeBridgeOptions(dispatcher: ExtensionDispatcher, fake: FakeRun) {
    const handler: PluginHookCommandHandler = {
      kind: 'command',
      sourceFormat: 'MINIMAX',
      pluginName: 'p',
      pluginRoot: '/p',
      sourcePath: '/p/hook.sh',
      event: 'PreToolUse',
      command: 'echo',
      timeoutMs: 1000,
      declarationOrder: 0,
    };
    return {
      dispatcher,
      handlers: [handler],
      run: async (handlers: readonly PluginHookCommandHandler[], input: PluginHookEventInput): Promise<PluginHookRunResult> => {
        fake.args.push(input);
        return {
          decision: fake.decision ?? { decision: 'allow' },
          diagnostics: [],
        };
      },
      project: (event: string, payload: Record<string, unknown>) => {
        void event;
        return {
          sessionId: 's1',
          cwd: '/w',
          payload,
        };
      },
    };
  }

  it('PreToolUse deny blocks the tool call with the hook reason', async () => {
    const dispatcher = makeDispatcher();
    const fake: FakeRun = { args: [], decision: { decision: 'deny', toolPermissionDecision: 'deny', reason: 'no rm' } };
    attachPluginHookBridge(fakeBridgeOptions(dispatcher, fake));
    const outcome = await dispatcher.dispatch('tool_call', toolCallEvent({ toolName: 'bash' }));
    expect(outcome.result).toEqual({ block: true, reason: 'no rm' });
    expect(fake.args[0].event).toBe('PreToolUse');
    expect(fake.args[0].sessionId).toBe('s1');
  });

  it('PreToolUse updatedInput mutates event.input in place for later handlers and the executor', async () => {
    const dispatcher = makeDispatcher();
    const seen: unknown[] = [];
    const fake: FakeRun = { args: [], decision: { decision: 'allow', updatedInput: { a: 99 } } };
    attachPluginHookBridge(fakeBridgeOptions(dispatcher, fake));
    dispatcher.on('tool_call', (event: { input: Record<string, unknown> }) => {
      seen.push(event.input.a);
      return undefined;
    }, { band: 'pi', owner: 'observer' });
    const event = toolCallEvent();
    await dispatcher.dispatch('tool_call', event);
    expect(seen).toEqual([99]);
    expect((event as { input: Record<string, unknown> }).input.a).toBe(99);
  });

  it('PostToolUse updatedResult replaces the model-visible content only', async () => {
    const dispatcher = makeDispatcher();
    const fake: FakeRun = { args: [], decision: { decision: 'allow', updatedResult: 'sanitized' } };
    attachPluginHookBridge(fakeBridgeOptions(dispatcher, fake));
    const outcome = await dispatcher.dispatch('tool_result', toolResultEvent());
    // Content replaced (model-visible), structuredContent dropped with it (pin
    // fold rule), carried isError stays. Audit keeps the original — host duty.
    expect(outcome.result).toMatchObject({ content: [{ type: 'text', text: 'sanitized' }] });
    expect((outcome.result as Record<string, unknown>).structuredContent).toBeUndefined();
  });

  it('UserPromptSubmit deny consumes the input', async () => {
    const dispatcher = makeDispatcher();
    const fake: FakeRun = { args: [], decision: { decision: 'deny' } };
    attachPluginHookBridge(fakeBridgeOptions(dispatcher, fake));
    const outcome = await dispatcher.dispatch('input', { type: 'input', text: 'hi', source: 'interactive' });
    expect(outcome.result).toEqual({ action: 'handled' });
  });

  it('every mapped plugin event dispatches through the one funnel', async () => {
    const dispatcher = makeDispatcher();
    const fake: FakeRun = { args: [], decision: { decision: 'allow' } };
    attachPluginHookBridge(fakeBridgeOptions(dispatcher, fake));
    const events: [string, Record<string, unknown>][] = [
      ['session_start', { type: 'session_start' }],
      ['session_shutdown', { type: 'session_shutdown' }],
      ['input', { type: 'input', text: 'x' }],
      ['tool_call', toolCallEvent()],
      ['permission_request', { type: 'permission_request', toolName: 'bash' }],
      ['tool_result', toolResultEvent()],
      ['session_before_compact', { type: 'session_before_compact' }],
      ['session_compact', { type: 'session_compact' }],
      ['agent_end', { type: 'agent_end' }],
      ['subagent_start', { type: 'subagent_start' }],
      ['subagent_stop', { type: 'subagent_stop' }],
    ];
    for (const [name, payload] of events) {
      await dispatcher.emit(name, payload);
    }
    // 11 of 11 plugin SPI events reached the runner through one dispatcher.
    expect(fake.args.map((input) => input.event)).toEqual([
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
      'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'SubagentStart', 'SubagentStop',
    ]);
  });
});

describe('pi compatibility facade', () => {
  it('satisfies the pinned ExtensionAPI surface and writes the dispatcher registries', () => {
    const dispatcher = makeDispatcher();
    const api = createPiExtensionApi({ dispatcher, owner: 'ext-a' });
    // Type-level: `createPiExtensionApi` is declared `satisfies ExtensionAPI` —
    // compile-time proof of surface compatibility.

    api.registerCommand('greet', { description: 'says hi', handler: async () => {} });
    api.registerFlag('verbose', { type: 'boolean', default: false });
    api.registerShortcut('ctrl+g', { handler: () => {} });
    api.registerTool({
      name: 'ext_tool',
      label: 'ext_tool',
      description: 'extension tool',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
    });
    api.registerProvider('my-proxy', { baseUrl: 'https://proxy.example.com', api: 'openai-completions' });
    api.registerMcpServer('jira', { url: 'https://mcp.example.com' });
    api.registerVirtualModel({ provider: 'my-proxy', id: 'router', route: async () => ({}) } as never);
    api.registerMarkdownTransformer((markdown) => markdown);

    expect(dispatcher.getCommand('greet')?.owner).toBe('ext-a');
    expect(dispatcher.getFlag('verbose')).toBe(false);
    expect(dispatcher.getShortcuts()).toHaveLength(1);
    expect(dispatcher.getTool('ext_tool')?.band).toBe('pi');
    expect(dispatcher.getProviderNames()).toEqual(['my-proxy']);
    expect(dispatcher.getMcpServerNames()).toEqual(['jira']);
    expect(dispatcher.getVirtualModelKeys()).toEqual(['my-proxy/router']);
    expect(dispatcher.getMarkdownTransformers()).toHaveLength(1);
  });

  it('duplicate registrations fail loudly, not silently', () => {
    const dispatcher = makeDispatcher();
    const api = createPiExtensionApi({ dispatcher, owner: 'ext-a' });
    const apiB = createPiExtensionApi({ dispatcher, owner: 'ext-b' });
    api.registerCommand('dup', { handler: async () => {} });
    expect(() => apiB.registerCommand('dup', { handler: async () => {} })).toThrow(/already registered/);
  });

  it('session effects without a host capability throw instead of silently no-oping', () => {
    const dispatcher = makeDispatcher();
    const api = createPiExtensionApi({ dispatcher, owner: 'ext-a' });
    expect(() => api.appendEntry('custom', {})).toThrow(MissingHostCapabilityError);
    expect(() => api.getActiveTools()).toThrow(MissingHostCapabilityError);
    expect(() => api.setActiveTools(['read'])).toThrow(MissingHostCapabilityError);
  });

  it('subscribes only to pi event names; product events are not reachable from the facade', () => {
    const dispatcher = makeDispatcher();
    const api = createPiExtensionApi({ dispatcher, owner: 'ext-a' });
    expect(() => api.on('permission_request' as never, () => {})).toThrow(/Unknown extension event/);
    const off = api.on('tool_call', () => {});
    expect(typeof off).toBe('function');
    off();
  });
});

describe('gateway tool hooks funnel', () => {
  function fakeContext() {
    return {
      assistantMessage: { role: 'assistant', content: [] },
      toolCall: { id: 'call-9', name: 'read', input: { path: 'a.ts' } },
      args: { path: 'a.ts' },
      context: {},
      result: { content: [{ type: 'text', text: 'file body' }], details: {} },
      isError: false,
    } as never;
  }

  it('beforeToolCall dispatches tool_call and maps block results', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('tool_call', (event) => {
      expect((event as { toolName: string }).toolName).toBe('read');
      return { block: true, reason: 'denied by extension' };
    }, { band: 'pi', owner: 'e' });
    const hooks = createDispatcherToolHooks(dispatcher);
    const result = await hooks.beforeToolCall(fakeContext());
    expect(result).toMatchObject({ block: true, reason: 'denied by extension' });
  });

  it('afterToolCall dispatches tool_result and applies the fold as an override patch', async () => {
    const dispatcher = makeDispatcher();
    dispatcher.on('tool_result', () => ({ content: [{ type: 'text', text: 'redacted' }] }), { band: 'pi', owner: 'e' });
    const hooks = createDispatcherToolHooks(dispatcher);
    const patch = await hooks.afterToolCall(fakeContext());
    expect(patch).toMatchObject({ content: [{ type: 'text', text: 'redacted' }] });
  });

  it('afterToolCall with no handler override returns undefined (no patch)', async () => {
    const dispatcher = makeDispatcher();
    const hooks = createDispatcherToolHooks(dispatcher);
    expect(await hooks.afterToolCall(fakeContext())).toBeUndefined();
  });
});
