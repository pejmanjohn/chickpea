import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import {
  exportWorkspaceRecipe,
  previewWorkspaceRecipe,
} from '../src/management/recipes.ts';
import { ManagementError } from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

test('recipe export retains operational requirements and strips workspace authority and secrets', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await config.createAgent({
      id: 'agent_research',
      name: 'Research',
      instructions: 'Synthesize evidence.',
      enabled: true,
      model: 'openai/gpt-5',
      skills: [{
        name: 'research-synthesis',
        description: 'Synthesize research.',
        instructions: 'Group evidence into themes.',
        enabled: true,
      }],
      mcpServers: [{
        id: 'notion', displayName: 'Notion', url: 'https://mcp.notion.com/mcp',
        transport: 'streamable-http', authMode: 'oauth', headerNames: [], enabled: true,
        lifecycleStatus: 'ready', statusText: 'Connected',
        discoveredTools: [{ name: 'search' }], allowedTools: ['search'],
        identity: { accountName: 'alex@northstar.example', workspaceName: 'Northstar' },
        presetId: 'notion',
      }],
      apiConnections: [{
        id: 'gmail', displayName: 'Gmail', allowedHosts: ['gmail.googleapis.com'],
        pathPrefixes: ['/gmail/v1'], headerName: 'Authorization', allowedMethods: ['GET'],
        enabled: true, authMode: 'oauth', oauthProvider: 'google',
        oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        oauthAppType: 'external', lifecycleStatus: 'ready', statusText: 'Connected',
        identity: { accountName: 'alex@northstar.example' }, presetId: 'gmail',
      }],
      repositories: [{
        id: 'repo', installationId: 42, accountLogin: 'northstar',
        fullName: 'northstar/research', enabled: true,
      }],
    });
    await config.putChannel({
      workspaceId: 'T_SECRET', channelId: 'C_SECRET', label: 'research',
      lifecycle: 'active',
    }, 0);
    await config.putChannelPlacement({
      channel: (await config.getChannel('T_SECRET', 'C_SECRET'))!,
      agentId: 'agent_research', expectedAgentId: null, expectedRevision: 1,
    });

    const recipe = await exportWorkspaceRecipe(config, { agentIds: ['agent_research'] });
    const serialized = JSON.stringify(recipe);
    assert.equal(recipe.schemaVersion, 1);
    assert.equal(recipe.agents[0]?.repositoryRequirements[0]?.fullName, 'northstar/research');
    assert.equal(recipe.agents[0]?.mcpRequirements[0]?.authMode, 'oauth');
    assert.equal(Object.hasOwn(recipe, 'channels'), false);
    assert.doesNotMatch(serialized, /T_SECRET|C_SECRET|alex@northstar/);
    assert.doesNotMatch(serialized, /installationId|accountLogin|slackIdentityId|identity/);
  } finally {
    config.close();
  }
});

test('recipe preview exposes conflict choices then compiles Agent and setup operations', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await config.createAgent({
      id: 'agent_existing', name: 'Research', instructions: 'Existing.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const recipe = {
      schemaVersion: 1,
      name: 'Research',
      agents: [{
        symbol: 'agent_1', name: 'Research', instructions: 'Portable.', enabled: true,
        model: 'openai/gpt-5', skills: [],
        mcpRequirements: [{
          id: 'notion', displayName: 'Notion', url: 'https://mcp.notion.com/mcp',
          transport: 'streamable-http', authMode: 'oauth', headerNames: [],
          enabled: true, allowedTools: ['search'], presetId: 'notion',
        }],
        apiRequirements: [],
        repositoryRequirements: [{ id: 'repo', fullName: 'northstar/research', enabled: true }],
      }],
    };
    const source = async () => 'missing' as const;
    const conflict = await previewWorkspaceRecipe(config, source, { recipe });
    assert.equal(conflict.agents[0]?.status, 'conflict');
    assert.deepEqual(conflict.agents[0]?.choices, ['clone', 'update', 'skip']);
    assert.equal(conflict.operations.length, 0);

    const clone = await previewWorkspaceRecipe(config, source, {
      recipe,
      agentStrategy: 'clone',
    });
    assert.equal(clone.agents[0]?.status, 'clone');
    assert.deepEqual(clone.agents[0]?.setupRequired.sort(), [
      'Notion', 'northstar/research', 'openai model provider',
    ].sort());
    assert.deepEqual(clone.operations.map(({ kind }) => kind), [
      'create_agent', 'request_setup', 'request_setup', 'request_setup',
    ]);

    const update = await previewWorkspaceRecipe(config, source, {
      recipe,
      agentStrategy: 'update',
    });
    const updateOperation = update.operations.find(({ kind }) => kind === 'update_agent');
    assert.equal(
      updateOperation?.kind === 'update_agent' ? updateOperation.confirmationReason : undefined,
      'recipe_overwrite',
    );
  } finally {
    config.close();
  }
});

test('recipe preview rejects authority and credential fields before compiling writes', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const unsafe = {
      schemaVersion: 1,
      name: 'Unsafe',
      agents: [{
        symbol: 'agent_1', name: 'Unsafe', instructions: 'Do work.', enabled: true,
        skills: [], mcpRequirements: [], apiRequirements: [], repositoryRequirements: [],
        clientSecret: 'not-allowed',
      }],
    };
    await assert.rejects(
      () => previewWorkspaceRecipe(config, async () => 'missing', { recipe: unsafe }),
      (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    );

    const { clientSecret: _clientSecret, ...safeAgentFields } = unsafe.agents[0]!;
    const secretUrl = {
      ...unsafe,
      agents: [{
        ...safeAgentFields,
        mcpRequirements: [{
        id: 'private', displayName: 'Private',
        url: 'https://mcp.example.com/mcp?api_key=plain-secret',
        transport: 'streamable-http', authMode: 'none', headerNames: [],
        enabled: true, allowedTools: [],
        }],
      }],
    };
    await assert.rejects(
      () => previewWorkspaceRecipe(config, async () => 'missing', { recipe: secretUrl }),
      (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    );
  } finally {
    config.close();
  }
});

test('recipe preview rejects malformed nested requirements and oversized operation batches', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const malformed = {
      schemaVersion: 1,
      name: 'Malformed',
      agents: [{
        symbol: 'agent_1', name: 'Malformed', instructions: '', enabled: true,
        skills: [], mcpRequirements: [{ displayName: 'Missing fields' }],
        apiRequirements: [], repositoryRequirements: [],
      }],
    };
    await assert.rejects(
      () => previewWorkspaceRecipe(config, async () => 'missing', { recipe: malformed }),
      (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    );

    const tooLarge = {
      schemaVersion: 1,
      name: 'Too large',
      agents: Array.from({ length: 26 }, (_, index) => ({
        symbol: `agent_${index}`, name: `Agent ${index}`, instructions: '', enabled: true,
        skills: [], mcpRequirements: [], apiRequirements: [], repositoryRequirements: [],
      })),
    };
    await assert.rejects(
      () => previewWorkspaceRecipe(config, async () => 'missing', { recipe: tooLarge }),
      (error: unknown) => error instanceof ManagementError &&
        error.message.includes('more than 25 operations'),
    );

    const unsupportedModel = structuredClone(malformed);
    unsupportedModel.agents[0]!.mcpRequirements = [];
    Object.assign(unsupportedModel.agents[0]!, { model: 'unknown/model' });
    await assert.rejects(
      () => previewWorkspaceRecipe(config, async () => 'missing', { recipe: unsupportedModel }),
      (error: unknown) => error instanceof ManagementError &&
        error.message.includes('model is unsupported'),
    );
  } finally {
    config.close();
  }
});

test('recipe import progressively creates live configuration and rejects a stale update preview', async () => {
  const f = await createManagementAdapterFixture('recipe-import');
  try {
    const context = {
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: 'client_codex' },
    };
    const recipe = {
      schemaVersion: 1,
      name: 'Research',
      agents: [{
        symbol: 'agent_1', name: 'Research', instructions: 'Portable.', enabled: true,
        model: 'openai/gpt-5.6-terra', skills: [],
        mcpRequirements: [{
          id: 'notion', displayName: 'Notion', url: 'https://mcp.notion.com/mcp',
          transport: 'streamable-http', authMode: 'oauth', headerNames: [],
          enabled: true, allowedTools: ['search'], presetId: 'notion',
        }],
        apiRequirements: [],
        repositoryRequirements: [{ id: 'repo', fullName: 'northstar/research', enabled: true }],
      }],
    };
    const preview = await f.service.previewRecipe(context, { recipe });
    const applied = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'recipe-import',
      operations: preview.operations,
    });
    assert.deepEqual(applied.outcomes.map(({ disposition }) => disposition), [
      'applied', 'setup_required', 'setup_required', 'setup_required',
    ]);
    const created = (await f.config.listAgents()).find(({ name }) => name === 'Research');
    assert.ok(created);

    const updateRecipe = {
      ...recipe,
      agents: [{
        ...recipe.agents[0]!,
        instructions: 'Recipe replacement.',
        model: undefined,
        mcpRequirements: [],
        repositoryRequirements: [],
      }],
    };
    const updatePreview = await f.service.previewRecipe(context, {
      recipe: updateRecipe,
      agentStrategy: 'update',
    });
    await f.config.updateAgent(created.id, { instructions: 'Newer live edit.' }, created.revision);
    const stale = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'recipe-stale-update',
      operations: updatePreview.operations,
    });
    assert.equal(stale.outcomes[0]?.disposition, 'failed');
    assert.equal((await f.config.getAgent(created.id))?.instructions, 'Newer live edit.');
  } finally {
    f.close();
  }
});

test('confirmed recipe overwrite resumes connector setup', async () => {
  const f = await createManagementAdapterFixture('recipe-confirm-resume');
  try {
    const existing = await f.config.createAgent({
      id: 'agent_existing', name: 'Existing', instructions: 'Old.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const context = {
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: 'client_codex' },
    };
    const preview = await f.service.previewRecipe(context, {
      agentStrategy: 'update',
      recipe: {
        schemaVersion: 1,
        name: 'Existing',
        agents: [{
          symbol: 'agent_1', name: existing.name, instructions: 'Updated.', enabled: true,
          skills: [],
          mcpRequirements: [{
            id: 'search', displayName: 'Search', url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http', authMode: 'bearer', headerNames: [],
            enabled: true, allowedTools: ['search'],
          }],
          apiRequirements: [], repositoryRequirements: [],
        }],
      },
    });
    const proposed = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'recipe-confirm-resume',
      operations: preview.operations,
    });
    assert.deepEqual(proposed.outcomes.map(({ disposition }) => disposition), [
      'confirmation_required',
    ]);
    const resumed = await f.service.confirmWorkspaceChange({
      context,
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.deepEqual(resumed.outcomes.map(({ disposition }) => disposition), [
      'applied', 'setup_required',
    ]);
    assert.match(resumed.outcomes[1]!.setupUrl!, /#setup=/);
    const durableAfterSetup = await f.management.getRequest(resumed.operationId);
    assert.equal(durableAfterSetup?.progress.outcomes[1]?.setupUrl, undefined);
    assert.doesNotMatch(JSON.stringify(durableAfterSetup), /#setup=/);
    assert.equal((await f.config.getAgent(existing.id)).instructions, 'Updated.');
  } finally {
    f.close();
  }
});
