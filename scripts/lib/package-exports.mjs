import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readExtraction } from "./release-metadata.mjs";

// Map published exports to the sources used by builds, type checks and tests.
function sourceOf(target) {
  return target
    .replace(/^\.\/dist\//u, "./src/")
    .replace(/\.d\.ts$/u, ".ts")
    .replace(/\.js$/u, ".ts");
}

// Bundled entry points are published under a `dist/` subdirectory while their
// TypeScript source lives flat in `src/`: the vendored coding-agent exports
// `./rpc-entry` as `./dist/bundle/rpc-entry.js`, but the source file is
// `src/rpc-entry.ts` (the upstream build script writes the bundle). The
// remap is an EXPLICIT allowlist keyed by `<package directory>:<rewritten
// source>` — not a generic fallback. The previous heuristic (try
// `./src/<basename>` for any unresolvable target) could silently bind a
// future vendor rebaseline's export to an unrelated same-named source file;
// a new bundle entry must now be added here deliberately.
const BUNDLE_ENTRY_SOURCES = new Map([
  [
    "third_party/pi-mono/packages/coding-agent:./src/bundle/rpc-entry.ts",
    "./src/rpc-entry.ts",
  ],
]);

export function resolveExportSource(root, directory, target) {
  if (
    !target.startsWith("./") ||
    target.includes("\\") ||
    target.split("/").includes("..")
  )
    throw new Error(`Invalid export target ${target} of ${directory}`);
  const source = sourceOf(target);
  if (source.includes("*")) return source;
  const remapped = BUNDLE_ENTRY_SOURCES.get(`${directory}:${source}`);
  const candidates = remapped ? [source, remapped] : [source];
  for (const candidate of candidates)
    if (existsSync(path.join(root, directory, candidate))) return candidate;
  throw new Error(
    `cannot resolve export target ${target} of ${directory} to a source file (tried ${candidates.join(", ")}); if this is a new bundle entry, add it to BUNDLE_ENTRY_SOURCES explicitly`,
  );
}

// Exact exports precede patterns. Node orders patterns by longest prefix before
// the star, then longest full key (the most specific suffix for equal prefixes).
function compareExports(a, b) {
  const left = a.specifier.indexOf("*");
  const right = b.specifier.indexOf("*");
  if (left === right) return left === -1 ? 0 : b.specifier.length - a.specifier.length;
  if (left === -1) return -1;
  if (right === -1) return 1;
  return right - left;
}

function exportPattern(specifier) {
  const parts = specifier.split("*").map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  // A wildcard may span directories. Reject traversal segments and backslashes
  // before substituting the capture into a source path on either platform.
  return new RegExp(`^(?!.*\\/\\.{1,2}(?:\\/|$))${parts.join("([^*\\\\]+)")}$`, "u");
}

export function workspacePackageExports(root, packageRoots) {
  const packages = new Map();
  for (const directory of packageRoots) {
    const manifest = JSON.parse(
      readFileSync(path.join(root, directory, "package.json"), "utf8"),
    );
    if (packages.has(manifest.name))
      throw new Error(`Duplicate workspace package: ${manifest.name}`);
    const exported = manifest.exports ?? manifest.types;
    const hasSubpaths = exported && typeof exported === "object" &&
      Object.keys(exported).some((key) => key.startsWith("."));
    const subpaths = hasSubpaths ? exported : { ".": exported };
    const entries = [];
    for (const [subpath, value] of Object.entries(subpaths)) {
      const target = typeof value === "string"
        ? value
        : (value?.types ?? value?.import ?? value?.default);
      if (!target || !subpath.startsWith(".")) continue;
      const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
      const source = resolveExportSource(root, directory, target);
      entries.push({
        specifier,
        directory,
        file: `${directory}/${source.replace(/^\.\//u, "")}`,
        find: exportPattern(specifier),
      });
    }
    packages.set(manifest.name, entries.sort(compareExports));
  }
  return packages;
}

export function packageExportEntries(root, packageRoots) {
  return [...workspacePackageExports(root, packageRoots).values()].flat();
}

export function workspaceSourceAliases(root, packageRoots = readExtraction(root).packageRoots) {
  return packageExportEntries(root, packageRoots).map(({ find, file }) => ({
    find,
    // Escape literal dollars in the checkout path before inserting a capture.
    replacement: path.join(
      root.replaceAll("$", () => "$$"),
      file.replaceAll("$", () => "$$").replaceAll("*", "$1"),
    ),
  }));
}

export function resolveExportSpecifier(root, entries, specifier) {
  for (const entry of entries) {
    const match = entry.find.exec(specifier);
    if (!match) continue;
    const file = entry.file.replaceAll("*", () => match[1]);
    return existsSync(path.join(root, file)) ? file : undefined;
  }
  return undefined;
}
