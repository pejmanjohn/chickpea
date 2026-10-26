import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CustomAgentConfig } from '../src/config/types.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import type { ManagementApplyResult, ManagementOperation } from '../src/management/types.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;

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

async function applyOverMcp(
  f: Fixture,
  idempotencyKey: string,
  operations: ManagementOperation[],
): Promise<ManagementApplyResult> {
  const response = await invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => ({
      userId: f.owner.user.id,
      membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'outcome-test' },
    }),
  }, 'apply_workspace_changes', { idempotencyKey, operations });
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: ManagementApplyResult }).result;
}

async function createAgent(f: Fixture, id: string): Promise<CustomAgentConfig> {
  return f.config.createAgent({
    id,
    name: 'Research',
    instructions: 'Find and cite sources.',
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

test('a refused delete tells the model why over MCP', () => withFixture('outcome-delete', async (f) => {
  const agent = await createAgent(f, 'agent_research');
  await f.config.putAgentChannelGrant({
    workspaceId: f.owner.binding.slackTeamId,
    channelId: 'C_LAUNCH',
    agentId: agent.id,
    status: 'active',
    createdByMembershipId: f.owner.membership.id,
    channelLabel: 'launch',
  });
  const refused = await applyOverMcp(f, 'delete-reached', [{
    itemId: 'delete',
    kind: 'delete_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
  }]);
  assert.deepEqual(refused.outcomes.map(({ disposition, code, instruction }) =>
    [disposition, code, instruction]), [[
    'failed',
    'invalid_request',
    'Archive the Agent and remove its Slack reach before deleting it.',
  ]]);
}));

test('code-only failures and skips still explain themselves', () => withFixture('outcome-codes', async (f) => {
  const agent = await createAgent(f, 'agent_editor');
  const result = await applyOverMcp(f, 'stale-then-dependent', [{
    itemId: 'stale',
    kind: 'update_agent',
    agentId: agent.id,
    expectedRevision: agent.revision + 5,
    patch: { description: 'Edits drafts.' },
  }, {
    itemId: 'after',
    kind: 'update_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
    dependsOn: ['stale'],
    patch: { instructions: 'Edit drafts.' },
  }]);
  assert.deepEqual(result.outcomes.map(({ disposition, code }) => [disposition, code]), [
    ['failed', 'revision_conflict'],
    ['skipped', 'dependency_not_applied'],
  ]);
  for (const outcome of result.outcomes) {
    assert.ok(outcome.instruction?.trim(), `${outcome.code} explains itself`);
    assert.doesNotMatch(outcome.instruction!, /agent_editor/);
  }
}));

test('a Slack presence refusal reaches the model with Slack\'s reason', () =>
  withFixture('outcome-presence', async (f) => {
    const agent = await createAgent(f, 'agent_research');
    const refused = await applyOverMcp(f, 'refused-description', [{
      itemId: 'describe',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { description: 'Finds and checks sources.' },
    }]);
    assert.deepEqual(refused.outcomes.map(({ disposition, code, instruction }) =>
      [disposition, code, instruction]), [[
      'failed',
      'user_group_policy_denied',
      'Slack blocked Chickpea from creating or editing the Agent handle.',
    ]]);
  }, {
    reconcileAgentUpdate: async () => {
      throw new AgentPresenceError(
        'user_group_policy_denied',
        'Slack blocked Chickpea from creating or editing the Agent handle.',
      );
    },
  }));
