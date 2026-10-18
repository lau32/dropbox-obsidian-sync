import { App, Modal, Notice, Platform, Plugin } from 'obsidian';
import { DropboxAuth } from './auth/DropboxAuth';
import { SyncEngine, type SyncOutcome } from './engine/SyncEngine';
import { PathFilter } from './filter/PathFilter';
import { contentHash } from './hash/contentHash';
import { ObsidianLocalStore } from './obsidian/ObsidianLocalStore';
import { obsidianHttp } from './obsidian/obsidianHttp';
import { DropboxRemote } from './remote/DropboxRemote';
import type { RemoteStore } from './remote/RemoteStore';
import { Scheduler } from './scheduler/Scheduler';
import { SelfWriteTracker } from './scheduler/SelfWriteTracker';
import {
  DEFAULT_SETTINGS,
  DropboxSyncSettings,
  SHIPPED_APP_KEY,
  defaultDeviceName,
} from './settings';
import { IdbStateStore } from './state/IdbStateStore';
import type { TriggerReason, WriteMode } from './types';
import { DropboxSyncSettingTab } from './ui/SettingsTab';
import { StatusBar } from './ui/StatusBar';

class DelegatingRemoteStore implements RemoteStore {
  constructor(private readonly getRemote: () => RemoteStore) {}

  listAll() {
    return this.getRemote().listAll();
  }

  listChanges(cursor: string) {
    return this.getRemote().listChanges(cursor);
  }

  longpoll(cursor: string, timeoutSec: number) {
    return this.getRemote().longpoll(cursor, timeoutSec);
  }

  download(path: string) {
    return this.getRemote().download(path);
  }

  downloadRev(path: string, rev: string) {
    return this.getRemote().downloadRev(path, rev);
  }

  upload(
    path: string,
    data: ArrayBuffer,
    mode: WriteMode,
    clientModified: number,
  ) {
    return this.getRemote().upload(path, data, mode, clientModified);
  }

  delete(path: string, rev: string | null) {
    return this.getRemote().delete(path, rev);
  }

  move(from: string, to: string) {
    return this.getRemote().move(from, to);
  }

  createFolder(path: string) {
    return this.getRemote().createFolder(path);
  }
}

class PluginPathFilter extends PathFilter {
  constructor(private readonly plugin: DropboxVaultSyncPlugin) {
    const configDir = plugin.app.vault.configDir;
    const pluginDir =
      plugin.manifest.dir ?? `${configDir}/plugins/${plugin.manifest.id}`;
    super({
      configDir,
      pluginDir,
      configSync: plugin.settings.configSync,
      excludes: plugin.settings.excludes,
      maxFileSizeBytes: plugin.settings.maxFileSizeMB * 1024 * 1024,
    });
  }

  private current(): PathFilter {
    const configDir = this.plugin.app.vault.configDir;
    const pluginDir =
      this.plugin.manifest.dir ??
      `${configDir}/plugins/${this.plugin.manifest.id}`;
    return new PathFilter({
      configDir,
      pluginDir,
      configSync: this.plugin.settings.configSync,
      excludes: this.plugin.settings.excludes,
      maxFileSizeBytes: this.plugin.settings.maxFileSizeMB * 1024 * 1024,
    });
  }

  override isConfigPath(path: string): boolean {
    return this.current().isConfigPath(path);
  }

  override isSizeAllowed(size: number): boolean {
    return this.current().isSizeAllowed(size);
  }

  override isPathSynced(path: string, isFolder = false): boolean {
    return this.current().isPathSynced(path, isFolder);
  }
}

class ConfirmResetModal extends Modal {
  constructor(
    app: App,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Reset sync state?' });
    contentEl.createEl('p', {
      text: 'This will reset all local sync metadata, bases, and cursors. On the next sync, a full union reconciliation will be performed. No files will be deleted.',
    });

    const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
    cancelBtn.onclick = () => this.close();

    const resetBtn = btnContainer.createEl('button', {
      text: 'Reset state',
      cls: 'mod-warning',
    });
    resetBtn.onclick = async () => {
      this.close();
      await this.onConfirm();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class DropboxVaultSyncPlugin extends Plugin {
  settings: DropboxSyncSettings = DEFAULT_SETTINGS;
  auth!: DropboxAuth;
  remote!: RemoteStore;
  state!: IdbStateStore;
  localStore!: ObsidianLocalStore;
  selfWrites!: SelfWriteTracker;
  engine!: SyncEngine;
  scheduler!: Scheduler;
  statusBar: StatusBar | null = null;
  isPaused = false;
  lastNeedsReviewOutcome: SyncOutcome | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.selfWrites = new SelfWriteTracker();
    this.localStore = new ObsidianLocalStore(this.app, this.selfWrites);

    this.auth = new DropboxAuth({
      http: obsidianHttp,
      appKey: this.settings.appKey || SHIPPED_APP_KEY,
      getRefreshToken: () => this.settings.refreshToken,
      saveConnection: async (refreshToken, accountEmail) => {
        this.settings.refreshToken = refreshToken;
        this.settings.accountEmail = accountEmail;
        await this.saveSettings();
        if (!refreshToken) {
          this.statusBar?.setState({ kind: 'disconnected' });
        }
      },
      getPendingAuth: () => this.settings.pendingAuth,
      savePendingAuth: async (pending) => {
        this.settings.pendingAuth = pending;
        await this.saveSettings();
      },
    });

    const getRemote = () => {
      return new DropboxRemote({
        http: obsidianHttp,
        root: this.settings.remoteFolder,
        getAccessToken: () => this.auth.getAccessToken(),
        refreshAccessToken: () => this.auth.refreshAccessToken(),
      });
    };
    this.remote = new DelegatingRemoteStore(getRemote);

    const appId =
      (this.app as unknown as { appId?: string }).appId ??
      this.app.vault.getName();
    this.state = await IdbStateStore.open(`dropbox-vault-sync-${appId}`);

    const filter = new PluginPathFilter(this);

    const renameHints: Array<{ from: string; to: string }> = [];
    const takeRenameHints = () => {
      const hints = [...renameHints];
      renameHints.length = 0;
      return hints;
    };

    this.engine = new SyncEngine({
      local: this.localStore,
      remote: this.remote,
      state: this.state,
      filter,
      hash: contentHash,
      now: () => new Date(),
      options: () => ({
        deviceName: this.settings.deviceName,
        maxDeletes: this.settings.guard.maxDeletes,
        maxPercent: this.settings.guard.maxPercent,
        baseTextCapBytes: this.settings.baseSizeCapMB * 1024 * 1024,
        configConflictDir: `${this.app.vault.configDir}/conflicts`,
      }),
      takeRenameHints,
    });

    this.scheduler = new Scheduler({
      run: async (trigger) => {
        await this.runSync(trigger);
      },
      settings: () => this.settings.triggers,
      isPaused: () => this.isPaused || this.settings.refreshToken === null,
      selfWrites: this.selfWrites,
      longpoll: async (signal) => {
        if (signal.aborted) return 'timeout';
        const meta = await this.state.getMeta();
        if (!meta.cursor) {
          return new Promise((resolve) => {
            const onAbort = () => {
              clearTimeout(t);
              signal.removeEventListener('abort', onAbort);
              resolve('timeout');
            };
            const t = setTimeout(() => {
              signal.removeEventListener('abort', onAbort);
              resolve('timeout');
            }, 30_000);
            signal.addEventListener('abort', onAbort);
          });
        }
        try {
          const resPromise = getRemote().longpoll(meta.cursor, 30);
          const abortPromise = new Promise<'timeout'>((resolve) => {
            signal.addEventListener('abort', () => resolve('timeout'), {
              once: true,
            });
          });
          const res = await Promise.race([resPromise, abortPromise]);
          if (typeof res === 'object' && res.changed) {
            return 'changed';
          }
          return 'timeout';
        } catch {
          return 'error';
        }
      },
    });

    // Status bar item
    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBar(statusBarEl, () => {
      if (this.isPaused && this.lastNeedsReviewOutcome) {
        this.openReviewModal();
      } else {
        void this.syncNow();
      }
    });

    if (!this.settings.refreshToken) {
      this.statusBar.setState({ kind: 'disconnected' });
    } else {
      const meta = await this.state.getMeta();
      this.statusBar.setState({ kind: 'idle', lastSyncAt: meta.lastSyncAt });
    }

    // Protocol handler: obsidian://dropbox-vault-sync-auth
    this.registerObsidianProtocolHandler(
      'dropbox-vault-sync-auth',
      async (params) => {
        if (typeof params.code === 'string') {
          try {
            await this.auth.completeAuth(params.code);
            new Notice('Connected to Dropbox!');
            this.statusBar?.setState({ kind: 'idle', lastSyncAt: null });
            void this.syncNow();
          } catch (err) {
            new Notice(
              `Dropbox auth error: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      },
    );

    // Vault events
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        this.scheduler.notifyLocalChange(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        this.scheduler.notifyLocalChange(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        this.scheduler.notifyLocalChange(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        renameHints.push({ from: oldPath, to: file.path });
        this.scheduler.notifyLocalChange(file.path);
      }),
    );

    // Window events
    this.registerDomEvent(window, 'focus', () => {
      this.scheduler.notifyResume();
    });
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.scheduler.notifyResume();
      }
    });

    // Commands
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => {
        void this.syncNow();
      },
    });
    this.addCommand({
      id: 'show-conflicts',
      name: 'Show conflicts',
      callback: () => {
        this.showConflicts();
      },
    });
    this.addCommand({
      id: 'open-sync-log',
      name: 'Open sync log',
      callback: () => {
        this.openSyncLog();
      },
    });
    this.addCommand({
      id: 'reset-sync-state',
      name: 'Reset sync state',
      callback: () => {
        this.confirmResetSyncState();
      },
    });

    // Settings tab
    this.addSettingTab(new DropboxSyncSettingTab(this.app, this));

    // Start scheduler when layout is ready
    this.app.workspace.onLayoutReady(() => {
      this.scheduler.start();
    });
  }

  onunload(): void {
    this.scheduler?.stop();
    this.statusBar?.destroy();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    if (data?.triggers) {
      this.settings.triggers = Object.assign(
        {},
        DEFAULT_SETTINGS.triggers,
        data.triggers,
      );
    }
    if (data?.configSync) {
      this.settings.configSync = Object.assign(
        {},
        DEFAULT_SETTINGS.configSync,
        data.configSync,
      );
    }
    if (data?.guard) {
      this.settings.guard = Object.assign(
        {},
        DEFAULT_SETTINGS.guard,
        data.guard,
      );
    }

    if (!this.settings.remoteFolder) {
      this.settings.remoteFolder = this.app.vault.getName();
    }
    if (!this.settings.deviceName) {
      this.settings.deviceName = defaultDeviceName(Platform);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async disconnect(): Promise<void> {
    await this.auth.disconnect();
    this.settings.refreshToken = null;
    this.settings.accountEmail = null;
    this.settings.pendingAuth = null;
    await this.saveSettings();
    this.statusBar?.setState({ kind: 'disconnected' });
  }

  async syncNow(): Promise<void> {
    if (this.isPaused) {
      this.openReviewModal();
      return;
    }
    try {
      await this.scheduler.requestManual();
    } catch (err) {
      new Notice(
        `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async runSync(
    trigger: TriggerReason,
    approval?: 'all' | 'noDeletes',
  ): Promise<void> {
    if (this.settings.verboseLogging) {
      console.log(`[DropboxVaultSync] Starting sync (trigger: ${trigger})`);
    }
    this.statusBar?.setState({ kind: 'syncing', done: 0, total: 0 });

    const outcome = await this.engine.run({
      trigger,
      approval,
      onProgress: (done, total) => {
        this.statusBar?.setState({ kind: 'syncing', done, total });
      },
    });

    if (this.settings.verboseLogging) {
      console.log('[DropboxVaultSync] Sync finished with outcome:', outcome);
    }

    if (outcome.status === 'ok') {
      this.isPaused = false;
      this.lastNeedsReviewOutcome = null;
      const meta = await this.state.getMeta();
      this.statusBar?.setState({ kind: 'idle', lastSyncAt: meta.lastSyncAt });
      if (outcome.result.conflicts.length > 0) {
        new Notice(
          `${outcome.result.conflicts.length} sync conflicts — run 'Show conflicts'`,
        );
      }
    } else if (outcome.status === 'needsReview') {
      this.isPaused = true;
      this.lastNeedsReviewOutcome = outcome;
      this.statusBar?.setState({ kind: 'needsReview' });
    } else if (outcome.status === 'offline') {
      this.statusBar?.setState({ kind: 'offline' });
    } else if (outcome.status === 'auth') {
      this.statusBar?.setState({ kind: 'reauth' });
    } else if (outcome.status === 'error') {
      this.statusBar?.setState({ kind: 'error', message: outcome.message });
    }
  }

  confirmResetSyncState(): void {
    const modal = new ConfirmResetModal(this.app, async () => {
      try {
        await this.state.reset();
        this.isPaused = false;
        this.lastNeedsReviewOutcome = null;
        this.statusBar?.setState({
          kind: this.settings.refreshToken ? 'idle' : 'disconnected',
          lastSyncAt: null,
        });
        new Notice(
          'Sync state reset. Next sync will perform a full reconciliation.',
        );
      } catch (err) {
        new Notice(
          `Failed to reset state: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
    modal.open();
  }

  showConflicts(): void {
    new Notice(
      "Showing conflicts is available in the command palette ('Show conflicts').",
    );
  }

  openSyncLog(): void {
    new Notice('Sync log view will open recent sync history.');
  }

  openReviewModal(): void {
    new Notice(
      'Sync paused: changes exceeded guardrail threshold. Review required.',
    );
  }
}
