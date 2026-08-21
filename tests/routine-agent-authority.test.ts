import assert from 'node:assert/strict';
import { test } from 'node:test';

import { provisionSlackInteractionMember } from '../src/auth/slack-admission.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ConnectionAccountOwnerKind, ResolvedAssignment } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import {
  bindRoutineAgentAuthority,
  reassignRoutineAgentAuthority,
  resolveRoutineAgentAuthority,
  RoutineAuthorityError,
} from '../src/routines/agent-authority.ts';
import type { RoutineDefinition } from '../src/routines/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const WORKSPACE = 'T_AUTHORITY';
const CHANNEL = 'C_SUPPORT';

test('Agent schedules capture one Runs as authority and safely reassign future runs', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const owner = await createSlackOwner(identity, {
      teamId: WORKSPACE,
      userId: 'U_OWNER',
      suffix: 'routine_authority',
    });
    const bob = await provisionSlackInteractionMember({
      identity,
      slackTeamId: WORKSPACE,
      botUserId: 'U_BOT',
      user: {
        id: 'U_BOB', teamId: WORKSPACE, displayName: 'Bob', email: 'bob@acme.test',
        deleted: false, bot: false, appUser: false, restricted: false,
        ultraRestricted: false, stranger: false,
      },
    });
    assert.ok(bob.resolution);
    const agent = await config.createAgent({
      id: 'agent_support', name: 'Support', instructions: 'Help customers.', enabled: true,
      lifecycle: 'active', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.putAgentChannelGrant({
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id, status: 'active',
      createdByMembershipId: owner.membership.id,
    });
    const team = await putConnection(config, 'connection_team', 'team', owner.membership.id);
    const ownerPersonal = await putConnection(
      config, 'connection_owner', 'member', owner.membership.id, owner.membership.id,
    );
    const bobPersonal = await putConnection(
      config, 'connection_bob', 'member', bob.resolution.membership.id, bob.resolution.membership.id,
    );
    for (const account of [team, ownerPersonal, bobPersonal]) {
      await config.putAgentConnectionBinding({
        agentId: agent.id, connectionAccountId: account.id, providerId: account.providerId,
        allowedCapabilities: [], enabled: true,
      });
    }

    const routine = routineDefinition();
    const assignment: ResolvedAssignment = {
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id,
      agent,
    };
    const first = await bindRoutineAgentAuthority({
      routine, assignment, actorMembershipId: owner.membership.id, env: undefined,
    }, { config, identity });
    assert.equal(first.createdByMembershipId, owner.membership.id);
    assert.equal(first.runsAsMembershipId, owner.membership.id);
    assert.deepEqual(first.requiredConnectionAccountIds.sort(), [team.id, ownerPersonal.id].sort());

    const resolved = await resolveRoutineAgentAuthority(routine, undefined, { config, identity });
    assert.equal(resolved.actorSlackUserId, 'U_OWNER');
    assert.deepEqual(resolved.effectiveConnections.map(({ account }) => account.id).sort(), [
      team.id, ownerPersonal.id,
    ].sort());

    await assert.rejects(
      bindRoutineAgentAuthority({
        routine: { ...routine, taskText: 'Use the other member\'s account.' },
        assignment,
        actorMembershipId: bob.resolution.membership.id,
        env: undefined,
      }, { config, identity }),
      (error: unknown) => error instanceof RoutineAuthorityError &&
        error.reason === 'creator_ineligible',
    );

    const reassigned = await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: bob.resolution.membership.id,
      receiptId: 'schedule_authority_bob',
      config,
      identity,
    });
    assert.equal(reassigned.createdByMembershipId, owner.membership.id);
    assert.equal(reassigned.runsAsMembershipId, bob.resolution.membership.id);
    assert.notEqual(reassigned.authorityReceiptId, first.authorityReceiptId);
    assert.deepEqual(reassigned.requiredConnectionAccountIds.sort(), [team.id, bobPersonal.id].sort());
    assert.equal(
      (await resolveRoutineAgentAuthority(routine, undefined, { config, identity })).actorSlackUserId,
      'U_BOB',
    );

    await config.putConnectionAccount({ ...bobPersonal, lifecycle: 'revoked' }, bobPersonal.revision);
    await assert.rejects(
      resolveRoutineAgentAuthority(routine, undefined, { config, identity }),
      (error: unknown) => error instanceof RoutineAuthorityError &&
        error.reason === 'connection_unavailable',
    );
  } finally {
    config.close();
    identity.close();
  }
});

async function putConnection(
  config: SqliteConfigStore,
  id: string,
  ownerKind: ConnectionAccountOwnerKind,
  createdByMembershipId: string,
  ownerMembershipId?: string,
) {
  return config.putConnectionAccount({
    id,
    workspaceId: WORKSPACE,
    ownerKind,
    ...(ownerMembershipId ? { ownerMembershipId } : {}),
    createdByMembershipId,
    providerId: 'test-provider',
    label: id,
    policy: {
      kind: 'api', allowedHosts: ['api.example.test'], pathPrefixes: ['/'],
      headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential',
    },
    secretRefId: `secret_${id}`,
    lifecycle: 'ready',
  });
}

function routineDefinition(): RoutineDefinition {
  return {
    id: 'routine_support', workspaceId: WORKSPACE, channelId: CHANNEL, creatorUserId: 'U_OWNER',
    name: 'Support check', description: '', taskText: 'Review support.', triggerKind: 'schedule',
    scheduleInput: '0 * * * *',
    scheduleJson: '{"version":1,"kind":"cron","expression":"0 * * * *"}',
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1', state: 'active',
    version: 1, nextRunAt: 1, lastScheduledAt: null, lastFinishedAt: null,
    consecutiveFailures: 0, lastChangeKeyHash: null, projectedDailyStarts: 24,
    reservationWindows: [{ windowStart: 1, count: 1 }], createdAt: 1, createdBy: 'U_OWNER',
    updatedAt: 1, updatedBy: 'U_OWNER', pausedAt: null, pausedBy: null, pausedReason: null,
    disabledAt: null, disabledBy: null, disabledReason: null, deletedAt: null, deletedBy: null,
  };
}
