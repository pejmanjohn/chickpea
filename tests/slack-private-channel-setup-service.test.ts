import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import {
  PrivateChannelSetupError,
  PrivateChannelSetupService,
} from '../src/slack/private-channel-setup-service.ts';
import type {
  SlackChannel,
  SlackMessageReference,
  SlackTransport,
  SlackUserGroup,
} from '../src/slack/transport/types.ts';

const WORKSPACE = 'T_PRIVATE';
const CHANNEL = 'C_PRIVATE';
const INVITER = 'U_INVITER';
const NOW = 1_800_000_000_000;

const principal: AuthPrincipal = {
  userId: 'user_inviter',
  membershipId: 'membership_inviter',
  organizationId: 'org_private',
  role: 'member',
  authenticatorKind: 'slack_event',
  credentialId: 'slack:T_PRIVATE:U_INVITER',
  correlationId: 'slack-event:T_PRIVATE:U_INVITER',
  machine: false,
};

function agent(
  id: string,
  name: string,
  options: Partial<CustomAgentConfig> = {},
): CustomAgentConfig {
  const handle = name.toLowerCase().replaceAll(' ', '-');
  return {
    id,
    kind: 'user',
    revision: 1,
    name,
    instructions: 'Help.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: principal.membershipId,
    editPolicy: 'creator_and_admins',
    slackPresence: {
      requestedHandle: handle,
      normalizedHandle: handle,
      desiredState: 'unpublished',
      health: 'unpublished',
      avatar: { kind: 'generated', revision: 1, seed: id },
    },
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...options,
  };
}

class FakePrivateSlackTransport implements SlackTransport {
  readonly mode = 'direct';
  channel: SlackChannel = {
    id: CHANNEL,
    name: 'private-lab',
    private: true,
    member: true,
    archived: false,
  };
  actorIsMember = true;
  createCalls = 0;
  createError: Error | undefined;
  groups: SlackUserGroup[] = [];

  async lookupMember(): Promise<never> { throw new Error('unused'); }
  async lookupChannel(_channelId: string) { return { ...this.channel }; }
  async listChannels() { return { channels: [{ ...this.channel }], truncated: false }; }
  async listMemberChannels() { return new Set(this.actorIsMember ? [CHANNEL] : []); }
  async channelHasMember() { return this.actorIsMember; }
  async openDirectConversation(): Promise<never> { throw new Error('unused'); }
  async joinPublicChannel(): Promise<never> { throw new Error('unused'); }
  async lookupUserGroup(id: string) {
    return this.groups.find((group) => group.id === id);
  }
  async listUserGroups() { return this.groups.map((group) => ({ ...group })); }
  async createUserGroup(input: { name: string; handle: string; description?: string }) {
    this.createCalls += 1;
    if (this.createError) throw this.createError;
    const group: SlackUserGroup = {
      id: 'S' + this.createCalls,
      name: input.name,
      handle: input.handle,
      disabled: false,
      ...(input.description ? { description: input.description } : {}),
    };
    this.groups.push(group);
    return { ...group };
  }
  async updateUserGroup(id: string, patch: Partial<SlackUserGroup>) {
    const group = this.groups.find((candidate) => candidate.id === id)!;
    Object.assign(group, patch);
    return { ...group };
  }
  async disableUserGroup(id: string) {
    const group = this.groups.find((candidate) => candidate.id === id)!;
    group.disabled = true;
    return { ...group };
  }
  async enableUserGroup(id: string) {
    const group = this.groups.find((candidate) => candidate.id === id)!;
    group.disabled = false;
    return { ...group };
  }
  async publishAppHome(): Promise<never> { throw new Error('unused'); }
  async postMessage(): Promise<SlackMessageReference> { throw new Error('unused'); }
}

async function fixture(options: {
  agents?: CustomAgentConfig[];
  publisher?: (
    reconciler: AgentPresenceReconciler,
    input: { actor: AuthPrincipal; workspaceId: string; channelId: string; agentId: string },
  ) => ReturnType<AgentPresenceReconciler['publish']>;
} = {}) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const transport = new FakePrivateSlackTransport();
  let now = NOW;
  let fullMember = true;
  let channelMember = true;
  let setupSequence = 0;
  const phases: string[] = [];
  for (const candidate of options.agents ?? [agent('agent_draft', 'Draft Agent', {
    enabled: false,
    lifecycle: 'draft',
  })]) await config.createAgent(candidate);
  await config.ensureWorkspaceInstallation({
    workspaceId: WORKSPACE,
    transportMode: 'direct',
    teamId: WORKSPACE,
    appId: 'A_PRIVATE',
    botUserId: 'U_BOT',
    defaultAgentId: 'agent_chickpea',
  });
  const reconciler = new AgentPresenceReconciler({ config, transport, now: () => now });
  const service = new PrivateChannelSetupService({
    config,
    management,
    resolveActor: async () => ({
      principal,
      routing: { fullMember, channelMember },
    }),
    lookupChannel: async (_workspaceId, channelId) => {
      assert.equal(channelId, CHANNEL);
      return transport.lookupChannel(channelId);
    },
    prepareGeneratedAvatar: async ({ agent: current }) => {
      phases.push('avatar');
      return current;
    },
    publishAgentChannel: async (input) => {
      phases.push('publish');
      const publish = options.publisher ?? ((live, request) => live.publish({
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        agentId: request.agentId,
        actorMembershipId: request.actor.membershipId,
        actorSlackUserId: INVITER,
      }));
      return publish(reconciler, input);
    },
    now: () => now,
    randomId: () => 'setup_private_' + (++setupSequence),
    claimObservationMs: 10,
  });
  return {
    config,
    management,
    transport,
    service,
    phases,
    setNow(value: number) { now = value; },
    setAuthority(value: { fullMember?: boolean; channelMember?: boolean }) {
      if (value.fullMember !== undefined) fullMember = value.fullMember;
      if (value.channelMember !== undefined) channelMember = value.channelMember;
    },
    close() { config.close(); management.close(); },
  };
}

const beginInput = {
  workspaceId: WORKSPACE,
  channelId: CHANNEL,
  inviterSlackUserId: INVITER,
};

test('setup lists editable draft Agents without mutating and Add publishes exactly once', async () => {
  const f = await fixture({
    agents: [
      agent('agent_draft', 'Draft Agent', { enabled: false, lifecycle: 'draft' }),
      agent('agent_disabled', 'Disabled Agent', { enabled: false, lifecycle: 'active' }),
      agent('agent_archived', 'Archived Agent', { lifecycle: 'archived' }),
      agent('agent_other', 'Other Agent', { creatorMembershipId: 'membership_other' }),
    ],
  });
  try {
    const begun = await f.service.begin(beginInput);
    assert.deepEqual(begun.agents.map(({ agentId }) => agentId), ['agent_draft']);
    assert.equal((await f.config.listAgentChannelGrants(WORKSPACE, CHANNEL)).length, 0);
    assert.equal(await f.config.getChannel(WORKSPACE, CHANNEL), undefined);

    const added = await f.service.add({ ...beginInput, setupId: begun.setupId, agentId: 'agent_draft' });
    assert.deepEqual(added, {
      kind: 'completed', agentId: 'agent_draft', handle: 'draft-agent', replayed: false,
    });
    assert.deepEqual(f.phases, ['avatar', 'publish']);
    assert.equal((await f.config.listAgentChannelGrants(WORKSPACE, CHANNEL))[0]?.status, 'active');
    const published = await f.config.getAgent('agent_draft');
    await f.config.updateAgent('agent_draft', {
      slackPresence: {
        ...published.slackPresence!,
        requestedHandle: 'draft-renamed',
        normalizedHandle: 'draft-renamed',
      },
    }, published.revision);
    assert.deepEqual(await f.service.add({
      ...beginInput, setupId: begun.setupId, agentId: 'agent_draft',
    }), {
      kind: 'completed', agentId: 'agent_draft', handle: 'draft-renamed', replayed: true,
    });
    assert.equal(f.transport.createCalls, 1);
    const consumed = await f.management.getPrivateChannelSetupIntent(begun.setupId);
    assert.equal(consumed?.status, 'completed');
    assert.deepEqual(consumed?.result, { agentId: 'agent_draft', handle: 'draft-agent' });
    await f.config.deleteAgentChannelGrant(WORKSPACE, CHANNEL, 'agent_draft');
    assert.deepEqual(await f.service.add({
      ...beginInput, setupId: begun.setupId, agentId: 'agent_draft',
    }), { kind: 'no_longer_added' });
    assert.equal((await f.management.getPrivateChannelSetupIntent(begun.setupId))?.status,
      'completed');
    assert.equal(f.transport.createCalls, 1);
  } finally {
    f.close();
  }
});

test('setup rechecks full membership, Channel membership, binding, expiry, and revisions', async () => {
  const f = await fixture({
    agents: [agent('agent_a', 'Agent A'), agent('agent_b', 'Agent B')],
  });
  try {
    f.setAuthority({ fullMember: false });
    await assert.rejects(
      () => f.service.begin(beginInput),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'forbidden',
    );
    f.setAuthority({ fullMember: true });
    const begun = await f.service.begin(beginInput);
    f.setAuthority({ channelMember: false });
    await assert.rejects(
      () => f.service.add({ ...beginInput, setupId: begun.setupId, agentId: 'agent_a' }),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'forbidden',
    );
    f.setAuthority({ channelMember: true });
    await assert.rejects(
      () => f.service.add({
        ...beginInput, inviterSlackUserId: 'U_OTHER', setupId: begun.setupId, agentId: 'agent_a',
      }),
      PrivateChannelSetupError,
    );
    const unrelated = await f.config.getAgent('agent_b');
    await f.config.updateAgent('agent_b', { description: 'unrelated change' }, unrelated.revision);
    assert.equal((await f.service.add({
      ...beginInput, setupId: begun.setupId, agentId: 'agent_a',
    })).kind, 'completed');

    const stale = await f.service.begin(beginInput);
    const selected = await f.config.getAgent('agent_b');
    await f.config.updateAgent('agent_b', { description: 'selected changed' }, selected.revision);
    await assert.rejects(
      () => f.service.add({ ...beginInput, setupId: stale.setupId, agentId: 'agent_b' }),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'stale',
    );

    const expiring = await f.service.begin(beginInput);
    f.setNow(expiring.expiresAt);
    await assert.rejects(
      () => f.service.add({ ...beginInput, setupId: expiring.setupId, agentId: 'agent_b' }),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'expired',
    );
  } finally {
    f.close();
  }
});

test('completed replay distinguishes authority and transient readback failures without mutation', async () => {
  const f = await fixture({ agents: [agent('agent_a', 'Agent A')] });
  try {
    const begun = await f.service.begin(beginInput);
    assert.equal((await f.service.add({
      ...beginInput, setupId: begun.setupId, agentId: 'agent_a',
    })).kind, 'completed');
    const before = await f.management.getPrivateChannelSetupIntent(begun.setupId);
    let authorityCalls = 0;
    const authorityReplay = new PrivateChannelSetupService({
      config: f.config,
      management: f.management,
      resolveActor: async () => authorityCalls++ === 0
        ? { principal, routing: { fullMember: true, channelMember: true } }
        : { routing: { fullMember: false, channelMember: false } },
      lookupChannel: (_workspaceId, channelId) => f.transport.lookupChannel(channelId),
      prepareGeneratedAvatar: async () => { throw new Error('must not prepare'); },
      publishAgentChannel: async () => { throw new Error('must not publish'); },
      now: () => NOW,
    });
    await assert.rejects(
      () => authorityReplay.add({
        ...beginInput, setupId: begun.setupId, agentId: 'agent_a',
      }),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'forbidden',
    );

    let lookupCalls = 0;
    const transientReplay = new PrivateChannelSetupService({
      config: f.config,
      management: f.management,
      resolveActor: async () => ({
        principal,
        routing: { fullMember: true, channelMember: true },
      }),
      lookupChannel: async (_workspaceId, channelId) => {
        lookupCalls += 1;
        if (lookupCalls === 2) throw new Error('Slack unavailable');
        return f.transport.lookupChannel(channelId);
      },
      prepareGeneratedAvatar: async () => { throw new Error('must not prepare'); },
      publishAgentChannel: async () => { throw new Error('must not publish'); },
      now: () => NOW,
    });
    await assert.rejects(
      () => transientReplay.add({
        ...beginInput, setupId: begun.setupId, agentId: 'agent_a',
      }),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'unverifiable',
    );
    assert.deepEqual(await f.management.getPrivateChannelSetupIntent(begun.setupId), before);
    assert.equal(f.transport.createCalls, 1);
  } finally {
    f.close();
  }
});

test('parallel different choices consume one card for one Agent', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let publications = 0;
  const f = await fixture({
    agents: [agent('agent_a', 'Agent A'), agent('agent_b', 'Agent B')],
    publisher: async (reconciler, input) => {
      publications += 1;
      await held;
      return reconciler.publish({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentId: input.agentId,
        actorMembershipId: input.actor.membershipId,
        actorSlackUserId: INVITER,
      });
    },
  });
  try {
    const begun = await f.service.begin(beginInput);
    const first = f.service.add({ ...beginInput, setupId: begun.setupId, agentId: 'agent_a' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.service.add({
      ...beginInput, setupId: begun.setupId, agentId: 'agent_a',
    })).kind, 'in_progress');
    const second = f.service.add({ ...beginInput, setupId: begun.setupId, agentId: 'agent_b' });
    await assert.rejects(second, PrivateChannelSetupError);
    release();
    assert.equal((await first).kind, 'completed');
    assert.equal(publications, 1);
  } finally {
    release();
    f.close();
  }
});

test('Add denies lost Agent edit authority and setup requires current bot membership', async () => {
  const f = await fixture({ agents: [agent('agent_a', 'Agent A')] });
  try {
    const begun = await f.service.begin(beginInput);
    const selected = await f.config.getAgent('agent_a');
    await f.config.updateAgent(
      selected.id,
      { creatorMembershipId: 'membership_other' },
      selected.revision,
    );
    await assert.rejects(
      () => f.service.add({ ...beginInput, setupId: begun.setupId, agentId: selected.id }),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'forbidden',
    );
    f.transport.channel.member = false;
    await assert.rejects(
      () => f.service.begin(beginInput),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'unavailable',
    );
  } finally {
    f.close();
  }
});

test('installation identity revision changes invalidate an open setup before mutation', async () => {
  const f = await fixture({ agents: [agent('agent_a', 'Agent A')] });
  try {
    const begun = await f.service.begin(beginInput);
    const installation = (await f.config.getWorkspaceInstallation(WORKSPACE))!;
    await f.config.updateWorkspaceInstallation(
      WORKSPACE,
      { health: 'needs_attention' },
      installation.revision,
    );
    await assert.rejects(
      () => f.service.add({ ...beginInput, setupId: begun.setupId, agentId: 'agent_a' }),
      (error: unknown) => error instanceof PrivateChannelSetupError && error.code === 'stale',
    );
    assert.equal(f.phases.length, 0);
  } finally {
    f.close();
  }
});

test('publication failure is recoverable and never republishes a consumed card', async () => {
  let publications = 0;
  const f = await fixture({
    agents: [agent('agent_a', 'Agent A')],
    publisher: async () => {
      publications += 1;
      throw new Error('publication failed');
    },
  });
  try {
    const begun = await f.service.begin(beginInput);
    assert.equal((await f.service.add({
      ...beginInput, setupId: begun.setupId, agentId: 'agent_a',
    })).kind, 'recovery_required');
    assert.equal((await f.service.add({
      ...beginInput, setupId: begun.setupId, agentId: 'agent_a',
    })).kind, 'recovery_required');
    assert.equal(publications, 1);
  } finally {
    f.close();
  }
});

test('an exception after publication is settled from exact active grant and presence', async () => {
  const f = await fixture({
    agents: [agent('agent_a', 'Agent A')],
    publisher: async (reconciler, input) => {
      await reconciler.publish({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentId: input.agentId,
        actorMembershipId: input.actor.membershipId,
        actorSlackUserId: INVITER,
      });
      throw new Error('callback response lost');
    },
  });
  try {
    const begun = await f.service.begin(beginInput);
    assert.deepEqual(await f.service.add({
      ...beginInput, setupId: begun.setupId, agentId: 'agent_a',
    }), {
      kind: 'completed', agentId: 'agent_a', handle: 'agent-a', replayed: false,
    });
    assert.equal((await f.management.getPrivateChannelSetupIntent(begun.setupId))?.status, 'completed');
  } finally {
    f.close();
  }
});
