import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { workspaceSourceAliases } from "./scripts/lib/package-exports.mjs";
import { allSuiteFiles } from "./scripts/lib/vitest-suites.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const alias = workspaceSourceAliases(root);

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: allSuiteFiles(root),
  },
});
