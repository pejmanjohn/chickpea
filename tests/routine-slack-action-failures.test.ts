import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { managementOperationDigest } from '../src/management/contracts.ts';
import {
  invokeSlackScheduleAction,
  retryDueSlackScheduleActions,
} from '../src/management/slack-schedule-actions.ts';
import type { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type { ManagementActorContext } from '../src/management/types.ts';
import { scheduleActionId } from '../src/routines/ids.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';

const NOW = Date.UTC(2026, 7, 27, 20);
const RETENTION_MS = 30 * 24 * 60 * 60_000;

test('a third unexpected schedule failure terminates its request, replays durably, and cleans up', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-schedule-terminal-failure-'));
  const statePath = join(directory, 'state.db');
  let now = NOW;
  let applyAttempts = 0;
  const management = new SqliteManagementStore(statePath);
  const routines = new SqliteRoutineStore(statePath, () => now);
  const service = {
    applyWorkspaceChanges: async () => {
      applyAttempts += 1;
      throw new Error('simulated unexpected apply failure');
    },
  } as unknown as WorkspaceManagementService;
  const context: ManagementActorContext = {
    userId: 'user_terminal_failure',
    membershipId: 'membership_terminal_failure',
    organizationId: 'T_TERMINAL_FAILURE',
    actingAgentId: 'agent_terminal_failure',
    origin: {
      kind: 'slack',
      workspaceId: 'T_TERMINAL_FAILURE',
      channelId: 'D_TERMINAL_FAILURE',
      threadTs: '1787883924.314659',
      messageTs: '1787883925.000100',
      conversationKind: 'im',
      agentId: 'agent_terminal_failure',
    },
  };
  const signal = {
    agentId: 'agent_terminal_failure',
    workspaceId: 'T_TERMINAL_FAILURE',
    channelId: 'D_TERMINAL_FAILURE',
    conversationKind: 'im' as const,
    threadTs: '1787883924.314659',
    slackUserId: 'U_TERMINAL_FAILURE',
    eventId: 'Ev_TERMINAL_FAILURE',
    messageTs: '1787883925.000100',
    turnJobId: 'turn_TERMINAL_FAILURE',
    requesterText: 'Schedule this in 5 minutes: Private task text that must become eligible for retention. Only post when the result changes.',
  };
  const operation = {
    itemId: 'schedule',
    kind: 'save_routine' as const,
    agentId: signal.agentId,
    workspaceId: signal.workspaceId,
    destination: { kind: 'current_dm_thread' as const },
    name: 'Terminal inbox check',
    description: 'Exercise durable terminal failure cleanup.',
    taskText: 'Private task text that must become eligible for retention.',
    schedule: { kind: 'in' as const, minutes: 5 },
    timezone: 'America/Los_Angeles',
    outputPolicy: 'post_on_change' as const,
  };
  const dependencies = { management, routines, service, now: () => now };

  try {
    assert.equal((await invokeSlackScheduleAction({
      signal,
      context,
      operation,
      dependencies,
    })).outcome, 'pending');

    now += 2_000;
    assert.equal((await retryDueSlackScheduleActions({
      dependencies,
      resolveContext: async () => context,
    })).attempted, 1);

    now += 4_000;
    assert.equal((await retryDueSlackScheduleActions({
      dependencies,
      resolveContext: async () => context,
    })).attempted, 1);
    assert.equal(applyAttempts, 3);

    const actionId = scheduleActionId(signal.turnJobId, managementOperationDigest([operation]));
    const terminal = await routines.getScheduleAction(actionId);
    assert.deepEqual(terminal?.result, {
      outcome: 'failed',
      code: 'schedule_internal_failure',
    });
    assert.equal(terminal?.attempts, 3);
    const failedRequest = await management.getRequest(terminal!.requestOperationId);
    assert.equal(failedRequest?.status, 'failed');

    const replay = await invokeSlackScheduleAction({
      signal,
      context,
      operation,
      dependencies,
    });
    assert.deepEqual(replay, terminal?.result);
    assert.equal(applyAttempts, 3);

    const failedAt = failedRequest!.updatedAt;
    const repeatedFailure = await management.failRequest(
      terminal!.requestOperationId,
      failedAt + 1,
    );
    assert.equal(repeatedFailure.status, 'failed');
    assert.equal(repeatedFailure.updatedAt, failedAt);

    await management.cleanupRetention(failedAt + RETENTION_MS + 1);
    assert.equal(await management.getRequest(terminal!.requestOperationId), undefined);
  } finally {
    management.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
