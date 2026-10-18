const CONFLICT_PATTERN = / \(conflict \d{4}-\d{2}-\d{2} \d{4} [^)]+\)(\.[^/]*)?$/;

/**
 * Filter paths that match the Dropbox conflict copy naming format.
 */
export function findConflictCopies(paths: string[]): string[] {
  return paths.filter((p) => CONFLICT_PATTERN.test(p));
}
