/**
 * The trio contract: `context-projection` → `convert-to-llm` → `wire-compiler`.
 *
 * The three packages form ONE pipeline, but each pins only its own side:
 * the projection pins the derived window, convert-to-llm pins the ordered
 * provider records, and the wire compiler pins the request bytes. This file
 * pins the SEAMS:
 *
 * - the projection's window ORDER is the payload's prefix order, and the
 *   payload's order is the wire body's line order;
 * - the audit/control kinds never reach the wire body;
 * - the reminder tails are positioned AFTER the prefix in the wire body;
 * - the compaction summary is the LEADING wire record;
 * - the two byte axes are DIFFERENT on purpose: the projection's
 *   `windowBytes` measures the RAW STORED payload, the wire body measures the
 *   OUTGOING provider bytes — a consumer must not mix them up;
 * - the whole pipeline is byte-for-byte deterministic, and the derived window
 *   does not depend on the writer's batch grouping.
 */

import { describe, expect, it } from 'vitest';

import { ProjectionService, buildProjection } from '../../../context-projection/src/index.js';
import type { ContextManifest } from '../../../context-projection/src/index.js';
import { assembleManifestPayload, serializeCompiledEntry } from '../../../convert-to-llm/src/index.js';
import type { DurableEntry } from '../../../convert-to-llm/src/index.js';
import type { Entry as BackendEntry } from '../../../durable-backend-sqlite-zstd/src/types.js';
import {
	compile,
	compiledEntryToWireEntry,
	compiledRecordDialect,
	createLruSegmentCache,
} from '../../src/index.js';

const REMINDER = '<system-reminder>todo state changed</system-reminder>';

/** Monotonic ordinal so the projection fold sees a strictly advancing log position. */
let ordinalCounter = 0;
function nextOrdinal(): number {
	ordinalCounter += 1;
	return ordinalCounter - 1;
}

/** The projection folds backend `Entry` values (branded `Seq`); cast the fixtures. */
function project(entries: readonly DurableEntry[]): ContextManifest {
	return buildProjection(entries as unknown as readonly BackendEntry[]);
}

/** A user entry in the pi-durable `{model:[message]}` convention. */
function user(id: string, text: string): DurableEntry {
	return {
		id,
		kind: 'pi.user',
		payload: { model: [{ role: 'user', content: text }] },
		seq: 1,
		ordinal: nextOrdinal(),
		parentId: null,
	};
}

/** An assistant entry with a text block. */
function assistant(id: string, text: string): DurableEntry {
	return {
		id,
		kind: 'pi.assistant',
		payload: { model: [{ role: 'assistant', content: [{ type: 'text', text }] }] },
		seq: 1,
		ordinal: nextOrdinal(),
		parentId: null,
	};
}

/** A dedicated reminder entry. */
function reminder(id: string, text: string): DurableEntry {
	return {
		id,
		kind: 'mcode.system-reminder',
		payload: { text },
		seq: 1,
		ordinal: nextOrdinal(),
		parentId: null,
	};
}

/** An audit/control entry that must never reach the provider. */
function audit(id: string): DurableEntry {
	return {
		id,
		kind: 'mcode.owner-input.received',
		payload: { inputId: 'in_1' },
		seq: 1,
		ordinal: nextOrdinal(),
		parentId: null,
	};
}

/** The placed steering entry. */
function placed(id: string, inputEntryId: string, text: string): DurableEntry {
	return {
		id,
		kind: 'mcode.owner-input.placed',
		payload: { inputEntryId, model: [{ role: 'user', content: text }] },
		seq: 1,
		ordinal: nextOrdinal(),
		parentId: null,
	};
}

/** Compiles the assembled payload into the wire body. */
function toWireBody(entries: readonly DurableEntry[], manifest: ContextManifest): {
	body: Buffer;
	lineCount: number;
} {
	const assembled = assembleManifestPayload(entries, manifest as never);
	const wireEntries = assembled.records.map(compiledEntryToWireEntry);
	const compiled = compile(
		wireEntries.map((entry) => ({ entryId: entry.entryId })),
		wireEntries,
		{
			maxBytes: 1 << 20,
			dialect: compiledRecordDialect(),
			cache: createLruSegmentCache(64),
		},
	);
	return { body: compiled.body, lineCount: compiled.segments.length };
}

describe('projection window → payload → wire body', () => {
	it('carries the window order into the payload order and into the body order', () => {
		const entries = [user('u1', 'first'), assistant('a1', 'reply'), user('u2', 'second')];
		const manifest = project(entries);
		const assembled = assembleManifestPayload(entries, manifest as never);

		expect(assembled.prefix.map((record) => record.entryId)).toEqual(['u1', 'a1', 'u2']);
		expect(manifest.segments.map((segment) => segment.entryId)).toEqual(['u1', 'a1', 'u2']);

		const { body, lineCount } = toWireBody(entries, manifest);
		expect(lineCount).toBe(assembled.records.length);
		const lines = body.toString('utf8').split('\n').filter((line) => line.length > 0);
		expect(lines).toEqual(assembled.records.map((record) => `${serializeCompiledEntry(record)}\n`.trimEnd()));
	});

	it('never lets an audit/control entry reach the wire body', () => {
		const entries = [user('u1', 'first'), audit('aud1'), user('u2', 'second')];
		const manifest = project(entries);
		const assembled = assembleManifestPayload(entries, manifest as never);

		expect(assembled.records.map((record) => record.entryId)).toEqual(['u1', 'u2']);
		const { body } = toWireBody(entries, manifest);
		expect(body.toString('utf8')).not.toContain('mcode');
		expect(body.toString('utf8')).not.toContain('aud1');
	});

	it('positions the reminder tail after the prefix in the wire body', () => {
		const entries = [user('u1', 'first'), reminder('rem1', 'todo state changed'), user('u2', 'second')];
		const manifest = project(entries);
		const assembled = assembleManifestPayload(entries, manifest as never);

		expect(assembled.prefix.map((record) => record.entryId)).toEqual(['u1', 'u2']);
		expect(assembled.tails.map((record) => record.entryId)).toEqual(['rem1']);

		const { body } = toWireBody(entries, manifest);
		const lines = body.toString('utf8').split('\n').filter((line) => line.length > 0);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain('"content":"first"');
		expect(lines[1]).toContain('"content":"second"');
		expect(lines[2]).toContain('<system-reminder>');
	});

	it('puts the compaction summary first in the wire body', () => {
		const entries = [user('u1', 'cut away'), user('u2', 'kept'), user('u3', 'newer')];
		const withCompaction: DurableEntry[] = [
			...entries,
			{
				id: 'comp1',
				kind: 'mcode.compaction',
				payload: { summary: 'summary of the cut prefix', firstKeptEntryId: 'u2' },
				seq: 1,
				ordinal: nextOrdinal(),
				parentId: null,
			},
		];
		const manifest = project(withCompaction);
		expect(manifest.compaction?.firstKeptEntryId).toBe('u2');

		const assembled = assembleManifestPayload(withCompaction, manifest as never);
		expect(assembled.stats.compactionSummaryIncluded).toBe(true);
		expect(assembled.prefix[0]!.content).toBe('summary of the cut prefix');
		expect(assembled.prefix[0]!.entryId).toMatch(/^mcode-compaction-summary#/);

		const { body } = toWireBody(withCompaction, manifest);
		const lines = body.toString('utf8').split('\n').filter((line) => line.length > 0);
		expect(lines[0]).toContain('summary of the cut prefix');
		// The cut prefix itself is NOT in the body — only its summary.
		expect(body.toString('utf8')).not.toContain('cut away');
		expect(body.toString('utf8')).toContain('kept');
	});

	it('keeps the two byte axes apart: raw stored bytes vs outgoing provider bytes', () => {
		const entries = [user('u1', 'first'), user('u2', 'second')];
		const manifest = project(entries);
		const assembled = assembleManifestPayload(entries, manifest as never);
		const { body } = toWireBody(entries, manifest);

		// The projection measures the RAW STORED payload…
		expect(manifest.windowBytes).toBe(
			entries.reduce(
				(sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'),
				0,
			),
		);
		// …while the wire body measures the OUTGOING provider bytes. The two
		// axes are intentionally different — a consumer must never mix them up.
		// The wire body adds ONE trailing newline per segment (the NDJSON frame),
		// so it is the provider-record bytes plus the frame bytes.
		expect(body.length).toBe(assembled.stats.totalBytes + assembled.records.length);
		expect(body.length).not.toBe(manifest.windowBytes);
	});
});

describe('pipeline determinism', () => {
	it('produces byte-identical wire bodies across repeated runs', () => {
		const entries = [user('u1', 'first'), reminder('rem1', 'todo'), user('u2', 'second')];
		const manifest = project(entries);

		const first = toWireBody(entries, manifest).body;
		const second = toWireBody(entries, manifest).body;
		expect(second.equals(first)).toBe(true);
	});

	it('produces byte-identical wire bodies whatever the writer\'s batch grouping is', () => {
		const content = [
			{ id: 'u1', kind: 'pi.user', payload: { model: [{ role: 'user', content: 'one' }] } },
			{ id: 'u2', kind: 'pi.user', payload: { model: [{ role: 'user', content: 'two' }] } },
			{ id: 'a1', kind: 'pi.assistant', payload: { model: [{ role: 'assistant', content: [{ type: 'text', text: 'three' }] }] } },
			{ id: 'aud', kind: 'mcode.audit', payload: { note: 'x' } },
		];

		/** Applies the content under a batch grouping and returns the manifest. */
		const grouped = (groupSizes: readonly number[]): ContextManifest => {
			const service = new ProjectionService();
			let offset = 0;
			let seq = 0;
			for (const size of groupSizes) {
				seq += 1;
				const batch = [];
				for (let ordinal = 0; ordinal < size; ordinal += 1) {
					const item = content[offset];
					offset += 1;
					if (item === undefined) break;
					batch.push({
						...item,
						seq: seq as never,
						ordinal,
						parentId: null,
					});
				}
				service.apply({
					seq: seq as never,
					batchId: seq as never,
					entryCount: batch.length,
					head: seq as never,
					codec: 'zstd',
					compressedBytes: 0,
					uncompressedBytes: 0,
					entries: batch as never,
				});
			}
			return service.manifest();
		};

		const one = grouped([1, 1, 1, 1]);
		const single = grouped([4]);
		const mixed = grouped([2, 2]);

		// The derived window does not depend on the grouping…
		expect(one.segments).toEqual(single.segments);
		expect(one.segments).toEqual(mixed.segments);
		expect(one.windowBytes).toBe(single.windowBytes);

		// …and therefore the provider payload and the wire body do not either.
		const entries = content as unknown as DurableEntry[];
		const bodyOne = toWireBody(entries, one).body;
		const bodySingle = toWireBody(entries, single).body;
		const bodyMixed = toWireBody(entries, mixed).body;
		expect(bodySingle.equals(bodyOne)).toBe(true);
		expect(bodyMixed.equals(bodyOne)).toBe(true);
	});
});
