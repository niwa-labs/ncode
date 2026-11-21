import {
  createAuthNamespace,
  FileStore,
  HttpOAuthClient,
  MCodeOAuthCore,
  type HttpOAuthClientOptions,
} from '@mavis/oauth-core';

import type { CreateMcodeSharedAuthSessionOptions } from '../../src/runtime/auth-session.js';

export interface CapturedSharedAuthSession {
  readonly region: CreateMcodeSharedAuthSessionOptions['region'];
  readonly buildEnv: CreateMcodeSharedAuthSessionOptions['buildEnv'];
  readonly oauthEndpoints?: Pick<
    HttpOAuthClientOptions,
    'deviceAuthorizationEndpoint' | 'tokenEndpoint' | 'revocationEndpoint'
  >;
}

/**
 * Real OAuth core and file store against the caller's namespace; only the
 * Account HTTP responses are simulated (the same cut as oauth-core's
 * local-auth fixture). The fake device page echoes the origin the session was
 * configured with, so region routing stays observable in the printed URL.
 */
export function createFakeOAuthSessionRecorder(captured: CapturedSharedAuthSession[]) {
  return (options: CreateMcodeSharedAuthSessionOptions): MCodeOAuthCore => {
    const namespace = createAuthNamespace({
      dataDir: options.dataDir,
      buildEnv: options.buildEnv,
      region: options.region,
    });
    captured.push({
      region: options.region,
      buildEnv: options.buildEnv,
      ...(options.oauthEndpoints ? { oauthEndpoints: options.oauthEndpoints } : {}),
    });
    return new MCodeOAuthCore({
      namespace,
      credentialStore: new FileStore({ authHome: namespace.namespaceHome }),
      oauthClient: new HttpOAuthClient({
        ...(options.oauthEndpoints ?? {}),
        fetchImpl: async (url, init) => {
          const target = String(url);
          if (target.endsWith('/device/code')) {
            return Response.json({
              user_code: 'TEST-CODE',
              verification_uri: `${new URL(target).origin}/device`,
              expired_in: Date.now() + 300_000,
              interval: 5_000,
            });
          }
          if (target.endsWith('/revoke')) return new Response(null, { status: 200 });
          const grantType = (init?.body as URLSearchParams | undefined)?.get('grant_type');
          const serial = grantType === 'refresh_token' ? 'refresh' : 'device';
          return Response.json({
            access_token: `test-access-${serial}`,
            refresh_token: `test-refresh-${serial}`,
            token_type: 'Bearer',
            scope: 'agent.default',
            expires_in: 3_600,
          });
        },
      }),
    });
  };
}
