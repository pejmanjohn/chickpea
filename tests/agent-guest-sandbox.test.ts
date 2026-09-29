import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileRuntimePlanV2,
  parseRuntimePlanV2,
  runtimePlanGuestSandboxKey,
} from '../src/agents/runtime-plan.ts';
import { sandboxThreadKey, slackTurnSandboxKey } from '../src/sandbox/thread-key.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const turn: NormalizedSlackTurn = {
  workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'E_TEST', text: '@finance check this',
  userId: 'U_TEST', actorMembershipId: 'member', messageTs: '1787000000.000200',
  threadTs: '1787000000.000100', source: 'agent_mention', contextMode: 'thread', channelType: 'channel',
};

function planFor(threadGuest: boolean) {
  const agent = {
    id: 'agent_finance', kind: 'user', revision: 1, name: 'Finance', instructions: 'Numbers.', enabled: true,
    model: 'local-stub/proof', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
  const assignment = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: agent.id, agent, model: agent.model,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 2,
    ...(threadGuest ? { threadGuest: true } : {}),
    modelAttribution: { source: 'workspace_default', providerId: 'local-stub', workspaceDefaultRevision: 1 },
  };
  return {
    assignment,
    plan: compileRuntimePlanV2({
      turn, assignment, instructions: agent.instructions, memoryEpoch: 1, effectiveConnections: [],
    } as never),
  };
}

test('a guest turn has its own coding Sandbox, the same on the runner and the Agent side', () => {
  const guest = planFor(true);
  assert.equal(guest.plan.conversation.guest, true);
  assert.equal(parseRuntimePlanV2(JSON.parse(JSON.stringify(guest.plan))).conversation.guest, true);
  const agentSide = runtimePlanGuestSandboxKey(guest.plan);
  const runnerSide = slackTurnSandboxKey(turn, guest.assignment as never);
  assert.match(runnerSide, /^sandbox_[a-f0-9]{40}$/);
  assert.equal(agentSide, runnerSide);
  // An owner-bound key is kept as it is wherever a thread key is expected.
  assert.equal(sandboxThreadKey(runnerSide), runnerSide);

  const owner = planFor(false);
  assert.equal(owner.plan.conversation.guest, undefined);
  assert.equal(runtimePlanGuestSandboxKey(owner.plan), undefined);
  assert.equal(
    slackTurnSandboxKey(turn, owner.assignment as never),
    sandboxThreadKey(slackAgentThreadKey(turn, owner.assignment as never)),
  );
  assert.notEqual(runnerSide, slackTurnSandboxKey(turn, owner.assignment as never));
});

test('a plan marks a guest only with true', () => {
  const { plan } = planFor(true);
  const broken = JSON.parse(JSON.stringify(plan));
  broken.conversation.guest = false;
  assert.throws(() => parseRuntimePlanV2(broken), /conversation\.guest must be true/);
});
