import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createDemoStarterAgent } from '../src/config/seed.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { AgentSlackPresence } from '../src/config/types.ts';
import { configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { resolveAgentRoute } from '../src/slack/agent-routing.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const NOW = 1_800_000_000_000;
const allowUserAgent = async () => ({ status: 'allowed' as const, audience: 'workspace_members' as const });
const actor = { channelMember: true, fullMember: true };

function turn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'C1', eventId: 'Ev1', text: '<@UBOTSUP> help',
    userId: 'U1', messageTs: '100.1', threadTs: '100.1', source: 'app_mention',
    channelType: 'channel', contextMode: 'channel_history', ...patch,
  };
}

const liveApp: AgentSlackPresence = {
  kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
  avatar: { kind: 'generated', revision: 1, seed: 'support' }, released: { userGroupId: 'SSUPPORT' },
  app: { state: 'active', at: NOW, app: { appId: 'A0APP1', clientId: '1.c' }, icon: 'agent_avatar', botUserId: 'UBOTSUP', installedAt: NOW, installedBy: 'UOWNER' },
};

/** The host serves Agent apps, as the hosting service's port does, for one test. */
function serveAgentApps(t: TestContext): void {
  configureAgentSlackApps({
    requestUrls: () => ({ events: 'https://host.test/e', interactions: 'https://host.test/i' }),
    redirectUri: 'https://host.test/callback',
    allowUrl: (agentId) => `https://host.test/allow/${agentId}`,
  });
  t.after(() => configureAgentSlackApps(undefined));
}

async function fixture(options: { grant?: boolean } = {}) {
  const store = new SqliteConfigStore(':memory:', { agents: [createDemoStarterAgent()] });
  const first = await store.getAgent('agent_default');
  const base = {
    instructions: 'Help.', enabled: true, lifecycle: 'active' as const, creatorMembershipId: 'membership_owner',
    editPolicy: 'creator_and_admins' as const, model: 'local-stub/x', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
  const support = await store.createAgent({ id: 'agent_support', name: 'Support', ...base, slackPresence: liveApp });
  const finance = await store.createAgent({
    id: 'agent_finance', name: 'Finance', ...base,
    slackPresence: {
      requestedHandle: 'finance', normalizedHandle: 'finance', desiredState: 'active', health: 'healthy', userGroupId: 'SFINANCE',
      avatar: { kind: 'generated', revision: 1, seed: 'finance' },
    },
  });
  await store.ensureWorkspaceInstallation({ workspaceId: 'T1', transportMode: 'direct', defaultAgentId: first.id, runtimeContract: 'legacy' });
  for (const agent of options.grant === false ? [finance] : [support, finance]) {
    await store.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: agent.id, status: 'active',
      createdByMembershipId: 'membership_owner', channelLabel: 'support', channelIsPrivate: false,
    });
  }
  return { store, first, support, finance };
}

test("a delivery from the Agent's own app reaches that Agent in its DM and in a granted Channel", async () => {
  const { store, support } = await fixture();
  try {
    const dm = await resolveAgentRoute({
      turn: turn({ channelId: 'D1', threadTs: '100.1', source: 'dm_message', channelType: 'im', contextMode: 'dm_history', text: 'hello' }),
      surface: 'direct', actor, config: store, agentApp: { agentId: support.id }, authorizeUserAgent: allowUserAgent,
    });
    assert.equal(dm.kind, 'routed');
    if (dm.kind !== 'routed') return;
    assert.equal(dm.source, 'agent_app');
    assert.equal(dm.assignment.agentId, support.id);

    const mention = await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor, config: store, agentApp: { agentId: support.id }, authorizeUserAgent: allowUserAgent,
    });
    assert.equal(mention.kind, 'routed');
    if (mention.kind !== 'routed') return;
    assert.equal(mention.source, 'agent_app');
    assert.equal(mention.assignment.agentId, support.id);
  } finally {
    store.close();
  }
});

test('a mention of the Agent bot in a Channel it has no grant in takes the not-in-channel path', async () => {
  const { store, support } = await fixture({ grant: false });
  try {
    const result = await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor, config: store, agentApp: { agentId: support.id }, authorizeUserAgent: allowUserAgent,
    });
    assert.equal(result.kind, 'not_in_channel');
    if (result.kind !== 'not_in_channel') return;
    assert.equal(result.agent.id, support.id);
  } finally {
    store.close();
  }
});

test("Chickpea's ingress ignores a Channel message mentioning a live Agent-app bot, but not the same text in its DM", async () => {
  const { store, first, support } = await fixture();
  try {
    const channel = await resolveAgentRoute({ turn: turn({ source: 'implicit_thread_reply' }), surface: 'channel', actor, config: store });
    assert.deepEqual(channel, { kind: 'ignore' });

    const dm = await resolveAgentRoute({
      turn: turn({ channelId: 'D1', source: 'dm_message', channelType: 'im', contextMode: 'dm_history' }),
      surface: 'direct', actor, config: store, authorizeUserAgent: allowUserAgent,
    });
    assert.equal(dm.kind, 'routed');
    if (dm.kind !== 'routed') return;
    assert.equal(dm.assignment.agentId, first.id);
    assert.notEqual(dm.assignment.agentId, support.id);
  } finally {
    store.close();
  }
});

test("a Channel message naming a user-group Agent and an Agent-app bot routes alike on either bot's delivery: the first named takes it and the other answers after", async (t) => {
  serveAgentApps(t);
  const { store, support, finance } = await fixture();
  try {
    const cases = [
      { ts: '100.1', text: '<!subteam^SFINANCE|@finance> and <@UBOTSUP> compare', named: [finance.id, support.id] },
      { ts: '200.1', text: '<@UBOTSUP|support> and <!subteam^SFINANCE|@finance> compare', named: [support.id, finance.id] },
      { ts: '300.1', text: '<@UBOTSUP> <!subteam^SFINANCE|@finance>, then <@UBOTSUP|support> again', named: [support.id, finance.id] },
    ];
    for (const { ts, text, named } of cases) {
      const message = { text, messageTs: ts, threadTs: ts };
      const deliveries = {
        chickpea: await resolveAgentRoute({ turn: turn({ ...message, source: 'agent_mention' }), surface: 'channel', actor, config: store }),
        app: await resolveAgentRoute({
          turn: turn(message), surface: 'channel', actor, config: store, agentApp: { agentId: support.id }, authorizeUserAgent: allowUserAgent,
        }),
      };
      for (const [delivery, routed] of Object.entries(deliveries)) {
        assert.equal(routed.kind, 'routed');
        if (routed.kind !== 'routed') return;
        assert.equal(routed.assignment.agentId, named[0], `${delivery}: the Agent named first takes the message`);
        assert.deepEqual(
          [routed.coAddressed?.agents.map(({ agentId }) => agentId), routed.coAddressed?.position],
          [named, 0],
          `${delivery}: both Agents answer, in the order named, so either delivery admits the same turns`,
        );
      }
    }

    const botOnly = await resolveAgentRoute({ turn: turn({ text: '<@UBOTSUP> compare', source: 'implicit_thread_reply' }), surface: 'channel', actor, config: store });
    assert.deepEqual(botOnly, { kind: 'ignore' }, "a message for the app bot alone is still the app's");
  } finally {
    store.close();
  }
});

test('a Channel message naming an app Agent without a grant there answers nobody, on either bot\'s delivery', async (t) => {
  serveAgentApps(t);
  const { store, support } = await fixture({ grant: false });
  try {
    const text = '<!subteam^SFINANCE|@finance> and <@UBOTSUP> compare';
    for (const routed of [
      await resolveAgentRoute({ turn: turn({ text, source: 'agent_mention' }), surface: 'channel', actor, config: store }),
      await resolveAgentRoute({ turn: turn({ text }), surface: 'channel', actor, config: store, agentApp: { agentId: support.id }, authorizeUserAgent: allowUserAgent }),
    ]) {
      assert.equal(routed.kind, 'not_in_channel');
      assert.equal(routed.kind === 'not_in_channel' && routed.agent.id, support.id, 'Finance does not answer alone either');
    }
  } finally {
    store.close();
  }
});

test('user-group routing is unchanged beside an Agent app', async () => {
  const { store, finance } = await fixture();
  try {
    const result = await resolveAgentRoute({
      turn: turn({ text: '<!subteam^SFINANCE|@finance> help', source: 'agent_mention' }), surface: 'channel', actor, config: store,
    });
    assert.equal(result.kind, 'routed');
    if (result.kind !== 'routed') return;
    assert.equal(result.source, 'agent_handle');
    assert.equal(result.assignment.agentId, finance.id);
  } finally {
    store.close();
  }
});
