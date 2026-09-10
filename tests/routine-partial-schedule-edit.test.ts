import { invokeSlackScheduleAction } from '../src/management/slack-schedule-actions.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import {
  executeSlackScheduleCommand,
} from '../src/routines/slack-command.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = Date.UTC(2026, 10, 1, 8, 45);

for (const edit of ['task', 'ordinary', 'time', 'timezone', 'echo', 'completed', 'cron'] as const) {
test(`partial schedule edit preserves canonical timing: ${edit}`, async () => {
  let now = NOW;
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, {
    now: NOW,
    teamId: 'T_SCHEDULE_COMMAND',
    suffix: 'schedule-command',
  });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const routines = new SqliteRoutineStore(':memory:', () => now);
  try {
    const agent = await config.createAgent({
      id: 'agent_schedule_command',
      name: 'Schedule Command',
      instructions: 'Run scheduled work.',
      enabled: true,
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.putChannel({
      workspaceId: 'T_SCHEDULE_COMMAND',
      channelId: 'C_SCHEDULE_COMMAND',
      label: 'schedule-command',
      lifecycle: 'active',
    }, 0);
    await config.putAgentChannelGrant({
      workspaceId: 'T_SCHEDULE_COMMAND',
      channelId: 'C_SCHEDULE_COMMAND',
      agentId: agent.id,
      status: 'active',
      createdByMembershipId: owner.membership.id,
    });
    const dependencies = {
      routines,
      config,
      identity,
      schedulingAvailable: true,
      now: () => now,
      createRunId: () => 'run_schedule_command',
    };
    const save = {
      kind: 'save' as const,
      requiredConnectionAccountIds: [],
      actionKey: 'rsaction_shared_save',
      itemId: 'save',
      actorUserId: owner.user.id,
      actorMembershipId: owner.membership.id,
      workspaceId: 'T_SCHEDULE_COMMAND',
      channelId: 'C_SCHEDULE_COMMAND',
      agentId: agent.id,
      name: 'Daily check',
      description: 'Check daily.',
      taskText: 'Tell me what changed.',
      schedule: edit === 'cron' ? { kind: 'cron' as const, expression: '30 12 * * *' }
        : { kind: 'in' as const, minutes: edit === 'ordinary' ? 120 : 45 },
      timezone: 'America/Los_Angeles',
      outputPolicy: 'post' as const,
    };
    const first = await executeSlackScheduleCommand(save, dependencies);
    if (edit === 'completed') {
      now = first.routine.nextRunAt! + 1;
      const run = await routines.createOccurrence({
        runId: 'rrun_completed_once', idempotencyKey: 'completed-once', routineId: first.routine.id,
        routineVersion: first.routine.version, scheduledFor: first.routine.nextRunAt!,
        triggerSource: 'once', queuedAt: now, deadlineAt: now + 60_000,
      });
      await routines.startAdmissionAttempt({ occurrenceId: run.id, owner: 'heartbeat',
        invokeStartedAt: now, leaseUntil: now + 30_000 });
      await routines.beginOccurrence({ occurrenceId: run.id, flueRunId: 'run_completed_once', startedAt: now });
      await routines.transitionRun({ occurrenceId: run.id, from: ['running'], to: 'succeeded', at: now });
      const completed = await routines.getRoutine(first.routine.id);
      assert.equal(completed?.state, 'completed');
      await assert.rejects(executeSlackScheduleCommand({ ...save, actionKey: 'rename_completed',
        routineId: first.routine.id, expectedVersion: first.routine.version,
        name: 'Renamed completed job', schedule: { kind: 'preserve' },
      }, dependencies), { code: 'routine_one_time_elapsed' });
      assert.deepEqual(await routines.getRoutine(first.routine.id), completed);
      assert.equal(completed?.nextRunAt, null);
      assert.equal((await routines.listRuns()).length, 1);
      return;
    }
    if (edit === 'task') assert.equal(new Date(first.routine.nextRunAt!).toISOString(), '2026-11-01T09:30:00.000Z');
    let captured: any;
    const sentinel = new Error('captured-before-reservation');
    const signal: any = { agentId: save.agentId, workspaceId: save.workspaceId, channelId: save.channelId,
      conversationKind: 'channel', requesterText: 'include refunds too', slackUserId: 'U_TEST',
      messageTs: '1793522700.000001', threadTs: '1793522700.000001', turnJobId: 'turn_edit' };
    const capture = async () => {
    try {
      await invokeSlackScheduleAction({ signal, context: { organizationId: owner.membership.organizationId,
        userId: owner.user.id, membershipId: owner.membership.id, origin: { kind: 'slack', ...signal } },
        operation: { kind: 'save_routine', requiredConnectionAccountIds: [], itemId: 'edit', agentId: save.agentId,
          workspaceId: save.workspaceId, channelId: save.channelId, routineId: first.routine.id,
          expectedVersion: first.routine.version, taskText: 'Tell me what changed, including refunds.',
          ...(edit === 'time' ? { schedule: { kind: 'once', localDateTime: '2026-11-01T02:30' } } : {}),
          ...(edit === 'timezone' ? { timezone: 'Pacific/Honolulu' } : {}),
          ...(edit === 'echo' ? { timezone: save.timezone } : {}) },
        dependencies: { ...dependencies, management: { reserveRequest: async (request: any) => {
          captured = request.operations[0]; throw sentinel;
        } } as any, service: {} as any }
      });
    } catch (error) { if (error !== sentinel) throw error; }
    };
    await capture();
    assert.ok(captured);
    assert.equal(captured.schedule.kind, ['time', 'timezone'].includes(edit) ? 'once' : 'preserve');
    const edited = await executeSlackScheduleCommand({ ...save, ...captured, kind: 'save', actionKey: 'rsaction_edit' }, dependencies);
    if (edit === 'time' || edit === 'timezone') {
      assert.equal(new Date(edited.routine.nextRunAt!).toISOString(), edit === 'time'
        ? '2026-11-01T10:30:00.000Z' : '2026-11-01T11:30:00.000Z');
    } else {
      assert.equal(edited.routine.nextRunAt, first.routine.nextRunAt);
      assert.equal(edited.routine.scheduleJson, first.routine.scheduleJson);
    }
    assert.equal(edited.routine.taskText, 'Tell me what changed, including refunds.');
    const admitted = JSON.stringify(captured);
    await capture();
    assert.equal(JSON.stringify(captured), admitted, 'Re-admission resolves omissions from the original expected revision');
    const replay = await executeSlackScheduleCommand({ ...save, ...captured, kind: 'save', actionKey: 'rsaction_edit' }, dependencies);
    assert.equal(replay.routine.version, edited.routine.version);
    assert.equal(replay.routine.scheduleJson, edited.routine.scheduleJson);
    assert.equal(replay.routine.nextRunAt, edited.routine.nextRunAt);
    // A different action based on the old version must not overwrite the current edit.
    await assert.rejects(executeSlackScheduleCommand({ ...save, ...captured, kind: 'save', actionKey: 'rsaction_stale' }, dependencies));
    assert.equal((await routines.getRoutine(first.routine.id))!.version, edited.routine.version);
    await assert.rejects(executeSlackScheduleCommand({ ...save, schedule: { kind: 'preserve' }, actionKey: 'rsaction_invalid_create' }, dependencies));
    await assert.rejects(executeSlackScheduleCommand({ ...save, routineId: first.routine.id,
      schedule: { kind: 'preserve' }, actionKey: 'rsaction_missing_version' }, dependencies));
  } finally { config.close(); identity.close(); routines.close(); }
});

}
