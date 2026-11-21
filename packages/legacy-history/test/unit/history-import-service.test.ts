import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCas } from '@mavis/cas';
import { parseCasSpillRef } from '@mavis/cas/cas-ref';
import { SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';

import {
  ImportConflictError,
  planHistoryImports,
  resumeHistoryImport,
  runHistoryImport,
  SourceDriftError,
  verifyHistoryImport,
} from '../../src/history-import/import-service.js';
import { durableSessionDirectory, openDurableHistoryStore } from '../../src/history-import/durable-history-store.js';
import { receiptPath, readReceipt } from '../../src/history-import/receipt.js';
import {
  ensureResolvedSessionHistoryPaths,
  resolveSessionHistoryPaths,
} from '../../../local-runtime-v2/src/service/session-system/messages/history/session-history-paths.js';
import type { SessionRecord } from '../../../local-runtime-v2/src/service/session-system/sessions/repo/contract.js';
import { envelopeLine } from './tmp-session.js';

// R6 service tests on synthetic sessions: plan → run (chunked seed into an
// EXPLICIT durable root, CAS on that root) → resume after a crash between
// chunks → verify (record/turn counts, 100% CAS digest+size, revision). The
// durable log stays the authority; receipts and conflicts behave as §10.2/§10.3
// of the test architecture demand.

const SEED_BEGIN_KIND = 'history.v2.seed.begin';
const SEED_CHUNK_KIND = 'history.v2.seed.chunk';
const SEED_COMMIT_KIND = 'history.v2.seed.commit';

function userLine(messageId: string, text: string): string {
  return envelopeLine({
    message_id: messageId,
    turn_id: '3f7d9c2e-1a4b-4c8d-9e2f-5a6b7c8d9e01',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1760755230000 },
  });
}

function assistantLine(messageId: string, text: string): string {
  return envelopeLine({
    message_id: messageId,
    turn_id: '3f7d9c2e-1a4b-4c8d-9e2f-5a6b7c8d9e02',
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: 1760755230001 },
  });
}

function imageLine(messageId: string, base64: string): string {
  return envelopeLine({
    message_id: messageId,
    turn_id: '3f7d9c2e-1a4b-4c8d-9e2f-5a6b7c8d9e03',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', data: base64 },
      ],
      timestamp: 1760755230002,
    },
  });
}

/** ~300-byte records; with a 1 KiB chunk budget every ~3 records make a chunk. */
function syntheticLines(): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    lines.push(userLine(`msg-${String(index)}`, `question ${String(index)} ${'x'.repeat(220)}`));
    lines.push(assistantLine(`msg-a-${String(index)}`, `answer ${String(index)} ${'y'.repeat(220)}`));
  }
  return lines;
}

async function writeSession(sourceRoot: string, sessionId: string, lines: readonly string[]): Promise<string> {
  const dir = join(sourceRoot, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  return dir;
}

/** Raw (id, kind) pairs of the durable log, in order. */
function logKinds(durableRoot: string, sessionId: string): { id: string; kind: string }[] {
  const backend = SqliteZstdBackend.open(join(durableRoot, 'durable-history', 'sessions', sessionId), { readonly: true });
  try {
    return backend
      .readDelta(0, 256 * 1024 * 1024)
      .map((entry) => ({ id: entry.id, kind: entry.kind }));
  } finally {
    backend.close();
  }
}

interface TempPaths {
  readonly sourceRoot: string;
  readonly durableRoot: string;
  dispose: () => Promise<void>;
}

async function tempPaths(prefix: string): Promise<TempPaths> {
  const sourceRoot = await mkdtemp(join(tmpdir(), `${prefix}-src-`));
  const durableRoot = await mkdtemp(join(tmpdir(), `${prefix}-root-`));
  return {
    sourceRoot,
    durableRoot,
    dispose: async () => {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(durableRoot, { recursive: true, force: true });
    },
  };
}

function runtimeSession(dataDir: string, sessionId: string) {
  const session: SessionRecord = {
    sessionId, agentName: 'mavis', workspaceDir: dataDir, runtime: 'pi-agent', sessionType: 'root',
    sessionKind: 'conversation', archived: false, status: 'started', sessionOrigin: 'local-runtime',
    sessionDataVersion: 4, createdAtMs: 1, updatedAtMs: 1,
  };
  return ensureResolvedSessionHistoryPaths(resolveSessionHistoryPaths(dataDir, session), session);
}

describe('history import service (R6)', () => {
  it('plans legacy sessions from a single dir or a parent of session dirs', async () => {
    const paths = await tempPaths('plan');
    try {
      const single = await writeSession(paths.sourceRoot, 'session-single', syntheticLines());
      expect(await planHistoryImports(single)).toMatchObject([
        { sessionId: 'session-single', records: 20, malformedLines: 0 },
      ]);

      await writeSession(paths.sourceRoot, 'session-other', [userLine('msg-0', 'tiny')]);
      const planned = await planHistoryImports(paths.sourceRoot);
      expect(planned.map((entry) => entry.sessionId)).toEqual(['session-other', 'session-single']);
      expect(planned[1]?.bytes).toBeGreaterThan(0);
    } finally {
      await paths.dispose();
    }
  });

  it('imports a real dated directory under its full logical session ID', async () => {
    const paths = await tempPaths('dated-id');
    try {
      // The writer truncates the encoded dirname after 180 base64url characters.
      const id = '../session/' + 's'.repeat(200);
      const source = runtimeSession(paths.sourceRoot, id);
      await writeFile(source.messages, userLine('msg-0', 'dated') + '\n');
      const options = { sourceDir: source.sessionDir, durableRoot: paths.durableRoot };
      expect(await planHistoryImports(source.sessionDir)).toMatchObject([{ sessionId: id }]);
      expect(await runHistoryImport(options)).toMatchObject({ sessionId: id, status: 'imported' });
      expect(await verifyHistoryImport(options)).toMatchObject({ sessionId: id, ok: true });
      expect(await readReceipt(receiptPath(paths.durableRoot, id))).toMatchObject({ sessionId: id });
      expect(await readdir(join(paths.durableRoot, 'history-import'))).toEqual(['by-id']);
      // Different full IDs can project to the same 180-character durable folder.
      const collision = runtimeSession(paths.sourceRoot + '/other', id + 'other');
      await writeFile(collision.messages, userLine('msg-1', 'other') + '\n');
      await expect(runHistoryImport({ sourceDir: collision.sessionDir, durableRoot: paths.durableRoot }))
        .rejects.toThrow(/already contains session/);
      expect(await verifyHistoryImport(options)).toMatchObject({ sessionId: id, ok: true });
    } finally {
      await paths.dispose();
    }
  });

  it('resumes and verifies earlier basename imports even after losing their receipt', async () => {
    const paths = await tempPaths('dated-legacy');
    try {
      const source = runtimeSession(paths.sourceRoot, 'original-session');
      const physicalName = basename(source.sessionDir);
      await writeFile(source.messages, syntheticLines().join('\n') + '\n');
      const manifest = await readFile(source.manifest);
      await unlink(source.manifest);
      const options = { sourceDir: source.sessionDir, durableRoot: paths.durableRoot, chunkTargetBytes: 1024 };
      await expect(runHistoryImport({ ...options, failAfterChunks: 1 })).rejects.toThrow();
      await writeFile(source.manifest, manifest);
      expect(await resumeHistoryImport(options)).toMatchObject({ sessionId: physicalName, status: 'imported' });
      await unlink(receiptPath(paths.durableRoot, physicalName));
      expect(await verifyHistoryImport(options)).toMatchObject({ sessionId: physicalName, ok: true });
      expect(await runHistoryImport(options)).toMatchObject({ sessionId: physicalName, status: 'already-imported' });
      expect(await readdir(join(paths.durableRoot, 'durable-history', 'sessions'))).toEqual([physicalName]);
    } finally {
      await paths.dispose();
    }
  });

  it('rejects mismatched and unsafe manifest IDs before touching the destination', async () => {
    const paths = await tempPaths('dated-invalid');
    try {
      for (const id of ['valid-id', 'unroutable|id']) {
        const source = runtimeSession(paths.sourceRoot, id);
        await writeFile(source.messages, userLine('msg-0', 'dated') + '\n');
        if (id === 'valid-id') {
          const value = JSON.parse(await readFile(source.manifest, 'utf8'));
          await writeFile(source.manifest, JSON.stringify({ ...value, sessionId: 'other-id' }));
        }
        await expect(runHistoryImport({ sourceDir: source.sessionDir, durableRoot: paths.durableRoot }))
          .rejects.toThrow(/identity/i);
      }
      expect(await readdir(paths.durableRoot)).toEqual([]);
    } finally {
      await paths.dispose();
    }
  });

  it('runs a chunked import with CAS externalization, then verifies it', async () => {
    const paths = await tempPaths('run');
    try {
      const source = await writeSession(paths.sourceRoot, 'session-run', [
        ...syntheticLines(),
        imageLine('msg-image', 'F'.repeat(64 * 1024)),
      ]);
      const progress: string[] = [];
      const result = await runHistoryImport({
        sourceDir: source,
        durableRoot: paths.durableRoot,
        chunkTargetBytes: 1024,
        onProgress: (event) => {
          if (event.kind === 'seed-chunk') progress.push(`chunk ${String(event.chunkNo)}`);
        },
      });

      expect(result.status).toBe('imported');
      expect(progress.length).toBeGreaterThanOrEqual(2);
      // Durable protocol: begin → chunks → commit, all under the explicit root.
      const kinds = logKinds(paths.durableRoot, 'session-run').map((entry) => entry.kind);
      expect(kinds[0]).toBe(SEED_BEGIN_KIND);
      expect(kinds.at(-1)).toBe(SEED_COMMIT_KIND);
      expect(kinds.filter((kind) => kind === SEED_CHUNK_KIND).length).toBeGreaterThanOrEqual(2);

      // The image lives in the CAS of the target root, the record carries a ref.
      const cas = await openCas(paths.durableRoot);
      const receipt = (await readReceipt(receiptPath(paths.durableRoot, 'session-run')))!;
      expect(receipt.state).toBe('complete');
      expect(receipt.counts.imagesStored).toBe(1);
      expect(receipt.revision).toMatch(/^sha256:/);

      // Verify: counts, id order, revision, and the CAS reference at 100%.
      const report = await verifyHistoryImport({ sourceDir: source, durableRoot: paths.durableRoot });
      expect(report.ok).toBe(true);
      expect(report.source.records).toBe(21);
      expect(report.durable.records).toBe(21);
      expect(report.counts).toEqual({ recordsMatch: true, turnsMatch: true, idOrderMatch: true });
      expect(report.cas).toMatchObject({ references: 1, verified: 1, failed: [] });
      expect(report.revisionMatch).toBe(true);
    } finally {
      await paths.dispose();
    }
  }, 60_000);

  it('reports an absent import without creating the target root', async () => {
    const paths = await tempPaths('verify-absent');
    try {
      const sourceDir = await writeSession(paths.sourceRoot, 'absent', [userLine('msg-0', 'hello')]);
      const durableRoot = join(paths.durableRoot, 'absent');
      const report = await verifyHistoryImport({ sourceDir, durableRoot });
      expect(report.ok).toBe(false);
      expect(report.issues).toContain(`no seed import for absent in ${durableRoot}`);
      await expect(stat(durableRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await paths.dispose();
    }
  });

  it('verifies a live session without taking ownership or sweeping CAS staging files', async () => {
    const paths = await tempPaths('verify-live');
    try {
      const sessionId = 'live';
      const sourceDir = await writeSession(paths.sourceRoot, sessionId, [imageLine('msg-image', 'F'.repeat(64 * 1024))]);
      await runHistoryImport({ sourceDir, durableRoot: paths.durableRoot });
      const stale = join(paths.durableRoot, 'tmp', 'staged');
      await writeFile(stale, 'staged bytes');
      await utimes(stale, 0, 0);
      const writer = openDurableHistoryStore(paths.durableRoot, { sessionId });
      try {
        const report = await verifyHistoryImport({ sourceDir, durableRoot: paths.durableRoot });
        expect(report.ok).toBe(true);
        expect(report.cas).toMatchObject({ references: 1, verified: 1 });
        expect(await readFile(stale, 'utf8')).toBe('staged bytes');
      } finally {
        await writer.dispose();
      }
    } finally {
      await paths.dispose();
    }
  });

  it('checks a legacy monolith only when the session has no generation of its own', async () => {
    const paths = await tempPaths('verify-legacy');
    try {
      const sessionId = 'legacy';
      const sourceDir = await writeSession(paths.sourceRoot, sessionId, [userLine('msg-0', 'hello')]);
      await runHistoryImport({
        sourceDir, durableRoot: paths.durableRoot, keepImagesInline: true,
        openStore: openDurableHistoryStore,
      });
      const report = await verifyHistoryImport({ sourceDir, durableRoot: paths.durableRoot });
      expect(report.ok).toBe(true);
      expect(await readdir(paths.durableRoot)).not.toContain('cas');
      const directory = durableSessionDirectory(paths.durableRoot, sessionId);
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'sessions.g1.db'), 'corrupt session database');
      await expect(verifyHistoryImport({ sourceDir, durableRoot: paths.durableRoot })).rejects.toThrow();
    } finally {
      await paths.dispose();
    }
  });

  it('imports twice as once: the second run is a no-op', async () => {
    const paths = await tempPaths('twice');
    try {
      const source = await writeSession(paths.sourceRoot, 'session-twice', syntheticLines());
      const first = await runHistoryImport({
        sourceDir: source,
        durableRoot: paths.durableRoot,
        chunkTargetBytes: 1024,
      });
      const headsAfterFirst = logKinds(paths.durableRoot, 'session-twice').length;

      const second = await runHistoryImport({
        sourceDir: source,
        durableRoot: paths.durableRoot,
        chunkTargetBytes: 1024,
      });
      expect(second.status).toBe('already-imported');
      expect(logKinds(paths.durableRoot, 'session-twice').length).toBe(headsAfterFirst);
      expect(second.receipt.revision).toBe(first.receipt.revision);
    } finally {
      await paths.dispose();
    }
  });

  it('resumes after a crash between chunks with parity and without duplicates', async () => {
    const paths = await tempPaths('resume');
    const reference = await tempPaths('resume-ref');
    try {
      const lines = syntheticLines();
      const source = await writeSession(paths.sourceRoot, 'session-resume', lines);
      const referenceSource = await writeSession(reference.sourceRoot, 'session-resume', lines);

      // Reference: an uninterrupted import of the same content.
      const referenceRun = await runHistoryImport({
        sourceDir: referenceSource,
        durableRoot: reference.durableRoot,
        chunkTargetBytes: 1024,
      });
      const referenceIds = logKinds(reference.durableRoot, 'session-resume').map((entry) => entry.id);

      // Crash: the import dies after two committed chunks.
      await expect(
        runHistoryImport({
          sourceDir: source,
          durableRoot: paths.durableRoot,
          chunkTargetBytes: 1024,
          failAfterChunks: 2,
        }),
      ).rejects.toThrow(/simulated crash/);
      const kindsAfterCrash = logKinds(paths.durableRoot, 'session-resume').map((entry) => entry.kind);
      expect(kindsAfterCrash).toContain(SEED_BEGIN_KIND);
      expect(kindsAfterCrash).not.toContain(SEED_COMMIT_KIND);
      // The receipt cursor names the last confirmed chunk.
      const crashedReceipt = (await readReceipt(receiptPath(paths.durableRoot, 'session-resume')))!;
      expect(crashedReceipt.cursor.chunkNo).toBe(2);

      // Corrupt the receipt cursor (chunkNo far past the crash, records
      // zeroed): the receipt is a convenience cursor, the durable log is the
      // authority (§10.2) — resume must re-derive the confirmed chunk cursor
      // from the log and ignore whatever numbers the receipt carries.
      await writeFile(
        receiptPath(paths.durableRoot, 'session-resume'),
        `${JSON.stringify({ ...crashedReceipt, cursor: { chunkNo: 99, records: 0 } }, null, 2)}\n`,
        'utf8',
      );

      // Resume: completes the protocol and matches the uninterrupted import —
      // same revision, same entry-id sequence (no chunk was re-sent).
      const resumed = await resumeHistoryImport({
        sourceDir: source,
        durableRoot: paths.durableRoot,
        chunkTargetBytes: 1024,
      });
      expect(resumed.status).toBe('imported');
      expect(resumed.receipt.revision).toBe(referenceRun.receipt.revision);
      expect(logKinds(paths.durableRoot, 'session-resume').map((entry) => entry.id)).toEqual(referenceIds);

      // The resulting receipt cursor is rebuilt from the log: the real chunk
      // count of the committed import, not the corrupted 99/0 it started from.
      const finalChunkCount = logKinds(paths.durableRoot, 'session-resume').filter(
        (entry) => entry.kind === SEED_CHUNK_KIND,
      ).length;
      expect(finalChunkCount).toBeGreaterThan(2);
      expect(resumed.receipt.cursor.chunkNo).toBe(finalChunkCount);
      expect(resumed.receipt.cursor.records).toBe(referenceRun.receipt.cursor.records);

      const report = await verifyHistoryImport({ sourceDir: source, durableRoot: paths.durableRoot });
      expect(report.ok).toBe(true);
    } finally {
      await paths.dispose();
      await reference.dispose();
    }
  }, 60_000);

  it('refuses to resume when the source drifted from the receipt', async () => {
    const paths = await tempPaths('drift');
    try {
      const source = await writeSession(paths.sourceRoot, 'session-drift', syntheticLines());
      await expect(
        runHistoryImport({
          sourceDir: source,
          durableRoot: paths.durableRoot,
          chunkTargetBytes: 1024,
          failAfterChunks: 1,
        }),
      ).rejects.toThrow(/simulated crash/);

      const changed = [...syntheticLines(), userLine('msg-extra', 'drift')];
      await writeFile(join(source, 'messages.jsonl'), `${changed.join('\n')}\n`, 'utf8');
      await expect(
        resumeHistoryImport({ sourceDir: source, durableRoot: paths.durableRoot }),
      ).rejects.toBeInstanceOf(SourceDriftError);
    } finally {
      await paths.dispose();
    }
  });

  it('conflicts explicitly when a crashed import meets a changed source', async () => {
    const paths = await tempPaths('conflict');
    try {
      const source = await writeSession(paths.sourceRoot, 'session-conflict', syntheticLines());
      await expect(
        runHistoryImport({
          sourceDir: source,
          durableRoot: paths.durableRoot,
          chunkTargetBytes: 1024,
          failAfterChunks: 1,
        }),
      ).rejects.toThrow(/simulated crash/);

      // Without the receipt the fingerprint check cannot run; the durable log
      // still refuses the foreign import id.
      await rm(join(paths.durableRoot, 'history-import'), { recursive: true, force: true });
      const changed = [...syntheticLines(), userLine('msg-extra', 'different revision')];
      await writeFile(join(source, 'messages.jsonl'), `${changed.join('\n')}\n`, 'utf8');
      await expect(
        runHistoryImport({ sourceDir: source, durableRoot: paths.durableRoot }),
      ).rejects.toBeInstanceOf(ImportConflictError);
    } finally {
      await paths.dispose();
    }
  });

  it('reports CAS failures instead of passing silently', async () => {
    const paths = await tempPaths('tamper');
    try {
      const source = await writeSession(paths.sourceRoot, 'session-tamper', [
        ...syntheticLines(),
        imageLine('msg-image', 'F'.repeat(64 * 1024)),
      ]);
      await runHistoryImport({
        sourceDir: source,
        durableRoot: paths.durableRoot,
        chunkTargetBytes: 1024,
      });

      const healthy = await verifyHistoryImport({ sourceDir: source, durableRoot: paths.durableRoot });
      expect(healthy.ok).toBe(true);
      expect(healthy.cas).toMatchObject({ references: 1, verified: 1, failed: [] });

      // Remove the stored blob, then verify must fail the CAS check loudly.
      const cas = await openCas(paths.durableRoot);
      // The image is the last source record, so byte-sized chunking places it
      // in a later chunk — scan every seed chunk for the externalized ref.
      const chunkEntries = logKinds(paths.durableRoot, 'session-tamper').filter(
        (entry) => entry.kind === SEED_CHUNK_KIND,
      );
      expect(chunkEntries.length).toBeGreaterThan(1);
      const blob = ((): string => {
        for (const chunkEntry of chunkEntries) {
          const payload = readChunkPayload(paths.durableRoot, 'session-tamper', chunkEntry.id);
          for (const envelope of payload.envelopes) {
            const content = (envelope as { message?: { content?: unknown } }).message?.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if ((block as { type?: unknown })?.type === 'image_ref') {
                return (block as { blob: string }).blob;
              }
            }
          }
        }
        throw new Error('imported chunk holds no image_ref');
      })();
      const parts = parseCasSpillRef(blob);
      expect(parts).not.toBeNull();
      await unlink(cas.pathFor(parts!.sha256));

      const tampered = await verifyHistoryImport({ sourceDir: source, durableRoot: paths.durableRoot });
      expect(tampered.ok).toBe(false);
      expect(tampered.cas.verified).toBe(0);
      expect(tampered.cas.failed).toHaveLength(1);
    } finally {
      await paths.dispose();
    }
  }, 60_000);

  it('fails strict on a malformed source and reports the failure in the receipt', async () => {
    const paths = await tempPaths('strict');
    try {
      const source = await writeSession(paths.sourceRoot, 'session-broken', [
        userLine('msg-0', 'fine'),
        'not-json-at-all',
      ]);
      await expect(
        runHistoryImport({ sourceDir: source, durableRoot: paths.durableRoot }),
      ).rejects.toThrow();
      const receipt = (await readReceipt(receiptPath(paths.durableRoot, 'session-broken')))!;
      expect(receipt.state).toBe('failed');
      // Nothing partial was published.
      expect(logKinds(paths.durableRoot, 'session-broken').map((entry) => entry.kind)).not.toContain(SEED_COMMIT_KIND);
    } finally {
      await paths.dispose();
    }
  });
});

/** Reads one chunk entry's payload back from the durable log by entry id. */
function readChunkPayload(durableRoot: string, sessionId: string, entryId: string): { envelopes: unknown[] } {
  const backend = SqliteZstdBackend.open(join(durableRoot, 'durable-history', 'sessions', sessionId), { readonly: true });
  try {
    const entry = backend
      .readDelta(0, 256 * 1024 * 1024)
      .find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`chunk entry ${entryId} not found`);
    return entry.payload as { envelopes: unknown[] };
  } finally {
    backend.close();
  }
}

function revisionOf(receipt: { revision?: string }): string {
  if (receipt.revision === undefined) throw new Error('receipt has no revision');
  return receipt.revision;
}

// Keep the store helper referenced: the tests above read the log directly, but
// an import must never leave a store open — one explicit lifecycle check.
describe('durable history store lifecycle', () => {
  it('opens the log directory inside the explicit root and disposes cleanly', async () => {
    const paths = await tempPaths('store');
    try {
      const store = openDurableHistoryStore(paths.durableRoot);
      expect(store.directory.startsWith(paths.durableRoot)).toBe(true);
      await store.dispose();
      await store.dispose(); // idempotent
    } finally {
      await paths.dispose();
    }
  });

  it('reads a receipt only from where it was written', async () => {
    const paths = await tempPaths('receipt');
    try {
      expect(await readReceipt(receiptPath(paths.durableRoot, 'absent'))).toBeUndefined();
      const raw = await readFile(receiptPath(paths.durableRoot, 'absent'), 'utf8').catch(
        () => 'missing',
      );
      expect(raw).toBe('missing');
    } finally {
      await paths.dispose();
    }
  });
});
