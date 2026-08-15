import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBetterAuthRuntimeRoutes } from '../src/auth/better-auth-runtime.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('recovery-only health gate admits no normal session or Slack auth route', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const control = await identity.ensureAuthControl({ healthGate: 'recovery_only' });
    assert.equal(control.healthGate, 'recovery_only');
    const app = createBetterAuthRuntimeRoutes({ identity, recoveryToken: '0'.repeat(64) });
    for (const path of ['/api/auth/get-session', '/api/auth/sign-out', '/api/auth/slack/start']) {
      const response = await app.request(`https://app.example${path}`);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.has('set-cookie'), false);
    }
  } finally {
    identity.close();
  }
});
