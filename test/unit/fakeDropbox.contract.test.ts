import { describeRemoteStoreContract } from '../contract/remoteStoreContract';
import { FakeDropbox } from '../fakes/FakeDropbox';
import { CursorResetError, NetworkError, RevConflictError } from '../../src/errors';
import { encodeText } from '../../src/bytes';

let t = 1000;
const server = new FakeDropbox(() => (t += 100));

describeRemoteStoreContract('FakeDropbox', async () => server.client());

describe('FakeDropbox test helpers', () => {
  test('writeText, readText, paths, expireCursors, failNext, beforeWrite', async () => {
    let now = 5000;
    const dbx = new FakeDropbox(() => (now += 100));
    const client = dbx.client();

    dbx.writeText('Notes/One.md', 'hello');
    expect(dbx.readText('notes/one.md')).toBe('hello');
    expect(dbx.paths()).toEqual(['Notes/One.md']);

    const { cursor } = await client.listAll();
    dbx.expireCursors();
    await expect(client.listChanges(cursor)).rejects.toBeInstanceOf(CursorResetError);

    dbx.failNext('listAll', new NetworkError('boom'));
    await expect(client.listAll()).rejects.toBeInstanceOf(NetworkError);
    await expect(client.listAll()).resolves.toBeDefined();

    // beforeWrite race simulation
    const entry = dbx.writeText('race.md', 'v1');
    dbx.beforeWrite((p) => {
      if (p === 'race.md') {
        dbx.writeText('race.md', 'concurrent v2');
      }
    });
    await expect(
      client.upload('race.md', encodeText('my v2'), { kind: 'update', rev: entry.rev! }, now),
    ).rejects.toBeInstanceOf(RevConflictError);
  });
});
