import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { InstallationContextError, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { ManagementActorContext } from '../src/management/types.ts';
import {
  agentAvatarInstallation,
  agentAvatarUrl,
  agentAvatarUrlForPresentation,
  uploadAgentAvatar,
} from '../src/slack/agent-presence/avatar-assets.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { REQUESTED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const TOKEN = 'hosted-admin-slack-token';
const ORIGIN = 'https://hosted.example';
const HOSTED = { CHICKPEA_TENANCY: 'installation' };
const ENV_A = scopeInstallationEnv(HOSTED, { installationId: 'inst_tenant_a' });
const ENV_B = scopeInstallationEnv(HOSTED, { installationId: 'inst_tenant_b' });

function agent(id: string): Omit<CustomAgentConfig, 'revision'> {
  return {
    id, kind: 'user', name: 'Support', instructions: '', enabled: true, lifecycle: 'active',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'unpublished',
      health: 'unpublished', avatar: { kind: 'generated', revision: 1, seed: 'support' },
    },
  };
}

function stores(t: TestContext) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => {
    config.close();
    settings.close();
    identity.close();
    invalidateSlackInstallationCredentialCache();
  });
  return { config, settings, identity };
}

test('a hosted Agent avatar URL names its installation, and a standalone one is unchanged', async (t) => {
  assert.equal(agentAvatarInstallation(undefined), undefined);
  assert.equal(agentAvatarInstallation({}), undefined);
  assert.equal(agentAvatarInstallation(ENV_A), 'inst_tenant_a');
  assert.equal(agentAvatarUrl(`${ORIGIN}/admin`, 'agent_support', 3),
    `${ORIGIN}/assets/agents/agent_support/avatar/3`);
  assert.equal(agentAvatarUrl(`${ORIGIN}/admin`, 'agent_support', 3, agentAvatarInstallation({})),
    `${ORIGIN}/assets/agents/agent_support/avatar/3`);
  assert.equal(agentAvatarUrl(ORIGIN, 'agent_support', 3, agentAvatarInstallation(ENV_A)),
    `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/3`);

  const { config, settings } = stores(t);
  const created = await config.createAgent(agent('agent_support'));
  assert.equal(agentAvatarUrlForPresentation(created, ORIGIN, 'inst_tenant_a'),
    `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/1`);
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
    0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
  const uploaded = await uploadAgentAvatar({
    config, settings, agentId: 'agent_support', bytes: png, contentType: 'image/png',
    publicOrigin: ORIGIN, installationId: 'inst_tenant_a',
  });
  assert.equal(uploaded.slackPresence?.avatar.url, `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/2`);
});

test('a stored avatar URL from before installations were named is served in the named form', () => {
  const stored = (url: string): CustomAgentConfig => ({
    ...agent('agent_support'), revision: 1,
    slackPresence: { ...agent('agent_support').slackPresence!, avatar: { kind: 'uploaded', revision: 2, url } },
  });
  const unnamed = stored(`${ORIGIN}/assets/agents/agent_support/avatar/2`);
  assert.equal(agentAvatarUrlForPresentation(unnamed, ORIGIN, 'inst_tenant_a'),
    `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/2`);
  assert.equal(agentAvatarUrlForPresentation(unnamed, ORIGIN), `${ORIGIN}/assets/agents/agent_support/avatar/2`,
    'standalone keeps the stored URL');
  assert.equal(agentAvatarUrlForPresentation(unnamed, undefined, 'inst_tenant_a'),
    `${ORIGIN}/assets/agents/agent_support/avatar/2`, 'without an origin nothing can be checked');
  for (const url of [
    'https://avatars.example.test/agent_support.png',
    'https://other.example/assets/agents/agent_support/avatar/2',
    `${ORIGIN}/assets/agents/agent_support/avatar/2?v=1`,
    `${ORIGIN}/assets/agents/agent_other/avatar/2`,
    `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/2`,
  ]) {
    assert.equal(agentAvatarUrlForPresentation(stored(url), ORIGIN, 'inst_tenant_a'), url, url);
  }
  assert.throws(() => agentAvatarInstallation(HOSTED), InstallationContextError, 'an unscoped env names nothing');
});

test('the avatar route serves an installation\'s avatar only under that installation', async (t) => {
  const { config, settings } = stores(t);
  await config.createAgent(agent('agent_support'));
  const app = createAdminRoutes({ store: config, settings, ...testAdminAuthority(TOKEN, ORIGIN) });
  const get = (path: string, env: Record<string, unknown>) => app.request(`${ORIGIN}${path}`, {}, env);

  const hosted = await get('/assets/i/inst_tenant_a/agents/agent_support/avatar/1', ENV_A);
  assert.equal(hosted.status, 200);
  assert.equal(hosted.headers.get('content-type'), 'image/png');
  assert.equal((await get('/assets/i/inst_tenant_a/agents/agent_support/avatar/1', ENV_B)).status, 404,
    'another installation\'s segment is refused');
  assert.equal((await get('/assets/agents/agent_support/avatar/1', ENV_A)).status, 404,
    'a hosted installation serves no unnamed avatar URL');

  const standalone = await get('/assets/agents/agent_support/avatar/1', {});
  assert.equal(standalone.status, 200);
  assert.deepEqual(new Uint8Array(await standalone.arrayBuffer()), new Uint8Array(await hosted.arrayBuffer()));
  assert.equal((await get('/assets/i/inst_tenant_a/agents/agent_support/avatar/1', {})).status, 404);
});

test('a hosted installation\'s Slack card reports its bot and record, without the standalone app\'s fields', async (t) => {
  const { config, settings, identity } = stores(t);
  const keyring = generateCredentialKeyring();
  const credentials = { state: identity, keyring };
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-hosted-card', botUserId: 'UBOT', appId: 'AHOSTED1', teamId: 'T_TEST',
    grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES], validatedAt: Date.now(),
  });
  const created = await config.ensureWorkspaceInstallation({
    workspaceId: 'T_TEST', transportMode: 'direct', teamId: 'T_TEST', appId: 'AHOSTED1', botUserId: 'UBOT',
  });
  await config.updateWorkspaceInstallation('T_TEST', {
    health: 'needs_attention', healthDetail: 'events_verification_pending',
  }, created.revision);
  const previousFetch = globalThis.fetch;
  const tokens: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    assert.equal(new URL(request.url).pathname, '/api/auth.test');
    tokens.push(request.headers.get('authorization') ?? '');
    return Response.json({ ok: true, team_id: 'T_TEST', team: 'Tenant Workspace', user_id: 'UBOT', app_id: 'AHOSTED1' });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const app = createAdminRoutes({
    store: config, settings, slackCredentials: credentials, ...testAdminAuthority(TOKEN, ORIGIN, identity),
  });

  const response = await app.request(`${ORIGIN}/admin/api/slack-connection`, { headers: testAdminHeaders(TOKEN) }, ENV_A);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    credentials: { botToken: 'stored', botUserId: 'stored' },
    connected: true,
    teamId: 'T_TEST',
    teamName: 'Tenant Workspace',
    appId: 'AHOSTED1',
    transportMode: 'direct',
    health: 'needs_attention',
    healthDetail: 'events_verification_pending',
    gateway: null,
    hosted: true,
    slackPermissions: { status: 'current', canUpdate: false, updatePath: null },
  });
  assert.deepEqual(tokens, ['Bearer xoxb-hosted-card'], 'the workspace name came from the installation\'s bot');

  // The connection test and the channel picker use the same bot.
  await app.request(`${ORIGIN}/admin/api/slack-connection/test`, { method: 'POST', headers: testAdminHeaders(TOKEN) }, ENV_A);
  assert.deepEqual([...new Set(tokens)], ['Bearer xoxb-hosted-card']);

  await config.updateWorkspaceInstallation('T_TEST', { health: 'revoked', healthDetail: 'app_uninstalled' });
  const ended = await (await app.request(`${ORIGIN}/admin/api/slack-connection`,
    { headers: testAdminHeaders(TOKEN) }, ENV_A)).json() as { health: string; connected: boolean };
  assert.equal(ended.health, 'revoked');
});

test('a new hosted installation\'s Slack card is healthy before any event arrives', async (t) => {
  const { config, settings, identity } = stores(t);
  const credentials = { state: identity, keyring: generateCredentialKeyring() };
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-hosted-new', botUserId: 'UBOT', appId: 'AHOSTED1', teamId: 'TTEST',
    grantedScopes: ['chat:write'], validatedAt: Date.now(),
  });
  await syncHostedWorkspaceInstallation(ENV_A, { teamId: 'TTEST', appId: 'AHOSTED1', botUserId: 'UBOT' }, config);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    ok: true, team_id: 'TTEST', team: 'Tenant Workspace', user_id: 'UBOT', app_id: 'AHOSTED1',
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const app = createAdminRoutes({
    store: config, settings, slackCredentials: credentials, ...testAdminAuthority(TOKEN, ORIGIN, identity),
  });

  const card = await (await app.request(`${ORIGIN}/admin/api/slack-connection`,
    { headers: testAdminHeaders(TOKEN) }, ENV_A)).json() as { connected: boolean; health: string; healthDetail: string | null };
  assert.deepEqual({ connected: card.connected, health: card.health, healthDetail: card.healthDetail },
    { connected: true, health: 'healthy', healthDetail: null });
});

test('Admin presents a management-created Agent\'s avatar at the URL Slack posts, hosted and standalone', async (t) => {
  const f = await createManagementAdapterFixture('hosted-admin-avatar');
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    f.close();
    settings.close();
  });
  const context: ManagementActorContext = {
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'hosted-admin-avatar' },
  };
  const created = await f.service.applyWorkspaceChanges({
    context,
    idempotencyKey: 'hosted-admin-avatar-create',
    operations: [{
      itemId: 'create',
      kind: 'create_agent',
      agent: {
        id: 'agent_support', name: 'Support Triage', requestedHandle: 'support',
        instructions: 'Triage support requests.', enabled: true,
        skills: [], mcpServers: [], apiConnections: [], repositories: [],
      },
    }],
  });
  assert.equal(created.status, 'completed');
  const stored = await f.config.getAgent('agent_support');
  assert.equal(stored.slackPresence?.avatar.kind, 'generated');
  assert.equal(stored.slackPresence?.avatar.url, undefined, 'the store leaves the URL to presentation');

  const app = createAdminRoutes({ store: f.config, settings, ...testAdminAuthority(TOKEN, ORIGIN, f.identity) });
  for (const { env, expected } of [
    { env: ENV_A, expected: `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/1` },
    { env: {}, expected: `${ORIGIN}/assets/agents/agent_support/avatar/1` },
  ]) {
    const listed = await app.request(`${ORIGIN}/admin/api/agents`, { headers: testAdminHeaders(TOKEN) }, env);
    assert.equal(listed.status, 200);
    const { agents } = await listed.json() as {
      agents: Array<{ id: string; slackPresence?: { avatar: { url?: string } } }>;
    };
    const presented = agents.find(({ id }) => id === 'agent_support')?.slackPresence?.avatar.url;
    assert.equal(presented, expected);
    assert.equal(presented, agentAvatarUrlForPresentation(stored, ORIGIN, agentAvatarInstallation(env)),
      'Slack posts the same image');
    const image = await app.request(expected, {}, env);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
  }
});
