// V-C10 differential parity: our per-entry conversion of the pi conversion
// tags against the PINNED pi `convertToLlm` itself (u-registry U07: "V-C10
// conversion tags pi + наши rules"; plan §9.1 V-C10: "Pi
// custom/bashExecution/!!/summary tags").
//
// The oracle is NOT our code: `convertToLlm` (and the message factories) come
// from the vendored coding-agent dist of the pinned tree (pin 48c8f32, built
// by W01). For every scenario the SAME stored message is (a) converted by pi's
// `convertToLlm` and (b) decoded + converted by our per-entry stage, and the
// provider-visible outcomes must agree after the declared mapping:
//
//   declared mapping — pi AgentMessage → our durable entry:
//     the pi message object IS the entry payload (`{ model: [message] }`),
//     the shape the pi session writer persists for one message entry;
//   outcome mapping — our `CompiledEntry` → pi `Message`:
//     `null` (no record) ↔ pi `undefined` (dropped from context);
//     otherwise `{ role, content: [{ type: 'text', text }] }` must equal pi's
//     output message in role and in the JOINED text of its content parts.
//
// Documented intentional differences (our rules, allowed by V-C10 — the plan
// lists "наши omit/merge/reminder/... rules" as our own layer on top):
//   - timestamp: pi `Message` carries `timestamp`; our `CompiledEntry` does
//     not (timestamps live on the durable entry, not the provider record);
//   - multi-block content: pi keeps the block ARRAY as the message content;
//     our `CompiledEntry.content` is one string, so blocks join with the
//     dialect `textJoin` — asserted explicitly in the custom-blocks scenario;
//   - image parts inside a custom message render through our dialect
//     placeholder policy (pi passes ImageContent through) — the image
//     rendering axis is pinned by the residency/wire suites, so the parity
//     corpus here uses text-only custom content.

import { describe, expect, it } from 'vitest';

import { fileURLToPath } from 'node:url';

import { convertEntry } from '../../src/convert-entry.js';
import { MINIMAX_M3_DIALECT } from '../../src/dialect.js';
import type { DurableEntry } from '../../src/types.js';

// The pinned pi converter, imported from the vendored dist (built from the
// pinned tree by W01 — NOT our code).
const PI_CORE = fileURLToPath(new URL('../../../../third_party/pi-mono/packages/coding-agent/dist/core', import.meta.url));

type PiMessage = { role: string; content: unknown; timestamp?: number };

async function loadPi(): Promise<(messages: unknown[]) => PiMessage[]> {
	const messages = (await import(`${PI_CORE}/messages.js`)) as { convertToLlm: (messages: unknown[]) => PiMessage[] };
	return messages.convertToLlm;
}

/** Our durable entry carrying exactly one pi message (the writer spelling). */
function entryOf(message: Record<string, unknown>): DurableEntry {
	return {
		id: 'e1',
		parentId: null,
		kind: 'pi.user',
		payload: { model: [message] } as unknown as DurableEntry['payload'],
		seq: 1 as DurableEntry['seq'],
		ordinal: 0,
	};
}

/** Provider-visible outcome of our stage, mapped to the pi comparison shape. */
function ourOutcome(entry: DurableEntry): { role: string; text: string } | null {
	const record = convertEntry(entry, MINIMAX_M3_DIALECT);
	if (record === null) return null;
	return { role: record.role, text: record.content };
}

/** pi outcome mapped to the same shape: dropped ↔ null, else joined part text. */
function piOutcome(pi: (messages: unknown[]) => PiMessage[], message: Record<string, unknown>): { role: string; text: string } | null {
	const converted = pi([message]);
	if (converted.length === 0) return null;
	const out = converted[0]!;
	const content = out.content;
	const text = Array.isArray(content)
		? content.map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '')).join('')
		: String(content);
	return { role: out.role, text };
}

describe('V-C10: pi conversion tags — our stage vs the pinned convertToLlm', () => {
	it('bashExecution scenarios match pi byte-for-byte', async () => {
		const pi = await loadPi();
		const scenarios: Record<string, unknown>[] = [
			{ role: 'bashExecution', command: 'ls -la', output: 'file-a\nfile-b', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
			{ role: 'bashExecution', command: 'make', output: '', exitCode: undefined, cancelled: false, truncated: false, timestamp: 0 },
			{ role: 'bashExecution', command: 'boom', output: 'err', exitCode: 2, cancelled: false, truncated: false, timestamp: 0 },
			{ role: 'bashExecution', command: 'sleep 10', output: 'partial', exitCode: undefined, cancelled: true, truncated: false, timestamp: 0 },
			{
				role: 'bashExecution',
				command: 'cat huge.log',
				output: '...first lines...',
				exitCode: 0,
				cancelled: false,
				truncated: true,
				fullOutputPath: '/tmp/spill/huge.log',
				timestamp: 0,
			},
			{ role: 'bashExecution', command: 'make && make install', output: 'built\ninstalled', exitCode: 1, cancelled: false, truncated: false, timestamp: 0 },
		];
		for (const message of scenarios) {
			expect(ourOutcome(entryOf(message))).toEqual(piOutcome(pi, message));
		}
	});

	it('the `!!` exclusion (excludeFromContext) drops the record exactly like pi', async () => {
		const pi = await loadPi();
		const message = {
			role: 'bashExecution',
			command: 'secret',
			output: 'output',
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 0,
		};
		expect(piOutcome(pi, message)).toBeNull();
		expect(ourOutcome(entryOf(message))).toBeNull();
	});

	it('custom messages match pi: string content; block content joins with the dialect textJoin', async () => {
		const pi = await loadPi();
		const stringContent = { role: 'custom', customType: 'com.example.note', content: 'plain string content', display: true, timestamp: 0 };
		expect(ourOutcome(entryOf(stringContent))).toEqual(piOutcome(pi, stringContent));

		const blocks = { role: 'custom', customType: 'com.example.blocks', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }], display: false, timestamp: 0 };
		const ours = ourOutcome(entryOf(blocks))!;
		const theirs = piOutcome(pi, blocks)!;
		// Role parity, and the SAME parts — pi keeps them as a block array,
		// our provider record is one string joined by the dialect textJoin
		// (the documented intentional difference above).
		expect(ours.role).toBe(theirs.role);
		expect(ours.text).toBe(['first', 'second'].join(MINIMAX_M3_DIALECT.textJoin));
		expect(ours.text.split(MINIMAX_M3_DIALECT.textJoin)).toEqual(['first', 'second']);
	});

	it('branchSummary and compactionSummary match the pi summary templates', async () => {
		const pi = await loadPi();
		const scenarios: Record<string, unknown>[] = [
			{ role: 'branchSummary', summary: 'Tried a refactor; reverted.', fromId: null, timestamp: 0 },
			{ role: 'compactionSummary', summary: 'Older turns condensed.', tokensBefore: 12345, timestamp: 0 },
		];
		for (const message of scenarios) {
			const ours = ourOutcome(entryOf(message));
			const theirs = piOutcome(pi, message);
			expect(ours).toEqual(theirs);
			// The template texts really are the pi constants (prefix + summary + suffix).
			expect(ours!.text).toContain('<summary>');
			expect(ours!.role).toBe('user');
		}
	});

	it('plain roles still pass through identically (system/user/assistant/toolResult)', async () => {
		const pi = await loadPi();
		const scenarios: Record<string, unknown>[] = [
			{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 0 },
			{ role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
			{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'done' }], timestamp: 0 },
		];
		for (const message of scenarios) {
			const ours = ourOutcome(entryOf(message));
			const theirs = piOutcome(pi, message);
			// Our stage maps toolResult → provider `tool` role with correlation
			// fields — a declared difference of the provider format; parity here
			// is on the TEXT and the non-dropping outcome.
			if (theirs === null) expect(ours).toBeNull();
			else expect(ours!.text).toBe(theirs.text);
		}
	});

	it('malformed tag payloads convert to nothing on our side; pi never lets them reach conversion', async () => {
		const sessionManager = (await import(`${PI_CORE}/session-manager.js`)) as {
			sessionEntryToContextMessages: (entry: unknown) => unknown[];
		};
		// OUR policy: a tag message whose template inputs are missing fails the
		// WHOLE message (decodes to nothing) — never a partially rendered record.
		const noCommand = { role: 'bashExecution', output: 'no command', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 };
		expect(ourOutcome(entryOf(noCommand))).toBeNull();
		// pi's SESSION layer (not convertToLlm) keeps empty summaries out of
		// context: `sessionEntryToContextMessages` guards `entry.summary &&`
		// (pin session-manager.ts:458) — such an entry contributes no message.
		expect(
			sessionManager.sessionEntryToContextMessages({ type: 'branch_summary', id: 'b1', parentId: null, timestamp: 't', fromId: null, summary: '' }),
		).toEqual([]);
		// And our stage agrees once the empty summary is decoded: no record.
		expect(ourOutcome(entryOf({ role: 'branchSummary', summary: '', fromId: null, timestamp: 0 }))).toBeNull();
	});
});
