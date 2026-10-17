import { RemoteStore } from '../../src/remote/RemoteStore';
import { contentHash } from '../../src/hash/contentHash';
import { encodeText, decodeText } from '../../src/bytes';
import { RevConflictError, NotFoundError } from '../../src/errors';

export function describeRemoteStoreContract(
  name: string,
  make: () => Promise<RemoteStore>,
): void {
  describe(`RemoteStore contract: ${name}`, () => {
    let counter = 0;
    const nextPrefix = () => `t-${Date.now().toString(36)}-${++counter}`;

    test('upload add then listAll contains the entry with matching contentHash', async () => {
      const store = await make();
      const prefix = nextPrefix();
      const path = `${prefix}/hello.md`;
      const data = encodeText('hello world');
      const expectedHash = await contentHash(data);

      const uploaded = await store.upload(path, data, { kind: 'add' }, 1000);
      expect(uploaded.path).toBe(path);
      expect(uploaded.isFolder).toBe(false);
      expect(uploaded.size).toBe(data.byteLength);
      expect(uploaded.contentHash).toBe(expectedHash);
      expect(uploaded.rev).toBeTruthy();

      const { entries, cursor } = await store.listAll();
      expect(cursor).toBeTruthy();
      const found = entries.find((e) => e.path === path);
      expect(found).toBeDefined();
      expect(found?.contentHash).toBe(expectedHash);
      expect(found?.rev).toBe(uploaded.rev);
    });

    test('upload add on existing path throws RevConflictError (including case-insensitive A.md then a.md)', async () => {
      const store = await make();
      const prefix = nextPrefix();
      const data = encodeText('initial');

      await store.upload(`${prefix}/same.md`, data, { kind: 'add' }, 1000);
      await expect(
        store.upload(`${prefix}/same.md`, data, { kind: 'add' }, 1001),
      ).rejects.toBeInstanceOf(RevConflictError);

      await store.upload(`${prefix}/A.md`, data, { kind: 'add' }, 1000);
      await expect(
        store.upload(`${prefix}/a.md`, data, { kind: 'add' }, 1001),
      ).rejects.toBeInstanceOf(RevConflictError);
    });

    test('upload update(staleRev) throws RevConflictError; update(currentRev) returns new rev', async () => {
      const store = await make();
      const prefix = nextPrefix();
      const path = `${prefix}/doc.md`;

      const v1 = await store.upload(path, encodeText('v1'), { kind: 'add' }, 1000);
      expect(v1.rev).toBeTruthy();

      const v2 = await store.upload(
        path,
        encodeText('v2'),
        { kind: 'update', rev: v1.rev! },
        2000,
      );
      expect(v2.rev).toBeTruthy();
      expect(v2.rev).not.toBe(v1.rev);

      await expect(
        store.upload(path, encodeText('v3'), { kind: 'update', rev: v1.rev! }, 3000),
      ).rejects.toBeInstanceOf(RevConflictError);
    });

    test('listChanges(cursor) after an upload and a delete returns one upsert and one deleted', async () => {
      const store = await make();
      const prefix = nextPrefix();
      const toDelete = `${prefix}/to-delete.md`;
      const toUpsert = `${prefix}/to-upsert.md`;

      const delEntry = await store.upload(toDelete, encodeText('bye'), { kind: 'add' }, 1000);
      const { cursor: startCursor } = await store.listAll();

      const upEntry = await store.upload(toUpsert, encodeText('hi'), { kind: 'add' }, 2000);
      await store.delete(toDelete, delEntry.rev);

      const { changes, cursor: nextCursor } = await store.listChanges(startCursor);
      expect(nextCursor).toBeTruthy();

      const relevant = changes.filter((c) =>
        c.kind === 'upsert'
          ? c.entry.path.startsWith(`${prefix}/`)
          : c.path.startsWith(`${prefix}/`),
      );
      expect(relevant).toHaveLength(2);

      const upserts = relevant.filter((c) => c.kind === 'upsert');
      const deleteds = relevant.filter((c) => c.kind === 'deleted');
      expect(upserts).toHaveLength(1);
      expect(deleteds).toHaveLength(1);
      if (upserts[0].kind === 'upsert') {
        expect(upserts[0].entry.path).toBe(toUpsert);
        expect(upserts[0].entry.rev).toBe(upEntry.rev);
      }
      if (deleteds[0].kind === 'deleted') {
        expect(deleteds[0].path.toLowerCase()).toBe(toDelete.toLowerCase());
      }
    });

    test('delete(path, staleRev) throws RevConflictError; delete(missingPath, null) resolves', async () => {
      const store = await make();
      const prefix = nextPrefix();
      const path = `${prefix}/file.md`;

      const v1 = await store.upload(path, encodeText('v1'), { kind: 'add' }, 1000);
      await store.upload(path, encodeText('v2'), { kind: 'update', rev: v1.rev! }, 2000);

      await expect(store.delete(path, v1.rev)).rejects.toBeInstanceOf(RevConflictError);
      await expect(store.delete(`${prefix}/missing.md`, null)).resolves.toBeUndefined();
    });

    test('move returns entry at new path and old path is absent from listAll', async () => {
      const store = await make();
      const prefix = nextPrefix();
      const from = `${prefix}/old.md`;
      const to = `${prefix}/new.md`;

      await store.upload(from, encodeText('move me'), { kind: 'add' }, 1000);
      const moved = await store.move(from, to);
      expect(moved.path).toBe(to);

      const { entries } = await store.listAll();
      expect(entries.find((e) => e.path === from)).toBeUndefined();
      expect(entries.find((e) => e.path === to)).toBeDefined();
    });

    test('createFolder twice resolves', async () => {
      const store = await make();
      const prefix = nextPrefix();
      const folder = `${prefix}/sub/folder`;

      await expect(store.createFolder(folder)).resolves.toBeUndefined();
      await expect(store.createFolder(folder)).resolves.toBeUndefined();
    });

    test('downloadRev(path, oldRev) returns the old bytes', async () => {
      const store = await make();
      const prefix = nextPrefix();
      const path = `${prefix}/hist.md`;

      const v1 = await store.upload(path, encodeText('version one'), { kind: 'add' }, 1000);
      await store.upload(path, encodeText('version two'), { kind: 'update', rev: v1.rev! }, 2000);

      const oldBytes = await store.downloadRev(path, v1.rev!);
      expect(decodeText(oldBytes)).toBe('version one');

      await expect(store.downloadRev(path, 'nonexistent-rev')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    test("'Notes/Café 😀.md' round-trips through upload/download with identical bytes and path", async () => {
      const store = await make();
      const prefix = nextPrefix();
      const path = `${prefix}/Notes/Café 😀.md`;
      const content = 'Café ☕ & 😀 unicode content\nline 2';
      const data = encodeText(content);

      const up = await store.upload(path, data, { kind: 'add' }, 1000);
      expect(up.path).toBe(path);

      const dl = await store.download(path);
      expect(dl.entry.path).toBe(path);
      expect(decodeText(dl.data)).toBe(content);
      expect(new Uint8Array(dl.data)).toEqual(new Uint8Array(data));
    });
  });
}
