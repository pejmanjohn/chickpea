import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { AuthorizationError } from '../src/auth/permissions.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { signInGroupPolicy } from '../src/config/sign-in-group.ts';
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
import {
  ManagedSignInOtherKindError,
  signInMixRefusal,
  signInOtherKindNotice,
} from '../src/connections/sign-in-mix.ts';

test('managed authorization refuses a frozen handoff capability absent from the live read lane', async () => {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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

test('reconnecting a read-only Agent on a shared Notion sign-in keeps its write lane and moves every Agent', async () => {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const authorized: Array<{ allowedCapabilities: readonly string[]; accessLane?: string }> = [];
  const revoked: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize(input) {
      authorized.push({
        allowedCapabilities: input.allowedCapabilities,
        ...(input.accessLane ? { accessLane: input.accessLane } : {}),
      });
      return {
        authorizationUrl: new URL('https://backend.composio.dev/link/shared-notion'),
        authorizationRef: 'ca_notion_new',
      };
    },
    async pollAuthorization() {
      return { status: 'active', accountRef: 'ca_notion_new', toolkit: 'notion' };
    },
    async validate() { return { person: 'notion:ws-1:user-1' }; },
    async execute() { return { data: {} }; },
    async revoke(input) { revoked.push(input.policy.accountRef); },
  };
  const principal: AuthPrincipal = {
    userId: 'user_shared_owner',
    membershipId: 'membership_shared_owner',
    organizationId: 'organization_shared',
    role: 'owner',
    authenticatorKind: 'better_auth',
    credentialId: 'credential_shared_owner',
    correlationId: 'correlation_shared_owner',
    machine: false,
  };
  try {
    const [ops, sales] = await Promise.all(['agent_shared_ops', 'agent_shared_sales'].map((id) =>
      config.createAgent({
        id, name: id, creatorMembershipId: 'membership_shared_owner', editPolicy: 'creator_and_admins',
        lifecycle: 'active', configurationGeneration: 1, instructions: 'Use Notion.', enabled: true,
        skills: [], mcpServers: [], apiConnections: [], repositories: [],
      })));
    if (!ops || !sales) throw new Error('expected both Agents');
    await config.ensureWorkspaceInstallation({
      workspaceId: 'workspace_shared_notion', transportMode: 'direct', defaultAgentId: ops.id,
    });
    const notion = (id: string, agentId: string, allowedCapabilities: string[]) => ({
      account: {
        id, workspaceId: 'workspace_shared_notion', ownerKind: 'team' as const,
        createdByMembershipId: 'membership_shared_owner', providerId: 'notion', label: 'Notion · Team',
        secretRefId: `secret_${id}`, lifecycle: 'ready' as const,
        policy: {
          kind: 'managed' as const, adapterId: 'composio', toolkit: 'notion',
          principalRef: 'chickpea:organization:organization_shared', accountRef: 'ca_notion_old',
          allowedCapabilities, signIn: { person: 'notion:ws-1:user-1', accessLane: 'write' as const },
          providerGeneration: 3, providerLineage: 'e'.repeat(24),
        },
      },
      binding: { agentId, connectionAccountId: id, providerId: 'notion', allowedCapabilities, enabled: true },
    });
    const { account: opsAccount } = await config.createAgentOwnedConnection(
      notion('connection_shared_ops', ops.id, ['notion.content.search', 'notion.pages.create']),
    );
    if (opsAccount.policy.kind !== 'managed') throw new Error('expected a managed account');
    await config.applySignInGroup({
      adapterId: 'composio', accountRef: 'ca_notion_old',
      members: [{ connectionAccountId: opsAccount.id, expectedRevision: opsAccount.revision }],
      shared: signInGroupPolicy(opsAccount.policy),
      join: notion('connection_shared_sales', sales.id, ['notion.content.search']),
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
      principal, agent: sales, workspaceId: 'workspace_shared_notion',
      connectionAccountId: 'connection_shared_sales',
    });
    assert.deepEqual(authorized, [{ allowedCapabilities: ['notion.content.search'], accessLane: 'write' }]);

    const connected = await pollManagedAuthorizationFlow(dependencies, {
      principal, agent: sales, workspaceId: 'workspace_shared_notion', browserSecret: started.browserSecret,
    });
    assert.equal(connected.status, 'connected');
    assert.deepEqual(revoked, ['ca_notion_old']);
    assert.deepEqual(
      (await config.listConnectionAccounts('workspace_shared_notion')).map((account) =>
        account.policy.kind === 'managed' && [account.id, account.policy.accountRef, account.policy.allowedCapabilities]),
      [
        ['connection_shared_ops', 'ca_notion_new', ['notion.content.search', 'notion.pages.create']],
        ['connection_shared_sales', 'ca_notion_new', ['notion.content.search']],
      ],
    );
  } finally {
    config.close();
    settings.close();
  }
});

const MAYA = 'notion:ws-1:user-maya';
const RAVI = 'notion:ws-1:user-ravi';
const NOTION = MANAGED_CONNECTOR_CATALOG.connector('notion')!;

/**
 * One workspace whose live Notion connections sit on another Agent unless
 * their id ends in `_target`, and a Composio fake whose sign-ins name
 * `state.person`, or no one while it is undefined, unless
 * `state.lookupFailed` says Notion could not be asked.
 */
async function notionMixHarness(existing: Array<{
  id: string;
  ownerKind: 'team' | 'member';
  signer: string;
  person?: string;
  lifecycle?: 'ready' | 'revoked';
  toolkit?: string;
}>) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const authorized: string[] = [];
  const cleaned: string[] = [];
  const revoked: string[] = [];
  const state: { person: string | undefined; lookupFailed?: boolean } = { person: undefined };
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      authorized.push(`ca_new_${authorized.length + 1}`);
      return {
        authorizationUrl: new URL(`https://backend.composio.dev/link/${authorized.length}`),
        authorizationRef: authorized.at(-1)!,
      };
    },
    async pollAuthorization(input) {
      return { status: 'active', accountRef: input.authorizationRef, toolkit: 'notion' };
    },
    async validate() {
      if (state.lookupFailed) return { personLookupFailed: true as const };
      return state.person ? { person: state.person } : undefined;
    },
    async execute() { return { data: {} }; },
    async revoke(input) { revoked.push(input.policy.accountRef); },
    async cleanupRemoteAccount({ accountRef }) { cleaned.push(accountRef); },
  };
  const agent = (id: string) => config.createAgent({
    id, name: id, creatorMembershipId: 'm_admin', editPolicy: 'all_workspace_members',
    lifecycle: 'active', configurationGeneration: 1, instructions: 'Use Notion.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const target = await agent('agent_notion_target');
  const other = await agent('agent_notion_other');
  await config.ensureWorkspaceInstallation({
    workspaceId: 'T_MIX', transportMode: 'direct', defaultAgentId: target.id,
  });
  for (const connection of existing) {
    const toolkit = connection.toolkit ?? 'notion';
    const allowedCapabilities = [MANAGED_CONNECTOR_CATALOG.capabilities(toolkit, 'read')[0]!.id];
    await config.createAgentOwnedConnection({
      account: {
        id: connection.id, workspaceId: 'T_MIX', ownerKind: connection.ownerKind,
        ...(connection.ownerKind === 'member' ? { ownerMembershipId: connection.signer } : {}),
        createdByMembershipId: connection.signer, providerId: toolkit, label: connection.id,
        secretRefId: `secret_${connection.id}`, lifecycle: connection.lifecycle ?? 'ready',
        policy: {
          kind: 'managed', adapterId: 'composio', toolkit,
          principalRef: connection.ownerKind === 'team'
            ? 'chickpea:organization:org_mix'
            : `chickpea:membership:${connection.signer}`,
          accountRef: `ca_${connection.id}`,
          allowedCapabilities,
          ...(connection.person ? { signIn: { person: connection.person, accessLane: 'read' as const } } : {}),
        },
      },
      binding: {
        agentId: connection.id.endsWith('_target') ? target.id : other.id,
        connectionAccountId: connection.id, providerId: toolkit, allowedCapabilities, enabled: true,
      },
    });
  }
  const principal = (membershipId: string, role: 'member' | 'admin' | 'owner'): AuthPrincipal => ({
    userId: `user_${membershipId}`, membershipId, organizationId: 'org_mix', role,
    authenticatorKind: 'better_auth', credentialId: `credential_${membershipId}`,
    correlationId: `correlation_${membershipId}`, machine: false,
  });
  const dependencies = {
    config,
    settings,
    catalog: MANAGED_CONNECTOR_CATALOG,
    providerContext: {
      providers: createManagedConnectionProviderRegistry([provider]),
      generation: 1,
      lineage: 'f'.repeat(24),
    },
  };
  const start = (actor: AuthPrincipal, lane: {
    ownerKind?: 'team' | 'member';
    connectionAccountId?: string;
    differentAccount?: boolean;
    toolkit?: string;
  }) =>
    startManagedAuthorizationFlow(dependencies, {
      principal: actor, agent: target, workspaceId: 'T_MIX', toolkit: 'notion', access: 'read', ...lane,
    });
  return {
    state, authorized, cleaned, revoked, principal, dependencies, start,
    /** Every saved row's revision and connected account, so a refusal can prove it wrote nothing. */
    async saved() {
      const accounts = (await config.listConnectionAccounts('T_MIX')).map((account) => ({
        id: account.id, revision: account.revision, lifecycle: account.lifecycle,
        accountRef: account.policy.kind === 'managed' ? account.policy.accountRef : undefined,
      }));
      return { accounts, targetBindings: await config.listAgentConnectionBindings(target.id) };
    },
    async signIn(actor: AuthPrincipal, lane: Parameters<typeof start>[1]) {
      const started = await start(actor, lane);
      return pollManagedAuthorizationFlow(dependencies, {
        principal: actor, agent: target, workspaceId: 'T_MIX', browserSecret: started.browserSecret,
      });
    },
    close() {
      config.close();
      settings.close();
    },
  };
}

test('a personal Notion sign-in on the person behind a live team connection is refused, removed at Composio, and saves nothing', async () => {
  const h = await notionMixHarness([{ id: 'connection_team', ownerKind: 'team', signer: 'm_admin', person: MAYA }]);
  try {
    const before = await h.saved();
    h.state.person = MAYA;
    const result = await h.signIn(h.principal('m_maya', 'member'), { ownerKind: 'member' });

    assert.deepEqual(result, { status: 'refused', message: signInMixRefusal(NOTION, 'team', { samePerson: true, manageable: false }) });
    assert.deepEqual(h.cleaned, ['ca_new_1'], 'the new connected account is removed');
    assert.deepEqual(h.revoked, [], 'the team connection keeps its connected account');
    assert.deepEqual(await h.saved(), before, 'no connection or binding is written');
  } finally {
    h.close();
  }
});

test('a personal Notion sign-in on a different Notion person than the team connection connects', async () => {
  const h = await notionMixHarness([{ id: 'connection_team', ownerKind: 'team', signer: 'm_maya', person: MAYA }]);
  try {
    h.state.person = RAVI;
    const result = await h.signIn(h.principal('m_ravi', 'member'), { ownerKind: 'member' });

    assert.equal(result.status, 'connected');
    assert.deepEqual(h.cleaned, []);
    assert.deepEqual((await h.saved()).accounts.map(({ accountRef }) => accountRef).sort(),
      ['ca_connection_team', 'ca_new_1']);
  } finally {
    h.close();
  }
});

test('a revoked team connection on the same Notion person never refuses a personal sign-in', async () => {
  const h = await notionMixHarness([{
    id: 'connection_team', ownerKind: 'team', signer: 'm_admin', person: MAYA, lifecycle: 'revoked',
  }]);
  try {
    h.state.person = MAYA;
    assert.equal((await h.signIn(h.principal('m_maya', 'member'), { ownerKind: 'member' })).status, 'connected');
  } finally {
    h.close();
  }
});

test('reconnecting a team Notion connection onto the person of a live personal connection is refused and leaves it unchanged', async () => {
  const h = await notionMixHarness([
    { id: 'connection_team_target', ownerKind: 'team', signer: 'm_admin', person: RAVI },
    { id: 'connection_personal', ownerKind: 'member', signer: 'm_maya', person: MAYA },
  ]);
  try {
    const before = await h.saved();
    h.state.person = MAYA;
    const result = await h.signIn(h.principal('m_admin', 'admin'), { connectionAccountId: 'connection_team_target' });

    assert.deepEqual(result, { status: 'refused', message: signInMixRefusal(NOTION, 'member', { samePerson: true, manageable: false }) });
    assert.deepEqual(h.cleaned, ['ca_new_1']);
    assert.deepEqual(h.revoked, [], 'the team connection\'s current sign-in is not rotated away');
    assert.deepEqual(await h.saved(), before, 'the team connection keeps its revision and connected account');
  } finally {
    h.close();
  }
});

test('a team reconnect whose person Notion did not name fails closed against the actor\'s own personal connection', async () => {
  const h = await notionMixHarness([
    { id: 'connection_team_target', ownerKind: 'team', signer: 'm_admin', person: RAVI },
    { id: 'connection_personal', ownerKind: 'member', signer: 'm_admin', person: MAYA },
  ]);
  try {
    const before = await h.saved();
    const result = await h.signIn(h.principal('m_admin', 'admin'), { connectionAccountId: 'connection_team_target' });

    assert.deepEqual(result, { status: 'refused', message: signInMixRefusal(NOTION, 'member', { samePerson: false, manageable: true }) });
    assert.deepEqual(await h.saved(), before);
  } finally {
    h.close();
  }
});

test('a team reconnect whose Notion lookup failed is not compared as the person it had before', async () => {
  const h = await notionMixHarness([
    { id: 'connection_team_target', ownerKind: 'team', signer: 'm_lee', person: RAVI },
    { id: 'connection_personal', ownerKind: 'member', signer: 'm_admin', person: MAYA },
  ]);
  try {
    const before = await h.saved();
    h.state.lookupFailed = true;
    const result = await h.signIn(h.principal('m_admin', 'admin'), { connectionAccountId: 'connection_team_target' });

    assert.deepEqual(result, { status: 'refused', message: signInMixRefusal(NOTION, 'member', { samePerson: false, manageable: true }) });
    assert.deepEqual(h.cleaned, ['ca_new_1']);
    assert.deepEqual(await h.saved(), before, 'the team connection keeps its revision, connected account and person');
  } finally {
    h.close();
  }
});

test('a member who signed a team Notion connection gets a notice before Notion opens for a personal one', async () => {
  const h = await notionMixHarness([{ id: 'connection_team', ownerKind: 'team', signer: 'm_maya', person: MAYA }]);
  try {
    await assert.rejects(
      h.start(h.principal('m_maya', 'admin'), { ownerKind: 'member' }),
      (error) => error instanceof ManagedSignInOtherKindError &&
        error.message === signInOtherKindNotice(NOTION, 'team'),
    );
    assert.deepEqual(h.authorized, [], 'Composio is never asked for a sign-in link');
  } finally {
    h.close();
  }
});

test('continuing with a different Notion account skips only the notice', async () => {
  const h = await notionMixHarness([{ id: 'connection_team', ownerKind: 'team', signer: 'm_maya', person: MAYA }]);
  try {
    const maya = h.principal('m_maya', 'admin');
    h.state.person = RAVI;
    assert.equal((await h.signIn(maya, { ownerKind: 'member', differentAccount: true })).status, 'connected',
      'a different Notion person connects');

    const fallback = await notionMixHarness([{ id: 'connection_team', ownerKind: 'team', signer: 'm_maya', person: MAYA }]);
    try {
      const result = await fallback.signIn(fallback.principal('m_maya', 'admin'), {
        ownerKind: 'member', differentAccount: true,
      });
      assert.deepEqual(result, { status: 'refused', message: signInMixRefusal(NOTION, 'team', { samePerson: false, manageable: true }) },
        'when Notion names no one, the after-sign-in check still refuses the team connection\'s creator');
      assert.deepEqual(fallback.cleaned, ['ca_new_1']);
    } finally {
      fallback.close();
    }
  } finally {
    h.close();
  }
});

test('the Notion notice does not stop people who did not sign the other kind, or other connectors', async () => {
  const h = await notionMixHarness([
    { id: 'connection_team', ownerKind: 'team', signer: 'm_maya', person: MAYA },
    { id: 'connection_personal', ownerKind: 'member', signer: 'm_ravi', person: RAVI },
    { id: 'connection_hubspot_team', ownerKind: 'team', signer: 'm_lee', toolkit: 'hubspot' },
  ]);
  try {
    await h.start(h.principal('m_kim', 'member'), { ownerKind: 'member' });
    assert.equal(h.authorized.length, 1, 'a member with no team Notion connection proceeds');
    await h.start(h.principal('m_admin', 'admin'), { ownerKind: 'team' });
    assert.equal(h.authorized.length, 2, 'an Admin who did not sign the personal connection proceeds');
    await h.start(h.principal('m_lee', 'member'), { ownerKind: 'member', toolkit: 'hubspot' });
    assert.equal(h.authorized.length, 3, 'HubSpot has no shared sign-ins, so its team creator proceeds');
  } finally {
    h.close();
  }
});
