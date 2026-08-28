import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';
import { PhotonImage } from '@cf-wasm/photon';
import * as v from 'valibot';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
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
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  disableStoredComposioConfiguration,
  recordComposioPreparationResult,
  resolveComposioConfiguration,
  saveStoredComposioProjectKey,
} from '../src/config/composio-settings.ts';
import type { ComposioClientLike } from '../src/connections/providers/composio.ts';
import {
  createManagedConnectionProviderRegistry,
  resolveDefaultManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import {
  createManagedConnectorCatalog,
  type ManagedConnectorDefinition,
} from '../src/connections/catalog/index.ts';
import {
  ManagedAuthorizationAllocatedError,
  ManagedProviderRequestError,
} from '../src/connections/managed-errors.ts';
import {
  beginManagedAuthorization,
  recordManagedAuthorizationRequest,
} from '../src/connections/managed-authorization.ts';

const TOKEN = 'agent-admin-token';

function auth(): HeadersInit {
  return testAdminHeaders(TOKEN, { 'content-type': 'application/json' });
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
  lookupError?: Error;

  async getWorkspaceInfo(): Promise<{ teamId: string; teamName?: string }> {
    return { teamId: 'T_TEST', teamName: 'Acme Inc' };
  }

  async lookupMember(userId: string): Promise<SlackMember> {
    if (this.lookupError) throw this.lookupError;
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
  async lookupUserGroup(userGroupId: string): Promise<SlackUserGroup | undefined> {
    return this.groups.find((group) => group.id === userGroupId);
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

test('shared Slack connection test requires inbound session health even when outbound Slack succeeds', async () => {
  const fixture = harness();
  let inboundHealthy = false;
  let statusCalls = 0;
  let restartCalls = 0;
  const env = {
    SLACK_GATEWAY_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({
        restart: async () => {
          restartCalls += 1;
        },
        status: async () => {
          statusCalls += 1;
          return {
            healthy: inboundHealthy,
            phase: inboundHealthy ? 'healthy' : 'retrying',
            detail: inboundHealthy ? null : 'gateway_session_offline',
            generation: 3,
          };
        },
      }),
    },
  };
  try {
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST',
      teamId: 'T_TEST',
      transportMode: 'gateway',
      appId: 'A_TEST',
      botUserId: 'U_BOT',
      gatewayBindingId: 'binding_test',
    });

    const offline = await fixture.app.request(
      'http://localhost/admin/api/slack-connection/test',
      { method: 'POST', headers: auth(), body: '{}' },
      env,
    );
    assert.equal(offline.status, 502);
    assert.deepEqual(await offline.json(), {
      error: 'slack_gateway_unreachable',
      detail: 'gateway_session_offline',
    });
    assert.equal(statusCalls, 2);
    assert.equal(restartCalls, 1);
    assert.equal((await fixture.store.getWorkspaceInstallation('T_TEST'))?.health, 'needs_attention');
    assert.equal(
      (await fixture.store.getWorkspaceInstallation('T_TEST'))?.healthDetail,
      'gateway_session_offline',
    );

    inboundHealthy = true;
    const recovered = await fixture.app.request(
      'http://localhost/admin/api/slack-connection/test',
      { method: 'POST', headers: auth(), body: '{}' },
      env,
    );
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as { ok: boolean }).ok, true);
    assert.equal(statusCalls, 3);
    assert.equal(restartCalls, 1);
    assert.equal((await fixture.store.getWorkspaceInstallation('T_TEST'))?.health, 'healthy');
    assert.equal(
      (await fixture.store.getWorkspaceInstallation('T_TEST'))?.healthDetail ?? null,
      null,
    );

    inboundHealthy = false;
    fixture.transport.lookupError = new SlackTransportError(
      'users.info',
      'gateway_binding_mismatch',
    );
    const reconnect = await fixture.app.request(
      'http://localhost/admin/api/slack-connection/test',
      { method: 'POST', headers: auth(), body: '{}' },
      env,
    );
    assert.equal(reconnect.status, 502);
    assert.deepEqual(await reconnect.json(), {
      error: 'slack_gateway_unreachable',
      detail: 'gateway_binding_mismatch',
    });
    assert.equal(
      (await fixture.store.getWorkspaceInstallation('T_TEST'))?.healthDetail,
      'gateway_binding_mismatch',
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('shared Slack connection test rejects a healthy session from an older Worker version', async () => {
  const fixture = harness();
  let gatewayVersion = 'old-version';
  let restartCalls = 0;
  const env = {
    CF_VERSION_METADATA: { id: 'current-version' },
    SLACK_GATEWAY_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({
        restart: async () => {
          restartCalls += 1;
        },
        status: async () => ({
          healthy: true,
          phase: 'healthy',
          detail: null,
          generation: 7,
          versionId: gatewayVersion,
        }),
      }),
    },
  };
  try {
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST',
      teamId: 'T_TEST',
      transportMode: 'gateway',
      appId: 'A_TEST',
      botUserId: 'U_BOT',
      gatewayBindingId: 'binding_test',
    });

    const stale = await fixture.app.request(
      'http://localhost/admin/api/slack-connection/test',
      { method: 'POST', headers: auth(), body: '{}' },
      env,
    );
    assert.equal(stale.status, 502);
    assert.deepEqual(await stale.json(), {
      error: 'slack_gateway_unreachable',
      detail: 'gateway_session_stale_version',
    });
    assert.equal(restartCalls, 1);
    assert.equal(
      (await fixture.store.getWorkspaceInstallation('T_TEST'))?.healthDetail,
      'gateway_session_stale_version',
    );

    gatewayVersion = 'current-version';
    const current = await fixture.app.request(
      'http://localhost/admin/api/slack-connection/test',
      { method: 'POST', headers: auth(), body: '{}' },
      env,
    );
    assert.equal(current.status, 200);
    assert.equal((await current.json() as { ok: boolean }).ok, true);
    assert.equal(restartCalls, 1);
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

function composioSetupClient(): ComposioClientLike {
  const configs = new Map<string, {
    id: string;
    name: string;
    toolkit: { slug: string };
    status: string;
    isComposioManaged: boolean;
    credentials: Record<string, never>;
    restrictToFollowingTools: string[];
  }>();
  return {
    authConfigs: {
      async list(query) {
        return {
          items: [...configs.values()].filter((item) =>
            !query?.toolkit || item.toolkit.slug === query.toolkit),
          nextCursor: null,
          totalPages: 1,
        };
      },
      async create(toolkit, input) {
        const id = `ac_${toolkit}_default`;
        configs.set(toolkit, {
          id,
          name: input.name,
          toolkit: { slug: toolkit },
          status: 'ENABLED',
          isComposioManaged: true,
          credentials: {},
          restrictToFollowingTools: [],
        });
        return { id, authScheme: 'OAUTH2', isComposioManaged: true, toolkit };
      },
    },
    sessions: {
      async create() { throw new Error('sessions are unused during setup'); },
    },
  };
}

test('owner setup is write-only, returns Agent continuation, and disable reconciliation resumes', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = {
    store: settings,
    keyring: generateCredentialKeyring('admin_route_composio'),
  };
  const client = composioSetupClient();
  const fixture = harness(new FakeTransport(), {
    composioConfiguration: { credentials },
    composioCreateClient: async () => client,
  }, { settings });
  const sentinel = 'ak_route_secret_must_never_echo_123456789';
  try {
    await createAgent(fixture.app);
    const response = await fixture.app.request(
      'http://localhost/admin/api/settings/connectors/composio/setup',
      {
        method: 'POST', headers: auth(), body: JSON.stringify({
          projectKey: sentinel,
          continuation: { agentId: 'agent_support', toolkit: 'gmail' },
        }),
      },
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(sentinel), false);
    const body = JSON.parse(text) as {
      provider: { configured: boolean; reconciliationPending: boolean };
      continuation: { agentId: string; toolkit: string; action: string };
    };
    assert.equal(body.provider.configured, true);
    assert.deepEqual(body.continuation, {
      agentId: 'agent_support', toolkit: 'gmail', action: 'authorize',
    });
    assert.equal((await settings.getSetting('managed.composio.configuration'))?.includes(sentinel), false);

    await disableStoredComposioConfiguration({ settings, credentials });
    assert.equal(
      JSON.parse((await settings.getSetting('managed.composio.configuration'))!).reconciliationPending,
      true,
    );
    const status = await fixture.app.request(
      'http://localhost/admin/api/settings/connectors/composio',
      { headers: auth() },
    );
    assert.equal(status.status, 200);
    const statusBody = await status.json() as {
      provider: { desiredState: string; reconciliationPending: boolean };
    };
    assert.equal(statusBody.provider.desiredState, 'disabled');
    assert.equal(statusBody.provider.reconciliationPending, true);

    const retry = await fixture.app.request(
      'http://localhost/admin/api/settings/connectors/composio/retry',
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(retry.status, 409);
    assert.deepEqual(await retry.json(), {
      error: 'composio_configuration_missing',
      message: 'Add a Composio project key before preparing managed connectors.',
    });
    const reconciled = await fixture.app.request(
      'http://localhost/admin/api/settings/connectors/composio',
      { headers: auth() },
    );
    assert.equal(reconciled.status, 200);
    const reconciledBody = await reconciled.json() as {
      provider: { reconciliationPending: boolean };
    };
    assert.equal(reconciledBody.provider.reconciliationPending, false);
  } finally {
    fixture.store.close();
    settings.close();
  }
});

test('setup shares one request deadline and reports a saved key when preparation exhausts it', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = {
    store: settings,
    keyring: generateCredentialKeyring('admin_route_composio_preparation_timeout'),
  };
  const validationClient = composioSetupClient();
  let clientCreations = 0;
  const fixture = harness(new FakeTransport(), {
    composioConfiguration: { credentials },
    composioPreparationTimeoutMs: 50,
    composioCreateClient: async () => {
      clientCreations += 1;
      if (clientCreations === 1) return validationClient;
      return {
        authConfigs: {
          async list(_query, requestOptions) {
            const signal = requestOptions?.signal;
            assert.ok(signal);
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            assert.fail('aborted preparation must not return a list');
          },
          async create() {
            assert.fail('timed-out preparation must not create an auth config');
          },
        },
        sessions: {
          async create() { throw new Error('sessions are unused during setup'); },
        },
      };
    },
  }, { settings });
  const sentinel = 'ak_saved_before_preparation_timeout';
  try {
    const response = await fixture.app.request(
      'http://localhost/admin/api/settings/connectors/composio/setup',
      {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ projectKey: sentinel }),
      },
    );
    assert.equal(response.status, 503, await response.clone().text());
    assert.deepEqual(await response.json(), {
      error: 'composio_setup_unavailable',
      message: 'The key was saved, but managed connectors could not be prepared. Retry setup.',
    });
    assert.equal(clientCreations, 2);
    assert.equal(
      (await resolveComposioConfiguration({ settings, credentials })).apiKey,
      sentinel,
    );
  } finally {
    fixture.store.close();
    settings.close();
  }
});

test('managed reconciliation uses one aggregate admin-request deadline', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = {
    store: settings,
    keyring: generateCredentialKeyring('admin_route_reconciliation_deadline'),
  };
  const fixture = harness(new FakeTransport(), {
    composioConfiguration: { credentials },
    composioReconciliationTimeoutMs: 5,
    composioInspectAccount: async () => new Promise(() => undefined),
  }, { settings });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    await fixture.store.putConnectionAccount({
      id: 'connection_reconciliation_deadline', workspaceId: 'T_TEST', ownerKind: 'team',
      createdByMembershipId: 'membership_test_owner', providerId: 'google',
      label: 'Gmail', lifecycle: 'ready', secretRefId: 'secret_reconciliation_deadline',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:organization:org_oss', accountRef: 'ca_reconciliation_deadline',
        allowedCapabilities: ['gmail.profile.read'],
      },
    }, 0);
    await saveStoredComposioProjectKey('ak_reconciliation_deadline', {
      settings,
      credentials,
    });
    const configuration = JSON.parse(
      (await settings.getSetting('managed.composio.configuration'))!,
    ) as Record<string, unknown>;
    await settings.setSetting('managed.composio.configuration', JSON.stringify({
      ...configuration,
      reconciliationPending: true,
    }));

    const startedAt = Date.now();
    const response = await fixture.app.request(
      'http://localhost/admin/api/settings/connectors/composio/retry',
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(response.status, 503, await response.clone().text());
    assert.ok(Date.now() - startedAt < 500);
    assert.deepEqual(await response.json(), {
      error: 'composio_reconciliation_incomplete',
      message: 'Chickpea is still reconciling managed accounts. Try again shortly.',
    });
  } finally {
    fixture.store.close();
    settings.close();
  }
});

test('managed reconciliation uses the production account inspector across a full key rotation', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = {
    store: settings,
    keyring: generateCredentialKeyring('admin_route_reconciliation_batches'),
  };
  let inspections = 0;
  t.mock.method(globalThis, 'fetch', async (
    input: string | URL | Request,
  ) => {
    const url = new URL(String(input));
    assert.equal(
      `${url.origin}${url.pathname}`,
      'https://backend.composio.dev/api/v3.1/connected_accounts',
    );
    const accountRef = url.searchParams.get('connected_account_ids');
    const principalRef = url.searchParams.get('user_ids');
    assert.ok(accountRef);
    assert.equal(principalRef, 'chickpea:organization:org_oss');
    inspections += 1;
    return Response.json({
      items: [{
        id: accountRef,
        status: 'ACTIVE',
        is_disabled: false,
        toolkit: { slug: 'gmail' },
        user_id: principalRef,
      }],
    });
  });
  const fixture = harness(new FakeTransport(), {
    composioConfiguration: { credentials },
    composioCreateClient: async () => composioSetupClient(),
  }, { settings });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const initial = await saveStoredComposioProjectKey(
      'ak_reconciliation_batches_initial',
      { settings, credentials },
    );
    assert.ok(initial.keyFingerprint);
    for (let index = 0; index < 26; index += 1) {
      await fixture.store.putConnectionAccount({
        id: `connection_reconciliation_batch_${index}`,
        workspaceId: 'T_TEST', ownerKind: 'team',
        createdByMembershipId: 'membership_test_owner', providerId: 'google',
        label: `Gmail ${index}`, lifecycle: 'ready',
        secretRefId: `secret_reconciliation_batch_${index}`,
        policy: {
          kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
          principalRef: 'chickpea:organization:org_oss',
          accountRef: `ca_reconciliation_batch_${index}`,
          allowedCapabilities: ['gmail.profile.read'],
          providerGeneration: initial.generation,
          providerLineage: initial.keyFingerprint,
        },
      }, 0);
    }
    const replacement = await saveStoredComposioProjectKey(
      'ak_reconciliation_batches_replacement',
      { settings, credentials },
    );
    assert.equal(replacement.reconciliationPending, true);

    const response = await fixture.app.request(
      'http://localhost/admin/api/settings/connectors/composio/retry',
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as {
      provider: { reconciliationPending: boolean };
    };
    assert.equal(body.provider.reconciliationPending, false);
    assert.equal(inspections, 26);
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST')).every((account) =>
        account.policy.kind === 'managed' &&
        account.policy.providerGeneration === replacement.generation &&
        account.policy.providerLineage === replacement.keyFingerprint),
      true,
    );
    const registry = await resolveDefaultManagedConnectionProviderRegistry(undefined, {
      settings,
      credentials,
    });
    assert.ok(registry.get('composio'));
  } finally {
    fixture.store.close();
    settings.close();
  }
});

test('deployment key rotation reconciles existing accounts before reactivating the provider', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  const firstEnv = {
    CHICKPEA_COMPOSIO_CONFIGURATION_MODE: 'deployment',
    COMPOSIO_API_KEY: 'ak_deployment_rotation_first',
  };
  const rotatedEnv = {
    CHICKPEA_COMPOSIO_CONFIGURATION_MODE: 'deployment',
    COMPOSIO_API_KEY: 'ak_deployment_rotation_second',
  };
  let inspections = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(
      `${url.origin}${url.pathname}`,
      'https://backend.composio.dev/api/v3.1/connected_accounts',
    );
    const accountRef = url.searchParams.get('connected_account_ids');
    const principalRef = url.searchParams.get('user_ids');
    assert.ok(accountRef);
    assert.equal(principalRef, 'chickpea:organization:org_oss');
    inspections += 1;
    return Response.json({
      items: [{
        id: accountRef,
        status: 'ACTIVE',
        is_disabled: false,
        toolkit: { slug: 'gmail' },
        user_id: principalRef,
      }],
    });
  });
  const fixture = harness(new FakeTransport(), {
    composioCreateClient: async () => composioSetupClient(),
  }, { settings });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    await recordComposioPreparationResult({
      expectedGeneration: 1,
      authConfigIds: { gmail: { read: 'ac_deployment_rotation_first' } },
      status: 'ready',
      completedAt: 1_900_000_000_100,
    }, { env: firstEnv, settings });
    const first = await resolveComposioConfiguration({ env: firstEnv, settings });
    assert.ok(first.keyFingerprint);
    for (let index = 0; index < 2; index += 1) {
      await fixture.store.putConnectionAccount({
        id: `connection_deployment_rotation_${index}`,
        workspaceId: 'T_TEST', ownerKind: 'team',
        createdByMembershipId: 'membership_test_owner', providerId: 'google',
        label: `Deployment Gmail ${index}`, lifecycle: 'ready',
        secretRefId: `secret_deployment_rotation_${index}`,
        policy: {
          kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
          principalRef: 'chickpea:organization:org_oss',
          accountRef: `ca_deployment_rotation_${index}`,
          allowedCapabilities: ['gmail.profile.read'],
          providerGeneration: first.generation,
          providerLineage: first.keyFingerprint,
        },
      }, 0);
    }

    const rotated = await resolveComposioConfiguration({ env: rotatedEnv, settings });
    assert.equal(rotated.generation, 2);
    assert.equal(rotated.reconciliationPending, true);
    assert.equal(
      (await resolveDefaultManagedConnectionProviderRegistry(rotatedEnv, { settings }))
        .get('composio'),
      undefined,
    );

    const response = await fixture.app.fetch(new Request(
      'http://localhost/admin/api/settings/connectors/composio/retry',
      { method: 'POST', headers: auth(), body: '{}' },
    ), rotatedEnv);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(inspections, 2);

    const reconciled = await resolveComposioConfiguration({ env: rotatedEnv, settings });
    assert.equal(reconciled.generation, 2);
    assert.equal(reconciled.reconciliationPending, false);
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST')).every((account) =>
        account.policy.kind === 'managed' &&
        account.policy.providerGeneration === reconciled.generation &&
        account.policy.providerLineage === reconciled.keyFingerprint),
      true,
    );
    assert.ok(
      (await resolveDefaultManagedConnectionProviderRegistry(rotatedEnv, { settings }))
        .get('composio'),
    );
  } finally {
    fixture.store.close();
    settings.close();
  }
});

test('provider settings use admin.configure and deployment ownership blocks browser mutation', async () => {
  const adminPrincipal: AuthPrincipal = {
    userId: 'user_admin', membershipId: 'membership_admin', organizationId: 'org_oss',
    role: 'admin', authenticatorKind: 'test_slack_session', credentialId: 'session_admin',
    correlationId: 'request_admin', machine: false,
  };
  const memberPrincipal: AuthPrincipal = {
    ...adminPrincipal,
    userId: 'user_member', membershipId: 'membership_member', role: 'member',
    credentialId: 'session_member', correlationId: 'request_member',
  };
  const admin = harness(new FakeTransport(), {}, {}, adminPrincipal);
  const member = harness(new FakeTransport(), {}, {}, memberPrincipal);
  try {
    const adminStatus = await admin.app.request(
      'http://localhost/admin/api/settings/connectors/composio', { headers: auth() },
    );
    assert.equal(adminStatus.status, 200);
    const adminStatusBody = await adminStatus.json() as {
      canConfigure: boolean;
      catalog: unknown[];
      impact: { accounts: number; schedules: number };
    };
    assert.equal(adminStatusBody.canConfigure, true);
    assert.equal(adminStatusBody.catalog.length, 13);
    assert.deepEqual(adminStatusBody.impact, { accounts: 0, schedules: 0 });

    const memberEnv = {
      CHICKPEA_COMPOSIO_CONFIGURATION_MODE: 'deployment',
      COMPOSIO_API_KEY: 'ak_member_status_redaction',
    };
    await recordComposioPreparationResult({
      expectedGeneration: 1,
      authConfigIds: { gmail: { read: 'ac_member_status_gmail' } },
      status: 'partial',
      issueCodes: ['operator_only_detail'],
      completedAt: 1_900_000_000_000,
    }, { env: memberEnv, settings: member.settings });
    const memberStatus = await member.app.fetch(new Request(
      'http://localhost/admin/api/settings/connectors/composio', { headers: auth() },
    ), memberEnv);
    assert.equal(memberStatus.status, 200);
    const memberStatusBody = await memberStatus.json() as {
      canConfigure: boolean;
      catalog: unknown[];
      provider: Record<string, unknown>;
    };
    assert.equal(memberStatusBody.canConfigure, false);
    assert.equal(memberStatusBody.catalog.length, 13);
    assert.equal('impact' in memberStatusBody, false);
    assert.equal(
      'lastSetupResult' in memberStatusBody.provider,
      false,
    );
    assert.equal((await member.app.request(
      'http://localhost/admin/api/settings/connectors/composio/disable', {
        method: 'POST', headers: auth(), body: '{}',
      },
    )).status, 403);

    const deploymentResponse = await admin.app.fetch(new Request(
      'http://localhost/admin/api/settings/connectors/composio/setup',
      {
        method: 'POST', headers: auth(), body: JSON.stringify({ projectKey: 'ak_browser_key' }),
      },
    ), {
      CHICKPEA_COMPOSIO_CONFIGURATION_MODE: 'deployment',
    });
    assert.equal(deploymentResponse.status, 409);
    assert.deepEqual(await deploymentResponse.json(), {
      error: 'composio_configuration_deployment_managed',
      message: 'This Composio project is managed by deployment configuration and cannot be changed here.',
    });
  } finally {
    admin.store.close();
    admin.settings.close();
    member.store.close();
    member.settings.close();
  }
});

test('concurrent Composio setup returns a typed retryable conflict', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = {
    store: settings,
    keyring: generateCredentialKeyring('admin_route_composio_setup_lease'),
  };
  const fixture = harness(new FakeTransport(), {
    composioConfiguration: { credentials },
    composioCreateClient: async () => composioSetupClient(),
  }, { settings });
  try {
    await settings.setSetting('managed.composio.setup_lease', JSON.stringify({
      version: 1,
      attemptId: 'existingroutelease0001',
      generation: 1,
      expiresAt: Date.now() + 60_000,
    }));
    const response = await fixture.app.request(
      'http://localhost/admin/api/settings/connectors/composio/setup',
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ projectKey: 'ak_valid_but_setup_is_busy' }),
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'composio_setup_in_progress',
      message: 'Managed connector setup is already in progress. Try again shortly.',
    });
  } finally {
    fixture.store.close();
    settings.close();
  }
});

test('hostless poll rejects a stale provider generation before calling Composio', async () => {
  let pollCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async authorize() { throw new Error('unused'); },
    async pollAuthorization() { pollCalls += 1; return { status: 'pending' }; },
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
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'],
        bindingCapabilities: ['gmail.profile.read'],
        providerGeneration: 2,
        providerLineage: 'b'.repeat(24),
      },
      randomSecret: () => 'd'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_stale_generation',
    });
    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      {
        method: 'POST',
        headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'managed_authorization_stale_provider',
      message: 'The connector configuration changed. Start this sign-in again.',
    });
    assert.equal(pollCalls, 0);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('hostless poll and cancel reject an authorization from a previously connected workspace', async () => {
  let pollCalls = 0;
  let revokeCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async pollAuthorization() { pollCalls += 1; return { status: 'pending' }; },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() { revokeCalls += 1; },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_OLD', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'],
        bindingCapabilities: ['gmail.profile.read'],
        providerGeneration: 1,
        providerLineage: '0'.repeat(24),
      },
      randomSecret: () => 'a'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_old_workspace_attempt',
    });
    const headers = {
      ...auth(),
      cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
    };

    const poll = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      { method: 'POST', headers, body: '{}' },
    );
    const cancel = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/cancel',
      { method: 'POST', headers, body: '{}' },
    );

    assert.equal(poll.status, 403);
    assert.equal(cancel.status, 403);
    assert.equal(pollCalls, 0);
    assert.equal(revokeCalls, 0);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('concurrent hostless polls remain request-local and import the exact account once', async () => {
  let pollCalls = 0;
  let validateCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async authorize() { throw new Error('unused'); },
    async pollAuthorization() {
      pollCalls += 1;
      await Promise.resolve();
      return { status: 'active', accountRef: 'ca_poll_once', toolkit: 'gmail' };
    },
    async validate() { validateCalls += 1; },
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'],
        bindingCapabilities: ['gmail.profile.read'],
        providerGeneration: 1,
        providerLineage: '0'.repeat(24),
      },
      randomSecret: () => 'e'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_poll_once',
    });
    const request = () => fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      {
        method: 'POST',
        headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    assert.equal(pollCalls, 2);
    assert.equal(validateCalls, 1);
    const accounts = await fixture.store.listConnectionAccounts('T_TEST');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.policy.kind, 'managed');
    if (accounts[0]?.policy.kind !== 'managed') assert.fail('expected managed account');
    assert.equal(accounts[0].policy.accountRef, 'ca_poll_once');
    assert.equal(accounts[0].policy.providerGeneration, 1);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('reconnect polling cannot narrow a shared account widened after authorization began', async () => {
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async pollAuthorization() {
      return { status: 'active', accountRef: 'ca_shared_reconnect', toolkit: 'gmail' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() { assert.fail('the imported shared account must not be revoked'); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.createAgent({
      id: 'agent_sibling', name: 'Sibling', instructions: 'Use Gmail.', enabled: true,
      creatorMembershipId: 'membership_test_owner', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const existing = await fixture.store.putConnectionAccount({
      id: 'connection_shared_reconnect', workspaceId: 'T_TEST', ownerKind: 'team',
      createdByMembershipId: 'membership_test_owner', providerId: 'google', label: 'Shared Gmail',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:organization:org_oss', accountRef: 'ca_shared_reconnect',
        allowedCapabilities: ['gmail.profile.read'],
        providerGeneration: 1, providerLineage: '0'.repeat(24),
      },
      secretRefId: 'secret_shared_reconnect', lifecycle: 'ready',
    }, 0);
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Shared Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'],
        connectionAccountId: existing.id,
        providerGeneration: 1, providerLineage: '0'.repeat(24),
      },
      randomSecret: () => '6'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings, actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret, authorizationRef: 'ca_shared_reconnect',
    });
    assert.equal(existing.policy.kind, 'managed');
    if (existing.policy.kind !== 'managed') assert.fail('expected managed policy');
    const widenedCapabilities = ['gmail.profile.read', 'gmail.messages.send'];
    const widened = await fixture.store.putConnectionAccount({
      ...existing,
      policy: { ...existing.policy, allowedCapabilities: widenedCapabilities },
    }, existing.revision);
    await fixture.store.putAgentConnectionBinding({
      agentId: 'agent_sibling', connectionAccountId: existing.id, providerId: 'google',
      allowedCapabilities: widenedCapabilities, enabled: true,
    });

    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      {
        method: 'POST',
        headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );

    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await response.json(), { error: 'managed_authorization_invalid' });
    const preserved = (await fixture.store.listConnectionAccounts('T_TEST'))
      .find(({ id }) => id === existing.id)!;
    assert.equal(preserved.revision, widened.revision);
    assert.equal(preserved.policy.kind, 'managed');
    if (preserved.policy.kind !== 'managed') assert.fail('expected managed policy');
    assert.deepEqual(preserved.policy.allowedCapabilities, widenedCapabilities);
    assert.deepEqual(
      (await fixture.store.listAgentConnectionBindings('agent_sibling'))[0]
        ?.allowedCapabilities,
      widenedCapabilities,
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('hostless poll cleans an unimported remote account after a lane conflict', async () => {
  const cleanedRemoteAccounts: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async authorize() { throw new Error('unused'); },
    async pollAuthorization() {
      return { status: 'active', accountRef: 'ca_poll_lane_conflict', toolkit: 'gmail' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
    async cleanupRemoteAccount({ accountRef }) { cleanedRemoteAccounts.push(accountRef); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const existing = await fixture.store.putConnectionAccount({
      id: 'connection_existing_gmail', workspaceId: 'T_TEST', ownerKind: 'team',
      createdByMembershipId: 'membership_test_owner', providerId: 'google',
      label: 'Existing Gmail', policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:organization:org_oss', accountRef: 'ca_existing_gmail',
        allowedCapabilities: ['gmail.profile.read'],
      },
      secretRefId: 'secret_existing_gmail', lifecycle: 'ready',
    }, 0);
    await fixture.store.putAgentConnectionBinding({
      agentId: 'agent_support', connectionAccountId: existing.id, providerId: 'google',
      allowedCapabilities: ['gmail.profile.read'], resourceConstraints: {}, enabled: true,
    });
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'], bindingCapabilities: ['gmail.profile.read'],
        providerGeneration: 1, providerLineage: '0'.repeat(24),
      },
      randomSecret: () => 'f'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings, actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret, authorizationRef: 'ca_poll_lane_conflict',
    });

    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      {
        method: 'POST', headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );

    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await response.json(), { error: 'managed_authorization_invalid' });
    assert.deepEqual(cleanedRemoteAccounts, ['ca_poll_lane_conflict']);
    assert.equal(
      await fixture.settings.getSetting(await managedAuthorizationSettingKey('membership_test_owner')),
      undefined,
    );
    assert.deepEqual(
      (await fixture.store.listConnectionAccounts('T_TEST')).map(({ id }) => id),
      [existing.id],
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('terminal hostless polling deletes the unimported remote account before abandoning', async () => {
  const cleanedRemoteAccounts: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async pollAuthorization() { return { status: 'terminal', reason: 'inactive' }; },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
    async cleanupRemoteAccount({ accountRef }) { cleanedRemoteAccounts.push(accountRef); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'], bindingCapabilities: ['gmail.profile.read'],
        providerGeneration: 1, providerLineage: '0'.repeat(24),
      },
      randomSecret: () => '1'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings, actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret, authorizationRef: 'ca_terminal_poll_cleanup',
    });

    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      {
        method: 'POST', headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );

    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await response.json(), {
      error: 'managed_authorization_terminal', reason: 'inactive',
    });
    assert.deepEqual(cleanedRemoteAccounts, ['ca_terminal_poll_cleanup']);
    assert.equal(
      await fixture.settings.getSetting(await managedAuthorizationSettingKey('membership_test_owner')),
      undefined,
    );
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('transient import validation preserves active authorization for poll retry', async () => {
  let validateCalls = 0;
  const cleanedRemoteAccounts: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async pollAuthorization() {
      return { status: 'active', accountRef: 'ca_import_validation_retry', toolkit: 'gmail' };
    },
    async validate() {
      validateCalls += 1;
      if (validateCalls === 1) {
        throw new ManagedProviderRequestError(
          'provider_unavailable',
          'temporary validation outage',
          {
            remoteCallCount: 1,
            providerToolCallCount: 0,
            capabilityToolDispatched: false,
            definiteFailure: false,
          },
        );
      }
    },
    async execute() { return { data: {} }; },
    async revoke({ policy }) { cleanedRemoteAccounts.push(policy.accountRef); },
    async cleanupRemoteAccount({ accountRef }) { cleanedRemoteAccounts.push(accountRef); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'], bindingCapabilities: ['gmail.profile.read'],
        providerGeneration: 1, providerLineage: '0'.repeat(24),
      },
      randomSecret: () => '2'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings, actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret, authorizationRef: 'ca_import_validation_retry',
    });
    const poll = () => fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      {
        method: 'POST', headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );

    const unavailable = await poll();
    assert.equal(unavailable.status, 503, await unavailable.clone().text());
    assert.deepEqual(await unavailable.json(), {
      error: 'managed_authorization_poll_unavailable',
      message: 'Managed sign-in could not be checked yet. Chickpea will keep trying.',
    });
    assert.doesNotMatch(unavailable.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.deepEqual(cleanedRemoteAccounts, []);
    assert.ok(
      await fixture.settings.getSetting(await managedAuthorizationSettingKey('membership_test_owner')),
    );

    const connected = await poll();
    assert.equal(connected.status, 200, await connected.clone().text());
    assert.equal((await connected.json() as { status: string }).status, 'connected');
    assert.equal(validateCalls, 2);
    assert.deepEqual(cleanedRemoteAccounts, []);
    assert.equal(
      await fixture.settings.getSetting(await managedAuthorizationSettingKey('membership_test_owner')),
      undefined,
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('definite import validation failure cleans authorization and returns terminal', async () => {
  const cleanedRemoteAccounts: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async pollAuthorization() {
      return { status: 'active', accountRef: 'ca_definite_validation_failure', toolkit: 'gmail' };
    },
    async validate() {
      throw new ManagedProviderRequestError(
        'validation_failed',
        'grant verification failed',
        {
          remoteCallCount: 2,
          providerToolCallCount: 1,
          capabilityToolDispatched: false,
          definiteFailure: true,
        },
      );
    },
    async execute() { return { data: {} }; },
    async revoke({ policy }) { cleanedRemoteAccounts.push(policy.accountRef); },
    async cleanupRemoteAccount({ accountRef }) { cleanedRemoteAccounts.push(accountRef); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'], bindingCapabilities: ['gmail.profile.read'],
        providerGeneration: 1, providerLineage: '0'.repeat(24),
      },
      randomSecret: () => '3'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings, actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret, authorizationRef: 'ca_definite_validation_failure',
    });

    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      {
        method: 'POST', headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );

    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await response.json(), {
      error: 'managed_authorization_terminal', reason: 'failed',
    });
    assert.deepEqual(cleanedRemoteAccounts, ['ca_definite_validation_failure']);
    assert.equal(
      await fixture.settings.getSetting(await managedAuthorizationSettingKey('membership_test_owner')),
      undefined,
    );
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('failed imported-account attachment leaves connector-paused schedules paused', async () => {
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async pollAuthorization() {
      return { status: 'active', accountRef: 'ca_existing_import', toolkit: 'gmail' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() { assert.fail('an already imported account must not be revoked'); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.createAgent({
      id: 'agent_existing_import', name: 'Existing import', instructions: 'Use Gmail.', enabled: true,
      creatorMembershipId: 'membership_test_owner', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const existing = await fixture.store.putConnectionAccount({
      id: 'connection_existing_import', workspaceId: 'T_TEST', ownerKind: 'team',
      createdByMembershipId: 'membership_test_owner', providerId: 'google', label: 'Existing Gmail',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:organization:org_oss', accountRef: 'ca_existing_import',
        allowedCapabilities: ['gmail.profile.read'],
        providerGeneration: 1, providerLineage: '0'.repeat(24),
      },
      secretRefId: 'secret_existing_import', lifecycle: 'needs_attention',
    }, 0);
    await fixture.store.putAgentConnectionBinding({
      agentId: 'agent_existing_import', connectionAccountId: existing.id, providerId: 'google',
      allowedCapabilities: ['gmail.profile.read'], enabled: true,
    });
    await fixture.store.putAgentScheduleReference({
      scheduleId: 'schedule_existing_import', agentId: 'agent_existing_import',
      workspaceId: 'T_TEST', channelId: 'C_IMPORT',
      createdByMembershipId: 'membership_test_owner', runsAsMembershipId: 'membership_test_owner',
      authorityReceiptId: 'authority_existing_import',
      requiredConnectionAccountIds: [existing.id],
      connectionPauseAccountIds: [existing.id], state: 'needs_attention',
    });
    const putBinding = fixture.store.putAgentConnectionBinding.bind(fixture.store);
    fixture.store.putAgentConnectionBinding = (input) => {
      if (input.agentId === 'agent_support') throw new Error('simulated attachment failure');
      return putBinding(input);
    };
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'], bindingCapabilities: ['gmail.profile.read'],
        providerGeneration: 1, providerLineage: '0'.repeat(24),
      },
      randomSecret: () => '4'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings, actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret, authorizationRef: 'ca_existing_import',
    });

    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/poll',
      {
        method: 'POST', headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );

    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(
      (await fixture.store.listConnectionAccounts('T_TEST'))
        .find(({ id }) => id === existing.id)?.lifecycle,
      'needs_attention',
    );
    const schedule = (await fixture.store.listAgentScheduleReferences('agent_existing_import'))[0]!;
    assert.equal(schedule.state, 'needs_attention');
    assert.deepEqual(schedule.connectionPauseAccountIds, [existing.id]);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('canceling hostless authorization revokes only the unimported remote grant', async () => {
  const revokedRefs: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async authorize() { throw new Error('unused'); },
    async pollAuthorization() { return { status: 'pending' }; },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke({ policy }) { revokedRefs.push(policy.accountRef); },
  };
  const fixture = harness(new FakeTransport(), {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const started = await beginManagedAuthorization({
      settings: fixture.settings,
      input: {
        workspaceId: 'T_TEST', agentId: 'agent_support',
        actorMembershipId: 'membership_test_owner', ownerKind: 'team',
        providerId: 'google', adapterId: 'composio', toolkit: 'gmail', label: 'Gmail',
        principalRef: 'chickpea:organization:org_oss',
        allowedCapabilities: ['gmail.profile.read'],
        bindingCapabilities: ['gmail.profile.read'],
      },
      randomSecret: () => 'f'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings: fixture.settings,
      actorMembershipId: 'membership_test_owner',
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_cancel_exact',
    });

    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections/managed/cancel',
      {
        method: 'POST',
        headers: {
          ...auth(),
          cookie: `__Secure-chickpea_managed_authorization=${started.browserSecret}`,
        },
        body: '{}',
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cancelled: true });
    assert.deepEqual(revokedRefs, ['ca_cancel_exact']);
    assert.equal(
      await fixture.settings.getSetting(await managedAuthorizationSettingKey('membership_test_owner')),
      undefined,
    );
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

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

test('activated Agents inherit the Workspace default and a pinned Agent can reset to it', async () => {
  const fixture = harness();
  try {
    const base = (await fixture.store.listAgents())[0]!;
    const installation = await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST',
      transportMode: 'direct',
      defaultAgentId: base.id,
    });
    await fixture.store.putWorkspaceModelDefault({
      workspaceId: installation.workspaceId,
      modelId: 'local-stub/workspace',
      provenance: 'admin_selected',
      lastChangedByMembershipId: 'membership_test_owner',
    }, 1);
    await fixture.store.updateWorkspaceInstallation(
      installation.workspaceId,
      { runtimeContract: 'chickpea-v1' },
      installation.revision,
    );

    const createdResponse = await fixture.app.request('http://localhost/admin/api/agents', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        id: 'agent_inheriting',
        name: 'Inheriting',
        instructions: 'Use the shared model.',
        enabled: true,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as { agent: Record<string, any> }).agent;
    assert.equal(created.model, undefined);
    assert.deepEqual(created.modelPolicy, {
      source: 'workspace_default',
      effectiveModel: 'local-stub/workspace',
      live: true,
      workspaceDefaultRevision: 2,
    });

    const pinnedResponse = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_inheriting',
      {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          expectedRevision: created.revision,
          model: 'local-stub/pinned',
        }),
      },
    );
    assert.equal(pinnedResponse.status, 200);
    const pinned = (await pinnedResponse.json() as { agent: Record<string, any> }).agent;
    assert.deepEqual(pinned.modelPolicy, {
      source: 'pinned',
      effectiveModel: 'local-stub/pinned',
      live: true,
      workspaceDefaultRevision: 2,
    });

    const resetResponse = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_inheriting',
      {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ expectedRevision: pinned.revision, model: null }),
      },
    );
    assert.equal(resetResponse.status, 200);
    const reset = (await resetResponse.json() as { agent: Record<string, any> }).agent;
    assert.equal(reset.model, undefined);
    assert.deepEqual(reset.modelPolicy, {
      source: 'workspace_default',
      effectiveModel: 'local-stub/workspace',
      live: true,
      workspaceDefaultRevision: 2,
    });
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('the Chickpea system Agent stays hidden across direct and nested Admin routes', async () => {
  const fixture = harness();
  try {
    const base = (await fixture.store.listAgents())[0]!;
    const installation = await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST',
      transportMode: 'direct',
      defaultAgentId: base.id,
    });
    const workspaceDefault = await fixture.store.putWorkspaceModelDefault({
      workspaceId: installation.workspaceId,
      modelId: 'local-stub/workspace',
      provenance: 'admin_selected',
      lastChangedByMembershipId: 'membership_test_owner',
    }, 1);
    await fixture.store.activateChickpeaCutover({
      workspaceId: installation.workspaceId,
      expectedInstallationRevision: installation.revision,
      expectedDefaultRevision: workspaceDefault.revision,
      defaultReady: true,
    });

    const requests: Array<[string, RequestInit?]> = [
      ['http://localhost/admin/api/agents/agent_chickpea'],
      ['http://localhost/admin/api/agents/agent_chickpea/memory'],
      ['http://localhost/admin/api/agents/agent_chickpea/schedules'],
      ['http://localhost/admin/api/agents/agent_chickpea/connections?workspaceId=T_TEST'],
      ['http://localhost/admin/api/agents/agent_chickpea', {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 1, instructions: 'Changed' }),
      }],
    ];
    for (const [url, init] of requests) {
      const response = await fixture.app.request(url, {
        ...init,
        headers: auth(),
      });
      assert.equal(response.status, 404, `${init?.method ?? 'GET'} ${url}`);
      assert.equal((await response.json() as { error: string }).error, 'not_found');
    }
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('Agent creation reserves Chickpea system identities across id, name, and handle', async () => {
  const fixture = harness();
  try {
    const cases = [
      { id: 'agent_chickpea', name: 'Helper', handle: 'helper' },
      { id: 'chick-pea', name: 'Helper', handle: 'helper' },
      { id: 'agent_helper', name: 'CHICK_PEA', handle: 'helper' },
      { id: 'agent_helper', name: 'Helper', handle: 'Chick pea!!' },
    ];
    for (const candidate of cases) {
      const response = await fixture.app.request('http://localhost/admin/api/agents', {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          ...candidate,
          instructions: 'Help people.',
          enabled: true,
          model: 'local-stub/admin-agent',
        }),
      });
      assert.equal(response.status, 400, JSON.stringify(candidate));
      assert.equal((await response.json() as { error: string }).error, 'invalid_request');
    }
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

test('workspace connection inventory omits revoked accounts and returns a reconnect Agent', async () => {
  const fixture = harness();
  try {
    await createAgent(fixture.app);
    const account = (id: string, lifecycle: 'ready' | 'revoked') => ({
      id,
      workspaceId: 'T_TEST',
      ownerKind: 'team' as const,
      createdByMembershipId: 'membership_test_owner',
      providerId: 'custom',
      label: id,
      policy: {
        kind: 'api' as const,
        allowedHosts: ['api.example.com'],
        pathPrefixes: ['/'],
        headerName: 'Authorization',
        allowedMethods: ['GET'],
        authMode: 'credential' as const,
      },
      secretRefId: `secret_${id}`,
      lifecycle,
    });
    const visible = await fixture.store.putConnectionAccount(account('connection_visible', 'ready'), 0);
    await fixture.store.putConnectionAccount(account('connection_unbound', 'ready'), 0);
    await fixture.store.putConnectionAccount(account('connection_revoked', 'revoked'), 0);
    await fixture.store.createAgent({
      id: 'agent_inventory_bound', name: 'Inventory bound', instructions: 'Use the account.',
      enabled: true, creatorMembershipId: 'membership_test_owner',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await fixture.store.putAgentConnectionBinding({
      agentId: 'agent_inventory_bound', connectionAccountId: visible.id,
      providerId: visible.providerId, allowedCapabilities: [], resourceConstraints: {},
      enabled: true,
    });

    const response = await fixture.app.request(
      'http://localhost/admin/api/connections?workspaceId=T_TEST',
      { headers: auth() },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as {
      accounts: Array<{
        account: { id: string };
        reconnectAgentId?: string;
      }>;
    };
    assert.deepEqual(body.accounts.map(({ account: listed }) => listed.id), [
      'connection_unbound',
      'connection_visible',
    ]);
    assert.equal(body.accounts[0]?.reconnectAgentId, undefined);
    assert.equal(body.accounts[1]?.reconnectAgentId, 'agent_inventory_bound');
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('corrupt managed credentials do not block native connection inventory, attach, or revoke', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  await saveStoredComposioProjectKey('ak_native_routes_survive_managed_corruption', {
    settings,
    credentials: {
      store: settings,
      keyring: generateCredentialKeyring('managed_configuration_writer'),
    },
  });
  const fixture = harness(new FakeTransport(), {
    composioConfiguration: {
      credentials: {
        store: settings,
        keyring: generateCredentialKeyring('managed_configuration_reader'),
      },
    },
  }, { settings });
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const account = await fixture.store.putConnectionAccount({
      id: 'connection_native_during_managed_failure', workspaceId: 'T_TEST',
      ownerKind: 'team', createdByMembershipId: 'membership_test_owner',
      providerId: 'custom', label: 'Native API', lifecycle: 'ready',
      secretRefId: 'secret_native_during_managed_failure',
      policy: {
        kind: 'api', allowedHosts: ['api.example.com'], pathPrefixes: ['/'],
        headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential',
      },
    }, 0);

    const listed = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections?workspaceId=T_TEST',
      { headers: auth() },
    );
    assert.equal(listed.status, 200, await listed.clone().text());
    const listedBody = await listed.json() as {
      available: Array<{ id: string }>;
    };
    assert.deepEqual(listedBody.available.map((item) => item.id), [account.id]);

    const attached = await fixture.app.request(
      `http://localhost/admin/api/agents/agent_support/connections/${account.id}/attach`,
      { method: 'POST', headers: auth(), body: JSON.stringify({ allowedCapabilities: [] }) },
    );
    assert.equal(attached.status, 201, await attached.clone().text());

    const revoked = await fixture.app.request(
      `http://localhost/admin/api/connections/${account.id}/revoke`,
      { method: 'POST', headers: auth(), body: '{}' },
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
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
          capabilities: Array<{ id: string; accessLane: string; description: string }>;
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
    assert.deepEqual(body.managedConnectors.catalog[0]?.capabilities[0], {
      id: 'gmail.profile.read',
      accessLane: 'read',
      description: 'Read the email address and mailbox totals for the selected Gmail account.',
    });
    assert.deepEqual(
      Object.keys(body.managedConnectors.catalog[0]?.capabilities[0] ?? {}).sort(),
      ['accessLane', 'description', 'id'],
      'the catalog must not expose execution-only capability metadata',
    );
  } finally {
    fixture.store.close();
    fixture.settings.close();
  }
});

test('revoked connection accounts are excluded from reusable available accounts', async () => {
  const fixture = harness(new FakeTransport());
  try {
    await createAgent(fixture.app);
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    await fixture.store.putConnectionAccount({
      id: 'connection_revoked', workspaceId: 'T_TEST', ownerKind: 'member',
      ownerMembershipId: 'membership_test_owner', createdByMembershipId: 'membership_test_owner',
      providerId: 'google', label: 'Revoked Gmail', lifecycle: 'revoked',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: 'chickpea:membership:membership_test_owner', accountRef: 'ca_revoked',
        allowedCapabilities: ['gmail.profile.read'],
      },
      secretRefId: 'secret_revoked',
    }, 0);
    const response = await fixture.app.request(
      'http://localhost/admin/api/agents/agent_support/connections?workspaceId=T_TEST',
      { headers: auth() },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { available: Array<{ id: string }> };
    assert.deepEqual(body.available, []);
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

test('hostless authorization polling survives a transient provider outage', async () => {
  let pollCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/lk_retry'),
        authorizationRef: 'ca_poll_retry',
      };
    },
    async pollAuthorization() {
      pollCalls += 1;
      if (pollCalls === 1) {
        throw new ManagedProviderRequestError(
          'provider_unavailable',
          'temporary outage',
          {
            remoteCallCount: 1,
            providerToolCallCount: 0,
            capabilityToolDispatched: false,
          },
        );
      }
      return { status: 'active', accountRef: 'ca_poll_retry', toolkit: 'gmail' };
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
    const started = await fixture.app.request(
      'https://chickpea.example/admin/api/agents/agent_support/connections/managed/start',
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
    const poll = () => fixture.app.request(
      'https://chickpea.example/admin/api/agents/agent_support/connections/managed/poll',
      { method: 'POST', headers: { ...auth(), cookie }, body: '{}' },
    );

    const unavailable = await poll();
    assert.equal(unavailable.status, 503, await unavailable.clone().text());
    assert.deepEqual(await unavailable.json(), {
      error: 'managed_authorization_poll_unavailable',
      message: 'Managed sign-in could not be checked yet. Chickpea will keep trying.',
    });
    const connected = await poll();
    assert.equal(connected.status, 200, await connected.clone().text());
    assert.equal((await connected.json() as { status: string }).status, 'connected');
    assert.equal(pollCalls, 2);
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

test('Channel use does not expose a non-editor Agent in Admin', async () => {
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
    assert.equal(listed.some((agent: Record<string, any>) => agent.id === 'agent_readonly'), false);

    const detail = await app.request('http://localhost/admin/api/agents/agent_readonly', { headers: auth() });
    assert.equal(detail.status, 404, await detail.clone().text());
  } finally {
    identities.close();
    settings.close();
    store.close();
  }
});

test('Agent detail projects the live categorical DM audience without a roster', async () => {
  const transport = new FakeTransport();
  const fixture = harness(transport);
  try {
    const selected = await fixture.store.createAgent({
      id: 'agent_audience', name: 'Audience', instructions: 'Help.', enabled: true,
      lifecycle: 'active', creatorMembershipId: 'membership_test_owner',
      editPolicy: 'creator_and_admins', model: 'local-stub/audience', skills: [],
      mcpServers: [], apiConnections: [], repositories: [],
    });
    await fixture.store.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: selected.id,
    });
    const listResponse = await fixture.app.request(
      'http://localhost/admin/api/agents',
      { headers: auth() },
    );
    assert.equal(listResponse.status, 200, await listResponse.clone().text());
    const listedAgent = (await listResponse.json() as Record<string, any>).agents.find(
      (candidate: Record<string, unknown>) => candidate.id === selected.id,
    );
    assert.ok(listedAgent);
    assert.equal('privateUseAudience' in listedAgent.whereItWorks, false);

    const audience = async () => {
      const response = await fixture.app.request(
        `http://localhost/admin/api/agents/${selected.id}`,
        { headers: auth() },
      );
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json() as Record<string, any>;
      assert.equal('members' in body.agent.whereItWorks, false);
      assert.equal('memberCount' in body.agent.whereItWorks, false);
      return body.agent.whereItWorks.privateUseAudience as string;
    };

    assert.equal(await audience(), 'creator_only');
    await fixture.store.putAgentChannelGrant({
      workspaceId: 'T_TEST', channelId: 'C_SUPPORT', agentId: selected.id,
      status: 'active', createdByMembershipId: 'membership_test_owner',
      channelLabel: 'support', channelIsPrivate: false,
    });
    transport.channel = {
      id: 'C_SUPPORT', name: 'support', private: false, member: true, archived: false,
    };
    assert.equal(await audience(), 'workspace_members');
    transport.channel = { ...transport.channel, private: true };
    assert.equal(await audience(), 'private_channel_members');
    transport.channel = { ...transport.channel, archived: true };
    assert.equal(await audience(), 'unavailable');
  } finally {
    fixture.store.close();
    fixture.settings.close();
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
