import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminRoutes } from '../src/admin/routes.ts';
import type { SettingsStore } from '../src/config/settings-store.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

test('installation endpoints require a human Owner and perform no settings mutations', async () => {
  let reads = 0; let fetches = 0;
  const settings = { getSetting: async () => { reads++; return undefined; }, setSetting: async () => { throw new Error('must not write'); } } as unknown as SettingsStore;
  for (const role of ['owner', 'admin', 'member'] as const) {
    for (const machine of [false, true]) {
      const principal: AuthPrincipal = { userId: 'u', membershipId: 'm', organizationId: 'org_oss', role, machine, authenticatorKind: 'test_slack_session', credentialId: 'c', correlationId: 'r' };
      const app = createAdminRoutes({ ...testAdminAuthority('token', undefined, undefined, principal), settings,
        updateFetch: async () => { fetches++; return new Response('', { status: 404 }); },
      });
      for (const path of ['', '/updates', '/support']) {
        const before = [reads, fetches];
        const response = await app.request(`http://localhost/admin/api/installation${path}`, { headers: testAdminHeaders('token') });
        assert.equal(response.status, role === 'owner' && !machine ? 200 : 403, `${role}/${machine}/${path}`);
        if (response.status === 403) assert.deepEqual([reads, fetches], before);
        else assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      assert.equal((await app.request('http://localhost/admin/api/installation/support')).status, 401);
    }
  }
});
