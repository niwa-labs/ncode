import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAuthNamespace } from '@mavis/oauth-core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTuiLogin } from '../../src/cli/auth-command.js';
import { createDefaultMcodeAuthApplication } from '../../src/auth/factory.js';
import { readTuiRegionPreference, writeTuiRegionPreference } from '../../src/auth/region-preference.js';
import { prepareTuiDataDir } from '../../src/runtime/data-dir.js';
import { createFakeAccountIdentityFetch } from '../helpers/fake-account-identity-fetch.js';
import {
  createFakeOAuthSessionRecorder,
  type CapturedSharedAuthSession,
} from '../helpers/fake-oauth-session.js';

const tempHomes: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
// Keys written by the startup chain (configureTuiRuntimeEnvironment) plus the
// overrides these tests set themselves — restored so nothing leaks to the
// next file on this worker.
const envKeys = [
  'MAVIS_REGION',
  'MAVIS_BUILD_ENV',
  'MINIMAX_DATA_DIR',
  'MAVIS_DATA_DIR',
  '__MAVIS_RUNTIME_MANAGED',
  'HOME',
  'MCODE_OAUTH_DEVICE_AUTHORIZATION_ENDPOINT',
  'MCODE_OAUTH_TOKEN_ENDPOINT',
  'MCODE_OAUTH_REVOCATION_ENDPOINT',
];

beforeEach(() => {
  tempHomes.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-login-region-')));
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const home = tempHomes.at(-1) as string;
  process.env['HOME'] = home;
  process.env['MINIMAX_DATA_DIR'] = home;
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

async function loginWithFakeOAuth(
  dataDir: string,
): Promise<{ captured: CapturedSharedAuthSession[]; stderr: string[] }> {
  const captured: CapturedSharedAuthSession[] = [];
  const stderr: string[] = [];
  // The post-login identity projection must not reach the real account host.
  const { fetchImpl } = createFakeAccountIdentityFetch();
  await runTuiLogin({
    openBrowser: false,
    createApplication: () =>
      createDefaultMcodeAuthApplication({
        dataDir,
        createSharedSession: createFakeOAuthSessionRecorder(captured),
        fetchImpl,
      }),
    writeError: (value) => stderr.push(value),
  });
  return { captured, stderr };
}

function expectProdEnOnly(dataDir: string, stderr: string[]): void {
  const enNamespace = createAuthNamespace({ dataDir, buildEnv: 'prod', region: 'en' });
  const cnNamespace = createAuthNamespace({ dataDir, buildEnv: 'prod', region: 'cn' });
  const state = JSON.parse(fs.readFileSync(enNamespace.statePath, 'utf8')) as Record<
    string,
    unknown
  >;
  expect(state).toMatchObject({ status: 'authenticated', region: 'en', buildEnv: 'prod' });
  expect(fs.existsSync(cnNamespace.namespaceHome)).toBe(false);
  // The printed authorization URL points at the en account, not the cn one.
  expect(stderr.join('')).toContain('https://account.minimax.io');
  expect(stderr.join('')).not.toContain('https://account.minimax.cn');
  // A login must not poison the profile preference away from en.
  expect(readTuiRegionPreference(dataDir, 'prod')).toBe('en');
}

describe('mcode login region resolution (end to end)', () => {
  it('logs env=en in to prod/en without creating prod/cn state', async () => {
    process.env['MAVIS_REGION'] = 'en';
    const dataDir = await prepareTuiDataDir();

    const { captured, stderr } = await loginWithFakeOAuth(dataDir);

    expect(captured[0]).toMatchObject({ region: 'en', buildEnv: 'prod' });
    expect(captured[0]?.oauthEndpoints?.deviceAuthorizationEndpoint).toBe(
      'https://account.minimax.io/oauth2/device/code',
    );
    expectProdEnOnly(dataDir, stderr);
  });

  it('keeps prod/en for an empty env when the profile preference says en', async () => {
    // Owner scenario: previous login left prod/en in the preference, current
    // shell carries no MAVIS_REGION.
    const home = tempHomes.at(-1) as string;
    writeTuiRegionPreference(home, { region: 'en', buildEnv: 'prod' });
    const dataDir = await prepareTuiDataDir();

    const { captured, stderr } = await loginWithFakeOAuth(dataDir);

    expect(captured[0]).toMatchObject({ region: 'en', buildEnv: 'prod' });
    expectProdEnOnly(dataDir, stderr);
  });
});
