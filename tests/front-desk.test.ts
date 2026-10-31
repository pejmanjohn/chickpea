import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { ConfigStoreLogic } from '../src/config/store.ts';
import type {
  AgentConnectionBinding,
  ConnectionAccount,
  CustomAgentConfig,
  FrontDeskAgent,
  FrontDeskDirectory,
} from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import {
  FRONT_DESK_MAX_BLOCK_CHARS,
  FRONT_DESK_RECENT_WINDOW_MS,
  agentChoiceSpec,
  compileFrontDeskPlan,
  frontDeskChoiceLine,
  frontDeskFailureLine,
  frontDeskHandoffLine,
  frontDeskMounted,
  pickRecentFrontDeskAgent,
  renderFrontDeskBlock,
  resolveFrontDeskTargets,
  sanitizeFrontDeskNote,
  slackTsAt,
} from '../src/slack/front-desk.ts';
import { assembleFrontDeskDirectory } from '../src/slack/front-desk-directory.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 24 * 60 * 60_000;

function deskAgent(id: string, name: string, patch: Partial<FrontDeskAgent> = {}): FrontDeskAgent {
  return {
    id, name, handle: name.toLowerCase().replace(/\s+/g, '-'),
    connections: [], websiteHosts: [], skills: [],
    more: { connections: 0, websiteHosts: 0, skills: 0 },
    ...patch,
  };
}

function userAgent(id: string, name: string, patch: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, instructions: `Help with ${name}.`, enabled: true, lifecycle: 'active',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: name.toLowerCase(), normalizedHandle: name.toLowerCase().replace(/\s+/g, '-'),
      desiredState: 'active', health: 'healthy', userGroupId: `S${id.toUpperCase()}`,
    } as NonNullable<CustomAgentConfig['slackPresence']>,
    ...patch,
  };
}

function rootDm(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'D1', eventId: 'Ev1', text: 'Check my order status on the portal.',
    userId: 'U1', messageTs: '1793440000.000100', threadTs: '1793440000.000100',
    source: 'dm_message', channelType: 'im', contextMode: 'thread', ...patch,
  };
}

test('the block lists names only, with every cap, and says when the list is not the whole set', () => {
  const longName = 'A'.repeat(60);
  const directory: FrontDeskDirectory = {
    agents: [
      deskAgent('agent_support', 'Support Desk', {
        purpose: 'Answers order questions from the help center.',
        connections: ['Zendesk', longName], websiteHosts: ['portal.example.test'], skills: ['refunds'],
        more: { connections: 3, websiteHosts: 0, skills: 0 },
      }),
      deskAgent('agent_research', 'Research'),
    ],
    omitted: 2,
    incomplete: true,
    recent: { agentId: 'agent_support', lastUsedTs: slackTsAt(NOW - 2 * DAY) },
  };
  const block = renderFrontDeskBlock(directory, NOW);
  assert.match(block, /^Agents this person may use \(host-provided/);
  assert.match(block, /Name only Agents in this list/);
  assert.match(block, /Most recent Agent in this DM: Support Desk \(2 days ago\)\./);
  assert.match(block, /- Support Desk \(@support-desk\): Answers order questions from the help center\./);
  assert.match(block, /Connections: Zendesk, A{60} \+3 more/);
  assert.match(block, /Website logins: portal\.example\.test/);
  assert.match(block, /- Research \(@research\)$/m);
  assert.match(block, /2 more Agents this person may use are not listed\. Never conclude that no Agent can do something\./);
  assert.match(block, /may be missing Agents that Slack could not confirm/);
  for (const id of ['agent_support', 'agent_research']) assert.ok(!block.includes(id), 'no Agent id is shown');
});

function account(id: string, label: string, patch: Partial<ConnectionAccount> = {}): ConnectionAccount {
  return {
    id, workspaceId: 'T1', revision: 1, ownerKind: 'team', createdByMembershipId: 'membership_admin',
    providerId: `provider_${id}`, label, secretRefId: `secret_${id}`, lifecycle: 'ready',
    policy: { kind: 'api', allowedHosts: ['api.example.test'], pathPrefixes: [], headerName: 'Authorization', allowedMethods: ['GET'] },
    createdAt: 0, updatedAt: 0, ...patch,
  } as ConnectionAccount;
}

function binding(agentId: string, item: ConnectionAccount): AgentConnectionBinding {
  return {
    agentId, connectionAccountId: item.id, providerId: item.providerId, allowedCapabilities: [],
    enabled: true, createdAt: 0, updatedAt: 0,
  };
}

test('the directory shows what this person would get from each Agent and nothing of anyone else', () => {
  const support = userAgent('agent_support', 'Support Desk', {
    description: 'Answers order questions. Escalates refunds to finance.',
    skills: [
      { name: 'refunds', description: '', instructions: 'secret steps', enabled: true },
      { name: 'retired', description: '', instructions: '', enabled: false },
    ],
    websiteLogins: [{ loginId: 'login_portal', level: 'check', enabled: true }],
  } as Partial<CustomAgentConfig>);
  const research = userAgent('agent_research', 'Research');
  const ownApp = userAgent('agent_app', 'App Agent', {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'app', normalizedHandle: 'app', desiredState: 'active', health: 'healthy',
      app: { state: 'active', at: 0, app: {}, icon: {}, botUserId: 'UAPP', installedAt: 0, installedBy: 'U1' },
    } as unknown as NonNullable<CustomAgentConfig['slackPresence']>,
  });
  const team = account('acct_team', 'Zendesk');
  const mine = account('acct_mine', 'My Calendar', { ownerKind: 'member', ownerMembershipId: 'membership_u1' });
  const theirs = account('acct_theirs', 'Their Inbox', { ownerKind: 'member', ownerMembershipId: 'membership_u2' });
  const directory = assembleFrontDeskDirectory({
    usable: { agents: [ownApp, research, support], incomplete: false },
    accounts: [team, mine, theirs],
    bindings: new Map([['agent_support', [binding('agent_support', team), binding('agent_support', mine), binding('agent_support', theirs)]]]),
    actorMembershipId: 'membership_u1',
    websiteLogins: [{ id: 'login_portal', host: 'portal.example.test', label: 'Portal', method: 'credentials', username: 'ops@example.test' }] as never,
    recentReplies: [],
    nowMs: NOW,
  });
  assert.ok(directory);
  assert.deepEqual(directory.agents.map(({ id }) => id), ['agent_research', 'agent_support'],
    'an Agent with its own live app is left out');
  const listed = directory.agents.find(({ id }) => id === 'agent_support')!;
  assert.deepEqual(listed.connections, ['Zendesk', 'My Calendar'], 'another member\'s personal account is never listed');
  assert.deepEqual(listed.websiteHosts, ['portal.example.test']);
  assert.deepEqual(listed.skills, ['refunds']);
  assert.equal(listed.purpose, 'Answers order questions.');
  const block = renderFrontDeskBlock(directory, NOW);
  for (const hidden of ['ops@example.test', 'secret steps', 'Their Inbox', 'login_portal', 'acct_team']) {
    assert.ok(!block.includes(hidden), `${hidden} never reaches the block`);
  }

  // No browser connected: no website login is offered as a reason to hand off.
  const offline = assembleFrontDeskDirectory({
    usable: { agents: [support], incomplete: false }, accounts: [], bindings: new Map(),
    recentReplies: [], nowMs: NOW,
  });
  assert.deepEqual(offline?.agents[0]?.websiteHosts, []);
  assert.equal(assembleFrontDeskDirectory({
    usable: { agents: [ownApp], incomplete: false }, accounts: [], bindings: new Map(), recentReplies: [], nowMs: NOW,
  }), undefined, 'no Agent left: no front desk');
});

test('at most twelve Agents are listed, the recent one first, and the block stays within its budget', () => {
  const agents = Array.from({ length: 15 }, (_, index) =>
    userAgent(`agent_${String(index).padStart(2, '0')}`, `Agent ${String(index).padStart(2, '0')}`, {
      description: `${'Handles a long list of specific kinds of work for the team. '.repeat(3)}`,
      skills: Array.from({ length: 12 }, (_, skill) => ({
        name: `skill-${skill}-${'x'.repeat(50)}`, description: '', instructions: '', enabled: true,
      })),
    }));
  const directory = assembleFrontDeskDirectory({
    usable: { agents, incomplete: false }, accounts: [], bindings: new Map(),
    recentReplies: [{ agentId: 'agent_14', messageTs: slackTsAt(NOW - DAY) }],
    nowMs: NOW,
  })!;
  assert.equal(directory.agents[0]?.id, 'agent_14', 'the recent Agent comes first');
  assert.ok(directory.agents.length <= 12);
  assert.equal(directory.agents.length + directory.omitted, 15, 'every usable Agent is listed or counted');
  const first = directory.agents[0]!;
  assert.equal(first.skills.length, 8);
  assert.equal(first.more.skills, 4);
  assert.ok(first.skills.every((name) => name.length <= 40));
  assert.ok((first.purpose?.length ?? 0) <= 120);
  const block = renderFrontDeskBlock(directory, NOW);
  assert.ok(block.length <= FRONT_DESK_MAX_BLOCK_CHARS, `block is ${block.length} characters`);
  assert.match(block, new RegExp(`${directory.omitted} more Agents this person may use are not listed`));
});

test('the recent Agent is the newest reply within seven days from an Agent the person may still use', () => {
  const usable = new Set(['agent_support', 'agent_research']);
  const at = (msAgo: number) => slackTsAt(NOW - msAgo);
  assert.deepEqual(pickRecentFrontDeskAgent([
    { agentId: 'agent_research', messageTs: at(3 * DAY) },
    { agentId: 'agent_support', messageTs: at(DAY) },
  ], usable, NOW), { agentId: 'agent_support', lastUsedTs: at(DAY) });
  assert.deepEqual(pickRecentFrontDeskAgent([
    { agentId: 'agent_support', messageTs: at(FRONT_DESK_RECENT_WINDOW_MS) },
  ], usable, NOW), { agentId: 'agent_support', lastUsedTs: at(FRONT_DESK_RECENT_WINDOW_MS) }, 'seven days is inside');
  assert.equal(pickRecentFrontDeskAgent([
    { agentId: 'agent_support', messageTs: at(FRONT_DESK_RECENT_WINDOW_MS + 1_000) },
  ], usable, NOW), undefined, 'past seven days is not');
  assert.equal(pickRecentFrontDeskAgent([
    { agentId: 'agent_revoked', messageTs: at(DAY) },
  ], usable, NOW), undefined, 'an Agent the person can no longer use is never the hint');
});

test('the store returns each Agent\'s newest reply in one DM since a time', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    for (const id of ['agent_support', 'agent_research']) {
      store.createAgent({ id, name: id, instructions: '', enabled: true, lifecycle: 'active',
        creatorMembershipId: 'owner', editPolicy: 'creator_and_admins', skills: [], mcpServers: [],
        apiConnections: [], repositories: [] });
    }
    const put = (channelId: string, rootTs: string, messageTs: string, agentId?: string) =>
      store.putSlackPublicContext({
        workspaceId: 'T1', channelId, rootTs, messageTs, role: agentId ? 'agent' : 'human', text: 'synthetic',
        ...(agentId ? { agentId } : {}),
      });
    put('D1', '1000.000100', '1000.000200', 'agent_support');
    put('D1', '2000.000100', '2000.000200', 'agent_support');
    put('D1', '2000.000100', '2000.000300');
    put('D1', '1500.000100', '1500.000200', 'agent_research');
    put('D1', '900.000100', '900.000200', 'agent_research');
    put('D2', '3000.000100', '3000.000200', 'agent_research');
    assert.deepEqual(store.listRecentSlackAgentReplies({ workspaceId: 'T1', channelId: 'D1', sinceMessageTs: '1000.000000' }), [
      { agentId: 'agent_support', messageTs: '2000.000200' },
      { agentId: 'agent_research', messageTs: '1500.000200' },
    ]);
    assert.deepEqual(store.listRecentSlackAgentReplies({ workspaceId: 'T1', channelId: 'D1', sinceMessageTs: '1600.000000' }), [
      { agentId: 'agent_support', messageTs: '2000.000200' },
    ]);
    assert.deepEqual(store.listRecentSlackAgentReplies({ workspaceId: 'T1', channelId: 'D1', sinceMessageTs: 'invalid' }), []);
  } finally {
    db.close();
  }
});

test('the note is one plain sentence with no Slack control syntax', () => {
  assert.equal(
    sanitizeFrontDeskNote('It has the <https://portal.example.test|portal> login.\n<!here> ping <@U123> @channel'),
    'It has the login. ping channel',
  );
  assert.equal(sanitizeFrontDeskNote('x'.repeat(400)).length, 160);
  assert.equal(frontDeskHandoffLine('Support Desk', 'It has the portal login.'), 'Support Desk is taking this. It has the portal login.');
  assert.equal(frontDeskHandoffLine('Support Desk', ''), 'Support Desk is taking this.');
  assert.equal(frontDeskChoiceLine('Both can check orders.'), 'Which Agent should take this? Both can check orders.');
  assert.equal(frontDeskFailureLine('Support Desk'), "I couldn't hand this to Support Desk. Mention the Agent you want to try again.");
});

test('the tool hands only to listed Agents, and its refusals never name anything else', () => {
  const plan = {
    agents: [
      { id: 'agent_support', name: 'Support Desk', handle: 'support-desk' },
      { id: 'agent_research', name: 'Research' },
    ],
    choices: true as const,
  };
  assert.deepEqual(resolveFrontDeskTargets(['@support-desk'], plan), { ok: true, agentIds: ['agent_support'] });
  assert.deepEqual(resolveFrontDeskTargets(['research', 'chickpea'], plan),
    { ok: true, agentIds: ['agent_research', CHICKPEA_AGENT_ID] }, 'an Agent with no handle goes by its name');
  const unlisted = resolveFrontDeskTargets(['secret-hr'], plan);
  assert.equal(unlisted.ok, false);
  assert.ok(!unlisted.ok && !unlisted.error.includes('secret-hr'));
  assert.equal(resolveFrontDeskTargets(['chickpea'], plan).ok, false, 'Chickpea alone is answering, not a hand-off');
  assert.equal(resolveFrontDeskTargets(['research', 'Research'], plan).ok, false, 'no duplicates');
  assert.equal(resolveFrontDeskTargets(['a', 'b', 'c', 'd', 'e'], plan).ok, false, 'at most four');
  assert.equal(resolveFrontDeskTargets([], plan).ok, false);
  assert.equal(resolveFrontDeskTargets(['research', 'support-desk'], { agents: plan.agents }).ok, false,
    'several Agents need a card the message fits on');
});

test('only the system Agent\'s own root DM turn with a list mounts the front desk', () => {
  const frontDesk: FrontDeskDirectory = { agents: [deskAgent('agent_support', 'Support Desk')], omitted: 0, incomplete: false };
  const chickpea = { agentId: CHICKPEA_AGENT_ID, runtimeContract: 'chickpea-v1' as const, frontDesk };
  assert.equal(frontDeskMounted(rootDm(), chickpea), true);
  for (const [why, turn, assignment] of [
    ['a thread reply', rootDm({ messageTs: '1793440000.000200' }), chickpea],
    ['a group DM', rootDm({ channelType: 'mpim', channelId: 'G1' }), chickpea],
    ['a Channel', rootDm({ source: 'app_mention', channelType: 'channel', channelId: 'C1' }), chickpea],
    ['a takeover', rootDm({ frontDesk: { fromAgentId: CHICKPEA_AGENT_ID, via: 'click' } }), chickpea],
    ['an edit', rootDm({ edit: { editedTs: '1793440001.000000', previousText: 'x' } }), chickpea],
    ['an ask', rootDm({ agentAsk: { fromAgentId: 'agent_x', fromAgentName: 'X', originMessageTs: '1' } }), chickpea],
    ['a user Agent', rootDm(), { ...chickpea, agentId: 'agent_support' }],
    ['an empty list', rootDm(), { ...chickpea, frontDesk: { ...frontDesk, agents: [] as FrontDeskAgent[] } }],
    ['the legacy contract', rootDm(), { ...chickpea, runtimeContract: 'legacy' as const }],
  ] satisfies Array<[string, NormalizedSlackTurn, Parameters<typeof frontDeskMounted>[1]]>) {
    assert.equal(frontDeskMounted(turn, assignment), false, why);
  }
});

test('several Agents are offered only when the message fits on the card', () => {
  const frontDesk: FrontDeskDirectory = {
    agents: [deskAgent('agent_support', 'Support Desk'), deskAgent('agent_research', 'Research')],
    omitted: 0, incomplete: false,
  };
  const assignment = { agentId: CHICKPEA_AGENT_ID, runtimeContract: 'chickpea-v1' as const, frontDesk };
  assert.deepEqual(compileFrontDeskPlan(rootDm(), assignment), {
    agents: [
      { id: 'agent_support', name: 'Support Desk', handle: 'support-desk' },
      { id: 'agent_research', name: 'Research', handle: 'research' },
    ],
    choices: true,
  });
  assert.equal(compileFrontDeskPlan(rootDm({ text: 'x'.repeat(17_000) }), assignment)?.choices, undefined);
  const spec = agentChoiceSpec(rootDm({ attachments: [{ fileId: 'F1' }], requesterTimezone: 'UTC' }), []);
  assert.deepEqual(spec.origin, {
    userId: 'U1', messageTs: '1793440000.000100', text: 'Check my order status on the portal.',
    attachments: [{ fileId: 'F1' }], requesterTimezone: 'UTC',
  });
});
