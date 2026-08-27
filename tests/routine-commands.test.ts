import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  handleRoutineSlackRequest as handleRoutineSlackRequestImpl,
  parseRoutineCommand,
  routineResponseVisibility,
} from '../src/routines/commands.ts';
import { normalizeRoutineSchedule } from '../src/routines/schedule.ts';
import type { RoutineCapability } from '../src/routines/scheduler-adapter.ts';
import { RoutineService } from '../src/routines/service.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinition, RoutineStore } from '../src/routines/types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const NOW = Date.UTC(2026, 6, 27, 12);
const enabled: RoutineCapability = {
  target: 'cloudflare', available: true, enabled: true, reason: 'enabled',
};
const assignment: ResolvedAssignment = {
  workspaceId: 'T_TEST',
  channelId: 'C_TEST',
  agentId: 'agent_test',
  agent: {
    id: 'agent_test', kind: 'user', revision: 1, name: 'Test Agent', instructions: 'Test.',
    enabled: true, lifecycle: 'active', creatorMembershipId: 'membership_test',
    editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'openai/gpt-5.6',
  modelAttribution: { source: 'workspace_default', providerId: 'openai', workspaceDefaultRevision: 1 },
};

function turn(text: string, eventId = `Ev_${Math.random().toString(36).slice(2)}`): NormalizedSlackTurn {
  return {
    workspaceId: 'T_TEST', channelId: 'C_TEST', eventId, text, userId: 'U_MEMBER',
    actorMembershipId: 'membership_test',
    messageTs: '1785000000.000100', threadTs: '1785000000.000100',
    source: 'app_mention', contextMode: 'channel_history',
  };
}

async function handleRoutineSlackRequest(
  requestTurn: NormalizedSlackTurn,
  store: RoutineStore,
  dependencies: Partial<Parameters<typeof handleRoutineSlackRequestImpl>[2]> = {},
): Promise<string | undefined> {
  return handleRoutineSlackRequestImpl(requestTurn, undefined, {
    store,
    capability: enabled,
    now: () => NOW,
    canManageChannel: async () => true,
    isActiveActor: async () => true,
    assignment,
    bindAuthority: async ({ routine }) => ({
      scheduleId: routine.id,
      agentId: assignment.agentId,
      workspaceId: routine.workspaceId,
      channelId: routine.channelId,
      destinationKind: 'channel',
      destinationBindingDigest: null,
      createdByMembershipId: 'membership_test',
      runsAsMembershipId: 'membership_test',
      authorityReceiptId: 'schedule_authority_test',
      requiredConnectionAccountIds: [],
      state: 'active',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    resolveAuthority: async (routine) => ({
      reference: {
        scheduleId: routine.id,
        agentId: assignment.agentId,
        workspaceId: routine.workspaceId,
        channelId: routine.channelId,
        destinationKind: 'channel',
        destinationBindingDigest: null,
        createdByMembershipId: 'membership_test',
        runsAsMembershipId: 'membership_test',
        authorityReceiptId: 'schedule_authority_test',
        requiredConnectionAccountIds: [],
        state: 'active',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      agent: assignment.agent,
      assignment: assignment as ResolvedAssignment & {
        model: string;
        modelAttribution: NonNullable<ResolvedAssignment['modelAttribution']>;
      },
      actorSlackUserId: 'U_MEMBER',
      effectiveConnections: [],
    }),
    ...dependencies,
  });
}

async function seedRoutine(store: RoutineStore, name = 'Support steward'): Promise<RoutineDefinition> {
  const projection = normalizeRoutineSchedule('0 9 * * 1-5', 'UTC', NOW);
  return new RoutineService(store, { now: () => NOW }).save({
    action: 'create',
    actorId: 'U_MEMBER',
    workspaceId: 'T_TEST',
    channelId: 'C_TEST',
    definition: {
      name,
      description: 'Posts the support summary.',
      taskText: 'Post the support summary.',
      triggerKind: 'schedule',
      scheduleInput: '0 9 * * 1-5',
      scheduleJson: projection.scheduleJson,
      timezone: 'UTC',
      outputPolicy: 'post',
      authorityMode: 'live_channel_v1',
    },
    nextRunAt: projection.nextRunAt,
    projectedDailyStarts: projection.projectedDailyStarts,
    reservations: projection.reservations,
  }, 'routine:test:seed:support-steward');
}

test('exact Routine commands parse without model interpretation', () => {
  assert.deepEqual(parseRoutineCommand('!routines'), { kind: 'list' });
  assert.deepEqual(parseRoutineCommand('<@UBOT> !routines <#C_OTHER|ops>', {
    botUserId: 'UBOT',
  }), {
    kind: 'list', channelMention: '<#C_OTHER|ops>',
  });
  assert.deepEqual(parseRoutineCommand('<@UBOT>: !routines help', {
    botUserId: 'UBOT',
  }), { kind: 'help' });
  assert.deepEqual(
    parseRoutineCommand('<!subteam^S012345|@sprout>: !routines help', {
      agentUserGroupId: 'S012345',
    }),
    { kind: 'help' },
  );
  assert.equal(parseRoutineCommand('<@U_TEAMMATE>: !routines help', {
    botUserId: 'UBOT',
  }), undefined);
  assert.equal(parseRoutineCommand('<!subteam^S999999|@oncall>: !routines help', {
    agentUserGroupId: 'S012345',
  }), undefined);
  assert.deepEqual(parseRoutineCommand('!routines pause routine_one'), {
    kind: 'control', action: 'pause', routineId: 'routine_one',
  });
  assert.deepEqual(parseRoutineCommand('!routines confirm abcdef'), {
    kind: 'confirm', token: 'abcdef',
  });
  assert.deepEqual(parseRoutineCommand('!routines nonsense'), { kind: 'invalid' });
  assert.equal(parseRoutineCommand('Every weekday at 9 AM, post the support summary.'), undefined);
});

test('the Routine command handler cannot interpret or persist natural language', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    let membershipChecks = 0;
    const response = await handleRoutineSlackRequestImpl(
      turn('Every weekday at 9 AM, post the support summary.', 'Ev_natural_language'),
      undefined,
      {
        store,
        isActiveActor: async () => { membershipChecks += 1; return true; },
      },
    );
    assert.equal(response, undefined);
    assert.equal(membershipChecks, 0);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 0);
  } finally {
    store.close();
  }
});

test('only a cross-channel Routine list is requester-only', () => {
  assert.equal(routineResponseVisibility('!routines', 'C_TEST'), 'channel');
  assert.equal(routineResponseVisibility('!routines <#C_TEST|current>', 'C_TEST'), 'channel');
  assert.equal(routineResponseVisibility('!routines <#C_OTHER|private>', 'C_TEST'), 'requester');
  assert.equal(routineResponseVisibility('!routines show routine_one', 'C_TEST'), 'channel');
});

test('inactive identities are denied exact controls but natural language remains outside this lane', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const denied = await handleRoutineSlackRequestImpl(turn('!routines'), undefined, {
      store,
      isActiveActor: async () => false,
    });
    assert.equal(denied, 'Only an active Chickpea member can manage schedules.');
    const natural = await handleRoutineSlackRequestImpl(
      turn('Every weekday at 9 AM, post the support summary.'),
      undefined,
      { store, isActiveActor: async () => false },
    );
    assert.equal(natural, undefined);
  } finally {
    store.close();
  }
});

test('exact ID controls remain authorized, idempotent, and confirmation-bound', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const routine = await seedRoutine(store);
    assert.match(await handleRoutineSlackRequest(turn('!routines'), store) ?? '', new RegExp(routine.id));
    assert.match(
      await handleRoutineSlackRequest(turn(`!routines show ${routine.id}`), store) ?? '',
      /Support steward/,
    );
    assert.match(
      await handleRoutineSlackRequest(turn(`!routines pause ${routine.id}`, 'Ev_pause'), store) ?? '',
      /Routine paused/,
    );
    assert.match(
      await handleRoutineSlackRequest(turn(`!routines resume ${routine.id}`, 'Ev_resume'), store) ?? '',
      /Routine resumed/,
    );
    const runText = await handleRoutineSlackRequest(
      turn(`!routines run ${routine.id}`, 'Ev_run'), store,
    );
    assert.match(runText ?? '', /Routine queued/);
    const replay = await handleRoutineSlackRequest(
      turn(`!routines run ${routine.id}`, 'Ev_run'), store,
    );
    assert.equal(replay, runText);
    assert.equal((await store.listRuns({ routineId: routine.id })).length, 1);

    const deletion = await handleRoutineSlackRequest(
      turn(`!routines delete ${routine.id}`, 'Ev_delete'), store,
    );
    assert.match(deletion ?? '', /Delete routine/);
    assert.equal((await store.getRoutine(routine.id))?.deletedAt, null);
    const token = deletion?.match(/!routines confirm ([A-Za-z0-9._-]+)/)?.[1];
    assert.ok(token);
    assert.match(
      await handleRoutineSlackRequest(turn(`!routines confirm ${token}`, 'Ev_confirm'), store) ?? '',
      /Routine deleted/,
    );
    assert.notEqual((await store.getRoutine(routine.id))?.deletedAt, null);
  } finally {
    store.close();
  }
});

test('exact commands reauthorize the current Channel and hide unauthorized IDs', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const routine = await seedRoutine(store);
    const denied = await handleRoutineSlackRequest(
      turn(`!routines show ${routine.id}`),
      store,
      { canManageChannel: async () => false },
    );
    assert.equal(denied, 'That routine or channel was not found or is unavailable.');
  } finally {
    store.close();
  }
});

test('unsupported deployments report capability state without disclosing Routine IDs', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const unavailable: RoutineCapability = {
    target: 'node', available: false, enabled: false, reason: 'unsupported_target',
  };
  try {
    assert.match(
      await handleRoutineSlackRequest(turn('!routines'), store, { capability: unavailable }) ?? '',
      /Cloudflare-only/,
    );
    assert.equal(
      await handleRoutineSlackRequest(turn('!routines show routine_secret'), store, {
        capability: unavailable,
      }),
      'That routine or channel was not found or is unavailable.',
    );
  } finally {
    store.close();
  }
});
