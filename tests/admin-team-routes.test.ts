import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createTeamAdminApi } from '../src/admin/team-api.ts';
import { AuthRateLimiter } from '../src/auth/rate-limit.ts';
import { setRequestPrincipal } from '../src/auth/service.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type {
  SlackDirectoryMember,
  SlackDirectoryUserInfoResult,
  SlackDirectoryUsersPage,
} from '../src/slack/credentials.ts';
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

function member(input: Partial<SlackDirectoryMember> & Pick<SlackDirectoryMember, 'id'>): SlackDirectoryMember {
  return {
    id: input.id,
    teamId: input.teamId ?? 'T12345678',
    deleted: input.deleted ?? false,
    bot: input.bot ?? false,
    appUser: input.appUser ?? false,
    restricted: input.restricted ?? false,
    ultraRestricted: input.ultraRestricted ?? false,
    stranger: input.stranger ?? false,
    displayName: input.displayName ?? input.id,
    realName: input.realName ?? input.displayName ?? input.id,
    handle: input.handle ?? input.id.toLowerCase(),
    ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
  };
}

async function harness(
  role: 'owner' | 'admin' = 'owner',
  overrides: {
    usersList?: () => Promise<SlackDirectoryUsersPage>;
    usersInfo?: (botToken: string, userId: string) => Promise<SlackDirectoryUserInfoResult>;
    rateLimiter?: (identity: SqliteIdentityStore) => AuthRateLimiter;
    revokeBetterAuthSessions?: (betterAuthUserId: string) => Promise<number>;
  } = {},
) {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW });
  const people = [
    member({ id: 'UINVITEE1', displayName: 'Ada', handle: 'ada' }),
    member({ id: 'UBOT00001', displayName: 'Bot', bot: true }),
    member({ id: 'UDELETED1', displayName: 'Deleted', deleted: true }),
    member({ id: 'UGUEST001', displayName: 'Guest', restricted: true }),
    member({ id: 'UFOREIGN1', displayName: 'Foreign', teamId: 'TOTHER' }),
  ];
  const app = new Hono();
  app.use('/admin/api/*', async (c, next) => {
    setRequestPrincipal(c.req.raw, principal(owner, role));
    await next();
  });
  app.route('/admin/api', createTeamAdminApi({
    store: () => identity,
    now: () => NOW,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    resolveCredentials: async () => ({
      botToken: 'xoxb-team', botUserId: 'UBOTOWNER',
      signingSecret: 'signing-secret', connectionRevision: 'revision_connected',
    }),
    usersList: overrides.usersList ?? (async () => ({
      ok: true, error: undefined, members: people,
      nextCursor: undefined, retryAfterMs: undefined,
    })),
    usersInfo: overrides.usersInfo ?? (async (_token, userId) => ({
      ok: true, error: undefined,
      member: people.find((candidate) => candidate.id === userId),
      retryAfterMs: undefined,
    })),
    ...(overrides.rateLimiter ? { rateLimiter: async () => overrides.rateLimiter!(identity) } : {}),
    ...(overrides.revokeBetterAuthSessions
      ? { revokeBetterAuthSessions: async (_c, userId) => overrides.revokeBetterAuthSessions!(userId) }
      : {}),
  }));
  return { app, identity, owner, people };
}

test('Team directory exposes only exact active humans and preserves Slack disambiguators', async () => {
  const { app, identity } = await harness();
  try {
    const response = await app.request('https://app.example/admin/api/team/directory');
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as {
      members: Array<{ slackUserId: string; displayName: string; handle: string }>;
      nextCursor: string | null;
    };
    assert.deepEqual(body.members, [{
      slackUserId: 'UINVITEE1', displayName: 'Ada', handle: 'ada',
      realName: 'Ada', avatarUrl: null,
    }]);
    assert.equal(body.nextCursor, null);
  } finally {
    identity.close();
  }
});

test('Owner creates one exact Slack invitation while Admin cannot invite', async () => {
  const ownerHarness = await harness('owner');
  try {
    const created = await ownerHarness.app.request('https://app.example/admin/api/team/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slackUserId: 'UINVITEE1' }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const body = await created.json() as {
      invitation: Record<string, unknown> & { slackTeamId: string; slackUserId: string };
      inviteLink: string;
    };
    assert.equal(body.invitation.slackTeamId, 'T12345678');
    assert.equal(body.invitation.slackUserId, 'UINVITEE1');
    assert.equal(body.invitation.displayName, 'Ada');
    assert.equal(body.invitation.role, 'admin');
    assert.equal(body.invitation.status, 'pending');
    assert.equal(body.invitation.expiresAt, NOW + 7 * 24 * 60 * 60_000);
    assert.match(body.inviteLink, /^https:\/\/app\.example\/auth\/slack\/invite#invite=/);
    assert.doesNotMatch(JSON.stringify(await ownerHarness.identity.exportSummary()), /BwcHBwcH/);
  } finally {
    ownerHarness.identity.close();
  }

  const adminHarness = await harness('admin');
  try {
    const denied = await adminHarness.app.request('https://app.example/admin/api/team/invitations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slackUserId: 'UINVITEE1' }),
    });
    assert.equal(denied.status, 403);
  } finally {
    adminHarness.identity.close();
  }
});

test('duplicate invitation reuses the frozen tuple without minting another locator', async () => {
  const { app, identity } = await harness();
  try {
    const request = () => app.request('https://app.example/admin/api/team/invitations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slackUserId: 'UINVITEE1' }),
    });
    const created = await request();
    assert.equal(created.status, 201);
    const first = await created.json() as { invitation: { id: string }; inviteLink: string };
    assert.match(first.inviteLink, /#invite=/);

    const duplicate = await request();
    assert.equal(duplicate.status, 200);
    const second = await duplicate.json() as { invitation: { id: string }; inviteLink: null };
    assert.equal(second.invitation.id, first.invitation.id);
    assert.equal(second.inviteLink, null);
    assert.equal((await identity.listInvitations()).filter((row) => row.status === 'pending').length, 1);
  } finally {
    identity.close();
  }
});

test('Slack directory failures remain retryable and honor Slack retry timing', async () => {
  const outage = await harness('owner', {
    usersList: async () => { throw new Error('synthetic Slack outage'); },
  });
  try {
    const response = await outage.app.request('https://app.example/admin/api/team/directory');
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'slack_directory_unavailable' });
  } finally {
    outage.identity.close();
  }

  const throttled = await harness('owner', {
    usersList: async () => ({
      ok: false, error: 'ratelimited', members: [], nextCursor: undefined, retryAfterMs: 5_000,
    }),
  });
  try {
    const response = await throttled.app.request('https://app.example/admin/api/team/directory');
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.deepEqual(await response.json(), { error: 'slack_rate_limited' });
  } finally {
    throttled.identity.close();
  }
});

test('Team API rate limits repeated failures and rejects oversized invite bodies before Slack lookup', async () => {
  let infoCalls = 0;
  const team = await harness('owner', {
    usersInfo: async () => {
      infoCalls += 1;
      return { ok: true, error: undefined, member: undefined, retryAfterMs: undefined };
    },
    rateLimiter: (identity) => new AuthRateLimiter(identity, {
      pepper: 'team-rate-limit-pepper-at-least-thirty-two-characters',
      now: () => NOW, perKeyLimit: 1, globalLimit: 100,
    }),
  });
  try {
    const request = (body: string) => team.app.request('https://app.example/admin/api/team/invitations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const first = await request(JSON.stringify({ slackUserId: 'UMISSING1' }));
    assert.equal(first.status, 404);
    const limited = await request(JSON.stringify({ slackUserId: 'UMISSING1' }));
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(infoCalls, 1);

    const oversizedTeam = await harness('owner');
    try {
      const oversized = await oversizedTeam.app.request('https://app.example/admin/api/team/invitations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slackUserId: `U${'A'.repeat(2_100)}` }),
      });
      assert.equal(oversized.status, 400);
      assert.equal((await oversizedTeam.identity.listInvitations()).length, 0);
    } finally {
      oversizedTeam.identity.close();
    }
  } finally {
    team.identity.close();
  }
});

test('removed Admin is eligible for an exact fresh invitation and existing sessions are revoked', async () => {
  const revokedUsers: string[] = [];
  const team = await harness('owner', {
    revokeBetterAuthSessions: async (userId) => { revokedUsers.push(userId); return 2; },
  });
  try {
    const firstInvite = await team.identity.createInvitation({
      organizationId: team.owner.membership.organizationId,
      slackTeamId: 'T12345678', slackUserId: 'UINVITEE1', displayName: 'Ada', role: 'admin',
      locatorHash: 'd'.repeat(64), inviterMembershipId: team.owner.membership.id,
      expiresAt: NOW + 60_000,
    });
    const admin = await team.identity.consumeInvitation({
      invitationId: firstInvite.id, locatorHash: 'd'.repeat(64),
      slackTeamId: 'T12345678', slackUserId: 'UINVITEE1', displayName: 'Ada',
      betterAuthUserId: 'ba_user_removed_admin', betterAuthMembershipId: 'ba_member_removed_admin',
    });
    const removed = await team.app.request(
      `https://app.example/admin/api/team/memberships/${admin.membership.id}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'removed' }) },
    );
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.deepEqual(revokedUsers, ['ba_user_removed_admin']);
    assert.equal((await team.identity.getMembership(admin.membership.id))?.status, 'removed');

    const directory = await team.app.request('https://app.example/admin/api/team/directory');
    assert.equal(directory.status, 200);
    assert.deepEqual((await directory.json() as { members: Array<{ slackUserId: string }> }).members
      .map((row) => row.slackUserId), ['UINVITEE1']);
    const reinvite = await team.app.request('https://app.example/admin/api/team/invitations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slackUserId: 'UINVITEE1' }),
    });
    assert.equal(reinvite.status, 201, await reinvite.clone().text());
  } finally {
    team.identity.close();
  }
});
