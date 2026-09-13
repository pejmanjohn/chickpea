import { ConfigStoreLogic } from '../../src/config/store.ts';
import { SettingsStoreLogic } from '../../src/config/settings-store.ts';
import { IdentityStoreLogic } from '../../src/identity/store.ts';
import { openStateDb } from '../../src/state/node-state-db.ts';
import { promisify } from '../../src/state/async-facade.ts';

/** Production gateway stores share TAG_STATE, including atomic binding writes. */
export function gatewayStores(now: () => number) {
  const db = openStateDb(':memory:');
  return {
    db,
    settings: promisify(new SettingsStoreLogic(db, now), { close: () => db.close() }),
    config: promisify(new ConfigStoreLogic(db, { agents: [{
      id: 'agent_default', name: 'Chickpea', instructions: 'Help.', enabled: true,
      lifecycle: 'active', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    }] }), { close() {} }),
    identity: promisify(new IdentityStoreLogic(db, { now }), { close() {} }),
  };
}
