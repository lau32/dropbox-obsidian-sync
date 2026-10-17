export interface LocalFile {
  path: string;
  isFolder: boolean;
  size: number;
  mtime: number;
}

export interface RemoteEntry {
  path: string;
  isFolder: boolean;
  size: number;
  rev: string | null;
  contentHash: string | null;
  serverModified: number | null;
}

export type RemoteChange =
  | { kind: 'upsert'; entry: RemoteEntry }
  | { kind: 'deleted'; path: string };

export type WriteMode =
  | { kind: 'add' }
  | { kind: 'update'; rev: string }
  | { kind: 'overwrite' };

export interface BaseRecord {
  path: string;
  isFolder: boolean;
  size: number;
  mtime: number;
  contentHash: string | null;
  rev: string | null;
  serverModified: number | null;
}

export interface SyncMeta {
  cursor: string | null;
  schemaVersion: number;
  lastSyncAt: number | null;
}

export type TriggerReason =
  | 'startup'
  | 'resume'
  | 'edit'
  | 'interval'
  | 'remote'
  | 'manual';

export interface SyncLogEntry {
  startedAt: number;
  finishedAt: number;
  trigger: TriggerReason;
  status: string;
  actions: Array<{ kind: string; path: string }>;
  merged: string[];
  conflicts: string[];
  errors: Array<{ path: string; message: string }>;
}
