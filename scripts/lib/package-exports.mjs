import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Single derivation of "package export specifier -> source file" for the workspace.
// The published packages point at built `dist` output, but every in-repository
// consumer (type checking, Vitest resolution) must resolve the TypeScript source
// instead. Keeping one implementation prevents the type-check path map and the test
// resolver from disagreeing about the same package.
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

export function packageExportEntries(root, packageRoots) {
  const entries = [];
  for (const directory of packageRoots) {
    const manifest = JSON.parse(
      readFileSync(path.join(root, directory, "package.json"), "utf8"),
    );
    for (const [subpath, value] of Object.entries(
      manifest.exports ?? { ".": manifest.types },
    )) {
      const target =
        typeof value === "string"
          ? value
          : (value?.types ?? value?.import ?? value?.default);
      if (!target || !subpath.startsWith(".")) continue;
      const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
      const source = resolveExportSource(root, directory, target);
      entries.push({
        specifier,
        directory,
        // Repository-relative POSIX path to the source entry point. Wildcard
        // subpaths keep their `*` pattern: TypeScript path mapping expands it.
        file: `${directory}/${source.replace(/^\.\//u, "")}`,
      });
    }
  }
  return entries;
}

// Resolve one concrete package specifier against derived export entries with
// Node's subpath-exports semantics: exact entries first, then single-star
// patterns in declaration order, where the `*` expands to the greedy remainder
// (which may contain `/`). The expansion must map to an existing source file;
// otherwise the specifier stays unresolved so callers fall back to normal
// resolution instead of silently binding an unrelated source path.
export function resolveExportSpecifier(root, entries, specifier) {
  const exact = entries.find((entry) => entry.specifier === specifier);
  if (exact) return exact.file;
  for (const entry of entries) {
    const star = entry.specifier.indexOf("*");
    if (star === -1) continue;
    const prefix = entry.specifier.slice(0, star);
    const suffix = entry.specifier.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const expansion = specifier.slice(prefix.length, specifier.length - suffix.length);
    if (expansion.includes("*")) continue;
    const file = entry.file.replace("*", expansion);
    if (existsSync(path.join(root, file))) return file;
  }
  return undefined;
}
