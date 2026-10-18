import type { PendingAuthState } from './auth/DropboxAuth';
import type { ConfigSyncSettings } from './filter/PathFilter';
import type { TriggerSettings } from './scheduler/Scheduler';

export interface DropboxSyncSettings {
  appKey: string;
  refreshToken: string | null;
  accountEmail: string | null;
  pendingAuth: PendingAuthState | null;
  remoteFolder: string;
  deviceName: string;
  triggers: TriggerSettings;
  configSync: ConfigSyncSettings;
  excludes: string[];
  maxFileSizeMB: number;
  baseSizeCapMB: number;
  guard: { maxDeletes: number; maxPercent: number };
  verboseLogging: boolean;
}

export const DEFAULT_SETTINGS: DropboxSyncSettings = {
  appKey: '',
  refreshToken: null,
  accountEmail: null,
  pendingAuth: null,
  remoteFolder: '',
  deviceName: '',
  triggers: {
    onStartup: true,
    onResume: true,
    onEdit: true,
    editDebounceSec: 10,
    interval: true,
    intervalMin: 5,
    longpoll: true,
  },
  configSync: {
    core: false,
    themes: false,
    plugins: false,
    workspace: false,
  },
  excludes: [],
  maxFileSizeMB: 50,
  baseSizeCapMB: 1,
  guard: {
    maxDeletes: 10,
    maxPercent: 10,
  },
  verboseLogging: false,
};

export function defaultDeviceName(p: {
  isIosApp: boolean;
  isAndroidApp: boolean;
  isTablet: boolean;
}): 'iPhone' | 'iPad' | 'Android' | 'Desktop' {
  if (p.isIosApp) {
    return p.isTablet ? 'iPad' : 'iPhone';
  }
  if (p.isAndroidApp) {
    return 'Android';
  }
  return 'Desktop';
}

export function clampMaxFileSizeMB(n: number): number {
  if (Number.isNaN(n)) {
    return 50;
  }
  return Math.min(150, Math.max(1, Math.round(n)));
}
