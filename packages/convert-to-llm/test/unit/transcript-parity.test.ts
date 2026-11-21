/**
 * W03-T oracle parity: the transcript layer (`src/transcript.ts`) against the
 * PINNED pi implementation itself — loaded here from the vendored source
 * (`third_party/pi-mono/packages/ai/src/utils/{transcript,text}.ts`),
 * byte-identical to the pin oracle checkout `worktrees/pi-oracle-48c8f32`
 * (verified by `diff` in this wave). Comparing two of OUR code paths would
 * not prove conformance to pi (port-plan.md:851); this file runs BOTH
 * implementations over the same declared data and requires identical
 * outputs — the "not-our-projector" rule applied to the transcript layer.
 *
 * The pin modules load through a DYNAMIC, non-literal import on purpose: a
 * static import (value or type) would pull the whole vendored pi-ai source
 * tree into this package's typecheck program, which compiles it under OUR
 * strictness flags instead of its own. The pin surface used here is declared
 * locally below; every comparison goes through JSON serialization, so the
 * boundary stays structural.
 */

import { describe, expect, it } from 'vitest';

import {
	collapseSystemMessages,
	createInitialSystemMessage,
	declarationsEqual,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getDeclaredTools,
	getInitialSystemMessage,
	getSystemMessageText,
	getToolStateChanges,
	hasNonAdditiveToolChanges,
	renderSystemMessageUpdate,
	resolveTranscript,
	resolveTranscriptTools,
	toToolDeclaration,
	withoutInitialSystemMessage,
	type DecodedMessage,
	type DecodedPart,
	type DecodedToolDeclaration,
} from '../../src/index.js';

// ─── the pin surface, loaded dynamically (see header) ────────────────────────

const PIN_TRANSCRIPT_URL = new URL(
	'../../../../third_party/pi-mono/packages/ai/src/utils/transcript.ts',
	import.meta.url,
).href;
const PIN_TEXT_URL = new URL(
	'../../../../third_party/pi-mono/packages/ai/src/utils/text.ts',
	import.meta.url,
).href;

/** The pinned `Tool` as JSON at rest (no typebox symbol keys). */
interface PinTool {
	name: string;
	description: string;
	parameters: unknown;
	constrainedSampling?: unknown;
}

/** The pinned `SystemMessage` fields the replay reads. */
interface PinSystemMessage {
	role: 'system';
	content: string | { type: 'text'; text: string }[];
	sections?: Record<string, string | null>;
	toolsAdded?: PinTool[];
	toolsRemoved?: { name: string }[];
	timestamp: number;
}

/** Any pinned message the replay helpers accept (`TranscriptMessages`) — role stays open, extras optional. */
type PinMessage = {
	role: string;
	content?: string | { type: 'text'; text: string }[];
	sections?: Record<string, string | null>;
	toolsAdded?: PinTool[];
	toolsRemoved?: { name: string }[];
	timestamp?: number;
};

/** The pin functions under test (transcript.ts + text.ts), all `unknown`-typed at the boundary. */
type PinTranscriptModule = {
	getCurrentTools: (messages: readonly PinMessage[]) => PinTool[];
	getCurrentSystemMessage: (messages: readonly PinMessage[]) => unknown;
	getCurrentSystemPrompt: (messages: readonly PinMessage[]) => string;
	getInitialSystemMessage: (messages: readonly PinMessage[]) => unknown;
	collapseSystemMessages: (context: { messages: PinMessage[] }) => { messages: PinMessage[] };
	resolveTranscript: (context: { messages: PinMessage[] }, supported: boolean | undefined) => { messages: PinMessage[] };
	getDeclaredTools: (messages: readonly PinMessage[]) => PinTool[];
	hasNonAdditiveToolChanges: (messages: readonly PinMessage[]) => boolean;
	resolveTranscriptTools: (
		messages: readonly PinMessage[],
		support: 'none' | 'additions' | 'changes',
	) => { requestTools: PinTool[]; foldedSystemMessages: number };
	createInitialSystemMessage: (
		systemPrompt: string | undefined,
		tools: readonly PinTool[] | undefined,
	) => unknown;
	getToolStateChanges: (
		previous: readonly PinTool[],
		current: readonly PinTool[],
	) => { toolsAdded: PinTool[]; toolsRemoved: { name: string }[] };
	toToolDeclaration: (tool: PinTool) => PinTool;
	declarationsEqual: (left: PinTool, right: PinTool) => boolean;
};

type PinTextModule = {
	getSystemMessageText: (message: PinSystemMessage) => string;
	renderSystemMessageUpdate: (message: PinSystemMessage) => string;
};

// Top-level await keeps the oracle load outside every test while staying
// asynchronous; a load failure fails the whole file, never silently passes.
const pin = (await import(PIN_TRANSCRIPT_URL)) as unknown as PinTranscriptModule;
const pinText = (await import(PIN_TEXT_URL)) as unknown as PinTextModule;

// ─── declared data ───────────────────────────────────────────────────────────

/** A pi `Tool` with plain-JSON parameters (JSON at rest carries no typebox symbols). */
function pinTool(name: string, parameters: Record<string, unknown>, description = `${name} tool`): PinTool {
	return { name, description, parameters };
}

interface Scenario {
	readonly name: string;
	readonly pinMessages: PinMessage[];
}

const TOOL_A = pinTool('read', { type: 'object', properties: { path: { type: 'string' } } });
const TOOL_A_V2 = pinTool('read', { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } } });
const TOOL_B = pinTool('bash', { type: 'object' });
const TOOL_C = pinTool('grep', { type: 'object' });

const SCENARIOS: Scenario[] = [
	{ name: 'empty', pinMessages: [] },
	{
		name: 'plain conversation, no system',
		pinMessages: [
			{ role: 'user', content: 'hi', timestamp: 1 },
			{ role: 'assistant', content: [], timestamp: 2 },
		],
	},
	{
		name: 'leading system with prompt and tools, later delta',
		pinMessages: [
			{ role: 'system', content: 'base prompt', toolsAdded: [TOOL_A, TOOL_B], timestamp: 10 },
			{ role: 'user', content: 'go', timestamp: 11 },
			{
				role: 'system',
				content: '',
				toolsAdded: [TOOL_A_V2, TOOL_C],
				toolsRemoved: [{ name: 'bash' }],
				timestamp: 12,
			},
		],
	},
	{
		name: 'tools-only leading system (positional prompt)',
		pinMessages: [
			{ role: 'system', content: '', toolsAdded: [TOOL_A], timestamp: 0 },
			{ role: 'user', content: 'x', timestamp: 1 },
		],
	},
	{
		name: 'non-leading system before any leading one',
		pinMessages: [
			{ role: 'user', content: 'first', timestamp: 1 },
			{ role: 'system', content: 'late instructions', toolsAdded: [TOOL_B], timestamp: 2 },
		],
	},
	{
		name: 'sections patch, null removal, re-add',
		pinMessages: [
			{ role: 'system', content: 'base', sections: { env: 'dev', cwd: '/tmp' }, timestamp: 1 },
			{ role: 'system', content: '', sections: { env: null }, timestamp: 2 },
			{ role: 'system', content: '', sections: { env: 'prod', extra: 'x' }, timestamp: 3 },
		],
	},
	{
		name: 'identical redeclaration then removal then re-add (non-additive history)',
		pinMessages: [
			{ role: 'system', content: '', toolsAdded: [TOOL_A], timestamp: 1 },
			{ role: 'user', content: 'u', timestamp: 2 },
			{ role: 'system', content: '', toolsAdded: [TOOL_A], timestamp: 3 },
			{ role: 'system', content: '', toolsRemoved: [{ name: 'read' }], timestamp: 4 },
			{ role: 'system', content: '', toolsAdded: [TOOL_A], timestamp: 5 },
		],
	},
	{
		name: 'block content joins with one newline inside a message',
		pinMessages: [
			{ role: 'system', content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }], timestamp: 1 },
			{ role: 'system', content: 'second message', timestamp: 2 },
		],
	},
];

// ─── declared data mapping: pin Message[] → our TranscriptMessage[] ─────────

function pinContentToParts(content: string | readonly unknown[]): DecodedPart[] {
	if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : [];
	return (content as { type: string; text?: string }[])
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => ({ type: 'text' as const, text: block.text as string }));
}

function pinToolToDecoded(tool: PinTool): DecodedToolDeclaration {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as DecodedToolDeclaration['parameters'],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling as never }),
	};
}

/** The same declared transcript as our decoded message list (what `decode.ts` produces at rest). */
function mapPinMessages(pinMessages: readonly PinMessage[]): DecodedMessage[] {
	return pinMessages.map((message) => {
		if (message.role !== 'system') {
			// Non-system messages only need role here; the replay ignores them.
			return { role: message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'toolResult', parts: [] } as DecodedMessage;
		}
		const system = message as PinSystemMessage;
		const decoded: DecodedMessage = {
			role: 'system',
			parts: pinContentToParts(system.content),
			...(system.sections === undefined ? {} : { sections: system.sections }),
			...(system.toolsAdded === undefined ? {} : { toolsAdded: system.toolsAdded.map(pinToolToDecoded) }),
			...(system.toolsRemoved === undefined ? {} : { toolsRemoved: system.toolsRemoved.map((r) => ({ name: r.name })) }),
			...(system.timestamp === undefined ? {} : { timestamp: system.timestamp }),
		};
		return decoded;
	});
}

// ─── normalization for comparison ────────────────────────────────────────────

/** Serialize tool lists through each side's own toToolDeclaration — the pin's exactness rule. */
function pinToolsJson(tools: readonly PinTool[]): string {
	return JSON.stringify(tools.map((tool) => pin.toToolDeclaration(tool)));
}

function ourToolsJson(tools: readonly DecodedToolDeclaration[]): string {
	return JSON.stringify(tools.map((tool) => toToolDeclaration(tool)));
}

/** Compare a pin SystemMessage with our TranscriptSystemMessage as JSON. */
function systemJson(message: unknown): string {
	return JSON.stringify(message);
}

// ─── the parity matrix ───────────────────────────────────────────────────────

describe('transcript parity with the pinned pi implementation', () => {
	for (const scenario of SCENARIOS) {
		describe(`scenario: ${scenario.name}`, () => {
			const pinMessages = scenario.pinMessages;
			const ours = mapPinMessages(pinMessages);

			it('getCurrentTools replays the same tool state', () => {
				expect(ourToolsJson(getCurrentTools(ours))).toBe(pinToolsJson(pin.getCurrentTools(pinMessages)));
			});

			it('getCurrentSystemMessage replays the same collapsed system message', () => {
				expect(systemJson(getCurrentSystemMessage(ours))).toBe(systemJson(pin.getCurrentSystemMessage(pinMessages)));
			});

			it('getCurrentSystemPrompt renders the same prompt text', () => {
				expect(getCurrentSystemPrompt(ours)).toBe(pin.getCurrentSystemPrompt(pinMessages));
			});

			it('getInitialSystemMessage agrees on presence', () => {
				expect(getInitialSystemMessage(ours) !== undefined).toBe(pin.getInitialSystemMessage(pinMessages) !== undefined);
			});

			it('withoutInitialSystemMessage drops the same prefix', () => {
				const pinFirst = pin.getInitialSystemMessage(pinMessages);
				expect(withoutInitialSystemMessage(ours).length).toBe(
					pinFirst ? pinMessages.length - 1 : pinMessages.length,
				);
			});

			it('collapseSystemMessages rebuilds the same transcript', () => {
				const pinCollapsed = pin.collapseSystemMessages({ messages: [...pinMessages] }).messages;
				const ourCollapsed = collapseSystemMessages(ours);
				expect(ourCollapsed.length).toBe(pinCollapsed.length);
				expect(ourCollapsed[0]?.role).toBe(pinCollapsed[0]?.role);
				if (pinCollapsed[0]?.role === 'system') {
					expect(systemJson(ourCollapsed[0])).toBe(systemJson(pinCollapsed[0]));
				}
				expect(ourCollapsed.slice(1).map((m) => m.role)).toEqual(pinCollapsed.slice(1).map((m) => m.role));
			});

			it('resolveTranscript keeps or collapses identically', () => {
				for (const supported of [true, false, undefined]) {
					const pinResolved = pin.resolveTranscript({ messages: [...pinMessages] }, supported).messages;
					const ourResolved = resolveTranscript(ours, supported);
					expect(ourResolved.length).toBe(pinResolved.length);
				}
			});

			it('getDeclaredTools lists the same definitions in order', () => {
				expect(ourToolsJson(getDeclaredTools(ours))).toBe(pinToolsJson(pin.getDeclaredTools(pinMessages)));
			});

			it('hasNonAdditiveToolChanges agrees', () => {
				expect(hasNonAdditiveToolChanges(ours)).toBe(pin.hasNonAdditiveToolChanges(pinMessages));
			});

			it('resolveTranscriptTools splits identically for every support', () => {
				for (const support of ['none', 'additions', 'changes'] as const) {
					const pinSplit = pin.resolveTranscriptTools(pinMessages, support);
					const ourSplit = resolveTranscriptTools(ours, support);
					expect(ourSplit.foldedSystemMessages).toBe(pinSplit.foldedSystemMessages);
					expect(ourToolsJson(ourSplit.requestTools)).toBe(pinToolsJson(pinSplit.requestTools));
				}
			});
		});
	}

	it('createInitialSystemMessage: same presence, content and tools', () => {
		const cases: Array<[string | undefined, PinTool[] | undefined]> = [
			[undefined, undefined],
			['', []],
			['prompt', undefined],
			[undefined, [TOOL_A]],
			['prompt', [TOOL_A, TOOL_B]],
		];
		for (const [prompt, tools] of cases) {
			const pinInitial = pin.createInitialSystemMessage(prompt, tools);
			const ourInitial = createInitialSystemMessage(
				prompt,
				tools === undefined ? undefined : tools.map(pinToolToDecoded),
			);
			expect(systemJson(ourInitial)).toBe(systemJson(pinInitial));
		}
	});

	it('getToolStateChanges: same diff, changed definition is removal + addition', () => {
		const previous = [TOOL_A, TOOL_B];
		const current = [TOOL_A_V2, TOOL_B, TOOL_C];
		const pinChanges = pin.getToolStateChanges(previous, current);
		const ourChanges = getToolStateChanges(previous.map(pinToolToDecoded), current.map(pinToolToDecoded));
		expect(ourToolsJson(ourChanges.toolsAdded)).toBe(pinToolsJson(pinChanges.toolsAdded));
		expect(JSON.stringify(ourChanges.toolsRemoved)).toBe(JSON.stringify(pinChanges.toolsRemoved));
	});

	it('declarationsEqual: same verdicts including key-order sensitivity', () => {
		const reordered = { ...TOOL_A, parameters: { properties: { path: { type: 'string' } }, type: 'object' } };
		expect(declarationsEqual(pinToolToDecoded(TOOL_A), pinToolToDecoded(TOOL_A_V2))).toBe(
			pin.declarationsEqual(TOOL_A, TOOL_A_V2),
		);
		expect(declarationsEqual(pinToolToDecoded(TOOL_A), pinToolToDecoded(TOOL_A))).toBe(
			pin.declarationsEqual(TOOL_A, TOOL_A),
		);
		expect(declarationsEqual(pinToolToDecoded(TOOL_A), pinToolToDecoded(reordered))).toBe(
			pin.declarationsEqual(TOOL_A, reordered),
		);
	});

	it('getSystemMessageText / renderSystemMessageUpdate render the same text', () => {
		// getSystemMessageText renders the REPLAYED message (sections already patched).
		const replayed = getCurrentSystemMessage([
			{ role: 'system', parts: [{ type: 'text', text: 'base' }], sections: { env: 'dev', old: null }, timestamp: 1 },
		]);
		expect(replayed).toBeDefined();
		expect(getSystemMessageText(replayed!)).toBe(
			pinText.getSystemMessageText({
				role: 'system',
				content: 'base',
				sections: { env: 'dev' },
				timestamp: 1,
			}),
		);

		// renderSystemMessageUpdate renders a LATER system message in place —
		// its `null` removals are still present, unlike the replayed head
		// (which deletes the section and never carries null values).
		const later: PinSystemMessage = {
			role: 'system',
			content: 'update',
			sections: { env: 'dev', old: null },
			timestamp: 2,
		};
		const ourUpdateView = {
			role: 'system' as const,
			content: 'update',
			sections: { env: 'dev', old: null } as Record<string, string | null>,
			timestamp: 2,
		};
		expect(renderSystemMessageUpdate(ourUpdateView)).toBe(pinText.renderSystemMessageUpdate(later));
	});
});
