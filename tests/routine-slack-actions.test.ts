import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import {
  invokeSlackScheduleAction,
  retryDueSlackScheduleActions,
} from '../src/management/slack-schedule-actions.ts';
import { managementOperationDigest } from '../src/management/contracts.ts';
import { resolveSlackManagementActor } from '../src/management/slack-tools.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { ManagementError } from '../src/management/types.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { scheduleActionId } from '../src/routines/ids.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = Date.UTC(2026, 7, 27, 18);
const ACTION_SAFETY_FAILURES = 3;

test('first-class DM actions create once, queue reactions, and run now without approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-schedule-action-'));
  const statePath = join(directory, 'state.db');
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, {
    now: NOW,
    teamId: 'T_SLACK_SCHEDULE_ACTION',
    suffix: 'slack-schedule-action',
  });
  const config = new SqliteConfigStore(statePath, { agents: [] });
  const management = new SqliteManagementStore(statePath);
  const routines = new SqliteRoutineStore(statePath, () => NOW);
  try {
    const agent = await config.createAgent({
      id: 'agent_sprout_action',
      name: 'Sprout',
      instructions: 'Check connected inboxes.',
      enabled: true,
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      model: 'openai/gpt-5.6-sol',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: 'T_SLACK_SCHEDULE_ACTION',
      transportMode: 'direct',
      defaultAgentId: agent.id,
    });
    await config.updateWorkspaceInstallation(
      'T_SLACK_SCHEDULE_ACTION',
      { runtimeContract: 'chickpea-v1' },
      installation.revision,
    );
    const service = new WorkspaceManagementService({
      identity, config, management, routines,
      routineSchedulingAvailable: true,
      now: () => NOW,
      randomId: () => 'unused_random_operation',
    });
    const signal = {
      agentId: agent.id,
      workspaceId: 'T_SLACK_SCHEDULE_ACTION',
      channelId: 'D_SLACK_SCHEDULE_ACTION',
      conversationKind: 'im' as const,
      threadTs: '1787874271.095969',
      slackUserId: owner.binding.slackUserId,
      eventId: 'Ev_SLACK_SCHEDULE_ACTION',
      messageTs: '1787874272.000100',
      turnJobId: 'turn_SLACK_SCHEDULE_ACTION',
    };
    const context = await resolveSlackManagementActor(signal, identity);
    const operation = {
      itemId: 'schedule',
      kind: 'save_routine' as const,
      agentId: agent.id,
      workspaceId: signal.workspaceId,
      destination: { kind: 'current_dm_thread' as const },
      name: 'Five-minute recurring inbox check',
      description: 'Check every five minutes.',
      taskText: 'Check the inbox again and tell me anything new.',
      schedule: { kind: 'cron' as const, expression: '*/5 * * * *' },
      timezone: 'America/Los_Angeles',
      outputPolicy: 'post' as const,
    };
    const dependencies = { management, routines, service, now: () => NOW };

    await assert.rejects(
      () => invokeSlackScheduleAction({
        signal: { ...signal, conversationKind: 'mpim' as const },
        context,
        operation,
        dependencies,
      }),
      (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request',
    );

    const first = await invokeSlackScheduleAction({ signal, context, operation, dependencies });
    const replay = await invokeSlackScheduleAction({ signal, context, operation, dependencies });
    assert.equal(first.outcome, 'applied');
    assert.deepEqual(replay, first);
    const saved = await routines.listRoutines(signal.workspaceId, signal.channelId);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.destination.kind, 'direct_thread');
    assert.equal(saved[0]?.destination.kind === 'direct_thread'
      ? saved[0].destination.threadTs
      : undefined, signal.threadTs);

    const actionsNeedingReceipts = await routines.listScheduleActionsNeedingReceipts(10);
    assert.deepEqual(actionsNeedingReceipts, []);
    const expectedActionId = scheduleActionId(
      signal.turnJobId,
      managementOperationDigest([operation]),
    );
    const action = await routines.getScheduleAction(expectedActionId);
    assert.equal(action?.status, 'applied');
    const outbox = await management.getOutboxForOperation(action!.actionId);
    assert.equal(outbox?.destination.kind, 'reaction');
    assert.deepEqual(outbox?.receipt, {
      kind: 'schedule_action',
      transition: 'applied',
      emojiName: 'white_check_mark',
    });

    const runSignal = {
      ...signal,
      eventId: 'Ev_SLACK_SCHEDULE_ACTION_RUN',
      messageTs: '1787874273.000100',
      turnJobId: 'turn_SLACK_SCHEDULE_ACTION_RUN',
    };
    const runOperation = {
      itemId: 'schedule',
      kind: 'run_routine' as const,
      workspaceId: signal.workspaceId,
      routineId: saved[0]!.id,
    };
    const run = await invokeSlackScheduleAction({
      signal: runSignal,
      context,
      operation: runOperation,
      dependencies,
    });
    const runReplay = await invokeSlackScheduleAction({
      signal: runSignal,
      context,
      operation: runOperation,
      dependencies,
    });
    assert.equal(run.outcome, 'applied');
    assert.equal(run.outcome === 'applied' ? run.effect : undefined, 'run_queued');
    assert.deepEqual(runReplay, run);
    assert.equal((await routines.listRuns({ routineId: saved[0]!.id })).length, 1);

    const runActionId = scheduleActionId(
      runSignal.turnJobId,
      managementOperationDigest([runOperation]),
    );
    const runAction = await routines.getScheduleAction(runActionId);
    assert.equal(runAction?.status, 'applied');
    assert.equal(runAction?.result?.outcome === 'applied'
      ? runAction.result.effect
      : undefined, 'run_queued');
    assert.equal((await management.getOutboxForOperation(runActionId))?.destination.kind, 'reaction');
  } finally {
    identity.close();
    config.close();
    management.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a transient first-class action failure recovers from the durable alarm ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-schedule-action-recovery-'));
  const statePath = join(directory, 'state.db');
  let now = NOW;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, {
    now,
    teamId: 'T_SLACK_SCHEDULE_RECOVERY',
    suffix: 'slack-schedule-recovery',
  });
  const config = new SqliteConfigStore(statePath, { agents: [] });
  const management = new SqliteManagementStore(statePath);
  const routines = new SqliteRoutineStore(statePath, () => now);
  try {
    const agent = await config.createAgent({
      id: 'agent_sprout_recovery',
      name: 'Sprout Recovery',
      instructions: 'Check connected inboxes.',
      enabled: true,
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: 'T_SLACK_SCHEDULE_RECOVERY',
      transportMode: 'direct',
      defaultAgentId: agent.id,
    });
    await config.updateWorkspaceInstallation(
      'T_SLACK_SCHEDULE_RECOVERY',
      { runtimeContract: 'chickpea-v1' },
      installation.revision,
    );
    const service = new WorkspaceManagementService({
      identity, config, management, routines,
      routineSchedulingAvailable: true,
      now: () => now,
      randomId: () => 'unused_recovery_operation',
    });
    const originalApply = service.applyWorkspaceChanges.bind(service);
    let attempts = 0;
    service.applyWorkspaceChanges = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error('simulated pre-commit interruption');
      return originalApply(input);
    };
    const signal = {
      agentId: agent.id,
      workspaceId: 'T_SLACK_SCHEDULE_RECOVERY',
      channelId: 'D_SLACK_SCHEDULE_RECOVERY',
      conversationKind: 'im' as const,
      threadTs: '1787883924.314659',
      slackUserId: owner.binding.slackUserId,
      eventId: 'Ev_SLACK_SCHEDULE_RECOVERY',
      messageTs: '1787883925.000100',
      turnJobId: 'turn_SLACK_SCHEDULE_RECOVERY',
    };
    const context = await resolveSlackManagementActor(signal, identity);
    const operation = {
      itemId: 'schedule',
      kind: 'save_routine' as const,
      agentId: agent.id,
      workspaceId: signal.workspaceId,
      destination: { kind: 'current_dm_thread' as const },
      name: 'Recovered inbox check',
      description: 'Check after a transient interruption.',
      taskText: 'Check the inbox and tell me anything new.',
      schedule: { kind: 'in' as const, minutes: 5 },
      timezone: 'America/Los_Angeles',
      outputPolicy: 'post_on_change' as const,
    };
    const dependencies = { management, routines, service, now: () => now };

    const pending = await invokeSlackScheduleAction({ signal, context, operation, dependencies });
    assert.equal(pending.outcome, 'pending');
    now += 2_000;
    const recovery = await retryDueSlackScheduleActions({
      dependencies,
      resolveContext: async () => context,
    });
    assert.equal(recovery.attempted, 1);
    assert.equal(attempts, 2);

    const actionId = scheduleActionId(signal.turnJobId, managementOperationDigest([operation]));
    const action = await routines.getScheduleAction(actionId);
    assert.equal(action?.status, 'applied');
    assert.equal(action?.result?.outcome === 'applied' ? action.result.effect : undefined, 'saved');
    const [saved] = await routines.listRoutines(signal.workspaceId, signal.channelId);
    assert.ok(saved);
    const recoveredReceipt = await management.getOutboxForOperation(actionId);
    assert.equal(recoveredReceipt?.destination.kind, 'thread');
    assert.deepEqual(recoveredReceipt?.receipt, {
      kind: 'schedule_action',
      transition: 'applied',
    });

    const originalPutReference = config.putAgentScheduleReference.bind(config);
    const originalControl = routines.control.bind(routines);
    let compensationAttempts = 0;
    config.putAgentScheduleReference = (() => {
      throw new Error('simulated post-save authority interruption');
    }) as typeof config.putAgentScheduleReference;
    routines.control = (async (input) => {
      compensationAttempts += 1;
      if (compensationAttempts <= ACTION_SAFETY_FAILURES) {
        throw new Error('simulated authority compensation interruption');
      }
      return originalControl(input);
    }) as typeof routines.control;
    const editSignal = {
      ...signal,
      eventId: 'Ev_SLACK_SCHEDULE_AUTHORITY_FAILURE',
      messageTs: '1787883926.000100',
      turnJobId: 'turn_SLACK_SCHEDULE_AUTHORITY_FAILURE',
    };
    const editOperation = {
      ...operation,
      routineId: saved.id,
      expectedVersion: saved.version,
      name: 'Authority-safe inbox check',
    };
    const authorityActionId = scheduleActionId(
      editSignal.turnJobId,
      managementOperationDigest([editOperation]),
    );
    try {
      const pendingAuthority = await invokeSlackScheduleAction({
        signal: editSignal,
        context,
        operation: editOperation,
        dependencies,
      });
      assert.deepEqual(pendingAuthority, { outcome: 'pending', actionId: authorityActionId });
      assert.equal((await routines.getRoutine(saved.id))?.state, 'active');

      for (const delay of [2_000, 4_000]) {
        now += delay;
        const stillRecovering = await retryDueSlackScheduleActions({
          dependencies,
          resolveContext: async () => context,
        });
        assert.equal(stillRecovering.attempted, 1);
      }
      const pendingAfterGenericLimit = await routines.getScheduleAction(authorityActionId);
      assert.equal(pendingAfterGenericLimit?.attempts, ACTION_SAFETY_FAILURES);
      assert.equal(pendingAfterGenericLimit?.status, 'pending');
      assert.equal((await management.getRequest(
        pendingAfterGenericLimit!.requestOperationId,
      ))?.status, 'applying');

      now += 8_000;
      const authorityRecovery = await retryDueSlackScheduleActions({
        dependencies,
        resolveContext: async () => context,
      });
      assert.equal(authorityRecovery.attempted, 1);
    } finally {
      config.putAgentScheduleReference = originalPutReference;
      routines.control = originalControl;
    }
    assert.equal(compensationAttempts, ACTION_SAFETY_FAILURES + 1);
    assert.deepEqual((await routines.getScheduleAction(authorityActionId))?.result, {
      outcome: 'failed',
      code: 'schedule_authority_missing',
      routineId: saved.id,
      safeState: 'paused',
    });
    assert.equal((await management.getRequest(
      (await routines.getScheduleAction(authorityActionId))!.requestOperationId,
    ))?.status, 'completed');
    assert.equal((await routines.getRoutine(saved.id))?.pausedReason, 'schedule_authority_missing');
  } finally {
    identity.close();
    config.close();
    management.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
