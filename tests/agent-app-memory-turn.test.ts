import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { EncryptedCredentialStore } from '../src/config/settings-store.ts';
import { type AppStores, closeNodeStateStores, getMemoryStateStore, resolveStores, type PlatformEnv } from '../src/config/state-backend.ts';
import type { AgentAppLifecycle, CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import { prepareMemoryTurn } from '../src/memory/runtime.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { withAgentAppExecution } from '../src/slack/agent-apps/index.ts';
import { writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { createAgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import type { SlackInstallationExecutionContext } from '../src/slack/installation-execution.ts';
import { invalidateSlackInstallationCredentialCache } from '../src/slack/installation-credentials.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { AGENT_FAILURE_TEXT } from '../src/slack/web-client-presenter.ts';

/**
 * Live retest L3: every turn of an Agent with its own Slack app ended in the
 * generic failure. The turn runs as the app's bot, and the memory delivery
 * lease refused any bot but the workspace's. These turns go through the real
 * memory preparation and lease, as the app's bot, against Slack's API.
 */

const TEAM = 'TTENANT1';
const WORKSPACE_BOT_USER = 'UBOT';
const APP_ID = 'A0AGENT1';
const AGENT_BOT = 'xoxb-agent-bot';
const AGENT_BOT_USER = 'UAGENTBOT';
const FINANCE_BOT_USER = 'UFINANCEBOT';
const MEMORY = 'Refunds go to account 99.';
const ANSWER = 'They go to account 99.';
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};

interface SlackCall { method: string; token: string | undefined; body: string }

interface Harness {
  env: PlatformEnv | undefined;
  stores: AppStores;
  agent: CustomAgentConfig;
  calls: SlackCall[];
  /** What `conversations.history` returns. */
  history: Record<string, unknown>[];
  context(): Promise<SlackInstallationExecutionContext>;
}

const INSTALLED_AT = Date.now() - 60_000;

function liveApp(appId: string, botUserId: string): AgentAppLifecycle {
  return {
    state: 'active', at: INSTALLED_AT, app: { appId, clientId: `${appId}.client` }, icon: 'agent_avatar',
    botUserId, installedAt: INSTALLED_AT, installedBy: 'U1',
  };
}

function appAgent(id: string, name: string, app: AgentAppLifecycle): CustomAgentConfig {
  const handle = name.toLowerCase();
  return {
    id, kind: 'user', revision: 1, name, instructions: `You are ${name}.`, enabled: true,
    lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1, model: 'local-stub/agent-app',
    slackPresence: {
      kind: 'agent_app', requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: handle }, app, released: { userGroupId: `S${name.toUpperCase()}` },
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

async function withHarness(t: TestContext, run: (h: Harness) => Promise<void>): Promise<void> {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-agent-app-memory-'));
  for (const key of keys.slice(0, 3)) process.env[key] = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  const previousFetch = globalThis.fetch;
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
  configureAgentSlackApps(HOST);
  t.after(() => {
    globalThis.fetch = previousFetch;
    configureAgentSlackApps(undefined);
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });

  // The memory lease is the same on every deployment; a standalone one runs the stub model.
  const env: PlatformEnv | undefined = undefined;
  const stores = resolveStores(env);
  const agent = await stores.config.createAgent(appAgent('agent_support', 'Support', liveApp(APP_ID, AGENT_BOT_USER)));
  const installation = await stores.config.ensureWorkspaceInstallation({
    workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: agent.id, botUserId: WORKSPACE_BOT_USER,
  });
  await stores.config.updateWorkspaceInstallation(TEAM, { health: 'healthy' }, installation.revision);
  await stores.config.putAgentChannelGrant({
    workspaceId: TEAM, channelId: 'C1', agentId: agent.id, status: 'active',
    createdByMembershipId: 'membership_owner', channelLabel: 'team', channelIsPrivate: false,
  });
  await getMemoryStateStore(env).putAgentMemory({ agentId: agent.id, body: MEMORY, expectedRevision: 0 });
  await writeAppSecrets(
    { credentials: stores.settings as unknown as EncryptedCredentialStore, keyring: loadCredentialKeyring(), slack: createAgentAppSlackApi() },
    APP_ID, agent.id, { clientSecret: 'cs', signingSecret: 'ss', botToken: AGENT_BOT }, null,
  );

  const calls: SlackCall[] = [];
  const history: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    assert.equal(url.hostname, 'slack.com', `no call leaves for ${url.hostname}`);
    const method = url.pathname.split('/').at(-1)!;
    const body = await request.clone().text().catch(() => '');
    const form = new URLSearchParams(body);
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? form.get('token') ?? undefined;
    calls.push({ method, token, body });
    const channel = form.get('channel') ?? 'C1';
    const answer = method === 'auth.test'
      ? { ok: true, team_id: TEAM, user_id: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: APP_ID }
      : method === 'users.info'
        ? { ok: true, user: { id: form.get('user'), team_id: TEAM, name: 'person', deleted: false, is_bot: false } }
        : method === 'conversations.info'
          ? { ok: true, channel: channel.startsWith('C')
            ? { id: channel, context_team_id: TEAM, name: 'team', is_channel: true, is_member: true }
            : { id: channel, is_im: true, user: 'U1' } }
          // The Channel holds the person and the Agent's bot; the workspace's bot was never added.
          : method === 'conversations.members'
            ? { ok: true, members: ['U1', AGENT_BOT_USER], response_metadata: { next_cursor: '' } }
            : method === 'conversations.replies' || method === 'conversations.history'
              ? { ok: true, messages: method === 'conversations.history' ? history : [] }
              : method.startsWith('chat.')
                ? { ok: true, ts: '1900000000.000200', channel }
                : { ok: true };
    return Response.json(answer);
  }) as typeof fetch;

  // The installation's own resolution, as hosted resolves it: the workspace's bot.
  const base: SlackInstallationExecutionContext = {
    workspaceId: TEAM, transportMode: 'direct', sharedAppReads: false, botToken: 'xoxb-workspace-bot',
    botUserId: WORKSPACE_BOT_USER, client: {} as SlackInstallationExecutionContext['client'],
  };
  const resolve = withAgentAppExecution(async () => base, env);
  await run({ env, stores, agent, calls, history, context: () => resolve(TEAM, agent.id) });
}

function assignmentFor(agent: CustomAgentConfig, channelId: string): ResolvedAssignment {
  return {
    workspaceId: TEAM, channelId, agentId: agent.id, agent, model: 'local-stub/agent-app',
    modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  };
}

/** What a Slack call carried, readable whether it was sent as a form or as JSON. */
function readable(body: string): string {
  return body.startsWith('{') ? body : [...new URLSearchParams(body).values()].join('\n');
}

/** Runs the turn as the Agent's own bot; returns what the model saw and what Slack was sent. */
async function runAsTheAppBot(
  h: Harness,
  turn: NormalizedSlackTurn,
  duringRun: () => Promise<void> = async () => undefined,
): Promise<{ memoryBlocks: Array<string | undefined>; prompts: string[]; posted: string }> {
  const context = await h.context();
  assert.equal(context.botUserId, AGENT_BOT_USER, "the turn runs as the Agent's own bot");
  const memoryBlocks: Array<string | undefined> = [];
  const prompts: string[] = [];
  const before = h.calls.length;
  await runTurn(turn, assignmentFor(h.agent, turn.channelId), h.env, {
    installationContext: context,
    usageRecordingEnabled: false,
    agentPrompt: async (input) => {
      memoryBlocks.push(input.memoryBlock);
      prompts.push(input.message);
      await duringRun();
      return {
        text: ANSWER, requestedModel: 'local-stub/agent-app', returnedModel: null,
        reportedUsage: null, usageCompleteness: 'not_reported' as const,
      };
    },
  });
  const calls = h.calls.slice(before);
  const chat = calls.filter((call) => call.method.startsWith('chat.'));
  assert.ok(chat.every((call) => call.token === AGENT_BOT), "every post is the Agent's bot's");
  assert.equal(calls.some((call) => call.token === 'xoxb-workspace-bot'), false, "the workspace's bot is never used");
  return { memoryBlocks, prompts, posted: chat.map((call) => readable(call.body)).join('\n') };
}

async function expectAnsweredFromMemory(h: Harness, turn: NormalizedSlackTurn): Promise<void> {
  const { memoryBlocks, posted } = await runAsTheAppBot(h, turn);
  assert.equal(posted.includes(AGENT_FAILURE_TEXT), false, 'the turn did not end in the generic failure');
  assert.equal(memoryBlocks.length, 1, 'the model ran once');
  assert.match(memoryBlocks[0] ?? '', /account 99/, "the Agent's memory reached the model");
  assert.ok(posted.includes(ANSWER), 'the answer was posted');
}

const at = (seconds: number) => `${1900000000 + seconds}.000100`;

function dmTurn(seconds: number): NormalizedSlackTurn {
  return {
    workspaceId: TEAM, channelId: 'D1', channelType: 'im', eventId: `EvDM${seconds}`, text: 'Where do refunds go?',
    userId: 'U1', messageTs: at(seconds), threadTs: at(seconds), source: 'dm_message', contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

/** Archiving uninstalls the app first; the record keeps its bot meanwhile. */
async function startUninstalling(h: Harness): Promise<void> {
  const current = await h.stores.config.getAgent(h.agent.id);
  assert.equal(current.slackPresence?.kind, 'agent_app');
  const app: AgentAppLifecycle = {
    state: 'uninstalling', at: Date.now(), startedBy: 'U1', app: { appId: APP_ID, clientId: `${APP_ID}.client` }, botUserId: AGENT_BOT_USER, next: 'uninstall',
  };
  await h.stores.config.updateAgent(current.id, { slackPresence: { ...current.slackPresence!, app } }, current.revision);
}

test("an Agent's own app answers a DM from its memory, not with the generic failure", async (t) => withHarness(t, async (h) => {
  await expectAnsweredFromMemory(h, dmTurn(1));
}));

function channelMention(seconds: number): NormalizedSlackTurn {
  return {
    workspaceId: TEAM, channelId: 'C1', channelType: 'channel', eventId: `EvCH${seconds}`, text: `<@${AGENT_BOT_USER}> where do refunds go?`,
    userId: 'U1', messageTs: at(seconds), threadTs: at(seconds), source: 'app_mention', contextMode: 'channel_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

test("an Agent's own app answers a Channel mention from its memory, its own bot being the Channel member", async (t) => withHarness(t, async (h) => {
  await expectAnsweredFromMemory(h, channelMention(2));
  const membership = h.calls.filter((call) => call.method === 'conversations.members');
  assert.ok(membership.length > 0, 'the lease checked the Channel');
  assert.ok(membership.every((call) => call.token === AGENT_BOT), "with the Agent's own bot");
}));

/** Support's memory turn in its DM, prepared as if `botUserId` were delivering it. */
async function dmLease(h: Harness, botUserId: string) {
  return prepareMemoryTurn({
    turn: {
      workspaceId: TEAM, channelId: 'D1', channelType: 'im', eventId: 'EvLease', text: 'Where do refunds go?',
      userId: 'U1', messageTs: at(3), threadTs: at(3), source: 'dm_message', contextMode: 'dm_history',
    },
    assignment: assignmentFor(h.agent, 'D1'),
    platformEnv: h.env,
    client: {} as SlackInstallationExecutionContext['client'],
    botToken: 'xoxb-unused',
    botUserId,
  });
}

test("another Agent's app bot never delivers this Agent's memory; the workspace's bot still does", async (t) => withHarness(t, async (h) => {
  await h.stores.config.createAgent(appAgent('agent_finance', 'Finance', liveApp('A0FINANCE', FINANCE_BOT_USER)));
  const prepared = await dmLease(h, FINANCE_BOT_USER);
  assert.match(prepared.promptBlock ?? '', /account 99/, 'preparation does not decide delivery');
  assert.equal(await prepared.validateLease(), false, "Finance's bot is this installation's, but not Support's");
  assert.equal(await (await dmLease(h, 'USTRANGER')).validateLease(), false, 'a bot that is nobody here');
  assert.equal(await (await dmLease(h, WORKSPACE_BOT_USER)).validateLease(), true, "the installation's own bot");
  assert.equal(await (await dmLease(h, AGENT_BOT_USER)).validateLease(), true, "Support's own app bot");
}));

test("an Agent app that stops being live before delivery ends the lease its turn was prepared under", async (t) => withHarness(t, async (h) => {
  const prepared = await dmLease(h, AGENT_BOT_USER);
  await startUninstalling(h);
  assert.equal(await prepared.validateLease(), false);
}));

test('a memory lease that ends a turn in the generic failure logs one operator line with why; the reply says nothing more', async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const failures = () => warn.mock.calls
    .map((call) => call.arguments[0] as { event?: string })
    .filter((line) => line?.event === 'chickpea.turn.agent_failure');

  const changed = await runAsTheAppBot(h, dmTurn(5), async () => {
    await getMemoryStateStore(h.env).putAgentMemory({ agentId: h.agent.id, body: 'Refunds go to account 7.', expectedRevision: 1 });
  });
  assert.ok(changed.posted.includes(AGENT_FAILURE_TEXT), 'memory changed while the model ran');
  assert.deepEqual(failures(), [
    { event: 'chickpea.turn.agent_failure', reason: 'memory_delivery_lease_rejected', stage: 'after_run', agentId: h.agent.id },
  ]);

  // The turn already holds the app's bot (resolved once per Agent) when the archive starts.
  await startUninstalling(h);
  const ended = await runAsTheAppBot(h, dmTurn(6));
  assert.equal(ended.memoryBlocks.length, 0, 'the model never ran');
  assert.ok(ended.posted.includes(AGENT_FAILURE_TEXT), 'the app is being uninstalled');
  assert.deepEqual(failures().slice(1), [
    { event: 'chickpea.turn.agent_failure', reason: 'memory_delivery_lease_rejected', stage: 'before_run', agentId: h.agent.id },
  ]);
  for (const posted of [changed.posted, ended.posted]) {
    assert.equal(/memory_delivery_lease_rejected|before_run|after_run|agent_failure/.test(posted), false, 'nothing diagnostic reaches Slack');
  }
}));

test("an app Agent's Channel history reads Chickpea's bot and other Agent apps as Agents, and its own posts too", async (t) => withHarness(t, async (h) => {
  await h.stores.config.createAgent(appAgent('agent_finance', 'Finance', liveApp('A0FINANCE', FINANCE_BOT_USER)));
  h.history.push(
    { user: FINANCE_BOT_USER, bot_id: 'BFINANCE', app_id: 'A0FINANCE', bot_profile: { app_id: 'A0FINANCE', name: 'finance' }, text: 'The books are closed.', ts: at(13) },
    { user: WORKSPACE_BOT_USER, bot_id: 'BCHICKPEA', username: 'Billing', text: 'Invoices went out.', ts: at(12) },
    { user: AGENT_BOT_USER, bot_id: 'BAGENT', app_id: APP_ID, bot_profile: { app_id: APP_ID, name: 'support' }, text: 'Refunds are queued.', ts: at(11) },
    { bot_id: 'B_PD', username: 'PagerDuty', text: 'checkout is down', ts: at(10) },
  );
  const { prompts } = await runAsTheAppBot(h, channelMention(20));
  assert.equal(prompts.length, 1);
  const labels = [...prompts[0]!.matchAll(/role=(\w+)[^\]]*\] "([^"]+)":/g)].map(([, role, name]) => [name, role]);
  assert.deepEqual(labels, [['PagerDuty', 'app'], ['support', 'agent'], ['Billing', 'agent'], ['finance', 'agent']],
    "Finance's app and Chickpea's bot (another Agent) are Agents, not apps; an outside app stays an app");
}));

test('a turn whose memory could not be prepared logs that it was quarantined, not that its lease was refused', async (t) => withHarness(t, async (h) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  t.mock.method(getMemoryStateStore(h.env), 'getAgentMemory', async () => {
    throw new Error('memory row unreadable');
  });
  const { memoryBlocks, posted } = await runAsTheAppBot(h, dmTurn(30));
  assert.equal(memoryBlocks.length, 0, 'the model never ran');
  assert.ok(posted.includes(AGENT_FAILURE_TEXT));
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments[0] as { event?: string }).filter((line) => line?.event === 'chickpea.turn.agent_failure'),
    [{ event: 'chickpea.turn.agent_failure', reason: 'memory_quarantined', stage: 'before_run', agentId: h.agent.id }],
  );
}));
