import { StateStore } from '../../src/state/StateStore';
import { BaseRecord, RemoteEntry, SyncLogEntry } from '../../src/types';
import { toKey } from '../../src/paths';

export function describeStateStoreContract(
  name: string,
  make: () => Promise<StateStore>,
): void {
  describe(`StateStore contract: ${name}`, () => {
    const sampleRec = (path: string, rev = 'r1'): BaseRecord => ({
      path,
      isFolder: false,
      size: 10,
      mtime: 1000,
      contentHash: 'hash1',
      rev,
      serverModified: 1000,
    });

    const sampleRemote = (path: string, rev = 'r1'): RemoteEntry => ({
      path,
      isFolder: false,
      size: 10,
      rev,
      contentHash: 'hash1',
      serverModified: 1000,
    });

    test('getMeta().schemaVersion === 1 on a fresh store', async () => {
      const store = await make();
      const meta = await store.getMeta();
      expect(meta).toEqual({
        cursor: null,
        schemaVersion: 1,
        lastSyncAt: null,
      });
    });

    test('commit then loadBase keyed by toKey', async () => {
      const store = await make();
      const rec = sampleRec('Notes/Café.md'.normalize('NFD'));
      await store.commit(rec);

      const base = await store.loadBase();
      const key = toKey('Notes/Café.md');
      expect(base.has(key)).toBe(true);
      expect(base.get(key)).toEqual(rec);
    });

    test('commit baseText semantics: set, keep on undefined, drop on null, and remove drops both', async () => {
      const store = await make();
      const path = 'Folder/Note.md';
      const rec1 = sampleRec(path, 'r1');

      await store.commit(rec1, 'initial base text');
      expect(await store.getBaseText(path)).toBe('initial base text');
      expect(await store.getBaseText('folder/note.md')).toBe('initial base text');

      // undefined keeps existing text
      const rec2 = sampleRec(path, 'r2');
      await store.commit(rec2);
      expect(await store.getBaseText(path)).toBe('initial base text');
      expect((await store.loadBase()).get(toKey(path))?.rev).toBe('r2');

      // null drops text
      const rec3 = sampleRec(path, 'r3');
      await store.commit(rec3, null);
      expect(await store.getBaseText(path)).toBeNull();
      expect((await store.loadBase()).get(toKey(path))?.rev).toBe('r3');

      // set text again then remove drops both record and base text
      await store.commit(rec3, 'restored text');
      await store.remove(path);
      expect(await store.getBaseText(path)).toBeNull();
      expect((await store.loadBase()).has(toKey(path))).toBe(false);
    });

    test('applyRemoteChanges upsert/delete/reset semantics and cursor stored in getMeta()', async () => {
      const store = await make();
      const e1 = sampleRemote('A.md', 'r1');
      const e2 = sampleRemote('B.md', 'r2');

      await store.applyRemoteChanges(
        [
          { kind: 'upsert', entry: e1 },
          { kind: 'upsert', entry: e2 },
        ],
        'cur-1',
        false,
      );

      let index = await store.loadRemoteIndex();
      expect(index.get(toKey('A.md'))).toEqual(e1);
      expect(index.get(toKey('B.md'))).toEqual(e2);
      expect((await store.getMeta()).cursor).toBe('cur-1');

      // update A and delete B
      const e1Updated = sampleRemote('A.md', 'r3');
      await store.applyRemoteChanges(
        [
          { kind: 'upsert', entry: e1Updated },
          { kind: 'deleted', path: 'b.md' },
        ],
        'cur-2',
        false,
      );

      index = await store.loadRemoteIndex();
      expect(index.get(toKey('A.md'))).toEqual(e1Updated);
      expect(index.has(toKey('B.md'))).toBe(false);
      expect((await store.getMeta()).cursor).toBe('cur-2');

      // reset=true replaces the entire index
      const e3 = sampleRemote('C.md', 'r4');
      await store.applyRemoteChanges([{ kind: 'upsert', entry: e3 }], 'cur-3', true);

      index = await store.loadRemoteIndex();
      expect(index.size).toBe(1);
      expect(index.get(toKey('C.md'))).toEqual(e3);
      expect((await store.getMeta()).cursor).toBe('cur-3');
    });

    test('appendLog keeps newest keep entries newest-first, and reset() clears everything except log', async () => {
      const store = await make();
      await store.commit(sampleRec('A.md'), 'some text');
      await store.applyRemoteChanges(
        [{ kind: 'upsert', entry: sampleRemote('A.md') }],
        'cur-1',
        false,
      );
      await store.setMeta({ lastSyncAt: 5000 });

      const makeLog = (n: number): SyncLogEntry => ({
        startedAt: n * 100,
        finishedAt: n * 100 + 50,
        trigger: 'manual',
        status: `ok-${n}`,
        actions: [],
        merged: [],
        conflicts: [],
        errors: [],
      });

      await store.appendLog(makeLog(1), 2);
      await store.appendLog(makeLog(2), 2);
      await store.appendLog(makeLog(3), 2);

      const logs = await store.getLog();
      expect(logs.map((l) => l.status)).toEqual(['ok-3', 'ok-2']);

      await store.reset();

      expect((await store.loadBase()).size).toBe(0);
      expect(await store.getBaseText('A.md')).toBeNull();
      expect((await store.loadRemoteIndex()).size).toBe(0);
      expect(await store.getMeta()).toEqual({
        cursor: null,
        schemaVersion: 1,
        lastSyncAt: null,
      });
      expect((await store.getLog()).map((l) => l.status)).toEqual(['ok-3', 'ok-2']);
    });
  });
}
