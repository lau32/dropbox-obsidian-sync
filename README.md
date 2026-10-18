# Dropbox Vault Sync

A privacy-first Obsidian community plugin for two-way synchronization between an Obsidian vault and your own Dropbox account across Desktop, iOS, and Android.

---

## Features

- **State-Based Reconciliation:** Pure 3-way reconciliation tracks base state, local vault state, and Dropbox remote state.
- **3-Way Markdown Text Merge:** Automatically reconciles non-overlapping edits to Markdown notes without producing duplicate files.
- **Conflict Handling:** Overlapping concurrent edits generate clearly named conflict copies: `Note (conflict YYYY-MM-DD HHMM Device).md`. Quickly view and open all vault conflicts with the **Show conflicts** command.
- **Deletion Guardrails:** Protects your data against accidental mass deletions, folder moves, or connecting an empty vault. A guardrail prompt pauses sync and presents a **Review Modal** offering options to review changed paths, apply without deletions, or cancel.
- **Selective Config Sync:** Independently sync hotkeys, snippets, themes, and plugins under `.obsidian/` while protecting device-specific files like `workspace.json`.
- **Zero-Intermediary Privacy:** Direct communication between Obsidian and Dropbox via official HTTPS endpoints. No proxy servers, no third-party telemetry, and no author access to your notes or tokens.
- **PKCE OAuth 2:** Secure client-side authorization using PKCE (no embedded client secret), with automatic token refresh and manual code-paste fallback for mobile devices.

---

## Getting Started

### 1. Installation
Install **Dropbox Vault Sync** from the Obsidian Community Plugins directory (or manually copy `main.js`, `manifest.json`, and `styles.css` into your vault under `.obsidian/plugins/dropbox-vault-sync/`).

### 2. Connect Your Dropbox Account
1. Open **Settings → Community Plugins → Dropbox Vault Sync**.
2. Click **Connect to Dropbox**.
3. A browser window will open requesting authorization.
4. Once authorized:
   - On Desktop: The browser will redirect to `obsidian://dropbox-vault-sync-auth` and connect automatically.
   - On Mobile / Fallback: If redirects are disabled, copy the authorization code from the browser and paste it into the **Manual Auth Code** field in settings.
5. Your files will sync to your Dropbox folder under `Apps/<App-Name>/<Vault-Name>/`.

### 3. Setup on Additional Devices
Repeat the installation and connection steps on your other desktop, phone, or tablet devices. The first sync on an existing vault automatically unions files from both locations without data loss.

---

## Conflicts & Resolution

- **Non-conflicting edits:** If two devices edit different sections of the same Markdown note, the plugin automatically performs a 3-way merge.
- **Conflicting edits:** If both devices modify the same lines or edit binary files concurrently, the local file is preserved and the remote file is saved as:
  ```
  Note (conflict 2026-10-13 2142 iPhone).md
  ```
- Use the command palette (`Ctrl/Cmd + P`) and run **Dropbox Vault Sync: Show conflicts** to list and jump to any conflict files in your vault.

---

## Guardrails & Review Modal

To prevent catastrophic accidental deletions (for example, if a folder is deleted externally or a device syncs an empty vault):
- If deletions exceed either a fixed count (default 10) or a percentage of the vault (default 10%), sync is paused and the status bar displays `⚠ Needs review`.
- Click the status bar or run **Dropbox Vault Sync: Review pending sync** to open the **Review Modal**:
  - **Apply all changes:** Proceeds with deletions and updates.
  - **Apply without deletions:** Restores deleted files and keeps existing copies intact.
  - **Cancel:** Leaves sync paused for manual inspection.

---

## Configuration & Category Sync

Under plugin settings, you can fine-tune what parts of the `.obsidian/` folder sync:
- **Appearance & Themes:** `themes/`, `snippets/`
- **Hotkeys:** `hotkeys.json`
- **Core Plugins & Settings:** `core-plugins.json`, `app.json`
- **Community Plugins:** `plugins/`
- **Excludes:** Add custom glob patterns (e.g. `archive/**`, `*.tmp`).

> [!WARNING]
> `workspace.json` and `workspace-mobile.json` store device-specific pane layouts and window sizes. These files are excluded by default to avoid desktop and mobile layouts overwriting each other.

---

## Limitations

- **File Size Cap:** Files larger than the configurable cap (default 150 MB) are skipped to preserve device memory and stay within standard Dropbox single-request upload limits.
- **Client-Side Sync:** Synchronization runs while the Obsidian app is running; background sync is supported upon app resume/focus.
- **Encryption:** Files are stored in standard format within your Dropbox account (encrypted in transit and at rest by Dropbox, but not end-to-end encrypted with zero-knowledge keys).

---

## Custom Dropbox App Key

By default, the plugin connects using a shared community client ID. If you prefer to use your own private Dropbox Developer App:
1. Follow the [Dropbox App Setup Guide](docs/dropbox-app-setup.md) to create an App folder app.
2. In the plugin settings, toggle **Use Custom App Key** and enter your App Key.

---

## License

MIT License.
