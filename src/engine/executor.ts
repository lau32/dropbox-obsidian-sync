import { decodeText, encodeText } from '../bytes';
import {
  AuthError,
  InsufficientSpaceError,
  NetworkError,
  NotFoundError,
  RevConflictError,
} from '../errors';
import { Hasher } from '../hash/contentHash';
import { LocalStore } from '../local/LocalStore';
import { merge3 } from '../merge/merge3';
import { conflictName, isMarkdown, toKey } from '../paths';
import { RemoteStore } from '../remote/RemoteStore';
import { StateStore } from '../state/StateStore';
import { BaseRecord, RemoteEntry, WriteMode } from '../types';
import { Action } from './planner';
import { Snapshot } from './snapshot';

export interface ExecutorDeps {
  local: LocalStore;
  remote: RemoteStore;
  state: StateStore;
  hash: Hasher;
  now: () => Date;
  deviceName: string;
  configConflictDir: string;
  baseTextCapBytes: number;
  downloadConcurrency: number;
}

export interface RunResult {
  applied: Action[];
  merged: string[];
  conflicts: string[];
  deferred: string[];
  errors: Array<{ path: string; message: string }>;
  fatal: null | 'offline' | 'auth';
}

function actionPath(action: Action): string {
  switch (action.kind) {
    case 'moveLocal':
    case 'moveRemote':
      return action.to;
    default:
      return action.path;
  }
}

function withConflictSuffix(baseCopyPath: string, index: number): string {
  if (index <= 1) {
    return baseCopyPath;
  }
  const closeParen = baseCopyPath.lastIndexOf(')');
  if (closeParen === -1) {
    return `${baseCopyPath} ${index}`;
  }
  return `${baseCopyPath.slice(0, closeParen)} ${index}${baseCopyPath.slice(closeParen)}`;
}

export async function execute(
  actions: Action[],
  snap: Snapshot,
  deps: ExecutorDeps,
  onProgress?: (done: number, total: number) => void,
): Promise<RunResult> {
  const result: RunResult = {
    applied: [],
    merged: [],
    conflicts: [],
    deferred: [],
    errors: [],
    fatal: null,
  };

  let spaceExhausted = false;
  let done = 0;
  const total = actions.length;

  const commitFile = async (
    path: string,
    data: ArrayBuffer,
    mtime: number,
    entry: RemoteEntry,
  ): Promise<void> => {
    const contentHash = entry.contentHash ?? (await deps.hash(data));
    const text =
      isMarkdown(path) && data.byteLength <= deps.baseTextCapBytes
        ? decodeText(data)
        : null;
    const rec: BaseRecord = {
      path,
      isFolder: false,
      size: data.byteLength,
      mtime,
      contentHash,
      rev: entry.rev,
      serverModified: entry.serverModified,
    };
    await deps.state.commit(rec, text);
  };

  const commitFolder = async (path: string, mtime: number): Promise<void> => {
    const rec: BaseRecord = {
      path,
      isFolder: true,
      size: 0,
      mtime,
      contentHash: null,
      rev: null,
      serverModified: null,
    };
    await deps.state.commit(rec, null);
  };

  const executeConflictCopy = async (
    action: Action,
    path: string,
    prefetchedRemote?: { data: ArrayBuffer; entry: RemoteEntry },
  ): Promise<void> => {
    if (spaceExhausted) {
      result.deferred.push(path);
      return;
    }

    const { data: remoteData, entry: remoteEntry } =
      prefetchedRemote ?? (await deps.remote.download(path));

    const baseCopyPath = conflictName(path, deps.now(), deps.deviceName);
    const copyMtime = remoteEntry.serverModified ?? deps.now().getTime();
    let idx = 1;
    let copyPath: string;
    let uploadedCopy: RemoteEntry;

    while (true) {
      const candidate = withConflictSuffix(baseCopyPath, idx);
      const existsLocal = (await deps.local.stat(candidate)) !== null;
      const existsRemoteSnap = snap.remote.has(toKey(candidate));
      if (existsLocal || existsRemoteSnap) {
        idx++;
        continue;
      }
      try {
        uploadedCopy = await deps.remote.upload(
          candidate,
          remoteData,
          { kind: 'add' },
          copyMtime,
        );
        copyPath = candidate;
        break;
      } catch (err) {
        if (err instanceof RevConflictError) {
          idx++;
          continue;
        }
        throw err;
      }
    }

    const writtenCopy = await deps.local.write(copyPath, remoteData, copyMtime);
    await commitFile(copyPath, remoteData, writtenCopy.mtime, uploadedCopy);

    const localData = await deps.local.read(path);
    const localStat = (await deps.local.stat(path)) ?? snap.local.get(toKey(path));
    const localMtime = localStat?.mtime ?? deps.now().getTime();
    const targetRev = remoteEntry.rev ?? snap.remote.get(toKey(path))?.rev;
    const mode: WriteMode = targetRev ? { kind: 'update', rev: targetRev } : { kind: 'add' };
    const uploadedMain = await deps.remote.upload(path, localData, mode, localMtime);
    await commitFile(path, localData, localMtime, uploadedMain);

    result.conflicts.push(copyPath);
    result.applied.push(action);
  };

  const executeConflictNewerWins = async (action: Action, path: string): Promise<void> => {
    const localData = await deps.local.read(path);
    const localStat = (await deps.local.stat(path)) ?? snap.local.get(toKey(path));
    const localMtime = localStat?.mtime ?? 0;

    const { data: remoteData, entry: remoteEntry } = await deps.remote.download(path);
    const remoteMtime =
      remoteEntry.serverModified ?? snap.remote.get(toKey(path))?.serverModified ?? 0;

    const remoteWins = remoteMtime > localMtime;
    if (!remoteWins && spaceExhausted) {
      result.deferred.push(path);
      return;
    }

    const cleanDir = deps.configConflictDir.replace(/\/+$/g, '');
    const baseLoserRel = conflictName(path, deps.now(), deps.deviceName).replace(/^\/+/g, '');
    const baseLoserPath = cleanDir ? `${cleanDir}/${baseLoserRel}` : baseLoserRel;
    let idx = 1;
    let loserPath = baseLoserPath;
    while ((await deps.local.stat(loserPath)) !== null) {
      idx++;
      loserPath = withConflictSuffix(baseLoserPath, idx);
    }

    if (remoteWins) {
      await deps.local.write(loserPath, localData, localMtime);
      const written = await deps.local.write(path, remoteData, remoteMtime);
      await commitFile(path, remoteData, written.mtime, remoteEntry);
    } else {
      await deps.local.write(loserPath, remoteData, remoteMtime);
      const targetRev = remoteEntry.rev ?? snap.remote.get(toKey(path))?.rev;
      const mode: WriteMode = targetRev ? { kind: 'update', rev: targetRev } : { kind: 'add' };
      const uploaded = await deps.remote.upload(path, localData, mode, localMtime);
      await commitFile(path, localData, localMtime, uploaded);
    }

    result.conflicts.push(loserPath);
    result.applied.push(action);
  };

  const executeDownload = async (
    action: Extract<Action, { kind: 'download' }>,
  ): Promise<void> => {
    const { path } = action;
    const snapLocal = snap.local.get(toKey(path));
    const currentStat = await deps.local.stat(path);
    if (
      currentStat !== null &&
      (!snapLocal ||
        currentStat.size !== snapLocal.size ||
        currentStat.mtime !== snapLocal.mtime)
    ) {
      result.deferred.push(path);
      return;
    }

    const { data, entry } = await deps.remote.download(path);
    const mtime =
      entry.serverModified ?? action.remote.serverModified ?? deps.now().getTime();
    const written = await deps.local.write(path, data, mtime);
    await commitFile(path, data, written.mtime, entry);
    result.applied.push(action);
  };

  const executeSingle = async (action: Action): Promise<void> => {
    switch (action.kind) {
      case 'upload': {
        if (spaceExhausted) {
          result.deferred.push(action.path);
          return;
        }
        const data = await deps.local.read(action.path);
        const stat = (await deps.local.stat(action.path)) ?? snap.local.get(toKey(action.path));
        const mtime = stat?.mtime ?? deps.now().getTime();
        const entry = await deps.remote.upload(action.path, data, action.mode, mtime);
        await commitFile(action.path, data, mtime, entry);
        result.applied.push(action);
        return;
      }

      case 'download': {
        await executeDownload(action);
        return;
      }

      case 'record': {
        const key = toKey(action.path);
        const l = snap.local.get(key);
        const r = snap.remote.get(key);
        if (l?.isFolder || r?.isFolder) {
          await commitFolder(action.path, l?.mtime ?? 0);
        } else {
          const size = l?.size ?? r?.size ?? 0;
          const mtime = l?.mtime ?? r?.serverModified ?? 0;
          let text: string | null = null;
          if (isMarkdown(action.path) && size <= deps.baseTextCapBytes) {
            const data = await deps.local.read(action.path);
            text = decodeText(data);
          }
          await deps.state.commit(
            {
              path: action.path,
              isFolder: false,
              size,
              mtime,
              contentHash: r?.contentHash ?? l?.contentHash ?? null,
              rev: r?.rev ?? null,
              serverModified: r?.serverModified ?? null,
            },
            text,
          );
        }
        result.applied.push(action);
        return;
      }

      case 'merge': {
        if (spaceExhausted) {
          result.deferred.push(action.path);
          return;
        }
        const key = toKey(action.path);
        const baseRec = snap.base.get(key);
        const remoteSnap = snap.remote.get(key);

        let baseText = await deps.state.getBaseText(action.path);
        if (baseText === null && baseRec?.rev) {
          try {
            const baseBuf = await deps.remote.downloadRev(action.path, baseRec.rev);
            baseText = decodeText(baseBuf);
          } catch (err) {
            if (err instanceof NotFoundError) {
              baseText = null;
            } else {
              throw err;
            }
          }
        }

        if (baseText === null) {
          await executeConflictCopy(action, action.path);
          return;
        }

        const localBuf = await deps.local.read(action.path);
        const localText = decodeText(localBuf);
        const remoteDownload = await deps.remote.download(action.path);
        const remoteText = decodeText(remoteDownload.data);

        const merged = merge3(baseText, localText, remoteText);
        if (merged.clean) {
          const mergedData = encodeText(merged.text);
          const written = await deps.local.write(action.path, mergedData);
          const targetRev = remoteDownload.entry.rev ?? remoteSnap?.rev;
          const mode: WriteMode = targetRev
            ? { kind: 'update', rev: targetRev }
            : { kind: 'add' };
          const uploaded = await deps.remote.upload(
            action.path,
            mergedData,
            mode,
            written.mtime,
          );
          await commitFile(action.path, mergedData, written.mtime, uploaded);
          result.merged.push(action.path);
          result.applied.push(action);
        } else {
          await executeConflictCopy(action, action.path, remoteDownload);
        }
        return;
      }

      case 'conflict': {
        if (action.strategy === 'newerWins') {
          await executeConflictNewerWins(action, action.path);
        } else {
          await executeConflictCopy(action, action.path);
        }
        return;
      }

      case 'deleteRemote': {
        await deps.remote.delete(action.path, action.rev);
        await deps.state.remove(action.path);
        result.applied.push(action);
        return;
      }

      case 'deleteLocal': {
        const snapLocal = snap.local.get(toKey(action.path));
        const currentStat = await deps.local.stat(action.path);
        if (currentStat !== null) {
          if (
            !snapLocal ||
            currentStat.size !== snapLocal.size ||
            currentStat.mtime !== snapLocal.mtime
          ) {
            result.deferred.push(action.path);
            return;
          }
          await deps.local.trash(action.path);
        }
        await deps.state.remove(action.path);
        result.applied.push(action);
        return;
      }

      case 'dropRecord': {
        await deps.state.remove(action.path);
        result.applied.push(action);
        return;
      }

      case 'moveRemote': {
        if (spaceExhausted) {
          result.deferred.push(action.to);
          return;
        }
        const movedEntry = await deps.remote.move(action.from, action.to);
        await deps.state.remove(action.from);
        const localStat = (await deps.local.stat(action.to)) ?? snap.local.get(toKey(action.to));
        if (movedEntry.isFolder) {
          await commitFolder(action.to, localStat?.mtime ?? 0);
        } else {
          const size = localStat?.size ?? movedEntry.size;
          const mtime = localStat?.mtime ?? movedEntry.serverModified ?? 0;
          let text: string | null = null;
          if (isMarkdown(action.to) && size <= deps.baseTextCapBytes) {
            const data = await deps.local.read(action.to);
            text = decodeText(data);
          }
          await deps.state.commit(
            {
              path: action.to,
              isFolder: false,
              size,
              mtime,
              contentHash:
                movedEntry.contentHash ??
                snap.local.get(toKey(action.to))?.contentHash ??
                null,
              rev: movedEntry.rev,
              serverModified: movedEntry.serverModified,
            },
            text,
          );
        }
        result.applied.push(action);
        return;
      }

      case 'moveLocal': {
        await deps.local.rename(action.from, action.to);
        await deps.state.remove(action.from);
        const localStat = await deps.local.stat(action.to);
        const remoteEntry =
          snap.remote.get(toKey(action.to)) ?? snap.base.get(toKey(action.from));
        if (localStat?.isFolder || remoteEntry?.isFolder) {
          await commitFolder(action.to, localStat?.mtime ?? 0);
        } else {
          const size = localStat?.size ?? remoteEntry?.size ?? 0;
          const mtime = localStat?.mtime ?? remoteEntry?.serverModified ?? 0;
          let text: string | null = null;
          if (isMarkdown(action.to) && size <= deps.baseTextCapBytes) {
            const data = await deps.local.read(action.to);
            text = decodeText(data);
          }
          await deps.state.commit(
            {
              path: action.to,
              isFolder: false,
              size,
              mtime,
              contentHash: remoteEntry?.contentHash ?? null,
              rev: remoteEntry?.rev ?? null,
              serverModified: remoteEntry?.serverModified ?? null,
            },
            text,
          );
        }
        result.applied.push(action);
        return;
      }

      case 'mkdirLocal': {
        await deps.local.mkdir(action.path);
        const stat = await deps.local.stat(action.path);
        await commitFolder(action.path, stat?.mtime ?? 0);
        result.applied.push(action);
        return;
      }

      case 'mkdirRemote': {
        if (spaceExhausted) {
          result.deferred.push(action.path);
          return;
        }
        await deps.remote.createFolder(action.path);
        const stat = (await deps.local.stat(action.path)) ?? snap.local.get(toKey(action.path));
        await commitFolder(action.path, stat?.mtime ?? 0);
        result.applied.push(action);
        return;
      }

      case 'rmdirLocal': {
        const removed = await deps.local.rmdirIfEmpty(action.path);
        if (removed) {
          await deps.state.remove(action.path);
          result.applied.push(action);
        }
        return;
      }

      case 'rmdirRemote': {
        const currentBase = await deps.state.loadBase();
        const prefix = `${toKey(action.path)}/`;
        for (const k of currentBase.keys()) {
          if (k.startsWith(prefix)) {
            return;
          }
        }
        await deps.remote.delete(action.path, null);
        await deps.state.remove(action.path);
        result.applied.push(action);
        return;
      }

      case 'skip': {
        result.errors.push({ path: action.path, message: action.reason });
        return;
      }
    }
  };

  let i = 0;
  while (i < actions.length) {
    if (actions[i].kind === 'download') {
      const batch: Array<Extract<Action, { kind: 'download' }>> = [];
      while (i < actions.length && actions[i].kind === 'download') {
        batch.push(actions[i] as Extract<Action, { kind: 'download' }>);
        i++;
      }

      let cursor = 0;
      let batchFatal: 'offline' | 'auth' | null = null;
      const poolSize = Math.min(Math.max(1, deps.downloadConcurrency), batch.length);

      const worker = async (): Promise<void> => {
        while (batchFatal === null) {
          const idx = cursor++;
          if (idx >= batch.length) {
            break;
          }
          const action = batch[idx];
          try {
            await executeDownload(action);
            done++;
            onProgress?.(done, total);
          } catch (err) {
            if (err instanceof NetworkError) {
              batchFatal = 'offline';
              return;
            }
            if (err instanceof AuthError) {
              batchFatal = 'auth';
              return;
            }
            if (err instanceof RevConflictError) {
              result.deferred.push(action.path);
            } else {
              result.errors.push({
                path: action.path,
                message: err instanceof Error ? err.message : String(err),
              });
            }
            done++;
            onProgress?.(done, total);
          }
        }
      };

      const workers: Array<Promise<void>> = [];
      for (let w = 0; w < poolSize; w++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (batchFatal !== null) {
        result.fatal = batchFatal;
        break;
      }
      continue;
    }

    const action = actions[i++];
    try {
      await executeSingle(action);
      done++;
      onProgress?.(done, total);
    } catch (err) {
      if (err instanceof NetworkError) {
        result.fatal = 'offline';
        break;
      }
      if (err instanceof AuthError) {
        result.fatal = 'auth';
        break;
      }
      if (err instanceof RevConflictError) {
        result.deferred.push(actionPath(action));
      } else if (err instanceof InsufficientSpaceError) {
        spaceExhausted = true;
        result.errors.push({
          path: actionPath(action),
          message: err.message,
        });
      } else {
        result.errors.push({
          path: actionPath(action),
          message: err instanceof Error ? err.message : String(err),
        });
      }
      done++;
      onProgress?.(done, total);
    }
  }

  return result;
}
