import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createTeamAdminApi } from '../src/admin/team-api.ts';
import { setRequestPrincipal } from '../src/auth/service.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_786_100_000_000;

function principal(owner: Awaited<ReturnType<typeof createSlackOwner>>, role: 'owner' | 'admin' = 'owner'): AuthPrincipal {
  return {
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    role,
    authenticatorKind: 'better_auth',
    credentialId: 'session_team_test',
    correlationId: `request_team_${role}`,
    machine: false,
  };
}

async function harness(
  role: 'owner' | 'admin' = 'owner',
  overrides: { revokeBetterAuthSessions?: (betterAuthUserId: string) => Promise<number> } = {},
) {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  const member = await identity.provisionSlackMember({
    slackTeamId: owner.binding.slackTeamId,
    slackUserId: 'UMEMBER01',
    displayName: 'Maya Member',
  });
  const app = new Hono();
  app.use('/admin/api/*', async (c, next) => {
    setRequestPrincipal(c.req.raw, principal(owner, role));
    await next();
  });
  app.route('/admin/api', createTeamAdminApi({
    store: () => identity,
    ...(overrides.revokeBetterAuthSessions
      ? { revokeBetterAuthSessions: async (_c, userId) => overrides.revokeBetterAuthSessions!(userId) }
      : {}),
  }));
  return { app, identity, owner, member: member.resolution! };
}

test('Team snapshot contains durable memberships only', async () => {
  const team = await harness();
  try {
    const response = await team.app.request('https://app.example/admin/api/team');
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as {
      viewer: { role: string };
      members: Array<{ slackUserId: string; role: string; status: string }>;
      invitations?: unknown;
      soleOwnerWarning?: unknown;
    };
    assert.equal(body.viewer.role, 'owner');
    assert.deepEqual(body.members.map((member) => ({
      slackUserId: member.slackUserId,
      role: member.role,
      status: member.status,
    })).sort((left, right) => left.slackUserId.localeCompare(right.slackUserId)), [
      { slackUserId: 'UMEMBER01', role: 'member', status: 'active' },
      { slackUserId: team.owner.binding.slackUserId, role: 'owner', status: 'active' },
    ].sort((left, right) => left.slackUserId.localeCompare(right.slackUserId)));
    assert.equal('invitations' in body, false);
    assert.equal('soleOwnerWarning' in body, false);
  } finally {
    team.identity.close();
  }
});

test('Team exposes no Slack directory or manual invitation routes', async () => {
  const team = await harness();
  try {
    for (const [path, init] of [
      ['/admin/api/team/directory', undefined],
      ['/admin/api/team/directory/UMEMBER01', undefined],
      ['/admin/api/team/invitations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slackUserId: 'UMEMBER02' }),
      }],
      ['/admin/api/team/invitations/invitation_missing', { method: 'DELETE' }],
    ] as const) {
      const response = await team.app.request(`https://app.example${path}`, init);
      assert.equal(response.status, 404, `${path} should not be a supported Team route`);
    }
    assert.equal((await team.identity.listInvitations()).length, 0);
  } finally {
    team.identity.close();
  }
});

test('Owner updates an existing membership while Admin cannot', async () => {
  const ownerTeam = await harness('owner');
  try {
    const promoted = await ownerTeam.app.request(
      `https://app.example/admin/api/team/memberships/${ownerTeam.member.membership.id}`,
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
    );
    assert.equal(promoted.status, 200, await promoted.clone().text());
    assert.equal((await ownerTeam.identity.getMembership(ownerTeam.member.membership.id))?.role, 'admin');
  } finally {
    ownerTeam.identity.close();
  }

  const adminTeam = await harness('admin');
  try {
    const denied = await adminTeam.app.request(
      `https://app.example/admin/api/team/memberships/${adminTeam.member.membership.id}`,
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
    );
    assert.equal(denied.status, 403);
  } finally {
    adminTeam.identity.close();
  }
});

test('membership updates delegate to the shared management service', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: 'team-management' });
  const member = await identity.provisionSlackMember({
    slackTeamId: owner.binding.slackTeamId,
    slackUserId: 'UMANAGED1',
    displayName: 'Managed Member',
  });
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const management = new SqliteManagementStore(':memory:');
  let sequence = 0;
  const service = new WorkspaceManagementService({
    identity,
    config,
    management,
    setupBaseUrl: 'https://app.example',
    now: () => NOW,
    randomId: () => `team_management_${++sequence}`,
    randomCapability: () => `${'m'.repeat(42)}${sequence % 10}`,
  });
  const app = new Hono();
  app.use('/admin/api/*', async (c, next) => {
    setRequestPrincipal(c.req.raw, principal(owner));
    await next();
  });
  app.route('/admin/api', createTeamAdminApi({
    store: () => identity,
    management: () => service,
  }));
  try {
    const response = await app.request(
      `https://app.example/admin/api/team/memberships/${member.resolution!.membership.id}`,
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' }),
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await identity.getMembership(member.resolution!.membership.id))?.status, 'suspended');
  } finally {
    identity.close();
    config.close();
    management.close();
  }
});

test('last active Owner protection remains enforced', async () => {
  const team = await harness();
  try {
    const response = await team.app.request(
      `https://app.example/admin/api/team/memberships/${team.owner.membership.id}`,
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'last_owner_required' });
  } finally {
    team.identity.close();
  }
});
