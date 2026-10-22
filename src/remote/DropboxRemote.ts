import { RemoteStore } from './RemoteStore';
import { HttpClient, HttpResponse } from './http';
import { RemoteChange, RemoteEntry, WriteMode } from '../types';
import {
  AuthError,
  CursorResetError,
  InsufficientSpaceError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  RemotePathError,
  RevConflictError,
} from '../errors';
import { fromRemotePath, toRemotePath } from '../paths';

const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

const API_BASE = 'https://api.dropboxapi.com/2/files';
const CONTENT_BASE = 'https://content.dropboxapi.com/2/files';
const NOTIFY_LONGPOLL = 'https://notify.dropboxapi.com/2/files/list_folder/longpoll';

export function encodeApiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

function formatClientModified(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface DropboxRawEntry {
  '.tag'?: 'file' | 'folder' | 'deleted';
  name?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  rev?: string;
  content_hash?: string;
  server_modified?: string;
}

export interface DropboxRemoteOptions {
  http: HttpClient;
  root: string;
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class DropboxRemote implements RemoteStore {
  private readonly http: HttpClient;
  private readonly root: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly refreshAccessToken: () => Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(opts: DropboxRemoteOptions) {
    this.http = opts.http;
    this.root = opts.root;
    this.getAccessToken = opts.getAccessToken;
    this.refreshAccessToken = opts.refreshAccessToken;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = opts.maxRetries ?? 5;
  }

  private async send(opts: {
    url: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    auth?: boolean;
  }): Promise<HttpResponse> {
    const useAuth = opts.auth ?? true;
    let token = useAuth ? await this.getAccessToken() : '';
    let refreshed401 = false;
    let rateLimitAttempt = 0;

    while (true) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (useAuth) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      let res: HttpResponse;
      try {
        res = await this.http({
          url: opts.url,
          method: 'POST',
          headers,
          body: opts.body,
        });
      } catch (err) {
        throw new NetworkError(err instanceof Error ? err.message : String(err));
      }

      if (res.status === 401 && useAuth) {
        if (refreshed401) {
          throw new AuthError();
        }
        refreshed401 = true;
        try {
          token = await this.refreshAccessToken();
        } catch (err) {
          throw new AuthError(err instanceof Error ? err.message : 'Token refresh failed');
        }
        continue;
      }

      if (res.status === 429 || res.status === 503) {
        const retryHeader = getHeader(res.headers, 'retry-after');
        const parsedSec = retryHeader !== undefined ? Number(retryHeader) : NaN;
        const delayMs =
          Number.isFinite(parsedSec) && parsedSec >= 0
            ? parsedSec * 1000
            : 1000 * Math.pow(2, rateLimitAttempt) + Math.floor(Math.random() * 100);

        if (rateLimitAttempt >= this.maxRetries) {
          throw new RateLimitError(delayMs);
        }
        rateLimitAttempt += 1;
        await this.sleep(delayMs);
        continue;
      }

      return res;
    }
  }

  private extractErrorSummary(res: HttpResponse): string {
    const parsed = tryParseJson(res.text());
    if (parsed && typeof parsed.error_summary === 'string') {
      return parsed.error_summary;
    }
    return `HTTP ${res.status}`;
  }

  private checkCommonErrors(summary: string): void {
    if (summary.includes('insufficient_space')) {
      throw new InsufficientSpaceError(summary);
    }
    if (summary.startsWith('reset')) {
      throw new CursorResetError(summary);
    }
  }

  private toEntry(raw: DropboxRawEntry, fallbackPath?: string): RemoteEntry | null {
    const rawPath = raw.path_display ?? raw.path_lower;
    const relPath = rawPath ? fromRemotePath(this.root, rawPath) : (fallbackPath ?? null);
    if (!relPath) {
      return null;
    }
    const isFolder = raw['.tag'] === 'folder';
    if (isFolder) {
      return {
        path: relPath,
        isFolder: true,
        size: 0,
        rev: null,
        contentHash: null,
        serverModified: null,
      };
    }
    return {
      path: relPath,
      isFolder: false,
      size: raw.size ?? 0,
      rev: raw.rev ?? null,
      contentHash: raw.content_hash ?? null,
      serverModified: raw.server_modified ? Date.parse(raw.server_modified) : null,
    };
  }

  private toChange(raw: DropboxRawEntry): RemoteChange | null {
    const rawPath = raw.path_display ?? raw.path_lower;
    if (!rawPath) {
      return null;
    }
    const relPath = fromRemotePath(this.root, rawPath);
    if (!relPath) {
      return null;
    }
    if (raw['.tag'] === 'deleted') {
      return { kind: 'deleted', path: relPath };
    }
    const entry = this.toEntry(raw, relPath);
    if (!entry) {
      return null;
    }
    return { kind: 'upsert', entry };
  }

  async listAll(): Promise<{ entries: RemoteEntry[]; cursor: string }> {
    const remoteRoot = toRemotePath(this.root, '');
    const res = await this.send({
      url: `${API_BASE}/list_folder`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: remoteRoot, recursive: true }),
    });

    if (res.status !== 200) {
      const summary = this.extractErrorSummary(res);
      this.checkCommonErrors(summary);
      if (res.status === 409 && summary.startsWith('path/not_found')) {
        await this.createFolder('');
        return this.listAll();
      }
      throw new RemotePathError('', summary);
    }

    let page = JSON.parse(res.text()) as {
      entries: DropboxRawEntry[];
      cursor: string;
      has_more: boolean;
    };

    const entries: RemoteEntry[] = [];
    for (const raw of page.entries) {
      if (raw['.tag'] === 'deleted') {
        continue;
      }
      const entry = this.toEntry(raw);
      if (entry) {
        entries.push(entry);
      }
    }

    while (page.has_more) {
      const contRes = await this.send({
        url: `${API_BASE}/list_folder/continue`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor: page.cursor }),
      });

      if (contRes.status !== 200) {
        const summary = this.extractErrorSummary(contRes);
        this.checkCommonErrors(summary);
        throw new RemotePathError('', summary);
      }

      page = JSON.parse(contRes.text()) as {
        entries: DropboxRawEntry[];
        cursor: string;
        has_more: boolean;
      };

      for (const raw of page.entries) {
        if (raw['.tag'] === 'deleted') {
          continue;
        }
        const entry = this.toEntry(raw);
        if (entry) {
          entries.push(entry);
        }
      }
    }

    return { entries, cursor: page.cursor };
  }

  async listChanges(cursor: string): Promise<{ changes: RemoteChange[]; cursor: string }> {
    const changes: RemoteChange[] = [];
    let currentCursor = cursor;
    let hasMore = true;

    while (hasMore) {
      const res = await this.send({
        url: `${API_BASE}/list_folder/continue`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor: currentCursor }),
      });

      if (res.status !== 200) {
        const summary = this.extractErrorSummary(res);
        this.checkCommonErrors(summary);
        throw new RemotePathError('', summary);
      }

      const page = JSON.parse(res.text()) as {
        entries: DropboxRawEntry[];
        cursor: string;
        has_more: boolean;
      };

      for (const raw of page.entries) {
        const change = this.toChange(raw);
        if (change) {
          changes.push(change);
        }
      }

      currentCursor = page.cursor;
      hasMore = page.has_more;
    }

    return { changes, cursor: currentCursor };
  }

  async longpoll(cursor: string, timeoutSec: number): Promise<{ changed: boolean; backoffSec: number }> {
    const res = await this.send({
      url: NOTIFY_LONGPOLL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, timeout: timeoutSec }),
      auth: false,
    });

    if (res.status !== 200) {
      const summary = this.extractErrorSummary(res);
      this.checkCommonErrors(summary);
      throw new RemotePathError('', summary);
    }

    const body = JSON.parse(res.text()) as { changes?: boolean; backoff?: number };
    return {
      changed: Boolean(body.changes),
      backoffSec: body.backoff ?? 0,
    };
  }

  async download(path: string): Promise<{ data: ArrayBuffer; entry: RemoteEntry }> {
    const remotePath = toRemotePath(this.root, path);
    const res = await this.send({
      url: `${CONTENT_BASE}/download`,
      headers: {
        'Dropbox-API-Arg': encodeApiArg({ path: remotePath }),
      },
    });

    if (res.status !== 200) {
      const summary = this.extractErrorSummary(res);
      this.checkCommonErrors(summary);
      if (
        res.status === 409 &&
        (summary.startsWith('path/not_found') || summary.startsWith('path_lookup/not_found'))
      ) {
        throw new NotFoundError(path, summary);
      }
      throw new RemotePathError(path, summary);
    }

    const resultHeader = getHeader(res.headers, 'dropbox-api-result');
    const rawMeta = resultHeader ? (JSON.parse(resultHeader) as DropboxRawEntry) : {};
    const entry = this.toEntry(rawMeta, path) ?? {
      path,
      isFolder: false,
      size: res.arrayBuffer().byteLength,
      rev: rawMeta.rev ?? null,
      contentHash: rawMeta.content_hash ?? null,
      serverModified: rawMeta.server_modified ? Date.parse(rawMeta.server_modified) : null,
    };

    return {
      data: res.arrayBuffer(),
      entry,
    };
  }

  async downloadRev(path: string, rev: string): Promise<ArrayBuffer> {
    const res = await this.send({
      url: `${CONTENT_BASE}/download`,
      headers: {
        'Dropbox-API-Arg': encodeApiArg({ path: `rev:${rev}` }),
      },
    });

    if (res.status !== 200) {
      const summary = this.extractErrorSummary(res);
      this.checkCommonErrors(summary);
      if (
        res.status === 400 ||
        (res.status === 409 &&
          (summary.startsWith('path/not_found') || summary.startsWith('path_lookup/not_found')))
      ) {
        throw new NotFoundError(path, summary);
      }
      throw new RemotePathError(path, summary);
    }

    return res.arrayBuffer();
  }

  async upload(
    path: string,
    data: ArrayBuffer,
    mode: WriteMode,
    clientModified: number,
  ): Promise<RemoteEntry> {
    if (data.byteLength > MAX_UPLOAD_BYTES) {
      throw new RemotePathError(path, 'file_too_large');
    }

    const remotePath = toRemotePath(this.root, path);
    const dbxMode =
      mode.kind === 'update'
        ? { '.tag': 'update', update: mode.rev }
        : mode.kind === 'overwrite'
          ? 'overwrite'
          : 'add';

    const arg = {
      path: remotePath,
      mode: dbxMode,
      autorename: false,
      mute: true,
      strict_conflict: true,
      client_modified: formatClientModified(clientModified),
    };

    const res = await this.send({
      url: `${CONTENT_BASE}/upload`,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': encodeApiArg(arg),
      },
      body: data,
    });

    if (res.status !== 200) {
      const summary = this.extractErrorSummary(res);
      this.checkCommonErrors(summary);
      if (res.status === 409 && summary.startsWith('path/conflict')) {
        throw new RevConflictError(path, summary);
      }
      throw new RemotePathError(path, summary);
    }

    const rawMeta = JSON.parse(res.text()) as DropboxRawEntry;
    return (
      this.toEntry(rawMeta, path) ?? {
        path,
        isFolder: false,
        size: rawMeta.size ?? data.byteLength,
        rev: rawMeta.rev ?? null,
        contentHash: rawMeta.content_hash ?? null,
        serverModified: rawMeta.server_modified ? Date.parse(rawMeta.server_modified) : null,
      }
    );
  }

  async delete(path: string, rev: string | null): Promise<void> {
    const remotePath = toRemotePath(this.root, path);
    const bodyObj: Record<string, string> = { path: remotePath };
    if (rev !== null) {
      bodyObj.parent_rev = rev;
    }

    const res = await this.send({
      url: `${API_BASE}/delete_v2`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });

    if (res.status !== 200) {
      const summary = this.extractErrorSummary(res);
      this.checkCommonErrors(summary);
      if (res.status === 409) {
        if (
          summary.startsWith('path_lookup/not_found') ||
          summary.startsWith('path/not_found')
        ) {
          return;
        }
        if (
          summary.startsWith('path_lookup/conflict') ||
          summary.startsWith('from_lookup') ||
          summary.startsWith('path/conflict')
        ) {
          throw new RevConflictError(path, summary);
        }
      }
      throw new RemotePathError(path, summary);
    }
  }

  async move(from: string, to: string): Promise<RemoteEntry> {
    const fromRemote = toRemotePath(this.root, from);
    const toRemote = toRemotePath(this.root, to);

    const res = await this.send({
      url: `${API_BASE}/move_v2`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_path: fromRemote,
        to_path: toRemote,
        autorename: false,
      }),
    });

    if (res.status !== 200) {
      const summary = this.extractErrorSummary(res);
      this.checkCommonErrors(summary);
      if (res.status === 409) {
        if (
          summary.startsWith('from_lookup/not_found') ||
          summary.startsWith('path/not_found')
        ) {
          throw new NotFoundError(from, summary);
        }
        if (summary.startsWith('to/conflict') || summary.startsWith('path/conflict')) {
          throw new RevConflictError(to, summary);
        }
      }
      throw new RemotePathError(from, summary);
    }

    const parsed = JSON.parse(res.text()) as { metadata?: DropboxRawEntry } & DropboxRawEntry;
    const rawMeta = parsed.metadata ?? parsed;
    return (
      this.toEntry(rawMeta, to) ?? {
        path: to,
        isFolder: rawMeta['.tag'] === 'folder',
        size: rawMeta.size ?? 0,
        rev: rawMeta.rev ?? null,
        contentHash: rawMeta.content_hash ?? null,
        serverModified: rawMeta.server_modified ? Date.parse(rawMeta.server_modified) : null,
      }
    );
  }

  async createFolder(path: string): Promise<void> {
    const remotePath = toRemotePath(this.root, path);
    const res = await this.send({
      url: `${API_BASE}/create_folder_v2`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: remotePath,
        autorename: false,
      }),
    });

    if (res.status !== 200) {
      const summary = this.extractErrorSummary(res);
      this.checkCommonErrors(summary);
      if (res.status === 409) {
        if (summary.startsWith('path/conflict/folder')) {
          return;
        }
        if (summary.startsWith('path/conflict')) {
          throw new RevConflictError(path, summary);
        }
      }
      throw new RemotePathError(path, summary);
    }
  }
}
