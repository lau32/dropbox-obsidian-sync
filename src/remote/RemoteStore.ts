import { RemoteChange, RemoteEntry, WriteMode } from '../types';

export interface RemoteStore {
  listAll(): Promise<{ entries: RemoteEntry[]; cursor: string }>; // creates root if missing
  listChanges(cursor: string): Promise<{ changes: RemoteChange[]; cursor: string }>; // throws CursorResetError
  longpoll(cursor: string, timeoutSec: number): Promise<{ changed: boolean; backoffSec: number }>;
  download(path: string): Promise<{ data: ArrayBuffer; entry: RemoteEntry }>;
  downloadRev(path: string, rev: string): Promise<ArrayBuffer>; // throws NotFoundError
  upload(
    path: string,
    data: ArrayBuffer,
    mode: WriteMode,
    clientModified: number,
  ): Promise<RemoteEntry>; // throws RevConflictError
  delete(path: string, rev: string | null): Promise<void>; // rev mismatch → RevConflictError; missing → resolves
  move(from: string, to: string): Promise<RemoteEntry>;
  createFolder(path: string): Promise<void>; // existing folder → resolves
}
