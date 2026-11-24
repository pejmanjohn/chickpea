import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps, withAgentSlackAppHandoff } from '../src/slack/agent-apps/host.ts';
import { createAgentSlackAppRoutes } from '../src/slack/agent-apps/index.ts';
import { AgentSlackApps } from '../src/slack/agent-apps/service.ts';
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
function fakeService(config: SqliteConfigStore, settings: SqliteSettingsStore, slack: Partial<AgentAppSlackApi> = {}, permissionMissing = false) {
  const refuse = (name: string) => async (): Promise<never> => { throw new Error(`unexpected ${name}`); };
  const api = {
    rotate: refuse('rotate'), create: refuse('create'), update: refuse('update'), setIcon: refuse('setIcon'),
    exchange: refuse('exchange'), uninstall: refuse('uninstall'), delete: refuse('delete'), ...slack,
  } as AgentAppSlackApi;
  const calls: string[] = [];
  const service = new AgentSlackApps({
    env: HOSTED, stores: { config, settings }, host: HOST, slack: api, keyring: generateCredentialKeyring('k1'), armSwitch: async () => undefined,
    transport: {
      disableUserGroup: async (id) => { calls.push(`disable:${id}`); return { id, name: 'Support', handle: 'support', disabled: true }; },
      enableUserGroup: refuse('enableUserGroup'),
      lookupChannel: refuse('lookupChannel'), joinPublicChannel: refuse('joinPublicChannel'), channelHasMember: refuse('channelHasMember'),
      openDirectConversation: async (user) => { calls.push(`dm:${user}`); return { id: `D_${user}`, private: true, member: true, archived: false }; },
      postMessage: async (input) => { calls.push(`post:${input.channelId}`); return { channelId: input.channelId, ts: '1.0' }; },
    },
    userGroupPermissionMissing: async () => permissionMissing,
    memberInSlack: async (id) => ({ membershipId: id, slackUserId: id, role: 'owner' }),
  });
  return { service, calls };
}

async function adminApp(
  t: TestContext,
  options: {
    role?: AuthPrincipal['role']; machine?: boolean; port?: boolean; slack?: Partial<AgentAppSlackApi>; permissionMissing?: boolean;
  } = {},
) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); configureAgentSlackApps(undefined); });
  const support = await config.createAgent(agent('agent_support'));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  const { service, calls } = fakeService(config, settings, options.slack, options.permissionMissing);
  configureAgentSlackApps(options.port === false ? undefined : HOST);
  const app = createAdminRoutes({
    store: config, settings,
    agentSlackApps: async () => service,
    ...testAdminAuthority(TOKEN, undefined, people, principal(options.role ?? 'owner', options.machine)),
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

/** The Admin page's config island: what the script reads at start-up. */
async function adminConfig(response: Response): Promise<Record<string, unknown>> {
  const html = await response.text();
  const config = html.match(/<script id="chickpea-admin-config" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(config, `Admin page config: ${response.status}`);
  return JSON.parse(config) as Record<string, unknown>;
}

test("the older per-Agent token page sends a person to Admin's token page, and is gone without the port", async (t) => {
  const owner = await adminApp(t);
  const moved = await owner.request('/admin/agents/agent_support/slack-app');
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), '/admin/destinations/slack/connection/token');
  const formPost = await owner.request('/admin/api/agents/agent_support/slack-app/token', owner.form({ action: 'paste', refreshToken: 'xoxe-1-x' }));
  assert.equal(formPost.status, 415, 'Admin refuses a form post: the token is pasted through the JSON API only');
  assert.equal(await owner.service.hasConfigurationToken(), false);

  const unported = await adminApp(t, { port: false });
  assert.equal((await unported.request('/admin/agents/agent_support/slack-app')).status, 404);
});

test('Admin offers Agents in Slack only to an Owner signed in as themselves, and only with the port', async (t) => {
  // A page every role opens; the flag is the same on every Admin page.
  const path = '/admin';
  assert.equal((await adminConfig(await (await adminApp(t)).request(path))).agentSlackAppsOffered, true);
  assert.equal((await adminConfig(await (await adminApp(t)).request('/admin/destinations/slack/connection/token'))).agentSlackAppsOffered, true);
  // An Owner's personal token opens no page at all; the API refuses it too.
  for (const options of [{ role: 'admin' as const }, { role: 'member' as const }, { port: false }]) {
    const response = await (await adminApp(t, options)).request(path);
    assert.equal((await adminConfig(response)).agentSlackAppsOffered, false, JSON.stringify(options));
  }
});

test("without the Owner's user-group permission a press starts nothing and says so, and the token is kept", async (t) => {
  const owner = await adminApp(t, {
    permissionMissing: true,
    slack: { rotate: async () => ({ accessToken: 'xoxe.xoxp-1-a', refreshToken: 'xoxe-1-r', teamId: TEAM, expiresAt: Date.now() + 3_600_000 }) },
  });
  const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  assert.equal((await owner.request('/admin/api/slack-apps/token', json('PUT', { refreshToken: 'xoxe-1-good-token-0000' }))).status, 200);
  const pressed = await owner.request('/admin/api/slack-apps/agents/agent_support/start', json('POST', {}));
  assert.equal(pressed.status, 409);
  assert.deepEqual(await pressed.json(), { error: 'permission_needed' });
  assert.deepEqual(owner.calls, ['dm:UOWNER', 'post:D_UOWNER'], 'the Owner is told in Slack too, and no handle is released');
  assert.equal(await owner.service.hasConfigurationToken(), true, 'the token is kept for the next start');
  assert.equal((await owner.config.getAgent('agent_support')).slackPresence?.kind, undefined);
});

test('the public allow and callback paths exist only with the port and an Owner handoff', async (t) => {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
