import { minimatch } from 'minimatch';

export interface ConfigSyncSettings {
  core: boolean;
  themes: boolean;
  plugins: boolean;
  workspace: boolean;
}

export interface FilterSettings {
  configDir: string;
  pluginDir: string;
  configSync: ConfigSyncSettings;
  excludes: string[];
  maxFileSizeBytes: number;
}

const MATCH_OPTS = { dot: true, matchBase: true, nocase: true } as const;

function stripSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}

export class PathFilter {
  private readonly configDir: string;
  private readonly pluginDir: string;
  private readonly configSync: ConfigSyncSettings;
  private readonly excludes: string[];
  private readonly maxFileSizeBytes: number;

  constructor(s: FilterSettings) {
    this.configDir = stripSlashes(s.configDir);
    this.pluginDir = stripSlashes(s.pluginDir);
    this.configSync = s.configSync;
    this.excludes = s.excludes;
    this.maxFileSizeBytes = s.maxFileSizeBytes;
  }

  isConfigPath(path: string): boolean {
    const p = stripSlashes(path);
    return p === this.configDir || p.startsWith(`${this.configDir}/`);
  }

  isSizeAllowed(size: number): boolean {
    return size <= this.maxFileSizeBytes;
  }

  isPathSynced(path: string, isFolder = false): boolean {
    const p = stripSlashes(path);
    if (!p) {
      return false;
    }

    if (p === this.pluginDir || p.startsWith(`${this.pluginDir}/`)) {
      return false;
    }

    if (p === '.trash' || p.startsWith('.trash/')) {
      return false;
    }

    const segments = p.split('/');
    for (const seg of segments) {
      const lower = seg.toLowerCase();
      if (lower === '.ds_store' || lower === 'thumbs.db') {
        return false;
      }
    }

    for (const pattern of this.excludes) {
      if (minimatch(p, pattern, MATCH_OPTS)) {
        return false;
      }
    }

    if (this.isConfigPath(p)) {
      if (isFolder || p === this.configDir) {
        return false;
      }
      const rel = p.slice(this.configDir.length + 1);
      if (!rel.includes('/')) {
        if (rel === 'community-plugins.json') {
          return this.configSync.plugins;
        }
        if (rel.startsWith('workspace') && rel.endsWith('.json')) {
          return this.configSync.workspace;
        }
        if (rel.endsWith('.json')) {
          return this.configSync.core;
        }
        return false;
      }
      if (rel.startsWith('themes/') || rel.startsWith('snippets/')) {
        return this.configSync.themes;
      }
      if (rel.startsWith('plugins/')) {
        return this.configSync.plugins;
      }
      return false;
    }

    return true;
  }
}
