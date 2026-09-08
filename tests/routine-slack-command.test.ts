import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { bindRoutineAgentAuthority } from '../src/routines/agent-authority.ts';
import { routineDestinationBindingDigest } from '../src/routines/ids.ts';
import {
  executeSlackScheduleCommand,
  SlackScheduleCommandError,
} from '../src/routines/slack-command.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = Date.UTC(2026, 7, 27, 12);

test('the shared schedule command replays save and immediate run effects once', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, {
    now: NOW,
    teamId: 'T_SCHEDULE_COMMAND',
    suffix: 'schedule-command',
  });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
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
      now: () => NOW,
      createRunId: () => 'run_schedule_command',
    };
    const save = {
      kind: 'save' as const,
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
      schedule: { kind: 'cron' as const, expression: '0 9 * * *' },
      timezone: 'UTC',
      outputPolicy: 'post' as const,
    };
    const first = await executeSlackScheduleCommand(save, dependencies);
    const replay = await executeSlackScheduleCommand(save, dependencies);
    assert.equal(first.effect, 'saved');
    assert.equal(replay.effect, 'saved');
    assert.equal(first.routine.id, replay.routine.id);
    assert.equal((await routines.listRoutines('T_SCHEDULE_COMMAND', 'C_SCHEDULE_COMMAND')).length, 1);

    const run = {
      kind: 'run' as const,
      actionKey: 'rsaction_shared_run',
      itemId: 'run',
      actorUserId: owner.user.id,
      routineId: first.routine.id,
    };
    const authority = await config.getAgentScheduleReference(first.routine.id);
    assert.ok(authority);
    const runDependencies = {
      ...dependencies,
      resolveAuthority: async () => ({
        reference: authority,
        agent,
        assignment: {
          workspaceId: 'T_SCHEDULE_COMMAND',
          channelId: 'C_SCHEDULE_COMMAND',
          agentId: agent.id,
          agent,
          model: 'openai/gpt-5.6',
          modelAttribution: { source: 'pinned' as const, providerId: 'openai' },
        },
        actorSlackUserId: owner.user.slackUserId,
        effectiveConnections: [],
      }),
    };
    const firstRun = await executeSlackScheduleCommand(run, runDependencies);
    const replayedRun = await executeSlackScheduleCommand(run, runDependencies);
    assert.equal(firstRun.effect, 'run_queued');
    assert.equal(replayedRun.effect, 'run_queued');
    assert.equal(firstRun.runId, replayedRun.runId);
    assert.equal((await routines.listRuns({ routineId: first.routine.id })).length, 1);
  } finally {
    identity.close();
    config.close();
    routines.close();
  }
});

test('authority failure leaves a durable safe routine state', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, {
    now: NOW,
    teamId: 'T_SCHEDULE_AUTHORITY',
    suffix: 'schedule-authority',
  });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const agent = await config.createAgent({
      id: 'agent_schedule_authority',
      name: 'Schedule Authority',
      instructions: 'Run scheduled work.',
      enabled: true,
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await assert.rejects(
      executeSlackScheduleCommand({
        kind: 'save',
        actionKey: 'rsaction_authority_failure',
        itemId: 'save',
        actorUserId: owner.user.id,
        actorMembershipId: owner.membership.id,
        workspaceId: 'T_SCHEDULE_AUTHORITY',
        channelId: 'C_SCHEDULE_AUTHORITY',
        agentId: agent.id,
        name: 'Unsafe check',
        description: 'Exercise compensation.',
        taskText: 'This must not stay active.',
        schedule: { kind: 'cron', expression: '0 9 * * *' },
        timezone: 'UTC',
        outputPolicy: 'post',
      }, {
        routines,
        config,
        identity,
        schedulingAvailable: true,
        now: () => NOW,
        bindAuthority: async () => { throw new Error('simulated authority failure'); },
      }),
      (error: unknown) => error instanceof SlackScheduleCommandError &&
        error.code === 'schedule_authority_missing' &&
        error.safeRoutine?.state === 'paused',
    );
    const [routine] = await routines.listRoutines('T_SCHEDULE_AUTHORITY', 'C_SCHEDULE_AUTHORITY');
    assert.equal(routine?.state, 'paused');
    assert.equal(routine?.pausedReason, 'schedule_authority_missing');
  } finally {
    identity.close();
    config.close();
    routines.close();
  }
});

test('a direct schedule retry activates the saved pending routine without reporting a new create', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, {
    now: NOW,
    teamId: 'T_DIRECT_RETRY',
    suffix: 'direct-retry',
  });
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-direct-schedule-retry-'));
  const database = join(directory, 'state.sqlite');
  const config = new SqliteConfigStore(database, { agents: [] });
  const routines = new SqliteRoutineStore(database, () => NOW);
  try {
    const agent = await config.createAgent({
      id: 'agent_direct_retry',
      name: 'Direct Retry',
      instructions: 'Run private scheduled work.',
      enabled: true,
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const command = {
      kind: 'save' as const,
      actionKey: 'rsaction_direct_retry',
      itemId: 'save',
      actorUserId: owner.user.id,
      actorMembershipId: owner.membership.id,
      workspaceId: owner.user.slackTeamId,
      channelId: 'D_DIRECT_RETRY',
      agentId: agent.id,
      directDestination: {
        conversationId: 'D_DIRECT_RETRY',
        threadTs: '1800200000.000100',
        ownerMembershipId: owner.membership.id,
      },
      name: 'Private check',
      description: 'Exercise authority recovery.',
      taskText: 'Tell me what changed.',
      schedule: { kind: 'cron' as const, expression: '0 9 * * *' },
      timezone: 'UTC',
      outputPolicy: 'post' as const,
    };
    let attempts = 0;
    const dependencies = {
      routines,
      config,
      identity,
      schedulingAvailable: true,
      now: () => NOW,
      bindAuthority: async (input: Parameters<typeof bindRoutineAgentAuthority>[0]) => {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated first-attempt authority failure');
        assert.equal(input.routine.destination.kind, 'direct_thread');
        return config.putAgentScheduleReference({
          scheduleId: input.routine.id,
          agentId: input.assignment.agentId,
          workspaceId: input.routine.workspaceId,
          channelId: input.routine.channelId,
          destinationKind: 'direct_thread',
          destinationBindingDigest: routineDestinationBindingDigest(
            input.routine.id,
            input.routine.workspaceId,
            input.routine.destination,
          ),
          createdByMembershipId: input.actorMembershipId,
          runsAsMembershipId: input.actorMembershipId,
          authorityReceiptId: 'receipt_direct_retry',
          requiredConnectionAccountIds: [],
          state: 'active',
        }, 0);
      },
    };

    await assert.rejects(
      executeSlackScheduleCommand(command, dependencies),
      (error: unknown) => error instanceof SlackScheduleCommandError &&
        error.code === 'schedule_authority_missing' &&
        error.safeRoutine?.state === 'pending_authority',
    );
    const retry = await executeSlackScheduleCommand(command, dependencies);

    assert.equal(retry.effect, 'saved');
    assert.equal(retry.routine.state, 'active');
    assert.equal(retry.created, false);
    assert.equal((await config.getAgentScheduleReference(retry.routine.id))?.state, 'active');
    assert.equal((await routines.listRoutines(owner.user.slackTeamId, 'D_DIRECT_RETRY')).length, 1);
  } finally {
    identity.close();
    config.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
