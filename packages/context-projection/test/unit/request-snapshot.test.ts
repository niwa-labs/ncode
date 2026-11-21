// C3: ProjectionRevision → RequestSnapshot (W03 part B closes the named
// boundary contract — `boundary-contracts.md` C3).
//
// Invariants under test:
//   1. ONE immutable snapshot per logical request: every field deep-frozen;
//      a mutation attempt throws. Over the service's revision-cached
//      manifest the snapshot SHARES the frozen segment array (freezing is
//      the isolation); over a plain mutable manifest it still copies.
//      Revision identity, not object identity, is the address — the runtime
//      calls snapshot() once per logical request.
//   2. Concurrent input/compaction create the NEXT revision: commits applied
//      after the snapshot never change it — not the manifest bytes, not the
//      window middle.
//   3. The snapshot is bounded (the manifest window) and carries a
//      deterministic token estimate; routing/session/request ids ride along.

import { describe, expect, it } from 'vitest';

import {
	PROJECTION_SCHEMA_VERSION,
	ProjectionService,
	deepFreeze,
	estimateTokens,
} from '../../src/index.js';
import type { ContextManifest } from '../../src/index.js';
import { commitOf, llmEntry, replacementEditEntry, retainNoneCompactionEntry, usageEntry } from './helpers.js';

describe('estimateTokens', () => {
	it('is Σ ceil(byteLen / 4), deterministic', () => {
		const segments = [
			{ entryId: 'a', byteLen: 10, kind: 'pi.user' },
			{ entryId: 'b', byteLen: 8, kind: 'pi.user' },
			{ entryId: 'c', byteLen: 1, kind: 'pi.user' },
		];
		expect(estimateTokens(segments)).toBe(3 + 2 + 1);
		expect(estimateTokens([])).toBe(0);
	});
});

describe('deepFreeze', () => {
	it('freezes nested structures and tolerates re-freezing shared ones', () => {
		const shared = { x: 1 };
		const value = deepFreeze({ a: [shared], b: { c: shared } });
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.a)).toBe(true);
		expect(Object.isFrozen(shared)).toBe(true);
		expect(() => {
			(value as { a: unknown[] }).a.push(1);
		}).toThrow();
	});
});

describe('ProjectionService.revision', () => {
	it('addresses the fold state with head/watermark/schema/edit/window components', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		service.apply(commitOf(1, [a]));

		const revision = service.revision({ conversationId: 'conv-1', rootId: 'root-1' });
		expect(revision).toEqual({
			conversationId: 'conv-1',
			rootId: 'root-1',
			head: 1,
			watermark: { seq: 1, ordinal: 0 },
			schemaVersion: PROJECTION_SCHEMA_VERSION,
			editVersion: 0,
			windowBytes: Buffer.byteLength(JSON.stringify(a.payload), 'utf8'),
		});
		expect(PROJECTION_SCHEMA_VERSION).toBe(2);
	});

	it('two services folding the same log produce equal revisions', () => {
		const log = [llmEntry('pi.user', { text: 'u' }, 1, 0), replacementEditEntry(2, 0, 'llm-1', null)];
		const first = new ProjectionService();
		const second = new ProjectionService();
		for (const [seq, entries] of [[1, [log[0]!]], [2, [log[1]!]]] as const) {
			first.apply(commitOf(seq, entries));
			second.apply(commitOf(seq, entries));
		}
		expect(first.revision({ conversationId: 'c', rootId: 'r' })).toEqual(
			second.revision({ conversationId: 'c', rootId: 'r' }),
		);
	});
});

describe('ProjectionService.snapshot (C3)', () => {
	it('builds one deep-frozen immutable snapshot per call', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		service.apply(commitOf(1, [a]));

		const snapshot = service.snapshot({
			conversationId: 'conv-1',
			rootId: 'root-1',
			requestId: 'req-1',
			sessionId: 'sess-1',
			route: { provider: 'anthropic', modelId: 'claude-3' },
			createdAtMs: 42,
		});

		expect(snapshot.requestId).toBe('req-1');
		expect(snapshot.sessionId).toBe('sess-1');
		expect(snapshot.route).toEqual({ provider: 'anthropic', modelId: 'claude-3' });
		expect(snapshot.createdAtMs).toBe(42);
		expect(snapshot.tokenEstimate).toBe(estimateTokens(snapshot.manifest.segments));
		expect(snapshot.revision.conversationId).toBe('conv-1');
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.revision)).toBe(true);
		expect(Object.isFrozen(snapshot.manifest)).toBe(true);
		expect(Object.isFrozen(snapshot.manifest.segments[0])).toBe(true);
		expect(() => {
			(snapshot.manifest as unknown as { segments: unknown[] }).segments.push({});
		}).toThrow();
		expect(() => {
			(snapshot.manifest.segments[0] as { byteLen: number }).byteLen = 999;
		}).toThrow();
		// The service's own manifest() is the revision's frozen cache too: the
		// snapshot SHARES its segment array with the cache instead of copying
		// it (freezing is the isolation), so same-head reads copy zero refs.
		const serviceManifest = service.manifest();
		expect(Object.isFrozen(serviceManifest)).toBe(true);
		expect(snapshot.manifest.segments).toBe(serviceManifest.segments);
	});

	it('concurrent input and compaction create the NEXT revision; the sent body never changes', () => {
		const service = new ProjectionService();
		const u1 = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const a1 = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		service.apply(commitOf(1, [u1, a1]));

		const inFlight = service.snapshot({
			conversationId: 'conv',
			rootId: 'root',
			requestId: 'req-1',
			sessionId: 'sess',
			createdAtMs: 1,
		});
		const bodyBytes = JSON.stringify(inFlight.manifest);

		// Concurrent input lands while the request is being sent.
		const steered = llmEntry('pi.user', { text: 'steer' }, 2, 0);
		service.apply(commitOf(2, [steered]));
		// A compaction lands too.
		service.apply(commitOf(3, [retainNoneCompactionEntry(3, 0, 'reset')]));
		// And an edit + usage for good measure.
		const fresh = llmEntry('pi.user', { text: 'fresh' }, 4, 0);
		service.apply(commitOf(4, [fresh, replacementEditEntry(4, 1, fresh.id, null)]));

		// The in-flight snapshot is untouched.
		expect(JSON.stringify(inFlight.manifest)).toBe(bodyBytes);
		expect(inFlight.revision.head).toBe(1);
		expect(inFlight.revision.editVersion).toBe(0);

		// The next logical request addresses the NEXT revision.
		const next = service.snapshot({
			conversationId: 'conv',
			rootId: 'root',
			requestId: 'req-2',
			sessionId: 'sess',
			createdAtMs: 2,
		});
		expect(next.revision.head).toBe(4);
		expect(next.revision.editVersion).toBe(1);
		expect(next.revision.windowBytes).toBe(0); // the only member was omitted
		expect(next.manifest.segments).toEqual([]);
		expect(next.revision).not.toEqual(inFlight.revision);
	});

	it('rejects empty identity fields loudly', () => {
		const service = new ProjectionService();
		const base = { rootId: 'r', requestId: 'q', sessionId: 's' } as const;
		expect(() => service.snapshot({ ...base, conversationId: '' })).toThrow(TypeError);
		expect(() =>
			service.snapshot({ conversationId: 'c', requestId: 'q', sessionId: 's', rootId: '' }),
		).toThrow(TypeError);
	});

	it('a snapshot without a route carries null, not undefined', () => {
		const service = new ProjectionService();
		service.apply(commitOf(1, [llmEntry('pi.user', { text: 'a' }, 1, 0)]));
		const snapshot = service.snapshot({
			conversationId: 'c',
			rootId: 'r',
			requestId: 'q',
			sessionId: 's',
			createdAtMs: 0,
		});
		expect(snapshot.route).toBeNull();
		expect(JSON.parse(JSON.stringify(snapshot)).route).toBeNull();
	});

	it('usage rides along on the snapshot manifest (readers never scan the log)', () => {
		const service = new ProjectionService();
		service.apply(
			commitOf(1, [
				llmEntry('pi.user', { text: 'a' }, 1, 0),
				usageEntry(1, 1, 'context', 'anthropic', 'claude-3', {
					input: 5,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				}),
			]),
		);
		const snapshot = service.snapshot({
			conversationId: 'c',
			rootId: 'r',
			requestId: 'q',
			sessionId: 's',
			createdAtMs: 0,
		});
		expect(snapshot.manifest.usage?.models['anthropic/claude-3']?.totalTokens).toBe(10);
		expect(Object.isFrozen(snapshot.manifest.usage?.models)).toBe(true);
	});
});

describe('snapshot equality across paths (C3 + fold)', () => {
	it('a resumed service produces the same revision and snapshot manifest bytes', () => {
		const first = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.user', { text: 'b' }, 2, 0);
		const edit = replacementEditEntry(3, 0, a.id, { content: 'fixed' });
		first.apply(commitOf(1, [a]));
		first.apply(commitOf(2, [b]));
		first.apply(commitOf(3, [edit]));

		const capsule = first.capsule();
		const resumed = ProjectionService.fromCapsule(capsule, [a, b, edit]);

		const identity = { conversationId: 'c', rootId: 'r' } as const;
		expect(resumed.revision(identity)).toEqual(first.revision(identity));
		const manifestOf = (m: ContextManifest) => JSON.stringify(m);
		expect(
			manifestOf(
				resumed.snapshot({ ...identity, requestId: 'q', sessionId: 's', createdAtMs: 0 }).manifest,
			),
		).toBe(manifestOf(first.snapshot({ ...identity, requestId: 'q', sessionId: 's', createdAtMs: 0 }).manifest));
	});
});
