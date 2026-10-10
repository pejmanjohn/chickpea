import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import { configureHostedSlackPermissionsUpdate, resetSlackPermissionsMemo } from '../src/slack/hosted-permissions.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { REQUESTED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { ownerUserGroupToken, ownerUserGroupTokenWorks } from '../src/slack/user-group-authority.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const OWNER_TOKEN = 'xoxp-lt8-owner-secret';
const NEW_OWNER_TOKEN = 'xoxp-lt8-new-owner-secret';
const BOT_TOKEN = 'xoxb-lt8-bot-secret';
const SESSION = 'lt8-admin-session';
const UPDATE_PATH = '/start/reinstall';

type Credential = 'owner' | 'bot';
/** Slack's error code for one call, or undefined for ok. */
type SlackAnswer = (credential: Credential, method: string) => string | undefined;

const botDisableDenied = (credential: Credential, method: string) =>
  credential === 'bot' && method === 'usergroups.disable' ? 'permission_denied' : undefined;

/** Slack refuses the Owner's token with `code` on every user-group call, and the bot may not disable. */
const ownerRefused = (code: string): SlackAnswer => (credential, method) =>
  credential === 'owner' && method.startsWith('usergroups.') ? code : botDisableDenied(credential, method);

/** A demoted Owner may still read user groups; only the change is refused. */
const ownerDemoted: SlackAnswer = (_credential, method) =>
  method === 'usergroups.disable' ? 'permission_denied' : undefined;

function publishedAgent(): CustomAgentConfig {
  return {
    id: 'agent_support', kind: 'user', revision: 1, name: 'Support', instructions: 'You are Support.',
    enabled: true, lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: 'agent_support' }, userGroupId: 'S_SUPPORT',
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

async function hostedTenant(t: TestContext, answer: SlackAnswer) {
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'info', () => undefined);
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_lt8' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  resetSlackPermissionsMemo();
  configureHostedSlackPermissionsUpdate({ path: UPDATE_PATH, grantsUserGroupToken: true });
  t.after(() => {
    config.close();
    settings.close();
    identity.close();
    invalidateSlackInstallationCredentialCache();
    resetSlackPermissionsMemo();
    configureHostedSlackPermissionsUpdate(undefined);
  });
  const owner = await createSlackOwner(identity, { teamId: 'TTEST', userId: 'UOWNER' });
  const credentials = { state: identity, keyring: generateCredentialKeyring() };
  const write = (expected: string | null, userGroupToken: string) => writeHostedSlackBotCredentials(credentials, expected, {
    botToken: BOT_TOKEN, userGroupToken, botUserId: 'UBOT', appId: 'AHOSTED1', teamId: 'TTEST',
    grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES], validatedAt: Date.now(),
  });
  const revision = await write(null, OWNER_TOKEN);
  await syncHostedWorkspaceInstallation(env, { teamId: 'TTEST', appId: 'AHOSTED1', botUserId: 'UBOT' }, config);
  await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Tenant Workspace');
  await config.createAgent(publishedAgent());

  const calls: string[] = [];
  const group = { id: 'S_SUPPORT', name: 'Support', handle: 'support', description: '', date_update: 1, date_delete: 0 };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1)!;
    const credential: Credential = request.headers.get('authorization') === `Bearer ${BOT_TOKEN}` ? 'bot' : 'owner';
    calls.push(`${credential}:${method}`);
    const code = answer(credential, method);
    if (code) return Response.json({ ok: false, error: code });
    if (method === 'usergroups.disable') group.date_delete = 2;
    return Response.json({
      ok: true, usergroups: [group], usergroup: group, channels: [], members: [], response_metadata: { next_cursor: '' },
    });
  });

  const principal: AuthPrincipal = {
    userId: owner.user.id, membershipId: owner.membership.id, organizationId: owner.membership.organizationId,
    role: 'owner', authenticatorKind: 'test_slack_session', credentialId: 'session_owner',
    correlationId: 'request_owner', machine: false,
  };
  const app = createAdminRoutes({
    store: config, settings, slackCredentials: credentials,
    ...testAdminAuthority(SESSION, undefined, identity, principal),
  });
  return {
    calls,
    revision,
    write,
    bar: async () => {
      const response = await app.request('http://localhost/admin/api/slack-connection', {
        headers: testAdminHeaders(SESSION),
      }, env);
      assert.equal(response.status, 200);
      return ((await response.json()) as { slackPermissions?: { status: string } }).slackPermissions?.status;
    },
    archive: async () => {
      const response = await app.request('http://localhost/admin/api/agents/agent_support/archive', {
        method: 'POST',
        headers: { ...testAdminHeaders(SESSION), 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1 }),
      }, env);
      return { status: response.status, body: await response.text() };
    },
  };
}

const deadTokenAnswers: Array<[string, SlackAnswer]> = [
  ['the token was revoked', ownerRefused('token_revoked')],
  ['the Owner left Slack', ownerRefused('account_inactive')],
  ['the token no longer authenticates', ownerRefused('invalid_auth')],
  ['the token expired', ownerRefused('token_expired')],
  ['the Owner was demoted', ownerDemoted],
  ['Slack does not allow the Owner any more', ownerRefused('not_allowed')],
];

for (const [why, answer] of deadTokenAnswers) {
  test(`when ${why}, Admin's permissions bar asks for an update again, and the update clears it`, async (t) => {
    const tenant = await hostedTenant(t, answer);
    assert.equal(await tenant.bar(), 'current', 'the bundle holds a working Owner token');

    const archived = await tenant.archive();
    assert.equal(archived.status, 409, archived.body);
    assert.equal(JSON.parse(archived.body).recovery.title, 'Slack could not finish archiving @support');
    assert.ok(tenant.calls.includes('owner:usergroups.disable'), 'the Owner token was tried');
    assert.equal(await tenant.bar(), 'update_needed');

    await tenant.write(tenant.revision, NEW_OWNER_TOKEN);
    assert.equal(await tenant.bar(), 'current', 'the update stores a new token');
  });
}

for (const code of ['ratelimited', 'service_unavailable', 'internal_error']) {
  test(`Slack answering ${code} to the Owner token is not a dead token, so the bar stays current`, async (t) => {
    const tenant = await hostedTenant(t, (credential, method) =>
      credential === 'owner' && method === 'usergroups.disable' ? code : undefined);
    const archived = await tenant.archive();
    assert.notEqual(archived.status, 200, archived.body);
    assert.ok(tenant.calls.includes('owner:usergroups.disable'));
    assert.equal(await tenant.bar(), 'current');
  });
}

test('an archive the Owner token finishes leaves the bar current', async (t) => {
  const tenant = await hostedTenant(t, botDisableDenied);
  const archived = await tenant.archive();
  assert.equal(archived.status, 200, archived.body);
  assert.equal(await tenant.bar(), 'current');
});

test('the dead-token record belongs to one credential revision, so a late refusal from another cannot raise or clear the bar', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const before = { userGroupToken: OWNER_TOKEN, connectionRevision: 'rev_1' };
  const after = { userGroupToken: NEW_OWNER_TOKEN, connectionRevision: 'rev_2' };
  const stale = ownerUserGroupToken(before, settings)!;
  assert.equal(stale.token, OWNER_TOKEN);
  assert.equal(await ownerUserGroupTokenWorks(before, settings), true);

  await stale.dead();
  assert.equal(await ownerUserGroupTokenWorks(before, settings), false);
  assert.equal(await ownerUserGroupTokenWorks(after, settings), true, 'a new revision starts working');

  await ownerUserGroupToken(after, settings)!.dead();
  await stale.dead();
  assert.equal(await ownerUserGroupTokenWorks(after, settings), false, 'the older revision\'s late refusal keeps the newer record');
  assert.equal(await ownerUserGroupTokenWorks({ userGroupToken: NEW_OWNER_TOKEN, connectionRevision: 'rev_3' }, settings), true);
  assert.equal(ownerUserGroupToken({ userGroupToken: undefined, connectionRevision: 'rev_2' }, settings), undefined);
  assert.equal(await ownerUserGroupTokenWorks({ userGroupToken: undefined, connectionRevision: 'rev_3' }, settings), false);
});
