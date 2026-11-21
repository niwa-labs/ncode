import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// G-PORT runner: executes the selected upstream vendored suites from
// test/port-conformance-suites.json and enforces inventory completeness.
// Vitest suites run through vitest.port.config.mjs (the upstream-conformance
// harness with closure-wide source aliases); `node-test` suites run through
// the Node test runner exactly like their upstream package script
// (`node --test`). The gate fails closed on both directions of drift:
//   - a manifest file the vendored trees no longer carry (silent suite loss),
//   - a vendored test file missing from the frozen inventory (a new/unselected
//     upstream test after a vendor rebaseline — the drift the G-PORT gate
//     exists to catch, plan :625 "inventory completeness").
// Every frozen file must be selected or excluded with a reason; `pin` must
// match the vendored upstream commit (machine-checked where a root carries
// `.minimax-vendor.json`; chord/pi-durable provenance is stated in
// third_party/pi-durable/MINIMAX_CHANGES.md, same pin).
// Manifest file paths are relative to the repository `src/` root.
const root = fileURLToPath(new URL("../", import.meta.url));
const vendorRoots = [
  "third_party/pi-mono",
  "third_party/chord",
  "third_party/pi-durable",
];

const manifest = JSON.parse(
  readFileSync(path.join(root, "test/port-conformance-suites.json"), "utf8"),
);

const inventoryOnly = process.argv.includes("--inventory-only");
const args = process.argv.slice(2).filter((a) => a !== "--inventory-only");
const selected = args;
const suites = Object.entries(manifest.suites).filter(
  ([name]) => selected.length === 0 || selected.includes(name),
);
if (suites.length === 0)
  throw new Error(
    `No port-conformance suites selected (asked for: ${selected.join(", ") || "all"})`,
  );

// --- inventory completeness -------------------------------------------------
const IGNORED_DIRS = new Set(["node_modules", "dist"]);
function listVendoredTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listVendoredTestFiles(full, acc);
    else if (entry.name.endsWith(".test.ts"))
      acc.push(path.relative(root, full));
  }
  return acc;
}

function assertInventoryComplete() {
  const failures = [];
  for (const vendorRoot of vendorRoots) {
    const vendorMeta = path.join(root, vendorRoot, ".minimax-vendor.json");
    if (!existsSync(vendorMeta)) continue;
    const vendorPin = JSON.parse(readFileSync(vendorMeta, "utf8")).upstream.commit;
    if (manifest.pin !== vendorPin)
      failures.push(
        `manifest pin ${manifest.pin} != ${vendorRoot} upstream.commit ${vendorPin}; refreeze the corpus after rebaselining`,
      );
  }

  const frozen = manifest.inventory.files;
  const selectedFiles = new Set(
    Object.values(manifest.suites).flatMap((s) => s.files),
  );
  const exclusions = manifest.inventory.exclusions;

  // classification: every frozen file is selected or excluded (longest prefix).
  const isClassified = (file) =>
    selectedFiles.has(file) || exclusions.some((e) => file.startsWith(e.prefix));
  for (const file of frozen) {
    if (!isClassified(file))
      failures.push(`frozen test file is neither selected nor excluded: ${file}`);
  }

  // drift: vendored disk state vs the frozen corpus.
  const onDisk = new Set(vendorRoots.flatMap((r) => listVendoredTestFiles(path.join(root, r))));
  const frozenSet = new Set(frozen);
  for (const file of frozen)
    if (!onDisk.has(file) && !existsSync(path.join(root, file)))
      failures.push(`frozen test file is missing from the vendored tree: ${file}`);
  for (const file of [...onDisk].sort())
    if (!frozenSet.has(file))
      failures.push(
        `vendored test file is not in the frozen inventory (new upstream test after rebaseline? refreeze and disposition it): ${file}`,
      );

  if (failures.length) {
    console.error(`Port-conformance inventory drift (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  const excludedCount = frozen.length - selectedFiles.size;
  console.log(
    `Inventory complete: ${frozen.length} vendored test files at pin ${manifest.pin.slice(0, 8)} — ${selectedFiles.size} selected, ${excludedCount} excluded with reasons.`,
  );
}

assertInventoryComplete();
if (inventoryOnly) {
  console.log("--inventory-only: skipping suite execution.");
  process.exit(0);
}
// ----------------------------------------------------------------------------

const byRunner = new Map();
for (const [name, suite] of suites) {
  const runner = suite.runner ?? "vitest";
  for (const file of suite.files) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute))
      throw new Error(
        `Port-conformance suite ${name} references a missing vendored file: ${file}`,
      );
    if (!byRunner.has(runner)) byRunner.set(runner, []);
    byRunner.get(runner).push(absolute);
  }
}

// Keep locale sources pinned exactly like the first-party suite runner so
// vendored assertions about messages and sorting stay deterministic.
const environment = { ...process.env };
// Spawned upstream probes must resolve workspace source exports too; Vitest's
// in-process aliases do not reach a child Node process (notably pi-schema).
environment.NODE_OPTIONS = `${environment.NODE_OPTIONS ?? ""} --conditions=source`.trim();
environment.LANG = "C";
environment.LANGUAGE = "C";
environment.LC_ALL = "C";
environment.LC_MESSAGES = "C";
if (process.platform === "win32") {
  environment.TEMP = environment.TMP = realpathSync.native(tmpdir());
}

let failed = false;
for (const [runner, files] of byRunner) {
  let command;
  if (runner === "vitest") {
    const require = createRequire(import.meta.url);
    const vitestManifest = require.resolve("vitest/package.json");
    command = [
      path.resolve(
        path.dirname(vitestManifest),
        require(vitestManifest).bin.vitest,
      ),
      "run",
      "--config",
      "vitest.port.config.mjs",
      ...files,
    ];
  } else if (runner === "node-test") {
    command = ["--test", ...files];
  } else {
    throw new Error(`Unknown port-conformance runner: ${runner}`);
  }
  const result = spawnSync(process.execPath, command, {
    stdio: "inherit",
    cwd: root,
    env: environment,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
