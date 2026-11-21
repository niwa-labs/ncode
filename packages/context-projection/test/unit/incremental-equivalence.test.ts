import { describe, expect, it } from 'vitest';

import { ProjectionService, buildProjection } from '../../src/index.js';
import { auditEntry, commitOf, compactionEntry, editEntry, llmEntry } from './helpers.js';

/**
 * Инкрементальный apply обязан давать ровно тот же байт-в-байт манифест, что и
 * полный rebuild из того же лога. Здесь это проверяется на уровне сериализации
 * (не только структурного равенства), потому что манифест уезжает в CAS/снапшот
 * и любое расхождение порядка ключей или значений ломает байтовый кэш.
 */
describe('incremental apply = full rebuild (byte-for-byte)', () => {
	it('пустая история: свежий сервис совпадает с buildProjection([])', () => {
		const service = new ProjectionService();

		expect(JSON.stringify(service.manifest())).toBe(JSON.stringify(buildProjection([])));
		expect(service.manifest().segments).toEqual([]);
		expect(service.manifest().windowBytes).toBe(0);
		expect(service.manifest().usageAnchor).toBeNull();
		expect(service.manifest().compaction ?? null).toBeNull();
	});

	it('после каждого коммита манифест побайтово равен rebuild того же лога', () => {
		const service = new ProjectionService();
		const log: ReturnType<typeof llmEntry>[] = [];

		for (let seq = 1; seq <= 6; seq += 1) {
			const batch = [
				llmEntry('pi.user', { text: `u${seq}` }, seq, 0),
				llmEntry('pi.assistant', { text: `a${seq}` }, seq, 1),
				auditEntry(seq, 2),
			];
			log.push(...batch);
			service.apply(commitOf(seq, batch));

			expect(JSON.stringify(service.manifest())).toBe(JSON.stringify(buildProjection(log)));
		}
	});

	it('одна гигантская entry: окно равно байтам payload, манифест равен rebuild', () => {
		const service = new ProjectionService();
		const payload = 'x'.repeat(2 * 1024 * 1024);
		const entry = llmEntry('pi.user', { text: payload }, 1, 0);

		service.apply(commitOf(1, [entry]));

		const manifest = service.manifest();
		expect(manifest.segments).toHaveLength(1);
		expect(manifest.segments[0]!.entryId).toBe(entry.id);
		expect(manifest.windowBytes).toBe(Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'));
		expect(JSON.stringify(manifest)).toBe(JSON.stringify(buildProjection([entry])));
	});

	it('батч, смешивающий control- и LLM-entry: rebuilt + delta только по LLM-entry', () => {
		const service = new ProjectionService();
		const first = llmEntry('pi.user', { text: 'first' }, 1, 0);
		service.apply(commitOf(1, [first]));

		const answer = llmEntry('pi.assistant', { text: 'answer' }, 2, 0);
		const compaction = compactionEntry(2, 1, 'summary of first', first.id);
		const result = service.apply(commitOf(2, [answer, compaction]));

		expect(result.rebuilt).toBe(true);
		expect(result.delta.map((segment) => segment.entryId)).toEqual([answer.id]);
		expect(JSON.stringify(result.manifest)).toBe(
			JSON.stringify(buildProjection([first, answer, compaction])),
		);
	});

	it('context_edit, вырезающий entry из того же батча: вырезанной entry нет в delta', () => {
		const service = new ProjectionService();
		const kept = llmEntry('pi.user', { text: 'kept' }, 1, 0);
		service.apply(commitOf(1, [kept]));

		const doomed = llmEntry('pi.assistant', { text: 'doomed' }, 2, 0);
		const edit = editEntry(2, 1, [doomed.id]);
		const result = service.apply(commitOf(2, [doomed, edit]));

		expect(result.rebuilt).toBe(true);
		expect(result.delta).toEqual([]);
		expect(result.manifest.segments.map((segment) => segment.entryId)).toEqual([kept.id]);
		expect(JSON.stringify(result.manifest)).toBe(
			JSON.stringify(buildProjection([kept, doomed, edit])),
		);
	});
});

describe('fold: граничные случаи окна и якоря', () => {
	it('компакция, оставляющая первый сегмент, не меняет окно', () => {
		const user = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const assistant = llmEntry('pi.assistant', { text: 'b' }, 1, 1);
		const compaction = compactionEntry(2, 0, 'summary', user.id);

		const manifest = buildProjection([user, assistant, compaction]);

		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([user.id, assistant.id]);
		expect(manifest.windowBytes).toBe(
			Buffer.byteLength(JSON.stringify(user.payload), 'utf8') +
				Buffer.byteLength(JSON.stringify(assistant.payload), 'utf8'),
		);
		expect(manifest.compaction?.firstKeptEntryId).toBe(user.id);
	});

	it('usageAnchor не откатывается, когда его entry вырезана', () => {
		const user = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const assistant = llmEntry('pi.assistant', { text: 'b' }, 1, 1);
		const edit = editEntry(2, 0, [assistant.id]);

		const manifest = buildProjection([user, assistant, edit]);

		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([user.id]);
		expect(manifest.usageAnchor).toBe(assistant.id);
	});

	it('батч с разрывом внутри себя отклоняется, состояние не меняется', () => {
		const service = new ProjectionService();
		const first = llmEntry('pi.user', { text: 'a' }, 1, 0);
		service.apply(commitOf(1, [first]));

		const before = JSON.stringify(service.manifest());
		const gapped = [
			llmEntry('pi.user', { text: 'gapped' }, 2, 0),
			llmEntry('pi.assistant', { text: 'gapped too' }, 2, 2),
		];

		expect(() => service.apply(commitOf(2, gapped))).toThrow();
		expect(JSON.stringify(service.manifest())).toBe(before);
		expect(service.capsule().head).toBe(1);
	});
});
