# Dropbox App Setup Guide

This guide is for the plugin maintainer or users who wish to register their own custom Dropbox App.

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

## 4. Embedding or Customizing the App Key

- **For Maintainers:** Place the registered App Key into `SHIPPED_APP_KEY` in `src/settings.ts`.
- **For Users:** If using a personal app, paste your App Key into the **Custom App Key** field under the plugin's settings tab in Obsidian.

---

## 5. Applying for Production Status

In Development mode, Dropbox limits your app to 50 connected user accounts. Before publishing for public community use or exceeding 50 users:
1. Go to the **Settings** tab in the Dropbox console.
2. Click **Apply for production status**.
3. Provide details describing the app's purpose (vault backup and sync across user devices).
