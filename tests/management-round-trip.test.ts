import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';

import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  resolveConnectionAccountSecret,
  saveConnectionAccountSecret,
} from '../src/config/connector-secrets.ts';
import type {
  ConnectionAccount,
  ConnectionAccountApiPolicy,
  ConnectionAccountMcpPolicy,
  CustomAgentConfig,
  McpConnectionConfig,
  McpConnectionIdentity,
  McpToolInputSchemaProjection,
  RepositoryGrant,
  SkillConfig,
} from '../src/config/types.ts';
import { allowedToolsAfterMcpDiscovery } from '../src/config/mcp-access.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import {
  API_CLIENT_FIELDS,
  MCP_CLIENT_FIELDS,
  mcpConnectionsAfterWrite,
  type ManagementApiConnection,
  type ManagementMcpConnection,
} from '../src/management/agent-connections.ts';
import type { WorkspaceRecipe, WorkspaceRecipePreview } from '../src/management/recipes.ts';
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
  ManagementAgentPatch,
  ManagementApplyResult,
  ManagementOperation,
  ManagementWorkspaceSnapshot,
} from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;
type SnapshotAgent = ManagementWorkspaceSnapshot['agents'][number];

const readyModels: Partial<WorkspaceManagementServiceInput> = {
  modelReadiness: async () => async () => undefined,
};

function schemaProjection(seed: string): McpToolInputSchemaProjection {
  return { propertyNames: ['query'], accountFields: [], ambiguous: false, fingerprint: seed.repeat(64) };
}

/** A connection as Admin stores it, with the server-owned state a management client never writes. */
interface ConnectionSeed<TPolicy extends ConnectionAccountMcpPolicy | ConnectionAccountApiPolicy =
  ConnectionAccountMcpPolicy | ConnectionAccountApiPolicy> {
  providerId: string;
  label: string;
  policy: TPolicy;
  identity?: McpConnectionIdentity;
  credential?: string;
  lifecycle?: ConnectionAccount['lifecycle'];
}

const tracker: ConnectionSeed<ConnectionAccountMcpPolicy> = {
  providerId: 'tracker',
  label: 'Tracker',
  policy: {
    kind: 'mcp',
    url: 'https://mcp.tracker.example/mcp',
    transport: 'streamable-http',
    authMode: 'none',
    headerNames: ['X-Api-Key'],
    credentialHeaderName: 'X-Api-Key',
    credentialValuePrefix: 'Token ',
    discoveredTools: [
      { name: 'search', readOnlyHint: true, inputSchema: schemaProjection('a') },
      { name: 'file_issue', inputSchema: schemaProjection('b') },
    ],
    allowedTools: ['search'],
  },
  identity: { accountName: 'tracker-bot' },
  credential: 'tracker-key',
};

const notion: ConnectionSeed<ConnectionAccountMcpPolicy> = {
  providerId: 'notion',
  label: 'Notion',
  policy: {
    kind: 'mcp',
    url: 'https://mcp.notion.com/mcp',
    transport: 'streamable-http',
    authMode: 'oauth',
    headerNames: [],
    discoveredTools: [{ name: 'search', inputSchema: schemaProjection('c') }],
    toolAccessMode: 'review',
    allowedTools: ['search'],
    oauthScope: 'read',
    oauthAttemptId: '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f',
  },
  identity: { workspaceName: 'Northstar' },
  lifecycle: 'ready',
};

const billing: ConnectionSeed<ConnectionAccountApiPolicy> = {
  providerId: 'billing',
  label: 'Billing',
  policy: {
    kind: 'api',
    allowedHosts: ['billing.example.test'],
    pathPrefixes: ['/v1/'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET'],
    authMode: 'credential',
  },
  identity: { accountName: 'billing@northstar.example' },
  credential: 'sk-billing',
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

function ownerPrincipal(f: Fixture): AuthPrincipal {
  return {
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    authenticatorKind: 'test',
    credentialId: 'round-trip-test',
    correlationId: 'round-trip-test',
    machine: false,
  };
}

let seededIds = 0;

/** Connects an account to the Agent the way Admin does, with its server-owned state already in place. */
async function connect(f: Fixture, agentId: string, seed: ConnectionSeed): Promise<ConnectionAccount> {
  const workspaceId = f.owner.binding.slackTeamId;
  // Updates and removals find the account through the workspace installation.
  await f.config.ensureWorkspaceInstallation({
    workspaceId, teamId: workspaceId, transportMode: 'gateway', appId: 'A_ROUND_TRIP', botUserId: 'U_BOT',
    gatewayBindingId: 'binding_round_trip',
  });
  const service = new ConnectionAccountService({
    config: f.config,
    settings: f.settings,
    // Ascending ids keep seeded connections in the order they were connected.
    randomId: () => (++seededIds).toString(16).padStart(32, '0'),
  });
  const { account } = await service.createForAgent({
    principal: ownerPrincipal(f),
    agentId,
    workspaceId,
    ownerKind: 'team',
    providerId: seed.providerId,
    label: seed.label,
    policy: seed.policy,
    ...(seed.identity ? { identity: seed.identity } : {}),
    ...(seed.credential ? { credential: seed.credential } : {}),
    pendingSetup: true,
  });
  return seed.lifecycle
    ? f.config.putConnectionAccount({ ...account, lifecycle: seed.lifecycle }, account.revision)
    : account;
}

/** The connection accounts bound to the Agent, revoked ones included, by provider id. */
async function accountsOf(f: Fixture, agentId: string): Promise<Map<string, ConnectionAccount>> {
  const bound = new Set((await f.config.listAgentConnectionBindings(agentId))
    .map(({ connectionAccountId }) => connectionAccountId));
  return new Map((await f.config.listConnectionAccounts(f.owner.binding.slackTeamId))
    .filter(({ id }) => bound.has(id))
    .map((account) => [account.providerId, account]));
}

async function accountOf(f: Fixture, agentId: string, providerId: string): Promise<ConnectionAccount> {
  const account = (await accountsOf(f, agentId)).get(providerId);
  assert.ok(account, `${providerId} is a connection account bound to ${agentId}`);
  return account;
}

function secretOf(f: Fixture, account: ConnectionAccount): Promise<string | undefined> {
  return resolveConnectionAccountSecret(account, undefined, f.settings);
}

/** What a completed setup link leaves behind: the credential, and the account in use again. */
async function completeSetup(f: Fixture, account: ConnectionAccount, credential: string): Promise<void> {
  await saveConnectionAccountSecret(account.secretRefId, credential, undefined, f.settings);
  await f.config.putConnectionAccount({ ...account, lifecycle: 'ready', identity: { accountName: 'setup' } },
    account.revision);
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
      repositories: [allAcme, docsRepository],
    });
    for (const seed of [tracker, notion, billing]) await connect(f, stored.id, seed);
    const accountsBefore = await accountsOf(f, stored.id);
    const before = await inspect(f, stored.id);
    assert.deepEqual(before.mcpServers.map(({ id }) => id), ['tracker', 'notion']);
    assert.deepEqual(before.apiConnections.map(({ id }) => id), ['billing']);
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

    const accountsAfter = await accountsOf(f, stored.id);
    const renamed = accountsAfter.get('tracker')!;
    const previous = accountsBefore.get('tracker')!;
    assert.deepEqual(
      [renamed.id, renamed.secretRefId, renamed.label, renamed.lifecycle, renamed.identity, renamed.policy],
      [previous.id, previous.secretRefId, 'Issue tracker', 'ready', tracker.identity, tracker.policy],
      'the renamed account keeps its secret slot, status, identity, header policy and discovered tool schemas',
    );
    assert.equal(await secretOf(f, renamed), tracker.credential);
    assert.deepEqual(accountsAfter.get('notion'), accountsBefore.get('notion'),
      'the OAuth connection in review mode is not written');
    assert.deepEqual(accountsAfter.get('billing'), accountsBefore.get('billing'),
      'the API connection is not written');
    assert.equal(await secretOf(f, accountsAfter.get('billing')!), billing.credential);
    const after = await f.config.getAgent(stored.id);
    assert.deepEqual(after.skills, stored.skills);
    assert.deepEqual(after.repositories, stored.repositories);

    const reread = await inspect(f, stored.id);
    assert.deepEqual(reread, {
      ...before,
      revision: before.revision + 1,
      configurationGeneration: before.configurationGeneration! + 1,
      mcpServers: before.mcpServers.map((connection) =>
        connection.id === 'tracker' ? { ...connection, displayName: 'Issue tracker' } : connection),
      connections: before.connections?.map((connection) =>
        connection.providerId === 'tracker' ? { ...connection, label: 'Issue tracker' } : connection),
    });
  }));

test('a client cannot forge connection status or discovered tools', () =>
  withFixture('round-trip-forgery', async (f) => {
    const { credential: _credential, ...withoutCredential } = tracker;
    const stored = await seedAgent(f, 'agent_guarded');
    const seeded = await connect(f, stored.id, {
      ...withoutCredential,
      policy: {
        ...tracker.policy,
        discoveredTools: [{ name: 'search', inputSchema: schemaProjection('a') }],
        toolAccessMode: 'review',
      },
    });
    assert.equal(seeded.lifecycle, 'pending', 'the tracker waits for its header credential');
    const forgedTools = [
      { name: 'search', inputSchema: schemaProjection('f') },
      { name: 'delete_everything', inputSchema: schemaProjection('f') },
    ];

    const current = await inspect(f, stored.id);
    const [clientConnection] = current.mcpServers;
    assert.ok(clientConnection);
    const accepts = (connection: Record<string, unknown>) => applyWorkspaceChangesZodSchema.safeParse({
      idempotencyKey: 'forge-over-mcp',
      operations: [{
        itemId: 'forge',
        kind: 'update_agent',
        agentId: stored.id,
        expectedRevision: current.revision,
        patch: { mcpServers: [connection] },
      }],
    }).success;
    assert.equal(accepts({ ...clientConnection }), true, 'the MCP schema accepts the client fields');
    assert.equal(accepts({ ...clientConnection, lifecycleStatus: 'ready' }), false,
      'the MCP schema refuses lifecycleStatus');
    assert.equal(accepts({ ...clientConnection, discoveredTools: forgedTools }), false,
      'the MCP schema refuses discoveredTools');

    const forgedExisting: McpConnectionConfig = {
      ...clientConnection,
      lifecycleStatus: 'ready',
      statusText: 'Connected',
      discoveredTools: forgedTools,
      toolAccessMode: 'auto',
      identity: { accountName: 'someone-else' },
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
        expectedRevision: current.revision,
        patch: { mcpServers: [forgedExisting, forgedNew] },
      }],
    }) as ManagementApplyResult;
    assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), ['applied'],
      JSON.stringify(result.outcomes));

    const accounts = await accountsOf(f, stored.id);
    assert.deepEqual(accounts.get('tracker'), seeded,
      'the existing account keeps its status, discovered tools, review mode, identity and secret slot');
    const added = accounts.get('wiki');
    assert.ok(added?.policy.kind === 'mcp', 'the new connection is an MCP account');
    assert.equal(added.lifecycle, 'pending', 'a new bearer connection waits for its setup');
    assert.deepEqual(added.policy.discoveredTools, [{ name: 'search' }],
      'a new connection starts from the tools the client approved');
    assert.equal(added.policy.toolAccessMode, undefined);
    assert.equal(added.identity, undefined);
    assert.deepEqual((await inspect(f, stored.id)).connectionStatus.map(({ id, lifecycleStatus, statusText }) =>
      [id, lifecycleStatus, statusText]).sort(), [
      ['tracker', 'pending', 'Setup required'],
      ['wiki', 'pending', 'Setup required'],
    ]);
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
    assert.deepEqual([...(await accountsOf(f, agent.id)).values()].map(({ providerId, lifecycle }) =>
      [providerId, lifecycle]), [['wiki', 'pending']]);
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

async function seedRecipeSource(f: Fixture): Promise<{ researcher: CustomAgentConfig; scribe: CustomAgentConfig }> {
  const researcher = await seedAgent(f, 'agent_researcher', {
    name: 'Researcher',
    description: 'Finds and cites sources.',
    editPolicy: 'all_workspace_members',
    instructions: 'Cite every source.',
    model: 'openai/gpt-5.6-terra',
    modelEffort: 'high',
    skills,
    repositories: [allAcme, docsRepository],
  });
  for (const seed of [tracker, notion, billing]) await connect(f, researcher.id, seed);
  const scribe = await seedAgent(f, 'agent_scribe', {
    name: 'Scribe',
    instructions: 'Take notes.',
    enabled: false,
  });
  return { researcher, scribe };
}

async function exportRecipe(f: Fixture, agentIds: string[]): Promise<WorkspaceRecipe> {
  return await mcpTool(f, 'export_workspace_recipe', { agentIds }) as WorkspaceRecipe;
}

async function previewRecipe(
  f: Fixture,
  recipe: WorkspaceRecipe,
  agentStrategy?: 'clone' | 'update' | 'skip',
): Promise<WorkspaceRecipePreview> {
  return await mcpTool(f, 'preview_workspace_recipe', {
    recipe,
    ...(agentStrategy ? { agentStrategy } : {}),
  }) as WorkspaceRecipePreview;
}

test('a recipe exported over MCP previews and applies into another workspace in one call', async () => {
  const source = await createManagementAdapterFixture('recipe-source', readyModels);
  const target = await createManagementAdapterFixture('recipe-target', readyModels);
  try {
    const { researcher, scribe } = await seedRecipeSource(source);
    const recipe = await exportRecipe(source, [researcher.id, scribe.id]);
    const [exported] = recipe.agents;
    assert.equal(exported!.description, 'Finds and cites sources.');
    assert.equal(exported!.editPolicy, 'all_workspace_members');
    assert.equal(exported!.modelEffort, 'high');
    assert.deepEqual(exported!.skills, skills);
    assert.deepEqual(exported!.repositoryRequirements, [
      { id: 'all-acme', owner: 'acme', allRepos: true, enabled: true },
      { id: 'docs', fullName: 'acme/docs', enabled: true },
    ]);
    assert.deepEqual(exported!.mcpRequirements.map(({ id }) => id), ['tracker', 'notion'],
      'a connection exports under its provider id');
    assert.doesNotMatch(JSON.stringify(recipe), /installationId|accountLogin|credentialRef|secretRefId|connection_/);

    const preview = await previewRecipe(target, recipe);
    assert.deepEqual(preview.agents.map(({ status }) => status), ['create', 'create']);
    assert.deepEqual(preview.agents[0]!.unavailable, []);
    assert.deepEqual(preview.agents[0]!.setupRequired, [
      'Tracker', 'Notion', 'Billing', 'All repositories of acme (grant in Admin)', 'acme/docs',
    ]);
    const creations = preview.operations.filter((operation) => operation.kind === 'create_agent');
    for (const creation of creations) {
      assert.deepEqual(
        [creation.agent.mcpServers, creation.agent.apiConnections, creation.agent.repositories],
        [[], [], []],
        'each base creation carries no capability',
      );
    }

    const applied = await mcpApply(target, { idempotencyKey: 'import-recipe', operations: preview.operations });
    assert.equal(applied.status, 'completed', JSON.stringify(applied.outcomes));
    const dispositions = Object.fromEntries(applied.outcomes.map(({ itemId, disposition }) => [itemId, disposition]));
    assert.ok(Object.values(dispositions).every((disposition) =>
      disposition === 'applied' || disposition === 'setup_required'), JSON.stringify(dispositions));
    const setupTargets = applied.outcomes
      .filter(({ disposition, setupUrl }) => disposition === 'setup_required' && setupUrl)
      .map(({ itemId }) => itemId);
    assert.deepEqual(setupTargets, [
      'setup_agent_1_mcp_tracker',
      'setup_agent_1_mcp_notion',
      'setup_agent_1_api_billing',
      'setup_agent_1_repo_docs',
    ]);

    const imported = (await target.config.listUserAgents())
      .filter(({ name }) => name === 'Researcher' || name === 'Scribe');
    assert.equal(imported.length, 2);
    const reexported = await exportRecipe(target, imported.map(({ id }) => id));
    // Connections list in account id order, which differs between workspaces.
    const byConnectionId = (agents: WorkspaceRecipe['agents']) => agents.map((agent) => ({
      ...agent,
      mcpRequirements: [...agent.mcpRequirements].sort((left, right) => left.id.localeCompare(right.id)),
    }));
    const withoutAllRepositories = recipe.agents.map((agent) => ({
      ...agent,
      repositoryRequirements: agent.repositoryRequirements.filter((requirement) => !('owner' in requirement)),
    }));
    assert.deepEqual(byConnectionId(reexported.agents), byConnectionId(withoutAllRepositories),
      'the imported Agents match every exported field except the grant Admin must choose');
    const importedResearcher = imported.find(({ name }) => name === 'Researcher')!;
    assert.deepEqual(importedResearcher.repositories, [
      { id: 'docs', installationId: null, accountLogin: 'unconnected', fullName: 'acme/docs', enabled: true },
    ]);
    assert.deepEqual(
      [...(await accountsOf(target, importedResearcher.id)).values()]
        .map(({ providerId, lifecycle }) => [providerId, lifecycle]).sort(),
      [['billing', 'pending'], ['notion', 'pending'], ['tracker', 'pending']],
    );
  } finally {
    source.close();
    target.close();
  }
});

test('a recipe never binds a GitHub installation the workspace already has', async () => {
  const source = await createManagementAdapterFixture('recipe-source-installed', readyModels);
  const target = await createManagementAdapterFixture('recipe-target-installed', readyModels);
  try {
    const { researcher } = await seedRecipeSource(source);
    const recipe = await exportRecipe(source, [researcher.id]);
    const builderRepositories: RepositoryGrant[] = [
      { id: 'all-acme', installationId: 7, accountLogin: 'acme', fullName: '', allRepos: true, enabled: true },
      { id: 'docs', installationId: 7, accountLogin: 'acme', fullName: 'acme/docs', enabled: true },
    ];
    const builder = await seedAgent(target, 'agent_builder', { name: 'Builder', repositories: builderRepositories });

    const preview = await previewRecipe(target, recipe);
    assert.deepEqual(preview.agents[0]!.setupRequired.filter((label) => /acme/.test(label)), [
      'All repositories of acme (grant in Admin)',
      'acme/docs',
    ]);
    const configure = preview.operations.find((operation) => operation.kind === 'update_agent');
    assert.ok(configure?.kind === 'update_agent');
    assert.deepEqual(configure.patch.repositories, [
      { id: 'docs', installationId: null, accountLogin: 'unconnected', fullName: 'acme/docs', enabled: true },
    ]);

    const applied = await mcpApply(target, { idempotencyKey: 'import-installed', operations: preview.operations });
    assert.equal(applied.status, 'completed', JSON.stringify(applied.outcomes));
    assert.equal(
      applied.outcomes.find(({ itemId }) => itemId === 'setup_agent_1_repo_docs')?.disposition,
      'setup_required',
    );
    const imported = (await target.config.listUserAgents()).find(({ name }) => name === 'Researcher')!;
    assert.deepEqual(imported.repositories.map(({ id, installationId }) => [id, installationId]), [['docs', null]]);
    assert.deepEqual((await target.config.getAgent(builder.id)).repositories, builderRepositories);
  } finally {
    source.close();
    target.close();
  }
});

test('a recipe overwrite keeps the existing connections\' secrets and status', () =>
  withFixture('recipe-overwrite', async (f) => {
    const { researcher } = await seedRecipeSource(f);
    const accountsBefore = await accountsOf(f, researcher.id);
    const recipe = await exportRecipe(f, [researcher.id]);
    recipe.agents[0]!.instructions = 'Cite every source twice.';
    const preview = await previewRecipe(f, recipe, 'update');
    assert.deepEqual(preview.agents.map(({ status }) => status), ['update']);
    const applied = await mcpApply(f, { idempotencyKey: 'overwrite', operations: preview.operations });
    assert.equal(applied.status, 'completed', JSON.stringify(applied.outcomes));
    const after = await f.config.getAgent(researcher.id);
    assert.equal(after.instructions, 'Cite every source twice.');
    assert.deepEqual(await accountsOf(f, researcher.id), accountsBefore, 'no connection account is written');
    assert.equal(await secretOf(f, accountsBefore.get('tracker')!), tracker.credential);
    assert.equal(await secretOf(f, accountsBefore.get('billing')!), billing.credential);
    assert.deepEqual(after.repositories, researcher.repositories);
  }, readyModels));

test('a recipe overwrite that drops a connection asks first over MCP, then keeps the rest on confirm', () =>
  withFixture('recipe-overwrite-removal', async (f) => {
    const { researcher } = await seedRecipeSource(f);
    const accountsBefore = await accountsOf(f, researcher.id);
    const recipe = await exportRecipe(f, [researcher.id]);
    recipe.agents[0]!.mcpRequirements = recipe.agents[0]!.mcpRequirements.filter(({ id }) => id !== 'notion');
    const preview = await previewRecipe(f, recipe, 'update');
    const pending = await mcpApply(f, { idempotencyKey: 'overwrite-removal', operations: preview.operations });
    assert.equal(pending.status, 'confirmation_required', JSON.stringify(pending.outcomes));
    assert.ok((pending.presentation?.markdown ?? '').trim().length > 0, 'the removal has a readable preview');
    assert.deepEqual(await accountsOf(f, researcher.id), accountsBefore, 'nothing changes before the confirmation');

    const confirmed = await mcpTool(f, 'confirm_workspace_change', {
      proposalId: pending.outcomes[0]!.proposalId!,
    }) as ManagementApplyResult;
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed.outcomes));
    const after = await accountsOf(f, researcher.id);
    assert.equal(after.get('notion')?.lifecycle, 'revoked');
    assert.deepEqual(after.get('tracker'), accountsBefore.get('tracker'));
    assert.deepEqual(after.get('billing'), accountsBefore.get('billing'));
    assert.equal(await secretOf(f, after.get('tracker')!), tracker.credential);
    assert.deepEqual((await inspect(f, researcher.id)).mcpServers.map(({ id }) => id), ['tracker']);
  }, readyModels));

test('a recipe overwrite that disables an Agent in Channels asks first over MCP', () =>
  withFixture('recipe-overwrite-disable', async (f) => {
    const { researcher } = await seedRecipeSource(f);
    const workspaceId = f.owner.binding.slackTeamId;
    await f.config.putChannel({ workspaceId, channelId: 'C_RESEARCH', label: 'research', lifecycle: 'active' });
    await f.config.putAgentChannelGrant({
      workspaceId,
      channelId: 'C_RESEARCH',
      agentId: researcher.id,
      status: 'active',
      createdByMembershipId: f.owner.membership.id,
      channelLabel: 'research',
    });
    const recipe = await exportRecipe(f, [researcher.id]);
    recipe.agents[0]!.enabled = false;
    const preview = await previewRecipe(f, recipe, 'update');
    const pending = await mcpApply(f, { idempotencyKey: 'overwrite-disable', operations: preview.operations });
    assert.equal(pending.status, 'confirmation_required', JSON.stringify(pending.outcomes));
    assert.equal((await f.config.getAgent(researcher.id)).enabled, true);

    const confirmed = await mcpTool(f, 'confirm_workspace_change', {
      proposalId: pending.outcomes[0]!.proposalId!,
    }) as ManagementApplyResult;
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed.outcomes));
    assert.equal((await f.config.getAgent(researcher.id)).enabled, false);
    assert.deepEqual((await f.config.listAgentChannelGrants(workspaceId, 'C_RESEARCH'))
      .map(({ agentId, status }) => [agentId, status]), [[researcher.id, 'active']], 'the Channel grant stays');
  }, readyModels));

test('a changed credential policy resets the secret and status, and header policy follows the auth mode', () =>
  withFixture('round-trip-credential-reset', async (f) => {
    const stored = await seedAgent(f, 'agent_reset');
    const seededTracker = await connect(f, stored.id, tracker);
    const seededBilling = await connect(f, stored.id, billing);
    const write = async (key: string, patch: (agent: SnapshotAgent) => ManagementAgentPatch) => {
      const current = await inspect(f, stored.id);
      const result = await mcpApply(f, {
        idempotencyKey: key,
        operations: [{
          itemId: key, kind: 'update_agent', agentId: current.id, expectedRevision: current.revision,
          patch: patch(current),
        }],
      });
      assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), ['applied'], JSON.stringify(result.outcomes));
    };
    const statusOf = async (id: string) => {
      const status = (await inspect(f, stored.id)).connectionStatus.find((connection) => connection.id === id);
      return [status?.lifecycleStatus, status?.statusText, status?.identity];
    };
    const trackerAccount = async () => {
      const account = await accountOf(f, stored.id, 'tracker');
      assert.equal(account.id, seededTracker.id, 'the tracker stays one connection account');
      assert.ok(account.policy.kind === 'mcp');
      return { account, policy: account.policy };
    };
    const headerPolicy = (policy: ConnectionAccountMcpPolicy) =>
      [policy.credentialHeaderName, policy.credentialValuePrefix, policy.credentialOptional];

    await write('repoint', (agent) => ({
      mcpServers: [{ ...agent.mcpServers[0]!, url: 'https://mcp.tracker.example/v2/mcp' }],
    }));
    const moved = await trackerAccount();
    assert.equal(await secretOf(f, moved.account), undefined, 'a new URL retires the stored credential');
    assert.deepEqual([moved.account.lifecycle, moved.account.identity], ['pending', undefined]);
    assert.deepEqual(await statusOf('tracker'), ['pending', 'Setup required', undefined]);
    assert.deepEqual(moved.policy.discoveredTools, [{ name: 'search' }], 'discovery restarts from the approved tools');
    assert.deepEqual(headerPolicy(moved.policy), ['X-Api-Key', 'Token ', undefined],
      'the header policy stays with the same auth mode');

    await completeSetup(f, moved.account, 'tracker-key-2');
    await write('bearer', (agent) => ({
      mcpServers: [{ ...agent.mcpServers[0]!, authMode: 'bearer', headerNames: [] }],
    }));
    const bearer = await trackerAccount();
    assert.deepEqual(headerPolicy(bearer.policy), [undefined, undefined, undefined], 'a new auth mode drops it');
    assert.equal(await secretOf(f, bearer.account), undefined, 'a new auth mode retires the stored credential');
    assert.deepEqual(await statusOf('tracker'), ['pending', 'Setup required', undefined]);

    const apiChanges: Array<[string, Partial<ManagementApiConnection>]> = [
      ['add-host', { allowedHosts: ['billing.example.test', 'invoices.example.test'] }],
      ['add-path', { pathPrefixes: ['/v1/', '/v2/'] }],
    ];
    for (const [key, change] of apiChanges) {
      await completeSetup(f, await accountOf(f, stored.id, 'billing'), `sk-${key}`);
      await write(key, (agent) => ({
        apiConnections: [{ ...agent.apiConnections[0]!, ...change }],
      }));
      const after = await accountOf(f, stored.id, 'billing');
      assert.equal(after.id, seededBilling.id);
      assert.equal(await secretOf(f, after), undefined, `${key} retires the stored credential`);
      assert.deepEqual([after.lifecycle, after.identity], ['pending', undefined], `${key} waits for setup`);
      assert.deepEqual(await statusOf('billing'), ['pending', 'Setup required', undefined]);
    }
  }));

test('discovery narrows a non-empty approved tool list, and an empty one counts as never discovered', () => {
  const offered = [{ name: 'search' }, { name: 'delete_everything' }];
  const added = (allowedTools: string[]) => mcpConnectionsAfterWrite([], [{ ...wikiServer, allowedTools }])[0]!;
  assert.deepEqual(allowedToolsAfterMcpDiscovery(added(['search']), offered), ['search']);
  assert.deepEqual(allowedToolsAfterMcpDiscovery(added([]), offered), ['search', 'delete_everything'],
    'outside review mode, the first discovery grants every tool the server offers');
});

test('expectedRevision 0 never reaches an Agent the call has not created', () =>
  withFixture('revision-zero-hardening', async (f) => {
    const create = (id: string): ManagementOperation => ({
      itemId: `create_${id}`,
      kind: 'create_agent',
      agent: {
        id, name: id, instructions: 'Answer.', enabled: true,
        skills: [], mcpServers: [], apiConnections: [], repositories: [],
      },
    });
    const connect = (id: string, dependsOn?: string[]): ManagementOperation => ({
      itemId: `connect_${id}`,
      ...(dependsOn ? { dependsOn } : {}),
      kind: 'update_agent',
      agentId: id,
      expectedRevision: 0,
      patch: { mcpServers: [wikiServer] },
    });
    // No dependsOn, so the generic rule that a dependency must come earlier
    // cannot be what refuses the call.
    const response = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => mcpContext(f),
    }, 'apply_workspace_changes', {
      idempotencyKey: 'connect-before-create',
      operations: [connect('agent_early'), create('agent_early')],
    });
    assert.deepEqual(response, {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'An update_agent with expectedRevision 0 must depend on the create_agent of that Agent earlier in the call.',
      },
    });
    await assert.rejects(() => f.config.getAgent('agent_early'), 'the call writes nothing');

    const taken = await seedAgent(f, 'agent_taken', { name: 'Taken' });
    const failed = await mcpApply(f, {
      idempotencyKey: 'failed-create',
      operations: [create(taken.id), connect(taken.id, [`create_${taken.id}`])],
    });
    assert.deepEqual(failed.outcomes.map(({ itemId, disposition, code }) => [itemId, disposition, code]), [
      ['create_agent_taken', 'failed', 'already_exists'],
      ['connect_agent_taken', 'skipped', 'dependency_not_applied'],
    ]);
    assert.deepEqual(await f.config.getAgent(taken.id), taken, 'the existing Agent with that id is untouched');
  }));

test('a recipe overwrite sends a setup link for a header credential, and none for a connection without one', () =>
  withFixture('recipe-header-credential', async (f) => {
    const keyed: ConnectionSeed<ConnectionAccountMcpPolicy> = {
      providerId: 'keyed',
      label: 'Keyed',
      policy: {
        kind: 'mcp', url: 'https://mcp.keyed.example/mcp', transport: 'streamable-http', authMode: 'none',
        headerNames: ['X-Api-Key'], credentialHeaderName: 'X-Api-Key',
        discoveredTools: [{ name: 'search' }], allowedTools: ['search'],
      },
      credential: 'keyed-key',
    };
    const unreachable: ConnectionSeed<ConnectionAccountMcpPolicy> = {
      providerId: 'open',
      label: 'Open',
      policy: {
        kind: 'mcp', url: 'https://mcp.open.example/mcp', transport: 'streamable-http', authMode: 'none',
        headerNames: [], discoveredTools: [{ name: 'search' }], allowedTools: ['search'],
      },
      lifecycle: 'needs_attention',
    };
    const agent = await seedAgent(f, 'agent_keyed', { name: 'Keyed' });
    const seededKeyed = await connect(f, agent.id, keyed);
    await connect(f, agent.id, unreachable);
    const recipe = await exportRecipe(f, [agent.id]);
    recipe.agents[0]!.mcpRequirements[0]!.url = 'https://mcp.keyed.example/v2/mcp';
    const preview = await previewRecipe(f, recipe, 'update');
    assert.deepEqual(preview.agents[0]!.setupRequired, ['Keyed', 'Open']);
    assert.deepEqual(preview.operations.map((operation) => operation.kind === 'request_setup'
      ? [operation.kind, operation.target.kind === 'mcp_connection' && operation.target.connectionId]
      : [operation.kind]), [['update_agent'], ['request_setup', 'keyed']],
    'only the connection with a credential to enter gets a setup link');
    const applied = await mcpApply(f, { idempotencyKey: 'overwrite-keyed', operations: preview.operations });
    assert.equal(applied.status, 'completed', JSON.stringify(applied.outcomes));
    const setup = applied.outcomes.find(({ operationKind }) => operationKind === 'request_setup');
    assert.ok(setup, JSON.stringify(applied.outcomes));
    assert.equal(setup.disposition, 'setup_required');
    assert.match(setup.setupUrl ?? '', /\/setup\/setup_/);
    const repointed = await accountOf(f, agent.id, 'keyed');
    assert.equal(repointed.id, seededKeyed.id);
    assert.equal(repointed.lifecycle, 'pending');
    assert.equal(await secretOf(f, repointed), undefined, 'the new URL retires the stored header credential');
  }, readyModels));
