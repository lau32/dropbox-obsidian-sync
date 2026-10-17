import { describeRemoteStoreContract } from './remoteStoreContract';
import { DropboxRemote } from '../../src/remote/DropboxRemote';
import { nodeHttp } from '../support/nodeHttp';

const token = process.env.DROPBOX_TEST_TOKEN;

if (token) {
  const root = `contract-${Date.now()}`;
  describeRemoteStoreContract('DropboxRemote (live)', async () => {
    return new DropboxRemote({
      http: nodeHttp,
      root,
      getAccessToken: async () => token,
      refreshAccessToken: async () => token,
    });
  });
} else {
  describe.skip('RemoteStore contract: DropboxRemote (live)', () => {
    test('skipped when DROPBOX_TEST_TOKEN is not set', () => {});
  });
}
