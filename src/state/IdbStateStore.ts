import { IDBPDatabase, openDB } from 'idb';
import { toKey } from '../paths';
import { BaseRecord, RemoteChange, RemoteEntry, SyncLogEntry, SyncMeta } from '../types';
import { StateStore } from './StateStore';

const SCHEMA_VERSION = 1;

const DEFAULT_META: SyncMeta = {
  cursor: null,
  schemaVersion: SCHEMA_VERSION,
  lastSyncAt: null,
};

export class IdbStateStore implements StateStore {
  private constructor(private readonly db: IDBPDatabase) {}

  static async open(dbName: string): Promise<IdbStateStore> {
    const db = await openDB(dbName, SCHEMA_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('files')) {
          database.createObjectStore('files');
        }
        if (!database.objectStoreNames.contains('bases')) {
          database.createObjectStore('bases');
        }
        if (!database.objectStoreNames.contains('remote')) {
          database.createObjectStore('remote');
        }
        if (!database.objectStoreNames.contains('meta')) {
          database.createObjectStore('meta');
        }
        if (!database.objectStoreNames.contains('log')) {
          database.createObjectStore('log', { autoIncrement: true });
        }
      },
    });
    return new IdbStateStore(db);
  }

  async loadBase(): Promise<Map<string, BaseRecord>> {
    const records = (await this.db.getAll('files')) as BaseRecord[];
    const map = new Map<string, BaseRecord>();
    for (const rec of records) {
      map.set(toKey(rec.path), rec);
    }
    return map;
  }

  async commit(rec: BaseRecord, baseText?: string | null): Promise<void> {
    const key = toKey(rec.path);
    const tx = this.db.transaction(['files', 'bases'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const basesStore = tx.objectStore('bases');

    await filesStore.put(rec, key);
    if (baseText === null) {
      await basesStore.delete(key);
    } else if (baseText !== undefined) {
      await basesStore.put(baseText, key);
    }
    await tx.done;
  }

  async remove(path: string): Promise<void> {
    const key = toKey(path);
    const tx = this.db.transaction(['files', 'bases'], 'readwrite');
    await tx.objectStore('files').delete(key);
    await tx.objectStore('bases').delete(key);
    await tx.done;
  }

  async getBaseText(path: string): Promise<string | null> {
    const text = (await this.db.get('bases', toKey(path))) as string | undefined;
    return text ?? null;
  }

  async loadRemoteIndex(): Promise<Map<string, RemoteEntry>> {
    const entries = (await this.db.getAll('remote')) as RemoteEntry[];
    const map = new Map<string, RemoteEntry>();
    for (const entry of entries) {
      map.set(toKey(entry.path), entry);
    }
    return map;
  }

  async applyRemoteChanges(changes: RemoteChange[], cursor: string, reset: boolean): Promise<void> {
    const tx = this.db.transaction(['remote', 'meta'], 'readwrite');
    const remoteStore = tx.objectStore('remote');
    const metaStore = tx.objectStore('meta');

    if (reset) {
      await remoteStore.clear();
    }
    for (const change of changes) {
      if (change.kind === 'upsert') {
        await remoteStore.put(change.entry, toKey(change.entry.path));
      } else {
        await remoteStore.delete(toKey(change.path));
      }
    }
    await metaStore.put(cursor, 'cursor');
    await tx.done;
  }

  async getMeta(): Promise<SyncMeta> {
    const tx = this.db.transaction('meta', 'readonly');
    const store = tx.objectStore('meta');
    const [cursor, schemaVersion, lastSyncAt] = await Promise.all([
      store.get('cursor') as Promise<string | null | undefined>,
      store.get('schemaVersion') as Promise<number | undefined>,
      store.get('lastSyncAt') as Promise<number | null | undefined>,
    ]);
    await tx.done;
    return {
      cursor: cursor ?? DEFAULT_META.cursor,
      schemaVersion: schemaVersion ?? DEFAULT_META.schemaVersion,
      lastSyncAt: lastSyncAt ?? DEFAULT_META.lastSyncAt,
    };
  }

  async setMeta(patch: Partial<SyncMeta>): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    if (patch.cursor !== undefined) {
      await store.put(patch.cursor, 'cursor');
    }
    if (patch.schemaVersion !== undefined) {
      await store.put(patch.schemaVersion, 'schemaVersion');
    }
    if (patch.lastSyncAt !== undefined) {
      await store.put(patch.lastSyncAt, 'lastSyncAt');
    }
    await tx.done;
  }

  async appendLog(entry: SyncLogEntry, keep: number): Promise<void> {
    const tx = this.db.transaction('log', 'readwrite');
    const store = tx.objectStore('log');
    await store.add(entry);
    const keys = await store.getAllKeys();
    const limit = Math.max(0, keep);
    const excess = keys.length - limit;
    for (let i = 0; i < excess; i++) {
      await store.delete(keys[i]);
    }
    await tx.done;
  }

  async getLog(): Promise<SyncLogEntry[]> {
    const entries = (await this.db.getAll('log')) as SyncLogEntry[];
    return entries.reverse();
  }

  async reset(): Promise<void> {
    const tx = this.db.transaction(['files', 'bases', 'remote', 'meta'], 'readwrite');
    await Promise.all([
      tx.objectStore('files').clear(),
      tx.objectStore('bases').clear(),
      tx.objectStore('remote').clear(),
      tx.objectStore('meta').clear(),
    ]);
    await tx.done;
  }
}
