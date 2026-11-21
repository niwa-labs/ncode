import { describe, expect, it } from 'vitest';

import { resolveDefaultChromeCandidates } from './headless-chrome-transport.js';

/**
 * The default Chrome discovery must cover the Beta channel: machines that
 * carry only Google Chrome Beta (no stable app) still get the out-of-the-box
 * Browser tool (owner bug 2026-11-07) instead of silently degrading to a
 * world where the `control-in-app-browser` skill has no tool behind it.
 */
describe('default Chrome discovery candidates', () => {
  it('includes the stable app before the Beta channel on macOS', () => {
    const candidates = resolveDefaultChromeCandidates('darwin', {});
    expect(candidates[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(candidates).toContain(
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    );
    expect(candidates.indexOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBeLessThan(
      candidates.indexOf('/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'),
    );
  });

  it('includes the Beta channel package on Linux', () => {
    expect(resolveDefaultChromeCandidates('linux', {})).toContain('/usr/bin/google-chrome-beta');
  });

  it('includes the Beta channel install path on Windows', () => {
    const candidates = resolveDefaultChromeCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' });
    expect(candidates).toContain('C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe');
  });
});
