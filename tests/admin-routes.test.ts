import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import flueApp from '../src/app.ts';
import type { RuntimeDrainStatus } from '../src/config/state-rpc.ts';
import { SqliteSlackStateStore, type SlackStateStore } from '../src/slack/claim-store.ts';
import {
  ApiOAuthError,
  apiOAuthSettingKeys,
  type ApiOAuthDependencies,
  type ApiOAuthProvider,
  type ApiOAuthRef,
} from '../src/config/api-oauth.ts';
import { googleWorkspaceApiPolicy } from '../src/config/api-oauth-policy.ts';
import {
  connectorCredentialSettingKey,
  connectorSecretCleanupMarkerKey,
  describeConnectorCredentialSource,
} from '../src/config/connector-secrets.ts';
import { DEFAULT_EGRESS_POLICY } from '../src/config/egress.ts';
import {
  McpOAuthError,
  mcpOAuthSettingKeys,
} from '../src/config/mcp-oauth.ts';
import type {
  CompleteMcpOAuthInput,
  McpOAuthDependencies,
  ResolveMcpOAuthAccessInput,
  StartMcpOAuthInput,
} from '../src/config/mcp-oauth.ts';
import {
  mcpSecretCleanupMarkerKey,
  saveMcpSecrets,
} from '../src/config/mcp-secrets.ts';
import type { McpConnectInput, McpDiscoveryResult } from '../src/config/mcp-test.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore, type ConfigStore } from '../src/config/store.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import { beginOnboardingJourney, startOnboardingTry } from '../src/config/onboarding-state.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type SlackIdentity,
  ApiConnectionConfig,
  CustomAgentConfig,
  McpConnectionConfig,
} from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';
import { loopbackListenSkipReason } from './helpers/listen.ts';
import { FakeSlackBackend } from './parity/fake-slack.ts';
import { writeSlackIdentityCredentials } from '../src/slack/identity-credentials.ts';
import {
  SLACK_SETTING_KEYS,
  type SlackConversationsInfoResult,
} from '../src/slack/credentials.ts';
import { opaqueId } from '../src/work/admission.ts';
import type { WorkRunListItem, WorkStore } from '../src/work/types.ts';
import {
  readPendingSlackChallenge,
  recordPendingSlackChallenge,
} from '../src/slack/identity-handshake.ts';
import {
  acceptModelCatalogCandidate,
  activateModelCatalog,
  activeModelCatalogSnapshot,
  parseModelCatalogBytes,
  resetModelCatalogActivationForTests,
  type ModelCatalogRefreshResult,
  type RefreshModelCatalogOptions,
} from '../src/model-catalog/index.ts';

const ADMIN_TOKEN = 'admin-secret-token';

interface AdminHarnessOptions {
  adminToken?: string | undefined;
  settings?: SettingsStore;
  discoverMcp?: (input: McpConnectInput) => Promise<McpDiscoveryResult>;
  startMcpOAuth?: (
    input: StartMcpOAuthInput,
    dependencies: McpOAuthDependencies,
  ) => Promise<{ authorizationUrl: URL; state: string }>;
  completeMcpOAuth?: (
    input: CompleteMcpOAuthInput,
    dependencies: McpOAuthDependencies,
  ) => Promise<{ ref: { agentId: string; connectionId: string } }>;
  cancelMcpOAuth?: (
    state: string,
    dependencies: McpOAuthDependencies,
  ) => Promise<{ ref: { agentId: string; connectionId: string } }>;
  resolveMcpOAuthToken?: (
    input: ResolveMcpOAuthAccessInput,
    dependencies: McpOAuthDependencies,
  ) => Promise<string>;
  identifyMcp?: (input: {
    id: string;
    url: string;
    transport: 'streamable-http' | 'sse';
    headers: Record<string, string>;
    presetId?: string;
  }) => Promise<{ workspaceName?: string; accountName?: string } | undefined>;
  startApiOAuth?: (
    input: {
      ref: ApiOAuthRef;
      provider: ApiOAuthProvider;
      callbackUrl: string;
      scopes: readonly string[];
    },
    dependencies: ApiOAuthDependencies,
  ) => Promise<{ authorizationUrl: URL; state: string }>;
  completeApiOAuth?: (
    input: { code: string; state: string },
    dependencies: ApiOAuthDependencies,
  ) => Promise<{
    ref: ApiOAuthRef;
    provider: ApiOAuthProvider;
    identity?: { accountName?: string };
  }>;
  cancelApiOAuth?: (
    state: string,
    dependencies: ApiOAuthDependencies,
  ) => Promise<{ ref: ApiOAuthRef; provider: ApiOAuthProvider }>;
  modelCatalogRefresh?: (
    options: RefreshModelCatalogOptions,
  ) => Promise<ModelCatalogRefreshResult>;
  modelCatalogNow?: () => number;
  modelCatalogRandom?: () => number;
  modelCatalogOwnerId?: () => string;
  modelCatalogFetch?: typeof fetch;
  modelCatalogTimeoutMs?: number;
  runtimeDrain?: () => Promise<RuntimeDrainStatus>;
  slackState?: SlackStateStore;
  identity?: IdentityStore;
  work?: WorkStore;
  snapshots?: AgentSnapshotStore;
  slackConversationsInfo?: (
    botToken: string,
    channelId: string,
  ) => Promise<SlackConversationsInfoResult>;
}

function appWithAdmin(store: ConfigStore, adminToken?: string): Hono {
  const overrides: AdminHarnessOptions = arguments.length >= 2 ? { adminToken } : {};
  return appWithAdminOptions(store, overrides);
}

function appWithAdminOptions(store: ConfigStore, options: AdminHarnessOptions = {}): Hono {
  const app = new Hono();
  const token = Object.hasOwn(options, 'adminToken') ? options.adminToken : ADMIN_TOKEN;
  // A fresh in-memory settings store keeps the assignment-PUT Slack validation
  // hermetic: with no stored bot token (and no SLACK_* env in CI), validation is
  // skipped, so these CRUD assertions keep their exact pre-validation shape and
  // never touch a file-backed store.
  const settings = options.settings ?? new SqliteSettingsStore(':memory:');
  // Pin the provider registry: importing src/app.ts anywhere in this test
  // process records real registrations, which would otherwise make the
  // unknown-provider pre-check reject the local-stub models used here.
  app.route(
    '/',
    createAdminRoutes({
      store,
      settings,
      adminToken: token,
      knownProviders: new Set(['local-stub']),
      ...(options.discoverMcp ? { discoverMcp: options.discoverMcp } : {}),
      ...(options.startMcpOAuth ? { startMcpOAuth: options.startMcpOAuth } : {}),
      ...(options.completeMcpOAuth
        ? { completeMcpOAuth: options.completeMcpOAuth }
        : {}),
      ...(options.cancelMcpOAuth ? { cancelMcpOAuth: options.cancelMcpOAuth } : {}),
      ...(options.resolveMcpOAuthToken
        ? { resolveMcpOAuthToken: options.resolveMcpOAuthToken }
        : {}),
      ...(options.identifyMcp ? { identifyMcp: options.identifyMcp } : {}),
      ...(options.startApiOAuth ? { startApiOAuth: options.startApiOAuth } : {}),
      ...(options.completeApiOAuth ? { completeApiOAuth: options.completeApiOAuth } : {}),
      ...(options.cancelApiOAuth ? { cancelApiOAuth: options.cancelApiOAuth } : {}),
      modelCatalogRefresh: options.modelCatalogRefresh ?? (async () => ({
        status: 'fresh',
        revision: activeModelCatalogSnapshot().revision,
      })),
      ...(options.modelCatalogNow ? { modelCatalogNow: options.modelCatalogNow } : {}),
      ...(options.modelCatalogRandom ? { modelCatalogRandom: options.modelCatalogRandom } : {}),
      ...(options.modelCatalogOwnerId ? { modelCatalogOwnerId: options.modelCatalogOwnerId } : {}),
      ...(options.modelCatalogFetch ? { modelCatalogFetch: options.modelCatalogFetch } : {}),
      ...(options.modelCatalogTimeoutMs !== undefined
        ? { modelCatalogTimeoutMs: options.modelCatalogTimeoutMs }
        : {}),
      ...(options.runtimeDrain ? { runtimeDrain: options.runtimeDrain } : {}),
      ...(options.slackState ? { slackState: options.slackState } : {}),
      ...(options.identity ? { identity: options.identity } : {}),
      ...(options.work ? { work: options.work } : {}),
      ...(options.snapshots ? { snapshots: options.snapshots } : {}),
      ...(options.slackConversationsInfo
        ? { slackConversationsInfo: options.slackConversationsInfo }
        : {}),
    }),
  );
  return app;
}

function activateAdminCatalog(
  revision: number,
  entries: unknown[],
  hashDigit = 'a',
): void {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision,
    generatedAt: '2026-07-29T20:00:00Z',
    entries,
  }));
  const activation = activateModelCatalog({
    document: parseModelCatalogBytes(bytes),
    sha256: hashDigit.repeat(64),
  });
  assert.equal(activation.status, 'activated');
}

async function persistAdminCatalog(
  settings: SettingsStore,
  revision: number,
  entries: unknown[],
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision,
    generatedAt: '2026-07-29T20:00:00Z',
    entries,
  }));
  const accepted = await acceptModelCatalogCandidate(settings, {
    bytes,
    checkedAt: revision * 1_000,
    nextRefreshAt: revision * 1_000 + 60_000,
  });
  assert.equal(accepted.status, 'accepted');
}

function mcpServer(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return {
    id: 'linear-mcp',
    displayName: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable-http',
    authMode: 'bearer',
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: 'Connected · 2 tools',
    discoveredTools: [{ name: 'search' }, { name: 'create' }],
    allowedTools: ['search'],
    ...overrides,
  };
}

function apiConnection(overrides: Partial<ApiConnectionConfig> = {}): ApiConnectionConfig {
  return {
    id: 'linear-api',
    displayName: 'Linear API',
    allowedHosts: ['api.linear.app'],
    pathPrefixes: ['/v1'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET', 'POST'],
    enabled: true,
    presetId: 'linear-api',
    ...overrides,
  };
}

function googleApiConnection(
  scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  overrides: Partial<ApiConnectionConfig> = {},
): ApiConnectionConfig {
  return {
    id: 'google-workspace',
    displayName: 'Google Workspace',
    ...googleWorkspaceApiPolicy(scopes),
    enabled: true,
    authMode: 'oauth',
    oauthProvider: 'google',
    oauthScopes: scopes,
    oauthAppType: 'workspace-internal',
    lifecycleStatus: 'pending',
    statusText: 'Not connected',
    presetId: 'google-workspace',
    ...overrides,
  };
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function deliveredOnboardingRun(
  workspaceId: string,
  channelId: string,
  createdAt: number,
): WorkRunListItem {
  return {
    work: { id: 'work_onboarding' as WorkRunListItem['work']['id'], kind: 'conversation', lifecycle: 'open', maximumSensitivity: 'private', createdAt: createdAt - 10, updatedAt: createdAt, closedAt: null },
    binding: {
      id: 'binding_onboarding' as WorkRunListItem['binding']['id'],
      workId: 'work_onboarding' as WorkRunListItem['binding']['workId'],
      adapterKind: 'slack',
      externalAccountId: opaqueId('account', `slack:${workspaceId}`),
      externalConversationId: 'conversation_opaque',
      generation: 1,
      lifecycle: 'active',
      sourceVisibility: 'private',
      configMode: 'resolve_each_run',
      pinnedConfigRevisionId: null,
      orderingKey: `slack:${workspaceId}:${channelId}`,
      createdAt: createdAt - 10,
      expiredAt: null,
    },
    run: {
      id: 'run_onboarding' as WorkRunListItem['run']['id'],
      workId: 'work_onboarding' as WorkRunListItem['run']['workId'],
      bindingId: 'binding_onboarding' as WorkRunListItem['run']['bindingId'],
      kind: 'interactive',
      admissionSequence: 1,
      triggerKind: 'slack_app_mention',
      triggerRef: 'slack:event:onboarding',
      dedupeKey: 'event-onboarding',
      actorRef: null,
      actorTrustTier: 'member',
      sourceContextWatermark: null,
      triggerContentRef: null,
      preparedInputRef: null,
      configRevisionId: 'config_onboarding' as WorkRunListItem['run']['configRevisionId'],
      effectiveCapabilityDigest: 'a'.repeat(64),
      executionAuthority: 'ledger',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
      policyApprovedOutputRef: null,
      renderedPayloadRef: null,
      status: 'settled',
      terminalDisposition: 'succeeded',
      deliveryStatus: 'delivered',
      deliveryMethod: 'slack_chat_postMessage',
      deliveryAttemptId: 'attempt-onboarding',
      deliveryRef: `slack:${channelId}:1900000000.000001`,
      deliveryFinalizedAt: createdAt,
      leaseOwner: null,
      leaseUntil: null,
      fencingToken: 1,
      safeFailureCode: null,
      recoveryResolutionKind: null,
      recoveryAdminCredentialId: null,
      recoveryOperatorLabel: null,
      recoveryAuthOrigin: null,
      recoveryReasonCode: null,
      recoveryRequestId: null,
      recoveryResolvedAt: null,
      createdAt,
      updatedAt: createdAt,
      settledAt: createdAt,
    },
  };
}

async function withCloudflareUserAgent<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Cloudflare-Workers' },
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_admin',
    revision: 1,
    name: 'Admin Agent',
    instructions: 'Use admin-managed instructions.',
    enabled: true,
    model: 'local-stub/admin-agent',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...overrides,
  };
}

test('the worker root redirects to /admin instead of a bare 404', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const response = await app.request('/', { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin');
  } finally {
    store.close();
  }
});

test('authenticated onboarding image routes serve the bundled retina Slack guides', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    for (const asset of ['bot-token.webp', 'events-retry.webp']) {
      const response = await app.request(`/admin/assets/onboarding/${asset}`, {
        headers: auth(ADMIN_TOKEN),
      });
      assert.equal(response.status, 200, asset);
      assert.equal(response.headers.get('content-type'), 'image/webp', asset);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', asset);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF', asset);
      assert.ok(bytes.byteLength > 10_000, asset);
    }

    const missing = await app.request('/admin/assets/onboarding/not-real.webp', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(missing.status, 404);
  } finally {
    store.close();
  }
});

test('MCP OAuth routes expose public metadata but gate start and return no secrets', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ mcpServers: [mcpServer({ authMode: 'oauth', oauthScope: 'read write' })] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const starts: StartMcpOAuthInput[] = [];
  try {
    const app = appWithAdminOptions(store, {
      settings,
      startMcpOAuth: async (input) => {
        starts.push(input);
        return {
          authorizationUrl: new URL(
            'https://auth.example.test/authorize?client_id=registered-client',
          ),
          state: 'must-not-cross-the-admin-api',
        };
      },
    });

    const metadataResponse = await app.request(
      'https://chickpea.example.test/.well-known/oauth-client-metadata.json',
    );
    assert.equal(metadataResponse.status, 200);
    assert.deepEqual(await metadataResponse.json(), {
      client_id:
        'https://chickpea.example.test/.well-known/oauth-client-metadata.json',
      redirect_uris: ['https://chickpea.example.test/oauth/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Chickpea',
    });

    const unauthorized = await app.request(
      '/admin/api/agents/agent_admin/mcp/oauth/linear-mcp/start',
      { method: 'POST', body: '{}' },
    );
    assert.equal(unauthorized.status, 401);

    const response = await app.request(
      'https://chickpea.example.test/admin/api/agents/agent_admin/mcp/oauth/linear-mcp/start',
      {
        method: 'POST',
        headers: {
          ...auth(ADMIN_TOKEN),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scope: 'tampered scope' }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      authorizationUrl:
        'https://auth.example.test/authorize?client_id=registered-client',
    });
    assert.deepEqual(starts, [
      {
        ref: { agentId: 'agent_admin', connectionId: 'linear-mcp' },
        serverUrl: 'https://mcp.linear.app/mcp',
        callbackUrl: 'https://chickpea.example.test/oauth/callback',
        scope: 'read write',
      },
    ]);
  } finally {
    settings.close();
    store.close();
  }
});

test('MCP OAuth callback is public, state-gated, enables all tools on first connect, and redirects with status only', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({
      mcpServers: [mcpServer({
        id: 'notion',
        displayName: 'Notion',
        url: 'https://mcp.notion.com/mcp',
        authMode: 'oauth',
        lifecycleStatus: 'pending',
        statusText: '',
        headerNames: ['X-Tenant'],
        discoveredTools: [],
        allowedTools: [],
        presetId: 'notion',
      })],
    })],
    assignments: [],
  });
  const completed: CompleteMcpOAuthInput[] = [];
  const cancelled: string[] = [];
  const discoveryCalls: McpConnectInput[] = [];
  const identityCalls: Array<Record<string, unknown>> = [];
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await saveMcpSecrets(
      { agentId: 'agent_admin', connectionId: 'notion' },
      { headers: { 'X-Tenant': 'tenant-1' } },
      undefined,
      settings,
    );
    const app = appWithAdminOptions(store, {
      settings,
      completeMcpOAuth: async (input) => {
        completed.push(input);
        return {
          ref: { agentId: 'agent_admin', connectionId: 'notion' },
        };
      },
      cancelMcpOAuth: async (state) => {
        cancelled.push(state);
        return {
          ref: { agentId: 'agent_admin', connectionId: 'notion' },
        };
      },
      resolveMcpOAuthToken: async () => 'notion-access-token',
      discoverMcp: async (input) => {
        discoveryCalls.push(input);
        return {
          tools: [
            { name: 'notion-search', description: 'Search Notion.' },
            { name: 'notion-fetch', description: 'Fetch from Notion.' },
          ],
        };
      },
      identifyMcp: async (input) => {
        identityCalls.push(input);
        return {
          workspaceName: "Pejman Pour-Moezzi's Notion",
          accountName: 'Pejman Pour-Moezzi',
        };
      },
    });

    const success = await app.request(
      'https://chickpea.example.test/oauth/callback?code=provider-code&state=opaque-state',
      { redirect: 'manual' },
    );
    assert.equal(success.status, 303);
    assert.equal(
      success.headers.get('location'),
      '/admin/agents/agent_admin?oauth=connected&connection=notion',
    );
    assert.equal(success.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.deepEqual(completed, [
      { code: 'provider-code', state: 'opaque-state' },
    ]);
    assert.equal(success.headers.get('location')?.includes('provider-code'), false);
    assert.equal(discoveryCalls.length, 1);
    assert.equal(discoveryCalls[0]?.headers.Authorization, 'Bearer notion-access-token');
    assert.equal(discoveryCalls[0]?.headers['X-Tenant'], 'tenant-1');
    assert.equal(identityCalls.length, 1);
    assert.equal(identityCalls[0]?.headers, discoveryCalls[0]?.headers);
    const connected = (await store.getAgent('agent_admin')).mcpServers[0];
    assert.equal(connected?.lifecycleStatus, 'ready');
    assert.equal(connected?.statusText, 'Connected · 2 tools');
    assert.deepEqual(connected?.allowedTools, ['notion-search', 'notion-fetch']);
    assert.deepEqual(connected?.identity, {
      workspaceName: "Pejman Pour-Moezzi's Notion",
      accountName: 'Pejman Pour-Moezzi',
    });
    assert.equal(typeof connected?.lastCheckedAt, 'number');

    const denied = await app.request(
      'https://chickpea.example.test/oauth/callback?error=access_denied&state=denied-state',
      { redirect: 'manual' },
    );
    assert.equal(denied.status, 303);
    assert.equal(
      denied.headers.get('location'),
      '/admin/agents/agent_admin?oauth=cancelled&connection=notion',
    );
    assert.deepEqual(cancelled, ['denied-state']);

    const providerFailure = await app.request(
      'https://chickpea.example.test/oauth/callback?error=server_error&state=failed-state',
      { redirect: 'manual' },
    );
    assert.equal(providerFailure.status, 303);
    assert.equal(
      providerFailure.headers.get('location'),
      '/admin/agents/agent_admin?oauth=failed&connection=notion',
    );
    assert.deepEqual(cancelled, ['denied-state', 'failed-state']);

    const malformed = await app.request(
      'https://chickpea.example.test/oauth/callback?code=provider-code',
      { redirect: 'manual' },
    );
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid_request' });
  } finally {
    settings.close();
    store.close();
  }
});

test('MCP OAuth reconnect preserves approvals without enabling newly discovered tools', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({
      mcpServers: [mcpServer({
        authMode: 'oauth',
        discoveredTools: [
          { name: 'search', description: 'Search Linear.' },
          { name: 'create', description: 'Create a Linear issue.' },
          { name: 'legacy', description: 'A removed Linear tool.' },
        ],
        allowedTools: ['search', 'legacy'],
      })],
    })],
    assignments: [],
  });
  try {
    const app = appWithAdminOptions(store, {
      completeMcpOAuth: async () => ({
        ref: { agentId: 'agent_admin', connectionId: 'linear-mcp' },
      }),
      resolveMcpOAuthToken: async () => 'linear-access-token',
      discoverMcp: async () => ({
        tools: [
          { name: 'search', description: 'Search Linear.' },
          { name: 'create', description: 'Create a Linear issue.' },
          { name: 'get', description: 'Get a Linear issue.' },
        ],
      }),
    });

    const response = await app.request(
      'https://chickpea.example.test/oauth/callback?code=provider-code&state=opaque-state',
      { redirect: 'manual' },
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      '/admin/agents/agent_admin?oauth=connected&connection=linear-mcp',
    );
    const connected = (await store.getAgent('agent_admin')).mcpServers[0];
    assert.deepEqual(connected?.discoveredTools, [
      { name: 'search', description: 'Search Linear.' },
      { name: 'create', description: 'Create a Linear issue.' },
      { name: 'get', description: 'Get a Linear issue.' },
    ]);
    assert.deepEqual(connected?.allowedTools, ['search']);
  } finally {
    store.close();
  }
});

test('MCP OAuth callback preserves tool policy across post-authorization verification failures', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({
      mcpServers: [mcpServer({
        id: 'notion',
        displayName: 'Notion',
        url: 'https://mcp.notion.com/mcp',
        authMode: 'oauth',
        lifecycleStatus: 'pending',
        statusText: '',
        discoveredTools: [
          { name: 'notion-search', description: 'Search Notion.' },
          { name: 'notion-update', description: 'Update Notion.' },
        ],
        allowedTools: ['notion-search'],
        presetId: 'notion',
      })],
    })],
    assignments: [],
  });
  try {
    const app = appWithAdminOptions(store, {
      completeMcpOAuth: async () => ({
        ref: { agentId: 'agent_admin', connectionId: 'notion' },
      }),
      resolveMcpOAuthToken: async () => 'notion-access-token',
      discoverMcp: async () => {
        throw new Error('connect timeout after 8000ms with remote-secret');
      },
    });

    const response = await app.request(
      'https://chickpea.example.test/oauth/callback?code=provider-code&state=opaque-state',
      { redirect: 'manual' },
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      '/admin/agents/agent_admin?oauth=verification_failed&connection=notion',
    );
    const failed = (await store.getAgent('agent_admin')).mcpServers[0];
    assert.equal(failed?.lifecycleStatus, 'failed');
    assert.match(failed?.statusText ?? '', /did not respond in time/i);
    assert.doesNotMatch(failed?.statusText ?? '', /remote-secret/);
    assert.deepEqual(failed?.discoveredTools, [
      { name: 'notion-search', description: 'Search Notion.' },
      { name: 'notion-update', description: 'Update Notion.' },
    ]);
    assert.deepEqual(failed?.allowedTools, ['notion-search']);
  } finally {
    store.close();
  }
});

test('MCP OAuth callback returns exchange failures to the affected connection', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ mcpServers: [mcpServer({ authMode: 'oauth' })] })],
    assignments: [],
  });
  const state = Buffer.from(
    JSON.stringify({ a: 'agent_admin', c: 'linear-mcp', n: 'nonce' }),
  ).toString('base64url');
  try {
    const app = appWithAdminOptions(store, {
      completeMcpOAuth: async () => {
        throw new McpOAuthError(
          'oauth_unavailable',
          'authorization-code exchange failed',
        );
      },
    });

    const response = await app.request(
      `https://chickpea.example.test/oauth/callback?code=provider-code&state=${state}`,
      { redirect: 'manual' },
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      '/admin/agents/agent_admin?oauth=failed&connection=linear-mcp',
    );
    assert.equal(response.headers.get('location')?.includes('provider-code'), false);
  } finally {
    store.close();
  }
});

test('admin API returns 404 for every admin route when TAG_ADMIN_TOKEN is unset', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store, undefined);

    const apiResponse = await app.request('/admin/api/agents', {
      headers: auth(ADMIN_TOKEN),
    });
    const pageResponse = await app.request('/admin', {
      headers: auth(ADMIN_TOKEN),
    });
    const loginResponse = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN_TOKEN }).toString(),
    });

    assert.equal(apiResponse.status, 404);
    assert.equal(pageResponse.status, 404);
    assert.equal(loginResponse.status, 404);
  } finally {
    store.close();
  }
});

test('admin API rejects a wrong bearer token and accepts the configured admin token', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const wrong = await app.request('/admin/api/agents', {
      headers: auth('wrong-token'),
    });
    assert.equal(wrong.status, 401);

    const right = await app.request('/admin/api/agents', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(right.status, 200);
    assert.deepEqual(await right.json(), { agents: [] });

    const page = await app.request('/admin', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /Chickpea/);
  } finally {
    store.close();
  }
});

test('runtime drain is admin-gated and reports every bounded work category', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new Proxy(new SqliteSettingsStore(':memory:'), {
    get() {
      throw new Error('runtime drain must not touch operator settings');
    },
  }) as SettingsStore;
  let calls = 0;
  const status: RuntimeDrainStatus = {
    drained: false,
    categories: {
      pendingLegacyTurnJobs: 2,
      pendingLedgerTurnJobs: 1,
      pendingSlackInteractionCleanups: 3,
      recoveryRequiredTurnJobs: 6,
      executingRuns: 4,
      admittingOrRunningRoutineOccurrences: 5,
    },
  };
  try {
    const app = appWithAdminOptions(store, {
      settings,
      runtimeDrain: async () => {
        calls += 1;
        return status;
      },
    });

    const unauthorized = await app.request('/admin/api/runtime/drain');
    assert.equal(unauthorized.status, 401);
    assert.equal(calls, 0);

    const response = await app.request('/admin/api/runtime/drain', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), status);
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('runtime drain fails closed when the state store is unavailable', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      runtimeDrain: async () => {
        throw new Error('private state failure');
      },
    });
    const response = await app.request('/admin/api/runtime/drain', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'runtime_drain_unavailable' });
  } finally {
    store.close();
  }
});

test('Slack presentation diagnostics are admin-only and workspace-scoped', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  await settings.setSetting('slack.teamId', 'T_AUTHORIZED');
  const summary = {
    workspaceId: 'T_AUTHORIZED',
    total: 2,
    truncated: false,
    streamStates: { finalized: 2 },
    eligibility: { allowed: 1, 'denied:effect_capable': 1 },
    outcomes: { progressive: 1, terminal_only: 1 },
    degradations: { none: 2 },
  };
  const slackState = {
    summarizeRunPresentations: async (workspaceId: string) => {
      assert.equal(workspaceId, 'T_AUTHORIZED');
      return summary;
    },
  } as unknown as SlackStateStore;
  try {
    const app = appWithAdminOptions(store, { settings, slackState });
    assert.equal(
      (await app.request('/admin/api/runtime/slack-presentations?workspaceId=T_AUTHORIZED')).status,
      401,
    );
    const wrongWorkspace = await app.request(
      '/admin/api/runtime/slack-presentations?workspaceId=T_OTHER',
      { headers: auth(ADMIN_TOKEN) },
    );
    assert.equal(wrongWorkspace.status, 403);
    assert.equal(wrongWorkspace.headers.get('cache-control'), 'no-store');

    const response = await app.request(
      '/admin/api/runtime/slack-presentations?workspaceId=T_AUTHORIZED',
      { headers: auth(ADMIN_TOKEN) },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), summary);
  } finally {
    settings.close();
    store.close();
  }
});

test('turn recovery inventory and explicit terminalization are admin-gated', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const turns = [{
    id: 'msg:recovery:1',
    executionAuthority: 'legacy' as const,
    reason: 'flue_expected_instance_missing',
    enqueuedAt: 1_800_000_000_000,
  }];
  const slackState = {
    listTurnRecoveryRequired: async () => [...turns],
    resolveTurnRecoveryRequired: async (id: string) => {
      const index = turns.findIndex((turn) => turn.id === id);
      if (index < 0) return false;
      turns.splice(index, 1);
      return true;
    },
  } as unknown as SlackStateStore;
  try {
    const app = appWithAdminOptions(store, { slackState });
    const unauthorized = await app.request('/admin/api/runtime/recovery-turns');
    assert.equal(unauthorized.status, 401);

    const listed = await app.request('/admin/api/runtime/recovery-turns?limit=10', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await listed.json(), { turns });

    const invalid = await app.request('/admin/api/runtime/recovery-turns/msg:recovery:1/resolve', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'idempotency-key': 'resolve-recovery-1' },
      body: JSON.stringify({ confirm: false }),
    });
    assert.equal(invalid.status, 400);

    const resolved = await app.request(
      '/admin/api/runtime/recovery-turns/msg:recovery:1/resolve',
      {
        method: 'POST',
        headers: {
          ...auth(ADMIN_TOKEN),
          'content-type': 'application/json',
          'idempotency-key': 'resolve-recovery-1',
        },
        body: JSON.stringify({ confirm: 'terminalize' }),
      },
    );
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), { id: 'msg:recovery:1', resolved: true });

    const replay = await app.request(
      '/admin/api/runtime/recovery-turns/msg:recovery:1/resolve',
      {
        method: 'POST',
        headers: {
          ...auth(ADMIN_TOKEN),
          'content-type': 'application/json',
          'idempotency-key': 'resolve-recovery-1',
        },
        body: JSON.stringify({ confirm: 'terminalize' }),
      },
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { id: 'msg:recovery:1', resolved: false });
  } finally {
    store.close();
  }
});

test('admin POST login exchanges the body token for a hashed HttpOnly cookie', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const login = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN_TOKEN, returnTo: '/admin' }).toString(),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/admin');

    const cookie = login.headers.get('set-cookie') ?? '';
    assert.match(cookie, /flue_admin=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    // The cookie carries a hash, never the raw admin token.
    assert.doesNotMatch(cookie, new RegExp(ADMIN_TOKEN));

    const cookieValue = cookie.split(';')[0] as string;
    const api = await app.request('/admin/api/agents', {
      headers: { cookie: cookieValue },
    });
    assert.equal(api.status, 200);

    // Query parameters are never credentials: GETs cannot create a session,
    // even if they carry the right token.
    const queryAttempt = await app.request(`/admin?token=${ADMIN_TOKEN}`);
    assert.equal(queryAttempt.status, 401);
    assert.equal(queryAttempt.headers.get('set-cookie'), null);

    // The return path is local admin UI only; an absolute URL cannot turn the
    // login exchange into an open redirect.
    const unsafeReturn = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: ADMIN_TOKEN,
        returnTo: 'https://example.test/steal',
      }).toString(),
    });
    assert.equal(unsafeReturn.status, 303);
    assert.equal(unsafeReturn.headers.get('location'), '/admin');
  } finally {
    store.close();
  }
});

test('client-routed admin paths serve the SPA page and POST login keeps a safe deep path', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // A deep page path serves the same SPA (client router takes it from there).
    const page = await app.request('/admin/agents/agent_default', { headers: auth(ADMIN_TOKEN) });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /Chickpea/);

    const channelsHub = await app.request('/admin/channels', { headers: auth(ADMIN_TOKEN) });
    assert.equal(channelsHub.status, 200);
    assert.equal(channelsHub.headers.get('cache-control'), 'no-store');
    assert.match(await channelsHub.text(), /Chickpea/);

    const retiredSessionsIndex = await app.request('/admin/sessions', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(retiredSessionsIndex.status, 302);
    assert.equal(retiredSessionsIndex.headers.get('location'), '/admin/channels');

    const retiredSessionsPage = await app.request('/admin/sessions/run_legacy', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(retiredSessionsPage.status, 302);
    assert.equal(retiredSessionsPage.headers.get('location'), '/admin/channels');

    // A body-authenticated login can return to the same client-routed path.
    const login = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN_TOKEN, returnTo: '/admin/profiles' }).toString(),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/admin/profiles');
    assert.match(login.headers.get('set-cookie') ?? '', /flue_admin=/);

    // An unauthenticated deep page GET gets the HTML login form, not JSON.
    const anon = await app.request('/admin/channels/T_X/C_Y');
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('content-type') ?? '', /text\/html/);
    assert.match(
      await anon.text(),
      /name="returnTo"[^>]*value="\/admin\/channels\/T_X\/C_Y"/,
    );

    // Unknown API paths stay 404 — never swallowed by the SPA catch-all.
    const api = await app.request('/admin/api/nope', { headers: auth(ADMIN_TOKEN) });
    assert.equal(api.status, 404);
  } finally {
    store.close();
  }
});

test('unauthenticated page GET renders a login form while XHR/API still gets JSON 401', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // A browser navigating to /admin with no session gets the POST token-entry
    // form (401, HTML) instead of a bare JSON error.
    const page = await app.request('/admin');
    assert.equal(page.status, 401);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /name="token"/);
    assert.match(html, /method="post" action="\/admin\/login"/);
    assert.match(html, /Sign in to Chickpea/);

    // A rejected body token is never echoed and never creates a session.
    const rejected = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'do-not-reflect', returnTo: '/admin' }).toString(),
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('set-cookie'), null);
    const rejectedHtml = await rejected.text();
    assert.match(rejectedHtml, /was not accepted/);
    assert.doesNotMatch(rejectedHtml, /do-not-reflect/);

    // API/XHR callers under /admin/* keep the JSON 401 they can handle.
    const api = await app.request('/admin/api/agents');
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), { error: 'unauthorized' });
  } finally {
    store.close();
  }
});

test('admin login rejects non-form and oversized bodies without setting a cookie', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const nonForm = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    assert.equal(nonForm.status, 401);
    assert.equal(nonForm.headers.get('set-cookie'), null);

    const oversizedRequest = new Request('http://localhost/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new Blob([
        new URLSearchParams({ token: '🐣'.repeat(2_048) }).toString(),
      ]),
    });
    assert.equal(oversizedRequest.headers.get('content-length'), null);
    const oversized = await app.request(oversizedRequest);
    assert.equal(oversized.status, 401);
    assert.equal(oversized.headers.get('set-cookie'), null);
    assert.doesNotMatch(await oversized.text(), /🐣{16}/);
  } finally {
    store.close();
  }
});

test('admin API validates request bodies with valibot', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ id: '', enabled: 'yes' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  } finally {
    store.close();
  }
});

test('admin API rejects enabled connections whose URL scopes overlap', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // Both cover api.example.com and one path is a segment-ancestor of the other,
    // so a request under /repos/issues would match both and merge both secrets.
    const overlapping = agent({
      apiConnections: [
        apiConnection({
          id: 'gh-broad',
          displayName: 'GitHub broad',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos'],
        }),
        apiConnection({
          id: 'gh-narrow',
          displayName: 'GitHub narrow',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos/issues'],
        }),
      ],
    });

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(overlapping),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  } finally {
    store.close();
  }
});

test('admin API rejects connector path prefixes carrying a query or fragment', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    for (const pathPrefix of ['/v1?tenant=a', '/v1#section']) {
      const response = await app.request('/admin/api/agents', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(
          agent({ apiConnections: [apiConnection({ pathPrefixes: [pathPrefix] })] }),
        ),
      });
      assert.equal(response.status, 400, pathPrefix);
      assert.deepEqual(await response.json(), { error: 'invalid_request' });
    }
  } finally {
    store.close();
  }
});

test('admin API accepts same-host connections with disjoint path scopes', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // Sibling prefixes (`/repos` vs `/repos-archive`, `/orgs`) never both match a
    // single request, so each connection governs a distinct URL space.
    const distinct = agent({
      apiConnections: [
        apiConnection({
          id: 'gh-repos',
          displayName: 'GitHub repos',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos', '/repos-archive'],
        }),
        apiConnection({
          id: 'gh-orgs',
          displayName: 'GitHub orgs',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/orgs'],
        }),
      ],
    });

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(distinct),
    });

    assert.equal(response.status, 201);
  } finally {
    store.close();
  }
});

test('admin API exempts a disabled connection from the overlap check', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // A disabled connection is never injected, so overlapping with it is allowed.
    const withDisabledOverlap = agent({
      apiConnections: [
        apiConnection({
          id: 'gh-active',
          displayName: 'GitHub active',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos'],
          enabled: true,
        }),
        apiConnection({
          id: 'gh-parked',
          displayName: 'GitHub parked',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos'],
          enabled: false,
        }),
      ],
    });

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(withDisabledOverlap),
    });

    assert.equal(response.status, 201);
  } finally {
    store.close();
  }
});

test('admin egress API defaults when unset and persists a valid allowlist policy', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });

    const initial = await app.request('/admin/api/egress', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { policy: DEFAULT_EGRESS_POLICY });

    const saved = await app.request('/admin/api/egress', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        // Exercises scheme stripping, case folding, whitespace trimming, and
        // dedup. A path (`/path`) is rejected separately, not silently dropped.
        mode: 'allowlist',
        domains: ['api.github.com', ' https://API.GITHUB.COM '],
      }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      policy: { mode: 'allowlist', domains: ['api.github.com'] },
    });

    const reflected = await app.request('/admin/api/egress', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(reflected.status, 200);
    assert.deepEqual(await reflected.json(), {
      policy: { mode: 'allowlist', domains: ['api.github.com'] },
    });
  } finally {
    settings.close();
    store.close();
  }
});

test('admin egress API rejects invalid modes, private hosts, and oversized allowlists', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });
    const invalidPolicies = [
      { mode: 'somewhere', domains: [] },
      { mode: 'allowlist', domains: ['10.0.0.1'] },
      { mode: 'allowlist', domains: ['localhost'] },
      // A path/port/query/fragment must be rejected, not silently widened to the
      // whole origin.
      { mode: 'allowlist', domains: ['example.com/private'] },
      { mode: 'allowlist', domains: ['example.com:8443'] },
      { mode: 'allowlist', domains: ['example.com?x=1'] },
      {
        mode: 'allowlist',
        domains: Array.from({ length: 101 }, (_, index) => `api-${index}.example.com`),
      },
    ];

    for (const policy of invalidPolicies) {
      const response = await app.request('/admin/api/egress', {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(policy),
      });
      assert.equal(response.status, 400, JSON.stringify(policy));
      assert.deepEqual(await response.json(), { error: 'invalid_request' });
    }
  } finally {
    settings.close();
    store.close();
  }
});

test('admin API validates skills: rejects whitespace-only description and duplicate names, trims on accept', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const post = (body: unknown) =>
      app.request('/admin/api/agents', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // A whitespace-only description would pass a naive minLength(1) but throws at
    // defineSkill (which trims) — the write boundary must reject it up front.
    const whitespace = await post(
      agent({
        id: 'agent_ws',
        model: 'local-stub/x',
        skills: [{ name: 'ok-name', description: '   ', instructions: '# body', enabled: true }],
      }),
    );
    assert.equal(whitespace.status, 400);

    // Duplicate skill names are a runtime turn-killer — reject at the boundary.
    const dup = await post(
      agent({
        id: 'agent_dup',
        model: 'local-stub/x',
        skills: [
          { name: 'dupe', description: 'a', instructions: 'x', enabled: true },
          { name: 'dupe', description: 'b', instructions: 'y', enabled: true },
        ],
      }),
    );
    assert.equal(dup.status, 400);

    // A valid skill with padded values is accepted and stored trimmed.
    const ok = await post(
      agent({
        id: 'agent_ok',
        model: 'local-stub/x',
        skills: [
          { name: 'good-skill', description: '  Trim me.  ', instructions: '  # body  ', enabled: true },
        ],
      }),
    );
    assert.equal(ok.status, 201);
    const created = (await ok.json()) as { agent: { skills: Array<{ description: string; instructions: string }> } };
    assert.equal(created.agent.skills[0]?.description, 'Trim me.');
    assert.equal(created.agent.skills[0]?.instructions, '# body');
  } finally {
    store.close();
  }
});

test('admin API rejects unpinned agents that cannot resolve a model in the current environment', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        SLACK_TAG_MODEL: undefined,
      },
      async () => {
        const app = appWithAdmin(store);
        const response = await app.request('/admin/api/agents', {
          method: 'POST',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify({
            ...agent(),
            model: undefined,
          }),
        });

        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), {
          error: 'model_not_resolvable',
          message:
            'No model pinned for agent agent_admin. Pin a model in /admin (Agents -> Model), or set SLACK_TAG_MODEL for offline/dev unpinned-agent fallback.',
        });
      },
    );
  } finally {
    store.close();
  }
});

test('admin API accepts an unpinned agent only when SLACK_TAG_MODEL is set', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        SLACK_TAG_MODEL: 'local-stub/admin-fallback',
        ANTHROPIC_API_KEY: 'anthropic-key',
        CLOUDFLARE_API_TOKEN: 'cf-token',
        CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      },
      async () => {
        const app = appWithAdmin(store);
        const createdAgent = agent();
        delete createdAgent.model;
        const response = await app.request('/admin/api/agents', {
          method: 'POST',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify(createdAgent),
        });

        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { agent: createdAgent });
      },
    );
  } finally {
    store.close();
  }
});

test('admin API reports every Agent reference before disable or atomic delete', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    await store.createAgent(agent());
    await store.putAssignment({
      workspaceId: 'T_ADMIN',
      channelId: 'C_ADMIN',
      agentId: 'agent_admin',
    });

    const response = await app.request('/admin/api/agents/agent_admin', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'agent_still_referenced',
      references: {
        agentId: 'agent_admin',
        channelAssignments: [{ workspaceId: 'T_ADMIN', channelId: 'C_ADMIN' }],
        dmIdentityIds: [],
        identityReferenceIds: [],
      },
    });
  } finally {
    store.close();
  }
});

test('admin API projects live frozen thread roots and blocks Agent deletion', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const roots = [{
    threadKey: 'T_ADMIN:C_FROZEN:1710000000.000100',
    agentId: 'agent_admin',
    lastActivityAt: 1_800_000_000_000,
  }];
  const snapshots: AgentSnapshotStore = {
    async get() { return undefined; },
    async putIfAbsent(_threadKey, snapshot) { return snapshot; },
    async listLiveRootsByAgent(agentId) {
      return agentId === 'agent_admin' ? roots : [];
    },
  };
  try {
    await store.createAgent(agent());
    const app = appWithAdminOptions(store, { snapshots });

    const getResponse = await app.request('/admin/api/agents/agent_admin', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(getResponse.status, 200);
    const getBody = await getResponse.json() as {
      agent: { deletion: { blocked: boolean; liveSnapshotRoots: unknown[] } };
    };
    const expectedRoots = [{
      threadKey: roots[0]!.threadKey,
      workspaceId: 'T_ADMIN',
      channelId: 'C_FROZEN',
      threadTs: '1710000000.000100',
      lastActivityAt: roots[0]!.lastActivityAt,
      channelHref: '/admin/channels/T_ADMIN/C_FROZEN',
    }];
    assert.equal(getBody.agent.deletion.blocked, true);
    assert.deepEqual(getBody.agent.deletion.liveSnapshotRoots, expectedRoots);

    const deleteResponse = await app.request('/admin/api/agents/agent_admin', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(deleteResponse.status, 409);
    assert.deepEqual(await deleteResponse.json(), {
      error: 'agent_live_snapshot_roots',
      agentId: 'agent_admin',
      roots: expectedRoots,
    });
    assert.equal((await store.getAgent('agent_admin')).id, 'agent_admin');
  } finally {
    store.close();
  }
});

test('admin API reports Slack DM identity blockers for Agent disable and delete', async () => {
  const profileId = 'agent_dm_handler';
  const identityId = 'slack_identity_dm_handler';
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(agent({ id: profileId, name: 'DM Handler' }));
    await store.createSlackIdentity({
      id: identityId,
      ingressKey: 'identity_ingress_dm_handler_0123456789abcdef',
      kind: 'dedicated',
      lifecycle: 'connected',
      teamId: 'T_ADMIN',
      appId: 'A0DMHANDLER',
      botUserId: 'U_DM_HANDLER',
      dmState: 'on',
      dmAgentId: profileId,
      credentialProvenance: 'stored',
      connectionRevision: 1,
      health: 'healthy',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
    const app = appWithAdminOptions(store, { settings });
    const disableExpected = {
      error: 'agent_still_referenced',
      references: [`DM:${identityId}`],
    };
    const deleteExpected = {
      error: 'agent_still_referenced',
      references: {
        agentId: profileId,
        channelAssignments: [],
        dmIdentityIds: [identityId],
        identityReferenceIds: [],
      },
    };

    const disabled = await app.request(`/admin/api/agents/${profileId}`, {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, enabled: false }),
    });
    assert.equal(disabled.status, 409);
    assert.deepEqual(await disabled.json(), disableExpected);
    assert.equal((await store.getAgent(profileId)).enabled, true);

    const deleted = await app.request(`/admin/api/agents/${profileId}`, {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(deleted.status, 409);
    assert.deepEqual(await deleted.json(), deleteExpected);
    assert.equal((await store.getAgent(profileId)).id, profileId);
  } finally {
    settings.close();
    store.close();
  }
});

test('admin API rejects patches that leave an agent without a resolvable model', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        SLACK_TAG_MODEL: undefined,
      },
      async () => {
        const app = appWithAdmin(store);
        const unpinnedAgent: CustomAgentConfig = {
          id: 'agent_admin',
          revision: 1,
          name: 'Admin Agent',
          instructions: 'Use admin-managed instructions.',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        };
        await store.createAgent(unpinnedAgent);

        const response = await app.request('/admin/api/agents/agent_admin', {
          method: 'PATCH',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: 1, description: 'Still unresolvable after patch.' }),
        });

        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), {
          error: 'model_not_resolvable',
          message:
            'No model pinned for agent agent_admin. Pin a model in /admin (Agents -> Model), or set SLACK_TAG_MODEL for offline/dev unpinned-agent fallback.',
        });
      },
    );
  } finally {
    store.close();
  }
});

test('onboarding API derives live stages and completes only after a delivered selected-channel mention', async () => {
  const store = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  let delivered: WorkRunListItem | undefined;
  let onboardingChannelMember = true;
  const work = {
    async listRuns() {
      return { items: delivered ? [delivered] : [], nextCursor: null };
    },
  } as unknown as WorkStore;
  try {
    const journey = await beginOnboardingJourney(settings, 1_800_000_000_000);
    const app = appWithAdminOptions(store, {
      settings,
      work,
      slackConversationsInfo: async (_botToken, channelId) => ({
        ok: true,
        error: undefined,
        channel: {
          id: channelId,
          name: 'start-here',
          isPrivate: false,
          isMember: onboardingChannelMember,
        },
        facts: undefined,
        retryAfterMs: undefined,
      }),
    });

    const disconnected = await app.request('/admin/api/onboarding', { headers: auth(ADMIN_TOKEN) });
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json() as { stage: string }).stage, 'connect_slack');

    const identity = await store.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
    await store.updateSlackIdentity(identity.id, identity.connectionRevision, {
      lifecycle: 'connected',
      teamId: 'TDESIGN',
      botUserId: 'U_CHICKPEA',
      credentialProvenance: 'stored',
      health: 'healthy',
    });
    await settings.applySettingsPatch({
      set: [
        { key: SLACK_SETTING_KEYS.botToken, value: 'xoxb-test' },
        { key: SLACK_SETTING_KEYS.signingSecret, value: 'signing-test' },
        { key: SLACK_SETTING_KEYS.botUserId, value: 'U_CHICKPEA' },
        { key: SLACK_SETTING_KEYS.teamId, value: 'TDESIGN' },
        { key: SLACK_SETTING_KEYS.teamName, value: 'Acme Inc' },
      ],
    });

    const choose = await app.request('/admin/api/onboarding', { headers: auth(ADMIN_TOKEN) });
    assert.equal(choose.status, 200);
    const chooseBody = await choose.json() as { stage: string; revision: string };
    assert.equal(chooseBody.stage, 'choose_channel');
    assert.equal(chooseBody.revision, journey.revision);

    await store.putChannel({
      workspaceId: 'TDESIGN',
      channelId: 'CSTART',
      label: 'start-here',
      participationMode: 'ambient',
      lifecycle: 'active',
    });
    await store.putAssignment({
      workspaceId: 'TDESIGN',
      channelId: 'CSTART',
      agentId: 'agent_default',
    });
    onboardingChannelMember = false;
    const notJoined = await app.request('/admin/api/onboarding/try', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: chooseBody.revision,
        workspaceId: 'TDESIGN',
        channelId: 'CSTART',
        channelName: 'start-here',
      }),
    });
    assert.equal(notJoined.status, 409);
    assert.deepEqual(await notJoined.json(), { error: 'slack_channel_membership_required' });

    onboardingChannelMember = true;
    const started = await app.request('/admin/api/onboarding/try', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: chooseBody.revision,
        workspaceId: 'TDESIGN',
        channelId: 'CSTART',
        channelName: 'client-label-is-not-authoritative',
      }),
    });
    assert.equal(started.status, 200);
    const startedBody = await started.json() as {
      stage: string;
      channel: { id: string; name: string };
      tryStartedAt: number;
    };
    assert.equal(startedBody.stage, 'try');
    assert.deepEqual(startedBody.channel, { id: 'CSTART', name: 'start-here' });

    const stillTrying = await app.request('/admin/api/onboarding', { headers: auth(ADMIN_TOKEN) });
    assert.equal((await stillTrying.json() as { stage: string }).stage, 'try');

    delivered = deliveredOnboardingRun('TDESIGN', 'CSTART', startedBody.tryStartedAt + 1);
    const complete = await app.request('/admin/api/onboarding', { headers: auth(ADMIN_TOKEN) });
    assert.equal(complete.status, 200);
    assert.equal((await complete.json() as { stage: string }).stage, 'complete');
  } finally {
    settings.close();
    store.close();
  }
});

test('onboarding Try can be explicitly completed without a Slack reply', async () => {
  const store = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const begun = await beginOnboardingJourney(settings, 1_800_000_000_000);
    const started = await startOnboardingTry(settings, {
      expectedRevision: begun.revision,
      agentId: 'agent_default',
      workspaceId: 'TDESIGN',
      channelId: 'CSTART',
      channelName: 'start-here',
      tryStartedAt: 1_800_000_001_000,
    });
    const app = appWithAdminOptions(store, { settings });
    const response = await app.request('/admin/api/onboarding/complete', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: started.revision }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { stage: string; agentId: string; redirectTo: string };
    assert.equal(body.stage, 'complete');
    assert.equal(body.agentId, 'agent_default');
    assert.equal(body.redirectTo, '/admin/agents/agent_default');

    const replay = await app.request('/admin/api/onboarding/complete', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: started.revision }),
    });
    assert.equal(replay.status, 409);
    assert.deepEqual(await replay.json(), { error: 'onboarding_changed' });
  } finally {
    settings.close();
    store.close();
  }
});

test('admin API supports agent and assignment CRUD with the admin token', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const createdAgent = agent();

    const createAgent = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(createdAgent),
    });
    assert.equal(createAgent.status, 201);
    assert.deepEqual(await createAgent.json(), { agent: createdAgent });

    const patchAgent = await app.request('/admin/api/agents/agent_admin', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        instructions: 'Updated runtime instructions.',
        model: 'local-stub/admin-updated',
      }),
    });
    assert.equal(patchAgent.status, 200);
    const patchedBody = await patchAgent.json() as {
      agent: CustomAgentConfig & { tabs: string[] };
    };
    assert.equal(patchedBody.agent.revision, 2);
    assert.equal(patchedBody.agent.instructions, 'Updated runtime instructions.');
    assert.equal(patchedBody.agent.model, 'local-stub/admin-updated');
    assert.deepEqual(patchedBody.agent.tabs, [
      'instructions', 'skills', 'connectors', 'repositories', 'memory',
    ]);

    const stalePatch = await app.request('/admin/api/agents/agent_admin', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, name: 'Lost concurrent draft' }),
    });
    assert.equal(stalePatch.status, 409);
    assert.deepEqual(await stalePatch.json(), {
      error: 'agent_revision_conflict',
      agentId: 'agent_admin',
      expectedRevision: 1,
      actualRevision: 2,
    });
    assert.equal((await store.getAgent('agent_admin')).name, createdAgent.name);

    const getAgent = await app.request('/admin/api/agents/agent_admin', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(getAgent.status, 200);
    assert.equal(((await getAgent.json()) as { agent: CustomAgentConfig }).agent.model, 'local-stub/admin-updated');

    const putAssignment = await app.request('/admin/api/assignments', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        agentId: 'agent_admin',
        enabled: true,
        channelLabel: 'eng-releases',
        channelPromptAddendum: 'Admin channel addendum.',
      }),
    });
    assert.equal(putAssignment.status, 200);
    assert.deepEqual(await putAssignment.json(), {
      assignment: {
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        agentId: 'agent_admin',
        enabled: true,
        channelLabel: 'eng-releases',
        channelPromptAddendum: 'Admin channel addendum.',
        participationMode: 'ambient',
      },
      channel: {
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        label: 'eng-releases',
        additionalInstructions: 'Admin channel addendum.',
        participationMode: 'ambient',
        lifecycle: 'active',
      },
    });

    const getAssignment = await app.request(
      '/admin/api/assignments?workspaceId=T_ADMIN&channelId=C_ADMIN',
      { headers: auth(ADMIN_TOKEN) },
    );
    assert.equal(getAssignment.status, 200);
    assert.deepEqual(await getAssignment.json(), {
      assignment: {
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        agentId: 'agent_admin',
        enabled: true,
        channelLabel: 'eng-releases',
        channelPromptAddendum: 'Admin channel addendum.',
        participationMode: 'ambient',
      },
    });

    const listAssignments = await app.request('/admin/api/assignments', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(listAssignments.status, 200);
    assert.deepEqual(await listAssignments.json(), {
      assignments: [
        {
          workspaceId: 'T_ADMIN',
          channelId: 'C_ADMIN',
          agentId: 'agent_admin',
          enabled: true,
          channelLabel: 'eng-releases',
          channelPromptAddendum: 'Admin channel addendum.',
          participationMode: 'ambient',
        },
      ],
    });

    const deleteAssignment = await app.request(
      '/admin/api/assignments?workspaceId=T_ADMIN&channelId=C_ADMIN',
      { method: 'DELETE', headers: auth(ADMIN_TOKEN) },
    );
    assert.equal(deleteAssignment.status, 204);

    const deleteAgent = await app.request('/admin/api/agents/agent_admin', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(deleteAgent.status, 204);
  } finally {
    store.close();
  }
});

test('main app owns the authenticated admin route without a Flue HTTP router', async () => {
  await withEnv(
    {
      TAG_ADMIN_TOKEN: 'mounted-admin-token',
      SLACK_STATE_DB_PATH: ':memory:',
    },
    async () => {
      const response = await flueApp.request('/admin/api/agents', {
        headers: auth('mounted-admin-token'),
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as { agents?: unknown };
      assert.equal(Array.isArray(body.agents), true);
    },
  );
});

test('admin API accepts a free-text model with an unknown provider prefix but warns', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const freeTextAgent = agent({ id: 'agent_free_text', model: 'anthropc/claude-sonnet-4-6' });

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(freeTextAgent),
    });

    // Warn, never block: the provider registry approximates the runtime's real
    // provider surface, so unknown prefixes save fine — with a visible warning
    // instead of a false all-clear.
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      agent: freeTextAgent,
      warnings: [
        { code: 'unknown_provider', provider: 'anthropc', knownProviders: ['local-stub'] },
      ],
    });
  } finally {
    store.close();
  }
});

test('admin API exposes model suggestions for configured provider sources', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        const app = appWithAdmin(store);

        const response = await app.request('/admin/api/models', {
          headers: auth(ADMIN_TOKEN),
        });

        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          automatic?: unknown;
          providers: Array<{ id: string; configured: boolean; suggestions: string[] }>;
        };
        assert.equal(body.automatic, undefined);
        assert.equal(Object.hasOwn(body, 'defaultModels'), false);
        assert.equal(
          body.providers.some(
            (provider) =>
              provider.id === 'anthropic' &&
              provider.configured &&
              provider.suggestions.includes('anthropic/claude-fable-5'),
          ),
          true,
        );
        // Custom (non-catalog) providers advertise no fabricated suggestions.
        assert.equal(
          body.providers.some(
            (provider) =>
              provider.id === 'local-stub' &&
              provider.configured &&
              provider.suggestions.length === 0,
          ),
          true,
        );
      },
    );
  } finally {
    store.close();
  }
});

test('model catalog admin routes expose safe status, force refresh, and an exact kill switch', async (t) => {
  resetModelCatalogActivationForTests();
  t.after(resetModelCatalogActivationForTests);
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  t.after(() => settings.close());
  const forced: boolean[] = [];
  const forwarded: Array<{
    now: number | undefined;
    random: number | undefined;
    ownerId: string | undefined;
    timeoutMs: number | undefined;
    hasFetch: boolean;
  }> = [];
  const catalogFetch: typeof fetch = async () => new Response(null, { status: 304 });
  const app = appWithAdminOptions(store, {
    settings,
    modelCatalogRefresh: async (options) => {
      forced.push(options.force === true);
      forwarded.push({
        now: options.now?.(),
        random: options.random?.(),
        ownerId: options.ownerId,
        timeoutMs: options.timeoutMs,
        hasFetch: options.fetch === catalogFetch,
      });
      return { status: 'activated', revision: 0 };
    },
    modelCatalogNow: () => 1234,
    modelCatalogRandom: () => 0.25,
    modelCatalogOwnerId: () => 'admin-catalog-owner',
    modelCatalogFetch: catalogFetch,
    modelCatalogTimeoutMs: 321,
  });

  const unauthorized = await app.request('/admin/api/model-catalog');
  assert.equal(unauthorized.status, 401);

  const status = await app.request('/admin/api/model-catalog', {
    headers: auth(ADMIN_TOKEN),
  });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    mode: 'hosted',
    source: 'bundled',
    revision: 0,
    generatedAt: null,
    checkedAt: null,
    nextRefreshAt: null,
    lkgAvailable: false,
  });

  const invalidMode = await app.request('/admin/api/model-catalog/mode', {
    method: 'PUT',
    headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'bundled', extra: true }),
  });
  assert.equal(invalidMode.status, 400);

  const bundled = await app.request('/admin/api/model-catalog/mode', {
    method: 'PUT',
    headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'bundled' }),
  });
  assert.equal(bundled.status, 200);
  assert.equal(await settings.getSetting('model.catalog.mode'), 'bundled');
  assert.deepEqual(forced, []);

  const hosted = await app.request('/admin/api/model-catalog/mode', {
    method: 'PUT',
    headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'hosted' }),
  });
  assert.equal(hosted.status, 200);
  assert.equal(await settings.getSetting('model.catalog.mode'), 'hosted');

  const refresh = await app.request('/admin/api/model-catalog/refresh', {
    method: 'POST',
    headers: auth(ADMIN_TOKEN),
  });
  assert.equal(refresh.status, 200);
  assert.deepEqual(forced, [true, true]);
  assert.deepEqual(forwarded, [
    { now: 1234, random: 0.25, ownerId: 'admin-catalog-owner', timeoutMs: 321, hasFetch: true },
    { now: 1234, random: 0.25, ownerId: 'admin-catalog-owner', timeoutMs: 321, hasFetch: true },
  ]);
});

test('model list routes refresh with the requested force and retain active inventory on failure', async (t) => {
  resetModelCatalogActivationForTests();
  t.after(resetModelCatalogActivationForTests);
  activateAdminCatalog(70, [{
    canonical: 'openai/gpt-admin-hosted',
    displayName: 'GPT Admin Hosted',
    lanes: { subscription: 'openai-codex-responses-standard@1' },
  }, {
    canonical: 'openai/gpt-admin-api-hosted',
    displayName: 'GPT Admin API Hosted',
    lanes: { apiKey: 'openai-platform-responses-terra-tier@1' },
  }, {
    canonical: 'anthropic/claude-admin-api-hosted',
    displayName: 'Claude Admin API Hosted',
    lanes: { apiKey: 'anthropic-messages-sonnet-tier@1' },
  }], 'b');
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  t.after(() => settings.close());
  await settings.setSetting('provider.openai.authMethod', 'subscription');
  const forced: boolean[] = [];
  const app = appWithAdminOptions(store, {
    settings,
    modelCatalogRefresh: async (options) => {
      forced.push(options.force === true);
      return { status: 'failed', revision: 70, code: 'unavailable' };
    },
  });

  const models = await app.request('/admin/api/models', { headers: auth(ADMIN_TOKEN) });
  assert.equal(models.status, 200);
  const modelBody = (await models.json()) as {
    providers: Array<{ id: string; suggestions: string[] }>;
  };
  assert.equal(
    modelBody.providers.find((provider) => provider.id === 'openai')?.suggestions.includes(
      'openai/gpt-admin-api-hosted',
    ),
    true,
  );
  assert.equal(await settings.getSetting('provider.openai.authMethod'), 'api_key');

  const openAiModels = await app.request('/admin/api/providers/openai/models?refresh=1', {
    headers: auth(ADMIN_TOKEN),
  });
  assert.equal(openAiModels.status, 409);

  await settings.setSetting('provider.openai.authMethod', 'api_key');
  const apiKeyModels = await app.request('/admin/api/models', { headers: auth(ADMIN_TOKEN) });
  const apiKeyBody = (await apiKeyModels.json()) as {
    providers: Array<{ id: string; suggestions: string[] }>;
  };
  assert.equal(
    apiKeyBody.providers.find((provider) => provider.id === 'openai')?.suggestions.includes(
      'openai/gpt-admin-api-hosted',
    ),
    true,
  );
  assert.equal(
    apiKeyBody.providers.find((provider) => provider.id === 'anthropic')?.suggestions.includes(
      'anthropic/claude-admin-api-hosted',
    ),
    true,
  );

  const anthropic = await app.request('/admin/api/providers/anthropic/models?refresh=1', {
    headers: auth(ADMIN_TOKEN),
  });
  assert.equal(anthropic.status, 409);

  const failedRefresh = await app.request('/admin/api/model-catalog/refresh', {
    method: 'POST',
    headers: auth(ADMIN_TOKEN),
  });
  assert.equal(failedRefresh.status, 200);
  const failedRefreshBody = (await failedRefresh.json()) as {
    refresh: { status: string };
    catalog: { source: string; revision: number };
  };
  assert.equal(failedRefreshBody.refresh.status, 'failed');
  assert.deepEqual(failedRefreshBody.catalog, {
    mode: 'hosted',
    source: 'hosted',
    revision: 70,
    generatedAt: null,
    checkedAt: null,
    nextRefreshAt: null,
    lkgAvailable: false,
  });
  assert.deepEqual(forced, [false, true, false, true, true]);
  assert.equal(activeModelCatalogSnapshot().revision, 70);
});

test('profile writes reject retired OpenAI Subscription-only models and admit the Anthropic API-key lane', async (t) => {
  resetModelCatalogActivationForTests();
  t.after(resetModelCatalogActivationForTests);
  const catalogEntries = [
    {
      canonical: 'openai/gpt-admin-subscription-only',
      lanes: { subscription: 'openai-codex-responses-standard@1' },
    },
    {
      canonical: 'anthropic/claude-admin-hosted',
      lanes: { apiKey: 'anthropic-messages-sonnet-tier@1' },
    },
  ];
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  t.after(() => settings.close());
  await persistAdminCatalog(settings, 71, catalogEntries);
  await settings.setSetting('provider.openai.authMethod', 'subscription');
  const app = appWithAdminOptions(store, { settings });

  const rejectedOpenAi = await app.request('/admin/api/agents', {
    method: 'POST',
    headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify(agent({
      id: 'agent_catalog_openai',
      model: 'openai/gpt-admin-subscription-only',
    })),
  });
  assert.equal(rejectedOpenAi.status, 400);
  assert.match(
    ((await rejectedOpenAi.json()) as { message: string }).message,
    /API-key catalog does not support/i,
  );

  const acceptedAnthropic = await app.request('/admin/api/agents', {
    method: 'POST',
    headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify(agent({
      id: 'agent_catalog_anthropic',
      model: 'anthropic/claude-admin-hosted',
    })),
  });
  assert.equal(acceptedAnthropic.status, 201);

  const rejectedAnthropic = await app.request('/admin/api/agents', {
    method: 'POST',
    headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify(agent({
      id: 'agent_catalog_anthropic_bad',
      model: 'anthropic/claude-not-admitted',
    })),
  });
  assert.equal(rejectedAnthropic.status, 400);

  await settings.setSetting('provider.openai.authMethod', 'api_key');
  const rejectedWrongLane = await app.request('/admin/api/agents', {
    method: 'POST',
    headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify(agent({
      id: 'agent_catalog_openai_wrong_lane',
      model: 'openai/gpt-admin-subscription-only',
    })),
  });
  assert.equal(rejectedWrongLane.status, 400);
  assert.match(
    ((await rejectedWrongLane.json()) as { message: string }).message,
    /API-key catalog does not support/i,
  );
});

test('effective config endpoint resolves through the runtime assignment path', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const identityId = 'slack_identity_admin_effective';
    await store.createSlackIdentity({
      id: identityId,
      ingressKey: 'identity_ingress_admin_effective_0123456789abcdef',
      kind: 'dedicated',
      lifecycle: 'connected',
      teamId: 'T_ADMIN',
      appId: 'A0ADMINEFFECTIVE',
      botUserId: 'U_ADMIN_EFFECTIVE',
      dmState: 'off',
      credentialProvenance: 'stored',
      connectionRevision: 1,
      health: 'healthy',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
    await store.createAgent(
      agent({
        instructions: 'Base profile instructions from the admin test.',
        model: 'local-stub/effective-model',
        skills: [],
        slackIdentityId: identityId,
      }),
    );
    await store.putChannel({
      workspaceId: 'T_ADMIN',
      channelId: 'C_ADMIN',
      additionalInstructions: 'Channel addendum from the admin test.',
      participationMode: 'ambient',
      lifecycle: 'active',
    });
    await store.putAssignment({
      workspaceId: 'T_ADMIN',
      channelId: 'C_ADMIN',
      agentId: 'agent_admin',
    });

    const response = await app.request(
      '/admin/api/effective-config?workspaceId=T_ADMIN&channelId=C_ADMIN',
      { headers: auth(ADMIN_TOKEN) },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      config: {
        agentId: string;
        slackIdentityId: string;
        model: string;
        provider: string;
        instructions: string;
        instructionLayers: Array<{ source: string; text: string }>;
      };
    };
    assert.equal(body.config.agentId, 'agent_admin');
    assert.equal(body.config.slackIdentityId, identityId);
    assert.equal(body.config.model, 'local-stub/effective-model');
    assert.equal(body.config.provider, 'local-stub');
    assert.match(body.config.instructions, /Base profile instructions from the admin test\./);
    assert.match(body.config.instructions, /Channel addendum from the admin test\./);
    assert.match(body.config.instructions, /Do not reveal Slack tokens/);
    assert.deepEqual(
      body.config.instructionLayers.map((layer) => layer.source),
      ['interaction_defaults', 'agent', 'channel', 'runtime', 'guardrail'],
    );
  } finally {
    store.close();
  }
});

test('effective config endpoint uses SLACK_TAG_MODEL for an unpinned profile on node', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        SLACK_TAG_MODEL: 'local-stub/node-unpinned-fallback',
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
      },
      async () => {
        const app = appWithAdmin(store);
        const unpinnedAgent = agent({
          id: 'agent_unpinned',
          name: 'Unpinned Agent',
        });
        delete unpinnedAgent.model;
        await store.createAgent(unpinnedAgent);
        await store.putAssignment({
          workspaceId: 'T_ADMIN',
          channelId: 'C_UNPINNED',
          agentId: 'agent_unpinned',
        });

        const response = await app.request(
          '/admin/api/effective-config?workspaceId=T_ADMIN&channelId=C_UNPINNED',
          { headers: auth(ADMIN_TOKEN) },
        );

        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          config: { model: string; provider: string; agent: { model: string | null } };
        };
        assert.equal(body.config.agent.model, null);
        assert.equal(body.config.model, 'local-stub/node-unpinned-fallback');
        assert.equal(body.config.provider, 'local-stub');
      },
    );
  } finally {
    store.close();
  }
});

test('admin API clears a pinned model with PATCH model: null', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv({ SLACK_TAG_MODEL: 'local-stub/fallback-after-clear' }, async () => {
      const app = appWithAdmin(store);
      await store.createAgent(agent());

      const response = await app.request('/admin/api/agents/agent_admin', {
        method: 'PATCH',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1, model: null }),
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as { agent: CustomAgentConfig };
      assert.equal('model' in body.agent, false);
      assert.equal('model' in (await store.getAgent('agent_admin')), false);
    });
  } finally {
    store.close();
  }
});

test('admin API maps an assignment to a missing agent to a stable unknown_agent error', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const response = await app.request('/admin/api/assignments', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        agentId: 'agent_missing',
        enabled: true,
      }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'unknown_agent' });
  } finally {
    store.close();
  }
});

// --- API Connections -----------------------------------------------------------

test('admin API accepts exact apiConnection hosts and round-trips every field', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const connection = apiConnection({ allowedHosts: ['api.linear.app'] });
    const createdAgent = agent({ id: 'agent_api_connection', apiConnections: [connection] });

    const create = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(createdAgent),
    });
    assert.equal(create.status, 201);
    assert.deepEqual(await create.json(), { agent: createdAgent });

    const patched = [
      apiConnection({
        displayName: 'Linear API v2',
        allowedHosts: ['api.example.com'],
        pathPrefixes: ['/v2/issues'],
        headerName: 'X-Api-Key',
        headerValuePrefix: 'token ',
        allowedMethods: ['HEAD', 'PUT', 'PATCH', 'DELETE'],
        enabled: false,
        presetId: 'linear-api-v2',
      }),
    ];
    const patch = await app.request('/admin/api/agents/agent_api_connection', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, apiConnections: patched }),
    });
    assert.equal(patch.status, 200);
    const body = (await patch.json()) as { agent: CustomAgentConfig };
    assert.deepEqual(body.agent.apiConnections, patched);
  } finally {
    store.close();
  }
});

test('admin API rejects invalid apiConnection hosts, methods, and header names', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const post = (id: string, connections: unknown) =>
      app.request('/admin/api/agents', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(
          agent({ id, apiConnections: connections as ApiConnectionConfig[] }),
        ),
      });

    const cases: Array<[string, ApiConnectionConfig]> = [
      ['private_host', apiConnection({ allowedHosts: ['10.0.0.1'] })],
      ['localhost', apiConnection({ allowedHosts: ['localhost'] })],
      ['wildcard_host', apiConnection({ allowedHosts: ['*.example.com'] })],
      ['empty_hosts', apiConnection({ allowedHosts: [] })],
      ['bad_method', apiConnection({ allowedMethods: ['TRACE'] })],
      ['bad_header', apiConnection({ headerName: 'Authorization:' })],
    ];
    for (const [id, connection] of cases) {
      const response = await post(`agent_api_${id}`, [connection]);
      assert.equal(response.status, 400, id);
    }

    for (const host of ['github.com', 'API.GITHUB.COM', 'api.github.com.']) {
      const response = await post(
        `agent_api_reserved_github_${host.replaceAll('.', '_').toLowerCase()}`,
        [apiConnection({ allowedHosts: [host] })],
      );
      assert.equal(response.status, 400, host);
      assert.deepEqual(await response.json(), {
        error: 'invalid_request',
        message:
          'GitHub is managed by the GitHub App integration; connect it in Settings → GitHub',
      });
    }
  } finally {
    store.close();
  }
});

test('admin API accepts exact Google OAuth policy and rejects client-side widening', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const valid = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(agent({ id: 'agent_google', apiConnections: [googleApiConnection()] })),
    });
    assert.equal(valid.status, 201);
    const created = (await valid.json()) as { agent: CustomAgentConfig };
    assert.deepEqual(created.agent.apiConnections, [googleApiConnection()]);

    const widened = await app.request('/admin/api/agents/agent_google', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        apiConnections: [
          googleApiConnection(undefined, {
            allowedHosts: ['gmail.googleapis.com', 'www.googleapis.com', 'evil.example.com'],
          }),
        ],
      }),
    });
    assert.equal(widened.status, 400);
  } finally {
    store.close();
  }
});

test('editing Google OAuth scopes invalidates old tokens and resets connection status', async () => {
  const originalScopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  const nextScopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ];
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({
      id: 'agent_google',
      apiConnections: [googleApiConnection(originalScopes, {
        lifecycleStatus: 'ready',
        statusText: 'Connected',
        identity: { accountName: 'original@example.com' },
      })],
    })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const [clientKey, , tokenKey] = apiOAuthSettingKeys(REF_FOR_TEST);
    await settings.setSetting(clientKey, 'stored-client-record');
    await settings.setSetting(tokenKey, 'stored-old-scope-token');
    const app = appWithAdminOptions(store, { settings });
    const response = await app.request('/admin/api/agents/agent_google', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        apiConnections: [googleApiConnection(nextScopes, {
          lifecycleStatus: 'ready',
          statusText: 'Connected',
          identity: { accountName: 'spoofed@example.com' },
        })],
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { agent: CustomAgentConfig };
    assert.deepEqual(body.agent.apiConnections, [googleApiConnection(nextScopes, {
      lifecycleStatus: 'pending',
      statusText: 'Not connected',
    })]);
    assert.equal(await settings.getSetting(clientKey), 'stored-client-record');
    assert.equal(await settings.getSetting(tokenKey), undefined);
  } finally {
    settings.close();
    store.close();
  }
});

test('removing Google OAuth policy through the profile API deletes its stored OAuth state', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_google', apiConnections: [googleApiConnection()] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    for (const [index, key] of apiOAuthSettingKeys(REF_FOR_TEST).entries()) {
      await settings.setSetting(key, `oauth-setting-${index}`);
    }
    const app = appWithAdminOptions(store, { settings });
    const response = await app.request('/admin/api/agents/agent_google', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, apiConnections: [] }),
    });

    assert.equal(response.status, 200);
    assert.ok(
      (await settings.getSettings(apiOAuthSettingKeys(REF_FOR_TEST))).every(
        (value) => value === undefined,
      ),
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('Google OAuth client credentials are write-only and start uses saved profile policy', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_google', apiConnections: [googleApiConnection()] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const starts: Array<Record<string, unknown>> = [];
  try {
    await settings.setSetting(
      connectorCredentialSettingKey('agent_google', 'google-workspace'),
      'legacy-static-token',
    );
    await settings.setSetting(
      apiOAuthSettingKeys(REF_FOR_TEST)[2],
      'old-client-token-bundle',
    );
    const app = appWithAdminOptions(store, {
      settings,
      startApiOAuth: async (input) => {
        starts.push(input);
        return {
          authorizationUrl: new URL('https://accounts.google.com/o/oauth2/v2/auth?state=opaque'),
          state: 'must-not-cross-api',
        };
      },
    });
    const clientResponse = await app.request(
      '/admin/api/agents/agent_google/api-connections/oauth/google-workspace/client',
      {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
        }),
      },
    );
    assert.equal(clientResponse.status, 200);
    assert.deepEqual(await clientResponse.json(), { source: 'stored' });
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_google', 'google-workspace'),
      ),
      undefined,
    );
    assert.equal(
      await settings.getSetting(apiOAuthSettingKeys(REF_FOR_TEST)[2]),
      undefined,
    );
    assert.doesNotMatch(await (await app.request('/admin/api/agents/agent_google', {
      headers: auth(ADMIN_TOKEN),
    })).text(), /google-client-secret|google-client-id/);

    const rejectedStaticCredential = await app.request(
      '/admin/api/agents/agent_google/api-connections/secrets/google-workspace',
      {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'must-not-replace-oauth' }),
      },
    );
    assert.equal(rejectedStaticCredential.status, 404);

    const start = await app.request(
      'https://chickpea.example.test/admin/api/agents/agent_google/api-connections/oauth/google-workspace/start',
      { method: 'POST', headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
    });
    assert.deepEqual(starts, [{
      ref: { agentId: 'agent_google', connectionId: 'google-workspace' },
      provider: 'google',
      callbackUrl: 'https://chickpea.example.test/oauth/api/callback',
      scopes: googleApiConnection().oauthScopes,
    }]);
    const stored = (await settings.getSettings(apiOAuthSettingKeys(REF_FOR_TEST))).join('\n');
    assert.match(stored, /google-client-secret/);
  } finally {
    settings.close();
    store.close();
  }
});

const REF_FOR_TEST = { agentId: 'agent_google', connectionId: 'google-workspace' };

test('Google OAuth callback is public, state-gated, and marks the API connection ready', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_google', apiConnections: [googleApiConnection()] })],
    assignments: [],
  });
  try {
    const app = appWithAdminOptions(store, {
      completeApiOAuth: async ({ state }) => {
        if (state !== 'valid-state') throw new ApiOAuthError('invalid_state', 'invalid');
        return {
          ref: REF_FOR_TEST,
          provider: 'google',
          identity: { accountName: 'operator@example.com' },
        };
      },
    });
    const invalid = await app.request('/oauth/api/callback?state=wrong&code=provider-code');
    assert.equal(invalid.status, 400);

    const completed = await app.request(
      '/oauth/api/callback?state=valid-state&code=provider-code',
      { redirect: 'manual' },
    );
    assert.equal(completed.status, 303);
    assert.equal(
      completed.headers.get('location'),
      '/admin/agents/agent_google?oauth=connected&connection=google-workspace&lane=api',
    );
    const saved = await store.getAgent('agent_google');
    assert.deepEqual(saved.apiConnections[0], googleApiConnection(undefined, {
      lifecycleStatus: 'ready',
      statusText: 'Connected',
      identity: { accountName: 'operator@example.com' },
    }));
  } finally {
    store.close();
  }
});

test('Google OAuth callback deletes tokens when the saved connection changes during exchange', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_google', apiConnections: [googleApiConnection()] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    for (const [index, key] of apiOAuthSettingKeys(REF_FOR_TEST).entries()) {
      await settings.setSetting(key, `opaque-setting-${index}`);
    }
    const app = appWithAdminOptions(store, {
      settings,
      completeApiOAuth: async () => {
        await store.updateAgent('agent_google', {
          apiConnections: [apiConnection({ id: 'google-workspace' })],
        });
        return { ref: REF_FOR_TEST, provider: 'google' };
      },
    });

    const completed = await app.request(
      '/oauth/api/callback?state=valid-state&code=provider-code',
      { redirect: 'manual' },
    );
    assert.equal(completed.status, 303);
    assert.equal(
      completed.headers.get('location'),
      '/admin/agents/agent_google?oauth=failed&connection=google-workspace&lane=api',
    );
    assert.ok(
      (await settings.getSettings(apiOAuthSettingKeys(REF_FOR_TEST))).every(
        (value) => value === undefined,
      ),
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('API connection secret PUT stores a write-only credential and keeps blank values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_connector',
        apiConnections: [apiConnection({ id: 'linear-api' })],
      }),
    );
    const app = appWithAdminOptions(store, { settings });
    const url = '/admin/api/agents/agent_connector/api-connections/secrets/linear-api';
    const headers = { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' };

    const response = await app.request(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: 'super-secret-credential' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { source: 'stored' });
    assert.doesNotMatch(JSON.stringify(body), /super-secret-credential/);
    assert.equal(
      await describeConnectorCredentialSource(
        'agent_connector',
        'linear-api',
        undefined,
        settings,
      ),
      'stored',
    );
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_connector', 'linear-api'),
      ),
      'super-secret-credential',
    );
    assert.equal(
      await settings.getSetting(connectorSecretCleanupMarkerKey('agent_connector')),
      JSON.stringify(['connector.agent_connector.linear-api.credential']),
    );

    for (const requestBody of [{ credential: '' }, {}]) {
      const keep = await app.request(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(requestBody),
      });
      assert.equal(keep.status, 200);
      assert.deepEqual(await keep.json(), { source: 'stored' });
    }

    const profile = await app.request('/admin/api/agents/agent_connector', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(profile.status, 200);
    assert.doesNotMatch(await profile.text(), /super-secret-credential/);

    const clear = await app.request(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ clearCredential: true }),
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(await clear.json(), { source: 'missing' });
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_connector', 'linear-api'),
      ),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('agent GET reports each API connection credential source, not a blanket "stored"', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({ id: 'agent_connector', apiConnections: [apiConnection({ id: 'linear-api' })] }),
    );
    const app = appWithAdminOptions(store, { settings });
    const readSource = async () => {
      const res = await app.request('/admin/api/agents/agent_connector', {
        headers: auth(ADMIN_TOKEN),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        agent: { apiConnections: Array<{ id: string; credentialSource?: string }> };
      };
      return body.agent.apiConnections[0]?.credentialSource;
    };

    // A persisted connection with no stored secret must NOT claim "stored" —
    // turn-time resolution would skip it, so the editor has to show the truth.
    assert.equal(await readSource(), 'missing');

    await app.request('/admin/api/agents/agent_connector/api-connections/secrets/linear-api', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'super-secret-credential' }),
    });

    assert.equal(await readSource(), 'stored');
  } finally {
    settings.close();
    store.close();
  }
});

test('API connection secret PUT rejects a connection outside the profile', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(agent({ id: 'agent_connector', apiConnections: [apiConnection()] }));
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request(
      '/admin/api/agents/agent_connector/api-connections/secrets/missing-api',
      {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'orphan-secret' }),
      },
    );

    assert.equal(response.status, 404);
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_connector', 'missing-api'),
      ),
      undefined,
    );
    assert.equal(
      await settings.getSetting(connectorSecretCleanupMarkerKey('agent_connector')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('API connection secret PUT removes its write when the profile disappears in flight', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let reads = 0;
  const disappearingStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getAgent') {
        return async (agentId: string) => {
          const current = await target.getAgent(agentId);
          reads += 1;
          if (reads === 1) {
            await target.deleteAgent(agentId);
          }
          return current;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    await store.createAgent(
      agent({ id: 'agent_disappearing_api', apiConnections: [apiConnection()] }),
    );
    const app = appWithAdminOptions(disappearingStore, { settings });

    const response = await app.request(
      '/admin/api/agents/agent_disappearing_api/api-connections/secrets/linear-api',
      {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'late-secret' }),
      },
    );

    assert.equal(response.status, 404);
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_disappearing_api', 'linear-api'),
      ),
      undefined,
    );
    assert.equal(
      await settings.getSetting(connectorSecretCleanupMarkerKey('agent_disappearing_api')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('API connection secret DELETE clears the stored credential and returns its source', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const key = connectorCredentialSettingKey('agent_connector', 'linear-api');
    await settings.setSetting(key, 'stored-secret');
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request(
      '/admin/api/agents/agent_connector/api-connections/secrets/linear-api',
      { method: 'DELETE', headers: auth(ADMIN_TOKEN) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { source: 'missing' });
    assert.equal(await settings.getSetting(key), undefined);
  } finally {
    settings.close();
    store.close();
  }
});

// --- MCP Connections (Task 7) -------------------------------------------------

test('admin API accepts an agent with a valid mcpServers entry and round-trips it', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const createdAgent = agent({
      id: 'agent_mcp',
      mcpServers: [mcpServer({ authMode: 'oauth', oauthScope: 'read write' })],
    });

    const create = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(createdAgent),
    });
    assert.equal(create.status, 201);
    assert.deepEqual(await create.json(), { agent: createdAgent });

    // A PATCH carrying only mcpServers must preserve the array verbatim.
    const patched = [mcpServer({
      id: 'linear-mcp',
      authMode: 'oauth',
      oauthScope: 'read write admin',
      allowedTools: ['search', 'create'],
      identity: {
        workspaceName: 'Engineering workspace',
        accountName: 'Admin user',
      },
    })];
    const patch = await app.request('/admin/api/agents/agent_mcp', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, mcpServers: patched }),
    });
    assert.equal(patch.status, 200);
    const body = (await patch.json()) as { agent: CustomAgentConfig };
    assert.deepEqual(body.agent.mcpServers, patched);
  } finally {
    store.close();
  }
});

test('admin API rejects mcpServers with a bad id, duplicate ids, oversize fields, or a blocked URL', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const post = (id: string, servers: unknown) =>
      app.request('/admin/api/agents', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(agent({ id, mcpServers: servers as McpConnectionConfig[] })),
      });

    const badId = await post('agent_badid', [mcpServer({ id: 'Not_Valid' })]);
    assert.equal(badId.status, 400);

    const dup = await post('agent_dup_mcp', [
      mcpServer({ id: 'dupe' }),
      mcpServer({ id: 'dupe' }),
    ]);
    assert.equal(dup.status, 400);

    const oversize = await post('agent_oversize', [mcpServer({ displayName: 'x'.repeat(81) })]);
    assert.equal(oversize.status, 400);

    // The schema-level v.check runs validateMcpUrl — a private IP literal is
    // rejected at the write boundary, not just at turn time.
    const blocked = await post('agent_blocked', [mcpServer({ url: 'https://10.0.0.1/mcp' })]);
    assert.equal(blocked.status, 400);
  } finally {
    store.close();
  }
});

test('POST /admin/api/agents/:agentId/mcp/test returns discovered tools on success (HTTP 200)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [{ name: 'search', description: 'Search things' }, { name: 'create' }] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        bearerToken: 'tok-from-form',
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      tools: [{ name: 'search', description: 'Search things' }, { name: 'create' }],
    });
    // The transient bearer from the body is applied to the connect headers.
    assert.equal(calls[0]?.headers.Authorization, 'Bearer tok-from-form');
  } finally {
    store.close();
  }
});

test('profile-scoped MCP test resolves OAuth at the request boundary', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const calls: McpConnectInput[] = [];
  const resolutions: ResolveMcpOAuthAccessInput[] = [];
  try {
    const app = appWithAdminOptions(store, {
      resolveMcpOAuthToken: async (input) => {
        resolutions.push(input);
        return 'oauth-access-token';
      },
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'oauth',
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(resolutions, [
      {
        ref: { agentId: 'agent_test', connectionId: 'linear-mcp' },
        serverUrl: 'https://mcp.linear.app/mcp',
      },
    ]);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer oauth-access-token');
  } finally {
    store.close();
  }
});

test('profile-scoped MCP test overrides stored secrets with body-supplied values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.agent_test.linear-mcp.bearer', 'stored-token');
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      settings,
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        bearerToken: 'fresh-token',
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer fresh-token');
  } finally {
    settings.close?.();
    store.close();
  }
});

test('profile-scoped MCP test backs an un-retyped header with its stored value via headerNames', async () => {
  // The connection must exist to hold stored secrets: the secrets PUT route
  // 404s for an unknown connection, so "a stored value with no saved
  // connection" is not a state the app can reach.
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_test', mcpServers: [mcpServer({ headerNames: ['X-Api-Key'] })] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    // Operator stored X-Api-Key earlier; on re-test they don't retype it, but
    // the client sends the header NAME so the server can resolve the stored value.
    await settings.setSetting('mcp.agent_test.linear-mcp.header.X-Api-Key', 'stored-key');
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      settings,
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'none',
        headerNames: ['X-Api-Key'],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0]?.headers['X-Api-Key'], 'stored-key');
  } finally {
    settings.close?.();
    store.close();
  }
});

test('profile-scoped MCP test never sends stored secrets to a URL the connection was not saved against', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_test', mcpServers: [mcpServer({ headerNames: ['X-Api-Key'] })] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.agent_test.linear-mcp.bearer', 'stored-bearer');
    await settings.setSetting('mcp.agent_test.linear-mcp.header.X-Api-Key', 'stored-key');
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      settings,
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    // Same connection id, attacker-chosen host. The stored bearer and header are
    // write-only everywhere else, so replaying them here would be a read-back.
    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://collector.invalid/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        headerNames: ['X-Api-Key'],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers['X-Api-Key'], undefined);
    assert.equal(
      Object.entries(calls[0]?.headers ?? {}).some(
        ([, value]) => typeof value === 'string' && value.includes('stored-'),
      ),
      false,
      'no stored secret may reach a host the connection was not saved against',
    );
  } finally {
    settings.close?.();
    store.close();
  }
});

test('repointing an MCP connection at a new origin drops its stored secrets', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_test', mcpServers: [mcpServer({ headerNames: ['X-Api-Key'] })] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.agent_test.linear-mcp.bearer', 'stored-bearer');
    await settings.setSetting('mcp.agent_test.linear-mcp.header.X-Api-Key', 'stored-key');
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/agents/agent_test', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        mcpServers: [mcpServer({
          url: 'https://collector.example/mcp',
          headerNames: ['X-Api-Key'],
        })],
      }),
    });
    assert.equal(response.status, 200);
    // Secrets are keyed by connection id, so without this they would be sent to
    // the new origin on the next turn.
    assert.equal(await settings.getSetting('mcp.agent_test.linear-mcp.bearer'), undefined);
    assert.equal(
      await settings.getSetting('mcp.agent_test.linear-mcp.header.X-Api-Key'),
      undefined,
    );
  } finally {
    settings.close?.();
    store.close();
  }
});

test('editing an MCP connection without changing its origin keeps its stored secrets', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_test', mcpServers: [mcpServer({ headerNames: ['X-Api-Key'] })] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.agent_test.linear-mcp.bearer', 'stored-bearer');
    const app = appWithAdminOptions(store, { settings });

    // Negative control: a same-origin path/display edit must not force the
    // operator to re-enter a credential they never moved.
    const response = await app.request('/admin/api/agents/agent_test', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        mcpServers: [mcpServer({
          displayName: 'Linear (prod)',
          url: 'https://mcp.linear.app/mcp/v2',
          headerNames: ['X-Api-Key'],
        })],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(await settings.getSetting('mcp.agent_test.linear-mcp.bearer'), 'stored-bearer');
  } finally {
    settings.close?.();
    store.close();
  }
});

test('profile-scoped MCP test classifies a hung connection as timeout (HTTP 200, no raw error)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        throw new Error('connect timeout after 8000ms — raw internal detail');
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'none',
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; code: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'timeout');
    assert.doesNotMatch(body.message, /raw internal detail/);
    assert.doesNotMatch(body.message, /8000ms/);
  } finally {
    store.close();
  }
});

test('admin sandbox state is auth-gated and Node cannot request or enable containers', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });

    for (const [method, path] of [
      ['GET', '/admin/api/sandbox/status'],
      ['POST', '/admin/api/sandbox/install'],
      ['DELETE', '/admin/api/sandbox/install'],
      ['PUT', '/admin/api/sandbox/status'],
    ] as const) {
      const response = await app.request(path, {
        method,
        ...(method === 'PUT'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                enabled: false,
                allowedHosts: [],
                monthlySessionCap: 0,
              }),
            }
          : {}),
      });
      assert.equal(response.status, 401);
    }

    const initial = await app.request('/admin/api/sandbox/status', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      installRequested: false,
      installed: false,
      storedEnabled: false,
      enabled: false,
      instanceType: 'standard-1',
      allowedHosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
      monthlySessionCap: 0,
      monthlySessionCapConfigured: false,
      target: 'node',
      githubConnected: false,
      repositoryGrantReady: false,
      unmetPrerequisites: ['cloudflare_target', 'sandbox_binding', 'github_app', 'repository_grant'],
      workersPaidNote: null,
    });

    const requested = await app.request('/admin/api/sandbox/install', {
      method: 'POST',
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(requested.status, 409);
    assert.deepEqual(await requested.json(), { error: 'sandbox_unsupported' });

    const enable = await app.request('/admin/api/sandbox/status', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        readinessConfirmed: true,
        allowedHosts: [],
        monthlySessionCap: 0,
      }),
    });
    assert.equal(enable.status, 409);
    assert.deepEqual(await enable.json(), { error: 'sandbox_unsupported' });
    assert.equal(await settings.getSetting('sandbox.enabled'), undefined);
  } finally {
    settings.close();
    store.close();
  }
});

test('core Cloudflare install request is idempotent and cancel atomically keeps later redeploy off', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings, identity });
    await withCloudflareUserAgent(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const requested = await app.request('/admin/api/sandbox/install', {
          method: 'POST',
          headers: auth(ADMIN_TOKEN),
        }, {});
        assert.equal(requested.status, 200);
        const body = await requested.json() as Record<string, unknown>;
        assert.equal(body.installRequested, true);
        assert.equal(body.installed, false);
        assert.equal(body.storedEnabled, false);
        assert.equal(body.enabled, false);
      }

      const enable = await app.request('/admin/api/sandbox/status', {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          readinessConfirmed: true,
          allowedHosts: ['registry.npmjs.org'],
          monthlySessionCap: 50,
        }),
      }, {});
      assert.equal(enable.status, 409);
      assert.deepEqual(await enable.json(), { error: 'sandbox_not_installed' });

      // A stale pre-change enabled flag remains visible but is never effective.
      await settings.setSetting('sandbox.enabled', 'true');
      const stale = await app.request('/admin/api/sandbox/status', {
        headers: auth(ADMIN_TOKEN),
      }, {});
      const staleBody = await stale.json() as Record<string, unknown>;
      assert.equal(staleBody.storedEnabled, true);
      assert.equal(staleBody.enabled, false);

      const canceled = await app.request('/admin/api/sandbox/install', {
        method: 'DELETE',
        headers: auth(ADMIN_TOKEN),
      }, {});
      assert.equal(canceled.status, 200);
      const canceledBody = await canceled.json() as Record<string, unknown>;
      assert.equal(canceledBody.installRequested, false);
      assert.equal(canceledBody.storedEnabled, false);
      assert.equal(canceledBody.enabled, false);
      assert.equal(await settings.getSetting('sandbox.installRequested'), undefined);
      assert.equal(await settings.getSetting('sandbox.enabled'), undefined);

      // A later Sandbox-profile redeploy cannot revive the canceled setting.
      const afterRedeploy = await app.request('/admin/api/sandbox/status', {
        headers: auth(ADMIN_TOKEN),
      }, { SANDBOX: {} });
      const afterRedeployBody = await afterRedeploy.json() as Record<string, unknown>;
      assert.equal(afterRedeployBody.installed, true);
      assert.equal(afterRedeployBody.storedEnabled, false);
      assert.equal(afterRedeployBody.enabled, false);
    });

    const actions = (await identity.listAuditEvents())
      .map((event) => JSON.parse(event.metadataJson) as { action?: string })
      .map((metadata) => metadata.action)
      .filter((action) => action?.startsWith('sandbox.'));
    assert.ok(actions.includes('sandbox.install.request'));
    assert.ok(actions.includes('sandbox.install.cancel'));
  } finally {
    identity.close();
    settings.close();
    store.close();
  }
});

test('installed Cloudflare sandbox remains off until confirmed enable and reports GitHub grant readiness', async () => {
  const readyAgent = agent({
    repositories: [{
      id: 'repo-alpha',
      installationId: 50_001,
      accountLogin: 'Acme',
      fullName: 'Acme/Alpha',
      enabled: true,
    }],
  });
  const store = new SqliteConfigStore(':memory:', { agents: [readyAgent], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings, identity });
    await withCloudflareUserAgent(async () => {
      const installed = await app.request('/admin/api/sandbox/status', {
        headers: auth(ADMIN_TOKEN),
      }, { Sandbox: {} });
      assert.deepEqual(await installed.json(), {
        installRequested: false,
        installed: true,
        storedEnabled: false,
        enabled: false,
        instanceType: 'standard-1',
        allowedHosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
        monthlySessionCap: 0,
        monthlySessionCapConfigured: false,
        target: 'cloudflare',
        githubConnected: false,
        repositoryGrantReady: true,
        unmetPrerequisites: ['github_app'],
        workersPaidNote: 'Requires Workers Paid. Real containers run on your Cloudflare account; a typical session costs about 1 cent.',
      });

      const unconfirmed = await app.request('/admin/api/sandbox/status', {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          allowedHosts: ['registry.npmjs.org'],
          monthlySessionCap: 450,
        }),
      }, { SANDBOX: {} });
      assert.equal(unconfirmed.status, 409);
      assert.deepEqual(await unconfirmed.json(), { error: 'sandbox_readiness_confirmation_required' });

      await settings.setSetting('github.app.id', '1234');
      await settings.setSetting('github.app.private_key', 'test-private-key');
      const enabled = await app.request('/admin/api/sandbox/status', {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          readinessConfirmed: true,
          // A legacy caller may still send this ignored deploy-time field.
          instanceType: 'standard-2',
          allowedHosts: ['registry.npmjs.org', 'files.pythonhosted.org', 'registry.npmjs.org'],
          monthlySessionCap: 450,
        }),
      }, { SANDBOX: {} });
      assert.equal(enabled.status, 200);
      const enabledBody = await enabled.json() as Record<string, unknown>;
      assert.equal(enabledBody.storedEnabled, true);
      assert.equal(enabledBody.enabled, true);
      assert.equal(enabledBody.githubConnected, true);
      assert.equal(enabledBody.repositoryGrantReady, true);
      assert.deepEqual(enabledBody.unmetPrerequisites, []);

      const disabled = await app.request('/admin/api/sandbox/status', {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          allowedHosts: ['registry.npmjs.org'],
          monthlySessionCap: 450,
        }),
      }, { SANDBOX: {} });
      assert.equal(disabled.status, 200);
      const disabledBody = await disabled.json() as Record<string, unknown>;
      assert.equal(disabledBody.installed, true);
      assert.equal(disabledBody.storedEnabled, false);
      assert.equal(disabledBody.enabled, false);
    });

    const actions = (await identity.listAuditEvents())
      .map((event) => JSON.parse(event.metadataJson) as { action?: string })
      .map((metadata) => metadata.action)
      .filter((action) => action?.startsWith('sandbox.'));
    assert.ok(actions.includes('sandbox.runtime.enable'));
    assert.ok(actions.includes('sandbox.runtime.disable'));
  } finally {
    identity.close();
    settings.close();
    store.close();
  }
});

test('Sandbox advanced settings update cannot re-enable a runtime disabled by another tab', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings, identity });
    await withCloudflareUserAgent(async () => {
      await settings.applySettingsPatch({
        set: [
          { key: 'sandbox.enabled', value: 'true' },
          { key: 'sandbox.allowedHosts', value: JSON.stringify(['registry.npmjs.org']) },
          { key: 'sandbox.monthlySessionCap', value: '200' },
        ],
      });

      // Simulate the later disable from another Admin tab.
      const disabled = await app.request('/admin/api/sandbox/status', {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          allowedHosts: ['registry.npmjs.org'],
          monthlySessionCap: 200,
        }),
      }, { SANDBOX: {} });
      assert.equal(disabled.status, 200);

      const advanced = await app.request('/admin/api/sandbox/status', {
        method: 'PATCH',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          allowedHosts: ['registry.npmjs.org', 'pypi.org'],
          monthlySessionCap: 300,
        }),
      }, { SANDBOX: {} });
      assert.equal(advanced.status, 200);
      const advancedBody = await advanced.json() as Record<string, unknown>;
      assert.equal(advancedBody.storedEnabled, false);
      assert.equal(advancedBody.enabled, false);
      assert.deepEqual(advancedBody.allowedHosts, ['registry.npmjs.org', 'pypi.org']);
      assert.equal(advancedBody.monthlySessionCap, 300);
    });
  } finally {
    identity.close();
    settings.close();
    store.close();
  }
});

test('admin memory status is auth-gated, always on, and cannot be disabled', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store);

    const unauthorized = await app.request('/admin/api/memory/settings');
    assert.equal(unauthorized.status, 401);

    const initial = await app.request('/admin/api/memory/settings', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.deepEqual(await initial.json(), {
      enabled: true,
      alwaysOn: true,
    });

    const rejected = await app.request('/admin/api/memory/settings', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      error: 'memory_always_enabled',
      enabled: true,
      alwaysOn: true,
    });
    await withEnv({ SLACK_TAG_MEMORY_ENABLED: 'false' }, async () => {
      const status = await app.request('/admin/api/memory/settings', {
        headers: auth(ADMIN_TOKEN),
      });
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), {
        enabled: true,
        alwaysOn: true,
      });
    });
  } finally {
    store.close();
  }
});

test('profile-scoped MCP test classifies a 401 as unauthorized (HTTP 200)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        throw new Error('HTTP 401 Unauthorized');
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        bearerToken: 'bad',
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; code: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'unauthorized');
    assert.doesNotMatch(body.message, /401/);
  } finally {
    store.close();
  }
});

test('profile-scoped MCP test redacts configured query and header credentials from logs', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async (input) => {
        throw new Error(
          'upstream echoed ' +
            input.url +
            ' ' +
            input.headers.Authorization +
            ' ' +
            input.headers['X-Custom-Credential'],
        );
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp?access_token=query-secret',
        transport: 'streamable-http',
        authMode: 'bearer',
        bearerToken: 'bearer-secret',
        headers: { 'X-Custom-Credential': 'custom-secret' },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ok: boolean }).ok, false);
  } finally {
    console.warn = previousWarn;
    store.close();
  }

  const logged = warnings.join('\n');
  assert.ok(logged.includes('[redacted]'));
  assert.doesNotMatch(logged, /query-secret|bearer-secret|custom-secret/);
});

test('profile-scoped MCP test returns ok:false blocked_url without connecting to a private target', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    let discoverCalled = false;
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        discoverCalled = true;
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://192.168.1.1/mcp',
        transport: 'streamable-http',
        authMode: 'none',
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; code: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'blocked_url');
    // No raw error text and no discover attempt against the blocked target.
    assert.doesNotMatch(body.message, /192\.168/);
    assert.equal(discoverCalled, false);
  } finally {
    store.close();
  }
});

test('profile-scoped MCP test returns 400 only for a schema-invalid body', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => ({ tools: [] }),
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'linear-mcp' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  } finally {
    store.close();
  }
});

test('PUT /admin/api/agents/:agentId/mcp/secrets/:connectionId stores scoped values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_alpha',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
      }),
    );
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/agents/agent_alpha/mcp/secrets/linear-mcp', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        bearerToken: 'super-secret-token',
        headers: { 'X-Api-Key': 'header-secret-value' },
        headerNames: ['X-Api-Key'],
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      bearer: string;
      headers: Record<string, string>;
    };
    assert.deepEqual(body, { bearer: 'stored', headers: { 'X-Api-Key': 'stored' } });
    // The response never echoes the secret values.
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /super-secret-token/);
    assert.doesNotMatch(raw, /header-secret-value/);
    // The values did land in the settings store by reference.
    assert.equal(
      await settings.getSetting('mcp.agent_alpha.linear-mcp.bearer'),
      'super-secret-token',
    );
    assert.equal(
      await settings.getSetting('mcp.agent_alpha.linear-mcp.header.X-Api-Key'),
      'header-secret-value',
    );
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_alpha')),
      JSON.stringify([
        'mcp.agent_alpha.linear-mcp.bearer',
        'mcp.agent_alpha.linear-mcp.header.X-Api-Key',
      ]),
    );
  } finally {
    settings.close?.();
    store.close();
  }
});

test('MCP secret PUT rejects missing scopes and header names outside the connection policy', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_alpha',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
      }),
    );
    const app = appWithAdminOptions(store, { settings });
    const headers = { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' };

    const missingAgent = await app.request(
      '/admin/api/agents/agent_missing/mcp/secrets/linear-mcp',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bearerToken: 'orphan', headerNames: [] }),
      },
    );
    const missingConnection = await app.request(
      '/admin/api/agents/agent_alpha/mcp/secrets/missing-mcp',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bearerToken: 'orphan', headerNames: [] }),
      },
    );
    const untrackedHeader = await app.request(
      '/admin/api/agents/agent_alpha/mcp/secrets/linear-mcp',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ headers: { 'X-Untracked': 'orphan' }, headerNames: [] }),
      },
    );

    assert.equal(missingAgent.status, 404);
    assert.equal(missingConnection.status, 404);
    assert.equal(untrackedHeader.status, 400);
    assert.equal(await settings.getSetting('mcp.agent_missing.linear-mcp.bearer'), undefined);
    assert.equal(await settings.getSetting('mcp.agent_alpha.missing-mcp.bearer'), undefined);
    assert.equal(
      await settings.getSetting('mcp.agent_alpha.linear-mcp.header.X-Untracked'),
      undefined,
    );
    assert.equal(await settings.getSetting(mcpSecretCleanupMarkerKey('agent_alpha')), undefined);
  } finally {
    settings.close();
    store.close();
  }
});

test('MCP secret PUT can clear an OAuth bundle without returning its values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_alpha',
        mcpServers: [mcpServer({ id: 'linear-mcp', authMode: 'none' })],
      }),
    );
    const oauthKeys = mcpOAuthSettingKeys({
      agentId: 'agent_alpha',
      connectionId: 'linear-mcp',
    });
    for (const [index, key] of oauthKeys.entries()) {
      await settings.setSetting(key, `oauth-secret-${index}`);
    }
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/agents/agent_alpha/mcp/secrets/linear-mcp', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ headerNames: [], clearOAuth: true }),
    });

    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.clone().text(), /oauth-secret/);
    assert.deepEqual(await settings.getSettings(oauthKeys), oauthKeys.map(() => undefined));
  } finally {
    settings.close?.();
    store.close();
  }
});

test('MCP secret PUT removes its writes when the profile disappears in flight', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let reads = 0;
  const disappearingStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getAgent') {
        return async (agentId: string) => {
          const current = await target.getAgent(agentId);
          reads += 1;
          if (reads === 1) {
            await target.deleteAgent(agentId);
          }
          return current;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    await store.createAgent(
      agent({
        id: 'agent_disappearing',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
      }),
    );
    const app = appWithAdminOptions(disappearingStore, { settings });

    const response = await app.request(
      '/admin/api/agents/agent_disappearing/mcp/secrets/linear-mcp',
      {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          bearerToken: 'late-token',
          headers: { 'X-Api-Key': 'late-header' },
          headerNames: ['X-Api-Key'],
        }),
      },
    );

    assert.equal(response.status, 404);
    assert.equal(
      await settings.getSetting('mcp.agent_disappearing.linear-mcp.bearer'),
      undefined,
    );
    assert.equal(
      await settings.getSetting('mcp.agent_disappearing.linear-mcp.header.X-Api-Key'),
      undefined,
    );
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_disappearing')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('parallel MCP secret PUTs retain cleanup inventory for every connection', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_parallel',
        mcpServers: [
          mcpServer({ id: 'linear-mcp', headerNames: ['X-Linear-Key'] }),
          mcpServer({ id: 'github-mcp', headerNames: ['X-GitHub-Key'] }),
        ],
      }),
    );
    const app = appWithAdminOptions(store, { settings });
    const headers = { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' };

    const [linear, github] = await Promise.all([
      app.request('/admin/api/agents/agent_parallel/mcp/secrets/linear-mcp', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          bearerToken: 'linear-token',
          headers: { 'X-Linear-Key': 'linear-key' },
          headerNames: ['X-Linear-Key'],
        }),
      }),
      app.request('/admin/api/agents/agent_parallel/mcp/secrets/github-mcp', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          bearerToken: 'github-token',
          headers: { 'X-GitHub-Key': 'github-key' },
          headerNames: ['X-GitHub-Key'],
        }),
      }),
    ]);

    assert.equal(linear.status, 200);
    assert.equal(github.status, 200);
    const marker = await settings.getSetting(mcpSecretCleanupMarkerKey('agent_parallel'));
    assert.ok(marker);
    assert.deepEqual(
      new Set(JSON.parse(marker) as string[]),
      new Set([
        'mcp.agent_parallel.linear-mcp.bearer',
        'mcp.agent_parallel.linear-mcp.header.X-Linear-Key',
        'mcp.agent_parallel.github-mcp.bearer',
        'mcp.agent_parallel.github-mcp.header.X-GitHub-Key',
      ]),
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('DELETE /admin/api/agents/:agentId/mcp/secrets/:connectionId clears only scoped secrets', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.agent_alpha.linear-mcp.bearer', 'tok');
    await settings.setSetting('mcp.agent_alpha.linear-mcp.header.X-Api-Key', 'val');
    const alphaOAuthKeys = mcpOAuthSettingKeys({
      agentId: 'agent_alpha',
      connectionId: 'linear-mcp',
    });
    for (const [index, key] of alphaOAuthKeys.entries()) {
      await settings.setSetting(key, `alpha-oauth-${index}`);
    }
    await settings.setSetting('mcp.agent_beta.linear-mcp.bearer', 'beta-tok');
    const betaOAuthTokenKey = mcpOAuthSettingKeys({
      agentId: 'agent_beta',
      connectionId: 'linear-mcp',
    })[2];
    await settings.setSetting(betaOAuthTokenKey, 'beta-oauth-token');
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/agents/agent_alpha/mcp/secrets/linear-mcp', {
      method: 'DELETE',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ headerNames: ['X-Api-Key'] }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(await settings.getSetting('mcp.agent_alpha.linear-mcp.bearer'), undefined);
    assert.equal(
      await settings.getSetting('mcp.agent_alpha.linear-mcp.header.X-Api-Key'),
      undefined,
    );
    assert.deepEqual(
      await settings.getSettings(alphaOAuthKeys),
      alphaOAuthKeys.map(() => undefined),
    );
    assert.equal(await settings.getSetting('mcp.agent_beta.linear-mcp.bearer'), 'beta-tok');
    assert.equal(await settings.getSetting(betaOAuthTokenKey), 'beta-oauth-token');
  } finally {
    settings.close?.();
    store.close();
  }
});

test('profile-scoped MCP routes reject invalid agent and connection ids', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const headers = { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' };
    const secretBody = JSON.stringify({ headerNames: [] });
    const testBody = JSON.stringify({
      id: 'linear-mcp',
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable-http',
      authMode: 'none',
    });

    const badAgentSecret = await app.request(
      '/admin/api/agents/agent.bad/mcp/secrets/linear-mcp',
      { method: 'PUT', headers, body: secretBody },
    );
    const badConnectionSecret = await app.request(
      '/admin/api/agents/agent_good/mcp/secrets/Not_Valid',
      { method: 'PUT', headers, body: secretBody },
    );
    const badAgentTest = await app.request('/admin/api/agents/agent.bad/mcp/test', {
      method: 'POST',
      headers,
      body: testBody,
    });

    assert.equal(badAgentSecret.status, 400);
    assert.equal(badConnectionSecret.status, 400);
    assert.equal(badAgentTest.status, 400);
  } finally {
    store.close();
  }
});

test('deleting an agent sweeps only that agent\'s connection secrets', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });
    await store.createAgent(
      agent({
        id: 'agent_sweep',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
        apiConnections: [apiConnection({ id: 'linear-api' })],
      }),
    );
    await settings.setSetting('mcp.agent_sweep.linear-mcp.bearer', 'tok');
    await settings.setSetting('mcp.agent_sweep.linear-mcp.header.X-Api-Key', 'val');
    await settings.setSetting('mcp.agent_survivor.linear-mcp.bearer', 'survivor-token');
    await settings.setSetting(
      'connector.agent_sweep.linear-api.credential',
      'connector-secret',
    );
    await settings.setSetting(
      'connector.agent_survivor.linear-api.credential',
      'survivor-connector-secret',
    );

    const response = await app.request('/admin/api/agents/agent_sweep', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 204);
    assert.equal(await settings.getSetting('mcp.agent_sweep.linear-mcp.bearer'), undefined);
    assert.equal(
      await settings.getSetting('mcp.agent_sweep.linear-mcp.header.X-Api-Key'),
      undefined,
    );
    assert.equal(
      await settings.getSetting('mcp.agent_survivor.linear-mcp.bearer'),
      'survivor-token',
    );
    assert.equal(
      await settings.getSetting('connector.agent_sweep.linear-api.credential'),
      undefined,
    );
    assert.equal(
      await settings.getSetting('connector.agent_survivor.linear-api.credential'),
      'survivor-connector-secret',
    );
  } finally {
    settings.close?.();
    store.close();
  }
});

test('agent deletion removes every fixed MCP OAuth setting', async () => {
  const oauthRef = { agentId: 'agent_oauth_delete', connectionId: 'linear-mcp' };
  const store = new SqliteConfigStore(':memory:', {
    agents: [
      agent({
        id: oauthRef.agentId,
        mcpServers: [mcpServer({ id: oauthRef.connectionId, authMode: 'oauth' })],
      }),
    ],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    for (const key of mcpOAuthSettingKeys(oauthRef)) {
      await settings.setSetting(key, 'sensitive-oauth-state');
    }
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request(
      `/admin/api/agents/${oauthRef.agentId}`,
      { method: 'DELETE', headers: auth(ADMIN_TOKEN) },
    );

    assert.equal(response.status, 204);
    assert.deepEqual(
      await settings.getSettings(mcpOAuthSettingKeys(oauthRef)),
      [undefined, undefined, undefined, undefined, undefined],
    );
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey(oauthRef.agentId)),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('agent deletion keeps a durable cleanup marker when secret deletion fails and can retry', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const persistedSettings = new SqliteSettingsStore(':memory:');
  const bearerKey = 'mcp.agent_cleanup_retry.linear-mcp.bearer';
  const headerKey = 'mcp.agent_cleanup_retry.linear-mcp.header.X-Api-Key';
  const survivorKey = 'mcp.agent_survivor.linear-mcp.bearer';
  const connectorKey = 'connector.agent_cleanup_retry.linear-api.credential';
  const survivorConnectorKey = 'connector.agent_survivor.linear-api.credential';
  let failSecretDeletion = true;
  const settings: SettingsStore = {
    getSetting: (key) => persistedSettings.getSetting(key),
    getSettings: (keys) => persistedSettings.getSettings(keys),
    setSetting: (key, value) => persistedSettings.setSetting(key, value),
    applySettingsPatch: (patch) => persistedSettings.applySettingsPatch(patch),
    mergeSettingStringSet: (key, values) =>
      persistedSettings.mergeSettingStringSet(key, values),
    deleteSetting: async (key) => {
      if (failSecretDeletion && key === connectorKey) {
        throw new Error('settings deletion unavailable');
      }
      await persistedSettings.deleteSetting(key);
    },
  };

  try {
    const connection = mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] });
    await store.createAgent(
      agent({
        id: 'agent_cleanup_retry',
        mcpServers: [connection],
        apiConnections: [apiConnection({ id: 'linear-api' })],
      }),
    );
    await persistedSettings.setSetting(bearerKey, 'tok');
    await persistedSettings.setSetting(headerKey, 'val');
    await persistedSettings.setSetting(survivorKey, 'survivor-token');
    await persistedSettings.setSetting(connectorKey, 'connector-secret');
    await persistedSettings.setSetting(survivorConnectorKey, 'survivor-connector-secret');
    const app = appWithAdminOptions(store, { settings });

    const failed = await app.request('/admin/api/agents/agent_cleanup_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'internal_error' });
    assert.equal(
      (await store.listAgents()).some(({ id }) => id === 'agent_cleanup_retry'),
      false,
    );
    assert.equal(await persistedSettings.getSetting(bearerKey), undefined);
    assert.equal(await persistedSettings.getSetting(headerKey), undefined);
    assert.equal(
      await persistedSettings.getSetting(mcpSecretCleanupMarkerKey('agent_cleanup_retry')),
      undefined,
    );
    assert.equal(await persistedSettings.getSetting(connectorKey), 'connector-secret');
    assert.equal(
      await persistedSettings.getSetting(
        connectorSecretCleanupMarkerKey('agent_cleanup_retry'),
      ),
      JSON.stringify([connectorKey]),
    );
    assert.equal(await persistedSettings.getSetting(survivorKey), 'survivor-token');
    assert.equal(
      await persistedSettings.getSetting(survivorConnectorKey),
      'survivor-connector-secret',
    );

    failSecretDeletion = false;
    const retried = await app.request('/admin/api/agents/agent_cleanup_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(retried.status, 204);
    assert.equal(
      (await store.listAgents()).some(({ id }) => id === 'agent_cleanup_retry'),
      false,
    );
    assert.equal(await persistedSettings.getSetting(bearerKey), undefined);
    assert.equal(await persistedSettings.getSetting(headerKey), undefined);
    assert.equal(await persistedSettings.getSetting(survivorKey), 'survivor-token');
    assert.equal(await persistedSettings.getSetting(connectorKey), undefined);
    assert.equal(
      await persistedSettings.getSetting(survivorConnectorKey),
      'survivor-connector-secret',
    );
    assert.equal(
      await persistedSettings.getSetting(mcpSecretCleanupMarkerKey('agent_cleanup_retry')),
      undefined,
    );
    assert.equal(
      await persistedSettings.getSetting(
        connectorSecretCleanupMarkerKey('agent_cleanup_retry'),
      ),
      undefined,
    );

    const missing = await app.request('/admin/api/agents/agent_cleanup_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });
  } finally {
    persistedSettings.close();
    store.close();
  }
});

test('agent deletion leaves secrets untouched when the config delete fails before commit', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let failConfigDelete = true;
  const flakyStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'deleteAgentWithMemory') {
        return async (agentId: string, idempotencyKey: string) => {
          if (failConfigDelete) {
            throw new Error('config deletion unavailable');
          }
          return target.deleteAgentWithMemory(agentId, idempotencyKey);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    const connection = mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] });
    await store.createAgent(agent({ id: 'agent_config_retry', mcpServers: [connection] }));
    const bearerKey = 'mcp.agent_config_retry.linear-mcp.bearer';
    const headerKey = 'mcp.agent_config_retry.linear-mcp.header.X-Api-Key';
    await settings.setSetting(bearerKey, 'tok');
    await settings.setSetting(headerKey, 'val');
    const app = appWithAdminOptions(flakyStore, { settings });

    const failed = await app.request('/admin/api/agents/agent_config_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'internal_error' });
    assert.deepEqual((await store.getAgent('agent_config_retry')).mcpServers, [connection]);
    assert.equal(await settings.getSetting(bearerKey), 'tok');
    assert.equal(await settings.getSetting(headerKey), 'val');
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_config_retry')),
      JSON.stringify([
        bearerKey,
        headerKey,
        ...mcpOAuthSettingKeys({
          agentId: 'agent_config_retry',
          connectionId: 'linear-mcp',
        }),
      ]),
    );

    failConfigDelete = false;
    const retried = await app.request('/admin/api/agents/agent_config_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(retried.status, 204);
    assert.equal(await settings.getSetting(bearerKey), undefined);
    assert.equal(await settings.getSetting(headerKey), undefined);
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_config_retry')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('agent deletion finishes cleanup after an ambiguous post-commit config error', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const ambiguousStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'deleteAgentWithMemory') {
        return async (agentId: string, idempotencyKey: string) => {
          await target.deleteAgentWithMemory(agentId, idempotencyKey);
          throw new Error('durable object response lost after commit');
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    const connection = mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] });
    await store.createAgent(agent({ id: 'agent_ambiguous', mcpServers: [connection] }));
    const bearerKey = 'mcp.agent_ambiguous.linear-mcp.bearer';
    const headerKey = 'mcp.agent_ambiguous.linear-mcp.header.X-Api-Key';
    await settings.setSetting(bearerKey, 'tok');
    await settings.setSetting(headerKey, 'val');
    const app = appWithAdminOptions(ambiguousStore, { settings });

    const response = await app.request('/admin/api/agents/agent_ambiguous', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 204);
    assert.equal(
      (await store.listAgents()).some(({ id }) => id === 'agent_ambiguous'),
      false,
    );
    assert.equal(await settings.getSetting(bearerKey), undefined);
    assert.equal(await settings.getSetting(headerKey), undefined);
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_ambiguous')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('an assignment race leaves the live agent credentials intact and can retry', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let injectAssignment = true;
  const racingStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'deleteAgentWithMemory') {
        return async (agentId: string, idempotencyKey: string) => {
          if (injectAssignment) {
            injectAssignment = false;
            await target.putAssignment({
              workspaceId: 'T_RACE',
              channelId: 'C_RACE',
              agentId,
            });
          }
          return target.deleteAgentWithMemory(agentId, idempotencyKey);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    const connection = mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] });
    await store.createAgent(agent({ id: 'agent_race', mcpServers: [connection] }));
    const bearerKey = 'mcp.agent_race.linear-mcp.bearer';
    const headerKey = 'mcp.agent_race.linear-mcp.header.X-Api-Key';
    await settings.setSetting(bearerKey, 'tok');
    await settings.setSetting(headerKey, 'val');
    const app = appWithAdminOptions(racingStore, { settings });

    const raced = await app.request('/admin/api/agents/agent_race', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(raced.status, 409);
    assert.deepEqual(await raced.json(), {
      error: 'agent_still_referenced',
      references: ['T_RACE/C_RACE'],
    });
    assert.deepEqual((await store.getAgent('agent_race')).mcpServers, [connection]);
    assert.equal(await settings.getSetting(bearerKey), 'tok');
    assert.equal(await settings.getSetting(headerKey), 'val');

    await store.deleteAssignment('T_RACE', 'C_RACE');
    const retried = await app.request('/admin/api/agents/agent_race', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(retried.status, 204);
    assert.equal(await settings.getSetting(bearerKey), undefined);
    assert.equal(await settings.getSetting(headerKey), undefined);
    assert.equal(await settings.getSetting(mcpSecretCleanupMarkerKey('agent_race')), undefined);
  } finally {
    settings.close();
    store.close();
  }
});

test('Slack identity Admin resources are gated, bounded, and secret-free', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });
    const unauthorized = await app.request('/admin/api/slack-identities');
    assert.equal(unauthorized.status, 401);

    await withEnv({}, async () => {
      const created = await app.request('https://chickpea.acme.test/admin/api/slack-identities', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'settings',
          initialDmAgentId: 'agent_finance',
          appName: 'Finance Copilot',
          displayName: 'Finance',
        }),
      });
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as {
        identity: Record<string, unknown> & { id: string };
        setupUrl: string;
        setup: { appName: string; botDisplayName: string; manifestUrl: string };
      };
      assert.equal(createdBody.identity.lifecycle, 'setup_incomplete');
      assert.equal(createdBody.identity.dmAgentId, 'agent_finance');
      assert.equal(createdBody.identity.dmState, 'on');
      assert.match(createdBody.setupUrl, /^\/admin\/settings\/slack\/identities\//);
      assert.equal(Object.hasOwn(createdBody.identity, 'ingressKey'), false);
      assert.equal(createdBody.setup.appName, 'Finance Copilot');
      assert.equal(createdBody.setup.botDisplayName, 'Finance');
      const dedicatedManifestUrl = new URL(createdBody.setup.manifestUrl);
      const dedicatedManifest = JSON.parse(
        dedicatedManifestUrl.searchParams.get('manifest_json') ?? '{}',
      ) as {
        $schema?: string;
        display_information: { name: string };
        features: { bot_user: { display_name: string } };
        settings: { event_subscriptions: { request_url: string; bot_events: string[] } };
      };
      assert.equal(dedicatedManifest.$schema, undefined);
      assert.equal(dedicatedManifest.display_information.name, 'Finance Copilot');
      assert.equal(dedicatedManifest.features.bot_user.display_name, 'Finance');
      assert.match(
        dedicatedManifest.settings.event_subscriptions.request_url,
        /^https:\/\/chickpea\.acme\.test\/channels\/slack\/events\/[A-Za-z0-9_-]{22,}$/,
      );
      assert.ok(dedicatedManifest.settings.event_subscriptions.bot_events.includes('app_uninstalled'));
      assert.ok(dedicatedManifest.settings.event_subscriptions.bot_events.includes('tokens_revoked'));

      const detail = await app.request(
        `https://chickpea.acme.test/admin/api/slack-identities/${createdBody.identity.id}`,
        { headers: auth(ADMIN_TOKEN) },
      );
      assert.equal(detail.status, 200);
      const detailBody = await detail.json() as {
        identity: Record<string, unknown>;
        setup: { appName: string; manifestUrl: string };
      };
      assert.equal(Object.hasOwn(detailBody.identity, 'ingressKey'), false);
      assert.equal(detailBody.setup.appName, 'Finance Copilot');
      assert.equal(detailBody.setup.manifestUrl, createdBody.setup.manifestUrl);

      const localDetail = await app.request(
        `/admin/api/slack-identities/${createdBody.identity.id}`,
        { headers: auth(ADMIN_TOKEN) },
      );
      assert.equal(localDetail.status, 200);
      const localDetailBody = await localDetail.json() as {
        setup: { manifestUrl: string | null; manifestError: string | null };
      };
      assert.equal(localDetailBody.setup.manifestUrl, null);
      assert.match(localDetailBody.setup.manifestError ?? '', /public HTTPS Admin URL/);

      const listed = await app.request('/admin/api/slack-identities', {
        headers: auth(ADMIN_TOKEN),
      });
      assert.equal(listed.status, 200);
      const bodyText = await listed.text();
      assert.doesNotMatch(bodyText, /ingressKey|botToken|signingSecret|xox[bp]-/);
      const listBody = JSON.parse(bodyText) as {
        identities: Array<Record<string, unknown>>;
      };
      assert.equal(Object.hasOwn(listBody, 'creationEnabled'), false);
      assert.equal(listBody.identities.length, 2);
      assert.equal(listBody.identities[0]?.kind, 'workspace_default');
      assert.equal(listBody.identities[0]?.credentialsWritable, false);
      assert.deepEqual(
        (listBody.identities[1]?.agents as Array<{ id: string; name: string }>),
        [],
      );
      assert.deepEqual(
        (await store.listSlackIdentityAuditEvents()).map(({ eventType }) => eventType),
        ['slack_identity.setup_started'],
      );
    });

    const oversized = await app.request(new Request(
      'http://localhost/admin/api/slack-identities',
      {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'settings',
          initialDmAgentId: 'agent_finance',
          displayName: 'x'.repeat(65_536),
        }),
      },
    ));
    assert.equal(oversized.status, 413);
    for (const invalidNames of [
      { appName: 'x'.repeat(36), displayName: 'Finance' },
      { appName: 'Finance', displayName: 'x'.repeat(81) },
    ]) {
      const invalid = await withEnv(
        {},
        () => app.request('/admin/api/slack-identities', {
          method: 'POST',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'settings',
            initialDmAgentId: 'agent_finance',
            ...invalidNames,
          }),
        }),
      );
      assert.equal(invalid.status, 400);
    }
    const oversizedDefault = await app.request(new Request(
      'http://localhost/admin/api/slack-connection',
      {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          botToken: `xoxb-${'x'.repeat(65_536)}`,
          signingSecret: 'not-stored',
        }),
      },
    ));
    assert.equal(oversizedDefault.status, 413);
    assert.equal((await store.listSlackIdentities()).length, 2);
  } finally {
    settings.close();
    store.close();
  }
});

test('Profile-origin identity setup replaces its captured prior identity and rejects stale completion', async () => {
  const profileId = 'agent_finance';
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: profileId, name: 'Finance' })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const connectedIdentity = (
    id: string,
    ingressKey: string,
    appId: string,
  ): SlackIdentity => ({
    id,
    ingressKey,
    kind: 'dedicated',
    lifecycle: 'connected',
    teamId: 'T_ACME',
    appId,
    botUserId: `U_${appId}`,
    dmState: 'off',
    credentialProvenance: 'stored',
    connectionRevision: 1,
    health: 'healthy',
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  });
  try {
    const prior = await store.createSlackIdentity(connectedIdentity(
      'slack_identity_prior',
      'identity_ingress_prior_0123456789abcdef',
      'A0PRIOR',
    ));
    const concurrent = await store.createSlackIdentity(connectedIdentity(
      'slack_identity_concurrent',
      'identity_ingress_concurrent_0123456789abcdef',
      'A0CONCURRENT',
    ));
    await store.attachAgentToSlackIdentity(
      profileId,
      prior.id,
      prior.connectionRevision,
      null,
    );
    const app = appWithAdminOptions(store, { settings });
    const created = await withEnv(
      {},
      () => app.request('/admin/api/slack-identities', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'agent',
          initialDmAgentId: profileId,
          displayName: 'Finance Next',
        }),
      }),
    );
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { identity: { id: string } };
    const draft = await store.getSlackIdentity(createdBody.identity.id);
    assert.equal(draft.setupIntent?.sourceAgentId, profileId);
    assert.equal(draft.setupIntent?.sourceAgentSlackIdentityId, prior.id);

    const pending = await store.updateSlackIdentity(draft.id, draft.connectionRevision, {
      lifecycle: 'credentials_pending',
      teamId: 'T_ACME',
      appId: 'A0FINANCENEXT',
      botUserId: 'U_FINANCE_NEXT',
      credentialProvenance: 'stored',
      health: 'healthy',
    });
    const signingSecret = 'finance-next-signing-secret';
    await writeSlackIdentityCredentials(settings, pending.id, null, {
      botToken: 'xoxb-finance-next',
      signingSecret,
      botUserId: 'U_FINANCE_NEXT',
    });
    const recordChallenge = async () => {
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'finance-next-challenge',
      });
      const signature = `v0=${createHmac('sha256', signingSecret)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest('hex')}`;
      const recorded = await recordPendingSlackChallenge(settings, pending, {
        rawBody,
        signature,
        timestamp,
      });
      assert.equal(recorded.accepted, true);
    };

    await store.attachAgentToSlackIdentity(
      profileId,
      concurrent.id,
      concurrent.connectionRevision,
      prior.id,
    );
    await recordChallenge();
    const stale = await app.request(`/admin/api/slack-identities/${pending.id}/verify`, {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: pending.connectionRevision,
        expectedAgentIdentityId: null,
      }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: 'agent_slack_identity_changed',
      agentId: profileId,
      expectedIdentityId: prior.id,
      actualIdentityId: concurrent.id,
    });
    assert.equal((await store.getAgent(profileId)).slackIdentityId, concurrent.id);
    assert.ok(await readPendingSlackChallenge(settings, pending.id));

    await store.attachAgentToSlackIdentity(
      profileId,
      prior.id,
      prior.connectionRevision,
      concurrent.id,
    );
    const completed = await app.request(`/admin/api/slack-identities/${pending.id}/verify`, {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: pending.connectionRevision,
        expectedAgentIdentityId: null,
      }),
    });
    assert.equal(completed.status, 200, await completed.clone().text());
    assert.equal((await store.getAgent(profileId)).slackIdentityId, pending.id);
    const connected = await store.getSlackIdentity(pending.id);
    assert.equal(connected.lifecycle, 'connected');
    assert.equal(connected.setupIntent?.sourceAgentId, undefined);
    assert.equal(connected.setupIntent?.sourceAgentSlackIdentityId, undefined);
    assert.equal(await readPendingSlackChallenge(settings, pending.id), undefined);
  } finally {
    settings.close();
    store.close();
  }
});

test('verified Slack identity reconnect requeues its unavailable delivery recoveries', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const retried: string[] = [];
  const slackState = {
    retrySlackIdentityRecovery: async (identityId: string) => {
      retried.push(identityId);
      return 2;
    },
    countPendingDeliveriesForSlackIdentity: async () => 0,
  } as unknown as SlackStateStore;
  const signingSecret = 'finance-reconnect-signing-secret';
  try {
    const reconnecting = await store.createSlackIdentity({
      id: 'slack_identity_finance',
      ingressKey: 'identity_ingress_finance_0123456789abcdef',
      kind: 'dedicated',
      lifecycle: 'credentials_pending',
      teamId: 'T_ACME',
      appId: 'A0FINANCE',
      botUserId: 'U_FINANCE',
      dmState: 'on',
      dmAgentId: 'agent_finance',
      credentialProvenance: 'stored',
      connectionRevision: 5,
      health: 'unknown',
      setupIntent: {
        appName: 'Finance',
        displayName: 'Finance',
        reconnecting: true,
      },
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
    await writeSlackIdentityCredentials(settings, reconnecting.id, null, {
      botToken: 'xoxb-finance-rotated',
      signingSecret,
      botUserId: 'U_FINANCE',
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const rawBody = JSON.stringify({
      type: 'url_verification',
      challenge: 'finance-reconnect-challenge',
    });
    const signature = `v0=${createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex')}`;
    const challenge = await recordPendingSlackChallenge(settings, reconnecting, {
      rawBody,
      signature,
      timestamp,
    });
    assert.equal(challenge.accepted, true);

    const app = appWithAdminOptions(store, { settings, slackState });
    const response = await app.request(
      `/admin/api/slack-identities/${reconnecting.id}/verify`,
      {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: reconnecting.connectionRevision,
          expectedAgentIdentityId: null,
        }),
      },
    );

    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(retried, [reconnecting.id]);
    assert.equal((await store.getSlackIdentity(reconnecting.id)).lifecycle, 'connected');
  } finally {
    settings.close();
    store.close();
  }
});

test('workspace-default Slack identity reports stored credentials as browser-writable', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('slack.botToken', 'xoxb-stored');
    await settings.setSetting('slack.signingSecret', 'stored-secret');
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/slack-identities', {
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      identities: Array<Record<string, unknown>>;
    };
    assert.equal(body.identities[0]?.credentialsWritable, true);
    assert.equal(body.identities[0]?.lifecycle, 'connected');
  } finally {
    settings.close();
    store.close();
  }
});

test('Slack identity DM and Profile mutations are explicit and stale-write fenced', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [
      agent({ id: 'agent_finance', name: 'Finance' }),
      agent({ id: 'agent_legal', name: 'Legal' }),
    ],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const identity: SlackIdentity = {
    id: 'slack_identity_finance',
    ingressKey: 'identity_ingress_finance_0123456789abcdef',
    kind: 'dedicated',
    lifecycle: 'connected',
    teamId: 'T_ACME',
    appId: 'A0FINANCE',
    botUserId: 'U_FINANCE',
    dmState: 'on',
    dmAgentId: 'agent_finance',
    credentialProvenance: 'stored',
    connectionRevision: 4,
    observedDisplayName: 'Finance',
    health: 'healthy',
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
  try {
    await store.createSlackIdentity(identity);
    const app = appWithAdminOptions(store, { settings });
    const attached = await withEnv(
      {},
      () => app.request(
        '/admin/api/slack-identities/slack_identity_finance/agents/agent_legal',
        {
          method: 'POST',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 4,
            expectedAgentIdentityId: null,
            acknowledgeUnenumeratedChannels: false,
          }),
        },
      ),
    );
    assert.equal(attached.status, 200);
    assert.equal((await store.getAgent('agent_legal')).slackIdentityId, identity.id);
    assert.equal((await store.getSlackIdentity(identity.id)).dmAgentId, 'agent_finance');

    const changedDm = await app.request(
      '/admin/api/slack-identities/slack_identity_finance/dms',
      {
        method: 'PATCH',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 4,
          dmState: 'off',
          dmAgentId: 'agent_finance',
        }),
      },
    );
    assert.equal(changedDm.status, 200);
    const changed = (await changedDm.json()) as { identity: { connectionRevision: number } };
    assert.equal(changed.identity.connectionRevision, 5);
    assert.equal((await store.getSlackIdentity(identity.id)).dmAgentId, 'agent_finance');

    const stale = await app.request(
      '/admin/api/slack-identities/slack_identity_finance/dms',
      {
        method: 'PATCH',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 4,
          dmState: 'on',
          dmAgentId: 'agent_legal',
        }),
      },
    );
    assert.equal(stale.status, 409);
    assert.equal((await store.getSlackIdentity(identity.id)).dmState, 'off');
    assert.deepEqual(
      (await store.listSlackIdentityAuditEvents()).map(({ eventType }) => eventType).sort(),
      [
        'slack_identity.dm_binding_changed',
        'slack_identity.profile_attached',
      ].sort(),
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('Slack identity preflight is Profile-mutation-free and requires wildcard acknowledgement', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const financeIdentity: SlackIdentity = {
    id: 'slack_identity_finance',
    ingressKey: 'identity_ingress_finance_0123456789abcdef',
    kind: 'dedicated',
    lifecycle: 'connected',
    teamId: 'T_ACME',
    appId: 'A0FINANCE',
    botUserId: 'U_FINANCE',
    dmState: 'on',
    dmAgentId: 'agent_finance',
    credentialProvenance: 'stored',
    connectionRevision: 4,
    health: 'healthy',
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
  const { dmAgentId: _financeDmAgentId, ...financeIdentityWithoutDmAgent } =
    financeIdentity;
  const legalIdentity: SlackIdentity = {
    ...financeIdentityWithoutDmAgent,
    id: 'slack_identity_legal',
    ingressKey: 'identity_ingress_legal_0123456789abcdef',
    appId: 'A0LEGAL',
    botUserId: 'U_LEGAL',
    dmState: 'off',
  };
  try {
    await store.createSlackIdentity(financeIdentity);
    await store.createSlackIdentity(legalIdentity);
    await store.attachAgentToSlackIdentity(
      'agent_finance',
      financeIdentity.id,
      financeIdentity.connectionRevision,
      null,
    );
    await store.putAssignment({
      workspaceId: 'T_ACME',
      channelId: '*',
      agentId: 'agent_finance',
    });
    const app = appWithAdminOptions(store, { settings });
    const endpoint =
      '/admin/api/slack-identities/slack_identity_legal/agents/agent_finance';

    const blocked = await withEnv(
      {},
      () => app.request(endpoint, {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: legalIdentity.connectionRevision,
          expectedAgentIdentityId: financeIdentity.id,
          acknowledgeUnenumeratedChannels: false,
          preflightOnly: true,
        }),
      }),
    );
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { error: string }).error, 'slack_identity_unenumerated_channels');
    assert.equal((await store.getAgent('agent_finance')).slackIdentityId, financeIdentity.id);

    const ready = await withEnv(
      {},
      () => app.request(endpoint, {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: legalIdentity.connectionRevision,
          expectedAgentIdentityId: financeIdentity.id,
          acknowledgeUnenumeratedChannels: true,
          preflightOnly: true,
        }),
      }),
    );
    assert.equal(ready.status, 200);
    const readyBody = await ready.json() as {
      preflightOnly: boolean;
      membership: { ready: boolean; unenumeratedRules: unknown[] };
    };
    assert.equal(readyBody.preflightOnly, true);
    assert.equal(readyBody.membership.ready, true);
    assert.equal(readyBody.membership.unenumeratedRules.length, 1);
    assert.equal((await store.getAgent('agent_finance')).slackIdentityId, financeIdentity.id);
    assert.equal((await store.listSlackIdentityAuditEvents()).length, 0);
  } finally {
    settings.close();
    store.close();
  }
});

test('Slack identity preflight names every concrete channel missing the selected app', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);
  const backend = new FakeSlackBackend({
    slack: {
      identity: { teamId: 'T_ACME', teamName: 'Acme Inc' },
      channels: [
        { id: 'C_PRIVATE', name: 'private-deals', isPrivate: true, isMember: false },
        { id: 'C_FINANCE', name: 'finance', isPrivate: true, isMember: false },
      ],
    },
  });
  const fake = await backend.listen();
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [
      {
        workspaceId: 'T_ACME',
        channelId: 'C_PRIVATE',
        channelLabel: 'stale-private-name',
        agentId: 'agent_finance',
        enabled: true,
      },
      {
        workspaceId: 'T_ACME',
        channelId: 'C_FINANCE',
        agentId: 'agent_finance',
        enabled: true,
      },
    ],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const identity: SlackIdentity = {
    id: 'slack_identity_finance',
    ingressKey: 'identity_ingress_finance_0123456789abcdef',
    kind: 'dedicated',
    lifecycle: 'connected',
    teamId: 'T_ACME',
    appId: 'A0FINANCE',
    botUserId: 'U_FINANCE',
    dmState: 'on',
    dmAgentId: 'agent_finance',
    credentialProvenance: 'stored',
    connectionRevision: 4,
    health: 'healthy',
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
  try {
    await store.createSlackIdentity(identity);
    await writeSlackIdentityCredentials(settings, identity.id, null, {
      botToken: 'xoxb-finance',
      signingSecret: 'finance-secret',
      botUserId: 'U_FINANCE',
    });
    const app = appWithAdminOptions(store, { settings });
    const response = await withEnv(
      {
        SLACK_API_URL: `${fake.url}/api/`,
      },
      () => app.request(
        '/admin/api/slack-identities/slack_identity_finance/agents/agent_finance',
        {
          method: 'POST',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: identity.connectionRevision,
            expectedAgentIdentityId: null,
            acknowledgeUnenumeratedChannels: false,
            preflightOnly: true,
          }),
        },
      ),
    );
    assert.equal(response.status, 409);
    const body = await response.json() as {
      error: string;
      channels: Array<{ channelId: string; label: string }>;
    };
    assert.equal(body.error, 'slack_identity_not_in_channels');
    assert.deepEqual(body.channels, [
      { workspaceId: 'T_ACME', channelId: 'C_FINANCE', label: 'finance' },
      { workspaceId: 'T_ACME', channelId: 'C_PRIVATE', label: 'private-deals' },
    ]);
    assert.equal((await store.getAgent('agent_finance')).slackIdentityId, undefined);
    assert.equal(backend.callsOfMethod('conversations.join').length, 0);
  } finally {
    await fake.close();
    settings.close();
    store.close();
  }
});

test('Slack identity cancellation erases pending secrets and retirement reports durable blockers', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  let pendingDeliveries = 2;
  const slackState = {
    countPendingDeliveriesForSlackIdentity: async () => pendingDeliveries,
  } as unknown as SlackStateStore;
  try {
    const draft: SlackIdentity = {
      id: 'slack_identity_draft',
      ingressKey: 'identity_ingress_draft_0123456789abcdef',
      kind: 'dedicated',
      lifecycle: 'setup_incomplete',
      dmState: 'on',
      dmAgentId: 'agent_finance',
      credentialProvenance: 'none',
      connectionRevision: 0,
      health: 'unknown',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    };
    await store.createSlackIdentity(draft);
    const app = appWithAdminOptions(store, { settings, slackState });
    const canceled = await app.request(
      '/admin/api/slack-identities/slack_identity_draft/cancel',
      {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 0, deleteDraft: true }),
      },
    );
    assert.equal(canceled.status, 200);
    assert.deepEqual(await canceled.json(), { ok: true, deleted: true });
    await assert.rejects(() => store.getSlackIdentity(draft.id), /Unknown Slack identity/);

    const reconnecting = await store.createSlackIdentity({
      ...draft,
      id: 'slack_identity_reconnecting',
      ingressKey: 'identity_ingress_reconnecting_0123456789abcdef',
      lifecycle: 'credentials_pending',
      credentialProvenance: 'stored',
      setupIntent: { appName: 'Finance', displayName: 'Finance', reconnecting: true },
    });
    const reconnectCancel = await app.request(
      '/admin/api/slack-identities/slack_identity_reconnecting/cancel',
      {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: reconnecting.connectionRevision,
          deleteDraft: true,
        }),
      },
    );
    assert.equal(reconnectCancel.status, 409);
    assert.equal(
      (await reconnectCancel.json() as { error: string }).error,
      'slack_identity_reconnect_cancel_unsupported',
    );
    assert.equal(
      (await store.getSlackIdentity(reconnecting.id)).lifecycle,
      'credentials_pending',
    );

    const { dmAgentId: _draftDmAgentId, ...draftWithoutDmAgent } = draft;
    const connected = await store.createSlackIdentity({
      ...draftWithoutDmAgent,
      id: 'slack_identity_retire',
      ingressKey: 'identity_ingress_retire_0123456789abcdef',
      lifecycle: 'connected',
      dmState: 'off',
      credentialProvenance: 'stored',
      connectionRevision: 3,
      health: 'healthy',
    });
    const blocked = await app.request(
      '/admin/api/slack-identities/slack_identity_retire/retire',
      {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: connected.connectionRevision }),
      },
    );
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { pendingDeliveryCount: number }).pendingDeliveryCount, 2);
    assert.equal((await store.getSlackIdentity(connected.id)).lifecycle, 'connected');

    pendingDeliveries = 0;
    const retired = await app.request(
      '/admin/api/slack-identities/slack_identity_retire/retire',
      {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: connected.connectionRevision }),
      },
    );
    assert.equal(retired.status, 200);
    const retiredBody = await retired.json() as {
      identity: { lifecycle: string; credentialProvenance: string };
      slackAppUninstalled: boolean;
    };
    assert.equal(retiredBody.identity.lifecycle, 'retired');
    assert.equal(retiredBody.identity.credentialProvenance, 'none');
    assert.equal(retiredBody.slackAppUninstalled, false);
  } finally {
    settings.close();
    store.close();
  }
});

test('Slack identity retirement waits for delivered Slack interaction cleanup', async () => {
  const retirementAgent = agent({ id: 'agent_finance', name: 'Finance' });
  const store = new SqliteConfigStore(':memory:', {
    agents: [retirementAgent],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const slackState = new SqliteSlackStateStore(':memory:');
  try {
    const identity = await store.createSlackIdentity({
      id: 'slack_identity_cleanup_retire',
      ingressKey: 'identity_ingress_cleanup_retire_0123456789abcdef',
      kind: 'dedicated',
      lifecycle: 'connected',
      dmState: 'off',
      credentialProvenance: 'stored',
      connectionRevision: 3,
      health: 'healthy',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
    const jobId = 'msg:C_FINANCE:cleanup-retirement';
    await slackState.enqueueTurn({
      id: jobId,
      evtKey: 'evt:cleanup-retirement',
      msgKey: jobId,
      turn: {
        workspaceId: 'T_ACME',
        channelId: 'C_FINANCE',
        eventId: 'Ev_CLEANUP_RETIREMENT',
        slackIdentityId: identity.id,
        text: 'finish the task',
        userId: 'U_MEMBER',
        messageTs: '1782770400.000100',
        threadTs: '1782770400.000100',
        source: 'app_mention',
        contextMode: 'thread',
      },
      assignment: {
        workspaceId: 'T_ACME',
        channelId: 'C_FINANCE',
        agentId: retirementAgent.id,
        slackIdentityId: identity.id,
        agent: retirementAgent,
        model: 'local-stub/admin-agent',
      },
    });
    await slackState.recordSlackInteractionProgress(jobId, {
      acknowledgment: {
        channelId: 'C_FINANCE',
        messageTs: '1782770400.000100',
        name: 'eyes',
        created: true,
        cleanup: 'pending',
      },
    });
    await slackState.markTurnDelivered(jobId);

    const app = appWithAdminOptions(store, { settings, slackState });
    const endpoint = `/admin/api/slack-identities/${identity.id}/retire`;
    const blocked = await app.request(endpoint, {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: identity.connectionRevision }),
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { pendingDeliveryCount: number }).pendingDeliveryCount, 1);
    assert.equal((await store.getSlackIdentity(identity.id)).lifecycle, 'connected');

    await slackState.recordSlackInteractionProgress(jobId, {
      acknowledgment: {
        channelId: 'C_FINANCE',
        messageTs: '1782770400.000100',
        name: 'eyes',
        created: true,
        cleanup: 'done',
      },
    });
    const retired = await app.request(endpoint, {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: identity.connectionRevision }),
    });
    assert.equal(retired.status, 200, await retired.clone().text());
    assert.equal((await store.getSlackIdentity(identity.id)).lifecycle, 'retired');
  } finally {
    slackState.close();
    settings.close();
    store.close();
  }
});

test('Slack identity retirement fails closed when pending delivery inventory is unavailable', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const slackState = {
    countPendingDeliveriesForSlackIdentity: async () => {
      throw new Error('inventory unavailable');
    },
  } as unknown as SlackStateStore;
  try {
    const identity = await store.createSlackIdentity({
      id: 'slack_identity_retire_inventory',
      ingressKey: 'identity_ingress_retire_inventory_0123456789abcdef',
      kind: 'dedicated',
      lifecycle: 'connected',
      dmState: 'off',
      credentialProvenance: 'stored',
      connectionRevision: 3,
      health: 'healthy',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
    const app = appWithAdminOptions(store, { settings, slackState });
    const response = await app.request(
      `/admin/api/slack-identities/${identity.id}/retire`,
      {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: identity.connectionRevision }),
      },
    );
    assert.equal(response.status, 500);
    assert.equal((await store.getSlackIdentity(identity.id)).lifecycle, 'connected');
  } finally {
    settings.close();
    store.close();
  }
});

test('Slack identity audit records each Profile attachment at the same identity revision', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [
      agent({ id: 'agent_finance', name: 'Finance' }),
      agent({ id: 'agent_legal', name: 'Legal' }),
    ],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const identity = await store.createSlackIdentity({
      id: 'slack_identity_shared_audit',
      ingressKey: 'identity_ingress_shared_audit_0123456789abcdef',
      kind: 'dedicated',
      lifecycle: 'connected',
      dmState: 'off',
      credentialProvenance: 'stored',
      connectionRevision: 4,
      health: 'healthy',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
    const app = appWithAdminOptions(store, { settings });
    for (const agentId of ['agent_finance', 'agent_legal']) {
      const response = await withEnv(
        {},
        () => app.request(
          `/admin/api/slack-identities/${identity.id}/agents/${agentId}`,
          {
            method: 'POST',
            headers: {
              ...auth(ADMIN_TOKEN),
              'content-type': 'application/json',
              'x-request-id': `attach-${agentId}`,
            },
            body: JSON.stringify({
              expectedRevision: identity.connectionRevision,
              expectedAgentIdentityId: null,
              acknowledgeUnenumeratedChannels: false,
            }),
          },
        ),
      );
      assert.equal(response.status, 200);
    }
    const attachmentEvents = await store.listSlackIdentityAuditEvents({
      eventType: 'slack_identity.profile_attached',
    });
    assert.equal(attachmentEvents.length, 2);
    assert.notEqual(attachmentEvents[0]?.idempotencyKey, attachmentEvents[1]?.idempotencyKey);
  } finally {
    settings.close();
    store.close();
  }
});

test('Agent-first admin projections expose capabilities, placements, readiness, and no Profile page', async () => {
  const configured = agent({
    id: 'agent_ops',
    name: 'Operations',
    skills: [{ name: 'project-health', description: 'Review project health.', instructions: 'Find blockers.', enabled: true }],
    mcpServers: [mcpServer({ id: 'linear', displayName: 'Linear', presetId: 'linear' })],
    repositories: [{ id: 'repo_ops', installationId: 42, accountLogin: 'acme', fullName: 'acme/ops', enabled: true }],
  });
  const store = new SqliteConfigStore(':memory:', { agents: [configured], assignments: [] });
  try {
    await store.putChannel({
      workspaceId: 'T123', channelId: 'C456', label: 'operations',
      additionalInstructions: 'Keep updates concise.', participationMode: 'ambient', lifecycle: 'active',
    });
    await store.putAssignment({ workspaceId: 'T123', channelId: 'C456', agentId: configured.id });
    await store.createSlackIdentity({
      id: 'slack_identity_ops', ingressKey: 'identity_ingress_ops_0123456789abcdef',
      kind: 'dedicated', lifecycle: 'connected', teamId: 'T123', dmState: 'on',
      dmAgentId: configured.id, credentialProvenance: 'stored', connectionRevision: 1,
      health: 'healthy', createdAt: 1, updatedAt: 1,
    });
    const app = appWithAdmin(store);
    const detailResponse = await app.request(`/admin/api/agents/${configured.id}`, { headers: auth(ADMIN_TOKEN) });
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as any;
    assert.deepEqual(detail.agent.tabs, ['instructions', 'skills', 'connectors', 'repositories', 'memory']);
    assert.equal(detail.agent.capabilityPreviews.skills[0].name, 'project-health');
    assert.equal(detail.agent.capabilityPreviews.connectors[0].name, 'Linear');
    assert.equal(detail.agent.capabilityPreviews.repositories[0].name, 'acme/ops');
    assert.equal(detail.agent.whereItWorks.channels[0].channelName, 'operations');
    assert.equal(detail.agent.whereItWorks.directMessages[0].identityId, 'slack_identity_ops');
    assert.deepEqual(detail.agent.memoryOwner, { ownerKind: 'agent', workspaceId: 'T123', ownerId: 'agent_ops' });
    assert.equal(detail.agent.deletion.blocked, true);

    const channelsResponse = await app.request('/admin/api/channels', { headers: auth(ADMIN_TOKEN) });
    assert.equal(channelsResponse.status, 200);
    const channels = (await channelsResponse.json()) as any;
    assert.equal(channels.channels[0].assignment.agentId, 'agent_ops');
    assert.equal(channels.channels[0].assignment.agentName, 'Operations');
    assert.equal(channels.channels[0].readiness.code, 'ready');
    assert.equal(channels.channels[0].links.agent, '/admin/agents/agent_ops');

    const removedProfilePage = await app.request('/admin/profiles/agent_ops', { headers: auth(ADMIN_TOKEN) });
    assert.equal(removedProfilePage.status, 404);
  } finally {
    store.close();
  }
});
