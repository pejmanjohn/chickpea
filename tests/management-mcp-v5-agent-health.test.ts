import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { createWebsiteLogin, touchWebsiteLoginUsed } from '../src/browser/logins.ts';
import type { ConnectionCheckOutcome } from '../src/connections/connection-check.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import type { ManagementActorContext } from '../src/management/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  applyThroughAdapter,
  createFixtureAgent,
  createManagementAdapterFixture,
  ownerMcpContext,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';

/** The fixture's clock. */
const NOW = 1_800_000_000_000;
const LEGACY = '2025-11-25';
const BASE_URL = 'https://chickpea.example.test';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown> & { error?: Record<string, unknown> };
  isError?: boolean;
};

interface HarnessOptions {
  as?: 'owner' | 'member';
  /** What a custom connection's one-request check answers, by connection account id. */
  checks?: Record<string, ConnectionCheckOutcome>;
  /** Models whose provider has no key. */
  unready?: readonly string[];
  /** A deployment that cannot test connections. */
  untestable?: true;
  /** What Slack says about each Channel; the member is in none of the private ones. */
  slackChannels?: Record<string, { name: string; private: boolean }>;
}

async function harness(t: TestContext, suffix: string, options: HarnessOptions = {}) {
  const tested: string[] = [];
  const channels = options.slackChannels;
  const f = await createManagementAdapterFixture(suffix, ({ settings }): Partial<WorkspaceManagementServiceInput> => ({
    settings,
    modelReadiness: async () => async (model) =>
      options.unready?.includes(model) ? { unavailable: 'credential_missing' } : undefined,
    ...(options.untestable ? {} : {
      testConnection: async ({ connectionId }) => {
        tested.push(connectionId);
        return options.checks?.[connectionId] ?? { kind: 'ok', url: 'https://acme.zendesk.com/api/v2/users/me', status: 200 };
      },
    }),
    ...(channels ? {
      slackFacts: async () => ({
        async lookupChannel(channelId: string) {
          const channel = channels[channelId];
          if (!channel) throw new Error(`channel_not_found:${channelId}`);
          return { id: channelId, ...channel, member: true, archived: false };
        },
        async listMemberChannels() {
          return new Set<string>();
        },
      }),
    } : {}),
  }));
  t.after(() => f.close());
  const teamId = f.owner.binding.slackTeamId;
  await f.config.ensureWorkspaceInstallation({
    workspaceId: teamId, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1',
  });
  if (options.as === 'member') {
    await f.identity.updateMembershipAuthority({
      membershipId: f.admin.membership.id,
      role: 'member',
      actorMembershipId: f.owner.membership.id,
      correlationId: `${suffix}-demotion`,
      authenticationSurface: 'better_auth',
      reasonCode: 'mcp_v5_test',
    });
  }
  const person = options.as === 'member' ? f.admin : f.owner;
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: person.binding.betterAuthUserId ?? 'ba_owner',
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    role: options.as ?? 'owner',
    clientId: `client_${suffix}`,
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: BASE_URL }),
    { legacy: 'stateless' },
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': LEGACY,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }));
    const body = await response.text();
    const json = body.trimStart().startsWith('{')
      ? body
      : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
    return (JSON.parse(json) as { result: ToolResult }).result;
  };
  const context: ManagementActorContext = {
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    origin: { kind: 'mcp', clientId: principal.clientId },
  };
  return { f, teamId, call, tested, context };
}

function structured(result: ToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent;
}

function errorOf(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent?.error, JSON.stringify(result));
  return result.structuredContent.error;
}

const PRESENCE = {
  requestedHandle: 'ops',
  normalizedHandle: 'ops',
  desiredState: 'active' as const,
  health: 'healthy' as const,
  avatar: { kind: 'generated' as const, revision: 1, seed: 'ops' },
};

/**
 * An Agent with the parts check_agent and explain_agent read: a skill, memory,
 * a public Channel, a team API connection that works, one that needs
 * reconnecting, a custom MCP server whose chosen and listed tools differ, a
 * website login, and a repository whose GitHub App is not installed.
 */
async function seedOps(f: ManagementAdapterFixture, teamId: string, extra: Record<string, unknown> = {}) {
  const created = await createWebsiteLogin({ store: f.settings as never, keyring: generateCredentialKeyring('agent_health') }, {
    host: 'portal.example.com', label: 'Order portal', ownerKind: 'team', createdByMembershipId: f.owner.membership.id, method: 'handoff',
  });
  await createFixtureAgent(f, 'agent_ops', {
    name: 'Ops',
    instructions: 'Keep the support queue moving.',
    model: 'local-stub/ops',
    slackPresence: PRESENCE,
    skills: [{ name: 'triage', description: 'Triage a ticket.', instructions: 'Read it, then label it.', enabled: true }],
    websiteLogins: [{ loginId: created.id, level: 'check', enabled: true }],
    repositories: [{ id: 'repo_api', installationId: null, accountLogin: 'acme', fullName: 'acme/api', enabled: true }],
    ...extra,
  });
  await f.memory.putAgentMemory?.({ agentId: 'agent_ops', body: 'Escalate refunds over $500 to #finance.', expectedRevision: 0 } as never);
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_ops', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support', channelIsPrivate: false,
  });
  const api = (host: string) => ({
    kind: 'api' as const, allowedHosts: [host], pathPrefixes: ['/api/'], headerName: 'Authorization',
    allowedMethods: ['GET' as const], authMode: 'credential' as const,
  });
  const accounts = [
    { id: 'connection_zendesk', providerId: 'zendesk', label: 'Zendesk', policy: api('acme.zendesk.com'), lifecycle: 'ready' as const },
    { id: 'connection_linear', providerId: 'linear', label: 'Linear', policy: api('api.linear.app'), lifecycle: 'needs_attention' as const },
    {
      id: 'connection_docs', providerId: 'docs', label: 'Docs MCP', lifecycle: 'ready' as const,
      policy: {
        kind: 'mcp' as const, url: 'https://mcp.docs.example/mcp', transport: 'streamable-http' as const, authMode: 'bearer' as const,
        headerNames: [], allowedTools: ['search', 'read_page', 'retired_tool'], guide: 'Search before you read a page.',
        discoveredTools: [
          { name: 'search', description: 'Search the docs.' },
          { name: 'read_page', description: 'Read one page.' },
          { name: 'delete_page', description: 'Delete a page.' },
        ],
      },
    },
  ];
  for (const account of accounts) {
    await f.config.putConnectionAccount({
      ...account, ownerKind: 'team', workspaceId: teamId, createdByMembershipId: f.owner.membership.id,
      secretRefId: `secret_${account.id}`,
    } as never, 0);
    await f.config.putAgentConnectionBinding({
      agentId: 'agent_ops', connectionAccountId: account.id, providerId: account.providerId, allowedCapabilities: [], enabled: true,
    });
  }
}

const ADMIN_SLACK_USER = 'U87654321';
const OWNER_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

type Explained = {
  prompt: Array<{ part: string; title: string; tokens: number; text?: string; whenUsed?: { tokens: number } }>;
  tools: Array<{ group: string; connectionId?: string; tools: string[]; tokens: number; missing: Array<{ tool: string; why: string; detail?: string }> }>;
  model: { model: string | null; canRun: boolean; why?: string };
  contextBudget: { tokens: number; top: Array<{ what: string; tokens: number }>; estimate: string };
  person: { name?: string; you: boolean };
  place: { kind: string; channelId?: string; name?: string };
};
type Checked = {
  healthy: boolean;
  checks: Array<{
    part: string; name: string; status: string; detail: string; plain?: string;
    fix?: { label: string; url?: string; tool?: string; arguments?: Record<string, unknown> };
    connectionId?: string; channelId?: string; scheduleId?: string; loginId?: string;
  }>;
};

const explain = async (call: Awaited<ReturnType<typeof harness>>['call'], args: Record<string, unknown>) =>
  structured(await call('explain_agent', args)) as unknown as Explained;
const check = async (call: Awaited<ReturnType<typeof harness>>['call'], args: Record<string, unknown>) =>
  structured(await call('check_agent', args)) as unknown as Checked;
const group = (explained: Explained, name: string) => explained.tools.find((entry) => entry.group === name);
const part = (checked: Checked, name: string) => checked.checks.filter((entry) => entry.part === name);

function assertNoInternalIds(serialized: string, f: ManagementAdapterFixture): void {
  for (const forbidden of [
    f.owner.membership.organizationId, f.owner.membership.id, f.owner.user.id, f.admin.membership.id, f.admin.user.id,
    '"revision"', 'configurationGeneration', 'creatorMembershipId', 'organizationId', 'membershipId', 'durationMs',
    'secret_connection',
  ]) assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked: ${serialized.slice(0, 300)}`);
}

test('explain_agent and check_agent declare read-only hints, and only check_agent reaches outside Chickpea', async (t) => {
  const { f } = await harness(t, 'descriptors');
  const handler = createMcpHandler(() => createWorkspaceManagementMcpServer({
    principal: {
      betterAuthUserId: 'ba_owner', userId: f.owner.user.id, membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId, role: 'owner', clientId: 'client_descriptors',
    },
    service: f.service,
  }), { legacy: 'stateless' });
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': LEGACY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }));
  const body = await response.text();
  const json = body.trimStart().startsWith('{') ? body : body.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
  const tools = (JSON.parse(json) as { result: { tools: Array<Record<string, unknown> & { name: string }> } }).result.tools;
  const explainTool = tools.find(({ name }) => name === 'explain_agent')!;
  const checkTool = tools.find(({ name }) => name === 'check_agent')!;
  assert.deepEqual(explainTool.annotations, OWNER_ONLY);
  // check_agent's connection checks send one request each to hosts the workspace configured.
  assert.deepEqual(checkTool.annotations, { ...OWNER_ONLY, openWorldHint: true });
  for (const tool of [explainTool, checkTool]) {
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['chickpea:workspace'] }], tool.name);
    const output = tool.outputSchema as { type?: string; additionalProperties?: boolean };
    assert.equal(output.type, 'object', `${tool.name}: an output schema`);
    assert.equal(output.additionalProperties, undefined, `${tool.name}: a listed output accepts a field a later release adds`);
  }
});

test('explain_agent shows the prompt parts, tools by connection with why any are missing, the model and the budget', async (t) => {
  const { f, teamId, call } = await harness(t, 'explain');
  await seedOps(f, teamId);
  const before = await f.config.getAgent('agent_ops');
  const explained = await explain(call, { agentId: 'agent_ops' });
  assert.deepEqual(await f.config.getAgent('agent_ops'), before, 'explaining changes nothing');

  assert.deepEqual(explained.place, { kind: 'dm' });
  assert.deepEqual(explained.person, { name: 'Owner', you: true });
  const [chickpea, instructions] = explained.prompt;
  assert.equal(chickpea!.part, 'chickpea');
  assert.equal(chickpea!.text, undefined, 'Chickpea\'s base prompt is named, not reproduced');
  assert.ok(chickpea!.tokens > 1_000);
  assert.equal(instructions!.text, 'Keep the support queue moving.');
  const memory = explained.prompt.find(({ part: kind }) => kind === 'memory');
  assert.equal(memory?.text, 'Escalate refunds over $500 to #finance.');
  const triage = explained.prompt.find(({ title }) => title === 'Skill: triage');
  assert.deepEqual(triage, {
    part: 'skill', title: 'Skill: triage', tokens: triage!.tokens,
    text: '- **triage** — Triage a ticket.', whenUsed: { tokens: triage!.whenUsed!.tokens },
  });
  assert.ok(explained.prompt.some(({ title }) => title === 'Chickpea\'s agent-authoring skill'));
  const guide = explained.prompt.find(({ part: kind }) => kind === 'connection_guide');
  assert.equal(guide?.title, 'Docs MCP\'s guide');
  assert.match(guide!.text!, /^- \*\*connection-docs\*\* — Notes on using the Docs MCP tools/);
  assert.ok(guide!.whenUsed!.tokens > guide!.tokens, 'the guide itself loads only when used');

  // Chosen and listed tools mount; one chosen tool is gone from the server, one listed tool is not chosen.
  assert.deepEqual(group(explained, 'Docs MCP'), {
    group: 'Docs MCP', connectionId: 'docs', tools: ['search', 'read_page'], tokens: group(explained, 'Docs MCP')!.tokens,
    missing: [
      { tool: 'retired_tool', why: 'not_discovered', detail: 'Chosen, but the server did not list it the last time Chickpea checked.' },
      { tool: 'delete_page', why: 'not_chosen', detail: 'The server offers it, but it is not chosen for this Agent.' },
    ],
  });
  assert.deepEqual(group(explained, 'Zendesk')?.tools, ['connection_request']);
  assert.deepEqual(group(explained, 'Linear')?.missing, [{ tool: 'connection_request', why: 'needs_attention', detail: 'It needs to be reconnected.' }]);
  assert.deepEqual(group(explained, 'Web')?.missing.map(({ tool, why }) => [tool, why]), [['web_search', 'not_set_up']]);
  assert.deepEqual(group(explained, 'Images')?.missing.map(({ tool, why }) => [tool, why]), [['*', 'not_set_up']]);
  assert.ok(group(explained, 'Slack')?.tools.includes('read_slack_thread'));
  assert.ok(group(explained, 'Chickpea')?.tools.includes('connection_request'));

  assert.deepEqual(explained.model, { model: 'local-stub/ops', source: 'pinned', effort: null, canRun: true });
  const { contextBudget } = explained;
  const sum = explained.prompt.reduce((total, entry) => total + entry.tokens, 0) +
    explained.tools.reduce((total, entry) => total + entry.tokens, 0);
  assert.equal(contextBudget.tokens, sum, 'one number: every prompt part and tool definition');
  assert.equal(contextBudget.top.length, 3);
  assert.deepEqual([...contextBudget.top].sort((left, right) => right.tokens - left.tokens), contextBudget.top);
  assert.equal(contextBudget.top[0]!.what, chickpea!.title);
  assert.match(contextBudget.estimate, /pi-ai: characters ÷ 3\.5/);
  assertNoInternalIds(JSON.stringify(explained), f);
});

test('explain_agent in a Channel names it, and refuses a Channel the Agent is not in', async (t) => {
  const { f, teamId, call } = await harness(t, 'explain-channel');
  await seedOps(f, teamId);
  const inChannel = await explain(call, { agentId: 'agent_ops', place: 'C_SUPPORT' });
  assert.deepEqual(inChannel.place, { kind: 'channel', channelId: 'C_SUPPORT', name: 'support' });
  const refused = errorOf(await call('explain_agent', { agentId: 'agent_ops', place: 'C_ELSEWHERE' }));
  assert.equal(refused.code, 'invalid_input');
  assert.match(refused.message as string, /not added to that Channel/);
});

test('explain_agent as another member names their own accounts by service only, connected or not, as Admin hides them', async (t) => {
  const { f, teamId, call } = await harness(t, 'explain-person');
  await seedOps(f, teamId);
  const drive = await f.config.putConnectionAccount({
    id: 'connection_admin_drive', workspaceId: teamId, ownerKind: 'member', ownerMembershipId: f.admin.membership.id,
    createdByMembershipId: f.admin.membership.id, providerId: 'google-drive', label: 'Admin\'s Drive',
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'googledrive', principalRef: 'principal_drive',
      accountRef: 'account_drive', allowedCapabilities: ['drive.files.search'],
    },
    secretRefId: 'secret_connection_drive', lifecycle: 'ready',
  } as never, 0);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_ops', connectionAccountId: drive.id, providerId: drive.providerId,
    allowedCapabilities: ['drive.files.search'], enabled: true,
  });
  // A personal API key the Owner saved, which every other member connects for themselves.
  const crm = await f.config.putConnectionAccount({
    id: 'connection_owner_crm', workspaceId: teamId, ownerKind: 'member', ownerMembershipId: f.owner.membership.id,
    createdByMembershipId: f.owner.membership.id, providerId: 'acme-crm', label: 'Owner\'s CRM key',
    policy: {
      kind: 'api', allowedHosts: ['api.acme-crm.example'], pathPrefixes: ['/v1/'], headerName: 'Authorization',
      allowedMethods: ['GET'], authMode: 'credential',
    },
    secretRefId: 'secret_connection_crm', lifecycle: 'ready',
  } as never, 0);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_ops', connectionAccountId: crm.id, providerId: crm.providerId, allowedCapabilities: [], enabled: true,
  });

  const asAdmin = await explain(call, { agentId: 'agent_ops', asPerson: ADMIN_SLACK_USER });
  assert.deepEqual(asAdmin.person, { name: 'Admin', you: false });
  const driveGroup = group(asAdmin, 'Their own Google Drive');
  assert.ok(driveGroup, JSON.stringify(asAdmin.tools.map(({ group: name }) => name)));
  assert.deepEqual({ ...driveGroup, tokens: 0 }, { group: 'Their own Google Drive', tools: ['*'], tokens: 0, missing: [] },
    'connected, with no label, connectionId or tool list');
  assert.ok(driveGroup.tokens > 0, 'the budget still counts the tools their run gets');
  assert.deepEqual(group(asAdmin, 'Their own acme-crm'), {
    group: 'Their own acme-crm', tools: [], tokens: 0,
    missing: [{ tool: 'connection_request', why: 'not_connected', detail: 'Admin has not connected their own account yet.' }],
  });
  const serialized = JSON.stringify(asAdmin);
  for (const hidden of ['Admin\'s Drive', 'connection_admin_drive', 'drive.files.search', 'Owner\'s CRM key', 'connection_owner_crm']) {
    assert.equal(serialized.includes(hidden), false, `${hidden} leaked`);
  }
  const checkedAsAdmin = JSON.stringify(await check(call, { agentId: 'agent_ops', asPerson: ADMIN_SLACK_USER }));
  for (const hidden of ['Admin\'s Drive', 'connection_admin_drive']) {
    assert.equal(checkedAsAdmin.includes(hidden), false, `check_agent: ${hidden} leaked`);
  }

  await f.config.putConnectionAccount({ ...drive, lifecycle: 'needs_attention' } as never, drive.revision);
  assert.deepEqual(group(await explain(call, { agentId: 'agent_ops', asPerson: ADMIN_SLACK_USER }), 'Their own Google Drive'), {
    group: 'Their own Google Drive', tools: [], tokens: 0,
    missing: [{ tool: '*', why: 'not_connected', detail: 'Admin\'s own account is not connected.' }],
  });

  const asOwner = await explain(call, { agentId: 'agent_ops' });
  assert.equal(asOwner.tools.some(({ group: name }) => name.includes('Google Drive')), false,
    'another member\'s own account never mounts for this person');
  assert.deepEqual(asOwner.tools.filter(({ group: name }) => name.includes('CRM') || name.includes('acme-crm'))
    .map(({ group: name, connectionId }) => [name, connectionId]), [['Owner\'s CRM key', 'acme-crm']],
  'the Owner sees their own key once, by its label');

  const unknown = errorOf(await call('explain_agent', { agentId: 'agent_ops', asPerson: 'U00NOBODY' }));
  assert.equal(unknown.code, 'not_found');
});

// Defect caught: another member's own connection named by its label and ID through its guide.
test('explain_agent as another member shows their own connection\'s guide by service only, with its cost and no text', async (t) => {
  const { f, teamId, call } = await harness(t, 'explain-person-guide');
  await seedOps(f, teamId);
  const crm = await f.config.putConnectionAccount({
    id: 'connection_admin_crm', workspaceId: teamId, ownerKind: 'member', ownerMembershipId: f.admin.membership.id,
    createdByMembershipId: f.admin.membership.id, providerId: 'acme-crm', label: 'Admin CRM secret label',
    policy: {
      kind: 'api', allowedHosts: ['api.acme-crm.example'], pathPrefixes: ['/v1/'], headerName: 'Authorization',
      allowedMethods: ['GET'], authMode: 'credential', guide: 'List deals with GET /v1/deals before answering.',
    },
    secretRefId: 'secret_connection_admin_crm', lifecycle: 'ready',
  } as never, 0);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_ops', connectionAccountId: crm.id, providerId: crm.providerId, allowedCapabilities: [], enabled: true,
  });

  const asAdmin = await explain(call, { agentId: 'agent_ops', asPerson: ADMIN_SLACK_USER });
  const serialized = JSON.stringify(asAdmin);
  for (const hidden of ['Admin CRM secret label', 'connection_admin_crm', 'connection-admin-crm', 'admin-crm']) {
    assert.equal(serialized.includes(hidden), false, `${hidden} leaked`);
  }
  const guide = asAdmin.prompt.find(({ part }) => part === 'connection_guide');
  assert.ok(guide, JSON.stringify(asAdmin.prompt.map(({ title }) => title)));
  assert.equal(guide.title, 'Their own acme-crm\'s guide');
  assert.equal(guide.text, undefined, 'no text: it names the connection');
  assert.ok(guide.tokens > 0, 'the budget still counts the guide');
});

test('a model whose provider has no key cannot run: explain says why and check offers the provider setup', async (t) => {
  const { f, teamId, call } = await harness(t, 'model', { unready: ['anthropic/claude-sonnet-4-6'] });
  await seedOps(f, teamId, { model: 'anthropic/claude-sonnet-4-6' });
  const explained = await explain(call, { agentId: 'agent_ops' });
  assert.equal(explained.model.canRun, false);
  // The card shows the provider by its name, never its ID.
  assert.equal(explained.model.why, 'Its provider, Anthropic, is not set up.');
  const [model] = part(await check(call, { agentId: 'agent_ops' }), 'model');
  assert.deepEqual(model, {
    part: 'model', name: 'anthropic/claude-sonnet-4-6', status: 'failing', detail: 'Its provider, Anthropic, is not set up.',
    plain: 'Its provider, Anthropic, is not set up.',
    fix: { label: 'Set up Anthropic', tool: 'connect_model_provider', arguments: { provider: 'anthropic' } },
  });
});

test('a model Chickpea cannot resolve keeps its reason for the model and gives the card a plain one', async (t) => {
  const { f, teamId, call } = await harness(t, 'unresolved');
  await seedOps(f, teamId, { model: undefined });
  const explained = await explain(call, { agentId: 'agent_ops' });
  assert.equal(explained.model.canRun, false);
  const [model] = part(await check(call, { agentId: 'agent_ops' }), 'model');
  assert.equal(model?.status, 'failing');
  assert.equal(model?.detail, explained.model.why);
  assert.equal(model?.plain, 'No model is ready for it. Choose one in Admin.');
});

test('check_agent tests custom connections once each, reads catalog ones from storage, and fixes what fails', async (t) => {
  const checks: Record<string, ConnectionCheckOutcome> = {
    connection_docs: { kind: 'key_rejected', status: 401, detail: 'Unauthorized' },
    connection_zendesk: { kind: 'unreachable', url: 'https://acme.zendesk.com/api/', detail: 'timed out' },
  };
  const { f, teamId, call, tested } = await harness(t, 'connections', { checks });
  await seedOps(f, teamId);
  const notion = await f.config.putConnectionAccount({
    id: 'connection_notion', workspaceId: teamId, ownerKind: 'team', createdByMembershipId: f.owner.membership.id,
    providerId: 'notion', label: 'Notion',
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'notion', principalRef: 'principal_notion',
      accountRef: 'account_notion', allowedCapabilities: ['notion.databases.query'],
    },
    secretRefId: 'secret_connection_notion', lifecycle: 'ready',
  } as never, 0);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_ops', connectionAccountId: notion.id, providerId: notion.providerId,
    allowedCapabilities: ['notion.databases.query'], enabled: true,
  });
  const pending = await f.config.putConnectionAccount({
    id: 'connection_statuspage', workspaceId: teamId, ownerKind: 'team', createdByMembershipId: f.owner.membership.id,
    providerId: 'statuspage', label: 'Statuspage', lifecycle: 'pending', secretRefId: 'secret_connection_statuspage',
    policy: { kind: 'api', allowedHosts: ['api.statuspage.example'], pathPrefixes: [], headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential' },
  } as never, 0);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_ops', connectionAccountId: pending.id, providerId: pending.providerId, allowedCapabilities: [], enabled: true,
  });
  const checked = await check(call, { agentId: 'agent_ops' });
  assert.deepEqual([...tested].sort(), ['connection_docs', 'connection_zendesk'], 'only custom connections get a request; no catalog call');
  const byName = new Map(part(checked, 'connection').map((entry) => [entry.name, entry]));
  assert.deepEqual(byName.get('Notion'), {
    part: 'connection', name: 'Notion', status: 'ok', detail: 'Connected.', plain: 'Connected.', connectionId: 'connection_notion',
  });
  const docs = byName.get('Docs MCP')!;
  assert.equal(docs.status, 'failing');
  assert.equal(docs.detail, 'The service rejected its saved key. HTTP 401. Unauthorized');
  assert.equal(docs.plain, 'The service rejected its saved key.', 'a card shows it without the status or the service\'s words');
  assert.deepEqual(docs.fix, {
    label: 'Send a link to save a new key',
    tool: 'reconnect_service',
    arguments: { agentId: 'agent_ops', connectionId: docs.connectionId },
  });
  const zendesk = byName.get('Zendesk')!;
  assert.deepEqual([zendesk.status, zendesk.fix], ['failing', undefined], 'an unreachable host has nothing the caller can fix');
  const linear = byName.get('Linear')!;
  assert.equal(linear.status, 'failing');
  assert.deepEqual(linear.fix, { label: 'Reconnect Linear', tool: 'reconnect_service', arguments: { agentId: 'agent_ops', connectionId: linear.connectionId } });
  const statuspage = byName.get('Statuspage')!;
  assert.equal(statuspage.status, 'warning');
  assert.deepEqual(statuspage.fix, {
    label: 'Finish setting up Statuspage', tool: 'reconnect_service', arguments: { agentId: 'agent_ops', connectionId: statuspage.connectionId },
  }, 'a custom connection waiting for its key gets its link, not Admin');
  assert.equal(checked.healthy, false);
  assertNoInternalIds(JSON.stringify(checked), f);

  const outcomes: Array<[ConnectionCheckOutcome, string, string, string, boolean]> = [
    [{ kind: 'ok', url: 'https://acme.zendesk.com/api/', status: 200 }, 'ok', 'Answered with HTTP 200.', 'It answered.', false],
    [{ kind: 'path_not_found', url: 'https://acme.zendesk.com/api/', status: 404, detail: 'Not Found' }, 'warning',
      'The service answered, but the path Chickpea checks was not found. HTTP 404. Not Found',
      'The service answered, but the path Chickpea checks was not found.', false],
    [{ kind: 'inconclusive', url: 'https://acme.zendesk.com/api/', detail: 'Redirected to a sign-in page.' }, 'unknown',
      'The check could not tell whether it works. Redirected to a sign-in page.', 'The check could not tell whether it works.', false],
    [{ kind: 'not_permitted', url: 'https://acme.zendesk.com/api/', status: 403, detail: 'Forbidden' }, 'failing',
      'The saved key works but lacks permission. HTTP 403. Forbidden', 'The saved key works but lacks permission.', true],
  ];
  for (const [outcome, status, detail, plain, fixed] of outcomes) {
    checks.connection_zendesk = outcome;
    const row = part(await check(call, { agentId: 'agent_ops' }), 'connection').find(({ name }) => name === 'Zendesk')!;
    assert.deepEqual([row.status, row.detail, row.plain, row.fix?.tool], [status, detail, plain, fixed ? 'reconnect_service' : undefined], outcome.kind);
  }
});

test('check_agent reports a custom connection it could not test as unknown, never as connected', async (t) => {
  const { f, teamId, call, tested } = await harness(t, 'untestable', { untestable: true });
  await seedOps(f, teamId);
  const rows = part(await check(call, { agentId: 'agent_ops' }), 'connection');
  assert.deepEqual(tested, []);
  for (const name of ['Zendesk', 'Docs MCP']) {
    const row = rows.find((entry) => entry.name === name)!;
    assert.deepEqual([row.status, row.detail, row.plain, row.fix],
      ['unknown', 'Connection testing is unavailable.', 'The check could not tell whether it works.', undefined], name);
  }
});

test('check_agent reports an id two connections share as unknown, in words a 5.0 client can act on', async (t) => {
  const { f, teamId, call, tested } = await harness(t, 'shared-id');
  await seedOps(f, teamId);
  // An API connection with the Docs MCP server's provider id: both rows are `docs`.
  await f.config.putConnectionAccount({
    id: 'connection_docs_api', providerId: 'docs', label: 'Docs API', lifecycle: 'ready', ownerKind: 'team',
    workspaceId: teamId, createdByMembershipId: f.owner.membership.id, secretRefId: 'secret_connection_docs_api',
    policy: {
      kind: 'api', allowedHosts: ['api.docs.example'], pathPrefixes: ['/v1/'], headerName: 'Authorization',
      allowedMethods: ['GET'], authMode: 'credential',
    },
  } as never, 0);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_ops', connectionAccountId: 'connection_docs_api', providerId: 'docs', allowedCapabilities: [], enabled: true,
  });
  const shared = part(await check(call, { agentId: 'agent_ops' }), 'connection').filter(({ connectionId }) => connectionId === 'docs');
  assert.deepEqual(shared.map(({ name }) => name).sort(), ['Docs API', 'Docs MCP']);
  assert.equal(tested.includes('docs'), false, 'nothing was sent for an id that names two connections');
  for (const row of shared) {
    assert.equal(row.status, 'unknown', row.name);
    assert.match(row.detail, /^More than one connection uses docs, so Chickpea could not tell which one to test\./, row.name);
  }
});

test('check_agent reports Slack presence and each Channel grant', async (t) => {
  const { f, teamId, call } = await harness(t, 'slack');
  await seedOps(f, teamId, { slackPresence: { ...PRESENCE, health: 'needs_attention', errorCode: 'handle_collision' } });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_NEW', agentId: 'agent_ops', status: 'pending',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'new', channelIsPrivate: false,
  });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_GONE', agentId: 'agent_ops', status: 'needs_attention',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'gone', channelIsPrivate: false,
  });
  const checked = await check(call, { agentId: 'agent_ops' });
  assert.deepEqual(part(checked, 'slack'), [{
    part: 'slack', name: '@ops', status: 'failing', detail: 'Another Slack group already uses this handle.',
    plain: 'Another Slack group already uses this handle.',
    fix: { label: 'Retry in Admin', url: `${BASE_URL}/admin/agents/agent_ops` },
  }]);
  assert.deepEqual(new Map(part(checked, 'channel').map(({ name, status }) => [name, status])), new Map([
    ['#gone', 'failing'], ['#new', 'failing'], ['#support', 'ok'],
  ]));
  assert.ok(part(checked, 'channel').find(({ name }) => name === '#gone')?.fix);
});

test('a Channel add held by the Agent\'s failed Slack presence says why, not that it is still joining', async (t) => {
  const { f, teamId, call } = await harness(t, 'held-add');
  // A free Slack plan: the bot joined the Channel, but Slack refused the handle, so the grant stayed pending.
  await seedOps(f, teamId, { slackPresence: { ...PRESENCE, health: 'needs_attention', errorCode: 'paid_plan_required' } });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_NEW', agentId: 'agent_ops', status: 'pending',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'new', channelIsPrivate: false,
  });
  const paidPlan = 'Slack needs a paid plan before an Agent can have its own handle.';
  const held = part(await check(call, { agentId: 'agent_ops' }), 'channel').find(({ channelId }) => channelId === 'C_NEW');
  assert.deepEqual([held?.status, held?.detail, held?.fix], ['failing', `Not in this Channel yet. ${paidPlan}`,
    { label: 'Retry in Admin', url: `${BASE_URL}/admin/agents/agent_ops` }]);
  const admission = part(await check(call, { agentId: 'agent_ops', place: 'C_NEW' }), 'admission')[0]!;
  assert.deepEqual([admission.status, admission.detail], ['failing', `Ops is not in this Channel yet. ${paidPlan}`]);
  const listed = async () => (structured(await call('list_slack_channels', {})).channels as Array<{ channelId: string; agents: Array<{ status: string }> }>)
    .find(({ channelId }) => channelId === 'C_NEW')?.agents[0]?.status;
  assert.equal(await listed(), 'needs_attention');

  // An add refused because the person adding it was not in the Channel names that, not the generic failure.
  await f.config.updateAgent('agent_ops', { slackPresence: { ...PRESENCE, health: 'needs_attention', errorCode: 'channel_membership_required' } } as never);
  const outsider = part(await check(call, { agentId: 'agent_ops' }), 'channel').find(({ channelId }) => channelId === 'C_NEW');
  assert.equal(outsider?.detail, 'Not in this Channel yet. Whoever adds it to a Channel must be in that Slack Channel.');

  // While the handle is still being made, the same grant is joining.
  await f.config.updateAgent('agent_ops', { slackPresence: { ...PRESENCE, health: 'pending' } } as never);
  const joining = part(await check(call, { agentId: 'agent_ops' }), 'channel').find(({ channelId }) => channelId === 'C_NEW');
  assert.deepEqual([joining?.status, joining?.detail], ['warning', 'Still joining this Channel.']);
  assert.equal(await listed(), 'joining');
});

test('check_agent reports a schedule\'s next run and the failures in its stored runs', async (t) => {
  const { f, teamId, call } = await harness(t, 'schedules');
  await seedOps(f, teamId);
  await applyThroughAdapter(f, ownerMcpContext(f), 'save-triage', [{
    itemId: 'triage', kind: 'save_routine', requiredConnectionAccountIds: [], agentId: 'agent_ops', workspaceId: teamId,
    channelId: 'C_SUPPORT', name: 'Morning triage', description: '', taskText: 'Summarize urgent requests.',
    schedule: { kind: 'cron', expression: '0 9 * * 1-5' }, timezone: 'UTC', outputPolicy: 'post',
  } as never]);
  const [routine] = await f.routines.listRoutines(teamId, 'C_SUPPORT');
  const settle = async (
    id: string, at: number, to: 'failed' | 'succeeded', publicError?: string,
    failureClass: 'credential_unavailable' | 'channel_destination_unavailable' = 'credential_unavailable',
  ) => {
    const run = await f.routines.createOccurrence({
      runId: id, idempotencyKey: `run:${id}`, routineId: routine!.id, routineVersion: routine!.version,
      scheduledFor: at, triggerSource: 'schedule', queuedAt: at, deadlineAt: at + 60_000,
    } as never);
    await f.routines.startAdmissionAttempt({ occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: at, leaseUntil: at + 30_000 } as never);
    if (to === 'succeeded') await f.routines.transitionRun({ occurrenceId: run.id, from: ['admitting'], to: 'running', at: at + 1 });
    await f.routines.transitionRun({
      occurrenceId: run.id, from: ['admitting', 'running'], to, at: at + 2,
      ...(to === 'failed' ? { failureClass, publicError: publicError ?? null } : {}),
    });
  };
  await settle('rrun_old', NOW - 3 * 86_400_000, 'failed', 'Zendesk rejected the key.');
  await settle('rrun_ok', NOW - 2 * 86_400_000, 'succeeded');
  const recovered = part(await check(call, { agentId: 'agent_ops' }), 'schedule');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.status, 'warning', 'an earlier failure after which a run succeeded');
  assert.match(recovered[0]!.detail, /^1 of its last 2 runs failed: Zendesk rejected the key\. Next run /);
  assert.match(recovered[0]!.plain!, /^1 of its last 2 runs failed\. Next run /, 'a card leaves out the run\'s error');
  assert.equal(recovered[0]!.scheduleId, routine!.id);

  await settle('rrun_new', NOW - 86_400_000, 'failed', 'Zendesk rejected the key.');
  const [failing] = part(await check(call, { agentId: 'agent_ops' }), 'schedule');
  assert.equal(failing!.status, 'failing');
  assert.match(failing!.detail, /^Its last run failed: Zendesk rejected the key\. Next run /);
  assert.match(failing!.plain!, /^Its last run failed\. Next run /);
  assert.equal(failing!.fix?.url, `${BASE_URL}/admin/agents/agent_ops`);

  // A paused schedule's stored reason is a lifecycle code: the model gets it, a card does not.
  await settle('rrun_gone', NOW - 3_600_000, 'failed', 'The Channel is gone.', 'channel_destination_unavailable');
  const [paused] = part(await check(call, { agentId: 'agent_ops' }), 'schedule');
  assert.deepEqual([paused!.status, paused!.detail, paused!.plain], ['warning', 'Paused. channel_destination_unavailable', 'Paused.']);
});

test('check_agent reports GitHub access for each repository, and website logins with when each was last used', async (t) => {
  const { f, teamId, call } = await harness(t, 'repositories');
  await seedOps(f, teamId, {
    repositories: [
      { id: 'repo_api', installationId: null, accountLogin: 'acme', fullName: 'acme/api', enabled: true },
      { id: 'repo_web', installationId: 42, accountLogin: 'acme', fullName: 'acme/web', enabled: true },
    ],
  });
  const disconnected = await check(call, { agentId: 'agent_ops' });
  assert.deepEqual(part(disconnected, 'repository').map(({ name, status, fix }) => [name, status, fix?.url]), [
    ['GitHub', 'failing', `${BASE_URL}/admin/settings/github`],
  ]);
  const [login] = part(disconnected, 'website_login');
  assert.equal(login!.status, 'failing');
  assert.equal(login!.detail, 'No hosted browser is connected, so it cannot sign in. Not used yet.');

  const { loginId } = (await f.config.getAgent('agent_ops')).websiteLogins![0]!;
  await touchWebsiteLoginUsed(f.settings as never, loginId, Date.UTC(2026, 10, 2, 9));
  const [used] = part(await check(call, { agentId: 'agent_ops' }), 'website_login');
  assert.deepEqual([used!.loginId, used!.detail], [loginId, 'No hosted browser is connected, so it cannot sign in. Last used Nov 2, 2026.']);

  const saved = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY };
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-real-key';
  t.after(() => {
    for (const [name, value] of [['GITHUB_APP_ID', saved.id], ['GITHUB_APP_PRIVATE_KEY', saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const connected = await check(call, { agentId: 'agent_ops' });
  const repositories = part(connected, 'repository');
  assert.deepEqual(repositories.map(({ name, status }) => [name, status]), [['acme/api', 'failing'], ['acme/web', 'ok']]);
  assert.deepEqual(repositories[0]!.fix, {
    label: 'Give GitHub access in Admin',
    url: `${new URL(BASE_URL).origin}/admin/agents/agent_ops`,
  });
  assert.ok(!JSON.stringify(connected).includes('not-a-real-key'), 'the GitHub App key never leaves');
});

test('check_agent\'s admission: who may DM it, the Agent\'s state, the Channel grant and when the front desk decides', async (t) => {
  const { f, teamId, call } = await harness(t, 'admission');
  await seedOps(f, teamId);
  const admission = async (args: Record<string, unknown>) => part(await check(call, { agentId: 'agent_ops', ...args }), 'admission')[0]!;

  const publicDm = await admission({});
  assert.equal(publicDm.status, 'ok');
  assert.match(publicDm.detail, /everyone in the workspace may DM it\. A DM to Chickpea goes first to the default Agent, whose front desk/);
  await f.config.setWorkspaceDefaultAgent(teamId, 'agent_ops');

  // Only in a Channel whose privacy is unknown or private: Slack decides at message time.
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_ops', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support', channelIsPrivate: true,
  });
  const privateOnly = await admission({});
  assert.equal(privateOnly.status, 'unknown');
  assert.match(privateOnly.detail, /Slack says whether this person is one when the message arrives\. It is the workspace's default Agent, so a DM to Chickpea reaches it\.$/);

  // In no Channel: only its creator may DM it.
  await f.config.deleteAgentChannelGrant(teamId, 'C_SUPPORT', 'agent_ops');
  assert.equal((await admission({})).status, 'ok', 'the Owner created it');
  const other = await admission({ asPerson: ADMIN_SLACK_USER });
  assert.equal(other.status, 'failing');
  assert.equal(other.name, 'Admin, in a DM');
  assert.match(other.detail, /only the person who created it may DM it/);
  assert.equal(other.fix?.url, `${BASE_URL}/admin/agents/agent_ops`);

  // A Channel shared with another Agent needs a mention; one the Agent is not in does not reach it.
  for (const agentId of ['agent_ops', 'agent_other']) {
    if (agentId === 'agent_other') await createFixtureAgent(f, agentId, { name: 'Other' });
    await f.config.putAgentChannelGrant({
      workspaceId: teamId, channelId: 'C_SUPPORT', agentId, status: 'active',
      createdByMembershipId: f.owner.membership.id, channelLabel: 'support', channelIsPrivate: false,
    });
  }
  const shared = await admission({ place: 'C_SUPPORT' });
  assert.deepEqual([shared.status, shared.name, shared.channelId], ['ok', 'you, in #support', 'C_SUPPORT']);
  assert.match(shared.detail, /^2 Agents answer here, so a message reaches it when it mentions @ops\.$/);
  assert.equal((await admission({ place: 'C_ELSEWHERE' })).status, 'failing');

  await f.config.updateAgent('agent_ops', { enabled: false });
  const off = await admission({});
  assert.deepEqual([off.status, off.detail, off.fix], ['failing', 'Ops is turned off, so it answers no one.',
    { label: 'Turn it back on', tool: 'update_agent', arguments: { agentId: 'agent_ops', on: true } }], 'turning it on, not Admin');
});

test('a member checks and explains only the Agents they may edit, and only as themselves', async (t) => {
  const { f, teamId, call } = await harness(t, 'member', { as: 'member' });
  await seedOps(f, teamId);
  for (const tool of ['explain_agent', 'check_agent']) {
    assert.equal(errorOf(await call(tool, { agentId: 'agent_ops' })).code, 'not_found', `${tool}: the Owner's Agent`);
  }
  await createFixtureAgent(f, 'agent_mine', { name: 'Mine', creatorMembershipId: f.admin.membership.id });
  assert.equal((await explain(call, { agentId: 'agent_mine', asPerson: ADMIN_SLACK_USER })).person.you, true,
    'naming yourself is allowed');
  const checked = await check(call, { agentId: 'agent_mine' });
  assert.ok(checked.checks.length > 0);
  const refused = errorOf(await call('check_agent', { agentId: 'agent_mine', asPerson: f.owner.binding.slackUserId }));
  assert.equal(refused.code, 'not_allowed');
});

test('the service hands a member the stores only for an Agent they may edit', async (t) => {
  const { f, teamId, context } = await harness(t, 'reader', { as: 'member' });
  await seedOps(f, teamId);
  await createFixtureAgent(f, 'agent_mine', { name: 'Mine', creatorMembershipId: f.admin.membership.id });
  await assert.rejects(f.service.agentReader(context, 'agent_ops'), (error: { code?: string }) => error.code === 'forbidden');
  assert.equal((await f.service.agentReader(context, 'agent_mine')).agent.id, 'agent_mine');
});

test('a member never learns a private Channel Admin hides from them, even one their Agent is in', async (t) => {
  const { f, teamId, call } = await harness(t, 'member-private', {
    as: 'member',
    slackChannels: { C_SECRET: { name: 'exec-secret', private: true }, C_OPEN: { name: 'open', private: false } },
  });
  await createFixtureAgent(f, 'agent_mine', { name: 'Mine', creatorMembershipId: f.admin.membership.id });
  for (const [channelId, label, isPrivate] of [['C_SECRET', 'exec-secret', true], ['C_OPEN', 'open', false]] as const) {
    await f.config.putChannel({ workspaceId: teamId, channelId, label, lifecycle: 'active' });
    await f.config.putAgentChannelGrant({
      workspaceId: teamId, channelId, agentId: 'agent_mine', status: 'active',
      createdByMembershipId: f.owner.membership.id, channelLabel: label, channelIsPrivate: isPrivate,
    });
  }
  const agent = structured(await call('get_agent', { agentId: 'agent_mine' })) as { channels: Array<{ channelId: string }> };
  assert.deepEqual(agent.channels.map(({ channelId }) => channelId), ['C_OPEN'], 'get_agent hides it');

  const checked = await check(call, { agentId: 'agent_mine' });
  assert.deepEqual(part(checked, 'channel').map(({ name, channelId }) => [name, channelId]), [['#open', 'C_OPEN']]);
  assert.equal(JSON.stringify(checked).includes('exec-secret'), false);

  const admission = async (place: string) => part(await check(call, { agentId: 'agent_mine', place }), 'admission')[0]!;
  const [secret, nowhere] = [await admission('C_SECRET'), await admission('C_NOWHERE')];
  assert.deepEqual([secret.status, secret.name, secret.detail], ['failing', 'you, in C_SECRET', 'Mine is not added to this Channel.']);
  assert.equal(nowhere.detail, secret.detail, 'as a Channel that does not exist');

  const explainIn = async (place: string) => errorOf(await call('explain_agent', { agentId: 'agent_mine', place }));
  const [refused, missing] = [await explainIn('C_SECRET'), await explainIn('C_NOWHERE')];
  assert.deepEqual(refused, missing, 'explain refuses it as a Channel that does not exist');
  assert.equal(refused.code, 'invalid_input');
  assert.equal(JSON.stringify(refused).includes('exec-secret'), false);
  assert.deepEqual((await explain(call, { agentId: 'agent_mine', place: 'C_OPEN' })).place,
    { kind: 'channel', channelId: 'C_OPEN', name: 'open' });
});
