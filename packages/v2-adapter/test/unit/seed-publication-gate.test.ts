/**
 * W02 part B: the seed PUBLICATION gate — `history.v2.seed.commit` may only
 * travel in a pi storage commit whose begin/chunks verify against the
 * protocol scanner ("Seed publication только при validated commit").
 */

import { describe, expect, it } from 'vitest';

import {
	asSeedCommitPayload,
	seedChunkDigest,
	seedRootDigest,
	SEED_BEGIN_KIND,
	SEED_CHUNK_KIND,
	SEED_COMMIT_KIND,
	SEED_MAPPING_VERSION,
	type SeedBeginPayload,
	type SeedChunkPayload,
	type SeedCommitPayload,
	type SeedEnvelope,
	type SeedLogEntry,
} from '../../src/history-import/seed-protocol.js';
import {
	createSeedPublicationPreCommitHook,
	SeedPublicationRejectedError,
	verifySeedCommitForPublication,
} from '../../src/history-import/seed-publication-gate.js';
import {
	createSingleWriterGate,
	gatePiStorageMutations,
	type PiStorageWriteLike,
	type PiWritableStorageLike,
} from '@mavis/storage-worker';

const SESSION = 'session-1';
const IMPORT = 'import-1';

function envelopes(count: number): SeedEnvelope[] {
	return Array.from({ length: count }, (_, index) => ({
		message_id: `m${String(index)}`,
		turn_id: 't1',
		message: { index },
	}));
}

function begin(overrides: Partial<SeedBeginPayload> = {}): SeedBeginPayload {
	return {
		sessionId: SESSION,
		importId: IMPORT,
		sourceFingerprint: 'sha256:abc',
		mappingVersion: SEED_MAPPING_VERSION,
		expectedCount: 0,
		reason: 'seed',
		...overrides,
	};
}

function chunk(chunkNo: number, count: number, cursor: number): SeedChunkPayload {
	const env = envelopes(count);
	return {
		sessionId: SESSION,
		importId: IMPORT,
		chunkNo,
		sourceCursor: cursor,
		count,
		digest: seedChunkDigest(env.map((entry) => JSON.stringify(entry))),
		envelopes: env,
	};
}

/** A well-formed import: begin + two chunks (3 records total). */
function validLogSeedEntries(): SeedLogEntry[] {
	return [
		{ kind: SEED_BEGIN_KIND, payload: begin() },
		{ kind: SEED_CHUNK_KIND, payload: chunk(1, 2, 2) },
		{ kind: SEED_CHUNK_KIND, payload: chunk(2, 1, 3) },
	];
}

function validCommit(): SeedCommitPayload {
	const chunks = [chunk(1, 2, 2), chunk(2, 1, 3)];
	return {
		sessionId: SESSION,
		importId: IMPORT,
		chunkCount: chunks.length,
		count: 3,
		activeRevision: 'rev-1',
		rootDigest: seedRootDigest(chunks.map((one) => one.digest)),
		casManifestDigest: null,
	};
}

function logEntryOf(payload: SeedCommitPayload): SeedLogEntry {
	return { kind: SEED_COMMIT_KIND, payload };
}

describe('verifySeedCommitForPublication — pure verdicts', () => {
	it('accepts a well-formed import', () => {
		const verdict = verifySeedCommitForPublication({
			logSeedEntries: validLogSeedEntries(),
			batchSeedEntries: [],
			commitEntry: logEntryOf(validCommit()),
		});
		expect(verdict).toEqual({ ok: true, commit: validCommit() });
	});

	it('accepts a commit batch that carries its own begin/chunks (single-commit seed)', () => {
		const verdict = verifySeedCommitForPublication({
			logSeedEntries: [],
			batchSeedEntries: validLogSeedEntries(),
			commitEntry: logEntryOf(validCommit()),
		});
		expect(verdict.ok).toBe(true);
	});

	it('rejects a commit without its begin (SEED_IMPORT_STATE_INVALID)', () => {
		const verdict = verifySeedCommitForPublication({
			logSeedEntries: [],
			batchSeedEntries: [],
			commitEntry: logEntryOf(validCommit()),
		});
		expect(verdict).toMatchObject({ ok: false, code: 'SEED_IMPORT_STATE_INVALID' });
	});

	it('rejects a lying chunk count (SEED_IMPORT_STATE_INVALID)', () => {
		const lying = { ...validCommit(), count: 99 };
		const verdict = verifySeedCommitForPublication({
			logSeedEntries: validLogSeedEntries(),
			batchSeedEntries: [],
			commitEntry: logEntryOf(lying),
		});
		expect(verdict).toMatchObject({ ok: false, code: 'SEED_IMPORT_STATE_INVALID' });
	});

	it('rejects a root digest mismatch (SEED_IMPORT_STATE_INVALID)', () => {
		const tampered = { ...validCommit(), rootDigest: seedRootDigest(['deadbeef']) };
		const verdict = verifySeedCommitForPublication({
			logSeedEntries: validLogSeedEntries(),
			batchSeedEntries: [],
			commitEntry: logEntryOf(tampered),
		});
		expect(verdict).toMatchObject({ ok: false, code: 'SEED_IMPORT_STATE_INVALID' });
		expect((verdict as { message: string }).message).toMatch(/rootDigest/);
	});

	it('rejects a foreign mapping version (SEED_MAPPING_VERSION_DRIFT)', () => {
		const drifted = validLogSeedEntries().map((entry) =>
			entry.kind === SEED_BEGIN_KIND
				? { ...entry, payload: begin({ mappingVersion: 'canonical-history-seed.v0' }) }
				: entry,
		);
		const verdict = verifySeedCommitForPublication({
			logSeedEntries: drifted,
			batchSeedEntries: [],
			commitEntry: logEntryOf(validCommit()),
		});
		expect(verdict).toMatchObject({ ok: false, code: 'SEED_MAPPING_VERSION_DRIFT' });
	});

	it('rejects non-monotonic chunk source cursors (SEED_SOURCE_CURSOR_NOT_MONOTONIC)', () => {
		// Chunk 2 reports a cursor that does not advance past chunk 1's.
		const backwards = [
			{ kind: SEED_BEGIN_KIND, payload: begin() } as SeedLogEntry,
			{ kind: SEED_CHUNK_KIND, payload: chunk(1, 2, 5) } as SeedLogEntry,
			{ kind: SEED_CHUNK_KIND, payload: chunk(2, 1, 5) } as SeedLogEntry,
		];
		const commit = validCommit();
		const verdict = verifySeedCommitForPublication({
			logSeedEntries: backwards,
			batchSeedEntries: [],
			commitEntry: logEntryOf(commit),
		});
		expect(verdict).toMatchObject({ ok: false, code: 'SEED_SOURCE_CURSOR_NOT_MONOTONIC' });
	});
});

// ---------------------------------------------------------------------------
// Pre-commit hook over the storage-worker single-writer composition
// ---------------------------------------------------------------------------

/** Bridge envelope of a pi EntryRecord hosting an mcode log entry. */
function envelopeWrite(kind: string, payload: unknown): PiStorageWriteLike {
	return {
		type: 'entry',
		value: { id: 1, conversationId: 1, kind, data: { v: 1, mcodeEntryId: `id-${kind}`, payload } },
	};
}

describe('createSeedPublicationPreCommitHook — write-side gate', () => {
	it('passes batches without seed commits untouched', async () => {
		const hook = createSeedPublicationPreCommitHook({ readLogSeedEntries: async () => [] });
		await expect(
			hook([envelopeWrite('mcode.owner-input.receipt', { ok: true })]),
		).resolves.toBeUndefined();
	});

	it('rejects a corrupted seed commit BEFORE storage and publishes nothing', async () => {
		const committed: PiStorageWriteLike[][] = [];
		const storage: PiWritableStorageLike = {
			commit: async (writes: readonly PiStorageWriteLike[]) => {
				committed.push([...writes]);
				return committed.length;
			},
			mintId: async () => 1,
		};
		const logEntries: SeedLogEntry[] = [];
		const hook = createSeedPublicationPreCommitHook({
			readLogSeedEntries: async () => logEntries,
		});
		const gate = createSingleWriterGate();
		const gated = gatePiStorageMutations(storage, { onBeforeCommit: hook }, gate);

		// The begin and chunks commit fine (no commit entry yet)…
		await gated.commit([envelopeWrite(SEED_BEGIN_KIND, begin())]);
		await gated.commit([envelopeWrite(SEED_CHUNK_KIND, chunk(1, 2, 2))]);
		// …mirror them into the readable log state.
		logEntries.push(
			{ kind: SEED_BEGIN_KIND, payload: begin() },
			{ kind: SEED_CHUNK_KIND, payload: chunk(1, 2, 2) },
		);

		// A commit entry whose root digest lies is refused before storage.
		const lying = { ...validCommit(), chunkCount: 1, count: 2, rootDigest: 'sha256:nope' };
		await expect(gated.commit([envelopeWrite(SEED_COMMIT_KIND, lying)])).rejects.toThrow(
			SeedPublicationRejectedError,
		);
		expect(committed).toHaveLength(2); // begin + chunk only — nothing published

		// The gate stays usable (validation, not storage damage): a VALID
		// commit publishes right after.
		const oneChunk = [chunk(1, 2, 2)];
		const valid: SeedCommitPayload = {
			...validCommit(),
			chunkCount: 1,
			count: 2,
			rootDigest: seedRootDigest(oneChunk.map((one) => one.digest)),
		};
		await expect(gated.commit([envelopeWrite(SEED_COMMIT_KIND, valid)])).resolves.toBe(3);
		expect(committed).toHaveLength(3);
		// The published commit parses as a valid seed commit payload.
		const published = committed[2]![0]!;
		expect(published.value).toMatchObject({
			kind: SEED_COMMIT_KIND,
			data: { v: 1, payload: valid },
		});
	});

	it('rejects a malformed commit payload with SEED_COMMIT_ENTRY_MALFORMED', async () => {
		const hook = createSeedPublicationPreCommitHook({ readLogSeedEntries: async () => [] });
		await expect(
			hook([envelopeWrite(SEED_COMMIT_KIND, { sessionId: 42 })]),
		).rejects.toMatchObject({
			code: 'SEED_COMMIT_ENTRY_MALFORMED',
		});
	});

	it('rejects a seed-commit entry without a bridge envelope', async () => {
		const hook = createSeedPublicationPreCommitHook({ readLogSeedEntries: async () => [] });
		await expect(
			hook([
				{
					type: 'entry',
					value: { id: 1, conversationId: 1, kind: SEED_COMMIT_KIND, data: { no: 'envelope' } },
				},
			]),
		).rejects.toMatchObject({ code: 'SEED_COMMIT_ENTRY_MALFORMED' });
	});

	it('round-trips the protocol payload through asSeedCommitPayload', () => {
		// The hook validates with the protocol's own parser; a payload that
		// survives it is exactly what the read side reconstructs.
		const parsed = asSeedCommitPayload(validCommit());
		expect(parsed).toEqual(validCommit());
	});
});
