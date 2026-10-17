import { CursorResetError } from '../errors';
import { PathFilter } from '../filter/PathFilter';
import { Hasher } from '../hash/contentHash';
import { LocalStore } from '../local/LocalStore';
import { toKey } from '../paths';
import { RemoteStore } from '../remote/RemoteStore';
import { StateStore } from '../state/StateStore';
import { BaseRecord, LocalFile, RemoteChange, RemoteEntry } from '../types';

export interface LocalItem extends LocalFile {
  contentHash: string | null; // null for folders
}

export interface Snapshot {
  base: Map<string, BaseRecord>;
  local: Map<string, LocalItem>;
  remote: Map<string, RemoteEntry>;
  skipped: string[];
  caseCollisions: string[][];
  remoteReset: boolean;
}

export interface SnapshotDeps {
  local: LocalStore;
  remote: RemoteStore;
  state: StateStore;
  filter: PathFilter;
  hash: Hasher;
}

export async function takeSnapshot(deps: SnapshotDeps): Promise<Snapshot> {
  const { local, remote, state, filter, hash } = deps;

  const meta = await state.getMeta();
  let remoteReset = false;

  const syncFullRemote = async (): Promise<void> => {
    const { entries, cursor } = await remote.listAll();
    const upserts: RemoteChange[] = entries.map((entry) => ({
      kind: 'upsert',
      entry,
    }));
    await state.applyRemoteChanges(upserts, cursor, true);
  };

  if (meta.cursor === null) {
    await syncFullRemote();
  } else {
    try {
      const { changes, cursor } = await remote.listChanges(meta.cursor);
      await state.applyRemoteChanges(changes, cursor, false);
    } catch (err) {
      if (err instanceof CursorResetError) {
        remoteReset = true;
        await syncFullRemote();
      } else {
        throw err;
      }
    }
  }

  const remoteView = await state.loadRemoteIndex();
  const baseView = await state.loadBase();

  const localFiles = await local.list();
  const groups = new Map<string, LocalFile[]>();
  for (const file of localFiles) {
    const key = toKey(file.path);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(file);
  }

  const caseCollisions: string[][] = [];
  const localCandidates = new Map<string, LocalFile>();

  for (const [key, group] of groups.entries()) {
    if (group.length > 1) {
      caseCollisions.push(group.map((f) => f.path));
      baseView.delete(key);
      remoteView.delete(key);
    } else {
      localCandidates.set(key, group[0]);
    }
  }

  const allKeys = new Set<string>([
    ...baseView.keys(),
    ...localCandidates.keys(),
    ...remoteView.keys(),
  ]);
  const skipped: string[] = [];

  for (const key of allKeys) {
    const b = baseView.get(key);
    const l = localCandidates.get(key);
    const r = remoteView.get(key);
    const sides = [b, l, r].filter(
      (s): s is BaseRecord | LocalFile | RemoteEntry => s !== undefined,
    );

    const isSkipped = sides.some(
      (s) => !filter.isPathSynced(s.path, s.isFolder) || !filter.isSizeAllowed(s.size),
    );

    if (isSkipped) {
      skipped.push(key);
      baseView.delete(key);
      localCandidates.delete(key);
      remoteView.delete(key);
    }
  }

  const localView = new Map<string, LocalItem>();
  for (const [key, file] of localCandidates.entries()) {
    if (file.isFolder) {
      localView.set(key, { ...file, contentHash: null });
      continue;
    }

    const baseRec = baseView.get(key);
    if (
      baseRec &&
      !baseRec.isFolder &&
      baseRec.contentHash !== null &&
      file.size === baseRec.size &&
      file.mtime === baseRec.mtime
    ) {
      localView.set(key, { ...file, contentHash: baseRec.contentHash });
      continue;
    }

    const data = await local.read(file.path);
    const fileHash = await hash(data);

    if (baseRec && !baseRec.isFolder && fileHash === baseRec.contentHash) {
      const updatedBase: BaseRecord = { ...baseRec, mtime: file.mtime };
      await state.commit(updatedBase);
      baseView.set(key, updatedBase);
    }

    localView.set(key, { ...file, contentHash: fileHash });
  }

  return {
    base: baseView,
    local: localView,
    remote: remoteView,
    skipped,
    caseCollisions,
    remoteReset,
  };
}
