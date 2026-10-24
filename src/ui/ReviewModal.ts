import { App, Modal, Setting } from 'obsidian';
import { PlanSummary } from '../engine/guardrails';
import { summaryLines } from './summaryText';

export type ReviewChoice = 'all' | 'noDeletes' | 'cancel';

export class ReviewModal extends Modal {
  private chosen = false;

  constructor(
    app: App,
    private readonly reason: 'massChange' | 'emptyLocal' | 'emptyRemote',
    private readonly summary: PlanSummary,
    private readonly onChoose: (c: ReviewChoice) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName('Review required').setHeading();

    const lines = summaryLines(this.reason, this.summary);
    if (lines.length > 0) {
      contentEl.createEl('p', { text: lines[0], cls: 'mod-warning' });
    }

    const container = contentEl.createDiv({ cls: 'dropbox-sync-review-summary' });
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('- ')) {
        container.createDiv({ text: line, cls: 'dropbox-sync-review-path' });
      } else if (line.startsWith('…and')) {
        container.createDiv({ text: line, cls: 'dropbox-sync-review-overflow' });
      } else {
        container.createDiv({ text: line, cls: 'dropbox-sync-review-stat' });
      }
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Apply all changes')
          .setDestructive()
          .onClick(() => {
            this.choose('all');
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Apply without deletions')
          .setCta()
          .onClick(() => {
            this.choose('noDeletes');
          }),
      )
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => {
          this.choose('cancel');
        }),
      );
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.chosen) {
      this.onChoose('cancel');
    }
  }

  private choose(c: ReviewChoice): void {
    this.chosen = true;
    this.close();
    this.onChoose(c);
  }
}
