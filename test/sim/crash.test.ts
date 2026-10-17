import { describe, expect, it } from 'vitest';
import { assertConverged, createWorld, syncAll } from './world';

describe('crash recovery simulation', () => {
  for (let k = 0; k <= 12; k++) {
    it(`recovers and preserves all edit tokens when A fails after k=${k} local mutations`, async () => {
      const w = createWorld(2);
      const [A, B] = w.devices;

      // Seed 3 shared files
      A.vault.writeText('f1.md', 'tok-init-1\nline-middle-1\ntok-end-1\n');
      A.vault.writeText('f2.md', 'tok-init-2\n');
      A.vault.writeText('f3.md', 'tok-init-3\n');
      await syncAll(w);

      w.clock.tick(1000);

      // Divergent edits across 3 files + new files on both sides
      // f1.md: clean mergeable edits on different lines
      A.vault.writeText('f1.md', 'tok-A1\nline-middle-1\ntok-end-1\n');
      B.vault.writeText('f1.md', 'tok-init-1\nline-middle-1\ntok-B1\n');

      // f2.md: overlapping conflict edits
      A.vault.writeText('f2.md', 'tok-A2-conflict\n');
      B.vault.writeText('f2.md', 'tok-B2-conflict\n');

      // f3.md: updated on B, new file created on B and A
      B.vault.writeText('f3.md', 'tok-init-3\ntok-B3-update\n');
      B.vault.writeText('sub/b-new.md', 'tok-B4-new\n');
      A.vault.writeText('sub/a-new.md', 'tok-A4-new\n');

      // Sync B first so remote has B's changes
      const bOut = await B.sync();
      expect(bOut.status).toBe('ok');

      // Inject fault on A's vault: failAfter = k
      A.setFailAfter(k);
      const aCrashOut = await A.sync();
      expect(['ok', 'error']).toContain(aCrashOut.status);

      // Clear fault on A and converge
      A.setFailAfter(undefined);
      await syncAll(w);
      assertConverged(w);

      const allText = A.vault
        .paths()
        .map((p) => A.vault.readText(p) ?? '')
        .join('\n');

      const requiredTokens = [
        'tok-A1',
        'tok-B1',
        'tok-A2-conflict',
        'tok-B2-conflict',
        'tok-B3-update',
        'tok-B4-new',
        'tok-A4-new',
      ];
      for (const token of requiredTokens) {
        expect(allText).toContain(token);
      }
    });
  }
});
