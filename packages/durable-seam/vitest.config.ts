import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Package-local config so the suite can run before the file is registered in
// test/vitest-suites.json; the repository gate keeps using the root config.
// `@mavis/logging` is aliased to its TypeScript source (the same export →
// source resolution the gate derives): the package export points at the
// (not built here) `dist` output.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@mavis/logging': fileURLToPath(new URL('../logging/src/index.ts', import.meta.url)),
      // W02: the vendored pi reference storage for the pi-storage-port tests
      // (same export → source resolution the root gate derives).
      '@earendil-works/pi-durable/storage/memory': fileURLToPath(
        new URL('../../third_party/pi-durable/src/storage/memory.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
});
