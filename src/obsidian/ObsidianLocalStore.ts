import { App, normalizePath, TFile } from 'obsidian';
import { decodeText } from '../bytes';
import { NotFoundError } from '../errors';
import type { LocalStore } from '../local/LocalStore';
import { parentDir } from '../paths';
import type { SelfWriteTracker } from '../scheduler/SelfWriteTracker';
import type { LocalFile } from '../types';

export class ObsidianLocalStore implements LocalStore {
  constructor(
    private readonly app: App,
    private readonly selfWrites: SelfWriteTracker,
  ) {}

  async list(): Promise<LocalFile[]> {
    const result: LocalFile[] = [];
    const visited = new Set<string>();

    const walk = async (dir: string) => {
      let listed: { files: string[]; folders: string[] };
      try {
        listed = await this.app.vault.adapter.list(dir);
      } catch {
        return;
      }

      for (const file of listed.files) {
        const normFile = normalizePath(file);
        const st = await this.app.vault.adapter.stat(normFile);
        if (st && st.type === 'file') {
          result.push({
            path: normFile,
            isFolder: false,
            size: st.size,
            mtime: st.mtime,
          });
        }
      }

      for (const folder of listed.folders) {
        const normFolder = normalizePath(folder);
        if (!normFolder || visited.has(normFolder)) continue;
        visited.add(normFolder);
        const st = await this.app.vault.adapter.stat(normFolder);
        result.push({
          path: normFolder,
          isFolder: true,
          size: 0,
          mtime: st ? st.mtime : 0,
        });
        await walk(normFolder);
      }
    };

    await walk('');

    const configDir = normalizePath(this.app.vault.configDir);
    if (configDir && !visited.has(configDir)) {
      try {
        const exists = await this.app.vault.adapter.exists(configDir);
        if (exists) {
          visited.add(configDir);
          const st = await this.app.vault.adapter.stat(configDir);
          result.push({
            path: configDir,
            isFolder: true,
            size: 0,
            mtime: st ? st.mtime : 0,
          });
          await walk(configDir);
        }
      } catch {
        // ignore
      }
    }

    return result;
  }

  async stat(path: string): Promise<LocalFile | null> {
    const norm = normalizePath(path);
    try {
      const st = await this.app.vault.adapter.stat(norm);
      if (!st) return null;
      return {
        path: norm,
        isFolder: st.type === 'folder',
        size: st.size,
        mtime: st.mtime,
      };
    } catch {
      return null;
    }
  }

  async read(path: string): Promise<ArrayBuffer> {
    const norm = normalizePath(path);
    try {
      return await this.app.vault.adapter.readBinary(norm);
    } catch {
      throw new NotFoundError(norm);
    }
  }

  async write(
    path: string,
    data: ArrayBuffer,
    mtime?: number,
  ): Promise<LocalFile> {
    const norm = normalizePath(path);
    const end = this.selfWrites.begin(norm);
    try {
      const parent = parentDir(norm);
      if (parent) {
        await this.mkdir(parent);
      }
      const file = this.app.vault.getAbstractFileByPath(norm);
      if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
        await this.app.vault.process(
          file,
          () => decodeText(data),
          mtime !== undefined ? { mtime } : undefined,
        );
      } else {
        await this.app.vault.adapter.writeBinary(
          norm,
          data,
          mtime !== undefined ? { mtime } : undefined,
        );
      }
      const st = await this.stat(norm);
      if (st) return st;
      return {
        path: norm,
        isFolder: false,
        size: data.byteLength,
        mtime: mtime ?? Date.now(),
      };
    } finally {
      end();
      this.selfWrites.mark(norm);
    }
  }

  async trash(path: string): Promise<void> {
    const norm = normalizePath(path);
    const end = this.selfWrites.begin(norm);
    try {
      const file = this.app.vault.getAbstractFileByPath(norm);
      if (file) {
        await this.app.fileManager.trashFile(file);
      } else {
        await this.app.vault.adapter.trashLocal(norm);
      }
    } finally {
      end();
      this.selfWrites.mark(norm);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const normFrom = normalizePath(from);
    const normTo = normalizePath(to);
    const endFrom = this.selfWrites.begin(normFrom);
    const endTo = this.selfWrites.begin(normTo);
    try {
      const parent = parentDir(normTo);
      if (parent) {
        await this.mkdir(parent);
      }
      const file = this.app.vault.getAbstractFileByPath(normFrom);
      if (file) {
        await this.app.vault.rename(file, normTo);
      } else {
        await this.app.vault.adapter.rename(normFrom, normTo);
      }
    } finally {
      endFrom();
      endTo();
      this.selfWrites.mark(normFrom);
      this.selfWrites.mark(normTo);
    }
  }

  async mkdir(path: string): Promise<void> {
    const norm = normalizePath(path);
    if (!norm) return;
    const end = this.selfWrites.begin(norm);
    try {
      const parts = norm.split('/');
      let current = '';
      for (const part of parts) {
        if (!part) continue;
        current = current ? `${current}/${part}` : part;
        const exists = await this.app.vault.adapter.exists(current);
        if (!exists) {
          await this.app.vault.adapter.mkdir(current);
        }
      }
    } finally {
      end();
      this.selfWrites.mark(norm);
    }
  }

  async rmdirIfEmpty(path: string): Promise<boolean> {
    const norm = normalizePath(path);
    if (!norm) return false;
    const end = this.selfWrites.begin(norm);
    try {
      const exists = await this.app.vault.adapter.exists(norm);
      if (!exists) return false;
      const listed = await this.app.vault.adapter.list(norm);
      if (listed.files.length === 0 && listed.folders.length === 0) {
        await this.app.vault.adapter.rmdir(norm, false);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      end();
      this.selfWrites.mark(norm);
    }
  }
}
