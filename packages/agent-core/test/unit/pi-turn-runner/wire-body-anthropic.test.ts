/**
 * Wire-body duplicates at the real serializer boundary (final-sprint §2).
 *
 * Unlike the `streamFn`-substitution tests in this directory, this file runs
 * the REAL provider chain: `composeStreamFn` composes the vendor
 * `streamSimple` (no `streamFn` is injected), the real
 * `anthropic-messages` adapter runs `buildParams`, and the vendored Anthropic
 * SDK serializes the final JSON body. The only interception point is
 * `LLMModelConfig.fetch` (`llm.ts` `withFetch`), which receives the actual
 * `(url, init)` the SDK would hand to the network — so every assertion below
 * checks the serialized HTTP request body itself, not the pre-serialization
 * context.
 *
 * Isolation (per the wave-B safety canon):
 * - the injected fetch is FAIL-CLOSED: it accepts exactly one fixture URL,
 *   never calls the ambient `fetch`, and any other origin (including any
 *   managed-auth endpoint) throws and is recorded as a violation — an access
 *   to managed auth fails the test by construction;
 * - auth is explicit test BYOK (`fixture-only-key`), so the vendor env-key
 *   resolution path (`withEnvApiKey`/`getEnvApiKey`) is never reached;
 * - responses are synthetic Anthropic SSE frames; no real provider, daemon,
 *   socket or OAuth grant is involved, and no auth headers are persisted;
 * - every scenario runs in its own throwaway fixture workspace.
 *
 * Scenarios (one request-body multiplicity audit each): plain turn,
 * seed→delta, tool-call/result, reminder injection (split segments), steer,
 * transport retry (whole-HTTP replay, not an in-body duplicate),
 * discard/recovery (rejected attempt must leave the wire), and
 * compaction/reseed (replaceMessages window). Legitimate provider-side
 * merging — the collapsed leading system message and immediate-send batch
 * merging — is asserted as such, never as a duplicate.
 *
 * Not covered here (explicitly): the ACP→daemon→runtime transport path and
 * any live provider behavior. Those need the separate local-fixture probe.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';

import { PiTurnRunner } from '../../../src/pi-turn-runner/pi-turn-runner.js';
import type { RuntimeEvent, RunTurnInput } from '../../../src/pi-turn-runner/types.js';
import type { RuntimeTool, ToolExecutionContext } from '../../../src/tools/index.js';

const FIXTURE_ORIGIN = 'https://wire-fixture.invalid';
const FIXTURE_URL = `${FIXTURE_ORIGIN}/v1/messages`;
const FIXTURE_API_KEY = 'fixture-only-key';
const MODEL_ID = 'fixture-claude-wire';
const SYSTEM_MARKER = 'WIRE-MARKER-SYSTEM-PROMPT';
const SYSTEM_PROMPT = `You are the wire fixture agent. ${SYSTEM_MARKER}`;

/**
 * The vendored SDK's beta client posts to `${FIXTURE_URL}?beta=true`. The
 * allowlist pins origin+path exactly and admits only that one fixed query
 * parameter — anything else (other origin, other path, extra parameters)
 * is a refused network target.
 */
function isFixtureTarget(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.origin === FIXTURE_ORIGIN &&
    url.pathname === '/v1/messages' &&
    url.searchParams.get('beta') === 'true' &&
    [...url.searchParams.keys()].every((key) => key === 'beta')
  );
}

/**
 * Deliberately NOT a builtin catalog provider name: `streamSimple` then
 * resolves the api provider for `anthropic-messages` directly — the real
 * adapter and serializer — instead of any builtin provider shortcut.
 */
const model = {
  id: MODEL_ID,
  name: 'Fixture Claude (wire probe)',
  api: 'anthropic-messages',
  provider: 'fixture-anthropic',
  baseUrl: FIXTURE_ORIGIN,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
} as unknown as Model<'anthropic-messages'>;

function usage(): Usage {
  return {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ---------------------------------------------------------------------------
// Synthetic Anthropic SSE responses
// ---------------------------------------------------------------------------

function sseScript(frames: readonly { event: string; data: unknown }[]): string {
  return frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join('');
}

function messageStartFrame(): { event: string; data: unknown } {
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_wire_fixture',
        model: MODEL_ID,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
  };
}

function textSse(text: string): Response {
  return new Response(
    sseScript([
      messageStartFrame(),
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function toolUseSse(id: string, name: string, inputJson: string): Response {
  return new Response(
    sseScript([
      messageStartFrame(),
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputJson } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** SDK `makeStatusError` message shape: `<status> <json body>` — the product retry classifier reads the status out of it. */
function rateLimitResponse(): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture rate limit' } }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// Fail-closed fetch fixture
// ---------------------------------------------------------------------------

interface WireContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface WireBody {
  model?: string;
  stream?: boolean;
  system?: { type: string; text: string }[];
  tools?: { name: string }[];
  messages?: { role: string; content: string | WireContentBlock[] }[];
}

interface RecordedRequest {
  /** One-based physical HTTP attempt ordinal within the scenario. */
  readonly ordinal: number;
  readonly url: string;
  readonly method: string;
  readonly userAgent: string | null;
  readonly rawBody: string;
  readonly body: WireBody;
}

const activeFixtures: WireFixture[] = [];

class WireFixture {
  readonly requests: RecordedRequest[] = [];
  readonly violations: string[] = [];
  private readonly responders: Array<() => Response> = [];

  constructor(private readonly scenario: string) {
    activeFixtures.push(this);
  }

  enqueue(responder: () => Response): void {
    this.responders.push(responder);
  }

  /** Fail-closed terminal fetch: exactly one fixture URL, never the ambient fetch. */
  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isFixtureTarget(url)) {
      this.violations.push(`network target refused: ${url}`);
      throw new Error(`wire fixture fetch is fail-closed: unexpected target ${url}`);
    }
    const rawBody = await readRawBody(input, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }
    const request: RecordedRequest = {
      ordinal: this.requests.length + 1,
      url,
      method: init?.method ?? 'POST',
      userAgent: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('user-agent'),
      rawBody,
      body: (parsed ?? {}) as WireBody,
    };
    this.requests.push(request);
    this.maybeDumpBody(request);
    const respond = this.responders.shift();
    if (!respond) {
      this.violations.push('unexpected extra HTTP request (no scripted response)');
      throw new Error('wire fixture: no scripted response for an extra HTTP request');
    }
    return respond();
  };

  /** Synthetic bodies only — never headers, never credentials. */
  private maybeDumpBody(request: RecordedRequest): void {
    const dir = process.env.MCODE_WIRE_BODY_ARTIFACTS_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${this.scenario}__req${request.ordinal}.json`),
      `${JSON.stringify(request.body, null, 2)}\n`,
    );
  }
}

async function readRawBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') return init.body;
    if (init.body instanceof ArrayBuffer) return new TextDecoder().decode(init.body);
  }
  if (typeof input !== 'string' && !(input instanceof URL) && typeof input.text === 'function') {
    return input.clone().text();
  }
  return '';
}

afterAll(() => {
  // Cross-scenario negative control: across every fixture in this file, not a
  // single fetch targeted anything but the fixture URL, and nothing hit the
  // ambient network entry (managed-auth endpoints included).
  const violations = activeFixtures.flatMap((fixture) => fixture.violations);
  expect(violations).toEqual([]);
});

// ---------------------------------------------------------------------------
// Body auditing helpers
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Text blocks carrying the marker: across `system`, message blocks and nested block content (tool_result). */
function countTextMarker(body: WireBody, marker: string): number {
  const countInBlocks = (blocks: readonly WireContentBlock[] | undefined): number => {
    let count = 0;
    for (const block of blocks ?? []) {
      if (block.type === 'text' && block.text?.includes(marker)) count += 1;
      // A tool_result block carries its payload as nested content — the
      // serializer emits a plain string for a single text block, an array
      // of blocks otherwise.
      if (typeof block.content === 'string') {
        if (block.content.includes(marker)) count += 1;
      } else if (Array.isArray(block.content)) {
        count += countInBlocks(block.content as readonly WireContentBlock[]);
      }
    }
    return count;
  };
  let count = 0;
  for (const systemBlock of body.system ?? []) {
    if (systemBlock.text.includes(marker)) count += 1;
  }
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') {
      if (message.content.includes(marker)) count += 1;
      continue;
    }
    count += countInBlocks(message.content);
  }
  return count;
}

function countBlocks(body: WireBody, predicate: (block: WireContentBlock) => boolean): number {
  let count = 0;
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (predicate(block)) count += 1;
    }
  }
  return count;
}

function messageRoles(body: WireBody): string[] {
  return (body.messages ?? []).map((message) => message.role);
}

/** Common audit: the serialized request is a well-formed fixture-targeted POST. */
function assertRequestShape(request: RecordedRequest): void {
  expect(request.url.startsWith(FIXTURE_URL)).toBe(true);
  expect(isFixtureTarget(request.url)).toBe(true);
  expect(request.method).toBe('POST');
  expect(request.body.model).toBe(MODEL_ID);
  expect(request.body.stream).toBe(true);
}

/** The system prompt rides `params.system` exactly once and never as a message. */
function assertSystemOnce(request: RecordedRequest): void {
  expect(countOccurrences(request.rawBody, SYSTEM_MARKER)).toBe(1);
  expect(countTextMarker(request.body, SYSTEM_MARKER)).toBe(1);
  expect(request.body.system?.[0]?.type).toBe('text');
  expect(request.body.system?.[0]?.text).toContain(SYSTEM_MARKER);
  expect(messageRoles(request.body)).not.toContain('system');
}

// ---------------------------------------------------------------------------
// Turn harness
// ---------------------------------------------------------------------------

function seededAssistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'fixture-anthropic',
    model: MODEL_ID,
    usage: usage(),
    stopReason: 'stop',
    timestamp: 2,
  } as AssistantMessage;
}

function seededUser(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 1,
  } as AgentMessage;
}

function wireNoopTool(): RuntimeTool {
  return {
    def: {
      name: 'wire_noop',
      description: 'wire fixture no-op tool',
      schema: Type.Object({}),
      executionMode: 'sequential',
    },
    impl: {
      execute: async () => ({
        tool_name: 'wire_noop',
        text: 'WIRE-MARKER-TOOL-RESULT',
        content: [{ type: 'text', text: 'WIRE-MARKER-TOOL-RESULT' }],
      }),
    },
  };
}

async function runWireTurn(
  fixture: WireFixture,
  overrides: Partial<RunTurnInput<ToolExecutionContext>> & { userText?: string },
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'mcode-wire-body-'));
  const input: RunTurnInput<ToolExecutionContext> = {
    sessionId: 'session-wire',
    turnId: 'turn-wire',
    workspaceDir,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: { text: overrides.userText ?? 'WIRE-MARKER-USER-CURRENT' },
    llm: {
      model,
      apiKey: FIXTURE_API_KEY,
      // THE interception seam: no streamFn — the real vendor streamSimple and
      // anthropic-messages serializer run below this fetch.
      fetch: fixture.fetch,
    },
    eventWriter: {
      appendEvents(batch) {
        events.push(...batch);
      },
      pushRuntime(event) {
        events.push(event);
      },
    },
    toolConfig: {
      tools: overrides.toolConfig?.tools ?? [],
      disableBuiltinToolFallback: true,
      context: { sessionId: 'session-wire', turnId: 'turn-wire' },
    },
    ...overrides,
  };
  await new PiTurnRunner().runTurn(input);
  return events;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('wire body at the real anthropic-messages serializer boundary', () => {
  it('plain turn: system and user ride the serialized body exactly once', async () => {
    const fixture = new WireFixture('plain-turn');
    fixture.enqueue(() => textSse('plain answer'));

    await runWireTurn(fixture, { userText: 'WIRE-MARKER-USER-PLAIN' });

    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0]!;
    assertRequestShape(request);
    expect(request.userAgent).toMatch(/^pi\/\S+ .* ncode\/dev$/);
    assertSystemOnce(request);
    // The user text is one text block in one user message — not merged into
    // anything, not repeated.
    expect(countTextMarker(request.body, 'WIRE-MARKER-USER-PLAIN')).toBe(1);
    expect(countOccurrences(request.rawBody, 'WIRE-MARKER-USER-PLAIN')).toBe(1);
    // No tools were declared for this turn.
    expect(request.body.tools).toBeUndefined();
    expect(fixture.violations).toEqual([]);
  });

  it('seed→delta: seeded history rides once per identity, identical texts preserved per copy', async () => {
    const fixture = new WireFixture('seed-delta');
    fixture.enqueue(() => textSse('delta answer'));

    await runWireTurn(fixture, {
      userText: 'WIRE-MARKER-SAME-QUESTION',
      history: [
        seededUser('WIRE-MARKER-SAME-QUESTION'),
        seededAssistant('WIRE-MARKER-SEED-ANSWER'),
      ],
    });

    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0]!;
    assertRequestShape(request);
    assertSystemOnce(request);
    // Two deliberately identical user inputs keep BOTH wire copies (one per
    // identity) — deduplication by text would be a bug, not a feature.
    expect(countTextMarker(request.body, 'WIRE-MARKER-SAME-QUESTION')).toBe(2);
    expect(countTextMarker(request.body, 'WIRE-MARKER-SEED-ANSWER')).toBe(1);
    // Order: seeded exchange first, the delta user last.
    expect(messageRoles(request.body)).toEqual(['user', 'assistant', 'user']);
    expect(fixture.violations).toEqual([]);
  });

  it('tool-call/result: one tool_use, one tool_result, tool declared once', async () => {
    const fixture = new WireFixture('tool-call-result');
    fixture.enqueue(() => toolUseSse('toolu_wire_1', 'wire_noop', '{}'));
    fixture.enqueue(() => textSse('after tool'));

    await runWireTurn(fixture, {
      toolConfig: {
        tools: [wireNoopTool()],
        disableBuiltinToolFallback: true,
        context: { sessionId: 'session-wire', turnId: 'turn-wire' },
      },
    });

    expect(fixture.requests).toHaveLength(2);

    const first = fixture.requests[0]!;
    assertRequestShape(first);
    assertSystemOnce(first);
    // The tool is declared exactly once in the request tool list.
    expect(first.body.tools?.filter((tool) => tool.name === 'wire_noop')).toHaveLength(1);
    expect(countTextMarker(first.body, 'WIRE-MARKER-USER-CURRENT')).toBe(1);

    const second = fixture.requests[1]!;
    assertRequestShape(second);
    assertSystemOnce(second);
    // The completed tool call and its result each appear exactly once, the
    // result directly after the assistant turn that issued the call.
    expect(
      countBlocks(second.body, (block) => block.type === 'tool_use' && block.id === 'toolu_wire_1'),
    ).toBe(1);
    expect(
      countBlocks(
        second.body,
        (block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_wire_1',
      ),
    ).toBe(1);
    expect(countTextMarker(second.body, 'WIRE-MARKER-TOOL-RESULT')).toBe(1);
    expect(countTextMarker(second.body, 'WIRE-MARKER-USER-CURRENT')).toBe(1);
    const roles = messageRoles(second.body);
    expect(roles.indexOf('assistant')).toBeLessThan(roles.lastIndexOf('user'));
    expect(fixture.violations).toEqual([]);
  });

  it('reminder injection: split reminder segments and the real user each ride once', async () => {
    const fixture = new WireFixture('reminder');
    fixture.enqueue(() => textSse('reminder answer'));

    await runWireTurn(fixture, {
      userText: 'WIRE-MARKER-USER-REMINDER',
      beforeUserMessages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>\nWIRE-MARKER-REMINDER-SEGMENT-A (todo unchanged)\n</system-reminder>',
            },
          ],
          timestamp: 1,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>\nWIRE-MARKER-REMINDER-SEGMENT-B\n</system-reminder>',
            },
          ],
          timestamp: 2,
        },
      ],
    });

    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0]!;
    assertRequestShape(request);
    assertSystemOnce(request);
    // A split reminder is two segments with distinct identities: each rides
    // exactly once, ahead of the real user message.
    expect(countTextMarker(request.body, 'WIRE-MARKER-REMINDER-SEGMENT-A')).toBe(1);
    expect(countTextMarker(request.body, 'WIRE-MARKER-REMINDER-SEGMENT-B')).toBe(1);
    expect(countOccurrences(request.rawBody, '<system-reminder>')).toBe(2);
    expect(countTextMarker(request.body, 'WIRE-MARKER-USER-REMINDER')).toBe(1);
    expect(messageRoles(request.body)).toEqual(['user', 'user', 'user']);
    expect(fixture.violations).toEqual([]);
  });

  it('steer: the steering message rides the next request exactly once', async () => {
    const fixture = new WireFixture('steer');
    fixture.enqueue(() => toolUseSse('toolu_wire_steer', 'wire_noop', '{}'));
    fixture.enqueue(() => textSse('steered answer'));

    let polls = 0;
    await runWireTurn(fixture, {
      toolConfig: {
        tools: [wireNoopTool()],
        disableBuiltinToolFallback: true,
        context: { sessionId: 'session-wire', turnId: 'turn-wire' },
      },
      getSteeringMessages: () => {
        polls += 1;
        // The first poll fires at the first step boundary (after the tool
        // step): its message rides the continuation request together with
        // the tool result — the mid-turn steering case.
        if (polls !== 1) return [];
        return [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'WIRE-MARKER-STEER' }],
            timestamp: 3,
          },
        ];
      },
    });

    expect(fixture.requests).toHaveLength(2);
    const second = fixture.requests[1]!;
    assertRequestShape(second);
    assertSystemOnce(second);
    // The steer message, the tool result and the original user all ride the
    // continuation request exactly once each.
    expect(countTextMarker(second.body, 'WIRE-MARKER-STEER')).toBe(1);
    expect(countTextMarker(second.body, 'WIRE-MARKER-TOOL-RESULT')).toBe(1);
    expect(countTextMarker(second.body, 'WIRE-MARKER-USER-CURRENT')).toBe(1);
    expect(
      countBlocks(
        second.body,
        (block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_wire_steer',
      ),
    ).toBe(1);
    expect(fixture.violations).toEqual([]);
  });

  it('transport retry: the whole HTTP request replays with a byte-identical body — no in-body duplication', async () => {
    const fixture = new WireFixture('transport-retry');
    fixture.enqueue(() => rateLimitResponse());
    fixture.enqueue(() => textSse('retry recovered'));

    await runWireTurn(fixture, {
      userText: 'WIRE-MARKER-USER-RETRY',
      llmRetry: {
        policy: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, maxRetryElapsedMs: 60_000 },
        sleep: async () => {},
      },
    });

    // TWO physical HTTP attempts for ONE logical request — the replay is a
    // transport-level metric, never a duplicate inside a body.
    expect(fixture.requests).toHaveLength(2);
    const [first, second] = fixture.requests as [RecordedRequest, RecordedRequest];
    expect(second.rawBody).toBe(first.rawBody);
    for (const request of fixture.requests) {
      assertRequestShape(request);
      assertSystemOnce(request);
      expect(countTextMarker(request.body, 'WIRE-MARKER-USER-RETRY')).toBe(1);
      expect(countOccurrences(request.rawBody, 'WIRE-MARKER-USER-RETRY')).toBe(1);
    }
    expect(fixture.violations).toEqual([]);
  });

  it('discard/recovery: the rejected attempt leaves the wire; the retry prompt rides once', async () => {
    const fixture = new WireFixture('discard-recovery');
    fixture.enqueue(() => textSse('WIRE-MARKER-DISCARDED-A'));
    fixture.enqueue(() => textSse('recovered answer'));

    let sawAttempt = 0;
    await runWireTurn(fixture, {
      userText: 'WIRE-MARKER-USER-DISCARD',
      hooks: {
        afterLlmCallHook: [
          async () => {
            sawAttempt += 1;
            if (sawAttempt === 1) {
              return {
                type: 'retry' as const,
                reason: 'response control rejected the attempt',
                prompt: 'WIRE-MARKER-RETRY-PROMPT',
              };
            }
            return undefined;
          },
        ],
      },
    });

    expect(sawAttempt).toBe(2);
    expect(fixture.requests).toHaveLength(2);
    const second = fixture.requests[1]!;
    assertRequestShape(second);
    assertSystemOnce(second);
    // The discarded attempt's text is gone from the replacement request…
    expect(countOccurrences(second.rawBody, 'WIRE-MARKER-DISCARDED-A')).toBe(0);
    // …the retry prompt and the original user ride it exactly once each.
    expect(countTextMarker(second.body, 'WIRE-MARKER-RETRY-PROMPT')).toBe(1);
    expect(countTextMarker(second.body, 'WIRE-MARKER-USER-DISCARD')).toBe(1);
    expect(fixture.violations).toEqual([]);
  });

  it('compaction/reseed: the replaced window rides once, dropped records stay off the wire', async () => {
    const fixture = new WireFixture('compaction-reseed');
    fixture.enqueue(() => textSse('compacted answer'));

    const currentUser = seededUser('WIRE-MARKER-USER-COMPACT');
    await runWireTurn(fixture, {
      userText: 'WIRE-MARKER-USER-COMPACT',
      history: [
        seededUser('WIRE-MARKER-SEED-DROPPED'),
        seededAssistant('WIRE-MARKER-SEED-ANSWER-DROPPED'),
      ],
      hooks: {
        beforeLlmCallHook: [
          async (hookInput) => {
            if (hookInput.phase !== 'initial') return undefined;
            return {
              type: 'replaceMessages' as const,
              messages: [seededUser('WIRE-MARKER-COMPACTION-SUMMARY'), currentUser],
              metadata: {
                replacementId: 'wire-replacement-1',
                strategyVersion: 'wire-fixture',
                summary: 'fixture compaction summary',
                compactedMessages: [seededUser('WIRE-MARKER-SEED-DROPPED')],
                keptMessages: [currentUser],
                firstKeptIndex: 0,
              },
            };
          },
        ],
      },
    });

    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0]!;
    assertRequestShape(request);
    assertSystemOnce(request);
    // The compacted window: summary once, current user once, dropped records
    // absent — old and new windows never ride the same body.
    expect(countTextMarker(request.body, 'WIRE-MARKER-COMPACTION-SUMMARY')).toBe(1);
    expect(countTextMarker(request.body, 'WIRE-MARKER-USER-COMPACT')).toBe(1);
    expect(countOccurrences(request.rawBody, 'WIRE-MARKER-SEED-DROPPED')).toBe(0);
    expect(countOccurrences(request.rawBody, 'WIRE-MARKER-SEED-ANSWER-DROPPED')).toBe(0);
    expect(messageRoles(request.body)).toEqual(['user', 'user']);
    expect(fixture.violations).toEqual([]);
  });
});

describe('wire fixture negative controls', () => {
  it('the injected fetch is fail-closed: any other origin throws and is recorded', async () => {
    const fixture = new WireFixture('negative-control');
    // The direct probe proves the deny works: a foreign origin never reaches
    // an ambient fetch and lands in the violation log instead.
    await expect(
      fixture.fetch('https://definitely-not-the-fixture.example.test/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/fail-closed/);
    expect(fixture.violations).toEqual([
      expect.stringContaining('definitely-not-the-fixture.example.test'),
    ]);
    // No request was recorded — the foreign origin never saw a body.
    expect(fixture.requests).toHaveLength(0);
    // Purge: the afterAll cross-check must not fail on this intentional hit.
    fixture.violations.length = 0;
  });
});
