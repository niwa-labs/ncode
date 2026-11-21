/**
 * W02-T: the FULL A+B composition over one physical storage — the wave-exit
 * integration run part B deferred ("Склейка полного цикла A+B",
 * state/w02-part-b.md §4.3).
 *
 * Composition under test, exactly as the wave ships it:
 *   SqliteZstdBackend (8 MiB admission cap, mirroring the durable-history
 *   provider's DURABLE_HISTORY_BATCH_CAP_BYTES) → PiSqliteZstdStorage (part A)
 *   → gatePiStorageMutations (part B) with BOTH pre-commit validators — the
 *   CAS publish-before-reference check and the seed publication gate — and a
 *   storage worker sharing the SAME single-writer gate for mcode appends;
 *   the seed travels as bridge envelopes through the seam's pi storage port.
 *
 * W02-T axes proven here:
 * - seed >8 MiB СУММАРНО: a chunked seed whose total exceeds the 8 MiB
 *   admission ceiling commits through the composition in real 6 MiB-target
 *   chunks and publishes only via a validated commit;
 * - oversized single record: one record at/over the hard cap fails
 *   controlled — nothing partial is published, the failure is FINAL for the
 *   writer (pi storage semantics: the shared gate poisons), and a fresh
 *   composition over the same directory continues cleanly;
 * - seed publication only при validated commit: a lying root digest is
 *   rejected BEFORE storage (nothing durable, the gate stays usable);
 * - CAS publish-before-reference inside the real cycle (I09);
 * - restart/resume без дублей (V-D04): close → reopen via the persisted
 *   bridge conversation id → resume chunk numbering exactly where the
 *   durable log confirms; re-feeding a confirmed chunk breaks the scanner
 *   (duplicate chunks can never publish);
 * - one physical storage, one writer: a worker append interleaves with pi
 *   commits through the shared gate without damage;
 * - I13: the whole cycle writes NOTHING under the legacy home (~/.minimax*).
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openCas, type CasStore } from '@mavis/cas';
import { PiSqliteZstdStorage, SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import {
	openPiStorageDurableLogPort,
	type PiStorageLogPort,
	type PortEntryDraft,
} from '@mavis/durable-seam';
import {
	createSingleWriterGate,
	createStorageWorker,
	gatedStorageWorkerBackend,
	gatePiStorageMutations,
	PiWriterFailedError,
	sqliteZstdStorageBackend,
	type SingleWriterGate,
	type StorageWorker,
} from '@mavis/storage-worker';
import { afterAll, describe, expect, it } from 'vitest';

import {
	createCasPreCommitValidator,
	createSeedPublicationPreCommitHook,
	createSeedScan,
	deriveSeedImportId,
	isSeedKind,
	SeedChunker,
	seedBeginEntryId,
	seedChunkEntryId,
	seedCommitEntryId,
	type SeedCommitPayload,
	type SeedChunkPlan,
	SEED_BEGIN_KIND,
	SEED_CHUNK_HARD_CAP_BYTES,
	SEED_CHUNK_KIND,
	SEED_COMMIT_KIND,
	SEED_MAPPING_VERSION,
	seedRootDigest,
	stitchSeedImport,
	type SeedEnvelope,
	type SeedLogEntry,
} from '../../src/index.js';

const context = BACKGROUND_CONTEXT;

/** The durable-history provider's admission cap (8 MiB) — the REAL seed ceiling. */
const BATCH_CAP_BYTES = 8 * 1024 * 1024;

const directories: string[] = [];

afterAll(() => {
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function freshDirectory(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	directories.push(dir);
	return dir;
}

/** ~100 KiB text envelope; `extra` rides inside the message content. */
function envelope(index: number, extra?: string): SeedEnvelope {
	const base = extra === undefined ? 'x'.repeat(100 * 1024) : `${'x'.repeat(1024)} ${extra}`;
	return {
		message_id: `msg-${String(index)}`,
		turn_id: `turn-${String(index)}`,
		message: { role: 'user', content: base, timestamp: 1760750000000 + index },
	};
}

function totalEnvelopeBytes(envelopes: readonly SeedEnvelope[]): number {
	return envelopes.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0);
}

/** Cut a full state into chunk plans with the protocol's single chunker. */
function cutAll(
	sessionId: string,
	importId: string,
	envelopes: readonly SeedEnvelope[],
	options: {
	 readonly startChunkNo?: number;
	 readonly startCursor?: number;
	 readonly targetBytes?: number;
	} = {},
): SeedChunkPlan[] {
	const chunker = new SeedChunker({ sessionId, importId, ...options });
	const cuts: SeedChunkPlan[] = [];
	for (const item of envelopes) {
		const cut = chunker.add(item);
		if (cut !== null) cuts.push(cut);
	}
	const tail = chunker.finish();
	if (tail !== null) cuts.push(tail);
	return cuts;
}

interface Composition {
	backend: SqliteZstdBackend;
	storage: PiSqliteZstdStorage;
	port: PiStorageLogPort;
	worker: StorageWorker;
	gate: SingleWriterGate;
	cas: CasStore;
	/** Seed entries the durable log already holds, oldest first. */
	readLogSeedEntries: () => Promise<SeedLogEntry[]>;
	close: () => Promise<void>;
}

/** The wave's composition: one gate, both pre-commit validators, one worker. */
async function openComposition(
	directory: string,
	conversationId: number | null,
): Promise<Composition> {
	const backend = SqliteZstdBackend.open(directory, { maxBatchUncompressedBytes: BATCH_CAP_BYTES });
	const storage = PiSqliteZstdStorage.open(backend);
	const cas = await openCas(join(directory, 'cas'));
	const gate = createSingleWriterGate();

	const portRef: { current: PiStorageLogPort | null } = { current: null };
	const readLogSeedEntries = async (): Promise<SeedLogEntry[]> => {
		const port = portRef.current;
		if (port === null) return [];
		const delta = port.readDeltaChecked(0, 512 * 1024 * 1024);
		return delta.entries
			.filter((portEntry) => isSeedKind(portEntry.kind))
			.map((portEntry) => ({ kind: portEntry.kind, payload: portEntry.payload }));
	};

	// Both pre-commit validators run inside the single-writer gate, before
	// any durable attempt: CAS publish-before-reference (I09) first, then the
	// seed publication gate.
	const casValidate = createCasPreCommitValidator(cas);
	const seedGate = createSeedPublicationPreCommitHook({ readLogSeedEntries });
	const onBeforeCommit = async (writes: readonly object[]): Promise<void> => {
		await casValidate(writes as never);
		await seedGate(writes as never);
	};

	const gated = gatePiStorageMutations(storage, { onBeforeCommit }, gate);
	const port = await openPiStorageDurableLogPort(gated as never, {
		...(conversationId !== null ? { conversationId } : {}),
	});
	portRef.current = port;
	const worker = createStorageWorker(gatedStorageWorkerBackend(sqliteZstdStorageBackend(backend), gate));

	return {
		backend,
		storage,
		port,
		worker,
		gate,
		cas,
		readLogSeedEntries,
		close: async () => {
			await worker.dispose();
			await storage.close(context);
		},
	};
}

/**
 * Seed protocol payloads cross the port's structural `JsonValue` boundary
 * here (the protocol interfaces have no index signatures): one explicit,
 * documented cast at this single boundary — the payloads are JSON by
 * construction.
 */
function draft(id: string, kind: string, payload: unknown): PortEntryDraft {
	return { id, kind, payload: payload as PortEntryDraft['payload'] };
}

function beginDraft(sessionId: string, importId: string, fingerprint: string, count: number) {
	return draft(seedBeginEntryId(sessionId, importId), SEED_BEGIN_KIND, {
			sessionId,
			importId,
			sourceFingerprint: fingerprint,
			mappingVersion: SEED_MAPPING_VERSION,
			expectedCount: count,
			reason: 'seed',
	});
}

function chunkDraft(sessionId: string, importId: string, plan: SeedChunkPlan) {
	return draft(seedChunkEntryId(sessionId, importId, plan.chunkNo, plan.digest), SEED_CHUNK_KIND, {
		sessionId,
		importId,
		chunkNo: plan.chunkNo,
		sourceCursor: plan.sourceCursor,
		count: plan.count,
		digest: plan.digest,
		envelopes: plan.envelopes,
	});
}

describe('W02 full cycle: gated pi storage + seed publication + CAS over sqlite-zstd', () => {
	it('commits a >8 MiB chunked seed, publishes only validated commits, and resumes without duplicates', async () => {
		const previousHome = process.env.HOME;
		const directory = freshDirectory('pi-seed-full-cycle-');
		const legacyHome = freshDirectory('pi-seed-legacy-home-');
		process.env.HOME = legacyHome;
		try {
			const sessionId = 'session-full-cycle';
			const envelopes = Array.from({ length: 90 }, (_, index) => envelope(index));
			// >8 MiB total with the REAL 6 MiB chunk target: at least 2 chunks.
			expect(totalEnvelopeBytes(envelopes)).toBeGreaterThan(8 * 1024 * 1024);

			const composition = await openComposition(directory, null);
			const importId = deriveSeedImportId({
				sessionId,
				reason: 'seed',
				sourceFingerprint: 'fingerprint-1',
				mappingVersion: SEED_MAPPING_VERSION,
			});

			const chunkPlans = cutAll(sessionId, importId, envelopes);
			expect(chunkPlans.length).toBeGreaterThanOrEqual(2);
			for (const plan of chunkPlans) {
				expect(plan.entryBytes).toBeLessThan(SEED_CHUNK_HARD_CAP_BYTES);
			}
			const committedBytes = chunkPlans.reduce((sum, plan) => sum + plan.entryBytes, 0);
			expect(committedBytes).toBeGreaterThan(8 * 1024 * 1024);

			await composition.port.appendBatch([beginDraft(sessionId, importId, 'fingerprint-1', envelopes.length)]);

			// A lying commit BEFORE any chunk exists must be refused by the
			// publication gate — nothing durable, the gate stays usable.
			const lyingCommit: SeedCommitPayload = {
				sessionId,
				importId,
				chunkCount: 1,
				count: 1,
				activeRevision: 'rev-1',
				rootDigest: seedRootDigest(['deadbeef']),
				casManifestDigest: null,
			};
			await expect(
				composition.port.appendBatch([
					draft(seedCommitEntryId(sessionId, importId), SEED_COMMIT_KIND, lyingCommit),
				]),
			).rejects.toThrow(/Seed publication gate/);
			expect(composition.port.head()).toBe(1);

			// Chunk 1 commits; then the process "restarts" (close everything).
			await composition.port.appendBatch([chunkDraft(sessionId, importId, chunkPlans[0]!)]);
			const bridgeConversationId = composition.port.bridgedConversationId;
			expect(bridgeConversationId).not.toBeNull();
			await composition.close();

			// --- reopen via the persisted bridge conversation (root-resolver) --
			const resumed = await openComposition(directory, bridgeConversationId);
			const logSeedEntries = await resumed.readLogSeedEntries();
			const scanner = createSeedScan();
			for (const entry of logSeedEntries) scanner.onEntry(entry);
			const confirmedChunks = scanner.scan.last?.chunks.length ?? 0;
			expect(confirmedChunks).toBe(1);

			// Re-feeding the confirmed chunk breaks the scanner: duplicates can
			// never publish — resume MUST skip confirmed chunks.
			expect(() => scanner.onEntry(logSeedEntries[logSeedEntries.length - 1]!)).toThrow();

			// Resume exactly where the durable log confirms: the remaining
			// chunks cut identically from the confirmed cursor.
			const remaining = cutAll(sessionId, importId, envelopes.slice(chunkPlans[0]!.sourceCursor), {
				startChunkNo: confirmedChunks + 1,
				startCursor: chunkPlans[0]!.sourceCursor,
			});
			expect(remaining.length).toBe(chunkPlans.length - 1);
			for (const plan of remaining) {
				await resumed.port.appendBatch([chunkDraft(sessionId, importId, plan)]);
			}

			// The validated commit publishes the base.
			const validCommit: SeedCommitPayload = {
				sessionId,
				importId,
				chunkCount: chunkPlans.length,
				count: envelopes.length,
				activeRevision: 'rev-1',
				rootDigest: seedRootDigest(chunkPlans.map((plan) => plan.digest)),
				casManifestDigest: null,
			};
			await resumed.port.appendBatch([
				draft(seedCommitEntryId(sessionId, importId), SEED_COMMIT_KIND, validCommit),
			]);

			// Whole-log verification: one begin, every chunk once, one adopted commit.
			const finalEntries = await resumed.readLogSeedEntries();
			const finalScan = createSeedScan();
			for (const entry of finalEntries) finalScan.onEntry(entry);
			const imported = finalScan.scan.last!;
			expect(imported.chunks).toHaveLength(chunkPlans.length);
			expect(imported.commit).toEqual(validCommit);
			expect(stitchSeedImport(imported)).toEqual(envelopes);
			expect(finalEntries.filter((entry) => entry.kind === SEED_CHUNK_KIND)).toHaveLength(chunkPlans.length);

			// A worker append shares the same physical storage through the same
			// gate: both streams coexist, the bridge log holds only port entries.
			const headBefore = resumed.port.head();
			await resumed.worker.enqueue({
				entryId: 'mcode-side-entry',
				parentId: null,
				kind: 'mcode.note',
				payload: { worker: true },
				bytes: 32,
			});
			await resumed.worker.flush();
			expect(resumed.port.head()).toBe(headBefore);
			const backendEntries = resumed.backend.readDelta(0, 512 * 1024 * 1024);
			expect(backendEntries.some((backendEntry) => backendEntry.id === 'mcode-side-entry')).toBe(true);
			expect(backendEntries.some((backendEntry) => backendEntry.id.startsWith('pi.entry.'))).toBe(true);

			await resumed.close();

			// I13: the whole cycle wrote nothing under the legacy home.
			expect(readdirSync(legacyHome)).toEqual([]);
		} finally {
			if (previousHome !== undefined) process.env.HOME = previousHome;
		}
	}, 120_000);

	it('fails an oversized single record controlled and finally (nothing partial, fresh composition continues)', async () => {
		const directory = freshDirectory('pi-seed-oversized-');
		const sessionId = 'session-oversized';
		const composition = await openComposition(directory, null);
		const importId = deriveSeedImportId({
			sessionId,
			reason: 'seed',
			sourceFingerprint: 'fingerprint-2',
			mappingVersion: SEED_MAPPING_VERSION,
		});

		await composition.port.appendBatch([beginDraft(sessionId, importId, 'fingerprint-2', 1)]);
		const bridgeConversationId = composition.port.bridgedConversationId;
		expect(bridgeConversationId).not.toBeNull();

		// One record whose serialized entry reaches the hard cap: the chunker
		// cuts it as a single-record chunk; the commit fails at the backend's
		// admission cap with NOTHING durable (no partial publication).
		const oversized = envelope(0, 'y'.repeat(SEED_CHUNK_HARD_CAP_BYTES));
		const [cut] = cutAll(sessionId, importId, [oversized], { targetBytes: 1024 });
		expect(cut!.entryBytes).toBeGreaterThanOrEqual(SEED_CHUNK_HARD_CAP_BYTES);
		const headBefore = composition.port.head();

		await expect(
			composition.port.appendBatch([chunkDraft(sessionId, importId, cut!)]),
		).rejects.toThrow();
		expect(composition.port.head()).toBe(headBefore);
		const seedEntries = await composition.readLogSeedEntries();
		expect(seedEntries.filter((entry) => entry.kind === SEED_CHUNK_KIND)).toHaveLength(0);

		// The storage failure is FINAL for this writer (pi semantics): the
		// shared gate is poisoned, fail-closed for every co-writer.
		expect(composition.gate.failed).toBe(true);
		await expect(composition.gate.run(async () => 1)).rejects.toBeInstanceOf(PiWriterFailedError);
		await composition.close();

		// A fresh composition over the same directory continues cleanly (the
		// bridge conversation is handed back — the root-resolver contract):
		// the failed attempt left no partial state (the import is still open).
		const fresh = await openComposition(directory, bridgeConversationId);
		const entries = await fresh.readLogSeedEntries();
		const scan = createSeedScan();
		for (const entry of entries) scan.onEntry(entry);
		expect(scan.scan.last?.commit).toBeUndefined();
		expect(scan.scan.last?.chunks).toHaveLength(0);
		const [smallCut] = cutAll(sessionId, importId, [envelope(1)]);
		await fresh.port.appendBatch([chunkDraft(sessionId, importId, smallCut!)]);
		expect(fresh.port.head()).toBeGreaterThan(headBefore);
		await fresh.close();
	}, 120_000);

	it('enforces CAS publish-before-reference inside the real cycle (I09)', async () => {
		const directory = freshDirectory('pi-seed-cas-');
		const blob = new Uint8Array(64);
		const digest = createHash('sha256').update(blob).digest('hex');
		const casRef = `cas://sha256/${digest}#64`;

		const composition = await openComposition(directory, null);

		// The commit referencing an UNPUBLISHED blob is rejected before any
		// durable attempt.
		await expect(
			composition.port.appendBatch([draft('seed-cas-ref-1', SEED_BEGIN_KIND, { ref: casRef })]),
		).rejects.toThrow(/not published yet/);
		expect(composition.port.head()).toBe(0);

		// Publish the blob, then the same commit passes — the explicit
		// publish-and-retry recovery path.
		const published = await composition.cas.putBytes(blob);
		expect(published.sha256).toBe(digest);
		await composition.port.appendBatch([draft('seed-cas-ref-2', SEED_BEGIN_KIND, { ref: casRef })]);
		expect(composition.port.getEntry('seed-cas-ref-2')).toBeDefined();
		await composition.close();
	}, 60_000);
});
