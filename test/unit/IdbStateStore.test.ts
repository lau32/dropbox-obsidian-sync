import 'fake-indexeddb/auto';
import { IdbStateStore } from '../../src/state/IdbStateStore';
import { describeStateStoreContract } from '../contract/stateStoreContract';

describeStateStoreContract('IdbStateStore', () => IdbStateStore.open(`t-${Math.random()}`));

describe('IdbStateStore persistence and isolation', () => {
  test('persists across instances with the same name', async () => {
    const a = await IdbStateStore.open('same');
    await a.commit(
      { path: 'A.md', isFolder: false, size: 1, mtime: 1, contentHash: 'h', rev: 'r1', serverModified: 1 },
      'x',
    );
    const b = await IdbStateStore.open('same');
    expect((await b.loadBase()).get('a.md')?.rev).toBe('r1');
    expect(await b.getBaseText('A.md')).toBe('x');
  });

  test('different names are isolated', async () => {
    const a = await IdbStateStore.open('v1');
    const b = await IdbStateStore.open('v2');
    await a.setMeta({ cursor: 'c' });
    expect((await b.getMeta()).cursor).toBeNull();
  });
});
