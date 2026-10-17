import { PathFilter, FilterSettings } from '../../src/filter/PathFilter';

const base: FilterSettings = { configDir: '.obsidian', pluginDir: '.obsidian/plugins/dropbox-vault-sync',
  configSync: { core: false, themes: false, plugins: false, workspace: false }, excludes: [], maxFileSizeBytes: 50 * 1024 * 1024 };
const f = (patch: Partial<FilterSettings> = {}) => new PathFilter({ ...base, ...patch });
const all = { core: true, themes: true, plugins: true, workspace: true };

test.each([
  ['Notes/a.md', true], ['.trash/x.md', false], ['dir/.DS_Store', false], ['Thumbs.db', false], ['.obsidian/app.json', false],
])('defaults: %s → %s', (p, exp) => expect(f().isPathSynced(p)).toBe(exp));

test.each([
  [{ core: true }, '.obsidian/app.json', true],
  [{ core: true }, '.obsidian/workspace.json', false],
  [{ core: true }, '.obsidian/community-plugins.json', false],
  [{ themes: true }, '.obsidian/themes/Minimal/theme.css', true],
  [{ themes: true }, '.obsidian/snippets/a.css', true],
  [{ plugins: true }, '.obsidian/plugins/calendar/main.js', true],
  [{ plugins: true }, '.obsidian/community-plugins.json', true],
  [{ workspace: true }, '.obsidian/workspace-mobile.json', true],
])('category %o: %s → %s', (cats, p, exp) =>
  expect(f({ configSync: { ...base.configSync, ...cats } }).isPathSynced(p)).toBe(exp));

test('own plugin dir and unknown config paths are never synced', () => {
  expect(f({ configSync: all }).isPathSynced('.obsidian/plugins/dropbox-vault-sync/data.json')).toBe(false);
  expect(f({ configSync: all }).isPathSynced('.obsidian/cache/x')).toBe(false);
  expect(f({ configSync: all }).isPathSynced('.obsidian/themes', true)).toBe(false);
});
test('custom configDir', () => {
  expect(f({ configDir: '.cfg', pluginDir: '.cfg/plugins/dropbox-vault-sync', configSync: all }).isPathSynced('.cfg/app.json')).toBe(true);
});
test('excludes', () => {
  const g = f({ excludes: ['Archive/**', '*.mov'] });
  expect(g.isPathSynced('Archive/a.md')).toBe(false);
  expect(g.isPathSynced('x/clip.MOV')).toBe(false);
  expect(g.isPathSynced('Archived.md')).toBe(true);
});
test('size and config detection', () => {
  expect(f().isSizeAllowed(50 * 1024 * 1024)).toBe(true);
  expect(f().isSizeAllowed(50 * 1024 * 1024 + 1)).toBe(false);
  expect(f().isConfigPath('.obsidian/app.json')).toBe(true);
  expect(f().isConfigPath('notes/.obsidian.md')).toBe(false);
});
