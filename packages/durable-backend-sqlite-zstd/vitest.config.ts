import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../../scripts/lib/package-exports.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const alias = workspaceSourceAliases(root);

// Spawned workers resolve packages via Node's export conditions.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
