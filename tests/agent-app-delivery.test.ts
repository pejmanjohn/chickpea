import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import { serveAgentAppSlackDelivery } from '../src/channels/slack.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { EncryptedCredentialStore } from '../src/config/settings-store.ts';
import { closeNodeStateStores, resolveStores, type AppStores, type PlatformEnv } from '../src/config/state-backend.ts';
import type { AgentAppLifecycle, CustomAgentConfig } from '../src/config/types.ts';
import {
  type AgentSlackAppsHost,
  agentSlackAppIngress,
  configureAgentSlackApps,
  endAgentSlackApp,
  withAgentSlackAppHandoff,
} from '../src/slack/agent-apps/host.ts';
import { createAgentSlackAppRoutes } from '../src/slack/agent-apps/index.ts';
import { readAppSecrets, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { createAgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { invalidateStoredSlackPublicUrl } from '../src/slack/credentials.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import { withHostedSlackApp } from '../src/slack/hosted-slack-app.ts';
import { invalidateSlackInstallationCredentialCache, writeHostedSlackBotCredentials } from '../src/slack/installation-credentials.ts';
import { stopNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import { uiActionId, uiBlockId, uiValue } from '../src/slack/ui/surface.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation', SLACK_TAG_PUBLIC_URL: 'https://hosted.example' };
const MAIN_APP = { appId: 'AHOSTED1', signingSecret: 'main-app-signing-secret' };
const MAIN_BOT = 'xoxb-main-bot';
const TEAM = 'TTENANT1';
const AGENT_APP = 'A0AGENT1';
const AGENT_SECRET = 'agent-app-signing-secret';
const AGENT_BOT = 'xoxb-agent-bot';
const AGENT_BOT_USER = 'UAGENTBOT';
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};

interface SlackCall { method: string; token: string | undefined; body: URLSearchParams }

interface Harness {
  stores: AppStores;
  calls: SlackCall[];
  base: PlatformEnv;
  delivery: PlatformEnv;
  installedAt: number;
  deliver(kind: 'events' | 'interactions', body: unknown, options?: { env?: PlatformEnv; secret?: string }): Promise<Response>;
  secrets(): { credentials: EncryptedCredentialStore; keyring: ReturnType<typeof loadCredentialKeyring>; slack: ReturnType<typeof createAgentAppSlackApi> };
}

function userAgent(id: string, name: string, handle: string): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, instructions: `You are ${name}.`, enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: {
      requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: id }, userGroupId: `S${handle.toUpperCase()}`,
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

async function withHarness(t: TestContext, run: (harness: Harness) => Promise<void>): Promise<void> {
  await stopNodeTurnRelay();
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-agent-app-'));
  process.env.TAG_DB_PATH = ':memory:';
  process.env.SLACK_STATE_DB_PATH = ':memory:';
  process.env.CHICKPEA_AUTH_DB_PATH = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  const previousFetch = globalThis.fetch;
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
  invalidateStoredSlackPublicUrl();
  configureAgentSlackApps(HOST);
  t.after(() => {
    globalThis.fetch = previousFetch;
    configureAgentSlackApps(undefined);
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    invalidateStoredSlackPublicUrl();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  const base = scopeInstallationEnv(HOSTED, { installationId: 'inst_tenant_a' });
  const stores = resolveStores(base);
  await createSlackOwner(stores.identity, { teamId: TEAM, userId: 'U1' });
  await writeHostedSlackBotCredentials({ state: stores.identity, keyring: loadCredentialKeyring() }, null, {
    botToken: MAIN_BOT, botUserId: 'UBOT', appId: MAIN_APP.appId, teamId: TEAM,
    grantedScopes: ['chat:write', 'users:read'], validatedAt: Date.now(),
  });
  await syncHostedWorkspaceInstallation(withHostedSlackApp(base, MAIN_APP), { teamId: TEAM, appId: MAIN_APP.appId, botUserId: 'UBOT' });
  const installedAt = Date.now() - 60_000;
  const support = await stores.config.createAgent(userAgent('agent_support', 'Support', 'support'));
  await stores.config.createAgent(userAgent('agent_finance', 'Finance', 'finance'));
  const live: AgentAppLifecycle = {
    state: 'active', at: installedAt, app: { appId: AGENT_APP, clientId: '1.client' }, icon: 'agent_avatar',
    botUserId: AGENT_BOT_USER, installedAt, installedBy: 'U1',
  };
  await stores.config.updateAgent(support.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: support.slackPresence!.avatar, app: live, released: { userGroupId: 'SSUPPORT' },
    },
  }, support.revision);
  const secrets = () => ({
    credentials: stores.settings as unknown as EncryptedCredentialStore, keyring: loadCredentialKeyring(), slack: createAgentAppSlackApi(),
  });
  await writeAppSecrets(secrets(), AGENT_APP, support.id, { clientSecret: 'client-secret', signingSecret: AGENT_SECRET, botToken: AGENT_BOT }, null);

  const calls: SlackCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    assert.equal(url.hostname, 'slack.com', `no call leaves for ${url.hostname}`);
    const method = url.pathname.split('/').at(-1)!;
    const body = new URLSearchParams(await request.clone().text().catch(() => ''));
    const authorization = request.headers.get('authorization') ?? undefined;
    calls.push({ method, token: authorization?.replace(/^Bearer /, '') ?? body.get('token') ?? undefined, body });
    const user = body.get('user') ?? 'U1';
    const answer = method === 'auth.test'
      ? { ok: true, team_id: TEAM, user_id: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: AGENT_APP, team: 'Tenant' }
      : method === 'users.info'
        ? { ok: true, user: { id: user, team_id: TEAM, name: user, deleted: false, is_bot: false, is_app_user: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false } }
        : method === 'conversations.info'
          ? { ok: true, channel: { id: body.get('channel'), is_im: true, user: 'U1' } }
          : method === 'conversations.members'
            ? { ok: true, members: ['U1', AGENT_BOT_USER], response_metadata: { next_cursor: '' } }
            : method === 'conversations.open'
              ? { ok: true, channel: { id: 'DOWNER' } }
              : method.startsWith('chat.')
                ? { ok: true, ts: '1900000000.000100', channel: body.get('channel') ?? 'D1' }
                : { ok: true };
    return Response.json(answer, { headers: { 'x-oauth-scopes': 'chat:write,users:read' } });
  }) as typeof fetch;

  const ingress = new Hono();
  ingress.route('/', createAgentSlackAppRoutes({ serveDelivery: serveAgentAppSlackDelivery }));
  const delivery = withAgentSlackAppHandoff(base, { kind: 'delivery', agentId: support.id, appId: AGENT_APP, signingSecret: AGENT_SECRET });
  await run({
    stores, calls, base, delivery, installedAt, secrets,
    async deliver(kind, body, options = {}) {
      const raw = kind === 'events' ? JSON.stringify(body) : new URLSearchParams({ payload: JSON.stringify(body) }).toString();
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const signature = createHmac('sha256', options.secret ?? AGENT_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
      return ingress.request(`/channels/slack/agent-apps/${kind}`, {
        method: 'POST',
        headers: {
          'content-type': kind === 'events' ? 'application/json' : 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': `v0=${signature}`,
        },
        body: raw,
      }, options.env ?? delivery);
    },
  });
}

function dmEvent(patch: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    type: 'event_callback', event_id: `Ev${now}`, event_time: now, team_id: TEAM, api_app_id: AGENT_APP,
    authorizations: [{ team_id: TEAM, user_id: AGENT_BOT_USER, is_bot: true, is_enterprise_install: false }],
    event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'hello', ts: `${now}.000100`, event_ts: `${now}.000100`, ...event },
    ...patch,
  };
}

async function appOf(stores: AppStores): Promise<AgentAppLifecycle | undefined> {
  const presence = (await stores.config.getAgent('agent_support')).slackPresence;
  return presence?.kind === 'agent_app' ? presence.app : undefined;
}

test("a delivery is served only with the port and a delivery handoff, verified with the app's own secret", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', dmEvent(), { env: h.base })).status, 404, 'no handoff');
  assert.equal((await h.deliver('events', dmEvent(), { env: withAgentSlackAppHandoff(h.base, { kind: 'owner', slackUserId: 'U1' }) })).status, 404, 'an Owner handoff is not a delivery');
  configureAgentSlackApps(undefined);
  assert.equal((await h.deliver('events', dmEvent())).status, 404, 'no port');
  configureAgentSlackApps(HOST);
  assert.equal((await h.deliver('events', dmEvent(), { secret: MAIN_APP.signingSecret })).status, 401, "the workspace app's secret does not verify an Agent app's delivery");
  assert.equal((await h.deliver('events', dmEvent({ api_app_id: MAIN_APP.appId }))).status, 404, 'another app');
  assert.equal((await h.deliver('events', dmEvent({ team_id: 'TOTHER', authorizations: [{ team_id: 'TOTHER' }] }))).status, 404, 'another workspace');
  assert.equal(h.calls.length, 0, 'nothing was trusted before verification');

  const served = await h.deliver('events', dmEvent());
  assert.equal(served.status, 200);
  const info = h.calls.filter((call) => call.method === 'users.info');
  assert.ok(info.length > 0, 'the delivery was admitted and the person looked up');
  assert.ok(info.every((call) => call.token === AGENT_BOT), "admission runs as the Agent's own bot");
  assert.equal(h.calls.some((call) => call.token === MAIN_BOT), false, 'the workspace bot is never used for an Agent app delivery');
}));

test("an interaction is served the same way and runs with the Agent's client", async (t) => withHarness(t, async (h) => {
  const surfaceId = 'ui_surface_agent_1';
  const click = {
    type: 'block_actions', api_app_id: AGENT_APP, team: { id: TEAM }, user: { id: 'U1' }, trigger_id: 'trigger-1',
    channel: { id: 'D1' }, message: { ts: '1900000000.000050', thread_ts: '1900000000.000050' },
    actions: [{ type: 'button', action_id: uiActionId('host', 'approval', 0), block_id: uiBlockId('host', surfaceId, 1), value: uiValue(surfaceId, 0), action_ts: '1900000000.000060' }],
  };
  assert.equal((await h.deliver('interactions', click, { env: h.base })).status, 404, 'no handoff');
  assert.equal((await h.deliver('interactions', click, { secret: MAIN_APP.signingSecret })).status, 401);
  assert.equal((await h.deliver('interactions', { ...click, api_app_id: MAIN_APP.appId })).status, 404, 'another app');
  assert.equal((await h.deliver('interactions', { ...click, team: { id: 'TOTHER' } })).status, 404, 'another workspace');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.deliver('interactions', click)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.calls.some((call) => call.token === MAIN_BOT), false, "a click on the Agent's message never uses the workspace bot");
  assert.ok(h.calls.every((call) => call.token === AGENT_BOT), "every call the click makes is the Agent's");
}));

test('an app_uninstalled ends only that Agent app: the bot token goes, the Owner is told, the installation and other Agents stand', async (t) => withHarness(t, async (h) => {
  assert.deepEqual(await agentSlackAppIngress(h.base, AGENT_APP), { agentId: 'agent_support', teamId: TEAM, signingSecret: AGENT_SECRET });
  assert.equal(await agentSlackAppIngress(h.base, 'A0UNKNOWN'), undefined);

  const before = Math.floor(h.installedAt / 1_000) - 10;
  assert.equal(await endAgentSlackApp(h.base, AGENT_APP, dmEvent({ event_time: before }, { type: 'app_uninstalled' })), 'ignored', 'an event from before the install is about an earlier app');
  assert.equal(await endAgentSlackApp(h.base, AGENT_APP, dmEvent({}, { type: 'tokens_revoked', tokens: { bot: ['UOTHERBOT'] } })), 'ignored', "another bot's revocation");
  assert.equal(await endAgentSlackApp(h.base, AGENT_APP, dmEvent({}, { type: 'tokens_revoked', tokens: { oauth: ['U1'] } })), 'ignored', "a person's token");
  assert.equal((await appOf(h.stores))?.state, 'active');
  assert.equal(h.calls.length, 0);

  const ended = await h.deliver('events', dmEvent({}, { type: 'app_uninstalled' }));
  assert.equal(ended.status, 200);
  const app = await appOf(h.stores);
  assert.equal(app?.state, 'needs_attention');
  assert.equal(app?.state === 'needs_attention' && app.reason, 'app_removed');
  assert.equal((await readAppSecrets(h.secrets(), AGENT_APP))?.secrets.botToken, undefined, 'the bot token is dropped');
  assert.notEqual((await h.stores.config.getWorkspaceInstallation(TEAM))?.health, 'revoked', 'the installation stands');
  assert.equal((await h.stores.config.getAgent('agent_finance')).slackPresence?.userGroupId, 'SFINANCE', 'other Agents untouched');
  const removedDm = h.calls.find((call) => call.method === 'chat.postMessage');
  assert.equal(removedDm?.token, MAIN_BOT, 'the Owner hears it from Chickpea');
  assert.match(removedDm?.body.get('text') ?? '', /removed from this workspace/);
  assert.equal(await agentSlackAppIngress(h.base, AGENT_APP) !== undefined, true, 'the app record is still known to the ingress while it waits for Allow');

  assert.equal(await endAgentSlackApp(h.base, AGENT_APP, dmEvent({}, { type: 'app_uninstalled' })), 'ignored', 'ending twice changes nothing');
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  assert.equal(h.calls.filter((call) => call.token === AGENT_BOT).length, 0, 'a removed app runs nothing as its bot');
}));
