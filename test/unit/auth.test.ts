import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { challengeFor, randomVerifier } from '../../src/auth/pkce';
import {
  DropboxAuth,
  PendingAuthState,
  REDIRECT_URI,
} from '../../src/auth/DropboxAuth';
import { AuthError } from '../../src/errors';
import { scriptedHttp } from '../support/scriptedHttp';

describe('PKCE helpers', () => {
  it('randomVerifier generates 64-char base64url strings with high entropy', () => {
    const v1 = randomVerifier();
    const v2 = randomVerifier();
    expect(v1).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(v2).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(v1).not.toBe(v2);
  });

  it('challengeFor matches node:crypto sha256 base64url oracle', async () => {
    const samples = [
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      randomVerifier(),
      'another-test-verifier_1234567890-abcdefghijklmnopqrstuvwxyz',
    ];
    for (const v of samples) {
      const expected = createHash('sha256').update(v).digest('base64url');
      const actual = await challengeFor(v);
      expect(actual).toBe(expected);
      expect(actual).not.toContain('=');
    }
  });
});

describe('DropboxAuth', () => {
  it('builds authorize URL with redirect_uri in redirect mode and omits it in manual mode', async () => {
    const { http } = scriptedHttp([]);
    let savedPending: PendingAuthState | null = null;

    const auth = new DropboxAuth({
      http,
      appKey: 'app-key-123',
      getRefreshToken: () => null,
      saveConnection: async () => {},
      savePendingAuth: async (p) => {
        savedPending = p;
      },
    });

    const redirectUrlStr = await auth.beginAuth('redirect');
    const redirectUrl = new URL(redirectUrlStr);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      'https://www.dropbox.com/oauth2/authorize',
    );
    expect(redirectUrl.searchParams.get('client_id')).toBe('app-key-123');
    expect(redirectUrl.searchParams.get('response_type')).toBe('code');
    expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(redirectUrl.searchParams.get('token_access_type')).toBe('offline');
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(savedPending).not.toBeNull();
    expect(savedPending!.mode).toBe('redirect');
    expect(redirectUrl.searchParams.get('code_challenge')).toBe(
      await challengeFor(savedPending!.verifier),
    );

    const manualUrlStr = await auth.beginAuth('manual');
    const manualUrl = new URL(manualUrlStr);
    expect(manualUrl.searchParams.get('client_id')).toBe('app-key-123');
    expect(manualUrl.searchParams.get('response_type')).toBe('code');
    expect(manualUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(manualUrl.searchParams.get('token_access_type')).toBe('offline');
    expect(manualUrl.searchParams.has('redirect_uri')).toBe(false);
    expect(savedPending!.mode).toBe('manual');
    expect(manualUrl.searchParams.get('code_challenge')).toBe(
      await challengeFor(savedPending!.verifier),
    );
  });

  it('completeAuth exchanges code in redirect mode, fetches account email, saves connection, and clears pending auth', async () => {
    const { http, requests } = scriptedHttp([
      {
        status: 200,
        json: {
          access_token: 'acc-1',
          token_type: 'bearer',
          expires_in: 14400,
          refresh_token: 'ref-1',
        },
      },
      {
        status: 200,
        json: {
          account_id: 'dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc',
          email: 'alice@example.com',
        },
      },
    ]);

    let refreshToken: string | null = null;
    let accountEmail: string | null = null;
    let pendingAuth: PendingAuthState | null = null;

    const auth = new DropboxAuth({
      http,
      appKey: 'my-app-key',
      getRefreshToken: () => refreshToken,
      saveConnection: async (rt, email) => {
        refreshToken = rt;
        accountEmail = email;
      },
      getPendingAuth: () => pendingAuth,
      savePendingAuth: async (p) => {
        pendingAuth = p;
      },
    });

    await auth.beginAuth('redirect');
    const expectedVerifier = pendingAuth!.verifier;

    await auth.completeAuth('c');

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://api.dropboxapi.com/oauth2/token');
    expect(requests[0].method).toBe('POST');
    const params = new URLSearchParams(requests[0].body as string);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('c');
    expect(params.get('client_id')).toBe('my-app-key');
    expect(params.get('code_verifier')).toBe(expectedVerifier);
    expect(params.get('redirect_uri')).toBe(REDIRECT_URI);

    expect(requests[1].url).toBe(
      'https://api.dropboxapi.com/2/users/get_current_account',
    );
    expect(requests[1].headers.Authorization).toBe('Bearer acc-1');

    expect(refreshToken).toBe('ref-1');
    expect(accountEmail).toBe('alice@example.com');
    expect(pendingAuth).toBeNull();
  });

  it('completeAuth succeeds on a fresh DropboxAuth instance using persisted getPendingAuth (mobile reload)', async () => {
    let persistedPending: PendingAuthState | null = null;
    let savedRefresh: string | null = null;
    let savedEmail: string | null = null;

    const { http: http1 } = scriptedHttp([]);
    const auth1 = new DropboxAuth({
      http: http1,
      appKey: 'my-app-key',
      getRefreshToken: () => savedRefresh,
      saveConnection: async () => {},
      savePendingAuth: async (p) => {
        persistedPending = p;
      },
    });

    await auth1.beginAuth('manual');
    expect(persistedPending).not.toBeNull();
    const verifier = persistedPending!.verifier;

    const { http: http2, requests } = scriptedHttp([
      {
        status: 200,
        json: {
          access_token: 'acc-mobile',
          expires_in: 14400,
          refresh_token: 'ref-mobile',
        },
      },
      {
        status: 200,
        json: {
          email: 'mobile@example.com',
        },
      },
    ]);

    const auth2 = new DropboxAuth({
      http: http2,
      appKey: 'my-app-key',
      getRefreshToken: () => savedRefresh,
      saveConnection: async (rt, email) => {
        savedRefresh = rt;
        savedEmail = email;
      },
      getPendingAuth: () => persistedPending,
      savePendingAuth: async (p) => {
        persistedPending = p;
      },
    });

    await auth2.completeAuth('manual-code');

    expect(requests).toHaveLength(2);
    const params = new URLSearchParams(requests[0].body as string);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('manual-code');
    expect(params.get('client_id')).toBe('my-app-key');
    expect(params.get('code_verifier')).toBe(verifier);
    expect(params.has('redirect_uri')).toBe(false);

    expect(savedRefresh).toBe('ref-mobile');
    expect(savedEmail).toBe('mobile@example.com');
    expect(persistedPending).toBeNull();
  });

  it('caches access token until 60s before expiry, then refreshes with grant_type=refresh_token', async () => {
    let currentTime = 1_000_000;
    const { http, requests } = scriptedHttp([
      {
        status: 200,
        json: {
          access_token: 'token-1',
          expires_in: 3600,
        },
      },
      {
        status: 200,
        json: {
          access_token: 'token-2',
          expires_in: 3600,
        },
      },
    ]);

    const auth = new DropboxAuth({
      http,
      appKey: 'app-key',
      getRefreshToken: () => 'stored-refresh-token',
      saveConnection: async () => {},
      now: () => currentTime,
    });

    const t1 = await auth.getAccessToken();
    const t2 = await auth.getAccessToken();
    expect(t1).toBe('token-1');
    expect(t2).toBe('token-1');
    expect(requests).toHaveLength(1);

    const firstParams = new URLSearchParams(requests[0].body as string);
    expect(firstParams.get('grant_type')).toBe('refresh_token');
    expect(firstParams.get('refresh_token')).toBe('stored-refresh-token');
    expect(firstParams.get('client_id')).toBe('app-key');

    // Advance time to within 60s of expiry (3600s - 60s = 3540s)
    currentTime += 3540 * 1000;
    const t3 = await auth.getAccessToken();
    expect(t3).toBe('token-2');
    expect(requests).toHaveLength(2);
    const secondParams = new URLSearchParams(requests[1].body as string);
    expect(secondParams.get('grant_type')).toBe('refresh_token');
  });

  it('throws AuthError and calls saveConnection(null, null) when refresh returns 400 invalid_grant', async () => {
    const { http } = scriptedHttp([
      {
        status: 400,
        json: {
          error: 'invalid_grant',
          error_description: 'refresh token is invalid or revoked',
        },
      },
    ]);

    const savedCalls: Array<{ rt: string | null; email: string | null }> = [];
    const auth = new DropboxAuth({
      http,
      appKey: 'app-key',
      getRefreshToken: () => 'revoked-refresh-token',
      saveConnection: async (rt, email) => {
        savedCalls.push({ rt, email });
      },
    });

    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthError);
    expect(savedCalls).toEqual([{ rt: null, email: null }]);
  });

  it('throws AuthError when no refresh token is available', async () => {
    const { http, requests } = scriptedHttp([]);
    const auth = new DropboxAuth({
      http,
      appKey: 'app-key',
      getRefreshToken: () => null,
      saveConnection: async () => {},
    });

    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthError);
    expect(requests).toHaveLength(0);
  });

  it('disconnect revokes token best-effort and clears connection', async () => {
    const { http, requests } = scriptedHttp([
      {
        status: 200,
        json: {
          access_token: 'token-to-revoke',
          expires_in: 3600,
        },
      },
      {
        status: 200,
      },
    ]);

    let refreshToken: string | null = 'valid-rt';
    let accountEmail: string | null = 'user@example.com';

    const auth = new DropboxAuth({
      http,
      appKey: 'app-key',
      getRefreshToken: () => refreshToken,
      saveConnection: async (rt, email) => {
        refreshToken = rt;
        accountEmail = email;
      },
    });

    await auth.getAccessToken();
    await auth.disconnect();

    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe(
      'https://api.dropboxapi.com/2/auth/token/revoke',
    );
    expect(requests[1].headers.Authorization).toBe('Bearer token-to-revoke');
    expect(refreshToken).toBeNull();
    expect(accountEmail).toBeNull();
  });
});
