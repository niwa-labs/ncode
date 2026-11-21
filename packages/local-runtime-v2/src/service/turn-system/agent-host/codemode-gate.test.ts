import { describe, expect, it } from 'vitest';

import { isRunCodeEnabled } from './codemode-gate.js';

describe('isRunCodeEnabled (the one run_code fact for a Turn)', () => {
  it('enables on explicit beta.runCode: true', () => {
    expect(isRunCodeEnabled({ runCode: true })).toBe(true);
  });

  it('stays off without beta and on an explicit false', () => {
    expect(isRunCodeEnabled(undefined)).toBe(false);
    expect(isRunCodeEnabled({})).toBe(false);
    // Default-off canon: the K1 acceptance matrix has not passed, so the
    // resolved default (and an explicit owner false) both keep it closed.
    // The MCODE_CODEMODE hatch materializes at config parse time, not here.
    expect(isRunCodeEnabled({ runCode: false })).toBe(false);
  });
});
