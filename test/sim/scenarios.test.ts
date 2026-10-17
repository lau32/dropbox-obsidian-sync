import { describe, expect, it } from 'vitest';
import { assertConverged, createWorld, syncAll } from './world';

describe('multi-device sync scenarios', () => {
  it('A creates n.md -> B has it', async () => {
    const w = createWorld(2);
    const [A, B] = w.devices;

    A.vault.writeText('n.md', 'hello from A\n');

    await syncAll(w);
    assertConverged(w);
    expect(B.vault.readText('n.md')).toBe('hello from A\n');
  });

  it('A and B edit different lines of n.md -> both have the merged text', async () => {
    const w = createWorld(2);
    const [A, B] = w.devices;

    A.vault.writeText('n.md', 'line 1\nline 2\nline 3\n');
    await syncAll(w);

    w.clock.tick(1000);
    A.vault.writeText('n.md', 'line 1 edited by A\nline 2\nline 3\n');
    B.vault.writeText('n.md', 'line 1\nline 2\nline 3 edited by B\n');

    await syncAll(w);
    assertConverged(w);
    expect(A.vault.readText('n.md')).toBe(
      'line 1 edited by A\nline 2\nline 3 edited by B\n',
    );
    expect(B.vault.readText('n.md')).toBe(
      'line 1 edited by A\nline 2\nline 3 edited by B\n',
    );
  });

  it('A and B overlap -> both devices hold n.md and one conflict copy; the union of the two contains both edits', async () => {
    const w = createWorld(2);
    const [A, B] = w.devices;

    A.vault.writeText('n.md', 'shared line\n');
    await syncAll(w);

    w.clock.tick(1000);
    A.vault.writeText('n.md', 'overlap edit A\n');
    B.vault.writeText('n.md', 'overlap edit B\n');

    await syncAll(w);
    assertConverged(w);

    const paths = A.vault.paths();
    expect(paths).toHaveLength(2);
    expect(paths).toContain('n.md');
    const conflictPath = paths.find((p) => p !== 'n.md');
    expect(conflictPath).toMatch(/^n \(conflict .*\)\.md$/);

    const contents = paths.map((p) => A.vault.readText(p)!);
    expect(contents).toContain('overlap edit A\n');
    expect(contents).toContain('overlap edit B\n');
  });

  it("A deletes n.md, B edits it -> n.md exists with B's edit everywhere", async () => {
    const w = createWorld(2, { autoApprove: true });
    const [A, B] = w.devices;

    A.vault.writeText('n.md', 'initial text\n');
    await syncAll(w);

    w.clock.tick(1000);
    A.vault.deleteUser('n.md');
    B.vault.writeText('n.md', 'B updated text\n');

    await syncAll(w);
    assertConverged(w);
    expect(A.vault.readText('n.md')).toBe('B updated text\n');
    expect(B.vault.readText('n.md')).toBe('B updated text\n');
    expect(w.dropbox.readText('n.md')).toBe('B updated text\n');
  });

  it('remote changes mid-run: dropbox.beforeWrite hook makes B upload n.md once while A is uploading -> no edit lost', async () => {
    const w = createWorld(2);
    const [A, B] = w.devices;

    A.vault.writeText('n.md', 'initial\n');
    await syncAll(w);

    w.clock.tick(1000);
    A.vault.writeText('n.md', 'edit-from-A\n');
    B.vault.writeText('n.md', 'edit-from-B\n');

    let injected = false;
    w.dropbox.beforeWrite(async (path) => {
      if (!injected && path === 'n.md') {
        injected = true;
        await B.sync();
      }
    });

    await A.sync();
    w.dropbox.beforeWrite(() => {});

    await syncAll(w);
    assertConverged(w);

    const allText = A.vault
      .paths()
      .map((p) => A.vault.readText(p) ?? '')
      .join('\n');
    expect(allText).toContain('edit-from-A');
    expect(allText).toContain('edit-from-B');
  });

  it('new device C with different pre-existing n.md joins -> union: nothing deleted, conflict copy present', async () => {
    const w = createWorld(3);
    const [A, B, C] = w.devices;

    A.vault.writeText('n.md', 'content-on-A\n');
    A.vault.writeText('a-only.md', 'a-only\n');
    await A.sync();
    await B.sync();

    C.vault.writeText('n.md', 'preexisting-on-C\n');
    C.vault.writeText('c-only.md', 'c-only\n');

    await syncAll(w);
    assertConverged(w);

    const paths = C.vault.paths();
    expect(paths).toContain('a-only.md');
    expect(paths).toContain('c-only.md');
    expect(paths).toContain('n.md');
    const conflictCopies = paths.filter((p) => p.startsWith('n (conflict '));
    expect(conflictCopies).toHaveLength(1);

    const nTexts = [
      C.vault.readText('n.md'),
      C.vault.readText(conflictCopies[0]),
    ];
    expect(nTexts).toContain('content-on-A\n');
    expect(nTexts).toContain('preexisting-on-C\n');
  });

  it('A adds exclude Archive/** -> Archive/a.md still on Dropbox and on B', async () => {
    const w = createWorld(2);
    const [A, B] = w.devices;

    A.vault.writeText('Archive/a.md', 'important archive\n');
    A.vault.writeText('regular.md', 'regular note\n');
    await syncAll(w);

    A.setExcludes(['Archive/**']);
    A.vault.deleteUser('Archive/a.md');

    await syncAll(w);
    assertConverged(w);

    expect(w.dropbox.readText('Archive/a.md')).toBe('important archive\n');
    expect(B.vault.readText('Archive/a.md')).toBe('important archive\n');
  });

  it('A disables the core config category after syncing .obsidian/app.json -> file still on Dropbox and B', async () => {
    const w = createWorld(2, {
      configSync: { core: true, themes: false, plugins: false, workspace: false },
    });
    const [A, B] = w.devices;

    A.vault.writeText('.obsidian/app.json', '{"showLineNumber":true}');
    await syncAll(w);
    expect(B.vault.readText('.obsidian/app.json')).toBe('{"showLineNumber":true}');

    A.setConfigSync({ core: false });
    A.vault.deleteUser('.obsidian/app.json');

    await syncAll(w);
    assertConverged(w);

    expect(w.dropbox.readText('.obsidian/app.json')).toBe('{"showLineNumber":true}');
    expect(B.vault.readText('.obsidian/app.json')).toBe('{"showLineNumber":true}');
  });

  it('cursor expiry between syncs -> converges', async () => {
    const w = createWorld(2);
    const [A, B] = w.devices;

    A.vault.writeText('one.md', 'v1\n');
    await syncAll(w);

    w.clock.tick(1000);
    A.vault.writeText('one.md', 'v2\n');
    B.vault.writeText('two.md', 'from B\n');
    await A.sync();

    w.dropbox.expireCursors();

    await syncAll(w);
    assertConverged(w);
    expect(A.vault.readText('two.md')).toBe('from B\n');
    expect(B.vault.readText('one.md')).toBe('v2\n');
  });

  it('30 remote deletes from B -> A returns needsReview(massChange); approval noDeletes keeps and re-uploads files', async () => {
    const w = createWorld(2);
    const [A, B] = w.devices;

    for (let i = 0; i < 35; i++) {
      A.vault.writeText(`note-${i}.md`, `content ${i}\n`);
    }
    await syncAll(w);

    for (let i = 0; i < 30; i++) {
      B.vault.deleteUser(`note-${i}.md`);
    }
    const bOut = await B.sync('all');
    expect(bOut.status).toBe('ok');

    const aAuto = await A.sync();
    expect(aAuto).toMatchObject({
      status: 'needsReview',
      reason: 'massChange',
    });

    const aNoDeletes = await A.sync('noDeletes');
    expect(aNoDeletes.status).toBe('ok');

    const aSubsequent = await A.sync();
    expect(aSubsequent.status).toBe('ok');

    await syncAll(w);
    assertConverged(w);

    for (let i = 0; i < 35; i++) {
      expect(A.vault.readText(`note-${i}.md`)).toBe(`content ${i}\n`);
      expect(B.vault.readText(`note-${i}.md`)).toBe(`content ${i}\n`);
      expect(w.dropbox.readText(`note-${i}.md`)).toBe(`content ${i}\n`);
    }
  });

  it('logs case collisions and skipped files, updates lastSyncAt only on non-fatal runs, and handles offline/auth/error outcomes', async () => {
    const w = createWorld(1, { excludes: ['ignored/**'] });
    const [A] = w.devices;

    A.vault.writeText('ok.md', 'hello\n');
    A.vault.writeText('ignored/skip.md', 'skipped\n');
    A.vault.writeText('Collision.md', 'one\n');
    // Inject a second local file with case-colliding path in FakeVault internal map
    const itemsMap = (A.vault as unknown as { items: Map<string, unknown> }).items;
    itemsMap.set('collision-2', {
      meta: { path: 'collision.md', isFolder: false, size: 4, mtime: 100 },
      data: new Uint8Array([116, 119, 111, 10]).buffer,
    });

    const outOk = await A.sync();
    expect(outOk.status).toBe('ok');
    const meta1 = await A.state.getMeta();
    expect(meta1.lastSyncAt).not.toBeNull();

    const logs1 = await A.state.getLog();
    expect(logs1).toHaveLength(1);
    expect(logs1[0].errors.some((e) => e.message.includes('case collision'))).toBe(true);
    expect(logs1[0].errors.some((e) => e.path === 'ignored/skip.md')).toBe(true);

    // Offline during snapshot
    const { NetworkError, AuthError } = await import('../../src/errors');
    w.clock.tick(5000);
    w.dropbox.failNext('listChanges', new NetworkError('offline test'));
    const outOffline = await A.sync();
    expect(outOffline.status).toBe('offline');
    const metaAfterOffline = await A.state.getMeta();
    expect(metaAfterOffline.lastSyncAt).toBe(meta1.lastSyncAt);

    // Auth error during snapshot
    w.dropbox.failNext('listChanges', new AuthError('expired token'));
    const outAuth = await A.sync();
    expect(outAuth.status).toBe('auth');

    // Unexpected error during snapshot
    w.dropbox.failNext('listChanges', new Error('unexpected boom'));
    const outErr = await A.sync();
    expect(outErr).toMatchObject({ status: 'error', message: 'unexpected boom' });
  });
});

