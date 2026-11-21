import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { readExtraction } from '../../scripts/lib/release-metadata.mjs';
import { packageExportEntries } from '../../scripts/lib/package-exports.mjs';

// Package-local config so the suite can run before the file is registered in
// test/vitest-suites.json; the repository gate keeps using the root config.
//
// The runtime-adapter suite pulls in the local-runtime-v2 conversation
// pipeline, so the alias table now covers every workspace export instead of a
// hand-picked list: the repository gate (`vitest.oss.config.mjs` over
// `test/vitest-suites.json`) resolves `@mavis/*` imports through the same
// shared `packageExportEntries` derivation, and this config reuses it so a
// test file cannot resolve differently in the two runners.
const root = fileURLToPath(new URL('../../', import.meta.url));
const alias = packageExportEntries(root, readExtraction(root).packageRoots).map(
  ({ specifier, file }) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    replacement: path.join(root, file),
  }),
);

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
