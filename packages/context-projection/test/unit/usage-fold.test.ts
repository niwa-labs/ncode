// Persisted usage fold of `mcode.usage` entries (W03 part B).
//
// pi folds usage per `provider/model` (coding-agent `usage-totals`) with the
// durable `harness/usage` arithmetic (`addUsage`: optional counters are added
// once either side reports them). Our fold keeps BOTH pi axes: `models` for
// billing parity and `categories` for the mcode separation of context spend
// from tool/summary/warm/branch usage. Totals survive compaction; the UI
// reads them off the manifest instead of scanning the log.

import { describe, expect, it } from 'vitest';

import {
	asUsagePayload,
	buildProjection,
	EMPTY_USAGE,
	ProjectionService,
	addUsageDelta,
	withUsageDelta,
	isUsageEmpty,
} from '../../src/index.js';
import { compactionEntry, commitOf, llmEntry, replacementEditEntry, usageEntry } from './helpers.js';

const delta = (over: Partial<Parameters<typeof usageEntry>[5]> = {}) => ({
	input: 10,
	output: 20,
	cacheRead: 30,
	cacheWrite: 40,
	totalTokens: 100,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	...over,
});

describe('asUsagePayload', () => {
	it('accepts the pinned UsageEntry payload shape', () => {
		const usage = delta();
		expect(asUsagePayload({ kind: 'context', provider: 'p', model: 'm', usage }, 'e1')).toEqual({
			kind: 'context',
			provider: 'p',
			model: 'm',
			usage,
		});
	});

	it('keeps the optional splits and note when present', () => {
		const parsed = asUsagePayload(
			{
				kind: 'cache_warm',
				provider: 'p',
				model: 'm',
				usage: delta({ cacheWrite1h: 7, reasoning: 5 }),
				note: 'warm',
			},
			'e1',
		);
		expect(parsed.usage.cacheWrite1h).toBe(7);
		expect(parsed.usage.reasoning).toBe(5);
		expect(parsed.note).toBe('warm');
	});

	it('rejects malformed payloads loudly', () => {
		const rejects: unknown[] = [
			undefined,
			null,
			'string',
			{},
			{ kind: '', provider: 'p', model: 'm', usage: delta() },
			{ kind: 'k', provider: '', model: 'm', usage: delta() },
			{ kind: 'k', provider: 'p', model: '', usage: delta() },
			{ kind: 'k', provider: 'p', model: 'm', usage: 'x' },
			{ kind: 'k', provider: 'p', model: 'm', usage: { ...delta(), input: 'x' } },
			{ kind: 'k', provider: 'p', model: 'm', usage: { ...delta(), cacheWrite1h: 'x' } },
			{ kind: 'k', provider: 'p', model: 'm', usage: { ...delta(), cost: {} } },
			{ kind: 'k', provider: 'p', model: 'm', usage: { ...delta(), cost: { ...delta().cost, total: 'x' } } },
			{ kind: 'k', provider: 'p', model: 'm', usage: delta(), note: 42 },
		];
		for (const payload of rejects) {
			expect(() => asUsagePayload(payload, 'e1')).toThrow(TypeError);
		}
	});
});

describe('usage fold arithmetic', () => {
	it('adds every counter; optional splits materialize once either side reports them', () => {
		const first = addUsageDelta(delta(), delta({ cacheWrite1h: 7 }));
		expect(first).toEqual({
			...delta({ input: 20, output: 40, cacheRead: 60, cacheWrite: 80, totalTokens: 200, cacheWrite1h: 7 }),
			cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 },
		});
		const second = addUsageDelta(first, delta({ reasoning: 5 }));
		expect(second.cacheWrite1h).toBe(7);
		expect(second.reasoning).toBe(5);
	});

	it('withUsageDelta is copy-on-write and keeps __proto__ a plain key', () => {
		const bucket = withUsageDelta(EMPTY_USAGE.models, 'p/m', delta());
		const next = withUsageDelta(bucket, '__proto__', delta());
		expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
		expect(Object.hasOwn(next, '__proto__')).toBe(true);
		expect(next['p/m']!.totalTokens).toBe(100);
		expect(Object.hasOwn(bucket, '__proto__')).toBe(false);
	});

	it('the empty fold is detected', () => {
		expect(isUsageEmpty(EMPTY_USAGE)).toBe(true);
		expect(
			isUsageEmpty({ models: withUsageDelta(EMPTY_USAGE.models, 'p/m', delta()), categories: {} }),
		).toBe(false);
	});
});

describe('usage fold in the projection', () => {
	it('accumulates per provider/model and per category', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const u1 = usageEntry(1, 1, 'context', 'anthropic', 'claude-3', delta());
		const u2 = usageEntry(2, 0, 'cache_warm', 'anthropic', 'claude-3', delta());
		const u3 = usageEntry(2, 1, 'context', 'openai', 'gpt-5', delta({ input: 1 }));
		const manifest = buildProjection([a, u1, u2, u3]);

		expect(manifest.segments.map((s) => s.entryId)).toEqual([a.id]);
		expect(manifest.usage?.models['anthropic/claude-3']?.totalTokens).toBe(200);
		expect(manifest.usage?.models['openai/gpt-5']?.input).toBe(1);
		expect(manifest.usage?.categories.context?.totalTokens).toBe(200);
		expect(manifest.usage?.categories.cache_warm?.totalTokens).toBe(100);
	});

	it('totals survive a compaction and edits; the manifest omits usage while empty', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const u = usageEntry(1, 1, 'context', 'anthropic', 'claude-3', delta());
		const manifest = buildProjection([a, u]);
		expect(manifest.usage?.models['anthropic/claude-3']?.totalTokens).toBe(100);

		// A retain-none compaction (the harshest cut) keeps the spend.
		const fresh = llmEntry('pi.user', { text: 'fresh' }, 3, 0);
		const cutAll = { ...compactionEntry(2, 0, 'reset', fresh.id), payload: { summary: 'reset', firstKeptEntryId: null } };
		const after = buildProjection([a, u, cutAll, fresh, replacementEditEntry(4, 0, fresh.id, null)]);
		expect(after.segments).toEqual([]);
		expect(after.usage?.models['anthropic/claude-3']?.totalTokens).toBe(100);
		expect(after.usage?.categories.context?.cost.total).toBe(10);

		expect(buildProjection([]).usage).toBeUndefined();
	});

	it('incremental apply stays byte-equal to a full rebuild with usage in the mix', () => {
		const service = new ProjectionService();
		const log = [
			llmEntry('pi.user', { text: 'u1' }, 1, 0),
			usageEntry(1, 1, 'context', 'anthropic', 'claude-3', delta()),
			usageEntry(2, 0, 'context', 'anthropic', 'claude-3', delta({ cacheWrite1h: 9 })),
			llmEntry('pi.assistant', { text: 'a1' }, 3, 0),
			usageEntry(4, 0, 'summary', 'openai', 'gpt-5', delta({ reasoning: 3 })),
		];
		service.apply(commitOf(1, [log[0]!, log[1]!]));
		service.apply(commitOf(2, [log[2]!]));
		service.apply(commitOf(3, [log[3]!]));
		service.apply(commitOf(4, [log[4]!]));
		expect(JSON.stringify(service.manifest())).toBe(JSON.stringify(buildProjection(log)));
	});

	it('a malformed usage payload fails the apply atomically', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		service.apply(commitOf(1, [a]));
		const before = service.manifest();
		const bad = { ...usageEntry(2, 0, 'context', 'p', 'm', delta()), payload: { kind: 'context' } };
		expect(() => service.apply(commitOf(2, [bad]))).toThrow(TypeError);
		expect(service.manifest()).toEqual(before);
	});

	it('usage entries in the resume capsule restore pre-slice spend wholesale', () => {
		const service = new ProjectionService();
		const early = usageEntry(1, 0, 'context', 'anthropic', 'claude-3', delta());
		const a = llmEntry('pi.assistant', { text: 'a' }, 2, 0);
		const b = llmEntry('pi.user', { text: 'b' }, 3, 0);
		const cut = compactionEntry(4, 0, 'summary of a', b.id);
		const late = usageEntry(5, 0, 'context', 'anthropic', 'claude-3', delta({ input: 1 }));
		service.apply(commitOf(1, [early]));
		service.apply(commitOf(2, [a]));
		service.apply(commitOf(3, [b]));
		service.apply(commitOf(4, [cut]));
		service.apply(commitOf(5, [late]));

		const capsule = service.capsule();
		expect(capsule.usage?.models['anthropic/claude-3']?.totalTokens).toBe(200);
		expect(capsule.editCount).toBeUndefined();

		// The retained slice starts at the compaction's first kept entry; the
		// pre-slice spend (the early usage entry) exists ONLY in the capsule.
		const resumed = ProjectionService.fromCapsule(capsule, [b, late]);
		expect(resumed.manifest().usage?.models['anthropic/claude-3']?.totalTokens).toBe(200);
		expect(resumed.capsule()).toEqual(capsule);
	});
});
