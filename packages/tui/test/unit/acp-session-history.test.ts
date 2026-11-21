import * as acp from '@agentclientprotocol/sdk';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createTuiAcpAgent } from '../../src/acp/agent.js';
import type { TuiAcpRuntime } from '../../src/acp/runtime.js';
import type { TuiContextSnapshotResponse, TuiRuntimeEvent } from '../../src/runtime/port.js';
import { normalizeTuiMessage } from '../../src/runtime/stream-events.js';
import type { TuiMessage } from '../../src/runtime/stream-events.js';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcode-acp-history-'));
  tempRoots.push(root);
  return root;
}

/** Writes one old-format v2 session directory; returns the profile dataDir. */
function writeLegacySession(root: string, sessionId: string, envelopes: unknown[]): string {
  const sessionDir = join(
    root,
    'v2',
    'sessions',
    '2026',
    '10',
    '12',
    `10-00-00-000-session_${Buffer.from(sessionId, 'utf8').toString('base64url')}`,
  );
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'messages.jsonl'),
    `${envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\n`,
  );
  return root;
}

/**
 * Stands up the durable-store paging contract over `listMessagePage`: a
 * bounded page is the newest `limit` messages strictly before the anchor,
 * presented chronologically, with `nextCursor` at the page's oldest message
 * (local-runtime-v2 messages repo, drizzle list). `messagesBySession` serves
 * several Sessions from one Runtime (the default map holds the single
 * `session-1`), and `events` overrides the Runtime event stream.
 */
function createHistoryRuntime(
  messages: readonly TuiMessage[],
  options: {
    session?: Record<string, unknown>;
    getSessionError?: Error;
    dataDir?: string;
    messagesBySession?: Record<string, readonly TuiMessage[]>;
    events?: (signal: AbortSignal) => AsyncGenerator<TuiRuntimeEvent>;
  } = {},
) {
  const messagesBySession = options.messagesBySession ?? { 'session-1': messages };
  const listMessagePage = vi.fn(
    async (sessionId: string, input: { limit?: number; before?: string } = {}) => {
      const history = messagesBySession[sessionId];
      if (!history) {
        throw new Error(`Runtime did not return session ${sessionId}.`);
      }
      const limit = input.limit ?? 80;
      const anchorIndex = input.before
        ? history.findIndex((message) => message.id === input.before)
        : history.length;
      const candidates = history.slice(0, anchorIndex);
      const hasMore = candidates.length > limit;
      const page = hasMore ? candidates.slice(candidates.length - limit) : candidates;
      return {
        messages: page,
        hasMore,
        ...(hasMore && page[0]?.id ? { nextCursor: page[0].id } : {}),
      };
    },
  );
  const getSession = vi.fn(async (sessionId: string) => {
    if (options.getSessionError) throw options.getSessionError;
    if (!messagesBySession[sessionId]) {
      throw new Error(`Runtime did not return session ${sessionId}.`);
    }
    return {
      sessionId,
      workspaceDir: '/workspace',
      title: 'Durable history probe',
      createdAt: 1700000000000,
      model: { providerId: 'minimax', modelId: 'MiniMax-M3' },
      ...options.session,
    };
  });
  const clearSessionMcpServers = vi.fn(async () => undefined);
  const configureSessionMcpServers = vi.fn(async () => undefined);
  const deleteSession = vi.fn(async () => undefined);
  const archiveSession = vi.fn(async () => undefined);
  const selectModel = vi.fn(async () => true);
  const setPermissionMode = vi.fn(async () => 'default' as const);
  const runtime = {
    createSession: vi.fn(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: 'session-1',
      workspaceDir,
    })),
    configureSessionMcpServers,
    clearSessionMcpServers,
    deleteSession,
    archiveSession,
    listSessionPage: vi.fn(async () => ({ sessions: [], hasMore: false })),
    getSession,
    listMessagePage,
    getAccountStatus: vi.fn(async () => ({ status: 'ready' as const, warnings: [] })),
    getRuntimeDiagnostics: vi.fn(async () => ({
      warnings: [],
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    })),
    getContextSnapshot: vi.fn(async (): Promise<TuiContextSnapshotResponse> => ({
      status: 'empty' as const,
    })),
    getSessionUsage: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => ({})),
    listMcpServers: vi.fn(async () => []),
    requestCompaction: vi.fn(async () => ({ success: true })),
    getPlanModeCapabilities: vi.fn(async () => ({ entryEnabled: true })),
    getPermissionMode: vi.fn(async () => 'default' as const),
    setPermissionMode,
    steer: vi.fn(async () => undefined),
    listQueuedMessages: vi.fn(async () => []),
    enqueueMessage: vi.fn(async () => ({ itemId: 'queue-1', position: 1 })),
    updateQueuedMessageContent: vi.fn(async () => undefined),
    deleteQueuedMessage: vi.fn(async () => undefined),
    steerQueuedMessage: vi.fn(async () => ({ queueItemId: 'queue-1', turnId: 'turn-2' })),
    isGoalEnabled: vi.fn(() => true),
    getGoal: vi.fn(async () => undefined),
    createGoal: vi.fn(async () => undefined),
    patchGoal: vi.fn(async () => undefined),
    clearGoal: vi.fn(async () => true),
    getDelegationSnapshot: vi.fn(async () => undefined),
    stopDelegation: vi.fn(async () => undefined),
    getSessionForkOptions: vi.fn(async () => ({
      canFork: false,
      worktreeVisible: false,
      worktreeEligible: false,
    })),
    forkSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async function* () {}),
    abortSession: vi.fn(async () => true),
    listModels: vi.fn(async () => []),
    selectModel,
    selectSessionModel: vi.fn(async () => true),
    replyPermission: vi.fn(async () => true),
    replyQuestionnaire: vi.fn(async () => true),
    dismissQuestionnaire: vi.fn(async () => true),
    watchEvents: vi.fn((signal: AbortSignal) =>
      options.events
        ? options.events(signal)
        : (async function* runtimeEvents() {
            while (!signal.aborted) yield await new Promise<never>(() => undefined);
          })(),
    ),
    watchSessionTurn: vi.fn(() =>
      (async function* sessionEvents() {
        yield { type: 'session-status', status: 'finished' } as const;
      })(),
    ),
  };
  return {
    runtime: runtime as unknown as TuiAcpRuntime,
    getSession,
    listMessagePage,
    clearSessionMcpServers,
    configureSessionMcpServers,
    deleteSession,
    archiveSession,
    selectModel,
    setPermissionMode,
    getRuntimeDiagnostics: runtime.getRuntimeDiagnostics,
  };
}

function userMessage(id: string, text: string): TuiMessage {
  return { id, role: 'user', content: text, timestamp: 1700000000000 };
}

function assistantMessage(id: string, text: string): TuiMessage {
  return { id, role: 'assistant', content: text, timestamp: 1700000001000 };
}

/** Opaque cursor envelope mirroring the agent-side codec. */
function encodeHistoryCursor(before: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: 'session-history', before })).toString('base64url');
}

async function requestHistory(
  runtime: TuiAcpRuntime,
  params: Record<string, unknown>,
): Promise<unknown> {
  const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
  const client = acp.client({ name: 'history-reader' });
  return await client.connectWith(agent, async (connection) => {
    await connection.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    return await connection.request('session/history', params);
  });
}

/** Pushable Runtime event stream: `push` feeds `watchEvents` consumers. */
function createRuntimeEventChannel(): {
  push(event: TuiRuntimeEvent): void;
  watch(signal: AbortSignal): AsyncGenerator<TuiRuntimeEvent>;
} {
  const queued: TuiRuntimeEvent[] = [];
  const waiters: (() => void)[] = [];
  return {
    push(event: TuiRuntimeEvent): void {
      queued.push(event);
      for (const wake of waiters.splice(0)) wake();
    },
    watch(signal: AbortSignal): AsyncGenerator<TuiRuntimeEvent> {
      return (async function* runtimeChannelEvents() {
        while (!signal.aborted) {
          while (queued.length > 0) yield queued.shift() as TuiRuntimeEvent;
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
      })();
    },
  };
}

/** One agent + one Client connection shared by every `session/history` call. */
async function withHistoryReader(
  runtime: TuiAcpRuntime,
  script: (
    request: (params: Record<string, unknown>) => Promise<unknown>,
    connection: acp.ClientConnection,
  ) => Promise<void>,
): Promise<void> {
  const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
  const client = acp.client({ name: 'history-reader' });
  await client.connectWith(agent, async (connection) => {
    await connection.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await script((params) => connection.request('session/history', params), connection);
  });
}

/** Full-history walks issued against one Session (repo-method spy). */
function historyWalkCount(
  listMessagePage: { readonly mock: { readonly calls: readonly unknown[][] } },
  sessionId: string,
): number {
  return listMessagePage.mock.calls.filter(([id]) => id === sessionId).length;
}

/** Lets the Runtime event stream deliver already-pushed events to the agent. */
async function flushRuntimeEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function turnStartedEvent(sessionId: string): TuiRuntimeEvent {
  return {
    type: 'session.start',
    sessionId,
    timestampMs: 1700000080000,
    source: 'test',
    queueItemIds: [],
  };
}

function turnFinishedEvent(sessionId: string): TuiRuntimeEvent {
  return {
    type: 'session.finish',
    sessionId,
    timestampMs: 1700000090000,
    source: 'test',
    queueItemIds: [],
  };
}

function rewindEvent(sessionId: string): TuiRuntimeEvent {
  return {
    type: 'message.rewind',
    sessionId,
    timestampMs: 1700000070000,
    source: 'test',
  };
}

describe('MiniMax Code ACP session/history', () => {
  it('serves mapped entries, totalEntries and sessionMeta without attaching the Session', async () => {
    const messages: TuiMessage[] = [
      userMessage('m1', 'Fix the flaky check'),
      assistantMessage('m2', 'On it'),
      {
        id: 'm3',
        role: 'user',
        timestamp: 1700000002000,
        toolResult: { toolCallId: 'tool-1', toolName: 'bash' },
      },
      { id: 'm4', role: 'assistant', kind: 'compaction', content: 'Summary of earlier turns' },
      { id: 'm5', role: 'system', kind: 'review_result', content: 'Review finished' },
      { id: 'm6', role: 'unknown', content: 'Guard reminder' },
      userMessage('m7', 'Thanks'),
    ];
    const fixture = createHistoryRuntime(messages);
    const page = (await requestHistory(fixture.runtime, { sessionId: 'session-1' })) as {
      entries: Record<string, unknown>[];
      totalEntries: number;
      nextCursor?: string;
      sessionMeta?: Record<string, unknown>;
    };
    expect(page.totalEntries).toBe(7);
    expect(page.nextCursor).toBeUndefined();
    expect(page.entries).toEqual([
      { role: 'user', text: 'Fix the flaky check', timestamp: 1700000000000 },
      { role: 'assistant', text: 'On it', timestamp: 1700000001000 },
      { role: 'toolResult', toolCallId: 'tool-1', toolName: 'bash', timestamp: 1700000002000 },
      { role: 'compactionSummary', text: 'Summary of earlier turns' },
      { role: 'custom', customType: 'review_result', text: 'Review finished' },
      { role: 'custom', text: 'Guard reminder' },
      { role: 'user', text: 'Thanks', timestamp: 1700000000000 },
    ]);
    expect(page.sessionMeta).toEqual({
      sessionId: 'session-1',
      title: 'Durable history probe',
      createdAt: new Date(1700000000000).toISOString(),
      model: { providerId: 'minimax', modelId: 'MiniMax-M3' },
      health: {
        schemaVersion: 1,
        source: 'durable',
        running: false,
        turns: 0,
        llmCalls: 0,
        compactions: { done: 1, failed: 0, open: 0 },
        injections: { steers: 0, reminders: {} },
        resumedTurns: 0,
      },
    });
    // READ-ONLY guarantees: no attach, no MCP overlay, no state change.
    expect(fixture.getSession).toHaveBeenCalledWith('session-1');
    expect(fixture.listMessagePage).toHaveBeenCalledTimes(1);
    expect(fixture.listMessagePage).toHaveBeenCalledWith('session-1', { limit: 500 });
    // The durable hit never consults the legacy fallback.
    expect(fixture.getRuntimeDiagnostics).not.toHaveBeenCalled();
    expect(fixture.clearSessionMcpServers).not.toHaveBeenCalled();
    expect(fixture.configureSessionMcpServers).not.toHaveBeenCalled();
    expect(fixture.deleteSession).not.toHaveBeenCalled();
    expect(fixture.archiveSession).not.toHaveBeenCalled();
    expect(fixture.selectModel).not.toHaveBeenCalled();
    expect(fixture.setPermissionMode).not.toHaveBeenCalled();
  });

  it('pages backwards through the whole session with a constant totalEntries', async () => {
    const messages: TuiMessage[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id, index) =>
      assistantMessage(id, `entry ${index + 1}`),
    );
    const fixture = createHistoryRuntime(messages);
    const first = (await requestHistory(fixture.runtime, {
      sessionId: 'session-1',
      limit: 3,
    })) as { entries: { text: string }[]; totalEntries: number; nextCursor?: string };
    expect(first.entries.map((entry) => entry.text)).toEqual(['entry 5', 'entry 6', 'entry 7']);
    expect(first.totalEntries).toBe(7);
    expect(first.nextCursor).toBe(encodeHistoryCursor('m5'));

    const second = (await requestHistory(fixture.runtime, {
      sessionId: 'session-1',
      limit: 3,
      cursor: first.nextCursor,
    })) as { entries: { text: string }[]; totalEntries: number; nextCursor?: string };
    expect(second.entries.map((entry) => entry.text)).toEqual(['entry 2', 'entry 3', 'entry 4']);
    expect(second.totalEntries).toBe(7);
    expect(second.nextCursor).toBe(encodeHistoryCursor('m2'));

    const last = (await requestHistory(fixture.runtime, {
      sessionId: 'session-1',
      limit: 3,
      cursor: second.nextCursor,
    })) as { entries: { text: string }[]; totalEntries: number; nextCursor?: string };
    expect(last.entries.map((entry) => entry.text)).toEqual(['entry 1']);
    expect(last.totalEntries).toBe(7);
    expect(last.nextCursor).toBeUndefined();
  });

  it('defaults the page size to 100 and caps it at 500', async () => {
    const messages: TuiMessage[] = Array.from({ length: 600 }, (_, index) =>
      assistantMessage(`m${index + 1}`, `entry ${index + 1}`),
    );
    const fixture = createHistoryRuntime(messages);
    const uncapped = (await requestHistory(fixture.runtime, {
      sessionId: 'session-1',
    })) as { entries: unknown[]; totalEntries: number; nextCursor?: string };
    expect(uncapped.entries).toHaveLength(100);
    expect(uncapped.totalEntries).toBe(600);
    expect(uncapped.nextCursor).toBe(encodeHistoryCursor('m501'));

    const capped = (await requestHistory(fixture.runtime, {
      sessionId: 'session-1',
      limit: 1000,
    })) as { entries: unknown[]; nextCursor?: string };
    expect(capped.entries).toHaveLength(500);
    expect(capped.nextCursor).toBe(encodeHistoryCursor('m101'));
    // The full-session walk scans with the page cap.
    expect(fixture.listMessagePage).toHaveBeenNthCalledWith(1, 'session-1', { limit: 500 });
    expect(fixture.listMessagePage).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 500,
      before: 'm101',
    });
  });

  it('rejects a foreign or nonexistent Session with session_not_found', async () => {
    const fixture = createHistoryRuntime([userMessage('m1', 'hi')], {
      getSessionError: new Error('Runtime did not return session ghost.'),
    });
    await expect(requestHistory(fixture.runtime, { sessionId: 'ghost' })).rejects.toMatchObject({
      code: -32002,
      data: { code: 'session_not_found', sessionId: 'ghost' },
    });
    expect(fixture.listMessagePage).not.toHaveBeenCalled();
  });

  it('rejects an invalid or stale cursor and a non-positive limit', async () => {
    const fixture = createHistoryRuntime([userMessage('m1', 'hi'), assistantMessage('m2', 'yo')]);
    await expect(
      requestHistory(fixture.runtime, { sessionId: 'session-1', cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      requestHistory(fixture.runtime, {
        sessionId: 'session-1',
        cursor: encodeHistoryCursor('m3'),
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      requestHistory(fixture.runtime, { sessionId: 'session-1', limit: 0 }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      requestHistory(fixture.runtime, { sessionId: 'session-1', limit: 2.5 }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      requestHistory(fixture.runtime, { sessionId: 'session-1', limit: 'many' }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(requestHistory(fixture.runtime, {})).rejects.toMatchObject({ code: -32602 });
  });

  it('requires an authenticated Session store before reading history', async () => {
    const fixture = createHistoryRuntime([userMessage('m1', 'hi')]);
    (fixture.runtime as unknown as { getAccountStatus: unknown }).getAccountStatus = vi.fn(
      async () => ({ status: 'needs-login' as const, warnings: [] }),
    );
    await expect(requestHistory(fixture.runtime, { sessionId: 'session-1' })).rejects.toMatchObject(
      { code: -32000 },
    );
  });

  it('carries tool calls, thinking and separate toolResult entries for durable history', async () => {
    const messages: TuiMessage[] = [
      userMessage('m1', 'Run the checks'),
      {
        id: 'm2',
        role: 'assistant',
        content: 'Working on it',
        thinking: 'Need to inspect the failing check',
        timestamp: 1700000001000,
        toolCalls: [
          { id: 'call-1', name: 'bash', input: { command: 'pnpm test' }, output: 'all green' },
          { id: 'call-2', name: 'edit', input: { path: 'a.ts' }, error: 'file locked' },
          { id: 'call-3', name: 'read', input: { path: 'b.ts' } },
        ],
      },
      {
        id: 'm3',
        role: 'assistant',
        kind: 'compaction',
        content: 'Earlier turns compressed: set up CI, fixed flaky check',
        timestamp: 1700000002000,
      },
      {
        id: 'm4',
        role: 'unknown',
        customType: 'todo_cadence_reminder',
        content: 'Update the todo list',
        timestamp: 1700000003000,
      },
    ];
    const fixture = createHistoryRuntime(messages);
    const page = (await requestHistory(fixture.runtime, { sessionId: 'session-1' })) as {
      entries: Record<string, unknown>[];
      totalEntries: number;
    };
    expect(page.totalEntries).toBe(4);
    expect(page.entries).toEqual([
      { role: 'user', text: 'Run the checks', timestamp: 1700000000000 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need to inspect the failing check' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pnpm test' } },
          { type: 'toolCall', id: 'call-2', name: 'edit', arguments: { path: 'a.ts' } },
          { type: 'toolCall', id: 'call-3', name: 'read', arguments: { path: 'b.ts' } },
        ],
        text: 'Working on it',
        timestamp: 1700000001000,
      },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', text: 'all green', timestamp: 1700000001000 },
      {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'edit',
        text: 'file locked',
        isError: true,
        timestamp: 1700000001000,
      },
      {
        role: 'compactionSummary',
        text: 'Earlier turns compressed: set up CI, fixed flaky check',
        timestamp: 1700000002000,
      },
      {
        role: 'custom',
        customType: 'todo_cadence_reminder',
        text: 'Update the todo list',
        timestamp: 1700000003000,
      },
    ]);
  });

  it('keeps canonical durable record shapes (compaction summary text, custom types) after normalization', async () => {
    // Raw records exactly as the durable serving layer stores them; the
    // runtime's listMessagePage normalizes them before the ACP mapper runs.
    const rawRecords: unknown[] = [
      { id: 'm1', role: 'user', content: 'Question', timestamp: 1700000000000 },
      {
        id: 'm2',
        role: 'assistant',
        msg_content: 'Doing it',
        thinking_content: 'Need to inspect the failing check',
        tool_calls: [
          {
            tool_call_id: 'call-1',
            tool_name: 'bash',
            tool_call_args: { command: 'pnpm test' },
            tool_call_result_data: 'all green',
          },
        ],
        timestamp: 1700000001000,
      },
      {
        id: 'm3',
        role: 'compactionSummary',
        summary: 'Compressed: set up CI, fixed flaky check',
        timestamp: 1700000002000,
      },
      {
        id: 'm4',
        role: 'custom',
        customType: 'guard-reminder',
        content: 'Stay guarded',
        timestamp: 1700000003000,
      },
    ];
    const fixture = createHistoryRuntime(rawRecords.map((record) => normalizeTuiMessage(record)));
    const page = (await requestHistory(fixture.runtime, { sessionId: 'session-1' })) as {
      entries: Record<string, unknown>[];
    };
    expect(page.entries).toEqual([
      { role: 'user', text: 'Question', timestamp: 1700000000000 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need to inspect the failing check' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pnpm test' } },
        ],
        text: 'Doing it',
        timestamp: 1700000001000,
      },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', text: 'all green', timestamp: 1700000001000 },
      {
        role: 'compactionSummary',
        text: 'Compressed: set up CI, fixed flaky check',
        timestamp: 1700000002000,
      },
      { role: 'custom', customType: 'guard-reminder', text: 'Stay guarded', timestamp: 1700000003000 },
    ]);
  });

  it('reports internalError when the daemon is unreachable instead of session_not_found', async () => {
    const fixture = createHistoryRuntime([userMessage('m1', 'hi')], {
      getSessionError: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5101'), {
        name: 'McodedConnectionError',
      }),
    });
    await expect(requestHistory(fixture.runtime, { sessionId: 'ghost' })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining('Session history is unavailable'),
    });
  });

  describe('per-connection history snapshot cache', () => {
    it('serves every page of one read from a single full traversal', async () => {
      const messages: TuiMessage[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id, index) =>
        assistantMessage(id, `entry ${index + 1}`),
      );
      const fixture = createHistoryRuntime(messages);
      await withHistoryReader(fixture.runtime, async (request) => {
        const first = (await request({ sessionId: 'session-1', limit: 3 })) as {
          entries: { text: string }[];
          totalEntries: number;
          nextCursor?: string;
        };
        expect(first.entries.map((entry) => entry.text)).toEqual(['entry 5', 'entry 6', 'entry 7']);
        const second = (await request({
          sessionId: 'session-1',
          limit: 3,
          cursor: first.nextCursor,
        })) as { entries: { text: string }[]; totalEntries: number; nextCursor?: string };
        expect(second.entries.map((entry) => entry.text)).toEqual([
          'entry 2',
          'entry 3',
          'entry 4',
        ]);
        const last = (await request({
          sessionId: 'session-1',
          limit: 3,
          cursor: second.nextCursor,
        })) as { entries: { text: string }[]; totalEntries: number; nextCursor?: string };
        expect(last.entries.map((entry) => entry.text)).toEqual(['entry 1']);
        expect(last.nextCursor).toBeUndefined();
      });
      // Three page requests, ONE full walk (a single 500-bounded page here).
      expect(fixture.listMessagePage).toHaveBeenCalledTimes(1);
      expect(fixture.listMessagePage).toHaveBeenCalledWith('session-1', { limit: 500 });
    });

    it('walks again and serves fresh data once a Turn commits history', async () => {
      const history: TuiMessage[] = [
        userMessage('m1', 'one'),
        assistantMessage('m2', 'two'),
        userMessage('m3', 'three'),
        assistantMessage('m4', 'four'),
      ];
      const channel = createRuntimeEventChannel();
      const fixture = createHistoryRuntime(history, {
        messagesBySession: { 'session-1': history },
        events: (signal) => channel.watch(signal),
      });
      await withHistoryReader(fixture.runtime, async (request) => {
        const before = (await request({ sessionId: 'session-1', limit: 2 })) as {
          entries: { text: string }[];
          totalEntries: number;
        };
        expect(before.entries.map((entry) => entry.text)).toEqual(['three', 'four']);
        expect(before.totalEntries).toBe(4);
        // A finished Turn committed one more record: the snapshot must drop.
        history.push(assistantMessage('m5', 'five'));
        channel.push(turnFinishedEvent('session-1'));
        await flushRuntimeEvents();
        const after = (await request({ sessionId: 'session-1', limit: 2 })) as {
          entries: { text: string }[];
          totalEntries: number;
        };
        expect(after.entries.map((entry) => entry.text)).toEqual(['four', 'five']);
        expect(after.totalEntries).toBe(5);
      });
      expect(historyWalkCount(fixture.listMessagePage, 'session-1')).toBe(2);
    });

    it('drops the snapshot when idle history is rewound', async () => {
      const history: TuiMessage[] = [
        userMessage('m1', 'one'),
        assistantMessage('m2', 'two'),
        assistantMessage('m3', 'three'),
      ];
      const channel = createRuntimeEventChannel();
      const fixture = createHistoryRuntime(history, {
        messagesBySession: { 'session-1': history },
        events: (signal) => channel.watch(signal),
      });
      await withHistoryReader(fixture.runtime, async (request) => {
        const before = (await request({ sessionId: 'session-1' })) as { totalEntries: number };
        expect(before.totalEntries).toBe(3);
        history.pop();
        channel.push(rewindEvent('session-1'));
        await flushRuntimeEvents();
        const after = (await request({ sessionId: 'session-1' })) as { totalEntries: number };
        expect(after.totalEntries).toBe(2);
      });
      expect(historyWalkCount(fixture.listMessagePage, 'session-1')).toBe(2);
    });

    it('keeps per-request freshness while a Turn is running', async () => {
      const history: TuiMessage[] = [userMessage('m1', 'one'), assistantMessage('m2', 'two')];
      const channel = createRuntimeEventChannel();
      const fixture = createHistoryRuntime(history, {
        messagesBySession: { 'session-1': history },
        events: (signal) => channel.watch(signal),
      });
      await withHistoryReader(fixture.runtime, async (request) => {
        const idle = (await request({ sessionId: 'session-1' })) as { totalEntries: number };
        expect(idle.totalEntries).toBe(2);
        // Mid-Turn commits publish no events; a running Session must not be
        // pinned to a stale snapshot.
        channel.push(turnStartedEvent('session-1'));
        await flushRuntimeEvents();
        history.push(assistantMessage('m3', 'three'));
        const duringTurn = (await request({ sessionId: 'session-1' })) as { totalEntries: number };
        expect(duringTurn.totalEntries).toBe(3);
        history.push(assistantMessage('m4', 'four'));
        const stillRunning = (await request({ sessionId: 'session-1' })) as {
          totalEntries: number;
        };
        expect(stillRunning.totalEntries).toBe(4);
      });
      expect(historyWalkCount(fixture.listMessagePage, 'session-1')).toBe(3);
    });

    it('bounds the snapshot cache to four Sessions (LRU)', async () => {
      const ids = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'];
      const messagesBySession = Object.fromEntries(
        ids.map((id) => [id, [assistantMessage(`${id}-m1`, `${id} entry`)]]),
      );
      const fixture = createHistoryRuntime([], { messagesBySession });
      await withHistoryReader(fixture.runtime, async (request) => {
        for (const id of ids) await request({ sessionId: id });
        // `session-a` fell out of the cap: reading it again re-walks.
        await request({ sessionId: 'session-a' });
        // The four most recent Sessions stay resident: no second walk.
        await request({ sessionId: 'session-e' });
        await request({ sessionId: 'session-d' });
      });
      expect(historyWalkCount(fixture.listMessagePage, 'session-a')).toBe(2);
      expect(historyWalkCount(fixture.listMessagePage, 'session-e')).toBe(1);
      expect(historyWalkCount(fixture.listMessagePage, 'session-d')).toBe(1);
    });

    it('keeps Sessions independent of each other', async () => {
      const fixture = createHistoryRuntime([userMessage('m1', 'hi')], {
        messagesBySession: {
          'session-1': [userMessage('a1', 'alpha'), assistantMessage('a2', 'beta')],
          'session-2': [userMessage('b1', 'gamma')],
        },
      });
      await withHistoryReader(fixture.runtime, async (request) => {
        const first = (await request({ sessionId: 'session-1' })) as {
          entries: { text: string }[];
        };
        const second = (await request({ sessionId: 'session-2' })) as {
          entries: { text: string }[];
        };
        expect(first.entries.map((entry) => entry.text)).toEqual(['alpha', 'beta']);
        expect(second.entries.map((entry) => entry.text)).toEqual(['gamma']);
        await request({ sessionId: 'session-1' });
        await request({ sessionId: 'session-2' });
      });
      expect(historyWalkCount(fixture.listMessagePage, 'session-1')).toBe(1);
      expect(historyWalkCount(fixture.listMessagePage, 'session-2')).toBe(1);
    });

    it('drops the snapshot when the Session is closed', async () => {
      const fixture = createHistoryRuntime([userMessage('m1', 'hi')]);
      await withHistoryReader(fixture.runtime, async (request, connection) => {
        await request({ sessionId: 'session-1' });
        expect(historyWalkCount(fixture.listMessagePage, 'session-1')).toBe(1);
        // The Session was never attached, so close reports not-found — but the
        // client is done with it, and its snapshot must not survive that.
        await expect(
          connection.request(acp.methods.agent.session.close, { sessionId: 'session-1' }),
        ).rejects.toThrow();
        await request({ sessionId: 'session-1' });
      });
      expect(historyWalkCount(fixture.listMessagePage, 'session-1')).toBe(2);
    });
  });

  describe('legacy (pre-durable) file fallback', () => {
    const legacySessionId = 'session-legacy-1';
    const legacyEnvelopes = [
      {
        message_id: 'msg-1',
        turn_id: 'turn-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Old user line' }],
          timestamp: 1700000100000,
        },
      },
      {
        message_id: 'msg-2',
        turn_id: 'turn-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Old assistant line' }],
          timestamp: 1700000101000,
        },
      },
      {
        message_id: 'msg-3',
        turn_id: 'turn-1',
        message: {
          role: 'toolResult',
          toolCallId: 'tool-9',
          toolName: 'edit',
          content: [{ type: 'text', text: 'done' }],
          timestamp: 1700000102000,
        },
      },
      {
        message_id: 'msg-4',
        turn_id: 'turn-2',
        message: { role: 'compactionSummary', summary: 'Old summary', timestamp: 1700000103000 },
      },
      {
        message_id: 'msg-5',
        turn_id: 'turn-2',
        message: {
          role: 'custom',
          customType: 'guard-reminder',
          content: [{ type: 'text', text: 'Stay guarded' }],
          timestamp: 1700000104000,
        },
      },
    ];

    it('reads old-format messages.jsonl through the same protocol and shape', async () => {
      const dataDir = writeLegacySession(makeTempRoot(), legacySessionId, legacyEnvelopes);
      const fixture = createHistoryRuntime([], {
        getSessionError: new Error(`Runtime did not return session ${legacySessionId}.`),
        dataDir,
      });
      const page = (await requestHistory(fixture.runtime, {
        sessionId: legacySessionId,
      })) as {
        entries: Record<string, unknown>[];
        totalEntries: number;
        nextCursor?: string;
        sessionMeta?: Record<string, unknown>;
      };
      expect(page.totalEntries).toBe(5);
      expect(page.entries).toEqual([
        { role: 'user', text: 'Old user line', timestamp: 1700000100000 },
        { role: 'assistant', text: 'Old assistant line', timestamp: 1700000101000 },
        { role: 'toolResult', toolCallId: 'tool-9', toolName: 'edit', text: 'done', timestamp: 1700000102000 },
        { role: 'compactionSummary', text: 'Old summary', timestamp: 1700000103000 },
        { role: 'custom', customType: 'guard-reminder', text: 'Stay guarded', timestamp: 1700000104000 },
      ]);
      expect(page.sessionMeta).toEqual({
        sessionId: legacySessionId,
        // Legacy source: no turnIds survive the old envelope parse, so the
        // per-Turn counters are null (unknown), never zero. The legacy custom
        // marker still counts — its type rides the kind slot.
        health: {
          schemaVersion: 1,
          source: 'legacy',
          running: false,
          turns: null,
          llmCalls: 0,
          compactions: { done: 1, failed: 0, open: 0 },
          injections: { steers: null, reminders: { 'guard-reminder': 1 } },
          resumedTurns: null,
        },
      });
      // Still read-only: no durable-session attachment was attempted.
      expect(fixture.clearSessionMcpServers).not.toHaveBeenCalled();
      expect(fixture.configureSessionMcpServers).not.toHaveBeenCalled();
      expect(fixture.listMessagePage).not.toHaveBeenCalled();
    });

    it('pages legacy history with the same cursor envelope and totalEntries', async () => {
      const dataDir = writeLegacySession(makeTempRoot(), legacySessionId, legacyEnvelopes);
      const fixture = createHistoryRuntime([], {
        getSessionError: new Error(`Runtime did not return session ${legacySessionId}.`),
        dataDir,
      });
      const first = (await requestHistory(fixture.runtime, {
        sessionId: legacySessionId,
        limit: 2,
      })) as { entries: unknown[]; totalEntries: number; nextCursor?: string };
      expect(first.entries).toHaveLength(2);
      expect(first.totalEntries).toBe(5);
      expect(first.nextCursor).toBe(encodeHistoryCursor('msg-4'));

      const second = (await requestHistory(fixture.runtime, {
        sessionId: legacySessionId,
        limit: 2,
        cursor: first.nextCursor,
      })) as { entries: unknown[]; totalEntries: number; nextCursor?: string };
      expect(second.entries).toHaveLength(2);
      expect(second.totalEntries).toBe(5);
      expect(second.nextCursor).toBe(encodeHistoryCursor('msg-2'));
    });

    it('still reports session_not_found when neither durable nor legacy holds the Session', async () => {
      const dataDir = writeLegacySession(makeTempRoot(), legacySessionId, legacyEnvelopes);
      const fixture = createHistoryRuntime([], {
        getSessionError: new Error('Runtime did not return session ghost.'),
        dataDir,
      });
      await expect(requestHistory(fixture.runtime, { sessionId: 'ghost' })).rejects.toMatchObject({
        code: -32002,
        data: { code: 'session_not_found', sessionId: 'ghost' },
      });
    });

    it('falls back to session_not_found when the runtime exposes no dataDir', async () => {
      const fixture = createHistoryRuntime([], {
        getSessionError: new Error('Runtime did not return session ghost.'),
      });
      await expect(requestHistory(fixture.runtime, { sessionId: 'ghost' })).rejects.toMatchObject({
        code: -32002,
        data: { code: 'session_not_found', sessionId: 'ghost' },
      });
      expect(fixture.getRuntimeDiagnostics).toHaveBeenCalledTimes(1);
    });

    it('carries canonical toolCall blocks and toolResult isError from old-format files', async () => {
      const legacyToolSessionId = 'session-legacy-tools';
      const envelopes = [
        {
          message_id: 'msg-t1',
          turn_id: 'turn-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Fix it' }],
            timestamp: 1700000200000,
          },
        },
        {
          message_id: 'msg-t2',
          turn_id: 'turn-1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Inspect first' },
              { type: 'text', text: 'On it' },
              { type: 'toolCall', id: 'tool-9', name: 'edit', arguments: { path: 'a.ts' } },
            ],
            timestamp: 1700000201000,
          },
        },
        {
          message_id: 'msg-t3',
          turn_id: 'turn-1',
          message: {
            role: 'toolResult',
            toolCallId: 'tool-9',
            toolName: 'edit',
            content: [{ type: 'text', text: 'patched' }],
            isError: true,
            timestamp: 1700000202000,
          },
        },
      ];
      const dataDir = writeLegacySession(makeTempRoot(), legacyToolSessionId, envelopes);
      const fixture = createHistoryRuntime([], {
        getSessionError: new Error(`Runtime did not return session ${legacyToolSessionId}.`),
        dataDir,
      });
      const page = (await requestHistory(fixture.runtime, {
        sessionId: legacyToolSessionId,
      })) as { entries: Record<string, unknown>[]; totalEntries: number };
      expect(page.totalEntries).toBe(3);
      expect(page.entries).toEqual([
        { role: 'user', text: 'Fix it', timestamp: 1700000200000 },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspect first' },
            { type: 'toolCall', id: 'tool-9', name: 'edit', arguments: { path: 'a.ts' } },
          ],
          text: 'On it',
          timestamp: 1700000201000,
        },
        {
          role: 'toolResult',
          toolCallId: 'tool-9',
          toolName: 'edit',
          text: 'patched',
          isError: true,
          timestamp: 1700000202000,
        },
      ]);
    });

    it.skipIf(process.platform === 'win32')(
      'refuses a symlinked sessions root with unsafe_history_root',
      async () => {
        const root = makeTempRoot();
        const realTree = writeLegacySession(join(root, 'real'), legacySessionId, legacyEnvelopes);
        const dataDir = join(root, 'profile');
        mkdirSync(join(dataDir, 'v2'), { recursive: true });
        symlinkSync(join(realTree, 'v2', 'sessions'), join(dataDir, 'v2', 'sessions'), 'dir');
        const fixture = createHistoryRuntime([], {
          getSessionError: new Error(`Runtime did not return session ${legacySessionId}.`),
          dataDir,
        });
        await expect(
          requestHistory(fixture.runtime, { sessionId: legacySessionId }),
        ).rejects.toMatchObject({
          code: -32603,
          data: { code: 'unsafe_history_root' },
        });
      },
    );

    // The guard's layered fix (opus review, legacy-guard): lstat only sees the
    // FINAL path segment, so a symlink one level up (`<dataDir>/v2`) used to
    // slip a foreign tree past the root check.
    it.skipIf(process.platform === 'win32')(
      'refuses a symlinked v2 parent directory with unsafe_history_root',
      async () => {
        const root = makeTempRoot();
        const realTree = writeLegacySession(join(root, 'real'), legacySessionId, legacyEnvelopes);
        const dataDir = join(root, 'profile');
        mkdirSync(dataDir, { recursive: true });
        symlinkSync(join(realTree, 'v2'), join(dataDir, 'v2'), 'dir');
        const fixture = createHistoryRuntime([], {
          getSessionError: new Error(`Runtime did not return session ${legacySessionId}.`),
          dataDir,
        });
        await expect(
          requestHistory(fixture.runtime, { sessionId: legacySessionId }),
        ).rejects.toMatchObject({
          code: -32603,
          data: { code: 'unsafe_history_root' },
        });
      },
    );

    it.skipIf(process.platform === 'win32')(
      'does not read a symlinked messages.jsonl (session_not_found, foreign file untouched)',
      async () => {
        const root = makeTempRoot();
        const foreignFile = join(root, 'foreign-messages.jsonl');
        writeFileSync(
          foreignFile,
          `${legacyEnvelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\n`,
        );
        const dataDir = writeLegacySession(root, legacySessionId, []);
        const sessionDir = join(
          dataDir,
          'v2',
          'sessions',
          '2026',
          '10',
          '12',
          `10-00-00-000-session_${Buffer.from(legacySessionId, 'utf8').toString('base64url')}`,
        );
        rmSync(join(sessionDir, 'messages.jsonl'));
        symlinkSync(foreignFile, join(sessionDir, 'messages.jsonl'), 'file');
        const fixture = createHistoryRuntime([], {
          getSessionError: new Error(`Runtime did not return session ${legacySessionId}.`),
          dataDir,
        });
        await expect(
          requestHistory(fixture.runtime, { sessionId: legacySessionId }),
        ).rejects.toMatchObject({
          code: -32002,
          data: { code: 'session_not_found', sessionId: legacySessionId },
        });
      },
    );

    it('treats a session directory without messages.jsonl as session_not_found, not empty history', async () => {
      const root = makeTempRoot();
      const dataDir = writeLegacySession(root, legacySessionId, legacyEnvelopes);
      const sessionDir = join(
        dataDir,
        'v2',
        'sessions',
        '2026',
        '10',
        '12',
        `10-00-00-000-session_${Buffer.from(legacySessionId, 'utf8').toString('base64url')}`,
      );
      rmSync(join(sessionDir, 'messages.jsonl'));
      const fixture = createHistoryRuntime([], {
        getSessionError: new Error(`Runtime did not return session ${legacySessionId}.`),
        dataDir,
      });
      await expect(
        requestHistory(fixture.runtime, { sessionId: legacySessionId }),
      ).rejects.toMatchObject({
        code: -32002,
        data: { code: 'session_not_found', sessionId: legacySessionId },
      });
    });
  });
});

// Context-health counters. `sessionMeta.health` summarizes the WHOLE snapshot every page
// was sliced from — zeros mean "provably did not happen", null means the
// source cannot know.
describe('MiniMax Code ACP session/history sessionMeta.health', () => {
  function healthOf(page: unknown): { health?: Record<string, unknown> } {
    return (page as { sessionMeta?: { health?: Record<string, unknown> } }).sessionMeta ?? {};
  }

  function withTurn(turnId: string, message: TuiMessage): TuiMessage {
    return { ...message, turnId };
  }

  function assistantWithUsage(id: string, text = 'answer'): TuiMessage {
    return {
      id,
      role: 'assistant',
      content: text,
      usage: { totalTokens: 12, inputTokens: 4, outputTokens: 8 },
      timestamp: 1700000001000,
    };
  }

  function hiddenMarker(id: string, customType: string, turnId?: string): TuiMessage {
    return {
      id,
      role: 'unknown',
      customType,
      content: '<system-reminder>…</system-reminder>',
      timestamp: 1700000002000,
      ...(turnId ? { turnId } : {}),
    };
  }

  it('reports all-zero counters for an empty durable Session, with running from session.status', async () => {
    const fixture = createHistoryRuntime([], { session: { status: 'started' } });
    const page = await requestHistory(fixture.runtime, { sessionId: 'session-1' });
    expect(healthOf(page).health).toEqual({
      schemaVersion: 1,
      source: 'durable',
      running: true,
      turns: 0,
      llmCalls: 0,
      compactions: { done: 0, failed: 0, open: 0 },
      injections: { steers: 0, reminders: {} },
      resumedTurns: 0,
    });
  });

  it('counts compactions done, failed and open, over records from before the compaction too', async () => {
    // Records before the compaction summary stay in the snapshot: the
    // counters cover the whole Session, not just since-last-compaction.
    const messages: TuiMessage[] = [
      withTurn('turn-1', userMessage('u1', 'first')),
      withTurn('turn-1', assistantWithUsage('a1', 'pre-compaction answer')),
      { id: 'c0', turnId: 'turn-1', role: 'assistant', kind: 'compaction_start', timestamp: 1700000003000 },
      {
        id: 'c1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'compaction',
        content: 'Summarized',
        timestamp: 1700000004000,
      },
      withTurn('turn-2', userMessage('u2', 'second')),
      withTurn('turn-2', assistantWithUsage('a2', 'post-compaction answer')),
      { id: 'c2', turnId: 'turn-2', role: 'assistant', kind: 'compaction_start', timestamp: 1700000005000 },
      { id: 'c3', turnId: 'turn-2', role: 'assistant', kind: 'compaction_failed', timestamp: 1700000006000 },
      withTurn('turn-3', userMessage('u3', 'third')),
      { id: 'c4', turnId: 'turn-3', role: 'assistant', kind: 'compaction_start', timestamp: 1700000007000 },
    ];
    const fixture = createHistoryRuntime(messages);
    const page = await requestHistory(fixture.runtime, { sessionId: 'session-1' });
    expect(healthOf(page).health).toMatchObject({
      turns: 3,
      lastTurnId: 'turn-3',
      llmCalls: 2,
      compactions: { done: 1, failed: 1, open: 1 },
    });
  });

  it('counts mid-turn user records as steers but a follow-up opening a new turn is not a steer', async () => {
    const messages: TuiMessage[] = [
      withTurn('turn-1', userMessage('u1', 'start')),
      withTurn('turn-1', assistantMessage('a1', 'working')),
      withTurn('turn-1', userMessage('u2', 'also check the tests')), // steer
      withTurn('turn-1', assistantMessage('a2', 'done')),
      withTurn('turn-1', userMessage('u3', 'and the docs')), // another steer
      // A follow-up that opens a NEW turn is a fresh request, not a steer.
      withTurn('turn-2', userMessage('u4', 'next task')),
      withTurn('turn-2', assistantMessage('a3', 'on it')),
    ];
    const fixture = createHistoryRuntime(messages);
    const page = await requestHistory(fixture.runtime, { sessionId: 'session-1' });
    expect(healthOf(page).health).toMatchObject({
      turns: 2,
      injections: { steers: 2, reminders: {} },
      lastTurn: { turnId: 'turn-2', steers: 0 },
    });
  });

  it('counts reminders by raw customType, known and unknown, and skips visible system records', async () => {
    const messages: TuiMessage[] = [
      hiddenMarker('m1', 'session_identity_reminder'),
      hiddenMarker('m2', 'session_identity_reminder'),
      hiddenMarker('m3', 'todo_cadence_reminder'),
      hiddenMarker('m4', 'experimental_marker'),
      { id: 'm5', role: 'system', kind: 'review_result', content: 'Review finished', timestamp: 1700000005000 },
      { id: 'm6', role: 'user', toolResult: { toolCallId: 'tool-1' }, timestamp: 1700000006000 },
      { id: 'm7', role: 'unknown', content: 'untyped marker', timestamp: 1700000007000 },
    ];
    const fixture = createHistoryRuntime(messages);
    const page = await requestHistory(fixture.runtime, { sessionId: 'session-1' });
    expect(healthOf(page).health).toMatchObject({
      injections: {
        steers: 0,
        reminders: {
          experimental_marker: 1,
          session_identity_reminder: 2,
          todo_cadence_reminder: 1,
        },
      },
    });
  });

  it('counts continuation turns opened without a user record as resumed; leading markers do not perturb it', async () => {
    const messages: TuiMessage[] = [
      withTurn('turn-1', userMessage('u1', 'normal')),
      withTurn('turn-1', assistantMessage('a1', 'ok')),
      // turn-continuation submits empty input: the turn starts with an
      // assistant record and no user record before it.
      withTurn('turn-2', assistantWithUsage('a2', 'resumed output')),
      // A reminder marker at turn start is not a user record either.
      withTurn('turn-3', hiddenMarker('m1', 'session_identity_reminder', 'turn-3')),
      withTurn('turn-3', assistantWithUsage('a3', 'continues')),
    ];
    const fixture = createHistoryRuntime(messages);
    const page = await requestHistory(fixture.runtime, { sessionId: 'session-1' });
    expect(healthOf(page).health).toMatchObject({
      turns: 3,
      resumedTurns: 2,
      lastTurn: { turnId: 'turn-3', resumed: true, llmCalls: 1 },
    });
  });

  it('scopes lastTurn to the newest turn only', async () => {
    const messages: TuiMessage[] = [
      withTurn('turn-1', userMessage('u1', 'first')),
      withTurn('turn-1', assistantWithUsage('a1')),
      withTurn('turn-1', userMessage('u2', 'steer')), // steer in turn-1 only
      hiddenMarker('m1', 'session_identity_reminder', 'turn-1'),
      { id: 'c0', turnId: 'turn-1', role: 'assistant', kind: 'compaction_start', timestamp: 1700000003000 },
      {
        id: 'c1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'compaction',
        content: 'Summarized',
        timestamp: 1700000004000,
      },
      withTurn('turn-2', userMessage('u3', 'second')),
      withTurn('turn-2', assistantWithUsage('a2')),
      withTurn('turn-2', assistantWithUsage('a3')),
      withTurn('turn-2', userMessage('u4', 'steer')), // steer in turn-2
      hiddenMarker('m2', 'todo_cadence_reminder', 'turn-2'),
    ];
    const fixture = createHistoryRuntime(messages);
    const page = await requestHistory(fixture.runtime, { sessionId: 'session-1' });
    expect(healthOf(page).health).toMatchObject({
      turns: 2,
      llmCalls: 3,
      injections: { steers: 2, reminders: { session_identity_reminder: 1, todo_cadence_reminder: 1 } },
      lastTurn: {
        turnId: 'turn-2',
        llmCalls: 2,
        compactions: 0,
        steers: 1,
        reminders: { todo_cadence_reminder: 1 },
        resumed: false,
      },
    });
  });

  it('reports identical health on every page of one traversal', async () => {
    const messages: TuiMessage[] = [];
    for (let index = 0; index < 7; index += 1) {
      const turnId = `turn-${index + 1}`;
      messages.push(withTurn(turnId, userMessage(`u${index + 1}`, `request ${index + 1}`)));
      messages.push(withTurn(turnId, assistantWithUsage(`a${index + 1}`)));
    }
    const fixture = createHistoryRuntime(messages);
    await withHistoryReader(fixture.runtime, async (request) => {
      const healths: unknown[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = (await request({
          sessionId: 'session-1',
          limit: 3,
          ...(cursor ? { cursor } : {}),
        })) as { nextCursor?: string; sessionMeta?: { health?: unknown } };
        healths.push(page.sessionMeta?.health);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(healths).toHaveLength(5);
      for (const health of healths.slice(1)) {
        expect(health).toEqual(healths[0]);
      }
      expect(healths[0]).toMatchObject({ turns: 7, llmCalls: 7, injections: { steers: 0 } });
    });
    // Five pages, one snapshot walk.
    expect(fixture.listMessagePage).toHaveBeenCalledTimes(1);
  });

  // Closes the design's first «ПРОВЕРИТЬ»: hidden custom markers
  // (`role:'custom'`, `display:false`, `customType`) survive the durable
  // serving path — `display:false` does not filter them out of the history
  // snapshot, so `getMessages` readers see and count them. The pre-compaction
  // assistant answer (m2) counting towards `llmCalls` closes the second one:
  // the display history spans the whole Session, no since-last-compaction
  // scope is needed.
  it('counts a hidden marker served from durable wire records (display:false is not a filter)', async () => {
    // Raw records exactly as the durable serving layer stores them; the
    // runtime's listMessagePage normalizes them before the summarizer runs.
    const rawRecords: unknown[] = [
      { msg_id: 'm1', turn_id: 'turn-1', role: 'user', msg_content: 'Fix it', timestamp: 1700000000000 },
      {
        msg_id: 'm2',
        turn_id: 'turn-1',
        role: 'assistant',
        msg_content: 'pre-compaction answer',
        usage: { totalTokens: 10, inputTokens: 4, outputTokens: 6 },
        timestamp: 1700000001000,
      },
      {
        msg_id: 'm3',
        turn_id: 'turn-1',
        role: 'custom',
        customType: 'session_identity_reminder',
        content: '<system-reminder>\nYOUR SESSION ID: session-1\n</system-reminder>',
        display: false,
        timestamp: 1700000002000,
      },
      { msg_id: 'c1', turn_id: 'turn-2', role: 'assistant', kind: 'compaction_start', timestamp: 1700000003000 },
      {
        msg_id: 'c2',
        turn_id: 'turn-2',
        role: 'assistant',
        kind: 'compaction',
        msg_content: 'Summarized earlier turns',
        timestamp: 1700000004000,
      },
      { msg_id: 'm4', turn_id: 'turn-3', role: 'user', msg_content: 'Continue', timestamp: 1700000005000 },
      {
        msg_id: 'm5',
        turn_id: 'turn-3',
        role: 'assistant',
        msg_content: 'post-compaction answer',
        usage: { totalTokens: 7, inputTokens: 3, outputTokens: 4 },
        timestamp: 1700000006000,
      },
      {
        msg_id: 'm6',
        turn_id: 'turn-3',
        role: 'custom',
        customType: 'background_task_read_settlement',
        content: '',
        display: false,
        timestamp: 1700000007000,
      },
    ];
    const fixture = createHistoryRuntime(rawRecords.map((record) => normalizeTuiMessage(record)));
    const page = await requestHistory(fixture.runtime, { sessionId: 'session-1' });
    expect(healthOf(page).health).toEqual({
      schemaVersion: 1,
      source: 'durable',
      running: false,
      turns: 3,
      lastTurnId: 'turn-3',
      llmCalls: 2,
      compactions: { done: 1, failed: 0, open: 0 },
      injections: {
        steers: 0,
        reminders: { background_task_read_settlement: 1, session_identity_reminder: 1 },
      },
      resumedTurns: 0,
      lastTurn: {
        turnId: 'turn-3',
        llmCalls: 1,
        compactions: 0,
        steers: 0,
        reminders: { background_task_read_settlement: 1 },
        resumed: false,
      },
    });
  });
});
