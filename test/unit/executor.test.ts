import { describe, expect, test } from 'vitest';
import { encodeText } from '../../src/bytes';
import { execute, ExecutorDeps } from '../../src/engine/executor';
import { plan } from '../../src/engine/planner';
import { takeSnapshot } from '../../src/engine/snapshot';
import {
  AuthError,
  InsufficientSpaceError,
  NetworkError,
  RevConflictError,
} from '../../src/errors';
import { FilterSettings, PathFilter } from '../../src/filter/PathFilter';
import { contentHash } from '../../src/hash/contentHash';
import { toKey } from '../../src/paths';
import { FakeDropbox } from '../fakes/FakeDropbox';
import { FakeVault } from '../fakes/FakeVault';
import { MemoryStateStore } from '../fakes/MemoryStateStore';

const defaultFilterSettings: FilterSettings = {
  configDir: '.obsidian',
  pluginDir: '.obsidian/plugins/dropbox-vault-sync',
  configSync: { core: true, themes: true, plugins: true, workspace: true },
  excludes: [],
  maxFileSizeBytes: 50 * 1024 * 1024,
};

function setup(filterPatch: Partial<FilterSettings> = {}) {
  let nowMs = 1000;
  const clock = () => (nowMs += 100);
  const vault = new FakeVault(clock);
  const dropbox = new FakeDropbox(clock);
  const state = new MemoryStateStore();
  const filter = new PathFilter({ ...defaultFilterSettings, ...filterPatch });
  const remote = dropbox.client();

  const deps: ExecutorDeps = {
    local: vault,
    remote,
    state,
    hash: contentHash,
    now: () => new Date(2026, 9, 13, 21, 42),
    deviceName: 'Test',
    configConflictDir: '.obsidian/plugins/dropbox-vault-sync/conflicts',
    baseTextCapBytes: 512 * 1024,
    downloadConcurrency: 4,
  };

  const seed = async (path: string, text: string) => {
    const lf = vault.writeText(path, text);
    const re = dropbox.writeText(path, text);
    const rec = {
      path,
      isFolder: false,
      size: lf.size,
      mtime: lf.mtime,
      contentHash: re.contentHash,
      rev: re.rev,
      serverModified: re.serverModified,
    };
    await state.commit(rec, text);
    return rec;
  };

  const snapAndPlan = async (renameHints: Array<{ from: string; to: string }> = []) => {
    const snap = await takeSnapshot({
      local: vault,
      remote,
      state,
      filter,
      hash: contentHash,
    });
    const actions = plan({
      snapshot: snap,
      renameHints,
      isConfigPath: (p) => filter.isConfigPath(p),
    });
    return { snap, actions };
  };

  return { vault, dropbox, state, filter, remote, deps, seed, snapAndPlan };
}

describe('executor', () => {
  test('upload commits record with remote rev and base text', async () => {
    const { vault, dropbox, state, deps, snapAndPlan } = setup();
    vault.writeText('a.md', 'hello world');

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    expect(res.fatal).toBeNull();
    expect(res.errors).toEqual([]);
    expect(dropbox.readText('a.md')).toBe('hello world');

    const base = await state.loadBase();
    const rec = base.get(toKey('a.md'));
    expect(rec).toBeDefined();
    expect(rec?.rev).toBe('r1');
    expect(rec?.size).toBe(11);
    expect(await state.getBaseText('a.md')).toBe('hello world');
  });

  test('rev conflict on upload defers and leaves record', async () => {
    const { vault, dropbox, state, deps, seed, snapAndPlan } = setup();
    const initialRec = await seed('a.md', 'v0');
    vault.writeText('a.md', 'v1');

    const { snap, actions } = await snapAndPlan();
    dropbox.failNext('upload', new RevConflictError('a.md'));

    const res = await execute(actions, snap, deps);

    expect(res.deferred).toEqual(['a.md']);
    expect(res.errors).toEqual([]);
    const base = await state.loadBase();
    expect(base.get(toKey('a.md'))).toEqual(initialRec);
    expect(await state.getBaseText('a.md')).toBe('v0');
  });

  test('download skipped when user edited during sync', async () => {
    const { vault, dropbox, deps, snapAndPlan } = setup();
    dropbox.writeText('a.md', 'from remote');

    const { snap, actions } = await snapAndPlan();
    vault.writeText('a.md', 'typing');

    const res = await execute(actions, snap, deps);

    expect(res.deferred).toEqual(['a.md']);
    expect(vault.readText('a.md')).toBe('typing');
  });

  test('clean merge writes merged text on both sides and as base', async () => {
    const { vault, dropbox, state, deps, seed, snapAndPlan } = setup();
    await seed('a.md', 'line1\nline2\nline3');
    vault.writeText('a.md', 'LOCAL1\nline2\nline3');
    dropbox.writeText('a.md', 'line1\nline2\nREMOTE3');

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    const expected = 'LOCAL1\nline2\nREMOTE3';
    expect(res.merged).toEqual(['a.md']);
    expect(vault.readText('a.md')).toBe(expected);
    expect(dropbox.readText('a.md')).toBe(expected);
    expect(await state.getBaseText('a.md')).toBe(expected);
  });

  test('merge without stored base uses downloadRev', async () => {
    const { vault, dropbox, state, deps, seed, snapAndPlan } = setup();
    const rec = await seed('a.md', 'line1\nline2\nline3');
    await state.commit(rec, null);
    expect(await state.getBaseText('a.md')).toBeNull();

    vault.writeText('a.md', 'LOCAL1\nline2\nline3');
    dropbox.writeText('a.md', 'line1\nline2\nREMOTE3');

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    const expected = 'LOCAL1\nline2\nREMOTE3';
    expect(res.merged).toEqual(['a.md']);
    expect(vault.readText('a.md')).toBe(expected);
    expect(dropbox.readText('a.md')).toBe(expected);
    expect(await state.getBaseText('a.md')).toBe(expected);
  });

  test('overlap keeps local at path and remote in conflict copy', async () => {
    const { vault, dropbox, state, deps, seed, snapAndPlan } = setup();
    await seed('n.md', 'base line');
    const localText = 'local edit on line';
    const remoteText = 'remote edit on line';
    vault.writeText('n.md', localText);
    dropbox.writeText('n.md', remoteText);

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    const copyPath = 'n (conflict 2026-10-13 2142 Test).md';
    expect(res.conflicts).toEqual([copyPath]);
    expect(vault.readText('n.md')).toBe(localText);
    expect(vault.readText(copyPath)).toBe(remoteText);
    expect(dropbox.readText('n.md')).toBe(localText);
    expect(dropbox.readText(copyPath)).toBe(remoteText);

    const base = await state.loadBase();
    expect(base.has(toKey('n.md'))).toBe(true);
    expect(base.has(toKey(copyPath))).toBe(true);
  });

  test('conflict copy disambiguates when same-minute copy already exists', async () => {
    const { vault, dropbox, deps, seed, snapAndPlan } = setup();
    const existingCopy = 'n (conflict 2026-10-13 2142 Test).md';
    await seed(existingCopy, 'earlier conflict');
    await seed('n.md', 'base');
    vault.writeText('n.md', 'local v2');
    dropbox.writeText('n.md', 'remote v2');

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    const secondCopy = 'n (conflict 2026-10-13 2142 Test 2).md';
    expect(res.conflicts).toEqual([secondCopy]);
    expect(vault.readText(existingCopy)).toBe('earlier conflict');
    expect(vault.readText(secondCopy)).toBe('remote v2');
    expect(dropbox.readText(secondCopy)).toBe('remote v2');
    expect(vault.readText('n.md')).toBe('local v2');
    expect(dropbox.readText('n.md')).toBe('local v2');
  });

  test('binary conflict copy naming', async () => {
    const { vault, dropbox, state, deps, seed, snapAndPlan } = setup();
    await seed('assets/pic.png', 'bin0');
    vault.writeText('assets/pic.png', 'bin-local');
    dropbox.writeText('assets/pic.png', 'bin-remote');

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    const copyPath = 'assets/pic (conflict 2026-10-13 2142 Test).png';
    expect(res.conflicts).toEqual([copyPath]);
    expect(vault.readText('assets/pic.png')).toBe('bin-local');
    expect(vault.readText(copyPath)).toBe('bin-remote');
    expect(dropbox.readText('assets/pic.png')).toBe('bin-local');
    expect(dropbox.readText(copyPath)).toBe('bin-remote');
    expect(await state.getBaseText('assets/pic.png')).toBeNull();
    expect(await state.getBaseText(copyPath)).toBeNull();
  });

  test('config newerWins: remote newer overwrites local and keeps loser in plugin conflicts dir', async () => {
    const { vault, dropbox, deps, seed, snapAndPlan } = setup();
    await seed('.obsidian/app.json', '{"v":0}');
    const localText = '{"v":1}';
    const remoteText = '{"v":2}';
    vault.writeText('.obsidian/app.json', localText);
    dropbox.writeText('.obsidian/app.json', remoteText);

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    const loserPath =
      '.obsidian/plugins/dropbox-vault-sync/conflicts/.obsidian/app (conflict 2026-10-13 2142 Test).json';
    expect(res.errors).toEqual([]);
    expect(vault.readText('.obsidian/app.json')).toBe(remoteText);
    expect(dropbox.readText('.obsidian/app.json')).toBe(remoteText);
    expect(vault.readText(loserPath)).toBe(localText);
    expect(vault.paths()).toEqual(['.obsidian/app.json', loserPath].sort());
    expect(dropbox.paths()).toEqual(['.obsidian/app.json']);
  });

  test('deleteLocal trashes and removes record', async () => {
    const { vault, remote, state, deps, seed, snapAndPlan } = setup();
    await seed('a.md', 'goodbye');
    await remote.delete('a.md', null);

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    expect(res.errors).toEqual([]);
    expect(vault.readText('a.md')).toBeUndefined();
    expect(vault.trashed).toEqual(['a.md']);
    expect((await state.loadBase()).has(toKey('a.md'))).toBe(false);
    expect(await state.getBaseText('a.md')).toBeNull();
  });

  test('network error stops run; earlier actions stay committed', async () => {
    const { vault, dropbox, state, deps, snapAndPlan } = setup();
    vault.writeText('a.md', 'first');
    vault.writeText('b.md', 'second');
    vault.writeText('c.md', 'third');

    const { snap, actions } = await snapAndPlan();
    dropbox.beforeWrite((path) => {
      if (path === 'a.md') {
        dropbox.failNext('upload', new NetworkError());
      }
    });

    const res = await execute(actions, snap, deps);

    expect(res.fatal).toBe('offline');
    const base = await state.loadBase();
    expect(base.has(toKey('a.md'))).toBe(true);
    expect(base.has(toKey('b.md'))).toBe(false);
    expect(base.has(toKey('c.md'))).toBe(false);
  });

  test('insufficient space defers later uploads, downloads continue', async () => {
    const { vault, dropbox, state, deps, snapAndPlan } = setup();
    vault.writeText('a.md', 'up1');
    vault.writeText('b.md', 'up2');
    dropbox.writeText('c.md', 'down1');

    const { snap, actions } = await snapAndPlan();
    dropbox.failNext('upload', new InsufficientSpaceError());

    const res = await execute(actions, snap, deps);

    expect(res.fatal).toBeNull();
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].path).toBe('a.md');
    expect(res.deferred).toEqual(['b.md']);
    expect(vault.readText('c.md')).toBe('down1');
    expect((await state.loadBase()).has(toKey('c.md'))).toBe(true);
  });

  test('large markdown has no stored base text', async () => {
    const { vault, state, deps, snapAndPlan } = setup();
    const twoMb = 'x'.repeat(2 * 1024 * 1024);
    await vault.write('big.md', encodeText(twoMb));

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    expect(res.errors).toEqual([]);
    expect((await state.loadBase()).has(toKey('big.md'))).toBe(true);
    expect(await state.getBaseText('big.md')).toBeNull();
  });

  test('moves, folders, skip, and auth error handling', async () => {
    const { vault, dropbox, state, deps, seed, snapAndPlan } = setup();
    await seed('old.md', 'move me');
    vault.renameUser('old.md', 'new.md');
    await vault.mkdir('folderA');

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    expect(res.errors).toEqual([]);
    expect(dropbox.readText('old.md')).toBeUndefined();
    expect(dropbox.readText('new.md')).toBe('move me');
    const base = await state.loadBase();
    expect(base.has(toKey('old.md'))).toBe(false);
    expect(base.has(toKey('new.md'))).toBe(true);
    expect(base.get(toKey('folderA'))?.isFolder).toBe(true);

    // Test skip and AuthError
    dropbox.failNext('upload', new AuthError());
    const res2 = await execute(
      [
        { kind: 'skip', path: 'bad.md', reason: 'type mismatch' },
        { kind: 'upload', path: 'new.md', mode: { kind: 'add' } },
      ],
      snap,
      deps,
    );
    expect(res2.errors).toEqual([{ path: 'bad.md', message: 'type mismatch' }]);
    expect(res2.fatal).toBe('auth');
  });

  test('download pool respects downloadConcurrency and reports progress', async () => {
    const { vault, dropbox, deps, snapAndPlan } = setup();
    for (let i = 0; i < 6; i++) {
      dropbox.writeText(`f${i}.md`, `content ${i}`);
    }

    const { snap, actions } = await snapAndPlan();
    let active = 0;
    let maxActive = 0;
    const origDownload = deps.remote.download.bind(deps.remote);
    deps.remote.download = async (path: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      try {
        return await origDownload(path);
      } finally {
        active--;
      }
    };

    const progress: Array<[number, number]> = [];
    const res = await execute(
      actions,
      snap,
      { ...deps, downloadConcurrency: 2 },
      (done, total) => progress.push([done, total]),
    );

    expect(res.errors).toEqual([]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);
    expect(progress).toHaveLength(6);
    expect(progress[progress.length - 1]).toEqual([6, 6]);
    for (let i = 0; i < 6; i++) {
      expect(vault.readText(`f${i}.md`)).toBe(`content ${i}`);
    }
  });

  test('rmdirRemote skips non-empty prefix and deletes empty; rmdirLocal and record work', async () => {
    const { vault, dropbox, remote, state, deps, seed, snapAndPlan } = setup();
    await seed('dirA/keep.md', 'stay');
    await state.commit({
      path: 'dirA',
      isFolder: true,
      size: 0,
      mtime: 1000,
      contentHash: null,
      rev: null,
      serverModified: null,
    });
    await remote.createFolder('dirA');

    await state.commit({
      path: 'dirEmpty',
      isFolder: true,
      size: 0,
      mtime: 1000,
      contentHash: null,
      rev: null,
      serverModified: null,
    });
    await remote.createFolder('dirEmpty');

    // Equal content on both sides without base -> record
    vault.writeText('same.md', 'identical');
    dropbox.writeText('same.md', 'identical');

    const { snap, actions } = await snapAndPlan();
    const res = await execute(actions, snap, deps);

    expect(res.errors).toEqual([]);
    const base = await state.loadBase();
    // dirA still has dirA/keep.md under it so rmdirRemote should not remove dirA
    expect(base.has(toKey('dirA'))).toBe(true);
    // dirEmpty has no children so rmdirRemote removes it
    expect(base.has(toKey('dirEmpty'))).toBe(false);
    // same.md was recorded with baseText
    expect(base.has(toKey('same.md'))).toBe(true);
    expect(await state.getBaseText('same.md')).toBe('identical');
  });
});

