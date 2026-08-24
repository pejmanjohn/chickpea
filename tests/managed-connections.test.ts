import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import type { ConnectionAccountManagedPolicy } from '../src/config/types.ts';
import {
  createDefaultManagedConnectionProviderRegistry,
  createManagedConnectionProviderRegistry,
  invokeManagedConnectionCapability,
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
  ConnectionAccountService,
  ManagedConnectionConflictError,
} from '../src/connections/store.ts';

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
    missingConfiguration: ['auth_config_missing', 'webhook_missing'],
  });
  assert.equal(warnings.length, 2);
  const parsed = warnings.map((warning) => JSON.parse(warning) as Record<string, unknown>);
  assert.deepEqual(parsed.find(({ event }) =>
    event === 'chickpea.managed_connection.expiry_webhook_unconfigured'), {
    event: 'chickpea.managed_connection.expiry_webhook_unconfigured',
    adapterId: 'composio',
  });
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
    webhookReady: true,
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

test('Google Ads stays unavailable until the developer token and permissible use are production-capable', () => {
  const testOnly = new ComposioManagedConnectionProvider({
    apiKey: 'test-key', webhookReady: true,
    authConfigIds: { googleads: { read: 'ac_ads', write: 'ac_ads' } },
    googleAdsAccessLevel: 'explorer',
    googleAdsPermissibleUse: 'ad_management',
  });
  assert.deepEqual(testOnly.availability({ toolkit: 'googleads', accessLane: 'read' }), {
    status: 'missing_configuration',
    missingConfiguration: ['provider_prerequisite_missing'],
  });

  const reporting = new ComposioManagedConnectionProvider({
    apiKey: 'test-key', webhookReady: true,
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
    const account = await service.create({
      principal: principal(),
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: MANAGED_POLICY,
    });
    assert.equal(account.lifecycle, 'ready');
    await assert.rejects(
      service.attach({
        principal: principal(), agentId: 'agent_mail', connectionAccountId: account.id,
        allowedCapabilities: ['gmail.messages.send'],
      }),
      /exceeds the account capability ceiling/,
    );
    await service.attach({
      principal: principal(), agentId: 'agent_mail', connectionAccountId: account.id,
      allowedCapabilities: ['gmail.messages.search'],
    });

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
      const account = await service.create({
        principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
        providerId: 'google', label: fixture.toolkit,
        policy: {
          kind: 'managed', adapterId: 'composio', toolkit: fixture.toolkit,
          principalRef: 'chickpea-user-1', accountRef: fixture.accountRef,
          allowedCapabilities: [...fixture.capabilities],
        },
      });
      await service.attach({
        principal: principal(), agentId: 'agent_productivity',
        connectionAccountId: account.id,
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'notion', label: 'Managed Notion',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'notion',
        principalRef: 'chickpea-user-1', accountRef: 'ca_notion_alice',
        allowedCapabilities: ['notion.pages.get', 'notion.pages.create'],
      },
    });
    await service.attach({
      principal: principal(), agentId: 'agent_notion', connectionAccountId: account.id,
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

test('managed attachment rejects a second owner lane for the same Agent and toolkit', async () => {
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
    const create = (accountRef: string) => service.create({
      principal: principal(),
      workspaceId: 'T_MANAGED',
      ownerKind: 'member' as const,
      providerId: 'google',
      label: 'Gmail · Personal',
      policy: { ...MANAGED_POLICY, accountRef },
    });
    const first = await create('ca_lane_one');
    const second = await create('ca_lane_two');
    await service.attach({
      principal: principal(), agentId: 'agent_mail', connectionAccountId: first.id,
    });
    await assert.rejects(
      service.attach({
        principal: principal(), agentId: 'agent_mail', connectionAccountId: second.id,
      }),
      ManagedConnectionConflictError,
    );
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
    const create = (membershipId: string, accountRef: string) => service.create({
      principal: principal(membershipId),
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
    const alice = await create('membership_alice', 'ca_alice');
    const bob = await create('membership_bob', 'ca_bob');
    await service.attach({
      principal: principal('membership_alice'),
      agentId: 'agent_mail',
      connectionAccountId: alice.id,
    });
    await service.attach({
      principal: principal('membership_bob'),
      agentId: 'agent_mail',
      connectionAccountId: bob.id,
    });
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
    const original = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Original Gmail', policy: MANAGED_POLICY,
    });

    await assert.rejects(
      service.create({
        principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
        providerId: 'google', label: 'Duplicate Gmail',
        policy: { ...MANAGED_POLICY, adapterId: 'COMPOSIO' },
      }),
      new RegExp(`already imported; reuse connection account ${original.id}`),
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
    await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
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
    const original = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: MANAGED_POLICY,
    });
    const expired = await config.putConnectionAccount(
      { ...original, lifecycle: 'needs_attention' },
      original.revision,
    );
    const reconnected = await service.replaceManagedAuthorization({
      principal: principal(),
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
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

test('managed Agent bindings keep their original ceiling when a shared account is widened', async () => {
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Personal Gmail',
      policy: { ...MANAGED_POLICY, allowedCapabilities: readCapabilities },
    });

    const binding = await service.attach({
      principal: principal(), agentId: 'agent_reader', connectionAccountId: account.id,
      allowedCapabilities: [],
    });
    assert.deepEqual(binding.allowedCapabilities, readCapabilities);

    await service.replaceManagedAuthorization({
      principal: principal(),
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

test('reusing a scoped managed account seeds the new Agent with its safe resource ceiling', async () => {
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
    randomId: () => 'scoped_reuse',
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
    const account = await service.create({
      principal: principal(),
      workspaceId: 'T_MANAGED',
      ownerKind: 'team',
      providerId: 'google',
      label: 'Growth Analytics',
      policy: {
        kind: 'managed',
        adapterId: 'composio',
        toolkit: 'google_analytics',
        principalRef: 'chickpea:organization:T_MANAGED',
        accountRef: 'ca_analytics',
        allowedCapabilities: ['analytics.reports.run'],
        resourceConstraints: { propertyIds: [selectedProperty] },
      },
    });
    await service.attach({
      principal: principal(),
      agentId: 'agent_analytics_a',
      connectionAccountId: account.id,
      resourceConstraints: { propertyIds: [selectedProperty.handle] },
    });
    const reusedBinding = await service.attach({
      principal: principal(),
      agentId: 'agent_analytics_b',
      connectionAccountId: account.id,
    });

    assert.deepEqual(reusedBinding.resourceConstraints, {
      propertyIds: [selectedProperty.handle],
    });
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
    assert.doesNotMatch(serializedViews, /ca_analytics|properties\/123|chickpea:organization/);
    assert.match(serializedViews, /property_primary/);
    assert.match(serializedViews, /Website — Acme/);
  } finally {
    config.close();
    settings.close();
  }
});

test('reattaching a managed account restores the Agent frozen ceiling after account widening', async () => {
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
    randomId: () => 'reattach_ceiling',
  });
  const propertyA = { handle: 'property_a', providerRef: 'properties/100', label: 'Property A' };
  const propertyB = { handle: 'property_b', providerRef: 'properties/200', label: 'Property B' };
  try {
    await config.createAgent({
      id: 'agent_analytics', name: 'Analytics', instructions: 'Read analytics.', enabled: true,
      creatorMembershipId: 'membership_alice', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGED', transportMode: 'direct', defaultAgentId: 'agent_analytics',
    });
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'team',
      providerId: 'google', label: 'Analytics',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'google_analytics',
        principalRef: 'chickpea:organization:T_MANAGED', accountRef: 'ca_analytics',
        allowedCapabilities: ['analytics.reports.run'],
        resourceConstraints: { propertyIds: [propertyA] },
      },
    });
    await service.attach({
      principal: principal(), agentId: 'agent_analytics', connectionAccountId: account.id,
      allowedCapabilities: ['analytics.reports.run'],
      resourceConstraints: { propertyIds: [propertyA.handle] },
    });
    await service.detach({
      principal: principal(), agentId: 'agent_analytics', connectionAccountId: account.id,
    });
    if (account.policy.kind !== 'managed') assert.fail('expected a managed account');
    await config.putConnectionAccount({
      ...account,
      policy: {
        ...account.policy,
        allowedCapabilities: ['analytics.reports.run', 'analytics.metadata.get'],
        resourceConstraints: { propertyIds: [propertyA, propertyB] },
      },
    }, account.revision);

    const restored = await service.attach({
      principal: principal(), agentId: 'agent_analytics', connectionAccountId: account.id,
    });
    assert.deepEqual(restored.allowedCapabilities, ['analytics.reports.run']);
    assert.deepEqual(restored.resourceConstraints, { propertyIds: [propertyA.handle] });
    const [effective] = await resolveEffectiveConnectionAccounts({
      config, workspaceId: 'T_MANAGED', agentId: 'agent_analytics',
      actorMembershipId: 'membership_alice',
    });
    assert.equal(effective?.policy.kind, 'managed');
    if (effective?.policy.kind !== 'managed') assert.fail('expected a managed policy');
    assert.deepEqual(effective.policy.allowedCapabilities, ['analytics.reports.run']);
    assert.deepEqual(effective.policy.resourceConstraints, { propertyIds: [propertyA] });
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: MANAGED_POLICY,
    });
    await service.attach({
      principal: principal(), agentId: 'agent_mail', connectionAccountId: account.id,
      allowedCapabilities: ['gmail.messages.search'],
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: MANAGED_POLICY,
    });
    assert.equal(account.revision, 1, 'managed import must be one atomic account write');
    await service.attach({
      principal: principal(), agentId: 'agent_mail', connectionAccountId: account.id,
      allowedCapabilities: ['gmail.messages.search'],
    });
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: MANAGED_POLICY,
    });
    await service.attach({
      principal: principal(), agentId: 'agent_mail', connectionAccountId: account.id,
      allowedCapabilities: ['gmail.messages.search'],
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
      service.create({
        principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
      providerId: 'google', label: 'Work Gmail', policy: MANAGED_POLICY,
    });
    await service.attach({
      principal: principal(), agentId: 'agent_mail', connectionAccountId: account.id,
      allowedCapabilities: ['gmail.messages.search'],
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
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
    });
    await service.attach({
      principal: principal(), agentId: 'agent_youtube', connectionAccountId: account.id,
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
    const account = await service.create({
      principal: principal(), workspaceId: 'T_MANAGED', ownerKind: 'member',
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
    });
    await service.attach({
      principal: principal(), agentId: 'agent_youtube_release',
      connectionAccountId: account.id,
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
