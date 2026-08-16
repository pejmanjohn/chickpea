import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('Slack Team routes require a session while password/account compatibility routes stay absent', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity, authService: {
      async authenticateRequest() { throw new Error('must not authenticate retired routes'); },
    } });
    for (const path of ['/admin/api/team', '/admin/api/team/invitations']) {
      const response = await app.request(`https://chickpea.example${path}`);
      assert.equal(response.status, 401, path);
    }
    for (const path of ['/admin/api/account', '/admin/slack-actor', '/admin/slack-actor/bind']) {
      const response = await app.request(`https://chickpea.example${path}`);
      assert.equal(response.status, 404, path);
    }
  } finally {
    identity.close();
  }
});
