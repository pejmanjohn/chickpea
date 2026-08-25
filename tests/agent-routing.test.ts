import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { discoverableAgents, resolveAgentRoute } from '../src/slack/agent-routing.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

function turn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'C1', eventId: 'Ev1', text: '<!subteam^SSUPPORT|@support> help',
    userId: 'U1', messageTs: '100.1', threadTs: '100.1', source: 'agent_mention',
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

async function activateChickpea(store: SqliteConfigStore) {
  const chickpea = await store.materializeChickpeaAgent();
  const installation = await store.getWorkspaceInstallation('T1');
  assert.ok(installation);
  await store.updateWorkspaceInstallation(
    'T1',
    { runtimeContract: 'chickpea-v1' },
    installation.revision,
  );
  return chickpea;
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

test('Agent discovery checks granted Channels lazily and reuses membership results', async () => {
  const { store, support, finance } = await fixture();
  try {
    for (const agent of [support, finance]) {
      await store.putAgentChannelGrant({
        workspaceId: 'T1', channelId: 'C2', agentId: agent.id, status: 'active',
        createdByMembershipId: 'membership_owner', channelLabel: 'later', channelIsPrivate: false,
      });
    }
    const calls: string[] = [];
    const visible = await discoverableAgents({
      config: store,
      workspaceId: 'T1',
      channelMember: async (channelId) => {
        calls.push(channelId);
        return channelId === 'C1';
      },
    });
    assert.deepEqual(visible.map(({ id }) => id).sort(), [finance.id, support.id].sort());
    assert.deepEqual(calls, ['C1']);
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
    assert.equal(handedOff.route.ownerIncarnation, 2);
    assert.equal(handedOff.assignment.ownerIncarnation, 2);
  } finally {
    store.close();
  }
});

test('activated transfers freeze only bounded Slack-visible context before the trigger', async () => {
  const { store, finance } = await fixture();
  try {
    await activateChickpea(store);
    await store.putSlackPublicContext({
      workspaceId: 'T1', channelId: 'C1', rootTs: '100.1', messageTs: '100.1',
      role: 'human', text: 'Need support help.',
    });
    await store.putSlackPublicContext({
      workspaceId: 'T1', channelId: 'C1', rootTs: '100.1', messageTs: '100.15',
      role: 'agent', agentId: 'agent_support', text: 'Here is the visible answer.',
    });
    await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    const transferred = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: '<!subteam^SFINANCE> take over',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(transferred.kind, 'routed');
    if (transferred.kind !== 'routed') return;
    assert.equal(transferred.assignment.agentId, finance.id);
    assert.deepEqual(transferred.assignment.handoffContext, [
      { messageTs: '100.1', role: 'human', text: 'Need support help.' },
      {
        messageTs: '100.15', role: 'agent', agentId: 'agent_support',
        text: 'Here is the visible answer.',
      },
    ]);
    assert.equal(
      transferred.assignment.handoffContext?.some(({ messageTs }) => messageTs === '100.2'),
      false,
    );
    const retried = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: '<!subteam^SFINANCE> take over',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(retried.kind, 'routed');
    if (retried.kind === 'routed') {
      assert.equal(retried.handoff, true);
      assert.equal(retried.route.ownerIncarnation, 2);
      assert.deepEqual(retried.assignment.handoffContext, transferred.assignment.handoffContext);
    }
  } finally {
    store.close();
  }
});

test('an empty handoff fallback is receipted once for retry stability', async () => {
  const { store, finance } = await fixture();
  try {
    await activateChickpea(store);
    await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    const transferred = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: '<!subteam^SFINANCE> take over',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(transferred.kind, 'routed');
    if (transferred.kind !== 'routed') return;
    assert.equal(transferred.handoffFallbackRequired, true);
    assert.equal(transferred.route.handoff?.context, undefined);

    const receipted = await store.putAgentThreadRoute({
      workspaceId: transferred.route.workspaceId,
      channelId: transferred.route.channelId,
      threadTs: transferred.route.threadTs,
      agentId: finance.id,
      agentGeneration: transferred.route.agentGeneration,
      ownerIncarnation: transferred.route.ownerIncarnation,
      handoff: { ...transferred.route.handoff!, context: [] },
    }, transferred.route.revision);
    assert.deepEqual(receipted.handoff?.context, []);

    const retried = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: '<!subteam^SFINANCE> take over',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(retried.kind, 'routed');
    if (retried.kind === 'routed') {
      assert.equal(retried.handoff, true);
      assert.equal(retried.handoffFallbackRequired, undefined);
      assert.equal(retried.route.ownerIncarnation, 2);
    }
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
    const base = await resolveAgentRoute({
      turn: turn({ text: '<@U_BOT> help', source: 'app_mention' }), surface: 'channel',
      actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(base.kind, 'routed');
    if (base.kind === 'routed') {
      assert.equal(base.assignment.agentId, first.id);
      assert.equal(base.assignment.interactionMode, 'workspace_management');
    }

    const outsider = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev-outsider', messageTs: '101.1', threadTs: '101.1',
        text: '<@U_BOT> help', source: 'app_mention',
      }),
      surface: 'channel', actor: { channelMember: false, fullMember: true }, config: store,
    });
    assert.equal(outsider.kind, 'denied');

    const dm = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: 'hello', source: 'dm_message', channelType: 'im',
        contextMode: 'dm_history',
      }),
      surface: 'direct', actor: { channelMember: false, fullMember: true }, config: store,
    });
    assert.equal(dm.kind, 'routed');
    if (dm.kind === 'routed') {
      assert.equal(dm.assignment.agentId, first.id);
      assert.equal(dm.assignment.interactionMode, undefined);
    }
  } finally {
    store.close();
  }
});

test('activated plain base-app DMs and mentions route to the Chickpea system Agent', async () => {
  const { store } = await fixture();
  try {
    const chickpea = await activateChickpea(store);
    const dm = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: 'hey', source: 'dm_message', channelType: 'im',
        contextMode: 'dm_history',
      }),
      surface: 'direct', actor: { channelMember: false, fullMember: true }, config: store,
    });
    assert.equal(dm.kind, 'routed');
    if (dm.kind !== 'routed') return;
    assert.equal(dm.assignment.agentId, chickpea.id);
    assert.equal(dm.assignment.ownerIncarnation, 1);

    const channel = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '200.1', threadTs: '200.1',
        text: '<@U_BOT> help', source: 'app_mention',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(channel.kind, 'routed');
    if (channel.kind === 'routed') {
      assert.equal(channel.assignment.agentId, chickpea.id);
      assert.equal(channel.assignment.interactionMode, 'workspace_management');
    }
  } finally {
    store.close();
  }
});

test('activated addressed DM roots are sticky and explicit addresses transfer ownership', async () => {
  const { store, support, finance } = await fixture();
  try {
    const chickpea = await activateChickpea(store);
    const actor = {
      channelMember: false,
      fullMember: true,
      discoverableAgentIds: new Set([support.id, finance.id]),
    };
    const opened = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: '<!subteam^SSUPPORT|@support> hey', source: 'dm_message',
        channelType: 'im', contextMode: 'dm_history',
      }),
      surface: 'direct', actor, config: store,
    });
    assert.equal(opened.kind, 'routed');
    if (opened.kind !== 'routed') return;
    assert.equal(opened.assignment.agentId, support.id);
    assert.equal(opened.route.ownerIncarnation, 1);

    const continued = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', eventId: 'Ev2', messageTs: '100.2', text: 'more',
        source: 'dm_message', channelType: 'im', contextMode: 'thread',
      }),
      surface: 'direct', actor, config: store,
    });
    assert.equal(continued.kind, 'routed');
    if (continued.kind !== 'routed') return;
    assert.equal(continued.assignment.agentId, support.id);
    assert.equal(continued.route.ownerIncarnation, 1);

    const transferred = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', eventId: 'Ev3', messageTs: '100.3',
        text: '<!subteam^SFINANCE|@finance> take over', source: 'dm_message',
        channelType: 'im', contextMode: 'thread',
      }),
      surface: 'direct', actor, config: store,
    });
    assert.equal(transferred.kind, 'routed');
    if (transferred.kind !== 'routed') return;
    assert.equal(transferred.assignment.agentId, finance.id);
    assert.equal(transferred.route.ownerIncarnation, 2);

    const returned = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', eventId: 'Ev4', messageTs: '100.4',
        text: '<@U_BOT> help', source: 'app_mention', channelType: 'im', contextMode: 'thread',
      }),
      surface: 'direct', actor, config: store,
    });
    assert.equal(returned.kind, 'routed');
    if (returned.kind === 'routed') {
      assert.equal(returned.assignment.agentId, chickpea.id);
      assert.equal(returned.route.ownerIncarnation, 3);
    }
  } finally {
    store.close();
  }
});

test('ambiguous, unknown, and unauthorized DM addresses do not mutate ownership', async () => {
  const { store, support } = await fixture();
  try {
    await activateChickpea(store);
    const actor = {
      channelMember: false,
      fullMember: true,
      discoverableAgentIds: new Set([support.id]),
    };
    await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: '<!subteam^SSUPPORT> hey', source: 'dm_message',
        channelType: 'im', contextMode: 'dm_history',
      }),
      surface: 'direct', actor, config: store,
    });
    const before = await store.getAgentThreadRoute('T1', 'D1', '100.1');
    assert.ok(before);

    for (const text of [
      '<!subteam^SSUPPORT> and <!subteam^SFINANCE>',
      '<!subteam^SUNKNOWN> help',
      '<!subteam^SFINANCE> help',
    ]) {
      const result = await resolveAgentRoute({
        turn: turn({
          channelId: 'D1', eventId: `Ev-${text}`, messageTs: '100.2', text,
          source: 'dm_message', channelType: 'im', contextMode: 'thread',
        }),
        surface: 'direct', actor, config: store,
      });
      assert.notEqual(result.kind, 'routed');
      assert.deepEqual(
        await store.getAgentThreadRoute('T1', 'D1', '100.1'),
        before,
      );
    }
  } finally {
    store.close();
  }
});

test('repeating the current owner and editing its profile do not rotate owner incarnation', async () => {
  const { store, support } = await fixture();
  try {
    await activateChickpea(store);
    const actor = {
      channelMember: false,
      fullMember: true,
      discoverableAgentIds: new Set([support.id]),
    };
    const opened = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: '<!subteam^SSUPPORT> hey', source: 'dm_message',
        channelType: 'im', contextMode: 'dm_history',
      }),
      surface: 'direct', actor, config: store,
    });
    assert.equal(opened.kind, 'routed');

    const repeated = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', eventId: 'Ev2', messageTs: '100.2',
        text: '<!subteam^SSUPPORT> still you', source: 'dm_message',
        channelType: 'im', contextMode: 'thread',
      }),
      surface: 'direct', actor, config: store,
    });
    assert.equal(repeated.kind, 'routed');
    if (repeated.kind !== 'routed') return;
    assert.equal(repeated.route.ownerIncarnation, 1);

    const edited = await store.updateAgent(support.id, {
      configurationGeneration: 2,
    }, support.revision);
    assert.equal(edited.configurationGeneration, 2);
    const afterEdit = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', eventId: 'Ev3', messageTs: '100.3', text: 'continue',
        source: 'dm_message', channelType: 'im', contextMode: 'thread',
      }),
      surface: 'direct', actor, config: store,
    });
    assert.equal(afterEdit.kind, 'routed');
    if (afterEdit.kind === 'routed') {
      assert.equal(afterEdit.route.ownerIncarnation, 1);
      assert.equal(afterEdit.route.revision, 2);
    }
  } finally {
    store.close();
  }
});

test('an explicit @Chickpea mention takes over an Agent thread without a default-Agent grant', async () => {
  const { store, first, support } = await fixture();
  try {
    const opened = await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(opened.kind, 'routed');
    if (opened.kind !== 'routed') return;
    assert.equal(opened.assignment.agentId, support.id);

    const handedOff = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: '<@U_BOT> manage this workspace',
        source: 'app_mention', contextMode: 'thread',
      }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(handedOff.kind, 'routed');
    if (handedOff.kind !== 'routed') return;
    assert.equal(handedOff.assignment.agentId, first.id);
    assert.equal(handedOff.source, 'default_agent');
    assert.equal(handedOff.handoff, true);
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
