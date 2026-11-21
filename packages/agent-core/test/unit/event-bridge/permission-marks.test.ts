/**
 * §4.3 delivery pins (event-bridge half): the writer of tool-call status
 * events stamps the per-turn permission mark onto every status event of a
 * resolved call — the final Failed/Completed statuses are the guaranteed
 * carriers (pi emits Start before the beforeToolCall hook runs), and the
 * deferred completed agent_message keeps the mark so durable replay
 * preserves it (pin 4.5).
 *
 * Pin 4.4 (denied call): a blocked call ends with exactly one Failed status
 * chunk carrying the mark — the bridge half; the gate half (block → single
 * immediate-error end) is pinned in local-runtime-v2.
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EventBridge } from "../../../src/event-bridge/bridge.js";
import type { RuntimeEvent } from "@mavis/protocol";
import type { RuntimePermissionMark } from "../../../src/protocol/runtime-event.js";

const MARK: RuntimePermissionMark = {
  decision: "allow",
  decidedBy: "rule",
  ruleKind: "builtin",
  mode: "default",
  reason: "Safe bash command",
};

const DENY_MARK: RuntimePermissionMark = {
  decision: "deny",
  decidedBy: "user",
  ruleKind: null,
  mode: "default",
  reason: "reject_once",
};

function assistant(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
    usage: {
      input: 10,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function fixture(initial: Record<string, RuntimePermissionMark> = {}) {
  const marks: Record<string, RuntimePermissionMark> = { ...initial };
  let sequence = 0;
  const bridge = new EventBridge({
    sessionId: "session-test",
    turnId: "turn-test",
    eventIdGenerator: (kind) => `${kind}-${++sequence}`,
    runtimeSeqGenerator: () => ++sequence,
    nowMs: () => 0,
    permissionMarks: { get: (toolCallId) => marks[toolCallId] },
  });
  return {
    bridge,
    /** Simulates the gate resolving the call mid-flight (production order). */
    resolve(toolCallId: string, mark: RuntimePermissionMark): void {
      marks[toolCallId] = mark;
    },
  };
}

/** Tool-call status chunks (RespData type 6) emitted so far. */
function toolCallChunks(events: readonly RuntimeEvent[]) {
  return events
    .map((event) => event.payload.stream_resp)
    .filter((raw): raw is string => typeof raw === "string")
    .map((raw) => JSON.parse(raw))
    .filter((resp) => resp.agent_message_chunk?.tool_calls?.length > 0)
    .flatMap((resp) => resp.agent_message_chunk.tool_calls);
}

function completedAgentMessage(events: readonly RuntimeEvent[]) {
  return events
    .map((event) => event.payload.stream_resp)
    .filter((raw): raw is string => typeof raw === "string")
    .map((raw) => JSON.parse(raw))
    .map((resp) => resp.agent_message)
    .find((message) => message?.tool_calls?.length > 0);
}

const TOOL = { type: "toolCall" as const, id: "t1", name: "bash", arguments: {} };

async function runToolTurn(
  bridge: EventBridge,
  isError: boolean,
  onInFlight?: () => void,
) {
  const events: RuntimeEvent[] = [];
  await bridge.processEvent({ type: "message_start", message: assistant() });
  bridge.setActiveAssistantMessageId("m1");
  // message_end with a tool call defers the completed agent_message until
  // every tool_execution_end arrives (the production lifecycle).
  const messageEnd = await bridge.processEvent({
    type: "message_end",
    message: assistant([TOOL]),
  });
  events.push(...messageEnd.events);
  const start = await bridge.processEvent({
    type: "tool_execution_start",
    toolCallId: TOOL.id,
    toolName: TOOL.name,
    args: TOOL.arguments,
  });
  events.push(...start.events);
  // The permission gate resolves while the call is "in flight"; the mark
  // lands from this point on — exactly the production ordering (Start is
  // emitted before the beforeToolCall hook).
  onInFlight?.();
  const end = await bridge.processEvent({
    type: "tool_execution_end",
    toolCallId: TOOL.id,
    toolName: TOOL.name,
    result: {
      content: [{ type: "text", text: isError ? "denied" : "done" }],
    },
    isError,
  } satisfies AgentEvent & { isError: boolean });
  events.push(...end.events);
  return events;
}

describe("EventBridge §4 permission marks", () => {
  it("stamps the mark on the final completed status chunk", async () => {
    const { bridge, resolve } = fixture();
    const events = await runToolTurn(bridge, false, () => resolve("t1", MARK));
    const chunks = toolCallChunks(events);
    expect(chunks.length).toBe(2);
    // Start precedes the decision — no mark yet.
    expect(chunks[0]).not.toHaveProperty("permission");
    expect(chunks[0].tool_call_status).toBe(1);
    // Final status carries the mark.
    expect(chunks[1].tool_call_status).toBe(2);
    expect(chunks[1].permission).toEqual(MARK);
  });

  it("denied-call-gets-failed-with-mark: one Failed chunk with the mark", async () => {
    const { bridge, resolve } = fixture();
    const events = await runToolTurn(bridge, true, () => resolve("t1", DENY_MARK));
    const chunks = toolCallChunks(events);
    expect(chunks.length).toBe(2);
    expect(chunks.filter((chunk) => chunk.tool_call_status === 3)).toHaveLength(1);
    expect(chunks[1].tool_call_status).toBe(3);
    expect(chunks[1].permission).toEqual(DENY_MARK);
  });

  it("mark-survives-replay: the deferred completed message keeps the mark", async () => {
    const { bridge, resolve } = fixture();
    const events = await runToolTurn(bridge, false, () => resolve("t1", MARK));
    const message = completedAgentMessage(events);
    expect(message).toBeDefined();
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls[0].permission).toEqual(MARK);
    expect(message.tool_calls[0].tool_call_status).toBe(2);
  });

  it("stamps the mark on nested child call statuses", async () => {
    const { bridge } = fixture({ nested: MARK });
    void bridge;
    const events: RuntimeEvent[] = [];
    await bridge.processEvent({ type: "message_start", message: assistant() });
    bridge.setActiveAssistantMessageId("m1");
    await bridge.processEvent({ type: "message_end", message: assistant([TOOL]) });
    events.push(
      ...bridge.nestedToolStart({
        toolCallId: "nested",
        parentToolCallId: TOOL.id,
        toolName: "edit",
        args: { path: "/workspace/a.ts" },
      }).events,
    );
    events.push(
      ...bridge.nestedToolEnd({
        toolCallId: "nested",
        parentToolCallId: TOOL.id,
        toolName: "edit",
        result: { content: [{ type: "text", text: "ok" }] },
      }).events,
    );
    const chunks = toolCallChunks(events);
    const nested = chunks.filter((chunk) => chunk.tool_call_id === "nested");
    expect(nested.length).toBe(2);
    expect(nested[1].permission).toEqual(MARK);
  });

  it("ships statuses without the field when no mark source is wired", async () => {
    const { bridge } = fixture({});
    const events = await runToolTurn(bridge, false);
    for (const chunk of toolCallChunks(events)) {
      expect(chunk).not.toHaveProperty("permission");
    }
  });
});
