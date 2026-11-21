#!/usr/bin/env node
// Launcher of the history-import CLI (integration plan R6). The CLI itself is
// the bundled `dist/history-import.js` entry (see scripts/build.mjs); this
// launcher only resolves and execs it, so `node scripts/history-import.mjs …`
// works from a checkout and from a release layout alike.
//
// `--root` is mandatory for run/resume/verify — the bundled CLI enforces it;
// this launcher never injects a default root.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDir, '..');
const entry = join(repositoryRoot, 'dist', 'history-import.js');

if (!existsSync(entry)) {
  process.stderr.write(
    `history-import: ${entry} is missing. Build the distribution first (esbuild entry "history-import" in scripts/build.mjs), then retry.\n`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
