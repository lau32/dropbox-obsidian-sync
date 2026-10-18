# Dropbox App Setup Guide

Dropbox Vault Sync ships **no** Dropbox app key and no secret. Each user registers their own free Dropbox app (about 5 minutes, once) and pastes its App key into the plugin. Your files and tokens never touch anyone else's app or account. Do this once; on your other devices paste the same App key.

---

## 1. Create the App in the Dropbox Developer Console

1. Navigate to the [Dropbox App Console](https://www.dropbox.com/developers/apps).
2. Click **Create app**.
3. Choose the following options:
   - **1. Choose an API:** Select **Scoped access**.
   - **2. Choose the type of access you need:** Select **App folder** (access is restricted to a dedicated subfolder in `Apps/<app-name>`).
   - **3. Name your app:** Choose a unique name (e.g. `Dropbox Vault Sync - <your-name>`).
4. Click **Create app**.

---

## 2. Configure Scopes and Permissions

1. Open the **Permissions** tab.
2. Under **Files and folders**, check:
   - `files.metadata.read`
   - `files.metadata.write`
   - `files.content.read`
   - `files.content.write`
3. Under **Account info**, check:
   - `account_info.read`
4. Click **Submit** at the bottom of the tab to save permissions.

---

## 3. Configure OAuth 2 & PKCE Settings

1. Open the **Settings** tab.
2. Under **OAuth 2**:
   - **Redirect URIs**: Add `obsidian://dropbox-vault-sync-auth`.
     *(Note: If the Dropbox App Console rejects the custom URL scheme during registration, users can authenticate via the manual code-paste flow which is built into the plugin settings).*
   - **Disallow code flow without PKCE**: Ensure PKCE is allowed / required.
   - **Public Client**: The plugin uses OAuth 2 PKCE as a public client. Never embed or distribute an App Secret.
3. Copy your **App key** (Client ID).

---

## 4. Enter the App Key in Obsidian

Open **Settings → Community plugins → Dropbox Vault Sync**, paste the App key into **Dropbox app key**, then click **Connect**. The App key is an identifier, not a secret; never use or share an App secret.

---

## 5. Production status

Not needed. A development-mode app is limited to 50 linked accounts, and here only you use your app.
