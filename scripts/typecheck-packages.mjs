import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Per-package typecheck gate. The root `typecheck` step compiles only the
// standalone entry points — packages/mcoded and most of packages/* are not in
// its include graph, so their compile-time ties to upstream types (e.g.
// mcoded's `satisfies (keyof CliService)[]` allowlist, `REMOTE_CALL_PLANS
// satisfies Record<…>`, `GLOBAL_EVENT_ROUTES satisfies Record<…>`) were
// checked only by hand. This gate runs every workspace package's own
// `typecheck` script, so a reshaped upstream type fails `pnpm verify`, not a
// W4 runtime.
//
// Two explicit exception lists keep the gate green without hiding drift:
// - NO_TSCONFIG: packages whose `typecheck` script cannot run (`tsc
//   --noEmit` with no tsconfig.json prints help and exits non-zero). Printed
//   on every run; a package that gains a tsconfig must leave this list.
// - KNOWN_FAILING: packages that fail their own typecheck today for reasons
//   outside this repo's gate (third_party/pi-mono sources vs the hoisted
//   @types/node). A failure inside the list warns; a PASS inside the list
//   FAILS the gate so stale entries get removed. Anything failing OUTSIDE
//   the list fails the gate.
const root = fileURLToPath(new URL("../", import.meta.url));
const packagesDir = path.join(root, "packages");

const NO_TSCONFIG = new Set(["mcode-tools-host", "oauth-core", "oauth-lease-protocol"]);
const KNOWN_FAILING = new Set([
  "@mavis/agent-tools",
  "@mavis/context-compaction",
  "@mavis/context-projection",
  "@mavis/convert-to-llm",
  "@mavis/durable-backend-sqlite-zstd",
  "@mavis/local-runtime",
]);

const skipped = [];
const runnable = [];
for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(packagesDir, entry.name);
  const manifestPath = path.join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.scripts?.typecheck === undefined) continue;
  if (NO_TSCONFIG.has(entry.name) || !existsSync(path.join(dir, "tsconfig.json"))) {
    skipped.push(entry.name);
    continue;
  }
  runnable.push({ name: manifest.name ?? entry.name, dir });
}

let concurrency = 4;
const given = process.env.MCODE_TYPECHECK_CONCURRENCY;
if (given && Number.isInteger(Number(given)) && Number(given) > 0)
  concurrency = Number(given);

let failures = 0;
let next = 0;
async function worker() {
  for (;;) {
    const index = next;
    if (index >= runnable.length) return;
    next += 1;
    const { name, dir } = runnable[index];
    const result = spawnSync("pnpm", ["run", "typecheck"], {
      cwd: dir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    const ok = result.status === 0 && !result.error;
    if (ok) {
      if (KNOWN_FAILING.has(name)) {
        failures += 1;
        console.error(
          `typecheck-packages: STALE known-failing entry (it passes now — remove it): ${name}`,
        );
      }
    } else if (KNOWN_FAILING.has(name)) {
      console.warn(`typecheck-packages: known-failing (allowed): ${name}`);
    } else {
      failures += 1;
      console.error(`typecheck-packages: FAIL ${name}`);
    }
  }
}
console.log(
  `typecheck-packages: ${runnable.length} package(s)` +
    (skipped.length ? `; skipped (no runnable tsconfig.json): ${skipped.join(", ")}` : ""),
);
await Promise.all(Array.from({ length: Math.min(concurrency, runnable.length) }, worker));
if (skipped.length > 0)
  console.warn(
    `typecheck-packages: ${skipped.length} package(s) skipped without a runnable tsconfig.json: ${skipped.join(", ")}`,
  );
if (failures > 0) {
  console.error(`typecheck-packages: ${failures} gate violation(s)`);
  process.exitCode = 1;
}
