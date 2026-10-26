import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  connectionAccountSecretSettingKey,
  saveConnectionAccountSecret,
} from '../src/config/connector-secrets.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import type { ConnectionAccount, CustomAgentConfig } from '../src/config/types.ts';
import { resolveEffectiveConnectionAccounts } from '../src/connections/runtime.ts';
import type { ManagementApiConnection, ManagementMcpConnection } from '../src/management/agent-connections.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import {
  invokeWorkspaceManagementTool,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolName,
} from '../src/management/tool-adapter.ts';
import type {
  ManagementApplyResult,
  ManagementOperation,
  ManagementWorkspaceSnapshot,
} from '../src/management/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;

const TEAM = 'T_TEST';
const TOKEN = 'connection-accounts-token';

const billing: ManagementApiConnection = {
  id: 'billing',
  displayName: 'Billing',
  allowedHosts: ['billing.example.test'],
  pathPrefixes: ['/v1'],
  headerName: 'Authorization',
  headerValuePrefix: 'Bearer ',
  allowedMethods: ['GET'],
  enabled: true,
  authMode: 'credential',
};

const tracker: ManagementMcpConnection = {
  id: 'tracker',
  displayName: 'Tracker',
  url: 'https://mcp.tracker.example/mcp',
  transport: 'streamable-http',
  authMode: 'none',
  headerNames: [],
  enabled: true,
  allowedTools: ['search'],
};

async function withFixture(suffix: string, run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await createManagementAdapterFixture(suffix, {}, { teamId: TEAM });
  try {
    await run(f);
  } finally {
    f.close();
  }
}

async function mcpTool<TName extends WorkspaceManagementToolName>(
  f: Fixture,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<unknown> {
  const response = await invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => ({
      userId: f.owner.user.id,
      membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'connection-accounts-test' },
    }),
  }, name, args);
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: unknown }).result;
}

async function apply(f: Fixture, idempotencyKey: string, operations: ManagementOperation[]) {
  return await mcpTool(f, 'apply_workspace_changes', { idempotencyKey, operations }) as ManagementApplyResult;
}

async function inspectAgent(f: Fixture, agentId: string) {
  const snapshot = await mcpTool(f, 'inspect_workspace', {}) as ManagementWorkspaceSnapshot;
  const agent = snapshot.agents.find(({ id }) => id === agentId);
  assert.ok(agent, `inspection lists ${agentId}`);
  return agent;
}

async function seedAgent(f: Fixture): Promise<CustomAgentConfig> {
  await f.config.ensureWorkspaceInstallation({
    workspaceId: TEAM,
    teamId: TEAM,
    transportMode: 'gateway',
    appId: 'A_TEST',
    botUserId: 'U_BOT',
    gatewayBindingId: 'binding_test',
  });
  return f.config.createAgent({
    id: 'agent_ops',
    name: 'Ops',
    instructions: 'Help the team.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: f.owner.membership.id,
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
}

function adminApp(f: Fixture): Hono {
  const principal: AuthPrincipal = {
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    authenticatorKind: 'test_slack_session',
    credentialId: 'session_connection_accounts',
    correlationId: 'request_connection_accounts',
    machine: false,
  };
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: f.config,
    settings: f.settings,
    management: new SqliteManagementStore(':memory:'),
    snapshots: { listLiveRootsByAgent: async () => [] } as unknown as AgentSnapshotStore,
    knownProviders: new Set(['local-stub']),
    ...testAdminAuthority(TOKEN, undefined, f.identity, principal),
  }));
  return app;
}

async function adminAttached(app: Hono, agentId: string): Promise<Array<{ account: ConnectionAccount }>> {
  const response = await app.request(
    `http://localhost/admin/api/agents/${agentId}/connections?workspaceId=${TEAM}`,
    { headers: testAdminHeaders(TOKEN) },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { attached: Array<{ account: ConnectionAccount }> }).attached;
}

async function accountFor(f: Fixture, agentId: string, providerId: string): Promise<ConnectionAccount> {
  const bindings = await f.config.listAgentConnectionBindings(agentId);
  const account = (await f.config.listConnectionAccounts(TEAM)).find((candidate) =>
    candidate.providerId === providerId && bindings.some(({ connectionAccountId }) => connectionAccountId === candidate.id));
  assert.ok(account, `${providerId} is a connection account bound to ${agentId}`);
  return account;
}

function planFor(agent: CustomAgentConfig, effectiveConnections: Awaited<ReturnType<typeof resolveEffectiveConnectionAccounts>>) {
  return compileRuntimePlanV2({
    turn: {
      workspaceId: TEAM,
      channelId: 'C_OPS',
      eventId: 'E_OPS',
      text: 'Check the invoices.',
      userId: 'U12345678',
      messageTs: '1783000000.000200',
      threadTs: '1783000000.000100',
      source: 'app_mention',
      contextMode: 'thread',
    },
    assignment: {
      workspaceId: TEAM,
      channelId: 'C_OPS',
      agentId: agent.id,
      agent,
      model: 'openai/gpt-5.4-mini',
      modelAttribution: { source: 'workspace_default', providerId: 'openai', workspaceDefaultRevision: 1 },
    },
    instructions: agent.instructions,
    memoryEpoch: 1,
    effectiveConnections,
  });
}

test('an API connection added over MCP is an Admin connection account that reaches the runtime plan', () =>
  withFixture('accounts-api', async (f) => {
    const agent = await seedAgent(f);
    const result = await apply(f, 'add-billing', [{
      itemId: 'add',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { apiConnections: [billing] },
    }]);
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), ['applied'], JSON.stringify(result));

    const inspected = await inspectAgent(f, agent.id);
    assert.deepEqual(inspected.apiConnections, [billing]);
    assert.deepEqual(inspected.connectionStatus.map(({ id, lifecycleStatus }) => [id, lifecycleStatus]),
      [['billing', 'pending']]);
    const attached = await adminAttached(adminApp(f), agent.id);
    assert.deepEqual(attached.map(({ account }) => [account.label, account.lifecycle, account.ownerKind]),
      [['Billing', 'pending', 'team']]);

    // The setup link stores the credential in the account and marks it ready.
    const account = await accountFor(f, agent.id, 'billing');
    await saveConnectionAccountSecret(account.secretRefId, 'sk-billing', undefined, f.settings);
    await f.config.putConnectionAccount({ ...account, lifecycle: 'ready' }, account.revision);

    const effective = await resolveEffectiveConnectionAccounts({
      config: f.config,
      workspaceId: TEAM,
      agentId: agent.id,
      actorMembershipId: f.owner.membership.id,
    });
    const plan = planFor(await f.config.getAgent(agent.id), effective);
    assert.deepEqual(plan.apiConnections.map(({ allowedHosts, allowedMethods }) => ({ allowedHosts, allowedMethods })),
      [{ allowedHosts: ['billing.example.test'], allowedMethods: ['GET'] }]);
  }));

test('an MCP server added over MCP appears in Admin, and Admin can remove it', () =>
  withFixture('accounts-mcp', async (f) => {
    const agent = await seedAgent(f);
    const result = await apply(f, 'add-tracker', [{
      itemId: 'add',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { mcpServers: [tracker] },
    }]);
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), ['applied'], JSON.stringify(result));
    assert.deepEqual((await f.config.getAgent(agent.id)).mcpServers, [], 'nothing is written to the legacy Agent row');

    const app = adminApp(f);
    const attached = await adminAttached(app, agent.id);
    assert.deepEqual(attached.map(({ account }) => [account.label, account.lifecycle]), [['Tracker', 'ready']]);
    const effective = await resolveEffectiveConnectionAccounts({
      config: f.config,
      workspaceId: TEAM,
      agentId: agent.id,
      actorMembershipId: f.owner.membership.id,
    });
    assert.deepEqual(planFor(agent, effective).mcpConnections.map(({ url }) => url), [tracker.url]);

    const removed = await app.request(
      `http://localhost/admin/api/agents/${agent.id}/connections/${attached[0]!.account.id}`,
      { method: 'DELETE', headers: testAdminHeaders(TOKEN) },
    );
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.deepEqual(await adminAttached(app, agent.id), []);
    assert.deepEqual((await inspectAgent(f, agent.id)).mcpServers, []);
  }));

test('a management edit that changes or removes a connection retires its credential', () =>
  withFixture('accounts-retire', async (f) => {
    const agent = await seedAgent(f);
    await apply(f, 'add-billing', [{
      itemId: 'add',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { apiConnections: [billing] },
    }]);
    const account = await accountFor(f, agent.id, 'billing');
    await saveConnectionAccountSecret(account.secretRefId, 'sk-billing', undefined, f.settings);
    await f.config.putConnectionAccount({ ...account, lifecycle: 'ready' }, account.revision);
    const secretKey = connectionAccountSecretSettingKey(account.secretRefId);

    const renamed = await inspectAgent(f, agent.id);
    await apply(f, 'rename-billing', [{
      itemId: 'rename',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: renamed.revision,
      patch: { apiConnections: [{ ...billing, displayName: 'Invoices' }] },
    }]);
    assert.equal(await f.settings.getSetting(secretKey), 'sk-billing', 'a rename keeps the credential');
    assert.equal((await accountFor(f, agent.id, 'billing')).lifecycle, 'ready');

    const moved = await inspectAgent(f, agent.id);
    await apply(f, 'move-billing', [{
      itemId: 'move',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: moved.revision,
      patch: { apiConnections: [{ ...billing, displayName: 'Invoices', allowedHosts: ['invoices.example.test'] }] },
    }]);
    assert.equal(await f.settings.getSetting(secretKey), undefined, 'a new host retires the credential');
    assert.equal((await accountFor(f, agent.id, 'billing')).lifecycle, 'pending');

    await saveConnectionAccountSecret(account.secretRefId, 'sk-invoices', undefined, f.settings);
    const current = await inspectAgent(f, agent.id);
    const pending = await apply(f, 'remove-billing', [{
      itemId: 'remove',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: current.revision,
      patch: { apiConnections: [] },
    }]);
    assert.equal(pending.status, 'confirmation_required', 'removing a connection asks first over MCP');
    const confirmed = await mcpTool(f, 'confirm_workspace_change', {
      proposalId: pending.outcomes[0]!.proposalId!,
    }) as ManagementApplyResult;
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed.outcomes));
    assert.equal(await f.settings.getSetting(secretKey), undefined, 'removal retires the credential');
    const revoked = (await f.config.listConnectionAccounts(TEAM)).find(({ id }) => id === account.id);
    assert.equal(revoked?.lifecycle, 'revoked');
    assert.deepEqual((await inspectAgent(f, agent.id)).apiConnections, []);
  }));
