import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAuthNamespace } from '@mavis/oauth-core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTuiLogin, runTuiLogout } from '../../src/cli/auth-command.js';
import { createFakeAccountIdentityFetch } from '../helpers/fake-account-identity-fetch.js';
import type { CapturedSharedAuthSession } from '../helpers/fake-oauth-session.js';

// The fake OAuth session from wave 4, applied one level up the stack: only the
// Account HTTP traffic is simulated. Everything between the CLI flag and the
// data directory — program.ts, auth-command.ts, prepareTuiDataDir — stays real,
// so these tests pin exactly the wiring that decides which store is used.
const fakes = vi.hoisted(() => ({ captured: [] as CapturedSharedAuthSession[] }));
vi.mock('../../src/runtime/auth-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/auth-session.js')>();
  const { createFakeOAuthSessionRecorder } = await import('../helpers/fake-oauth-session.js');
  return {
    ...actual,
    createMcodeSharedAuthSession: createFakeOAuthSessionRecorder(fakes.captured),
  };
});

const tempHomes: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
// Keys written by the startup chain (configureTuiRuntimeEnvironment) plus the
// profile selectors these tests set themselves — restored so nothing leaks to
// the next file on this worker.
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
  tempHomes.push(fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-profile-flag-')));
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const home = tempHomes.at(-1) as string;
  process.env['HOME'] = home;
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

function profileDir(profile: 'default' | 'cedar'): string {
  return profile === 'default'
    ? path.join(currentHome(), '.minimax')
    : path.join(currentHome(), '.minimax-cedar');
}

function namespaceState(profile: 'default' | 'cedar'): string {
  return createAuthNamespace({
    dataDir: profileDir(profile),
    buildEnv: 'prod',
    region: 'en',
  }).statePath;
}

function seedAuthenticatedState(profile: 'default' | 'cedar'): void {
  fs.mkdirSync(path.dirname(namespaceState(profile)), { recursive: true });
  fs.writeFileSync(
    namespaceState(profile),
    JSON.stringify({
      schemaVersion: 2,
      status: 'authenticated',
      storeKind: 'file',
      clientId: 'mcode-public',
      scopes: ['agent.default'],
      audience: 'agent-backend',
      buildEnv: 'prod',
      region: 'en',
      generation: 3,
    }),
  );
}

function storedStatus(profile: 'default' | 'cedar'): string | undefined {
  return (JSON.parse(fs.readFileSync(namespaceState(profile), 'utf8')) as { status?: string })
    .status;
}

describe('mcode login resolves the data directory from --profile (end to end)', () => {
  // The post-login identity projection must not reach the real account host.
  const identityFetch = createFakeAccountIdentityFetch();

  it('writes --profile default under an cedar environment to ~/.minimax, not .minimax-cedar', async () => {
    process.env['MINIMAX_PROFILE'] = 'cedar';

    const message = await runTuiLogin({
      openBrowser: false,
      profile: 'default',
      fetchImpl: identityFetch.fetchImpl,
      writeError: () => undefined,
    });

    expect(message).toBe('Signed in with MiniMax.');
    expect(storedStatus('default')).toBe('authenticated');
    // The mine this pins: the wrapper's env profile used to win, so a default
    // login wiped the cedar store instead of creating the default one.
    expect(fs.existsSync(profileDir('cedar'))).toBe(false);
    expect(fakes.captured).toHaveLength(1);
  });

  it('writes --profile cedar under a default environment to .minimax-cedar', async () => {
    const message = await runTuiLogin({
      openBrowser: false,
      profile: 'cedar',
      fetchImpl: identityFetch.fetchImpl,
      writeError: () => undefined,
    });

    expect(message).toBe('Signed in with MiniMax.');
    expect(storedStatus('cedar')).toBe('authenticated');
    expect(fs.existsSync(profileDir('default'))).toBe(false);
  });

  it('keeps the environment profile for login without a flag', async () => {
    process.env['MINIMAX_PROFILE'] = 'cedar';

    const message = await runTuiLogin({
      openBrowser: false,
      fetchImpl: identityFetch.fetchImpl,
      writeError: () => undefined,
    });

    expect(message).toBe('Signed in with MiniMax.');
    expect(storedStatus('cedar')).toBe('authenticated');
    expect(fs.existsSync(profileDir('default'))).toBe(false);
  });
});

describe('mcode logout resolves the data directory from --profile (end to end)', () => {
  it('signs --profile default out of ~/.minimax while an cedar environment is set', async () => {
    seedAuthenticatedState('default');
    process.env['MINIMAX_PROFILE'] = 'cedar';

    const stderr: string[] = [];
    const message = await runTuiLogout({
      openBrowser: false,
      profile: 'default',
      writeError: (value) => stderr.push(value),
    });

    expect(message).toContain('Signed out of MiniMax Global');
    expect(storedStatus('default')).toBe('anonymous');
    // The cedar store the environment points at must stay untouched.
    expect(fs.existsSync(profileDir('cedar'))).toBe(false);
  });

  it('signs --profile cedar out of .minimax-cedar while the environment is default', async () => {
    seedAuthenticatedState('cedar');

    const message = await runTuiLogout({
      openBrowser: false,
      profile: 'cedar',
      writeError: () => undefined,
    });

    expect(message).toContain('Signed out of MiniMax Global');
    expect(storedStatus('cedar')).toBe('anonymous');
    expect(fs.existsSync(profileDir('default'))).toBe(false);
  });

  it('keeps the environment profile for logout without a flag', async () => {
    seedAuthenticatedState('cedar');
    process.env['MINIMAX_PROFILE'] = 'cedar';

    const message = await runTuiLogout({
      openBrowser: false,
      writeError: () => undefined,
    });

    expect(message).toContain('Signed out of MiniMax Global');
    expect(storedStatus('cedar')).toBe('anonymous');
    expect(fs.existsSync(profileDir('default'))).toBe(false);
  });
});
