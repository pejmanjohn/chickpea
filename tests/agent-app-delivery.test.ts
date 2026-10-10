import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import { markSlackInstallationEnded, serveAgentAppSlackDelivery } from '../src/channels/slack.ts';
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
import type { PendingTurnJob } from '../src/slack/turn-jobs.ts';
import { uiActionId, uiBlockId, uiSurfaceId, uiValue } from '../src/slack/ui/surface.ts';
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
    editPolicy: 'creator_and_admins', configurationGeneration: 1, model: 'local-stub/agent-app',
    slackPresence: {
      requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: id }, userGroupId: `S${handle.toUpperCase()}`,
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

/** `lostHostedBot` writes the hosted bot's bundle under a key this deployment never holds, so it cannot be read. */
async function withHarness(t: TestContext, run: (harness: Harness) => Promise<void>, options: { lostHostedBot?: boolean } = {}): Promise<void> {
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
    calls.push({ method, token: authorization?.replace(/^Bearer /, '') ?? body.get('token') ?? undefined, body });
    const user = body.get('user') ?? 'U1';
    const answer = method === 'auth.test'
      ? { ok: true, team_id: TEAM, user_id: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: AGENT_APP, team: 'Tenant' }
      : method === 'users.info'
        ? { ok: true, user: { id: user, team_id: TEAM, name: user, deleted: false, is_bot: false, is_app_user: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false } }
        : method === 'conversations.info'
          ? { ok: true, channel: body.get('channel')?.startsWith('C')
            ? { id: body.get('channel'), name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false }
            : { id: body.get('channel'), is_im: true, user: 'U1' } }
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
