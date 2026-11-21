import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readExtraction } from "../scripts/lib/release-metadata.mjs";
import {
  packageExportEntries,
  resolveExportSource,
} from "../scripts/lib/package-exports.mjs";

// W01 dependency/export suite for the vendored pi closure (G-UNIT port-deps).
//
// The checks verify that dependencies resolve in
// the target workspace trees, the resolution graph holds no registry copies of
// `@earendil-works/*` packages, every declared export of the vendored packages
// resolves to a real source file, and the built `dist` output loads offline.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { packageRoots } = readExtraction(root);
const vendoredRoots = packageRoots.filter((directory) =>
  directory.startsWith("third_party/"),
);

const PI_MONO_PIN = "48c8f322844087ff6cd80885f093ad44557647d1";

describe("W01 vendored dependency closure", () => {
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

  it("documents the vendored pin in the vendor manifest", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(root, "third_party/pi-mono/.minimax-vendor.json"),
        "utf8",
      ),
    );
    expect(String(manifest.upstream.commit)).toBe(PI_MONO_PIN);
  });
});

describe("W01 vendored export surface", () => {
  const entries = packageExportEntries(root, vendoredRoots);

  it("maps every declared vendored export to an existing source file", () => {
    // 11 vendored packages currently declare 57 export entries (wildcards count once).
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

  it("resolves export sources through the shared resolver without dangling paths", () => {
    for (const directory of vendoredRoots) {
      const manifest = JSON.parse(
        readFileSync(path.join(root, directory, "package.json"), "utf8"),
      );
      for (const [subpath, value] of Object.entries(
        manifest.exports ?? { ".": manifest.types },
      )) {
        const target =
          typeof value === "string"
            ? value
            : ((value as Record<string, string | undefined>)?.types ??
              (value as Record<string, string | undefined>)?.import ??
              (value as Record<string, string | undefined>)?.default);
        if (!target || !subpath.startsWith(".")) continue;
        expect(() =>
          resolveExportSource(root, directory, target),
        ).not.toThrow();
      }
    }
  });
});

describe("W01 built dist import smoke (offline)", () => {
  const distributable = [
    "agent",
    "ai",
    "chord",
    "codemode",
    "coding-agent",
    "env",
    "mcp",
    "pi-durable",
    "telemetry",
    "tui",
  ];

  it("built every distributable vendored package", () => {
    const built = vendoredRoots
      .filter((directory) =>
        existsSync(path.join(root, directory, "dist", "index.js")),
      )
      .map((directory) => path.basename(directory))
      .sort();
    expect(built).toEqual([...distributable].sort());
  });

  for (const name of distributable) {
    const directory = path.join("third_party", name === "pi-durable" || name === "chord" ? "" : "pi-mono/packages", name);
    it(
      `imports @earendil-works ${name} from dist`,
      { timeout: 30_000 },
      async () => {
        const module = await import(
          pathToFileURL(path.join(root, directory, "dist", "index.js")).href
        );
        expect(Object.keys(module).length).toBeGreaterThan(0);
      },
    );
  }

  it("keeps the hydrated offline model catalog inside the ai dist", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          root,
          "third_party/pi-mono/packages/ai/dist/providers/data/.manifest.json",
        ),
        "utf8",
      ),
    );
    expect(manifest.schemaVersion).toBe(6);
    expect(Object.keys(manifest.files)).toHaveLength(42);
  });
});
