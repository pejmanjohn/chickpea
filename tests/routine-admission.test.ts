import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RoutineAdmissionController,
  type RoutineExecutionAdapter,
} from '../src/routines/admission.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type {
  RoutineAdmissionAttempt,
  RoutineDefinitionContent,
  RoutineRun,
} from '../src/routines/types.ts';

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
    nextRunAt: NOW, projectedDailyStarts: 1, reservations: [{ windowStart: NOW, count: 1 }],
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
  return (await store.claimDueSchedules({ now: NOW, owner: 'heartbeat', limit: 25 })).runs[0]!;
}

class FakeAdapter implements RoutineExecutionAdapter {
  readonly attempts: string[] = [];
  failBeforeReceipt = false;

  constructor(private readonly store: SqliteRoutineStore) {}

  async execute(run: RoutineRun, attempt: RoutineAdmissionAttempt) {
    this.attempts.push(attempt.attemptId);
    const envelope = {
      schemaVersion: 1 as const,
      attemptId: attempt.attemptId,
      instanceId: `routineagent_${hashRoutineValue(attempt.attemptId).slice(0, 20)}`,
      idempotencyKey: attempt.attemptId,
      message: 'Execute the frozen routine input.',
      initialData: { fixture: true },
    };
    await this.store.prepareAgentDispatch({
      occurrenceId: run.id,
      attempt: attempt.attempt,
      startedAt: NOW,
      envelope,
      resolvedAccessHash: 'a'.repeat(64),
      resolvedAgentId: 'agent_test',
      resolvedAuthorityReceiptId: 'schedule_authority_test',
      resolvedRunsAsMembershipId: 'membership_test',
      model: 'anthropic/test',
      traceId: run.id,
    });
    if (this.failBeforeReceipt) {
      this.failBeforeReceipt = false;
      throw new Error('connection ended after dispatch');
    }
    await this.store.recordAgentReceipt({
      occurrenceId: run.id,
      attempt: attempt.attempt,
      receipt: {
        submissionId: `submission_${hashRoutineValue(attempt.attemptId).slice(0, 20)}`,
        acceptedAt: new Date(NOW).toISOString(),
        uid: `uid_${hashRoutineValue(attempt.attemptId).slice(0, 20)}`,
      },
      at: NOW,
    });
    return 'resumable' as const;
  }
}

test('a repeated controller reattaches one stable attempt and never creates a second admission', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const run = await queuedRun(store, 'reattach');
    const adapter = new FakeAdapter(store);
    const controller = new RoutineAdmissionController(store, adapter);

    const first = await controller.process(NOW, 'heartbeat-one');
    const second = await controller.process(NOW + 1, 'heartbeat-two');
    const admissions = await store.listAdmissions(run.id);
    assert.equal(first.attached, 1);
    assert.equal(second.reconciled, 1);
    assert.equal(admissions.length, 1);
    assert.equal(adapter.attempts[0], adapter.attempts[1]);
    assert.equal((await store.getRun(run.id))?.flueRunId, null);
    assert.equal((await store.getRun(run.id))?.resolvedAuthorityReceiptId, 'schedule_authority_test');
    assert.equal((await store.getRun(run.id))?.resolvedRunsAsMembershipId, 'membership_test');
    assert.equal(admissions[0]?.flueAgentReceipt?.submissionId.startsWith('submission_'), true);
  } finally {
    store.close();
  }
});

test('a lost dispatch acknowledgement repeats the exact frozen envelope and idempotency key', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const run = await queuedRun(store, 'lost_ack');
    const adapter = new FakeAdapter(store);
    adapter.failBeforeReceipt = true;
    const controller = new RoutineAdmissionController(store, adapter);

    const first = await controller.process(NOW, 'heartbeat-one');
    const frozen = (await store.getRun(run.id))?.flueAgentEnvelope;
    const second = await controller.process(NOW + 1, 'heartbeat-two');
    const resumed = (await store.getRun(run.id))?.flueAgentEnvelope;

    assert.equal(first.unknown, 1);
    assert.equal(second.attached, 1);
    assert.deepEqual(resumed, frozen);
    assert.equal(resumed?.schemaVersion, 1);
    assert.equal(resumed?.idempotencyKey, resumed?.attemptId);
    assert.equal((await store.listAdmissions(run.id)).length, 1);
    assert.equal((await store.getRun(run.id))?.resolvedAuthorityReceiptId, 'schedule_authority_test');
    assert.equal((await store.getRun(run.id))?.resolvedRunsAsMembershipId, 'membership_test');
  } finally {
    store.close();
  }
});
