import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_ASK_PAUSE_TEXT,
  processGatewaySlackEnvelope,
  processSlackAgentAsks,
} from '../src/channels/slack.ts';
import { agentTeammateInstructions } from '../src/config/effective-config.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import {
  AGENT_ASK_TURN_LIMIT,
  agentAskOrigin,
  createAgentAskCollector,
  mentionedHandleWords,
  type SlackAgentAskRequest,
} from '../src/slack/agent-asks.ts';
import { resolveAgentRoute } from '../src/slack/agent-routing.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { ensureTriggerMessage } from '../src/slack/thread-context.ts';
import {
  memoryEpochThreadKey,
  slackAgentContinuityKey,
  slackAgentThreadKey,
} from '../src/slack/thread-key.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { assembleSlackPrompt } from '../src/slack/web-client-context.ts';
import {
  canonicalSlackMarkdownText,
  canonicalSlackReplyText,
  streamableSlackMarkdownPrefix,
} from '../src/slack/message-format.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const allowUserAgent = async () => ({
  status: 'allowed' as const,
  audience: 'workspace_members' as const,
});

function turn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'C1', eventId: 'Ev1', text: 'hello',
    userId: 'U1', messageTs: '100.2', threadTs: '100.1', source: 'implicit_thread_reply',
    channelType: 'channel', contextMode: 'thread', ...patch,
  };
}

function presence(handle: string) {
  return {
    requestedHandle: handle, normalizedHandle: handle, desiredState: 'active' as const,
    health: 'healthy' as const, userGroupId: `S${handle.toUpperCase()}`,
    avatar: { kind: 'generated' as const, revision: 1, seed: handle, url: `https://example.com/${handle}.svg` },
  };
}

function agentInput(id: string, name: string, handle: string, creatorMembershipId = 'membership_owner') {
  return {
    id, name, instructions: `Help with ${name}.`, enabled: true, lifecycle: 'active' as const,
    creatorMembershipId, editPolicy: 'creator_and_admins' as const,
    model: `local-stub/${handle}`, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: presence(handle),
  };
}

test('handle words are read from prose, never from code, emails, or paths', () => {
  assert.deepEqual(
    mentionedHandleWords('@Finance can you check? cc @legal, and @finance again.'),
    ['finance', 'legal'],
  );
  // Neutralization leaves a word joiner after the `@` of a user-group mention.
  assert.deepEqual(mentionedHandleWords(`Asking @${'\u2060'}finance now`), ['finance']);
  assert.deepEqual(mentionedHandleWords('mail ops@example.com, see a/@b, x.@c, https://x.com/@d'), []);
  assert.deepEqual(mentionedHandleWords('run `@finance` or\n```\n@legal\n```'), []);
  assert.deepEqual(mentionedHandleWords('ask @data-team- please'), ['data-team']);
});

test('an ask exchange is bounded by the person message it started from', () => {
  assert.equal(agentAskOrigin(turn({ messageTs: '100.5' })), '100.5');
  assert.equal(agentAskOrigin(turn({
    messageTs: '100.7',
    agentAsk: { fromAgentId: 'agent_support', fromAgentName: 'Support', originMessageTs: '100.5' },
  })), '100.5');
});

test('the collector hands over handle-bearing replies once, after delivery, and only from Channel threads', async () => {
  const assignment = { agentId: 'agent_support', runtimeContract: 'chickpea-v1' } as ResolvedAssignment;
  const requests: SlackAgentAskRequest[] = [];
  const collector = createAgentAskCollector({
    turn: turn({ requesterTimezone: 'America/New_York' }),
    assignment,
    dispatch: async (request) => { requests.push(request); },
  });
  collector.note({ messageTs: '100.3', text: 'No mention here.' });
  collector.note({ messageTs: '100.4', text: '@finance what is Q3?' });
  collector.note({ messageTs: '100.4', text: '@finance what is Q3?' });
  await collector.flush();
  await collector.flush();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    turn: {
      workspaceId: 'T1', channelId: 'C1', threadTs: '100.1', messageTs: '100.2', userId: 'U1',
      channelType: 'channel', requesterTimezone: 'America/New_York',
    },
    fromAgentId: 'agent_support',
    deliveries: [{ messageTs: '100.4', text: '@finance what is Q3?' }],
  });

  for (const [ineligibleTurn, contract] of [
    [turn({ source: 'dm_message', channelType: 'im' }), 'chickpea-v1'],
    [turn(), 'legacy'],
  ] as const) {
    const skipped: SlackAgentAskRequest[] = [];
    const other = createAgentAskCollector({
      turn: ineligibleTurn,
      assignment: { ...assignment, runtimeContract: contract } as ResolvedAssignment,
      dispatch: async (request) => { skipped.push(request); },
    });
    other.note({ messageTs: '100.4', text: '@finance hi' });
    await other.flush();
    assert.equal(skipped.length, 0);
  }

  const failing = createAgentAskCollector({
    turn: turn(),
    assignment,
    dispatch: async () => { throw new Error('boom'); },
  });
  failing.note({ messageTs: '100.4', text: '@finance hi' });
  await failing.flush();
});

test('a guest keeps its own transcript, memory conversation, and nothing of the owner', () => {
  const base = turn();
  const owner = { runtimeContract: 'chickpea-v1' as const, ownerIncarnation: 2, agentId: 'agent_support' };
  const guest = { ...owner, agentId: 'agent_finance', threadGuest: true as const };
  assert.equal(slackAgentContinuityKey(base, owner), slackAgentThreadKey(base, owner));
  assert.equal(slackAgentContinuityKey(base, guest), 'T1:C1:100.1:owner-i2:guest-agent_finance');
  // The runner and active-work key stays the thread's: asks queue behind it.
  assert.equal(slackAgentThreadKey(base, guest), 'T1:C1:100.1:owner-i2');
  assert.equal(memoryEpochThreadKey(slackAgentContinuityKey(base, owner), 3), 'T1:C1:100.1:owner-i2:memory-e3');
  assert.equal(
    memoryEpochThreadKey(slackAgentContinuityKey(base, guest), 3),
    'T1:C1:100.1:owner-i2:guest-agent_finance:memory-e3',
  );
});

test('an ask’s trigger is the asking Agent’s message, and the prompt says who asked for whom', () => {
  const askTurn = turn({
    messageTs: '100.4',
    text: '@finance what is Q3?',
    agentAsk: {
      fromAgentId: 'agent_support', fromAgentName: 'Support', fromAgentHandle: 'support',
      originMessageTs: '100.2',
    },
  });
  const [trigger] = ensureTriggerMessage([], askTurn);
  assert.equal(trigger?.role, 'agent');
  assert.equal(trigger?.authorName, 'Support');
  assert.equal(trigger?.agentId, 'agent_support');
  const prompt = assembleSlackPrompt(askTurn, {
    mode: 'thread', messages: [trigger!], truncated: false, degradations: [],
  });
  assert.match(prompt, /Another Chickpea Agent, "Support" \(@support\), mentioned your handle/);
  assert.match(prompt, /<@U1> started this exchange, and you act with their access/);
  assert.match(prompt, /mention @support in your reply so it picks the answer up/);
  assert.match(prompt, /Current Slack request, from the Agent "Support"/);
  const plain = assembleSlackPrompt(turn(), { mode: 'thread', messages: [], truncated: false, degradations: [] });
  assert.doesNotMatch(plain, /teammate request context/);
});

test('teammate instructions name whom an Agent can ask and how', () => {
  assert.equal(agentTeammateInstructions({}), undefined);
  const text = agentTeammateInstructions({
    channelTeammates: [
      { name: 'Finance', handle: 'finance', userGroupId: 'SFINANCE' },
      { name: 'Legal', handle: 'legal', userGroupId: 'SLEGAL' },
    ],
  });
  assert.match(text!, /mention their handle as plain text in your reply, for example @finance/);
  assert.match(text!, /never mention your own handle/);
  assert.match(text!, /Teammates here: "Finance" \(@finance\), "Legal" \(@legal\)\./);
});

async function routingFixture() {
  const store = new SqliteConfigStore(':memory:');
  const support = await store.createAgent(agentInput('agent_support', 'Support', 'support'));
  const finance = await store.createAgent(agentInput('agent_finance', 'Finance', 'finance'));
  const legal = await store.createAgent(agentInput('agent_legal', 'Legal', 'legal'));
  await store.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'direct', runtimeContract: 'chickpea-v1',
  });
  for (const agent of [support, finance]) {
    await store.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: agent.id, status: 'active',
      createdByMembershipId: 'membership_owner', channelLabel: 'support', channelIsPrivate: false,
    });
  }
  await store.putAgentThreadRoute({
    workspaceId: 'T1', channelId: 'C1', threadTs: '100.1', agentId: support.id,
    agentGeneration: support.configurationGeneration ?? support.revision, ownerIncarnation: 2,
  }, 0);
  return { store, support, finance, legal };
}

test('an ask routes to the asked Agent without taking the thread over', async () => {
  const { store, support, finance, legal } = await routingFixture();
  const actor = { channelMember: true, fullMember: true };
  const routed = await resolveAgentRoute({
    turn: turn({ text: '@finance what is Q3?' }), surface: 'channel', actor, config: store,
    askAgentId: finance.id, authorizeUserAgent: allowUserAgent,
  });
  assert.equal(routed.kind, 'routed');
  if (routed.kind !== 'routed') return;
  assert.equal(routed.source, 'agent_ask');
  assert.equal(routed.handoff, false);
  assert.equal(routed.assignment.agentId, finance.id);
  assert.equal(routed.assignment.threadGuest, true);
  assert.equal(routed.assignment.ownerIncarnation, 2);
  assert.deepEqual(routed.assignment.channelTeammates, [{ name: 'Support', handle: 'support', userGroupId: 'SSUPPORT' }]);
  const route = await store.getAgentThreadRoute('T1', 'C1', '100.1');
  assert.equal(route?.agentId, support.id);
  assert.equal(route?.ownerIncarnation, 2);

  // Asking the thread's own Agent continues its transcript.
  const back = await resolveAgentRoute({
    turn: turn(), surface: 'channel', actor, config: store,
    askAgentId: support.id, authorizeUserAgent: allowUserAgent,
  });
  assert.equal(back.kind === 'routed' && back.assignment.threadGuest, undefined);

  // No grant here, no route to continue, or a person outside the Channel: not asked.
  const refused = [
    await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor, config: store, askAgentId: legal.id,
      authorizeUserAgent: allowUserAgent,
    }),
    await resolveAgentRoute({
      turn: turn({ threadTs: '200.1' }), surface: 'channel', actor, config: store,
      askAgentId: finance.id, authorizeUserAgent: allowUserAgent,
    }),
    await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: false, fullMember: true },
      config: store, askAgentId: finance.id, authorizeUserAgent: allowUserAgent,
    }),
  ];
  assert.deepEqual(refused.map(({ kind }) => kind), ['denied', 'denied', 'denied']);
});

const OWNER = {
  id: 'U1', team_id: 'T1', name: 'Owner', deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, is_stranger: false,
};

test('a delivered reply that mentions a teammate admits one ask per Agent, up to the exchange limit', async () => {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    const agents: CustomAgentConfig[] = [];
    for (const [id, name, handle] of [
      ['agent_support', 'Support', 'support'],
      ['agent_finance', 'Finance', 'finance'],
      ['agent_legal', 'Legal', 'legal'],
    ] as const) {
      agents.push(await stores.config.createAgent(agentInput(id, name, handle, owner.membership.id)));
    }
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1', runtimeContract: 'chickpea-v1',
    });
    await stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'team', lifecycle: 'active' }, 0);
    // Legal has no grant in this Channel.
    for (const agent of agents.slice(0, 2)) {
      await stores.config.putAgentChannelGrant({
        workspaceId: 'T1', channelId: 'C1', agentId: agent.id, status: 'active',
        createdByMembershipId: owner.membership.id, channelLabel: 'team', channelIsPrivate: false,
      }, 0);
    }
    const posts: Array<Record<string, unknown>> = [];
    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const liveChannel = {
      id: 'C1', name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false,
    };
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string, args: Record<string, unknown>) {
        if (operation === 'users.info') return { user: OWNER };
        if (operation === 'conversations.info') return { channel: liveChannel };
        if (operation === 'conversations.members') return { members: ['U1', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [liveChannel] };
        if (operation === 'chat.postMessage') {
          posts.push(args);
          return { ok: true, ts: `9000.00000${posts.length}`, channel: 'C1' };
        }
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    const jobs: TurnJob[] = [];
    const enqueueTurn = async (job: TurnJob) => {
      if (!jobs.some(({ id }) => id === job.id)) jobs.push(job);
      return { ok: true as const, value: null };
    };

    // A person asks Support, which owns the thread from here.
    await processGatewaySlackEnvelope({
      workspaceId: 'T1', eventId: 'Ev3000', eventTime: 3000,
      event: {
        type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '3000.000100',
        text: '<!subteam^SSUPPORT|@support> What was Q3 revenue?',
      },
    }, undefined, gateway, { stores, enqueueTurn });
    assert.equal(jobs.length, 1);
    const supportJob = jobs[0]!;
    assert.equal(supportJob.assignment.agentId, 'agent_support');
    assert.deepEqual(supportJob.assignment.channelTeammates, [{ name: 'Finance', handle: 'finance', userGroupId: 'SFINANCE' }]);

    // Support's reply asks Finance (and mentions Legal, who cannot be asked here).
    const ask = (messageTs: string, text = 'Let me check. @finance what was Q3 revenue? cc @legal') =>
      processSlackAgentAsks({
        turn: supportJob.turn,
        fromAgentId: 'agent_support',
        deliveries: [{ messageTs, text }],
      }, undefined, { stores, gatewayClient: gateway, enqueueTurn });
    await ask('3000.000200');
    assert.equal(jobs.length, 2);
    const financeJob = jobs[1]!;
    assert.equal(financeJob.id, 'msg:C1:3000.000200:ask-agent_finance');
    assert.equal(financeJob.assignment.agentId, 'agent_finance');
    assert.equal(financeJob.assignment.threadGuest, true);
    assert.equal(financeJob.assignment.ownerIncarnation, supportJob.assignment.ownerIncarnation);
    assert.equal(financeJob.turn.userId, 'U1');
    assert.equal(financeJob.turn.threadTs, '3000.000100');
    assert.deepEqual(financeJob.turn.agentAsk, {
      fromAgentId: 'agent_support', fromAgentName: 'Support', fromAgentHandle: 'support',
      originMessageTs: '3000.000100',
    });
    assert.equal(slackAgentThreadKey(financeJob.turn, financeJob.assignment),
      slackAgentThreadKey(supportJob.turn, supportJob.assignment));
    // The thread is still Support's.
    assert.equal((await stores.config.getAgentThreadRoute('T1', 'C1', '3000.000100'))?.agentId, 'agent_support');

    // The same delivery again (a redelivered notification) asks nobody twice.
    await ask('3000.000200');
    assert.equal(jobs.length, 2);

    // An Agent cannot ask itself.
    await ask('3000.000250', '@support note to self');
    assert.equal(jobs.length, 2);

    // Keep asking from the same person's message until the exchange pauses.
    for (let index = 2; index <= AGENT_ASK_TURN_LIMIT; index += 1) {
      await ask(`3000.000${300 + index}`);
    }
    assert.equal(jobs.length, 1 + AGENT_ASK_TURN_LIMIT);
    assert.equal(posts.length, 0);
    await ask('3000.000400');
    await ask('3000.000401');
    assert.equal(jobs.length, 1 + AGENT_ASK_TURN_LIMIT);
    assert.equal(posts.length, 1, 'the pause is said once per exchange');
    assert.equal(posts[0]?.text, AGENT_ASK_PAUSE_TEXT);
    assert.equal(posts[0]?.thread_ts, '3000.000100');
    assert.equal(posts[0]?.username, 'Support');

    // A new person message starts a new exchange with its own asks.
    await ask('3000.000500');
    assert.equal(jobs.length, 1 + AGENT_ASK_TURN_LIMIT);
    await processSlackAgentAsks({
      turn: { ...supportJob.turn, messageTs: '3000.000600' },
      fromAgentId: 'agent_support',
      deliveries: [{ messageTs: '3000.000700', text: '@finance one more thing' }],
    }, undefined, { stores, gatewayClient: gateway, enqueueTurn });
    assert.equal(jobs.length, 2 + AGENT_ASK_TURN_LIMIT);
    assert.equal(jobs.at(-1)?.turn.agentAsk?.originMessageTs, '3000.000600');
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
});

test('a reply mentions its Channel teammates live and every other user group stays inert', () => {
  const live = new Map([['a2a-finance', 'SFIN'], ['legal', 'SLEGAL']]);
  const joiner = '⁠';
  assert.equal(
    canonicalSlackMarkdownText('Checking. @a2a-finance, what was Q3? cc @A2A-Finance', live),
    'Checking. <!subteam^SFIN|@a2a-finance>, what was Q3? cc <!subteam^SFIN|@a2a-finance>',
  );
  // A mention token the model wrote for a teammate stays live, normalized.
  assert.equal(canonicalSlackMarkdownText('<!subteam^SLEGAL|@counsel> ok?', live), '<!subteam^SLEGAL|@legal> ok?');
  // Other groups, broadcasts, code, emails, and longer words stay as before.
  assert.equal(canonicalSlackMarkdownText('<!subteam^SOPS|@ops> and @here', live), `@${joiner}ops and @${joiner}here`);
  assert.equal(canonicalSlackMarkdownText('run `@a2a-finance` or mail a2a@legal.com', live),
    'run `@a2a-finance` or mail a2a@legal.com');
  assert.equal(canonicalSlackMarkdownText('ask @a2a-finance-team', live), 'ask @a2a-finance-team');
  // Without a list nothing is live, exactly as before.
  assert.equal(canonicalSlackMarkdownText('<!subteam^SFIN|@a2a-finance> @a2a-finance'), `@${joiner}a2a-finance @a2a-finance`);
  // Idempotent, and file-reply mrkdwn renders the same live mention.
  const once = canonicalSlackMarkdownText('Hi @legal', live);
  assert.equal(canonicalSlackMarkdownText(once, live), once);
  assert.equal(canonicalSlackReplyText('Hi @legal', 'mrkdwn', live), 'Hi <!subteam^SLEGAL|@legal>');
  // The host reads the live token as a handle word, so it still asks.
  assert.deepEqual(mentionedHandleWords('Hi <!subteam^SLEGAL|@legal>'), ['legal']);
});

test('every streamed prefix of a reply with live mentions is a prefix of its final text', () => {
  const live = new Map([['a2a-finance', 'SFIN'], ['a2a-support', 'SSUP']]);
  const answer = 'Checking with @a2a-finance, one moment.\nEach charge was *$129*. @a2a-support\n' +
    'See `@a2a-finance` notes, then <!subteam^SSUP|@support> or @a2a-financeX.';
  const final = canonicalSlackMarkdownText(answer, live);
  for (let end = 0; end <= answer.length; end += 1) {
    const prefix = streamableSlackMarkdownPrefix(answer.slice(0, end), live);
    assert.ok(final.startsWith(prefix), `prefix at ${end}: ${JSON.stringify(prefix)}`);
  }
});
