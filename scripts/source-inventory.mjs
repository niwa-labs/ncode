import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { inventoryPath, readExtraction } from "./lib/release-metadata.mjs";
import { resolveExportSource } from "./lib/package-exports.mjs";
import { retiredSourceRoots } from "./lib/retired-sources.mjs";
import { readSuites, suiteInventoryViolations } from "./lib/vitest-suites.mjs";
import {
  embeddedCredential as credential,
  internalSourceReference as internalText,
} from "./lib/public-text-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const skipped = new Set([
  ".git",
  "node_modules",
  "dist",
  ".cache",
  ".pnpm-store",
  ".turbo",
  ".DS_Store",
  // Agent-tooling state (workflow-run scratch files); gitignored by the
  // tool itself and never reviewed source.
  ".zcode",
  // Local Python SDK environment and tool caches (packages/code-sdk-python).
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
function filesIn(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name) || entry.name.endsWith(".tsbuildinfo"))
      return [];
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Source symlink requires explicit review: ${relative}`);
    return entry.isDirectory()
      ? filesIn(path.join(directory, entry.name), relative)
      : [relative];
  });
}
const walked = filesIn(root);
// W10 (U30 build/release paths): the reviewed source set is what a reviewed
// tree exports — git-tracked files plus untracked-but-not-ignored ones (the
// review trigger for new sources). Gitignored build artifacts that merely sit
// on disk (e.g. a cargo `target/` directory from a local daemon build) are
// NOT reviewed source and must not enter the inventory: the export gate
// archives the committed tree and would fail its own inventory re-check.
// Outside a git repository (the exported-archive profile) the raw walk is
// kept — an archive has no ignores left to apply.
let reviewedFiles;
try {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  reviewedFiles = new Set(listed.split("\0").filter(Boolean));
} catch {
  reviewedFiles = undefined;
}
const files = (reviewedFiles ? walked.filter((file) => reviewedFiles.has(file)) : walked).sort();
// Wildcard export subpaths (`./providers/*` -> `src/providers/*.ts`) are valid
// as long as the pattern directory contains at least one matching TypeScript
// file; plain paths are checked with existsSync.
function exportSourceExists(root, directory, source) {
  const absolute = path.join(root, directory, source);
  if (!source.includes("*")) return existsSync(absolute);
  const head = source.slice(0, source.indexOf("*"));
  const tail = source.slice(source.indexOf("*") + 1);
  const prefix = head.endsWith("/") ? "" : path.posix.basename(head);
  let entries;
  try {
    entries = readdirSync(path.dirname(absolute));
  } catch {
    return false;
  }
  return entries.some(
    (name) =>
      name.startsWith(prefix) && name.endsWith(tail) && name.endsWith(".ts"),
  );
}
const violations = suiteInventoryViolations(files, readSuites(root));
// Standard MIT text with the reviewed first-party attribution.
// Source: https://opensource.org/license/mit
const rootLicenseSha256 =
  "28bb5c2948742f9f8d27ed84882844d09dff07cb5df64f20729875e8582a18ea";
if (
  createHash("sha256")
    .update(readFileSync(path.join(root, "LICENSE")))
    .digest("hex") !== rootLicenseSha256
)
  violations.push(
    "LICENSE: expected MIT text with the reviewed MiniMax Code attribution",
  );
for (const file of files) {
  if (retiredSourceRoots.some((prefix) => file.startsWith(prefix)))
    violations.push(`${file}: retired source`);
  if (/^(?:.*\/)?\.env(?:\.|$)/u.test(file) && !file.endsWith(".env.example"))
    violations.push(`${file}: environment file`);
  let content = readFileSync(path.join(root, file));
  if (file.endsWith(".gz")) content = gunzipSync(content);
  const text = content.toString("utf8");
  if (internalText.test(text))
    violations.push(`${file}: internal source reference`);
  if (credential.test(text))
    violations.push(`${file}: possible embedded credential`);
}
const { packageRoots } = readExtraction(root);
const packages = packageRoots.map((directory) => ({
  directory,
  manifest: JSON.parse(
    readFileSync(path.join(root, directory, "package.json"), "utf8"),
  ),
}));
const names = new Set(packages.map(({ manifest }) => manifest.name));
for (const { directory, manifest } of packages) {
  if (!manifest.license || manifest.license === "UNLICENSED")
    violations.push(`${directory}: missing open-source license`);
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version.startsWith("workspace:") && !names.has(name))
        violations.push(`${directory}: unknown workspace ${name}`);
    }
  }
  for (const [name, entry] of Object.entries(manifest.exports ?? {})) {
    const target =
      typeof entry === "string"
        ? entry
        : (entry.types ?? entry.import ?? entry.default);
    if (!target) continue;
    let source;
    try {
      source = resolveExportSource(root, directory, target);
    } catch {
      violations.push(`${directory}: missing export ${name}`);
      continue;
    }
    if (!exportSourceExists(root, directory, source))
      violations.push(`${directory}: missing export ${name}`);
  }
}
const native = JSON.parse(
  readFileSync(
    path.join(root, "third_party/sandbox-runtime/native-integrity.json"),
    "utf8",
  ),
);
for (const entry of native.files) {
  const bytes = readFileSync(
    path.join(root, "third_party/sandbox-runtime", entry.path),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
    violations.push(`${entry.path}: native helper integrity mismatch`);
}

// The public Plugin contract is validated by the same code path an external
// author runs. Keeping it inside check:source stops the published schemas and
// the public validator from drifting apart.
const { validatePluginContract } = await import(
  new URL("../tools/plugins/validate-plugin.mjs", import.meta.url).href
);
for (const problem of validatePluginContract(root))
  violations.push(`plugin contract: ${problem}`);
if (violations.length)
  throw new Error(`Public source check failed:\n${violations.join("\n")}`);
if (process.argv.includes("--write")) {
  const projected = [...new Set([...files, inventoryPath])].sort();
  writeFileSync(
    path.join(root, inventoryPath),
    JSON.stringify({ schemaVersion: 1, files: projected }, null, 2) + "\n",
  );
  console.log(`Recorded ${projected.length} reviewed source paths.`);
} else {
  const expected = JSON.parse(
    readFileSync(path.join(root, inventoryPath), "utf8"),
  ).files;
  const actualSet = new Set(files),
    expectedSet = new Set(expected);
  const missing = expected.filter((file) => !actualSet.has(file));
  const added = files.filter((file) => !expectedSet.has(file));
  if (missing.length || added.length)
    throw new Error(
      `Source inventory changed; review before updating.\nMissing: ${missing.join(", ")}\nAdded: ${added.join(", ")}`,
    );
  console.log(
    `Public source check passed: ${files.length} files, workspace exports and native helper integrity verified.`,
  );
}
