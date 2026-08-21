import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = Date.UTC(2026, 7, 21, 12);

test('management-created schedules bind one active Agent and runs-as member', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, {
    now: NOW,
    teamId: 'T_MANAGEMENT_ROUTINE',
    suffix: 'management-routine',
  });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    await config.createAgent({
      id: 'agent_support',
      name: 'Support',
      instructions: 'Triage support requests.',
      enabled: true,
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
      slackPresence: {
        requestedHandle: 'support',
        normalizedHandle: 'support',
        desiredState: 'active',
        health: 'healthy',
        userGroupId: 'S_SUPPORT',
        avatar: { kind: 'generated', seed: 'support', revision: 1 },
      },
    });
    await config.putChannel({
      workspaceId: 'T_MANAGEMENT_ROUTINE',
      channelId: 'C_SUPPORT',
      label: 'support',
      lifecycle: 'active',
    });
    await config.putAgentChannelGrant({
      workspaceId: 'T_MANAGEMENT_ROUTINE',
      channelId: 'C_SUPPORT',
      agentId: 'agent_support',
      status: 'active',
      createdByMembershipId: owner.membership.id,
    });
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      routines,
      routineSchedulingAvailable: true,
      now: () => NOW,
      randomId: () => 'management_routine',
    });
    const context = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: { kind: 'admin' as const, sessionId: 'session_owner' },
    };
    const result = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'save-support-routine',
      operations: [{
        itemId: 'routine',
        kind: 'save_routine',
        agentId: 'agent_support',
        workspaceId: 'T_MANAGEMENT_ROUTINE',
        channelId: 'C_SUPPORT',
        name: 'Morning triage',
        description: 'Triage the overnight support queue.',
        taskText: 'Summarize urgent support requests.',
        schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
        timezone: 'UTC',
        outputPolicy: 'post',
      }],
    });
    assert.equal(result.status, 'completed');
    const [routine] = await routines.listRoutines('T_MANAGEMENT_ROUTINE', 'C_SUPPORT');
    assert.ok(routine);
    const authority = await config.getAgentScheduleReference(routine.id);
    assert.equal(authority?.agentId, 'agent_support');
    assert.equal(authority?.runsAsMembershipId, owner.membership.id);
    assert.equal(authority?.state, 'active');

    const snapshot = await service.inspectWorkspace(context);
    assert.equal(snapshot.agents[0]?.slackPresence?.normalizedHandle, 'support');
    assert.equal(snapshot.agents[0]?.slackPresence?.avatar.revision, 1);
    assert.ok(snapshot.effectiveRevision);
  } finally {
    identity.close();
    config.close();
    management.close();
    routines.close();
  }
});
