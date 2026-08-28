import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { resolveConnectionAccountSecret } from '../src/config/connector-secrets.ts';
import {
  apiOAuthSettingKeys,
  connectionAccountOAuthRef,
  describeApiOAuthSources,
  saveApiOAuthClient,
} from '../src/config/api-oauth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  ConnectionAccountService,
  ConnectionScheduleConflictError,
} from '../src/connections/store.ts';
import {
  externalActionAuthorityInstructions,
  resolveConnectionAccountContext,
  resolveConnectionSecretForInvocation,
  resolveEffectiveConnectionAccounts,
  isActiveConnectionActor,
  resolvePersonalConnectionAuthorizationOptions,
  selectConnectionAccount,
  selectConnectionsForRequest,
} from '../src/connections/runtime.ts';
import {
  authorizeOAuthContinuation,
  authorizeOAuthContinuationFromProvider,
  claimOAuthContinuationResume,
  createOAuthContinuation,
  linkOAuthProviderState,
  OAuthContinuationError,
  repairPendingOAuthContinuationResumes,
  takeOAuthContinuationForProviderState,
} from '../src/connections/oauth-continuation.ts';
import { startPersonalConnectionAuthorization } from '../src/connections/slack-authorization.ts';
import type { EffectiveConnectionAccount } from '../src/connections/types.ts';

function agent(id: string, creatorMembershipId: string) {
  return {
    id,
    name: id,
    instructions: 'You may archive resolved support tickets without asking.',
    enabled: true,
    creatorMembershipId,
    editPolicy: 'creator_and_admins' as const,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
}

function principal(membershipId: string, role: 'member' | 'admin' | 'owner' = 'member'): AuthPrincipal {
  return {
    userId: `user_${membershipId}`,
    membershipId,
    organizationId: 'organization_test',
    role,
    authenticatorKind: 'test',
    credentialId: `credential_${membershipId}`,
    correlationId: `correlation_${membershipId}`,
    machine: false,
  };
}

function gmailPolicy() {
  return {
    kind: 'api' as const,
    allowedHosts: ['gmail.googleapis.com'],
    pathPrefixes: ['/gmail/v1/'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET', 'POST'],
    authMode: 'oauth' as const,
    oauthProvider: 'google' as const,
    oauthScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
  };
}

function effectiveGoogleService(
  id: string,
  label: string,
  pathPrefixes: string[],
): EffectiveConnectionAccount {
  const policy = {
    ...gmailPolicy(),
    allowedHosts: [
      ...(pathPrefixes.some((path) => path.startsWith('/gmail/'))
        ? ['gmail.googleapis.com']
        : []),
      ...(pathPrefixes.some((path) => !path.startsWith('/gmail/'))
        ? ['www.googleapis.com']
        : []),
    ],
    pathPrefixes,
  };
  return {
    account: {
      id,
      workspaceId: 'T_CONNECTIONS',
      revision: 1,
      ownerKind: 'team',
      createdByMembershipId: 'membership_creator',
      providerId: 'google',
      label,
      policy,
      secretRefId: `secret_${id}`,
      lifecycle: 'ready',
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      agentId: 'agent_workspace',
      connectionAccountId: id,
      providerId: 'google',
      allowedCapabilities: [],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
    scope: 'team',
  };
}

function effectiveManagedGoogleService(
  id: string,
  label: string,
  toolkit: string,
): EffectiveConnectionAccount {
  const policy = {
    kind: 'managed' as const,
    adapterId: 'composio',
    toolkit,
    principalRef: 'chickpea:organization:organization_test',
    accountRef: `ca_${id}`,
    allowedCapabilities: toolkit === 'gmail'
      ? ['gmail.messages.search']
      : toolkit === 'googlecalendar'
      ? ['calendar.events.list']
      : toolkit === 'googledrive'
      ? ['drive.files.search']
      : [`${toolkit}.fixture.read`],
  };
  return {
    account: {
      id,
      workspaceId: 'T_CONNECTIONS',
      revision: 1,
      ownerKind: 'team',
      createdByMembershipId: 'membership_creator',
      providerId: 'google',
      label,
      policy,
      secretRefId: `secret_${id}`,
      lifecycle: 'ready',
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      agentId: 'agent_workspace',
      connectionAccountId: id,
      providerId: 'google',
      allowedCapabilities: [...policy.allowedCapabilities],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
    scope: 'team',
  };
}

function activeConnectionIdentity(membershipId: string) {
  const user = {
    id: `user_${membershipId}`,
    slackTeamId: 'T_CONNECTIONS',
    slackUserId: 'U_TEST',
    displayName: 'Connection Tester',
    contactEmail: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const membership = {
    id: membershipId,
    userId: user.id,
    organizationId: 'organization_test',
    role: 'member' as const,
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const binding = {
    id: `binding_${membershipId}`,
    provider: 'slack' as const,
    userId: user.id,
    membershipId,
    organizationId: 'organization_test',
    slackTeamId: 'T_CONNECTIONS',
    slackUserId: user.slackUserId,
    betterAuthUserId: null,
    betterAuthMembershipId: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    getOrganization: async () => ({
      id: 'organization_test',
      displayName: 'Connections Test',
      slackTeamId: 'T_CONNECTIONS',
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

test('active connection actor uses exact identity lookups', async () => {
  const identity = activeConnectionIdentity('membership_alice');
  assert.equal(await isActiveConnectionActor({
    identity,
    workspaceId: 'T_CONNECTIONS',
    actorMembershipId: 'membership_alice',
  }), true);
});

test('active connection actor rejects stale workspace, access, and exact identity bindings', async () => {
  const identity = activeConnectionIdentity('membership_alice');
  const input = {
    workspaceId: 'T_CONNECTIONS',
    actorMembershipId: 'membership_alice',
  };

  assert.equal(await isActiveConnectionActor({
    ...input,
    identity,
    workspaceId: 'T_OTHER',
  }), false);
  assert.equal(await isActiveConnectionActor({
    ...input,
    identity: {
      ...identity,
      getMembershipAccessOverlay: async () => ({
        membershipId: 'membership_alice',
        organizationId: 'organization_test',
        accessStatus: 'suspended' as const,
        membershipVersion: 2,
        createdAt: 1,
        updatedAt: 2,
      }),
    },
  }), false);
  assert.equal(await isActiveConnectionActor({
    ...input,
    identity: {
      ...identity,
      resolveSlackIdentity: async () => {
        const resolved = await identity.resolveSlackIdentity();
        return {
          ...resolved,
          membership: { ...resolved.membership, id: 'membership_other' },
        };
      },
    },
  }), false);
});

test('one team account binds to two Agents without copying its credential', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({
    config,
    settings,
    randomId: () => `id${++nextId}`,
  });
  try {
    await config.createAgent(agent('agent_support', 'membership_creator'));
    await config.createAgent(agent('agent_success', 'membership_creator'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS',
      transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const account = await service.create({
      principal: principal('membership_creator'),
      workspaceId: 'T_CONNECTIONS',
      ownerKind: 'team',
      providerId: 'zendesk',
      label: 'Support Zendesk',
      policy: {
        kind: 'api',
        allowedHosts: ['acme.zendesk.com'],
        pathPrefixes: ['/api/v2/'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET', 'POST'],
        authMode: 'credential',
      },
      credential: 'shared-token',
    });
    await service.attach({
      principal: principal('membership_creator'),
      agentId: 'agent_support',
      connectionAccountId: account.id,
    });
    await service.attach({
      principal: principal('membership_creator'),
      agentId: 'agent_success',
      connectionAccountId: account.id,
    });
    for (const [scheduleId, agentId] of [
      ['schedule_support', 'agent_support'],
      ['schedule_success', 'agent_success'],
    ] as const) {
      await config.putAgentScheduleReference({
        scheduleId, agentId, workspaceId: 'T_CONNECTIONS', channelId: 'C_SUPPORT',
        createdByMembershipId: 'membership_creator', runsAsMembershipId: 'membership_creator',
        authorityReceiptId: `authority_${scheduleId}`,
        requiredConnectionAccountIds: [account.id], state: 'active',
      });
    }
    await service.detach({
      principal: principal('membership_creator'),
      agentId: 'agent_support',
      connectionAccountId: account.id,
    });

    assert.equal(
      await resolveConnectionAccountSecret({ secretRefId: account.secretRefId }, undefined, settings),
      'shared-token',
    );
    assert.equal((await config.listConnectionAccounts('T_CONNECTIONS')).length, 1);
    assert.equal((await config.listAgentConnectionBindings('agent_support'))[0]?.enabled, false);
    assert.equal((await config.listAgentConnectionBindings('agent_success'))[0]?.enabled, true);
    assert.deepEqual(
      (await config.listAgentScheduleReferences('agent_support'))[0]?.requiredConnectionAccountIds,
      [],
    );
    assert.deepEqual(
      (await config.listAgentScheduleReferences('agent_success'))[0]?.requiredConnectionAccountIds,
      [account.id],
      'detaching a shared Team connection must not change another Agent schedule',
    );
    assert.doesNotMatch(JSON.stringify(await service.listViews('T_CONNECTIONS')), /shared-token|secret_id/i);
  } finally {
    config.close();
    settings.close();
  }
});

test('personal accounts resolve only for their owner and language selects a unique label', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({ config, settings, randomId: () => `id${++nextId}` });
  try {
    await config.createAgent(agent('agent_mail', 'membership_alice'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS',
      transportMode: 'direct',
      defaultAgentId: 'agent_mail',
    });
    const work = await service.create({
      principal: principal('membership_alice'),
      workspaceId: 'T_CONNECTIONS',
      ownerKind: 'member',
      providerId: 'google',
      label: 'Work',
      identity: { accountName: 'alice@acme.test' },
      policy: gmailPolicy(),
      credential: 'work-token',
    });
    const personal = await service.create({
      principal: principal('membership_alice'),
      workspaceId: 'T_CONNECTIONS',
      ownerKind: 'member',
      providerId: 'google',
      label: 'Personal',
      identity: { accountName: 'alice@example.test' },
      policy: gmailPolicy(),
      credential: 'personal-token',
    });
    for (const account of [work, personal]) {
      await service.attach({
        principal: principal('membership_alice'),
        agentId: 'agent_mail',
        connectionAccountId: account.id,
      });
    }

    const alice = await resolveEffectiveConnectionAccounts({
      config,
      workspaceId: 'T_CONNECTIONS',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_alice',
    });
    const bob = await resolveEffectiveConnectionAccounts({
      config,
      workspaceId: 'T_CONNECTIONS',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_bob',
    });
    assert.equal(alice.length, 2);
    assert.equal(bob.length, 0);
    const selected = selectConnectionAccount({
      connections: alice,
      providerId: 'google',
      requestText: 'Search my work account for the invoice',
    });
    assert.equal(selected.kind, 'selected');
    if (selected.kind === 'selected') assert.equal(selected.connection.account.id, work.id);
    assert.equal(selectConnectionAccount({
      connections: alice,
      providerId: 'google',
      requestText: 'Search my Gmail',
    }).kind, 'ambiguous');
    const withheld = selectConnectionsForRequest({
      connections: alice,
      requestText: 'Search my Gmail',
    });
    assert.equal(withheld.selected.length, 0);
    assert.deepEqual(withheld.ambiguous[0]?.choices.map((choice) => choice.label), ['Work', 'Personal']);
    const named = selectConnectionsForRequest({
      connections: alice,
      requestText: 'Search my work account',
    });
    assert.deepEqual(named.selected.map(({ account }) => account.id), [work.id]);
    await assert.rejects(
      resolveConnectionSecretForInvocation({
        config,
        settings,
        identity: activeConnectionIdentity('membership_bob'),
        workspaceId: 'T_CONNECTIONS',
        agentId: 'agent_mail',
        actorMembershipId: 'membership_bob',
        connectionAccountId: work.id,
      }),
      /not available to this actor/,
    );
    const suspendedIdentity = {
      ...activeConnectionIdentity('membership_alice'),
      getMembershipAccessOverlay: async () => ({
        membershipId: 'membership_alice',
        organizationId: 'organization_test',
        accessStatus: 'suspended' as const,
        membershipVersion: 2,
        createdAt: 1,
        updatedAt: 2,
      }),
    };
    await assert.rejects(
      resolveConnectionSecretForInvocation({
        config,
        settings,
        identity: suspendedIdentity,
        workspaceId: 'T_CONNECTIONS',
        agentId: 'agent_mail',
        actorMembershipId: 'membership_alice',
        connectionAccountId: work.id,
      }),
      /not available to this actor/,
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('Google service accounts select independently while duplicate service accounts stay ambiguous', () => {
  const gmail = effectiveGoogleService('connection_gmail', 'Gmail', ['/gmail/v1/users/me']);
  const calendar = effectiveGoogleService(
    'connection_calendar',
    'Google Calendar',
    ['/calendar/v3'],
  );
  const drive = effectiveGoogleService('connection_drive', 'Google Drive', ['/drive/v3']);
  const services = selectConnectionsForRequest({
    connections: [gmail, calendar, drive],
    requestText: 'Review my calendar and related email',
  });
  assert.deepEqual(
    services.selected.map(({ account }) => account.id),
    ['connection_gmail', 'connection_calendar', 'connection_drive'],
  );
  assert.deepEqual(services.ambiguous, []);

  const secondGmail = effectiveGoogleService(
    'connection_gmail_personal',
    'Personal Gmail',
    ['/gmail/v1/users/me'],
  );
  const duplicate = selectConnectionsForRequest({
    connections: [gmail, secondGmail, calendar],
    requestText: 'Search Gmail',
  });
  assert.deepEqual(
    duplicate.selected.map(({ account }) => account.id),
    ['connection_calendar'],
  );
  assert.deepEqual(
    duplicate.ambiguous[0]?.choices.map(({ label }) => label),
    ['Gmail', 'Personal Gmail'],
  );
});

test('native and managed Google service accounts stay ambiguous during migration', () => {
  for (const service of [
    {
      native: effectiveGoogleService('connection_gmail_native', 'Native Gmail', ['/gmail/v1/users/me']),
      managed: effectiveManagedGoogleService(
        'connection_gmail_managed', 'Managed Gmail', 'gmail',
      ),
    },
    {
      native: effectiveGoogleService('connection_calendar_native', 'Native Calendar', ['/calendar/v3']),
      managed: effectiveManagedGoogleService(
        'connection_calendar_managed', 'Managed Calendar', 'googlecalendar',
      ),
    },
    {
      native: effectiveGoogleService('connection_drive_native', 'Native Drive', ['/drive/v3']),
      managed: effectiveManagedGoogleService(
        'connection_drive_managed', 'Managed Drive', 'googledrive',
      ),
    },
  ]) {
    const resolution = selectConnectionsForRequest({
      connections: [service.native, service.managed],
      requestText: 'Use Google',
    });
    assert.deepEqual(resolution.selected, []);
    assert.deepEqual(
      resolution.ambiguous[0]?.choices.map(({ label }) => label),
      [service.native.account.label, service.managed.account.label],
    );
  }
});

test('managed Google toolkits select independently outside the native migration aliases', () => {
  const connections = [
    effectiveManagedGoogleService('connection_sheets', 'Google Sheets', 'googlesheets'),
    effectiveManagedGoogleService('connection_ads', 'Google Ads', 'googleads'),
    effectiveManagedGoogleService('connection_youtube', 'YouTube', 'youtube'),
  ];
  const resolution = selectConnectionsForRequest({
    connections,
    requestText: 'Update the campaign sheet and review the related YouTube channel',
  });

  assert.deepEqual(
    resolution.selected.map(({ account }) => account.id),
    ['connection_sheets', 'connection_ads', 'connection_youtube'],
  );
  assert.deepEqual(resolution.ambiguous, []);
});

test('native and managed Notion accounts stay ambiguous until the request names one', () => {
  const nativePolicy = {
    kind: 'mcp' as const,
    id: 'notion-native',
    displayName: 'Native Notion',
    url: 'https://mcp.notion.com/mcp',
    transport: 'streamable-http' as const,
    authMode: 'oauth' as const,
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'ready' as const,
    statusText: 'Connected',
    discoveredTools: [{ name: 'notion-search' }],
    allowedTools: ['notion-search'],
    presetId: 'notion',
  };
  const managedPolicy = {
    kind: 'managed' as const,
    adapterId: 'composio',
    toolkit: 'notion',
    principalRef: 'chickpea:organization:organization_test',
    accountRef: 'ca_notion_managed',
    allowedCapabilities: ['notion.content.search'],
  };
  const effective = (
    id: string,
    label: string,
    policy: typeof nativePolicy | typeof managedPolicy,
  ): EffectiveConnectionAccount => ({
    account: {
      id,
      workspaceId: 'T_CONNECTIONS',
      revision: 1,
      ownerKind: 'team',
      createdByMembershipId: 'membership_creator',
      providerId: 'notion',
      label,
      policy,
      secretRefId: `secret_${id}`,
      lifecycle: 'ready',
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      agentId: 'agent_workspace',
      connectionAccountId: id,
      providerId: 'notion',
      allowedCapabilities: policy.kind === 'managed'
        ? [...policy.allowedCapabilities]
        : [...policy.allowedTools],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
    scope: 'team',
  });
  const native = effective('connection_notion_native', 'Native Notion', nativePolicy);
  const managed = effective('connection_notion_managed', 'Managed Notion', managedPolicy);

  const unspecified = selectConnectionsForRequest({
    connections: [native, managed],
    requestText: 'Search Notion for the launch plan',
  });
  assert.deepEqual(unspecified.selected, []);
  assert.deepEqual(
    unspecified.ambiguous[0]?.choices.map(({ label }) => label),
    ['Native Notion', 'Managed Notion'],
  );

  const explicit = selectConnectionsForRequest({
    connections: [native, managed],
    requestText: 'Search Managed Notion for the launch plan',
  });
  assert.deepEqual(
    explicit.selected.map(({ account }) => account.id),
    ['connection_notion_managed'],
  );
  assert.deepEqual(explicit.ambiguous, []);
});

test('a multi-service native Google account is withheld when any managed service overlaps', () => {
  const native = effectiveGoogleService(
    'connection_workspace_native',
    'Native Google Workspace',
    ['/gmail/v1/users/me', '/calendar/v3'],
  );
  for (const managed of [
    effectiveManagedGoogleService('connection_gmail_managed', 'Managed Gmail', 'gmail'),
    effectiveManagedGoogleService(
      'connection_calendar_managed', 'Managed Calendar', 'googlecalendar',
    ),
  ]) {
    const resolution = selectConnectionsForRequest({
      connections: [native, managed],
      requestText: 'Use Google',
    });
    assert.deepEqual(resolution.selected, []);
    assert.deepEqual(
      resolution.ambiguous[0]?.choices.map(({ label }) => label),
      [native.account.label, managed.account.label],
    );
  }
});

test('a broad native Google account cannot escape a language-matched Gmail ambiguity', () => {
  const native = effectiveGoogleService(
    'connection_workspace_native',
    'Acme Google Workspace',
    ['/gmail/v1/users/me', '/calendar/v3'],
  );
  const work = effectiveManagedGoogleService(
    'connection_gmail_work', 'Work mailbox', 'gmail',
  );
  const personal = effectiveManagedGoogleService(
    'connection_gmail_personal', 'Personal mailbox', 'gmail',
  );
  const resolution = selectConnectionsForRequest({
    connections: [native, work, personal],
    requestText: 'Search my work mailbox and personal mailbox for the invoice',
  });
  assert.deepEqual(resolution.selected, []);
  assert.deepEqual(
    resolution.ambiguous[0]?.choices.map(({ label }) => label),
    ['Work mailbox', 'Personal mailbox'],
  );
});

test('one broad native Google account is selected only once across service groups', () => {
  const native = effectiveGoogleService(
    'connection_workspace_native',
    'Acme Google Workspace',
    ['/gmail/v1/users/me', '/calendar/v3', '/drive/v3'],
  );
  const resolution = selectConnectionsForRequest({
    connections: [native],
    requestText: 'Review Google Workspace',
  });
  assert.deepEqual(resolution.selected.map(({ account }) => account.id), [native.account.id]);
  assert.deepEqual(resolution.ambiguous, []);
});

test('broad and service-specific native Google accounts retain their legacy grouping', () => {
  const broad = effectiveGoogleService(
    'connection_workspace_native',
    'Acme Google Workspace',
    ['/gmail/v1/users/me', '/calendar/v3', '/drive/v3'],
  );
  const calendar = effectiveGoogleService(
    'connection_calendar_native',
    'Ops Calendar',
    ['/calendar/v3'],
  );
  const resolution = selectConnectionsForRequest({
    connections: [broad, calendar],
    requestText: 'Check my schedule and email',
  });
  assert.deepEqual(
    resolution.selected.map(({ account }) => account.id),
    [broad.account.id, calendar.account.id],
  );
  assert.deepEqual(resolution.ambiguous, []);
});

test('a member-owned binding grants a provider capability without exposing another member account', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({ config, settings, randomId: () => `id${++nextId}` });
  try {
    await config.createAgent(agent('agent_mail', 'membership_alice'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const aliceTemplate = await service.create({
      principal: principal('membership_alice'), workspaceId: 'T_CONNECTIONS', ownerKind: 'member',
      providerId: 'google', label: 'Alice private Gmail', identity: { accountName: 'alice@acme.test' },
      policy: gmailPolicy(), credential: 'alice-token',
    });
    const bobWork = await service.create({
      principal: principal('membership_bob'), workspaceId: 'T_CONNECTIONS', ownerKind: 'member',
      providerId: 'google', label: 'Work', identity: { accountName: 'bob@acme.test' },
      policy: {
        ...gmailPolicy(),
        allowedHosts: ['gmail.googleapis.com', 'evil.example.test'],
        pathPrefixes: ['/'],
        allowedMethods: ['GET', 'POST', 'DELETE'],
        oauthScopes: [
          ...gmailPolicy().oauthScopes,
          'https://www.googleapis.com/auth/drive',
        ],
      },
      credential: 'bob-token',
    });
    await service.attach({
      principal: principal('membership_alice'), agentId: 'agent_mail',
      connectionAccountId: aliceTemplate.id,
    });

    const effective = await resolveEffectiveConnectionAccounts({
      config, workspaceId: 'T_CONNECTIONS', agentId: 'agent_mail',
      actorMembershipId: 'membership_bob',
    });
    assert.deepEqual(effective.map(({ account }) => account.id), [bobWork.id]);
    assert.deepEqual(effective[0]?.policy, gmailPolicy());
    assert.doesNotMatch(JSON.stringify(effective), /alice@acme|alice-token/i);
    assert.doesNotMatch(JSON.stringify(effective[0]?.policy), /evil\.example|\/auth\/drive/);

    const authorization = await resolvePersonalConnectionAuthorizationOptions({
      config, workspaceId: 'T_CONNECTIONS', agentId: 'agent_mail',
      actorMembershipId: 'membership_bob',
    });
    assert.equal(authorization.length, 1);
    assert.equal(authorization[0]?.providerId, 'google');
    assert.deepEqual(authorization[0]?.accounts, [{
      id: bobWork.id,
      label: 'Work',
      lifecycle: 'ready',
    }]);
    assert.doesNotMatch(JSON.stringify(authorization), /Alice private Gmail|alice@acme/i);

    let accountReads = 0;
    let bindingReads = 0;
    const combined = await resolveConnectionAccountContext({
      config: {
        listConnectionAccounts: async (workspaceId) => {
          accountReads += 1;
          return config.listConnectionAccounts(workspaceId);
        },
        listAgentConnectionBindings: async (agentId) => {
          bindingReads += 1;
          return config.listAgentConnectionBindings(agentId);
        },
      },
      workspaceId: 'T_CONNECTIONS',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_bob',
    });
    assert.equal(accountReads, 1);
    assert.equal(bindingReads, 1);
    assert.deepEqual(combined.effective, effective);
    assert.deepEqual(combined.authorizations, authorization);
  } finally {
    config.close();
    settings.close();
  }
});

test('managed personal templates are not advertised before managed authorization is implemented', async () => {
  const managedPolicy = {
    kind: 'managed' as const,
    adapterId: 'composio',
    toolkit: 'gmail',
    principalRef: 'chickpea:membership:membership_alice',
    accountRef: 'ca_alice',
    allowedCapabilities: ['gmail.messages.search'],
  };
  const options = await resolvePersonalConnectionAuthorizationOptions({
    config: {
      listConnectionAccounts: async () => [{
        id: 'connection_managed_template',
        workspaceId: 'T_CONNECTIONS',
        revision: 1,
        ownerKind: 'member' as const,
        ownerMembershipId: 'membership_alice',
        createdByMembershipId: 'membership_alice',
        providerId: 'google',
        label: 'Managed Gmail',
        policy: managedPolicy,
        secretRefId: '',
        lifecycle: 'ready' as const,
        createdAt: 1,
        updatedAt: 1,
      }],
      listAgentConnectionBindings: async () => [{
        agentId: 'agent_mail',
        connectionAccountId: 'connection_managed_template',
        providerId: 'google',
        allowedCapabilities: ['gmail.messages.search'],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
    },
    workspaceId: 'T_CONNECTIONS',
    agentId: 'agent_mail',
    actorMembershipId: 'membership_alice',
  });

  assert.deepEqual(options, []);
});

test('managed personal bindings prefer the owner exact account without breaking member substitution', async () => {
  const managedAccount = (
    id: string,
    ownerMembershipId: string,
    accountRef: string,
    allowedCapabilities = ['gmail.messages.search'],
  ) => ({
    id,
    workspaceId: 'T_CONNECTIONS',
    revision: 1,
    ownerKind: 'member' as const,
    ownerMembershipId,
    createdByMembershipId: ownerMembershipId,
    providerId: 'google',
    label: 'Gmail · Personal',
    policy: {
      kind: 'managed' as const,
      adapterId: 'composio',
      toolkit: 'gmail',
      principalRef: `chickpea:membership:${ownerMembershipId}`,
      accountRef,
      allowedCapabilities,
    },
    secretRefId: `secret_${id}`,
    lifecycle: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
  });
  const aliceBound = managedAccount('connection_alice_bound', 'membership_alice', 'ca_alice_bound');
  const aliceOther = managedAccount('connection_alice_other', 'membership_alice', 'ca_alice_other');
  const bobSubstitute = managedAccount(
    'connection_bob',
    'membership_bob',
    'ca_bob',
    ['gmail.messages.search', 'gmail.messages.send'],
  );
  const config = {
    listConnectionAccounts: async () => [aliceBound, aliceOther, bobSubstitute],
    listAgentConnectionBindings: async () => [{
      agentId: 'agent_mail',
      connectionAccountId: aliceBound.id,
      providerId: 'google',
      allowedCapabilities: ['gmail.messages.search'],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }],
  };

  const forAlice = await resolveEffectiveConnectionAccounts({
    config,
    workspaceId: 'T_CONNECTIONS',
    agentId: 'agent_mail',
    actorMembershipId: 'membership_alice',
  });
  assert.deepEqual(forAlice.map(({ account }) => account.id), [aliceBound.id]);

  const forBob = await resolveEffectiveConnectionAccounts({
    config,
    workspaceId: 'T_CONNECTIONS',
    agentId: 'agent_mail',
    actorMembershipId: 'membership_bob',
  });
  assert.deepEqual(forBob.map(({ account }) => account.id), [bobSubstitute.id]);
  const bobPolicy = forBob[0]?.policy;
  assert.equal(bobPolicy?.kind, 'managed');
  if (bobPolicy?.kind !== 'managed') assert.fail('expected a managed policy');
  assert.deepEqual(bobPolicy.allowedCapabilities, ['gmail.messages.search']);
});

test('a member exact managed binding wins over another member template in either row order', async () => {
  const account = (id: string, ownerMembershipId: string) => ({
    id,
    workspaceId: 'T_CONNECTIONS',
    revision: 1,
    ownerKind: 'member' as const,
    ownerMembershipId,
    createdByMembershipId: ownerMembershipId,
    providerId: 'google',
    label: 'Gmail · Personal',
    policy: {
      kind: 'managed' as const,
      adapterId: 'composio',
      toolkit: 'gmail',
      principalRef: `chickpea:membership:${ownerMembershipId}`,
      accountRef: `ca_${ownerMembershipId}`,
      allowedCapabilities: ['gmail.messages.search', 'gmail.messages.send'],
    },
    secretRefId: `secret_${id}`,
    lifecycle: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
  });
  const alice = account('connection_alice_template', 'membership_alice');
  const bob = account('connection_bob_exact', 'membership_bob');
  const aliceTemplate = {
    agentId: 'agent_mail',
    connectionAccountId: alice.id,
    providerId: 'google',
    allowedCapabilities: ['gmail.messages.search', 'gmail.messages.send'],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const bobExact = {
    ...aliceTemplate,
    connectionAccountId: bob.id,
    allowedCapabilities: ['gmail.messages.search'],
  };

  for (const bindings of [
    [aliceTemplate, bobExact],
    [bobExact, aliceTemplate],
  ]) {
    const effective = await resolveEffectiveConnectionAccounts({
      config: {
        listConnectionAccounts: async () => [alice, bob],
        listAgentConnectionBindings: async () => bindings,
      },
      workspaceId: 'T_CONNECTIONS',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_bob',
    });
    assert.deepEqual(effective.map(({ account: current }) => current.id), [bob.id]);
    const policy = effective[0]?.policy;
    assert.equal(policy?.kind, 'managed');
    if (policy?.kind !== 'managed') assert.fail('expected a managed policy');
    assert.deepEqual(policy.allowedCapabilities, ['gmail.messages.search']);
    assert.equal(effective[0]?.binding.connectionAccountId, bob.id);
  }
});

test('foreign managed templates collapse to their capability intersection in either row order', async () => {
  const account = (
    id: string,
    ownerMembershipId: string,
    allowedCapabilities: string[],
  ) => ({
    id,
    workspaceId: 'T_CONNECTIONS',
    revision: 1,
    ownerKind: 'member' as const,
    ownerMembershipId,
    createdByMembershipId: ownerMembershipId,
    providerId: 'google',
    label: 'Gmail · Personal',
    policy: {
      kind: 'managed' as const,
      adapterId: 'composio',
      toolkit: 'gmail',
      principalRef: `chickpea:membership:${ownerMembershipId}`,
      accountRef: `ca_${ownerMembershipId}`,
      allowedCapabilities,
    },
    secretRefId: `secret_${id}`,
    lifecycle: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
  });
  const alice = account(
    'connection_alice_template',
    'membership_alice',
    ['gmail.messages.search', 'gmail.messages.send'],
  );
  const carol = account(
    'connection_carol_template',
    'membership_carol',
    ['gmail.messages.search'],
  );
  const bob = account(
    'connection_bob_unbound',
    'membership_bob',
    ['gmail.messages.search', 'gmail.messages.send'],
  );
  const binding = (current: typeof alice) => ({
    agentId: 'agent_mail',
    connectionAccountId: current.id,
    providerId: 'google',
    allowedCapabilities: [...current.policy.allowedCapabilities],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const aliceTemplate = binding(alice);
  const carolTemplate = binding(carol);

  for (const bindings of [
    [aliceTemplate, carolTemplate],
    [carolTemplate, aliceTemplate],
  ]) {
    const effective = await resolveEffectiveConnectionAccounts({
      config: {
        listConnectionAccounts: async () => [alice, carol, bob],
        listAgentConnectionBindings: async () => bindings,
      },
      workspaceId: 'T_CONNECTIONS',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_bob',
    });
    assert.deepEqual(effective.map(({ account: current }) => current.id), [bob.id]);
    const policy = effective[0]?.policy;
    assert.equal(policy?.kind, 'managed');
    if (policy?.kind !== 'managed') assert.fail('expected a managed policy');
    assert.deepEqual(policy.allowedCapabilities, ['gmail.messages.search']);
  }
});

test('foreign managed templates collapse to their resource intersection in either row order', async () => {
  const resource = (handle: string, providerRef: string) => ({
    handle,
    providerRef,
    label: handle,
  });
  const account = (
    id: string,
    ownerMembershipId: string,
    selectedHandles: string[],
  ) => ({
    id,
    workspaceId: 'T_CONNECTIONS',
    revision: 1,
    ownerKind: 'member' as const,
    ownerMembershipId,
    createdByMembershipId: ownerMembershipId,
    providerId: 'google',
    label: 'Google Analytics · Personal',
    policy: {
      kind: 'managed' as const,
      adapterId: 'composio',
      toolkit: 'google_analytics',
      principalRef: `chickpea:membership:${ownerMembershipId}`,
      accountRef: `ca_${ownerMembershipId}`,
      allowedCapabilities: ['analytics.reports.run'],
      resourceConstraints: {
        propertyIds: [
          resource('property_shared', 'properties/100'),
          resource('property_alice', 'properties/200'),
          resource('property_carol', 'properties/300'),
        ].filter(({ handle }) => selectedHandles.includes(handle)),
      },
    },
    secretRefId: `secret_${id}`,
    lifecycle: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
  });
  const alice = account(
    'connection_alice_template',
    'membership_alice',
    ['property_shared', 'property_alice'],
  );
  const carol = account(
    'connection_carol_template',
    'membership_carol',
    ['property_shared', 'property_carol'],
  );
  const bob = account(
    'connection_bob_unbound',
    'membership_bob',
    ['property_shared', 'property_alice', 'property_carol'],
  );
  const binding = (current: typeof alice) => ({
    agentId: 'agent_analytics',
    connectionAccountId: current.id,
    providerId: 'google',
    allowedCapabilities: ['analytics.reports.run'],
    resourceConstraints: {
      propertyIds: current.policy.resourceConstraints.propertyIds.map(({ handle }) => handle),
    },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });

  for (const bindings of [
    [binding(alice), binding(carol)],
    [binding(carol), binding(alice)],
  ]) {
    const effective = await resolveEffectiveConnectionAccounts({
      config: {
        listConnectionAccounts: async () => [alice, carol, bob],
        listAgentConnectionBindings: async () => bindings,
      },
      workspaceId: 'T_CONNECTIONS',
      agentId: 'agent_analytics',
      actorMembershipId: 'membership_bob',
    });
    assert.deepEqual(effective.map(({ account: current }) => current.id), [bob.id]);
    const policy = effective[0]?.policy;
    assert.equal(policy?.kind, 'managed');
    if (policy?.kind !== 'managed') assert.fail('expected a managed policy');
    assert.deepEqual(policy.resourceConstraints?.propertyIds?.map(({ handle }) => handle), [
      'property_shared',
    ]);
  }
});

test('personal MCP accounts cannot substitute a different credential header policy', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({ config, settings, randomId: () => `header${++nextId}` });
  const templatePolicy = {
    kind: 'mcp' as const,
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'streamable-http' as const,
    authMode: 'none' as const,
    headerNames: ['Authorization'],
    credentialHeaderName: 'Authorization',
    credentialValuePrefix: 'Sentry-Bearer ',
    discoveredTools: [{ name: 'search_issues' }],
    allowedTools: ['search_issues'],
    presetId: 'sentry',
  };
  try {
    await config.createAgent(agent('agent_errors', 'membership_alice'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS', transportMode: 'direct', defaultAgentId: 'agent_errors',
    });
    const template = await service.create({
      principal: principal('membership_alice'), workspaceId: 'T_CONNECTIONS', ownerKind: 'member',
      providerId: 'sentry', label: 'Alice Sentry', policy: templatePolicy, credential: 'alice-token',
    });
    await service.create({
      principal: principal('membership_bob'), workspaceId: 'T_CONNECTIONS', ownerKind: 'member',
      providerId: 'sentry', label: 'Bob altered Sentry',
      policy: {
        ...templatePolicy,
        headerNames: ['X-Unsafe-Key'],
        credentialHeaderName: 'X-Unsafe-Key',
        credentialValuePrefix: 'Token ',
      },
      credential: 'bob-token',
    });
    await service.attach({
      principal: principal('membership_alice'), agentId: 'agent_errors',
      connectionAccountId: template.id,
    });

    const effective = await resolveEffectiveConnectionAccounts({
      config, workspaceId: 'T_CONNECTIONS', agentId: 'agent_errors',
      actorMembershipId: 'membership_bob',
    });
    assert.deepEqual(effective, []);
  } finally {
    config.close();
    settings.close();
  }
});

test('a retry finishes terminal schedule cleanup after revocation already tombstoned the secret', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({ config, settings, randomId: () => `id${++nextId}` });
  try {
    await config.createAgent(agent('agent_support', 'membership_creator'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const account = await service.create({
      principal: principal('membership_creator'), workspaceId: 'T_CONNECTIONS', ownerKind: 'team',
      providerId: 'zendesk', label: 'Zendesk', policy: {
        kind: 'api', allowedHosts: ['acme.zendesk.com'], pathPrefixes: ['/api/'],
        headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential',
      }, credential: 'token',
    });
    await service.attach({
      principal: principal('membership_creator'), agentId: 'agent_support', connectionAccountId: account.id,
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_triage', agentId: 'agent_support', workspaceId: 'T_CONNECTIONS',
      channelId: 'C_SUPPORT', createdByMembershipId: 'membership_creator',
      runsAsMembershipId: 'membership_creator', authorityReceiptId: 'schedule_authority_creator',
      requiredConnectionAccountIds: [account.id], state: 'active',
    });
    const putSchedule = config.putAgentScheduleReference.bind(config);
    config.putAgentScheduleReference = (input, expectedRevision) => {
      if (input.scheduleId === 'schedule_triage' &&
          input.requiredConnectionAccountIds.length === 0) {
        throw new Error('simulated terminal schedule cleanup race');
      }
      return putSchedule(input, expectedRevision);
    };
    await assert.rejects(
      service.revoke({
        principal: principal('membership_creator'), connectionAccountId: account.id,
      }),
      ConnectionScheduleConflictError,
    );
    assert.equal(
      (await config.listConnectionAccounts('T_CONNECTIONS'))
        .find(({ id }) => id === account.id)?.lifecycle,
      'revoked',
    );
    assert.equal(await resolveConnectionAccountSecret({ secretRefId: account.secretRefId }, undefined, settings), undefined);
    const pendingCleanup = (await config.listAgentScheduleReferences('agent_support'))[0];
    assert.equal(pendingCleanup?.state, 'needs_attention');
    assert.deepEqual(pendingCleanup?.requiredConnectionAccountIds, [account.id]);
    assert.deepEqual(pendingCleanup?.connectionPauseAccountIds, [account.id]);
    config.putAgentScheduleReference = putSchedule;
    const revoked = await service.revoke({
      principal: principal('membership_creator'), connectionAccountId: account.id,
    });
    assert.equal(revoked.lifecycle, 'revoked');
    const schedule = (await config.listAgentScheduleReferences('agent_support'))[0];
    assert.equal(schedule?.state, 'needs_attention');
    assert.deepEqual(schedule?.requiredConnectionAccountIds, []);
    assert.equal(schedule?.connectionPauseAccountIds, undefined);
  } finally {
    config.close();
    settings.close();
  }
});

test('attaching an account refreshes schedule revisions before retrying a resume conflict', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const service = new ConnectionAccountService({
    config, settings, randomId: () => 'attach_resume_conflict',
  });
  try {
    await config.createAgent(agent('agent_resume_conflict', 'membership_creator'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS', transportMode: 'direct',
      defaultAgentId: 'agent_resume_conflict',
    });
    const account = await service.create({
      principal: principal('membership_creator'), workspaceId: 'T_CONNECTIONS',
      ownerKind: 'team', providerId: 'zendesk', label: 'Zendesk', policy: {
        kind: 'api', allowedHosts: ['acme.zendesk.com'], pathPrefixes: ['/api/'],
        headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential',
      }, credential: 'token',
    });
    await config.putAgentConnectionBinding({
      agentId: 'agent_resume_conflict', connectionAccountId: account.id,
      providerId: account.providerId, allowedCapabilities: [], enabled: false,
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_resume_conflict', agentId: 'agent_resume_conflict',
      workspaceId: 'T_CONNECTIONS', channelId: 'C_SUPPORT',
      createdByMembershipId: 'membership_creator', runsAsMembershipId: 'membership_creator',
      authorityReceiptId: 'authority_resume_conflict',
      requiredConnectionAccountIds: [account.id],
      connectionPauseAccountIds: [account.id], state: 'needs_attention',
    });
    const putSchedule = config.putAgentScheduleReference.bind(config);
    let conflictInjected = false;
    config.putAgentScheduleReference = async (input, expectedRevision) => {
      if (!conflictInjected && input.scheduleId === 'schedule_resume_conflict' &&
          input.state === 'active') {
        conflictInjected = true;
        const current = (await config.listAgentScheduleReferences('agent_resume_conflict'))[0]!;
        await putSchedule(current, current.revision);
        throw new Error('simulated concurrent schedule revision');
      }
      return putSchedule(input, expectedRevision);
    };

    await service.attach({
      principal: principal('membership_creator'), agentId: 'agent_resume_conflict',
      connectionAccountId: account.id,
    });

    assert.equal(conflictInjected, true);
    const resumed = (await config.listAgentScheduleReferences('agent_resume_conflict'))[0]!;
    assert.equal(resumed.state, 'active');
    assert.equal(resumed.connectionPauseAccountIds, undefined);
  } finally {
    config.close();
    settings.close();
  }
});

test('OAuth continuation is actor/Agent-bound and resumes exactly once', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let clock = 100;
  try {
    const created = await createOAuthContinuation({
      settings, workspaceId: 'T_CONNECTIONS', actorMembershipId: 'membership_alice',
      agentId: 'agent_mail', channelId: 'D_ALICE', threadTs: '1.000', taskId: 'task_1',
      providerId: 'google', accountId: 'connection_google', now: () => clock,
      randomId: (() => { let id = 0; return () => `random${++id}`; })(),
    });
    await assert.rejects(
      authorizeOAuthContinuation({ settings, state: created.state, actorMembershipId: 'membership_bob', agentId: 'agent_mail', now: () => clock }),
      (error: unknown) => error instanceof OAuthContinuationError && error.code === 'wrong_actor',
    );
    const authorized = await authorizeOAuthContinuation({
      settings, state: created.state, actorMembershipId: 'membership_alice', agentId: 'agent_mail', now: () => ++clock,
    });
    assert.equal(authorized.status, 'authorized');
    const resumed = await claimOAuthContinuationResume({ settings, continuationId: authorized.id, now: () => ++clock });
    assert.equal(resumed.status, 'resumed');
    await assert.rejects(
      claimOAuthContinuationResume({ settings, continuationId: authorized.id, now: () => ++clock }),
      (error: unknown) => error instanceof OAuthContinuationError && error.code === 'replayed',
    );
  } finally {
    settings.close();
  }
});

test('provider OAuth state authorizes only its linked Slack continuation and consumes the link', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const created = await createOAuthContinuation({
      settings, workspaceId: 'T_CONNECTIONS', actorMembershipId: 'membership_alice',
      agentId: 'agent_mail', channelId: 'D_ALICE', threadTs: '2.000', taskId: 'task_2',
      providerId: 'google', accountId: 'connection_google', now: () => 100,
      randomId: (() => { let id = 0; return () => `provider${++id}`; })(),
    });
    await linkOAuthProviderState({
      settings,
      providerState: 'opaque-provider-state',
      continuationState: created.state,
    });
    const continuationState = await takeOAuthContinuationForProviderState({
      settings,
      providerState: 'opaque-provider-state',
    });
    assert.equal(continuationState, created.state);
    assert.equal(await takeOAuthContinuationForProviderState({
      settings,
      providerState: 'opaque-provider-state',
    }), undefined);
    const authorized = await authorizeOAuthContinuationFromProvider({
      settings,
      state: continuationState!,
      now: () => 101,
    });
    assert.equal(authorized.status, 'authorized');
    assert.equal(authorized.actorMembershipId, 'membership_alice');
    assert.equal(authorized.agentId, 'agent_mail');
    assert.equal(authorized.taskId, 'task_2');
  } finally {
    settings.close();
  }
});

test('authorized OAuth continuations survive a failed resume without starving later repairs', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const created = await createOAuthContinuation({
      settings, workspaceId: 'T_CONNECTIONS', actorMembershipId: 'membership_alice',
      agentId: 'agent_mail', channelId: 'D_ALICE', threadTs: '2.000', taskId: 'task_repair',
      providerId: 'google', accountId: 'connection_google', now: () => 100,
      randomId: (() => { let id = 0; return () => `repair${++id}`; })(),
    });
    const authorized = await authorizeOAuthContinuationFromProvider({
      settings,
      state: created.state,
      now: () => 101,
    });
    const later = await createOAuthContinuation({
      settings, workspaceId: 'T_CONNECTIONS', actorMembershipId: 'membership_bob',
      agentId: 'agent_mail', channelId: 'D_BOB', threadTs: '3.000', taskId: 'task_later',
      providerId: 'google', accountId: 'connection_google_bob', now: () => 100,
      randomId: (() => { let id = 0; return () => `later${++id}`; })(),
    });
    const laterAuthorized = await authorizeOAuthContinuationFromProvider({
      settings,
      state: later.state,
      now: () => 101,
    });
    let deliveries = 0;
    const firstPass = await repairPendingOAuthContinuationResumes({
      settings,
      now: () => 102,
      onReady: async (continuation) => {
        deliveries += 1;
        if (continuation.id === authorized.id) throw new Error('queue temporarily unavailable');
        assert.equal(continuation.id, laterAuthorized.id);
      },
    });
    assert.deepEqual(firstPass, { resumed: 1, pending: 1, pruned: 0 });
    assert.equal(deliveries, 2);
    const repaired = await repairPendingOAuthContinuationResumes({
      settings,
      now: () => 103,
      onReady: async (continuation) => {
        assert.equal(continuation.id, authorized.id);
        deliveries += 1;
      },
    });
    assert.deepEqual(repaired, { resumed: 1, pending: 0, pruned: 0 });
    assert.equal(deliveries, 3);
    assert.deepEqual(await repairPendingOAuthContinuationResumes({
      settings,
      now: () => 104,
      onReady: async () => { deliveries += 1; },
    }), { resumed: 0, pending: 0, pruned: 0 });
  } finally {
    settings.close();
  }
});

test('OAuth continuation repair prunes a pending entry that expired before authorization', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const created = await createOAuthContinuation({
      settings, workspaceId: 'T_CONNECTIONS', actorMembershipId: 'membership_alice',
      agentId: 'agent_mail', channelId: 'D_ALICE', threadTs: '2.500', taskId: 'task_expired',
      providerId: 'google', accountId: 'connection_google', now: () => 100,
      ttlMs: 10,
      randomId: (() => { let id = 0; return () => `expired${++id}`; })(),
    });
    await settings.setSetting(
      'connection-oauth-resume-pending',
      JSON.stringify([created.continuation.id]),
    );
    let deliveries = 0;
    assert.deepEqual(await repairPendingOAuthContinuationResumes({
      settings,
      now: () => 111,
      onReady: async () => { deliveries += 1; },
    }), { resumed: 0, pending: 0, pruned: 1 });
    assert.equal(deliveries, 0);
    assert.deepEqual(await repairPendingOAuthContinuationResumes({
      settings,
      now: () => 112,
      onReady: async () => { deliveries += 1; },
    }), { resumed: 0, pending: 0, pruned: 0 });
  } finally {
    settings.close();
  }
});

test('missing actor account starts one account-owned OAuth flow from the Agent provider capability', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({ config, settings, randomId: () => `seed${++nextId}` });
  try {
    await config.createAgent(agent('agent_mail', 'membership_alice'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS', transportMode: 'direct', defaultAgentId: 'agent_mail',
    });
    const template = await service.create({
      principal: principal('membership_alice'), workspaceId: 'T_CONNECTIONS', ownerKind: 'member',
      providerId: 'google', label: 'Alice Work', policy: gmailPolicy(), credential: 'seed-token',
    });
    await service.attach({
      principal: principal('membership_alice'), agentId: 'agent_mail', connectionAccountId: template.id,
    });
    await saveApiOAuthClient(connectionAccountOAuthRef(template.id), {
      provider: 'google', clientId: 'deployment-client', clientSecret: 'deployment-secret',
    }, settings);

    const started = await startPersonalConnectionAuthorization({
      workspaceId: 'T_CONNECTIONS', agentId: 'agent_mail',
      actorMembershipId: 'membership_bob', slackUserId: 'U_BOB',
      channelId: 'C_MAIL', threadTs: '123.000', taskId: 'turn_job_1',
      providerId: 'google', accountLabel: 'Work',
    }, {
      config,
      settings,
      resolveMembership: async () => ({ membershipId: 'membership_bob' }),
      publicOrigin: async () => 'https://chickpea.example.test',
      randomId: () => 'bobwork',
      oauth: { randomId: (() => { let id = 0; return () => `oauth${++id}`; })() },
    });
    assert.equal(started.kind, 'authorization_required');
    if (started.kind !== 'authorization_required') return;
    assert.match(started.authorizationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.deepEqual(started.actionLinks, [{
      url: started.authorizationUrl,
      label: 'Authorize Google',
    }]);
    const actorAccount = (await config.listConnectionAccounts('T_CONNECTIONS'))
      .find((account) => account.id === 'connection_bobwork');
    assert.equal(actorAccount?.ownerMembershipId, 'membership_bob');
    assert.equal(actorAccount?.lifecycle, 'pending');
    assert.match(
      actorAccount?.policy.oauthAttemptId ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const pendingAuthorization = JSON.parse(
      (await settings.getSetting(apiOAuthSettingKeys(
        connectionAccountOAuthRef('connection_bobwork'),
      )[1]))!,
    ) as { accountRevision?: number; oauthAttemptId?: string };
    assert.equal(pendingAuthorization.accountRevision, actorAccount?.revision);
    assert.equal(pendingAuthorization.oauthAttemptId, actorAccount?.policy.oauthAttemptId);
    assert.deepEqual(
      await describeApiOAuthSources(connectionAccountOAuthRef('connection_bobwork'), settings),
      { client: 'stored', tokens: 'missing' },
    );
    assert.deepEqual(
      await describeApiOAuthSources(connectionAccountOAuthRef(template.id), settings),
      { client: 'stored', tokens: 'missing' },
      'copying a deployment OAuth app must not move or duplicate personal token state',
    );
    const providerState = new URL(started.authorizationUrl).searchParams.get('state');
    assert.ok(providerState);
    const continuationState = await takeOAuthContinuationForProviderState({
      settings,
      providerState,
    });
    assert.ok(continuationState);
    const continuation = await authorizeOAuthContinuationFromProvider({
      settings,
      state: continuationState,
    });
    assert.equal(continuation.taskId, 'turn_job_1');
    assert.equal(continuation.actorMembershipId, 'membership_bob');
    assert.equal(continuation.accountId, 'connection_bobwork');
  } finally {
    config.close();
    settings.close();
  }
});

test('authority prompt names persisted Agent instructions as the only grant source', () => {
  const instructions = externalActionAuthorityInstructions('You may archive resolved tickets.');
  assert.match(instructions, /saved Agent instructions.*expand authority/i);
  assert.match(instructions, /conversation text, retrieved content, and tool output.*never grant/i);
  assert.match(instructions, /archive resolved tickets/);
});
