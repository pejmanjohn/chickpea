import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import type { BetterAuthDatabaseBackend } from '../src/auth/better-auth-backend.ts';
import { withBetterAuthBackend } from '../src/auth/better-auth-environment.ts';
import { START_AGENT_ACTION_ID } from '../src/slack/app-home.ts';
import { channel as slackChannel } from '../src/channels/slack.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  closeNodeStateStores,
  getSlackCredentialResolutionDependencies,
  resolveStores,
  type AppStores,
  type PlatformEnv,
} from '../src/config/state-backend.ts';
import {
  HOSTED_SLACK_INSTALLATION_ID,
  WORKSPACE_SLACK_INSTALLATION_ID,
} from '../src/config/types.ts';
import {
  describeSlackCredentialSources,
  invalidateStoredSlackPublicUrl,
  readSlackConnectionRevision,
  readStoredSlackTeamInfo,
  resolveSlackCredentials,
} from '../src/slack/credentials.ts';
import { generateCredentialKeyring, loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  backfillHostedWorkspaceInstallation,
  syncHostedWorkspaceInstallation,
} from '../src/slack/hosted-installation.ts';
import { withHostedSlackApp } from '../src/slack/hosted-slack-app.ts';
import { SLACK_PENDING_ENVELOPE_SETTING } from '../src/slack/installation-handshake.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  stageSlackCredentialBundle,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { resolveSlackInstallationExecutionContext } from '../src/slack/installation-execution.ts';
import { stopNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import {
  PRIVATE_CHANNEL_SETUP_ADD_ACTION,
  PRIVATE_CHANNEL_SETUP_AGENT_ACTION,
  PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK,
} from '../src/slack/private-channel-setup.ts';
import { uiActionId, uiBlockId } from '../src/slack/ui/surface.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * A host serving many installations verifies each Slack delivery with its one
 * app's signing secret, routes it by the workspace that received it, and
 * hands Core that installation's env with the app attached. Core verifies
 * again, acts only for the host's app and its own workspace record, and
 * reaches Slack only with the installation's own bot.
 */

const APP = { appId: 'AHOSTED1', signingSecret: 'hosted-app-signing-secret' };
const TEAM = 'TTENANT1';
const BOT_TOKEN = 'xoxb-hosted-tenant-bot';
const HOSTED = { CHICKPEA_TENANCY: 'installation', SLACK_TAG_PUBLIC_URL: 'https://hosted.example' };

interface SlackCall {
  method: string;
  token: string | undefined;
  body: URLSearchParams;
}

interface Harness {
  env: PlatformEnv;
  stores: AppStores;
  calls: SlackCall[];
  ownerMembershipId: string;
  /** POST a signed delivery through Core's Slack route. */
  deliver(kind: 'events' | 'interactions', body: Record<string, unknown>, options?: {
    secret?: string;
    timestamp?: number;
    env?: PlatformEnv;
  }): Promise<Response>;
  /** A signed Events API envelope for this installation's team. */
  event(event: Record<string, unknown>, patch?: Record<string, unknown>): Record<string, unknown>;
  settle(until: () => boolean | Promise<boolean>): Promise<void>;
}

async function withHostedInstallation(
  t: TestContext,
  run: (harness: Harness) => Promise<void>,
  options: { installationId?: string; record?: boolean } = {},
): Promise<void> {
  await stopNodeTurnRelay();
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-hosted-slack-'));
  process.env.TAG_DB_PATH = ':memory:';
  process.env.SLACK_STATE_DB_PATH = ':memory:';
  process.env.CHICKPEA_AUTH_DB_PATH = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  const previousFetch = globalThis.fetch;
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
  invalidateStoredSlackPublicUrl();
  t.after(() => {
    globalThis.fetch = previousFetch;
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    invalidateStoredSlackPublicUrl();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });

  const env = withHostedSlackApp(
    scopeInstallationEnv(HOSTED, { installationId: options.installationId ?? 'inst_tenant_a' }),
    APP,
  );
  const stores = resolveStores(env);
  const owner = await createSlackOwner(stores.identity, { teamId: TEAM, userId: 'U1' });
  await writeHostedSlackBotCredentials({ state: stores.identity, keyring: loadCredentialKeyring() }, null, {
    botToken: BOT_TOKEN, botUserId: 'UBOT', appId: APP.appId, teamId: TEAM,
    grantedScopes: ['chat:write', 'users:read'], validatedAt: Date.now(),
  });
  if (options.record !== false) {
    await syncHostedWorkspaceInstallation(env, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT' });
  }

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
      ? { ok: true, team_id: TEAM, user_id: 'UBOT', bot_id: 'BBOT', app_id: APP.appId, team: 'Tenant' }
      : method === 'users.info'
        ? {
            ok: true,
            user: {
              id: user, team_id: TEAM, name: user, deleted: false, is_bot: false, is_app_user: false,
              is_restricted: false, is_ultra_restricted: false, is_stranger: false,
            },
          }
        : method === 'conversations.info'
          ? { ok: true, channel: { id: body.get('channel'), is_im: true, user: 'U1' } }
          : method === 'conversations.members'
            ? { ok: true, members: ['U1', 'UBOT'], response_metadata: { next_cursor: '' } }
            : method === 'conversations.open'
              ? { ok: true, channel: { id: 'DHOME' } }
              : method.startsWith('chat.')
                ? { ok: true, ts: '1900000000.000100', channel: body.get('channel') ?? 'D1' }
                : { ok: true };
    return Response.json(answer, { headers: { 'x-oauth-scopes': 'chat:write,users:read' } });
  }) as typeof fetch;

  const ingress = new Hono();
  ingress.route('/channels/slack', slackChannel.route());
  let eventCount = 0;
  await run({
    env,
    stores,
    calls,
    ownerMembershipId: owner.membership.id,
    async deliver(kind, body, deliveryOptions = {}) {
      const raw = kind === 'events'
        ? JSON.stringify(body)
        : new URLSearchParams({ payload: JSON.stringify(body) }).toString();
      const timestamp = String(deliveryOptions.timestamp ?? Math.floor(Date.now() / 1_000));
      const signature = createHmac('sha256', deliveryOptions.secret ?? APP.signingSecret)
        .update(`v0:${timestamp}:${raw}`).digest('hex');
      return ingress.request(`/channels/slack/${kind}`, {
        method: 'POST',
        headers: {
          'content-type': kind === 'events' ? 'application/json' : 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': `v0=${signature}`,
        },
        body: raw,
      }, deliveryOptions.env ?? env);
    },
    event(event, patch = {}) {
      eventCount += 1;
      return {
        token: '', team_id: TEAM, api_app_id: APP.appId, type: 'event_callback',
        event_id: `EvHosted${eventCount}`, event_time: Math.floor(Date.now() / 1_000),
        authorizations: [{ team_id: TEAM, user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
        event, ...patch,
      };
    },
    async settle(until) {
      for (let tries = 0; tries < 200; tries += 1) {
        if (await until()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('detached Slack work did not settle');
    },
  });
}

const tokensUsed = (calls: SlackCall[]) => [...new Set(calls.map(({ token }) => token))];

test('a hosted delivery verifies only with the host app\'s signing secret, and only for its app', async (t) => {
  await withHostedInstallation(t, async (h) => {
    // A bundle-style signing secret in the installation's store is never a verifier.
    const credentials = { state: h.stores.identity, keyring: loadCredentialKeyring() };
    const legacy = await stageSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
      purpose: 'connected_credentials', expectedActiveRevision: null, appId: APP.appId, teamId: TEAM,
      secrets: { signingSecret: 'bundle-signing-secret', botToken: 'xoxb-bundle' },
    });
    await promoteSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: legacy.revision, expectedActiveRevision: null,
    });
    const home = h.event({ type: 'app_home_opened', user: 'U1', channel: 'DHOME', tab: 'home' });
    assert.equal((await h.deliver('events', home, { secret: 'bundle-signing-secret' })).status, 401);
    assert.equal((await h.deliver('events', home, { secret: 'wrong-secret' })).status, 401);
    assert.equal((await h.deliver('events', home, {
      timestamp: Math.floor(Date.now() / 1_000) - 301,
    })).status, 401, 'a stale signature is refused');
    const unconfigured = scopeInstallationEnv(HOSTED, { installationId: 'inst_tenant_a' });
    const missing = await h.deliver('events', home, { env: unconfigured });
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: 'slack_not_configured' });
    assert.equal((await h.deliver('interactions', { type: 'block_actions', team: { id: TEAM } }, {
      env: unconfigured,
    })).status, 401);

    // Another app's delivery, even signed with this secret, is acknowledged and dropped.
    const otherApp = await h.deliver('events', { ...home, api_app_id: 'AOTHERAPP' });
    assert.equal(otherApp.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(h.calls, [], 'nothing reached Slack');

    assert.equal((await h.deliver('events', h.event({ type: 'app_home_opened', user: 'U1', tab: 'home' }))).status, 200);
    await h.settle(() => h.calls.some(({ method }) => method === 'views.publish'));
    assert.deepEqual(tokensUsed(h.calls), [BOT_TOKEN], 'the installation\'s own bot published App Home');
  });
});

test('a hosted delivery with a bad signature is refused before any store is read', async (t) => {
  await withHostedInstallation(t, async (h) => {
    const reads: string[] = [];
    const spy = (store: object, name: string) => {
      const target = store as Record<string, (...args: unknown[]) => unknown>;
      const original = target[name]!;
      target[name] = (...args: unknown[]) => {
        reads.push(name);
        return original.apply(store, args);
      };
      t.after(() => { delete target[name]; });
    };
    for (const name of ['getActiveSlackCredentialRevision', 'getSlackCredentialControl', 'getAuthControl']) {
      spy(h.stores.identity, name);
    }
    spy(h.stores.config, 'getWorkspaceInstallation');
    spy(h.stores.settings, 'getSetting');
    const home = h.event({ type: 'app_home_opened', user: 'U1', tab: 'home' });
    assert.equal((await h.deliver('events', home, { secret: 'forged-secret' })).status, 401);
    assert.equal((await h.deliver('interactions', {
      type: 'block_actions', api_app_id: APP.appId, team: { id: TEAM }, user: { id: 'U1' }, actions: [],
    }, { secret: 'forged-secret' })).status, 401);
    assert.equal(reads.length, 0, reads.join());
    // A verified delivery reads the installation's own state as before.
    assert.equal((await h.deliver('events', home)).status, 200);
    assert.ok(reads.includes('getWorkspaceInstallation'));
  });
});

test('a hosted app\'s url_verification is answered without recording a challenge or finishing a setup', async (t) => {
  await withHostedInstallation(t, async (h) => {
    const response = await h.deliver('events', { token: '', type: 'url_verification', challenge: 'challenge-value' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { challenge: 'challenge-value' });
    assert.equal(await h.stores.settings.getSetting(SLACK_PENDING_ENVELOPE_SETTING), undefined);
    assert.equal(await h.stores.identity.getSlackSetupTransaction('setup_default'), undefined);
  });
});

test('Core drops a hosted event routed to the wrong workspace, an org-wide install or a shared channel without authorization', async (t) => {
  await withHostedInstallation(t, async (h) => {
    const home = { type: 'app_home_opened', user: 'U1', tab: 'home' };
    for (const patch of [
      { context_team_id: 'TOTHER' },
      { authorizations: [{ team_id: null, is_enterprise_install: true }] },
      { authorizations: [{ team_id: 'TOTHER', is_enterprise_install: false }] },
      { authorizations: undefined, is_ext_shared_channel: true },
    ]) {
      assert.equal((await h.deliver('events', h.event(home, patch))).status, 200, JSON.stringify(patch));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(h.calls, []);
    assert.equal((await h.stores.config.getWorkspaceInstallation(TEAM))?.health, 'needs_attention',
      'a dropped delivery is not the installation\'s first event');
  });
});

test('every runtime Slack path of a hosted installation acts as its own bot', async (t) => {
  await withHostedInstallation(t, async (h) => {
    const failures: string[] = [];
    const errors = console.error;
    const warnings = console.warn;
    console.error = (...args: unknown[]) => { failures.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { failures.push(args.map(String).join(' ')); };
    t.after(() => { console.error = errors; console.warn = warnings; });
    const ofMethod = (method: string) => h.calls.filter((call) => call.method === method);

    // App Home.
    assert.equal((await h.deliver('events', h.event({ type: 'app_home_opened', user: 'U1', tab: 'home' }))).status, 200);
    await h.settle(() => ofMethod('views.publish').length === 1);

    // A direct message reaches admission with the installation's bot.
    const before = h.calls.length;
    assert.equal((await h.deliver('events', h.event({
      type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: '1800000001.000100', text: 'hello',
    }))).status, 200);
    await h.settle(() => h.calls.length > before);

    // A modal button without its card is refused privately, through the same bot.
    const click = (actionId: string) => ({
      type: 'block_actions', api_app_id: APP.appId, team: { id: TEAM }, user: { id: 'U1' },
      trigger_id: 'trigger1', container: { type: 'message', channel_id: 'C1', message_ts: '1800000002.000100' },
      channel: { id: 'C1' }, message: { ts: '1800000002.000100' },
      actions: [{
        action_id: actionId, block_id: uiBlockId('ui', 'a'.repeat(32), 1), type: 'button',
        value: `${'a'.repeat(32)}:0`, action_ts: '1800000003.000100',
      }],
    });
    assert.equal((await h.deliver('interactions', click(uiActionId('ui', 'form_open', 0)))).status, 200);
    await h.settle(() => ofMethod('chat.postEphemeral').length === 1);

    // A form submission whose card is gone keeps the modal open with Slack's errors.
    const submission = await h.deliver('interactions', {
      type: 'view_submission', api_app_id: APP.appId, team: { id: TEAM }, user: { id: 'U1' },
      view: { id: 'V1', callback_id: 'chickpea.ui.v1.form', private_metadata: 'b'.repeat(32), state: { values: {} } },
    });
    assert.equal(submission.status, 200);
    assert.ok(((await submission.json()) as { response_action?: string }).response_action);

    // Private Channel setup (an unknown card ends quietly after its credentials).
    assert.equal((await h.deliver('interactions', {
      type: 'block_actions', api_app_id: APP.appId, team: { id: TEAM }, user: { id: 'U1' },
      channel: { id: 'GPRIVATE1' }, container: { type: 'message', is_ephemeral: true, channel_id: 'GPRIVATE1' },
      actions: [{ action_id: PRIVATE_CHANNEL_SETUP_ADD_ACTION, value: 'setup1', action_ts: '1800000004.000100' }],
      state: { values: { [PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK]: {
        [PRIVATE_CHANNEL_SETUP_AGENT_ACTION]: { type: 'static_select', selected_option: null },
      } } },
    })).status, 200);

    // Slack's Stop button stops the Agent's running turn in its thread.
    const rootTs = '1800000000.000100';
    await h.stores.config.createAgent({
      id: 'agent_ops', name: 'ops', instructions: '', enabled: true, lifecycle: 'active',
      model: 'local-stub/hosted', creatorMembershipId: h.ownerMembershipId, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'ops', normalizedHandle: 'ops', desiredState: 'active', health: 'healthy',
        userGroupId: 'SOPS', avatar: { kind: 'generated', revision: 1, seed: 'ops' },
      },
    });
    const agent = await h.stores.config.getAgent('agent_ops');
    await h.stores.config.putChannel({ workspaceId: TEAM, channelId: 'C1', label: 'ops', lifecycle: 'active' }, 0);
    await h.stores.config.putAgentChannelGrant({
      workspaceId: TEAM, channelId: 'C1', agentId: 'agent_ops', status: 'active',
      createdByMembershipId: h.ownerMembershipId, channelLabel: 'ops', channelIsPrivate: false,
    }, 0);
    await h.stores.config.putAgentThreadRoute({
      workspaceId: TEAM, channelId: 'C1', threadTs: rootTs, agentId: 'agent_ops',
      agentGeneration: agent.configurationGeneration ?? agent.revision, ownerIncarnation: 1,
    }, 0);
    const jobId = `msg:C1:${rootTs}`;
    await h.stores.slackState.enqueueTurn!({
      id: jobId, evtKey: `evt:${rootTs}`, msgKey: jobId,
      turn: {
        workspaceId: TEAM, channelId: 'C1', userId: 'U1', text: 'Investigate.', eventId: 'EvRoot',
        messageTs: rootTs, threadTs: rootTs, source: 'app_mention', channelType: 'channel', contextMode: 'thread',
      },
      assignment: { runtimeContract: 'chickpea-v1', agentId: 'agent_ops', agent: { id: 'agent_ops' } },
    } as unknown as Parameters<NonNullable<AppStores['slackState']['enqueueTurn']>>[0]);
    assert.equal((await h.deliver('events', h.event({
      type: 'agent_session_stopped', channel: 'C1', thread_ts: rootTs, user: 'U1',
      event_ts: '1800000005.000100', streaming_message_ts: [],
    }))).status, 200);
    await h.settle(async () => Boolean((await h.stores.slackState.listPendingTurns!())
      .find((job) => job.id === jobId)?.stop));

    // The relay's execution context for a durable turn.
    const context = await resolveSlackInstallationExecutionContext(TEAM, h.env);
    assert.equal(context.botToken, BOT_TOKEN);
    assert.equal(context.transportMode, 'direct');

    // The shared readers behind turns, memory, routines, attachments and Admin.
    assert.equal((await resolveSlackCredentials(h.env)).botToken, BOT_TOKEN);
    assert.deepEqual(await describeSlackCredentialSources(h.env),
      { botToken: 'stored', signingSecret: 'missing', botUserId: 'stored' });
    assert.equal((await readStoredSlackTeamInfo(h.env)).teamId, TEAM);
    const dependencies = getSlackCredentialResolutionDependencies(h.env);
    const active = await h.stores.identity.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID);
    assert.equal(await readSlackConnectionRevision(h.stores.settings, dependencies), active?.revision);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(tokensUsed(h.calls), [BOT_TOKEN], JSON.stringify(h.calls.map(({ method }) => method)));
    assert.deepEqual(failures.filter((line) => /installation|standalone|credential/i.test(line)), [],
      'no path asked for another slot');
  });
});

test('a hosted deactivation suspends the member through the installation\'s bot revision and ends their access', async (t) => {
  await withHostedInstallation(t, async (h) => {
    const revoked: string[] = [];
    const backend = {
      async deleteSessionsForUser(userId: string) { revoked.push(`sessions:${userId}`); return 1; },
      async revokeOAuthGrantsForUser(userId: string) {
        revoked.push(`grants:${userId}`);
        return { consents: 0, accessTokens: 0, refreshTokens: 0 };
      },
    } as unknown as BetterAuthDatabaseBackend;
    const control = await h.stores.identity.ensureAuthControl();
    await h.stores.identity.updateAuthControl({
      expectedRevision: control.revision, authMode: 'slack_active',
      canonicalAdminOrigin: 'https://hosted.example', betterAuthOrganizationId: '11111111-1111-4111-8111-111111111111',
    });
    const env = withBetterAuthBackend({ ...h.env, CHICKPEA_AUTH_SECRET: Buffer.alloc(32, 7).toString('base64url') }, backend);
    const owner = await h.stores.identity.resolveSlackIdentity(TEAM, 'U1');
    assert.ok(owner?.binding.betterAuthUserId);
    const response = await h.deliver('events', h.event({
      type: 'user_change', event_ts: '1800000006.000100',
      user: { id: 'U1', team_id: TEAM, deleted: true, is_bot: false, is_app_user: false },
    }), { env });
    assert.equal(response.status, 200);
    await h.settle(async () =>
      (await h.stores.identity.getMembershipAccessOverlay(h.ownerMembershipId))?.accessStatus === 'suspended');
    await h.settle(() => revoked.length === 2);
    assert.deepEqual(revoked, [`grants:${owner.binding.betterAuthUserId}`, `sessions:${owner.binding.betterAuthUserId}`]);
  });
});

test('a hosted installation turns healthy at its first signed delivery, once', async (t) => {
  await withHostedInstallation(t, async (h) => {
    const record = async () => h.stores.config.getWorkspaceInstallation(TEAM);
    assert.deepEqual(
      { health: (await record())?.health, detail: (await record())?.healthDetail },
      { health: 'needs_attention', detail: 'events_verification_pending' },
    );
    await h.deliver('events', h.event({ type: 'app_context_changed' }));
    const healthy = await record();
    assert.equal(healthy?.health, 'healthy');
    assert.equal(healthy?.healthDetail, undefined);
    await h.deliver('events', h.event({ type: 'app_context_changed' }));
    assert.equal((await record())?.revision, healthy?.revision, 'later deliveries write nothing');

    // An interaction is a first delivery as well.
    await h.stores.config.updateWorkspaceInstallation(TEAM, {
      health: 'needs_attention', healthDetail: 'events_verification_pending',
    });
    await h.deliver('interactions', { type: 'block_actions', api_app_id: APP.appId, team: { id: TEAM }, user: { id: 'U1' }, actions: [] });
    assert.equal((await record())?.health, 'healthy');

    // A revoked record never flips.
    await h.stores.config.updateWorkspaceInstallation(TEAM, { health: 'revoked', healthDetail: 'app_uninstalled' });
    await h.deliver('events', h.event({ type: 'app_context_changed' }));
    assert.equal((await record())?.health, 'revoked');
  });
});

test('a standalone installation waiting for its events proof is not promoted by a delivery', async (t) => {
  await stopNodeTurnRelay();
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-standalone-slack-'));
  for (const key of keys.slice(0, 3)) process.env[key] = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
  t.after(() => {
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  const stores = resolveStores();
  const credentials = { state: stores.identity, keyring: loadCredentialKeyring() };
  const bundle = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: 'connected_credentials', expectedActiveRevision: null, appId: 'A1', teamId: 'T1', botUserId: 'UBOT',
    secrets: { signingSecret: 'standalone-secret', botToken: 'xoxb-standalone' },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: bundle.revision, expectedActiveRevision: null,
  });
  const created = await stores.config.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'direct', teamId: 'T1', appId: 'A1', botUserId: 'UBOT',
  });
  await stores.config.updateWorkspaceInstallation('T1', {
    health: 'needs_attention', healthDetail: 'events_verification_pending',
  }, created.revision);
  const body = JSON.stringify({
    token: '', team_id: 'T1', api_app_id: 'A1', type: 'event_callback', event_id: 'EvStandalone',
    event_time: Math.floor(Date.now() / 1_000), event: { type: 'app_context_changed' },
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const ingress = new Hono();
  ingress.route('/channels/slack', slackChannel.route());
  const response = await ingress.request('/channels/slack/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', 'standalone-secret').update(`v0:${timestamp}:${body}`).digest('hex')}`,
    },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal((await stores.config.getWorkspaceInstallation('T1'))?.healthDetail, 'events_verification_pending');
});

test('an installation provisioned before hosts wrote the record is backfilled from its own bot bundle', async (t) => {
  await withHostedInstallation(t, async (h) => {
    assert.equal(await h.stores.config.getWorkspaceInstallation(TEAM), undefined);
    const home = h.event({ type: 'app_home_opened', user: 'U1', tab: 'home' });
    assert.equal((await h.deliver('events', home)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(h.calls, [], 'without its record an installation acts on nothing');

    await assert.rejects(
      backfillHostedWorkspaceInstallation(h.env, { teamId: TEAM, appId: 'AOTHERAPP' }),
      /no bot credentials/,
    );
    const { installation, botUserId } = await backfillHostedWorkspaceInstallation(h.env, { teamId: TEAM, appId: APP.appId });
    assert.equal(botUserId, 'UBOT');
    assert.equal(installation.healthDetail, 'events_verification_pending');
    assert.equal((await h.deliver('events', h.event({ type: 'app_home_opened', user: 'U1', tab: 'home' }))).status, 200);
    await h.settle(() => h.calls.some(({ method }) => method === 'views.publish'));
  }, { record: false });
});

test('only the installation\'s own bot token ends it, in either order, and older events are ignored', async (t) => {
  for (const order of [['tokens_revoked', 'app_uninstalled'], ['app_uninstalled', 'tokens_revoked']] as const) {
    await t.test(order.join(' then '), async (t) => {
      await withHostedInstallation(t, async (h) => {
        const record = () => h.stores.config.getWorkspaceInstallation(TEAM);
        const lifecycle = (type: string, patch: Record<string, unknown> = {}) => h.event(type === 'tokens_revoked'
          ? { type, tokens: { oauth: [], bot: ['UBOT'] } }
          : { type }, patch);
        // A person's user token revoked: the installation stays.
        await h.deliver('events', h.event({ type: 'tokens_revoked', tokens: { oauth: ['U1'] } }));
        assert.notEqual((await record())?.health, 'revoked');
        // Retries of an uninstall from before this installation: ignored.
        await h.deliver('events', lifecycle(order[0], { event_time: 1_700_000_000 }));
        assert.notEqual((await record())?.health, 'revoked');

        await h.deliver('events', lifecycle(order[0]));
        const ended = await record();
        assert.equal(ended?.health, 'revoked');
        assert.equal(ended?.healthDetail, order[0]);
        await h.deliver('events', lifecycle(order[1]));
        await h.deliver('events', lifecycle(order[0]));
        assert.equal((await record())?.revision, ended?.revision, 'the terminal state is reached once');
        // Nothing an ended installation receives reaches Slack.
        await h.deliver('events', h.event({ type: 'app_home_opened', user: 'U1', tab: 'home' }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(h.calls, []);
      });
    });
  }
});

test('two installations with colliding channel, event and message IDs each admit only their own, once', async (t) => {
  await stopNodeTurnRelay();
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-hosted-pair-'));
  const previousFetch = globalThis.fetch;
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'deployment-keyring.json');
  t.after(() => {
    globalThis.fetch = previousFetch;
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  // Each installation's store is its own database, as each has its own state object.
  const tenants = ['a', 'b'].map((name) => ({
    name,
    team: `TTENANT${name.toUpperCase()}`,
    token: `xoxb-tenant-${name}`,
    database: join(directory, `${name}.db`),
    env: withHostedSlackApp(scopeInstallationEnv(HOSTED, { installationId: `inst_tenant_${name}` }), APP),
  }));
  const open = (tenant: typeof tenants[number]) => {
    for (const key of keys.slice(0, 3)) process.env[key] = tenant.database;
    return resolveStores(tenant.env);
  };
  const calls: Array<{ method: string; token: string | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1)!;
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    const tenant = tenants.find((candidate) => candidate.token === token);
    calls.push({ method, token });
    const body = new URLSearchParams(await request.clone().text().catch(() => ''));
    return Response.json(method === 'users.info'
      ? { ok: true, user: { id: body.get('user'), team_id: tenant?.team, name: 'Person', deleted: false, is_bot: false,
          is_app_user: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false } }
      : method === 'conversations.info'
        ? { ok: true, channel: { id: body.get('channel'), is_im: true, user: 'U1' } }
        : { ok: true, ts: '1900000000.000100', channel: 'D1' });
  }) as typeof fetch;
  for (const tenant of tenants) {
    const stores = open(tenant);
    await createSlackOwner(stores.identity, { teamId: tenant.team, userId: 'U1' });
    await writeHostedSlackBotCredentials({ state: stores.identity, keyring: loadCredentialKeyring() }, null, {
      botToken: tenant.token, botUserId: 'UBOT', appId: APP.appId, teamId: tenant.team,
      grantedScopes: ['chat:write'], validatedAt: Date.now(),
    });
    await syncHostedWorkspaceInstallation(tenant.env, { teamId: tenant.team, appId: APP.appId, botUserId: 'UBOT' });
  }

  const ingress = new Hono();
  ingress.route('/channels/slack', slackChannel.route());
  const deliver = (tenant: typeof tenants[number], team: string) => {
    const raw = JSON.stringify({
      token: '', team_id: team, api_app_id: APP.appId, type: 'event_callback', event_id: 'EvColliding',
      event_time: Math.floor(Date.now() / 1_000),
      authorizations: [{ team_id: team, user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
      event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: '1800000001.000100', text: 'Hello' },
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    return ingress.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-slack-request-timestamp': timestamp,
        'x-slack-signature': `v0=${createHmac('sha256', APP.signingSecret).update(`v0:${timestamp}:${raw}`).digest('hex')}`,
      },
      body: raw,
    }, tenant.env);
  };
  const admitted = async (stores: AppStores) => (await stores.slackState.listPendingTurns!())
    .filter((job) => job.id === 'msg:D1:1800000001.000100');
  const settle = async (until: () => Promise<boolean>) => {
    for (let tries = 0; tries < 300 && !await until(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  for (const tenant of tenants) {
    const stores = open(tenant);
    assert.equal((await deliver(tenant, tenant.team)).status, 200);
    await settle(async () => (await admitted(stores)).length === 1);
    // The other tenant's event arriving here is dropped before anything runs.
    const before = calls.length;
    const other = tenants.find((candidate) => candidate !== tenant)!;
    assert.equal((await deliver(tenant, other.team)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.length, before, 'another workspace\'s event reached nothing here');
    // Slack's retry of the same event admits nothing new.
    assert.equal((await deliver(tenant, tenant.team)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const jobs = await admitted(stores);
    assert.equal(jobs.length, 1, `${tenant.name} admitted its event once`);
    assert.equal(jobs[0]!.turn.workspaceId, tenant.team);
  }
  assert.deepEqual([...new Set(calls.map(({ token }) => token))].sort(), tenants.map(({ token }) => token).sort());
});

test('a hosted Agent posts with an avatar URL that names its installation', async (t) => {
  await withHostedInstallation(t, async (h) => {
    await h.stores.config.createAgent({
      id: 'agent_ops', name: 'Ops', instructions: '', enabled: true, lifecycle: 'active',
      creatorMembershipId: h.ownerMembershipId, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'ops', normalizedHandle: 'ops', desiredState: 'unpublished', health: 'unpublished',
        avatar: { kind: 'generated', revision: 1, seed: 'ops' },
      },
    });
    assert.equal((await h.deliver('interactions', {
      type: 'block_actions', api_app_id: APP.appId, team: { id: TEAM }, user: { id: 'U1' }, trigger_id: 'trigger2',
      actions: [{ action_id: 'chickpea.agent.start', value: 'agent_ops', action_ts: '1800000007.000100' }],
    })).status, 200);
    await h.settle(() => h.calls.some(({ method }) => method === 'chat.postMessage'));
    const posted = h.calls.find(({ method }) => method === 'chat.postMessage')!;
    assert.equal(posted.token, BOT_TOKEN);
    assert.equal(posted.body.get('icon_url'), 'https://hosted.example/assets/i/inst_tenant_a/agents/agent_ops/avatar/1');
  });
});

test('a hosted bot bundle that latches recovery on a direct delivery is answered not found, never a server error', async (t) => {
  await withHostedInstallation(t, async (h) => {
    t.mock.method(console, 'error', () => {});
    // The bundle's key slot is gone from the deployment keyring: reading it latches recovery.
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!,
      `${JSON.stringify({ version: 1, ...generateCredentialKeyring('key_unrelated') })}\n`, { mode: 0o600 });
    invalidateSlackInstallationCredentialCache();
    const home = await h.deliver('events', h.event({ type: 'app_home_opened', user: 'U1', tab: 'home' }));
    assert.equal(home.status, 404, 'as the app\'s recovery gate answers');
    assert.equal((await h.stores.identity.getAuthControl())?.healthGate, 'recovery_only');
    const start = await h.deliver('interactions', {
      type: 'block_actions', api_app_id: APP.appId, team: { id: TEAM }, user: { id: 'U1' }, trigger_id: 'trigger_home',
      actions: [{ action_id: START_AGENT_ACTION_ID, value: 'agent_home', action_ts: '1800000006.000100' }],
    });
    assert.equal(start.status, 404);
    assert.deepEqual(h.calls, [], 'nothing reached Slack');
  });
});

test('a hosted keyring that will not load stays a server error on a direct delivery, for Slack to retry', async (t) => {
  await withHostedInstallation(t, async (h) => {
    t.mock.method(console, 'error', () => {});
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!, 'not a keyring', { mode: 0o600 });
    invalidateSlackInstallationCredentialCache();
    const home = await h.deliver('events', h.event({ type: 'app_home_opened', user: 'U1', tab: 'home' }));
    assert.equal(home.status, 500);
    assert.notEqual((await h.stores.identity.getAuthControl())?.healthGate, 'recovery_only', 'nothing latched');
  });
});
