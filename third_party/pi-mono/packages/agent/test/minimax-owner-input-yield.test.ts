/**
 * MiniMax host seam: the sequential-batch yield-to-owner-input boundary
 * (reactive subagents verdict §1.7, wave 3).
 *
 * The accepted-owner-input generation is captured BEFORE the first call of a
 * batch; a change at an inter-call boundary means a trusted owner input was
 * accepted while the earlier calls of THIS batch were running, so the
 * not-yet-started calls must not start blind: each receives exactly one
 * honest skipped error outcome (the terminate seam's shape, WITHOUT
 * terminate-agent) and the loop CONTINUES to the steering drain — the model
 * turn is not ended, so the next provider request carries the new input.
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
import { agentLoop, type AgentLoopConfig, type StreamFn } from "../src/index.ts";
import type { AgentContext, AgentMessage, AgentTool } from "../src/types.ts";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
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

const parkParameters = Type.Object({ value: Type.String() });

/** A sequential tool whose execution can advance the owner-input generation. */
function parkTool(
	executed: string[],
	options: { readonly generationBumpOnFirstCall?: () => void; readonly name?: string } = {},
): AgentTool<typeof parkParameters> {
	let firstCall = true;
	return {
		name: options.name ?? "park",
		label: options.name ?? "park",
		description: "park tool",
		parameters: parkParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			executed.push(params.value);
			if (firstCall) {
				firstCall = false;
				options.generationBumpOnFirstCall?.();
			}
			return { content: [{ type: "text", text: params.value }], details: {} };
		},
	};
}

function toolCallBatch(ids: readonly string[]): AssistantMessage["content"] {
	return ids.map((id) => ({
		type: "toolCall" as const,
		id,
		name: "park",
		arguments: { value: id },
	}));
}

describe("MiniMax seam: sequential-batch yield-to-owner-input (§1.7)", () => {
	it("skips the not-yet-started calls with honest errors and continues to the steering drain", async () => {
		const executed: string[] = [];
		let generation = 0;
		const tool = parkTool(executed, {
			generationBumpOnFirstCall: () => {
				generation += 1;
			},
		});
		let llmCalls = 0;
		let polls = 0;
		let steeringAvailable = true;
		const requests: string[] = [];
		const context: AgentContext = { messages: [], tools: [tool] };
		const stream = agentLoop(
			[createUserMessage("run the batch")],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel", // the tool's own `sequential` mode serializes the batch
				ownerInputGeneration: () => generation,
				// The accepted input is drained exactly once — the FIRST poll after
				// the tool round (poll 1 is the initial pre-request poll).
				getSteeringMessages: async () => {
					polls += 1;
					if (polls >= 2 && steeringAvailable) {
						steeringAvailable = false;
						return [createUserMessage("the new user instruction")];
					}
					return [];
				},
			} satisfies AgentLoopConfig,
			undefined,
			((_model, context) => {
				llmCalls += 1;
				requests.push(JSON.stringify(context.messages));
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message =
						llmCalls === 1
							? createAssistantMessage(toolCallBatch(["call-a", "call-b", "call-c"]), "toolUse")
							: createAssistantMessage([{ type: "text", text: "answered the new input" }]);
					mockStream.push({ type: "done", reason: message.stopReason, message });
				});
				return mockStream;
			}) as StreamFn,
		);
		for await (const _event of stream) {
			// consume
		}
		// №4 ordering fact: only the FIRST call of the batch started; B and C
		// never executed against the accepted instruction.
		expect(executed).toEqual(["call-a"]);
		// The loop continued past the tool round (the steering drain ran and the
		// follow-up request consumed the accepted input) — no terminate-agent.
		expect(llmCalls).toBeGreaterThanOrEqual(2);
		expect(requests[1]).toContain("the new user instruction");
		// Every call of the batch received exactly one (honest) outcome.
		const toolResults = (await stream.result()).filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(3);
		expect(toolResults[0]).toMatchObject({ toolCallId: "call-a", isError: false });
		for (const skipped of toolResults.slice(1)) {
			expect(skipped).toMatchObject({
				isError: true,
				content: [
					{
						type: "text",
						text: expect.stringContaining("not started because new user input was accepted"),
					},
				],
			});
		}
	});

	it("keeps the whole batch running when the generation did not change", async () => {
		const executed: string[] = [];
		const tool = parkTool(executed);
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("run the batch")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				ownerInputGeneration: () => 0,
				getSteeringMessages: async () => [],
			},
			undefined,
			(() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: llmCalls === 1 ? "toolUse" : "stop",
						message:
							llmCalls === 1
								? createAssistantMessage(toolCallBatch(["call-a", "call-b"]), "toolUse")
								: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				});
				return mockStream;
			}) as StreamFn,
		);
		for await (const _event of stream) {
			// consume
		}
		expect(executed).toEqual(["call-a", "call-b"]);
		expect(llmCalls).toBe(2);
		const toolResults = (await stream.result()).filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.every((result) => result.isError === false)).toBe(true);
	});

	it("ignores an input accepted before the batch when no new one arrives mid-batch", async () => {
		const executed: string[] = [];
		// The generation was ALREADY advanced when the batch starts (the input
		// was drained before this assistant response) — the baseline captures
		// it, so the batch runs fully against the NEW instruction.
		const tool = parkTool(executed);
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("the new user instruction")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				ownerInputGeneration: () => 7,
				getSteeringMessages: async () => [],
			},
			undefined,
			(() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: llmCalls === 1 ? "toolUse" : "stop",
						message:
							llmCalls === 1
								? createAssistantMessage(toolCallBatch(["call-a", "call-b"]), "toolUse")
								: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				});
				return mockStream;
			}) as StreamFn,
		);
		for await (const _event of stream) {
			// consume
		}
		expect(executed).toEqual(["call-a", "call-b"]);
	});

	it("behaves exactly as before when the host does not wire the probe", async () => {
		const executed: string[] = [];
		const tool = parkTool(executed, {
			generationBumpOnFirstCall: () => undefined,
		});
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("run the batch")],
			{ messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				getSteeringMessages: async () => [],
			},
			undefined,
			(() => {
				llmCalls += 1;
				const mockStream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: llmCalls === 1 ? "toolUse" : "stop",
						message:
							llmCalls === 1
								? createAssistantMessage(toolCallBatch(["call-a", "call-b"]), "toolUse")
								: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				});
				return mockStream;
			}) as StreamFn,
		);
		for await (const _event of stream) {
			// consume
		}
		expect(executed).toEqual(["call-a", "call-b"]);
	});
});
