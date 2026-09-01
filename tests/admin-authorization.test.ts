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
  assert.equal(permissionForRole('member').has('connection.create_team'), false);
  assert.equal(permissionForRole('member').has('team.view'), false);
  assert.equal(permissionForRole('owner').has('auth.manage'), true);
  assert.equal(permissionForRole('admin').has('admin.configure'), true);
  assert.equal(permissionForRole('admin').has('connection.create_team'), true);
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
    const unavailableConnection = await config.putConnectionAccount({
      id: 'connection_schedule_unavailable', workspaceId: 'T_TEST', ownerKind: 'team',
      createdByMembershipId: owner.membership.id, providerId: 'google', label: 'Shared Gmail',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'principal_schedule_unavailable',
        accountRef: 'account_schedule_unavailable',
        allowedCapabilities: ['gmail.messages.search'],
      },
      secretRefId: 'secret_schedule_unavailable', lifecycle: 'needs_attention',
    }, 0);
    await config.putAgentConnectionBinding({
      agentId: agent.id, connectionAccountId: unavailableConnection.id,
      providerId: unavailableConnection.providerId,
      allowedCapabilities: ['gmail.messages.search'], enabled: true,
    });
    const reference = await config.putAgentScheduleReference({
      scheduleId: 'schedule_authority',
      agentId: agent.id,
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      createdByMembershipId: other.resolution.membership.id,
      runsAsMembershipId: other.resolution.membership.id,
      authorityReceiptId: 'receipt_other',
      requiredConnectionAccountIds: [unavailableConnection.id],
      connectionPauseAccountIds: [unavailableConnection.id],
      state: 'needs_attention',
    });
    const nextRunAt = Date.now() + 60 * 60_000;
    const savedRoutine = await routines.save({
      actorId: other.resolution.membership.id,
      actorClass: 'member',
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      draft: {
        action: 'create',
        routineId: reference.scheduleId,
        definition: {
          name: 'Schedule authority', description: 'Test authority takeover.',
          taskText: 'Run scheduled work.', triggerKind: 'schedule',
          scheduleInput: '0 * * * *',
          scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
          timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
        },
        nextRunAt,
        projectedDailyStarts: 1,
        reservations: [{ windowStart: nextRunAt, count: 1 }],
      },
      idempotencyKey: 'create:schedule_authority',
    });
    const pausedRoutine = await routines.control({
      routineId: savedRoutine.id,
      expectedVersion: savedRoutine.version,
      action: 'pause',
      actorId: other.resolution.membership.id,
      actorClass: 'member',
      reasonCode: 'connection_unavailable',
      idempotencyKey: 'pause:schedule_authority',
    });
    assert.equal(pausedRoutine.state, 'paused');
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
    const takeoverBody = await takeover.json() as Record<string, any>;
    assert.equal(takeoverBody.reference.runsAsMembershipId, owner.membership.id);
    assert.equal(takeoverBody.reference.state, 'needs_attention');
    assert.deepEqual(takeoverBody.reference.connectionPauseAccountIds, [unavailableConnection.id]);
    assert.equal(takeoverBody.routine.state, 'paused');
    const latestUnavailableConnection = (await config.listConnectionAccounts('T_TEST'))
      .find(({ id }) => id === unavailableConnection.id)!;
    await config.putConnectionAccount({
      ...latestUnavailableConnection,
      lifecycle: 'ready',
    }, latestUnavailableConnection.revision);
    const activeAuthority = await app.request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedAuthorityRevision: takeoverBody.reference.revision,
        runsAsMembershipId: owner.membership.id,
      }),
    });
    assert.equal(activeAuthority.status, 200, await activeAuthority.clone().text());
    const activeAuthorityBody = await activeAuthority.json() as Record<string, any>;
    assert.equal(activeAuthorityBody.reference.state, 'active');
    assert.equal(
      activeAuthorityBody.routine.state,
      'paused',
      'Runs-as reassignment must not acknowledge a non-authority pause',
    );
    assert.equal(activeAuthorityBody.routine.pausedReason, 'connection_unavailable');
    const resumedForSystemPause = await routines.control({
      routineId: activeAuthorityBody.routine.id,
      expectedVersion: activeAuthorityBody.routine.version,
      action: 'resume',
      actorId: owner.membership.id,
      actorClass: 'operator',
      idempotencyKey: 'resume:before-credential-pause',
    });
    const credentialPaused = await routines.control({
      routineId: resumedForSystemPause.id,
      expectedVersion: resumedForSystemPause.version,
      action: 'pause',
      actorId: owner.membership.id,
      actorClass: 'system',
      reasonCode: 'credential_unavailable',
      idempotencyKey: 'pause:credential-unavailable',
    });
    assert.equal(credentialPaused.state, 'paused');
    const repairedCredentialPause = await app.request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedAuthorityRevision: activeAuthorityBody.reference.revision,
        runsAsMembershipId: owner.membership.id,
      }),
    });
    assert.equal(
      repairedCredentialPause.status,
      200,
      await repairedCredentialPause.clone().text(),
    );
    const repairedCredentialBody = await repairedCredentialPause.json() as Record<string, any>;
    assert.equal(repairedCredentialBody.reference.state, 'active');
    assert.equal(repairedCredentialBody.routine.state, 'active');
  } finally {
    routines.close();
    config.close();
    identity.close();
  }
});
