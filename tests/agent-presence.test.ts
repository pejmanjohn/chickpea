import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

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
  classifyAgentPresenceError,
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

test('Slack create-time handle collisions retain safe alternative suggestions', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const transport = new FakeSlackTransport();
  transport.createError = new SlackTransportError(
    'usergroups.create',
    'handle_already_exists',
  );
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    await assert.rejects(
      () => new AgentPresenceReconciler({ config, transport, now: () => NOW }).publish({
        workspaceId: 'TACME',
        agentId: 'agent_support',
        channelId: 'C_SUPPORT',
        actorMembershipId: 'membership_ada',
        actorSlackUserId: 'UADA',
      }),
      (error: unknown) => error instanceof AgentPresenceError &&
        error.code === 'handle_collision' && error.suggestions[0] === 'support-2',
    );
  } finally {
    config.close();
  }
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
    assert.deepEqual(await config.getChannel('TACME', 'C_SUPPORT'), {
      workspaceId: 'TACME',
      channelId: 'C_SUPPORT',
      revision: 1,
      label: 'support',
      lifecycle: 'active',
    });
  } finally {
    config.close();
  }
});

test('publishing activates a private Chickpea-created draft before enabling its Channel grant', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const transport = new FakeSlackTransport();
  try {
    await config.createAgent({
      ...agent('agent_support', 'Support Triage', 'support'),
      enabled: false,
      lifecycle: 'draft',
    });

    const result = await new AgentPresenceReconciler({ config, transport, now: () => NOW }).publish({
      workspaceId: 'TACME',
      agentId: 'agent_support',
      channelId: 'C_SUPPORT',
      actorMembershipId: 'membership_ada',
      actorSlackUserId: 'UADA',
    });

    assert.equal(result.agent.enabled, true);
    assert.equal(result.agent.lifecycle, 'active');
    assert.equal(result.grant.status, 'active');
    assert.equal(transport.createCalls, 1);
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

test('a failed republish never downgrades an existing active Channel grant', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const transport = new FakeSlackTransport();
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const reconciler = new AgentPresenceReconciler({ config, transport });
    await reconciler.publish({
      workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
      actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
    });
    transport.channel.private = true;
    transport.channel.member = false;
    await assert.rejects(
      reconciler.publish({
        workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
        actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
      }),
      (error: unknown) => error instanceof AgentPresenceError &&
        error.code === 'private_channel_invite_required',
    );
    assert.equal((await config.listAgentChannelGrants())[0]?.status, 'active');
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

test('revoked or displaced shared-app authority gives reconnect, not generic Retry advice', () => {
  for (const slackCode of ['binding_reconnect_required', 'binding_mismatch']) {
    const classified = classifyAgentPresenceError(
      new SlackTransportError('usergroups.update', slackCode),
    );
    assert.equal(classified.code, 'slack_reconnect_required');
    const recovery = agentPresenceRecovery(classified, 'support');
    assert.equal(recovery.actionLabel, 'Reconnect Slack');
    assert.equal(recovery.actionKind, 'reconnect');
    assert.match(recovery.explanation, /current Slack Owner or Admin/);
    assert.match(recovery.note ?? '', /encrypted Slack authorization/);
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

test('failed Slack restore stays retryable with an active desired state', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const transport = new FakeSlackTransport();
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const reconciler = new AgentPresenceReconciler({ config, transport });
    await reconciler.publish({
      workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
      actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
    });
    await reconciler.archive('agent_support');
    transport.enableError = new SlackTransportError(
      'usergroups.enable',
      'slack_unreachable',
      { retryable: true },
    );

    await assert.rejects(() => reconciler.restore('agent_support'), AgentPresenceError);
    const failed = await config.getAgent('agent_support');
    assert.equal(failed.lifecycle, 'needs_attention');
    assert.equal(failed.slackPresence?.desiredState, 'active');
    assert.equal(failed.slackPresence?.health, 'needs_attention');

    transport.enableError = undefined;
    const recovered = await reconciler.retry('agent_support');
    assert.equal(recovered.lifecycle, 'active');
    assert.equal(recovered.slackPresence?.desiredState, 'active');
    assert.equal(transport.groups[0]?.disabled, false);
  } finally {
    config.close();
  }
});

test('Retry never resurrects an archived Agent or its Slack user group', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const transport = new FakeSlackTransport();
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const reconciler = new AgentPresenceReconciler({ config, transport });
    await reconciler.publish({
      workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
      actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
    });
    await reconciler.archive('agent_support');
    await assert.rejects(reconciler.retry('agent_support'), /Archived Agents cannot be retried/);
    const archived = await config.getAgent('agent_support');
    assert.equal(archived.lifecycle, 'archived');
    assert.equal(archived.enabled, false);
    assert.equal(transport.groups[0]?.disabled, true);
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

test('JPEG and WebP uploads keep their pixels but lose embedded metadata', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent(agent('agent_support', 'Support', 'support'));
    const secret = new TextEncoder().encode('private-location');
    const jpeg = concat(
      Uint8Array.from([0xff, 0xd8]),
      jpegSegment(0xe1, concat(new TextEncoder().encode('Exif\0\0'), secret)),
      jpegSegment(0xdb, Uint8Array.from([0, 1, 2, 3])),
      jpegSegment(0xc0, Uint8Array.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
      jpegSegment(0xc4, Uint8Array.from([0, 1])),
      jpegSegment(0xfe, secret),
      jpegSegment(0xda, Uint8Array.from([1, 1, 0, 0, 0x3f, 0])),
      Uint8Array.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
      Uint8Array.from([0xff, 0xd9]),
    );
    await uploadAgentAvatar({
      config, settings, agentId: 'agent_support', bytes: jpeg,
      contentType: 'image/jpeg', publicOrigin: 'https://chickpea.example',
    });
    const storedJpeg = await readAgentAvatarAsset({ settings, agentId: 'agent_support', revision: 2 });
    assert.equal(storedJpeg?.contentType, 'image/jpeg');
    assert.equal(findBytes(storedJpeg!.bytes, secret), -1);
    assert.ok(findBytes(storedJpeg!.bytes, Uint8Array.from([0xff, 0xc0])) > 0);
    assert.ok(findBytes(storedJpeg!.bytes, Uint8Array.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9])) > 0);

    const vp8x = Uint8Array.from([0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const webpBody = concat(
      riffChunk('VP8X', vp8x),
      riffChunk('EXIF', secret),
      riffChunk('VP8 ', Uint8Array.from([1, 2, 3, 4])),
    );
    const webp = concat(
      new TextEncoder().encode('RIFF'),
      uint32le(4 + webpBody.length),
      new TextEncoder().encode('WEBP'),
      webpBody,
    );
    await uploadAgentAvatar({
      config, settings, agentId: 'agent_support', bytes: webp,
      contentType: 'image/webp', publicOrigin: 'https://chickpea.example',
    });
    const storedWebp = await readAgentAvatarAsset({ settings, agentId: 'agent_support', revision: 3 });
    assert.equal(storedWebp?.contentType, 'image/webp');
    assert.equal(findBytes(storedWebp!.bytes, secret), -1);
    assert.equal(findBytes(storedWebp!.bytes, new TextEncoder().encode('EXIF')), -1);
    assert.equal(storedWebp!.bytes[20], 0, 'VP8X EXIF flag is cleared');
    assert.deepEqual(Array.from(storedWebp!.bytes.subarray(4, 8)), Array.from(uint32le(storedWebp!.bytes.length - 8)));
    assert.ok(findBytes(storedWebp!.bytes, Uint8Array.from([1, 2, 3, 4])) > 0);
  } finally {
    config.close();
    settings.close();
  }
});

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return concat(Uint8Array.from([0xff, marker, length >> 8, length & 0xff]), payload);
}

function riffChunk(type: string, payload: Uint8Array): Uint8Array {
  return concat(
    new TextEncoder().encode(type),
    uint32le(payload.length),
    payload,
    payload.length & 1 ? new Uint8Array(1) : new Uint8Array(),
  );
}

function uint32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function onePixelPng(pixel: readonly number[]): Uint8Array {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, 1);
  new DataView(header.buffer).setUint32(4, 1);
  header.set([8, 6, 0, 0, 0], 8);
  const chunk = (type: string, data: Uint8Array) => {
    const typeBytes = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(concat(typeBytes, data)));
    return out;
  };
  return concat(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(Uint8Array.from([0, ...pixel])))),
    chunk('IEND', new Uint8Array()),
  );
}

function pngWithTextMetadata(pixel = [24, 92, 61, 255]): Uint8Array {
  const png = onePixelPng(pixel);
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
    kind: 'user',
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
  enableError: Error | undefined;
  disableError: Error | undefined;
  disableCalls = 0;
  enableCalls = 0;
  ambiguousCreate = false;
  ambiguousCreatePersistsGroup = true;
  onCreate?: () => Promise<void>;
  channel = { id: 'C_SUPPORT', name: 'support', private: false, member: false, archived: false };
  groups: SlackUserGroup[] = [];

  async lookupMember(): Promise<never> { throw new Error('unused'); }
  async lookupChannel() { return { ...this.channel }; }
  async listChannels() { return { channels: [{ ...this.channel }], truncated: false }; }
  async listMemberChannels(): Promise<ReadonlySet<string>> {
    return new Set(this.actorIsMember ? [this.channel.id] : []);
  }
  async channelHasMember() { return this.actorIsMember; }
  async openDirectConversation() {
    return { id: 'D_ACTOR', private: true, member: true, archived: false };
  }
  async joinPublicChannel() { this.joinCalls += 1; this.channel.member = true; return { ...this.channel }; }
  async lookupUserGroup(id: string) {
    const group = this.groups.find((candidate) => candidate.id === id);
    return group ? { ...group } : undefined;
  }
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
    this.disableCalls += 1;
    if (this.disableError) throw this.disableError;
    const group = this.requiredGroup(id); group.disabled = true; return { ...group };
  }
  async enableUserGroup(id: string) {
    this.enableCalls += 1;
    if (this.enableError) throw this.enableError;
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


for (const externallyDisabled of [false, true]) {
  test(`archive retry preserves disabled intent after Slack denial (already disabled: ${externallyDisabled})`, async () => {
    const config = new SqliteConfigStore(':memory:', { agents: [] });
    const transport = new FakeSlackTransport();
    try {
      await config.createAgent(agent('agent_support', 'Support', 'support'));
      const reconciler = new AgentPresenceReconciler({ config, transport });
      await reconciler.publish({ workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
        actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA' });
      await config.deleteAgentChannelGrant('TACME', 'C_SUPPORT', 'agent_support');
      assert.equal(transport.disableCalls, 0, 'removing the last grant does not disable Slack');
      transport.disableError = new SlackTransportError('usergroups.disable', 'permission_denied');
      await assert.rejects(() => reconciler.archive('agent_support'), AgentPresenceError);
      const failed = await config.getAgent('agent_support');
      assert.equal(failed.lifecycle, 'needs_attention');
      assert.equal(failed.slackPresence?.desiredState, 'disabled');
      assert.match(failed.slackPresence?.errorDetail ?? '', /disable the Agent handle/);
      const recovery = agentPresenceRecovery(new AgentPresenceError('user_group_policy_denied', 'denied'),
        'support', failed.slackPresence?.desiredState);
      assert.match(recovery.title, /archiving @support/);
      assert.match(recovery.explanation, /without reactivating/);
      assert.doesNotMatch(recovery.steps.join(' '), /Add Members|create and edit/i);
      await assert.rejects(() => reconciler.retry('agent_support'), AgentPresenceError);
      assert.equal((await config.getAgent('agent_support')).slackPresence?.desiredState, 'disabled');
      assert.equal(transport.enableCalls, 0);
      if (externallyDisabled) transport.groups[0]!.disabled = true;
      else transport.disableError = undefined;
      const disableCalls = transport.disableCalls;
      const archived = await reconciler.retry('agent_support');
      assert.equal(archived.lifecycle, 'archived');
      assert.equal(archived.slackPresence?.desiredState, 'disabled');
      assert.equal(archived.slackPresence?.errorCode, undefined);
      assert.equal(transport.groups[0]?.disabled, true);
      assert.equal(transport.enableCalls, 0);
      assert.equal(transport.disableCalls, disableCalls + (externallyDisabled ? 0 : 1));
    } finally { config.close(); }
  });
}
