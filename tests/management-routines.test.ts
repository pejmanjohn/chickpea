import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

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
    assert.equal(result.status, 'confirmation_required');
    const confirmed = await service.confirmWorkspaceChange({
      context,
      proposalId: result.outcomes[0]!.proposalId!,
    });
    assert.equal(confirmed.status, 'completed');
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

test('a routed Agent manages and inspects only its own routines', async () => {
  const f = await createManagementAdapterFixture('self-routines');
  const workspaceId = f.admin.binding.slackTeamId;
  const support = await f.config.createAgent({
    id: 'agent_self_routine',
    name: 'Routine Self',
    instructions: 'Manage support routines.',
    enabled: true,
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const sales = await f.config.createAgent({
    id: 'agent_sales_routine',
    name: 'Sales Routine',
    instructions: 'Manage sales routines.',
    enabled: true,
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  await f.config.materializeChickpeaAgent();
  const installation = await f.config.ensureWorkspaceInstallation({
    workspaceId,
    transportMode: 'direct',
    defaultAgentId: support.id,
  });
  await f.config.updateWorkspaceInstallation(
    workspaceId,
    { runtimeContract: 'chickpea-v1' },
    installation.revision,
  );
  await f.config.putChannel({
    workspaceId,
    channelId: 'C_SELF_ROUTINE',
    label: 'self-routines',
    lifecycle: 'active',
  }, 0);
  for (const agent of [support, sales]) {
    await f.config.putAgentChannelGrant({
      workspaceId,
      channelId: 'C_SELF_ROUTINE',
      agentId: agent.id,
      status: 'active',
      createdByMembershipId: f.admin.membership.id,
    });
  }
  let sequence = 0;
  const signal = {
    agentId: support.id,
    workspaceId,
    channelId: 'D_SELF_ROUTINE',
    threadTs: '600.1',
    slackUserId: f.admin.binding.slackUserId,
    eventId: `Ev_SELF_ROUTINE_${++sequence}`,
    messageTs: '600.2',
    turnJobId: `turn_SELF_ROUTINE_${sequence}`,
  };
  const routineOperation = (agentId: string, itemId: string) => ({
    itemId,
    kind: 'save_routine' as const,
    agentId,
    workspaceId,
    channelId: 'C_SELF_ROUTINE',
    name: `${itemId} summary`,
    description: `Run ${itemId} summary.`,
    taskText: `Summarize ${itemId}.`,
    schedule: { kind: 'cron' as const, expression: '0 9 * * 1-5' },
    timezone: 'UTC',
    outputPolicy: 'post' as const,
  });
  try {
    const proposal = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'propose_workspace_changes',
      args: { operations: [routineOperation(support.id, 'support')] },
    });
    assert.equal(proposal.ok, true);
    assert.deepEqual(await f.routines.listRoutines(workspaceId, 'C_SELF_ROUTINE'), []);
    await invokeSlackWorkspaceManagementTool({
      signal: { ...signal, eventId: `Ev_SELF_ROUTINE_${++sequence}` },
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: (proposal as { ok: true; result: { proposalId: string } }).result.proposalId },
    });

    const adminContext = {
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: 'routine-admin' },
    };
    const salesProposal = await f.service.proposeWorkspaceChanges({
      context: adminContext,
      operations: [routineOperation(sales.id, 'sales')],
    });
    await f.service.confirmWorkspaceChange({
      context: adminContext,
      proposalId: salesProposal.proposalId,
    });

    const inspected = await invokeSlackWorkspaceManagementTool({
      signal: { ...signal, eventId: `Ev_SELF_ROUTINE_${++sequence}` },
      identity: f.identity,
      service: f.service,
      name: 'inspect_routines',
      args: { workspaceId, channelId: 'C_SELF_ROUTINE' },
    });
    const routines = (inspected as { ok: true; result: {
      routines: Array<{ id: string; name: string | null; contentAccess: string }>;
    } }).result.routines;
    assert.equal(routines.length, 1);
    assert.equal(
      (await f.config.getAgentScheduleReference(routines[0]!.id))?.agentId,
      support.id,
    );
    assert.equal(routines[0]?.contentAccess, 'authorization_unknown');

    const [salesRoutine] = (await f.routines.listRoutines(workspaceId, 'C_SELF_ROUTINE'))
      .filter(({ name }) => name === 'sales summary');
    assert.ok(salesRoutine);
    const crossControl = await invokeSlackWorkspaceManagementTool({
      signal: { ...signal, eventId: `Ev_SELF_ROUTINE_${++sequence}` },
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'cross-routine-control',
        operations: [{
          itemId: 'cross',
          kind: 'control_routine',
          workspaceId,
          channelId: 'C_SELF_ROUTINE',
          routineId: salesRoutine.id,
          expectedVersion: salesRoutine.version,
          action: 'pause',
        }],
      },
    });
    assert.equal((crossControl as { ok: true; result: {
      outcomes: Array<{ disposition: string }>;
    } }).result.outcomes[0]?.disposition, 'chickpea_handoff');
  } finally {
    f.close();
  }
});
