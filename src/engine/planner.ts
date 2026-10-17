import { isMarkdown, parentDir, toKey } from '../paths';
import { RemoteEntry, WriteMode } from '../types';
import { LocalItem, Snapshot } from './snapshot';

export type Action =
  | { kind: 'mkdirLocal'; path: string }
  | { kind: 'mkdirRemote'; path: string }
  | { kind: 'moveRemote'; from: string; to: string }
  | { kind: 'moveLocal'; from: string; to: string }
  | { kind: 'upload'; path: string; mode: WriteMode }
  | { kind: 'download'; path: string; remote: RemoteEntry }
  | { kind: 'record'; path: string } // equal content, refresh record
  | { kind: 'merge'; path: string }
  | { kind: 'conflict'; path: string; strategy: 'copy' | 'newerWins' }
  | { kind: 'deleteRemote'; path: string; rev: string | null }
  | { kind: 'deleteLocal'; path: string }
  | { kind: 'dropRecord'; path: string }
  | { kind: 'rmdirLocal'; path: string }
  | { kind: 'rmdirRemote'; path: string }
  | { kind: 'skip'; path: string; reason: string };

export interface PlanInput {
  snapshot: Snapshot;
  renameHints: Array<{ from: string; to: string }>;
  isConfigPath: (p: string) => boolean;
}

interface LocalDeleteCandidate {
  key: string;
  remote: RemoteEntry;
  hash: string | null;
}

interface LocalCreateCandidate {
  key: string;
  local: LocalItem;
  hash: string | null;
}

interface RemoteDeleteCandidate {
  key: string;
  local: LocalItem;
  hash: string | null;
}

interface RemoteCreateCandidate {
  key: string;
  remote: RemoteEntry;
  hash: string | null;
}

function pathDepth(path: string): number {
  let depth = 0;
  let cur = parentDir(path);
  while (cur !== '') {
    depth++;
    cur = parentDir(cur);
  }
  return depth;
}

function pairByHashAndHints<
  D extends { key: string; hash: string | null },
  C extends { key: string; hash: string | null },
>(
  deletes: D[],
  creates: C[],
  hints: Array<{ from: string; to: string }>,
): {
  pairs: Array<{ del: D; create: C }>;
  unpairedDeletes: D[];
  unpairedCreates: C[];
} {
  const deletesByHash = new Map<string, D[]>();
  const createsByHash = new Map<string, C[]>();

  for (const d of deletes) {
    if (d.hash === null) continue;
    let group = deletesByHash.get(d.hash);
    if (!group) {
      group = [];
      deletesByHash.set(d.hash, group);
    }
    group.push(d);
  }

  for (const c of creates) {
    if (c.hash === null) continue;
    let group = createsByHash.get(c.hash);
    if (!group) {
      group = [];
      createsByHash.set(c.hash, group);
    }
    group.push(c);
  }

  const pairedDeletes = new Set<string>();
  const pairedCreates = new Set<string>();
  const pairs: Array<{ del: D; create: C }> = [];

  for (const [hash, dGroup] of deletesByHash.entries()) {
    const cGroup = createsByHash.get(hash);
    if (!cGroup || cGroup.length === 0) continue;

    if (dGroup.length === 1 && cGroup.length === 1) {
      pairedDeletes.add(dGroup[0].key);
      pairedCreates.add(cGroup[0].key);
      pairs.push({ del: dGroup[0], create: cGroup[0] });
    } else {
      for (const hint of hints) {
        const fromKey = toKey(hint.from);
        const toKeyVal = toKey(hint.to);
        const dMatch = dGroup.find((d) => d.key === fromKey && !pairedDeletes.has(d.key));
        const cMatch = cGroup.find((c) => c.key === toKeyVal && !pairedCreates.has(c.key));
        if (dMatch && cMatch) {
          pairedDeletes.add(dMatch.key);
          pairedCreates.add(cMatch.key);
          pairs.push({ del: dMatch, create: cMatch });
        }
      }
    }
  }

  return {
    pairs,
    unpairedDeletes: deletes.filter((d) => !pairedDeletes.has(d.key)),
    unpairedCreates: creates.filter((c) => !pairedCreates.has(c.key)),
  };
}

export function plan(input: PlanInput): Action[] {
  const { snapshot, renameHints, isConfigPath } = input;

  const allKeys = Array.from(
    new Set<string>([
      ...snapshot.base.keys(),
      ...snapshot.local.keys(),
      ...snapshot.remote.keys(),
    ]),
  ).sort();

  const mkdirs: Array<Extract<Action, { kind: 'mkdirLocal' | 'mkdirRemote' }>> = [];
  const moves: Array<Extract<Action, { kind: 'moveRemote' | 'moveLocal' }>> = [];
  const transfers: Array<Extract<Action, { kind: 'upload' | 'download' | 'record' }>> = [];
  const conflicts: Array<Extract<Action, { kind: 'merge' | 'conflict' }>> = [];
  const deletes: Array<Extract<Action, { kind: 'deleteLocal' | 'deleteRemote' }>> = [];
  const drops: Array<Extract<Action, { kind: 'dropRecord' }>> = [];
  const rmdirs: Array<Extract<Action, { kind: 'rmdirLocal' | 'rmdirRemote' }>> = [];
  const skips: Array<Extract<Action, { kind: 'skip' }>> = [];

  const localDeletes: LocalDeleteCandidate[] = [];
  const localCreates: LocalCreateCandidate[] = [];
  const remoteDeletes: RemoteDeleteCandidate[] = [];
  const remoteCreates: RemoteCreateCandidate[] = [];

  for (const key of allKeys) {
    const b = snapshot.base.get(key);
    const l = snapshot.local.get(key);
    const r = snapshot.remote.get(key);

    const present = [b, l, r].filter(
      (item): item is NonNullable<typeof item> => item !== undefined,
    );
    if (present.length === 0) continue;

    const hasFolder = present.some((item) => item.isFolder);
    const hasFile = present.some((item) => !item.isFolder);

    if (hasFolder && hasFile) {
      const displayPath = l?.path ?? r?.path ?? b!.path;
      skips.push({ kind: 'skip', path: displayPath, reason: 'type mismatch' });
      continue;
    }

    if (hasFolder) {
      if (!b && l && !r) {
        mkdirs.push({ kind: 'mkdirRemote', path: l.path });
      } else if (!b && !l && r) {
        mkdirs.push({ kind: 'mkdirLocal', path: r.path });
      } else if (!b && l && r) {
        transfers.push({ kind: 'record', path: l.path });
      } else if (b && !l && r) {
        rmdirs.push({ kind: 'rmdirRemote', path: r.path });
      } else if (b && l && !r) {
        rmdirs.push({ kind: 'rmdirLocal', path: l.path });
      } else if (b && !l && !r) {
        drops.push({ kind: 'dropRecord', path: b.path });
      } else if (b && l && r) {
        if (l.path !== b.path && r.path === b.path) {
          moves.push({ kind: 'moveRemote', from: b.path, to: l.path });
        } else if (r.path !== b.path && l.path === b.path) {
          moves.push({ kind: 'moveLocal', from: b.path, to: r.path });
        }
      }
      continue;
    }

    // All present sides are files
    if (!b && l && !r) {
      localCreates.push({ key, local: l, hash: l.contentHash });
    } else if (!b && !l && r) {
      remoteCreates.push({ key, remote: r, hash: r.contentHash });
    } else if (!b && l && r) {
      if (l.contentHash !== null && l.contentHash === r.contentHash) {
        transfers.push({ kind: 'record', path: l.path });
      } else {
        conflicts.push({
          kind: 'conflict',
          path: l.path,
          strategy: isConfigPath(l.path) ? 'newerWins' : 'copy',
        });
      }
    } else if (b && !l && !r) {
      drops.push({ kind: 'dropRecord', path: b.path });
    } else if (b && !l && r) {
      const remoteChanged = r.contentHash !== b.contentHash;
      if (!remoteChanged) {
        localDeletes.push({ key, remote: r, hash: r.contentHash });
      } else {
        transfers.push({ kind: 'download', path: r.path, remote: r });
      }
    } else if (b && l && !r) {
      const localChanged = l.contentHash !== b.contentHash;
      if (!localChanged) {
        remoteDeletes.push({ key, local: l, hash: l.contentHash });
      } else {
        transfers.push({ kind: 'upload', path: l.path, mode: { kind: 'add' } });
      }
    } else if (b && l && r) {
      const localChanged = l.contentHash !== b.contentHash;
      const remoteChanged = r.contentHash !== b.contentHash;

      if (!localChanged && !remoteChanged) {
        if (l.path !== b.path && r.path === b.path) {
          moves.push({ kind: 'moveRemote', from: b.path, to: l.path });
        } else if (r.path !== b.path && l.path === b.path) {
          moves.push({ kind: 'moveLocal', from: b.path, to: r.path });
        }
      } else if (localChanged && !remoteChanged) {
        const mode: WriteMode = r.rev ? { kind: 'update', rev: r.rev } : { kind: 'add' };
        transfers.push({ kind: 'upload', path: l.path, mode });
      } else if (!localChanged && remoteChanged) {
        transfers.push({ kind: 'download', path: r.path, remote: r });
      } else {
        // Both changed
        if (l.contentHash !== null && l.contentHash === r.contentHash) {
          transfers.push({ kind: 'record', path: l.path });
        } else if (isConfigPath(l.path)) {
          conflicts.push({ kind: 'conflict', path: l.path, strategy: 'newerWins' });
        } else if (isMarkdown(l.path)) {
          conflicts.push({ kind: 'merge', path: l.path });
        } else {
          conflicts.push({ kind: 'conflict', path: l.path, strategy: 'copy' });
        }
      }
    }
  }

  // Pair local renames (delete + create on local side -> moveRemote)
  const localPaired = pairByHashAndHints(localDeletes, localCreates, renameHints);
  for (const { del, create } of localPaired.pairs) {
    moves.push({ kind: 'moveRemote', from: del.remote.path, to: create.local.path });
  }
  for (const del of localPaired.unpairedDeletes) {
    deletes.push({ kind: 'deleteRemote', path: del.remote.path, rev: del.remote.rev });
  }
  for (const create of localPaired.unpairedCreates) {
    transfers.push({ kind: 'upload', path: create.local.path, mode: { kind: 'add' } });
  }

  // Pair remote renames (delete + create on remote side -> moveLocal)
  const remotePaired = pairByHashAndHints(remoteDeletes, remoteCreates, renameHints);
  for (const { del, create } of remotePaired.pairs) {
    moves.push({ kind: 'moveLocal', from: del.local.path, to: create.remote.path });
  }
  for (const del of remotePaired.unpairedDeletes) {
    deletes.push({ kind: 'deleteLocal', path: del.local.path });
  }
  for (const create of remotePaired.unpairedCreates) {
    transfers.push({ kind: 'download', path: create.remote.path, remote: create.remote });
  }

  mkdirs.sort((a, b) => pathDepth(a.path) - pathDepth(b.path) || a.path.localeCompare(b.path));
  rmdirs.sort((a, b) => pathDepth(b.path) - pathDepth(a.path) || a.path.localeCompare(b.path));

  return [
    ...mkdirs,
    ...moves,
    ...transfers,
    ...conflicts,
    ...deletes,
    ...drops,
    ...rmdirs,
    ...skips,
  ];
}
