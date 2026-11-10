import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { createWebsiteLogin } from '../src/browser/logins.ts';
import type { ConnectionAccount } from '../src/config/types.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import type { PrepareConnectorSetupResult } from '../src/management/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  createFixtureAgent,
  createManagementAdapterFixture,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';

/**
 * U3b-2: the 5.0 connection and removal tools, through the MCP door. Each
 * call goes through createWorkspaceManagementMcpServer as a client would.
 */

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown> & { error?: Record<string, unknown> };
  isError?: boolean;
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
type Person = 'owner' | 'admin';
type Overrides = Partial<WorkspaceManagementServiceInput>;

async function harness(t: TestContext, suffix: string, options: { member?: boolean; overrides?: Overrides } = {}) {
  const f = await createManagementAdapterFixture(suffix, options.overrides ?? {});
  t.after(() => f.close());
  if (options.member) {
    await f.identity.updateMembershipAuthority({
      membershipId: f.admin.membership.id,
      role: 'member',
      actorMembershipId: f.owner.membership.id,
      correlationId: `${suffix}-demotion`,
      authenticationSurface: 'better_auth',
      reasonCode: 'mcp_v5_test',
    });
  }
  const as = (who: Person, clientId = `client_${suffix}`): Call => {
    const person = who === 'owner' ? f.owner : f.admin;
    const principal: McpAuthenticatedPrincipal = {
      betterAuthUserId: person.binding.betterAuthUserId ?? `ba_${who}`,
      userId: person.user.id,
      membershipId: person.membership.id,
      organizationId: person.membership.organizationId,
      role: who === 'owner' ? 'owner' : options.member ? 'member' : 'admin',
      clientId,
    };
    const handler = createMcpHandler(
      () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: 'https://chickpea.example.test' }),
      { legacy: 'stateless' },
    );
    return async (name, args = {}) => {
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
      assert.equal(response.status, 200, body);
      const json = body.trimStart().startsWith('{')
        ? body
        : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
      return (JSON.parse(json) as { result: ToolResult }).result;
    };
  };
  return { f, as, call: as('owner'), teamId: f.owner.binding.slackTeamId };
}

function structured(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent;
}

function errorOf(result: ToolResult, code: string): Record<string, any> {
  assert.equal(result.isError, true, JSON.stringify(result));
  const error = result.structuredContent?.error;
  assert.ok(error, JSON.stringify(result));
  assert.equal(error.code, code, JSON.stringify(error));
  return error;
}

function assertNoInternalIds(serialized: string, f: ManagementAdapterFixture): void {
  for (const forbidden of [
    f.owner.membership.organizationId, f.owner.membership.id, f.owner.user.id, f.admin.membership.id, f.admin.user.id,
    '"revision"', 'membershipId', 'organizationId', 'proposalId', 'operationId',
    'confirm_workspace_change', 'apply_workspace_changes', 'prepare_connector_setup',
  ]) assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked: ${serialized}`);
}

async function version(call: Call, agentId: string): Promise<string> {
  return structured(await call('get_agent', { agentId })).version;
}

async function grantChannel(f: ManagementAdapterFixture, teamId: string, agentId: string, channelId = 'C_SUPPORT') {
  await f.config.putChannel({ workspaceId: teamId, channelId, label: channelId.slice(2).toLowerCase(), lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId, agentId, status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: channelId.slice(2).toLowerCase(),
  });
}

/** A team HubSpot sign-in bound to the Agent, as Admin's catalog connect leaves it. */
async function bindTeamHubspot(f: ManagementAdapterFixture, teamId: string, agentId: string, providerId = 'hubspot') {
  const account = await f.config.putConnectionAccount({
    id: 'connection_hubspot_team', workspaceId: teamId, ownerKind: 'team', providerId, label: 'HubSpot · Team',
    lifecycle: 'ready', createdByMembershipId: f.owner.membership.id, secretRefId: 'secret_hubspot',
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'hubspot', principalRef: 'chickpea:organization:test',
      accountRef: 'account_hubspot', allowedCapabilities: ['hubspot.contacts.search'],
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId, connectionAccountId: account.id, providerId: account.providerId, allowedCapabilities: [], enabled: true,
  });
  return account;
}

/** Connections live in accounts the Agent's workspace installation lists. */
async function installAgent(f: ManagementAdapterFixture, agentId = 'agent_research') {
  await createFixtureAgent(f, agentId);
  await f.config.ensureWorkspaceInstallation({ workspaceId: f.owner.binding.slackTeamId!, transportMode: 'direct', defaultAgentId: agentId });
}

/** An Agent's writable connection lanes, as the 4.x inspect_workspace shows them. */
async function lanes(call: Call, agentId: string): Promise<{ apiConnections: Array<Record<string, any>>; mcpServers: Array<Record<string, any>> }> {
  const inspected = JSON.parse((await call('inspect_workspace')).content[0]!.text) as { result: { agents: Array<{ id: string }> } };
  return inspected.result.agents.find(({ id }) => id === agentId) as never;
}

/** Records every prepareConnectorSetup call and what it returned. */
function spyConnectorSetup(f: ManagementAdapterFixture) {
  const calls: Array<{ input: unknown; result: PrepareConnectorSetupResult }> = [];
  const original = f.service.prepareConnectorSetup.bind(f.service);
  f.service.prepareConnectorSetup = async (context, input) => {
    const result = await original(context, input);
    calls.push({ input, result });
    return result;
  };
  return calls;
}

test('connect_service hands out exactly the link prepare_connector_setup makes, from the same method', async (t) => {
  const { f, call } = await harness(t, 'connect-catalog');
  await createFixtureAgent(f, 'agent_research');
  const calls = spyConnectorSetup(f);

  const v4 = JSON.parse((await call('prepare_connector_setup', {
    agentId: 'agent_research', connector: 'gmail', ownerKind: 'member',
  })).content[0]!.text) as { ok: true; result: PrepareConnectorSetupResult };
  const connected = structured(await call('connect_service', {
    agentId: 'agent_research', service: 'Gmail', owner: 'me', idempotencyKey: 'gmail',
  }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.input, calls[0]!.input, 'the same service method with the same input');
  assert.equal(connected.status, 'needs_setup');
  assert.equal(connected.setup.url, calls[1]!.result.handoffUrl, 'the link is the method\'s, never built by the tool');
  assert.equal(connected.setup.setupToken, calls[1]!.result.setupOperationId);
  assert.equal(v4.result.handoffUrl, calls[0]!.result.handoffUrl);
  assert.equal(connected.setup.what, 'Gmail');
  assert.equal(connected.agent.agentId, 'agent_research');
  assert.match(connected.summary, /^Open the link to connect Gmail to Research\.$/);

  const team = structured(await call('connect_service', {
    agentId: 'agent_research', service: 'gmail', owner: 'team', idempotencyKey: 'gmail-team',
  }));
  assert.deepEqual(calls[2]!.input, { agentId: 'agent_research', connector: 'gmail', ownerKind: 'team' });
  assert.equal(team.setup.url, calls[2]!.result.handoffUrl);

  errorOf(await call('connect_service', {
    agentId: 'agent_research', service: 'Nonexistent Service', owner: 'me', idempotencyKey: 'unknown',
  }), 'invalid_input');
  errorOf(await call('connect_service', {
    agentId: 'agent_research', service: 'gmail', idempotencyKey: 'no-owner',
  }), 'invalid_input');
  assertNoInternalIds(JSON.stringify({ connected, team }), f);
});

test('connect_service refuses a service the Agent already has and names reconnect_service', async (t) => {
  const { f, teamId, call } = await harness(t, 'connect-existing');
  await createFixtureAgent(f, 'agent_research');
  const account = await bindTeamHubspot(f, teamId, 'agent_research');
  const calls = spyConnectorSetup(f);

  const refused = errorOf(await call('connect_service', {
    agentId: 'agent_research', service: 'HubSpot', owner: 'team', idempotencyKey: 'hubspot',
  }), 'invalid_input');
  assert.match(refused.message, /^Research already has HubSpot · Team, so no link was made\.$/);
  assert.deepEqual(refused.fix, {
    label: 'Reconnect HubSpot · Team',
    tool: 'reconnect_service',
    arguments: { agentId: 'agent_research', connectionId: account.id },
  });
  assert.equal(calls.length, 0, 'no link was made');

  // A personal HubSpot is another lane, so it is a new connection.
  structured(await call('connect_service', { agentId: 'agent_research', service: 'HubSpot', owner: 'me', idempotencyKey: 'mine' }));
  assert.equal(calls.length, 1);
});

test('when the service would sign an existing connection in again, connect_service cancels that link and refuses', async (t) => {
  const { f, call } = await harness(t, 'connect-post-check');
  await createFixtureAgent(f, 'agent_research');
  // A real link of this person's, standing in for the one the service issued.
  const issued = structured(await call('connect_model_provider', { provider: 'openai' })).setup.setupToken as string;
  f.service.prepareConnectorSetup = async () => ({
    agent: { id: 'agent_research', name: 'Research' },
    connector: { id: 'notion', name: 'Notion' },
    ownerKind: 'member',
    handoffUrl: 'http://localhost/setup/x',
    setupOperationId: issued,
    reconnect: { connectionId: 'connection_notion_mine', label: 'Notion · Personal' },
  });
  const refused = errorOf(await call('connect_service', {
    agentId: 'agent_research', service: 'Notion', owner: 'me', idempotencyKey: 'notion',
  }), 'invalid_input');
  assert.equal(refused.fix.tool, 'reconnect_service');
  assert.equal(refused.fix.arguments.connectionId, 'connection_notion_mine');
  assert.equal(structured(await call('get_setup_status', { setupToken: issued })).status, 'cancelled');
});

test('connect_service adds a custom API or MCP connection, then links its key; a retry adds nothing and links again', async (t) => {
  const { f, call } = await harness(t, 'connect-custom');
  await installAgent(f);
  const custom = { kind: 'api', name: 'Statusboard API', hosts: ['api.statusboard.example'], pathPrefixes: ['/v1'] };
  const args = { agentId: 'agent_research', custom, checkPath: '/v1/me', version: await version(call, 'agent_research'), idempotencyKey: 'statusboard' };

  const added = structured(await call('connect_service', args));
  assert.equal(added.status, 'needs_setup');
  assert.match(added.summary, /^Added Statusboard API\. Open the link to add its key\.$/);
  assert.match(added.setup.url, /^http:\/\/localhost\/setup\/setup_/);
  const setup = await f.management.getSetup(added.setup.setupToken);
  assert.equal(setup?.action, 'api_credential');
  assert.equal(setup?.target.checkPath, '/v1/me');
  const [entry] = (await lanes(call, 'agent_research')).apiConnections;
  assert.deepEqual(
    [entry?.id, entry?.allowedHosts, entry?.pathPrefixes, entry?.headerName, entry?.headerValuePrefix, entry?.allowedMethods],
    ['statusboard_api', ['api.statusboard.example'], ['/v1'], 'Authorization', 'Bearer ', ['GET', 'HEAD']],
  );
  assert.equal(added.version, await version(call, 'agent_research'), 'the version after the add');

  const retried = structured(await call('connect_service', args));
  assert.equal((await lanes(call, 'agent_research')).apiConnections.length, 1, 'the retry replays the add');
  assert.notEqual(retried.setup.setupToken, added.setup.setupToken, 'and makes a fresh link, since a stored result keeps none');

  const again = errorOf(await call('connect_service', { ...args, version: await version(call, 'agent_research'), idempotencyKey: 'twice' }), 'invalid_input');
  assert.equal(again.fix.tool, 'reconnect_service');
  errorOf(await call('connect_service', { ...args, idempotencyKey: 'stale' }), 'changed_since_read');
  errorOf(await call('connect_service', { ...args, version: undefined, idempotencyKey: 'no-version' }), 'invalid_input');

  const open = structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none' },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'docs',
  }));
  assert.deepEqual([open.status, open.setup], ['done', undefined], 'an open MCP server needs no key');
  const keyed = structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Tracker', url: 'https://mcp.tracker.example/mcp' },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'tracker',
  }));
  assert.equal(keyed.status, 'needs_setup');
  assert.equal((await f.management.getSetup(keyed.setup.setupToken))?.action, 'mcp_credentials');
  assertNoInternalIds(JSON.stringify({ added, open, keyed }), f);
});

test('reconnect_service links a custom connection\'s key, and signs a catalog connection in again through prepareConnectorSetup', async (t) => {
  const { f, teamId, call } = await harness(t, 'reconnect');
  await installAgent(f);
  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'api', name: 'Statusboard API', hosts: ['api.statusboard.example'] },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'statusboard',
  }));
  const custom = structured(await call('reconnect_service', { agentId: 'agent_research', connectionId: 'statusboard_api', checkPath: '/v1/me' }));
  assert.equal(custom.status, 'needs_setup');
  const setup = await f.management.getSetup(custom.setup.setupToken);
  assert.equal(setup?.action, 'api_credential');
  assert.equal(setup?.target.agentId, 'agent_research');

  const account = await bindTeamHubspot(f, teamId, 'agent_research');
  const calls = spyConnectorSetup(f);
  const catalog = structured(await call('reconnect_service', { agentId: 'agent_research', connectionId: account.id }));
  assert.deepEqual(calls.map(({ input }) => input), [{ agentId: 'agent_research', connector: 'hubspot-managed', ownerKind: 'team' }]);
  assert.equal(calls[0]!.result.reconnect?.connectionId, account.id, 'the service reconnects that connection in place');
  assert.equal(catalog.setup.url, calls[0]!.result.handoffUrl);
  assert.match(catalog.summary, /^Open the link to reconnect HubSpot · Team\.$/);

  errorOf(await call('reconnect_service', { agentId: 'agent_research', connectionId: 'connection_unknown' }), 'not_found');
});

test('a member cannot connect or reconnect a team connection, or change an Agent they cannot edit', async (t) => {
  const { f, teamId, as } = await harness(t, 'connect-member', { member: true });
  await createFixtureAgent(f, 'agent_owner_only');
  await createFixtureAgent(f, 'agent_shared', { name: 'Shared', creatorMembershipId: f.admin.membership.id });
  const account = await bindTeamHubspot(f, teamId, 'agent_shared');
  const member = as('admin');
  const calls = spyConnectorSetup(f);

  errorOf(await member('connect_service', { agentId: 'agent_shared', service: 'gmail', owner: 'team', idempotencyKey: 'team' }), 'not_allowed');
  errorOf(await member('reconnect_service', { agentId: 'agent_shared', connectionId: account.id }), 'not_allowed');
  assert.equal(calls.length, 0);
  errorOf(await member('remove_connection', { agentId: 'agent_shared', connectionId: account.id, idempotencyKey: 'remove' }), 'not_allowed');
  for (const [name, args] of Object.entries({
    connect_service: { agentId: 'agent_owner_only', service: 'gmail', owner: 'me' },
    update_connection: { agentId: 'agent_owner_only', connectionId: 'x', version: '0123456789abcdef', changes: { guide: 'x' } },
    remove_connection: { agentId: 'agent_owner_only', connectionId: 'x' },
    set_agent_repositories: { agentId: 'agent_owner_only', version: '0123456789abcdef', repositories: [] },
  })) errorOf(await member(name, { ...args, idempotencyKey: name }), 'not_found');
  errorOf(await member('reconnect_service', { agentId: 'agent_owner_only', connectionId: 'x' }), 'not_found');
  structured(await member('connect_service', { agentId: 'agent_shared', service: 'gmail', owner: 'me', idempotencyKey: 'mine' }));
});

test('update_connection changes a custom connection, links its key again when it would go somewhere new, and leaves catalog ones alone', async (t) => {
  const { f, teamId, call } = await harness(t, 'update-connection');
  await installAgent(f);
  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none' },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'docs',
  }));
  const guided = structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: await version(call, 'agent_research'),
    changes: { guide: 'Search before you read.' }, idempotencyKey: 'guide',
  }));
  assert.deepEqual([guided.status, guided.setup], ['done', undefined]);
  assert.equal((await lanes(call, 'agent_research')).mcpServers[0]?.guide, 'Search before you read.');
  errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: await version(call, 'agent_research'),
    changes: { hosts: ['api.example.com'] }, idempotencyKey: 'hosts-on-mcp',
  }), 'invalid_input');

  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'api', name: 'Statusboard API', hosts: ['api.statusboard.example'] },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'statusboard',
  }));
  const moved = structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'statusboard_api', version: await version(call, 'agent_research'),
    changes: { hosts: ['api.statusboard.example', 'eu.statusboard.example'] }, idempotencyKey: 'hosts',
  }));
  assert.equal(moved.status, 'needs_setup');
  assert.deepEqual((await lanes(call, 'agent_research')).apiConnections[0]?.allowedHosts, ['api.statusboard.example', 'eu.statusboard.example']);
  errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'statusboard_api', version: guided.version,
    changes: { guide: 'stale' }, idempotencyKey: 'stale',
  }), 'changed_since_read');

  await f.config.putConnectionAccount({
    id: 'connection_linear', workspaceId: teamId, ownerKind: 'team', providerId: 'linear', label: 'Linear', lifecycle: 'ready',
    createdByMembershipId: f.owner.membership.id, secretRefId: 'secret_linear',
    policy: {
      kind: 'mcp', url: 'https://mcp.linear.app/mcp', transport: 'streamable-http', authMode: 'oauth', headerNames: [],
      discoveredTools: [{ name: 'list_issues' }], allowedTools: ['list_issues'], oauthScope: 'read', presetId: 'linear',
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_research', connectionAccountId: 'connection_linear', providerId: 'linear', allowedCapabilities: [], enabled: true,
  });
  const catalog = errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: await version(call, 'agent_research'),
    changes: { guide: 'x' }, idempotencyKey: 'catalog',
  }), 'invalid_input');
  assert.match(catalog.nextStep, /reconnect_service/);
});

test('remove_connection confirms first, as policy.ts says, then confirm_change disconnects it', async (t) => {
  const { f, call } = await harness(t, 'remove-connection');
  await installAgent(f);
  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none' },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'docs',
  }));
  const proposed = structured(await call('remove_connection', { agentId: 'agent_research', connectionId: 'docs', idempotencyKey: 'remove' }));
  assert.equal(proposed.status, 'needs_confirmation');
  assert.match(proposed.confirmation.preview, /Disconnect \*\*Docs\*\* from \*\*Research\*\*/);
  assert.equal((await lanes(call, 'agent_research')).mcpServers.length, 1, 'nothing changed yet');
  const done = structured(await call('confirm_change', { confirmToken: proposed.confirmation.confirmToken }));
  assert.equal(done.status, 'done');
  assert.deepEqual(structured(await call('get_agent', { agentId: 'agent_research' })).connections, []);
  errorOf(await call('remove_connection', { agentId: 'agent_research', connectionId: 'docs', idempotencyKey: 'again' }), 'invalid_input');
  assertNoInternalIds(JSON.stringify({ proposed, done }), f);
});

test('set_agent_repositories sets the whole list and links GitHub access for a new repository', async (t) => {
  const { f, call } = await harness(t, 'repositories');
  await createFixtureAgent(f, 'agent_research');
  const set = structured(await call('set_agent_repositories', {
    agentId: 'agent_research', version: await version(call, 'agent_research'),
    repositories: [{ repository: 'acme/api' }, { repository: 'acme/web' }], idempotencyKey: 'two',
  }));
  assert.equal(set.status, 'needs_setup');
  assert.match(set.summary, /2 need GitHub access/);
  assert.equal((await f.management.getSetup(set.setup.setupToken))?.action, 'repository_access');
  assert.equal(set.warnings.length, 1, 'the second repository\'s link');
  const stored = (await f.config.getAgent('agent_research')).repositories;
  assert.deepEqual(stored.map(({ fullName, installationId, enabled }) => [fullName, installationId, enabled]),
    [['acme/api', null, true], ['acme/web', null, true]]);

  const accountWide = errorOf(await call('set_agent_repositories', {
    agentId: 'agent_research', version: await version(call, 'agent_research'),
    repositories: [{ repository: 'acme/*' }], idempotencyKey: 'all',
  }), 'invalid_input');
  assert.equal(accountWide.fix.url, 'https://chickpea.example.test/admin/agents/agent_research');

  const kept = structured(await call('set_agent_repositories', {
    agentId: 'agent_research', version: await version(call, 'agent_research'),
    repositories: [{ repository: 'acme/api' }], idempotencyKey: 'one',
  }));
  assert.deepEqual((await f.config.getAgent('agent_research')).repositories.map(({ id }) => id), [stored[0]!.id], 'the grant kept its ID');
  assert.equal(kept.status, 'needs_setup');
  const cleared = structured(await call('set_agent_repositories', {
    agentId: 'agent_research', version: await version(call, 'agent_research'), repositories: [], idempotencyKey: 'none',
  }));
  assert.deepEqual([cleared.status, (await f.config.getAgent('agent_research')).repositories], ['done', []]);
});

test('delete_agent names what blocks it before any confirmation, then confirms the deletion', async (t) => {
  const { f, teamId, call } = await harness(t, 'delete-agent');
  await createFixtureAgent(f, 'agent_research');
  await grantChannel(f, teamId, 'agent_research');

  const blocked = errorOf(await call('delete_agent', {
    agentId: 'agent_research', version: await version(call, 'agent_research'), idempotencyKey: 'blocked',
  }), 'still_in_use');
  assert.match(blocked.message, /^Archive Research first, then delete it\. .* It answers in #support\. Nothing was deleted\.$/);
  assert.equal(blocked.retryable, false);
  assert.equal(blocked.fix.tool, 'archive_agent');
  assert.deepEqual(Object.keys(blocked.fix.arguments).sort(), ['agentId', 'idempotencyKey', 'version']);
  assert.ok(await f.config.getAgent('agent_research'));

  // The fix is a real call.
  const archived = structured(await call('archive_agent', blocked.fix.arguments));
  errorOf(await call('delete_agent', { agentId: 'agent_research', version: blocked.fix.arguments.version, idempotencyKey: 'stale' }), 'changed_since_read');
  const proposed = structured(await call('delete_agent', { agentId: 'agent_research', version: archived.version, idempotencyKey: 'delete' }));
  assert.equal(proposed.status, 'needs_confirmation');
  assert.match(proposed.confirmation.preview, /Delete \*\*Research\*\* \(@research\) permanently\. This cannot be undone\./);
  assert.equal(proposed.agent.agentId, 'agent_research');
  assert.ok(await f.config.getAgent('agent_research'), 'nothing is deleted before the confirmation');
  const deleted = structured(await call('confirm_change', { confirmToken: proposed.confirmation.confirmToken }));
  assert.equal(deleted.status, 'done');
  assert.equal(deleted.agent, undefined);
  assert.equal((await f.config.listUserAgents()).some(({ id }) => id === 'agent_research'), false);
  errorOf(await call('get_agent', { agentId: 'agent_research' }), 'not_found');
  assertNoInternalIds(JSON.stringify({ blocked, proposed, deleted }), f);
});

test('a member cannot delete an Agent whose team connection the deletion would disconnect', async (t) => {
  const { f, teamId, as } = await harness(t, 'delete-member', { member: true });
  // Checked before the service's own preflight, so the Agent need not be archived for the refusal.
  await createFixtureAgent(f, 'agent_mine', { name: 'Mine', creatorMembershipId: f.admin.membership.id });
  await bindTeamHubspot(f, teamId, 'agent_mine');
  const member = as('admin');
  const refused = errorOf(await member('delete_agent', {
    agentId: 'agent_mine', version: await version(member, 'agent_mine'), idempotencyKey: 'delete',
  }), 'not_allowed');
  assert.match(refused.message, /^Only an Owner or Admin can delete Mine: deleting it disconnects its team connection, HubSpot · Team\.$/);
  await createFixtureAgent(f, 'agent_owner_only');
  errorOf(await member('delete_agent', { agentId: 'agent_owner_only', version: '0123456789abcdef', idempotencyKey: 'other' }), 'not_found');
});

test('remove_agent_from_channel applies at once with undo; delete_schedule confirms first', async (t) => {
  const { f, teamId, call } = await harness(t, 'channel-schedule');
  await createFixtureAgent(f, 'agent_research');
  await grantChannel(f, teamId, 'agent_research');

  const removed = structured(await call('remove_agent_from_channel', { agentId: 'agent_research', channelId: 'C_SUPPORT', idempotencyKey: 'leave' }));
  assert.equal(removed.status, 'done');
  assert.ok(removed.undoToken);
  assert.equal((await f.config.listAgentChannelGrants(teamId, 'C_SUPPORT')).some(({ agentId }) => agentId === 'agent_research'), false);
  errorOf(await call('remove_agent_from_channel', { agentId: 'agent_research', channelId: 'C_SUPPORT', idempotencyKey: 'leave-again' }), 'not_found');
  structured(await call('undo_change', { undoToken: removed.undoToken, idempotencyKey: 'rejoin' }));
  assert.ok((await f.config.listAgentChannelGrants(teamId, 'C_SUPPORT')).some(({ agentId }) => agentId === 'agent_research'));

  structured(await call('save_schedule', {
    agentId: 'agent_research', channelId: 'C_SUPPORT', name: 'Digest', task: 'Summarize the week.',
    when: { cron: '0 9 * * 1' }, timezone: 'UTC', post: 'always', requiredConnections: [], idempotencyKey: 'schedule',
  }));
  const [schedule] = structured(await call('list_schedules', { agentId: 'agent_research' })).schedules;
  const proposed = structured(await call('delete_schedule', { scheduleId: schedule.scheduleId, version: schedule.version, idempotencyKey: 'delete' }));
  assert.equal(proposed.status, 'needs_confirmation');
  assert.match(proposed.confirmation.preview, /Delete \*\*Digest\*\* permanently/);
  assert.equal((await f.routines.getRoutine(schedule.scheduleId))?.deletedAt, null, 'nothing is deleted yet');
  structured(await call('confirm_change', { confirmToken: proposed.confirmation.confirmToken }));
  assert.notEqual((await f.routines.getRoutine(schedule.scheduleId))?.deletedAt, null);
  errorOf(await call('delete_schedule', { scheduleId: schedule.scheduleId, version: schedule.version, idempotencyKey: 'again' }), 'changed_since_read');
});

test('remove_model_provider_key confirms first and is an Owner\'s or Admin\'s; an unknown website login is refused', async (t) => {
  let stored: 'stored' | 'missing' = 'stored';
  const overrides: Overrides = {
    providerCredentialSource: async () => stored,
    removeProviderCredential: async () => {
      stored = 'missing';
      return 'missing';
    },
  };
  const { f, as } = await harness(t, 'provider-key', { member: true, overrides });
  const owner = as('owner');
  const proposed = structured(await owner('remove_model_provider_key', { provider: 'openai', idempotencyKey: 'remove' }));
  assert.equal(proposed.status, 'needs_confirmation');
  assert.match(proposed.confirmation.preview, /Remove the stored \*\*OpenAI\*\* key\./);
  assert.equal(stored, 'stored');
  errorOf(await as('admin')('remove_model_provider_key', { provider: 'openai', idempotencyKey: 'member' }), 'not_allowed');
  errorOf(await as('admin')('confirm_change', { confirmToken: proposed.confirmation.confirmToken }), 'not_found');
  structured(await owner('confirm_change', { confirmToken: proposed.confirmation.confirmToken }));
  assert.equal(stored, 'missing');
  errorOf(await owner('remove_model_provider_key', { provider: 'openai', idempotencyKey: 'again' }), 'invalid_input');

  await createFixtureAgent(f, 'agent_research');
  errorOf(await owner('remove_website_login', {
    agentId: 'agent_research', loginId: `wl_${'0'.repeat(32)}`, idempotencyKey: 'login',
  }), 'invalid_input');
  errorOf(await owner('remove_website_login', { agentId: 'agent_research', loginId: 'login_1', idempotencyKey: 'bad' }), 'invalid_input');
});

test('remove_website_login confirms first, and a member cannot remove a team login', async (t) => {
  const { f, as } = await harness(t, 'website-login', { member: true });
  const agent = await createFixtureAgent(f, 'agent_research', { editPolicy: 'all_workspace_members' });
  const login = await createWebsiteLogin({ store: f.settings, keyring: generateCredentialKeyring('u3b2_website_login') }, {
    host: 'portal.example.com', label: 'Vendor portal', ownerKind: 'team', createdByMembershipId: f.owner.membership.id,
    method: 'credentials', username: 'ops@example.com', password: 'synthetic-portal-password',
  });
  await f.config.updateAgent(agent.id, { websiteLogins: [{ loginId: login.id, level: 'check', enabled: true }] }, agent.revision);
  const owner = as('owner');
  assert.deepEqual(structured(await owner('get_agent', { agentId: agent.id })).websiteLogins, [{ loginId: login.id, site: 'portal.example.com' }]);

  errorOf(await as('admin')('remove_website_login', { agentId: agent.id, loginId: login.id, idempotencyKey: 'member' }), 'not_allowed');
  const proposed = structured(await owner('remove_website_login', { agentId: agent.id, loginId: login.id, idempotencyKey: 'remove' }));
  assert.equal(proposed.status, 'needs_confirmation');
  assert.match(proposed.confirmation.preview, /Remove the \*\*portal\.example\.com\*\* login from \*\*Research\*\*/);
  assert.equal((await f.config.getAgent(agent.id)).websiteLogins?.length, 1, 'nothing changed yet');
  structured(await owner('confirm_change', { confirmToken: proposed.confirmation.confirmToken }));
  assert.deepEqual((await f.config.getAgent(agent.id)).websiteLogins ?? [], []);
  assert.doesNotMatch(JSON.stringify(proposed), /synthetic-portal-password/);
});

test('update_member is an Owner\'s: suspending confirms first, an Admin to Member change applies at once', async (t) => {
  const { f, as } = await harness(t, 'update-member');
  const owner = as('owner');
  const [admin] = structured(await owner('list_members')).members.filter(({ role }: { role: string }) => role === 'admin');
  assert.ok(admin.slackUserId);

  errorOf(await as('admin')('update_member', { slackUserId: admin.slackUserId, role: 'member', idempotencyKey: 'self' }), 'not_allowed');
  errorOf(await owner('update_member', { slackUserId: 'U_NOBODY', status: 'suspended', idempotencyKey: 'nobody' }), 'not_found');

  const demoted = structured(await owner('update_member', { slackUserId: admin.slackUserId, role: 'member', idempotencyKey: 'demote' }));
  assert.equal(demoted.status, 'done');
  assert.equal((await f.identity.getMembership(f.admin.membership.id))?.role, 'member');

  const suspend = structured(await owner('update_member', { slackUserId: admin.slackUserId, status: 'suspended', idempotencyKey: 'suspend' }));
  assert.equal(suspend.status, 'needs_confirmation');
  assert.match(suspend.confirmation.preview, /Suspend \*\*Admin\*\*’s Chickpea access/);
  assert.equal((await f.identity.getMembership(f.admin.membership.id))?.status, 'active', 'nothing changed yet');
  const confirmed = structured(await owner('confirm_change', { confirmToken: suspend.confirmation.confirmToken }));
  assert.equal(confirmed.status, 'done');
  assert.equal((await f.identity.getMembership(f.admin.membership.id))?.status, 'suspended');
  assertNoInternalIds(JSON.stringify({ suspend, demoted, confirmed }), f);
});

test('cancel_setup_link cancels a person\'s own link, or swaps it for a fresh one', async (t) => {
  const { as } = await harness(t, 'cancel-link');
  const owner = as('owner');
  const first = structured(await owner('connect_model_provider', { provider: 'openai' })).setup.setupToken;
  errorOf(await as('admin')('cancel_setup_link', { setupToken: first }), 'not_found');
  errorOf(await as('owner', 'client_other_app')('cancel_setup_link', { setupToken: first }), 'not_found');

  const cancelled = structured(await owner('cancel_setup_link', { setupToken: first }));
  assert.deepEqual([cancelled.status, cancelled.setup], ['done', undefined]);
  assert.equal(structured(await owner('get_setup_status', { setupToken: first })).status, 'cancelled');
  errorOf(await owner('cancel_setup_link', { setupToken: first }), 'setup_link_unusable');

  const second = structured(await owner('connect_model_provider', { provider: 'openai' })).setup.setupToken;
  const swapped = structured(await owner('cancel_setup_link', { setupToken: second, sendNewLink: true }));
  assert.equal(swapped.status, 'needs_setup');
  assert.notEqual(swapped.setup.setupToken, second);
  assert.equal(structured(await owner('get_setup_status', { setupToken: swapped.setup.setupToken })).status, 'waiting');
  errorOf(await owner('cancel_setup_link', { setupToken: 'setup_unknown' }), 'not_found');
});

test('disconnect_app revokes one of the person\'s own apps, this one included', async (t) => {
  const clients = new Map<string, Array<{ clientId: string; name: string; connectedAt: Date; lastTokenAt: Date | null }>>();
  const overrides: Overrides = {
    mcpOAuthClients: async () => ({
      listOAuthClientsForUser: async (userId: string) => clients.get(userId) ?? [],
      revokeOAuthClientForUser: async (userId: string, clientId: string) => {
        clients.set(userId, (clients.get(userId) ?? []).filter((client) => client.clientId !== clientId));
        return { clientId, revoked: true };
      },
    }) as never,
  };
  const { f, as } = await harness(t, 'disconnect-app', { overrides });
  const at = new Date('2026-11-01T00:00:00Z');
  clients.set(f.owner.binding.betterAuthUserId!, [
    { clientId: 'client_disconnect-app', name: 'Claude Code', connectedAt: at, lastTokenAt: at },
    { clientId: 'client_chatgpt', name: 'ChatGPT', connectedAt: at, lastTokenAt: null },
  ]);
  const owner = as('owner');
  const other = structured(await owner('disconnect_app', { appId: 'client_chatgpt' }));
  assert.deepEqual([other.name, other.thisApp], ['ChatGPT', false]);
  assert.match(other.message, /^Revoked ChatGPT\./);
  errorOf(await owner('disconnect_app', { appId: 'client_chatgpt' }), 'not_found');
  errorOf(await as('admin')('disconnect_app', { appId: 'client_disconnect-app' }), 'not_found');
  const self = structured(await owner('disconnect_app', { appId: 'client_disconnect-app' }));
  assert.equal(self.thisApp, true);
  assert.deepEqual(structured(await owner('list_connected_apps')).apps, []);
});
