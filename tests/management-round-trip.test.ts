import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';

import {
  apiCredentialBinding,
  mcpCredentialBinding,
} from '../src/config/connection-credential-binding.ts';
import type {
  ApiConnectionConfig,
  CustomAgentConfig,
  McpConnectionConfig,
  McpToolInputSchemaProjection,
  RepositoryGrant,
  SkillConfig,
} from '../src/config/types.ts';
import {
  API_CLIENT_FIELDS,
  MCP_CLIENT_FIELDS,
  type ManagementMcpConnection,
} from '../src/management/agent-connections.ts';
import {
  applyWorkspaceChangesValibotSchema,
  applyWorkspaceChangesZodSchema,
  vApiConnection,
  vMcpConnection,
  zApiConnection,
  zMcpConnection,
} from '../src/management/schemas.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
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
} from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;
type SnapshotAgent = ManagementWorkspaceSnapshot['agents'][number];

function schemaProjection(seed: string): McpToolInputSchemaProjection {
  return { propertyNames: ['query'], accountFields: [], ambiguous: false, fingerprint: seed.repeat(64) };
}

const tracker: McpConnectionConfig = {
  id: 'tracker',
  displayName: 'Tracker',
  url: 'https://mcp.tracker.example/mcp',
  transport: 'streamable-http',
  authMode: 'bearer',
  headerNames: ['X-Api-Key'],
  credentialHeaderName: 'X-Api-Key',
  credentialValuePrefix: 'Token ',
  credentialOptional: true,
  enabled: true,
  lifecycleStatus: 'ready',
  statusText: 'Connected · 2 tools',
  discoveredTools: [
    { name: 'search', readOnlyHint: true, inputSchema: schemaProjection('a') },
    { name: 'file_issue', inputSchema: schemaProjection('b') },
  ],
  toolAccessMode: 'review',
  allowedTools: ['search'],
  lastCheckedAt: 1_700_000_000_000,
  identity: { accountName: 'tracker-bot' },
};

const notion: McpConnectionConfig = {
  id: 'notion',
  displayName: 'Notion',
  url: 'https://mcp.notion.com/mcp',
  transport: 'streamable-http',
  authMode: 'oauth',
  headerNames: [],
  enabled: true,
  lifecycleStatus: 'ready',
  statusText: 'Connected',
  discoveredTools: [{ name: 'search', inputSchema: schemaProjection('c') }],
  allowedTools: ['search'],
  oauthScope: 'read',
  oauthAttemptId: 'attempt_1',
  identity: { workspaceName: 'Northstar' },
};

const billing: ApiConnectionConfig = {
  id: 'billing',
  displayName: 'Billing',
  allowedHosts: ['billing.example.test'],
  pathPrefixes: ['/v1/'],
  headerName: 'Authorization',
  headerValuePrefix: 'Bearer ',
  allowedMethods: ['GET'],
  enabled: true,
  authMode: 'credential',
  lifecycleStatus: 'ready',
  statusText: 'Connected',
  identity: { accountName: 'billing@northstar.example' },
};

const skills: SkillConfig[] = [
  {
    name: 'triage',
    description: 'Triage new issues.',
    instructions: 'Sort issues by severity.',
    enabled: true,
    importSource: {
      repository: 'acme/skills',
      commit: 'a'.repeat(40),
      path: 'skills/triage',
      contentSha256: 'b'.repeat(64),
    },
  },
  {
    name: 'weekly-digest',
    description: 'Write the weekly digest.',
    instructions: 'Summarize the week.',
    enabled: false,
    suggestedSkillId: 'weekly-digest',
  },
];

const allAcme: RepositoryGrant = {
  id: 'all-acme',
  installationId: 7,
  accountLogin: 'acme',
  fullName: '',
  allRepos: true,
  enabled: true,
};

const docsRepository: RepositoryGrant = {
  id: 'docs',
  installationId: 7,
  accountLogin: 'acme',
  fullName: 'acme/docs',
  enabled: true,
};

function mcpContext(f: Fixture): ManagementActorContext {
  return {
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'round-trip-test' },
  };
}

/** Calls a tool the way the MCP door does: the SDK validates with the Zod schema first. */
async function mcpTool<TName extends WorkspaceManagementToolName>(
  f: Fixture,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<unknown> {
  const response = await invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => mcpContext(f),
  }, name, args);
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: unknown }).result;
}

async function mcpApply(
  f: Fixture,
  payload: { idempotencyKey: string; operations: unknown[] },
): Promise<ManagementApplyResult> {
  const parsed = applyWorkspaceChangesZodSchema.safeParse(payload);
  assert.equal(parsed.success, true, `the MCP schema accepts the payload: ${parsed.error?.message}`);
  const slack = v.safeParse(applyWorkspaceChangesValibotSchema, payload);
  assert.equal(slack.success, true, 'the Slack schema accepts the payload');
  return await mcpTool(f, 'apply_workspace_changes', {
    idempotencyKey: parsed.data!.idempotencyKey,
    operations: parsed.data!.operations as ManagementOperation[],
  }) as ManagementApplyResult;
}

async function inspect(f: Fixture, agentId: string): Promise<SnapshotAgent> {
  const snapshot = await mcpTool(f, 'inspect_workspace', {}) as ManagementWorkspaceSnapshot;
  const agent = snapshot.agents.find(({ id }) => id === agentId);
  assert.ok(agent, `inspection lists ${agentId}`);
  return agent;
}

async function seedAgent(
  f: Fixture,
  id: string,
  extra: Partial<CustomAgentConfig> = {},
): Promise<CustomAgentConfig> {
  return f.config.createAgent({
    id,
    name: id.replace(/^agent_/, ''),
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
    ...extra,
  });
}

async function withFixture(
  suffix: string,
  run: (f: Fixture) => Promise<void>,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
): Promise<void> {
  const f = await createManagementAdapterFixture(suffix, overrides);
  try {
    await run(f);
  } finally {
    f.close();
  }
}

const SERVER_OWNED_KEYS = [
  'credentialRef',
  'credentialHeaderName',
  'credentialValuePrefix',
  'credentialOptional',
  'lifecycleStatus',
  'statusText',
  'discoveredTools',
  'toolAccessMode',
  'oauthAttemptId',
  'lastCheckedAt',
  'identity',
];

test('both write schemas accept exactly the client connection fields', () => {
  for (const [label, keys, fields] of [
    ['MCP door, MCP server', Object.keys(zMcpConnection.shape), MCP_CLIENT_FIELDS],
    ['Slack door, MCP server', Object.keys(vMcpConnection.entries), MCP_CLIENT_FIELDS],
    ['MCP door, API connection', Object.keys(zApiConnection.shape), API_CLIENT_FIELDS],
    ['Slack door, API connection', Object.keys(vApiConnection.entries), API_CLIENT_FIELDS],
  ] as const) {
    assert.deepEqual([...keys].sort(), [...fields].sort(), label);
  }
});

test('inspect, patch one connection field, apply and inspect again keeps every secret and server fact', () =>
  withFixture('round-trip-inspect', async (f) => {
    const stored = await seedAgent(f, 'agent_ops', {
      name: 'Ops',
      skills,
      mcpServers: [tracker, notion],
      apiConnections: [billing],
      repositories: [allAcme, docsRepository],
    });
    const before = await inspect(f, stored.id);
    for (const connection of [...before.mcpServers, ...before.apiConnections]) {
      for (const key of SERVER_OWNED_KEYS) {
        assert.equal(key in connection, false, `inspection omits ${connection.id}.${key}`);
      }
    }

    const result = await mcpApply(f, {
      idempotencyKey: 'rename-tracker',
      operations: [{
        itemId: 'rename',
        kind: 'update_agent',
        agentId: before.id,
        expectedRevision: before.revision,
        patch: {
          skills: before.skills,
          mcpServers: before.mcpServers.map((connection) =>
            connection.id === 'tracker' ? { ...connection, displayName: 'Issue tracker' } : connection),
          apiConnections: before.apiConnections,
          repositories: before.repositories,
        },
      }],
    });
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), ['applied'],
      JSON.stringify(result.outcomes));

    const after = await f.config.getAgent(stored.id);
    for (const [label, previous, current] of [
      ['tracker', stored.mcpServers[0]!, after.mcpServers[0]!],
      ['notion', stored.mcpServers[1]!, after.mcpServers[1]!],
    ] as const) {
      assert.equal(current.credentialRef, previous.credentialRef, `${label} keeps its secret namespace`);
      assert.equal(mcpCredentialBinding(current), mcpCredentialBinding(previous),
        `${label} keeps its credential binding and header semantics`);
    }
    assert.deepEqual(after.mcpServers[0], { ...stored.mcpServers[0], displayName: 'Issue tracker' });
    assert.deepEqual(after.mcpServers[1], stored.mcpServers[1]);
    assert.equal(after.apiConnections[0]!.credentialRef, stored.apiConnections[0]!.credentialRef);
    assert.equal(apiCredentialBinding(after.apiConnections[0]!), apiCredentialBinding(stored.apiConnections[0]!));
    assert.deepEqual(after.apiConnections, stored.apiConnections);
    assert.deepEqual(after.skills, stored.skills);
    assert.deepEqual(after.repositories, stored.repositories);

    const reread = await inspect(f, stored.id);
    assert.deepEqual(reread, {
      ...before,
      revision: before.revision + 1,
      configurationGeneration: before.configurationGeneration! + 1,
      mcpServers: before.mcpServers.map((connection) =>
        connection.id === 'tracker' ? { ...connection, displayName: 'Issue tracker' } : connection),
    });
  }));

test('a client cannot forge connection status or discovered tools', () =>
  withFixture('round-trip-forgery', async (f) => {
    const pendingTracker: McpConnectionConfig = {
      ...tracker,
      lifecycleStatus: 'pending',
      statusText: 'Setup required',
      discoveredTools: [{ name: 'search', inputSchema: schemaProjection('a') }],
    };
    const stored = await seedAgent(f, 'agent_guarded', { mcpServers: [pendingTracker] });
    const forgedTools = [
      { name: 'search', inputSchema: schemaProjection('f') },
      { name: 'delete_everything', inputSchema: schemaProjection('f') },
    ];

    const clientConnection = {
      id: 'tracker', displayName: 'Tracker', url: tracker.url, transport: 'streamable-http',
      authMode: 'bearer', headerNames: ['X-Api-Key'], enabled: true, allowedTools: ['search'],
    };
    const accepts = (connection: Record<string, unknown>) => applyWorkspaceChangesZodSchema.safeParse({
      idempotencyKey: 'forge-over-mcp',
      operations: [{
        itemId: 'forge',
        kind: 'update_agent',
        agentId: stored.id,
        expectedRevision: stored.revision,
        patch: { mcpServers: [connection] },
      }],
    }).success;
    assert.equal(accepts(clientConnection), true, 'the MCP schema accepts the client fields');
    assert.equal(accepts({ ...clientConnection, lifecycleStatus: 'ready' }), false,
      'the MCP schema refuses lifecycleStatus');
    assert.equal(accepts({ ...clientConnection, discoveredTools: forgedTools }), false,
      'the MCP schema refuses discoveredTools');

    const forgedExisting: McpConnectionConfig = {
      ...pendingTracker,
      lifecycleStatus: 'ready',
      statusText: 'Connected',
      discoveredTools: forgedTools,
      toolAccessMode: 'auto',
    };
    const forgedNew: McpConnectionConfig = {
      id: 'wiki',
      displayName: 'Wiki',
      url: 'https://mcp.wiki.example/mcp',
      transport: 'streamable-http',
      authMode: 'bearer',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'ready',
      statusText: 'Connected',
      discoveredTools: forgedTools,
      allowedTools: ['search'],
      identity: { accountName: 'someone-else' },
    };
    const result = await f.service.applyWorkspaceChanges({
      context: mcpContext(f),
      idempotencyKey: 'forge-through-service',
      operations: [{
        itemId: 'forge',
        kind: 'update_agent',
        agentId: stored.id,
        expectedRevision: stored.revision,
        patch: { mcpServers: [forgedExisting, forgedNew] },
      }],
    }) as ManagementApplyResult;
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), ['applied'],
      JSON.stringify(result.outcomes));

    const [existing, added] = (await f.config.getAgent(stored.id)).mcpServers;
    assert.equal(existing!.lifecycleStatus, 'pending');
    assert.equal(existing!.statusText, 'Setup required');
    assert.deepEqual(existing!.discoveredTools, pendingTracker.discoveredTools);
    assert.equal(existing!.toolAccessMode, 'review');
    assert.equal(existing!.credentialRef, stored.mcpServers[0]!.credentialRef);
    assert.equal(added!.lifecycleStatus, 'pending', 'a new bearer connection waits for its setup');
    assert.deepEqual(added!.discoveredTools, [{ name: 'search' }],
      'a new connection starts from the tools the client approved');
    assert.equal(added!.identity, undefined);
  }));

const wikiServer: ManagementMcpConnection = {
  id: 'wiki',
  displayName: 'Wiki',
  url: 'https://mcp.wiki.example/mcp',
  transport: 'streamable-http',
  authMode: 'bearer',
  headerNames: [],
  enabled: true,
  allowedTools: ['search'],
};

test('a call that creates an Agent configures it at whatever revision publishing left', async () => {
  let config: Fixture['config'] | undefined;
  const f = await createManagementAdapterFixture('create-then-configure', {
    // Publishing a Slack handle writes the new Agent again before the next item runs.
    publishAgentPresence: async ({ agentId }) => {
      const agent = await config!.getAgent(agentId);
      return { agent: await config!.updateAgent(agentId, { description: 'Published.' }, agent.revision) };
    },
  });
  config = f.config;
  try {
    const result = await mcpApply(f, {
      idempotencyKey: 'create-and-configure',
      operations: [
        {
          itemId: 'create',
          kind: 'create_agent',
          agent: {
            id: 'agent_wiki', name: 'Wiki', instructions: 'Answer from the wiki.', enabled: true,
            skills: [], mcpServers: [], apiConnections: [], repositories: [],
          },
        },
        {
          itemId: 'connect',
          dependsOn: ['create'],
          kind: 'update_agent',
          agentId: 'agent_wiki',
          expectedRevision: 0,
          patch: { mcpServers: [wikiServer] },
        },
        {
          itemId: 'setup',
          dependsOn: ['connect'],
          kind: 'request_setup',
          target: { kind: 'mcp_connection', agentId: 'agent_wiki', connectionId: 'wiki' },
        },
      ],
    });
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition),
      ['applied', 'applied', 'setup_required'], JSON.stringify(result.outcomes));
    const agent = await f.config.getAgent('agent_wiki');
    assert.equal(agent.revision, 3, 'creation, publication, then the connection');
    assert.deepEqual(agent.mcpServers.map(({ id, lifecycleStatus }) => [id, lifecycleStatus]), [['wiki', 'pending']]);
  } finally {
    f.close();
  }
});

test('expectedRevision 0 names only an Agent the same call creates first', () =>
  withFixture('revision-zero-scope', async (f) => {
    const existing = await seedAgent(f, 'agent_existing');
    const refused = async (idempotencyKey: string, operations: ManagementOperation[]) => {
      const response = await invokeWorkspaceManagementTool({
        service: f.service,
        resolveContext: async () => mcpContext(f),
      }, 'apply_workspace_changes', { idempotencyKey, operations });
      assert.equal(response.ok, false, JSON.stringify(response));
      return (response as { error: { code: string } }).error.code;
    };
    const connect = (agentId: string, dependsOn?: string[]): ManagementOperation => ({
      itemId: 'connect',
      ...(dependsOn ? { dependsOn } : {}),
      kind: 'update_agent',
      agentId,
      expectedRevision: 0,
      patch: { mcpServers: [wikiServer] },
    });
    assert.equal(await refused('existing-agent', [connect(existing.id)]), 'invalid_request');
    assert.equal(await refused('no-dependency', [
      {
        itemId: 'create',
        kind: 'create_agent',
        agent: {
          id: 'agent_wiki', name: 'Wiki', instructions: 'Answer.', enabled: true,
          skills: [], mcpServers: [], apiConnections: [], repositories: [],
        },
      },
      connect('agent_wiki'),
    ]), 'invalid_request');
    assert.deepEqual((await f.config.getAgent(existing.id)).mcpServers, []);
    await assert.rejects(() => f.config.getAgent('agent_wiki'));
  }));
