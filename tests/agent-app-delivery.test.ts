import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { Hono, type ExecutionContext } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { channel as slackChannel, markSlackInstallationEnded, serveAgentAppSlackDelivery } from '../src/channels/slack.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { EncryptedCredentialStore } from '../src/config/settings-store.ts';
import { closeNodeStateStores, getSettingsStore, resolveStores, type AppStores, type PlatformEnv } from '../src/config/state-backend.ts';
import type { AgentAppLifecycle, CustomAgentConfig } from '../src/config/types.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import type { ManagementActorContext } from '../src/management/types.ts';
import {
  type AgentSlackAppsHost,
  agentSlackAppIngress,
  configureAgentSlackApps,
  endAgentSlackApp,
  retireAgentSlackApps,
  withAgentSlackAppHandoff,
} from '../src/slack/agent-apps/host.ts';
import { agentAppPresenceHooks, createAgentSlackAppRoutes } from '../src/slack/agent-apps/index.ts';
import { readAppSecrets, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { createAgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { generateCredentialKeyring, loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_CHANNEL_ADD_ACTION } from '../src/slack/agent-channel-offer.ts';
import { invalidateStoredSlackPublicUrl } from '../src/slack/credentials.ts';
import { configureHostedSlackPermissionsUpdate } from '../src/slack/hosted-permissions.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import { slackInstallationCredentialId, withHostedSlackApp } from '../src/slack/hosted-slack-app.ts';
import {
  invalidateSlackInstallationCredentialCache,
  resolveSlackInstallationCredentials,
  SlackCredentialRecoveryOnlyError,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { stopNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import { recordDeliveredSlackAgentMessage } from '../src/slack/public-context.ts';
import { SLACK_READ_MESSAGES, SlackReadError } from '../src/slack/reading/errors.ts';
import { slackReadingService } from '../src/slack/reading/tools.ts';
import { createDirectSlackTransport } from '../src/slack/transport/direct.ts';
import type { PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { uiActionId, uiBlockId, uiSurfaceId, uiValue } from '../src/slack/ui/surface.ts';
import { escapeMrkdwn } from '../src/slack/ui/text.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
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
  /** The hosted bot's active credential revision. */
  hostedRevision: string;
  ownerMembershipId: string;
  deliver(kind: 'events' | 'interactions', body: unknown, options?: { env?: PlatformEnv; secret?: string }): Promise<Response>;
  /** The same Slack event or click as Chickpea's own app receives it; settles once the work it detaches is done. */
  deliverToChickpea(body: unknown, kind?: 'events' | 'interactions'): Promise<Response>;
  secrets(): { credentials: EncryptedCredentialStore; keyring: ReturnType<typeof loadCredentialKeyring>; slack: ReturnType<typeof createAgentAppSlackApi> };
}

function userAgent(id: string, name: string, handle: string): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, instructions: `You are ${name}.`, enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1, model: 'local-stub/agent-app',
    slackPresence: {
      requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: id }, userGroupId: `S${handle.toUpperCase()}`,
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

/**
 * `lostHostedBot` writes the hosted bot's bundle under a key this deployment never holds, so it cannot be read.
 * `notMemberOf` names, per bot token, the Channels that bot is not in until it joins one; every bot is in every other Channel.
 * `privateChannels` are private; every other Channel is public. As in Slack, a bot not in a private Channel is answered
 *   `channel_not_found` when it looks the Channel up.
 * `refuse` answers a call, keyed `<method> <token>`, with that Slack error.
 * `rateLimited` answers a call, keyed the same way, with HTTP 429 and a one-second Retry-After.
 * `history` and `replies` are the messages `conversations.history` and `conversations.replies` return.
 */
async function withHarness(
  t: TestContext,
  run: (harness: Harness) => Promise<void>,
  options: {
    lostHostedBot?: boolean;
    notMemberOf?: Partial<Record<string, readonly string[]>>;
    privateChannels?: readonly string[];
    refuse?: Partial<Record<string, string>>;
    rateLimited?: readonly string[];
    history?: readonly Record<string, unknown>[];
    replies?: readonly Record<string, unknown>[];
  } = {},
): Promise<void> {
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
  const owner = await createSlackOwner(stores.identity, { teamId: TEAM, userId: 'U1' });
  const hostedKeyring = options.lostHostedBot ? generateCredentialKeyring('key_lost') : loadCredentialKeyring();
  const hostedRevision = await writeHostedSlackBotCredentials({ state: stores.identity, keyring: hostedKeyring }, null, {
    botToken: MAIN_BOT, botUserId: 'UBOT', appId: MAIN_APP.appId, teamId: TEAM,
    grantedScopes: ['chat:write', 'users:read'], validatedAt: Date.now(),
  });
  await syncHostedWorkspaceInstallation(withHostedSlackApp(base, MAIN_APP), { teamId: TEAM, appId: MAIN_APP.appId, botUserId: 'UBOT' });
  const installedAt = Date.now() - 60_000;
  const support = await stores.config.createAgent(userAgent('agent_support', 'Support', 'support'));
  await stores.config.createAgent(userAgent('agent_finance', 'Finance', 'finance'));
  await stores.config.putChannel({ workspaceId: TEAM, channelId: 'C1', label: 'team', lifecycle: 'active' }, 0);
  for (const agentId of ['agent_support', 'agent_finance']) {
    await stores.config.putAgentChannelGrant({
      workspaceId: TEAM, channelId: 'C1', agentId, status: 'active',
      createdByMembershipId: owner.membership.id, channelLabel: 'team', channelIsPrivate: false,
    }, 0);
  }
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
  const outside = new Map(Object.entries(options.notMemberOf ?? {}).map(([token, channels]) => [token, new Set(channels)]));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    assert.equal(url.hostname, 'slack.com', `no call leaves for ${url.hostname}`);
    const method = url.pathname.split('/').at(-1)!;
    const body = new URLSearchParams(await request.clone().text().catch(() => ''));
    const authorization = request.headers.get('authorization') ?? undefined;
    const token = authorization?.replace(/^Bearer /, '') ?? body.get('token') ?? undefined;
    calls.push({ method, token, body });
    const user = body.get('user') ?? 'U1';
    const channel = body.get('channel') ?? '';
    const refusal = options.refuse?.[`${method} ${token}`];
    if (refusal) return Response.json({ ok: false, error: refusal });
    if (options.rateLimited?.includes(`${method} ${token}`)) {
      return Response.json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': '1' } });
    }
    if (method === 'conversations.info' && options.privateChannels?.includes(channel) && outside.get(token ?? '')?.has(channel)) {
      return Response.json({ ok: false, error: 'channel_not_found' });
    }
    if (method === 'conversations.join') outside.get(token ?? '')?.delete(channel);
    const answer = method === 'auth.test'
      ? token === MAIN_BOT
        ? { ok: true, team_id: TEAM, user_id: 'UBOT', bot_id: 'BCHICKPEA', app_id: MAIN_APP.appId, team: 'Tenant' }
        : { ok: true, team_id: TEAM, user_id: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: AGENT_APP, team: 'Tenant' }
      : method === 'users.info'
        ? { ok: true, user: { id: user, team_id: TEAM, name: user, deleted: false, is_bot: false, is_app_user: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false } }
        : method === 'conversations.info'
          ? { ok: true, channel: channel.startsWith('C')
            ? {
              id: channel, name: 'team', is_channel: true, is_private: options.privateChannels?.includes(channel) ?? false,
              is_member: !outside.get(token ?? '')?.has(channel), is_archived: false,
            }
            : { id: channel, is_im: true, user: 'U1' } }
          : method === 'conversations.join'
            ? { ok: true, channel: { id: channel, name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false } }
          : method === 'conversations.members'
            ? {
              ok: true,
              members: ['U1', 'U2', ...([[MAIN_BOT, 'UBOT'], [AGENT_BOT, AGENT_BOT_USER]] as const)
                .flatMap(([botToken, botUser]) => outside.get(botToken)?.has(channel) ? [] : [botUser])],
              response_metadata: { next_cursor: '' },
            }
            : method === 'conversations.open'
              ? { ok: true, channel: { id: 'DOWNER' } }
              : method === 'conversations.history' || method === 'conversations.replies'
                ? { ok: true, messages: (method === 'conversations.history' ? options.history : options.replies) ?? [] }
              : method.startsWith('chat.')
                ? { ok: true, ts: '1900000000.000100', channel: body.get('channel') ?? 'D1' }
                : { ok: true };
    return Response.json(answer, { headers: { 'x-oauth-scopes': 'chat:write,users:read' } });
  }) as typeof fetch;

  const ingress = new Hono();
  ingress.route('/', createAgentSlackAppRoutes({ serveDelivery: serveAgentAppSlackDelivery }));
  ingress.route('/channels/slack', slackChannel.route());
  const signed = (path: string, raw: string, secret: string, env: PlatformEnv, ctx?: ExecutionContext) => {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex');
    const contentType = path.endsWith('/events') ? 'application/json' : 'application/x-www-form-urlencoded';
    return ingress.request(path, {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` },
      body: raw,
    }, env, ctx);
  };
  const delivery = withAgentSlackAppHandoff(base, { kind: 'delivery', agentId: support.id, appId: AGENT_APP, signingSecret: AGENT_SECRET });
  await run({
    stores, calls, base, delivery, installedAt, hostedRevision, secrets, ownerMembershipId: owner.membership.id,
    async deliver(kind, body, options = {}) {
      const raw = kind === 'events' ? JSON.stringify(body) : new URLSearchParams({ payload: JSON.stringify(body) }).toString();
      return signed(`/channels/slack/agent-apps/${kind}`, raw, options.secret ?? AGENT_SECRET, options.env ?? delivery);
    },
    async deliverToChickpea(body, kind = 'events') {
      const detached: Promise<unknown>[] = [];
      const ctx: ExecutionContext = { waitUntil: (task) => { detached.push(task); }, passThroughOnException() {}, props: {} };
      const raw = kind === 'events' ? JSON.stringify(body) : new URLSearchParams({ payload: JSON.stringify(body) }).toString();
      const response = await signed(`/channels/slack/${kind}`, raw, MAIN_APP.signingSecret, withHostedSlackApp(base, MAIN_APP), ctx);
      await Promise.all(detached);
      return response;
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

/** Slack's event for a member joining a Channel: by default the Agent app's own bot, added to #C2 by the Owner. */
function joinEvent(event: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    type: 'event_callback', event_id: `EvJoin${now}`, event_time: now, team_id: TEAM, api_app_id: AGENT_APP,
    authorizations: [{ team_id: TEAM, user_id: AGENT_BOT_USER, is_bot: true, is_enterprise_install: false }],
    event: { type: 'member_joined_channel', user: AGENT_BOT_USER, channel: 'C2', channel_type: 'C', team: TEAM, inviter: 'U1', ...event },
  };
}

/** One person's Channel message as each bot hears it: Chickpea's app as a message, the Agent app's bot as its mention. */
function channelMessage(ts: string, text: string) {
  const now = Math.floor(Date.now() / 1_000);
  const heard = (type: 'message' | 'app_mention', appId: string, botUserId: string) => ({
    type: 'event_callback', event_id: `Ev${type}${ts}`, event_time: now, team_id: TEAM, api_app_id: appId,
    authorizations: [{ team_id: TEAM, user_id: botUserId, is_bot: true, is_enterprise_install: false }],
    event: { type, channel: 'C1', channel_type: 'channel', user: 'U1', text, ts, event_ts: ts },
  });
  return { chickpea: heard('message', MAIN_APP.appId, 'UBOT'), app: heard('app_mention', AGENT_APP, AGENT_BOT_USER) };
}

/** The operator lines for deliveries that added no turn. */
function notAdmitted(calls: ReadonlyArray<{ arguments: unknown[] }>): unknown[] {
  return calls.flatMap(({ arguments: [line] }) => (line as { event?: unknown } | undefined)?.event === 'chickpea.turn.not_admitted' ? [line] : []);
}

/** The first undelivered turn that matches, once detached admission has written it. */
async function pendingTurn(stores: AppStores, matches: (job: PendingTurnJob) => boolean): Promise<PendingTurnJob | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = (await stores.slackState.listPendingTurns!()).find(matches);
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
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
  assert.equal((await pendingTurn(h.stores, () => true))?.assignment.agentId, 'agent_support', "a message to the Agent's bot is the Agent's turn");
  assert.ok(info.every((call) => call.token === AGENT_BOT), "admission runs as the Agent's own bot");
  assert.equal(h.calls.some((call) => call.token === MAIN_BOT), false, 'the workspace bot is never used for an Agent app delivery');
}));

test("an interaction is served the same way and runs with the Agent's client", async (t) => withHarness(t, async (h) => {
  const surfaceId = uiSurfaceId('msg:D1:1900000000.000050', 'host-approval:1');
  const click = {
    type: 'block_actions', api_app_id: AGENT_APP, team: { id: TEAM }, user: { id: 'U1' }, trigger_id: 'trigger-1',
    container: { type: 'message', channel_id: 'D1', message_ts: '1900000000.000050', is_ephemeral: false },
    channel: { id: 'D1' }, message: { ts: '1900000000.000050', thread_ts: '1900000000.000050' },
    actions: [{ type: 'button', action_id: uiActionId('host', 'approval', 0), block_id: uiBlockId('host', surfaceId, 1), value: uiValue(surfaceId, 0), action_ts: '1900000000.000060' }],
  };
  assert.equal((await h.deliver('interactions', click, { env: h.base })).status, 404, 'no handoff');
  assert.equal((await h.deliver('interactions', click, { secret: MAIN_APP.signingSecret })).status, 401);
  assert.equal((await h.deliver('interactions', { ...click, api_app_id: MAIN_APP.appId })).status, 404, 'another app');
  assert.equal((await h.deliver('interactions', { ...click, team: { id: 'TOTHER' } })).status, 404, 'another workspace');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.deliver('interactions', click)).status, 200);
  for (let attempt = 0; attempt < 100 && !h.calls.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.calls.map((call) => call.method), ['chat.postEphemeral'], 'a click on a closed card is told so privately');
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

test('ingress facts for an app whose secrets cannot be opened are none, and logged; a store outage still throws', async (t) => withHarness(t, async (h) => {
  // The store's facade forwards a patch to its logic object; deleting it restores the method.
  const settings = getSettingsStore(h.base) as unknown as Record<string, unknown>;
  settings.getEncryptedCredentialRevision = async () => { throw new Error('realm unreachable'); };
  await assert.rejects(() => agentSlackAppIngress(h.base, AGENT_APP), /realm unreachable/, 'an outage is retried by the host');
  delete settings.getEncryptedCredentialRevision;

  const stored = await readAppSecrets(h.secrets(), AGENT_APP);
  assert.ok(stored);
  await writeAppSecrets({ ...h.secrets(), keyring: generateCredentialKeyring('key_lost') }, AGENT_APP, 'agent_support', stored.secrets, stored.revision);
  const warn = t.mock.method(console, 'warn', () => undefined);
  assert.equal(await agentSlackAppIngress(h.base, AGENT_APP), undefined, 'the host acknowledges instead of asking Slack to retry forever');
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes(AGENT_APP)), 'the unreadable app is logged by ID');
  assert.equal(warn.mock.calls.some((call) => JSON.stringify(call.arguments).includes(AGENT_SECRET)), false);
}));

test("a revoked installation serves none of its Agent apps' deliveries and offers no ingress facts", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  assert.ok(h.calls.some((call) => call.token === AGENT_BOT), 'live before the revocation');
  h.calls.length = 0;
  await markSlackInstallationEnded(h.stores.config, TEAM, 'app_uninstalled');
  assert.equal((await h.deliver('events', dmEvent())).status, 404);
  assert.equal((await h.deliver('interactions', {
    type: 'block_actions', api_app_id: AGENT_APP, team: { id: TEAM }, user: { id: 'U1' }, trigger_id: 't', channel: { id: 'D1' },
    message: { ts: '1.1' }, actions: [{ type: 'button', action_id: 'x', block_id: 'y', value: 'z', action_ts: '1.2' }],
  })).status, 404);
  assert.equal(h.calls.length, 0, 'nothing runs as the Agent bot once the installation is gone');
  assert.equal(await agentSlackAppIngress(h.base, AGENT_APP), undefined);
}));

test("a click on the app Agent's approval card reaches that Agent, as the thread's owner or its guest, and runs as its bot", async (t) => withHarness(t, async (h) => {
  const owner = await h.stores.identity.resolveSlackIdentity(TEAM, 'U1');
  assert.ok(owner);
  const clickSupportCard = async (threadTs: string, threadOwner: string, actionTs: string) => {
    await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'C1', threadTs, agentId: threadOwner, agentGeneration: 1 });
    const scope = `slack:${TEAM}:C1:${threadTs}:agent:agent_support`;
    const proposalId = `proposal_${threadOwner}`;
    await h.stores.management.putChangeSetProposal({
      proposalId, organizationId: owner.membership.organizationId,
      actorUserId: owner.user.id, actorMembershipId: owner.membership.id,
      originKey: scope, approvalScopeKey: scope, idempotencyKey: proposalId,
      guideVersion: 'test', authoringReason: 'agent_edit', digest: 'd'.repeat(64),
      operations: [{ itemId: 'memory', kind: 'update_agent_memory', agentId: 'agent_support', expectedRevision: 0, body: 'Refunds go to account 99.' }],
      preview: { summary: 'Preview', changes: [], missingSetup: [] },
      targetRevisions: { 'memory:agent_support': 0 }, at: Date.now(),
    });
    const cardTs = `${threadTs.split('.')[0]}.000300`;
    const surfaceId = uiSurfaceId(`msg:C1:${threadTs}`, 'host-approval:1');
    const now = Date.now();
    await h.stores.slackState.executeUiSurface!({
      kind: 'put_surface',
      record: {
        id: surfaceId, namespace: 'host', workspaceId: TEAM, channelId: 'C1', threadTs, conversationThreadTs: threadTs,
        conversationKind: 'channel', agentId: 'agent_support', turnJobId: `msg:C1:${threadTs}`, requesterUserId: 'U1',
        spec: { kind: 'approval', approval: 'workspace_change', proposalId },
        status: 'open', messageTs: cardTs, createdAt: now, updatedAt: now, expiresAt: now + 60_000,
      },
    });
    h.calls.length = 0;
    const clicked = await h.deliver('interactions', {
      type: 'block_actions', api_app_id: AGENT_APP, team: { id: TEAM }, user: { id: 'U1' }, trigger_id: 'trigger-1',
      container: { type: 'message', channel_id: 'C1', message_ts: cardTs, is_ephemeral: false },
      channel: { id: 'C1' }, message: { ts: cardTs, thread_ts: threadTs },
      actions: [{ type: 'button', action_id: uiActionId('host', 'approval', 0), block_id: uiBlockId('host', surfaceId, 1), value: uiValue(surfaceId, 0), action_ts: actionTs }],
    });
    assert.equal(clicked.status, 200);
    const job = await pendingTurn(h.stores, (pending) => pending.turn.threadTs === threadTs);
    assert.ok(job, 'the click became a turn');
    assert.equal(job.assignment.agentId, 'agent_support', 'the Agent whose card it is answers the click');
    assert.equal(job.turn.managementApprovalProposalId, proposalId, "the person's click is the approval");
    assert.ok(h.calls.length > 0);
    assert.ok(h.calls.every((call) => call.token === AGENT_BOT), "the click is handled with the Agent's own bot");
    return job;
  };

  const own = await clickSupportCard('1900000000.000050', 'agent_support', '1900000000.000060');
  assert.notEqual(own.assignment.threadGuest, true, "in its own thread the Agent answers as the thread's Agent");

  const guest = await clickSupportCard('1900000100.000050', 'agent_finance', '1900000100.000060');
  assert.equal(guest.assignment.threadGuest, true, "in another Agent's thread it answers as a guest");
  assert.equal(
    (await h.stores.config.getAgentThreadRoute(TEAM, 'C1', '1900000100.000050'))?.agentId,
    'agent_finance',
    'the click never takes the thread over',
  );
}));

test('a Channel message naming the app Agent and a user-group Agent is answered once by each, first-named first, whichever bot hears it first', async (t) => withHarness(t, async (h) => {
  const supportFirst = `<@${AGENT_BOT_USER}> and <!subteam^SFINANCE|@finance> compare our refund numbers`;
  const financeFirst = `<!subteam^SFINANCE|@finance> and <@${AGENT_BOT_USER}> compare our refund numbers`;
  const cases = [
    { ts: '1900000200.000100', text: supportFirst, named: ['agent_support', 'agent_finance'], heardFirst: 'chickpea' },
    { ts: '1900000300.000100', text: supportFirst, named: ['agent_support', 'agent_finance'], heardFirst: 'app' },
    { ts: '1900000400.000100', text: financeFirst, named: ['agent_finance', 'agent_support'], heardFirst: 'chickpea' },
    { ts: '1900000500.000100', text: financeFirst, named: ['agent_finance', 'agent_support'], heardFirst: 'app' },
  ] as const;
  const info = t.mock.method(console, 'info', () => undefined);
  for (const { ts, text, named, heardFirst } of cases) {
    const label = `${named[0]} named first, ${heardFirst === 'app' ? "the app's bot" : 'Chickpea'} heard first`;
    const message = channelMessage(ts, text);
    info.mock.resetCalls();
    for (const ingress of heardFirst === 'app' ? ['app', 'chickpea'] : ['chickpea', 'app']) {
      const response = ingress === 'app' ? await h.deliver('events', message.app) : await h.deliverToChickpea(message.chickpea);
      assert.equal(response.status, 200);
    }
    const turns = (await h.stores.slackState.listPendingTurns!()).filter((job) => job.turn.messageTs === ts);
    assert.deepEqual(
      turns.map((job) => [job.assignment.agentId, job.assignment.threadGuest === true, job.turn.coAddressed?.position]),
      [[named[0], false, 0], [named[1], true, 1]],
      `${label}: each Agent answers once, the first one named first and the other after it as its guest`,
    );
    assert.equal((await h.stores.config.getAgentThreadRoute(TEAM, 'C1', ts))?.agentId, named[0], `${label}: the first one named keeps the thread`);
    assert.deepEqual(
      notAdmitted(info.mock.calls),
      [{ event: 'chickpea.turn.not_admitted', reason: 'already_admitted', agentId: named[0], delivery: heardFirst === 'app' ? 'installation' : 'agent_app' }],
      `${label}: the later delivery adds no turn, and says so in the operator log`,
    );
  }
}));

test("without the port a Channel message naming the app Agent's bot and a user-group Agent is the user-group Agent's alone, as before", async (t) => withHarness(t, async (h) => {
  configureAgentSlackApps(undefined);
  for (const [ts, text] of [
    ['1900000700.000100', `<@${AGENT_BOT_USER}> and <!subteam^SFINANCE|@finance> compare our refund numbers`],
    ['1900000800.000100', `<!subteam^SFINANCE|@finance> and <@${AGENT_BOT_USER}> compare our refund numbers`],
  ] as const) {
    assert.equal((await h.deliverToChickpea(channelMessage(ts, text).chickpea)).status, 200);
    const turns = (await h.stores.slackState.listPendingTurns!()).filter((job) => job.turn.messageTs === ts);
    assert.deepEqual(
      turns.map((job) => [job.assignment.agentId, job.assignment.threadGuest === true, job.turn.coAddressed]),
      [['agent_finance', false, undefined]],
      "no app is served, so its bot addresses nobody and no turn of the app Agent would post as Chickpea's bot",
    );
  }
}));

/** The private notes a Channel message got, as [the bot that posted it, its text, whether it has a button]. */
function channelNotes(h: Harness): Array<[string | undefined, string | null, boolean]> {
  return h.calls.filter((call) => call.method === 'chat.postEphemeral' && call.body.get('channel') === 'C1')
    .map((call) => [call.token, call.body.get('text'), call.body.get('blocks')?.includes('"button"') === true]);
}

/** Both orders of naming the app Agent's bot and Finance's user group. */
const MIXED_TEXTS = [
  `<!subteam^SFINANCE|@finance> and <@${AGENT_BOT_USER}> compare our refund numbers`,
  `<@${AGENT_BOT_USER}> and <!subteam^SFINANCE|@finance> compare our refund numbers`,
];

test("a mixed message where Chickpea's bot is not in the Channel tells the person Finance is not there, and nobody answers", async (t) => withHarness(t, async (h) => {
  for (const [index, text] of MIXED_TEXTS.entries()) {
    const ts = `1900000900.00010${index}`;
    h.calls.length = 0;
    // Only the app's bot is in the Channel, so only it hears the message.
    assert.equal((await h.deliver('events', channelMessage(ts, text).app)).status, 200);
    assert.deepEqual((await h.stores.slackState.listPendingTurns!()).filter((job) => job.turn.messageTs === ts), [],
      "no turn is admitted for an Agent whose reply Chickpea's bot could never post here");
    assert.deepEqual(channelNotes(h), [[AGENT_BOT, '@finance isn’t in <#C1> yet.', false]],
      "the person hears it once, from the bot that heard them, with no Add button that would leave Chickpea's bot out");
  }

  await h.stores.config.deleteAgentChannelGrant(TEAM, 'C1', 'agent_finance');
  h.calls.length = 0;
  assert.equal((await h.deliver('events', channelMessage('1900000900.000200', MIXED_TEXTS[0]!).app)).status, 200);
  assert.deepEqual(channelNotes(h), [[AGENT_BOT, '@finance isn’t in <#C1> yet.', false]],
    "without its grant either, an Add that granted it would still leave Chickpea's bot out, so there is no button");
}, { notMemberOf: { [MAIN_BOT]: ['C1'] } }));

test("a mixed message where the app Agent's bot is not in the Channel tells the person Support is not there, and nobody answers", async (t) => withHarness(t, async (h) => {
  for (const [index, text] of MIXED_TEXTS.entries()) {
    const ts = `1900001000.00010${index}`;
    h.calls.length = 0;
    // Only Chickpea's bot is in the Channel, so only it hears the message.
    assert.equal((await h.deliverToChickpea(channelMessage(ts, text).chickpea)).status, 200);
    assert.deepEqual((await h.stores.slackState.listPendingTurns!()).filter((job) => job.turn.messageTs === ts), [],
      "no turn is admitted for an Agent whose reply its own bot could never post here");
    assert.deepEqual(channelNotes(h), [[MAIN_BOT, '@support isn’t in <#C1> yet.', false]],
      "the person hears it once, from the bot that heard them, with no Add button: only Slack's Add brings an app's bot in");
  }
}, { notMemberOf: { [AGENT_BOT]: ['C1'] } }));

test('a later delivery of a message the fallback lane admitted adds no turn and is logged too', async (t) => withHarness(t, async (h) => {
  const state = h.stores.slackState;
  const admitCanonical = state.admitCanonical.bind(state);
  state.admitCanonical = async (input) => {
    if (!input.msgKey.includes(':ask-')) throw new Error('canonical admission unavailable');
    return await admitCanonical(input);
  };
  t.mock.method(console, 'error', () => undefined);
  const info = t.mock.method(console, 'info', () => undefined);
  const ts = '1900000600.000100';
  const message = channelMessage(ts, `<@${AGENT_BOT_USER}> and <!subteam^SFINANCE|@finance> compare our refund numbers`);
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  assert.equal((await h.deliver('events', message.app)).status, 200);

  const turns = (await state.listPendingTurns!()).filter((job) => job.turn.messageTs === ts);
  assert.deepEqual(turns.map((job) => job.assignment.agentId), ['agent_support', 'agent_finance'], 'each Agent answers once');
  assert.deepEqual(notAdmitted(info.mock.calls), [
    { event: 'chickpea.turn.not_admitted', reason: 'already_admitted', agentId: 'agent_support', delivery: 'agent_app' },
  ]);
}));

/** Each queued turn on one message, as [its Agent, its place among the Agents the message named]. */
async function queuedFor(h: Harness, ts: string): Promise<Array<[string, number | undefined]>> {
  return (await h.stores.slackState.listPendingTurns!())
    .filter((job) => job.turn.messageTs === ts)
    .map((job) => [job.assignment.agentId, job.turn.coAddressed?.position]);
}

/**
 * The first delivery stops once the first Agent's turn is queued, before any
 * other Agent's is admitted, as when its isolate ends. On the fallback lane
 * the first turn is claimed and queued outside canonical admission.
 */
async function stopAfterFirstTurn(t: TestContext, h: Harness, lane: 'canonical' | 'fallback'): Promise<void> {
  const state = h.stores.slackState;
  const admitCanonical = state.admitCanonical.bind(state);
  if (lane === 'fallback') t.mock.method(console, 'error', () => undefined);
  let resume: (() => void) | undefined;
  const stopped = new Promise<void>((reached) => {
    state.admitCanonical = async (input) => {
      if (lane === 'fallback' && !input.msgKey.includes(':ask-')) throw new Error('canonical admission unavailable');
      if (!resume && input.msgKey.includes(':ask-')) {
        reached();
        await new Promise<void>((resolve) => { resume = resolve; });
      }
      return await admitCanonical(input);
    };
  });
  t.mock.method(console, 'info', () => undefined);
  const ts = lane === 'canonical' ? '1900001100.000100' : '1900001100.000200';
  const message = channelMessage(ts, `<@${AGENT_BOT_USER}> and <!subteam^SFINANCE|@finance> compare our refund numbers`);
  const first = h.deliver('events', message.app);
  await stopped;
  assert.deepEqual(await queuedFor(h, ts), [['agent_support', 0]], "Support's turn is queued, and Finance's never was");

  assert.equal((await h.deliver('events', message.app)).status, 200);
  assert.deepEqual(await queuedFor(h, ts), [['agent_support', 0], ['agent_finance', 1]], "Slack's retry admits Finance's turn, after Support's");

  assert.equal((await h.deliver('events', message.app)).status, 200);
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  resume!();
  assert.equal((await first).status, 200);
  assert.deepEqual(await queuedFor(h, ts), [['agent_support', 0], ['agent_finance', 1]],
    "another retry, Chickpea's delivery, and the stopped delivery finishing late add nothing");
}

test("a delivery that stopped after admitting the first Agent's turn has the other Agent's turn admitted by a later delivery, once", async (t) => withHarness(t, async (h) => {
  await stopAfterFirstTurn(t, h, 'canonical');
}));

test("on the fallback lane too, a later delivery admits the other Agent's turn the stopped delivery never reached, once", async (t) => withHarness(t, async (h) => {
  await stopAfterFirstTurn(t, h, 'fallback');
}));

test("Slack's retries of a message every Agent it named answered admit nothing again; a message whose claims were taken with nothing queued admits nobody", async (t) => withHarness(t, async (h) => {
  const state = h.stores.slackState;
  const admitCanonical = state.admitCanonical.bind(state);
  const asks: string[] = [];
  state.admitCanonical = async (input) => {
    if (input.msgKey.includes(':ask-')) asks.push(input.msgKey);
    return await admitCanonical(input);
  };
  const text = `<@${AGENT_BOT_USER}> and <!subteam^SFINANCE|@finance> compare our refund numbers`;
  const ts = '1900001200.000100';
  const message = channelMessage(ts, text);
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  assert.equal((await h.deliver('events', message.app)).status, 200);
  assert.deepEqual(asks, [`msg:C1:${ts}:ask-agent_finance`], "Finance's turn is admitted by the first delivery only");
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  assert.equal((await h.deliver('events', message.app)).status, 200);
  assert.deepEqual(await queuedFor(h, ts), [['agent_support', 0], ['agent_finance', 1]]);
  assert.equal(asks.length, 1, "a retry does not admit a queued guest's turn again");

  // A stop, or a message refused before it was queued, holds its claims with no turn.
  const refused = '1900001300.000100';
  await state.claim(`evt:Evmessage${refused}`);
  await state.claim(`msg:C1:${refused}`);
  assert.equal((await h.deliverToChickpea(channelMessage(refused, text).chickpea)).status, 200);
  assert.deepEqual(await queuedFor(h, refused), [], 'no guest answers a message its first Agent never took');
}));

test("the Agent's own reply, echoed back by Slack, stays its Agent's row in the thread record", async (t) => withHarness(t, async (h) => {
  const root = '1900000000.000100';
  const reply = '1900000000.000200';
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'D1', threadTs: root, agentId: 'agent_support', agentGeneration: 1 });
  await recordDeliveredSlackAgentMessage(
    h.stores.config,
    { workspaceId: TEAM, channelId: 'D1', threadTs: root } as NormalizedSlackTurn,
    { runtimeContract: 'chickpea-v1', agentId: 'agent_support' },
    { messageTs: reply, text: 'Refunds go to account 99.' },
  );
  const echo = dmEvent({}, {
    user: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: AGENT_APP, bot_profile: { app_id: AGENT_APP, name: 'support' },
    text: 'Refunds go to account 99.', ts: reply, event_ts: reply, thread_ts: root,
  });
  assert.equal((await h.deliver('events', echo)).status, 200);
  const rows = await h.stores.config.listSlackPublicContext(TEAM, 'D1', root);
  assert.deepEqual(rows.map((row) => [row.messageTs, row.role, row.agentId ?? null]), [[reply, 'agent', 'agent_support']],
    "the Agent's own post is not recorded again as another app's");
}));

/** One event as Chickpea's own app receives it. */
function chickpeaEvent(eventId: string, event: Record<string, unknown>) {
  return {
    type: 'event_callback', event_id: eventId, event_time: Math.floor(Date.now() / 1_000), team_id: TEAM, api_app_id: MAIN_APP.appId,
    authorizations: [{ team_id: TEAM, user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
    event: { channel: 'C1', channel_type: 'channel', ...event },
  };
}

async function setSupportApp(h: Harness, app: AgentAppLifecycle): Promise<void> {
  const support = await h.stores.config.getAgent('agent_support');
  assert.equal(support.slackPresence?.kind, 'agent_app');
  if (support.slackPresence?.kind !== 'agent_app') return;
  await h.stores.config.updateAgent(support.id, { slackPresence: { ...support.slackPresence, app } }, support.revision);
}

const UNINSTALLING: AgentAppLifecycle = {
  state: 'uninstalling', at: Date.now(), startedBy: 'U1', app: { appId: AGENT_APP, clientId: '1.client' }, botUserId: AGENT_BOT_USER, next: 'uninstall',
};

/** A second Agent with its own live app; only its record matters here. */
async function addBilling(h: Harness): Promise<void> {
  const billing = await h.stores.config.createAgent(userAgent('agent_billing', 'Billing', 'billing'));
  await h.stores.config.updateAgent(billing.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'billing', normalizedHandle: 'billing', desiredState: 'active', health: 'healthy',
      avatar: billing.slackPresence!.avatar, released: { userGroupId: 'SBILLING' },
      app: {
        state: 'active', at: h.installedAt, app: { appId: 'A0BILLING', clientId: '2.client' }, icon: 'agent_avatar',
        botUserId: 'UBILLBOT', installedAt: h.installedAt, installedBy: 'U1',
      },
    },
  }, billing.revision);
}

test("an Agent's reply Slack echoes after its app began uninstalling stays its Agent's row in the thread record", async (t) => withHarness(t, async (h) => {
  const root = '1900001400.000100';
  const reply = '1900001400.000200';
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'C1', threadTs: root, agentId: 'agent_support', agentGeneration: 1 });
  await recordDeliveredSlackAgentMessage(
    h.stores.config,
    { workspaceId: TEAM, channelId: 'C1', threadTs: root } as NormalizedSlackTurn,
    { runtimeContract: 'chickpea-v1', agentId: 'agent_support' },
    { messageTs: reply, text: 'Refunds go to account 99.' },
  );
  await setSupportApp(h, UNINSTALLING);
  assert.equal((await h.deliverToChickpea(chickpeaEvent('EvLateEcho', {
    type: 'message', user: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: AGENT_APP, bot_profile: { app_id: AGENT_APP, name: 'support' },
    text: 'Refunds go to account 99.', ts: reply, event_ts: reply, thread_ts: root,
  }))).status, 200);
  const rows = await h.stores.config.listSlackPublicContext(TEAM, 'C1', root);
  assert.deepEqual(rows.map((row) => [row.messageTs, row.role, row.agentId ?? null]), [[reply, 'agent', 'agent_support']],
    "the app's bot is still Support's while the app is being removed");
}));

const HANDOFF_ROOT = '1900001500.000100';
const HANDOFF_TS = '1900001500.000600';

test("a thread an app Agent owns with no record is handed over with its replies as that Agent's", async (t) => withHarness(t, async (h) => {
  await addBilling(h);
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'C1', threadTs: HANDOFF_ROOT, agentId: 'agent_billing', agentGeneration: 1 });
  // A mention of Support's bot reaches its app as app_mention, which nothing records before routing reads the thread record.
  assert.equal((await h.deliver('events', {
    type: 'event_callback', event_id: 'EvTakeOver', event_time: Math.floor(Date.now() / 1_000), team_id: TEAM, api_app_id: AGENT_APP,
    authorizations: [{ team_id: TEAM, user_id: AGENT_BOT_USER, is_bot: true, is_enterprise_install: false }],
    event: {
      type: 'app_mention', channel: 'C1', channel_type: 'channel', user: 'U1', text: `<@${AGENT_BOT_USER}> take over`,
      ts: HANDOFF_TS, event_ts: HANDOFF_TS, thread_ts: HANDOFF_ROOT,
    },
  })).status, 200);
  const route = await h.stores.config.getAgentThreadRoute(TEAM, 'C1', HANDOFF_ROOT);
  assert.equal(route?.agentId, 'agent_support');
  assert.deepEqual(route?.handoff?.context?.map((row) => [row.messageTs, row.role, row.agentId ?? null]), [
    [HANDOFF_ROOT, 'human', null],
    ['1900001500.000200', 'agent', 'agent_billing'],
    ['1900001500.000300', 'agent', 'agent_support'],
    ['1900001500.000400', 'agent', 'agent_billing'],
    ['1900001500.000500', 'app', null],
  ], "each app's replies are its Agent's; Chickpea's bot's are the previous owner's, as before; another app stays an app");
}, {
  replies: [
    { user: 'U1', text: 'Can someone check the refund numbers?', ts: HANDOFF_ROOT },
    { user: 'UBILLBOT', bot_id: 'BBILL', app_id: 'A0BILLING', bot_profile: { app_id: 'A0BILLING', name: 'billing' }, text: 'Refunds go to account 99.', ts: '1900001500.000200', thread_ts: HANDOFF_ROOT },
    { user: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: AGENT_APP, bot_profile: { app_id: AGENT_APP, name: 'support' }, text: 'Support agrees.', ts: '1900001500.000300', thread_ts: HANDOFF_ROOT },
    { user: 'UBOT', bot_id: 'BCHICKPEA', username: 'Billing', text: 'Earlier, before Billing had its app.', ts: '1900001500.000400', thread_ts: HANDOFF_ROOT },
    { bot_id: 'B_PD', username: 'PagerDuty', text: 'checkout is down', ts: '1900001500.000500', thread_ts: HANDOFF_ROOT },
    { user: 'U1', text: `<@${AGENT_BOT_USER}> take over`, ts: HANDOFF_TS, thread_ts: HANDOFF_ROOT },
  ],
}));

/** Posts in #C2: Support's own app, Chickpea's bot as Finance, another app, and a person. */
const C2_POSTS = [
  { user: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: AGENT_APP, bot_profile: { app_id: AGENT_APP, name: 'support' }, text: 'Refunds go to account 99.', ts: '1900001600.000100' },
  { user: 'UBOT', bot_id: 'BCHICKPEA', username: 'Finance', text: 'The books are closed.', ts: '1900001600.000200' },
  { bot_id: 'B_PD', username: 'PagerDuty', text: 'checkout is down', ts: '1900001600.000300' },
  { user: 'U2', text: 'Thanks, all.', ts: '1900001600.000400' },
];

/** One read of #C2 by an Agent answering the Owner in #C1: its result, or its refusal, and the bot tokens its Slack reads used. */
async function readC2(h: Harness, agentId: string): Promise<{
  authors?: Array<[string, string | null]>; refused?: SlackReadError; tokens: Array<string | undefined>;
}> {
  await h.stores.config.putChannel({ workspaceId: TEAM, channelId: 'C2', label: 'refunds', lifecycle: 'active' }, 0).catch(() => undefined);
  if (!(await h.stores.config.listAgentChannelGrants(TEAM, 'C2')).some((grant) => grant.agentId === agentId)) {
    await h.stores.config.putAgentChannelGrant({
      workspaceId: TEAM, channelId: 'C2', agentId, status: 'active',
      createdByMembershipId: h.ownerMembershipId, channelLabel: 'refunds', channelIsPrivate: false,
    }, 0);
  }
  const before = h.calls.length;
  const service = await slackReadingService({ agentId, actorMembershipId: h.ownerMembershipId }, {
    agentId, workspaceId: TEAM, channelId: 'C1', threadTs: '1900001700.000100', conversationKind: 'channel',
    slackUserId: 'U1', eventId: 'EvRead', messageTs: '1900001700.000100', turnJobId: 'job_read',
  }, withHostedSlackApp(h.base, MAIN_APP));
  // Resolving the installation checks Chickpea's bot with auth.test first, whichever bot then reads.
  const tokens = () => [...new Set(h.calls.slice(before).filter((call) => call.method !== 'auth.test').map((call) => call.token))];
  try {
    const result = await service.readChannel({ target: { channelId: 'C2' } }) as { messages: Array<{ author: { kind: string; name?: string } }> };
    return {
      authors: result.messages.map(({ author }) => [author.kind, author.kind === 'person' ? null : author.name ?? null]),
      tokens: tokens(),
    };
  } catch (error) {
    assert.ok(error instanceof SlackReadError);
    return { refused: error, tokens: tokens() };
  }
}

test("an Agent with a live app reads Slack as its own bot, so a Channel Chickpea's bot isn't in is readable, and its own posts read as an Agent's", async (t) => withHarness(t, async (h) => {
  const support = await readC2(h, 'agent_support');
  assert.deepEqual(support.tokens, [AGENT_BOT], "every read is the Agent's own bot's");
  assert.deepEqual(support.authors, [['agent', 'support'], ['agent', 'Finance'], ['app', 'PagerDuty'], ['person', null]],
    "its own post and Chickpea's bot's are Agents'; another app is an app");
  assert.equal((await readC2(h, 'agent_support')).authors?.length, 4, "its app's own reads are not held to the shared app's pace");

  const finance = await readC2(h, 'agent_finance');
  assert.deepEqual(finance.tokens, [MAIN_BOT], "a user-group Agent reads as Chickpea's bot, as before");
  assert.equal(finance.refused?.code, 'needs_bot_invite');
  assert.equal(finance.refused?.message, SLACK_READ_MESSAGES.needs_bot_invite, "Chickpea's bot is missing there, and says so as before");
}, { notMemberOf: { [MAIN_BOT]: ['C2'] }, history: C2_POSTS }));

test("an app Agent whose own bot isn't in a Channel is told its own app is missing there, not Chickpea's", async (t) => withHarness(t, async (h) => {
  const { refused, tokens } = await readC2(h, 'agent_support');
  assert.deepEqual(tokens, [AGENT_BOT]);
  assert.equal(refused?.code, 'needs_bot_invite');
  assert.equal(refused?.message, "This Agent's own Slack app is not in that channel yet. Someone in the channel can add it from the channel's Add people or agents.");
}, { notMemberOf: { [AGENT_BOT]: ['C2'] }, history: C2_POSTS }));

test("a read Slack rate-limits on the app Agent's own bot is refused at once, as on Chickpea's bot, rather than waiting it out", async (t) => withHarness(t, async (h) => {
  const started = Date.now();
  const { refused, tokens } = await readC2(h, 'agent_support');
  assert.deepEqual(tokens, [AGENT_BOT]);
  assert.equal(refused?.code, 'rate_limited');
  assert.ok(Date.now() - started < 1_000, 'the read does not wait for Retry-After');
}, { history: C2_POSTS, rateLimited: [`conversations.history ${AGENT_BOT}`] }));

// Chickpea's shared app reads once a minute per workspace, so each case below reads in a workspace of its own.
test("a user-group Agent reads as Chickpea's bot, as before, and reads an app Agent's posts as an Agent's", async (t) => withHarness(t, async (h) => {
  const finance = await readC2(h, 'agent_finance');
  assert.deepEqual(finance.tokens, [MAIN_BOT]);
  assert.deepEqual(finance.authors, [['agent', 'support'], ['agent', 'Finance'], ['app', 'PagerDuty'], ['person', null]]);
}, { history: C2_POSTS }));

test("an Agent whose app is being removed reads as Chickpea's bot", async (t) => withHarness(t, async (h) => {
  await setSupportApp(h, UNINSTALLING);
  const removing = await readC2(h, 'agent_support');
  assert.deepEqual(removing.tokens, [MAIN_BOT]);
  assert.deepEqual(removing.authors, [['agent', 'support'], ['agent', 'Finance'], ['app', 'PagerDuty'], ['person', null]]);
}, { history: C2_POSTS }));

test("without the port an app Agent reads as Chickpea's bot, and its app's posts are an app's, as before", async (t) => withHarness(t, async (h) => {
  configureAgentSlackApps(undefined);
  const unserved = await readC2(h, 'agent_support');
  assert.deepEqual(unserved.tokens, [MAIN_BOT], 'no app is served');
  assert.deepEqual(unserved.authors, [['app', 'support'], ['agent', 'Finance'], ['app', 'PagerDuty'], ['person', null]]);
}, { history: C2_POSTS }));

async function hostedBotIsLost(h: Harness): Promise<void> {
  await assert.rejects(resolveSlackInstallationCredentials(slackInstallationCredentialId(h.base), h.base), SlackCredentialRecoveryOnlyError);
  h.calls.length = 0;
}

test("a tenant's end retires an Agent app with its own credentials when the hosted bot's cannot be read", async (t) => withHarness(t, async (h) => {
  const rotated = { accessToken: 'xoxe.xoxp-1-config-access', refreshToken: 'xoxe-1-config-refresh', teamId: TEAM, expiresAt: Date.now() + 12 * 3_600_000 };
  assert.equal(await saveConfigurationToken({ ...h.secrets(), slack: { rotate: async () => rotated } }, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  await hostedBotIsLost(h);

  assert.deepEqual(await retireAgentSlackApps(h.base), [{ agentId: 'agent_support', outcome: 'removed' }]);
  assert.deepEqual(h.calls.map(({ method, token }) => [method, token]), [
    ['apps.uninstall', AGENT_BOT],
    ['apps.manifest.delete', rotated.accessToken],
  ], "the app's own bot and the configuration token are all it takes");
  assert.equal((await h.stores.config.getAgent('agent_support')).slackPresence?.kind, undefined, 'the handle is back with its user group');
  assert.equal(await readAppSecrets(h.secrets(), AGENT_APP), undefined);
}, { lostHostedBot: true }));

test("a tenant's end that cannot tell the Owner about a left app still uninstalls it and names it for the Owner", async (t) => withHarness(t, async (h) => {
  await hostedBotIsLost(h);

  assert.deepEqual(await retireAgentSlackApps(h.base), [{ agentId: 'agent_support', outcome: 'left_for_owner' }]);
  assert.deepEqual(h.calls.map(({ method, token }) => [method, token]), [['apps.uninstall', AGENT_BOT]],
    'the app is uninstalled with its own bot; without a configuration token its definition stays, and the Owner cannot be messaged');
}, { lostHostedBot: true }));

const SUPPORT_READY = '@support is ready in this channel. Mention @support to start a conversation.';
const SUPPORT_WELCOME = 'Hi, I’m *Support*.\n\nMention <@UAGENTBOT> to start a thread with me. I only join conversations that mention me';
const SUPPORT_WELCOME_IN_THREADS = `${SUPPORT_WELCOME}, and once I’m in a thread you can keep going there without the mention.`;

function slackPosts(h: Harness, method: 'chat.postMessage' | 'chat.postEphemeral'): URLSearchParams[] {
  return h.calls.filter((call) => call.method === method).map((call) => call.body);
}

test("an Owner's Slack Add of the Agent's bot adds the Agent to that Channel, and it greets the Channel as its own bot", async (t) => withHarness(t, async (h) => {
  const owner = await h.stores.identity.resolveSlackIdentity(TEAM, 'U1');
  assert.equal((await h.deliver('events', joinEvent())).status, 200);

  const grants = await h.stores.config.listAgentChannelGrants(TEAM, 'C2');
  assert.deepEqual(grants.map(({ agentId, status }) => [agentId, status]), [['agent_support', 'active']],
    "the app's Agent, and only it, is added");
  assert.equal(grants[0]?.createdByMembershipId, owner?.membership.id, 'added on behalf of the person who added the bot');
  const [welcome] = slackPosts(h, 'chat.postMessage');
  assert.equal(welcome?.get('channel'), 'C2');
  assert.equal(welcome?.get('text'), SUPPORT_WELCOME_IN_THREADS,
    "Chickpea's bot is in the Channel, so a thread's unmentioned replies reach the Agent");
  assert.equal(welcome?.get('username'), null, 'no persona: the app posts as itself');
  assert.equal(welcome?.get('icon_url'), null);
  assert.deepEqual(slackPosts(h, 'chat.postEphemeral').map((body) => [body.get('user'), body.get('text')]), [['U1', SUPPORT_READY]],
    'the Owner is told as after the Add button');
  assert.ok(h.calls.filter((call) => call.method.startsWith('chat.')).every((call) => call.token === AGENT_BOT),
    "Slack's Add is answered as the Agent's own bot");
  assert.deepEqual(h.calls.filter((call) => call.token !== AGENT_BOT).map((call) => `${call.method} ${call.body.get('channel')}`),
    ['conversations.info C2'], "Chickpea's bot only says whether it is in the Channel");
}));

test("an app Agent's welcome promises replies without a mention only where Chickpea's bot is in the Channel", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', joinEvent())).status, 200);

  assert.deepEqual(slackPosts(h, 'chat.postMessage').map((body) => [body.get('channel'), body.get('text')]), [['C2', `${SUPPORT_WELCOME}.`]],
    'the app has no Channel message events, so without Chickpea there a thread follow-up needs the mention');
}, { notMemberOf: { [MAIN_BOT]: ['C2'] } }));

test("a Member's Slack Add adds nothing and tells them who can", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', joinEvent({ inviter: 'U2' }))).status, 200);

  assert.deepEqual(await h.stores.config.listAgentChannelGrants(TEAM, 'C2'), []);
  assert.deepEqual(slackPosts(h, 'chat.postEphemeral').map((body) => [body.get('channel'), body.get('user'), body.get('text')]), [
    ['C2', 'U2', 'Ask a workspace Owner or Admin, such as <@U1>, to add @support to this channel.'],
  ]);
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), [], 'nothing is posted in the Channel');
}));

test('a redelivered Slack Add changes nothing and says nothing again', async (t) => withHarness(t, async (h) => {
  const refused = joinEvent({ channel: 'C3', inviter: 'U2' });
  assert.equal((await h.deliver('events', refused)).status, 200);
  assert.equal((await h.deliver('events', refused)).status, 200);
  assert.equal(slackPosts(h, 'chat.postEphemeral').length, 1, 'a Member is told who can add it once');

  const event = joinEvent();
  assert.equal((await h.deliver('events', event)).status, 200);
  const [granted] = await h.stores.config.listAgentChannelGrants(TEAM, 'C2');
  assert.equal(granted?.status, 'active');
  const answered = h.calls.length;
  assert.equal((await h.deliver('events', event)).status, 200);
  assert.equal(h.calls.length, answered, 'a redelivery makes no Slack call');
  assert.deepEqual(await h.stores.config.listAgentChannelGrants(TEAM, 'C2'), [granted], 'and writes nothing');
}));

test('a Slack Add into a Channel its Agent already has changes nothing and tells nobody to ask', async (t) => withHarness(t, async (h) => {
  const before = await h.stores.config.listAgentChannelGrants(TEAM, 'C1');
  for (const inviter of ['U2', 'U1']) {
    assert.equal((await h.deliver('events', { ...joinEvent({ channel: 'C1', inviter }), event_id: `EvJoinGranted${inviter}` })).status, 200);
  }
  assert.deepEqual(await h.stores.config.listAgentChannelGrants(TEAM, 'C1'), before, 'the grant made before the Agent had its app stands as it was');
  assert.deepEqual(h.calls.filter((call) => call.method.startsWith('chat.')), [], 'nobody is told to ask an Owner, and nothing is posted');
}));

test("only the app's own bot joining, added by a person, adds its Agent; user-group Agents are untouched", async (t) => withHarness(t, async (h) => {
  const before = await h.stores.config.listAgentChannelGrants(TEAM);
  for (const event of [
    joinEvent({ user: 'U3' }),
    joinEvent({ user: 'UBOT' }),
    joinEvent({ inviter: undefined }),
    joinEvent({ inviter: '' }),
  ]) {
    assert.equal((await h.deliver('events', { ...event, event_id: `Ev${JSON.stringify(event.event)}` })).status, 200);
  }
  assert.deepEqual(await h.stores.config.listAgentChannelGrants(TEAM), before,
    "a person or Chickpea joining a Channel the app's bot is in, or the bot joining without an inviter, adds nobody");
  assert.deepEqual(h.calls.filter((call) => call.method.startsWith('chat.')), []);

  assert.equal((await h.deliver('events', joinEvent())).status, 200);
  assert.deepEqual((await h.stores.config.listAgentChannelGrants(TEAM, 'C2')).map(({ agentId }) => agentId), ['agent_support']);
  assert.deepEqual((await h.stores.config.listAgentChannelGrants(TEAM, 'C1')).map(({ agentId }) => agentId).sort(),
    ['agent_finance', 'agent_support'], "Finance's grants are as they were");
}));

test("a DM reaches an app Agent whose earlier grant is in a Channel only Chickpea's bot is in", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const turn = await pendingTurn(h.stores, () => true);
  assert.deepEqual(slackPosts(h, 'chat.postMessage').map((body) => body.get('text')), [], 'nobody is told the Agent is not available');
  assert.equal(turn?.assignment.agentId, 'agent_support', "the DM is the Agent's turn");
  assert.deepEqual(
    [...new Set(h.calls.filter((call) => call.token === MAIN_BOT).map((call) => `${call.method} ${call.body.get('channel')}`))],
    ['conversations.info C1'],
    "Chickpea's bot only reads the Channel the Agent was placed in",
  );
}, { notMemberOf: { [AGENT_BOT]: ['C1'] } }));

test('a DM to an app Agent whose only placement neither bot is in is still refused', async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  for (let attempt = 0; attempt < 100 && !slackPosts(h, 'chat.postMessage').length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const refusals = h.calls.filter((call) => call.method === 'chat.postMessage');
  assert.deepEqual(refusals.map((call) => [call.token, call.body.get('text')]), [[AGENT_BOT, 'That Agent is not available here.']]);
  assert.equal(await pendingTurn(h.stores, () => true), undefined);
}, { notMemberOf: { [AGENT_BOT]: ['C1'], [MAIN_BOT]: ['C1'] } }));

test("Admin's DM audience for an app Agent counts a Channel either bot is in, as its DMs do", async (t) => withHarness(t, async (h) => {
  const owner = (await h.stores.identity.resolveSlackIdentity(TEAM, 'U1'))!;
  const admin = createAdminRoutes({
    store: h.stores.config, settings: h.stores.settings, slackTransport: createDirectSlackTransport(MAIN_BOT, undefined),
    ...testAdminAuthority('admin-token', undefined, h.stores.identity, {
      userId: owner.user.id, membershipId: owner.membership.id, organizationId: owner.membership.organizationId, role: 'owner',
      authenticatorKind: 'test_slack_session', credentialId: 'session_owner', correlationId: 'request_owner', machine: false,
    }),
  });
  const audience = async (agentId: string) => {
    const response = await admin.request(`/admin/api/agents/${agentId}`, { headers: testAdminHeaders('admin-token') }, h.base);
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as { agent: { whereItWorks: { privateUseAudience?: string } } }).agent.whereItWorks.privateUseAudience;
  };
  await h.stores.config.deleteAgentChannelGrant(TEAM, 'C1', 'agent_finance');
  assert.equal(await audience('agent_support'), 'workspace_members', "a grant from before the app, where only Chickpea's bot is");

  await h.stores.config.deleteAgentChannelGrant(TEAM, 'C1', 'agent_support');
  assert.equal((await h.deliver('events', joinEvent())).status, 200);
  await h.stores.config.putAgentChannelGrant({
    workspaceId: TEAM, channelId: 'C2', agentId: 'agent_finance', status: 'active',
    createdByMembershipId: owner.membership.id, channelLabel: 'team', channelIsPrivate: false,
  }, 0);
  assert.equal(await audience('agent_support'), 'workspace_members', "after Slack's Add alone, where only the app's bot is");
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  assert.equal((await pendingTurn(h.stores, () => true))?.assignment.agentId, 'agent_support', 'and a DM to the app gets through');
  assert.equal(await audience('agent_finance'), 'unavailable', "a user-group Agent's Channels are read through Chickpea's bot alone");
  configureAgentSlackApps(undefined);
  assert.equal(await audience('agent_support'), 'unavailable', 'with the switch off, Admin reads as before');
}, { notMemberOf: { [MAIN_BOT]: ['C2'], [AGENT_BOT]: ['C1'] } }));

/** Chickpea Admin as the workspace's Owner, with Chickpea's bot as its Slack transport. */
async function ownerAdmin(h: Harness): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const owner = (await h.stores.identity.resolveSlackIdentity(TEAM, 'U1'))!;
  const admin = createAdminRoutes({
    store: h.stores.config, settings: h.stores.settings, slackTransport: createDirectSlackTransport(MAIN_BOT, undefined),
    ...testAdminAuthority('admin-token', undefined, h.stores.identity, {
      userId: owner.user.id, membershipId: owner.membership.id, organizationId: owner.membership.organizationId, role: 'owner',
      authenticatorKind: 'test_slack_session', credentialId: 'session_owner', correlationId: 'request_owner', machine: false,
    }),
  });
  return async (path, init = {}) => admin.request(`http://localhost${path}`, { ...init, headers: testAdminHeaders('admin-token', { 'content-type': 'application/json' }) }, h.base);
}

async function addInAdmin(h: Harness, agentId: string, channelId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await (await ownerAdmin(h))(`/admin/api/agents/${agentId}/channels`, {
    method: 'POST', body: JSON.stringify({ workspaceId: TEAM, channelId }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** The operator lines for an app bot Chickpea could not bring into a Channel. */
function botsLeftOut(calls: ReadonlyArray<{ arguments: unknown[] }>): unknown[] {
  return calls.flatMap(({ arguments: [line] }) => (line as { event?: unknown } | undefined)?.event === 'chickpea.agent_app.bot_left_out' ? [line] : []);
}

const joins = (h: Harness) => h.calls.filter((call) => call.method === 'conversations.join').map((call) => [call.token, call.body.get('channel')]);

test("Admin's Add to channels brings the app Agent's own bot into a public Channel, and nothing else has a bot to bring", async (t) => withHarness(t, async (h) => {
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, 'in_channel');
  assert.deepEqual(joins(h), [[AGENT_BOT, 'C2']], "the app's bot joins; Chickpea's bot was already there");
  assert.equal((await h.stores.config.listAgentChannelGrants(TEAM, 'C2'))[0]?.status, 'active');

  h.calls.length = 0;
  const hooks = agentAppPresenceHooks(h.base)!;
  assert.equal(await hooks.bringBotIn(await h.stores.config.getAgent('agent_finance'), { id: 'C3', private: false }), undefined);
  assert.deepEqual(h.calls, [], "a user-group Agent has no bot of its own to bring in");
  configureAgentSlackApps(undefined);
  assert.equal(agentAppPresenceHooks(h.base), undefined, 'without the port there is nothing to bring in');
}));

test("Admin's Add to channels welcomes a public Channel once, as the app Agent's own bot, after that bot has joined", async (t) => withHarness(t, async (h) => {
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, 'in_channel');
  assert.deepEqual(joins(h), [[MAIN_BOT, 'C2'], [AGENT_BOT, 'C2']], 'neither bot was in the Channel');
  const welcomes = h.calls.filter((call) => call.method === 'chat.postMessage');
  assert.deepEqual(welcomes.map((call) => [call.token, call.body.get('channel'), call.body.get('text')]), [[AGENT_BOT, 'C2', SUPPORT_WELCOME_IN_THREADS]],
    "the Agent greets as its own bot, and Chickpea's bot, now in the Channel, brings it the thread's unmentioned replies");
  assert.equal(welcomes[0]?.body.get('username'), null, 'no persona: the app posts as itself');
  assert.equal(welcomes[0]?.body.get('icon_url'), null);
  const agentBotCall = (method: string) => h.calls.findIndex((call) => call.method === method && call.token === AGENT_BOT);
  assert.ok(agentBotCall('conversations.join') < agentBotCall('chat.postMessage'), 'the welcome follows the bot into the Channel');

  const admin = await ownerAdmin(h);
  assert.equal((await addInAdmin(h, 'agent_support', 'C2')).status, 201);
  const retried = await admin('/admin/api/agents/agent_support/slack/retry', { method: 'POST', body: JSON.stringify({ workspaceId: TEAM }) });
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await h.deliver('events', { ...joinEvent({ inviter: undefined }), event_id: 'EvSelfJoin' })).status, 200);
  assert.equal((await h.deliver('events', { ...joinEvent(), event_id: 'EvAddedAgain' })).status, 200);
  assert.equal(slackPosts(h, 'chat.postMessage').length, 1,
    "one welcome per grant: adding again, a retry, the bot's own join and a later Slack Add post nothing more");
}, { notMemberOf: { [MAIN_BOT]: ['C2'], [AGENT_BOT]: ['C2'] } }));

test("asking Chickpea to add the app Agent greets the Channel the same way", async (t) => withHarness(t, async (h) => {
  const owner = (await h.stores.identity.resolveSlackIdentity(TEAM, 'U1'))!;
  const adapter = {
    service: createLiveWorkspaceManagementService(h.base),
    resolveContext: async (): Promise<ManagementActorContext> => ({
      userId: owner.user.id, membershipId: owner.membership.id, organizationId: owner.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'x1-admin-welcome' },
    }),
  };
  const applied = await invokeWorkspaceManagementTool(adapter, 'apply_workspace_changes', {
    idempotencyKey: 'add-support-c2',
    operations: [{ itemId: 'reach', kind: 'grant_agent_channel', workspaceId: TEAM, channelId: 'C2', agentId: 'agent_support', expectedRevision: 0 }],
  });
  const proposalId = (applied as { result?: { outcomes?: Array<{ proposalId?: string }> } }).result?.outcomes?.[0]?.proposalId;
  assert.ok(proposalId, JSON.stringify(applied));
  const confirmed = await invokeWorkspaceManagementTool(adapter, 'confirm_workspace_change', { proposalId });
  assert.equal((confirmed as { result?: { status?: string } }).result?.status, 'completed', JSON.stringify(confirmed));
  assert.deepEqual(h.calls.filter((call) => call.method === 'chat.postMessage').map((call) => [call.token, call.body.get('channel'), call.body.get('text')]),
    [[AGENT_BOT, 'C2', SUPPORT_WELCOME_IN_THREADS]]);
}, { notMemberOf: { [MAIN_BOT]: ['C2'], [AGENT_BOT]: ['C2'] } }));

test("with the switch off, Admin's Add of an app Agent greets nobody, as before", async (t) => withHarness(t, async (h) => {
  configureAgentSlackApps(undefined);
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, undefined);
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), [], 'nothing brings the app bot in, so nothing posts as it');
}));

test("when Admin's Add cannot bring the app's bot into a private Channel, its result says so and the reason is logged", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const added = await addInAdmin(h, 'agent_support', 'C3');
  assert.equal(added.status, 201, 'the Agent is still added');
  assert.equal(added.body.appBot, 'left_out');
  assert.equal((await h.stores.config.listAgentChannelGrants(TEAM, 'C3'))[0]?.status, 'active');
  assert.deepEqual(joins(h), [], 'a bot cannot join a private Channel');
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), [], 'nobody is welcomed');
  assert.deepEqual(botsLeftOut(warn.mock.calls), [{
    event: 'chickpea.agent_app.bot_left_out', agentId: 'agent_support', appId: AGENT_APP, channelId: 'C3', reason: 'private_channel',
  }]);
  assert.doesNotMatch(JSON.stringify(warn.mock.calls.map((call) => call.arguments)), /xoxb-/, 'no token in the log');

  const alreadyIn = await addInAdmin(h, 'agent_support', 'C4');
  assert.equal(alreadyIn.body.appBot, 'in_channel', 'a private Channel someone already added the bot to');
  assert.deepEqual(joins(h), []);
  assert.equal(botsLeftOut(warn.mock.calls).length, 1);
}, { privateChannels: ['C3', 'C4'], notMemberOf: { [AGENT_BOT]: ['C3'] } }));

test("an app whose bot Slack will not let join a public Channel is reported the same way, with Slack's reason", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, 'left_out');
  assert.deepEqual(joins(h), [[AGENT_BOT, 'C2']]);
  assert.deepEqual(botsLeftOut(warn.mock.calls).map((line) => (line as { reason: string }).reason), ['missing_scope']);
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), [], 'a bot outside the Channel cannot greet it');
}, { refuse: { [`conversations.join ${AGENT_BOT}`]: 'missing_scope' } }));

/** An Owner's click on the not-in-channel offer's Add button, as Chickpea's own app receives it. */
function addClick(channelId: string, agentId: string) {
  return {
    type: 'block_actions', api_app_id: MAIN_APP.appId, team: { id: TEAM }, user: { id: 'U1' },
    channel: { id: channelId }, trigger_id: 'trigger1',
    container: { type: 'message', channel_id: channelId, message_ts: '1800000000.000200', is_ephemeral: true },
    actions: [{ type: 'button', action_id: AGENT_CHANNEL_ADD_ACTION, block_id: AGENT_CHANNEL_ADD_ACTION, value: agentId, action_ts: `${Date.now() / 1_000}` }],
  };
}

async function ephemeralNotes(h: Harness): Promise<string[]> {
  for (let attempt = 0; attempt < 200 && !slackPosts(h, 'chat.postEphemeral').length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return slackPosts(h, 'chat.postEphemeral').map((body) => body.get('text') ?? '');
}

test("Chickpea's in-Slack Add brings the app's bot in too, and says plainly when it could not", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliverToChickpea(addClick('C2', 'agent_support'), 'interactions')).status, 200);
  assert.deepEqual(await ephemeralNotes(h), [SUPPORT_READY]);
  assert.deepEqual(joins(h), [[AGENT_BOT, 'C2']]);
  assert.deepEqual(h.calls.filter((call) => call.method === 'chat.postMessage').map((call) => [call.token, call.body.get('channel'), call.body.get('text')]),
    [[AGENT_BOT, 'C2', SUPPORT_WELCOME_IN_THREADS]], "the click reached Chickpea's own app, and the Agent still greets as its own bot");
}));

test("Chickpea's in-Slack Add that leaves the app's bot out tells the person how to add it", async (t) => withHarness(t, async (h) => {
  t.mock.method(console, 'warn', () => undefined);
  assert.equal((await h.deliverToChickpea(addClick('C2', 'agent_support'), 'interactions')).status, 200);
  assert.deepEqual(await ephemeralNotes(h), ["To let @support answer here, add it from the channel's Add people or agents."]);
  assert.equal((await h.stores.config.listAgentChannelGrants(TEAM, 'C2'))[0]?.status, 'active');
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), []);
}, { refuse: { [`conversations.join ${AGENT_BOT}`]: 'missing_scope' } }));

test("the Owner's App Home reads the permission bar's fact: without the user-group token Finance's offer sends the Owner to Admin", async (t) => withHarness(t, async (h) => {
  configureHostedSlackPermissionsUpdate({ path: '/start/reinstall', grantsUserGroupToken: true });
  t.after(() => configureHostedSlackPermissionsUpdate(undefined));
  const home = async (): Promise<string> => {
    const before = h.calls.length;
    const now = Date.now();
    assert.equal((await h.deliverToChickpea({
      token: '', team_id: TEAM, api_app_id: MAIN_APP.appId, type: 'event_callback', event_id: `EvHome${now}`, event_time: now,
      authorizations: [{ team_id: TEAM, user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
      event: { type: 'app_home_opened', user: 'U1', channel: 'DHOME', tab: 'home' },
    })).status, 200);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const published = h.calls.slice(before).find((call) => call.method === 'views.publish');
      if (published) return published.body.get('view') ?? '';
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('no App Home was published');
  };

  const missing = await home();
  assert.ok(missing.includes(escapeMrkdwn('Chickpea needs one more Slack permission to give @finance its own Slack app. In Chickpea Admin, choose Update in Slack.')));
  assert.ok(missing.includes('"url":"https://hosted.example/admin"'));
  assert.equal(missing.includes(escapeMrkdwn('Give @finance its own Slack app')), false);

  await writeHostedSlackBotCredentials({ state: h.stores.identity, keyring: loadCredentialKeyring() }, h.hostedRevision, {
    botToken: MAIN_BOT, botUserId: 'UBOT', appId: MAIN_APP.appId, teamId: TEAM,
    grantedScopes: ['chat:write', 'users:read'], validatedAt: Date.now(), userGroupToken: 'xoxp-owner-user-group',
  });
  invalidateSlackInstallationCredentialCache();
  const held = await home();
  assert.ok(held.includes(escapeMrkdwn('Give @finance its own Slack app')), 'with the token held the Owner can start');
  assert.equal(held.includes('one more Slack permission'), false);
}));
