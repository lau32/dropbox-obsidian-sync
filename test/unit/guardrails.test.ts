import { describe, expect, test } from 'vitest';
import {
  guard,
  GuardContext,
  summarize,
  withoutDeletions,
} from '../../src/engine/guardrails';
import { Action } from '../../src/engine/planner';
import { Snapshot } from '../../src/engine/snapshot';
import { RemoteEntry } from '../../src/types';

const ctx = (p: Partial<GuardContext> = {}): GuardContext => ({
  baseCount: 1000,
  localCount: 1000,
  remoteCount: 1000,
  maxDeletes: 10,
  maxPercent: 10,
  ...p,
});

const dels = (n: number): Action[] =>
  Array.from(
    { length: n },
    (_, i) => ({ kind: 'deleteRemote', path: `f${i}.md`, rev: 'r' }) as Action,
  );

describe('guardrails', () => {
  test('10 deletes ok, 11 trips', () => {
    expect(guard(dels(10), ctx()).ok).toBe(true);
    expect(guard(dels(11), ctx())).toMatchObject({ ok: false, reason: 'massChange' });
  });

  test('percent threshold', () =>
    expect(guard(dels(6), ctx({ baseCount: 50 }))).toMatchObject({
      ok: false,
      reason: 'massChange',
    }));

  test('moves never trip', () =>
    expect(
      guard(
        Array.from(
          { length: 50 },
          (_, i) => ({ kind: 'moveRemote', from: `a/${i}`, to: `b/${i}` }) as Action,
        ),
        ctx(),
      ).ok,
    ).toBe(true));

  test('empty local with base trips', () =>
    expect(guard(dels(5), ctx({ localCount: 0 }))).toMatchObject({ reason: 'emptyLocal' }));

  test('empty remote with base trips', () =>
    expect(guard([], ctx({ remoteCount: 0 }))).toMatchObject({ reason: 'emptyRemote' }));

  test('first sync never trips', () =>
    expect(guard([], ctx({ baseCount: 0, localCount: 0 })).ok).toBe(true));

  test('withoutDeletions converts deleteLocal to upload add and drops deleteRemote without snap', () =>
    expect(
      withoutDeletions([
        { kind: 'deleteLocal', path: 'k.md' },
        ...dels(2),
        { kind: 'upload', path: 'x', mode: { kind: 'add' } },
      ]),
    ).toEqual([
      { kind: 'upload', path: 'x', mode: { kind: 'add' } },
      { kind: 'upload', path: 'k.md', mode: { kind: 'add' } },
    ]));

  test('withoutDeletions converts deleteRemote to download when snap has remote entry and drops rmdir/dropRecord', () => {
    const remoteEntry: RemoteEntry = {
      path: 'Note.md',
      isFolder: false,
      size: 10,
      rev: 'r1',
      contentHash: 'h1',
      serverModified: 1000,
    };
    const snap: Snapshot = {
      base: new Map(),
      local: new Map(),
      remote: new Map([['note.md', remoteEntry]]),
      skipped: [],
      caseCollisions: [],
      remoteReset: false,
    };
    const actions: Action[] = [
      { kind: 'deleteRemote', path: 'Note.md', rev: 'r1' },
      { kind: 'rmdirLocal', path: 'old-dir' },
      { kind: 'rmdirRemote', path: 'old-remote-dir' },
      { kind: 'dropRecord', path: 'gone.md' },
    ];
    expect(withoutDeletions(actions, snap)).toEqual([
      { kind: 'download', path: 'Note.md', remote: remoteEntry },
    ]);
  });

  test('summarize counts config overwrites and stores baseCount', () =>
    expect(
      summarize([{ kind: 'conflict', path: '.obsidian/app.json', strategy: 'newerWins' }], 42),
    ).toMatchObject({ baseCount: 42, configOverwrites: ['.obsidian/app.json'] }));

  test('configOverwrites count toward destructive threshold in guard', () => {
    const actions: Action[] = [
      ...dels(9),
      { kind: 'conflict', path: '.obsidian/app.json', strategy: 'newerWins' },
      { kind: 'conflict', path: '.obsidian/workspace.json', strategy: 'newerWins' },
    ];
    expect(guard(actions, ctx())).toMatchObject({ ok: false, reason: 'massChange' });
  });
});
