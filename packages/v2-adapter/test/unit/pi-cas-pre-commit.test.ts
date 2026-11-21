/**
 * W02 part B: the CAS publish-before-reference validator for pi storage
 * commits (I09; C1 invariant 5) — a commit referencing an unpublished blob
 * is rejected before any durable attempt.
 */

import { describe, expect, it } from 'vitest';

import {
	CasRefBudgetExceededError,
	CasRefUnpublishedError,
	collectCasRefDigests,
	createCasPreCommitValidator,
} from '../../src/pi-cas-pre-commit.js';

const PUBLISHED = 'a'.repeat(64);
const OTHER_PUBLISHED = 'b'.repeat(64);
const UNPUBLISHED = 'c'.repeat(64);

function fakeCas(published: readonly string[]): { hasAsync(sha256: string): Promise<boolean> } {
	const set = new Set(published);
	return { hasAsync: async (sha256: string) => set.has(sha256) };
}

function entryWrite(data: unknown): { type: 'entry'; value: { id: number; conversationId: number; kind: string; data: unknown } } {
	return { type: 'entry', value: { id: 1, conversationId: 1, kind: 'mcode.test', data } };
}

describe('collectCasRefDigests', () => {
	it('finds cas:// refs anywhere in the write JSON', () => {
		const digests = collectCasRefDigests({
			type: 'entry',
			value: {
				id: 1,
				conversationId: 1,
				kind: 'mcode.test',
				data: {
					v: 1,
					mcodeEntryId: 'x',
					payload: {
						spill: `cas://sha256/${PUBLISHED}#123`,
						nested: [{ ref: `cas://sha256/${OTHER_PUBLISHED}#1` }],
						notARef: 'cas://sha256/zz#1',
						alsoNot: 'https://cas://sha256/x',
					},
				},
			},
		});
		expect([...digests].sort()).toEqual([OTHER_PUBLISHED, PUBLISHED].sort());
	});

	it('returns an empty set for ref-free writes', () => {
		expect(collectCasRefDigests(entryWrite({ payload: { text: 'no refs' } }).value).size).toBe(0);
	});
});

describe('createCasPreCommitValidator', () => {
	it('passes commits whose refs are all published', async () => {
		const validate = createCasPreCommitValidator(fakeCas([PUBLISHED, OTHER_PUBLISHED]));
		await expect(
			validate([
				entryWrite({
					v: 1,
					mcodeEntryId: 'x',
					payload: { a: `cas://sha256/${PUBLISHED}#10`, b: `cas://sha256/${OTHER_PUBLISHED}#20` },
				}),
			]),
		).resolves.toBeUndefined();
	});

	it('rejects a commit referencing an unpublished blob, naming the digest', async () => {
		const validate = createCasPreCommitValidator(fakeCas([PUBLISHED]));
		const attempt = validate([
			entryWrite({
				v: 1,
				mcodeEntryId: 'x',
				payload: { ok: `cas://sha256/${PUBLISHED}#1`, missing: `cas://sha256/${UNPUBLISHED}#2` },
			}),
		]);
		await expect(attempt).rejects.toMatchObject({
			name: 'CasRefUnpublishedError',
			sha256: UNPUBLISHED,
		});
		expect(CasRefUnpublishedError).toBeDefined();
	});

	it('enforces the distinct-ref budget', async () => {
		const validate = createCasPreCommitValidator(fakeCas([]), { maxRefsPerCommit: 2 });
		const payload = {
			v: 1,
			mcodeEntryId: 'x',
			payload: {
				refs: ['a', 'b', 'c'].map(
					(letter) => `cas://sha256/${letter.repeat(64)}#1`,
				),
			},
		};
		await expect(validate([entryWrite(payload)])).rejects.toBeInstanceOf(CasRefBudgetExceededError);
	});

	it('passes ref-free commits without touching the store', async () => {
		let probes = 0;
		const validate = createCasPreCommitValidator({
			hasAsync: async () => {
				probes += 1;
				return false;
			},
		});
		await expect(validate([entryWrite({ payload: { text: 'plain' } })])).resolves.toBeUndefined();
		expect(probes).toBe(0);
	});
});
