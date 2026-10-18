import { describe, expect, test } from 'vitest';
import { PlanSummary } from '../../src/engine/guardrails';
import { findConflictCopies } from '../../src/ui/conflicts';
import { summaryLines } from '../../src/ui/summaryText';

describe('findConflictCopies', () => {
  test('matches conflict patterns and rejects non-conflict files', () => {
    const files = [
      'a/Note (conflict 2026-10-13 2142 iPhone).md',
      '.gitignore (conflict 2026-10-13 2142 Desktop)',
      'Note (conflict notes).md',
      'Normal Note.md',
      'folder/sub (conflict 2024-01-01 1200 Mac)/file.txt',
      'folder/Note (conflict 2026-10-13 2142 iPhone).png',
    ];

    const conflicts = findConflictCopies(files);
    expect(conflicts).toEqual([
      'a/Note (conflict 2026-10-13 2142 iPhone).md',
      '.gitignore (conflict 2026-10-13 2142 Desktop)',
      'folder/Note (conflict 2026-10-13 2142 iPhone).png',
    ]);
  });
});

describe('summaryLines', () => {
  const emptySummary: PlanSummary = {
    baseCount: 42,
    uploads: 1,
    downloads: 2,
    moves: 3,
    merges: 4,
    conflicts: 5,
    deletesLocal: [],
    deletesRemote: [],
    configOverwrites: [],
  };

  test('emptyLocal contains baseCount in first line', () => {
    const lines = summaryLines('emptyLocal', emptySummary);
    expect(lines[0]).toContain('42');
    expect(lines[0]).toBe(
      'Your local vault appears empty, but 42 files were synced before. Applying would delete them from Dropbox.',
    );
  });

  test('emptyRemote contains baseCount in first line', () => {
    const lines = summaryLines('emptyRemote', emptySummary);
    expect(lines[0]).toContain('42');
    expect(lines[0]).toBe(
      'Your Dropbox folder appears empty, but 42 files were synced before. Applying would delete them locally.',
    );
  });

  test('massChange with 250 remote deletes has 200 path lines and ends with ...and 50 more', () => {
    const deletes = Array.from({ length: 250 }, (_, i) => `file-${i}.md`);
    const summary: PlanSummary = {
      ...emptySummary,
      deletesRemote: deletes,
    };
    const lines = summaryLines('massChange', summary);
    expect(lines[0]).toBe('This sync would delete or overwrite 250 files.');

    // Count lines should contain details
    expect(lines.some((l) => l.includes('Remote deletions: 250'))).toBe(true);

    // Filter path lines (paths starting with file- or prefixed)
    const pathLines = lines.filter((l) => l.includes('file-'));
    expect(pathLines).toHaveLength(200);
    expect(lines[lines.length - 1]).toBe('…and 50 more');
  });
});
