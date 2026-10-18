import { ItemView, WorkspaceLeaf } from 'obsidian';
import { StateStore } from '../state/StateStore';
import { SyncLogEntry } from '../types';

export const SYNC_LOG_VIEW = 'dropbox-vault-sync-log';

export class SyncLogView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly getStateStore: () => StateStore,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SYNC_LOG_VIEW;
  }

  getDisplayText(): string {
    return 'Dropbox Sync Log';
  }

  getIcon(): string {
    return 'history';
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    const header = containerEl.createDiv({ cls: 'dropbox-sync-log-header' });
    header.createEl('h3', { text: 'Sync History' });

    const refreshBtn = header.createEl('button', { text: 'Refresh' });
    refreshBtn.onclick = () => {
      this.render();
    };

    const logList = containerEl.createDiv({ cls: 'dropbox-sync-log-list' });

    let entries: SyncLogEntry[] = [];
    try {
      entries = await this.getStateStore().getLog();
    } catch (err) {
      logList.createEl('p', {
        text: `Failed to load sync log: ${err instanceof Error ? err.message : String(err)}`,
        cls: 'mod-warning',
      });
      return;
    }

    if (entries.length === 0) {
      logList.createEl('p', { text: 'No sync runs recorded yet.' });
      return;
    }

    for (const entry of entries) {
      const card = logList.createDiv({ cls: 'dropbox-sync-log-card' });
      const durationSec = Math.max(0, (entry.finishedAt - entry.startedAt) / 1000).toFixed(1);
      const timeStr = new Date(entry.startedAt).toLocaleString();

      const topRow = card.createDiv({ cls: 'dropbox-sync-log-row-top' });
      topRow.createEl('strong', { text: timeStr });
      topRow.createEl('span', {
        text: ` [${entry.trigger}] — ${entry.status} (${durationSec}s)`,
        cls: `dropbox-sync-status-${entry.status}`,
      });

      const statsRow = card.createDiv({ cls: 'dropbox-sync-log-row-stats' });
      statsRow.createEl('span', {
        text: `Actions: ${entry.actions.length} | Merged: ${entry.merged.length} | Conflicts: ${entry.conflicts.length} | Errors: ${entry.errors.length}`,
      });

      if (entry.errors.length > 0) {
        const errorList = card.createEl('ul', { cls: 'dropbox-sync-log-errors' });
        for (const err of entry.errors) {
          errorList.createEl('li', {
            text: err.path ? `${err.path}: ${err.message}` : err.message,
          });
        }
      }

      if (entry.conflicts.length > 0) {
        const conflictList = card.createEl('ul', { cls: 'dropbox-sync-log-conflicts' });
        for (const c of entry.conflicts) {
          conflictList.createEl('li', { text: `Conflict copy created: ${c}` });
        }
      }
    }
  }
}
