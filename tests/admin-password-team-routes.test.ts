import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('email/password team and actor-binding compatibility routes are absent', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity, authService: {
      async authenticateRequest() { throw new Error('must not authenticate retired routes'); },
    } });
    for (const path of [
      '/admin/api/team', '/admin/api/team/invitations', '/admin/api/account',
      '/admin/slack-actor', '/admin/slack-actor/bind',
    ]) {
      const response = await app.request(`https://chickpea.example${path}`);
      assert.equal(response.status, 404, path);
    }
  } finally {
    identity.close();
  }
});
