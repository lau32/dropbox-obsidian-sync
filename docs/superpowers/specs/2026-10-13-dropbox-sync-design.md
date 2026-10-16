# Dropbox Sync for Obsidian — Design

Date: 2026-10-13
Status: Draft, awaiting review

## 1. Purpose

An Obsidian community plugin that syncs a vault two-way with Dropbox, working on desktop **and mobile** (iOS/Android). The Dropbox desktop client cannot sync a vault on mobile; this plugin fills that gap and is intended for publication in the community plugin directory.

### Success criteria

- An edit on one device appears on the others within seconds to minutes while Obsidian is open on both.
- No edit is ever silently lost: every written version survives at its path, in a merge result, or in a conflict copy, unless the user explicitly deleted it.
- Works identically on desktop, iOS and Android.

### Decisions

| Topic | Decision |
|---|---|
| Topology | Plugin runs on every device; it is the only writer to the Dropbox folder. External edits (e.g. dropbox.com) are tolerated, not optimized for. |
| Conflicts | 3-way merge for Markdown; conflict copy on overlap and for binaries. |
| Triggers | Startup, app resume, debounced local edits, interval poll, remote longpoll, manual. Each toggleable. |
| Scope | Notes + attachments, plus opt-in per-category `.obsidian/` sync; exclude globs; size limit. |
| Encryption | Not in v1; `RemoteStore` is an interface so an encrypting decorator can be added later. |
| Deletion safety | Mass-change threshold with review, union-mode first sync, empty-side protection. |
| Engine | State-based reconciliation (not an operation journal, not a shared remote manifest). |

### Out of scope (v1)

Encryption, real-time co-editing, multi-user shared vaults, storage providers other than Dropbox, selective/on-demand download of files.

## 2. Platform constraints

- No Node `fs`, `child_process`, or background execution on mobile. All file I/O goes through `app.vault` / `app.vault.adapter`; all HTTP through Obsidian's `requestUrl` (consistent behavior, no CORS issues).
- Obsidian may be suspended or killed at any time on mobile; correctness cannot depend on receiving every vault event or completing a sync.
- `.obsidian/` files are not visible via the `Vault` file API; they are accessed with `vault.adapter`.
- Hashing uses `crypto.subtle` (available on all platforms).

## 3. Architecture

```
src/
  main.ts            Plugin lifecycle, commands, status bar, wiring
  auth/              Dropbox OAuth 2 PKCE, offline refresh token, token refresh
  remote/
    RemoteStore.ts   Interface: listAll, listChanges(cursor), longpoll(cursor),
                     download(path | rev), upload(path, data, mode), delete, move, createFolder
    DropboxRemote.ts Implementation over requestUrl; retry/backoff; upload sessions for large files
  local/
    LocalStore.ts    Interface over vault.adapter: list, stat, read, write, process (md), trash, rename, mkdir
  filter/            isSynced(path, size): excludes, size limit, .obsidian categories,
                     always excludes this plugin's own folder
  hash/              Dropbox content_hash (SHA-256 of concatenated SHA-256s of 4 MB blocks)
  state/             IndexedDB: per-file records, cursor, merge bases, schema version
  engine/
    snapshot.ts      Builds local and remote views
    planner.ts       Pure: (base, local, remote) -> Plan (list of actions)
    guardrails.ts    Pure: Plan + context -> ok | needs-review(reason, summary)
    executor.ts      Applies actions; commits state after each successful action
  merge/             3-way text merge (node-diff3)
  scheduler/         Triggers, debounce, single-run mutex with coalescing
  ui/                Settings tab, status bar, review modal, conflicts list, sync log view
```

Principles:

- `planner` and `guardrails` are pure functions with no I/O.
- The engine depends only on `LocalStore` and `RemoteStore` interfaces, enabling in-memory fakes for testing and a future encryption decorator around `RemoteStore`.
- The executor commits state per action, never per sync, so interrupted syncs resume correctly.

### Authentication

- Each user connects **their own Dropbox account**; their vault is stored in their own Dropbox under `/Apps/<app name>/`. The plugin author never has access to user files or tokens — there is no server and no client secret.
- The plugin author registers one Dropbox app and ships its app key (public client, PKCE, no secret); the key only identifies the app on Dropbox's consent screen. End users register nothing. Access type: **App folder**. The app must be submitted for Dropbox production approval before it exceeds 50 linked users. An advanced setting allows a custom app key for users who prefer their own.
- Redirect via `registerObsidianProtocolHandler` (`obsidian://dropbox-vault-sync-auth`) on desktop and mobile (with PKCE verifier persisted across app suspension); fallback is the no-redirect flow where the user pastes the authorization code.
- `token_access_type=offline` yields a refresh token. Access tokens refresh automatically on 401 or before expiry.
- Tokens stored in the plugin's `data.json`. The plugin's folder is always excluded from sync, so tokens and state stay per device.

### Remote layout

Remote root is `/<remote folder>` inside the app folder; the remote folder defaults to the vault name and is configurable. The remote folder holds a plain mirror of the vault — no plugin metadata files.

### Local state (IndexedDB)

Database name derived from vault identity (`app.appId`) so multiple vaults on one device are independent.

- `files` store, keyed by lowercased path: `{ path (original case), size, mtime, contentHash, rev, serverModified, isFolder }` — the last synced state ("base").
- `bases` store: merge base text for `.md` files up to the base-size cap (default 1 MB).
- `meta` store: `{ cursor, schemaVersion, lastSyncAt, deviceName }`.
- `log` store: last N sync runs with their actions, merges, conflicts and errors.

## 4. Sync algorithm

Each run: **snapshot → plan → guard → execute**.

### 4.1 Snapshot

**Local.** List all paths passing the filter. A file is unchanged if `mtime` and `size` equal the base record. Otherwise compute `content_hash`; if equal to the base hash, it is unchanged (update stored mtime only). This prevents false changes from unreliable mobile mtimes.

**Remote.** First run: full recursive `list_folder`. Subsequent runs: `list_folder/continue` from the stored cursor; the remote view is the base overlaid with the deltas. On `reset`, do a full listing.

**Case.** Paths are keyed by lowercase (Dropbox is case-insensitive). Local paths differing only in case are reported and skipped.

### 4.2 Plan

For each path, with B = base record, L = local, R = remote:

| B | L | R | Action |
|---|---|---|---|
| – | present | – | upload (mode `add`) |
| – | – | present | download |
| – | present | present | equal hash → record only; else conflict copy (no base) |
| ✓ | changed | unchanged | upload (mode `update(B.rev)`) |
| ✓ | unchanged | changed | download |
| ✓ | changed | changed | equal hash → record; `.md` → 3-way merge; else conflict copy |
| ✓ | deleted | unchanged | delete remote |
| ✓ | unchanged | deleted | delete local (trash) |
| ✓ | deleted | changed | download (edit beats delete) |
| ✓ | changed | deleted | upload (edit beats delete) |
| ✓ | deleted | deleted | drop record |

**Renames.** A delete and a create with the same `content_hash` on the same side, within one run, become a single `move` action on the other side. Local `rename` vault events are recorded as hints to make pairing reliable. Without pairing, delete + upload is still correct.

**Folders.** Folders are tracked as records. Empty folders are created on the other side; a folder deleted on one side is deleted on the other only if it is empty after file actions.

### 4.3 Guard

See §6.

### 4.4 Execute

Order: create folders → uploads/downloads/moves → merges → deletions → remove empty folders. Deletions run last so an interrupted run leaves extra files, never missing ones.

Concurrency:

- Uploads to existing files use `mode: update(rev)`. A rev mismatch means the remote changed after snapshot; the action is abandoned and the path re-planned next run.
- Before writing a download, re-stat the local file. If it changed since snapshot, skip; the next run handles it.
- Markdown writes use `vault.process` (or `vault.modify` for files not in the `Vault` index), so open editors reload cleanly.
- After each successful action the corresponding record (and base text for `.md`) is committed in one IndexedDB transaction.
- The cursor is committed only after all remote-side deltas it covers have been applied or recorded as errored.

Concurrency limits: ~4 parallel downloads, uploads serialized (Dropbox namespace write lock).

## 5. Conflicts and merging

### Markdown (3-way merge)

1. Obtain base text: from the `bases` store; if missing, download `rev:<B.rev>` from Dropbox (revisions retained ≥ 30 days); if unavailable, fall back to a conflict copy.
2. Normalize line endings; run a line-based 3-way merge (node-diff3) of base, local, remote.
3. **Clean merge:** write merged text locally, upload with `update(R.rev)`, store merged text as new base.
4. **Overlap:** local version stays at the original path; remote version is written as `<name> (conflict YYYY-MM-DD HHmm <device>).md`. Both sync normally. A Notice is shown. No conflict markers are inserted into notes.

### Binary files

Both changed: local stays at the path; remote saved as a conflict copy with the same naming scheme.

### `.obsidian/` config files

Newer wins (local `mtime` vs Dropbox `server_modified`). The loser is saved under the plugin's own `conflicts/` folder (excluded from sync) and logged. Conflict copies are never written inside `.obsidian/`.

### Visibility

- Setting: device name used in conflict filenames (default by platform: "iPhone", "iPad", "Android", "Desktop").
- Command "Show conflicts": lists conflict copies still present in the vault. Deleting a copy resolves it.
- Sync log records every merge and conflict.

## 6. Guardrails

Applied to every plan by `guardrails.ts`:

- **Mass-change threshold.** If the plan deletes or overwrites more than **10 files or 10%** of synced files (both configurable), the run pauses.
  - Manual sync: opens the review modal (counts + file list) with **Apply**, **Apply without deletions**, **Cancel**.
  - Automatic sync: no modal; status bar shows "⚠ Needs review"; clicking it opens the modal. Further automatic runs stay paused until reviewed.
- **First sync / after state reset: union mode.** No deletions in either direction; identical files are recorded; differing files become conflict copies.
- **Empty-side protection.** If either the local or remote listing is empty while the state has records, block and require explicit confirmation.
- **Recoverable deletes.** Local deletions use `vault.trash` honoring the user's trash preference; remote deletions remain restorable from Dropbox.

## 7. Triggers and scheduling

All toggleable in settings; defaults shown.

| Trigger | Default |
|---|---|
| On startup (after layout ready) | on |
| On app resume / window focus | on |
| After local edits, debounced | on, 10 s |
| Interval poll | on, 5 min |
| Remote longpoll (`list_folder/longpoll`) while app is foregrounded | on |
| Manual: command + status bar click | always available |

A mutex ensures one run per device. Triggers during a run coalesce into a single follow-up run.

## 8. Filtering

- Always synced: vault files outside `.obsidian/` that pass excludes and the size limit.
- Always excluded: this plugin's folder, `.trash/`, OS junk (`.DS_Store`, `Thumbs.db`).
- `.obsidian/` categories, each opt-in (default off):
  - Core settings (`app.json`, `appearance.json`, `core-plugins.json`, `hotkeys.json`, …)
  - Themes and CSS snippets
  - Community plugin list and plugin folders
  - Workspace layout (`workspace*.json`) — off by default with a churn warning
- User exclude globs (e.g. `Archive/**`, `*.mov`).
- Max file size (default 50 MB). Files above are skipped and logged.

## 9. Error handling

| Situation | Behavior |
|---|---|
| Offline / network error | Abort run quietly; status "Offline"; retry on next trigger. Completed actions persist. |
| 429 / `too_many_write_operations` | Honor `Retry-After`; exponential backoff with jitter. |
| 401 | Refresh token; if refresh fails, stop syncing and show "Re-authenticate". |
| Per-file error (invalid name, path conflict, local write failure) | Mark errored, skip, log, continue. Retried next run. |
| `insufficient_space` | Stop uploads, continue downloads, notify. |
| App killed mid-run | Per-action commits make the next run resume correctly. |
| Corrupt or outdated state | Schema versioning with migrations; command "Reset sync state" rebuilds via union mode. |

Status bar states: idle (last sync time), syncing (n/m), offline, needs review, error, re-authenticate.

## 10. Settings

- Dropbox account: connect / disconnect, connected account email.
- Remote folder name.
- Device name.
- Trigger toggles and intervals (§7).
- `.obsidian/` category toggles (§8).
- Exclude globs; max file size; merge base size cap.
- Guardrail thresholds (count and percent).
- Advanced: reset sync state, open sync log, verbose logging.

## 11. Testing

Tooling: TypeScript, esbuild (from `obsidian-sample-plugin`), Vitest, fast-check.

- **Unit:** planner (every table row plus case-only renames, rename + edit, folder ↔ file), merge (clean, overlap, CRLF/LF, frontmatter, empty base), hash (Dropbox's published `content_hash` test vector), filter, guardrails.
- **Multi-device simulation:** `FakeDropbox` (revs, cursors, `update(rev)` rejection, longpoll) and N `FakeVault`s with independent state DBs.
  - Scenario tests: concurrent edits, delete-vs-edit races, remote change between snapshot and execute.
  - Crash tests: executor throws at action k for every k; next run must converge.
  - Property tests: random create/edit/rename/delete across 2–3 devices interleaved with syncs, then sync to quiescence. Invariants: (1) all devices converge to identical content; (2) every written version survives at a path, in a merge, or in a conflict copy, unless explicitly deleted.
- **Contract tests:** one suite run against `FakeDropbox` and, opt-in via env token, a real Dropbox test app folder.
- **Manual release checklist:** desktop + real iOS/Android device — OAuth, background/resume, offline → online, large attachment, review modal on small screens.

## 12. Future (not v1)

- Encryption as a `RemoteStore` decorator (encrypted names and content, local name map).
- Batched uploads via `upload_session/finish_batch` for large initial syncs.
- Additional storage providers implementing `RemoteStore`.
