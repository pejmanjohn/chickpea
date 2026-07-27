import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashRoutineValue } from '../src/routines/ids.ts';
import { ROUTINE_LIMITS } from '../src/routines/limits.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinition, RoutineDefinitionContent } from '../src/routines/types.ts';

const START = Date.UTC(2026, 6, 27, 12);

function definition(): RoutineDefinitionContent {
  return {
    name: 'Retention fixture',
    description: 'Exercises body-free scheduled work retention.',
    taskText: 'Inspect the channel and safely update the configured tracker.',
    triggerKind: 'schedule',
    scheduleInput: '0 9 * * *',
    scheduleJson: '{"version":1,"kind":"cron","expression":"0 9 * * *"}',
    timezone: 'UTC',
    outputPolicy: 'post',
    authorityMode: 'live_channel_v1',
  };
}

async function createRoutine(
  store: SqliteRoutineStore,
  id: string,
  now: number,
): Promise<RoutineDefinition> {
  const tokenHash = hashRoutineValue(`token-${id}`);
  const draft = {
    action: 'create' as const,
    routineId: id,
    definition: definition(),
    nextRunAt: now + 60 * 60_000,
    projectedDailyStarts: 1,
    reservations: [{ windowStart: now + 60 * 60_000, count: 1 }],
  };
  const previewHash = hashRoutineValue(JSON.stringify(draft));
  await store.putConfirmation({
    confirmationId: `rconfirm_${id}`,
    tokenHash,
    actorId: 'U_MEMBER',
    actorClass: 'member',
    workspaceId: 'T_TEST',
    channelId: `C_${id}`,
    draft,
    previewHash,
    expiresAt: now + ROUTINE_LIMITS.confirmationTtlMs,
  });
  return store.confirm({
    tokenHash,
    actorId: 'U_MEMBER',
    workspaceId: 'T_TEST',
    channelId: `C_${id}`,
    previewHash,
    idempotencyKey: `create-${id}`,
  });
}

async function startRun(
  store: SqliteRoutineStore,
  routine: RoutineDefinition,
  id: string,
  now: number,
  deadlineAt = now + ROUTINE_LIMITS.occurrenceDeadlineMs,
) {
  const run = await store.createOccurrence({
    runId: id,
    idempotencyKey: `run-${id}`,
    routineId: routine.id,
    routineVersion: routine.version,
    scheduledFor: now,
    triggerSource: 'run_now',
    requestedBy: 'U_MEMBER',
    queuedAt: now,
    deadlineAt,
  });
  await store.startAdmissionAttempt({
    occurrenceId: run.id,
    owner: 'retention-test',
    invokeStartedAt: now + 1,
    leaseUntil: now + ROUTINE_LIMITS.admissionLeaseMs,
  });
  await store.beginOccurrence({
    occurrenceId: run.id,
    flueRunId: `flue_${id}`,
    startedAt: now + 2,
  });
  return (await store.getRun(run.id))!;
}

test('maintenance expires ambiguous leases and hard deadlines without retrying work', async () => {
  let now = START;
  const store = new SqliteRoutineStore(':memory:', () => now);
  try {
    const deliveryRoutine = await createRoutine(store, 'routine_delivery_lease', now);
    const deliveryRun = await startRun(store, deliveryRoutine, 'rrun_delivery_lease', now);
    await store.claimDelivery({
      occurrenceId: deliveryRun.id,
      at: now + 3,
      leaseUntil: now + 3 + ROUTINE_LIMITS.deliveryLeaseMs,
    });
    now += ROUTINE_LIMITS.deliveryLeaseMs + 4;

    const deliveryCleanup = await store.cleanupRetention();
    assert.equal(deliveryCleanup.deliveryLeasesReconciled, 1);
    assert.equal((await store.getRun(deliveryRun.id))?.status, 'failed');
    assert.equal((await store.getRun(deliveryRun.id))?.deliveryStatus, 'unknown');
    assert.equal((await store.getRoutine(deliveryRoutine.id))?.state, 'paused');
    assert.equal((await store.getRoutine(deliveryRoutine.id))?.pausedReason, 'delivery_unknown');
    assert.equal(
      (await store.listAuditEvents({ subjectId: deliveryRoutine.id }))
        .filter((event) => event.eventType === 'routine.auto_paused').length,
      1,
    );

    const deadlineRoutine = await createRoutine(store, 'routine_deadline', now);
    const deadlineRun = await startRun(
      store,
      deadlineRoutine,
      'rrun_deadline',
      now,
      now + 100,
    );
    now += 100 + ROUTINE_LIMITS.deliveryLeaseMs + 1;
    const deadlineCleanup = await store.cleanupRetention();
    assert.equal(deadlineCleanup.deadlineRunsReconciled, 1);
    assert.equal((await store.getRun(deadlineRun.id))?.failureClass, 'unknown_external_outcome');
    assert.equal((await store.getRoutine(deadlineRoutine.id))?.pausedReason, 'unknown_external_outcome');
  } finally {
    store.close();
  }
});

test('maintenance deletes terminal run and scheduled-work audit metadata after 365 days', async () => {
  let now = START;
  const store = new SqliteRoutineStore(':memory:', () => now);
  try {
    const routine = await createRoutine(store, 'routine_old_metadata', now);
    const run = await startRun(store, routine, 'rrun_old_metadata', now);
    await store.transitionRun({
      occurrenceId: run.id,
      from: ['running'],
      to: 'succeeded',
      at: now + 3,
      inputTokens: 10,
      outputTokens: 5,
      toolCallCount: 1,
    });
    assert.ok((await store.listAuditEvents()).length > 0);

    now += ROUTINE_LIMITS.metadataRetentionMs + ROUTINE_LIMITS.confirmationPurgeDelayMs + 10;
    const result = await store.cleanupRetention();
    assert.equal(result.runsDeleted, 1);
    assert.ok(result.auditEventsDeleted >= 3);
    assert.equal(result.confirmationsPurged, 1);
    assert.equal(result.reservationsPurged, 1);
    assert.equal(await store.getRun(run.id), undefined);
    assert.equal((await store.listAuditEvents()).length, 0);
    assert.equal((await store.getRoutine(routine.id))?.taskText, definition().taskText);
  } finally {
    store.close();
  }
});

test('resume clears the failure streak after an automatic pause', async () => {
  let now = START;
  const store = new SqliteRoutineStore(':memory:', () => now);
  try {
    let routine = await createRoutine(store, 'routine_failure_reset', now);
    for (let index = 0; index < 3; index += 1) {
      const run = await startRun(store, routine, `rrun_failure_reset_${index}`, now + index * 10);
      await store.transitionRun({
        occurrenceId: run.id,
        from: ['running'],
        to: 'failed',
        at: now + index * 10 + 3,
        failureClass: 'tool_failed',
        publicError: 'The scheduled action failed safely.',
      });
      routine = (await store.getRoutine(routine.id))!;
    }
    assert.equal(routine.consecutiveFailures, 3);
    assert.equal(routine.state, 'paused');
    now += 100;
    const resumed = await store.control({
      routineId: routine.id,
      expectedVersion: routine.version,
      action: 'resume',
      actorId: 'U_MEMBER',
      actorClass: 'member',
      idempotencyKey: 'resume-after-failures',
    });
    assert.equal(resumed.state, 'active');
    assert.equal(resumed.consecutiveFailures, 0);
  } finally {
    store.close();
  }
});
