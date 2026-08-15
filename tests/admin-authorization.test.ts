import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { permissionForRole, requirePermission } from '../src/auth/permissions.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

function principal(role: AuthPrincipal['role']): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_oss',
    role, authenticatorKind: 'better_auth', credentialId: 'session_test',
    correlationId: 'request_test', machine: false,
  };
}

test('only Chickpea Owner and Admin roles exist at the permission boundary', () => {
  assert.equal(permissionForRole('owner').has('auth.manage'), true);
  assert.equal(permissionForRole('admin').has('admin.configure'), true);
  assert.equal(permissionForRole('admin').has('auth.manage'), false);
  assert.doesNotThrow(() => requirePermission(principal('admin'), 'admin.configure'));
  assert.throws(() => requirePermission(principal('admin'), 'auth.manage'), /forbidden/i);
});

test('deployment/shared token cannot become a product principal', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity, adminToken: 'deployment-token' });
    assert.equal((await app.request('https://app.example/admin', {
      headers: { authorization: 'Bearer deployment-token' },
    })).status, 503);
  } finally {
    identity.close();
  }
});
