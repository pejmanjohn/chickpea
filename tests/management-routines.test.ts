import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { RoutineService } from '../src/routines/service.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const NOW = Date.UTC(2026, 7, 21, 12);

test('management-created schedules accept active grant-only destinations and bind authority', async () => {
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
    await config.putAgentChannelGrant({
      workspaceId: 'T_MANAGEMENT_ROUTINE',
      channelId: 'C_SUPPORT',
      agentId: 'agent_support',
      status: 'active',
      createdByMembershipId: owner.membership.id,
      channelLabel: 'support',
    });
    assert.equal(await config.getChannel('T_MANAGEMENT_ROUTINE', 'C_SUPPORT'), undefined);
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
    assert.deepEqual(snapshot.channels, [{
      workspaceId: 'T_MANAGEMENT_ROUTINE',
      channelId: 'C_SUPPORT',
      revision: 0,
      label: 'support',
      lifecycle: 'active',
      grants: [{ agentId: 'agent_support', status: 'active', revision: 1 }],
    }]);
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
      args: {
        ...authoringProposalMetadata('support-routine', 'onboarding'),
        operations: [routineOperation(support.id, 'support')],
      },
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
      ...authoringProposalMetadata('sales-routine', 'onboarding'),
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

test('private DM routines need no deployment flag and use trusted thread management', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-management-direct-routines-'));
  const statePath = join(dir, 'state.db');
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, {
    now: NOW, teamId: 'T_DIRECT_ROUTINE', userId: 'U_DIRECT_OWNER',
    suffix: 'management-direct-routine',
  });
  const config = new SqliteConfigStore(statePath, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const routines = new SqliteRoutineStore(statePath, () => NOW);
  try {
    const support = await config.createAgent({
      id: 'agent_direct_support', name: 'Direct support', instructions: 'Help privately.',
      enabled: true, lifecycle: 'active', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    const sales = await config.createAgent({
      id: 'agent_direct_sales', name: 'Direct sales', instructions: 'Help privately.',
      enabled: true, lifecycle: 'active', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.materializeChickpeaAgent();
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: 'T_DIRECT_ROUTINE', transportMode: 'direct', defaultAgentId: support.id,
    });
    await config.updateWorkspaceInstallation(
      'T_DIRECT_ROUTINE', { runtimeContract: 'chickpea-v1' }, installation.revision,
    );
    const service = new WorkspaceManagementService({
      identity, config, management, routines,
      routineSchedulingAvailable: true,
      now: () => NOW,
      randomId: (() => { let sequence = 0; return () => `direct_${++sequence}`; })(),
    });
    let sequence = 0;
    const signal = (agentId: string, threadTs: string, conversationKind: 'im' | 'mpim' = 'im') => ({
      agentId, workspaceId: 'T_DIRECT_ROUTINE', channelId: 'D_DIRECT_OWNER',
      conversationKind, threadTs, slackUserId: owner.binding.slackUserId,
      eventId: `Ev_DIRECT_${++sequence}`, messageTs: `${sequence}.2`,
      turnJobId: `turn_DIRECT_${sequence}`,
    });
    const createOperation = {
      itemId: 'private-schedule', kind: 'save_routine' as const,
      agentId: support.id, workspaceId: 'T_DIRECT_ROUTINE',
      destination: { kind: 'current_dm_thread' as const },
      name: 'Private support pulse', description: 'Check private support state.',
      taskText: 'Review the private support queue.',
      schedule: { kind: 'cron' as const, expression: '0 9 * * 1-5' },
      timezone: 'UTC', outputPolicy: 'post' as const,
    };

    const rawDestinationAttempt = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id, '95.1'), identity, service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'private-create-raw-destination',
        operations: [{ ...createOperation, channelId: 'D_DIRECT_OWNER' }],
      },
    });
    assert.equal((rawDestinationAttempt as { ok: true; result: {
      outcomes: Array<{ disposition: string }>;
    } }).result.outcomes[0]?.disposition, 'failed');
    assert.deepEqual(await routines.listRoutines('T_DIRECT_ROUTINE', 'D_DIRECT_OWNER'), []);

    const proposed = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id, '100.1'), identity, service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('private-schedule', 'onboarding'),
        operations: [createOperation],
      },
    });
    assert.equal(proposed.ok, true);
    const proposalId = (proposed as { ok: true; result: { proposalId: string } }).result.proposalId;
    const confirmed = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id, '100.1'), identity, service,
      name: 'confirm_workspace_change', args: { proposalId },
    });
    assert.equal(confirmed.ok, true);
    const [routine] = await routines.listRoutines('T_DIRECT_ROUTINE', 'D_DIRECT_OWNER');
    assert.ok(routine);
    assert.equal(routine.state, 'active');
    assert.deepEqual(routine.destination, {
      kind: 'direct_thread', conversationId: 'D_DIRECT_OWNER', threadTs: '100.1',
      ownerMembershipId: owner.membership.id,
    });
    assert.deepEqual(await config.listAgentChannelGrants('T_DIRECT_ROUTINE'), []);

    const inspect = async (agentId: string) => invokeSlackWorkspaceManagementTool({
      signal: signal(agentId, '200.1'), identity, service,
      name: 'inspect_routines', args: { workspaceId: 'T_DIRECT_ROUTINE' },
    });
    const supportInspection = await inspect(support.id) as {
      ok: true; result: { routines: Array<{ id: string; name: string | null; contentAccess: string }> };
    };
    assert.equal(supportInspection.result.routines[0]?.id, routine.id);
    assert.equal(supportInspection.result.routines[0]?.name, routine.name);
    assert.equal(supportInspection.result.routines[0]?.contentAccess, 'private');
    assert.deepEqual((await inspect(sales.id) as { ok: true; result: { routines: unknown[] } })
      .result.routines, []);
    assert.equal((await inspect('agent_chickpea') as { ok: true; result: { routines: unknown[] } })
      .result.routines.length, 1);

    const memberReassignment = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id, '225.1'), identity, service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'member-reassign-private-schedule',
        operations: [{
          itemId: 'reassign', kind: 'reassign_routine_agent',
          workspaceId: 'T_DIRECT_ROUTINE', routineId: routine.id,
          expectedVersion: routine.version, agentId: sales.id,
        }],
      },
    });
    assert.equal((memberReassignment as { ok: true; result: {
      outcomes: Array<{ disposition: string }>;
    } }).result.outcomes[0]?.disposition, 'chickpea_handoff');

    const reassignSignal = signal('agent_chickpea', '250.1');
    const reassignment = await invokeSlackWorkspaceManagementTool({
      signal: reassignSignal, identity, service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('reassign-private-schedule', 'agent_edit'),
        operations: [{
          itemId: 'reassign', kind: 'reassign_routine_agent',
          workspaceId: 'T_DIRECT_ROUTINE', routineId: routine.id,
          expectedVersion: routine.version, agentId: sales.id,
        }],
      },
    });
    assert.equal(reassignment.ok, true);
    const reassignProposalId = (reassignment as {
      ok: true; result: { proposalId: string };
    }).result.proposalId;
    const previousAuthority = await config.getAgentScheduleReference(routine.id);
    await invokeSlackWorkspaceManagementTool({
      signal: { ...reassignSignal, eventId: `Ev_DIRECT_${++sequence}` },
      identity, service, name: 'confirm_workspace_change',
      args: { proposalId: reassignProposalId },
    });
    const reassignedAuthority = await config.getAgentScheduleReference(routine.id);
    assert.equal(reassignedAuthority?.agentId, sales.id);
    assert.notEqual(reassignedAuthority?.authorityReceiptId, previousAuthority?.authorityReceiptId);
    assert.equal(reassignedAuthority?.destinationBindingDigest, previousAuthority?.destinationBindingDigest);
    assert.deepEqual((await inspect(support.id) as { ok: true; result: { routines: unknown[] } })
      .result.routines, []);
    assert.equal((await inspect(sales.id) as { ok: true; result: { routines: unknown[] } })
      .result.routines.length, 1);

    const rawControlAttempt = await invokeSlackWorkspaceManagementTool({
      signal: signal(sales.id, '275.1'), identity, service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'private-control-raw-destination',
        operations: [{
          itemId: 'pause', kind: 'control_routine', workspaceId: 'T_DIRECT_ROUTINE',
          channelId: 'D_DIRECT_OWNER', routineId: routine.id,
          expectedVersion: routine.version, action: 'pause',
        }],
      },
    });
    assert.equal((rawControlAttempt as { ok: true; result: {
      outcomes: Array<{ disposition: string }>;
    } }).result.outcomes[0]?.disposition, 'failed');

    const paused = await invokeSlackWorkspaceManagementTool({
      signal: signal(sales.id, '300.1'), identity, service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'pause-private-from-another-thread',
        operations: [{
          itemId: 'pause', kind: 'control_routine', workspaceId: 'T_DIRECT_ROUTINE',
          routineId: routine.id, expectedVersion: routine.version, action: 'pause',
        }],
      },
    });
    assert.equal(paused.ok, true);
    assert.equal((await routines.getRoutine(routine.id))?.state, 'paused');

    const groupAttempt = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id, '400.1', 'mpim'), identity, service,
      name: 'apply_workspace_changes',
      args: { idempotencyKey: 'group-dm-create', operations: [createOperation] },
    });
    assert.equal(groupAttempt.ok, true);
    assert.equal((groupAttempt as { ok: true; result: {
      outcomes: Array<{ disposition: string }>;
    } }).result.outcomes[0]?.disposition, 'failed');

    const pausedRoutine = (await routines.getRoutine(routine.id))!;
    const activeRoutine = await new RoutineService(routines).control({
      routineId: pausedRoutine.id,
      expectedVersion: pausedRoutine.version,
      action: 'resume',
      actorId: owner.user.id,
      actorClass: 'operator',
      reasonCode: 'test_reactivate',
      idempotencyKey: 'test:reactivate-before-authority-failure',
    });
    const originalPutReference = config.putAgentScheduleReference.bind(config);
    config.putAgentScheduleReference = (() => {
      throw new Error('simulated authority write failure');
    }) as typeof config.putAgentScheduleReference;
    try {
      const editSignal = signal('agent_chickpea', '500.1');
      const editProposal = await invokeSlackWorkspaceManagementTool({
        signal: editSignal, identity, service,
        name: 'propose_workspace_changes',
        args: {
          ...authoringProposalMetadata('private-schedule-authority-failure', 'agent_edit'),
          operations: [{
            ...createOperation,
            itemId: 'edit-after-authority-failure',
            agentId: sales.id,
            routineId: routine.id,
            expectedVersion: activeRoutine.version,
            name: 'Edited private support pulse',
          }],
        },
      });
      assert.equal(editProposal.ok, true);
      const editProposalId = (editProposal as {
        ok: true; result: { proposalId: string };
      }).result.proposalId;
      const failedEdit = await invokeSlackWorkspaceManagementTool({
        signal: { ...editSignal, eventId: `Ev_DIRECT_${++sequence}` },
        identity, service, name: 'confirm_workspace_change',
        args: { proposalId: editProposalId },
      });
      assert.equal((failedEdit as { ok: true; result: {
        outcomes: Array<{ disposition: string }>;
      } }).result.outcomes[0]?.disposition, 'failed');
    } finally {
      config.putAgentScheduleReference = originalPutReference;
    }
    const authorityFailedRoutine = await routines.getRoutine(routine.id);
    assert.equal(authorityFailedRoutine?.state, 'paused');
    assert.equal(authorityFailedRoutine?.pausedReason, 'schedule_authority_missing');
  } finally {
    identity.close();
    config.close();
    management.close();
    routines.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
