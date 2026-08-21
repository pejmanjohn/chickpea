import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhotonImage } from '@cf-wasm/photon';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  agentAvatarUrl,
  generatedAgentAvatarPng,
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
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

test('retry never adopts a foreign same-handle group after an ambiguous create', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const transport = new FakeSlackTransport();
  transport.ambiguousCreate = true;
  transport.ambiguousCreatePersistsGroup = false;
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
    transport.groups.push({
      id: 'S_FOREIGN',
      name: 'Somebody else',
      handle: 'support',
      description: 'Not Chickpea\'s group',
      disabled: false,
      updatedAt: Math.floor(NOW / 1_000) + 1,
    });
    transport.ambiguousCreate = false;

    await assert.rejects(
      () => reconciler.reconcile('agent_support'),
      (error: unknown) => error instanceof AgentPresenceError &&
        error.code === 'user_group_create_ambiguous',
    );
    assert.equal((await config.getAgent('agent_support')).slackPresence?.userGroupId, undefined);
    assert.equal(transport.createCalls, 1);
  } finally {
    config.close();
  }
});

test('a handle edit racing Slack creation converges on one updated user group', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const transport = new FakeSlackTransport();
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    transport.onCreate = async () => {
      const current = await config.getAgent('agent_support');
      await config.updateAgent(current.id, {
        name: 'Support Pro',
        slackPresence: {
          ...current.slackPresence!,
          requestedHandle: 'support-pro',
          normalizedHandle: 'support-pro',
        },
      }, current.revision);
    };
    const reconciler = new AgentPresenceReconciler({ config, transport, now: () => NOW });
    const reconciled = await reconciler.reconcile('agent_support');

    assert.equal(reconciled.name, 'Support Pro');
    assert.equal(reconciled.slackPresence?.normalizedHandle, 'support-pro');
    assert.equal(reconciled.slackPresence?.userGroupId, 'S1');
    assert.equal(transport.groups.length, 1);
    assert.equal(transport.groups[0]?.handle, 'support-pro');
  } finally {
    config.close();
  }
});

test('archive disables the alias and removes grants; restore enables the same alias', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const png = pngWithTextMetadata();
    const firstUrl = agentAvatarUrl('https://chickpea.example', 'agent_support', 1);
    const updated = await uploadAgentAvatar({
      config, settings, agentId: 'agent_support', bytes: png,
      contentType: 'image/png', publicOrigin: 'https://chickpea.example',
    });
    assert.equal(updated.slackPresence?.avatar.revision, 2);
    assert.equal(updated.slackPresence?.avatar.url,
      'https://chickpea.example/assets/agents/agent_support/avatar/2');
    assert.equal(firstUrl, 'https://chickpea.example/assets/agents/agent_support/avatar/1');
    const stored = await readAgentAvatarAsset({
      settings, agentId: 'agent_support', revision: 2,
    });
    assert.equal(stored?.contentType, 'image/png');
    assert.notDeepEqual(stored?.bytes, png);
    assert.doesNotMatch(new TextDecoder().decode(stored?.bytes), /private-location/);
    const generatedA = await generatedAgentAvatarPng('agent-a');
    const generatedB = await generatedAgentAvatarPng('agent-b');
    assert.deepEqual(Array.from(generatedA.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.notDeepEqual(generatedA, generatedB);
    const directGenerated = await readAgentAvatarAsset({
      settings, agentId: 'agent_support', revision: 1,
    });
    assert.equal(directGenerated?.contentType, 'image/png');
    assert.deepEqual(Array.from(directGenerated?.bytes.slice(0, 8) ?? []),
      [137, 80, 78, 71, 13, 10, 26, 10]);
  } finally {
    config.close();
    settings.close?.();
  }
});

test('uploaded avatars can publish through shared gateway storage before saving their public URL', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const png = pngWithTextMetadata();
    const published: unknown[] = [];
    const updated = await uploadAgentAvatar({
      config, settings, agentId: 'agent_support', bytes: png,
      contentType: 'image/png', publicOrigin: 'https://self-hosted.example',
      publish: async (input) => {
        published.push(input);
        return 'https://gateway.chickpea.test/avatars/binding/agent_support/rev_2.png';
      },
    });
    assert.equal(published.length, 1);
    const publication = published[0] as {
      agentId: string;
      revision: number;
      contentType: string;
      bytes: Uint8Array;
    };
    assert.equal(publication.agentId, 'agent_support');
    assert.equal(publication.revision, 2);
    assert.equal(publication.contentType, 'image/png');
    assert.notDeepEqual(publication.bytes, png);
    assert.doesNotMatch(new TextDecoder().decode(publication.bytes), /private-location/);
    assert.equal(updated.slackPresence?.avatar.url,
      'https://gateway.chickpea.test/avatars/binding/agent_support/rev_2.png');
    assert.deepEqual(
      (await readAgentAvatarAsset({ settings, agentId: 'agent_support', revision: 2 }))?.bytes,
      publication.bytes,
    );
  } finally {
    config.close();
    settings.close?.();
  }
});

test('concurrent avatar uploads reserve distinct immutable URLs', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const results = await Promise.allSettled([
      uploadAgentAvatar({
        config, settings, agentId: 'agent_support', bytes: pngWithTextMetadata([24, 92, 61, 255]),
        contentType: 'image/png', publicOrigin: 'https://chickpea.example',
      }),
      uploadAgentAvatar({
        config, settings, agentId: 'agent_support', bytes: pngWithTextMetadata([180, 30, 90, 255]),
        contentType: 'image/png', publicOrigin: 'https://chickpea.example',
      }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
    const [revision2, revision3] = await Promise.all([
      readAgentAvatarAsset({ settings, agentId: 'agent_support', revision: 2 }),
      readAgentAvatarAsset({ settings, agentId: 'agent_support', revision: 3 }),
    ]);
    assert.ok(revision2);
    assert.ok(revision3);
    assert.notDeepEqual(revision2.bytes, revision3.bytes);
  } finally {
    config.close();
    settings.close?.();
  }
});

test('avatar upload rejects raster signatures that do not decode', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    await assert.rejects(
      () => uploadAgentAvatar({
        config,
        settings,
        agentId: 'agent_support',
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
        contentType: 'image/png',
        publicOrigin: 'https://chickpea.example',
      }),
      (error: unknown) => error instanceof Error && error.message === 'invalid_image',
    );
  } finally {
    config.close();
    settings.close?.();
  }
});

function pngWithTextMetadata(pixel = [24, 92, 61, 255]): Uint8Array {
  const image = new PhotonImage(Uint8Array.from(pixel), 1, 1);
  const png = Uint8Array.from(image.get_bytes());
  image.free();
  const marker = Uint8Array.from([0x49, 0x45, 0x4e, 0x44]);
  const iendType = findBytes(png, marker);
  assert.ok(iendType >= 4);
  const chunkStart = iendType - 4;
  const payload = new TextEncoder().encode('location\0private-location');
  const type = new TextEncoder().encode('tEXt');
  const chunk = new Uint8Array(12 + payload.length);
  new DataView(chunk.buffer).setUint32(0, payload.length);
  chunk.set(type, 4);
  chunk.set(payload, 8);
  new DataView(chunk.buffer).setUint32(8 + payload.length, crc32(concat(type, payload)));
  return concat(png.subarray(0, chunkStart), chunk, png.subarray(chunkStart));
}

function findBytes(value: Uint8Array, needle: Uint8Array): number {
  for (let offset = 0; offset <= value.length - needle.length; offset += 1) {
    if (needle.every((byte, index) => value[offset + index] === byte)) return offset;
  }
  return -1;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
  ambiguousCreatePersistsGroup = true;
  onCreate?: () => Promise<void>;
  channel = { id: 'C_SUPPORT', name: 'support', private: false, member: false, archived: false };
  groups: SlackUserGroup[] = [];

  async lookupMember(): Promise<never> { throw new Error('unused'); }
  async lookupChannel() { return { ...this.channel }; }
  async listChannels() { return { channels: [{ ...this.channel }], truncated: false }; }
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
      updatedAt: Math.floor(NOW / 1_000),
    };
    if (this.ambiguousCreate) {
      if (this.ambiguousCreatePersistsGroup) this.groups.push(group);
      throw new SlackTransportError('usergroups.create', 'slack_unreachable', { retryable: true });
    }
    if (this.createError) throw this.createError;
    this.groups.push(group);
    await this.onCreate?.();
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
