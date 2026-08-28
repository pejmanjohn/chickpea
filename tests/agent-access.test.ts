import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentChannelGrant, CustomAgentConfig } from '../src/config/types.ts';
import {
  listPrivatelyUsableAgents,
  resolvePrivateAgentAccess,
  resolvePrivateAgentAudience,
} from '../src/slack/agent-access.ts';
import {
  SlackTransportError,
  type SlackChannel,
  type SlackTransport,
} from '../src/slack/transport/types.ts';

function agent(
  id: string,
  patch: Partial<CustomAgentConfig> = {},
): CustomAgentConfig {
  return {
    id,
    kind: 'user',
    revision: 1,
    name: id,
    instructions: '',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: `creator_${id}`,
    editPolicy: 'creator_and_admins',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...patch,
  };
}

function grant(
  agentId: string,
  channelId: string,
  patch: Partial<AgentChannelGrant> = {},
): AgentChannelGrant {
  return {
    workspaceId: 'T1',
    channelId,
    agentId,
    revision: 1,
    status: 'active',
    createdByMembershipId: 'creator',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function channel(
  id: string,
  patch: Partial<SlackChannel> = {},
): SlackChannel {
  return {
    id,
    name: id.toLowerCase(),
    private: false,
    member: true,
    archived: false,
    ...patch,
  };
}

function transport(input: {
  channels?: Record<string, SlackChannel | Error | undefined>;
  memberChannels?: ReadonlySet<string> | Error;
  directory?: { channels: SlackChannel[]; truncated: boolean } | Error;
  calls?: string[];
} = {}): Pick<SlackTransport, 'lookupChannel' | 'listChannels' | 'listMemberChannels'> {
  return {
    async lookupChannel(channelId) {
      input.calls?.push(`lookup:${channelId}`);
      const result = input.channels?.[channelId];
      if (result instanceof Error) throw result;
      if (!result) throw new Error('channel unavailable');
      return result;
    },
    async listChannels() {
      input.calls?.push('directory');
      if (input.directory instanceof Error) throw input.directory;
      return input.directory ?? { channels: [], truncated: false };
    },
    async listMemberChannels() {
      input.calls?.push('member-channels');
      if (input.memberChannels instanceof Error) throw input.memberChannels;
      return input.memberChannels ?? new Set<string>();
    },
  };
}

const fullMember = {
  fullMember: true,
  membershipId: 'member_1',
  slackUserId: 'U1',
};

test('a verified public placement allows any full workspace member', async () => {
  const selected = agent('public');
  const result = await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants: [grant(selected.id, 'C_PUBLIC')],
    actor: fullMember,
    transport: transport({ channels: { C_PUBLIC: channel('C_PUBLIC') } }),
  });

  assert.deepEqual(result, { status: 'allowed', audience: 'workspace_members' });
});

test('private-only access is the union of current placed-Channel membership', async () => {
  const selected = agent('private');
  const grants = [grant(selected.id, 'C_ONE'), grant(selected.id, 'C_TWO')];
  const slack = transport({
    channels: {
      C_ONE: channel('C_ONE', { private: true }),
      C_TWO: channel('C_TWO', { private: true }),
    },
    memberChannels: new Set(['C_TWO']),
  });

  assert.deepEqual(await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants,
    actor: fullMember,
    transport: slack,
  }), { status: 'allowed', audience: 'private_channel_members' });

  assert.deepEqual(await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants,
    actor: { ...fullMember, slackUserId: 'U2' },
    transport: transport({
      channels: {
        C_ONE: channel('C_ONE', { private: true }),
        C_TWO: channel('C_TWO', { private: true }),
      },
      memberChannels: new Set(),
    }),
  }), { status: 'denied', audience: 'private_channel_members' });
});

test('exact no-placement access is creator-only and does not include an admin', async () => {
  const selected = agent('unplaced', { creatorMembershipId: 'creator' });
  const slack = transport();

  assert.deepEqual(await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants: [],
    actor: { ...fullMember, membershipId: 'creator' },
    transport: slack,
  }), { status: 'allowed', audience: 'creator_only' });

  assert.deepEqual(await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants: [],
    actor: { ...fullMember, membershipId: 'admin' },
    transport: slack,
  }), { status: 'denied', audience: 'creator_only' });
});

test('a creator outside every placed private Channel is denied', async () => {
  const selected = agent('private', { creatorMembershipId: 'creator' });
  assert.deepEqual(await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants: [grant(selected.id, 'C_PRIVATE')],
    actor: { ...fullMember, membershipId: 'creator' },
    transport: transport({
      channels: { C_PRIVATE: channel('C_PRIVATE', { private: true }) },
      memberChannels: new Set(),
    }),
  }), { status: 'denied', audience: 'private_channel_members' });
});

test('unknown or unusable active placements fail closed without creator fallback', async () => {
  const selected = agent('uncertain', { creatorMembershipId: 'creator' });
  for (const fact of [
    undefined,
    channel('C1', { archived: true }),
    channel('C1', { member: false }),
  ]) {
    assert.deepEqual(await resolvePrivateAgentAccess({
      agent: selected,
      workspaceId: 'T1',
      grants: [grant(selected.id, 'C1')],
      actor: { ...fullMember, membershipId: 'creator' },
      transport: transport({ channels: { C1: fact } }),
    }), { status: 'unavailable', audience: 'unavailable' });
  }
});

test('a verified public placement still grants access when another placement is unknown', async () => {
  const selected = agent('mixed');
  const calls: string[] = [];
  assert.deepEqual(await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants: [grant(selected.id, 'C_PUBLIC'), grant(selected.id, 'C_UNKNOWN')],
    actor: fullMember,
    transport: transport({
      calls,
      channels: { C_PUBLIC: channel('C_PUBLIC'), C_UNKNOWN: undefined },
      memberChannels: new Error('must not be needed for public access'),
    }),
  }), { status: 'allowed', audience: 'workspace_members' });
  assert.deepEqual(calls.sort(), ['lookup:C_PUBLIC', 'lookup:C_UNKNOWN']);
});

test('an unknown active placement keeps private-only access unavailable', async () => {
  const selected = agent('mixed-private-unknown');
  assert.deepEqual(await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants: [
      grant(selected.id, 'C_PRIVATE'),
      grant(selected.id, 'C_UNKNOWN'),
    ],
    actor: fullMember,
    transport: transport({
      channels: {
        C_PRIVATE: channel('C_PRIVATE', { private: true }),
        C_UNKNOWN: new Error('Slack unavailable'),
      },
      memberChannels: new Set(['C_PRIVATE']),
    }),
  }), { status: 'unavailable', audience: 'unavailable' });
});

test('private membership uncertainty is unavailable, while audience projection stays categorical', async () => {
  const selected = agent('private');
  const grants = [grant(selected.id, 'C_PRIVATE')];
  const channels = { C_PRIVATE: channel('C_PRIVATE', { private: true }) };

  assert.deepEqual(await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants,
    actor: fullMember,
    transport: transport({ channels, memberChannels: new Error('unavailable') }),
  }), { status: 'unavailable', audience: 'unavailable' });

  assert.equal(await resolvePrivateAgentAudience({
    agent: selected,
    workspaceId: 'T1',
    grants,
    transport: transport({ channels }),
  }), 'private_channel_members');
});

test('directory access filters workspace, grant, and Agent lifecycle state', async () => {
  const active = agent('active');
  const disabled = agent('disabled', { enabled: false });
  const draft = agent('draft', { lifecycle: 'draft' });
  const calls: string[] = [];
  const visible = await listPrivatelyUsableAgents({
    agents: [disabled, active, draft],
    workspaceId: 'T1',
    grants: [
      grant(active.id, 'C_PUBLIC'),
      grant(active.id, 'C_OTHER', { workspaceId: 'T2' }),
      grant(disabled.id, 'C_DISABLED'),
      grant(draft.id, 'C_DRAFT'),
      grant(active.id, 'C_PENDING', { status: 'pending' }),
    ],
    actor: fullMember,
    transport: transport({ calls, channels: { C_PUBLIC: channel('C_PUBLIC') } }),
  });

  assert.deepEqual(visible.map(({ id }) => id), [active.id]);
  assert.deepEqual(calls, ['lookup:C_PUBLIC']);
  assert.equal(await resolvePrivateAgentAudience({
    agent: disabled,
    workspaceId: 'T1',
    grants: [],
    transport: transport(),
  }), 'unavailable');
});

test('directory fact collection deduplicates Channel lookups and member traversal', async () => {
  const alpha = agent('alpha');
  const beta = agent('beta');
  const calls: string[] = [];
  const visible = await listPrivatelyUsableAgents({
    agents: [beta, alpha],
    workspaceId: 'T1',
    grants: [grant(alpha.id, 'C_SHARED'), grant(beta.id, 'C_SHARED')],
    actor: fullMember,
    transport: transport({
      calls,
      channels: { C_SHARED: channel('C_SHARED', { private: true }) },
      memberChannels: new Set(['C_SHARED']),
    }),
  });

  assert.deepEqual(visible.map(({ id }) => id), [alpha.id, beta.id]);
  assert.deepEqual(calls, ['lookup:C_SHARED', 'member-channels']);
});

test('large directories use one bounded traversal and target only unresolved grants', async () => {
  const agents = Array.from({ length: 8 }, (_, index) => agent(`agent_${index}`));
  const grants = agents.map((item, index) => grant(item.id, `C${index}`));
  const calls: string[] = [];
  const directoryChannels = grants.slice(0, 7).map(({ channelId }) => channel(channelId));
  const visible = await listPrivatelyUsableAgents({
    agents,
    workspaceId: 'T1',
    grants,
    actor: fullMember,
    transport: transport({
      calls,
      directory: { channels: directoryChannels, truncated: true },
      channels: { C7: channel('C7') },
    }),
  });

  assert.equal(visible.length, 8);
  assert.deepEqual(calls, ['directory', 'lookup:C7']);
});

test('Slack fact failures emit sanitized unavailable diagnostics', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => {
    warnings.push(values.map(String).join(' '));
  });
  const selected = agent('private');
  const grants = [grant(selected.id, 'C_PRIVATE')];

  await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants,
    actor: fullMember,
    transport: transport({
      channels: {
        C_PRIVATE: new SlackTransportError('conversations.info', 'ratelimited'),
      },
    }),
  });
  await resolvePrivateAgentAccess({
    agent: selected,
    workspaceId: 'T1',
    grants,
    actor: fullMember,
    transport: transport({
      channels: { C_PRIVATE: channel('C_PRIVATE', { private: true }) },
      memberChannels: new SlackTransportError('users.conversations', 'service_unavailable'),
    }),
  });
  const directoryAgents = Array.from({ length: 8 }, (_, index) => agent(`directory_${index}`));
  const directoryGrants = directoryAgents.map((item, index) => grant(item.id, `C${index}`));
  await listPrivatelyUsableAgents({
    agents: directoryAgents,
    workspaceId: 'T1',
    grants: directoryGrants,
    actor: fullMember,
    transport: transport({
      directory: new SlackTransportError('conversations.list', 'request_timeout'),
      channels: Object.fromEntries(directoryGrants.map(({ channelId }) => [
        channelId,
        channel(channelId),
      ])),
    }),
  });

  assert.match(warnings.join('\n'), /placement facts unavailable \(conversations\.info:ratelimited\)/);
  assert.match(
    warnings.join('\n'),
    /member-channels facts unavailable \(users\.conversations:service_unavailable\)/,
  );
  assert.match(
    warnings.join('\n'),
    /directory facts unavailable \(conversations\.list:request_timeout\)/,
  );
  assert.doesNotMatch(warnings.join('\n'), /C_PRIVATE|U1|member_1/);
});
