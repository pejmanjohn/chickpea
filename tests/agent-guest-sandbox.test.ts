import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileRuntimePlanV2,
  parseRuntimePlanV2,
  runtimePlanConversationKey,
  runtimePlanWorkspaceConversationKey,
} from '../src/agents/runtime-plan.ts';
import { runtimePlanGuestSandboxKey, sandboxThreadKey, slackTurnSandboxKey } from '../src/sandbox/thread-key.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { defaultWorkspaceId } from '../src/sandbox/workspace-session.ts';

const turn: NormalizedSlackTurn = {
  workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'E_TEST', text: '@finance check this',
  userId: 'U_TEST', actorMembershipId: 'member', messageTs: '1787000000.000200',
  threadTs: '1787000000.000100', source: 'agent_mention', contextMode: 'thread', channelType: 'channel',
};

function planFor(input: { threadGuest?: boolean; agentId?: string; ownerIncarnation?: number } = {}) {
  const agent = {
    id: input.agentId ?? 'agent_finance', kind: 'user', revision: 1, name: 'Finance', instructions: 'Numbers.',
    enabled: true, model: 'local-stub/proof', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
  const assignment = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: agent.id, agent, model: agent.model,
    runtimeContract: 'chickpea-v1', ownerIncarnation: input.ownerIncarnation ?? 2,
    ...(input.threadGuest ? { threadGuest: true } : {}),
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
  const guest = planFor({ threadGuest: true });
  assert.equal(guest.plan.conversation.guest, true);
  assert.equal(parseRuntimePlanV2(JSON.parse(JSON.stringify(guest.plan))).conversation.guest, true);
  const agentSide = runtimePlanGuestSandboxKey(guest.plan)!;
  const runnerSide = slackTurnSandboxKey({ turn, assignment: guest.assignment, runtimePlan: guest.plan } as never);
  assert.match(runnerSide, /^sandbox_[a-f0-9]{40}$/);
  assert.equal(agentSide, runnerSide);
  // Every Agent-side workspace key falls back to the guest's own Sandbox.
  assert.equal(runtimePlanWorkspaceConversationKey(guest.plan), agentSide);
  assert.equal(defaultWorkspaceId(agentSide), agentSide);
  // An owner-bound key is kept as it is wherever a thread key is expected.
  assert.equal(sandboxThreadKey(runnerSide), runnerSide);
  // The guest flag changes no instance: the harness revision is the owner's.
  assert.equal(guest.plan.harnessRevision, planFor().plan.harnessRevision);

  const owner = planFor();
  assert.equal(owner.plan.conversation.guest, undefined);
  assert.equal(runtimePlanGuestSandboxKey(owner.plan), undefined);
  const threadSandbox = sandboxThreadKey(slackAgentThreadKey(turn, owner.assignment as never));
  assert.equal(slackTurnSandboxKey({ turn, assignment: owner.assignment, runtimePlan: owner.plan } as never), threadSandbox);
  assert.equal(defaultWorkspaceId(runtimePlanWorkspaceConversationKey(owner.plan)), threadSandbox);
  assert.equal(runtimePlanWorkspaceConversationKey(owner.plan), runtimePlanConversationKey(owner.plan));
  assert.notEqual(runnerSide, threadSandbox);
});

test('each guest has its own Sandbox in a thread, kept across a takeover', () => {
  const finance = runtimePlanGuestSandboxKey(planFor({ threadGuest: true }).plan);
  const legal = runtimePlanGuestSandboxKey(planFor({ threadGuest: true, agentId: 'agent_legal' }).plan);
  assert.notEqual(finance, legal);
  assert.equal(
    runtimePlanGuestSandboxKey(planFor({ threadGuest: true, ownerIncarnation: 3 }).plan),
    finance,
    'a guest key names no owner incarnation, as the thread key does not',
  );
});

test('the runner reads where the frozen plan wrote, not where the assignment points', () => {
  const guest = planFor({ threadGuest: true });
  const threadSandbox = sandboxThreadKey(slackAgentThreadKey(turn, guest.assignment as never));
  // A guest turn frozen before plans carried `guest` used the thread's Sandbox.
  const before = planFor().plan;
  assert.equal(slackTurnSandboxKey({ turn, assignment: guest.assignment, runtimePlan: before } as never), threadSandbox);
  // Without a frozen plan no workspace was opened.
  assert.equal(slackTurnSandboxKey({ turn, assignment: guest.assignment } as never), threadSandbox);
});

test('a plan marks a guest only with true', () => {
  const { plan } = planFor({ threadGuest: true });
  for (const value of [false, null, 'true', 1]) {
    const broken = JSON.parse(JSON.stringify(plan));
    broken.conversation.guest = value;
    assert.throws(() => parseRuntimePlanV2(broken), /conversation\.guest must be true/, String(value));
  }
});
