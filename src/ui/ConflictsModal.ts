import { App, Notice, SuggestModal, TFile } from 'obsidian';
import { findConflictCopies } from './conflicts';

export class ConflictsModal extends SuggestModal<string> {
  private readonly conflicts: string[];

  constructor(app: App) {
    super(app);
    const allFiles = app.vault.getFiles().map((f) => f.path);
    this.conflicts = findConflictCopies(allFiles);
    this.setPlaceholder(
      this.conflicts.length > 0
        ? 'Select a conflict copy to open and resolve...'
        : 'No conflict copies found in vault.',
    );
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.conflicts.filter((path) => path.toLowerCase().includes(q));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.createDiv({ text: value });
  }

  onChooseSuggestion(item: string, _evt: MouseEvent | KeyboardEvent): void {
    const file = this.app.vault.getAbstractFileByPath(item);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf().openFile(file);
    } else {
      new Notice(`Could not open file: ${item}`);
    }
  }
}
