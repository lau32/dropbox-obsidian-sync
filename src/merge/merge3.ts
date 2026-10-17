import { diff3Merge } from 'node-diff3';

export type MergeResult = { clean: true; text: string } | { clean: false };

export function merge3(base: string, local: string, remote: string): MergeResult {
  const crlf = local.includes('\r\n');
  const norm = (s: string): string[] => s.replace(/\r\n/g, '\n').split('\n');
  const blocks = diff3Merge(norm(local), norm(base), norm(remote), { excludeFalseConflicts: true });
  const out: string[] = [];
  for (const block of blocks) {
    if (block.conflict) return { clean: false };
    if (block.ok) out.push(...block.ok);
  }
  return { clean: true, text: out.join(crlf ? '\r\n' : '\n') };
}
