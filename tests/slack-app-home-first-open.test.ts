import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import { formatManagementSetupReceipt } from '../src/management/receipts.ts';
import type { ManagementReceipt } from '../src/management/types.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const FIRST_PROMPTS = [
  { title: 'Create my first Agent', message: 'Help me create my first Agent. Ask me what my team works on.' },
  { title: 'Ideas for my team', message: 'What kinds of Agents could help my team?' },
  { title: 'Connect a tool', message: 'Which tools can my Agents connect to?' },
];
const JOINER_PROMPTS = [
  { title: 'What can our Agents do?', message: 'Which Agents can I use, and what does each one do?' },
  { title: 'Set up a new Agent', message: 'Help me set up a new Agent. Ask me what I work on.' },
  { title: 'Connect a tool', message: 'Which tools can my Agents connect to?' },
];
const NO_AGENTS = { kind: 'chickpea_introduction', trigger: 'first_interaction', usable: { agents: [], more: 0 } };

interface Harness {
  stores: AppStores;
  calls: Array<{ operation: string; input: Record<string, unknown> }>;
  warnings: unknown[][];
  openAppHome(user: string, tab: string): Promise<void>;
  claimDueOutbox(): Promise<Array<{ destination: unknown; receipt: ManagementReceipt }>>;
  /** A live user Agent placed in these Channels. */
  placeAgent(id: string, name: string, description: string, channelIds: string[]): Promise<void>;
}

async function withGatewayInstallation(
  t: TestContext,
  options: {
    refusePrompts?: string;
    /** Slack's Channels by id: whether each is private. The bot is in each. */
    channels?: Record<string, { private: boolean }>;
    /** The Channels each person is in. */
    memberChannels?: Record<string, string[]>;
  } = {},
): Promise<Harness> {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = ':memory:';
  closeNodeStateStores();
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  t.after(() => {
    console.warn = warn;
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  const stores = resolveStores();
  const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
  await stores.config.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT', gatewayBindingId: 'binding1',
  });
  const calls: Harness['calls'] = [];
  const gateway = {
    workspaceId: 'T1',
    async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' }; },
    async call(operation: string, input: Record<string, unknown>) {
      calls.push({ operation, input });
      if (operation === 'users.info') {
        return { user: {
          id: input.user, team_id: 'T1', name: String(input.user), deleted: false, is_bot: false,
          is_app_user: false, is_restricted: input.user === 'UGUEST', is_ultra_restricted: false, is_stranger: false,
        } };
      }
      if (operation === 'assistant.threads.setSuggestedPrompts' && options.refusePrompts) {
        throw new SlackTransportError(operation, options.refusePrompts, { effectOutcome: 'failed' });
      }
      if (operation === 'assistant.threads.setSuggestedPrompts' || operation === 'views.publish') return {};
      if (operation === 'users.conversations') {
        return { channels: (options.memberChannels?.[String(input.user)] ?? []).map((id) => ({ id })) };
      }
      const channel = operation === 'conversations.info' ? options.channels?.[String(input.channel)] : undefined;
      if (channel) {
        return { channel: { id: input.channel, is_private: channel.private, is_member: true, is_archived: false } };
      }
      throw new Error(`Unexpected gateway operation: ${operation}`);
    },
  } as unknown as GatewayDeploymentClient;
  let events = 0;
  return {
    stores,
    calls,
    warnings,
    async placeAgent(id, name, description, channelIds) {
      await stores.config.createAgent({
        id, name, description, instructions: 'Help.', enabled: true, lifecycle: 'active',
        creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
        skills: [], mcpServers: [], apiConnections: [], repositories: [],
      });
      for (const channelId of channelIds) {
        await stores.config.putAgentChannelGrant({
          workspaceId: 'T1', channelId, agentId: id, createdByMembershipId: owner.membership.id, status: 'active',
        });
      }
    },
    async openAppHome(user, tab) {
      events += 1;
      assert.equal(await processGatewaySlackEnvelope({
        workspaceId: 'T1', eventId: `EvHome${events}`, eventTime: 1_800_000_000 + events,
        event: { type: 'app_home_opened', user, channel: `D_${user}`, tab, event_ts: `1800000000.00000${events}` },
      }, undefined, gateway, { stores }), 'accepted');
    },
    async claimDueOutbox() {
      const now = Date.now();
      return (await stores.management.claimDueOutbox(now + 1, 10, now + 30_000))
        .map(({ destination, receipt }) => ({ destination, receipt: receipt as ManagementReceipt }));
    },
  };
}

const ofOperation = (h: Harness, operation: string) =>
  h.calls.filter((call) => call.operation === operation).map(({ input }) => input);

test('opening the Messages tab offers the first prompts and greets a member once', async (t) => {
  const h = await withGatewayInstallation(t);
  await h.openAppHome('U1', 'messages');
  await h.openAppHome('U1', 'messages');
  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), [
    { channel_id: 'D_U1', prompts: FIRST_PROMPTS },
    { channel_id: 'D_U1', prompts: FIRST_PROMPTS },
  ], 'every Messages open sets the prompts for the whole DM, never one thread');
  assert.deepEqual(await h.claimDueOutbox(), [{
    destination: { kind: 'slack_dm', workspaceId: 'T1', slackUserId: 'U1' },
    receipt: NO_AGENTS,
  }]);
  assert.equal(ofOperation(h, 'views.publish').length, 2);
  assert.deepEqual(h.warnings, []);
});

test('a teammate who can use an Agent is welcomed with it and its Channel, and offered the joiner prompts', async (t) => {
  const h = await withGatewayInstallation(t, {
    channels: { C01SUPPORT: { private: false }, C02NEWHIRES: { private: true }, C03FINANCE: { private: true } },
    memberChannels: { U2: ['C02NEWHIRES'] },
  });
  await h.placeAgent('agent_support', 'Support Desk', 'Answers order, shipping and returns questions. Escalates refunds.', ['C01SUPPORT']);
  await h.placeAgent('agent_onboarding', 'Onboarding Guide', 'Helps new teammates find the right Channel and person.', ['C03FINANCE', 'C02NEWHIRES']);
  await h.placeAgent('agent_finance', 'Finance Desk', 'Answers expense questions.', ['C03FINANCE']);
  await h.openAppHome('U2', 'messages');

  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), [
    { channel_id: 'D_U2', prompts: JOINER_PROMPTS },
  ]);
  const queued = await h.claimDueOutbox();
  assert.deepEqual(queued, [{
    destination: { kind: 'slack_dm', workspaceId: 'T1', slackUserId: 'U2' },
    receipt: {
      kind: 'chickpea_introduction',
      trigger: 'first_interaction',
      usable: {
        agents: [
          {
            name: 'Onboarding Guide', handle: 'onboarding-guide',
            purpose: 'Helps new teammates find the right Channel and person.', channelId: 'C02NEWHIRES',
          },
          {
            name: 'Support Desk', handle: 'support-desk',
            purpose: 'Answers order, shipping and returns questions.', channelId: 'C01SUPPORT',
          },
        ],
        more: 0,
      },
    },
  }], 'Finance Desk, only in a private Channel this person is not in, is not listed; nor is that Channel');
  assert.equal(formatManagementSetupReceipt(queued[0]!.receipt), [
    'Hi, I’m *Chickpea*. Your team uses me to set up AI Agents here in Slack. You can already use these:',
    [
      '• *Onboarding Guide* @onboarding-guide in <#C02NEWHIRES>: Helps new teammates find the right Channel and person.',
      '• *Support Desk* @support-desk in <#C01SUPPORT>: Answers order, shipping and returns questions.',
    ].join('\n'),
    'Mention an Agent in its Channel, or press Message next to it on my Home tab to talk to it privately. To set up a new Agent for work you repeat, tell me what it should do.',
  ].join('\n\n'));
  assert.equal(ofOperation(h, 'views.publish').length, 1);
  assert.equal(ofOperation(h, 'users.conversations').length, 1, 'one read of the person\'s Channels serves the Home tab, the prompts and the welcome');
  assert.deepEqual(h.warnings, []);
});

test('a teammate whose only Agent is in a private Channel they are not in gets the first prompts and the no-Agents welcome', async (t) => {
  const h = await withGatewayInstallation(t, { channels: { C03FINANCE: { private: true } } });
  await h.placeAgent('agent_finance', 'Finance Desk', 'Answers expense questions.', ['C03FINANCE']);
  await h.openAppHome('U2', 'messages');

  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), [
    { channel_id: 'D_U2', prompts: FIRST_PROMPTS },
  ]);
  const queued = await h.claimDueOutbox();
  assert.deepEqual(queued.map(({ receipt }) => receipt), [NO_AGENTS]);
  assert.doesNotMatch(formatManagementSetupReceipt(queued[0]!.receipt), /Finance Desk|C03FINANCE/);
});

test('when Slack cannot confirm any Agent for the person, the welcome stores no list', async (t) => {
  const h = await withGatewayInstallation(t, { channels: {} });
  await h.placeAgent('agent_support', 'Support Desk', 'Answers order questions.', ['C04UNREACHABLE']);
  await h.openAppHome('U2', 'messages');

  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), [
    { channel_id: 'D_U2', prompts: FIRST_PROMPTS },
  ]);
  assert.deepEqual((await h.claimDueOutbox()).map(({ receipt }) => receipt), [
    { kind: 'chickpea_introduction', trigger: 'first_interaction' },
  ]);
});

test('opening the Home tab offers no prompts and greets nobody', async (t) => {
  const h = await withGatewayInstallation(t);
  await h.openAppHome('U1', 'home');
  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), []);
  assert.deepEqual(await h.claimDueOutbox(), []);
  assert.equal(ofOperation(h, 'views.publish').length, 1);
});

test('a guest opening the Messages tab gets the prompts but no introduction', async (t) => {
  const h = await withGatewayInstallation(t);
  await h.openAppHome('UGUEST', 'messages');
  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), [
    { channel_id: 'D_UGUEST', prompts: FIRST_PROMPTS },
  ]);
  assert.deepEqual(await h.claimDueOutbox(), []);
  assert.equal(ofOperation(h, 'views.publish').length, 1);
});

test('an app with static prompts refuses them quietly; the App Home and the introduction still go out', async (t) => {
  const h = await withGatewayInstallation(t, { refusePrompts: 'static_prompts_configured' });
  await h.openAppHome('U1', 'messages');
  assert.equal(ofOperation(h, 'assistant.threads.setSuggestedPrompts').length, 1);
  assert.equal(ofOperation(h, 'views.publish').length, 1);
  assert.equal((await h.claimDueOutbox()).length, 1);
  assert.deepEqual(h.warnings, [], 'every standalone app made with static prompts answers this');
});

test('any other refusal of the prompts is logged by its code alone and blocks nothing', async (t) => {
  const h = await withGatewayInstallation(t, { refusePrompts: 'channel_not_found' });
  await h.openAppHome('U1', 'messages');
  assert.equal(ofOperation(h, 'views.publish').length, 1);
  assert.equal((await h.claimDueOutbox()).length, 1);
  assert.deepEqual(h.warnings, [['[chickpea] Slack suggested prompts refused:', 'channel_not_found']]);
});
