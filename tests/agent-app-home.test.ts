import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { AgentAppLifecycle, AgentSlackPresence, CustomAgentConfig } from '../src/config/types.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, type AgentAppTransport, handleAgentAppHomeAction } from '../src/slack/agent-apps/index.ts';
import { START_APP_ACTION } from '../src/slack/agent-apps/pages.ts';
import { saveConfigurationToken } from '../src/slack/agent-apps/secrets.ts';
import type { AgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { agentDirectoryAppHome } from '../src/slack/app-home.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { escapeMrkdwn } from '../src/slack/ui/text.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const APP = { appId: 'A0APP1', clientId: '1.client' };
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
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

async function service(t: TestContext, options: { token?: boolean; now?: number; permissionMissing?: boolean } = {}) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  const support = await config.createAgent(agent('agent_support', 'user', presence()));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  const keyring = generateCredentialKeyring('k1');
  if (options.token) await saveConfigurationToken({ credentials: settings, keyring, slack }, TEAM, 'xoxe-1-pasted-token-0000');
  return new AgentSlackApps({
    env: ENV, stores: { config, settings }, host: HOST, transport, slack, keyring,
    now: () => options.now ?? NOW, publicOrigin: async () => 'https://core.test/',
    userGroupPermissionMissing: async () => options.permissionMissing ?? false,
  });
}

const text = (blocks: readonly object[]) => (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text;
const button = (blocks: readonly object[], index = 0) => (blocks[index] as { elements: Array<{ text: { text: string }; url?: string; action_id: string; value?: string }> }).elements[0]!;

test('an Owner sees a link to the token page without a token, and a click button with one; nobody else sees anything', async (t) => {
  const agents = [agent('agent_support', 'user', presence()), agent(CHICKPEA_AGENT_ID, 'system', presence())];
  const noToken = await (await service(t)).homeRows(agents, { role: 'owner' });
  assert.deepEqual([...noToken.keys()], ['agent_support'], "the system Agent's row shows nothing");
  const offer = button(noToken.get('agent_support')!);
  assert.equal(offer.text.text, escapeMrkdwn('Give @support its own Slack app'));
  assert.equal(offer.url, 'https://core.test/admin/agents/agent_support/slack-app');

  const withToken = await (await service(t, { token: true })).homeRows(agents, { role: 'owner' });
  const click = button(withToken.get('agent_support')!);
  assert.equal(click.url, undefined, 'with a token the button is a plain click');
  assert.equal(click.action_id, START_APP_ACTION);
  assert.equal(click.value, 'agent_support');

  for (const role of ['admin', 'member', undefined]) {
    assert.equal((await (await service(t, { token: true })).homeRows(agents, { role })).size, 0, `${role ?? 'a guest'} sees nothing`);
  }
});

test("without the Owner's user-group permission the offer becomes a line that sends the Owner to Admin's update", async (t) => {
  const groupless: AgentSlackPresence = { requestedHandle: 'billing', normalizedHandle: 'billing', desiredState: 'unpublished', health: 'unpublished', avatar: { kind: 'generated', revision: 1, seed: 'b' } };
  const agents = [agent('agent_support', 'user', presence()), agent('agent_billing', 'user', groupless)];
  for (const token of [false, true]) {
    const rows = await (await service(t, { token, permissionMissing: true })).homeRows(agents, { role: 'owner' });
    const blocks = rows.get('agent_support')!;
    assert.equal(text(blocks), escapeMrkdwn('Chickpea needs one more Slack permission to give @support its own Slack app. In Chickpea Admin, choose Update in Slack.'));
    const link = button(blocks, 1);
    assert.equal(link.text.text, 'Open Chickpea');
    assert.equal(link.url, 'https://core.test/admin');
    assert.equal(blocks.length, 2, 'no Give button');
    assert.equal(button(rows.get('agent_billing')!).text.text, escapeMrkdwn('Give @billing its own Slack app'),
      'an Agent with no user group to free is still offered the app');
  }
  const held = await (await service(t, { token: true })).homeRows(agents, { role: 'owner' });
  assert.equal(button(held.get('agent_support')!).action_id, START_APP_ACTION, 'with the permission the Owner can start again');
  assert.equal((await (await service(t, { permissionMissing: true })).homeRows(agents, { role: 'admin' })).size, 0, 'only Owners see it');
});

test('each state reads as its own line, and a sequence stopped for two minutes offers Finish setting up', async (t) => {
  const svc = await service(t, { token: true });
  const rows = async (app: AgentAppLifecycle) => (await svc.homeRows([agent('agent_support', 'user', presence(app))], { role: 'owner' })).get('agent_support')!;
  assert.equal(text(await rows({ state: 'releasing_handle', at: NOW - 1_000, startedBy: 'U1' })), escapeMrkdwn("Setting up @support's own Slack app."));
  const stalled = await rows({ state: 'created', at: NOW - 3 * 60_000, startedBy: 'U1', app: APP });
  assert.equal(text(stalled), escapeMrkdwn("Setting up @support's Slack app stopped partway."));
  assert.equal(button(stalled, 1).text.text, 'Finish setting up');
  assert.equal(text(await rows({ state: 'awaiting_consent', at: NOW, startedBy: 'U1', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.0' } })),
    escapeMrkdwn("@support's Slack app is ready to add. Open your messages with Chickpea to allow it."));
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
  const viewer = async () => { viewers += 1; return { role: 'member', republish: async () => {} }; };
  assert.equal(await handleAgentAppHomeAction({ env: ENV, payload: { type: 'view_submission' }, viewer }), false);
  assert.equal(await handleAgentAppHomeAction({ env: ENV, payload: { type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'chickpea.agent.start', value: 'agent_support' }] }, viewer }), false, "the Message button is the directory's");
  assert.equal(viewers, 0);
  assert.equal(await handleAgentAppHomeAction({ env: ENV, payload: { type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: START_APP_ACTION, value: 'agent_support' }] }, viewer }), true);
  assert.equal(viewers, 1, "a Member's click is ours and does nothing");
  configureAgentSlackApps(undefined);
  assert.equal(await handleAgentAppHomeAction({ env: ENV, payload: { type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: START_APP_ACTION, value: 'agent_support' }] }, viewer }), false, 'without the port the control does not exist');
});
