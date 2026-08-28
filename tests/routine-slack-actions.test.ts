import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import {
  invokeSlackScheduleAction,
} from '../src/management/slack-schedule-actions.ts';
import { managementOperationDigest } from '../src/management/contracts.ts';
import { resolveSlackManagementActor } from '../src/management/slack-tools.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { scheduleActionId } from '../src/routines/ids.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = Date.UTC(2026, 7, 27, 18);

test('a first-class DM action creates once and durably queues one reaction', async () => {
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
      name: 'Five-minute inbox check',
      description: 'Check again after five minutes.',
      taskText: 'Check the inbox again and tell me anything new.',
      schedule: { kind: 'in' as const, minutes: 5 },
      timezone: 'America/Los_Angeles',
      outputPolicy: 'post' as const,
    };
    const dependencies = { management, routines, service, now: () => NOW };

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
  } finally {
    identity.close();
    config.close();
    management.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
