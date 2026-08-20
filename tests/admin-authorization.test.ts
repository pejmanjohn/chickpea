import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  canEditAgent,
  permissionForRole,
  requireAgentChannelPublication,
  requirePermission,
} from '../src/auth/permissions.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

function principal(role: AuthPrincipal['role']): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_oss',
    role, authenticatorKind: 'better_auth', credentialId: 'session_test',
    correlationId: 'request_test', machine: false,
  };
}

test('team authority is split so Admin can inspect but only Owner can mutate membership', () => {
  assert.equal(permissionForRole('member').has('agent.create'), true);
  assert.equal(permissionForRole('member').has('connection.create_personal'), true);
  assert.equal(permissionForRole('member').has('team.view'), false);
  assert.equal(permissionForRole('owner').has('auth.manage'), true);
  assert.equal(permissionForRole('admin').has('admin.configure'), true);
  assert.equal(permissionForRole('admin').has('auth.manage'), false);
  assert.equal(permissionForRole('admin').has('team.view'), true);
  assert.equal(permissionForRole('admin').has('team.invite'), false);
  assert.equal(permissionForRole('admin').has('team.manage_members'), false);
  assert.equal(permissionForRole('admin').has('team.manage_owners'), false);
  assert.equal(permissionForRole('owner').has('team.invite'), true);
  assert.equal(permissionForRole('owner').has('team.manage_members'), true);
  assert.equal(permissionForRole('owner').has('team.manage_owners'), true);
  assert.doesNotThrow(() => requirePermission(principal('admin'), 'admin.configure'));
  assert.doesNotThrow(() => requirePermission(principal('admin'), 'team.view'));
  assert.throws(() => requirePermission(principal('admin'), 'team.invite'), /forbidden/i);
  assert.throws(() => requirePermission(principal('admin'), 'auth.manage'), /forbidden/i);
});

test('Agent collaboration and Slack Channel membership are separate authority checks', () => {
  const creator = principal('member');
  const other = { ...principal('member'), membershipId: 'membership_other' };
  const admin = principal('admin');
  const agent = {
    creatorMembershipId: creator.membershipId,
    editPolicy: 'creator_and_admins' as const,
  };
  assert.equal(canEditAgent(creator, agent), true);
  assert.equal(canEditAgent(admin, agent), true);
  assert.equal(canEditAgent(other, agent), false);
  assert.equal(canEditAgent(other, { ...agent, editPolicy: 'all_workspace_members' }), true);
  assert.doesNotThrow(() => requireAgentChannelPublication(creator, agent, true));
  assert.throws(
    () => requireAgentChannelPublication(admin, agent, false),
    /forbidden/i,
    'Admin authority cannot publish into a Channel the actor does not belong to',
  );
});

test('deployment/shared token cannot become a product principal', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity });
    assert.equal((await app.request('https://app.example/admin', {
      headers: { authorization: 'Bearer deployment-token' },
    })).status, 503);
  } finally {
    identity.close();
  }
});
