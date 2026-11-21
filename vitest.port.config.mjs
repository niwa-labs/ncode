import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExtraction } from "./scripts/lib/release-metadata.mjs";
import { packageExportEntries } from "./scripts/lib/package-exports.mjs";

// Upstream-conformance harness for the vendored pi closure (G-PORT).
//
// The vendored packages keep their upstream package names and export maps, and
// their suites import each other through `@earendil-works/*` specifiers. The
// per-package upstream vitest configs alias those specifiers to package
// sources; this shared config does the same for the whole vendored closure at
// once, deriving the alias map from the same `packageExportEntries` used by
// the tsconfig path generator so the port harness and the type checker cannot
// disagree about resolution. Wildcard exports (`./providers/*`) become capture
// aliases. Tests run against TypeScript sources, exactly like upstream CI
// (`conditions: ["source"]` there; source aliases here).
const root = fileURLToPath(new URL(".", import.meta.url));
const { packageRoots } = readExtraction(root);
const vendoredRoots = packageRoots.filter((directory) =>
  directory.startsWith("third_party/"),
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const alias = packageExportEntries(root, vendoredRoots).map(
  ({ specifier, file }) => ({
    find: new RegExp(
      `^${specifier.split("*").map(escapeRegExp).join("(.+)")}$`,
    ),
    replacement: path.join(root, file).replace(/\*/u, "$1"),
  }),
);

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    reporters: process.env.GITHUB_ACTIONS
      ? ["dot", "github-actions"]
      : ["dot"],
    silent: "passed-only",
  },
});
