import { toKey, toRemotePath, fromRemotePath, conflictName, isMarkdown, parentDir } from '../../src/paths';
const when = new Date(2026, 9, 13, 21, 42);

test('toKey normalizes NFD to NFC and lowercases', () => {
  expect(toKey('Notes/Café.md'.normalize('NFD'))).toBe('notes/café.md'.normalize('NFC'));
});
test('remote path mapping', () => {
  expect(toRemotePath('My Vault', 'Sub/A.md')).toBe('/My Vault/Sub/A.md');
  expect(toRemotePath('My Vault', '')).toBe('/My Vault');
  expect(fromRemotePath('My Vault', '/my vault/Sub/A.md')).toBe('Sub/A.md');
  expect(fromRemotePath('My Vault', '/My Vault')).toBeNull();
  expect(fromRemotePath('My Vault', '/Other/A.md')).toBeNull();
  expect(fromRemotePath('My Vault', '/My Vault2/A.md')).toBeNull();
});
test('conflictName', () => {
  expect(conflictName('a/Note.md', when, 'iPhone')).toBe('a/Note (conflict 2026-10-13 2142 iPhone).md');
  expect(conflictName('x.tar.gz', when, 'Desktop')).toBe('x.tar (conflict 2026-10-13 2142 Desktop).gz');
  expect(conflictName('.gitignore', when, 'Desktop')).toBe('.gitignore (conflict 2026-10-13 2142 Desktop)');
  expect(conflictName('README', when, 'Desktop')).toBe('README (conflict 2026-10-13 2142 Desktop)');
});
test('helpers', () => {
  expect(isMarkdown('a/B.MD')).toBe(true);
  expect(isMarkdown('a/b.png')).toBe(false);
  expect(parentDir('a/b/c.md')).toBe('a/b');
  expect(parentDir('c.md')).toBe('');
});
