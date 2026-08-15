import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('legacy password setup, recovery, migration, and account routes stay dark', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity, recoveryToken: '0'.repeat(64), adminToken: 'deployment-token' });
    for (const path of [
      '/admin/setup', '/admin/recovery', '/admin/migrate', '/admin/account/password',
    ]) {
      for (const method of ['GET', 'POST']) {
        const response = await app.request(`https://chickpea.example${path}`, { method });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(response.headers.has('set-cookie'), false);
      }
    }
  } finally {
    identity.close();
  }
});
