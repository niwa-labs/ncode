/**
 * Runtime verification of the per-session durable stores (owner decision
 * 2026-11-18): TWO REAL node processes write DIFFERENT sessions on ONE
 * shared dataDir concurrently — the scenario the single-log era refused at
 * boot — plus a third-process handover of an exited runtime's session.
 *
 * Children run through tsx from the local-runtime-v2 package directory (the
 * @mavis/* workspace links resolve there); the parent only coordinates and
 * checks the file layout.
 *
 * Usage: node scripts/verify-per-session-stores.mjs  → exit 0 = PASS.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = fileURLToPath(new URL('..', import.meta.url));
const packageDir = join(srcRoot, 'packages', 'local-runtime-v2');
const storesModule = join(
  packageDir,
  'src',
  'service',
  'session-system',
  'messages',
  'history',
  'durable-session-stores.ts',
);

/**
 * Child mode (argv[2]): `write <dataDir> <sessionId> <tag>` — open stores,
 * claim + enqueue + flush the session, verify the read path, exit 0.
 */
const WRITE_CODE = `
import { createDurableHistoryStores } from ${JSON.stringify(storesModule)};
const [, , dataDir, sessionId, tag] = process.argv;
const stores = await createDurableHistoryStores({ dataDir, ownsSystemRoot: false });
try {
  const opened = await stores.sessionStores(sessionId);
  await opened.worker.enqueue({
    entryId: sessionId + '|verify|' + tag,
    parentId: null,
    kind: 'verify.append',
    payload: { sessionId, tag },
    bytes: 64,
  });
  await stores.worker.flush();
  const backend = await stores.backendForRead(sessionId);
  const own = backend.readDelta(0, 1024 * 1024).filter((e) => !e.kind.startsWith('pi.'));
  // The session may already hold entries from an earlier owner (the handover
  // scenario): what matters is that THIS process's entry is durably there.
  if (!own.some((e) => e.id === sessionId + '|verify|' + tag)) {
    throw new Error('own entry missing after flush; history entries: ' + own.length);
  }
  if (!stores.hasSessionFile(sessionId)) throw new Error('own file not visible after claim');
  console.log('OK ' + sessionId);
} finally {
  await stores.dispose();
}
`;

function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      ['--import', join(srcRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'), '-e', WRITE_CODE, '--', ...args],
      { cwd: packageDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (error) => resolve({ code: -1, out: '', err: String(error) }));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

function currentGenerationOf(directory) {
  if (!existsSync(directory)) return 0;
  let highest = 0;
  for (const name of readdirSync(directory)) {
    const match = /^sessions\.g(\d+)\.db$/.exec(name);
    const parsed = match ? Number(match[1]) : Number.NaN;
    if (Number.isSafeInteger(parsed) && parsed > highest) highest = parsed;
  }
  return highest;
}

function sessionDirOf(dataDir, sessionId) {
  return join(dataDir, 'durable-history', 'sessions', sessionId);
}

const dataDir = mkdtempSync(join(tmpdir(), 'verify-per-session-'));
let failure;
try {
  // Two REAL processes, one dataDir, different sessions, concurrent.
  const [a, b] = await Promise.all([
    runChild(['write', dataDir, 'session-verify-a', 'alpha']),
    runChild(['write', dataDir, 'session-verify-b', 'beta']),
  ]);
  for (const [label, child] of [['A', a], ['B', b]]) {
    if (child.code !== 0) {
      console.error(`child ${label} failed (exit ${String(child.code)}):\n${child.err.slice(-4000)}`);
      failure = `child ${label} exited ${String(child.code)}`;
    } else if (!child.out.includes('OK')) {
      failure = `child ${label} produced no OK marker`;
    }
  }
  // Both per-session files exist.
  for (const sessionId of ['session-verify-a', 'session-verify-b']) {
    if (currentGenerationOf(sessionDirOf(dataDir, sessionId)) !== 1) {
      failure = `missing own session file for ${sessionId}`;
    }
  }
  // The legacy monolith was never created (no system owner anywhere).
  if (currentGenerationOf(join(dataDir, 'durable-history')) !== 0) {
    failure = 'the legacy monolith was created without a system owner';
  }
  // A THIRD process claims session A's file after A exited: the handover
  // appends on top of the claimed file (2 history entries after both runs).
  const handover = await runChild(['write', dataDir, 'session-verify-a', 'handover']);
  if (handover.code !== 0) {
    console.error(`child handover failed:\n${handover.err.slice(-4000)}`);
    failure = 'the post-exit handover claim was refused';
  }
  if (failure === undefined) {
    console.log('VERIFY-PER-SESSION-STORES: PASS (two processes coexisted; per-session files; handover OK)');
  } else {
    console.error(`VERIFY-PER-SESSION-STORES: FAIL — ${failure}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
