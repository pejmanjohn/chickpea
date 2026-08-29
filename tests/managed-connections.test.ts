import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import type { ConnectionAccountManagedPolicy } from '../src/config/types.ts';
import {
  AgentRevisionConflictError,
  AgentStillReferencedError,
  ConnectionAccountRevisionConflictError,
  UnknownAgentError,
} from '../src/config/errors.ts';
import {
  createDefaultManagedConnectionProviderRegistry,
  createManagedConnectionProviderRegistry,
  invokeManagedConnectionCapability,
  resolveDefaultManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import {
  ManagedAuthorizationExpiredError,
  ManagedProviderRequestError,
} from '../src/connections/managed-errors.ts';
import { createManagedConnectionTools } from '../src/connections/managed-tools.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import { resolveEffectiveConnectionAccounts } from '../src/connections/runtime.ts';
import {
  ConnectionScheduleConflictError,
  ConnectionAccountService,
  ManagedConnectionConflictError,
  markManagedAccountExpired,
  markManagedProviderAccountsUnavailable,
  reconcileManagedProviderAccounts,
  toConnectionAccountView,
} from '../src/connections/store.ts';

test('browser-safe managed account views omit provider credential lineage', () => {
  const view = toConnectionAccountView({
    id: 'connection_safe_view', workspaceId: 'T_MANAGED', ownerKind: 'member',
    ownerMembershipId: 'membership_alice', createdByMembershipId: 'membership_alice',
    providerId: 'google', label: 'Work Gmail', lifecycle: 'ready', revision: 1,
    createdAt: 1, updatedAt: 1,
    secretRefId: 'secret_safe_view',
    policy: {
      ...MANAGED_POLICY,
      providerGeneration: 9,
      providerLineage: 'f'.repeat(24),
    },
  });
  assert.equal('secretRefId' in view, false);
  assert.equal(view.policy.kind, 'managed');
  if (view.policy.kind !== 'managed') assert.fail('expected managed policy');
  assert.equal('principalRef' in view.policy, false);
  assert.equal('accountRef' in view.policy, false);
  assert.equal('providerGeneration' in view.policy, false);
  assert.equal('providerLineage' in view.policy, false);
});

const MANAGED_POLICY: ConnectionAccountManagedPolicy = {
  kind: 'managed',
  adapterId: 'composio',
  toolkit: 'gmail',
  principalRef: 'chickpea-user-1',
  accountRef: 'ca_test_account',
  allowedCapabilities: [
    'gmail.profile.read',
    'gmail.messages.search',
    'gmail.drafts.create',
  ],
};

test('a partially configured Composio provider warns once without disclosing secret values', (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  const env = { COMPOSIO_API_KEY: 'test-key' };

  assert.ok(createDefaultManagedConnectionProviderRegistry(env).get('composio'));
  const provider = createDefaultManagedConnectionProviderRegistry(env).get('composio');
  assert.ok(provider);
  assert.ok(provider.availability);
  assert.deepEqual(provider.availability({ toolkit: 'gmail', accessLane: 'read' }), {
    status: 'missing_configuration',
    missingConfiguration: ['auth_config_missing'],
  });
  assert.equal(warnings.length, 1);
  const parsed = warnings.map((warning) => JSON.parse(warning) as Record<string, unknown>);
  assert.deepEqual(parsed.find(({ event }) =>
    event === 'chickpea.managed_connection.authorization_config_unavailable'), {
    event: 'chickpea.managed_connection.authorization_config_unavailable',
    adapterId: 'composio',
    missingAuthConfigs: [
      'gmail.read', 'gmail.write',
      'googlecalendar.read', 'googlecalendar.write',
      'googledrive.read', 'googledrive.write',
      'googlesheets.read', 'googlesheets.write',
      'googledocs.read', 'googledocs.write',
      'googleslides.read', 'googleslides.write',
      'notion.read', 'notion.write',
      'google_search_console.read', 'google_analytics.read',
      'hubspot.read', 'hubspot.write',
      'gong.read',
      'googleads.read', 'googleads.write',
      'youtube.read', 'youtube.write',
    ],
  });
  assert.equal(warnings.some((warning) => warning.includes('test-key')), false);
});

test('a fully configured Composio provider is ready to authorize', () => {
  const authConfigId = 'ac_managed_default';
  const provider = createDefaultManagedConnectionProviderRegistry({
    COMPOSIO_API_KEY: 'test-key',
    COMPOSIO_WEBHOOK_SECRET: 'test-webhook-secret',
    COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_GMAIL_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_CALENDAR_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_CALENDAR_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_DRIVE_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_DRIVE_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_SHEETS_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_SHEETS_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_DOCS_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_DOCS_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_SLIDES_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_SLIDES_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_NOTION_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_NOTION_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_HUBSPOT_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_HUBSPOT_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_GONG_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_GOOGLE_ADS_READ_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_GOOGLE_ADS_WRITE_AUTH_CONFIG_ID: authConfigId,
    COMPOSIO_GOOGLE_ADS_ACCESS_LEVEL: 'basic',
    COMPOSIO_GOOGLE_ADS_PERMISSIBLE_USE: 'ad_management',
  }).get('composio');
  assert.ok(provider);
  assert.ok(provider.availability);
  assert.deepEqual(provider.availability({ toolkit: 'gmail', accessLane: 'read' }), {
    status: 'ready',
    missingConfiguration: [],
  });
});

test('Composio readiness is isolated by toolkit and access lane', () => {
  const provider = new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    authConfigIds: {
      gmail: { read: 'ac_gmail_read' },
      sheets_fixture: { read: 'ac_sheets_read' },
    },
  });

  assert.equal(provider.availability({ toolkit: 'gmail', accessLane: 'read' }).status, 'ready');
  assert.equal(
    provider.availability({ toolkit: 'gmail', accessLane: 'write' }).status,
    'missing_configuration',
  );
  assert.equal(
    provider.availability({ toolkit: 'sheets_fixture', accessLane: 'read' }).status,
    'ready',
  );
  assert.equal(
    provider.availability({ toolkit: 'sheets_fixture', accessLane: 'write' }).status,
    'missing_configuration',
  );
});

test('Google Ads accepts Composio managed auth and Explorer access without operator-only assertions', () => {
  const managedDefault = new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    authConfigIds: { googleads: { read: 'ac_ads', write: 'ac_ads' } },
  });
  assert.equal(
    managedDefault.availability({ toolkit: 'googleads', accessLane: 'read' }).status,
    'ready',
  );
  assert.equal(
    managedDefault.availability({ toolkit: 'googleads', accessLane: 'write' }).status,
    'ready',
  );

  const explorer = new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    authConfigIds: { googleads: { read: 'ac_ads', write: 'ac_ads' } },
    googleAdsAccessLevel: 'explorer',
  });
  assert.equal(explorer.availability({ toolkit: 'googleads', accessLane: 'read' }).status, 'ready');
  assert.equal(explorer.availability({ toolkit: 'googleads', accessLane: 'write' }).status, 'ready');
});

test('Google Ads keeps explicit restricted developer-token configurations fail closed', () => {
  const reporting = new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    authConfigIds: { googleads: { read: 'ac_ads', write: 'ac_ads' } },
    googleAdsAccessLevel: 'basic',
    googleAdsPermissibleUse: 'reporting',
  });
  assert.equal(
    reporting.availability({ toolkit: 'googleads', accessLane: 'read' }).status,
    'ready',
  );
  assert.deepEqual(reporting.availability({ toolkit: 'googleads', accessLane: 'write' }), {
    status: 'missing_configuration',
    missingConfiguration: ['provider_prerequisite_missing'],
  });

  const testOnly = new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    authConfigIds: { googleads: { read: 'ac_ads', write: 'ac_ads' } },
    googleAdsAccessLevel: 'test',
  });
  assert.deepEqual(testOnly.availability({ toolkit: 'googleads', accessLane: 'read' }), {
    status: 'missing_configuration',
    missingConfiguration: ['provider_prerequisite_missing'],
  });
});

test('managed validation persists only the display-safe provider grant summary', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {
      return {
        grantSummary: {
          items: [
            { type: 'page' as const, label: 'Launch plan' },
            { type: 'database' as const, label: 'Customer pipeline' },
          ],
          truncated: false,
        },
      };
    },
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'notion_summary',
  });
  try {
    await config.createAgent({
      id: 'agent_notion_summary', name: 'Notion summary', instructions: 'Inspect Notion.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct',
      defaultAgentId: 'agent_notion_summary',
    });
    const { account } = await service.createForAgent({
      principal: principal(),
      agentId: 'agent_notion_summary',
      workspaceId: 'T_MANAGED',
      ownerKind: 'member',
      providerId: 'notion',
      label: 'Managed Notion',
      policy: {
        kind: 'managed',
        adapterId: 'composio',
        toolkit: 'notion',
        principalRef: 'chickpea-user-1',
        accountRef: 'ca_test_notion',
        allowedCapabilities: ['notion.content.search'],
      },
    });
    assert.deepEqual(
      account.policy.kind === 'managed' ? account.policy.grantSummary : undefined,
      {
        items: [
          { type: 'page', label: 'Launch plan' },
          { type: 'database', label: 'Customer pipeline' },
        ],
        truncated: false,
      },
    );
    assert.equal(JSON.stringify(account).includes('ca_test_notion'), true);
    assert.equal(JSON.stringify(account.policy).includes('provider-page-id'), false);
  } finally {
    config.close();
    settings.close();
  }
});

function principal(membershipId = 'membership_alice'): AuthPrincipal {
  return {
    userId: `user_${membershipId}`,
    membershipId,
    organizationId: 'organization_test',
    role: 'owner',
    authenticatorKind: 'test',
    credentialId: 'credential_test',
    correlationId: 'correlation_test',
    machine: false,
  };
}

function activeIdentity() {
  const user = {
    id: 'user_alice',
    slackTeamId: 'T_MANAGED',
    slackUserId: 'U_ALICE',
    displayName: 'Alice',
    contactEmail: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const membership = {
    id: 'membership_alice',
    organizationId: 'organization_test',
    userId: user.id,
    role: 'owner' as const,
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const binding = {
    id: 'binding_alice',
    provider: 'slack' as const,
    slackTeamId: 'T_MANAGED',
    slackUserId: user.slackUserId,
    userId: user.id,
    organizationId: membership.organizationId,
    membershipId: membership.id,
    betterAuthUserId: null,
    betterAuthMembershipId: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    getOrganization: async () => ({
      id: 'organization_test',
      displayName: 'Managed Test',
      slackTeamId: 'T_MANAGED',
      authMode: 'slack_active' as const,
      canonicalAdminOrigin: 'https://chickpea.test',
      createdAt: 1,
      updatedAt: 1,
    }),
    getMembership: async () => membership,
    getMembershipAccessOverlay: async () => undefined,
    getUser: async () => user,
    resolveSlackIdentity: async () => ({ user, membership, binding }),
  };
}

test('Composio execution pins one account, exposes one raw tool, and strips bodies by default', async () => {
  const sessions: Array<{ userId: string; config: Record<string, unknown> }> = [];
  const executions: Array<{ tool: string; arguments_: Record<string, unknown> }> = [];
  const retrievedAccounts: string[] = [];
  let clientCreations = 0;
  const provider = new ComposioManagedConnectionProvider({
    apiKey: 'test-project-key',
    getConnectedAccount: async ({ accountRef }) => {
      retrievedAccounts.push(accountRef);
      return {
        id: accountRef,
        status: 'ACTIVE',
        isDisabled: false,
        toolkit: 'gmail',
        userId: MANAGED_POLICY.principalRef,
      };
    },
    createClient: async () => {
      clientCreations += 1;
      return ({
        sessions: {
          async create(userId, config) {
            sessions.push({ userId, config });
            throw new Error('production execution must not create a session');
          },
        },
        tools: {
          async execute(tool, input) {
            executions.push({ tool, arguments_: input.arguments });
            return {
              data: {
                messages: [{
                  messageId: 'message_1',
                  subject: 'Quarterly plan',
                  messageText: 'sensitive full body',
                  message_text: 'sensitive snake-case body',
                  snippet: 'sensitive snippet',
                  preview: { subject: 'Quarterly plan', body: 'sensitive preview' },
                }],
              },
              error: null,
              successful: true,
              logId: 'log_test',
            };
          },
        },
      });
    },
  });

  await provider.validate({ policy: MANAGED_POLICY });
  const result = await provider.execute({
    policy: MANAGED_POLICY,
    capability: 'gmail.messages.search',
    arguments: { query: 'newer_than:7d', maxResults: 3, includeBody: false },
  });

  assert.deepEqual(sessions, []);
  assert.equal(clientCreations, 1);
  assert.deepEqual(retrievedAccounts, ['ca_test_account']);
  assert.deepEqual(executions, [{
    tool: 'GMAIL_FETCH_EMAILS',
    arguments_: {
      user_id: 'me',
      query: 'newer_than:7d',
      max_results: 3,
      include_payload: false,
    },
  }]);
  assert.equal(JSON.stringify(result.data).includes('sensitive full body'), false);
  assert.equal(JSON.stringify(result.data).includes('sensitive preview'), false);
  assert.equal(JSON.stringify(result.data).includes('sensitive snake-case body'), false);
  assert.equal(JSON.stringify(result.data).includes('sensitive snippet'), false);
  assert.equal(result.logId, 'log_test');
});

test('Composio revocation delegates exact remote-account deletion', async () => {
  const calls: Array<{ apiKey: string; accountRef: string; aborted: boolean }> = [];
  const provider = new ComposioManagedConnectionProvider({
    apiKey: 'test-project-key',
    revokeAccount: async ({ apiKey, accountRef, signal }) => {
      calls.push({ apiKey, accountRef, aborted: signal.aborted });
    },
  });
  await provider.revoke({
    policy: MANAGED_POLICY,
  });
  assert.deepEqual(calls, [{
    apiKey: 'test-project-key',
    accountRef: 'ca_test_account',
    aborted: false,
  }]);
});

test('managed invocation rechecks Chickpea authority and the live capability ceiling', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  const usageWindowStart = Date.now() - 60_000;
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute(input) {
      calls.push(input.capability);
      const metadata = {
        providerTool: 'GMAIL_FETCH_EMAILS',
        providerVersion: '20260817_00',
        remoteCallCount: 1,
        providerToolCallCount: 1,
      };
      if (input.arguments.failure === 'throttled') {
        throw new ManagedProviderRequestError('throttled', 'Provider throttled', {
          ...metadata, httpStatus: 429, rateLimitRemaining: 0, retryAfterMs: 30_000,
        });
      }
      if (input.arguments.failure === 'provider_unavailable') {
        throw new ManagedProviderRequestError(
          'provider_unavailable',
          'Provider unavailable',
          { ...metadata, httpStatus: 503 },
        );
      }
      if (input.arguments.failure === 'ambiguous') {
        throw new ManagedProviderRequestError('ambiguous', 'Write outcome is ambiguous', metadata);
      }
      if (input.arguments.failure === 'authorization_expired') {
        throw new ManagedAuthorizationExpiredError(metadata);
      }
      if (input.arguments.oversized === true) {
        return { data: { value: '\ud83e\udd5c'.repeat(70_000) } };
      }
      if (input.arguments.unserializable === true) {
        return {
          data: { value: 1n },
          providerTool: 'GMAIL_FETCH_EMAILS',
          providerVersion: '20260817_00',
          remoteCallCount: 1,
          providerToolCallCount: 1,
        };
      }
      return { data: { ok: true } };
    },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: providers,
    randomId: (() => { let id = 0; return () => `managed${++id}`; })(),
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    await assert.rejects(
      service.createForAgent({
        principal: principal(), agentId: 'agent_mail', workspaceId: 'T_MANAGED',
        ownerKind: 'member', providerId: 'google', label: 'Invalid Gmail',
        policy: MANAGED_POLICY, allowedCapabilities: ['gmail.messages.send'],
      }),
      /exceeds the account capability ceiling/,
    );
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_mail', workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Work Gmail',
      policy: MANAGED_POLICY, allowedCapabilities: ['gmail.messages.search'],
    });
    assert.equal(account.lifecycle, 'ready');

    const result = await invokeManagedConnectionCapability({
      config,
      identity: activeIdentity(),
      providers,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_alice',
      connectionAccountId: account.id,
      capability: 'gmail.messages.search',
      arguments: { query: 'is:unread' },
      usage,
      correlation: { operationId: 'operation_mail_1', runId: 'run_mail_1' },
    });
    assert.deepEqual(result.data, { ok: true });
    assert.deepEqual(calls, ['gmail.messages.search']);

    await assert.rejects(
      invokeManagedConnectionCapability({
        config,
        identity: activeIdentity(),
        providers,
        workspaceId: 'T_MANAGED',
        agentId: 'agent_mail',
        actorMembershipId: 'membership_alice',
        connectionAccountId: account.id,
        capability: 'gmail.messages.search',
        arguments: { query: 'is:unread', oversized: true },
        usage,
      }),
      /result exceeded Chickpea\u2019s size limit/,
    );
    assert.deepEqual(calls, ['gmail.messages.search', 'gmail.messages.search']);

    await assert.rejects(
      invokeManagedConnectionCapability({
        config,
        identity: activeIdentity(),
        providers,
        workspaceId: 'T_MANAGED',
        agentId: 'agent_mail',
        actorMembershipId: 'membership_alice',
        connectionAccountId: account.id,
        capability: 'gmail.messages.search',
        arguments: { query: 'is:unread', unserializable: true },
        usage,
      }),
      /BigInt/,
    );
    assert.deepEqual(calls, [
      'gmail.messages.search', 'gmail.messages.search', 'gmail.messages.search',
    ]);

    await assert.rejects(
      invokeManagedConnectionCapability({
        config,
        identity: activeIdentity(),
        providers,
        workspaceId: 'T_MANAGED',
        agentId: 'agent_mail',
        actorMembershipId: 'membership_alice',
        connectionAccountId: account.id,
        capability: 'gmail.drafts.create',
        arguments: { recipientEmail: 'bob@example.test', subject: 'Hi', body: 'Hello' },
        usage,
      }),
      /capability is not available/i,
    );
    assert.deepEqual(calls, [
      'gmail.messages.search', 'gmail.messages.search', 'gmail.messages.search',
    ]);

    for (const failure of [
      'throttled',
      'provider_unavailable',
      'ambiguous',
      'authorization_expired',
    ]) {
      await assert.rejects(
        invokeManagedConnectionCapability({
          config,
          identity: activeIdentity(),
          providers,
          workspaceId: 'T_MANAGED',
          agentId: 'agent_mail',
          actorMembershipId: 'membership_alice',
          connectionAccountId: account.id,
          capability: 'gmail.messages.search',
          arguments: { query: 'is:unread', failure },
          usage,
        }),
      );
    }

    const revoked = await service.revoke({
      principal: principal(), connectionAccountId: account.id,
    });
    assert.equal(revoked.lifecycle, 'revoked');
    assert.deepEqual(calls, [
      'gmail.messages.search',
      'gmail.messages.search',
      'gmail.messages.search',
      'gmail.messages.search',
      'gmail.messages.search',
      'gmail.messages.search',
      'gmail.messages.search',
      'revoke:ca_test_account',
    ]);
    const summary = await usage.summarizeConnectorUsage({
      from: usageWindowStart,
      to: Date.now() + 60_000,
      workspaceId: 'T_MANAGED',
    });
    assert.equal(summary.attemptCount, 8);
    assert.equal(summary.successCount, 1);
    assert.equal(summary.errorCount, 7);
    assert.equal(summary.throttledCount, 1);
    assert.equal(summary.ambiguousCount, 1);
    assert.equal(summary.providerToolCallCount, 7);
    assert.equal(summary.estimatedCostMicros, 4_200);
  } finally {
    config.close();
    settings.close();
    usage.close();
  }
});

test('Google productivity tools execute reads and writes through the Agent runtime on their bound accounts', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  const calls: Array<{
    accountRef: string;
    capability: string;
    arguments: Record<string, unknown>;
  }> = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute(input) {
      calls.push({
        accountRef: input.policy.accountRef,
        capability: input.capability,
        arguments: input.arguments,
      });
      return {
        data: { accountRef: input.policy.accountRef, capability: input.capability },
        providerTool: `FIXTURE_${input.capability}`,
        providerVersion: '20260813_00',
        remoteCallCount: 1,
        providerToolCallCount: 1,
      };
    },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: providers,
    randomId: (() => { let id = 0; return () => `productivity${++id}`; })(),
  });
  const fixtures = [
    {
      toolkit: 'googlesheets',
      accountRef: 'ca_sheets_alice',
      capabilities: ['sheets.values.get', 'sheets.values.append'],
    },
    {
      toolkit: 'googledocs',
      accountRef: 'ca_docs_alice',
      capabilities: ['docs.documents.text', 'docs.documents.create_markdown'],
    },
    {
      toolkit: 'googleslides',
      accountRef: 'ca_slides_alice',
      capabilities: ['slides.presentations.get', 'slides.presentations.batch_update'],
    },
  ] as const;
  try {
    await config.createAgent({
      id: 'agent_productivity', name: 'Productivity', instructions: 'Work with files.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct',
      defaultAgentId: 'agent_productivity',
    });

    const connections = [];
    for (const fixture of fixtures) {
      const { account } = await service.createForAgent({
        principal: principal(), agentId: 'agent_productivity',
        workspaceId: 'T_MANAGED', ownerKind: 'member',
        providerId: 'google', label: fixture.toolkit,
        policy: {
          kind: 'managed', adapterId: 'composio', toolkit: fixture.toolkit,
          principalRef: 'chickpea-user-1', accountRef: fixture.accountRef,
          allowedCapabilities: [...fixture.capabilities],
        },
      });
      connections.push({
        id: account.id, providerId: account.providerId, adapterId: 'composio',
        toolkit: fixture.toolkit, allowedCapabilities: [...fixture.capabilities],
      });
    }

    const tools = createManagedConnectionTools({
      connections,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_productivity',
      actorMembershipId: 'membership_alice',
      resolvePlatformEnv: async () => undefined,
      providers,
      stores: { config, identity: activeIdentity(), usage },
    });
    const run = async (name: string, data: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} should be projected into the Agent runtime`);
      const result = await tool.run({
        toolCallId: `call_${name}`,
        log: { info() {}, warn() {}, error() {} },
        data,
      });
      const output = typeof result === 'object' && result !== null && 'output' in result
        ? result.output
        : result;
      return JSON.parse(String(output)) as Record<string, unknown>;
    };

    assert.equal((await run('google_sheets_get_values', {
      spreadsheetId: 'sheet_1', range: 'Leads!A1:C10',
    })).accountRef, 'ca_sheets_alice');
    assert.equal((await run('google_sheets_append_values', {
      spreadsheetId: 'sheet_1', range: 'Leads!A:C', values: [['Acme', 42, true]],
    })).accountRef, 'ca_sheets_alice');
    assert.equal((await run('google_docs_get_text', {
      documentId: 'doc_1', includeTables: true,
    })).accountRef, 'ca_docs_alice');
    assert.equal((await run('google_docs_create_markdown', {
      title: 'Weekly brief', markdown: '# Weekly brief\n\nAll systems go.',
    })).accountRef, 'ca_docs_alice');
    assert.equal((await run('google_slides_get_presentation', {
      presentationId: 'slides_1',
    })).accountRef, 'ca_slides_alice');
    assert.equal((await run('google_slides_update', {
      presentationId: 'slides_1',
      operations: [{
        kind: 'replace_all_text', findText: '{{quarter}}', replaceText: 'Q3',
      }],
    })).accountRef, 'ca_slides_alice');

    assert.deepEqual(calls.map(({ accountRef, capability }) => ({ accountRef, capability })), [
      { accountRef: 'ca_sheets_alice', capability: 'sheets.values.get' },
      { accountRef: 'ca_sheets_alice', capability: 'sheets.values.append' },
      { accountRef: 'ca_docs_alice', capability: 'docs.documents.text' },
      { accountRef: 'ca_docs_alice', capability: 'docs.documents.create_markdown' },
      { accountRef: 'ca_slides_alice', capability: 'slides.presentations.get' },
      { accountRef: 'ca_slides_alice', capability: 'slides.presentations.batch_update' },
    ]);
    assert.deepEqual(calls[5]?.arguments, {
      presentationId: 'slides_1',
      operations: [{
        kind: 'replace_all_text', findText: '{{quarter}}', replaceText: 'Q3',
      }],
    });
    const summary = await usage.summarizeConnectorUsage({
      from: Date.now() - 60_000, to: Date.now() + 60_000, workspaceId: 'T_MANAGED',
    });
    assert.equal(summary.attemptCount, 6);
    assert.equal(summary.successCount, 6);
  } finally {
    config.close();
    settings.close();
    usage.close();
  }
});

test('managed Notion reads and writes through its exact Agent-bound account without replacing Native Notion', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  const calls: Array<{
    accountRef: string;
    capability: string;
    arguments: Record<string, unknown>;
  }> = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute(input) {
      calls.push({
        accountRef: input.policy.accountRef,
        capability: input.capability,
        arguments: input.arguments,
      });
      return {
        data: { accountRef: input.policy.accountRef, capability: input.capability },
        providerTool: `FIXTURE_${input.capability}`,
        providerVersion: '20260819_00',
        remoteCallCount: 1,
        providerToolCallCount: 1,
      };
    },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: providers,
    randomId: () => 'notion_runtime',
  });
  try {
    await config.createAgent({
      id: 'agent_notion', name: 'Notion', instructions: 'Work with approved Notion content.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [],
      mcpServers: [{
        id: 'notion', displayName: 'Native Notion', url: 'https://mcp.notion.com/mcp',
        transport: 'streamable-http', authMode: 'oauth', headerNames: [], enabled: true,
        lifecycleStatus: 'ready', statusText: 'Connected', discoveredTools: [],
        allowedTools: ['notion-search'], presetId: 'notion',
      }],
      apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_notion',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_notion',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'notion', label: 'Managed Notion',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'notion',
        principalRef: 'chickpea-user-1', accountRef: 'ca_notion_alice',
        allowedCapabilities: ['notion.pages.get', 'notion.pages.create'],
      },
    });
    const tools = createManagedConnectionTools({
      connections: [{
        id: account.id, providerId: 'notion', adapterId: 'composio', toolkit: 'notion',
        allowedCapabilities: ['notion.pages.get', 'notion.pages.create'],
      }],
      workspaceId: 'T_MANAGED', agentId: 'agent_notion',
      actorMembershipId: 'membership_alice', resolvePlatformEnv: async () => undefined,
      providers, stores: { config, identity: activeIdentity(), usage },
    });
    const run = async (name: string, data: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool);
      const result = await tool.run({
        toolCallId: `call_${name}`,
        log: { info() {}, warn() {}, error() {} },
        data,
      });
      const output = typeof result === 'object' && result !== null && 'output' in result
        ? result.output
        : result;
      return JSON.parse(String(output)) as Record<string, unknown>;
    };

    assert.equal((await run('notion_get_page', { pageId: 'page_allowed' })).accountRef, 'ca_notion_alice');
    assert.equal((await run('notion_create_page', {
      parentId: 'page_allowed', title: 'Child canary', markdown: 'Created by Chickpea.',
    })).accountRef, 'ca_notion_alice');
    assert.deepEqual(calls, [
      {
        accountRef: 'ca_notion_alice', capability: 'notion.pages.get',
        arguments: { pageId: 'page_allowed' },
      },
      {
        accountRef: 'ca_notion_alice', capability: 'notion.pages.create',
        arguments: {
          parentId: 'page_allowed', title: 'Child canary', markdown: 'Created by Chickpea.',
        },
      },
    ]);
    await service.revoke({ principal: principal(), connectionAccountId: account.id });
    assert.deepEqual((await config.getAgent('agent_notion')).mcpServers.map(({ presetId }) => presetId), ['notion']);
  } finally {
    config.close();
    settings.close();
    usage.close();
  }
});

test('managed setup rejects a second owner lane for the same Agent and toolkit', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: (() => { let id = 0; return () => `lane${++id}`; })(),
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const create = (accountRef: string) => service.createForAgent({
      principal: principal(),
      agentId: 'agent_mail',
      workspaceId: 'T_MANAGED',
      ownerKind: 'member' as const,
      providerId: 'google',
      label: 'Gmail · Personal',
      policy: { ...MANAGED_POLICY, accountRef },
    });
    const first = await create('ca_lane_one');
    await assert.rejects(
      create('ca_lane_two'),
      ManagedConnectionConflictError,
    );
    assert.equal(first.binding.agentId, 'agent_mail');
  } finally {
    config.close();
    settings.close();
  }
});

test('managed personal owner lanes are isolated per member on the same Agent', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: (() => { let id = 0; return () => `member_lane${++id}`; })(),
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'all_workspace_members',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const create = (membershipId: string, accountRef: string) => service.createForAgent({
      principal: principal(membershipId),
      agentId: 'agent_mail',
      workspaceId: 'T_MANAGED',
      ownerKind: 'member' as const,
      providerId: 'google',
      label: 'Gmail · Personal',
      policy: {
        ...MANAGED_POLICY,
        principalRef: `chickpea:membership:${membershipId}`,
        accountRef,
      },
    });
    const { account: alice } = await create('membership_alice', 'ca_alice');
    const { account: bob } = await create('membership_bob', 'ca_bob');
    assert.deepEqual(
      (await config.listAgentConnectionBindings('agent_mail'))
        .map(({ connectionAccountId }) => connectionAccountId)
        .sort(),
      [alice.id, bob.id].sort(),
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('managed account imports reject a duplicate remote account before provider validation', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let validationCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() { validationCalls += 1; },
    async execute() { return { data: { ok: true } }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: (() => { let id = 0; return () => `duplicate${++id}`; })(),
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const { account: original } = await service.createForAgent({
      principal: principal(), agentId: 'agent_mail', workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Original Gmail', policy: MANAGED_POLICY,
    });

    await assert.rejects(
      service.createForAgent({
        principal: principal(), agentId: 'agent_mail',
        workspaceId: 'T_MANAGED', ownerKind: 'member',
        providerId: 'google', label: 'Duplicate Gmail',
        policy: { ...MANAGED_POLICY, adapterId: 'COMPOSIO' },
      }),
      /already committed to another connection/,
    );
    assert.equal(validationCalls, 1);
    assert.deepEqual(
      (await config.listConnectionAccounts('T_MANAGED')).map(({ id }) => id),
      [original.id],
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('managed remote lookup never returns an account from another workspace', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'workspace_scope',
  });
  try {
    await config.createAgent({
      id: 'agent_scope', name: 'Scoped', instructions: 'Stay scoped.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_scope',
    });
    await service.createForAgent({
      principal: principal(), agentId: 'agent_scope',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Scoped Gmail', policy: MANAGED_POLICY,
    });

    const foreign = await service.findManagedByRemoteRef({
      principal: principal(),
      workspaceId: 'T_OTHER',
      adapterId: 'composio',
      accountRef: MANAGED_POLICY.accountRef,
    });
    assert.equal(foreign, undefined);
  } finally {
    config.close();
    settings.close();
  }
});

test('managed reconnect preserves the Chickpea account and deletes the previous remote account', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const calls: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate(input) { calls.push(`validate:${input.policy.accountRef}`); },
    async execute() { return { data: { ok: true } }; },
    async revoke(input) { calls.push(`revoke:${input.policy.accountRef}`); },
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'reconnect',
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const { account: original } = await service.createForAgent({
      principal: principal(), agentId: 'agent_mail', workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: MANAGED_POLICY,
    });
    const expired = await config.putConnectionAccount(
      { ...original, lifecycle: 'needs_attention' },
      original.revision,
    );
    const reconnected = await service.replaceManagedAuthorization({
      principal: principal(),
      agentId: 'agent_mail',
      connectionAccountId: original.id,
      expectedRevision: expired.revision,
      adapterId: 'composio',
      toolkit: 'gmail',
      principalRef: MANAGED_POLICY.principalRef,
      allowedCapabilities: [...MANAGED_POLICY.allowedCapabilities],
      accountRef: 'ca_reconnected',
    });

    assert.equal(reconnected.id, original.id);
    assert.equal(reconnected.lifecycle, 'ready');
    assert.equal(
      reconnected.policy.kind === 'managed' ? reconnected.policy.accountRef : undefined,
      'ca_reconnected',
    );
    assert.deepEqual(calls, [
      'validate:ca_test_account',
      'validate:ca_reconnected',
      'revoke:ca_test_account',
    ]);
  } finally {
    config.close();
    settings.close();
  }
});

test('managed reconnect keeps a resource-incomplete account pending', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: { ok: true } }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'reconnect_pending_ads',
  });
  try {
    await config.createAgent({
      id: 'agent_ads', name: 'Ads', instructions: 'Read selected ad accounts.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_ads',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_ads', workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Google Ads',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'googleads',
        principalRef: 'chickpea-user-1', accountRef: 'ca_ads_pending',
        allowedCapabilities: ['ads.campaigns.report'],
      },
    });
    assert.equal(account.lifecycle, 'pending');

    const reconnected = await service.replaceManagedAuthorization({
      principal: principal(),
      agentId: 'agent_ads',
      connectionAccountId: account.id,
      expectedRevision: account.revision,
      adapterId: 'composio',
      toolkit: 'googleads',
      principalRef: 'chickpea-user-1',
      allowedCapabilities: ['ads.campaigns.report'],
      accountRef: 'ca_ads_reconnected',
    });
    assert.equal(reconnected.lifecycle, 'pending');
  } finally {
    config.close();
    settings.close();
  }
});

test('managed Agent bindings keep their original ceiling when reauthorization broadens the account', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: { ok: true } }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: (() => { let id = 0; return () => `ceiling${++id}`; })(),
  });
  const readCapabilities = ['gmail.messages.search'];
  try {
    await config.createAgent({
      id: 'agent_reader', name: 'Reader', instructions: 'Read mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_reader',
    });
    const { account, binding } = await service.createForAgent({
      principal: principal(), agentId: 'agent_reader', workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Personal Gmail',
      policy: { ...MANAGED_POLICY, allowedCapabilities: readCapabilities },
    });
    assert.deepEqual(binding.allowedCapabilities, readCapabilities);

    await service.replaceManagedAuthorization({
      principal: principal(),
      agentId: 'agent_reader',
      connectionAccountId: account.id,
      expectedRevision: account.revision,
      adapterId: 'composio',
      toolkit: 'gmail',
      principalRef: MANAGED_POLICY.principalRef,
      expectedAllowedCapabilities: readCapabilities,
      allowedCapabilities: [...readCapabilities, 'gmail.drafts.create'],
      accountRef: MANAGED_POLICY.accountRef,
    });

    const [effective] = await resolveEffectiveConnectionAccounts({
      config,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_reader',
      actorMembershipId: 'membership_alice',
    });
    assert.equal(effective?.policy.kind, 'managed');
    assert.deepEqual(
      effective?.policy.kind === 'managed' ? effective.policy.allowedCapabilities : undefined,
      readCapabilities,
    );

    await config.putAgentConnectionBinding({ ...binding, allowedCapabilities: [] });
    const [legacyEffective] = await resolveEffectiveConnectionAccounts({
      config,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_reader',
      actorMembershipId: 'membership_alice',
    });
    assert.deepEqual(
      legacyEffective?.policy.kind === 'managed'
        ? legacyEffective.policy.allowedCapabilities
        : undefined,
      [],
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('two Agents may separately authorize the same external managed identity', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: { ok: true } }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: (() => { let id = 0; return () => `scoped_${++id}`; })(),
  });
  const selectedProperty = {
    handle: 'property_primary',
    providerRef: 'properties/123',
    label: 'Website — Acme',
  };
  try {
    for (const id of ['agent_analytics_a', 'agent_analytics_b']) {
      await config.createAgent({
        id,
        name: id,
        instructions: 'Read bounded analytics reports.',
        enabled: true,
        creatorMembershipId: 'membership_alice',
        editPolicy: 'creator_and_admins',
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
      });
    }
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED',
      transportMode: 'direct',
      defaultAgentId: 'agent_analytics_a',
    });
    const { account: accountA, binding: bindingA } = await service.createForAgent({
      principal: principal(),
      agentId: 'agent_analytics_a',
      workspaceId: 'T_MANAGED',
      ownerKind: 'team',
      providerId: 'google',
      label: 'Growth Analytics',
      policy: {
        kind: 'managed',
        adapterId: 'composio',
        toolkit: 'google_analytics',
        principalRef: 'chickpea:organization:T_MANAGED',
        accountRef: 'ca_analytics_a',
        allowedCapabilities: ['analytics.reports.run'],
        resourceConstraints: { propertyIds: [selectedProperty] },
      },
      resourceConstraints: { propertyIds: [selectedProperty.handle] },
    });
    const { account: accountB, binding: bindingB } = await service.createForAgent({
      principal: principal(),
      agentId: 'agent_analytics_b',
      workspaceId: 'T_MANAGED',
      ownerKind: 'team',
      providerId: 'google',
      label: 'Growth Analytics',
      policy: {
        kind: 'managed',
        adapterId: 'composio',
        toolkit: 'google_analytics',
        principalRef: 'chickpea:organization:T_MANAGED',
        accountRef: 'ca_analytics_b',
        allowedCapabilities: ['analytics.reports.run'],
        resourceConstraints: { propertyIds: [selectedProperty] },
      },
      resourceConstraints: { propertyIds: [selectedProperty.handle] },
    });

    assert.notEqual(accountA.id, accountB.id);
    assert.equal(bindingA.agentId, 'agent_analytics_a');
    assert.equal(bindingB.agentId, 'agent_analytics_b');
    const [effective] = await resolveEffectiveConnectionAccounts({
      config,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_analytics_b',
      actorMembershipId: 'membership_alice',
    });
    assert.equal(effective?.policy.kind, 'managed');
    if (effective?.policy.kind !== 'managed') assert.fail('expected a managed policy');
    assert.deepEqual(effective.policy.allowedCapabilities, ['analytics.reports.run']);
    assert.deepEqual(effective.policy.resourceConstraints, {
      propertyIds: [selectedProperty],
    });

    const serializedViews = JSON.stringify(await service.listViews('T_MANAGED'));
    assert.doesNotMatch(serializedViews, /ca_analytics_[ab]|properties\/123|chickpea:organization/);
    assert.match(serializedViews, /property_primary/);
    assert.match(serializedViews, /Website — Acme/);
  } finally {
    config.close();
    settings.close();
  }
});

test('replayed expiry handling finishes pausing schedules after a partial first delivery', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: { ok: true } }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'expiry',
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_mail', workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Work Gmail',
      policy: MANAGED_POLICY, allowedCapabilities: ['gmail.messages.search'],
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_replay', agentId: 'agent_mail', workspaceId: 'T_MANAGED',
      channelId: 'C_MAIL', createdByMembershipId: 'membership_alice',
      runsAsMembershipId: 'membership_alice', authorityReceiptId: 'authority_replay',
      requiredConnectionAccountIds: [account.id], state: 'active',
    });
    await config.putConnectionAccount(
      { ...account, lifecycle: 'needs_attention' },
      account.revision,
    );

    assert.equal(await service.markManagedAccountExpired({
      adapterId: 'composio', accountRef: MANAGED_POLICY.accountRef,
    }), 0);
    assert.equal(
      (await config.listAgentScheduleReferences('agent_mail'))[0]?.state,
      'needs_attention',
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('provider reconciliation fails closed, pauses schedules, and restores only matched lineage', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: { ok: true } }; },
    async revoke() { assert.fail('provider lifecycle must not revoke remote accounts'); },
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'provider_reconcile',
  });
  try {
    await config.createAgent({
      id: 'agent_mail_reconcile', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail_reconcile',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_mail_reconcile',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: {
        ...MANAGED_POLICY,
        providerGeneration: 4,
        providerLineage: 'a'.repeat(24),
      },
      allowedCapabilities: ['gmail.messages.search'],
    });
    const blocker = await config.putConnectionAccount({
      id: 'connection_secondary_requirement', workspaceId: 'T_MANAGED', ownerKind: 'team',
      createdByMembershipId: 'membership_alice', providerId: 'custom', label: 'Secondary API',
      policy: {
        kind: 'api', allowedHosts: ['api.example.test'], pathPrefixes: ['/'],
        headerName: 'authorization', allowedMethods: ['GET'], authMode: 'credential',
      },
      secretRefId: 'secret_secondary_requirement', lifecycle: 'ready',
    }, 0);
    await config.putAgentConnectionBinding({
      agentId: 'agent_mail_reconcile', connectionAccountId: blocker.id,
      providerId: 'custom', allowedCapabilities: [], enabled: true,
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_provider_reconcile', agentId: 'agent_mail_reconcile',
      workspaceId: 'T_MANAGED', channelId: 'C_MAIL',
      createdByMembershipId: 'membership_alice', runsAsMembershipId: 'membership_alice',
      authorityReceiptId: 'authority_provider_reconcile',
      requiredConnectionAccountIds: [account.id, blocker.id], state: 'active',
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_preexisting_attention', agentId: 'agent_mail_reconcile',
      workspaceId: 'T_MANAGED', channelId: 'C_MAIL',
      createdByMembershipId: 'membership_alice', runsAsMembershipId: 'membership_alice',
      authorityReceiptId: 'authority_preexisting_attention',
      requiredConnectionAccountIds: [account.id], state: 'needs_attention',
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_archived_connector_pause', agentId: 'agent_mail_reconcile',
      workspaceId: 'T_MANAGED', channelId: 'C_MAIL',
      createdByMembershipId: 'membership_alice', runsAsMembershipId: 'membership_alice',
      authorityReceiptId: 'authority_archived_connector_pause',
      requiredConnectionAccountIds: [account.id],
      connectionPauseAccountIds: [account.id],
      state: 'archived',
    });

    assert.deepEqual(await markManagedProviderAccountsUnavailable(config, {
      adapterId: 'composio',
    }), { accounts: 1, schedules: 1, retryable: 0 });
    assert.equal(
      (await config.listConnectionAccounts('T_MANAGED')).find(({ id }) => id === account.id)?.lifecycle,
      'needs_attention',
    );
    const pausedSchedules = await config.listAgentScheduleReferences('agent_mail_reconcile');
    const paused = pausedSchedules.find(({ scheduleId }) =>
      scheduleId === 'schedule_provider_reconcile')!;
    assert.equal(paused.state, 'needs_attention');
    assert.deepEqual(paused.connectionPauseAccountIds, [account.id]);
    const preexisting = pausedSchedules.find(({ scheduleId }) =>
      scheduleId === 'schedule_preexisting_attention')!;
    assert.equal(preexisting.state, 'needs_attention');
    assert.deepEqual(preexisting.connectionPauseAccountIds, [account.id]);
    assert.equal(preexisting.connectionPausePreservesState, true);
    const archived = pausedSchedules.find(({ scheduleId }) =>
      scheduleId === 'schedule_archived_connector_pause')!;
    assert.equal(archived.state, 'archived');
    assert.deepEqual(archived.connectionPauseAccountIds, [account.id]);
    const blockerBinding = (await config.listAgentConnectionBindings('agent_mail_reconcile'))
      .find(({ connectionAccountId }) => connectionAccountId === blocker.id)!;
    await config.putAgentConnectionBinding({ ...blockerBinding, enabled: false });

    assert.deepEqual(await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio', generation: 5, lineage: 'b'.repeat(24),
      inspect: async ({ accountRef, principalRef, toolkit }) => {
        assert.equal(accountRef, MANAGED_POLICY.accountRef);
        assert.equal(principalRef, MANAGED_POLICY.principalRef);
        assert.equal(toolkit, 'gmail');
        return 'match';
      },
    }), { restored: 1, needsAttention: 0, retryable: 0 });
    const restored = (await config.listConnectionAccounts('T_MANAGED'))
      .find(({ id }) => id === account.id)!;
    assert.equal(restored.lifecycle, 'ready');
    assert.equal(restored.policy.kind, 'managed');
    if (restored.policy.kind !== 'managed') assert.fail('expected managed policy');
    assert.equal(restored.policy.providerGeneration, 5);
    assert.equal(restored.policy.providerLineage, 'b'.repeat(24));
    const reconciledSchedules = await config.listAgentScheduleReferences('agent_mail_reconcile');
    const deferred = reconciledSchedules.find(({ scheduleId }) =>
      scheduleId === 'schedule_provider_reconcile')!;
    assert.equal(deferred.state, 'needs_attention');
    assert.deepEqual(
      deferred.connectionPauseAccountIds,
      [blocker.id],
      'a deferred resume must track the connection that is still unavailable',
    );
    assert.equal(
      reconciledSchedules.find(({ scheduleId }) =>
        scheduleId === 'schedule_preexisting_attention')?.state,
      'needs_attention',
      'reconciliation must not reactivate a schedule paused for another reason',
    );
    assert.equal(
      reconciledSchedules.find(({ scheduleId }) =>
        scheduleId === 'schedule_preexisting_attention')?.connectionPauseAccountIds,
      undefined,
    );
    await config.putAgentConnectionBinding({ ...blockerBinding, enabled: true });
    let repeatedInspections = 0;
    assert.deepEqual(await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio', generation: 5, lineage: 'b'.repeat(24),
      inspect: async () => { repeatedInspections += 1; return 'match'; },
    }), { restored: 0, needsAttention: 0, retryable: 0 });
    assert.equal(repeatedInspections, 0, 'an already reconciled account must be skipped');
    assert.equal(
      (await config.listAgentScheduleReferences('agent_mail_reconcile'))
        .find(({ scheduleId }) => scheduleId === 'schedule_provider_reconcile')?.state,
      'active',
      'an already-reconciled account must retry after another required binding becomes effective',
    );
    assert.equal(
      (await config.listAgentScheduleReferences('agent_mail_reconcile'))
        .find(({ scheduleId }) => scheduleId === 'schedule_provider_reconcile')
        ?.connectionPauseAccountIds,
      undefined,
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('an archived Agent restores its schedules across a managed provider outage', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: { ok: true } }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'archive_outage',
  });
  try {
    await config.createAgent({
      id: 'agent_archive_outage', name: 'Archived Mail', instructions: 'Check mail.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.createAgent({
      id: 'agent_archive_fallback', name: 'Fallback', instructions: 'Stay available.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct',
      defaultAgentId: 'agent_archive_fallback',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_archive_outage',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Archived Gmail', policy: {
        ...MANAGED_POLICY,
        providerGeneration: 1,
        providerLineage: 'a'.repeat(24),
      },
      allowedCapabilities: ['gmail.messages.search'],
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_archive_outage', agentId: 'agent_archive_outage',
      workspaceId: 'T_MANAGED', channelId: 'C_MAIL',
      createdByMembershipId: 'membership_alice', runsAsMembershipId: 'membership_alice',
      authorityReceiptId: 'authority_archive_outage',
      requiredConnectionAccountIds: [account.id], state: 'active',
    });

    await config.archiveAgent('agent_archive_outage');
    assert.equal(
      (await config.getAgentScheduleReference('schedule_archive_outage'))?.state,
      'paused',
    );
    assert.deepEqual(await markManagedProviderAccountsUnavailable(config, {
      adapterId: 'composio',
    }), { accounts: 1, schedules: 0, retryable: 0 });
    const parkedDuringOutage = await config.getAgentScheduleReference('schedule_archive_outage');
    assert.equal(parkedDuringOutage?.state, 'paused');
    assert.deepEqual(parkedDuringOutage?.connectionPauseAccountIds, [account.id]);
    assert.equal(parkedDuringOutage?.connectionPausePreservesState, undefined);

    await config.restoreAgent('agent_archive_outage');
    assert.equal(
      (await config.getAgentScheduleReference('schedule_archive_outage'))?.state,
      'needs_attention',
    );
    assert.deepEqual(await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio', generation: 2, lineage: 'b'.repeat(24),
      inspect: async () => 'match',
    }), { restored: 1, needsAttention: 0, retryable: 0 });
    const recovered = await config.getAgentScheduleReference('schedule_archive_outage');
    assert.equal(recovered?.state, 'active');
    assert.equal(recovered?.connectionPauseAccountIds, undefined);

    assert.deepEqual(await markManagedProviderAccountsUnavailable(config, {
      adapterId: 'composio',
    }), { accounts: 1, schedules: 1, retryable: 0 });
    assert.equal(
      (await config.getAgentScheduleReference('schedule_archive_outage'))?.state,
      'needs_attention',
    );
    await config.archiveAgent('agent_archive_outage');
    assert.equal(
      (await config.getAgentScheduleReference('schedule_archive_outage'))?.state,
      'paused',
    );
    assert.deepEqual(await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio', generation: 3, lineage: 'c'.repeat(24),
      inspect: async () => 'match',
    }), { restored: 1, needsAttention: 0, retryable: 0 });
    const recoveredWhileArchived = await config.getAgentScheduleReference(
      'schedule_archive_outage',
    );
    assert.equal(recoveredWhileArchived?.state, 'paused');
    assert.equal(recoveredWhileArchived?.connectionPauseAccountIds, undefined);
    assert.equal((await config.getAgent('agent_archive_outage')).lifecycle, 'archived');
    await config.restoreAgent('agent_archive_outage');
    assert.equal(
      (await config.getAgentScheduleReference('schedule_archive_outage'))?.state,
      'active',
    );

    await config.archiveAgent('agent_archive_outage');
    assert.equal(
      (await config.getAgentScheduleReference('schedule_archive_outage'))?.state,
      'paused',
    );
    assert.equal((await service.revoke({
      principal: principal(), connectionAccountId: account.id,
    })).lifecycle, 'revoked');
    const parkedAfterRevocation = await config.getAgentScheduleReference(
      'schedule_archive_outage',
    );
    assert.equal(parkedAfterRevocation?.state, 'paused');
    assert.deepEqual(parkedAfterRevocation?.requiredConnectionAccountIds, []);
    assert.equal(parkedAfterRevocation?.connectionPauseAccountIds, undefined);
    await config.restoreAgent('agent_archive_outage');
    assert.equal(
      (await config.getAgentScheduleReference('schedule_archive_outage'))?.state,
      'active',
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('provider reconciliation batches accounts and skips completed work on retry', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: { ok: true } }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'reconcile_batch_first',
  });
  try {
    await config.createAgent({
      id: 'agent_reconcile_batch', name: 'Batch', instructions: 'Reconcile accounts.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_reconcile_batch',
    });
    const { account: first } = await service.createForAgent({
      principal: principal(), agentId: 'agent_reconcile_batch',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'First Gmail', policy: {
        ...MANAGED_POLICY,
        providerGeneration: 1,
        providerLineage: 'a'.repeat(24),
      },
    });
    if (first.policy.kind !== 'managed') assert.fail('expected managed policy');
    await config.putConnectionAccount({
      ...first,
      id: 'connection_reconcile_batch_second',
      label: 'Second Gmail',
      policy: {
        ...first.policy,
        accountRef: 'ca_reconcile_batch_second',
      },
    }, 0);

    let inspections = 0;
    const inspect = async () => { inspections += 1; return 'match' as const; };
    assert.deepEqual(await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio', generation: 2, lineage: 'b'.repeat(24),
      maxInspections: 1,
      inspect,
    }), { restored: 1, needsAttention: 0, retryable: 1 });
    assert.equal(inspections, 1);

    let scheduleReads = 0;
    let accountReads = 0;
    let bindingReads = 0;
    const instrumentedConfig = new Proxy(config, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (property === 'listAgentScheduleReferences') scheduleReads += 1;
          if (property === 'listConnectionAccounts') accountReads += 1;
          if (property === 'listAgentConnectionBindings') bindingReads += 1;
          return Reflect.apply(value, target, args);
        };
      },
    });
    assert.deepEqual(await reconcileManagedProviderAccounts(instrumentedConfig, {
      adapterId: 'composio', generation: 2, lineage: 'b'.repeat(24),
      maxInspections: 1,
      inspect,
    }), { restored: 1, needsAttention: 0, retryable: 0 });
    assert.equal(inspections, 2);
    assert.equal(scheduleReads, 1, 'one reconciliation pass indexes each Agent schedule list once');
    assert.equal(accountReads, 1, 'one reconciliation pass loads each workspace account list once');
    assert.equal(bindingReads, 1, 'one reconciliation pass loads each Agent binding list once');
    const reconciled = await config.listConnectionAccounts('T_MANAGED');
    assert.equal(reconciled.every((account) => account.policy.kind === 'managed' &&
      account.policy.providerGeneration === 2 &&
      account.policy.providerLineage === 'b'.repeat(24)), true);
  } finally {
    config.close();
    settings.close();
  }
});

test('provider reconciliation treats account revision races as retryable work', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([{
      id: 'composio',
      async validate() {},
      async execute() { return { data: {} }; },
      async revoke() {},
    }]),
    randomId: () => 'revision_race',
  });
  try {
    await config.createAgent({
      id: 'agent_revision_race', name: 'Race', instructions: 'Test reconciliation races.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_revision_race',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_revision_race',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Racing Gmail', policy: {
        ...MANAGED_POLICY,
        providerGeneration: 1,
        providerLineage: 'a'.repeat(24),
      },
    });
    let revisionConflictsRemaining = Number.POSITIVE_INFINITY;
    let putAttempts = 0;
    const racingConfig = new Proxy(config, {
      get(target, property, receiver) {
        if (property === 'putConnectionAccount') {
          return async (...arguments_: Parameters<typeof target.putConnectionAccount>) => {
            putAttempts += 1;
            if (revisionConflictsRemaining > 0) {
              revisionConflictsRemaining -= 1;
              throw new ConnectionAccountRevisionConflictError(
                account.id,
                account.revision,
                account.revision + 1,
              );
            }
            return target.putConnectionAccount(...arguments_);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    assert.deepEqual(await reconcileManagedProviderAccounts(racingConfig, {
      adapterId: 'composio', generation: 2, lineage: 'b'.repeat(24),
      inspect: async () => 'match',
    }), { restored: 0, needsAttention: 0, retryable: 1 });
    assert.deepEqual(await markManagedProviderAccountsUnavailable(racingConfig, {
      adapterId: 'composio',
    }), { accounts: 0, schedules: 0, retryable: 1 });

    revisionConflictsRemaining = 1;
    putAttempts = 0;
    assert.equal(await markManagedAccountExpired(racingConfig, {
      adapterId: 'composio', accountRef: MANAGED_POLICY.accountRef,
    }), 1);
    assert.equal(putAttempts, 2);
    const needsAttention = (await config.listConnectionAccounts('T_MANAGED'))[0];
    assert.equal(needsAttention?.lifecycle, 'needs_attention');

    assert.ok(needsAttention);
    await config.putConnectionAccount(
      { ...needsAttention, lifecycle: 'ready' },
      needsAttention.revision,
    );
    revisionConflictsRemaining = Number.POSITIVE_INFINITY;
    putAttempts = 0;
    await assert.rejects(
      markManagedAccountExpired(racingConfig, {
        adapterId: 'composio', accountRef: MANAGED_POLICY.accountRef,
      }),
      ManagedConnectionConflictError,
    );
    assert.equal(putAttempts, 3);
  } finally {
    config.close();
    settings.close();
  }
});

test('legacy lineage is adopted only after successful concurrent execution', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let validateCalls = 0;
  let executeCalls = 0;
  let failExecution = true;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() { validateCalls += 1; },
    async execute({ policy }) {
      executeCalls += 1;
      assert.equal(policy.providerGeneration, 2);
      assert.equal(policy.providerLineage, 'b'.repeat(24));
      if (failExecution) {
        throw new ManagedProviderRequestError(
          'provider_unavailable',
          'temporary provider failure',
          { remoteCallCount: 1, providerToolCallCount: 0 },
        );
      }
      return { data: { ok: true } };
    },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider], {
    composio: { generation: 2, lineage: 'b'.repeat(24) },
  });
  const service = new ConnectionAccountService({
    config, settings, managedProviders: providers, randomId: () => 'legacy_lineage',
  });
  try {
    await config.createAgent({
      id: 'agent_legacy_lineage', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_legacy_lineage',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_legacy_lineage', workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Legacy Gmail',
      policy: MANAGED_POLICY, allowedCapabilities: ['gmail.messages.search'],
    });
    validateCalls = 0;

    await assert.rejects(invokeManagedConnectionCapability({
      config, identity: activeIdentity(), providers,
      workspaceId: 'T_MANAGED', agentId: 'agent_legacy_lineage',
      actorMembershipId: 'membership_alice', connectionAccountId: account.id,
      capability: 'gmail.messages.search', arguments: { query: 'is:unread' },
    }), (error: unknown) => error instanceof ManagedProviderRequestError &&
      error.code === 'provider_unavailable');
    const unverified = (await config.listConnectionAccounts('T_MANAGED'))[0]!;
    assert.equal(unverified.policy.kind, 'managed');
    if (unverified.policy.kind !== 'managed') assert.fail('expected managed policy');
    assert.equal(unverified.policy.providerGeneration, undefined);
    assert.equal(unverified.policy.providerLineage, undefined);
    failExecution = false;

    let lineageWriteFailed = false;
    const unavailableAdoptionStore = new Proxy(config, {
      get(target, property, receiver) {
        if (property === 'putConnectionAccount') {
          return async () => {
            lineageWriteFailed = true;
            throw new Error('simulated lineage write outage');
          };
        }
        if (property === 'listConnectionAccounts') {
          return async (workspaceId: string) => {
            if (lineageWriteFailed) throw new Error('simulated lineage recovery read outage');
            return target.listConnectionAccounts(workspaceId);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const completedDuringStoreOutage = await invokeManagedConnectionCapability({
      config: unavailableAdoptionStore, identity: activeIdentity(), providers,
      workspaceId: 'T_MANAGED', agentId: 'agent_legacy_lineage',
      actorMembershipId: 'membership_alice', connectionAccountId: account.id,
      capability: 'gmail.messages.search', arguments: { query: 'is:unread' },
    });
    assert.deepEqual(completedDuringStoreOutage.data, { ok: true });
    const stillUnverified = (await config.listConnectionAccounts('T_MANAGED'))[0]!;
    assert.equal(stillUnverified.policy.kind, 'managed');
    if (stillUnverified.policy.kind !== 'managed') assert.fail('expected managed policy');
    assert.equal(stillUnverified.policy.providerGeneration, undefined);
    assert.equal(stillUnverified.policy.providerLineage, undefined);

    await Promise.all([0, 1].map(() => invokeManagedConnectionCapability({
      config, identity: activeIdentity(), providers,
      workspaceId: 'T_MANAGED', agentId: 'agent_legacy_lineage',
      actorMembershipId: 'membership_alice', connectionAccountId: account.id,
      capability: 'gmail.messages.search', arguments: { query: 'is:unread' },
    })));

    assert.equal(validateCalls, 0);
    assert.equal(executeCalls, 4);
    const adopted = (await config.listConnectionAccounts('T_MANAGED'))[0]!;
    assert.equal(adopted.lifecycle, 'ready');
    assert.equal(adopted.policy.kind, 'managed');
    if (adopted.policy.kind !== 'managed') assert.fail('expected managed policy');
    assert.equal(adopted.policy.providerGeneration, 2);
    assert.equal(adopted.policy.providerLineage, 'b'.repeat(24));
  } finally {
    config.close();
    settings.close();
  }
});

test('execution blocks stale provider lineage before remote account validation or tool dispatch', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let validateCalls = 0;
  let executeCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() { validateCalls += 1; },
    async execute() { executeCalls += 1; return { data: { ok: true } }; },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider], {
    composio: { generation: 2, lineage: 'b'.repeat(24) },
  });
  const service = new ConnectionAccountService({
    config, settings, managedProviders: providers, randomId: () => 'stale_lineage',
  });
  try {
    await config.createAgent({
      id: 'agent_stale_lineage', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_stale_lineage',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_stale_lineage',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Stale Gmail', policy: {
        ...MANAGED_POLICY,
        providerGeneration: 1,
        providerLineage: 'a'.repeat(24),
      },
      allowedCapabilities: ['gmail.messages.search'],
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_stale_lineage', agentId: 'agent_stale_lineage',
      workspaceId: 'T_MANAGED', channelId: 'C_MAIL',
      createdByMembershipId: 'membership_alice', runsAsMembershipId: 'membership_alice',
      authorityReceiptId: 'authority_stale_lineage', requiredConnectionAccountIds: [account.id],
      state: 'active',
    });
    validateCalls = 0;

    await assert.rejects(invokeManagedConnectionCapability({
      config, identity: activeIdentity(), providers,
      workspaceId: 'T_MANAGED', agentId: 'agent_stale_lineage',
      actorMembershipId: 'membership_alice', connectionAccountId: account.id,
      capability: 'gmail.messages.search', arguments: { query: 'is:unread' },
    }), ManagedAuthorizationExpiredError);
    assert.equal(validateCalls, 0);
    assert.equal(executeCalls, 0);
    assert.equal((await config.listConnectionAccounts('T_MANAGED'))[0]?.lifecycle, 'needs_attention');
    assert.equal((await config.listAgentScheduleReferences('agent_stale_lineage'))[0]?.state, 'needs_attention');
  } finally {
    config.close();
    settings.close();
  }
});

test('an unreadable deployment generation fails closed without demoting connected accounts', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const unreadableSettings = new Proxy(settings, {
    get(target, property, receiver) {
      if (property === 'getSetting') {
        return async () => { throw new Error('settings RPC unavailable'); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(resolveDefaultManagedConnectionProviderRegistry({
    COMPOSIO_API_KEY: 'ak_generation_must_not_be_synthesized',
  }, { settings: unreadableSettings }), /settings RPC unavailable/);
  const unavailableProviders = createManagedConnectionProviderRegistry([]);
  assert.equal(unavailableProviders.get('composio'), undefined);
  assert.equal(unavailableProviders.configuration('composio'), undefined);

  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { assert.fail('an unreadable provider must not execute'); },
    async revoke() {},
  };
  const healthyProviders = createManagedConnectionProviderRegistry([provider], {
    composio: { generation: 2, lineage: 'b'.repeat(24) },
  });
  const service = new ConnectionAccountService({
    config, settings, managedProviders: healthyProviders, randomId: () => 'unreadable_generation',
  });
  try {
    await config.createAgent({
      id: 'agent_unreadable_generation', name: 'Mail', instructions: 'Help with mail.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct',
      defaultAgentId: 'agent_unreadable_generation',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_unreadable_generation',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: {
        ...MANAGED_POLICY,
        providerGeneration: 2,
        providerLineage: 'b'.repeat(24),
      },
      allowedCapabilities: ['gmail.messages.search'],
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_unreadable_generation', agentId: 'agent_unreadable_generation',
      workspaceId: 'T_MANAGED', channelId: 'C_MAIL',
      createdByMembershipId: 'membership_alice', runsAsMembershipId: 'membership_alice',
      authorityReceiptId: 'authority_unreadable_generation',
      requiredConnectionAccountIds: [account.id], state: 'active',
    });

    await assert.rejects(invokeManagedConnectionCapability({
      config, identity: activeIdentity(), providers: unavailableProviders,
      workspaceId: 'T_MANAGED', agentId: 'agent_unreadable_generation',
      actorMembershipId: 'membership_alice', connectionAccountId: account.id,
      capability: 'gmail.messages.search', arguments: { query: 'is:unread' },
    }), (error: unknown) => error instanceof ManagedProviderRequestError &&
      error.code === 'provider_unavailable');
    assert.equal((await config.listConnectionAccounts('T_MANAGED'))[0]?.lifecycle, 'ready');
    assert.equal(
      (await config.listAgentScheduleReferences('agent_unreadable_generation'))[0]?.state,
      'active',
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('a transient provider execution failure does not demote a healthy local account', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let transient = false;
  let executeCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() {
      executeCalls += 1;
      if (transient) throw new ManagedProviderRequestError(
        'provider_unavailable',
        'temporary provider failure',
        { remoteCallCount: 1, providerToolCallCount: 0, capabilityToolDispatched: false },
      );
      return { data: { ok: true } };
    },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider], {
    composio: { generation: 3, lineage: 'c'.repeat(24) },
  });
  const service = new ConnectionAccountService({
    config, settings, managedProviders: providers, randomId: () => 'transient_preflight',
  });
  try {
    await config.createAgent({
      id: 'agent_transient_preflight', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_transient_preflight',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_transient_preflight',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: {
        ...MANAGED_POLICY,
        providerGeneration: 3,
        providerLineage: 'c'.repeat(24),
      },
      allowedCapabilities: ['gmail.messages.search'],
    });
    transient = true;

    await assert.rejects(invokeManagedConnectionCapability({
      config, identity: activeIdentity(), providers,
      workspaceId: 'T_MANAGED', agentId: 'agent_transient_preflight',
      actorMembershipId: 'membership_alice', connectionAccountId: account.id,
      capability: 'gmail.messages.search', arguments: { query: 'is:unread' },
    }), (error: unknown) => error instanceof ManagedProviderRequestError &&
      error.code === 'provider_unavailable');
    assert.equal(executeCalls, 1);
    assert.equal((await config.listConnectionAccounts('T_MANAGED'))[0]?.lifecycle, 'ready');
  } finally {
    config.close();
    settings.close();
  }
});

test('an execution-time authorization failure demotes the account and pauses schedules', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { throw new ManagedAuthorizationExpiredError(); },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: providers,
    randomId: () => 'runtime_expiry',
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_mail', workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Work Gmail',
      policy: MANAGED_POLICY, allowedCapabilities: ['gmail.messages.search'],
    });
    assert.equal(account.revision, 1, 'managed import must be one atomic account write');
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_runtime_expiry', agentId: 'agent_mail', workspaceId: 'T_MANAGED',
      channelId: 'C_MAIL', createdByMembershipId: 'membership_alice',
      runsAsMembershipId: 'membership_alice', authorityReceiptId: 'authority_runtime_expiry',
      requiredConnectionAccountIds: [account.id], state: 'active',
    });

    await assert.rejects(
      invokeManagedConnectionCapability({
        config,
        identity: activeIdentity(),
        providers,
        workspaceId: 'T_MANAGED',
        agentId: 'agent_mail',
        actorMembershipId: 'membership_alice',
        connectionAccountId: account.id,
        capability: 'gmail.messages.search',
        arguments: { query: 'is:unread' },
      }),
      ManagedAuthorizationExpiredError,
    );
    assert.equal(
      (await config.listConnectionAccounts('T_MANAGED'))[0]?.lifecycle,
      'needs_attention',
    );
    assert.equal(
      (await config.listAgentScheduleReferences('agent_mail'))[0]?.state,
      'needs_attention',
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('an expiry demotion store failure preserves the actionable authorization error', async (t) => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const expired = new ManagedAuthorizationExpiredError({
    providerTool: 'GMAIL_FETCH_EMAILS',
    providerVersion: '20260817_00',
    remoteCallCount: 1,
    providerToolCallCount: 1,
    capabilityToolDispatched: true,
  });
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { throw expired; },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: providers,
    randomId: () => 'runtime_expiry_store_failure',
  });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_mail', workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Work Gmail',
      policy: MANAGED_POLICY, allowedCapabilities: ['gmail.messages.search'],
    });
    t.mock.method(config, 'putConnectionAccount', async () => {
      throw new Error('transient durable store failure');
    });

    await assert.rejects(invokeManagedConnectionCapability({
      config,
      identity: activeIdentity(),
      providers,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_alice',
      connectionAccountId: account.id,
      capability: 'gmail.messages.search',
      arguments: { query: 'is:unread' },
    }), (error: unknown) => error === expired);
    assert.ok(warnings.some((warning) =>
      warning.includes('chickpea.managed_connection.expiry_demotion_failed')));
  } finally {
    config.close();
    settings.close();
  }
});

test('managed provider validation failure leaves no persisted account', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() { throw new Error('managed account validation failed'); },
    async execute() { return { data: { ok: true } }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    await assert.rejects(
      service.createForAgent({
        principal: principal(), agentId: 'agent_mail',
        workspaceId: 'T_MANAGED', ownerKind: 'member',
        providerId: 'google', label: 'Invalid Gmail', policy: MANAGED_POLICY,
      }),
      /managed account validation failed/,
    );
    assert.deepEqual(await config.listConnectionAccounts('T_MANAGED'), []);
  } finally {
    config.close();
    settings.close();
  }
});

test('failed managed revocation stays fail closed and pauses dependent schedules', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let executionCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() {
      executionCalls += 1;
      return { data: { ok: true } };
    },
    async revoke() { throw new Error('remote account deletion failed'); },
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: providers,
    randomId: (() => { let id = 0; return () => `revoke${++id}`; })(),
  });
  try {
    await config.createAgent({
      id: 'agent_mail', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_mail', workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Work Gmail',
      policy: MANAGED_POLICY, allowedCapabilities: ['gmail.messages.search'],
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_mail', agentId: 'agent_mail', workspaceId: 'T_MANAGED',
      channelId: 'C_MAIL', createdByMembershipId: 'membership_alice',
      runsAsMembershipId: 'membership_alice', authorityReceiptId: 'authority_mail',
      requiredConnectionAccountIds: [account.id], state: 'active',
    });

    await assert.rejects(
      service.revoke({ principal: principal(), connectionAccountId: account.id }),
      /remote account deletion failed/,
    );
    assert.equal(
      (await config.listConnectionAccounts('T_MANAGED')).find(({ id }) => id === account.id)?.lifecycle,
      'needs_attention',
    );
    assert.equal(
      (await config.listAgentScheduleReferences('agent_mail'))[0]?.state,
      'needs_attention',
    );
    await assert.rejects(
      invokeManagedConnectionCapability({
        config,
        identity: activeIdentity(),
        providers,
        workspaceId: 'T_MANAGED',
        agentId: 'agent_mail',
        actorMembershipId: 'membership_alice',
        connectionAccountId: account.id,
        capability: 'gmail.messages.search',
        arguments: { query: 'is:unread' },
      }),
      /not available to this actor/,
    );
    assert.equal(executionCalls, 0);
  } finally {
    config.close();
    settings.close();
  }
});

test('Agent deletion keeps ownership records when provider cleanup fails', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([{
      id: 'composio',
      async validate() {},
      async execute() { return { data: {} }; },
      async revoke() { throw new Error('provider cleanup failed'); },
    }]),
    randomId: (() => { let id = 0; return () => `delete_failure_${++id}`; })(),
  });
  try {
    await config.createAgent({
      id: 'agent_fallback', name: 'Fallback', instructions: 'Stay available.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const agent = await config.createAgent({
      id: 'agent_delete_failure', name: 'Delete failure', instructions: 'Own Gmail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_fallback',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: agent.id, workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Deletion Gmail',
      policy: { ...MANAGED_POLICY, accountRef: 'ca_delete_failure' },
      allowedCapabilities: ['gmail.messages.search'],
    });

    await assert.rejects(
      service.prepareAgentDeletion({
        principal: principal(), agentId: agent.id, expectedRevision: agent.revision,
      }),
      /provider cleanup failed/,
    );
    assert.equal((await config.getAgent(agent.id)).id, agent.id);
    assert.equal(
      (await config.getAgentConnectionBindingForAccount(account.id))?.agentId,
      agent.id,
    );
    assert.equal(
      (await config.listConnectionAccounts('T_MANAGED')).find(({ id }) => id === account.id)
        ?.lifecycle,
      'needs_attention',
    );
    await assert.rejects(
      () => config.deleteAgent(agent.id, agent.revision),
      AgentStillReferencedError,
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('Agent deletion validates its revision before revoking any owned connection', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let revokeCalls = 0;
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([{
      id: 'composio',
      async validate() {},
      async execute() { return { data: {} }; },
      async revoke() { revokeCalls += 1; },
    }]),
    randomId: () => 'delete_stale',
  });
  try {
    await config.createAgent({
      id: 'agent_fallback', name: 'Fallback', instructions: 'Stay available.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const inspected = await config.createAgent({
      id: 'agent_delete_stale', name: 'Delete stale', instructions: 'Own Gmail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_fallback',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: inspected.id, workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Deletion Gmail',
      policy: { ...MANAGED_POLICY, accountRef: 'ca_delete_stale' },
      allowedCapabilities: ['gmail.messages.search'],
    });
    const current = await config.updateAgent(
      inspected.id,
      { description: 'Changed after deletion was proposed.' },
      inspected.revision,
    );

    await assert.rejects(
      service.prepareAgentDeletion({
        principal: principal(), agentId: inspected.id, expectedRevision: inspected.revision,
      }),
      AgentRevisionConflictError,
    );
    assert.equal(revokeCalls, 0);
    assert.equal(
      (await config.listConnectionAccounts('T_MANAGED')).find(({ id }) => id === account.id)
        ?.lifecycle,
      'ready',
    );
    assert.equal((await config.getAgent(inspected.id)).revision, current.revision);
  } finally {
    config.close();
    settings.close();
  }
});

test('an Agent editor can delete accounts authorized by another member of that Agent', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let revokeCalls = 0;
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([{
      id: 'composio',
      async validate() {},
      async execute() { return { data: {} }; },
      async revoke() { revokeCalls += 1; },
    }]),
    randomId: () => 'delete_colleague',
  });
  try {
    await config.createAgent({
      id: 'agent_fallback', name: 'Fallback', instructions: 'Stay available.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const agent = await config.createAgent({
      id: 'agent_delete_colleague', name: 'Shared Agent', instructions: 'Own Gmail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'all_workspace_members',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_fallback',
    });
    const { account } = await service.createForAgent({
      principal: principal('membership_bob'), agentId: agent.id, workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Bob Gmail',
      policy: {
        ...MANAGED_POLICY,
        principalRef: 'chickpea:membership:membership_bob',
        accountRef: 'ca_delete_colleague',
      },
      allowedCapabilities: ['gmail.messages.search'],
    });
    const aliceEditor = { ...principal('membership_alice'), role: 'member' as const };

    const revoked = await service.prepareAgentDeletion({
      principal: aliceEditor,
      agentId: agent.id,
      expectedRevision: agent.revision,
    });
    assert.deepEqual(revoked.map(({ id, lifecycle }) => ({ id, lifecycle })), [{
      id: account.id,
      lifecycle: 'revoked',
    }]);
    assert.equal(revokeCalls, 1);
    assert.equal(await config.deleteAgent(agent.id, agent.revision), true);
  } finally {
    config.close();
    settings.close();
  }
});

test('Agent deletion revokes its accounts before removing bindings and the Agent', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let revokeCalls = 0;
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([{
      id: 'composio',
      async validate() {},
      async execute() { return { data: {} }; },
      async revoke() { revokeCalls += 1; },
    }]),
    randomId: (() => { let id = 0; return () => `delete_success_${++id}`; })(),
  });
  try {
    await config.createAgent({
      id: 'agent_fallback', name: 'Fallback', instructions: 'Stay available.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const agent = await config.createAgent({
      id: 'agent_delete_success', name: 'Delete success', instructions: 'Own Gmail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_fallback',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: agent.id, workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Deletion Gmail',
      policy: { ...MANAGED_POLICY, accountRef: 'ca_delete_success' },
      allowedCapabilities: ['gmail.messages.search'],
    });

    const revoked = await service.prepareAgentDeletion({
      principal: principal(),
      agentId: agent.id,
      expectedRevision: agent.revision,
    });
    assert.deepEqual(revoked.map(({ id, lifecycle }) => ({ id, lifecycle })), [{
      id: account.id,
      lifecycle: 'revoked',
    }]);
    assert.equal(revokeCalls, 1);
    assert.equal(await config.deleteAgent(agent.id, agent.revision), true);
    assert.equal(await config.getAgentConnectionBindingForAccount(account.id), undefined);
    await assert.rejects(() => config.getAgent(agent.id), UnknownAgentError);
  } finally {
    config.close();
    settings.close();
  }
});

test('managed revocation reports a retryable conflict before touching the remote grant', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let revokeCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: { ok: true } }; },
    async revoke() { revokeCalls += 1; },
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: () => 'revoke_schedule_conflict',
  });
  try {
    await config.createAgent({
      id: 'agent_revoke_conflict', name: 'Mail', instructions: 'Help with mail.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_revoke_conflict',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_revoke_conflict', workspaceId: 'T_MANAGED',
      ownerKind: 'member', providerId: 'google', label: 'Work Gmail',
      policy: MANAGED_POLICY, allowedCapabilities: ['gmail.messages.search'],
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_revoke_conflict', agentId: 'agent_revoke_conflict',
      workspaceId: 'T_MANAGED', channelId: 'C_MAIL',
      createdByMembershipId: 'membership_alice', runsAsMembershipId: 'membership_alice',
      authorityReceiptId: 'authority_revoke_conflict',
      requiredConnectionAccountIds: [account.id], state: 'active',
    });
    const putSchedule = config.putAgentScheduleReference.bind(config);
    config.putAgentScheduleReference = (input, expectedRevision) => {
      if (input.scheduleId === 'schedule_revoke_conflict' && input.state === 'needs_attention') {
        throw new Error('simulated schedule revision conflict');
      }
      return putSchedule(input, expectedRevision);
    };

    await assert.rejects(
      service.revoke({ principal: principal(), connectionAccountId: account.id }),
      ConnectionScheduleConflictError,
    );
    assert.equal(revokeCalls, 0, 'the provider grant must remain untouched until schedules pause');
    assert.equal(
      (await config.listConnectionAccounts('T_MANAGED')).find(({ id }) => id === account.id)
        ?.lifecycle,
      'needs_attention',
    );
    assert.equal(
      (await config.listAgentScheduleReferences('agent_revoke_conflict'))[0]?.state,
      'active',
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('YouTube quota exhaustion blocks the provider before dispatch', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  let executionCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    quotaBudget: () => ({ limit: 52, timeZone: 'America/Los_Angeles' }),
    async execute() {
      executionCalls += 1;
      return { data: { unexpected: true } };
    },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: providers,
    randomId: () => 'youtube_quota',
  });
  try {
    await config.createAgent({
      id: 'agent_youtube', name: 'YouTube', instructions: 'Manage the selected channel.',
      enabled: true, creatorMembershipId: 'membership_alice',
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_youtube',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_youtube',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Chickpea YouTube',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'youtube',
        principalRef: 'chickpea-user-1', accountRef: 'ca_youtube',
        allowedCapabilities: ['youtube.videos.update'],
        resourceConstraints: {
          channelIds: [{
            handle: 'channel_chickpea', providerRef: 'UCchickpea', label: 'Chickpea',
          }],
        },
      },
      allowedCapabilities: ['youtube.videos.update'],
      resourceConstraints: { channelIds: ['channel_chickpea'] },
    });

    await assert.rejects(invokeManagedConnectionCapability({
      config,
      identity: activeIdentity(),
      providers,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_youtube',
      actorMembershipId: 'membership_alice',
      connectionAccountId: account.id,
      capability: 'youtube.videos.update',
      arguments: {
        channelHandle: 'channel_chickpea', videoId: 'video_1', title: 'Updated title',
      },
      usage,
    }), (error: unknown) =>
      error instanceof ManagedProviderRequestError && error.code === 'throttled');
    assert.equal(executionCalls, 0);
  } finally {
    config.close();
    settings.close();
    usage.close();
  }
});

test('pre-dispatch validation releases only provably unused YouTube quota buckets', async () => {
  const fixedNow = Date.UTC(2026, 7, 23, 12);
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:', () => fixedNow);
  let executionCalls = 0;
  let uploadCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    quotaBudget: ({ bucket }) => ({
      limit: bucket === 'video_insert_calls' ? 2 : 200,
      timeZone: 'America/Los_Angeles',
    }),
    async execute(input) {
      executionCalls += 1;
      if (input.capability === 'youtube.videos.update' && executionCalls === 1) {
        throw new ManagedProviderRequestError(
          'validation_failed',
          'local request validation failed',
          {
            remoteCallCount: 0,
            providerToolCallCount: 0,
            capabilityToolDispatched: false,
          },
        );
      }
      if (input.capability === 'youtube.videos.upload' && uploadCalls++ === 0) {
        throw new ManagedProviderRequestError(
          'provider_unavailable',
          'upload staging provider failed before YouTube dispatch',
          {
            remoteCallCount: 1,
            providerToolCallCount: 1,
            capabilityToolDispatched: false,
          },
        );
      }
      if (input.capability === 'youtube.videos.upload' && uploadCalls === 3) {
        throw new ManagedAuthorizationExpiredError({
          remoteCallCount: 1,
          providerToolCallCount: 1,
          capabilityToolDispatched: false,
        });
      }
      return { data: { recovered: true }, remoteCallCount: 1, providerToolCallCount: 1 };
    },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: providers,
    randomId: () => 'youtube_release',
  });
  try {
    await config.createAgent({
      id: 'agent_youtube_release', name: 'YouTube',
      instructions: 'Manage the selected channel.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct',
      defaultAgentId: 'agent_youtube_release',
    });
    const { account } = await service.createForAgent({
      principal: principal(), agentId: 'agent_youtube_release',
      workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Chickpea YouTube',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'youtube',
        principalRef: 'chickpea-user-1', accountRef: 'ca_youtube_release',
        allowedCapabilities: ['youtube.videos.update', 'youtube.videos.upload'],
        resourceConstraints: {
          channelIds: [{
            handle: 'channel_chickpea', providerRef: 'UCchickpea', label: 'Chickpea',
          }],
        },
      },
      allowedCapabilities: ['youtube.videos.update', 'youtube.videos.upload'],
      resourceConstraints: { channelIds: ['channel_chickpea'] },
    });
    const invoke = () => invokeManagedConnectionCapability({
      config,
      identity: activeIdentity(),
      providers,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_youtube_release',
      actorMembershipId: 'membership_alice',
      connectionAccountId: account.id,
      capability: 'youtube.videos.update',
      arguments: {
        channelHandle: 'channel_chickpea', videoId: 'video_1', title: 'Updated title',
      },
      usage,
      now: () => fixedNow,
    });

    await assert.rejects(invoke(), (error: unknown) =>
      error instanceof ManagedProviderRequestError && error.code === 'validation_failed');
    assert.deepEqual((await invoke()).data, { recovered: true });
    const upload = () => invokeManagedConnectionCapability({
      config,
      identity: activeIdentity(),
      providers,
      workspaceId: 'T_MANAGED',
      agentId: 'agent_youtube_release',
      actorMembershipId: 'membership_alice',
      connectionAccountId: account.id,
      capability: 'youtube.videos.upload',
      arguments: { channelHandle: 'channel_chickpea', title: 'Private test' },
      usage,
      now: () => fixedNow,
    });
    await assert.rejects(upload(), (error: unknown) =>
      error instanceof ManagedProviderRequestError &&
      error.metadata.capabilityToolDispatched === false &&
      error.metadata.remoteCallCount === 1);
    assert.deepEqual((await upload()).data, { recovered: true });
    await assert.rejects(upload(), ManagedAuthorizationExpiredError);
    const replacement = await usage.reserveConnectorQuota({
      reservationId: 'connector:replacement:video_insert_calls',
      workspaceId: 'T_MANAGED',
      adapterId: 'composio',
      toolkit: 'youtube',
      bucket: 'video_insert_calls',
      units: 1,
      limit: 2,
      periodStart: Date.UTC(2026, 7, 23, 7),
      periodEnd: Date.UTC(2026, 7, 24, 7),
    });
    assert.equal(replacement.remaining, 0);
    assert.equal(executionCalls, 5);
  } finally {
    config.close();
    settings.close();
    usage.close();
  }
});

test('managed tool projection withholds ambiguous accounts instead of crashing the turn', () => {
  const context = {
    workspaceId: 'T_MANAGED',
    agentId: 'agent_mail',
    actorMembershipId: 'membership_alice',
    resolvePlatformEnv: async () => undefined,
  };
  const one = createManagedConnectionTools({
    ...context,
    connections: [{
      id: 'connection_one', providerId: 'google',
      adapterId: 'composio', toolkit: 'gmail',
      allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
    }],
  });
  assert.deepEqual(one.map(({ name }) => name), ['gmail_get_profile', 'gmail_search_messages']);

  const ambiguous = createManagedConnectionTools({
    ...context,
    connections: [
      {
        id: 'connection_one', providerId: 'google',
        adapterId: 'composio', toolkit: 'gmail',
        allowedCapabilities: ['gmail.messages.search'],
      },
      {
        id: 'connection_two', providerId: 'google',
        adapterId: 'composio', toolkit: 'gmail',
        allowedCapabilities: ['gmail.messages.search'],
      },
    ],
  });
  assert.deepEqual(ambiguous, []);
});
