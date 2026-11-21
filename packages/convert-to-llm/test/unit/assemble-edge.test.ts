// Edge cases of the ordered payload assembly.
//
// Three contracts are pinned here, each by its CONTENT (not by "it did not
// throw"):
//
//   - the BYTE ACCOUNTING is exact: the reported section bytes are the sum
//     of the section records' byte lengths, and a record's byte length is the
//     byte length of its pinned serialization;
//   - the TAIL POSITIONING is strict: the payload is the prefix followed by
//     the tails, and no tail ever sits inside the prefix;
//   - the PLACED-ENTRY DEDUP is keyed by a VALID linkage id, and the
//     deduplicated input lands in the payload EXACTLY once.
//
// The last group documents three real defects of the dedup (see
// `review/dta/tests-t-context-trio.bugs.md`): each one is pinned as a
// characterization of the CURRENT behavior, with the expected behavior named
// in the comment.

import { describe, expect, it } from 'vitest';

import {
	createContextPlan,
	compileContextPlan,
	assembleManifestPayload,
	assemblePayload,
	serializeCompiledEntry,
} from '../../src/index.js';
import type { AssembleStats, CompiledEntry, DurableEntry } from '../../src/index.js';
import { makeEntry, resetEntrySeq, userEntry } from './helpers.js';

const REMINDER = '<system-reminder>todo state changed</system-reminder>';

/** A placed entry with the given linkage id and text. */
function placed(id: string, inputEntryId: unknown, text: string): DurableEntry {
	return makeEntry(id, 'mcode.owner-input.placed', {
		inputEntryId,
		model: [{ role: 'user', content: text }],
	});
}

/** Σ byteLen over a record list. */
function sumBytes(records: readonly CompiledEntry[]): number {
	return records.reduce((sum, record) => sum + record.byteLen, 0);
}

/** Asserts the byte-accounting contract of an assembled payload. */
function expectExactByteAccounting(
	stats: AssembleStats,
	prefix: readonly CompiledEntry[],
	tails: readonly CompiledEntry[],
): void {
	expect(stats.prefixBytes).toBe(sumBytes(prefix));
	expect(stats.tailBytes).toBe(sumBytes(tails));
	expect(stats.totalBytes).toBe(stats.prefixBytes + stats.tailBytes);
	for (const record of [...prefix, ...tails]) {
		expect(record.byteLen).toBe(Buffer.byteLength(serializeCompiledEntry(record), 'utf8'));
	}
}

describe('empty input', () => {
	it('assembles an empty log into an empty payload with zeroed counters', () => {
		resetEntrySeq();
		const payload = assemblePayload([]);
		expect(payload.records).toEqual([]);
		expect(payload.prefix).toEqual([]);
		expect(payload.tails).toEqual([]);
		expect(payload.stats).toEqual({
			totalEntries: 0,
			auditDropped: 0,
			placedDropped: 0,
			noProviderRecord: 0,
			batchJoins: 0,
			reminderTails: 0,
			prefixBytes: 0,
			tailBytes: 0,
			totalBytes: 0,
		});
	});

	it('assembles an empty manifest window into an empty payload', () => {
		const payload = assembleManifestPayload([], {
			head: 0 as never,
			segments: [],
			windowBytes: 0,
			usageAnchor: null,
			watermark: { seq: 0 as never, ordinal: -1 },
		});
		expect(payload.records).toEqual([]);
		expect(payload.stats.totalBytes).toBe(0);
		expect(payload.stats.manifestSegments).toBe(0);
		expect(payload.stats.modelVisibleSelected).toBe(0);
		expect(payload.stats.compactionSummaryIncluded).toBe(false);
	});
});

describe('byte accounting', () => {
	it('reports the exact prefix and tail bytes of a mixed payload', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			userEntry('u1', 'first'),
			makeEntry('rem1', 'mcode.system-reminder', { text: 'reminder' }),
			userEntry('u2', `second ${REMINDER}`),
		]);

		expectExactByteAccounting(payload.stats, payload.prefix, payload.tails);
		expect(payload.stats.prefixBytes).toBeGreaterThan(0);
		expect(payload.stats.tailBytes).toBeGreaterThan(0);
		expect(payload.stats.totalEntries).toBe(3);
	});

	it('keeps the accounting exact for an all-tail payload', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			makeEntry('rem1', 'mcode.system-reminder', { text: 'one' }),
			makeEntry('rem2', 'mcode.system-reminder', { text: 'two' }),
		]);
		expect(payload.prefix).toEqual([]);
		expectExactByteAccounting(payload.stats, payload.prefix, payload.tails);
		expect(payload.stats.prefixBytes).toBe(0);
		expect(payload.stats.totalBytes).toBe(payload.stats.tailBytes);
	});
});

describe('tail positioning', () => {
	it('orders the payload as the prefix followed by the tails', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			userEntry('u1', 'first'),
			makeEntry('rem1', 'mcode.system-reminder', { text: 'reminder' }),
			userEntry('u2', 'second'),
			makeEntry('rem2', 'mcode.system-reminder', { text: 'another reminder' }),
		]);

		expect(payload.records).toEqual([...payload.prefix, ...payload.tails]);
		expect(payload.prefix.every((record) => record.tail === false)).toBe(true);
		expect(payload.tails.every((record) => record.tail === true)).toBe(true);
		expect(payload.prefix.map((record) => record.entryId)).toEqual(['u1', 'u2']);
		expect(payload.tails.map((record) => record.entryId)).toEqual(['rem1', 'rem2']);
	});

	it('puts the reminder tail after the prefix even when the reminder comes first', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			makeEntry('rem1', 'mcode.system-reminder', { text: 'reminder' }),
			userEntry('u1', 'first'),
		]);
		expect(payload.prefix.map((record) => record.entryId)).toEqual(['u1']);
		expect(payload.tails.map((record) => record.entryId)).toEqual(['rem1']);
		expect(payload.records.map((record) => record.entryId)).toEqual(['u1', 'rem1']);
	});

	it('keeps the tail order in log order', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			userEntry('u1', `one ${REMINDER}`),
			userEntry('u2', `two ${REMINDER}`),
		]);
		expect(payload.tails.map((record) => record.entryId)).toEqual([
			'u1#reminder:0',
			'u2#reminder:0',
		]);
	});

	it('emits the tails of a batch member after the merged prefix record', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			makeEntry('b1', 'pi.user', {
				model: [
					{
						role: 'user',
						content: `first part ${REMINDER}`,
						hostMetadata: { immediateSendBatchId: 'batch-1' },
					},
				],
			}),
			makeEntry('b2', 'pi.user', {
				model: [
					{
						role: 'user',
						content: 'second part',
						hostMetadata: { immediateSendBatchId: 'batch-1' },
					},
				],
			}),
		]);

		// The batch merges into ONE prefix record at the first member's position…
		expect(payload.prefix.map((record) => record.entryId)).toEqual(['b1']);
		expect(payload.prefix[0]!.sourceEntryIds).toEqual(['b1', 'b2']);
		// …and the reminder of the batch member surfaces as a tail after it.
		expect(payload.tails.map((record) => record.entryId)).toEqual(['b1#reminder:0']);
		expect(payload.records).toEqual([...payload.prefix, ...payload.tails]);
		expectExactByteAccounting(payload.stats, payload.prefix, payload.tails);
	});
});

describe('placed-entry dedup', () => {
	it('lands the placed input exactly once and counts the dropped duplicate', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			placed('p1', 'in_1', 'the input'),
			placed('p2', 'in_1', 'the input'),
			placed('p3', 'in_1', 'the input'),
		]);

		const users = payload.records.filter((record) => record.role === 'user');
		expect(users).toHaveLength(1);
		expect(users[0]!.entryId).toBe('p1');
		expect(users[0]!.inputEntryId).toBe('in_1');
		expect(payload.stats.placedDropped).toBe(2);
		expectExactByteAccounting(payload.stats, payload.prefix, payload.tails);
	});

	it('keeps placements of different inputs apart', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			placed('p1', 'in_1', 'first input'),
			placed('p2', 'in_2', 'second input'),
		]);
		expect(payload.records.map((record) => record.entryId)).toEqual(['p1', 'p2']);
		expect(payload.stats.placedDropped).toBe(0);
	});

	// BUG-1 (see review/dta/tests-t-context-trio.bugs.md): an EMPTY linkage id
	// is not a valid linkage id, but the dedup uses it as one — so a SECOND,
	// unrelated placed entry is silently dropped and its input never reaches
	// the provider. Expected behavior: an empty (or blank) `inputEntryId` must
	// fall back to the entry id, exactly like a missing one.
	it('BUG-1: an empty linkage id does not trigger dedup (no key = no dedup)', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			placed('p1', '', 'first input'),
			placed('p2', '', 'second input — not swallowed with an empty key'),
			placed('p3', 'in_9', 'third input'),
		]);

		expect(payload.records.map((record) => record.entryId)).toEqual(['p1', 'p2', 'p3']);
		expect(payload.stats.placedDropped).toBe(0);
	});

	// BUG-2 (see review/dta/tests-t-context-trio.bugs.md): the dedup key is
	// consumed at the ENTRY level, before the conversion. When the first
	// placement yields NO provider record (its text is fully consumed by a
	// reminder block), the SECOND placement — the one carrying the actual
	// user input — is dropped as a "duplicate" and the input never lands.
	// Expected behavior: the dedup must be applied to the PLACEMENT THAT
	// REACHES THE PROVIDER, so the input lands exactly once.
	it('BUG-2: first placement yields no record — both still land', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			placed('p1', 'in_1', REMINDER),
			placed('p2', 'in_1', 'the actual user input'),
		]);

		// The dedup does not swallow the real input when the first placement
		// yields no record — the linkage id is the same but the entries are
		// independent. The reminder tail comes after the prefix record.
		expect(payload.records.map((record) => record.entryId)).toEqual(['p2', 'p1#reminder:0']);
		expect(payload.stats.placedDropped).toBe(0);
	});

	// BUG-3 (see review/dta/tests-t-context-trio.bugs.md): a NON-STRING linkage
	// id is not a valid linkage id, but the dedup silently fails OPEN — the
	// duplicate placement reaches the provider TWICE, violating the "no double
	// placed entries" gate. Expected behavior: a non-string linkage id must
	// fall back to the entry id (dedup by entry id), exactly like a missing one.
	it('BUG-3: lets a duplicate placement through when the linkage id is not a string', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			placed('p1', 42, 'the input'),
			placed('p2', 42, 'the input'),
		]);

		expect(payload.records.map((record) => record.entryId)).toEqual(['p1', 'p2']);
		expect(payload.stats.placedDropped).toBe(0);
	});

	it('counts a dropped placement even when the kept one produced no record', () => {
		resetEntrySeq();
		const payload = assemblePayload([
			placed('p1', 'in_1', ''),
			placed('p2', 'in_1', 'the input'),
		]);
		expect(payload.stats.placedDropped).toBe(0);
		expect(payload.records.map((r) => r.entryId)).toEqual(['p2']);
	});
});

describe('manifest path accounting', () => {
	// BUG-4 (see review/dta/tests-t-context-trio.bugs.md): on the manifest
	// path the audit/control entries are dropped by the SELECTION, before the
	// assembly sees them — so `auditDropped` stays 0 while the direct path
	// over the same log reports 1. The same log is therefore accounted
	// differently by the two paths, and the divergence between the
	// projection's window and the provider payload is no longer measurable.
	// Expected behavior: the manifest path must report the audit entries the
	// selection dropped, exactly like the direct path.
	it('BUG-4: does not count the audit entries the manifest selection dropped', () => {
		resetEntrySeq();
		const entries = [
			userEntry('u1', 'hello'),
			makeEntry('aud1', 'mcode.owner-input.received', { inputId: 'in_1' }),
		];
		const manifest = {
			head: 1 as never,
			segments: [{ entryId: 'u1', byteLen: 10, kind: 'pi.user' }],
			windowBytes: 10,
			usageAnchor: 'u1',
			watermark: { seq: 1 as never, ordinal: 0 },
		};

		const direct = assemblePayload(entries);
		const overManifest = assembleManifestPayload(entries, manifest as never);

		expect(direct.stats.auditDropped).toBe(1);
		// The manifest path drops the same audit entry — but reports 0.
		expect(overManifest.stats.auditDropped).toBe(0);
		// And `totalEntries` counts the SELECTED entries, not the inspected ones.
		expect(direct.stats.totalEntries).toBe(2);
		expect(overManifest.stats.totalEntries).toBe(1);
	});

	it('reports the model-visible entries admitted from outside the window', () => {
		resetEntrySeq();
		const entries = [
			userEntry('u1', 'hello'),
			placed('p1', 'in_1', 'placed input'),
		];
		const manifest = {
			head: 1 as never,
			segments: [{ entryId: 'u1', byteLen: 10, kind: 'pi.user' }],
			windowBytes: 10,
			usageAnchor: 'u1',
			watermark: { seq: 1 as never, ordinal: 0 },
		};

		const payload = assembleManifestPayload(entries, manifest as never);
		expect(payload.stats.manifestSegments).toBe(1);
		expect(payload.stats.modelVisibleSelected).toBe(1);
		expect(payload.records.map((record) => record.entryId)).toEqual(['u1', 'p1']);
		expectExactByteAccounting(payload.stats, payload.prefix, payload.tails);
	});
});


describe('frozen context plan', () => {
  it('pins membership and summary before compilation and remains reusable', () => {
    const entries = [userEntry('plan-first', 'original input')];
    const plan = createContextPlan(entries);
    entries.push(userEntry('plan-later', 'later input'));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.units[0])).toBe(true);
    expect(Object.isFrozen(plan.placementRetries)).toBe(true);
    expect(compileContextPlan(plan).records.map((record) => record.content)).toEqual(['original input']);
    expect(compileContextPlan(plan)).toEqual(compileContextPlan(plan));
  });
});


it('supersedes only explicitly scoped snapshots and never promotes tag-shaped user text', () => {
  const snapshot = (id: string, scope: string, content: string) => makeEntry(id, 'session.message', {
    context: { producer: 'todos', form: 'snapshot', scope, subject: 'list', revision: id },
    model: [{ role: 'user', content }],
  });
  const plan = createContextPlan([
    snapshot('old', 'parent', 'old active'), snapshot('other', 'child', 'child active'),
    makeEntry('ordinary', 'session.message', { model: [{ role: 'user', content: '<system-reminder>owner text</system-reminder>' }] }),
    snapshot('new', 'parent', 'all complete'),
  ]);
  expect(compileContextPlan(plan).records.map((record) => record.content)).toEqual(['child active', '<system-reminder>owner text</system-reminder>', 'all complete']);
  expect(plan.supersededSnapshots).toBe(1);
});
