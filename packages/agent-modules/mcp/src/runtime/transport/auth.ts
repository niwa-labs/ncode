/**
 * Bearer auth bridge — mcode credentials → pi-mcp `AuthProvider`.
 *
 * W08 PORT-PI-1.3: `@mavis/mcp` stays the credentials FACADE (§4 :504). The
 * pool reads a `tokenProvider` (mcode profile/lease credential source) per
 * request and hands this provider to the pi-mcp HTTP transport, which calls
 * `token()` only before requests whose answer it waits for and reports 401 /
 * insufficient-scope challenges through `onUnauthorized`. The bridge never
 * stores a token copy of its own — the mcode credential store keeps ownership
 * (one copy per profile, plan :789).
 */
import type { AuthProvider, UnauthorizedContext } from '@earendil-works/pi-mcp';
import type { McpTokenProvider } from '../types.js';

export interface BearerAuthProviderOptions {
  /** Resolves the current bearer token, if credentials exist. */
  token: McpTokenProvider;
  /**
   * Called when the server rejected the token (401 or insufficient_scope 403).
   * The credential owner decides what to do (refresh, invalidate, surface
   * needs-auth); the bridge itself never retries.
   */
  onRejected?: (context: UnauthorizedContext) => Promise<void> | void;
}

export function createBearerAuthProvider(options: BearerAuthProviderOptions): AuthProvider {
  return {
    async token(): Promise<string | undefined> {
      const value = await options.token();
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    },
    ...(options.onRejected
      ? {
          async onUnauthorized(context: UnauthorizedContext): Promise<void> {
            await options.onRejected?.(context);
          },
        }
      : {}),
  };
}
