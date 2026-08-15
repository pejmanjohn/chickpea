import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('/admin/migrate has no authority or visible route on a fresh deployment', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity, recoveryToken: '0'.repeat(64), adminToken: 'shared' });
    for (const method of ['GET', 'POST']) {
      const response = await app.request('https://app.example/admin/migrate', {
        method,
        headers: { authorization: 'Bearer shared' },
      });
      assert.equal(response.status, 404);
      assert.equal(response.headers.has('set-cookie'), false);
    }
  } finally {
    identity.close();
  }
});
