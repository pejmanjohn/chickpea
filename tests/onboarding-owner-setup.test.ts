import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const ORIGIN = 'https://chickpea.example';

test('fresh installs expose no password owner setup route', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = createAdminRoutes({ identity, settings });
    const get = await app.request(`${ORIGIN}/admin/setup`);
    assert.equal(get.status, 404);

    const post = await app.request(`${ORIGIN}/admin/setup`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        ownerEmail: 'owner@example.com',
        password: 'several unrelated words 5729',
        passwordConfirmation: 'several unrelated words 5729',
      }),
    });
    assert.equal(post.status, 404);
    assert.equal(await identity.getOrganization(), undefined);
  } finally {
    settings.close();
    identity.close();
  }
});

test('legacy shared-token login cannot bootstrap a fresh install', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity, adminToken: 'legacy-deployment-token' });
    const response = await app.request(`${ORIGIN}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'legacy-deployment-token' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await identity.getOrganization(), undefined);
  } finally {
    identity.close();
  }
});
