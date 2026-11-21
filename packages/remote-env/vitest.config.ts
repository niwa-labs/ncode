import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Package-local config so the suite runs before root-config registration;
// the repository gate keeps using the root config (same pattern as
// durable-orchestration).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
