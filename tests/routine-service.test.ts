import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RoutineService } from '../src/routines/service.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinitionContent } from '../src/routines/types.ts';

const NOW = Date.UTC(2026, 6, 27, 12);
const NEXT = NOW + 60 * 60 * 1_000;

function definition(): RoutineDefinitionContent {
  return {
    name: 'Project steward',
    description: 'Keeps the project moving.',
    taskText: 'Review status and perform the current channel-authorized follow-up actions.',
    triggerKind: 'schedule',
    scheduleInput: 'Every weekday at 9am',
    scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 9 * * 1-5' }),
    timezone: 'America/Los_Angeles',
    outputPolicy: 'post_on_change',
    authorityMode: 'live_channel_v1',
  };
}

test('service persists only a short-lived draft until the same actor confirms it', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const service = new RoutineService(store, {
    now: () => NOW,
    routineId: () => 'routine_service',
    confirmationId: () => 'rconfirm_service',
    token: () => 'secret-confirmation-token',
  });
  try {
    const receipt = await service.createConfirmation({
      action: 'create',
      actorId: 'U_MEMBER',
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      definition: definition(),
      nextRunAt: NEXT,
      projectedDailyStarts: 5,
      reservations: [{ windowStart: NEXT, count: 1 }],
    });

    assert.equal((await store.listRoutines()).length, 0);
    assert.equal(receipt.token, 'secret-confirmation-token');
    assert.equal(receipt.expiresAt, NOW + 15 * 60 * 1_000);
    assert.equal(await store.getConfirmation(receipt.token), undefined);
    assert.equal(
      (await store.getConfirmation(hashRoutineValue(receipt.token)))?.id,
      receipt.confirmationId,
    );

    const routine = await service.confirm({
      token: receipt.token,
      actorId: 'U_MEMBER',
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      previewHash: receipt.previewHash,
      idempotencyKey: 'routine:service:confirm',
    });
    assert.equal(routine.id, 'routine_service');
    assert.equal(routine.outputPolicy, 'post_on_change');
  } finally {
    store.close();
  }
});

test('service binds edits and deletions to the current optimistic version', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  let confirmation = 0;
  const service = new RoutineService(store, {
    now: () => NOW,
    routineId: () => 'routine_versioned',
    confirmationId: () => `rconfirm_versioned_${confirmation++}`,
    token: () => `token-versioned-${confirmation}`,
  });
  try {
    const create = await service.createConfirmation({
      action: 'create', actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
      definition: definition(), nextRunAt: NEXT, projectedDailyStarts: 5,
      reservations: [{ windowStart: NEXT, count: 1 }],
    });
    const routine = await service.confirm({
      token: create.token, actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
      previewHash: create.previewHash, idempotencyKey: 'create-versioned',
    });
    await assert.rejects(
      () => service.createConfirmation({
        action: 'edit', actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
        routineId: routine.id, expectedVersion: 99, definition: definition(),
        nextRunAt: NEXT, projectedDailyStarts: 5,
        reservations: [{ windowStart: NEXT, count: 1 }],
      }),
      /changed/i,
    );
    const deletion = await service.createConfirmation({
      action: 'delete', actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
      routineId: routine.id, expectedVersion: 1,
    });
    assert.deepEqual(deletion.draft, {
      action: 'delete', routineId: routine.id, expectedVersion: 1,
    });
  } finally {
    store.close();
  }
});
