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
import {
  type AgentSlackAppsHost,
  agentSlackAppIngress,
  configureAgentSlackApps,
  endAgentSlackApp,
  retireAgentSlackApps,
  withAgentSlackAppHandoff,
} from '../src/slack/agent-apps/host.ts';
import { createAgentSlackAppRoutes } from '../src/slack/agent-apps/index.ts';
import { readAppSecrets, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { createAgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { generateCredentialKeyring, loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { invalidateStoredSlackPublicUrl } from '../src/slack/credentials.ts';
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
import { createDirectSlackTransport } from '../src/slack/transport/direct.ts';
import type { PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { uiActionId, uiBlockId, uiSurfaceId, uiValue } from '../src/slack/ui/surface.ts';
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
  deliver(kind: 'events' | 'interactions', body: unknown, options?: { env?: PlatformEnv; secret?: string }): Promise<Response>;
  /** The same Slack event as Chickpea's own app receives it; settles once the work it detaches is done. */
  deliverToChickpea(body: unknown): Promise<Response>;
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
 * `notMemberOf` names, per bot token, the Channels that bot is not in; every bot is in every other Channel.
 */
async function withHarness(
  t: TestContext,
  run: (harness: Harness) => Promise<void>,
  options: { lostHostedBot?: boolean; notMemberOf?: Partial<Record<string, readonly string[]>> } = {},
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
  await writeHostedSlackBotCredentials({ state: stores.identity, keyring: hostedKeyring }, null, {
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
    const answer = method === 'auth.test'
      ? { ok: true, team_id: TEAM, user_id: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: AGENT_APP, team: 'Tenant' }
      : method === 'users.info'
        ? { ok: true, user: { id: user, team_id: TEAM, name: user, deleted: false, is_bot: false, is_app_user: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false } }
        : method === 'conversations.info'
          ? { ok: true, channel: channel.startsWith('C')
            ? {
              id: channel, name: 'team', is_channel: true, is_private: false,
              is_member: !options.notMemberOf?.[token ?? '']?.includes(channel), is_archived: false,
            }
            : { id: channel, is_im: true, user: 'U1' } }
          : method === 'conversations.members'
            ? { ok: true, members: ['U1', 'U2', AGENT_BOT_USER], response_metadata: { next_cursor: '' } }
            : method === 'conversations.open'
              ? { ok: true, channel: { id: 'DOWNER' } }
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
    stores, calls, base, delivery, installedAt, secrets,
    async deliver(kind, body, options = {}) {
      const raw = kind === 'events' ? JSON.stringify(body) : new URLSearchParams({ payload: JSON.stringify(body) }).toString();
      return signed(`/channels/slack/agent-apps/${kind}`, raw, options.secret ?? AGENT_SECRET, options.env ?? delivery);
    },
    async deliverToChickpea(body) {
      const detached: Promise<unknown>[] = [];
      const ctx: ExecutionContext = { waitUntil: (task) => { detached.push(task); }, passThroughOnException() {}, props: {} };
      const response = await signed('/channels/slack/events', JSON.stringify(body), MAIN_APP.signingSecret, withHostedSlackApp(base, MAIN_APP), ctx);
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
    assert.deepEqual(
      notAdmitted(info.mock.calls),
      [{ event: 'chickpea.turn.not_admitted', reason: 'already_admitted', agentId: named[0], delivery: heardFirst === 'app' ? 'installation' : 'agent_app' }],
      `${label}: the later delivery adds no turn, and says so in the operator log`,
    );
    const turns = (await h.stores.slackState.listPendingTurns!()).filter((job) => job.turn.messageTs === ts);
    assert.deepEqual(
      turns.map((job) => [job.assignment.agentId, job.assignment.threadGuest === true, job.turn.coAddressed?.position]),
      [[named[0], false, 0], [named[1], true, 1]],
      `${label}: each Agent answers once, the first one named first and the other after it as its guest`,
    );
    assert.equal((await h.stores.config.getAgentThreadRoute(TEAM, 'C1', ts))?.agentId, named[0], `${label}: the first one named keeps the thread`);
  }
}));

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
  assert.equal(welcome?.get('text'), `${SUPPORT_WELCOME}, and once I’m in a thread you can keep going there without the mention.`,
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
