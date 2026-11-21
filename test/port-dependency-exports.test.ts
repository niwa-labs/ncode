import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Metafile } from "esbuild";
import { describe, expect, it } from "vitest";
import { readExtraction } from "../scripts/lib/release-metadata.mjs";
import {
  packageExportEntries,
  resolveExportSpecifier,
  resolveExportSource,
  workspaceSourceAliases,
} from "../scripts/lib/package-exports.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { packageRoots } = readExtraction(root);
const vendoredRoots = packageRoots.filter((directory) =>
  directory.startsWith("third_party/"),
);

describe("vendored dependency closure", () => {
  it("resolves every @earendil-works dependency of vendored packages to a workspace link", () => {
    const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    const importerBlocks = lock.split(/\n(?=  \S)/);
    const vendoredImporters = importerBlocks.filter((block) =>
      /^  (third_party\/\S+):$/mu.test(block.split("\n")[0] ?? ""),
    );
    expect(vendoredImporters.length).toBeGreaterThanOrEqual(11);
    const offenders: string[] = [];
    for (const block of vendoredImporters) {
      const importer = block.split("\n")[0].trim();
      for (const match of block.matchAll(
        /'(@earendil-works\/[^']+)':\n\s+specifier: [^\n]+\n\s+version: (\S[^\n]*)/gu,
      )) {
        const [, dependency, version] = match;
        if (!version.startsWith("link:"))
          offenders.push(`${importer} -> ${dependency}: ${version}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the resolution graph free of registry @earendil-works packages", () => {
    const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    const registryEntries = [
      ...lock.matchAll(
        /^  '(@earendil-works\/[^']+)':\n\s+resolution: \{integrity:/gmu,
      ),
    ].map((match) => match[1]);
    expect(registryEntries).toEqual([]);
  });
});

describe("vendored export surface", () => {
  const entries = packageExportEntries(root, vendoredRoots);

  it("maps every declared vendored export to an existing source file", () => {
    expect(entries.length).toBeGreaterThanOrEqual(55);
    const missing: string[] = [];
    for (const { specifier, directory, file } of entries) {
      const absolute = path.join(root, file);
      if (file.includes("*")) {
        const wildcardDirectory = path.dirname(absolute);
        const prefix = path.posix.basename(file).replace(/\*.*$/u, "");
        const hasMatch =
          existsSync(wildcardDirectory) &&
          readdirSync(wildcardDirectory).some(
            (name) => name.startsWith(prefix) && name.endsWith(".ts"),
          );
        if (!hasMatch) missing.push(`${directory}: ${specifier}`);
      } else if (!existsSync(absolute)) {
        missing.push(`${directory}: ${specifier} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("resolves bundled and wildcard exports to their checked-in sources", () => {
    expect(resolveExportSpecifier(root, entries, "@earendil-works/pi-coding-agent/rpc-entry")).toBe(
      "third_party/pi-mono/packages/coding-agent/src/rpc-entry.ts",
    );
    expect(resolveExportSpecifier(root, entries, "@earendil-works/pi-ai/providers/all")).toBe(
      "third_party/pi-mono/packages/ai/src/providers/all.ts",
    );
    expect(resolveExportSpecifier(root, entries, "@earendil-works/pi-ai/src/index")).toBeUndefined();
    expect(resolveExportSpecifier(root, entries, "@earendil-works/pi-ai/providers/../index")).toBeUndefined();
    expect(() => resolveExportSource(root, "packages/agent-core", "./../shared/src/index.ts")).toThrow();
  });

  it("resolves overlapping exports in the same order in the build and Vitest", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "ncode-$1-exports-"));
    try {
      const directory = path.join(fixture, "pkg");
      mkdirSync(directory);
      writeFileSync(path.join(directory, "package.json"), JSON.stringify({
        name: "fixture",
        exports: {
          "./*": "./broad.ts",
          "./feature/*": "./prefix.ts",
          "./feature/*.js": "./suffix.ts",
          "./feature/exact.js": "./exact.ts",
          "./feature/missing/*": "./absent-*.ts",
          "./by-name/*": "./*.ts",
        },
      }));
      for (const name of ["broad", "prefix", "suffix", "exact"])
        writeFileSync(path.join(directory, name + ".ts"), "");
      const fixtureEntries = packageExportEntries(fixture, ["pkg"]);
      const aliases = workspaceSourceAliases(fixture, ["pkg"]);
      for (const [specifier, expected] of [
        ["fixture/nested/value", "broad"],
        ["fixture/by-name/prefix", "prefix"],
        ["fixture/feature/foo", "prefix"],
        ["fixture/feature/foo.js", "suffix"],
        ["fixture/feature/exact.js", "exact"],
      ]) {
        const file = `pkg/${expected}.ts`;
        expect(resolveExportSpecifier(fixture, fixtureEntries, specifier)).toBe(file);
        const alias = aliases.find(({ find }) => find.test(specifier))!;
        expect(specifier.replace(alias.find, alias.replacement)).toBe(path.join(fixture, file));
      }
      expect(resolveExportSpecifier(fixture, fixtureEntries, "fixture/feature/missing/value")).toBeUndefined();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("vendored sources in the standalone distribution", () => {
  it("bundles the Pi runtime, durable storage, orchestration and offline model catalog", () => {
    const build: Metafile = JSON.parse(readFileSync(path.join(root, "dist/metafile.json"), "utf8"));
    const emitted = new Set(Object.values(build.outputs).flatMap(({ inputs }) =>
      Object.keys(inputs).filter((file) => inputs[file].bytesInOutput > 0),
    ));
    for (const directory of ["third_party/chord", "third_party/pi-durable", "third_party/pi-mono/packages/coding-agent"])
      expect([...emitted].some((file) => file.startsWith(`${directory}/src/`)), directory).toBe(true);
    for (const directory of vendoredRoots)
      expect(Object.keys(build.inputs).some((file) => file.startsWith(`${directory}/dist/`)), directory).toBe(false);

    const data = "third_party/pi-mono/packages/ai/src/providers/data";
    const manifest = JSON.parse(readFileSync(path.join(root, data, ".manifest.json"), "utf8"));
    expect(manifest.files).toHaveProperty(["minimax.json"]);
    expect(manifest.files).toHaveProperty(["minimax-cn.json"]);
    for (const file of Object.keys(manifest.files)) expect(emitted.has(`${data}/${file}`), file).toBe(true);
  });
});
