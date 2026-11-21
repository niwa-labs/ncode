import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Package-local config so the suite can run before the file is registered in
// test/vitest-suites.json; the repository gate keeps using the root config.
// The alias map mirrors the root configs' @mavis/* source resolution.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const { readExtraction } = await import(path.join(repoRoot, 'scripts/lib/release-metadata.mjs'));
const { packageExportEntries } = await import(path.join(repoRoot, 'scripts/lib/package-exports.mjs'));
const { packageRoots } = readExtraction(repoRoot);
const alias = packageExportEntries(repoRoot, packageRoots).map(({ specifier, file }) => ({
	find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
	replacement: path.join(repoRoot, file),
}));

if (process.env['CHORD_HOST_ALIAS_DEBUG'] === '1') {
	console.log('ALIAS COUNT:', alias.length, alias.filter((a) => String(a.find).includes('chord')).map((a) => String(a.find)));
}
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	resolve: { alias },
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		testTimeout: 30_000,
	},
});
