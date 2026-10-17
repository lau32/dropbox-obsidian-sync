import { toKey } from '../paths';
import { Action } from './planner';
import { Snapshot } from './snapshot';

export interface PlanSummary {
  baseCount: number;
  uploads: number;
  downloads: number;
  moves: number;
  merges: number;
  conflicts: number;
  deletesLocal: string[];
  deletesRemote: string[];
  configOverwrites: string[];
}

export interface GuardContext {
  baseCount: number;
  localCount: number;
  remoteCount: number;
  maxDeletes: number;
  maxPercent: number;
}

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'massChange' | 'emptyLocal' | 'emptyRemote';
      summary: PlanSummary;
    };

export function summarize(actions: Action[], baseCount = 0): PlanSummary {
  const summary: PlanSummary = {
    baseCount,
    uploads: 0,
    downloads: 0,
    moves: 0,
    merges: 0,
    conflicts: 0,
    deletesLocal: [],
    deletesRemote: [],
    configOverwrites: [],
  };

  for (const a of actions) {
    switch (a.kind) {
      case 'upload':
        summary.uploads++;
        break;
      case 'download':
        summary.downloads++;
        break;
      case 'moveLocal':
      case 'moveRemote':
        summary.moves++;
        break;
      case 'merge':
        summary.merges++;
        break;
      case 'conflict':
        summary.conflicts++;
        if (a.strategy === 'newerWins') {
          summary.configOverwrites.push(a.path);
        }
        break;
      case 'deleteLocal':
        summary.deletesLocal.push(a.path);
        break;
      case 'deleteRemote':
        summary.deletesRemote.push(a.path);
        break;
    }
  }

  return summary;
}

export function guard(actions: Action[], ctx: GuardContext): GuardResult {
  const summary = summarize(actions, ctx.baseCount);

  if (ctx.baseCount > 0 && ctx.localCount === 0) {
    return { ok: false, reason: 'emptyLocal', summary };
  }

  if (ctx.baseCount > 0 && ctx.remoteCount === 0) {
    return { ok: false, reason: 'emptyRemote', summary };
  }

  const destructiveCount =
    summary.deletesLocal.length +
    summary.deletesRemote.length +
    summary.configOverwrites.length;

  if (
    destructiveCount > ctx.maxDeletes ||
    (ctx.baseCount > 0 && destructiveCount > (ctx.baseCount * ctx.maxPercent) / 100)
  ) {
    return { ok: false, reason: 'massChange', summary };
  }

  return { ok: true };
}

export function withoutDeletions(actions: Action[], snap?: Snapshot): Action[] {
  const kept: Action[] = [];
  const restored: Action[] = [];

  for (const a of actions) {
    switch (a.kind) {
      case 'rmdirLocal':
      case 'rmdirRemote':
      case 'dropRecord':
        break;
      case 'deleteLocal':
        restored.push({ kind: 'upload', path: a.path, mode: { kind: 'add' } });
        break;
      case 'deleteRemote': {
        const remote = snap?.remote.get(toKey(a.path));
        if (remote) {
          restored.push({ kind: 'download', path: a.path, remote });
        }
        break;
      }
      default:
        kept.push(a);
        break;
    }
  }

  return [...kept, ...restored];
}
