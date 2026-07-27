import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashRoutineValue } from '../src/routines/ids.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinitionContent } from '../src/routines/types.ts';

const HOUR = 60 * 60 * 1_000;
const START = Date.UTC(2026, 6, 27, 12);

function definition(minute = 0): RoutineDefinitionContent {
  const expression = `${minute} * * * *`;
  return {
    name: `Hourly at ${minute}`,
    description: 'Scheduler fixture.',
    taskText: 'Inspect current channel state.',
    triggerKind: 'schedule',
    scheduleInput: expression,
    scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression }),
    timezone: 'UTC',
    outputPolicy: 'post',
    authorityMode: 'live_channel_v1',
  };
}

async function createRoutine(
  store: SqliteRoutineStore,
  routineId: string,
  nextRunAt: number,
  minute = new Date(nextRunAt).getUTCMinutes(),
): Promise<void> {
  const tokenHash = hashRoutineValue(`token-${routineId}`);
  const draft = {
    action: 'create' as const,
    routineId,
    definition: definition(minute),
    nextRunAt,
    projectedDailyStarts: 1,
    reservations: [{ windowStart: nextRunAt, count: 1 }],
  };
  const previewHash = hashRoutineValue(JSON.stringify(draft));
  await store.putConfirmation({
    confirmationId: `confirm_${routineId}`,
    tokenHash,
    actorId: 'U_MEMBER',
    actorClass: 'member',
    workspaceId: 'T_TEST',
    channelId: `C_${routineId}`,
    draft,
    previewHash,
    expiresAt: START + 15 * 60_000,
  });
  await store.confirm({
    tokenHash,
    actorId: 'U_MEMBER',
    workspaceId: 'T_TEST',
    channelId: `C_${routineId}`,
    previewHash,
    idempotencyKey: `confirm:${routineId}`,
  });
}

test('heartbeat claims oldest due schedules once and aggregates downtime without catch-up', async () => {
  const store = new SqliteRoutineStore(':memory:', () => START);
  try {
    await createRoutine(store, 'routine_missed', START - 2 * HOUR);
    await createRoutine(store, 'routine_current', START);

    const batch = await store.claimDueSchedules({ now: START, owner: 'heartbeat-1', limit: 25 });
    assert.equal(batch.scannedCount, 2);
    assert.equal(batch.deferredCount, 0);
    assert.deepEqual(batch.runs.map((run) => run.routineId), ['routine_missed', 'routine_current']);
    assert.equal(batch.runs[0]?.status, 'skipped');
    assert.equal(batch.runs[0]?.skipReason, 'missed_schedule');
    assert.equal(batch.runs[0]?.missedSlotCount, 3);
    assert.equal(batch.runs[0]?.firstMissedAt, START - 2 * HOUR);
    assert.equal(batch.runs[0]?.lastMissedAt, START);
    assert.equal(batch.runs[1]?.status, 'queued');

    const repeated = await store.claimDueSchedules({ now: START, owner: 'heartbeat-2', limit: 25 });
    assert.equal(repeated.scannedCount, 0);
    assert.equal((await store.listRuns()).length, 2);
  } finally {
    store.close();
  }
});

test('overlap is skipped while deployment saturation defers inside admission grace', async () => {
  const store = new SqliteRoutineStore(':memory:', () => START);
  try {
    for (let index = 0; index < 4; index += 1) {
      await createRoutine(store, `routine_active_${index}`, START, 0);
    }
    const first = await store.claimDueSchedules({ now: START, owner: 'heartbeat-first', limit: 25 });
    assert.equal(first.runs.filter((run) => run.status === 'queued').length, 4);

    await createRoutine(store, 'routine_deferred', START + 15 * 60_000, 15);
    const saturated = await store.claimDueSchedules({
      now: START + 15 * 60_000,
      owner: 'heartbeat-saturated',
      limit: 25,
    });
    assert.equal(saturated.runs.length, 0);
    assert.equal(saturated.deferredCount, 1);
    assert.equal((await store.getRoutine('routine_deferred'))?.nextRunAt, START + 15 * 60_000);

    const overlap = await store.claimDueSchedules({
      now: START + HOUR,
      owner: 'heartbeat-overlap',
      limit: 25,
    });
    assert.equal(overlap.runs.length, 5);
    assert.equal(overlap.runs.filter((run) => run.skipReason === 'overlap').length, 4);
    assert.equal(
      overlap.runs.find((run) => run.routineId === 'routine_deferred')?.skipReason,
      'admission_grace_expired',
    );
  } finally {
    store.close();
  }
});

test('due scan is indexed, oldest-first, and bounded to twenty-five routines', async () => {
  const store = new SqliteRoutineStore(':memory:', () => START);
  try {
    for (let index = 0; index < 26; index += 1) {
      const offsetMinutes = index * 15;
      const nextRunAt = START - offsetMinutes * 60_000;
      await createRoutine(store, `routine_batch_${String(index).padStart(2, '0')}`, nextRunAt);
    }
    const batch = await store.claimDueSchedules({ now: START, owner: 'heartbeat-batch', limit: 25 });
    assert.equal(batch.scannedCount, 25);
    assert.equal(batch.runs[0]?.routineId, 'routine_batch_25');
    assert.equal(batch.runs.at(-1)?.routineId, 'routine_batch_01');
    assert.equal((await store.getRoutine('routine_batch_00'))?.nextRunAt, START);
  } finally {
    store.close();
  }
});
