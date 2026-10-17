import { describeStateStoreContract } from '../contract/stateStoreContract';
import { MemoryStateStore } from '../fakes/MemoryStateStore';

describeStateStoreContract('MemoryStateStore', async () => new MemoryStateStore());
