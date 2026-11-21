/**
 * W03 transcript fold: the incremental entry fold agrees with the one-shot
 * fold and with the pure replay contracts by construction (the T-phase rule
 * "cached/incremental/full результаты одинаковы"), the compaction checkpoint
 * re-baselines the system state (pi `buildContextEntries`: no initial-system
 * duplication, pre-checkpoint declarations never leak past a cut), and the
 * same-head lookups answer from the folded state.
 */

import { describe, expect, it } from 'vitest';

import {
	EMPTY_TRANSCRIPT_STATE,
	foldTranscriptEntries,
	foldTranscriptEntry,
	getCurrentSystemMessage,
	getCurrentTools,
	resolveTranscriptTools,
	transcriptResolveTools,
	transcriptStateFromCheckpoint,
	transcriptSystemMessage,
	transcriptTools,
	decodeEntryPayload,
	type DurableEntry,
	type JsonValue,
	type TranscriptState,
} from '../../src/index.js';
import { makeEntry, userEntry } from './helpers.js';

let nextSeq = 100;
function entry(id: string, kind: string, payload: JsonValue): DurableEntry {
	return makeEntry(id, kind, payload, { seq: nextSeq++ });
}

/** A `pi.system` entry carrying the given SystemMessage fields. */
function systemEntry(id: string, message: Record<string, unknown>): DurableEntry {
	return entry(id, 'pi.system', { model: [{ role: 'system', timestamp: 0, ...message }] });
}

function compactionEntry(id: string, systemMessage: string | null | number, extra: Record<string, unknown> = {}): DurableEntry {
	return entry(id, 'mcode.compaction', { summary: 'cut', firstKeptEntryId: 'kept-1', systemMessage, ...extra });
}

const READ = { name: 'read', description: 'r', parameters: { type: 'object', v: 1 } };
const READ_V2 = { name: 'read', description: 'r', parameters: { type: 'object', v: 2 } };
const BASH = { name: 'bash', description: 'b', parameters: { type: 'object' } };
const GREP = { name: 'grep', description: 'g', parameters: { type: 'object' } };

/** The log-order fixture family the equivalence runs over. */
function fixtureLogs(): DurableEntry[][] {
	return [
		[],
		[userEntry('u1', 'hi')],
		[
			systemEntry('s1', { content: 'base', toolsAdded: [READ, BASH], timestamp: 10 }),
			userEntry('u1', 'go'),
			systemEntry('s2', { content: '', toolsAdded: [READ_V2, GREP], toolsRemoved: [{ name: 'bash' }], timestamp: 12 }),
		],
		[
			userEntry('u1', 'first'),
			systemEntry('s1', { content: 'late', toolsAdded: [BASH], timestamp: 3 }),
		],
		[
			systemEntry('s1', { content: '', toolsAdded: [READ], timestamp: 1 }),
			systemEntry('s2', { content: '', toolsAdded: [READ], timestamp: 2 }),
			systemEntry('s3', { content: '', toolsRemoved: [{ name: 'read' }], timestamp: 3 }),
			systemEntry('s4', { content: '', toolsAdded: [READ], timestamp: 4 }),
		],
		[
			systemEntry('s1', { content: 'base', sections: { env: 'dev', cwd: '/tmp' }, timestamp: 1 }),
			systemEntry('s2', { content: '', sections: { env: null }, timestamp: 2 }),
			systemEntry('s3', { content: '', sections: { env: 'prod' }, timestamp: 3 }),
		],
		[
			systemEntry('s1', { content: 'one', timestamp: 1 }),
			entry('rem1', 'mcode.system-reminder', { text: 'todo' }),
			userEntry('u1', 'with input'),
			entry('audit1', 'mcode.owner-input.received', { text: 'noise' }),
			systemEntry('s2', { content: 'two', timestamp: 9 }),
		],
	];
}

/** The decoded window messages of a log (what the pure replay contracts take). */
function decodedMessages(entries: readonly DurableEntry[]) {
	return entries.flatMap((e) => decodeEntryPayload(e.kind, e.payload).messages);
}

/** Compare every same-head lookup surface of two fold states. */
function expectSameView(left: TranscriptState, right: TranscriptState): void {
	expect(transcriptSystemMessage(left)).toEqual(transcriptSystemMessage(right));
	expect(transcriptTools(left).map((t) => t.name)).toEqual(transcriptTools(right).map((t) => t.name));
	for (const support of ['none', 'additions', 'changes'] as const) {
		expect(transcriptResolveTools(left, support)).toEqual(transcriptResolveTools(right, support));
	}
}

describe('transcript fold equivalence (incremental === one-shot === pure replay)', () => {
	for (const [index, log] of fixtureLogs().entries()) {
		it(`fixture ${index}: per-entry incremental application equals the one-shot fold`, () => {
			const oneShot = foldTranscriptEntries(log);
			let incremental = EMPTY_TRANSCRIPT_STATE;
			for (const e of log) incremental = foldTranscriptEntry(incremental, e);
			expectSameView(oneShot, incremental);
			expect(incremental.lastEntryId).toBe(oneShot.lastEntryId);
		});

		it(`fixture ${index}: the fold equals the pure replay contracts over the decoded window`, () => {
			const state = foldTranscriptEntries(log);
			const messages = decodedMessages(log);
			expect(transcriptSystemMessage(state)).toEqual(getCurrentSystemMessage(messages));
			expect(transcriptTools(state)).toEqual(getCurrentTools(messages));
			for (const support of ['none', 'additions', 'changes'] as const) {
				expect(transcriptResolveTools(state, support)).toEqual(resolveTranscriptTools(messages, support));
			}
		});
	}
});

describe('compaction checkpoint re-baseline (pi buildContextEntries semantics)', () => {
	it('wipes pre-checkpoint system messages and re-baselines to the frozen prompt', () => {
		const log = [
			systemEntry('s1', { content: 'old base', toolsAdded: [READ, BASH], timestamp: 1 }),
			userEntry('u1', 'kept'),
			compactionEntry('c1', 'frozen prompt'),
			systemEntry('s2', { content: '', toolsAdded: [GREP], timestamp: 5 }),
		];
		const state = foldTranscriptEntries(log);
		const message = transcriptSystemMessage(state);
		expect(message?.content).toBe('frozen prompt');
		expect(message?.toolsAdded?.map((t) => t.name)).toEqual(['grep']);
		expect(message?.timestamp).toBe(0);
		// The additions boundary restarted at the checkpoint: post-checkpoint
		// additions stay anchored in place, requestTools is the checkpoint
		// baseline (the legacy string form declares no tools).
		expect(transcriptResolveTools(state, 'additions')).toEqual({ requestTools: [], foldedSystemMessages: 1 });
	});

	it('retains none when the checkpoint systemMessage is null', () => {
		const state = foldTranscriptEntries([
			systemEntry('s1', { content: 'old', toolsAdded: [READ], timestamp: 1 }),
			compactionEntry('c1', null),
		]);
		expect(transcriptSystemMessage(state)).toBeUndefined();
		expect(transcriptTools(state)).toEqual([]);
	});

	it('treats an absent checkpoint systemMessage as retain-none (foreign writer)', () => {
		const state = foldTranscriptEntries([
			systemEntry('s1', { content: 'old', toolsAdded: [READ], timestamp: 1 }),
			entry('c1', 'mcode.compaction', { summary: 'cut', firstKeptEntryId: 'k1' }),
		]);
		expect(transcriptSystemMessage(state)).toBeUndefined();
	});

	it('rejects a corrupt checkpoint systemMessage (writer-contract breach, fail-closed)', () => {
		expect(() => foldTranscriptEntries([compactionEntry('c1', 42)])).toThrow(TypeError);
		expect(() => foldTranscriptEntries([entry('c1', 'mcode.compaction', 'not an object')])).toThrow(TypeError);
	});

	it('a post-checkpoint redeclaration of a pre-checkpoint name is window-local additive', () => {
		const state = foldTranscriptEntries([
			systemEntry('s1', { content: '', toolsAdded: [READ], timestamp: 1 }),
			compactionEntry('c1', 'base'),
			// `read` was declared pre-checkpoint, but the checkpoint reset the
			// declared set: this is a fresh declaration, not a redeclaration.
			systemEntry('s2', { content: '', toolsAdded: [READ_V2], timestamp: 2 }),
		]);
		expect(transcriptTools(state).map((t) => t.parameters)).toEqual([{ type: 'object', v: 2 }]);
		// Non-additive relative to the checkpoint window only: nothing before s2.
		expect(transcriptResolveTools(state, 'additions')).toEqual({ requestTools: [], foldedSystemMessages: 1 });
	});

	it('the checkpoint seed equals folding the log with the checkpoint entry', () => {
		const tail = [userEntry('k1', 'kept'), systemEntry('s2', { content: '', toolsAdded: [GREP], timestamp: 7 })];
		const seeded = tail.reduce(foldTranscriptEntry, transcriptStateFromCheckpoint('frozen prompt'));
		const withEntry = foldTranscriptEntries([compactionEntry('c1', 'frozen prompt'), ...tail]);
		expectSameView(seeded, withEntry);
	});
});

describe('fold state discipline', () => {
	it('audit/control kinds other than compaction never touch the system state', () => {
		const base = foldTranscriptEntries([systemEntry('s1', { content: 'base', toolsAdded: [READ], timestamp: 3 })]);
		const audited = foldTranscriptEntry(
			base,
			entry('e1', 'mcode.context_edit', { action: 'omission', targetIds: ['s1'] }),
		);
		expect(transcriptSystemMessage(audited)).toEqual(transcriptSystemMessage(base));
		expect(audited.lastEntryId).toBe('e1');
	});

	it('an empty log folds to the empty state and no system message', () => {
		const state = foldTranscriptEntries([]);
		expect(state).toEqual(EMPTY_TRANSCRIPT_STATE);
		expect(transcriptSystemMessage(state)).toBeUndefined();
		expect(transcriptResolveTools(state, 'none')).toEqual({ requestTools: [], foldedSystemMessages: 0 });
	});
});
