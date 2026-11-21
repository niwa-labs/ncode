import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  buildChannelSuffix,
  PI_VENDOR_VERSION,
  resolveBuildChannel,
} from '../../src/application/build-marker.js';

function env(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { MCODE_BUILD_CHANNEL: value };
}

describe('build marker', () => {
  // The whole point of this module: a developer must be able to tell their own
  // fork build from the installed package. The version string cannot do that
  // job, so the badge is driven by an explicit opt-in instead.
  it('claims the fork build only for the exact chimera channel', () => {
    expect(resolveBuildChannel(env('chimera'))).toBe('chimera');
    expect(buildChannelSuffix(env('chimera'))).toBe(
      ' · chimera build',
    );
  });

  it('stays silent for an installed package', () => {
    expect(buildChannelSuffix(env(undefined))).toBe('');
    expect(buildChannelSuffix(env(''))).toBe('');
  });

  it('never mislabels an official build from an unexpected value', () => {
    // Fail-closed: anything that is not the known fork channel renders
    // nothing, so a typo or a future channel name cannot put the fork badge on
    // a published artifact. 'local' is a deliberate member of this list: the
    // old launcher channel must not silently keep claiming the badge.
    for (const value of ['npm', 'release', 'local', 'CHIMERA', 'chimera-dev', 'chimeras']) {
      expect(buildChannelSuffix(env(value))).toBe('');
    }
  });

  it('trims surrounding whitespace from the channel value', () => {
    expect(buildChannelSuffix(env('  chimera  '))).toBe(
      ' · chimera build',
    );
  });

  it('pins the advertised pi version to the vendored pi package', async () => {
    // The badge claims the pi core the fork runs on. This test is the drift
    // alarm for the hand-pinned constant: bumping the vendor without bumping
    // PI_VENDOR_VERSION (or the reverse) fails here.
    const vendored = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL(
            '../../../../third_party/pi-mono/packages/coding-agent/package.json',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    ) as { version: string };
    expect(PI_VENDOR_VERSION).toBe(vendored.version);
  });
});
