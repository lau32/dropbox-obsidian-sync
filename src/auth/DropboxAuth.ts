import { AuthError, NetworkError } from '../errors';
import { HttpClient, HttpRequest, HttpResponse } from '../remote/http';
import { challengeFor, randomVerifier } from './pkce';

export { challengeFor, randomVerifier };

export const REDIRECT_URI = 'obsidian://dropbox-vault-sync-auth';

export interface PendingAuthState {
  verifier: string;
  mode: 'redirect' | 'manual';
}

export interface DropboxAuthOptions {
  http: HttpClient;
  appKey: string;
  getRefreshToken: () => string | null;
  saveConnection: (
    refreshToken: string | null,
    accountEmail: string | null,
  ) => Promise<void>;
  getPendingAuth?: () => PendingAuthState | null;
  savePendingAuth?: (pending: PendingAuthState | null) => Promise<void>;
  now?: () => number;
}

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const CURRENT_ACCOUNT_URL =
  'https://api.dropboxapi.com/2/users/get_current_account';
const REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';
const EXPIRY_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 14_400;

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class DropboxAuth {
  private readonly http: HttpClient;
  private readonly appKey: string;
  private readonly getRefreshToken: () => string | null;
  private readonly saveConnection: (
    refreshToken: string | null,
    accountEmail: string | null,
  ) => Promise<void>;
  private readonly getPendingAuth?: () => PendingAuthState | null;
  private readonly savePendingAuth?: (
    pending: PendingAuthState | null,
  ) => Promise<void>;
  private readonly now: () => number;

  private pendingAuth: PendingAuthState | null = null;
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(opts: DropboxAuthOptions) {
    this.http = opts.http;
    this.appKey = opts.appKey;
    this.getRefreshToken = opts.getRefreshToken;
    this.saveConnection = opts.saveConnection;
    this.getPendingAuth = opts.getPendingAuth;
    this.savePendingAuth = opts.savePendingAuth;
    this.now = opts.now ?? (() => Date.now());
  }

  async beginAuth(mode: 'redirect' | 'manual'): Promise<string> {
    const verifier = randomVerifier();
    const challenge = await challengeFor(verifier);
    const pending: PendingAuthState = { verifier, mode };
    this.pendingAuth = pending;
    await this.savePendingAuth?.(pending);

    const params = new URLSearchParams({
      client_id: this.appKey,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
    });
    if (mode === 'redirect') {
      params.set('redirect_uri', REDIRECT_URI);
    }

    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async completeAuth(code: string): Promise<void> {
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      throw new AuthError('Authorization code is empty');
    }

    const pending = this.pendingAuth ?? this.getPendingAuth?.() ?? null;
    if (!pending) {
      throw new AuthError('No pending OAuth flow');
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: trimmedCode,
      client_id: this.appKey,
      code_verifier: pending.verifier,
    });
    if (pending.mode === 'redirect') {
      params.set('redirect_uri', REDIRECT_URI);
    }

    const tokenRes = await this.sendRequest({
      url: TOKEN_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (tokenRes.status !== 200) {
      const errBody = tryParseJson(tokenRes.text());
      const desc =
        typeof errBody?.error_description === 'string'
          ? errBody.error_description
          : `Token exchange failed with status ${tokenRes.status}`;
      throw new AuthError(desc);
    }

    const tokenData = tryParseJson(tokenRes.text());
    const accessToken =
      typeof tokenData?.access_token === 'string'
        ? tokenData.access_token
        : null;
    const refreshToken =
      typeof tokenData?.refresh_token === 'string'
        ? tokenData.refresh_token
        : null;
    const expiresIn =
      typeof tokenData?.expires_in === 'number'
        ? tokenData.expires_in
        : DEFAULT_EXPIRES_IN_SECONDS;

    if (!accessToken || !refreshToken) {
      throw new AuthError('Token exchange response missing tokens');
    }

    this.accessToken = accessToken;
    this.expiresAt = this.now() + expiresIn * 1000;

    const accountRes = await this.sendRequest({
      url: CURRENT_ACCOUNT_URL,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // Explicit JSON null: a bodyless POST picks up a default Content-Type on
      // some platforms (Android) and Dropbox rejects it with a 400.
      body: 'null',
    });

    // The email is display-only; the tokens are already valid, so don't fail
    // the whole connection over it.
    const accountData =
      accountRes.status === 200 ? tryParseJson(accountRes.text()) : null;
    const email =
      typeof accountData?.email === 'string' ? accountData.email : null;

    await this.saveConnection(refreshToken, email);
    this.pendingAuth = null;
    await this.savePendingAuth?.(null);
  }

  async getAccessToken(): Promise<string> {
    if (
      this.accessToken !== null &&
      this.now() < this.expiresAt - EXPIRY_SAFETY_MARGIN_MS
    ) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  async refreshAccessToken(): Promise<string> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      this.accessToken = null;
      this.expiresAt = 0;
      throw new AuthError('No refresh token available');
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.appKey,
    });

    const res = await this.sendRequest({
      url: TOKEN_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (res.status >= 500) {
      throw new NetworkError(`Dropbox token server error (${res.status})`);
    }

    if (res.status !== 200) {
      this.accessToken = null;
      this.expiresAt = 0;
      const errBody = tryParseJson(res.text());
      if (res.status === 400 && errBody?.error === 'invalid_grant') {
        await this.saveConnection(null, null);
      }
      const desc =
        typeof errBody?.error_description === 'string'
          ? errBody.error_description
          : `Token refresh failed with status ${res.status}`;
      throw new AuthError(desc);
    }

    const data = tryParseJson(res.text());
    const accessToken =
      typeof data?.access_token === 'string' ? data.access_token : null;
    if (!accessToken) {
      throw new AuthError('Refresh response missing access_token');
    }

    const expiresIn =
      typeof data?.expires_in === 'number'
        ? data.expires_in
        : DEFAULT_EXPIRES_IN_SECONDS;

    this.accessToken = accessToken;
    this.expiresAt = this.now() + expiresIn * 1000;
    return accessToken;
  }

  async disconnect(): Promise<void> {
    try {
      const token =
        this.accessToken ??
        (this.getRefreshToken() ? await this.getAccessToken() : null);
      if (token) {
        await this.http({
          url: REVOKE_URL,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      }
    } catch {
      // Best-effort token revocation
    } finally {
      this.accessToken = null;
      this.expiresAt = 0;
      this.pendingAuth = null;
      await this.savePendingAuth?.(null);
      await this.saveConnection(null, null);
    }
  }

  private async sendRequest(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.http(req);
    } catch (err) {
      if (err instanceof AuthError || err instanceof NetworkError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new NetworkError(msg);
    }
  }
}
