import { describe, expect, it, vi } from 'vitest';
import { toRuntimeTool } from '@mavis/agent-core/tools';
import { restrictMavisToSessionHistory, isSessionHistoryOnlyTool, LocalMavisTool } from '../../src/desktop/local-mavis.js';
import type { LocalMavisAgentAdapter, LocalMavisSessionAdapter } from '../../src/desktop/types.js';

function fixture() {
  const listMessages = vi.fn(async () => ({
    messages: [{ msg_id: 'message-2', role: 'user', msg_content: 'Original decision' }],
    hasMore: true,
    nextCursor: 'message-2',
  }));
  const tool = new LocalMavisTool({} as LocalMavisAgentAdapter, undefined, { listMessages } as unknown as LocalMavisSessionAdapter);
  const run = (args: Record<string, unknown>, signal?: AbortSignal) => tool.execute(
    { sessionId: 'session-current', agentName: 'mavis', turnId: 'history-read' },
    { command: 'session messages', args }, signal,
  );
  return { listMessages, run };
}

describe('mavis session messages contract', () => {
  it('resolves me and returns the service cursor without changing message identity', async () => {
    const { run, listMessages } = fixture();
    const result = await run({ session_id: 'me', limit: 2, before: 'message-3' });
    expect(listMessages).toHaveBeenCalledWith({ sessionId: 'session-current', limit: 2, before: 'message-3' }, undefined);
    expect(JSON.parse(result.text)).toMatchObject({ ok: true, response: {
      messages: [{ msg_id: 'message-2', msg_content: 'Original decision' }], hasMore: true, nextCursor: 'message-2',
    } });
  });

  it.each([0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER])('rejects invalid page size %s before reading', async (limit) => {
    const { run, listMessages } = fixture();
    const result = await run({ session_id: 'me', limit });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('rejects unsupported cursor/filter arguments rather than silently repeating a page', async () => {
    const { run, listMessages } = fixture();
    const result = await run({ session_id: 'me', cursor: 'acp-cursor-is-not-before', search: 'needle' });
    expect(result.isError).toBe(true);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('does not read history when the tool call is already cancelled', async () => {
    const { run, listMessages } = fixture();
    const controller = new AbortController(); controller.abort();
    const result = await run({ session_id: 'me' }, controller.signal);
    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toContain('abort');
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('forwards explicit cloud routing and bounded paging', async () => {
    const { run, listMessages } = fixture();
    const result = await run({ session_id: 'cloud-explicit', source: 'cloud', limit: 100, before: 'cloud-before' });
    expect(result.isError).not.toBe(true);
    expect(listMessages).toHaveBeenCalledWith({ sessionId: 'cloud-explicit', source: 'cloud', limit: 100, before: 'cloud-before' }, undefined);
  });

  it('rejects cloud me and reports a missing session without claiming an empty success', async () => {
    const { run, listMessages } = fixture();
    expect((await run({ session_id: 'me', source: 'cloud' })).isError).toBe(true);
    expect(listMessages).not.toHaveBeenCalled();
    listMessages.mockRejectedValueOnce(new Error('Session not found: missing-session'));
    const result = await run({ session_id: 'missing-session' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Session not found');
  });
  it('returns only conversation text and preserves paging across a tool-only page', async () => {
    const { run, listMessages } = fixture();
    listMessages.mockResolvedValueOnce({
      messages: [{ msg_id: 'message-2', role: 'assistant', msg_content: 'Decision',
        thinking_content: 'THINKING_PRIVATE', tool_calls: [{ tool_call_args: 'RAW_ARGS_PRIVATE', tool_call_result_data: 'RAW_RESULT_PRIVATE' }],
        attachments: [{ data: 'BASE64_PRIVATE' }] }],
      hasMore: true, nextCursor: 'message-2',
    } as never);
    const result = await run({ session_id: 'me' });
    expect(listMessages).toHaveBeenCalledWith({ sessionId: 'session-current', limit: 20 }, undefined);
    expect(JSON.stringify(result)).not.toMatch(/THINKING_PRIVATE|RAW_ARGS_PRIVATE|RAW_RESULT_PRIVATE|BASE64_PRIVATE/);
    expect(JSON.parse(result.text)).toMatchObject({ response: { format: 'text', messages: [
      { msg_id: 'message-2', role: 'assistant', msg_content: 'Decision' },
    ] } });
    listMessages.mockResolvedValueOnce({ messages: [{ msg_id: 'tool-only', role: 'assistant', tool_calls: [] }], hasMore: true, nextCursor: 'tool-only' } as never);
    expect(JSON.parse((await run({ session_id: 'me', limit: 1 })).text)).toMatchObject({ response: { messages: [], hasMore: true, nextCursor: 'tool-only' } });
  });

  it('keeps large Unicode pages valid JSON with honest text truncation and a usable cursor', async () => {
    const { run, listMessages } = fixture();
    listMessages.mockResolvedValueOnce({ messages: Array.from({ length: 100 }, (_, index) => ({
      msg_id: 'message-' + index, role: 'user', msg_content: '🌸漢'.repeat(10000),
    })), hasMore: true, nextCursor: 'message-0' } as never);
    const result = await run({ session_id: 'me', limit: 100 });
    expect(result.isError).not.toBe(true);
    const output = JSON.parse(result.text);
    expect(output.response.nextCursor).toBe('message-0');
    expect(output.response.messages).toHaveLength(100);
    expect(output.response.messages.every((m: Record<string, unknown>) => m.text_truncated === true && m.original_chars === 30000)).toBe(true);
    expect(result.details).not.toHaveProperty('truncated');
  });

  it('does not return a successful page after cancellation during the read', async () => {
    const { run, listMessages } = fixture();
    const controller = new AbortController();
    listMessages.mockImplementationOnce(async () => { controller.abort(); return { messages: [], hasMore: false }; });
    const result = await run({ session_id: 'me' }, controller.signal);
    expect(result.isError).toBe(true);
  });

  it('exposes the same command in a current-session-only facade and rejects management/cross-session calls at runtime', async () => {
    const listMessages = vi.fn(async () => ({ messages: [{ msg_id: 'm1', role: 'user', msg_content: 'History' }], hasMore: false }));
    const full = toRuntimeTool(new LocalMavisTool({} as LocalMavisAgentAdapter, undefined, { listMessages } as unknown as LocalMavisSessionAdapter));
    const scoped = restrictMavisToSessionHistory(full);
    expect(scoped.def.name).toBe('mavis');
    expect(isSessionHistoryOnlyTool(scoped)).toBe(true);
    expect(isSessionHistoryOnlyTool(full)).toBe(false);
    const ctx = { sessionId: 'session-current', agentName: 'mavis', turnId: 'history-read' };
    const result = await scoped.impl.execute(ctx, { command: 'session messages' });
    expect(result.isError).not.toBe(true);
    expect(listMessages).toHaveBeenCalledWith({ sessionId: 'session-current', limit: 20 }, undefined);
    listMessages.mockClear();
    for (const input of [
      { command: 'session send', args: { session_id: 'me', content: 'mutate' } },
      { command: 'agent delete', args: { agent_name: 'me' } },
      { command: 'session messages', args: { session_id: 'other-session' } },
      { command: 'session messages', args: { session_id: 'me', source: 'cloud' } },
      { command: 'session messages', args: 42 },
      { command: 'session messages', args: null },
    ]) expect((await scoped.impl.execute(ctx, input)).isError).toBe(true);
    expect(listMessages).not.toHaveBeenCalled();
  });

});
