import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../src/management/agent-authoring/index.ts';
import { exportWorkspaceRecipe } from '../src/management/recipes.ts';
import {
  agentAuthoringArtifactClass,
  emitManagementMetric,
} from '../src/management/telemetry.ts';
import {
  WORKSPACE_MANAGEMENT_TOOL_NAMES,
  workspaceManagementToolDescription,
} from '../src/management/tool-adapter.ts';

const SECRET_CORPUS = [
  'alex-private@northstar.example',
  'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  'oauth-code-private-123456',
  'PRIVATE_INSTRUCTION_SENTINEL',
  'PRIVATE_MEMORY_SENTINEL',
  'T_PRIVATE_WORKSPACE',
  'C_PRIVATE_CHANNEL',
];

test('management telemetry accepts only content-free dimensions', () => {
  const lines: string[] = [];
  emitManagementMetric('PRIVATE_MEMORY_SENTINEL', {
    surface: 'T_PRIVATE_WORKSPACE',
    tool: 'PRIVATE_INSTRUCTION_SENTINEL',
    reason: 'alex-private@northstar.example',
    outcome: 'oauth-code-private-123456',
    guideVersion: 'PRIVATE_INSTRUCTION_SENTINEL',
    artifactClass: 'northstar/research',
    proposalOutcome: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    staleReason: 'T_PRIVATE_WORKSPACE',
    handoffClass: 'C_PRIVATE_CHANNEL',
    operationCount: 2,
    ignored: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  }, { info: (line) => lines.push(line) });

  assert.equal(lines.length, 1);
  for (const value of SECRET_CORPUS) assert.doesNotMatch(lines[0]!, new RegExp(value));
  assert.match(lines[0]!, /"event":"other"/);
  assert.match(lines[0]!, /"operationCount":2/);
  assert.doesNotMatch(lines[0]!, /ignored/);
});

test('Agent-authoring telemetry keeps only versioned outcome classes', () => {
  const lines: string[] = [];
  emitManagementMetric('agent_authoring.outcome', {
    surface: 'slack',
    guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
    posture: 'commit',
    artifactClass: 'skill',
    proposalOutcome: 'created',
    staleReason: 'target_revision',
    handoffClass: 'cross_agent',
    operationCount: 1,
  }, { info: (line) => lines.push(line) });

  assert.deepEqual(JSON.parse(lines[0]!.replace('[chickpea:management] ', '')), {
    event: 'agent_authoring.outcome',
    surface: 'slack',
    guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
    posture: 'commit',
    artifactClass: 'skill',
    proposalOutcome: 'created',
    staleReason: 'target_revision',
    handoffClass: 'cross_agent',
    operationCount: 1,
  });
  assert.equal(agentAuthoringArtifactClass([{
    kind: 'update_agent',
    itemId: 'skill-edit',
    agentId: 'agent_support',
    expectedRevision: 1,
    patch: { skills: [{ name: 'triage', description: 'Triage requests.', instructions: 'Inspect.', enabled: true }] },
  }]), 'skill');
  assert.equal(agentAuthoringArtifactClass([{
    kind: 'update_agent',
    itemId: 'mixed-edit',
    agentId: 'agent_support',
    expectedRevision: 1,
    patch: { description: 'Support requests.', instructions: 'Resolve support requests.' },
  }]), 'mixed');
});

test('Agent creation telemetry keeps only bounded delivery classes and counts', () => {
  const lines: string[] = [];
  emitManagementMetric('agent_creation.welcome_claim', {
    surface: 'slack',
    outcome: 'created',
    connectorActionCount: 3,
    connectorNoticeCount: 1,
    publicationStatus: 'complete',
    deliveryPersona: 'agent',
    requestText: 'PRIVATE_MEMORY_SENTINEL',
    setupUrl: 'https://example.invalid/#oauth-code-private-123456',
  }, { info: (line) => lines.push(line) });

  assert.deepEqual(JSON.parse(lines[0]!.replace('[chickpea:management] ', '')), {
    event: 'agent_creation.welcome_claim',
    surface: 'slack',
    outcome: 'created',
    connectorActionCount: 3,
    connectorNoticeCount: 1,
    publicationStatus: 'complete',
    deliveryPersona: 'agent',
  });
});

test('tool discovery and portable recipe exports exclude secret and authority corpus', async () => {
  const descriptions = WORKSPACE_MANAGEMENT_TOOL_NAMES.map((name) => ({
    name,
    description: workspaceManagementToolDescription(name),
  }));
  for (const value of SECRET_CORPUS) {
    assert.doesNotMatch(JSON.stringify(descriptions), new RegExp(value));
  }

  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    await config.createAgent({
      id: 'agent_secure',
      name: 'Secure export',
      instructions: 'Use the declared requirements.',
      enabled: true,
      skills: [],
      mcpServers: [{
        id: 'notion', displayName: 'Notion', url: 'https://mcp.notion.com/mcp',
        transport: 'streamable-http', authMode: 'oauth', headerNames: [], enabled: true,
        lifecycleStatus: 'ready', statusText: 'Connected', discoveredTools: [],
        allowedTools: [], identity: { accountName: SECRET_CORPUS[0]! },
      }],
      apiConnections: [],
      repositories: [{
        id: 'repo', installationId: 42, accountLogin: 'private-account',
        fullName: 'northstar/research', enabled: true,
      }],
    });
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: 'T_RECIPE',
      transportMode: 'direct',
      defaultAgentId: 'agent_secure',
    });
    const workspaceDefault = await config.putWorkspaceModelDefault({
      workspaceId: installation.workspaceId,
      modelId: 'openai/gpt-5.6-sol',
      provenance: 'admin_selected',
    }, 1);
    await config.activateChickpeaCutover({
      workspaceId: installation.workspaceId,
      expectedInstallationRevision: installation.revision,
      expectedDefaultRevision: workspaceDefault.revision,
      defaultReady: true,
    });

    const recipe = await exportWorkspaceRecipe(config, {});
    assert.deepEqual(recipe.agents.map(({ name }) => name), ['Secure export']);
    const serialized = JSON.stringify(recipe);
    assert.doesNotMatch(serialized, /alex-private|installationId|accountLogin|slackIdentityId/);
    assert.doesNotMatch(serialized, /identity|workspaceId|channelId|memory/i);
    assert.doesNotMatch(serialized, /Chickpea|agent_chickpea/);
    await assert.rejects(
      () => exportWorkspaceRecipe(config, { agentIds: ['agent_chickpea'] }),
      /recipe Agents were not found/,
    );
  } finally {
    config.close();
  }
});
