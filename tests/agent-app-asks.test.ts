import assert from 'node:assert/strict';
import { test } from 'node:test';

import { processGatewaySlackEnvelope, processSlackAgentAsks } from '../src/channels/slack.ts';
import { agentTeammateHandles } from '../src/config/effective-config.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import type { AgentSlackPresence, CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import { createAgentAskCollector, mentionedBotUsers, personRequestText, type SlackAgentAskRequest } from '../src/slack/agent-asks.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { liveAgentMention } from '../src/slack/message-format.ts';
import { toContextMessages } from '../src/slack/thread-context.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { normalizeSlackTurn } from '../src/slack/turn-normalization.ts';
import type { SlackEventFixture } from '../src/slack/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_800_000_000_000;
const FINANCE_BOT = 'UBOTFIN';
const OWNER = {
  id: 'U1', team_id: 'T1', name: 'owner', deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, is_stranger: false,
};

function groupPresence(handle: string): AgentSlackPresence {
  return {
    requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy',
    avatar: { kind: 'generated', revision: 1, seed: handle }, userGroupId: `S${handle.toUpperCase()}`,
  };
}

const financeApp: AgentSlackPresence = {
  kind: 'agent_app', requestedHandle: 'finance', normalizedHandle: 'finance', desiredState: 'active', health: 'healthy',
  avatar: { kind: 'generated', revision: 1, seed: 'finance' }, released: { userGroupId: 'SFINANCE' },
  app: { state: 'active', at: NOW, app: { appId: 'A0FIN', clientId: '1.c' }, icon: 'agent_avatar', botUserId: FINANCE_BOT, installedAt: NOW, installedBy: 'U1' },
};

function agentInput(id: string, name: string, presence: AgentSlackPresence, creatorMembershipId: string) {
  return {
    id, name, instructions: `Help with ${name}.`, enabled: true, lifecycle: 'active' as const,
    creatorMembershipId, editPolicy: 'creator_and_admins' as const,
    model: `local-stub/${id}`, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: presence,
  };
}

interface Lane {
  stores: ReturnType<typeof resolveStores>;
  gateway: GatewayDeploymentClient;
  jobs: TurnJob[];
  enqueueTurn: (job: TurnJob) => Promise<{ ok: true; value: null }>;
}

/** Support has a user group; Finance answers as its own app's bot. Both are granted in C1. */
async function withLane(scenario: (lane: Lane) => Promise<void>): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    const agents: CustomAgentConfig[] = [
      await stores.config.createAgent(agentInput('agent_support', 'Support', groupPresence('support'), owner.membership.id)),
      await stores.config.createAgent(agentInput('agent_finance', 'Finance', financeApp, owner.membership.id)),
    ];
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT', gatewayBindingId: 'binding1', runtimeContract: 'chickpea-v1',
    });
    await stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'team', lifecycle: 'active' }, 0);
    for (const agent of agents) {
      await stores.config.putAgentChannelGrant({
        workspaceId: 'T1', channelId: 'C1', agentId: agent.id, status: 'active',
        createdByMembershipId: owner.membership.id, channelLabel: 'team', channelIsPrivate: false,
      }, 0);
    }
    const liveChannel = { id: 'C1', name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false };
    const posts: Array<Record<string, unknown>> = [];
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' }; },
      async call(operation: string, args: Record<string, unknown>) {
        if (operation === 'users.info') return { user: OWNER };
        if (operation === 'conversations.info') return { channel: liveChannel };
        if (operation === 'conversations.members') return { members: ['U1', 'UBOT', FINANCE_BOT] };
        if (operation === 'users.conversations') return { channels: [liveChannel] };
        if (operation === 'chat.postMessage') { posts.push(args); return { ok: true, ts: `9000.00000${posts.length}`, channel: 'C1' }; }
        if (operation === 'chat.postEphemeral') { posts.push({ ...args, ephemeral: true }); return { ok: true }; }
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
    const jobs: TurnJob[] = [];
    const enqueueTurn = async (job: TurnJob) => {
      if (!jobs.some(({ id }) => id === job.id)) jobs.push(job);
      return { ok: true as const, value: null };
    };
    await scenario({ stores, gateway, jobs, enqueueTurn });
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
}

test('an Agent asks a teammate with its own app by its bot user, and that teammate answers once as itself', async () => {
  await withLane(async ({ stores, gateway, jobs, enqueueTurn }) => {
    await processGatewaySlackEnvelope({
      workspaceId: 'T1', eventId: 'Ev3000', eventTime: 3000,
      event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '3000.000100', text: '<!subteam^SSUPPORT|@support> What was Q3 revenue?' },
    }, undefined, gateway, { stores, enqueueTurn });
    assert.equal(jobs.length, 1);
    const supportJob = jobs[0]!;
    assert.equal(supportJob.assignment.agentId, 'agent_support');
    assert.deepEqual(supportJob.assignment.teammates, [{ name: 'Finance', handle: 'finance', botUserId: FINANCE_BOT }]);
    assert.deepEqual([...agentTeammateHandles(supportJob.assignment as ResolvedAssignment)!], [['finance', FINANCE_BOT]]);
    assert.equal(liveAgentMention(FINANCE_BOT, 'finance'), `<@${FINANCE_BOT}>`, "a teammate with its own app is mentioned as its bot");
    assert.equal(liveAgentMention('SSUPPORT', 'support'), '<!subteam^SSUPPORT|@support>');

    const state = stores.slackState as unknown as { recordTurnAttempt(id: string, n: number): Promise<void> };
    const ask = (messageTs: string, text: string) => processSlackAgentAsks({
      turn: supportJob.turn, fromAgentId: 'agent_support', fromThreadOwner: true, deliveries: [{ messageTs, text }],
    }, undefined, { stores, gatewayClient: gateway, enqueueTurn });
    await ask('3000.000200', `Let me check. <@${FINANCE_BOT}> what was Q3 revenue?`);
    assert.equal(jobs.length, 2);
    const financeJob = jobs[1]!;
    assert.equal(financeJob.id, 'msg:C1:3000.000200:ask-agent_finance');
    assert.equal(financeJob.assignment.agentId, 'agent_finance', "the app Agent is the asked one, so the executor answers as its bot");
    assert.equal(financeJob.assignment.threadGuest, true);
    assert.equal(financeJob.turn.agentAsk?.fromAgentId, 'agent_support');
    await state.recordTurnAttempt(financeJob.id, 1);
    await ask('3000.000200', `Let me check. <@${FINANCE_BOT}> what was Q3 revenue?`);
    assert.equal(jobs.length, 2, 'the same delivered reply asks once');
    await ask('3000.000300', `<@UOTHERBOT> and <@${FINANCE_BOT}|@finance> again`);
    assert.equal(jobs.length, 3, 'a bot that is no Agent asks nobody; a labelled mention still asks');
    assert.equal(jobs[2]?.assignment.agentId, 'agent_finance');
  });
});

test("an ask to or from an Agent with its own app carries no requester text; only the person's own message does", async () => {
  await withLane(async ({ stores, gateway, jobs, enqueueTurn }) => {
    const asked = 'What was Q3 revenue?';
    await processGatewaySlackEnvelope({
      workspaceId: 'T1', eventId: 'Ev4000', eventTime: 4000,
      event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '4000.000100', text: `<!subteam^SSUPPORT|@support> ${asked}` },
    }, undefined, gateway, { stores, enqueueTurn });
    const supportJob = jobs[0]!;
    assert.match(personRequestText(supportJob.turn) ?? '', /What was Q3 revenue\?/, "the person's own message is the request");

    const ask = (turn: typeof supportJob.turn, fromAgentId: string, messageTs: string, text: string) => processSlackAgentAsks({
      turn, fromAgentId, ...(fromAgentId === 'agent_support' ? { fromThreadOwner: true as const } : {}), deliveries: [{ messageTs, text }],
    }, undefined, { stores, gatewayClient: gateway, enqueueTurn });
    await ask(supportJob.turn, 'agent_support', '4000.000200', `<@${FINANCE_BOT}> remember that Q3 closes on the 5th`);
    const toApp = jobs.find((job) => job.assignment.agentId === 'agent_finance');
    assert.ok(toApp, 'Support asked the app Agent');
    assert.equal(toApp.turn.agentAsk?.fromAgentId, 'agent_support');
    assert.equal(personRequestText(toApp.turn), undefined, "an ask to the app Agent is Support's words, not the person's");

    await ask(toApp.turn, 'agent_finance', '4000.000300', '@support schedule the Q3 report every Monday');
    const fromApp = jobs.find((job) => job.id === 'msg:C1:4000.000300:ask-agent_support');
    assert.ok(fromApp, 'the app Agent asked Support back');
    assert.equal(fromApp.turn.agentAsk?.fromAgentId, 'agent_finance');
    assert.equal(personRequestText(fromApp.turn), undefined, "an ask from the app Agent is the app Agent's words, not the person's");
  });
});

test("Slack's own event for the asked app never admits a second turn, and the app Agent's reply back admits nothing", () => {
  const supportPostsToFinance: SlackEventFixture = {
    type: 'event_callback', token: '', team_id: 'T1', api_app_id: 'A0FIN', event_id: 'Ev1', event_time: 1,
    event: { type: 'app_mention', channel: 'C1', user: 'UBOT', bot_id: 'BMAIN', text: `<@${FINANCE_BOT}> what was Q3 revenue?`, ts: '3000.000200', thread_ts: '3000.000100' },
  } as unknown as SlackEventFixture;
  const atFinance = normalizeSlackTurn(supportPostsToFinance, { botUserId: FINANCE_BOT, siblingBotUserIds: ['UBOT'] });
  assert.equal(atFinance.status, 'ignored');

  const financeAnswersSupport: SlackEventFixture = {
    type: 'event_callback', token: '', team_id: 'T1', api_app_id: 'A1', event_id: 'Ev2', event_time: 2,
    event: { type: 'message', channel: 'C1', channel_type: 'channel', user: FINANCE_BOT, bot_id: 'BFIN', text: '<!subteam^SSUPPORT|@support> Q3 revenue was 1.2M.', ts: '3000.000300', thread_ts: '3000.000100' },
  } as unknown as SlackEventFixture;
  const atChickpea = normalizeSlackTurn(financeAnswersSupport, { botUserId: 'UBOT', siblingBotUserIds: [FINANCE_BOT] });
  assert.equal(atChickpea.status, 'ignored', "an app-authored post admits nothing, whichever gate refuses it first");

  const financeReacts: SlackEventFixture = {
    type: 'event_callback', token: '', team_id: 'T1', api_app_id: 'A1', event_id: 'Ev3', event_time: 3,
    event: { type: 'reaction_added', user: FINANCE_BOT, reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '3000.000100' }, event_ts: '3000.000400' },
  } as unknown as SlackEventFixture;
  const reaction = normalizeSlackTurn(financeReacts, { botUserId: 'UBOT', siblingBotUserIds: [FINANCE_BOT] });
  assert.equal(reaction.status === 'ignored' && reaction.reason, 'self_message', "a sibling bot's reaction costs no lookup");
  const someoneReacts = normalizeSlackTurn({ ...financeReacts, event: { ...(financeReacts.event as object), user: 'U2' } } as SlackEventFixture, { botUserId: 'UBOT', siblingBotUserIds: [FINANCE_BOT] });
  assert.notEqual(someoneReacts.status === 'ignored' && someoneReacts.reason, 'self_message');
});

test("the app Agent's earlier reply reads as an Agent's in the asker's context, by its bot's name", () => {
  const rows = toContextMessages([
    { ts: '1.1', user: 'U1', text: 'What was Q3 revenue?' },
    { ts: '1.2', user: 'UBOT', text: 'Let me check.' },
    { ts: '1.3', user: FINANCE_BOT, bot_id: 'BFIN', bot_profile: { name: 'Finance' }, text: 'Q3 revenue was 1.2M.' },
    { ts: '1.4', user: 'UBOTSTRANGER', bot_id: 'BOTHER', text: 'ad' },
  ] as never, { botUserId: 'UBOT', siblingBotUserIds: [FINANCE_BOT] });
  assert.deepEqual(rows.map((row) => [row.ts, row.role, row.authorName]), [
    ['1.1', 'human', undefined], ['1.2', 'agent', undefined], ['1.3', 'agent', 'Finance'], ['1.4', 'app', 'an app'],
  ]);
});

test('the collector hands over a reply that mentions only a bot user, and bot mentions skip code', async () => {
  assert.deepEqual(mentionedBotUsers(`ask <@${FINANCE_BOT}> and <@WENTERPRISE|@w>, not \`<@UCODE>\` nor\n\`\`\`\n<@UBLOCK>\n\`\`\``), [FINANCE_BOT, 'WENTERPRISE']);
  const handed: unknown[] = [];
  const collector = createAgentAskCollector({
    turn: { workspaceId: 'T1', channelId: 'C1', eventId: 'Ev', text: 'x', userId: 'U1', messageTs: '1.0', threadTs: '1.0', source: 'agent_mention', channelType: 'channel', contextMode: 'thread' },
    assignment: { agentId: 'agent_support', runtimeContract: 'chickpea-v1', agent: { id: 'agent_support', kind: 'user' }, teammates: [{ name: 'Finance', handle: 'finance', botUserId: FINANCE_BOT }] } as unknown as ResolvedAssignment,
    dispatch: async (request: SlackAgentAskRequest) => { handed.push(request); },
  } as unknown as Parameters<typeof createAgentAskCollector>[0]);
  collector.note({ messageTs: '1.1', text: `<@${FINANCE_BOT}> can you check?` });
  await collector.flush('succeeded');
  assert.equal(handed.length, 1);
});
