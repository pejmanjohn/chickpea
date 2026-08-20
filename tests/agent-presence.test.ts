import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  agentAvatarUrl,
  generatedAgentAvatarSvg,
  readAgentAvatarAsset,
  uploadAgentAvatar,
} from '../src/slack/agent-presence/avatar-assets.ts';
import {
  AgentPresenceError,
  agentPresenceRecovery,
} from '../src/slack/agent-presence/errors.ts';
import {
  alternativeAgentHandles,
  normalizeAgentHandle,
} from '../src/slack/agent-presence/handles.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import {
  SlackTransportError,
  type SlackTransport,
  type SlackUserGroup,
} from '../src/slack/transport/types.ts';

const NOW = 1_800_000_000_000;

test('Agent handles normalize predictably and suggest collision-free alternatives', () => {
  assert.equal(normalizeAgentHandle('  Support & Success!  '), 'support-success');
  assert.equal(normalizeAgentHandle('!!!'), 'agent');
  assert.deepEqual(
    alternativeAgentHandles('support', new Set(['support', 'support-2', 'support-4'])),
    ['support-3', 'support-5', 'support-6'],
  );
});

test('publishing verifies actor membership, joins a public Channel, and creates one alias', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const transport = new FakeSlackTransport();
  try {
    await config.createAgent(agent('agent_support', 'Support Triage', 'support'));
    const result = await new AgentPresenceReconciler({ config, transport, now: () => NOW }).publish({
      workspaceId: 'TACME',
      agentId: 'agent_support',
      channelId: 'C_SUPPORT',
      actorMembershipId: 'membership_ada',
      actorSlackUserId: 'UADA',
    });

    assert.equal(transport.joinCalls, 1);
    assert.equal(transport.createCalls, 1);
    assert.equal(result.grant.status, 'active');
    assert.equal(result.grant.createdByMembershipId, 'membership_ada');
    assert.equal(result.agent.slackPresence?.health, 'healthy');
    assert.equal(result.agent.slackPresence?.userGroupId, 'S1');
    assert.equal(result.agent.slackPresence?.observedAt, NOW);
  } finally {
    config.close();
  }
});

test('publication fails closed when the actor is not a member or Chickpea needs a private invite', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const notMember = new FakeSlackTransport();
    notMember.actorIsMember = false;
    await assert.rejects(
      () => new AgentPresenceReconciler({ config, transport: notMember }).publish({
        workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_PRIVATE',
        actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
      }),
      (error: unknown) => error instanceof AgentPresenceError &&
        error.code === 'channel_membership_required',
    );
    assert.equal((await config.listAgentChannelGrants()).length, 0);

    const privateChannel = new FakeSlackTransport();
    privateChannel.channel.private = true;
    privateChannel.channel.member = false;
    await assert.rejects(
      () => new AgentPresenceReconciler({ config, transport: privateChannel }).publish({
        workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_PRIVATE',
        actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
      }),
      (error: unknown) => error instanceof AgentPresenceError &&
        error.code === 'private_channel_invite_required',
    );
    assert.equal((await config.listAgentChannelGrants())[0]?.status, 'pending');
    assert.equal((await config.getAgent('agent_support')).slackPresence?.health, 'needs_attention');
  } finally {
    config.close();
  }
});

test('Slack policy denial saves needs-attention state with the exact role recovery path', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const transport = new FakeSlackTransport();
  transport.createError = new SlackTransportError('usergroups.create', 'permission_denied');
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    await assert.rejects(
      () => new AgentPresenceReconciler({ config, transport }).publish({
        workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
        actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
      }),
      (error: unknown) => error instanceof AgentPresenceError &&
        error.code === 'user_group_policy_denied',
    );
    const saved = await config.getAgent('agent_support');
    assert.equal(saved.lifecycle, 'needs_attention');
    assert.equal(saved.slackPresence?.errorCode, 'user_group_policy_denied');
    const recovery = agentPresenceRecovery(
      new AgentPresenceError('user_group_policy_denied', 'denied'),
      'support',
    );
    assert.match(recovery.explanation, /Reconnecting Slack will not change/);
    assert.deepEqual(recovery.steps, [
      'Ask a Slack Workspace Owner or Admin to open Roles & permissions → Account types at slack.com/admin.',
      'Next to “Create and edit user groups,” choose … → Edit permission.',
      'Add Members, then Save.',
      'Come back here and select Retry.',
    ]);
  } finally {
    config.close();
  }
});

test('retry adopts an exact group after an ambiguous create and never creates a duplicate', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const transport = new FakeSlackTransport();
  transport.ambiguousCreate = true;
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const reconciler = new AgentPresenceReconciler({ config, transport, now: () => NOW });
    await assert.rejects(
      () => reconciler.publish({
        workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
        actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
      }),
      (error: unknown) => error instanceof AgentPresenceError &&
        error.code === 'user_group_create_ambiguous',
    );
    assert.equal(transport.groups.length, 1);
    assert.equal((await config.getAgent('agent_support')).slackPresence?.errorCode,
      'user_group_create_ambiguous');

    transport.ambiguousCreate = false;
    const recovered = await reconciler.reconcile('agent_support');
    assert.equal(recovered.slackPresence?.userGroupId, 'S1');
    assert.equal(recovered.slackPresence?.health, 'healthy');
    assert.equal(transport.createCalls, 1);
    assert.equal(transport.groups.length, 1);
  } finally {
    config.close();
  }
});

test('archive disables the alias and removes grants; restore enables the same alias', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const transport = new FakeSlackTransport();
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const reconciler = new AgentPresenceReconciler({ config, transport });
    await reconciler.publish({
      workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
      actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
    });
    const archived = await reconciler.archive('agent_support');
    assert.equal(archived.lifecycle, 'archived');
    assert.equal(archived.slackPresence?.desiredState, 'disabled');
    assert.equal(transport.groups[0]?.disabled, true);
    assert.deepEqual(await config.listAgentChannelGrants(), []);

    const restored = await reconciler.restore('agent_support');
    assert.equal(restored.lifecycle, 'active');
    assert.equal(restored.slackPresence?.desiredState, 'active');
    assert.equal(transport.groups[0]?.disabled, false);
  } finally {
    config.close();
  }
});

test('uploaded avatars create immutable revisions while generated avatars vary by seed', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const firstUrl = agentAvatarUrl('https://chickpea.example', 'agent_support', 1);
    const updated = await uploadAgentAvatar({
      config, settings, agentId: 'agent_support', bytes: png,
      contentType: 'image/png', publicOrigin: 'https://chickpea.example',
    });
    assert.equal(updated.slackPresence?.avatar.revision, 2);
    assert.equal(updated.slackPresence?.avatar.url,
      'https://chickpea.example/assets/agents/agent_support/avatar/2');
    assert.equal(firstUrl, 'https://chickpea.example/assets/agents/agent_support/avatar/1');
    assert.deepEqual(
      (await readAgentAvatarAsset({ settings, agentId: 'agent_support', revision: 2 }))?.bytes,
      png,
    );
    assert.notEqual(generatedAgentAvatarSvg('agent-a'), generatedAgentAvatarSvg('agent-b'));
  } finally {
    config.close();
    settings.close?.();
  }
});

function agent(id: string, name: string, handle: string): CustomAgentConfig {
  return {
    id,
    revision: 1,
    name,
    instructions: `You are ${name}.`,
    enabled: true,
    lifecycle: 'active',
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
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
  };
}

class FakeSlackTransport implements SlackTransport {
  readonly mode = 'direct';
  actorIsMember = true;
  joinCalls = 0;
  createCalls = 0;
  createError: Error | undefined;
  ambiguousCreate = false;
  channel = { id: 'C_SUPPORT', name: 'support', private: false, member: false, archived: false };
  groups: SlackUserGroup[] = [];

  async lookupMember(): Promise<never> { throw new Error('unused'); }
  async lookupChannel() { return { ...this.channel }; }
  async channelHasMember() { return this.actorIsMember; }
  async openDirectConversation() {
    return { id: 'D_ACTOR', private: true, member: true, archived: false };
  }
  async joinPublicChannel() { this.joinCalls += 1; this.channel.member = true; return { ...this.channel }; }
  async listUserGroups() { return this.groups.map((group) => ({ ...group })); }
  async createUserGroup(input: { name: string; handle: string; description?: string }) {
    this.createCalls += 1;
    const group: SlackUserGroup = {
      id: `S${this.groups.length + 1}`,
      name: input.name,
      handle: input.handle,
      ...(input.description ? { description: input.description } : {}),
      disabled: false,
    };
    if (this.ambiguousCreate) {
      this.groups.push(group);
      throw new SlackTransportError('usergroups.create', 'slack_unreachable', { retryable: true });
    }
    if (this.createError) throw this.createError;
    this.groups.push(group);
    return { ...group };
  }
  async updateUserGroup(id: string, patch: Partial<SlackUserGroup>) {
    const group = this.requiredGroup(id);
    Object.assign(group, patch);
    return { ...group };
  }
  async disableUserGroup(id: string) {
    const group = this.requiredGroup(id); group.disabled = true; return { ...group };
  }
  async enableUserGroup(id: string) {
    const group = this.requiredGroup(id); group.disabled = false; return { ...group };
  }
  async publishAppHome(): Promise<never> { throw new Error('unused'); }
  async postMessage(): Promise<never> { throw new Error('unused'); }

  private requiredGroup(id: string): SlackUserGroup {
    const group = this.groups.find((candidate) => candidate.id === id);
    if (!group) throw new Error(`Unknown group ${id}`);
    return group;
  }
}
