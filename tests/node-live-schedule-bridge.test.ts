import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('default Node live binding persists one authorized idempotent schedule and refuses foreign authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-live-schedule-'));
  const statePath = join(directory, 'state.sqlite');
  const priorStatePath = process.env.SLACK_STATE_DB_PATH;
  const priorTelemetry = process.env.CHICKPEA_DISABLE_TELEMETRY;
  process.env.SLACK_STATE_DB_PATH = statePath;
  process.env.CHICKPEA_DISABLE_TELEMETRY = 'true';

  const { getConfigStore, getIdentityStore, getManagementStore, getRoutineStore } =
    await import('../src/config/state-backend.ts');
  const { setNodeRoutineSchedulerAvailable } = await import('../src/routines/runtime-state.ts');
  const { invokeLiveSlackScheduleAction } = await import('../src/management/slack-tools.ts');
  const { ManagementError } = await import('../src/management/types.ts');
  const { openStateDb } = await import('../src/state/node-state-db.ts');
  const { createSlackOwner } = await import('./helpers/slack-owner.ts');
  const identity = getIdentityStore();
  const config = getConfigStore();
  const management = getManagementStore();
  const routines = getRoutineStore();
  const db = openStateDb(statePath);
  const durableCounts = () => ({
    requests: Number(db.get('SELECT COUNT(*) AS count FROM management_requests')?.count),
    actions: Number(db.get('SELECT COUNT(*) AS count FROM routine_schedule_actions')?.count),
    routines: Number(db.get('SELECT COUNT(*) AS count FROM routines')?.count),
  });

  try {
    const owner = await createSlackOwner(identity, {
      teamId: 'T_NODE_LIVE_SCHEDULE',
      userId: 'U_NODE_OWNER',
      suffix: 'node-live-schedule',
    });
    const agent = await config.createAgent({
      id: 'agent_node_live', name: 'Node Live', instructions: 'Schedule authorized work.',
      enabled: true, lifecycle: 'active', configurationGeneration: 1,
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const foreignAgent = await config.createAgent({
      id: 'agent_node_foreign', name: 'Node Foreign', instructions: 'Remain separate.',
      enabled: true, lifecycle: 'active', configurationGeneration: 1,
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.putChannel({
      workspaceId: 'T_NODE_LIVE_SCHEDULE', channelId: 'C_NODE_LIVE',
      label: 'node-live', lifecycle: 'active',
    }, 0);
    await config.putAgentChannelGrant({
      workspaceId: 'T_NODE_LIVE_SCHEDULE', channelId: 'C_NODE_LIVE', agentId: agent.id,
      status: 'active', createdByMembershipId: owner.membership.id,
    }, 0);
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: 'T_NODE_LIVE_SCHEDULE', transportMode: 'direct',
      runtimeContract: 'chickpea-v1', defaultAgentId: agent.id,
    });
    if (installation.runtimeContract !== 'chickpea-v1') {
      await config.updateWorkspaceInstallation(
        installation.workspaceId,
        { runtimeContract: 'chickpea-v1' },
        installation.revision,
      );
    }
    const signal = {
      agentId: agent.id,
      workspaceId: 'T_NODE_LIVE_SCHEDULE',
      channelId: 'C_NODE_LIVE',
      conversationKind: 'channel' as const,
      threadTs: '1900000000.000100',
      slackUserId: owner.binding.slackUserId,
      eventId: 'Ev_NODE_LIVE_SCHEDULE',
      messageTs: '1900000001.000100',
      turnJobId: 'turn_NODE_LIVE_SCHEDULE',
      requesterText: 'Schedule Report the Node bridge status every day at 9am UTC.',
    };
    const operation = {
      itemId: 'schedule', kind: 'save_routine' as const,
      agentId: agent.id, workspaceId: signal.workspaceId, channelId: signal.channelId,
      requiredConnectionAccountIds: [], name: 'Node bridge status', description: '',
      taskText: 'Report the Node bridge status',
      schedule: { kind: 'cron' as const, expression: '0 9 * * *' },
      timezone: 'UTC', outputPolicy: 'post' as const,
    };

    const unavailable = await invokeLiveSlackScheduleAction(
      { ...signal, eventId: 'Ev_NODE_NOT_READY', turnJobId: 'turn_NODE_NOT_READY' },
      async () => undefined,
      operation,
    );
    assert.deepEqual(unavailable, {
      outcome: 'failed',
      code: 'routines_unavailable_on_target',
    });
    assert.deepEqual(durableCounts(), { requests: 0, actions: 0, routines: 0 });

    setNodeRoutineSchedulerAvailable(true);
    const first = await invokeLiveSlackScheduleAction(signal, async () => undefined, operation);
    const replay = await invokeLiveSlackScheduleAction(signal, async () => undefined, operation);
    assert.equal(first.outcome, 'applied');
    assert.deepEqual(replay, first);
    const saved = await routines.listRoutines(signal.workspaceId, signal.channelId);
    assert.equal(saved.length, 1);
    assert.equal((await config.getAgentScheduleReference(saved[0]!.id))?.agentId, agent.id);
    assert.equal((await routines.listScheduleActionsNeedingReceipts(10)).length, 0);
    assert.deepEqual(durableCounts(), { requests: 1, actions: 1, routines: 1 });

    await assert.rejects(
      invokeLiveSlackScheduleAction(
        { ...signal, eventId: 'Ev_NODE_CROSS_AGENT', turnJobId: 'turn_NODE_CROSS_AGENT' },
        async () => undefined,
        { ...operation, agentId: foreignAgent.id, name: 'Foreign schedule' },
      ),
      (error: unknown) => error instanceof ManagementError && error.code === 'forbidden' &&
        error.message === 'The addressed user Agent must own this schedule.',
    );
    assert.deepEqual(durableCounts(), { requests: 1, actions: 1, routines: 1 });

    await assert.rejects(
      invokeLiveSlackScheduleAction(
        { ...signal, slackUserId: 'U_NODE_UNKNOWN', eventId: 'Ev_NODE_UNKNOWN', turnJobId: 'turn_NODE_UNKNOWN' },
        async () => undefined,
        operation,
      ),
      (error: unknown) => error instanceof ManagementError && error.code === 'forbidden',
    );
    assert.deepEqual(durableCounts(), { requests: 1, actions: 1, routines: 1 });

    setNodeRoutineSchedulerAvailable(false);
    const stopped = await invokeLiveSlackScheduleAction(
      { ...signal, eventId: 'Ev_NODE_STOPPED', turnJobId: 'turn_NODE_STOPPED' },
      async () => undefined,
      operation,
    );
    assert.deepEqual(stopped, {
      outcome: 'failed',
      code: 'routines_unavailable_on_target',
    });
    assert.deepEqual(durableCounts(), { requests: 1, actions: 1, routines: 1 });
  } finally {
    setNodeRoutineSchedulerAvailable(false);
    db.close();
    for (const store of [routines, management, config, identity]) {
      if ('close' in store && typeof store.close === 'function') store.close();
    }
    if (priorStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
    else process.env.SLACK_STATE_DB_PATH = priorStatePath;
    if (priorTelemetry === undefined) delete process.env.CHICKPEA_DISABLE_TELEMETRY;
    else process.env.CHICKPEA_DISABLE_TELEMETRY = priorTelemetry;
    rmSync(directory, { recursive: true, force: true });
  }
});
