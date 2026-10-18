# Release Verification Checklist

This manual verification matrix should be performed across target platforms (Desktop: macOS / Windows / Linux, iOS, Android) prior to publishing a release.

---

## 1. Authentication & Onboarding

- [ ] **Desktop OAuth Redirect:**
  - Click "Connect to Dropbox" in Settings.
  - Browser opens Dropbox consent page.
  - Approving redirects to `obsidian://dropbox-vault-sync-auth`.
  - Obsidian shows "Connected to Dropbox!" notification and status bar updates to Idle.
- [ ] **Mobile Manual Auth Code Flow:**
  - Click "Connect to Dropbox" with redirect disabled or on mobile.
  - Copy authorization code from the Dropbox page.
  - Paste into "Manual Auth Code" field and submit.
  - Connection completes and saves refresh token.
- [ ] **Token Refresh:**
  - Token refresh occurs transparently without re-prompting the user.
- [ ] **Disconnect & Reconnect:**
  - Clicking "Disconnect" wipes local tokens and sets status bar to Disconnected.
  - Reconnecting works cleanly.

---

## 2. Synchronization Scenarios

- [ ] **First Sync of an Existing Vault:**
  - Connect a device with existing local notes to a Dropbox folder with pre-existing notes.
  - Verify union reconciliation: all local notes upload, all remote notes download, and nothing is deleted.
- [ ] **Mobile to Desktop Sync:**
  - Edit note on mobile.
  - Status bar syncs on edit debounce or manual sync.
  - Open note on desktop; changes appear accurately.
- [ ] **App Suspension & Resume:**
  - Put Obsidian in background on mobile / minimize window on desktop.
  - Bring back into focus.
  - Verify sync triggers automatically on resume without error.
- [ ] **Offline / Airplane Mode:**
  - Toggle airplane mode / disconnect Wi-Fi.
  - Make local edits.
  - Status bar updates to `Offline`.
  - Reconnect network.
  - Changes sync seamlessly once online.
- [ ] **Large Attachments:**
  - Add a 30 MB binary attachment (e.g. PDF or image).
  - Verify successful upload and download without timeouts or truncation.
- [ ] **Non-ASCII Filenames & Unicode Normalization:**
  - Create note with Unicode characters and emoji: `Café 😀.md`.
  - Verify sync completes without character corruption and is accessible across platforms.
- [ ] **Folder Rename:**
  - Create a folder with 20 notes.
  - Rename the folder.
  - Verify the planner generates moves (`moveRemote` / `moveLocal`), not deletes + re-uploads.
  - Verify no mass-delete guardrail review is triggered.

---

## 3. Conflict Resolution & Guardrails

- [ ] **Concurrent 3-Way Merge:**
  - Edit top paragraph of a note on Device A.
  - Edit bottom paragraph of the same note on Device B.
  - Sync both.
  - Verify both edits merge cleanly into a single file with no conflict copy.
- [ ] **Conflicting Edit (Conflict Copy):**
  - Edit the exact same sentence on Device A and Device B simultaneously.
  - Sync both.
  - Verify local edit is preserved and remote version is saved as `Note (conflict YYYY-MM-DD HHMM Device).md`.
  - Run **Dropbox Vault Sync: Show conflicts** from the command palette.
  - Verify modal lists the file and selecting it opens the conflict note.
- [ ] **Mass Deletion Guardrail & Review Modal:**
  - Delete 15 files externally on dropbox.com.
  - Run sync in Obsidian.
  - Status bar displays `⚠ Needs review` and sync pauses.
  - Click status bar or run **Dropbox Vault Sync: Review pending sync**.
  - Verify **Review Modal** accurately lists the 15 deletions.
  - Verify modal UI fits properly on mobile/phone screen.
  - Click **Apply without deletions**.
  - Verify local files are retained, remote copies are restored, and status bar returns to Idle.
