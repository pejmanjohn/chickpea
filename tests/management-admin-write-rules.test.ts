import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { BUGSNAG_MCP_SERVER_URL } from '../src/config/bugsnag-policy.ts';
import { apiOAuthSettingKeys, connectionAccountOAuthRef } from '../src/config/api-oauth.ts';
import { agentCredentialConfigurationBinding } from '../src/config/connection-credential-binding.ts';
import { mcpOAuthSettingKeys } from '../src/config/mcp-oauth.ts';
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
import {
  AgentWriteRuleError,
  type ManagementApplyResult,
  type ManagementOperation,
  type ManagementWorkspaceSnapshot,
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

test('an API connection added over MCP leaves the Agent saveable in Admin and takes its key there', () =>
  withFixture('accounts-admin-key', async (f) => {
    const agent = await seedAgent(f);
    await f.config.putWorkspaceModelDefault({
      workspaceId: TEAM,
      modelId: 'local-stub/workspace',
      provenance: 'admin_selected',
      lastChangedByMembershipId: f.owner.membership.id,
    }, (await f.config.getWorkspaceModelDefault(TEAM))?.revision);
    const smoke: ManagementApiConnection = {
      ...billing, id: 'api_smoke_example', displayName: 'Smoke example', allowedHosts: ['smoke.example.test'],
    };
    const result = await apply(f, 'add-smoke', [{
      itemId: 'add',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { apiConnections: [smoke] },
    }]);
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), ['applied'], JSON.stringify(result));

    const app = adminApp(f);
    const headers = testAdminHeaders(TOKEN, { 'content-type': 'application/json' });
    const current = await f.config.getAgent(agent.id);
    const saved = await app.request(`http://localhost/admin/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        expectedRevision: current.revision,
        credentialConfigurationBinding: agentCredentialConfigurationBinding(current.credentialIncarnation),
        instructions: 'Help the team with smoke checks.',
      }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());

    const [entry] = await adminAttached(app, agent.id);
    assert.deepEqual([entry?.account.label, entry?.account.lifecycle], ['Smoke example', 'pending']);
    const keyed = await app.request(`http://localhost/admin/api/agents/${agent.id}/connections/${entry!.account.id}/credential`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expectedRevision: entry!.account.revision, credential: 'sk-smoke' }),
    });
    assert.equal(keyed.status, 200, await keyed.clone().text());
    assert.deepEqual((await adminAttached(app, agent.id)).map(({ account }) => account.lifecycle), ['ready']);
    const account = await accountFor(f, agent.id, entry!.account.providerId);
    assert.equal(await f.settings.getSetting(connectionAccountSecretSettingKey(account.secretRefId)), 'sk-smoke');

    const effective = await resolveEffectiveConnectionAccounts({
      config: f.config,
      workspaceId: TEAM,
      agentId: agent.id,
      actorMembershipId: f.owner.membership.id,
    });
    assert.deepEqual(planFor(await f.config.getAgent(agent.id), effective).apiConnections.map(({ allowedHosts }) => allowedHosts),
      [['smoke.example.test']]);
  }));

const skill ={ name: 'triage', description: 'Triage new issues.', instructions: 'Sort by severity.', enabled: true };
const adminMcp = { lifecycleStatus: 'pending', statusText: '', discoveredTools: [] };

/** One bad input, written the way each door takes it. */
const REFUSED_WRITES: Array<{ name: string; admin: Record<string, unknown>; management: Record<string, unknown> }> = [
  { name: 'a skill name Flue rejects', admin: { skills: [{ ...skill, name: 'Bad Name' }] },
    management: { skills: [{ ...skill, name: 'Bad Name' }] } },
  { name: 'two skills with one name', admin: { skills: [skill, skill] }, management: { skills: [skill, skill] } },
  { name: 'a skill without instructions', admin: { skills: [{ ...skill, instructions: '   ' }] },
    management: { skills: [{ ...skill, instructions: '   ' }] } },
  { name: 'an MCP server on a private address', admin: {
    mcpServers: [{ ...tracker, ...adminMcp, url: 'https://10.0.0.1/mcp' }],
  }, management: { mcpServers: [{ ...tracker, url: 'https://10.0.0.1/mcp' }] } },
  { name: 'an MCP connector whose tools need review', admin: {
    mcpServers: [{ ...tracker, ...adminMcp, url: BUGSNAG_MCP_SERVER_URL, authMode: 'oauth' }],
  }, management: { mcpServers: [{ ...tracker, url: BUGSNAG_MCP_SERVER_URL, authMode: 'oauth' }] } },
  { name: 'an API host on a private address', admin: { apiConnections: [{ ...billing, allowedHosts: ['10.0.0.1'] }] },
    management: { apiConnections: [{ ...billing, allowedHosts: ['10.0.0.1'] }] } },
  { name: 'the GitHub API host', admin: { apiConnections: [{ ...billing, allowedHosts: ['api.github.com'] }] },
    management: { apiConnections: [{ ...billing, allowedHosts: ['api.github.com'] }] } },
  { name: 'a path prefix with a query', admin: { apiConnections: [{ ...billing, pathPrefixes: ['/v1?all=1'] }] },
    management: { apiConnections: [{ ...billing, pathPrefixes: ['/v1?all=1'] }] } },
  { name: 'two API connections with one id', admin: {
    apiConnections: [billing, { ...billing, allowedHosts: ['other.example.test'] }],
  }, management: { apiConnections: [billing, { ...billing, allowedHosts: ['other.example.test'] }] } },
  { name: 'API connections that overlap', admin: {
    apiConnections: [billing, { ...billing, id: 'billing-admin', pathPrefixes: ['/v1/admin'] }],
  }, management: { apiConnections: [billing, { ...billing, id: 'billing-admin', pathPrefixes: ['/v1/admin'] }] } },
];

test('management refuses every Agent write Admin refuses', () =>
  withFixture('write-rules', async (f) => {
    const agent = await seedAgent(f);
    const app = adminApp(f);
    for (const write of REFUSED_WRITES) {
      const adminResponse = await app.request(`http://localhost/admin/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: testAdminHeaders(TOKEN, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          expectedRevision: agent.revision,
          credentialConfigurationBinding: agentCredentialConfigurationBinding(agent.credentialIncarnation),
          ...write.admin,
        }),
      });
      assert.equal(adminResponse.status, 400, `Admin refuses ${write.name}: ${await adminResponse.text()}`);
      const refusal = await f.service.applyWorkspaceChanges({
        context: {
          userId: f.owner.user.id,
          membershipId: f.owner.membership.id,
          organizationId: f.owner.membership.organizationId,
          origin: { kind: 'mcp', clientId: 'write-rules-test' },
        },
        idempotencyKey: `refused-${write.name}`,
        operations: [{
          itemId: 'edit',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: agent.revision,
          patch: write.management,
        } as ManagementOperation],
      }).then(
        (result) => 'outcomes' in result && result.outcomes[0]?.disposition === 'failed'
          ? result.outcomes[0].warning
          : undefined,
        (error: unknown) => error instanceof AgentWriteRuleError ? error.message : undefined,
      );
      assert.ok(refusal, `management refuses ${write.name} and says why`);
    }
    assert.equal((await f.config.getAgent(agent.id)).revision, agent.revision, 'nothing was written');
  }));

test('management will not delete an Agent a recent Slack thread still uses', () =>
  withFixture('write-rules-delete', async (f) => {
    const agent = await seedAgent(f);
    const pending = await apply(f, 'delete-ops', [{
      itemId: 'delete',
      kind: 'delete_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
    }]);
    assert.equal(pending.outcomes[0]?.disposition, 'failed', JSON.stringify(pending.outcomes));
    assert.match(pending.outcomes[0]?.warning ?? '', /used in a Slack thread in the last 30 days/);
    assert.equal((await f.config.getAgent(agent.id)).id, agent.id, 'the Agent is still there');
  }, { agentLiveThreadCount: async () => 1 }));

test('a Member adds a personal connection and cannot change a team one, as in Admin', () =>
  withFixture('write-rules-member', async (f) => {
    const seeded = await seedAgent(f);
    const agent = await f.config.updateAgent(seeded.id, { editPolicy: 'all_workspace_members' }, seeded.revision);
    await apply(f, 'team-billing', [{
      itemId: 'add',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { apiConnections: [billing] },
    }]);
    const member = (await f.identity.provisionSlackMember({
      slackTeamId: TEAM,
      slackUserId: 'U11223344',
      displayName: 'Member',
    })).resolution;
    const asMember = async (idempotencyKey: string, patch: Record<string, unknown>) =>
      f.service.applyWorkspaceChanges({
        context: {
          userId: member.user.id,
          membershipId: member.membership.id,
          organizationId: member.membership.organizationId,
          origin: { kind: 'mcp', clientId: 'write-rules-member' },
        },
        idempotencyKey,
        operations: [{
          itemId: 'edit',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: (await f.config.getAgent(agent.id)).revision,
          patch,
        } as ManagementOperation],
      });

    const before = await f.config.getAgent(agent.id);
    const refused = await asMember('member-rename', { apiConnections: [{ ...billing, displayName: 'Invoices' }] });
    assert.equal('outcomes' in refused ? refused.outcomes[0]?.code : undefined, 'forbidden', JSON.stringify(refused));
    assert.equal((await f.config.getAgent(agent.id)).revision, before.revision, 'nothing was written');

    const added = await asMember('member-tracker', { apiConnections: [billing], mcpServers: [tracker] });
    assert.equal('outcomes' in added ? added.outcomes[0]?.disposition : undefined, 'applied', JSON.stringify(added));
    const personal = await accountFor(f, agent.id, 'tracker');
    assert.deepEqual([personal.ownerKind, personal.ownerMembershipId], ['member', member.membership.id]);
  }));

test('Admin-made connections round-trip through management: a reviewed connector renames but keeps its tools', () =>
  withFixture('write-rules-admin-shapes', async (f) => {
    const agent = await seedAgent(f);
    const bind = (id: string, providerId: string, label: string, policy: ConnectionAccount['policy']) =>
      f.config.createAgentOwnedConnection({
        account: {
          id, workspaceId: TEAM, ownerKind: 'team', createdByMembershipId: f.owner.membership.id,
          providerId, label, policy, secretRefId: `secret_${providerId}`, lifecycle: 'ready',
        },
        binding: {
          agentId: agent.id, connectionAccountId: id, providerId, allowedCapabilities: [], enabled: true,
        },
      });
    await bind('connection_bugsnag', 'bugsnag', 'Bugsnag', {
      kind: 'mcp', url: BUGSNAG_MCP_SERVER_URL, transport: 'streamable-http', authMode: 'oauth', headerNames: [],
      oauthScope: 'api', toolAccessMode: 'review', discoveredTools: [{ name: 'list_errors' }, { name: 'delete_project' }],
      allowedTools: ['list_errors'],
    });
    await bind('connection_keyed', 'keyed', 'Keyed', {
      kind: 'mcp', url: 'https://mcp.keyed.example/mcp', transport: 'streamable-http', authMode: 'bearer',
      headerNames: ['X-Api-Key'], credentialHeaderName: 'X-Api-Key', discoveredTools: [{ name: 'search' }],
      allowedTools: ['search'],
    });
    const edit = async (idempotencyKey: string, mcpServers: ManagementMcpConnection[]) => {
      const current = await inspectAgent(f, agent.id);
      return apply(f, idempotencyKey, [{
        itemId: 'edit', kind: 'update_agent', agentId: agent.id, expectedRevision: current.revision, patch: { mcpServers },
      }]);
    };

    const inspected = (await inspectAgent(f, agent.id)).mcpServers;
    const renamed = await edit('rename', inspected.map((connection) =>
      connection.id === 'bugsnag' ? { ...connection, displayName: 'Errors' } : connection));
    assert.deepEqual(renamed.outcomes.map(({ disposition }) => disposition), ['applied'], JSON.stringify(renamed));
    assert.equal((await accountFor(f, agent.id, 'bugsnag')).label, 'Errors');
    assert.equal((await accountFor(f, agent.id, 'keyed')).lifecycle, 'ready', 'a bearer account with a header round-trips');

    const widened = await edit('widen', (await inspectAgent(f, agent.id)).mcpServers.map((connection) =>
      connection.id === 'bugsnag' ? { ...connection, allowedTools: ['list_errors', 'delete_project'] } : connection));
    assert.equal(widened.outcomes[0]?.disposition, 'failed', JSON.stringify(widened.outcomes));
    const bugsnag = await accountFor(f, agent.id, 'bugsnag');
    assert.deepEqual(bugsnag.policy.kind === 'mcp' ? bugsnag.policy.allowedTools : undefined, ['list_errors'],
      'tools change only through Admin\'s review');
  }));

const OAUTH_TOKENS = '{"refreshToken":"rt-secret"}';

/** An Agent with one MCP and one API account that signed in with OAuth, each holding stored tokens. */
async function seedOauthAccounts(f: Fixture, agent: CustomAgentConfig): Promise<{ keys: string[]; ids: string[] }> {
  const bind = (id: string, providerId: string, label: string, policy: ConnectionAccount['policy']) =>
    f.config.createAgentOwnedConnection({
      account: {
        id, workspaceId: TEAM, ownerKind: 'team', createdByMembershipId: f.owner.membership.id,
        providerId, label, policy, secretRefId: `secret_${providerId}`, lifecycle: 'ready',
      },
      binding: {
        agentId: agent.id, connectionAccountId: id, providerId, allowedCapabilities: [], enabled: true,
      },
    });
  await bind('connection_docs', 'docs', 'Docs', {
    kind: 'mcp', url: 'https://mcp.docs.example/mcp', transport: 'streamable-http', authMode: 'oauth',
    headerNames: [], discoveredTools: [{ name: 'search' }], allowedTools: ['search'],
  });
  await bind('connection_calendar', 'calendar', 'Calendar', {
    kind: 'api', allowedHosts: ['www.googleapis.com'], pathPrefixes: ['/calendar/v3'], headerName: 'Authorization',
    headerValuePrefix: 'Bearer ', allowedMethods: ['GET'], authMode: 'oauth', oauthProvider: 'google',
    oauthScopes: ['https://www.googleapis.com/auth/calendar.readonly'], oauthAppType: 'external',
  });
  const keys = [
    ...mcpOAuthSettingKeys(connectionAccountOAuthRef('connection_docs')),
    ...apiOAuthSettingKeys(connectionAccountOAuthRef('connection_calendar')),
  ];
  for (const key of keys) await f.settings.setSetting(key, OAUTH_TOKENS);
  return { keys, ids: ['connection_docs', 'connection_calendar'] };
}

async function confirmed(f: Fixture, pending: ManagementApplyResult): Promise<ManagementApplyResult> {
  assert.equal(pending.status, 'confirmation_required', JSON.stringify(pending.outcomes));
  const result = await mcpTool(f, 'confirm_workspace_change', {
    proposalId: pending.outcomes[0]!.proposalId!,
  }) as ManagementApplyResult;
  assert.equal(result.status, 'completed', JSON.stringify(result.outcomes));
  return result;
}

test('removing OAuth connections over MCP deletes their stored tokens', () =>
  withFixture('accounts-oauth-remove', async (f) => {
    const agent = await seedAgent(f);
    const { keys, ids } = await seedOauthAccounts(f, agent);
    const current = await inspectAgent(f, agent.id);
    await confirmed(f, await apply(f, 'remove-oauth', [{
      itemId: 'remove',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: current.revision,
      patch: { mcpServers: [], apiConnections: [] },
    }]));
    assert.deepEqual(
      (await f.config.listConnectionAccounts(TEAM)).filter(({ id }) => ids.includes(id)).map(({ lifecycle }) => lifecycle),
      ['revoked', 'revoked'],
    );
    assert.deepEqual(await f.settings.getSettings(keys), keys.map(() => undefined),
      'no OAuth setting survives the removal');
  }));

test('deleting an Agent deletes its connections\' stored tokens', () =>
  withFixture('accounts-oauth-delete', async (f) => {
    const seeded = await seedAgent(f);
    const { keys } = await seedOauthAccounts(f, seeded);
    const agent = await f.config.getAgent(seeded.id);
    const deleted = await adminApp(f).request(`http://localhost/admin/api/agents/${agent.id}`, {
      method: 'DELETE',
      headers: testAdminHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        expectedRevision: agent.revision,
        credentialConfigurationBinding: agentCredentialConfigurationBinding(agent.credentialIncarnation),
      }),
    });
    assert.equal(deleted.status, 204, await deleted.clone().text());
    await assert.rejects(f.config.getAgent(agent.id));
    assert.deepEqual(await f.settings.getSettings(keys), keys.map(() => undefined),
      'no OAuth setting survives the deletion');
  }));

test('a Member cannot ask for a setup link on a team connection, as Admin refuses them its setup', async () => {
  const management = new SqliteManagementStore(':memory:');
  let issued = 0;
  const putSetup = management.putSetup.bind(management);
  management.putSetup = (input) => {
    issued += 1;
    return putSetup(input);
  };
  try {
    await withFixture('write-rules-member-setup', async (f) => {
      const seeded = await seedAgent(f);
      const agent = await f.config.updateAgent(seeded.id, { editPolicy: 'all_workspace_members' }, seeded.revision);
      await apply(f, 'team-billing', [{
        itemId: 'add',
        kind: 'update_agent',
        agentId: agent.id,
        expectedRevision: agent.revision,
        patch: { apiConnections: [billing] },
      }]);
      const member = (await f.identity.provisionSlackMember({
        slackTeamId: TEAM,
        slackUserId: 'U11223344',
        displayName: 'Member',
      })).resolution;
      const asMember = (operation: ManagementOperation) => f.service.applyWorkspaceChanges({
        context: {
          userId: member.user.id,
          membershipId: member.membership.id,
          organizationId: member.membership.organizationId,
          origin: { kind: 'mcp', clientId: 'write-rules-member-setup' },
        },
        idempotencyKey: 'member-setup',
        operations: [operation],
      });
      const request: ManagementOperation = {
        itemId: 'setup',
        kind: 'request_setup',
        target: { kind: 'api_connection', agentId: agent.id, connectionId: 'billing' },
      };

      const refusal = await asMember(request).then(
        (result) => JSON.stringify(result),
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      assert.match(refusal, /Only a Chickpea Admin can change or remove a team connection\./);
      assert.equal(issued, 0, 'no setup record was issued');
    }, { management });
  } finally {
    management.close();
  }
});
