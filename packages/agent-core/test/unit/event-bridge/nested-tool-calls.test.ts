import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EventBridge } from "../../../src/event-bridge/bridge.js";
import type { RuntimeEvent } from "@mavis/protocol";

function assistant(
  content: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolUse"
      : "stop",
    timestamp: 0,
    usage: {
      input: 10,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      total: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function streamPayloads(events: RuntimeEvent[]): Record<string, unknown>[] {
  return events
    .map((event) => event.payload.stream_resp)
    .filter((raw): raw is string => typeof raw === "string")
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function chunkToolCalls(events: RuntimeEvent[]): Record<string, unknown>[] {
  return streamPayloads(events).flatMap((payload) => {
    const chunk = payload.agent_message_chunk as
      | { tool_calls?: Record<string, unknown>[] }
      | undefined;
    return chunk?.tool_calls ?? [];
  });
}

function fixture() {
  let now = 0;
  let sequence = 0;
  const bridge = new EventBridge({
    sessionId: "session-test",
    turnId: "turn-test",
    eventIdGenerator: (kind) => `${kind}-${++sequence}`,
    runtimeSeqGenerator: () => ++sequence,
    nowMs: () => now,
  });
  return { bridge, setTime: (value: number) => (now = value) };
}

describe("EventBridge nested tool calls (run_code children)", () => {
  it("attributes children to the parent and folds them into the flushed message", async () => {
    const { bridge, setTime } = fixture();
    await bridge.processEvent({ type: "message_start", message: assistant() });
    bridge.setActiveAssistantMessageId("parent-message");
    const runCall = {
      type: "toolCall" as const,
      id: "run-1",
      name: "run_code",
      arguments: { code: "return 1;" },
    };
    await bridge.processEvent(
      { type: "message_end", message: assistant([runCall]) },
      1_000,
    );
    // The outer run_code chunk (from its own tool_execution_start) carries
    // no parent id, unlike its children.
    const startedParent = await bridge.processEvent({
      type: "tool_execution_start",
      toolCallId: "run-1",
      toolName: "run_code",
      args: { code: "return 1;" },
    });
    const parentChunks = chunkToolCalls(startedParent.events).filter(
      (call) => call.tool_call_id === "run-1",
    );
    expect(parentChunks.length).toBeGreaterThan(0);
    for (const call of parentChunks) expect(call.parent_tool_call_id).toBeUndefined();

    const started = bridge.nestedToolStart({
      toolCallId: "run-1/1",
      parentToolCallId: "run-1",
      toolName: "read",
      args: { path: "a.ts" },
    });
    const startChunks = chunkToolCalls(started.events).filter(
      (call) => call.tool_call_id === "run-1/1",
    );
    expect(startChunks).toHaveLength(1);
    expect(startChunks[0]).toMatchObject({
      tool_name: "read",
      parent_tool_call_id: "run-1",
      tool_call_args: JSON.stringify({ path: "a.ts" }),
    });

    setTime(2_000);
    const finished = bridge.nestedToolEnd({
      toolCallId: "run-1/1",
      parentToolCallId: "run-1",
      toolName: "read",
      result: { text: "token" },
      durationMs: 12,
    });
    const endChunks = chunkToolCalls(finished.events).filter(
      (call) => call.tool_call_id === "run-1/1",
    );
    expect(endChunks).toHaveLength(1);
    expect(endChunks[0]).toMatchObject({
      parent_tool_call_id: "run-1",
      tool_call_result_data: JSON.stringify({ text: "token" }),
      tool_call_duration_ms: 12,
    });

    // The deferred parent message folds the child into its tool_calls so the
    // durable transcript keeps the attribution after reopen.
    const completed = await bridge.processEvent({
      type: "tool_execution_end",
      toolCallId: "run-1",
      toolName: "run_code",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });
    const flushed = streamPayloads(completed.events)
      .map((payload) => payload.agent_message as Record<string, unknown> | undefined)
      .find((message) => Array.isArray(message?.tool_calls));
    const calls = (flushed?.tool_calls ?? []) as Record<string, unknown>[];
    expect(calls.map((call) => call.tool_call_id)).toEqual(["run-1", "run-1/1"]);
    expect(calls[1]).toMatchObject({
      parent_tool_call_id: "run-1",
      tool_call_result_data: JSON.stringify({ text: "token" }),
    });
  });

  it("marks a failed child as failed and keeps its args", async () => {
    const { bridge } = fixture();
    await bridge.processEvent({ type: "message_start", message: assistant() });
    bridge.setActiveAssistantMessageId("parent-message");
    const runCall = {
      type: "toolCall" as const,
      id: "run-1",
      name: "run_code",
      arguments: { code: "throw" },
    };
    await bridge.processEvent({ type: "message_end", message: assistant([runCall]) }, 0);
    bridge.nestedToolStart({
      toolCallId: "run-1/1",
      parentToolCallId: "run-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    const finished = bridge.nestedToolEnd({
      toolCallId: "run-1/1",
      parentToolCallId: "run-1",
      toolName: "bash",
      error: "cancelled: This operation was aborted",
    });
    const endChunks = chunkToolCalls(finished.events).filter(
      (call) => call.tool_call_id === "run-1/1",
    );
    expect(endChunks[0]).toMatchObject({
      parent_tool_call_id: "run-1",
      tool_call_status: 3,
      tool_call_args: JSON.stringify({ command: "sleep 30" }),
    });
    // The converter folds a child error into tool_call_result_data as {error}.
    const resultPayload = JSON.parse(endChunks[0].tool_call_result_data as string) as {
      error?: { message?: string };
    };
    expect(resultPayload.error?.message).toContain("cancelled");
  });

  it("drops nested events without an active assistant message via a debug trace", async () => {
    const { bridge } = fixture();
    const started = bridge.nestedToolStart({
      toolCallId: "run-1/1",
      parentToolCallId: "run-1",
      toolName: "read",
    });
    const finished = bridge.nestedToolEnd({
      toolCallId: "run-1/1",
      parentToolCallId: "run-1",
      toolName: "read",
      result: { text: "x" },
    });
    for (const batch of [started, finished]) {
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0].payload.trace?.phase).toContain("nested_tool");
    }
  });
});
