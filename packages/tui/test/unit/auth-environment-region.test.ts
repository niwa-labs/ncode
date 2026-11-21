import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readRuntimeRegion, resolveMcodeAuthEnvironment } from '../../src/auth/environment.js';
import { createDefaultMcodeAuthApplication } from '../../src/auth/factory.js';
import {
  createFakeOAuthSessionRecorder,
  type CapturedSharedAuthSession,
} from '../helpers/fake-oauth-session.js';

describe('resolveMcodeAuthEnvironment region', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps MAVIS_REGION=en to the en region', () => {
    vi.stubEnv('MAVIS_REGION', 'en');
    expect(resolveMcodeAuthEnvironment().region).toBe('en');
  });

  it('maps MAVIS_REGION=cn to the cn region', () => {
    vi.stubEnv('MAVIS_REGION', 'cn');
    expect(resolveMcodeAuthEnvironment().region).toBe('cn');
  });

  it.each([[undefined], [''], ['us']] as const)(
    'falls back to the cn default when MAVIS_REGION is %s',
    (value) => {
      // A `undefined` stub deletes the variable; anything unparsable maps to cn.
      vi.stubEnv('MAVIS_REGION', value);
      expect(resolveMcodeAuthEnvironment().region).toBe('cn');
    },
  );

  it('lets an explicit runtimeRegion beat MAVIS_REGION', () => {
    vi.stubEnv('MAVIS_REGION', 'en');
    expect(resolveMcodeAuthEnvironment({ runtimeRegion: 'cn' }).region).toBe('cn');
  });

  it('parses only the known regions', () => {
    expect(readRuntimeRegion('en')).toBe('en');
    expect(readRuntimeRegion('cn')).toBe('cn');
    expect(readRuntimeRegion(undefined)).toBeUndefined();
    expect(readRuntimeRegion('us')).toBeUndefined();
  });
});

describe('createDefaultMcodeAuthApplication region', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the prod/en scope and the en account origin under MAVIS_REGION=en', async () => {
    vi.stubEnv('MAVIS_REGION', 'en');
    vi.stubEnv('MAVIS_BUILD_ENV', 'prod');
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-auth-region-'));
    const captured: CapturedSharedAuthSession[] = [];
    try {
      const application = createDefaultMcodeAuthApplication({
        dataDir,
        createSharedSession: createFakeOAuthSessionRecorder(captured),
      });

      // The logout URL is built from the resolved scope, so it pins prod/en.
      await expect(application.logout()).resolves.toMatchObject({
        logoutUrl: expect.stringContaining('https://agent.minimax.io'),
      });
      expect(captured[0]).toMatchObject({ region: 'en', buildEnv: 'prod' });
      expect(captured[0]?.oauthEndpoints?.deviceAuthorizationEndpoint).toBe(
        'https://account.minimax.io/oauth2/device/code',
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
