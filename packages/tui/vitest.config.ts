import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { readExtraction } from '../../scripts/lib/release-metadata.mjs';
import { packageExportEntries } from '../../scripts/lib/package-exports.mjs';

// Package-local Vitest config so `vitest run --config vitest.config.ts` works
// from this directory before reaching for the repository gate. The gate
// (`vitest.oss.config.mjs` over `test/vitest-suites.json`) resolves every
// `@mavis/*` and `@earendil-works/*` workspace import to its TypeScript source
// through the shared `packageExportEntries` alias table; this config reuses
// the exact same derivation so a test file cannot resolve differently in the
// two runners. Every suite lives under `test/unit/`.
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
