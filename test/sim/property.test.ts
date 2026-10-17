import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { assertConverged, createWorld, syncAll } from './world';

const PATHS = ['a.md', 'b.md', 'd/c.md', 'img.png'] as const;
type SimPath = (typeof PATHS)[number];

type Command =
  | { kind: 'create'; device: number; path: SimPath }
  | { kind: 'append'; device: number; path: SimPath }
  | { kind: 'delete'; device: number; path: SimPath }
  | { kind: 'rename'; device: number; from: SimPath; to: SimPath }
  | { kind: 'sync'; device: number };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant('create' as const),
    device: fc.integer({ min: 0, max: 2 }),
    path: fc.constantFrom(...PATHS),
  }),
  fc.record({
    kind: fc.constant('append' as const),
    device: fc.integer({ min: 0, max: 2 }),
    path: fc.constantFrom(...PATHS),
  }),
  fc.record({
    kind: fc.constant('delete' as const),
    device: fc.integer({ min: 0, max: 2 }),
    path: fc.constantFrom(...PATHS),
  }),
  fc
    .record({
      kind: fc.constant('rename' as const),
      device: fc.integer({ min: 0, max: 2 }),
      from: fc.constantFrom(...PATHS),
      to: fc.constantFrom(...PATHS),
    })
    .filter((c) => c.from !== c.to),
  fc.record({
    kind: fc.constant('sync' as const),
    device: fc.integer({ min: 0, max: 2 }),
  }),
);

function extractTokens(text: string): string[] {
  return text.match(/\bt\d+\b/g) ?? [];
}

describe('property-based multi-device sync simulation', () => {
  it(
    'converges and never loses un-deleted tokens across 200 random command sequences',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(commandArb, { minLength: 1, maxLength: 25 }),
          async (commands) => {
            const w = createWorld(3, { autoApprove: true });
            const issuedTokens = new Set<string>();
            const allowedLost = new Set<string>();
            let nextTokenId = 1;

            for (const cmd of commands) {
              w.clock.tick(100);
              const dev = w.devices[cmd.device];

              switch (cmd.kind) {
                case 'create': {
                  if (dev.vault.readText(cmd.path) === undefined) {
                    const tok = `t${nextTokenId++}`;
                    issuedTokens.add(tok);
                    dev.vault.writeText(cmd.path, `${tok}\n`);
                  }
                  break;
                }
                case 'append': {
                  const tok = `t${nextTokenId++}`;
                  issuedTokens.add(tok);
                  const existing = dev.vault.readText(cmd.path) ?? '';
                  dev.vault.writeText(cmd.path, `${existing}${tok}\n`);
                  break;
                }
                case 'delete': {
                  const existing = dev.vault.readText(cmd.path);
                  if (existing !== undefined) {
                    for (const tok of extractTokens(existing)) {
                      allowedLost.add(tok);
                    }
                    dev.vault.deleteUser(cmd.path);
                  }
                  break;
                }
                case 'rename': {
                  const fromText = dev.vault.readText(cmd.from);
                  const toText = dev.vault.readText(cmd.to);
                  if (fromText !== undefined && toText === undefined) {
                    dev.vault.renameUser(cmd.from, cmd.to);
                    dev.addRenameHint(cmd.from, cmd.to);
                  }
                  break;
                }
                case 'sync': {
                  await dev.sync('all');
                  break;
                }
              }
            }

            await syncAll(w);
            assertConverged(w);

            const survivingTokens = new Set<string>();
            for (const dev of w.devices) {
              for (const p of dev.vault.paths()) {
                const text = dev.vault.readText(p);
                if (text !== undefined) {
                  for (const tok of extractTokens(text)) {
                    survivingTokens.add(tok);
                  }
                }
              }
            }

            for (const tok of issuedTokens) {
              if (!allowedLost.has(tok)) {
                expect(survivingTokens.has(tok)).toBe(true);
              }
            }
          },
        ),
        { numRuns: 200 },
      );
    },
    60_000,
  );
});
