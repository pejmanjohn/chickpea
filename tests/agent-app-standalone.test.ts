import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import app from '../src/app.ts';
import { channel as slackChannel, processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { EncryptedCredentialStore } from '../src/config/settings-store.ts';
import { closeNodeStateStores, resolveStores, type AppStores, type PlatformEnv } from '../src/config/state-backend.ts';
import type { AgentSlackPresence, CustomAgentConfig } from '../src/config/types.ts';
import { type AgentSlackAppsHost, agentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { withAgentAppExecution } from '../src/slack/agent-apps/index.ts';
import { writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { createAgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { agentDirectoryAppHome } from '../src/slack/app-home.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { invalidateStoredSlackPublicUrl } from '../src/slack/credentials.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import { withHostedSlackApp } from '../src/slack/hosted-slack-app.ts';
import type { SlackInstallationExecutionContext } from '../src/slack/installation-execution.ts';
import { invalidateSlackInstallationCredentialCache, writeHostedSlackBotCredentials } from '../src/slack/installation-credentials.ts';
import { stopNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import { escapeMrkdwn } from '../src/slack/ui/text.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { withDirectSlackInstall } from './helpers/direct-slack-install.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};
const HOSTED_APP = { appId: 'AHOSTED1', signingSecret: 'hosted-app-signing-secret' };
const ADMIN_TOKEN = 'admin-token';
const MEMBER = {
  team_id: 'T1', deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, is_stranger: false,
};
const NOT_FOUND = [404, 404, 404, 404, 404, 404];

const groupPresence: AgentSlackPresence = {
  requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
  avatar: { kind: 'generated', revision: 1, seed: 'support' }, userGroupId: 'SSUPPORT',
};

async function createSupport(stores: AppStores, creatorMembershipId: string): Promise<CustomAgentConfig> {
  return stores.config.createAgent({
    id: 'agent_support', name: 'Support', instructions: 'Help with support.', enabled: true, lifecycle: 'active',
    creatorMembershipId, editPolicy: 'creator_and_admins', model: 'local-stub/support',
    skills: [], mcpServers: [], apiConnections: [], repositories: [], slackPresence: groupPresence,
  });
}

/** Every read of an Agent app's secrets or a configuration token, by realm key. */
function watchAgentAppRealm(stores: AppStores): string[] {
  const settings = stores.settings as unknown as EncryptedCredentialStore;
  const read = settings.getEncryptedCredentialRevision.bind(settings);
  const keys: string[] = [];
  settings.getEncryptedCredentialRevision = async (key) => {
    if (key.startsWith('agent-slack-app.') || key.startsWith('slack-configuration-token.')) keys.push(key);
    return read(key);
  };
  return keys;
}

/** The Owner's directory as Chickpea built it before Agent apps existed: no rows of theirs. */
async function todaysHome(stores: AppStores): Promise<string> {
  return JSON.stringify(agentDirectoryAppHome([await stores.config.getAgent('agent_support')], { unavailableNotice: false }));
}

/** The four Core paths and the two Admin paths, each as an Owner would reach it. */
async function agentAppPathStatuses(env: PlatformEnv | undefined, stores: AppStores): Promise<number[]> {
  const core = await Promise.all([
    app.request('/channels/slack/agent-apps/events', { method: 'POST', body: '{}' }, env),
    app.request('/channels/slack/agent-apps/interactions', { method: 'POST', body: 'payload=%7B%7D' }, env),
    app.request('/channels/slack/agent-apps/allow/agent_support', {}, env),
    app.request('/channels/slack/agent-apps/callback?code=c&state=s', {}, env),
  ]);
  const admin = createAdminRoutes({ store: stores.config, settings: stores.settings, ...testAdminAuthority(ADMIN_TOKEN) });
  const owner = testAdminHeaders(ADMIN_TOKEN);
  const pages = await Promise.all([
    admin.request('/admin/agents/agent_support/slack-app', { headers: owner }, env),
    admin.request('/admin/api/agents/agent_support/slack-app/token', {
      method: 'POST', body: 'action=paste&refreshToken=xoxe-1-x',
      headers: { ...owner, 'content-type': 'application/x-www-form-urlencoded' },
    }, env),
  ]);
  return [...core, ...pages].map((response) => response.status);
}

/**
 * Support's record names a live app with its secrets in the realm, yet the
 * executor's resolver answers with the installation's own context and never
 * reads the realm.
 */
async function resolvesAsInstallation(env: PlatformEnv | undefined, stores: AppStores, realmReads: string[]): Promise<void> {
  const support = await stores.config.getAgent('agent_support');
  await stores.config.updateAgent(support.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: groupPresence.avatar, released: { userGroupId: 'SSUPPORT' },
      app: { state: 'active', at: 1, app: { appId: 'A0AGENT1', clientId: '1.c' }, icon: 'agent_avatar', botUserId: 'UAGENTBOT', installedAt: 1, installedBy: 'U1' },
    },
  }, support.revision);
  await writeAppSecrets(
    { credentials: stores.settings as unknown as EncryptedCredentialStore, keyring: loadCredentialKeyring(env), slack: createAgentAppSlackApi() },
    'A0AGENT1', support.id, { clientSecret: 'cs', signingSecret: 'ss', botToken: 'xoxb-agent-bot' }, null,
  );
  realmReads.length = 0;
  const base = { workspaceId: 'T1', transportMode: 'direct', sharedAppReads: false, botToken: 'xoxb-installation' } as SlackInstallationExecutionContext;
  assert.equal(await withAgentAppExecution(async () => base, env)('T1', support.id), base);
  assert.deepEqual(realmReads, [], 'the executor never reads an Agent app secret');
}

function viewOf(body: URLSearchParams | Record<string, unknown> | undefined): string | undefined {
  const view = body instanceof URLSearchParams ? body.get('view') : body?.view;
  if (view === undefined || view === null) return undefined;
  return typeof view === 'string' ? view : JSON.stringify(view);
}

async function eventually<T>(read: () => T | undefined): Promise<T | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

function isolateStores(t: TestContext): void {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-agent-app-standalone-'));
  for (const key of keys.slice(0, 3)) process.env[key] = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  closeNodeStateStores();
  t.after(() => {
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
}

test('Core never installs the port itself: only a host can', () => {
  const callers = (function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.ts') && /\bconfigureAgentSlackApps\s*\(/.test(readFileSync(path, 'utf8'))
        ? [relative(ROOT, path).split(sep).join('/')]
        : [];
    });
  })(join(ROOT, 'src'));
  assert.deepEqual(callers, ['src/slack/agent-apps/host.ts'], 'only its definition names it');
  assert.equal(agentSlackAppsHost(), undefined, 'loading Core installs no port');
});

test("a self-hosted direct install has no port: the Owner's App Home is today's, the paths are not found, and nothing reads the realm", async () => {
  await withDirectSlackInstall({
    answer: (method, body) => method === 'users.info'
      ? { ok: true, user: { id: body.get('user'), name: body.get('user'), ...MEMBER } }
      : method === 'users.conversations' ? { ok: true, channels: [], response_metadata: { next_cursor: '' } } : undefined,
  }, async (install) => {
    assert.equal(agentSlackAppsHost(), undefined);
    await createSupport(install.stores, install.ownerMembershipId);
    const realmReads = watchAgentAppRealm(install.stores);
    const opened = await install.deliver('events', {
      token: '', team_id: 'T1', api_app_id: 'A1', type: 'event_callback', event_id: 'EvHome1', event_time: 1,
      authorizations: [{ team_id: 'T1', user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
      event: { type: 'app_home_opened', user: 'U1', channel: 'DHOME', tab: 'home' },
    });
    assert.equal(opened.status, 200);
    const published = await eventually(() => viewOf(install.calls.find((call) => call.method === 'views.publish')?.body));
    assert.equal(published, await todaysHome(install.stores));
    assert.deepEqual(await agentAppPathStatuses(undefined, install.stores), NOT_FOUND);
    assert.deepEqual(realmReads, []);
    await resolvesAsInstallation(undefined, install.stores, realmReads);
  });
});

test("a self-hosted gateway install has no port: the Owner's App Home is today's, the paths are not found, and nothing reads the realm", async (t) => {
  isolateStores(t);
  const stores = resolveStores();
  const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
  await stores.config.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT', gatewayBindingId: 'binding1', runtimeContract: 'chickpea-v1',
  });
  await createSupport(stores, owner.membership.id);
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const gateway = {
    workspaceId: 'T1',
    async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' }; },
    async call(operation: string, input: Record<string, unknown>) {
      calls.push({ operation, input });
      if (operation === 'users.info') return { user: { id: input.user, name: String(input.user), ...MEMBER } };
      if (operation === 'users.conversations') return { channels: [] };
      if (operation === 'views.publish') return {};
      throw new Error(`Unexpected gateway operation: ${operation}`);
    },
  } as unknown as GatewayDeploymentClient;
  const realmReads = watchAgentAppRealm(stores);
  assert.equal(await processGatewaySlackEnvelope({
    workspaceId: 'T1', eventId: 'EvHome1', eventTime: 1,
    event: { type: 'app_home_opened', user: 'U1', channel: 'DHOME', tab: 'home', event_ts: '1800000000.000001' },
  }, undefined, gateway, { stores }), 'accepted');
  assert.equal(viewOf(calls.find((call) => call.operation === 'views.publish')?.input), await todaysHome(stores));
  assert.deepEqual(await agentAppPathStatuses(undefined, stores), NOT_FOUND);
  assert.deepEqual(realmReads, []);
  await resolvesAsInstallation(undefined, stores, realmReads);
});

test("a hosted installation with the switch off is today's; only with it on does the Owner's App Home offer the app", async (t) => {
  await stopNodeTurnRelay();
  isolateStores(t);
  const previousFetch = globalThis.fetch;
  invalidateSlackInstallationCredentialCache();
  invalidateStoredSlackPublicUrl();
  t.after(() => {
    globalThis.fetch = previousFetch;
    configureAgentSlackApps(undefined);
    invalidateSlackInstallationCredentialCache();
    invalidateStoredSlackPublicUrl();
  });
  const env = withHostedSlackApp(
    scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation', SLACK_TAG_PUBLIC_URL: 'https://hosted.example' }, { installationId: 'inst_tenant_a' }),
    HOSTED_APP,
  );
  const stores = resolveStores(env);
  const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
  await writeHostedSlackBotCredentials({ state: stores.identity, keyring: loadCredentialKeyring() }, null, {
    botToken: 'xoxb-hosted-bot', botUserId: 'UBOT', appId: HOSTED_APP.appId, teamId: 'T1',
    grantedScopes: ['chat:write', 'users:read'], validatedAt: Date.now(),
  });
  await syncHostedWorkspaceInstallation(env, { teamId: 'T1', appId: HOSTED_APP.appId, botUserId: 'UBOT' });
  await createSupport(stores, owner.membership.id);
  const published: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1)!;
    const body = new URLSearchParams(await request.clone().text().catch(() => ''));
    if (method === 'views.publish') published.push(viewOf(body)!);
    const answer = method === 'users.info'
      ? { ok: true, user: { id: body.get('user'), name: body.get('user'), ...MEMBER } }
      : method === 'users.conversations' ? { ok: true, channels: [], response_metadata: { next_cursor: '' } } : { ok: true };
    return Response.json(answer, { headers: { 'x-oauth-scopes': 'chat:write,users:read' } });
  }) as typeof fetch;
  const ingress = new Hono();
  ingress.route('/channels/slack', slackChannel.route());
  let events = 0;
  const openHome = async (): Promise<string | undefined> => {
    events += 1;
    const raw = JSON.stringify({
      token: '', team_id: 'T1', api_app_id: HOSTED_APP.appId, type: 'event_callback', event_id: `EvHome${events}`, event_time: events,
      authorizations: [{ team_id: 'T1', user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
      event: { type: 'app_home_opened', user: 'U1', channel: 'DHOME', tab: 'home' },
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = createHmac('sha256', HOSTED_APP.signingSecret).update(`v0:${timestamp}:${raw}`).digest('hex');
    const before = published.length;
    const response = await ingress.request('/channels/slack/events', {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` },
    }, env);
    assert.equal(response.status, 200);
    return eventually(() => published.length > before ? published.at(-1) : undefined);
  };

  const realmReads = watchAgentAppRealm(stores);
  assert.equal(await openHome(), await todaysHome(stores));
  assert.deepEqual(await agentAppPathStatuses(env, stores), NOT_FOUND);
  assert.deepEqual(realmReads, []);

  configureAgentSlackApps(HOST);
  const offered = await openHome() ?? '';
  assert.ok(offered.includes(escapeMrkdwn('Give @support its own Slack app')), "the Owner's App Home offers the app once the port is installed");
  assert.ok(offered.includes('"url":"https://hosted.example/admin/agents/agent_support/slack-app"'), "the offer links to this installation's token page");
  configureAgentSlackApps(undefined);
  assert.equal(await openHome(), await todaysHome(stores), 'turning the switch off takes the offer away again');
  await resolvesAsInstallation(env, stores, realmReads);
});
