import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('unconfigured admin is fail-closed and shared/deployment credentials are inert', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity, adminToken: 'deployment-token' });
    for (const headers of [
      {},
      { authorization: 'Bearer deployment-token' },
      { 'cf-access-jwt-assertion': 'edge-assertion' },
    ]) {
      const response = await app.request('https://app.example/admin', { headers });
      assert.equal(response.status, 503);
      assert.equal(response.headers.has('set-cookie'), false);
    }
  } finally {
    identity.close();
  }
});

test('recovery-only hides normal Admin and Slack actor handoff routes', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    await identity.ensureAuthControl({ healthGate: 'recovery_only' });
    const app = createAdminRoutes({ identity });
    for (const path of ['/admin', '/admin/api/agents', '/admin/slack-actor']) {
      assert.equal((await app.request(`https://app.example${path}`)).status, 404, path);
    }
  } finally {
    identity.close();
  }
});
