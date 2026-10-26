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
import { allowedToolsAfterMcpDiscovery } from '../src/config/mcp-access.ts';
import {
  API_CLIENT_FIELDS,
  MCP_CLIENT_FIELDS,
  mcpConnectionsAfterWrite,
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

async function seedRecipeSource(f: Fixture): Promise<{ researcher: CustomAgentConfig; scribe: CustomAgentConfig }> {
  const researcher = await seedAgent(f, 'agent_researcher', {
    name: 'Researcher',
    description: 'Finds and cites sources.',
    editPolicy: 'all_workspace_members',
    instructions: 'Cite every source.',
    model: 'openai/gpt-5.6-terra',
    modelEffort: 'high',
    skills,
    mcpServers: [tracker, notion],
    apiConnections: [billing],
    repositories: [allAcme, docsRepository],
  });
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
    assert.doesNotMatch(JSON.stringify(recipe), /installationId|accountLogin|credentialRef/);

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
    const withoutAllRepositories = recipe.agents.map((agent) => ({
      ...agent,
      repositoryRequirements: agent.repositoryRequirements.filter((requirement) => !('owner' in requirement)),
    }));
    assert.deepEqual(reexported.agents, withoutAllRepositories,
      'the imported Agents match every exported field except the grant Admin must choose');
    const importedResearcher = imported.find(({ name }) => name === 'Researcher')!;
    assert.deepEqual(importedResearcher.repositories, [
      { id: 'docs', installationId: null, accountLogin: 'unconnected', fullName: 'acme/docs', enabled: true },
    ]);
    assert.deepEqual(
      importedResearcher.mcpServers.map(({ id, lifecycleStatus }) => [id, lifecycleStatus]),
      [['tracker', 'pending'], ['notion', 'pending']],
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
    const recipe = await exportRecipe(f, [researcher.id]);
    recipe.agents[0]!.instructions = 'Cite every source twice.';
    const preview = await previewRecipe(f, recipe, 'update');
    assert.deepEqual(preview.agents.map(({ status }) => status), ['update']);
    const applied = await mcpApply(f, { idempotencyKey: 'overwrite', operations: preview.operations });
    assert.equal(applied.status, 'completed', JSON.stringify(applied.outcomes));
    const after = await f.config.getAgent(researcher.id);
    assert.equal(after.instructions, 'Cite every source twice.');
    assert.deepEqual(after.mcpServers, researcher.mcpServers);
    assert.deepEqual(after.apiConnections, researcher.apiConnections);
    assert.deepEqual(after.repositories, researcher.repositories);
  }, readyModels));

test('a recipe overwrite that drops a connection asks first over MCP, then keeps the rest on confirm', () =>
  withFixture('recipe-overwrite-removal', async (f) => {
    const { researcher } = await seedRecipeSource(f);
    const recipe = await exportRecipe(f, [researcher.id]);
    recipe.agents[0]!.mcpRequirements = recipe.agents[0]!.mcpRequirements.filter(({ id }) => id !== 'notion');
    const preview = await previewRecipe(f, recipe, 'update');
    const pending = await mcpApply(f, { idempotencyKey: 'overwrite-removal', operations: preview.operations });
    assert.equal(pending.status, 'confirmation_required', JSON.stringify(pending.outcomes));
    assert.ok((pending.presentation?.markdown ?? '').trim().length > 0, 'the removal has a readable preview');
    assert.deepEqual((await f.config.getAgent(researcher.id)).mcpServers, researcher.mcpServers);

    const confirmed = await mcpTool(f, 'confirm_workspace_change', {
      proposalId: pending.outcomes[0]!.proposalId!,
    }) as ManagementApplyResult;
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed.outcomes));
    assert.deepEqual((await f.config.getAgent(researcher.id)).mcpServers, [researcher.mcpServers[0]]);
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
  }, readyModels));

test('a changed credential policy resets the secret and status, and header policy follows the auth mode', () =>
  withFixture('round-trip-credential-reset', async (f) => {
    const stored = await seedAgent(f, 'agent_reset', { mcpServers: [tracker], apiConnections: [billing] });
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
      return await f.config.getAgent(stored.id);
    };
    const headerPolicy = (connection: McpConnectionConfig) =>
      [connection.credentialHeaderName, connection.credentialValuePrefix, connection.credentialOptional];

    const moved = (await write('repoint', (agent) => ({
      mcpServers: [{ ...agent.mcpServers[0]!, url: 'https://mcp.tracker.example/v2/mcp' }],
    }))).mcpServers[0]!;
    assert.notEqual(moved.credentialRef, stored.mcpServers[0]!.credentialRef, 'a new URL gets a new secret namespace');
    assert.deepEqual([moved.lifecycleStatus, moved.statusText, moved.identity], ['pending', 'Setup required', undefined]);
    assert.deepEqual(moved.discoveredTools, [{ name: 'search' }], 'discovery restarts from the approved tools');
    assert.deepEqual(headerPolicy(moved), ['X-Api-Key', 'Token ', true], 'the header policy stays with the same auth mode');
    assert.equal(moved.toolAccessMode, 'review');

    const unauthenticated = (await write('no-auth', (agent) => ({
      mcpServers: [{ ...agent.mcpServers[0]!, authMode: 'none' }],
    }))).mcpServers[0]!;
    assert.deepEqual(headerPolicy(unauthenticated), [undefined, undefined, undefined], 'a new auth mode drops it');
    assert.notEqual(unauthenticated.credentialRef, moved.credentialRef);

    const apiChanges: Array<[string, Partial<ApiConnectionConfig>]> = [
      ['add-host', { allowedHosts: ['billing.example.test', 'invoices.example.test'] }],
      ['add-path', { pathPrefixes: ['/v1/', '/v2/'] }],
    ];
    for (const [key, change] of apiChanges) {
      const before = (await f.config.getAgent(stored.id)).apiConnections[0]!;
      const after = (await write(key, (agent) => ({
        apiConnections: [{ ...agent.apiConnections[0]!, ...change }],
      }))).apiConnections[0]!;
      assert.notEqual(after.credentialRef, before.credentialRef, `${key} gets a new secret namespace`);
      assert.deepEqual([after.lifecycleStatus, after.statusText, after.identity], ['pending', 'Setup required', undefined],
        `${key} waits for setup`);
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

test('a recipe overwrite names a header credential only Admin can set, without a setup link apply would refuse', () =>
  withFixture('recipe-header-credential', async (f) => {
    const keyed: McpConnectionConfig = {
      id: 'keyed', displayName: 'Keyed', url: 'https://mcp.keyed.example/mcp', transport: 'streamable-http',
      authMode: 'none', headerNames: ['X-Api-Key'], credentialHeaderName: 'X-Api-Key', credentialOptional: false,
      enabled: true, lifecycleStatus: 'ready', statusText: 'Connected',
      discoveredTools: [{ name: 'search' }], allowedTools: ['search'],
    };
    const unreachable: McpConnectionConfig = {
      id: 'open', displayName: 'Open', url: 'https://mcp.open.example/mcp', transport: 'streamable-http',
      authMode: 'none', headerNames: [], enabled: true, lifecycleStatus: 'failed', statusText: 'Unreachable',
      discoveredTools: [{ name: 'search' }], allowedTools: ['search'],
    };
    const agent = await seedAgent(f, 'agent_keyed', { name: 'Keyed', mcpServers: [keyed, unreachable] });
    const recipe = await exportRecipe(f, [agent.id]);
    recipe.agents[0]!.mcpRequirements[0]!.url = 'https://mcp.keyed.example/v2/mcp';
    const preview = await previewRecipe(f, recipe, 'update');
    assert.deepEqual(preview.agents[0]!.setupRequired, ['Keyed (set its credential in Admin)', 'Open'],
      'a connection without a credential is named without the Admin credential note');
    assert.deepEqual(preview.operations.map(({ kind }) => kind), ['update_agent']);
    const applied = await mcpApply(f, { idempotencyKey: 'overwrite-keyed', operations: preview.operations });
    assert.equal(applied.status, 'completed', JSON.stringify(applied.outcomes));
    assert.equal((await f.config.getAgent(agent.id)).mcpServers[0]!.lifecycleStatus, 'pending');
  }, readyModels));
