import { AuthError, NetworkError } from '../errors';
import { PathFilter } from '../filter/PathFilter';
import { Hasher } from '../hash/contentHash';
import { LocalStore } from '../local/LocalStore';
import { RemoteStore } from '../remote/RemoteStore';
import { StateStore } from '../state/StateStore';
import { SyncLogEntry, TriggerReason } from '../types';
import { execute, RunResult } from './executor';
import { guard, PlanSummary, withoutDeletions } from './guardrails';
import { Action, plan } from './planner';
import { takeSnapshot } from './snapshot';

export interface EngineOptions {
  deviceName: string;
  maxDeletes: number;
  maxPercent: number;
  baseTextCapBytes: number;
  configConflictDir: string;
}

export interface SyncEngineDeps {
  local: LocalStore;
  remote: RemoteStore;
  state: StateStore;
  filter: PathFilter;
  hash: Hasher;
  now: () => Date;
  options: () => EngineOptions;
  takeRenameHints: () => Array<{ from: string; to: string }>;
}

export type SyncOutcome =
  | { status: 'ok'; result: RunResult }
  | {
      status: 'needsReview';
      reason: 'massChange' | 'emptyLocal' | 'emptyRemote';
      summary: PlanSummary;
    }
  | { status: 'offline' | 'auth' | 'error'; message: string; result?: RunResult };

function actionLogPath(action: Action): string {
  switch (action.kind) {
    case 'moveLocal':
    case 'moveRemote':
      return action.to;
    default:
      return action.path;
  }
}

export class SyncEngine {
  private pendingRenameHints: Array<{ from: string; to: string }> = [];

  constructor(private readonly deps: SyncEngineDeps) {}

  async run(opts: {
    trigger: TriggerReason;
    approval?: 'all' | 'noDeletes';
    onProgress?: (d: number, t: number) => void;
  }): Promise<SyncOutcome> {
    const startedAt = this.deps.now().getTime();

    try {
      const snap = await takeSnapshot({
        local: this.deps.local,
        remote: this.deps.remote,
        state: this.deps.state,
        filter: this.deps.filter,
        hash: this.deps.hash,
      });

      const newHints = this.deps.takeRenameHints();
      if (newHints.length > 0) {
        this.pendingRenameHints.push(...newHints);
      }

      let actions = plan({
        snapshot: snap,
        renameHints: this.pendingRenameHints,
        isConfigPath: (p) => this.deps.filter.isConfigPath(p),
      });

      const engineOpts = this.deps.options();

      if (!opts.approval) {
        let baseCount = 0;
        for (const entry of snap.base.values()) {
          if (!entry.isFolder) baseCount++;
        }
        let localCount = 0;
        for (const entry of snap.local.values()) {
          if (!entry.isFolder) localCount++;
        }
        let remoteCount = 0;
        for (const entry of snap.remote.values()) {
          if (!entry.isFolder) remoteCount++;
        }

        const guardRes = guard(actions, {
          baseCount,
          localCount,
          remoteCount,
          maxDeletes: engineOpts.maxDeletes,
          maxPercent: engineOpts.maxPercent,
        });

        if (!guardRes.ok) {
          return {
            status: 'needsReview',
            reason: guardRes.reason,
            summary: guardRes.summary,
          };
        }
      } else if (opts.approval === 'noDeletes') {
        actions = withoutDeletions(actions, snap);
      }

      this.pendingRenameHints = [];

      const result = await execute(
        actions,
        snap,
        {
          local: this.deps.local,
          remote: this.deps.remote,
          state: this.deps.state,
          hash: this.deps.hash,
          now: this.deps.now,
          deviceName: engineOpts.deviceName,
          configConflictDir: engineOpts.configConflictDir,
          baseTextCapBytes: engineOpts.baseTextCapBytes,
          downloadConcurrency: 4,
        },
        opts.onProgress,
      );

      const snapshotErrors: Array<{ path: string; message: string }> = [
        ...snap.caseCollisions.map((paths) => ({
          path: paths.join(', '),
          message: 'case collision',
        })),
        ...snap.skipped.map((path) => ({
          path,
          message: 'skipped',
        })),
      ];

      const finishedAt = this.deps.now().getTime();
      let status: 'ok' | 'offline' | 'auth';
      if (result.fatal === 'offline') {
        status = 'offline';
      } else if (result.fatal === 'auth') {
        status = 'auth';
      } else {
        status = 'ok';
        await this.deps.state.setMeta({ lastSyncAt: finishedAt });
      }

      const logEntry: SyncLogEntry = {
        startedAt,
        finishedAt,
        trigger: opts.trigger,
        status,
        actions: result.applied.map((a) => ({
          kind: a.kind,
          path: actionLogPath(a),
        })),
        merged: [...result.merged],
        conflicts: [...result.conflicts],
        errors: [...snapshotErrors, ...result.errors],
      };
      await this.deps.state.appendLog(logEntry, 50);

      if (result.fatal === 'offline') {
        return { status: 'offline', message: 'Network error', result };
      }
      if (result.fatal === 'auth') {
        return { status: 'auth', message: 'Authentication error', result };
      }
      return { status: 'ok', result };
    } catch (err) {
      const finishedAt = this.deps.now().getTime();
      const message = err instanceof Error ? err.message : String(err);
      const status: 'offline' | 'auth' | 'error' =
        err instanceof NetworkError
          ? 'offline'
          : err instanceof AuthError
            ? 'auth'
            : 'error';

      await this.deps.state.appendLog(
        {
          startedAt,
          finishedAt,
          trigger: opts.trigger,
          status,
          actions: [],
          merged: [],
          conflicts: [],
          errors: [{ path: '', message }],
        },
        50,
      );

      return { status, message };
    }
  }
}
