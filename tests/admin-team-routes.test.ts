import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('pre-U6 team surface does not expose email-shaped operations', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity });
    for (const path of ['/admin/api/team', '/admin/api/team/invitations', '/admin/api/account']) {
      assert.equal((await app.request(`https://app.example${path}`)).status, 404, path);
    }
  } finally {
    identity.close();
  }
});
