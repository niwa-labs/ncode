/**
 * The W2 daemon control-plane APIs of `durable-paths.ts`: the
 * `MCODE_SERVER_MODE` resolution and the `off` start gate, the
 * `resolveDaemonControlRoot` control/data split (including the `dd-<hash>`
 * branch), and the `ensureControlRootLayout` guarantees — 0700 creation,
 * owner/write-bit verification of BOTH the control root and the fallback
 * socket directory (arch §4.6.1, §4.8, §2.2).
 *
 * @module
 */

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InvalidProfileNameError } from "../src/auth-profile.js";
import {
  ControlRootInsecureError,
  DURABLE_ROOT_BASENAME,
  DURABLE_SOCKET_BASENAME,
  MCODE_SERVER_MODE_ENV,
  ServerModeConfigError,
  ServerModeOffError,
  assertDaemonStartAllowed,
  ensureControlRootLayout,
  resolveDaemonControlRoot,
  resolveDurableRoot,
  resolveFallbackMcodedSocketDir,
  resolveFallbackMcodedSocketPath,
  resolveMcodedSocketPath,
  resolveServerMode,
} from "../src/durable-paths.js";

describe("resolveServerMode", () => {
  it("defaults to auto when the variable is absent, blank, or whitespace (owner decision 2026-10-29 after the green 24h soak)", () => {
    expect(resolveServerMode({})).toBe("auto");
    expect(resolveServerMode({ [MCODE_SERVER_MODE_ENV]: "" })).toBe("auto");
    expect(resolveServerMode({ [MCODE_SERVER_MODE_ENV]: "   " })).toBe("auto");
  });

  it.each([
    ["off", "off"],
    ["auto", "auto"],
    ["required", "required"],
    [" Auto ", "auto"],
    ["REQUIRED", "required"],
  ] as const)("parses %j as %j", (raw, expected) => {
    expect(resolveServerMode({ [MCODE_SERVER_MODE_ENV]: raw })).toBe(expected);
  });

  it.each(["yes", "ON", "1", "0", "production", "requiredd"])("fails closed on %j", (raw) => {
    expect(() => resolveServerMode({ [MCODE_SERVER_MODE_ENV]: raw })).toThrow(
      ServerModeConfigError,
    );
    try {
      resolveServerMode({ [MCODE_SERVER_MODE_ENV]: raw });
      expect.unreachable("resolveServerMode must throw");
    } catch (error) {
      expect((error as ServerModeConfigError).code).toBe("SERVER_MODE_INVALID");
      expect((error as ServerModeConfigError).value).toBe(raw);
    }
  });
});

describe("assertDaemonStartAllowed (the §4.8 daemon gate)", () => {
  it("refuses an explicit off with SERVER_MODE_OFF", () => {
    try {
      assertDaemonStartAllowed({ [MCODE_SERVER_MODE_ENV]: "off" });
      expect.unreachable("the gate must refuse off");
    } catch (error) {
      expect(error).toBeInstanceOf(ServerModeOffError);
      expect((error as ServerModeOffError).code).toBe("SERVER_MODE_OFF");
    }
  });

  it("allows the default (auto) — the owner flipped the product default on 2026-10-29", () => {
    expect(assertDaemonStartAllowed({})).toBe("auto");
  });

  it("refuses an explicit off", () => {
    expect(() => assertDaemonStartAllowed({ [MCODE_SERVER_MODE_ENV]: "off" })).toThrow(
      ServerModeOffError,
    );
  });

  it("passes auto and required through unchanged", () => {
    expect(assertDaemonStartAllowed({ [MCODE_SERVER_MODE_ENV]: "auto" })).toBe("auto");
    expect(assertDaemonStartAllowed({ [MCODE_SERVER_MODE_ENV]: "required" })).toBe("required");
  });

  it("propagates the unknown-value refusal", () => {
    expect(() => assertDaemonStartAllowed({ [MCODE_SERVER_MODE_ENV]: "maybe" })).toThrow(
      ServerModeConfigError,
    );
  });
});

describe("resolveDaemonControlRoot", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "daemon-control-root-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("uses the profile durable root when no dataDir override is given", () => {
    expect(resolveDaemonControlRoot({ homeDir: home })).toBe(resolveDurableRoot(null, home));
    expect(resolveDaemonControlRoot({ profile: "work", homeDir: home })).toBe(
      resolveDurableRoot("work", home),
    );
  });

  it.each(["", "   "])("treats the blank dataDir %j as no override", (dataDir) => {
    expect(resolveDaemonControlRoot({ dataDir, homeDir: home })).toBe(resolveDurableRoot(null, home));
  });

  it("keeps the default root when the override IS the profile data directory", () => {
    fs.mkdirSync(join(home, ".minimax"), { recursive: true });
    // A symlinked spelling resolves to the same directory, so the daemon must
    // stay on the unsuffixed root — no dd- branch for the profile's own dir.
    const link = join(home, "minimax-link");
    fs.symlinkSync(join(home, ".minimax"), link);
    expect(resolveDaemonControlRoot({ dataDir: link, homeDir: home })).toBe(
      resolveDurableRoot(null, home),
    );
  });

  it("moves the control root to dd-<hash> for a foreign dataDir", () => {
    const dataDir = fs.mkdtempSync(join(home, "project-data-"));
    const controlRoot = resolveDaemonControlRoot({ dataDir, homeDir: home });
    const defaultRoot = resolveDurableRoot(null, home);
    expect(controlRoot.startsWith(join(defaultRoot, "dd-"))).toBe(true);
    const segment = controlRoot.slice(defaultRoot.length + 1);
    expect(segment).toMatch(/^dd-[0-9a-f]{16}$/);
    // Two different data dirs never share one control root.
    const other = resolveDaemonControlRoot({ dataDir: join(home, "other"), homeDir: home });
    expect(other).not.toBe(controlRoot);
    // Same dir → same root (deterministic).
    expect(resolveDaemonControlRoot({ dataDir, homeDir: home })).toBe(controlRoot);
  });

  it("does not touch the disk", () => {
    const missing = join(home, "not-created-yet");
    expect(() => resolveDaemonControlRoot({ dataDir: missing, homeDir: home })).not.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("propagates the profile-name refusal", () => {
    expect(() => resolveDaemonControlRoot({ profile: "../evil", homeDir: home })).toThrow(
      InvalidProfileNameError,
    );
  });
});

describe("ensureControlRootLayout", () => {
  let home: string;
  const tempDirs: string[] = [];

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "ensure-layout-"));
    tempDirs.push(home);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the control root with 0700 and is idempotent", () => {
    const root = join(home, DURABLE_ROOT_BASENAME);
    expect(ensureControlRootLayout(root)).toBe(root);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(ensureControlRootLayout(root)).toBe(root);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });

  it("fails closed on an existing group/other-writable control root", () => {
    const root = join(home, DURABLE_ROOT_BASENAME);
    fs.mkdirSync(root, { recursive: true });
    // chmod (not mkdir mode): the umask would mask the write bits off.
    fs.chmodSync(root, 0o757);
    expect(() => ensureControlRootLayout(root)).toThrow(ControlRootInsecureError);
    // The misconfiguration is reported, not silently tightened.
    expect(fs.statSync(root).mode & 0o777).toBe(0o757);
  });

  it("creates and verifies the fallback socket directory when the socket path is too long", () => {
    // A long profile name pushes <root>/mcoded.sock past the sun_path limit,
    // so the socket falls back to /tmp/mcoded-<uid>/<hash>.sock (§4.6.1).
    const longProfile = "p".repeat(64);
    const root = resolveDurableRoot(longProfile, home);
    expect(Buffer.byteLength(join(root, DURABLE_SOCKET_BASENAME))).toBeGreaterThan(100);
    expect(resolveMcodedSocketPath(root)).toBe(resolveFallbackMcodedSocketPath(root));
    const fallbackDir = resolveFallbackMcodedSocketDir(root);

    ensureControlRootLayout(root);
    expect(fs.existsSync(fallbackDir)).toBe(true);
    expect(fs.statSync(fallbackDir).mode & 0o777).toBe(0o700);
    expect(resolveFallbackMcodedSocketPath(root).startsWith(fallbackDir)).toBe(true);

    // Cleanup: the fallback dir lives under the shared tmpdir, not under home.
    fs.rmSync(fallbackDir, { recursive: true, force: true });
  });

  it("refuses a pre-existing fallback socket directory that is group/other-writable", () => {
    // mkdir recursive must not silently accept a directory we did not create
    // (arch §4.6.1: "каталог 0700, владелец проверяется").
    const longProfile = "q".repeat(64);
    const root = resolveDurableRoot(longProfile, home);
    const fallbackDir = resolveFallbackMcodedSocketDir(root);
    fs.rmSync(fallbackDir, { recursive: true, force: true });
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.chmodSync(fallbackDir, 0o757);
    try {
      expect(() => ensureControlRootLayout(root)).toThrow(ControlRootInsecureError);
    } finally {
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  });

  it("accepts a pre-existing correctly-permissioned fallback socket directory", () => {
    const longProfile = "r".repeat(60);
    const root = resolveDurableRoot(longProfile, home);
    const fallbackDir = resolveFallbackMcodedSocketDir(root);
    fs.rmSync(fallbackDir, { recursive: true, force: true });
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
    try {
      expect(() => ensureControlRootLayout(root)).not.toThrow();
    } finally {
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  });
});
