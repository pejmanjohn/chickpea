import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { exportWorkspaceRecipe } from '../src/management/recipes.ts';
import { emitManagementMetric } from '../src/management/telemetry.ts';
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
    operationCount: 2,
    ignored: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  }, { info: (line) => lines.push(line) });

  assert.equal(lines.length, 1);
  for (const value of SECRET_CORPUS) assert.doesNotMatch(lines[0]!, new RegExp(value));
  assert.match(lines[0]!, /"event":"other"/);
  assert.match(lines[0]!, /"operationCount":2/);
  assert.doesNotMatch(lines[0]!, /ignored/);
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
    const recipe = await exportWorkspaceRecipe(config, { agentIds: ['agent_secure'] });
    const serialized = JSON.stringify(recipe);
    assert.doesNotMatch(serialized, /alex-private|installationId|accountLogin|slackIdentityId/);
    assert.doesNotMatch(serialized, /identity|workspaceId|channelId|memory/i);
  } finally {
    config.close();
  }
});
