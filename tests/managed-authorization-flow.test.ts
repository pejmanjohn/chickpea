import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { AuthorizationError } from '../src/auth/permissions.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import {
  cancelManagedAuthorizationFlow,
  pollManagedAuthorizationFlow,
  startManagedAuthorizationFlow,
} from '../src/connections/managed-authorization-flow.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';

test('managed authorization refuses a frozen handoff capability absent from the live read lane', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let authorizeCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      authorizeCalls += 1;
      return {
        authorizationUrl: new URL('https://backend.composio.dev/link/should-not-run'),
        authorizationRef: 'authorization_should_not_run',
      };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  try {
    const agent = await config.createAgent({
      id: 'agent_scope_drift',
      name: 'Scope Drift',
      creatorMembershipId: 'membership_scope_drift',
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Test frozen connection scope.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const principal: AuthPrincipal = {
      userId: 'user_scope_drift',
      membershipId: 'membership_scope_drift',
      organizationId: 'organization_scope_drift',
      role: 'owner',
      authenticatorKind: 'better_auth',
      credentialId: 'credential_scope_drift',
      correlationId: 'correlation_scope_drift',
      machine: false,
    };
    await assert.rejects(
      startManagedAuthorizationFlow({
        config,
        settings,
        catalog: MANAGED_CONNECTOR_CATALOG,
        providerContext: {
          providers: createManagedConnectionProviderRegistry([provider]),
          generation: 1,
          lineage: 'lineage_scope_drift',
        },
      }, {
        principal,
        agent,
        workspaceId: 'workspace_scope_drift',
        ownerKind: 'member',
        toolkit: 'hubspot',
        access: 'read',
        capabilities: ['hubspot.objects.search', 'hubspot.capability.removed'],
      }),
      /target_changed/,
    );
    assert.equal(authorizeCalls, 0);
  } finally {
    config.close();
    settings.close();
  }
});

test('managed authorization isolates scoped setup flows for the same member', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let authorizeCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      authorizeCalls += 1;
      return {
        authorizationUrl: new URL(`https://backend.composio.dev/link/${authorizeCalls}`),
        authorizationRef: `authorization_${authorizeCalls}`,
      };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  try {
    const agent = await config.createAgent({
      id: 'agent_concurrent_claims',
      name: 'Concurrent Claims',
      creatorMembershipId: 'membership_concurrent_claims',
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Test isolated connector setup claims.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const principal: AuthPrincipal = {
      userId: 'user_concurrent_claims',
      membershipId: 'membership_concurrent_claims',
      organizationId: 'organization_concurrent_claims',
      role: 'owner',
      authenticatorKind: 'better_auth',
      credentialId: 'credential_concurrent_claims',
      correlationId: 'correlation_concurrent_claims',
      machine: false,
    };
    const dependencies = {
      config,
      settings,
      catalog: MANAGED_CONNECTOR_CATALOG,
      providerContext: {
        providers: createManagedConnectionProviderRegistry([provider]),
        generation: 1,
        lineage: 'a'.repeat(24),
      },
    };
    const common = {
      principal,
      agent,
      workspaceId: 'workspace_concurrent_claims',
      ownerKind: 'member' as const,
      toolkit: 'hubspot',
      access: 'read' as const,
    };

    const first = await startManagedAuthorizationFlow(dependencies, {
      ...common,
      attemptScopeId: 'setup_first',
    });
    const second = await startManagedAuthorizationFlow(dependencies, {
      ...common,
      attemptScopeId: 'setup_second',
    });

    assert.notEqual(first.browserSecret, second.browserSecret);
    assert.equal(first.attempt.authorizationRef, undefined);
    assert.equal(second.attempt.authorizationRef, undefined);
    assert.equal(authorizeCalls, 2);
  } finally {
    config.close();
    settings.close();
  }
});

test('a lost final setup commit revokes the imported account', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let revokeCalls = 0;
  let commitCalls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      return {
        authorizationUrl: new URL('https://backend.composio.dev/link/lost-commit'),
        authorizationRef: 'authorization_lost_commit',
      };
    },
    async pollAuthorization() {
      return {
        status: 'active',
        accountRef: 'authorization_lost_commit',
        toolkit: 'hubspot',
      };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() { revokeCalls += 1; },
  };
  try {
    const agent = await config.createAgent({
      id: 'agent_lost_commit',
      name: 'Lost Commit',
      creatorMembershipId: 'membership_lost_commit',
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Test final setup commit rollback.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const principal: AuthPrincipal = {
      userId: 'user_lost_commit',
      membershipId: 'membership_lost_commit',
      organizationId: 'organization_lost_commit',
      role: 'owner',
      authenticatorKind: 'better_auth',
      credentialId: 'credential_lost_commit',
      correlationId: 'correlation_lost_commit',
      machine: false,
    };
    await config.ensureWorkspaceInstallation({
      workspaceId: 'workspace_lost_commit',
      transportMode: 'direct',
      defaultAgentId: agent.id,
    });
    const dependencies = {
      config,
      settings,
      catalog: MANAGED_CONNECTOR_CATALOG,
      providerContext: {
        providers: createManagedConnectionProviderRegistry([provider]),
        generation: 1,
        lineage: 'd'.repeat(24),
      },
    };
    const started = await startManagedAuthorizationFlow(dependencies, {
      principal,
      agent,
      workspaceId: 'workspace_lost_commit',
      ownerKind: 'member',
      toolkit: 'hubspot',
      access: 'read',
      attemptScopeId: 'setup_lost_commit',
    });

    const result = await pollManagedAuthorizationFlow(dependencies, {
      principal,
      agent,
      workspaceId: 'workspace_lost_commit',
      browserSecret: started.browserSecret,
      attemptScopeId: 'setup_lost_commit',
      commit: async () => {
        commitCalls += 1;
        return false;
      },
    });

    assert.deepEqual(result, { status: 'lost' });
    assert.equal(commitCalls, 1);
    assert.equal(revokeCalls, 1);
    const accounts = await config.listConnectionAccounts('workspace_lost_commit');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.lifecycle, 'revoked');
  } finally {
    config.close();
    settings.close();
  }
});

test('a demoted Team creator gets cleanup-only reconnect polling and cancellation', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let authorizeCalls = 0;
  let pollCalls = 0;
  let validateCalls = 0;
  let revokeCalls = 0;
  let commitCalls = 0;
  const cleanedRemoteRefs: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      authorizeCalls += 1;
      return {
        authorizationUrl: new URL('https://backend.composio.dev/link/team-reconnect'),
        authorizationRef: 'authorization_team_reconnect',
      };
    },
    async pollAuthorization() {
      pollCalls += 1;
      return {
        status: 'active',
        accountRef: 'authorization_team_reconnect',
        toolkit: 'hubspot',
      };
    },
    async validate() { validateCalls += 1; },
    async execute() { return { data: {} }; },
    async revoke() { revokeCalls += 1; },
    async cleanupRemoteAccount({ accountRef }) { cleanedRemoteRefs.push(accountRef); },
  };
  const principal = (role: 'member' | 'admin'): AuthPrincipal => ({
    userId: 'user_team_creator',
    membershipId: 'membership_team_creator',
    organizationId: 'organization_team_reconnect',
    role,
    authenticatorKind: 'better_auth',
    credentialId: 'credential_team_creator',
    correlationId: `correlation_team_creator_${role}`,
    machine: false,
  });
  try {
    const agent = await config.createAgent({
      id: 'agent_team_reconnect',
      name: 'Team Reconnect',
      creatorMembershipId: 'membership_team_creator',
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Test current Team reconnect authority.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'workspace_team_reconnect',
      transportMode: 'direct',
      defaultAgentId: agent.id,
    });
    const { account } = await config.createAgentOwnedConnection({
      account: {
        id: 'connection_team_reconnect',
        workspaceId: 'workspace_team_reconnect',
        ownerKind: 'team',
        createdByMembershipId: 'membership_team_creator',
        providerId: 'hubspot',
        label: 'Team HubSpot',
        secretRefId: 'secret_team_reconnect',
        lifecycle: 'needs_attention',
        policy: {
          kind: 'managed',
          adapterId: 'composio',
          toolkit: 'hubspot',
          principalRef: 'chickpea:organization:organization_team_reconnect',
          accountRef: 'account_team_expired',
          allowedCapabilities: ['hubspot.objects.search'],
        },
      },
      binding: {
        agentId: agent.id,
        connectionAccountId: 'connection_team_reconnect',
        providerId: 'hubspot',
        allowedCapabilities: ['hubspot.objects.search'],
        enabled: true,
      },
    });
    const dependencies = {
      config,
      settings,
      catalog: MANAGED_CONNECTOR_CATALOG,
      providerContext: {
        providers: createManagedConnectionProviderRegistry([provider]),
        generation: 3,
        lineage: 'e'.repeat(24),
      },
    };
    const started = await startManagedAuthorizationFlow(dependencies, {
      principal: principal('admin'),
      agent,
      workspaceId: 'workspace_team_reconnect',
      connectionAccountId: account.id,
      attemptScopeId: 'setup_team_reconnect',
    });
    assert.equal(authorizeCalls, 1);

    const forbidden = (error: unknown) => error instanceof AuthorizationError;
    await assert.rejects(
      startManagedAuthorizationFlow(dependencies, {
        principal: principal('member'),
        agent,
        workspaceId: 'workspace_team_reconnect',
        connectionAccountId: account.id,
        attemptScopeId: 'setup_team_reconnect_denied',
      }),
      forbidden,
    );
    await assert.rejects(
      pollManagedAuthorizationFlow(dependencies, {
        principal: principal('member'),
        agent,
        workspaceId: 'workspace_team_reconnect',
        browserSecret: started.browserSecret,
        attemptScopeId: 'setup_team_reconnect',
        commit: async () => {
          commitCalls += 1;
          return true;
        },
      }),
      forbidden,
    );
    assert.equal(authorizeCalls, 1);
    assert.equal(pollCalls, 0);
    assert.equal(validateCalls, 0);
    assert.equal(revokeCalls, 0);
    assert.equal(commitCalls, 0);
    assert.deepEqual(cleanedRemoteRefs, ['authorization_team_reconnect']);
    assert.equal(
      (await config.listConnectionAccounts('workspace_team_reconnect'))[0]?.revision,
      account.revision,
    );

    const cancelAttempt = await startManagedAuthorizationFlow(dependencies, {
      principal: principal('admin'),
      agent,
      workspaceId: 'workspace_team_reconnect',
      connectionAccountId: account.id,
      attemptScopeId: 'setup_team_reconnect_cancel',
    });
    await assert.rejects(
      cancelManagedAuthorizationFlow(dependencies, {
        principal: principal('member'),
        browserSecret: cancelAttempt.browserSecret,
        attemptScopeId: 'setup_team_reconnect_cancel',
      }),
      forbidden,
    );
    assert.deepEqual(cleanedRemoteRefs, [
      'authorization_team_reconnect',
      'authorization_team_reconnect',
    ]);

    const adminAttempt = await startManagedAuthorizationFlow(dependencies, {
      principal: principal('admin'),
      agent,
      workspaceId: 'workspace_team_reconnect',
      connectionAccountId: account.id,
      attemptScopeId: 'setup_team_reconnect_admin',
    });
    const connected = await pollManagedAuthorizationFlow(dependencies, {
      principal: principal('admin'),
      agent,
      workspaceId: 'workspace_team_reconnect',
      browserSecret: adminAttempt.browserSecret,
      attemptScopeId: 'setup_team_reconnect_admin',
      commit: async () => {
        commitCalls += 1;
        return true;
      },
    });
    assert.equal(connected.status, 'connected');
    assert.equal(authorizeCalls, 3);
    assert.equal(pollCalls, 1);
    assert.equal(validateCalls, 1);
    assert.equal(revokeCalls, 1);
    assert.equal(commitCalls, 1);
  } finally {
    config.close();
    settings.close();
  }
});
