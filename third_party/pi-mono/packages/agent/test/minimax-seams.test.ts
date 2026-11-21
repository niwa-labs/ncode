/**
 * MiniMax host-seam regressions (port plan §5.1 rows 1/15/16/17/44, owner W04).
 *
 * These tests pin the seam behaviors re-applied onto the pinned upstream agent
 * loop: explicit atomic steering batches, the post-dequeue steering admission
 * veto, whole-agent termination from tool hooks, the admitted-execution
 * boundary callback, and the unexpected-tool-call fallback. They were ported
 * from the pre-rebaseline vendored suite (tree `624746c`, tests
 * `agent.test.ts` / `agent-loop.test.ts`) onto the pin's harness.
 */
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, Agent, type AgentLoopConfig, type StreamFn } from "../src/index.ts";
import type { AgentContext, AgentMessage, AgentTool } from "../src/types.ts";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

const echoParameters = Type.Object({ value: Type.String() });
type EchoParameters = typeof echoParameters;

function echoTool(executed: string[], name = "echo"): AgentTool<EchoParameters> {
	const parameters = echoParameters;
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: params.value }], details: {} };
		},
	};
}

describe("MiniMax seam: steerBatch (row 44)", () => {
	it("consumes the whole snapshot in one slot and leaves subsequent steering separate", async () => {
		const contexts: string[] = [];
		const agent = new Agent({
			streamFn: ((_model, context) => {
				contexts.push(JSON.stringify(context.messages));
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text: "done" }]) }));
				return stream;
			}) as StreamFn,
		});
		agent.state.messages = [createAssistantMessage([{ type: "text", text: "previous answer" }])];
		const snapshot = ["A", "machine", "B"].map((content, timestamp) => ({
			role: "user" as const,
			content,
			timestamp,
		}));
		agent.steerBatch(snapshot);
		agent.steer({ role: "user", content: "C after snapshot", timestamp: 3 });
		await agent.continue();
		expect(contexts).toHaveLength(2);
		for (const member of snapshot) expect(contexts[0]).toContain(member.content);
		expect(contexts[0]).not.toContain("C after snapshot");
		expect(contexts[1]).toContain("C after snapshot");
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"assistant",
			"user",
			"user",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("peeks a batch as one atomic group without consuming it", () => {
		const agent = new Agent({ streamFn: (() => {
			throw new Error("not used");
		}) as StreamFn });
		const batch = [
			{ role: "user" as const, content: "one", timestamp: 1 },
			{ role: "user" as const, content: "two", timestamp: 2 },
		];
		agent.steerBatch(batch);
		expect(agent.hasQueuedMessages()).toBe(true);
		const peeked = agent.peekQueuedMessages();
		expect(peeked).toHaveLength(2);
		// peek is not consume: the messages are still queued
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.peekQueuedMessages()).toEqual(peeked);
	});
});

describe("MiniMax seam: shouldStopAfterSteering admission veto (row 15)", () => {
	it("ends the run gracefully instead of issuing the next provider request", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed);
		let llmCalls = 0;
		let veto = false;
		const context: AgentContext = { messages: [], tools: [tool] };
		const stream = agentLoop(
			[createUserMessage("echo twice")],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				shouldStopAfterSteering: () => veto,
				getSteeringMessages: async () => (llmCalls >= 2 ? [createUserMessage("queued while running")] : []),
			},
			undefined,
			() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message =
						llmCalls === 1
							? createAssistantMessage(
									[
										{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: message.stopReason, message });
				});
				return mockStream;
			},
		);
		const events: string[] = [];
		veto = true; // admission rejects the message dequeued after the tool turn
		for await (const event of stream) {
			events.push(event.type);
		}
		// first call answers the prompt; the veto fires after the tool turn's steering
		// poll and must prevent the request that would consume the tool result
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["first"]);
		expect(events.at(-1)).toBe("agent_end");
	});
});

describe("MiniMax seam: terminateAgent whole-agent stop (row 16)", () => {
	it("should not execute later sequential calls after a hook requests global termination", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed);
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("echo both")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				beforeToolCall: async ({ toolCall }) =>
					toolCall.id === "tool-1"
						? { block: true, reason: "stop now", terminateAgent: true }
						: undefined,
			},
			undefined,
			() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
							],
							"toolUse",
						),
					});
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
		expect(executed).toEqual([]);
		const toolResults = (await stream.result()).filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults[1]).toMatchObject({
			toolCallId: "tool-2",
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("skipped") }],
		});
	});

	it("should stop every prepared parallel call when a later blocked call requests global termination", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed);
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("echo both")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				beforeToolCall: async ({ toolCall }) =>
					toolCall.id === "tool-2" ? { block: true, reason: "stop now", terminateAgent: true } : undefined,
			},
			undefined,
			() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
							],
							"toolUse",
						),
					});
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
		expect(executed).toEqual([]);
		expect((await stream.result()).filter((message) => message.role === "toolResult")).toHaveLength(2);
	});

	it("should stop a mixed parallel batch when one after-tool hook requests global termination", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed);
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("echo both")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				afterToolCall: async ({ toolCall }) => ({ terminateAgent: toolCall.id === "tool-1" }),
			},
			undefined,
			() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
							],
							"toolUse",
						),
					});
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});

	it("should keep an ordinary blocked tool call non-terminal", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed);
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("echo")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => ({ block: true, reason: "ordinary block" }),
			},
			undefined,
			() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message =
						llmCalls === 1
							? createAssistantMessage(
									[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } }],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: message.stopReason, message });
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
	});

	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed);
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("echo something")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				afterToolCall: async () => ({ terminate: true }),
			},
			undefined,
			() => {
				llmCalls++;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
							"toolUse",
						),
					});
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});
});

describe("MiniMax seam: onToolExecutionStart admitted boundary (row 17)", () => {
	it("should observe execution start only after before-tool admission succeeds", async () => {
		const order: string[] = [];
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: Type.Object({ value: Type.String() }),
			async execute(_toolCallId, params) {
				order.push("execute");
				return { content: [{ type: "text", text: String((params as { value: string }).value) }], details: {} };
			},
		};
		const stream = agentLoop(
			[createUserMessage("echo")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => {
					order.push("before");
					return undefined;
				},
				onToolExecutionStart: () => order.push("execution-start"),
				afterToolCall: async () => {
					order.push("after");
					return { terminate: true };
				},
			},
			undefined,
			() => {
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "one" } }],
							"toolUse",
						),
					});
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}
		expect(order).toEqual(["before", "execution-start", "execute", "after"]);
	});

	it("does not fire for denied or skipped calls", async () => {
		const started: string[] = [];
		const tool = echoTool([], "echo");
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("echo both")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				beforeToolCall: async ({ toolCall }) =>
					toolCall.id === "tool-1"
						? { block: true, reason: "stop now", terminateAgent: true }
						: undefined,
				onToolExecutionStart: ({ toolCall }) => started.push(toolCall.id),
			},
			undefined,
			() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
							],
							"toolUse",
						),
					});
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}
		// denied (tool-1) and skipped (tool-2) calls never reach the effect boundary
		expect(started).toEqual([]);
	});
});

describe("MiniMax seam: unexpectedToolCallFallback (row 1)", () => {
	it.each(["error", "aborted"] as const)(
		"does not normalize an interrupted unexpected tool call with stop reason %s",
		async (stopReason) => {
			const fallback = "Switch to standard mode.";
			const message = {
				...createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
					stopReason,
				),
				errorMessage: "Synthetic provider failure",
			};
			const stream = agentLoop(
				[createUserMessage("Read a file")],
				{ messages: [], tools: [] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					unexpectedToolCallFallback: fallback,
				},
				undefined,
				() => {
					const mockStream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						mockStream.push({ type: "error", reason: stopReason, error: message });
					});
					return mockStream;
				},
			);

			for await (const _event of stream) {
				// consume
			}
			const assistant = (await stream.result()).at(-1);
			expect(assistant).toMatchObject({
				role: "assistant",
				stopReason,
				errorMessage: "Synthetic provider failure",
				content: [{ type: "toolCall", name: "read" }],
			});
		},
	);

	it.each([
		["I'll read the file.", "I'll read the file.\n\nSwitch to standard mode."],
		["I'll read the file.\n\nSwitch to standard mode.", "I'll read the file.\n\nSwitch to standard mode."],
	])("appends unexpected-tool guidance once after provider text", async (providerText, expected) => {
		const fallback = "Switch to standard mode.";
		const stream = agentLoop(
			[createUserMessage("Read a file")],
			{ messages: [], tools: [] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				unexpectedToolCallFallback: fallback,
			},
			undefined,
			() => {
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage(
						[
							{ type: "text", text: providerText },
							{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}
		const assistant = (await stream.result()).at(-1);
		expect(assistant).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: expected }],
		});
		expect((assistant as AssistantMessage).content).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
		);
		expect(expected.split(fallback)).toHaveLength(2);
	});
});
