import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { AgentAppLifecycle, AgentSlackPresence, CustomAgentConfig } from '../src/config/types.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { handleAgentAppHomeAction } from '../src/slack/agent-apps/index.ts';
import { AgentSlackApps, type AgentAppTransport } from '../src/slack/agent-apps/service.ts';
import { FINISH_APP_ACTION, START_APP_ACTION } from '../src/slack/agent-apps/pages.ts';
import { saveConfigurationToken } from '../src/slack/agent-apps/secrets.ts';
import type { AgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { formatManagementSetupReceipt } from '../src/management/receipts.ts';
import type { ChickpeaIntroductionAgent } from '../src/management/types.ts';
import { agentDirectoryAppHome, OPEN_AGENT_DM_ACTION_ID, START_AGENT_ACTION_ID } from '../src/slack/app-home.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { escapeMrkdwn } from '../src/slack/ui/text.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const APP = { appId: 'A0APP1', clientId: '1.client' };
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
  addUrl: (agentId) => `https://cloud.test/slack/agent-apps/add/${agentId}`,
};
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });

const refuse = (name: string) => async (): Promise<never> => { throw new Error(`unexpected ${name}`); };
const slack = {
  async rotate() { return { accessToken: 'xoxe.xoxp-1-a', refreshToken: 'xoxe-1-r', teamId: TEAM, expiresAt: NOW + 3_600_000 }; },
  create: refuse('create'), update: refuse('update'), setIcon: refuse('setIcon'), exchange: refuse('exchange'), uninstall: refuse('uninstall'), delete: refuse('delete'),
} as AgentAppSlackApi;
const transport: AgentAppTransport = {
  disableUserGroup: refuse('disableUserGroup'), enableUserGroup: refuse('enableUserGroup'),
  openDirectConversation: refuse('openDirectConversation'), postMessage: refuse('postMessage'),
  lookupChannel: refuse('lookupChannel'), joinPublicChannel: refuse('joinPublicChannel'),
};

function presence(app?: AgentAppLifecycle): AgentSlackPresence {
  const base = { requestedHandle: 'support', normalizedHandle: 'support', avatar: { kind: 'generated' as const, revision: 1, seed: 's' } };
  return app
    ? { kind: 'agent_app', ...base, desiredState: 'active', health: 'pending', app }
    : { ...base, desiredState: 'active', health: 'healthy', userGroupId: 'S1' };
}

function agent(id: string, kind: CustomAgentConfig['kind'], slackPresence: AgentSlackPresence): CustomAgentConfig {
  return {
    id, kind, revision: 1, name: 'Support', instructions: 'x', enabled: true, lifecycle: 'active', editPolicy: 'creator_and_admins',
    configurationGeneration: 1, slackPresence, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

async function service(
  t: TestContext,
  options: { token?: boolean; now?: number; permissionMissing?: boolean; onRead?: (what: string) => void } = {},
) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  const support = await config.createAgent(agent('agent_support', 'user', presence()));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  const keyring = generateCredentialKeyring('k1');
  if (options.token) await saveConfigurationToken({ credentials: settings, keyring, slack }, TEAM, 'xoxe-1-pasted-token-0000');
  const read = options.onRead ?? (() => undefined);
  const watched = Object.assign(Object.create(settings) as SqliteSettingsStore, {
    getEncryptedCredentialRevision: (key: string) => { read(key); return settings.getEncryptedCredentialRevision(key); },
  });
  return new AgentSlackApps({
    env: ENV, stores: { config, settings: watched }, host: HOST, transport, slack, keyring, armSwitch: async () => undefined,
    now: () => options.now ?? NOW, publicOrigin: async () => { read('origin'); return 'https://core.test/'; },
    userGroupPermissionMissing: async () => { read('permission'); return options.permissionMissing ?? false; },
  });
}

const text = (blocks: readonly object[]) => (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text;
const button = (blocks: readonly object[], index = 0) => (blocks[index] as { elements: Array<{ text: { text: string }; url?: string; action_id: string; value?: string }> }).elements[0]!;

test('no Agent is offered its own Slack app from the Home tab, and an Agent with no app record reads nothing', async (t) => {
  const groupless: AgentSlackPresence = { requestedHandle: 'billing', normalizedHandle: 'billing', desiredState: 'unpublished', health: 'unpublished', avatar: { kind: 'generated', revision: 1, seed: 'b' } };
  const agents = [agent('agent_support', 'user', presence()), agent('agent_billing', 'user', groupless), agent(CHICKPEA_AGENT_ID, 'system', presence())];
  for (const options of [{}, { token: true }, { permissionMissing: true }]) {
    const reads: string[] = [];
    const svc = await service(t, { ...options, onRead: (what) => reads.push(what) });
    const rows = await svc.homeRows(agents, { role: 'owner' });
    assert.equal(rows.size, 0, `no start row (${JSON.stringify(options)})`);
    assert.deepEqual(reads, [], 'neither the token nor the permission is read');
  }
});

test('each state reads as its own line, and a sequence stopped for two minutes offers Finish setting up', async (t) => {
  const svc = await service(t, { token: true });
  const rows = async (app: AgentAppLifecycle) => (await svc.homeRows([agent('agent_support', 'user', presence(app))], { role: 'owner' })).get('agent_support')!;
  assert.equal(text(await rows({ state: 'releasing_handle', at: NOW - 1_000, startedBy: 'U1' })), escapeMrkdwn("Setting up @support's own Slack app."));
  const stalled = await rows({ state: 'created', at: NOW - 3 * 60_000, startedBy: 'U1', app: APP });
  assert.equal(text(stalled), escapeMrkdwn("Setting up @support's Slack app stopped partway."));
  assert.equal(button(stalled, 1).text.text, 'Finish setting up');
  assert.equal(button(stalled, 1).url, 'https://cloud.test/slack/agent-apps/add/agent_support', "an add that stopped is finished on the hand-off page");
  assert.equal(button(stalled, 1).value, undefined, 'a link, not an action');
  const waiting = await rows({ state: 'awaiting_consent', at: NOW, startedBy: 'U1', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.0' } });
  assert.equal(text(waiting), escapeMrkdwn("@support's Slack app is ready to add. Choose Allow in Slack to finish."));
  assert.deepEqual([button(waiting, 1).text.text, button(waiting, 1).url], ['Allow in Slack', 'https://cloud.test/slack/agent-apps/add/agent_support']);
  const switching = await rows({ state: 'active', at: NOW - 3 * 60_000, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: NOW, installedBy: 'U1', switchProgress: 'bring_in_pending' });
  assert.deepEqual([button(switching, 1).action_id, button(switching, 1).url], [FINISH_APP_ACTION, undefined], 'a switch after Allow keeps its action');
  assert.equal(text(await rows({ state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: NOW, installedBy: 'U1' })),
    escapeMrkdwn('@support has its own Slack app. People can message @support directly.'));
  assert.equal(text(await rows({ state: 'needs_attention', at: NOW, startedBy: 'U1', reason: 'create_refused', resume: 'creating' })),
    escapeMrkdwn("@support's Slack app needs your attention. Open your messages with Chickpea for details."));
});

test("the directory appends an Agent's row after its section, and the view is unchanged without rows", () => {
  const agents = [agent('agent_support', 'user', presence())];
  const plain = agentDirectoryAppHome(agents) as unknown as { blocks: Array<Record<string, unknown>> };
  const extras = new Map<string, readonly object[]>([['agent_support', [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'row' }] }]]]);
  const withRows = agentDirectoryAppHome(agents, { rowExtras: extras }) as unknown as { blocks: Array<Record<string, unknown>> };
  assert.equal(withRows.blocks.length, plain.blocks.length + 1);
  const section = withRows.blocks.findIndex((block) => block.type === 'section' && (block.accessory as { value?: string } | undefined)?.value === 'agent_support');
  assert.deepEqual(withRows.blocks[section + 1], extras.get('agent_support')![0]);
  assert.deepEqual(agentDirectoryAppHome(agents, { rowExtras: new Map() }), plain);
});

test('a click on an Agent app control is an Owner-only control, and other clicks are not ours', async (t) => {
  configureAgentSlackApps(HOST);
  t.after(() => configureAgentSlackApps(undefined));
  let viewers = 0;
  const told: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const viewer = async () => {
    await gate;
    viewers += 1;
    return { role: 'member', republish: async () => {}, tell: async (text: string) => { told.push(text); } };
  };
  const detached: Promise<void>[] = [];
  const press = (payload: Parameters<typeof handleAgentAppHomeAction>[0]['payload']) =>
    handleAgentAppHomeAction({ env: ENV, payload, viewer, detach: (work) => { detached.push(work); } });
  assert.equal(await press({ type: 'view_submission' }), false);
  assert.equal(await press({ type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'chickpea.agent.start', value: 'agent_support' }] }), false, "the Message button is the directory's");
  assert.equal(viewers + detached.length, 0);
  assert.equal(await press({ type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: FINISH_APP_ACTION, value: 'agent_support' }] }), true);
  assert.deepEqual([viewers, detached.length], [0, 1], 'the press is answered while its work still waits: Slack gets its answer first');
  open();
  await Promise.all(detached);
  assert.deepEqual([viewers, told], [1, []], "a Member's Finish setting up is ours and does nothing");
  configureAgentSlackApps(undefined);
  assert.equal(await press({ type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: START_APP_ACTION, value: 'agent_support' }] }), false, 'without the port the control does not exist');
});

test("the directory's Message opens a live app Agent's own DM only when given the team; every other Agent starts a thread", () => {
  const live: AgentAppLifecycle = { state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: NOW, installedBy: 'U1' };
  const agents = [
    agent('agent_live', 'user', presence(live)),
    agent('agent_waiting', 'user', presence({ state: 'awaiting_consent', at: NOW, startedBy: 'U1', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.0' } })),
    agent('agent_group', 'user', presence()),
  ];
  const buttons = (options?: { agentDmTeamId?: string }) => Object.fromEntries(
    ((agentDirectoryAppHome(agents, options) as unknown as { blocks: Array<{ accessory?: { action_id: string; value: string; url?: string } }> }).blocks)
      .flatMap(({ accessory }) => accessory ? [[accessory.value, [accessory.action_id, accessory.url]]] : []),
  );
  assert.deepEqual(buttons({ agentDmTeamId: TEAM }), {
    agent_live: [OPEN_AGENT_DM_ACTION_ID, `https://slack.com/app_redirect?app=${APP.appId}&team=${TEAM}`],
    agent_waiting: [START_AGENT_ACTION_ID, undefined],
    agent_group: [START_AGENT_ACTION_ID, undefined],
  });
  assert.deepEqual(buttons(), {
    agent_live: [START_AGENT_ACTION_ID, undefined],
    agent_waiting: [START_AGENT_ACTION_ID, undefined],
    agent_group: [START_AGENT_ACTION_ID, undefined],
  });
});

test("the joiner welcome names app Agents to message directly, and keeps today's line when none is listed", () => {
  const welcome = (agents: ChickpeaIntroductionAgent[], more = 0) => formatManagementSetupReceipt({
    kind: 'chickpea_introduction', trigger: 'first_interaction', usable: { agents, more },
  }).split('\n\n').at(-1);
  const close = 'To set up a new Agent for work you repeat, tell me what it should do.';
  const group = { name: 'Finance', handle: 'finance' };
  const sales = { name: 'Sales Desk', handle: 'sales_desk', ownApp: true as const };
  const support = { name: 'Support', handle: 'support', ownApp: true as const };
  assert.equal(welcome([group]), `Mention an Agent in its Channel, or press Message next to it on my Home tab to talk to it privately. ${close}`);
  assert.equal(welcome([sales]), `Mention an Agent in its Channel, or message @sales_desk directly to talk privately. ${close}`);
  assert.equal(welcome([sales, support, { ...support, handle: 'ops' }]),
    `Mention an Agent in its Channel, or message @sales_desk, @support or @ops directly to talk privately. ${close}`);
  assert.equal(welcome([group, support]),
    `Mention an Agent in its Channel, or press Message next to it on my Home tab to talk to it privately. You can also message @support directly. ${close}`);
  assert.equal(welcome([support], 2),
    `Mention an Agent in its Channel, or press Message next to it on my Home tab to talk to it privately. You can also message @support directly. ${close}`,
    'Agents not listed may have no app');
  assert.equal(welcome([{ name: 'Nameless', ownApp: true }, { name: 'Inert', handle: '***', ownApp: true }]),
    `Mention an Agent in its Channel, or press Message next to it on my Home tab to talk to it privately. ${close}`,
    'an app Agent with no handle to write is reached from the Home tab');
});
