#!/usr/bin/env node
// W02 G-PERF (append/open/worker): the PI Storage surface of the wave over
// the REAL sqlite-zstd backend — the full adapter (`PiSqliteZstdStorage`) and
// the single-writer composition (`gatePiStorageMutations` +
// `gatedStorageWorkerBackend`), which is what one physical storage serves in
// the product composition.
//
// What is measured (machine-readable `metric=value` lines, same conventions
// as the other benches):
//
//   pi.commitP95Ms / pi.commitP99Ms  — small pi record commits (one entry +
//     periodic task replacement per commit), the pi "append" budget.
//   pi.bigBatchCommitMs              — one commit of a ~1 MiB record batch
//     under the REAL 8 MiB admission cap (the durable-history provider's
//     DURABLE_HISTORY_BATCH_CAP_BYTES); §10 demands the ACTUAL big-batch
//     caps be measured, not declared from the old 256 KiB document.
//   pi.actualBatchCapBytes           — the cap the store was opened with.
//   pi.largestCommittedBatchBytes    — the largest batch actually committed.
//   pi.reopenMs                      — close + reopen of backend AND adapter
//     over the populated store (the I03 recovery-open path), plus a full
//     fork-chain entry scan (pi.scanEntriesMs) over every committed record.
//   piworker.enqueueP99Ms            — worker admission through the SHARED
//     single-writer gate (§10 "Enqueue p99 ≤ 1 ms" — gated in
//     thresholds.json).
//   piworker.commitP95Ms             — worker 256 KiB batch commits through
//     the same gate (§10 "256 KiB batch commit p95 ≤ 5 ms в worker" — gated
//     in thresholds.json).
//
// Corpus: synthetic-admission, same as bench-worker-commit.mjs — no session
// fixture is read; the numbers are the admission/commit profile of the pi
// path, not a history-scaling measurement.
//
// Usage: node scripts/bench/bench-pi-storage.mjs   (env PI_COMMITS=500, BATCHES=100, ENTRY_KB=64)
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (message) => {
  console.error(`bench-pi-storage: ${message}`);
  process.exit(2);
};

// Same source-mapping hook as bench-worker-commit.mjs (type stripping loads
// `.ts` sources; `.js` specifiers map onto them in-process).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const packagesRoot = fileURLToPath(new URL('../../packages', import.meta.url));
const storageWorkerUrl = pathToFileURL(join(packagesRoot, 'storage-worker/src/index.ts')).href;
const backendUrl = pathToFileURL(join(packagesRoot, 'durable-backend-sqlite-zstd/src/index.ts')).href;

const piCommits = Number(process.env.PI_COMMITS ?? 500);
const batches = Number(process.env.BATCHES ?? 100);
const entryKb = Number(process.env.ENTRY_KB ?? 64);
for (const [name, value] of [
  ['PI_COMMITS', piCommits],
  ['BATCHES', batches],
  ['ENTRY_KB', entryKb],
]) {
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer, got "${value}"`);
}

const { createStorageWorker, gatePiStorageMutations, gatedStorageWorkerBackend, sqliteZstdStorageBackend, createSingleWriterGate } =
  await import(storageWorkerUrl);
const { PiSqliteZstdStorage, SqliteZstdBackend } = await import(backendUrl);

/** The durable-history provider's admission cap (8 MiB) — the REAL seed ceiling. */
const BATCH_CAP_BYTES = 8 * 1024 * 1024;
const ROOT_CONVERSATION_ID = 1;

const percentile = (values, quantile) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
};

const dataDir = mkdtempSync(join(tmpdir(), 'bench-pi-storage-'));
try {
  const backend = SqliteZstdBackend.open(dataDir, { maxBatchUncompressedBytes: BATCH_CAP_BYTES });
  const adapter = PiSqliteZstdStorage.open(backend);
  const context = { spans: [] };
  await adapter.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);

  // --- pi record commits (append) ---------------------------------------
  const commitMs = [];
  const taskId = await adapter.mintId();
  let nextEntryId = await adapter.mintId();
  const taskRecord = (status) => ({
    id: taskId,
    conversationId: ROOT_CONVERSATION_ID,
    kind: 'bench.task',
    version: 1,
    input: {},
    state: { status, checkpoint: {} },
    background: false,
    abortRequested: false,
  });
  await adapter.commit([{ type: 'task', value: taskRecord('pending') }], context);
  for (let index = 0; index < piCommits; index += 1) {
    const entryId = nextEntryId;
    nextEntryId += 1;
    const writes = [
      { type: 'entry', value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: 'bench.user', data: { text: 'x'.repeat(1024), index } } },
    ];
    if (index % 10 === 0) writes.push({ type: 'task', value: taskRecord('running') });
    const started = performance.now();
    await adapter.commit(writes, context);
    commitMs.push(performance.now() - started);
  }
  console.log(`pi.corpus=synthetic-admission`);
  console.log(`pi.commits=${piCommits}`);
  console.log(`pi.commitP50Ms=${percentile(commitMs, 0.5).toFixed(3)}`);
  console.log(`pi.commitP95Ms=${percentile(commitMs, 0.95).toFixed(3)}`);
  console.log(`pi.commitP99Ms=${percentile(commitMs, 0.99).toFixed(3)}`);
  console.log(`pi.commitMaxMs=${Math.max(...commitMs).toFixed(3)}`);

  // --- one big batch under the real 8 MiB cap ----------------------------
  const bigText = 'y'.repeat(1024 * 1024);
  const bigWrites = [];
  for (let part = 0; part < 6; part += 1) {
    const entryId = nextEntryId;
    nextEntryId += 1;
    bigWrites.push({ type: 'entry', value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: 'bench.big', data: { text: bigText, part } } });
  }
  const bigStarted = performance.now();
  await adapter.commit(bigWrites, context);
  const bigBatchMs = performance.now() - bigStarted;
  const largestBatchBytes = bigWrites.reduce(
    (sum, write) => sum + Buffer.byteLength(JSON.stringify(write.value), 'utf8'),
    0,
  );
  console.log(`pi.actualBatchCapBytes=${BATCH_CAP_BYTES}`);
  console.log(`pi.largestCommittedBatchBytes=${largestBatchBytes}`);
  console.log(`pi.bigBatchCommitMs=${bigBatchMs.toFixed(2)}`);

  // --- close + reopen (recovery open) and a full scan --------------------
  await adapter.close(context);
  const reopenStarted = performance.now();
  const reopenedBackend = SqliteZstdBackend.open(dataDir, { maxBatchUncompressedBytes: BATCH_CAP_BYTES });
  const reopened = PiSqliteZstdStorage.open(reopenedBackend);
  const reopenMs = performance.now() - reopenStarted;
  const scanStarted = performance.now();
  const page = await reopened.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, piCommits + bigWrites.length + 10, undefined, context);
  const scanMs = performance.now() - scanStarted;
  console.log(`pi.reopenMs=${reopenMs.toFixed(2)}`);
  console.log(`pi.scanEntriesMs=${scanMs.toFixed(2)}`);
  console.log(`pi.scanEntriesItems=${page.items.length}`);
  if (page.items.length !== piCommits + bigWrites.length) fail(`scan returned ${page.items.length} of ${piCommits + bigWrites.length} records`);

  // --- the shared-gate worker (admission + 256 KiB batch commits) ---------
  const gate = createSingleWriterGate();
  const gated = gatePiStorageMutations(reopened, {}, gate);
  const worker = createStorageWorker(gatedStorageWorkerBackend(sqliteZstdStorageBackend(reopenedBackend), gate), {
    windowMs: 60_000,
    windowBytes: 256 * 1024,
    maxBatchUncompressedBytes: BATCH_CAP_BYTES,
  });
  const text = 'w'.repeat(entryKb * 1024 - 128);
  const enqueueMs = [];
  const workerCommitMs = [];
  for (let index = 0; index < batches; index += 1) {
    for (let part = 0; part < 4; part += 1) {
      const started = performance.now();
      await worker.enqueue({
        entryId: `pi-bench-${index}-${part}`,
        parentId: null,
        kind: 'pi.bench',
        payload: { text, index, part },
        bytes: entryKb * 1024,
      });
      enqueueMs.push(performance.now() - started);
    }
    const started = performance.now();
    await worker.flush();
    workerCommitMs.push(performance.now() - started);
  }
  await worker.dispose();
  console.log(`piworker.batches=${batches}`);
  console.log(`piworker.entries=${batches * 4}`);
  console.log(`piworker.entryKb=${entryKb}`);
  console.log(`piworker.enqueueP50Ms=${percentile(enqueueMs, 0.5).toFixed(3)}`);
  console.log(`piworker.enqueueP99Ms=${percentile(enqueueMs, 0.99).toFixed(3)}`);
  console.log(`piworker.enqueueMaxMs=${Math.max(...enqueueMs).toFixed(3)}`);
  console.log(`piworker.commitP50Ms=${percentile(workerCommitMs, 0.5).toFixed(2)}`);
  console.log(`piworker.commitP95Ms=${percentile(workerCommitMs, 0.95).toFixed(2)}`);
  console.log(`piworker.commitMaxMs=${Math.max(...workerCommitMs).toFixed(2)}`);
  void gated;
  await reopened.close(context);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
