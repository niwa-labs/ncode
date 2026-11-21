/**
 * W03 transcript decode: `pi.system` entries carry their tool/section extras
 * through `decodeEntryPayload` — tool declarations must not vanish in decode
 * (wave risk "tool declarations теряются в decode"), and a malformed extra is
 * a diagnosable loss (the message decodes to nothing and the assembler counts
 * it under `noProviderRecord`), never a silent drop.
 */

import { describe, expect, it } from 'vitest';

import {
	decodeEntryPayload,
	assemblePayload,
	convertEntry,
	MINIMAX_M3_DIALECT,
} from '../../src/index.js';
import { makeEntry } from './helpers.js';

/** A `pi.system` entry with `{model:[SystemMessage]}` payload (pi-durable convention). */
function systemEntry(id: string, message: Record<string, unknown>): ReturnType<typeof makeEntry> {
	return makeEntry(id, 'pi.system', { model: [{ role: 'system', ...message }] });
}

const TOOL = { name: 'read', description: 'read a file', parameters: { type: 'object' } };

describe('pi.system decode carries the transcript extras', () => {
	it('decodes sections, toolsAdded, toolsRemoved and timestamp', () => {
		const decoded = decodeEntryPayload(
			'pi.system',
			{
				model: [
					{
						role: 'system',
						content: '',
						sections: { env: 'dev', old: null },
						toolsAdded: [{ ...TOOL, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }],
						toolsRemoved: [{ name: 'bash', extra: 'dropped' }],
						timestamp: 42,
					},
				],
			},
		);
		expect(decoded.messages).toHaveLength(1);
		const message = decoded.messages[0]!;
		expect(message.role).toBe('system');
		expect(message.sections).toEqual({ env: 'dev', old: null });
		expect(message.toolsAdded).toEqual([
			{ name: 'read', description: 'read a file', parameters: { type: 'object' }, constrainedSampling: { type: 'json_schema', strict: 'prefer' } },
		]);
		expect(message.toolsRemoved).toEqual([{ name: 'bash' }]);
		expect(message.timestamp).toBe(42);
	});

	it('decodes block content and keeps absent extras absent', () => {
		const decoded = decodeEntryPayload('pi.system', {
			model: [{ role: 'system', content: [{ type: 'text', text: 'base' }, { type: 'text', text: 'more' }] }],
		});
		const message = decoded.messages[0]!;
		expect(message.parts).toEqual([
			{ type: 'text', text: 'base' },
			{ type: 'text', text: 'more' },
		]);
		expect(message.sections).toBeUndefined();
		expect(message.toolsAdded).toBeUndefined();
		expect(message.toolsRemoved).toBeUndefined();
		expect(message.timestamp).toBeUndefined();
	});

	it('strips unknown extra fields off tool declarations (toToolDeclaration shape)', () => {
		const decoded = decodeEntryPayload('pi.system', {
			model: [{ role: 'system', content: '', toolsAdded: [{ ...TOOL, executable: 'x-ui' }] }],
		});
		expect(decoded.messages[0]!.toolsAdded).toEqual([TOOL]);
	});

	it('a tool-only positional system entry converts to no provider record (tools ride the request field)', () => {
		const entry = systemEntry('s1', { content: '', toolsAdded: [TOOL], timestamp: 0 });
		expect(convertEntry(entry, MINIMAX_M3_DIALECT)).toBeNull();
		const assembled = assemblePayload([entry]);
		expect(assembled.records).toHaveLength(0);
		expect(assembled.stats.noProviderRecord).toBe(1);
	});

	it.each([
		['toolsAdded is not an array', { content: '', toolsAdded: 'read' }],
		['toolsAdded item missing name', { content: '', toolsAdded: [{ description: 'd', parameters: {} }] }],
		['toolsAdded item missing description', { content: '', toolsAdded: [{ name: 'n', parameters: {} }] }],
		['toolsAdded item missing parameters', { content: '', toolsAdded: [{ name: 'n', description: 'd' }] }],
		['toolsRemoved item missing name', { content: '', toolsRemoved: [{}] }],
		['sections value is a number', { content: '', sections: { env: 3 } }],
		['timestamp is a string', { content: '', timestamp: 'x' }],
	])('malformed system extra (%s) fails the WHOLE message, not just the field', (_label, message) => {
		const decoded = decodeEntryPayload('pi.system', { model: [{ role: 'system', ...message }] });
		expect(decoded.messages).toEqual([]);
		const assembled = assemblePayload([systemEntry('s1', message)]);
		expect(assembled.stats.noProviderRecord).toBe(1);
	});

	it('non-system messages with a timestamp still decode (timestamp is system-only bookkeeping)', () => {
		const decoded = decodeEntryPayload('pi.user', {
			model: [{ role: 'user', content: 'hi', timestamp: 7 }],
		});
		expect(decoded.messages[0]!.parts).toEqual([{ type: 'text', text: 'hi' }]);
		expect(decoded.messages[0]!.timestamp).toBeUndefined();
	});
});
