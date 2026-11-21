import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SESSIONS_GENERATION,
  DURABLE_CAS_DIR_BASENAME,
  DURABLE_ROOT_BASENAME,
  DURABLE_RUNTIME_DB_BASENAME,
  DURABLE_SESSIONS_DB_BASENAME,
  DURABLE_SOCKET_BASENAME,
  LEGACY_ROOT,
  LegacyWriteError,
  assertNoLegacyWrite,
  ensureDurableLayout,
  profileOfDataDir,
  resolveCasDirPath,
  resolveDaemonControlRoot,
  resolveDurableRoot,
  resolveMcodedSocketPath,
  resolveRuntimeDbPath,
  resolveSessionsDbPath,
} from "../src/durable-paths.js";
import { InvalidProfileNameError } from "../src/auth-profile.js";

describe("durable root resolution", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "durable-root-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resolves the unsuffixed root for the default profile", () => {
    const expected = join(home, DURABLE_ROOT_BASENAME);
    expect(resolveDurableRoot(undefined, home)).toBe(expected);
    expect(resolveDurableRoot(null, home)).toBe(expected);
  });

  it.each(["", "   ", "default"])("maps the absent selector %j to the unsuffixed root", (profile) => {
    expect(resolveDurableRoot(profile, home)).toBe(join(home, DURABLE_ROOT_BASENAME));
  });

  it("suffixes a named profile", () => {
    expect(resolveDurableRoot("work", home)).toBe(join(home, `${DURABLE_ROOT_BASENAME}-work`));
  });

  // The profile name becomes a directory segment under $HOME, so the same
  // allowlist as the auth profile applies: an unusable name must be refused,
  // not sanitised into some other directory.
  it.each(["../evil", "a/b", "-lead"])("refuses the profile name %j", (profile) => {
    expect(() => resolveDurableRoot(profile, home)).toThrow(InvalidProfileNameError);
  });

  it("keeps the durable root separate from the legacy data directory", () => {
    expect(DURABLE_ROOT_BASENAME).toBe(".mcode-durable");
    expect(LEGACY_ROOT).toBe(join(os.homedir(), ".minimax"));
  });
});

describe("session database generations", () => {
  const root = join("/home", "dev", DURABLE_ROOT_BASENAME);

  it("resolves the first generation by default", () => {
    expect(resolveSessionsDbPath(root)).toBe(join(root, "sessions.g1.db"));
    expect(DEFAULT_SESSIONS_GENERATION).toBe(1);
  });

  it("resolves an explicit generation next to the previous one", () => {
    expect(resolveSessionsDbPath(root, 2)).toBe(join(root, "sessions.g2.db"));
    expect(resolveSessionsDbPath(root, 2)).toContain(DURABLE_SESSIONS_DB_BASENAME);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects the generation %j", (generation) => {
    expect(() => resolveSessionsDbPath(root, generation)).toThrow(RangeError);
  });
});

describe("durable layout paths", () => {
  const root = join("/home", "dev", DURABLE_ROOT_BASENAME);

  it("resolves the blob store, service tables, and daemon socket", () => {
    expect(resolveCasDirPath(root)).toBe(join(root, DURABLE_CAS_DIR_BASENAME));
    expect(resolveRuntimeDbPath(root)).toBe(join(root, DURABLE_RUNTIME_DB_BASENAME));
    expect(resolveMcodedSocketPath(root)).toBe(join(root, DURABLE_SOCKET_BASENAME));
  });

  it("pins the documented file names", () => {
    expect(DURABLE_CAS_DIR_BASENAME).toBe("cas");
    expect(DURABLE_RUNTIME_DB_BASENAME).toBe("runtime.db");
    expect(DURABLE_SOCKET_BASENAME).toBe("mcoded.sock");
  });
});

describe("legacy write guard", () => {
  let home: string;
  let legacyRoot: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "legacy-guard-"));
    legacyRoot = join(home, ".minimax");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("allows the durable root and everything under it", () => {
    const durable = join(home, DURABLE_ROOT_BASENAME);
    expect(assertNoLegacyWrite(durable, legacyRoot)).toBe(durable);
    expect(assertNoLegacyWrite(join(durable, "runtime.db"), legacyRoot)).toBe(
      join(durable, "runtime.db"),
    );
  });

  it("allows paths elsewhere under the home directory", () => {
    expect(assertNoLegacyWrite(join(home, "projects", "notes.txt"), legacyRoot)).toBe(
      join(home, "projects", "notes.txt"),
    );
  });

  it("allows the home directory itself", () => {
    expect(assertNoLegacyWrite(home, legacyRoot)).toBe(home);
  });

  it("blocks the legacy root and everything inside it", () => {
    expect(() => assertNoLegacyWrite(legacyRoot, legacyRoot)).toThrow(LegacyWriteError);
    expect(() => assertNoLegacyWrite(join(legacyRoot, "auth", "token.json"), legacyRoot)).toThrow(
      LegacyWriteError,
    );
  });

  // The legacy family includes the profile-suffixed siblings: the durable
  // rule is "no writes to `~/.minimax*`", not just the unsuffixed directory.
  it("blocks the profile-suffixed legacy directories", () => {
    expect(() => assertNoLegacyWrite(join(home, ".minimax-work", "auth.json"), legacyRoot)).toThrow(
      LegacyWriteError,
    );
  });

  it("blocks traversal spellings that resolve into the legacy root", () => {
    expect(() => assertNoLegacyWrite(join(home, "projects", "..", ".minimax", "db"), legacyRoot)).toThrow(
      LegacyWriteError,
    );
  });

  it("reports the refused path on the error", () => {
    const target = join(legacyRoot, "sessions.sqlite");
    try {
      assertNoLegacyWrite(target, legacyRoot);
      expect.unreachable("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(LegacyWriteError);
      expect((error as LegacyWriteError).code).toBe("LEGACY_WRITE_FORBIDDEN");
      expect((error as LegacyWriteError).targetPath).toBe(target);
      expect((error as LegacyWriteError).legacyRoot).toBe(legacyRoot);
    }
  });

  it("defaults to the real legacy root", () => {
    expect(() => assertNoLegacyWrite(join(LEGACY_ROOT, "config.yaml"))).toThrow(LegacyWriteError);
    expect(assertNoLegacyWrite(join(os.tmpdir(), "somewhere-else", "data.db"))).toBe(
      join(os.tmpdir(), "somewhere-else", "data.db"),
    );
  });
});

describe("durable layout creation", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "durable-layout-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("creates the root and the blob store directory", () => {
    const root = join(home, DURABLE_ROOT_BASENAME);
    ensureDurableLayout(root);
    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect(fs.statSync(resolveCasDirPath(root)).isDirectory()).toBe(true);
  });

  it("leaves files to their owners", () => {
    const root = join(home, DURABLE_ROOT_BASENAME);
    ensureDurableLayout(root);
    expect(fs.readdirSync(root)).toEqual([DURABLE_CAS_DIR_BASENAME]);
  });

  it("is idempotent", () => {
    const root = join(home, DURABLE_ROOT_BASENAME);
    ensureDurableLayout(root);
    ensureDurableLayout(root);
    expect(fs.readdirSync(root)).toEqual([DURABLE_CAS_DIR_BASENAME]);
  });

  // The guard fires before any filesystem call, so a misconfigured root inside
  // the legacy family is refused without touching the disk.
  it("refuses a root inside the legacy root", () => {
    const escape = join(LEGACY_ROOT, "escape");
    expect(() => ensureDurableLayout(escape)).toThrow(LegacyWriteError);
    expect(fs.existsSync(escape)).toBe(false);
  });
});

// Opus decision 2026-11-01: the daemon's identity IS realpath(dataDir); the
// profile is a label derived from it, never an independent input.
describe("profileOfDataDir (dataDir → profile inference)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "profile-infer-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads the default profile off the unsuffixed data directory", () => {
    fs.mkdirSync(join(home, ".minimax"), { recursive: true });
    expect(profileOfDataDir(home, join(home, ".minimax"))).toEqual({ kind: "default" });
  });

  it("names the profile whose primary data directory the path is", () => {
    fs.mkdirSync(join(home, ".minimax-cedar"), { recursive: true });
    expect(profileOfDataDir(home, join(home, ".minimax-cedar"))).toEqual({
      kind: "profile",
      profile: "cedar",
    });
  });

  // The identity check is realpath-based: a symlinked spelling of the profile
  // directory must resolve to the same profile, not fall into dd-<hash>.
  it("infers the profile through a symlink onto the profile directory", () => {
    const real = join(home, "real-cedar-data");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, join(home, ".minimax-cedar"));
    const viaLink = profileOfDataDir(home, join(home, ".minimax-cedar"));
    expect(viaLink).toEqual({ kind: "profile", profile: "cedar" });
    expect(profileOfDataDir(home, real)).toEqual(viaLink);
  });

  // A profile directory that does not exist yet must infer the same way the
  // daemon's realpath fallback will pin it once created (first-run case).
  it("infers a profile whose directory does not exist yet", () => {
    expect(profileOfDataDir(home, join(home, ".minimax-work"))).toEqual({
      kind: "profile",
      profile: "work",
    });
  });

  it("reports a genuinely foreign directory", () => {
    const foreign = join(home, "projects", "project-data");
    fs.mkdirSync(foreign, { recursive: true });
    expect(profileOfDataDir(home, foreign)).toEqual({ kind: "foreign" });
    expect(profileOfDataDir(home, home)).toEqual({ kind: "foreign" });
  });

  // A suffix outside the profile-name allowlist is not a profile directory:
  // guessing would redirect the control plane at an unvalidated name.
  it("reports foreign for suffixes that are not valid profile names", () => {
    fs.mkdirSync(join(home, ".minimax-"), { recursive: true });
    expect(profileOfDataDir(home, join(home, ".minimax-"))).toEqual({ kind: "foreign" });
    fs.mkdirSync(join(home, ".minimax--bad"), { recursive: true });
    expect(profileOfDataDir(home, join(home, ".minimax--bad"))).toEqual({ kind: "foreign" });
  });
});

describe("resolveDaemonControlRoot (profile inference from the dataDir)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "control-root-infer-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The headline fix (opus 2026-11-01): a profile-less request for a profile
  // directory keeps that profile's plain durable root — no dd-<hash> daemon
  // can appear for a profile directory anymore.
  it("keeps the plain root of the profile inferred from the dataDir", () => {
    fs.mkdirSync(join(home, ".minimax-cedar"), { recursive: true });
    expect(resolveDaemonControlRoot({ dataDir: join(home, ".minimax-cedar"), homeDir: home })).toBe(
      resolveDurableRoot("cedar", home),
    );
    expect(resolveDaemonControlRoot({ dataDir: join(home, ".minimax-cedar"), homeDir: home })).toBe(
      join(home, `${DURABLE_ROOT_BASENAME}-cedar`),
    );
  });

  it("keeps the unsuffixed root for the default profile's dataDir", () => {
    fs.mkdirSync(join(home, ".minimax"), { recursive: true });
    expect(resolveDaemonControlRoot({ dataDir: join(home, ".minimax"), homeDir: home })).toBe(
      resolveDurableRoot(null, home),
    );
  });

  it("resolves a symlinked spelling of the profile directory to the same root", () => {
    const real = join(home, "real-cedar-data");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, join(home, ".minimax-cedar"));
    expect(resolveDaemonControlRoot({ dataDir: join(home, ".minimax-cedar"), homeDir: home })).toBe(
      resolveDurableRoot("cedar", home),
    );
  });

  it("infers a not-yet-created profile directory to its plain root", () => {
    expect(resolveDaemonControlRoot({ dataDir: join(home, ".minimax-work"), homeDir: home })).toBe(
      resolveDurableRoot("work", home),
    );
    expect(fs.existsSync(join(home, ".minimax-work"))).toBe(false);
  });

  it("keeps dd-<hash> for a genuinely foreign dataDir", () => {
    const foreign = fs.mkdtempSync(join(home, "project-data-"));
    const controlRoot = resolveDaemonControlRoot({ dataDir: foreign, homeDir: home });
    expect(controlRoot.startsWith(join(resolveDurableRoot(null, home), "dd-"))).toBe(true);
  });

  it("an explicit profile still wins its own root, and a foreign dataDir under it stays dd-<hash>", () => {
    fs.mkdirSync(join(home, ".minimax-cedar"), { recursive: true });
    const foreign = fs.mkdtempSync(join(home, "project-data-"));
    expect(
      resolveDaemonControlRoot({ profile: "cedar", dataDir: join(home, ".minimax-cedar"), homeDir: home }),
    ).toBe(resolveDurableRoot("cedar", home));
    expect(
      resolveDaemonControlRoot({ profile: "cedar", dataDir: foreign, homeDir: home }),
    ).not.toBe(resolveDurableRoot("cedar", home));
  });
});
