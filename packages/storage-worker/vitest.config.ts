import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Local test config for `pnpm --filter @mavis/storage-worker test`. The
// repository-wide suites are declared in `test/vitest-suites.json`; this file
// only exists so the package can be exercised standalone during development.
// `@mavis/durable-backend-sqlite-zstd` and `@mavis/logging` are aliased to
// their TypeScript sources because the package exports point at the (not
// built here) `dist` output — the same export → source resolution the root
// config derives from the package exports.
export default defineConfig({
  resolve: {
    alias: {
      '@mavis/durable-backend-sqlite-zstd': fileURLToPath(
        new URL('../durable-backend-sqlite-zstd/src/index.ts', import.meta.url),
      ),
      '@mavis/logging': fileURLToPath(new URL('../logging/src/index.ts', import.meta.url)),
      // W02: the vendored pi reference storage for the pi-composition tests
      // (same export → source resolution the root gate derives).
      '@earendil-works/pi-durable/storage/memory': fileURLToPath(
        new URL('../../third_party/pi-durable/src/storage/memory.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
