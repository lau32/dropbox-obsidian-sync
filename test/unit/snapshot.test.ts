import { describe, expect, test, vi } from 'vitest';
import { takeSnapshot } from '../../src/engine/snapshot';
import { PathFilter, FilterSettings } from '../../src/filter/PathFilter';
import { contentHash } from '../../src/hash/contentHash';
import { toKey } from '../../src/paths';
import { FakeDropbox } from '../fakes/FakeDropbox';
import { FakeVault } from '../fakes/FakeVault';
import { MemoryStateStore } from '../fakes/MemoryStateStore';

const defaultFilterSettings: FilterSettings = {
  configDir: '.obsidian',
  pluginDir: '.obsidian/plugins/dropbox-vault-sync',
  configSync: { core: false, themes: false, plugins: false, workspace: false },
  excludes: [],
  maxFileSizeBytes: 50 * 1024 * 1024,
};

function makeFilter(patch: Partial<FilterSettings> = {}): PathFilter {
  return new PathFilter({ ...defaultFilterSettings, ...patch });
}

function setup() {
  let now = 1000;
  const clock = () => (now += 100);
  const vault = new FakeVault(clock);
  const dropbox = new FakeDropbox(clock);
  const state = new MemoryStateStore();

  const seed = async (path: string, text: string) => {
    const lf = vault.writeText(path, text);
    const re = dropbox.writeText(path, text);
    await state.commit(
      {
        path,
        isFolder: false,
        size: lf.size,
        mtime: lf.mtime,
        contentHash: re.contentHash,
        rev: re.rev,
        serverModified: re.serverModified,
      },
      text,
    );
  };

  return { vault, dropbox, state, seed };
}

describe('takeSnapshot', () => {
  test('unchanged file is not re-hashed', async () => {
    const { vault, dropbox, state, seed } = setup();
    await seed('a.md', 'hello world');

    const baseRec = (await state.loadBase()).get('a.md')!;
    const spyHash = vi.fn(contentHash);

    const snap = await takeSnapshot({
      local: vault,
      remote: dropbox.client(),
      state,
      filter: makeFilter(),
      hash: spyHash,
    });

    expect(spyHash).not.toHaveBeenCalled();
    expect(snap.local.get('a.md')?.contentHash).toBe(baseRec.contentHash);
  });

  test('touched but identical file keeps base hash and refreshes mtime', async () => {
    const { vault, dropbox, state, seed } = setup();
    await seed('a.md', 'same content');

    const beforeBase = (await state.loadBase()).get('a.md')!;
    const touched = vault.writeText('a.md', 'same content');
    expect(touched.mtime).toBeGreaterThan(beforeBase.mtime);

    const spyHash = vi.fn(contentHash);
    const snap = await takeSnapshot({
      local: vault,
      remote: dropbox.client(),
      state,
      filter: makeFilter(),
      hash: spyHash,
    });

    expect(spyHash).toHaveBeenCalledTimes(1);
    const afterBase = (await state.loadBase()).get('a.md')!;
    expect(afterBase.mtime).toBe(touched.mtime);
    expect(afterBase.contentHash).toBe(beforeBase.contentHash);
    expect(snap.base.get('a.md')?.mtime).toBe(touched.mtime);
    expect(snap.local.get('a.md')?.contentHash).toBe(beforeBase.contentHash);
    expect(await state.getBaseText('a.md')).toBe('same content');
  });

  test('first run lists all, later runs use stored cursor', async () => {
    const { vault, dropbox, state, seed } = setup();
    await seed('a.md', 'hello');

    const remote = dropbox.client();
    const listAllSpy = vi.spyOn(remote, 'listAll');
    const listChangesSpy = vi.spyOn(remote, 'listChanges');

    const snap1 = await takeSnapshot({
      local: vault,
      remote,
      state,
      filter: makeFilter(),
      hash: contentHash,
    });

    expect(listAllSpy).toHaveBeenCalledTimes(1);
    expect(listChangesSpy).toHaveBeenCalledTimes(0);
    expect(snap1.remoteReset).toBe(false);

    dropbox.writeText('b.md', 'second');

    const snap2 = await takeSnapshot({
      local: vault,
      remote,
      state,
      filter: makeFilter(),
      hash: contentHash,
    });

    expect(listAllSpy).toHaveBeenCalledTimes(1);
    expect(listChangesSpy).toHaveBeenCalledTimes(1);
    expect(snap2.remoteReset).toBe(false);
    expect(snap2.remote.has('b.md')).toBe(true);
  });

  test('cursor reset falls back to full listing', async () => {
    const { vault, dropbox, state, seed } = setup();
    await seed('a.md', 'one');

    await takeSnapshot({
      local: vault,
      remote: dropbox.client(),
      state,
      filter: makeFilter(),
      hash: contentHash,
    });

    dropbox.writeText('b.md', 'two');
    dropbox.expireCursors();

    const remote = dropbox.client();
    const listAllSpy = vi.spyOn(remote, 'listAll');
    const listChangesSpy = vi.spyOn(remote, 'listChanges');

    const snap = await takeSnapshot({
      local: vault,
      remote,
      state,
      filter: makeFilter(),
      hash: contentHash,
    });

    expect(listChangesSpy).toHaveBeenCalledTimes(1);
    expect(listAllSpy).toHaveBeenCalledTimes(1);
    expect(snap.remoteReset).toBe(true);
    expect(snap.remote.has('a.md')).toBe(true);
    expect(snap.remote.has('b.md')).toBe(true);
  });

  test('excluded path disappears from all views', async () => {
    const { vault, dropbox, state, seed } = setup();
    await seed('Archive/a.md', 'archived');
    await seed('keep.md', 'kept');

    const snap = await takeSnapshot({
      local: vault,
      remote: dropbox.client(),
      state,
      filter: makeFilter({ excludes: ['Archive/**'] }),
      hash: contentHash,
    });

    expect(snap.base.has('archive/a.md')).toBe(false);
    expect(snap.local.has('archive/a.md')).toBe(false);
    expect(snap.remote.has('archive/a.md')).toBe(false);
    expect(snap.skipped).toContain('archive/a.md');

    expect(snap.base.has('keep.md')).toBe(true);
    expect(snap.local.has('keep.md')).toBe(true);
    expect(snap.remote.has('keep.md')).toBe(true);

    // Underlying DB still preserves the record
    expect((await state.loadBase()).has('archive/a.md')).toBe(true);
    expect((await state.loadRemoteIndex()).has('archive/a.md')).toBe(true);
  });

  test('oversized local file is skipped on all sides', async () => {
    const { vault, dropbox, state, seed } = setup();
    await seed('big.pdf', 'small');

    await vault.write('big.pdf', new ArrayBuffer(60 * 1024 * 1024));

    const snap = await takeSnapshot({
      local: vault,
      remote: dropbox.client(),
      state,
      filter: makeFilter(),
      hash: contentHash,
    });

    expect(snap.base.has('big.pdf')).toBe(false);
    expect(snap.local.has('big.pdf')).toBe(false);
    expect(snap.remote.has('big.pdf')).toBe(false);
    expect(snap.skipped).toContain('big.pdf');
  });

  test('NFD local and NFC remote are one key', async () => {
    const { vault, dropbox, state } = setup();
    const nfd = 'Cafe\u0301.md';
    const nfc = 'Caf\u00e9.md';

    vault.writeText(nfd, 'coffee');
    dropbox.writeText(nfc, 'coffee');

    const snap = await takeSnapshot({
      local: vault,
      remote: dropbox.client(),
      state,
      filter: makeFilter(),
      hash: contentHash,
    });

    const key = toKey(nfc);
    expect(snap.local.size).toBe(1);
    expect(snap.remote.size).toBe(1);
    expect(snap.local.has(key)).toBe(true);
    expect(snap.remote.has(key)).toBe(true);
  });

  test('case collision is reported and skipped', async () => {
    const { vault, dropbox, state, seed } = setup();
    await seed('a.md', 'v1');

    vi.spyOn(vault, 'list').mockResolvedValue([
      { path: 'A.md', isFolder: false, size: 2, mtime: 1000 },
      { path: 'a.md', isFolder: false, size: 2, mtime: 1000 },
    ]);

    const snap = await takeSnapshot({
      local: vault,
      remote: dropbox.client(),
      state,
      filter: makeFilter(),
      hash: contentHash,
    });

    expect(snap.caseCollisions).toHaveLength(1);
    expect(snap.caseCollisions[0]).toEqual(expect.arrayContaining(['A.md', 'a.md']));
    expect(snap.local.has('a.md')).toBe(false);
    expect(snap.base.has('a.md')).toBe(false);
    expect(snap.remote.has('a.md')).toBe(false);
  });
});
