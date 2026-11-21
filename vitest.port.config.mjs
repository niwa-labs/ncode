import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readExtraction } from "./scripts/lib/release-metadata.mjs";
import { workspaceSourceAliases } from "./scripts/lib/package-exports.mjs";

// Upstream conformance suites resolve only the vendored package scope.
const root = fileURLToPath(new URL(".", import.meta.url));
const { packageRoots } = readExtraction(root);
const vendoredRoots = packageRoots.filter((directory) =>
  directory.startsWith("third_party/"),
);

const alias = workspaceSourceAliases(root, vendoredRoots);

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
