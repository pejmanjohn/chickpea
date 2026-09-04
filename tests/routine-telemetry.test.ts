import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoutineAdmissionController } from '../src/routines/admission.ts';
import { RoutineScheduler } from '../src/routines/scheduler.ts';
import {
  emitRoutineHeartbeatTelemetry,
  emitRoutinePersistenceTelemetry,
} from '../src/routines/telemetry.ts';
import type { RoutineStore } from '../src/routines/types.ts';

const result = {
  claims: { runs: [], scannedCount: 4, deferredCount: 1 },
  admissions: { attempted: 2, attached: 1, reconciled: 1, unknown: 0, deferred: 1 },
  maintenance: {
    confirmationsPurged: 3,
    reservationsPurged: 4,
    scheduleActionsDeleted: 2,
    recoveryNoticesReconciled: 1,
    deliveryLeasesReconciled: 0,
    deadlineRunsReconciled: 1,
    runsDeleted: 2,
    auditEventsDeleted: 5,
  },
};

test('routine heartbeat telemetry contains only approved counts and duration', () => {
  const messages: string[] = [];
  emitRoutineHeartbeatTelemetry(result, 12.6, { info: (message) => messages.push(JSON.stringify(message)) });
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(messages[0]!).component, 'routines');
  const body = JSON.parse(messages[0]!) as Record<string, unknown>;
  assert.deepEqual(body, {
    component: 'routines',
    event: 'routine.heartbeat',
    scanned: 4,
    claimed: 0,
    deferred: 2,
    admissionAttempted: 2,
    admissionAttached: 1,
    admissionReconciled: 1,
    admissionUnknown: 0,
    confirmationsPurged: 3,
    reservationsPurged: 4,
    scheduleActionsDeleted: 2,
    recoveryNoticesReconciled: 1,
    deliveryLeasesReconciled: 0,
    deadlineRunsReconciled: 1,
    runsDeleted: 2,
    auditEventsDeleted: 5,
    durationMs: 13,
  });
  assert.doesNotMatch(messages[0]!, /task|prompt|token|credential|channel|actor|error/i);
});

test('telemetry sink failures never fail scheduling', () => {
  assert.doesNotThrow(() => emitRoutineHeartbeatTelemetry(result, 1, {
    info() { throw new Error('logging unavailable'); },
  }));
});

test('routine persistence emits one sanitized summary and only unrepaired gaps use error', () => {
  const info: string[] = [];
  const errors: string[] = [];
  const sink = {
    info: (message: Record<string, unknown>) => info.push(JSON.stringify(message)),
    error: (message: Record<string, unknown>) => errors.push(JSON.stringify(message)),
  };
  emitRoutinePersistenceTelemetry({
    phase: 'repair', outcome: 'repaired', usage: 'repaired', work: 'recorded', durationMs: 128,
  }, sink);
  emitRoutinePersistenceTelemetry({
    phase: 'work', outcome: 'unrepaired', usage: 'recorded', work: 'unrepaired', durationMs: 255,
  }, sink);

  assert.equal(info.length, 1);
  assert.equal(errors.length, 1);
  for (const message of [...info, ...errors]) {
    assert.equal(JSON.parse(message).component, 'routines');
    assert.doesNotMatch(message, /routine_|rrun_|channel|prompt|task|credential|actor|message/i);
  }
  assert.deepEqual(JSON.parse(info[0]!), {
    component: 'routines',
    event: 'routine.persistence',
    phase: 'repair',
    outcome: 'repaired',
    usage: 'repaired',
    work: 'recorded',
    durationMs: 128,
  });
  assert.match(errors[0]!, /"outcome":"unrepaired"/);
});

test('scheduler runs maintenance before claims and emits one heartbeat record', async () => {
  const order: string[] = [];
  const messages: string[] = [];
  const store = {
    async cleanupRetention() {
      order.push('maintenance');
      return result.maintenance;
    },
    async claimDueSchedules() {
      order.push('claims');
      return result.claims;
    },
  } as unknown as RoutineStore;
  const admissions = {
    async process() {
      order.push('admissions');
      return result.admissions;
    },
  } as unknown as RoutineAdmissionController;
  let clock = 100;
  const scheduler = new RoutineScheduler(
    store,
    admissions,
    { info: (message) => messages.push(JSON.stringify(message)) },
    () => (clock += 5),
  );

  assert.deepEqual(await scheduler.heartbeat(123, 'heartbeat-test'), result);
  assert.deepEqual(order, ['maintenance', 'claims', 'admissions']);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /"durationMs":5/);
});

test('a claim failure still processes queued admissions and emits heartbeat telemetry', async () => {
  const order: string[] = [];
  const messages: string[] = [];
  const store = {
    async cleanupRetention() { order.push('maintenance'); return result.maintenance; },
    async claimDueSchedules() { order.push('claims'); throw new Error('claim failed'); },
  } as unknown as RoutineStore;
  const admissions = {
    async process() { order.push('admissions'); return result.admissions; },
  } as unknown as RoutineAdmissionController;
  const scheduler = new RoutineScheduler(
    store,
    admissions,
    { info: (message) => messages.push(JSON.stringify(message)) },
    () => 100,
  );

  await assert.rejects(() => scheduler.heartbeat(123, 'heartbeat-test'), /claim failed/);
  assert.deepEqual(order, ['maintenance', 'claims', 'admissions']);
  assert.equal(messages.length, 1);
});
