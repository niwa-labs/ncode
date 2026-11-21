export interface FakeAccountIdentity {
  readonly realUserID: string;
  readonly userEmail?: string;
  readonly userName?: string;
  readonly subUserName?: string;
}

export interface FakeAccountIdentityFetch {
  /** `typeof fetch` for the account client; rejects on any other endpoint. */
  readonly fetchImpl: typeof fetch;
  /** Every requested URL, in order — assertions pin the USER_INFO call. */
  readonly calls: string[];
}

/**
 * Fetch implementation for the matrix account identity endpoint only: answers
 * `GET <matrix-origin>/v1/api/user/info` with a fixed USER_INFO payload and
 * fails on anything else, so auth tests can drive the real post-login identity
 * projection without network access (the OAuth half is faked separately by
 * `fake-oauth-session.ts`).
 */
export function createFakeAccountIdentityFetch(
  identity: FakeAccountIdentity = {
    realUserID: 'user-42',
    userEmail: 'user@example.test',
    userName: 'Test User',
  },
): FakeAccountIdentityFetch {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (!target.includes('/v1/api/user/info')) {
      throw new Error(`Unexpected account fetch: ${target}`);
    }
    return Response.json({
      statusInfo: { code: 0 },
      data: {
        userInfo: {
          realUserID: identity.realUserID,
          ...(identity.userEmail ? { email: identity.userEmail } : {}),
          ...(identity.userName ? { name: identity.userName } : {}),
          ...(identity.subUserName ? { sub_user_name: identity.subUserName } : {}),
        },
      },
    });
  };
  return { fetchImpl, calls };
}
