import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { createDemoStarterAgent } from '../src/config/seed.ts';
import { AgentRevisionConflictError } from '../src/config/errors.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  handoffCreatedAgentThread,
  resolveAgentRoute,
} from '../src/slack/agent-routing.ts';
import {
  AgentUserGroupLookupLimiter,
  repairMentionedAgentUserGroup,
} from '../src/slack/agent-presence/reconciler.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

type MentionRepairConfig = Parameters<typeof repairMentionedAgentUserGroup>[0]['config'];

const allowUserAgent = async () => ({
  status: 'allowed' as const,
  audience: 'workspace_members' as const,
});

function turn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'C1', eventId: 'Ev1', text: '<!subteam^SSUPPORT|@support> help',
    userId: 'U1', messageTs: '100.1', threadTs: '100.1', source: 'agent_mention',
    channelType: 'channel', contextMode: 'channel_history', ...patch,
  };
}

async function fixture() {
  const store = new SqliteConfigStore(':memory:', { agents: [createDemoStarterAgent()] });
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
    workspaceId: 'T1', transportMode: 'direct', defaultAgentId: first.id, runtimeContract: 'legacy',
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

test('a plain reply continues an explicitly opened Chickpea Channel thread without a grant', async () => {
  const { store } = await fixture();
  try {
    const chickpea = await activateChickpea(store);
    const opened = await resolveAgentRoute({
      turn: turn({
        text: '<@U_BOT> create a Paid Marketing Agent',
        source: 'app_mention',
      }),
      surface: 'channel',
      actor: { channelMember: true, fullMember: true },
      config: store,
    });
    assert.equal(opened.kind, 'routed');
    if (opened.kind !== 'routed') return;
    assert.equal(opened.source, 'default_agent');
    assert.equal(opened.assignment.agentId, chickpea.id);
    assert.equal(opened.assignment.interactionMode, 'workspace_management');
    assert.equal(
      (await store.listAgentChannelGrants('T1', 'C1'))
        .some(({ agentId }) => agentId === chickpea.id),
      false,
    );

    const approvalTurn = turn({
      eventId: 'Ev2',
      messageTs: '100.2',
      text: 'create it',
      source: 'implicit_thread_reply',
      contextMode: 'thread',
    });
    const outsider = await resolveAgentRoute({
      turn: approvalTurn,
      surface: 'channel',
      actor: { channelMember: false, fullMember: true },
      config: store,
    });
    assert.equal(outsider.kind, 'denied');

    const approved = await resolveAgentRoute({
      turn: approvalTurn,
      surface: 'channel',
      actor: { channelMember: true, fullMember: true },
      config: store,
    });
    assert.equal(approved.kind, 'routed');
    if (approved.kind !== 'routed') return;
    assert.equal(approved.source, 'thread_owner');
    assert.equal(approved.assignment.agentId, chickpea.id);
    assert.equal(approved.assignment.interactionMode, 'workspace_management');
  } finally {
    store.close();
  }
});

test('a threaded Chickpea DM stays on the ordinary direct-message path', async () => {
  const { store } = await fixture();
  try {
    const chickpea = await activateChickpea(store);
    const directTurn = turn({
      channelId: 'D1',
      text: 'help me configure Chickpea',
      source: 'dm_message',
      channelType: 'im',
      contextMode: 'dm_history',
    });
    const opened = await resolveAgentRoute({
      turn: directTurn,
      surface: 'direct',
      actor: { channelMember: true, fullMember: true },
      config: store,
    });
    assert.equal(opened.kind, 'routed');
    if (opened.kind !== 'routed') return;
    assert.equal(opened.assignment.agentId, chickpea.id);
    assert.equal(opened.assignment.interactionMode, undefined);

    const continued = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1',
        eventId: 'Ev2',
        messageTs: '100.2',
        text: 'one more thing',
        source: 'dm_message',
        channelType: 'im',
        contextMode: 'dm_history',
      }),
      surface: 'direct',
      actor: { channelMember: true, fullMember: true },
      config: store,
    });
    assert.equal(continued.kind, 'routed');
    if (continued.kind !== 'routed') return;
    assert.equal(continued.source, 'thread_owner');
    assert.equal(continued.assignment.agentId, chickpea.id);
    assert.equal(continued.assignment.interactionMode, undefined);
  } finally {
    store.close();
  }
});

test('an acknowledged creation welcome transfers only the granted source Channel thread', async () => {
  const { store, first, support } = await fixture();
  try {
    await activateChickpea(store);
    await store.putAgentThreadRoute({
      workspaceId: 'T1',
      channelId: 'C1',
      threadTs: '100.1',
      agentId: first.id,
      agentGeneration: first.revision,
      ownerIncarnation: 1,
    });
    const handedOff = await handoffCreatedAgentThread({
      workspaceId: 'T1',
      channelId: 'C1',
      threadTs: '100.1',
      welcomeMessageTs: '100.3',
      agentId: support.id,
      requesterMembershipId: 'membership_owner',
      surface: 'channel',
      config: store,
    });
    assert.equal(handedOff.source, 'creation_handoff');
    assert.equal(handedOff.assignment.agentId, support.id);
    assert.equal(handedOff.previousAgentId, first.id);
    assert.equal(
      (await store.getAgentThreadRoute('T1', 'C1', '100.1'))?.agentId,
      support.id,
    );

    await assert.rejects(() => handoffCreatedAgentThread({
      workspaceId: 'T1',
      channelId: 'C_WITHOUT_GRANT',
      threadTs: '200.1',
      welcomeMessageTs: '200.2',
      agentId: support.id,
      requesterMembershipId: 'membership_owner',
      surface: 'channel',
      config: store,
    }), /active source Channel grant/);
  } finally {
    store.close();
  }
});

test('an authenticated unknown group repairs a proven interrupted-create mapping before routing', async () => {
  const { store, support } = await fixture();
  try {
    const startedAt = 1_800_000_000_000;
    await store.updateAgent(support.id, {
      lifecycle: 'needs_attention',
      slackPresence: {
        ...support.slackPresence!,
        kind: 'user_group',
        userGroupId: 'SOLD',
        health: 'needs_attention',
        errorCode: 'user_group_create_ambiguous',
        errorDetail: 'Slack may have created this group.',
        pendingCreate: {
          name: support.name,
          handle: 'support',
          description: support.description!,
          startedAt,
        },
      },
    }, support.revision);
    let lookups = 0;
    const resolved = await resolveAgentRoute({
      turn: turn({ text: '<!subteam^SREPAIRED|@finance> help' }),
      surface: 'channel',
      actor: { channelMember: true, fullMember: true },
      config: store,
      transport: {
        lookupUserGroup: async (groupId: string) => {
          lookups += 1;
          assert.equal(groupId, 'SREPAIRED');
          return {
            id: groupId,
            name: support.name,
            handle: 'support',
            description: support.description!,
            disabled: false,
            updatedAt: Math.floor(startedAt / 1_000),
          };
        },
      },
    });

    assert.equal(resolved.kind, 'routed');
    if (resolved.kind !== 'routed') return;
    assert.equal(resolved.assignment.agentId, support.id);
    assert.equal(resolved.source, 'agent_handle');
    assert.equal(lookups, 1);
    assert.equal((await store.getAgent(support.id)).slackPresence?.userGroupId, 'SREPAIRED');
  } finally {
    store.close();
  }
});

test('an authenticated directory handle overrides a forged message label for one unique claim', async () => {
  const { store, support } = await fixture();
  try {
    const resolved = await resolveAgentRoute({
      turn: turn({ text: '<!subteam^SAUTHENTICATED|@forged-label> help' }),
      surface: 'channel',
      actor: { channelMember: true, fullMember: true },
      config: store,
      transport: {
        lookupUserGroup: async () => ({
          id: 'SAUTHENTICATED',
          name: support.name,
          handle: 'support',
          description: support.description!,
          disabled: false,
          updatedAt: 1_800_000_000,
        }),
      },
    });

    assert.equal(resolved.kind, 'routed');
    if (resolved.kind !== 'routed') return;
    assert.equal(resolved.assignment.agentId, support.id);
    assert.equal((await store.getAgent(support.id)).slackPresence?.userGroupId, 'SAUTHENTICATED');
  } finally {
    store.close();
  }
});

test('a stored user-group id stays on the no-network routing path', async () => {
  const { store, support } = await fixture();
  try {
    let lookups = 0;
    const resolved = await resolveAgentRoute({
      turn: turn(),
      surface: 'channel',
      actor: { channelMember: true, fullMember: true },
      config: store,
      transport: {
        lookupUserGroup: async () => {
          lookups += 1;
          throw new Error('the stored-id path must not read Slack directory state');
        },
      },
    });
    assert.equal(resolved.kind, 'routed');
    if (resolved.kind === 'routed') assert.equal(resolved.assignment.agentId, support.id);
    assert.equal(lookups, 0);
  } finally {
    store.close();
  }
});

test('a stored group id with competing Agent claims fails closed without a directory lookup', async () => {
  const { store, finance } = await fixture();
  try {
    await store.updateAgent(finance.id, {
      slackPresence: { ...finance.slackPresence!, kind: 'user_group', userGroupId: 'SSUPPORT' },
    }, finance.revision);
    let lookups = 0;
    const resolved = await resolveAgentRoute({
      turn: turn(), surface: 'channel',
      actor: { channelMember: true, fullMember: true }, config: store,
      transport: {
        lookupUserGroup: async () => {
          lookups += 1;
          return undefined;
        },
      },
    });
    assert.equal(resolved.kind, 'denied');
    assert.equal(lookups, 0);
  } finally {
    store.close();
  }
});

test('directory repair rejects disabled, ambiguous, inactive, ungranted, and competing claims', async () => {
  const { store, support, finance } = await fixture();
  try {
    const startedAt = 1_800_000_000_000;
    const proven: CustomAgentConfig = {
      ...support,
      lifecycle: 'needs_attention',
      slackPresence: {
        ...support.slackPresence!,
        kind: 'user_group',
        userGroupId: 'SOLD',
        desiredState: 'active',
        health: 'needs_attention',
        errorCode: 'user_group_create_ambiguous',
        pendingCreate: {
          name: support.name,
          handle: 'support',
          description: support.description!,
          startedAt,
        },
      },
    };
    const group = {
      id: 'SUNKNOWN',
      name: support.name,
      handle: 'support',
      description: support.description!,
      disabled: false,
      updatedAt: Math.floor(startedAt / 1_000),
    };
    const grant = (await store.listAgentChannelGrants('T1', 'C1')).find(
      (candidate) => candidate.agentId === support.id,
    )!;
    const cases: Array<{
      name: string;
      agents: CustomAgentConfig[];
      grants: typeof grant[];
      disabled?: boolean;
    }> = [
      { name: 'disabled group', agents: [proven], grants: [grant], disabled: true },
      {
        name: 'ambiguous normalized handle',
        agents: [
          proven,
          {
            ...finance,
            slackPresence: {
              ...finance.slackPresence!,
              requestedHandle: 'support',
              normalizedHandle: 'support',
              desiredState: 'active',
            },
          },
        ],
        grants: [grant],
      },
      { name: 'inactive Agent', agents: [{ ...proven, enabled: false }], grants: [grant] },
      { name: 'missing Channel grant', agents: [proven], grants: [] },
      {
        name: 'competing group claim',
        agents: [
          proven,
          { ...finance, slackPresence: { ...finance.slackPresence!, kind: 'user_group', userGroupId: group.id } },
        ],
        grants: [grant],
      },
    ];

    for (const scenario of cases) {
      let updates = 0;
      const result = await repairMentionedAgentUserGroup({
        workspaceId: 'T1',
        channelId: 'C1',
        userGroupId: group.id,
        config: {
          listAgents: async () => scenario.agents,
          listAgentChannelGrants: async () => scenario.grants,
          updateAgent: async () => {
            updates += 1;
            return proven;
          },
        } satisfies MentionRepairConfig,
        transport: {
          lookupUserGroup: async () => ({ ...group, disabled: scenario.disabled ?? false }),
        },
        limiter: new AgentUserGroupLookupLimiter(),
      });
      assert.equal(result.kind, 'unknown', scenario.name);
      assert.equal(updates, 0, scenario.name);
    }
  } finally {
    store.close();
  }
});

test('directory repair turns a concurrent Agent edit into a retryable safe denial', async () => {
  const { store, support } = await fixture();
  try {
    const startedAt = 1_800_000_000_000;
    const proven: CustomAgentConfig = {
      ...support,
      lifecycle: 'needs_attention',
      slackPresence: {
        ...support.slackPresence!,
        kind: 'user_group',
        userGroupId: 'SOLD',
        desiredState: 'active',
        health: 'needs_attention',
        errorCode: 'user_group_create_ambiguous',
        pendingCreate: {
          name: support.name,
          handle: 'support',
          description: support.description!,
          startedAt,
        },
      },
    };
    const grant = (await store.listAgentChannelGrants('T1', 'C1')).find(
      (candidate) => candidate.agentId === support.id,
    )!;
    const result = await repairMentionedAgentUserGroup({
      workspaceId: 'T1', channelId: 'C1', userGroupId: 'SREPAIRED',
      config: {
        listAgents: async () => [proven],
        listAgentChannelGrants: async () => [grant],
        updateAgent: async () => {
          throw new AgentRevisionConflictError(proven.id, proven.revision, proven.revision + 1);
        },
      } satisfies MentionRepairConfig,
      transport: {
        lookupUserGroup: async () => ({
          id: 'SREPAIRED', name: support.name, handle: 'support',
          description: support.description!, disabled: false,
          updatedAt: Math.floor(startedAt / 1_000),
        }),
      },
      limiter: new AgentUserGroupLookupLimiter(),
    });
    assert.equal(result.kind, 'temporarily_unavailable');
  } finally {
    store.close();
  }
});

test('unknown group lookup uses negative caching and a bounded per-workspace window', async () => {
  let lookups = 0;
  const limiter = new AgentUserGroupLookupLimiter({
    now: () => 1_800_000_000_000,
    maxLookupsPerWindow: 2,
  });
  const transport = {
    lookupUserGroup: async () => {
      lookups += 1;
      return undefined;
    },
  };
  assert.equal((await limiter.lookup('T1', 'S1', transport)).kind, 'missing');
  assert.equal((await limiter.lookup('T1', 'S1', transport)).kind, 'missing');
  assert.equal((await limiter.lookup('T1', 'S2', transport)).kind, 'missing');
  assert.equal((await limiter.lookup('T1', 'S3', transport)).kind, 'rate_limited');
  assert.equal(lookups, 2);

  let failures = 0;
  const failureLimiter = new AgentUserGroupLookupLimiter({
    now: () => 1_800_000_000_000,
  });
  const failingTransport = {
    lookupUserGroup: async () => {
      failures += 1;
      throw new Error('Slack unavailable');
    },
  };
  assert.equal((await failureLimiter.lookup('T1', 'SFAIL', failingTransport)).kind, 'failed');
  assert.equal((await failureLimiter.lookup('T1', 'SFAIL', failingTransport)).kind, 'failed');
  assert.equal(failures, 1);
});

test('concurrent unknown-group repairs share one directory lookup', async () => {
  let lookups = 0;
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const input = {
    workspaceId: 'T1',
    channelId: 'C1',
    userGroupId: 'SUNKNOWN',
    config: {
      listAgents: async () => [],
      listAgentChannelGrants: async () => [],
      updateAgent: async () => {
        throw new Error('a missing group never reaches persistence');
      },
    } satisfies MentionRepairConfig,
    transport: {
      lookupUserGroup: async () => {
        lookups += 1;
        await lookupGate;
        return undefined;
      },
    },
    limiter: new AgentUserGroupLookupLimiter(),
  };

  const first = repairMentionedAgentUserGroup(input);
  const second = repairMentionedAgentUserGroup(input);
  assert.equal(lookups, 1);
  releaseLookup();
  assert.deepEqual(await Promise.all([first, second]), [
    { kind: 'unknown' },
    { kind: 'unknown' },
  ]);
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

test('a switched-off Agent\'s handle discloses only permitted alternatives and keeps the current owner', async () => {
  const { store, support, finance } = await fixture();
  try {
    await resolveAgentRoute({
      turn: turn(), surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    await store.deleteAgentChannelGrant('T1', 'C1', finance.id);
    await store.updateAgent(finance.id, { enabled: false }, finance.revision);
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

test('a non-member Channel denial never enumerates Agent alternatives', async () => {
  const { store } = await fixture();
  try {
    let lookups = 0;
    const result = await resolveAgentRoute({
      turn: turn({ text: '<!subteam^SUNKNOWN|@unknown> help' }), surface: 'channel',
      actor: { channelMember: false, fullMember: false }, config: store,
      transport: {
        lookupUserGroup: async () => {
          lookups += 1;
          return undefined;
        },
      },
    });
    assert.equal(result.kind, 'denied');
    if (result.kind === 'denied') assert.deepEqual(result.alternatives, []);
    const direct = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1',
        channelType: 'im',
        source: 'dm_message',
        text: '<!subteam^SUNKNOWN|@unknown> help',
      }),
      surface: 'direct',
      actor: { channelMember: false, fullMember: false },
      config: store,
      transport: {
        lookupUserGroup: async () => {
          lookups += 1;
          return undefined;
        },
      },
    });
    assert.equal(direct.kind, 'denied');
    if (direct.kind === 'denied') {
      assert.equal(direct.reason, 'member_required');
      assert.deepEqual(direct.alternatives, []);
    }
    assert.equal(lookups, 0);
  } finally {
    store.close();
  }
});

test('several Agent handles address each Agent in order, and root messages without an address are ignored', async () => {
  const { store, support, finance } = await fixture();
  try {
    const actor = { channelMember: true, fullMember: true };
    const both = await resolveAgentRoute({
      turn: turn({ text: '<!subteam^SFINANCE> and <!subteam^SSUPPORT> please compare notes' }),
      surface: 'channel', actor, config: store,
    });
    assert.equal(both.kind, 'routed');
    if (both.kind !== 'routed') return;
    // The first handle takes the thread; the rest answer after it.
    assert.equal(both.assignment.agentId, finance.id);
    assert.deepEqual(both.coAddressed, {
      agents: [
        { agentId: finance.id, name: finance.name, handle: 'finance' },
        { agentId: support.id, name: support.name, handle: 'support' },
      ],
      position: 0,
    });
    assert.equal((await store.getAgentThreadRoute('T1', 'C1', '100.1'))?.agentId, finance.id);

    // One mentioned Agent is not in this Channel: nobody is asked, and it is named.
    await store.createAgent({
      id: 'agent_legal', name: 'Legal', instructions: 'Legal.', enabled: true, lifecycle: 'active',
      creatorMembershipId: 'membership_owner', editPolicy: 'creator_and_admins',
      model: 'local-stub/legal', skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'legal', normalizedHandle: 'legal', desiredState: 'active',
        health: 'healthy', userGroupId: 'SLEGAL',
        avatar: { kind: 'generated', revision: 1, seed: 'legal' },
      },
    });
    const withUngranted = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '102.1', threadTs: '102.1',
        text: '<!subteam^SSUPPORT> <!subteam^SLEGAL> can we refund?',
      }),
      surface: 'channel', actor, config: store,
    });
    assert.equal(withUngranted.kind, 'not_in_channel');
    if (withUngranted.kind === 'not_in_channel') assert.equal(withUngranted.agent.id, 'agent_legal');
    assert.equal(await store.getAgentThreadRoute('T1', 'C1', '102.1'), undefined);

    const ignored = await resolveAgentRoute({
      turn: turn({ eventId: 'Ev3', messageTs: '103.1', threadTs: '103.1', text: 'hello everyone' }),
      surface: 'channel', actor, config: store,
    });
    assert.equal(ignored.kind, 'ignore');
  } finally {
    store.close();
  }
});

test('legacy defaults require ordinary placement authority on every surface', async () => {
  const { store, first } = await fixture();
  try {
    const base = await resolveAgentRoute({
      turn: turn({ text: '<@U_BOT> help', source: 'app_mention' }), surface: 'channel',
      actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(base.kind, 'denied');

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
      authorizeUserAgent: allowUserAgent,
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

test('one message addresses at most six Agents, in mention order', async () => {
  const { store } = await fixture();
  try {
    const handles: string[] = [];
    for (let index = 1; index <= 7; index += 1) {
      const id = `agent_extra_${index}`;
      await store.createAgent({
        id, name: `Extra ${index}`, instructions: 'Help.', enabled: true, lifecycle: 'active',
        creatorMembershipId: 'membership_owner', editPolicy: 'creator_and_admins',
        model: 'local-stub/extra', skills: [], mcpServers: [], apiConnections: [], repositories: [],
        slackPresence: {
          requestedHandle: `extra-${index}`, normalizedHandle: `extra-${index}`, desiredState: 'active',
          health: 'healthy', userGroupId: `SEXTRA${index}`,
          avatar: { kind: 'generated', revision: 1, seed: `extra-${index}` },
        },
      });
      await store.putAgentChannelGrant({
        workspaceId: 'T1', channelId: 'C1', agentId: id, status: 'active',
        createdByMembershipId: 'membership_owner', channelLabel: 'support', channelIsPrivate: false,
      });
      handles.push(`<!subteam^SEXTRA${index}|@extra-${index}>`);
    }
    const routed = await resolveAgentRoute({
      turn: turn({ text: `${handles.join(' ')} thoughts?` }),
      surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
    });
    assert.equal(routed.kind, 'routed');
    if (routed.kind !== 'routed') return;
    assert.equal(routed.assignment.agentId, 'agent_extra_1');
    assert.deepEqual(routed.coAddressed?.agents.map(({ handle }) => handle),
      ['extra-1', 'extra-2', 'extra-3', 'extra-4', 'extra-5', 'extra-6']);
  } finally {
    store.close();
  }
});

const DM_ACTOR = { channelMember: false, fullMember: true };

function dmTurn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return turn({
    channelId: 'D1', source: 'dm_message', channelType: 'im', contextMode: 'dm_history', ...patch,
  });
}

function dmAskTurn(messageTs: string, text: string): NormalizedSlackTurn {
  return dmTurn({
    eventId: `agent-ask:${messageTs}`, messageTs, text, source: 'agent_mention', contextMode: 'thread',
    agentAsk: { fromAgentId: 'agent_support', fromAgentName: 'Support', fromAgentHandle: 'support', originMessageTs: '100.1' },
  });
}

async function supportDmThread() {
  const routes = await fixture();
  await activateChickpea(routes.store);
  const legal = await routes.store.createAgent({
    id: 'agent_legal', name: 'Legal', instructions: 'Legal.', enabled: true, lifecycle: 'active',
    creatorMembershipId: 'membership_owner', editPolicy: 'creator_and_admins',
    model: 'local-stub/legal', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: 'legal', normalizedHandle: 'legal', desiredState: 'active',
      health: 'healthy', userGroupId: 'SLEGAL',
      avatar: { kind: 'generated', revision: 1, seed: 'legal' },
    },
  });
  const opened = await resolveAgentRoute({
    turn: dmTurn({ text: '<!subteam^SSUPPORT|@support> can we refund order 4821?' }),
    surface: 'direct', actor: DM_ACTOR, config: routes.store, authorizeUserAgent: allowUserAgent,
  });
  assert.equal(opened.kind === 'routed' && opened.assignment.agentId, routes.support.id);
  return { ...routes, legal };
}

function answeredInDm(store: SqliteConfigStore, agentId: string, messageTs: string) {
  return store.putSlackPublicContext({
    workspaceId: 'T1', channelId: 'D1', rootTs: '100.1', messageTs, role: 'agent', agentId,
    text: `${agentId} answered.`,
  });
}

function countingRecordReads(store: SqliteConfigStore) {
  const reads: string[] = [];
  const config = new Proxy(store, {
    get(target, key) {
      if (key === 'listSlackPublicContext') {
        return (...args: Parameters<SqliteConfigStore['listSlackPublicContext']>) => {
          reads.push(args[2]);
          return target.listSlackPublicContext(...args);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { config, reads };
}

test('a direct message that mentions several usable Agents routes to the first, and the rest answer after it', async () => {
  const { store, support, finance } = await fixture();
  try {
    await activateChickpea(store);
    const routed = await resolveAgentRoute({
      turn: dmTurn({ text: '<!subteam^SSUPPORT|@support> <!subteam^SFINANCE|@finance> go back and forth on this' }),
      surface: 'direct', actor: DM_ACTOR, config: store, authorizeUserAgent: allowUserAgent,
    });
    assert.equal(routed.kind, 'routed');
    if (routed.kind !== 'routed') return;
    assert.equal(routed.assignment.agentId, support.id);
    assert.deepEqual(routed.coAddressed, {
      agents: [
        { agentId: support.id, name: 'Support', handle: 'support' },
        { agentId: finance.id, name: 'Finance', handle: 'finance' },
      ],
      position: 0,
    });
    assert.deepEqual(routed.assignment.teammates, [{ name: 'Finance', handle: 'finance', userGroupId: 'SFINANCE' }]);
    assert.equal((await store.getAgentThreadRoute('T1', 'D1', '100.1'))?.agentId, support.id);
  } finally {
    store.close();
  }
});

test('a direct message that mentions an Agent this person cannot use privately asks none of them and names none', async () => {
  const { store, support } = await fixture();
  try {
    await activateChickpea(store);
    const authorized: string[] = [];
    const result = await resolveAgentRoute({
      turn: dmTurn({ text: '<!subteam^SSUPPORT|@support> <!subteam^SFINANCE|@finance> compare notes' }),
      surface: 'direct', actor: DM_ACTOR, config: store,
      authorizeUserAgent: async (agent) => {
        authorized.push(agent.id);
        return agent.id === support.id
          ? { status: 'allowed' as const, audience: 'workspace_members' as const }
          : { status: 'denied' as const, audience: 'private_channel_members' as const };
      },
    });
    assert.deepEqual(result, { kind: 'denied', reason: 'not_available', alternatives: [] });
    assert.ok(authorized.includes('agent_finance'), 'the later Agent was checked as the person may use it here');
    assert.equal(await store.getAgentThreadRoute('T1', 'D1', '100.1'), undefined);
  } finally {
    store.close();
  }
});

test('a later Agent a direct message mentioned answers in the first Agent\'s thread as a guest', async () => {
  const { store, support, finance } = await fixture();
  try {
    await activateChickpea(store);
    const text = '<!subteam^SSUPPORT|@support> <!subteam^SFINANCE|@finance> go back and forth on this';
    const first = await resolveAgentRoute({
      turn: dmTurn({ text }), surface: 'direct', actor: DM_ACTOR, config: store,
      authorizeUserAgent: allowUserAgent,
    });
    assert.equal(first.kind, 'routed');
    if (first.kind !== 'routed') return;
    const later = await resolveAgentRoute({
      turn: dmTurn({
        eventId: `co-addressed:D1:100.1:${finance.id}`, text, contextMode: 'thread',
        coAddressed: { ...first.coAddressed!, position: 1 },
      }),
      surface: 'direct', actor: DM_ACTOR, config: store, askAgentId: finance.id,
      authorizeUserAgent: allowUserAgent,
    });
    assert.equal(later.kind, 'routed');
    if (later.kind !== 'routed') return;
    assert.equal(later.assignment.agentId, finance.id);
    assert.equal(later.assignment.threadGuest, true);
    assert.deepEqual(later.assignment.teammates, [{ name: 'Support', handle: 'support', userGroupId: 'SSUPPORT' }]);
    assert.equal((await store.getAgentThreadRoute('T1', 'D1', '100.1'))?.agentId, support.id);
  } finally {
    store.close();
  }
});

test('in a direct thread an Agent can ask only an Agent that answered there', async () => {
  const { store, legal } = await supportDmThread();
  try {
    const ask = () => resolveAgentRoute({
      turn: dmAskTurn('100.2', '@legal may we refund?'), surface: 'direct', actor: DM_ACTOR, config: store,
      askAgentId: legal.id, authorizeUserAgent: allowUserAgent,
    });
    assert.deepEqual(await ask(), { kind: 'denied', reason: 'not_available', alternatives: [] });

    await answeredInDm(store, legal.id, '100.15');
    const asked = await ask();
    assert.equal(asked.kind, 'routed');
    if (asked.kind !== 'routed') return;
    assert.equal(asked.source, 'agent_ask');
    assert.equal(asked.assignment.agentId, legal.id);
    assert.equal(asked.assignment.threadGuest, true);
    assert.deepEqual(asked.assignment.teammates, [{ name: 'Support', handle: 'support', userGroupId: 'SSUPPORT' }]);
  } finally {
    store.close();
  }
});

test('an Agent in a direct thread is asked only while this person may still use it privately', async () => {
  const { store, finance } = await supportDmThread();
  try {
    await answeredInDm(store, finance.id, '100.15');
    const ask = (financeAccess: 'allowed' | 'denied') => resolveAgentRoute({
      turn: dmAskTurn('100.2', '@finance what was charged?'), surface: 'direct', actor: DM_ACTOR, config: store,
      askAgentId: finance.id,
      authorizeUserAgent: async (agent) => ({
        status: agent.id === finance.id ? financeAccess : 'allowed' as const,
        audience: 'private_channel_members' as const,
      }),
    });
    assert.equal((await ask('allowed')).kind, 'routed');
    assert.deepEqual(await ask('denied'), { kind: 'denied', reason: 'not_available', alternatives: [] });
  } finally {
    store.close();
  }
});

test('a person\'s message that mentioned an Agent does not bring it into a direct thread', async () => {
  const { store, finance, legal } = await supportDmThread();
  try {
    await store.putSlackPublicContext({
      workspaceId: 'T1', channelId: 'D1', rootTs: '100.1', messageTs: '100.12', role: 'human',
      authorId: 'U1', text: '<!subteam^SLEGAL|@legal> join us',
    });
    await answeredInDm(store, finance.id, '100.15');
    const asked = await resolveAgentRoute({
      turn: dmAskTurn('100.2', '@legal may we refund?'), surface: 'direct', actor: DM_ACTOR, config: store,
      askAgentId: legal.id, authorizeUserAgent: allowUserAgent,
    });
    assert.deepEqual(asked, { kind: 'denied', reason: 'not_available', alternatives: [] });
    const reply = await resolveAgentRoute({
      turn: dmTurn({ eventId: 'Ev3', messageTs: '100.3', text: 'any update?', contextMode: 'thread' }),
      surface: 'direct', actor: DM_ACTOR, config: store, authorizeUserAgent: allowUserAgent,
    });
    assert.equal(reply.kind, 'routed');
    if (reply.kind !== 'routed') return;
    assert.deepEqual(reply.assignment.teammates, [{ name: 'Finance', handle: 'finance', userGroupId: 'SFINANCE' }]);
  } finally {
    store.close();
  }
});

test('a plain reply in a direct thread keeps the Agents that answered there as teammates, with no Slack lookup', async () => {
  const { store, support, finance } = await supportDmThread();
  try {
    await answeredInDm(store, finance.id, '100.15');
    const authorized: string[] = [];
    const lookups: string[] = [];
    const reply = await resolveAgentRoute({
      turn: dmTurn({ eventId: 'Ev3', messageTs: '100.3', text: 'what do you both think?', contextMode: 'thread' }),
      surface: 'direct', actor: DM_ACTOR, config: store,
      authorizeUserAgent: async (agent) => {
        authorized.push(agent.id);
        return { status: 'allowed' as const, audience: 'workspace_members' as const };
      },
      transport: { lookupUserGroup: async (groupId: string) => { lookups.push(groupId); return undefined; } },
    });
    assert.equal(reply.kind, 'routed');
    if (reply.kind !== 'routed') return;
    assert.equal(reply.source, 'thread_owner');
    assert.equal(reply.assignment.agentId, support.id);
    assert.deepEqual(reply.assignment.teammates, [{ name: 'Finance', handle: 'finance', userGroupId: 'SFINANCE' }]);
    assert.deepEqual(authorized, [support.id], 'only the routed Agent is checked');
    assert.deepEqual(lookups, []);
  } finally {
    store.close();
  }
});

test('a direct thread\'s record is read once per routing, and only for an existing thread a user Agent or an ask needs', async () => {
  const { store, finance } = await fixture();
  try {
    await activateChickpea(store);
    const { config, reads } = countingRecordReads(store);
    const route = (patch: Partial<NormalizedSlackTurn>, askAgentId?: string) => resolveAgentRoute({
      turn: dmTurn(patch), surface: 'direct', actor: DM_ACTOR, config,
      ...(askAgentId ? { askAgentId } : {}), authorizeUserAgent: allowUserAgent,
    });

    const opened = await route({ text: '<!subteam^SSUPPORT|@support> hi' });
    assert.equal(opened.kind, 'routed');
    if (opened.kind === 'routed') assert.equal(opened.assignment.teammates, undefined);
    await route({ eventId: 'Ev-cp1', messageTs: '200.1', threadTs: '200.1', text: 'hello' });
    await route({ eventId: 'Ev-cp2', messageTs: '200.2', threadTs: '200.1', text: 'and more', contextMode: 'thread' });
    assert.deepEqual(reads, []);

    await answeredInDm(store, finance.id, '100.15');
    const asked = await route(
      { eventId: 'Ev-ask', messageTs: '100.2', text: '@finance hi', source: 'agent_mention', contextMode: 'thread' },
      finance.id,
    );
    assert.equal(asked.kind, 'routed');
    assert.deepEqual(reads, ['100.1']);
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
    };
    const opened = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: '<!subteam^SSUPPORT|@support> hey', source: 'dm_message',
        channelType: 'im', contextMode: 'dm_history',
      }),
      surface: 'direct', actor, config: store, authorizeUserAgent: allowUserAgent,
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
      surface: 'direct', actor, config: store, authorizeUserAgent: allowUserAgent,
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
      surface: 'direct', actor, config: store, authorizeUserAgent: allowUserAgent,
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
      surface: 'direct', actor, config: store, authorizeUserAgent: allowUserAgent,
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

test('ambiguous, unauthorized, and non-Agent DM addresses do not mutate ownership', async () => {
  const { store, support } = await fixture();
  try {
    await activateChickpea(store);
    const actor = {
      channelMember: false,
      fullMember: true,
    };
    const authorizeUserAgent = async (agent: CustomAgentConfig) => agent.id === support.id
      ? { status: 'allowed' as const, audience: 'private_channel_members' as const }
      : { status: 'denied' as const, audience: 'private_channel_members' as const };
    await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: '<!subteam^SSUPPORT> hey', source: 'dm_message',
        channelType: 'im', contextMode: 'dm_history',
      }),
      surface: 'direct', actor, config: store, authorizeUserAgent,
    });
    const before = await store.getAgentThreadRoute('T1', 'D1', '100.1');
    assert.ok(before);

    for (const [text, routedTo] of [
      ['<!subteam^SSUPPORT> and <!subteam^SFINANCE>', undefined],
      // Not an Agent here: plain text, which the thread's Agent answers.
      ['<!subteam^SUNKNOWN> help', support.id],
      ['<!subteam^SFINANCE> help', undefined],
    ] as const) {
      const result = await resolveAgentRoute({
        turn: turn({
          channelId: 'D1', eventId: `Ev-${text}`, messageTs: '100.2', text,
          source: 'dm_message', channelType: 'im', contextMode: 'thread',
        }),
        surface: 'direct', actor, config: store, authorizeUserAgent,
      });
      assert.equal(result.kind === 'routed' ? result.assignment.agentId : undefined, routedTo, text);
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
    };
    const opened = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', text: '<!subteam^SSUPPORT> hey', source: 'dm_message',
        channelType: 'im', contextMode: 'dm_history',
      }),
      surface: 'direct', actor, config: store, authorizeUserAgent: allowUserAgent,
    });
    assert.equal(opened.kind, 'routed');

    const repeated = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', eventId: 'Ev2', messageTs: '100.2',
        text: '<!subteam^SSUPPORT> still you', source: 'dm_message',
        channelType: 'im', contextMode: 'thread',
      }),
      surface: 'direct', actor, config: store, authorizeUserAgent: allowUserAgent,
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
      surface: 'direct', actor, config: store, authorizeUserAgent: allowUserAgent,
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

test('a legacy user-created default cannot use the system-Agent Channel waiver', async () => {
  const { store, support } = await fixture();
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
    assert.equal(handedOff.kind, 'denied');
    assert.equal(
      (await store.getAgentThreadRoute('T1', 'C1', '100.1'))?.agentId,
      support.id,
    );
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
      },
      config: store,
      appHomeAgentId: support.id,
      authorizeUserAgent: allowUserAgent,
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

test('an existing Agent DM reaction reauthorizes before changing its stored route', async () => {
  const { store, support } = await fixture();
  try {
    const directTurn = turn({
      channelId: 'D1', text: '<!subteam^SSUPPORT> hey', source: 'dm_message',
      channelType: 'im', contextMode: 'dm_history',
    });
    const opened = await resolveAgentRoute({
      turn: directTurn,
      surface: 'direct',
      actor: { channelMember: false, fullMember: true },
      config: store,
      authorizeUserAgent: async () => ({
        status: 'allowed', audience: 'private_channel_members',
      }),
    });
    assert.equal(opened.kind, 'routed');
    const before = await store.getAgentThreadRoute('T1', 'D1', '100.1');
    assert.equal(before?.agentId, support.id);

    const revoked = await resolveAgentRoute({
      turn: {
        ...directTurn,
        eventId: 'Ev2',
        messageTs: '100.2',
        text: 'continue',
        source: 'reaction_added',
        reactionTargetTs: '100.1',
        reactionTargetText: 'original Agent reply',
      },
      surface: 'direct',
      actor: { channelMember: false, fullMember: true },
      config: store,
      authorizeUserAgent: async () => ({
        status: 'denied', audience: 'private_channel_members',
      }),
    });
    assert.equal(revoked.kind, 'denied');
    assert.deepEqual(
      await store.getAgentThreadRoute('T1', 'D1', '100.1'),
      before,
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

/** A workspace directory holding one group that is not this installation's Agent. */
function peopleGroup(id: string, handle: string) {
  return {
    lookupUserGroup: async (groupId: string) => groupId === id
      ? { id, name: handle, handle, description: 'People', disabled: false, updatedAt: 1_800_000_000 }
      : undefined,
  };
}

test('a user group that is not one of this installation\'s Agents addresses nobody in a Channel', async () => {
  const { store } = await fixture();
  try {
    for (const transport of [
      peopleGroup('SHELP', 'help'),
      { lookupUserGroup: async () => { throw new Error('Slack unavailable'); } },
    ]) {
      const result = await resolveAgentRoute({
        turn: turn({ text: '<!subteam^SHELP|@help> what instrument does chickpea play?' }),
        surface: 'channel', actor: { channelMember: true, fullMember: true }, config: store,
        transport, userGroupLookupLimiter: new AgentUserGroupLookupLimiter(),
      });
      assert.deepEqual(result, { kind: 'ignore' });
    }
  } finally {
    store.close();
  }
});

test('a people group mentioned beside an Agent, or in an Agent\'s thread, leaves that Agent answering', async () => {
  const { store, support } = await fixture();
  try {
    const actor = { channelMember: true, fullMember: true };
    const opened = await resolveAgentRoute({
      turn: turn({ text: '<!subteam^SPEOPLE|@oncall> <!subteam^SSUPPORT|@support> is checkout down?' }),
      surface: 'channel', actor, config: store, transport: peopleGroup('SPEOPLE', 'oncall'),
    });
    assert.equal(opened.kind, 'routed');
    if (opened.kind === 'routed') assert.equal(opened.assignment.agentId, support.id);

    const reply = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: 'thanks, looping in <!subteam^SPEOPLE|@oncall>',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor, config: store, transport: peopleGroup('SPEOPLE', 'oncall'),
    });
    assert.equal(reply.kind, 'routed');
    if (reply.kind === 'routed') {
      assert.equal(reply.assignment.agentId, support.id);
      assert.equal(reply.source, 'thread_owner');
    }
  } finally {
    store.close();
  }
});

test('in a DM with Chickpea a mentioned people group is part of the request, with no directory lookup', async () => {
  const { store } = await fixture();
  try {
    const chickpea = await activateChickpea(store);
    let lookups = 0;
    const result = await resolveAgentRoute({
      turn: turn({
        channelId: 'D1', source: 'dm_message', channelType: 'im', contextMode: 'dm_history',
        text: 'create me a <!subteam^SOLDSUPPORT|@support> agent that ill connect to zendesk',
      }),
      surface: 'direct', actor: { channelMember: false, fullMember: true }, config: store,
      authorizeUserAgent: allowUserAgent,
      transport: {
        lookupUserGroup: async () => {
          lookups += 1;
          return undefined;
        },
      },
    });
    assert.equal(result.kind, 'routed');
    if (result.kind === 'routed') {
      assert.equal(result.assignment.agentId, chickpea.id);
      assert.equal(result.source, 'default_agent');
    }
    assert.equal(lookups, 0);
  } finally {
    store.close();
  }
});

test('a mentioned Agent with no grant in this Channel is named so it can be added', async () => {
  const { store, support, finance } = await fixture();
  try {
    const actor = { channelMember: true, fullMember: true };
    await resolveAgentRoute({ turn: turn(), surface: 'channel', actor, config: store });
    await store.deleteAgentChannelGrant('T1', 'C1', finance.id);
    const result = await resolveAgentRoute({
      turn: turn({
        eventId: 'Ev2', messageTs: '100.2', text: '<!subteam^SFINANCE|@finance> take over',
        source: 'implicit_thread_reply', contextMode: 'thread',
      }),
      surface: 'channel', actor, config: store,
    });
    assert.equal(result.kind, 'not_in_channel');
    if (result.kind === 'not_in_channel') assert.equal(result.agent.id, finance.id);
    assert.equal((await store.getAgentThreadRoute('T1', 'C1', '100.1'))?.agentId, support.id);

    // Someone outside the Channel is still refused.
    const outsider = await resolveAgentRoute({
      turn: turn({ messageTs: '300.1', threadTs: '300.1', text: '<!subteam^SFINANCE|@finance> hi' }),
      surface: 'channel', actor: { channelMember: false, fullMember: true }, config: store,
    });
    assert.equal(outsider.kind, 'denied');
  } finally {
    store.close();
  }
});
