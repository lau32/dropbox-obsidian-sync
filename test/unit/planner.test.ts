import { describe, expect, test } from 'vitest';
import { plan, PlanInput } from '../../src/engine/planner';
import { LocalItem, Snapshot } from '../../src/engine/snapshot';
import { toKey } from '../../src/paths';
import { BaseRecord, RemoteEntry } from '../../src/types';

interface EntrySpec {
  base?: string;
  local?: string;
  remote?: string;
  basePath?: string;
  localPath?: string;
  remotePath?: string;
  baseRev?: string;
  remoteRev?: string;
  folder?: boolean;
}

/**
 * Builds a PlanInput from a concise path-keyed spec.
 * Note: When `folder: true` and `local` holds a real hash (not `'f'`),
 * only the non-local (`'f'`) side is marked as a folder so file-vs-folder
 * type mismatch at one key can be tested.
 */
function snap(
  spec: Record<string, EntrySpec>,
  hints: Array<{ from: string; to: string }> = [],
): PlanInput {
  const base = new Map<string, BaseRecord>();
  const local = new Map<string, LocalItem>();
  const remote = new Map<string, RemoteEntry>();

  for (const [rawPath, s] of Object.entries(spec)) {
    const key = toKey(rawPath);

    if (s.base !== undefined) {
      const isFolder = Boolean(s.folder && s.base === 'f');
      base.set(key, {
        path: s.basePath ?? rawPath,
        isFolder,
        size: isFolder ? 0 : 10,
        mtime: 1000,
        contentHash: isFolder ? null : s.base,
        rev: isFolder ? null : (s.baseRev ?? `r-${s.base}`),
        serverModified: isFolder ? null : 1000,
      });
    }

    if (s.local !== undefined) {
      const isFolder = Boolean(s.folder && s.local === 'f');
      local.set(key, {
        path: s.localPath ?? rawPath,
        isFolder,
        size: isFolder ? 0 : 10,
        mtime: 1000,
        contentHash: isFolder ? null : s.local,
      });
    }

    if (s.remote !== undefined) {
      const isFolder = Boolean(s.folder && s.remote === 'f');
      remote.set(key, {
        path: s.remotePath ?? rawPath,
        isFolder,
        size: isFolder ? 0 : 10,
        rev: isFolder ? null : (s.remoteRev ?? `r-${s.remote}`),
        contentHash: isFolder ? null : s.remote,
        serverModified: isFolder ? null : 1000,
      });
    }
  }

  const snapshot: Snapshot = {
    base,
    local,
    remote,
    skipped: [],
    caseCollisions: [],
    remoteReset: false,
  };

  return {
    snapshot,
    renameHints: hints,
    isConfigPath: (p: string) => p.startsWith('.obsidian/'),
  };
}

function one(s: EntrySpec, path = 'n.md'): string[] {
  return plan(snap({ [path]: s })).map((a) => a.kind);
}

describe('planner', () => {
  test.each([
    [{ local: 'h1' }, ['upload']],
    [{ remote: 'h1' }, ['download']],
    [{ local: 'h1', remote: 'h1' }, ['record']],
    [{ local: 'h1', remote: 'h2' }, ['conflict']],
    [{ base: 'h0', local: 'h1', remote: 'h0' }, ['upload']],
    [{ base: 'h0', local: 'h0', remote: 'h1' }, ['download']],
    [{ base: 'h0', local: 'h1', remote: 'h1' }, ['record']],
    [{ base: 'h0', local: 'h1', remote: 'h2' }, ['merge']],
    [{ base: 'h0', remote: 'h0' }, ['deleteRemote']],
    [{ base: 'h0', local: 'h0' }, ['deleteLocal']],
    [{ base: 'h0', remote: 'h1' }, ['download']],
    [{ base: 'h0', local: 'h1' }, ['upload']],
    [{ base: 'h0' }, ['dropRecord']],
    [{ base: 'h0', local: 'h0', remote: 'h0' }, []],
  ])('%o → %o', (s, kinds) => expect(one(s)).toEqual(kinds));

  test('binary both changed → conflict copy', () =>
    expect(plan(snap({ 'p.png': { base: 'h0', local: 'h1', remote: 'h2' } }))[0]).toMatchObject({
      kind: 'conflict',
      strategy: 'copy',
    }));

  test('config both changed → newerWins', () =>
    expect(
      plan(snap({ '.obsidian/app.json': { base: 'h0', local: 'h1', remote: 'h2' } }))[0],
    ).toMatchObject({ strategy: 'newerWins' }));

  test('upload over remote uses remote rev', () =>
    expect(
      plan(
        snap({ 'n.md': { base: 'h0', baseRev: 'r0', local: 'h1', remote: 'h0', remoteRev: 'r5' } }),
      )[0],
    ).toMatchObject({ kind: 'upload', mode: { kind: 'update', rev: 'r5' } }));

  test('local rename is one moveRemote', () =>
    expect(plan(snap({ 'a.md': { base: 'h0', remote: 'h0' }, 'b.md': { local: 'h0' } }))).toEqual([
      { kind: 'moveRemote', from: 'a.md', to: 'b.md' },
    ]));

  test('remote rename is one moveLocal', () =>
    expect(plan(snap({ 'a.md': { base: 'h0', local: 'h0' }, 'b.md': { remote: 'h0' } }))).toEqual([
      { kind: 'moveLocal', from: 'a.md', to: 'b.md' },
    ]));

  test('case-only rename locally produces moveRemote', () =>
    expect(
      plan(
        snap({
          'note.md': {
            base: 'h0',
            local: 'h0',
            remote: 'h0',
            basePath: 'note.md',
            remotePath: 'note.md',
            localPath: 'Note.md',
          },
        }),
      ),
    ).toEqual([{ kind: 'moveRemote', from: 'note.md', to: 'Note.md' }]));

  test('case-only rename remotely produces moveLocal', () =>
    expect(
      plan(
        snap({
          'note.md': {
            base: 'h0',
            local: 'h0',
            remote: 'h0',
            basePath: 'note.md',
            localPath: 'note.md',
            remotePath: 'Note.md',
          },
        }),
      ),
    ).toEqual([{ kind: 'moveLocal', from: 'note.md', to: 'Note.md' }]));

  test('folder rename of 20 files → 20 moves, 0 deletes', () => {
    const s: Parameters<typeof snap>[0] = {};
    for (let i = 0; i < 20; i++) {
      s[`old/${i}.md`] = { base: `h${i}`, remote: `h${i}` };
      s[`new/${i}.md`] = { local: `h${i}` };
    }
    const kinds = plan(snap(s)).map((a) => a.kind);
    expect(kinds.filter((k) => k === 'moveRemote')).toHaveLength(20);
    expect(kinds).not.toContain('deleteRemote');
  });

  test('ambiguous equal hashes pair only via hints', () => {
    const s = {
      'a.md': { base: 'h0', remote: 'h0' },
      'b.md': { base: 'h0', remote: 'h0' },
      'c.md': { local: 'h0' },
      'd.md': { local: 'h0' },
    };
    expect(
      plan(snap(s))
        .map((a) => a.kind)
        .sort(),
    ).toEqual(['deleteRemote', 'deleteRemote', 'upload', 'upload']);
    expect(
      plan(
        snap(s, [
          { from: 'a.md', to: 'c.md' },
          { from: 'b.md', to: 'd.md' },
        ]),
      ),
    ).toEqual([
      { kind: 'moveRemote', from: 'a.md', to: 'c.md' },
      { kind: 'moveRemote', from: 'b.md', to: 'd.md' },
    ]);
  });

  test('ordering: deletes after transfers, rmdir deepest first', () => {
    const kinds = plan(
      snap({
        'x.md': { base: 'h0', remote: 'h0' },
        'y.md': { local: 'h9' },
        d: { base: 'f', remote: 'f', folder: true },
        'd/e': { base: 'f', remote: 'f', folder: true },
      }),
    ).map((a) => (a.kind === 'rmdirRemote' ? `rmdir:${a.path}` : a.kind));
    expect(kinds).toEqual(['upload', 'deleteRemote', 'rmdir:d/e', 'rmdir:d']);
  });

  test('file vs folder at one key → skip', () =>
    expect(one({ local: 'h1', remote: 'f', folder: true })).toEqual(['skip']));

  test('folder creation and ordering shallowest first', () => {
    const actions = plan(
      snap({
        'a/b': { local: 'f', folder: true },
        a: { local: 'f', folder: true },
        'x/y': { remote: 'f', folder: true },
        x: { remote: 'f', folder: true },
      }),
    );
    expect(actions).toEqual([
      { kind: 'mkdirRemote', path: 'a' },
      { kind: 'mkdirLocal', path: 'x' },
      { kind: 'mkdirRemote', path: 'a/b' },
      { kind: 'mkdirLocal', path: 'x/y' },
    ]);
  });
});
