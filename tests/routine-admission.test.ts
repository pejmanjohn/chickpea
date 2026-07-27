import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADMISSION_RECONCILE_AFTER_MS,
  RoutineAdmissionController,
  type RoutineAdmissionAdapter,
  type RoutineWorkflowScan,
} from '../src/routines/admission.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinitionContent, RoutineRun } from '../src/routines/types.ts';

const NOW = Date.UTC(2026, 6, 27, 12);

async function queuedRun(store: SqliteRoutineStore, suffix: string): Promise<RoutineRun> {
  const definition: RoutineDefinitionContent = {
    name: 'Admission fixture', description: '', taskText: 'Inspect state.', triggerKind: 'schedule',
    scheduleInput: '0 * * * *',
    scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
  };
  const draft = {
    action: 'create' as const, routineId: `routine_${suffix}`, definition,
    nextRunAt: NOW, projectedDailyStarts: 1,
    reservations: [{ windowStart: NOW, count: 1 }],
  };
  const tokenHash = hashRoutineValue(`token-${suffix}`);
  const previewHash = hashRoutineValue(JSON.stringify(draft));
  await store.putConfirmation({
    confirmationId: `confirm_${suffix}`, tokenHash, actorId: 'U_MEMBER', actorClass: 'member',
    workspaceId: 'T_TEST', channelId: `C_${suffix}`, draft, previewHash,
    expiresAt: NOW + 15 * 60_000,
  });
  await store.confirm({
    tokenHash, actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: `C_${suffix}`,
    previewHash, idempotencyKey: `confirm:${suffix}`,
  });
  const batch = await store.claimDueSchedules({ now: NOW, owner: 'heartbeat', limit: 25 });
  return batch.runs[0]!;
}

class FakeAdapter implements RoutineAdmissionAdapter {
  invokeCount = 0;
  invokeResult: 'success' | 'ambiguous' = 'success';
  scanResult: RoutineWorkflowScan = { available: true, complete: true, candidates: [] };

  async invoke(): Promise<{ runId: string }> {
    this.invokeCount += 1;
    if (this.invokeResult === 'ambiguous') throw new Error('connection ended after submission');
    return { runId: `run_flue_${this.invokeCount}` };
  }
  async scan(): Promise<RoutineWorkflowScan> {
    return this.scanResult;
  }
}

test('a repeated controller cannot create a second attempt while a receipt is attached', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const run = await queuedRun(store, 'attached');
    const adapter = new FakeAdapter();
    const controller = new RoutineAdmissionController(store, adapter);

    const first = await controller.process(NOW, 'heartbeat-one');
    const second = await controller.process(NOW + 1, 'heartbeat-two');
    assert.equal(first.attached, 1);
    assert.equal(second.deferred, 1);
    assert.equal(adapter.invokeCount, 1);
    assert.equal((await store.getRun(run.id))?.flueRunId, 'run_flue_1');
    assert.equal((await store.listAdmissions(run.id)).length, 1);
  } finally {
    store.close();
  }
});

test('ambiguous invoke is reconciled by persisted occurrence input before reinvocation', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const run = await queuedRun(store, 'reconcile');
    const adapter = new FakeAdapter();
    adapter.invokeResult = 'ambiguous';
    const controller = new RoutineAdmissionController(store, adapter);
    await controller.process(NOW, 'heartbeat-one');

    adapter.scanResult = {
      available: true,
      complete: true,
      candidates: [{
        runId: 'run_reconciled', workflowName: 'routine-occurrence',
        startedAt: NOW + 1, input: { occurrenceId: run.id },
      }],
    };
    const summary = await controller.process(
      NOW + ADMISSION_RECONCILE_AFTER_MS,
      'heartbeat-two',
    );
    assert.equal(summary.reconciled, 1);
    assert.equal(summary.attached, 1);
    assert.equal(adapter.invokeCount, 1);
    assert.equal((await store.getRun(run.id))?.flueRunId, 'run_reconciled');
  } finally {
    store.close();
  }
});

test('complete absence permits one new attempt; incomplete scan fails closed', async () => {
  const absentStore = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const run = await queuedRun(absentStore, 'absent');
    const adapter = new FakeAdapter();
    adapter.invokeResult = 'ambiguous';
    const controller = new RoutineAdmissionController(absentStore, adapter);
    await controller.process(NOW, 'heartbeat-one');
    adapter.invokeResult = 'success';
    const summary = await controller.process(NOW + ADMISSION_RECONCILE_AFTER_MS, 'heartbeat-two');
    assert.equal(summary.reconciled, 1);
    assert.equal(summary.attempted, 1);
    assert.equal(adapter.invokeCount, 2);
    assert.equal((await absentStore.listAdmissions(run.id)).length, 2);
  } finally {
    absentStore.close();
  }

  const unknownStore = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const run = await queuedRun(unknownStore, 'unknown');
    const adapter = new FakeAdapter();
    adapter.invokeResult = 'ambiguous';
    const controller = new RoutineAdmissionController(unknownStore, adapter);
    await controller.process(NOW, 'heartbeat-one');
    adapter.scanResult = { available: false, complete: false, candidates: [] };
    const summary = await controller.process(NOW + ADMISSION_RECONCILE_AFTER_MS, 'heartbeat-two');
    assert.equal(summary.unknown, 1);
    assert.equal((await unknownStore.getRun(run.id))?.status, 'failed');
    assert.equal((await unknownStore.getRun(run.id))?.failureClass, 'admission_unknown');
    assert.equal((await unknownStore.getRoutine(run.routineId))?.state, 'active');
  } finally {
    unknownStore.close();
  }
});
