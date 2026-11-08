import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RuntimeModelReadinessError } from '../src/config/runtime-model.ts';
import {
  ALICE,
  ALICE_ACCOUNT,
  BOB,
  freezeRoutineFixturePlan,
  freezeSlackFixturePlan,
  ROUTINE_FIXTURES,
  SLACK_FIXTURES,
  TEAM_ACCOUNT,
  withRunPlanLane,
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
