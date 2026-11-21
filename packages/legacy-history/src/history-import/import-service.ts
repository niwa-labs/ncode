/**
 * The shared import service behind the history-import CLI (integration plan
 * R6 — the CLI is a thin shell over these operations, test architecture
 * §10.3). One source session (a legacy mcode v2 `messages.jsonl`) is imported
 * into one EXPLICITLY given durable root:
 *
 *   fingerprint → receipt (pending) → CAS externalization (hooks on the same
 *   root) → streaming legacy-history read → canonical decode → chunked seed
 *   (begin/chunk/commit of `seed-protocol.ts`, flushed per chunk) → receipt
 *   complete.
 *
 * Honesty rules this module keeps:
 * - the durable log is the authority; the receipt is a convenience cursor —
 *   resume re-derives the confirmed chunk cursor from the log and only
 *   cross-checks the receipt's source fingerprint;
 * - `--root` is always caller-supplied; nothing here resolves a default root;
 * - a source whose fingerprint changed between runs stops with an explicit
 *   drift error, never silently re-imports;
 * - records are canonically decoded before entering a chunk (strict — a
 *   malformed source fails the import; §10.5);
 * - resume skips exactly the records covered by confirmed chunks (the record
 *   cursor of the streaming reader IS the record index), so the CAS hook and
 *   the counters only ever see the unconfirmed suffix;
 * - progress is observed counters only.
 *
 * Memory note (honest MVP): the source FILE is streamed and each chunk is
 * flushed before the next is queued, but the fresh canonical records are held
 * for the end-of-run revision — the same O(session) the runtime's own seed
 * path costs. A bounded-memory revision hasher is follow-up work.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { openCas } from '@mavis/cas';
import { parseCasSpillRef } from '@mavis/cas/cas-ref';
import { createLogger } from '@mavis/logging';

import type { CanonicalHistoryEnvelope } from '@mavis/local-runtime-v2/canonical-history';

import {
  decodeCanonicalHistoryEnvelope,
  canonicalActiveHistoryRevision,
} from './canonical-revision.js';
import {
  openDurableHistoryStore,
  readDurableLogEntries,
  type DurableHistoryStore,
} from './durable-history-store.js';
import {
  beginReceipt,
  readReceipt,
  receiptPath,
  writeReceipt,
  type HistoryImportReceipt,
} from './receipt.js';
import {
  createSeedScan,
  deriveSeedImportId,
  isSeedKind,
  SeedChunker,
  seedBeginEntryId,
  seedChunkEntryId,
  seedCommitEntryId,
  seedEntrySizeBytes,
  SEED_BEGIN_KIND,
  SEED_CHUNK_HARD_CAP_BYTES,
  SEED_CHUNK_KIND,
  SEED_COMMIT_KIND,
  SEED_MAPPING_VERSION,
  seedRootDigest,
  stitchSeedImport,
  type SeedBeginPayload,
  type SeedChunkPayload,
  type SeedChunkPlan,
  type SeedCommitPayload,
  type SeedImportScan,
} from './seed-protocol.js';
import {
  V2_MESSAGES_FILE,
  openV2Session,
  type CasIssueListener,
  type V2ImportTarget,
} from '../index.js';

const log = createLogger('mcode:adapter');
const storageLog = createLogger('mcode:storage');

// -- plan --------------------------------------------------------------------

/** One legacy session found by `plan`. */
export interface ImportPlanEntry {
  readonly sessionId: string;
  readonly dir: string;
  readonly messagesPath: string;
  /** Source byte length (stat snapshot of the same scan). */
  readonly bytes: number;
  /** Records counted by the validated streaming scan. */
  readonly records: number;
  /** Records that failed envelope validation (import would fail strict). */
  readonly malformedLines: number;
}

/**
 * Lists the legacy v2 sessions under `sourceDir`: either the directory is
 * itself a session (holds `messages.jsonl`) or its immediate child
 * directories are scanned. Read-only.
 */
export async function planHistoryImports(sourceDir: string): Promise<readonly ImportPlanEntry[]> {
  const direct = join(sourceDir, V2_MESSAGES_FILE);
  if (await fileExists(direct)) {
    return [await planEntry(sourceDir)];
  }
  const children = await readdir(sourceDir, { withFileTypes: true });
  const sessions: ImportPlanEntry[] = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const dir = join(sourceDir, child.name);
    if (await fileExists(join(dir, V2_MESSAGES_FILE))) sessions.push(await planEntry(dir));
  }
  sessions.sort((left, right) => (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0));
  return sessions;
}

async function planEntry(dir: string): Promise<ImportPlanEntry> {
  const stats = await openV2Session(dir).stats({ validate: true });
  return {
    sessionId: basename(resolve(dir)),
    dir,
    messagesPath: join(dir, V2_MESSAGES_FILE),
    bytes: stats.bytes,
    records: stats.lines,
    malformedLines: stats.malformedLines,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// -- fingerprint -------------------------------------------------------------

/** Content fingerprint of one source history. */
export interface SourceFingerprint {
  readonly bytes: number;
  readonly sha256: string;
}

/** Streams the source file once for its byte length and SHA-256. */
export async function fingerprintSource(messagesPath: string): Promise<SourceFingerprint> {
  const { createReadStream } = await import('node:fs');
  const input = createReadStream(messagesPath);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of input) {
      const data = chunk as Buffer;
      bytes += data.length;
      hash.update(data);
    }
  } finally {
    input.destroy();
  }
  return { bytes, sha256: hash.digest('hex') };
}

// -- run / resume ------------------------------------------------------------

/** Progress events of a run; every field is an observed counter. */
export type ImportProgressEvent =
  | {
      readonly kind: 'source';
      readonly phase: 'scan' | 'complete';
      readonly bytesRead: number;
      readonly totalBytes?: number;
      readonly recordsRead: number;
      readonly recordsDelivered: number;
      readonly imagesSeen: number;
      readonly imagesStored: number;
      readonly sourceCursor: number;
      readonly elapsedMs: number;
    }
  | { readonly kind: 'seed-begin'; readonly importId: string; readonly expectedCount: number }
  | {
      readonly kind: 'seed-chunk';
      readonly chunkNo: number;
      readonly bytes: number;
      readonly entries: number;
      readonly sourceCursor: number;
    }
  | {
      readonly kind: 'seed-commit';
      readonly chunks: number;
      readonly entries: number;
      readonly bytes: number;
      readonly revision: string;
    };

export interface RunHistoryImportOptions {
  /** Session directory holding the legacy `messages.jsonl`. */
  readonly sourceDir: string;
  /** EXPLICIT durable root (mandatory; no default is ever resolved). */
  readonly durableRoot: string;
  /** Receipt location override; default is inside the target root. */
  readonly receipt?: string;
  /** Keep image blocks inline (`cas: null`) instead of CAS at the root. */
  readonly keepImagesInline?: boolean;
  /** Records per target delivery batch (the legacy-history default applies when unset). */
  readonly batchRecords?: number;
  /** Chunk budget override (protocol default ~6 MiB; small values are for tests). */
  readonly chunkTargetBytes?: number;
  readonly onProgress?: (event: ImportProgressEvent) => void;
  readonly onIssue?: CasIssueListener;
  /**
   * Test seam only: throw AFTER this many fresh chunks committed (a controlled
   * crash between chunks — flushed chunks stay durable for a resume).
   */
  readonly failAfterChunks?: number;
  /** Test seam only: store factory override. */
  readonly openStore?: (durableRoot: string) => DurableHistoryStore;
}

export interface RunHistoryImportResult {
  readonly sessionId: string;
  readonly importId: string;
  readonly status: 'imported' | 'already-imported';
  readonly receipt: HistoryImportReceipt;
}

/** The open import belongs to a different import id — an explicit conflict. */
export class ImportConflictError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly openImportId: string,
    readonly attemptedImportId: string,
  ) {
    super(message);
    this.name = 'ImportConflictError';
  }
}

/** The source changed since the receipt was written — an explicit stop. */
export class SourceDriftError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly receiptSha256: string,
    readonly currentSha256: string,
  ) {
    super(message);
    this.name = 'SourceDriftError';
  }
}

/** Runs (or resumes) the import of one session into one explicit root. */
export async function runHistoryImport(
  options: RunHistoryImportOptions & { readonly requireResumable?: boolean },
): Promise<RunHistoryImportResult> {
  const sourceDir = resolve(options.sourceDir);
  const durableRoot = resolve(options.durableRoot);
  const sessionId = basename(sourceDir);
  const messagesPath = join(sourceDir, V2_MESSAGES_FILE);
  if (!(await fileExists(messagesPath))) {
    throw new Error(`No legacy v2 history at ${messagesPath}; --source must be a session directory`);
  }
  const fingerprint = await fingerprintSource(messagesPath);
  const importId = deriveSeedImportId({
    sessionId,
    reason: 'seed',
    sourceFingerprint: fingerprint.sha256,
    mappingVersion: SEED_MAPPING_VERSION,
  });
  const receiptFile = options.receipt ?? receiptPath(durableRoot, sessionId);

  // Receipt cross-check (R6: resume reads its cursor context here; the durable
  // log below remains the authority for what actually committed).
  const existingReceipt = await readReceipt(receiptFile);
  if (existingReceipt) {
    if (existingReceipt.source.sha256 !== fingerprint.sha256) {
      throw new SourceDriftError(
        `Source of ${sessionId} changed since the receipt was written (${short(existingReceipt.source.sha256)} → ${short(fingerprint.sha256)}); resume refused`,
        sessionId,
        existingReceipt.source.sha256,
        fingerprint.sha256,
      );
    }
    if (resolve(existingReceipt.durableRoot) !== durableRoot) {
      throw new Error(
        `Receipt ${receiptFile} belongs to root ${existingReceipt.durableRoot}, not ${durableRoot}`,
      );
    }
  }

  const store = (options.openStore ?? ((root: string) => openDurableHistoryStore(root, { sessionId })))(
    durableRoot,
  );
  try {
    const logScan = await scanSessionSeeds(store, sessionId);
    const lastImport = logScan.scan.last;
    if (lastImport?.commit && lastImport.importId === importId) {
      // Already imported: publish the completing receipt from the commit.
      const committed = lastImport.commit;
      const receipt: HistoryImportReceipt = {
        ...(existingReceipt ??
          beginReceipt({
            sessionId,
            sourceDir,
            messagesPath,
            fingerprint,
            durableRoot,
            durableDirectory: store.directory,
            casRoot: durableRoot,
            importId,
            nowMs: Date.now(),
          })),
        state: 'complete',
        importId,
        cursor: {
          chunkNo: lastImport.chunks.length,
          records: committed.count,
          ...(lastImport.chunks.length > 0
            ? { digest: lastImport.chunks[lastImport.chunks.length - 1]?.digest }
            : {}),
        },
        chunks: {
          committed: lastImport.chunks.length,
          bytes: existingReceipt?.chunks.bytes ?? 0,
          entries: committed.count,
        },
        counts: {
          records: committed.count,
          imagesStored: existingReceipt?.counts.imagesStored ?? 0,
          imagesInline: existingReceipt?.counts.imagesInline ?? 0,
        },
        revision: committed.activeRevision,
        rootDigest: committed.rootDigest,
        updatedAtMs: Date.now(),
        completedAtMs: existingReceipt?.completedAtMs ?? Date.now(),
      };
      await writeReceipt(receiptFile, receipt);
      return { sessionId, importId, status: 'already-imported', receipt };
    }
    if (lastImport && !lastImport.commit && lastImport.importId !== importId) {
      throw new ImportConflictError(
        `Durable root ${durableRoot} holds an unfinished import (${lastImport.importId}) for ${sessionId}; the source fingerprint now derives ${importId}. Finish or discard the open import explicitly.`,
        sessionId,
        lastImport.importId,
        importId,
      );
    }
    if (options.requireResumable && !(lastImport && !lastImport.commit)) {
      throw new Error(
        `Nothing to resume for ${sessionId} in ${durableRoot}: the durable log has no unfinished seed import and no pending receipt`,
      );
    }
    // Resume only an UNFINISHED import of the SAME id; a committed import from
    // an earlier source version is published history — a new run starts its
    // own import.
    const open = lastImport && !lastImport.commit ? lastImport : undefined;

    const confirmedChunks = open?.chunks ?? [];
    const confirmedRecords = confirmedChunks.reduce((sum, chunk) => sum + chunk.count, 0);
    let lastEntryId = logScan.lastEntryId;
    let chunkCommits = 0;
    let freshChunkCount = 0;
    let freshChunkBytes = 0;
    const freshDigests: string[] = [];

    let receipt: HistoryImportReceipt = existingReceipt ??
      beginReceipt({
        sessionId,
        sourceDir,
        messagesPath,
        fingerprint,
        durableRoot,
        durableDirectory: store.directory,
        casRoot: durableRoot,
        importId,
        nowMs: Date.now(),
      });
    if (!existingReceipt) {
      // §10.3: the receipt appears at begin with state 'pending' and is
      // durable before any log write, so a crash right after the begin still
      // leaves a traceable receipt for resume; a resumed run keeps its
      // on-disk state and flips straight to 'running'.
      await writeReceipt(receiptFile, receipt);
    }
    receipt = { ...receipt, state: 'running', importId, updatedAtMs: Date.now() };
    await writeReceipt(receiptFile, receipt);

    if (!open) {
      // expectedCount stays 0 on the streaming path: the record count is not
      // known before the scan; the durable chunk digests are the resume check.
      const beginPayload: SeedBeginPayload = {
        sessionId,
        importId,
        sourceFingerprint: fingerprint.sha256,
        mappingVersion: SEED_MAPPING_VERSION,
        expectedCount: 0,
        reason: 'seed',
      };
      const entryId = seedBeginEntryId(sessionId, importId);
      const bytes = seedEntrySizeBytes(entryId, SEED_BEGIN_KIND, beginPayload, lastEntryId);
      await store.worker.enqueue({
        entryId,
        parentId: lastEntryId,
        kind: SEED_BEGIN_KIND,
        payload: beginPayload,
        bytes,
      });
      lastEntryId = entryId;
      await store.worker.flush();
      storageLog.info('seed begin', {
        sessionId,
        importId,
        reason: 'seed',
        sourceSha256: fingerprint.sha256,
        bytes,
      });
      options.onProgress?.({
        kind: 'seed-begin',
        importId,
        expectedCount: beginPayload.expectedCount,
      });
    }

    const chunker = new SeedChunker({
      sessionId,
      importId,
      ...(options.chunkTargetBytes === undefined ? {} : { targetBytes: options.chunkTargetBytes }),
      startChunkNo: confirmedChunks.length + 1,
      startCursor: confirmedRecords,
    });
    const freshRecords: CanonicalHistoryEnvelope[] = [];

    const writeChunk = async (plan: SeedChunkPlan): Promise<void> => {
      if (options.failAfterChunks !== undefined && chunkCommits >= options.failAfterChunks) {
        // Controlled crash between chunks: flushed chunks stay durable; the
        // receipt's cursor names the last confirmed one.
        throw new Error(
          `simulated crash between seed chunks (after ${String(chunkCommits)} committed chunks of ${sessionId})`,
        );
      }
      const payload: SeedChunkPayload = {
        sessionId,
        importId,
        chunkNo: plan.chunkNo,
        sourceCursor: plan.sourceCursor,
        count: plan.count,
        digest: plan.digest,
        envelopes: plan.envelopes,
      };
      const entryId = seedChunkEntryId(sessionId, importId, plan.chunkNo, plan.digest);
      const bytes = seedEntrySizeBytes(entryId, SEED_CHUNK_KIND, payload, lastEntryId);
      if (bytes >= SEED_CHUNK_HARD_CAP_BYTES) {
        throw new Error(
          `Seed record of ${sessionId} serializes to ${String(bytes)} bytes and reaches the admission cap ${String(SEED_CHUNK_HARD_CAP_BYTES)}; the import stops controlled, nothing partial is published`,
        );
      }
      await store.worker.enqueue({
        entryId,
        parentId: lastEntryId,
        kind: SEED_CHUNK_KIND,
        payload,
        bytes,
      });
      lastEntryId = entryId;
      // Durability barrier and confirmed cursor BEFORE the next chunk (§10.2).
      await store.worker.flush();
      chunkCommits += 1;
      freshChunkCount += 1;
      freshChunkBytes += bytes;
      freshDigests.push(plan.digest);
      receipt = {
        ...receipt,
        state: 'running',
        cursor: { chunkNo: plan.chunkNo, records: plan.sourceCursor, digest: plan.digest },
        chunks: {
          committed: confirmedChunks.length + freshChunkCount,
          bytes: receipt.chunks.bytes + bytes,
          entries: receipt.chunks.entries + plan.count,
        },
        counts: { ...receipt.counts, records: plan.sourceCursor },
        updatedAtMs: Date.now(),
      };
      await writeReceipt(receiptFile, receipt);
      storageLog.info('seed chunk', {
        sessionId,
        importId,
        chunkNo: plan.chunkNo,
        bytes,
        entries: plan.count,
        cursor: plan.sourceCursor,
      });
      options.onProgress?.({
        kind: 'seed-chunk',
        chunkNo: plan.chunkNo,
        bytes,
        entries: plan.count,
        sourceCursor: plan.sourceCursor,
      });
    };

    const target: V2ImportTarget = {
      putEntry: async () => {
        throw new Error('history import target requires batch delivery');
      },
      putEntries: async (envelopes) => {
        for (const envelope of envelopes) {
          // Strict canonical decode before anything enters a chunk (§10.5):
          // the decoder is the single validation authority.
          const canonical = decodeCanonicalHistoryEnvelope(envelope);
          freshRecords.push(canonical);
          const closed = chunker.add(canonical);
          if (closed) await writeChunk(closed);
        }
      },
    };

    try {
      const stats = await openV2Session(sourceDir).importTo(target, {
        // Default ON: images are externalized into the CAS of the EXPLICIT
        // target root (`<root>/cas/<aa>/...`); `keepImagesInline` passes null.
        cas: options.keepImagesInline ? null : durableRoot,
        // Resume cursor: the reader's record index IS the record number, so
        // the confirmed record count skips exactly the durable prefix. The
        // CAS hook and the counters below only see the fresh suffix.
        resumeAfterLine: confirmedRecords,
        ...(options.batchRecords === undefined ? {} : { batchSize: options.batchRecords }),
        onIssue: options.onIssue,
        onProgress: (progress) => {
          options.onProgress?.({
            kind: 'source',
            phase: progress.phase,
            bytesRead: progress.bytesRead,
            ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
            recordsRead: progress.recordsRead,
            recordsDelivered: progress.recordsDelivered,
            imagesSeen: progress.imagesSeen,
            imagesStored: progress.imagesStored,
            sourceCursor: progress.sourceCursor,
            elapsedMs: progress.elapsedMs,
          });
        },
      });

      const tail = chunker.finish();
      if (tail) await writeChunk(tail);

      // The full base = confirmed chunks (durable) ++ fresh records. The
      // revision comes from the canonical authority the runtime validates
      // against — the importer never restates the algorithm.
      const baseRecords =
        confirmedChunks.length > 0
          ? [
              // The confirmed prefix is re-read from the durable chunks and
              // re-decoded (revalidated) before it feeds the revision.
              ...stitchSeedImport({
                importId,
                begin: open!.begin, // confirmedChunks imply an open import
                chunks: confirmedChunks,
              }).map((record) => decodeCanonicalHistoryEnvelope(record)),
              ...freshRecords,
            ]
          : freshRecords;
      const revision = canonicalActiveHistoryRevision(baseRecords);
      const commitPayload: SeedCommitPayload = {
        sessionId,
        importId,
        chunkCount: confirmedChunks.length + freshChunkCount,
        count: baseRecords.length,
        activeRevision: revision,
        rootDigest: seedRootDigest([
          ...confirmedChunks.map((chunk) => chunk.digest),
          ...freshDigests,
        ]),
        casManifestDigest: null,
      };
      const commitId = seedCommitEntryId(sessionId, importId);
      const commitBytes = seedEntrySizeBytes(commitId, SEED_COMMIT_KIND, commitPayload, lastEntryId);
      await store.worker.enqueue({
        entryId: commitId,
        parentId: lastEntryId,
        kind: SEED_COMMIT_KIND,
        payload: commitPayload,
        bytes: commitBytes,
      });
      await store.worker.flush();
      storageLog.info('seed commit', {
        sessionId,
        importId,
        chunks: commitPayload.chunkCount,
        entries: commitPayload.count,
        bytes: freshChunkBytes + commitBytes,
        revision,
      });
      options.onProgress?.({
        kind: 'seed-commit',
        chunks: commitPayload.chunkCount,
        entries: commitPayload.count,
        bytes: freshChunkBytes + commitBytes,
        revision,
      });

      const complete: HistoryImportReceipt = {
        ...receipt,
        state: 'complete',
        cursor: {
          chunkNo: commitPayload.chunkCount,
          records: commitPayload.count,
          ...(freshDigests.length > 0
            ? { digest: freshDigests[freshDigests.length - 1] }
            : confirmedChunks.length > 0
              ? { digest: confirmedChunks[confirmedChunks.length - 1]?.digest }
              : {}),
        },
        chunks: {
          committed: commitPayload.chunkCount,
          bytes: receipt.chunks.bytes + commitBytes,
          entries: commitPayload.count,
        },
        counts: {
          records: commitPayload.count,
          // This run's counters cover only the fresh suffix (the confirmed
          // prefix was skipped); previous runs' counters live in the receipt.
          imagesStored: (existingReceipt?.counts.imagesStored ?? 0) + stats.imagesMigrated,
          imagesInline: (existingReceipt?.counts.imagesInline ?? 0) + stats.imagesInline,
        },
        revision,
        rootDigest: commitPayload.rootDigest,
        updatedAtMs: Date.now(),
        completedAtMs: Date.now(),
      };
      await writeReceipt(receiptFile, complete);
      log.info('import run complete', {
        sessionId,
        importId,
        records: commitPayload.count,
        chunks: commitPayload.chunkCount,
        images: stats.imageBlocks,
      });
      return { sessionId, importId, status: 'imported', receipt: complete };
    } catch (error) {
      // The receipt reports the failure; already-flushed chunks and the
      // receipt cursor stay resumable (the durable log remains authoritative).
      await writeReceipt(receiptFile, {
        ...receipt,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAtMs: Date.now(),
      }).catch(() => {
        // The original error outranks a failing receipt write.
      });
      throw error;
    }
  } finally {
    await store.dispose();
  }
}

/** Resumes the import named by the receipt of an explicit root. */
export async function resumeHistoryImport(
  options: RunHistoryImportOptions,
): Promise<RunHistoryImportResult> {
  return runHistoryImport({ ...options, requireResumable: true });
}

/**
 * The last seed import of one session in the durable log, plus the last entry
 * id of the session (the parent chain continues from it).
 */
async function scanSessionSeeds(
  store: DurableHistoryStore,
  sessionId: string,
): Promise<{ readonly scan: { readonly last?: SeedImportScan }; readonly lastEntryId: string | null }> {
  const entries = await readDurableLogEntries(store.backend);
  const scan = createSeedScan();
  let lastEntryId: string | null = null;
  for (const entry of entries) {
    if (sessionIdOfPayload(entry.payload) !== sessionId) continue;
    lastEntryId = entry.id;
    if (!isSeedKind(entry.kind)) continue;
    scan.onEntry({ id: entry.id, kind: entry.kind, payload: entry.payload });
  }
  return { scan: scan.scan, lastEntryId };
}

function sessionIdOfPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return undefined;
  return (payload as { sessionId?: unknown }).sessionId;
}

function short(sha256: string): string {
  return `${sha256.slice(0, 12)}…`;
}

// -- verify ------------------------------------------------------------------

export interface ImportVerificationReport {
  readonly sessionId: string;
  readonly durableRoot: string;
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly source: {
    readonly bytes: number;
    readonly sha256: string;
    readonly records: number;
    readonly turns: number;
  };
  readonly durable: {
    readonly records: number;
    readonly turns: number;
    readonly chunks: number;
    readonly importId?: string;
    readonly revision?: string;
    readonly rootDigest?: string;
  };
  readonly counts: {
    readonly recordsMatch: boolean;
    readonly turnsMatch: boolean;
    readonly idOrderMatch: boolean;
  };
  /** 100% target: every image_ref resolves to bytes with the exact digest+size. */
  readonly cas: {
    readonly references: number;
    readonly verified: number;
    readonly failed: readonly { readonly digest: string; readonly reason: string }[];
  };
  readonly revisionMatch: boolean;
}

export interface VerifyHistoryImportOptions {
  readonly sourceDir: string;
  readonly durableRoot: string;
  readonly keepImagesInline?: boolean;
  /** Test seam only: store factory override. */
  readonly openStore?: (durableRoot: string) => DurableHistoryStore;
}

/**
 * Read-only verification of one imported session: record/turn counts, identity
 * order, revision of the committed base, and EVERY `image_ref` resolved
 * against the CAS with digest and size (the 100% CAS check). The verifier
 * reads the committed chunks back through the shared protocol scanner and the
 * canonical decoder — the importer's own serialization is never the oracle.
 */
export async function verifyHistoryImport(
  options: VerifyHistoryImportOptions,
): Promise<ImportVerificationReport> {
  const sourceDir = resolve(options.sourceDir);
  const durableRoot = resolve(options.durableRoot);
  const sessionId = basename(sourceDir);
  const messagesPath = join(sourceDir, V2_MESSAGES_FILE);
  const issues: string[] = [];
  const fingerprint = await fingerprintSource(messagesPath);

  const sourceIds: string[] = [];
  const sourceTurns = new Set<string>();
  await openV2Session(sourceDir).readEnvelopes((envelope) => {
    sourceIds.push(envelope.message_id);
    sourceTurns.add(envelope.turn_id);
  });

  // Verify reads the session's OWN file first (the per-session layout), and
  // falls back to the legacy monolith for imports made before 2026-11-18.
  const openVerifyStore = () => {
    try {
      return openDurableHistoryStore(durableRoot, { sessionId, readonly: true });
    } catch {
      return openDurableHistoryStore(durableRoot, { readonly: true });
    }
  };
  const store = (options.openStore ?? openVerifyStore)(durableRoot);
  try {
    const { scan } = await scanSessionSeeds(store, sessionId);
    const open = scan.last;
    const commit = open?.commit;
    if (!open || !commit) {
      issues.push(
        open
          ? `seed import ${open.importId} has no commit — the base is not published`
          : `no seed import for ${sessionId} in ${durableRoot}`,
      );
    }
    const durableRecords: CanonicalHistoryEnvelope[] = open
      ? stitchSeedImport(open).map((record) => decodeCanonicalHistoryEnvelope(record))
      : [];
    if (open && commit) {
      const rootDigest = seedRootDigest(open.chunks.map((chunk) => chunk.digest));
      if (rootDigest !== commit.rootDigest) {
        issues.push(`commit rootDigest mismatch: commit ${commit.rootDigest}, chunks ${rootDigest}`);
      }
    }
    const revision = canonicalActiveHistoryRevision(durableRecords);
    const revisionMatch = commit !== undefined && commit.activeRevision === revision;
    if (commit && !revisionMatch) {
      issues.push(
        `commit revision ${commit.activeRevision} does not match the durable records (${revision})`,
      );
    }

    const durableIds = durableRecords.map((record) => record.message_id);
    const durableTurns = new Set(durableRecords.map((record) => record.turn_id));
    const recordsMatch = durableRecords.length === sourceIds.length;
    const turnsMatch = durableTurns.size === sourceTurns.size;
    const idOrderMatch = recordsMatch && durableIds.every((id, index) => id === sourceIds[index]);
    if (!recordsMatch) {
      issues.push(
        `record count differs: source ${String(sourceIds.length)}, durable ${String(durableRecords.length)}`,
      );
    }
    if (!turnsMatch) {
      issues.push(`turn count differs: source ${String(sourceTurns.size)}, durable ${String(durableTurns.size)}`);
    }
    if (!idOrderMatch) issues.push('record identity order differs from the source');

    // CAS 100%: every image_ref must resolve with the exact digest and size.
    const casFailures: { digest: string; reason: string }[] = [];
    let casReferences = 0;
    let casVerified = 0;
    if (!options.keepImagesInline) {
      const cas = await openCas(durableRoot);
      const seen = new Set<string>();
      for (const record of durableRecords) {
        const content = record.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (
            block === null ||
            typeof block !== 'object' ||
            (block as { type?: unknown }).type !== 'image_ref'
          ) {
            continue;
          }
          const blob = (block as { blob?: unknown }).blob;
          if (typeof blob !== 'string') continue;
          const parts = parseCasSpillRef(blob);
          if (parts === null) {
            casFailures.push({ digest: blob.slice(0, 48), reason: 'non-canonical cas reference' });
            continue;
          }
          if (seen.has(parts.sha256)) continue;
          seen.add(parts.sha256);
          casReferences += 1;
          try {
            await cas.get(parts.sha256, { expectedSize: parts.size });
            casVerified += 1;
          } catch (error) {
            casFailures.push({
              digest: parts.sha256,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      if (casFailures.length > 0) {
        issues.push(
          `${String(casFailures.length)} of ${String(casReferences)} CAS references failed verification`,
        );
      }
    }

    return {
      sessionId,
      durableRoot,
      ok: issues.length === 0,
      issues,
      source: {
        bytes: fingerprint.bytes,
        sha256: fingerprint.sha256,
        records: sourceIds.length,
        turns: sourceTurns.size,
      },
      durable: {
        records: durableRecords.length,
        turns: durableTurns.size,
        chunks: open?.chunks.length ?? 0,
        ...(open ? { importId: open.importId } : {}),
        ...(commit ? { revision: commit.activeRevision, rootDigest: commit.rootDigest } : {}),
      },
      counts: { recordsMatch, turnsMatch, idOrderMatch },
      cas: { references: casReferences, verified: casVerified, failed: casFailures },
      revisionMatch,
    };
  } finally {
    await store.dispose();
  }
}
