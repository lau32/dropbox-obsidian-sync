export type StatusState =
  | { kind: 'idle'; lastSyncAt: number | null }
  | { kind: 'syncing'; done: number; total: number }
  | { kind: 'offline' }
  | { kind: 'needsReview' }
  | { kind: 'error'; message: string }
  | { kind: 'reauth' }
  | { kind: 'disconnected' };

export function statusText(s: StatusState, now: number): string {
  switch (s.kind) {
    case 'idle': {
      if (s.lastSyncAt === null) {
        return 'Dropbox: ✓';
      }
      const diffMs = Math.max(0, now - s.lastSyncAt);
      const mins = Math.floor(diffMs / 60_000);
      if (mins < 1) {
        return 'Dropbox: ✓ just now';
      }
      if (mins < 60) {
        return `Dropbox: ✓ ${mins}m ago`;
      }
      const hours = Math.floor(mins / 60);
      if (hours < 24) {
        return `Dropbox: ✓ ${hours}h ago`;
      }
      const days = Math.floor(hours / 24);
      return `Dropbox: ✓ ${days}d ago`;
    }
    case 'syncing':
      return `Dropbox: ⟳ ${s.done}/${s.total}`;
    case 'offline':
      return 'Dropbox: offline';
    case 'needsReview':
      return 'Dropbox: ⚠ Needs review';
    case 'error':
      return `Dropbox: ✕ ${s.message}`;
    case 'reauth':
      return 'Dropbox: ⚠ Re-authenticate';
    case 'disconnected':
      return 'Dropbox: not connected';
  }
}
