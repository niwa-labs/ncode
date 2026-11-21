// Deterministic factories for log entries and enriched commits in the
// projection unit tests. Ids and payloads are generated sequentially so the
// suites are reproducible.

import type { Commit, Entry, JsonValue, Seq } from '../../../durable-backend-sqlite-zstd/src/types.js';

import type { CommitWithEntries } from '../../src/service.js';

let counter = 0;

/** Fresh unique entry id. */
export function nextId(prefix = 'e'): string {
	counter += 1;
	return `${prefix}-${counter}`;
}

/** Wraps a plain number into the backend's branded `Seq`. */
export function seqOf(value: number): Seq {
	return value as Seq;
}

/** LLM-visible entry (a `pi.*` kind by convention of the log). */
export function llmEntry(kind: string, payload: JsonValue, seq: number, ordinal: number): Entry {
	return { id: nextId('llm'), parentId: null, kind, payload, seq: seqOf(seq), ordinal };
}

/** Audit entry (`mcode.audit`): filtered out of the LLM context, advances the fold. */
export function auditEntry(seq: number, ordinal: number): Entry {
	return {
		id: nextId('audit'),
		parentId: null,
		kind: 'mcode.audit',
		payload: { note: `audit-${ordinal}` },
		seq: seqOf(seq),
		ordinal,
	};
}

/** Compaction control entry: cuts every segment before `firstKeptEntryId`. */
export function compactionEntry(
	seq: number,
	ordinal: number,
	summary: string,
	firstKeptEntryId: string,
): Entry {
	return {
		id: nextId('compaction'),
		parentId: null,
		kind: 'mcode.compaction',
		payload: { summary, firstKeptEntryId },
		seq: seqOf(seq),
		ordinal,
	};
}

/** Context-edit control entry: prunes `removedEntryIds` from the derived segments. */
export function editEntry(seq: number, ordinal: number, removedEntryIds: string[]): Entry {
	return {
		id: nextId('edit'),
		parentId: null,
		kind: 'mcode.context_edit',
		payload: { removedEntryIds },
		seq: seqOf(seq),
		ordinal,
	};
}

/** pi-variant context-edit entry: `{ content }` replaces one target, `null` omits it. */
export function replacementEditEntry(
	seq: number,
	ordinal: number,
	targetId: string,
	replacement: { content: string | JsonValue[] } | null,
): Entry {
	return {
		id: nextId('edit'),
		parentId: null,
		kind: 'mcode.context_edit',
		payload: { targetId, replacement },
		seq: seqOf(seq),
		ordinal,
	};
}

/** Usage control entry: model-attributed usage folded outside the LLM window. */
export function usageEntry(
	seq: number,
	ordinal: number,
	kind: string,
	provider: string,
	model: string,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cacheWrite1h?: number;
		reasoning?: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
): Entry {
	return {
		id: nextId('usage'),
		parentId: null,
		kind: 'mcode.usage',
		payload: { kind, provider, model, usage },
		seq: seqOf(seq),
		ordinal,
	};
}

/** Compaction control entry with the retain-none spelling (`firstKeptEntryId: null`). */
export function retainNoneCompactionEntry(seq: number, ordinal: number, summary: string): Entry {
	return {
		id: nextId('compaction'),
		parentId: null,
		kind: 'mcode.compaction',
		payload: { summary, firstKeptEntryId: null },
		seq: seqOf(seq),
		ordinal,
	};
}

/** pi branch-summary entry (visible in context on both sides; not content-editable). */
export function branchSummaryEntry(seq: number, ordinal: number, summary: string): Entry {
	return {
		id: nextId('branch'),
		parentId: null,
		kind: 'pi.branch-summary',
		payload: { summary, fromId: null },
		seq: seqOf(seq),
		ordinal,
	};
}

/** pi custom_message entry (extension-injected, context-visible, content-editable). */
export function customMessageEntry(seq: number, ordinal: number, customType: string, text: string): Entry {
	return {
		id: nextId('custommsg'),
		parentId: null,
		kind: 'pi.custom-message',
		payload: { role: 'custom', customType, content: text, display: true },
		seq: seqOf(seq),
		ordinal,
	};
}

/**
 * One of the pi dictionary kinds that NEVER enter LLM context (extension
 * state / metadata / settings): `mcode.custom`, `mcode.label`,
 * `mcode.session-info`, `mcode.model-change`, `mcode.thinking-level`.
 */
export function dictionaryControlEntry(
	kind: 'mcode.custom' | 'mcode.label' | 'mcode.session-info' | 'mcode.model-change' | 'mcode.thinking-level',
	seq: number,
	ordinal: number,
	payload: JsonValue,
): Entry {
	return { id: nextId('dict'), parentId: null, kind, payload, seq: seqOf(seq), ordinal };
}

/** Builds the backend-shaped commit of `entries`, enriched with them. */
export function commitOf(seq: number, entries: readonly Entry[]): CommitWithEntries {
	const uncompressedBytes = entries.reduce(
		(sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'),
		0,
	);
	const commit: Commit = {
		seq: seqOf(seq),
		batchId: seq as Commit['batchId'],
		entryCount: entries.length,
		head: seqOf(seq),
		codec: 'zstd',
		compressedBytes: uncompressedBytes,
		uncompressedBytes,
	};
	return { ...commit, entries };
}

/** Deterministic LCG in [0, 1) so the randomized equivalence test is reproducible. */
export function makeLcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}
