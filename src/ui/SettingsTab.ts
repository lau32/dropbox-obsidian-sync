import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type DropboxVaultSyncPlugin from '../main';
import { clampMaxFileSizeMB } from '../settings';

export class DropboxSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DropboxVaultSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Dropbox Vault Sync' });

    // Section 1: Dropbox Account
    containerEl.createEl('h3', { text: 'Dropbox account' });

    if (this.plugin.settings.refreshToken) {
      new Setting(containerEl)
        .setName('Account')
        .setDesc(`Connected: ${this.plugin.settings.accountEmail ?? 'Connected'}`)
        .addButton((btn) => {
          btn
            .setButtonText('Disconnect')
            .setWarning()
            .onClick(async () => {
              await this.plugin.disconnect();
              new Notice('Disconnected from Dropbox');
              this.display();
            });
        });
    } else {
      new Setting(containerEl)
        .setName('Connect to Dropbox')
        .setDesc('Authorize this plugin to sync your vault with Dropbox.')
        .addButton((btn) => {
          btn
            .setButtonText('Connect')
            .setCta()
            .onClick(async () => {
              try {
                const url = await this.plugin.auth.beginAuth('redirect');
                window.open(url);
              } catch (err) {
                new Notice(
                  `Failed to begin authentication: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            });
        });

      let manualCode = '';
      new Setting(containerEl)
        .setName('Manual authorization')
        .setDesc(
          'If the redirect does not open Obsidian, click "Get code", authorize, and paste the code here.',
        )
        .addText((text) => {
          text.setPlaceholder('Authorization code').onChange((v) => {
            manualCode = v.trim();
          });
        })
        .addButton((btn) => {
          btn.setButtonText('Get code').onClick(async () => {
            try {
              const url = await this.plugin.auth.beginAuth('manual');
              window.open(url);
            } catch (err) {
              new Notice(
                `Failed to begin authentication: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          });
        })
        .addButton((btn) => {
          btn.setButtonText('Submit code').onClick(async () => {
            if (!manualCode) {
              new Notice('Please enter an authorization code');
              return;
            }
            try {
              await this.plugin.auth.completeAuth(manualCode);
              new Notice('Successfully connected to Dropbox!');
              this.display();
              void this.plugin.syncNow();
            } catch (err) {
              new Notice(
                `Authentication failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          });
        });
    }

    // Section 2: Vault & Device
    containerEl.createEl('h3', { text: 'Vault and device' });

    new Setting(containerEl)
      .setName('Remote folder')
      .setDesc('Folder in Dropbox where this vault is stored (under Apps/<App>/).')
      .addText((text) => {
        text
          .setValue(this.plugin.settings.remoteFolder)
          .onChange(async (v) => {
            this.plugin.settings.remoteFolder = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Device name')
      .setDesc('Device name used in conflict file names.')
      .addText((text) => {
        text
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (v) => {
            this.plugin.settings.deviceName = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // Section 3: Sync Triggers
    containerEl.createEl('h3', { text: 'Sync triggers' });

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Trigger sync when Obsidian starts and vault layout is ready.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.triggers.onStartup)
          .onChange(async (val) => {
            this.plugin.settings.triggers.onStartup = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Sync on resume / window focus')
      .setDesc('Trigger sync when resuming app or focusing the Obsidian window.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.triggers.onResume)
          .onChange(async (val) => {
            this.plugin.settings.triggers.onResume = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Sync on local edit')
      .setDesc('Trigger sync automatically after changes in the vault.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.triggers.onEdit)
          .onChange(async (val) => {
            this.plugin.settings.triggers.onEdit = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Edit debounce (seconds)')
      .setDesc('Seconds to wait after the last local edit before syncing.')
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.triggers.editDebounceSec))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!Number.isNaN(num) && num >= 0) {
              this.plugin.settings.triggers.editDebounceSec = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('Periodic interval sync')
      .setDesc('Trigger sync periodically on a timer.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.triggers.interval)
          .onChange(async (val) => {
            this.plugin.settings.triggers.interval = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Interval sync frequency (minutes)')
      .setDesc('Minutes between periodic sync checks.')
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.triggers.intervalMin))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!Number.isNaN(num) && num > 0) {
              this.plugin.settings.triggers.intervalMin = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('Remote longpoll')
      .setDesc('Listen for remote changes on Dropbox while the app is foregrounded.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.triggers.longpoll)
          .onChange(async (val) => {
            this.plugin.settings.triggers.longpoll = val;
            await this.plugin.saveSettings();
          });
      });

    // Section 4: Configuration Sync (.obsidian)
    containerEl.createEl('h3', { text: 'Obsidian configuration sync' });

    new Setting(containerEl)
      .setName('Core settings')
      .setDesc('Sync core configuration files (app.json, appearance.json, hotkeys.json, etc.).')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.configSync.core)
          .onChange(async (val) => {
            this.plugin.settings.configSync.core = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Themes and snippets')
      .setDesc('Sync custom themes and CSS snippets.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.configSync.themes)
          .onChange(async (val) => {
            this.plugin.settings.configSync.themes = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Community plugins')
      .setDesc('Sync community plugin list and plugin data files.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.configSync.plugins)
          .onChange(async (val) => {
            this.plugin.settings.configSync.plugins = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Workspace layout')
      .setDesc(
        'Sync workspace layout (workspace.json). Warning: Can cause frequent sync churn if different devices have different screen sizes or open tabs.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.configSync.workspace)
          .onChange(async (val) => {
            this.plugin.settings.configSync.workspace = val;
            await this.plugin.saveSettings();
          });
      });

    // Section 5: Filters & File Limits
    containerEl.createEl('h3', { text: 'Filters and file limits' });

    new Setting(containerEl)
      .setName('Excluded paths')
      .setDesc('Comma- or newline-separated glob patterns to exclude from sync (e.g. Archive/**, *.mov).')
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.excludes.join('\n'))
          .onChange(async (val) => {
            this.plugin.settings.excludes = val
              .split(/[\n,]/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Max file size (MB)')
      .setDesc('Files larger than this limit are skipped (1 to 150 MB).')
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.maxFileSizeMB))
          .onChange(async (val) => {
            const num = parseFloat(val);
            if (!Number.isNaN(num)) {
              this.plugin.settings.maxFileSizeMB = clampMaxFileSizeMB(num);
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('Merge base size cap (MB)')
      .setDesc('Maximum file size for storing 3-way merge bases.')
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.baseSizeCapMB))
          .onChange(async (val) => {
            const num = parseFloat(val);
            if (!Number.isNaN(num) && num > 0) {
              this.plugin.settings.baseSizeCapMB = num;
              await this.plugin.saveSettings();
            }
          });
      });

    // Section 6: Guardrails
    containerEl.createEl('h3', { text: 'Guardrails' });

    new Setting(containerEl)
      .setName('Max deletions threshold (count)')
      .setDesc('Pause automatic sync for review if more than this many files would be deleted or overwritten.')
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.guard.maxDeletes))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!Number.isNaN(num) && num > 0) {
              this.plugin.settings.guard.maxDeletes = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('Max deletions threshold (percent)')
      .setDesc('Pause automatic sync for review if more than this percentage of files would be deleted or overwritten.')
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.guard.maxPercent))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!Number.isNaN(num) && num > 0 && num <= 100) {
              this.plugin.settings.guard.maxPercent = num;
              await this.plugin.saveSettings();
            }
          });
      });

    // Section 7: Advanced
    containerEl.createEl('h3', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Custom Dropbox app key')
      .setDesc('Overrides the shipped app key. Changing this requires reconnecting your Dropbox account.')
      .addText((text) => {
        text
          .setPlaceholder('Shipped default')
          .setValue(this.plugin.settings.appKey)
          .onChange(async (val) => {
            const trimmed = val.trim();
            const oldKey = this.plugin.settings.appKey;
            this.plugin.settings.appKey = trimmed;
            await this.plugin.saveSettings();
            this.plugin.reinitAuth();
            if (oldKey !== trimmed && this.plugin.settings.refreshToken) {
              new Notice('App key changed. Please disconnect and reconnect your Dropbox account.');
            }
          });
      });

    new Setting(containerEl)
      .setName('Verbose logging')
      .setDesc('Enable verbose logging in the developer console.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.verboseLogging)
          .onChange(async (val) => {
            this.plugin.settings.verboseLogging = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Open sync log')
      .setDesc('View recent sync runs, actions, merges, and conflicts.')
      .addButton((btn) => {
        btn.setButtonText('Open log').onClick(() => {
          this.plugin.openSyncLog();
        });
      });

    new Setting(containerEl)
      .setName('Reset sync state')
      .setDesc('Clear local sync metadata and cache. Next sync will perform a full union reconciliation.')
      .addButton((btn) => {
        btn
          .setButtonText('Reset sync state')
          .setWarning()
          .onClick(() => {
            this.plugin.confirmResetSyncState();
          });
      });
  }
}
