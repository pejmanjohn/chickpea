import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteIdentityStore } from '../src/identity/store.ts';

test('fresh identity lifecycle begins unconfigured without legacy provider state', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    assert.equal((await identity.ensureAuthControl()).authMode, 'unconfigured');
    assert.equal(await identity.getOrganization(), undefined);
    assert.deepEqual(await identity.listExternalIdentities(), []);
  } finally {
    identity.close();
  }
});
