import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('a fresh setup capability cannot bootstrap password authority', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const response = await createAdminRoutes({ identity, recoveryToken: '1'.repeat(64) }).request(
      'https://chickpea.example/admin/setup',
      { method: 'POST', body: new URLSearchParams({ ownerEmail: 'owner@example.com', password: 'secret' }) },
    );
    assert.equal(response.status, 404);
    assert.equal(await identity.getOrganization(), undefined);
    assert.equal((await identity.ensureAuthControl()).authMode, 'unconfigured');
  } finally {
    identity.close();
  }
});
