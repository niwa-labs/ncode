import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packageExportEntries, resolveExportSpecifier } from "../../../../../../scripts/lib/package-exports.mjs";
import { readExtraction } from "../../../../../../scripts/lib/release-metadata.mjs";

// The Ncode source projection derives Pi's aliases from package exports.
// Use the same paths as the bundle and Vitest so subprocesses exercise vendor source.
const repositoryRoot = fileURLToPath(new URL("../../../../../..", import.meta.url));
const vendoredRoots = readExtraction(repositoryRoot).packageRoots.filter((directory) =>
	directory.startsWith("third_party/pi-mono/"),
);
const entries = packageExportEntries(repositoryRoot, vendoredRoots);

registerHooks({
	resolve(specifier, context, nextResolve) {
		const file = resolveExportSpecifier(repositoryRoot, entries, specifier);
		if (file) return { url: pathToFileURL(resolve(repositoryRoot, file)).href, shortCircuit: true };
		if (entries.some(({ find }) => find.test(specifier))) {
			throw new Error(`Source runtime could not resolve ${specifier} through its workspace export`);
		}
		return nextResolve(specifier, context);
	},
});
