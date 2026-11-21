import {
  readLocalRuntimeAuthContext,
  type LocalRuntimeAuthContextSnapshot,
} from '@mavis/config';

import { TuiMatrixAccountClient } from '../account/matrix-account-client.js';
import { writeVerifiedCliAccountIdentity } from './identity-storage.js';
import { writeCliAuthContext, type CliAuthScope } from './storage.js';

export interface PersistLoginIdentityCacheOptions {
  readonly dataDir: string;
  readonly scope: CliAuthScope;
  readonly accessToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly writeAuthContext?: typeof writeCliAuthContext;
  readonly writeVerifiedIdentity?: typeof writeVerifiedCliAccountIdentity;
}

/**
 * Project a fresh login grant into the client identity cache the window
 * runtime reads (`local-runtime.auth.json`, plus the scoped private context
 * and the verified identity store the runtime's own refresh path writes —
 * lifecycle.ts resolveFeedbackAuthContext is the reference). The account
 * identity comes from the matrix USER_INFO endpoint; when it is unreachable
 * the cache degrades to the bare access token and this function stays silent —
 * a successful login must never fail on its bonus projection (fail-open).
 */
export async function persistLoginIdentityCache(
  options: PersistLoginIdentityCacheOptions,
): Promise<void> {
  const writeAuthContext = options.writeAuthContext ?? writeCliAuthContext;
  const writeVerifiedIdentity = options.writeVerifiedIdentity ?? writeVerifiedCliAccountIdentity;
  const accountClient = new TuiMatrixAccountClient({
    authContextGetter: () => undefined,
    region: options.scope.region,
    buildEnv: options.scope.buildEnv,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  // Snapshot the shared projection BEFORE the identity round-trip: if another
  // login lands while this one resolves, the stale `expectedSharedAuth` makes
  // writeCliAuthContext keep the newer writer's shared file.
  const expectedSharedAuth = readLocalRuntimeAuthContext(options.dataDir);
  const identity = await accountClient
    .getAuthContextForAuth({ accessToken: options.accessToken })
    .catch(() => undefined);
  const auth: LocalRuntimeAuthContextSnapshot = {
    accessToken: options.accessToken,
    ...(identity?.realUserID ? { realUserID: identity.realUserID } : {}),
    ...(identity?.userEmail ? { userEmail: identity.userEmail } : {}),
    ...(identity?.userName ? { userName: identity.userName } : {}),
    ...(identity?.subUserName ? { subUserName: identity.subUserName } : {}),
  };
  writeAuthContext(options.dataDir, auth, options.scope, { expectedSharedAuth });
  if (identity?.realUserID) {
    writeVerifiedIdentity(options.dataDir, options.scope, options.accessToken, identity);
  }
}
