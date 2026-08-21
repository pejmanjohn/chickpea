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
import { provisionSlackInteractionMember } from '../src/auth/slack-admission.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

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
  assert.equal(permissionForRole('admin').has('team.manage_members'), false);
  assert.equal(permissionForRole('admin').has('team.manage_owners'), false);
  assert.equal(permissionForRole('owner').has('team.manage_members'), true);
  assert.equal(permissionForRole('owner').has('team.manage_owners'), true);
  assert.doesNotThrow(() => requirePermission(principal('admin'), 'admin.configure'));
  assert.doesNotThrow(() => requirePermission(principal('admin'), 'team.view'));
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

test('shared Slack reconnect is POST-only and requires Admin configuration authority', async () => {
  const member = principal('member');
  const app = createAdminRoutes(testAdminAuthority('member-token', undefined, undefined, member));

  const get = await app.request('http://localhost/admin/slack-gateway/reconnect', {
    headers: testAdminHeaders('member-token'),
  });
  assert.equal(get.status, 405);
  assert.deepEqual(await get.json(), { error: 'method_not_allowed' });

  const post = await app.request('http://localhost/admin/slack-gateway/reconnect', {
    method: 'POST',
    headers: testAdminHeaders('member-token'),
  });
  assert.equal(post.status, 403);
});

test('an Agent editor may take over Runs as but cannot grant another member authority', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const routines = new SqliteRoutineStore(':memory:');
  try {
    const owner = await createSlackOwner(identity, {
      teamId: 'T_TEST',
      userId: 'U_OWNER',
      suffix: 'admin-schedule-authority',
    });
    const other = await provisionSlackInteractionMember({
      identity,
      slackTeamId: 'T_TEST',
      botUserId: 'U_BOT',
      user: {
        id: 'U_OTHER',
        teamId: 'T_TEST',
        displayName: 'Other member',
        email: 'other@example.test',
        deleted: false,
        bot: false,
        appUser: false,
        restricted: false,
        ultraRestricted: false,
        stranger: false,
      },
    });
    assert.ok(other.resolution);
    const agent = await config.createAgent({
      id: 'agent_schedule',
      name: 'Schedule Agent',
      instructions: 'Run scheduled work.',
      enabled: true,
      lifecycle: 'active',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const reference = await config.putAgentScheduleReference({
      scheduleId: 'schedule_authority',
      agentId: agent.id,
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      createdByMembershipId: other.resolution.membership.id,
      runsAsMembershipId: other.resolution.membership.id,
      authorityReceiptId: 'receipt_other',
      requiredConnectionAccountIds: [],
      state: 'paused',
    });
    const ownerPrincipal: AuthPrincipal = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      role: 'owner',
      authenticatorKind: 'test_slack_session',
      credentialId: 'session_schedule_owner',
      correlationId: 'request_schedule_owner',
      machine: false,
    };
    const app = createAdminRoutes({
      store: config,
      routines,
      ...testAdminAuthority('owner-token', undefined, identity, ownerPrincipal),
    });
    const endpoint = `http://localhost/admin/api/agents/${agent.id}/schedules/${reference.scheduleId}/reassign`;
    const headers = testAdminHeaders('owner-token', { 'content-type': 'application/json' });

    const delegated = await app.request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedAuthorityRevision: reference.revision,
        runsAsMembershipId: other.resolution.membership.id,
      }),
    });
    assert.equal(delegated.status, 403);

    const takeover = await app.request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedAuthorityRevision: reference.revision,
        runsAsMembershipId: owner.membership.id,
      }),
    });
    assert.equal(takeover.status, 200, await takeover.clone().text());
    assert.equal((await takeover.json() as Record<string, any>).reference.runsAsMembershipId,
      owner.membership.id);
  } finally {
    routines.close();
    config.close();
    identity.close();
  }
});
