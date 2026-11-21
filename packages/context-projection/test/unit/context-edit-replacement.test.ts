// pi replacement/omission edit semantics inside the single incremental fold.
//
// W03 part B ports the pinned `ContextEditEntry` semantics (coding-agent
// session-manager: targetId + replacement `{content}` | null, per-target
// newest-edit-wins) into `mcode.context_edit`, merged with the legacy
// omission/prune variants: one fold step, one result for compactor/wire/UI.
// These tests pin the fold behavior itself; `pi-oracle-parity.test.ts` pins
// equivalence against the pinned pi projector on the same scenarios.

import { describe, expect, it } from 'vitest';

import {
	asContextEditPayload,
	buildProjection,
	foldAll,
	type ProjectionState,
	ProjectionService,
} from '../../src/index.js';

import {
	auditEntry,
	compactionEntry,
	commitOf,
	llmEntry,
	replacementEditEntry,
	retainNoneCompactionEntry,
	usageEntry,
} from './helpers.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('asContextEditPayload: pi replacement variant', () => {
	it('accepts a replacement with string content', () => {
		expect(asContextEditPayload({ targetId: 'a', replacement: { content: 'fixed' } }, 'e1')).toEqual({
			targetId: 'a',
			replacement: { content: 'fixed' },
		});
	});

	it('accepts a replacement with array content', () => {
		const content = [{ type: 'text', text: 'fixed' }];
		expect(asContextEditPayload({ targetId: 'a', replacement: { content } }, 'e1')).toEqual({
			targetId: 'a',
			replacement: { content },
		});
	});

	it('accepts replacement null (the pi omission spelling)', () => {
		expect(asContextEditPayload({ targetId: 'a', replacement: null }, 'e1')).toEqual({
			targetId: 'a',
			replacement: null,
		});
	});

	it('rejects malformed pi variants loudly', () => {
		const rejects: unknown[] = [
			{ targetId: 'a' },
			{ targetId: 'a', replacement: undefined },
			{ targetId: '', replacement: null },
			{ targetId: 42, replacement: null },
			{ targetId: 'a', replacement: 'text' },
			{ targetId: 'a', replacement: {} },
			{ targetId: 'a', replacement: { content: 42 } },
			{ targetId: 'a', replacement: { content: null } },
		];
		for (const payload of rejects) {
			expect(() => asContextEditPayload(payload, 'e1')).toThrow(TypeError);
		}
	});

	it('keeps the omission variant first when several variants are present', () => {
		expect(
			asContextEditPayload({ action: 'omission', targetIds: ['a'], targetId: 'b', replacement: null }, 'e1'),
		).toEqual({ action: 'omission', targetIds: ['a'] });
	});
});

describe('fold: pi replacement edits', () => {
	it('replaces the content bytes of a visible target in place', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.user', { text: 'b' }, 1, 1);
		const edit = replacementEditEntry(2, 0, a.id, { content: 'rewritten' });
		const manifest = buildProjection([a, b, edit]);

		expect(manifest.segments.map((s) => s.entryId)).toEqual([a.id, b.id]);
		expect(manifest.segments[0]).toEqual({ entryId: a.id, byteLen: bytes('rewritten'), kind: 'pi.user' });
		expect(manifest.windowBytes).toBe(bytes('rewritten') + bytes(b.payload));
		expect(manifest.edits).toEqual({ [a.id]: { editEntryId: edit.id, action: 'replace' } });
	});

	it('array replacement content measures the array JSON', () => {
		const a = llmEntry('pi.assistant', { text: 'a' }, 1, 0);
		const content = [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }];
		const edit = replacementEditEntry(2, 0, a.id, { content });
		const manifest = buildProjection([a, edit]);
		expect(manifest.segments[0]!.byteLen).toBe(bytes(content));
	});

	it('omits the target when replacement is null', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.user', { text: 'b' }, 1, 1);
		const edit = replacementEditEntry(2, 0, a.id, null);
		const manifest = buildProjection([a, b, edit]);

		expect(manifest.segments.map((s) => s.entryId)).toEqual([b.id]);
		expect(manifest.edits).toEqual({ [a.id]: { editEntryId: edit.id, action: 'omit' } });
	});

	it('newest edit wins: replacement, then omission, then resurrection', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.user', { text: 'b' }, 1, 1);
		const c = llmEntry('pi.user', { text: 'c' }, 1, 2);
		const first = replacementEditEntry(2, 0, a.id, { content: 'v1' });
		const second = replacementEditEntry(3, 0, a.id, null);
		const third = replacementEditEntry(4, 0, a.id, { content: 'v2' });

		const afterFirst = buildProjection([a, b, c, first]);
		expect(afterFirst.segments.map((s) => s.entryId)).toEqual([a.id, b.id, c.id]);
		expect(afterFirst.segments[0]!.byteLen).toBe(bytes('v1'));

		// The omission hides the target but the member stays a window slot...
		const afterSecond = buildProjection([a, b, c, first, second]);
		expect(afterSecond.segments.map((s) => s.entryId)).toEqual([b.id, c.id]);

		// ...so the newest replacement resurrects it AT ITS ORIGINAL POSITION.
		const afterThird = buildProjection([a, b, c, first, second, third]);
		expect(afterThird.segments.map((s) => s.entryId)).toEqual([a.id, b.id, c.id]);
		expect(afterThird.segments[0]!.byteLen).toBe(bytes('v2'));
		expect(afterThird.edits).toEqual({ [a.id]: { editEntryId: third.id, action: 'replace' } });
	});

	it('a later replacement after a plain omission also resurrects at the original position', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.user', { text: 'b' }, 1, 1);
		const omission = replacementEditEntry(2, 0, a.id, null);
		const restore = replacementEditEntry(3, 0, a.id, { content: 'back' });
		const manifest = buildProjection([a, b, omission, restore]);

		expect(manifest.segments.map((s) => s.entryId)).toEqual([a.id, b.id]);
		expect(manifest.segments[0]!.byteLen).toBe(bytes('back'));
	});

	it('is inert for a target outside the window (never projected, cut, or pruned)', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const unknownEdit = replacementEditEntry(2, 0, 'never-projected', { content: 'x' });
		const inert = buildProjection([a, unknownEdit]);
		expect(inert.segments.map((s) => s.entryId)).toEqual([a.id]);
		expect(inert.edits).toBeUndefined();

		// Cut by a compaction: pi applies an edit only when its target is projected.
		const b = llmEntry('pi.user', { text: 'b' }, 1, 1);
		const cut = compactionEntry(2, 0, 'summary', b.id);
		const lateEdit = replacementEditEntry(3, 0, a.id, { content: 'x' });
		const manifest = buildProjection([a, b, cut, lateEdit]);
		expect(manifest.segments.map((s) => s.entryId)).toEqual([b.id]);
		expect(manifest.edits).toBeUndefined();
	});

	it('a strict prune removes the member outright: a later pi edit of a pruned id is inert', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const prune = { ...replacementEditEntry(2, 0, a.id, null), payload: { removedEntryIds: [a.id] } };
		const later = replacementEditEntry(3, 0, a.id, { content: 'x' });
		const manifest = buildProjection([a, prune, later]);
		expect(manifest.segments).toEqual([]);
		expect(manifest.edits).toEqual({});
	});

	it('editCount counts view-changing edit entries and drives the edits record', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const state: ProjectionState = foldAll([
			a,
			replacementEditEntry(2, 0, a.id, null),
			replacementEditEntry(3, 0, 'unknown', { content: 'x' }),
		]);
		expect(state.editCount).toBe(1);
	});
});

describe('fold: edits composed with compaction and usage', () => {
	it('retain-none (null firstKeptEntryId) cuts every segment', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.user', { text: 'b' }, 1, 1);
		const cut = retainNoneCompactionEntry(2, 0, 'fresh start');
		const after = llmEntry('pi.assistant', { text: 'after' }, 3, 0);
		const manifest = buildProjection([a, b, cut, after]);

		expect(manifest.segments.map((s) => s.entryId)).toEqual([after.id]);
		expect(manifest.windowBytes).toBe(bytes(after.payload));
		expect(manifest.compaction).toEqual({ summary: 'fresh start', firstKeptEntryId: null });
		// The usage anchor never regresses, even when its segment was cut.
		expect(manifest.usageAnchor).toBe(after.id);
	});

	it("pi's on-disk retain-none spelling (the compaction's own id) also cuts everything", () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const cut = retainNoneCompactionEntry(2, 0, 'self');
		const selfRef = { ...cut, payload: { summary: 'self', firstKeptEntryId: cut.id } };
		const manifest = buildProjection([a, selfRef]);
		expect(manifest.segments).toEqual([]);
		expect(manifest.compaction).toEqual({ summary: 'self', firstKeptEntryId: null });
	});

	it("a hidden member may serve as firstKeptEntryId (pi cuts on path entries, not visible messages)", () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.user', { text: 'b' }, 1, 1);
		const c = llmEntry('pi.user', { text: 'c' }, 1, 2);
		const hideB = replacementEditEntry(2, 0, b.id, null);
		const cut = compactionEntry(3, 0, 'from b', b.id);
		const manifest = buildProjection([a, b, c, hideB, cut]);

		// b stays a window member (it IS the first kept one) but remains hidden
		// by its winning edit — pi projects exactly the same way.
		expect(manifest.segments.map((s) => s.entryId)).toEqual([c.id]);
		expect(manifest.windowBytes).toBe(bytes(c.payload));
		expect(manifest.compaction).toEqual({ summary: 'from b', firstKeptEntryId: b.id });

		// The member survives the cut, so a NEWEST replacement resurrects it.
		const restore = replacementEditEntry(4, 0, b.id, { content: 'back' });
		const after = buildProjection([a, b, c, hideB, cut, restore]);
		expect(after.segments.map((s) => s.entryId)).toEqual([b.id, c.id]);
		expect(after.segments[0]!.byteLen).toBe(bytes('back'));
	});

	it('usage entries never become segments nor move the anchor', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const usage = usageEntry(1, 1, 'context', 'anthropic', 'claude-3', {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
		});
		const manifest = buildProjection([a, usage]);
		expect(manifest.segments.map((s) => s.entryId)).toEqual([a.id]);
		expect(manifest.usageAnchor).toBe(a.id);
		expect(manifest.usage?.models['anthropic/claude-3']?.totalTokens).toBe(15);
	});

	it('audit entries stay invisible beside edits and usage', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const audit = auditEntry(1, 1);
		const manifest = buildProjection([a, audit]);
		expect(manifest.segments.map((s) => s.entryId)).toEqual([a.id]);
	});
});

describe('incremental application of pi edit/usage/retain-none commits', () => {
	it('stays byte-equal to a full rebuild after every commit', () => {
		const service = new ProjectionService();
		const log = [
			llmEntry('pi.user', { text: 'u1' }, 1, 0),
			llmEntry('pi.assistant', { text: 'a1' }, 1, 1),
			replacementEditEntry(2, 0, 'llm-1', { content: 'rewritten' }),
			usageEntry(2, 1, 'context', 'anthropic', 'claude-3', {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
			}),
			llmEntry('pi.user', { text: 'u2' }, 3, 0),
			replacementEditEntry(4, 0, 'llm-1', null),
			retainNoneCompactionEntry(5, 0, 'reset'),
			llmEntry('pi.user', { text: 'u3' }, 6, 0),
			replacementEditEntry(7, 0, 'llm-5', { content: [{ type: 'text', text: 't' }] }),
		];
		const commits = [
			[log[0]!, log[1]!],
			[log[2]!, log[3]!],
			[log[4]!],
			[log[5]!],
			[log[6]!],
			[log[7]!],
			[log[8]!],
		];
		let folded = 0;
		for (let seq = 1; seq <= commits.length; seq += 1) {
			service.apply(commitOf(seq, commits[seq - 1]!));
			folded += commits[seq - 1]!.length;
			expect(JSON.stringify(service.manifest())).toBe(JSON.stringify(buildProjection(log.slice(0, folded))));
		}
	});

	it('a failed apply leaves the state untouched (malformed pi edit payload)', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		service.apply(commitOf(1, [a]));
		const before = service.manifest();

		const badEdit = {
			...replacementEditEntry(2, 0, a.id, { content: 'x' }),
			payload: { targetId: a.id, replacement: { content: 42 } },
		};
		expect(() => service.apply(commitOf(2, [badEdit]))).toThrow(TypeError);
		expect(service.manifest()).toEqual(before);
		// The corrected commit applies at the same sequence.
		const good = replacementEditEntry(2, 0, a.id, { content: 'x' });
		service.apply(commitOf(2, [good]));
		expect(service.manifest().segments[0]!.byteLen).toBe(bytes('x'));
	});
});
