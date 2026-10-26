import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWebsiteLogin, listWebsiteLogins } from '../src/browser/logins.ts';
import type { ConnectionAccount, CustomAgentConfig } from '../src/config/types.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
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
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

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
    assert.equal(viaMcp.handoffUrl, `http://localhost/admin/agents/${agent.id}`,
      'MCP sends the person to the Agent page, whose Reconnect keeps the account');

    const accounts = await f.config.listConnectionAccounts(TEAM);
    assert.equal(accounts.length, 2, 'no account was minted');
    const bindings = await f.config.listAgentConnectionBindings(agent.id);
    assert.deepEqual(bindings.map(({ connectionAccountId }) => connectionAccountId).sort(), [hubspot.id, linear.id].sort());
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

    const refused = await callRaw(f, context, 'prepare_connector_setup', { connector: 'HubSpot', ownerKind: 'team' });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.ok === false ? refused.error.code : undefined, 'setup_unavailable');
    assert.equal(refused.ok === false ? refused.error.message : undefined,
      'HubSpot sign-in is not configured for this Chickpea deployment yet.');

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

    const confirmed = await call(f, mcpContext(f.owner), 'confirm_workspace_change', {
      proposalId: pending.outcomes[0]!.proposalId!,
    }) as ManagementApplyResult;
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
      const confirmed = await call(f, mcpContext(admin), 'confirm_workspace_change', {
        proposalId: pending.outcomes[0]!.proposalId!,
      }) as ManagementApplyResult;
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
    await f.config.updateAgent(agent.id, {
      websiteLogins: [{ loginId: team.id, level: 'check', enabled: true }],
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
    }]);
    const raw = JSON.stringify(snapshot);
    assert.doesNotMatch(raw, /hunter2-portal-password/);
    assert.doesNotMatch(raw, /JBSWY3DPEHPK3PXP/);
    assert.match(snapshot.websiteLoginSetup ?? '', /Admin/);

    const member = await addMember(f, 'U44444444');
    const memberResult = await apply(f, mcpContext(member), 'member-remove-login', [{
      itemId: 'remove',
      kind: 'remove_website_login',
      agentId: agent.id,
      loginId: team.id,
    }]);
    assert.equal(memberResult.outcomes[0]?.disposition, 'failed', JSON.stringify(memberResult.outcomes));
    assert.equal(memberResult.outcomes[0]?.code, 'forbidden');

    const pending = await apply(f, mcpContext(f.owner), 'remove-login', [{
      itemId: 'remove',
      kind: 'remove_website_login',
      agentId: agent.id,
      loginId: team.id,
    }]);
    assert.equal(pending.status, 'confirmation_required', JSON.stringify(pending.outcomes));
    assert.match(pending.presentation?.markdown ?? '',
      /^\*\*Proposed changes\*\*\nRemove the \*\*portal\.example\.com\*\* login from \*\*Ops\*\* \(@ops\)\. If no other Agent uses it, the saved sign-in is deleted too\.\n/);
    assert.equal((await listWebsiteLogins(store)).length, 1, 'nothing applies before confirm');

    const confirmed = await call(f, mcpContext(f.owner), 'confirm_workspace_change', {
      proposalId: pending.outcomes[0]!.proposalId!,
    }) as ManagementApplyResult;
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed.outcomes));
    assert.deepEqual((await f.config.getAgent(agent.id)).websiteLogins, []);
    assert.deepEqual(await listWebsiteLogins(store), [], 'the unused login and its secret are deleted');
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
