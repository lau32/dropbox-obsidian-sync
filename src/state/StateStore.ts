import { BaseRecord, RemoteChange, RemoteEntry, SyncLogEntry, SyncMeta } from '../types';

export interface StateStore {
  loadBase(): Promise<Map<string, BaseRecord>>;
  commit(rec: BaseRecord, baseText?: string | null): Promise<void>; // one transaction; undefined = keep text, null = drop text
  remove(path: string): Promise<void>; // removes record and base text
  getBaseText(path: string): Promise<string | null>;
  loadRemoteIndex(): Promise<Map<string, RemoteEntry>>;
  applyRemoteChanges(changes: RemoteChange[], cursor: string, reset: boolean): Promise<void>; // reset replaces the index; one transaction with cursor
  getMeta(): Promise<SyncMeta>;
  setMeta(patch: Partial<SyncMeta>): Promise<void>;
  appendLog(entry: SyncLogEntry, keep: number): Promise<void>;
  getLog(): Promise<SyncLogEntry[]>; // newest first
  reset(): Promise<void>; // clears base, texts, remote index, cursor; keeps log
}
