import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveConfigFromRaw } from "../src/config.js";

// The MCODE_CODEMODE=1 dev/probe hatch resolves at config parse time, where
// "beta.runCode absent" is still distinguishable from an explicit `false`.
describe("beta.runCode config resolution (codemode hatch)", () => {
  const dataDir = join(tmpdir(), "mcode-config-beta-hatch");
  const rawWithBeta = (beta: Record<string, unknown>) => ({ beta });

  const originalEnv = process.env.MCODE_CODEMODE;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MCODE_CODEMODE;
    else process.env.MCODE_CODEMODE = originalEnv;
  });

  it("resolves an explicit true and the materialized default", () => {
    expect(
      resolveConfigFromRaw(rawWithBeta({ runCode: true }), dataDir).beta.runCode,
    ).toBe(true);
    // Default-off canon: nothing set, no hatch — OFF.
    delete process.env.MCODE_CODEMODE;
    expect(resolveConfigFromRaw({}, dataDir).beta.runCode).toBe(false);
  });

  it("lets MCODE_CODEMODE=1 stand in for an absent beta.runCode", () => {
    process.env.MCODE_CODEMODE = "1";
    expect(resolveConfigFromRaw({}, dataDir).beta.runCode).toBe(true);
    expect(
      resolveConfigFromRaw(rawWithBeta({ runCode: undefined }), dataDir).beta
        .runCode,
    ).toBe(true);
  });

  it("an explicit beta.runCode: false is the owner decision and blocks the hatch", () => {
    process.env.MCODE_CODEMODE = "1";
    expect(
      resolveConfigFromRaw(rawWithBeta({ runCode: false }), dataDir).beta
        .runCode,
    ).toBe(false);
  });
});
