import { PlanSummary } from '../engine/guardrails';

export function summaryLines(
  reason: 'massChange' | 'emptyLocal' | 'emptyRemote',
  s: PlanSummary,
): string[] {
  const lines: string[] = [];

  const destructiveCount =
    s.deletesLocal.length + s.deletesRemote.length + s.configOverwrites.length;

  if (reason === 'emptyLocal') {
    lines.push(
      `Your local vault appears empty, but ${s.baseCount} files were synced before. Applying would delete them from Dropbox.`,
    );
  } else if (reason === 'emptyRemote') {
    lines.push(
      `Your Dropbox folder appears empty, but ${s.baseCount} files were synced before. Applying would delete them locally.`,
    );
  } else {
    lines.push(`This sync would delete or overwrite ${destructiveCount} files.`);
  }

  const counts: string[] = [];
  if (s.uploads > 0) counts.push(`Uploads: ${s.uploads}`);
  if (s.downloads > 0) counts.push(`Downloads: ${s.downloads}`);
  if (s.moves > 0) counts.push(`Moves: ${s.moves}`);
  if (s.merges > 0) counts.push(`Merges: ${s.merges}`);
  if (s.conflicts > 0) counts.push(`Conflicts: ${s.conflicts}`);
  if (s.deletesLocal.length > 0) counts.push(`Local deletions: ${s.deletesLocal.length}`);
  if (s.deletesRemote.length > 0) counts.push(`Remote deletions: ${s.deletesRemote.length}`);
  if (s.configOverwrites.length > 0) counts.push(`Config overwrites: ${s.configOverwrites.length}`);

  if (counts.length > 0) {
    lines.push(...counts);
  }

  const allDestructivePaths: string[] = [
    ...s.deletesLocal.map((p) => `- Delete local: ${p}`),
    ...s.deletesRemote.map((p) => `- Delete from Dropbox: ${p}`),
    ...s.configOverwrites.map((p) => `- Overwrite config: ${p}`),
  ];

  const MAX_PATHS = 200;
  const displayedPaths = allDestructivePaths.slice(0, MAX_PATHS);
  lines.push(...displayedPaths);

  const overflow = allDestructivePaths.length - MAX_PATHS;
  if (overflow > 0) {
    lines.push(`…and ${overflow} more`);
  }

  return lines;
}
