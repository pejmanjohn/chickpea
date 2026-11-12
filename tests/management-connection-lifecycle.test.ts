import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { createWebsiteLogin, listWebsiteLogins } from '../src/browser/logins.ts';
import { configureComposioPlatformSettings } from '../src/config/composio-settings.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { signInGroupPolicy } from '../src/config/sign-in-group.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import type { ConnectionAccount, ConnectionAccountManagedPolicy, CustomAgentConfig } from '../src/config/types.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProviderRegistry,
} from '../src/connections/managed.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { executeHostSlackManagementApproval } from '../src/management/slack-approval.ts';
import {
  invokeWorkspaceManagementTool,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolName,
} from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
  ManagementWorkspaceSnapshot,
  PrepareConnectorSetupResult,
} from '../src/management/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { confirmThroughService } from './helpers/management-service-result.ts';
import { storeAsPersonalLogin } from './helpers/website-logins.ts';

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;

const TEAM = 'T_TEST';

async function withFixture(
  suffix: string,
  run: (f: Fixture) => Promise<void>,
  overrides: Parameters<typeof createManagementAdapterFixture>[1] = {},
): Promise<void> {
  const f = await createManagementAdapterFixture(suffix, overrides, { teamId: TEAM });
  try {
    await run(f);
  } finally {
    f.close();
  }
}

function mcpContext(member: IdentityResolution | Fixture['owner']): ManagementActorContext {
  return {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'connection-lifecycle-test' },
  };
}

function slackContext(member: IdentityResolution | Fixture['owner'], agentId: string): ManagementActorContext {
  return {
    userId: member.user.id,
    membershipId: member.membership.id,
    organizationId: member.membership.organizationId,
    origin: { kind: 'slack', workspaceId: TEAM, channelId: 'C_OPS', threadTs: '100.1', agentId },
  };
}

async function call<TName extends WorkspaceManagementToolName>(
  f: Fixture,
  context: ManagementActorContext,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<unknown> {
  const response = await invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => context,
  }, name, args);
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: unknown }).result;
}

/** Confirms a held change over MCP, as 5.0's confirm_change does. */
async function confirmChange(f: Fixture, context: ManagementActorContext, proposalId: string): Promise<ManagementApplyResult> {
  const response = await confirmThroughService(f.service, context, proposalId);
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: ManagementApplyResult }).result;
}

async function callRaw<TName extends WorkspaceManagementToolName>(
  f: Fixture,
  context: ManagementActorContext,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
) {
  return invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => context,
  }, name, args);
}

async function apply(
  f: Fixture,
  context: ManagementActorContext,
  key: string,
  operations: ManagementOperation[],
): Promise<ManagementApplyResult> {
  return await call(f, context, 'apply_workspace_changes', { idempotencyKey: key, operations }) as ManagementApplyResult;
}

async function inspectAgent(f: Fixture, context: ManagementActorContext, agentId: string) {
  const snapshot = await call(f, context, 'inspect_workspace', {}) as ManagementWorkspaceSnapshot;
  const agent = snapshot.agents.find(({ id }) => id === agentId);
  assert.ok(agent, `inspection lists ${agentId}`);
  return { snapshot, agent };
}

async function addMember(f: Fixture, slackUserId: string): Promise<IdentityResolution> {
  return (await f.identity.provisionSlackMember({
    slackTeamId: TEAM,
    slackUserId,
    displayName: slackUserId,
  })).resolution;
}

async function seedAgent(f: Fixture, editPolicy: CustomAgentConfig['editPolicy'] = 'all_workspace_members') {
  const agent = await f.config.createAgent({
    id: 'agent_ops',
    name: 'Ops',
    instructions: 'Help the team.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: f.owner.membership.id,
    editPolicy,
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await f.config.ensureWorkspaceInstallation({ workspaceId: TEAM, transportMode: 'direct', defaultAgentId: agent.id });
  return agent;
}

async function bindAccount(
  f: Fixture,
  agentId: string,
  account: Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt' | 'workspaceId' | 'secretRefId' | 'createdByMembershipId'>,
): Promise<ConnectionAccount> {
  const stored = await f.config.putConnectionAccount({
    ...account,
    workspaceId: TEAM,
    createdByMembershipId: f.owner.membership.id,
    secretRefId: `secret_${account.id}`,
  });
  await f.config.putAgentConnectionBinding({
    agentId,
    connectionAccountId: stored.id,
    providerId: stored.providerId,
    allowedCapabilities: [],
    enabled: true,
  });
  return stored;
}

function linearAccount(lifecycle: ConnectionAccount['lifecycle']) {
  return {
    id: 'connection_linear_team',
    ownerKind: 'team' as const,
    providerId: 'linear',
    label: 'Linear',
    lifecycle,
    policy: {
      kind: 'mcp' as const,
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable-http' as const,
      authMode: 'oauth' as const,
      headerNames: [],
      discoveredTools: [{ name: 'list_issues' }, { name: 'create_issue' }],
      allowedTools: ['list_issues', 'create_issue'],
      oauthScope: 'read write',
      presetId: 'linear',
    },
  };
}

function hubspotAccount(lifecycle: ConnectionAccount['lifecycle']) {
  return {
    id: 'connection_hubspot_team',
    ownerKind: 'team' as const,
    providerId: 'hubspot',
    label: 'HubSpot · Team',
    lifecycle,
    policy: {
      kind: 'managed' as const,
      adapterId: 'composio',
      toolkit: 'hubspot',
      principalRef: 'chickpea:organization:test',
      accountRef: 'account_hubspot',
      allowedCapabilities: ['hubspot.contacts.search'],
    },
  };
}

test('prepare_connector_setup reconnects a needs_attention connection in place on both doors', () =>
  withFixture('reconnect-in-place', async (f) => {
    const agent = await seedAgent(f);
    const linear = await bindAccount(f, agent.id, linearAccount('needs_attention'));
    const hubspot = await bindAccount(f, agent.id, hubspotAccount('needs_attention'));

    const viaSlack = await call(f, slackContext(f.owner, agent.id), 'prepare_connector_setup', {
      connector: 'Linear',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    assert.deepEqual(viaSlack.reconnect, { connectionId: linear.id, label: 'Linear' });
    const setup = await f.management.getSetup(viaSlack.setupOperationId!);
    assert.equal(setup?.action, 'catalog_connection');
    assert.equal(setup?.target.connectionId, linear.id, 'the link reconnects the existing account');
    assert.equal(setup?.target.replacement, true);
    assert.equal(setup?.target.ownerKind, 'team');

    const managed = await call(f, slackContext(f.owner, agent.id), 'prepare_connector_setup', {
      connector: 'HubSpot',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    assert.deepEqual(managed.reconnect, { connectionId: hubspot.id, label: 'HubSpot · Team' });
    const managedSetup = await f.management.getSetup(managed.setupOperationId!);
    assert.equal(managedSetup?.action, 'managed_connection');
    assert.equal(managedSetup?.target.connectionId, hubspot.id);
    assert.equal(managedSetup?.target.replacement, true);

    const viaMcp = await call(f, mcpContext(f.owner), 'prepare_connector_setup', {
      agentId: agent.id,
      connector: 'Linear',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    assert.deepEqual(viaMcp.reconnect, { connectionId: linear.id, label: 'Linear' });
    assert.equal(new URL(viaMcp.handoffUrl).pathname, `/setup/${viaMcp.setupOperationId}`,
      'MCP gets the same one-connection setup page as Slack');
    const mcpSetup = await f.management.getSetup(viaMcp.setupOperationId!);
    assert.equal(mcpSetup?.action, 'catalog_connection');
    assert.equal(mcpSetup?.target.connectionId, linear.id, 'the MCP link reconnects the existing account too');
    assert.equal(mcpSetup?.target.replacement, true);
    assert.deepEqual(mcpSetup?.origin, { kind: 'mcp', clientId: 'connection-lifecycle-test' });

    const managedViaMcp = await call(f, mcpContext(f.owner), 'prepare_connector_setup', {
      agentId: agent.id,
      connector: 'HubSpot',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    const managedMcpSetup = await f.management.getSetup(managedViaMcp.setupOperationId!);
    assert.equal(managedMcpSetup?.action, 'managed_connection');
    assert.equal(managedMcpSetup?.target.connectionId, hubspot.id);
    assert.equal(managedMcpSetup?.target.replacement, true);

    const accounts = await f.config.listConnectionAccounts(TEAM);
    assert.equal(accounts.length, 2, 'no account was minted');
    const bindings = await f.config.listAgentConnectionBindings(agent.id);
    assert.deepEqual(bindings.map(({ connectionAccountId }) => connectionAccountId).sort(), [hubspot.id, linear.id].sort());
  }));

test('prepare_connector_setup reconnects a ready managed connection so the person can change its access', () =>
  withFixture('reconnect-ready-managed', async (f) => {
    const agent = await seedAgent(f);
    const notion = await bindAccount(f, agent.id, {
      id: 'connection_notion_team',
      ownerKind: 'team',
      providerId: 'notion',
      label: 'Notion · Team',
      lifecycle: 'ready',
      policy: {
        kind: 'managed',
        adapterId: 'composio',
        toolkit: 'notion',
        principalRef: 'chickpea:organization:test',
        accountRef: 'account_notion',
        allowedCapabilities: ['notion.content.search'],
      },
    });
    const hubspot = await bindAccount(f, agent.id, hubspotAccount('pending'));
    const linear = await bindAccount(f, agent.id, linearAccount('ready'));

    const pending = await call(f, slackContext(f.owner, agent.id), 'prepare_connector_setup', {
      connector: 'HubSpot',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    assert.equal(pending.reconnect?.connectionId, hubspot.id, 'a pending managed connection is reconnected too');

    const viaSlack = await call(f, slackContext(f.owner, agent.id), 'prepare_connector_setup', {
      connector: 'Notion',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    assert.deepEqual(viaSlack.reconnect, { connectionId: notion.id, label: 'Notion · Team' });
    const setup = await f.management.getSetup(viaSlack.setupOperationId!);
    assert.equal(setup?.action, 'managed_connection');
    assert.equal(setup?.target.connectionId, notion.id, 'the link signs in again on the same connection');
    assert.equal(setup?.target.replacement, true);

    const viaMcp = await call(f, mcpContext(f.owner), 'prepare_connector_setup', {
      agentId: agent.id,
      connector: 'Notion',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    assert.deepEqual(viaMcp.reconnect, { connectionId: notion.id, label: 'Notion · Team' });
    const mcpSetup = await f.management.getSetup(viaMcp.setupOperationId!);
    assert.equal(mcpSetup?.action, 'managed_connection');
    assert.equal(mcpSetup?.target.connectionId, notion.id, 'over MCP too, the link signs in again on the same connection');
    assert.equal(mcpSetup?.target.replacement, true);

    const native = await call(f, slackContext(f.owner, agent.id), 'prepare_connector_setup', {
      connector: 'Linear',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    assert.equal(native.reconnect, undefined, 'a ready non-managed connection still gets a fresh setup');
    const nativeSetup = await f.management.getSetup(native.setupOperationId!);
    assert.equal(nativeSetup?.target.replacement, false);
    assert.notEqual(nativeSetup?.target.connectionId, linear.id);
  }));

test('inspect says which connections need reconnecting and how', () =>
  withFixture('reconnect-hint', async (f) => {
    const agent = await seedAgent(f);
    await bindAccount(f, agent.id, linearAccount('needs_attention'));
    await bindAccount(f, agent.id, hubspotAccount('needs_attention'));
    await bindAccount(f, agent.id, {
      ...linearAccount('ready'),
      id: 'connection_linear_ready',
      providerId: 'linear-ready',
    });

    const { agent: inspected } = await inspectAgent(f, mcpContext(f.owner), agent.id);
    const byId = new Map((inspected.connections ?? []).map((connection) => [connection.id, connection]));
    assert.deepEqual(byId.get('connection_linear_team')?.reconnect, {
      tool: 'apply_workspace_changes',
      operation: {
        kind: 'request_setup',
        target: { kind: 'mcp_connection', agentId: agent.id, connectionId: 'connection_linear_team' },
      },
    });
    assert.deepEqual(byId.get('connection_hubspot_team')?.reconnect, {
      tool: 'prepare_connector_setup',
      connector: 'hubspot-managed',
      ownerKind: 'team',
    });
    assert.equal(byId.get('connection_linear_ready')?.reconnect, undefined, 'a ready connection needs nothing');

    const member = await addMember(f, 'U22222222');
    const { agent: memberView } = await inspectAgent(f, mcpContext(member), agent.id);
    assert.ok((memberView.connections ?? []).every(({ reconnect }) => reconnect === undefined),
      'a Member cannot reconnect a team connection, so none is offered');
  }));

test('a Member cannot get a reconnect link for a team connection, and gets a fresh personal setup instead', () =>
  withFixture('reconnect-member-team', async (f) => {
    const agent = await seedAgent(f);
    const linear = await bindAccount(f, agent.id, linearAccount('needs_attention'));
    const member = await addMember(f, 'U55555555');
    const context = slackContext(member, agent.id);

    const team = await callRaw(f, context, 'prepare_connector_setup', { connector: 'Linear', ownerKind: 'team' });
    assert.equal(team.ok, false, JSON.stringify(team));
    assert.equal(team.ok === false ? team.error.code : undefined, 'forbidden');

    const personal = await call(f, context, 'prepare_connector_setup', {
      connector: 'Linear',
      ownerKind: 'member',
    }) as PrepareConnectorSetupResult;
    assert.equal(personal.reconnect, undefined, 'the team connection is not offered for reconnecting');
    const setup = await f.management.getSetup(personal.setupOperationId!);
    assert.equal(setup?.target.replacement, false);
    assert.equal(setup?.target.ownerKind, 'member');
    assert.notEqual(setup?.target.connectionId, linear.id, 'a new personal account, not the team one');
    assert.equal((await f.config.listConnectionAccounts(TEAM))[0]?.lifecycle, 'needs_attention');
  }));

test('a reconnect finds only the asker\'s own personal account, even for an Admin', () =>
  withFixture('reconnect-personal-lane', async (f) => {
    const agent = await seedAgent(f);
    const member = await addMember(f, 'U66666666');
    const personal = await bindAccount(f, agent.id, {
      ...linearAccount('needs_attention'),
      id: 'connection_linear_member',
      ownerKind: 'member',
      ownerMembershipId: member.membership.id,
      label: 'Linear · member',
    });

    const asAdmin = await call(f, slackContext(f.admin, agent.id), 'prepare_connector_setup', {
      connector: 'Linear',
      ownerKind: 'member',
    }) as PrepareConnectorSetupResult;
    assert.equal(asAdmin.reconnect, undefined, 'another member\'s personal account is never the Admin\'s to reconnect');
    const adminSetup = await f.management.getSetup(asAdmin.setupOperationId!);
    assert.equal(adminSetup?.target.replacement, false);
    assert.notEqual(adminSetup?.target.connectionId, personal.id);

    const asMember = await call(f, slackContext(member, agent.id), 'prepare_connector_setup', {
      connector: 'Linear',
      ownerKind: 'member',
    }) as PrepareConnectorSetupResult;
    assert.deepEqual(asMember.reconnect, { connectionId: personal.id, label: 'Linear · member' });
    const memberSetup = await f.management.getSetup(asMember.setupOperationId!);
    assert.equal(memberSetup?.target.connectionId, personal.id, 'the member gets the in-place reconnect');
    assert.equal(memberSetup?.target.replacement, true);
    assert.equal(memberSetup?.target.ownerKind, 'member');
  }));

test('a managed reconnect link needs the connector available, as a new connection does', async () => {
  let available = false;
  await withFixture('reconnect-managed-unavailable', async (f) => {
    const agent = await seedAgent(f);
    await bindAccount(f, agent.id, hubspotAccount('needs_attention'));
    const context = slackContext(f.owner, agent.id);

    // An app over MCP has no Agent in a thread to explain it, so the error names the next step and its page.
    for (const caller of [context, mcpContext(f.owner)]) {
      const refused = await callRaw(f, caller, 'prepare_connector_setup', {
        agentId: agent.id,
        connector: 'HubSpot',
        ownerKind: 'team',
      });
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.deepEqual(refused.ok === false ? refused.error : undefined, {
        code: 'setup_unavailable',
        message: 'HubSpot sign-in is not configured for this Chickpea deployment yet. A workspace Owner or Admin can set it up in Connectors in Admin Settings.',
        links: { admin: 'http://localhost/admin/settings/connectors' },
      }, caller.origin.kind);
    }

    available = true;
    const issued = await call(f, context, 'prepare_connector_setup', {
      connector: 'HubSpot',
      ownerKind: 'team',
    }) as PrepareConnectorSetupResult;
    assert.ok(issued.setupOperationId, 'the link is issued once the connector is available');
    assert.equal(issued.reconnect?.connectionId, 'connection_hubspot_team');
  }, { managedConnectorAvailable: async () => available });
});

test('disconnect_connection confirms on MCP, then revokes the account as Admin does', () =>
  withFixture('disconnect', async (f) => {
    const agent = await seedAgent(f);
    const linear = await bindAccount(f, agent.id, linearAccount('ready'));

    const pending = await apply(f, mcpContext(f.owner), 'disconnect-linear', [{
      itemId: 'disconnect',
      kind: 'disconnect_connection',
      agentId: agent.id,
      connectionId: 'linear',
    }]);
    assert.equal(pending.status, 'confirmation_required', JSON.stringify(pending.outcomes));
    assert.match(pending.presentation?.markdown ?? '',
      /^\*\*Proposed changes\*\*\nDisconnect \*\*Linear\*\* from \*\*Ops\*\* \(@ops\)\. The Agent loses access to it, and schedules that use it pause\.\n/);
    assert.equal((await f.config.listConnectionAccounts(TEAM))[0]?.lifecycle, 'ready', 'nothing applies before confirm');

    const confirmed = await confirmChange(f, mcpContext(f.owner), pending.outcomes[0]!.proposalId!);
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed.outcomes));
    const account = (await f.config.listConnectionAccounts(TEAM)).find(({ id }) => id === linear.id);
    assert.equal(account?.lifecycle, 'revoked');
    const { agent: after } = await inspectAgent(f, mcpContext(f.owner), agent.id);
    assert.equal((after.connections ?? []).length, 0);
  }));

test('a Member cannot disconnect a team connection on either door', () =>
  withFixture('disconnect-member', async (f) => {
    const agent = await seedAgent(f);
    const linear = await bindAccount(f, agent.id, linearAccount('ready'));
    const member = await addMember(f, 'U33333333');
    for (const context of [mcpContext(member), slackContext(member, agent.id)]) {
      const result = await apply(f, context, `member-disconnect-${context.origin.kind}`, [{
        itemId: 'disconnect',
        kind: 'disconnect_connection',
        agentId: agent.id,
        connectionId: linear.id,
      }]);
      assert.equal(result.outcomes[0]?.disposition, 'failed', `${context.origin.kind}: ${JSON.stringify(result.outcomes)}`);
      assert.equal(result.outcomes[0]?.code, 'forbidden');
    }
    assert.equal((await f.config.listConnectionAccounts(TEAM))[0]?.lifecycle, 'ready');
  }));

test('an Owner or Admin can disconnect another member\'s personal connection, as in Admin; no one else sees it', () =>
  withFixture('disconnect-personal', async (f) => {
    const agent = await seedAgent(f);
    const member = await addMember(f, 'U77777777');
    const bystander = await addMember(f, 'U88888888');
    const personal = await bindAccount(f, agent.id, {
      ...linearAccount('ready'),
      id: 'connection_linear_member',
      ownerKind: 'member',
      ownerMembershipId: member.membership.id,
      label: 'Linear · member',
    });
    const disconnect = [{
      itemId: 'disconnect',
      kind: 'disconnect_connection' as const,
      agentId: agent.id,
      connectionId: personal.id,
    }];

    const hidden = await apply(f, mcpContext(bystander), 'bystander-disconnect', disconnect);
    assert.equal(hidden.outcomes[0]?.disposition, 'failed', JSON.stringify(hidden.outcomes));
    assert.equal(hidden.outcomes[0]?.code, 'invalid_request', 'another member\'s personal account stays private from a Member');

    for (const [admin, key] of [[f.admin, 'admin-disconnect'], [f.owner, 'owner-disconnect']] as const) {
      const bound = await bindAccount(f, agent.id, {
        ...linearAccount('ready'),
        id: `connection_linear_${key}`,
        providerId: `linear-${key}`,
        ownerKind: 'member',
        ownerMembershipId: member.membership.id,
        label: `Linear · ${key}`,
      });
      const pending = await apply(f, mcpContext(admin), key, [{ ...disconnect[0]!, connectionId: bound.id }]);
      assert.equal(pending.status, 'confirmation_required', `${key}: ${JSON.stringify(pending.outcomes)}`);
      const confirmed = await confirmChange(f, mcpContext(admin), pending.outcomes[0]!.proposalId!);
      assert.equal(confirmed.status, 'completed', `${key}: ${JSON.stringify(confirmed.outcomes)}`);
      assert.equal((await f.config.listConnectionAccounts(TEAM)).find(({ id }) => id === bound.id)?.lifecycle, 'revoked');
    }
  }));

test('disconnecting needs the right to edit the Agent, as the Agent page\'s Disconnect does', () =>
  withFixture('disconnect-uneditable', async (f) => {
    const agent = await seedAgent(f, 'creator_and_admins');
    const member = await addMember(f, 'U10101010');
    const team = await bindAccount(f, agent.id, linearAccount('ready'));
    const own = await bindAccount(f, agent.id, {
      ...linearAccount('ready'),
      id: 'connection_linear_own',
      providerId: 'linear-own',
      ownerKind: 'member',
      ownerMembershipId: member.membership.id,
      label: 'Linear · own',
    });
    for (const connection of [team, own]) {
      for (const context of [mcpContext(member), slackContext(member, agent.id)]) {
        const result = await apply(f, context, `uneditable-${connection.id}-${context.origin.kind}`, [{
          itemId: 'disconnect',
          kind: 'disconnect_connection',
          agentId: agent.id,
          connectionId: connection.id,
        }]);
        assert.equal(result.outcomes[0]?.disposition, 'failed', JSON.stringify(result.outcomes));
        assert.equal(result.outcomes[0]?.code, 'forbidden');
      }
    }
    assert.deepEqual((await f.config.listConnectionAccounts(TEAM)).map(({ lifecycle }) => lifecycle), ['ready', 'ready']);
  }));

/** A Composio provider that records each remote account it deletes, or fails every deletion while `failure` is set. */
function composioProvider() {
  const deleted: string[] = [];
  const state: { failure?: Error } = {};
  const registry = createManagedConnectionProviderRegistry([{
    id: 'composio',
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke({ policy }) {
      if (state.failure) throw state.failure;
      deleted.push(policy.accountRef);
    },
  }]);
  return { deleted, state, registry };
}

/** The service MCP and Slack get in production, on this fixture's stores. */
function liveService(f: Fixture, options: { env?: PlatformEnv; managedProviders?: ManagedConnectionProviderRegistry } = {}) {
  const { env, managedProviders } = options;
  return createLiveWorkspaceManagementService(env, {
    identity: f.identity,
    settings: f.settings,
    ...(managedProviders ? { managedProviders } : {}),
    overrides: {
      config: f.config,
      management: f.management,
      memory: f.memory,
      routines: f.routines,
      setupBaseUrl: 'http://localhost',
    },
  });
}

let removals = 0;

/** Propose a removal and confirm it as its door does: the MCP caller confirms, and on Slack the person approves. */
async function removeConnection(
  service: ReturnType<typeof liveService>,
  context: ManagementActorContext,
  agentId: string,
  connectionId: string,
) {
  const tool = (as: ManagementActorContext) =>
    (name: WorkspaceManagementToolName, args: unknown) =>
      invokeWorkspaceManagementTool({ service, resolveContext: async () => as }, name, args as never);
  const proposed = await tool(context)('apply_workspace_changes', {
    idempotencyKey: `remove-${connectionId}-${++removals}`,
    operations: [{ itemId: 'remove', kind: 'disconnect_connection', agentId, connectionId }],
  });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const pending = (proposed as { result: ManagementApplyResult }).result;
  assert.equal(pending.status, 'confirmation_required', JSON.stringify(pending.outcomes));
  const proposalId = pending.outcomes[0]!.proposalId!;
  const approver = context.origin.kind === 'slack'
    ? { ...context, origin: { ...context.origin, approvedProposalId: proposalId } }
    : context;
  return confirmThroughService(service, approver, proposalId);
}

function notionAccount(id: string, accountRef: string) {
  return {
    id,
    ownerKind: 'team' as const,
    providerId: 'notion',
    label: 'Notion · Team',
    lifecycle: 'ready' as const,
    policy: {
      kind: 'managed' as const,
      adapterId: 'composio',
      toolkit: 'notion',
      principalRef: 'chickpea:organization:test',
      accountRef,
      allowedCapabilities: ['notion.content.search'],
    },
  };
}

async function lifecycleOf(f: Fixture, connectionId: string) {
  return (await f.config.listConnectionAccounts(TEAM)).find(({ id }) => id === connectionId)?.lifecycle;
}

test('removing a managed connection that is its sign-in\'s only user deletes the remote account, over MCP and over Slack', () =>
  withFixture('remove-managed-last', async (f) => {
    const agent = await seedAgent(f);
    const composio = composioProvider();
    const service = liveService(f, { managedProviders: composio.registry });
    const hubspot = await bindAccount(f, agent.id, hubspotAccount('ready'));
    const notion = await bindAccount(f, agent.id, notionAccount('connection_notion_team', 'account_notion'));

    for (const [context, account] of [
      [mcpContext(f.owner), hubspot],
      [slackContext(f.owner, agent.id), notion],
    ] as const) {
      const removed = await removeConnection(service, context, agent.id, account.id);
      assert.equal(removed.ok, true, JSON.stringify(removed));
      const result = (removed as { result: ManagementApplyResult }).result;
      assert.equal(result.status, 'completed', `${context.origin.kind}: ${JSON.stringify(result.outcomes)}`);
      assert.equal(await lifecycleOf(f, account.id), 'revoked', context.origin.kind);
    }
    assert.deepEqual(composio.deleted, ['account_hubspot', 'account_notion']);
    const { agent: after } = await inspectAgent(f, mcpContext(f.owner), agent.id);
    assert.deepEqual(after.connections ?? [], []);
  }));

test('removing one Agent from a shared managed sign-in keeps the remote account until its last Agent is removed', () =>
  withFixture('remove-managed-shared', async (f) => {
    const ops = await seedAgent(f);
    const desk = await f.config.createAgent({
      id: 'agent_desk',
      name: 'Desk',
      instructions: 'Help the desk.',
      enabled: true,
      lifecycle: 'active',
      creatorMembershipId: f.owner.membership.id,
      editPolicy: 'all_workspace_members',
      configurationGeneration: 1,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const composio = composioProvider();
    const service = liveService(f, { managedProviders: composio.registry });
    const opsNotion = await bindAccount(f, ops.id, notionAccount('connection_notion_ops', 'account_notion_shared'));
    const policy = opsNotion.policy as ConnectionAccountManagedPolicy;
    await f.config.applySignInGroup({
      adapterId: 'composio',
      accountRef: policy.accountRef,
      members: [{ connectionAccountId: opsNotion.id, expectedRevision: opsNotion.revision }],
      shared: signInGroupPolicy(policy),
      join: {
        account: {
          id: 'connection_notion_desk',
          workspaceId: TEAM,
          ownerKind: 'team',
          createdByMembershipId: f.owner.membership.id,
          providerId: 'notion',
          label: 'Notion · Team',
          policy,
          secretRefId: 'secret_connection_notion_desk',
          lifecycle: 'ready',
        },
        binding: {
          agentId: desk.id,
          connectionAccountId: 'connection_notion_desk',
          providerId: 'notion',
          allowedCapabilities: [],
          enabled: true,
        },
      },
    });

    const first = await removeConnection(service, mcpContext(f.owner), ops.id, opsNotion.id);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal((first as { result: ManagementApplyResult }).result.status, 'completed');
    assert.equal(await lifecycleOf(f, opsNotion.id), 'revoked');
    assert.equal(await lifecycleOf(f, 'connection_notion_desk'), 'ready', 'the other Agent keeps the sign-in');
    assert.deepEqual(composio.deleted, [], 'the shared remote account is kept');

    const last = await removeConnection(service, slackContext(f.owner, desk.id), desk.id, 'connection_notion_desk');
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.equal((last as { result: ManagementApplyResult }).result.status, 'completed');
    assert.equal(await lifecycleOf(f, 'connection_notion_desk'), 'revoked');
    assert.deepEqual(composio.deleted, ['account_notion_shared'], 'its last Agent deletes it');
  }));

/** Composio as the real provider reaches it: every request, and how Composio answers a deletion. */
function composioApi(t: TestContext) {
  const requests: Array<{ method: string; url: string; key: string | null }> = [];
  const state: { answer: 'deleted' | 'refused' | 'timeout' | 'unreadable' } = { answer: 'deleted' };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ method: init?.method ?? 'GET', url: String(input), key: new Headers(init?.headers).get('x-api-key') });
    if (state.answer === 'refused') return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
    if (state.answer === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (state.answer === 'unreadable') return new Response('<html>ok</html>', { status: 200 });
    return Response.json({ success: true });
  });
  return { requests, state };
}

const deletion = (accountRef: string) =>
  `https://backend.composio.dev/api/v3.1/connected_accounts/${accountRef}?revoke_on_delete=false`;

/** A self-hosted deployment's own Composio key. */
const SELF_HOSTED_ENV: PlatformEnv = { COMPOSIO_API_KEY: 'ak_self_hosted_key' };

/** A Cloud installation: the platform's key, with the platform's preparation store. */
function cloudEnv(t: TestContext): PlatformEnv {
  configureComposioPlatformSettings(() => ({ getSetting: async () => undefined, applySettingsPatch: async () => false }));
  t.after(() => configureComposioPlatformSettings(undefined));
  return scopeInstallationEnv({
    CHICKPEA_TENANCY: 'installation',
    COMPOSIO_API_KEY: 'ak_cloud_platform_key',
    CHICKPEA_COMPOSIO_ENVIRONMENT: 'staging',
  }, { installationId: 'inst_lifecycle' });
}

type Door = 'MCP 4.x' | 'MCP 5.0' | 'Slack';
type Removal = { done: true } | { done: false; message: string; code?: string; nextStep?: string };

/** The removal each door makes, read back the way its person or client sees it. */
async function removeOver(
  door: Door,
  f: Fixture,
  service: ReturnType<typeof liveService>,
  agent: CustomAgentConfig,
  connectionId: string,
): Promise<Removal> {
  if (door === 'MCP 4.x') {
    const removed = await removeConnection(service, mcpContext(f.owner), agent.id, connectionId);
    assert.equal(removed.ok, true, JSON.stringify(removed));
    const result = (removed as { result: ManagementApplyResult }).result;
    if (result.status === 'completed') return { done: true };
    return { done: false, message: result.outcomes[0]!.instruction!, code: result.outcomes[0]!.code! };
  }
  if (door === 'MCP 5.0') {
    const principal: McpAuthenticatedPrincipal = {
      betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
      userId: f.owner.user.id,
      membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId,
      role: 'owner',
      clientId: 'connection-lifecycle-test',
    };
    const handler = createMcpHandler(
      () => createWorkspaceManagementMcpServer({ principal, service, baseUrl: 'https://chickpea.example.test' }),
      { legacy: 'stateless' },
    );
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const response = await handler.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }));
      const body = await response.text();
      const json = body.trimStart().startsWith('{')
        ? body
        : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
      return (JSON.parse(json) as { result: { structuredContent: Record<string, any>; isError?: boolean } }).result;
    };
    const proposed = await callTool('remove_connection', {
      agentId: agent.id, connectionId, idempotencyKey: `remove-${connectionId}-${++removals}`,
    });
    assert.equal(proposed.structuredContent.status, 'needs_confirmation', JSON.stringify(proposed));
    const confirmed = await callTool('confirm_change', { confirmToken: proposed.structuredContent.confirmation.confirmToken });
    if (!confirmed.isError) return { done: true };
    const { error } = confirmed.structuredContent;
    return { done: false, message: error.message, code: error.code, ...(error.nextStep ? { nextStep: error.nextStep } : {}) };
  }
  // On Slack the person's Approve click applies the change, and the host's receipt is all they see.
  const proposed = await invokeWorkspaceManagementTool({
    service,
    resolveContext: async () => slackContext(f.owner, agent.id),
  }, 'apply_workspace_changes', {
    idempotencyKey: `remove-${connectionId}-${++removals}`,
    operations: [{ itemId: 'remove', kind: 'disconnect_connection', agentId: agent.id, connectionId }],
  });
  const proposalId = (proposed as { result: ManagementApplyResult }).result.outcomes[0]!.proposalId!;
  const receipt = await executeHostSlackManagementApproval({
    turn: {
      workspaceId: TEAM,
      channelId: 'C_OPS',
      threadTs: '100.1',
      eventId: `Ev_APPROVE_${removals}`,
      messageTs: `100.${removals + 1}`,
      text: 'Approved.',
      userId: f.owner.binding.slackUserId,
      source: 'app_mention',
      contextMode: 'thread',
      uiResponse: { surfaceId: 'surface_approval', namespace: 'host', kind: 'approval', choice: 0 },
    },
    assignment: { workspaceId: TEAM, channelId: 'C_OPS', agentId: agent.id, runtimeContract: 'chickpea-v1', agent },
    turnJobId: `turn_APPROVE_${removals}`,
    proposalId,
    dependencies: { identity: f.identity, config: f.config, management: f.management, service },
  });
  assert.equal(receipt.kind, 'message', JSON.stringify(receipt));
  const { text } = receipt as { text: string };
  return text === 'Applied the approved changes.' ? { done: true } : { done: false, message: text };
}

const DOORS: readonly Door[] = ['MCP 4.x', 'MCP 5.0', 'Slack'];

async function scheduleOn(f: Fixture, agentId: string, connectionId: string) {
  await f.config.putAgentScheduleReference({
    scheduleId: `schedule_${connectionId}`,
    agentId,
    workspaceId: TEAM,
    channelId: 'C_OPS',
    createdByMembershipId: f.owner.membership.id,
    runsAsMembershipId: f.owner.membership.id,
    authorityReceiptId: `authority_${connectionId}`,
    requiredConnectionAccountIds: [connectionId],
    state: 'active',
  });
}

async function scheduleOf(f: Fixture, agentId: string, connectionId: string) {
  return (await f.config.listAgentScheduleReferences(agentId)).find(({ scheduleId }) => scheduleId === `schedule_${connectionId}`);
}

test('removing a managed connection reaches Composio with the deployment\'s own key, self-hosted and on Cloud', (t) =>
  withFixture('remove-managed-default-provider', async (f) => {
    const agent = await seedAgent(f);
    const composio = composioApi(t);
    for (const [shape, env, key] of [
      ['self_hosted', SELF_HOSTED_ENV, 'ak_self_hosted_key'],
      ['cloud', cloudEnv(t), 'ak_cloud_platform_key'],
    ] as const) {
      const account = await bindAccount(f, agent.id, notionAccount(`connection_${shape}`, `account_${shape}`));
      composio.requests.length = 0;
      const removed = await removeOver('MCP 4.x', f, liveService(f, { env }), agent, account.id);
      assert.deepEqual(removed, { done: true }, shape);
      assert.equal(await lifecycleOf(f, account.id), 'revoked', shape);
      assert.deepEqual(composio.requests, [{ method: 'DELETE', url: deletion(`account_${shape}`), key }], shape);
    }
  }));

const RETRY_WITH_NEW_KEY = 'Call remove_connection again with a new idempotencyKey, then confirm_change. Resending this call replays this result.';

// Defect caught: the Slack receipt for a removal Composio fails would carry a label's mentions and links unescaped.
test('the Slack line for a removal Composio fails escapes the connection label', (t) =>
  withFixture('remove-managed-escape', async (f) => {
    const agent = await seedAgent(f);
    const composio = composioApi(t);
    const service = liveService(f, { env: SELF_HOSTED_ENV });
    const account = await bindAccount(f, agent.id, { ...notionAccount('connection_escape', 'account_escape'), label: 'Notion <!channel> · Team' });
    composio.state.answer = 'refused';
    const removed = await removeOver('Slack', f, service, agent, account.id);
    assert.equal(removed.done, false);
    const message = (removed as { message: string }).message;
    assert.match(message, /&lt;!channel&gt;/);
    assert.doesNotMatch(message, /<!channel>/);
  }));

test('a removal Composio fails cuts the Agent off at once and says so plainly, on every door, and a retry finishes it', (t) =>
  withFixture('remove-managed-remote-fails', async (f) => {
    const agent = await seedAgent(f);
    const composio = composioApi(t);
    const service = liveService(f, { env: SELF_HOSTED_ENV });
    const plain = 'Ops no longer uses Notion · Team, but Chickpea could not remove its sign-in yet. Remove the connection again to finish.';
    const failed: string[] = [];
    for (const door of DOORS) {
      for (const answer of ['refused', 'timeout', 'unreadable'] as const) {
        const label = `${answer} on ${door}`;
        const accountRef = `account_${failed.length}`;
        const account = await bindAccount(f, agent.id, notionAccount(`connection_${failed.length}`, accountRef));
        await scheduleOn(f, agent.id, account.id);
        composio.state.answer = answer;
        composio.requests.length = 0;
        assert.deepEqual(await removeOver(door, f, service, agent, account.id), {
          done: false,
          message: plain,
          ...(door === 'Slack' ? {} : { code: door === 'MCP 4.x' ? 'removal_incomplete' : 'temporarily_unavailable' }),
          ...(door === 'MCP 5.0' ? { nextStep: RETRY_WITH_NEW_KEY } : {}),
        }, label);
        assert.deepEqual(composio.requests.map(({ method, url }) => [method, url]), [['DELETE', deletion(accountRef)]], label);
        assert.equal(await lifecycleOf(f, account.id), 'needs_attention', label);
        const schedule = await scheduleOf(f, agent.id, account.id);
        assert.equal(schedule?.state, 'needs_attention', label);
        assert.deepEqual(schedule?.connectionPauseAccountIds, [account.id], label);
        failed.push(account.id);
      }
    }

    composio.state.answer = 'deleted';
    for (const [index, door] of DOORS.entries()) {
      assert.deepEqual(await removeOver(door, f, service, agent, failed[index]!), { done: true }, `retry on ${door}`);
      assert.equal(await lifecycleOf(f, failed[index]!), 'revoked', `retry on ${door}`);
    }
  }));

test('a managed removal that fails before Composio is asked leaves the connection and its schedules as they were, on every door', () =>
  withFixture('remove-managed-no-provider', async (f) => {
    const agent = await seedAgent(f);
    const hubspot = await bindAccount(f, agent.id, hubspotAccount('ready'));
    await scheduleOn(f, agent.id, hubspot.id);
    // No Composio key anywhere: the default resolver finds no provider.
    const service = liveService(f);
    for (const door of DOORS) {
      const removed = await removeOver(door, f, service, agent, hubspot.id);
      assert.deepEqual(removed, door === 'Slack'
        ? { done: false, message: 'I couldn’t apply the approved changes (invalid_request). Nothing was changed.' }
        : {
            done: false,
            message: 'Restore the composio provider credentials before disconnecting this managed account so its remote account can also be removed.',
            code: door === 'MCP 4.x' ? 'invalid_request' : 'invalid_input',
          }, door);
      assert.equal(await lifecycleOf(f, hubspot.id), 'ready', door);
      const schedule = await scheduleOf(f, agent.id, hubspot.id);
      assert.equal(schedule?.state, 'active', door);
      assert.equal(schedule?.connectionPauseAccountIds, undefined, door);
      assert.equal((await f.config.getAgentConnectionBindingForAccount(hubspot.id))?.agentId, agent.id, door);
    }
  }));

test('tool selection applies directly and only names tools the server offers', () =>
  withFixture('tool-selection', async (f) => {
    const agent = await seedAgent(f);
    await bindAccount(f, agent.id, linearAccount('ready'));
    const { agent: before } = await inspectAgent(f, mcpContext(f.owner), agent.id);
    const linear = before.mcpServers[0]!;

    const refused = await apply(f, mcpContext(f.owner), 'unknown-tool', [{
      itemId: 'tools',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: before.revision,
      patch: { mcpServers: [{ ...linear, allowedTools: ['list_issues', 'delete_everything'] }] },
    }]);
    assert.equal(refused.outcomes[0]?.disposition, 'failed', JSON.stringify(refused.outcomes));
    assert.equal(refused.outcomes[0]?.warning,
      'Linear does not offer delete_everything. Its tools are: list_issues, create_issue.');

    const narrowed = await apply(f, mcpContext(f.owner), 'narrow-tools', [{
      itemId: 'tools',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: before.revision,
      patch: { mcpServers: [{ ...linear, allowedTools: ['list_issues'] }] },
    }]);
    assert.equal(narrowed.status, 'completed', JSON.stringify(narrowed.outcomes));
    const account = (await f.config.listConnectionAccounts(TEAM))[0]!;
    assert.deepEqual(account.policy.kind === 'mcp' ? account.policy.allowedTools : [], ['list_issues']);
  }));

test('inspect lists website logins without secrets, and removal confirms as in Admin', () =>
  withFixture('website-logins', async (f) => {
    const agent = await seedAgent(f);
    const store = f.settings;
    const deps = { store, keyring: generateCredentialKeyring('connection_lifecycle_test') };
    const team = await createWebsiteLogin(deps, {
      host: 'portal.example.com',
      label: 'Vendor portal',
      ownerKind: 'team',
      createdByMembershipId: f.owner.membership.id,
      method: 'credentials',
      username: 'ops@example.com',
      password: 'hunter2-portal-password',
      totpSeed: 'JBSWY3DPEHPK3PXP',
    });
    const member = await addMember(f, 'U44444444');
    const personal = await createWebsiteLogin(deps, {
      host: 'desk.example.com',
      label: 'Desk',
      ownerKind: 'team',
      createdByMembershipId: f.owner.membership.id,
      method: 'handoff',
    });
    await storeAsPersonalLogin(store, personal.id, member.membership.id);
    await f.config.updateAgent(agent.id, {
      websiteLogins: [
        { loginId: team.id, level: 'check', enabled: true },
        { loginId: personal.id, level: 'check', enabled: true },
      ],
    }, agent.revision);

    const { snapshot, agent: inspected } = await inspectAgent(f, mcpContext(f.owner), agent.id);
    assert.deepEqual(inspected.websiteLogins, [{
      loginId: team.id,
      host: 'portal.example.com',
      label: 'Vendor portal',
      ownerKind: 'team',
      method: 'credentials',
      username: 'ops@example.com',
      level: 'check',
      enabled: true,
    }, {
      loginId: personal.id,
      host: 'desk.example.com',
      label: 'Desk',
      ownerKind: 'team',
      method: 'handoff',
      level: 'check',
      enabled: true,
    }]);
    const raw = JSON.stringify(snapshot);
    assert.doesNotMatch(raw, /hunter2-portal-password/);
    assert.doesNotMatch(raw, /JBSWY3DPEHPK3PXP/);
    assert.match(snapshot.websiteLoginSetup ?? '', /^An Owner or Admin adds website logins in Admin/);

    // The member whose personal login it was can no longer remove it, nor a team login.
    for (const loginId of [team.id, personal.id]) {
      const memberResult = await apply(f, mcpContext(member), `member-remove-${loginId}`, [{
        itemId: 'remove',
        kind: 'remove_website_login',
        agentId: agent.id,
        loginId,
      }]);
      assert.equal(memberResult.outcomes[0]?.disposition, 'failed', JSON.stringify(memberResult.outcomes));
      assert.equal(memberResult.outcomes[0]?.code, 'forbidden');
      assert.match(JSON.stringify(memberResult.outcomes), /Only a Chickpea Owner or Admin can remove a website login\./);
    }

    const pending = await apply(f, mcpContext(f.owner), 'remove-login', [{
      itemId: 'remove',
      kind: 'remove_website_login',
      agentId: agent.id,
      loginId: team.id,
    }]);
    assert.equal(pending.status, 'confirmation_required', JSON.stringify(pending.outcomes));
    assert.match(pending.presentation?.markdown ?? '',
      /^\*\*Proposed changes\*\*\nRemove the \*\*portal\.example\.com\*\* login from \*\*Ops\*\* \(@ops\)\. If no other Agent uses it, the saved sign-in is deleted too\.\n/);
    assert.equal((await listWebsiteLogins(store)).length, 2, 'nothing applies before confirm');

    const confirmed = await confirmChange(f, mcpContext(f.owner), pending.outcomes[0]!.proposalId!);
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed.outcomes));
    assert.deepEqual((await f.config.getAgent(agent.id)).websiteLogins, [{ loginId: personal.id, level: 'check', enabled: true }]);
    assert.deepEqual((await listWebsiteLogins(store)).map(({ id }) => id), [personal.id], 'the unused login and its secret are deleted');
  }));

test('a re-point preview names only fields the caller sent', () =>
  withFixture('repoint-preview', async (f) => {
    const agent = await seedAgent(f);
    await bindAccount(f, agent.id, {
      ...linearAccount('ready'),
      id: 'connection_wiki',
      providerId: 'wiki',
      label: 'Wiki',
      policy: {
        kind: 'mcp',
        url: 'https://mcp.wiki.example/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        headerNames: [],
        discoveredTools: [{ name: 'read_page' }, { name: 'search' }],
        allowedTools: ['read_page'],
      },
    });
    const { agent: before } = await inspectAgent(f, slackContext(f.owner, agent.id), agent.id);
    const result = await apply(f, slackContext(f.owner, agent.id), 'repoint', [{
      itemId: 'repoint',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: before.revision,
      patch: { mcpServers: [{ ...before.mcpServers[0]!, url: 'https://mcp.wiki2.example/mcp' }] },
    }]);
    assert.equal(result.status, 'confirmation_required', JSON.stringify(result.outcomes));
    const preview = result.presentation?.markdown ?? '';
    assert.match(preview, /Server URL changes from/);
    assert.doesNotMatch(preview, /Discovered tools/);
  }));

test('deleting an Agent over the management door refuses a member a login, even their former personal one', () =>
  withEnv({ CHICKPEA_CREDENTIAL_KEYRING_PATH: join(mkdtempSync(join(tmpdir(), 'chickpea-keyring-')), 'keyring.json') }, () =>
  withFixture('delete-agent-login', async (f) => {
    const holder = await addMember(f, 'U66666666');
    const agent = await f.config.createAgent({
      id: 'agent_desk',
      name: 'Desk',
      instructions: 'Help.',
      enabled: true,
      lifecycle: 'active',
      creatorMembershipId: f.owner.membership.id,
      editPolicy: 'all_workspace_members',
      configurationGeneration: 1,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const login = await createWebsiteLogin({ store: f.settings, keyring: generateCredentialKeyring('delete_agent_login') }, {
      host: 'mail.example.com',
      label: 'Mail',
      ownerKind: 'team',
      createdByMembershipId: f.owner.membership.id,
      method: 'handoff',
    });
    await storeAsPersonalLogin(f.settings, login.id, holder.membership.id);
    const granted = await f.config.updateAgent(agent.id, {
      websiteLogins: [{ loginId: login.id, level: 'check', enabled: true }],
    }, agent.revision);
    const service = createLiveWorkspaceManagementService(undefined, {
      identity: f.identity,
      settings: f.settings,
      overrides: {
        config: f.config,
        management: f.management,
        memory: f.memory,
        routines: f.routines,
        setupBaseUrl: 'http://localhost',
      },
    });
    const live = (context: ManagementActorContext, name: WorkspaceManagementToolName, args: unknown) =>
      invokeWorkspaceManagementTool({ service, resolveContext: async () => context }, name, args as never);

    const proposed = await live(mcpContext(holder), 'apply_workspace_changes', {
      idempotencyKey: 'delete-desk',
      operations: [{ itemId: 'delete', kind: 'delete_agent', agentId: agent.id, expectedRevision: granted.revision }],
    });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    const proposalId = (proposed as { result: ManagementApplyResult }).result.outcomes[0]!.proposalId!;
    const refused = await confirmThroughService(service, mcpContext(holder), proposalId);
    assert.match(JSON.stringify(refused),
      /"code":"forbidden".*This Agent uses a website login you can't remove\. Ask an Owner or Admin to remove it first\./);
    assert.equal((await f.config.getAgent(agent.id)).websiteLogins?.length, 1, 'the Agent is kept');
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), [login.id]);
  })));
