import { expect } from 'vitest';
import { SyncEngine, SyncOutcome } from '../../src/engine/SyncEngine';
import { ConfigSyncSettings, PathFilter } from '../../src/filter/PathFilter';
import { contentHash } from '../../src/hash/contentHash';
import { toKey } from '../../src/paths';
import { FakeDropbox } from '../fakes/FakeDropbox';
import { FakeVault } from '../fakes/FakeVault';
import { MemoryStateStore } from '../fakes/MemoryStateStore';

export interface WorldOptions {
  autoApprove?: boolean;
  maxDeletes?: number;
  maxPercent?: number;
  baseTextCapBytes?: number;
  maxFileSizeBytes?: number;
  excludes?: string[];
  configSync?: Partial<ConfigSyncSettings>;
}

export interface Device {
  name: string;
  vault: FakeVault;
  state: MemoryStateStore;
  filter: PathFilter;
  sync(approval?: 'all' | 'noDeletes'): Promise<SyncOutcome>;
  setExcludes(globs: string[]): void;
  setConfigSync(patch: Partial<ConfigSyncSettings>): void;
  setFailAfter(k?: number): void;
  addRenameHint(from: string, to: string): void;
}

export interface World {
  dropbox: FakeDropbox;
  devices: Device[];
  clock: { tick(ms: number): void };
  autoApprove: boolean;
}

const DEVICE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];

export function createWorld(n: number, opts: WorldOptions = {}): World {
  let currentTime = Date.UTC(2026, 9, 13, 12, 0, 0);
  const clockFn = () => currentTime;
  const clock = {
    tick(ms: number): void {
      currentTime += ms;
    },
  };

  const dropbox = new FakeDropbox(clockFn);
  const devices: Device[] = [];

  for (let i = 0; i < n; i++) {
    const name = DEVICE_NAMES[i] ?? `dev-${i + 1}`;
    const vaultOpts: { failAfter?: number } = {};
    const vault = new FakeVault(clockFn, vaultOpts);
    const state = new MemoryStateStore();

    let excludes = [...(opts.excludes ?? [])];
    let configSync: ConfigSyncSettings = {
      core: opts.configSync?.core ?? false,
      themes: opts.configSync?.themes ?? false,
      plugins: opts.configSync?.plugins ?? false,
      workspace: opts.configSync?.workspace ?? false,
    };
    const maxFileSizeBytes = opts.maxFileSizeBytes ?? 50 * 1024 * 1024;

    const makeFilter = () =>
      new PathFilter({
        configDir: '.obsidian',
        pluginDir: '.obsidian/plugins/dropbox-vault-sync',
        configSync: { ...configSync },
        excludes: [...excludes],
        maxFileSizeBytes,
      });

    let currentFilter = makeFilter();
    let renameHints: Array<{ from: string; to: string }> = [];

    const remote = dropbox.client();

    const createEngine = () =>
      new SyncEngine({
        local: vault,
        remote,
        state,
        filter: currentFilter,
        hash: contentHash,
        now: () => new Date(currentTime),
        options: () => ({
          deviceName: name,
          maxDeletes: opts.maxDeletes ?? 25,
          maxPercent: opts.maxPercent ?? 50,
          baseTextCapBytes: opts.baseTextCapBytes ?? 1024 * 1024,
          configConflictDir: '.obsidian/conflicts',
        }),
        takeRenameHints: () => {
          const taken = renameHints;
          renameHints = [];
          return taken;
        },
      });

    let engine = createEngine();

    const device: Device = {
      name,
      vault,
      state,
      get filter() {
        return currentFilter;
      },
      async sync(approval?: 'all' | 'noDeletes'): Promise<SyncOutcome> {
        return engine.run({
          trigger: approval ? 'manual' : 'interval',
          approval,
        });
      },
      setExcludes(globs: string[]): void {
        excludes = [...globs];
        currentFilter = makeFilter();
        engine = createEngine();
      },
      setConfigSync(patch: Partial<ConfigSyncSettings>): void {
        configSync = { ...configSync, ...patch };
        currentFilter = makeFilter();
        engine = createEngine();
      },
      setFailAfter(k?: number): void {
        (vault as unknown as { mutatingCalls: number }).mutatingCalls = 0;
        if (k === undefined) {
          delete vaultOpts.failAfter;
        } else {
          vaultOpts.failAfter = k;
        }
      },
      addRenameHint(from: string, to: string): void {
        renameHints.push({ from, to });
      },
    };

    devices.push(device);
  }

  return {
    dropbox,
    devices,
    clock,
    autoApprove: opts.autoApprove ?? false,
  };
}

export async function syncAll(world: World, rounds = 4): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    for (const dev of world.devices) {
      const out = await dev.sync();
      if (out.status === 'needsReview' && world.autoApprove) {
        await dev.sync('all');
      }
    }
  }
}

export function assertConverged(world: World): void {
  for (const dev of world.devices) {
    const remoteMap = new Map<string, string>();
    for (const p of world.dropbox.paths()) {
      if (dev.filter.isPathSynced(p, false)) {
        remoteMap.set(toKey(p), world.dropbox.readText(p) ?? '');
      }
    }

    const localMap = new Map<string, string>();
    for (const p of dev.vault.paths()) {
      if (dev.filter.isPathSynced(p, false)) {
        localMap.set(toKey(p), dev.vault.readText(p) ?? '');
      }
    }

    expect(localMap, `device ${dev.name} synced files should match Dropbox`).toEqual(
      remoteMap,
    );
  }
}
