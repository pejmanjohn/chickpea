import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { Hono, type ExecutionContext } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import {
  admitSetupWake,
  markSlackInstallationEnded,
  processSlackAgentAsks,
  serveAgentAppSlackDelivery,
  setupWakeTurnJobId,
  channel as slackChannel,
} from '../src/channels/slack.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { EncryptedCredentialStore } from '../src/config/settings-store.ts';
import { closeNodeStateStores, getSettingsStore, resolveStores, type AppStores, type PlatformEnv } from '../src/config/state-backend.ts';
import { AWAITING_OWN_APP, type AgentAppLifecycle, type CustomAgentConfig, appRecordOf } from '../src/config/types.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { deliverManagementReceiptToSlack, formatManagementSetupReceipt } from '../src/management/receipts.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import { drainManagementReceiptOutbox, isAgentAppSwitchJob, isFinalOutboxAttempt } from '../src/management/receipts.ts';
import type { ManagementStore } from '../src/management/store.ts';
import type { ManagementActorContext, ManagementAgentAppSwitchJob } from '../src/management/types.ts';
import {
  type AgentSlackAppsHost,
  agentSlackAppIngress,
  configureAgentSlackApps,
  endAgentSlackApp,
  retireAgentSlackApps,
  withAgentSlackAppHandoff,
} from '../src/slack/agent-apps/host.ts';
import {
  agentAppBotCredentials,
  agentAppPresenceHooks,
  armUnfinishedAgentAppMoves,
  continueAgentAppSwitch,
  createAgentSlackAppRoutes,
  withAgentAppExecution,
} from '../src/slack/agent-apps/index.ts';
import { clearAdmissionMembershipsForTests } from '../src/slack/agent-apps/place.ts';
import { readAppSecrets, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { createAgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { generateCredentialKeyring, loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_ASK_PAUSE_TEXT, AGENT_ASK_TURN_LIMIT, createAgentAskCollector } from '../src/slack/agent-asks.ts';
import { OPEN_AGENT_DM_ACTION_ID, START_AGENT_ACTION_ID } from '../src/slack/app-home.ts';
import { CANVASES_NOT_IN_AGENT_DM, createSlackCanvasTools, slackCanvasService } from '../src/slack/canvases/tools.ts';
import { createSlackChannel } from '../src/slack/channel-creation/runtime.ts';
import { startSlackGroupDm } from '../src/slack/group-dm/runtime.ts';
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
import {
  resolveSlackInstallationExecutionContext,
  SlackInstallationUnavailableError,
  turnJobRunSpeaker,
  verifySlackInstallationTurnAccess,
} from '../src/slack/installation-execution.ts';
import { stopNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import { deliverAgentFailureFinal } from '../src/slack/run-turn.ts';
import { redrawCardSetAsAgent } from '../src/slack/ui/agent-card-redraw.ts';
import { validatePresentCards } from '../src/slack/ui/presentation-tools.ts';
import { renderCards } from '../src/slack/ui/render-display.ts';
import type { ResolvedRoutineAuthority } from '../src/routines/agent-authority.ts';
import { routineDestinationBindingDigest } from '../src/routines/ids.ts';
import { resolveRoutineRuntimeAccess } from '../src/routines/runtime.ts';
import type { RoutineDefinition, RoutineRun } from '../src/routines/types.ts';
import { recordDeliveredSlackAgentMessage } from '../src/slack/public-context.ts';
import { SLACK_READ_MESSAGES, SlackReadError } from '../src/slack/reading/errors.ts';
import { slackReadingService } from '../src/slack/reading/tools.ts';
import { createDirectSlackTransport } from '../src/slack/transport/direct.ts';
import type { PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { displaySurfaceId, uiActionId, uiBlockId, uiSurfaceId, uiValue, type UiSurfaceRecord } from '../src/slack/ui/surface.ts';
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
const BOTS = [[MAIN_BOT, 'UBOT'], [AGENT_BOT, AGENT_BOT_USER]] as const;
/** The Owner's DM with Chickpea's app. `D1` is their DM with Support's own app. */
const CHICKPEA_DM = 'DCHICKPEA';
const DM_BOTS: Partial<Record<string, string>> = { D1: AGENT_BOT, [CHICKPEA_DM]: MAIN_BOT };
const FINANCE_APP = 'A0AGENT2';
const FINANCE_BOT = 'xoxb-finance-bot';
const FINANCE_BOT_USER = 'UFINBOT';
/** Each Agent app bot's DM with the Owner, as `conversations.open` names it. */
const APP_DMS: Partial<Record<string, string>> = { [AGENT_BOT]: 'D1', [FINANCE_BOT]: 'DFINANCE' };
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};

interface SlackCall { method: string; token: string | undefined; body: URLSearchParams }

interface Harness {
  stores: AppStores;
  calls: SlackCall[];
  /** The user groups Slack has turned off. */
  groupsOff: Set<string>;
  base: PlatformEnv;
  delivery: PlatformEnv;
  installedAt: number;
  /** The hosted bot's active credential revision. */
  hostedRevision: string;
  ownerMembershipId: string;
  /** `settle` waits for the work the delivery detaches. */
  deliver(kind: 'events' | 'interactions', body: unknown, options?: { env?: PlatformEnv; secret?: string; settle?: boolean }): Promise<Response>;
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
 * `sharedFrom` are Channels whose `conversations.info` names another workspace as their context team.
 * `refuse` answers a call, keyed `<method> <token>`, with that Slack error.
 * `rateLimited` answers a call, keyed the same way, with HTTP 429 and a one-second Retry-After.
 * `history` and `replies` are the messages `conversations.history` and `conversations.replies` return; `reactions.get` finds its message in `replies`.
 */
async function withHarness(
  t: TestContext,
  run: (harness: Harness) => Promise<void>,
  options: {
    lostHostedBot?: boolean;
    notMemberOf?: Partial<Record<string, readonly string[]>>;
    privateChannels?: readonly string[];
    sharedFrom?: readonly string[];
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
  clearAdmissionMembershipsForTests();
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
  // Support's app holds its handle, so its released group is off in Slack.
  const groupsOff = new Set(['SSUPPORT']);
  const outside = new Map(Object.entries(options.notMemberOf ?? {}).map(([token, channels]) => [token, new Set(channels)]));
  // Who posted each message, so an edit by another token is refused as Slack refuses it.
  const posters = new Map<string, string | undefined>();
  let posted = 0;
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
    // As in Slack, an Agent app's token is refused what its scopes leave out: reading a DM (im:read), a group DM's
    // messages (mpim:history), and opening a group DM (mpim:write).
    if (token && APP_DMS[token] && (
      (method === 'conversations.info' && channel.startsWith('D')) ||
      (['conversations.history', 'conversations.replies'].includes(method) && channel.startsWith('G')) ||
      (method === 'conversations.open' && (body.get('users') ?? '').includes(','))
    )) {
      return Response.json({ ok: false, error: 'missing_scope' });
    }
    if (method === 'conversations.open' && !body.get('users') && !channel) return Response.json({ ok: false, error: 'users_list_not_supplied' });
    // As in Slack, a bot sees a private Channel or group DM only when it is in it, and a DM only when it is one side of it.
    if (method === 'conversations.info' && (
      ((options.privateChannels?.includes(channel) || channel.startsWith('G')) && outside.get(token ?? '')?.has(channel)) ||
      (DM_BOTS[channel] && DM_BOTS[channel] !== token)
    )) {
      return Response.json({ ok: false, error: 'channel_not_found' });
    }
    // As in Slack, a bot posts or edits only where it is: a Channel or group DM it is in, and its own app's DM.
    if (['chat.postMessage', 'chat.update', 'chat.startStream', 'chat.appendStream', 'chat.stopStream'].includes(method)) {
      if (channel.startsWith('C') && outside.get(token ?? '')?.has(channel)) return Response.json({ ok: false, error: 'not_in_channel' });
      if (channel.startsWith('G') && outside.get(token ?? '')?.has(channel)) return Response.json({ ok: false, error: 'channel_not_found' });
      const dmBot = DM_BOTS[channel];
      if (dmBot && token !== dmBot) return Response.json({ ok: false, error: 'channel_not_found' });
    }
    // Only the bot that posted a message can edit it.
    const edited = body.get('ts');
    if (method === 'chat.update' && edited && posters.has(`${channel} ${edited}`) && posters.get(`${channel} ${edited}`) !== token) {
      return Response.json({ ok: false, error: 'cant_update_message' });
    }
    // As in Slack, a user group is turned off or on once; a second time is refused as already so.
    if (method === 'usergroups.enable' || method === 'usergroups.disable') {
      const id = body.get('usergroup') ?? '';
      const disable = method === 'usergroups.disable';
      if (groupsOff.has(id) === disable) return Response.json({ ok: false, error: disable ? 'already_disabled' : 'already_enabled' });
      if (disable) groupsOff.add(id);
      else groupsOff.delete(id);
      return Response.json({ ok: true, usergroup: { id, name: id, handle: id.slice(1).toLowerCase(), is_disabled: disable } });
    }
    if (method === 'conversations.join') outside.get(token ?? '')?.delete(channel);
    if (method === 'conversations.invite') {
      if (outside.get(token ?? '')?.has(channel)) return Response.json({ ok: false, error: 'not_in_channel' });
      const invited = BOTS.find(([, botUser]) => botUser === body.get('users'))?.[0];
      if (!outside.get(invited ?? '')?.delete(channel)) return Response.json({ ok: false, error: 'already_in_channel' });
    }
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
              ...(options.sharedFrom?.includes(channel) ? { is_shared: true, context_team_id: 'TOTHER' } : {}),
            }
            : channel.startsWith('G')
              ? { id: channel, name: 'mpdm-owner--teammate-1', is_mpim: true, is_private: true, is_member: true, is_archived: false }
              : { id: channel, is_im: true, user: 'U1' } }
          : method === 'conversations.create'
            ? { ok: true, channel: { id: 'C9NEW', name: body.get('name'), is_channel: true, is_private: body.get('is_private') === 'true', is_member: true } }
          : method === 'conversations.join'
            ? { ok: true, channel: { id: channel, name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false } }
          : method === 'conversations.members'
            ? {
              ok: true,
              members: ['U1', 'U2', ...BOTS
                .flatMap(([botToken, botUser]) => outside.get(botToken)?.has(channel) ? [] : [botUser])],
              response_metadata: { next_cursor: '' },
            }
            : method === 'conversations.open'
              ? { ok: true, channel: { id: (body.get('users') ?? '').includes(',') ? 'GNEW' : APP_DMS[token ?? ''] ?? 'DOWNER' } }
              : method === 'conversations.history' || method === 'conversations.replies'
                ? { ok: true, messages: (method === 'conversations.history' ? options.history : options.replies) ?? [] }
              : method === 'reactions.get'
                ? { ok: true, type: 'message', message: options.replies?.find((message) => message.ts === body.get('timestamp')) }
              : method === 'chat.postMessage' || method === 'chat.startStream'
                ? (() => {
                  posted += 1;
                  const ts = `1900000000.${String(100 + posted).padStart(6, '0')}`;
                  posters.set(`${channel} ${ts}`, token);
                  return { ok: true, ts, channel: body.get('channel') ?? 'D1' };
                })()
              : method.startsWith('chat.')
                ? { ok: true, ts: edited ?? '1900000000.000100', channel: body.get('channel') ?? 'D1' }
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
    stores, calls, base, delivery, groupsOff, installedAt, hostedRevision, secrets, ownerMembershipId: owner.membership.id,
    async deliver(kind, body, options = {}) {
      const raw = kind === 'events' ? JSON.stringify(body) : new URLSearchParams({ payload: JSON.stringify(body) }).toString();
      if (!options.settle) return signed(`/channels/slack/agent-apps/${kind}`, raw, options.secret ?? AGENT_SECRET, options.env ?? delivery);
      const detached: Promise<unknown>[] = [];
      const ctx: ExecutionContext = { waitUntil: (task) => { detached.push(task); }, passThroughOnException() {}, props: {} };
      const response = await signed(`/channels/slack/agent-apps/${kind}`, raw, options.secret ?? AGENT_SECRET, options.env ?? delivery, ctx);
      await Promise.all(detached);
      return response;
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

/**
 * Run the move jobs in the state store's outbox as its alarm does, through the real outbox and drain, until none is
 * due; returns each settled job's delivery reference.
 */
async function drainMoves(h: Harness): Promise<string[]> {
  const refs: string[] = [];
  for (let pass = 0; pass < 10; pass += 1) {
    const drained = await drainManagementReceiptOutbox({
      management: h.stores.management as unknown as ManagementStore,
      deliver: async (record) => {
        assert.equal(isAgentAppSwitchJob(record.receipt), true, 'only move jobs are due');
        // The store's own rows, as its drain passes them: the main bot's credentials are read from these, not through the env.
        const local = { ...h.stores, settings: getSettingsStore(h.base) };
        const delivered = await continueAgentAppSwitch(h.base, record.receipt as ManagementAgentAppSwitchJob, local, {
          finalAttempt: isFinalOutboxAttempt(record),
        });
        refs.push(delivered.deliveryRef);
        return delivered;
      },
    });
    if (drained.delivered + drained.retried + drained.failed === 0) break;
  }
  return refs;
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

test('an app_uninstalled ends only that Agent app: the bot token goes, its group comes back, the Owner is told, the installation and other Agents stand', async (t) => withHarness(t, async (h) => {
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
  assert.equal(h.calls.some((call) => call.method === 'chat.postMessage'), false, 'the event itself tells no one');

  // The state store's drain runs the move job the event armed: the group back on, then the Owner told.
  assert.deepEqual(await drainMoves(h), ['agent_app_switch:not_live']);
  assert.equal(h.groupsOff.has('SSUPPORT'), false, 'the released group is on again');
  assert.equal(h.calls.find((call) => call.method === 'usergroups.enable')?.body.get('usergroup'), 'SSUPPORT');
  const presence = (await h.stores.config.getAgent('agent_support')).slackPresence;
  assert.deepEqual(presence && [presence.kind, presence.userGroupId, presence.health], [undefined, 'SSUPPORT', 'healthy'], 'the group holds the handle again');
  assert.equal(appRecordOf(presence)?.state, 'needs_attention', 'with the removed app attached');
  const removedDm = h.calls.filter((call) => call.method === 'chat.postMessage');
  assert.equal(removedDm.length, 1, 'the Owner is told once');
  assert.equal(removedDm[0]?.token, MAIN_BOT, 'the Owner hears it from Chickpea');
  assert.equal(removedDm[0]?.body.get('text'), escapeMrkdwn(
    "Support's Slack app was removed from this workspace. People can still mention @support, and Support answers through Chickpea. Choose Allow to add the app back.",
  ));
  assert.equal(await agentSlackAppIngress(h.base, AGENT_APP) !== undefined, true, 'the app record is still known to the ingress while it waits for Allow');
  assert.deepEqual(await drainMoves(h), [], 'nothing is left to run');

  assert.equal(await endAgentSlackApp(h.base, AGENT_APP, dmEvent({}, { type: 'app_uninstalled' })), 'ignored', 'ending twice changes nothing');
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  assert.equal(h.calls.filter((call) => call.token === AGENT_BOT).length, 0, 'a removed app runs nothing as its bot');
}));

// Defects caught: a switch cut off between making the app live and arming its job, left for a person; a job the drain
// cannot run in the state store (no port, the main bot unreadable from inside it); a sweep that arms a second job.
test("a switch whose job was never armed is found by the state store's sweep and run by its drain to done, through the real stores", async (t) => withHarness(t, async (h) => {
  const agent = await h.stores.config.getAgent('agent_support');
  const live = agent.slackPresence!.kind === 'agent_app' ? agent.slackPresence!.app : undefined;
  assert.equal(live?.state, 'active');
  h.groupsOff.delete('SSUPPORT');
  // As Allow leaves it when the Worker stops before the job is armed: the app live, its group still answering.
  await h.stores.config.updateAgent(agent.id, {
    slackPresence: {
      ...agent.slackPresence!, kind: 'agent_app', app: { ...live!, switchProgress: 'group_pending' },
      released: { userGroupId: 'SSUPPORT', desiredState: 'active', health: 'healthy', answers: true },
    },
  } as never, agent.revision);
  assert.deepEqual(await drainMoves(h), [], 'no job was armed');

  await armUnfinishedAgentAppMoves(h.stores, Date.now());
  await armUnfinishedAgentAppMoves(h.stores, Date.now());
  assert.deepEqual(await drainMoves(h), ['agent_app_switch:done'], 'the sweep armed one job, and the drain ran it');
  const presence = (await h.stores.config.getAgent('agent_support')).slackPresence;
  const app = presence?.kind === 'agent_app' ? presence.app : undefined;
  assert.equal(app?.state === 'active' && app.switchProgress, 'done');
  assert.equal(presence?.kind === 'agent_app' && presence.released?.answers, false);
  assert.equal(h.groupsOff.has('SSUPPORT'), true, 'the group is off in Slack');
  const disable = h.calls.find((call) => call.method === 'usergroups.disable');
  assert.equal(disable?.token, MAIN_BOT, "the disable uses the main bot's credentials, read inside the store");
  const told = h.calls.filter((call) => call.method === 'chat.postMessage');
  assert.equal(told.length, 1);
  assert.match(told[0]?.body.get('text') ?? '', /Support is now its own Slack app/);

  await armUnfinishedAgentAppMoves(h.stores, Date.now());
  assert.deepEqual(await drainMoves(h), [], 'a finished switch is armed no more');
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

test("an Agent whose app's record names another Agent gets no bot token and no ingress facts, and the operator sees why", async (t) => withHarness(t, async (h) => {
  const stored = await readAppSecrets(h.secrets(), AGENT_APP);
  assert.ok(stored);
  await writeAppSecrets(h.secrets(), AGENT_APP, 'agent_finance', stored.secrets, stored.revision);
  const warn = t.mock.method(console, 'warn', () => undefined);
  assert.equal(await agentSlackAppIngress(h.base, AGENT_APP), undefined);
  assert.equal(await agentAppBotCredentials(h.base, 'agent_support', AGENT_APP), undefined);
  const line = (use: string) => ({ event: 'chickpea.agent_app.record_refused', use, agentId: 'agent_support', appId: AGENT_APP, recordAgentId: 'agent_finance' });
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [line('ingress'), line('execution')]);
  assert.equal(JSON.stringify(warn.mock.calls).includes(AGENT_BOT), false);
  assert.equal(JSON.stringify(warn.mock.calls).includes(AGENT_SECRET), false);
}));

test("an app_uninstalled for an app whose record names another Agent leaves that record as it was", async (t) => withHarness(t, async (h) => {
  const stored = await readAppSecrets(h.secrets(), AGENT_APP);
  assert.ok(stored);
  await writeAppSecrets(h.secrets(), AGENT_APP, 'agent_finance', stored.secrets, stored.revision);
  t.mock.method(console, 'warn', () => undefined);
  assert.equal(await endAgentSlackApp(h.base, AGENT_APP, dmEvent({}, { type: 'app_uninstalled' })), 'ended');
  const after = await readAppSecrets(h.secrets(), AGENT_APP);
  assert.deepEqual(after && { agentId: after.agentId, botToken: after.secrets.botToken }, { agentId: 'agent_finance', botToken: AGENT_BOT },
    "Support's end never rewrites another Agent's record as Support's");
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

test("a person's reply right after a proposal is judged at admission; after another turn only the exact word approves", async (t) => withHarness(t, async (h) => {
  const owner = await h.stores.identity.resolveSlackIdentity(TEAM, 'U1');
  assert.ok(owner);
  const reply = async (text: string, ts: string) => {
    assert.equal((await h.deliver('events', dmEvent({ event_id: `Ev${ts}` }, { text, ts, event_ts: ts }))).status, 200);
    const job = await pendingTurn(h.stores, (pending) => pending.turn.messageTs === ts);
    assert.ok(job, `"${text}" became a turn`);
    return job;
  };
  const judged = async (ts: string) =>
    (await h.stores.usage.getOperation(`management_approval:${TEAM}:D1:Ev${ts}`)) !== undefined;

  const proposing = await reply('remember that refunds go to account 99', '1900000200.000100');
  const scope = `slack:${TEAM}:D1:dm:agent:agent_support`;
  const proposalId = 'changeset_typed_dm';
  await h.stores.management.putChangeSetProposal({
    proposalId, organizationId: owner.membership.organizationId,
    actorUserId: owner.user.id, actorMembershipId: owner.membership.id,
    originKey: scope, approvalScopeKey: scope, idempotencyKey: proposalId,
    guideVersion: 'test', authoringReason: 'agent_edit', digest: 'd'.repeat(64),
    operations: [{ itemId: 'memory', kind: 'update_agent_memory', agentId: 'agent_support', expectedRevision: 0, body: 'Refunds go to account 99.' }],
    preview: { summary: 'Preview', changes: [], missingSetup: [] },
    targetRevisions: { 'memory:agent_support': 0 }, at: Date.now(),
    proposedMessageTs: proposing.turn.messageTs,
  });

  assert.equal(proposing.turn.managementProposalPending, undefined, 'nothing waited when the request was admitted');

  // This harness grants the judge no model access, so its side call fails.
  const adjacent = await reply('yes, go ahead', '1900000201.000100');
  assert.equal(await judged('1900000201.000100'), true, 'the reply right after the proposal is judged');
  assert.equal(adjacent.turn.managementApprovalProposalId, undefined, 'a failed judgment applies nothing');
  assert.equal((await h.stores.management.getChangeSetProposal(proposalId))?.status, 'pending');
  // Defect caught: a typed reply that left the change set waiting dispatches
  // without the pre-mount flag, so the Agent's first request lacks the change tools.
  assert.equal(adjacent.turn.managementProposalPending, true, 'the change set still waits on the requester');

  const later = await reply('sounds good', '1900000202.000100');
  assert.equal(await judged('1900000202.000100'), false, 'the Agent took a turn since the proposal');
  assert.equal(later.turn.managementApprovalProposalId, undefined);
  assert.equal(later.turn.managementProposalPending, true, 'still waiting, judged or not');

  const typed = await reply('approve', '1900000203.000100');
  assert.equal(typed.turn.managementApprovalProposalId, proposalId, 'the exact word needs no model and no adjacency');
  assert.equal(typed.turn.managementProposalPending, undefined, 'an approval carries no pre-mount flag');
}));

test("a stop phrase in a DM thread keeps its host meaning and is never judged as a decline", async (t) => withHarness(t, async (h) => {
  const owner = await h.stores.identity.resolveSlackIdentity(TEAM, 'U1');
  assert.ok(owner);
  const root = '1900000300.000100';
  assert.equal((await h.deliver('events', dmEvent({ event_id: `Ev${root}` }, { text: 'remember that refunds go to account 99', ts: root, event_ts: root }))).status, 200);
  assert.ok(await pendingTurn(h.stores, (pending) => pending.turn.messageTs === root));
  const proposalId = 'changeset_stop_phrase';
  await h.stores.management.putChangeSetProposal({
    proposalId, organizationId: owner.membership.organizationId,
    actorUserId: owner.user.id, actorMembershipId: owner.membership.id,
    originKey: `slack:${TEAM}:D1:${root}:im:agent:agent_support`,
    approvalScopeKey: `slack:${TEAM}:D1:dm:agent:agent_support`, idempotencyKey: proposalId,
    guideVersion: 'test', authoringReason: 'agent_edit', digest: 'd'.repeat(64),
    operations: [{ itemId: 'memory', kind: 'update_agent_memory', agentId: 'agent_support', expectedRevision: 0, body: 'Refunds go to account 99.' }],
    preview: { summary: 'Preview', changes: [], missingSetup: [] },
    targetRevisions: { 'memory:agent_support': 0 }, at: Date.now(),
    proposedMessageTs: root,
  });

  const stop = '1900000301.000100';
  const stopEvent = dmEvent({ event_id: `Ev${stop}` }, { text: 'cancel that', ts: stop, event_ts: stop, thread_ts: root });
  assert.equal((await h.deliver('events', stopEvent, { settle: true })).status, 200);
  assert.equal(await h.stores.usage.getOperation(`management_approval:${TEAM}:D1:Ev${stop}`), undefined,
    'a stop phrase is never judged');
  assert.equal((await h.stores.management.getChangeSetProposal(proposalId))?.status, 'pending');
}));

test("a stop phrase that hands the thread to another Agent is never judged against that Agent's waiting change", async (t) => withHarness(t, async (h) => {
  const owner = await h.stores.identity.resolveSlackIdentity(TEAM, 'U1');
  assert.ok(owner);
  const root = '1900001100.000100';
  assert.equal((await h.deliverToChickpea(channelMessage(root, '<!subteam^SFINANCE|@finance> remember that refunds go to account 99').chickpea)).status, 200);
  assert.ok(await pendingTurn(h.stores, (pending) => pending.assignment.agentId === 'agent_finance' && pending.turn.messageTs === root),
    "Finance's turn proposed the change");
  const proposalId = 'changeset_routed_stop_phrase';
  const scope = `slack:${TEAM}:C1:${root}:agent:agent_finance`;
  await h.stores.management.putChangeSetProposal({
    proposalId, organizationId: owner.membership.organizationId,
    actorUserId: owner.user.id, actorMembershipId: owner.membership.id,
    originKey: scope, approvalScopeKey: scope, idempotencyKey: proposalId,
    guideVersion: 'test', authoringReason: 'agent_edit', digest: 'd'.repeat(64),
    operations: [{ itemId: 'memory', kind: 'update_agent_memory', agentId: 'agent_finance', expectedRevision: 0, body: 'Refunds go to account 99.' }],
    preview: { summary: 'Preview', changes: [], missingSetup: [] },
    targetRevisions: { 'memory:agent_finance': 0 }, at: Date.now(),
    proposedMessageTs: root,
  });
  const route = await h.stores.config.getAgentThreadRoute(TEAM, 'C1', root);
  assert.equal(route?.agentId, 'agent_finance');
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'C1', threadTs: root, agentId: 'agent_support', agentGeneration: 1 }, route!.revision);

  const stop = '1900001101.000100';
  const heard = channelMessage(stop, '<!subteam^SFINANCE|@finance> cancel that').chickpea;
  assert.equal((await h.deliverToChickpea({ ...heard, event: { ...heard.event, thread_ts: root } })).status, 200);
  assert.equal((await h.stores.config.getAgentThreadRoute(TEAM, 'C1', root))?.agentId, 'agent_finance',
    'the message names Finance, so it is a handoff from the thread\'s owner');
  assert.equal(await h.stores.usage.getOperation(`management_approval:${TEAM}:C1:${heard.event_id}`), undefined,
    'a stop phrase is never judged, handed to another Agent or not');
  assert.equal((await h.stores.management.getChangeSetProposal(proposalId))?.status, 'pending');
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

test("a mixed message where the app Agent's bot is not in the Channel is answered by each Agent, Support through Chickpea's bot", async (t) => withHarness(t, async (h) => {
  for (const [index, text] of MIXED_TEXTS.entries()) {
    const ts = `1900001000.00010${index}`;
    h.calls.length = 0;
    // Only Chickpea's bot is in the Channel, so only it hears the message.
    assert.equal((await h.deliverToChickpea(channelMessage(ts, text).chickpea)).status, 200);
    assert.deepEqual((await answersTo(h, ts)).map(([agentId, speaker]) => [agentId, (speaker as { kind: string }).kind]).sort(),
      [['agent_finance', 'chickpea_as_agent'], ['agent_support', 'chickpea_as_agent']],
      "Chickpea's bot posts for Support where Support's own bot is not");
    assert.deepEqual(channelNotes(h), [], 'nobody is told an Agent is missing');
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

// Defect caught: with Chickpea's bot gone, an uninstalled app whose definition was left reported as still installed,
// because the Owner's message failed after the outcome was committed.
test("a tenant's end that cannot tell the Owner about a left app still uninstalls it and reports what happened to it", async (t) => withHarness(t, async (h) => {
  await hostedBotIsLost(h);
  t.mock.method(console, 'warn', () => undefined);

  assert.deepEqual(await retireAgentSlackApps(h.base), [{ agentId: 'agent_support', outcome: 'uninstalled_left_definition' }]);
  assert.deepEqual(h.calls.map(({ method, token }) => [method, token]), [['apps.uninstall', AGENT_BOT]],
    'the app is uninstalled with its own bot; without a configuration token its definition stays, and the Owner cannot be messaged');
}, { lostHostedBot: true }));

// Defects caught: Admin's archive door choosing the reconciler by the presence's kind, so an Agent with no user
// group whose app record is attached is archived straight in the store and its Slack app is left behind.
test("Admin's archive of an Agent not in Slack yet, with its app attached, retires that app", async (t) => withHarness(t, async (h) => {
  const rotated = { accessToken: 'xoxe.xoxp-1-config-access', refreshToken: 'xoxe-1-config-refresh', teamId: TEAM, expiresAt: Date.now() + 12 * 3_600_000 };
  assert.equal(await saveConfigurationToken({ ...h.secrets(), slack: { rotate: async () => rotated } }, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  const support = await h.stores.config.getAgent('agent_support');
  const waiting = await h.stores.config.updateAgent(support.id, {
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'pending',
      errorCode: AWAITING_OWN_APP, avatar: support.slackPresence!.avatar,
      app: {
        state: 'awaiting_consent', at: Date.now(), startedBy: 'U1', app: { appId: AGENT_APP, clientId: '1.client' },
        icon: 'agent_avatar', allowDm: { channelId: 'D_U1', ts: '1.0' },
      },
    },
  }, support.revision);
  h.calls.length = 0;

  const response = await (await ownerAdmin(h))('/admin/api/agents/agent_support/archive', {
    method: 'POST', body: JSON.stringify({ expectedRevision: waiting.revision }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const archived = await h.stores.config.getAgent('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.equal(archived.slackPresence?.app, undefined, 'nothing of the app is left on the Agent');
  assert.deepEqual(h.calls.map(({ method, token }) => [method, token]), [
    ['apps.uninstall', AGENT_BOT],
    ['apps.manifest.delete', rotated.accessToken],
  ], 'the app is uninstalled and its definition deleted in Slack');
  assert.equal(await readAppSecrets(h.secrets(), AGENT_APP), undefined, "and the app's secrets are gone");
}));

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
  t.mock.method(console, 'warn', () => undefined);
  assert.equal((await h.deliver('events', joinEvent())).status, 200);

  assert.deepEqual(slackPosts(h, 'chat.postMessage').map((body) => [body.get('channel'), body.get('text')]), [['C2', `${SUPPORT_WELCOME}.`]],
    'the app has no Channel message events, so where Chickpea could not join a thread follow-up needs the mention');
}, { notMemberOf: { [MAIN_BOT]: ['C2'] }, refuse: { [`conversations.join ${MAIN_BOT}`]: 'missing_scope' } }));

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
}, {
  notMemberOf: { [MAIN_BOT]: ['C2'], [AGENT_BOT]: ['C1'] },
  // Chickpea's bot could not follow the app's bot into #C2.
  refuse: { [`conversations.join ${MAIN_BOT}`]: 'missing_scope' },
}));

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

function invitesRefused(calls: ReadonlyArray<{ arguments: unknown[] }>): unknown[] {
  return calls.flatMap(({ arguments: [line] }) => {
    const entry = line as { event?: unknown; step?: unknown } | undefined;
    return entry?.event === 'chickpea.agent_app.slack_refused' && entry.step === 'invite' ? [line] : [];
  });
}

const joins = (h: Harness) => h.calls.filter((call) => call.method === 'conversations.join').map((call) => [call.token, call.body.get('channel')]);
const invites = (h: Harness) => h.calls.filter((call) => call.method === 'conversations.invite')
  .map((call) => [call.token, call.body.get('channel'), call.body.get('users')]);

test("Admin's Add to channels has Chickpea's bot invite the app Agent's own bot into a public Channel, and nothing else has a bot to bring", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, 'in_channel');
  assert.deepEqual(invites(h), [[MAIN_BOT, 'C2', AGENT_BOT_USER]], "Chickpea's bot, already in the Channel, invites the app's bot");
  assert.deepEqual(joins(h), [], "the app's bot does not need to join by itself");
  assert.deepEqual([...invitesRefused(warn.mock.calls), ...botsLeftOut(warn.mock.calls)], []);
  assert.equal((await h.stores.config.listAgentChannelGrants(TEAM, 'C2'))[0]?.status, 'active');

  h.calls.length = 0;
  const hooks = agentAppPresenceHooks(h.base)!;
  assert.equal(await hooks.bringBotIn(await h.stores.config.getAgent('agent_finance'), { id: 'C3', private: false }), undefined);
  assert.deepEqual(h.calls, [], "a user-group Agent has no bot of its own to bring in");
  configureAgentSlackApps(undefined);
  assert.equal(agentAppPresenceHooks(h.base), undefined, 'without the port there is nothing to bring in');
}, { notMemberOf: { [AGENT_BOT]: ['C2'] } }));

test("Admin's Add to channels has Chickpea's bot invite the app Agent's own bot into a private Channel", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const added = await addInAdmin(h, 'agent_support', 'C3');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, 'in_channel', 'the Owner is not told to add the bot by hand');
  assert.deepEqual(invites(h), [[MAIN_BOT, 'C3', AGENT_BOT_USER]]);
  assert.deepEqual(joins(h), []);
  assert.deepEqual([...invitesRefused(warn.mock.calls), ...botsLeftOut(warn.mock.calls)], []);
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), [], 'a private Channel is not welcomed');
}, { privateChannels: ['C3'], notMemberOf: { [AGENT_BOT]: ['C3'] } }));

test("an app bot already in the Channel is neither invited nor joined", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  assert.equal((await addInAdmin(h, 'agent_support', 'C2')).body.appBot, 'in_channel');
  assert.equal((await addInAdmin(h, 'agent_support', 'C3')).body.appBot, 'in_channel');
  assert.deepEqual([...invites(h), ...joins(h)], [], 'nothing is written to Slack for a bot that is already there');
  assert.deepEqual([...invitesRefused(warn.mock.calls), ...botsLeftOut(warn.mock.calls)], []);
}, { privateChannels: ['C3'] }));

test("Slack's already_in_channel, for a bot added after Chickpea looked, counts as brought in", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  assert.equal((await addInAdmin(h, 'agent_support', 'C2')).body.appBot, 'in_channel');
  assert.equal((await addInAdmin(h, 'agent_support', 'C3')).body.appBot, 'in_channel');
  assert.deepEqual(invites(h), [[MAIN_BOT, 'C2', AGENT_BOT_USER], [MAIN_BOT, 'C3', AGENT_BOT_USER]]);
  assert.deepEqual(joins(h), [], 'no fallback runs after already_in_channel');
  assert.deepEqual([...invitesRefused(warn.mock.calls), ...botsLeftOut(warn.mock.calls)], [], 'already_in_channel is not a refusal');
}, {
  privateChannels: ['C3'], notMemberOf: { [AGENT_BOT]: ['C2', 'C3'] }, refuse: { [`conversations.invite ${MAIN_BOT}`]: 'already_in_channel' },
}));

const INVITE_REFUSALS = [
  'missing_scope', 'not_in_channel', 'cant_invite', 'is_archived', 'app_cannot_join_channel', 'no_permission', 'user_not_found',
] as const;

test('every invite refusal falls back to the app bot joining a public Channel, and to the left-out path in a private one', async (t) => {
  for (const code of INVITE_REFUSALS) {
    await t.test(code, (st) => withHarness(st, async (h) => {
      const warn = st.mock.method(console, 'warn', () => undefined);
      const publicAdd = await addInAdmin(h, 'agent_support', 'C2');
      assert.equal(publicAdd.status, 201);
      assert.equal(publicAdd.body.appBot, 'in_channel', 'the app bot joins the public Channel itself, as before');
      assert.deepEqual(joins(h), [[AGENT_BOT, 'C2']]);
      const privateAdd = await addInAdmin(h, 'agent_support', 'C3');
      assert.equal(privateAdd.status, 201, 'the Agent is still added');
      assert.equal(privateAdd.body.appBot, 'left_out', 'the Owner is told to add the bot by hand');
      assert.deepEqual(invitesRefused(warn.mock.calls), ['C2', 'C3'].map((channelId) => ({
        event: 'chickpea.agent_app.slack_refused', step: 'invite', agentId: 'agent_support', appId: AGENT_APP, channelId, code, errors: [],
      })), "Slack's code is recorded for the operator");
      assert.deepEqual(botsLeftOut(warn.mock.calls).map((line) => (line as { reason: string }).reason), ['private_channel']);
    }, {
      privateChannels: ['C3'],
      notMemberOf: { [AGENT_BOT]: ['C2', 'C3'] },
      refuse: { [`conversations.invite ${MAIN_BOT}`]: code },
    }));
  }
});

test("Admin's Add to channels welcomes a public Channel once, as the app Agent's own bot, after that bot is invited", async (t) => withHarness(t, async (h) => {
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, 'in_channel');
  assert.deepEqual(joins(h), [[MAIN_BOT, 'C2']], 'neither bot was in the Channel: Chickpea joins, then invites the app bot');
  assert.deepEqual(invites(h), [[MAIN_BOT, 'C2', AGENT_BOT_USER]]);
  const welcomes = h.calls.filter((call) => call.method === 'chat.postMessage');
  assert.deepEqual(welcomes.map((call) => [call.token, call.body.get('channel'), call.body.get('text')]), [[AGENT_BOT, 'C2', SUPPORT_WELCOME_IN_THREADS]],
    "the Agent greets as its own bot, and Chickpea's bot, now in the Channel, brings it the thread's unmentioned replies");
  assert.equal(welcomes[0]?.body.get('username'), null, 'no persona: the app posts as itself');
  assert.equal(welcomes[0]?.body.get('icon_url'), null);
  const invited = h.calls.findIndex((call) => call.method === 'conversations.invite');
  const welcomed = h.calls.findIndex((call) => call.method === 'chat.postMessage' && call.token === AGENT_BOT);
  assert.ok(invited >= 0 && invited < welcomed, 'the welcome follows the bot into the Channel');

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
  assert.equal((applied as { result?: { status?: string } }).result?.status, 'completed', JSON.stringify(applied));
  assert.deepEqual(invites(h), [[MAIN_BOT, 'C2', AGENT_BOT_USER]], "Chickpea's bot invites the app's bot here too");
  assert.deepEqual(joins(h), [[MAIN_BOT, 'C2']]);
  assert.deepEqual(h.calls.filter((call) => call.method === 'chat.postMessage').map((call) => [call.token, call.body.get('channel'), call.body.get('text')]),
    [[AGENT_BOT, 'C2', SUPPORT_WELCOME_IN_THREADS]]);
}, { notMemberOf: { [MAIN_BOT]: ['C2'], [AGENT_BOT]: ['C2'] } }));

test("an unreadable Chickpea bot token sends no invite and falls back, logged apart from Slack's refusals", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, 'in_channel', 'the app bot joins the public Channel itself');
  assert.deepEqual(invites(h), [], 'nothing goes to Slack without the token');
  assert.deepEqual(joins(h), [[AGENT_BOT, 'C2']]);
  assert.deepEqual(invitesRefused(warn.mock.calls).map((line) => (line as { code: string }).code), ['credentials_unavailable']);
}, { lostHostedBot: true, notMemberOf: { [AGENT_BOT]: ['C2'] } }));

test("with the switch off, Admin's Add of an app Agent greets nobody, as before", async (t) => withHarness(t, async (h) => {
  configureAgentSlackApps(undefined);
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, undefined);
  assert.deepEqual(invites(h), [], 'nothing invites a bot the host has no app for');
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), [], 'nothing brings the app bot in, so nothing posts as it');
}));

test("without the invite permissions, Admin's Add of a private Channel the app's bot is not in says so and logs both reasons", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const added = await addInAdmin(h, 'agent_support', 'C3');
  assert.equal(added.status, 201, 'the Agent is still added');
  assert.equal(added.body.appBot, 'left_out');
  assert.equal((await h.stores.config.listAgentChannelGrants(TEAM, 'C3'))[0]?.status, 'active');
  assert.deepEqual(joins(h), [], 'a bot cannot join a private Channel');
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), [], 'nobody is welcomed');
  assert.deepEqual(invitesRefused(warn.mock.calls).map((line) => (line as { code: string }).code), ['missing_scope']);
  assert.deepEqual(botsLeftOut(warn.mock.calls), [{
    event: 'chickpea.agent_app.bot_left_out', agentId: 'agent_support', appId: AGENT_APP, channelId: 'C3', reason: 'private_channel',
  }]);
  assert.doesNotMatch(JSON.stringify(warn.mock.calls.map((call) => call.arguments)), /xoxb-/, 'no token in the log');

  const alreadyIn = await addInAdmin(h, 'agent_support', 'C4');
  assert.equal(alreadyIn.body.appBot, 'in_channel', 'a private Channel someone already added the bot to');
  assert.deepEqual(joins(h), []);
  assert.equal(botsLeftOut(warn.mock.calls).length, 1);
}, {
  privateChannels: ['C3', 'C4'], notMemberOf: { [AGENT_BOT]: ['C3'] }, refuse: { [`conversations.invite ${MAIN_BOT}`]: 'missing_scope' },
}));

test("an app whose bot Slack will neither let Chickpea invite nor let join a public Channel is reported the same way, with Slack's reason", async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const added = await addInAdmin(h, 'agent_support', 'C2');
  assert.equal(added.status, 201);
  assert.equal(added.body.appBot, 'left_out');
  assert.deepEqual(joins(h), [[AGENT_BOT, 'C2']]);
  assert.deepEqual(botsLeftOut(warn.mock.calls).map((line) => (line as { reason: string }).reason), ['missing_scope']);
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), [], 'a bot outside the Channel cannot greet it');
}, {
  notMemberOf: { [AGENT_BOT]: ['C2'] },
  refuse: { [`conversations.invite ${MAIN_BOT}`]: 'missing_scope', [`conversations.join ${AGENT_BOT}`]: 'missing_scope' },
}));

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
  assert.deepEqual(await ephemeralNotes(h), [SUPPORT_READY], 'the invite brought the bot in, so nobody is told to add it by hand');
  assert.deepEqual(invites(h), [[MAIN_BOT, 'C2', AGENT_BOT_USER]]);
  assert.deepEqual(joins(h), [], "the app's own join, which Slack would refuse here, is not needed");
  assert.deepEqual(h.calls.filter((call) => call.method === 'chat.postMessage').map((call) => [call.token, call.body.get('channel'), call.body.get('text')]),
    [[AGENT_BOT, 'C2', SUPPORT_WELCOME_IN_THREADS]], "the click reached Chickpea's own app, and the Agent still greets as its own bot");
}, { notMemberOf: { [AGENT_BOT]: ['C2'] }, refuse: { [`conversations.join ${AGENT_BOT}`]: 'missing_scope' } }));

test("Chickpea's in-Slack Add that leaves the app's bot out tells the person how to add it", async (t) => withHarness(t, async (h) => {
  t.mock.method(console, 'warn', () => undefined);
  assert.equal((await h.deliverToChickpea(addClick('C2', 'agent_support'), 'interactions')).status, 200);
  assert.deepEqual(await ephemeralNotes(h), ["To let @support answer here, add it from the channel's Add people or agents."]);
  assert.equal((await h.stores.config.listAgentChannelGrants(TEAM, 'C2'))[0]?.status, 'active');
  assert.deepEqual(slackPosts(h, 'chat.postMessage'), []);
}, {
  notMemberOf: { [AGENT_BOT]: ['C2'] },
  refuse: { [`conversations.invite ${MAIN_BOT}`]: 'missing_scope', [`conversations.join ${AGENT_BOT}`]: 'missing_scope' },
}));

test("the Owner's App Home offers no Agent its own Slack app, with or without the user-group permission", async (t) => withHarness(t, async (h) => {
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
  assert.equal(missing.includes('one more Slack permission'), false);
  assert.equal(missing.includes(escapeMrkdwn('Give @finance its own Slack app')), false);

  await writeHostedSlackBotCredentials({ state: h.stores.identity, keyring: loadCredentialKeyring() }, h.hostedRevision, {
    botToken: MAIN_BOT, botUserId: 'UBOT', appId: MAIN_APP.appId, teamId: TEAM,
    grantedScopes: ['chat:write', 'users:read'], validatedAt: Date.now(), userGroupToken: 'xoxp-owner-user-group',
  });
  invalidateSlackInstallationCredentialCache();
  const held = await home();
  assert.equal(held.includes(escapeMrkdwn('Give @finance its own Slack app')), false, 'starting is in Admin');
  assert.equal(held.includes('one more Slack permission'), false);
}));

/** A person's reply in a thread of their DM with Chickpea's own app, as Chickpea's app hears it. */
function chickpeaDmReply(root: string, ts: string) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    type: 'event_callback', event_id: `EvDm${ts}`, event_time: now, team_id: TEAM, api_app_id: MAIN_APP.appId,
    authorizations: [{ team_id: TEAM, user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
    event: { type: 'message', channel: CHICKPEA_DM, channel_type: 'im', user: 'U1', text: 'and the refunds?', ts, event_ts: ts, thread_ts: root },
  };
}

/** A reply with no mention in a #C1 thread Support owns, as Chickpea's app hears it. */
function channelThreadReply(root: string, ts: string) {
  const heard = channelMessage(ts, 'and the refunds?').chickpea;
  return { ...heard, event: { ...heard.event, thread_ts: root } };
}

/** Admits one turn of Support in the thread `root` owns, heard by Chickpea's app, and returns it. */
async function admitSupportTurn(h: Harness, channelId: string, root: string, ts: string): Promise<PendingTurnJob> {
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId, threadTs: root, agentId: 'agent_support', agentGeneration: 1 });
  const event = channelId === CHICKPEA_DM ? chickpeaDmReply(root, ts) : channelThreadReply(root, ts);
  assert.equal((await h.deliverToChickpea(event)).status, 200);
  const job = await pendingTurn(h.stores, (pending) => pending.turn.messageTs === ts);
  assert.ok(job, 'the reply is a turn of Support');
  assert.equal(job.assignment.agentId, 'agent_support');
  return job;
}

/** Who a post or edit comes from: the bot token, and the name and picture it carries. */
function sender(call: SlackCall | undefined) {
  return call && { token: call.token, username: call.body.get('username'), picture: Boolean(call.body.get('icon_url')) };
}

const AS_SUPPORT = { token: MAIN_BOT, username: 'Support', picture: true };
const OWN_BOT = { token: AGENT_BOT, username: null, picture: false };

/** The run's own reply, as its executor posts one: the bot its resolver picks, checked for the place, under the owner its admission froze. */
async function postAsRun(h: Harness, job: PendingTurnJob): Promise<SlackCall | undefined> {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const resolve = withAgentAppExecution((workspaceId) => resolveSlackInstallationExecutionContext(workspaceId, env), env);
  const context = await resolve(TEAM, turnJobRunSpeaker(job));
  await verifySlackInstallationTurnAccess(context, job.turn);
  const before = h.calls.length;
  await deliverAgentFailureFinal(job.turn, job.assignment, context.client, env, undefined, {
    state: { getRunPresentation: async (runId) => h.stores.slackState.getRunPresentation!(runId) },
    runId: job.runId!,
    settingsStore: h.stores.settings,
  });
  return h.calls.slice(before).find((call) => call.method === 'chat.postMessage' || call.method === 'chat.startStream');
}

/** The bot tokens one read of #C2 by the run's reading tools used, other than Chickpea's identity check. */
async function readingTokens(h: Harness, job: PendingTurnJob): Promise<Array<string | undefined>> {
  await h.stores.config.putChannel({ workspaceId: TEAM, channelId: 'C2', label: 'refunds', lifecycle: 'active' }, 0).catch(() => undefined);
  if (!(await h.stores.config.listAgentChannelGrants(TEAM, 'C2')).some((grant) => grant.agentId === 'agent_support')) {
    await h.stores.config.putAgentChannelGrant({
      workspaceId: TEAM, channelId: 'C2', agentId: 'agent_support', status: 'active',
      createdByMembershipId: h.ownerMembershipId, channelLabel: 'refunds', channelIsPrivate: false,
    }, 0);
  }
  const service = await slackReadingService({ agentId: 'agent_support', actorMembershipId: h.ownerMembershipId }, {
    agentId: 'agent_support', workspaceId: TEAM, channelId: job.turn.channelId, threadTs: job.turn.threadTs,
    conversationKind: job.turn.channelType === 'im' ? 'im' : 'channel', slackUserId: 'U1', eventId: job.turn.eventId,
    messageTs: job.turn.messageTs, turnJobId: job.id,
  }, withHostedSlackApp(h.base, MAIN_APP));
  const before = h.calls.length;
  await service.readChannel({ target: { channelId: 'C2' } }).catch(() => undefined);
  return [...new Set(h.calls.slice(before).filter((call) => call.method !== 'auth.test').map((call) => call.token))];
}

function personaOnAppToken(h: Harness): SlackCall[] {
  return h.calls.filter((call) => call.token === AGENT_BOT && call.method.startsWith('chat.') &&
    (call.body.has('username') || call.body.has('icon_url')));
}

test("a live app Agent's reply in a thread in Chickpea's DM posts with Chickpea's token under the Agent's name and picture", async (t) => withHarness(t, async (h) => {
  const job = await admitSupportTurn(h, CHICKPEA_DM, '1900003000.000100', '1900003000.000200');
  assert.deepEqual(job.turn.speaker, { kind: 'chickpea_as_agent' }, "Chickpea's bot heard it in its own DM, where the app's bot cannot post");
  assert.equal(job.turn.dmBotUserId, undefined, "no marker: Chickpea's DM");
  assert.deepEqual(sender(await postAsRun(h, job)), AS_SUPPORT);
  assert.deepEqual(await readingTokens(h, job), [MAIN_BOT], 'it reads the thread it answers in as the bot that answers');
}));

test("a live app Agent's turn in its own DM is marked with its bot, and posts and reads as that bot with no persona", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const job = await pendingTurn(h.stores, () => true);
  assert.ok(job);
  assert.equal(job.turn.dmBotUserId, AGENT_BOT_USER);
  assert.deepEqual(job.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  assert.deepEqual(sender(await postAsRun(h, job)), OWN_BOT);
  assert.deepEqual(await readingTokens(h, job), [AGENT_BOT]);
  assert.deepEqual(personaOnAppToken(h), []);
}));

test("a message in the app Agent's own DM that names its bot is its Agent's, answered as its bot", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', dmEvent({}, { text: `<@${AGENT_BOT_USER}> hello` }))).status, 200);
  const job = await pendingTurn(h.stores, () => true);
  assert.ok(job);
  assert.deepEqual([job.assignment.agentId, job.turn.speaker], ['agent_support', { kind: 'own_bot', botUserId: AGENT_BOT_USER }],
    'Slack sends a DM as a message whatever it mentions, and normalization reads one that names the bot as a mention');
}));

test("a live app Agent's reply in a Channel its bot is not in, where Chickpea's bot is, posts through Chickpea as the Agent instead of failing not_in_channel", async (t) => withHarness(t, async (h) => {
  const job = await admitSupportTurn(h, 'C1', '1900003100.000100', '1900003100.000200');
  assert.deepEqual(job.turn.speaker, { kind: 'chickpea_as_agent' });
  assert.deepEqual(
    h.calls.filter((call) => call.token === AGENT_BOT).map((call) => `${call.method} ${call.body.get('channel')}`),
    ['conversations.info C1'],
    "the app's bot is asked once, at admission, whether it is in the Channel",
  );
  assert.deepEqual(sender(await postAsRun(h, job)), AS_SUPPORT);
  assert.deepEqual(await readingTokens(h, job), [MAIN_BOT]);
}, { notMemberOf: { [AGENT_BOT]: ['C1'] } }));

test("a live app Agent's reply in a Channel its bot is in answers as its own bot, even when Chickpea's bot heard it", async (t) => withHarness(t, async (h) => {
  const job = await admitSupportTurn(h, 'C1', '1900003200.000100', '1900003200.000200');
  assert.deepEqual(job.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  const before = h.calls.length;
  assert.deepEqual(sender(await postAsRun(h, job)), OWN_BOT);
  assert.deepEqual(h.calls.slice(before).filter((call) => call.method === 'conversations.info').map((call) => call.token), [],
    "the run reuses admission's membership check instead of asking Slack again");
  assert.deepEqual(await readingTokens(h, job), [AGENT_BOT]);
  assert.deepEqual(personaOnAppToken(h), []);
}));

test('an Agent whose app is not live replies under its own name through Chickpea, not as plain Chickpea', async (t) => withHarness(t, async (h) => {
  const app = { appId: AGENT_APP, clientId: '1.client' };
  const states: Array<[string, () => Promise<void>]> = [
    ['waiting for Allow', () => setSupportApp(h, {
      state: 'awaiting_consent', at: Date.now(), startedBy: 'U1', app, icon: 'agent_avatar', allowDm: { channelId: 'DOWNER', ts: '1.1' },
    })],
    ['removed', () => setSupportApp(h, { state: 'needs_attention', at: Date.now(), startedBy: 'U1', reason: 'app_removed', resume: 'icon_set', app })],
    ['live with a token that cannot be opened', async () => {
      await setSupportApp(h, { state: 'active', at: h.installedAt, app, icon: 'agent_avatar', botUserId: AGENT_BOT_USER, installedAt: h.installedAt, installedBy: 'U1' });
      const stored = await readAppSecrets(h.secrets(), AGENT_APP);
      assert.ok(stored);
      await writeAppSecrets({ ...h.secrets(), keyring: generateCredentialKeyring('key_lost') }, AGENT_APP, 'agent_support', stored.secrets, stored.revision);
    }],
  ];
  let second = 0;
  for (const [name, put] of states) {
    await put();
    for (const channelId of [CHICKPEA_DM, 'C1']) {
      second += 1;
      const root = `19000033${String(second).padStart(2, '0')}.000100`;
      const job = await admitSupportTurn(h, channelId, root, root.replace(/100$/, '200'));
      assert.deepEqual(job.turn.speaker, { kind: 'chickpea_as_agent' }, `${name}, ${channelId}`);
      assert.deepEqual(sender(await postAsRun(h, job)), AS_SUPPORT, `${name}, ${channelId}`);
      assert.deepEqual(await readingTokens(h, job), [MAIN_BOT], `${name}, ${channelId}`);
    }
  }
  assert.deepEqual(personaOnAppToken(h), []);
}));

test('the speaker is decided once: the app bot joining after admission does not move the run off Chickpea, and an app token never carries a persona', async (t) => withHarness(t, async (h) => {
  const job = await admitSupportTurn(h, 'C1', '1900003400.000100', '1900003400.000200');
  assert.deepEqual(job.turn.speaker, { kind: 'chickpea_as_agent' });
  // Support's bot joins #C1 while the turn waits.
  await fetch('https://slack.com/api/conversations.join', {
    method: 'POST', headers: { authorization: `Bearer ${AGENT_BOT}` }, body: new URLSearchParams({ channel: 'C1' }),
  });
  clearAdmissionMembershipsForTests();
  assert.deepEqual(sender(await postAsRun(h, job)), AS_SUPPORT, 'the run posts with the bot its admission chose');

  const later = await admitSupportTurn(h, 'C1', '1900003400.000100', '1900003400.000300');
  assert.deepEqual(later.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER }, 'the next turn is admitted for the bot now there');
  assert.deepEqual(sender(await postAsRun(h, later)), OWN_BOT);
  assert.deepEqual(personaOnAppToken(h), []);
}, { notMemberOf: { [AGENT_BOT]: ['C1'] } }));

test('a card is redrawn by the bot that posted it', async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const spec = validatePresentCards({ caption: 'Refunds', cards: [{ title: 'Order 1', actions: [{ label: 'Refund' }, { label: 'Skip' }] }] });
  const redraw = async (job: PendingTurnJob) => {
    const now = Date.now();
    const surface: UiSurfaceRecord = {
      id: displaySurfaceId(job.id, 0), namespace: 'ui', workspaceId: TEAM, channelId: job.turn.channelId, threadTs: job.turn.threadTs,
      conversationThreadTs: job.turn.threadTs, conversationKind: job.turn.channelType === 'im' ? 'im' : 'channel', agentId: 'agent_support',
      turnJobId: job.id, requesterUserId: 'U1', spec: { kind: 'cards', cards: spec }, status: 'open', messageTs: '1900003500.000900',
      createdAt: now, updatedAt: now, expiresAt: now + 60_000,
    };
    const answerMessage = { ts: '1900003500.000900', text: 'Refunds', blocks: renderCards(spec, surface.id).blocks };
    const before = h.calls.length;
    assert.equal(await redrawCardSetAsAgent(env, 'agent_support', { ...surface, answerMessage }, job.id), true);
    return sender(h.calls.slice(before).find((call) => call.method === 'chat.update'));
  };
  const throughChickpea = await admitSupportTurn(h, CHICKPEA_DM, '1900003500.000100', '1900003500.000200');
  assert.deepEqual(await redraw(throughChickpea), { token: MAIN_BOT, username: null, picture: false },
    "a card Chickpea's bot posted is edited by Chickpea's bot");
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const own = await pendingTurn(h.stores, (pending) => pending.turn.channelId === 'D1');
  assert.ok(own);
  assert.deepEqual(await redraw(own), OWN_BOT, "a card the app's bot posted is edited by the app's bot");
}));

test("a run whose own bot can no longer post ends unavailable: nothing posts, not as plain Chickpea and not with a persona on the app's token", async (t) => withHarness(t, async (h) => {
  const job = await admitSupportTurn(h, 'C1', '1900003600.000100', '1900003600.000200');
  assert.deepEqual(job.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  await setSupportApp(h, { state: 'needs_attention', at: Date.now(), startedBy: 'U1', reason: 'app_removed', resume: 'icon_set', app: { appId: AGENT_APP, clientId: '1.client' } });
  const before = h.calls.length;
  await assert.rejects(() => postAsRun(h, job), (error: unknown) =>
    error instanceof SlackInstallationUnavailableError && error.reasonCode === 'agent_app_unavailable' && error.retryable === false);
  assert.deepEqual(h.calls.slice(before).filter((call) => call.method.startsWith('chat.')), []);
}));

test("without the port no app bot answers: an app Agent's reply in a Channel its bot is in answers through Chickpea under its name", async (t) => withHarness(t, async (h) => {
  configureAgentSlackApps(undefined);
  const job = await admitSupportTurn(h, 'C1', '1900003700.000100', '1900003700.000200');
  assert.deepEqual(job.turn.speaker, { kind: 'chickpea_as_agent' });
  assert.deepEqual(sender(await postAsRun(h, job)), AS_SUPPORT);
  assert.deepEqual(personaOnAppToken(h), []);
}));

test("a schedule made in the app Agent's own DM runs as the app's bot, and the app's token only opens that DM to find out", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  // The Owner made Support, so it is theirs to use in a DM.
  const agent = { ...await h.stores.config.getAgent('agent_support'), creatorMembershipId: h.ownerMembershipId };
  const destination = {
    kind: 'direct_thread' as const, conversationId: 'D1', threadTs: '1900003900.000100', ownerMembershipId: h.ownerMembershipId,
  };
  const routine: RoutineDefinition = {
    id: 'routine_own_dm', workspaceId: TEAM, channelId: 'D1', creatorUserId: 'U1', destination,
    name: 'Standup', description: '', taskText: 'Summarize.', triggerKind: 'schedule',
    scheduleInput: '0 * * * *', scheduleJson: '{"version":1,"kind":"cron","expression":"0 * * * *"}',
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_direct_member_v1',
    state: 'active', version: 1, nextRunAt: 1, lastScheduledAt: null, lastFinishedAt: null,
    consecutiveFailures: 0, lastChangeKeyHash: null, projectedDailyStarts: 24,
    reservationWindows: [{ windowStart: 1, count: 1 }], createdAt: 1, createdBy: 'U1',
    updatedAt: 1, updatedBy: 'U1', pausedAt: null, pausedBy: null, pausedReason: null,
    disabledAt: null, disabledBy: null, disabledReason: null, deletedAt: null, deletedBy: null,
  };
  const run = {
    id: 'rrun_own_dm', routineId: routine.id, status: 'admitting',
    revision: { name: routine.name, description: '', taskText: routine.taskText, triggerKind: 'schedule',
      scheduleInput: routine.scheduleInput, scheduleJson: routine.scheduleJson, timezone: 'UTC', outputPolicy: 'post',
      authorityMode: routine.authorityMode },
  } as unknown as RoutineRun;
  const authority = async (): Promise<ResolvedRoutineAuthority> => ({
    reference: {
      scheduleId: routine.id, agentId: agent.id, workspaceId: TEAM, channelId: 'D1', destinationKind: 'direct_thread',
      destinationBindingDigest: routineDestinationBindingDigest(routine.id, TEAM, destination),
      createdByMembershipId: h.ownerMembershipId, runsAsMembershipId: h.ownerMembershipId,
      authorityReceiptId: 'receipt_owner', requiredConnectionAccountIds: [], state: 'active',
      revision: 1, createdAt: 1, updatedAt: 1,
    },
    agent, agentGrants: [],
    assignment: {
      workspaceId: TEAM, channelId: 'D1', agentId: agent.id, agent,
      model: 'local-stub/agent-app', modelAttribution: { source: 'pinned', providerId: 'local-stub' },
    },
    actorSlackUserId: 'U1',
    effectiveConnections: [],
  } as ResolvedRoutineAuthority);
  const before = h.calls.length;
  // Only the authority is injected: the installation, the app's context and the DM question are the defaults.
  const access = await resolveRoutineRuntimeAccess(run, routine, env, { authority });
  assert.deepEqual(access.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  assert.deepEqual(dmQuestions(h, AGENT_BOT, before), ['conversations.open U1'], "the app's token only opened its DM with the Owner");
}));

/** A person's message in `channel` as each bot hears it; `G…` is a group DM, `thread` a reply under that root. */
function messageIn(channel: string, ts: string, text: string, thread?: string) {
  const now = Math.floor(Date.now() / 1_000);
  const heard = (type: 'message' | 'app_mention', appId: string, botUserId: string) => ({
    type: 'event_callback', event_id: `Ev${type}${channel}${ts}`, event_time: now, team_id: TEAM, api_app_id: appId,
    authorizations: [{ team_id: TEAM, user_id: botUserId, is_bot: true, is_enterprise_install: false }],
    event: {
      type, channel, user: 'U1', text, ts, event_ts: ts,
      ...(type === 'message' ? { channel_type: channel.startsWith('G') ? 'mpim' : 'channel' } : {}),
      ...(thread ? { thread_ts: thread } : {}),
    },
  });
  return { chickpea: heard('message', MAIN_APP.appId, 'UBOT'), app: heard('app_mention', AGENT_APP, AGENT_BOT_USER) };
}

/** Every queued turn on one message, as [its Agent, the speaker its admission chose]. */
async function answersTo(h: Harness, ts: string): Promise<Array<[string, unknown]>> {
  return (await h.stores.slackState.listPendingTurns!())
    .filter((job) => job.turn.messageTs === ts)
    .map((job) => [job.assignment.agentId, job.turn.speaker]);
}

const SUPPORT_THROUGH_CHICKPEA = ['agent_support', { kind: 'chickpea_as_agent' }];
const SUPPORT_AS_ITS_BOT = ['agent_support', { kind: 'own_bot', botUserId: AGENT_BOT_USER }];

test("a mention of the app Agent's bot where both bots are in the Channel is answered once, by the app's own delivery, as its bot", async (t) => withHarness(t, async (h) => {
  for (const [ts, first] of [['1900004000.000100', 'chickpea'], ['1900004000.000200', 'app']] as const) {
    const message = messageIn('C1', ts, `<@${AGENT_BOT_USER}> where do refunds go?`);
    for (const ingress of first === 'app' ? ['app', 'chickpea'] : ['chickpea', 'app']) {
      if (ingress === 'chickpea') {
        assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
        if (first === 'chickpea') assert.deepEqual(await answersTo(h, ts), [], "Chickpea's delivery leaves it to the app, which can answer here");
      } else {
        assert.equal((await h.deliver('events', message.app)).status, 200);
      }
    }
    assert.deepEqual(await answersTo(h, ts), [SUPPORT_AS_ITS_BOT], `${first} heard first: one answer, from Support's own bot`);
  }
}));

test("a mention of the app Agent's bot in a Channel its bot is not in is routed by Chickpea, once, as the Agent", async (t) => withHarness(t, async (h) => {
  const root = '1900004100.000100';
  const message = messageIn('C1', root, `<@${AGENT_BOT_USER}> where do refunds go?`);
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  assert.deepEqual(await answersTo(h, root), [SUPPORT_THROUGH_CHICKPEA], 'a root message naming only the bot is a turn of its Agent');
  assert.equal((await h.stores.config.getAgentThreadRoute(TEAM, 'C1', root))?.agentId, 'agent_support');
  const [job] = (await h.stores.slackState.listPendingTurns!()).filter((pending) => pending.turn.messageTs === root);
  assert.deepEqual(sender(await postAsRun(h, job!)), AS_SUPPORT, "Chickpea's bot posts under Support's name and picture");
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  assert.deepEqual(await answersTo(h, root), [SUPPORT_THROUGH_CHICKPEA], "Slack's retry adds nothing");

  const reply = '1900004200.000200';
  assert.equal((await h.deliverToChickpea(messageIn('C1', reply, `<@${AGENT_BOT_USER}> and this one?`, '1900004200.000100').chickpea)).status, 200);
  assert.deepEqual(await answersTo(h, reply), [SUPPORT_THROUGH_CHICKPEA], 'so is a mention in a thread no Agent owns yet');
  assert.deepEqual(h.calls.filter((call) => call.token === AGENT_BOT && call.method === 'conversations.info').length, 1,
    "the app's bot is asked once whether it is in the Channel, and the answer is reused");
}, { notMemberOf: { [AGENT_BOT]: ['C1'] } }));

test("a mention of the app Agent's bot is routed by Chickpea when the app is not live, or its token cannot be read, though its bot is in the Channel", async (t) => withHarness(t, async (h) => {
  const app = { appId: AGENT_APP, clientId: '1.client' };
  const states: Array<[string, () => Promise<void>]> = [
    ['needing attention', () => setSupportApp(h, {
      state: 'needs_attention', at: Date.now(), startedBy: 'U1', reason: 'app_removed', resume: 'icon_set', app, botUserId: AGENT_BOT_USER,
    })],
    ['live with a token that cannot be opened', async () => {
      await setSupportApp(h, { state: 'active', at: h.installedAt, app, icon: 'agent_avatar', botUserId: AGENT_BOT_USER, installedAt: h.installedAt, installedBy: 'U1' });
      const stored = await readAppSecrets(h.secrets(), AGENT_APP);
      assert.ok(stored);
      await writeAppSecrets({ ...h.secrets(), keyring: generateCredentialKeyring('key_lost') }, AGENT_APP, 'agent_support', stored.secrets, stored.revision);
    }],
  ];
  for (const [index, [name, put]] of states.entries()) {
    await put();
    const ts = `190000430${index}.000100`;
    assert.equal((await h.deliverToChickpea(messageIn('C1', ts, `<@${AGENT_BOT_USER}> where do refunds go?`).chickpea)).status, 200);
    assert.deepEqual(await answersTo(h, ts), [SUPPORT_THROUGH_CHICKPEA], name);
  }
}));

/** Slack calls rate-limited for now, keyed `<method> <token>`; a test lifts the limit by emptying it. */
const appReadLimited: string[] = [];

test("a mention of the app Agent's bot is routed by Chickpea while Slack rate-limits the app bot's membership read, and answered once", async (t) => withHarness(t, async (h) => {
  const ts = '1900004350.000100';
  const message = messageIn('C1', ts, `<@${AGENT_BOT_USER}> where do refunds go?`);
  appReadLimited.push(`conversations.info ${AGENT_BOT}`);
  t.after(() => { appReadLimited.length = 0; });
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  assert.deepEqual(await answersTo(h, ts), [SUPPORT_THROUGH_CHICKPEA], 'a read that failed counts as the app being unable to answer here');
  const [job] = (await h.stores.slackState.listPendingTurns!()).filter((pending) => pending.turn.messageTs === ts);
  assert.deepEqual(sender(await postAsRun(h, job!)), AS_SUPPORT, "Chickpea's bot posts under Support's name and picture");

  appReadLimited.length = 0;
  t.mock.method(console, 'info', () => undefined);
  assert.equal((await h.deliver('events', message.app)).status, 200);
  assert.deepEqual(await answersTo(h, ts), [SUPPORT_THROUGH_CHICKPEA], "the app's own delivery of the same message adds no second answer");
}, { rateLimited: appReadLimited }));

test('a mention both deliveries route, the app having become able to answer between them, is answered once', async (t) => withHarness(t, async (h) => {
  const ts = '1900004400.000100';
  const message = messageIn('C1', ts, `<@${AGENT_BOT_USER}> where do refunds go?`);
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  await fetch('https://slack.com/api/conversations.join', {
    method: 'POST', headers: { authorization: `Bearer ${AGENT_BOT}` }, body: new URLSearchParams({ channel: 'C1' }),
  });
  clearAdmissionMembershipsForTests();
  t.mock.method(console, 'info', () => undefined);
  assert.equal((await h.deliver('events', message.app)).status, 200);
  assert.deepEqual(await answersTo(h, ts), [SUPPORT_THROUGH_CHICKPEA], "the message's claim keeps one answer");
}, { notMemberOf: { [AGENT_BOT]: ['C1'] } }));

test("a mention of the app Agent's bot in a group DM both bots are in is answered once, by the app's own delivery, as its bot", async (t) => withHarness(t, async (h) => {
  for (const [ts, first] of [['1900004500.000100', 'chickpea'], ['1900004500.000200', 'app']] as const) {
    const message = messageIn('G1', ts, `<@${AGENT_BOT_USER}> where do refunds go?`);
    for (const ingress of first === 'app' ? ['app', 'chickpea'] : ['chickpea', 'app']) {
      if (ingress === 'chickpea') {
        assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
        if (first === 'chickpea') assert.deepEqual(await answersTo(h, ts), [], "Chickpea's delivery leaves it to the app, which can answer here");
      } else {
        assert.equal((await h.deliver('events', message.app)).status, 200);
      }
    }
    assert.deepEqual(await answersTo(h, ts), [SUPPORT_AS_ITS_BOT], `${first} heard first: one answer, from Support's own bot`);
    const [job] = (await h.stores.slackState.listPendingTurns!()).filter((pending) => pending.turn.messageTs === ts);
    assert.deepEqual(sender(await postAsRun(h, job!)), OWN_BOT);
  }
  assert.deepEqual(personaOnAppToken(h), []);
}));

test("a mention of the app Agent's bot in a group DM only Chickpea's bot is in is routed by Chickpea and answered under the Agent's name", async (t) => withHarness(t, async (h) => {
  const ts = '1900004550.000100';
  assert.equal((await h.deliverToChickpea(messageIn('G1', ts, `<@${AGENT_BOT_USER}> where do refunds go?`).chickpea)).status, 200);
  assert.deepEqual(await answersTo(h, ts), [SUPPORT_THROUGH_CHICKPEA]);
  const [job] = (await h.stores.slackState.listPendingTurns!()).filter((pending) => pending.turn.messageTs === ts);
  assert.deepEqual(sender(await postAsRun(h, job!)), AS_SUPPORT);
  assert.deepEqual(personaOnAppToken(h), []);
}, { notMemberOf: { [AGENT_BOT]: ['G1'] } }));

test("a mention of the app Agent's bot in a group DM neither bot is in produces nothing", async (t) => withHarness(t, async (h) => {
  const ts = '1900004600.000100';
  const message = messageIn('G2', ts, `<@${AGENT_BOT_USER}> where do refunds go?`);
  assert.equal((await h.deliverToChickpea(message.chickpea)).status, 200);
  assert.equal((await h.deliver('events', message.app, { settle: true })).status, 200);
  assert.deepEqual(await answersTo(h, ts), [], 'no turn');
  assert.deepEqual(h.calls.filter((call) => call.method.startsWith('chat.')), [], 'and nothing is posted');
}, { notMemberOf: { [MAIN_BOT]: ['G2'], [AGENT_BOT]: ['G2'] } }));

/** A Finance thread in #C1, and the reply under its root that Slack keeps. */
async function financeThread(h: Harness, root: string): Promise<void> {
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'C1', threadTs: root, agentId: 'agent_finance', agentGeneration: 1 });
}

/** An event as the app's own delivery would hear it, were it ever subscribed to it. */
function heardByApp(event: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    type: 'event_callback', event_id: `EvApp${String(event.ts ?? event.event_ts)}`, event_time: now, team_id: TEAM, api_app_id: AGENT_APP,
    authorizations: [{ team_id: TEAM, user_id: AGENT_BOT_USER, is_bot: true, is_enterprise_install: false }],
    event: { channel: 'C1', channel_type: 'channel', user: 'U1', ...event },
  };
}

test("the app's delivery selects its Agent only for its own mention or DM: any other event routes as on Chickpea's", async (t) => withHarness(t, async (h) => {
  const root = '1900004700.000100';
  await financeThread(h, root);
  const reply = '1900004700.000200';
  assert.equal((await h.deliver('events', heardByApp({ type: 'message', text: 'and the refunds?', ts: reply, event_ts: reply, thread_ts: root }))).status, 200);
  assert.deepEqual((await answersTo(h, reply)).map(([agentId]) => agentId), ['agent_finance'], "a plain reply in Finance's thread is Finance's");
  assert.equal((await h.stores.config.getAgentThreadRoute(TEAM, 'C1', root))?.agentId, 'agent_finance', 'and Finance keeps the thread');

  const groupRoot = '1900004800.000100';
  assert.equal((await h.deliver('events', heardByApp({ type: 'message', text: '<!subteam^SFINANCE|@finance> refunds?', ts: groupRoot, event_ts: groupRoot }))).status, 200);
  assert.deepEqual((await answersTo(h, groupRoot)).map(([agentId]) => agentId), ['agent_finance'], "a message naming Finance's group is Finance's");

  const reacted = '1900004700.000300';
  assert.equal((await h.deliver('events', heardByApp({
    type: 'reaction_added', reaction: 'eyes', event_ts: reacted, item: { type: 'message', channel: 'C1', ts: root },
  }))).status, 200);
  assert.equal((await answersTo(h, reacted)).some(([agentId]) => agentId === 'agent_support'), false, "a reaction in Finance's thread is not Support's");
  assert.equal((await h.stores.config.getAgentThreadRoute(TEAM, 'C1', root))?.agentId, 'agent_finance');
}, { replies: [{ ts: '1900004700.000100', thread_ts: '1900004700.000100', user: 'U1', text: 'What did we refund?' }] }));

const CHICKPEA_JOINED = 'Chickpea joined too, so replies in my threads reach me without a mention.';

test("a person's Slack Add of the Agent's bot to a public Channel brings Chickpea's bot too, and the welcome says so", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', joinEvent())).status, 200);
  assert.deepEqual((await h.stores.config.listAgentChannelGrants(TEAM, 'C2')).map(({ agentId, status }) => [agentId, status]), [['agent_support', 'active']]);
  assert.deepEqual(h.calls.filter((call) => call.method === 'conversations.join').map((call) => [call.token, call.body.get('channel')]),
    [[MAIN_BOT, 'C2']], "Chickpea's bot joins with its own token");
  assert.deepEqual(slackPosts(h, 'chat.postMessage').map((body) => [body.get('channel'), body.get('text')]),
    [['C2', `${SUPPORT_WELCOME}. ${CHICKPEA_JOINED}`]]);
}, { notMemberOf: { [MAIN_BOT]: ['C2'] } }));

test("the same Slack Add by someone who may not add the Agent grants nothing, and Chickpea's bot stays out", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', joinEvent({ inviter: 'U2' }))).status, 200);
  assert.deepEqual(await h.stores.config.listAgentChannelGrants(TEAM, 'C2'), []);
  assert.deepEqual(h.calls.filter((call) => call.method === 'conversations.join'), []);
}, { notMemberOf: { [MAIN_BOT]: ['C2'] } }));

test("a Slack Add of the Agent's bot to a private Channel grants it, and Chickpea's bot stays out", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', joinEvent())).status, 200);
  assert.deepEqual((await h.stores.config.listAgentChannelGrants(TEAM, 'C2')).map(({ status }) => status), ['active']);
  assert.deepEqual(h.calls.filter((call) => call.method === 'conversations.join'), []);
  assert.equal(slackPosts(h, 'chat.postMessage').some((body) => body.get('text')?.includes(CHICKPEA_JOINED)), false);
}, { privateChannels: ['C2'], notMemberOf: { [MAIN_BOT]: ['C2'] } }));

test("without the port no app answers, so a reply naming its bot in Finance's thread is Finance's, and the app's token is never used", async (t) => withHarness(t, async (h) => {
  configureAgentSlackApps(undefined);
  const root = '1900004900.000100';
  await financeThread(h, root);
  const reply = '1900004900.000200';
  assert.equal((await h.deliverToChickpea(messageIn('C1', reply, `<@${AGENT_BOT_USER}> and the refunds?`, root).chickpea)).status, 200);
  assert.deepEqual((await answersTo(h, reply)).map(([agentId]) => agentId), ['agent_finance']);
  assert.deepEqual(h.calls.filter((call) => call.token === AGENT_BOT), []);
}));

const SETUP_NOTE = 'Chickpea note, not typed by Owner: Owner saved the key for Tasks on its setup page.';

function setupWake(channelId: string, threadTs: string, setupOperationId: string, agentId = 'agent_support') {
  return {
    setupOperationId, workspaceId: TEAM, channelId, threadTs, notice: '✅ Tasks is now connected to Support.',
    wake: { agentId, slackUserId: 'U1', conversationKind: 'im' as const, note: SETUP_NOTE },
  };
}

/** The calls an Agent app's token made that a DM place needed: reading a DM, or opening one. */
function dmQuestions(h: Harness, token: string, from = 0): string[] {
  return h.calls.slice(from).filter((call) => call.token === token &&
    ((call.method === 'conversations.info' && call.body.get('channel')?.startsWith('D')) || call.method === 'conversations.open'))
    .map((call) => `${call.method} ${call.body.get('channel') ?? call.body.get('users')}`);
}

test("a setup's wake in the app Agent's own DM is that app's DM, and its reply posts as the app's bot", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const asked = await pendingTurn(h.stores, (job) => job.turn.channelId === 'D1');
  assert.ok(asked);
  assert.equal(await admitSetupWake(setupWake('D1', asked.turn.threadTs, 'setup_tasks'), env, { stores: h.stores }), 'queued');
  const woken = await pendingTurn(h.stores, (job) => job.id === setupWakeTurnJobId('D1', 'setup_tasks'));
  assert.ok(woken, 'the wake is queued in the thread it asked from');
  assert.equal(woken.turn.dmBotUserId, AGENT_BOT_USER, "the app's DM with the Owner is this one, so it is the app's own");
  assert.deepEqual(woken.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  assert.deepEqual(sender(await postAsRun(h, woken)), OWN_BOT);
  assert.deepEqual(dmQuestions(h, AGENT_BOT), ['conversations.open U1'], "the app's token only opened its DM with the Owner");
}));

test("a setup's wake in Chickpea's DM posts through Chickpea under the Agent's name, and the app's token never reads the DM", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const inChickpeaDm = await admitSupportTurn(h, CHICKPEA_DM, '1900003800.000100', '1900003800.000200');
  const before = h.calls.length;
  assert.equal(await admitSetupWake(setupWake(CHICKPEA_DM, inChickpeaDm.turn.threadTs, 'setup_other'), env, { stores: h.stores }), 'queued');
  const throughChickpea = await pendingTurn(h.stores, (job) => job.id === setupWakeTurnJobId(CHICKPEA_DM, 'setup_other'));
  assert.ok(throughChickpea);
  assert.equal(throughChickpea.turn.dmBotUserId, undefined, "the app's DM with the Owner is another one");
  assert.deepEqual(throughChickpea.turn.speaker, { kind: 'chickpea_as_agent' });
  assert.deepEqual(sender(await postAsRun(h, throughChickpea)), AS_SUPPORT);
  assert.deepEqual(dmQuestions(h, AGENT_BOT, before), ['conversations.open U1']);
  assert.deepEqual(personaOnAppToken(h), []);
}));

test("a setup's wake whose DM Slack does not place is retried, and is never queued on a guessed bot", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const inChickpeaDm = await admitSupportTurn(h, CHICKPEA_DM, '1900003850.000100', '1900003850.000200');
  const before = h.calls.length;
  const error = t.mock.method(console, 'error', () => undefined);
  assert.equal(await admitSetupWake(setupWake(CHICKPEA_DM, inChickpeaDm.turn.threadTs, 'setup_limited'), env, { stores: h.stores }), 'refused',
    'a wake not admitted is refused, so its setup posts the notice instead');
  assert.deepEqual(dmQuestions(h, AGENT_BOT, before), ['conversations.open U1', 'conversations.open U1', 'conversations.open U1'],
    'each admission attempt asks Slack again; a failed answer is not kept');
  assert.equal((await h.stores.slackState.turnJobView!(setupWakeTurnJobId(CHICKPEA_DM, 'setup_limited')))?.status ?? 'missing', 'missing');
  assert.deepEqual(h.calls.slice(before).filter((call) => call.method.startsWith('chat.')), [], 'nothing posts on either bot');
  assert.ok(error.mock.calls.some(({ arguments: [line] }) => String(line).includes('agent turn was not admitted')));
}, { rateLimited: [`conversations.open ${AGENT_BOT}`] }));

test("a user-group Agent's setup wake in Chickpea's DM asks Slack nothing about the DM", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const root = '1900003870.000100';
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: CHICKPEA_DM, threadTs: root, agentId: 'agent_finance', agentGeneration: 1 });
  assert.equal((await h.deliverToChickpea(chickpeaDmReply(root, '1900003870.000200'))).status, 200);
  const before = h.calls.length;
  assert.equal(await admitSetupWake(setupWake(CHICKPEA_DM, root, 'setup_finance', 'agent_finance'), env, { stores: h.stores }), 'queued');
  const woken = await pendingTurn(h.stores, (job) => job.id === setupWakeTurnJobId(CHICKPEA_DM, 'setup_finance'));
  assert.deepEqual(woken?.turn.speaker, { kind: 'chickpea_as_agent' });
  assert.deepEqual(h.calls.slice(before).filter((call) => call.method === 'conversations.open' || call.token !== MAIN_BOT)
    .map((call) => `${call.method} ${call.token}`), [], "only Chickpea's own admission reads run, and no DM is opened");
}));

/** Finance gets its own live app too, so Support and Finance are teammates with an app each. */
async function giveFinanceApp(h: Harness): Promise<void> {
  const finance = await h.stores.config.getAgent('agent_finance');
  await h.stores.config.updateAgent(finance.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'finance', normalizedHandle: 'finance', desiredState: 'active', health: 'healthy',
      avatar: finance.slackPresence!.avatar, released: { userGroupId: 'SFINANCE' },
      app: {
        state: 'active', at: h.installedAt, app: { appId: FINANCE_APP, clientId: '2.client' }, icon: 'agent_avatar',
        botUserId: FINANCE_BOT_USER, installedAt: h.installedAt, installedBy: 'U1',
      },
    },
  }, finance.revision);
  await writeAppSecrets(h.secrets(), FINANCE_APP, finance.id, { clientSecret: 'client-secret-2', signingSecret: 'signing-2', botToken: FINANCE_BOT }, null);
}

test("a teammate with its own app, asked inside another Agent's own DM, never gets its own app's token for that DM", async (t) => withHarness(t, async (h) => {
  await giveFinanceApp(h);
  const env = withHostedSlackApp(h.base, MAIN_APP);
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const asking = await pendingTurn(h.stores, (job) => job.turn.channelId === 'D1' && job.assignment.agentId === 'agent_support');
  assert.ok(asking);
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'D1', threadTs: asking.turn.threadTs, agentId: 'agent_support', agentGeneration: 1 });
  // In a DM only an Agent that has answered in the thread can be asked there.
  await recordDeliveredSlackAgentMessage(
    h.stores.config,
    { workspaceId: TEAM, channelId: 'D1', threadTs: asking.turn.threadTs } as NormalizedSlackTurn,
    { runtimeContract: 'chickpea-v1', agentId: 'agent_finance' },
    { messageTs: '1900003900.000100', text: 'Q2 revenue was 1.1M.' },
  );
  // As a runner from before the host refused asks in an app's DM hands one over: without the DM's bot.
  const { dmBotUserId: _heardBy, ...handedOver } = asking.turn;
  await processSlackAgentAsks({
    turn: handedOver, fromAgentId: 'agent_support', fromThreadOwner: true,
    deliveries: [{ messageTs: '1900003900.000200', text: `Let me check. <@${FINANCE_BOT_USER}> what was Q3 revenue?` }],
  }, env, { stores: h.stores });
  const asked = await pendingTurn(h.stores, (job) => job.assignment.agentId === 'agent_finance');
  assert.ok(asked, 'Finance is asked in the thread');
  assert.equal(asked.turn.dmBotUserId, undefined);
  assert.notEqual(asked.turn.speaker?.kind, 'own_bot', "Support's DM is not Finance's own");
  await postAsRun(h, asked).catch(() => undefined);
  assert.deepEqual(
    h.calls.filter((call) => call.token === FINANCE_BOT).map((call) => `${call.method} ${call.body.get('channel') ?? call.body.get('users')}`),
    ['conversations.open U1'],
    "Finance's token only opened its own DM with the Owner, which is not this one",
  );
}));

test("a mention the app's own bot heard in a group DM it is in answers as that bot, with no persona", async (t) => withHarness(t, async (h) => {
  const now = Math.floor(Date.now() / 1_000);
  const ts = `${now}.000300`;
  assert.equal((await h.deliver('events', dmEvent({ event_id: `EvMpim${now}` }, {
    type: 'app_mention', channel: 'G1', channel_type: 'mpim', text: `<@${AGENT_BOT_USER}> hello`, ts, event_ts: ts,
  }))).status, 200);
  const job = await pendingTurn(h.stores, (pending) => pending.turn.channelId === 'G1');
  assert.ok(job, 'the mention is a turn of Support');
  assert.deepEqual(job.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  assert.deepEqual(sender(await postAsRun(h, job)), OWN_BOT);
  assert.deepEqual(personaOnAppToken(h), []);
}));

/** Admits one turn of `agentId` in the #C1 thread `root`, heard by Chickpea's app, and returns it. */
async function admitChannelTurnOf(h: Harness, agentId: string, root: string, ts: string): Promise<PendingTurnJob> {
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'C1', threadTs: root, agentId, agentGeneration: 1 });
  assert.equal((await h.deliverToChickpea(channelThreadReply(root, ts))).status, 200);
  const job = await pendingTurn(h.stores, (pending) => pending.turn.messageTs === ts);
  assert.ok(job, `the reply is a turn of ${agentId}`);
  assert.equal(job.assignment.agentId, agentId);
  return job;
}

test("Chickpea's bot whose membership admission could not verify answers as the Agent, for user-group and app Agents alike, and the run's access check decides", async (t) => withHarness(t, async (h) => {
  const finance = await admitChannelTurnOf(h, 'agent_finance', '1900004000.000100', '1900004000.000200');
  assert.equal(finance.turn.channelMembership, undefined, 'a Channel shared from another workspace is not verified at admission');
  assert.deepEqual(finance.turn.speaker, { kind: 'chickpea_as_agent' }, 'a user-group Agent, as before this change');
  const support = await admitChannelTurnOf(h, 'agent_support', '1900004100.000100', '1900004100.000200');
  assert.deepEqual(support.turn.speaker, { kind: 'chickpea_as_agent' }, "an app Agent whose bot is not there, through Chickpea's bot");
}, { sharedFrom: ['C1'], notMemberOf: { [AGENT_BOT]: ['C1'] } }));

test("a failed read of the run's turn row fails its reading tool and its card redraw, and never switches to the app's bot", async (t) => withHarness(t, async (h) => {
  const job = await admitSupportTurn(h, CHICKPEA_DM, '1900004200.000100', '1900004200.000200');
  assert.deepEqual(job.turn.speaker, { kind: 'chickpea_as_agent' });
  const state = h.stores.slackState as { turnJobView: (id: string) => Promise<unknown> };
  const turnJobView = state.turnJobView;
  state.turnJobView = async () => { throw new Error('state store unreachable'); };
  t.after(() => { state.turnJobView = turnJobView; });
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const before = h.calls.length;
  const service = await slackReadingService({ agentId: 'agent_support', actorMembershipId: h.ownerMembershipId }, {
    agentId: 'agent_support', workspaceId: TEAM, channelId: CHICKPEA_DM, threadTs: job.turn.threadTs, conversationKind: 'im',
    slackUserId: 'U1', eventId: job.turn.eventId, messageTs: job.turn.messageTs, turnJobId: job.id,
  }, env).catch((error: unknown) => error);
  assert.ok(service instanceof SlackReadError && service.code === 'unavailable', 'the reading tool says it cannot read now');
  const spec = validatePresentCards({ caption: 'Refunds', cards: [{ title: 'Order 1', actions: [{ label: 'Refund' }] }] });
  const now = Date.now();
  const surface: UiSurfaceRecord = {
    id: displaySurfaceId(job.id, 0), namespace: 'ui', workspaceId: TEAM, channelId: CHICKPEA_DM, threadTs: job.turn.threadTs,
    conversationThreadTs: job.turn.threadTs, conversationKind: 'im', agentId: 'agent_support', turnJobId: job.id, requesterUserId: 'U1',
    spec: { kind: 'cards', cards: spec }, status: 'open', messageTs: '1900004200.000900', createdAt: now, updatedAt: now, expiresAt: now + 60_000,
  };
  await assert.rejects(() => redrawCardSetAsAgent(env, 'agent_support', surface, job.id), /state store unreachable/);
  assert.deepEqual(h.calls.slice(before).filter((call) => call.token === AGENT_BOT), [], "the app's token is never tried");
}));

test("a card whose run has finished is redrawn with this run's bot: the same bot edits it, another bot is refused by Slack", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const spec = validatePresentCards({ caption: 'Refunds', cards: [{ title: 'Order 1', actions: [{ label: 'Refund' }, { label: 'Skip' }] }] });
  /** The card `posting`'s run posted with `token`, then that run finishes. */
  const finishedCard = async (posting: PendingTurnJob, token: string): Promise<UiSurfaceRecord> => {
    const id = displaySurfaceId(posting.id, 0);
    const blocks = renderCards(spec, id).blocks;
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: new URLSearchParams({ channel: 'C1', thread_ts: posting.turn.threadTs, text: 'Refunds', blocks: JSON.stringify(blocks) }),
    });
    const { ts } = await response.json() as { ts: string };
    await h.stores.slackState.markTurnDelivered!(posting.id);
    const now = Date.now();
    return {
      id, namespace: 'ui', workspaceId: TEAM, channelId: 'C1', threadTs: posting.turn.threadTs, conversationThreadTs: posting.turn.threadTs,
      conversationKind: 'channel', agentId: 'agent_support', turnJobId: posting.id, requesterUserId: 'U1', spec: { kind: 'cards', cards: spec },
      status: 'open', messageTs: ts, createdAt: now, updatedAt: now, expiresAt: now + 60_000, answerMessage: { ts, text: 'Refunds', blocks },
    };
  };
  const redraw = async (surface: UiSurfaceRecord, from: PendingTurnJob) => {
    const before = h.calls.length;
    const redrawn = await redrawCardSetAsAgent(env, 'agent_support', surface, from.id);
    return [redrawn, h.calls.slice(before).filter((call) => call.method === 'chat.update').map((call) => call.token)] as const;
  };
  const root = '1900004300.000100';
  const throughChickpea = await admitSupportTurn(h, 'C1', root, '1900004300.000200');
  assert.deepEqual(throughChickpea.turn.speaker, { kind: 'chickpea_as_agent' });
  const chickpeaCard = await finishedCard(throughChickpea, MAIN_BOT);
  const sameBot = await admitSupportTurn(h, 'C1', root, '1900004300.000300');
  assert.deepEqual(await redraw(chickpeaCard, sameBot), [true, [MAIN_BOT]], "this run's bot posted it, so the edit lands");

  // Support's bot joins #C1 before the next turn, so that turn answers as the app's bot.
  await fetch('https://slack.com/api/conversations.join', {
    method: 'POST', headers: { authorization: `Bearer ${AGENT_BOT}` }, body: new URLSearchParams({ channel: 'C1' }),
  });
  clearAdmissionMembershipsForTests();
  const ownBot = await admitSupportTurn(h, 'C1', root, '1900004300.000400');
  assert.deepEqual(ownBot.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  assert.deepEqual(await redraw(chickpeaCard, ownBot), [false, [AGENT_BOT]],
    "the other bot tries the edit, Slack refuses it, and the card stays as it was");
}, { notMemberOf: { [AGENT_BOT]: ['C1'] } }));

test("a turn Chickpea builds in a Channel its bot is not in answers as the app's bot when that bot is there, and has no speaker when neither is", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const root = '1900004400.000100';
  await h.stores.config.putAgentThreadRoute({ workspaceId: TEAM, channelId: 'C1', threadTs: root, agentId: 'agent_support', agentGeneration: 1 });
  const wake = async (setupOperationId: string) => {
    const request = { ...setupWake('C1', root, setupOperationId), wake: { ...setupWake('C1', root, setupOperationId).wake, conversationKind: 'channel' as const } };
    assert.equal(await admitSetupWake(request, env, { stores: h.stores }), 'queued');
    const job = await pendingTurn(h.stores, (pending) => pending.id === setupWakeTurnJobId('C1', setupOperationId));
    assert.ok(job);
    return job;
  };
  assert.deepEqual((await wake('setup_neither')).turn.speaker, { kind: 'unavailable', reason: 'no_bot_can_post' },
    "Slack said Chickpea's bot is not in the Channel, and the app's bot is not either");
  await fetch('https://slack.com/api/conversations.join', {
    method: 'POST', headers: { authorization: `Bearer ${AGENT_BOT}` }, body: new URLSearchParams({ channel: 'C1' }),
  });
  clearAdmissionMembershipsForTests();
  const own = await wake('setup_app_bot');
  assert.deepEqual(own.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  assert.deepEqual(sender(await postAsRun(h, own)), OWN_BOT);
}, { notMemberOf: { [MAIN_BOT]: ['C1'], [AGENT_BOT]: ['C1'] } }));

/** Support back on its user group with its app's record attached and not live, as while the app waits for Allow. */
async function attachSupportApp(h: Harness): Promise<void> {
  const support = await h.stores.config.getAgent('agent_support');
  await h.stores.config.updateAgent(support.id, {
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: support.slackPresence!.avatar, userGroupId: 'SSUPPORT',
      app: {
        state: 'awaiting_consent', at: Date.now(), startedBy: 'U1', app: { appId: AGENT_APP, clientId: '1.client' },
        icon: 'agent_avatar', allowDm: { channelId: 'DOWNER', ts: '1.1' },
      },
    },
  }, support.revision);
}

/** The Agents a Channel message Chickpea's bot heard was admitted for. */
async function admittedFor(h: Harness, ts: string, text: string): Promise<string[]> {
  assert.equal((await h.deliverToChickpea(channelMessage(ts, text).chickpea)).status, 200);
  return (await h.stores.slackState.listPendingTurns!()).filter((job) => job.turn.messageTs === ts).map((job) => job.assignment.agentId);
}

// Defects caught: Slack's URL check finding apps by kind, so an app being created beside its group fails the check;
// a removal event acting on an app that is not live; and the attached record making the Agent answer as its app.
test("an app record attached to a user group is found by Slack's URL check, while the Agent routes, speaks and is listed as a user-group Agent", async (t) => withHarness(t, async (h) => {
  await attachSupportApp(h);
  const before = (await h.stores.config.getAgent('agent_support')).slackPresence;
  assert.deepEqual(await agentSlackAppIngress(h.base, AGENT_APP), { agentId: 'agent_support', teamId: TEAM, signingSecret: AGENT_SECRET });
  assert.equal(await agentAppBotCredentials(h.base, 'agent_support', AGENT_APP), undefined, 'the app does not speak for the Agent');
  assert.deepEqual(await h.stores.config.listAgentAppBots(), [], 'no bot of an app never allowed is listed');
  assert.equal(await endAgentSlackApp(h.base, AGENT_APP, dmEvent({}, { type: 'app_uninstalled' })), 'ignored',
    'Slack removing an app that is not live ends nothing');
  assert.deepEqual((await h.stores.config.getAgent('agent_support')).slackPresence, before);
  assert.equal((await readAppSecrets(h.secrets(), AGENT_APP))?.secrets.botToken, AGENT_BOT);

  const ts = '1900005000.000100';
  assert.deepEqual(await admittedFor(h, ts, '<!subteam^SSUPPORT|@support> what changed?'), ['agent_support'], 'its group still routes to it');
  const job = await pendingTurn(h.stores, (pending) => pending.turn.messageTs === ts);
  assert.ok(job);
  assert.deepEqual(job.turn.speaker, { kind: 'chickpea_as_agent' });
  assert.deepEqual(sender(await postAsRun(h, job)), AS_SUPPORT);
  assert.equal(h.calls.some((call) => call.token === AGENT_BOT), false, 'nothing runs as the app bot');
}));

// Defects caught: tenant end finding apps by kind, so an app attached to a user group outlives its tenant; and a
// retire that rewrites the group instead of only dropping the record.
test("a tenant's end retires an app record attached to a user group and leaves the group as it was", async (t) => withHarness(t, async (h) => {
  const rotated = { accessToken: 'xoxe.xoxp-1-config-access', refreshToken: 'xoxe-1-config-refresh', teamId: TEAM, expiresAt: Date.now() + 12 * 3_600_000 };
  assert.equal(await saveConfigurationToken({ ...h.secrets(), slack: { rotate: async () => rotated } }, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  await attachSupportApp(h);
  const { app: _app, ...group } = (await h.stores.config.getAgent('agent_support')).slackPresence!;
  h.calls.length = 0;
  assert.deepEqual(await retireAgentSlackApps(h.base), [{ agentId: 'agent_support', outcome: 'removed' }]);
  assert.deepEqual(h.calls.map(({ method, token }) => [method, token]), [
    ['apps.uninstall', AGENT_BOT],
    ['apps.manifest.delete', rotated.accessToken],
  ]);
  assert.deepEqual((await h.stores.config.getAgent('agent_support')).slackPresence, group);
  assert.equal(await readAppSecrets(h.secrets(), AGENT_APP), undefined);
}));

// Defects caught: the user-group lookup ignoring a released group that still answers, so a mention of it reaches
// nobody between the app going live and the group being disabled; or honoring one that no longer answers.
test('a mention of an app Agent’s released user group routes to it only while that group answers', async (t) => withHarness(t, async (h) => {
  const setAnswers = async (answers: boolean | undefined) => {
    const support = await h.stores.config.getAgent('agent_support');
    assert.equal(support.slackPresence?.kind, 'agent_app');
    if (support.slackPresence?.kind !== 'agent_app') return;
    const released = { userGroupId: 'SSUPPORT', ...(answers === undefined ? {} : { answers }) };
    await h.stores.config.updateAgent(support.id, { slackPresence: { ...support.slackPresence, released } }, support.revision);
  };
  const text = '<!subteam^SSUPPORT|@support> what changed?';
  await setAnswers(true);
  assert.deepEqual(await admittedFor(h, '1900005100.000100', text), ['agent_support']);
  await setAnswers(false);
  assert.deepEqual(await admittedFor(h, '1900005200.000100', text), []);
  await setAnswers(undefined);
  assert.deepEqual(await admittedFor(h, '1900005300.000100', text), []);
  assert.equal((await h.stores.config.getAgent('agent_support')).slackPresence?.kind, 'agent_app', 'nothing rebinds the group');
}));

// Defects caught: between Allow and the group's disable, a mention of the group or of the bot reaching nobody, or
// one message reaching the Agent twice when both bots hear it.
test('after Allow and before the group is off, a mention of the group and a mention of the bot each get one answer', async (t) => withHarness(t, async (h) => {
  const support = await h.stores.config.getAgent('agent_support');
  assert.equal(support.slackPresence?.kind, 'agent_app');
  if (support.slackPresence?.kind !== 'agent_app' || support.slackPresence.app.state !== 'active') return;
  await h.stores.config.updateAgent(support.id, {
    slackPresence: {
      ...support.slackPresence,
      released: { userGroupId: 'SSUPPORT', desiredState: 'active' as const, health: 'healthy' as const, answers: true },
      app: { ...support.slackPresence.app, switchProgress: 'group_pending' as const },
    },
  }, support.revision);
  t.mock.method(console, 'info', () => undefined);

  const group = channelMessage('1900006000.000100', '<!subteam^SSUPPORT|@support> what changed?');
  assert.equal((await h.deliverToChickpea(group.chickpea)).status, 200);
  const bot = channelMessage('1900006100.000100', `<@${AGENT_BOT_USER}> what changed?`);
  for (const delivered of [await h.deliver('events', bot.app), await h.deliverToChickpea(bot.chickpea)]) assert.equal(delivered.status, 200);

  const turns = await h.stores.slackState.listPendingTurns!();
  assert.deepEqual(turns.filter((job) => job.turn.messageTs === '1900006000.000100').map((job) => job.assignment.agentId), ['agent_support'],
    'the group still reaches Support');
  assert.deepEqual(turns.filter((job) => job.turn.messageTs === '1900006100.000100').map((job) => job.assignment.agentId), ['agent_support'],
    'the bot reaches Support once, though both bots heard it');
}));

/** The App Home Chickpea publishes for U1, by Agent: its Message button's action and link. */
async function appHomeMessageButtons(h: Harness, tab: 'home' | 'messages' = 'home'): Promise<Record<string, { action: string; url?: string }>> {
  const before = h.calls.length;
  const now = Date.now();
  assert.equal((await h.deliverToChickpea({
    token: '', team_id: TEAM, api_app_id: MAIN_APP.appId, type: 'event_callback', event_id: `EvHome${now}`, event_time: now,
    authorizations: [{ team_id: TEAM, user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
    event: { type: 'app_home_opened', user: 'U1', channel: CHICKPEA_DM, tab },
  })).status, 200);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const published = h.calls.slice(before).find((call) => call.method === 'views.publish');
    if (published) {
      const view = JSON.parse(published.body.get('view') ?? '{}') as {
        blocks: Array<{ accessory?: { action_id: string; value?: string; url?: string; text?: { text: string } } }>;
      };
      return Object.fromEntries(view.blocks.flatMap(({ accessory }) =>
        accessory?.text?.text === 'Message' && accessory.value
          ? [[accessory.value, { action: accessory.action_id, ...(accessory.url ? { url: accessory.url } : {}) }]]
          : []));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('no App Home was published');
}

test("App Home's Message opens a live app Agent's own DM; a user-group Agent's still starts a thread in Chickpea's DM", async (t) => withHarness(t, async (h) => {
  const start = { action: START_AGENT_ACTION_ID };
  assert.deepEqual(await appHomeMessageButtons(h), {
    agent_support: { action: OPEN_AGENT_DM_ACTION_ID, url: `https://slack.com/app_redirect?app=${AGENT_APP}&team=${TEAM}` },
    agent_finance: start,
  });
  configureAgentSlackApps(undefined);
  assert.deepEqual(await appHomeMessageButtons(h), { agent_support: start, agent_finance: start },
    "without the port no app's bot answers its DM, so Message starts a thread in Chickpea's DM as before");
}));

test("App Home's link click for an app Agent seeds nothing in Chickpea's DM", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliverToChickpea({
    type: 'block_actions', api_app_id: MAIN_APP.appId, team: { id: TEAM }, user: { id: 'U1' }, trigger_id: 'trigger1',
    container: { type: 'view', view_id: 'VHOME' },
    actions: [{ type: 'button', action_id: OPEN_AGENT_DM_ACTION_ID, value: 'agent_support', action_ts: `${Date.now() / 1_000}` }],
  }, 'interactions')).status, 200);
  assert.deepEqual(h.calls.filter((call) => call.method.startsWith('chat.') || call.method === 'conversations.open'), []);
}));

test('the joiner welcome tells a person to message an app Agent directly by its handle; a user-group Agent keeps the Message row', async (t) => withHarness(t, async (h) => {
  await appHomeMessageButtons(h, 'messages');
  const now = Date.now();
  const [queued] = await h.stores.management.claimDueOutbox(now + 1, 10, now + 30_000);
  assert.ok(queued && 'kind' in queued.receipt && queued.receipt.kind === 'chickpea_introduction');
  assert.deepEqual(queued.receipt.usable?.agents.map(({ name, ownApp }) => [name, ownApp ?? false]), [['Finance', false], ['Support', true]]);
  assert.equal(formatManagementSetupReceipt(queued.receipt).split('\n\n').at(-1),
    'Mention an Agent in its Channel, or press Message next to it on my Home tab to talk to it privately. You can also message @support directly. To set up a new Agent for work you repeat, tell me what it should do.');
}));

/** A connector's notice for `agentId` in the thread `threadTs` of `channelId`, delivered as the outbox delivers it. */
async function deliverConnectedNotice(h: Harness, agentId: string, channelId: string, threadTs: string, finishedBy: string | null = 'U1') {
  const agent = await h.stores.config.getAgent(agentId);
  const before = h.calls.length;
  await deliverManagementReceiptToSlack({
    outboxId: `receipt_${channelId}_${threadTs}`, operationId: 'setup_tasks',
    destination: {
      kind: 'thread', workspaceId: TEAM, channelId, threadTs,
      ...(finishedBy ? { wake: { agentId, slackUserId: finishedBy, conversationKind: 'im' as const, note: SETUP_NOTE } } : {}),
    },
    receipt: {
      kind: 'connector_connected', setupOperationId: 'setup_tasks', connector: 'Tasks', toolkit: 'tasks', agentId, agentName: agent.name,
      ownerKind: 'member', accessLane: 'read', avatarUrl: 'https://hosted.example/avatar.png', completedAt: Date.now(),
    },
    status: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: 0, updatedAt: 0,
  }, {
    identity: h.stores.identity,
    env: withHostedSlackApp(h.base, MAIN_APP),
    agentPresence: async (id) => (await h.stores.config.getAgent(id)).slackPresence,
  });
  return sender(h.calls.slice(before).find((call) => call.method === 'chat.postMessage'));
}

test("the connected notice speaks as the bot that speaks for the Agent where it lands, and never with a persona on the app's token", async (t) => withHarness(t, async (h) => {
  assert.deepEqual(await deliverConnectedNotice(h, 'agent_support', 'D1', '1900004500.000100'), OWN_BOT,
    "in the app's own DM, where Chickpea's bot cannot post");
  assert.deepEqual(dmQuestions(h, AGENT_BOT), ['conversations.open U1'], "the app's token only opened its DM with the person who finished the setup");
  const before = h.calls.length;
  assert.deepEqual(await deliverConnectedNotice(h, 'agent_support', CHICKPEA_DM, '1900004500.000200'), AS_SUPPORT);
  assert.deepEqual(dmQuestions(h, AGENT_BOT, before), ['conversations.open U1'], "the app's DM with that person is another one");
  assert.deepEqual(await deliverConnectedNotice(h, 'agent_support', 'C1', '1900004500.000300'), OWN_BOT, 'a Channel its bot is in');
  assert.deepEqual(await deliverConnectedNotice(h, 'agent_support', 'C2', '1900004500.000400'), AS_SUPPORT, 'a Channel its bot is not in');
  assert.deepEqual(await deliverConnectedNotice(h, 'agent_finance', 'C1', '1900004500.000500'), { token: MAIN_BOT, username: 'Finance', picture: true },
    'a user-group Agent, as before');
  assert.deepEqual(personaOnAppToken(h), []);
}, { notMemberOf: { [AGENT_BOT]: ['C2'] } }));

test("a connected notice with no person to ask about is placed as Chickpea's DM, and the app's token is asked nothing", async (t) => withHarness(t, async (h) => {
  await assert.rejects(deliverConnectedNotice(h, 'agent_support', 'D1', '1900004550.000100', null), /channel_not_found/,
    "Chickpea's bot is refused in the app's own DM, so the outbox keeps the notice");
  assert.deepEqual(dmQuestions(h, AGENT_BOT), []);
  assert.deepEqual(await deliverConnectedNotice(h, 'agent_support', CHICKPEA_DM, '1900004550.000200', null), AS_SUPPORT);
  assert.deepEqual(dmQuestions(h, AGENT_BOT), []);
}));

test("a connected notice whose DM Slack does not place is not posted on a guessed bot", async (t) => withHarness(t, async (h) => {
  await assert.rejects(deliverConnectedNotice(h, 'agent_support', CHICKPEA_DM, '1900004560.000100'), /ratelimited/);
  assert.deepEqual(h.calls.filter((call) => call.method.startsWith('chat.')), [], 'nothing posts on either bot');
}, { rateLimited: [`conversations.open ${AGENT_BOT}`] }));

const FINANCE_NOT_IN_DM = "Finance can't reply in this direct message. Mention Finance in a channel instead.";

/** Hands the host one reply of `asking` that asks Finance, as its run's collector does when Finance is its teammate there. */
async function askFinanceFrom(h: Harness, asking: PendingTurnJob, ts: string): Promise<void> {
  const collector = createAgentAskCollector({
    turn: asking.turn,
    assignment: { ...asking.assignment, teammates: [{ name: 'Finance', handle: 'finance', userGroupId: 'SFINANCE' }] },
    dispatch: (request) => processSlackAgentAsks(request, withHostedSlackApp(h.base, MAIN_APP), { stores: h.stores }),
  });
  collector.note({ messageTs: ts, text: 'Let me ask @finance about Q3.' });
  await collector.flush('succeeded');
}

test("a teammate asked inside an app Agent's own DM is not run, and the Agent's bot says once in the thread where to ask instead", async (t) => withHarness(t, async (h) => {
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const asking = await pendingTurn(h.stores, (job) => job.turn.channelId === 'D1');
  assert.ok(asking);
  assert.deepEqual(asking.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  await askFinanceFrom(h, asking, '1900004650.000100');
  await askFinanceFrom(h, asking, '1900004650.000200');
  const lines = h.calls.filter((call) => call.method === 'chat.postMessage' && call.body.get('text') === FINANCE_NOT_IN_DM);
  assert.deepEqual(lines.map((call) => [sender(call), call.body.get('channel'), call.body.get('thread_ts')]),
    [[OWN_BOT, 'D1', asking.turn.threadTs]], "one line, from Support's own bot, in the thread it asked from");
  assert.equal(await pendingTurn(h.stores, (job) => job.assignment.agentId === 'agent_finance'), undefined, 'no teammate turn is admitted');
  assert.ok((await h.stores.config.listSlackPublicContext(TEAM, 'D1', asking.turn.threadTs))
    .some((row) => row.role === 'agent' && row.text === FINANCE_NOT_IN_DM), 'Support reads the line on its next turn');
}));

test("the same ask from a Channel admits the teammate and posts no such line", async (t) => withHarness(t, async (h) => {
  const asking = await admitSupportTurn(h, 'C1', '1900004660.000100', '1900004660.000200');
  await askFinanceFrom(h, asking, '1900004660.000300');
  assert.ok(await pendingTurn(h.stores, (job) => job.assignment.agentId === 'agent_finance'), 'Finance is asked');
  assert.deepEqual(h.calls.filter((call) => call.body.get('text') === FINANCE_NOT_IN_DM), []);
}));

/** Asks Finance from `asking` until the exchange reaches its limit, then once more; returns the pause line's post. */
async function pauseLineAfterLimit(h: Harness, asking: PendingTurnJob): Promise<SlackCall | undefined> {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const state = h.stores.slackState as unknown as { recordTurnAttempt(id: string, n: number): Promise<void> };
  for (let index = 1; index <= AGENT_ASK_TURN_LIMIT + 1; index += 1) {
    const ts = `${asking.turn.threadTs.split('.')[0]}.0009${String(index).padStart(2, '0')}`;
    await processSlackAgentAsks({
      turn: asking.turn, fromAgentId: asking.assignment.agentId, fromThreadOwner: true,
      deliveries: [{ messageTs: ts, text: '@finance and now?' }],
    }, env, { stores: h.stores });
    const asked = await pendingTurn(h.stores, (job) => job.turn.messageTs === ts);
    if (asked) await state.recordTurnAttempt(asked.id, 1);
  }
  return h.calls.find((call) => call.method === 'chat.postMessage' && call.body.get('text') === AGENT_ASK_PAUSE_TEXT);
}

test("the ask-limit pause line comes from the asking run's own bot without a persona where that bot speaks", async (t) => withHarness(t, async (h) => {
  const asking = await admitSupportTurn(h, 'C1', '1900004600.000100', '1900004600.000200');
  assert.deepEqual(asking.turn.speaker, { kind: 'own_bot', botUserId: AGENT_BOT_USER });
  assert.deepEqual(sender(await pauseLineAfterLimit(h, asking)), OWN_BOT);
  assert.deepEqual(personaOnAppToken(h), []);
}));

test("the ask-limit pause line comes through Chickpea under the Agent's name where its app's bot is not", async (t) => withHarness(t, async (h) => {
  const asking = await admitSupportTurn(h, 'C1', '1900004700.000100', '1900004700.000200');
  assert.deepEqual(asking.turn.speaker, { kind: 'chickpea_as_agent' });
  assert.deepEqual(sender(await pauseLineAfterLimit(h, asking)), AS_SUPPORT);
}, { notMemberOf: { [AGENT_BOT]: ['C1'] } }));

/** The Slack signal of `job`'s run, as its tools read it. */
function signalOf(job: PendingTurnJob, requesterText?: string) {
  return {
    agentId: job.assignment.agentId, workspaceId: TEAM, channelId: job.turn.channelId, threadTs: job.turn.threadTs,
    conversationKind: job.turn.channelType === 'im' ? 'im' as const : 'channel' as const, slackUserId: 'U1', eventId: job.turn.eventId,
    messageTs: job.turn.messageTs, turnJobId: job.id, ...(requesterText ? { requesterText } : {}),
  };
}

test("canvases say plainly they are not available in an app Agent's own DM, and work as before everywhere else", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  const plan = { agentId: 'agent_support', actorMembershipId: h.ownerMembershipId } as RuntimePlanV2;
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const own = await pendingTurn(h.stores, (job) => job.turn.channelId === 'D1');
  assert.ok(own);
  const before = h.calls.length;
  const [read] = createSlackCanvasTools(() => slackCanvasService(plan, signalOf(own), env));
  const refused = JSON.parse(await (read as unknown as { run(input: { data: object }): Promise<string> }).run({ data: {} }));
  assert.deepEqual(refused, { status: 'not_read', code: 'not_in_this_conversation', message: CANVASES_NOT_IN_AGENT_DM });
  assert.deepEqual(h.calls.slice(before).filter((call) => call.method !== 'auth.test' && call.method !== 'users.info'), [],
    'nothing is asked of Slack');
  for (const channelId of [CHICKPEA_DM, 'C1']) {
    const job = await admitSupportTurn(h, channelId, `19000048${channelId === 'C1' ? '1' : '0'}0.000100`, `19000048${channelId === 'C1' ? '1' : '0'}0.000200`);
    await slackCanvasService(plan, signalOf(job), env);
  }
  const finance = await admitChannelTurnOf(h, 'agent_finance', '1900004820.000100', '1900004820.000200');
  await slackCanvasService({ ...plan, agentId: 'agent_finance' }, signalOf(finance), env);
}));

test("an app Agent asked in its own DM to create a Channel has Chickpea's bot create it and post as the Agent", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const own = await pendingTurn(h.stores, (job) => job.turn.channelId === 'D1');
  assert.ok(own);
  const result = await createSlackChannel(
    { agentId: 'agent_support', actorMembershipId: h.ownerMembershipId },
    signalOf(own, 'please make a channel for the Q3 refunds'),
    env,
    { name: 'q3-refunds', visibility: 'private', people: [], message: 'Kicking off Q3 refunds here.' },
  );
  assert.equal(result.status, 'created', JSON.stringify(result));
  assert.deepEqual(h.calls.filter((call) => call.method === 'conversations.info' && call.body.get('channel') === 'D1').map((call) => call.token), [AGENT_BOT],
    "the DM it was asked in is read by the app's bot, the one in it");
  assert.deepEqual(['conversations.create', 'conversations.invite'].map((method) => h.calls.find((call) => call.method === method)?.token), [MAIN_BOT, MAIN_BOT]);
  assert.deepEqual(sender(h.calls.find((call) => call.method === 'chat.postMessage' && call.body.get('channel') === 'C9NEW')), AS_SUPPORT);
}));

test("an app Agent asked in its own DM to start a group DM has Chickpea's bot open it and post as the Agent", async (t) => withHarness(t, async (h) => {
  const env = withHostedSlackApp(h.base, MAIN_APP);
  assert.equal((await h.deliver('events', dmEvent())).status, 200);
  const own = await pendingTurn(h.stores, (job) => job.turn.channelId === 'D1');
  assert.ok(own);
  const result = await startSlackGroupDm(
    { agentId: 'agent_support', actorMembershipId: h.ownerMembershipId },
    signalOf(own, 'please start a group DM with <@U0SAM> about the Q3 refunds'),
    env,
    ['U0SAM'],
    'Kicking off Q3 refunds here.',
  );
  assert.equal(result.status, 'posted', JSON.stringify(result));
  assert.deepEqual(h.calls.filter((call) => call.method === 'conversations.info' && call.body.get('channel') === 'D1').map((call) => call.token), [AGENT_BOT],
    "the DM it was asked in is read by the app's bot, the one in it");
  const opened = h.calls.find((call) => call.method === 'conversations.open' && call.body.get('users')?.includes(','));
  assert.equal(opened?.token, MAIN_BOT);
  assert.deepEqual(sender(h.calls.find((call) => call.method === 'chat.postMessage' && call.body.get('text') === 'Kicking off Q3 refunds here.')), AS_SUPPORT);
}));
