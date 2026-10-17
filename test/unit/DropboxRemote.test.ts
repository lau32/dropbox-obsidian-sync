import { DropboxRemote, encodeApiArg } from '../../src/remote/DropboxRemote';
import { scriptedHttp } from '../support/scriptedHttp';
import { encodeText, decodeText } from '../../src/bytes';
import {
  AuthError,
  CursorResetError,
  InsufficientSpaceError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  RemotePathError,
  RevConflictError,
} from '../../src/errors';

describe('DropboxRemote & encodeApiArg', () => {
  test('encodeApiArg escapes non-ASCII characters as \\uXXXX and produces pure ASCII', () => {
    const encoded = encodeApiArg({ path: '/Café 😀.md' });
    expect(encoded).toContain('\\u00e9');
    expect(encoded).toContain('\\ud83d\\ude00');
    expect(encoded).toMatch(/^[\x00-\x7f]*$/);
    expect(JSON.parse(encoded)).toEqual({ path: '/Café 😀.md' });
  });

  test('upload update builds exact Dropbox-API-Arg for a.md under root Vault with client_modified', async () => {
    const { http, requests } = scriptedHttp([
      {
        status: 200,
        json: {
          '.tag': 'file',
          name: 'a.md',
          path_lower: '/vault/a.md',
          path_display: '/Vault/a.md',
          id: 'id:1',
          client_modified: '2026-10-13T19:42:00Z',
          server_modified: '2026-10-13T19:42:05Z',
          rev: '015a123456789',
          size: 5,
          content_hash: 'abc123hash',
        },
      },
    ]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok-1',
      refreshAccessToken: async () => 'tok-2',
    });

    const clientModifiedMs = Date.parse('2026-10-13T19:42:00.789Z');
    const data = encodeText('hello');
    const entry = await remote.upload('a.md', data, { kind: 'update', rev: '015a000000000' }, clientModifiedMs);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://content.dropboxapi.com/2/files/upload');
    expect(requests[0].headers['Authorization']).toBe('Bearer tok-1');
    expect(requests[0].headers['Content-Type']).toBe('application/octet-stream');

    const apiArg = JSON.parse(requests[0].headers['Dropbox-API-Arg']);
    expect(apiArg).toEqual({
      path: '/Vault/a.md',
      mode: { '.tag': 'update', update: '015a000000000' },
      autorename: false,
      mute: true,
      strict_conflict: true,
      client_modified: '2026-10-13T19:42:00Z',
    });

    expect(entry).toEqual({
      path: 'a.md',
      isFolder: false,
      size: 5,
      rev: '015a123456789',
      contentHash: 'abc123hash',
      serverModified: Date.parse('2026-10-13T19:42:05Z'),
    });
  });

  test('409 path/conflict/file/ on upload throws RevConflictError', async () => {
    const { http } = scriptedHttp([
      {
        status: 409,
        json: {
          error_summary: 'path/conflict/file/...',
          error: { '.tag': 'path', path: { reason: { '.tag': 'conflict' } } },
        },
      },
    ]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok-1',
      refreshAccessToken: async () => 'tok-2',
    });

    await expect(
      remote.upload('a.md', encodeText('hi'), { kind: 'add' }, Date.now()),
    ).rejects.toBeInstanceOf(RevConflictError);
  });

  test('401 then success calls refreshAccessToken once and retries with the new bearer token', async () => {
    const { http, requests } = scriptedHttp([
      { status: 401, json: { error_summary: 'expired_access_token/' } },
      {
        status: 200,
        json: {
          entries: [],
          cursor: 'cur-1',
          has_more: false,
        },
      },
    ]);

    let refreshCount = 0;
    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'old-token',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return 'new-token';
      },
    });

    const res = await remote.listAll();
    expect(res).toEqual({ entries: [], cursor: 'cur-1' });
    expect(refreshCount).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers['Authorization']).toBe('Bearer old-token');
    expect(requests[1].headers['Authorization']).toBe('Bearer new-token');
  });

  test('401 twice throws AuthError', async () => {
    const { http } = scriptedHttp([
      { status: 401, json: { error_summary: 'invalid_access_token/' } },
      { status: 401, json: { error_summary: 'invalid_access_token/' } },
    ]);

    let refreshCount = 0;
    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'old-token',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return 'still-bad-token';
      },
    });

    await expect(remote.listAll()).rejects.toBeInstanceOf(AuthError);
    expect(refreshCount).toBe(1);
  });

  test('429 with Retry-After: 2 calls sleep(2000) then succeeds', async () => {
    const { http, requests } = scriptedHttp([
      {
        status: 429,
        headers: { 'Retry-After': '2' },
        json: { error_summary: 'too_many_requests/' },
      },
      {
        status: 200,
        json: {
          entries: [],
          cursor: 'cur-after-retry',
          has_more: false,
        },
      },
    ]);

    const sleeps: number[] = [];
    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const res = await remote.listAll();
    expect(res).toEqual({ entries: [], cursor: 'cur-after-retry' });
    expect(sleeps).toEqual([2000]);
    expect(requests).toHaveLength(2);
  });

  test('429 exceeding maxRetries throws RateLimitError', async () => {
    const { http } = scriptedHttp([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 429, headers: { 'retry-after': '1' } },
    ]);

    const sleeps: number[] = [];
    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 1,
    });

    await expect(remote.listAll()).rejects.toBeInstanceOf(RateLimitError);
    expect(sleeps).toEqual([1000]);
  });

  test('http throwing an error maps to NetworkError', async () => {
    const { http } = scriptedHttp([new Error('socket hang up')]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
    });

    await expect(remote.listAll()).rejects.toBeInstanceOf(NetworkError);
  });

  test('list_folder with has_more: true follows /continue, drops entries outside root, maps .tag: deleted and server_modified', async () => {
    const { http, requests } = scriptedHttp([
      {
        status: 200,
        json: {
          entries: [
            {
              '.tag': 'folder',
              name: 'Vault',
              path_lower: '/vault',
              path_display: '/Vault',
            },
            {
              '.tag': 'file',
              name: 'outside.md',
              path_lower: '/other/outside.md',
              path_display: '/Other/outside.md',
              size: 10,
              rev: 'rev-out',
              content_hash: 'hash-out',
              server_modified: '2026-10-13T10:00:00Z',
            },
            {
              '.tag': 'file',
              name: 'note.md',
              path_lower: '/vault/sub/note.md',
              path_display: '/Vault/sub/note.md',
              size: 42,
              rev: 'rev-1',
              content_hash: 'hash-1',
              server_modified: '2026-10-13T12:00:00Z',
            },
          ],
          cursor: 'cur-page-1',
          has_more: true,
        },
      },
      {
        status: 200,
        json: {
          entries: [
            {
              '.tag': 'folder',
              name: 'sub',
              path_lower: '/vault/sub',
              path_display: '/Vault/sub',
            },
          ],
          cursor: 'cur-page-2',
          has_more: false,
        },
      },
      {
        status: 200,
        json: {
          entries: [
            {
              '.tag': 'deleted',
              name: 'old.md',
              path_lower: '/vault/old.md',
              path_display: '/Vault/old.md',
            },
            {
              '.tag': 'deleted',
              name: 'ignore.md',
              path_lower: '/outside/ignore.md',
              path_display: '/Outside/ignore.md',
            },
            {
              '.tag': 'file',
              name: 'updated.md',
              path_lower: '/vault/updated.md',
              path_display: '/Vault/updated.md',
              size: 99,
              rev: 'rev-2',
              content_hash: 'hash-2',
              server_modified: '2026-10-13T15:30:00Z',
            },
          ],
          cursor: 'cur-changes-done',
          has_more: false,
        },
      },
    ]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
    });

    const listRes = await remote.listAll();
    expect(requests[0].url).toBe('https://api.dropboxapi.com/2/files/list_folder');
    expect(JSON.parse(requests[0].body as string)).toEqual({
      path: '/Vault',
      recursive: true,
    });
    expect(requests[1].url).toBe('https://api.dropboxapi.com/2/files/list_folder/continue');
    expect(JSON.parse(requests[1].body as string)).toEqual({
      cursor: 'cur-page-1',
    });

    expect(listRes.cursor).toBe('cur-page-2');
    expect(listRes.entries).toEqual([
      {
        path: 'sub/note.md',
        isFolder: false,
        size: 42,
        rev: 'rev-1',
        contentHash: 'hash-1',
        serverModified: Date.parse('2026-10-13T12:00:00Z'),
      },
      {
        path: 'sub',
        isFolder: true,
        size: 0,
        rev: null,
        contentHash: null,
        serverModified: null,
      },
    ]);

    const changesRes = await remote.listChanges('cur-page-2');
    expect(requests[2].url).toBe('https://api.dropboxapi.com/2/files/list_folder/continue');
    expect(changesRes.cursor).toBe('cur-changes-done');
    expect(changesRes.changes).toEqual([
      {
        kind: 'deleted',
        path: 'old.md',
      },
      {
        kind: 'upsert',
        entry: {
          path: 'updated.md',
          isFolder: false,
          size: 99,
          rev: 'rev-2',
          contentHash: 'hash-2',
          serverModified: Date.parse('2026-10-13T15:30:00Z'),
        },
      },
    ]);
  });

  test('/continue 409 reset/ throws CursorResetError', async () => {
    const { http } = scriptedHttp([
      {
        status: 409,
        json: { error_summary: 'reset/...' },
      },
    ]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
    });

    await expect(remote.listChanges('old-cursor')).rejects.toBeInstanceOf(CursorResetError);
  });

  test('download parses ASCII-escaped Dropbox-API-Result header into RemoteEntry with non-ASCII path', async () => {
    const apiResultHeader = encodeApiArg({
      '.tag': 'file',
      name: 'Café 😀.md',
      path_lower: '/vault/notes/café 😀.md',
      path_display: '/Vault/Notes/Café 😀.md',
      size: 12,
      rev: 'rev-cafe',
      content_hash: 'hash-cafe',
      server_modified: '2026-10-13T20:00:00Z',
    });

    const { http, requests } = scriptedHttp([
      {
        status: 200,
        headers: { 'dropbox-api-result': apiResultHeader },
        body: encodeText('Café content'),
      },
    ]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
    });

    const { data, entry } = await remote.download('Notes/Café 😀.md');
    expect(requests[0].url).toBe('https://content.dropboxapi.com/2/files/download');
    expect(requests[0].headers['Dropbox-API-Arg']).toBe(
      encodeApiArg({ path: '/Vault/Notes/Café 😀.md' }),
    );
    expect(decodeText(data)).toBe('Café content');
    expect(entry).toEqual({
      path: 'Notes/Café 😀.md',
      isFolder: false,
      size: 12,
      rev: 'rev-cafe',
      contentHash: 'hash-cafe',
      serverModified: Date.parse('2026-10-13T20:00:00Z'),
    });
  });

  test('longpoll request has no Authorization header and maps { changes, backoff }', async () => {
    const { http, requests } = scriptedHttp([
      {
        status: 200,
        json: { changes: true, backoff: 15 },
      },
    ]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'should-not-be-used',
      refreshAccessToken: async () => 'should-not-be-used',
    });

    const res = await remote.longpoll('cur-lp', 30);
    expect(res).toEqual({ changed: true, backoffSec: 15 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://notify.dropboxapi.com/2/files/list_folder/longpoll');
    expect(requests[0].headers['Authorization']).toBeUndefined();
    expect(JSON.parse(requests[0].body as string)).toEqual({
      cursor: 'cur-lp',
      timeout: 30,
    });
  });

  test('listAll with 409 path/not_found/ sends create_folder_v2 request, then returns empty result', async () => {
    const { http, requests } = scriptedHttp([
      {
        status: 409,
        json: { error_summary: 'path/not_found/...' },
      },
      {
        status: 200,
        json: {
          metadata: {
            name: 'Vault',
            path_lower: '/vault',
            path_display: '/Vault',
          },
        },
      },
    ]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
    });

    const res = await remote.listAll();
    expect(res.entries).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://api.dropboxapi.com/2/files/list_folder');
    expect(requests[1].url).toBe('https://api.dropboxapi.com/2/files/create_folder_v2');
    expect(JSON.parse(requests[1].body as string)).toEqual({
      path: '/Vault',
      autorename: false,
    });
  });

  test('upload larger than 150 MB throws RemotePathError without making a request', async () => {
    const { http, requests } = scriptedHttp([]);
    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
    });

    const bigBuffer = new ArrayBuffer(150 * 1024 * 1024 + 1);
    await expect(
      remote.upload('huge.bin', bigBuffer, { kind: 'add' }, Date.now()),
    ).rejects.toBeInstanceOf(RemotePathError);
    expect(requests).toHaveLength(0);
  });

  test('delete, createFolder, downloadRev, move, and insufficient_space error mapping', async () => {
    const { http, requests } = scriptedHttp([
      // 1. delete rev mismatch -> RevConflictError
      { status: 409, json: { error_summary: 'path_lookup/conflict/file/...' } },
      // 2. delete not_found -> resolves
      { status: 409, json: { error_summary: 'path_lookup/not_found/...' } },
      // 3. createFolder conflict/folder -> resolves
      { status: 409, json: { error_summary: 'path/conflict/folder/...' } },
      // 4. downloadRev not_found -> NotFoundError
      { status: 409, json: { error_summary: 'path/not_found/...' } },
      // 5. upload insufficient_space -> InsufficientSpaceError
      { status: 409, json: { error_summary: 'path/insufficient_space/...' } },
      // 6. move success
      {
        status: 200,
        json: {
          metadata: {
            '.tag': 'file',
            name: 'b.md',
            path_lower: '/vault/b.md',
            path_display: '/Vault/b.md',
            size: 3,
            rev: 'rev-b',
            content_hash: 'hash-b',
            server_modified: '2026-10-13T21:00:00Z',
          },
        },
      },
    ]);

    const remote = new DropboxRemote({
      http,
      root: 'Vault',
      getAccessToken: async () => 'tok',
      refreshAccessToken: async () => 'tok',
    });

    await expect(remote.delete('a.md', 'stale-rev')).rejects.toBeInstanceOf(RevConflictError);
    expect(JSON.parse(requests[0].body as string)).toEqual({
      path: '/Vault/a.md',
      parent_rev: 'stale-rev',
    });

    await expect(remote.delete('missing.md', null)).resolves.toBeUndefined();
    expect(JSON.parse(requests[1].body as string)).toEqual({
      path: '/Vault/missing.md',
    });

    await expect(remote.createFolder('existing')).resolves.toBeUndefined();

    await expect(remote.downloadRev('a.md', 'deadbeef00')).rejects.toBeInstanceOf(NotFoundError);
    expect(JSON.parse(requests[3].headers['Dropbox-API-Arg'])).toEqual({
      path: 'rev:deadbeef00',
    });

    await expect(
      remote.upload('full.md', encodeText('x'), { kind: 'add' }, Date.now()),
    ).rejects.toBeInstanceOf(InsufficientSpaceError);

    const moved = await remote.move('a.md', 'b.md');
    expect(JSON.parse(requests[5].body as string)).toEqual({
      from_path: '/Vault/a.md',
      to_path: '/Vault/b.md',
      autorename: false,
    });
    expect(moved.path).toBe('b.md');
  });
});
