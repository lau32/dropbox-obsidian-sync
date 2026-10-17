import { LocalStore } from '../../src/local/LocalStore';
import { LocalFile } from '../../src/types';
import { NotFoundError } from '../../src/errors';
import { parentDir, toKey } from '../../src/paths';
import { decodeText, encodeText } from '../../src/bytes';

interface VaultItem {
  meta: LocalFile;
  data: ArrayBuffer;
}

export class FakeVault implements LocalStore {
  private items = new Map<string, VaultItem>();
  private mutatingCalls = 0;
  public readonly trashed: string[] = [];

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly opts?: { failAfter?: number },
  ) {}

  private checkMutate(): void {
    this.mutatingCalls += 1;
    if (this.opts?.failAfter !== undefined && this.mutatingCalls > this.opts.failAfter) {
      throw new Error('injected');
    }
  }

  private ensureParentsInternal(path: string): void {
    const parts = path.split('/');
    if (parts.length <= 1) {
      return;
    }
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      const key = toKey(current);
      if (!this.items.has(key)) {
        this.items.set(key, {
          meta: {
            path: current,
            isFolder: true,
            size: 0,
            mtime: 0,
          },
          data: new ArrayBuffer(0),
        });
      }
    }
  }

  private writeInternal(path: string, data: ArrayBuffer, mtime?: number): LocalFile {
    this.ensureParentsInternal(path);
    const key = toKey(path);
    const meta: LocalFile = {
      path,
      isFolder: false,
      size: data.byteLength,
      mtime: mtime ?? this.clock(),
    };
    this.items.set(key, { meta, data: data.slice(0) });
    return { ...meta };
  }

  private deleteInternal(path: string): void {
    const key = toKey(path);
    this.items.delete(key);
    const prefix = `${key}/`;
    for (const k of Array.from(this.items.keys())) {
      if (k.startsWith(prefix)) {
        this.items.delete(k);
      }
    }
  }

  private renameInternal(from: string, to: string): void {
    const fromKey = toKey(from);
    const existing = this.items.get(fromKey);
    if (!existing) {
      throw new NotFoundError(from);
    }
    this.ensureParentsInternal(to);
    this.items.delete(fromKey);
    const toKeyVal = toKey(to);
    this.items.set(toKeyVal, {
      meta: {
        ...existing.meta,
        path: to,
      },
      data: existing.data.slice(0),
    });

    if (existing.meta.isFolder) {
      const prefix = `${fromKey}/`;
      for (const [k, item] of Array.from(this.items.entries())) {
        if (k.startsWith(prefix)) {
          this.items.delete(k);
          const suffix = item.meta.path.slice(from.length);
          const newChildPath = `${to}${suffix}`;
          this.items.set(toKey(newChildPath), {
            meta: {
              ...item.meta,
              path: newChildPath,
            },
            data: item.data.slice(0),
          });
        }
      }
    }
  }

  // Test helpers (do not count toward failAfter)
  writeText(path: string, text: string): LocalFile {
    return this.writeInternal(path, encodeText(text), this.clock());
  }

  readText(path: string): string | undefined {
    const item = this.items.get(toKey(path));
    if (!item || item.meta.isFolder) {
      return undefined;
    }
    return decodeText(item.data);
  }

  deleteUser(path: string): void {
    this.deleteInternal(path);
  }

  renameUser(from: string, to: string): void {
    this.renameInternal(from, to);
  }

  paths(): string[] {
    const out: string[] = [];
    for (const { meta } of this.items.values()) {
      if (!meta.isFolder) {
        out.push(meta.path);
      }
    }
    return out.sort();
  }

  // LocalStore implementation
  async list(): Promise<LocalFile[]> {
    return Array.from(this.items.values()).map((i) => ({ ...i.meta }));
  }

  async stat(path: string): Promise<LocalFile | null> {
    const item = this.items.get(toKey(path));
    return item ? { ...item.meta } : null;
  }

  async read(path: string): Promise<ArrayBuffer> {
    const item = this.items.get(toKey(path));
    if (!item || item.meta.isFolder) {
      throw new NotFoundError(path);
    }
    return item.data.slice(0);
  }

  async write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalFile> {
    this.checkMutate();
    return this.writeInternal(path, data, mtime);
  }

  async trash(path: string): Promise<void> {
    this.checkMutate();
    this.trashed.push(path);
    this.deleteInternal(path);
  }

  async rename(from: string, to: string): Promise<void> {
    this.checkMutate();
    this.renameInternal(from, to);
  }

  async mkdir(path: string): Promise<void> {
    this.checkMutate();
    const p = parentDir(path);
    if (p) {
      this.ensureParentsInternal(path);
    }
    const key = toKey(path);
    if (!this.items.has(key)) {
      this.items.set(key, {
        meta: {
          path,
          isFolder: true,
          size: 0,
          mtime: 0,
        },
        data: new ArrayBuffer(0),
      });
    }
  }

  async rmdirIfEmpty(path: string): Promise<boolean> {
    this.checkMutate();
    const key = toKey(path);
    const existing = this.items.get(key);
    if (!existing || !existing.meta.isFolder) {
      return false;
    }
    const prefix = `${key}/`;
    for (const k of this.items.keys()) {
      if (k.startsWith(prefix)) {
        return false;
      }
    }
    this.items.delete(key);
    return true;
  }
}
