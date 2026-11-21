import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readLocalRuntimeAuthContext } from '@mavis/config';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTuiLogin, runTuiLogout } from '../../src/cli/auth-command.js';
import { createFakeAccountIdentityFetch } from '../helpers/fake-account-identity-fetch.js';
import type { CapturedSharedAuthSession } from '../helpers/fake-oauth-session.js';

// Wave 7 (owner complaint 2026-11-02): after a successful `mcode login` the
// window used to start without the client identity cache — only the window
// runtime created it later, on a context refresh — so quotas showed
// "Temporarily unavailable" and the daemon-login mismatch warning fired.
// The fake OAuth session (wave 4) and the fake account identity keep the
// whole CLI chain real (program.ts → auth-command.ts → prepareTuiDataDir →
// McodeAuthApplication → the MCodeOAuthCore file store); only the Account
// HTTP traffic is simulated.
const fakes = vi.hoisted(() => ({ captured: [] as CapturedSharedAuthSession[] }));
vi.mock('../../src/runtime/auth-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/auth-session.js')>();
  const { createFakeOAuthSessionRecorder } = await import('../helpers/fake-oauth-session.js');
  return {
    ...actual,
    createMcodeSharedAuthSession: createFakeOAuthSessionRecorder(fakes.captured),
  };
});

// The grant the fake OAuth session commits (fake-oauth-session.ts).
const GRANT_ACCESS_TOKEN = 'test-access-device';

const tempHomes: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  'MAVIS_REGION',
  'MAVIS_BUILD_ENV',
  'MINIMAX_DATA_DIR',
  'MAVIS_DATA_DIR',
  '__MAVIS_RUNTIME_MANAGED',
  '__MAVIS_ALLOW_LEGACY_RUNTIME_ENV',
  '__MAVIS_RUNTIME_PROFILE',
  'HOME',
  'MINIMAX_PROFILE',
];

beforeEach(() => {
  tempHomes.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-login-identity-cache-')));
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env['HOME'] = tempHomes.at(-1) as string;
  process.env['MAVIS_REGION'] = 'en';
  process.env['MAVIS_BUILD_ENV'] = 'prod';
});

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(() => {
  for (const home of tempHomes) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function currentHome(): string {
  return tempHomes.at(-1) as string;
}

function dataDir(): string {
  return path.join(currentHome(), '.minimax');
}

function identityCachePath(): string {
  return path.join(dataDir(), 'local-runtime.auth.json');
}

describe('mcode login projects the identity cache (end to end)', () => {
  it('writes the grant token and the account identity right after a fresh login', async () => {
    const identityFetch = createFakeAccountIdentityFetch();

    const message = await runTuiLogin({
      openBrowser: false,
      fetchImpl: identityFetch.fetchImpl,
      writeError: () => undefined,
    });

    expect(message).toBe('Signed in with MiniMax.');
    expect(identityFetch.calls.some((target) => target.includes('/v1/api/user/info'))).toBe(true);
    // The window runtime reads the cache through readLocalRuntimeAuthContext.
    expect(readLocalRuntimeAuthContext(dataDir())).toMatchObject({
      accessToken: GRANT_ACCESS_TOKEN,
      realUserID: 'user-42',
      userEmail: 'user@example.test',
      userName: 'Test User',
    });
    const raw = JSON.parse(fs.readFileSync(identityCachePath(), 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 1,
      auth: { accessToken: GRANT_ACCESS_TOKEN, realUserID: 'user-42' },
    });
    expect(typeof raw['updatedAtMs']).toBe('number');
  });

  it('keeps the login successful and caches the bare token when the identity API is down', async () => {
    const message = await runTuiLogin({
      openBrowser: false,
      fetchImpl: async () => {
        throw new Error('identity API unreachable');
      },
      writeError: () => undefined,
    });

    expect(message).toBe('Signed in with MiniMax.');
    // Fail-open: the cache still carries the grant so quotas resolve, without
    // an unverified identity.
    expect(readLocalRuntimeAuthContext(dataDir())).toEqual({
      accessToken: GRANT_ACCESS_TOKEN,
    });
    expect(readLocalRuntimeAuthContext(dataDir())?.realUserID).toBeUndefined();
  });

  it('logout clears the identity cache and its projections', async () => {
    const identityFetch = createFakeAccountIdentityFetch();
    await runTuiLogin({
      openBrowser: false,
      fetchImpl: identityFetch.fetchImpl,
      writeError: () => undefined,
    });
    expect(fs.existsSync(identityCachePath())).toBe(true);

    const stderr: string[] = [];
    const message = await runTuiLogout({
      openBrowser: false,
      writeError: (value) => stderr.push(value),
    });

    expect(message).toContain('Signed out of MiniMax Global');
    expect(fs.existsSync(identityCachePath())).toBe(false);
    expect(readLocalRuntimeAuthContext(dataDir())).toBeUndefined();
    expect(
      fs.existsSync(path.join(dataDir(), 'cli-auth', 'prod', 'en', 'local-runtime.auth.json')),
    ).toBe(false);
    expect(fs.existsSync(path.join(dataDir(), 'cli-auth', 'shared-projection.json'))).toBe(false);
  });
});
