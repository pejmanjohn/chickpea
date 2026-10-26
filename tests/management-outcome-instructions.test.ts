import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ManagementApplyResult, ManagementOperation } from '../src/management/types.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import {
  applyThroughAdapter,
  createFixtureAgent as createAgent,
  ownerMcpContext,
  withManagementAdapterFixture as withFixture,
  type ManagementAdapterFixture as Fixture,
} from './helpers/management-adapter-fixture.ts';

function applyOverMcp(
  f: Fixture,
  idempotencyKey: string,
  operations: ManagementOperation[],
): Promise<ManagementApplyResult> {
  return applyThroughAdapter(f, ownerMcpContext(f, 'outcome-test'), idempotencyKey, operations);
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
    'Archive Research first, then delete it. Archiving takes it out of its Slack Channels and turns off its Slack handle.',
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
