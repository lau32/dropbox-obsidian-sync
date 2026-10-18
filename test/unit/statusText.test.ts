import { describe, it, expect } from 'vitest';
import { statusText, type StatusState } from '../../src/ui/statusText';

describe('statusText', () => {
  const now = 1_700_000_000_000;

  it('renders idle with elapsed time', () => {
    const state: StatusState = { kind: 'idle', lastSyncAt: now - 120_000 };
    expect(statusText(state, now)).toBe('Dropbox: ✓ 2m ago');
  });

  it('renders idle when never synced', () => {
    const state: StatusState = { kind: 'idle', lastSyncAt: null };
    expect(statusText(state, now)).toBe('Dropbox: ✓');
  });

  it('renders syncing with progress', () => {
    const state: StatusState = { kind: 'syncing', done: 12, total: 40 };
    expect(statusText(state, now)).toBe('Dropbox: ⟳ 12/40');
  });

  it('renders offline', () => {
    const state: StatusState = { kind: 'offline' };
    expect(statusText(state, now)).toBe('Dropbox: offline');
  });

  it('renders needsReview', () => {
    const state: StatusState = { kind: 'needsReview' };
    expect(statusText(state, now)).toBe('Dropbox: ⚠ Needs review');
  });

  it('renders error with message', () => {
    const state: StatusState = { kind: 'error', message: 'disk full' };
    expect(statusText(state, now)).toBe('Dropbox: ✕ disk full');
  });

  it('renders reauth', () => {
    const state: StatusState = { kind: 'reauth' };
    expect(statusText(state, now)).toBe('Dropbox: ⚠ Re-authenticate');
  });

  it('renders disconnected', () => {
    const state: StatusState = { kind: 'disconnected' };
    expect(statusText(state, now)).toBe('Dropbox: not connected');
  });
});
