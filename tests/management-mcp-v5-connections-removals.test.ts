import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { createWebsiteLogin } from '../src/browser/logins.ts';
import { BUGSNAG_MCP_SERVER_URL } from '../src/config/bugsnag-policy.ts';
import { resolveConnectionAccountSecret, saveConnectionAccountSecret } from '../src/config/connector-secrets.ts';
import type { ConnectionAccount } from '../src/config/types.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import type { PrepareConnectorSetupResult } from '../src/management/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  createFixtureAgent,
  createManagementAdapterFixture,
  ownerMcpContext,
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
type Overrides = Parameters<typeof createManagementAdapterFixture>[1];

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

/** An Agent's writable connection lanes as the service stores them, read as the Owner over MCP. */
async function lanes(f: ManagementAdapterFixture, agentId: string): Promise<{ apiConnections: Array<Record<string, any>>; mcpServers: Array<Record<string, any>> }> {
  const inspected = await f.service.inspectWorkspace(ownerMcpContext(f));
  return inspected.agents.find(({ id }) => id === agentId) as never;
}

/** The one-connection setup page with a token to follow it, never Admin. */
function assertFocusedSetup(setup: { url: string; setupToken?: string }): void {
  assert.match(setup.url, /^http:\/\/localhost\/setup\/setup_[^/#]+#setup=/, setup.url);
  assert.doesNotMatch(setup.url, /\/admin\//);
  assert.ok(setup.setupToken, 'a setupToken follows the link');
  assert.equal(new URL(setup.url).pathname, `/setup/${setup.setupToken}`);
}

/** A catalog Linear sign-in bound to the Agent, as the setup page leaves one it started (pending) or one that broke. */
async function bindCatalogLinear(
  f: ManagementAdapterFixture,
  teamId: string,
  lifecycle: ConnectionAccount['lifecycle'],
  preset: 'linear' | 'sentry' = 'linear',
) {
  const account = await f.config.putConnectionAccount({
    id: `connection_${preset === 'linear' ? 'a' : 'b'}${'0'.repeat(31)}`, workspaceId: teamId, ownerKind: 'team', providerId: preset,
    label: preset === 'linear' ? 'Linear' : 'Sentry', lifecycle, createdByMembershipId: f.owner.membership.id, secretRefId: `secret_${preset}`,
    policy: {
      kind: 'mcp', url: `https://mcp.${preset}.example/mcp`, transport: 'streamable-http', authMode: 'oauth', headerNames: [],
      discoveredTools: [], allowedTools: [], oauthScope: 'read', presetId: preset,
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_research', connectionAccountId: account.id, providerId: preset, allowedCapabilities: [], enabled: true,
  });
  return account;
}

/** A signed-in catalog Linear whose server said one tool reads, one writes, and nothing of the third. */
const LINEAR_TOOLS = [{ name: 'list_issues', readOnlyHint: true }, { name: 'get_issue' }, { name: 'save_issue', readOnlyHint: false }];

async function bindReadyCatalog(
  f: ManagementAdapterFixture,
  teamId: string,
  agentId: string,
  preset: 'linear' | 'sentry',
  owner: { ownerKind: 'team' } | { ownerKind: 'member'; ownerMembershipId: string } = { ownerKind: 'team' },
) {
  const account = await f.config.putConnectionAccount({
    id: `connection_${preset}_${owner.ownerKind}`, workspaceId: teamId, ...owner, providerId: preset,
    label: preset === 'linear' ? 'Linear' : 'Sentry', lifecycle: 'ready', identity: { workspaceName: 'Acme' },
    createdByMembershipId: owner.ownerKind === 'member' ? owner.ownerMembershipId : f.owner.membership.id,
    secretRefId: `secret_${preset}_${owner.ownerKind}`,
    policy: {
      kind: 'mcp', url: `https://mcp.${preset}.example/mcp`, transport: 'streamable-http', authMode: 'oauth', headerNames: [],
      discoveredTools: LINEAR_TOOLS, allowedTools: LINEAR_TOOLS.map(({ name }) => name), oauthScope: 'read', presetId: preset,
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId, connectionAccountId: account.id, providerId: preset, allowedCapabilities: [], enabled: true,
  });
  return account;
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
  assertFocusedSetup(connected.setup);
  assert.equal(v4.result.handoffUrl, calls[0]!.result.handoffUrl);
  assert.equal(connected.setup.what, 'Gmail');
  assert.equal(connected.agent.agentId, 'agent_research');
  assert.match(connected.summary, /^Open the link to connect Gmail to Research\.$/);

  const team = structured(await call('connect_service', {
    agentId: 'agent_research', service: 'gmail', owner: 'team', idempotencyKey: 'gmail-team',
  }));
  assert.deepEqual(calls[2]!.input, { agentId: 'agent_research', connector: 'gmail', ownerKind: 'team' });
  assert.equal(team.setup.url, calls[2]!.result.handoffUrl);
  assertFocusedSetup(team.setup);
  assert.equal((await f.management.getSetup(team.setup.setupToken))?.action, 'managed_connection');

  // A catalog connector that is not a managed sign-in gets the same page.
  const linear = structured(await call('connect_service', {
    agentId: 'agent_research', service: 'Linear', owner: 'team', idempotencyKey: 'linear',
  }));
  assert.equal(linear.setup.url, calls[3]!.result.handoffUrl);
  assertFocusedSetup(linear.setup);
  assert.equal((await f.management.getSetup(linear.setup.setupToken))?.action, 'catalog_connection');

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
  const [entry] = (await lanes(f, 'agent_research')).apiConnections;
  assert.deepEqual(
    [entry?.id, entry?.allowedHosts, entry?.pathPrefixes, entry?.headerName, entry?.headerValuePrefix, entry?.allowedMethods],
    ['statusboard_api', ['api.statusboard.example'], ['/v1'], 'Authorization', 'Bearer ', ['GET', 'HEAD']],
  );
  assert.equal(added.version, await version(call, 'agent_research'), 'the version after the add');

  const retried = structured(await call('connect_service', args));
  assert.equal((await lanes(f, 'agent_research')).apiConnections.length, 1, 'the retry replays the add');
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

// Defect caught: a custom "Linear" still waiting for its key was signed in as the catalog Linear, losing its hosts.
test('a custom connection waiting for its key is not taken for an unfinished catalog sign-in of the same name', async (t) => {
  const { f, call } = await harness(t, 'connect-custom-catalog-name');
  await installAgent(f);
  const custom = { kind: 'api', name: 'Linear', hosts: ['api.mycorp.example'], pathPrefixes: ['/v1'] };
  structured(await call('connect_service', {
    agentId: 'agent_research', custom, version: await version(call, 'agent_research'), idempotencyKey: 'custom-linear',
  }));
  const catalog = structured(await call('connect_service', {
    agentId: 'agent_research', service: 'Linear', owner: 'team', idempotencyKey: 'catalog-linear',
  }));
  assert.equal(catalog.status, 'needs_setup');
  const setup = await f.management.getSetup(catalog.setup.setupToken);
  assert.equal(setup?.action, 'catalog_connection');
  assert.notEqual((setup?.target as { replacement?: boolean } | undefined)?.replacement, true, 'a new connection, not a replacement');
  const [entry] = (await lanes(f, 'agent_research')).apiConnections;
  assert.deepEqual(entry?.allowedHosts, ['api.mycorp.example'], 'the custom connection is unchanged');
});

test('two custom connections whose names share a slug get their own IDs, and a refusal names the right one', async (t) => {
  const { f, call } = await harness(t, 'connect-slugs');
  await installAgent(f);
  const add = async (name: string, host: string, idempotencyKey: string) => call('connect_service', {
    agentId: 'agent_research', custom: { kind: 'api', name, hosts: [host] }, version: await version(call, 'agent_research'), idempotencyKey,
  });
  const japanese = structured(await add('日本語', 'api.jp.example', 'jp'));
  const chineseArgs = { agentId: 'agent_research', custom: { kind: 'api', name: '中文', hosts: ['api.cn.example'] }, version: await version(call, 'agent_research'), idempotencyKey: 'cn' };
  const chinese = structured(await call('connect_service', chineseArgs));
  assert.deepEqual((await lanes(f, 'agent_research')).apiConnections.map(({ id, displayName, allowedHosts }) => [id, displayName, allowedHosts])
    .sort(([left], [right]) => left.localeCompare(right)),
  [['connection', '日本語', ['api.jp.example']], ['connection-2', '中文', ['api.cn.example']]]);
  assert.equal((await f.management.getSetup(japanese.setup.setupToken))?.target.targetLabel, '日本語');
  assert.equal((await f.management.getSetup(chinese.setup.setupToken))?.target.targetLabel, '中文');
  // A retry replays the add, and links the connection it added, found by name.
  const retried = structured(await call('connect_service', chineseArgs));
  assert.equal((await lanes(f, 'agent_research')).apiConnections.length, 2);
  assert.equal((await f.management.getSetup(retried.setup.setupToken))?.target.targetLabel, '中文');

  const again = errorOf(await add('中文', 'api.cn2.example', 'cn-again'), 'invalid_input');
  assert.deepEqual(again.fix.arguments, { agentId: 'agent_research', connectionId: 'connection-2' }, 'the fix reconnects the one with that name');
  structured(await add('Acme (EU)', 'eu.acme.example', 'acme-eu-1'));
  structured(await add('Acme EU', 'eu2.acme.example', 'acme-eu-2'));
  // An account's ID starts with connection_, which a new connection's never does.
  structured(await add('Connection Manager', 'api.manager.example', 'manager'));
  assert.deepEqual((await lanes(f, 'agent_research')).apiConnections.map(({ id }) => id).sort(),
    ['acme_eu', 'acme_eu-2', 'connection', 'connection-2', 'connection-manager']);
});

test('custom connect_service refuses the other kind\'s fields, a prefix it would drop, and a key in the prefix', async (t) => {
  const { f, call } = await harness(t, 'connect-fields');
  await installAgent(f);
  const connect = async (custom: Record<string, unknown>, extra: Record<string, unknown> = {}) => call('connect_service', {
    agentId: 'agent_research', custom, version: await version(call, 'agent_research'), idempotencyKey: JSON.stringify(custom), ...extra,
  });
  const api = { kind: 'api', name: 'Statusboard API', hosts: ['api.statusboard.example'] };
  const mcp = { kind: 'mcp', name: 'Tracker', url: 'https://mcp.tracker.example/mcp' };
  for (const [custom, field] of [
    [{ ...api, auth: 'none' }, /no auth/],
    [{ ...api, allowedTools: ['search'] }, /no allowedTools/],
    [{ ...api, url: 'https://api.statusboard.example' }, /no url/],
    [{ ...mcp, pathPrefixes: ['/v1'], methods: ['GET'] }, /no pathPrefixes or methods/],
    [{ ...mcp, hosts: ['mcp.tracker.example'] }, /no hosts/],
  ] as const) {
    const refused = errorOf(await connect(custom), 'invalid_input');
    assert.match(refused.nextStep, field, JSON.stringify(custom));
  }
  const tokenPrefix = errorOf(await connect({ ...mcp, headerValuePrefix: 'Token ' }), 'invalid_input');
  assert.match(tokenPrefix.message, /cannot send "Token" before it\.$/);
  errorOf(await connect({ ...mcp, headerName: 'X-Api-Key', headerValuePrefix: 'Bearer ' }), 'invalid_input');
  errorOf(await connect({ ...mcp, auth: 'none', headerValuePrefix: 'Bearer ' }), 'invalid_input');
  errorOf(await connect(mcp, { checkPath: '/v1/me' }), 'invalid_input');
  const keyed = errorOf(await connect({ ...api, headerValuePrefix: 'Token 3f9a8b7c6d5e4f3a2b1c0d ' }), 'invalid_input');
  assert.match(keyed.message, /value prefix is the text before the key/);
  errorOf(await connect({ ...api, headerValuePrefix: `${'x '.repeat(16)}y` }), 'invalid_input');
  assert.deepEqual(await lanes(f, 'agent_research').then(({ apiConnections, mcpServers }) => [apiConnections, mcpServers]), [[], []], 'nothing was added');

  // What the connection can send is kept: "Bearer " in Authorization, and an open server.
  structured(await connect({ ...mcp, headerValuePrefix: 'Bearer ' }));
  structured(await connect({ kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none' }));
  assert.deepEqual((await lanes(f, 'agent_research')).mcpServers.map(({ displayName, authMode }) => [displayName, authMode])
    .sort(([left], [right]) => left.localeCompare(right)), [['Docs', 'none'], ['Tracker', 'bearer']]);
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
  assertFocusedSetup(catalog.setup);
  assert.match(catalog.summary, /^Open the link to reconnect HubSpot · Team\.$/);

  // A card draws an error's message (review SHOULD 5), so it names no field.
  const gone = errorOf(await call('reconnect_service', { agentId: 'agent_research', connectionId: 'connection_unknown' }), 'not_found');
  assert.equal(gone.message, `${(await f.config.getAgent('agent_research'))!.name} no longer has that connection.`);
});

test('reconnect_service finishes or repairs a catalog sign-in on the page connect_service gives, in place', async (t) => {
  const { f, teamId, call } = await harness(t, 'reconnect-catalog');
  await installAgent(f);
  const calls = spyConnectorSetup(f);
  const reconnect = async (connectionId = 'linear') => structured(await call('reconnect_service', { agentId: 'agent_research', connectionId }));

  for (const lifecycle of ['pending', 'needs_attention'] as const) {
    const account = await bindCatalogLinear(f, teamId, lifecycle);
    calls.length = 0;
    const linked = await reconnect();
    assert.deepEqual(calls.map(({ input }) => input), [{ agentId: 'agent_research', connector: 'linear', ownerKind: 'team' }], lifecycle);
    assert.equal(linked.setup.url, calls[0]!.result.handoffUrl);
    assertFocusedSetup(linked.setup);
    const setup = await f.management.getSetup(linked.setup.setupToken);
    assert.deepEqual([setup?.action, setup?.target.connectionId, setup?.target.replacement], ['catalog_connection', account.id, true],
      `a ${lifecycle} sign-in is finished in that same connection, never a second one beside it`);
    assert.match(linked.summary, /^Open the link to reconnect Linear\.$/);
  }

  // A ready catalog connection, and one the setup page cannot serve, keep their own sign-in link.
  await bindCatalogLinear(f, teamId, 'ready');
  calls.length = 0;
  const ready = await reconnect();
  assert.equal(calls.length, 0);
  assertFocusedSetup(ready.setup);
  assert.equal((await f.management.getSetup(ready.setup.setupToken))?.action, 'mcp_oauth');
  await bindCatalogLinear(f, teamId, 'needs_attention', 'sentry');
  const sentry = await reconnect('sentry');
  assert.equal(calls.length, 1, 'the service is asked first');
  assert.equal(calls[0]!.result.setupOperationId, undefined, 'it has only Admin\'s page for Sentry');
  assertFocusedSetup(sentry.setup);
  assert.equal((await f.management.getSetup(sentry.setup.setupToken))?.action, 'mcp_oauth');
});

test('check_agent sends an abandoned catalog sign-in to reconnect_service, whose link finishes it on the setup page', async (t) => {
  const { f, teamId, call } = await harness(t, 'check-abandoned');
  await installAgent(f);
  const account = await bindCatalogLinear(f, teamId, 'pending');
  const checked = structured(await call('check_agent', { agentId: 'agent_research' }));
  const linear = checked.checks.find(({ part, name }: { part: string; name: string }) => part === 'connection' && name === 'Linear');
  assert.equal(linear.status, 'warning');
  assert.deepEqual(linear.fix, {
    label: 'Finish setting up Linear', tool: 'reconnect_service', arguments: { agentId: 'agent_research', connectionId: 'linear' },
  }, 'never "Finish its setup in Admin"');

  const followed = structured(await call(linear.fix.tool, linear.fix.arguments));
  assertFocusedSetup(followed.setup);
  const setup = await f.management.getSetup(followed.setup.setupToken);
  assert.deepEqual([setup?.action, setup?.target.connectionId], ['catalog_connection', account.id]);
});

test('reconnect_service replaces a saved optional key, such as Exa\'s, and still refuses a connection with no key to replace', async (t) => {
  // Live wiring hands the service its settings, where a saved key lives.
  const { f, teamId, call } = await harness(t, 'reconnect-optional-key', { overrides: ({ settings }) => ({ settings }) });
  await installAgent(f);
  const exa = await f.config.putConnectionAccount({
    id: `connection_e${'0'.repeat(31)}`, workspaceId: teamId, ownerKind: 'team', providerId: 'exa', label: 'Exa',
    lifecycle: 'ready', createdByMembershipId: f.owner.membership.id, secretRefId: 'secret_exa',
    policy: {
      kind: 'mcp', url: 'https://mcp.exa.ai/mcp', transport: 'streamable-http', authMode: 'none', headerNames: ['x-api-key'],
      credentialHeaderName: 'x-api-key', credentialOptional: true,
      discoveredTools: [{ name: 'web_search_exa' }], allowedTools: ['web_search_exa'], presetId: 'exa',
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_research', connectionAccountId: exa.id, providerId: 'exa', allowedCapabilities: [], enabled: true,
  });
  const reconnect = (connectionId: string) => call('reconnect_service', { agentId: 'agent_research', connectionId });

  // Exa used without a key has none to replace, as before.
  const keyless = errorOf(await reconnect('exa'), 'invalid_input');
  assert.equal(keyless.message, 'This MCP connection does not require setup.');

  await saveConnectionAccountSecret(exa.secretRefId, 'exa-test-key', undefined, f.settings);
  const keyed = structured(await reconnect('exa'));
  assert.equal(keyed.status, 'needs_setup');
  assert.match(keyed.summary, /Open the link to reconnect Exa\.$/);
  assert.equal(JSON.stringify(keyed).includes('exa-test-key'), false, 'the saved key never reaches the result');
  const setup = await f.management.getSetup(keyed.setup.setupToken);
  assert.deepEqual(
    [setup?.action, setup?.target.connectionId, setup?.target.replacement, setup?.target.formFields],
    ['mcp_credentials', exa.id, true, ['header:x-api-key']],
    'the person types the new key on Chickpea\'s key page',
  );

  // A server that takes no key at all is still refused, even holding a stray secret, since its page has no key field.
  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none' },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'docs',
  }));
  const docs = (await f.config.listConnectionAccounts(teamId)).find(({ label }) => label === 'Docs')!;
  await saveConnectionAccountSecret(docs.secretRefId, 'stray-secret', undefined, f.settings);
  const open = errorOf(await reconnect('docs'), 'invalid_input');
  assert.equal(open.message, 'This MCP connection does not require setup.');
});

// A saved key a service rejects leaves the account ready (check_agent's own test reports key_rejected). The one
// way an optional-key account needs attention is a removal that fails after closing it, before revoking it.
test('check_agent sends an optional-key connection a failed removal left needing attention to reconnect_service, key or no key', async (t) => {
  const { f, teamId, call } = await harness(t, 'reconnect-optional-attention', { overrides: ({ settings }) => ({ settings }) });
  await installAgent(f);
  const optionalKey = async (providerId: string, label: string, presetId?: string) => {
    const account = await f.config.putConnectionAccount({
      id: `connection_${providerId}`, workspaceId: teamId, ownerKind: 'team', providerId, label,
      lifecycle: 'ready', createdByMembershipId: f.owner.membership.id, secretRefId: `secret_${providerId}`,
      policy: {
        kind: 'mcp', url: `https://mcp.${providerId}.example/mcp`, transport: 'streamable-http', authMode: 'none', headerNames: ['x-api-key'],
        credentialHeaderName: 'x-api-key', credentialOptional: true,
        discoveredTools: [{ name: 'search' }], allowedTools: ['search'], ...presetId ? { presetId } : {},
      },
    } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
    await f.config.putAgentConnectionBinding({
      agentId: 'agent_research', connectionAccountId: account.id, providerId, allowedCapabilities: [], enabled: true,
    });
    await saveConnectionAccountSecret(account.secretRefId, `${providerId}-key`, undefined, f.settings);
    return account;
  };
  const failedRemoval = async (connectionId: string) => {
    const proposed = structured(await call('remove_connection', { agentId: 'agent_research', connectionId, idempotencyKey: `remove-${connectionId}` }));
    assert.equal((await call('confirm_change', { confirmToken: proposed.confirmation.confirmToken })).isError, true);
  };
  const exa = await optionalKey('exa', 'Exa', 'exa');
  const search = await optionalKey('search', 'Search');
  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none' },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'docs',
  }));
  const docs = (await f.config.listConnectionAccounts(teamId)).find(({ label }) => label === 'Docs')!;

  // Exa's key stays: the removal stopped while retiring it. Docs, which takes no key, stopped at the same step.
  const deleteSetting = f.settings.deleteSetting.bind(f.settings);
  f.settings.deleteSetting = async () => { throw new Error('settings unavailable'); };
  await failedRemoval('exa');
  await failedRemoval('docs');
  f.settings.deleteSetting = deleteSetting;
  // Search's key is gone: the removal stopped after retiring it, as a newer write to the account won.
  const putConnectionAccount = f.config.putConnectionAccount.bind(f.config);
  f.config.putConnectionAccount = async (account, revision) => {
    if (account.id === search.id && account.lifecycle === 'revoked') throw new Error('revision moved');
    return putConnectionAccount(account, revision);
  };
  await failedRemoval('search');
  f.config.putConnectionAccount = putConnectionAccount;
  const lifecycle = async (id: string) => (await f.config.listConnectionAccounts(teamId)).find((account) => account.id === id)?.lifecycle;
  assert.deepEqual([await lifecycle(exa.id), await lifecycle(search.id), await lifecycle(docs.id)], ['needs_attention', 'needs_attention', 'needs_attention']);
  assert.deepEqual(
    [await resolveConnectionAccountSecret(exa, undefined, f.settings), await resolveConnectionAccountSecret(search, undefined, f.settings)],
    ['exa-key', undefined],
  );

  const checked = structured(await call('check_agent', { agentId: 'agent_research' }));
  for (const [name, connectionId] of [['Exa', 'exa'], ['Search', 'search']] as const) {
    const row = checked.checks.find((check: { part: string; name: string }) => check.part === 'connection' && check.name === name);
    assert.deepEqual([row.status, row.detail, row.fix], ['failing', 'It needs to be reconnected.', {
      label: `Reconnect ${name}`, tool: 'reconnect_service', arguments: { agentId: 'agent_research', connectionId },
    }], `${name}: as a connection whose key is required, never "Reconnect it in Admin"`);
    const followed = structured(await call(row.fix.tool, row.fix.arguments));
    assert.equal(followed.status, 'needs_setup', name);
    assertFocusedSetup(followed.setup);
    const setup = await f.management.getSetup(followed.setup.setupToken);
    assert.equal(setup?.target.connectionId, connectionId === 'exa' ? exa.id : search.id, name);
  }
  // A server that takes no key has no key page to send: Admin, as before.
  const keyless = checked.checks.find((check: { part: string; name: string }) => check.part === 'connection' && check.name === 'Docs');
  assert.deepEqual([keyless.status, keyless.fix.label, keyless.fix.tool], ['failing', 'Reconnect it in Admin', undefined]);
  assert.equal(errorOf(await call('reconnect_service', { agentId: 'agent_research', connectionId: 'docs' }), 'invalid_input').message,
    'This MCP connection does not require setup.');
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

  // An Owner's custom connection is the team's: a member can neither link its key nor change it.
  await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'direct', defaultAgentId: 'agent_shared' });
  const owner = as('owner');
  structured(await owner('connect_service', {
    agentId: 'agent_shared', custom: { kind: 'api', name: 'Statusboard API', hosts: ['api.statusboard.example'] },
    version: await version(owner, 'agent_shared'), idempotencyKey: 'team-custom',
  }));
  assert.equal(structured(await member('get_agent', { agentId: 'agent_shared' })).connections
    .find(({ connectionId }: { connectionId: string }) => connectionId === 'statusboard_api')?.owner, 'team');
  errorOf(await member('reconnect_service', { agentId: 'agent_shared', connectionId: 'statusboard_api' }), 'not_allowed');
  const before = await version(member, 'agent_shared');
  errorOf(await member('update_connection', {
    agentId: 'agent_shared', connectionId: 'statusboard_api', version: before,
    changes: { hosts: ['api.elsewhere.example'] }, idempotencyKey: 'member-change',
  }), 'not_allowed');
  assert.equal(await version(member, 'agent_shared'), before, 'refused before anything was written');
  assert.deepEqual((await lanes(f, 'agent_shared')).apiConnections.map(({ allowedHosts }) => allowedHosts), [['api.statusboard.example']]);

  // A team connection a failed removal left needing attention, its optional key gone: an Owner gets its key page,
  // a member gets neither the page nor a fix that names it.
  const search = await f.config.putConnectionAccount({
    id: 'connection_search', workspaceId: teamId, ownerKind: 'team', providerId: 'search', label: 'Search',
    lifecycle: 'needs_attention', createdByMembershipId: f.owner.membership.id, secretRefId: 'secret_search',
    policy: {
      kind: 'mcp', url: 'https://mcp.search.example/mcp', transport: 'streamable-http', authMode: 'none', headerNames: ['x-api-key'],
      credentialHeaderName: 'x-api-key', credentialOptional: true, discoveredTools: [{ name: 'search' }], allowedTools: ['search'],
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_shared', connectionAccountId: search.id, providerId: 'search', allowedCapabilities: [], enabled: true,
  });
  errorOf(await member('reconnect_service', { agentId: 'agent_shared', connectionId: 'search' }), 'not_allowed');
  const fixOf = async (call: typeof member) => structured(await call('check_agent', { agentId: 'agent_shared' })).checks
    .find((check: { part: string; name: string }) => check.part === 'connection' && check.name === 'Search').fix;
  const memberFix = await fixOf(member);
  assert.deepEqual([memberFix.label, memberFix.tool], ['Reconnect it in Admin', undefined]);
  assert.equal((await fixOf(owner)).tool, 'reconnect_service');
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
  assert.equal((await lanes(f, 'agent_research')).mcpServers[0]?.guide, 'Search before you read.');
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
  assert.deepEqual((await lanes(f, 'agent_research')).apiConnections[0]?.allowedHosts, ['api.statusboard.example', 'eu.statusboard.example']);
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

test('update_connection marks a custom MCP connection\'s tools as reads or writes; others keep their marks and limits', async (t) => {
  const { f, call } = await harness(t, 'mark-tools');
  await installAgent(f);
  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none', allowedTools: ['search', 'read_page', 'delete_page'] },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'docs',
  }));
  // An argument limit someone set through the Admin API stays when the tool is marked.
  const [account] = (await f.config.listConnectionAccounts(f.owner.binding.slackTeamId!)).filter(({ providerId }) => providerId === 'docs');
  await f.config.putConnectionAccount({
    ...account!,
    policy: { ...account!.policy, toolPolicies: { read_page: { effect: 'write', argumentConstraints: { space: ['eng'] } } } } as never,
  }, account!.revision);

  const marked = structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: await version(call, 'agent_research'),
    changes: { readTools: ['search', 'read_page'], writeTools: ['delete_page'] }, idempotencyKey: 'mark',
  }));
  assert.deepEqual([marked.status, marked.setup], ['done', undefined], 'marks apply at once and keep the connection\'s key');
  assert.deepEqual((await lanes(f, 'agent_research')).mcpServers[0]?.toolPolicies, {
    search: { effect: 'read' },
    read_page: { effect: 'read', argumentConstraints: { space: ['eng'] } },
    delete_page: { effect: 'write' },
  });
  const row = async () => (structured(await call('get_agent', { agentId: 'agent_research' })).connections as Array<Record<string, any>>)
    .find(({ connectionId }) => connectionId === 'docs')!.custom;
  assert.deepEqual([(await row()).readTools, (await row()).writeTools], [['search', 'read_page'], ['delete_page']]);

  // A tool not named keeps its mark.
  structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: await version(call, 'agent_research'),
    changes: { writeTools: ['read_page'] }, idempotencyKey: 'remark',
  }));
  assert.deepEqual([(await row()).readTools, (await row()).writeTools], [['search'], ['read_page', 'delete_page']]);

  const before = await version(call, 'agent_research');
  const refused = async (changes: Record<string, unknown>, key: string) => errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: before, changes, idempotencyKey: key,
  }), 'invalid_input');
  assert.match((await refused({ readTools: ['export_all'] }, 'unallowed')).message, /^Docs does not allow export_all, so it cannot be marked\.$/);
  assert.match((await refused({ readTools: ['search'], writeTools: ['search'] }, 'both')).message, /as a read or as a write, not both/);
  // An empty list marks nothing, so it is refused rather than saved as a new version.
  const marksBefore = (await lanes(f, 'agent_research')).mcpServers[0]?.toolPolicies;
  for (const [changes, key] of [[{ readTools: [] }, 'empty-read'], [{ readTools: [], writeTools: [] }, 'empty-both'],
    [{ name: 'Docs wiki', writeTools: [] }, 'empty-with-name']] as const) {
    const empty = await refused(changes, key);
    assert.deepEqual([empty.message, empty.nextStep], ['An empty readTools or writeTools marks nothing, so nothing changed.',
      'Name at least one of its allowedTools from get_agent in readTools or writeTools, or leave both out.']);
  }
  assert.deepEqual((await lanes(f, 'agent_research')).mcpServers[0]?.toolPolicies, marksBefore);
  assert.equal(await version(call, 'agent_research'), before, 'a refused mark writes nothing');

  structured(await call('connect_service', {
    agentId: 'agent_research', custom: { kind: 'api', name: 'Statusboard API', hosts: ['api.statusboard.example'] },
    version: await version(call, 'agent_research'), idempotencyKey: 'api',
  }));
  const api = errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'statusboard_api', version: await version(call, 'agent_research'),
    changes: { readTools: ['search'] }, idempotencyKey: 'api-marks',
  }), 'invalid_input');
  assert.equal(api.message, 'A custom API connection has no readTools to change.');
});

test('a mark goes with its tool\'s allowance: a tool update_connection allows again starts unmarked', async (t) => {
  const { f, call } = await harness(t, 'mark-allowance');
  await installAgent(f);
  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none', allowedTools: ['search', 'read_page', 'delete_page'] },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'docs',
  }));
  const change = async (changes: Record<string, unknown>, key: string) => assert.equal(structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: await version(call, 'agent_research'), changes, idempotencyKey: key,
  })).status, 'done');
  const marks = async () => (await lanes(f, 'agent_research')).mcpServers[0]?.toolPolicies;
  await change({ readTools: ['search', 'delete_page'] }, 'mark');
  await change({ allowedTools: ['search', 'read_page'] }, 'narrow');
  assert.deepEqual(await marks(), { search: { effect: 'read' } }, 'a dis-allowed tool loses its mark');
  await change({ allowedTools: ['search', 'read_page', 'delete_page'] }, 'widen');
  const docs = (structured(await call('get_agent', { agentId: 'agent_research' })).connections as Array<Record<string, any>>)
    .find(({ connectionId }) => connectionId === 'docs')!.custom;
  assert.deepEqual([docs.readTools, docs.writeTools], [['search'], undefined], 'nobody marked delete_page when it was allowed again');

  // An argument limit is a restriction, not a mark: it stays with its tool through a narrow and a widen.
  const [limited] = (await f.config.listConnectionAccounts(f.owner.binding.slackTeamId!)).filter(({ providerId }) => providerId === 'docs');
  const sandboxed = { effect: 'write', argumentConstraints: { space: ['sandbox'] } };
  await f.config.putConnectionAccount({
    ...limited!, policy: { ...limited!.policy, toolPolicies: { search: { effect: 'read' }, delete_page: sandboxed } } as never,
  }, limited!.revision);
  await change({ allowedTools: ['search', 'read_page'] }, 'narrow-limited');
  assert.deepEqual(await marks(), { search: { effect: 'read' }, delete_page: sandboxed }, 'a dis-allowed tool keeps its limit');
  await change({ allowedTools: ['search', 'read_page', 'delete_page'] }, 'widen-limited');
  assert.deepEqual(await marks(), { search: { effect: 'read' }, delete_page: sandboxed }, 'and comes back with it');

  // A mark left from before this rule, on a tool that is not allowed, does not come back with it either.
  const [account] = (await f.config.listConnectionAccounts(f.owner.binding.slackTeamId!)).filter(({ providerId }) => providerId === 'docs');
  await f.config.putConnectionAccount({
    ...account!,
    policy: { ...account!.policy, allowedTools: ['search'], toolPolicies: { search: { effect: 'read' }, read_page: { effect: 'read' } } } as never,
  }, account!.revision);
  await change({ allowedTools: ['search', 'read_page'] }, 'stale');
  assert.deepEqual(await marks(), { search: { effect: 'read' } });
});

test('undo_change takes back a mark: a connection that had none is left unmarked, one that had some keeps them', async (t) => {
  const { f, call } = await harness(t, 'mark-undo');
  await installAgent(f);
  structured(await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'mcp', name: 'Docs', url: 'https://mcp.docs.example/mcp', auth: 'none', allowedTools: ['search', 'read_page', 'delete_page'] },
    version: await version(call, 'agent_research'),
    idempotencyKey: 'docs',
  }));
  const mark = async (readTools: string[], key: string) => structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: await version(call, 'agent_research'),
    changes: { readTools }, idempotencyKey: key,
  }));
  const docs = async () => (structured(await call('get_agent', { agentId: 'agent_research' })).connections as Array<Record<string, any>>)
    .find(({ connectionId }) => connectionId === 'docs')!.custom;

  const first = await mark(['delete_page'], 'first');
  assert.deepEqual((await docs()).readTools, ['delete_page']);
  const undone = structured(await call('undo_change', { undoToken: first.undoToken, idempotencyKey: 'undo-first' }));
  assert.equal(undone.status, 'done');
  assert.deepEqual([(await docs()).readTools, (await docs()).writeTools], [undefined, undefined], 'the first mark is gone');
  assert.deepEqual((await lanes(f, 'agent_research')).mcpServers[0]?.toolPolicies ?? {}, {});

  await mark(['search'], 'earlier');
  const later = await mark(['delete_page'], 'later');
  structured(await call('undo_change', { undoToken: later.undoToken, idempotencyKey: 'undo-later' }));
  assert.deepEqual((await docs()).readTools, ['search'], 'the mark from before the change stays');
});

test('a member takes back a mark on their own connection while the Agent has an unmarked team one', async (t) => {
  const { f, teamId, as } = await harness(t, 'mark-undo-member', { member: true });
  await createFixtureAgent(f, 'agent_shared', { name: 'Shared', creatorMembershipId: f.admin.membership.id });
  await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'direct', defaultAgentId: 'agent_shared' });
  const [owner, member] = [as('owner'), as('admin')];
  for (const [who, name, key] of [[owner, 'Wiki', 'team'], [member, 'Docs', 'mine']] as const) {
    structured(await who('connect_service', {
      agentId: 'agent_shared',
      custom: { kind: 'mcp', name, url: `https://mcp.${name.toLowerCase()}.example/mcp`, auth: 'none', allowedTools: ['search', 'delete_page'] },
      version: await version(who, 'agent_shared'), idempotencyKey: key,
    }));
  }
  const accounts = async () => new Map((await f.config.listConnectionAccounts(teamId)).map((account) => [account.providerId, account]));
  const wiki = (await accounts()).get('wiki')!;
  assert.equal(wiki.ownerKind, 'team');

  const marked = structured(await member('update_connection', {
    agentId: 'agent_shared', connectionId: 'docs', version: await version(member, 'agent_shared'),
    changes: { readTools: ['delete_page'] }, idempotencyKey: 'mark',
  }));
  const undone = structured(await member('undo_change', { undoToken: marked.undoToken, idempotencyKey: 'undo' }));
  assert.equal(undone.status, 'done', JSON.stringify(undone));
  const after = await accounts();
  const docs = after.get('docs')!.policy;
  assert.deepEqual(docs.kind === 'mcp' ? docs.toolPolicies ?? {} : null, {}, 'the member\'s mark is gone');
  assert.deepEqual(after.get('wiki'), wiki, 'the team connection is not written');
});

test('update_connection marks and unmarks a catalog MCP service\'s tools, which get_agent lists, and changes nothing else', async (t) => {
  const { f, teamId, call } = await harness(t, 'catalog-marks');
  await installAgent(f);
  const before = await bindReadyCatalog(f, teamId, 'agent_research', 'linear');
  const linear = async () => (structured(await call('get_agent', { agentId: 'agent_research' })).connections as Array<Record<string, any>>)
    .find(({ connectionId }) => connectionId === 'linear')!;
  const allowedTools = ['list_issues', 'get_issue', 'save_issue'];
  assert.deepEqual(await linear(), { connectionId: 'linear', name: 'Linear', kind: 'service', owner: 'team', status: 'ready', tools: { allowedTools } },
    'its tools are listed, unmarked: a server\'s own hint is not a mark');
  const mark = async (changes: Record<string, unknown>, key: string) => structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: await version(call, 'agent_research'), changes, idempotencyKey: key,
  }));

  const marked = await mark({ readTools: ['list_issues', 'get_issue'], writeTools: ['save_issue'] }, 'mark');
  assert.deepEqual([marked.status, marked.setup], ['done', undefined], 'marks apply at once, with no sign-in link');
  assert.deepEqual((await linear()).tools, { allowedTools, readTools: ['list_issues', 'get_issue'], writeTools: ['save_issue'] });
  // The marks are the whole change: the same account, sign-in, server, tools and binding.
  const [after] = (await f.config.listConnectionAccounts(teamId)).filter(({ id }) => id === before.id);
  const { revision: _revision, updatedAt: _updatedAt, ...kept } = after!;
  const { revision: _was, updatedAt: _then, ...was } = before;
  assert.deepEqual(kept, {
    ...was,
    policy: { ...before.policy, toolPolicies: { list_issues: { effect: 'read' }, get_issue: { effect: 'read' }, save_issue: { effect: 'write' } } },
  });
  assert.deepEqual((await f.config.listAgentConnectionBindings('agent_research')).map(({ allowedCapabilities, enabled }) => [allowedCapabilities, enabled]),
    [[[], true]]);

  // A tool not named keeps its mark; one named again moves.
  const unmarked = await mark({ writeTools: ['get_issue'] }, 'unmark');
  assert.deepEqual((await linear()).tools, { allowedTools, readTools: ['list_issues'], writeTools: ['get_issue', 'save_issue'] });
  structured(await call('undo_change', { undoToken: unmarked.undoToken, idempotencyKey: 'undo' }));
  assert.deepEqual((await linear()).tools, { allowedTools, readTools: ['list_issues', 'get_issue'], writeTools: ['save_issue'] }, 'undo takes it back');

  // Its other settings are Chickpea's: a change that names one is refused whole.
  const unchanged = await version(call, 'agent_research');
  const refused = errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: unchanged,
    changes: { guide: 'Search first.', url: 'https://evil.example/mcp', readTools: ['list_issues'] }, idempotencyKey: 'other-fields',
  }), 'invalid_input');
  assert.deepEqual([refused.message, refused.nextStep], [
    'Linear is a catalog service, so update_connection changes only its readTools and writeTools.',
    'Leave out url and guide. reconnect_service signs it in again.',
  ]);
  assert.equal(await version(call, 'agent_research'), unchanged, 'nothing was written');
});

test('a catalog tool its server says changes things is never marked as a read, and a read loses its mark once its server says so', async (t) => {
  const { f, teamId, call } = await harness(t, 'catalog-marks-guard');
  await installAgent(f);
  const account = await bindReadyCatalog(f, teamId, 'agent_research', 'linear');
  const unchanged = await version(call, 'agent_research');
  const refused = errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: unchanged,
    changes: { readTools: ['list_issues', 'save_issue'] }, idempotencyKey: 'write-as-read',
  }), 'invalid_input');
  assert.deepEqual([refused.message, refused.nextStep], [
    'save_issue says it changes things, so it can\'t be marked as a read.',
    'Leave it out of readTools. A practice run never calls a tool that is not marked as a read.',
  ]);
  assert.equal(await version(call, 'agent_research'), unchanged, 'nothing was written, list_issues included');
  const stored = async () => {
    const [current] = (await f.config.listConnectionAccounts(teamId)).filter(({ id }) => id === account.id);
    if (current?.policy.kind !== 'mcp') throw new Error('not an MCP account');
    return { ...current, policy: current.policy };
  };
  assert.equal((await stored()).policy.toolPolicies, undefined);

  // Marked as a write, it is what the server says.
  structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: unchanged,
    changes: { readTools: ['list_issues'], writeTools: ['save_issue'] }, idempotencyKey: 'marks',
  }));
  // The server then says list_issues changes things: get_agent stops listing it as a read.
  const current = await stored();
  await f.config.putConnectionAccount({
    ...current,
    policy: { ...current.policy, discoveredTools: LINEAR_TOOLS.map((tool) => tool.name === 'list_issues' ? { ...tool, readOnlyHint: false } : tool) },
  }, current.revision);
  const tools = (structured(await call('get_agent', { agentId: 'agent_research' })).connections as Array<Record<string, any>>)
    .find(({ connectionId }) => connectionId === 'linear')!.tools;
  assert.deepEqual(tools, { allowedTools: ['list_issues', 'get_issue', 'save_issue'], writeTools: ['save_issue'] });
  // Two at once are named together, and the next step says them.
  const both = errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: await version(call, 'agent_research'),
    changes: { readTools: ['list_issues', 'save_issue'] }, idempotencyKey: 'two-writes-as-reads',
  }), 'invalid_input');
  assert.deepEqual([both.message, both.nextStep], [
    'list_issues, save_issue say they change things, so they can\'t be marked as a read.',
    'Leave them out of readTools. A practice run never calls a tool that is not marked as a read.',
  ]);
});

test('a custom MCP tool its server says changes things is never marked as a read either, and get_agent drops a read its server now says writes', async (t) => {
  const { f, teamId, call } = await harness(t, 'custom-marks-guard');
  await installAgent(f);
  const account = await f.config.putConnectionAccount({
    id: 'connection_docs_team', workspaceId: teamId, ownerKind: 'team', providerId: 'docs', label: 'Docs', lifecycle: 'ready',
    createdByMembershipId: f.owner.membership.id, secretRefId: 'secret_docs',
    policy: {
      kind: 'mcp', url: 'https://docs.example/mcp', transport: 'streamable-http', authMode: 'none', headerNames: [],
      discoveredTools: LINEAR_TOOLS, allowedTools: LINEAR_TOOLS.map(({ name }) => name),
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_research', connectionAccountId: account.id, providerId: 'docs', allowedCapabilities: [], enabled: true,
  });
  const stored = async () => {
    const [current] = (await f.config.listConnectionAccounts(teamId)).filter(({ id }) => id === account.id);
    if (current?.policy.kind !== 'mcp') throw new Error('not an MCP account');
    return { ...current, policy: current.policy };
  };
  const unchanged = await version(call, 'agent_research');
  const refused = errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: unchanged, changes: { readTools: ['save_issue'] }, idempotencyKey: 'write-as-read',
  }), 'invalid_input');
  assert.equal(refused.message, 'save_issue says it changes things, so it can\'t be marked as a read.');
  assert.equal((await stored()).policy.toolPolicies, undefined, 'nothing was written');

  structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'docs', version: unchanged, changes: { readTools: ['list_issues'] }, idempotencyKey: 'mark',
  }));
  const current = await stored();
  await f.config.putConnectionAccount({
    ...current,
    policy: { ...current.policy, discoveredTools: LINEAR_TOOLS.map((tool) => tool.name === 'list_issues' ? { ...tool, readOnlyHint: false } : tool) },
  }, current.revision);
  const { custom } = (structured(await call('get_agent', { agentId: 'agent_research' })).connections as Array<Record<string, any>>)
    .find(({ connectionId }) => connectionId === 'docs')!;
  assert.deepEqual(custom, { url: 'https://docs.example/mcp', allowedTools: ['list_issues', 'get_issue', 'save_issue'] });
});

test('marking a catalog service that waits for its sign-in gives no key link: reconnect_service signs it in', async (t) => {
  const { f, teamId, call } = await harness(t, 'catalog-marks-pending');
  await installAgent(f);
  const ready = await bindReadyCatalog(f, teamId, 'agent_research', 'linear');
  const account = await f.config.putConnectionAccount({ ...ready, lifecycle: 'pending' }, ready.revision);
  const marked = structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: await version(call, 'agent_research'),
    changes: { readTools: ['list_issues'] }, idempotencyKey: 'mark-pending',
  }));
  assert.deepEqual([marked.status, marked.setup], ['done', undefined]);
  const [after] = (await f.config.listConnectionAccounts(teamId)).filter(({ id }) => id === account.id);
  assert.deepEqual([after!.lifecycle, after!.policy.kind === 'mcp' && after!.policy.toolPolicies], ['pending', { list_issues: { effect: 'read' } }]);
});

test('a catalog service\'s tools are marked only by whoever may change that connection: a member\'s own, not the team\'s', async (t) => {
  const { f, teamId, as } = await harness(t, 'catalog-marks-authority', { member: true });
  // The member created the Agent, so they may change it and its connections they own.
  await createFixtureAgent(f, 'agent_shared', { name: 'Shared', creatorMembershipId: f.admin.membership.id });
  await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'direct', defaultAgentId: 'agent_shared' });
  const team = await bindReadyCatalog(f, teamId, 'agent_shared', 'linear');
  const own = await bindReadyCatalog(f, teamId, 'agent_shared', 'sentry', { ownerKind: 'member', ownerMembershipId: f.admin.membership.id });
  const member = as('admin');
  const before = await version(member, 'agent_shared');
  const refused = errorOf(await member('update_connection', {
    agentId: 'agent_shared', connectionId: 'linear', version: before, changes: { readTools: ['list_issues'] }, idempotencyKey: 'team',
  }), 'not_allowed');
  assert.equal(refused.message, 'Only a Chickpea Admin can change or remove a team connection.');
  assert.equal(await version(member, 'agent_shared'), before, 'refused before anything was written');
  const policies = async (id: string) => {
    const [account] = (await f.config.listConnectionAccounts(teamId)).filter((candidate) => candidate.id === id);
    return account!.policy.kind === 'mcp' ? account!.policy.toolPolicies : null;
  };
  assert.equal(await policies(team.id), undefined);

  assert.equal(structured(await member('update_connection', {
    agentId: 'agent_shared', connectionId: 'sentry', version: before, changes: { readTools: ['list_issues'] }, idempotencyKey: 'own',
  })).status, 'done');
  assert.deepEqual(await policies(own.id), { list_issues: { effect: 'read' } });
  assert.equal(await policies(team.id), undefined, 'the team connection is not written');
});

test('a reviewed catalog connector lists no tools to mark, and update_connection refuses it before the service would', async (t) => {
  const { f, teamId, call } = await harness(t, 'catalog-marks-reviewed');
  await installAgent(f);
  const account = await f.config.putConnectionAccount({
    id: 'connection_bugsnag_team', workspaceId: teamId, ownerKind: 'team', providerId: 'bugsnag', label: 'BugSnag', lifecycle: 'ready',
    createdByMembershipId: f.owner.membership.id, secretRefId: 'secret_bugsnag',
    policy: {
      kind: 'mcp', url: BUGSNAG_MCP_SERVER_URL, transport: 'streamable-http', authMode: 'oauth', headerNames: [], oauthScope: 'api',
      toolAccessMode: 'review', presetId: 'bugsnag', discoveredTools: [{ name: 'list_errors', readOnlyHint: true }], allowedTools: ['list_errors'],
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_research', connectionAccountId: account.id, providerId: 'bugsnag', allowedCapabilities: [], enabled: true,
  });
  const row = (structured(await call('get_agent', { agentId: 'agent_research' })).connections as Array<Record<string, any>>)
    .find(({ connectionId }) => connectionId === 'bugsnag')!;
  assert.deepEqual(row, { connectionId: 'bugsnag', name: 'BugSnag', kind: 'service', owner: 'team', status: 'ready' },
    'its tools are chosen on the Agent\'s page in Admin, where Chickpea\'s review marks them');
  const before = await version(call, 'agent_research');
  const refused = errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'bugsnag', version: before, changes: { readTools: ['list_errors'] }, idempotencyKey: 'reviewed',
  }), 'invalid_input');
  assert.deepEqual([refused.message, refused.nextStep, refused.fix], [
    'BugSnag\'s tools are chosen on the Agent\'s page in Admin, so update_connection doesn\'t mark them.',
    'Its tools are chosen on the Agent\'s page in Admin, where Chickpea marks the ones that only read.',
    { label: 'Open the Agent in Admin', url: 'https://chickpea.example.test/admin/agents/agent_research' },
  ]);
  assert.equal(await version(call, 'agent_research'), before);
});

test('a tool a catalog server adds later is not a read until someone marks it', async (t) => {
  const { f, teamId, call } = await harness(t, 'catalog-marks-new-tool');
  await installAgent(f);
  const account = await bindReadyCatalog(f, teamId, 'agent_research', 'linear');
  structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: await version(call, 'agent_research'),
    changes: { readTools: ['list_issues'] }, idempotencyKey: 'mark',
  }));
  // The server lists a new tool that says it only reads, and the connection allows it, as a reconnect would.
  const [current] = (await f.config.listConnectionAccounts(teamId)).filter(({ id }) => id === account.id);
  if (current!.policy.kind !== 'mcp') throw new Error('not an MCP account');
  await f.config.putConnectionAccount({
    ...current!,
    policy: {
      ...current!.policy,
      discoveredTools: [...LINEAR_TOOLS, { name: 'list_projects', readOnlyHint: true }],
      allowedTools: [...current!.policy.allowedTools, 'list_projects'],
    },
  }, current!.revision);
  const tools = async () => (structured(await call('get_agent', { agentId: 'agent_research' })).connections as Array<Record<string, any>>)
    .find(({ connectionId }) => connectionId === 'linear')!.tools;
  assert.deepEqual(await tools(), { allowedTools: ['list_issues', 'get_issue', 'save_issue', 'list_projects'], readTools: ['list_issues'] });
  structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'linear', version: await version(call, 'agent_research'),
    changes: { readTools: ['list_projects'] }, idempotencyKey: 'mark-new',
  }));
  assert.deepEqual((await tools()).readTools, ['list_issues', 'list_projects']);
});

test('a custom API whose stored prefix predates the rule still renames and gains a neighbor; a changed prefix meets the rule', async (t) => {
  const { f, teamId, call } = await harness(t, 'kept-prefix');
  await installAgent(f);
  const stored = 'Bearer sk_live_abcdefghijklmnop0123 ';
  await f.config.createAgentOwnedConnection({
    account: {
      id: 'connection_legacy', workspaceId: teamId, ownerKind: 'team', createdByMembershipId: f.owner.membership.id,
      providerId: 'legacy', label: 'Legacy', secretRefId: 'secret_legacy', lifecycle: 'ready',
      policy: {
        kind: 'api', allowedHosts: ['legacy.example.test'], pathPrefixes: [], headerName: 'Authorization',
        headerValuePrefix: stored, allowedMethods: ['GET'], authMode: 'credential',
      },
    },
    binding: { agentId: 'agent_research', connectionAccountId: 'connection_legacy', providerId: 'legacy', allowedCapabilities: [], enabled: true },
  });
  const renamed = structured(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'legacy', version: await version(call, 'agent_research'),
    changes: { name: 'Old API' }, idempotencyKey: 'rename',
  }));
  assert.equal(renamed.status, 'done');
  structured(await call('connect_service', {
    agentId: 'agent_research', custom: { kind: 'api', name: 'Statusboard API', hosts: ['api.statusboard.example'] },
    version: await version(call, 'agent_research'), idempotencyKey: 'neighbor',
  }));
  const keyed = errorOf(await call('update_connection', {
    agentId: 'agent_research', connectionId: 'legacy', version: await version(call, 'agent_research'),
    changes: { headerValuePrefix: 'Token 3f9a8b7c6d5e4f3a2b1c0d ' }, idempotencyKey: 'change',
  }), 'invalid_input');
  assert.match(keyed.message, /value prefix is the text before the key/);
  const legacy = (await lanes(f, 'agent_research')).apiConnections.find(({ id }) => id === 'legacy');
  assert.deepEqual([legacy?.displayName, legacy?.headerValuePrefix], ['Old API', stored]);
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
  assert.equal((await lanes(f, 'agent_research')).mcpServers.length, 1, 'nothing changed yet');
  const done = structured(await call('confirm_change', { confirmToken: proposed.confirmation.confirmToken }));
  assert.deepEqual([done.status, done.summary], ['done', 'Disconnected Docs from Research.'], 'it names what the person confirmed');
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
  assert.equal(set.warnings, undefined, 'no link goes in the words');
  assert.equal(set.moreSetups.length, 1, 'the second repository\'s link, with its own token');
  const stored = (await f.config.getAgent('agent_research')).repositories;
  assert.deepEqual(stored.map(({ fullName, installationId, enabled }) => [fullName, installationId, enabled]),
    [['acme/api', null, true], ['acme/web', null, true]]);
  assert.deepEqual(
    await Promise.all([set.setup, ...set.moreSetups].map(async ({ setupToken }: { setupToken: string }) => (await f.management.getSetup(setupToken))?.target.repositoryId)),
    stored.map(({ id }) => id),
    'each link grants its own repository',
  );

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

  // Names that share a slug get their own grants, and each link names its own.
  const alike = structured(await call('set_agent_repositories', {
    agentId: 'agent_research', version: await version(call, 'agent_research'),
    repositories: [{ repository: 'acme/x-y' }, { repository: 'acme-x/y' }, { repository: 'acme/x.y' }], idempotencyKey: 'alike',
  }));
  const grants = (await f.config.getAgent('agent_research')).repositories;
  assert.equal(new Set(grants.map(({ id }) => id)).size, 3);
  const linked = await Promise.all([alike.setup, ...alike.moreSetups].map(async ({ setupToken }: { setupToken: string }) =>
    (await f.management.getSetup(setupToken))?.target.repositoryId));
  assert.deepEqual(linked, grants.map(({ id }) => id));
  assert.deepEqual([alike.setup, ...alike.moreSetups].map(({ what }: { what: string }) => what), ['acme/x-y', 'acme-x/y', 'acme/x.y']);

  // The service refuses two grants with one ID from any door.
  const agent = await f.config.getAgent('agent_research');
  const grant = { id: 'repo_same', installationId: null, accountLogin: 'acme', enabled: true };
  await assert.rejects(f.service.applyWorkspaceChanges({
    context: ownerMcpContext(f),
    idempotencyKey: 'duplicate-grants',
    operations: [{
      itemId: 'edit', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision,
      patch: { repositories: [{ ...grant, fullName: 'acme/one' }, { ...grant, fullName: 'acme/two' }] },
    }],
  }), /Each repository grant needs its own id\./);
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
  assert.match(blocked.nextStep, /^Tell the person it must be archived first, .* Archive it only if they agree, then call delete_agent again/);
  assert.equal(blocked.fix.tool, 'archive_agent');
  assert.deepEqual(Object.keys(blocked.fix.arguments).sort(), ['agentId', 'idempotencyKey', 'version']);
  assert.ok(await f.config.getAgent('agent_research'));

  // The fix is a real call, as the person's click on it would make.
  const archived = structured(await call('archive_agent', blocked.fix.arguments));
  errorOf(await call('delete_agent', { agentId: 'agent_research', version: blocked.fix.arguments.version, idempotencyKey: 'stale' }), 'changed_since_read');
  const proposed = structured(await call('delete_agent', { agentId: 'agent_research', version: archived.version, idempotencyKey: 'delete' }));
  assert.equal(proposed.status, 'needs_confirmation');
  assert.match(proposed.confirmation.preview, /Delete \*\*Research\*\* \(@research\) permanently\. This cannot be undone\./);
  assert.equal(proposed.agent.agentId, 'agent_research');
  assert.ok(await f.config.getAgent('agent_research'), 'nothing is deleted before the confirmation');
  const deleted = structured(await call('confirm_change', { confirmToken: proposed.confirmation.confirmToken }));
  assert.equal(deleted.status, 'done');
  assert.equal(deleted.summary, 'Deleted Research.', 'a deleted Agent is named from what the person confirmed');
  assert.equal(deleted.agent, undefined);
  assert.equal((await f.config.listUserAgents()).some(({ id }) => id === 'agent_research'), false);
  errorOf(await call('get_agent', { agentId: 'agent_research' }), 'not_found');
  assertNoInternalIds(JSON.stringify({ blocked, proposed, deleted }), f);
});

test('delete_agent says only time clears a recent thread, and offers archiving only instead of deleting', async (t) => {
  const { f, call } = await harness(t, 'delete-thread', { overrides: { agentLiveThreadCount: async () => 1 } });
  await createFixtureAgent(f, 'agent_research');
  const blocked = errorOf(await call('delete_agent', {
    agentId: 'agent_research', version: await version(call, 'agent_research'), idempotencyKey: 'blocked',
  }), 'still_in_use');
  assert.match(blocked.message, /^Research was used in a Slack thread in the last 30 days, so it cannot be deleted yet\. .* Nothing was deleted\.$/);
  assert.equal(blocked.fix, undefined, 'archiving does not clear it, so it is not the fix');
  assert.equal(blocked.nextStep, 'Tell the person when it can be deleted. If they want it to stop answering until then, offer archive_agent instead of deleting; call it only if they agree.');

  const archived = structured(await call('archive_agent', { agentId: 'agent_research', version: await version(call, 'agent_research'), idempotencyKey: 'archive' }));
  const still = errorOf(await call('delete_agent', { agentId: 'agent_research', version: archived.version, idempotencyKey: 'archived' }), 'still_in_use');
  assert.deepEqual([still.nextStep, still.fix], ['Tell the person when it can be deleted.', undefined]);
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
  assert.equal(structured(await call('confirm_change', { confirmToken: proposed.confirmation.confirmToken })).summary, 'Deleted the schedule Digest.');
  assert.notEqual((await f.routines.getRoutine(schedule.scheduleId))?.deletedAt, null);
  errorOf(await call('delete_schedule', { scheduleId: schedule.scheduleId, version: schedule.version, idempotencyKey: 'again' }), 'changed_since_read');
  const missing = errorOf(await call('delete_schedule', { scheduleId: 'schedule_missing', version: schedule.version, idempotencyKey: 'missing' }), 'not_found');
  assert.equal(missing.message, 'That schedule is gone, or you can\'t see it.', 'a card draws it, so it names no field');
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
  assert.equal(structured(await owner('confirm_change', { confirmToken: proposed.confirmation.confirmToken })).summary, 'Removed the OpenAI key.');
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
  assert.equal(structured(await owner('confirm_change', { confirmToken: proposed.confirmation.confirmToken })).summary,
    'Removed the portal.example.com login from Research.');
  assert.deepEqual((await f.config.getAgent(agent.id)).websiteLogins ?? [], []);
  assert.doesNotMatch(JSON.stringify(proposed), /synthetic-portal-password/);
});

test('update_member is an Owner\'s: suspending confirms first, an Admin to Member change applies at once', async (t) => {
  const { f, as } = await harness(t, 'update-member');
  const owner = as('owner');
  const [admin] = structured(await owner('list_members')).members.filter(({ role }: { role: string }) => role === 'admin');
  assert.ok(admin.slackUserId);

  errorOf(await as('admin')('update_member', { slackUserId: admin.slackUserId, role: 'member', idempotencyKey: 'self' }), 'not_allowed');
  const nobody = errorOf(await owner('update_member', { slackUserId: 'U_NOBODY', status: 'suspended', idempotencyKey: 'nobody' }), 'not_found');
  assert.equal(nobody.message, 'That person isn\'t in this workspace.', 'a card draws it, so it names no field');

  // An Owner change and a removal confirm first, as Admin asks.
  const promote = structured(await owner('update_member', { slackUserId: admin.slackUserId, role: 'owner', idempotencyKey: 'promote' }));
  assert.equal(promote.status, 'needs_confirmation');
  assert.match(promote.confirmation.preview, /Make \*\*Admin\*\* an Owner\./);
  const remove = structured(await owner('update_member', { slackUserId: admin.slackUserId, status: 'removed', idempotencyKey: 'remove' }));
  assert.equal(remove.status, 'needs_confirmation');
  assert.match(remove.confirmation.preview, /Remove \*\*Admin\*\* from Chickpea\./);
  assert.deepEqual(
    await f.identity.getMembership(f.admin.membership.id).then((membership) => [membership?.role, membership?.status]),
    ['admin', 'active'],
    'nothing changed yet',
  );

  const demoted = structured(await owner('update_member', { slackUserId: admin.slackUserId, role: 'member', idempotencyKey: 'demote' }));
  assert.equal(demoted.status, 'done');
  assert.equal((await f.identity.getMembership(f.admin.membership.id))?.role, 'member');

  const suspend = structured(await owner('update_member', { slackUserId: admin.slackUserId, status: 'suspended', idempotencyKey: 'suspend' }));
  assert.equal(suspend.status, 'needs_confirmation');
  assert.match(suspend.confirmation.preview, /Suspend \*\*Admin\*\*’s Chickpea access/);
  assert.equal((await f.identity.getMembership(f.admin.membership.id))?.status, 'active', 'nothing changed yet');
  const confirmed = structured(await owner('confirm_change', { confirmToken: suspend.confirmation.confirmToken }));
  assert.deepEqual([confirmed.status, confirmed.summary], ['done', 'Suspended Admin.']);
  assert.equal((await f.identity.getMembership(f.admin.membership.id))?.status, 'suspended');
  assertNoInternalIds(JSON.stringify({ suspend, demoted, confirmed }), f);
});

test('the only active Owner cannot demote, suspend or remove themselves, and nothing is revoked first', async (t) => {
  const revoked: string[] = [];
  const overrides: Overrides = {
    withBetterAuthAccessRevoker: async (use) => use({
      revokeOAuthGrantsForUser: async (userId: string) => {
        revoked.push(`grants:${userId}`);
        return { revokedGrants: 0 } as never;
      },
      deleteSessionsForUser: async (userId: string) => {
        revoked.push(`sessions:${userId}`);
        return 0;
      },
    }),
  };
  const { f, as } = await harness(t, 'last-owner', { overrides });
  const owner = as('owner');
  const members = structured(await owner('list_members')).members as Array<{ slackUserId: string; role: string }>;
  const self = members.find(({ role }) => role === 'owner')!.slackUserId;
  const admin = members.find(({ role }) => role === 'admin')!.slackUserId;
  const ownerState = async () => f.identity.getMembership(f.owner.membership.id).then((membership) => [membership?.role, membership?.status]);
  /** The other person's role, set in the identity store as another door would. */
  let changes = 0;
  const setOtherRole = (role: 'owner' | 'admin') => f.identity.updateMembershipAuthority({
    membershipId: f.admin.membership.id, role, actorMembershipId: f.owner.membership.id,
    correlationId: `last-owner-${++changes}`, authenticationSurface: 'better_auth', reasonCode: 'mcp_v5_test',
  });
  const LAST_OWNER = 'At least one active Owner is required. Make someone else an Owner first.';

  for (const change of [{ role: 'admin' }, { role: 'member' }, { status: 'suspended' }, { status: 'removed' }]) {
    const refused = errorOf(await owner('update_member', { slackUserId: self, ...change, idempotencyKey: JSON.stringify(change) }), 'invalid_input');
    assert.deepEqual([refused.message, refused.retryable], [LAST_OWNER, false], JSON.stringify(change));
  }
  assert.deepEqual(await ownerState(), ['owner', 'active']);
  assert.deepEqual(revoked, [], 'no session or app connection ended');

  // With a second Owner the same change is an ordinary confirmation.
  const promote = structured(await owner('update_member', { slackUserId: admin, role: 'owner', idempotencyKey: 'promote' }));
  structured(await owner('confirm_change', { confirmToken: promote.confirmation.confirmToken }));
  const step = structured(await owner('update_member', { slackUserId: self, role: 'admin', idempotencyKey: 'step-down' }));
  assert.equal(step.status, 'needs_confirmation');

  // The other Owner steps down before the confirmation: confirming is refused, and nothing is revoked.
  await setOtherRole('admin');
  revoked.length = 0;
  const late = errorOf(await owner('confirm_change', { confirmToken: step.confirmation.confirmToken }), 'invalid_input');
  assert.equal(late.retryable, false);
  assert.deepEqual([await ownerState(), revoked], [['owner', 'active'], []]);

  // A race: the checks read Owners from before the other one stepped down.
  await setOtherRole('owner');
  const twoOwners = await f.identity.listMemberships();
  const listMemberships = f.identity.listMemberships.bind(f.identity);
  let staleReads = 0;
  f.identity.listMemberships = (() => staleReads-- > 0 ? twoOwners : listMemberships()) as typeof f.identity.listMemberships;

  // Only the check before the confirmation is stale: the change checks again and revokes nothing.
  const raced = structured(await owner('update_member', { slackUserId: self, status: 'suspended', idempotencyKey: 'race' }));
  await setOtherRole('admin');
  staleReads = 1;
  revoked.length = 0;
  errorOf(await owner('confirm_change', { confirmToken: raced.confirmation.confirmToken }), 'invalid_input');
  assert.equal(staleReads, -1, 'the stale read went to the check before the confirmation');
  assert.deepEqual([await ownerState(), revoked], [['owner', 'active'], []]);

  // Both checks are stale: the identity store's own refusal reads the same, and is not retryable.
  await setOtherRole('owner');
  const last = structured(await owner('update_member', { slackUserId: self, status: 'suspended', idempotencyKey: 'race-2' }));
  await setOtherRole('admin');
  staleReads = 2;
  const refusedByStore = errorOf(await owner('confirm_change', { confirmToken: last.confirmation.confirmToken }), 'invalid_input');
  assert.deepEqual([refusedByStore.message, refusedByStore.retryable], [LAST_OWNER, false]);
  assert.deepEqual(await ownerState(), ['owner', 'active']);
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
  const page = 'https://chickpea.example.test/admin/settings/connected-apps';
  assert.equal(structured(await owner('list_connected_apps')).adminUrl, page);
  const other = structured(await owner('disconnect_app', { appId: 'client_chatgpt' }));
  assert.deepEqual([other.name, other.thisApp, other.adminUrl], ['ChatGPT', false, page]);
  assert.match(other.message, /^Revoked ChatGPT\./);
  errorOf(await owner('disconnect_app', { appId: 'client_chatgpt' }), 'not_found');
  errorOf(await as('admin')('disconnect_app', { appId: 'client_disconnect-app' }), 'not_found');
  const self = structured(await owner('disconnect_app', { appId: 'client_disconnect-app' }));
  assert.equal(self.thisApp, true);
  assert.deepEqual(structured(await owner('list_connected_apps')).apps, []);
});
