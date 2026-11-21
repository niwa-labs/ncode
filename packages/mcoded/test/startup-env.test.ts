import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readProfileStartupEnvironment } from '../src/startup-env.js';

// W2 live-check finding: the standalone daemon entry must resolve the same
// env identity as the TUI CLI (profile region preference → cn default), or
// profile-aware clients get ENV_MISMATCH on the v2 handshake.

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function profileHome(profile: string | null, regions?: Record<string, string>): string {
  root = mkdtempSync(path.join(tmpdir(), 'startup-env-'));
  const dataDirName = profile ? `.minimax-${profile}` : '.minimax';
  const dataDir = path.join(root, dataDirName);
  mkdirSync(path.join(dataDir, 'preferences'), { recursive: true });
  if (regions) {
    writeFileSync(
      path.join(dataDir, 'preferences', 'mcode-region.json'),
      `${JSON.stringify({ version: 1, regions, updatedAtMs: 1 })}\n`,
    );
  }
  return root;
}

describe('readProfileStartupEnvironment (standalone daemon env parity)', () => {
  it('explicit MAVIS_REGION wins over the profile preference', () => {
    const home = profileHome('cedar', { prod: 'cn' });
    const env: NodeJS.ProcessEnv = { HOME: home, MINIMAX_PROFILE: 'cedar', MAVIS_REGION: 'en' };
    expect(readProfileStartupEnvironment(env, home)).toEqual({ region: 'en', buildEnv: undefined });
  });

  it('reads the profile region preference (TUI parity file format)', () => {
    const home = profileHome('cedar', { prod: 'en' });
    const env: NodeJS.ProcessEnv = { HOME: home, MINIMAX_PROFILE: 'cedar' };
    expect(readProfileStartupEnvironment(env, home)).toEqual({ region: 'en', buildEnv: undefined });
  });

  it('falls back to cn (managed-account default), not the bare-shell en', () => {
    const home = profileHome(null);
    const env: NodeJS.ProcessEnv = { HOME: home };
    expect(readProfileStartupEnvironment(env, home)).toEqual({ region: 'cn', buildEnv: undefined });
  });

  it('keeps an explicit buildEnv and pairs it with the preference region', () => {
    const home = profileHome('cedar', { prod: 'cn', dev: 'en' });
    const env: NodeJS.ProcessEnv = { HOME: home, MINIMAX_PROFILE: 'cedar', MAVIS_BUILD_ENV: 'dev' };
    expect(readProfileStartupEnvironment(env, home)).toEqual({ region: 'en', buildEnv: 'dev' });
  });

  it('never throws on a broken preference file', () => {
    const home = profileHome('cedar');
    writeFileSync(
      path.join(home, '.minimax-cedar', 'preferences', 'mcode-region.json'),
      'not json',
    );
    const env: NodeJS.ProcessEnv = { HOME: home, MINIMAX_PROFILE: 'cedar' };
    expect(readProfileStartupEnvironment(env, home).region).toBe('cn');
  });
});
