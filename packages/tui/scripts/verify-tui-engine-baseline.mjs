#!/usr/bin/env node
// Independent verifier for the MCode TUI engine baseline (see UPSTREAM.md).
//
//   node packages/tui/scripts/verify-tui-engine-baseline.mjs --upstream-root /path/to/pi/packages/tui/src
//
// Checks, all locally:
//   1. BASELINE.json files[]: per-file upstreamSha256 against the upstream checkout and
//      adaptedSha256 against the engine tree.
//   2. Tree digests: sha256 over sorted "<path>\n<sha256>\n" blocks — upstreamTreeDigest over
//      upstreamSha256, adaptedTreeDigest over adaptedSha256 (BASELINE.rebase.digestAlgorithm).
//   3. localSourceFiles: existence + adaptedSha256.
//   4. Coverage: every engine *.ts file is accounted for by files[] or localSourceFiles.
//   5. LOCAL_CHANGES.json: re-anchored to the current adaptedTreeDigest; every listed file exists
//      with a matching currentSha256; every changeId appears in LOCAL_CHANGES.md; L010 stays retired.
//   6. Ledger completeness: every files[] entry whose local content diverges from the pin beyond the
//      L001 NodeNext import rewrite must carry a LOCAL_CHANGES.json entry (numbered or unnumbered),
//      files that are pin-identical or import-only must not, and localSourceFiles always need one.
//
// Exit code 0 = all checks green; 1 = any mismatch. Node stdlib only.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
  return false;
}
function ok(message) {
  console.log(`ok   ${message}`);
  return true;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--upstream-root' || arg === '--engine-root') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      args[arg.slice(2)] = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args['upstream-root']) throw new Error('--upstream-root /path/to/pi/packages/tui/src is required');
  return args;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const treeDigest = (entries, key) =>
  sha256(
    Buffer.from(
      [...entries]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((entry) => `${entry.path}\n${entry[key]}\n`)
        .join(''),
    ),
  );

async function listTypeScriptFiles(root, prefix = '') {
  const out = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...(await listTypeScriptFiles(path.join(root, item.name), rel)));
    else if (item.name.endsWith('.ts')) out.push(rel);
  }
  return out.sort();
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv);
const engineRoot = args['engine-root'] ?? path.resolve(scriptDir, '..', 'src', 'tui', 'engine');
const upstreamRoot = args['upstream-root'];

const baseline = JSON.parse(await readFile(path.join(engineRoot, 'BASELINE.json'), 'utf8'));
const localChanges = JSON.parse(await readFile(path.join(engineRoot, 'LOCAL_CHANGES.json'), 'utf8'));
const localChangesMd = await readFile(path.join(engineRoot, 'LOCAL_CHANGES.md'), 'utf8');

// 1. Per-file hashes.
let fileChecks = 0;
for (const entry of baseline.files) {
  const upstreamBuffer = await readFile(path.join(upstreamRoot, entry.path)).catch(() => null);
  if (!upstreamBuffer || sha256(upstreamBuffer) !== entry.upstreamSha256) {
    fail(`upstream hash ${entry.path}`);
  } else {
    fileChecks += 1;
  }
  const adaptedBuffer = await readFile(path.join(engineRoot, entry.path)).catch(() => null);
  if (!adaptedBuffer || sha256(adaptedBuffer) !== entry.adaptedSha256) {
    fail(`adapted hash ${entry.path}`);
  } else {
    fileChecks += 1;
  }
}
if (baseline.files.length !== baseline.sourceFileCount) {
  fail(`sourceFileCount ${baseline.sourceFileCount} != files[] length ${baseline.files.length}`);
} else {
  ok(`per-file hashes for ${fileChecks / 2}/${baseline.files.length} files (upstream + adapted)`);
}

// 2. Tree digests.
if (treeDigest(baseline.files, 'upstreamSha256') !== baseline.upstreamTreeDigest) {
  fail('upstreamTreeDigest does not match the content scheme (path\\nupstreamSha256\\n blocks)');
} else if (treeDigest(baseline.files, 'adaptedSha256') !== baseline.adaptedTreeDigest) {
  fail('adaptedTreeDigest does not match the content scheme (path\\nadaptedSha256\\n blocks)');
} else {
  ok(`tree digests content-addressed (upstream ${baseline.upstreamTreeDigest.slice(0, 12)}, adapted ${baseline.adaptedTreeDigest.slice(0, 12)})`);
}

// 3. Local source files.
for (const entry of baseline.localSourceFiles) {
  const record = typeof entry === 'string' ? { path: entry } : entry;
  const buffer = await readFile(path.join(engineRoot, record.path)).catch(() => null);
  if (!buffer || (record.adaptedSha256 && sha256(buffer) !== record.adaptedSha256)) {
    fail(`local source file ${record.path}`);
  } else {
    ok(`local source file ${record.path}`);
  }
}

// 4. Coverage: every engine .ts file is in files[] or localSourceFiles.
const accounted = new Set([...baseline.files.map((f) => f.path), ...baseline.localSourceFiles.map((f) => f.path)]);
const engineFiles = await listTypeScriptFiles(engineRoot);
const unaccounted = engineFiles.filter((p) => !accounted.has(p) && !['BASELINE.json', 'LOCAL_CHANGES.json', 'LOCAL_CHANGES.md', 'UPSTREAM.md'].includes(p));
if (unaccounted.length > 0) {
  fail(`engine files not accounted for in BASELINE/LOCAL_CHANGES: ${unaccounted.join(', ')}`);
} else {
  ok(`coverage: ${engineFiles.length} engine .ts files all accounted for`);
}

// 5. LOCAL_CHANGES.json consistency.
if (localChanges.baselineAdaptedTreeDigest !== baseline.adaptedTreeDigest) {
  fail(`LOCAL_CHANGES.baselineAdaptedTreeDigest ${localChanges.baselineAdaptedTreeDigest.slice(0, 12)} != BASELINE.adaptedTreeDigest ${baseline.adaptedTreeDigest.slice(0, 12)}`);
} else {
  ok('LOCAL_CHANGES.json re-anchored to the current adaptedTreeDigest');
}

const retired = new Set(['L010']);
for (const entry of localChanges.files) {
  const buffer = await readFile(path.join(engineRoot, entry.path)).catch(() => null);
  if (!buffer || sha256(buffer) !== entry.currentSha256) {
    fail(`LOCAL_CHANGES currentSha256 ${entry.path}`);
  } else if (!accounted.has(entry.path)) {
    fail(`LOCAL_CHANGES entry ${entry.path} missing from BASELINE files[]/localSourceFiles`);
  } else {
    ok(`ledger entry ${entry.path} [${entry.changeIds.join(',')}]`);
  }
  for (const id of entry.changeIds) {
    if (retired.has(id)) fail(`retired ${id} reused by ${entry.path}`);
    if (!localChangesMd.includes(id)) fail(`${id} (${entry.path}) has no LOCAL_CHANGES.md record`);
  }
  if (entry.changeIds.length === 0 && !localChangesMd.includes(entry.path)) {
    fail(`unnumbered entry ${entry.path} has no LOCAL_CHANGES.md record`);
  }
}

// 6. Ledger completeness: substantive divergence from the pin <=> ledger entry.
const importSpecifier = /((?:from|import)\s*["'])(\.[^"']+?)\.ts(["'])/g;
const nodeNext = (text) => text.replaceAll('\r\n', '\n').replace(importSpecifier, '$1$2.js$3');
const ledgerPaths = new Set(localChanges.files.map((f) => f.path));
let divergent = 0;
let excluded = 0;
for (const entry of baseline.files) {
  const pinText = await readFile(path.join(upstreamRoot, entry.path), 'utf8').catch(() => null);
  const localText = await readFile(path.join(engineRoot, entry.path), 'utf8').catch(() => null);
  if (pinText === null || localText === null) continue; // already failed in check 1
  const normalized = nodeNext(pinText.replaceAll('\r\n', '\n'));
  const isSubstantive = localText.replaceAll('\r\n', '\n') !== normalized;
  if (isSubstantive) {
    divergent += 1;
    if (!ledgerPaths.has(entry.path)) {
      fail(`ledger completeness: ${entry.path} diverges from the pin beyond L001 but has no LOCAL_CHANGES.json entry`);
    }
  } else {
    excluded += 1;
    if (ledgerPaths.has(entry.path)) {
      fail(`ledger completeness: ${entry.path} is pin-identical/import-only but still has a LOCAL_CHANGES.json entry`);
    }
  }
}
for (const record of baseline.localSourceFiles) {
  if (!ledgerPaths.has(record.path)) {
    fail(`ledger completeness: local source file ${record.path} has no LOCAL_CHANGES.json entry`);
  }
}
if (!process.exitCode) {
  ok(`ledger completeness: ${divergent} divergent files all ledgered, ${excluded} pin-identical/import-only files all excluded`);
}
console.log(process.exitCode ? '\nverify-tui-engine-baseline: FAILED' : '\nverify-tui-engine-baseline: all checks green');
