# Dropbox Vault Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Obsidian plugin (desktop + mobile) that syncs a vault two-way with the user's own Dropbox, using state-based reconciliation, 3-way merge for Markdown, and deletion guardrails.

**Architecture:** A pure planner turns a snapshot (last-synced base, local listing, remote listing) into a list of actions; guardrails inspect the plan; an executor applies actions one at a time and commits state after each. The engine depends only on `LocalStore`, `RemoteStore` and `StateStore` interfaces, so nearly everything is tested against in-memory fakes; Obsidian- and Dropbox-specific code lives in thin adapters.

**Tech Stack:** TypeScript, esbuild (obsidian-sample-plugin layout), Vitest, fast-check, fake-indexeddb; runtime deps `node-diff3`, `idb`, `minimatch`.

**Spec:** `docs/superpowers/specs/2026-10-13-dropbox-sync-design.md`

## Global Constraints

- Plugin id `dropbox-vault-sync`, name "Dropbox Vault Sync", `isDesktopOnly: false`, `minAppVersion: "1.7.2"`.
- No Node built-ins (`fs`, `path`, `crypto`, `os`, `child_process`, `node:*`) imported anywhere under `src/`. Tests may use them. Enforced by `npm run lint:imports`.
- Only `src/main.ts`, `src/obsidian/**` and `src/ui/**` may import `obsidian`. Everything else must be runnable under Vitest in Node.
- All HTTP goes through the `HttpClient` type (wired to Obsidian `requestUrl` in production). All vault I/O goes through `LocalStore`.
- Each user connects their own Dropbox (App-folder access). Remote root is `/<remoteFolder>` inside the app folder; `remoteFolder` defaults to the vault name. No plugin metadata files are ever written to Dropbox.
- Paths inside the engine are vault-relative, `/`-separated, no leading slash. Map keys are `toKey(path)` = NFC-normalized + lowercased.
- Defaults (verbatim from spec): edit debounce 10 s, interval poll 5 min, max file size 50 MB, merge base cap 1 MB, guard threshold 10 files or 10 %, all `.obsidian/` categories off, workspace category carries a churn warning.
- Conflict copy name: `<name> (conflict YYYY-MM-DD HHmm <device>).<ext>` (local time). Device default: "iPhone", "iPad", "Android", "Desktop".
- Concurrency: at most 4 parallel downloads; uploads serial.
- Log keeps the last 50 sync runs.

### Spec clarifications made by this plan (confirm during review)

1. **Remote index.** Instead of deriving the remote view from base + deltas, the state DB stores a remote index (every remote entry under the root) updated from `list_folder` deltas together with the cursor, right after listing. This removes the risk of losing a remote change when an action is deferred or errors, and lets the cursor always advance.
2. **What the guard counts as "overwrite".** The threshold counts local deletions, remote deletions, and `.obsidian/` newer-wins overwrites. Ordinary propagation of edits is not counted (prior versions remain in Dropbox version history; local unsynced edits are always merged or copied, never overwritten).
3. **No upload sessions in v1.** The max-file-size setting is capped at 150 MB (Dropbox single-request upload limit). Spec §12 already lists batching as future work.

## Review Focus

1. **Non-ASCII filenames** (é, CJK, emoji) must upload/download correctly — Dropbox's `Dropbox-API-Arg` header must be ASCII-escaped. → Task 12.
2. **Unicode normalization**: iOS/macOS may report NFD names while Dropbox returns NFC; the same note must map to one key, never a duplicate + delete. → Tasks 1, 7.
3. **Changing filter settings** (disabling a `.obsidian` category, adding an exclude, a file growing past the size limit) must never propagate deletions. → Tasks 7, 11.
4. **Self-triggered sync loops**: the plugin's own writes must not trigger the edit-debounce sync. → Task 14.
5. **Renaming a folder with many files** must produce moves, not a mass delete that trips the guard. → Tasks 8, 9.

---

## File Structure

```
package.json  tsconfig.json  esbuild.config.mjs  vitest.config.ts  manifest.json  versions.json  styles.css  .gitignore
src/
  main.ts                    Plugin: wiring, events, commands, protocol handler
  settings.ts                Settings type, defaults, device-name default
  types.ts                   Shared data types
  errors.ts                  Typed errors
  paths.ts                   toKey, remote path mapping, conflictName, isMarkdown, parentDir
  bytes.ts                   encodeText / decodeText
  hash/contentHash.ts        Dropbox content_hash
  filter/PathFilter.ts       Sync scope decisions
  merge/merge3.ts            3-way text merge
  remote/RemoteStore.ts      Interface
  remote/http.ts             HttpClient types
  remote/DropboxRemote.ts    Dropbox API implementation
  auth/pkce.ts               PKCE helpers
  auth/DropboxAuth.ts        OAuth + token management
  local/LocalStore.ts        Interface
  state/StateStore.ts        Interface
  state/IdbStateStore.ts     IndexedDB implementation
  engine/snapshot.ts         Builds base/local/remote views
  engine/planner.ts          Pure planner
  engine/guardrails.ts       Pure guard
  engine/executor.ts         Applies actions
  engine/SyncEngine.ts       Orchestrates one run
  scheduler/Scheduler.ts     Triggers, debounce, mutex
  scheduler/SelfWriteTracker.ts
  obsidian/ObsidianLocalStore.ts
  obsidian/obsidianHttp.ts
  ui/statusText.ts           Pure status-bar text
  ui/StatusBar.ts  ui/SettingsTab.ts  ui/ReviewModal.ts  ui/ConflictsModal.ts  ui/SyncLogView.ts
  ui/conflicts.ts            Pure: findConflictCopies
  ui/summaryText.ts          Pure: plan summary text
test/
  fakes/FakeDropbox.ts  fakes/FakeVault.ts  fakes/MemoryStateStore.ts
  contract/remoteStoreContract.ts  contract/stateStoreContract.ts
  support/nodeHttp.ts  support/scriptedHttp.ts
  unit/**.test.ts  sim/world.ts  sim/**.test.ts
docs/release-checklist.md  docs/dropbox-app-setup.md  README.md  .github/workflows/release.yml
```

---

### Task 1: Project scaffold and path utilities

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `vitest.config.ts`, `manifest.json`, `versions.json`, `styles.css`, `.gitignore`, `src/main.ts`, `src/paths.ts`
- Test: `test/unit/paths.test.ts`

**Interfaces:**
- Produces:
  - `toKey(path: string): string`
  - `toRemotePath(root: string, path: string): string`
  - `fromRemotePath(root: string, pathDisplay: string): string | null`
  - `conflictName(path: string, when: Date, device: string): string`
  - `isMarkdown(path: string): boolean`
  - `parentDir(path: string): string` (`''` for top level)

- [ ] **Step 1: Scaffold the project**

Base the layout on `obsidian-sample-plugin`. `package.json` scripts: `dev` (esbuild watch), `build` (`tsc --noEmit && node esbuild.config.mjs production`), `test` (`vitest run`), `lint:imports` (fails if any file in `src/` matches `from ['"](node:|fs|path|crypto|os|child_process)['"]`). Dev deps: `obsidian`, `typescript`, `esbuild`, `builtin-modules`, `vitest`, `fast-check`, `fake-indexeddb`, `@types/node`. Deps: `node-diff3`, `idb`, `minimatch`. Install with `npm install` and commit `package-lock.json`. `manifest.json` per Global Constraints. `tsconfig`: `strict: true`, `lib: ["DOM","ES2022"]`. `src/main.ts`: an empty `Plugin` subclass. `.gitignore`: `node_modules`, `main.js`, `data.json`.

- [ ] **Step 2: Write the failing tests**

```ts
import { toKey, toRemotePath, fromRemotePath, conflictName, isMarkdown, parentDir } from '../../src/paths';
const when = new Date(2026, 9, 13, 21, 42);

test('toKey normalizes NFD to NFC and lowercases', () => {
  expect(toKey('Notes/Café.md'.normalize('NFD'))).toBe('notes/café.md'.normalize('NFC'));
});
test('remote path mapping', () => {
  expect(toRemotePath('My Vault', 'Sub/A.md')).toBe('/My Vault/Sub/A.md');
  expect(toRemotePath('My Vault', '')).toBe('/My Vault');
  expect(fromRemotePath('My Vault', '/my vault/Sub/A.md')).toBe('Sub/A.md');
  expect(fromRemotePath('My Vault', '/My Vault')).toBeNull();
  expect(fromRemotePath('My Vault', '/Other/A.md')).toBeNull();
  expect(fromRemotePath('My Vault', '/My Vault2/A.md')).toBeNull();
});
test('conflictName', () => {
  expect(conflictName('a/Note.md', when, 'iPhone')).toBe('a/Note (conflict 2026-10-13 2142 iPhone).md');
  expect(conflictName('x.tar.gz', when, 'Desktop')).toBe('x.tar (conflict 2026-10-13 2142 Desktop).gz');
  expect(conflictName('.gitignore', when, 'Desktop')).toBe('.gitignore (conflict 2026-10-13 2142 Desktop)');
  expect(conflictName('README', when, 'Desktop')).toBe('README (conflict 2026-10-13 2142 Desktop)');
});
test('helpers', () => {
  expect(isMarkdown('a/B.MD')).toBe(true);
  expect(isMarkdown('a/b.png')).toBe(false);
  expect(parentDir('a/b/c.md')).toBe('a/b');
  expect(parentDir('c.md')).toBe('');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/paths.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/paths.ts`**

`fromRemotePath` compares the root prefix with `toKey` on both sides and returns the remainder from `pathDisplay` (preserving case), NFC-normalized.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npm run build && npm run lint:imports` — Expected: tests PASS, `main.js` produced, lint exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold plugin and add path utilities"
```

---

### Task 2: Dropbox content hash

**Files:**
- Create: `src/hash/contentHash.ts`, `src/bytes.ts`
- Test: `test/unit/contentHash.test.ts`

**Interfaces:**
- Produces: `type Hasher = (data: ArrayBuffer) => Promise<string>`; `contentHash: Hasher` (lowercase hex); `encodeText(s: string): ArrayBuffer`; `decodeText(b: ArrayBuffer): string` (UTF-8).

- [ ] **Step 1: Write the failing test** — Node's `crypto` is the oracle.

```ts
import { createHash } from 'node:crypto';
const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const oracle = (buf: Buffer) => {
  const blocks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += 4 * 1024 * 1024) blocks.push(sha(buf.subarray(i, i + 4 * 1024 * 1024)));
  return sha(Buffer.concat(blocks)).toString('hex');
};
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

test.each([0, 3, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 9 * 1024 * 1024])('matches oracle for %i bytes', async (n) => {
  const buf = Buffer.alloc(n, 7);
  expect(await contentHash(ab(buf))).toBe(oracle(buf));
});
test('empty file hash', async () => {
  expect(await contentHash(new ArrayBuffer(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
test('text roundtrip', () => expect(decodeText(encodeText('héllo 😀'))).toBe('héllo 😀'));
```

- [ ] **Step 2: Run** `npx vitest run test/unit/contentHash.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with `crypto.subtle.digest('SHA-256', …)` per 4 MiB block, then over the concatenated digests.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: Dropbox content hash`

---

### Task 3: Path filter

**Files:**
- Create: `src/filter/PathFilter.ts`
- Test: `test/unit/PathFilter.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ConfigSyncSettings { core: boolean; themes: boolean; plugins: boolean; workspace: boolean }
export interface FilterSettings { configDir: string; pluginDir: string; configSync: ConfigSyncSettings; excludes: string[]; maxFileSizeBytes: number }
export class PathFilter {
  constructor(s: FilterSettings);
  isPathSynced(path: string, isFolder?: boolean): boolean;
  isSizeAllowed(size: number): boolean;
  isConfigPath(path: string): boolean;
}
```

Rules (spec §8): always excluded — `pluginDir/**`, `.trash/**`, any `.DS_Store`/`Thumbs.db`, folders inside `configDir` (and `configDir` itself; config folders are created implicitly). Config categories: **core** = any `*.json` directly in `configDir` except `workspace*.json` and `community-plugins.json`; **themes** = `themes/**`, `snippets/**`; **plugins** = `community-plugins.json`, `plugins/**`; **workspace** = `workspace*.json`. Anything else in `configDir` is excluded. Excludes use `minimatch` with `{ dot: true, matchBase: true, nocase: true }`.

- [ ] **Step 1: Write the failing tests**

```ts
const base: FilterSettings = { configDir: '.obsidian', pluginDir: '.obsidian/plugins/dropbox-vault-sync',
  configSync: { core: false, themes: false, plugins: false, workspace: false }, excludes: [], maxFileSizeBytes: 50 * 1024 * 1024 };
const f = (patch: Partial<FilterSettings> = {}) => new PathFilter({ ...base, ...patch });
const all = { core: true, themes: true, plugins: true, workspace: true };

test.each([
  ['Notes/a.md', true], ['.trash/x.md', false], ['dir/.DS_Store', false], ['Thumbs.db', false], ['.obsidian/app.json', false],
])('defaults: %s → %s', (p, exp) => expect(f().isPathSynced(p)).toBe(exp));

test.each([
  [{ core: true }, '.obsidian/app.json', true],
  [{ core: true }, '.obsidian/workspace.json', false],
  [{ core: true }, '.obsidian/community-plugins.json', false],
  [{ themes: true }, '.obsidian/themes/Minimal/theme.css', true],
  [{ themes: true }, '.obsidian/snippets/a.css', true],
  [{ plugins: true }, '.obsidian/plugins/calendar/main.js', true],
  [{ plugins: true }, '.obsidian/community-plugins.json', true],
  [{ workspace: true }, '.obsidian/workspace-mobile.json', true],
])('category %o: %s → %s', (cats, p, exp) =>
  expect(f({ configSync: { ...base.configSync, ...cats } }).isPathSynced(p)).toBe(exp));

test('own plugin dir and unknown config paths are never synced', () => {
  expect(f({ configSync: all }).isPathSynced('.obsidian/plugins/dropbox-vault-sync/data.json')).toBe(false);
  expect(f({ configSync: all }).isPathSynced('.obsidian/cache/x')).toBe(false);
  expect(f({ configSync: all }).isPathSynced('.obsidian/themes', true)).toBe(false);
});
test('custom configDir', () => {
  expect(f({ configDir: '.cfg', pluginDir: '.cfg/plugins/dropbox-vault-sync', configSync: all }).isPathSynced('.cfg/app.json')).toBe(true);
});
test('excludes', () => {
  const g = f({ excludes: ['Archive/**', '*.mov'] });
  expect(g.isPathSynced('Archive/a.md')).toBe(false);
  expect(g.isPathSynced('x/clip.MOV')).toBe(false);
  expect(g.isPathSynced('Archived.md')).toBe(true);
});
test('size and config detection', () => {
  expect(f().isSizeAllowed(50 * 1024 * 1024)).toBe(true);
  expect(f().isSizeAllowed(50 * 1024 * 1024 + 1)).toBe(false);
  expect(f().isConfigPath('.obsidian/app.json')).toBe(true);
  expect(f().isConfigPath('notes/.obsidian.md')).toBe(false);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; also `npm run build` to confirm `minimatch` bundles for mobile (no Node built-ins in output: `grep -c "require(\"path\")" main.js` → 0).
- [ ] **Step 5: Commit** `feat: path filter with .obsidian categories`

---

### Task 4: Three-way merge

**Files:**
- Create: `src/merge/merge3.ts`
- Test: `test/unit/merge3.test.ts`

**Interfaces:**
- Produces: `type MergeResult = { clean: true; text: string } | { clean: false }`; `merge3(base: string, local: string, remote: string): MergeResult`

Approach: normalize CRLF→LF on all three, split on `\n`, `diff3Merge(local, base, remote, { excludeFalseConflicts: true })` from `node-diff3`; any conflict block → `{ clean: false }`. If `local` contained `\r\n`, join the result with `\r\n`.

- [ ] **Step 1: Write the failing tests**

```ts
test('disjoint edits merge', () =>
  expect(merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({ clean: true, text: 'A\nb\nC\n' }));
test('identical edits are clean', () =>
  expect(merge3('a\n', 'b\n', 'b\n')).toEqual({ clean: true, text: 'b\n' }));
test('overlapping edits conflict', () =>
  expect(merge3('a\nb\n', 'X\nb\n', 'Y\nb\n')).toEqual({ clean: false }));
test('both append different lines at end conflicts', () =>
  expect(merge3('a\n', 'a\nx\n', 'a\ny\n')).toEqual({ clean: false }));
test('delete on one side, edit elsewhere on the other', () =>
  expect(merge3('a\nb\nc\nd\n', 'a\nc\nd\n', 'a\nb\nc\nD\n')).toEqual({ clean: true, text: 'a\nc\nD\n' }));
test('CRLF local is preserved', () =>
  expect(merge3('a\nb\nc\n', 'A\r\nb\r\nc\r\n', 'a\nb\nC\n')).toEqual({ clean: true, text: 'A\r\nb\r\nC\r\n' }));
test('frontmatter and body edits merge', () =>
  expect(merge3('---\ntags: [a]\n---\nbody\n', '---\ntags: [a, b]\n---\nbody\n', '---\ntags: [a]\n---\nbody 2\n'))
    .toEqual({ clean: true, text: '---\ntags: [a, b]\n---\nbody 2\n' }));
test('empty base with different content conflicts', () =>
  expect(merge3('', 'x\n', 'y\n')).toEqual({ clean: false }));
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: three-way text merge`

---

### Task 5: Core interfaces, errors, and in-memory fakes

**Files:**
- Create: `src/types.ts`, `src/errors.ts`, `src/remote/RemoteStore.ts`, `src/local/LocalStore.ts`, `src/state/StateStore.ts`, `test/fakes/FakeDropbox.ts`, `test/fakes/FakeVault.ts`, `test/fakes/MemoryStateStore.ts`, `test/contract/remoteStoreContract.ts`, `test/contract/stateStoreContract.ts`
- Test: `test/unit/fakeDropbox.contract.test.ts`, `test/unit/memoryState.contract.test.ts`, `test/unit/FakeVault.test.ts`

**Interfaces:**
- Produces (`src/types.ts`):
```ts
export interface LocalFile { path: string; isFolder: boolean; size: number; mtime: number }
export interface RemoteEntry { path: string; isFolder: boolean; size: number; rev: string | null; contentHash: string | null; serverModified: number | null }
export type RemoteChange = { kind: 'upsert'; entry: RemoteEntry } | { kind: 'deleted'; path: string };
export type WriteMode = { kind: 'add' } | { kind: 'update'; rev: string } | { kind: 'overwrite' };
export interface BaseRecord { path: string; isFolder: boolean; size: number; mtime: number; contentHash: string | null; rev: string | null; serverModified: number | null }
export interface SyncMeta { cursor: string | null; schemaVersion: number; lastSyncAt: number | null }
export type TriggerReason = 'startup' | 'resume' | 'edit' | 'interval' | 'remote' | 'manual';
export interface SyncLogEntry { startedAt: number; finishedAt: number; trigger: TriggerReason; status: string;
  actions: Array<{ kind: string; path: string }>; merged: string[]; conflicts: string[]; errors: Array<{ path: string; message: string }> }
```
- Produces (`src/errors.ts`): `RevConflictError(path)`, `CursorResetError`, `AuthError`, `RateLimitError(retryAfterMs)`, `InsufficientSpaceError`, `NetworkError`, `NotFoundError(path)`, `RemotePathError(path, summary)` — all extend `SyncError extends Error`.
- Produces (`src/remote/RemoteStore.ts`) — paths are vault-relative; implementations map to the remote root and drop anything outside it:
```ts
export interface RemoteStore {
  listAll(): Promise<{ entries: RemoteEntry[]; cursor: string }>;            // creates root if missing
  listChanges(cursor: string): Promise<{ changes: RemoteChange[]; cursor: string }>; // throws CursorResetError
  longpoll(cursor: string, timeoutSec: number): Promise<{ changed: boolean; backoffSec: number }>;
  download(path: string): Promise<{ data: ArrayBuffer; entry: RemoteEntry }>;
  downloadRev(path: string, rev: string): Promise<ArrayBuffer>;              // throws NotFoundError
  upload(path: string, data: ArrayBuffer, mode: WriteMode, clientModified: number): Promise<RemoteEntry>; // throws RevConflictError
  delete(path: string, rev: string | null): Promise<void>;                  // rev mismatch → RevConflictError; missing → resolves
  move(from: string, to: string): Promise<RemoteEntry>;
  createFolder(path: string): Promise<void>;                                // existing folder → resolves
}
```
- Produces (`src/local/LocalStore.ts`):
```ts
export interface LocalStore {
  list(): Promise<LocalFile[]>;                     // all files and folders, recursive, including configDir
  stat(path: string): Promise<LocalFile | null>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalFile>; // creates parent folders
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdirIfEmpty(path: string): Promise<boolean>;
}
```
- Produces (`src/state/StateStore.ts`) — keys are `toKey(path)`:
```ts
export interface StateStore {
  loadBase(): Promise<Map<string, BaseRecord>>;
  commit(rec: BaseRecord, baseText?: string | null): Promise<void>; // one transaction; undefined = keep text, null = drop text
  remove(path: string): Promise<void>;                                 // removes record and base text
  getBaseText(path: string): Promise<string | null>;
  loadRemoteIndex(): Promise<Map<string, RemoteEntry>>;
  applyRemoteChanges(changes: RemoteChange[], cursor: string, reset: boolean): Promise<void>; // reset replaces the index; one transaction with cursor
  getMeta(): Promise<SyncMeta>;
  setMeta(patch: Partial<SyncMeta>): Promise<void>;
  appendLog(entry: SyncLogEntry, keep: number): Promise<void>;
  getLog(): Promise<SyncLogEntry[]>;                                  // newest first
  reset(): Promise<void>;                                             // clears base, texts, remote index, cursor; keeps log
}
```
- Produces (fakes, used by Tasks 7–11):
  - `new FakeDropbox(clock: () => number)` with `client(): RemoteStore` (all clients share one server), test helpers `readText(path): string | undefined`, `writeText(path, text)` (external edit), `paths(): string[]`, `expireCursors()`, `failNext(method: keyof RemoteStore, err: Error)`, `beforeWrite(hook: (path: string) => Promise<void> | void)`. Revs are `r1, r2, …`; storage is case-insensitive by `toKey`, keeping display case; cursor = journal sequence number; `listChanges` returns the latest change per path since the cursor.
  - `new FakeVault(clock: () => number, opts?: { failAfter?: number })` implementing `LocalStore`, plus `writeText(path, text)` (user edit, bumps mtime), `readText(path)`, `deleteUser(path)`, `renameUser(from, to)`, `paths(): string[]`, `trashed: string[]`. `failAfter: n` makes the (n+1)-th mutating call throw `Error('injected')` (used by crash tests).
  - `new MemoryStateStore()` implementing `StateStore`.
  - `describeRemoteStoreContract(name: string, make: () => Promise<RemoteStore>)` and `describeStateStoreContract(name, make: () => Promise<StateStore>)`.

- [ ] **Step 1: Write the RemoteStore contract suite** in `test/contract/remoteStoreContract.ts` covering, with unique test-run path prefixes:
  - `upload add` then `listAll` contains the entry with `contentHash === await contentHash(data)`.
  - `upload add` on an existing path → `RevConflictError`; same for `'A.md'` then `'a.md'` (case-insensitive).
  - `upload update(staleRev)` → `RevConflictError`; `update(currentRev)` → returns a new `rev`.
  - `listChanges(cursor)` after an upload and a delete returns one `upsert` and one `deleted`.
  - `delete(path, staleRev)` → `RevConflictError`; `delete(missingPath, null)` resolves.
  - `move` returns entry at new path; old path absent from `listAll`.
  - `createFolder` twice resolves.
  - `downloadRev(path, oldRev)` returns the old bytes.
  - `'Notes/Café 😀.md'` round-trips through upload/download with identical bytes and path.
- [ ] **Step 2: Write the StateStore contract suite** covering: `commit` then `loadBase` keyed by `toKey`; `commit(rec, 'text')` then `getBaseText`; `commit(rec)` keeps existing text; `commit(rec, null)` drops it; `remove` drops both; `applyRemoteChanges` upsert/delete/reset semantics and cursor stored in `getMeta()`; `appendLog` keeps newest `keep` entries newest-first; `reset()` clears everything except log; `getMeta().schemaVersion === 1` on a fresh store.
- [ ] **Step 3: Wire suites** to `FakeDropbox` and `MemoryStateStore` in the two `*.contract.test.ts` files; add `FakeVault.test.ts` asserting `write` creates parents, `failAfter` throws on the right call, and `stat` returns `null` for missing paths.
- [ ] **Step 4: Run** `npx vitest run test/unit` — Expected: FAIL (implementations missing).
- [ ] **Step 5: Implement** types, errors, interfaces and the three fakes.
- [ ] **Step 6: Run** — Expected: PASS.
- [ ] **Step 7: Commit** `feat: core interfaces, errors and in-memory fakes`

---

### Task 6: IndexedDB state store

**Files:**
- Create: `src/state/IdbStateStore.ts`
- Test: `test/unit/IdbStateStore.test.ts`

**Interfaces:**
- Consumes: `StateStore` (Task 5).
- Produces: `IdbStateStore.open(dbName: string): Promise<IdbStateStore>`. Object stores: `files` (key = `toKey(path)`), `bases`, `remote`, `meta`, `log`. `commit` writes `files` + `bases` in one transaction; `applyRemoteChanges` writes `remote` + `meta.cursor` in one transaction. Schema version 1.

- [ ] **Step 1: Write the failing test**

```ts
import 'fake-indexeddb/auto';
describeStateStoreContract('IdbStateStore', () => IdbStateStore.open(`t-${Math.random()}`));
test('persists across instances with the same name', async () => {
  const a = await IdbStateStore.open('same');
  await a.commit({ path: 'A.md', isFolder: false, size: 1, mtime: 1, contentHash: 'h', rev: 'r1', serverModified: 1 }, 'x');
  const b = await IdbStateStore.open('same');
  expect((await b.loadBase()).get('a.md')?.rev).toBe('r1');
  expect(await b.getBaseText('A.md')).toBe('x');
});
test('different names are isolated', async () => {
  const a = await IdbStateStore.open('v1'); const b = await IdbStateStore.open('v2');
  await a.setMeta({ cursor: 'c' });
  expect((await b.getMeta()).cursor).toBeNull();
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with `idb`'s `openDB`. **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: IndexedDB state store`

---

### Task 7: Snapshot

**Files:**
- Create: `src/engine/snapshot.ts`
- Test: `test/unit/snapshot.test.ts`

**Interfaces:**
- Consumes: `LocalStore`, `RemoteStore`, `StateStore`, `PathFilter`, `Hasher`, `toKey`.
- Produces:
```ts
export interface LocalItem extends LocalFile { contentHash: string | null } // null for folders
export interface Snapshot {
  base: Map<string, BaseRecord>; local: Map<string, LocalItem>; remote: Map<string, RemoteEntry>;
  skipped: string[]; caseCollisions: string[][]; remoteReset: boolean;
}
export interface SnapshotDeps { local: LocalStore; remote: RemoteStore; state: StateStore; filter: PathFilter; hash: Hasher }
export async function takeSnapshot(deps: SnapshotDeps): Promise<Snapshot>
```

Algorithm:
1. Remote: if `meta.cursor` is null → `listAll()` and `applyRemoteChanges(entries as upserts, cursor, true)`. Otherwise `listChanges(cursor)` → `applyRemoteChanges(changes, cursor, false)`; on `CursorResetError` do the `listAll` path and set `remoteReset = true`. Then `remote = loadRemoteIndex()`.
2. Local: `list()`. Group by `toKey`; keys with more than one local path go to `caseCollisions` and are removed from all three views.
3. Hash shortcut: for files whose `size` and `mtime` equal the base record, reuse `base.contentHash`; otherwise hash the file. If the hash equals the base hash, commit the base record with the new `mtime` (no text change).
4. Skips: a key is skipped if its path fails `filter.isPathSynced(path, isFolder)` or **any** side's size fails `filter.isSizeAllowed`. Skipped keys are removed from `base`, `local` and `remote` views (not from the DB) and listed in `skipped`.

- [ ] **Step 1: Write the failing tests** (use fakes; `seed()` helper syncs a known base via `state.commit`):
  - `'unchanged file is not re-hashed'`: spy hasher; base with equal size/mtime → hasher not called; `local.get('a.md').contentHash === base hash`.
  - `'touched but identical file keeps base hash and refreshes mtime'`: mtime differs, content same → `state.loadBase()` record has the new mtime.
  - `'first run lists all, later runs use stored cursor'`: spy `listAll`/`listChanges` call counts across two snapshots.
  - `'cursor reset falls back to full listing'`: `dropbox.expireCursors()` → `remoteReset === true`, remote view complete.
  - `'excluded path disappears from all views'`: base + local + remote contain `Archive/a.md`; filter excludes `Archive/**` → absent from all three maps, present in `skipped`.
  - `'oversized local file is skipped on all sides'`: base and remote have `big.pdf` (small), local version is 60 MB → absent from all three maps.
  - `'NFD local and NFC remote are one key'`: local `Café.md` in NFD, remote in NFC → one key in each map.
  - `'case collision is reported and skipped'`: local `A.md` and `a.md` → `caseCollisions` has both, neither in `local`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: sync snapshot`

---

### Task 8: Planner

**Files:**
- Create: `src/engine/planner.ts`
- Test: `test/unit/planner.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `LocalItem` (Task 7), `isMarkdown`, `parentDir`.
- Produces:
```ts
export type Action =
  | { kind: 'mkdirLocal'; path: string } | { kind: 'mkdirRemote'; path: string }
  | { kind: 'moveRemote'; from: string; to: string } | { kind: 'moveLocal'; from: string; to: string }
  | { kind: 'upload'; path: string; mode: WriteMode }
  | { kind: 'download'; path: string; remote: RemoteEntry }
  | { kind: 'record'; path: string }                                      // equal content, refresh record
  | { kind: 'merge'; path: string }
  | { kind: 'conflict'; path: string; strategy: 'copy' | 'newerWins' }
  | { kind: 'deleteRemote'; path: string; rev: string | null }
  | { kind: 'deleteLocal'; path: string }
  | { kind: 'dropRecord'; path: string }
  | { kind: 'rmdirLocal'; path: string } | { kind: 'rmdirRemote'; path: string }
  | { kind: 'skip'; path: string; reason: string };
export interface PlanInput { snapshot: Snapshot; renameHints: Array<{ from: string; to: string }>; isConfigPath: (p: string) => boolean }
export function plan(input: PlanInput): Action[]
```

Rules:
- Changed: `localChanged = local.contentHash !== base.contentHash`; `remoteChanged = remote.contentHash !== base.contentHash`. Uploads over an existing remote use `update(remote.rev)`; new remote files use `add`.
- Decision table: spec §4.2 verbatim. Both changed with different hashes: config path → `conflict newerWins`; `.md` → `merge`; else `conflict copy`. No base, both present, different: config → `newerWins`, else `copy`.
- Folders: existence only; mkdir on the missing side, rmdir when deleted on one side and unchanged on the other; type mismatch (file vs folder at one key) → `skip`.
- Renames: pair a one-sided delete with a one-sided create on the **same** side having equal `contentHash` → `moveRemote` (local rename) or `moveLocal` (remote rename). If several candidates share a hash, pair only those named by `renameHints`; others stay delete + create.
- Output order: `mkdir*` (shallowest first) → `move*` → `upload`/`download`/`record` → `merge`/`conflict` → `deleteLocal`/`deleteRemote` → `dropRecord` → `rmdir*` (deepest first) → `skip`.

- [ ] **Step 1: Write the failing tests.** Test helpers in the test file:
  - `snap(spec: Record<string, { base?: string; local?: string; remote?: string; baseRev?: string; remoteRev?: string; folder?: boolean }>, hints = []): PlanInput` — builds a `Snapshot` where each present side has that `contentHash` (revs default to `'r-' + hash`), `isConfigPath = p => p.startsWith('.obsidian/')`.
  - `one(s, path = 'n.md') = plan(snap({ [path]: s })).map(a => a.kind)`.

```ts
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
  expect(plan(snap({ 'p.png': { base: 'h0', local: 'h1', remote: 'h2' } }))[0]).toMatchObject({ kind: 'conflict', strategy: 'copy' }));
test('config both changed → newerWins', () =>
  expect(plan(snap({ '.obsidian/app.json': { base: 'h0', local: 'h1', remote: 'h2' } }))[0]).toMatchObject({ strategy: 'newerWins' }));
test('upload over remote uses remote rev', () =>
  expect(plan(snap({ 'n.md': { base: 'h0', baseRev: 'r0', local: 'h1', remote: 'h0', remoteRev: 'r5' } }))[0])
    .toMatchObject({ kind: 'upload', mode: { kind: 'update', rev: 'r5' } }));
test('local rename is one moveRemote', () =>
  expect(plan(snap({ 'a.md': { base: 'h0', remote: 'h0' }, 'b.md': { local: 'h0' } }))).toEqual([{ kind: 'moveRemote', from: 'a.md', to: 'b.md' }]));
test('remote rename is one moveLocal', () =>
  expect(plan(snap({ 'a.md': { base: 'h0', local: 'h0' }, 'b.md': { remote: 'h0' } }))).toEqual([{ kind: 'moveLocal', from: 'a.md', to: 'b.md' }]));
test('folder rename of 20 files → 20 moves, 0 deletes', () => {
  const s: Parameters<typeof snap>[0] = {};
  for (let i = 0; i < 20; i++) { s[`old/${i}.md`] = { base: `h${i}`, remote: `h${i}` }; s[`new/${i}.md`] = { local: `h${i}` }; }
  const kinds = plan(snap(s)).map(a => a.kind);
  expect(kinds.filter(k => k === 'moveRemote')).toHaveLength(20);
  expect(kinds).not.toContain('deleteRemote');
});
test('ambiguous equal hashes pair only via hints', () => {
  const s = { 'a.md': { base: 'h0', remote: 'h0' }, 'b.md': { base: 'h0', remote: 'h0' }, 'c.md': { local: 'h0' }, 'd.md': { local: 'h0' } };
  expect(plan(snap(s)).map(a => a.kind).sort()).toEqual(['deleteRemote', 'deleteRemote', 'upload', 'upload']);
  expect(plan(snap(s, [{ from: 'a.md', to: 'c.md' }, { from: 'b.md', to: 'd.md' }])))
    .toEqual([{ kind: 'moveRemote', from: 'a.md', to: 'c.md' }, { kind: 'moveRemote', from: 'b.md', to: 'd.md' }]);
});
test('ordering: deletes after transfers, rmdir deepest first', () => {
  const kinds = plan(snap({ 'x.md': { base: 'h0', remote: 'h0' }, 'y.md': { local: 'h9' },
    'd': { base: 'f', remote: 'f', folder: true }, 'd/e': { base: 'f', remote: 'f', folder: true } })).map(a => a.kind === 'rmdirRemote' ? `rmdir:${(a as any).path}` : a.kind);
  expect(kinds).toEqual(['upload', 'deleteRemote', 'rmdir:d/e', 'rmdir:d']);
});
test('file vs folder at one key → skip', () =>
  expect(one({ local: 'h1', remote: 'f', folder: true })).toEqual(['skip']));
```

For the type-mismatch case, `snap` marks only the remote side as a folder when `folder: true` and `local` holds a real hash; document that in the helper.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: sync planner`

---

### Task 9: Guardrails

**Files:**
- Create: `src/engine/guardrails.ts`
- Test: `test/unit/guardrails.test.ts`

**Interfaces:**
- Consumes: `Action` (Task 8).
- Produces:
```ts
export interface PlanSummary { uploads: number; downloads: number; moves: number; merges: number; conflicts: number;
  deletesLocal: string[]; deletesRemote: string[]; configOverwrites: string[] }
export interface GuardContext { baseCount: number; localCount: number; remoteCount: number; maxDeletes: number; maxPercent: number }
export type GuardResult = { ok: true } | { ok: false; reason: 'massChange' | 'emptyLocal' | 'emptyRemote'; summary: PlanSummary };
export function summarize(actions: Action[]): PlanSummary;
export function guard(actions: Action[], ctx: GuardContext): GuardResult;
export function withoutDeletions(actions: Action[]): Action[]; // drops deleteLocal, deleteRemote, rmdirLocal, rmdirRemote, dropRecord
```
Destructive count = `deletesLocal + deletesRemote + configOverwrites` (newer-wins conflicts). `massChange` when count `> maxDeletes` or (`baseCount > 0` and count `> baseCount * maxPercent / 100`). `emptyLocal` when `baseCount > 0 && localCount === 0` (likewise remote); empty checks take precedence.

- [ ] **Step 1: Write the failing tests**

```ts
const ctx = (p: Partial<GuardContext> = {}) => ({ baseCount: 1000, localCount: 1000, remoteCount: 1000, maxDeletes: 10, maxPercent: 10, ...p });
const dels = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'deleteRemote', path: `f${i}.md`, rev: 'r' }) as Action);
test('10 deletes ok, 11 trips', () => { expect(guard(dels(10), ctx()).ok).toBe(true); expect(guard(dels(11), ctx())).toMatchObject({ ok: false, reason: 'massChange' }); });
test('percent threshold', () => expect(guard(dels(6), ctx({ baseCount: 50 }))).toMatchObject({ ok: false, reason: 'massChange' }));
test('moves never trip', () => expect(guard(Array.from({ length: 50 }, (_, i) => ({ kind: 'moveRemote', from: `a/${i}`, to: `b/${i}` }) as Action), ctx()).ok).toBe(true));
test('empty local with base trips', () => expect(guard(dels(5), ctx({ localCount: 0 }))).toMatchObject({ reason: 'emptyLocal' }));
test('empty remote with base trips', () => expect(guard([], ctx({ remoteCount: 0 }))).toMatchObject({ reason: 'emptyRemote' }));
test('first sync never trips', () => expect(guard([], ctx({ baseCount: 0, localCount: 0 })).ok).toBe(true));
test('withoutDeletions keeps transfers', () => expect(withoutDeletions([...dels(2), { kind: 'upload', path: 'x', mode: { kind: 'add' } }]).map(a => a.kind)).toEqual(['upload']));
test('summarize counts config overwrites', () => expect(summarize([{ kind: 'conflict', path: '.obsidian/app.json', strategy: 'newerWins' }]).configOverwrites).toEqual(['.obsidian/app.json']));
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: plan guardrails`

---

### Task 10: Executor

**Files:**
- Create: `src/engine/executor.ts`
- Test: `test/unit/executor.test.ts`

**Interfaces:**
- Consumes: `Action`, `Snapshot`, `merge3`, `conflictName`, `isMarkdown`, stores, errors, `encodeText/decodeText`.
- Produces:
```ts
export interface ExecutorDeps { local: LocalStore; remote: RemoteStore; state: StateStore; hash: Hasher; now: () => Date;
  deviceName: string; configConflictDir: string; baseTextCapBytes: number; downloadConcurrency: number }
export interface RunResult { applied: Action[]; merged: string[]; conflicts: string[]; deferred: string[];
  errors: Array<{ path: string; message: string }>; fatal: null | 'offline' | 'auth' }
export async function execute(actions: Action[], snap: Snapshot, deps: ExecutorDeps,
  onProgress?: (done: number, total: number) => void): Promise<RunResult>
```

Behaviour per action (commit = `state.commit(record, text)` after the side effects succeed; `text` is the decoded content for `.md` ≤ `baseTextCapBytes`, otherwise `null`):
- `upload`: read local → `remote.upload(path, data, mode, mtime)` → commit. `RevConflictError` → `deferred`.
- `download`: `local.stat`; if the file exists and differs from `snap.local` (size or mtime) → `deferred`. Else download, write with `mtime = serverModified`, commit.
- `record`: commit from snapshot local + remote (+ text for `.md`).
- `merge`: base text from `state.getBaseText`, else `remote.downloadRev(path, base.rev)`, else handle as `conflict copy`. Clean → write locally, `upload update(remote.rev)`, commit merged text, add to `merged`. Overlap → `conflict copy`.
- `conflict copy`: download remote → write to `conflictName(path, now(), deviceName)` locally and `upload add` it (commit both records) → upload local at `path` with `update(remote.rev)` → commit. Add the copy path to `conflicts`.
- `conflict newerWins`: winner = larger of `local.mtime` and `remote.serverModified`. Loser's bytes are written to `${configConflictDir}/${conflictName(path, now(), deviceName)}`; winner propagated to the other side; commit.
- `deleteRemote`: `remote.delete(path, rev)` → `state.remove`. `RevConflictError` → `deferred`.
- `deleteLocal`: re-stat; changed since snapshot → `deferred`; else `local.trash` → `state.remove`.
- `moveRemote`/`moveLocal`: move, `state.remove(from)`, commit `to`.
- `mkdir*`: create, commit folder record. `rmdirLocal`: `rmdirIfEmpty`, remove record if removed. `rmdirRemote`: only if no record remains under the prefix, then `remote.delete(path, null)`.
- `skip`: append to `errors`.
- `InsufficientSpaceError`: append error; every later `upload`/`moveRemote`/`mkdirRemote` goes to `deferred`; downloads continue.
- `NetworkError` → stop, `fatal: 'offline'`. `AuthError` → stop, `fatal: 'auth'`. Any other error → append to `errors`, continue.
- Consecutive `download` actions run in a pool of `downloadConcurrency`; everything else is sequential in plan order.

- [ ] **Step 1: Write the failing tests** (fakes; `snapAndPlan()` helper calls `takeSnapshot` + `plan`):
  - `'upload commits record with remote rev and base text'`.
  - `'rev conflict on upload defers and leaves record'`: `dropbox.failNext('upload', new RevConflictError('a.md'))` → `deferred` = `['a.md']`, base unchanged.
  - `'download skipped when user edited during sync'`: `vault.writeText('a.md', 'typing')` after snapshot → `deferred`, local text is `'typing'`.
  - `'clean merge writes merged text on both sides and as base'`.
  - `'merge without stored base uses downloadRev'`: `state.commit(rec, null)` before; result clean.
  - `'overlap keeps local at path and remote in conflict copy'`: after execute, `vault.readText('n.md') === localText`, `vault.readText('n (conflict 2026-10-13 2142 Test).md') === remoteText`, same two files on `dropbox`.
  - `'binary conflict copy naming'`.
  - `'config newerWins: remote newer overwrites local and keeps loser in plugin conflicts dir'`: `vault.readText('.obsidian/app.json') === remoteText`; loser under `.obsidian/plugins/dropbox-vault-sync/conflicts/.obsidian/app (conflict …).json`; nothing new under `.obsidian/` except that.
  - `'deleteLocal trashes and removes record'`.
  - `'network error stops run; earlier actions stay committed'`: `failNext('upload', new NetworkError())` on the 2nd upload → `fatal: 'offline'`, first upload's record present, third absent.
  - `'insufficient space defers later uploads, downloads continue'`.
  - `'large markdown has no stored base text'`: 2 MB `.md` → `getBaseText` is `null`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: action executor`

---

### Task 11: Sync engine and multi-device simulation

**Files:**
- Create: `src/engine/SyncEngine.ts`, `test/sim/world.ts`
- Test: `test/sim/scenarios.test.ts`, `test/sim/crash.test.ts`, `test/sim/property.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces:
```ts
export interface EngineOptions { deviceName: string; maxDeletes: number; maxPercent: number; baseTextCapBytes: number; configConflictDir: string }
export interface SyncEngineDeps { local: LocalStore; remote: RemoteStore; state: StateStore; filter: PathFilter; hash: Hasher;
  now: () => Date; options: () => EngineOptions; takeRenameHints: () => Array<{ from: string; to: string }> }
export type SyncOutcome =
  | { status: 'ok'; result: RunResult }
  | { status: 'needsReview'; reason: 'massChange' | 'emptyLocal' | 'emptyRemote'; summary: PlanSummary }
  | { status: 'offline' | 'auth' | 'error'; message: string; result?: RunResult };
export class SyncEngine {
  constructor(deps: SyncEngineDeps);
  run(opts: { trigger: TriggerReason; approval?: 'all' | 'noDeletes'; onProgress?: (d: number, t: number) => void }): Promise<SyncOutcome>;
}
```
`run`: snapshot → plan → guard (skipped when `approval` given; `'noDeletes'` applies `withoutDeletions`) → execute → `setMeta({ lastSyncAt })` when not fatal → `appendLog(entry, 50)`. Case collisions and skips from the snapshot are added to the log's `errors`. Unexpected exceptions → `{ status: 'error' }` and logged.

- Produces (`test/sim/world.ts`): `createWorld(n: number, opts?)` → `{ dropbox: FakeDropbox; devices: Device[]; clock: { tick(ms: number): void } }` where `Device = { name: string; vault: FakeVault; state: MemoryStateStore; filter: PathFilter; sync(approval?): Promise<SyncOutcome>; setExcludes(globs: string[]): void }`; `syncAll(world, rounds = 4)` syncs every device in order per round (approving reviews only if `opts.autoApprove`); `assertConverged(world)` checks every device's synced files and the Dropbox root hold identical path → text maps.

- [ ] **Step 1: Write scenario tests** (`scenarios.test.ts`), each ending with `await syncAll(w); assertConverged(w)`:
  - A creates `n.md` → B has it.
  - A and B edit different lines of `n.md` → both have the merged text.
  - A and B overlap → both devices hold `n.md` and one conflict copy; the union of the two contains both edits.
  - A deletes `n.md`, B edits it → `n.md` exists with B's edit everywhere.
  - Remote changes mid-run: `dropbox.beforeWrite` hook makes B upload `n.md` once while A is uploading → no edit lost.
  - New device C with different pre-existing `n.md` joins → union: nothing deleted, conflict copy present.
  - A adds exclude `Archive/**` → `Archive/a.md` still on Dropbox and on B (Review Focus 3).
  - A disables the `core` config category after syncing `.obsidian/app.json` → file still on Dropbox and B.
  - Cursor expiry between syncs → converges.
  - 30 remote deletes from B → A's automatic run returns `needsReview` with `reason: 'massChange'`; `approval: 'noDeletes'` keeps files.
- [ ] **Step 2: Write crash tests** (`crash.test.ts`): build a 3-file divergent scenario; for every `k` from 0 to 12, create a world where A's vault uses `failAfter: k` for one run, run A (expect `status: 'error'` or `'ok'`), then clear the fault, `syncAll`, `assertConverged`, and assert every edit token still exists.
- [ ] **Step 3: Write the property test** (`property.test.ts`, `fc.assert(..., { numRuns: 200 })`): commands over 3 devices and paths `['a.md', 'b.md', 'd/c.md', 'img.png']`: `create`, `append` (adds a unique line `t<n>`), `delete`, `rename`, `sync`. Edits are append-only so tokens are only removed by user deletes. Track "allowed lost" tokens: tokens present in a file on the device that deleted it at delete time. After `syncAll`: (1) `assertConverged`; (2) every token not in "allowed lost" appears in some file on some device.
- [ ] **Step 4: Run** `npx vitest run test/sim` — Expected: FAIL (`SyncEngine` missing).
- [ ] **Step 5: Implement `SyncEngine`** and `world.ts`.
- [ ] **Step 6: Run** `npx vitest run` — Expected: all PASS. If the property test finds a counterexample, fix the engine (not the invariant) and add the shrunk case as a scenario test.
- [ ] **Step 7: Commit** `feat: sync engine with multi-device simulation tests`

---

### Task 12: Dropbox remote

**Files:**
- Create: `src/remote/http.ts`, `src/remote/DropboxRemote.ts`, `test/support/scriptedHttp.ts`, `test/support/nodeHttp.ts`
- Test: `test/unit/DropboxRemote.test.ts`, `test/contract/dropboxLive.test.ts`

**Interfaces:**
- Consumes: `RemoteStore`, errors, `toRemotePath`/`fromRemotePath`.
- Produces:
```ts
// http.ts
export interface HttpRequest { url: string; method: 'POST'; headers: Record<string, string>; body?: string | ArrayBuffer }
export interface HttpResponse { status: number; headers: Record<string, string>; text(): string; arrayBuffer(): ArrayBuffer }
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>; // throws only on network failure
// DropboxRemote.ts
export function encodeApiArg(value: unknown): string; // JSON with every non-ASCII char as \uXXXX
export class DropboxRemote implements RemoteStore {
  constructor(opts: { http: HttpClient; root: string; getAccessToken: () => Promise<string>; refreshAccessToken: () => Promise<string>;
    sleep?: (ms: number) => Promise<void>; maxRetries?: number });
}
```

Endpoints: `api.dropboxapi.com/2/files/list_folder` (`recursive: true`, follow `has_more` via `/continue`), `/files/delete_v2` (`parent_rev`), `/files/move_v2` (`autorename: false`), `/files/create_folder_v2`; `content.dropboxapi.com/2/files/upload` (arg `{ path, mode, autorename: false, mute: true, strict_conflict: true, client_modified }`, `client_modified` formatted `YYYY-MM-DDTHH:MM:SSZ`), `/files/download` (path or `rev:<rev>`, metadata from `Dropbox-API-Result` header); `notify.dropboxapi.com/2/files/list_folder/longpoll` (no `Authorization` header).

Error mapping: thrown by `http` → `NetworkError`; 401 → `refreshAccessToken()` once and retry, then `AuthError`; 429/503 → sleep `Retry-After` seconds (else `1000·2^attempt` ms + jitter) up to `maxRetries` (default 5), then `RateLimitError`; 409 by `error_summary` prefix: `path/conflict` (upload) and `path_lookup/conflict`/`from_lookup` rev mismatch (delete) → `RevConflictError`; `reset` → `CursorResetError`; `path/not_found` on download-by-rev → `NotFoundError`, on delete → success; `path/conflict/folder` on create_folder → success; anything containing `insufficient_space` → `InsufficientSpaceError`; other → `RemotePathError`. `listAll` on missing root → `createFolder('')` then empty listing. Upload larger than 150 MB → `RemotePathError` without a request.

- [ ] **Step 1: Write the failing tests** with `scriptedHttp(responses)` (records requests, returns queued responses):
  - `encodeApiArg({ path: '/Café 😀.md' })` contains `\\u00e9` and `\\ud83d\\ude00` and matches `/^[\x00-\x7f]*$/`.
  - upload `update` builds the exact `Dropbox-API-Arg` above for `'a.md'` under root `'Vault'` with `client_modified: '2026-10-13T19:42:00Z'`.
  - 409 `path/conflict/file/` on upload → `RevConflictError`.
  - 401 then success → `refreshAccessToken` called once, retried request carries the new bearer token.
  - 429 with `Retry-After: 2` → `sleep(2000)` then success.
  - `http` throws → `NetworkError`.
  - `list_folder` with `has_more: true` → follows `/continue`; entries outside the root dropped; `.tag: deleted` → `{ kind: 'deleted' }`; `server_modified` parsed to ms.
  - `/continue` 409 `reset/` → `CursorResetError`.
  - download parses an ASCII-escaped `Dropbox-API-Result` header into a `RemoteEntry` with the non-ASCII path.
  - longpoll request has no `Authorization` header and maps `{ changes, backoff }`.
  - `listAll` with 409 `path/not_found/` → `create_folder_v2` request, then empty result.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Live contract.** In `dropboxLive.test.ts`, when `process.env.DROPBOX_TEST_TOKEN` is set, run `describeRemoteStoreContract` against `DropboxRemote` with `nodeHttp` (global `fetch`) and root `contract-<timestamp>`; otherwise `describe.skip`. Run once manually with a token from the test app: `DROPBOX_TEST_TOKEN=… npx vitest run test/contract` — Expected: PASS (this also verifies `contentHash` against Dropbox).
- [ ] **Step 6: Commit** `feat: Dropbox remote store`

---

### Task 13: Dropbox OAuth (PKCE)

**Files:**
- Create: `src/auth/pkce.ts`, `src/auth/DropboxAuth.ts`
- Test: `test/unit/auth.test.ts`

**Interfaces:**
- Consumes: `HttpClient`, `AuthError`.
- Produces:
```ts
export function randomVerifier(): string;                     // 64 chars, base64url, crypto.getRandomValues
export async function challengeFor(verifier: string): Promise<string>; // base64url(SHA-256(verifier)), no padding
export const REDIRECT_URI = 'obsidian://dropbox-vault-sync-auth';
export class DropboxAuth {
  constructor(opts: { http: HttpClient; appKey: string; getRefreshToken: () => string | null;
    saveConnection: (refreshToken: string | null, accountEmail: string | null) => Promise<void>; now?: () => number });
  beginAuth(mode: 'redirect' | 'manual'): Promise<string>;   // authorize URL; keeps verifier in memory
  completeAuth(code: string): Promise<void>;                 // token exchange, then users/get_current_account for email
  getAccessToken(): Promise<string>;                         // cached until 60 s before expiry
  refreshAccessToken(): Promise<string>;
  disconnect(): Promise<void>;                               // auth/token/revoke (best effort), saveConnection(null, null)
}
```
Authorize URL: `https://www.dropbox.com/oauth2/authorize?client_id&response_type=code&code_challenge&code_challenge_method=S256&token_access_type=offline` plus `redirect_uri` only in `redirect` mode. Token endpoint: `https://api.dropboxapi.com/oauth2/token`, form-encoded.

- [ ] **Step 1: Write the failing tests**
  - `challengeFor(v)` equals `createHash('sha256').update(v).digest('base64url')` (node oracle); `randomVerifier()` matches `/^[A-Za-z0-9_-]{64}$/`.
  - authorize URL params for both modes (`redirect_uri` present/absent).
  - `completeAuth('c')` posts `grant_type=authorization_code`, `code=c`, `client_id`, `code_verifier` (and `redirect_uri` in redirect mode); saves refresh token and email.
  - `getAccessToken` twice → one token request; after advancing `now` past expiry → refresh request with `grant_type=refresh_token`.
  - refresh returns 400 `invalid_grant` → `AuthError`, `saveConnection(null, null)` called.
  - no refresh token → `getAccessToken` throws `AuthError`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: Dropbox OAuth with PKCE`

---

### Task 14: Scheduler and self-write tracking

**Files:**
- Create: `src/scheduler/Scheduler.ts`, `src/scheduler/SelfWriteTracker.ts`
- Test: `test/unit/Scheduler.test.ts`

**Interfaces:**
- Consumes: `TriggerReason`.
- Produces:
```ts
export class SelfWriteTracker { constructor(windowMs?: number /* 5000 */, now?: () => number); mark(path: string): void; isSelfWrite(path: string): boolean }
export interface TriggerSettings { onStartup: boolean; onResume: boolean; onEdit: boolean; editDebounceSec: number; interval: boolean; intervalMin: number; longpoll: boolean }
export class Scheduler {
  constructor(opts: { run: (t: TriggerReason) => Promise<void>; settings: () => TriggerSettings; isPaused: () => boolean;
    selfWrites: SelfWriteTracker; longpoll: (signal: AbortSignal) => Promise<'changed' | 'timeout' | 'error'> });
  start(): void; stop(): void;
  notifyLocalChange(path: string): void;  // ignored for self-writes; debounced
  notifyResume(): void;
  requestManual(): Promise<void>;         // ignores isPaused
  readonly running: boolean;
}
```
Mutex: one run at a time; triggers during a run set a single pending follow-up (manual takes precedence over automatic reasons). `isPaused()` suppresses all automatic triggers. Longpoll loop: `'changed'` → trigger `'remote'`; `'error'` → wait 60 s; stops on `stop()` via abort.

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`):
  - three `notifyLocalChange` calls 2 s apart → exactly one run, 10 s after the last.
  - `selfWrites.mark('a.md')` then `notifyLocalChange('a.md')` → no run; after 5 s window `notifyLocalChange('a.md')` → run (Review Focus 4).
  - trigger during a running run → exactly one follow-up run.
  - `isPaused() === true` → interval and edits produce no runs; `requestManual()` runs.
  - `interval: false` → advancing 30 min produces no runs; `true` → one run per 5 min.
  - `onStartup` → `start()` runs once with `'startup'`.
  - longpoll resolving `'changed'` → run with `'remote'`; `stop()` aborts the signal and clears timers (no runs after).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: sync scheduler`

---

### Task 15: Obsidian integration (local store, settings, wiring, status bar)

**Files:**
- Create: `src/settings.ts`, `src/obsidian/ObsidianLocalStore.ts`, `src/obsidian/obsidianHttp.ts`, `src/ui/statusText.ts`, `src/ui/StatusBar.ts`, `src/ui/SettingsTab.ts`
- Modify: `src/main.ts`
- Test: `test/unit/statusText.test.ts`, `test/unit/settings.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
```ts
// settings.ts
export interface DropboxSyncSettings {
  appKey: string; refreshToken: string | null; accountEmail: string | null;
  remoteFolder: string; deviceName: string; triggers: TriggerSettings; configSync: ConfigSyncSettings;
  excludes: string[]; maxFileSizeMB: number; baseSizeCapMB: number; guard: { maxDeletes: number; maxPercent: number }; verboseLogging: boolean;
}
export const DEFAULT_SETTINGS: DropboxSyncSettings; // values per Global Constraints; appKey = shipped key constant
export function defaultDeviceName(p: { isIosApp: boolean; isAndroidApp: boolean; isTablet: boolean }): 'iPhone' | 'iPad' | 'Android' | 'Desktop';
export function clampMaxFileSizeMB(n: number): number; // 1..150
// ui/statusText.ts
export type StatusState = { kind: 'idle'; lastSyncAt: number | null } | { kind: 'syncing'; done: number; total: number }
  | { kind: 'offline' } | { kind: 'needsReview' } | { kind: 'error'; message: string } | { kind: 'reauth' } | { kind: 'disconnected' };
export function statusText(s: StatusState, now: number): string;
// obsidian/ObsidianLocalStore.ts
export class ObsidianLocalStore implements LocalStore { constructor(app: App, selfWrites: SelfWriteTracker) }
// obsidian/obsidianHttp.ts
export const obsidianHttp: HttpClient; // requestUrl({ ..., throw: false })
```
Status text: `Dropbox: ✓ 2m ago` / `Dropbox: ✓` (never synced) / `Dropbox: ⟳ 12/40` / `Dropbox: offline` / `Dropbox: ⚠ Needs review` / `Dropbox: ✕ <message>` / `Dropbox: ⚠ Re-authenticate` / `Dropbox: not connected`.

`ObsidianLocalStore`: `list` walks `adapter.list` from the vault root; `stat` via `adapter.stat`; `read` via `adapter.readBinary`; `write` marks the path in `selfWrites`, creates parents with `adapter.mkdir`, uses `vault.process` for `.md` files present in the vault index (so open editors reload), else `adapter.writeBinary(path, data, { mtime })`; `trash` uses `app.fileManager.trashFile` for indexed files (honours the user's trash setting), else `adapter.trashLocal`; `rename` uses `vault.rename` for indexed files (no link updating), else `adapter.rename`; marks both paths.

`main.ts` wiring: load settings (resolve empty `remoteFolder` to vault name and empty `deviceName` via `defaultDeviceName(Platform)`); build `DropboxAuth`, `DropboxRemote`, `IdbStateStore.open(\`dropbox-vault-sync-${this.app.appId}\`)`, `PathFilter` (`configDir = vault.configDir`, `pluginDir = this.manifest.dir`), `SyncEngine`, `Scheduler`. `registerObsidianProtocolHandler('dropbox-vault-sync-auth', p => auth.completeAuth(p.code))`. Vault `create`/`modify`/`delete`/`rename` → `scheduler.notifyLocalChange`; `rename` also pushes a rename hint. `registerDomEvent(window, 'focus')` and `document` `visibilitychange` (visible) → `notifyResume`. Start the scheduler in `workspace.onLayoutReady`. Run outcome → status bar state; `needsReview` sets the paused flag and stores the outcome; `auth` → `reauth`; a non-empty `result.conflicts` shows a `Notice` ("N sync conflicts — run 'Show conflicts'"). Commands: `sync-now`, `show-conflicts`, `open-sync-log`, `reset-sync-state` (confirm modal, then `state.reset()`). Status bar click → review modal when paused, else manual sync. Settings tab sections per spec §10 (connect button opens `beginAuth('redirect')` URL; a "Paste code" field uses `manual` mode; workspace toggle shows the churn warning; Advanced has a "Custom Dropbox app key" field that overrides the shipped key and requires reconnecting).

- [ ] **Step 1: Write the failing tests** for `statusText` (one assertion per state, `idle` with `now - 120_000` → `'Dropbox: ✓ 2m ago'`), `defaultDeviceName` (4 cases), `clampMaxFileSizeMB(500) === 150`, `clampMaxFileSizeMB(0) === 1`, and `DEFAULT_SETTINGS` values (`triggers.editDebounceSec === 10`, `triggers.intervalMin === 5`, `maxFileSizeMB === 50`, `baseSizeCapMB === 1`, `guard` `{ maxDeletes: 10, maxPercent: 10 }`, all `configSync` false).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** all files above. **Step 4: Run** `npx vitest run && npm run build && npm run lint:imports` — PASS.
- [ ] **Step 5: Manual check (desktop).** Copy `main.js`, `manifest.json`, `styles.css` into `<test vault>/.obsidian/plugins/dropbox-vault-sync/`, enable the plugin, connect a Dropbox test account, create a note → it appears under `Apps/<app>/<vault>/` on dropbox.com; edit it on dropbox.com → it updates in Obsidian within one interval/longpoll; status bar shows `✓`.
- [ ] **Step 6: Commit** `feat: Obsidian integration, settings and status bar`

---

### Task 16: Review modal, conflicts list, sync log view

**Files:**
- Create: `src/ui/summaryText.ts`, `src/ui/conflicts.ts`, `src/ui/ReviewModal.ts`, `src/ui/ConflictsModal.ts`, `src/ui/SyncLogView.ts`
- Modify: `src/main.ts` (open these from commands/status bar)
- Test: `test/unit/ui-pure.test.ts`

**Interfaces:**
- Consumes: `PlanSummary`, `SyncLogEntry`, `StateStore.getLog`.
- Produces:
```ts
export function summaryLines(reason: 'massChange' | 'emptyLocal' | 'emptyRemote', s: PlanSummary): string[];
export function findConflictCopies(paths: string[]): string[]; // matches / \(conflict \d{4}-\d{2}-\d{2} \d{4} [^)]+\)(\.[^/]*)?$/
export class ReviewModal extends Modal { constructor(app: App, reason: ..., summary: PlanSummary, onChoose: (c: 'all' | 'noDeletes' | 'cancel') => void) }
export class ConflictsModal extends SuggestModal<string> { /* lists findConflictCopies(vault files); choosing opens the file */ }
export const SYNC_LOG_VIEW = 'dropbox-vault-sync-log'; export class SyncLogView extends ItemView {}
```
`summaryLines`: first line explains the reason — `emptyLocal`: "Your local vault appears empty, but N files were synced before. Applying would delete them from Dropbox."; `emptyRemote`: the mirror for Dropbox; `massChange`: "This sync would delete or overwrite N files." — then counts, then up to 200 paths for deletions and config overwrites, then `…and N more`.

- [ ] **Step 1: Write the failing tests**: `findConflictCopies` matches `'a/Note (conflict 2026-10-13 2142 iPhone).md'` and `'.gitignore (conflict 2026-10-13 2142 Desktop)'`, rejects `'Note (conflict notes).md'`; `summaryLines('massChange', …)` with 250 remote deletes has 200 path lines and ends with `'…and 50 more'`; `emptyLocal` first line contains the base count.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**; wire `ReviewModal` choices to `engine.run({ trigger: 'manual', approval })` and clear the paused flag on `all`/`noDeletes`. **Step 4: Run** tests + `npm run build` — PASS.
- [ ] **Step 5: Manual check**: delete 15 files on dropbox.com → status bar shows `⚠ Needs review`; modal lists them; "Apply without deletions" restores normal status and keeps files locally.
- [ ] **Step 6: Commit** `feat: review modal, conflicts list and sync log`

---

### Task 17: Release preparation

**Files:**
- Create: `README.md`, `docs/dropbox-app-setup.md`, `docs/release-checklist.md`, `.github/workflows/release.yml`
- Modify: `versions.json`, `manifest.json` (version `0.1.0`)

- [ ] **Step 1: `docs/dropbox-app-setup.md`** (for the author): create a Scoped, App-folder app; permissions `files.metadata.read`, `files.metadata.write`, `files.content.read`, `files.content.write`, `account_info.read`; enable PKCE / public client; add redirect URI `obsidian://dropbox-vault-sync-auth` (if the console rejects the custom scheme, ship with manual code-paste only and say so in README); put the app key in `DEFAULT_SETTINGS.appKey`; apply for production before 50 users.
- [ ] **Step 2: `README.md`**: what it does; each user connects their own Dropbox and files live in `Apps/<app>/<vault>`; the author never sees data or tokens; setup on each device; conflict copies; guardrails and the review modal; `.obsidian` categories and the workspace warning; limitations (no encryption, 150 MB file cap, syncs only while Obsidian is open); custom app key option.
- [ ] **Step 3: `docs/release-checklist.md`**: manual matrix for Desktop + iOS + Android — OAuth redirect and manual code, first sync of an existing vault (union, nothing deleted), edit on phone → desktop, background then resume, airplane mode edits then reconnect, 30 MB attachment, overlapping edit → conflict copy, rename a folder of 20 notes (no review prompt), non-ASCII filename (`Café 😀.md`), review modal on a phone screen.
- [ ] **Step 4: Release workflow**: on tag push, `npm ci && npm test && npm run build`, create a GitHub release attaching `main.js`, `manifest.json`, `styles.css`.
- [ ] **Step 5: Verify** `npm ci && npm test && npm run build && npm run lint:imports` — all succeed.
- [ ] **Step 6: Commit** `docs: README, Dropbox app setup, release checklist and workflow`
