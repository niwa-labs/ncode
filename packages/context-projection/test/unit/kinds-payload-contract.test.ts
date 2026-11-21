// Payload-narrowing contract of the control kinds.
//
// `asCompactionPayload` / `asContextEditPayload` are the ONLY gate between an
// arbitrary stored payload and the derived view. A malformed payload must be
// rejected loudly (a contract breach, never a silently ignored control entry),
// and every accepted shape must have exactly one meaning.
//
// This file pins the accepted shapes, the rejected shapes, and the two
// documented precedence rules of the context-edit payload.

import { describe, expect, it } from 'vitest';

import {
	COMPACTION_KIND,
	CONTROL_KIND_PREFIX,
	CONTEXT_EDIT_KIND,
	ProjectionError,
	asCompactionPayload,
	asContextEditPayload,
	buildProjection,
	isControlKind,
} from '../../src/index.js';
import { auditEntry, compactionEntry, editEntry, llmEntry } from './helpers.js';

describe('isControlKind', () => {
	it('classifies by the `mcode.` prefix only', () => {
		expect(CONTROL_KIND_PREFIX).toBe('mcode.');
		expect(isControlKind('mcode.compaction')).toBe(true);
		expect(isControlKind('mcode.context_edit')).toBe(true);
		expect(isControlKind('mcode.audit')).toBe(true);
		expect(isControlKind('mcode.')).toBe(true);
		// Not control: no dot, or a different prefix.
		expect(isControlKind('mcode')).toBe(false);
		expect(isControlKind('mcodex')).toBe(false);
		expect(isControlKind('Mcode.compaction')).toBe(false);
		expect(isControlKind('pi.user')).toBe(false);
		expect(isControlKind('')).toBe(false);
	});
});

describe('asCompactionPayload', () => {
	it('accepts the documented shape', () => {
		expect(asCompactionPayload({ summary: 's', firstKeptEntryId: 'e1' }, 'e1')).toEqual({
			summary: 's',
			firstKeptEntryId: 'e1',
		});
	});

	it('accepts an empty summary (a string is a string)', () => {
		expect(asCompactionPayload({ summary: '', firstKeptEntryId: 'e1' }, 'e1')).toEqual({
			summary: '',
			firstKeptEntryId: 'e1',
		});
	});

	it('rejects every malformed shape loudly', () => {
		const rejects: unknown[] = [
			undefined,
			null,
			'string',
			42,
			[],
			{},
			{ summary: 's' },
			{ firstKeptEntryId: 'e1' },
			{ summary: 42, firstKeptEntryId: 'e1' },
			{ summary: 's', firstKeptEntryId: '' },
			{ summary: 's', firstKeptEntryId: 42 },
			{ summary: null, firstKeptEntryId: 'e1' },
		];
		for (const payload of rejects) {
			expect(() => asCompactionPayload(payload, 'e1')).toThrow(TypeError);
		}
	});
});

describe('asContextEditPayload', () => {
	it('accepts the omission variant', () => {
		expect(
			asContextEditPayload({ action: 'omission', targetIds: ['a', 'b'] }, 'e1'),
		).toEqual({ action: 'omission', targetIds: ['a', 'b'] });
	});

	it('accepts an omission with an empty target list', () => {
		expect(asContextEditPayload({ action: 'omission', targetIds: [] }, 'e1')).toEqual({
			action: 'omission',
			targetIds: [],
		});
	});

	it('accepts the strict-prune variant', () => {
		expect(asContextEditPayload({ removedEntryIds: ['a'] }, 'e1')).toEqual({
			removedEntryIds: ['a'],
		});
	});

	it('drops the optional omission fields the fold does not read', () => {
		expect(
			asContextEditPayload(
				{ action: 'omission', targetIds: ['a'], reason: 'overflow', createdAtMs: 1 },
				'e1',
			),
		).toEqual({ action: 'omission', targetIds: ['a'] });
	});

	it('prefers the omission variant when both variants are present', () => {
		// Precedence rule: the omission branch is checked first, so a payload
		// carrying both variants is read as an omission — never as a strict
		// prune (which would REJECT unknown ids).
		expect(
			asContextEditPayload(
				{ action: 'omission', targetIds: ['a'], removedEntryIds: ['unknown'] },
				'e1',
			),
		).toEqual({ action: 'omission', targetIds: ['a'] });
	});

	it('rejects every malformed shape loudly', () => {
		const rejects: unknown[] = [
			undefined,
			null,
			'string',
			42,
			[],
			{},
			{ action: 'omission' },
			{ action: 'omission', targetIds: 'a' },
			{ action: 'omission', targetIds: ['a', 42] },
			{ action: 'replacement', targetIds: ['a'] },
			{ removedEntryIds: 'a' },
			{ removedEntryIds: ['a', 42] },
			{ note: 'no recognized variant' },
		];
		for (const payload of rejects) {
			expect(() => asContextEditPayload(payload, 'e1')).toThrow(TypeError);
		}
	});
});

describe('control kinds in the fold', () => {
	it('rejects a compaction whose target is not a current segment', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const compaction = compactionEntry(2, 0, 'summary', 'missing-entry');
		expect(() => buildProjection([a, compaction])).toThrow(ProjectionError);
	});

	it('rejects a strict prune of an id that a previous prune already removed', () => {
		// The strict variant asserts EXACT knowledge of the window: pruning an
		// id that is no longer a segment is a contract breach.
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'b' }, 1, 1);
		const first = editEntry(2, 0, [a.id]);
		const second = editEntry(3, 0, [a.id]);
		expect(() => buildProjection([a, b, first, second])).toThrow(ProjectionError);
	});

	it('removes a segment once when the prune lists its id twice', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'b' }, 1, 1);
		const edit = { ...editEntry(2, 0, []), payload: { removedEntryIds: [a.id, a.id] } };
		const manifest = buildProjection([a, b, edit]);
		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([b.id]);
		expect(manifest.windowBytes).toBe(Buffer.byteLength(JSON.stringify(b.payload), 'utf8'));
	});

	it('tolerates an omission of a target that is not a current segment', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const omission = {
			...editEntry(2, 0, []),
			payload: { action: 'omission', targetIds: ['never-projected'], reason: 'late retraction' },
		};
		const manifest = buildProjection([a, omission]);
		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([a.id]);
		expect(manifest.windowBytes).toBe(Buffer.byteLength(JSON.stringify(a.payload), 'utf8'));
	});

	it('keeps the audit kinds out of the window while the fold advances', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const audit = auditEntry(1, 1);
		const manifest = buildProjection([a, audit]);
		expect(manifest.segments).toHaveLength(1);
		expect(manifest.watermark).toEqual({ seq: 1, ordinal: 1 });
		expect(manifest.usageAnchor).toBe(a.id);
	});

	it('exposes the reserved control kinds under their pinned literals', () => {
		expect(COMPACTION_KIND).toBe('mcode.compaction');
		expect(CONTEXT_EDIT_KIND).toBe('mcode.context_edit');
	});
});
