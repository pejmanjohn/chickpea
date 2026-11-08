import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileAgentRunPlan, resolveAgentRunPlan } from '../src/agents/run-plan-resolution.ts';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { slackTenantInstructions } from '../src/agents/shared-prefix-layout.ts';
import { RuntimeModelReadinessError } from '../src/config/runtime-model.ts';
import { resolveEffectiveConnectionAccounts, selectConnectionsForRequest } from '../src/connections/runtime.ts';
import {
  ALICE,
  ALICE_ACCOUNT,
  BOB,
  freezeRoutineFixturePlan,
  freezeSlackFixturePlan,
  ROUTINE_FIXTURES,
  SLACK_FIXTURES,
  TEAM_ACCOUNT,
  WORKSPACE,
  withRunPlanLane,
  type RoutineFixture,
  type RunPlanLane,
  type SlackFixture,
} from './helpers/run-plan-lane.ts';

const [dmAlice, channelAlice, channelBob, channelNoMember, dmUnready] = SLACK_FIXTURES;
const [routineTeam, routineCoding, routineUnready] = ROUTINE_FIXTURES;

test('a DM turn by its member freezes their personal and the team connections, the browser and search', async () => {
  await withRunPlanLane(async (lane) => {
    const plan = await freezeSlackFixturePlan(lane, dmAlice!);
    assert.equal(plan.actorMembershipId, ALICE);
    assert.equal(plan.conversation.surface, 'direct_message');
    assert.equal(plan.model, 'local-stub/ops');
    assert.equal(plan.runtimeModel, 'local-stub/ops');
    assert.deepEqual(plan.connectionAccountIds, [ALICE_ACCOUNT, TEAM_ACCOUNT]);
    assert.equal(plan.usesPersonalAccess, true);
    assert.deepEqual(plan.teamReconnects, [{ providerId: 'linear', label: 'Linear' }]);
    assert.deepEqual(plan.browserCapability, { provider: 'browserbase' });
    assert.deepEqual(plan.websiteLogins?.map(({ host, level }) => ({ host, level })),
      [{ host: 'portal.example.com', level: 'check' }]);
    assert.equal(plan.webSearch, true);
    assert.deepEqual(plan.skills.map(({ name }) => name), ['triage']);
    assert.equal(plan.codingWorkspace, undefined, 'only the Cloudflare target offers a coding workspace');
  });
});

test('a Channel turn by a member without a personal account gets the team connection and an option to connect', async () => {
  await withRunPlanLane(async (lane) => {
    const alice = await freezeSlackFixturePlan(lane, channelAlice!);
    assert.equal(alice.conversation.surface, 'channel_thread');
    assert.deepEqual(alice.connectionAccountIds, [ALICE_ACCOUNT, TEAM_ACCOUNT]);
    assert.equal(alice.browserCapability, undefined);
    assert.equal(alice.webSearch, undefined);
    assert.equal(alice.websiteLogins, undefined, 'logins freeze only with a browser');

    const bob = await freezeSlackFixturePlan(lane, channelBob!);
    assert.equal(bob.actorMembershipId, BOB);
    assert.deepEqual(bob.connectionAccountIds, [TEAM_ACCOUNT]);
    assert.equal(bob.usesPersonalAccess, false);
    assert.deepEqual((bob.connectionAuthorizations ?? []).map(({ providerId, accounts }) => ({ providerId, accounts })),
      [{ providerId: 'sentry', accounts: [] }]);
  });
});

test('a requester with no membership gets no connections', async () => {
  await withRunPlanLane(async (lane) => {
    const plan = await freezeSlackFixturePlan(lane, channelNoMember!);
    assert.equal(plan.actorMembershipId, undefined);
    assert.deepEqual(plan.connectionAccountIds, []);
    assert.deepEqual(plan.connectionAuthorizations, []);
    assert.equal(plan.teamReconnects, undefined);
    assert.deepEqual(plan.connectionSelections, []);
  });
});

test('a model whose provider has no key fails the turn before it has a plan', async () => {
  await withRunPlanLane(async (lane) => {
    await assert.rejects(freezeSlackFixturePlan(lane, dmUnready!), RuntimeModelReadinessError);
  });
});

test('a routine freezes only the connections its schedule admitted, and its coding model', async () => {
  await withRunPlanLane(async (lane) => {
    const team = await freezeRoutineFixturePlan(lane, routineTeam!);
    assert.ok('plan' in team, JSON.stringify(team));
    assert.equal(team.plan.actorMembershipId, ALICE);
    assert.deepEqual(team.plan.connectionAccountIds, [TEAM_ACCOUNT]);
    assert.deepEqual(team.plan.connectionAuthorizations, []);
    assert.equal(team.plan.teamReconnects, undefined);
    assert.equal(team.plan.connectionSelections, undefined);
    assert.equal(team.plan.codingWorkspace, undefined);

    const coding = await freezeRoutineFixturePlan(lane, routineCoding!);
    assert.ok('plan' in coding, JSON.stringify(coding));
    assert.deepEqual(coding.plan.connectionAccountIds, [ALICE_ACCOUNT, TEAM_ACCOUNT]);
    assert.deepEqual(coding.plan.codingWorkspace, {
      available: true,
      codingModel: {
        model: 'local-stub/ops',
        runtimeModel: 'local-stub/ops',
        attribution: { role: 'coding', source: 'agent_model', providerId: 'local-stub', fallback: false },
      },
    });

    assert.deepEqual(await freezeRoutineFixturePlan(lane, routineUnready!),
      { failure: 'tool_failed: The routine could not complete safely.' });
  });
});

/** The parts for a fixture's Agent, place and actor, resolved with no Slack event. */
async function partsWithoutEvent(lane: RunPlanLane, fixture: SlackFixture) {
  const assignment = await lane.assignment(fixture.agentId, fixture.place);
  const parts = await resolveAgentRunPlan({
    assignment,
    model: assignment.model!,
    workspaceId: WORKSPACE,
    ...(fixture.actor ? { connections: { actorMembershipId: fixture.actor, config: lane.stores.config } } : {}),
    env: lane.platformEnv(fixture),
    settings: lane.stores.settings,
    roles: lane.stores.config,
  });
  return { assignment, parts };
}

for (const fixture of SLACK_FIXTURES.filter(({ agentId }) => agentId !== dmUnready!.agentId)) {
  test(`${fixture.name}: the parts resolved with no Slack event, joined with the message's own, are the turn's plan`,
    async () => {
      await withRunPlanLane(async (lane) => {
        const { assignment, parts } = await partsWithoutEvent(lane, fixture);
        const turn = lane.turn(fixture);
        const composed = compileAgentRunPlan(parts, {
          turn,
          assignment,
          instructions: slackTenantInstructions(assignment),
          memoryEpoch: 3,
          request: selectConnectionsForRequest({ connections: parts.connections, requestText: turn.text }),
        });
        assert.deepEqual(composed, await freezeSlackFixturePlan(lane, fixture));
      });
    });
}

test('with no Slack event, a model whose provider has no key fails as the turn does', async () => {
  await withRunPlanLane(async (lane) => {
    await assert.rejects(partsWithoutEvent(lane, dmUnready!), RuntimeModelReadinessError);
  });
});

/** What the parts decide in a plan: the model route, the capabilities, and the connections with their tools. */
function partsView(plan: RuntimePlanV2) {
  const {
    runtimeModel, runtimeModelRoute, imageCapability, codingWorkspace, browserCapability, websiteLogins, webSearch,
    connectionAccountIds, usesPersonalAccess, connectionAuthorizations, teamReconnects, apiConnections, mcpConnections,
    managedConnections,
  } = plan;
  return {
    runtimeModel, runtimeModelRoute, imageCapability, codingWorkspace, browserCapability, websiteLogins, webSearch,
    connectionAccountIds, usesPersonalAccess, connectionAuthorizations, teamReconnects, apiConnections, mcpConnections,
    managedConnections,
  };
}

for (const fixture of [routineTeam!, routineCoding!]) {
  test(`${fixture.name}: the parts resolved with no routine decide what the routine froze`, async () => {
    await withRunPlanLane(async (lane) => {
      const frozen = await freezeRoutineFixturePlan(lane, fixture);
      assert.ok('plan' in frozen, JSON.stringify(frozen));
      const parts = await routinePartsWithoutEvent(lane, fixture);
      // Any conversation will do: none of these fields depend on one.
      const { assignment } = await partsWithoutEvent(lane, channelAlice!);
      const composed = compileAgentRunPlan(parts, {
        turn: lane.turn(channelAlice!), assignment, instructions: 'Any.', memoryEpoch: 1,
      });
      assert.deepEqual(partsView(composed), partsView(frozen.plan));
    });
  });
}

async function routinePartsWithoutEvent(lane: RunPlanLane, fixture: RoutineFixture) {
  const assignment = await lane.assignment(fixture.agentId, { kind: 'channel' });
  const effective = await resolveEffectiveConnectionAccounts({
    config: lane.stores.config, workspaceId: WORKSPACE, agentId: fixture.agentId, actorMembershipId: fixture.actor,
  });
  return resolveAgentRunPlan({
    assignment,
    model: assignment.model!,
    workspaceId: WORKSPACE,
    connections: { admitted: effective.filter(({ account }) => fixture.admittedAccountIds.includes(account.id)) },
    env: {} as never,
    settings: lane.stores.settings,
    roles: lane.stores.config,
    ...(fixture.codingWorkspace
      ? { decideCodingWorkspace: async () => ({ capability: 'available' as const, unavailableFallback: false }) }
      : {}),
  });
}
