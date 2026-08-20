import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { resolveAgentRoute } from '../src/slack/agent-routing.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

function turn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'C1', eventId: 'Ev1', text: '<!subteam^SSUPPORT|@support> help',
    userId: 'U1', messageTs: '100.1', threadTs: '100.1', source: 'ambient_channel_message',
    channelType: 'channel', contextMode: 'channel_history', ...patch,
  };
}

async function fixture() {
  const store = new SqliteConfigStore(':memory:');
  const first = await store.getAgent('agent_default');
  const support = await store.createAgent({
    id: 'agent_support', name: 'Support', description: 'Answers support questions',
    instructions: 'Help customers.', enabled: true, lifecycle: 'active',
    creatorMembershipId: 'membership_owner', editPolicy: 'creator_and_admins',
    model: 'local-stub/support', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active',
      health: 'healthy', userGroupId: 'SSUPPORT',
      avatar: { kind: 'generated', revision: 1, seed: 'support', url: 'https://example.com/support.svg' },
    },
  });
  const finance = await store.createAgent({
    id: 'agent_finance', name: 'Finance', instructions: 'Help with finance.', enabled: true,
    lifecycle: 'active', creatorMembershipId: 'membership_owner',
    editPolicy: 'creator_and_admins', model: 'local-stub/finance', skills: [], mcpServers: [],
    apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: 'finance', normalizedHandle: 'finance', desiredState: 'active',
      health: 'healthy', userGroupId: 'SFINANCE',
      avatar: { kind: 'generated', revision: 1, seed: 'finance', url: 'https://example.com/finance.svg' },
    },
  });
  await store.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'direct', defaultAgentId: first.id,
  });
  await store.putAgentChannelGrant({
    workspaceId: 'T1', channelId: 'C1', agentId: support.id, status: 'active',
    createdByMembershipId: 'membership_owner', channelLabel: 'support', channelIsPrivate: false,
  });
  await store.putAgentChannelGrant({
    workspaceId: 'T1', channelId: 'C1', agentId: finance.id, status: 'active',
    createdByMembershipId: 'membership_owner', channelLabel: 'support', channelIsPrivate: false,
  });
  return { store, first, support, finance };
}

test('an Agent user-group mention opens a route and an unmentioned reply continues it', async () => {
  const { store, support } = await fixture();
  try {
    const opened = await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(opened.kind, 'routed');
    if (opened.kind !== 'routed') return;
    assert.equal(opened.assignment.agentId, support.id);
    assert.equal(opened.source, 'agent_handle');

    const continued = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: 'one more thing',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(continued.kind, 'routed');
    if (continued.kind === 'routed') assert.equal(continued.source, 'thread_owner');
  } finally {
    store.close();
  }
});

test('a permitted explicit handle visibly hands an owned thread to another Agent', async () => {
  const { store, finance } = await fixture();
  try {
    await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    const handedOff = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: '<!subteam^SFINANCE|@finance> take over',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(handedOff.kind, 'routed');
    if (handedOff.kind !== 'routed') return;
    assert.equal(handedOff.assignment.agentId, finance.id);
    assert.equal(handedOff.handoff, true);
    assert.equal(handedOff.route.revision, 2);
  } finally {
    store.close();
  }
});

test('an ungranted handle discloses only permitted alternatives and keeps the current owner', async () => {
  const { store, support, finance } = await fixture();
  try {
    await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    await store.deleteAgentChannelGrant('T1', 'C1', finance.id);
    const denied = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: '<!subteam^SFINANCE|@finance> take over',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(denied.kind, 'denied');
    if (denied.kind === 'denied') {
      assert.deepEqual(denied.alternatives.map(({ id }) => id), [support.id]);
    }
    assert.equal((await store.getAgentThreadRoute('T1', 'C1', '100.1'))?.agentId, support.id);
  } finally {
    store.close();
  }
});

test('multiple Agent handles are ambiguous and root messages without an address are ignored', async () => {
  const { store } = await fixture();
  try {
    const ambiguous = await resolveAgentRoute({
      turn: turn({ text: '<!subteam^SSUPPORT> meet <!subteam^SFINANCE>' }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(ambiguous.kind, 'ambiguous');
    const ignored = await resolveAgentRoute({
      turn: turn({ text: 'hello everyone' }), surface: 'channel',
      actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(ignored.kind, 'ignore');
  } finally {
    store.close();
  }
});

test('@Chickpea and direct-message roots use the normal workspace default Agent', async () => {
  const { store, first } = await fixture();
  try {
    await store.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: first.id, status: 'active',
      createdByMembershipId: 'membership_owner', channelLabel: 'support', channelIsPrivate: false,
    });
    const base = await resolveAgentRoute({
      turn: turn({ text: '<@U_BOT> help', source: 'app_mention' }), surface: 'channel',
      actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(base.kind, 'routed');
    if (base.kind === 'routed') assert.equal(base.assignment.agentId, first.id);

    const dm = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: 'hello', source: 'dm_message', channelType: 'im',
        contextMode: 'dm_history',
      }),
      surface: 'direct', actor: { channelMember: false, fullMember: true }, config: store,
    });
    assert.equal(dm.kind, 'routed');
    if (dm.kind === 'routed') assert.equal(dm.assignment.agentId, first.id);
  } finally {
    store.close();
  }
});

test('a trusted App Home selection starts a discoverable Agent-specific DM route', async () => {
  const { store, support } = await fixture();
  try {
    const selected = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: '', source: 'dm_message', channelType: 'im',
        contextMode: 'thread',
      }),
      surface: 'direct',
      actor: {
        channelMember: false,
        fullMember: true,
        discoverableAgentIds: new Set([support.id]),
      },
      config: store,
      appHomeAgentId: support.id,
    });
    assert.equal(selected.kind, 'routed');
    if (selected.kind !== 'routed') return;
    assert.equal(selected.source, 'app_home');
    assert.equal(selected.assignment.agentId, support.id);
    assert.equal(
      (await store.getAgentThreadRoute('T1', 'D1', '100.1'))?.agentId,
      support.id,
    );
  } finally {
    store.close();
  }
});

test('an Agent edit advances its owned route so the next reply uses current persona and config', async () => {
  const { store, support } = await fixture();
  try {
    const opened = await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(opened.kind, 'routed');
    if (opened.kind !== 'routed') return;
    await store.updateAgent(support.id, {
      name: 'Support Updated',
      configurationGeneration: 2,
      slackPresence: {
        ...support.slackPresence!,
        avatar: {
          ...support.slackPresence!.avatar,
          revision: 2,
          url: 'https://example.com/support-v2.svg',
        },
      },
    }, support.revision);

    const continued = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: 'continue',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(continued.kind, 'routed');
    if (continued.kind !== 'routed') return;
    assert.equal(continued.assignment.agent.name, 'Support Updated');
    assert.equal(continued.route.agentGeneration, 2);
    assert.equal(continued.route.revision, 2);
    assert.equal(continued.routeChanged, true);
  } finally {
    store.close();
  }
});
