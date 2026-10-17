import { FakeVault } from '../fakes/FakeVault';
import { encodeText, decodeText } from '../../src/bytes';

describe('FakeVault', () => {
  test('write creates parent folders and stat returns file/folder metadata or null for missing paths', async () => {
    let now = 1000;
    const vault = new FakeVault(() => (now += 100));

    expect(await vault.stat('missing.md')).toBeNull();

    const written = await vault.write('a/b/c.md', encodeText('hello'));
    expect(written).toEqual({
      path: 'a/b/c.md',
      isFolder: false,
      size: 5,
      mtime: 1100,
    });

    const statA = await vault.stat('a');
    expect(statA?.isFolder).toBe(true);
    const statAB = await vault.stat('a/b');
    expect(statAB?.isFolder).toBe(true);
    const statFile = await vault.stat('a/b/c.md');
    expect(statFile).toEqual(written);

    expect(decodeText(await vault.read('a/b/c.md'))).toBe('hello');
    expect(vault.readText('a/b/c.md')).toBe('hello');
  });

  test('failAfter throws Error("injected") on the (n+1)-th mutating call', async () => {
    let now = 1000;
    const vault = new FakeVault(() => (now += 100), { failAfter: 2 });

    await vault.write('one.md', encodeText('1'));
    await vault.mkdir('dir');
    await expect(vault.write('two.md', encodeText('2'))).rejects.toThrow('injected');
  });

  test('user helpers, trash, rename, and rmdirIfEmpty work as expected', async () => {
    let now = 1000;
    const vault = new FakeVault(() => (now += 100));

    vault.writeText('sub/note.md', 'v1');
    expect(vault.paths()).toEqual(['sub/note.md']);
    expect(vault.readText('sub/note.md')).toBe('v1');

    vault.renameUser('sub/note.md', 'sub/renamed.md');
    expect(vault.paths()).toEqual(['sub/renamed.md']);

    await vault.trash('sub/renamed.md');
    expect(vault.trashed).toEqual(['sub/renamed.md']);
    expect(vault.paths()).toEqual([]);

    expect(await vault.rmdirIfEmpty('sub')).toBe(true);
    expect(await vault.stat('sub')).toBeNull();
  });
});
