import { StateStore } from '../../src/state/StateStore';
import { BaseRecord, RemoteChange, RemoteEntry, SyncLogEntry, SyncMeta } from '../../src/types';
import { toKey } from '../../src/paths';

export class MemoryStateStore implements StateStore {
  private base = new Map<string, BaseRecord>();
  private baseTexts = new Map<string, string>();
  private remoteIndex = new Map<string, RemoteEntry>();
  private meta: SyncMeta = {
    cursor: null,
    schemaVersion: 1,
    lastSyncAt: null,
  };
  private logs: SyncLogEntry[] = [];

  async loadBase(): Promise<Map<string, BaseRecord>> {
    const out = new Map<string, BaseRecord>();
    for (const [k, v] of this.base.entries()) {
      out.set(k, { ...v });
    }
    return out;
  }

  async commit(rec: BaseRecord, baseText?: string | null): Promise<void> {
    const key = toKey(rec.path);
    this.base.set(key, { ...rec });
    if (baseText === null) {
      this.baseTexts.delete(key);
    } else if (baseText !== undefined) {
      this.baseTexts.set(key, baseText);
    }
  }

  async remove(path: string): Promise<void> {
    const key = toKey(path);
    this.base.delete(key);
    this.baseTexts.delete(key);
  }

  async getBaseText(path: string): Promise<string | null> {
    return this.baseTexts.get(toKey(path)) ?? null;
  }

  async loadRemoteIndex(): Promise<Map<string, RemoteEntry>> {
    const out = new Map<string, RemoteEntry>();
    for (const [k, v] of this.remoteIndex.entries()) {
      out.set(k, { ...v });
    }
    return out;
  }

  async applyRemoteChanges(
    changes: RemoteChange[],
    cursor: string,
    reset: boolean,
  ): Promise<void> {
    if (reset) {
      this.remoteIndex.clear();
    }
    for (const change of changes) {
      if (change.kind === 'upsert') {
        this.remoteIndex.set(toKey(change.entry.path), { ...change.entry });
      } else {
        this.remoteIndex.delete(toKey(change.path));
      }
    }
    this.meta.cursor = cursor;
  }

  async getMeta(): Promise<SyncMeta> {
    return { ...this.meta };
  }

  async setMeta(patch: Partial<SyncMeta>): Promise<void> {
    this.meta = { ...this.meta, ...patch };
  }

  async appendLog(entry: SyncLogEntry, keep: number): Promise<void> {
    const copy: SyncLogEntry = {
      ...entry,
      actions: entry.actions.map((a) => ({ ...a })),
      merged: [...entry.merged],
      conflicts: [...entry.conflicts],
      errors: entry.errors.map((e) => ({ ...e })),
    };
    this.logs.unshift(copy);
    if (this.logs.length > keep) {
      this.logs.length = Math.max(0, keep);
    }
  }

  async getLog(): Promise<SyncLogEntry[]> {
    return this.logs.map((entry) => ({
      ...entry,
      actions: entry.actions.map((a) => ({ ...a })),
      merged: [...entry.merged],
      conflicts: [...entry.conflicts],
      errors: entry.errors.map((e) => ({ ...e })),
    }));
  }

  async reset(): Promise<void> {
    this.base.clear();
    this.baseTexts.clear();
    this.remoteIndex.clear();
    this.meta = {
      cursor: null,
      schemaVersion: 1,
      lastSyncAt: null,
    };
  }
}
