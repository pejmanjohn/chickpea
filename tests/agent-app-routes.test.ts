import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps, withAgentSlackAppHandoff } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, createAgentSlackAppRoutes } from '../src/slack/agent-apps/index.ts';
import type { AgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'admin-token';
const TEAM = 'T_TEST';
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};
const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });

function principal(role: AuthPrincipal['role'], machine = false): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_test', role,
    authenticatorKind: machine ? 'personal_token' : 'test_slack_session', credentialId: `credential_${role}`,
    correlationId: `request_${role}`, machine,
  };
}

/** The signed-in people agentActor resolves: one active membership per role, each with a Slack user. */
const people = {
  getMembership: async (id: string) => ({ id, userId: id.replace('membership_', 'user_'), status: 'active' }),
  getUser: async (id: string) => ({ id, displayName: id, slackUserId: id.replace('user_', 'U').toUpperCase(), slackTeamId: TEAM }),
  recordAuthAudit: async () => undefined,
} as unknown as IdentityStore;

function agent(id: string): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name: 'Support', instructions: 'You are Support.', enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: { requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: id }, userGroupId: 'S1' },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

/** A service whose Slack and main bot never answer; the page and its gate are what these tests watch. */
function fakeService(config: SqliteConfigStore, settings: SqliteSettingsStore, slack: Partial<AgentAppSlackApi> = {}) {
  const refuse = (name: string) => async (): Promise<never> => { throw new Error(`unexpected ${name}`); };
  const api = {
    rotate: refuse('rotate'), create: refuse('create'), update: refuse('update'), setIcon: refuse('setIcon'),
    exchange: refuse('exchange'), uninstall: refuse('uninstall'), delete: refuse('delete'), ...slack,
  } as AgentAppSlackApi;
  const calls: string[] = [];
  const service = new AgentSlackApps({
    env: HOSTED, stores: { config, settings }, host: HOST, slack: api, keyring: generateCredentialKeyring('k1'),
    transport: {
      disableUserGroup: async (id) => { calls.push(`disable:${id}`); return { id, name: 'Support', handle: 'support', disabled: true }; },
      enableUserGroup: refuse('enableUserGroup'),
      openDirectConversation: async (user) => { calls.push(`dm:${user}`); return { id: `D_${user}`, private: true, member: true, archived: false }; },
      postMessage: async (input) => { calls.push(`post:${input.channelId}`); return { channelId: input.channelId, ts: '1.0' }; },
    },
  });
  return { service, calls };
}

async function adminApp(t: TestContext, options: { role?: AuthPrincipal['role']; port?: boolean; slack?: Partial<AgentAppSlackApi> } = {}) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); configureAgentSlackApps(undefined); });
  const support = await config.createAgent(agent('agent_support'));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  const { service, calls } = fakeService(config, settings, options.slack);
  configureAgentSlackApps(options.port === false ? undefined : HOST);
  const app = createAdminRoutes({
    store: config, settings,
    agentSlackApps: async () => service,
    ...testAdminAuthority(TOKEN, undefined, people, principal(options.role ?? 'owner')),
  });
  const request = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    app.request(path, { ...init, headers: { ...testAdminHeaders(TOKEN), ...(init.headers as Record<string, string> | undefined), ...headers } }, HOSTED);
  const form = (fields: Record<string, string>): RequestInit => ({
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  return { request, form, service, calls, config, settings };
}

test('the token page and its form are for Owners with the port, and 404 without it', async (t) => {
  const owner = await adminApp(t);
  const page = await owner.request('/admin/agents/agent_support/slack-app');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Let Chickpea create Slack apps for your Agents/);
  assert.match(html, /To give Support its own Slack app, Chickpea needs a Slack app configuration token for this workspace\. You only do this once\./);
  assert.match(html, /name="refreshToken" type="password"/);
  assert.match(html, /Starts with xoxe-/);
  assert.match(html, /Create Support(&#39;|')s Slack app/);
  assert.match(html, /<p>If Slack doesn(&#39;|')t offer this workspace when you choose Generate Token, you already hold as many tokens as Slack allows there\. Delete one you no longer use under Your App Configuration Tokens, or ask another Owner to do this step\.<\/p>/);
  assert.equal(html.includes('replacing each other'), false);
  assert.match(html, /Chickpea only changes the apps it creates for your Agents/);
  assert.equal(html.includes('Remove the configuration token'), false, 'nothing to remove yet');

  const member = await adminApp(t, { role: 'member' });
  assert.equal((await member.request('/admin/agents/agent_support/slack-app')).status, 403);
  assert.equal((await member.request('/admin/api/agents/agent_support/slack-app/token', member.form({ action: 'paste', refreshToken: 'xoxe-1-x' }))).status, 403);
  const admin = await adminApp(t, { role: 'admin' });
  assert.equal((await admin.request('/admin/agents/agent_support/slack-app')).status, 403);

  const unported = await adminApp(t, { port: false });
  assert.equal((await unported.request('/admin/agents/agent_support/slack-app')).status, 404);
  assert.equal((await unported.request('/admin/api/agents/agent_support/slack-app/token', unported.form({ action: 'paste', refreshToken: 'xoxe-1-x' }))).status, 404);
  assert.equal((await owner.request('/admin/agents/agent_missing/slack-app')).status, 404);
});

test('a cross-origin form post never reaches the token API', async (t) => {
  const owner = await adminApp(t);
  const foreign = await owner.request(
    '/admin/api/agents/agent_support/slack-app/token',
    owner.form({ action: 'paste', refreshToken: 'xoxe-1-x' }),
    { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
  );
  assert.equal(foreign.status, 403);
  assert.equal(await owner.service.hasConfigurationToken(), false);
  assert.deepEqual(owner.calls, []);
});

test('a pasted token is checked with Slack, refused with the right sentence, and a good one starts the app', async (t) => {
  let team = 'T_OTHER';
  const rotations: string[] = [];
  const owner = await adminApp(t, {
    slack: {
      rotate: async (refreshToken) => { rotations.push(refreshToken); return { accessToken: 'xoxe.xoxp-1-a', refreshToken: 'xoxe-1-r', teamId: team, expiresAt: Date.now() + 3_600_000 }; },
      create: async () => ({ appId: 'A0APP1', clientId: '1.c', clientSecret: 'cs', signingSecret: 'ss' }),
      update: async () => undefined,
      setIcon: async () => 'set',
    },
  });
  const api = '/admin/api/agents/agent_support/slack-app/token';
  const notRefresh = await owner.request(api, owner.form({ action: 'paste', refreshToken: 'xoxe.xoxp-1-access' }));
  assert.equal(notRefresh.status, 400);
  assert.match(await notRefresh.text(), /That isn(&#39;|')t a refresh token\. Copy the Refresh Token, which starts with xoxe-\./);
  assert.deepEqual(rotations, []);

  const other = await owner.request(api, owner.form({ action: 'paste', refreshToken: 'xoxe-1-other-team-0000' }));
  assert.equal(other.status, 400);
  assert.match(await other.text(), /That token is for a different Slack workspace\. Generate one for this workspace\./);
  assert.equal(await owner.service.hasConfigurationToken(), false);

  team = TEAM;
  const good = await owner.request(api, owner.form({ action: 'paste', refreshToken: 'xoxe-1-good-token-0000' }));
  assert.equal(good.status, 200);
  const html = await good.text();
  assert.match(html, /Creating Support(&#39;|')s Slack app/);
  assert.match(html, /Go back to Slack\. Chickpea will message you in a moment so you can allow it\./);
  assert.equal(html.includes('xoxe-1-good-token-0000'), false, 'the token never echoes');
  assert.deepEqual(owner.calls, ['disable:S1', 'dm:UOWNER', 'post:D_UOWNER']);
  const presence = (await owner.config.getAgent('agent_support')).slackPresence;
  assert.equal(presence?.kind, 'agent_app');

  const again = await owner.request(api, owner.form({ action: 'create' }));
  assert.equal(again.status, 409);
  assert.match(await again.text(), /Support already has its own Slack app\./);

  const withToken = await owner.request('/admin/agents/agent_support/slack-app');
  assert.match(await withToken.text(), /Remove the configuration token/);
  const removed = await owner.request(api, owner.form({ action: 'remove' }));
  assert.equal(removed.status, 200);
  assert.match(await removed.text(), /Chickpea deleted its copy of your configuration token\. To revoke it in Slack too, open Your Apps and choose Delete token under Your App Configuration Tokens\./);
  assert.equal(await owner.service.hasConfigurationToken(), false);
  assert.equal(rotations.length, 2, 'removal makes no Slack call');
});

test('the public allow and callback paths exist only with the port and an Owner handoff', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); configureAgentSlackApps(undefined); });
  const support = await config.createAgent(agent('agent_support'));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  await config.updateAgent(support.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'pending',
      avatar: support.slackPresence!.avatar, released: { userGroupId: 'S1' },
      app: { state: 'awaiting_consent', at: 1, startedBy: 'UOWNER', app: { appId: 'A0APP1', clientId: '1.c' }, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.0' } },
    },
  }, support.revision);
  const { service } = fakeService(config, settings);
  const app = createAgentSlackAppRoutes({ service: async () => service });
  const owner = withAgentSlackAppHandoff(HOSTED, { kind: 'owner', slackUserId: 'UOWNER' });
  const delivery = withAgentSlackAppHandoff(HOSTED, { kind: 'delivery', agentId: 'agent_support', appId: 'A0APP1', signingSecret: 's' });

  assert.equal((await app.request('/channels/slack/agent-apps/allow/agent_support', {}, owner)).status, 404, 'no port');
  configureAgentSlackApps(HOST);
  assert.equal((await app.request('/channels/slack/agent-apps/allow/agent_support', {}, HOSTED)).status, 404, 'no handoff');
  assert.equal((await app.request('/channels/slack/agent-apps/allow/agent_support', {}, delivery)).status, 404, 'wrong handoff');
  const allowed = await app.request('/channels/slack/agent-apps/allow/agent_support', {}, owner);
  assert.equal(allowed.status, 303);
  const state = new URL(allowed.headers.get('location')!).searchParams.get('state')!;

  assert.equal((await app.request(`/channels/slack/agent-apps/callback?code=c&state=${state}`, {}, HOSTED)).status, 404, 'no handoff');
  const cancelled = await app.request(`/channels/slack/agent-apps/callback?error=access_denied&state=${state}`, {}, owner);
  assert.equal(cancelled.status, 200);
  assert.match(await cancelled.text(), /wasn&#39;t added/);
});
