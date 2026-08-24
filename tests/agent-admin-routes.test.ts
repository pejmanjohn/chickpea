import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';
import { PhotonImage } from '@cf-wasm/photon';
import * as v from 'valibot';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore, type ConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { AuthorizationError } from '../src/auth/permissions.ts';
import { provisionSlackInteractionMember } from '../src/auth/slack-admission.ts';
import {
  ApiOAuthError,
  apiOAuthSettingKeys,
  connectionAccountOAuthRef,
} from '../src/config/api-oauth.ts';
import {
  McpOAuthError,
  mcpOAuthSettingKeys,
  type StartMcpOAuthInput,
} from '../src/config/mcp-oauth.ts';
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
import { defaultAgentAvatarPng } from '../src/slack/agent-presence/default-avatar-pool.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import {
  createManagedConnectorCatalog,
  type ManagedConnectorDefinition,
} from '../src/connections/catalog/index.ts';
import { ManagedAuthorizationAllocatedError } from '../src/connections/managed-errors.ts';
import {
  beginManagedAuthorization,
  recordManagedAuthorizationAccount,
  recordManagedAuthorizationRequest,
} from '../src/connections/managed-authorization.ts';

const TOKEN = 'agent-admin-token';

function auth(): HeadersInit {
  return testAdminHeaders(TOKEN, { 'content-type': 'application/json' });
}

async function composioWebhookSignature(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(message),
  ));
  return Buffer.from(bytes).toString('base64');
}

async function managedAuthorizationSettingKey(actorMembershipId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(actorMembershipId),
  ));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `connections.managed.authorization.${hex.slice(0, 32)}`;
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

function harness(
  transport = new FakeTransport(),
  overrides: Partial<Parameters<typeof createAdminRoutes>[0]> = {},
  backing: { store?: SqliteConfigStore; settings?: SqliteSettingsStore } = {},
  principal?: AuthPrincipal,
) {
  const store = backing.store ?? new SqliteConfigStore(':memory:');
  const settings = backing.settings ?? new SqliteSettingsStore(':memory:');
  const sourceIdentity = identity();
  const authority = testAdminAuthority(TOKEN, undefined, sourceIdentity, principal);
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
    ...overrides,
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
    assert.match(agent.slackPresence.avatar.seed, /^chickpea-avatar-v1:\d{2}:/);
    assert.match(agent.slackPresence.avatar.url, /\/assets\/agents\/agent_support\/avatar\/1$/);

    const avatar = await fixture.app.request(agent.slackPresence.avatar.url);
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get('content-type'), 'image/png');
    const avatarBytes = new Uint8Array(await avatar.arrayBuffer());
    assert.deepEqual([...avatarBytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(avatarBytes, defaultAgentAvatarPng(agent.slackPresence.avatar.seed));
    assert.match(avatar.headers.get('cache-control') ?? '', /immutable/);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('reusable MCP credentials cannot target an undeclared header', async () => {
  const fixture = harness();
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'team', providerId: 'custom', label: 'Unsafe',
          credential: 'secret', allowedCapabilities: [],
          mcp: {
            id: 'unsafe', displayName: 'Unsafe', url: 'https://mcp.example.test/mcp',
            transport: 'streamable-http', authMode: 'none', headerNames: [],
            credentialHeaderName: 'x-api-key', enabled: true,
            lifecycleStatus: 'pending', statusText: '', discoveredTools: [], allowedTools: [],
          },
        }),
      },
    );
    assert.equal(response.status, 400, await response.clone().text());
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('the reusable connection API never accepts caller-supplied managed account refs', async () => {
  const providerCalls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() { providerCalls.push('validate'); },
    async execute() { return { data: {} }; },
    async revoke() { providerCalls.push('revoke'); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', providerId: 'google',
          label: 'Managed Gmail', allowedCapabilities: ['gmail.messages.search'],
          managed: {
            adapterId: 'composio', toolkit: 'gmail', accountRef: 'ca_someone_else',
            capabilities: ['gmail.profile.read', 'gmail.messages.search'],
          },
        }),
      },
    );

    assert.equal(response.status, 400, await response.clone().text());
    assert.deepEqual(await fixture.store.listConnectionAccounts('T_TEST'), []);
    assert.deepEqual(providerCalls, []);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('managed revoke response strips execution-only provider references', async () => {
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const account = await fixture.store.putConnectionAccount({
      id: 'connection_managed_revoke', workspaceId: 'T_TEST', ownerKind: 'team',
      createdByMembershipId: 'membership_test_owner', providerId: 'google',
      label: 'Analytics',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'google_analytics',
        principalRef: 'chickpea:organization:organization_test', accountRef: 'ca_revoke',
        allowedCapabilities: ['analytics.reports.run'],
        resourceConstraints: {
          propertyIds: [{
            handle: 'property_safe', providerRef: 'properties/999', label: 'Website',
          }],
        },
      },
      secretRefId: 'secret_managed_revoke', lifecycle: 'ready',
    }, 0);

    const response = await fixture.app.request(
      `http://localhost/admin/api/connections/${account.id}/revoke`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const serialized = JSON.stringify(await response.json());
    assert.doesNotMatch(serialized, /ca_revoke|properties\/999|chickpea:organization/);
    assert.match(serialized, /property_safe/);
    assert.match(serialized, /Website/);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('managed Google setup reports an unconfigured provider without reserving an attempt', async () => {
  const fixture = harness();
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const request = () => fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );

    for (const response of [await request(), await request()]) {
      assert.equal(response.status, 503, await response.clone().text());
      assert.deepEqual(await response.json(), {
        error: 'managed_provider_unavailable',
        message: 'Gmail managed access is not configured for this deployment.',
      });
    }

    const imported = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', providerId: 'google',
          label: 'Gmail · Personal', allowedCapabilities: ['gmail.messages.search'],
          managed: {
            adapterId: 'composio', toolkit: 'gmail', accountRef: 'ca_import_unconfigured',
            capabilities: ['gmail.profile.read', 'gmail.messages.search'],
          },
        }),
      },
    );
    assert.equal(imported.status, 400, await imported.clone().text());

    const account = await fixture.store.putConnectionAccount({
      id: 'connection_unconfigured_composio',
      workspaceId: 'T_TEST',
      ownerKind: 'member',
      ownerMembershipId: 'membership_test_owner',
      createdByMembershipId: 'membership_test_owner',
      providerId: 'google',
      label: 'Gmail · Personal',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:membership:membership_test_owner',
        accountRef: 'ca_unconfigured',
        allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
      },
      secretRefId: 'secret_unconfigured_composio',
      lifecycle: 'ready',
    }, 0);
    const revoke = await fixture.app.request(
      `http://localhost/admin/api/connections/${account.id}/revoke`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(revoke.status, 503, await revoke.clone().text());
    assert.deepEqual(await revoke.json(), {
      error: 'managed_provider_unavailable',
      message: 'Restore the composio provider credentials before disconnecting this managed account so its remote account can also be removed.',
    });
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST'))
        .find(({ id }) => id === account.id)?.lifecycle,
      'needs_attention',
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('the reusable connection catalog reports managed readiness per toolkit and lane', async () => {
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability({ toolkit, accessLane }) {
      return toolkit === 'gmail' && accessLane === 'read'
        ? { status: 'ready', missingConfiguration: [] }
        : { status: 'missing_configuration', missingConfiguration: ['auth_config_missing'] };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections?workspaceId=T_TEST',
      { headers: auth() },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as {
      managedConnectors: {
        composio: boolean;
        catalog: Array<{
          toolkit: string;
          access: { read: { status: string }; write: { status: string } };
        }>;
      };
    };
    assert.equal(body.managedConnectors.composio, true);
    assert.deepEqual(body.managedConnectors.catalog.map(({ toolkit }) => toolkit), [
      'gmail', 'googlecalendar', 'googledrive',
      'googlesheets', 'googledocs', 'googleslides',
      'google_search_console', 'google_analytics',
      'notion',
      'hubspot',
      'gong',
      'googleads',
      'youtube',
    ]);
    assert.deepEqual(body.managedConnectors.catalog[0]?.access, {
      read: { status: 'ready', missingConfiguration: [] },
      write: {
        status: 'missing_configuration',
        missingConfiguration: ['auth_config_missing'],
      },
    });
    assert.equal(body.managedConnectors.catalog[1]?.access.read.status, 'missing_configuration');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('managed resource routes return local handles and reject stale selections', async () => {
  const connector: ManagedConnectorDefinition = {
    id: 'analytics-fixture',
    toolkit: 'analytics_fixture',
    providerId: 'google',
    label: 'Analytics fixture',
    description: 'Test-only resource-scoped connector.',
    securityDescription: 'Only selected properties are available.',
    resources: [{
      key: 'propertyIds',
      label: 'Properties',
      required: true,
      multiple: true,
      localArgument: 'propertyHandle',
      providerArgument: 'propertyId',
    }],
    capabilities: [{
      id: 'analytics_fixture.reports.read',
      connectorToolkit: 'analytics_fixture',
      accessLane: 'read',
      effect: 'read',
      toolName: 'analytics_fixture_read_report',
      description: 'Read a fixture report.',
      input: v.strictObject({ propertyHandle: v.string() }),
      maxResultBytes: 16_384,
    }],
  };
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability() { return { status: 'ready', missingConfiguration: [] }; },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
    async discoverResources() {
      return {
        resources: [
          { providerRef: 'properties/123', label: 'Primary property' },
          { providerRef: 'properties/456', label: 'Secondary property' },
        ],
      };
    },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectorCatalog: createManagedConnectorCatalog([connector]),
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const account = await fixture.store.putConnectionAccount({
      id: 'connection_resources',
      workspaceId: 'T_TEST',
      ownerKind: 'member',
      ownerMembershipId: 'membership_test_owner',
      createdByMembershipId: 'membership_test_owner',
      providerId: 'google',
      label: 'Analytics fixture',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: connector.toolkit,
        principalRef: 'chickpea:membership:membership_test_owner',
        accountRef: 'ca_resources',
        allowedCapabilities: ['analytics_fixture.reports.read'],
      },
      secretRefId: 'secret_resources',
      lifecycle: 'pending',
    }, 0);
    await fixture.store.putAgentConnectionBinding({
      agentId: 'agent_support',
      connectionAccountId: account.id,
      providerId: 'google',
      allowedCapabilities: ['analytics_fixture.reports.read'],
      resourceConstraints: {},
      enabled: true,
    });

    const discovery = await fixture.app.request(
      `http://localhost/admin/api/agents/agent_support/connections/${account.id}/managed/resources?workspaceId=T_TEST&resourceKey=propertyIds`,
      { headers: auth() },
    );
    assert.equal(discovery.status, 200, await discovery.clone().text());
    const discovered = await discovery.json() as {
      resources: Array<{ handle: string; label: string }>;
    };
    assert.equal(discovered.resources.length, 2);
    assert.doesNotMatch(JSON.stringify(discovered), /properties\/123|properties\/456/);
    const selectedHandle = discovered.resources[0]!.handle;

    const selection = await fixture.app.request(
      `http://localhost/admin/api/agents/agent_support/connections/${account.id}/managed/resources`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST',
          expectedRevision: account.revision,
          resourceConstraints: { propertyIds: [selectedHandle] },
        }),
      },
    );
    assert.equal(selection.status, 200, await selection.clone().text());
    const selected = await selection.json();
    assert.doesNotMatch(JSON.stringify(selected), /properties\/123|properties\/456/);

    const persisted = (await fixture.store.listConnectionAccounts('T_TEST'))
      .find(({ id }) => id === account.id);
    assert.equal(persisted?.policy.kind, 'managed');
    if (persisted?.policy.kind !== 'managed') assert.fail('expected managed policy');
    assert.equal(
      persisted.policy.resourceConstraints?.propertyIds?.[0]?.providerRef,
      'properties/123',
    );

    const stale = await fixture.app.request(
      `http://localhost/admin/api/agents/agent_support/connections/${account.id}/managed/resources`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST',
          expectedRevision: account.revision,
          resourceConstraints: { propertyIds: [selectedHandle] },
        }),
      },
    );
    assert.equal(stale.status, 409, await stale.clone().text());
    assert.deepEqual(await stale.json(), {
      error: 'managed_resource_selection_stale',
      message: 'Managed connection changed',
    });
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('an owner reconciles malformed managed authorization state before retrying', async (t) => {
  const errors: string[] = [];
  const cleanedRemoteAccounts: string[] = [];
  let authorizationCalls = 0;
  t.mock.method(console, 'error', (message: string) => { errors.push(message); });
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      authorizationCalls += 1;
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/should-not-start'),
        authorizationRef: 'ca_should_not_start',
      };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
    async cleanupRemoteAccount(input) { cleanedRemoteAccounts.push(input.accountRef); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const imported = await fixture.store.putConnectionAccount({
      id: 'connection_imported_upgrade',
      workspaceId: 'T_TEST',
      ownerKind: 'member',
      ownerMembershipId: 'membership_test_owner',
      createdByMembershipId: 'membership_test_owner',
      providerId: 'google',
      label: 'Imported Gmail',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:membership:membership_test_owner',
        accountRef: 'ca_authorized_upgrade',
        allowedCapabilities: ['gmail.profile.read'],
      },
      secretRefId: 'secret_imported_upgrade',
      lifecycle: 'ready',
    }, 0);
    const key = await managedAuthorizationSettingKey('membership_test_owner');
    const malformed = JSON.stringify({
      version: 2,
      adapterId: 'composio',
      authorizationRef: 'ca_pending_upgrade',
      accountRef: 'ca_authorized_upgrade',
    });
    await fixture.settings.setSetting(key, malformed);

    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );

    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await response.json(), {
      error: 'managed_authorization_recovery_required',
      message: 'This Google sign-in needs administrator cleanup before another connection can start. Contact your Chickpea workspace owner.',
    });
    assert.equal(await fixture.settings.getSetting(key), malformed);
    assert.equal(authorizationCalls, 0);
    assert.ok(errors.some((message) => {
      const event = JSON.parse(message) as Record<string, unknown>;
      return event.event === 'chickpea.managed_connection.invalid_authorization_attempt_blocked' &&
        event.authorizationRef === 'ca_pending_upgrade' &&
        event.accountRef === 'ca_authorized_upgrade' &&
        event.adapterId === 'composio';
    }));

    const recovered = await fixture.app.request(
      'http://localhost/admin/api/connections/managed/recover',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ actorMembershipId: 'membership_test_owner' }),
      },
    );
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.deepEqual(await recovered.json(), { recovered: true, deletedRemoteAccounts: 1 });
    assert.deepEqual(cleanedRemoteAccounts, ['ca_pending_upgrade']);
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST'))
        .find(({ id }) => id === imported.id)?.lifecycle,
      'ready',
    );
    assert.equal(await fixture.settings.getSetting(key), undefined);

    const restarted = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    assert.equal(restarted.status, 200, await restarted.clone().text());
    assert.equal(authorizationCalls, 1);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('a failed Connect Link validates and deletes its allocated remote account', async () => {
  const revoked: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      throw new ManagedAuthorizationAllocatedError('ca_invalid_connect_link');
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke(input) { revoked.push(input.policy.accountRef); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });

    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );

    assert.equal(response.status, 500, await response.clone().text());
    assert.deepEqual(revoked, ['ca_invalid_connect_link']);
    assert.equal(
      await fixture.settings.getSetting(
        await managedAuthorizationSettingKey('membership_test_owner'),
      ),
      undefined,
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('managed Google authorization starts a Connect Link and imports the verified callback account', async () => {
  const calls: string[] = [];
  const authorizedCapabilities: string[][] = [];
  let completedAccountRef = 'ca_connected';
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize(input) {
      calls.push(`authorize:${input.principalRef}:${input.toolkit}`);
      authorizedCapabilities.push([...input.allowedCapabilities]);
      assert.equal(input.callbackUrl, 'http://localhost/admin/connections/composio/callback');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/lk_test'),
        authorizationRef: completedAccountRef,
      };
    },
    async completeAuthorization(input) {
      calls.push(`complete:${input.principalRef}:${input.sessionUri}`);
      return { accountRef: completedAccountRef, toolkit: 'gmail' };
    },
    async validate(input) {
      calls.push(`validate:${input.policy.accountRef}`);
    },
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const started = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'write',
        }),
      },
    );
    assert.equal(started.status, 200, await started.clone().text());
    assert.deepEqual(await started.clone().json(), {
      authorizationUrl: 'https://connect.composio.dev/link/lk_test',
    });
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(cookie);
    assert.match(started.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.match(started.headers.get('set-cookie') ?? '', /SameSite=Lax/);

    const callback = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Fsigned-once',
      { headers: testAdminHeaders(TOKEN, { cookie }) },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      '/admin/agents/agent_support/connections?managed=connected&toolkit=gmail',
    );
    const accounts = await fixture.store.listConnectionAccounts('T_TEST');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.label, 'Gmail · Personal');
    assert.deepEqual(accounts[0]?.policy, {
      kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
      principalRef: 'chickpea:membership:membership_test_owner',
      accountRef: 'ca_connected',
      allowedCapabilities: [
        'gmail.profile.read', 'gmail.messages.search',
        'gmail.drafts.create', 'gmail.messages.send',
      ],
    });
    assert.equal(accounts[0]?.lifecycle, 'ready');
    assert.deepEqual(
      (await fixture.store.listAgentConnectionBindings('agent_support'))[0]?.allowedCapabilities,
      [
        'gmail.profile.read', 'gmail.messages.search',
        'gmail.drafts.create', 'gmail.messages.send',
      ],
    );
    assert.deepEqual(calls, [
      'authorize:chickpea:membership:membership_test_owner:gmail',
      'complete:chickpea:membership:membership_test_owner:session://signed-once',
      'validate:ca_connected',
    ]);
    assert.deepEqual(authorizedCapabilities[0], [
      'gmail.profile.read', 'gmail.messages.search',
      'gmail.drafts.create', 'gmail.messages.send',
    ]);

    const original = accounts[0]!;
    const originalBinding = (await fixture.store.listAgentConnectionBindings('agent_support'))[0]!;
    await fixture.store.putAgentConnectionBinding({ ...originalBinding, enabled: false });
    await fixture.store.putConnectionAccount(
      { ...original, lifecycle: 'needs_attention' },
      original.revision,
    );
    completedAccountRef = 'ca_reconnected';
    const restarted = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', connectionAccountId: original.id,
        }),
      },
    );
    assert.equal(restarted.status, 200, await restarted.clone().text());
    const reconnectCookie = restarted.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(reconnectCookie);
    const reconnected = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Freconnect-once',
      { headers: testAdminHeaders(TOKEN, { cookie: reconnectCookie }) },
    );
    assert.equal(reconnected.status, 303, await reconnected.clone().text());
    const reconnectedAccounts = await fixture.store.listConnectionAccounts('T_TEST');
    assert.equal(reconnectedAccounts.length, 1);
    assert.equal(reconnectedAccounts[0]?.id, original.id);
    assert.equal(reconnectedAccounts[0]?.lifecycle, 'ready');
    assert.equal(
      (await fixture.store.listAgentConnectionBindings('agent_support'))[0]?.enabled,
      false,
      'an unattached managed account must reconnect without silently reattaching',
    );
    assert.equal(
      reconnectedAccounts[0]?.policy.kind === 'managed'
        ? reconnectedAccounts[0].policy.accountRef
        : undefined,
      'ca_reconnected',
    );
    assert.deepEqual(calls.slice(-3), [
      'authorize:chickpea:membership:membership_test_owner:gmail',
      'complete:chickpea:membership:membership_test_owner:session://reconnect-once',
      'validate:ca_reconnected',
    ]);
    await fixture.store.putAgentConnectionBinding({ ...originalBinding, enabled: true });

    await fixture.store.putAgentScheduleReference({
      scheduleId: 'schedule_managed_gmail', agentId: 'agent_support', workspaceId: 'T_TEST',
      channelId: 'C_TEST', createdByMembershipId: 'membership_test_owner',
      runsAsMembershipId: 'membership_test_owner', authorityReceiptId: 'authority_managed_gmail',
      requiredConnectionAccountIds: [original.id], state: 'active',
    });
    const secret = 'whsec_route_test';
    const webhookId = 'msg_expired_test';
    const webhookEventId = 'evt_expired_test';
    const webhookTimestamp = String(Math.floor(Date.now() / 1_000));
    const webhookBody = JSON.stringify({
      id: webhookEventId,
      timestamp: new Date().toISOString(),
      type: 'composio.connected_account.expired',
      metadata: {},
      data: { id: 'ca_reconnected', toolkit: { slug: 'gmail' } },
    });
    const webhookSignature = await composioWebhookSignature(
      secret,
      `${webhookId}.${webhookTimestamp}.${webhookBody}`,
    );
    const unconfiguredWebhook = await fixture.app.request(
      'http://localhost/webhooks/composio',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: webhookBody,
      },
    );
    assert.equal(unconfiguredWebhook.status, 503, await unconfiguredWebhook.clone().text());
    assert.deepEqual(await unconfiguredWebhook.json(), { error: 'not_configured' });
    const invalidWebhook = await fixture.app.request(
      'http://localhost/webhooks/composio',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': webhookId,
          'webhook-timestamp': webhookTimestamp,
          'webhook-signature': 'v1,invalid',
        },
        body: webhookBody,
      },
      { COMPOSIO_WEBHOOK_SECRET: secret },
    );
    assert.equal(invalidWebhook.status, 401, await invalidWebhook.clone().text());
    assert.deepEqual(await invalidWebhook.json(), { error: 'invalid_webhook' });
    const oversizedWebhook = await fixture.app.request(
      'http://localhost/webhooks/composio',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(256 * 1024 + 1),
      },
      { COMPOSIO_WEBHOOK_SECRET: secret },
    );
    assert.equal(oversizedWebhook.status, 413, await oversizedWebhook.clone().text());
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST'))[0]?.lifecycle,
      'ready',
    );
    const ignoredWebhookId = 'msg_trigger_test';
    const ignoredWebhookBody = JSON.stringify({
      id: 'evt_trigger_test',
      timestamp: new Date().toISOString(),
      type: 'composio.trigger.message',
      metadata: {},
      data: {},
    });
    const ignoredWebhookSignature = await composioWebhookSignature(
      secret,
      `${ignoredWebhookId}.${webhookTimestamp}.${ignoredWebhookBody}`,
    );
    const ignoredWebhook = await fixture.app.request(
      'http://localhost/webhooks/composio',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': ignoredWebhookId,
          'webhook-timestamp': webhookTimestamp,
          'webhook-signature': `v1,${ignoredWebhookSignature}`,
        },
        body: ignoredWebhookBody,
      },
      { COMPOSIO_WEBHOOK_SECRET: secret },
    );
    assert.equal(ignoredWebhook.status, 204, await ignoredWebhook.clone().text());
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST'))[0]?.lifecycle,
      'ready',
    );
    const expired = await fixture.app.request(
      'http://localhost/webhooks/composio',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': webhookId,
          'webhook-timestamp': webhookTimestamp,
          'webhook-signature': `v1,${webhookSignature}`,
        },
        body: webhookBody,
      },
      { COMPOSIO_WEBHOOK_SECRET: secret },
    );
    assert.equal(expired.status, 204, await expired.clone().text());
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST'))[0]?.lifecycle,
      'needs_attention',
    );
    assert.equal(
      (await fixture.store.listAgentScheduleReferences('agent_support'))[0]?.state,
      'needs_attention',
    );

    // Reauthorization uses the existing lane so the callback can revalidate
    // the same account and restore Chickpea readiness without creating an
    // ambiguous second Personal Gmail connection on this Agent.
    const freshRestart = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', connectionAccountId: original.id,
        }),
      },
    );
    assert.equal(freshRestart.status, 200, await freshRestart.clone().text());
    const freshCookie = freshRestart.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(freshCookie);
    const freshCallback = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Ffresh-reauthorize',
      { headers: testAdminHeaders(TOKEN, { cookie: freshCookie }) },
    );
    assert.equal(freshCallback.status, 303, await freshCallback.clone().text());
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST'))[0]?.lifecycle,
      'ready',
    );
    const freshAccount = (await fixture.store.listConnectionAccounts('T_TEST'))[0];
    assert.equal(
      freshAccount?.policy.kind === 'managed'
        ? freshAccount.policy.allowedCapabilities.length
        : 0,
      4,
      'a narrower Agent binding must not narrow the shared account ceiling',
    );
    assert.deepEqual(
      (await fixture.store.listAgentConnectionBindings('agent_support'))[0]?.allowedCapabilities,
      [
        'gmail.profile.read', 'gmail.messages.search',
        'gmail.drafts.create', 'gmail.messages.send',
      ],
    );
    assert.deepEqual(authorizedCapabilities.at(-1), [
      'gmail.profile.read', 'gmail.messages.search',
      'gmail.drafts.create', 'gmail.messages.send',
    ]);
    assert.deepEqual(calls.slice(-3), [
      'authorize:chickpea:membership:membership_test_owner:gmail',
      'complete:chickpea:membership:membership_test_owner:session://fresh-reauthorize',
      'validate:ca_reconnected',
    ]);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('a finalize race after durable managed import still reports the working connection', async (t) => {
  const baseSettings = new SqliteSettingsStore(':memory:');
  let finalizeAttempts = 0;
  const racingSettings = new Proxy(baseSettings as SettingsStore, {
    get(target, property) {
      if (property === 'applySettingsPatch') return async (
        patch: Parameters<SettingsStore['applySettingsPatch']>[0],
      ) => {
        if (patch.delete && patch.delete.length > 0) {
          finalizeAttempts += 1;
          return false;
        }
        return target.applySettingsPatch(patch);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/finalize-race'),
        authorizationRef: 'ca_finalize_race',
      };
    },
    async completeAuthorization() {
      return { accountRef: 'ca_finalize_race', toolkit: 'gmail' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const fixture = harness(new FakeTransport(), {
    settings: racingSettings,
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  }, { settings: baseSettings });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const started = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    assert.equal(started.status, 200, await started.clone().text());
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(cookie);

    const callback = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Ffinalize-race',
      { headers: testAdminHeaders(TOKEN, { cookie }) },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      '/admin/agents/agent_support/connections?managed=connected&toolkit=gmail',
    );
    assert.match(callback.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal(finalizeAttempts, 1);
    const accounts = await fixture.store.listConnectionAccounts('T_TEST');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.lifecycle, 'ready');
    assert.equal((await fixture.store.listAgentConnectionBindings('agent_support')).length, 1);
    assert.ok(warnings.some((message) =>
      message.includes('chickpea.managed_connection.finalization_deferred')));
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('a transient local import failure can retry without redeeming or revoking twice', async () => {
  const calls: string[] = [];
  let validationAttempts = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      calls.push('authorize');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/lk_retry'),
        authorizationRef: 'ca_retry',
      };
    },
    async completeAuthorization() {
      calls.push('complete');
      return { accountRef: 'ca_retry', toolkit: 'gmail' };
    },
    async validate() {
      validationAttempts += 1;
      calls.push(`validate:${validationAttempts}`);
      if (validationAttempts === 1) throw new Error('transient provider lookup failure');
    },
    async execute() { return { data: {} }; },
    async revoke() { calls.push('revoke'); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const started = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    assert.equal(started.status, 200, await started.clone().text());
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(cookie);
    const callbackUrl =
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Fretry-once';

    const failed = await fixture.app.request(callbackUrl, {
      headers: testAdminHeaders(TOKEN, { cookie }),
    });
    assert.equal(failed.status, 303, await failed.clone().text());
    assert.equal(
      failed.headers.get('location'),
      '/admin/agents/agent_support/connections?managed=failed',
    );
    assert.doesNotMatch(failed.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.deepEqual(await fixture.store.listConnectionAccounts('T_TEST'), []);

    const retried = await fixture.app.request(callbackUrl, {
      headers: testAdminHeaders(TOKEN, { cookie }),
    });
    assert.equal(retried.status, 303, await retried.clone().text());
    assert.equal(
      retried.headers.get('location'),
      '/admin/agents/agent_support/connections?managed=connected&toolkit=gmail',
    );
    assert.equal((await fixture.store.listConnectionAccounts('T_TEST')).length, 1);
    assert.deepEqual(calls, ['authorize', 'complete', 'validate:1', 'validate:2']);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('the same browser revokes an unimported authorized grant before starting over', async () => {
  const calls: string[] = [];
  let authorizationNumber = 0;
  let currentAccountRef = '';
  let rejectRevocation = true;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      currentAccountRef = `ca_cleanup_${++authorizationNumber}`;
      calls.push(`authorize:${currentAccountRef}`);
      return {
        authorizationUrl: new URL(`https://connect.composio.dev/link/${currentAccountRef}`),
        authorizationRef: currentAccountRef,
      };
    },
    async completeAuthorization() {
      calls.push(`complete:${currentAccountRef}`);
      return { accountRef: currentAccountRef, toolkit: 'gmail' };
    },
    async validate() {
      calls.push('validate:failed');
      throw new Error('transient import failure');
    },
    async execute() { return { data: {} }; },
    async revoke(input) {
      calls.push(`revoke:${input.policy.accountRef}`);
      if (rejectRevocation) throw new Error('remote account deletion failed');
    },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const start = (cookie?: string) => fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST',
        headers: testAdminHeaders(TOKEN, {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        }),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    const first = await start();
    assert.equal(first.status, 200, await first.clone().text());
    const cookie = first.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(cookie);
    const failedImport = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Fcleanup',
      { headers: testAdminHeaders(TOKEN, { cookie }) },
    );
    assert.equal(failedImport.status, 303, await failedImport.clone().text());
    assert.deepEqual(await fixture.store.listConnectionAccounts('T_TEST'), []);

    const cleanupFailed = await start(cookie);
    assert.equal(cleanupFailed.status, 500, await cleanupFailed.clone().text());
    assert.equal(authorizationNumber, 1, 'failed cleanup must not issue another Connect Link');

    rejectRevocation = false;
    const restarted = await start(cookie);
    assert.equal(restarted.status, 200, await restarted.clone().text());
    assert.equal(authorizationNumber, 2);
    assert.deepEqual(calls, [
      'authorize:ca_cleanup_1',
      'complete:ca_cleanup_1',
      'validate:failed',
      'revoke:ca_cleanup_1',
      'revoke:ca_cleanup_1',
      'authorize:ca_cleanup_2',
    ]);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('a stale authorized grant is revoked and replaced after its browser cookie is gone', async () => {
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      calls.push('authorize:ca_recovered');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/ca_recovered'),
        authorizationRef: 'ca_recovered',
      };
    },
    async completeAuthorization() {
      return { accountRef: 'ca_recovered', toolkit: 'gmail' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const startedAt = Date.now() - 40 * 60_000;
    const stale = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST',
        agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner',
        ownerKind: 'member',
        providerId: 'google',
        adapterId: 'composio',
        toolkit: 'gmail',
        label: 'Gmail · Personal',
        principalRef: 'chickpea:membership:membership_test_owner',
        allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
        bindingCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
      },
      now: () => startedAt,
      randomSecret: () => '9'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: stale.browserSecret,
      authorizationRef: 'ca_orphaned',
      now: () => startedAt + 1,
    });
    await recordManagedAuthorizationAccount({
      settings: fixture.settings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: stale.browserSecret,
      accountRef: 'ca_orphaned',
      toolkit: 'gmail',
      now: () => startedAt + 2,
    });

    // No Cookie header: the browser-bound secret has expired and disappeared.
    const recovered = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.deepEqual(calls, ['revoke:ca_orphaned', 'authorize:ca_recovered']);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('concurrent stale-grant recovery returns only success or in-progress, never 500', async () => {
  const baseStore = new SqliteConfigStore(':memory:');
  const baseSettings = new SqliteSettingsStore(':memory:');
  let staleDeleteCalls = 0;
  let releaseStaleDeletes!: () => void;
  const staleDeleteBarrier = new Promise<void>((resolve) => {
    releaseStaleDeletes = resolve;
  });
  const delayedSettings = new Proxy(baseSettings as SettingsStore, {
    get(target, property) {
      if (property === 'getSetting') return async (key: string) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return target.getSetting(key);
      };
      if (property === 'applySettingsPatch') return async (
        patch: Parameters<SettingsStore['applySettingsPatch']>[0],
      ) => {
        if (patch.delete && patch.delete.length > 0) {
          staleDeleteCalls += 1;
          if (staleDeleteCalls === 2) releaseStaleDeletes();
          await staleDeleteBarrier;
        }
        return target.applySettingsPatch(patch);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      calls.push('authorize');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/concurrent-recovery'),
        authorizationRef: 'ca_concurrent_recovery',
      };
    },
    async completeAuthorization() {
      return { accountRef: 'ca_concurrent_recovery', toolkit: 'gmail' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke(input) {
      calls.push(`revoke:${input.policy.accountRef}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    },
  };
  const fixture = harness(new FakeTransport(), {
    settings: delayedSettings,
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  }, { store: baseStore, settings: baseSettings });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const startedAt = Date.now() - 40 * 60_000;
    const stale = await beginManagedAuthorization({
      settings: baseSettings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'member',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail',
        label: 'Gmail · Personal',
        principalRef: 'chickpea:membership:membership_test_owner',
        allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
        bindingCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
      },
      now: () => startedAt,
      randomSecret: () => '8'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: baseSettings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: stale.browserSecret,
      authorizationRef: 'ca_stale_concurrent',
      now: () => startedAt + 1,
    });
    await recordManagedAuthorizationAccount({
      settings: baseSettings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: stale.browserSecret,
      accountRef: 'ca_stale_concurrent',
      toolkit: 'gmail',
      now: () => startedAt + 2,
    });
    const start = () => fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    const responses = await Promise.all([start(), start()]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    assert.equal(responses.some(({ status }) => status === 500), false);
    assert.equal(calls.filter((call) => call === 'authorize').length, 1);
    assert.equal(staleDeleteCalls, 2, 'the test must exercise the lost cleanup CAS');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('concurrent same-cookie recovery returns only success or in-progress, never 500', async () => {
  const baseStore = new SqliteConfigStore(':memory:');
  const baseSettings = new SqliteSettingsStore(':memory:');
  let cookieDeleteCalls = 0;
  let releaseCookieDeletes!: () => void;
  const cookieDeleteBarrier = new Promise<void>((resolve) => {
    releaseCookieDeletes = resolve;
  });
  const delayedSettings = new Proxy(baseSettings as SettingsStore, {
    get(target, property) {
      if (property === 'getSetting') return async (key: string) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return target.getSetting(key);
      };
      if (property === 'applySettingsPatch') return async (
        patch: Parameters<SettingsStore['applySettingsPatch']>[0],
      ) => {
        if (patch.delete && patch.delete.length > 0) {
          cookieDeleteCalls += 1;
          if (cookieDeleteCalls === 2) releaseCookieDeletes();
          await cookieDeleteBarrier;
        }
        return target.applySettingsPatch(patch);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      calls.push('authorize');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/cookie-recovery'),
        authorizationRef: 'ca_cookie_recovery',
      };
    },
    async completeAuthorization() {
      return { accountRef: 'ca_cookie_recovery', toolkit: 'gmail' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke(input) {
      calls.push(`revoke:${input.policy.accountRef}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    },
  };
  const fixture = harness(new FakeTransport(), {
    settings: delayedSettings,
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  }, { store: baseStore, settings: baseSettings });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const browserSecret = '7'.repeat(64);
    const started = await beginManagedAuthorization({
      settings: baseSettings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'member',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail',
        label: 'Gmail · Personal',
        principalRef: 'chickpea:membership:membership_test_owner',
        allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
        bindingCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
      },
      randomSecret: () => browserSecret,
    });
    await recordManagedAuthorizationRequest({
      settings: baseSettings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_cookie_orphan',
    });
    await recordManagedAuthorizationAccount({
      settings: baseSettings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret,
      accountRef: 'ca_cookie_orphan',
      toolkit: 'gmail',
    });
    const cookie = `__Secure-chickpea_managed_authorization=${browserSecret}`;
    const start = () => fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST',
        headers: testAdminHeaders(TOKEN, { 'content-type': 'application/json', cookie }),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    const responses = await Promise.all([start(), start()]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    assert.equal(responses.some(({ status }) => status === 500), false);
    assert.equal(calls.filter((call) => call === 'authorize').length, 1);
    assert.deepEqual(
      calls.filter((call) => call === 'revoke:ca_cookie_orphan'),
      ['revoke:ca_cookie_orphan', 'revoke:ca_cookie_orphan'],
    );
    assert.equal(cookieDeleteCalls, 2, 'the test must exercise the lost cookie cleanup CAS');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('a terminal failure on callback retry revokes the durable remote grant and frees the attempt', async () => {
  const calls: string[] = [];
  let validationAttempts = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      calls.push('authorize');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/lk_terminal_retry'),
        authorizationRef: 'ca_terminal_retry',
      };
    },
    async completeAuthorization() {
      calls.push('complete');
      return { accountRef: 'ca_terminal_retry', toolkit: 'gmail' };
    },
    async validate() {
      validationAttempts += 1;
      calls.push(`validate:${validationAttempts}`);
      if (validationAttempts === 1) throw new Error('transient provider lookup failure');
      throw new AuthorizationError();
    },
    async execute() { return { data: {} }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const start = () => fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    const started = await start();
    assert.equal(started.status, 200, await started.clone().text());
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(cookie);
    const callbackUrl =
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Fterminal-retry';

    const failed = await fixture.app.request(callbackUrl, {
      headers: testAdminHeaders(TOKEN, { cookie }),
    });
    assert.equal(failed.status, 303, await failed.clone().text());
    const terminal = await fixture.app.request(callbackUrl, {
      headers: testAdminHeaders(TOKEN, { cookie }),
    });
    assert.equal(terminal.status, 303, await terminal.clone().text());
    assert.match(terminal.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.deepEqual(calls, [
      'authorize', 'complete', 'validate:1', 'validate:2', 'revoke:ca_terminal_retry',
    ]);
    assert.equal((await start()).status, 200, 'terminal cleanup must free the attempt slot');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('team authorization rejects overlap and revokes both allocated and redeemed remote accounts', async () => {
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize(input) {
      calls.push(`authorize:${input.toolkit}`);
      assert.equal(input.principalRef, 'chickpea:organization:org_oss');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/lk_overlap'),
        authorizationRef: 'ca_expected_request',
      };
    },
    async completeAuthorization() {
      calls.push('complete:ca_rejected');
      return { accountRef: 'ca_rejected', toolkit: 'googledrive' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const started = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'team', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    assert.equal(started.status, 200, await started.clone().text());
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(cookie);

    const overlapping = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'team', toolkit: 'googlecalendar', access: 'read',
        }),
      },
    );
    assert.equal(overlapping.status, 409, await overlapping.clone().text());
    assert.deepEqual(await overlapping.json(), {
      error: 'managed_authorization_in_progress',
      message: 'A Google sign-in is already in progress in another browser. Finish that sign-in before starting another.',
    });

    const callback = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Fmismatch',
      { headers: testAdminHeaders(TOKEN, { cookie }) },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      '/admin/agents/agent_support/connections?managed=failed',
    );
    assert.deepEqual(await fixture.store.listConnectionAccounts('T_TEST'), []);
    assert.deepEqual(calls, [
      'authorize:gmail',
      'complete:ca_rejected',
      'revoke:ca_expected_request',
      'revoke:ca_rejected',
    ]);

    const retried = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'team', toolkit: 'googlecalendar', access: 'read',
        }),
      },
    );
    assert.equal(retried.status, 200, await retried.clone().text());
    assert.equal(calls.at(-1), 'authorize:googlecalendar');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('the same browser can replace an abandoned pending managed authorization', async () => {
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize(input) {
      calls.push(input.toolkit);
      return {
        authorizationUrl: new URL(`https://connect.composio.dev/link/${input.toolkit}`),
        authorizationRef: `ca_${input.toolkit}`,
      };
    },
    async completeAuthorization() { return { accountRef: 'ca_unused', toolkit: 'gmail' }; },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const start = (toolkit: string, cookie?: string) => fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST',
        headers: testAdminHeaders(TOKEN, {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        }),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit, access: 'read',
        }),
      },
    );
    const first = await start('gmail');
    assert.equal(first.status, 200, await first.clone().text());
    const cookie = first.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(cookie);

    const replacement = await start('googlecalendar', cookie);
    assert.equal(replacement.status, 200, await replacement.clone().text());
    assert.deepEqual(calls, ['gmail', 'revoke:ca_gmail', 'googlecalendar']);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('a callback without identity verification revokes the pending Connect Link account', async (t) => {
  const calls: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => { errors.push(message); });
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      calls.push('authorize');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/verifier-required'),
        authorizationRef: 'ca_verifier_required',
      };
    },
    async completeAuthorization() {
      calls.push('complete');
      return { accountRef: 'ca_verifier_required', toolkit: 'gmail' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const started = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.equal(started.status, 200, await started.clone().text());
    assert.ok(cookie);

    const callback = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?status=success&connected_account_id=ca_verifier_required',
      { headers: testAdminHeaders(TOKEN, { cookie }) },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      '/admin/agents/agent_support/connections?managed=failed',
    );
    assert.deepEqual(calls, ['authorize', 'revoke:ca_verifier_required']);
    assert.ok(errors.some((message) =>
      message.includes('callback_identity_verifier_unavailable')));
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('managed Google owner lanes allow Team plus Personal and reject duplicates', async () => {
  const calls: string[] = [];
  let nextAccount = 0;
  let completingAccountRef = '';
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize(input) {
      completingAccountRef = `ca_lane_${++nextAccount}`;
      calls.push(`authorize:${input.principalRef}:${input.allowedCapabilities.length}`);
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/access-level'),
        authorizationRef: completingAccountRef,
      };
    },
    async completeAuthorization() {
      calls.push(`complete:${completingAccountRef}`);
      return { accountRef: completingAccountRef, toolkit: 'gmail' };
    },
    async validate(input) {
      calls.push(`validate:${input.policy.accountRef}`);
    },
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const connect = async (
      app: Hono,
      ownerKind: 'team' | 'member',
      access: 'read' | 'write',
      suffix: string,
    ) => {
      const started = await app.request(
        'http://localhost/admin/api/agents/agent_support/connections/managed/start',
        {
          method: 'POST', headers: auth(),
          body: JSON.stringify({
            workspaceId: 'T_TEST', ownerKind, toolkit: 'gmail', access,
          }),
        },
      );
      assert.equal(started.status, 200, await started.clone().text());
      const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
      assert.ok(cookie);
      const callback = await app.request(
        `http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2F${suffix}`,
        { headers: testAdminHeaders(TOKEN, { cookie }) },
      );
      assert.equal(callback.status, 303, await callback.clone().text());
    };

    await connect(fixture.app, 'member', 'read', 'personal');
    const duplicatePersonal = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'write',
        }),
      },
    );
    assert.equal(duplicatePersonal.status, 409, await duplicatePersonal.clone().text());
    assert.equal((await duplicatePersonal.json() as { error: string }).error,
      'managed_connection_already_attached');

    const bobPrincipal: AuthPrincipal = {
      userId: 'user_test_bob',
      membershipId: 'membership_test_bob',
      organizationId: 'org_oss',
      role: 'admin',
      authenticatorKind: 'test_slack_session',
      credentialId: 'session_test_bob',
      correlationId: 'request_test_bob',
      machine: false,
    };
    const bobFixture = harness(
      new FakeTransport(),
      { managedConnectionProviders: createManagedConnectionProviderRegistry([provider]) },
      { store: fixture.store, settings: fixture.settings },
      bobPrincipal,
    );
    await connect(bobFixture.app, 'member', 'write', 'bob-personal');
    await connect(fixture.app, 'team', 'read', 'team');
    const accounts = await fixture.store.listConnectionAccounts('T_TEST');
    assert.deepEqual(accounts.map(({ label }) => label).sort(), [
      'Gmail · Personal', 'Gmail · Personal', 'Gmail · Team',
    ]);
    assert.equal((await fixture.store.listAgentConnectionBindings('agent_support')).length, 3);
    assert.deepEqual(calls, [
      'authorize:chickpea:membership:membership_test_owner:2',
      'complete:ca_lane_1',
      'validate:ca_lane_1',
      'authorize:chickpea:membership:membership_test_bob:4',
      'complete:ca_lane_2',
      'validate:ca_lane_2',
      'authorize:chickpea:organization:org_oss:2',
      'complete:ca_lane_3',
      'validate:ca_lane_3',
    ]);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('a competing owner lane at callback revokes the newly authorized remote account', async () => {
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      calls.push('authorize:ca_callback_race');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/callback-race'),
        authorizationRef: 'ca_callback_race',
      };
    },
    async completeAuthorization() {
      calls.push('complete:ca_callback_race');
      return { accountRef: 'ca_callback_race', toolkit: 'gmail' };
    },
    async validate(input) { calls.push(`validate:${input.policy.accountRef}`); },
    async execute() { return { data: {} }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const started = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    assert.equal(started.status, 200, await started.clone().text());
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.ok(cookie);

    const competing = await fixture.store.putConnectionAccount({
      id: 'connection_competing_lane',
      workspaceId: 'T_TEST', ownerKind: 'member',
      ownerMembershipId: 'membership_test_owner',
      createdByMembershipId: 'membership_test_owner',
      providerId: 'google', label: 'Existing Personal Gmail',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:membership:membership_test_owner',
        accountRef: 'ca_competing_lane',
        allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
      },
      secretRefId: 'secret_competing_lane', lifecycle: 'ready',
    }, 0);
    await fixture.store.putAgentConnectionBinding({
      agentId: 'agent_support', connectionAccountId: competing.id, providerId: 'google',
      allowedCapabilities: ['gmail.messages.search'], enabled: true,
    });

    const callback = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Fcallback-race',
      { headers: testAdminHeaders(TOKEN, { cookie }) },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      '/admin/agents/agent_support/connections?managed=failed',
    );
    const activeManagedRefs = (await fixture.store.listConnectionAccounts('T_TEST'))
      .filter(({ lifecycle }) => lifecycle !== 'revoked')
      .flatMap((account) => account.policy.kind === 'managed' ? [account.policy.accountRef] : []);
    assert.deepEqual(activeManagedRefs, ['ca_competing_lane']);
    assert.deepEqual(calls, [
      'authorize:ca_callback_race',
      'complete:ca_callback_race',
      'revoke:ca_callback_race',
    ]);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('callback compensation revokes a fresh import when binding persistence fails', async () => {
  const baseStore = new SqliteConfigStore(':memory:');
  const baseSettings = new SqliteSettingsStore(':memory:');
  let failNextBinding = false;
  const failingStore = new Proxy(baseStore as ConfigStore, {
    get(target, property) {
      if (property === 'putAgentConnectionBinding') return async (
        input: Parameters<ConfigStore['putAgentConnectionBinding']>[0],
      ) => {
        if (failNextBinding) {
          failNextBinding = false;
          throw new Error('injected binding persistence failure');
        }
        return target.putAgentConnectionBinding(input);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      calls.push('authorize');
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/fresh-compensation'),
        authorizationRef: 'ca_fresh_compensation',
      };
    },
    async completeAuthorization() {
      calls.push('complete');
      return { accountRef: 'ca_fresh_compensation', toolkit: 'gmail' };
    },
    async validate(input) { calls.push(`validate:${input.policy.accountRef}`); },
    async execute() { return { data: {} }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const fixture = harness(new FakeTransport(), {
    store: failingStore,
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  }, { store: baseStore, settings: baseSettings });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const started = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read',
        }),
      },
    );
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.equal(started.status, 200, await started.clone().text());
    assert.ok(cookie);
    failNextBinding = true;
    const callback = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Ffresh-compensation',
      { headers: testAdminHeaders(TOKEN, { cookie }) },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    const compensated = (await fixture.store.listConnectionAccounts('T_TEST')).find(
      (account) => account.policy.kind === 'managed' &&
        account.policy.accountRef === 'ca_fresh_compensation',
    );
    assert.equal(compensated?.lifecycle, 'revoked');
    assert.deepEqual(await fixture.store.listAgentConnectionBindings('agent_support'), []);
    assert.deepEqual(calls, [
      'authorize', 'complete', 'validate:ca_fresh_compensation',
      'revoke:ca_fresh_compensation',
    ]);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('callback compensation restores a known account when a new binding fails', async () => {
  const baseStore = new SqliteConfigStore(':memory:');
  const baseSettings = new SqliteSettingsStore(':memory:');
  let failNextBinding = false;
  const failingStore = new Proxy(baseStore as ConfigStore, {
    get(target, property) {
      if (property === 'putAgentConnectionBinding') return async (
        input: Parameters<ConfigStore['putAgentConnectionBinding']>[0],
      ) => {
        if (failNextBinding) {
          failNextBinding = false;
          throw new Error('injected binding persistence failure');
        }
        return target.putAgentConnectionBinding(input);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize(input) {
      calls.push(`authorize:${input.allowedCapabilities.length}`);
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/known-compensation'),
        authorizationRef: 'ca_known_compensation',
      };
    },
    async completeAuthorization() {
      calls.push('complete');
      return { accountRef: 'ca_known_compensation', toolkit: 'gmail' };
    },
    async validate(input) {
      calls.push(`validate:${input.policy.accountRef}:${input.policy.allowedCapabilities.length}`);
    },
    async execute() { return { data: {} }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const fixture = harness(new FakeTransport(), {
    store: failingStore,
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  }, { store: baseStore, settings: baseSettings });
  try {
    await createAgent(fixture.app);
    await fixture.store.createAgent({
      id: 'agent_archive', name: 'Archive', instructions: 'Archive mail.', enabled: true,
      creatorMembershipId: 'membership_test_owner', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const original = await fixture.store.putConnectionAccount({
      id: 'connection_known_compensation',
      workspaceId: 'T_TEST', ownerKind: 'member',
      ownerMembershipId: 'membership_test_owner',
      createdByMembershipId: 'membership_test_owner',
      providerId: 'google', label: 'Known Personal Gmail',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:membership:membership_test_owner',
        accountRef: 'ca_known_compensation',
        allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
      },
      secretRefId: 'secret_known_compensation', lifecycle: 'ready',
    }, 0);
    await fixture.store.putAgentConnectionBinding({
      agentId: 'agent_archive', connectionAccountId: original.id, providerId: 'google',
      allowedCapabilities: ['gmail.messages.search'], enabled: true,
    });
    const prior = await fixture.store.putConnectionAccount(
      { ...original, lifecycle: 'needs_attention' },
      original.revision,
    );

    const started = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/start',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'write',
        }),
      },
    );
    const cookie = started.headers.get('set-cookie')?.match(/^[^;]+/)?.[0];
    assert.equal(started.status, 200, await started.clone().text());
    assert.ok(cookie);
    failNextBinding = true;
    const callback = await fixture.app.request(
      'http://localhost/admin/connections/composio/callback?session_uri=session%3A%2F%2Fknown-compensation',
      { headers: testAdminHeaders(TOKEN, { cookie }) },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    const restored = (await fixture.store.listConnectionAccounts('T_TEST')).find(
      ({ id }) => id === prior.id,
    );
    assert.equal(restored?.lifecycle, 'needs_attention');
    assert.deepEqual(
      restored?.policy.kind === 'managed' ? restored.policy.allowedCapabilities : [],
      ['gmail.profile.read', 'gmail.messages.search'],
    );
    assert.equal(
      (await fixture.store.listAgentConnectionBindings('agent_archive'))[0]?.enabled,
      true,
    );
    assert.deepEqual(await fixture.store.listAgentConnectionBindings('agent_support'), []);
    assert.deepEqual(calls, [
      'authorize:4',
      'complete',
      'validate:ca_known_compensation:4',
    ]);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('reusable MCP OAuth accounts start and complete against the account reference', async () => {
  let accountId = '';
  let startedInput: StartMcpOAuthInput | undefined;
  const fixture = harness(new FakeTransport(), {
    startMcpOAuth: async (input) => {
      startedInput = input;
      return {
        authorizationUrl: new URL('https://linear.example.test/oauth?state=opaque'),
        state: 'opaque',
      };
    },
    completeMcpOAuth: async () => ({
      ref: { agentId: accountId, connectionId: 'account' },
      ...(startedInput?.accountRevision !== undefined
        ? { accountRevision: startedInput.accountRevision }
        : {}),
      ...(startedInput?.oauthAttemptId ? { oauthAttemptId: startedInput.oauthAttemptId } : {}),
      returnAgentId: 'agent_support',
    }),
    resolveMcpOAuthToken: async () => 'oauth-access-token',
    discoverMcp: async (input) => {
      assert.equal(input.headers.Authorization, 'Bearer oauth-access-token');
      return { tools: [{ name: 'search_issues' }, { name: 'create_issue' }] };
    },
    identifyMcp: async () => ({ workspaceName: 'Acme Linear', accountName: 'Owner' }),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const created = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'team', providerId: 'linear', label: 'Linear',
          allowedCapabilities: [],
          mcp: {
            id: 'linear', displayName: 'Linear', url: 'https://mcp.linear.app/mcp',
            transport: 'streamable-http', authMode: 'oauth', headerNames: [], enabled: true,
            lifecycleStatus: 'pending', statusText: '', discoveredTools: [], allowedTools: [],
            oauthScope: 'read write', presetId: 'linear',
          },
        }),
      },
    );
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await created.json() as Record<string, any>;
    accountId = createdBody.account.id;
    assert.equal(createdBody.account.lifecycle, 'needs_attention');

    const started = await fixture.app.request(
      `http://localhost/admin/api/agents/agent_support/connections/${accountId}/oauth/mcp/start`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(started.status, 200, await started.clone().text());
    assert.deepEqual(startedInput?.ref, { agentId: accountId, connectionId: 'account' });
    assert.equal(startedInput?.returnAgentId, 'agent_support');
    assert.equal(typeof startedInput?.accountRevision, 'number');
    assert.match(
      startedInput?.oauthAttemptId ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const callback = await fixture.app.request(
      'http://localhost/oauth/callback?state=opaque&code=accepted',
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      `/admin/agents/agent_support?oauth=connected&connection=${encodeURIComponent(accountId)}&lane=mcp`,
    );
    const account = (await fixture.store.listConnectionAccounts('T_TEST'))
      .find((candidate) => candidate.id === accountId);
    assert.equal(account?.lifecycle, 'ready');
    assert.deepEqual(account?.identity, { workspaceName: 'Acme Linear', accountName: 'Owner' });
    assert.deepEqual(
      account?.policy.kind === 'mcp' ? account.policy.allowedTools : [],
      ['search_issues', 'create_issue'],
    );

    const oauthKeys = mcpOAuthSettingKeys(connectionAccountOAuthRef(accountId));
    await Promise.all(oauthKeys.map((key, index) => fixture.settings.setSetting(key, `secret-${index}`)));
    const revoked = await fixture.app.request(
      `http://localhost/admin/api/connections/${accountId}/revoke`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.deepEqual(await fixture.settings.getSettings(oauthKeys), oauthKeys.map(() => undefined));
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST')).find((candidate) => candidate.id === accountId)?.lifecycle,
      'revoked',
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('revoking during reusable MCP OAuth verification cannot reactivate the account', async () => {
  let accountId = '';
  let releaseDiscovery: (() => void) | undefined;
  let markDiscoveryStarted: (() => void) | undefined;
  const discoveryStarted = new Promise<void>((resolve) => { markDiscoveryStarted = resolve; });
  const discoveryReleased = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
  const fixture = harness(new FakeTransport(), {
    startMcpOAuth: async () => ({
      authorizationUrl: new URL('https://linear.example.test/oauth?state=opaque'),
      state: 'opaque',
    }),
    completeMcpOAuth: async () => ({
      ref: { agentId: accountId, connectionId: 'account' },
      returnAgentId: 'agent_support',
    }),
    resolveMcpOAuthToken: async () => 'oauth-access-token',
    discoverMcp: async () => {
      markDiscoveryStarted?.();
      await discoveryReleased;
      return { tools: [{ name: 'search_issues' }] };
    },
    identifyMcp: async () => ({ workspaceName: 'Acme Linear', accountName: 'Owner' }),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const created = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'team', providerId: 'linear', label: 'Linear',
          allowedCapabilities: [],
          mcp: {
            id: 'linear', displayName: 'Linear', url: 'https://mcp.linear.app/mcp',
            transport: 'streamable-http', authMode: 'oauth', headerNames: [], enabled: true,
            lifecycleStatus: 'pending', statusText: '', discoveredTools: [], allowedTools: [],
            oauthScope: 'read write', presetId: 'linear',
          },
        }),
      },
    );
    accountId = ((await created.json()) as Record<string, any>).account.id;
    const started = await fixture.app.request(
      `http://localhost/admin/api/agents/agent_support/connections/${accountId}/oauth/mcp/start`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(started.status, 200, await started.clone().text());

    const callbackPromise = fixture.app.request(
      'http://localhost/oauth/callback?state=opaque&code=accepted',
    );
    await discoveryStarted;
    const revoked = await fixture.app.request(
      `http://localhost/admin/api/connections/${accountId}/revoke`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
    releaseDiscovery?.();

    const callback = await callbackPromise;
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      `/admin/agents/agent_support?oauth=verification_failed&connection=${encodeURIComponent(accountId)}&lane=mcp`,
    );
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST')).find((candidate) => candidate.id === accountId)?.lifecycle,
      'revoked',
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('reusable API OAuth accounts return to the initiating Agent and become ready', async () => {
  let accountId = '';
  let startedInput: {
    ref: { agentId: string; connectionId: string };
    provider: string;
    scopes: readonly string[];
    returnAgentId?: string;
    accountRevision?: number;
    oauthAttemptId?: string;
  } | undefined;
  const fixture = harness(new FakeTransport(), {
    startApiOAuth: async (input) => {
      startedInput = input;
      return {
        authorizationUrl: new URL('https://accounts.google.com/o/oauth2/v2/auth?state=opaque'),
        state: 'opaque',
      };
    },
    completeApiOAuth: async () => ({
      ref: { agentId: accountId, connectionId: 'account' },
      provider: 'google',
      identity: { accountName: 'operator@acme.test' },
      ...(startedInput?.accountRevision !== undefined
        ? { accountRevision: startedInput.accountRevision }
        : {}),
      ...(startedInput?.oauthAttemptId ? { oauthAttemptId: startedInput.oauthAttemptId } : {}),
      returnAgentId: 'agent_support',
    }),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const created = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'team', providerId: 'google', label: 'Work Gmail',
          allowedCapabilities: [],
          api: {
            id: 'google-workspace', displayName: 'Work Gmail',
            allowedHosts: ['gmail.googleapis.com'], pathPrefixes: ['/gmail/v1/users/me'],
            headerName: 'Authorization', headerValuePrefix: 'Bearer ',
            allowedMethods: ['GET', 'HEAD'], enabled: true,
            authMode: 'oauth', oauthProvider: 'google',
            oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            oauthAppType: 'external', lifecycleStatus: 'pending', statusText: '',
            presetId: 'google-workspace',
          },
        }),
      },
    );
    assert.equal(created.status, 201, await created.clone().text());
    accountId = ((await created.json()) as Record<string, any>).account.id;

    const client = await fixture.app.request(
      `http://localhost/admin/api/agents/agent_support/connections/${accountId}/oauth/api/client`,
      {
        method: 'PUT', headers: auth(),
        body: JSON.stringify({
          provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret',
        }),
      },
    );
    assert.equal(client.status, 200, await client.clone().text());
    const started = await fixture.app.request(
      `http://localhost/admin/api/agents/agent_support/connections/${accountId}/oauth/api/start`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(started.status, 200, await started.clone().text());
    assert.deepEqual(startedInput?.ref, { agentId: accountId, connectionId: 'account' });
    assert.equal(startedInput?.provider, 'google');
    assert.deepEqual(startedInput?.scopes, ['https://www.googleapis.com/auth/gmail.readonly']);
    assert.equal(startedInput?.returnAgentId, 'agent_support');
    assert.equal(typeof startedInput?.accountRevision, 'number');
    assert.match(
      startedInput?.oauthAttemptId ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const callback = await fixture.app.request(
      'http://localhost/oauth/api/callback?state=opaque&code=accepted',
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      `/admin/agents/agent_support?oauth=connected&connection=${encodeURIComponent(accountId)}&lane=api`,
    );
    const account = (await fixture.store.listConnectionAccounts('T_TEST'))
      .find((candidate) => candidate.id === accountId);
    assert.equal(account?.lifecycle, 'ready');
    assert.deepEqual(account?.identity, { accountName: 'operator@acme.test' });
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('reusable OAuth exchange failures return to the initiating Agent', async () => {
  const mcpRef = { agentId: 'connection_linear_failed', connectionId: 'account' };
  const apiRef = { agentId: 'connection_google_failed', connectionId: 'account' };
  const fixture = harness(new FakeTransport(), {
    completeMcpOAuth: async () => {
      throw new McpOAuthError('oauth_unavailable', 'exchange failed', {
        callbackContext: { ref: mcpRef, returnAgentId: 'agent_support' },
      });
    },
    completeApiOAuth: async () => {
      throw new ApiOAuthError('oauth_unavailable', 'exchange failed', {
        callbackContext: { ref: apiRef, returnAgentId: 'agent_support' },
      });
    },
  });
  try {
    const mcpCallback = await fixture.app.request(
      'http://localhost/oauth/callback?state=opaque&code=rejected',
    );
    assert.equal(mcpCallback.status, 303, await mcpCallback.clone().text());
    assert.equal(
      mcpCallback.headers.get('location'),
      '/admin/agents/agent_support?oauth=failed&connection=connection_linear_failed&lane=mcp',
    );

    const apiCallback = await fixture.app.request(
      'http://localhost/oauth/api/callback?state=opaque&code=rejected',
    );
    assert.equal(apiCallback.status, 303, await apiCallback.clone().text());
    assert.equal(
      apiCallback.headers.get('location'),
      '/admin/agents/agent_support?oauth=failed&connection=connection_google_failed&lane=api',
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('revoking a reusable API OAuth account deletes its client and token settings', async () => {
  const fixture = harness();
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const created = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({
          workspaceId: 'T_TEST', ownerKind: 'team', providerId: 'google', label: 'Work Gmail',
          allowedCapabilities: [],
          api: {
            id: 'google-workspace', displayName: 'Work Gmail',
            allowedHosts: ['gmail.googleapis.com'], pathPrefixes: ['/gmail/v1/users/me'],
            headerName: 'Authorization', headerValuePrefix: 'Bearer ',
            allowedMethods: ['GET', 'HEAD'], enabled: true,
            authMode: 'oauth', oauthProvider: 'google',
            oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            oauthAppType: 'external', lifecycleStatus: 'pending', statusText: '',
            presetId: 'google-workspace',
          },
        }),
      },
    );
    assert.equal(created.status, 201, await created.clone().text());
    const accountId = ((await created.json()) as Record<string, any>).account.id as string;
    const oauthKeys = apiOAuthSettingKeys(connectionAccountOAuthRef(accountId));
    await Promise.all(oauthKeys.map((key, index) => fixture.settings.setSetting(key, `secret-${index}`)));

    const revoked = await fixture.app.request(
      `http://localhost/admin/api/connections/${accountId}/revoke`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.deepEqual(await fixture.settings.getSettings(oauthKeys), oauthKeys.map(() => undefined));
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
