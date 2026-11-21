/**
 * V-C09 closure (W03 deferral → W05): the FULL frozen SystemMessage
 * checkpoint — content+sections+toolsAdded+timestamp — re-baselines the
 * transcript fold, and the manifest-path seed
 * (`transcriptStateFromCheckpoint`) equals folding the log WITH the
 * checkpoint entry on the full form (the deferral's acceptance condition 2:
 * "re-baseline tools не пуст, seed ≡ fold-with-checkpoint-entry на полной
 * форме"). Legacy `string|null` checkpoints keep reading unchanged
 * (condition 3).
 */

import { describe, expect, it } from 'vitest';

import {
	decodeEntryPayload,
	foldTranscriptEntries,
	foldTranscriptEntry,
	isCheckpointSystemMessage,
	resolveTranscriptTools,
	transcriptResolveTools,
	transcriptStateFromCheckpoint,
	transcriptSystemMessage,
	transcriptTools,
	getCurrentSystemMessage,
	getCurrentTools,
	type CheckpointSystemMessage,
	type DurableEntry,
	type JsonValue,
	type TranscriptMessage,
} from '../../src/index.js';
import { makeEntry, userEntry } from './helpers.js';

let nextSeq = 500;
function entry(id: string, kind: string, payload: JsonValue): DurableEntry {
	return makeEntry(id, kind, payload, { seq: nextSeq++ });
}

function systemEntry(id: string, message: Record<string, unknown>): DurableEntry {
	return entry(id, 'pi.system', { model: [{ role: 'system', timestamp: 0, ...message }] });
}

function compactionEntry(id: string, systemMessage: string | null | CheckpointSystemMessage): DurableEntry {
	// The payload crosses the JSON boundary like every durable entry; the
	// typed spelling is this layer's view of the same shape.
	return entry(id, 'mcode.compaction', {
		summary: 'cut',
		firstKeptEntryId: 'k1',
		systemMessage: systemMessage as unknown as JsonValue,
	});
}

const READ = { name: 'read', description: 'r', parameters: { type: 'object', v: 1 } };
const GREP = { name: 'grep', description: 'g', parameters: { type: 'object' } };

/** A full frozen SystemMessage exactly as the W05 writer (context-compaction) records it. */
const FROZEN: CheckpointSystemMessage = {
	role: 'system',
	content: 'frozen prompt',
	sections: { env: 'prod', extra: 'context' },
	toolsAdded: [READ],
	timestamp: 4711,
};

function expectSameView(a: ReturnType<typeof foldTranscriptEntries>, b: ReturnType<typeof foldTranscriptEntries>) {
	expect(transcriptSystemMessage(a)).toEqual(transcriptSystemMessage(b));
	expect(transcriptTools(a)).toEqual(transcriptTools(b));
	for (const support of ['none', 'additions', 'changes'] as const) {
		expect(transcriptResolveTools(a, support)).toEqual(transcriptResolveTools(b, support));
	}
}

describe('isCheckpointSystemMessage (structural guard)', () => {
	it('accepts the full form and its minimal variants, rejects corrupt shapes', () => {
		expect(isCheckpointSystemMessage(FROZEN)).toBe(true);
		expect(isCheckpointSystemMessage({ role: 'system', content: [{ type: 'text', text: 'a' }], timestamp: 1 })).toBe(true);
		expect(isCheckpointSystemMessage({ content: 'x', timestamp: 1 })).toBe(true); // tolerant: role optional
		for (const corrupt of [42, 'string', null, [], { role: 'user', content: 'x', timestamp: 1 }, { content: 7 }, { content: 'x', timestamp: 'now' }, { content: 'x', timestamp: 1, sections: { a: 3 } }, { content: 'x', timestamp: 1, toolsAdded: [{}] }]) {
			expect(isCheckpointSystemMessage(corrupt)).toBe(false);
		}
	});

	it('W05 review pass 1 (validator asymmetry): a corrupt toolsRemoved is rejected by BOTH package guards', async () => {
		// The same frozen-shape guard exists in @mavis/context-projection
		// (`isFrozenCompactionSystemMessage`, kinds.ts) — the projection-side
		// reader of the checkpoint. A record with a broken `toolsRemoved` must
		// be rejected by BOTH, never accepted by one reader and turned into
		// dead weight by the other: that is exactly the "one consumer applied
		// the cut, the other rejected the record" desync kinds.ts warns about.
		const { asCompactionPayload, isFrozenCompactionSystemMessage } = await import(
			'../../../context-projection/src/index.js'
		);
		const intact = { ...FROZEN, toolsRemoved: [{ name: 'bash' }] };
		expect(isCheckpointSystemMessage(intact)).toBe(true);
		expect(isFrozenCompactionSystemMessage(intact)).toBe(true);
		for (const corruptToolsRemoved of [[{}], [{ tool: 'bash' }], [42], 'bash', { name: 'bash' }]) {
			const corrupt = { ...FROZEN, toolsRemoved: corruptToolsRemoved } as never;
			expect(isCheckpointSystemMessage(corrupt), `convert-to-llm rejects toolsRemoved=${JSON.stringify(corruptToolsRemoved)}`).toBe(false);
			expect(isFrozenCompactionSystemMessage(corrupt), `context-projection rejects toolsRemoved=${JSON.stringify(corruptToolsRemoved)}`).toBe(false);
		}
		// And the end-to-end readers fail closed on the same record: the
		// transcript fold throws (foreign shape), the projection payload
		// decoder throws (writer-contract breach) — no reader applies it.
		const record = { ...FROZEN, toolsRemoved: [{}] } as never;
		expect(() => foldTranscriptEntries([compactionEntry('c1', record)])).toThrow(TypeError);
		expect(() => asCompactionPayload({ summary: 'cut', firstKeptEntryId: 'k1', systemMessage: record }, 'c1')).toThrow(TypeError);
	});
});

describe('full-form checkpoint re-baseline', () => {
	it('re-baselines content, sections, tools AND timestamp (not just prompt text)', () => {
		const state = foldTranscriptEntries([
			systemEntry('s1', { content: 'old base', toolsAdded: [{ name: 'bash' }], timestamp: 1 }),
			userEntry('u1', 'kept'),
			compactionEntry('c1', FROZEN),
		]);
		const message = transcriptSystemMessage(state);
		expect(message).toBeDefined();
		expect(message!.content).toBe('frozen prompt');
		expect(message!.sections).toEqual({ env: 'prod', extra: 'context' });
		expect(message!.toolsAdded?.map((tool) => tool.name)).toEqual(['read']);
		expect(message!.timestamp).toBe(4711); // the full form carries the wall-clock stamp
	});

	it('pre-checkpoint declarations never leak past the cut', () => {
		const state = foldTranscriptEntries([
			systemEntry('s1', { content: '', toolsAdded: [{ name: 'bash' }], timestamp: 1 }),
			compactionEntry('c1', FROZEN),
		]);
		expect(transcriptTools(state).map((tool) => tool.name)).toEqual(['read']);
	});

	it('post-checkpoint additions fold ON TOP of the frozen baseline', () => {
		const state = foldTranscriptEntries([
			compactionEntry('c1', FROZEN),
			systemEntry('s2', { content: '', toolsAdded: [GREP], timestamp: 9000 }),
		]);
		expect(transcriptTools(state).map((tool) => tool.name)).toEqual(['read', 'grep']);
		// The additions boundary is the checkpoint itself: requestTools is the
		// frozen tool set, not empty (the legacy-form gap the deferral called out).
		expect(transcriptResolveTools(state, 'additions')).toEqual({
			requestTools: [READ],
			foldedSystemMessages: 1,
		});
	});

	it('the seed equals folding the log with the checkpoint entry (full form)', () => {
		const tail = [userEntry('k1', 'kept'), systemEntry('s2', { content: '', toolsAdded: [GREP], timestamp: 7 })];
		const seeded = tail.reduce(foldTranscriptEntry, transcriptStateFromCheckpoint(FROZEN));
		const withEntry = foldTranscriptEntries([compactionEntry('c1', FROZEN), ...tail]);
		expectSameView(seeded, withEntry);
		expect(seeded.timestamp).toBe(withEntry.timestamp);
		expect(seeded.declaredNames).toEqual(withEntry.declaredNames);
	});

	it('retain-none (null) and the legacy string keep their documented behavior', () => {
		const none = foldTranscriptEntries([systemEntry('s1', { content: 'old', timestamp: 1 }), compactionEntry('c1', null)]);
		expect(transcriptSystemMessage(none)).toBeUndefined();
		const legacy = foldTranscriptEntries([compactionEntry('c1', 'text only')]);
		expect(transcriptSystemMessage(legacy)?.content).toBe('text only');
		expect(transcriptTools(legacy)).toEqual([]);
		expect(transcriptSystemMessage(legacy)?.timestamp).toBe(0); // legacy: no stamp
	});

	it('a corrupt full form fails closed (TypeError), like every reader of the checkpoint', () => {
		expect(() =>
			foldTranscriptEntries([compactionEntry('c1', { role: 'system', content: 42 as never, timestamp: 1 })]),
		).toThrow(TypeError);
	});

	it('the folded view equals the pure replay contract over the decoded window', () => {
		const log = [
			compactionEntry('c1', FROZEN),
			systemEntry('s2', { content: '', toolsAdded: [GREP], timestamp: 9000 }),
			userEntry('u1', 'hi'),
		];
		const state = foldTranscriptEntries(log);
		// The decoded window of the retained slice: the checkpoint contributes
		// its frozen system message (pi buildContextEntries: systemMessage
		// replays ahead of the summary), the post-checkpoint system entry follows.
		const messages: TranscriptMessage[] = [
			{ role: 'system', ...FROZEN } as TranscriptMessage,
			...decodeEntryPayload(log[1]!.kind, log[1]!.payload).messages,
		];
		expect(transcriptSystemMessage(state)).toEqual(getCurrentSystemMessage(messages));
		expect(transcriptTools(state)).toEqual(getCurrentTools(messages));
		expect(transcriptResolveTools(state, 'changes')).toEqual(resolveTranscriptTools(messages, 'changes'));
	});
});
