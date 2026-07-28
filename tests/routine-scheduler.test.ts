import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashRoutineValue } from '../src/routines/ids.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { RoutineStateError, type RoutineDefinitionContent } from '../src/routines/types.ts';

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

async function createOneTimeRoutine(
  store: SqliteRoutineStore,
  routineId: string,
  at: number,
): Promise<void> {
  await store.save({
    actorId: 'U_MEMBER',
    actorClass: 'member',
    workspaceId: 'T_TEST',
    channelId: `C_${routineId}`,
    draft: {
      action: 'create',
      routineId,
      definition: {
        ...definition(),
        name: 'One-time job',
        triggerKind: 'once',
        scheduleInput: '2026-07-27T12:00',
        scheduleJson: JSON.stringify({
          version: 1,
          kind: 'once',
          localDateTime: '2026-07-27T12:00',
          at,
        }),
      },
      nextRunAt: at,
      projectedDailyStarts: 0,
      reservations: [{ windowStart: at, count: 1 }],
    },
    idempotencyKey: `create:${routineId}`,
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

test('one-time work claims once, completes after its terminal run, and never repeats', async () => {
  const store = new SqliteRoutineStore(':memory:', () => START);
  try {
    await createOneTimeRoutine(store, 'routine_once', START);
    const batch = await store.claimDueSchedules({ now: START, owner: 'once-heartbeat', limit: 25 });
    const run = batch.runs[0];
    assert.ok(run);
    assert.equal(run.triggerSource, 'once');
    assert.equal((await store.getRoutine('routine_once'))?.nextRunAt, null);
    assert.equal((await store.getRoutine('routine_once'))?.state, 'active');

    const current = (await store.getRoutine('routine_once'))!;
    await assert.rejects(
      () => store.save({
        actorId: 'U_MEMBER', actorClass: 'member', workspaceId: 'T_TEST',
        channelId: 'C_routine_once',
        draft: {
          action: 'edit', routineId: current.id, expectedVersion: current.version,
          definition: {
            name: current.name, description: current.description, taskText: current.taskText,
            triggerKind: 'once', scheduleInput: '2026-07-27T13:00',
            scheduleJson: JSON.stringify({
              version: 1, kind: 'once', localDateTime: '2026-07-27T13:00', at: START + HOUR,
            }),
            timezone: current.timezone, outputPolicy: current.outputPolicy,
            authorityMode: current.authorityMode,
          },
          nextRunAt: START + HOUR, projectedDailyStarts: 0,
          reservations: [{ windowStart: START + HOUR, count: 1 }],
        },
        idempotencyKey: 'edit:once:active',
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_run_conflict',
    );

    await store.startAdmissionAttempt({
      occurrenceId: run.id,
      owner: 'once-heartbeat',
      leaseUntil: START + 60_000,
      invokeStartedAt: START,
    });
    await store.recordAdmissionReceipt(run.id, 1, 'flue_once', START);
    assert.equal(await store.beginOccurrence({
      occurrenceId: run.id,
      flueRunId: 'flue_once',
      startedAt: START,
    }), 'started');
    await store.transitionRun({
      occurrenceId: run.id,
      from: ['running'],
      to: 'succeeded',
      at: START + 1_000,
    });
    assert.equal((await store.getRoutine('routine_once'))?.state, 'completed');
    assert.equal(
      (await store.claimDueSchedules({ now: START + HOUR, owner: 'once-repeat', limit: 25 })).runs.length,
      0,
    );
  } finally {
    store.close();
  }
});

test('a paused one-time job resumes only while its scheduled instant is still future', async () => {
  let now = START;
  const store = new SqliteRoutineStore(':memory:', () => now);
  try {
    await createOneTimeRoutine(store, 'routine_once_resume', START + HOUR);
    let routine = (await store.getRoutine('routine_once_resume'))!;
    routine = await store.control({
      routineId: routine.id, expectedVersion: routine.version, action: 'pause',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'pause:once:future',
    });
    now = START + 30 * 60_000;
    routine = await store.control({
      routineId: routine.id, expectedVersion: routine.version, action: 'resume',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'resume:once:future',
    });
    assert.equal(routine.state, 'active');
    assert.equal(routine.nextRunAt, START + HOUR);
    routine = await store.control({
      routineId: routine.id, expectedVersion: routine.version, action: 'pause',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'pause:once:elapsed',
    });
    now = START + 2 * HOUR;
    await assert.rejects(
      () => store.control({
        routineId: routine.id, expectedVersion: routine.version, action: 'resume',
        actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'resume:once:elapsed',
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_one_time_elapsed',
    );
    assert.equal((await store.getRoutine(routine.id))?.state, 'paused');
  } finally {
    store.close();
  }
});

test('pause cancels queued scheduled work, while disable fences an already submitted admission at begin', async () => {
  const store = new SqliteRoutineStore(':memory:', () => START);
  try {
    await createRoutine(store, 'routine_pause_queued', START + HOUR);
    const pausedRoutine = (await store.getRoutine('routine_pause_queued'))!;
    const queued = await store.createOccurrence({
      runId: 'rrun_pause_queued', idempotencyKey: 'run:pause:queued', routineId: pausedRoutine.id,
      routineVersion: pausedRoutine.version, scheduledFor: START + HOUR, triggerSource: 'schedule',
      queuedAt: START, deadlineAt: START + 15 * 60_000,
    });
    await store.control({
      routineId: pausedRoutine.id, expectedVersion: pausedRoutine.version, action: 'pause',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'control:pause:queued',
    });
    assert.equal((await store.getRun(queued.id))?.status, 'cancelled');
    await assert.rejects(
      () => store.startAdmissionAttempt({
        occurrenceId: queued.id, owner: 'scheduler', leaseUntil: START + 60_000, invokeStartedAt: START,
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_run_transition_invalid',
    );

    await createRoutine(store, 'routine_disable_admitting', START + HOUR);
    const disablingRoutine = (await store.getRoutine('routine_disable_admitting'))!;
    const submitted = await store.createOccurrence({
      runId: 'rrun_disable_admitting', idempotencyKey: 'run:disable:admitting', routineId: disablingRoutine.id,
      routineVersion: disablingRoutine.version, scheduledFor: START + HOUR, triggerSource: 'schedule',
      queuedAt: START, deadlineAt: START + 15 * 60_000,
    });
    await store.startAdmissionAttempt({
      occurrenceId: submitted.id, owner: 'scheduler', leaseUntil: START + 60_000, invokeStartedAt: START,
    });
    await store.recordAdmissionReceipt(submitted.id, 1, 'flue_disable_admitting', START);
    await store.control({
      routineId: disablingRoutine.id, expectedVersion: disablingRoutine.version, action: 'disable',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'control:disable:admitting',
    });
    assert.equal((await store.getRun(submitted.id))?.status, 'admitting');
    assert.equal(await store.beginOccurrence({
      occurrenceId: submitted.id, flueRunId: 'flue_disable_admitting', startedAt: START + 1,
    }), 'superseded');
    assert.equal((await store.getRun(submitted.id))?.status, 'superseded');

    await createRoutine(store, 'routine_disable_run_now', START + HOUR);
    const runNowRoutine = (await store.getRoutine('routine_disable_run_now'))!;
    const runNow = await store.createOccurrence({
      runId: 'rrun_disable_run_now', idempotencyKey: 'run:disable:run-now', routineId: runNowRoutine.id,
      routineVersion: runNowRoutine.version, scheduledFor: START, triggerSource: 'run_now', requestedBy: 'U_MEMBER',
      queuedAt: START, deadlineAt: START + 15 * 60_000,
    });
    await store.control({
      routineId: runNowRoutine.id, expectedVersion: runNowRoutine.version, action: 'disable',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'control:disable:run-now',
    });
    await store.startAdmissionAttempt({
      occurrenceId: runNow.id, owner: 'scheduler', leaseUntil: START + 60_000, invokeStartedAt: START,
    });
    await store.recordAdmissionReceipt(runNow.id, 1, 'flue_disable_run_now', START);
    assert.equal(await store.beginOccurrence({
      occurrenceId: runNow.id, flueRunId: 'flue_disable_run_now', startedAt: START + 1,
    }), 'started');
  } finally {
    store.close();
  }
});

test('a one-time job outside admission grace is recorded once as missed and completed', async () => {
  const store = new SqliteRoutineStore(':memory:', () => START);
  try {
    await createOneTimeRoutine(store, 'routine_once_missed', START - HOUR);
    const batch = await store.claimDueSchedules({ now: START, owner: 'once-missed', limit: 25 });
    assert.equal(batch.runs[0]?.status, 'skipped');
    assert.equal(batch.runs[0]?.skipReason, 'missed_one_time');
    assert.equal((await store.getRoutine('routine_once_missed'))?.state, 'completed');
    assert.equal((await store.listRuns({ routineId: 'routine_once_missed' })).length, 1);
  } finally {
    store.close();
  }
});
