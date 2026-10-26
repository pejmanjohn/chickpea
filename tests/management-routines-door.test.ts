import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';

import {
  MCP_MANAGEMENT_OPERATION_KINDS,
  managementOperationValibotSchema,
  managementOperationZodSchema,
} from '../src/management/schemas.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
  ManagementRoutineSnapshot,
} from '../src/management/types.ts';
import { RoutineService } from '../src/routines/service.ts';
import {
  MEMBER_SLACK_USER,
  apply,
  channelRoutine,
  chickpeaDm,
  createAgent,
  disposition,
  dmRoutine,
  grant,
  mcp,
  slackFacts,
  withFixture,
  type Fixture,
  type Person,
} from './helpers/management-authority-fixture.ts';

const OWNER_SLACK_USER = 'U12345678';

/** The member is in the lobby and one private room; the Owner is in every Channel. */
const ROOMS = slackFacts({
  C_LOBBY: { name: 'lobby', private: false, member: true, archived: false },
  G_ROOM: { name: 'room', private: true, member: true, archived: false },
  G_OTHER: { name: 'other', private: true, member: true, archived: false },
}, {
  [MEMBER_SLACK_USER]: ['C_LOBBY', 'G_ROOM'],
  [OWNER_SLACK_USER]: ['C_LOBBY', 'G_ROOM', 'G_OTHER'],
});

type InspectedRoutine = ManagementRoutineSnapshot['routines'][number];

async function routinesFor(
  f: Fixture,
  context: ManagementActorContext,
): Promise<InspectedRoutine[]> {
  return (await f.service.inspectRoutines(context, { workspaceId: f.workspaceId })).routines;
}

async function dmRoutineOf(f: Fixture, person: Person) {
  const [routine] = await f.routines.listRoutines(f.workspaceId, `D_${person.user.slackUserId}`);
  assert.ok(routine, `${person.user.slackUserId} has a DM routine`);
  return routine;
}

function proposalOf(result: ManagementApplyResult): string {
  const [outcome] = result.outcomes;
  assert.equal(outcome?.disposition, 'confirmation_required', JSON.stringify(result.outcomes));
  assert.ok(outcome.proposalId);
  return outcome.proposalId;
}

test('MCP lists and manages the signed-in person\'s own DM routines, and nobody else\'s', () =>
  withFixture('mcp-dm-routines', async (f) => {
    const helper = await createAgent(f, f.owner, 'agent_lobby', { name: 'Lobby helper' });
    await grant(f, helper.id, 'C_LOBBY');
    const memberSaved = await apply(f, chickpeaDm(f, f.member), 'member-dm', [dmRoutine(f, helper.id)]);
    assert.equal(disposition(memberSaved), 'applied', JSON.stringify(memberSaved.outcomes));
    const ownerSaved = await apply(f, chickpeaDm(f, f.owner), 'owner-dm', [{
      ...dmRoutine(f, helper.id),
      name: 'Owner digest',
    } as ManagementOperation]);
    assert.equal(disposition(ownerSaved), 'applied', JSON.stringify(ownerSaved.outcomes));
    const memberRoutine = await dmRoutineOf(f, f.member);
    const ownerRoutine = await dmRoutineOf(f, f.owner);

    const [listed, ...others] = await routinesFor(f, mcp(f.member));
    assert.deepEqual(others, []);
    assert.equal(listed?.id, memberRoutine.id);
    assert.equal(listed.name, 'Morning check');
    assert.equal(listed.taskText, 'Summarize what changed overnight.');
    assert.equal(listed.scheduleInput, '0 9 * * 1-5');
    assert.equal(listed.state, 'active');
    assert.deepEqual(listed.destination, { kind: 'direct_message', label: 'your DM with Lobby helper' });
    assert.equal(listed.channelId, null);
    assert.deepEqual((await routinesFor(f, mcp(f.owner))).map(({ id }) => id), [ownerRoutine.id]);
    assert.deepEqual((await routinesFor(f, chickpeaDm(f, f.member))).map(({ id }) => id), [memberRoutine.id]);

    const control = (person: Person, key: string, routineId: string, action: 'pause' | 'resume', version: number) =>
      apply(f, mcp(person), key, [{
        itemId: 'control', kind: 'control_routine', workspaceId: f.workspaceId,
        routineId, expectedVersion: version, action,
      }]);
    const ownerPausesTheirs = await control(f.owner, 'owner-pause-member', memberRoutine.id, 'pause', memberRoutine.version);
    assert.equal(disposition(ownerPausesTheirs), 'failed', JSON.stringify(ownerPausesTheirs.outcomes));
    const ownerDeletesTheirs = await apply(f, mcp(f.owner), 'owner-delete-member', [{
      itemId: 'delete', kind: 'delete_routine', workspaceId: f.workspaceId,
      routineId: memberRoutine.id, expectedVersion: memberRoutine.version,
    }]);
    assert.equal(disposition(ownerDeletesTheirs), 'failed', JSON.stringify(ownerDeletesTheirs.outcomes));
    const memberPausesOwners = await control(f.member, 'member-pause-owner', ownerRoutine.id, 'pause', ownerRoutine.version);
    assert.equal(disposition(memberPausesOwners), 'failed', JSON.stringify(memberPausesOwners.outcomes));
    assert.equal((await f.routines.getRoutine(ownerRoutine.id))?.state, 'active');
    assert.equal((await f.routines.getRoutine(memberRoutine.id))?.state, 'active');

    const paused = await control(f.member, 'member-pause', memberRoutine.id, 'pause', memberRoutine.version);
    assert.equal(disposition(paused), 'applied', JSON.stringify(paused.outcomes));
    const pausedRoutine = await dmRoutineOf(f, f.member);
    assert.equal(pausedRoutine.state, 'paused');
    const resumed = await control(f.member, 'member-resume', memberRoutine.id, 'resume', pausedRoutine.version);
    assert.equal(disposition(resumed), 'applied', JSON.stringify(resumed.outcomes));
    const resumedRoutine = await dmRoutineOf(f, f.member);
    assert.equal(resumedRoutine.state, 'active');

    const edited = await apply(f, mcp(f.member), 'member-edit', [{
      itemId: 'edit', kind: 'save_routine', requiredConnectionAccountIds: [],
      agentId: helper.id, workspaceId: f.workspaceId,
      routineId: memberRoutine.id, expectedVersion: resumedRoutine.version,
      name: 'Morning check', description: 'Check in privately.',
      taskText: 'Summarize what changed overnight, newest first.',
      schedule: { kind: 'preserve' }, timezone: 'UTC', outputPolicy: 'post',
    }]);
    assert.equal(disposition(edited), 'applied', JSON.stringify(edited.outcomes));
    const editedRoutine = await dmRoutineOf(f, f.member);
    assert.equal(editedRoutine.taskText, 'Summarize what changed overnight, newest first.');
    assert.deepEqual(editedRoutine.destination, memberRoutine.destination);

    const created = await apply(f, mcp(f.member), 'member-mcp-create', [dmRoutine(f, helper.id, 'second')]);
    assert.equal(disposition(created), 'failed', JSON.stringify(created.outcomes));

    const proposalId = proposalOf(await apply(f, mcp(f.member), 'member-delete', [{
      itemId: 'delete', kind: 'delete_routine', workspaceId: f.workspaceId,
      routineId: memberRoutine.id, expectedVersion: editedRoutine.version,
    }]));
    const confirmed = await f.service.confirmWorkspaceChange({ context: mcp(f.member), proposalId });
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed));
    assert.notEqual((await f.routines.getRoutine(memberRoutine.id))?.deletedAt, null);
    assert.equal((await f.routines.getRoutine(ownerRoutine.id))?.deletedAt, null);
  }, { slackFacts: ROOMS }));

test('changing a routine\'s Agent stays in Slack; taking over its Runs as is MCP\'s Admin repair', () => {
  const reassign = {
    itemId: 'reassign', kind: 'reassign_routine_agent', workspaceId: 'T1',
    routineId: 'routine_1', expectedVersion: 1, agentId: 'agent_other',
  };
  const takeOver = {
    itemId: 'take-over', kind: 'take_over_routine', workspaceId: 'T1', channelId: 'C1',
    routineId: 'routine_1', expectedVersion: 1, requiredConnectionAccountIds: [],
  };
  assert.equal(managementOperationZodSchema.safeParse(reassign).success, false);
  assert.equal(v.safeParse(managementOperationValibotSchema, reassign).success, true);
  assert.equal(managementOperationZodSchema.safeParse(takeOver).success, true);
  assert.equal(v.safeParse(managementOperationValibotSchema, takeOver).success, false);
  assert.equal(MCP_MANAGEMENT_OPERATION_KINDS.includes('take_over_routine'), true);
  assert.equal((MCP_MANAGEMENT_OPERATION_KINDS as readonly string[]).includes('reassign_routine_agent'), false);
});

test('an editor takes over a Channel routine whose Runs as authority broke, and it resumes', () =>
  withFixture('mcp-take-over', async (f) => {
    const pulse = await createAgent(f, f.member, 'agent_member_pulse');
    await grant(f, pulse.id, 'C_LOBBY');
    const saved = await apply(f, mcp(f.member), 'member-save', [channelRoutine(f, pulse.id, 'C_LOBBY')]);
    assert.equal(disposition(saved), 'applied', JSON.stringify(saved.outcomes));
    const [routine] = await f.routines.listRoutines(f.workspaceId, 'C_LOBBY');
    assert.ok(routine);
    const broken = await new RoutineService(f.routines).control({
      routineId: routine.id,
      expectedVersion: routine.version,
      action: 'pause',
      actorId: f.owner.user.id,
      actorClass: 'operator',
      reasonCode: 'schedule_authority_missing',
      idempotencyKey: 'test:authority-pause',
    });
    const [inspected] = await routinesFor(f, mcp(f.owner));
    assert.equal(inspected?.state, 'paused');
    assert.equal(inspected.pausedReason, 'schedule_authority_missing');
    assert.equal(inspected.disabledReason, null);

    const takeOver = (person: Person, key: string, routineId: string, version: number, channelId?: string) =>
      apply(f, mcp(person), key, [{
        itemId: 'take-over', kind: 'take_over_routine', workspaceId: f.workspaceId,
        ...(channelId ? { channelId } : {}), routineId, expectedVersion: version,
      }]);
    const tookOver = await takeOver(f.owner, 'owner-take-over', routine.id, broken.version, 'C_LOBBY');
    assert.equal(disposition(tookOver), 'applied', JSON.stringify(tookOver.outcomes));
    assert.equal((await f.config.getAgentScheduleReference(routine.id))?.runsAsMembershipId, f.owner.membership.id);
    assert.equal((await f.routines.getRoutine(routine.id))?.state, 'active');

    const locked = await createAgent(f, f.owner, 'agent_owner_pulse');
    await grant(f, locked.id, 'C_LOBBY');
    const ownerSaved = await apply(f, mcp(f.owner), 'owner-save', [{
      ...channelRoutine(f, locked.id, 'C_LOBBY'), name: 'Owner pulse',
    }]);
    assert.equal(disposition(ownerSaved), 'applied', JSON.stringify(ownerSaved.outcomes));
    const ownerRoutine = (await f.routines.listRoutines(f.workspaceId, 'C_LOBBY'))
      .find(({ name }) => name === 'Owner pulse');
    assert.ok(ownerRoutine);
    const refused = await takeOver(f.member, 'member-take-over', ownerRoutine.id, ownerRoutine.version, 'C_LOBBY');
    assert.equal(disposition(refused), 'failed', JSON.stringify(refused.outcomes));
    assert.equal(refused.outcomes[0]?.code, 'forbidden');
    assert.equal((await f.config.getAgentScheduleReference(ownerRoutine.id))?.runsAsMembershipId, f.owner.membership.id);

    const dmSaved = await apply(f, chickpeaDm(f, f.member), 'member-dm', [dmRoutine(f, pulse.id)]);
    assert.equal(disposition(dmSaved), 'applied', JSON.stringify(dmSaved.outcomes));
    const dm = await dmRoutineOf(f, f.member);
    const dmRefused = await takeOver(f.member, 'member-take-over-dm', dm.id, dm.version);
    assert.equal(disposition(dmRefused), 'failed', JSON.stringify(dmRefused.outcomes));
    assert.match(dmRefused.outcomes[0]?.instruction ?? '', /DM routine/);
  }, { slackFacts: ROOMS }));

test('a disabled or paused routine shows no next run', () =>
  withFixture('mcp-disabled-next-run', async (f) => {
    const pulse = await createAgent(f, f.owner, 'agent_next_run');
    await grant(f, pulse.id, 'C_LOBBY');
    const saved = await apply(f, mcp(f.owner), 'save', [channelRoutine(f, pulse.id, 'C_LOBBY')]);
    assert.equal(disposition(saved), 'applied', JSON.stringify(saved.outcomes));
    const [routine] = await f.routines.listRoutines(f.workspaceId, 'C_LOBBY');
    assert.ok(routine);
    const [active] = await routinesFor(f, mcp(f.owner));
    assert.notEqual(active?.nextRunAt, null);
    assert.notEqual(active?.nextRunTime, null);

    const disabled = await apply(f, mcp(f.owner), 'disable', [{
      itemId: 'disable', kind: 'control_routine', workspaceId: f.workspaceId, channelId: 'C_LOBBY',
      routineId: routine.id, expectedVersion: routine.version, action: 'disable',
    }]);
    assert.equal(disposition(disabled), 'applied', JSON.stringify(disabled.outcomes));
    const [inspected] = await routinesFor(f, mcp(f.owner));
    assert.equal(inspected?.state, 'disabled');
    assert.equal(inspected.nextRunAt, null);
    assert.equal(inspected.nextRunTime, null);
  }, { slackFacts: ROOMS }));

test('inspection shows a Channel routine\'s name and task to whoever Slack shows in its Channel', () =>
  withFixture('mcp-routine-content', async (f) => {
    const digest = await createAgent(f, f.member, 'agent_member_digest');
    await grant(f, digest.id, 'G_ROOM');
    await grant(f, digest.id, 'G_OTHER');
    const memberSaved = await apply(f, mcp(f.member), 'member-room', [channelRoutine(f, digest.id, 'G_ROOM')]);
    assert.equal(disposition(memberSaved), 'applied', JSON.stringify(memberSaved.outcomes));
    const ownerSaved = await apply(f, mcp(f.owner), 'owner-other', [channelRoutine(f, digest.id, 'G_OTHER')]);
    assert.equal(disposition(ownerSaved), 'applied', JSON.stringify(ownerSaved.outcomes));

    const content = async (context: ManagementActorContext) => Object.fromEntries(
      (await routinesFor(f, context)).map((routine) => [routine.channelId, {
        name: routine.name,
        taskText: routine.taskText,
        contentAccess: routine.contentAccess,
      }]),
    );
    assert.deepEqual(await content(mcp(f.owner)), {
      G_ROOM: { name: 'Pulse G_ROOM', taskText: 'Summarize the Channel.', contentAccess: 'private_member' },
      G_OTHER: { name: 'Pulse G_OTHER', taskText: 'Summarize the Channel.', contentAccess: 'private_member' },
    });
    assert.deepEqual(await content(mcp(f.member)), {
      G_ROOM: { name: 'Pulse G_ROOM', taskText: 'Summarize the Channel.', contentAccess: 'private_member' },
      G_OTHER: { name: null, taskText: null, contentAccess: 'private_nonmember' },
    });
  }, { slackFacts: ROOMS }));

test('a member\'s inspection lists the shared Agents they may schedule with, marking the ones they edit', () =>
  withFixture('member-usable-agents', async (f) => {
    const shared = await createAgent(f, f.owner, 'agent_shared', { name: 'Shared helper' });
    await grant(f, shared.id, 'C_LOBBY');
    const own = await createAgent(f, f.member, 'agent_own', { name: 'Own helper' });
    await createAgent(f, f.owner, 'agent_owners_only', { name: 'Owners only' });
    const hidden = await createAgent(f, f.owner, 'agent_hidden', { name: 'Hidden helper' });
    await grant(f, hidden.id, 'G_OTHER');

    const snapshot = await f.service.inspectWorkspace(chickpeaDm(f, f.member));
    assert.deepEqual(snapshot.agents.map(({ id }) => id), [own.id]);
    assert.deepEqual(snapshot.usableAgents, [
      { id: own.id, name: 'Own helper', handle: 'own-helper', canEdit: true },
      { id: shared.id, name: 'Shared helper', handle: 'shared-helper', canEdit: false },
    ]);

    const saved = await apply(f, chickpeaDm(f, f.member), 'shared-dm', [dmRoutine(f, shared.id)]);
    assert.equal(disposition(saved), 'applied', JSON.stringify(saved.outcomes));
  }, { slackFacts: ROOMS }));
