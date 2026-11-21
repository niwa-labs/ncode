// Edge cases of the wire compiler: empty input, giant input, invalid input,
// and the byte-for-byte determinism of the compiled body.
//
// The compiled body is the request payload: it must be newline-delimited JSON
// (one segment per line, no matter what the payload contains), it must be
// byte-identical across cache states, and the byte budget guard must report
// an EXACT per-entry breakdown before anything is handed out.

import { describe, expect, it } from 'vitest';

import {
	WireBudgetExceeded,
	WireCompilerError,
	compile,
	createLruSegmentCache,
} from '../../src/index.js';
import type { Entry } from '../../src/index.js';

/** One text entry with the given content. */
function text(entryId: string, content: string): Entry {
	return { entryId, kind: 'text', role: 'user', content };
}

/** Splits a compiled body into its JSONL records. */
function parseBody(body: Buffer): unknown[] {
	const text = body.toString('utf8');
	return text
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

describe('empty input', () => {
	it('compiles an empty manifest into an empty body', () => {
		const result = compile([], [], { maxBytes: 0, cache: createLruSegmentCache(8) });
		expect(result.totalBytes).toBe(0);
		expect(result.body.length).toBe(0);
		expect(result.segments).toEqual([]);
	});

	it('ignores entries the manifest does not reference', () => {
		const result = compile(
			[{ entryId: 'a' }],
			[text('a', 'kept'), text('b', 'not referenced')],
			{ maxBytes: 1 << 20, cache: createLruSegmentCache(8) },
		);
		expect(result.segments.map((stat) => stat.entryId)).toEqual(['a']);
		expect(result.body.toString('utf8')).toBe('{"role":"user","content":"kept"}\n');
	});
});

describe('NDJSON framing', () => {
	it('keeps a multi-line payload on exactly one line', () => {
		const result = compile(
			[{ entryId: 'a' }],
			[text('a', 'line1\nline2\r\nline3')],
			{ maxBytes: 1 << 20, cache: createLruSegmentCache(8) },
		);
		const body = result.body.toString('utf8');
		expect(body.endsWith('\n')).toBe(true);
		expect(body.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
		expect(parseBody(result.body)).toEqual([{ role: 'user', content: 'line1\nline2\r\nline3' }]);
	});

	it('keeps a lone surrogate well-formed JSON', () => {
		const result = compile(
			[{ entryId: 'a' }],
			[text('a', 'x\uD800y')],
			{ maxBytes: 1 << 20, cache: createLruSegmentCache(8) },
		);
		expect(() => parseBody(result.body)).not.toThrow();
		expect(result.body.toString('utf8')).toContain('\\ud800');
	});

	it('frames a payload with an embedded quote without breaking the line', () => {
		const result = compile(
			[{ entryId: 'a' }],
			[text('a', 'say "hi"')],
			{ maxBytes: 1 << 20, cache: createLruSegmentCache(8) },
		);
		expect(parseBody(result.body)).toEqual([{ role: 'user', content: 'say "hi"' }]);
	});
});

describe('byte-for-byte determinism', () => {
	it('produces the same bytes from a cold cache, a warm cache and a fresh cache', () => {
		const entries = [text('a', 'one'), text('b', 'two'), text('c', 'three')];
		const manifest = entries.map((entry) => ({ entryId: entry.entryId }));

		const warm = createLruSegmentCache(16);
		const cold = compile(manifest, entries, { maxBytes: 1 << 20, cache: warm });
		const rerun = compile(manifest, entries, { maxBytes: 1 << 20, cache: warm });
		const fresh = compile(manifest, entries, { maxBytes: 1 << 20, cache: createLruSegmentCache(16) });
		const rehashed = compile(manifest, entries, {
			maxBytes: 1 << 20,
			cache: warm,
			requireHashes: true,
		});

		expect(rerun.body.equals(cold.body)).toBe(true);
		expect(fresh.body.equals(cold.body)).toBe(true);
		expect(rehashed.body.equals(cold.body)).toBe(true);
		expect(rerun.totalBytes).toBe(cold.totalBytes);
		expect(rehashed.totalBytes).toBe(cold.totalBytes);
	});

	it('keeps the sha256 of a segment equal across cache states', () => {
		const entries = [text('a', 'one')];
		const manifest = [{ entryId: 'a' }];
		const cache = createLruSegmentCache(8);
		const cold = compile(manifest, entries, { maxBytes: 1 << 20, cache });
		const warm = compile(manifest, entries, { maxBytes: 1 << 20, cache, requireHashes: true });
		expect(warm.segments[0]!.sha256).toBe(cold.segments[0]!.sha256);
	});
});

describe('giant input', () => {
	it('rejects an oversized body with an exact per-entry breakdown', () => {
		const huge = 'x'.repeat(3_000_000);
		let caught: WireBudgetExceeded | undefined;
		try {
			compile([{ entryId: 'a' }], [text('a', huge)], {
				maxBytes: 1000,
				cache: createLruSegmentCache(8),
			});
		} catch (error) {
			caught = error as WireBudgetExceeded;
		}
		expect(caught).toBeInstanceOf(WireBudgetExceeded);
		expect(caught!.totalBytes).toBeGreaterThan(3_000_000);
		expect(caught!.maxBytes).toBe(1000);
		expect(caught!.breakdown).toEqual([{ entryId: 'a', bytes: caught!.totalBytes }]);
		// The breakdown is EXACT, not an estimate.
		expect(caught!.breakdown[0]!.bytes).toBe(caught!.totalBytes);
	});

	it('reports the per-entry breakdown in manifest order', () => {
		const entries = [text('a', 'aaaa'), text('b', 'bb'), text('c', 'c')];
		let caught: WireBudgetExceeded | undefined;
		try {
			compile(entries.map((entry) => ({ entryId: entry.entryId })), entries, {
				maxBytes: 1,
				cache: createLruSegmentCache(8),
			});
		} catch (error) {
			caught = error as WireBudgetExceeded;
		}
		expect(caught).toBeInstanceOf(WireBudgetExceeded);
		expect(caught!.breakdown.map((part) => part.entryId)).toEqual(['a', 'b', 'c']);
		expect(caught!.breakdown.reduce((sum, part) => sum + part.bytes, 0)).toBe(caught!.totalBytes);
	});

	it('compiles a giant body under the budget and keeps the byte axes aligned', () => {
		const huge = 'x'.repeat(1_000_000);
		const result = compile([{ entryId: 'a' }], [text('a', huge)], {
			maxBytes: 4 << 20,
			cache: createLruSegmentCache(8),
		});
		expect(result.totalBytes).toBe(result.body.length);
		expect(result.totalBytes).toBeGreaterThan(1_000_000);
		expect(result.segments).toHaveLength(1);
		expect(result.segments[0]!.bytes).toBe(result.totalBytes);
	});

	it('keeps the manifest order across a five-hundred-entry window', () => {
		const entries = Array.from({ length: 500 }, (_, index) =>
			text(`e${index}`, `content-${index}`),
		);
		const manifest = entries.map((entry) => ({ entryId: entry.entryId }));
		const result = compile(manifest, entries, {
			maxBytes: 1 << 20,
			cache: createLruSegmentCache(1024),
		});

		expect(result.segments.map((stat) => stat.entryId)).toEqual(
			entries.map((entry) => entry.entryId),
		);
		const lines = parseBody(result.body);
		expect(lines).toHaveLength(500);
		expect(lines[0]).toEqual({ role: 'user', content: 'content-0' });
		expect(lines[499]).toEqual({ role: 'user', content: 'content-499' });
		expect(result.totalBytes).toBe(result.body.length);
	});
});

describe('invalid input', () => {
	it('rejects a non-sensible byte budget', () => {
		for (const maxBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				compile([{ entryId: 'a' }], [text('a', 'x')], {
					maxBytes,
					cache: createLruSegmentCache(8),
				}),
			).toThrow(RangeError);
		}
	});

	it('rejects a duplicate entry id, a duplicate manifest reference and an unknown reference', () => {
		const cache = createLruSegmentCache(8);
		expect(() =>
			compile([{ entryId: 'a' }], [text('a', 'x'), text('a', 'y')], { maxBytes: 1 << 20, cache }),
		).toThrow(WireCompilerError);
		expect(() =>
			compile([{ entryId: 'a' }, { entryId: 'a' }], [text('a', 'x')], { maxBytes: 1 << 20, cache }),
		).toThrow(WireCompilerError);
		expect(() =>
			compile([{ entryId: 'missing' }], [text('a', 'x')], { maxBytes: 1 << 20, cache }),
		).toThrow(WireCompilerError);
	});

	it('rejects an entry kind the dialect does not know', () => {
		const bogus = { entryId: 'a', kind: 'not-a-kind' } as unknown as Entry;
		expect(() =>
			compile([{ entryId: 'a' }], [bogus], {
				maxBytes: 1 << 20,
				cache: createLruSegmentCache(8),
			}),
		).toThrow(WireCompilerError);
	});

	it('rejects a dialect that normalizes an entry to undefined', () => {
		expect(() =>
			compile([{ entryId: 'a' }], [text('a', 'x')], {
				maxBytes: 1 << 20,
				cache: createLruSegmentCache(8),
				dialect: {
					name: 'broken',
					normalizerVersion: '1',
					normalizeEntry: () => undefined as never,
				},
			}),
		).toThrow(WireCompilerError);
	});
});

describe('cache isolation', () => {
	it('keeps two dialects of the same entry id apart', () => {
		const entries = [text('a', 'shared')];
		const cache = createLruSegmentCache(8);
		const first = compile([{ entryId: 'a' }], entries, {
			maxBytes: 1 << 20,
			cache,
			dialect: { name: 'dialect-a', normalizerVersion: '1', normalizeEntry: () => ({ role: 'user', content: 'A' }) },
		});
		const second = compile([{ entryId: 'a' }], entries, {
			maxBytes: 1 << 20,
			cache,
			dialect: { name: 'dialect-b', normalizerVersion: '1', normalizeEntry: () => ({ role: 'user', content: 'B' }) },
		});

		expect(first.segments[0]!.cacheHit).toBe(false);
		expect(second.segments[0]!.cacheHit).toBe(false);
		expect(first.body.toString('utf8')).toBe('{"role":"user","content":"A"}\n');
		expect(second.body.toString('utf8')).toBe('{"role":"user","content":"B"}\n');
	});
});
