import { createHash } from 'node:crypto';
import { RemoteStore } from '../../src/remote/RemoteStore';
import { RemoteChange, RemoteEntry, WriteMode } from '../../src/types';
import { CursorResetError, NotFoundError, RevConflictError } from '../../src/errors';
import { toKey } from '../../src/paths';
import { encodeText, decodeText } from '../../src/bytes';

const BLOCK_SIZE = 4 * 1024 * 1024;

function computeContentHashSync(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const numBlocks = Math.ceil(bytes.byteLength / BLOCK_SIZE);
  const concatDigests = Buffer.alloc(numBlocks * 32);

  for (let i = 0; i < numBlocks; i++) {
    const start = i * BLOCK_SIZE;
    const end = Math.min(start + BLOCK_SIZE, bytes.byteLength);
    const block = bytes.subarray(start, end);
    const digest = createHash('sha256').update(block).digest();
    digest.copy(concatDigests, i * 32);
  }

  return createHash('sha256').update(concatDigests).digest('hex');
}

interface StoredItem {
  entry: RemoteEntry;
  data: ArrayBuffer;
}

interface JournalRecord {
  seq: number;
  key: string;
  change: RemoteChange;
}

export class FakeDropbox {
  private items = new Map<string, StoredItem>();
  private revHistory = new Map<string, Map<string, ArrayBuffer>>();
  private journal: JournalRecord[] = [];
  private seq = 0;
  private minValidCursor = 0;
  private revCounter = 0;
  private failQueue = new Map<keyof RemoteStore, Error[]>();
  private beforeWriteHook?: (path: string) => Promise<void> | void;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private nextRev(): string {
    this.revCounter += 1;
    return `r${this.revCounter}`;
  }

  private checkFail(method: keyof RemoteStore): void {
    const q = this.failQueue.get(method);
    if (q && q.length > 0) {
      const err = q.shift()!;
      throw err;
    }
  }

  private saveRev(key: string, rev: string, data: ArrayBuffer): void {
    let byRev = this.revHistory.get(key);
    if (!byRev) {
      byRev = new Map();
      this.revHistory.set(key, byRev);
    }
    byRev.set(rev, data.slice(0));
  }

  private recordChange(key: string, change: RemoteChange): void {
    this.seq += 1;
    this.journal.push({
      seq: this.seq,
      key,
      change:
        change.kind === 'upsert'
          ? { kind: 'upsert', entry: { ...change.entry } }
          : { kind: 'deleted', path: change.path },
    });
  }

  readText(path: string): string | undefined {
    const item = this.items.get(toKey(path));
    if (!item || item.entry.isFolder) {
      return undefined;
    }
    return decodeText(item.data);
  }

  writeText(path: string, text: string): RemoteEntry {
    const data = encodeText(text);
    const key = toKey(path);
    const rev = this.nextRev();
    const hash = computeContentHashSync(data);
    const serverModified = this.clock();
    const existing = this.items.get(key);
    const displayPath = existing ? existing.entry.path : path;
    const entry: RemoteEntry = {
      path: displayPath,
      isFolder: false,
      size: data.byteLength,
      rev,
      contentHash: hash,
      serverModified,
    };
    const copy = data.slice(0);
    this.items.set(key, { entry, data: copy });
    this.saveRev(key, rev, copy);
    this.recordChange(key, { kind: 'upsert', entry });
    return { ...entry };
  }

  paths(): string[] {
    const result: string[] = [];
    for (const { entry } of this.items.values()) {
      if (!entry.isFolder) {
        result.push(entry.path);
      }
    }
    return result.sort();
  }

  expireCursors(): void {
    this.seq += 1;
    this.minValidCursor = this.seq;
  }

  failNext(method: keyof RemoteStore, err: Error): void {
    let q = this.failQueue.get(method);
    if (!q) {
      q = [];
      this.failQueue.set(method, q);
    }
    q.push(err);
  }

  beforeWrite(hook: (path: string) => Promise<void> | void): void {
    this.beforeWriteHook = hook;
  }

  client(): RemoteStore {
    return {
      listAll: async () => {
        this.checkFail('listAll');
        const entries = Array.from(this.items.values()).map((i) => ({ ...i.entry }));
        return { entries, cursor: String(this.seq) };
      },

      listChanges: async (cursor: string) => {
        this.checkFail('listChanges');
        const num = Number(cursor);
        if (
          cursor === '' ||
          Number.isNaN(num) ||
          !Number.isInteger(num) ||
          num < this.minValidCursor ||
          num > this.seq
        ) {
          throw new CursorResetError();
        }
        const latestByKey = new Map<string, RemoteChange>();
        for (const rec of this.journal) {
          if (rec.seq > num) {
            latestByKey.set(
              rec.key,
              rec.change.kind === 'upsert'
                ? { kind: 'upsert', entry: { ...rec.change.entry } }
                : { kind: 'deleted', path: rec.change.path },
            );
          }
        }
        return {
          changes: Array.from(latestByKey.values()),
          cursor: String(this.seq),
        };
      },

      longpoll: async (cursor: string, _timeoutSec: number) => {
        this.checkFail('longpoll');
        const num = Number(cursor);
        const changed = Number.isNaN(num) || num < this.minValidCursor || num < this.seq;
        return { changed, backoffSec: 0 };
      },

      download: async (path: string) => {
        this.checkFail('download');
        const item = this.items.get(toKey(path));
        if (!item || item.entry.isFolder) {
          throw new NotFoundError(path);
        }
        return {
          data: item.data.slice(0),
          entry: { ...item.entry },
        };
      },

      downloadRev: async (path: string, rev: string) => {
        this.checkFail('downloadRev');
        const byRev = this.revHistory.get(toKey(path));
        const data = byRev?.get(rev);
        if (!data) {
          throw new NotFoundError(path);
        }
        return data.slice(0);
      },

      upload: async (
        path: string,
        data: ArrayBuffer,
        mode: WriteMode,
        _clientModified: number,
      ) => {
        this.checkFail('upload');
        if (this.beforeWriteHook) {
          await this.beforeWriteHook(path);
        }
        const key = toKey(path);
        const existing = this.items.get(key);

        if (mode.kind === 'add') {
          if (existing) {
            throw new RevConflictError(path);
          }
        } else if (mode.kind === 'update') {
          if (!existing || existing.entry.isFolder || existing.entry.rev !== mode.rev) {
            throw new RevConflictError(path);
          }
        }

        const rev = this.nextRev();
        const hash = computeContentHashSync(data);
        const serverModified = this.clock();
        const entry: RemoteEntry = {
          path,
          isFolder: false,
          size: data.byteLength,
          rev,
          contentHash: hash,
          serverModified,
        };
        const copy = data.slice(0);
        this.items.set(key, { entry, data: copy });
        this.saveRev(key, rev, copy);
        this.recordChange(key, { kind: 'upsert', entry });
        return { ...entry };
      },

      delete: async (path: string, rev: string | null) => {
        this.checkFail('delete');
        const key = toKey(path);
        const existing = this.items.get(key);
        if (!existing) {
          return;
        }
        if (rev !== null && existing.entry.rev !== rev) {
          throw new RevConflictError(path);
        }
        this.items.delete(key);
        this.recordChange(key, { kind: 'deleted', path: existing.entry.path });
      },

      move: async (from: string, to: string) => {
        this.checkFail('move');
        const fromKey = toKey(from);
        const toKeyVal = toKey(to);
        const existing = this.items.get(fromKey);
        if (!existing) {
          throw new NotFoundError(from);
        }

        this.items.delete(fromKey);
        this.recordChange(fromKey, { kind: 'deleted', path: existing.entry.path });

        const movedEntry: RemoteEntry = {
          ...existing.entry,
          path: to,
        };
        const copy = existing.data.slice(0);
        this.items.set(toKeyVal, { entry: movedEntry, data: copy });

        const oldHist = this.revHistory.get(fromKey);
        if (oldHist) {
          let targetHist = this.revHistory.get(toKeyVal);
          if (!targetHist) {
            targetHist = new Map();
            this.revHistory.set(toKeyVal, targetHist);
          }
          for (const [r, buf] of oldHist.entries()) {
            targetHist.set(r, buf);
          }
        }

        this.recordChange(toKeyVal, { kind: 'upsert', entry: movedEntry });
        return { ...movedEntry };
      },

      createFolder: async (path: string) => {
        this.checkFail('createFolder');
        const key = toKey(path);
        const existing = this.items.get(key);
        if (existing) {
          if (existing.entry.isFolder) {
            return;
          }
          throw new RevConflictError(path);
        }
        const entry: RemoteEntry = {
          path,
          isFolder: true,
          size: 0,
          rev: null,
          contentHash: null,
          serverModified: null,
        };
        this.items.set(key, { entry, data: new ArrayBuffer(0) });
        this.recordChange(key, { kind: 'upsert', entry });
      },
    };
  }
}
