import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';
import { PhotonImage } from '@cf-wasm/photon';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { provisionSlackInteractionMember } from '../src/auth/slack-admission.ts';
import type {
  SlackAppHomeReference,
  SlackChannel,
  SlackMember,
  SlackMessageReference,
  SlackTransport,
  SlackUserGroup,
} from '../src/slack/transport/types.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const TOKEN = 'agent-admin-token';

function auth(): HeadersInit {
  return testAdminHeaders(TOKEN, { 'content-type': 'application/json' });
}

function identity(): IdentityStore {
  return {
    getOrganization: async () => ({
      id: 'org_oss',
      name: 'Acme',
      slackTeamId: 'T_TEST',
      provisioningMode: 'all_workspace_members',
      createdAt: 1,
      updatedAt: 1,
    }),
    getMembership: async (id: string) => id === 'membership_test_owner'
      ? {
          id,
          organizationId: 'org_oss',
          userId: 'user_test_owner',
          role: 'owner',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        }
      : undefined,
    getUser: async (id: string) => id === 'user_test_owner'
      ? {
          id,
          slackTeamId: 'T_TEST',
          slackUserId: 'U_OWNER',
          displayName: 'Owner',
          contactEmail: 'owner@example.com',
          createdAt: 1,
          updatedAt: 1,
        }
      : undefined,
    recordAuthAudit: async () => undefined,
  } as unknown as IdentityStore;
}

class FakeTransport implements SlackTransport {
  readonly mode = 'direct' as const;
  groups: SlackUserGroup[] = [];
  channel: SlackChannel = {
    id: 'C_SUPPORT', name: 'support', private: false, member: false, archived: false,
  };
  memberAllowed = true;
  createError?: Error;

  async getWorkspaceInfo(): Promise<{ teamId: string; teamName?: string }> {
    return { teamId: 'T_TEST', teamName: 'Acme Inc' };
  }

  async lookupMember(userId: string): Promise<SlackMember> {
    return {
      id: userId, deleted: false, bot: false, restricted: false, ultraRestricted: false,
      appUser: false, stranger: false,
    };
  }
  async lookupChannel(): Promise<SlackChannel> { return this.channel; }
  async listChannels() { return { channels: [this.channel], truncated: false }; }
  async listMemberChannels(): Promise<ReadonlySet<string>> {
    return new Set(this.memberAllowed ? [this.channel.id] : []);
  }
  async channelHasMember(): Promise<boolean> { return this.memberAllowed; }
  async openDirectConversation(): Promise<SlackChannel> {
    return { id: 'D_OWNER', private: true, member: true, archived: false };
  }
  async joinPublicChannel(): Promise<SlackChannel> {
    this.channel = { ...this.channel, member: true };
    return this.channel;
  }
  async listUserGroups(): Promise<SlackUserGroup[]> { return this.groups.slice(); }
  async createUserGroup(input: { name: string; handle: string; description?: string }): Promise<SlackUserGroup> {
    if (this.createError) throw this.createError;
    const group = { id: `S${this.groups.length + 1}`, ...input, disabled: false };
    this.groups.push(group);
    return group;
  }
  async updateUserGroup(id: string, patch: Partial<Omit<SlackUserGroup, 'id' | 'disabled'>>): Promise<SlackUserGroup> {
    const index = this.groups.findIndex((group) => group.id === id);
    this.groups[index] = { ...this.groups[index]!, ...patch };
    return this.groups[index]!;
  }
  async disableUserGroup(id: string): Promise<SlackUserGroup> {
    return this.setDisabled(id, true);
  }
  async enableUserGroup(id: string): Promise<SlackUserGroup> {
    return this.setDisabled(id, false);
  }
  async publishAppHome(): Promise<SlackAppHomeReference> { return {}; }
  async postMessage(): Promise<SlackMessageReference> { return { channelId: 'C', ts: '1' }; }

  private setDisabled(id: string, disabled: boolean): SlackUserGroup {
    const index = this.groups.findIndex((group) => group.id === id);
    this.groups[index] = { ...this.groups[index]!, disabled };
    return this.groups[index]!;
  }
}

test('shared Slack connection backfills and persists the workspace display name', async () => {
  const fixture = harness();
  try {
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST',
      teamId: 'T_TEST',
      transportMode: 'gateway',
      appId: 'A_TEST',
      botUserId: 'U_BOT',
      gatewayBindingId: 'binding_test',
    });

    const response = await fixture.app.request('http://localhost/admin/api/slack-connection', {
      headers: auth(),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { connected: boolean; teamId: string; teamName: string };
    assert.equal(body.connected, true);
    assert.equal(body.teamId, 'T_TEST');
    assert.equal(body.teamName, 'Acme Inc');
    assert.equal(await fixture.settings.getSetting('slack.teamName'), 'Acme Inc');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

function harness(transport = new FakeTransport()) {
  const store = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const sourceIdentity = identity();
  const authority = testAdminAuthority(TOKEN, undefined, sourceIdentity);
  const snapshots = {
    listLiveRootsByAgent: async () => [],
  } as unknown as AgentSnapshotStore;
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store,
    settings,
    snapshots,
    slackTransport: transport,
    knownProviders: new Set(['local-stub']),
    ...authority,
  }));
  return { app, store, settings, transport };
}

async function createAgent(app: Hono, name = 'Support Triage') {
  const response = await app.request('http://localhost/admin/api/agents', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      id: 'agent_support',
      name,
      handle: 'support',
      description: 'Triages support questions',
      editPolicy: 'creator_and_admins',
      instructions: 'Answer support questions.',
      enabled: true,
      model: 'local-stub/admin-agent',
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { agent: Record<string, any> };
}

test('Agent create owns its handle, generated avatar, edit policy, and creator', async () => {
  const fixture = harness();
  try {
    const { agent } = await createAgent(fixture.app);
    assert.equal(agent.creatorMembershipId, 'membership_test_owner');
    assert.equal(agent.editPolicy, 'creator_and_admins');
    assert.equal(agent.lifecycle, 'draft');
    assert.equal(agent.slackPresence.normalizedHandle, 'support');
    assert.equal(agent.slackPresence.avatar.kind, 'generated');
    assert.match(agent.slackPresence.avatar.url, /\/assets\/agents\/agent_support\/avatar\/1$/);

    const avatar = await fixture.app.request(agent.slackPresence.avatar.url);
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get('content-type'), 'image/png');
    const avatarBytes = new Uint8Array(await avatar.arrayBuffer());
    assert.deepEqual([...avatarBytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.match(avatar.headers.get('cache-control') ?? '', /immutable/);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('Channel discovery projects a non-editor Agent as explicitly read-only', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const identities = new SqliteIdentityStore(':memory:');
  const transport = new FakeTransport();
  try {
    const owner = await createSlackOwner(identities, {
      teamId: 'T_TEST', userId: 'U_OWNER', suffix: 'readonly-owner',
    });
    const member = await provisionSlackInteractionMember({
      identity: identities,
      slackTeamId: 'T_TEST',
      botUserId: 'U_BOT',
      user: {
        id: 'U_MEMBER', teamId: 'T_TEST', displayName: 'Member',
        email: 'member@example.test', deleted: false, bot: false, appUser: false,
        restricted: false, ultraRestricted: false, stranger: false,
      },
    });
    assert.ok(member.resolution);
    await store.createAgent({
      id: 'agent_readonly', name: 'Readonly', description: 'Visible in Support',
      instructions: 'Help.', enabled: true, lifecycle: 'active',
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      model: 'local-stub/readonly', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await store.putAgentChannelGrant({
      workspaceId: 'T_TEST', channelId: 'C_SUPPORT', agentId: 'agent_readonly',
      status: 'active', createdByMembershipId: owner.membership.id,
      channelLabel: 'support', channelIsPrivate: false,
    });
    const principal: AuthPrincipal = {
      userId: member.resolution.user.id,
      membershipId: member.resolution.membership.id,
      organizationId: member.resolution.membership.organizationId,
      role: 'member', authenticatorKind: 'test_slack_session',
      credentialId: 'session_readonly', correlationId: 'request_readonly', machine: false,
    };
    const app = new Hono();
    app.route('/', createAdminRoutes({
      store, settings, slackTransport: transport,
      knownProviders: new Set(['local-stub']),
      ...testAdminAuthority(TOKEN, undefined, identities, principal),
    }));

    const list = await app.request('http://localhost/admin/api/agents', { headers: auth() });
    assert.equal(list.status, 200, await list.clone().text());
    const listed = (await list.json() as Record<string, any>).agents;
    assert.equal(listed.find((agent: Record<string, any>) => agent.id === 'agent_readonly')?.canEdit, false);

    const detail = await app.request('http://localhost/admin/api/agents/agent_readonly', { headers: auth() });
    assert.equal(detail.status, 200, await detail.clone().text());
    assert.equal((await detail.json() as Record<string, any>).agent.canEdit, false);
  } finally {
    identities.close();
    settings.close();
    store.close();
  }
});

test('shared-gateway channel discovery uses the credential-free transport', async () => {
  const fixture = harness();
  try {
    fixture.transport.channel = {
      id: 'C_SUPPORT', name: 'support', private: true, member: true, archived: false,
    };
    const picker = await fixture.app.request('http://localhost/admin/api/slack-channels', {
      headers: auth(),
    });
    assert.equal(picker.status, 200);
    const pickerBody = await picker.json() as Record<string, any>;
    assert.deepEqual(pickerBody.channels, [{
      id: 'C_SUPPORT', name: 'support', isPrivate: true, isMember: true,
    }]);
    assert.equal(pickerBody.teamId, 'T_TEST');

    const channels = await fixture.app.request('http://localhost/admin/api/channels', {
      headers: auth(),
    });
    assert.equal(channels.status, 200);
    const channelsBody = await channels.json() as Record<string, any>;
    assert.equal(channelsBody.discovery.connected, true);
    assert.equal(channelsBody.channels[0].channelId, 'C_SUPPORT');
    assert.equal(channelsBody.channels[0].isPrivate, true);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('Channel publication joins Chickpea, creates the user group, and activates the grant', async () => {
  const fixture = harness();
  try {
    await createAgent(fixture.app);
    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/channels',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ workspaceId: 'T_TEST', channelId: 'C_SUPPORT' }),
      },
    );
    assert.equal(response.status, 201);
    const body = await response.json() as Record<string, any>;
    assert.equal(body.grant.status, 'active');
    assert.equal(body.agent.slackPresence.health, 'healthy');
    assert.equal(fixture.transport.channel.member, true);
    assert.deepEqual(fixture.transport.groups.map(({ handle }) => handle), ['support']);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('Published Agent edits update the existing Slack handle instead of creating another group', async () => {
  const fixture = harness();
  try {
    await createAgent(fixture.app);
    const published = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/channels',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ workspaceId: 'T_TEST', channelId: 'C_SUPPORT' }),
      },
    );
    const publishedBody = await published.json() as Record<string, any>;
    const groupId = publishedBody.agent.slackPresence.userGroupId;

    const edited = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support',
      {
        method: 'PATCH', headers: auth(),
        body: JSON.stringify({
          expectedRevision: publishedBody.agent.revision,
          name: 'Customer Care',
          handle: 'customer-care',
          description: 'Handles customer questions',
        }),
      },
    );
    assert.equal(edited.status, 200);
    const editedBody = await edited.json() as Record<string, any>;
    assert.equal(editedBody.agent.slackPresence.health, 'healthy');
    assert.equal(editedBody.agent.slackPresence.userGroupId, groupId);
    assert.equal(fixture.transport.groups.length, 1);
    assert.deepEqual(fixture.transport.groups[0], {
      id: groupId,
      name: 'Customer Care',
      handle: 'customer-care',
      description: 'Handles customer questions',
      disabled: false,
    });
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('Slack policy failures preserve the Agent and return exact recovery steps', async () => {
  const transport = new FakeTransport();
  transport.createError = new SlackTransportError('usergroups.create', 'permission_denied');
  const fixture = harness(transport);
  try {
    await createAgent(fixture.app);
    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/channels',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ workspaceId: 'T_TEST', channelId: 'C_SUPPORT' }),
      },
    );
    assert.equal(response.status, 409);
    const body = await response.json() as Record<string, any>;
    assert.equal(body.error, 'user_group_policy_denied');
    assert.match(body.recovery.explanation, /Reconnect.*will not change/i);
    assert.match(body.recovery.steps[0], /Roles & permissions/);
    assert.equal(body.agent.slackPresence.health, 'needs_attention');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('Avatar uploads create a new immutable revision used by later Slack replies', async () => {
  const fixture = harness();
  try {
    const { agent } = await createAgent(fixture.app);
    const source = new PhotonImage(Uint8Array.from([24, 92, 61, 255]), 1, 1);
    const png = Buffer.from(source.get_bytes());
    source.free();
    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/avatar',
      {
        method: 'PUT', headers: auth(),
        body: JSON.stringify({ contentType: 'image/png', base64: png.toString('base64') }),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, any>;
    assert.equal(body.agent.slackPresence.avatar.kind, 'uploaded');
    assert.equal(body.agent.slackPresence.avatar.revision, 2);
    assert.notEqual(body.agent.slackPresence.avatar.url, agent.slackPresence.avatar.url);
    const uploaded = await fixture.app.request(body.agent.slackPresence.avatar.url);
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.headers.get('content-type'), 'image/png');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('Archive disables the same Slack handle and restore re-enables it', async () => {
  const fixture = harness();
  try {
    await createAgent(fixture.app);
    const published = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/channels',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ workspaceId: 'T_TEST', channelId: 'C_SUPPORT' }),
      },
    );
    const publishedBody = await published.json() as Record<string, any>;
    const groupId = publishedBody.agent.slackPresence.userGroupId;
    const archived = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/archive',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ expectedRevision: publishedBody.agent.revision }),
      },
    );
    assert.equal(archived.status, 200);
    const archivedBody = await archived.json() as Record<string, any>;
    assert.equal(archivedBody.agent.lifecycle, 'archived');
    assert.equal(fixture.transport.groups.find(({ id }) => id === groupId)?.disabled, true);

    const restored = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/restore',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ expectedRevision: archivedBody.agent.revision }),
      },
    );
    assert.equal(restored.status, 200);
    const restoredBody = await restored.json() as Record<string, any>;
    assert.equal(restoredBody.agent.lifecycle, 'active');
    assert.equal(restoredBody.agent.slackPresence.userGroupId, groupId);
    assert.equal(fixture.transport.groups.find(({ id }) => id === groupId)?.disabled, false);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});
